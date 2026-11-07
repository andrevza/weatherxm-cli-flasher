import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { Transport } from 'esptool-js';
import { NodeSerialPort, type SerialPortFactory } from '../src/nodeSerialPort.js';

class FakePort extends EventEmitter {
  isOpen = true;
  written: Buffer[] = [];
  signalHistory: Array<{ dtr: boolean; rts: boolean }> = [];
  drainCallback?: (error: Error | null) => void;
  pauseCount = 0;
  resumeCount = 0;

  open(callback: (error: Error | null) => void) { callback(null); }
  write(chunk: Buffer, callback: (error: Error | null) => void) { this.written.push(Buffer.from(chunk)); callback(null); }
  drain(callback: (error: Error | null) => void) { this.drainCallback = callback; }
  update(_options: { baudRate: number }, callback: (error: Error | null) => void) { callback(null); }
  set(options: { dtr: boolean; rts: boolean }, callback: (error: Error | null) => void) { this.signalHistory.push(options); callback(null); }
  pause() { this.pauseCount++; return this; }
  resume() { this.resumeCount++; return this; }
  close(callback: () => void) { this.isOpen = false; this.emit('close'); callback(); }
  send(...bytes: number[]) { this.emit('data', Buffer.from(bytes)); }
}

function slip(payload: Uint8Array): Uint8Array {
  const framed = [0xc0];
  for (const byte of payload) {
    if (byte === 0xc0) framed.push(0xdb, 0xdc);
    else if (byte === 0xdb) framed.push(0xdb, 0xdd);
    else framed.push(byte);
  }
  framed.push(0xc0);
  return Uint8Array.from(framed);
}

async function makeTransport() {
  const port = new FakePort();
  const adapter = new NodeSerialPort('/dev/fake', undefined, (() => port) as unknown as SerialPortFactory);
  const transport = new Transport(adapter);
  await transport.connect(115200);
  // ESPLoader starts this background consumer as part of its connection setup.
  void transport.readLoop();
  return { port, adapter, transport };
}

