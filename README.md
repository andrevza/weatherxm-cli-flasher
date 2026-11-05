# WeatherXM WG1200 CLI

Independent command-line utility for inspecting, verifying and installing compatible firmware on WeatherXM WG1200 gateways without a browser. It is not an official WeatherXM utility.

## Status

Commands include `info`, `verify`, `status`, `firmware list`, `security`, and `flash`. Standard device inspection enters the ESP32-S3 ROM loader and runs a RAM stub; `security` stays in the ROM loader and reads eFuse registers without uploading a stub or accessing flash. Firmware writing remains fail-closed while installed-bootloader anti-rollback behavior and OTA rollback compatibility are unknown. `flash --dry-run` remains read-only.

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

`monitor` opens a receive-only serial session without creating an esptool loader, sending serial bytes, or changing DTR/RTS. It supports `--timestamp`, `--level error|warn|info|debug|verbose`, `--output <file>`, `--raw`, and `--no-color`. The monitor sanitizes certificate/key blocks and long hex values even in raw mode. `--monitor` on a device operation starts this same passive reader after the operation closes and releases its own serial connection; duplicate owners are never kept open together. Because the monitor must reopen after the inspection/reset handoff, some early boot messages can occur before it begins listening.

`--redact` masks MAC addresses, gateway/device identifiers and names, certificate common names, fingerprints and PEM blocks, public keys/hashes, serial-number fields, and common USB serial paths in human-readable and JSON output, including application diagnostics and monitor output files. It does not alter values used internally for device identity, validation, or cryptographic checks. It preserves operational details such as chip model, firmware version, flash size, and partition layout. Redaction uses field names and recognizable text patterns; it cannot identify every possible secret, so review logs before sharing them.

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

`security --port <path>` reports read-only Secure Boot V2 eFuse evidence. `security check weatherxm --port <path>` (or `meshtastic`) verifies the candidate image structure, digest, RSA-PSS signature, signing-key digest, eligible device key, revocation state, and security-version floor. `trust.result: TRUSTED` means those image and device trust checks pass; it does not establish application bootability or installed-bootloader OTA/rollback behavior. The result's `installation.readiness` remains `BLOCKED` while those matters and complete protected-region preservation remain unverified. Firmware install attempts remain rejected before any flash operation regardless of `--yes`, `--force`, or `--recover`. `--dry-run` remains read-only and reports the proposed target plus the write-block reason. See [the safety audit](docs/firmware-write-safety-audit.md).

Security-check JSON preserves the existing top-level `result`, `trust`, and `applicationBootAndRollbackEstablished` fields. It adds `installation: { readiness, reason }`; `trust.result` now represents verified image/device trust independently of unknown bootloader configuration. The top-level `result` mirrors that trust result and does not represent write readiness.

Security JSON `keyBlocks[]` includes `readDiagnostic` for digest-purpose blocks. It reports the logical slot, physical eFuse block, register base offset, eight-word read count, and a fixed failure category/word offset when relevant. It never includes raw eFuse words. A successful signature check is separate from device key trust, and the digest remains unavailable until read-only hardware revalidation succeeds.

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

The hardware gate is read-only and does not enable firmware writes. The CLI currently blocks all installation attempts because Secure Boot trust and device anti-rollback evidence are unavailable. Automated firmware-write testing remains fixture/mock-only. Never use the release gate to run `flash`.

## License

This CLI/source is distributed under Apache-2.0. Reused WeatherXM implementation code is attributed to [WeatherXM/web-flasher](https://github.com/WeatherXM/web-flasher) at commit `35b2ecc4ccb31799ecd720609786362a99b3e33a`; see [UPSTREAM_NOTICES.md](UPSTREAM_NOTICES.md) and [LICENSE](LICENSE). Firmware manifests and images are fetched from WeatherXM's hosted catalog and official [WG1200 firmware source](https://github.com/WeatherXM/wg1200-firmware); the official [WeatherXM Web Flasher](https://flash.weatherxm.com/) and its [source repository](https://github.com/WeatherXM/web-flasher) are useful references. This independent project does not include or redistribute official firmware binaries.
