import type { Wg1200Inspection, Wg1200Transport } from './upstream/flasher/transport.js';
import { WG1200_CONSTANTS } from './upstream/flasher/constants.js';
import { EXPECTED_WG1200_PARTITIONS, parsePartitionTableWithMetadata } from './upstream/flasher/partitions.js';
import { NodeSerialPort } from './nodeSerialPort.js';
import { fetchAndVerifyFirmware } from './upstream/flasher/manifest.js';
import { buildTransactionalOtadataSector } from './upstream/flasher/otadata.js';
import { md5Hex } from './upstream/flasher/hashing.js';
import { fetchCatalog } from './catalog.js';
import { analyzeBootLogs, captureBootLogs } from './upstream/flasher/serialLog.js';
import { parseAppDescriptor } from './upstream/flasher/appDescriptor.js';
import { isValidAppDescriptor } from './upstream/flasher/appDescriptor.js';
import { compareFirmware, firmwareInstallPolicy, type FirmwareComparison } from './upstream/flasher/firmwareComparison.js';
import type { FirmwareEntry, VerifiedFirmware } from './upstream/flasher/manifest.js';

export interface DeviceOptions { portPath: string; baudRate?: number; traceSerial?: boolean; }
export interface FlashConfirmation {
  deviceName: string; firmwareKey: string; firmwareLabel: string; activeSlot: string; targetSlot: string;
  targetOffset: number; bytes: number; sha256: string; recovery: boolean;
  comparison: FirmwareComparison;
}
export interface SelectedFirmware { entry: FirmwareEntry; verified: VerifiedFirmware; descriptor: NonNullable<ReturnType<typeof parseAppDescriptor>>; }
export interface FirmwareCheckResult {
  device: { model: 'WG1200'; identity: string | null; identityValid: boolean; chip: string; flashBytes: number };
  otaState: { ambiguous: boolean; explanation: string };
  installedFirmware: FirmwareComparison['installed'];
  availableFirmware: FirmwareComparison['selected'];
  firmwareImageSha256: string;
  comparison: FirmwareComparison['kind'];
  updateAvailable: boolean;
  flashingPermitted: boolean;
  approvalRequired: boolean;
  status: 'up-to-date' | 'update-available' | 'downgrade-blocked' | 'approval-required' | 'incompatible-firmware';
  explanation: string;
  ota?: { activeSlot: string | null; inactiveSlot: string | null; nextTargetSlot: string | null; nextTargetOffset: number | null; activeSeq: number | null; nextSeq: number | null; ambiguous: boolean; state?: string };
  firmwareSlots?: Record<string, { active: boolean; version: string | null; firmwareType: string | null; build: string | null; descriptorStatus: 'valid' | 'invalid' | 'unknown' }>;
  inactiveMatch?: boolean;
}

function descriptorSlot(desc: Wg1200Inspection['currentFirmware'], active: boolean) {
  if (!desc) return { active, version: null, firmwareType: null, build: null, descriptorStatus: 'unknown' as const };
  const valid = isValidAppDescriptor(desc);
  return { active, version: valid ? desc.version : null, firmwareType: valid ? desc.firmwareType : null,
    build: valid ? desc.appElfSha256 : null, descriptorStatus: valid ? 'valid' as const : 'invalid' as const };
}

export function firmwareSlotSummary(inspection: Wg1200Inspection) {
  const activeSlot = inspection.otadata.isAmbiguous || !['ota_0', 'ota_1'].includes(inspection.otadata.activeSlot)
    ? null : inspection.otadata.activeSlot;
  const inactiveSlot = activeSlot === 'ota_0' ? 'ota_1' : activeSlot === 'ota_1' ? 'ota_0' : null;
  return {
    ota: { activeSlot, inactiveSlot, nextTargetSlot: inspection.otadata.isAmbiguous ? null : inspection.otadata.targetSlot,
      nextTargetOffset: inspection.otadata.isAmbiguous ? null : inspection.otadata.targetOffset,
      activeSeq: inspection.otadata.activeSeq || null, nextSeq: inspection.otadata.isAmbiguous ? null : inspection.otadata.nextSeq,
      ambiguous: inspection.otadata.isAmbiguous, state: inspection.otadata.isAmbiguous ? 'AMBIGUOUS' : 'VALID' },
    firmwareSlots: {
      ota_0: descriptorSlot(activeSlot === 'ota_0' ? inspection.currentFirmware : activeSlot === 'ota_1' ? inspection.inactiveFirmware : null, activeSlot === 'ota_0'),
      ota_1: descriptorSlot(activeSlot === 'ota_1' ? inspection.currentFirmware : activeSlot === 'ota_0' ? inspection.inactiveFirmware : null, activeSlot === 'ota_1'),
    },
  };
}

