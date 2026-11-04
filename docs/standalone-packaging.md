# Standalone packaging decision

## Chosen approach: Node.js SEA

The TypeScript source and firmware implementation remain unchanged. The release builder bundles the CLI into one CommonJS script with esbuild, then uses Node 26's built-in `--build-sea` command to place the bundled script and one platform-specific SerialPort `.node` addon into a single executable.

The `@serialport/bindings-cpp` package discovers native builds through `node-gyp-build`. It reads a package directory, searches `prebuilds/<platform>-<arch>`, matches prebuild tags, then calls `require()` on the chosen `.node` path. In a Bun executable, the compiled package retained its source `__dirname` and searched `/workspace/node_modules`. Explicitly embedding the Mach-O addon fixed discovery and let `SerialPort.list()` enumerate ports, but opening a port crashed in Bun's native compatibility layer at `uv_poll_init`. Bun is therefore not suitable for this SerialPort implementation.

The SEA bootstrap reads its embedded addon with `node:sea`, writes it to a private temporary directory, and loads it with `process.dlopen()`. A build-time esbuild alias replaces the package's `node-gyp-build` resolver with a tiny loader that returns those preloaded native exports. This avoids its filesystem-based prebuild lookup entirely. The temporary addon file is deleted when the executable exits; no project path or installed `node_modules` tree is used at runtime.

Each output is built on its native target runner: Ubuntu ARM64, Ubuntu x64, or macOS ARM64. This ensures the correct native addon and Node binary are paired. The macOS binary is ad-hoc signed after SEA generation.

Linux ARM64 SEA generation is pinned to Node 26.8.2. Node 26.9 through 26.13 added 4 KB-aligned load segments on official Linux ARM64 SEA outputs; those binaries fail to load on 16 KB and 64 KB page kernels even though the base Node executable runs. The release build validates every executable and SerialPort addon `PT_LOAD` for 16 KB file-offset/address congruence, checks the executable interpreter/dynamic segment, and inspects dynamic dependencies. Update this pin only after the generated SEA passes the same validation and an actual 16 KB Linux runtime test. The other target platforms continue using the same Node release pin for reproducible builds.

Release filenames identify their platform; after installation, all three are exposed under the command name `wg1200`. The executable embeds package version, build timestamp, source SHA-256, Git commit/tag, and dirty-tree status. Tagged release builds are rejected unless the checkout is clean. `wg1200 --version --verbose` reports these values alongside runtime platform and Node version.

## Packaging tests and release gate

Each target executes `--serial-binding-smoke`, which checks the addon exports its native open, close, signal, baud-rate, flush, and drain methods, then imports the SerialPort package through its embedded loader. The automated test copies the executable to a clean temporary directory and runs it without project paths or dependencies. It checks version/help, the embedded presentation formatters, and the optional installer using mocked downloads; the installer test also installs and executes the actual platform binary. If the addon is missing, cannot load, or lacks the required native methods, the executable exits non-zero and the test fails. This avoids relying on Linux's external `udevadm` utility just to validate the addon.

The optional `scripts/install-wg1200.sh` requires an explicitly configured GitHub owner/repository and release tag because the source checkout has no canonical release URL configured. It downloads only over HTTPS, verifies the requested artifact against `SHA256SUMS`, and uses a no-clobber hard-link operation to create the installed command atomically. Manual installation remains supported.

The release workflow then requires a self-hosted 16 KB Linux ARM64 runner with a WG1200 attached (configure a Raspberry Pi 5 runner with `WG1200_PORT`). It runs version/help/catalog commands, then `info --json` and `verify --json`. Device inspection enters the ROM loader and resets the gateway, but these commands do not write flash. No release is published until this hardware check passes. Firmware-write tests remain mock/fixture-only.

## Why not Bun compile

Bun's documentation recommends directly requiring `.node` files so they are embedded. This packaging path was tested. It successfully loaded the SerialPort addon for enumeration, but an actual port open crashed in the addon when it called the unsupported `uv_poll_init` function. A successful standalone CLI start or port enumeration was not sufficient to validate Bun for this application.

## References

- [Bun standalone executables and native addons](https://bun.sh/docs/bundler/executables)
- [Node.js Single Executable Applications](https://nodejs.org/api/single-executable-applications.html)
- [node-gyp-build prebuild discovery](https://github.com/prebuild/node-gyp-build)
