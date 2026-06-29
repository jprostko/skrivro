#!/usr/bin/env bash
# Format the standalone skrivro.html in place with Vite+'s oxfmt.
# The bare standalone branch has no Vite+ workspace, so this borrows
# master's package.json and vite.config.js just long enough for vp to
# see the project and its fmt rules, formats the working-tree skrivro.html
# as it sits (committed or not), then removes the borrowed files.
# Formatting follows master's config, which stays the only place it lives.

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

if [ ! -f skrivro.html ]; then
  echo "skrivro.html not found. Run this on the standalone branch." >&2
  exit 1
fi

git show master:package.json   > package.json
git show master:vite.config.js > vite.config.js
trap 'rm -f package.json vite.config.js' EXIT
vp fmt skrivro.html
echo "Formatted skrivro.html in place. Review with git diff, then commit."
