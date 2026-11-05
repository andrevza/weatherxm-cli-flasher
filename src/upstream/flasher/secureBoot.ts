import { createHash, createPublicKey, constants, verify as cryptoVerify, timingSafeEqual } from 'node:crypto';

/** ESP32-S3 eFuse read-register addresses from Espressif esptool's ESP32-S3 memory definition. */
export const ESP32S3_EFUSE = {
  base: 0x60007000,
  block0: 0x6000702c,
  keyBlocks: [0x6000709c, 0x600070bc, 0x600070dc, 0x600070fc, 0x6000711c, 0x6000713c],
  readDisableWord: 0x60007030,
  purposeAndRevokeWord2: 0x60007034,
  purposeWord3: 0x60007038,
  securityWord4: 0x6000703c,
} as const;

export type EvidenceStatus = 'verified' | 'unavailable' | 'ambiguous';
export type SecureBootState = 'enabled' | 'disabled' | 'unknown';

export interface SecureBootKeyBlock {
  block: number;
  purposeCode: number | null;
  purpose: string;
  readProtected: boolean | null;
  publicKeyHash: string | null;
  digestStatus: EvidenceStatus;
  readDiagnostic: KeyDigestReadDiagnostic | null;
}

export interface KeyDigestReadDiagnostic {
  operation: 'READ_REG';
  logicalSlot: number;
  physicalBlock: number;
  registerBaseOffset: string;
  expectedWords: 8;
  wordsRead: number;
  errorCategory: 'read-protected' | 'protection-state-unavailable' | 'serial-read-failed' | 'rom-command-unavailable' | 'register-read-failed' | 'invalid-register-value' | 'empty-readable-block' | null;
  failedWordIndex: number | null;
  failedRegisterOffset: string | null;
}

export interface SecureBootDeviceState {
  chip: { model: string; revision: string | null; status: EvidenceStatus };
  secureBootV2: { state: SecureBootState; status: EvidenceStatus };
  keyBlocks: SecureBootKeyBlock[];
  revocation: Array<{ digestSlot: number; revoked: boolean | null; status: EvidenceStatus }>;
  secureVersion: { value: number | null; status: EvidenceStatus };
  antiRollbackEnforcement: { state: 'enabled' | 'disabled' | 'unknown'; status: EvidenceStatus; explanation: string };
  downloadMode: {
    disableAllDownload: boolean | null;
    disableUsbSerialJtagDownload: boolean | null;
    securityDownloadEnabled: boolean | null;
    status: EvidenceStatus;
  };
  evidence: EvidenceStatus;
}

export interface ReadRegister {
  (address: number): Promise<number>;
}

const PURPOSE_NAMES: Record<number, string> = {
  0: 'USER', 1: 'RESERVED', 2: 'XTS_AES_256_KEY_1', 3: 'XTS_AES_256_KEY_2',
  4: 'XTS_AES_128_KEY', 5: 'HMAC_DOWN_ALL', 6: 'HMAC_DOWN_JTAG',
  7: 'HMAC_DOWN_DIGITAL_SIGNATURE', 8: 'HMAC_UP', 9: 'SECURE_BOOT_DIGEST0',
  10: 'SECURE_BOOT_DIGEST1', 11: 'SECURE_BOOT_DIGEST2',
};

function wordBytes(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
  return bytes;
}

/** esptool-js 0.7.0 assembles READ_REG values with JS bitwise operators and can return a signed int32. */
function unsignedRegisterWord(value: number): number | null {
  if (!Number.isInteger(value) || value < -0x80000000 || value > 0xffffffff) return null;
  return value >>> 0;
}

