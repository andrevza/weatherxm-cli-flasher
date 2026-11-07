# Backup and recovery guide

This guide describes distinct backup types and the current OTA metadata recovery paths. Confirm that the image is correct for the gateway, keep a stable power source and serial connection, and read every plan before typing its exact confirmation phrase. Inspection enters the ROM loader and resets the gateway during cleanup.

## OTA metadata backup

Before activation, create a fresh backup at a new path:

```sh
wg1200 ota backup --port /dev/ttyUSB0 \
  --output "$HOME/wg1200-otadata-before-ota0.bin" --json --redact
```

The command saves the complete 8 KiB `otadata` area and an adjacent `.manifest.json` file. It independently reads the physical partition again and compares SHA-256, refuses to overwrite either output, and binds the manifest to hashes of the gateway MAC and Secure Certificate identity. Protect the data and manifest together.

## OTA activation

Review image and metadata state first, then run a no-write plan:

```sh
wg1200 ota status --port /dev/ttyUSB0 --verify-mode thorough --json --redact
wg1200 ota activate --target ota_0 --port /dev/ttyUSB0 \
  --metadata-backup-manifest "$HOME/wg1200-otadata-before-ota0.bin.manifest.json" \
  --verify-mode thorough --dry-run --json --redact
```

Fast mode verifies authenticated source bytes and compares the target/recovery image ranges with device-side MD5; it is not a physical full-image SHA-256 readback. Thorough mode also reads full physical app partitions and checks SHA-256, image structure and Secure Boot V2 signatures. The backup must describe the exact current 8 KiB metadata bytes and the same device; take a new one after every activation before the next switch.

For an actual activation, run the same command without `--dry-run` in a real interactive terminal. The CLI presents the selected/current slot, target, sequence, metadata sector/address, image checks and preserved areas. It requires the exact phrase `ACTIVATE <slot> SEQUENCE <n>` submitted as a line. Cancellation or an incorrect phrase does not enter the writer. After confirmation, live metadata is revalidated, one selected 4 KiB `otadata` sector is written and read back, then the receiver is prepared before one normal-boot reset. The capture distinguishes:

- metadata update and sector readback;
- bootloader Secure Boot verification;
- actual loaded OTA offset (the firmware versions may be identical);
- expected app version and startup;
- optional Wi-Fi, HTTP, internet, MQTT and station-health observations.

Missing optional health evidence is `NOT_OBSERVED`, not a failure claim. No automatic rollback is attempted.

## Return to another OTA slot

After observing the selected application, take a new `ota backup` reflecting the current metadata and request the other slot. For the reported test order, the commands were conceptually:

```sh
# First switch to ota_0, using a fresh backup of current ota_1 metadata.
wg1200 ota activate --target ota_0 --port /dev/ttyUSB0 \
  --metadata-backup-manifest "$HOME/otadata-before-ota0.bin.manifest.json" \
  --verify-mode thorough --redact

# After validating ota_0, create another metadata backup and explicitly return.
wg1200 ota backup --port /dev/ttyUSB0 \
  --output "$HOME/otadata-before-return-ota1.bin" --json --redact
wg1200 ota activate --target ota_1 --port /dev/ttyUSB0 \
  --metadata-backup-manifest "$HOME/otadata-before-return-ota1.bin.manifest.json" \
  --verify-mode thorough --redact
```

The sample paths must be new before execution because backup outputs are no-clobber. Never reuse the first metadata manifest after the selection changes.

## Emergency metadata restore

Prefer `ota activate --target <still-valid-slot>` whenever current metadata and image validation permit it. Use restore only when the live metadata selection cannot be safely switched through ordinary activation and the saved metadata backup identifies a valid recovery app that is still present and trusted:

```sh
wg1200 ota restore --port /dev/ttyUSB0 \
  --metadata-backup-manifest "$HOME/otadata-before-known-good.bin.manifest.json" \
  --redact
```

Restore validates backup file length, SHA-256, device binding and both sectors; validates the backed-up selected slot against current physical firmware and device Secure Boot trust; then proposes one fresh `VALID` metadata record. It rechecks live metadata after confirmation and writes only one 4 KiB sector, preserving its peer. It does not copy the saved 8 KiB bytes back onto flash. It still requires exact high-risk interactive confirmation and captures the resulting boot. If both metadata sectors and the backed-up app are unusable, stop and seek vendor/service recovery.

## Application and partition backups

`backup active` and `backup inactive` save a complete 4 MiB OTA partition with an independently verified second device read and a manifest. These files are preservation artifacts: the CLI does not implement application backup restore, and matching hashes do not prove an image can boot.

`backup partition <name>` reads an allowlisted full partition after interactive confirmation. Treat all such images and manifests as sensitive because NVS, certificates or other device data may be included. Do not upload or share them. No general-purpose flash restore command is provided.

## Stop conditions

Stop without confirming if metadata is ambiguous, a backup is stale/wrong-device, Secure Boot trust is negative or unavailable where required, the recovery image is invalid, a write range differs from one 4 KiB metadata sector, or any preflight check fails. If readback or boot selection fails, do not clear metadata or retry blindly. A successful previous slot round trip is not a guarantee against interrupted writes or a later app/bootloader failure.
