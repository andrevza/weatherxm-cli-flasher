// Adapted for the WG1200 CLI from WeatherXM/web-flasher commit 35b2ecc4ccb31799ecd720609786362a99b3e33a (Apache-2.0); downstream changes are documented in UPSTREAM_NOTICES.md.
export interface BootLogAnalysis {
  lines: string[];
  rawText: string;
  detectedSign: 'weatherxm' | 'meshtastic' | 'booting' | 'none';
  bootObserved: boolean;
  expectedSlotObserved: boolean | null;
  expectedFirmwareObserved: boolean | null;
  applicationHealthy: 'not-checked';
  bootFailureObserved: boolean;
  bootFailureLines: string[];
  bootVersion?: string;
  secureBootVerified: boolean;
  applicationStarted: boolean;
}

export function analyzeBootLogs(lines: string[], expected: { slotOffset?: number; firmwareVersion?: string } = {}): BootLogAnalysis {
  const detected = detectBootEvidence(lines, expected);
  return { lines, rawText: lines.join('\n'), ...detected };
}

function detectBootEvidence(lines: string[], expected: { slotOffset?: number; firmwareVersion?: string }) {
  let detectedSign: BootLogAnalysis['detectedSign'] = 'none';
  let bootObserved = false;
  let observedSlot: number | undefined;
  let bootVersion: string | undefined;
  let expectedFirmwareObserved: boolean | null = null;
  let secureBootVerified = false;
  const bootFailureLines: string[] = [];
  let appStarted = false;
  for (const line of lines) {
    const clean = line.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
    const lower = clean.toLowerCase();
    if (/signature verified successfully/i.test(clean)) secureBootVerified = true;
    const version = clean.match(/App version:\s*([^\s,;]+)/i)?.[1];
    if (version) {
      bootVersion ??= version;
      expectedFirmwareObserved = expected.firmwareVersion ? version === expected.firmwareVersion : null;
    }
    const partitionOffset = clean.match(/(?:loaded app from partition at offset|partition at offset)\s*(0x[0-9a-f]+|[0-9a-f]+)/i)?.[1];
    if (partitionOffset) {
      observedSlot = Number.parseInt(partitionOffset.replace(/^0x/i, ''), 16);
      bootObserved = true;
    }
    if (/esp-idf|boot:|rst:|configsip|entry 0x|load:0x|secure_boot_v2|app version:/i.test(clean)) bootObserved = true;
    if (/\bapp_main\b|application started|starting application|app startup complete/i.test(clean)) appStarted = true;
    if (/guru meditation|assert failed|panic(?:'ed)?|abort\(\)|invalid image|no bootable app|boot failed|watchdog reset/i.test(clean)) {
      bootFailureLines.push(clean);
      bootObserved = true;
    }
    if (lower.includes('weatherxm') || lower.includes('thingsboard') || lower.includes('wg1200')) detectedSign = 'weatherxm';
    else if (lower.includes('meshtastic') || lower.includes('lora') || lower.includes('sx1262') || lower.includes('mesh')) detectedSign = 'meshtastic';
    else if (bootObserved && detectedSign === 'none') detectedSign = 'booting';
  }
  return {
    detectedSign,
    bootObserved,
    expectedSlotObserved: expected.slotOffset === undefined || observedSlot === undefined ? null : observedSlot === expected.slotOffset,
    expectedFirmwareObserved,
    applicationHealthy: 'not-checked' as const,
    bootFailureObserved: bootFailureLines.length > 0,
    bootFailureLines,
    bootVersion,
    secureBootVerified,
    applicationStarted: appStarted,
  };
}

/**
 * Stateful log sanitizer that handles multiline certificate and private key blocks.
 */
export class LogSanitizer {
  private inRedactionBlock = false;

  private inRadioPacket = false;

  private inRadioPayload = false;

  public constructor(private readonly options: { suppressRadioPayloads?: boolean } = {}) {}

  public sanitizeLine(line: string): string | null {
    const trimmed = line.trim();

    if (/-----BEGIN [A-Z0-9\s]*(?:CERTIFICATE|PRIVATE KEY|KEY)-----/i.test(trimmed)) {
      this.inRedactionBlock = true;
      return '[REDACTED_SENSITIVE_BLOCK_START]';
    }

    if (this.inRedactionBlock && /-----END [A-Z0-9\s]*(?:CERTIFICATE|PRIVATE KEY|KEY)-----/i.test(trimmed)) {
      this.inRedactionBlock = false;
      return '[REDACTED_SENSITIVE_BLOCK_END]';
    }

    if (this.inRedactionBlock) {
      return null;
    }

    if (this.options.suppressRadioPayloads) {
      if (/---.*\bPacket\s+(?:Received|Response)\b.*---/i.test(trimmed)) {
        this.inRadioPacket = true;
        this.inRadioPayload = false;
        return line;
      }
      if (this.inRadioPacket && /^={3,}\s*$/.test(trimmed)) {
        if (this.inRadioPayload) {
          this.inRadioPayload = false;
          this.inRadioPacket = false;
        } else {
          this.inRadioPayload = true;
        }
        return line;
      }
      if (this.inRadioPayload && /^(?:[0-9a-f]{2}(?:\s+|$)){2,}$/i.test(trimmed)) {
        const bytes = trimmed.split(/\s+/).filter(Boolean).length;
        return `[REDACTED RADIO PAYLOAD; ${bytes} bytes]`;
      }
    }

    return line
      .replace(/[0-9a-fA-F]{64}/gi, (digest, index: number, source: string) => /sha-?256\s*[:=]?\s*$/i.test(source.slice(Math.max(0, index - 16), index)) ? digest : '[REDACTED_64_HEX]')
      .replace(/\b(wifi_password|pass|secret|token)\s*([:=])\s*\S+/gi, '$1$2[REDACTED]');
  }

  public sanitizeText(text: string): string {
    const lines = text.split('\n');
    const result: string[] = [];
    for (const l of lines) {
      const sanitized = this.sanitizeLine(l);
      if (sanitized !== null) {
        result.push(sanitized);
      }
    }
    return result.join('\n');
  }
}

/**
 * Sanitizes log output so no accidentally logged keys, NVS dumps, or certificates can leak.
 */
export function sanitizeLog(text: string): string {
  const sanitizer = new LogSanitizer();
  return sanitizer.sanitizeText(text);
}

/**
 * Reopens serial port at 115200 baud to capture post-flash boot messages.
 */
export async function captureBootLogs(
  port: any,
  durationMs = 15000,
  onLine?: (line: string) => void,
  expected: { slotOffset?: number; firmwareVersion?: string } = {},
): Promise<BootLogAnalysis> {
  if (!port) {
    return analyzeBootLogs([], expected);
  }
  if (durationMs <= 0) return analyzeBootLogs([], expected);
  const lines: string[] = [];

  try {
    if (!port.readable) {
      await port.open({ baudRate: 115200 });
    }

    const textDecoder = new TextDecoderStream();
    const readableStreamClosed = port.readable.pipeTo(textDecoder.writable);
    const reader = textDecoder.readable.getReader();

    let buffer = '';
    const deadline = Date.now() + durationMs;
    const sanitizer = new LogSanitizer();

    while (Date.now() < deadline) {
      const readPromise = reader.read();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<{ value?: string; done: boolean }>((resolve) => {
        timer = setTimeout(() => resolve({ done: true }), Math.max(1, deadline - Date.now()));
      });
      const res = await Promise.race([readPromise, timeoutPromise]);
      if (timer) clearTimeout(timer);
      if (res.done) break;

      if (res.value) {
        buffer += res.value;
        const splitLines = buffer.split('\n');
        buffer = splitLines.pop() ?? '';

        for (const rawLine of splitLines) {
          const cleanLine = sanitizer.sanitizeLine(rawLine.trim());
          if (cleanLine !== null && cleanLine.length > 0) {
            lines.push(cleanLine);
            if (onLine) onLine(cleanLine);

          }
        }
      }
    }

    if (buffer.trim().length) {
      const cleanLine = sanitizer.sanitizeLine(buffer.trim());
      if (cleanLine !== null) {
        lines.push(cleanLine);
        onLine?.(cleanLine);
      }
    }

    try {
      await reader.cancel();
      await readableStreamClosed.catch(() => {});
      await port.close();
    } catch (e) {
      // Ignore close errors
    }
  } catch (err: any) {
    lines.push(`[Log capture completed or port closed: ${err.message ?? err}]`);
  }

  return analyzeBootLogs(lines, expected);
}

/**
 * Triggers a browser download of the technical log as a .txt file.
 */
export function downloadLogFile(lines: string[], filename = 'wg1200_flasher_log.txt'): void {
  const content = sanitizeLog(lines.join('\n'));
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
