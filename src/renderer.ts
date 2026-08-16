// ================= Renderer =================
// Source-to-HTML rendering interface and the AsciiDoc implementation.
// Isolates the markup-specific work (parsing, sanitizing, building the
// source-line → DOM-element map for scroll sync) behind a Renderer
// interface that preview.ts calls uniformly regardless of the active
// markup format.
//
// Three implementations live here: AsciidoctorRenderer,
// markdownRenderer, and textRenderer, with getRenderer at the bottom
// dispatching on the buffer's format field.

import DOMPurify from "dompurify";

import { readTextFile } from "@tauri-apps/plugin-fs";
import { basename, dirname, resolve } from "@tauri-apps/api/path";

import { userConfig } from "./config.js";
import { perfLog } from "./perf.js";
import type { Format } from "./io.js";
import type { WorkerRenderRequest, WorkerRenderResponse } from "./render-worker.js";

// ================= Public interface =================

// One entry per mapped preview element. `line` is the source line
// number that produced `el`, 1-indexed. For AsciiDoc this refers to
// the FLATTENED source (post-include-expansion), and translation
// from editor-source coordinates to flat-source coordinates is done
// via RenderResult.translateEditorLine so callers never have to
// know.
export interface BlockMapEntry {
  line: number;
  el: Element;
}

// Per-render context supplied by the caller. `path` is the absolute
// file path of the current buffer, or null for an untitled buffer.
// Renderers use it to resolve relative references (AsciiDoc include
// targets, eventual future uses for image-path resolution, etc.).
export interface RenderContext {
  path: string | null;
}

// Result of a single render. `fragment` is a DocumentFragment of the
// already-sanitized rendered nodes, ready to move straight into the
// preview container, with no HTML re-parse on the caller's side. The
// two callbacks close over per-render state: `buildBlockMap` walks
// the rendered output in the caller's container to produce the
// scroll-sync map, and `translateEditorLine` converts an
// editor-source line number into whatever coordinate system the
// returned BlockMapEntry.line values use (identity for renderers
// that don't transform source, include-line-map-aware for AsciiDoc).
export interface RenderResult {
  fragment: DocumentFragment;
  buildBlockMap: (rootElement: Element) => BlockMapEntry[];
  translateEditorLine: (editorLine: number) => number;
  // Asciidoctor's `:toc:` source attribute, surfaced so the
  // sidebar layout in ui.ts can decide whether to activate the
  // grid layout for the current doc. Values: 'left', 'right',
  // 'auto', 'macro', 'preamble', 'content', or null (no `:toc:`
  // set). Embedded-mode HTML doesn't carry classes that
  // distinguish the sidebar variants, so the position has to come
  // from the doc attribute. null for renderers that don't have an
  // analog (markdown, text).
  tocPosition: string | null;
}

// The abstraction preview.ts consumes. Every concrete markup format
// implements this. `clearCache` is a no-op for renderers without a
// per-path cache, while AsciidoctorRenderer uses it to invalidate
// the include-file cache on buffer change / reload.
export interface Renderer {
  render(source: string, context: RenderContext): Promise<RenderResult>;
  clearCache(): void;
}

// ================= Asciidoctor include preprocessing =================
//
// Must run BEFORE Asciidoctor sees the source. Asciidoctor.js's
// browser-side include reader uses synchronous XMLHttpRequest against
// the current page URL. In our Tauri webview the page URL is our own
// index.html, served via Tauri's asset protocol, which has SPA-style
// fallback: any unresolved path returns index.html with a 200 status.
// The result is that every `include::` directive silently "resolves"
// to our own built HTML, which Asciidoctor parses as AsciiDoc content
// and splices into the preview.
//
// Fix: we read each include target directly via Tauri's readTextFile
// (which goes through the actual filesystem, not through the SPA-
// fallback trap), apply any include attributes (lines=, tag=, tags=,
// indent=, leveloffset=), and splice the resolved content inline.
// By the time Asciidoctor sees the source there are no include::
// directives left, so its broken browser include reader never runs.

// Absolute file path (string) → raw file content (string). The
// explicit `Map<string, string>` annotation prevents TS from
// inferring `Map<any, any>` under strict mode. Persists across
// renders so editing the root document in a 100-chapter book
// doesn't trigger 100 disk reads per keystroke. Invalidated
// via asciidoctorRenderer.clearCache() on buffer change / reload.
let includeCache = new Map<string, string>();

// Parse the attributes inside `include::target[attrs]` into a keyed
// object. Positional attributes (values without `=`) are ignored:
// the AsciiDoc include directive doesn't use positional attrs.
//
// Return type is Record<string, string>: all keys are strings, all
// values are strings. TS's Record doesn't model "key might be absent
// at runtime", so attrs.leveloffset is typed as string even when the
// raw didn't include that key, so downstream `if (attrs.leveloffset)`
// truthiness checks still do the right runtime work while TS's
// narrowing accepts them.
export const parseIncludeAttrs = (raw: string): Record<string, string> => {
  const attrs: Record<string, string> = {};
  if (!raw) return attrs;
  for (const part of raw.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    attrs[key] = val;
  }
  return attrs;
};

