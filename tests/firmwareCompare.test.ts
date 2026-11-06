import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compareBackupToFirmware } from '../src/firmwareCompare.js';
import { createInactiveBackup } from '../src/stageOnly.js';
import { parseAppDescriptor } from '../src/upstream/flasher/appDescriptor.js';
import { parseEsp32S3ImageBoundary, verifySecureBootV2Image } from '../src/upstream/flasher/secureBoot.js';
import type { CachedFirmware } from '../src/firmwareStore.js';
import { WG1200_CONSTANTS } from '../src/upstream/flasher/constants.js';
import { createSignedWeatherXmImage } from './fixtures/secureFirmware.js';

const dirs: string[] = [];
async function tempDir() { const dir = await mkdtemp(join(tmpdir(), 'wg1200-compare-')); dirs.push(dir); return dir; }
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

async function makeBackup(path: string, image: Uint8Array) {
  const partition = new Uint8Array(WG1200_CONSTANTS.MAX_APP_SIZE_BYTES); partition.fill(0xff); partition.set(image);
  async function* chunks() { for (let i = 0; i < partition.length; i += 4096) yield partition.subarray(i, i + 4096); }
  const manifest = await createInactiveBackup({ outputPath: path, label: 'ota_0', offset: WG1200_CONSTANTS.APP_OTA_0.offset,
    length: partition.length, chip: { model: 'ESP32-S3', revision: '0.2' }, readChunks: chunks(), hashLivePartition: async () => sha(partition) });
  return { partition, manifest };
}
function cached(data: Uint8Array, version = '0.8.34'): CachedFirmware {
  const entry = { name: 'WeatherXM', version, file: 'https://flash.weatherxm.com/image.bin', bytes: data.length, sha256: sha(data), category: 'weatherxm', secure_boot_v2: true };
  return { entry, verified: { entry, data, sha256: sha(data) }, descriptor: parseAppDescriptor(data)!, cachePath: '/tmp/official.bin', reused: false,
    signature: verifySecureBootV2Image(data) };
}

describe('ESP32-S3 backup image boundaries and offline comparison', () => {
  it('parses signed-image extent from ESP segments and signature padding, not erased partition tail', async () => {
    const { data } = createSignedWeatherXmImage();
    const partition = new Uint8Array(WG1200_CONSTANTS.MAX_APP_SIZE_BYTES); partition.fill(0xff); partition.set(data);
    const parsed = parseEsp32S3ImageBoundary(partition);
    expect(parsed).toMatchObject({ status: 'valid-signature', imageLength: data.length, signedLength: 0x10000,
      signatureBlockCount: 1, chipId: 9, appendedDigest: true, trailingErased: true });
  });

  it('compares exact signed image bytes and reports full-partition trailing data separately', async () => {
    const dir = await tempDir(); const { data } = createSignedWeatherXmImage(); const path = join(dir, 'ota0.bin');
    const backup = await makeBackup(path, data);
    expect(backup.manifest.actualImageLength).toBe(data.length);
    expect(backup.manifest.actualImageSha256).toBe(sha(data));
    expect(backup.manifest.signatureVerification.status).toBe('valid');
    const result = await compareBackupToFirmware(path, cached(data));
    expect(result).toMatchObject({ outcome: 'EXACT IMAGE MATCH', sameVersion: true, sameBuildIdentity: true,
      exactBytesCompared: data.length, trailingPartitionBytes: backup.partition.length - data.length, trailingPartitionErased: true,
      backup: { sha256: sha(backup.partition), signature: 'valid-signature' }, firmware: { officialManifestVerified: true } });
  });

  it('distinguishes same build with different signed bytes and different build identities', async () => {
    const dir = await tempDir(); const original = createSignedWeatherXmImage(); const path = join(dir, 'ota0.bin');
    await makeBackup(path, original.data);
    const differentSigning = createSignedWeatherXmImage();
    const sameBuild = await compareBackupToFirmware(path, cached(differentSigning.data));
    expect(sameBuild.outcome).toBe('MATCHING BUILD — IMAGE DIFFERENCES');
    expect(sameBuild.sameBuildIdentity).toBe(true);
    expect(sameBuild.differingBytes).toBeGreaterThan(0);
    const otherBuild = createSignedWeatherXmImage('0.8.35', '22'.repeat(32));
    const different = await compareBackupToFirmware(path, cached(otherBuild.data, '0.8.35'));
    expect(different.outcome).toBe('DIFFERENT FIRMWARE BUILD');
    expect(different.sameBuildIdentity).toBe(false);
  });

  it('reports invalid signature and malformed manifests instead of claiming image identity', async () => {
    const dir = await tempDir(); const image = createSignedWeatherXmImage(); const path = join(dir, 'bad.bin');
    const corrupt = image.data.slice(); corrupt[0x10000 + 812] ^= 1;
    const manifest = await makeBackup(path, corrupt);
    expect(manifest.manifest.signatureVerification.status).toBe('invalid');
    const report = await compareBackupToFirmware(path, cached(image.data));
    expect(report.outcome).toBe('SIGNATURE VERIFICATION FAILED');
    const malformedPath = join(dir, 'not-a-backup.bin');
    await expect(compareBackupToFirmware(malformedPath, cached(image.data))).rejects.toThrow(/requires the backup manifest/);
  });
});
