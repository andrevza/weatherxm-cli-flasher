import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { link, open, unlink, readFile, mkdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { AppDescriptor } from './upstream/flasher/appDescriptor.js';
import { parseEsp32S3ImageBoundary, type SecureBootImageEvidence } from './upstream/flasher/secureBoot.js';
import { getEmbeddedBuildInfo } from './buildInfo.js';
import type { ProgressReporter } from './progress.js';

export interface InactiveBackupManifest {
  backupFormatVersion: 1;
  createdAt: string;
  chip: { model: string; revision: string | null };
  partition: { label: 'ota_0' | 'ota_1'; offset: number; length: number };
  backupFile: string;
  sha256: string;
  bytes: number;
  descriptor: AppDescriptor | null;
  firmwareVersion: string | null;
  signatureVerification: { status: 'valid' | 'invalid' | 'not-verified' | 'no-signature' | 'unsupported'; imageLength: number | null; explanation: string };
  actualImageLength?: number | null;
  actualImageSha256?: string | null;
  signatureKeyDigests?: string[];
  independentReadbackVerified: boolean;
  tool: { version: string; gitCommit: string | null; sourceSha256: string | null };
}

export interface PartitionBackupManifest {
  format: 'wg1200-partition-backup-v1';
  createdAt: string;
  chip: { model: string; revision: string | null };
  partition: { label: string; offset: number; length: number };
  backupFile: string;
  bytes: number;
  sha256: string;
  sensitive: true;
  independentReadbackVerified: true;
  tool: { version: string; gitCommit: string | null; sourceSha256: string | null };
}

/** Creates a sensitive full-partition dump; data and manifest are finalized atomically and never overwrite. */
export async function createPartitionBackup(input: {
  outputPath: string; label: string; offset: number; length: number;
  chip: { model: string; revision: string | null }; readChunks: AsyncIterable<Uint8Array>;
  hashLivePartition: () => Promise<string>; signal?: AbortSignal; progress?: ProgressReporter;
}): Promise<PartitionBackupManifest> {
  const outputPath = resolve(input.outputPath);
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
  const manifestPath = `${outputPath}.manifest.json`;
  const tag = `.tmp-${randomUUID()}`;
  const tempOutput = `${outputPath}${tag}`;
  const tempManifest = `${manifestPath}${tag}`;
  let outputLinked = false;
  let manifestLinked = false;
  try {
    const handle = await open(tempOutput, 'wx', 0o600);
    const hash = createHash('sha256');
    let bytes = 0;
    try {
      for await (const chunk of input.readChunks) {
        if (input.signal?.aborted) throw new Error('Partition backup cancelled; temporary file removed');
        hash.update(chunk); bytes += chunk.byteLength;
        let cursor = 0;
        while (cursor < chunk.byteLength) {
          const result = await handle.write(chunk, cursor, chunk.byteLength - cursor);
          if (result.bytesWritten <= 0) throw new Error('partition backup write made no progress');
          cursor += result.bytesWritten;
        }
      }
      if (input.signal?.aborted) throw new Error('Partition backup cancelled; temporary file removed');
      if (bytes !== input.length) throw new Error(`partition backup length ${bytes} does not match expected ${input.length}`);
      await handle.sync();
    } finally { await handle.close(); }
    const sha256 = hash.digest('hex');
    if ((await input.hashLivePartition()).toLowerCase() !== sha256) throw new Error('partition backup SHA-256 does not match independent second flash-read SHA-256');
    if (input.signal?.aborted) throw new Error('Partition backup cancelled; temporary file removed');
    const build = getEmbeddedBuildInfo();
    const manifest: PartitionBackupManifest = { format: 'wg1200-partition-backup-v1', createdAt: new Date().toISOString(), chip: input.chip,
      partition: { label: input.label, offset: input.offset, length: input.length }, backupFile: basename(outputPath), bytes, sha256,
      sensitive: true, independentReadbackVerified: true,
      tool: { version: build.packageVersion, gitCommit: build.gitCommit, sourceSha256: build.sourceSha256 } };
    input.progress?.stage('Saving backup and manifest');
    const mh = await open(tempManifest, 'wx', 0o600);
    try { await mh.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'); await mh.sync(); } finally { await mh.close(); }
    await link(tempOutput, outputPath); outputLinked = true;
    await link(tempManifest, manifestPath); manifestLinked = true;
    await unlink(tempOutput); await unlink(tempManifest);
    input.progress?.finish('complete', 'backup and manifest saved');
    return manifest;
  } catch (error) {
    input.progress?.finish(input.signal?.aborted ? 'cancelled' : 'failed');
    await unlink(tempOutput).catch(() => undefined); await unlink(tempManifest).catch(() => undefined);
    if (manifestLinked) await unlink(manifestPath).catch(() => undefined);
    if (outputLinked) await unlink(outputPath).catch(() => undefined);
    if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') throw new Error('Partition backup output or manifest already exists; refusing to overwrite it');
    throw error;
  }
}

export async function hashFileDigests(path: string): Promise<{ sha256: string; md5: string; bytes: number }> {
  const sha256 = createHash('sha256');
  const md5 = createHash('md5');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    const data = chunk as Buffer;
    sha256.update(data);
    md5.update(data);
    bytes += data.byteLength;
  }
  return { sha256: sha256.digest('hex'), md5: md5.digest('hex'), bytes };
}
export async function hashFileSha256(path: string): Promise<{ sha256: string; bytes: number }> {
  const { sha256, bytes } = await hashFileDigests(path);
  return { sha256, bytes };
}

export async function validateInactiveBackup(manifestPath: string, expected: { label: 'ota_0' | 'ota_1'; offset: number; length: number }): Promise<{ manifest: InactiveBackupManifest; backupPath: string; backupMd5: string }> {
  let raw: unknown;
  try { raw = JSON.parse(await readFile(manifestPath, 'utf8')); }
  catch { throw new Error('STAGING BLOCKED — BACKUP INVALID: backup manifest is unreadable or malformed'); }
  const value = raw as Partial<InactiveBackupManifest> | null;
  if (!value || value.backupFormatVersion !== 1 || !value.partition || !value.chip || !value.tool ||
      value.partition.label !== expected.label || value.partition.offset !== expected.offset || value.partition.length !== expected.length ||
      value.bytes !== expected.length || !/^[a-f0-9]{64}$/i.test(value.sha256 ?? '') ||
      value.independentReadbackVerified !== true || !value.backupFile || basename(value.backupFile) !== value.backupFile ||
      !value.signatureVerification || !['valid', 'invalid', 'not-verified', 'no-signature', 'unsupported'].includes(value.signatureVerification.status) ||
      typeof value.chip.model !== 'string' || !value.chip.model.toLowerCase().includes('esp32-s3') ||
      !(typeof value.chip.revision === 'string' || value.chip.revision === null) ||
      !value.createdAt || !Number.isFinite(Date.parse(value.createdAt)) || !value.tool.version ||
      (value.descriptor !== null && (typeof value.descriptor !== 'object' || typeof value.descriptor.version !== 'string'))) {
    throw new Error('STAGING BLOCKED — BACKUP INVALID: manifest does not describe a verified backup of the exact target partition');
  }
  const backupPath = join(dirname(resolve(manifestPath)), value.backupFile);
  let fileEvidence: { sha256: string; md5: string; bytes: number };
  try { fileEvidence = await hashFileDigests(backupPath); }
  catch { throw new Error('STAGING BLOCKED — BACKUP INVALID: backup image file is missing or unreadable'); }
  if (fileEvidence.bytes !== expected.length || fileEvidence.sha256.toLowerCase() !== value.sha256!.toLowerCase()) {
    throw new Error('STAGING BLOCKED — BACKUP INVALID: backup file length or SHA-256 does not match its manifest');
  }
  return { manifest: value as InactiveBackupManifest, backupPath, backupMd5: fileEvidence.md5 };
}

async function readExactly(handle: Awaited<ReturnType<typeof open>>, buffer: Buffer, position: number): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const result = await handle.read(buffer, offset, buffer.length - offset, position + offset);
    if (result.bytesRead === 0) throw new Error('backup file ended during image inspection');
    offset += result.bytesRead;
  }
}

