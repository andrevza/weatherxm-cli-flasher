# WG1200 recovery readiness

**Status: NOT READY FOR PHYSICAL FLASH TEST.** This report describes evidence
and a proposed read-only-first recovery runbook. The runbook has not been
executed. No Codex-initiated physical device access, flash write, erase, OTA
metadata change, or eFuse operation occurred.

## A. Verified device state

The maintainer supplied this evidence from a Raspberry Pi 5 running Debian
ARM64 with 16 KB kernel pages. The tested executable was package `0.1.0`, Node
`v26.8.2`, built from `dc73da4a07eeb6cab5ed8ff8ae4f5ccc01c18622`, SHA-256
`0946f8f9f5b414be15353e9f027fde0dcf3d7bc202c1488e23ef6b72b9a43a82`.
Codex did not independently access the gateway.

The supplied `security check` result reported a valid RSA-PSS image signature
and digest, a matching eligible non-revoked signing key, a candidate at the
observed security-version floor, and `TRUSTED`. Installation readiness was
`BLOCKED`. Reported eFuse state included Secure Boot V2 enabled, ROM download
mode accessible, Secure Download Mode not enabled, USB Serial/JTAG download
restriction not enabled, and security-version floor 0.

The supplied dry run reported 16 MiB flash, active `ota_1` sequence 4,
inactive/target `ota_0` at `0x420000`, proposed sequence 5, active and selected
WeatherXM `0.8.34-g86b609b`, comparison `identical`, and `flashModified: false`.
The earlier supplied inspection also reported `ota_0` at `v0.6.1-dirty`. No
flash backup or read of the second-stage bootloader is reported. These records
are maintainer-supplied evidence for the named executable, not evidence that
the modified source in this follow-up has run on hardware.

## B. Protected-region integrity matrix

`device.ts` validates the exact partition table before it reaches the write
transaction. The expected table MD5, entries, names, offsets, sizes, types,
subtypes, flags, non-overlap and 16 MiB bounds are checked by
`validateExactPartitionLayout` and `validateRawPartitionTable`.
`transport.ts:hashRegionSha256` reads sequential 4 KiB chunks and updates a
SHA-256 context; it retains no full partition in memory. A short read or thrown
read error stops the operation. `verifyProtectedRegions` checks the exact
snapshot inventory and compares the complete before/after hashes. Mismatch
messages contain partition names only, not stored data or digest values.

| Region | Start | Size | Before/after treatment | Notes |
|---|---:|---:|---|---|
| Partition table | `0x0C000` | `0x1000` | Full SHA-256 / full SHA-256 | Extent must match the validated WG1200 table. |
| `esp_secure_cert` | `0x0D000` | `0x2000` | Full SHA-256 / full SHA-256 | Device-specific certificate material is never logged. |
| `nvs` | `0x0F000` | `0x4000` | Full SHA-256 / full SHA-256 | May contain network credentials and application state. |
| `otadata` | `0x13000` | Separate path | Full two-sector snapshot and reread; target record and unchanged peer checked | Intentionally changed only during OTA activation; excluded from protected hash list. |
| `phy_init` | `0x15000` | `0x1000` | Full SHA-256 / full SHA-256 | New firmware may later update calibration after reboot; transaction comparison ends before reset. |
| Factory app | `0x020000` | `0x400000` | Full SHA-256 / full SHA-256 | Preserved independently of OTA target. |
| Active/preserved OTA app | Metadata-derived slot | `0x400000` | Full SHA-256 / full SHA-256 | New code hashes the slot opposite the target, which is the active/known-good slot for unambiguous OTA state. For ambiguous/factory selection it preserves the other non-target OTA slot. |
| Target OTA app | Metadata-derived slot | `0x400000` | Not preserved; intended write target | Exact slot start and rounded erase extent are constrained to this one slot. Image length is at most 4 MiB and chip-side MD5 is checked. |
| `nvs_key` | `0xC20000` | `0x1000` | Full SHA-256 / full SHA-256 | Treat as device-specific key material; never log or share raw contents. |
| SPIFFS | `0xC21000` | `0x300000` | Full SHA-256 / full SHA-256 | May contain device/application state. |

The earlier audit's statement that factory, PHY and SPIFFS were not hashed was
incorrect for the source at the baseline. Those fixed non-OTA regions already
had full before/after checks. This follow-up adds a full digest for the
non-target OTA slot and a second complete `otadata` read immediately before
the app write. This narrows stale-OTA-state risk. The write gate remains
closed, and this expanded check has only deterministic mock coverage; it has
not been hardware-tested.

