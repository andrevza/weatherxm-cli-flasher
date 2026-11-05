import { describe, expect, it, vi } from 'vitest';
import { validateExactPartitionLayout, runOtaWriteTransaction, summarizeBootLog } from '../src/device.js';
import { EXPECTED_WG1200_PARTITIONS, parsePartitionTableWithMetadata } from '../src/upstream/flasher/partitions.js';
import { validateManifest, fetchAndVerifyFirmware } from '../src/upstream/flasher/manifest.js';
import { determineActiveBootSlot, buildOtadataSector, ESP_OTA_IMG_VALID } from '../src/upstream/flasher/otadata.js';
import { WG1200_CONSTANTS } from '../src/upstream/flasher/constants.js';
import { assertAllowedApplicationWrite } from '../src/upstream/flasher/writeGuard.js';
import { Wg1200Transport, assertCompleteProtectedRegionSnapshots } from '../src/upstream/flasher/transport.js';
import { configureEsptoolTrace } from '../src/upstream/flasher/transport.js';
import { fetchCatalog } from '../src/catalog.js';
import { md5Hex } from '../src/upstream/flasher/hashing.js';
import { assertFirmwareSecurityReady, firmwareSecurityReady } from '../src/upstream/flasher/securityPolicy.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function makeTableFixture() {
  const bytes = new Uint8Array(WG1200_CONSTANTS.PARTITION_TABLE.size).fill(0xff);
  const entries = new Uint8Array(Object.keys(EXPECTED_WG1200_PARTITIONS).length * 32);
  entries.fill(0);
  const view = new DataView(entries.buffer);
  let i = 0;
  for (const [label, part] of Object.entries(EXPECTED_WG1200_PARTITIONS)) {
    const at = i * 32;
    view.setUint16(at, WG1200_CONSTANTS.PARTITION_TABLE_MAGIC, true);
    view.setUint8(at + 2, part.type ?? 1); view.setUint8(at + 3, part.subtype ?? 0);
    view.setUint32(at + 4, part.offset, true); view.setUint32(at + 8, part.size, true);
    for (let j = 0; j < label.length; j++) entries[at + 12 + j] = label.charCodeAt(j);
    i++;
  }
  bytes.set(entries);
  const md5At = entries.length;
  const md5View = new DataView(bytes.buffer);
  md5View.setUint16(md5At, 0xebeb, true); md5View.setUint8(md5At + 2, 0xff); md5View.setUint8(md5At + 3, 0xff);
  const digest = md5Hex(entries);
  for (let j = 0; j < 16; j++) bytes[md5At + 16 + j] = Number.parseInt(digest.slice(j * 2, j * 2 + 2), 16);
  return bytes;
}

const OTA_BEFORE = (() => {
  const bytes = new Uint8Array(WG1200_CONSTANTS.OTADATA.size).fill(0xff);
  bytes.set(buildOtadataSector(1, ESP_OTA_IMG_VALID), 0);
  return bytes;
})();

function fakeParsed(overrides: { extra?: string; duplicate?: boolean; md5Valid?: boolean | null; overlap?: boolean } = {}) {
  const partitions = Object.fromEntries(Object.entries(EXPECTED_WG1200_PARTITIONS).map(([label, p]) => [label, {
    label, offset: p.offset, size: p.size, type: p.type ?? 1, subtype: p.subtype ?? 0, flags: 0,
  }]));
  if (overrides.extra) partitions[overrides.extra] = { label: overrides.extra, offset: 0x1000000, size: 0x1000, type: 1, subtype: 0, flags: 0 };
  if (overrides.overlap) partitions.nvs_key.offset = partitions.spiffs.offset;
  return { partitions, duplicateLabels: overrides.duplicate ? ['nvs'] : [], md5Valid: overrides.md5Valid === undefined ? true : overrides.md5Valid };
}

