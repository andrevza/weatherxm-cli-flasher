import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { formatMonitorLine, formatSanitizedMonitorLine, monitorColorEnabled, monitorSerial, parseSerialLevel, resetForNormalBoot, writeMonitorOutput } from '../src/monitor.js';
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

  it('uses the same timestamped, severity-coloured presentation for monitor and OTA boot lines', () => {
    const raw = 'W (123) WiFi: credentials unavailable';
    const monitor = formatMonitorLine(raw, { timestamp: true, color: true });
    const ota = formatSanitizedMonitorLine(raw, { timestamp: true, color: true });
    expect(ota).toBe(monitor);
    expect(ota).toMatch(/^\u001b\[33m\d{4}-\d\d-\d\dT.* W \(123\) WiFi: credentials unavailable\u001b\[0m$/);
    const banner = formatSanitizedMonitorLine('WeatherXM WG1200 starting', { color: true });
    expect(banner).toBe('\u001b[36mWeatherXM WG1200 starting\u001b[0m');
  });

  it('keeps OTA and monitor logs plain when color is disabled, redirected, or NO_COLOR is set', () => {
    expect(monitorColorEnabled({ isTTY: true, env: { TERM: 'xterm-256color' } })).toBe(true);
    expect(monitorColorEnabled({ isTTY: true, noColor: true, env: { TERM: 'xterm-256color' } })).toBe(false);
    expect(monitorColorEnabled({ isTTY: true, env: { TERM: 'xterm-256color', NO_COLOR: '1' } })).toBe(false);
    expect(monitorColorEnabled({ isTTY: false, env: { TERM: 'xterm-256color' } })).toBe(false);
    expect(formatSanitizedMonitorLine('\u001b[31mE (9) fatal\u001b[0m', { timestamp: true, noColor: true, color: false }))
      .toMatch(/^\d{4}-\d\d-\d\dT.* E \(9\) fatal$/);
  });

  it('saves the same timestamped plain text that it displays without allowing decoration into boot evidence', () => {
    const rawEvidence = ['I (123) MAIN: booting', 'E (124) Guru Meditation Error: Core 0 panic'];
    const analysis = analyzeBootLogs(rawEvidence);
    const displayed: string[] = [];
    const saved: string[] = [];
    for (const line of rawEvidence) {
      const formatted = formatSanitizedMonitorLine(line, { timestamp: true, color: true })!;
      writeMonitorOutput(`${formatted}\n`, true, (text) => displayed.push(text), (text) => saved.push(text));
    }
    expect(displayed.join('').replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')).toBe(saved.join(''));
    expect(saved.join('')).not.toMatch(/\u001b\[/);
    expect(saved.join('')).toMatch(/^\d{4}-\d\d-\d\dT/m);
    expect(analysis.lines).toEqual(rawEvidence);
    expect(analysis.bootFailureObserved).toBe(true);
  });

  it('redacts multiline sensitive UART blocks before shared formatting', () => {
    const sanitizer = new LogSanitizer();
    const safe = [
      sanitizer.sanitizeLine('Certificate PEM:'),
      sanitizer.sanitizeLine('-----BEGIN CERTIFICATE-----'),
      sanitizer.sanitizeLine('SECRET-CERTIFICATE-CONTENT'),
      sanitizer.sanitizeLine('-----END CERTIFICATE-----'),
      sanitizer.sanitizeLine('I (130) MAIN: boot continues'),
    ].filter((line): line is string => line !== null);
    const output = safe.map((line) => formatSanitizedMonitorLine(line, { timestamp: true, noColor: true })).join('\n');
    expect(output).not.toContain('SECRET-CERTIFICATE-CONTENT');
    expect(output).toContain('[REDACTED_SENSITIVE_BLOCK_START]');
    expect(output).toContain('[REDACTED_SENSITIVE_BLOCK_END]');
    expect(output).toContain('boot continues');
  });

  it('keeps public-key redaction active across interleaved UART lines and fragmented byte rows', () => {
    // Model a UART reader splitting the stream at arbitrary byte boundaries;
    // line framing reassembles each line before LogSanitizer sees it.
    const stream = 'WS PubKey:\r\n=========================\r\n12 34\r\nI (42) UART: diagnostic\r\n56\r\n78 9a bc\r\n=========================\r\nI (43) MAIN: boot continues\r\n';
    const sanitizer = new LogSanitizer({ suppressRadioPayloads: true });
    const safe: string[] = [];
    let pending = '';
    for (let offset = 0; offset < stream.length;) {
      const width = (offset % 7) + 1;
      pending += stream.slice(offset, offset + width);
      offset += width;
      // Simulate the serial line framer used by monitorSerial.
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const sanitized = sanitizer.sanitizeLine(line.replace(/[\r\n]+$/, ''));
        if (sanitized !== null) safe.push(sanitized);
      }
    }
    const output = safe.join('\n');
    expect(output).toContain('I (42) UART: diagnostic');
    expect(output).toContain('I (43) MAIN: boot continues');
    expect(output).not.toMatch(/(?:12 34|56|78 9a bc)/);
    expect(output).toContain('[REDACTED PUBLIC KEY; 2 bytes]');
    expect(output).toContain('[REDACTED PUBLIC KEY; 1 bytes]');
    expect(output).toContain('[REDACTED PUBLIC KEY; 3 bytes]');
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

  it('still requests normal boot when log capture is disabled after a metadata commit', async () => {
    const port = { readable: null as ReadableStream<Uint8Array> | null, open: vi.fn(async () => { port.readable = new ReadableStream<Uint8Array>(); }), close: vi.fn(async () => {}) };
    const reset = vi.fn(async () => {});
    const result = await captureBootLogs(port, 0, undefined, expected, reset);
    expect(port.open).toHaveBeenCalledOnce();
    expect(reset).toHaveBeenCalledOnce();
    expect(port.close).toHaveBeenCalledOnce();
    expect(result.expectedSlotObserved).toBeNull();
  });

  it('starts the boot receiver before pulsing reset and captures the resulting boot text', async () => {
    const events: string[] = [];
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const port = {
      readable: null as ReadableStream<Uint8Array> | null,
      async open() { events.push('open'); this.readable = new ReadableStream<Uint8Array>({ start(value) { controller = value; } }); },
      async close() { events.push('close'); },
    };
    const resultPromise = captureBootLogs(port, 20, undefined, expected, async () => {
      events.push('reset');
      controller!.enqueue(new TextEncoder().encode('I boot: Loaded app from partition at offset 0x420000\r\nI secure_boot_v2: Signature verified successfully\r\n'));
    });
    const result = await resultPromise;
    expect(events[0]).toBe('open');
    expect(events[1]).toBe('reset');
    expect(result.expectedSlotObserved).toBe(true);
    expect(result.secureBootVerified).toBe(true);
    expect(result.lines.join('\n')).toContain('Signature verified successfully');
  });

  it('starts the full capture interval only after reset release and announces live capture afterward', async () => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const events: string[] = [];
    const port = {
      readable: null as ReadableStream<Uint8Array> | null,
      async open() { this.readable = new ReadableStream<Uint8Array>({ start(value) { controller = value; } }); },
      async close() { events.push('close'); },
    };
    const started = Date.now();
    const liveLines: string[] = [];
    const result = await captureBootLogs(port, 30, (line) => liveLines.push(line), expected, async () => {
      events.push('reset-start');
      await new Promise((resolve) => setTimeout(resolve, 35));
      controller!.enqueue(new TextEncoder().encode('I boot: Loaded app from partition at offset 0x420000\r\n'));
      events.push('reset-release');
    }, () => events.push('capture-start'));
    expect(events.slice(0, 3)).toEqual(['reset-start', 'reset-release', 'capture-start']);
    expect(Date.now() - started).toBeGreaterThanOrEqual(60);
    expect(result.expectedSlotObserved).toBe(true);
    expect(liveLines).toEqual(['I boot: Loaded app from partition at offset 0x420000']);
  });

  it('surfaces serial capture errors without converting missing evidence into a boot failure', async () => {
    const port = {
      readable: null as ReadableStream<Uint8Array> | null,
      async open() { throw new Error('USB adapter disappeared'); },
      async close() {},
    };
    const result = await captureBootLogs(port, 20, undefined, expected);
    expect(result.captureError).toContain('USB adapter disappeared');
    expect(result.bootFailureObserved).toBe(false);
    expect(result.expectedSlotObserved).toBeNull();
  });

  it('requires bootloader Secure Boot V2 and the explicit loaded-app offset markers', () => {
    expect(analyzeBootLogs(['secure boot verification succeeded', 'I boot: partition at offset 0x420000'], expected))
      .toMatchObject({ secureBootVerified: false, expectedSlotObserved: null });
    expect(analyzeBootLogs(['I secure_boot_v2: Signature verified successfully!', 'I boot: Loaded app from partition at offset 0x820000'], expected))
      .toMatchObject({ secureBootVerified: true, expectedSlotObserved: false });
  });

  it('records optional service health without requiring it for successful boot evidence', () => {
    const result = analyzeBootLogs([
      'I secure_boot_v2: Signature verified successfully!',
      'I boot: Loaded app from partition at offset 0x420000',
      'I app_init: App version: 0.8.35-gabc1234',
      'I main_task: Calling app_main()',
      'I WiFi: Got IP: 192.0.2.25',
      'I MQTT: connected successfully',
    ], expected);
    expect(result).toMatchObject({ secureBootVerified: true, expectedSlotObserved: true, expectedFirmwareObserved: true, applicationStarted: true });
    expect(result.health).toMatchObject({ wifiConnected: true, dhcpAddress: true, mqttConnected: true, httpServerStarted: false });
    const withoutMqtt = analyzeBootLogs(result.lines.slice(0, 4), expected);
    expect(withoutMqtt.applicationStarted).toBe(true);
    expect(withoutMqtt.health.mqttConnected).toBe(false);
  });

  it.each([
    { slot: 'ota_0', offset: '0x420000' },
    { slot: 'ota_1', offset: '0x820000' },
  ])('parses redacted physical $slot activation evidence and keeps optional services distinct', ({ offset }) => {
    const result = analyzeBootLogs([
      'I (812) secure_boot_v2: Signature verified successfully!',
      `I (906) boot: Loaded app from partition at offset ${offset}`,
      'I (1378) app_init: App version: 0.8.34-g86b609b',
      'I (1410) main_task: Calling app_main()',
      'I (1954) MAIN: LittleFS mounted successfully.',
      'W (2181) Utils: NVS diagnostics: initial=ESP_OK final=ESP_OK',
      'I (2696) Settings: All configuration keys loaded from NVS.',
      'I (11035) WiFi: Got IP: [REDACTED IP]',
      'Wi-Fi CONNECTED SUCCESSFULLY!',
      'Starting web server on port 80...',
      'I (11054) WebServer: Starting web server on port 80...',
      'I (11116) WiFi: Connected to internet!',
    ], { slotOffset: Number.parseInt(offset, 16), firmwareVersion: '0.8.34-g86b609b' });
    expect(result).toMatchObject({ secureBootVerified: true, expectedSlotObserved: true, expectedFirmwareObserved: true, applicationStarted: true });
    expect(result.health).toMatchObject({ littlefsMounted: true, nvsInitialized: true, wifiConnected: true,
      dhcpAddress: true, httpServerStarted: true, internetConnected: true, mqttConnected: false,
      weatherPacketReceived: false, stationReceptionComplete: false, stationActive: false });
    expect(result.healthDetails.nvs).toMatchObject({ status: 'VERIFIED', evidence: 'W (2181) Utils: NVS diagnostics: initial=ESP_OK final=ESP_OK', uptimeMs: 2181 });
    expect(result.healthDetails.configuration.status).toBe('VERIFIED');
    expect(result.healthDetails.httpServer).toMatchObject({ status: 'VERIFIED', startup: 'STARTING', reachable: { status: 'NOT_OBSERVED' } });
    expect(result.healthDetails.internet.status).toBe('VERIFIED');
    expect(result.healthDetails.mqtt.status).toBe('NOT_OBSERVED');
    expect(result.healthDetails.weatherStationPacket.status).toBe('NOT_OBSERVED');
    const json = JSON.parse(JSON.stringify(result));
    expect(json.healthDetails.httpServer).toMatchObject({ status: 'VERIFIED', startup: 'STARTING', evidence: 'I (11054) WebServer: Starting web server on port 80...', reachable: { status: 'NOT_OBSERVED' } });
    expect(json.healthDetails.internet).toMatchObject({ status: 'VERIFIED', evidence: 'I (11116) WiFi: Connected to internet!', uptimeMs: 11116 });
  });

  it('classifies service failures, filesystem recovery, MQTT recovery, station markers, ANSI, duplicates and timed evidence', () => {
    const result = analyzeBootLogs([
      '\u001b[31mE (100) LittleFS mount failed\u001b[0m',
      'I (250) LittleFS recovery completed by formatting filesystem',
      'I (300) LittleFS mounted successfully.',
      'E (400) NVS initialization failed: ESP_ERR_NVS_NO_FREE_PAGES',
      'W (500) MQTT connection failed: timeout',
      'I (2100) MQTT connected successfully',
      'I (2200) MQTT publish successful',
      'I (2300) Valid WS1001 weather packet decoded successfully',
      'I (2350) Weather station reception reached 65%',
      'I (2400) Weather station reception reached 100%',
      'I (2450) Weather station ownership confirmed',
      'I (2500) Station status: ACTIVE_OK',
      'I (2600) HTTP server started successfully and is listening',
      'I (2700) HTTP health check passed; server is accepting requests',
      'E (2800) Internet connectivity check failed',
      'I (3000) Wi-Fi connected successfully',
      'I (3100) Connected to internet!',
      'I (3200) MQTT connected successfully',
    ], expected);
    expect(result.healthDetails.littlefs).toMatchObject({ status: 'VERIFIED', uptimeMs: 300 });
    expect(result.healthDetails.filesystemRecovery.status).toBe('VERIFIED');
    expect(result.healthDetails.nvs.status).toBe('FAILED');
    expect(result.healthDetails.mqtt).toMatchObject({ status: 'VERIFIED', uptimeMs: 3200 });
    expect(result.healthDetails.weatherStationPacket.status).toBe('VERIFIED');
    expect(result.healthDetails.stationReception.status).toBe('VERIFIED');
    expect(result.healthDetails.stationReception.percentage).toBe(100);
    expect(result.healthDetails.stationOwnership.status).toBe('VERIFIED');
    expect(result.healthDetails.stationActive.status).toBe('VERIFIED');
    expect(result.healthDetails.httpServer).toMatchObject({ status: 'VERIFIED', startup: 'STARTED', reachable: { status: 'VERIFIED' } });
    expect(result.healthDetails.internet).toMatchObject({ status: 'VERIFIED', uptimeMs: 3100 });
  });

  it('does not promote partial lines, duplicate markers, or explicit failures into stronger service claims', () => {
    const result = analyzeBootLogs([
      'Starting web server on port 80...',
      'Starting web server on port 80...',
      'E WebServer: Failed to start HTTP server',
      'MQTT connection failed',
      'Weather station packet decode failed',
      'station communication failed',
    ], expected);
    expect(result.healthDetails.httpServer.startup).toBe('FAILED');
    expect(result.healthDetails.httpServer.reachable.status).toBe('NOT_OBSERVED');
    expect(result.healthDetails.mqtt.status).toBe('FAILED');
    expect(result.healthDetails.weatherStationPacket.status).toBe('FAILED');
    expect(result.healthDetails.stationActive.status).toBe('FAILED');
    const partialOnly = analyzeBootLogs(['I (11054) WebServer: Starting web server on por'], expected, true);
    expect(partialOnly.health.httpServerStarted).toBe(false);
    expect(partialOnly.healthDetails.httpServer.status).toBe('NOT_OBSERVED');
  });

  it('reports recovered NVS initialization and incomplete station reception without calling either a failure', () => {
    const result = analyzeBootLogs([
      'W (400) Utils: NVS diagnostics: initial=ESP_ERR_NVS_NO_FREE_PAGES final=ESP_OK',
      'I (9000) Packet reception percentage: 65%',
    ], expected);
    expect(result.healthDetails.nvs).toMatchObject({ status: 'VERIFIED', uptimeMs: 400 });
    expect(result.healthDetails.stationReception).toMatchObject({ status: 'NOT_OBSERVED', percentage: 65, uptimeMs: 9000 });
    expect(result.health.stationReceptionComplete).toBe(false);
  });

  it('keeps live lines and evidence analysis identical across fragmented UART reads', async () => {
    const encoder = new TextEncoder();
    const chunks = [
      'I (812) secure_boot_v2: Signature verified successfully!\r\nI (906) boot: Loaded app from partition at offset 0x420000\r\n',
      'W (2181) Utils: NVS diagnostics: initial=ESP_OK final=ESP_OK\r\nI (11054) WebServer: Starting web server on port ',
      '80...\r\nI (11116) WiFi: Connected to internet!\r\nI (12000) MQTT connected successfully\r\n',
    ];
    const readable = new ReadableStream<Uint8Array>({
      start(controller) { for (const chunk of chunks) controller.enqueue(encoder.encode(chunk)); controller.close(); },
    });
    const port = { readable, async close() {} };
    const live: string[] = [];
    const result = await captureBootLogs(port, 100, (line) => live.push(line), expected);
    expect(live).toEqual(result.lines);
    expect(result.healthDetails.nvs.status).toBe('VERIFIED');
    expect(result.healthDetails.httpServer.startup).toBe('STARTING');
    expect(result.healthDetails.internet.status).toBe('VERIFIED');
    expect(result.healthDetails.mqtt.status).toBe('VERIFIED');
  });
});
