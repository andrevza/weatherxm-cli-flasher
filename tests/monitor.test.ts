import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { formatMonitorLine, monitorSerial, parseSerialLevel } from '../src/monitor.js';
import { analyzeBootLogs, captureBootLogs } from '../src/upstream/flasher/serialLog.js';

class FakeMonitorPort extends EventEmitter {
  isOpen = false;
  openedOptions?: Record<string, unknown>;
  openCallback?: (error: Error | null) => void;
  closeCount = 0;
  open(callback: (error: Error | null) => void) { this.openCallback = callback; }
  openNow() { this.isOpen = true; this.openCallback?.(null); }
  close(callback: (error?: Error | null) => void) { this.isOpen = false; this.closeCount++; this.emit('close'); callback(null); }
  send(value: string | Uint8Array) { this.emit('data', Buffer.from(value)); }
}

describe('passive serial monitor', () => {
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
