// The CLI currently verifies a manifest SHA-256 and signature-block marker,
// but has no verified signer-to-device trust or security-version evidence.
// Keep this gate fail-closed until both are implemented and tested.
export const FIRMWARE_SECURITY_BLOCK_REASON =
  'Firmware writing is disabled: Secure Boot V2 signature trust and gateway anti-rollback compatibility are not verified.';

export function firmwareSecurityReady(): false {
  return false;
}

export function assertFirmwareSecurityReady(): void {
  if (!firmwareSecurityReady()) throw new Error(FIRMWARE_SECURITY_BLOCK_REASON);
}
