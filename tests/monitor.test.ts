import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { formatMonitorLine, monitorSerial, parseSerialLevel, resetForNormalBoot, writeMonitorOutput } from '../src/monitor.js';
import { analyzeBootLogs, captureBootLogs } from '../src/upstream/flasher/serialLog.js';
import { LogSanitizer } from '../src/upstream/flasher/serialLog.js';

class FakeMonitorPort extends EventEmitter {
  isOpen = false;
  openedOptions?: Record<string, unknown>;
  openCallback?: (error: Error | null) => void;
  closeCount = 0;
  open(callback: (error: Error | null) => void) { this.openCallback = callback; }
  openNow() { this.isOpen = true; this.openCallback?.(null); }
  close(callback: (error?: Error | null) => void) { this.isOpen = false; this.closeCount++; this.emit('close'); callback(null); }
  send(value: string | Uint8Array) { this.emit('data', Buffer.from(value)); }
  signals: Array<{ dtr: boolean; rts: boolean }> = [];
  set(options: { dtr: boolean; rts: boolean }, callback: (error: Error | null) => void) { this.signals.push(options); callback(null); if (options.rts === false && this.signals.length === 3) this.send('ROM boot\r\nI bootloader: ready\r\nI app: started\r\n'); }
}

describe('passive serial monitor', () => {
  it('redacts fragmented JSON and radio payloads identically for console and output-file sinks', async () => {
    const port = new FakeMonitorPort();
    const signals = new EventEmitter();
    const consoleOutput: string[] = [];
    const fileOutput: string[] = [];
    const monitoring = monitorSerial({
      portPath: '/dev/fake', redact: true, signalSource: signals, portFactory: () => port,
      output: (rendered) => writeMonitorOutput(rendered, true, (value) => consoleOutput.push(value), (value) => fileOutput.push(value)),
    });
    port.openNow();
    await Promise.resolve();
    port.send('I (123) Submit: Remote Settings JSON {"client":{"ws_fo_id":"0x00A1B2C3"},');
    port.send('"shared":{"name":"Synthetic Gateway"}}\r\n');
    port.send('--- WS1001 Packet Received ---\r\nRSSI: -67, SNR: 8\r\n=========================\r\n01 02 ');
    port.send('ab cd\r\n=========================\r\n');
    port.send('WS PubKey:\r\n=========================\r\n12 34 56 78\r\n=========================\r\n');
    port.send('WS SN:\r\n=========================\r\nab cd ef\r\n=========================\r\n');
    signals.emit('SIGINT');
    await monitoring;
    const consoleText = consoleOutput.join('');
    expect(consoleText).toBe(fileOutput.join(''));
    expect(consoleText).toContain('"ws_fo_id":"[REDACTED STATION ID]"');
    expect(consoleText).toContain('"name":"[REDACTED DEVICE NAME]"');
    expect(consoleText).toContain('RSSI: -67, SNR: 8');
    expect(consoleText).toContain('[REDACTED RADIO PAYLOAD; 4 bytes]');
    expect(consoleText).toContain('[REDACTED PUBLIC KEY; 4 bytes]');
    expect(consoleText).toContain('[REDACTED SERIAL NUMBER; 3 bytes]');
    expect(consoleText).not.toContain('0x00A1B2C3');
    expect(consoleText).not.toContain('01 02 ab cd');
    expect(consoleText).not.toContain('Synthetic Gateway');
    expect(consoleText).not.toContain('12 34 56 78');
    expect(consoleText).not.toContain('ab cd ef');
  });

  it('suppresses radio payload byte rows in redacted mode while retaining packet diagnostics', () => {
    const sanitizer = new LogSanitizer({ suppressRadioPayloads: true });
    expect(sanitizer.sanitizeLine('--- WS1300 Packet Received ---')).toContain('Packet Received');
    expect(sanitizer.sanitizeLine('RSSI: -91, SNR: 7.5')).toBe('RSSI: -91, SNR: 7.5');
    expect(sanitizer.sanitizeLine('--- WS1300 ADV Packet Decoded Parameters ---')).toContain('Decoded Parameters');
    expect(sanitizer.sanitizeLine('=========================')).toBe('=========================');
    expect(sanitizer.sanitizeLine('01 02 ab cd')).toBe('[REDACTED RADIO PAYLOAD; 4 bytes]');
    expect(sanitizer.sanitizeLine('=========================')).toBe('=========================');
    expect(sanitizer.sanitizeLine('--- WS1300 Packet Response ---')).toContain('Packet Response');
    expect(sanitizer.sanitizeLine('=========================')).toBe('=========================');
    expect(sanitizer.sanitizeLine('aa bb cc')).toBe('[REDACTED RADIO PAYLOAD; 3 bytes]');
    expect(sanitizer.sanitizeLine('=========================')).toBe('=========================');
    expect(sanitizer.sanitizeLine('reset=1 load=0x820000')).toBe('reset=1 load=0x820000');
  });

  it('keeps labeled SHA-256 diagnostics while masking unlabeled 64-digit values', () => {
    const sanitizer = new LogSanitizer();
    const hash = 'a'.repeat(64);
    expect(sanitizer.sanitizeLine(`SHA-256: ${hash}`)).toBe(`SHA-256: ${hash}`);
    expect(sanitizer.sanitizeLine(hash)).toBe('[REDACTED_64_HEX]');
  });
  it('shows CONNECTED only after open and uses a receive-only open configuration', async () => {
    const port = new FakeMonitorPort();
    const signals = new EventEmitter();
    const output: string[] = [];
    const portFactory = vi.fn((options: Record<string, unknown>) => { port.openedOptions = options; return port; });
    const monitoring = monitorSerial({ portPath: '/dev/fake', signalSource: signals, portFactory, output: (line) => output.push(line) });
    await Promise.resolve();
    expect(output).toEqual([]);
    expect(port.openedOptions).toMatchObject({ autoOpen: false, hupcl: false });
    expect('write' in port).toBe(false);
    port.openNow();
    await Promise.resolve();
    expect(output.join('')).toContain('Status      CONNECTED');
    expect(output.join('')).toContain('Listening for serial output...');
    signals.emit('SIGINT');
    await expect(monitoring).resolves.toEqual([]);
    expect(port.closeCount).toBe(1);
    expect(port.eventNames()).not.toContain('data');
  });

  it('streams complete lines, handles chunk boundaries, and stays silent without received data', async () => {
    const port = new FakeMonitorPort();
    const signals = new EventEmitter();
    const output: string[] = [];
    const monitoring = monitorSerial({ portPath: '/dev/fake', signalSource: signals, portFactory: () => port, output: (line) => output.push(line) });
    port.openNow();
    await Promise.resolve();
    const headerCount = output.length;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(output).toHaveLength(headerCount);
    port.send('I (123) app: firmware st');
    expect(output).toHaveLength(headerCount);
    port.send('arted\r\n');
    expect(output.at(-1)).toContain('I (123) app: firmware started');
    signals.emit('SIGINT');
    await monitoring;
  });

  it('reports unexpected USB disconnects and rejects open failures clearly', async () => {
    const disconnected = new FakeMonitorPort();
    const signals = new EventEmitter();
    const pending = monitorSerial({ portPath: '/dev/fake', signalSource: signals, portFactory: () => disconnected });
    disconnected.openNow();
    disconnected.emit('close');
    await expect(pending).rejects.toThrow(/USB serial port closed unexpectedly/);

    const failed = new FakeMonitorPort();
    const openFailure = monitorSerial({ portPath: '/dev/missing', signalSource: signals, portFactory: () => failed });
    failed.openCallback?.(new Error('no such device'));
    await expect(openFailure).rejects.toThrow(/Could not open passive serial monitor on \/dev\/missing/);

    const errored = new FakeMonitorPort();
    const serialError = monitorSerial({ portPath: '/dev/fake', signalSource: signals, portFactory: () => errored });
    errored.openNow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    errored.emit('error', new Error('adapter failure'));
    await expect(serialError).rejects.toThrow(/Serial monitor disconnected: adapter failure/);
  });

  it('captures a continuous ROM-to-app stream with receiver installed before normal-boot reset', async () => {
    const port = new FakeMonitorPort();
    const signals = new EventEmitter();
    const output: string[] = [];
    const delays: number[] = [];
    const monitoring = monitorSerial({ portPath: '/dev/fake', boot: true, resetDelay: async (ms) => { delays.push(ms); }, signalSource: signals, portFactory: () => port, output: (line) => output.push(line) });
    await Promise.resolve();
    expect(port.eventNames()).toContain('data');
    expect(port.listenerCount('data')).toBe(1);
    port.openNow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(port.signals).toEqual([{ dtr: false, rts: false }, { dtr: false, rts: true }, { dtr: false, rts: false }]);
    expect(delays).toEqual([50, 120, 150]);
    expect(output.join('')).toContain('ROM boot');
    expect(output.join('')).toContain('I app: started');
    signals.emit('SIGINT');
    await monitoring;
    expect(port.closeCount).toBe(1);
  });

  it('restores deasserted reset signals if the reset pulse fails', async () => {
    const port = new FakeMonitorPort();
    port.set = (options, callback) => { port.signals.push(options); callback(port.signals.length === 2 ? new Error('signal failure') : null); };
    await expect(resetForNormalBoot(port, async () => {})).rejects.toThrow('signal failure');
    expect(port.signals.at(-1)).toEqual({ dtr: false, rts: false });
  });

  it('parses severity, applies filters, timestamps, raw mode and no-color mode', () => {
    expect(parseSerialLevel('\u001b[32mI (123) tag: started\u001b[0m')).toBe('info');
    expect(formatMonitorLine('D (123) tag: detail', { level: 'info' })).toBeNull();
    expect(formatMonitorLine('\u001b[32mI (123) tag: started\u001b[0m', { noColor: true })).toBe('I (123) tag: started');
    expect(formatMonitorLine('W (123) tag: warning', { timestamp: true })).toMatch(/^\d{4}-\d\d-\d\dT.* W \(123\) tag: warning$/);
    expect(formatMonitorLine('I (123) tag: raw', { raw: true, timestamp: true })).toBe('I (123) tag: raw');
  });
});