export async function inspectBackupImage(path: string, partitionLength: number): Promise<{ descriptor: AppDescriptor | null; signature: InactiveBackupManifest['signatureVerification']; actualImageLength?: number | null; actualImageSha256?: string | null; signatureKeyDigests?: string[] }> {
  const handle = await open(path, 'r');
  try {
    const descriptorBytes = Buffer.alloc(Math.min(4096, partitionLength));
    await readExactly(handle, descriptorBytes, 0);
    const { parseAppDescriptor } = await import('./upstream/flasher/appDescriptor.js');
    const descriptor = parseAppDescriptor(new Uint8Array(descriptorBytes));
    const bytes = new Uint8Array(await readFile(path));
    const boundary = parseEsp32S3ImageBoundary(bytes);
    const signatureStatus = boundary.status === 'valid-signature' ? 'valid'
      : boundary.status === 'invalid-signature' ? 'invalid'
        : boundary.status === 'no-signature' ? 'no-signature'
          : boundary.status === 'unsupported-image' ? 'unsupported' : 'not-verified';
    const imageLength = boundary.imageLength;
    const actualImageSha256 = imageLength === null ? null : createHash('sha256').update(bytes.subarray(0, imageLength)).digest('hex');
    const signatureKeyDigests = boundary.imageEvidence?.blocks.flatMap((block) => block.publicKeyHash ? [block.publicKeyHash] : []) ?? [];
    return { descriptor, signature: { status: signatureStatus, imageLength, explanation: boundary.explanation },
      actualImageLength: imageLength, actualImageSha256, signatureKeyDigests };
  } finally { await handle.close(); }
}

