# WG1200 stage-only hardware test

## Purpose and boundaries

This procedure backs up the complete currently inactive OTA application and
then stages official WeatherXM 0.8.34 into `ota_0` while `ota_1` remains
selected and running. It is a physical write/readback test. It does not switch
boot selection, activate the staged image, or test application boot or rollback
behavior. The old `ota_0` application will be overwritten.

Only `flash weatherxm --stage-only` can enter this path. Normal OTA install
remains blocked by the global firmware readiness gate. Stage-only requires the
pinned official manifest digest, Secure Boot V2 RSA-PSS verification and trust
against active non-revoked eFuse digest slot 0, flash encryption disabled,
permitted ROM download mode, exact WG1200 partition layout, active firmware
`0.8.34-g86b609b` in `ota_1`, an exact verified backup of `ota_0`, and an
interactive confirmation. Unknown bootloader anti-rollback configuration is
not used as a blocker because no activation occurs. It also remains unproven.

The write sends only the 3,674,112-byte image. For the pinned image the image
range is `[0x420000, 0x7A1000)` and its 4 KiB sector erase range is the same.
`ota_0` ends at `0x820000`; the remainder of the 4 MiB partition is not erased
or written. The active `ota_1` app, bootloader region `[0x000000, 0x00C000)`,
partition table, factory app, credentials, NVS, NVS keys, calibration,
SPIFFS, and both OTA metadata sectors are checked and preserved. No credentials
are exported by the backup operation.

A matching backup SHA-256 and file length prove the saved bytes match the
inactive partition when read. They do not prove that the old application is
valid, signed, bootable, or restorable. The manifest records descriptor and
signature inspection where possible and labels unknown/invalid results. The
operator must review that limitation; do not call the backup a tested recovery
path.

## Prepare the Raspberry Pi

Copy the uniquely named build to `bugs` and verify its checksum against the
final build report:

```sh
ssh bugs 'mkdir -p ~/weatherxm-flash-stage'
scp dist/weatherxm-flash-linux-arm64-stage-only bugs:~/weatherxm-flash-stage/
ssh bugs 'chmod 755 ~/weatherxm-flash-stage/weatherxm-flash-linux-arm64-stage-only && sha256sum ~/weatherxm-flash-stage/weatherxm-flash-linux-arm64-stage-only'
```

In the Pi shell, use the standalone binary as `wg1200`:

```sh
cd ~/weatherxm-flash-stage
alias wg1200="$PWD/weatherxm-flash-linux-arm64-stage-only"
wg1200 --version --verbose
```

## A. Download and compare backups

The default terminal view shows operation stages and measured byte progress.
Use `--verbose` to include detailed ROM/esptool/transport logs; diagnostic
messages are coordinated with the active progress line. In redirected or JSON
mode output uses complete stderr lines without terminal cursor sequences.
Status-only operations report elapsed time and do not show transfer speed or
ETA.

Download the exact pinned release before connecting the gateway. The verified
content-addressed cache defaults to `~/.cache/weatherxm-flash/firmware/`.
Repeat with `--offline` to validate cache reuse without network access.

```sh
wg1200 firmware download weatherxm --version 0.8.34
wg1200 firmware download weatherxm --version 0.8.34 --offline --json
```

Capture both OTA applications before staging. Choose output paths that do not
already exist. Each backup is followed by an independent full-partition read
and SHA-256 comparison.

```sh
wg1200 backup active --port /dev/ttyUSB0 --output "$HOME/wg1200-stage-backups/ota1-before-stage.bin" --json --redact
wg1200 backup inactive --port /dev/ttyUSB0 --output "$HOME/wg1200-stage-backups/ota0-before-stage.bin" --json --redact
wg1200 firmware compare --backup "$HOME/wg1200-stage-backups/ota1-before-stage.bin" --firmware weatherxm --offline --json
wg1200 firmware compare --backup "$HOME/wg1200-stage-backups/ota0-before-stage.bin" --firmware weatherxm --offline --json
```

Comparison uses supported signed-image extents and reports trailing partition
data separately. Unknown or unsupported boundaries remain inconclusive.
Progress stays on stderr so JSON stdout remains valid. Inspect logs before
sharing even when `--redact` is used.

## B. Read-only preflight

Run each command and review its complete output. Device inspection can reset
the gateway while entering the ROM loader. These commands do not write flash.

```sh
wg1200 firmware list --json
wg1200 security --port /dev/ttyUSB0 --json --redact
wg1200 security check weatherxm --port /dev/ttyUSB0 --json --redact
wg1200 info --port /dev/ttyUSB0 --json --redact
wg1200 flash weatherxm --port /dev/ttyUSB0 --dry-run --json --redact
```

Confirm ESP32-S3 revision 0.2, Secure Boot V2 enabled, security-version floor
0, flash-encryption count 0 and disabled, `DIS_DOWNLOAD_MANUAL_ENCRYPT=false`, all ROM
download restrictions false, candidate `WeatherXM 0.8.34` SHA-256
`bb5af75dfe1b5df7d973110d834c8b7c26af983acc0ff2728900b3ca88dc19eb`, signer
slot-0 match, `ota_1` active at `0x820000`, and `ota_0` inactive at `0x420000`.
The `dry-run` is the ordinary read-only policy path and may report that the
identical active version is already installed; it is not stage authorization.

