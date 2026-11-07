import { describe, expect, it, vi } from 'vitest';
import { retryExactConfirmation, RegionVerificationMismatch, verifyInactiveBackupFreshness } from '../src/verification.js';
import { WG1200_CONSTANTS } from '../src/upstream/flasher/constants.js';
import { Wg1200Transport } from '../src/upstream/flasher/transport.js';

const target = WG1200_CONSTANTS.APP_OTA_0;
const md5 = 'a'.repeat(32);
const sha256 = 'b'.repeat(64);

describe('stage-only verification modes', () => {
  it('uses device SPI_FLASH_MD5 for exact ota_0 backup freshness and records range and elapsed time', async () => {
    let now = 100;
    const deviceMd5 = vi.fn(async () => md5);
    const readSha256 = vi.fn(async () => sha256);
    const result = await verifyInactiveBackupFreshness({ mode: 'fast', address: target.offset, length: target.size,
      expectedMd5: md5, expectedSha256: sha256, deviceMd5, readSha256, now: () => (now += 2400) });
    expect(result).toEqual({ address: target.offset, length: target.size, algorithm: 'MD5', method: 'device-side SPI_FLASH_MD5', outcome: 'MATCH', elapsedMs: 2400 });
    expect(deviceMd5).toHaveBeenCalledOnce();
    expect(readSha256).not.toHaveBeenCalled();
  });

  it('fails on a valid but mismatching fast digest without falling back', async () => {
    const readSha256 = vi.fn(async () => sha256);
    await expect(verifyInactiveBackupFreshness({ mode: 'fast', address: target.offset, length: target.size,
      expectedMd5: md5, expectedSha256: sha256, deviceMd5: async () => 'c'.repeat(32), readSha256 }))
      .rejects.toBeInstanceOf(RegionVerificationMismatch);
    expect(readSha256).not.toHaveBeenCalled();
  });

  it.each(['unsupported', 'command failed', 'malformed response'])('falls back to physical SHA-256 when device MD5 is %s', async (reason) => {
    const onFallback = vi.fn();
    const readSha256 = vi.fn(async () => sha256);
    const result = await verifyInactiveBackupFreshness({ mode: 'fast', address: target.offset, length: target.size,
      expectedMd5: md5, expectedSha256: sha256,
      deviceMd5: async () => { if (reason === 'malformed response') return 'xyz'; throw new Error(reason); },
      readSha256, onFallback });
    expect(result).toMatchObject({ algorithm: 'SHA-256', method: 'physical flash read', outcome: 'MATCH' });
    expect(onFallback).toHaveBeenCalledWith(expect.stringMatching(reason === 'malformed response' ? /unexpected MD5/ : new RegExp(reason)));
    expect(readSha256).toHaveBeenCalledOnce();
  });

  it('uses only full physical SHA-256 in Thorough mode and fails on mismatch or failed fallback', async () => {
    const deviceMd5 = vi.fn(async () => md5);
    const result = await verifyInactiveBackupFreshness({ mode: 'thorough', address: target.offset, length: target.size,
      expectedMd5: md5, expectedSha256: sha256, deviceMd5, readSha256: async () => sha256 });
    expect(result.algorithm).toBe('SHA-256');
    expect(deviceMd5).not.toHaveBeenCalled();
    await expect(verifyInactiveBackupFreshness({ mode: 'fast', address: target.offset, length: target.size,
      expectedMd5: md5, expectedSha256: sha256, deviceMd5: async () => { throw new Error('unsupported'); }, readSha256: async () => '0'.repeat(64) }))
      .rejects.toBeInstanceOf(RegionVerificationMismatch);
  });

  it('rejects ranges other than the exact target partition', async () => {
    await expect(verifyInactiveBackupFreshness({ mode: 'fast', address: target.offset + 1, length: target.size,
      expectedMd5: md5, expectedSha256: sha256, deviceMd5: async () => md5, readSha256: async () => sha256 }))
      .rejects.toThrow(/exact inactive ota_0 partition/);
  });

  it('issues SPI_FLASH_MD5 only through the stub and with the exact ota_0 base and full partition length', async () => {
    const stubLoader = { IS_STUB: true, flashMd5sum: vi.fn(async () => md5) };
    const transport = new Wg1200Transport();
    (transport as any).loader = stubLoader;
    await expect(transport.md5InactiveOta0()).resolves.toBe(md5);
    expect(stubLoader.flashMd5sum).toHaveBeenCalledWith(0x420000, 0x400000);

    (transport as any).loader = { IS_STUB: false, flashMd5sum: vi.fn(async () => md5) };
    await expect(transport.md5InactiveOta0()).rejects.toThrow(/RAM stub is unavailable/);
  });
});

describe('retryable exact stage confirmation', () => {
  const phrase = `STAGE ota_0 WeatherXM 0.8.34 ${'d'.repeat(64)}`;
  it('permits a typo then accepts only the complete phrase without restarting preflight', async () => {
    const entries = ['typo', phrase];
    const askPhrase = vi.fn(async () => entries.shift()!);
    const askRetry = vi.fn(async () => 'retry' as const);
    await expect(retryExactConfirmation({ phrase, askPhrase, askRetry })).resolves.toBe(true);
    expect(askPhrase).toHaveBeenCalledTimes(2);
    expect(askRetry).toHaveBeenCalledOnce();
  });

  it('cancels after five invalid entries and never confirms partial hashes or generic yes', async () => {
    const askPhrase = vi.fn(async () => 'yes');
    const askRetry = vi.fn(async () => 'retry' as const);
    await expect(retryExactConfirmation({ phrase, askPhrase, askRetry })).resolves.toBe(false);
    expect(askPhrase).toHaveBeenCalledTimes(5);
    expect(askRetry).toHaveBeenCalledTimes(4);
    await expect(retryExactConfirmation({ phrase, askPhrase: async () => phrase.slice(0, -1), askRetry: async () => 'cancel' })).resolves.toBe(false);
  });

  it('supports cancellation at the phrase and retry prompts', async () => {
    await expect(retryExactConfirmation({ phrase, askPhrase: async () => 'CANCEL', askRetry: async () => 'retry' })).resolves.toBe(false);
    await expect(retryExactConfirmation({ phrase, askPhrase: async () => 'wrong', askRetry: async () => 'cancel' })).resolves.toBe(false);
    const interrupted = new Error('aborted'); interrupted.name = 'AbortError';
    await expect(retryExactConfirmation({ phrase, askPhrase: async () => { throw interrupted; }, askRetry: async () => 'retry' })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