export async function createInactiveBackup(input: {
  outputPath: string; label: 'ota_0' | 'ota_1'; offset: number; length: number;
  chip: { model: string; revision: string | null }; readChunks: AsyncIterable<Uint8Array>;
  hashLivePartition: () => Promise<string>; signal?: AbortSignal; progress?: ProgressReporter;
  inspect?: (path: string, length: number) => ReturnType<typeof inspectBackupImage>;
}): Promise<InactiveBackupManifest> {
  const outputPath = resolve(input.outputPath);
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
  const manifestPath = `${outputPath}.manifest.json`;
  const tempTag = `.tmp-${randomUUID()}`;
  const tempOutput = `${outputPath}${tempTag}`;
  const tempManifest = `${manifestPath}${tempTag}`;
  let outputLinked = false;
  let manifestLinked = false;
  try {
    const handle = await open(tempOutput, 'wx', 0o600);
    const hash = createHash('sha256');
    let bytes = 0;
    try {
      for await (const chunk of input.readChunks) {
        if (input.signal?.aborted) throw new Error('Backup cancelled; temporary file removed');
        hash.update(chunk);
        bytes += chunk.byteLength;
        let cursor = 0;
        while (cursor < chunk.byteLength) {
          const result = await handle.write(chunk, cursor, chunk.byteLength - cursor);
          if (result.bytesWritten <= 0) throw new Error('backup file write made no progress');
          cursor += result.bytesWritten;
        }
      }
      if (input.signal?.aborted) throw new Error('Backup cancelled; temporary file removed');
      if (bytes !== input.length) throw new Error(`backup read length ${bytes} does not match partition length ${input.length}`);
      await handle.sync();
    } finally { await handle.close(); }
    const sha256 = hash.digest('hex');
    const independentReadbackVerified = (await input.hashLivePartition()).toLowerCase() === sha256;
    if (input.signal?.aborted) throw new Error('Backup cancelled; temporary file removed');
    if (!independentReadbackVerified) throw new Error('backup file SHA-256 does not match independent second flash-read SHA-256');
    input.progress?.stage('Verifying saved backup image signature');
    const imageInfo = await (input.inspect ?? inspectBackupImage)(tempOutput, input.length);
    input.progress?.finish('complete', `${imageInfo.signature.status} signature evidence collected`);
    if (input.signal?.aborted) throw new Error('Backup cancelled; temporary file removed');
    const build = getEmbeddedBuildInfo();
    const manifest: InactiveBackupManifest = {
      backupFormatVersion: 1, createdAt: new Date().toISOString(), chip: input.chip,
      partition: { label: input.label, offset: input.offset, length: input.length }, backupFile: basename(outputPath),
      sha256, bytes, descriptor: imageInfo.descriptor, firmwareVersion: imageInfo.descriptor?.version ?? null,
      signatureVerification: imageInfo.signature, independentReadbackVerified,
      actualImageLength: imageInfo.actualImageLength ?? null, actualImageSha256: imageInfo.actualImageSha256 ?? null,
      signatureKeyDigests: imageInfo.signatureKeyDigests ?? [],
      tool: { version: build.packageVersion, gitCommit: build.gitCommit, sourceSha256: build.sourceSha256 },
    };
    input.progress?.stage('Saving backup and manifest');
    const manifestHandle = await open(tempManifest, 'wx', 0o600);
    try { await manifestHandle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'); await manifestHandle.sync(); }
    finally { await manifestHandle.close(); }
    await link(tempOutput, outputPath); outputLinked = true;
    await link(tempManifest, manifestPath); manifestLinked = true;
    await unlink(tempOutput); await unlink(tempManifest);
    input.progress?.finish('complete', 'backup and manifest saved');
    return manifest;
  } catch (error) {
    input.progress?.finish(input.signal?.aborted ? 'cancelled' : 'failed');
    await unlink(tempOutput).catch(() => undefined);
    await unlink(tempManifest).catch(() => undefined);
    if (manifestLinked) await unlink(manifestPath).catch(() => undefined);
    if (outputLinked) await unlink(outputPath).catch(() => undefined);
    if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') throw new Error('Backup output or manifest already exists; refusing to overwrite it');
    throw error;
  }
}

export interface StageOnlySummary {
  deviceModel: string; deviceName: string; activeSlot: 'ota_1'; activeFirmware: string | null;
  targetSlot: 'ota_0'; targetOffset: number; targetLength: number;
  firmwareVersion: string; firmwareSha256: string; imageBytes: number;
  backupFile: string; backupSha256: string; backupFirmwareVersion: string | null;
  backupSignatureStatus: 'valid' | 'invalid' | 'not-verified' | 'no-signature' | 'unsupported';
  eraseStart: number; eraseEnd: number; flashEncryption: boolean;
  verificationMode: 'fast' | 'thorough';
  protectedVerificationMode: 'fast' | 'thorough';
  metadataWillChange: false; autoActivation: false;
}

export interface StageOnlyOperations {
  revalidate(): Promise<boolean>;
  writeApplication(offset: number, bytes: Uint8Array): Promise<void>;
  verifyHardwareMd5(offset: number, expectedMd5: string, length: number): Promise<boolean>;
  readbackSha256(offset: number, length: number): Promise<string>;
  verifyProtected(): Promise<{ valid: boolean; mismatches: string[] }>;
  readOtadata(): Promise<Uint8Array>;
  resetNormal(): Promise<void>;
}

export async function runStageOnlyTransaction(operations: StageOnlyOperations, input: {
  activeSlot: 'ota_0' | 'ota_1'; targetOffset: number; targetLength: number; firmwareBytes: Uint8Array; expectedSha256: string;
  expectedMd5: string; otadataBefore: Uint8Array; confirm: () => Promise<boolean>;
}): Promise<{ outcome: 'STAGED AND VERIFIED — NOT ACTIVATED'; hardwareMd5Verified: true; expectedMd5: string; expectedSha256: string; actualSha256: string; bytesRead: number; range: { start: number; end: number } }> {
  if (input.activeSlot !== 'ota_1' || input.targetOffset !== 0x420000 || input.targetLength !== 0x400000 ||
      input.firmwareBytes.length === 0 || input.firmwareBytes.length > input.targetLength) {
    throw new Error('STAGING BLOCKED — PREFLIGHT FAILED: only the validated 4 MiB ota_0 partition is supported');
  }
  if (createHash('sha256').update(input.firmwareBytes).digest('hex').toLowerCase() !== input.expectedSha256.toLowerCase()) {
    throw new Error('STAGING BLOCKED — PREFLIGHT FAILED: selected bytes do not match the official firmware SHA-256');
  }
  if (createHash('md5').update(input.firmwareBytes).digest('hex').toLowerCase() !== input.expectedMd5.toLowerCase() ||
      input.otadataBefore.byteLength !== 8192) {
    throw new Error('STAGING BLOCKED — PREFLIGHT FAILED: image digest or OTA metadata snapshot is invalid');
  }
  const eraseEnd = input.targetOffset + Math.ceil(input.firmwareBytes.length / 0x1000) * 0x1000;
  if (eraseEnd > input.targetOffset + input.targetLength) throw new Error('STAGING BLOCKED — PREFLIGHT FAILED: erase range exceeds ota_0');
  if (!(await input.confirm())) throw new Error('STAGING BLOCKED — OPERATOR CANCELLED: no write was started');
  let fresh = false;
  try { fresh = await operations.revalidate(); }
  catch { throw new Error('STAGING BLOCKED — PREFLIGHT FAILED: live revalidation could not complete after confirmation'); }
  if (!fresh) throw new Error('STAGING BLOCKED — PREFLIGHT FAILED: target, active slot, backup, or protected snapshot changed after confirmation');
  try {
    await operations.writeApplication(input.targetOffset, input.firmwareBytes);
  } catch (error) {
    throw new Error(`STAGING FAILED — TARGET MAY BE PARTIALLY WRITTEN: ${error instanceof Error ? error.message : String(error)}`);
  }
  let md5Valid = false;
  try { md5Valid = await operations.verifyHardwareMd5(input.targetOffset, input.expectedMd5, input.firmwareBytes.length); }
  catch { throw new Error('STAGING FAILED — VERIFICATION MISMATCH: hardware MD5 read failed'); }
  if (!md5Valid) throw new Error('STAGING FAILED — VERIFICATION MISMATCH: hardware MD5 mismatch');
  let actualSha256: string;
  try { actualSha256 = await operations.readbackSha256(input.targetOffset, input.firmwareBytes.length); }
  catch { throw new Error('STAGING FAILED — VERIFICATION MISMATCH: SHA-256 readback failed'); }
  if (actualSha256.toLowerCase() !== input.expectedSha256.toLowerCase()) {
    throw new Error(`STAGING FAILED — VERIFICATION MISMATCH: target SHA-256 expected ${input.expectedSha256}, readback ${actualSha256}`);
  }
  let protectedResult: { valid: boolean; mismatches: string[] };
  try { protectedResult = await operations.verifyProtected(); }
  catch { throw new Error('STAGING FAILED — PROTECTED REGION CHANGED: protected-region readback failed'); }
  if (!protectedResult.valid) throw new Error(`STAGING FAILED — PROTECTED REGION CHANGED: ${protectedResult.mismatches.join('; ')}`);
  let otadataAfter: Uint8Array;
  try { otadataAfter = await operations.readOtadata(); }
  catch { throw new Error('STAGING FAILED — VERIFICATION MISMATCH: OTA metadata readback failed'); }
  if (!Buffer.from(otadataAfter).equals(Buffer.from(input.otadataBefore))) throw new Error('STAGING FAILED — VERIFICATION MISMATCH: OTA metadata changed during stage-only operation');
  try { await operations.resetNormal(); }
  catch { throw new Error('STAGING FAILED — VERIFICATION MISMATCH: normal-boot reset could not be confirmed'); }
  return { outcome: 'STAGED AND VERIFIED — NOT ACTIVATED', hardwareMd5Verified: true, expectedMd5: input.expectedMd5, expectedSha256: input.expectedSha256,
    actualSha256, bytesRead: input.firmwareBytes.length,
    range: { start: input.targetOffset, end: input.targetOffset + input.firmwareBytes.length } };
}
