import { describe, expect, it } from 'vitest';
import { firmwareSlotSummary } from '../src/device.js';
import { WG1200_CONSTANTS } from '../src/upstream/flasher/constants.js';
import type { Wg1200Inspection } from '../src/upstream/flasher/transport.js';

const desc = (version: string, build: string, type: 'weatherxm' | 'meshtastic' = 'weatherxm') => ({
  magic: WG1200_CONSTANTS.APP_DESC_MAGIC, secureVersion: 1, version, projectName: type,
  compileTime: '', compileDate: '', idfVersion: '', appElfSha256: build.repeat(64).slice(0, 64),
  firmwareType: type, displayTitle: `${type} ${version}`,
} as const);

function inspection(activeSlot: 'ota_0' | 'ota_1', currentFirmware: any, inactiveFirmware: any, ambiguous = false) {
  return {
    otadata: { activeSlot, targetSlot: activeSlot === 'ota_0' ? 'ota_1' : 'ota_0', targetOffset: activeSlot === 'ota_0' ? 0x820000 : 0x420000,
      nextSeq: 5, activeSeq: 4, targetSector: 0, activeSector: 1, isAmbiguous: ambiguous,
      sector0: {} as any, sector1: {} as any, description: '' }, currentFirmware, inactiveFirmware,
  } as unknown as Wg1200Inspection;
}

describe('firmware slot visibility', () => {
  it('maps descriptors correctly with ota_0 active', () => {
    const slots = firmwareSlotSummary(inspection('ota_0', desc('1.0.0', 'a'), desc('0.9.0', 'b')));
    expect(slots.ota.activeSlot).toBe('ota_0');
    expect(slots.ota.inactiveSlot).toBe('ota_1');
    expect(slots.firmwareSlots.ota_0.version).toBe('1.0.0');
    expect(slots.firmwareSlots.ota_1.version).toBe('0.9.0');
  });

  it('maps descriptors correctly with ota_1 active and permits identical descriptors', () => {
    const same = desc('1.0.0', 'a');
    const slots = firmwareSlotSummary(inspection('ota_1', same, same));
    expect(slots.ota.activeSlot).toBe('ota_1');
    expect(slots.ota.nextTargetOffset).toBe(0x420000);
    expect(slots.firmwareSlots.ota_0.version).toBe(slots.firmwareSlots.ota_1.version);
    expect(slots.firmwareSlots.ota_0.build).toBe(slots.firmwareSlots.ota_1.build);
  });

  it('reports missing, invalid, mixed-type, and ambiguous metadata without guessing', () => {
    const missing = firmwareSlotSummary(inspection('ota_1', desc('1.0.0', 'a'), null));
    expect(missing.firmwareSlots.ota_0.descriptorStatus).toBe('unknown');
    const invalid = firmwareSlotSummary(inspection('ota_1', desc('1.0.0', 'a'), { ...desc('', 'b'), magic: 0 }));
    expect(invalid.firmwareSlots.ota_0.descriptorStatus).toBe('invalid');
    const mixed = firmwareSlotSummary(inspection('ota_1', desc('1.0.0', 'a'), desc('2.0.0', 'c', 'meshtastic')));
    expect(mixed.firmwareSlots.ota_0.firmwareType).toBe('meshtastic');
    const ambiguous = firmwareSlotSummary(inspection('ota_1', desc('1.0.0', 'a'), desc('2.0.0', 'b'), true));
    expect(ambiguous.ota.activeSlot).toBeNull();
    expect(ambiguous.ota.nextTargetSlot).toBeNull();
  });
});
