import { createHash } from 'node:crypto';
import { assertSafeInspection, exactLayoutErrors, type DeviceOptions } from './device.js';
import { NodeSerialPort } from './nodeSerialPort.js';
import { WG1200_CONSTANTS } from './upstream/flasher/constants.js';
import { analyzeOtaMetadata, createOtaMetadataBackup, otaDeviceBinding, planOtaActivation } from './otaManagement.js';
import { compareSecureBootTrust, parseEsp32S3ImageBoundary } from './upstream/flasher/secureBoot.js';
import { parseAppDescriptor } from './upstream/flasher/appDescriptor.js';
import type { ProgressReporter } from './progress.js';

function logger(options: DeviceOptions) {
  const report = (message: string) => options.progress?.log(`[wg1200] ${message}`);
  return { log: (message: string) => (options.verbose || options.traceSerial) && report(message), error: (message: string) => report(`ERROR ${message}`),
    progress: (stage: string, state: 'start' | 'complete' | 'failed' | 'bytes', detail?: string, completed?: number, total?: number) => {
      if (state === 'start') options.progress?.stage(stage, total, detail);
      else if (state === 'bytes') options.progress?.bytes(completed ?? 0, total);
      else options.progress?.finish(state, detail);
    } };
}

async function withOtaDevice<T>(options: DeviceOptions, body: (transport: any, inspection: any) => Promise<T>): Promise<T> {
  const lifecycle = (stage: string, state: 'start' | 'complete' | 'failed', detail?: string) => {
    if (state === 'start') options.progress?.log(`${stage}...`);
    else options.progress?.log(`${stage} ${state === 'complete' ? 'DONE' : 'FAILED'}${detail ? ` — ${detail}` : ''}`);
  };
  const port = new NodeSerialPort(options.portPath, options.traceSerial ? (message) => options.progress?.log(`[serial] ${message}`) : undefined,
    undefined, false, lifecycle);
  const { Wg1200Transport } = await import('./upstream/flasher/transport.js');
  const transport = new Wg1200Transport(logger(options), Boolean(options.verbose || options.traceSerial));
  let result: T | undefined; let operationError: unknown; let cleanupError: unknown;
  try {
    options.progress?.log('Connecting to ESP32-S3 and initializing ROM...');
    const inspection = await transport.connect(port, options.baudRate ?? WG1200_CONSTANTS.BAUDRATE_FLASH);
    options.progress?.log('ROM flash reader ready; device metadata collected');
    options.progress?.stage('Reading and validating partition table', WG1200_CONSTANTS.PARTITION_TABLE.size);
    const layoutErrors = await exactLayoutErrors(transport);
    options.progress?.bytes(WG1200_CONSTANTS.PARTITION_TABLE.size, WG1200_CONSTANTS.PARTITION_TABLE.size);
    assertSafeInspection(inspection, layoutErrors);
    options.progress?.finish('complete', 'exact WG1200 layout validated');
    result = await body(transport, inspection);
  } catch (error) {
    operationError = error;
    options.progress?.finish(options.signal?.aborted ? 'cancelled' : 'failed', error instanceof Error ? error.message : String(error));
  } finally {
    options.progress?.stage('Returning gateway to normal boot');
    try {
      const disconnected = await transport.disconnect();
      const cleanupState = disconnected.normalBootResetSucceeded === false ? 'failed' : 'complete';
      const cleanupDetail = disconnected.normalBootResetSucceeded === true ? 'normal-boot reset requested; serial connection released'
        : disconnected.normalBootResetSucceeded === false ? 'normal-boot reset was unavailable'
          : 'serial connection released; reset was not required';
      options.progress?.finish(cleanupState, cleanupDetail);
    } catch (error) { cleanupError = error; options.progress?.finish('failed'); }
  }
  if (operationError !== undefined) throw operationError;
  if (cleanupError !== undefined) throw cleanupError;
  return result as T;
}

