#!/usr/bin/env bash
# build.sh: assemble a Debian package for Skrivro from the staging tree.
#
# A .deb is an ar(1) archive with exactly three members, in order:
#   debian-binary    the literal text "2.0\n"
#   control.tar.xz   ./control (+ ./md5sums), the package metadata
#   data.tar.xz      ./usr/..., the installed files
# This script builds those directly with ar + tar + xz, so it runs on any
# system (no dpkg required, this is developed on Arch). xz is used rather
# than zstd for compatibility with every dpkg still in support.
#
# The installed tree comes from stage.sh (which re-validates all inputs),
# so this stays a thin metadata wrapper. No maintainer scripts are needed:
# on Debian systems the icon cache, MIME database, and desktop database
# are rebuilt by file triggers declared by hicolor-icon-theme,
# shared-mime-info, and desktop-file-utils when our files land in their
# watched paths.
#
# The BINARY IS NOT BUILT HERE. Build it first, the same way the PKGBUILD
# does (frontend build + cargo with --features tauri/custom-protocol, or
# `vp run tauri build`), then run this. A binary built with plain
# `cargo build --release` will dial the dev server instead of working.
#
# Environment overrides:
#   REPO_ROOT   app repo root      (default: grandparent of this script)
#   OUT_DIR     output directory   (default: $REPO_ROOT/dist)
#   BIN         binary to package  (passed through to stage.sh)
#   VERSION     package version    (default: read from tauri.conf.json)
#   ARCH        Debian arch string (default: amd64)
#
# Dependency names in control.in were mapped from the binary's direct
# DT_NEEDED list to Debian package names by hand, with t64-alternations
# for the 2024 time_t transition renames, and verified with apt on
# Ubuntu 24.04 (fully resolves) and 18.04 (correctly refuses: no
# webkit2gtk-4.1 there). Re-verify only if the DT_NEEDED set changes.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(dirname -- "$SCRIPT_DIR")"
REPO_ROOT="${REPO_ROOT:-"$(dirname -- "$PKG_DIR")"}"
OUT_DIR="${OUT_DIR:-"$REPO_ROOT/dist"}"
ARCH="${ARCH:-amd64}"

if [[ -z ${VERSION:-} ]]; then
    VERSION="$(python3 -c '
import json, sys
print(json.load(open(sys.argv[1]))["version"])
' "$REPO_ROOT/src-tauri/tauri.conf.json")"
fi

WORK="$OUT_DIR/deb-work"
ROOT="$WORK/root"
CTRL="$WORK/DEBIAN"
DEB="$OUT_DIR/skrivro_${VERSION}_${ARCH}.deb"

rm -rf "$WORK"
mkdir -p "$WORK" "$CTRL"

# 1. Staging tree (stage.sh wipes and rebuilds $ROOT, validates inputs).
STAGE="$ROOT" REPO_ROOT="$REPO_ROOT" ${BIN:+BIN="$BIN"} "$PKG_DIR/stage.sh"

# Strip the staged copy (never the input): Debian Policy expects stripped
# binaries, and unlike the PKGBUILD path there is no makepkg to do it.
strip "$ROOT/usr/bin/skrivro"

# 2. Control file: substitute version/arch/size into the template.
#    Installed-Size is in KiB, per Debian Policy.
INSTALLED_SIZE="$(du -sk "$ROOT" | cut -f1)"
sed -e "s/@VERSION@/$VERSION/" \
    -e "s/@ARCH@/$ARCH/" \
    -e "s/@INSTALLED_SIZE@/$INSTALLED_SIZE/" \
    "$SCRIPT_DIR/control.in" > "$CTRL/control"

# 3. md5sums for all payload files (paths relative to /, no leading ./).
(cd "$ROOT" && find usr -type f -print0 | sort -z | xargs -0 md5sum) \
    > "$CTRL/md5sums"

# 4. The three archive members. root:root ownership and name-sorted
#    entries keep the output deterministic regardless of who builds it.
printf '2.0\n' > "$WORK/debian-binary"

tar --sort=name --owner=0 --group=0 --numeric-owner \
    -C "$CTRL" -cJf "$WORK/control.tar.xz" ./control ./md5sums

tar --sort=name --owner=0 --group=0 --numeric-owner \
    -C "$ROOT" -cJf "$WORK/data.tar.xz" ./usr

# 5. Assemble. Member order is significant. D = deterministic ar mode.
rm -f "$DEB"
ar rcD "$DEB" "$WORK/debian-binary" "$WORK/control.tar.xz" "$WORK/data.tar.xz"

# 6. Summary.
echo "built: $DEB"
ls -l "$DEB"
echo "members:"
ar t "$DEB" | sed 's/^/  /'
echo "control:"
sed 's/^/  /' "$CTRL/control"