function registerErrorCategory(error: unknown): KeyDigestReadDiagnostic['errorCategory'] {
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (/timeout|serial|port closed|stream stopped|no data/.test(message)) return 'serial-read-failed';
  if (/unsupported|not supported|invalid command/.test(message)) return 'rom-command-unavailable';
  return 'register-read-failed';
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function readBits(words: number[], start: number, width: number): number {
  const word = words[Math.floor(start / 32)];
  if (word === undefined) throw new Error('eFuse field was not read');
  return (word >>> (start % 32)) & (width === 32 ? 0xffffffff : (1 << width) - 1);
}

function statusJoin(...statuses: EvidenceStatus[]): EvidenceStatus {
  if (statuses.includes('ambiguous')) return 'ambiguous';
  if (statuses.includes('unavailable')) return 'unavailable';
  return 'verified';
}

/** Reads only ESP32-S3 eFuse read registers. It has no eFuse write path. */
export async function readEsp32S3SecureBootState(
  readReg: ReadRegister,
  chip: { model: string; revision: string | null; status?: EvidenceStatus },
): Promise<SecureBootDeviceState> {
  const words: number[] = [];
  let block0Status: EvidenceStatus = 'verified';
  for (let i = 0; i < 6; i++) {
    try {
      const word = unsignedRegisterWord(await readReg(ESP32S3_EFUSE.block0 + i * 4));
      if (word === null) throw new Error('invalid register value');
      words.push(word);
    } catch {
      words.push(0);
      block0Status = 'unavailable';
    }
  }

  const secureBootEnabled = block0Status === 'verified' ? readBits(words, 116, 1) === 1 : null;
  const readDisable = block0Status === 'verified' ? readBits(words, 32, 7) : null;
  const revocation = [0, 1, 2].map((digestSlot) => ({
    digestSlot,
    revoked: block0Status === 'verified' ? readBits(words, 85 + digestSlot, 1) === 1 : null,
    status: block0Status,
  }));
  const keyBlocks: SecureBootKeyBlock[] = [];

  for (let block = 0; block < 6; block++) {
    const purposeStart = 88 + block * 4;
    const purposeCode = block0Status === 'verified' ? readBits(words, purposeStart, 4) : null;
    const purpose = purposeCode === null ? 'UNKNOWN' : PURPOSE_NAMES[purposeCode] ?? `UNKNOWN(0x${purposeCode.toString(16)})`;
    const readProtected = readDisable === null ? null : ((readDisable >>> block) & 1) === 1;
    const digestPurpose = purposeCode !== null && purposeCode >= 9 && purposeCode <= 11;
    let publicKeyHash: string | null = null;
    let digestStatus: EvidenceStatus = block0Status === 'verified' ? 'verified' : 'unavailable';
    let readDiagnostic: KeyDigestReadDiagnostic | null = digestPurpose ? {
      operation: 'READ_REG', logicalSlot: purposeCode! - 9, physicalBlock: block + 4,
      registerBaseOffset: `0x${(ESP32S3_EFUSE.keyBlocks[block] - ESP32S3_EFUSE.base).toString(16).padStart(3, '0')}`,
      expectedWords: 8, wordsRead: 0, errorCategory: null, failedWordIndex: null, failedRegisterOffset: null,
    } : null;

    if (digestPurpose) {
      if (readProtected === true) {
        digestStatus = 'unavailable';
        readDiagnostic!.errorCategory = 'read-protected';
      } else if (readProtected === null) {
        digestStatus = 'unavailable';
        readDiagnostic!.errorCategory = 'protection-state-unavailable';
      } else {
        const start = ESP32S3_EFUSE.keyBlocks[block];
        const bytes = new Uint8Array(32);
        let readFailed = false;
        for (let word = 0; word < 8; word++) {
          const address = start + word * 4;
          let rawValue: number;
          try {
            rawValue = await readReg(address);
          } catch (error) {
            readDiagnostic!.errorCategory = registerErrorCategory(error);
            readDiagnostic!.failedWordIndex = word;
            readDiagnostic!.failedRegisterOffset = `0x${(address - ESP32S3_EFUSE.base).toString(16).padStart(3, '0')}`;
            readFailed = true;
            break;
          }
          const value = unsignedRegisterWord(rawValue);
          if (value === null) {
            readDiagnostic!.errorCategory = 'invalid-register-value';
            readDiagnostic!.failedWordIndex = word;
            readDiagnostic!.failedRegisterOffset = `0x${(address - ESP32S3_EFUSE.base).toString(16).padStart(3, '0')}`;
            readFailed = true;
            break;
          }
          readDiagnostic!.wordsRead++;
          bytes.set(wordBytes(value), word * 4);
        }
        if (readFailed) {
          digestStatus = 'unavailable';
        } else if (bytes.every((byte) => byte === 0) || bytes.every((byte) => byte === 0xff)) {
          digestStatus = 'ambiguous';
          readDiagnostic!.errorCategory = 'empty-readable-block';
        } else {
          publicKeyHash = hex(bytes);
        }
      }
    }

    keyBlocks.push({ block, purposeCode, purpose, readProtected, publicKeyHash, digestStatus, readDiagnostic });
  }

  // Duplicate digest purposes make the silicon's active key-block selection ambiguous.
  for (const purposeCode of [9, 10, 11]) {
    const matches = keyBlocks.filter((entry) => entry.purposeCode === purposeCode);
    if (matches.length > 1) for (const match of matches) match.digestStatus = 'ambiguous';
  }

  const secureVersion = block0Status === 'verified'
    ? { value: readBits(words, 142, 16), status: 'verified' as const }
    : { value: null, status: 'unavailable' as const };
  const downloadMode = block0Status === 'verified'
    ? {
        disableAllDownload: readBits(words, 128, 1) === 1,
        disableUsbSerialJtagDownload: readBits(words, 132, 1) === 1,
        securityDownloadEnabled: readBits(words, 133, 1) === 1,
        status: 'verified' as const,
      }
    : { disableAllDownload: null, disableUsbSerialJtagDownload: null, securityDownloadEnabled: null, status: 'unavailable' as const };

  const secureBootV2: SecureBootDeviceState['secureBootV2'] = {
    state: secureBootEnabled === null ? 'unknown' : secureBootEnabled ? 'enabled' : 'disabled',
    status: block0Status,
  };
  const activeDigestBlocks = keyBlocks.filter((entry) => entry.purposeCode !== null && entry.purposeCode >= 9 && entry.purposeCode <= 11);
  const evidence = statusJoin(chip.status ?? (chip.model.toLowerCase().includes('esp32-s3') ? 'verified' : 'ambiguous'), block0Status,
    ...activeDigestBlocks.map((entry) => entry.digestStatus));

  return {
    chip: { ...chip, status: chip.status ?? (chip.model.toLowerCase().includes('esp32-s3') ? 'verified' : 'ambiguous') },
    secureBootV2,
    keyBlocks,
    revocation,
    secureVersion,
    antiRollbackEnforcement: {
      state: 'unknown',
      status: 'unavailable',
      explanation: 'The security-version eFuse floor is readable, but eFuses do not attest whether the installed bootloader was built with CONFIG_BOOTLOADER_APP_ANTI_ROLLBACK.',
    },
    downloadMode,
    evidence,
  };
}

export interface SignatureBlockEvidence {
  index: number;
  algorithm: 'RSA-3072-PSS-SHA256' | 'unsupported';
  publicKeyHash: string | null;
  imageDigestValid: boolean;
  signatureValid: boolean;
  blockValid: boolean;
  error: string | null;
}

export interface SecureBootImageEvidence {
  imageFormatValid: boolean;
  imageDigestValid: boolean;
  signatureValid: boolean;
  secureVersion: number | null;
  chipId: number | null;
  signedLength: number | null;
  blocks: SignatureBlockEvidence[];
  errors: string[];
}

const SIGNATURE_SECTOR_SIZE = 4096;
const SIGNATURE_BLOCK_USED_SIZE = 1216;
const WG1200_MMU_PAGE_SIZE = 0x10000;

function sha256(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(data).digest());
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function reverse(bytes: Uint8Array): Uint8Array { return new Uint8Array(bytes).reverse(); }

function base64Url(bytes: Uint8Array): string { return Buffer.from(bytes).toString('base64url'); }

function publicKeyFromSignatureBlock(block: Uint8Array) {
  const modulus = reverse(block.subarray(36, 420));
  const exponentValue = new DataView(block.buffer, block.byteOffset + 420, 4).getUint32(0, true);
  if (modulus.length !== 384 || modulus[0] === 0 || exponentValue < 3 || (exponentValue & 1) === 0) {
    throw new Error('invalid RSA-3072 public-key encoding');
  }
  let exponentBytes = new Uint8Array(4);
  new DataView(exponentBytes.buffer).setUint32(0, exponentValue, false);
  while (exponentBytes.length > 1 && exponentBytes[0] === 0) exponentBytes = exponentBytes.slice(1);
  const key = createPublicKey({ key: { kty: 'RSA', n: base64Url(modulus), e: base64Url(exponentBytes) }, format: 'jwk' });
  if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails?.modulusLength !== 3072) throw new Error('Secure Boot V2 requires RSA-3072');
  return key;
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let b = base % modulus;
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % modulus;
    e >>= 1n;
    b = (b * b) % modulus;
  }
  return result;
}

