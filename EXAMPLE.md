# WG1200 CLI examples

These examples show how to inspect firmware slots, compare an available release, and review a proposed installation without writing flash. Replace the serial path with the one used by your system.

Install the platform artifact as `wg1200` first; see the [installation steps in README](README.md#manual-installation). The command examples below use that installed name.

## Print the version and check the executable you are running

The concise version command is offline and does not open the serial port:

```sh
wg1200 --version
wg1200 -v
```

Example:

```text
WeatherXM WG1200 Flasher v0.1.0
```

Verbose human-readable and JSON forms are available:

```sh
wg1200 --version --verbose
wg1200 --version --verbose --json
```

The metadata comes from the standalone build. OS, architecture, and runtime identify the executable's current host.

## Check the embedded build details

For a locally built macOS ARM64 executable, inspect the build details embedded in that exact file:

```sh
wg1200 --version --verbose
```

The output reports the package version, build time, and source SHA-256 embedded in that exact binary. To build the executable, use native Node.js 26 or newer on the target platform:

```sh
node --version
npm run build:standalone
```

The standalone builder uses Node's SEA builder. Bun may run the source app, but it is not a valid standalone SEA build runtime.

## Inspect both installed OTA slots

```sh
wg1200 status --port /dev/cu.usbserial-13210
```

Example output:

```text
WeatherXM WG1200 — Firmware Status
────────────────────────────────────────────────
Device          WG1200
Flash           16 MiB
OTA State       VALID
Active OTA Seq  4
OTA Records     sector 0 valid; sector 1 valid

FIRMWARE SLOTS

  ota_0    INACTIVE
           Firmware    WeatherXM v0.6.1-dirty
           Build       8d11a5d088fb…

  ota_1    ACTIVE
           Firmware    WeatherXM 0.8.34-g86b609b
           Build       cd90d5aa46a0…

NEXT INSTALLATION

  Target Slot     ota_0
  Target Offset   0x420000
  Next OTA Seq    5
```

Active/inactive labels come from OTA metadata. The next target is the slot selected by the current OTA state; it is not activated by `status`.

## Compare an available release

```sh
wg1200 check weatherxm --port /dev/cu.usbserial-13210
```

Example excerpt:

```text
DEVICE FIRMWARE

  Active Slot       ota_1
  Running Firmware  WeatherXM 0.8.34-g86b609b
  Running Build     cd90d5aa46a0…

  Inactive Slot     ota_0
  Stored Firmware   WeatherXM v0.6.1-dirty
  Stored Build      8d11a5d088fb…

AVAILABLE FIRMWARE

  Selected          WeatherXM 0.8.34-g86b609b
  Comparison        IDENTICAL

STATUS              UP TO DATE
```

The active firmware remains the reference for comparison policy. Inactive-slot contents do not change upgrade, downgrade, duplicate, or approval decisions.

## Review a dry-run

```sh
wg1200 flash weatherxm_0_6_2 \
  --port /dev/cu.usbserial-13210 \
  --dry-run
```

Example excerpt:

```text
SELECTED FIRMWARE

  Firmware          weatherxm v0.6.2-2-g8f4dca2
  Target Slot       ota_0
  Target Offset     0x420000
  Comparison        OLDER

STATUS              DOWNGRADE BLOCKED

The selected firmware is older than the currently running firmware.

TECHNICAL DETAILS
  Image SHA-256     <downloaded image SHA-256>

No flash operations performed.
```

If the selected image descriptor matches the inactive slot descriptor, the CLI adds this informational note:

```text
Selected firmware matches the build descriptor stored
in the inactive OTA slot.
```

That note does not verify byte-for-byte image integrity, activate the slot, bypass a downgrade restriction, or skip normal installation policy.

## Machine-readable output

Add `--json` to supported commands. `ota` reports validated active/inactive slots and the proposed target. `firmwareSlots.ota_0` and `.ota_1` report descriptor values and status; missing values are `null`. If OTA metadata is ambiguous, slot/target identity is left `null` rather than inferred from firmware versions.

## Standalone presentation regression check

After rebuilding the executable, run tests against that exact file:

```sh
WG1200_STANDALONE_BINARY="$PWD/dist/weatherxm-flash-macos-arm64" npm test
```

This executes the embedded status, check, and dry-run formatters from the standalone binary. It does not connect to hardware or write flash.
