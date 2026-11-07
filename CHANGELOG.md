# Changelog

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