// Apply include-attribute filters to the target file's content.
// Handles lines=, tag=/tags=, and indent=. (leveloffset= is applied
// later by the caller since it needs to wrap the recursively-expanded
// content, not the raw pre-expansion content.)
export const applyIncludeAttrs = (content: string, attrs: Record<string, string>): string => {
  // lines=N..M or lines=N..M;X..Y: keep specified 1-indexed ranges.
  // Open-ended ranges like `lines=5..` mean "from line 5 to end".
  if (attrs.lines) {
    const lines = content.split("\n");
    const kept = [];
    for (const range of attrs.lines.split(";")) {
      const dotdot = range.indexOf("..");
      let from, to;
      if (dotdot === -1) {
        from = to = parseInt(range, 10);
      } else {
        from = parseInt(range.slice(0, dotdot), 10);
        const toStr = range.slice(dotdot + 2);
        to = toStr === "" ? lines.length : parseInt(toStr, 10);
      }
      if (Number.isNaN(from) || Number.isNaN(to)) continue;
      for (let i = from; i <= to && i <= lines.length; i++) {
        if (i >= 1) kept.push(lines[i - 1]);
      }
    }
    content = kept.join("\n");
  }
  // tag=name or tags=n1;n2: keep only lines inside matching tag
  // regions, marked by `// tag::NAME[]` and `// end::NAME[]` comment
  // lines. Tag delimiter lines themselves are stripped from the output.
  if (attrs.tag || attrs.tags) {
    const wanted = new Set();
    if (attrs.tag) wanted.add(attrs.tag);
    if (attrs.tags) {
      for (const t of attrs.tags.split(/[;,]/)) {
        const n = t.trim();
        if (n) wanted.add(n);
      }
    }
    const lines = content.split("\n");
    const kept = [];
    const active = new Set();
    const startRe = /\/\/\s*tag::([a-zA-Z0-9_.-]+)\[\]/;
    const endRe = /\/\/\s*end::([a-zA-Z0-9_.-]+)\[\]/;
    for (const line of lines) {
      const sm = line.match(startRe);
      const em = line.match(endRe);
      if (sm) {
        if (wanted.has(sm[1])) active.add(sm[1]);
      } else if (em) {
        active.delete(em[1]);
      } else if (active.size > 0) {
        kept.push(line);
      }
    }
    content = kept.join("\n");
  }
  // indent=N: normalize leading indent to exactly N spaces. Finds
  // the minimum indent across non-blank lines, strips it, then
  // prefixes N spaces. Blank lines are left untouched.
  if (attrs.indent !== undefined) {
    const target = parseInt(attrs.indent, 10) || 0;
    const lines = content.split("\n");
    let minIndent = Infinity;
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      const m = line.match(/^( *)/);
      // `m[1]!`: required capture group, always present when match
      // succeeds. Non-null assertion satisfies noUncheckedIndexedAccess.
      if (m) minIndent = Math.min(minIndent, m[1]!.length);
    }
    if (!isFinite(minIndent)) minIndent = 0;
    const pad = " ".repeat(target);
    content = lines.map((l) => (l.trim().length === 0 ? l : pad + l.slice(minIndent))).join("\n");
  }
  return content;
};

// Expand a single `include::target[attrs]` directive. Reads the
// target file (from cache if present), applies attribute filters,
// recursively expands any nested includes, and wraps the content
// in :leveloffset: directives if the include specifies one. On any
// error (missing file, permission denied, cycle), returns a visible
// comment-style placeholder rather than throwing, since a broken
// include shouldn't crash the render, it should just show
// "Unresolved include" where the content would have been.
const expandOneInclude = async (
  target: string,
  attrsRaw: string,
  baseDir: string,
  cycle: Set<string>,
): Promise<string> => {
  try {
    const resolvedPath = await resolve(baseDir, target);
    if (cycle.has(resolvedPath)) {
      return `// Unresolved include (cycle): ${target}`;
    }
    let content = includeCache.get(resolvedPath);
    if (content === undefined) {
      content = await readTextFile(resolvedPath);
      includeCache.set(resolvedPath, content);
    }
    const attrs = parseIncludeAttrs(attrsRaw);
    content = applyIncludeAttrs(content, attrs);
    // Nested expansion: resolve nested include paths against the
    // INCLUDING file's directory (not the root document's). Use a
    // fresh Set per branch so sibling branches don't interfere with
    // each other's cycle detection.
    const nestedBase = await dirname(resolvedPath);
    const nestedCycle = new Set(cycle).add(resolvedPath);
    content = await expandRecursively(content, nestedBase, nestedCycle);
    // leveloffset wrapping: emit `:leveloffset: +N` before and an
    // inverse `:leveloffset: -N` after, so Asciidoctor re-levels
    // headings inside the expanded content at parse time. We don't
    // rewrite heading tokens ourselves, since Asciidoctor's
    // built-in leveloffset handling is the right tool for this.
    if (attrs.leveloffset) {
      const lo = attrs.leveloffset;
      let sign, invSign, mag;
      if (lo.startsWith("+")) {
        sign = "+";
        invSign = "-";
        mag = lo.slice(1);
      } else if (lo.startsWith("-")) {
        sign = "-";
        invSign = "+";
        mag = lo.slice(1);
      } else {
        sign = "+";
        invSign = "-";
        mag = lo;
      }
      content = `\n:leveloffset: ${sign}${mag}\n\n${content}\n\n:leveloffset: ${invSign}${mag}\n`;
    }
    return content;
  } catch (e) {
    // Catch variable is `unknown` under strict mode's
    // useUnknownInCatchVariables. Narrow to extract a displayable
    // message rather than accessing .message on unknown.
    const msg = e instanceof Error ? e.message : String(e);
    return `// Unresolved include: ${target} (${msg})`;
  }
};