**Stop** if any observed chip, active firmware, partition layout, OTA slot,
security value, signer, candidate digest, or port differs from the values
above or is unknown. Do not use `--force` or normal `flash` as a substitute.

## C. Back up the whole inactive partition

Choose a new output filename; the command refuses to overwrite either the
backup or its manifest. Ensure the destination directory has enough space.

```sh
mkdir -p "$HOME/wg1200-stage-backups"
BACKUP="$HOME/wg1200-stage-backups/ota0-before-stage.bin"
wg1200 backup inactive --port /dev/ttyUSB0 --output "$BACKUP" --json --redact
```

The command re-reads the entire 4 MiB inactive partition in bounded 4 KiB
chunks, writes a temporary file, calculates SHA-256, performs an independent
second complete device hash pass, inspects the app descriptor/signature when
the signed image boundary can be identified, and atomically finalizes the
backup and `$BACKUP.manifest.json`. It resets back to normal boot on exit.

## D. Review the backup

```sh
test "$(stat -c %s "$BACKUP")" -eq 4194304
sha256sum "$BACKUP"
cat "$BACKUP.manifest.json"
```

Check partition label `ota_0`, offset `0x420000`, length `4194304`,
`independentReadbackVerified: true`, and matching SHA-256. Review `firmwareVersion`
and `signatureVerification`. `invalid` or `not-verified` means the existing
inactive image has not been established as restorable; the displayed stage
confirmation repeats this limitation. The stage command independently checks
manifest format, file digest and size, exact partition identity, and a fresh
live `ota_0` hash before it will write.

## E. Stage the verified firmware without activation

Run this in an interactive terminal. Do not add `--yes`, `--force`,
`--recover`, `--dry-run`, or `--monitor`. The program prints device, active and
inactive descriptors, backup digest, candidate digest, erase/write ranges,
flash-encryption state, protected partitions, unchanged metadata, no-activation
behavior, and interruption risks. It requires typing a phrase containing the
gateway name, `ota_0`, firmware version, and full candidate SHA-256. With
`--redact`, type the redacted gateway placeholder shown in the prompt.

```sh
wg1200 flash weatherxm --stage-only --backup-manifest "$BACKUP.manifest.json" \
  --port /dev/ttyUSB0 --redact
```

The stage path rechecks device identity, active/inactive metadata, backup
freshness, protected hashes and bootloader hash immediately before writing.
It writes only the image-length range, runs ESP32 hardware MD5, streams the
written image back for SHA-256, rechecks protected regions and the active
`ota_1` image, compares all 8 KiB of OTA metadata byte-for-byte, and resets to
normal mode. The stage code contains no OTA metadata write operation.

Expected success:

```text
STAGED AND VERIFIED — NOT ACTIVATED
Hardware MD5: VERIFIED
Expected SHA-256: bb5af75dfe1b5df7d973110d834c8b7c26af983acc0ff2728900b3ca88dc19eb
Readback SHA-256: bb5af75dfe1b5df7d973110d834c8b7c26af983acc0ff2728900b3ca88dc19eb
OTA metadata unchanged: YES
Active ota_1 unchanged: YES
Automatic activation: NO
```

Other outcomes are `STAGING FAILED — TARGET MAY BE PARTIALLY WRITTEN`,
`STAGING FAILED — VERIFICATION MISMATCH`,
`STAGING FAILED — PROTECTED REGION CHANGED`,
`STAGING BLOCKED — PREFLIGHT FAILED`, or
`STAGING BLOCKED — BACKUP INVALID`. On any non-success outcome, stop. Do not
run normal flash, modify OTA metadata, or assume the backup can restore the
inactive image.

## F. Confirm original firmware remains selected

The stage command itself resets into normal boot after successful verification.
Capture the normal startup, then inspect boot selection and descriptors:

```sh
wg1200 monitor --boot --port /dev/ttyUSB0 --redact
# Wait for ROM, Secure Boot, ota_1 selection, and application startup; then Ctrl+C.
wg1200 info --port /dev/ttyUSB0 --json --redact
```

Confirm Secure Boot succeeds, `ota_1` remains selected at `0x820000`, and
WeatherXM `0.8.34-g86b609b` starts. These checks establish only the original
active application continued to boot after staging. They do not activate or
boot-test the new `ota_0` image. Normal Wi-Fi/MQTT service should be checked
using the operator's usual telemetry path.

## Stop and recovery conditions

- Any failed preflight, mismatch, incomplete read, unavailable protected hash,
  or unexpected OTA metadata: stop before staging, or classify the stage as
  failed if it occurred after writing began.
- A partial write or verification failure: leave `ota_1` selected. Do not
  clear OTA metadata, erase flash, or attempt an unreviewed restore.
- If the original `ota_1` no longer boots or ROM access is lost, stop and use
  the vendor/service recovery path. The inactive-slot backup and this test do
  not establish a recovery procedure.
- No eFuse programming, Secure Boot bypass, chip erase, release publication,
  or GitHub push is part of this procedure.
