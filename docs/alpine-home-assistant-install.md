# Alpine Linux ARM64 installation

Use `weatherxm-flash-linux-arm64-musl-v0.1.1` for Alpine Linux on ARM64,
including the Home Assistant OS Terminal & SSH add-on. The existing
`weatherxm-flash-linux-arm64` file is the glibc build for Debian and Ubuntu;
it is not compatible with Alpine's musl runtime. Both executables are single
files with their Node.js runtime and SerialPort addon embedded. The Alpine
binary requires only Alpine's musl loader and the Linux kernel at runtime.

Confirm the add-on architecture and libc:

```sh
uname -m
cat /etc/os-release
ldd --version
```

Choose the musl artifact when `uname -m` reports `aarch64` and `/etc/os-release`
identifies Alpine; `ldd --version` should identify musl. Obtain the executable
and checksum manifest from the same trusted release archive. Copy the
executable into the add-on's `/config` directory using the Home Assistant
configuration share or another trusted transfer method. From the add-on
terminal, verify it and run it directly:

```sh
cd /config
grep ' weatherxm-flash-linux-arm64-musl-v0.1.1$' SHA256SUMS | sha256sum -c
chmod 755 weatherxm-flash-linux-arm64-musl-v0.1.1
./weatherxm-flash-linux-arm64-musl-v0.1.1 --version --verbose
./weatherxm-flash-linux-arm64-musl-v0.1.1 --help
```

For a read-only gateway inspection, first confirm that the serial adapter is
visible inside the add-on, then use the actual path shown by the add-on:

```sh
ls -l /dev/ttyUSB0
./weatherxm-flash-linux-arm64-musl-v0.1.1 info --port /dev/ttyUSB0 --redact
```

The SSH add-on runs in its own container. The host's USB adapter must be
exposed to that container, and the add-on process must have permission to open
the device. A host-visible device that is not passed through to the add-on
cannot be used by the CLI. Do not install Node.js, npm, Docker, glibc
compatibility packages, `libatomic`, or `libstdc++` in the add-on for this
executable.

This installation guide does not recommend firmware-writing commands. Device
inspection enters the ESP32 ROM loader and resets the gateway during cleanup;
review the command's safety notes before connecting to a device.
