# WeatherXM WG1200 CLI

Independent command-line utility for inspecting, verifying and installing compatible firmware on WeatherXM WG1200 gateways without a browser. It is not an official WeatherXM utility.

## Status

Commands include `info`, `verify`, `status`, `ota status`, `ota backup`, `firmware list`, `security`, `backup inactive`, `backup partition`, and `flash`. Standard device inspection enters the ESP32-S3 ROM loader and runs a RAM stub; `security` stays in the ROM loader and reads eFuse registers without uploading a stub or accessing flash. Normal OTA installation remains fail-closed. The distinct `flash weatherxm --stage-only` path can write only verified official WeatherXM 0.8.34 to `ota_0` while `ota_1` is active, and never modifies OTA metadata or activates the staged image. `ota status` reads both OTA metadata sectors and both app slots. `ota backup` saves the exact 8 KiB metadata partition with an independent readback and device-bound manifest. `ota activate` currently accepts only `--dry-run` and always blocks; the installed bootloader rollback/anti-rollback configuration and actual-running slot cannot be inferred from a ROM flash snapshot. `backup inactive` streams the complete inactive OTA partition and creates a verified manifest. `backup partition <name>` explicitly reads one exact discovered allowlisted partition, creating a sensitive full dump and manifest after an interactive confirmation. Stage-only requires the OTA backup manifest and a deliberate interactive confirmation. `flash --dry-run` remains read-only.

`ota status` defaults to `--verify-mode fast`: it validates OTA metadata and reports application identity from 4 KiB descriptor headers without reading complete 4 MiB app partitions. Fast mode does not verify full-image SHA-256 or signatures; it reports those checks as unavailable. Use `ota status --verify-mode thorough` to read both full app partitions, calculate SHA-256, inspect image boundaries and verify Secure Boot V2 signatures. Both modes report signature validity separately from signer trust, and neither infers anti-rollback settings or the application currently running. The JSON report includes `verificationMode`, overall `assurance`, and per-slot `imageVerification` fields; calculated hashes do not imply a match against a trusted baseline. With `--json`, the final document stays on stdout while the shared progress display remains on stderr; when stderr is a TTY it updates in place even if stdout is JSON.

The official reference repository and exact behavior reviewed are documented in [docs/official-flasher-analysis.md](docs/official-flasher-analysis.md). The staged implementation plan is in [docs/implementation-plan.md](docs/implementation-plan.md). Safety rules are in [SAFETY.md](SAFETY.md).

## Hardware validation

The maintainer-reported Linux ARM64 standalone built from commit `b332833` completed one each of `info`, `verify`, and `status` on a Raspberry Pi 5 with a WG1200. This validates those read-only operations on that hardware, not firmware installation, erase, or recovery. The current audited source is newer and has not been physically exercised. See the [hardware validation record](docs/hardware-validation.md) for build identity and limits.

Contributor workflow and safety requirements are in [AGENTS.md](AGENTS.md). Command examples and sample dual-slot output are in [EXAMPLE.md](EXAMPLE.md).

## Standalone executables

The release workflow builds a self-contained executable with the Node.js runtime, bundled CLI, and platform-specific `serialport` binding. Users do not need Node.js, npm, Bun, or the source repository to run an installed standalone executable. Firmware manifests and images are still downloaded from the configured official HTTPS catalog when a network-dependent firmware command is run.

### Supported platform matrix

| Release artifact | OS and architecture | Minimum validated OS baseline | Status in this project |
| --- | --- | --- | --- |
| `weatherxm-flash-macos-arm64` | macOS ARM64 (Apple Silicon) | macOS 14 build runner | Build target; physical hardware validation is not claimed in this validation record. |
| `weatherxm-flash-linux-arm64` | Linux ARM64 | Ubuntu 22.04 build runner | Read-only physical validation reported on Raspberry Pi 5; see [hardware validation](docs/hardware-validation.md). |
| `weatherxm-flash-linux-x64` | Linux x64 | Ubuntu 22.04 build runner | Build and release-workflow smoke-test target; no physical-device validation is recorded here. |

