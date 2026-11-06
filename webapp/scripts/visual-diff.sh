#!/bin/sh
# Compares two screenshot sets taken by `VISUAL_DIR=<dir> npx playwright test visual`:
# prints each screen whose pixels differ, and writes a diff image beside it.
# Two identical runs still differ by a pixel or two of anti-aliasing (the avatar's
# circle), so a 2% colour fuzz and up to NOISE pixels count as the same; a real
# layout change moves thousands.
# Usage: scripts/visual-diff.sh <before-dir> <after-dir>
set -u
NOISE=${NOISE:-10}
before=$1
after=$2
changed=0
for a in "$before"/*.png; do
  name=$(basename "$a")
  b="$after/$name"
  if [ ! -f "$b" ]; then echo "missing: $name"; changed=1; continue; fi
  n=$(magick compare -metric AE -fuzz 2% "$a" "$b" "$after/diff-$name" 2>&1 >/dev/null | cut -d' ' -f1)
  if awk -v n="$n" -v max="$NOISE" 'BEGIN { exit !(n > max) }'; then
    echo "differs: $name ($n pixels)"
    changed=1
  else
    rm -f "$after/diff-$name"
  fi
done
[ "$changed" = 0 ] && echo "identical: every screen"
exit "$changed"