describe('NodeSerialPort transport contract', () => {
  it('reports serial-open lifecycle only after the actual port open succeeds', async () => {
    const port = new FakePort(); const lifecycle: string[] = [];
    const adapter = new NodeSerialPort('/dev/fake', undefined, (() => port) as unknown as SerialPortFactory, false,
      (stage, state) => lifecycle.push(`${stage}:${state}`));
    await adapter.open({ baudRate: 115200 });
    expect(lifecycle).toEqual(['Opening serial port /dev/fake:start', 'Opening serial port /dev/fake:complete']);
    await adapter.close();
  });

  it('keeps modem-line transitions quiet in ordinary mode and exposes each transition in detailed mode', async () => {
    const ordinaryPort = new FakePort(); const ordinaryEvents: string[] = [];
    const ordinary = new NodeSerialPort('/dev/fake', undefined, (() => ordinaryPort) as unknown as SerialPortFactory, false,
      (stage, state) => ordinaryEvents.push(`${stage}:${state}`));
    await ordinary.open({ baudRate: 115200 });
    await ordinary.setSignals({ dataTerminalReady: false, requestToSend: false });
    await ordinary.setSignals({ dataTerminalReady: false, requestToSend: false });
    await ordinary.setSignals({ dataTerminalReady: false, requestToSend: true });
    await ordinary.setSignals({ dataTerminalReady: false, requestToSend: false });
    expect(ordinaryEvents.filter((event) => event.startsWith('Applying RTS/DTR'))).toEqual([]);
    expect(ordinaryPort.signalHistory).toEqual([{ dtr: false, rts: false }, { dtr: false, rts: true }, { dtr: false, rts: false }]);
    await ordinary.close();

    const detailedPort = new FakePort(); const detailedEvents: string[] = [];
    const detailed = new NodeSerialPort('/dev/fake', undefined, (() => detailedPort) as unknown as SerialPortFactory, false,
      (stage, state) => detailedEvents.push(`${stage}:${state}`), true);
    await detailed.open({ baudRate: 115200 });
    await detailed.setSignals({ dataTerminalReady: false, requestToSend: false });
    await detailed.setSignals({ dataTerminalReady: false, requestToSend: true });
    await detailed.setSignals({ dataTerminalReady: false, requestToSend: false });
    expect(detailedEvents.filter((event) => event.startsWith('Applying RTS/DTR'))).toEqual([
      'Applying RTS/DTR reset signals:start', 'Applying RTS/DTR reset signals:complete',
      'Applying RTS/DTR reset signals:start', 'Applying RTS/DTR reset signals:complete',
    ]);
    await detailed.close();
  });

  it('reassembles a SLIP packet fragmented across serial data events', async () => {
    const { port, transport } = await makeTransport();
    const payload = Uint8Array.from([0x10, 0x20, 0xc0, 0xdb, 0x30]);
    const frame = slip(payload);
    const received = transport.read(500);
    port.send(...frame.slice(0, 2));
    port.send(...frame.slice(2, 5));
    port.send(...frame.slice(5));
    expect(await received).toEqual(payload);
    await transport.disconnect();
  });

  it('returns multiple SLIP packets that arrive in one serial read without dropping the next frame', async () => {
    const { port, transport } = await makeTransport();
    const first = slip(Uint8Array.from([1, 2, 3]));
    const second = slip(Uint8Array.from([4, 5, 6]));
    const joined = new Uint8Array(first.length + second.length);
    joined.set(first); joined.set(second, first.length);
    const firstRead = transport.read(500);
    port.emit('data', Buffer.from(joined));
    expect(await firstRead).toEqual(Uint8Array.from([1, 2, 3]));
    expect(await transport.read(500)).toEqual(Uint8Array.from([4, 5, 6]));
    await transport.disconnect();
  });

  it('preserves escape sequences split at a partial-read boundary', async () => {
    const { port, transport } = await makeTransport();
    const received = transport.read(500);
    port.send(0xc0, 0x01, 0xdb);
    port.send(0xdc, 0x02, 0xdb);
    port.send(0xdd, 0xc0);
    expect(await received).toEqual(Uint8Array.from([0x01, 0xc0, 0x02, 0xdb]));
    await transport.disconnect();
  });

  it('does not resolve a Web Serial write until serialport has drained it to the device', async () => {
    const { port, adapter } = await makeTransport();
    const writer = adapter.writable!.getWriter();
    let settled = false;
    const write = writer.write(Uint8Array.from([0xc0, 0x01, 0xc0])).then(() => { settled = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(port.written).toHaveLength(1);
    expect(port.drainCallback).toBeTypeOf('function');
    expect(settled).toBe(false);
    port.drainCallback!(null);
    await write;
    expect(settled).toBe(true);
    await writer.close();
    await adapter.close();
  });

  it('retains a delayed response while the reader is waiting', async () => {
    const { port, transport } = await makeTransport();
    const read = transport.read(500);
    await new Promise((resolve) => setTimeout(resolve, 25));
    port.send(...slip(Uint8Array.from([0xaa, 0xbb])));
    expect(await read).toEqual(Uint8Array.from([0xaa, 0xbb]));
    await transport.disconnect();
  });

  it('reports stream closure during an active read without throwing from late data events', async () => {
    const { port, transport } = await makeTransport();
    const read = transport.read(30);
    port.isOpen = false;
    port.emit('close');
    await expect(read).rejects.toThrow(/Serial data stream stopped/);
    await transport.disconnect();
  });

  it('preserves all frames in a large flash-read response delivered in one event', async () => {
    const { port, transport } = await makeTransport();
    const payloads = Array.from({ length: 16 }, (_, packet) => Uint8Array.from(
      { length: 1024 }, (_unused, index) => (packet * 17 + index) & 0xff,
    ));
    const frames = payloads.map(slip);
    const combined = new Uint8Array(frames.reduce((sum, frame) => sum + frame.length, 0));
    let offset = 0;
    for (const frame of frames) { combined.set(frame, offset); offset += frame.length; }
    const firstRead = transport.read(1000);
    port.emit('data', Buffer.from(combined));
    for (let packet = 0; packet < payloads.length; packet++) {
      const actual = packet === 0 ? await firstRead : await transport.read(1000);
      expect(actual).toEqual(payloads[packet]);
    }
    await transport.disconnect();
  });
});
