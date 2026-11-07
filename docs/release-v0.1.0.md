# WeatherXM WG1200 CLI v0.1.0

This is the first stable version of an independent WeatherXM WG1200 command-line
utility. It is not an official WeatherXM release or endorsement. The local
release-finalization task builds and verifies artifacts but does not push a Git
commit/tag or publish a GitHub release.

## Included capabilities

- WG1200 identity, fixed partition-layout, OTA metadata and firmware inspection.
- Secure Boot V2 image and device trust evidence with unknown states preserved.
- Fast and Thorough image verification, firmware download/cache and backup
  comparison.
- The narrowly scoped WeatherXM `0.8.34` stage-only application write to
  inactive `ota_0` while `ota_1` is active, requiring verified backup,
  preflight, and exact confirmation. The ordinary generic `flash <firmware>`
  installation path remains blocked.
- Explicit OTA activate and emergency restore transactions that write at most
  one 4 KiB OTA metadata sector, preserving and verifying the peer sector.
- Serial boot monitoring with timestamps, severity formatting, redaction and
  structured evidence.
- Linux ARM64 standalone packaging with embedded Node.js and SerialPort native
  binding.

## Hardware evidence and limits

The maintainer reports read-only physical acceptance of the exact
`v0.1.0-rc.1` Linux ARM64 executable on a Raspberry Pi 5 and WG1200. The
reported RC checksum matched its manifest. Checks included executable startup
and provenance, structured help, read-only OTA metadata/CRC inspection,
Secure Boot V2 verification, normal application boot from `ota_1`, firmware
version, LittleFS, NVS, Wi-Fi/internet, HTTP startup, MQTT, WS1001 station
reception, timestamped/redacted logs and clean monitor cancellation. The RC
did not write OTA metadata.

Separately, the maintainer reports an `ota_1 → ota_0 → ota_1` selection cycle
using earlier development builds. Do not attribute that switching cycle to
the RC or stable executable. The final stable executable has not itself been
run on physical hardware. Emergency `ota restore` has automated regression
coverage but no physical recovery test. These reports are attributed and
scoped in [`hardware-validation.md`](hardware-validation.md).

The reports do not prove automatic rollback, power-loss recovery, all deployed
bootloader configurations, universal hardware compatibility, or long-term
application health. Fast mode uses device-side MD5 only as an equality check;
use Thorough mode for complete physical image SHA-256 and signature checks.
Application/partition backups are not generic restore images. Redaction is
best-effort and logs should be reviewed before sharing.

## Build and verification provenance

Package and Git tag are both `v0.1.0` / `0.1.0`. The local annotated tag is
created on the final source commit **before** the clean standalone build so
the executable embeds the exact commit and tag. Confirm `gitDirty: false` in
the verbose version JSON. The embedded source hash covers the TypeScript
sources under `src/`; the artifact checksum is recorded in
`dist/SHA256SUMS-v0.1.0` and included in the release archive.

The final source and executable-backed test counts, ELF/page compatibility,
native binding smoke test, build timestamp, embedded commit and checksum are
available from the validated executable, its checksum manifest and the
delivery record for this local build. Generated artifacts are not tracked in
Git. No physical operation or public release is part of this local workflow.

For the Linux ARM64 target, the local bundle is
`dist/weatherxm-flash-linux-arm64-v0.1.0.tar.gz`; the executable is
`dist/weatherxm-flash-linux-arm64-v0.1.0`, and the external checksum manifest
is `dist/SHA256SUMS-v0.1.0`. The archive uses a fixed allowlist and contains
the binary, its binary checksum manifest, `LICENSE`, `UPSTREAM_NOTICES.md`,
the installation guide as `INSTALL.md`, and these notes as `RELEASE_NOTES.md`.
The manifest beside the archive checks both the executable and the archive;
the manifest inside the archive checks the contained executable.

The validation run consists of a source suite and a separate full
standalone-backed suite. Source-only mode is expected to skip
executable-dependent tests; those tests must all run with
`WG1200_STANDALONE_BINARY` set to the release executable. The local build uses
Node.js `v26.8.2` in a Linux ARM64 Docker environment.

## Recovery and safety references

Read [`SAFETY.md`](../SAFETY.md), the [security and trust model](security-trust-model.md),
[backup and recovery guide](backup-recovery.md),
[known limitations](known-limitations.md), and
[troubleshooting guide](troubleshooting.md) before operating a gateway.
