# Security and trust model

The CLI separates firmware-byte integrity, image signature validity, signer trust on a device, boot selection, application startup and application health. Passing one layer does not imply the others.

## Firmware and Secure Boot checks

Catalog downloads are checked against the catalog-provided size and SHA-256. The candidate parser checks ESP32-S3 image structure and its Secure Boot V2 signature block. `security check` cryptographically validates supported RSA-PSS image signature evidence and compares the signing public-key digest against readable, eligible ESP32-S3 eFuse key-purpose slots, revocation and the observed security-version floor. `TRUSTED` is an image/device trust result, not proof that the image starts, that OTA metadata selects it, or that the installed bootloader uses the inspected configuration.

The bootloader performs the actual Secure Boot verification on startup. UART log parsing reports only explicit verification lines that were observed; it cannot establish correctness if logs are missing. Different bootloader/app ESP-IDF versions are possible. An unknown anti-rollback setting stays `unknown`; the eFuse security-version value alone does not establish whether that bootloader enforces it.

`security --port <path>` accesses ROM eFuse read registers only. It does not upload a RAM stub, read flash, write flash, erase flash or program eFuses. Entering ROM mode may reset the gateway. Digest reads are unavailable or unknown when protection, ROM restrictions, zero values, ambiguous key purposes or communication errors prevent reliable evidence. Read diagnostics intentionally exclude raw key-block words.

## Write controls

The generic `flash <firmware>` installer is fail-closed and remains hard-blocked even when `--yes`, `--force`, or `--recover` is supplied. The narrowly scoped `flash weatherxm --stage-only` write can place only the approved 0.8.34 image in inactive `ota_0` while `ota_1` is active after backup, source, signer, identity, layout and preserved-region checks plus exact interactive confirmation. It leaves OTA metadata unchanged.

`ota activate` selects between already verified applications by writing one 4 KiB `otadata` record. It requires a current device-bound metadata backup and per-image validation. `ota restore` writes one fresh record using a verified device-bound backup, current live metadata and a still-valid recovery app. Both require exact interactive operator confirmation and post-write readback. Neither application-flashes nor automatically rolls back. A record write cannot be treated as complete until exact readback and selected-slot checks pass.

The operator-reported `ota_1 → ota_0 → ota_1` physical round trip is positive operational evidence for that sequence and device. It does not prove power-loss atomicity, all invalid-state behavior, another device's eFuse/bootloader configuration, or automatic recovery.

## Backups and identity

The 8 KiB OTA metadata backup is accompanied by a SHA-256 manifest with MAC and Secure Certificate identity hashes. The backup process independently rereads the physical metadata and compares hashes. Activation also requires the backup bytes to match current metadata exactly; this prevents a stale backup from authorizing a changed state. The manifest is a local integrity/identity record, not a vendor signature or tamper-proof attestation. Keep it together with its data file and protect both.

Full application and partition backups are not general restore authorization. They may be useful for byte preservation and offline comparison, but the CLI does not expose a generic raw restore operation. Whole partition dumps can contain credentials and keys.

## Redaction

`--redact` masks known device/station identifiers, certificate/key material, tokens, credentials, location-like fields, serial identifiers and selected radio payloads at output boundaries, including JSON and saved logs. It does not modify values used internally for identity checks or signature verification. Pattern-based redaction cannot recognize every future log schema; review before sharing.
