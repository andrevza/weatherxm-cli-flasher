# v0.1.1 Alpine ARM64 build record

This v0.1.1 release candidate adds the Linux ARM64 musl executable
`weatherxm-flash-linux-arm64-musl-v0.1.1`. It does not replace or modify the
existing glibc artifact. The Alpine build is published under the pre-release
tag `v0.1.1-rc.1`; v0.1.1 has not been published as a final release.

## Build and validation

- The build uses Alpine 3.24.3 on `linux/arm64` and builds Node.js 26.8.2 from
  the upstream source archive after checking SHA-256
  `67d1e64b1c80faa8be9ee80e78b89c9aa47ddd29a62200a6b053e80b9c8d4245`.
- Node is linked partly statically, including libatomic. The SerialPort native
  addon is rebuilt from its pinned package source with the C++ runtime linked
  statically. ELF inspection showed only Alpine musl as a dynamic dependency
  for the Node runtime and addon.
- The build runs the SerialPort binding smoke check, enumerates and uses a PTY
  in an Alpine container for open/read/write/close, the complete unit/safety/standalone test suite,
  typecheck, and the regular bundle build.
- The final-stage check copies only the standalone executable into a clean
  Alpine runtime image with no added packages, inspects its dynamic libraries,
  and runs version, help, and SerialPort binding commands with an empty PATH.
- Docker ran on the ARM64 Linux VM supplied by Docker Desktop on Apple Silicon.
  This verifies an ARM64 Alpine userspace in a VM, not a Raspberry Pi or a
  physical WG1200.

The PTY exercises serial data flow and cleanup. PTYs do not provide the modem
control lines used for board reset, so DTR/RTS behavior remains unverified on
this target. No physical-device checks or flash writes were performed.

## Installation

See the [Alpine/Home Assistant installation guide](alpine-home-assistant-install.md)
for architecture/runtime identification, checksum verification, and serial
device passthrough instructions.