export async function loadSelectedFirmware(firmwareKey: string, manifestUrl: string): Promise<SelectedFirmware> {
  const manifest = await fetchCatalog(manifestUrl);
  const entry = manifest.firmwares[firmwareKey];
  if (!entry) throw new Error(`Firmware key '${firmwareKey}' is not in the validated manifest`);
  const firmwareUrl = new URL(entry.file, manifestUrl);
  if (firmwareUrl.origin !== new URL(manifestUrl).origin || firmwareUrl.protocol !== 'https:') {
    throw new Error('Firmware URL is outside the HTTPS manifest origin');
  }
  const verified = await fetchAndVerifyFirmware({ ...entry, file: firmwareUrl.href });
  const descriptor = parseAppDescriptor(verified.data);
  if (!descriptor) throw new Error('Selected firmware image has no valid ESP application descriptor');
  if (entry.category && descriptor.firmwareType !== entry.category) {
    throw new Error(`Selected image firmware type '${descriptor.firmwareType}' does not match manifest category '${entry.category}'`);
  }
  return { entry, verified, descriptor };
}

export async function checkFirmware(options: DeviceOptions & { firmwareKey: string; manifestUrl: string }): Promise<FirmwareCheckResult> {
  const selected = await loadSelectedFirmware(options.firmwareKey, options.manifestUrl);
  const inspection = await inspectDevice(options);
  const comparison = compareFirmware(inspection.currentFirmware, selected.descriptor);
  const slots = firmwareSlotSummary(inspection);
  const installPolicy = firmwareInstallPolicy(comparison);
  const status = comparison.kind === 'identical' ? 'up-to-date'
    : comparison.kind === 'newer' ? 'update-available'
      : comparison.kind === 'older' ? 'downgrade-blocked'
        : comparison.kind === 'different-type' ? 'incompatible-firmware' : 'approval-required';
  const approvalRequired = installPolicy.approvalRequired || inspection.otadata.isAmbiguous;
  const finalStatus = status === 'update-available' && inspection.otadata.isAmbiguous ? 'approval-required' : status;
  const explanation = inspection.otadata.isAmbiguous
    ? `${comparison.message} OTA metadata is ambiguous: ${inspection.otadata.description}`
    : comparison.message;
  return {
    device: { model: 'WG1200', identity: inspection.deviceName ?? inspection.macAddress ?? null,
      identityValid: inspection.secureCert.valid, chip: inspection.chipName, flashBytes: inspection.flashSizeBytes },
    otaState: { ambiguous: inspection.otadata.isAmbiguous, explanation: inspection.otadata.description },
    installedFirmware: comparison.installed, availableFirmware: comparison.selected,
    firmwareImageSha256: selected.verified.sha256, comparison: comparison.kind,
    updateAvailable: comparison.kind === 'newer',
    flashingPermitted: installPolicy.flashingPermitted && !inspection.otadata.isAmbiguous,
    approvalRequired, status: finalStatus, explanation,
    ...slots,
    inactiveMatch: Boolean(inspection.inactiveFirmware && isValidAppDescriptor(inspection.inactiveFirmware) &&
      inspection.inactiveFirmware.version === selected.descriptor.version && inspection.inactiveFirmware.appElfSha256 === selected.descriptor.appElfSha256 &&
      inspection.inactiveFirmware.firmwareType === selected.descriptor.firmwareType),
  };
}

