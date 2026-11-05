# Raspberry Pi 5 read-only hardware validation

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
