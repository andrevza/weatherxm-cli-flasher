# Troubleshooting

All commands below are examples; use the correct serial path for your host. Device inspection can reset the gateway while entering ROM mode. Start with `--json --redact` for shareable diagnostics and review output before sending it anywhere.

## Serial port cannot open or ROM sync fails

- Check that the expected USB adapter appears (`/dev/ttyUSB0`, `/dev/serial/by-id/...`, or `/dev/cu.*`).
- On Linux, verify the account has permission to open the serial device, commonly through `dialout`; reconnect after changing group membership.
- Close terminal programs that may hold the port and confirm the selected baud rate (default 115200).
- Avoid changing USB permissions or power-cycling repeatedly without an approved procedure. ROM entry resets the gateway.

## Device identity/layout verification fails

```sh
wg1200 info --port /dev/ttyUSB0 --json --redact
wg1200 verify --port /dev/ttyUSB0 --json --redact
```

Stop if the chip, flash capacity, credential evidence, partition table, metadata, or expected WG1200 layout is missing or different. Do not use a generic ESP32 layout as a substitute.

## OTA state is ambiguous or CRC-invalid

```sh
wg1200 ota status --port /dev/ttyUSB0 --verify-mode thorough --json --redact
```

Do not guess the active application from firmware version strings. Use a normal boot log to observe the bootloader's loaded offset if it is safe to reset. Do not clear OTA metadata or run generic flash commands. Consider `ota restore` only if its backup and recovery-image requirements are satisfied and the exact high-risk plan is reviewed.

## Backup is rejected as stale or belongs to another device

Keep the binary and its `.manifest.json` together. Verify the selected manifest path, identity binding and SHA-256, and use a freshly created metadata backup for the current live OTA state before activation. Backups do not overwrite existing paths; use a new filename rather than replacing evidence.

## Activation or restore cancelled before write

An incorrect phrase, cancellation, or Ctrl+C before transaction entry does not start the metadata writer. Re-run read-only `ota status` and create a new metadata backup if state may have changed. Do not assume a displayed confirmation prompt itself means a write occurred.

## Metadata updated but boot is unverified

The tool reports metadata update separately from boot selection, Secure Boot evidence, application startup and optional health. If the loaded offset or startup is missing, do not describe the activation as successful. Use `monitor --port /dev/ttyUSB0 --redact --timestamp` to passively observe future output; `monitor --boot` deliberately resets to normal boot. If metadata remains valid, the operator can choose a still-valid slot using a new backup and another explicit activation. There is no automatic rollback.

## Secure Boot trust is unknown or negative

```sh
wg1200 security --port /dev/ttyUSB0 --json --redact
wg1200 security check weatherxm --port /dev/ttyUSB0 --json --redact
```

`UNKNOWN` is not a match. An explicit revoked, incompatible or untrusted result blocks activation. Do not disable Secure Boot, program eFuses, or substitute a signature-block marker for signature verification.

## Fast and Thorough results differ

Fast mode avoids full partition reads and uses header/source plus device-side MD5 evidence where applicable. Thorough mode reads complete application partitions and computes physical SHA-256 plus structural/signature checks. Use Thorough to investigate an image mismatch; do not describe MD5-only evidence as cryptographic authentication.
