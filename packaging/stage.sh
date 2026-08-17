#!/usr/bin/env bash
# stage.sh: assemble the Linux install tree for Skrivro.
#
# Gathers the release binary, desktop-integration assets, and reference
# examples into a staging tree that mirrors the final install layout
# (usr/bin, usr/share/...). Every Linux packager (PKGBUILD, deb, rpm)
# consumes this tree verbatim. None of them need to know where inputs
# live in the repo.
#
# Input roots:
#   REPO_ROOT      app-owned inputs: the binary, resources/, LICENSE,
#                  NOTICES, README.adoc. Defaults to the parent of this
#                  script's directory, i.e. the repo root.
#   <script dir>/assets
#                  desktop-integration assets: .desktop, MIME XML,
#                  AppStream metainfo.
#
# Environment overrides:
#   REPO_ROOT   as above
#   STAGE       output tree, default $REPO_ROOT/dist/stage (wiped first)
#   BIN         binary, default $REPO_ROOT/src-tauri/target/release/skrivro
#
# Naming: reverse-DNS (com.skrivro.editor) only inside shared namespaces
# (applications/, icons/hicolor/, metainfo/, mime/packages/), and the
# short package name everywhere the namespace belongs to one package
# (usr/bin, doc/, licenses/). All renaming from repo names to install names
# happens here and only here.
#
# Deliberately NOT done here:
#   - update-mime-database / update-desktop-database /
#     gtk-update-icon-cache: package-manager hooks own post-install
#     maintenance (pacman hooks, deb triggers, rpm scriptlets).
#   - stripping the binary: every packager in this directory strips its
#     own staged copy (makepkg automatically, debian/build.sh and the
#     rpm spec explicitly). stage.sh never alters its input files.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${REPO_ROOT:-"$(dirname -- "$SCRIPT_DIR")"}"
STAGE="${STAGE:-"$REPO_ROOT/dist/stage"}"
BIN="${BIN:-"$REPO_ROOT/src-tauri/target/release/skrivro"}"

PKGNAME=skrivro
APPID=com.skrivro.editor
ASSETS="$SCRIPT_DIR/assets"
RES="$REPO_ROOT/resources"
ICONS="$RES/icons"
HICOLOR="$STAGE/usr/share/icons/hicolor"

# ---- input check: report everything missing at once ------------------
missing=()
for f in \
    "$BIN" \
    "$ASSETS/applications/$APPID.desktop" \
    "$ASSETS/mime/packages/$APPID.xml" \
    "$ASSETS/metainfo/$APPID.metainfo.xml" \
    "$ICONS/32x32.png" \
    "$ICONS/64x64.png" \
    "$ICONS/128x128.png" \
    "$ICONS/128x128@2x.png" \
    "$ICONS/icon.png" \
    "$ICONS/skrivro.svg" \
    "$RES/skrivro.conf.default" \
    "$REPO_ROOT/LICENSE" \
    "$REPO_ROOT/NOTICES" \
    "$REPO_ROOT/README.adoc"
do
    [[ -e $f ]] || missing+=("$f")
done
compgen -G "$RES/themes/*.theme.default" >/dev/null \
    || missing+=("$RES/themes/*.theme.default")
command -v rsvg-convert >/dev/null \
    || missing+=("rsvg-convert (tool, renders the 48x48 icon)")

if ((${#missing[@]})); then
    printf 'stage.sh: missing input:\n' >&2
    printf '  %s\n' "${missing[@]}" >&2
    exit 1
fi

# ---- validate desktop-integration assets -----------------------------
if command -v desktop-file-validate >/dev/null; then
    desktop-file-validate "$ASSETS/applications/$APPID.desktop"
else
    echo 'stage.sh: warning: desktop-file-validate not found, skipping' >&2
fi

# appstreamcli exits nonzero on warnings. Gate on errors only, so that
# advisory warnings never block packaging. The "E:" severity prefix is
# locale-independent.
if command -v appstreamcli >/dev/null; then
    out="$(appstreamcli validate --no-net "$ASSETS/metainfo/$APPID.metainfo.xml" 2>&1)" || true
    if grep -q '^E:' <<<"$out"; then
        printf '%s\n' "$out" >&2
        exit 1
    fi
else
    echo 'stage.sh: warning: appstreamcli not found, skipping' >&2
fi

if command -v xmllint >/dev/null; then
    xmllint --noout "$ASSETS/mime/packages/$APPID.xml"
fi

# ---- assemble --------------------------------------------------------
case "$STAGE" in
    ''|/|"$HOME") echo "stage.sh: refusing STAGE='$STAGE'" >&2; exit 1 ;;
esac
rm -rf "$STAGE"
mkdir -p "$STAGE"

install -Dm755 "$BIN" "$STAGE/usr/bin/$PKGNAME"

install -Dm644 "$ASSETS/applications/$APPID.desktop" \
    "$STAGE/usr/share/applications/$APPID.desktop"
install -Dm644 "$ASSETS/mime/packages/$APPID.xml" \
    "$STAGE/usr/share/mime/packages/$APPID.xml"
install -Dm644 "$ASSETS/metainfo/$APPID.metainfo.xml" \
    "$STAGE/usr/share/metainfo/$APPID.metainfo.xml"

# Icons: the repo keeps Tauri's generated names. hicolor indexes by actual
# pixel size, so 128x128@2x (a 256px image) lands in 256x256/ and the
# 512px icon.png in 512x512/. 48x48 has no pre-rendered source and is
# rendered from the SVG master.
install -Dm644 "$ICONS/32x32.png"      "$HICOLOR/32x32/apps/$APPID.png"
install -Dm644 "$ICONS/64x64.png"      "$HICOLOR/64x64/apps/$APPID.png"
install -Dm644 "$ICONS/128x128.png"    "$HICOLOR/128x128/apps/$APPID.png"
install -Dm644 "$ICONS/128x128@2x.png" "$HICOLOR/256x256/apps/$APPID.png"
install -Dm644 "$ICONS/icon.png"       "$HICOLOR/512x512/apps/$APPID.png"
install -Dm644 "$ICONS/skrivro.svg"    "$HICOLOR/scalable/apps/$APPID.svg"

install -d "$HICOLOR/48x48/apps"
rsvg-convert --width 48 --height 48 --output "$HICOLOR/48x48/apps/$APPID.png" \
    "$ICONS/skrivro.svg"
chmod 644 "$HICOLOR/48x48/apps/$APPID.png"

# Reference examples: the .default suffix is kept deliberately. It marks
# "shipped template, copy and strip the suffix to customize" and lets
# users diff their live config against the packaged default.
install -Dm644 "$RES/skrivro.conf.default" \
    "$STAGE/usr/share/doc/$PKGNAME/examples/skrivro.conf.default"
install -Dm644 -t "$STAGE/usr/share/doc/$PKGNAME/examples/themes" \
    "$RES/themes/"*.theme.default

install -Dm644 "$REPO_ROOT/README.adoc" "$STAGE/usr/share/doc/$PKGNAME/README.adoc"
install -Dm644 "$REPO_ROOT/LICENSE"     "$STAGE/usr/share/licenses/$PKGNAME/LICENSE"
install -Dm644 "$REPO_ROOT/NOTICES"     "$STAGE/usr/share/licenses/$PKGNAME/NOTICES"

# ---- summary ---------------------------------------------------------
echo "staged in $STAGE:"
find "$STAGE" -type f | sort | sed "s|^$STAGE/|  |"
