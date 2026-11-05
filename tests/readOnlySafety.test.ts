import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { validateExactPartitionLayout, runOtaWriteTransaction, summarizeBootLog } from '../src/device.js';
import { EXPECTED_WG1200_PARTITIONS, parsePartitionTableWithMetadata } from '../src/upstream/flasher/partitions.js';
import { validateManifest, fetchAndVerifyFirmware } from '../src/upstream/flasher/manifest.js';
import { determineActiveBootSlot, buildOtadataSector, ESP_OTA_IMG_VALID } from '../src/upstream/flasher/otadata.js';
import { WG1200_CONSTANTS } from '../src/upstream/flasher/constants.js';
import { PROTECTED_REGIONS } from '../src/upstream/flasher/constants.js';
import { assertAllowedApplicationWrite } from '../src/upstream/flasher/writeGuard.js';
import { getApplicationEraseRange } from '../src/upstream/flasher/writeGuard.js';
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

function protectedSnapshots(preservedOtaSlot: 'ota_0' | 'ota_1' = 'ota_0') {
  const ota = preservedOtaSlot === 'ota_0' ? WG1200_CONSTANTS.APP_OTA_0 : WG1200_CONSTANTS.APP_OTA_1;
  return [...PROTECTED_REGIONS.filter((region) => region.name !== 'otadata'),
    { name: 'preserved_ota', offset: ota.offset, size: ota.size }]
    .map((region) => ({ ...region, sha256: 'a'.repeat(64) }));
}

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
      firmwareBytes: new Uint8Array([1]), nextSeq: 0xffffffff, targetSector: 1, snapshots: protectedSnapshots(), otadataBefore: OTA_BEFORE, preservedOtaSlot: 'ota_0' }))
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
    expect(() => assertFirmwareSecurityReady()).toThrow(/installed bootloader rollback and recovery behaviour/);
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

  it('bounds four-byte padding and sector-rounded erases to the exact OTA slot', () => {
    expect(getApplicationEraseRange(WG1200_CONSTANTS.APP_OTA_0.offset, 1)).toEqual({ slot: 'ota_0', start: 0x420000, end: 0x421000 });
    expect(getApplicationEraseRange(WG1200_CONSTANTS.APP_OTA_0.offset, WG1200_CONSTANTS.APP_OTA_0.size))
      .toEqual({ slot: 'ota_0', start: 0x420000, end: 0x820000 });
    expect(getApplicationEraseRange(WG1200_CONSTANTS.APP_OTA_1.offset, WG1200_CONSTANTS.APP_OTA_1.size))
      .toEqual({ slot: 'ota_1', start: 0x820000, end: 0xc20000 });
    expect(() => getApplicationEraseRange(WG1200_CONSTANTS.APP_OTA_0.offset + 4, 4096)).toThrow(/Rounded application erase/);
    expect(() => getApplicationEraseRange(WG1200_CONSTANTS.APP_OTA_0.offset + WG1200_CONSTANTS.APP_OTA_0.size - 1, 2)).toThrow(/maximum|not fully contained/);
  });

  it('simulates max-size writes as one inactive-slot file with whole-chip erase disabled', async () => {
    for (const slot of [WG1200_CONSTANTS.APP_OTA_0, WG1200_CONSTANTS.APP_OTA_1]) {
      const transport = new Wg1200Transport();
      const writeFlash = vi.fn(async (_options: any) => undefined);
      (transport as any).loader = { writeFlash };
      await transport.installApplication(slot.offset, new Uint8Array(slot.size));
      const options = writeFlash.mock.calls[0]?.[0];
      expect(writeFlash).toHaveBeenCalledTimes(1);
      expect(options.eraseAll).toBe(false);
      expect(options.fileArray).toHaveLength(1);
      expect(options.fileArray[0].address).toBe(slot.offset);
      expect(options.fileArray[0].data.byteLength).toBe(slot.size);
      const targetEnd = slot.offset + options.fileArray[0].data.byteLength;
      for (const region of PROTECTED_REGIONS) {
        expect(Math.max(slot.offset, region.offset)).toBeGreaterThanOrEqual(Math.min(targetEnd, region.offset + region.size));
      }
      const otherOta = slot.name === 'ota_0' ? WG1200_CONSTANTS.APP_OTA_1 : WG1200_CONSTANTS.APP_OTA_0;
      expect(Math.max(slot.offset, otherOta.offset)).toBeGreaterThanOrEqual(Math.min(targetEnd, otherOta.offset + otherOta.size));
    }
  });

  it('requires complete exact protected-region snapshots and fails closed on short reads', async () => {
    const required = protectedSnapshots('ota_0');
    expect(() => assertCompleteProtectedRegionSnapshots(required, 'ota_0')).not.toThrow();
    expect(() => assertCompleteProtectedRegionSnapshots(required.filter((r) => r.name !== 'factory'), 'ota_0')).toThrow(/complete, exact/);
    expect(() => assertCompleteProtectedRegionSnapshots([...required, required[0]], 'ota_0')).toThrow(/complete, exact/);
    expect(() => assertCompleteProtectedRegionSnapshots(required, 'ota_1')).toThrow(/complete, exact/);

    const transport = new Wg1200Transport();
    (transport as any).loader = { readFlash: vi.fn(async () => new Uint8Array(1)) };
    await expect(transport.snapshotProtectedRegions('ota_0')).rejects.toThrow(/Incomplete protected flash read/);
  });

  it('snapshots every fixed protected range and the whole preserved OTA slot using exact boundaries', async () => {
    const transport = new Wg1200Transport();
    const hash = vi.spyOn(transport as any, 'hashRegionSha256').mockResolvedValue('a'.repeat(64));
    const snapshots = await transport.snapshotProtectedRegions('ota_1');
    const expected = [...PROTECTED_REGIONS.filter((region) => region.name !== 'otadata'),
      { ...WG1200_CONSTANTS.APP_OTA_1, name: 'preserved_ota' }]
      .map(({ name, offset, size }) => ({ name, offset, size }));
    expect(snapshots.map(({ name, offset, size }) => ({ name, offset, size }))).toEqual(expected);
    expect(hash.mock.calls.map(([offset, size]) => ({ offset, size }))).toEqual(expected.map(({ offset, size }) => ({ offset, size })));
    expect(snapshots.find((region) => region.name === 'preserved_ota')).toMatchObject({ offset: 0x820000, size: 0x400000 });
  });

  it('streams region SHA-256 in 4 KiB reads and fails closed on short reads or timeouts', async () => {
    const transport = new Wg1200Transport();
    const readFlash = vi.fn(async (_offset: number, size: number) => new Uint8Array(size).fill(0x5a));
    (transport as any).loader = { readFlash };
    const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void) => { callback(); return 0; }) as typeof setTimeout);
    const digest = await (transport as any).hashRegionSha256(0x1000, 8192);
    expect(digest).toBe(createHash('sha256').update(new Uint8Array(8192).fill(0x5a)).digest('hex'));
    expect(readFlash.mock.calls).toEqual([[0x1000, 4096], [0x2000, 4096]]);
    readFlash.mockResolvedValueOnce(new Uint8Array(10) as any);
    await expect((transport as any).hashRegionSha256(0x3000, 4096)).rejects.toThrow(/Incomplete protected flash read/);
    readFlash.mockRejectedValueOnce(new Error('read timeout'));
    await expect((transport as any).hashRegionSha256(0x4000, 4096)).rejects.toThrow(/read timeout/);
    timer.mockRestore();
  });

  it('reports protected hash mismatches by partition only and never includes digest values', async () => {
    const transport = new Wg1200Transport();
    const snapshots = protectedSnapshots('ota_0');
    const hash = vi.spyOn(transport as any, 'hashRegionSha256').mockResolvedValue('a'.repeat(64));
    hash.mockResolvedValueOnce('b'.repeat(64));
    const result = await transport.verifyProtectedRegions(snapshots, 'ota_0');
    expect(result).toEqual({ valid: false, mismatches: ["Protected partition 'partition_table' was modified"] });
    expect(JSON.stringify(result)).not.toMatch(/[a-f0-9]{64}/);
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
      readOtadataSnapshot: vi.fn(async () => OTA_BEFORE),
      installApplication: vi.fn(async () => { calls.push('write-app'); }),
      verifyApplicationFlash: vi.fn(async () => { calls.push('verify-app'); return false; }),
      writeOtaSelectSector: vi.fn(async () => { calls.push('select-ota'); }),
      verifyProtectedRegions: vi.fn(async () => ({ valid: true, mismatches: [] })),
      hardReset: vi.fn(async () => { calls.push('reset'); }),
    };
    await expect(runOtaWriteTransaction(mock, { targetOffset: WG1200_CONSTANTS.APP_OTA_1.offset, firmwareBytes: new Uint8Array([1]), nextSeq: 2, targetSector: 1, snapshots: protectedSnapshots(), otadataBefore: OTA_BEFORE, preservedOtaSlot: 'ota_0' })).rejects.toThrow(/MD5 mismatch/);
    expect(calls).toEqual(['write-app', 'verify-app']);
    expect(mock.writeOtaSelectSector).not.toHaveBeenCalled();
  });

  it('rechecks the complete OTA selection immediately before writing and rejects stale or active-slot targets', async () => {
    const installApplication = vi.fn(async () => undefined);
    const mock = {
      readOtadataSnapshot: vi.fn(async () => OTA_BEFORE), installApplication,
      verifyApplicationFlash: vi.fn(async () => true), writeOtaSelectSector: vi.fn(async () => undefined),
      verifyProtectedRegions: vi.fn(async () => ({ valid: true, mismatches: [] })), hardReset: vi.fn(async () => undefined),
    };
    const changed = new Uint8Array(OTA_BEFORE); changed[0] ^= 1;
    mock.readOtadataSnapshot.mockResolvedValueOnce(changed);
    await expect(runOtaWriteTransaction(mock, { targetOffset: WG1200_CONSTANTS.APP_OTA_1.offset, firmwareBytes: new Uint8Array([1]),
      nextSeq: 2, targetSector: 1, snapshots: protectedSnapshots('ota_0'), otadataBefore: OTA_BEFORE, preservedOtaSlot: 'ota_0' }))
      .rejects.toThrow(/OTA metadata changed before application write/);
    expect(installApplication).not.toHaveBeenCalled();
    await expect(runOtaWriteTransaction(mock, { targetOffset: WG1200_CONSTANTS.APP_OTA_0.offset, firmwareBytes: new Uint8Array([1]),
      nextSeq: 2, targetSector: 1, snapshots: protectedSnapshots('ota_1'), otadataBefore: OTA_BEFORE, preservedOtaSlot: 'ota_1' }))
      .rejects.toThrow(/OTA target no longer matches/);
    expect(installApplication).not.toHaveBeenCalled();
  });

  it('checks protected data before committing OTA metadata and stops on either failure', async () => {
    const writeOtaSelectSector = vi.fn(async () => undefined);
    writeOtaSelectSector.mockRejectedValueOnce(new Error('metadata readback failed'));
    const base = {
      readOtadataSnapshot: vi.fn(async () => OTA_BEFORE),
      installApplication: vi.fn(async () => undefined), verifyApplicationFlash: vi.fn(async () => true),
      writeOtaSelectSector,
      verifyProtectedRegions: vi.fn(async () => ({ valid: true, mismatches: [] })),
      hardReset: vi.fn(async () => undefined),
    };
    await expect(runOtaWriteTransaction(base, { targetOffset: WG1200_CONSTANTS.APP_OTA_1.offset, firmwareBytes: new Uint8Array([1]), nextSeq: 2, targetSector: 1, snapshots: protectedSnapshots(), otadataBefore: OTA_BEFORE, preservedOtaSlot: 'ota_0' })).rejects.toThrow(/metadata readback failed/);
    expect(base.verifyProtectedRegions).toHaveBeenCalledTimes(1);
    expect(base.hardReset).not.toHaveBeenCalled();

    writeOtaSelectSector.mockClear();
    base.verifyProtectedRegions.mockResolvedValueOnce({ valid: false, mismatches: ['nvs changed'] } as any);
    await expect(runOtaWriteTransaction(base, { targetOffset: WG1200_CONSTANTS.APP_OTA_1.offset, firmwareBytes: new Uint8Array([1]), nextSeq: 2, targetSector: 1, snapshots: protectedSnapshots(), otadataBefore: OTA_BEFORE, preservedOtaSlot: 'ota_0' })).rejects.toThrow(/nvs changed/);
    expect(writeOtaSelectSector).not.toHaveBeenCalled();
    expect(base.hardReset).not.toHaveBeenCalled();
  });

  it('records the required order and never activates after protected-region mismatch', async () => {
    const calls: string[] = [];
    const mock = {
      readOtadataSnapshot: vi.fn(async () => OTA_BEFORE),
      installApplication: vi.fn(async () => { calls.push('erase-write'); }),
      verifyApplicationFlash: vi.fn(async () => { calls.push('image-verify'); return true; }),
      verifyProtectedRegions: vi.fn(async () => { calls.push('protected-verify'); return { valid: false, mismatches: ['spiffs changed'] }; }),
      writeOtaSelectSector: vi.fn(async () => { calls.push('ota-commit'); }),
      hardReset: vi.fn(async () => { calls.push('reset'); }),
    };
    await expect(runOtaWriteTransaction(mock, { targetOffset: WG1200_CONSTANTS.APP_OTA_1.offset, firmwareBytes: new Uint8Array([1]), nextSeq: 2, targetSector: 1, snapshots: protectedSnapshots(), otadataBefore: OTA_BEFORE, preservedOtaSlot: 'ota_0' })).rejects.toThrow(/spiffs changed/);
    expect(calls).toEqual(['erase-write', 'image-verify', 'protected-verify']);
    expect(mock.writeOtaSelectSector).not.toHaveBeenCalled();
    expect(mock.hardReset).not.toHaveBeenCalled();
  });

  it('reports flash, OTA, and protected-data verification only after each stage succeeds', async () => {
    const result = await runOtaWriteTransaction({
      readOtadataSnapshot: vi.fn(async () => OTA_BEFORE),
      installApplication: vi.fn(async () => undefined),
      verifyApplicationFlash: vi.fn(async () => true),
      writeOtaSelectSector: vi.fn(async () => undefined),
      verifyProtectedRegions: vi.fn(async () => ({ valid: true, mismatches: [] })),
      hardReset: vi.fn(async () => true),
    }, { targetOffset: WG1200_CONSTANTS.APP_OTA_1.offset, firmwareBytes: new Uint8Array([1, 2, 3]), nextSeq: 2, targetSector: 1, snapshots: protectedSnapshots(), otadataBefore: OTA_BEFORE, preservedOtaSlot: 'ota_0' });
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
