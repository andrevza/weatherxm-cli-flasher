import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';
import { link, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { WG1200_CONSTANTS } from './upstream/flasher/constants.js';
import { buildTransactionalOtadataSector, calculateOtaSeqCrc32, ESP_OTA_IMG_ABORTED, ESP_OTA_IMG_INVALID, ESP_OTA_IMG_NEW, ESP_OTA_IMG_PENDING_VERIFY, ESP_OTA_IMG_UNDEFINED, ESP_OTA_IMG_VALID } from './upstream/flasher/otadata.js';
import { getEmbeddedBuildInfo } from './buildInfo.js';
import type { ProgressReporter } from './progress.js';

export interface OtaSectorDiagnostic {
  index: 0 | 1;
  address: number;
  sequence: number | null;
  stateCode: number | null;
  state: 'NEW' | 'PENDING_VERIFY' | 'VALID' | 'INVALID' | 'ABORTED' | 'UNDEFINED' | 'UNKNOWN' | 'ERASED';
  storedCrc32: string | null;
  expectedCrc32: string | null;
  crcValid: boolean;
  selectionEligibleByIdf512: boolean;
  first32BytesHex: string;
}

export interface OtaMetadataAnalysis {
  partition: { offset: number; length: number; sectorSize: number };
  sectors: [OtaSectorDiagnostic, OtaSectorDiagnostic];
  selectedSector: 0 | 1 | null;
  selectedSequence: number | null;
  selectedByMetadata: 'ota_0' | 'ota_1' | 'factory' | null;
  expectedNextPartition: 'ota_0' | 'ota_1' | 'factory' | null;
  ambiguous: boolean;
  selectionModel: 'ESP-IDF 5.1.2 source model';
  caveat: string;
}

const sectorState = (value: number): OtaSectorDiagnostic['state'] => value === ESP_OTA_IMG_NEW ? 'NEW'
  : value === ESP_OTA_IMG_PENDING_VERIFY ? 'PENDING_VERIFY' : value === ESP_OTA_IMG_VALID ? 'VALID'
    : value === ESP_OTA_IMG_INVALID ? 'INVALID' : value === ESP_OTA_IMG_ABORTED ? 'ABORTED'
      : value === ESP_OTA_IMG_UNDEFINED ? 'UNDEFINED' : 'UNKNOWN';

function diagnosticSector(bytes: Uint8Array, index: 0 | 1): OtaSectorDiagnostic {
  const address = WG1200_CONSTANTS.OTADATA.offset + index * 4096;
  const prefix = bytes.subarray(index * 4096, index * 4096 + 32);
  if (prefix.length !== 32) throw new Error('OTA metadata must contain exactly two complete 4 KiB sectors');
  const view = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength);
  const sequence = view.getUint32(0, true);
  const stateCode = view.getUint32(24, true);
  const stored = view.getUint32(28, true);
  const erased = sequence === 0xffffffff;
  const expected = erased ? 0xffffffff : calculateOtaSeqCrc32(sequence);
  const crcValid = stored === expected;
  const state = erased ? 'ERASED' : sectorState(stateCode);
  // IDF 5.1.2 rejects only erased sequence, invalid/aborted state, or bad CRC here.
  const selectionEligibleByIdf512 = !erased && crcValid && stateCode !== ESP_OTA_IMG_INVALID && stateCode !== ESP_OTA_IMG_ABORTED;
  return { index, address, sequence: erased ? null : sequence, stateCode: erased ? null : stateCode, state,
    storedCrc32: erased ? null : `0x${stored.toString(16).padStart(8, '0')}`,
    expectedCrc32: erased ? null : `0x${expected.toString(16).padStart(8, '0')}`,
    crcValid, selectionEligibleByIdf512, first32BytesHex: Buffer.from(prefix).toString('hex') };
}

