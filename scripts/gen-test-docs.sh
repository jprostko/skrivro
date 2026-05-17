#!/usr/bin/env bash
# Generate synthetic AsciiDoc and Markdown documents at controlled size
# tiers, for benchmarking the editor's preview-render responsiveness.
#
# Synthetic generation (rather than a real document) buys a size knob:
# the tiers below sweep from small to pathological, so render and debounce
# behavior can be measured against document size. Each document is built
# by repeating a content unit — heading, prose, list, code block,
# admonition, table — so the renderer is exercised on real features
# rather than flat text.
#
# Output goes to test-data/ at the repo root, overwriting any previous
# run. The output is generated, not authored — it is not part of the app.
#
# Usage:  scripts/gen-test-docs.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT="$REPO_ROOT/test-data"
INC="$OUT/includes"

# Tier name : content-unit count. One unit is roughly 1 KB, so the tiers
# land approximately at: small ~2 KB, medium ~30 KB, large ~275 KB,
# ridiculous ~1.5 MB. The run prints actual sizes — adjust a count here
# if a tier drifts out of its intended range.
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

# emit one AsciiDoc content unit; $1 = section index
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

# emit one Markdown content unit; $1 = section index
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

# --- summary ----------------------------------------------------------

echo "Generated under $OUT:"
wc -c "$OUT"/*.adoc "$OUT"/*.md
echo
echo "include-heavy.adoc pulls in $INCLUDE_CHUNKS chunks from includes/ ($(cat "$INC"/*.adoc | wc -c | tr -d ' ') bytes expanded)."
