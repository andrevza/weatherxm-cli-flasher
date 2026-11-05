const sensitiveKey = /^(?:mac(?:address)?|device(?:name|id|identifier)?|gateway(?:id|identifier)?|serial(?:number|no)?|commonname|fingerprint|certificatefingerprint|publickeyhash|publickey|certificate|identity)$/i;

function redactJsonValue(value: unknown, key?: string): unknown {
  const normalizedKey = key?.replace(/[_ -]/g, '').toLowerCase();
  if (normalizedKey && sensitiveKey.test(normalizedKey) && normalizedKey === 'identity' && value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redactJsonValue(child, childKey)]));
  }
  if (normalizedKey && sensitiveKey.test(normalizedKey)) {
    if (normalizedKey.includes('mac')) return value === null ? null : '[REDACTED MAC]';
    if (normalizedKey.includes('fingerprint')) return value === null ? null : '[REDACTED CERTIFICATE FINGERPRINT]';
    if (normalizedKey.includes('commonname')) return value === null ? null : '[REDACTED COMMON NAME]';
    if (normalizedKey.includes('serial')) return value === null ? null : '[REDACTED SERIAL NUMBER]';
    if (normalizedKey.includes('publickey')) return value === null ? null : '[REDACTED PUBLIC KEY]';
    if (normalizedKey.includes('certificate')) return value === null ? null : '[REDACTED CERTIFICATE]';
    return value === null ? null : '[REDACTED DEVICE ID]';
  }
  if (Array.isArray(value)) return value.map((item) => redactJsonValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redactJsonValue(child, childKey)]));
  }
  return value;
}

/** Redacts known device identifiers in structured JSON or human-readable diagnostics. */
export function redactOutput(input: string): string {
  const trimmed = input.trim();
  if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && (trimmed.endsWith('}') || trimmed.endsWith(']'))) {
    try {
      const parsed = JSON.parse(input);
      return JSON.stringify(redactJsonValue(parsed), null, 2) + (input.endsWith('\n') ? '\n' : '');
    } catch { /* Treat non-JSON text as ordinary diagnostic output. */ }
  }
  return input
    .replace(/-----BEGIN (?:X509 )?CERTIFICATE-----[\s\S]*?-----END (?:X509 )?CERTIFICATE-----/gi, '[REDACTED CERTIFICATE]')
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gi, '[REDACTED PRIVATE KEY]')
    .replace(/\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b/gi, '[REDACTED MAC]')
    .replace(/\/dev\/serial\/by-id\/[^\s]+|\/dev\/cu\.usbserial-[\w.-]+/gi, '[REDACTED SERIAL DEVICE]')
    .replace(/\bWeatherXM WG1200\s+[0-9a-f]{4}\b/gi, 'WeatherXM WG1200 [REDACTED DEVICE ID]')
    .replace(/\b(MAC(?: address)?|device(?: name| id| identifier)|device(?=\s{2,}|\s*[:=])|gateway(?: id| identifier)|common name|certificate fingerprint|fingerprint|public key(?: hash)?|serial number|serial no\.?)\s*([:=]\s*|\s+)([^\r\n,;]+)/gi,
      (_match, label: string, separator: string) => `${label}${separator}${label.toLowerCase().includes('mac') ? '[REDACTED MAC]' : label.toLowerCase().includes('fingerprint') ? '[REDACTED CERTIFICATE FINGERPRINT]' : label.toLowerCase().includes('common') ? '[REDACTED COMMON NAME]' : label.toLowerCase().includes('serial') ? '[REDACTED SERIAL NUMBER]' : label.toLowerCase().includes('public key') ? '[REDACTED PUBLIC KEY]' : '[REDACTED DEVICE ID]'}`);
}

/** Synthetic fixture for checking that the executable's output boundary applies redaction. */
export function standaloneRedactionFixture(): string[] {
  return [
    `${JSON.stringify({ macAddress: 'AA:BB:CC:DD:EE:FF', deviceName: 'WeatherXM WG1200 1234', identity: { valid: true, commonName: 'gateway-secret.example', fingerprint: 'AB12CD34EF56' }, keyBlocks: [{ publicKeyHash: 'a'.repeat(64) }], chip: 'ESP32-S3' }, null, 2)}\n`,
    `ERROR: MAC address: AA:BB:CC:DD:EE:FF; certificate fingerprint: AB12CD34EF56; Public key hash: ${'b'.repeat(64)}\n`,
  ];
}
