import { assertSafeInspection, exactLayoutErrors, type DeviceOptions } from './device.js';
import { NodeSerialPort } from './nodeSerialPort.js';
import { WG1200_CONSTANTS } from './upstream/flasher/constants.js';
import { analyzeOtaMetadata, createOtaMetadataBackup, otaDeviceBinding, planOtaActivation } from './otaManagement.js';
import { compareSecureBootTrust, parseEsp32S3ImageBoundary } from './upstream/flasher/secureBoot.js';
import { parseAppDescriptor } from './upstream/flasher/appDescriptor.js';

function logger(options: DeviceOptions) {
  return { log: (message: string) => options.verbose && process.stderr.write(`[wg1200] ${message}\n`),
    error: (message: string) => process.stderr.write(`[wg1200] ERROR ${message}\n`) };
}

async function withOtaDevice<T>(options: DeviceOptions, body: (transport: any, inspection: any) => Promise<T>): Promise<T> {
  const port = new NodeSerialPort(options.portPath);
  const { Wg1200Transport } = await import('./upstream/flasher/transport.js');
  const transport = new Wg1200Transport(logger(options), Boolean(options.verbose));
  try {
    const inspection = await transport.connect(port, options.baudRate ?? WG1200_CONSTANTS.BAUDRATE_FLASH);
    assertSafeInspection(inspection, await exactLayoutErrors(transport));
    return await body(transport, inspection);
  } finally { await transport.disconnect(); }
}

async function readPartition(transport: any, offset: number, size: number, signal?: AbortSignal): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of transport.readRegionChunks(offset, size, undefined, signal)) chunks.push(chunk);
  return Buffer.concat(chunks, size);
}

export async function readOtaStatus(options: DeviceOptions) {
  return withOtaDevice(options, async (transport, inspection) => {
    const raw = await transport.readOtadataSnapshot();
    const security = await transport.readSecureBootConfiguration();
    const analysis = analyzeOtaMetadata(raw, { factoryPresent: Boolean(inspection.partitions.factory) });
    const slots = {} as Record<'ota_0' | 'ota_1', unknown>;
    for (const slot of ['ota_0', 'ota_1'] as const) {
      const part = slot === 'ota_0' ? WG1200_CONSTANTS.APP_OTA_0 : WG1200_CONSTANTS.APP_OTA_1;
      const image = await readPartition(transport, part.offset, part.size, options.signal);
      const boundary = parseEsp32S3ImageBoundary(image);
      const trust = boundary.imageEvidence ? compareSecureBootTrust(boundary.imageEvidence, security) : null;
      slots[slot] = { offset: part.offset, length: part.size, sha256: boundary.imageLength ? (await import('node:crypto')).createHash('sha256').update(image.subarray(0, boundary.imageLength)).digest('hex') : null,
        descriptor: parseAppDescriptor(image.subarray(0, 4096)),
        imageStatus: boundary.status, imageLength: boundary.imageLength, signature: boundary.imageEvidence ? { valid: boundary.imageEvidence.signatureValid, trust } : null };
    }
    return { outcome: 'READ ONLY OTA STATUS', partitionTable: Object.fromEntries(Object.entries(inspection.partitions).map(([label, p]: [string, any]) => [label, { offset: p.offset, length: p.size }])),
      metadata: analysis, slots,
      activeRunningSlot: { value: null, source: 'unobserved: ROM flash inspection cannot query esp_ota_get_running_partition; collect serial boot logs and inspect Loaded app from partition at offset.' },
      secureBoot: security.secureBootV2, antiRollback: { status: 'unknown', source: 'not established by eFuse readout or OTA metadata' },
      rollback: { status: 'unknown', source: 'installed bootloader CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE is not independently established' },
      activation: { allowed: false, reasons: ['Actual running slot is not observed by ROM flash inspection.', 'Installed bootloader rollback and anti-rollback configuration are unknown.', 'Activation writer is intentionally unavailable pending installed bootloader and return-path evidence.'] } };
  });
}

export async function backupOtaMetadata(options: DeviceOptions & { outputPath: string }) {
  return withOtaDevice(options, async (transport, inspection) => {
    if (!inspection.secureCert?.sha256) throw new Error('OTA metadata backup requires a verified Secure Certificate identity');
    const binding = otaDeviceBinding(inspection.macAddress, inspection.secureCert.sha256);
    return createOtaMetadataBackup({ outputPath: options.outputPath, deviceBinding: binding,
      readChunks: transport.readRegionChunks(WG1200_CONSTANTS.OTADATA.offset, WG1200_CONSTANTS.OTADATA.size, undefined, options.signal),
      hashLivePartition: () => transport.hashRegionSha256(WG1200_CONSTANTS.OTADATA.offset, WG1200_CONSTANTS.OTADATA.size, undefined, options.signal), signal: options.signal });
  });
}

export async function dryRunOtaActivation(options: DeviceOptions & { target: 'ota_0' | 'ota_1'; metadataBackupManifest?: string }) {
  return withOtaDevice(options, async (transport, inspection) => {
    const raw = await transport.readOtadataSnapshot();
    const analysis = analyzeOtaMetadata(raw, { factoryPresent: true });
    let backupVerified = false;
    const security = await transport.readSecureBootConfiguration();
    if (options.metadataBackupManifest) {
      const { validateOtaMetadataBackup } = await import('./otaManagement.js');
      try { await validateOtaMetadataBackup(options.metadataBackupManifest, { bytes: raw,
        deviceBinding: otaDeviceBinding(inspection.macAddress, inspection.secureCert.sha256) }); backupVerified = true; } catch { /* report as a closed gate */ }
    }
    let targetImageValid = false; let targetImageSha256: string | null = null; let targetSignatureTrusted = false;
    const targetPart = options.target === 'ota_0' ? WG1200_CONSTANTS.APP_OTA_0 : WG1200_CONSTANTS.APP_OTA_1;
    const targetImage = await readPartition(transport, targetPart.offset, targetPart.size, options.signal);
    const boundary = parseEsp32S3ImageBoundary(targetImage);
    targetImageValid = boundary.status === 'valid-signature';
    if (boundary.imageLength) targetImageSha256 = (await import('node:crypto')).createHash('sha256').update(targetImage.subarray(0, boundary.imageLength)).digest('hex');
    if (boundary.imageEvidence) targetSignatureTrusted = compareSecureBootTrust(boundary.imageEvidence, security).result === 'TRUSTED';
    const otherPart = options.target === 'ota_0' ? WG1200_CONSTANTS.APP_OTA_1 : WG1200_CONSTANTS.APP_OTA_0;
    const otherImage = await readPartition(transport, otherPart.offset, otherPart.size, options.signal);
    const otherBoundary = parseEsp32S3ImageBoundary(otherImage);
    return planOtaActivation({ analysis, target: options.target, actualRunningSlot: null,
      targetImageValid, otherImageValid: otherBoundary.status === 'valid-signature', targetImageSha256,
      expectedTargetSha256: 'bb5af75dfe1b5df7d973110d834c8b7c26af983acc0ff2728900b3ca88dc19eb',
      targetSignatureTrusted, metadataBackupVerified: backupVerified, rollbackConfig: 'unknown', antiRollbackConfig: 'unknown' });
  });
}
