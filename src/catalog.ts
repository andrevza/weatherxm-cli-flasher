import { validateManifest, type FirmwareManifest } from './upstream/flasher/manifest.js';

export const DEFAULT_MANIFEST_URL = 'https://flash.weatherxm.com/firmware/manifest.json';

export async function fetchCatalog(url = DEFAULT_MANIFEST_URL, fetcher: typeof fetch = fetch): Promise<FirmwareManifest> {
  if (new URL(url).protocol !== 'https:') throw new Error('Firmware manifest must be served over HTTPS');
  const response = await fetcher(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Manifest request failed: HTTP ${response.status} ${response.statusText}`);
  const manifest = validateManifest(await response.json());
  for (const [key, entry] of Object.entries(manifest.firmwares)) {
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes <= 0) throw new Error(`Firmware '${key}' has an invalid byte length`);
    if (!/^[a-f0-9]{64}$/i.test(entry.sha256)) throw new Error(`Firmware '${key}' has a malformed SHA-256 digest`);
    const fileUrl = new URL(entry.file, url);
    if (fileUrl.protocol !== 'https:' || fileUrl.origin !== new URL(url).origin) {
      throw new Error(`Firmware '${key}' URL must use HTTPS and the manifest origin`);
    }
  }
  return manifest;
}

export function catalogRows(manifest: FirmwareManifest) {
  return Object.entries(manifest.firmwares).map(([key, fw]) => ({
    key, name: fw.name, version: fw.version, label: fw.label ?? `${fw.name} v${fw.version}`,
    bytes: fw.bytes, sha256: fw.sha256, source: fw.source_repo, commit: fw.git_commit,
  }));
}
