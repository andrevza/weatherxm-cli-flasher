import { createHash } from 'node:crypto';
import { assertSafeInspection, exactLayoutErrors, loadSelectedFirmware, STAGE_ONLY_WXM_0834_SHA256, type DeviceOptions } from './device.js';
import { DEFAULT_MANIFEST_URL } from './catalog.js';
import { NodeSerialPort } from './nodeSerialPort.js';
import { WG1200_CONSTANTS } from './upstream/flasher/constants.js';
import { analyzeOtaMetadata, commitOtaActivationTransaction, createOtaMetadataBackup, otaDeviceBinding, planOtaActivation, planOtaMetadataRestore, qualifiesUnknownSignerTrust, readOtaMetadataBackup } from './otaManagement.js';
import { compareSecureBootTrust, parseEsp32S3ImageBoundary } from './upstream/flasher/secureBoot.js';
import { parseAppDescriptor } from './upstream/flasher/appDescriptor.js';
import { captureBootLogs } from './upstream/flasher/serialLog.js';
import { buildOtadataSector } from './upstream/flasher/otadata.js';
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

async function withOtaDevice<T>(options: DeviceOptions, body: (transport: any, inspection: any) => Promise<T>, deferResetAfterSuccess: () => boolean = () => false): Promise<T> {
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
    const deferReset = deferResetAfterSuccess();
    options.progress?.stage(deferReset ? 'Releasing ROM connection for captured normal-boot reset' : 'Returning gateway to normal boot');
    try {
      const disconnected = await transport.disconnect(!deferReset);
      const cleanupState = disconnected.normalBootResetSucceeded === false ? 'failed' : 'complete';
      const cleanupDetail = disconnected.normalBootResetSucceeded === true ? 'normal-boot reset requested; serial connection released'
        : disconnected.normalBootResetSucceeded === false ? 'normal-boot reset was unavailable'
          : deferReset ? 'ROM serial connection released; reset will start after boot-log receiver is ready' : 'serial connection released; reset was not required';
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

type ActivationEvidence = { sourceImage: Uint8Array; sourceSha256: string; sourceMd5: string; sourceBoundary: ReturnType<typeof parseEsp32S3ImageBoundary>;
  descriptor: NonNullable<ReturnType<typeof parseAppDescriptor>>; mode: OtaStatusVerificationMode };

async function loadActivationEvidence(options: DeviceOptions & { verificationMode?: OtaStatusVerificationMode }): Promise<ActivationEvidence> {
  options.progress?.stage('Retrieving and verifying approved WeatherXM firmware');
  const selected = await loadSelectedFirmware('weatherxm', DEFAULT_MANIFEST_URL, {
    progress: (event) => options.progress?.event(event), offline: options.offline, cacheDirectory: options.cacheDirectory,
  });
  const sourceImage = selected.verified.data;
  const sourceSha256 = createHash('sha256').update(sourceImage).digest('hex');
  const sourceBoundary = parseEsp32S3ImageBoundary(sourceImage);
  const descriptor = parseAppDescriptor(sourceImage.subarray(0, 4096));
  if (selected.entry.version.replace(/^v/i, '') !== '0.8.34' || selected.entry.sha256.toLowerCase() !== STAGE_ONLY_WXM_0834_SHA256 ||
      sourceSha256 !== STAGE_ONLY_WXM_0834_SHA256 || sourceBoundary.status !== 'valid-signature' || !sourceBoundary.imageEvidence?.signatureValid ||
      !descriptor || sourceBoundary.imageLength !== sourceImage.byteLength || selected.entry.bytes !== sourceImage.byteLength) {
    throw new Error('Activation blocked: authenticated source is not the pinned, structurally valid WeatherXM 0.8.34 signed image');
  }
  options.progress?.finish('complete', 'pinned official SHA-256 and Secure Boot V2 image signature verified');
  return { sourceImage, sourceSha256, sourceMd5: createHash('md5').update(sourceImage).digest('hex'), sourceBoundary, descriptor: descriptor!,
    mode: options.verificationMode ?? 'fast' };
}

async function inspectActivationEvidence(transport: any, inspection: any, options: DeviceOptions & { target: 'ota_0' | 'ota_1'; metadataBackupManifest?: string }, evidence: ActivationEvidence) {
  const raw = await readPartition(transport, WG1200_CONSTANTS.OTADATA.offset, WG1200_CONSTANTS.OTADATA.size, 'Reading OTA metadata', options.progress, options.signal);
  const analysis = analyzeOtaMetadata(raw, { factoryPresent: true });
  if (analysis.sectors.some((sector) => sector.state !== 'ERASED' && !sector.crcValid)) {
    throw new Error('Activation blocked: an OTA metadata sector has a corrupt sequence CRC; metadata is unchanged');
  }
  let backupVerified = false;
  if (options.metadataBackupManifest && inspection.secureCert?.sha256) {
    options.progress?.stage('Validating fresh device-bound metadata backup');
    await (await import('./otaManagement.js')).validateOtaMetadataBackup(options.metadataBackupManifest, {
      bytes: raw, deviceBinding: otaDeviceBinding(inspection.macAddress, inspection.secureCert.sha256) });
    backupVerified = true;
    options.progress?.finish('complete', 'backup identity binding, SHA-256, and exact live metadata match');
  }
  const security = await transport.readSecureBootConfiguration();
  const trust = compareSecureBootTrust(evidence.sourceBoundary.imageEvidence!, security);
  if (trust.result === 'UNTRUSTED' || trust.result === 'REVOKED' || trust.result === 'INCOMPATIBLE') {
    throw new Error(`Activation blocked: explicit device Secure Boot result is ${trust.result} (${trust.securityVersionStatus})`);
  }
  if (security.secureBootV2.status === 'verified' && security.secureBootV2.state !== 'enabled') {
    throw new Error('Activation blocked: Secure Boot V2 is explicitly disabled on the device');
  }
  if (security.secureVersion.value !== null && evidence.descriptor.secureVersion < security.secureVersion.value) {
    throw new Error('Activation blocked: approved application security version is below the readable device eFuse floor');
  }
  const targetPart = options.target === 'ota_0' ? WG1200_CONSTANTS.APP_OTA_0 : WG1200_CONSTANTS.APP_OTA_1;
  const recoverySlot = options.target === 'ota_0' ? 'ota_1' : 'ota_0';
  const recoveryPart = recoverySlot === 'ota_0' ? WG1200_CONSTANTS.APP_OTA_0 : WG1200_CONSTANTS.APP_OTA_1;
  let targetImage: Uint8Array | null = null; let recoveryImage: Uint8Array | null = null;
  let targetHeader: Uint8Array; let recoveryHeader: Uint8Array;
  if (evidence.mode === 'thorough') {
    targetImage = await readPartition(transport, targetPart.offset, targetPart.size, `Inspecting complete ${options.target} firmware`, options.progress, options.signal);
    recoveryImage = await readPartition(transport, recoveryPart.offset, recoveryPart.size, `Inspecting complete ${recoverySlot} recovery firmware`, options.progress, options.signal);
    targetHeader = targetImage.subarray(0, 4096); recoveryHeader = recoveryImage.subarray(0, 4096);
  } else {
    targetHeader = await readPartition(transport, targetPart.offset, 4096, `Reading ${options.target} application header`, options.progress, options.signal);
    recoveryHeader = await readPartition(transport, recoveryPart.offset, 4096, `Reading ${recoverySlot} recovery header`, options.progress, options.signal);
  }
  const expectedHeader = evidence.sourceImage.subarray(0, 4096);
  if (!Buffer.from(targetHeader).equals(Buffer.from(expectedHeader)) || !parseAppDescriptor(targetHeader)) {
    throw new Error(`Activation blocked: ${options.target} header or descriptor differs from the authenticated source`);
  }
  if (!Buffer.from(recoveryHeader).equals(Buffer.from(expectedHeader)) || !parseAppDescriptor(recoveryHeader)) {
    throw new Error(`Activation blocked: ${recoverySlot} recovery header or descriptor differs from the authenticated source`);
  }
  options.progress?.stage(`Checking ${options.target} on-chip MD5`);
  const targetMd5 = await transport.md5FlashRegion(targetPart.offset, evidence.sourceImage.byteLength);
  options.progress?.finish(targetMd5 === evidence.sourceMd5 ? 'complete' : 'failed', targetMd5 === evidence.sourceMd5 ? 'approved image range matches' : 'approved image range mismatch');
  options.progress?.stage(`Checking ${recoverySlot} recovery on-chip MD5`);
  const recoveryMd5 = await transport.md5FlashRegion(recoveryPart.offset, evidence.sourceImage.byteLength);
  options.progress?.finish(recoveryMd5 === evidence.sourceMd5 ? 'complete' : 'failed', recoveryMd5 === evidence.sourceMd5 ? 'approved recovery image range matches' : 'recovery image mismatch');
  const targetMd5Matches = targetMd5 === evidence.sourceMd5;
  const recoveryMd5Matches = recoveryMd5 === evidence.sourceMd5;
  if (!targetMd5Matches) throw new Error(`Activation blocked: ${options.target} on-chip MD5 does not match the authenticated source; metadata is unchanged`);
  if (!recoveryMd5Matches) throw new Error(`Activation blocked: selected recovery slot ${recoverySlot} does not match the authenticated approved image; metadata is unchanged`);
  let physicalSha256: string | null = null;
  if (evidence.mode === 'thorough' && targetImage) {
    const boundary = parseEsp32S3ImageBoundary(targetImage);
    if (boundary.status !== 'valid-signature' || boundary.imageLength !== evidence.sourceImage.byteLength) throw new Error(`Activation blocked: physical target signature/structure check is ${boundary.status}`);
    physicalSha256 = hashImage(targetImage, boundary.imageLength, `Calculating ${options.target} physical SHA-256`, options.progress);
    if (physicalSha256 !== evidence.sourceSha256) throw new Error('Activation blocked: thorough physical SHA-256 differs from authenticated source');
    const recoveryBoundary = parseEsp32S3ImageBoundary(recoveryImage!);
    if (recoveryBoundary.status !== 'valid-signature' || recoveryBoundary.imageLength !== evidence.sourceImage.byteLength) throw new Error('Activation blocked: thorough recovery image signature/structure check failed');
    const recoverySha = hashImage(recoveryImage!, recoveryBoundary.imageLength, `Calculating ${recoverySlot} physical SHA-256`, options.progress);
    if (recoverySha !== evidence.sourceSha256) throw new Error('Activation blocked: thorough recovery SHA-256 differs from authenticated source');
  }
  const unknownTrustQualified = qualifiesUnknownSignerTrust({ signerTrust: trust.result, sourceSha256Verified: true,
    sourceSignatureVerified: evidence.sourceBoundary.imageEvidence!.signatureValid, targetMd5Matches, recoveryMd5Matches,
    selectedByMetadata: analysis.selectedByMetadata, recoverySlot, metadataBackupVerified: backupVerified });
  const plan = planOtaActivation({ analysis, target: options.target, actualRunningSlot: null,
    targetImageValid: evidence.sourceBoundary.status === 'valid-signature', otherImageValid: recoveryMd5Matches,
    targetImageSha256: physicalSha256, expectedTargetSha256: evidence.sourceSha256, targetDigestMatches: targetMd5Matches,
    targetSignatureTrusted: trust.result === 'TRUSTED', allowUnknownSignerTrust: unknownTrustQualified,
    metadataBackupVerified: backupVerified,
    verification: { mode: evidence.mode, sourceSha256Verified: true, sourceSignatureVerified: true,
      targetOnChipMd5: targetMd5Matches ? 'match' : 'mismatch', recoveryOnChipMd5: recoveryMd5Matches ? 'match' : 'mismatch',
      signerTrust: trust.result, unknownTrustQualified },
    rollbackConfig: 'unknown', antiRollbackConfig: 'unknown' });
  return { raw, analysis, backupVerified, security, trust, plan, descriptor: evidence.descriptor, physicalSha256,
    targetMd5, recoveryMd5, recoverySlot };
}

async function resetNormalBootWithReceiver(port: NodeSerialPort, progress?: ProgressReporter): Promise<void> {
  const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  progress?.stage('Resetting ESP32-S3 into normal boot');
  await port.setSignals({ dataTerminalReady: false, requestToSend: false });
  progress?.finish('complete', 'reset lines released');
  await wait(50);
  progress?.stage('Asserting ESP32-S3 reset');
  await port.setSignals({ dataTerminalReady: false, requestToSend: true });
  progress?.finish('complete', 'EN asserted through RTS; GPIO0 released through DTR');
  await wait(120);
  progress?.stage('Releasing ESP32-S3 reset');
  await port.setSignals({ dataTerminalReady: false, requestToSend: false });
  progress?.finish('complete', 'EN released; serial boot capture already listening');
}

async function captureOtaBoot(portPath: string, expected: { slotOffset: number; firmwareVersion: string }, seconds: number,
  progress: ProgressReporter | undefined) {
  const lifecycle = (stage: string, state: 'start' | 'complete' | 'failed', detail?: string) => {
    if (state === 'start') progress?.log(`${stage}...`);
    else progress?.log(`${stage} ${state === 'complete' ? 'DONE' : 'FAILED'}${detail ? ` — ${detail}` : ''}`);
  };
  // The flash-protocol transport must release its stream reader before the
  // UART monitor can own the receive stream. The descriptor is reopened with
  // HUPCL disabled so closing it cannot implicitly pulse the board reset.
  const port = new NodeSerialPort(portPath, undefined, undefined, true, lifecycle);
  progress?.stage('Preparing serial boot monitor');
  try {
    const boot = await captureBootLogs(port, seconds * 1000, (line) => progress?.log(line), expected,
      async () => { await resetNormalBootWithReceiver(port, progress); },
      () => {
        progress?.stage(`Capturing live boot output (${seconds} seconds)`);
        progress?.log('--- WG1200 BOOT LOG ---');
        progress?.suspend();
      });
    progress?.resume();
    progress?.finish(boot.captureError ? 'failed' : 'complete', boot.captureError ?? `captured ${seconds} seconds after reset release`);
    progress?.log('--- BOOT CAPTURE COMPLETE ---');
    return boot;
  } catch (error) {
    progress?.resume();
    progress?.finish('failed', error instanceof Error ? error.message : String(error));
    throw error;
  }
}

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
      activation: { functionality: 'implemented', allowed: null,
        inspectionLimitations: ['ROM inspection does not observe the application currently running; post-activation boot capture checks the loaded offset.'],
        preflightRequirements: ['Fresh device-bound exact metadata backup', 'Pinned official signed source image', 'Target and selected recovery range on-chip MD5 match', 'Explicit transaction confirmation'],
        confirmedBlockers: [], unknowns: ['Actual running slot before reset', 'Installed bootloader rollback behavior', 'Anti-rollback enforcement unless established from device evidence'],
        note: 'Availability is determined by ota activate preflight; status does not claim a target is currently activatable.' } };
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

export async function dryRunOtaActivation(options: DeviceOptions & { target: 'ota_0' | 'ota_1'; metadataBackupManifest?: string; verificationMode?: OtaStatusVerificationMode }) {
  const evidence = await loadActivationEvidence(options);
  return withOtaDevice(options, async (transport, inspection) => {
    const result = await inspectActivationEvidence(transport, inspection, options, evidence);
    return { ...result.plan, evidence: { sourceSha256: evidence.sourceSha256, sourceSha256Verified: true,
      sourceSignature: 'VERIFIED', physicalTargetSha256: result.physicalSha256,
      targetOnChipMd5: result.targetMd5, recoveryOnChipMd5: result.recoveryMd5,
      deviceSignerTrust: result.trust.result, unknownTrustQualified: result.plan.verification?.unknownTrustQualified,
      selectedRecoverySlot: result.recoverySlot, metadataBackupVerified: result.backupVerified } };
  });
}

const WG1200_0834_SHA256 = 'bb5af75dfe1b5df7d973110d834c8b7c26af983acc0ff2728900b3ca88dc19eb';

/** Performs a confirmed one-sector activation through the ESP32 ROM/stub transport. Never called by tests on physical hardware. */
export async function activateOtaSlot(options: DeviceOptions & { target: 'ota_0' | 'ota_1'; metadataBackupManifest: string;
  confirm: (plan: ReturnType<typeof planOtaActivation>) => Promise<boolean>; bootLogSeconds?: number; verificationMode?: OtaStatusVerificationMode }) {
  const evidence = await loadActivationEvidence(options);
  let captureResetAfterOpen = false;
  const transaction = await withOtaDevice(options, async (transport, inspection) => {
    if (!inspection.secureCert?.sha256) throw new Error('Activation requires a verified Secure Certificate identity');
    const prepared = await inspectActivationEvidence(transport, inspection, options, evidence);
    const raw = prepared.raw;
    if (prepared.analysis.ambiguous || !prepared.analysis.selectedByMetadata || prepared.analysis.selectedSector === null || prepared.analysis.selectedSequence === null) {
      throw new Error('Activation blocked: OTA metadata has no unambiguous selectable record');
    }
    const plan = prepared.plan;
    if (plan.blockers.length) throw new Error(`Activation blocked: ${plan.blockers.join(' ')}`);
    options.progress?.log(`OTA ACTIVATION PLAN\nCurrent slot (metadata): ${prepared.analysis.selectedByMetadata}\nTarget slot: ${options.target}\nCurrent sequence: ${prepared.analysis.selectedSequence}\nProposed sequence: ${plan.proposedUpdate.sequence}\nTarget metadata sector address: 0x${plan.proposedUpdate.sectorAddress!.toString(16)}\nWrite length: 4096 bytes\nSource firmware SHA-256: VERIFIED\nSource Secure Boot signature: VERIFIED\nTarget on-chip MD5: MATCH\nRecovery on-chip MD5: MATCH\nDevice signer trust: ${prepared.trust.result}${plan.verification?.unknownTrustQualified ? ' (UNKNOWN qualified by same selected-device recovery image evidence)' : ''}\nTarget full physical SHA-256: ${prepared.physicalSha256 ? 'VERIFIED' : 'not calculated in FAST mode'}\nMetadata backup: VERIFIED\nApplication partitions, NVS, factory, bootloader, and partition table: UNCHANGED`);
    const destinationAddress = plan.proposedUpdate.sectorAddress!;
    const committed = await commitOtaActivationTransaction({ before: raw, plan, transport, confirm: () => options.confirm(plan), signal: options.signal,
      onConfirmationAccepted: () => options.progress?.stage('Revalidating OTA metadata after confirmation'),
      onWriteStart: () => options.progress?.stage(`Writing OTA metadata sector at 0x${destinationAddress.toString(16)}`, 4096) });
    captureResetAfterOpen = true;
    options.progress?.bytes(4096, 4096);
    options.progress?.finish('complete', 'exact 4096-byte inactive metadata sector independently read back');
    return { target: options.target, address: committed.address, sequence: committed.sequence, metadata: committed.metadata, firmwareVersion: prepared.descriptor.version,
      verificationMode: evidence.mode, sourceSha256: evidence.sourceSha256, sourceSignatureVerified: true, physicalSha256: prepared.physicalSha256,
      targetOnChipMd5: prepared.targetMd5, recoveryOnChipMd5: prepared.recoveryMd5, signerTrust: prepared.trust.result,
      unknownTrustQualified: plan.verification?.unknownTrustQualified };
  }, () => captureResetAfterOpen);
  const boot = await captureOtaBoot(options.portPath, {
    slotOffset: options.target === 'ota_0' ? WG1200_CONSTANTS.APP_OTA_0.offset : WG1200_CONSTANTS.APP_OTA_1.offset,
    firmwareVersion: transaction.firmwareVersion }, options.bootLogSeconds ?? 15, options.progress);
  const bootVerified = boot.expectedSlotObserved === true && boot.secureBootVerified;
  const applicationVerified = boot.applicationStarted && boot.expectedFirmwareObserved === true && !boot.bootFailureObserved;
  const bootValidationFailed = boot.bootFailureObserved || boot.expectedSlotObserved === false || boot.expectedFirmwareObserved === false;
  return { outcome: bootVerified && applicationVerified && !boot.captureError ? 'OTA ACTIVATION COMPLETE'
    : bootValidationFailed ? 'OTA METADATA UPDATED; BOOT VALIDATION FAILED' : 'OTA METADATA UPDATED; BOOT UNVERIFIED', metadataUpdated: true,
    bootSelectionVerified: boot.expectedSlotObserved === true, applicationStarted: boot.applicationStarted,
    bootValidationFailed, applicationHealth: 'unverified', transaction, boot: { secureBootVerified: boot.secureBootVerified,
      bootFailureObserved: boot.bootFailureObserved, bootFailureLines: boot.bootFailureLines, bootVersion: boot.bootVersion,
      expectedFirmwareObserved: boot.expectedFirmwareObserved, applicationVerified, health: boot.health, captureError: boot.captureError ?? null, lines: boot.lines } };
}

export async function restoreOtaMetadata(options: DeviceOptions & { metadataBackupManifest: string;
  confirm: (plan: ReturnType<typeof planOtaMetadataRestore>) => Promise<boolean>; bootLogSeconds?: number }) {
  let captureResetAfterOpen = false;
  const transaction = await withOtaDevice(options, async (transport, inspection) => {
    if (!inspection.secureCert?.sha256) throw new Error('Emergency metadata recovery requires a verified Secure Certificate identity');
    const binding = otaDeviceBinding(inspection.macAddress, inspection.secureCert.sha256);
    options.progress?.stage('Validating device-bound emergency metadata backup');
    const backup = await readOtaMetadataBackup(options.metadataBackupManifest, binding);
    const backupAnalysis = analyzeOtaMetadata(backup.bytes, { factoryPresent: true });
    const live = await readPartition(transport, WG1200_CONSTANTS.OTADATA.offset, WG1200_CONSTANTS.OTADATA.size, 'Reading live OTA metadata for recovery', options.progress, options.signal);
    const liveAnalysis = analyzeOtaMetadata(live, { factoryPresent: true });
    options.progress?.finish('complete', 'backup SHA-256, identity binding, and both metadata sectors validated');
    const target = backupAnalysis.selectedByMetadata;
    if (target !== 'ota_0' && target !== 'ota_1') throw new Error('Emergency recovery blocked: backup does not select an OTA application slot');
    const security = await transport.readSecureBootConfiguration();
    const part = target === 'ota_0' ? WG1200_CONSTANTS.APP_OTA_0 : WG1200_CONSTANTS.APP_OTA_1;
    const image = await readPartition(transport, part.offset, part.size, `Verifying recovery application ${target}`, options.progress, options.signal);
    const boundary = parseEsp32S3ImageBoundary(image);
    const digest = boundary.imageLength ? hashImage(image, boundary.imageLength, 'Hashing recovery application', options.progress) : null;
    const trusted = boundary.imageEvidence ? compareSecureBootTrust(boundary.imageEvidence, security).result === 'TRUSTED' : false;
    const descriptor = parseAppDescriptor(image.subarray(0, 4096));
    const imageValid = boundary.status === 'valid-signature' && digest === WG1200_0834_SHA256 && trusted && Boolean(descriptor) &&
      (security.secureVersion.value === null || descriptor!.secureVersion >= security.secureVersion.value);
    const plan = planOtaMetadataRestore(liveAnalysis, backupAnalysis, imageValid);
    if (plan.blockers.length) throw new Error(`Emergency metadata recovery blocked: ${plan.blockers.join(' ')}`);
    options.progress?.log(`EMERGENCY OTA METADATA RECOVERY PLAN\nBackup recovery slot: ${target}\nProposed sequence: ${plan.sequence}\nTarget metadata sector: 0x${plan.sectorAddress!.toString(16)}\nWrite length: 4096 bytes\nRecovery image: VERIFIED\nStrategy: write one new VALID selection record first; preserve the peer sector. Application partitions and all other flash ranges remain unchanged.`);
    if (!(await options.confirm(plan))) throw new Error('Emergency OTA recovery cancelled before metadata write; flash is unchanged');
    const latest = await transport.readOtadataSnapshot();
    if (!latest.every((byte: number, index: number) => byte === live[index])) throw new Error('OTA metadata changed after recovery confirmation; refusing write');
    const sector = plan.sectorAddress === WG1200_CONSTANTS.OTADATA.offset ? 0 : 1;
    const payload = buildOtadataSector(plan.sequence!);
    options.progress?.stage(`Writing emergency OTA metadata record at 0x${plan.sectorAddress!.toString(16)}`, 4096);
    await transport.writeOtaRecoverySector(plan.sectorAddress!, payload, plan.sequence!, live);
    options.progress?.bytes(4096, 4096); options.progress?.finish('complete', 'one recovery record independently read back; peer sector preserved');
    const after = analyzeOtaMetadata(await transport.readOtadataSnapshot(), { factoryPresent: true });
    if (after.selectedByMetadata !== target || after.selectedSequence !== plan.sequence) throw new Error('Emergency recovery readback did not select the backed-up recovery slot');
    captureResetAfterOpen = true;
    return { target, sequence: plan.sequence, address: WG1200_CONSTANTS.OTADATA.offset + sector * 4096, metadata: after, firmwareVersion: descriptor!.version };
  }, () => captureResetAfterOpen);
  const boot = await captureOtaBoot(options.portPath, {
    slotOffset: transaction.target === 'ota_0' ? WG1200_CONSTANTS.APP_OTA_0.offset : WG1200_CONSTANTS.APP_OTA_1.offset,
    firmwareVersion: transaction.firmwareVersion }, options.bootLogSeconds ?? 15, options.progress);
  const bootValidationFailed = boot.bootFailureObserved || boot.expectedSlotObserved === false || boot.expectedFirmwareObserved === false;
  return { outcome: boot.expectedSlotObserved && boot.secureBootVerified && boot.applicationStarted && !boot.bootFailureObserved
    ? 'OTA METADATA RECOVERY COMPLETE' : bootValidationFailed ? 'OTA METADATA UPDATED; BOOT VALIDATION FAILED' : 'OTA METADATA UPDATED; BOOT UNVERIFIED', metadataUpdated: true,
    bootValidationFailed,
    bootSelectionVerified: boot.expectedSlotObserved === true, applicationStarted: boot.applicationStarted, applicationHealth: 'unverified', transaction,
    boot: { secureBootVerified: boot.secureBootVerified, bootFailureObserved: boot.bootFailureObserved, bootFailureLines: boot.bootFailureLines,
      bootVersion: boot.bootVersion, expectedFirmwareObserved: boot.expectedFirmwareObserved, health: boot.health, captureError: boot.captureError ?? null, lines: boot.lines } };
}