describe('read-only safety validation', () => {
  it('rejects an OTA sequence that would be interpreted as erased before any write', async () => {
    const installApplication = vi.fn();
    const transport = { installApplication } as unknown as Wg1200Transport;
    await expect(runOtaWriteTransaction(transport, { targetOffset: WG1200_CONSTANTS.APP_OTA_1.offset,
      firmwareBytes: new Uint8Array([1]), nextSeq: 0xffffffff, targetSector: 1, snapshots: [], otadataBefore: OTA_BEFORE }))
      .rejects.toThrow(/sequence is outside/);
    expect(installApplication).not.toHaveBeenCalled();
  });

  it('summarizes post-boot firmware, Secure Boot, and calibration messages without printing raw logs', () => {
    expect(summarizeBootLog([
      'I secure_boot_v2: Signature verified successfully!',
      'I app_init: App version: 0.8.34-g86b609b',
      'I phy_init: Saving new calibration data due to checksum failure or outdated calibration data',
    ])).toEqual({ bootVersion: '0.8.34-g86b609b', secureBootVerified: true, calibrationUpdated: true });
  });
  it('fails closed when device-specific Secure Boot and rollback evidence is unavailable', () => {
    expect(firmwareSecurityReady()).toBe(false);
    expect(() => assertFirmwareSecurityReady()).toThrow(/Secure Boot V2 signature trust and gateway anti-rollback compatibility are not verified/);
  });
  it('parses and accepts a fixture with the complete signed-off partition table structure', () => {
    const parsed = parsePartitionTableWithMetadata(makeTableFixture());
    expect(parsed.md5Valid).toBe(true);
    expect(validateExactPartitionLayout(parsed, makeTableFixture())).toEqual([]);
    const damaged = makeTableFixture(); damaged[9 * 32 + 16] ^= 0xff;
    expect(parsePartitionTableWithMetadata(damaged).md5Valid).toBe(false);
  });
  it('accepts the real WG1200 partition fixture copied from the official repository', () => {
    const path = new URL('./fixtures/wg1200-partition-table.bin', import.meta.url);
    const bytes = new Uint8Array(readFileSync(fileURLToPath(path)));
    expect(validateExactPartitionLayout(parsePartitionTableWithMetadata(bytes), bytes)).toEqual([]);
  });
  it('accepts only the complete expected WG1200 partition layout with a verified table MD5', () => {
    expect(validateExactPartitionLayout(fakeParsed())).toEqual([]);
    expect(validateExactPartitionLayout(fakeParsed({ md5Valid: null }))).toContain('partition table MD5 must be present and valid (result: null)');
    expect(validateExactPartitionLayout(fakeParsed({ extra: 'custom_data' })).join(' ')).toContain('unexpected partition labels');
    expect(validateExactPartitionLayout(fakeParsed({ overlap: true })).join(' ')).toContain('overlap');
    expect(validateExactPartitionLayout(fakeParsed({ duplicate: true })).join(' ')).toContain('duplicate labels');
  });

  it('rejects empty-label records and nonzero partition flags even when MD5 is recomputed', () => {
    const bytes = makeTableFixture();
    const extraAt = 9 * 32;
    const view = new DataView(bytes.buffer);
    view.setUint16(extraAt, WG1200_CONSTANTS.PARTITION_TABLE_MAGIC, true);
    view.setUint32(extraAt + 4, 0x100000, true); view.setUint32(extraAt + 8, 0x1000, true);
    bytes.fill(0, extraAt + 12, extraAt + 28); view.setUint32(extraAt + 28, 0, true);
    const md5At = 10 * 32;
    view.setUint16(md5At, 0xebeb, true); view.setUint8(md5At + 2, 0xff); view.setUint8(md5At + 3, 0xff);
    const digest = md5Hex(bytes.subarray(0, extraAt + 32));
    for (let j = 0; j < 16; j++) bytes[md5At + 16 + j] = Number.parseInt(digest.slice(j * 2, j * 2 + 2), 16);
    const parsed = parsePartitionTableWithMetadata(bytes);
    expect(validateExactPartitionLayout(parsed, bytes).join(' ')).toContain('empty label');

    const flagged = makeTableFixture(); new DataView(flagged.buffer).setUint32(28, 1, true);
    expect(validateExactPartitionLayout(parsePartitionTableWithMetadata(flagged), flagged).join(' ')).toContain('unexpected flags');
  });

  it('rejects an altered or malformed firmware manifest before download', () => {
    const fw = { name: 'WeatherXM', version: '1', file: '/fw.bin', bytes: 100, sha256: 'a'.repeat(64), secure_boot_v2: true };
    const good = { schema: 1, hardware: 'WG1200', chip: 'ESP32-S3', flash_bytes: WG1200_CONSTANTS.FLASH_SIZE_BYTES, app_partition_bytes: WG1200_CONSTANTS.MAX_APP_SIZE_BYTES, firmwares: { weatherxm: fw, meshtastic: { ...fw, name: 'Meshtastic' } } };
    expect(() => validateManifest(good)).not.toThrow();
    expect(() => validateManifest({ ...good, flash_bytes: 8 * 1024 * 1024 })).toThrow(/flash_bytes mismatch/);
  });

  it('treats an unavailable manifest as an operational error', async () => {
    await expect(fetchCatalog('https://example.test/manifest.json', vi.fn(async () => new Response('', { status: 503, statusText: 'Unavailable' }))))
      .rejects.toThrow(/Manifest request failed: HTTP 503/);
  });

  it('keeps esptool lifecycle TRACE off stdout unless diagnostics are enabled and preserves serial errors', () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const debug = vi.fn(), error = vi.fn();
    const transport = { trace: vi.fn() } as any;
    configureEsptoolTrace(transport, { log: vi.fn(), error, debug }, false);
    transport.trace('Serial port done');
    transport.trace('readLoop exited');
    transport.trace('Unrecoverable serial port error: disconnected');
    expect(output).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith('[serial] Unrecoverable serial port error: disconnected');
    expect(debug).not.toHaveBeenCalled();
    output.mockRestore();
  });

  it('rejects an image with wrong length before computing integrity', async () => {
    const fw = { name: 'WeatherXM', version: '1', file: 'https://example.test/fw.bin', bytes: 99, sha256: 'a'.repeat(64), secure_boot_v2: true };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(100), { status: 200 })));
    await expect(fetchAndVerifyFirmware(fw)).rejects.toThrow(/size mismatch/);
    vi.unstubAllGlobals();
  });

  it('rejects a same-size image whose SHA-256 does not match the manifest', async () => {
    const bytes = new Uint8Array(4096);
    bytes[0] = 0xe7; // Required upstream signature-block marker at length - 4096.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes, { status: 200 })));
    await expect(fetchAndVerifyFirmware({ name: 'WeatherXM', version: '1', file: 'https://example.test/fw.bin', bytes: 4096, sha256: 'a'.repeat(64), secure_boot_v2: true })).rejects.toThrow(/SHA-256/);
    vi.unstubAllGlobals();
  });

  it('blocks factory/protected writes before esptool can write flash', async () => {
    expect(assertAllowedApplicationWrite(WG1200_CONSTANTS.APP_OTA_0.offset, 4096)).toBe('ota_0');
    expect(() => assertAllowedApplicationWrite(WG1200_CONSTANTS.APP_FACTORY.offset, 4096)).toThrow(/protected partition|not fully contained/);
    const transport = new Wg1200Transport();
    const writeFlash = vi.fn();
    (transport as any).loader = { writeFlash };
    await expect(transport.installApplication(WG1200_CONSTANTS.APP_FACTORY.offset, new Uint8Array(4096))).rejects.toThrow(/protected partition|not fully contained/);
    // --force is a CLI duplicate-install override only; it is not accepted by or forwarded into the writer.
    await expect((transport.installApplication as any)(WG1200_CONSTANTS.APP_FACTORY.offset, new Uint8Array(4096), undefined, true)).rejects.toThrow(/protected partition|not fully contained/);
    expect(writeFlash).not.toHaveBeenCalled();
  });

  it('requires complete exact protected-region snapshots and fails closed on short reads', async () => {
    const required = [
      { name: 'partition_table', ...WG1200_CONSTANTS.PARTITION_TABLE },
      { name: 'esp_secure_cert', ...WG1200_CONSTANTS.SECURE_CERT },
      { name: 'nvs', ...WG1200_CONSTANTS.NVS },
      { name: 'phy_init', ...WG1200_CONSTANTS.PHY_INIT },
      { name: 'factory', offset: WG1200_CONSTANTS.APP_FACTORY.offset, size: WG1200_CONSTANTS.APP_FACTORY.size },
      { name: 'nvs_key', ...WG1200_CONSTANTS.NVS_KEY },
      { name: 'spiffs', ...WG1200_CONSTANTS.SPIFFS },
    ].map((region) => ({ ...region, sha256: 'a'.repeat(64) }));
    expect(() => assertCompleteProtectedRegionSnapshots(required)).not.toThrow();
    expect(() => assertCompleteProtectedRegionSnapshots(required.filter((r) => r.name !== 'factory'))).toThrow(/complete, exact/);
    expect(() => assertCompleteProtectedRegionSnapshots([...required, required[0]])).toThrow(/complete, exact/);

    const transport = new Wg1200Transport();
    (transport as any).loader = { readFlash: vi.fn(async () => new Uint8Array(1)) };
    await expect(transport.snapshotProtectedRegions()).rejects.toThrow(/Incomplete protected flash read/);
  });

  it('refuses OTA commit if metadata changed after the pre-write snapshot', async () => {
    const transport = new Wg1200Transport();
    const writeFlash = vi.fn(async (_options: any) => undefined);
    (transport as any).loader = { writeFlash };
    vi.spyOn(transport, 'readOtadataSnapshot').mockResolvedValue(new Uint8Array(WG1200_CONSTANTS.OTADATA.size).fill(0xff));
    await expect(transport.writeOtaSelectSector(0x14000, buildOtadataSector(2), 2, OTA_BEFORE)).rejects.toThrow(/changed during app installation/);
    expect(writeFlash).not.toHaveBeenCalled();
  });

  it('verifies the full OTA metadata readback and preserves the untouched peer sector', async () => {
    const transport = new Wg1200Transport();
    const writeFlash = vi.fn(async (_options: any) => undefined);
    (transport as any).loader = { writeFlash };
    const after = new Uint8Array(OTA_BEFORE);
    after.set(buildOtadataSector(2), 4096);
    vi.spyOn(transport, 'readOtadataSnapshot').mockResolvedValueOnce(OTA_BEFORE).mockResolvedValueOnce(after);
    await expect(transport.writeOtaSelectSector(0x14000, buildOtadataSector(2), 2, OTA_BEFORE)).resolves.toBeUndefined();
    expect(writeFlash).toHaveBeenCalledTimes(1);
    expect(writeFlash.mock.calls[0]?.[0]?.eraseAll).toBe(false);
  });

  it('keeps OTA selection untouched when the application MD5 check fails', async () => {
    const calls: string[] = [];
    const mock = {
      installApplication: vi.fn(async () => { calls.push('write-app'); }),
      verifyApplicationFlash: vi.fn(async () => { calls.push('verify-app'); return false; }),
      writeOtaSelectSector: vi.fn(async () => { calls.push('select-ota'); }),
      verifyProtectedRegions: vi.fn(async () => ({ valid: true, mismatches: [] })),
      hardReset: vi.fn(async () => { calls.push('reset'); }),
    };
    await expect(runOtaWriteTransaction(mock, { targetOffset: WG1200_CONSTANTS.APP_OTA_1.offset, firmwareBytes: new Uint8Array([1]), nextSeq: 2, targetSector: 1, snapshots: [], otadataBefore: OTA_BEFORE })).rejects.toThrow(/MD5 mismatch/);
    expect(calls).toEqual(['write-app', 'verify-app']);
    expect(mock.writeOtaSelectSector).not.toHaveBeenCalled();
  });

  it('checks protected data before committing OTA metadata and stops on either failure', async () => {
    const writeOtaSelectSector = vi.fn(async () => undefined);
    writeOtaSelectSector.mockRejectedValueOnce(new Error('metadata readback failed'));
    const base = {
      installApplication: vi.fn(async () => undefined), verifyApplicationFlash: vi.fn(async () => true),
      writeOtaSelectSector,
      verifyProtectedRegions: vi.fn(async () => ({ valid: true, mismatches: [] })),
      hardReset: vi.fn(async () => undefined),
    };
    await expect(runOtaWriteTransaction(base, { targetOffset: WG1200_CONSTANTS.APP_OTA_1.offset, firmwareBytes: new Uint8Array([1]), nextSeq: 2, targetSector: 1, snapshots: [], otadataBefore: OTA_BEFORE })).rejects.toThrow(/metadata readback failed/);
    expect(base.verifyProtectedRegions).toHaveBeenCalledTimes(1);
    expect(base.hardReset).not.toHaveBeenCalled();

    writeOtaSelectSector.mockClear();
    base.verifyProtectedRegions.mockResolvedValueOnce({ valid: false, mismatches: ['nvs changed'] } as any);
    await expect(runOtaWriteTransaction(base, { targetOffset: WG1200_CONSTANTS.APP_OTA_1.offset, firmwareBytes: new Uint8Array([1]), nextSeq: 2, targetSector: 1, snapshots: [], otadataBefore: OTA_BEFORE })).rejects.toThrow(/nvs changed/);
    expect(writeOtaSelectSector).not.toHaveBeenCalled();
    expect(base.hardReset).not.toHaveBeenCalled();
  });

  it('records the required order and never activates after protected-region mismatch', async () => {
    const calls: string[] = [];
    const mock = {
      installApplication: vi.fn(async () => { calls.push('erase-write'); }),
      verifyApplicationFlash: vi.fn(async () => { calls.push('image-verify'); return true; }),
      verifyProtectedRegions: vi.fn(async () => { calls.push('protected-verify'); return { valid: false, mismatches: ['spiffs changed'] }; }),
      writeOtaSelectSector: vi.fn(async () => { calls.push('ota-commit'); }),
      hardReset: vi.fn(async () => { calls.push('reset'); }),
    };
    await expect(runOtaWriteTransaction(mock, { targetOffset: WG1200_CONSTANTS.APP_OTA_1.offset, firmwareBytes: new Uint8Array([1]), nextSeq: 2, targetSector: 1, snapshots: [], otadataBefore: OTA_BEFORE })).rejects.toThrow(/spiffs changed/);
    expect(calls).toEqual(['erase-write', 'image-verify', 'protected-verify']);
    expect(mock.writeOtaSelectSector).not.toHaveBeenCalled();
    expect(mock.hardReset).not.toHaveBeenCalled();
  });

  it('reports flash, OTA, and protected-data verification only after each stage succeeds', async () => {
    const result = await runOtaWriteTransaction({
      installApplication: vi.fn(async () => undefined),
      verifyApplicationFlash: vi.fn(async () => true),
      writeOtaSelectSector: vi.fn(async () => undefined),
      verifyProtectedRegions: vi.fn(async () => ({ valid: true, mismatches: [] })),
      hardReset: vi.fn(async () => true),
    }, { targetOffset: WG1200_CONSTANTS.APP_OTA_1.offset, firmwareBytes: new Uint8Array([1, 2, 3]), nextSeq: 2, targetSector: 1, snapshots: [], otadataBefore: OTA_BEFORE });
    expect(result).toEqual({ flashVerified: true, otaMetadataVerified: true, protectedPartitionsVerified: true, deviceReleased: true });
  });

  it('uses the official sequence/CRC mapping for OTA slot state', () => {
    const sectors = new Uint8Array(WG1200_CONSTANTS.OTADATA.size).fill(0xff);
    sectors.set(buildOtadataSector(1, ESP_OTA_IMG_VALID), 0);
    const state = determineActiveBootSlot(sectors);
    expect(state.activeSlot).toBe('ota_0');
    expect(state.targetSlot).toBe('ota_1');
    expect(state.targetSector).toBe(1);
    expect(state.nextSeq).toBe(2);
  });

  it('refuses invalid non-erased OTA records as ambiguous', () => {
    const sectors = new Uint8Array(WG1200_CONSTANTS.OTADATA.size).fill(0x00);
    const state = determineActiveBootSlot(sectors);
    expect(state.isAmbiguous).toBe(true);
    expect(state.activeSlot).toBe('factory');
  });
});
