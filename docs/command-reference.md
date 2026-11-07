# Command reference

Use `wg1200 --help` or `wg1200 <command> --help` for the installed executable's formatted help. The parser and structured help are covered by the CLI help-audit tests. Device commands default to 115200 baud; `--port` is required for serial operations.

## Device inspection

| Command | Purpose and effects |
|---|---|
| `info --port <path>` | Read device identity, hardware, fixed partition layout, OTA metadata and app descriptors. Enters ROM/stub mode and resets on cleanup. |
| `verify --port <path>` | Validate WG1200 identity, flash size, credentials, exact partition layout and OTA metadata. Same ROM/stub/reset behavior. |
| `status --port <path>` | Report OTA metadata selection and both slot descriptors. Same ROM/stub/reset behavior. |
| `check <weatherxm\|meshtastic> --port <path>` | Fetch/verify the selected catalog image, inspect the gateway, and report comparison policy against the active firmware. Resets during inspection; completed comparison outcomes are informational. |
| `monitor --port <path> [--boot]` | Receive serial output. Passive mode does not request reset; `--boot` installs a receiver and deliberately resets to normal application boot. |

Common output options include `--json`, `--redact`, `--verbose`, and `--trace-serial`. JSON results go to stdout; progress and diagnostics go to stderr. `--redact` is best-effort.

## OTA management

| Command | Purpose and write behavior |
|---|---|
| `ota status --port <path> [--verify-mode fast\|thorough]` | Inspect metadata and both applications. Fast uses descriptors/headers and reports full-image checks unavailable; Thorough reads complete images and performs SHA-256/signature checks. Read-only with ROM reset/cleanup. |
| `ota backup --port <path> --output <file>` | Save exactly 8 KiB of `otadata`, independently compare a second device read, and create `<file>.manifest.json` bound to device identity. Read-only with ROM reset/cleanup. Does not overwrite. |
| `ota activate --target <ota_0\|ota_1> --port <path> --metadata-backup-manifest <file> [--dry-run]` | Dry-run writes nothing. Real operation requires a current device-bound metadata backup, valid target/recovery images, and exact interactive confirmation; writes one 4 KiB metadata sector and verifies it before resetting to normal boot. |
| `ota restore --port <path> --metadata-backup-manifest <file>` | High-risk emergency metadata repair. Requires a verified device-bound backup, valid trusted recovery app, and exact interactive confirmation; writes one 4 KiB record while preserving its peer. It does not replay the raw 8 KiB backup. |

Activation and restore capture boot UART output for 15 seconds by default. `--boot-capture-seconds <15..3600>` changes the duration; `--boot-log-output <file>` saves formatted, timestamped plain-text logs. `--timestamp` is accepted for consistency; timestamps are already enabled for boot captures. `--no-color` disables terminal colors. Neither command automatically rolls back.

## Backups

| Command | Purpose and cautions |
|---|---|
| `backup active --port <path> --output <file>` | Read and independently hash the complete metadata-selected 4 MiB active app partition. |
| `backup inactive --port <path> --output <file>` | Read and independently hash the complete metadata-selected inactive app partition. |
| `backup partition <name> --port <path> --output <file>` | Read one discovered allowlisted partition after interactive confirmation. Dumps may contain credentials or keys; protect them. |

Backup output paths are no-clobber. Application and partition backups do not constitute a supported restore mechanism.

## Firmware and security

- `firmware list [--manifest <url>] [--json]` lists validated catalog entries.
- `firmware download <weatherxm|meshtastic> [--version <version>] [--offline] [--cache-dir <path>]` retrieves and verifies a catalog image into the local content-addressed cache.
- `firmware compare --backup <file> (--firmware <key> | --firmware-file <path>) [--expected-sha256 <hex>]` compares supported signed-image extents offline/locally.
- `security --port <path>` reads Secure Boot V2 eFuse evidence from ROM registers only. It does not upload a RAM stub or access flash.
- `security check <weatherxm|meshtastic> --port <path>` verifies a candidate and compares signer evidence to device trust evidence. It does not authorize writes.

## Flash commands and current gate

- `flash diagnose --target <ota_0|ota_1> --port <path>` is read-only image diagnosis.
- `flash weatherxm --stage-only --port <path> --backup-manifest <file>` is the only application-byte write path enabled by this CLI. It is narrowly pinned to the official 0.8.34 image written to `ota_0` while `ota_1` is active. It requires backup selection and exact interactive confirmation.
- The ordinary `flash <firmware>` installation path is hard-blocked. `--yes`, `--force`, and `--recover` cannot bypass the gate.

See [backup and recovery](backup-recovery.md), [security and trust](security-trust-model.md), and [known limitations](known-limitations.md) before operating a gateway.
