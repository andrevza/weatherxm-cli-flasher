# WeatherXM WG1200 flasher source analysis

## Source reviewed

The reference checkout is the independent repository `https://github.com/WeatherXM/web-flasher`, reviewed at commit `35b2ecc4ccb31799ecd720609786362a99b3e33a` (2026-10-22). That checkout was clean when reviewed. Its WG1200 implementation is Apache-2.0 and depends on `esptool-js` 0.7.x. Main source files are `src/lib/flasher/{flasherController,transport,constants,partitions,writeGuard,manifest,identity,otadata,appDescriptor,hashing,serialLog}.ts`.

## Exact official install sequence

1. **Load firmware catalog.** `FlasherController.initialize()` calls `loadManifest('/firmware/manifest.json')`. `validateManifest()` checks schema, `hardware === WG1200`, `chip === ESP32-S3`, 16 MiB flash, 4 MiB app slots, required WeatherXM and Meshtastic entries, positive bounded byte counts, 64-character SHA-256 text, and `secure_boot_v2 === true` (`manifest.ts`). `fetchAndVerifyFirmware()` downloads the selected path, requires exact declared length, enforces the 4 MiB limit, checks byte `0xE7` at `length - 4096`, then compares SHA-256 (`manifest.ts`).
2. **Connect to ROM loader.** `connectDevice()` selects USB serial using the listed bridge vendor IDs, creates `Wg1200Transport`, and calls `ESPLoader.main()` at 115200 baud (`flasherController.ts`, `transport.ts`, `constants.ts`). This enters the ESP32-S3 ROM download loader and uploads/runs an esptool stub in RAM. `patchTransportRead()` skips leading serial noise before SLIP framing. `patchEsploaderRunStub()` adds an ESP32-S3 Secure Boot workaround and, for native USB-JTAG/Serial, disables watchdogs through volatile register writes. These are not flash writes, but connecting is not a passive application-level read: it resets/changes the running device into loader mode and runs RAM code.
3. **Identify and inspect.** `Wg1200Transport.inspect()` reads chip identity, MAC, flash size, partition table at `0xC000` (4 KiB), secure certificate at `0xD000` (8 KiB), OTA metadata at `0x13000` (8 KiB), and 4 KiB app-descriptor headers from the active/target app slots. Controller connection acceptance requires ESP32-S3, 16 MiB flash, the expected mandatory partition entries, and a nonblank recognized WeatherXM credential format (`identity.ts`, `partitions.ts`, `flasherController.ts`). Certificate data is SHA-256 fingerprinted; a device cert may yield a CN/public key. MAC is display identity fallback.
4. **Choose the inactive OTA slot.** `determineActiveBootSlot()` parses two 4 KiB OTA sectors, sequence, state, and ESP-IDF CRC32; the larger valid sequence determines active slot (`(seq - 1) % 2`). Target is the other OTA slot, and target metadata sector is the opposite metadata sector. Fully erased metadata selects factory as active and `ota_0` as target; invalid non-erased data is marked ambiguous and enters recovery UI (`otadata.ts`). The controller uses the partition-table-resolved target offset.
5. **Snapshot critical regions.** `snapshotProtectedRegions()` reads and SHA-256 snapshots the partition table, secure certificate, NVS, and NVS key. It does not snapshot `phy_init` or SPIFFS. OTA metadata is intentionally modified later.
6. **Write application.** `installApplication()` calls `assertAllowedApplicationWrite()`, which only allows a range wholly contained within `ota_0` (`0x420000..0x81FFFF`) or `ota_1` (`0x820000..0xC1FFFF`), no more than 4 MiB, and rejects intersection with every protected range. Factory `0x020000..0x41FFFF` is forbidden for normal installs. `ESPLoader.writeFlash()` is called with a single image, `flashSize: '16MB'`, DIO, 80 MHz, compression enabled, and `eraseAll: false` (`writeGuard.ts`, `transport.ts`).
7. **Verify image on chip.** The expected MD5 is calculated from downloaded firmware and compared with ESP32 `flashMd5sum(targetOffset, imageLength)` (`flasherController.ts`, `transport.ts`). The upstream flow has no independent target-region SHA-256 readback.
8. **Activate transactionally.** `buildTransactionalOtadataSector()` creates one 4096-byte sector filled with `0xFF`, sequence at byte 0, `ESP_OTA_IMG_VALID` (2) at byte 24, and CRC32 at byte 28. `writeOtaSelectSector()` only permits address `0x13000` or `0x14000`, writes exactly 4096 bytes with `eraseAll: false`, then reads it back and validates CRC/sequence/state. The other metadata sector is left untouched (`otadata.ts`, `writeGuard.ts`, `transport.ts`).
9. **Check preservation and reboot.** Controller re-reads the four snapshotted regions and compares SHA-256 after OTA metadata has already been committed. A mismatch fails the operation after activation; a serial read hiccup is logged as notice. It toggles RTS/DTR to reset into normal mode, disconnects, reopens serial at 115200, and captures/sanitizes boot logs for 12 seconds (`hardReset()`, `disconnect()`, `captureBootLogs()`). Boot-log signature detection is informational, not a hard verification of successful OTA boot.

