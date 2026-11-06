import { createHash, generateKeyPairSync, sign, constants } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { assertInstallSecurityEvidence, assertStageOnlySecurityEvidence } from '../src/device.js';
import { compareSecureBootTrust, ESP32S3_EFUSE, readEsp32S3SecureBootState, verifySecureBootV2Image } from '../src/upstream/flasher/secureBoot.js';

function sha(data: Uint8Array) { return new Uint8Array(createHash('sha256').update(data).digest()); }
function crc32(data: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function reverse(bytes: Uint8Array) { return new Uint8Array(bytes).reverse(); }
function bytesFromBigInt(value: bigint, length: number) {
  const result = new Uint8Array(length); let v = value;
  for (let i = length - 1; i >= 0; i--) { result[i] = Number(v & 255n); v >>= 8n; }
  return result;
}

function fixture() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 3072, publicExponent: 0x10001 });
  const jwk = publicKey.export({ format: 'jwk' });
  const modulus = reverse(new Uint8Array(Buffer.from(jwk.n!, 'base64url')));
  const exponent = Number.parseInt(Buffer.from(jwk.e!, 'base64url').toString('hex'), 16);
  const image = new Uint8Array(0x10000);
  image[0] = 0xe9; image[1] = 1; image[23] = 1;
  const header = new DataView(image.buffer);
  header.setUint16(12, 9, true);
  header.setUint32(24, 0x3fc80000, true); header.setUint32(28, 4, true);
  image.set([1, 2, 3, 4], 32);
  let checksum = 0xef; for (const b of image.subarray(32, 36)) checksum ^= b;
  image[47] = checksum; image.set(sha(image.subarray(0, 48)), 48);
  const block = new Uint8Array(4096); block.fill(0xff);
  block.set([0xe7, 2, 0, 0], 0); block.set(sha(image), 4); block.set(modulus, 36);
  new DataView(block.buffer).setUint32(420, exponent, true);
  const n = BigInt(`0x${Buffer.from(jwk.n!, 'base64url').toString('hex')}`);
  const r = (1n << 6144n) % n;
  block.set(reverse(bytesFromBigInt(r, 384)), 424);
  const n0 = Number(n & 0xffffffffn) >>> 0;
  // Newton iteration computes the inverse modulo 2^32 for the fixture.
  let inverse = n0;
  for (let i = 0; i < 5; i++) inverse = Math.imul(inverse, 2 - Math.imul(n0, inverse)) >>> 0;
  new DataView(block.buffer).setUint32(808, (-inverse) >>> 0, true);
  const signature = sign('sha256', image, { key: privateKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 });
  block.set(reverse(new Uint8Array(signature)), 812);
  block.fill(0, 1200, 1216);
  new DataView(block.buffer).setUint32(1196, crc32(block.subarray(0, 1196)), true);
  const data = new Uint8Array(image.length + block.length); data.set(image); data.set(block, image.length);
  return { data, digest: Buffer.from(sha(block.subarray(36, 812))).toString('hex') };
}

function setBit(words: number[], bit: number, value = 1) {
  const index = Math.floor(bit / 32); words[index] = (words[index] ?? 0) | (value << (bit % 32));
}
function deviceRegisters(options: { secureBoot?: boolean; purpose?: number; revoke?: boolean; readProtect?: boolean; digest?: string } = {}) {
  const words = Array(6).fill(0);
  if (options.secureBoot ?? true) setBit(words, 116);
  if (options.purpose ?? 9) words[Math.floor(88 / 32)] |= (options.purpose ?? 9) << (88 % 32);
  if (options.revoke) setBit(words, 85);
  if (options.readProtect) setBit(words, 32);
  words[Math.floor(142 / 32)] |= 2 << (142 % 32);
  const digest = Buffer.from(options.digest ?? '11'.repeat(32), 'hex');
  return (address: number) => {
    if (address >= ESP32S3_EFUSE.block0 && address < ESP32S3_EFUSE.block0 + 24) return words[(address - ESP32S3_EFUSE.block0) / 4] >>> 0;
    if (address >= ESP32S3_EFUSE.keyBlocks[0] && address < ESP32S3_EFUSE.keyBlocks[0] + 32) {
      const word = (address - ESP32S3_EFUSE.keyBlocks[0]) / 4;
      // Match esptool-js's READ_REG bitwise int32 return value, including negatives.
      return new DataView(digest.buffer, digest.byteOffset, digest.byteLength).getUint32(word * 4, true) | 0;
    }
    throw new Error('unexpected register');
  };
}

