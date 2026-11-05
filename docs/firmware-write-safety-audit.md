# WG1200 firmware-write safety audit

## A. Audit baseline

The documentation-only hardware record was committed first as
`7453fdf060927123ebeb1e9cee87206916a796c8`. The safety review began from this
clean working tree and audited the source at that commit. The available
independent sibling checkout `../web-flasher` is clean at
`35b2ecc4ccb31799ecd720609786362a99b3e33a`, the upstream revision identified in
`UPSTREAM_NOTICES.md`; its `origin` is the official
[`WeatherXM/web-flasher` repository](https://github.com/WeatherXM/web-flasher/tree/35b2ecc4ccb31799ecd720609786362a99b3e33a). No network fetch of the remote branch was
available during this audit, so this identifies the locally reviewed upstream
reference, not a claim that it is the latest remote revision.

The project declares Apache-2.0 and retains `LICENSE` and per-file upstream
attribution; upstream notices identify adapted and unchanged files. Runtime
versions pinned in the lockfile include `esptool-js` 0.7.0 and `spark-md5`
3.0.2; SerialPort is declared `^13.0.0` and its resolved version is in
`package-lock.json`. Release builds use Node 26.8.2 for Linux ARM64 and 26.13.0
for Linux x64/macOS ARM64, native runners, and a Linux ARM64 ELF/page-alignment
check. Release tags trigger builds and a hardware-gated draft release. The
current environment has no `node` executable, so its exact Node/npm runtime and
the resolved package versions could not be queried here.

## B. Implementation mapping

The audit mapped the source flow at baseline commit `7453fdf…` to the official
checkout and the installed `esptool-js` 0.7.0 source. The CLI differs from the
browser upstream in its Node serial adapter, explicit `--yes` / typed
confirmation, same-origin HTTPS manifest restriction, strict exact partition
layout validation, and post-write transaction wrapper.

| Stage | CLI implementation and evidence | Upstream comparison |
| --- | --- | --- |
| Manifest retrieval | `catalog.ts` → `fetchCatalog`; `manifest.ts` → `validateManifest`, `loadManifest` | Same schema and official catalog intent; CLI requires HTTPS. |
| Firmware download | `device.ts` → `loadSelectedFirmware`; `manifest.ts` → `fetchAndVerifyFirmware` | Same selected binary retrieval. |
| Image hash | `fetchAndVerifyFirmware` exact length, 4 MiB maximum and SHA-256 from manifest | Matches upstream. Manifest authenticity itself is not signed/anchored here. |
| Firmware type | Descriptor parsed by `appDescriptor.ts`; manifest category checked; `firmwareComparison.ts` compares type | Similar descriptor/category checks. |
| ESP32-S3 identification | `transport.ts` → `connect`, `inspect`; `device.ts` → `assertSafeInspection` | Adapted ROM loader identification; CLI requires 16 MiB and exact layout. |
| Secure Boot V2 | `writeGuard.ts` / `manifest.ts` check signature-block marker `0xE7`; transport applies RAM-stub workaround | Marker presence is not signature verification or trust-key matching. Upstream uses the same marker-level image check. |
| Partition validation | `partitions.ts`; `device.ts` → `validateExactPartitionLayout`, `exactLayoutErrors` | CLI is stricter: MD5 required, exact names/fields/flags, duplicates, overlap, padding. |
| OTA inspection | `transport.ts` → `inspect`; `otadata.ts` → `determineActiveBootSlot` | Sequence/CRC-based mapping; compares two records and treats damaged non-erased metadata as ambiguous. |
| Inactive selection | `otadata.ts`; re-inspected immediately before writes in `flashDevice` | Target is derived from metadata and exact validated constants. |
| Flash erase | `transport.ts` → `installApplication`; `writeGuard.ts` → `assertAllowedApplicationWrite`; `esptool-js` `flashDeflBegin` | `eraseAll:false`; per-image esptool erase, not whole-chip. Size/offset are guarded. |
| Flash writing | `installApplication` calls `ESPLoader.writeFlash` compressed; esptool sends sequence-numbered blocks and checks command responses | Same esptool-js mechanism. Transport completion alone is not final verification. |
| Flash verification | `transport.ts` → `verifyApplicationFlash` uses chip `flashMd5sum(offset,length)` | On-device MD5; independent host readback is not performed. |
| Protected regions | `snapshotProtectedRegions` / `verifyProtectedRegions` hash table, secure cert, NVS, NVS key | Upstream snapshots same four. Write guard also excludes table, cert, NVS, otadata, PHY, NVS key and SPIFFS. Factory and PHY/SPIFFS are not hash-snapshotted. |
| OTA metadata | `otadata.ts` → `buildTransactionalOtadataSector`; `transport.ts` → `writeOtaSelectSector` validates one sector readback | One sector, sequence/state/CRC checked, peer sector left untouched. CLI now checks protected snapshots before this commit. |
| Reset | `transport.ts` → `hardReset`, then `disconnect` | Serial line reset; not an OTA-specific firmware API. |
| Boot / health | `serialLog.ts` → `captureBootLogs`, `analyzeBootLogs`; result reports boot indicators | Informational observation only. It does not prove application health; API marks health `not-checked`. |

The official source flow and the CLI both treat image authenticity as manifest
hash plus signature-block presence. Neither locally verifies a Secure Boot V2
signature against the device's enrolled key digests, nor compares image
security-version fields with eFuse anti-rollback state. The bootloader may
reject an image that passes the host-side checks.

### Added: read-only Secure Boot V2 evidence and candidate checks

The CLI now provides `security --port <path>` and
`security check <weatherxm|meshtastic> --port <path>`. Both connect through
`ESPLoader.detectChip()` and stay in the ROM loader: this path skips
`runStub()`, flash-ID probing, flash reads/writes/erases, and all eFuse write
commands. The ROM-loader reset/entry behavior can restart the gateway. The
security command reads only ESP32-S3 eFuse read-register addresses validated
against Espressif's [ESP32-S3 eFuse memory definition](https://github.com/espressif/esptool/blob/master/espefuse/efuse/esp32s3/mem_definition.py).
Secure Download Mode and other ROM restrictions can make register evidence
unavailable; failures remain `UNKNOWN`/`unavailable` rather than being treated
as zero.

Reported fields include Secure Boot V2 enablement, key purposes, key-block read
protection, key digests, digest-slot revocation, the security-version floor,
and download-mode restrictions. Only blocks assigned a Secure Boot digest
purpose are read as key digests. Duplicate purposes, protected blocks, failed
reads, or unexplained chip identity are surfaced as ambiguous or unavailable.
The key digest is SHA-256 over the Secure Boot V2 public-key data (modulus,
exponent, and Montgomery constants).

### Key-digest read diagnosis

Espressif's ESP32-S3 eFuse definition maps `BLOCK_KEY0` to physical block 4,
read-register base `EFUSE_BASE + 0x09C`, and eight 32-bit words. Its read-disable
bit is `RD_DIS[0]`; `KEY_PURPOSE_0 = SECURE_BOOT_DIGEST0` selects this block as
logical Secure Boot digest slot 0. The register map and block/alias mapping are
confirmed by Espressif's [official definition](https://github.com/espressif/esptool/blob/master/espefuse/efuse/esp32s3/mem_definition.py).

The unavailable digest report was caused by signed conversion, not an
incorrect block address or word count. In the installed `esptool-js` version,
`readReg()` returns the `READ_REG` response assembled with JavaScript bitwise
operators; the top bit therefore makes a valid 32-bit register word a negative
JavaScript number. The decoder rejected negative values before byte decoding.
Eight digest words are independently random-looking, so this affected most
real digests. The correction accepts the signed-int32 representation and
normalizes it with `>>> 0`. Byte ordering matches Espressif `espefuse`: its
implementation reads eight ascending registers, reverses the word list to
construct its bit array, then reverses those bytes for display. The CLI writes
each word's bytes little-endian in ascending address order, yielding the same
display/digest bytes.

Each digest slot now includes a bounded `readDiagnostic`: logical slot,
physical block, register base offset, expected/read word counts, failed word and
offset when present, and a fixed error category. It never includes raw register
values or unrestricted exception text. A complete all-zero or all-one block
remains ambiguous and cannot be accepted as a trusted digest. Secure Download
Mode may separately restrict register operations; a failed read reports its
category and remains unavailable. The supplied Raspberry Pi result predates
this correction, so the new digest decoder still requires read-only physical
revalidation before device trust can be claimed.

Candidate checks first use the existing HTTPS catalog and manifest SHA-256
validator. They then validate the ESP image header/segments, ESP32-S3 chip ID,
segment XOR checksum, appended image SHA-256, 64 KiB WG1200 page boundary,
signature-sector structure/CRC/reserved bytes, RSA-3072 encoding and
Montgomery constants, signed-image digest, and RSA-PSS/SHA-256 signature with
32-byte salt. RSA signature verification uses Node's OpenSSL-backed
cryptographic implementation. These layout and cryptographic parameters follow
Espressif's [Secure Boot V2 guide](https://docs.espressif.com/projects/esp-idf/en/v5.5.3/esp32s3/security/secure-boot-v2.html),
[firmware image format](https://docs.espressif.com/projects/esptool/en/latest/esp32/advanced-topics/firmware-image-format.html),
and [esptool image implementation](https://github.com/espressif/esptool/blob/master/esptool/bin_image.py).
Candidate signatures are then matched to readable, correctly purposed,
non-revoked device digest slots. Image signature validity and device trust are
reported independently.

The descriptor's `secure_version` is compared with the device eFuse floor.
However, the eFuse does not establish whether the installed bootloader was
built with `CONFIG_BOOTLOADER_APP_ANTI_ROLLBACK`; the public WG1200 firmware
configuration is not proof of the connected gateway's installed bootloader.
Therefore enforcement is explicitly `unknown`, and a key match alone cannot
produce `TRUSTED`. Application boot acceptance, OTA rollback configuration,
and application health are not established. This feature does not alter the
existing `security-blocked` firmware-writing policy.

No physical gateway was measured as part of this implementation. Hardware
validation requires capturing unredacted/local and redacted output from the
commands in the final report, recording chip revision and read availability,
and independently matching the key digest to a trusted firmware signing-key
record. Do not treat synthetic unit fixtures as gateway evidence.

## C. Findings

### Fixed: protected-region failure happened after OTA selection

**Severity: High.** At baseline `7453fdf`, `runOtaWriteTransaction` wrote and
verified the OTA select sector before calling `verifyProtectedRegions`. If a
protected-region mismatch was then found, the command failed but the new image
was already selected for the next boot. This violated the stated transaction
ordering and could turn a preservation failure into an activated image.

The fix moves the full protected-region verification before the metadata write
and includes “OTA activation was not attempted” in the mismatch error. A
deterministic mock regression asserts the sequence and proves metadata write and
reset are absent on mismatch. This fix is in the audit changes after baseline;
the separately committed hardware validation executable did not contain it.

### Addressed for read-only checks; install gate retained: Secure Boot trust

**Severity: Critical / still blocks physical flashing.** The original audit
found only marker and manifest-hash checks. The read-only `security check`
command now verifies the signed image and compares its key digest with readable
device eFuse digests. It also reports the descriptor security version against
the eFuse floor. The installed bootloader's anti-rollback configuration and
OTA rollback behavior remain unknown, so this is not sufficient to permit
writes and the fail-closed `securityPolicy.ts` remains unchanged.

### Blocking: protection snapshots omit writable-but-protected regions

**Severity: High / blocks physical flashing.** Snapshot code records SHA-256
only for the partition table, `esp_secure_cert`, `nvs`, and `nvs_key`. The
16 MiB map and write guard additionally designate factory, `phy_init`, and
`spiffs` as protected, but those byte ranges are not compared after the app
write. The range guard makes ordinary application writes disjoint from them,
but the transaction currently has no runtime evidence that they remained
unchanged. Add matching snapshots/checks (including factory if the chosen policy
requires proof of preservation), with exact identical ranges and tests.

### Blocking: no physical firmware-write evidence or confirmed health gate

**Severity: High / blocks readiness.** The supplied hardware record covers
read-only inspection only. The CLI observes boot text after the reset, but
does not require the expected slot, firmware descriptor, Secure Boot success,
or application-health result before reporting the transaction stages complete.
No firmware write/erase/OTA change is authorized or performed in this audit.

### Protocol and boundary assessment

The app target is checked as wholly contained in one non-factory OTA partition,
with positive integer length, safe-integer end arithmetic, 4 MiB maximum and
16 MiB flash bound. Both OTA offsets and sizes are 4 KiB aligned; app offset is
also 16-byte aligned. `esptool-js` pads input to 4 bytes, rounds erase using the
chip's `getEraseSize`, sends `FLASH_DEFL_BEGIN` / compressed data blocks with
sequence acknowledgements and exits compressed mode before returning. A full
4 MiB image is the maximum; the slot is sector-aligned, so sector rounding at
the end remains within that slot. `eraseAll:false` prevents the whole-chip erase
path. App MD5 verification is a separate command after write completion.

`esptool-js` source shows ACK waits for compressed block operations, but stub
protocol distinguishes receipt from subsequent flash write timing; final
`flashDeflFinish` is awaited and an explicit on-chip MD5 read follows. A timeout,
disconnect or partial response throws; there is no automatic destructive
retry in this wrapper. The established `READ_FLASH` trailing 16-byte digest
fix is covered separately by `flashReadProtocol.test.ts`. No evidence was found
that the current wrapper interprets transmission completion as verified flash.
Relevant references are the pinned [`esptool-js` 0.7.0 source](https://github.com/espressif/esptool-js/tree/v0.7.0)
and Espressif's [ESP32-S3 esptool write/verify documentation](https://docs.espressif.com/projects/esptool/en/release-v4/esp32s3/esptool/advanced-commands.html).

## D. Flashing state machine

1. Retrieve and validate HTTPS manifest and selected image (no device mutation).
2. Connect to ROM loader; inspect chip, flash, identity, partition table,
   credentials, OTA records and descriptors; enforce exact layout.
3. Compare active firmware and selected descriptor; apply downgrade/type/force
   policy. Dry-run returns before any write operation.
4. Obtain the reviewed confirmation; re-inspect identity/OTA target and refuse
   if the bound device state changed.
5. Snapshot currently configured protected regions.
6. Erase/write only the metadata-derived inactive OTA app range using
   `eraseAll:false`; any failure leaves OTA selection untouched.
7. Verify exact image-length on-chip MD5; mismatch leaves selection untouched.
8. Verify recorded protected-region hashes; mismatch leaves selection untouched
   after the fix.
9. Write a single alternate 4 KiB OTA sector with next sequence, state `VALID`
   and CRC; read back and validate sequence/state/CRC. The previous metadata
   sector remains untouched.
10. Reset/disconnect, capture logs, and report observed boot signals. This is not
    an application-health gate.

The CLI writes state `ESP_OTA_IMG_VALID` directly, rather than staging a `NEW`
or `PENDING_VERIFY` state and relying on an application confirmation/rollback
cycle. ESP-IDF documents two-sector OTA selection for power-loss resilience and
rollback semantics tied to `NEW` / `PENDING_VERIFY`; the shipped gateway's
bootloader/application configuration and compatibility of this direct `VALID`
record have not been established from authoritative WG1200 firmware sources.
This uncertainty is another physical-write blocker. CRC is computed over the
little-endian sequence using ESP ROM CRC32 convention; sequence overflow and
near-wrap behavior are not explicitly rejected and require confirmation against
the device's ESP-IDF version/bootloader behavior. Espressif documents the
two-sector power-loss design and `NEW` / `PENDING_VERIFY` rollback flow in its
[ESP-IDF 5.5 ESP32-S3 OTA reference](https://docs.espressif.com/projects/esp-idf/en/v5.5/esp32s3/api-reference/system/ota.html).

## E. Protected-region guarantees

The observed fixed layout is enforced against constants: partition table
`0xC000/0x1000`; `esp_secure_cert` `0xD000/0x2000`; NVS `0xF000/0x4000`;
otadata `0x13000/0x2000`; PHY `0x15000/0x1000`; factory `0x20000/0x400000`;
ota_0 `0x420000/0x400000`; ota_1 `0x820000/0x400000`; NVS key
`0xC20000/0x1000`; SPIFFS `0xC21000/0x300000`. Table validation also checks
MD5, duplicate labels, exact entries, overlaps, flags, and erased trailing
bytes.

The absolute application writer guard denies factory and any range outside
exactly one OTA app partition. OTA metadata has a separate exact 4096-byte
sector guard. The application erase rounded by esptool remains within a
sector-aligned 4 MiB slot for accepted lengths. Current SHA-256 preservation
evidence covers only table, secure cert, NVS and NVS key. Factory, PHY and
SPIFFS preservation is range-policy evidence only, not post-write readback
evidence. Metadata's untouched peer sector is protected by targeting the other
sector but is not separately compared byte-for-byte.

## F. Failure and recovery matrix

| Failure point | Expected state / recovery | Retry guidance and report |
| --- | --- | --- |
| Download, manifest, hash, descriptor | Flash untouched | Correct input/connectivity; safe to retry. |
| Pre-write identity/layout/OTA validation or approval | Flash untouched | Resolve state or obtain explicit approval; no retry needed. |
| Erase/write timeout or disconnect | Inactive slot may be partially erased/written; old OTA metadata remains selected | Do not retry automatically; reconnect read-only, inspect OTA state and image integrity, then deliberate retry/recovery. |
| MD5 mismatch | Inactive slot uncertain; old selection remains | Stop; no metadata commit; inspect read-only before retry. |
| Protected-data mismatch | Inactive image written; old selection remains after fix | Stop; do not activate; investigate data loss and preserve logs. |
| Metadata write timeout/partial commit | Target sector may be erased, partial, or valid; peer sector preserved | Boot choice can be uncertain. Do not retry automatically; inspect both sectors read-only before recovery. |
| Metadata readback failure | Commit may have happened despite failed response | Treat selected state as uncertain; no automatic retry/reset. |
| Reset failure / unplug after commit | New record may select target on next boot; old app remains in peer slot | Reconnect read-only; observe boot and inspect OTA state. |
| Secure Boot rejection / invalid app startup | Could fail boot; rollback depends on gateway bootloader state and factory path | No CLI-proven automatic recovery. Stop and use vendor-supported recovery; no blind metadata clearing. |
| Application starts but is unhealthy | CLI captures only finite boot text and does not assess service health | Operator must evaluate separately; current CLI cannot certify health. |

The recovery statements above describe likely slot/metadata mechanics, not
physically demonstrated recovery on this gateway. The ambiguous-OTA `--recover`
path requires explicit typed confirmation and does not make it safe to override
unknown bootloader semantics.

## G. Test evidence and limitations

Existing automated coverage includes comparison policy, slots/presentation,
read-only safety, manifest/hash rejection, write boundaries, OTA CRC/sequence,
metadata readback, protected mismatch, transport read protocol, redaction,
standalone executable fixtures, and install script behavior. The new regression
proves that protected-region failure precedes and prevents OTA metadata commit.
All are mocks/fixtures; no test writes physical flash. A complete simulated 16
MiB flash operation ledger covering the entire requested matrix (all partial
acks, erase interruptions, malformed frames, CRC/commit failures and recovery)
does not yet exist.

Typecheck, full source test suite and source build passed in the repository's
Node 22 container: 64 tests passed and 7 tests were skipped because no
standalone-binary environment variable was set; 8 test files passed and the
standalone file was skipped. The one skipped installer case requires a suitable
standalone binary. A second attempt to activate the standalone tests with the
existing Linux ARM64 binary failed because the container lacked
`libatomic.so.1`; those failures do not establish a binary defect. The existing
macOS ARM64 executable runs on the host and reports Node.js v26.3.0, but it
predates the audit fix and is not evidence for modified-source standalone
packaging. The Linux ARM64 ELF validator passed for the existing executable and
SerialPort addon (5 and 2 PT_LOAD segments, respectively), using Bun to run the
pure-JavaScript validator; these artifacts predate the source fix. Full release
workflow checks remain unrun. No physical tests were run. This audit's modified
source must not be represented by the prior read-only hardware validation
record.

## H. Physical test readiness

**NOT READY FOR PHYSICAL FLASH TEST**

Blocking issues:

1. No locally verified Secure Boot V2 signature trust or anti-rollback check;
   no authoritative gateway signing-key/eFuse compatibility evidence.
2. Factory, PHY and SPIFFS are not included in post-write preservation hashes;
   the untouched OTA metadata peer sector also lacks byte-for-byte comparison.
3. The gateway's ESP-IDF/bootloader transaction semantics for directly writing
   `VALID`, rollback behavior, and sequence wrap have not been established.
4. No strict success gate confirms expected slot and firmware boot, Secure Boot
   log, or actual application health.
5. Requested regression/build/ELF/release checks could not run in this
   environment, and the requested broad deterministic 16 MiB fault-injection
   matrix remains incomplete.

No physical write procedure is provided because the readiness gate is not met.

## I. Follow-up investigation and current status (2026-11-05)

This follow-up starts at clean commit `a1e53b9e62c39beb25cba7efee77d3fcf5d83c69`.
The independently pinned web-flasher checkout remains at
`35b2ecc4ccb31799ecd720609786362a99b3e33a`. The reviewed public WeatherXM
firmware source checkout was `a30374b045c138dac3f6dd4267ef8eb7390a7670`
(`wg1200-firmware`, 2026-10-26); it is a source reference and is not proven to
be the exact firmware/bootloader installed on the previously observed gateway.
The lockfile resolves `esptool-js` 0.7.0 and SerialPort 13.0.0. No physical
device was connected or modified during this follow-up.

### Secure Boot V2 and anti-rollback assessment

The three checks are distinct:

| Property | What this CLI establishes | Assessment |
|---|---|---|
| A. Image structure | Manifest length and SHA-256, app descriptor, expected Secure Boot V2 signature-block marker `0xE7` | Format/manifest integrity only; the marker does not establish a valid signature. |
| B. Cryptographic signature | No RSA-PSS verification of the image signature against its embedded public key | Unverified. The public firmware repository does not contain its configured production private key. |
| C. Device trust | No comparison between the candidate key digest and active, unrevoked ESP32-S3 eFuse key digests | Unverified for the individual gateway. |

Espressif Secure Boot V2 stores SHA-256 key digests in eFuse key-purpose
blocks. Secure-boot enablement, key-purpose values, per-key revocation, and
read-protection state all matter. ROM-loader register reads could in principle
expose read-only eFuse state, and esptool-js provides low-level register reads,
but this project has no validated ESP32-S3 field decoder or cross-check against
the installed bootloader. The reviewed release profile sets
`CONFIG_SECURE_BOOT_V2_ALLOW_EFUSE_RD_DIS=y`, so relevant fields can be
read-protected. Missing, inconsistent, or protected values are inconclusive.
No eFuse operation was issued.

Espressif documents the ESP32-S3 digest/key-purpose/revocation model and the
`CONFIG_SECURE_BOOT_V2_ALLOW_EFUSE_RD_DIS` option in its [Secure Boot V2
guide](https://docs.espressif.com/projects/esp-idf/en/v5.5.3/esp32s3/security/secure-boot-v2.html).

The public `sdkconfig.wg1200_release` enables Secure Boot V2 and signed
applications, but its configured production key file is absent from the public
checkout. Its anti-rollback configuration is not enabled, and
`CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE` is not set. The new command compares
the app descriptor's `secure_version` with the device eFuse floor; it cannot
establish whether the connected gateway's installed bootloader enforces that
floor. Secure Boot and anti-rollback are independent. **Install blocker
unresolved.**

The independent option semantics are described in Espressif's [ESP32-S3 OTA
guide](https://docs.espressif.com/projects/esp-idf/en/v5.5/esp32s3/api-reference/system/ota.html): app rollback uses `NEW`/`PENDING_VERIFY` only when enabled, and anti-rollback separately compares image security version with the eFuse floor. The WeatherXM source inspected was pinned at [`a30374b045c138dac3f6dd4267ef8eb7390a7670`](https://github.com/WeatherXM/wg1200-firmware/tree/a30374b045c138dac3f6dd4267ef8eb7390a7670); its `sdkconfig.wg1200_release` and [`main/boot_guard.cpp`](https://github.com/WeatherXM/wg1200-firmware/blob/a30374b045c138dac3f6dd4267ef8eb7390a7670/main/boot_guard.cpp) are source evidence only, not proof of the gateway's installed build.

The safe resolution is to retain the hard write block in `securityPolicy.ts`.
Non-identical firmware checks report `security-blocked` with
`securityEvidence: "unverified"`; write attempts are rejected before any flash
operation and cannot be overridden by confirmation, `--yes`, `--force`, or
recovery flags. This is conservative, not proof that a candidate would fail.

### Protected-region coverage after hardening

Exact expected extents are validated against the partition table before the
transaction. Every non-OTA protected range below is read completely before the
app write and SHA-256 hashed incrementally; the same range is reread and
compared after app MD5 verification and before OTA activation. Reads use 4096
byte chunks, retaining one chunk at a time. Partial reads, timeouts,
disconnects, malformed/incomplete snapshot sets, or hash mismatches fail
closed. ROM-loader reads do not intentionally mutate flash.

| Region | Start | End (exclusive) | Size | Before / after | Integrity handling |
|---|---:|---:|---:|---|---|
| Partition table | `0x0C000` | `0x0D000` | `0x1000` | Full / full | SHA-256 equality; abort before activation |
| `esp_secure_cert` | `0x0D000` | `0x0F000` | `0x2000` | Full / full | SHA-256 equality; abort |
| `nvs` | `0x0F000` | `0x13000` | `0x4000` | Full / full | SHA-256 equality; abort |
| `otadata` | `0x13000` | `0x15000` | `0x2000` | Full snapshot / full precommit reread and postcommit read | Intentional target-sector mutation; validate state, sequence, CRC, target bytes and unchanged peer sector |
| `phy_init` | `0x15000` | `0x16000` | `0x1000` | Full / full | SHA-256 equality; abort |
| `factory` | `0x020000` | `0x420000` | `0x400000` | Full / full | SHA-256 equality; abort |
| `ota_0` | `0x420000` | `0x820000` | `0x400000` | Not hashed as protected | OTA target exception; metadata-selected active slot is not targeted; app gets on-chip MD5 verification |
| `ota_1` | `0x820000` | `0xC20000` | `0x400000` | Not hashed as protected | Same OTA-slot exception |
| `nvs_key` | `0xC20000` | `0xC21000` | `0x1000` | Full / full | SHA-256 equality; abort |
| `spiffs` | `0xC21000` | `0xF21000` | `0x300000` | Full / full | SHA-256 equality; abort |

Each non-OTA protected pass reads 7,372,800 bytes; both passes total
14,745,600 bytes. At 115200 baud and 10 serial bits per byte, payload alone
requires about 21.4 minutes. The 25 ms inter-chunk pacing adds about 90 seconds
across both passes, before ROM protocol and response overhead. Memory remains
bounded to a 4 KiB chunk plus hash state. Large ranges are not sampled and raw
data or hashes are not printed. The active OTA slot is protected by the
metadata-derived write guard rather than an additional full-slot digest.

The transaction reads both full OTA metadata sectors after confirmation and
compares their derived active/target state with the initial inspection. Before
commit it compares the complete 8192-byte snapshot, refuses to overwrite the
active sector, validates intended sequence and CRC, then reads the full
partition back and checks the target record and byte-identical peer sector.
Sequence `0xFFFFFFFF` is rejected before app write because ESP OTA treats that
value as erased. A future activation still carries rollback risk: the CLI
directly writes `VALID`, not the normal `NEW`/`PENDING_VERIFY` flow.

### OTA rollback and failure recovery matrix

| Scenario | Evidence and likely behavior | Recovery conclusion |
|---|---|---|
| Malformed image | Host checks structure, manifest digest and descriptor; the Secure Boot bootloader should reject an invalid image, but the installed bootloader is not matched | Boot rejection/fallback is unverified; ROM recovery may be required |
| Validly formatted, untrusted signature | Public WeatherXM source says production bootloader accepts production-key applications; production key and installed bootloader are unavailable | Rejection expected from source, fallback unverified; ROM recovery may be required |
| Candidate security version below device eFuse floor | Current public profile has anti-rollback disabled; actual device eFuse/profile unknown | CLI cannot preflight; if enforced, rejection/fallback behavior is unknown |
| Valid signed image crashes immediately | Public `boot_guard.cpp` counts panic/watchdog resets and selects previous OTA slot at a threshold; power-on resets the count | App-level and source-only, not bootloader rollback; deployed build and behavior unverified |
| App starts but initialization fails | Source guard relies on panic/watchdog reset reasons; no generic early-init confirmation established | Unknown; ROM-loader recovery may be needed |
| Power loss during metadata commit | CLI alternates metadata sectors, preserves/checks peer and checks readback; ESP-IDF documents two-sector selection | Generic power-loss tolerance is not validated with this bootloader and direct `VALID` record |
| New image boots but never confirms health | Public profile does not enable ESP-IDF app rollback; app guard clears its counter after 600 seconds or ThingsBoard connection | No generic rollback guarantee; serial observation is informational and health remains `not-checked` |
| No app-level rollback / rejected new app | CLI commits `VALID`; the old sector remains but shipped bootloader policy is unmatched | Do not assume automatic return to prior app; ROM-loader recovery may be needed |

These statements describe the public source snapshot, not proven gateway
behavior. The physical-write and health-gate blocker remains unresolved.

### Current disposition

Regression coverage checks exact snapshot membership, partial-read failure,
OTA metadata precommit/readback, abort before activation on protected-check
failure, the hard security gate, and OTA erased-sequence rejection. `factory`
is newly included in protected hashes. Source tests and standalone validation
results for this follow-up:

- `npm run typecheck`, `npm test`, and `npm run build` passed in the Node 22
  source container. The source suite passed 70 tests; the standalone suite was
  skipped at that stage because no binary variable was configured.
- The committed source was built for native Linux ARM64 in a Node.js 26.8.2
  ARM64 container after installing `libatomic1`. The builder's normal Git probe
  could not read mounted `.git` metadata, so a second build used its explicit
  `WG1200_GIT_COMMIT` / `WG1200_GIT_DIRTY` overrides after confirming clean
  commit `c8ce1d61708d864355be1349773024323b588d93`.
- Final artifact: `dist/weatherxm-flash-linux-arm64`, SHA-256
  `93960c611d568f2883a827626fa404bbb909bb054b84e8dfcdc66f4b07e93bde`, size
  143 MiB. Embedded metadata reports package `0.1.0`, Node `v26.8.2`, source
  SHA-256 `8e57578c017c85f534e66a01dd5e6dc35ab3c2cfbc17fe02f8bff89fc8c00e3e`,
  commit `c8ce1d61708d864355be1349773024323b588d93`, and `gitDirty: false`.
- `--version --verbose --json`, `--help`, and `firmware list` passed. ELF
  validation passed: executable 5 PT_LOAD segments and embedded SerialPort
  addon 2 PT_LOAD segments, all compatible with 16 KiB pages. `ldd` checks ran
  in the builder and found the expected runtime dependency set.
- Final full ARM64 standalone suite passed with the full 40-character embedded
  commit SHA: 9 files, 77 tests, zero skipped. This
  verifies the executable and addon in the container, not on a Raspberry Pi or
  gateway.
- Previous artifact preserved at
  `/private/tmp/weatherxm-flash-linux-arm64-pre-audit-a1e53b9`, SHA-256
  `8ba42e765a9de90e4edb20977664b7109ee3328f45079e3cf17aedab654dc2ed`.

The requested cryptographic cases (trusted/untrusted RSA signatures, revoked
key slots, and device-specific secure-version incompatibility) cannot be
meaningfully represented as successful mock checks because those validators
and a validated eFuse decoder are not implemented. Instead, the deterministic
security-gate regression asserts no write permission is granted while
evidence is unavailable. Existing simulated tests cover metadata CRC/readback
and activation ordering. No test performs physical writes.

**NOT READY FOR PHYSICAL FLASH TEST.** Remaining blockers are per-device Secure
Boot key trust and anti-rollback evidence, unconfirmed exact gateway
rollback/bootloader semantics, and absence of physical write/health-gate
validation. Resolution requires authoritative production public-key digests, a
validated read-only eFuse decoder and device-specific readable configuration
and security-version evidence (or authoritative attestation), the exact
deployed bootloader/configuration and rollback behavior, and a separately
approved staged hardware plan with recovery prerequisites. No physical writes
should be attempted before then.
