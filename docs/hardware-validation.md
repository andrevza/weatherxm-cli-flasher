# Raspberry Pi 5 read-only hardware validation

## Maintainer-supplied physical boot capture (5 November 2026)

The maintainer supplied a complete `monitor --boot --redact` transcript captured
on a Raspberry Pi 5 running Linux ARM64. The executable was
`~/weatherxm-flash-boot-monitor`, SHA-256
`115fb7f481f023374a9a95a1c8eedc06143397130cda016717f5e53b0de50c37`, with
embedded source SHA-256
`3e4f23a22cd07689569c2bf96bae2faf50c9384ce83c7707772f408866fd4a43`, Git
commit `d9b2ff0b221a7b2680e37f9b1ca0aeebe524efea`, a clean source tree, and
Node.js `v26.8.2`. Codex did not access the Pi or gateway. The full transcript
is deliberately not stored here because it contains device identifiers,
locations, and radio packet bytes.

The capture showed `ESP-ROM:esp32s3-20210327`, a power-on reset line, the
ESP-IDF 5.1.2 second-stage bootloader, 16 MiB flash, and the WG1200 partition
layout. The ROM printed `Valid secure boot key blocks: 0` followed by
`secure boot verification succeeded`. The second-stage bootloader then
reported successful RSA-PSS signature verification, loaded the application
from `0x820000` (`ota_1` in the observed partition table), and the application
started as version `0.8.34-g86b609b` under ESP-IDF 6.0.1. The app connected to
MQTT and processed station traffic. These are observations from one supplied
startup, not a test of fallback, rollback, or recovery behavior.

