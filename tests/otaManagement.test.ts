import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeOtaMetadata, commitOtaActivationTransaction, createOtaMetadataBackup, planOtaActivation, planOtaMetadataRestore, validateOtaMetadataBackup } from '../src/otaManagement.js';
import { calculateOtaSeqCrc32, ESP_OTA_IMG_ABORTED, ESP_OTA_IMG_INVALID, ESP_OTA_IMG_VALID } from '../src/upstream/flasher/otadata.js';
import { ProgressReporter } from '../src/progress.js';

function snapshot(records: Array<{ seq: number; state: number; crc?: number }>): Uint8Array {
  const bytes = new Uint8Array(8192).fill(0xff); const view = new DataView(bytes.buffer);
  records.forEach((record, index) => { const at = index * 4096; view.setUint32(at, record.seq, true); view.setUint32(at + 24, record.state, true); view.setUint32(at + 28, record.crc ?? calculateOtaSeqCrc32(record.seq), true); });
  return bytes;
}

describe('OTA diagnostics and fail-closed activation planning', () => {
  it('validates seq-only CRC and maps sequence 4 to ota_1', () => {
    const result = analyzeOtaMetadata(snapshot([{ seq: 3, state: ESP_OTA_IMG_VALID }, { seq: 4, state: ESP_OTA_IMG_VALID }]), { factoryPresent: true });
    expect(result.sectors.map((sector) => sector.crcValid)).toEqual([true, true]);
    expect(result.selectedSector).toBe(1); expect(result.selectedSequence).toBe(4); expect(result.selectedByMetadata).toBe('ota_1');
  });
  it('excludes bad CRC, INVALID, ABORTED, and erased records', () => {
    const result = analyzeOtaMetadata(snapshot([{ seq: 4, state: ESP_OTA_IMG_INVALID }, { seq: 5, state: ESP_OTA_IMG_ABORTED, crc: 0 }]), { factoryPresent: true });
    expect(result.selectedByMetadata).toBe('factory'); expect(result.ambiguous).toBe(true);
    const erased = analyzeOtaMetadata(new Uint8Array(8192).fill(0xff), { factoryPresent: true });
    expect(erased.selectedByMetadata).toBe('factory'); expect(erased.ambiguous).toBe(false);
  });
  it('derives the alternating single-sector activation sequence without claiming a running slot', () => {
    const analysis = analyzeOtaMetadata(snapshot([{ seq: 4, state: ESP_OTA_IMG_VALID }, { seq: 3, state: ESP_OTA_IMG_VALID }]), { factoryPresent: true });
    const plan = planOtaActivation({ analysis, target: 'ota_0', actualRunningSlot: null, targetImageValid: true, otherImageValid: true,
      targetImageSha256: 'a'.repeat(64), expectedTargetSha256: 'a'.repeat(64), targetSignatureTrusted: true,
      metadataBackupVerified: true, rollbackConfig: 'unknown', antiRollbackConfig: 'unknown' });
    expect(plan.outcome).toBe('OTA ACTIVATION PLAN'); expect(plan.writeRanges).toEqual([{ start: 0x14000, end: 0x15000 }]);
    expect(plan.proposedUpdate).toMatchObject({ sectorAddress: 0x14000, sequence: 5, state: 'VALID', priorSectorPreserved: true });
    expect(plan.blockers).toEqual([]);
    const returnAnalysis = analyzeOtaMetadata(snapshot([{ seq: 5, state: ESP_OTA_IMG_VALID }, { seq: 4, state: ESP_OTA_IMG_VALID }]), { factoryPresent: true });
    const returnPlan = planOtaActivation({ analysis: returnAnalysis, target: 'ota_1', actualRunningSlot: 'ota_0', targetImageValid: true, otherImageValid: true,
      targetImageSha256: 'a'.repeat(64), expectedTargetSha256: null, targetSignatureTrusted: true,
      metadataBackupVerified: true, rollbackConfig: 'disabled', antiRollbackConfig: 'disabled' });
    expect(returnPlan.proposedUpdate).toMatchObject({ sequence: 6, sectorAddress: 0x14000 });
    expect(returnPlan.blockers.join('\n')).toMatch(/No exact approved application digest/);
  });
  it('plans sequence 5 to ota_0 and sequence 6 to ota_1 while alternating metadata sectors', () => {
    const five = analyzeOtaMetadata(snapshot([{ seq: 5, state: ESP_OTA_IMG_VALID }, { seq: 4, state: ESP_OTA_IMG_VALID }]), { factoryPresent: true });
    const toOne = planOtaActivation({ analysis: five, target: 'ota_1', actualRunningSlot: null, targetImageValid: true, otherImageValid: true,
      targetImageSha256: 'a'.repeat(64), expectedTargetSha256: 'a'.repeat(64), targetSignatureTrusted: true,
      metadataBackupVerified: true, rollbackConfig: 'unknown', antiRollbackConfig: 'unknown' });
    expect(five.selectedByMetadata).toBe('ota_0');
    expect(toOne.proposedUpdate).toMatchObject({ sequence: 6, sectorAddress: 0x14000 });
    const six = analyzeOtaMetadata(snapshot([{ seq: 6, state: ESP_OTA_IMG_VALID }, { seq: 5, state: ESP_OTA_IMG_VALID }]), { factoryPresent: true });
    const toZero = planOtaActivation({ analysis: six, target: 'ota_0', actualRunningSlot: null, targetImageValid: true, otherImageValid: true,
      targetImageSha256: 'a'.repeat(64), expectedTargetSha256: 'a'.repeat(64), targetSignatureTrusted: true,
      metadataBackupVerified: true, rollbackConfig: 'unknown', antiRollbackConfig: 'unknown' });
    expect(toZero.proposedUpdate).toMatchObject({ sequence: 7, sectorAddress: 0x14000 });
  });
  it('commits only the planned 4096-byte sector, validates selected slot, and leaves bytes unchanged on cancellation', async () => {
    const before = snapshot([{ seq: 3, state: ESP_OTA_IMG_VALID }, { seq: 4, state: ESP_OTA_IMG_VALID }]);
    const analysis = analyzeOtaMetadata(before, { factoryPresent: true });
    const plan = planOtaActivation({ analysis, target: 'ota_0', actualRunningSlot: null, targetImageValid: true, otherImageValid: true,
      targetImageSha256: 'a'.repeat(64), expectedTargetSha256: 'a'.repeat(64), targetSignatureTrusted: true,
      metadataBackupVerified: true, rollbackConfig: 'unknown', antiRollbackConfig: 'unknown' });
    let live = Uint8Array.from(before); const writes: Array<{ address: number; bytes: Uint8Array }> = [];
    const transport = { readOtadataSnapshot: async () => live, writeOtaSelectSector: async (address: number, bytes: Uint8Array) => {
      writes.push({ address, bytes: Uint8Array.from(bytes) }); const offset = address - 0x13000; live = Uint8Array.from(live); live.set(bytes, offset);
    } };
    await expect(commitOtaActivationTransaction({ before, plan, transport, confirm: async () => false })).rejects.toThrow(/cancelled/);
    expect(writes).toHaveLength(0); expect(live).toEqual(before);
    const committed = await commitOtaActivationTransaction({ before, plan, transport, confirm: async () => true });
    expect(writes).toHaveLength(1); expect(writes[0]).toMatchObject({ address: 0x13000 });
    expect(writes[0]!.bytes).toHaveLength(4096); expect(committed).toMatchObject({ address: 0x13000, sequence: 5, bytesWritten: 4096,
      metadata: { selectedByMetadata: 'ota_0', selectedSequence: 5 } });
    expect(live.subarray(4096)).toEqual(before.subarray(4096));
    expect(new DataView(writes[0]!.bytes.buffer).getUint32(24, true)).toBe(ESP_OTA_IMG_VALID);
    expect(new DataView(writes[0]!.bytes.buffer).getUint32(28, true)).toBe(calculateOtaSeqCrc32(5));
  });
  it('plans emergency recovery as a first-valid-sector transaction and preserves a viable peer', () => {
    const live = analyzeOtaMetadata(snapshot([{ seq: 5, state: ESP_OTA_IMG_INVALID }, { seq: 4, state: ESP_OTA_IMG_ABORTED }]), { factoryPresent: true });
    const backup = analyzeOtaMetadata(snapshot([{ seq: 3, state: ESP_OTA_IMG_VALID }, { seq: 4, state: ESP_OTA_IMG_VALID }]), { factoryPresent: true });
    const plan = planOtaMetadataRestore(live, backup, true);
    expect(plan).toMatchObject({ target: 'ota_1', sequence: 6, sectorAddress: 0x13000, writeLength: 4096,
      method: 'single-sector-valid-record-preserving-peer', blockers: [] });
    expect(planOtaMetadataRestore(live, backup, false).blockers).toContain('The recovery application selected by the backup is not currently valid and trusted.');
  });
});

