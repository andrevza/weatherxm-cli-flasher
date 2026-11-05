# WG1200 recovery readiness

## Bootloader identification research (5 November 2026)

Espressif documents the ESP32-S3 second-stage bootloader at flash offset
`0x00000`; the WG1200's validated partition table begins at `0x00C000`, so
`0x00000..0x00BFFF` is the device-specific upper bound for that flash area.
This is an address bound, not a proven bootloader file length. The standard
ESP image begins with magic `0xE9`, a segment count, and segment headers with
lengths. Its checksum has alignment padding; an optional SHA-256 digest may
follow, and Secure Boot V2 uses a signature sector. A read covering the whole
area can therefore include erased/padding bytes and cannot be called the
bootloader binary hash without reliable end-boundary parsing. `esptool image-info`
can decode image structure and, when a bootloader descriptor is present,
report its version, ESP-IDF version, and build time. Those fields are optional
and do not reveal the complete compile-time Kconfig.

The current CLI has no read-only command that exports and validates precisely
the bootloader image extent. No such command was added: the exact binary end,
including this unit's signed-image layout, has not been demonstrated. The
existing internal full-flash reader is not an acceptable fallback because it
does not enforce complete reads for every chunk and retains sensitive device
data in memory. A future diagnostic needs exact layout validation, bounded
reads, exact length checks, and hash calculation before it can be considered.

For manual read-only triage, an operator with Espressif `esptool` may capture
the validated pre-table area to a local file:

```sh
esptool --chip esp32s3 --port /dev/ttyUSB0 read-flash \
  0x000000 0x00C000 wg1200-pre-table-area.bin
sha256sum wg1200-pre-table-area.bin
esptool --chip esp32s3 image-info wg1200-pre-table-area.bin
```

This reads flash and resets/enters the ROM loader, but does not write or erase.
The SHA-256 is for the entire 48 KiB pre-table area, not the bootloader image.
The `image-info` output is exploratory because the capture may contain padding
after the image; do not treat its file length or extracted strings as a
verified bootloader extent, signature result, configuration record, or vendor
match. Keep the capture local and review it before sharing. A trustworthy
bootloader-only digest still needs a format-aware, Secure-Boot-V2-aware
boundary determination validated for the installed layout.

