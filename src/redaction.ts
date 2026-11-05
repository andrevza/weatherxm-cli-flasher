const sensitiveKey = /^(?:mac(?:address)?|device(?:name|id|identifier)?|gateway(?:id|identifier)?|(?:weather)?station(?:id|identifier|uuid|serial|name)|(?:cloud|local)?ws(?:id|sn|pubkey|publickey)|serial(?:number|no)?|commonname|fingerprint|certificatefingerprint|publickeyhash|publickey|certificate|identity|location|coordinates|latitude|longitude|lat|lon|lng|gps(?:lat|lon|latitude|longitude)|access(?:token|key)|refresh(?:token|key)|auth(?:orization|token)|bearer|token|password|passwd|passphrase|secret|credential|credentials|mqtt(?:username|user|password|pass|token|clientid)|broker(?:username|user|password|pass)|api(?:key|token))$/i;

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
    if (normalizedKey.includes('publickey') || normalizedKey.includes('pubkey')) return value === null ? null : '[REDACTED PUBLIC KEY]';
    if (normalizedKey.includes('certificate')) return value === null ? null : '[REDACTED CERTIFICATE]';
    if (/^(?:location|coordinates|latitude|longitude|lat|lon|lng|gps(?:lat|lon|latitude|longitude))$/.test(normalizedKey)) return value === null ? null : '[REDACTED LOCATION]';
    if (/^(?:station|serial|(?:cloud|local)?ws(?:id|sn))/.test(normalizedKey)) return value === null ? null : '[REDACTED STATION ID]';
    if (/token|key|password|passwd|passphrase|secret|credential|authorization|bearer|username|mqtt|broker|api/.test(normalizedKey)) return value === null ? null : '[REDACTED CREDENTIAL]';
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
    .replace(/(["']?(?:station(?:[_ -]?(?:id|identifier|uuid|serial|name))|device(?:[_ -]?(?:id|name|identifier))|gateway(?:[_ -]?(?:id|identifier))|(?:(?:cloud|local)[_ -]?)?ws[_ -]?(?:id|sn|pubkey|public[_ -]?key)|gps[_ -]?(?:lat|lon|latitude|longitude)|(?:access|refresh)[_ -]?(?:token|key)|auth(?:orization|[_ -]?token)|bearer|token|password|passwd|passphrase|secret|credentials?|mqtt[_ -]?(?:username|user|password|pass|token|client[_ -]?id)|broker[_ -]?(?:username|user|password|pass)|api[_ -]?(?:key|token)|location|coordinates|latitude|longitude|lat|lon|lng)["']?\s*[:=]\s*)(\[[^\]\r\n]*\]|"[^"\r\n]*"|'[^'\r\n]*'|[^,;\s}\]]+)/gi, (_match, prefix: string) => `${prefix}[REDACTED SENSITIVE VALUE]`)
    .replace(/-----BEGIN (?:X509 )?CERTIFICATE-----[\s\S]*?-----END (?:X509 )?CERTIFICATE-----/gi, '[REDACTED CERTIFICATE]')
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gi, '[REDACTED PRIVATE KEY]')
    .replace(/\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b/gi, '[REDACTED MAC]')
    .replace(/\/dev\/serial\/by-id\/[^\s]+|\/dev\/cu\.usbserial-[\w.-]+/gi, '[REDACTED SERIAL DEVICE]')
    .replace(/\bWeatherXM WG1200\s+[0-9a-f]{4}\b/gi, 'WeatherXM WG1200 [REDACTED DEVICE ID]')
    .replace(/\b(MAC(?: address)?|device(?: name| id| identifier)|device(?=\s{2,}|\s*[:=])|gateway(?: id| identifier)|common name|certificate fingerprint|fingerprint|public key(?: hash)?|serial number|serial no\.?)\s*([:=]\s*|\s+)([^\r\n,;]+)/gi,
      (_match, label: string, separator: string) => `${label}${separator}${label.toLowerCase().includes('mac') ? '[REDACTED MAC]' : label.toLowerCase().includes('fingerprint') ? '[REDACTED CERTIFICATE FINGERPRINT]' : label.toLowerCase().includes('common') ? '[REDACTED COMMON NAME]' : label.toLowerCase().includes('serial') ? '[REDACTED SERIAL NUMBER]' : label.toLowerCase().includes('public key') ? '[REDACTED PUBLIC KEY]' : '[REDACTED DEVICE ID]'}`)
    .replace(/\b(station(?: id| identifier| UUID| serial| name)|(?:(?:cloud|local) )?ws[ _-]?(?:id|sn|pubkey|public key)|GPS[ _-]?(?:lat|lon|latitude|longitude)|access token|refresh token|authorization|token|password|passphrase|secret|credentials?|MQTT (?:username|user|password|pass|token|client id)|location|coordinates|latitude|longitude|lat|lon|lng)\s*([:=]\s*)([^\r\n,;]+)/gi,
      (_match, label: string, separator: string) => `${label}${separator}${/pubkey|public key/i.test(label) ? '[REDACTED PUBLIC KEY]' : /serial|station|ws[ _-]?(?:id|sn)/i.test(label) ? '[REDACTED STATION ID]' : /gps|location|coordinate|latitude|longitude|^(?:lat|lon|lng)$/i.test(label) ? '[REDACTED LOCATION]' : '[REDACTED CREDENTIAL]'}`);
}

/** Synthetic fixture for checking that the executable's output boundary applies redaction. */
export function standaloneRedactionFixture(): string[] {
  return [
    `${JSON.stringify({ macAddress: 'AA:BB:CC:DD:EE:FF', deviceName: 'WeatherXM WG1200 1234', stationId: 'station-123', cloud_ws_id: 'station-123', ws_sn: 'serial-123', ws_pubkey: 'station-public-key', identity: { valid: true, commonName: 'gateway-secret.example', fingerprint: 'AB12CD34EF56' }, keyBlocks: [{ publicKeyHash: 'a'.repeat(64) }], mqtt_password: 'mqtt-secret', accessToken: 'access-secret', gps_lat: -33.9, gps_lon: 18.4, location: { lat: -33.9, lon: 18.4 }, chip: 'ESP32-S3' }, null, 2)}\n`,
    `ERROR: MAC address: AA:BB:CC:DD:EE:FF; certificate fingerprint: AB12CD34EF56; Public key hash: ${'b'.repeat(64)}; station id: station-123; mqtt password: mqtt-secret; access token: access-secret; latitude: -33.9; longitude: 18.4\n`,
  ];
}
