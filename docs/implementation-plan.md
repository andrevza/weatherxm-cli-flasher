# WG1200 CLI implementation plan

This plan follows the source analysis in [official-flasher-analysis.md](official-flasher-analysis.md). Read-only implementation and source-to-code review were completed before the mocked OTA write path was added. No real device writes were performed.

## Phase 1: CLI foundation and shared rules — complete

1. Add a root Node.js TypeScript package with `info`, `verify`, `firmware list`, and `status` command routing, JSON output, structured nonzero error exits, and serial path/baud options.
2. Reuse the official pure TS modules for constants, partition parsing, identity, manifest/image validation, OTA metadata, app descriptors, hashing, and write guards. Preserve attribution and Apache-2.0 terms. Avoid importing browser UI/controller code.
3. Add a Node serial adapter for esptool-js, mapping a native serial library to the serial interface esptool-js expects. Keep ROM baud at 115200 and allow configured flash baud, defaulting to 115200 to match WG1200 behavior.
4. Make port opening explicit by path (e.g. `/dev/ttyUSB0`). Document Linux dialout permissions, Raspberry Pi ARM64 setup, and Home Assistant container/device passthrough.

## Phase 2: Read-only inspection — complete

1. Implement one `inspectDevice()` operation that opens the selected device, enters the ESP32-S3 ROM loader/stub, reads the same identity/layout/OTA/app regions as upstream, and always closes/reboots cleanly on completion or failure.
2. Tighten layout validation: require exact mandatory entries and expected attributes; reject missing/invalid table MD5, duplicates, overlaps, out-of-flash ranges, and unexpected entries. Derive offsets only after full validation.
3. Implement `info`, `verify`, and `status` as projections of that inspection result. Command handlers call inspection only; the CLI tests assert that guarded write APIs reject unsafe target ranges before a loader write.
4. Implement `firmware list` against the official manifest URL with strict schema, URL, size, hash, and secure-boot metadata validation. It does not connect to a device.
5. Add generated and official partition-table fixtures, manifest/image and OTA metadata fixtures, and mocked loader writes. Reused upstream tests continue to cover certificate and app descriptor parsers in the reference checkout.

## Phase 3: Write-path implementation — implemented; hardware use untested

1. Add `flash <firmware-key>` behind explicit confirmation and a second clear review of device identity, exact validated layout, inactive slot, firmware version/size/hash, and the exact write ranges. Non-interactive use must require a dedicated `--yes` flag and must not imply confirmation by default.
2. Download and validate the image before any write; require exact bytes, <=4 MiB, final signature marker, and manifest SHA-256. Resolve signature authenticity questions before claiming cryptographic Secure Boot verification.
3. Re-inspect immediately before mutation; snapshot the upstream credential/table/NVS regions. The write guard excludes all protected ranges, including calibration and SPIFFS, plus factory and the active app slot. Write one image only to the table-derived inactive OTA partition with `eraseAll: false`.
4. Verify on-chip MD5, write only the inactive 4 KiB OTA metadata sector using the official sequence/state/CRC method, and read it back.
5. Re-read/compare protected regions, report any read or integrity failure distinctly, reset to application mode, and report boot logs without treating log heuristics as proof of successful boot.
6. Add failure-injection tests for application MD5 mismatch, metadata write/readback failure, and protected-region mismatch. All write-path tests use mocked operations; no real hardware write tests.

## Phase 4: Packaging and docs — complete

1. Add a minimal multi-architecture Dockerfile targeting Linux ARM64 and AMD64, with a non-root runtime and serial device passthrough examples.
2. Document commands, safe read-only operation, exact partition map, firmware trust model, confirmation behavior, recovery/error meanings, Raspberry Pi/Home Assistant usage, and the fact that inspection enters ROM loader mode and reboots the gateway.
3. Validate `npm test`, typecheck/build, Docker build for supported architectures, and CLI help/list behavior. Keep all device integration tests mocked.

## Exit gates

- No mutation path exists in Phase 2 command implementations.
- Read-only tests establish strict WG1200 identity/layout before returning a valid device.
- Before Phase 3, reviewed code path and parity tests establish target selection, erase behavior, metadata encoding, and cleanup behavior against upstream source.
- The CLI never exposes full-chip erase or full-flash restore.
