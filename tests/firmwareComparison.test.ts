import { describe, expect, it } from 'vitest';
import type { AppDescriptor } from '../src/upstream/flasher/appDescriptor.js';
import { compareFirmware, firmwareInstallPolicy } from '../src/upstream/flasher/firmwareComparison.js';
import { parseAppDescriptor } from '../src/upstream/flasher/appDescriptor.js';
import { WG1200_CONSTANTS } from '../src/upstream/flasher/constants.js';
import { checkExitCode, serializeFirmwareCheckResult, type FirmwareCheckResult } from '../src/device.js';

function descriptor(type: AppDescriptor['firmwareType'], version: string, hash: string): AppDescriptor {
  return {
    magic: 0xabcd5432, secureVersion: 0, version, projectName: 'wg1010_port',
    compileTime: '12:00:00', compileDate: 'Jan 01 2026', idfVersion: '6.0.1',
    firmwareType: type, displayTitle: version, appElfSha256: hash.repeat(64 / hash.length),
  };
}

const buildA = 'a'.repeat(64);
const buildB = 'b'.repeat(64);

describe('firmware version and build comparison', () => {
  it('identifies the exact same type, version, and embedded build identifier', () => {
    expect(compareFirmware(descriptor('weatherxm', '0.8.34-g86b609b', buildA), descriptor('weatherxm', '0.8.34-g86b609b', buildA)).kind).toBe('identical');
  });

  it('blocks older firmware', () => {
    expect(compareFirmware(descriptor('weatherxm', '0.8.34', buildA), descriptor('weatherxm', '0.8.33', buildB)).kind).toBe('older');
  });

  it('classifies newer firmware', () => {
    expect(compareFirmware(descriptor('weatherxm', '0.8.34', buildA), descriptor('weatherxm', '0.8.35', buildB)).kind).toBe('newer');
  });

  it('distinguishes different builds at the same version', () => {
    expect(compareFirmware(descriptor('weatherxm', '0.8.34', buildA), descriptor('weatherxm', '0.8.34', buildB)).kind).toBe('same-version-different-build');
  });

  it('classifies a firmware type change', () => {
    expect(compareFirmware(descriptor('weatherxm', '0.8.34', buildA), descriptor('meshtastic', '2.7.0', buildB)).kind).toBe('different-type');
    expect(compareFirmware(descriptor('meshtastic', '2.7.0', buildA), descriptor('weatherxm', '0.8.34', buildB)).kind).toBe('different-type');
  });

  it('limits --force to identical builds and leaves downgrade/type-switch approval gates intact', () => {
    const identical = compareFirmware(descriptor('weatherxm', '0.8.34', buildA), descriptor('weatherxm', '0.8.34', buildA));
    const downgrade = compareFirmware(descriptor('weatherxm', '0.8.34', buildA), descriptor('weatherxm', '0.8.33', buildB));
    const typeSwitch = compareFirmware(descriptor('weatherxm', '0.8.34', buildA), descriptor('meshtastic', '2.7.0', buildB));
    expect(firmwareInstallPolicy(identical, false)).toMatchObject({ alreadyInstalled: true, flashingPermitted: false });
    expect(firmwareInstallPolicy(identical, true)).toMatchObject({ alreadyInstalled: false, flashingPermitted: true });
    expect(firmwareInstallPolicy(downgrade, true)).toMatchObject({ downgradeBlocked: true, flashingPermitted: false });
    expect(firmwareInstallPolicy(typeSwitch, true)).toMatchObject({ approvalRequired: true, flashingPermitted: false });
  });

  it('requires approval when version formats cannot be reliably ordered', () => {
    expect(compareFirmware(descriptor('weatherxm', 'custom-release', buildA), descriptor('weatherxm', 'vNext', buildB)).kind).toBe('ambiguous');
    expect(compareFirmware(descriptor('weatherxm', '0.8.34-g86b609b', buildA), descriptor('weatherxm', '0.8.34', buildB)).kind).toBe('ambiguous');
  });

  it('fails closed when descriptor build metadata is missing', () => {
    const missing = descriptor('weatherxm', '0.8.34', buildA);
    missing.appElfSha256 = '';
    expect(() => compareFirmware(missing, descriptor('weatherxm', '0.8.35', buildB))).toThrow(/missing a validated type, version, or embedded build identifier/);
  });

  it('fails closed for a missing or invalid descriptor', () => {
    expect(() => compareFirmware(null, descriptor('weatherxm', '0.8.35', buildB))).toThrow(/Installed firmware descriptor/);
    expect(() => compareFirmware(descriptor('weatherxm', '0.8.34', buildA), null)).toThrow(/Selected firmware descriptor/);
    const invalid = descriptor('weatherxm', '0.8.34', buildA);
    invalid.magic = 0;
    expect(() => compareFirmware(invalid, descriptor('weatherxm', '0.8.35', buildB))).toThrow(/Installed firmware descriptor/);
    const invalidSelected = descriptor('weatherxm', '0.8.35', buildB);
    invalidSelected.firmwareType = 'unknown';
    expect(() => compareFirmware(descriptor('weatherxm', '0.8.34', buildA), invalidSelected)).toThrow(/Selected firmware descriptor/);
  });

  it.each(['up-to-date', 'update-available', 'downgrade-blocked', 'approval-required', 'incompatible-firmware', 'security-blocked'] as const)(
    'returns success exit status for a completed check with status %s', (status) => {
      const result: FirmwareCheckResult = {
        device: { model: 'WG1200', identity: 'WG1200-test', identityValid: true, chip: 'ESP32-S3', flashBytes: 16 * 1024 * 1024 },
        otaState: { ambiguous: false, explanation: 'valid' },
        installedFirmware: { type: 'weatherxm', version: '1.2.3', build: buildA },
        availableFirmware: { type: 'weatherxm', version: '1.2.4', build: buildB },
        firmwareImageSha256: buildB, comparison: 'newer', updateAvailable: true,
        flashingPermitted: true, approvalRequired: false, status, securityEvidence: 'unverified', explanation: 'fixture result',
      };
      expect(checkExitCode(result)).toBe(0);
      expect(JSON.parse(serializeFirmwareCheckResult(result))).toMatchObject({ status, device: { model: 'WG1200' }, comparison: 'newer', firmwareImageSha256: buildB });
    },
  );

  it('reads the embedded ELF SHA-256 from a synthetic application descriptor', () => {
    const image = new Uint8Array(512).fill(0xff);
    const view = new DataView(image.buffer);
    view.setUint32(0, WG1200_CONSTANTS.APP_DESC_MAGIC, true);
    view.setUint32(4, 0, true);
    const string = (offset: number, value: string) => image.set(new TextEncoder().encode(value), offset);
    string(16, '0.8.34-g86b609b');
    string(48, 'wg1010_port');
    string(80, '12:00:00');
    string(96, 'Jan 01 2026');
    string(112, '6.0.1');
    image.set(Buffer.from(buildA, 'hex'), 144);
    expect(parseAppDescriptor(image)?.appElfSha256).toBe(buildA);
  });

});
