import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeOtaMetadata, createOtaMetadataBackup, planOtaActivation, validateOtaMetadataBackup } from '../src/otaManagement.js';
import { calculateOtaSeqCrc32, ESP_OTA_IMG_ABORTED, ESP_OTA_IMG_INVALID, ESP_OTA_IMG_VALID } from '../src/upstream/flasher/otadata.js';

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
  it('always blocks activation when running slot/configuration evidence is missing and plans no writes', () => {
    const analysis = analyzeOtaMetadata(snapshot([{ seq: 4, state: ESP_OTA_IMG_VALID }, { seq: 3, state: ESP_OTA_IMG_VALID }]), { factoryPresent: true });
    const plan = planOtaActivation({ analysis, target: 'ota_0', actualRunningSlot: null, targetImageValid: true, otherImageValid: true,
      targetImageSha256: 'a'.repeat(64), expectedTargetSha256: 'a'.repeat(64), targetSignatureTrusted: true,
      metadataBackupVerified: true, rollbackConfig: 'unknown', antiRollbackConfig: 'unknown' });
    expect(plan.outcome).toBe('ACTIVATION BLOCKED'); expect(plan.writeRanges).toEqual([]);
    expect(plan.proposedUpdate).toMatchObject({ sectorAddress: 0x14000, sequence: 5, priorSectorPreserved: true });
    expect(plan.blockers.join('\n')).toMatch(/running slot/); expect(plan.blockers.join('\n')).toMatch(/rollback configuration/);
    const returnPlan = planOtaActivation({ analysis, target: 'ota_1', actualRunningSlot: 'ota_0', targetImageValid: true, otherImageValid: true,
      targetImageSha256: 'a'.repeat(64), expectedTargetSha256: null, targetSignatureTrusted: true,
      metadataBackupVerified: true, rollbackConfig: 'disabled', antiRollbackConfig: 'disabled' });
    expect(returnPlan.proposedUpdate).toMatchObject({ sequence: 4, sectorAddress: 0x14000 });
    expect(returnPlan.blockers.join('\n')).toMatch(/No exact approved application digest/);
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
