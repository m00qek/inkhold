#!/bin/sh
# The version in build.zig.zon, and whether it is a release still to make
# (docs/content/contributor/release.md). Prints, for $GITHUB_OUTPUT:
#
#   version=1.0.0-beta.2
#   pending=true       no tag v<version> yet: this commit releases it once green
#
# Which versions a branch may release, while the beta lasts:
#   main     1.0.0-beta.N, N one past every release so far
#   stable   1.0.0-beta.N.M, a fix of the release stable is based on
# A version that could never be released fails here, and so does a release
# with no notes in CHANGELOG.md. 0.0.0 means "no release yet". BRANCH defaults
# to the checked-out one.
set -eu

version=$(sed -n 's/^ *\.version = "\(.*\)",$/\1/p' build.zig.zon)
branch=${BRANCH:-$(git rev-parse --abbrev-ref HEAD)}
echo "version=$version"

fail() { echo "::error::$*" >&2; exit 1; }

if [ "$version" = 0.0.0 ]; then
  echo "pending=false"
  exit 0
fi

tags=$(git ls-remote --tags --refs origin 'v1.0.0-beta.*' | sed 's|.*refs/tags/||')
if printf '%s\n' "$tags" | grep -qx "v$version"; then
  echo "pending=false"
  exit 0
fi

case $branch in
  main)
    n=$(printf '%s\n' "$version" | sed -n 's/^1\.0\.0-beta\.\([1-9][0-9]*\)$/\1/p')
    [ -n "$n" ] || fail "build.zig.zon says $version; main releases 1.0.0-beta.N during the beta"
    last=$(printf '%s\n' "$tags" | sed -n 's/^v1\.0\.0-beta\.\([0-9]*\).*/\1/p' | sort -n | tail -n 1)
    if [ -n "$last" ] && [ "$n" -le "$last" ]; then
      fail "build.zig.zon says $version, but v1.0.0-beta.$last is already out"
    fi
    ;;
  stable)
    n=$(printf '%s\n' "$version" | sed -n 's/^1\.0\.0-beta\.\([1-9][0-9]*\)\.[1-9][0-9]*$/\1/p')
    m=${version##*.}
    [ -n "$n" ] || fail "build.zig.zon says $version; stable releases fixes, 1.0.0-beta.N.M"
    # The release stable is based on: the newest release tag in its history.
    base=$(git describe --tags --abbrev=0 --match 'v1.0.0-beta.*' 2>/dev/null | sed -n 's/^v1\.0\.0-beta\.\([0-9]*\).*/\1/p')
    [ "$n" = "$base" ] || fail "build.zig.zon says $version, but stable is based on 1.0.0-beta.$base"
    last=$(printf '%s\n' "$tags" | sed -n "s/^v1\.0\.0-beta\.$n\.\([0-9]*\)$/\1/p" | sort -n | tail -n 1)
    if [ -n "$last" ] && [ "$m" -le "$last" ]; then
      fail "build.zig.zon says $version, but v1.0.0-beta.$n.$last is already out"
    fi
    ;;
  *)
    fail "releases are made from main or stable, not $branch"
    ;;
esac

# Its notes: the version's section of CHANGELOG.md, which the release page
# shows. (NOTES=skip: release-prepare.sh, before the section is written.)
if [ "${NOTES:-}" != skip ]; then
  notes=$(awk -v v="$version" '/^## / { on = ($2 == v); next } on && NF' CHANGELOG.md 2>/dev/null || true)
  [ -n "$notes" ] || fail "CHANGELOG.md has no notes under '## $version': write them before releasing"
fi
echo "pending=true"
