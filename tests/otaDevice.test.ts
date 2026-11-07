import { describe, expect, it, vi } from 'vitest';
import { buildOtaStatusReport } from '../src/otaDevice.js';
import { WG1200_CONSTANTS } from '../src/upstream/flasher/constants.js';
import { calculateOtaSeqCrc32, ESP_OTA_IMG_VALID } from '../src/upstream/flasher/otadata.js';

function otaBytes(): Uint8Array {
  const bytes = new Uint8Array(WG1200_CONSTANTS.OTADATA.size).fill(0xff);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 4, true); view.setUint32(24, ESP_OTA_IMG_VALID, true); view.setUint32(28, calculateOtaSeqCrc32(4), true);
  view.setUint32(4096, 5, true); view.setUint32(4096 + 24, ESP_OTA_IMG_VALID, true); view.setUint32(4096 + 28, 0, true);
  return bytes;
}

function makeInput() {
  const headers = new Uint8Array(4096).fill(0xff);
  const readRegionChunks = vi.fn(async function* (_offset: number, size: number) { yield new Uint8Array(size).fill(0xff); });
  const transport = { readRegionChunks, readSecureBootConfiguration: vi.fn(async () => ({ secureBootV2: { status: 'enabled' } })) };
  const inspection = { partitions: { ota_0: { offset: WG1200_CONSTANTS.APP_OTA_0.offset, size: WG1200_CONSTANTS.APP_OTA_0.size },
    ota_1: { offset: WG1200_CONSTANTS.APP_OTA_1.offset, size: WG1200_CONSTANTS.APP_OTA_1.size } },
    otadataRaw: otaBytes(), appHeaders: { [WG1200_CONSTANTS.APP_OTA_0.offset.toString(16)]: headers,
      [WG1200_CONSTANTS.APP_OTA_1.offset.toString(16)]: headers } };
  return { transport, inspection, readRegionChunks };
}

describe('OTA status verification modes', () => {
  it('defaults to fast cached descriptor evidence and never reads whole application partitions', async () => {
    const { transport, inspection, readRegionChunks } = makeInput();
    const result = await buildOtaStatusReport({ transport, inspection });
    expect(result.verificationMode).toBe('fast');
    expect(readRegionChunks).not.toHaveBeenCalled();
    expect(result.metadata.sectors.map((sector) => sector.crcValid)).toEqual([true, false]);
    expect(result.antiRollback.status).toBe('unknown');
    expect(result.slots.ota_0).toMatchObject({ offset: WG1200_CONSTANTS.APP_OTA_0.offset, sha256: null, descriptor: null, securityVersion: null,
        imageVerification: { method: 'descriptor-and-metadata-only', fullSha256Verified: false, signatureVerified: null,
        trustedBaselineMatched: null, deviceMd5BaselineMatched: null } });
    expect(result.slots.ota_1).toMatchObject({ imageVerification: { signatureVerified: null, trustedBaselineMatched: null } });
  });

  it('reads both complete OTA partitions in thorough mode and reports calculated hashes separately from baseline trust', async () => {
    const { transport, inspection, readRegionChunks } = makeInput();
    await buildOtaStatusReport({ transport, inspection, verificationMode: 'thorough' });
    expect(readRegionChunks).toHaveBeenCalledTimes(3);
    expect(readRegionChunks.mock.calls.map(([offset, size]) => [offset, size])).toEqual([
      [WG1200_CONSTANTS.OTADATA.offset, WG1200_CONSTANTS.OTADATA.size],
      [WG1200_CONSTANTS.APP_OTA_0.offset, WG1200_CONSTANTS.APP_OTA_0.size],
      [WG1200_CONSTANTS.APP_OTA_1.offset, WG1200_CONSTANTS.APP_OTA_1.size],
    ]);
  });
});
