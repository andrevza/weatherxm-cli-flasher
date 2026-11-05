import type { FirmwareCheckResult } from './device.js';

type Slot = { active: boolean; version: string | null; firmwareType: string | null; build: string | null; descriptorStatus: 'valid' | 'invalid' | 'unknown' };
type SlotMap = Record<string, Slot>;
type StatusView = {
  hardware: string; flashBytes: number;
  ota: { isAmbiguous: boolean; activeSeq: number | null; nextSeq: number | null; nextTargetSlot: string | null; nextTargetOffset: number | null; sector0: { valid: boolean }; sector1: { valid: boolean } };
  firmwareSlots: SlotMap;
};
type DryRunView = {
  targetSlot: string; targetOffset: number; sha256: string; inactiveMatch?: boolean; writeBlockedReason?: string;
  comparison: { kind: string; message: string; installed: { type: string; version: string; build: string }; selected: { type: string; version: string; build: string } };
  ota?: { activeSlot: string | null; inactiveSlot: string | null };
  firmwareSlots?: SlotMap;
};

function firmwareTitle(slot: Slot | undefined): string {
  return slot?.descriptorStatus === 'valid'
    ? `${slot.firmwareType === 'weatherxm' ? 'WeatherXM' : slot.firmwareType === 'meshtastic' ? 'Meshtastic' : slot.firmwareType} ${slot.version}`
    : slot?.descriptorStatus === 'invalid' ? 'INVALID' : 'UNKNOWN';
}
function buildLabel(slot: Slot | undefined): string {
  return slot?.build ? `${slot.build.slice(0, 12)}…` : slot?.descriptorStatus.toUpperCase() ?? 'UNKNOWN';
}

export function formatStatusOutput(summary: StatusView): string {
  const ota = summary.ota;
  const render = (slotName: 'ota_0' | 'ota_1') => {
    const slot = summary.firmwareSlots[slotName];
    return `  ${slotName.padEnd(8)} ${slot.active ? 'ACTIVE' : 'INACTIVE'}\n           Firmware    ${firmwareTitle(slot)}\n           Build       ${buildLabel(slot)}\n`;
  };
  return `WeatherXM WG1200 — Firmware Status\n${'─'.repeat(48)}\nDevice          WG1200\nFlash           ${summary.flashBytes / (1024 * 1024)} MiB\nOTA State       ${ota.isAmbiguous ? 'AMBIGUOUS' : 'VALID'}\nActive OTA Seq  ${ota.activeSeq || 'UNKNOWN'}\nOTA Records     ${ota.sector0.valid ? 'sector 0 valid' : 'sector 0 invalid'}; ${ota.sector1.valid ? 'sector 1 valid' : 'sector 1 invalid'}\n\nFIRMWARE SLOTS\n\n${render('ota_0')}\n${render('ota_1')}\nNEXT INSTALLATION\n\n  Target Slot     ${ota.nextTargetSlot ?? 'UNKNOWN'}\n  Target Offset   ${ota.nextTargetOffset === null ? 'UNKNOWN' : `0x${ota.nextTargetOffset.toString(16)}`}\n  Next OTA Seq    ${ota.nextSeq ?? 'UNKNOWN'}\n`;
}

export function formatCheckOutput(result: FirmwareCheckResult): string {
  const labels: Record<FirmwareCheckResult['status'], string> = {
    'up-to-date': 'UP TO DATE', 'update-available': 'UPDATE AVAILABLE',
    'downgrade-blocked': 'DOWNGRADE BLOCKED', 'approval-required': 'APPROVAL REQUIRED',
    'incompatible-firmware': 'INCOMPATIBLE FIRMWARE',
    'security-blocked': 'SECURITY EVIDENCE REQUIRED',
  };
  const selectedLabel = result.availableFirmware.type === 'weatherxm' ? 'WeatherXM' : result.availableFirmware.type === 'meshtastic' ? 'Meshtastic' : result.availableFirmware.type;
  const activeName = result.ota?.activeSlot ?? null;
  const inactiveName = result.ota?.inactiveSlot ?? null;
  const active = activeName ? result.firmwareSlots?.[activeName] : undefined;
  const inactive = inactiveName ? result.firmwareSlots?.[inactiveName] : undefined;
  const decision = result.approvalRequired ? 'Additional approval is required before flashing.'
    : result.flashingPermitted ? 'Flashing is permitted after the normal write confirmation.'
      : 'No firmware update is permitted by the current safety policy.';
  return `WeatherXM WG1200 — Firmware Check\n${'─'.repeat(48)}\nDEVICE FIRMWARE\n\n  Active Slot       ${activeName ?? 'UNKNOWN'}\n  Running Firmware  ${firmwareTitle(active)}\n  Running Build     ${buildLabel(active)}\n\n  Inactive Slot     ${inactiveName ?? 'UNKNOWN'}\n  Stored Firmware   ${firmwareTitle(inactive)}\n  Stored Build      ${buildLabel(inactive)}\n\nAVAILABLE FIRMWARE\n\n  Selected          ${selectedLabel} ${result.availableFirmware.version}\n  Build             ${result.availableFirmware.build.slice(0, 12)}…\n  Comparison        ${result.comparison.toUpperCase()}\n${result.inactiveMatch ? '\nSelected firmware matches the build descriptor stored in the inactive OTA slot.\n' : ''}\nSTATUS              ${labels[result.status]}\n\n${result.explanation}\n${decision}\n`;
}