Build runner baselines are macOS 14 and Ubuntu 22.04. Linux ARM64 runtime environments need `libatomic1`. Older OS releases have not been established as compatible. The maintainer-reported Linux ARM64 build has completed read-only tests on a Raspberry Pi 5; the current audited source has not. Other platform targets are not claimed as physically validated.

Linux executables need a compatible system C/C++ runtime and `libatomic.so.1` (usually provided by the `libatomic1` package on Debian/Ubuntu). Linux users need permission to open the serial device, often through the `dialout` group; log out and back in after changing group membership. Containers must expose the serial device, commonly `/dev/ttyUSB0` or `/dev/serial/by-id/...`.

On macOS, serial adapters commonly appear as `/dev/cu.*` and `/dev/tty.*`; use the `/dev/cu.*` path for CLI connections. For example, `/dev/cu.usbserial-13210`.

### Manual installation

Download the matching executable and `SHA256SUMS` from the same trusted GitHub release. This repository does not currently configure a public owner/repository URL, so replace `<OWNER>/<REPOSITORY>` and `<TAG>` with the actual release location; do not guess the URL. Verify the checksum in the directory containing the downloaded files:

```sh
# macOS ARM64 (verifies the one artifact you downloaded)
grep ' weatherxm-flash-macos-arm64$' SHA256SUMS | shasum -a 256 -c

# Linux ARM64
grep ' weatherxm-flash-linux-arm64$' SHA256SUMS | sha256sum -c

# Linux x64
grep ' weatherxm-flash-linux-x64$' SHA256SUMS | sha256sum -c
```

Install the verified artifact under the command name `wg1200`:

```sh
# macOS ARM64
chmod +x weatherxm-flash-macos-arm64
sudo install -m 755 weatherxm-flash-macos-arm64 /usr/local/bin/wg1200

# Linux ARM64
chmod +x weatherxm-flash-linux-arm64
sudo install -m 755 weatherxm-flash-linux-arm64 /usr/local/bin/wg1200

# Linux x64
chmod +x weatherxm-flash-linux-x64
sudo install -m 755 weatherxm-flash-linux-x64 /usr/local/bin/wg1200

wg1200 --version
wg1200 --help
```

Homebrew is not required. On Apple Silicon, Homebrew commonly adds `/opt/homebrew/bin` to `PATH`, while the commands above install to `/usr/local/bin`. Check `command -v wg1200` and `printf '%s\n' "$PATH"`; if `/usr/local/bin` is missing, add it to your shell `PATH`, or install into a directory already on `PATH` such as `/opt/homebrew/bin` or `$HOME/.local/bin` (create the latter and add it to `PATH` first).

