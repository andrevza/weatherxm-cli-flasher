# Changelog

## v0.1.0-rc.1 — 2026-11-07

First release-candidate preparation for the independent WeatherXM WG1200 CLI.

- Includes exact-layout inspection, firmware catalog verification, Secure Boot V2 evidence checks, bounded stage-only preparation, OTA metadata backup/activation/restore, and serial boot monitoring.
- Records maintainer-supplied physical evidence for the `ota_1 → ota_0 → ota_1` slot-selection round trip; it is not a claim of automatic rollback or universal recovery.
- Aligns release documentation with the blocked generic installer, enabled scoped stage-only operation, explicit OTA metadata writes, and the documented backup/recovery boundaries.
- Includes a cancellation guard so SIGINT arriving during the final OTA metadata reread is checked before activation or emergency restore enters the writer.
- Release-candidate monitor formatting and help audit fixes from the validated baseline are included.

See [`docs/release-v0.1.0-rc.1.md`](docs/release-v0.1.0-rc.1.md) for build provenance, validation and known limits.
