#!/usr/bin/env bash
# build.sh: build the Skrivro RPM from skrivro.spec + the staging tree.
#
# Thin rpmbuild driver: resolves paths and the version, then hands
# everything to the spec as macros. See skrivro.spec for the packaging
# policy (auto-generated soname Requires, no scriptlets, no debuginfo).
#
# The BINARY IS NOT BUILT HERE, same rule as the deb: build it first
# with --features tauri/custom-protocol (or `vp run tauri build`).
#
# Environment overrides:
#   REPO_ROOT   app repo root      (default: grandparent of this script)
#   OUT_DIR     output directory   (default: $REPO_ROOT/dist)
#   BIN         binary to package  (passed through to stage.sh)
#   VERSION     package version    (default: read from tauri.conf.json)

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(dirname -- "$SCRIPT_DIR")"
REPO_ROOT="${REPO_ROOT:-"$(dirname -- "$PKG_DIR")"}"
OUT_DIR="${OUT_DIR:-"$REPO_ROOT/dist"}"

if [[ -z ${VERSION:-} ]]; then
    VERSION="$(python3 -c '
import json, sys
print(json.load(open(sys.argv[1]))["version"])
' "$REPO_ROOT/src-tauri/tauri.conf.json")"
fi

WORK="$OUT_DIR/rpm-work"
rm -rf "$WORK"
mkdir -p "$WORK" "$OUT_DIR"

rpmbuild -bb \
    --define "_topdir $WORK" \
    --define "_rpmdir $OUT_DIR" \
    --define "_rpmfilename %%{name}-%%{version}-%%{release}.%%{arch}.rpm" \
    --define "pkgver $VERSION" \
    --define "repo_root $REPO_ROOT" \
    --define "pkg_dir $PKG_DIR" \
    ${BIN:+--define "app_bin $BIN"} \
    "$SCRIPT_DIR/skrivro.spec"

echo "built: $OUT_DIR/skrivro-$VERSION-1.x86_64.rpm"
