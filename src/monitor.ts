import { SerialPort } from 'serialport';
import { StringDecoder } from 'node:string_decoder';
import { LogSanitizer } from './upstream/flasher/serialLog.js';
import { redactOutput } from './redaction.js';

export type MonitorLevel = 'error' | 'warn' | 'info' | 'debug' | 'verbose';
export interface MonitorOptions {
  portPath: string;
  baudRate?: number;
  timestamp?: boolean;
  level?: MonitorLevel;
  raw?: boolean;
  boot?: boolean;
  redact?: boolean;
  resetDelay?: (ms: number) => Promise<void>;
  noColor?: boolean;
  color?: boolean;
  header?: string;
  output?: (line: string) => void;
  signalSource?: NodeJS.EventEmitter;
  portFactory?: (options: Record<string, unknown>) => MonitorPort;
}
export interface MonitorPort {
  isOpen?: boolean;
  open(callback: (error: Error | null) => void): void;
  close(callback: (error?: Error | null) => void): void;
  on(event: string, listener: (...args: any[]) => void): unknown;
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
  set?(options: { dtr: boolean; rts: boolean }, callback: (error: Error | null) => void): void;
}

export async function resetForNormalBoot(port: MonitorPort, delay: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))): Promise<void> {
  if (!port.set) throw new Error('Serial port does not support RTS/DTR reset signals');
  const set = (dtr: boolean, rts: boolean) => new Promise<void>((resolve, reject) => port.set!({ dtr, rts }, (error) => error ? reject(error) : resolve()));
  try {
    // DTR maps to GPIO0 and RTS to EN in the esptool/CLI adapter convention.
    // These are active-low: keep GPIO0 released, pulse EN low, then release EN.
    await set(false, false);
    await delay(50);
    await set(false, true);
    await delay(120);
    await set(false, false);
    await delay(150);
  } catch (error) {
    try { await set(false, false); } catch { /* preserve the original failure */ }
    throw error;
  }
}

const rank: Record<MonitorLevel, number> = { error: 0, warn: 1, info: 2, debug: 3, verbose: 4 };
const ansi = /\u001b\[[0-?]*[ -/]*[@-~]/g;

/** Sends one already-rendered monitor chunk through the same redaction boundary for console and file sinks. */
export function writeMonitorOutput(
  rendered: string,
  redact: boolean,
  consoleWrite: (text: string) => void,
  fileWrite?: (text: string) => void,
): string {
  const safe = redact ? redactOutput(rendered) : rendered;
  consoleWrite(safe);
  fileWrite?.(safe.replace(ansi, ''));
  return safe;
}

export function parseSerialLevel(line: string): MonitorLevel | undefined {
  const clean = line.replace(ansi, '');
  const match = clean.match(/(?:^|\s)([EWIDV])\s*\([^)]*\)|\[([EWIDV])\]/i);
  const code = (match?.[1] ?? match?.[2])?.toUpperCase();
  return code ? ({ E: 'error', W: 'warn', I: 'info', D: 'debug', V: 'verbose' } as const)[code as 'E'|'W'|'I'|'D'|'V'] : undefined;
}

export function formatMonitorLine(line: string, options: Pick<MonitorOptions, 'timestamp'|'level'|'raw'|'noColor'|'color'> = {}): string | null {
  const sanitizer = new LogSanitizer();
  const safe = sanitizer.sanitizeLine(line);
  return safe === null ? null : formatSafeLine(safe, options);
}

function formatSafeLine(safe: string, options: Pick<MonitorOptions, 'timestamp'|'level'|'raw'|'noColor'|'color'>): string | null {
  if (safe === null || safe.length === 0) return null;
  const severity = parseSerialLevel(safe);
  if (options.level && severity && rank[severity] > rank[options.level]) return null;
  let output = (options.noColor || !options.color ? safe.replace(ansi, '') : safe);
  if (!options.raw) output = output.trimEnd();
  if (!options.raw && options.timestamp) output = `${new Date().toISOString()} ${output}`;
  if (!options.raw && !options.noColor && options.color && severity) {
    const color = severity === 'error' ? '31' : severity === 'warn' ? '33' : severity === 'debug' || severity === 'verbose' ? '90' : '32';
    output = `\u001b[${color}m${output}\u001b[0m`;
  }
  return output;
}