async function readPartition(transport: any, offset: number, size: number, label: string, progress?: ProgressReporter, signal?: AbortSignal): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  progress?.stage(label, size);
  for await (const chunk of transport.readRegionChunks(offset, size, (done: number, total: number) => progress?.bytes(done, total), signal)) chunks.push(chunk);
  progress?.finish('complete', 'flash read complete');
  return Buffer.concat(chunks, size);
}

function hashImage(data: Uint8Array, length: number, label: string, progress?: ProgressReporter): string {
  progress?.stage(label, length);
  const hash = createHash('sha256');
  for (let offset = 0; offset < length; offset += 64 * 1024) {
    const chunk = data.subarray(offset, Math.min(length, offset + 64 * 1024));
    hash.update(chunk);
    progress?.bytes(offset + chunk.byteLength, length);
  }
  progress?.finish('complete');
  return hash.digest('hex');
}

export type OtaStatusVerificationMode = 'fast' | 'thorough';

export async function buildOtaStatusReport(input: { transport: any; inspection: any; verificationMode?: OtaStatusVerificationMode;
  progress?: ProgressReporter; signal?: AbortSignal }) {
    const mode = input.verificationMode ?? 'fast';
    const { transport, inspection, progress, signal } = input;
    let raw: Uint8Array;
    if (mode === 'fast' && inspection.otadataRaw instanceof Uint8Array) {
      progress?.stage('Using OTA metadata read during device inspection');
      raw = inspection.otadataRaw;
      progress?.finish('complete', '8 KiB snapshot retained from validated device inspection');
    } else {
      raw = await readPartition(transport, WG1200_CONSTANTS.OTADATA.offset, WG1200_CONSTANTS.OTADATA.size, 'Reading OTA metadata', progress, signal);
    }
    progress?.stage('Reading Secure Boot trust configuration');
    const security = await transport.readSecureBootConfiguration();
    progress?.finish('complete');
    const analysis = analyzeOtaMetadata(raw, { factoryPresent: Boolean(inspection.partitions.factory) });
    const slots = {} as Record<'ota_0' | 'ota_1', unknown>;
    for (const slot of ['ota_0', 'ota_1'] as const) {
      const part = slot === 'ota_0' ? WG1200_CONSTANTS.APP_OTA_0 : WG1200_CONSTANTS.APP_OTA_1;
      let descriptor: ReturnType<typeof parseAppDescriptor>;
      let imageHeaderValid: boolean;
      let imageSha256: string | null = null;
      let partitionSha256: string | null = null;
      let imageLength: number | null = null;
      let imageStatus: string;
      let signatureVerified: boolean | null = null;
      let signerTrust: ReturnType<typeof compareSecureBootTrust> | null = null;
      if (mode === 'fast') {
        let header = inspection.appHeaders?.[part.offset.toString(16)] as Uint8Array | undefined;
        if (!header || header.byteLength !== 4096) {
          header = await readPartition(transport, part.offset, 4096, `Reading ${slot} application header`, progress, signal);
        } else {
          progress?.stage(`Using ${slot} application header collected during inspection`);
          progress?.finish('complete', '4 KiB cached descriptor evidence');
        }
        imageHeaderValid = header[0] === 0xe9;
        descriptor = parseAppDescriptor(header);
        imageStatus = imageHeaderValid ? (descriptor ? 'header-and-descriptor-present' : 'header-present-descriptor-invalid') : 'invalid-image-header';
      } else {
        const image = await readPartition(transport, part.offset, part.size, `Inspecting ${slot} firmware`, progress, signal);
        progress?.stage(`Verifying ${slot} signature and image structure`);
        const boundary = parseEsp32S3ImageBoundary(image);
        signerTrust = boundary.imageEvidence ? compareSecureBootTrust(boundary.imageEvidence, security) : null;
        progress?.finish('complete', `${boundary.status}: ${boundary.explanation}`);
        descriptor = parseAppDescriptor(image.subarray(0, 4096));
        imageHeaderValid = image[0] === 0xe9;
        imageStatus = boundary.status;
        imageLength = boundary.imageLength ?? null;
        signatureVerified = boundary.imageEvidence ? boundary.imageEvidence.signatureValid : null;
        imageSha256 = boundary.imageLength ? hashImage(image, boundary.imageLength, `Hashing ${slot} signed image`, progress) : null;
        partitionSha256 = hashImage(image, image.byteLength, `Hashing ${slot} full partition`, progress);
      }
      slots[slot] = { offset: part.offset, length: part.size, sha256: imageSha256, partitionSha256, descriptor,
        buildIdentity: descriptor?.appElfSha256 || null, securityVersion: descriptor?.secureVersion ?? null,
        imageStatus, imageHeaderValid, imageLength,
        signature: { valid: signatureVerified, trust: signerTrust },
        imageVerification: { method: mode === 'fast' ? 'descriptor-and-metadata-only' : 'full-image-sha256-and-secure-boot-v2',
          fullSha256Calculated: mode === 'thorough' && imageSha256 !== null,
          fullPartitionSha256Calculated: mode === 'thorough' && partitionSha256 !== null,
          fullSha256Verified: false, signatureVerified, trustedBaselineMatched: null, baseline: 'not supplied',
          deviceMd5BaselineMatched: null, deviceMd5Status: 'not-run-no-trusted-baseline',
          explanation: mode === 'fast' ? 'Full image SHA-256 and cryptographic signature were not checked in Fast mode.' : 'Full physical image and partition SHA-256 values were calculated; no trusted digest baseline was supplied, and Secure Boot signature validity is distinct from signer trust.' } };
    }
    return { outcome: 'READ ONLY OTA STATUS', verificationMode: mode,
      assurance: mode === 'fast' ? 'OTA metadata CRC and application header/descriptor only; full image integrity and signatures not checked' : 'Both full app partitions read; image boundaries checked; SHA-256 calculated; Secure Boot V2 signatures checked when signed image evidence is present',
      partitionTable: Object.fromEntries(Object.entries(inspection.partitions).map(([label, p]: [string, any]) => [label, { offset: p.offset, length: p.size }])),
      metadata: analysis, slots,
      activeRunningSlot: { value: null, source: 'unobserved: ROM flash inspection cannot query esp_ota_get_running_partition; collect serial boot logs and inspect Loaded app from partition at offset.' },
      secureBoot: security.secureBootV2,
      deviceSecurity: { secureVersion: security.secureVersion, flashEncryption: security.flashEncryption,
        downloadMode: security.downloadMode },
      antiRollback: { status: 'unknown', source: 'not established by connected bootloader configuration' },
      rollback: { status: 'unknown', source: 'installed bootloader CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE is not independently established' },
      activation: { allowed: false, reasons: ['Actual running slot is not observed by ROM flash inspection.', 'Installed bootloader rollback and anti-rollback configuration are unknown.', 'Activation writer is intentionally unavailable pending installed bootloader and return-path evidence.'] } };
}

