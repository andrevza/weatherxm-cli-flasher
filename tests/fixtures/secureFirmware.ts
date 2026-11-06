import { createHash, generateKeyPairSync, sign, constants } from 'node:crypto';
import { WG1200_CONSTANTS } from '../../src/upstream/flasher/constants.js';

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

export function createSignedWeatherXmImage(version = '0.8.34', elfHash = '11'.repeat(32)) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 3072, publicExponent: 0x10001 });
  const jwk = publicKey.export({ format: 'jwk' });
  const modulus = reverse(new Uint8Array(Buffer.from(jwk.n!, 'base64url')));
  const exponent = Number.parseInt(Buffer.from(jwk.e!, 'base64url').toString('hex'), 16);
  const image = new Uint8Array(0x10000);
  image[0] = 0xe9; image[1] = 1; image[23] = 1;
  const header = new DataView(image.buffer);
  header.setUint16(12, 9, true);
  header.setUint32(24, 0x3fc80000, true);
  const descriptor = new Uint8Array(256);
  const descView = new DataView(descriptor.buffer);
  descView.setUint32(0, WG1200_CONSTANTS.APP_DESC_MAGIC, true);
  descView.setUint32(4, 0, true);
  const put = (offset: number, text: string, max: number) => descriptor.set(new TextEncoder().encode(text).subarray(0, max), offset);
  put(16, version, 32); put(48, 'weatherxm', 32); put(80, '12:00:00', 16); put(96, 'Nov 06 2026', 16); put(112, 'ESP-IDF v6.0.1', 32);
  descriptor.set(Buffer.from(elfHash, 'hex'), 144);
  header.setUint32(28, descriptor.length, true);
  image.set(descriptor, 32);
  let checksum = 0xef; for (const b of descriptor) checksum ^= b;
  const checksumOffset = 24 + 8 + descriptor.length + (15 - ((24 + 8 + descriptor.length) % 16));
  image[checksumOffset] = checksum;
  image.set(sha(image.subarray(0, checksumOffset + 1)), checksumOffset + 1);
  const block = new Uint8Array(4096); block.fill(0xff);
  block.set([0xe7, 2, 0, 0], 0); block.set(sha(image), 4); block.set(modulus, 36);
  new DataView(block.buffer).setUint32(420, exponent, true);
  const n = BigInt(`0x${Buffer.from(jwk.n!, 'base64url').toString('hex')}`);
  const r = (1n << 6144n) % n;
  block.set(reverse(bytesFromBigInt(r, 384)), 424);
  const n0 = Number(n & 0xffffffffn) >>> 0;
  let inverse = n0;
  for (let i = 0; i < 5; i++) inverse = Math.imul(inverse, 2 - Math.imul(n0, inverse)) >>> 0;
  new DataView(block.buffer).setUint32(808, (-inverse) >>> 0, true);
  const signature = sign('sha256', image, { key: privateKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 });
  block.set(reverse(new Uint8Array(signature)), 812);
  block.fill(0, 1200, 1216);
  new DataView(block.buffer).setUint32(1196, crc32(block.subarray(0, 1196)), true);
  const data = new Uint8Array(image.length + block.length); data.set(image); data.set(block, image.length);
  return { data, publicKeyDigest: Buffer.from(sha(block.subarray(36, 812))).toString('hex') };
}

