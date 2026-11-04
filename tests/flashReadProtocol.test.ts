import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ESPLoader } from 'esptool-js';
import '../src/upstream/flasher/transport.js';

const BLOCK_SIZE = 1024;

function dataFor(seed: number): Uint8Array {
  return Uint8Array.from({ length: BLOCK_SIZE }, (_unused, index) => (seed + index * 13) & 0xff);
}

function md5(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('md5').update(bytes).digest());
}

function makeLoader(frames: Uint8Array[]) {
  const events: string[] = [];
  const acknowledgements: Uint8Array[] = [];
  const loader = Object.create(ESPLoader.prototype) as any;
  loader.IS_STUB = true;
  loader.ESP_READ_FLASH = 0xd2;
  loader.FLASH_READ_TIMEOUT = 1000;
  loader.checkCommand = vi.fn(async (_name: string, opcode: number) => {
    events.push(`command:${opcode.toString(16)}`);
    return 0;
  });
  loader.transport = {
    read: vi.fn(async () => {
      const frame = frames.shift();
      if (!frame) throw new Error('Unexpected empty protocol fixture');
      events.push(frame.length === 16 ? 'digest' : 'data');
      return frame;
    }),
    write: vi.fn(async (ack: Uint8Array) => {
      acknowledgements.push(ack.slice());
      events.push(`ack:${ack[0] | (ack[1] << 8) | (ack[2] << 16) | (ack[3] << 24)}`);
    }),
  };
  return { loader, events, acknowledgements };
}

describe('ESP32 stub flash-read protocol', () => {
  it('consumes and verifies the trailing digest before starting the next D2 read', async () => {
    const firstBlocks = [dataFor(3), dataFor(7), dataFor(11), dataFor(17)];
    const secondBlocks = [dataFor(23), dataFor(29), dataFor(31), dataFor(37)];
    const firstData = new Uint8Array(BLOCK_SIZE * firstBlocks.length);
    const secondData = new Uint8Array(BLOCK_SIZE * secondBlocks.length);
    firstBlocks.forEach((block, index) => firstData.set(block, index * BLOCK_SIZE));
    secondBlocks.forEach((block, index) => secondData.set(block, index * BLOCK_SIZE));
    const frames = [...firstBlocks, md5(firstData), ...secondBlocks, md5(secondData)];
    const { loader, events, acknowledgements } = makeLoader(frames);

    await expect(loader.readFlash(0xc000, firstData.length)).resolves.toEqual(firstData);
    await expect(loader.readFlash(0xc000, secondData.length)).resolves.toEqual(secondData);

    expect(events).toEqual([
      'command:d2', 'data', 'ack:1024', 'data', 'ack:2048', 'data', 'ack:3072', 'data', 'ack:4096', 'digest',
      'command:d2', 'data', 'ack:1024', 'data', 'ack:2048', 'data', 'ack:3072', 'data', 'ack:4096', 'digest',
    ]);
    expect(acknowledgements).toHaveLength(8);
    expect(frames).toHaveLength(0);
  });

  it('rejects a bad final digest after consuming the complete transaction', async () => {
    const blocks = [dataFor(2), dataFor(5), dataFor(9), dataFor(13)];
    const wrongDigest = md5(new Uint8Array(BLOCK_SIZE * 4));
    const { loader, events } = makeLoader([...blocks, wrongDigest]);

    await expect(loader.readFlash(0xc000, BLOCK_SIZE * 4)).rejects.toThrow(/digest did not match/);
    expect(events.at(-1)).toBe('digest');
  });
});
