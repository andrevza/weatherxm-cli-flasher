import { WG1200_CONSTANTS } from './upstream/flasher/constants.js';

export type VerificationMode = 'fast' | 'thorough';

export async function establishProtectedRegionSnapshot<TFast, TThorough>(input: {
  mode: VerificationMode;
  fastSnapshot: () => Promise<TFast>;
  thoroughSnapshot: () => Promise<TThorough>;
  signal?: AbortSignal;
  onFallback?: (reason: string) => void;
}): Promise<{ mode: 'fast'; snapshot: TFast } | { mode: 'thorough'; snapshot: TThorough }> {
  if (input.mode === 'fast') {
    try {
      if (input.signal?.aborted) throw Object.assign(new Error('Operation cancelled'), { name: 'AbortError' });
      const snapshot = await input.fastSnapshot();
      if (input.signal?.aborted) throw Object.assign(new Error('Operation cancelled'), { name: 'AbortError' });
      return { mode: 'fast', snapshot };
    } catch (error) {
      if (input.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
      input.onFallback?.(error instanceof Error ? error.message : String(error));
    }
  }
  return { mode: 'thorough', snapshot: await input.thoroughSnapshot() };
}

export interface RegionVerificationRecord {
  address: number;
  length: number;
  algorithm: 'MD5' | 'SHA-256';
  method: 'device-side SPI_FLASH_MD5' | 'physical flash read';
  outcome: 'MATCH';
  elapsedMs: number;
}
export interface ProtectedRegionVerificationRecord {
  name: string;
  address: number;
  length: number;
  algorithm: 'MD5' | 'SHA-256' | 'byte-for-byte';
  method: 'device-side SPI_FLASH_MD5' | 'physical flash read';
  snapshot: 'SNAPSHOT';
  postWrite: 'MATCH';
}
export class RegionVerificationMismatch extends Error {
  constructor(readonly address: number, readonly length: number, readonly algorithm: 'MD5' | 'SHA-256') {
    super(`${algorithm} integrity mismatch for flash range [0x${address.toString(16)}, 0x${(address + length).toString(16)})`);
    this.name = 'RegionVerificationMismatch';
  }
}
export class ConfirmationCancelledError extends Error {
  constructor(message = 'Stage-only confirmation cancelled; no write was started') { super(message); this.name = 'ConfirmationCancelledError'; }
}

/** Compares a verified local backup with the fixed inactive ota_0 range. MD5 is a speed check, not authentication. */
export async function verifyInactiveBackupFreshness(input: {
  mode: VerificationMode;
  address: number;
  length: number;
  expectedMd5: string;
  expectedSha256: string;
  deviceMd5: () => Promise<string>;
  readSha256: () => Promise<string>;
  signal?: AbortSignal;
  onFallback?: (reason: string) => void;
  now?: () => number;
}): Promise<RegionVerificationRecord> {
  const target = WG1200_CONSTANTS.APP_OTA_0;
  if (input.address !== target.offset || input.length !== target.size) throw new Error('Fast freshness verification is restricted to the exact inactive ota_0 partition');
  if (!/^[a-f0-9]{32}$/i.test(input.expectedMd5) || !/^[a-f0-9]{64}$/i.test(input.expectedSha256)) throw new Error('Verified backup reference digests are malformed');
  const now = input.now ?? (() => performance.now());
  if (input.mode === 'fast') {
    const started = now();
    try {
      if (input.signal?.aborted) { const error = new Error('Operation cancelled'); error.name = 'AbortError'; throw error; }
      const digest = await input.deviceMd5();
      if (input.signal?.aborted) { const error = new Error('Operation cancelled'); error.name = 'AbortError'; throw error; }
      if (!/^[a-f0-9]{32}$/i.test(digest)) throw new Error('device returned an unexpected MD5 response');
      if (digest.toLowerCase() !== input.expectedMd5.toLowerCase()) throw new RegionVerificationMismatch(input.address, input.length, 'MD5');
      return { address: input.address, length: input.length, algorithm: 'MD5', method: 'device-side SPI_FLASH_MD5', outcome: 'MATCH', elapsedMs: Math.max(0, now() - started) };
    } catch (error) {
      if (error instanceof RegionVerificationMismatch) throw error;
      if (input.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) { const cancelled = new Error('Operation cancelled'); cancelled.name = 'AbortError'; throw cancelled; }
      const reason = error instanceof Error ? error.message : String(error);
      input.onFallback?.(reason);
    }
  }
  const started = now();
  if (input.signal?.aborted) { const error = new Error('Operation cancelled'); error.name = 'AbortError'; throw error; }
  const digest = await input.readSha256();
  if (!/^[a-f0-9]{64}$/i.test(digest) || digest.toLowerCase() !== input.expectedSha256.toLowerCase()) {
    throw new RegionVerificationMismatch(input.address, input.length, 'SHA-256');
  }
  return { address: input.address, length: input.length, algorithm: 'SHA-256', method: 'physical flash read', outcome: 'MATCH', elapsedMs: Math.max(0, now() - started) };
}

export async function retryExactConfirmation(input: {
  phrase: string;
  askPhrase: (attempt: number, phrase: string) => Promise<string>;
  askRetry: (attempt: number) => Promise<'retry' | 'cancel'>;
  onMismatch?: (attempt: number, maximum: number) => void;
  attempts?: number;
}): Promise<boolean> {
  const maximum = input.attempts ?? 5;
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 5) throw new Error('Confirmation attempts must be from 1 to 5');
  for (let attempt = 1; attempt <= maximum; attempt++) {
    const entry = await input.askPhrase(attempt, input.phrase);
    if (entry === input.phrase) return true;
    if (entry.trim().toLowerCase() === 'cancel') return false;
    input.onMismatch?.(attempt, maximum);
    if (attempt === maximum || await input.askRetry(attempt) === 'cancel') return false;
  }
  return false;
}