The esptool-js 0.7.0 ESP32-S3 erase range is sector-rounded by the ROM/stub.
`getApplicationEraseRange` accounts for four-byte image padding and 4 KiB
rounding, requires the exact OTA partition start, and refuses an erase end
beyond the slot. Both OTA slots are sector-aligned and exactly 4 MiB. The
writer hardcodes `eraseAll: false`; it submits one file at one address. It
does not pass through `--force`, `--recover`, or `--yes`. `flashDevice` derives
the target from validated OTA metadata, re-inspects before mutation, and the
transaction rejects a target that does not match the captured inactive slot.
The complete snapshot check runs before the write and again before activation.

The preserved slot adds 4 MiB to each hash pass. Full fixed and preserved
ranges total 11,571,200 bytes per pass; two passes total 23,142,400 bytes. At
115200 baud, payload alone takes roughly 33.5 minutes; pacing/protocol time is
additional. This is a synthetic implementation estimate, not measured device
performance. A physical run may take longer and should be budgeted accordingly.

## C. Bootloader identification

ESP32-S3 loads its second-stage bootloader from flash offset `0x0`. The public
WG1200 release configuration sets `CONFIG_BOOTLOADER_OFFSET_IN_FLASH=0x0` and
`CONFIG_PARTITION_TABLE_OFFSET=0xC000`; the validated device partition table
also places the partition table at `0xC000`. Therefore the reserved bootloader
area is bounded by offset 0 and the validated partition-table start. `0xC000`
is a safe read ceiling for that reserved area, not a claim that the bootloader
binary itself is exactly that size. ESP-IDF describes the ESP32-S3 bootloader
load address and image format in its [startup guide](https://docs.espressif.com/projects/esp-idf/en/latest/esp32s3/api-guides/startup.html)
and [bootloader image format guide](https://docs.espressif.com/projects/esp-idf/en/v5.5.1/esp32s3/api-reference/system/bootloader_image_format.html).

No installed bootloader bytes, hash, build identifier, or exact official
bootloader artifact has been supplied. Public source commit
`a30374b045c138dac3f6dd4267ef8eb7390a7670` is evidence about a source
snapshot only. Its WG1200 release config enables Secure Boot V2 and signed
apps, does not set ESP-IDF application rollback, and enables UART ROM download
mode. Its `main/boot_guard.cpp` implements app-level crash handling: three
classified crash boots can switch to the other OTA slot; a power-on reset
clears the counter; 600 seconds healthy uptime or a ThingsBoard connection
clears it. That guard runs in the application. It is not bootloader rollback
and cannot recover before application code starts.

The same public source has INFO bootloader logs on UART0 at 115200 baud.
Because it is not the installed image, these settings are source evidence, not
proof that logging or those options are enabled in the gateway. Normal logs
can reveal a bootloader version string, selected app offset, and some failures;
they cannot establish rollback Kconfig. Missing log lines prove nothing.

A bounded read-only dump for inspection is technically possible after
validating the device's 16 MiB flash and table offset. With Espressif esptool
5.x, the command is:

```sh
esptool --chip ESP32-S3 --port /dev/ttyUSB0 --baud 115200 \
  read-flash 0x0 0xC000 /secure/local/path/wg1200-boot-region.bin
sha256sum /secure/local/path/wg1200-boot-region.bin
esptool image-info /secure/local/path/wg1200-boot-region.bin
```

This performs reads only and creates a local binary containing the reserved
bootloader area up to (not including) the validated partition table. Do not
share it or console logs without review. It may include padding; compare against
an authoritative artifact only after normalizing the same address span and
confirming its signature/image structure. A hash or missing string by itself
does not establish build options. No exact WeatherXM bootloader artifact was
found in the inspected source checkouts.

## D. ROM-loader recovery capabilities

The maintainer-reported eFuse and ROM observations establish that this device
could enter the UART ROM loader for read-only inspection; Secure Download Mode
and the USB Serial/JTAG download restriction were reported off. Espressif
documents that Secure Download Mode restricts commands and disables stub,
register, and normal flash-read functionality; the reported mode does not have
those additional limits. See Espressif's [ESP32-S3 security configuration](https://docs.espressif.com/projects/esp-idf/en/v5.5/esp32s3/api-reference/kconfig.html)
and [download guidelines](https://docs.espressif.com/projects/esp-hardware-design-guidelines/en/latest/esp32s3/download-guidelines.html).

ROM-loader access permits a host to communicate with the immutable ROM
download implementation. It does not authorize arbitrary firmware as
bootable. Secure Boot V2 still authenticates the second-stage bootloader and
apps on SPI boot; a replacement app must be signed by an accepted device key.
Secure Boot does not make a mismatched/corrupt second-stage bootloader
recoverable without an appropriate signed bootloader image. Flash-encryption
state was not included in the supplied observations or current CLI report, so
flash backup/restore compatibility is not established.

The CLI and the public web-flasher source both connect through esptool-js and
upload its RAM stub for normal flash inspection/OTA writing. Prior successful
read-only stub communication establishes that this path worked on the tested
gateway. It does not establish that the write command is permitted or safe on
this specific configuration. The CLI's `assertFirmwareSecurityReady()` keeps
all writes blocked; `--yes`, `--force`, and `--recover` cannot bypass it. The
official web flasher follows its own OTA write path and is not a reviewed
recovery tool for this failure case.

The transport includes internal `rollbackToFactory`, full-flash read, and
full-flash restore helpers, but no CLI command calls them. Factory rollback
clears both OTA metadata sectors after checking only a descriptor and
signature-block marker; it does not verify the complete signed image against
the device key. The full-flash backup helper retains 16 MiB in memory and does
not fail on every short chunk; the restore helper rewrites the full chip and
checks only a boot header. Do not use these helpers for recovery. No destructive
test of any recovery method was performed.

## E. Recovery inventory

No pre-existing full-flash or partition backup is recorded. Read-only backup
is technically possible where ROM download commands and flash access permit
it, but it would contain credentials and device-specific data. The actual
flash-encryption eFuse state must first be established from read-only eFuse
summary evidence; the public source's flash-encryption build settings are not
device evidence. Store any backup encrypted, locally, with restricted access,
and never publish it. A raw backup is only potentially restorable to the same
gateway and same flash offsets; copying NVS, certificates, or key material to
another gateway is unsafe.

| Data | Recovery role | Device-specific / reconstructable | Backup and restore position |
|---|---|---|---|
| Flash chip / full 16 MiB | Capacity and geometry bound all offsets | Physical flash model is not identified in supplied evidence; 16 MiB capacity is reported | Read-only `flash-id` is possible. Do not infer manufacturer/model from capacity alone. |
| Bootloader `0x00000` to table boundary | Starts second-stage boot and enforces signatures | Binary/configuration not identified; source rebuild may not match release | Read-only bounded dump/hash possible. Restore only an exact supported signed artifact under a reviewed procedure; not available now. |
| Partition table `0x0C000/0x1000` | Defines all partition boundaries | Public layout is reproducible; installed table was reportedly validated | Back up with full flash inventory; restoration could change layout and strand data. Do not rewrite as recovery shortcut. |
| Factory app `0x020000/0x400000` | Potential fallback when OTA metadata selects factory | Firmware bytes/version may be factory-specific to this batch, not expected to contain individual credentials | Full read and SHA-256 possible; currently no backup. Preserve. Replacement must be trusted/signed and compatible. |
| Active OTA app (`ota_1` at reported state) | Current known-good application | Firmware image can be re-downloaded only if exact signed release artifact remains available; its bytes are not guaranteed from descriptor alone | No backup recorded. Preserve and hash before any recovery. |
| Inactive OTA app (`ota_0` at reported state) | Alternate image / prospective target | Supplied descriptor says `v0.6.1-dirty`; complete signature validity not established by descriptor | No backup recorded. Preserve until evidence shows it is safe to replace. |
| `otadata` `0x13000/0x2000` | Chooses app slot/sequence/state | State is device-specific but can be decoded from valid CRC records | Read-only snapshot possible; reconstruction is safe only when active app and exact ESP-IDF semantics are known. Never clear/repair while ambiguous. |
| `esp_secure_cert` `0x0D000/0x2000` | Device identity/certificate material | Unique to gateway | Read-only backup possible, but sensitive. Preserve only with encrypted, same-device custody; do not copy between devices. |
| `nvs` `0x0F000/0x4000` | Credentials and app/boot-guard state | Device-specific and likely sensitive | Read-only backup possible. Restore only same device after verified compatible encryption/layout; not safe to reconstruct generically. |
| `phy_init` `0x15000/0x1000` | Radio calibration | May contain per-device calibration | Read-only backup possible; do not assume factory values are equivalent. Keep intact. |
| `nvs_key` `0xC20000/0x1000` | NVS encryption key partition if used | Key material is device-specific; source config currently says NVS encryption unset, but this is not the installed device state | Read-only backup possible but secret. Must remain paired with its NVS and same gateway. No restore is approved. |
| SPIFFS `0xC21000/0x300000` | Files/application state | May include device-specific content | Read-only backup possible; no verified reconstruction path. Preserve. |
| Security eFuses | Secure Boot keys/purposes/revocations, download restrictions, version floor | Unique and irreversible | Read-only inspection only. Not backed up as restorable data; never program during recovery. |

## F. Failure and recovery scenarios

| Failure | Evidence-based expectation | Current recovery position |
|---|---|---|
| Invalid image format or rejected signing key | Generic ESP-IDF Secure Boot V2 docs say the bootloader verifies selected apps and may try another app if verification fails. Public WG1200 source signs apps. Installed bootloader not matched. | Fallback is unverified on this unit; inspect both OTA images and metadata read-only. |
| Candidate security version below floor | Supplied candidate was version 0 at observed floor 0, so this case was not tested. Device anti-rollback enforcement remains unknown. | Do not rely on the previous OTA being eligible; require matching bootloader/config evidence. |
| Valid app crashes | Public app-level guard may switch OTA after three classified crash boots. It is not bootloader logic and not proven deployed. Power-on resets its counter in the public implementation. | Do not manually power-cycle repeatedly to “help” rollback. Capture logs and let the gateway remain on stable power while observing. |
| App fails during initialization | Guard counts specific panic/watchdog/soft-watchdog reset causes; failures that do not reach or trigger that path may not be handled. | Recovery by guard unknown; use passive log capture and read-only inspection. |
| OTA metadata write interrupted | CLI writes the alternate sector and preserves/checks the peer; generic ESP-IDF uses two-sector selection. No physical power-interruption test or installed bootloader match exists. | Treat boot choice as uncertain; read both sectors and do not rewrite while ambiguous. |
| OTA metadata corrupted | CLI marks non-erased invalid records ambiguous. Generic factory fallback on erased metadata is not proof for arbitrary corruption on this device. | Do not use `--recover` as a repair authorization; write gate remains blocked. |
| Factory app still valid | ESP-IDF can select factory when OTA selection is erased, but the gateway's exact factory state/signature was not reported in latest validation. | Verify complete factory image/signature read-only before any proposed metadata change. Existing internal rollback helper is not sufficiently validated. |
| Both OTA apps invalid | Secure Boot may reject both; factory may remain a separate boot option if metadata and partition table permit. | ROM access may allow reflashing, but app/metadata repair order and exact signed artifacts are not yet approved. |
| Second-stage bootloader corrupt/rejected | ROM download remains a separate immutable path, but normal SPI boot cannot continue without a valid signed second-stage image. | Requires a supported signed bootloader artifact and recovery method. None is identified; vendor service/RMA may be necessary. |

ESP-IDF rollback `NEW` / `PENDING_VERIFY` is conditional on the bootloader rollback option. The public WG1200 profile does not enable that option and the CLI writes `VALID` directly. The app crash guard is a distinct, later application behavior. Do not count either mechanism as proven rollback for the installed gateway.

## G. Recovery prerequisites

Before any controlled write is considered:

1. Obtain an authoritative bootloader artifact or reproducible release record and match it to the installed bootloader using normalized bytes/hash and signature evidence.
2. Capture the actual flash chip ID/capacity, bootloader startup logs, full partition inventory, both OTA records, and descriptors with the read-only commands below.
3. Establish flash-encryption and relevant NVS-encryption eFuse state read-only.
4. Make and verify a sensitive same-device backup under an approved encrypted-storage process; prove each read covered the exact expected byte count. No suitable CLI backup command currently exists.
5. Document physical ROM entry via the available CH340/reset/boot-strapping controls after an app boot failure. Current ROM access is evidenced only in normal read-only inspection.
6. Obtain a vendor-approved image and a recovery plan that preserves factory, certificates, NVS, NVS keys, SPIFFS, the active OTA, and eFuses.
7. Review the transaction, install gate, full protected-slot hashing cost, and post-boot health criteria on a sacrificial equivalent gateway before the target unit.

## H. Unexecuted recovery runbook

This is a plan, not authorization to write, erase, or change metadata.

1. Keep stable power. If the app is crash-looping, capture logs passively and
   allow its self-restart behavior to run without repeated manual power cycles.
   Stop if heat, electrical, or other hardware concerns arise.
2. Capture UART logs at 115200 baud using the passive `monitor` command below.
   A single intentional reset is required to capture startup from the top;
   reset the unit only if the maintainer judges that operationally safe. The
   monitor itself sends no bytes and does not toggle DTR/RTS.
3. Re-enter ROM and run only `security`, `info`, `status`, and `flash --dry-run`.
   Record the exact binary build metadata, chip/flash capacity, validated
   partition layout, OTA sectors, descriptors, eFuse download restrictions,
   and candidate trust. Redact output before sharing.
4. If OTA state is ambiguous, do not run `flash --recover`, clear `otadata`, or
   select factory. Verify both OTA images and the factory image against trusted
   signed artifacts first; the current tools do not provide sufficient
   recovery proof.
5. If ROM access is available, use a reviewed read-only backup procedure and
   preserve the original data locally. Confirm flash-encryption semantics and
   exact byte counts before treating a backup as restorable.
6. Only after vendor-supported procedure, exact artifacts, backup, and a
   separate safety review exist should a recovery write be considered. Prefer
   a signed app update into the validated inactive OTA slot, retain the known-
   good slot and all identity/state partitions, then update only metadata using
   verified ESP-IDF semantics. This CLI currently blocks that write.
7. If the second-stage bootloader or partition table requires repair, stop and
   use a vendor-approved process or service path. Do not use generic full-flash
   restore helpers.
8. After any authorized recovery, re-read partition/OTA state and protected
   hashes, observe boot logs and expected slot/version, then apply a separately
   defined application-health check. No such physical recovery has been run.

## Read-only Raspberry Pi commands

These commands may reset the gateway while entering ROM mode, but they do not
write/erase flash or program eFuses:

```sh
./weatherxm-flash-linux-arm64 --version --verbose
./weatherxm-flash-linux-arm64 security --port /dev/ttyUSB0 --json --redact
./weatherxm-flash-linux-arm64 security check weatherxm --port /dev/ttyUSB0 --json --redact
./weatherxm-flash-linux-arm64 info --port /dev/ttyUSB0 --json --redact
./weatherxm-flash-linux-arm64 status --port /dev/ttyUSB0 --json --redact
./weatherxm-flash-linux-arm64 flash weatherxm --port /dev/ttyUSB0 --dry-run --json --redact
```

For normal startup logs without changing serial control lines, start this in
one terminal, then (only if safe) press the gateway's normal reset control
once while it is running:

```sh
./weatherxm-flash-linux-arm64 monitor --port /dev/ttyUSB0 --baud 115200 \
  --redact --output ./wg1200-boot-redacted.log
```

Stop with Ctrl+C. The public release config uses INFO logging on UART0 at
115200, but the installed configuration is unknown; absent output is
inconclusive. Review logs before sharing.

The following extra esptool/espefuse commands are read-only, but they may
reset the device and can print identifiers. Use the installed supported CLI
version, review/redact output, and never add a `write`, `erase`, `burn`,
`program`, `merge`, or `--force` operation:

```sh
espefuse.py --chip ESP32-S3 --port /dev/ttyUSB0 summary
esptool --chip ESP32-S3 --port /dev/ttyUSB0 --baud 115200 \
  read-flash 0x0 0xC000 /secure/local/path/wg1200-boot-region.bin
sha256sum /secure/local/path/wg1200-boot-region.bin
esptool image-info /secure/local/path/wg1200-boot-region.bin
```

`read-flash` is a file backup of the reserved bootloader area only, not a full
device backup. Confirm that the device partition table still places its start
at `0xC000` before using that length. Protect the file as firmware material;
do not upload it. The eFuse `summary` operation is read-only; eFuse programming
is prohibited.

## Outstanding blockers

- The installed bootloader binary/configuration and exact rollback semantics
  remain unidentified.
- UART logs and bootloader-range read/hash have not been captured for this
  follow-up.
- Flash-encryption state and an approved sensitive backup procedure are
  unknown; no full backup exists.
- Recovery by CH340 after failed application boot has not been demonstrated.
- The newly added full preserved-slot hash/recheck code is not hardware-tested;
  it also adds roughly 33.5 minutes of payload reads at 115200 baud.
- No recovery attempt or physical firmware-write/boot-health test has occurred.
- The install policy remains hard-blocked.

## References

- [ESP32-S3 Secure Boot V2](https://docs.espressif.com/projects/esp-idf/en/v5.5.3/esp32s3/security/secure-boot-v2.html)
- [ESP32-S3 OTA and rollback](https://docs.espressif.com/projects/esp-idf/en/v5.5/esp32s3/api-reference/system/ota.html)
- [ESP32-S3 ROM download security configuration](https://docs.espressif.com/projects/esp-idf/en/v5.5/esp32s3/api-reference/kconfig.html)
- [ESP32-S3 esptool read-flash command](https://docs.espressif.com/projects/esptool/en/latest/esp32s3/esptool/basic-commands.html)
- WeatherXM public firmware source: `a30374b045c138dac3f6dd4267ef8eb7390a7670` (source evidence only)
- WeatherXM web-flasher: `35b2ecc4ccb31799ecd720609786362a99b3e33a` (implementation reference only)