// Expand include directives inside content that itself came from an
// expanded include. This variant does NOT build a line map, since
// nested includes are invisible to the editor's cursor position, so
// their internal line coordinates aren't needed for scroll sync.
const expandRecursively = async (
  source: string,
  baseDir: string,
  cycle: Set<string>,
): Promise<string> => {
  const includeRe = /^include::([^[\n]+)\[([^\]]*)\]\s*$/;
  const lines = source.split("\n");
  const out = [];
  for (const line of lines) {
    const m = line.match(includeRe);
    if (m) {
      // `m[1]!` is the target path (required capture group in
      // includeRe), and `m[2]` is the attribute blob which has default
      // empty-string semantics via the `[^\]]*` match: undefined
      // would mean the match failed, but we just guarded against that.
      out.push(await expandOneInclude(m[1]!.trim(), m[2]!, baseDir, cycle));
    } else {
      out.push(line);
    }
  }
  return out.join("\n");
};

// Top-level include preprocessing. Walks the editor's root source
// line-by-line, expanding any include:: directives and building an
// editor-line → flat-line mapping for scroll sync.
//
// Returns { source, lineMap } where:
//   source:  flattened source ready for Asciidoctor
//   lineMap: array, lineMap[editorLine - 1] = flatLine (1-indexed)
//
// For non-include root lines, the mapping is 1:1 adjusted by the
// cumulative offset from preceding expansions. For include lines,
// the mapping points to the FIRST line of expanded content, so
// scroll-syncing on an `include::chapter-05/content.adoc[]` line
// jumps the preview to the top of chapter 5.
export const preprocessSource = async (
  rootSource: string,
  baseDir: string,
): Promise<{ source: string; lineMap: number[] }> => {
  const includeRe = /^include::([^[\n]+)\[([^\]]*)\]\s*$/;
  // split('\n') on a string ending with '\n' produces a trailing
  // empty element. That's not a real line of content, it's the
  // representation of "the source ends with a newline." Drop it so
  // we don't emit a spurious blank line at the very end of the
  // flattened output.
  let rootLines = rootSource.split("\n");
  if (rootSource.endsWith("\n") && rootLines.length > 0 && rootLines[rootLines.length - 1] === "") {
    rootLines = rootLines.slice(0, -1);
  }

  const parts = [];
  const lineMap = new Array(rootLines.length);
  let flatLine = 1;

  for (let i = 0; i < rootLines.length; i++) {
    // `rootLines[i]!`: the loop bound i < rootLines.length makes
    // index access safe at runtime, but noUncheckedIndexedAccess
    // can't narrow based on loop bounds.
    const line = rootLines[i]!;
    const m = line.match(includeRe);
    if (m) {
      lineMap[i] = flatLine;
      let expanded = await expandOneInclude(m[1]!.trim(), m[2]!, baseDir, new Set());
      if (expanded.length > 0) {
        // Normalize to always end with exactly one newline so the
        // next root line starts on a fresh flat line, and line
        // counting stays consistent.
        if (!expanded.endsWith("\n")) expanded += "\n";
        parts.push(expanded);
        // With the trailing '\n' guarantee, the number of flat
        // lines in the expansion is (newlines), since each
        // '\n' terminates exactly one line.
        flatLine += expanded.split("\n").length - 1;
      }
      // Empty expansion: consume the root include line but don't
      // advance flatLine. The next root line's lineMap entry points
      // to the same flatLine, which correctly represents "the
      // empty include collapsed."
    } else {
      lineMap[i] = flatLine;
      parts.push(line);
      parts.push("\n");
      flatLine++;
    }
  }

  // Rejoin and restore trailing-newline state of the root source.
  // If the root didn't end with '\n', strip the one we appended to
  // the last line.
  let flat = parts.join("");
  if (!rootSource.endsWith("\n") && flat.endsWith("\n")) {
    flat = flat.slice(0, -1);
  }
  return { source: flat, lineMap };
};

// ================= Block-map pairing =================
//
// The render worker walks the parsed AST / token tree and returns a
// per-block source-line list (one entry per mappable block, in
// document order). These helpers pair that list against the rendered
// DOM on the main thread to produce the scroll-sync BlockMapEntry[].

// CSS selector matching the DOM elements Asciidoctor emits for those
// block contexts. Order in the selector doesn't matter: querySelectorAll
// returns matches in document order regardless.
const DOM_BLOCK_SELECTOR = [
  ".paragraph",
  ".listingblock",
  ".literalblock",
  ".exampleblock",
  ".sidebarblock",
  ".admonitionblock",
  ".quoteblock",
  ".verseblock",
  ".imageblock",
  ".ulist",
  ".olist",
  ".dlist",
  ".sect1",
  ".sect2",
  ".sect3",
  ".sect4",
  ".sect5",
  ".openblock",
  "table.tableblock",
].join(", ");

