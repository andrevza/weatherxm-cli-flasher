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

### Blocking: no host-side cryptographic Secure Boot verification

**Severity: Critical / blocks physical flashing.** Image validation establishes
declared byte count, a 4 MiB ceiling, the `0xE7` signature-block marker at the
expected location, and SHA-256 equality with the manifest. It does not parse and
verify the Secure Boot V2 RSA-PSS signature, establish that its key digest is
trusted by this gateway, or check the device eFuse security version. A valid
format and checksum do not establish bootability or device trust. Resolve this
before any write by establishing an authoritative firmware signing-key/trust
source and implementing or independently validating signature and anti-rollback
compatibility checks.

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