The ROM line's trailing `0` is consistent with a listed valid key-block index,
not a count of valid keys: Espressif's own examples show the same format with
`Valid secure boot key blocks: 0` and successful verification, and an issue
shows multiple indices (`0 1 2`). The ROM source's exact formatting contract
was not located, so this interpretation is supported by the examples and
surrounding successful signature checks rather than a source-level proof.
Secure Boot V2 verifies the image signature against key digests held in eFuse;
the log is not evidence that Secure Boot was disabled. See Espressif's
[ESP-IDF Secure Boot V2 guide](https://docs.espressif.com/projects/esp-idf/en/v5.1.2/esp32s3/security/secure-boot-v2.html),
[ROM log example](https://developer.espressif.com/blog/flash-encryption-and-secure-boot/),
and [multiple-block log example](https://github.com/espressif/esp-idf/issues/12851).

The application read the `bootguard` NVS namespace keys `swd_flag` and
`crash_cnt`; the transcript did not expose their values or report a rollback.
At pinned WeatherXM source revision
`a30374b045c138dac3f6dd4267ef8eb7390a7670`, the app-side guard classifies
selected watchdog/panic resets and its software-watchdog flag as crash boots,
clears the counter on power-on reset, and tries the other OTA app after three
crash boots if its descriptor is valid. Its health reset is tied to 600 seconds
of uptime or successful ThingsBoard connectivity. This is source behavior,
not proof that this exact source and configuration are installed. The
`POWERON` log describes this observed startup only. A settings-commit log line
follows station traffic in this capture. In the reviewed application source,
the WS1300 ADV/BOOT handler can save a changed paired-station serial/public-key
profile through `Settings::commit()`. That makes an application NVS settings
commit a plausible explanation for the log; the transcript does not identify
the fields or prove that this exact branch ran. It is not evidence of an OTA
metadata write.

The installed bootloader is not identified by an exact artifact. Its second
stage reports ESP-IDF 5.1.2 while the app reports ESP-IDF 6.0.1; this is
consistent with separately built components but does not identify either
binary. The app's `unknown pin` inventory label comes from a hash comparison
in the public source; it means no known pin mapping matched the full pre-table
region digest, not that a physical pin is unknown. Exact image extent,
full digest, build configuration, and rollback support remain unconfirmed.
No raw flash or provisioning data was read by this review.

The transcript also demonstrated that the earlier binary's `--redact` missed
station telemetry IDs, a serial field, an mDNS identity and partial MAC, a
public API address, and raw radio packet bytes. The source changes in this
follow-up address those known forms and suppress packet byte rows in redacted
monitor mode; the updated implementation still needs its automated validation
below and has not been physically retested. This is best-effort filtering.

## Continuous startup capture follow-up

Source now provides `monitor --boot`: the receive listener is attached before
port open, one SerialPort instance remains open, DTR stays deasserted and RTS
is asserted for 120 ms to pulse EN into normal app boot (50 ms setup, 150 ms
after release). This matches the existing transport signal convention.
Espressif documents the CH340/ESP32-S3 mapping RTS-to-EN and DTR-to-GPIO0;
the WG1200 PCB traces have not been physically checked. A maintainer-supplied
capture using the earlier candidate demonstrated a ROM-to-app startup with
the gateway attached; it does not validate the latest redaction changes. USB
power stays connected and no monitor-initiated flash, OTA or eFuse operation
is performed.

The `gw_bootloader_sha256` telemetry attribute is the app's hash of the full
`0xC000`-byte pre-partition-table region, not an image-only bootloader digest.
No authorized ThingsBoard connector/session is available here to retrieve it.
An already-authorized operator can export that device attribute and compare
the full value with the known-image table; the current `64e8c47e` prefix does
not match the listed known reset-pin variants.

## Maintainer-reported validation of the protected-region candidate (5 November 2026)

The maintainer reports that `dist/weatherxm-flash-linux-arm64-protected-region`
with SHA-256
`256f8345aa9bc6445c69aa5ce108318e660a477ba8a79bbba6e280ef7d858a16`, embedded
Git commit `675233492afe6d86b76d219a37a9b36cf2a3a6cf`, ran on a Raspberry Pi 5
running Debian Linux ARM64 with a 16 KB page kernel. Codex did not connect to
or independently access the gateway.

The maintainer reports successful `--version --verbose`, `security check
weatherxm --json --redact`, `info --json --redact`, `verify --json --redact`,
`status --json --redact`, `flash weatherxm --dry-run --json --redact`, and
passive `monitor --baud 115200 --timestamp --level info --redact` commands.
Security output was `TRUSTED`, with valid candidate signature and digest and a
matching device key. The device reported active WeatherXM
`0.8.34-g86b609b` in `ota_1`, sequence 4; inactive `ota_0` contained
`v0.6.1-dirty`. Metadata was valid and unambiguous. The proposed target was
`ota_0` at `0x420000`, comparison `identical`, and dry-run `flashModified`
was `false`.

Passive monitor output included:

```text
W (28449) Utils: Bootloader inventory: unknown pin (May 27 2024, sha=64e8c47e)
```

The application source review explains this as an app-generated inventory
based on a SHA-256 of the whole `0x000000..0x00BFFF` pre-table flash area; the
log says no known pin mapping matched. The reviewed source table's known
full-region digests also have different prefixes from `64e8c47e`. This is
useful physical evidence, but is not a bootloader-only digest or exact build
match. See the updated recovery readiness notes.

No firmware writes, flash erases, OTA metadata changes, or eFuse modifications
were performed. The preserved-slot before/after hashing has not been exercised
during a physical firmware write. The latest standalone automated test suite
remains unverified; these maintainer-reported command runs do not replace that
suite. They do not establish firmware-installation readiness.

The physical run used the pre-follow-up executable from commit `6752334`.
This follow-up changes source redaction behavior and its fixtures, so that
binary does not contain the new redaction rules. It remains preserved at the
path and checksum above. A new Linux ARM64 candidate was not built here because
this host has no Node/npm CLI and the authorized Docker daemon was unavailable.
Rebuild and rerun standalone tests on the Raspberry Pi or another authorized
native Linux ARM64 host before treating the updated source as covered.

The maintainer also observed application settings, station identifiers,
credential fields, and location-related data in serial logs. No unredacted
capture was added to this repository. `--redact` now masks structured and
labeled station identifiers, credentials/tokens, and location coordinates;
this remains best-effort for arbitrary application-generated text. Review all
logs before sharing them.

## Candidate artifact static review (5 November 2026)

The repository candidate `dist/weatherxm-flash-linux-arm64-protected-region`
was reviewed from macOS ARM64; it was not executed. Its SHA-256 is
`256f8345aa9bc6445c69aa5ce108318e660a477ba8a79bbba6e280ef7d858a16`.
The embedded build metadata extracted from the ELF identifies package `0.1.0`,
build time `2026-11-05T10:30:51.347Z`, source SHA-256
`787606c7b69207f5fca1a4fe737027193abc0691e635a48b9c5df422c6807db8`, Git
commit `675233492afe6d86b76d219a37a9b36cf2a3a6cf`, clean tree, and Node.js
`v26.8.2`. Recomputing the builder's source hash from the current TypeScript
files produced the same digest. Source inspection confirms this commit contains
the pre-write OTA-sector revalidation, full preserved-OTA and fixed-region
SHA-256 checks, and the unconditional installation security gate.

An independent ELF64 parser confirmed `EM_AARCH64` (183), a dynamic Linux
interpreter, five loadable segments, `p_align=0x10000` for each, and 16 KiB
offset/address congruence. This establishes the ELF layout check for the main
executable. The matching staged `linux-arm64/@serialport+bindings-cpp.armv8.glibc.node`
addon was also present and statically checked: AArch64, two loadable segments,
64 KiB alignment, and 16 KiB congruence. It declares `libstdc++.so.6`,
`libm.so.6`, `libgcc_s.so.1`, and `libc.so.6`; the executable declares those
plus `libatomic.so.1`, `libdl.so.2`, `libpthread.so.0`, and
`ld-linux-aarch64.so.1`. This does not prove the candidate can load the
embedded addon at runtime. The host had no Node/npm executable; Docker was installed but
the daemon socket denied access. Consequently typecheck, source tests, source
build, standalone tests, and native-binding smoke tests were not run in this
validation pass. The candidate is not a newly generated artifact from this
pass, and no physical device was accessed.

On the Raspberry Pi 5, run the following before any hardware command:

```sh
cd /path/to/weatherxm-cli-flasher
BIN="$PWD/dist/weatherxm-flash-linux-arm64-protected-region"
sha256sum "$BIN"
"$BIN" --version --verbose
"$BIN" --version --json
WG1200_STANDALONE_BINARY="$BIN" npm test
```

The last command exercises the standalone binary fixtures and redaction
regressions. Then perform only read-only device checks, reviewing output before
sharing it:

```sh
"$BIN" security check weatherxm --port /dev/ttyUSB0 --json --redact
"$BIN" info --port /dev/ttyUSB0 --json --redact
"$BIN" verify --port /dev/ttyUSB0 --json --redact
"$BIN" status --port /dev/ttyUSB0 --json --redact
"$BIN" flash weatherxm --port /dev/ttyUSB0 --dry-run --json --redact
```

These inspection commands can reset the gateway while entering ROM mode;
`security` reads eFuse registers without a RAM stub or flash access. The dry
run does not write flash. Do not treat artifact execution or these checks as
firmware-installation validation.

## Latest maintainer-reported trust and dry-run validation (5 November 2026)

The maintainer reports that the Linux ARM64 executable built from commit
`dc73da4a07eeb6cab5ed8ff8ae4f5ccc01c18622` (Node.js `v26.8.2`, artifact
SHA-256
`0946f8f9f5b414be15353e9f027fde0dcf3d7bc202c1488e23ef6b72b9a43a82`)
completed the following on a Raspberry Pi 5 running Debian ARM64 with 16 KB
kernel pages:

```sh
./weatherxm-flash-linux-arm64 security check weatherxm \
  --port /dev/ttyUSB0 --json --redact
./weatherxm-flash-linux-arm64 flash weatherxm \
  --port /dev/ttyUSB0 --dry-run --json --redact
```

The security command reported `TRUSTED`: RSA-PSS signature and image digest
valid, signing-key digest matched an eligible non-revoked device key, and the
candidate met the observed eFuse security-version floor. Installation
readiness remained `BLOCKED`. The dry run reported active `ota_1`, inactive
`ota_0`, active OTA sequence 4, proposed sequence 5, target offset `0x420000`,
installed/selected WeatherXM `0.8.34-g86b609b`, comparison `identical`, and
`flashModified: false`. This evidence was supplied by the maintainer; Codex did
not independently access the gateway. It verifies only the named executable
and read-only flow. It does not validate the protected-region hashing added
after this commit or any physical recovery procedure.

## Maintainer-reported Secure Boot validation (4 November 2026)

The maintainer reports that Linux ARM64 executable version `0.1.0`, built
with Node.js `v26.8.2` from commit
`1881be937c94be9f48e566a1fc6d37ff9dc73776`, had SHA-256
`a57682e15418389c02f7e9ff509a9311035af903796c8269e44272361c6a9310` and
successfully ran both read-only commands below on a Raspberry Pi 5 / WG1200:

```sh
./weatherxm-flash-linux-arm64 security --port /dev/ttyUSB0 --json --redact
./weatherxm-flash-linux-arm64 security check weatherxm --port /dev/ttyUSB0 --json --redact
```

The reported ESP32-S3 v0.2 evidence was Secure Boot V2 enabled and verified;
logical digest slot 0 mapped to physical block 4 and was readable, active,
correctly purposed and matched the candidate signer; slots 1 and 2 were
revoked; security-version floor and candidate version were both 0. Candidate
manifest/image digest, ESP image structure, RSA-3072/PSS-SHA256 signature and
signature-block checks passed. The reported comparison was `meets-floor`.
Anti-rollback enforcement and installed-bootloader behavior remain unknown.
No raw identifiers, digests or certificates are recorded here. This is
maintainer-supplied evidence; Codex did not independently access the gateway.

This executable predates the trust-classification change in the current
checkout. Its output was `UNKNOWN` because anti-rollback configuration was
unknown. The updated classifier should report image/device trust as `TRUSTED`
while keeping installation readiness blocked; this updated source has not yet
been physically validated.

## Latest build validation

The maintainer supplied the following results for the Linux ARM64 standalone
executable built from commit
`b3328336f494558fbc37a8c5537646441c1e20ab` on 4 November 2026. Codex did not
generate these results in its own hardware environment.

| Item | Result |
| --- | --- |
| Host | Raspberry Pi 5, AArch64 |
| OS/kernel | Debian ARM64; 16 KB kernel page size |
| CLI | `weatherxm-flash-linux-arm64`, package version `0.1.0` |
| Build | Node.js `v26.8.2`; timestamp `2026-11-04T22:05:59.740Z`; source SHA-256 `c2796f8c67887fcdc711280357af9cfd4c215caec0cab05210f4d95324dd4d29`; clean tree |
| Device | WeatherXM WG1200 using `/dev/ttyUSB0` |
| Chip/flash | ESP32-S3; 16 MiB flash detected |
| Operations | One `verify`, one `status`, and one `info --json`; all succeeded |

The maintainer reports successful ESP32-S3 ROM connection, Secure Boot V2 stub
workaround, RAM stub upload and execution, partition-table read, secure
certificate and OTA metadata inspection, and reads of both application
descriptors. Device identity and the exact WG1200 partition layout validated;
`verify` returned `VERIFIED`; OTA state remained `VALID`, active slot `ota_1`
at sequence 4, inactive slot `ota_0`, and next proposed sequence 5. The report
states that MAC addresses, device identifiers, and certificate identity fields
were redacted and that JSON output remained valid and correctly structured.
No firmware writes or erases occurred.

This was one successful run of each of the three commands against the build
from `b3328336…`. It is distinct from the previous nine-operation validation
below, which used commit `233fe617f57f3c75e0a2d31214ff731a62b509ca`. The newer
commit did not undergo nine repeated rounds.

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
