# WeatherXM WG1200 CLI v0.1.0-rc.1

**Release candidate.** This is an independent project and is not an official WeatherXM release. The candidate is intended for cautious evaluation by gateway operators; ordinary firmware installation remains hard-blocked.

## What is included

- Read-only WG1200 identity, layout, OTA status and firmware comparison commands.
- Secure Boot V2 image/device evidence checks with unavailable and unknown states kept explicit.
- Verified firmware cache and full-image backup/compare workflows.
- Scoped `flash weatherxm --stage-only` preparation, with a required backup and interactive confirmation; no OTA metadata update.
- OTA metadata backup, explicit one-sector activation, and separately gated emergency metadata restore.
- Continuous monitor and live OTA boot capture with host timestamps, severity/color formatting, redaction and structured JSON evidence.
- Node.js SEA standalone builds that embed the native SerialPort binding.

## Hardware evidence

The maintainer reports one physical `ota_1 → ota_0 → ota_1` activation cycle on a Raspberry Pi 5 and WG1200. The report says the already staged applications were selected through the OTA metadata path and their actual loaded slots were observed at boot. The full raw transcript and identifiers are not included. This is maintainer-supplied evidence; Codex did not access the gateway. See [`hardware-validation.md`](hardware-validation.md) for attribution, artifact-linkage caveat, and scope.

That round trip does not demonstrate automatic rollback, interrupted-write recovery, recovery from a corrupt second-stage bootloader, long-term service health, or compatibility with every gateway. The release-candidate build produced for this review has not itself been physically run.

## Verification record

The release checks run for this source revision reported 272 passing source tests and 57 skipped tests (including seven executable-backed tests, which are enabled for the final artifact run). Typecheck and source build completed. The ARM64 standalone-backed suite and provenance checks are required before treating the candidate as ready.

| Item | Result |
|---|---|
| Package version | `0.1.0-rc.1` |
| Git commit | Embedded in the candidate's `--version --verbose --json` output |
| Local annotated tag | `v0.1.0-rc.1` only after all gates pass |
| Linux ARM64 executable | `dist/weatherxm-flash-linux-arm64-v0.1.0-rc.1` |
| Executable SHA-256 | In the companion `dist/SHA256SUMS-v0.1.0-rc.1` file |
| Embedded source SHA-256 | In the candidate's `--version --verbose --json` output |
| Source tests | 272 passed, 57 skipped; 21 files passed, one file skipped |
| Standalone-backed tests | Recorded in final delivery after execution against this candidate |
| ARM64/16 KB/native binding | Recorded in final delivery after artifact validation |
| Public release or push | None |

`SHA256SUMS` is generated from the verified candidate executable. Do not treat this local RC as published or install it over a known-good binary without reviewing its checksum and provenance.

## Known limitations

The ordinary generic firmware installer is blocked. Anti-rollback and installed bootloader rollback configuration remain unknown unless independently proven for the device. Fast mode does not perform full physical image SHA-256 readback; use Thorough mode where full reads are required. App/partition backups are not generic restore images. Redaction is best-effort. See [`known-limitations.md`](known-limitations.md), [`security-trust-model.md`](security-trust-model.md), and [`backup-recovery.md`](backup-recovery.md).
