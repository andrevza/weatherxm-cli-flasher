import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseAppDescriptor } from './upstream/flasher/appDescriptor.js';
import { parseEsp32S3ImageBoundary } from './upstream/flasher/secureBoot.js';
import { validateInactiveBackup } from './stageOnly.js';
import type { CachedFirmware } from './firmwareStore.js';
import { WG1200_CONSTANTS } from './upstream/flasher/constants.js';

export interface FirmwareComparisonReport {
  outcome: 'EXACT IMAGE MATCH' | 'MATCHING BUILD — IMAGE DIFFERENCES' | 'DIFFERENT FIRMWARE BUILD' |
    'SIGNATURE VERIFICATION FAILED' | 'UNSUPPORTED IMAGE FORMAT' | 'COMPARISON INCOMPLETE';
  backup: { path: string; partition: string; version: string | null; firmwareType: string | null; sha256: string; imageLength: number | null; imageSha256: string | null; signature: string; signerKeyDigests: string[] };
  firmware: { path: string; version: string | null; firmwareType: string | null; sha256: string; imageLength: number | null; imageSha256: string | null; signature: string; signerKeyDigests: string[]; officialManifestVerified: boolean };
  sameVersion: boolean | null;
  sameBuildIdentity: boolean | null;
  sameSigningKeyDigest: boolean | null;
  differingBytes: number | null;
  differenceRanges: Array<{ start: number; end: number }>;
  trailingPartitionBytes: number | null;
  trailingPartitionErased: boolean | null;
  exactBytesCompared: number;
  explanation: string;
}

function sha(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }

function differenceSummary(a: Uint8Array, b: Uint8Array): { count: number; ranges: Array<{ start: number; end: number }> } {
  const length = Math.min(a.byteLength, b.byteLength);
  let count = Math.abs(a.byteLength - b.byteLength);
  const ranges: Array<{ start: number; end: number }> = [];
  let openStart = -1;
  for (let i = 0; i < length; i++) {
    if (a[i] !== b[i]) {
      count++;
      if (openStart < 0) openStart = i;
    } else if (openStart >= 0) {
      if (ranges.length < 32) ranges.push({ start: openStart, end: i });
      openStart = -1;
    }
  }
  if (openStart >= 0 && ranges.length < 32) ranges.push({ start: openStart, end: length });
  if (a.byteLength !== b.byteLength && ranges.length < 32) ranges.push({ start: length, end: Math.max(a.byteLength, b.byteLength) });
  return { count, ranges };
}

