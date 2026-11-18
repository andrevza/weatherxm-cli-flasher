# Changelog

## v0.1.1 — 2026-11-18

Adds a separately named Linux ARM64 executable for Alpine Linux and other
musl-based environments. The existing glibc executable and v0.1.0 release
remain unchanged.

- Builds Node.js 26.8.2 from checksum-verified source on Alpine ARM64 and embeds
  the SerialPort native addon with its C++ runtime statically linked.
- Tests the standalone executable in a clean Alpine 3.24.3 runtime with no
  additional packages, and exercises serial open/read/write/close using a PTY.
- Includes a narrowly scoped musl SerialPort enumeration fallback for systems
  without `udevadm`.
- Fixes monitor redaction across chunked public-key output interleaved with
  diagnostics.
- No physical gateway or Raspberry Pi validation is claimed. The container
  checks ran in an ARM64 Docker Desktop VM on Apple Silicon.

See [`docs/alpine-home-assistant-install.md`](docs/alpine-home-assistant-install.md)
for Alpine/Home Assistant installation instructions and [`docs/release-v0.1.1.md`](docs/release-v0.1.1.md)
for build evidence and limitations.

## v0.1.0 — 2026-11-07

First stable version of this independent WeatherXM WG1200 CLI. This is not an
official WeatherXM release or endorsement.

- Carries forward the validated v0.1.0-rc.1 CLI, OTA switching, serial
  monitoring, recovery safeguards, structured output, and verification modes.
- Records maintainer-supplied physical acceptance checks of the RC on a WG1200
  and Raspberry Pi ARM64 host. The RC did not perform an OTA metadata write.
- Separately records the earlier development-build `ota_1 → ota_0 → ota_1`
  physical switching cycle. Neither operation should be attributed to the
  stable executable without a matching stable-binary test record.
- Emergency `ota restore` remains covered by automated regression tests but has
  not been physically exercised.
- Keeps generic firmware installation hard-blocked and preserves the narrow
  stage-only app write and explicit one-sector OTA metadata transactions.

See [`docs/release-v0.1.0.md`](docs/release-v0.1.0.md) for the final evidence,
build provenance, validation, and known limits.

## v0.1.0-rc.1 — 2026-11-07

First release-candidate preparation for the independent WeatherXM WG1200 CLI.

- Includes exact-layout inspection, firmware catalog verification, Secure Boot V2 evidence checks, bounded stage-only preparation, OTA metadata backup/activation/restore, and serial boot monitoring.
- Records maintainer-supplied physical evidence for the `ota_1 → ota_0 → ota_1` slot-selection round trip; it is not a claim of automatic rollback or universal recovery.
- Aligns release documentation with the blocked generic installer, enabled scoped stage-only operation, explicit OTA metadata writes, and the documented backup/recovery boundaries.
- Includes a cancellation guard so SIGINT arriving during the final OTA metadata reread is checked before activation or emergency restore enters the writer.
- Release-candidate monitor formatting and help audit fixes from the validated baseline are included.

See [`docs/release-v0.1.0-rc.1.md`](docs/release-v0.1.0-rc.1.md) for the historical candidate record.