// Pair the worker's AsciiDoc block-line list against the rendered
// DOM. blockLines[i] is the source line of the i-th mappable block in
// document order, and querySelectorAll returns the matching elements
// in the same order, so domEls[i] is that block's element. A
// blockLines entry of 0 marks a block with no usable source location:
// the index still advances so the alignment holds, the entry is just
// skipped.
export const pairAsciidoctorBlockMap = (
  blockLines: number[],
  rootElement: Element,
): BlockMapEntry[] => {
  try {
    const domEls = Array.from(rootElement.querySelectorAll(DOM_BLOCK_SELECTOR));
    const map: BlockMapEntry[] = [];
    const n = Math.min(blockLines.length, domEls.length);
    for (let i = 0; i < n; i++) {
      const line = blockLines[i]!;
      if (line > 0) map.push({ line, el: domEls[i]! });
    }
    map.sort((a, b) => a.line - b.line);
    return map;
  } catch (e) {
    console.error("pairAsciidoctorBlockMap failed:", e);
    return [];
  }
};

// Pair the worker's Markdown block-line list against the rendered
// DOM. The worker emits one entry per visible top-level token, in
// order, and rootElement.children are the rendered top-level
// elements. Min guards a future divergence from the 1:1
// token-to-element invariant, so sync degrades silently rather
// than throwing.
export const pairMarkdownBlockMap = (
  blockLines: number[],
  rootElement: Element,
): BlockMapEntry[] => {
  const children = rootElement.children;
  const n = Math.min(children.length, blockLines.length);
  const map: BlockMapEntry[] = [];
  for (let i = 0; i < n; i++) {
    map.push({ line: blockLines[i]!, el: children[i]! });
  }
  return map;
};

// ================= Admonition icon SVGs =================
//
// Font Awesome 4 glyphs extracted from the webfont SVG and wrapped
// in standalone SVG elements. Asciidoctor with `icons: 'font'` emits
// admonition icons as <i class="fa icon-NAME">, glyphs rendered by
// the FontAwesome font. We replace those elements with inline SVGs
// during render post-processing (see replaceAdmonitionIcons below).
//
// Why SVG instead of the native font-icon output: font glyphs are
// positioned by baseline metrics, not by visible bounding box, so
// the cell's flex centering doesn't visually center the icon: the
// glyph floats toward the top of the cell because Font Awesome
// glyphs are drawn like uppercase letters (ascender above baseline,
// nothing below). SVGs have explicit viewBox/width/height and sit
// at the geometric center when flex-aligned.
//
// Most icons use a 1792×1792 viewBox (FA4's units-per-em) with the
// glyph naturally centered inside it. Two glyphs (warning, caution)
// have ink that touches or extends past the standard viewBox edges
// and use expanded 2048×2048 viewBoxes with offset origins so the
// glyph bbox sits centered in the SVG bounding box, see the per-icon
// comments below.
//
// The path transform `matrix(1 0 0 -1 X 1536)` does two jobs:
//   1. Flips the Y axis (fonts use y-up with baseline at y=0, while
//      SVG uses y-down), with +1536 translation so the ascent top
//      lines up with y=0 in the original 1792×1792 viewBox space.
//   2. X-offsets narrower glyphs so they're centered horizontally:
//      X = (1792 − horiz-adv-x) / 2 for the centered viewBox case.
//
// The `fill="currentColor"` attribute makes the glyph inherit color
// from the enclosing td via CSS's per-type color rules (see
// styles.css), matching how Octicons work for GFM alerts.

type AdmonitionType = "note" | "tip" | "important" | "warning" | "caution";