describe('ESP32-S3 Secure Boot V2 read-only evidence', () => {
  it('verifies a real synthetic RSA-3072 PSS image and rejects tampering', () => {
    const { data } = fixture();
    const valid = verifySecureBootV2Image(data);
    expect(valid).toMatchObject({ imageFormatValid: true, imageDigestValid: true, signatureValid: true, signedLength: 0x10000 });
    const corrupted = data.slice(); corrupted[70] ^= 1;
    expect(verifySecureBootV2Image(corrupted).imageFormatValid).toBe(false);
    const badSignature = data.slice(); badSignature[0x10000 + 812] ^= 1;
    new DataView(badSignature.buffer).setUint32(0x10000 + 1196, crc32(badSignature.subarray(0x10000, 0x10000 + 1196)), true);
    expect(verifySecureBootV2Image(badSignature)).toMatchObject({ imageFormatValid: true, imageDigestValid: true, signatureValid: false });
    const badDigest = data.slice(); badDigest[0x10000 + 4] ^= 1;
    new DataView(badDigest.buffer).setUint32(0x10000 + 1196, crc32(badDigest.subarray(0x10000, 0x10000 + 1196)), true);
    expect(verifySecureBootV2Image(badDigest)).toMatchObject({ imageFormatValid: true, imageDigestValid: false, signatureValid: false });
    const malformed = data.slice(); malformed[0x10000] = 0;
    expect(verifySecureBootV2Image(malformed)).toMatchObject({ imageFormatValid: true, signatureValid: false });
  });

  it('reads only eFuse read registers and marks protected or failed evidence unavailable', async () => {
    const reads: number[] = [];
    const expectedDigest = '8123456789abcdef'.repeat(4);
    const read = deviceRegisters({ digest: expectedDigest });
    const state = await readEsp32S3SecureBootState(async (address) => { reads.push(address); return read(address); }, { model: 'ESP32-S3', revision: 'v0.2' });
    expect(state.secureBootV2.state).toBe('enabled');
    expect(state.keyBlocks[0].publicKeyHash).toBe(expectedDigest);
    expect(state.keyBlocks[0].readDiagnostic).toMatchObject({ logicalSlot: 0, physicalBlock: 4, registerBaseOffset: '0x09c', expectedWords: 8, wordsRead: 8, errorCategory: null });
    expect(reads.filter((address) => address >= ESP32S3_EFUSE.keyBlocks[0] && address < ESP32S3_EFUSE.keyBlocks[0] + 32))
      .toEqual(Array.from({ length: 8 }, (_, word) => ESP32S3_EFUSE.keyBlocks[0] + word * 4));
    expect(reads.every((address) => address >= ESP32S3_EFUSE.block0 && address < 0x60007200)).toBe(true);
    const protectedState = await readEsp32S3SecureBootState(async (address) => deviceRegisters({ readProtect: true })(address), { model: 'ESP32-S3', revision: null });
    expect(protectedState.keyBlocks[0].digestStatus).toBe('unavailable');
    expect(protectedState.keyBlocks[0].readDiagnostic?.errorCategory).toBe('read-protected');
    const failed = await readEsp32S3SecureBootState(async () => { throw new Error('serial failure'); }, { model: 'ESP32-S3', revision: null });
    expect(failed.secureBootV2.state).toBe('unknown');
    expect(failed.secureVersion.value).toBeNull();

    const truncated = await readEsp32S3SecureBootState(async (address) => {
      if (address === ESP32S3_EFUSE.keyBlocks[0] + 16) throw new Error('Serial timeout');
      return deviceRegisters({ digest: expectedDigest })(address);
    }, { model: 'ESP32-S3', revision: null });
    expect(truncated.keyBlocks[0].publicKeyHash).toBeNull();
    expect(truncated.keyBlocks[0].digestStatus).toBe('unavailable');
    expect(truncated.keyBlocks[0].readDiagnostic).toMatchObject({ wordsRead: 4, failedWordIndex: 4, failedRegisterOffset: '0x0ac', errorCategory: 'serial-read-failed' });

    const restricted = await readEsp32S3SecureBootState(async (address) => {
      if (address === ESP32S3_EFUSE.keyBlocks[0]) throw new Error('Command not supported in secure download mode');
      return deviceRegisters({ digest: expectedDigest })(address);
    }, { model: 'ESP32-S3', revision: null });
    expect(restricted.keyBlocks[0].readDiagnostic?.errorCategory).toBe('rom-command-unavailable');

    const zeroBlock = await readEsp32S3SecureBootState(async (address) => {
      if (address >= ESP32S3_EFUSE.keyBlocks[0] && address < ESP32S3_EFUSE.keyBlocks[0] + 32) return 0;
      return deviceRegisters({ digest: expectedDigest })(address);
    }, { model: 'ESP32-S3', revision: null });
    expect(zeroBlock.keyBlocks[0].publicKeyHash).toBeNull();
    expect(zeroBlock.keyBlocks[0].digestStatus).toBe('ambiguous');
    expect(zeroBlock.keyBlocks[0].readDiagnostic?.errorCategory).toBe('empty-readable-block');
  });

  it('keeps device trust separate from unknown bootloader rollback and rejects revoked or mismatched keys', () => {
    const { data, digest } = fixture();
    const image = verifySecureBootV2Image(data); image.secureVersion = 2;
    const makeState = (options: Parameters<typeof deviceRegisters>[0]) => readEsp32S3SecureBootState(async (address) => deviceRegisters({ ...options, digest })(address), { model: 'ESP32-S3', revision: null });
    return makeState({}).then((trusted) => {
      expect(compareSecureBootTrust(image, trusted).result).toBe('TRUSTED');
      expect(compareSecureBootTrust(image, trusted).trustedKeyMatch).toBe(true);
      expect(compareSecureBootTrust(image, trusted).securityVersionStatus).toBe('meets-floor');
      return makeState({ revoke: true }).then((revoked) => expect(compareSecureBootTrust(image, revoked).result).toBe('REVOKED'));
    }).then(() => makeState({ purpose: 0 }).then((wrong) => expect(compareSecureBootTrust(image, wrong).result).toBe('UNTRUSTED')));
  });

  it('reports flash-encryption and all ROM download restriction eFuses as read-only evidence', async () => {
    const reads: number[] = [];
    const read = deviceRegisters();
    const state = await readEsp32S3SecureBootState(async (address) => {
      reads.push(address);
      if (address === ESP32S3_EFUSE.block0 + 8) return (read(address) | (1 << 18)) >>> 0; // SPI_BOOT_CRYPT_CNT=1 (odd parity)
      if (address === ESP32S3_EFUSE.block0 + 4) return (read(address) | (1 << 20)) >>> 0; // DIS_DOWNLOAD_MANUAL_ENCRYPT
      if (address === ESP32S3_EFUSE.block0 + 16) return (read(address) | (1 << 0) | (1 << 4) | (1 << 5) | (1 << 31)) >>> 0; // download restrictions
      return read(address);
    }, { model: 'ESP32-S3', revision: null });
    expect(state.flashEncryption).toEqual({ cryptCount: 1, enabled: true, disableManualEncryption: true, status: 'verified' });
    expect(state.downloadMode).toEqual({ disableAllDownload: true, disableUsbSerialJtagDownload: true, disableUsbOtgDownload: true, securityDownloadEnabled: true, status: 'verified' });
    expect(reads.slice(0, 6)).toEqual(Array.from({ length: 6 }, (_, i) => ESP32S3_EFUSE.block0 + i * 4));
  });

  it('fails closed when anti-rollback configuration is not established for installation', async () => {
    const { data, digest } = fixture();
    const image = verifySecureBootV2Image(data);
    image.secureVersion = 2;
    const state = await readEsp32S3SecureBootState(async (address) => deviceRegisters({ digest })(address), { model: 'ESP32-S3', revision: null });
    expect(image.signatureValid).toBe(true);
    expect(() => assertInstallSecurityEvidence(image, state)).toThrow(/anti-rollback configuration is not established/);
    const invalid = { ...image, signatureValid: false };
    expect(() => assertInstallSecurityEvidence(invalid, state)).toThrow(/signature verification failed/);
  });

  it('permits stage-only security preflight with verified slot-0 trust and unknown bootloader rollback, but rejects concrete eFuse blockers', async () => {
    const { data, digest } = fixture();
    const image = verifySecureBootV2Image(data); image.secureVersion = 2;
    const readState = async (reader: (address: number) => number = deviceRegisters({ digest })) =>
      readEsp32S3SecureBootState(async (address) => reader(address), { model: 'ESP32-S3', revision: '0.2' });
    const trusted = await readState();
    expect(trusted.antiRollbackEnforcement.state).toBe('unknown');
    expect(() => assertStageOnlySecurityEvidence(image, trusted)).not.toThrow();
    await expect(readState(deviceRegisters({ digest: '22'.repeat(32) })).then((state) => assertStageOnlySecurityEvidence(image, state))).rejects.toThrow(/signer\/security-version check/);
    await expect(readState(deviceRegisters({ digest, revoke: true })).then((state) => assertStageOnlySecurityEvidence(image, state))).rejects.toThrow(/signer\/security-version check/);
    await expect(readState((address) => address === ESP32S3_EFUSE.block0 + 8 ? deviceRegisters({ digest })(address) | (1 << 18) : deviceRegisters({ digest })(address))
      .then((state) => assertStageOnlySecurityEvidence(image, state))).rejects.toThrow(/flash encryption is enabled/);
    await expect(readState((address) => address === ESP32S3_EFUSE.block0 + 16 ? deviceRegisters({ digest })(address) | 1 : deviceRegisters({ digest })(address))
      .then((state) => assertStageOnlySecurityEvidence(image, state))).rejects.toThrow(/ROM serial flash writing is restricted/);
    expect(() => assertStageOnlySecurityEvidence({ ...image, signatureValid: false }, trusted)).toThrow(/signature is invalid/);
  });

  it('keeps unknown security-version evidence unknown and reports a below-floor candidate as incompatible', async () => {
    const { data, digest } = fixture();
    const image = verifySecureBootV2Image(data); image.secureVersion = 1;
    const state = await readEsp32S3SecureBootState(async (address) => deviceRegisters({ digest })(address), { model: 'ESP32-S3', revision: null });
    state.secureVersion = { value: null, status: 'unavailable' } as typeof state.secureVersion;
    expect(compareSecureBootTrust(image, state).result).toBe('UNKNOWN');
    state.secureVersion = { value: 2, status: 'verified' } as typeof state.secureVersion;
    expect(compareSecureBootTrust(image, state)).toMatchObject({ result: 'INCOMPATIBLE', trustedKeyMatch: true, securityVersionStatus: 'below-floor' });
  });
});