The public WeatherXM WG1200 firmware repository and web flasher provide source
and application firmware workflows. The firmware repository also contains
`tools/update_wg1200_bootloader.py`, which builds or validates local signed
bootloader artifacts, checks configured safety settings and Secure Boot V2
signature information, and has device backup/update modes. No exact production
artifact is tracked in the reviewed checkout, and no matching artifact was
located; the reviewed [GitHub Releases page](https://github.com/WeatherXM/wg1200-firmware/releases)
lists no releases. The helper is a build/replacement tool, not evidence that
its current source output matches this gateway. Its backup-only path exports
raw device data; it was not run. Application firmware artifacts cannot stand
in for the bootloader. This review does not prove no vendor-held artifact exists.

Compile-time OTA rollback support remains unknown for the installed unit.
ESP-IDF says rollback is implemented by the bootloader and is controlled by
build configuration; observable application metadata or absent log strings do
not establish that configuration. The public source profile is useful context,
not proof of the installed binary's configuration. Likewise, absence of boot
logs is inconclusive.

### Maintainer-reported app-side bootloader inventory

The Pi monitor report now includes `unknown pin (May 27 2024, sha=64e8c47e)`.
In the stated WeatherXM source revision
`a30374b045c138dac3f6dd4267ef8eb7390a7670`, this line is produced by
`main/utils.cpp:1404-1528` in `Utils::detect_bootloader()`, called by the
getters in `tb_json.cpp`. The function reads `0xC000` bytes from flash offset
zero with `esp_flash_read()` in 2048-byte chunks, computes SHA-256 over that
entire region, and exposes the full digest as `gw_bootloader_sha256`. The
reported 8-hex-character value is the log prefix of that region hash; it is
not a hash of only the parsed ESP image. The application therefore did inspect
flash independently of its own build metadata, assuming the reported line is
from this implementation and the hash completed successfully.

`KNOWN_BOOTLOADERS` compares the full `0xC000`-byte-region digest against five
known entries labeled with their factory-reset GPIO mapping. `unknown pin`
means no table entry matched, so the source has no known reset-pin mapping for
the observed image. It does not mean the chip pin itself is unknown. The
prefix `64e8c47e` does not match the prefixes of any entry in the reviewed
table; the full device digest was not included in the report. The source scans
raw region bytes for the first string shaped like `Mmm DD 20YY`; it does not
parse or validate an ESP bootloader descriptor before printing it. `May 27
2024` is consistent with the bootloader compile date and the public config
enables `CONFIG_BOOTLOADER_COMPILE_TIME_DATE`, but the scan alone cannot prove
the date belongs to the image. The source's current full table, date, and
region hash are useful classification evidence, not a matching official
bootloader artifact or proof of its complete Kconfig.

The same source publishes the full region digest as `gw_bootloader_sha256` in
its ThingsBoard attribute JSON. If that existing telemetry is available, the
operator can compare the full value with the source table without exporting a
flash dump. The tool's device modes were not run. In particular,
`--backup-only` creates raw device backups and is not a no-export diagnostic.

The reviewed `sdkconfig.wg1200_release` leaves
`CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE` unset. The same source's
`main/boot_guard.cpp` implements an application-level fallback after three
classified crash boots, using the other OTA slot if it has a valid app
descriptor; a power-on reset clears the crash counter, and 600 seconds of
healthy uptime or ThingsBoard connectivity clears it as well. This guard can
only run after an application starts and initializes NVS. The physical log
proves the running application executed its bootloader inventory code, but it
does not identify that app's exact source build or prove this `boot_guard.cpp`
was installed. The boot-guard source is already present in WeatherXM's public
v0.8.27 source snapshot, earlier than the maintainer-reported app version
`0.8.34`; that makes deployment plausible but the app version string is not a
source/binary match. Keep deployed rollback behavior unconfirmed.

Generic ESP-IDF Secure Boot V2 documentation says the bootloader tries another
application image if verification of the selected image fails. Generic ESP-IDF
OTA data uses two sectors with CRC/sequence selection and rollback states are
conditional on bootloader configuration. Those are platform behaviors, not
verified behavior of the unmatched installed bootloader. The CLI's own
transaction writes only the inactive OTA slot and changes one validated OTA
metadata sector after checks; it preserves the active slot in code and in
mocked tests. The maintainer's dry run selected `ota_0` while `ota_1` was
active, but no physical write exercised that preservation. A partial metadata
commit can leave selection uncertain; do not manually repair or clear
`otadata`.

To observe normal startup messages, connect the CH340 and passively listen:

```sh
wg1200 monitor --port /dev/ttyUSB0 --baud 115200 --timestamp --level info --redact
```

The monitor sends no serial bytes and does not toggle DTR/RTS. It only sees
messages produced after it opens; a single ordinary reset is needed to see
startup from the beginning, and should be done only when operationally safe.
Do not provoke a crash or repeatedly power-cycle the gateway to infer rollback.

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
The earlier supplied inspection also reported `ota_0` at `v0.6.1-dirty`. The
maintainer subsequently reported the app-side pre-table hash log documented
below, but supplied neither a raw flash capture nor the full hash. No flash
backup is reported. These are maintainer-supplied records, not Codex hardware
access.

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

No exact bootloader binary, image-only digest, or artifact match has been
supplied. The maintainer-reported app-side full pre-table-area digest prefix is
new content evidence, not an image-only hash. Public source commit
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

Prefer retrieving the existing `gw_bootloader_sha256` telemetry attribute
before extracting anything. The app already computes this region digest at
boot; a raw flash capture would add sensitive device data without improving
the current `unknown pin` classification. Only if independent byte-level
corroboration is specifically needed, a bounded read-only capture is
technically possible after validating the device's 16 MiB flash and table
offset. With Espressif esptool 5.x, the commands are:

```sh
esptool --chip ESP32-S3 --port /dev/ttyUSB0 --baud 115200 \
  read-flash 0x0 0xC000 /secure/local/path/wg1200-boot-region.bin
sha256sum /secure/local/path/wg1200-boot-region.bin
```

This performs reads only and creates a local binary containing the reserved
pre-table area, not a proven exact bootloader file. Do not share it or console
logs. Its hash can corroborate `gw_bootloader_sha256` only if the read returns
all 0xC000 bytes and no flash contents changed. Because this capture contains
padding and possibly Secure Boot V2 signature data, do not call it a
bootloader-only digest or infer configuration from it. No exact matching
WeatherXM artifact was found in the inspected source checkout.

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

No pre-existing full-flash or partition backup is recorded. The app-side
48 KiB region digest provides integrity evidence for the pre-table area but
not a retained bootloader file. Read-only full-content inventory is technically
possible where ROM download commands and flash access permit it, but the
resulting files would contain credentials and device-specific data. Current
CLI inspection establishes partition metadata, descriptors, selected
identity/eFuse evidence, and OTA state; it does not hash or retain every
partition's full contents as a standalone read-only inventory. The actual
flash-encryption eFuse state must first be established from read-only eFuse
summary evidence; the public source's flash-encryption build settings are not
device evidence. Store any backup encrypted, locally, with restricted access,
and never publish it. A raw backup is only potentially restorable to the same
gateway and same flash offsets; copying NVS, certificates, or key material to
another gateway is unsafe.

| Data | Recovery role | Device-specific / reconstructable | Backup and restore position |
|---|---|---|---|
| Flash chip / full 16 MiB | Capacity and geometry bound all offsets | Physical flash model is not identified in supplied evidence; 16 MiB capacity is reported | Read-only `flash-id` is possible. Do not infer manufacturer/model from capacity alone. |
| Bootloader region `0x00000..0x00BFFF` | Starts second-stage boot and enforces signatures | App-reported full-region hash exists in principle; supplied log has only prefix `64e8c47e`, unmatched in reviewed source table. Exact image/configuration not identified. | App reads/hash the region; no raw dump retained. Restore only an exact supported signed artifact under a reviewed procedure; no matching artifact established. |
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
- The Pi monitor line is maintainer-reported; the full
  `gw_bootloader_sha256` telemetry value and an exact artifact match have not
  been obtained.
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
- [ESP32-S3 bootloader image description](https://docs.espressif.com/projects/esp-idf/en/v5.5.1/esp32s3/api-reference/system/bootloader_image_format.html)
- [ESP32-S3 ROM download security configuration](https://docs.espressif.com/projects/esp-idf/en/v5.5/esp32s3/api-reference/kconfig.html)
- [ESP32-S3 esptool read-flash command](https://docs.espressif.com/projects/esptool/en/latest/esp32s3/esptool/basic-commands.html)
- WeatherXM [`main/utils.cpp`](https://github.com/WeatherXM/wg1200-firmware/blob/a30374b045c138dac3f6dd4267ef8eb7390a7670/main/utils.cpp#L1381-L1528), [`main/tb_json.cpp`](https://github.com/WeatherXM/wg1200-firmware/blob/a30374b045c138dac3f6dd4267ef8eb7390a7670/main/tb_json.cpp#L383-L394), [`main/boot_guard.cpp`](https://github.com/WeatherXM/wg1200-firmware/blob/a30374b045c138dac3f6dd4267ef8eb7390a7670/main/boot_guard.cpp), [`sdkconfig.wg1200_release`](https://github.com/WeatherXM/wg1200-firmware/blob/a30374b045c138dac3f6dd4267ef8eb7390a7670/sdkconfig.wg1200_release), and [`tools/update_wg1200_bootloader.py`](https://github.com/WeatherXM/wg1200-firmware/blob/a30374b045c138dac3f6dd4267ef8eb7390a7670/tools/update_wg1200_bootloader.py) at reviewed source revision `a30374b045c138dac3f6dd4267ef8eb7390a7670` (source evidence only)
- WeatherXM web-flasher: `35b2ecc4ccb31799ecd720609786362a99b3e33a` (implementation reference only)