The current CLI adds independent target-region SHA-256 readback and checks its
protected-region and preserved OTA-slot snapshots before committing the
alternate metadata sector. It also verifies the signed candidate image and
compares the signer digest with read-only device eFuse evidence in the
pre-install path. Flash encryption/ROM download restrictions are now surfaced
from read-only eFuse fields. The installed bootloader's anti-rollback and
recovery behavior remain unknown; the unconditional firmware-write gate is
still `BLOCKED`, so none of these transaction improvements have been exercised
on physical hardware.

## Comparison with the supplied successful device log

The supplied log matches the source sequence: ESP32-S3 with the Secure Boot loader workaround, 16 MiB flash, active `ota_0`, target `ota_1` at `0x820000`, a 3,674,112-byte WeatherXM 0.8.34 image, on-chip MD5 success, then sequence 4 written to OTA sector 1 at `0x14000`. The bootloader subsequently loaded app offset `0x820000`, reported RSA-PSS Secure Boot signature success, and the app identified itself as 0.8.34. This supports the sequence and slot mapping documented above.

The app write took about 158 seconds at the upstream 115200-baud setting. The CLI now reports write progress at 5% intervals and performs the same 12-second post-boot monitor. It reports only the detected boot type, app version, whether Secure Boot signature success appeared, and whether calibration regeneration was logged; it does not print raw boot logs that could contain network details.

The log also reports `phy_init` saving new calibration data after boot because prior calibration was outdated or failed its checksum. This occurs in application firmware after the flasher's protected-region check. The upstream flasher protects calibration from its own write range; neither it nor this CLI can guarantee the new firmware will leave calibration byte-for-byte unchanged at runtime.

## Verified partition map

All addresses and sizes below come from `constants.ts` and the expected entries in `partitions.ts`, not generic ESP32 defaults. Partition table is read at `0xC000`; the partition table itself does not contain a named `partition_table` entry.

| Start | End (exclusive) | Size | Label | Official use / write policy |
|---|---:|---:|---|---|
| `0x00C000` | `0x00D000` | 4 KiB | partition table | Read and validate; protected |
| `0x00D000` | `0x00F000` | 8 KiB | `esp_secure_cert` | Device identity; protected |
| `0x00F000` | `0x013000` | 16 KiB | `nvs` | Device/application settings; protected |
| `0x013000` | `0x015000` | 8 KiB | `otadata` | Boot selection; only one 4 KiB sector is written per OTA activation |
| `0x015000` | `0x016000` | 4 KiB | `phy_init` | RF calibration; protected |
| `0x020000` | `0x420000` | 4 MiB | `factory` | Stock recovery; preserved and not overwritten by normal install |
| `0x420000` | `0x820000` | 4 MiB | `ota_0` | OTA app slot; may receive image only while inactive |
| `0x820000` | `0xC20000` | 4 MiB | `ota_1` | OTA app slot; may receive image only while inactive |
| `0xC20000` | `0xC21000` | 4 KiB | `nvs_key` | Encryption key; protected |
| `0xC21000` | `0xF21000` | 3 MiB | `spiffs` | File storage; protected |

