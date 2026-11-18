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
  captureError?: string;
  health: { littlefsMounted: boolean; nvsInitialized: boolean; wifiConnected: boolean; dhcpAddress: boolean; httpServerStarted: boolean;
    internetConnected: boolean; mqttConnected: boolean; weatherPacketReceived: boolean; stationReceptionComplete: boolean; stationActive: boolean };
  /** Evidence-rich service state. Legacy booleans above remain for existing JSON consumers. */
  healthDetails: BootHealthDetails;
}

export type BootHealthStatus = 'VERIFIED' | 'NOT_OBSERVED' | 'FAILED';
export interface BootHealthEvidence {
  status: BootHealthStatus;
  evidence: string | null;
  uptimeMs: number | null;
  reason: string | null;
}
export interface BootHealthDetails {
  littlefs: BootHealthEvidence;
  filesystemRecovery: BootHealthEvidence;
  nvs: BootHealthEvidence;
  configuration: BootHealthEvidence;
  wifi: BootHealthEvidence;
  dhcp: BootHealthEvidence;
  httpServer: BootHealthEvidence & { startup: 'NOT_OBSERVED' | 'STARTING' | 'STARTED' | 'FAILED'; reachable: BootHealthEvidence };
  internet: BootHealthEvidence;
  mqtt: BootHealthEvidence;
  weatherStationPacket: BootHealthEvidence;
  stationReception: BootHealthEvidence & { percentage: number | null };
  stationOwnership: BootHealthEvidence;
  stationActive: BootHealthEvidence;
}

export function analyzeBootLogs(lines: string[], expected: { slotOffset?: number; firmwareVersion?: string } = {}, incompleteFinalLine = false): BootLogAnalysis {
  const detected = detectBootEvidence(lines, expected, incompleteFinalLine);
  return { lines, rawText: lines.join('\n'), ...detected };
}

