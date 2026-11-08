#!/bin/sh
# Prepares a release commit on the checked-out branch
# (docs/content/contributor/release.md):
#
#   scripts/release-prepare.sh VERSION
#
# Sets .version in build.zig.zon, refusing a version this branch could never
# release; adds VERSION's section to CHANGELOG.md; and prints the commits since
# the last release, by type, to write it from. Commits nothing.
set -eu

version=${1:?usage: scripts/release-prepare.sh 1.0.0-beta.N}
fail() { echo "release: $*" >&2; exit 1; }
[ -z "$(git status --porcelain build.zig.zon CHANGELOG.md)" ] || fail "build.zig.zon or CHANGELOG.md has changes; commit or drop them first"

old=$(sed -n 's/^ *\.version = "\(.*\)",$/\1/p' build.zig.zon)
sed -i "s/^\( *\.version = \)\"$old\",\$/\1\"$version\",/" build.zig.zon
# The branch's rules, but not the notes check: the section is written next.
if ! status=$(NOTES=skip scripts/release-version.sh); then
  git checkout -q -- build.zig.zon
  exit 1
fi
printf '%s\n' "$status" | grep -qx "pending=true" || { git checkout -q -- build.zig.zon; fail "$version is already released"; }

# The section, newest first, under the file's header.
if ! grep -q "^## $version\b" CHANGELOG.md; then
  awk -v h="## $version ($(date -u +%Y-%m-%d))" '
    !done && /^## / { print h "\n"; done = 1 }
    { print }
    END { if (!done) print "\n" h }' CHANGELOG.md > CHANGELOG.md.new && mv CHANGELOG.md.new CHANGELOG.md
fi

last=$(git describe --tags --abbrev=0 --match 'v1.0.0-beta.*' 2>/dev/null || true)
range=${last:+$last..}HEAD
echo "build.zig.zon: $old -> $version"
echo "CHANGELOG.md: write the '## $version' section, for the people who run Inkhold."
echo
echo "Commits since ${last:-the beginning}, by type:"
for type in feat fix perf refactor build docs test ci style chore revert; do
  lines=$(git log --no-merges --format='%s' "$range" | grep -E "^$type(\([^)]*\))?!?: " || true)
  [ -n "$lines" ] || continue
  echo
  echo "$type:"
  printf '%s\n' "$lines" | sed 's/^/  /'
done
echo
echo "Then: git commit -am 'chore(release): $version' and push."