function bytesToBigIntLE(bytes: Uint8Array): bigint { return BigInt(`0x${hex(reverse(bytes)) || '0'}`); }

function expectedRAndM(modulusLittleEndian: Uint8Array): { r: Uint8Array; m: number } {
  const n = bytesToBigIntLE(modulusLittleEndian);
  if (n <= 0n || (n & 1n) === 0n) throw new Error('invalid RSA modulus');
  const rValue = modPow(2n, 6144n, n);
  let rBig = rValue.toString(16).padStart(768, '0');
  const rBigEndian = Uint8Array.from(rBig.match(/.{2}/g) ?? [], (pair) => Number.parseInt(pair, 16));
  // n' is the negative modular inverse of n modulo 2^32.
  const modulus32 = 1n << 32n;
  let t = 0n; let newT = 1n; let r = modulus32; let newR = n % modulus32;
  while (newR !== 0n) {
    const quotient = r / newR;
    [t, newT] = [newT, t - quotient * newT];
    [r, newR] = [newR, r - quotient * newR];
  }
  if (r !== 1n) throw new Error('RSA modulus has no Montgomery inverse');
  const m = Number(((modulus32 - (t % modulus32)) % modulus32));
  return { r: reverse(rBigEndian), m };
}

function validateSignatureBlock(block: Uint8Array, signedImage: Uint8Array, index: number): SignatureBlockEvidence {
  const base = { index, algorithm: 'RSA-3072-PSS-SHA256' as const, publicKeyHash: null as string | null,
    imageDigestValid: false, signatureValid: false, blockValid: false, error: null as string | null };
  try {
    if (block.length !== SIGNATURE_SECTOR_SIZE || block[0] !== 0xe7 || block[1] !== 0x02 || block[2] !== 0 || block[3] !== 0) {
      throw new Error('invalid Secure Boot V2 RSA signature-block header');
    }
    const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
    if (view.getUint32(1196, true) !== crc32(block.subarray(0, 1196))) throw new Error('signature-block CRC32 mismatch');
    if (block.subarray(1200, 1216).some((byte) => byte !== 0) || block.subarray(SIGNATURE_BLOCK_USED_SIZE).some((byte) => byte !== 0xff)) {
      throw new Error('signature-block reserved or erased padding is invalid');
    }
    const modulusLittle = block.subarray(36, 420);
    const { r, m } = expectedRAndM(modulusLittle);
    if (!timingSafeEqual(r, block.subarray(424, 808)) || m !== view.getUint32(808, true)) {
      throw new Error('RSA Montgomery pre-calculation fields are invalid');
    }
    const imageDigest = sha256(signedImage);
    base.imageDigestValid = timingSafeEqual(imageDigest, block.subarray(4, 36));
    if (!base.imageDigestValid) throw new Error('signed image SHA-256 does not match signature block');
    const publicKeyHash = sha256(block.subarray(36, 812));
    base.publicKeyHash = hex(publicKeyHash);
    const key = publicKeyFromSignatureBlock(block);
    const signature = reverse(block.subarray(812, 1196));
    base.signatureValid = cryptoVerify('sha256', signedImage, {
      key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32,
    }, signature);
    if (!base.signatureValid) throw new Error('RSA-PSS signature verification failed');
    base.blockValid = true;
  } catch (error) {
    base.error = error instanceof Error ? error.message : String(error);
  }
  return base;
}

