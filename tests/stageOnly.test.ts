import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInactiveBackup, runStageOnlyTransaction, validateInactiveBackup, type StageOnlyOperations } from '../src/stageOnly.js';

const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const md5 = (data: Uint8Array) => createHash('md5').update(data).digest('hex');
const tempDirs: string[] = [];
async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'wg1200-stage-test-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(async () => { await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

function ops(overrides: Partial<StageOnlyOperations> = {}) {
  const events: string[] = [];
  const defaults: StageOnlyOperations = {
    revalidate: vi.fn(async () => { events.push('revalidate'); return true; }),
    writeApplication: vi.fn(async () => { events.push('write'); }),
    verifyHardwareMd5: vi.fn(async () => { events.push('md5'); return true; }),
    readbackSha256: vi.fn(async () => { events.push('sha256'); return sha(bytes); }),
    verifyProtected: vi.fn(async () => { events.push('protected'); return { valid: true, mismatches: [] }; }),
    readOtadata: vi.fn(async () => { events.push('otadata'); return new Uint8Array(8192).fill(0xaa); }),
    resetNormal: vi.fn(async () => { events.push('reset'); }),
  };
  return { events, mock: { ...defaults, ...overrides }, input: {
    activeSlot: 'ota_1' as const, targetOffset: 0x420000, targetLength: 0x400000,
    firmwareBytes: bytes, expectedSha256: sha(bytes), expectedMd5: md5(bytes),
    otadataBefore: new Uint8Array(8192).fill(0xaa), confirm: vi.fn(async () => true),
  } };
}