const ADMONITION_ICON_SVGS: Record<AdmonitionType, string> = {
  // info-circle (fa \f05a), horiz-adv-x 1536, offset (1792−1536)/2 = 128
  note: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1792 1792" fill="currentColor" aria-hidden="true"><path transform="matrix(1 0 0 -1 128 1536)" d="M1024 160v160q0 14 -9 23t-23 9h-96v512q0 14 -9 23t-23 9h-320q-14 0 -23 -9t-9 -23v-160q0 -14 9 -23t23 -9h96v-320h-96q-14 0 -23 -9t-9 -23v-160q0 -14 9 -23t23 -9h448q14 0 23 9t9 23zM896 1056v160q0 14 -9 23t-23 9h-192q-14 0 -23 -9t-9 -23v-160q0 -14 9 -23t23 -9h192q14 0 23 9t9 23zM1536 640q0 -209 -103 -385.5t-279.5 -279.5t-385.5 -103t-385.5 103t-279.5 279.5t-103 385.5t103 385.5t279.5 279.5t385.5 103t385.5 -103t279.5 -279.5t103 -385.5z"/></svg>',
  // lightbulb-o (fa \f0eb), horiz-adv-x 1024, offset (1792−1024)/2 = 384
  tip: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1792 1792" fill="currentColor" aria-hidden="true"><path transform="matrix(1 0 0 -1 384 1536)" d="M736 960q0 -13 -9.5 -22.5t-22.5 -9.5t-22.5 9.5t-9.5 22.5q0 46 -54 71t-106 25q-13 0 -22.5 9.5t-9.5 22.5t9.5 22.5t22.5 9.5q50 0 99.5 -16t87 -54t37.5 -90zM896 960q0 72 -34.5 134t-90 101.5t-123 62t-136.5 22.5t-136.5 -22.5t-123 -62t-90 -101.5t-34.5 -134q0 -101 68 -180q10 -11 30.5 -33t30.5 -33q128 -153 141 -298h228q13 145 141 298q10 11 30.5 33t30.5 33q68 79 68 180zM1024 960q0 -155 -103 -268q-45 -49 -74.5 -87t-59.5 -95.5t-34 -107.5q47 -28 47 -82q0 -37 -25 -64q25 -27 25 -64q0 -52 -45 -81q13 -23 13 -47q0 -46 -31.5 -71t-77.5 -25q-20 -44 -60 -70t-87 -26t-87 26t-60 70q-46 0 -77.5 25t-31.5 71q0 24 13 47q-45 29 -45 81q0 37 25 64q-25 27 -25 64q0 54 47 82q-4 50 -34 107.5t-59.5 95.5t-74.5 87q-103 113 -103 268q0 99 44.5 184.5t117 142t164 89t186.5 32.5t186.5 -32.5t164 -89t117 -142t44.5 -184.5z"/></svg>',
  // exclamation-circle (fa \f06a), horiz-adv-x 1536, offset 128
  important:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1792 1792" fill="currentColor" aria-hidden="true"><path transform="matrix(1 0 0 -1 128 1536)" d="M768 1408q209 0 385.5 -103t279.5 -279.5t103 -385.5t-103 -385.5t-279.5 -279.5t-385.5 -103t-385.5 103t-279.5 279.5t-103 385.5t103 385.5t279.5 279.5t385.5 103zM896 161v190q0 14 -9 23.5t-22 9.5h-192q-13 0 -23 -10t-10 -23v-190q0 -13 10 -23t23 -10h192q13 0 22 9.5t9 23.5zM894 505l18 621q0 12 -10 18q-10 8 -24 8h-220q-14 0 -24 -8q-10 -6 -10 -18l17 -621q0 -10 10 -17.5t24 -7.5h185q14 0 23.5 7.5t10.5 17.5z"/></svg>',
  // exclamation-triangle (fa \f071). Glyph bbox extends to the top of
  // the viewBox (y=0) and slightly past both horizontal edges, so its
  // ink visibly overflows a tight viewBox. Expanded viewBox centers
  // the bbox (cx=896, cy=832) in a 2048×2048 frame (128 units
  // horizontal padding, 192 units vertical) to give consistent
  // breathing room matching the other admonition icons.
  warning:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-128 -192 2048 2048" fill="currentColor" aria-hidden="true"><path transform="matrix(1 0 0 -1 0 1536)" d="M1024 161v190q0 14 -9.5 23.5t-22.5 9.5h-192q-13 0 -22.5 -9.5t-9.5 -23.5v-190q0 -14 9.5 -23.5t22.5 -9.5h192q13 0 22.5 9.5t9.5 23.5zM1022 535l18 459q0 12 -10 19q-13 11 -24 11h-220q-11 0 -24 -11q-10 -7 -10 -21l17 -457q0 -10 10 -16.5t24 -6.5h185q14 0 23.5 6.5t10.5 16.5zM1008 1469l768 -1408q35 -63 -2 -126q-17 -29 -46.5 -46t-63.5 -17h-1536q-34 0 -63.5 17t-46.5 46q-37 63 -2 126l768 1408q17 31 47 49t65 18t65 -18t47 -49z"/></svg>',
  // fire (fa \f06d). Glyph bbox fills the viewBox floor-to-ceiling
  // (y=0 to y=1792 in the 1792-tall viewBox). Expanded viewBox adds
  // 128 units padding on all sides (bbox already horizontally
  // centered) so ink has consistent margin inside the rendered SVG.
  caution:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-128 -128 2048 2048" fill="currentColor" aria-hidden="true"><path transform="matrix(1 0 0 -1 192 1536)" d="M1408 -160v-64q0 -13 -9.5 -22.5t-22.5 -9.5h-1344q-13 0 -22.5 9.5t-9.5 22.5v64q0 13 9.5 22.5t22.5 9.5h1344q13 0 22.5 -9.5t9.5 -22.5zM1152 896q0 -78 -24.5 -144t-64 -112.5t-87.5 -88t-96 -77.5t-87.5 -72t-64 -81.5t-24.5 -96.5q0 -96 67 -224l-4 1l1 -1q-90 41 -160 83t-138.5 100t-113.5 122.5t-72.5 150.5t-27.5 184q0 78 24.5 144t64 112.5t87.5 88t96 77.5t87.5 72t64 81.5t24.5 96.5q0 94 -66 224l3 -1l-1 1q90 -41 160 -83t138.5 -100t113.5 -122.5t72.5 -150.5t27.5 -184z"/></svg>',
};