/** Interprets the two-sector IDF otadata record without asserting the installed bootloader matches IDF. */
export function analyzeOtaMetadata(bytes: Uint8Array, options: { factoryPresent: boolean; otaAppCount?: number }): OtaMetadataAnalysis {
  if (bytes.byteLength !== WG1200_CONSTANTS.OTADATA.size) throw new Error('OTA metadata snapshot must be exactly 8192 bytes');
  const otaAppCount = options.otaAppCount ?? 2;
  if (!Number.isInteger(otaAppCount) || otaAppCount < 1) throw new Error('OTA application partition count is invalid');
  const sectors: [OtaSectorDiagnostic, OtaSectorDiagnostic] = [diagnosticSector(bytes, 0), diagnosticSector(bytes, 1)];
  const eligible = sectors.filter((entry) => entry.selectionEligibleByIdf512);
  let selected = eligible.length === 0 ? null : eligible.length === 1 ? eligible[0]!
    : eligible[0]!.sequence! >= eligible[1]!.sequence! ? eligible[0]! : eligible[1]!;
  let selectedByMetadata: OtaMetadataAnalysis['selectedByMetadata'];
  let expectedNextPartition: OtaMetadataAnalysis['expectedNextPartition'];
  if (!selected) {
    selectedByMetadata = options.factoryPresent ? 'factory' : 'ota_0';
    expectedNextPartition = selectedByMetadata;
  } else {
    const sequenceMinusOne = (selected.sequence! - 1) >>> 0;
    const slot = sequenceMinusOne % otaAppCount;
    selectedByMetadata = slot === 0 ? 'ota_0' : slot === 1 ? 'ota_1' : null;
    expectedNextPartition = selectedByMetadata;
  }
  return { partition: { offset: WG1200_CONSTANTS.OTADATA.offset, length: WG1200_CONSTANTS.OTADATA.size, sectorSize: 4096 }, sectors,
    selectedSector: selected?.index ?? null, selectedSequence: selected?.sequence ?? null, selectedByMetadata, expectedNextPartition,
    ambiguous: eligible.length === 0 && !(sectors.every((entry) => entry.state === 'ERASED')),
    selectionModel: 'ESP-IDF 5.1.2 source model',
    caveat: 'Metadata predicts selection only. Installed bootloader identity/configuration, app fallback behavior, rollback configuration, and the application actually running are not inferred from this calculation.' };
}

export interface OtaMetadataBackupManifest {
  format: 'wg1200-ota-metadata-backup-v1';
  createdAt: string;
  partition: { label: 'otadata'; offset: number; length: number };
  backupFile: string;
  bytes: number;
  sha256: string;
  deviceBinding: { macAddressSha256: string; secureCertificateSha256: string };
  independentReadbackVerified: true;
  tool: { version: string; gitCommit: string | null; sourceSha256: string | null };
}

export function otaDeviceBinding(macAddress: string | undefined, secureCertificateSha256: string): OtaMetadataBackupManifest['deviceBinding'] {
  if (!macAddress || !/^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/i.test(macAddress) || !/^[a-f0-9]{64}$/i.test(secureCertificateSha256)) {
    throw new Error('OTA metadata backup requires a verified device MAC and Secure Certificate SHA-256 identity');
  }
  return { macAddressSha256: createHash('sha256').update(macAddress.toLowerCase()).digest('hex'), secureCertificateSha256: secureCertificateSha256.toLowerCase() };
}