describe('stage-only transaction', () => {
  it('writes only ota_0, verifies bytes and protected state, preserves otadata, and never calls activation', async () => {
    const { events, mock, input } = ops();
    const result = await runStageOnlyTransaction(mock, input);
    expect(result).toMatchObject({ outcome: 'STAGED AND VERIFIED — NOT ACTIVATED', expectedSha256: sha(bytes), actualSha256: sha(bytes), bytesRead: bytes.length, range: { start: 0x420000, end: 0x420008 } });
    expect(events).toEqual(['revalidate', 'write', 'md5', 'sha256', 'protected', 'otadata', 'reset']);
    expect(mock.writeApplication).toHaveBeenCalledWith(0x420000, bytes);
    expect('writeOtaSelectSector' in mock).toBe(false);
  });

  it('blocks an active ota_0, wrong target, oversized write, hash mismatch, and operator cancellation before writing', async () => {
    for (const overrides of [
      { activeSlot: 'ota_0' as const }, { targetOffset: 0x820000 }, { targetLength: 0x3fffff },
      { expectedSha256: '0'.repeat(64) },
    ]) {
      const { mock, input } = ops();
      await expect(runStageOnlyTransaction(mock, { ...input, ...overrides })).rejects.toThrow(/STAGING BLOCKED/);
      expect(mock.writeApplication).not.toHaveBeenCalled();
    }
    const { mock, input } = ops(); input.confirm = vi.fn(async () => false);
    await expect(runStageOnlyTransaction(mock, input)).rejects.toThrow(/OPERATOR CANCELLED/);
    expect(mock.writeApplication).not.toHaveBeenCalled();
  });

  it('blocks if live revalidation fails and handles write interruption as potentially partial', async () => {
    const preflight = ops({ revalidate: vi.fn(async () => false) });
    await expect(runStageOnlyTransaction(preflight.mock, preflight.input)).rejects.toThrow(/PREFLIGHT FAILED/);
    expect(preflight.mock.writeApplication).not.toHaveBeenCalled();
    const interrupted = ops({ writeApplication: vi.fn(async () => { throw new Error('timeout'); }) });
    await expect(runStageOnlyTransaction(interrupted.mock, interrupted.input)).rejects.toThrow(/TARGET MAY BE PARTIALLY WRITTEN/);
    expect(interrupted.mock.verifyHardwareMd5).not.toHaveBeenCalled();
    expect(interrupted.mock.readOtadata).not.toHaveBeenCalled();
  });

  it('does not accept hardware MD5 or SHA-256 mismatch', async () => {
    const md5Fail = ops({ verifyHardwareMd5: vi.fn(async () => false) });
    await expect(runStageOnlyTransaction(md5Fail.mock, md5Fail.input)).rejects.toThrow(/hardware MD5 mismatch/);
    expect(md5Fail.mock.verifyProtected).not.toHaveBeenCalled();
    const shaFail = ops({ readbackSha256: vi.fn(async () => 'f'.repeat(64)) });
    await expect(runStageOnlyTransaction(shaFail.mock, shaFail.input)).rejects.toThrow(/SHA-256 expected/);
    expect(shaFail.mock.readOtadata).not.toHaveBeenCalled();
  });

  it('classifies verification I/O failures and does not proceed to later checks', async () => {
    const md5ReadFail = ops({ verifyHardwareMd5: vi.fn(async () => { throw new Error('serial timeout'); }) });
    await expect(runStageOnlyTransaction(md5ReadFail.mock, md5ReadFail.input)).rejects.toThrow(/VERIFICATION MISMATCH: hardware MD5 read failed/);
    expect(md5ReadFail.mock.readbackSha256).not.toHaveBeenCalled();

    const shaReadFail = ops({ readbackSha256: vi.fn(async () => { throw new Error('serial disconnected'); }) });
    await expect(runStageOnlyTransaction(shaReadFail.mock, shaReadFail.input)).rejects.toThrow(/VERIFICATION MISMATCH: SHA-256 readback failed/);
    expect(shaReadFail.mock.verifyProtected).not.toHaveBeenCalled();

    const protectedReadFail = ops({ verifyProtected: vi.fn(async () => { throw new Error('read failed'); }) });
    await expect(runStageOnlyTransaction(protectedReadFail.mock, protectedReadFail.input)).rejects.toThrow(/PROTECTED REGION CHANGED: protected-region readback failed/);
    expect(protectedReadFail.mock.readOtadata).not.toHaveBeenCalled();

    const metadataReadFail = ops({ readOtadata: vi.fn(async () => { throw new Error('read failed'); }) });
    await expect(runStageOnlyTransaction(metadataReadFail.mock, metadataReadFail.input)).rejects.toThrow(/VERIFICATION MISMATCH: OTA metadata readback failed/);
    expect(metadataReadFail.mock.resetNormal).not.toHaveBeenCalled();

    const resetFail = ops({ resetNormal: vi.fn(async () => { throw new Error('reset unavailable'); }) });
    await expect(runStageOnlyTransaction(resetFail.mock, resetFail.input)).rejects.toThrow(/VERIFICATION MISMATCH: normal-boot reset could not be confirmed/);
  });

  it('reports active-image/protected change and unexpected OTA metadata without activation', async () => {
    const protectedFail = ops({ verifyProtected: vi.fn(async () => ({ valid: false, mismatches: ['preserved_ota'] })) });
    await expect(runStageOnlyTransaction(protectedFail.mock, protectedFail.input)).rejects.toThrow(/PROTECTED REGION CHANGED/);
    expect(protectedFail.mock.readOtadata).not.toHaveBeenCalled();
    const otaChanged = ops({ readOtadata: vi.fn(async () => new Uint8Array(8192).fill(0xbb)) });
    await expect(runStageOnlyTransaction(otaChanged.mock, otaChanged.input)).rejects.toThrow(/OTA metadata changed/);
    expect(otaChanged.mock.resetNormal).not.toHaveBeenCalled();
  });
});

