# Raspberry Pi 5 read-only hardware validation

## Validation record

The project maintainer reported this validation on 4 November 2026 using the Linux ARM64 standalone executable built from source commit `233fe617f57f3c75e0a2d31214ff731a62b509ca`.

| Item | Result |
| --- | --- |
| Host | Raspberry Pi 5, AArch64 |
| OS/kernel | Debian ARM64; Linux `6.18.39+rpt-rpi-2712` |
| Page size | 16 KB |
| CLI | `weatherxm-flash-linux-arm64`, package version `0.1.0` |
| Build | Node.js `v26.8.2`; source SHA-256 `bb4b185c320f970a3634a3349297bc9156776adefc0e724242ae302ce9ec9fd5`; clean source tree |
| Device | WeatherXM WG1200 using `/dev/ttyUSB0` |
| Chip | ESP32-S3; 16 MB flash detected |

Three rounds ran each of `info`, `verify`, and `status`. All nine operations completed successfully in approximately 4–5 seconds each. Each session connected to the ESP32-S3 ROM loader, applied the secure-boot ROM stub workaround, uploaded and ran the RAM stub, and read the partition table, credential area, OTA metadata, and application descriptors. The loader released USB reset and returned the device to its firmware. `verify` reported `VERIFIED` all three times.

The observed status was consistently OTA `VALID`, active slot `ota_1` with firmware `0.8.34-g86b609b`, inactive slot `ota_0` with firmware `v0.6.1-dirty`, and next installation target `ota_0` at `0x420000`. No MAC address, certificate value, serial number, or gateway-specific identifier is recorded here.

## Protocol regression addressed

An earlier Linux ARM64 trace showed that a late 16-byte raw MD5 digest from a completed ESP32 stub `READ_FLASH` transaction could remain unread. The following read then consumed the digest while waiting for its `0xD2` response and timed out. The transport now reads and verifies that trailing digest before returning from each flash-read transaction. The repeated Pi 5 `info`, `verify`, and `status` sessions completed without READ_FLASH timeouts or incomplete responses, providing physical evidence for the fix on this target.

## Scope and limits

These were read-only flash-inspection and validation commands. Inspection enters the ROM loader, resets the gateway, and performs the documented volatile register workaround, but these commands did not write or erase flash. No actual firmware installation, OTA activation, erase, or recovery operation has been physically tested with this standalone executable. Firmware-write behavior remains covered only by automated fixtures and mocks. Do not describe the full flashing workflow as hardware validated.

This record is based on the test report supplied by the maintainer; raw serial captures are not included. For future reproduction, record the executable's `--version --verbose` output and run the read-only hardware check script with the Pi's serial device configured. Review and redact any captured output before sharing it.