export function checkExitCode(_result: FirmwareCheckResult): 0 { return 0; }
export function serializeFirmwareCheckResult(result: FirmwareCheckResult): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}
export function summarizeBootLog(lines: string[]) {
  const analysis = analyzeBootLogs(lines);
  const versionLine = lines.find((line) => /App version:\s*/i.test(line));
  return {
    bootVersion: versionLine?.match(/App version:\s*(.+)/i)?.[1]?.trim(),
    secureBootVerified: analysis.secureBootVerified,
    calibrationUpdated: lines.some((line) => /phy_init: Saving new calibration data/i.test(line)),
  };
}
export interface OtaWriteOperations {
  installApplication(offset: number, bytes: Uint8Array, onProgress?: (percent: number) => void): Promise<void>;
  verifyApplicationFlash(offset: number, expectedMd5: string, length: number): Promise<boolean>;
  writeOtaSelectSector(address: number, bytes: Uint8Array, expectedSeq: number): Promise<void>;
  verifyProtectedRegions(snapshots: Awaited<ReturnType<Wg1200Transport['snapshotProtectedRegions']>>): Promise<{ valid: boolean; mismatches: string[] }>;
  hardReset(): Promise<void | boolean>;
}

export async function runOtaWriteTransaction(transport: OtaWriteOperations, input: {
  targetOffset: number; firmwareBytes: Uint8Array; nextSeq: number; targetSector: 0 | 1;
  snapshots: Awaited<ReturnType<Wg1200Transport['snapshotProtectedRegions']>>;
}, onProgress?: (percent: number) => void): Promise<{ flashVerified: true; otaMetadataVerified: true; protectedPartitionsVerified: true; deviceReleased: boolean }> {
  await transport.installApplication(input.targetOffset, input.firmwareBytes, onProgress);
  const expectedMd5 = md5Hex(input.firmwareBytes);
  if (!(await transport.verifyApplicationFlash(input.targetOffset, expectedMd5, input.firmwareBytes.byteLength))) {
    throw new Error('On-chip flash MD5 mismatch; OTA activation was not attempted');
  }
  // Do not make the new slot bootable until all protected-region checks pass.
  const protectedResult = await transport.verifyProtectedRegions(input.snapshots);
  if (!protectedResult.valid) throw new Error(`Protected flash data changed: ${protectedResult.mismatches.join('; ')}; OTA activation was not attempted`);
  const { targetAddress, sectorData } = buildTransactionalOtadataSector(input.nextSeq, input.targetSector);
  await transport.writeOtaSelectSector(targetAddress, sectorData, input.nextSeq);
  const resetResult = await transport.hardReset();
  return { flashVerified: true, otaMetadataVerified: true, protectedPartitionsVerified: true, deviceReleased: resetResult !== false };
}

function assertSafeInspection(result: Wg1200Inspection, exactErrors: string[]) {
  const errors = [
    ...(!result.isEsp32S3 ? [`chip is ${result.chipName}, expected ESP32-S3`] : []),
    ...(!result.is16Mb ? [`flash is ${result.flashSizeMb} MiB, expected 16 MiB`] : []),
    ...result.partitionErrors,
    ...exactErrors,
    ...result.secureCert.errors,
  ];
  if (!result.isValidWg1200 || errors.length) throw new Error(`Device validation failed: ${errors.join('; ')}`);
}

async function exactLayoutErrors(transport: Wg1200Transport): Promise<string[]> {
  const tableBytes = await transport.readRegion(WG1200_CONSTANTS.PARTITION_TABLE.offset, WG1200_CONSTANTS.PARTITION_TABLE.size);
  return validateExactPartitionLayout(parsePartitionTableWithMetadata(tableBytes), tableBytes);
}

export function validateExactPartitionLayout(parsed: ReturnType<typeof parsePartitionTableWithMetadata>, rawBytes?: Uint8Array): string[] {
  const errors: string[] = [];
  const expectedNames = Object.keys(EXPECTED_WG1200_PARTITIONS).sort();
  const actualNames = Object.keys(parsed.partitions).sort();
  if (parsed.md5Valid !== true) errors.push(`partition table MD5 must be present and valid (result: ${parsed.md5Valid})`);
  if (parsed.duplicateLabels.length) errors.push(`duplicate labels: ${parsed.duplicateLabels.join(', ')}`);
  if (rawBytes) errors.push(...validateRawPartitionTable(rawBytes));
  const unexpected = actualNames.filter((name) => !expectedNames.includes(name));
  const missing = expectedNames.filter((name) => !actualNames.includes(name));
  if (unexpected.length) errors.push(`unexpected partition labels: ${unexpected.join(', ')}`);
  if (missing.length) errors.push(`missing partition labels: ${missing.join(', ')}`);
  for (const [name, expected] of Object.entries(EXPECTED_WG1200_PARTITIONS)) {
    const found = parsed.partitions[name];
    if (!found) continue;
    const end = found.offset + found.size;
    if (!Number.isSafeInteger(end) || found.offset < 0 || found.size <= 0 || end > WG1200_CONSTANTS.FLASH_SIZE_BYTES) {
      errors.push(`partition '${name}' has an invalid flash range`);
    }
    for (const field of ['offset', 'size', 'type', 'subtype'] as const) {
      const target = expected[field];
      if (target !== undefined && found[field] !== target) errors.push(`partition '${name}' ${field} mismatch`);
    }
  }
  const ordered = Object.values(parsed.partitions).sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i].offset < ordered[i - 1].offset + ordered[i - 1].size) {
      errors.push(`partitions '${ordered[i - 1].label}' and '${ordered[i].label}' overlap`);
    }
  }
  return [...new Set(errors)];
}

