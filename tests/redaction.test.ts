import { describe, expect, it } from 'vitest';
import { redactOutput } from '../src/redaction.js';

describe('output redaction', () => {
  it('redacts device and certificate identifiers recursively in JSON but keeps operational fields', () => {
    const output = redactOutput(JSON.stringify({
      macAddress: 'AA:BB:CC:DD:EE:FF', deviceName: 'WeatherXM WG1200 1234',
      gatewayId: 'gateway-secret-id', device_id: 'device-secret-id', serialNumber: 'serial-secret', serial_number: 'serial-secret-snake', certificate: [1, 2, 3],
      stationId: 'station-secret-id',
      identity: { valid: true, commonName: 'gateway-secret.example', fingerprint: 'AB12CD34EF56', publicKeyHash: 'a'.repeat(64) },
      mqtt_username: 'wxm-user', mqtt_password: 'wxm-password', accessToken: 'access-secret', refresh_token: 'refresh-secret',
      location: { latitude: -33.9, longitude: 18.4 },
      cloud_ws_id: 'cloud-station-id', ws_sn: 'station-serial', ws_pubkey: 'station-public-key', gps_lat: -33.9, gps_lon: 18.4,
      chip: 'ESP32-S3', flashBytes: 16777216,
    }));
    const parsed = JSON.parse(output);
    expect(parsed.macAddress).toBe('[REDACTED MAC]');
    expect(parsed.deviceName).toBe('[REDACTED DEVICE NAME]');
    expect(parsed.gatewayId).toBe('[REDACTED DEVICE ID]');
    expect(parsed.device_id).toBe('[REDACTED DEVICE ID]');
    expect(parsed.serialNumber).toBe('[REDACTED SERIAL NUMBER]');
    expect(parsed.serial_number).toBe('[REDACTED SERIAL NUMBER]');
    expect(parsed.certificate).toBe('[REDACTED CERTIFICATE]');
    expect(parsed.stationId).toBe('[REDACTED STATION ID]');
    expect(parsed.identity).toEqual({ valid: true, commonName: '[REDACTED COMMON NAME]', fingerprint: '[REDACTED CERTIFICATE FINGERPRINT]', publicKeyHash: '[REDACTED PUBLIC KEY]' });
    expect(parsed.mqtt_username).toBe('[REDACTED CREDENTIAL]');
    expect(parsed.mqtt_password).toBe('[REDACTED CREDENTIAL]');
    expect(parsed.accessToken).toBe('[REDACTED CREDENTIAL]');
    expect(parsed.refresh_token).toBe('[REDACTED CREDENTIAL]');
    expect(parsed.location).toBe('[REDACTED LOCATION]');
    expect(parsed.cloud_ws_id).toBe('[REDACTED STATION ID]');
    expect(parsed.ws_sn).toBe('[REDACTED STATION ID]');
    expect(parsed.ws_pubkey).toBe('[REDACTED PUBLIC KEY]');
    expect(parsed.gps_lat).toBe('[REDACTED LOCATION]');
    expect(parsed.gps_lon).toBe('[REDACTED LOCATION]');
    expect(parsed.chip).toBe('ESP32-S3');
    expect(parsed.flashBytes).toBe(16777216);
  });

  it('redacts identifiers in human-readable diagnostics and errors', () => {
    expect(redactOutput('Device: WeatherXM WG1200 1234; Chip: ESP32-S3; MAC address: AA:BB:CC:DD:EE:FF\nCommon Name: gateway-secret.example\nCertificate fingerprint: AB12CD34EF56\nError: gateway ID secret-xyz'))
      .toContain('Device: [REDACTED DEVICE ID]');
    const output = redactOutput('Device: WeatherXM WG1200 1234; Chip: ESP32-S3; MAC address: AA:BB:CC:DD:EE:FF\nCommon Name: gateway-secret.example\nCertificate fingerprint: AB12CD34EF56\nError: gateway ID secret-xyz');
    expect(output).not.toContain('1234');
    expect(output).not.toContain('AA:BB:CC:DD:EE:FF');
    expect(output).not.toContain('AB12CD34EF56');
    expect(output).not.toContain('gateway-secret.example');
    expect(output).not.toContain('secret-xyz');
    expect(output).toContain('ESP32-S3');
    expect(redactOutput('Device validation failed: partition table mismatch')).toContain('Device validation failed: partition table mismatch');
    expect(redactOutput('-----BEGIN CERTIFICATE-----\nsynthetic-certificate-bytes\n-----END CERTIFICATE-----')).toBe('[REDACTED CERTIFICATE]');
  });

  it('redacts credentials, station identifiers and coordinates in serial-style JSON and key-value lines', () => {
    const prefixed = redactOutput('I (123) settings: {"station_id":"station-secret","cloud_ws_id":"cloud-station-secret","ws_sn":"station-serial-secret","ws_pubkey":"public-key-secret","mqtt_password":"mqtt-secret","access_token":"token-secret","gps_lat":-33.9,"gps_lon":18.4,"coordinates":[-33.9,18.4]}');
    expect(prefixed).not.toContain('station-secret');
    expect(prefixed).not.toContain('cloud-station-secret');
    expect(prefixed).not.toContain('station-serial-secret');
    expect(prefixed).not.toContain('public-key-secret');
    expect(prefixed).not.toContain('mqtt-secret');
    expect(prefixed).not.toContain('token-secret');
    expect(prefixed).not.toContain('-33.9');
    expect(prefixed).not.toContain('18.4');

    const plain = redactOutput('station id: station-secret; ws_id: 12345; ws_sn: serial-secret; ws_pubkey: public-key-secret; MQTT password: mqtt-secret; access token: token-secret; GPS latitude: -33.9; GPS longitude: 18.4');
    for (const secret of ['station-secret', '12345', 'serial-secret', 'public-key-secret', 'mqtt-secret', 'token-secret', '-33.9', '18.4']) expect(plain).not.toContain(secret);
    expect(plain).toContain('[REDACTED STATION ID]');
    expect(plain).toContain('[REDACTED CREDENTIAL]');
    expect(plain).toContain('[REDACTED LOCATION]');
  });

  it('redacts Secure Boot public-key digests in text and JSON', () => {
    const digest = 'a'.repeat(64);
    const diagnostic = { operation: 'READ_REG', logicalSlot: 0, physicalBlock: 4, registerBaseOffset: '0x09c', expectedWords: 8, wordsRead: 3, errorCategory: 'serial-read-failed', failedWordIndex: 3, failedRegisterOffset: '0x0a8' };
    const json = JSON.parse(redactOutput(JSON.stringify({ keyBlocks: [{ publicKeyHash: digest, readDiagnostic: diagnostic }] })));
    expect(json.keyBlocks[0].publicKeyHash).toBe('[REDACTED PUBLIC KEY]');
    expect(json.keyBlocks[0].readDiagnostic).toEqual(diagnostic);
    expect(redactOutput(`Public key hash: ${digest}`)).toBe('Public key hash: [REDACTED PUBLIC KEY]');
  });

  it('redacts hashed physical-device identity fields in OTA backup manifests', () => {
    const safe = JSON.parse(redactOutput(JSON.stringify({ deviceBinding: { macAddressSha256: 'a'.repeat(64), secureCertificateSha256: 'b'.repeat(64) },
      partition: { label: 'otadata', offset: 0x13000, length: 8192 } })));
    expect(safe.deviceBinding.macAddressSha256).toBe('[REDACTED MAC]');
    expect(safe.deviceBinding.secureCertificateSha256).toBe('[REDACTED CERTIFICATE]');
    expect(safe.partition.offset).toBe(0x13000);
  });

  it('covers telemetry station IDs, serial fragments, mDNS identity and public API locations', () => {
    const text = redactOutput('Station ID, Val: 15428\nI: {"ws_fo_id": "0x00001234"}\nS/N: ABCD123456\nI MdnsDiscovery: mDNS announced: wxm-gw-a1b2c3.local, service: _weatherxm._tcp (id: [REDACTED MAC]:11:22:33:44)\nI PubApi: address=Example City, ZZ; reset=1; boot=8\n');
    for (const secret of ['15428', '0x00001234', 'ABCD123456', 'wxm-gw-a1b2c3.local', '11:22:33:44', 'Example City, ZZ']) expect(text).not.toContain(secret);
    expect(text).toContain('reset=1');
    expect(text).toContain('boot=8');
  });

  it('is idempotent and never redacts its own placeholders twice', () => {
    const input = '> WXM WG1200 RELEASE BUILD\n> S/N: SERIAL-SYNTH-42\nI MdnsDiscovery: mDNS announced: wxm-gw-synthetic.local, service: _weatherxm._tcp (id: 0x00A1B2C3)\n';
    const once = redactOutput(input);
    expect(once).toContain('S/N: [REDACTED SERIAL NUMBER]');
    expect(once).toContain('mDNS announced: [REDACTED DEVICE NAME]');
    expect(once).not.toContain('SERIAL-SYNTH-42');
    expect(once).not.toContain('DEVICE NAME] DEVICE NAME]');
    expect(redactOutput(once)).toBe(once);
  });

  it('redacts embedded settings and telemetry JSON without damaging JSON syntax', () => {
    const samples = [
      'I (123) Submit: Remote Settings JSON {"client":{"ws_fo_id":"0x0000A1B2"},"shared":{"rm_run_ts":123,"name":"Synthetic Gateway"},"sensor":{"name":"Temperature"},"mdnsName":"wxm-gw-synthetic.local"}',
      'I (124) TBJson: {"gw_tick_ms":"1234","ws_fo_id":"0x0000B2C3","ws_reception":"100","reset":1}',
    ];
    for (const sample of samples) {
      const sanitized = redactOutput(sample);
      expect(redactOutput(sanitized)).toBe(sanitized);
      const firstBrace = sanitized.indexOf('{');
      const lastBrace = sanitized.lastIndexOf('}');
      const parsed = JSON.parse(sanitized.slice(firstBrace, lastBrace + 1));
      const client = parsed.client ?? parsed;
      expect(client.ws_fo_id).toBe('[REDACTED STATION ID]');
      expect(JSON.stringify(parsed)).not.toContain('Synthetic Gateway');
      expect(JSON.stringify(parsed)).not.toContain('0x0000');
      expect(JSON.stringify(parsed)).not.toContain('wxm-gw-synthetic.local');
      if (sample.includes('sensor')) expect(JSON.stringify(parsed)).toContain('"name":"Temperature"');
    }
  });

  it('redacts station IDs by context but retains unrelated addresses, reset values, heap telemetry and public firmware hashes', () => {
    const firmwareHash = 'cf'.repeat(32);
    const input = [
      'W (23303) WsHandler: Station ownership challenge sent to 0x00A1B2C3',
      'W (23304) WsHandler: Station ownership confirmed by GPS response for 0x00A1B2C3 after 1 packet(s)',
      'Station ID, Val: 123456',
      'load:0x403c9700 reset=1 boot=8',
      'ESP-ROM:esp32s3-20210327 secure boot verification succeeded',
      'I secure_boot_v2: Signature verified successfully!',
      'I boot: Loaded app from partition at offset 0x820000',
      'I (2262) nvs: nvs_get swd_flag 1',
      'IP Address=192.0.2.123',
      'I (1523) heap_init: Initializing. RAM available for dynamic allocation: 123456 bytes',
      `I Submit: Public firmware SHA-256: ${firmwareHash}`,
    ].join('\n');
    const output = redactOutput(input);
    expect(output.match(/\[REDACTED STATION ID\]/g)).toHaveLength(3);
    expect(output).toContain('load:0x403c9700 reset=1 boot=8');
    expect(output).toContain('ESP-ROM:esp32s3-20210327 secure boot verification succeeded');
    expect(output).toContain('Signature verified successfully!');
    expect(output).toContain('Loaded app from partition at offset 0x820000');
    expect(output).toContain('nvs_get swd_flag 1');
    expect(output).toContain('IP Address=[REDACTED IP ADDRESS]');
    expect(output).toContain('RAM available for dynamic allocation: 123456 bytes');
    expect(output).toContain(firmwareHash);
  });

  it('uses a safe fallback for malformed JSON-like fields without inserting unmatched brackets', () => {
    const malformed = 'I Submit: {"client":{"ws_fo_id":0x00A1B2C3';
    const output = redactOutput(malformed);
    expect(output).toContain('"ws_fo_id":null');
    expect(output).not.toContain('0x00A1B2C3');
    expect(output).not.toContain('[REDACTED STATION ID] STATION ID]');
  });
});
