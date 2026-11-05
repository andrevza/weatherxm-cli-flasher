type RedactionKind = 'MAC' | 'DEVICE ID' | 'DEVICE NAME' | 'STATION ID' | 'STATION NAME' | 'SERIAL NUMBER' | 'CERTIFICATE FINGERPRINT' | 'COMMON NAME' | 'PUBLIC KEY' | 'CERTIFICATE' | 'LOCATION' | 'IP ADDRESS' | 'CREDENTIAL';

const sensitiveKey = /^(?:mac(?:address)?|device(?:name|id|identifier|hostname)?|gateway(?:id|identifier)?|(?:weather)?station(?:id|identifier|uuid|serial|name)|(?:cloud|local)?ws(?:id|sn|pubkey|publickey)|wsfoid|mdns(?:name|hostname|host)?|serial(?:number|no)?|commonname|fingerprint|certificatefingerprint|publickeyhash|publickey|certificate|identity|location|address|city|postalcode|postcode|zip|coordinates|latitude|longitude|lat|lon|lng|gps(?:lat|lon|latitude|longitude)|ip(?:v4|v6)?address|access(?:token|key)|refresh(?:token|key)|auth(?:orization|token)|bearer|token|password|passwd|passphrase|secret|credential|credentials|mqtt(?:username|user|password|pass|token|clientid)|broker(?:username|user|password|pass)|api(?:key|token))$/i;

const labelAlternation = [
  'station[_ -]?id(?:\\s*,\\s*val)?', 'station[_ -]?(?:identifier|uuid|serial|name)',
  '(?:local|cloud)[_ -]?ws[_ -]?(?:id|sn|pubkey|public key)', 'ws[_ -]?fo[_ -]?id', 'ws[_ -]?(?:id|sn|pubkey|public key)',
  'device[_ -]?(?:name|id|identifier|hostname)?', 'gateway[_ -]?(?:id|identifier)',
  'mac(?: address)?', 'serial(?: number| no\\.?)?', 's/n', 'common name',
  'certificate fingerprint', 'fingerprint', 'public key(?: hash)?', 'certificate',
  'ip address', 'address', 'city', 'postal[_ -]?code', 'postcode', 'zip',
  'location', 'coordinates', 'latitude', 'longitude', 'gps[_ -]?(?:lat|lon|latitude|longitude)', 'lat', 'lon', 'lng',
  'access token', 'refresh token', 'authorization', 'token', 'password', 'passwd', 'passphrase', 'secret', 'credentials?',
  'mqtt[_ -]?(?:username|user|password|pass|token|client[_ -]?id)', 'broker[_ -]?(?:username|user|password|pass)', 'api[_ -]?(?:key|token)',
].join('|');

function kindForKey(key: string, parentKey = ''): RedactionKind | undefined {
  const normalized = key.replace(/[_ -]/g, '').toLowerCase();
  const parent = parentKey.replace(/[_ -]/g, '').toLowerCase();
  if (normalized === 'name' && ['shared', 'device', 'gateway'].includes(parent)) return 'DEVICE NAME';
  if (!sensitiveKey.test(normalized)) return undefined;
  if (normalized.startsWith('ip') && normalized.includes('address')) return 'IP ADDRESS';
  if (normalized.includes('mac')) return 'MAC';
  if (normalized.startsWith('mdns')) return 'DEVICE NAME';
  if (normalized.includes('fingerprint')) return 'CERTIFICATE FINGERPRINT';
  if (normalized.includes('commonname')) return 'COMMON NAME';
  if (normalized.includes('serial')) return 'SERIAL NUMBER';
  if (normalized.includes('publickey') || normalized.includes('pubkey')) return 'PUBLIC KEY';
  if (normalized.includes('certificate')) return 'CERTIFICATE';
  if (/^(?:location|address|city|postalcode|postcode|zip|coordinates|latitude|longitude|lat|lon|lng|gps(?:lat|lon|latitude|longitude))$/.test(normalized)) return 'LOCATION';
  if (normalized.includes('token') || normalized.includes('key') || normalized.includes('password') || normalized.includes('passwd') || normalized.includes('passphrase') || normalized.includes('secret') || normalized.includes('credential') || normalized.includes('authorization') || normalized.includes('bearer') || normalized.includes('username') || normalized.includes('mqtt') || normalized.includes('broker') || normalized.includes('api')) return 'CREDENTIAL';
  if (normalized === 'stationname') return 'STATION NAME';
  if (/^(?:station|(?:cloud|local)?ws|wsfoid)/.test(normalized)) return 'STATION ID';
  if (normalized.endsWith('name') || normalized === 'hostname') return normalized.startsWith('station') ? 'STATION NAME' : 'DEVICE NAME';
  return 'DEVICE ID';
}

