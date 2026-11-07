# Linux ARM64 release installation

The release archive contains only the Linux ARM64 executable, its SHA-256
manifest, the Apache-2.0 license, upstream notices, this installation guide,
and the v0.1.0 release notes. It is built from an explicit file allowlist; it
does not include source-control metadata, dependencies, backups, logs, or local
configuration.

Extract the archive, verify the binary, then install it under the `wg1200`
command name. Debian/Ubuntu Linux requires a compatible glibc/C++ runtime and
`libatomic1`. You also need permission to access the serial adapter.

```sh
tar -xzf weatherxm-flash-linux-arm64-v0.1.0.tar.gz
cd weatherxm-flash-linux-arm64-v0.1.0
sha256sum -c SHA256SUMS-v0.1.0
chmod 755 weatherxm-flash-linux-arm64-v0.1.0
sudo install -m 755 weatherxm-flash-linux-arm64-v0.1.0 /usr/local/bin/wg1200
wg1200 --version --verbose
wg1200 --help
```

Review the embedded package version, Git commit, Git tag, source SHA-256 and
clean-tree flag against the release record. Keep an existing known-good binary
until the new executable's provenance and checksum have been checked. Do not
use OTA activation, restore, staging, or any other write-capable command
unless the operation is explicitly intended and its safeguards have been
reviewed. See the command reference and safety documentation in the source
repository for current command effects.