export async function readOtaStatus(options: DeviceOptions & { verificationMode?: OtaStatusVerificationMode }) {
  return withOtaDevice(options, async (transport, inspection) => buildOtaStatusReport({ transport, inspection,
    verificationMode: options.verificationMode, progress: options.progress, signal: options.signal }));
}

export async function backupOtaMetadata(options: DeviceOptions & { outputPath: string }) {
  return withOtaDevice(options, async (transport, inspection) => {
    if (!inspection.secureCert?.sha256) throw new Error('OTA metadata backup requires a verified Secure Certificate identity');
    const binding = otaDeviceBinding(inspection.macAddress, inspection.secureCert.sha256);
    return createOtaMetadataBackup({ outputPath: options.outputPath, deviceBinding: binding,
      readChunks: transport.readRegionChunks(WG1200_CONSTANTS.OTADATA.offset, WG1200_CONSTANTS.OTADATA.size,
        (done: number, total: number) => options.progress?.bytes(done, total), options.signal),
      hashLivePartition: () => {
        return transport.hashRegionSha256(WG1200_CONSTANTS.OTADATA.offset, WG1200_CONSTANTS.OTADATA.size,
          (done: number, total: number) => options.progress?.bytes(done, total), options.signal);
      }, signal: options.signal, progress: options.progress });
  });
}

