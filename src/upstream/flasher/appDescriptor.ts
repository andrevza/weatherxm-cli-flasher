// Adapted for the WG1200 CLI from WeatherXM/web-flasher commit 35b2ecc4ccb31799ecd720609786362a99b3e33a (Apache-2.0); downstream changes are documented in UPSTREAM_NOTICES.md.
import { WG1200_CONSTANTS } from './constants';

export type DetectedFirmwareType = 'weatherxm' | 'meshtastic' | 'unknown';

export interface AppDescriptor {
  magic: number;
  secureVersion: number;
  version: string;
  projectName: string;
  compileTime: string;
  compileDate: string;
  idfVersion: string;
  /** SHA-256 of the linked application ELF recorded in esp_app_desc_t. */
  appElfSha256: string;
  firmwareType: DetectedFirmwareType;
  displayTitle: string;
}

/**
 * Searches for and parses the ESP-IDF esp_app_desc_t structure from the beginning of an application partition.
 */
export function parseAppDescriptor(bytes: Uint8Array): AppDescriptor | null {
  const maxSearch = Math.min(bytes.byteLength - 176, 4096);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  for (let i = 0; i <= maxSearch; i += 4) {
    if (view.getUint32(i, true) === WG1200_CONSTANTS.APP_DESC_MAGIC) {
      const magic = WG1200_CONSTANTS.APP_DESC_MAGIC;
      const secureVersion = view.getUint32(i + 4, true);

      // Version: 32 bytes ASCII
      const version = readString(bytes, i + 16, 32);

      // Project Name: 32 bytes ASCII
      const projectName = readString(bytes, i + 48, 32);

      // Compile Time: 16 bytes ASCII
      const compileTime = readString(bytes, i + 80, 16);

      // Compile Date: 16 bytes ASCII
      const compileDate = readString(bytes, i + 96, 16);

      // IDF Version: 32 bytes ASCII
      const idfVersion = readString(bytes, i + 112, 32);
      const appElfSha256 = Array.from(bytes.subarray(i + 144, i + 176))
        .map((byte) => byte.toString(16).padStart(2, '0')).join('');

      const firmwareType = classifyFirmware(projectName, version);
      const displayTitle = formatDisplayTitle(firmwareType, projectName, version);

      return {
        magic,
        secureVersion,
        version,
        projectName,
        compileTime,
        compileDate,
        idfVersion,
        appElfSha256,
        firmwareType,
        displayTitle,
      };
    }
  }

  return null;
}

function readString(bytes: Uint8Array, offset: number, maxLength: number): string {
  let str = '';
  for (let i = 0; i < maxLength; i++) {
    const code = bytes[offset + i];
    if (code === 0) break;
    str += String.fromCharCode(code);
  }
  return str.trim();
}

function classifyFirmware(projectName: string, version: string): DetectedFirmwareType {
  const p = projectName.toLowerCase();
  const v = version.toLowerCase();

  // 1. Check explicit project names first to avoid misclassifying Meshtastic versions like '2.8.1-wxm'
  if (p.includes('meshtastic')) {
    return 'meshtastic';
  }
  if (p.includes('wg1010_port') || p.includes('weatherxm') || p.includes('wg1')) {
    return 'weatherxm';
  }

  // 2. Secondary checks if project name is generic or ambiguous
  if (v.includes('meshtastic')) {
    return 'meshtastic';
  }
  if (v.includes('wxm') || v.includes('weatherxm') || p.includes('station')) {
    return 'weatherxm';
  }

  return 'unknown';
}

function formatDisplayTitle(
  type: DetectedFirmwareType,
  projectName: string,
  version: string
): string {
  switch (type) {
    case 'weatherxm':
      return `WeatherXM ${version || projectName}`;
    case 'meshtastic':
      return `Meshtastic (${version || 'WG1200'})`;
    case 'unknown':
      return projectName ? `${projectName} (${version})` : 'Unknown compatible firmware';
  }
}

/**
 * Returns true if the descriptor represents a valid, bootable application image
 * (as opposed to an erased 0xFF slot or unrecognized header).
 */
export function isValidAppDescriptor(
  desc: AppDescriptor | null | undefined
): desc is AppDescriptor {
  return Boolean(
    desc &&
      desc.magic === WG1200_CONSTANTS.APP_DESC_MAGIC &&
      desc.firmwareType !== 'unknown' &&
      desc.version.length > 0
  );
}

/** A descriptor build identifier is usable only when its embedded ELF SHA-256 is present. */
export function hasBuildIdentifier(desc: AppDescriptor | null | undefined): desc is AppDescriptor {
  return Boolean(desc && /^[a-f0-9]{64}$/i.test(desc.appElfSha256) && !/^0+$/.test(desc.appElfSha256));
}

/**
 * Checks whether an on-chip application descriptor matches a manifest firmware entry.
 * Handles exact/substring version matching, git commit matching, and the Jan 2026
 * WeatherXM v0.6.2 cloud OTA build whose embedded esp_app_desc_t version is 'v0.6.1-dirty'.
 */
export function doesDescriptorMatchManifestEntry(
  desc: AppDescriptor | null | undefined,
  fw: { version: string; category?: string; git_commit?: string }
): boolean {
  if (!isValidAppDescriptor(desc)) return false;

  if (fw.category && desc.firmwareType !== fw.category) {
    return false;
  }

  const normalizedDescVer = desc.version.toLowerCase();
  const normalizedTargetVer = fw.version.toLowerCase().replace(/^v/, '');

  if (normalizedDescVer.includes(normalizedTargetVer)) {
    return true;
  }

  if (fw.git_commit && normalizedDescVer.includes(fw.git_commit.toLowerCase())) {
    return true;
  }

  // Official Jan 2026 cloud OTA v0.6.2 binary has esp_app_desc_t.version === 'v0.6.1-dirty'
  if (
    desc.firmwareType === 'weatherxm' &&
    normalizedTargetVer === '0.6.2' &&
    (normalizedDescVer === 'v0.6.1-dirty' ||
      normalizedDescVer.startsWith('v0.6.') ||
      normalizedDescVer.startsWith('0.6.'))
  ) {
    return true;
  }

  return false;
}