interface ParsedImageBoundary { checksumOffset: number; imageDigestOffset: number; chipId: number; }

function parseAndValidateEspImage(data: Uint8Array, signedLength: number): ParsedImageBoundary {
  if (data[0] !== 0xe9) throw new Error('ESP image magic is not 0xE9');
  const segmentCount = data[1];
  if (segmentCount < 1 || segmentCount > 16) throw new Error(`ESP image segment count ${segmentCount} is outside 1..16`);
  const chipId = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint16(12, true);
  if (chipId !== 9) throw new Error(`ESP image chip ID ${chipId} is not ESP32-S3 (9)`);
  const hashAppended = data[23];
  if (hashAppended !== 0 && hashAppended !== 1) throw new Error('ESP image hash_appended flag is invalid');
  let cursor = 24;
  let imageChecksum = 0xef;
  for (let segment = 0; segment < segmentCount; segment++) {
    if (cursor + 8 > signedLength) throw new Error(`ESP image segment ${segment} header is truncated`);
    const view = new DataView(data.buffer, data.byteOffset + cursor, 8);
    const segmentLength = view.getUint32(4, true);
    cursor += 8;
    if (segmentLength === 0 || segmentLength > 0x1000000 || cursor + segmentLength > signedLength) {
      throw new Error(`ESP image segment ${segment} has an invalid length`);
    }
    for (const byte of data.subarray(cursor, cursor + segmentLength)) imageChecksum ^= byte;
    cursor += segmentLength;
  }
  // esptool aligns the file cursor to offset 15 mod 16, then writes checksum;
  // the checksum is the final byte that makes the image length divisible by 16.
  const checksumOffset = cursor + (15 - (cursor % 16));
  if (checksumOffset >= signedLength || data[checksumOffset] !== imageChecksum) throw new Error('ESP image segment XOR checksum mismatch');
  const digestOffset = checksumOffset + 1;
  if (hashAppended === 1) {
    if (digestOffset + 32 > signedLength || !timingSafeEqual(sha256(data.subarray(0, digestOffset)), data.subarray(digestOffset, digestOffset + 32))) {
      throw new Error('ESP image appended SHA-256 digest mismatch');
    }
  }
  const contentEnd = digestOffset + (hashAppended === 1 ? 32 : 0);
  if (signedLength % WG1200_MMU_PAGE_SIZE !== 0) throw new Error('Secure Boot V2 signed image is not padded to the WG1200 64 KiB MMU page size');
  if (data.subarray(contentEnd, signedLength).some((byte) => byte !== 0)) throw new Error('Secure Boot V2 page padding contains non-zero bytes');
  return { checksumOffset, imageDigestOffset: digestOffset, chipId };
}