export async function createOtaMetadataBackup(input: {
  outputPath: string; deviceBinding: OtaMetadataBackupManifest['deviceBinding'];
  readChunks: AsyncIterable<Uint8Array>; hashLivePartition: () => Promise<string>; signal?: AbortSignal; progress?: ProgressReporter;
}): Promise<OtaMetadataBackupManifest> {
  const outputPath = resolve(input.outputPath); const manifestPath = `${outputPath}.manifest.json`;
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
  const tag = `.tmp-${cryptoRandomTag()}`; const tempOutput = `${outputPath}${tag}`; const tempManifest = `${manifestPath}${tag}`;
  let outputLinked = false; let manifestLinked = false;
  try {
    input.progress?.stage('Reading and saving otadata backup', WG1200_CONSTANTS.OTADATA.size);
    const handle = await open(tempOutput, 'wx', 0o600); const hash = createHash('sha256'); let bytes = 0;
    try {
      for await (const chunk of input.readChunks) {
        if (input.signal?.aborted) throw new Error('OTA metadata backup cancelled; temporary files removed');
        hash.update(chunk); bytes += chunk.byteLength; let written = 0;
        while (written < chunk.byteLength) {
          const result = await handle.write(chunk, written, chunk.byteLength - written);
          if (result.bytesWritten <= 0) throw new Error('OTA metadata backup write made no progress');
          written += result.bytesWritten;
        }
      }
      if (bytes !== WG1200_CONSTANTS.OTADATA.size) throw new Error('OTA metadata backup must contain exactly 8192 bytes');
      await handle.sync();
    } finally { await handle.close(); }
    input.progress?.finish('complete', '8192 bytes read and staged to a restrictive temporary file');
    const sha256 = hash.digest('hex');
    input.progress?.stage('Independent flash readback SHA-256', WG1200_CONSTANTS.OTADATA.size);
    const liveSha256 = (await input.hashLivePartition()).toLowerCase();
    input.progress?.finish(liveSha256 === sha256 ? 'complete' : 'failed', liveSha256 === sha256 ? 'physical readback matches' : 'physical readback differs from backup');
    if (liveSha256 !== sha256) throw new Error('OTA metadata backup does not match independent physical readback');
    if (input.signal?.aborted) throw new Error('OTA metadata backup cancelled; temporary files removed');
    const build = getEmbeddedBuildInfo();
    const manifest: OtaMetadataBackupManifest = { format: 'wg1200-ota-metadata-backup-v1', createdAt: new Date().toISOString(),
      partition: { label: 'otadata', offset: WG1200_CONSTANTS.OTADATA.offset, length: WG1200_CONSTANTS.OTADATA.size },
      backupFile: basename(outputPath), bytes, sha256, deviceBinding: input.deviceBinding, independentReadbackVerified: true,
      tool: { version: build.packageVersion, gitCommit: build.gitCommit, sourceSha256: build.sourceSha256 } };
    input.progress?.stage('Saving backup and manifest');
    const manifestHandle = await open(tempManifest, 'wx', 0o600);
    try { await manifestHandle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'); await manifestHandle.sync(); } finally { await manifestHandle.close(); }
    await link(tempOutput, outputPath); outputLinked = true; await link(tempManifest, manifestPath); manifestLinked = true;
    await unlink(tempOutput); await unlink(tempManifest);
    input.progress?.finish('complete', 'backup and manifest saved without overwriting existing files');
    return manifest;
  } catch (error) {
    input.progress?.finish(input.signal?.aborted ? 'cancelled' : 'failed');
    await unlink(tempOutput).catch(() => undefined); await unlink(tempManifest).catch(() => undefined);
    if (manifestLinked) await unlink(manifestPath).catch(() => undefined); if (outputLinked) await unlink(outputPath).catch(() => undefined);
    if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') throw new Error('OTA metadata backup or manifest already exists; refusing to overwrite it');
    throw error;
  }
}

function cryptoRandomTag(): string { return randomUUID(); }

export interface OtaActivationPlan {
  outcome: 'OTA ACTIVATION PLAN'; dryRun: true; target: 'ota_0' | 'ota_1'; selectedByMetadata: OtaMetadataAnalysis['selectedByMetadata'];
  expectedTargetSha256: string | null;
  proposedUpdate: { sectorAddress: number | null; length: 4096; sequence: number | null; sequenceCrc32: string | null; state: 'VALID'; priorSectorPreserved: true };
  writeRanges: Array<{ start: number; end: number }>;
  blockers: string[];
}

/** Derives the one-sector IDF 5.1.2 boot-selection transaction from live metadata. */
export function planOtaActivation(input: { analysis: OtaMetadataAnalysis; target: 'ota_0' | 'ota_1'; actualRunningSlot: string | null;
  targetImageValid: boolean; otherImageValid: boolean; targetImageSha256: string | null; expectedTargetSha256: string | null;
  targetSignatureTrusted: boolean; metadataBackupVerified: boolean; rollbackConfig: 'enabled' | 'disabled' | 'unknown'; antiRollbackConfig: 'enabled' | 'disabled' | 'unknown' }): OtaActivationPlan {
  const blockers: string[] = [];
  if (input.actualRunningSlot === input.target) blockers.push('Requested target is already the observed running slot; no activation plan is needed.');
  if (input.analysis.selectedByMetadata === input.target) blockers.push('Requested target is already selected by OTA metadata; no metadata update is needed.');
  if (!input.analysis.selectedByMetadata || input.analysis.ambiguous) blockers.push('OTA metadata is ambiguous or has no valid selectable record.');
  if (!input.targetImageValid) blockers.push('Target application image validation failed or is unavailable.');
  if (!input.otherImageValid) blockers.push('Other OTA application image validation failed or is unavailable.');
  if (!input.expectedTargetSha256) blockers.push('No exact approved application digest is available for the requested target.');
  else if (!input.targetImageSha256 || input.targetImageSha256.toLowerCase() !== input.expectedTargetSha256.toLowerCase()) blockers.push('Target image digest does not match the approved artifact.');
  if (!input.targetSignatureTrusted) blockers.push('Target Secure Boot signature is not verified as trusted by this device.');
  if (!input.metadataBackupVerified) blockers.push('A fresh exact OTA metadata backup bound to this device is missing or invalid.');
  if (input.rollbackConfig === 'enabled') blockers.push('Rollback is enabled; application confirmation/rollback behavior must be reviewed before activation.');
  if (input.antiRollbackConfig === 'enabled') blockers.push('Anti-rollback is enabled; target security version must be established before activation.');
  const current = input.analysis.sectors[input.analysis.selectedSector ?? 0];
  const targetIndex = input.target === 'ota_0' ? 0 : 1;
  const currentSequence = current?.sequence;
  // IDF 5.1.2 esp_rewrite_ota_data chooses the smallest sequence congruent
  // to (subtype + 1) modulo ota_app_count that is >= the current sequence.
  const sequenceResidue = (targetIndex + 1) % 2;
  const multiplier = currentSequence === null || currentSequence === undefined ? null
    : Math.max(0, Math.ceil((currentSequence - sequenceResidue) / 2));
  const proposedSeq = multiplier === null ? null : (sequenceResidue + multiplier * 2) >>> 0;
  const selectedSector = input.analysis.selectedSector;
  if (currentSequence === 0xffffffff || currentSequence === 0xfffffffe) blockers.push('OTA sequence is at the unsupported wrap boundary.');
  return { outcome: 'OTA ACTIVATION PLAN', dryRun: true, target: input.target, selectedByMetadata: input.analysis.selectedByMetadata,
    expectedTargetSha256: input.expectedTargetSha256,
    proposedUpdate: { sectorAddress: selectedSector === null ? null : input.analysis.partition.offset + (selectedSector === 0 ? 1 : 0) * 4096,
      length: 4096, sequence: proposedSeq, sequenceCrc32: proposedSeq === null ? null : `0x${calculateOtaSeqCrc32(proposedSeq).toString(16).padStart(8, '0')}`,
      state: 'VALID', priorSectorPreserved: true },
    writeRanges: selectedSector === null ? [] : [{ start: input.analysis.partition.offset + (selectedSector === 0 ? 1 : 0) * 4096,
      end: input.analysis.partition.offset + (selectedSector === 0 ? 2 : 1) * 4096 }], blockers };
}

/** Shared one-sector commit path. Its injected transport keeps all write tests deterministic and hardware-free. */
export async function commitOtaActivationTransaction(input: {
  before: Uint8Array; plan: OtaActivationPlan;
  transport: { readOtadataSnapshot(): Promise<Uint8Array>; writeOtaSelectSector(address: number, bytes: Uint8Array, sequence: number, before: Uint8Array): Promise<void> };
  confirm(): Promise<boolean>; signal?: AbortSignal;
}): Promise<{ metadata: OtaMetadataAnalysis; address: number; sequence: number; bytesWritten: 4096 }> {
  if (input.plan.blockers.length) throw new Error(`Activation blocked: ${input.plan.blockers.join(' ')}`);
  const { sectorAddress: address, sequence } = input.plan.proposedUpdate;
  if (address === null || sequence === null ||
      input.plan.writeRanges.length !== 1 || input.plan.writeRanges[0]!.start !== address || input.plan.writeRanges[0]!.end !== address + 4096) {
    throw new Error('Activation plan has an invalid or non-sector write range');
  }
  if (!(await input.confirm())) throw new Error('OTA activation cancelled before metadata write; flash is unchanged');
  if (input.signal?.aborted) throw new Error('OTA activation cancelled before metadata write; flash is unchanged');
  const live = await input.transport.readOtadataSnapshot();
  if (live.byteLength !== input.before.byteLength || !live.every((byte, index) => byte === input.before[index])) {
    throw new Error('OTA metadata changed after confirmation; refusing activation');
  }
  const sectorIndex = address === WG1200_CONSTANTS.OTADATA.offset ? 0 : address === WG1200_CONSTANTS.OTADATA.offset + 4096 ? 1 : -1;
  if (sectorIndex < 0) throw new Error('Activation address is outside the two OTA metadata sectors');
  const payload = buildTransactionalOtadataSector(sequence, sectorIndex as 0 | 1);
  await input.transport.writeOtaSelectSector(address, payload.sectorData, sequence, input.before);
  const metadata = analyzeOtaMetadata(await input.transport.readOtadataSnapshot(), { factoryPresent: true });
  if (metadata.selectedByMetadata !== input.plan.target || metadata.selectedSequence !== sequence) {
    throw new Error('Metadata readback did not select the requested OTA slot and sequence');
  }
  return { metadata, address, sequence, bytesWritten: 4096 };
}

export async function validateOtaMetadataBackup(manifestPath: string, expected: {
  bytes: Uint8Array; deviceBinding: OtaMetadataBackupManifest['deviceBinding'];
}): Promise<{ manifest: OtaMetadataBackupManifest; backupPath: string }> {
  const result = await readOtaMetadataBackup(manifestPath, expected.deviceBinding);
  if (!Buffer.from(result.bytes).equals(Buffer.from(expected.bytes))) throw new Error('OTA metadata backup is corrupt or stale; its exact bytes do not match current otadata');
  return { manifest: result.manifest, backupPath: result.backupPath };
}

/** Verifies backup structure, device binding, file length and SHA-256 without requiring it to match current flash. */
export async function readOtaMetadataBackup(manifestPath: string, deviceBinding: OtaMetadataBackupManifest['deviceBinding']): Promise<{
  manifest: OtaMetadataBackupManifest; backupPath: string; bytes: Uint8Array;
}> {
  let manifest: OtaMetadataBackupManifest;
  try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as OtaMetadataBackupManifest; }
  catch { throw new Error('OTA metadata backup manifest is unreadable or malformed'); }
  if (!manifest || manifest.format !== 'wg1200-ota-metadata-backup-v1' || manifest.partition?.label !== 'otadata' ||
      manifest.partition.offset !== WG1200_CONSTANTS.OTADATA.offset || manifest.partition.length !== WG1200_CONSTANTS.OTADATA.size ||
      manifest.bytes !== WG1200_CONSTANTS.OTADATA.size || manifest.independentReadbackVerified !== true ||
      !/^[a-f0-9]{64}$/i.test(manifest.sha256 ?? '') || basename(manifest.backupFile ?? '') !== manifest.backupFile ||
      JSON.stringify(manifest.deviceBinding) !== JSON.stringify(deviceBinding)) throw new Error('OTA metadata backup manifest does not bind a verified backup to this exact device and partition');
  const backupPath = resolve(dirname(resolve(manifestPath)), manifest.backupFile);
  let bytes: Buffer;
  try { bytes = await readFile(backupPath); } catch { throw new Error('OTA metadata backup data file is missing or unreadable'); }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (bytes.byteLength !== WG1200_CONSTANTS.OTADATA.size || sha256 !== manifest.sha256.toLowerCase()) throw new Error('OTA metadata backup is corrupt or stale (wrong length or SHA-256)');
  return { manifest, backupPath, bytes };
}

