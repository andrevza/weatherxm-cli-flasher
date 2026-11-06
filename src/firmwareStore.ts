import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, link, unlink, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fetchCatalog } from './catalog.js';
import { parseAppDescriptor } from './upstream/flasher/appDescriptor.js';
import { verifySecureBootV2Image } from './upstream/flasher/secureBoot.js';
import type { FirmwareEntry, FirmwareManifest, VerifiedFirmware } from './upstream/flasher/manifest.js';
import { WG1200_CONSTANTS } from './upstream/flasher/constants.js';

export type FirmwareProgress = (event: { stage: string; completed?: number; total?: number; detail?: string }) => void;

export interface CachedFirmware {
  entry: FirmwareEntry;
  verified: VerifiedFirmware;
  descriptor: NonNullable<ReturnType<typeof parseAppDescriptor>>;
  cachePath: string;
  reused: boolean;
  signature: ReturnType<typeof verifySecureBootV2Image>;
}

interface CacheMetadata { formatVersion: 1; manifestUrl: string; downloadedAt: string; entry: FirmwareEntry; }
const defaultCacheDirectory = () => process.env.WG1200_FIRMWARE_CACHE || join(homedir(), '.cache/weatherxm-flash/firmware');
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export function cacheImagePath(digest: string, cacheDirectory = defaultCacheDirectory()): string {
  if (!/^[a-f0-9]{64}$/i.test(digest)) throw new Error('Invalid firmware cache digest');
  return join(cacheDirectory, `${digest.toLowerCase()}.bin`);
}

function validateImage(entry: FirmwareEntry, data: Uint8Array): CachedFirmware['signature'] {
  if (data.byteLength !== entry.bytes) throw new Error(`Firmware size mismatch: expected ${entry.bytes}, received ${data.byteLength}`);
  if (data.byteLength > WG1200_CONSTANTS.MAX_APP_SIZE_BYTES) throw new Error('Firmware image exceeds the WG1200 application partition');
  const actual = sha256(data);
  if (actual.toLowerCase() !== entry.sha256.toLowerCase()) throw new Error(`Firmware SHA-256 mismatch: expected ${entry.sha256}, received ${actual}`);
  const descriptor = parseAppDescriptor(data);
  if (!descriptor) throw new Error('Firmware image has no valid ESP application descriptor');
  if (entry.category && descriptor.firmwareType !== entry.category) throw new Error(`Firmware descriptor type ${descriptor.firmwareType} does not match manifest category ${entry.category}`);
  const signature = verifySecureBootV2Image(data);
  if (!signature.imageFormatValid || !signature.imageDigestValid || !signature.signatureValid) {
    throw new Error(`Firmware Secure Boot V2 signature validation failed: ${signature.errors.join('; ')}`);
  }
  if (signature.chipId !== 9) throw new Error('Firmware image is not for ESP32-S3');
  return signature;
}

async function readVerifiedCache(entry: FirmwareEntry, manifestUrl: string, cacheDirectory: string): Promise<CachedFirmware | null> {
  const path = cacheImagePath(entry.sha256, cacheDirectory);
  const metadataPath = `${path}.json`;
  try {
    const data = await readFile(path);
    let metadata: CacheMetadata | null = null;
    try { metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as CacheMetadata; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (metadata && (metadata.formatVersion !== 1 || metadata.manifestUrl !== manifestUrl || metadata.entry.sha256.toLowerCase() !== entry.sha256.toLowerCase() || metadata.entry.version !== entry.version)) {
      throw new Error('Cached firmware provenance does not match the selected official manifest entry');
    }
    const signature = validateImage(entry, data);
    const descriptor = parseAppDescriptor(data)!;
    if (!metadata) {
      // Recover an image promoted before a process interruption; its complete
      // content is rechecked against the currently validated HTTPS manifest.
      const temp = `${metadataPath}.${randomUUID()}.tmp`;
      const handle = await open(temp, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify({ formatVersion: 1, manifestUrl, downloadedAt: new Date().toISOString(), entry } satisfies CacheMetadata)); await handle.sync(); }
      finally { await handle.close(); }
      try { await promoteNoReplace(temp, metadataPath); }
      catch (error) { await unlink(temp).catch(() => undefined); if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    return { entry, verified: { entry, data, sha256: sha256(data) }, descriptor, cachePath: path, reused: true, signature };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`Cached firmware is corrupt or untrusted at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function downloadToTemporaryFile(url: string, destination: string, expectedBytes: number,
  onProgress?: FirmwareProgress, fetcher: typeof fetch = fetch): Promise<{ bytes: number; sha256: string }> {
  const response = await fetcher(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Firmware download failed: HTTP ${response.status} ${response.statusText}`);
  if (!response.body) throw new Error('Firmware download response has no body');
  const headerLength = response.headers.get('content-length');
  const contentLength = headerLength && /^\d+$/.test(headerLength) ? Number(headerLength) : undefined;
  if (contentLength !== undefined && contentLength !== expectedBytes) throw new Error(`HTTP Content-Length ${contentLength} does not match manifest size ${expectedBytes}`);
  const handle = await open(destination, 'wx', 0o600);
  const hash = createHash('sha256');
  let completed = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      let offset = 0;
      while (offset < value.byteLength) {
        const result = await handle.write(value, offset, value.byteLength - offset);
        if (result.bytesWritten <= 0) throw new Error('Firmware cache write made no progress');
        offset += result.bytesWritten;
      }
      completed += value.byteLength;
      onProgress?.({ stage: 'Downloading firmware', completed, total: contentLength ?? expectedBytes });
      if (completed > expectedBytes) throw new Error('Firmware download exceeded the manifest size');
    }
    if (contentLength !== undefined && completed !== contentLength) throw new Error(`Truncated firmware response: expected Content-Length ${contentLength}, received ${completed}`);
    if (completed !== expectedBytes) throw new Error(`Firmware size mismatch: expected ${expectedBytes}, received ${completed}`);
    await handle.sync();
    return { bytes: completed, sha256: hash.digest('hex') };
  } finally {
    reader.releaseLock();
    await handle.close();
  }
}