function validateRawPartitionTable(bytes: Uint8Array): string[] {
  const errors: string[] = [];
  if (bytes.byteLength !== WG1200_CONSTANTS.PARTITION_TABLE.size) return ['partition table read has an unexpected size'];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let entries = 0;
  let foundMd5 = false;
  let md5End = bytes.byteLength;
  for (let offset = 0; offset + 32 <= bytes.byteLength; offset += 32) {
    const magic = view.getUint16(offset, true);
    if (magic === 0xebeb) { foundMd5 = true; md5End = offset + 32; break; }
    if (magic === 0xffff) break;
    if (magic !== WG1200_CONSTANTS.PARTITION_TABLE_MAGIC) {
      errors.push(`unexpected record magic 0x${magic.toString(16)} at 0x${offset.toString(16)}`);
      break;
    }
    entries++;
    let labelLength = 0;
    while (labelLength < 16 && bytes[offset + 12 + labelLength] !== 0) labelLength++;
    if (labelLength === 0) errors.push(`partition entry ${entries} has an empty label`);
    if (view.getUint32(offset + 28, true) !== 0) errors.push(`partition entry ${entries} has unexpected flags`);
  }
  if (!foundMd5) errors.push('partition table MD5 record is missing');
  if (entries !== Object.keys(EXPECTED_WG1200_PARTITIONS).length) errors.push(`partition table has ${entries} entries; expected ${Object.keys(EXPECTED_WG1200_PARTITIONS).length}`);
  for (let i = md5End; i < bytes.length; i++) if (bytes[i] !== 0xff) {
    errors.push('partition table contains unexpected data after its MD5 record');
    break;
  }
  return errors;
}

/** Read-only inspection adapter. This class intentionally exposes no write operations. */
export async function inspectDevice(options: DeviceOptions): Promise<Wg1200Inspection> {
  const trace = options.traceSerial ? (message: string) => process.stderr.write(`[serial] ${message}\n`) : undefined;
  const port = new NodeSerialPort(options.portPath, trace);
  const { Wg1200Transport } = await import('./upstream/flasher/transport.js');
  const transport = new Wg1200Transport({
    log: (message) => process.stderr.write(`[wg1200] ${message}\n`),
    error: (message) => process.stderr.write(`[wg1200] ERROR ${message}\n`),
    debug: (message) => process.stderr.write(`${message}\n`),
  }, options.traceSerial);
  try {
    const result = await transport.connect(port, options.baudRate ?? WG1200_CONSTANTS.BAUDRATE_FLASH);
    assertSafeInspection(result, await exactLayoutErrors(transport));
    return result;
  } finally {
    await transport.disconnect();
  }
}