export async function dryRunOtaActivation(options: DeviceOptions & { target: 'ota_0' | 'ota_1'; metadataBackupManifest?: string }) {
  return withOtaDevice(options, async (transport, inspection) => {
    const raw = await readPartition(transport, WG1200_CONSTANTS.OTADATA.offset, WG1200_CONSTANTS.OTADATA.size, 'Reading OTA metadata', options.progress, options.signal);
    const analysis = analyzeOtaMetadata(raw, { factoryPresent: true });
    let backupVerified = false;
    options.progress?.stage('Reading Secure Boot trust configuration');
    const security = await transport.readSecureBootConfiguration();
    options.progress?.finish('complete');
    if (options.metadataBackupManifest) {
      const { validateOtaMetadataBackup } = await import('./otaManagement.js');
      try {
        options.progress?.stage('Validating fresh metadata backup');
        await validateOtaMetadataBackup(options.metadataBackupManifest, { bytes: raw,
        deviceBinding: otaDeviceBinding(inspection.macAddress, inspection.secureCert.sha256) }); backupVerified = true; } catch { /* report as a closed gate */ }
      options.progress?.finish('complete', backupVerified ? 'device-bound backup matches current metadata' : 'backup missing, stale, or invalid');
    }
    let targetImageValid = false; let targetImageSha256: string | null = null; let targetSignatureTrusted = false;
    const targetPart = options.target === 'ota_0' ? WG1200_CONSTANTS.APP_OTA_0 : WG1200_CONSTANTS.APP_OTA_1;
    const targetImage = await readPartition(transport, targetPart.offset, targetPart.size, `Inspecting ${options.target} firmware`, options.progress, options.signal);
    options.progress?.stage(`Verifying ${options.target} image signature and structure`);
    const boundary = parseEsp32S3ImageBoundary(targetImage);
    targetImageValid = boundary.status === 'valid-signature';
    options.progress?.finish('complete', `${boundary.status}: ${boundary.explanation}`);
    if (boundary.imageLength) targetImageSha256 = hashImage(targetImage, boundary.imageLength, `Hashing ${options.target} signed image`, options.progress);
    if (boundary.imageEvidence) targetSignatureTrusted = compareSecureBootTrust(boundary.imageEvidence, security).result === 'TRUSTED';
    const otherPart = options.target === 'ota_0' ? WG1200_CONSTANTS.APP_OTA_1 : WG1200_CONSTANTS.APP_OTA_0;
    const otherSlot = options.target === 'ota_0' ? 'ota_1' : 'ota_0';
    const otherImage = await readPartition(transport, otherPart.offset, otherPart.size, `Inspecting ${otherSlot} firmware`, options.progress, options.signal);
    options.progress?.stage(`Verifying ${otherSlot} image signature and structure`);
    const otherBoundary = parseEsp32S3ImageBoundary(otherImage);
    options.progress?.finish('complete', `${otherBoundary.status}: ${otherBoundary.explanation}`);
    return planOtaActivation({ analysis, target: options.target, actualRunningSlot: null,
      targetImageValid, otherImageValid: otherBoundary.status === 'valid-signature', targetImageSha256,
      expectedTargetSha256: options.target === 'ota_0' ? 'bb5af75dfe1b5df7d973110d834c8b7c26af983acc0ff2728900b3ca88dc19eb' : null,
      targetSignatureTrusted, metadataBackupVerified: backupVerified, rollbackConfig: 'unknown', antiRollbackConfig: 'unknown' });
  });
}