// Replace Asciidoctor's font-icon admonition markers (<i class="fa
// icon-NAME" title="..."></i>) with the corresponding inline SVG.
// Mutates `parsed` in place: the caller parses the worker's HTML
// once and passes the resulting Document through here and then to
// DOMPurify, so the markup is never re-serialized to a string.
//
// We target only the admonition icon pattern (`icon-` class prefix).
// Inline icon:name[] directives emit <i class="fa fa-NAME"> (note
// the `fa-` prefix, not `icon-`) and deliberately flow through
// unchanged, since they're sized inline with surrounding text and
// the baseline-positioning that makes admonition icons look off is
// exactly what's wanted for a character-in-text inline icon.
export const replaceAdmonitionIcons = (parsed: Document): void => {
  // Scope the query to icon cells under admonitionblocks, then
  // extract the type from the `icon-<type>` class so we never
  // accidentally rewrite something else that happens to share the
  // <i class="fa icon-..."> shape.
  const iconEls = parsed.querySelectorAll('.admonitionblock td.icon i.fa[class*="icon-"]');
  for (const el of iconEls) {
    const match = el.className.match(/\bicon-([a-z]+)\b/);
    const type = match?.[1] as AdmonitionType | undefined;
    if (!type || !(type in ADMONITION_ICON_SVGS)) continue;
    // Parse the SVG as an HTML fragment so we get a proper Element
    // we can swap in place of the <i>. Using a template element
    // rather than another DOMParser call for a cheaper round-trip.
    const template = parsed.createElement("template");
    template.innerHTML = ADMONITION_ICON_SVGS[type];
    const svg = template.content.firstElementChild;
    if (svg) el.replaceWith(svg);
  }
};

// ================= Render worker client =================
//
// The expensive parse + convert work runs in render-worker.ts (a Web
// Worker), so a render in progress never blocks the editor. This
// section owns the single worker instance and the request/response
// plumbing: each render gets a monotonic id, its resolve callback is
// parked in pendingRenders, and the worker's message handler looks the
// id up and settles the matching promise.

// The worker, created lazily on first render and reused for the
// process lifetime. null until the first render, and again after a
// worker crash, when it's dropped so the next render builds a fresh
// one.
let renderWorker: Worker | null = null;

// Monotonic request id. Each runInWorker call increments it so the
// worker's echoed-back id matches a response to its request.
let workerSeq = 0;

// In-flight worker requests: id → the promise's resolve callback. The
// worker processes messages in receive order and echoes the id, so
// the message handler resolves the matching entry and deletes it.
const pendingRenders = new Map<number, (response: WorkerRenderResponse) => void>();

// Lazily construct the worker and wire its listeners.
//
// new URL('./render-worker.ts', import.meta.url) is the Vite worker
// pattern: Vite recognizes this exact form statically and emits the
// worker module as its own bundle chunk.
//
// message handler: resolve whichever pendingRenders entry matches the
// echoed id. error handler: a worker-level failure (module load
// error, a throw outside the message handler) can't be tied to one
// request, so every in-flight request is failed and the worker is
// dropped, so the next render lazily builds a fresh one.
const getWorker = (): Worker => {
  if (renderWorker) return renderWorker;
  const worker = new Worker(new URL("./render-worker.ts", import.meta.url), { type: "module" });
  worker.addEventListener("message", (e: MessageEvent<WorkerRenderResponse>) => {
    const response = e.data;
    const settle = pendingRenders.get(response.id);
    if (settle) {
      pendingRenders.delete(response.id);
      settle(response);
    }
  });
  worker.addEventListener("error", (e: ErrorEvent) => {
    console.error("render worker error:", e.message);
    const failure: WorkerRenderResponse = {
      id: -1,
      ok: false,
      error: e.message || "render worker crashed",
    };
    for (const settle of pendingRenders.values()) settle(failure);
    pendingRenders.clear();
    renderWorker = null;
  });
  renderWorker = worker;
  return worker;
};

// Send one render request to the worker and resolve with its
// response. The returned promise always resolves (never rejects):
// worker-side failures come back as a WorkerRenderFailure, so
// callers branch on `response.ok` rather than wrapping this in
// try/catch.
const runInWorker = (req: Omit<WorkerRenderRequest, "id">): Promise<WorkerRenderResponse> => {
  const id = ++workerSeq;
  const worker = getWorker();
  return new Promise<WorkerRenderResponse>((resolve) => {
    pendingRenders.set(id, resolve);
    worker.postMessage({ id, ...req });
  });
};