function redactJsonValue(value: unknown, key: string | undefined, parentKey: string, mark: (kind: RedactionKind) => string): unknown {
  if (key) {
    const kind = kindForKey(key, parentKey);
    const normalized = key.replace(/[_ -]/g, '').toLowerCase();
    const isContainer = value && typeof value === 'object' && !Array.isArray(value) && ['identity', 'device', 'gateway'].includes(normalized);
    if (kind && !isContainer) return value === null ? null : mark(kind);
  }
  if (typeof value === 'string') {
    if (/-----BEGIN (?:X509 )?CERTIFICATE-----[\s\S]*?-----END (?:X509 )?CERTIFICATE-----/i.test(value)) return mark('CERTIFICATE');
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i.test(value)) return mark('CREDENTIAL');
    return redactPlainText(value, mark);
  }
  if (Array.isArray(value)) return value.map((item) => redactJsonValue(item, undefined, '', mark));
  if (value && typeof value === 'object') {
    const parent = key ?? parentKey;
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redactJsonValue(child, childKey, parent, mark)]));
  }
  return value;
}

function findJsonSpan(text: string, from: number): { start: number; end: number } | undefined {
  for (let start = from; start < text.length; start++) {
    if (text[start] !== '{' && text[start] !== '[') continue;
    const stack: string[] = [];
    let quoted = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const char = text[i]!;
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') { quoted = true; continue; }
      if (char === '{' || char === '[') stack.push(char === '{' ? '}' : ']');
      else if (char === '}' || char === ']') {
        if (stack.pop() !== char) break;
        if (stack.length === 0) return { start, end: i + 1 };
      }
    }
  }
  return undefined;
}

