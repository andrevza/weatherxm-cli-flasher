# Safety and validation

## Command effects

`firmware list`, `firmware download`, and `firmware compare` are host-side operations and do not connect to a gateway. Device inspection commands (`info`, `verify`, `status`, `check`, `ota status`, `ota backup`, `backup active`, `backup inactive`, `backup partition`, and `flash diagnose`) enter the ESP32-S3 ROM loader/stub as applicable, read device state, and reset the gateway during cleanup. They do not write flash. The `security` command stays in ROM, reads only eFuse read registers without uploading a RAM stub or accessing flash, and may reset the gateway while entering ROM mode.

`monitor` is a passive receive-only session. It does not create an esptool loader, send serial bytes, or pulse reset lines. `monitor --boot` deliberately performs one normal-boot RTS/EN reset after installing its UART reader. Device-operation `--monitor` handoffs are passive, but any reset already performed by the preceding operation still applies. USB/OS drivers may alter modem-line state when opening a serial port; see the monitor notes in README.

The ordinary `flash <firmware>` installation path is hard-blocked by the firmware safety gate, regardless of `--yes`, `--force`, or `--recover`. `flash --dry-run` is read-only and reports the proposed plan and write-block reason. `flash diagnose` is a read-only image comparison. The separate `flash weatherxm --stage-only` path is enabled only for the pinned official WeatherXM 0.8.34 image, writing its image-length bytes into `ota_0` while validated metadata selects `ota_1`. It requires a verified inactive-slot backup and exact interactive confirmation. It verifies the image source, target, protected-region baselines, and post-write reads, and never changes OTA metadata or activates the image. Power loss can leave `ota_0` partial; no restore guarantee is implied.

`ota activate --target <ota_0|ota_1>` changes boot selection without reflashing either application. It validates current metadata, the target and recovery applications, their signed-image evidence, and a current device-bound OTA metadata backup; after exact transaction-specific confirmation it writes one 4 KiB OTA metadata sector, independently verifies its contents and peer preservation, then resets and captures boot. `ota restore` is an emergency metadata repair using a valid device-bound backup and a currently valid/trusted recovery app. It writes one new 4 KiB valid metadata record into the non-selected sector and preserves the peer. It does not replay the raw 8 KiB backup. Both commands require an interactive terminal and exact confirmation; cancellation before the write makes no flash modification. Neither performs automatic rollback.

Maintainer-supplied evidence reports one physical `ota_1 → ota_0 → ota_1` activation round trip. This is evidence for the reported gateway and test sequence, not proof of automatic rollback, power-loss recovery, every bootloader state, or all supported platforms. See the hardware ledger and RC notes.

## Write boundaries and verification

- No command exposes a full-chip erase or full-flash restore.
- The ordinary generic firmware-install gate remains closed.
- Stage-only app writes are restricted to the exact inactive `ota_0` image range; OTA metadata is checked byte-for-byte and remains unchanged.
- Activation and restore write one selected 4 KiB `otadata` sector at `0x13000` or `0x14000`. The exact record, sequence, state and CRC are read back; the peer sector must remain byte-identical.
- Application, factory, credentials, NVS, calibration, partition table, bootloader and unrelated regions are outside OTA metadata write ranges.
- A failed write/readback or uncertain transport result is reported as an error, not success. The program does not retry metadata or app writes automatically.
- Activation requires exact fresh metadata-backup bytes; a stale backup cannot authorize a different live metadata state. Restore validates backup length, SHA-256, identity binding, both metadata sectors, and the recovery app before confirmation.

Stage-only backups, OTA metadata backups, and application backups have distinct purposes. An OTA metadata backup is device-bound and can be used by the narrowly gated restore command only after its selected recovery app is revalidated. Application and whole-partition backups are preservation artifacts and are not general restore images. Partition dumps may contain sensitive device data.

## Firmware trust and Secure Boot

Firmware catalog SHA-256 protects the fetched bytes against the digest in the validated catalog. `security check` additionally validates ESP32-S3 image structure and RSA-PSS Secure Boot V2 signature evidence, then compares its signer to readable device eFuse key-purpose digests and revocation/security-version evidence. Image signature validity, device signer trust, OTA selection, application startup and long-term application health are separate claims. The device bootloader remains responsible for enforcing Secure Boot during startup.

Readable eFuse data is not guaranteed. All-zero, protected, unreadable, or ambiguous digest data is not promoted to trusted key evidence. The installed bootloader rollback/anti-rollback configuration remains unknown unless independently established; the image security-version floor is reported separately. A successful OTA round trip does not demonstrate recovery from a rejected image or sudden power loss.

## JSON and redaction

With `--json`, stdout contains the JSON result only; progress and diagnostics go to stderr. Unavailable evidence is represented as unknown/null rather than guessed. `--redact` is applied at output boundaries, including JSON, stderr, live monitor output, and saved monitor/boot logs, while original identifiers remain available internally for validation and cryptographic operations. Redaction is best-effort, not a guarantee; review logs before sharing.

## Automated and physical validation

Automated tests use fixtures and mocked transports. They must never perform physical flash writes or erases. Physical checks require explicit operator authorization and must use the read-only workflow unless a separately reviewed and operator-confirmed write procedure is in progress. Current known limitations are listed in [`docs/known-limitations.md`](docs/known-limitations.md).