export function verifySecureBootV2Image(data: Uint8Array): SecureBootImageEvidence {
  const errors: string[] = [];
  const invalid = (message: string): SecureBootImageEvidence => ({ imageFormatValid: false, imageDigestValid: false,
    signatureValid: false, secureVersion: null, chipId: null, signedLength: null, blocks: [], errors: [message] });
  if (data.length < SIGNATURE_SECTOR_SIZE * 2 || data.length % SIGNATURE_SECTOR_SIZE !== 0) return invalid('signed image length is not a valid sector-aligned ESP image');

  for (let blockCount = 1; blockCount <= 3; blockCount++) {
    const signedLength = data.length - blockCount * SIGNATURE_SECTOR_SIZE;
    if (signedLength <= 0 || signedLength % WG1200_MMU_PAGE_SIZE !== 0) continue;
    try {
      parseAndValidateEspImage(data, signedLength);
      const blocks: SignatureBlockEvidence[] = [];
      for (let index = 0; index < blockCount; index++) {
        const start = signedLength + index * SIGNATURE_SECTOR_SIZE;
        blocks.push(validateSignatureBlock(data.subarray(start, start + SIGNATURE_SECTOR_SIZE), data.subarray(0, signedLength), index));
      }
      const validBlocks = blocks.filter((block) => block.blockValid);
      const imageDigestValid = blocks.some((block) => block.imageDigestValid);
      const signatureValid = validBlocks.length > 0;
      if (!signatureValid) errors.push(...blocks.map((block) => block.error ?? 'invalid signature block'));
      return { imageFormatValid: true, imageDigestValid, signatureValid, secureVersion: null,
        chipId: 9, signedLength, blocks, errors };
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { imageFormatValid: false, imageDigestValid: false, signatureValid: false, secureVersion: null,
    chipId: null, signedLength: null, blocks: [], errors: errors.length ? errors : ['no valid 64 KiB-aligned signature boundary found'] };
}

export function compareSecureBootTrust(image: SecureBootImageEvidence, device: SecureBootDeviceState): {
  result: 'TRUSTED' | 'UNTRUSTED' | 'REVOKED' | 'INCOMPATIBLE' | 'UNKNOWN';
  trustedKeyMatch: boolean | null;
  keyStatus: EvidenceStatus;
  securityVersionStatus: 'meets-floor' | 'below-floor' | 'unknown';
  explanation: string;
} {
  if (!image.imageFormatValid || !image.imageDigestValid || !image.signatureValid) {
    return { result: 'UNTRUSTED', trustedKeyMatch: false, keyStatus: 'verified', securityVersionStatus: 'unknown', explanation: 'Candidate image structure, digest, or RSA-PSS signature verification failed.' };
  }
  if (device.secureBootV2.state !== 'enabled' || device.secureBootV2.status !== 'verified') {
    return { result: 'UNKNOWN', trustedKeyMatch: null, keyStatus: 'unavailable', securityVersionStatus: 'unknown', explanation: 'Device Secure Boot V2 state is unavailable or not enabled.' };
  }
  const signerDigests = image.blocks.filter((block) => block.blockValid && block.publicKeyHash).map((block) => block.publicKeyHash!);
  const activePurposeBlocks = device.keyBlocks.filter((block) => block.purposeCode !== null && block.purposeCode >= 9 && block.purposeCode <= 11);
  if (activePurposeBlocks.length === 0 || activePurposeBlocks.some((block) => block.digestStatus !== 'verified' || !block.publicKeyHash)) {
    if (activePurposeBlocks.length === 0 && device.evidence === 'verified') {
      return { result: 'UNTRUSTED', trustedKeyMatch: false, keyStatus: 'verified', securityVersionStatus: 'unknown', explanation: 'No Secure Boot digest key purpose is configured on the device.' };
    }
    return { result: 'UNKNOWN', trustedKeyMatch: null, keyStatus: activePurposeBlocks.length ? 'unavailable' : 'ambiguous', securityVersionStatus: 'unknown', explanation: 'One or more active Secure Boot digest fields could not be read unambiguously.' };
  }
  const matches = activePurposeBlocks.filter((block) => signerDigests.some((digest) => {
    const candidate = Buffer.from(digest, 'hex'); const enrolled = Buffer.from(block.publicKeyHash!, 'hex');
    return candidate.length === enrolled.length && timingSafeEqual(candidate, enrolled);
  }));
  const nonRevokedMatches = matches.filter((block) => device.revocation[block.purposeCode! - 9]?.revoked === false);
  const onlyRevokedMatches = matches.length > 0 && nonRevokedMatches.length === 0;
  const trustedKeyMatch = nonRevokedMatches.length > 0;
  const securityVersionStatus = device.secureVersion.status === 'verified' && image.secureVersion !== null
    ? image.secureVersion >= device.secureVersion.value! ? 'meets-floor' : 'below-floor'
    : 'unknown';
  if (onlyRevokedMatches) return { result: 'REVOKED', trustedKeyMatch: false, keyStatus: 'verified', securityVersionStatus, explanation: 'Candidate signature key matches only a revoked device key digest.' };
  if (!trustedKeyMatch) return { result: 'UNTRUSTED', trustedKeyMatch: false, keyStatus: 'verified', securityVersionStatus, explanation: 'Candidate signing-key digest does not match an active, non-revoked device digest.' };
  if (securityVersionStatus === 'below-floor' && device.antiRollbackEnforcement.state === 'enabled') return { result: 'INCOMPATIBLE', trustedKeyMatch: true, keyStatus: 'verified', securityVersionStatus, explanation: 'Candidate security_version is below the device eFuse floor.' };
  if (securityVersionStatus === 'unknown' || device.antiRollbackEnforcement.state === 'unknown') {
    return { result: 'UNKNOWN', trustedKeyMatch: true, keyStatus: 'verified', securityVersionStatus, explanation: securityVersionStatus === 'below-floor'
      ? 'The RSA-PSS signature and device key match, but the candidate is below the security-version eFuse floor and enforcement by the installed bootloader is unknown.'
      : 'The RSA-PSS signature and device key match, but the security-version floor or installed bootloader anti-rollback enforcement is unknown.' };
  }
  return { result: 'TRUSTED', trustedKeyMatch: true, keyStatus: 'verified', securityVersionStatus, explanation: 'Signature, image digest, active device key, and anti-rollback compatibility all verified.' };
}
