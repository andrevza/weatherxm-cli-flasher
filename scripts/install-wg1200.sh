#!/bin/sh
set -eu

fail() {
  printf 'wg1200 installer: %s\n' "$*" >&2
  exit 1
}

repo=${WG1200_GITHUB_REPOSITORY:-}
tag=${WG1200_RELEASE_TAG:-}
install_dir=${WG1200_INSTALL_DIR:-/usr/local/bin}

[ -n "$repo" ] || fail 'set WG1200_GITHUB_REPOSITORY to the trusted GitHub owner/repository (for example, owner/project)'
[ -n "$tag" ] || fail 'set WG1200_RELEASE_TAG to the release tag (for example, v1.2.3)'

case "$repo" in
  */*) owner=${repo%%/*}; project=${repo#*/} ;;
  *) fail 'WG1200_GITHUB_REPOSITORY must be owner/repository' ;;
esac
case "$owner$project" in
  ''|*[!A-Za-z0-9._-]*) fail 'WG1200_GITHUB_REPOSITORY may contain only letters, digits, dots, underscores and hyphens' ;;
esac
case "$project" in
  */*) fail 'WG1200_GITHUB_REPOSITORY must contain exactly one slash' ;;
esac
case "$tag" in
  ''|*[!A-Za-z0-9._-]*) fail 'WG1200_RELEASE_TAG may contain only letters, digits, dots, underscores and hyphens' ;;
esac

os=$(uname -s)
arch=$(uname -m)
case "$os:$arch" in
  Darwin:arm64|Darwin:aarch64) artifact=weatherxm-flash-macos-arm64 ;;
  Linux:arm64|Linux:aarch64) artifact=weatherxm-flash-linux-arm64 ;;
  Linux:x86_64|Linux:amd64) artifact=weatherxm-flash-linux-x64 ;;
  *) fail "unsupported platform: $os/$arch (supported: macOS ARM64, Linux ARM64, Linux x64)" ;;
esac

command -v curl >/dev/null 2>&1 || fail 'curl is required to download the release'
if command -v shasum >/dev/null 2>&1; then
  checksum_tool=shasum
elif command -v sha256sum >/dev/null 2>&1; then
  checksum_tool=sha256sum
else
  fail 'shasum or sha256sum is required to verify the release'
fi

target=$install_dir/wg1200
if [ -e "$target" ] || [ -L "$target" ]; then
  fail "$target already exists; remove or move it yourself before installing an upgrade"
fi

case "$install_dir" in
  /*) ;;
  *) install_dir=$PWD/$install_dir; target=$install_dir/wg1200 ;;
esac
mkdir -p "$install_dir" || fail "cannot create installation directory: $install_dir"
stage=$(mktemp -d "$install_dir/.wg1200-install.XXXXXX") || fail "cannot create temporary staging directory in $install_dir"
trap 'rm -rf "$stage"' EXIT HUP INT TERM

base_url="https://github.com/$repo/releases/download/$tag"
curl --fail --location --silent --show-error --proto '=https' --proto-redir '=https' --tlsv1.2 \
  --output "$stage/SHA256SUMS" "$base_url/SHA256SUMS" || fail 'could not download release checksums over HTTPS'
curl --fail --location --silent --show-error --proto '=https' --proto-redir '=https' --tlsv1.2 \
  --output "$stage/$artifact" "$base_url/$artifact" || fail "could not download $artifact over HTTPS"

awk -v file="$artifact" '$2 == file { print $1 "  " $2; count++ } END { if (count != 1) exit 1 }' \
  "$stage/SHA256SUMS" > "$stage/expected-checksum" || fail "SHA256SUMS must contain exactly one checksum for $artifact"
if [ "$checksum_tool" = shasum ]; then
  (cd "$stage" && shasum -a 256 -c expected-checksum) || fail 'downloaded file failed SHA-256 verification'
else
  (cd "$stage" && sha256sum -c expected-checksum) || fail 'downloaded file failed SHA-256 verification'
fi

chmod 755 "$stage/$artifact" || fail 'could not mark the verified executable as executable'
ln "$stage/$artifact" "$target" || fail "$target appeared during installation or could not be created; existing files are never overwritten"
printf 'Installed verified wg1200 command at %s\n' "$target"
printf 'Check it with: %s --version --verbose\n' "$target"