export const asciidoctorRenderer: Renderer = {
  async render(source: string, context: RenderContext): Promise<RenderResult> {
    let lineMap: number[] | null = null;
    const t0 = performance.now(); // [perf]

    // Asciidoctor load attributes. showtitle renders the doc title in
    // embedded output. icons: 'font' switches admonition rendering
    // from text labels to Font Awesome icon markup (<i class="fa
    // icon-note"> etc.), later swapped for inline SVGs by
    // replaceAdmonitionIcons, and styling for the icons lives in
    // styles.css (see .admonitionblock td.icon [class^="fa icon-"]).
    // relfilesuffix makes inter-document xref targets keep their
    // source extension (xref:other.adoc[] renders href="other.adoc"
    // instead of the default "other.html"), which is what lets the
    // preview's link interception resolve the target on disk.
    // Self-referencing xrefs still collapse to pure #fragment hrefs
    // regardless of the suffix.
    //
    // Typed Record<string, unknown> so the docname/docfile/docdir keys
    // can be spread on below without TS narrowing it to the initial
    // literal shape. Asciidoctor attribute values span strings,
    // numbers, and booleans, so unknown is the right width.
    let attributes: Record<string, unknown> = {
      showtitle: true,
      icons: "font",
      relfilesuffix: ".adoc",
    };

    if (context.path) {
      const baseDir = await dirname(context.path);
      const result = await preprocessSource(source, baseDir);
      source = result.source;
      lineMap = result.lineMap;

      // Set docname / docfile / docdir attributes so Asciidoctor
      // knows the "identity" of the document being rendered. Normally
      // Asciidoctor derives these from the filename when loading from
      // a file, but we pass a string to load() (because we pre-expand
      // includes), so we have to set them explicitly via attributes.
      //
      // Why this matters: many AsciiDoc book projects use the ifeval
      // pattern to conditionally override per-chapter :imagesdir: in
      // a standalone-vs-included-in-book way, e.g.:
      //
      //   :imagesdir: images
      //   ifeval::["{docname}" == "index"]
      //   :imagesdir: chapter-03/images
      //   endif::[]
      //
      // Without a correct {docname}, the ifeval evaluates as
      // "" == "index" = false, the override doesn't fire, and
      // image paths resolve relative to the wrong directory. Setting
      // docname to the basename (without extension) of the current
      // path makes the ifeval pattern work as the document author
      // intended.
      const name = await basename(context.path);
      const docname = name.replace(/\.[^.]+$/, "");
      attributes = {
        ...attributes,
        docname,
        docfile: context.path,
        docdir: baseDir,
      };
    }
    const t1 = performance.now(); // [perf]

    // Hand the flattened source to the worker for load + convert +
    // block-line extraction. sourcemap is enabled inside the worker
    // so blocks carry source line numbers for the scroll-sync map.
    //
    // safe mode: config-file override via userConfig.asciidocSafeMode
    // (set-and-forget knob, no UI), default 'unsafe'. Asciidoctor's
    // safe modes (unsafe/safe/server/secure) were designed for a
    // server-rendering threat model: an untrusted document processed
    // by a trusted server and served to others. That model does not
    // apply to Skrivro: this is a single-user local editor where
    // users edit their own files, and restricting safe mode would
    // cripple legitimate features (docinfo, book-mode doctype,
    // cross-directory includes) for no real gain, since the user can
    // already open any OS-readable file via File → Open. The real
    // protections are Content-Security-Policy (blocks all network
    // egress so nothing can phone home) and the DOMPurify pass below
    // (strips scripts / event handlers before the HTML hits the DOM).
    const res = await runInWorker({
      kind: "asciidoc",
      source,
      safe: userConfig.asciidocSafeMode || "unsafe",
      attributes,
    });
    const t2 = performance.now(); // [perf]
    if (!res.ok) throw new Error(res.error);

    // Parse the worker's HTML into a DOM exactly once. The
    // admonition-icon swap and DOMPurify both operate on that single
    // DOM: replaceAdmonitionIcons mutates it in place, then
    // DOMPurify.sanitize takes the node (not a string) and returns a
    // DocumentFragment, so the markup is never re-serialized. Both
    // steps need a DOM (DOMParser / DOMPurify), so they run here on
    // the main thread, not in the worker. DOMPurify keeps <svg>/<path>
    // elements by default (verified with the Octicons used in GFM
    // alerts), so the injected icon markup survives sanitization.
    const parsed = new DOMParser().parseFromString(res.html, "text/html");
    replaceAdmonitionIcons(parsed);
    const fragment = DOMPurify.sanitize(parsed.body, { RETURN_DOM_FRAGMENT: true });
    const t3 = performance.now(); // [perf]
    perfLog(
      `adoc render: total ${(t3 - t0).toFixed(0)}ms (preprocess ${(t1 - t0).toFixed(0)}, worker ${(t2 - t1).toFixed(0)}, post ${(t3 - t2).toFixed(0)})`,
    );

    // Capture the per-render state in closures. The caller invokes
    // buildBlockMap after injecting the fragment into a container,
    // and pairAsciidoctorBlockMap pairs the worker's block-line list
    // against that container's DOM. translateEditorLine looks up the
    // flat-source line number for a given editor-source line:
    // identity when there were no includes (lineMap is null), mapped
    // otherwise.
    const capturedLineMap = lineMap;
    const blockLines = res.blockLines;
    return {
      fragment,
      buildBlockMap: (rootElement: Element) => pairAsciidoctorBlockMap(blockLines, rootElement),
      translateEditorLine: (editorLine: number) =>
        capturedLineMap ? (capturedLineMap[editorLine - 1] ?? editorLine) : editorLine,
      tocPosition: res.tocPosition,
    };
  },

  clearCache() {
    includeCache = new Map<string, string>();
  },
};

