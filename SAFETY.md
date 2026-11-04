# Safety and validation

## Current behavior

`info`, `verify`, `status`, `check`, and `firmware list` are read-only with respect to flash. Device commands enter the ESP32 ROM loader and run a RAM stub, which resets the gateway and can write volatile control registers for the documented ESP32-S3 loader workaround. They do not call a flash-write API. `check` also downloads and validates the selected image, then reports the active-versus-available descriptor comparison. Every completed check outcome exits successfully; operational, validation, and integrity errors exit nonzero.

`monitor` and all `--monitor` handoffs are passive receive-only sessions. They do not instantiate `ESPLoader`, write serial bytes, or call `setSignals`. On macOS/Linux the monitor opens SerialPort with `hupcl:false`, which prevents the POSIX HUPCL behavior from dropping DTR on close. The `serialport` stream source applies its default DTR/RTS values only when `.set()` is called; monitor mode never calls it. The operating system or USB adapter may still alter modem-line state during initial open, so a reset cannot be ruled out for every adapter/driver. The CLI deliberately provides no `--reset` option. Early boot logs can be missed because inspection/flash releases and closes its serial owner before passive monitoring reopens the port.

`flash` downloads and validates the selected image, inspects the device, presents identity/hash/inactive-slot/address for explicit confirmation, and re-inspects immediately before the first write. It uses the upstream bounded OTA write and activation functions. No hardware write tests are run.

The comparison uses application type, version, and the descriptor's embedded app ELF SHA-256 build identifier. An exact match is skipped unless `--force` is supplied. `--force` changes only that duplicate skip; it cannot bypass identity/layout/MD5/image-integrity/OTA/write-boundary/protected-region checks or explicit confirmation. Downgrades remain blocked with or without `--force`. Ambiguous version ordering and firmware-type changes need separate interactive approval and cannot be approved by `--yes` or `--force`.

When OTA metadata is ambiguous, flashing fails by default. `--recover` explicitly opts into the upstream targeted recovery behavior, which writes the determined OTA target while preserving factory firmware and the other OTA metadata sector; the normal confirmation is still required.

The flasher never writes `phy_init`, but firmware may update calibration data during normal boot. The supplied update log showed the app saving new PHY calibration because existing calibration was outdated or had a checksum failure. The CLI protects calibration from its own OTA write range; it cannot promise byte-for-byte calibration preservation after the new firmware starts. Successful image/OTA/protected-region verification does not prove that application firmware booted. Boot fields report observed evidence independently; missing evidence is `not-observed`, and application health remains `not-checked` until a reliable health probe exists.

## Identity and layout gate

The CLI accepts only ESP32-S3 with 16 MiB flash, a valid WeatherXM credential partition, and an exact WG1200 partition table. The table must have a present, valid MD5 record, all expected entries and attributes, no duplicate/unexpected labels, no overlaps, and no out-of-flash ranges. Any mismatch is a hard failure.

Partition addresses come from WeatherXM WG1200 source, reviewed at commit `35b2ecc4ccb31799ecd720609786362a99b3e33a` (`src/lib/flasher/constants.ts` and `partitions.ts`). The CLI does not infer layouts from generic ESP32 defaults.

## Write invariants

- Never issue a full-chip erase, full-chip write, or full-flash restore.
- Never overwrite `factory`, credentials, NVS, calibration, SPIFFS, partition table, or NVS key.
- Write the selected firmware only to the validated inactive OTA app partition.
- Change boot selection by writing exactly one inactive 4 KiB OTA metadata sector with the official sequence, CRC, and valid-state encoding; read it back before reboot.
- Verify the firmware manifest digest before writing and compare on-chip flash MD5 after writing.
- Snapshot and verify protected flash data around the write.
- Require an explicit interactive confirmation, or an explicit `--yes` for automation, including device identity, firmware, target slot, and affected ranges.
- Use mocks and fixtures for all automated write-operation tests. Never flash hardware in tests.

## Firmware trust

Upstream checks the manifest SHA-256 and Secure Boot V2 signature-block marker (`0xE7` at the final 4096-byte block). These establish integrity against the fetched manifest and expected packaging marker; they are not an independent cryptographic verification of the Secure Boot signature. The CLI will not claim that marker alone verifies signer authenticity.
