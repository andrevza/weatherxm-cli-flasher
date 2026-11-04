import { describe, expect, it } from 'vitest';
import { redactOutput } from '../src/redaction.js';

describe('output redaction', () => {
  it('redacts device and certificate identifiers recursively in JSON but keeps operational fields', () => {
    const output = redactOutput(JSON.stringify({
      macAddress: 'AA:BB:CC:DD:EE:FF', deviceName: 'WeatherXM WG1200 1234',
      gatewayId: 'gateway-secret-id', device_id: 'device-secret-id', serialNumber: 'serial-secret', serial_number: 'serial-secret-snake', certificate: [1, 2, 3],
      identity: { valid: true, commonName: 'gateway-secret.example', fingerprint: 'AB12CD34EF56', publicKeyHash: 'a'.repeat(64) },
      chip: 'ESP32-S3', flashBytes: 16777216,
    }));
    const parsed = JSON.parse(output);
    expect(parsed.macAddress).toBe('[REDACTED MAC]');
    expect(parsed.deviceName).toBe('[REDACTED DEVICE ID]');
    expect(parsed.gatewayId).toBe('[REDACTED DEVICE ID]');
    expect(parsed.device_id).toBe('[REDACTED DEVICE ID]');
    expect(parsed.serialNumber).toBe('[REDACTED SERIAL NUMBER]');
    expect(parsed.serial_number).toBe('[REDACTED SERIAL NUMBER]');
    expect(parsed.certificate).toBe('[REDACTED CERTIFICATE]');
    expect(parsed.identity).toEqual({ valid: true, commonName: '[REDACTED COMMON NAME]', fingerprint: '[REDACTED CERTIFICATE FINGERPRINT]', publicKeyHash: '[REDACTED PUBLIC KEY]' });
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
});