function redactPlainText(input: string, mark: (kind: RedactionKind) => string): string {
  let output = input
    .replace(/(\b(?:station\s+ownership\s+challenge\s+sent\s+to|station\s+ownership\s+confirmed\b[^:\r\n]*?\bfor)\s+)(0x[0-9a-f]{1,16})/gi, (_m, prefix: string) => `${prefix}${mark('STATION ID')}`)
    .replace(/(\bDevice\s*[:=]\s*)[^\r\n,;]+/gi, (_m, prefix: string) => `${prefix}${mark('DEVICE ID')}`)
    .replace(/(\bGateway\s+ID\s+)[^\s,;]+/gi, (_m, prefix: string) => `${prefix}${mark('DEVICE ID')}`)
    .replace(/(\bmDNS announced:\s*)[^\s,]+/gi, (_m, prefix: string) => `${prefix}${mark('DEVICE NAME')}`)
    .replace(/(\bmDNS announced:[^\r\n]*?\(id:\s*)[^)]*(\))/gi, (_m, prefix: string, suffix: string) => `${prefix}${mark('DEVICE ID')}${suffix}`)
    .replace(/\bwxm-gw-[a-z0-9-]+\.local\b/gi, () => mark('DEVICE NAME'))
    .replace(/\bDevice\s+name\s+[^\r\n,;]+/gi, (match) => `${match.slice(0, match.toLowerCase().indexOf('name') + 4)} ${mark('DEVICE NAME')}`)
    .replace(new RegExp(`(?<![a-z0-9_])(["']?(?:${labelAlternation})["']?\\s*[:=]\\s*)(?:"([^"\\r\\n]*)"|'([^'\\r\\n]*)'|([^,;\\s}\\]]+))`, 'gi'), (match, prefix: string, doubleQuoted: string | undefined, singleQuoted: string | undefined, bare: string | undefined) => {
      const rawLabel = prefix.replace(/["']/g, '').split(/\s*[:=]\s*/)[0]!.replace(/,\s*Val$/i, '');
      const kind = kindForTextLabel(rawLabel);
      if (!kind) return match;
      const placeholder = mark(kind);
      if (doubleQuoted !== undefined) return `${prefix}"${placeholder}"`;
      if (singleQuoted !== undefined) return `${prefix}'${placeholder}'`;
      // Bare values in a JSON-like key/value fragment use null, keeping JSON syntax valid.
      if (/^["'][^"']+["']\s*:\s*$/.test(prefix)) return `${prefix}null`;
      return `${prefix}${placeholder}`;
    })
    .replace(/(^|[^a-z0-9_])((?:ip|mac)\s+address|address|city|postal[_ -]?code|postcode|zip)\s*([:=])\s*([^\r\n;]*)/gi, (_m, lead: string, label: string, separator: string) => `${lead}${label}${separator}${/^ip\s+address$/i.test(label) ? mark('IP ADDRESS') : /^mac\s+address$/i.test(label) ? mark('MAC') : mark('LOCATION')}`)
    .replace(/\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b/gi, () => mark('MAC'))
    .replace(/\[REDACTED MAC\](?::[0-9a-f]{2}){1,5}\b/gi, () => mark('MAC'))
    .replace(/\/dev\/serial\/by-id\/[^\s]+|\/dev\/cu\.usbserial-[\w.-]+/gi, () => mark('CREDENTIAL'))
    .replace(/\bWeatherXM WG1200\s+[0-9a-f]{4}\b/gi, 'WeatherXM WG1200 [REDACTED DEVICE ID]')
    .replace(/-----BEGIN (?:X509 )?CERTIFICATE-----[\s\S]*?-----END (?:X509 )?CERTIFICATE-----/gi, () => mark('CERTIFICATE'))
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gi, () => mark('CREDENTIAL'));
  return output;
}

function kindForTextLabel(label: string): RedactionKind | undefined {
  const normalized = label.replace(/[_ -]/g, '').replace(/,Val$/i, '').toLowerCase();
  if (normalized === 'ipaddress') return 'IP ADDRESS';
  if (normalized.startsWith('mac')) return 'MAC';
  if (normalized.includes('fingerprint')) return 'CERTIFICATE FINGERPRINT';
  if (normalized.includes('commonname')) return 'COMMON NAME';
  if (normalized.startsWith('serial') || normalized === 'sn' || normalized === 's/n') return 'SERIAL NUMBER';
  if (normalized.includes('publickey') || normalized.includes('pubkey')) return 'PUBLIC KEY';
  if (normalized === 'certificate') return 'CERTIFICATE';
  if (/^(?:stationid|localwsid|cloudwsid|wsfoid|wsid|wssn)$/.test(normalized)) return 'STATION ID';
  if (normalized === 'stationname') return 'STATION NAME';
  if (/^(?:devicename|devicehostname)$/.test(normalized)) return 'DEVICE NAME';
  if (/^(?:device|deviceid|deviceidentifier|gatewayid|gatewayidentifier)$/.test(normalized)) return 'DEVICE ID';
  if (/^(?:address|city|postalcode|postcode|zip|location|coordinates|latitude|longitude|lat|lon|lng|gps(?:lat|lon|latitude|longitude))$/.test(normalized)) return 'LOCATION';
  if (/token|key|password|passwd|passphrase|secret|credential|authorization|bearer|username|mqtt|broker|api/.test(normalized)) return 'CREDENTIAL';
  return undefined;
}

