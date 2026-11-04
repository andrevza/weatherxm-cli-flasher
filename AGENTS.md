# Contributor Guide

This repository contains the WeatherXM WG1200 CLI and its standalone serial flasher. Keep changes focused, preserve the safety model, and verify the executable users will actually run.

## Project map

- `src/cli.ts` defines command parsing and dispatch.
- `src/device.ts` handles read-only inspection, firmware comparison, and the guarded OTA installation transaction.
- `src/presentation.ts` formats human-readable status, check, and dry-run output. Keep user-visible slot formatting here so it can be exercised by standalone tests.
- `src/upstream/flasher/` contains the adapted ESP32/WG1200 transport, partition, descriptor, and OTA logic.
- `tests/` contains unit, safety, and standalone executable regression tests.
- `scripts/build-standalone.mjs` builds platform-native Node single executable applications.
- `SAFETY.md` and `docs/official-flasher-analysis.md` provide additional safety and implementation context.

## Safety requirements

- Never change firmware upgrade/downgrade comparison policy, duplicate detection, `--force` restrictions, identity checks, image validation, partition validation, protected-region handling, OTA selection, transactional metadata updates, write boundaries, or post-flash monitoring without an explicit task requiring that change.
- The active firmware descriptor is the reference for upgrade and downgrade decisions. The inactive slot is informational only; a matching descriptor does not prove image integrity, authorize activation, bypass downgrade rules, or justify skipping installation.
- Keep inspection and dry-run read-only with respect to flash. Inspection may enter the ESP32 ROM loader, read metadata, and reset the gateway; state this accurately in user-facing docs.
- Never run firmware writes or erases as a test. Physical-device checks must be read-only (`info`, `verify`, `status`, `check`, or `flash --dry-run`) and should only be done when explicitly requested.
- JSON mode must emit valid JSON on stdout. Send diagnostics to stderr and use `null` for unavailable fields rather than guessed values.
- `--redact` must be applied at the output boundary for stdout and stderr, including JSON, diagnostics, monitor display, and monitor output files. Keep original identity values for validation and cryptographic operations. Extend `tests/redaction.test.ts` and the standalone executable redaction fixture for any new sensitive output fields.

## Development and verification

Use Node.js 20 or newer for the source project. The standalone SEA builder specifically requires native Node.js 26 or newer; Bun is not a substitute for `node --build-sea`.

```sh
npm test
npm run typecheck
npm run build
```

For an actual platform-native standalone build:

```sh
node --version                 # must be v26 or newer
npm run build:standalone
wg1200 --version --verbose
```

Build on the target OS and architecture because the executable embeds the native `serialport` binding. The build script stages the binary, verifies embedded source/build metadata and the slot formatter, then replaces the artifact in `dist/`. It intentionally rejects Bun to prevent a false-success build.

When changing human-readable status, check, or dry-run output, test the executable itself, not only the source renderer or `--help`:

```sh
WG1200_STANDALONE_BINARY="$PWD/dist/weatherxm-flash-macos-arm64" npm test
```

`tests/standaloneExecutable.test.ts` runs the real binary's embedded presentation fixtures and checks that both OTA slots, versions/builds, target details, comparisons, and the inactive-match message are present. It also verifies `--version`, `-v`, verbose and JSON output, and the package version in normal help. Keep that regression coverage in sync with formatter changes. The binary's verbose version output identifies package version, build timestamp, source SHA-256, Git commit/tag, and whether the build tree was dirty; `--version --json` is available for automation. Tagged GitHub release builds must use a clean checkout. `--build-info` remains an internal build-validation command.

The optional `--redact` output mode masks MAC addresses, gateway/device IDs and names, certificate common names/fingerprints/PEM blocks, public keys/hashes, serial-number fields, and common USB serial paths. It keeps chip, firmware, flash, and partition details useful for diagnosis. It cannot guarantee detection of every sensitive value; docs must tell users to review logs before sharing.

Do not treat a help output smoke test as verification that firmware presentation code is current.

## Implementation guidance

- Prefer reusing values collected by `inspectDevice`; do not add flash reads just to format output.
- Active-slot labeling must come from validated OTA metadata, not relative firmware versions.
- Missing, invalid, or ambiguous metadata must remain visibly unknown/invalid/ambiguous.
- Keep output wording consistent across `status`, `check`, and `flash --dry-run`; document additive JSON schema changes in `README.md`.
- Do not add dependencies unless the task needs them.