/** Opens a passive serial reader. It never changes DTR/RTS and sends no serial data. */
export async function monitorSerial(options: MonitorOptions): Promise<string[]> {
  const baudRate = options.baudRate ?? 115200;
  const factory = options.portFactory ?? ((openOptions) => new SerialPort(openOptions as any) as unknown as MonitorPort);
  // hupcl:false prevents POSIX macOS/Linux from dropping DTR on close. The
  // OS/USB driver may still change modem lines when the port is first opened.
  const port = factory({ path: options.portPath, baudRate, autoOpen: false, hupcl: false });
  const signalSource = options.signalSource ?? process;
  const lines: string[] = [];
  const sanitizer = new LogSanitizer({ suppressRadioPayloads: options.redact });
  const decoder = new StringDecoder('utf8');
  const pendingChunks: Buffer[] = [];
  let buffer = '';
  let stopped = false;
  let settled = false;
  let openResolved = false;
  let closeRequested = false;
  let resolveMonitor!: () => void;
  let rejectMonitor!: (error: Error) => void;
  const completion = new Promise<void>((resolve, reject) => { resolveMonitor = resolve; rejectMonitor = reject; });

  const writeLine = (rawLine: string) => {
    const safe = sanitizer.sanitizeLine(rawLine);
    if (safe === null) return;
    const line = formatSafeLine(safe, options);
    if (line === null) return;
    lines.push(safe.replace(ansi, ''));
    options.output?.(line);
  };
  const consume = (chunk: Buffer | Uint8Array) => {
    buffer += decoder.write(Buffer.from(chunk));
    const pieces = buffer.split(/\r?\n/);
    buffer = pieces.pop() ?? '';
    for (const piece of pieces) writeLine(piece);
  };
  const onData = (chunk: Buffer | Uint8Array) => {
    if (!openResolved) pendingChunks.push(Buffer.from(chunk));
    else consume(chunk);
  };
  const onError = (error: Error) => {
    if (!openResolved || stopped || settled) return;
    settled = true;
    rejectMonitor(new Error(`Serial monitor disconnected: ${error.message}`));
  };
  const onClose = () => {
    if (closeRequested || stopped || settled) return;
    settled = true;
    rejectMonitor(new Error('Serial monitor disconnected: USB serial port closed unexpectedly'));
  };
  const onSigint = () => {
    if (stopped) return;
    stopped = true;
    closeRequested = true;
    buffer += decoder.end();
    if (buffer.length) writeLine(buffer);
    buffer = '';
    port.close((error) => {
      settled = true;
      if (error) rejectMonitor(new Error(`Could not close serial monitor: ${error.message}`));
      else resolveMonitor();
    });
  };
  port.on('data', onData);
  port.on('error', onError);
  port.on('close', onClose);
  try {
    await new Promise<void>((resolve, reject) => port.open((error) => error ? reject(error) : resolve()));
    openResolved = true;
    signalSource.on('SIGINT', onSigint);
    options.output?.(options.header ?? `WeatherXM WG1200 — Serial Monitor\n${'─'.repeat(46)}\nPort        ${options.portPath}\nBaud        ${baudRate}\nMode        ${options.boot ? 'Normal-boot capture' : 'Passive / Receive-only'}\nStatus      CONNECTED\n\n${options.boot ? 'Resetting via RTS/EN; capturing startup...' : 'Listening for serial output...'}\nPress Ctrl+C to disconnect.\n`);
    if (options.boot) await resetForNormalBoot(port, options.resetDelay);
    for (const chunk of pendingChunks) consume(chunk);
    pendingChunks.length = 0;
    await completion;
  } catch (error) {
    if (port.isOpen && !closeRequested) await new Promise<void>((resolve) => port.close(() => resolve()));
    const message = error instanceof Error ? error.message : String(error);
    if (!/^Serial monitor disconnected:/.test(message) && !/^Could not close/.test(message)) {
      throw new Error(`Could not open passive serial monitor on ${options.portPath}: ${message}`);
    }
    throw error;
  } finally {
    signalSource.removeListener('SIGINT', onSigint);
    port.removeListener('data', onData);
    port.removeListener('error', onError);
    port.removeListener('close', onClose);
  }
  return lines;
}