export function formatDryRunOutput(result: DryRunView): string {
  const activeName = result.ota?.activeSlot ?? null;
  const inactiveName = result.ota?.inactiveSlot ?? null;
  const active = activeName ? result.firmwareSlots?.[activeName] : undefined;
  const inactive = inactiveName ? result.firmwareSlots?.[inactiveName] : undefined;
  const outcome = result.comparison.kind === 'older' ? 'DOWNGRADE BLOCKED' : result.comparison.kind.toUpperCase();
  const explanation = result.comparison.kind === 'older'
    ? 'The selected firmware is older than the currently running firmware.' : result.comparison.message;
  return `WeatherXM WG1200 — Firmware Dry Run\n${'─'.repeat(48)}\nDEVICE FIRMWARE\n\n  Active Slot       ${activeName ?? 'UNKNOWN'}\n  Running Firmware  ${firmwareTitle(active)}\n  Running Build     ${buildLabel(active)}\n\n  Inactive Slot     ${inactiveName ?? 'UNKNOWN'}\n  Stored Firmware   ${firmwareTitle(inactive)}\n  Stored Build      ${buildLabel(inactive)}\n\nSELECTED FIRMWARE\n\n  Firmware          ${result.comparison.selected.type} ${result.comparison.selected.version}\n  Build             ${result.comparison.selected.build.slice(0, 12)}…\n  Target Slot       ${result.targetSlot}\n  Target Offset     0x${result.targetOffset.toString(16)}\n  Comparison        ${result.comparison.kind.toUpperCase()}\n\nSTATUS              ${outcome}\n\n${explanation}\n${result.inactiveMatch ? '\nSelected firmware matches the build descriptor stored in the inactive OTA slot.\n' : ''}\nTECHNICAL DETAILS\n  Image SHA-256     ${result.sha256}\n\nNo flash operations performed.\n`;
}

export function standalonePresentationFixture(mode: 'status' | 'check' | 'dry-run' | 'dry-run-match'): string {
  const a = 'cd90d5aa46a01234';
  const b = '8d11a5d088fb5678';
  const slots = { ota_0: { active: false, version: 'v0.6.1-dirty', firmwareType: 'weatherxm', build: b, descriptorStatus: 'valid' as const },
    ota_1: { active: true, version: '0.8.34-g86b609b', firmwareType: 'weatherxm', build: a, descriptorStatus: 'valid' as const } };
  if (mode === 'status') return formatStatusOutput({ hardware: 'WG1200', flashBytes: 16 * 1024 * 1024,
    ota: { isAmbiguous: false, activeSeq: 4, nextSeq: 5, nextTargetSlot: 'ota_0', nextTargetOffset: 0x420000,
      sector0: { valid: true }, sector1: { valid: true } }, firmwareSlots: slots });
  const selected = { type: 'weatherxm', version: mode === 'check' ? '0.8.34-g86b609b' : mode === 'dry-run-match' ? 'v0.6.1-dirty' : 'v0.6.2-2-g8f4dca2', build: mode === 'check' ? a : mode === 'dry-run-match' ? b : 'legacybuild9876' };
  if (mode === 'check') return formatCheckOutput({ device: { model: 'WG1200', identity: 'fixture', identityValid: true, chip: 'ESP32-S3', flashBytes: 16 * 1024 * 1024 },
    ota: { activeSlot: 'ota_1', inactiveSlot: 'ota_0', nextTargetSlot: 'ota_0', nextTargetOffset: 0x420000, activeSeq: 4, nextSeq: 5, ambiguous: false },
    firmwareSlots: slots, inactiveMatch: false, otaState: { ambiguous: false, explanation: 'valid' },
    installedFirmware: { type: 'weatherxm', version: '0.8.34-g86b609b', build: a }, availableFirmware: selected,
    firmwareImageSha256: 'f'.repeat(64), comparison: 'identical', updateAvailable: false, flashingPermitted: false,
    approvalRequired: false, status: 'up-to-date', securityEvidence: 'unverified', explanation: 'Already installed' });
  return formatDryRunOutput({ targetSlot: 'ota_0', targetOffset: 0x420000, sha256: 'f'.repeat(64), inactiveMatch: mode === 'dry-run-match',
    ota: { activeSlot: 'ota_1', inactiveSlot: 'ota_0' }, firmwareSlots: slots,
    comparison: { kind: 'older', message: 'Selected image is older.', installed: { type: 'weatherxm', version: '0.8.34-g86b609b', build: a }, selected } });
}