/** Plans interruption-aware emergency repair from the slot selected by the device-bound backup. */
export function planOtaMetadataRestore(live: OtaMetadataAnalysis, backup: OtaMetadataAnalysis, recoveryImageValid: boolean): {
  target: 'ota_0' | 'ota_1' | null; sequence: number | null; sectorAddress: number | null; writeLength: 4096;
  method: 'single-sector-valid-record-preserving-peer'; blockers: string[];
} {
  const blockers: string[] = [];
  const target = backup.selectedByMetadata === 'ota_0' || backup.selectedByMetadata === 'ota_1' ? backup.selectedByMetadata : null;
  if (backup.ambiguous || target === null || backup.selectedSequence === null) blockers.push('Backup does not identify an unambiguous OTA recovery application.');
  if (!recoveryImageValid) blockers.push('The recovery application selected by the backup is not currently valid and trusted.');
  const maxSequence = Math.max(-1, ...live.sectors.filter((s) => s.crcValid && s.sequence !== null).map((s) => s.sequence!));
  let sequence: number | null = null;
  let sectorAddress: number | null = null;
  if (target !== null) {
    const residue = (target === 'ota_0' ? 1 : 2);
    sequence = residue;
    while (sequence <= maxSequence && sequence < 0xfffffffd) sequence += 2;
    if (sequence > 0xfffffffd) { sequence = null; blockers.push('OTA sequence is too close to unsigned wrap; recovery requires manual vendor review.'); }
    const writeSector = live.selectedSector === null ? 0 : 1 - live.selectedSector;
    sectorAddress = live.partition.offset + writeSector * live.partition.sectorSize;
  }
  return { target, sequence, sectorAddress, writeLength: 4096, method: 'single-sector-valid-record-preserving-peer', blockers };
}