function detectBootEvidence(lines: string[], expected: { slotOffset?: number; firmwareVersion?: string }, incompleteFinalLine: boolean) {
  let detectedSign: BootLogAnalysis['detectedSign'] = 'none';
  let bootObserved = false;
  let observedSlot: number | undefined;
  let bootVersion: string | undefined;
  let expectedFirmwareObserved: boolean | null = null;
  let secureBootVerified = false;
  const bootFailureLines: string[] = [];
  let appStarted = false;
  const health = { littlefsMounted: false, nvsInitialized: false, wifiConnected: false, dhcpAddress: false, httpServerStarted: false,
    internetConnected: false, mqttConnected: false, weatherPacketReceived: false, stationReceptionComplete: false, stationActive: false };
  const emptyEvidence = (): BootHealthEvidence => ({ status: 'NOT_OBSERVED', evidence: null, uptimeMs: null, reason: 'No conclusive matching log evidence was captured.' });
  const healthDetails: BootHealthDetails = {
    littlefs: emptyEvidence(), filesystemRecovery: emptyEvidence(), nvs: emptyEvidence(), configuration: emptyEvidence(),
    wifi: emptyEvidence(), dhcp: emptyEvidence(),
    httpServer: { ...emptyEvidence(), startup: 'NOT_OBSERVED', reachable: emptyEvidence() },
    internet: emptyEvidence(), mqtt: emptyEvidence(), weatherStationPacket: emptyEvidence(),
    stationReception: { ...emptyEvidence(), percentage: null }, stationOwnership: emptyEvidence(), stationActive: emptyEvidence(),
  };
  const uptime = (line: string): number | null => {
    const match = line.match(/\b\w?\s*\((\d+)\)/);
    return match ? Number(match[1]) : null;
  };
  const record = (current: BootHealthEvidence, status: BootHealthStatus, line: string, reason: string | null = null): BootHealthEvidence =>
    ({ status, evidence: line, uptimeMs: uptime(line), reason });
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    // The capture window can end mid-UART line. Keep that text in the transcript,
    // but do not interpret its partial words as conclusive boot/service evidence.
    if (incompleteFinalLine && lineIndex === lines.length - 1) continue;
    const clean = line.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
    const lower = clean.toLowerCase();
    if (/secure_boot_v2[^\r\n]*signature verified successfully/i.test(clean)) secureBootVerified = true;
    const version = clean.match(/App version:\s*([^\s,;]+)/i)?.[1];
    if (version) {
      bootVersion ??= version;
      expectedFirmwareObserved = expected.firmwareVersion ? version === expected.firmwareVersion : null;
    }
    const partitionOffset = clean.match(/loaded app from partition at offset\s*(0x[0-9a-f]+|[0-9a-f]+)/i)?.[1];
    if (partitionOffset) {
      observedSlot = Number.parseInt(partitionOffset.replace(/^0x/i, ''), 16);
      bootObserved = true;
    }
    if (/esp-idf|boot:|rst:|configsip|entry 0x|load:0x|secure_boot_v2|app version:/i.test(clean)) bootObserved = true;
    if (/\bapp_main\b|application started|starting application|app startup complete/i.test(clean)) appStarted = true;
    const filesystemSuccess = /littlefs.*(?:mounted successfully|mount(?:ed)? successfully|mount(?:ed)? ok)|(?:mounted|mount(?:ed)? successfully).*littlefs/i.test(clean);
    const filesystemFailure = /littlefs.*(?:failed to mount|mount failed|mount error|mounting failed)/i.test(clean);
    if (filesystemSuccess) healthDetails.littlefs = record(healthDetails.littlefs, 'VERIFIED', clean);
    else if (filesystemFailure) healthDetails.littlefs = record(healthDetails.littlefs, 'FAILED', clean, 'LittleFS mount failed.');
    if (/littlefs.*(?:recover(?:y|ed|ing)|format(?:ted|ting)?)|(?:recover(?:y|ed|ing)|format(?:ted|ting)?).*littlefs/i.test(clean)) {
      healthDetails.filesystemRecovery = record(healthDetails.filesystemRecovery, 'VERIFIED', clean);
    }
    if (filesystemSuccess) health.littlefsMounted = true;

    const nvsDiagnostic = clean.match(/nvs diagnostics\s*:\s*initial\s*=\s*(ESP_OK|ESP_ERR_[A-Z0-9_]+)\s+final\s*=\s*(ESP_OK|ESP_ERR_[A-Z0-9_]+)/i);
    const nvsSuccess = Boolean(nvsDiagnostic && nvsDiagnostic[2].toUpperCase() === 'ESP_OK');
    const nvsFailure = nvsDiagnostic ? nvsDiagnostic[2].toUpperCase() !== 'ESP_OK'
      : /nvs.*(?:init(?:ialization)? failed|failed to init|ESP_ERR_[A-Z0-9_]+)|initial\s*=\s*ESP_ERR_|final\s*=\s*ESP_ERR_/i.test(clean);
    const configLoaded = /(?:all )?configuration keys loaded from nvs|settings loaded from nvs|configuration loaded successfully/i.test(clean);
    if (nvsSuccess) healthDetails.nvs = record(healthDetails.nvs, 'VERIFIED', clean,
      nvsDiagnostic![1].toUpperCase() === 'ESP_OK' ? null : 'Initial NVS diagnostics reported an error, but final initialization returned ESP_OK.');
    else if (nvsFailure) healthDetails.nvs = record(healthDetails.nvs, 'FAILED', clean, 'NVS initialization reported an ESP-IDF error.');
    if (configLoaded) {
      healthDetails.configuration = record(healthDetails.configuration, 'VERIFIED', clean);
      if (healthDetails.nvs.status !== 'VERIFIED') healthDetails.nvs = record(healthDetails.nvs, 'VERIFIED', clean, 'Successful configuration loading confirms NVS data was readable.');
    }
    health.nvsInitialized ||= nvsSuccess || configLoaded;

    const wifiSuccess = /wi[- ]?fi\s+(?:connected successfully|connection successful|connected|association successful|associated successfully)|got ip:/i.test(clean);
    const wifiFailure = /wi[- ]?fi.*(?:authentication failed|auth failed|connection failed|failed to connect|disconnected|association failed)|(?:auth|association) failed/i.test(clean);
    if (wifiSuccess) healthDetails.wifi = record(healthDetails.wifi, 'VERIFIED', clean);
    else if (wifiFailure) healthDetails.wifi = record(healthDetails.wifi, 'FAILED', clean, 'Wi-Fi association or connection failed.');
    const dhcpSuccess = /got ip:|dhcp.*(?:bound|lease|address assigned)/i.test(clean);
    const dhcpFailure = /dhcp.*(?:failed|failure|timeout|no offer)/i.test(clean);
    if (dhcpSuccess) healthDetails.dhcp = record(healthDetails.dhcp, 'VERIFIED', clean);
    else if (dhcpFailure) healthDetails.dhcp = record(healthDetails.dhcp, 'FAILED', clean, 'DHCP did not assign an address.');
    health.wifiConnected ||= wifiSuccess;
    health.dhcpAddress ||= dhcpSuccess;

    const httpFailure = /(?:http|web) server.*(?:failed to start|startup failed|start failed|error starting)|failed to start (?:the )?(?:http|web) server/i.test(clean);
    const httpStarted = /(?:http|web) server.*(?:started successfully|started|listening)|server started on port/i.test(clean);
    const httpStarting = /(?:starting|initializing) (?:the )?(?:http|web) server|(?:http|web) server.*starting/i.test(clean);
    if (httpFailure) {
      healthDetails.httpServer = { ...record(healthDetails.httpServer, 'FAILED', clean, 'HTTP server startup failed.'), startup: 'FAILED', reachable: healthDetails.httpServer.reachable };
    } else if (httpStarted) {
      healthDetails.httpServer = { ...record(healthDetails.httpServer, 'VERIFIED', clean), startup: 'STARTED', reachable: healthDetails.httpServer.reachable };
    } else if (httpStarting) {
      // Preserve the legacy signal that server startup was observed, while the
      // evidence-rich field explicitly says startup is still in progress.
      healthDetails.httpServer = { ...record(healthDetails.httpServer, 'VERIFIED', clean, 'Startup initiation is verified; completion and reachability were not observed.'), startup: 'STARTING', reachable: healthDetails.httpServer.reachable };
    }
    health.httpServerStarted ||= httpStarting || httpStarted;
    if (/http.*(?:reachable|health check passed|request handled|response sent)|(?:http|web) server.*accepting requests/i.test(clean)) {
      healthDetails.httpServer.reachable = record(healthDetails.httpServer.reachable, 'VERIFIED', clean);
    } else if (/http.*(?:unreachable|request failed|health check failed)/i.test(clean)) {
      healthDetails.httpServer.reachable = record(healthDetails.httpServer.reachable, 'FAILED', clean, 'HTTP reachability check failed.');
    }

    const internetSuccess = /connected to internet|internet connectivity.*(?:success|verified)|internet connected/i.test(clean);
    const internetFailure = /(?:internet|connectivity).*(?:connection failed|unavailable|not reachable|failed)|no internet connection/i.test(clean);
    if (internetSuccess) healthDetails.internet = record(healthDetails.internet, 'VERIFIED', clean);
    else if (internetFailure) healthDetails.internet = record(healthDetails.internet, 'FAILED', clean, 'Internet connectivity check failed.');
    health.internetConnected ||= internetSuccess;

    const mqttSuccess = /mqtt.*(?:connected successfully|connection successful|connected)|connected to mqtt|mqtt (?:publish|subscribe).*success/i.test(clean);
    const mqttFailure = /mqtt.*(?:connection failed|connect failed|disconnected|error|publish failed|subscribe failed)/i.test(clean);
    if (mqttSuccess) healthDetails.mqtt = record(healthDetails.mqtt, 'VERIFIED', clean);
    else if (mqttFailure) healthDetails.mqtt = record(healthDetails.mqtt, 'FAILED', clean, 'The latest MQTT connection or operation evidence indicates a failure/disconnection.');
    health.mqttConnected ||= mqttSuccess;

    const packetSuccess = /(?:valid )?ws\s*[- ]?1001\s+(?:weather )?packet (?:received|decoded)|weather[- ]station.*(?:valid )?packet (?:received|decoded)|packet decoded successfully/i.test(clean);
    const packetFailure = /weather[- ]station.*(?:packet (?:invalid|decode failed)|communication failed)|ws\s*[- ]?1001.*(?:invalid|decode error)/i.test(clean);
    if (packetSuccess) healthDetails.weatherStationPacket = record(healthDetails.weatherStationPacket, 'VERIFIED', clean);
    else if (packetFailure) healthDetails.weatherStationPacket = record(healthDetails.weatherStationPacket, 'FAILED', clean, 'Weather-station packet reception or decoding failed.');
    health.weatherPacketReceived ||= packetSuccess;
    const receptionPercent = clean.match(/\breception\b[^\d%]{0,40}(\d+(?:\.\d+)?)\s*%/i)?.[1];
    const receptionComplete = Boolean(receptionPercent && Number(receptionPercent) >= 100) || /weather[- ]station reception.*100\s*%|reception reached 100\s*%|packet reception.*100\s*%/i.test(clean);
    const receptionFailure = /weather[- ]station.*(?:reception failed|no packets|timeout)/i.test(clean);
    if (receptionComplete) healthDetails.stationReception = { ...record(healthDetails.stationReception, 'VERIFIED', clean), percentage: receptionPercent ? Number(receptionPercent) : 100 };
    else if (receptionPercent) healthDetails.stationReception = { ...record(healthDetails.stationReception, 'NOT_OBSERVED', clean, 'Reception progress was observed but did not reach completion.'), percentage: Number(receptionPercent) };
    else if (receptionFailure) healthDetails.stationReception = { ...record(healthDetails.stationReception, 'FAILED', clean, 'Station reception did not complete successfully.'), percentage: healthDetails.stationReception.percentage };
    health.stationReceptionComplete ||= receptionComplete;
    const ownershipSuccess = /(?:station|weather station).*(?:paired successfully|pairing complete|ownership confirmed|owned by this gateway|ownership verified)/i.test(clean);
    const ownershipFailure = /(?:station|weather station).*(?:pairing failed|ownership (?:missing|failed|not confirmed))/i.test(clean);
    if (ownershipSuccess) healthDetails.stationOwnership = record(healthDetails.stationOwnership, 'VERIFIED', clean);
    else if (ownershipFailure) healthDetails.stationOwnership = record(healthDetails.stationOwnership, 'FAILED', clean, 'Station pairing or ownership was not confirmed.');
    const stationActive = /(?:station(?: status)?|weather station).*\bACTIVE_OK\b|\bACTIVE_OK\b/i.test(clean);
    const stationInactive = /(?:station|weather station).*(?:inactive|not paired|ownership (?:missing|failed)|communication failed)/i.test(clean);
    if (stationActive) healthDetails.stationActive = record(healthDetails.stationActive, 'VERIFIED', clean);
    else if (stationInactive) healthDetails.stationActive = record(healthDetails.stationActive, 'FAILED', clean, 'Station is not active or ownership/communication failed.');
    health.stationActive ||= stationActive;
    if (/guru meditation|assert failed|panic(?:'ed)?|abort\(\)|invalid image|invalid signature|signature verification failed|no bootable app|boot failed|watchdog reset/i.test(clean)) {
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
    health,
    healthDetails,
  };
}

/**
 * Stateful log sanitizer that handles multiline certificate and private key blocks.
 */
export class LogSanitizer {
  private inRedactionBlock = false;

  private inRadioPacket = false;

  private inRadioPayload = false;

  private pendingIdentityBlock?: 'PUBLIC KEY' | 'SERIAL NUMBER';

  private identityHexBlock?: 'PUBLIC KEY' | 'SERIAL NUMBER';

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
      const identityLabel = trimmed.match(/\b(?:local\s+|cloud\s+)?WS\s+(PubKey|SN)\s*:/i)?.[1]?.toLowerCase();
      if (identityLabel) {
        this.pendingIdentityBlock = identityLabel === 'pubkey' ? 'PUBLIC KEY' : 'SERIAL NUMBER';
        this.identityHexBlock = undefined;
        return line;
      }
      if (this.identityHexBlock && /^={3,}\s*$/.test(trimmed)) {
        this.identityHexBlock = undefined;
        return line;
      }
      if (this.pendingIdentityBlock && /^={3,}\s*$/.test(trimmed)) {
        this.identityHexBlock = this.pendingIdentityBlock;
        this.pendingIdentityBlock = undefined;
        return line;
      }
      // UART diagnostics can be interleaved between rows of the identity dump.
      // Keep the block armed across those lines: only the explicit separator
      // ends it. Accept single-byte rows as well, since chunking/formatting can
      // split a hex dump at any byte boundary.
      if (this.identityHexBlock && /^(?:[0-9a-f]{2}(?:\s+|$))+$/i.test(trimmed)) {
        const bytes = trimmed.split(/\s+/).filter(Boolean).length;
        return `[REDACTED ${this.identityHexBlock}; ${bytes} bytes]`;
      }
      if (this.pendingIdentityBlock && /^(?:[0-9a-f]{2}(?:\s+|$))+$/i.test(trimmed)) {
        const bytes = trimmed.split(/\s+/).filter(Boolean).length;
        return `[REDACTED ${this.pendingIdentityBlock}; ${bytes} bytes]`;
      }

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
  resetAfterListenerReady?: () => Promise<void>,
  onCaptureStarted?: () => void,
): Promise<BootLogAnalysis> {
  if (!port) {
    return analyzeBootLogs([], expected);
  }
  if (durationMs <= 0) {
    if (resetAfterListenerReady) {
      const lines: string[] = [];
      try {
        if (!port.readable) await port.open({ baudRate: 115200 });
        await resetAfterListenerReady();
        await port.close();
      } catch (error) {
        lines.push(`[Normal-boot reset failed: ${error instanceof Error ? error.message : String(error)}]`);
        try { await port.close(); } catch { /* best effort */ }
      }
      return analyzeBootLogs(lines, expected);
    }
    return analyzeBootLogs([], expected);
  }
  const lines: string[] = [];
  let incompleteFinalLine = false;

  try {
    if (!port.readable) {
      await port.open({ baudRate: 115200 });
    }

    const textDecoder = new TextDecoderStream();
    const readableStreamClosed = port.readable.pipeTo(textDecoder.writable);
    const reader = textDecoder.readable.getReader();

    let buffer = '';
    const sanitizer = new LogSanitizer();
    let readPromise = reader.read();
    if (resetAfterListenerReady) await resetAfterListenerReady();
    // The requested capture interval begins only after the intentional reset
    // sequence has released EN. Reset assertion and settling are setup time.
    onCaptureStarted?.();
    const deadline = Date.now() + durationMs;

    while (Date.now() < deadline) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<{ value?: string; done: boolean }>((resolve) => {
        timer = setTimeout(() => resolve({ done: true }), Math.max(1, deadline - Date.now()));
      });
      const res = await Promise.race([readPromise, timeoutPromise]);
      if (timer) clearTimeout(timer);
      if (res.done) break;
      readPromise = reader.read();

      if (res.value) {
        buffer += res.value;
        const splitLines = buffer.split('\n');
        buffer = splitLines.pop() ?? '';

        for (const rawLine of splitLines) {
          const cleanLine = sanitizer.sanitizeLine(rawLine.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').trim());
          if (cleanLine !== null && cleanLine.length > 0) {
            lines.push(cleanLine);
            if (onLine) onLine(cleanLine);

          }
        }
      }
    }

    if (buffer.trim().length) {
      incompleteFinalLine = true;
      const cleanLine = sanitizer.sanitizeLine(buffer.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').trim());
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
    try { await port.close(); } catch { /* preserve the capture failure */ }
    const failed = analyzeBootLogs(lines, expected, incompleteFinalLine);
    failed.captureError = `Boot log capture failed: ${err instanceof Error ? err.message : String(err)}`;
    return failed;
  }

  return analyzeBootLogs(lines, expected, incompleteFinalLine);
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
