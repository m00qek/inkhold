#!/bin/sh
# Commit titles follow Conventional Commits and stay under 120 characters
# (docs/content/contributor/commit-messages.md).
#
#   scripts/commit-titles.sh [RANGE]   every title in RANGE (default origin/main..HEAD)
#   scripts/commit-titles.sh FILE      the title in FILE: works as a commit-msg hook
#
# Merge commits are skipped: their titles are written by git.
set -eu

types='feat|fix|docs|ci|build|perf|refactor|test|style|chore|revert'
pattern="^($types)(\([a-z0-9._/-]+\))?!?: [^ ]"

check() {
  title=$1
  len=$(printf '%s' "$title" | wc -m)
  if ! printf '%s\n' "$title" | grep -Eq "$pattern"; then
    echo "not a Conventional Commit: $title" >&2
    return 1
  fi
  if [ "$len" -ge 120 ]; then
    echo "$len characters, the limit is 119: $title" >&2
    return 1
  fi
}

arg=${1:-origin/main..HEAD}

if [ -f "$arg" ]; then
  title=$(grep -v '^#' "$arg" | head -n 1)
  # git writes these itself (merge, fixup!, squash!); leave them alone.
  case $title in Merge\ *|fixup!\ *|squash!\ *) exit 0 ;; esac
  check "$title" || { echo "types: $types; e.g. fix(server): ..." >&2; exit 1; }
  exit 0
fi

bad=0
titles=$(git log --no-merges --format=%s "$arg")
[ -n "$titles" ] || { echo "no commits in $arg"; exit 0; }
while IFS= read -r title; do
  check "$title" || bad=$((bad + 1))
done <<EOF
$titles
EOF

if [ "$bad" -gt 0 ]; then
  echo "$bad title(s) to fix; types: $types; e.g. fix(server): ..." >&2
  exit 1
fi
echo "commit titles: $(printf '%s\n' "$titles" | wc -l) ok"