describe('inactive OTA backup artifacts', () => {
  it('streams a complete partition, performs an independent live hash, and finalizes file and manifest without overwrite', async () => {
    const dir = await tempDir();
    const output = join(dir, 'ota_0.bin');
    async function* chunks() { yield bytes.subarray(0, 3); yield bytes.subarray(3); }
    const manifest = await createInactiveBackup({ outputPath: output, label: 'ota_0', offset: 0x420000, length: bytes.length,
      chip: { model: 'ESP32-S3', revision: '0.2' }, readChunks: chunks(), hashLivePartition: async () => sha(bytes),
      inspect: async () => ({ descriptor: null, signature: { status: 'not-verified' as const, imageLength: null, explanation: 'No signed image boundary.' } }) });
    expect(manifest).toMatchObject({ partition: { label: 'ota_0', offset: 0x420000, length: 8 }, bytes: 8, sha256: sha(bytes), independentReadbackVerified: true, signatureVerification: { status: 'not-verified' } });
    expect(new Uint8Array(await readFile(output))).toEqual(bytes);
    const manifestPath = `${output}.manifest.json`;
    await expect(validateInactiveBackup(manifestPath, { label: 'ota_0', offset: 0x420000, length: 8 })).resolves.toMatchObject({ manifest: { sha256: sha(bytes) }, backupPath: output });
    await expect(createInactiveBackup({ outputPath: output, label: 'ota_0', offset: 0x420000, length: 8,
      chip: { model: 'ESP32-S3', revision: null }, readChunks: chunks(), hashLivePartition: async () => sha(bytes),
      inspect: async () => ({ descriptor: null, signature: { status: 'not-verified' as const, imageLength: null, explanation: 'n/a' } }) })).rejects.toThrow(/refusing to overwrite/);
  });

  it('does not finalize on short backup, live hash mismatch, corrupt bytes, wrong layout, or missing manifest', async () => {
    const dir = await tempDir();
    const mk = async (name: string, length: number, liveHash: string, parts: Uint8Array[]) => {
      async function* chunks() { for (const part of parts) yield part; }
      return createInactiveBackup({ outputPath: join(dir, name), label: 'ota_0', offset: 0x420000, length,
        chip: { model: 'ESP32-S3', revision: null }, readChunks: chunks(), hashLivePartition: async () => liveHash,
        inspect: async () => ({ descriptor: null, signature: { status: 'not-verified' as const, imageLength: null, explanation: 'n/a' } }) });
    };
    await expect(mk('short.bin', 9, sha(bytes), [bytes])).rejects.toThrow(/does not match partition length/);
    await expect(mk('mismatch.bin', 8, '0'.repeat(64), [bytes])).rejects.toThrow(/independent second flash-read/);
    await expect(validateInactiveBackup(join(dir, 'missing.json'), { label: 'ota_0', offset: 0x420000, length: 8 })).rejects.toThrow(/manifest is unreadable/);
    await expect(mk('valid.bin', 8, sha(bytes), [bytes])).resolves.toBeDefined();
    const manifestPath = join(dir, 'valid.bin.manifest.json');
    await expect(validateInactiveBackup(manifestPath, { label: 'ota_1', offset: 0x820000, length: 8 })).rejects.toThrow(/exact target partition/);
    await writeFile(join(dir, 'valid.bin'), 'corrupt');
    await expect(validateInactiveBackup(manifestPath, { label: 'ota_0', offset: 0x420000, length: 8 })).rejects.toThrow(/length or SHA-256/);
  });

  it('removes staged artifacts after a simulated flash read failure or unrecognized-image inspection failure', async () => {
    const dir = await tempDir();
    const output = join(dir, 'failed.bin');
    async function* brokenChunks() { yield bytes.subarray(0, 4); throw new Error('simulated serial disconnect'); }
    await expect(createInactiveBackup({ outputPath: output, label: 'ota_0', offset: 0x420000, length: 8,
      chip: { model: 'ESP32-S3', revision: null }, readChunks: brokenChunks(), hashLivePartition: async () => sha(bytes),
      inspect: async () => ({ descriptor: null, signature: { status: 'not-verified' as const, imageLength: null, explanation: 'n/a' } }) })).rejects.toThrow(/simulated serial disconnect/);
    await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(`${output}.manifest.json`)).rejects.toMatchObject({ code: 'ENOENT' });

    async function* chunks() { yield bytes; }
    await expect(createInactiveBackup({ outputPath: output, label: 'ota_0', offset: 0x420000, length: 8,
      chip: { model: 'ESP32-S3', revision: null }, readChunks: chunks(), hashLivePartition: async () => sha(bytes),
      inspect: async () => { throw new Error('simulated unsupported image'); } })).rejects.toThrow(/simulated unsupported image/);
    await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(`${output}.manifest.json`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes temporary backup files when cancellation arrives during streaming', async () => {
    const dir = await tempDir();
    const output = join(dir, 'cancelled.bin');
    const controller = new AbortController();
    async function* chunks() { yield bytes.subarray(0, 4); controller.abort(); yield bytes.subarray(4); }
    await expect(createInactiveBackup({ outputPath: output, label: 'ota_0', offset: 0x420000, length: 8,
      chip: { model: 'ESP32-S3', revision: null }, readChunks: chunks(), signal: controller.signal,
      hashLivePartition: async () => sha(bytes), inspect: async () => ({ descriptor: null,
        signature: { status: 'not-verified' as const, imageLength: null, explanation: 'n/a' } }) })).rejects.toThrow(/cancelled/);
    expect(await readdir(dir)).toEqual([]);
  });
});