describe('boot log evidence', () => {
  const expected = { slotOffset: 0x420000, firmwareVersion: '0.8.35-gabc1234' };
  it('reports expected slot, version, secure-boot, application startup and failure evidence independently', () => {
    const result = analyzeBootLogs([
      'I boot: Loaded app from partition at offset 0x420000',
      'I secure_boot_v2: Signature verified successfully',
      'I app: App version: 0.8.35-gabc1234',
      'I app_main: application started',
    ], expected);
    expect(result).toMatchObject({ bootObserved: true, expectedSlotObserved: true, expectedFirmwareObserved: true, secureBootVerified: true, applicationStarted: true, bootFailureObserved: false, applicationHealthy: 'not-checked' });
  });

  it('distinguishes missing evidence from an observed slot/version mismatch and explicit boot failure', () => {
    const missing = analyzeBootLogs(['noise without boot metadata'], expected);
    expect(missing).toMatchObject({ bootObserved: false, expectedSlotObserved: null, expectedFirmwareObserved: null, bootFailureObserved: false, applicationHealthy: 'not-checked' });
    const mismatch = analyzeBootLogs(['I boot: Loaded app from partition at offset 0x820000', 'I app: App version: 0.8.34'], expected);
    expect(mismatch).toMatchObject({ expectedSlotObserved: false, expectedFirmwareObserved: false });
    const failure = analyzeBootLogs(['Guru Meditation Error: Core 0 panic\'ed'], expected);
    expect(failure.bootFailureObserved).toBe(true);
  });

  it('does not open a serial device when post-flash boot capture is disabled', async () => {
    const port = { open: vi.fn(), close: vi.fn() };
    const result = await captureBootLogs(port, 0, undefined, expected);
    expect(port.open).not.toHaveBeenCalled();
    expect(result.bootObserved).toBe(false);
    expect(result.expectedSlotObserved).toBeNull();
  });
});