async function promoteNoReplace(temp: string, final: string): Promise<void> {
  await link(temp, final);
  await unlink(temp);
}

async function acquireCacheLock(path: string, onWait: () => Promise<CachedFirmware | null>): Promise<Awaited<ReturnType<typeof open>> | null> {
  const deadline = Date.now() + 10 * 60_000;
  for (;;) {
    try {
      const handle = await open(path, 'wx', 0o600);
      await handle.writeFile(`${process.pid}\n`);
      return handle;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const cached = await onWait();
      if (cached) return null;
      if (Date.now() >= deadline) throw new Error('Timed out waiting for another verified firmware cache download to finish');
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

async function cacheManifest(manifest: FirmwareManifest, manifestUrl: string, cacheDirectory: string): Promise<void> {
  const path = join(cacheDirectory, `catalog-${createHash('sha256').update(manifestUrl).digest('hex')}.json`);
  const temp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify({ manifestUrl, cachedAt: new Date().toISOString(), manifest })); await handle.sync(); }
  finally { await handle.close(); }
  try { await (await import('node:fs/promises')).rename(temp, path); }
  catch (error) { await unlink(temp).catch(() => undefined); throw error; }
}

export async function loadCachedManifest(manifestUrl: string, cacheDirectory = defaultCacheDirectory()): Promise<FirmwareManifest | null> {
  const path = join(cacheDirectory, `catalog-${createHash('sha256').update(manifestUrl).digest('hex')}.json`);
  try {
    const cached = JSON.parse(await readFile(path, 'utf8')) as { manifestUrl?: string; manifest?: FirmwareManifest };
    if (cached.manifestUrl !== manifestUrl || !cached.manifest) return null;
    // Revalidate schema and hardware metadata even when offline.
    const { validateManifest } = await import('./upstream/flasher/manifest.js');
    return validateManifest(cached.manifest);
  } catch { return null; }
}

export async function getOfficialFirmware(input: {
  key: string; manifestUrl: string; version?: string; cacheDirectory?: string; progress?: FirmwareProgress;
  fetcher?: typeof fetch; offline?: boolean;
}): Promise<CachedFirmware> {
  const cacheDirectory = input.cacheDirectory ?? defaultCacheDirectory();
  await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
  const fetcher = input.fetcher ?? fetch;
  let manifest: FirmwareManifest;
  try {
    if (input.offline) throw new Error('offline requested');
    input.progress?.({ stage: 'Retrieving firmware catalog', detail: 'connecting to official catalog' });
    manifest = await fetchCatalog(input.manifestUrl, fetcher);
    await cacheManifest(manifest, input.manifestUrl, cacheDirectory);
  } catch (error) {
    const cached = await loadCachedManifest(input.manifestUrl, cacheDirectory);
    if (!cached) throw error;
    manifest = cached;
  }
  const entry = manifest.firmwares[input.key];
  if (!entry) throw new Error(`Firmware '${input.key}' is not in the validated official catalog`);
  if (input.version && entry.version.replace(/^v/i, '') !== input.version.replace(/^v/i, '')) {
    throw new Error(`Requested ${input.key} version ${input.version} is unavailable in the selected manifest (available: ${entry.version}); no release was substituted`);
  }
  const cachePath = cacheImagePath(entry.sha256, cacheDirectory);
  const cached = await readVerifiedCache(entry, input.manifestUrl, cacheDirectory);
  if (cached) {
    input.progress?.({ stage: 'Verified firmware cache', completed: entry.bytes, total: entry.bytes, detail: 'reused verified image' });
    return cached;
  }
  if (input.offline) throw new Error(`Verified firmware ${entry.version} is not present in the local cache`);
  const url = new URL(entry.file, input.manifestUrl);
  if (url.protocol !== 'https:' || url.origin !== new URL(input.manifestUrl).origin) throw new Error('Firmware image URL must use HTTPS and the official manifest origin');
  const lockPath = `${cachePath}.lock`;
  const lock = await acquireCacheLock(lockPath, () => readVerifiedCache(entry, input.manifestUrl, cacheDirectory));
  if (!lock) {
    const afterWait = await readVerifiedCache(entry, input.manifestUrl, cacheDirectory);
    if (afterWait) return { ...afterWait, reused: true };
    throw new Error('Concurrent firmware download ended without a valid cache entry');
  }
  try {
  const afterLock = await readVerifiedCache(entry, input.manifestUrl, cacheDirectory);
  if (afterLock) return { ...afterLock, reused: true };
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const temp = `${cachePath}.${randomUUID()}.tmp`;
    try {
      input.progress?.({ stage: 'Downloading firmware', detail: `attempt ${attempt}/2` });
      const downloaded = await downloadToTemporaryFile(url.href, temp, entry.bytes, input.progress, fetcher);
      if (downloaded.sha256.toLowerCase() !== entry.sha256.toLowerCase()) throw new Error(`Firmware SHA-256 mismatch: expected ${entry.sha256}, received ${downloaded.sha256}`);
      const data = new Uint8Array(await readFile(temp));
      input.progress?.({ stage: 'Validating firmware image and signature', detail: 'checking image structure and Secure Boot V2 signature' });
      const signature = validateImage(entry, data);
      const descriptor = parseAppDescriptor(data)!;
      const metadata: CacheMetadata = { formatVersion: 1, manifestUrl: input.manifestUrl, downloadedAt: new Date().toISOString(), entry };
      const metadataTemp = `${cachePath}.json.${randomUUID()}.tmp`;
      const metaHandle = await open(metadataTemp, 'wx', 0o600);
      try { await metaHandle.writeFile(JSON.stringify(metadata, null, 2)); await metaHandle.sync(); }
      finally { await metaHandle.close(); }
      try { await promoteNoReplace(temp, cachePath); }
      catch (error) {
        await unlink(metadataTemp).catch(() => undefined);
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          const existing = await readVerifiedCache(entry, input.manifestUrl, cacheDirectory);
          if (existing) return existing;
        }
        throw error;
      }
      try { await promoteNoReplace(metadataTemp, `${cachePath}.json`); }
      catch (error) {
        await unlink(metadataTemp).catch(() => undefined);
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const bytes = new Uint8Array(await readFile(cachePath));
      return { entry, verified: { entry, data: bytes, sha256: downloaded.sha256 }, descriptor, cachePath, reused: false, signature };
    } catch (error) {
      lastError = error;
      await unlink(temp).catch(() => undefined);
      if (attempt === 2 || /SHA-256 mismatch|descriptor|signature validation|Content-Length|size mismatch|exceeded/.test(error instanceof Error ? error.message : '')) break;
    }
  }
  throw new Error(`Firmware download/verification failed after bounded retry: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  } finally {
    await lock.close();
    await unlink(lockPath).catch(() => undefined);
  }
}

export async function verifyCachedImageFile(path: string, entry: FirmwareEntry): Promise<{ data: Uint8Array; descriptor: NonNullable<ReturnType<typeof parseAppDescriptor>>; signature: ReturnType<typeof verifySecureBootV2Image>; sha256: string }> {
  const metadataPath = `${path}.json`;
  const [metadataRaw, fileStat, data] = await Promise.all([readFile(metadataPath, 'utf8'), stat(path), readFile(path)]);
  const metadata = JSON.parse(metadataRaw) as CacheMetadata;
  if (metadata.formatVersion !== 1 || metadata.entry.sha256.toLowerCase() !== entry.sha256.toLowerCase()) throw new Error('Cached firmware provenance mismatch');
  if (fileStat.size !== entry.bytes) throw new Error(`Cached firmware size mismatch: expected ${entry.bytes}, got ${fileStat.size}`);
  const signature = validateImage(entry, data);
  const descriptor = parseAppDescriptor(data);
  if (!descriptor) throw new Error('Cached firmware has no application descriptor');
  return { data: new Uint8Array(data), descriptor, signature, sha256: sha256(data) };
}