The macOS executable is ad-hoc signed, not Developer ID signed or notarized. Do not remove quarantine attributes automatically or disable Gatekeeper. If macOS blocks the executable, first review its source and checksum; if you choose to proceed, attempt to open it, then use **System Settings → Privacy & Security → Open Anyway** to make a user-controlled exception. See [Apple's instructions for safely opening apps](https://support.apple.com/en-gb/102445).

### Optional installation script

[`scripts/install-wg1200.sh`](scripts/install-wg1200.sh) detects the OS/architecture, downloads the matching release artifact over HTTPS, checks its entry in `SHA256SUMS`, and only then installs it as `wg1200`. It requires `curl` and `shasum` or `sha256sum` on the target, but no Node.js/npm/Bun. The script requires explicit `WG1200_GITHUB_REPOSITORY` and `WG1200_RELEASE_TAG` values because this checkout has no configured public release URL; it has no default repository. It refuses to overwrite an existing install. Set `WG1200_INSTALL_DIR` to choose another directory.

```sh
sudo env WG1200_GITHUB_REPOSITORY='<OWNER>/<REPOSITORY>' \
  WG1200_RELEASE_TAG='<TAG>' WG1200_INSTALL_DIR='/usr/local/bin' \
  sh ./scripts/install-wg1200.sh
```

Manual installation remains available for users who do not want to run the script.

For a per-user install, choose a directory on your `PATH` and run the script without `sudo`:

```sh
WG1200_GITHUB_REPOSITORY='<OWNER>/<REPOSITORY>' \
  WG1200_RELEASE_TAG='<TAG>' WG1200_INSTALL_DIR="$HOME/.local/bin" \
  sh ./scripts/install-wg1200.sh
```

### Upgrade, uninstall, and build details

To upgrade manually, download the new release files, verify `SHA256SUMS`, then intentionally replace the installed command:

```sh
sudo install -m 755 weatherxm-flash-macos-arm64 /usr/local/bin/wg1200
```

Choose the Linux artifact as appropriate. The optional installer deliberately stops if `/usr/local/bin/wg1200` already exists; move/remove the existing command yourself before using it. To uninstall the default installation, run `sudo rm /usr/local/bin/wg1200`.

Inspect the installed executable and its build provenance with `wg1200 --version` and `wg1200 --version --verbose`. Verbose output includes package version, build timestamp, source SHA-256, Git commit and tag, dirty-tree status, OS, architecture, and Node runtime. Tagged release builds require a clean source tree. The embedded source hash is computed over the TypeScript files in `src/`; the release workflow also publishes SHA-256 checksums for downloaded executables.

To build locally, install Node.js 26 or newer and the package dependencies, then run `npm ci` and `npm run build:standalone` on the target OS and architecture. Bun is not a substitute for Node's SEA builder. Cross-platform compilation is refused because the serial adapter includes OS-specific native code. The release workflow builds each target on a matching native runner and validates the staged executable before replacing any existing output.

## Requirements for the source build

- Node.js 20 or newer
- Linux, macOS, or Windows with a supported USB serial adapter
- Linux users need permission to open the serial device (often membership in `dialout`)

```sh
npm ci
npm run build
npm link
wg1200 --help
```

## Commands

```sh
# Identify the connected gateway and show the validated layout and OTA state
wg1200 info --port /dev/ttyUSB0

# Run identity, flash-size, partition, certificate, and OTA validation
wg1200 verify --port /dev/ttyUSB0 --baud 115200

# Show active and inactive firmware slots and OTA records
wg1200 status --port /dev/ttyUSB0 --json

# Passively monitor the device console without entering the bootloader
wg1200 monitor --port /dev/ttyUSB0 --timestamp --level info

# Reset into normal application boot and capture ROM, bootloader and app logs
wg1200 monitor --port /dev/ttyUSB0 --baud 115200 --boot --redact --timestamp --output ./wg1200-boot.log

# Check a release against the active app descriptor without changing flash
wg1200 check weatherxm --port /dev/ttyUSB0 --json

# List firmware releases from the official catalog
wg1200 firmware list

# Install a listed release; review the displayed identity, image hash, and target slot
wg1200 flash meshtastic --port /dev/ttyUSB0

# Complete inspection and then keep listening to the booted device
wg1200 info --port /dev/ttyUSB0 --monitor

# Share identifying output more safely (review before posting)
wg1200 info --port /dev/ttyUSB0 --json --redact
wg1200 status --port /dev/ttyUSB0 --redact

# Capture post-flash boot logs for 30 seconds, or disable the finite capture
wg1200 flash weatherxm --port /dev/ttyUSB0 --boot-log-seconds 30
wg1200 flash weatherxm --port /dev/ttyUSB0 --boot-log-seconds 0

# Continue monitoring after a successful installation until Ctrl+C
wg1200 flash weatherxm --port /dev/ttyUSB0 --monitor

# Explicit noninteractive confirmation for reviewed automation
wg1200 flash weatherxm --port /dev/ttyUSB0 --yes

# Inspect the image descriptor, compare it with the active app, and show the proposed target without writing
wg1200 flash weatherxm --port /dev/ttyUSB0 --dry-run

# Intentionally reinstall the exact same firmware build (still requires normal write confirmation)
wg1200 flash weatherxm --port /dev/ttyUSB0 --force

# Explicitly authorize the official targeted recovery flow for ambiguous OTA metadata
wg1200 flash weatherxm --port /dev/ttyUSB0 --recover
```

Print the application version without accessing a device or the network:

```sh
wg1200 --version
wg1200 --version --verbose
wg1200 --version --verbose --json
```

The concise form prints the application name and package version. Verbose output also reports embedded build timestamp, source SHA-256, Git commit/tag and working-tree status, plus the operating system, architecture, and Node.js runtime version.

Baud defaults to 115200, matching the WG1200 web flasher. Firmware writes report progress at 5% intervals. After reboot, the CLI listens for up to 12 seconds and reports the detected boot signature, app version, whether the boot log reported Secure Boot signature success, and whether it observed PHY calibration regeneration. `--json` emits machine-readable device/catalog output. `--manifest URL` can point `firmware list` to another HTTPS manifest on the same origin as its firmware files.

`check <firmware>` downloads and validates the actual firmware image, inspects the gateway, then applies the same descriptor comparison policy as flash preflight. Completed checks always exit `0`, including up-to-date, update available, downgrade blocked, approval required, and incompatible firmware results. Invalid input, unavailable manifests, image-integrity failures, and device-validation errors exit nonzero. A firmware-type change is reported as incompatible/approval-required and is never described as a normal version upgrade.

`monitor` opens a receive-only serial session without creating an esptool loader or sending serial bytes. It supports `--timestamp`, `--level error|warn|info|debug|verbose`, `--output <file>`, `--raw`, and `--no-color`. The monitor sanitizes certificate/key blocks and long hex values even in raw mode. `--boot` attaches the raw receive handler before opening the port, then holds DTR deasserted (GPIO0 released), asserts RTS for 120 ms (EN reset), and releases RTS; it keeps that same port open through ROM, bootloader, and application output until Ctrl+C. The reset sequence also waits 50 ms before asserting EN and 150 ms after release. This mapping follows the existing esptool transport convention; board-level tracing has not independently verified the WG1200 wiring. Do not infer device configuration from missing log messages. Redaction is best-effort; inspect captures before sharing. `--monitor` on a device operation starts this passive reader after the operation closes and releases its own serial connection; early boot messages can occur before that reader opens.

`--redact` masks MAC addresses and partial MAC suffixes, gateway/device and station identifiers/names (including telemetry `ws_fo_id` and station-ownership log messages), certificate common names, fingerprints and PEM blocks, public keys/hashes, serial-number fields, access tokens, MQTT credentials, device/mDNS names, and labeled location/address and IP-address fields in human-readable and JSON output, including application diagnostics and monitor output files. Embedded JSON in serial log lines is parsed and reserialized after sensitive fields are replaced. Sensitive JSON values become string placeholders (JSON `null` stays `null`); for malformed JSON-like key/value fragments, an unquoted sensitive value is replaced with `null` when the key is quoted. In monitor mode it also replaces byte rows inside recognized LoRa packet blocks and `WS PubKey`/`WS SN` identity blocks with byte counts while preserving packet headers and signal metrics. `--raw` changes monitor formatting only; it does not disable redaction. It does not alter values used internally for device identity, validation, or cryptographic checks. It preserves operational details such as chip model, firmware version, reset reason, flash size, partition layout, heap telemetry, ordinary hexadecimal addresses, and labeled public firmware SHA-256 values. Redaction uses field names and recognizable text patterns; unknown log syntax can still leak values, so it is best-effort and not a security proof. Review logs before sharing them.

Post-flash boot capture defaults to 15 seconds. Set `--boot-log-seconds 0` to skip it or a positive value up to 3600 to change the duration. `--monitor` overrides finite capture and continues until Ctrl+C. Flash, OTA metadata, and protected-partition verification are reported separately from boot evidence. Missing boot logs report `NOT OBSERVED`; `applicationHealthy` remains `not-checked` because no reliable application health probe is currently defined.

The `check --json` response is a JSON object with these stable fields:

```json
{
  "device": { "model": "WG1200", "identity": "<device name>", "identityValid": true, "chip": "ESP32-S3", "flashBytes": 16777216 },
  "otaState": { "ambiguous": false, "explanation": "<OTA state description>" },
  "installedFirmware": { "type": "weatherxm", "version": "0.8.34-g86b609b", "build": "<embedded app ELF SHA-256>" },
  "availableFirmware": { "type": "weatherxm", "version": "0.8.34-g86b609b", "build": "<embedded app ELF SHA-256>" },
  "firmwareImageSha256": "<downloaded image SHA-256>",
  "comparison": "identical",
  "updateAvailable": false,
  "flashingPermitted": false,
  "approvalRequired": false,
  "status": "up-to-date",
  "explanation": "Already installed"
}
```

`comparison` values are `identical`, `newer`, `older`, `same-version-different-build`, `different-type`, and `ambiguous`. `status` values are `up-to-date`, `update-available`, `downgrade-blocked`, `approval-required`, `incompatible-firmware`, and `security-blocked`. Existing check output's `securityEvidence` remains `unverified`; `flashingPermitted` is always false. A type change is not treated as an update.

Device inspection JSON (`info`, `status`, `verify`) and firmware check/dry-run JSON include additive `ota` and `firmwareSlots` fields. `ota.activeSlot` and `ota.inactiveSlot` are null when validated OTA metadata cannot identify an OTA slot; `nextTargetSlot` and `nextTargetOffset` are null for ambiguous metadata. `firmwareSlots.ota_0` and `.ota_1` contain `active`, `version`, `firmwareType`, `build`, and `descriptorStatus` (`valid`, `invalid`, or `unknown`). Unavailable descriptor values are JSON `null`. Check/dry-run also report `inactiveMatch` when the selected application descriptor matches the readable inactive slot descriptor; this is informational and does not change installation policy.

`security --port <path>` reports read-only Secure Boot V2 eFuse evidence. `security check weatherxm --port <path>` (or `meshtastic`) verifies the candidate image structure, digest, RSA-PSS signature, signing-key digest, eligible device key, revocation state, and security-version floor. `trust.result: TRUSTED` means those image and device trust checks pass; it does not establish application bootability or installed-bootloader OTA/rollback behavior. The result's `installation.readiness` remains `BLOCKED` while bootloader/recovery readiness and physical validation of complete protected-region preservation remain incomplete. Firmware install attempts remain rejected before any flash operation regardless of `--yes`, `--force`, or `--recover`. `--dry-run` remains read-only and reports the proposed target plus the write-block reason. See the [safety audit](docs/firmware-write-safety-audit.md) and [recovery readiness report](docs/wg1200-recovery-readiness.md).

Security-check JSON preserves the existing top-level `result`, `trust`, and `applicationBootAndRollbackEstablished` fields. It adds `installation: { readiness, reason }`; `trust.result` now represents verified image/device trust independently of unknown bootloader configuration. The top-level `result` mirrors that trust result and does not represent write readiness.

Security JSON `keyBlocks[]` includes `readDiagnostic` for digest-purpose blocks. It reports the logical slot, physical eFuse block, register base offset, eight-word read count, and a fixed failure category/word offset when relevant. It never includes raw eFuse words. A successful signature check is separate from device key trust, and the digest remains unavailable until read-only hardware revalidation succeeds.

Security JSON now also reports `flashEncryption` (`cryptCount`, odd-parity `enabled`, `disableManualEncryption`, and evidence `status`) plus `downloadMode.disableUsbOtgDownload`. These are read-only eFuse observations; unavailable data is `null`, and unknown flash-encryption or ROM write conditions fail closed. They do not override the global `BLOCKED` installation policy.

`firmware download weatherxm [--version 0.8.34]` retrieves an exact official catalog release, streams it to a temporary file, checks size and SHA-256, validates the ESP32-S3 descriptor and Secure Boot V2 signature, then stores the complete verified image by digest under `~/.cache/weatherxm-flash/firmware/`. Valid entries are rechecked before reuse; `--offline` requires a cached, verified catalog and image. Cache files include official-manifest provenance. A valid image signature is not the same as signer trust for a particular gateway; that requires read-only device security evidence.

`backup active --port <path> --output <file>` and `backup inactive --port <path> --output <file>` write the selected full 4 MiB OTA application partition and create `<file>.manifest.json`. They use the validated live OTA selection, never overwrite an existing output, and independently hash a second physical read of the partition. Active backup selects the validated active slot; inactive backup selects the validated inactive slot. The manifest records descriptor and supported signature-boundary evidence, readback status, and build provenance. Backups do not include NVS or credentials and do not prove restorability.

`backup partition <name> --port <path> --output <file>` is a separate read-only command for an explicitly named, discovered WG1200 allowlisted partition. It reads every byte, shows transfer progress, speed and ETA, computes SHA-256, then independently reads the entire partition again and compares SHA-256 before atomically finalizing the data file and `<file>.manifest.json`. Existing files are never overwritten; both files use mode `0600`. All such dumps are treated as sensitive because they may contain certificates, credentials, NVS or other device-specific data. The command requires an interactive `BACKUP <name>` confirmation and warns the operator before connecting. Protect both files and review them before sharing. These dumps are never added automatically to OTA application backups, and a backup alone does not establish a restore procedure.

`ota status --port <path> [--json] [--redact]` reads and reports the two `otadata` sectors using the ESP-IDF v5.1.2 source model, then reads both OTA app slots for descriptors and Secure Boot V2 signature/device-trust evidence. It also reports the fixed partition map, CRC/state/sequence observations, and why activation is blocked. ROM inspection can predict metadata selection but cannot query `esp_ota_get_running_partition()`; use `monitor --boot --redact --output <log>` and look for the bootloader line `Loaded app from partition at offset 0x...` to observe the slot actually selected. The reported bootloader IDF version or ROM log does not prove the precise deployed bootloader binary or Kconfig.

`ota backup --port <path> --output <file>` saves exactly `0x2000` bytes from `otadata` at `0x13000`, verifies it with an independent second physical SHA-256 read, and creates `<file>.manifest.json`. The data and manifest use mode `0600`; existing paths are never overwritten. The manifest binds the bytes to hashes of the device MAC and Secure Certificate identity. Keep these files separate from application backups. This command is read-only with respect to flash but enters the ROM/stub inspection flow and resets the gateway on cleanup. It does not implement raw restore.

`ota activate --target ota_0 --port <path> --dry-run [--metadata-backup-manifest <path>]` is a read-only plan and exits unsuccessfully while safety blockers remain. This build has no OTA metadata activation writer. It never changes either OTA image or `otadata`. The currently observed deployment evidence does not establish installed rollback/anti-rollback configuration, application confirmation behavior, or an actual running slot from ROM inspection, so the command is not ready for a physical activation trial. Keep the gateway on the known working slot; use a vendor-approved recovery process if a boot failure occurs. Do not treat identical application version strings as proof of which slot booted or of automatic rollback.

`firmware compare --backup <full-partition-file> --firmware weatherxm --json` compares an integrity-checked backup to the official image, using signed-image extents rather than comparing the 4 MiB partition hash to the smaller firmware file. `--offline` uses the previously verified catalog/cache. An explicit image can be compared with `--firmware-file <path> [--expected-sha256 <digest>]`; without an expected digest its provenance is unverified. Results separate image bytes from trailing partition data and do not infer an exact image match from version/build identity alone.

Long-running operations report measured completed bytes, rate, elapsed time, and ETA when the total is known. Status-only operations show their stage and elapsed time without transfer metrics. On an interactive terminal, progress updates share an output coordinator with esptool/transport diagnostics so logs clear and then resume the active line cleanly. Redirected output uses complete periodic lines with no cursor controls. `--verbose` enables detailed ROM/esptool/transport messages; `--trace-serial` includes serial diagnostics. Progress and diagnostics stay on stderr so JSON stdout remains valid, and `--redact` applies at the output boundary. Review logs before sharing because redaction cannot detect every possible sensitive value.

`flash weatherxm --stage-only` downloads or verifies the exact firmware locally before device access, then performs live preflight and presents an interactive target-backup choice. Stage-only still requires a verified backup; declining stops the operation. It is pinned to the approved 0.8.34 image and `ota_0` while `ota_1` is active. A separate exact confirmation is required before writing; it allows up to five phrase attempts, with a retry-or-cancel choice after a mistake. A failed phrase never authorizes a write, and Ctrl+C or cancellation returns the gateway to normal boot and closes the port.

Stage-only defaults to `--verify-mode fast`; select `--verify-mode thorough` before preflight for complete physical SHA-256 reads. Fast uses the bundled ESP32-S3 RAM stub's `SPI_FLASH_MD5` for the exact `ota_0` backup-freshness comparison and for every preserved region, including bootloader, partition table, OTA metadata, active OTA, factory, SPIFFS, NVS, certificates and calibration. These device digests are routine equality checks for accidental changes, not cryptographic authentication. If device MD5 fails or is unavailable during protected-region snapshotting, Fast reports the reason and falls back to Thorough before confirmation; a valid digest mismatch blocks staging and never falls back. If an MD5 comparison fails after confirmation, the transaction fails closed. Thorough never uses MD5 for protected-region comparison: it retains full physical SHA-256 reads. Both modes retain official firmware SHA-256, Secure Boot V2 signature and signer-trust checks, backup-file SHA-256, exact OTA metadata byte-for-byte checks, and independent post-write firmware SHA-256 readback. Reports identify the actual method and range for each protected region. Device-side digest work reports status and elapsed time only, without fabricated byte speed or ETA. This path never calls the OTA metadata writer; it does not establish that the staged image boots or that the previous inactive image is restorable. The ordinary installation gate remains blocked. See [the stage-only hardware test procedure](docs/wg1200-stage-only-hardware-test.md).

## Docker

The image supports the host architecture, including Linux ARM64 systems such as Raspberry Pi. Pass the serial device through explicitly:

```sh
docker build -t weatherxm-wg1200-cli .
docker run --rm --device=/dev/ttyUSB0 weatherxm-wg1200-cli info --port /dev/ttyUSB0
docker run --rm --device=/dev/ttyUSB0 weatherxm-wg1200-cli verify --port /dev/ttyUSB0 --json
```

For hosts where the device is group-restricted, add its numeric group ID with `--group-add <gid>`. Home Assistant OS add-on and container deployments must expose the serial device to the container; device naming may be `/dev/ttyUSB0` or `/dev/serial/by-id/...`.

## Testing

```sh
npm test
npm run typecheck
npm run build
```

Tests use fixtures and mocks. They do not connect to a gateway or perform firmware writes.

## Release process

The release workflow builds each target on a matching native runner, smoke-tests startup and the serial binding, then waits for the configured self-hosted Linux ARM64 read-only device gate. It generates SHA-256 checksums and creates a **draft prerelease** that is not public until manually published. Its notes distinguish physically tested read-only operations from automated-only write paths. Do not publish it as production-ready until firmware installation and OTA activation have been separately validated on hardware. No release has been created by this task.

The hardware gate is read-only and does not enable firmware writes. The CLI currently blocks all installation attempts because installed-bootloader recovery behavior and physical preservation validation remain incomplete. Automated firmware-write testing remains fixture/mock-only. Never use the release gate to run `flash`.

## License

This CLI/source is distributed under Apache-2.0. Reused WeatherXM implementation code is attributed to [WeatherXM/web-flasher](https://github.com/WeatherXM/web-flasher) at commit `35b2ecc4ccb31799ecd720609786362a99b3e33a`; see [UPSTREAM_NOTICES.md](UPSTREAM_NOTICES.md) and [LICENSE](LICENSE). Firmware manifests and images are fetched from WeatherXM's hosted catalog and official [WG1200 firmware source](https://github.com/WeatherXM/wg1200-firmware); the official [WeatherXM Web Flasher](https://flash.weatherxm.com/) and its [source repository](https://github.com/WeatherXM/web-flasher) are useful references. This independent project does not include or redistribute official firmware binaries.