/** Redacts known identity fields without reprocessing placeholders produced in this pass. */
export function redactOutput(input: string): string {
  const placeholders: string[] = [];
  const mark = (kind: RedactionKind) => `\uE000${placeholders.push(`[REDACTED ${kind}]`) - 1}\uE001`;
  const protect = (text: string) => text
    .replace(/\[REDACTED MAC\](?::[0-9a-f]{2}){1,5}\b/gi, '[REDACTED MAC]')
    .replace(/\[REDACTED[^\]\r\n]*\]/g, (placeholder) => markExisting(placeholder));
  const markExisting = (placeholder: string) => `\uE000${placeholders.push(placeholder) - 1}\uE001`;
  const protectedInput = protect(input);
  const restore = (text: string) => text.replace(/\uE000(\d+)\uE001/g, (_m, index: string) => placeholders[Number(index)] ?? '');

  try {
    const parsed = JSON.parse(protectedInput.trim());
    const rendered = JSON.stringify(redactJsonValue(parsed, undefined, '', mark), null, 2) + (input.endsWith('\n') ? '\n' : '');
    return restore(rendered);
  } catch { /* Serial logs commonly prefix JSON with a timestamp or log tag. */ }

  let output = '';
  let cursor = 0;
  let searchFrom = 0;
  let foundJson = false;
  while (searchFrom < protectedInput.length) {
    const span = findJsonSpan(protectedInput, searchFrom);
    if (!span) break;
    try {
      const value = JSON.parse(protectedInput.slice(span.start, span.end));
      output += redactPlainText(protectedInput.slice(cursor, span.start), mark);
      output += JSON.stringify(redactJsonValue(value, undefined, '', mark));
      cursor = span.end;
      searchFrom = span.end;
      foundJson = true;
    } catch {
      searchFrom = span.start + 1;
    }
  }
  output = foundJson ? `${output}${redactPlainText(protectedInput.slice(cursor), mark)}` : redactPlainText(protectedInput, mark);
  return restore(output);
}

/** Synthetic fixture for checking that the executable's output boundary applies redaction. */
export function standaloneRedactionFixture(): string[] {
  return [
    `${JSON.stringify({ macAddress: 'AA:BB:CC:DD:EE:FF', deviceName: 'WeatherXM WG1200 1234', stationId: 'station-123', cloud_ws_id: 'station-123', ws_sn: 'serial-123', ws_pubkey: 'station-public-key', ws_fo_id: '0x00001234', mdnsName: 'wxm-gw-aabbcc.local', identity: { valid: true, commonName: 'gateway-secret.example', fingerprint: 'AB12CD34EF56' }, keyBlocks: [{ publicKeyHash: 'a'.repeat(64) }], mqtt_password: 'mqtt-secret', accessToken: 'access-secret', gps_lat: -33.9, gps_lon: 18.4, address: 'synthetic city, ZZ', location: { lat: -33.9, lon: 18.4 }, chip: 'ESP32-S3' }, null, 2)}\n`,
    `ERROR: MAC address: AA:BB:CC:DD:EE:FF; certificate fingerprint: AB12CD34EF56; Public key hash: ${'b'.repeat(64)}; station id: station-123; mqtt password: mqtt-secret; access token: access-secret; latitude: -33.9; longitude: 18.4\n`,
    'Station ID, Val: 12345\nS/N: AA:BB:CC:DD:EE:FF\nI MdnsDiscovery: mDNS announced: wxm-gw-a1b2c3.local, service: _weatherxm._tcp (id: [REDACTED MAC]:11:22:33:44)\nI PubApi: address=Synthetic City, ZZ; reset=1; boot=8\n',
    'I Submit: Remote Settings JSON {"client":{"ws_fo_id":"0x00A1B2C3"},"shared":{"rm_run_ts":123,"name":"Synthetic Gateway"}}\nW (123) WsHandler: Station ownership challenge sent to 0x00B2C3D4\nIP Address=192.0.2.42\nI (124) heap_init: RAM available for dynamic allocation: 123456 bytes\nI Submit: Public firmware SHA-256: cf99cf99cf99cf99cf99cf99cf99cf99cf99cf99cf99cf99cf99cf99cf99cf99\n',
  ];
}