// ================= MarkdownRenderer =================
//
// Renders GitHub-Flavored Markdown. The parse runs in the render
// worker (render-worker.ts hosts markdown-it plus the gfmAlert,
// task-list, and emoji extensions), while this renderer
// assembles the request, sanitizes the worker's HTML, and pairs
// the worker's block-line list against the rendered DOM for
// scroll sync.

export const markdownRenderer: Renderer = {
  async render(source: string, _context: RenderContext): Promise<RenderResult> {
    const m0 = performance.now(); // [perf]
    const res = await runInWorker({ kind: "markdown", source });
    const m1 = performance.now(); // [perf]
    if (!res.ok) throw new Error(res.error);

    // DOMPurify sanitization matches the AsciiDoc path: the same
    // HTML-injection protection regardless of format. RETURN_DOM_FRAGMENT
    // hands back a DocumentFragment the caller injects directly, so the
    // HTML is parsed once (here, inside DOMPurify) rather than again on
    // the caller's side.
    const fragment = DOMPurify.sanitize(res.html, { RETURN_DOM_FRAGMENT: true });
    const m2 = performance.now(); // [perf]
    perfLog(
      `md render: total ${(m2 - m0).toFixed(0)}ms (worker ${(m1 - m0).toFixed(0)}, sanitize ${(m2 - m1).toFixed(0)})`,
    );

    const blockLines = res.blockLines;
    return {
      fragment,
      // Pair the worker's per-token line list against the rendered
      // top-level children by index (the 1:1 token-to-element
      // invariant, see pairMarkdownBlockMap).
      buildBlockMap: (rootElement: Element) => pairMarkdownBlockMap(blockLines, rootElement),
      // Markdown rendering does no source transformation (unlike
      // AsciiDoc's include expansion), so editor and output line
      // coordinates coincide and identity translation is exact.
      translateEditorLine: (editorLine: number) => editorLine,
      // Markdown has no `:toc:` analog, so the sidebar table of
      // contents layout never activates for markdown documents.
      tocPosition: null,
    };
  },

  clearCache() {
    // No per-path state to invalidate.
  },
};

// ================= TextRenderer =================
//
// Pass-through renderer for buffers the user has marked as plain
// text. The preview mirrors the source verbatim in a monospace
// block: no parsing, no transformation. AsciiDoc or Markdown
// syntax typed in a text-mode buffer stays literal in the preview.

// HTML-entity escape for interpolation into the <pre> output. Same
// set of metacharacters preview.ts's error-display path escapes,
// kept as a local helper here so TextRenderer doesn't reach into
// another module. Record<string, string> typing satisfies strict
// mode's noUncheckedIndexedAccess, and the `?? c` fallback is
// defensive and unreachable given the regex class.
const TEXT_ESCAPE_MAP: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
const escapeForPre = (s: string): string => s.replace(/[&<>]/g, (c) => TEXT_ESCAPE_MAP[c] ?? c);

export const textRenderer: Renderer = {
  // Not declared async for the same reason as markdownRenderer: no
  // awaits inside, Promise.resolve matches the interface contract.
  render(source: string, _context: RenderContext): Promise<RenderResult> {
    // Wrap the escaped source in <pre class="text-verbatim">. The
    // class is a hook for future styling: CSS can target it to
    // adjust font or spacing specifically in text mode without
    // touching the generic <pre> used by AsciiDoc listing blocks.
    // DOMPurify pass is redundant here (our escape produces only
    // entity references, no injection vectors) but cheap and keeps
    // the output path uniform with the other renderers. RETURN_DOM_FRAGMENT
    // matches the fragment-returning contract the other renderers use.
    const fragment = DOMPurify.sanitize(
      `<pre class="text-verbatim">${escapeForPre(source)}</pre>`,
      { RETURN_DOM_FRAGMENT: true },
    );

    return Promise.resolve({
      fragment,
      buildBlockMap: () => [],
      translateEditorLine: (editorLine: number) => editorLine,
      // Plain text has no table of contents, so the sidebar
      // layout never activates for text documents.
      tocPosition: null,
    });
  },

  clearCache() {
    // No state.
  },
};

// ================= Dispatch =================
//
// Format → Renderer mapping. The single call site in preview.ts's
// render() reads currentBuffer.format, calls getRenderer, and
// invokes render on whatever comes back. Adding a new format means
// adding a Renderer implementation above and a case here, and
// preview.ts doesn't change.
//
// The switch is exhaustive over the Format union, so TypeScript
// will flag any missing case if Format gains a new member.
export const getRenderer = (format: Format): Renderer => {
  switch (format) {
    case "markdown":
      return markdownRenderer;
    case "text":
      return textRenderer;
    case "asciidoc":
      return asciidoctorRenderer;
  }
};

// Invalidate every renderer's per-path cache. Called from io.ts on
// file operations that change the buffer's identity (open, save-as,
// new, reload, :e filename) so stale cached state doesn't bleed
// across buffers. Only asciidoctorRenderer has a cache worth
// clearing today, while markdown and text no-op. Calling the set
// lets io.ts stay agnostic about which renderer holds cacheable
// state.
const ALL_RENDERERS: readonly Renderer[] = [asciidoctorRenderer, markdownRenderer, textRenderer];

export const clearAllRendererCaches = (): void => {
  for (const r of ALL_RENDERERS) r.clearCache();
};
