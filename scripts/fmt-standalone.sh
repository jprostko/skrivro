#!/usr/bin/env bash
# Reformat the standalone branch's skrivro.html with Vite+'s oxfmt.
#
# vp fmt needs a Vite+ workspace (package.json plus config) that only
# master has. The standalone branch is a single bare file, so vp fmt
# cannot run there. This script bridges that gap. It formats on master,
# where the workspace lives, then lands the result on standalone for a
# manual commit.
#
# Run this from a clean master tree. When it finishes you are on the
# standalone branch with the reformatted skrivro.html in place, ready
# to review and commit.

set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Working tree not clean (this script switches branches). Commit or stash first." >&2
  exit 1
fi

TMP="$(mktemp --suffix=.html)"
trap 'rm -f "$TMP"' EXIT

# Format the current standalone skrivro.html here, in the workspace. The
# result is captured in the temp file, so the branch switch cannot touch
# it.
git show standalone:skrivro.html > "$TMP"
vp fmt "$TMP"

# Land it on the standalone branch.
git checkout standalone
cp "$TMP" skrivro.html

echo
echo "Reformatted skrivro.html is in place on standalone. Review with"
echo "'git diff skrivro.html', then commit."
