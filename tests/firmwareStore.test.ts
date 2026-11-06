import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getOfficialFirmware } from '../src/firmwareStore.js';
import { WG1200_CONSTANTS } from '../src/upstream/flasher/constants.js';
import { createSignedWeatherXmImage } from './fixtures/secureFirmware.js';

const dirs: string[] = [];
async function tempDir() { const dir = await mkdtemp(join(tmpdir(), 'wg1200-fw-cache-')); dirs.push(dir); return dir; }
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

function manifestFor(data: Uint8Array) {
  const entry = { name: 'WeatherXM', version: '0.8.34', file: 'https://flash.weatherxm.com/firmware/wxm.bin', bytes: data.byteLength,
    sha256: createHashHex(data), category: 'weatherxm', secure_boot_v2: true };
  const mesh = { ...entry, name: 'Meshtastic', category: 'meshtastic' };
  return { schema: 1, hardware: WG1200_CONSTANTS.HARDWARE, chip: WG1200_CONSTANTS.CHIP, flash_bytes: WG1200_CONSTANTS.FLASH_SIZE_BYTES,
    app_partition_bytes: WG1200_CONSTANTS.MAX_APP_SIZE_BYTES, firmwares: { weatherxm: entry, meshtastic: mesh } };
}
function createHashHex(data: Uint8Array) { return createHash('sha256').update(data).digest('hex'); }
function fetchMock(data: Uint8Array, options: { failFirstImage?: boolean; truncated?: boolean; badHash?: boolean } = {}) {
  const manifest = manifestFor(data);
  const requests: string[] = [];
  let imageRequest = 0;
  const fetcher = vi.fn(async (input: string | URL | Request) => {
    const url = String(input); requests.push(url);
    if (url.endsWith('/manifest.json')) return new Response(JSON.stringify(manifest), { status: 200, headers: { 'content-type': 'application/json' } });
    imageRequest++;
    if (options.failFirstImage && imageRequest === 1) throw new TypeError('simulated network reset');
    const body = options.truncated ? data.subarray(0, data.length - 12) : data;
    const headers = options.truncated ? { 'content-length': String(data.length) } : { 'content-length': String(body.length) };
    const responseData = options.badHash ? Uint8Array.from(body, (value, index) => index === 45 ? value ^ 1 : value) : body;
    return new Response(Buffer.from(responseData), { status: 200, headers });
  }) as unknown as typeof fetch;
  return { fetcher, requests, imageRequest };
}

describe('verified persistent firmware cache', () => {
  it('downloads exact release, verifies image/hash/signature, promotes atomically and reuses offline', async () => {
    const dir = await tempDir(); const { data } = createSignedWeatherXmImage(); const mock = fetchMock(data, { failFirstImage: true });
    const progress: Array<{ stage: string; completed?: number; total?: number }> = [];
    const first = await getOfficialFirmware({ key: 'weatherxm', manifestUrl: 'https://flash.weatherxm.com/firmware/manifest.json', version: 'v0.8.34',
      cacheDirectory: dir, fetcher: mock.fetcher, progress: (event) => progress.push(event) });
    expect(first).toMatchObject({ reused: false, entry: { version: '0.8.34' }, descriptor: { firmwareType: 'weatherxm' }, signature: { signatureValid: true } });
    expect(await readFile(first.cachePath)).toEqual(Buffer.from(data));
    expect(JSON.parse(await readFile(`${first.cachePath}.json`, 'utf8')).formatVersion).toBe(1);
    const before = mock.requests.filter((url) => url.endsWith('/wxm.bin')).length;
    const offline = await getOfficialFirmware({ key: 'weatherxm', manifestUrl: 'https://flash.weatherxm.com/firmware/manifest.json',
      offline: true, cacheDirectory: dir, fetcher: mock.fetcher });
    expect(offline.reused).toBe(true);
    expect(mock.requests.filter((url) => url.endsWith('/wxm.bin')).length).toBe(before);
    expect(progress.some((event) => event.stage === 'Downloading firmware' && event.completed === data.length)).toBe(true);
    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('does not substitute releases and rejects truncated, wrong-hash and corrupt cache data', async () => {
    const dir = await tempDir(); const { data } = createSignedWeatherXmImage();
    const mock = fetchMock(data);
    await expect(getOfficialFirmware({ key: 'weatherxm', version: '0.8.33', manifestUrl: 'https://flash.weatherxm.com/firmware/manifest.json', cacheDirectory: dir, fetcher: mock.fetcher })).rejects.toThrow(/no release was substituted/);
    await expect(getOfficialFirmware({ key: 'weatherxm', manifestUrl: 'https://flash.weatherxm.com/firmware/manifest.json', cacheDirectory: dir, fetcher: fetchMock(data, { truncated: true }).fetcher })).rejects.toThrow(/Content-Length|bounded retry/);
    await expect(getOfficialFirmware({ key: 'weatherxm', manifestUrl: 'https://flash.weatherxm.com/firmware/manifest.json', cacheDirectory: dir, fetcher: fetchMock(data, { badHash: true }).fetcher })).rejects.toThrow(/SHA-256 mismatch|bounded retry/);
    const good = await getOfficialFirmware({ key: 'weatherxm', manifestUrl: 'https://flash.weatherxm.com/firmware/manifest.json', cacheDirectory: dir, fetcher: mock.fetcher });
    await writeFile(good.cachePath, new Uint8Array(data.length).fill(0));
    await expect(getOfficialFirmware({ key: 'weatherxm', manifestUrl: 'https://flash.weatherxm.com/firmware/manifest.json', offline: true, cacheDirectory: dir, fetcher: mock.fetcher })).rejects.toThrow(/corrupt or untrusted/);
  });

  it('serializes concurrent cache downloads and avoids duplicate image fetches', async () => {
    const dir = await tempDir(); const { data } = createSignedWeatherXmImage(); const mock = fetchMock(data);
    const options = { key: 'weatherxm', manifestUrl: 'https://flash.weatherxm.com/firmware/manifest.json', cacheDirectory: dir, fetcher: mock.fetcher };
    const [left, right] = await Promise.all([getOfficialFirmware(options), getOfficialFirmware(options)]);
    expect(left.verified.sha256).toBe(right.verified.sha256);
    expect(mock.requests.filter((url) => url.endsWith('/wxm.bin'))).toHaveLength(1);
  });
});
import { createHash } from 'node:crypto';
