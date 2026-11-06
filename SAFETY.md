# Safety and validation

## Current behavior

`info`, `verify`, `status`, `check`, and `firmware list` are read-only with respect to flash. Device commands enter the ESP32 ROM loader and run a RAM stub, which resets the gateway and can write volatile control registers for the documented ESP32-S3 loader workaround. They do not call a flash-write API. `check` also downloads and validates the selected image, then reports the active-versus-available descriptor comparison. Every completed check outcome exits successfully; operational, validation, and integrity errors exit nonzero.

`monitor` and all `--monitor` handoffs are passive receive-only sessions. They do not instantiate `ESPLoader`, write serial bytes, or call `setSignals`. On macOS/Linux the monitor opens SerialPort with `hupcl:false`, which prevents the POSIX HUPCL behavior from dropping DTR on close. The `serialport` stream source applies its default DTR/RTS values only when `.set()` is called; monitor mode never calls it. The operating system or USB adapter may still alter modem-line state during initial open, so a reset cannot be ruled out for every adapter/driver. The CLI deliberately provides no `--reset` option. Early boot logs can be missed because inspection/flash releases and closes its serial owner before passive monitoring reopens the port.

Normal `flash <firmware>` downloads and validates the selected image, inspects the device, presents identity/hash/inactive-slot/address for explicit confirmation, and re-inspects immediately before the first write. Its global firmware readiness gate remains blocked. The separate `flash weatherxm --stage-only --backup-manifest <path>` path is narrowly permitted for the pinned WeatherXM 0.8.34 artifact, only when active `ota_1` and inactive `ota_0` match live metadata and a fresh exact-partition backup validates. It writes only the candidate image length in `ota_0`, verifies hardware MD5 and SHA-256 readback, rechecks protected regions and full OTA metadata, then resets to normal boot without changing OTA selection. It requires interactive confirmation; `--yes`, `--force`, and `--recover` cannot authorize it. No physical write tests have been run.

`backup inactive` streams only the selected inactive OTA application partition to a new file, compares a second complete device-read SHA-256 pass, and atomically publishes the file plus a manifest without overwriting existing paths. It does not export credential, NVS, NVS-key, or certificate partitions. A hash-verified backup does not establish that the image is restorable or bootable.

## Command effects

- Read-only inspection: `info`, `verify`, `status`, `check`, and `firmware list` do not write or erase flash. Device inspection enters ROM loader mode and resets the gateway; `check` also downloads the selected image.
- Installation: `flash <firmware>` can write the validated inactive OTA application slot and one OTA-selection sector after image checks, device checks, reinspection, and explicit confirmation. This modifies device firmware and may leave the gateway unusable if power or transport is interrupted.
- Stage-only: `flash weatherxm --stage-only --backup-manifest <path>` can write only the pinned 0.8.34 application bytes to `ota_0` while `ota_1` is active. It does not commit OTA metadata or activate. Power loss can leave the old inactive app partially erased/written; no restoration guarantee is implied.
- Inactive backup: `backup inactive --output <file>` reads the complete current inactive OTA partition and creates a manifest. The backup is a preservation artifact, not a tested recovery mechanism.
- Recovery: `flash <firmware> --recover` opts into the narrowly bounded recovery flow for ambiguous OTA metadata. It still writes and is not a read-only diagnostic operation.
- Erase: the CLI exposes no standalone erase command and must never issue a full-chip erase. Flash writes are bounded to the inactive OTA app and the selected OTA metadata sector.

The comparison uses application type, version, and the descriptor's embedded app ELF SHA-256 build identifier. An exact match is skipped unless `--force` is supplied. `--force` changes only that duplicate skip; it cannot bypass identity/layout/MD5/image-integrity/OTA/write-boundary/protected-region checks or explicit confirmation. Downgrades remain blocked with or without `--force`. Ambiguous version ordering and firmware-type changes need separate interactive approval and cannot be approved by `--yes` or `--force`.

When OTA metadata is ambiguous, flashing fails by default. `--recover` is only an explicit opt-in for the bounded OTA-target calculation; it does not bypass the unconditional firmware-security gate. Any future authorized transaction must preserve the non-target OTA slot and complete all protected-region checks before OTA activation.

The app writer never targets `phy_init`; transaction verification also compares its complete before/after SHA-256. Firmware may update calibration during normal boot, so preservation verification ends before reset and does not promise post-boot calibration identity. Successful image/OTA/protected-region verification does not prove that application firmware booted. Boot fields report observed evidence independently; missing evidence is `not-observed`, and application health remains `not-checked` until a reliable health probe exists.

## Identity and layout gate

The CLI accepts only ESP32-S3 with 16 MiB flash, a valid WeatherXM credential partition, and an exact WG1200 partition table. The table must have a present, valid MD5 record, all expected entries and attributes, no duplicate/unexpected labels, no overlaps, and no out-of-flash ranges. Any mismatch is a hard failure.

Partition addresses come from WeatherXM WG1200 source, reviewed at commit `35b2ecc4ccb31799ecd720609786362a99b3e33a` (`src/lib/flasher/constants.ts` and `partitions.ts`). The CLI does not infer layouts from generic ESP32 defaults.

## Write invariants

- Never issue a full-chip erase, full-chip write, or full-flash restore.
- Never overwrite `factory`, credentials, NVS, calibration, SPIFFS, partition table, or NVS key.
- Write the selected firmware only to the validated inactive OTA app partition.
- Change boot selection by writing exactly one inactive 4 KiB OTA metadata sector with the official sequence, CRC, and valid-state encoding; read it back before reboot.
- For stage-only operations, do not call any OTA metadata writer and compare both metadata sectors byte-for-byte before and after.
- Verify the firmware manifest digest before writing and compare on-chip flash MD5 after writing.
- Snapshot and verify protected flash data around the write.
- Require an explicit interactive confirmation, or an explicit `--yes` for automation, including device identity, firmware, target slot, and affected ranges.
- Use mocks and fixtures for all automated write-operation tests. Never flash hardware in tests.

## Firmware trust

Upstream checks the manifest SHA-256 and Secure Boot V2 signature-block marker (`0xE7` at the final 4096-byte block). These establish integrity against the fetched manifest and expected packaging marker; they are not an independent cryptographic verification of the Secure Boot signature. The CLI will not claim that marker alone verifies signer authenticity.

The manifest requires `secure_boot_v2: true`; the device itself remains responsible for secure-boot enforcement. Do not disable Secure Boot or bypass signature verification. Firmware images are obtained from WeatherXM's official sources; this repository does not include those binaries.
