#!/usr/bin/env bash
# Points package.nix at a release: its version and the four builds' hashes,
# read from the release's SHA256SUMS.
#   contrib/nixos/update.sh 1.0.0-beta.3
set -euo pipefail

version=${1:?usage: update.sh <version>}
pkg=$(dirname "$0")/package.nix
sums=$(curl -fsSL "https://github.com/m00qek/inkhold/releases/download/v$version/SHA256SUMS")

sed -i "s|version = \"[^\"]*\";|version = \"$version\";|" "$pkg"
for target in x86_64-linux-musl aarch64-linux-musl arm-linux-musleabihf x86-linux-musl; do
  hex=$(awk -v f="inkhold-$target.tar.gz" '$2 == f { print $1 }' <<<"$sums")
  [ -n "$hex" ] || { echo "update.sh: no $target in SHA256SUMS" >&2; exit 1; }
  sri=$(nix hash convert --hash-algo sha256 --to sri "$hex")
  # The hash line follows its target's line.
  sed -i "/target = \"$target\";/{n;s|hash = \"[^\"]*\";|hash = \"$sri\";|}" "$pkg"
done
echo "package.nix now at $version"