describe('exact OTA metadata backup', () => {
  it('writes 8192 bytes mode 0600, verifies an independent read and binds to the device', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wg-otadata-')); const outputPath = join(dir, 'otadata.bin');
    const bytes = new Uint8Array(8192).fill(0x5a); const binding = { macAddressSha256: 'a'.repeat(64), secureCertificateSha256: 'b'.repeat(64) };
    async function* chunks() { yield bytes.subarray(0, 4096); yield bytes.subarray(4096); }
    try {
      const manifest = await createOtaMetadataBackup({ outputPath, deviceBinding: binding, readChunks: chunks(), hashLivePartition: async () => manifestSha(bytes) });
      expect(manifest.independentReadbackVerified).toBe(true); expect((await stat(outputPath)).mode & 0o777).toBe(0o600);
      await expect(validateOtaMetadataBackup(`${outputPath}.manifest.json`, { bytes, deviceBinding: binding })).resolves.toMatchObject({ manifest: { sha256: manifest.sha256 } });
      await expect(createOtaMetadataBackup({ outputPath, deviceBinding: binding, readChunks: chunks(), hashLivePartition: async () => manifest.sha256 })).rejects.toThrow(/refusing to overwrite/);
      await expect(validateOtaMetadataBackup(`${outputPath}.manifest.json`, { bytes, deviceBinding: { ...binding, macAddressSha256: 'c'.repeat(64) } })).rejects.toThrow(/does not bind/);
      await expect(validateOtaMetadataBackup(`${outputPath}.manifest.json`, { bytes: new Uint8Array(8192).fill(0x51), deviceBinding: binding })).rejects.toThrow(/corrupt or stale/);
      await writeFile(outputPath, new Uint8Array(8192).fill(0x11));
      await expect(validateOtaMetadataBackup(`${outputPath}.manifest.json`, { bytes, deviceBinding: binding })).rejects.toThrow(/corrupt or stale/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('reports measured backup/readback bytes and cancellation through the shared reporter', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wg-otadata-progress-'));
    const binding = { macAddressSha256: 'a'.repeat(64), secureCertificateSha256: 'b'.repeat(64) };
    const bytes = new Uint8Array(8192).fill(0x5a); const lines: string[] = [];
    const progress = new ProgressReporter({ write: (line) => lines.push(line), tty: false, intervalMs: 1 });
    async function* fullChunks() { yield bytes.subarray(0, 4096); progress.bytes(4096, 8192); yield bytes.subarray(4096); progress.bytes(8192, 8192); }
    try {
      progress.stage('Connecting to ESP32-S3'); progress.finish('complete');
      await createOtaMetadataBackup({ outputPath: join(dir, 'progress.bin'), deviceBinding: binding, readChunks: fullChunks(), progress,
        hashLivePartition: async () => { progress.bytes(8192, 8192); return manifestSha(bytes); } });
      progress.close();
      expect(lines.join('')).toContain('Reading and saving otadata backup');
      expect(lines.join('')).toContain('Independent flash readback SHA-256');
      expect(lines.join('')).toContain('Saving backup and manifest DONE');
      expect(lines.join('')).not.toMatch(/[\r\u001b]/);

      const controller = new AbortController(); const cancelledLines: string[] = [];
      const cancelledProgress = new ProgressReporter({ write: (line) => cancelledLines.push(line), tty: false });
      async function* interruptedChunks() { yield bytes.subarray(0, 4096); controller.abort(); yield bytes.subarray(4096); }
      await expect(createOtaMetadataBackup({ outputPath: join(dir, 'cancelled.bin'), deviceBinding: binding, readChunks: interruptedChunks(),
        hashLivePartition: async () => manifestSha(bytes), signal: controller.signal, progress: cancelledProgress })).rejects.toThrow(/cancelled/);
      cancelledProgress.close();
      expect(cancelledLines.join('')).toContain('CANCELLED');
      expect(await readdir(dir)).toEqual(['progress.bin', 'progress.bin.manifest.json']);
    } finally { progress.close(); await rm(dir, { recursive: true, force: true }); }
  });
  it('does not finalize a mismatched or short snapshot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wg-otadata-')); const outputPath = join(dir, 'otadata.bin');
    const binding = { macAddressSha256: 'a'.repeat(64), secureCertificateSha256: 'b'.repeat(64) };
    async function* short() { yield new Uint8Array(20); }
    try {
      await expect(createOtaMetadataBackup({ outputPath, deviceBinding: binding, readChunks: short(), hashLivePartition: async () => '' })).rejects.toThrow(/exactly 8192/);
      expect(await readdir(dir)).toEqual([]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

function manifestSha(bytes: Uint8Array) { return import('node:crypto').then(({ createHash }) => createHash('sha256').update(bytes).digest('hex')); }
