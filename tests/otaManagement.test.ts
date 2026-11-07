import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { analyzeOtaMetadata, commitOtaActivationTransaction, commitOtaRecoveryTransaction, createOtaMetadataBackup, planOtaActivation, planOtaMetadataRestore, qualifiesUnknownSignerTrust, validateOtaMetadataBackup } from '../src/otaManagement.js';
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
  it('permits only explicitly qualified UNKNOWN signer trust while keeping invalid trust blocked', () => {
    const analysis = analyzeOtaMetadata(snapshot([{ seq: 3, state: ESP_OTA_IMG_VALID }, { seq: 4, state: ESP_OTA_IMG_VALID }]), { factoryPresent: true });
    const base = { analysis, target: 'ota_0' as const, actualRunningSlot: null, targetImageValid: true, otherImageValid: true,
      targetImageSha256: null, expectedTargetSha256: 'a'.repeat(64), targetDigestMatches: true,
      metadataBackupVerified: true, rollbackConfig: 'unknown' as const, antiRollbackConfig: 'unknown' as const };
    const unknown = planOtaActivation({ ...base, targetSignatureTrusted: false, allowUnknownSignerTrust: true });
    expect(unknown.blockers).toEqual([]);
    expect(planOtaActivation({ ...base, targetSignatureTrusted: false }).blockers).toContain('Target Secure Boot signer trust is not verified by this device.');
    expect(planOtaActivation({ ...base, targetSignatureTrusted: false, allowUnknownSignerTrust: false }).blockers).toContain('Target Secure Boot signer trust is not verified by this device.');
  });
  it('qualifies UNKNOWN signer evidence only with the authenticated source, matching target and recovery, selected recovery metadata, and current backup', () => {
    const evidence = { signerTrust: 'UNKNOWN' as const, sourceSha256Verified: true, sourceSignatureVerified: true,
      targetMd5Matches: true, recoveryMd5Matches: true, selectedByMetadata: 'ota_1', recoverySlot: 'ota_1', metadataBackupVerified: true };
    expect(qualifiesUnknownSignerTrust(evidence)).toBe(true);
    expect(qualifiesUnknownSignerTrust({ ...evidence, signerTrust: 'REVOKED' })).toBe(false);
    expect(qualifiesUnknownSignerTrust({ ...evidence, signerTrust: 'UNTRUSTED' })).toBe(false);
    expect(qualifiesUnknownSignerTrust({ ...evidence, signerTrust: 'INCOMPATIBLE' })).toBe(false);
    expect(qualifiesUnknownSignerTrust({ ...evidence, sourceSignatureVerified: false })).toBe(false);
    expect(qualifiesUnknownSignerTrust({ ...evidence, targetMd5Matches: false })).toBe(false);
    expect(qualifiesUnknownSignerTrust({ ...evidence, recoveryMd5Matches: false })).toBe(false);
    expect(qualifiesUnknownSignerTrust({ ...evidence, selectedByMetadata: 'ota_0' })).toBe(false);
    expect(qualifiesUnknownSignerTrust({ ...evidence, metadataBackupVerified: false })).toBe(false);
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
  it('does not enter the metadata writer while confirmation is still waiting, and tests writer timeout separately', async () => {
    const before = snapshot([{ seq: 3, state: ESP_OTA_IMG_VALID }, { seq: 4, state: ESP_OTA_IMG_VALID }]);
    const analysis = analyzeOtaMetadata(before, { factoryPresent: true });
    const plan = planOtaActivation({ analysis, target: 'ota_0', actualRunningSlot: null, targetImageValid: true, otherImageValid: true,
      targetImageSha256: 'a'.repeat(64), expectedTargetSha256: 'a'.repeat(64), targetSignatureTrusted: true,
      metadataBackupVerified: true, rollbackConfig: 'unknown', antiRollbackConfig: 'unknown' });
    let finishConfirmation!: (accepted: boolean) => void;
    const writes: number[] = []; const accepted = vi.fn(); const writeStarted = vi.fn();
    const transport = { readOtadataSnapshot: async () => before,
      writeOtaSelectSector: async () => { writes.push(1); } };
    const pending = commitOtaActivationTransaction({ before, plan, transport,
      confirm: () => new Promise<boolean>((resolve) => { finishConfirmation = resolve; }), onConfirmationAccepted: accepted, onWriteStart: writeStarted });
    await Promise.resolve();
    expect(writes).toEqual([]);
    expect(accepted).not.toHaveBeenCalled();
    expect(writeStarted).not.toHaveBeenCalled();
    finishConfirmation(false);
    await expect(pending).rejects.toThrow(/cancelled before metadata write/);
    expect(writes).toEqual([]);

    const timeout = new Error('simulated metadata transport timeout');
    const writerOrder: string[] = [];
    const timedOut = commitOtaActivationTransaction({ before, plan,
      transport: { readOtadataSnapshot: async () => before, writeOtaSelectSector: async () => { writerOrder.push('writer-entered'); throw timeout; } },
      confirm: async () => true, onConfirmationAccepted: accepted, onWriteStart: () => { writerOrder.push('progress-write-stage'); writeStarted(); } });
    await expect(timedOut).rejects.toBe(timeout);
    expect(accepted).toHaveBeenCalledOnce();
    expect(writeStarted).toHaveBeenCalledOnce();
    expect(writerOrder).toEqual(['writer-entered', 'progress-write-stage']);
  });
  it('cancels activation after the final metadata reread without entering the writer', async () => {
    const before = snapshot([{ seq: 3, state: ESP_OTA_IMG_VALID }, { seq: 4, state: ESP_OTA_IMG_VALID }]);
    const analysis = analyzeOtaMetadata(before, { factoryPresent: true });
    const plan = planOtaActivation({ analysis, target: 'ota_0', actualRunningSlot: null, targetImageValid: true, otherImageValid: true,
      targetImageSha256: 'a'.repeat(64), expectedTargetSha256: 'a'.repeat(64), targetSignatureTrusted: true,
      metadataBackupVerified: true, rollbackConfig: 'unknown', antiRollbackConfig: 'unknown' });
    const controller = new AbortController(); let finishRead!: (bytes: Uint8Array) => void;
    const writer = vi.fn(async () => undefined);
    const pending = commitOtaActivationTransaction({ before, plan,
      transport: { readOtadataSnapshot: () => new Promise((resolve) => { finishRead = resolve; }), writeOtaSelectSector: writer },
      confirm: async () => true, signal: controller.signal });
    await Promise.resolve();
    controller.abort(); finishRead(before);
    await expect(pending).rejects.toThrow(/cancelled before metadata write/);
    expect(writer).not.toHaveBeenCalled();
  });
  it('cancels emergency restore during final metadata reread without entering the writer', async () => {
    const before = snapshot([{ seq: 5, state: ESP_OTA_IMG_INVALID }, { seq: 4, state: ESP_OTA_IMG_ABORTED }]);
    const controller = new AbortController(); let finishRead!: (bytes: Uint8Array) => void;
    const writer = vi.fn(async () => undefined);
    const pending = commitOtaRecoveryTransaction({ before, address: 0x13000, sequence: 6,
      transport: { readOtadataSnapshot: () => new Promise((resolve) => { finishRead = resolve; }), writeOtaRecoverySector: writer },
      confirm: async () => true, signal: controller.signal });
    await Promise.resolve();
    controller.abort(); finishRead(before);
    await expect(pending).rejects.toThrow(/cancelled before metadata write/);
    expect(writer).not.toHaveBeenCalled();
  });
  it('restores with one exact 4 KiB valid record at the planned metadata sector', async () => {
    const before = snapshot([{ seq: 5, state: ESP_OTA_IMG_INVALID }, { seq: 4, state: ESP_OTA_IMG_ABORTED }]);
    const writer = vi.fn(async (_address: number, _bytes: Uint8Array, _sequence: number) => undefined);
    const committed = await commitOtaRecoveryTransaction({ before, address: 0x13000, sequence: 6,
      transport: { readOtadataSnapshot: async () => before, writeOtaRecoverySector: writer }, confirm: async () => true });
    expect(committed).toEqual({ address: 0x13000, sequence: 6 });
    expect(writer).toHaveBeenCalledTimes(1);
    expect(writer.mock.calls[0]?.[0]).toBe(0x13000);
    expect(writer.mock.calls[0]?.[1]).toHaveLength(4096);
    expect(new DataView(writer.mock.calls[0]![1].buffer).getUint32(28, true)).toBe(calculateOtaSeqCrc32(6));
  });
  it('plans emergency recovery as a first-valid-sector transaction and preserves a viable peer', () => {
    const live = analyzeOtaMetadata(snapshot([{ seq: 5, state: ESP_OTA_IMG_INVALID }, { seq: 4, state: ESP_OTA_IMG_ABORTED }]), { factoryPresent: true });
    const backup = analyzeOtaMetadata(snapshot([{ seq: 3, state: ESP_OTA_IMG_VALID }, { seq: 4, state: ESP_OTA_IMG_VALID }]), { factoryPresent: true });
    const plan = planOtaMetadataRestore(live, backup, true);
    expect(plan).toMatchObject({ target: 'ota_1', sequence: 6, sectorAddress: 0x13000, writeLength: 4096,
      method: 'single-sector-valid-record-preserving-peer', blockers: [] });
    expect(planOtaMetadataRestore(live, backup, false).blockers).toContain('The recovery application selected by the backup is not currently valid and trusted.');
    const nearWrap = analyzeOtaMetadata(snapshot([{ seq: 0xfffffffd, state: ESP_OTA_IMG_VALID }, { seq: 0xfffffffb, state: ESP_OTA_IMG_VALID }]), { factoryPresent: true });
    expect(planOtaMetadataRestore(nearWrap, backup, true).blockers.join('\n')).toMatch(/unsigned wrap/);
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