## Reuse assessment and safety gaps

Directly importing the TypeScript business logic is preferable to reimplementing the format/CRC/descriptor rules. It is not a drop-in Node CLI: `Wg1200Transport` constructs esptool-js `Transport` over the browser Web Serial port object, `FlasherController` depends on `navigator.serial` and UI callbacks, and boot monitoring uses Web Streams. A Node serial adapter can preserve the esptool protocol and share pure TS modules, but needs an explicit adapter for open/read/write/signals/close, and must be validated against the esptool-js version. Linux ARM64 also needs dependency/container validation.

The CLI should reuse or port `constants`, `partitions`, `writeGuard`, `manifest`, `identity`, `otadata`, `appDescriptor`, and hashing logic. The transport should reuse esptool-js with a Node serial adapter if compatible; otherwise port protocol operations while maintaining fixture parity.

The CLI strengthens the official guard: it requires a valid MD5 record, exact expected entries, nonempty labels, zero flags as present in the upstream real WG1200 partition fixture, no duplicate/unexpected/overlapping entries, and erased padding after the MD5 record. It only resolves offsets after this full check. The official firmware authenticity check only checks a trailing `0xE7` marker plus a SHA-256 value from the downloaded manifest; it does not cryptographically verify the Secure Boot V2 signature. The CLI preserves those checks and restricts the manifest and firmware to the same HTTPS origin; independent signature verification requires the Espressif public key and supported verifier to be established from authoritative firmware source.

The official protected-region hash snapshot covers partition table, secure cert, NVS and NVS key; `writeGuard` blocks writes over all seven protected regions. CLI should snapshot/compare all non-target ranges that it can safely read, especially `phy_init` and SPIFFS, and explicitly treat OTA metadata as the only authorized non-app write. No full-chip erase or full-image restore should be offered.

## Read-only command semantics

`info`, `verify`, `status`, and `firmware list` should never invoke `writeFlash`. Device inspection will still enter ROM loader/stub and reset the device as described above. `verify` should validate identity, flash size, complete layout, credentials, OTA records, and both app headers, with a machine-readable result and hard failure for any unexpected identity/layout. `status` should report active/target slots and sector sequence/state/CRC without changing them.

## Reference source index

- Connect and inspection flow: `src/lib/flasher/flasherController.ts` → `connectDevice()`; `src/lib/flasher/transport.ts` → `connect()`, `inspect()`, `readRegion()`.
- Device identity and cert parsing: `src/lib/flasher/identity.ts` → `verifySecureCertIdentity()`, `extractDeviceCertBytes()`.
- Partition parsing/verification: `src/lib/flasher/partitions.ts` → `parsePartitionTableWithMetadata()`, `verifyWg1200PartitionTable()`.
- Firmware catalog and image validation: `src/lib/flasher/manifest.ts` → `validateManifest()`, `loadManifest()`, `fetchAndVerifyFirmware()`.
- Protected-write policy: `src/lib/flasher/writeGuard.ts` → `assertAllowedApplicationWrite()`, `assertAllowedOtaSelectWrite()`.
- OTA algorithm: `src/lib/flasher/otadata.ts` → `determineActiveBootSlot()`, `buildTransactionalOtadataSector()`.
- Actual staged install: `src/lib/flasher/flasherController.ts` → `flashFirmware()`.
- Serial details and reset: `src/lib/flasher/transport.ts` → `patchTransportRead()`, `patchEsploaderRunStub()`, `hardReset()`, `disconnect()`; `src/lib/flasher/serialLog.ts` → `captureBootLogs()`.
- Upstream safety tests: `tests/{writeGuard,transport,otadata,manifest,identity,appDescriptor}.test.ts`.
