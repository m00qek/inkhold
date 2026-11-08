#!/bin/sh
# The version in build.zig.zon, and whether it is a release still to make
# (docs/content/contributor/release.md). Prints, for $GITHUB_OUTPUT:
#
#   version=1.0.0-beta.2
#   pending=true       no tag v<version> yet: this commit releases it once green
#
# Fails when the version could never be released: not 1.0.0-beta.N while the
# beta lasts, or not newer than the last release. 0.0.0 means "no release yet".
set -eu

version=$(sed -n 's/^ *\.version = "\(.*\)",$/\1/p' build.zig.zon)
echo "version=$version"

if [ "$version" = 0.0.0 ]; then
  echo "pending=false"
  exit 0
fi

# While the beta lasts, every release is 1.0.0-beta.N.
n=$(printf '%s\n' "$version" | sed -n 's/^1\.0\.0-beta\.\([1-9][0-9]*\)$/\1/p')
if [ -z "$n" ]; then
  echo "::error::build.zig.zon says $version; releases are 1.0.0-beta.N during the beta" >&2
  exit 1
fi

tags=$(git ls-remote --tags --refs origin 'v1.0.0-beta.*' | sed 's|.*refs/tags/||')
if printf '%s\n' "$tags" | grep -qx "v$version"; then
  echo "pending=false"
  exit 0
fi

last=$(printf '%s\n' "$tags" | sed -n 's/^v1\.0\.0-beta\.\([0-9]*\)$/\1/p' | sort -n | tail -n 1)
if [ -n "$last" ] && [ "$n" -le "$last" ]; then
  echo "::error::build.zig.zon says $version, but v1.0.0-beta.$last is already out" >&2
  exit 1
fi
echo "pending=true"
