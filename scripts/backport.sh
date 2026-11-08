#!/bin/sh
# Copies a commit already on main onto `stable` and pushes it
# (docs/content/contributor/release.md). A docs fix then reaches the site's
# root; a code fix waits there for a fix release (`make release` on stable).
#
#   scripts/backport.sh COMMIT
#
# Works in a temporary worktree: the current checkout is never touched.
set -eu

commit=${1:?usage: scripts/backport.sh COMMIT}
fail() { echo "backport: $*" >&2; exit 1; }

git fetch -q origin main
git fetch -q origin stable 2>/dev/null || fail "there is no stable branch yet: the first promotion creates it"
git merge-base --is-ancestor "$commit" origin/main || fail "$commit is not on main: fix main first, then backport"

dir=$(mktemp -d)
trap 'git worktree remove --force "$dir" >/dev/null 2>&1 || true; rm -rf "$dir"' EXIT
git worktree add -q --detach "$dir" origin/stable

cd "$dir"
# -x records where it came from: "(cherry picked from commit ...)".
git cherry-pick -x "$commit" || fail "$commit does not apply to stable cleanly; resolve it by hand"
git push -q origin HEAD:stable
echo "backported $(git log -1 --format='%h %s') to stable"
