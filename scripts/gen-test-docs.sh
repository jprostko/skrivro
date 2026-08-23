#!/usr/bin/env bash
# Generate synthetic AsciiDoc and Markdown documents at controlled size
# tiers, for benchmarking the editor's preview-render responsiveness.
#
# Synthetic generation (rather than a real document) buys a size knob:
# the tiers below sweep from small to pathological, so render and debounce
# behavior can be measured against document size. Each document is built
# by repeating a content unit (heading, prose, list, code block,
# admonition, table), so the renderer is exercised on real features
# rather than flat text.
#
# Also emits sync-drift-test.md, a fixed-content Markdown document that
# demonstrates the scroll-sync drift on raw-HTML blocks (the sync map
# pairs one block token to one preview element, while a raw-HTML token can
# render as several elements or none, shifting every later pairing).
# It has a control zone that syncs exactly, an HTML zone with a known
# engineered shift, and numbered markers where the drift shows, a
# before/after artifact for fixing that pairing.
#
# Output goes to test-data/ at the repo root, overwriting any previous
# run. The output is generated, not authored, and it is not part of the
# app.
#
# Usage:  scripts/gen-test-docs.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT="$REPO_ROOT/test-data"
INC="$OUT/includes"

# Tier name : content-unit count. One unit is roughly 1 KB, so the tiers
# land approximately at: small ~2 KB, medium ~30 KB, large ~275 KB,
# ridiculous ~1.5 MB. The run prints actual sizes, so adjust a count
# here if a tier drifts out of its intended range.
TIERS=(small:2 medium:30 large:250 ridiculous:1400)

# Number of included chunk files for the include-heavy AsciiDoc variant.
INCLUDE_CHUNKS=100

# --- repeated content -------------------------------------------------

PROSE="Skrivro renders the preview from the editor buffer on a debounce. \
These synthetic documents push that pipeline well past the size of \
hand-authored content, so render cost can be measured against document \
size rather than estimated."

CODE='fn render(source: &str) -> Html {
    let document = parse(source);
    document.to_html()
}'

# emit an AsciiDoc content unit ($1 = section index)
emit_adoc() {
  local n="$1"
  cat <<EOF
== Section $n — synthetic benchmark content

$PROSE

$PROSE

* First list item for section $n
* Second list item, a little longer than the first one
* Third list item for section $n

[source,rust]
----
$CODE
----

[NOTE]
====
Admonition block for section $n, exercising the admonition render path.
====

|===
| Key | Value | Note

| alpha-$n | 1 | first row
| beta-$n | 2 | second row
| gamma-$n | 3 | third row
|===

EOF
}

# emit a Markdown content unit ($1 = section index)
emit_md() {
  local n="$1"
  cat <<EOF
## Section $n — synthetic benchmark content

$PROSE

$PROSE

- First list item for section $n
- Second list item, a little longer than the first one
- Third list item for section $n

\`\`\`rust
$CODE
\`\`\`

> [!NOTE]
> Admonition block for section $n, exercising the alert render path.

| Key | Value | Note |
| --- | --- | --- |
| alpha-$n | 1 | first row |
| beta-$n | 2 | second row |
| gamma-$n | 3 | third row |

EOF
}

# --- generation -------------------------------------------------------

rm -rf "$OUT"
mkdir -p "$INC"

for tier in "${TIERS[@]}"; do
  name="${tier%%:*}"
  count="${tier##*:}"
  adoc="$OUT/$name.adoc"
  md="$OUT/$name.md"

  printf '= Synthetic benchmark document — %s tier\n\n' "$name" > "$adoc"
  printf '# Synthetic benchmark document — %s tier\n\n' "$name" > "$md"

  for ((i = 1; i <= count; i++)); do
    emit_adoc "$i" >> "$adoc"
    emit_md   "$i" >> "$md"
  done
done

# Include-heavy AsciiDoc variant: a main file that pulls in many chunk
# files, exercising the include:: expansion path specifically.
main="$OUT/include-heavy.adoc"
printf '= Synthetic benchmark document — include-heavy\n\n' > "$main"
for ((i = 1; i <= INCLUDE_CHUNKS; i++)); do
  chunk="$(printf 'chunk-%03d.adoc' "$i")"
  emit_adoc "$i" > "$INC/$chunk"
  printf 'include::includes/%s[]\n\n' "$chunk" >> "$main"
done

# --- scroll-sync drift document ----------------------------------------
# Fixed content plus a marker loop. The HTML chunks are deliberately
# blank-line-separated so each chunk is ONE markdown-it html_block token,
# a chunk of three divs renders as three top-level elements (+2 pairing
# shift each), the two-div chunk as two (+1), and the comment renders as
# zero (-1). Net shift: +6.

DRIFT_MD="$OUT/sync-drift-test.md"

cat <<'EOF' > "$DRIFT_MD"
# Scroll-sync drift test

How to use this file: open it in split mode as Markdown. Put the cursor
on a heading in the CONTROL zone and trigger sync (Ctrl+Alt+L on
Linux/Windows, Ctrl+Cmd+L on Mac, or gz in Vim normal mode). The
preview should land exactly on that heading. Then put the cursor on any
MARKER heading below the HTML zone and sync again. While the drift bug
is present, the preview lands visibly BEFORE the marker, because the
raw-HTML blocks above shifted the pairing. With the bug fixed, it lands
exactly on the marker, same as the control zone.

## Control zone

### Control A

Plain Markdown only above this line, so token-to-element pairing is
still one-to-one. Syncing from this heading should be precise.

### Control B

Second control point. Also expected to be exact, with or without the
bug.

## Drift zone

Each three-div chunk below is ONE markdown-it block token that renders
as THREE top-level elements, shifting every later pairing by two. The
two-div chunk shifts by one, and the comment is one token that renders
as ZERO elements, shifting by minus one. Net engineered drift below
this zone: +6 elements, which is exactly three markers.

<div>html block one, element a</div>
<div>html block one, element b</div>
<div>html block one, element c</div>

<div>html block two, element a</div>
<div>html block two, element b</div>
<div>html block two, element c</div>

<div>html block three, element a</div>
<div>html block three, element b</div>
<div>html block three, element c</div>

<!-- one comment block: one token, zero rendered elements -->

<div>html block four, element a</div>
<div>html block four, element b</div>

## Marker zone

EOF

for ((i = 1; i <= 12; i++)); do
  cat <<EOF >> "$DRIFT_MD"
### Marker $(printf '%02d' "$i")

Filler text so each marker occupies real vertical space. The drift is
easiest to see when neighboring markers cannot share the viewport.
Line two of filler. Line three of filler.

EOF
done

# --- summary ----------------------------------------------------------

echo "Generated under $OUT:"
wc -c "$OUT"/*.adoc "$OUT"/*.md
echo
echo "include-heavy.adoc pulls in $INCLUDE_CHUNKS chunks from includes/ ($(cat "$INC"/*.adoc | wc -c | tr -d ' ') bytes expanded)."