/** Performs the reviewed OTA-slot update flow. The caller must obtain explicit confirmation. */
export async function flashDevice(options: DeviceOptions & {
  firmwareKey: string; manifestUrl: string; recovery?: boolean; force?: boolean; dryRun?: boolean;
  bootLogSeconds?: number; onBootLine?: (line: string) => void;
  confirm: (summary: FlashConfirmation) => Promise<boolean>;
  approveComparisonException?: (comparison: FirmwareComparison) => Promise<boolean>;
}): Promise<{ deviceName: string; firmwareKey: string; targetSlot: string; targetOffset: number; sha256: string; firmwareSlots?: ReturnType<typeof firmwareSlotSummary>['firmwareSlots']; ota?: ReturnType<typeof firmwareSlotSummary>['ota']; inactiveMatch?: boolean; bootSignature?: string; bootVersion?: string; secureBootVerified?: boolean; calibrationUpdated?: boolean; dryRun?: boolean; alreadyInstalled?: boolean; comparison: FirmwareComparison; flashVerified?: boolean; otaMetadataVerified?: boolean; protectedPartitionsVerified?: boolean; bootObserved?: boolean; expectedSlotObserved?: boolean | null; expectedFirmwareObserved?: boolean | null; applicationStarted?: boolean; applicationHealthy?: 'not-checked'; bootFailureObserved?: boolean; bootFailureLines?: string[]; bootLines?: string[] }> {
  const { entry, verified, descriptor: selectedDescriptor } = await loadSelectedFirmware(options.firmwareKey, options.manifestUrl);

  const trace = options.traceSerial ? (message: string) => process.stderr.write(`[serial] ${message}\n`) : undefined;
  const port = new NodeSerialPort(options.portPath, trace);
  const { Wg1200Transport } = await import('./upstream/flasher/transport.js');
  const transport = new Wg1200Transport({
    log: (message) => process.stderr.write(`[wg1200] ${message}\n`),
    error: (message) => process.stderr.write(`[wg1200] ERROR ${message}\n`),
    debug: (message) => process.stderr.write(`${message}\n`),
  }, options.traceSerial);
  let completed: { deviceName: string; firmwareKey: string; targetSlot: string; targetOffset: number; sha256: string; flashVerified: boolean; otaMetadataVerified: boolean; protectedPartitionsVerified: boolean } | undefined;
  let flashComparison: FirmwareComparison | undefined;
  let firmwareReleased = false;
  try {
    const before = await transport.connect(port, options.baudRate ?? WG1200_CONSTANTS.BAUDRATE_FLASH);
    assertSafeInspection(before, await exactLayoutErrors(transport));
    if (before.otadata.isAmbiguous && !options.recovery) {
      throw new Error(`OTA state is ambiguous: ${before.otadata.description}. Use --recover to authorize the official targeted recovery flow.`);
    }
    const comparison = compareFirmware(before.currentFirmware, selectedDescriptor);
    const slotSummary = firmwareSlotSummary(before);
    const inactiveMatch = Boolean(before.inactiveFirmware && isValidAppDescriptor(before.inactiveFirmware) &&
      before.inactiveFirmware.version === selectedDescriptor.version && before.inactiveFirmware.appElfSha256 === selectedDescriptor.appElfSha256 &&
      before.inactiveFirmware.firmwareType === selectedDescriptor.firmwareType);
    const installPolicy = firmwareInstallPolicy(comparison, options.force);
    flashComparison = comparison;
    if (installPolicy.downgradeBlocked && !options.dryRun) throw new Error(comparison.message);
    const summary: FlashConfirmation = {
      deviceName: before.deviceName ?? 'WeatherXM WG1200', firmwareKey: options.firmwareKey,
      firmwareLabel: `${entry.name} v${entry.version}`, activeSlot: before.otadata.activeSlot, targetSlot: before.otadata.targetSlot,
      targetOffset: before.otadata.targetOffset, bytes: verified.data.byteLength, sha256: verified.sha256,
      recovery: before.otadata.isAmbiguous,
      comparison,
    };
    if (options.dryRun) return { deviceName: summary.deviceName, firmwareKey: options.firmwareKey,
      targetSlot: summary.targetSlot, targetOffset: summary.targetOffset, sha256: verified.sha256, dryRun: true, comparison,
      ...slotSummary, inactiveMatch };
    if (installPolicy.alreadyInstalled) {
      return { deviceName: before.deviceName ?? 'WeatherXM WG1200', firmwareKey: options.firmwareKey,
        targetSlot: before.otadata.targetSlot, targetOffset: before.otadata.targetOffset,
        sha256: verified.sha256, alreadyInstalled: true, comparison };
    }
    if (installPolicy.approvalRequired) {
      if (!options.approveComparisonException || !(await options.approveComparisonException(comparison))) {
        throw new Error(`${comparison.message} Explicit interactive approval is required; --yes cannot approve this change.`);
      }
    }
    if (!(await options.confirm(summary))) throw new Error('Firmware installation cancelled before any flash write');

    // Re-inspect immediately before the first mutation and bind the confirmation to this same device/state.
    const fresh = await transport.inspect();
    assertSafeInspection(fresh, await exactLayoutErrors(transport));
    const freshFirmware = compareFirmware(before.currentFirmware, fresh.currentFirmware);
    if (freshFirmware.kind !== 'identical') {
      throw new Error('Active firmware descriptor changed after confirmation; refusing to write');
    }
    if (fresh.secureCert.sha256 !== before.secureCert.sha256 || fresh.otadata.activeSlot !== before.otadata.activeSlot ||
        fresh.otadata.activeSeq !== before.otadata.activeSeq || fresh.otadata.nextSeq !== before.otadata.nextSeq ||
        fresh.otadata.targetSector !== before.otadata.targetSector || fresh.otadata.targetSlot !== before.otadata.targetSlot ||
        fresh.otadata.targetOffset !== before.otadata.targetOffset ||
        fresh.otadata.isAmbiguous !== before.otadata.isAmbiguous || (fresh.otadata.isAmbiguous && !options.recovery)) {
      throw new Error('Device identity or OTA target changed after confirmation; refusing to write');
    }

    const snapshots = await transport.snapshotProtectedRegions();
    let lastProgress = -5;
    const transactionResult = await runOtaWriteTransaction(transport, {
      targetOffset: fresh.otadata.targetOffset, firmwareBytes: verified.data,
      nextSeq: fresh.otadata.nextSeq, targetSector: fresh.otadata.targetSector, snapshots,
    }, (percent) => {
      if (percent === 100 || percent >= lastProgress + 5) {
        lastProgress = percent;
        process.stderr.write(`[wg1200] App write progress: ${percent}%\n`);
      }
    });
    firmwareReleased = transactionResult.deviceReleased;
    completed = { deviceName: summary.deviceName, firmwareKey: options.firmwareKey, targetSlot: summary.targetSlot, targetOffset: summary.targetOffset, sha256: verified.sha256, ...transactionResult };
  } finally {
    await transport.disconnect(!firmwareReleased);
  }
  if (!completed) throw new Error('Firmware write completed without a result');
  const bootSeconds = options.bootLogSeconds ?? 15;
  const bootPort = bootSeconds > 0 ? new NodeSerialPort(options.portPath, trace, undefined, true) : undefined;
  const boot = bootPort
    ? await captureBootLogs(bootPort, bootSeconds * 1000, options.onBootLine, { slotOffset: completed.targetOffset, firmwareVersion: selectedDescriptor.version })
    : analyzeBootLogs([], { slotOffset: completed.targetOffset, firmwareVersion: selectedDescriptor.version });
  if (!flashComparison) throw new Error('Firmware comparison was not completed');
  return {
    ...completed, bootSignature: boot.detectedSign, bootVersion: boot.bootVersion,
    secureBootVerified: boot.secureBootVerified,
    calibrationUpdated: boot.lines.some((line) => /phy_init: Saving new calibration data/i.test(line)),
    bootObserved: boot.bootObserved, expectedSlotObserved: boot.expectedSlotObserved,
    expectedFirmwareObserved: boot.expectedFirmwareObserved, applicationStarted: boot.applicationStarted, applicationHealthy: boot.applicationHealthy,
    bootFailureObserved: boot.bootFailureObserved, bootFailureLines: boot.bootFailureLines,
    bootLines: boot.lines, comparison: flashComparison,
  };
}

export function summarizeInspection(data: Wg1200Inspection) {
  const slots = firmwareSlotSummary(data);
  return {
    hardware: 'WG1200', chip: data.chipName, flashBytes: data.flashSizeBytes,
    macAddress: data.macAddress, deviceName: data.deviceName,
    identity: { valid: data.secureCert.valid, fingerprint: data.secureCert.fingerprint, commonName: data.secureCert.commonName },
    partitionLayout: { valid: data.isPartitionLayoutValid, partitions: data.partitions, errors: data.partitionErrors },
    ota: { ...data.otadata, ...slots.ota },
    firmwareSlots: slots.firmwareSlots,
    activeFirmware: data.currentFirmware,
    targetFirmware: data.inactiveFirmware,
  };
}
