// Firmware writes remain blocked until bootloader OTA selection, rollback,
// protected-region preservation, and recovery readiness are established.
export const FIRMWARE_SECURITY_BLOCK_REASON =
  'Firmware writing is disabled: installed bootloader rollback and recovery behaviour and complete protected-region preservation are not verified.';

export function firmwareSecurityReady(): false {
  return false;
}

export function assertFirmwareSecurityReady(): void {
  if (!firmwareSecurityReady()) throw new Error(FIRMWARE_SECURITY_BLOCK_REASON);
}