export async function compareBackupToFirmware(backupPath: string, firmware: CachedFirmware, onStage?: (stage: string) => void,
  officialManifestVerified = true): Promise<FirmwareComparisonReport> {
  onStage?.('Verifying full-partition backup and manifest');
  const manifestPath = `${backupPath}.manifest.json`;
  let raw: { partition?: { label?: string; offset?: number; length?: number } };
  try { raw = JSON.parse(await readFile(manifestPath, 'utf8')); }
  catch { throw new Error('Comparison requires the backup manifest beside the full-partition file'); }
  const label = raw.partition?.label;
  const offset = raw.partition?.offset;
  if ((label !== 'ota_0' && label !== 'ota_1') ||
      (label === 'ota_0' && offset !== WG1200_CONSTANTS.APP_OTA_0.offset) ||
      (label === 'ota_1' && offset !== WG1200_CONSTANTS.APP_OTA_1.offset)) {
    throw new Error('Backup manifest does not identify a WG1200 OTA partition');
  }
  const validBackup = await validateInactiveBackup(manifestPath, { label, offset: offset!, length: WG1200_CONSTANTS.MAX_APP_SIZE_BYTES });
  const partitionBytes = new Uint8Array(await readFile(validBackup.backupPath));
  onStage?.('Parsing backup ESP image and signed-image boundary');
  const backupDescriptor = parseAppDescriptor(partitionBytes);
  const backupBoundary = parseEsp32S3ImageBoundary(partitionBytes);
  const firmwareData = firmware.verified.data;
  const firmwareBoundary = parseEsp32S3ImageBoundary(firmwareData);
  const firmwareDescriptor = firmware.descriptor;
  const backupImageLength = backupBoundary.status === 'valid-signature' || backupBoundary.status === 'invalid-signature'
    ? backupBoundary.imageLength : null;
  const firmwareImageLength = firmwareBoundary.status === 'valid-signature' || firmwareBoundary.status === 'invalid-signature'
    ? firmwareBoundary.imageLength : null;
  const backupSignature = backupBoundary.status;
  const firmwareSignature = firmwareBoundary.status;
  const backupImage = backupImageLength === null ? null : partitionBytes.subarray(0, backupImageLength);
  const firmwareImage = firmwareImageLength === null ? null : firmwareData.subarray(0, firmwareImageLength);
  const sameImageLength = backupImage !== null && firmwareImage !== null && backupImage.byteLength === firmwareImage.byteLength;
  const diff = sameImageLength ? differenceSummary(backupImage!, firmwareImage!) : null;
  const exactImage = sameImageLength && diff!.count === 0;
  const sameVersion = backupDescriptor ? backupDescriptor.version.replace(/^v/i, '') === firmwareDescriptor.version.replace(/^v/i, '') : null;
  const sameBuildIdentity = backupDescriptor ? backupDescriptor.appElfSha256.toLowerCase() === firmwareDescriptor.appElfSha256.toLowerCase() : null;
  const backupKeys = backupBoundary.imageEvidence?.blocks.flatMap((block) => block.publicKeyHash ? [block.publicKeyHash.toLowerCase()] : []) ?? [];
  const firmwareKeys = firmware.signature.blocks.flatMap((block) => block.publicKeyHash ? [block.publicKeyHash.toLowerCase()] : []);
  const sameSigningKeyDigest = backupKeys.length && firmwareKeys.length ? backupKeys.some((key) => firmwareKeys.includes(key)) : null;
  const bothSigned = backupBoundary.status === 'valid-signature' && firmwareBoundary.status === 'valid-signature';
  const outcome: FirmwareComparisonReport['outcome'] = backupBoundary.status === 'invalid-signature' || firmwareBoundary.status === 'invalid-signature'
    ? 'SIGNATURE VERIFICATION FAILED'
    : !backupDescriptor || backupBoundary.status === 'unsupported-image' || firmwareBoundary.status === 'unsupported-image' || !backupImage || !firmwareImage
      ? (backupBoundary.status === 'no-signature' || firmwareBoundary.status === 'no-signature' ? 'COMPARISON INCOMPLETE' : 'UNSUPPORTED IMAGE FORMAT')
      : exactImage && bothSigned ? 'EXACT IMAGE MATCH'
        : sameBuildIdentity ? 'MATCHING BUILD — IMAGE DIFFERENCES' : 'DIFFERENT FIRMWARE BUILD';
  const backupImageSha256 = backupImage ? sha(backupImage) : null;
  const firmwareImageSha256 = firmwareImage ? sha(firmwareImage) : null;
  return {
    outcome,
    backup: { path: backupPath, partition: label, version: backupDescriptor?.version ?? null, firmwareType: backupDescriptor?.firmwareType ?? null,
      sha256: validBackup.manifest.sha256, imageLength: backupImageLength, imageSha256: backupImageSha256, signature: backupSignature, signerKeyDigests: backupKeys },
    firmware: { path: firmware.cachePath, version: firmwareDescriptor.version, firmwareType: firmwareDescriptor.firmwareType,
      sha256: firmware.verified.sha256, imageLength: firmwareImageLength, imageSha256: firmwareImageSha256,
      signature: firmwareSignature, signerKeyDigests: firmwareKeys, officialManifestVerified },
    sameVersion, sameBuildIdentity, sameSigningKeyDigest, differingBytes: diff?.count ?? null,
    differenceRanges: diff?.ranges ?? [], trailingPartitionBytes: backupImageLength === null ? null : partitionBytes.length - backupImageLength,
    trailingPartitionErased: backupBoundary.trailingErased, exactBytesCompared: sameImageLength ? backupImage!.byteLength : 0,
    explanation: outcome === 'EXACT IMAGE MATCH' ? 'The complete signed image bytes match exactly; OTA partition trailing bytes are reported separately.'
      : outcome === 'MATCHING BUILD — IMAGE DIFFERENCES' ? 'ELF build identities match but the complete signed image bytes differ; this is not an exact image match.'
        : outcome === 'DIFFERENT FIRMWARE BUILD' ? 'The parsed firmware build identity differs from the selected official image.'
          : outcome === 'SIGNATURE VERIFICATION FAILED' ? 'At least one image has a signature boundary whose Secure Boot V2 verification failed.'
            : 'A complete signed-image comparison could not be established from the available image evidence.',
  };
}

export async function compareFirmwareFiles(backupPath: string, firmwarePath: string, expectedSha256?: string): Promise<FirmwareComparisonReport> {
  const data = new Uint8Array(await readFile(firmwarePath));
  const actualSha = sha(data);
  if (expectedSha256 && actualSha.toLowerCase() !== expectedSha256.toLowerCase()) throw new Error(`Firmware file SHA-256 mismatch: expected ${expectedSha256}, received ${actualSha}`);
  const descriptor = parseAppDescriptor(data);
  const boundary = parseEsp32S3ImageBoundary(data);
  const signature = boundary.imageEvidence;
  if (!descriptor || !signature) throw new Error('Explicit firmware file has an unsupported ESP image format or no signed-image boundary');
  const fake: CachedFirmware = { entry: { name: firmwarePath, version: descriptor.version, file: firmwarePath, bytes: data.length,
    sha256: expectedSha256 ?? actualSha, secure_boot_v2: true, category: descriptor.firmwareType },
    verified: { entry: { name: firmwarePath, version: descriptor.version, file: firmwarePath, bytes: data.length,
      sha256: expectedSha256 ?? actualSha, secure_boot_v2: true, category: descriptor.firmwareType }, data, sha256: actualSha },
    descriptor, cachePath: firmwarePath, reused: true, signature };
  return compareBackupToFirmware(backupPath, fake, undefined, false);
}
