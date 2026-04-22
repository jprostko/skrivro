// ================= Renderer =================
// Source-to-HTML rendering interface and the AsciiDoc implementation.
// Isolates the markup-specific work (parsing, sanitizing, building the
// source-line → DOM-element map for scroll sync) behind a Renderer
// interface that preview.ts calls uniformly regardless of the active
// markup format.
//
// Only AsciidoctorRenderer exists today. When additional formats are
// added, each implementation lives here (or in a sibling module) and
// the dispatch — "given this buffer, which Renderer do I use?" —
// gets added at the point where the buffer's format field is read.

import Asciidoctor, {
  type Document as AsciidoctorDocument,
  type AbstractBlock,
} from '@asciidoctor/core';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { markedEmoji } from 'marked-emoji';
import { nameToEmoji } from 'gemoji';

import { readTextFile } from '@tauri-apps/plugin-fs';
import { basename, dirname, resolve } from '@tauri-apps/api/path';

import { userConfig } from './config.js';
import type { Format } from './io.js';

// ================= Public interface =================

// One entry per mapped preview element. `line` is the source line
// number that produced `el`, 1-indexed. For AsciiDoc this refers to
// the FLATTENED source (post-include-expansion) — translation from
// editor-source coordinates to flat-source coordinates is done via
// RenderResult.translateEditorLine so callers never have to know.
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

// Result of a single render. `html` is ready for DOM injection
// (already sanitized by the renderer). The two callbacks close over
// per-render state: `buildBlockMap` walks the rendered output of
// `html` in the caller's container to produce the scroll-sync map;
// `translateEditorLine` converts an editor-source line number into
// whatever coordinate system the returned BlockMapEntry.line values
// use (identity for renderers that don't transform source; include-
// line-map-aware for AsciiDoc).
export interface RenderResult {
  html: string;
  buildBlockMap: (rootElement: Element) => BlockMapEntry[];
  translateEditorLine: (editorLine: number) => number;
}

// The abstraction preview.ts consumes. Every concrete markup format
// implements this. `clearCache` is a no-op for renderers without a
// per-path cache; AsciidoctorRenderer uses it to invalidate the
// include-file cache on buffer change / reload.
export interface Renderer {
  render(source: string, context: RenderContext): Promise<RenderResult>;
  clearCache(): void;
}

// ================= Asciidoctor include preprocessing =================
//
// Must run BEFORE Asciidoctor sees the source. Asciidoctor.js's
// browser-side include reader uses synchronous XMLHttpRequest against
// the current page URL; in our Tauri webview the page URL is our own
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
// object. Positional attributes (values without `=`) are ignored —
// the AsciiDoc include directive doesn't use positional attrs.
//
// Return type is Record<string, string>: all keys are strings, all
// values are strings. TS's Record doesn't model "key might be absent
// at runtime" — attrs.leveloffset is typed as string even when the
// raw didn't include that key, so downstream `if (attrs.leveloffset)`
// truthiness checks still do the right runtime work while TS's
// narrowing accepts them.
const parseIncludeAttrs = (raw: string): Record<string, string> => {
  const attrs: Record<string, string> = {};
  if (!raw) return attrs;
  for (const part of raw.split(',')) {
    const eq = part.indexOf('=');
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
const applyIncludeAttrs = (content: string, attrs: Record<string, string>): string => {
  // lines=N..M or lines=N..M;X..Y — keep specified 1-indexed ranges.
  // Open-ended ranges like `lines=5..` mean "from line 5 to end".
  if (attrs.lines) {
    const lines = content.split('\n');
    const kept = [];
    for (const range of attrs.lines.split(';')) {
      const dotdot = range.indexOf('..');
      let from, to;
      if (dotdot === -1) {
        from = to = parseInt(range, 10);
      } else {
        from = parseInt(range.slice(0, dotdot), 10);
        const toStr = range.slice(dotdot + 2);
        to = toStr === '' ? lines.length : parseInt(toStr, 10);
      }
      if (Number.isNaN(from) || Number.isNaN(to)) continue;
      for (let i = from; i <= to && i <= lines.length; i++) {
        if (i >= 1) kept.push(lines[i - 1]);
      }
    }
    content = kept.join('\n');
  }
  // tag=name or tags=n1;n2 — keep only lines inside matching tag
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
    const lines = content.split('\n');
    const kept = [];
    const active = new Set();
    const startRe = /\/\/\s*tag::([a-zA-Z0-9_.-]+)\[\]/;
    const endRe   = /\/\/\s*end::([a-zA-Z0-9_.-]+)\[\]/;
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
    content = kept.join('\n');
  }
  // indent=N — normalize leading indent to exactly N spaces. Finds
  // the minimum indent across non-blank lines, strips it, then
  // prefixes N spaces. Blank lines are left untouched.
  if (attrs.indent !== undefined) {
    const target = parseInt(attrs.indent, 10) || 0;
    const lines = content.split('\n');
    let minIndent = Infinity;
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      const m = line.match(/^( *)/);
      // `m[1]!` — required capture group, always present when match
      // succeeds. Non-null assertion satisfies noUncheckedIndexedAccess.
      if (m) minIndent = Math.min(minIndent, m[1]!.length);
    }
    if (!isFinite(minIndent)) minIndent = 0;
    const pad = ' '.repeat(target);
    content = lines.map(l =>
      l.trim().length === 0 ? l : pad + l.slice(minIndent)
    ).join('\n');
  }
  return content;
};

// Expand a single `include::target[attrs]` directive. Reads the
// target file (from cache if present), applies attribute filters,
// recursively expands any nested includes, and wraps the content
// in :leveloffset: directives if the include specifies one. On any
// error (missing file, permission denied, cycle), returns a visible
// comment-style placeholder rather than throwing — a broken include
// shouldn't crash the render, it should just show "Unresolved
// include" where the content would have been.
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
    // rewrite heading tokens ourselves — Asciidoctor's built-in
    // leveloffset handling is the right tool for this.
    if (attrs.leveloffset) {
      const lo = attrs.leveloffset;
      let sign, invSign, mag;
      if (lo.startsWith('+')) { sign = '+'; invSign = '-'; mag = lo.slice(1); }
      else if (lo.startsWith('-')) { sign = '-'; invSign = '+'; mag = lo.slice(1); }
      else { sign = '+'; invSign = '-'; mag = lo; }
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
// expanded include. This variant does NOT build a line map — nested
// includes are invisible to the editor's cursor position, so their
// internal line coordinates aren't needed for scroll sync.
const expandRecursively = async (
  source: string,
  baseDir: string,
  cycle: Set<string>,
): Promise<string> => {
  const includeRe = /^include::([^[\n]+)\[([^\]]*)\]\s*$/;
  const lines = source.split('\n');
  const out = [];
  for (const line of lines) {
    const m = line.match(includeRe);
    if (m) {
      // `m[1]!` is the target path (required capture group in
      // includeRe); `m[2]` is the attribute blob which has default
      // empty-string semantics via the `[^\]]*` match — undefined
      // would mean the match failed, but we just guarded against that.
      out.push(await expandOneInclude(m[1]!.trim(), m[2]!, baseDir, cycle));
    } else {
      out.push(line);
    }
  }
  return out.join('\n');
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
// the mapping points to the FIRST line of expanded content — so
// scroll-syncing on an `include::chapter-05/content.adoc[]` line
// jumps the preview to the top of chapter 5.
const preprocessSource = async (
  rootSource: string,
  baseDir: string,
): Promise<{ source: string; lineMap: number[] }> => {
  const includeRe = /^include::([^[\n]+)\[([^\]]*)\]\s*$/;
  // split('\n') on a string ending with '\n' produces a trailing
  // empty element. That's not a real line of content — it's the
  // representation of "the source ends with a newline." Drop it so
  // we don't emit a spurious blank line at the very end of the
  // flattened output.
  let rootLines = rootSource.split('\n');
  if (rootSource.endsWith('\n') && rootLines.length > 0 && rootLines[rootLines.length - 1] === '') {
    rootLines = rootLines.slice(0, -1);
  }

  const parts = [];
  const lineMap = new Array(rootLines.length);
  let flatLine = 1;

  for (let i = 0; i < rootLines.length; i++) {
    // `rootLines[i]!` — the loop bound i < rootLines.length makes
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
        if (!expanded.endsWith('\n')) expanded += '\n';
        parts.push(expanded);
        // With the trailing '\n' guarantee, the number of flat
        // lines in the expansion is (newlines) — each '\n'
        // terminates exactly one line.
        flatLine += (expanded.split('\n').length - 1);
      }
      // Empty expansion: consume the root include line but don't
      // advance flatLine. The next root line's lineMap entry points
      // to the same flatLine, which correctly represents "the
      // empty include collapsed."
    } else {
      lineMap[i] = flatLine;
      parts.push(line);
      parts.push('\n');
      flatLine++;
    }
  }

  // Rejoin and restore trailing-newline state of the root source.
  // If the root didn't end with '\n', strip the one we appended to
  // the last line.
  let flat = parts.join('');
  if (!rootSource.endsWith('\n') && flat.endsWith('\n')) {
    flat = flat.slice(0, -1);
  }
  return { source: flat, lineMap };
};

// ================= AsciiDoc block-map walk =================

// Asciidoctor block contexts that map to a scrollable preview element.
// Excludes purely structural contexts (document, preamble) and inline-
// level blocks that don't get their own preview container.
const MAPPABLE_CONTEXTS = new Set([
  'paragraph', 'listing', 'literal', 'example', 'sidebar',
  'admonition', 'quote', 'verse', 'image', 'ulist', 'olist', 'dlist',
  'section', 'open', 'table',
]);

// CSS selector matching the DOM elements Asciidoctor emits for those
// block contexts. Order in the selector doesn't matter — querySelectorAll
// returns matches in document order regardless.
const DOM_BLOCK_SELECTOR = [
  '.paragraph', '.listingblock', '.literalblock', '.exampleblock',
  '.sidebarblock', '.admonitionblock', '.quoteblock', '.verseblock',
  '.imageblock', '.ulist', '.olist', '.dlist',
  '.sect1', '.sect2', '.sect3', '.sect4', '.sect5',
  '.openblock', 'table.tableblock',
].join(', ');

// Walk the parsed AST and the rendered DOM in parallel, building a
// map from source line to preview block element. Walks the tree
// manually via getBlocks() rather than findBy() for robustness
// against API surprises. Relies on Asciidoctor emitting blocks in
// document order in both the AST walk and the rendered HTML (via
// querySelectorAll). The i-th matching AST block aligns with the
// i-th matching DOM element.
//
// Types sourced from @asciidoctor/core's bundled type declarations.
// Document extends AbstractBlock, so `doc: AsciidoctorDocument` and
// `block: AbstractBlock` line up naturally. One caveat: the bundled
// definition for AbstractBlock.getBlocks() returns `any[]` (not a
// typed AbstractBlock[] union), so the children yielded by walk()
// inside this function stay effectively untyped.
const buildAsciidoctorBlockMap = (
  doc: AsciidoctorDocument,
  rootElement: Element,
): BlockMapEntry[] => {
  try {
    const ast: AbstractBlock[] = [];
    const walk = (block: AbstractBlock) => {
      if (!block || typeof block.getBlocks !== 'function') return;
      for (const child of block.getBlocks()) {
        let ctx = null;
        try { ctx = child.getContext(); } catch {}
        if (ctx && MAPPABLE_CONTEXTS.has(ctx)) {
          let loc = null;
          try { loc = child.getSourceLocation(); } catch {}
          if (loc) ast.push(child);
        }
        walk(child);
      }
    };
    walk(doc);

    const dom = Array.from(rootElement.querySelectorAll(DOM_BLOCK_SELECTOR));
    const map: BlockMapEntry[] = [];
    const n = Math.min(ast.length, dom.length);
    for (let i = 0; i < n; i++) {
      try {
        // Both ast[i] and dom[i] are safe here because the loop
        // runs only to i < n = min(ast.length, dom.length). The `!`
        // assertions document that invariant for the type system.
        const line = ast[i]!.getSourceLocation().getLineNumber();
        if (typeof line === 'number') {
          map.push({ line, el: dom[i]! });
        }
      } catch {}
    }
    map.sort((a, b) => a.line - b.line);
    console.log(`[skrivro] buildBlockMap: ast=${ast.length} dom=${dom.length} map=${map.length}`);
    return map;
  } catch (e) {
    console.error('buildBlockMap failed:', e);
    return [];
  }
};

// ================= AsciidoctorRenderer =================

const ad = Asciidoctor();

// ================= Admonition icon SVGs =================
//
// Font Awesome 4 glyphs extracted from the webfont SVG and wrapped
// in standalone SVG elements. Asciidoctor with `icons: 'font'` emits
// admonition icons as <i class="fa icon-NAME"> — glyphs rendered by
// the FontAwesome font. We replace those elements with inline SVGs
// during render post-processing (see replaceAdmonitionIcons below).
//
// Why SVG instead of the native font-icon output: font glyphs are
// positioned by baseline metrics, not by visible bounding box, so
// the cell's flex centering doesn't visually center the icon — the
// glyph floats toward the top of the cell because Font Awesome
// glyphs are drawn like uppercase letters (ascender above baseline,
// nothing below). SVGs have explicit viewBox/width/height and sit
// at the geometric center when flex-aligned.
//
// Most icons use a 1792×1792 viewBox (FA4's units-per-em) with the
// glyph naturally centered inside it. Two glyphs (warning, caution)
// have ink that touches or extends past the standard viewBox edges
// and use expanded 2048×2048 viewBoxes with offset origins so the
// glyph bbox sits centered in the SVG bounding box; see the per-icon
// comments below.
//
// The path transform `matrix(1 0 0 -1 X 1536)` does two jobs:
//   1. Flips the Y axis (fonts use y-up with baseline at y=0; SVG
//      uses y-down), with +1536 translation so the ascent top lines
//      up with y=0 in the original 1792×1792 viewBox space.
//   2. X-offsets narrower glyphs so they're centered horizontally —
//      X = (1792 − horiz-adv-x) / 2 for the centered viewBox case.
//
// The `fill="currentColor"` attribute makes the glyph inherit color
// from the enclosing td via CSS's per-type color rules (see
// styles.css), matching how Octicons work for GFM alerts.

type AdmonitionType = 'note' | 'tip' | 'important' | 'warning' | 'caution';

const ADMONITION_ICON_SVGS: Record<AdmonitionType, string> = {
  // info-circle (fa \f05a), horiz-adv-x 1536, offset (1792−1536)/2 = 128
  note: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1792 1792" fill="currentColor" aria-hidden="true"><path transform="matrix(1 0 0 -1 128 1536)" d="M1024 160v160q0 14 -9 23t-23 9h-96v512q0 14 -9 23t-23 9h-320q-14 0 -23 -9t-9 -23v-160q0 -14 9 -23t23 -9h96v-320h-96q-14 0 -23 -9t-9 -23v-160q0 -14 9 -23t23 -9h448q14 0 23 9t9 23zM896 1056v160q0 14 -9 23t-23 9h-192q-14 0 -23 -9t-9 -23v-160q0 -14 9 -23t23 -9h192q14 0 23 9t9 23zM1536 640q0 -209 -103 -385.5t-279.5 -279.5t-385.5 -103t-385.5 103t-279.5 279.5t-103 385.5t103 385.5t279.5 279.5t385.5 103t385.5 -103t279.5 -279.5t103 -385.5z"/></svg>',
  // lightbulb-o (fa \f0eb), horiz-adv-x 1024, offset (1792−1024)/2 = 384
  tip: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1792 1792" fill="currentColor" aria-hidden="true"><path transform="matrix(1 0 0 -1 384 1536)" d="M736 960q0 -13 -9.5 -22.5t-22.5 -9.5t-22.5 9.5t-9.5 22.5q0 46 -54 71t-106 25q-13 0 -22.5 9.5t-9.5 22.5t9.5 22.5t22.5 9.5q50 0 99.5 -16t87 -54t37.5 -90zM896 960q0 72 -34.5 134t-90 101.5t-123 62t-136.5 22.5t-136.5 -22.5t-123 -62t-90 -101.5t-34.5 -134q0 -101 68 -180q10 -11 30.5 -33t30.5 -33q128 -153 141 -298h228q13 145 141 298q10 11 30.5 33t30.5 33q68 79 68 180zM1024 960q0 -155 -103 -268q-45 -49 -74.5 -87t-59.5 -95.5t-34 -107.5q47 -28 47 -82q0 -37 -25 -64q25 -27 25 -64q0 -52 -45 -81q13 -23 13 -47q0 -46 -31.5 -71t-77.5 -25q-20 -44 -60 -70t-87 -26t-87 26t-60 70q-46 0 -77.5 25t-31.5 71q0 24 13 47q-45 29 -45 81q0 37 25 64q-25 27 -25 64q0 54 47 82q-4 50 -34 107.5t-59.5 95.5t-74.5 87q-103 113 -103 268q0 99 44.5 184.5t117 142t164 89t186.5 32.5t186.5 -32.5t164 -89t117 -142t44.5 -184.5z"/></svg>',
  // exclamation-circle (fa \f06a), horiz-adv-x 1536, offset 128
  important: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1792 1792" fill="currentColor" aria-hidden="true"><path transform="matrix(1 0 0 -1 128 1536)" d="M768 1408q209 0 385.5 -103t279.5 -279.5t103 -385.5t-103 -385.5t-279.5 -279.5t-385.5 -103t-385.5 103t-279.5 279.5t-103 385.5t103 385.5t279.5 279.5t385.5 103zM896 161v190q0 14 -9 23.5t-22 9.5h-192q-13 0 -23 -10t-10 -23v-190q0 -13 10 -23t23 -10h192q13 0 22 9.5t9 23.5zM894 505l18 621q0 12 -10 18q-10 8 -24 8h-220q-14 0 -24 -8q-10 -6 -10 -18l17 -621q0 -10 10 -17.5t24 -7.5h185q14 0 23.5 7.5t10.5 17.5z"/></svg>',
  // exclamation-triangle (fa \f071). Glyph bbox extends to the top of
  // the viewBox (y=0) and slightly past both horizontal edges, so its
  // ink visibly overflows a tight viewBox. Expanded viewBox centers
  // the bbox (cx=896, cy=832) in a 2048×2048 frame — 128 units
  // horizontal padding, 192 units vertical — to give consistent
  // breathing room matching the other admonition icons.
  warning: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-128 -192 2048 2048" fill="currentColor" aria-hidden="true"><path transform="matrix(1 0 0 -1 0 1536)" d="M1024 161v190q0 14 -9.5 23.5t-22.5 9.5h-192q-13 0 -22.5 -9.5t-9.5 -23.5v-190q0 -14 9.5 -23.5t22.5 -9.5h192q13 0 22.5 9.5t9.5 23.5zM1022 535l18 459q0 12 -10 19q-13 11 -24 11h-220q-11 0 -24 -11q-10 -7 -10 -21l17 -457q0 -10 10 -16.5t24 -6.5h185q14 0 23.5 6.5t10.5 16.5zM1008 1469l768 -1408q35 -63 -2 -126q-17 -29 -46.5 -46t-63.5 -17h-1536q-34 0 -63.5 17t-46.5 46q-37 63 -2 126l768 1408q17 31 47 49t65 18t65 -18t47 -49z"/></svg>',
  // fire (fa \f06d). Glyph bbox fills the viewBox floor-to-ceiling
  // (y=0 to y=1792 in the 1792-tall viewBox). Expanded viewBox adds
  // 128 units padding on all sides (bbox already horizontally
  // centered) so ink has consistent margin inside the rendered SVG.
  caution: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-128 -128 2048 2048" fill="currentColor" aria-hidden="true"><path transform="matrix(1 0 0 -1 192 1536)" d="M1408 -160v-64q0 -13 -9.5 -22.5t-22.5 -9.5h-1344q-13 0 -22.5 9.5t-9.5 22.5v64q0 13 9.5 22.5t22.5 9.5h1344q13 0 22.5 -9.5t9.5 -22.5zM1152 896q0 -78 -24.5 -144t-64 -112.5t-87.5 -88t-96 -77.5t-87.5 -72t-64 -81.5t-24.5 -96.5q0 -96 67 -224l-4 1l1 -1q-90 41 -160 83t-138.5 100t-113.5 122.5t-72.5 150.5t-27.5 184q0 78 24.5 144t64 112.5t87.5 88t96 77.5t87.5 72t64 81.5t24.5 96.5q0 94 -66 224l3 -1l-1 1q90 -41 160 -83t138.5 -100t113.5 -122.5t72.5 -150.5t27.5 -184z"/></svg>',
};

// Replace Asciidoctor's font-icon admonition markers (<i class="fa
// icon-NAME" title="..."></i>) with the corresponding inline SVG.
// Called on the rendered HTML string before DOMPurify runs.
//
// We target only the admonition icon pattern (`icon-` class prefix).
// Inline icon:name[] directives emit <i class="fa fa-NAME"> (note
// the `fa-` prefix, not `icon-`) and deliberately flow through
// unchanged — they're sized inline with surrounding text and the
// baseline-positioning that makes admonition icons look off is
// exactly what's wanted for a character-in-text inline icon.
//
// Implementation via DOMParser so we handle attribute ordering,
// quoting, and edge cases properly rather than relying on a regex
// over raw HTML.
const replaceAdmonitionIcons = (rawHtml: string): string => {
  const parser = new DOMParser();
  const parsed = parser.parseFromString(rawHtml, 'text/html');
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
    const template = parsed.createElement('template');
    template.innerHTML = ADMONITION_ICON_SVGS[type];
    const svg = template.content.firstElementChild;
    if (svg) el.replaceWith(svg);
  }
  return parsed.body.innerHTML;
};

export const asciidoctorRenderer: Renderer = {
  async render(source: string, context: RenderContext): Promise<RenderResult> {
    let lineMap: number[] | null = null;

    // Asciidoctor safe mode: config-file override via
    // userConfig.asciidocSafeMode (set-and-forget knob, no UI), falling
    // back to 'unsafe' which allows all features (docinfo, book-mode
    // doctype, includes across directories, etc.). Valid values per
    // Asciidoctor: unsafe / safe / server / secure.
    //
    // attributes is typed as Record<string, unknown> so we can spread
    // additional keys (docname, docfile, docdir) onto it below without
    // TS narrowing it to the initial `{ showtitle: boolean }` literal
    // shape. Asciidoctor attribute values span strings, numbers, and
    // booleans depending on the attribute, so unknown is the right
    // width here.
    const loadOpts: {
      safe: string;
      sourcemap: boolean;
      attributes: Record<string, unknown>;
    } = {
      safe: userConfig.asciidocSafeMode || 'unsafe',
      sourcemap: true,
      // icons: 'font' switches admonition rendering from text labels
      // to Font Awesome icon markup (<i class="fa icon-note"> etc.),
      // matching Asciidoctor's standard convention. Styling for the
      // resulting icons lives in styles.css — see the rules targeting
      // .admonitionblock td.icon [class^="fa icon-"].
      attributes: { showtitle: true, icons: 'font' },
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
      const docname = name.replace(/\.[^.]+$/, '');
      loadOpts.attributes = {
        ...loadOpts.attributes,
        docname,
        docfile: context.path,
        docdir: baseDir,
      };
    }

    // Load first (so we get the AST for the scroll-sync block map),
    // then convert. sourcemap=true is a TOP-LEVEL option to load(),
    // NOT nested under attributes — this is what makes Asciidoctor
    // annotate blocks with their source line numbers. Getting this
    // wrong silently produces blocks with null source locations.
    //
    // Asciidoctor's safe modes (unsafe/safe/server/secure) gate
    // parser-level features and were designed for a server-rendering
    // threat model where an untrusted user submits a document that a
    // trusted server processes on its own filesystem and serves to
    // other users. That model does not apply to Skrivro — this is
    // a single-user local editor where users edit their own files.
    // Restricting safe mode here would cripple legitimate features
    // (docinfo, book-mode doctype, includes across directories)
    // without providing real security gain, because the user can
    // already read any file the OS permits them to read via File →
    // Open.
    //
    // The real security layers are Content-Security-Policy (blocks
    // all network egress so nothing can phone home) and DOMPurify
    // on the render output (strips scripts and event handlers from
    // passthrough-injected HTML before it reaches the DOM). Those
    // are what protect against actual attacks. The safe mode here
    // is intentionally open.
    //
    // Users who want a stricter mode can override it via skrivro.conf.
    const doc = ad.load(source, loadOpts);
    // Swap Asciidoctor's font-icon admonition markers for inline
    // SVGs before sanitization — see replaceAdmonitionIcons above
    // for why. DOMPurify keeps <svg> and <path> elements by default
    // (verified with the Octicons used in GFM alerts), so the
    // injected markup survives the subsequent sanitize call.
    const rawHtml = replaceAdmonitionIcons(doc.convert({ standalone: false }));
    const html = DOMPurify.sanitize(rawHtml);

    // Capture the per-render state in closures. The caller invokes
    // buildBlockMap after injecting `html` into a container; we walk
    // the parsed `doc` AST against that container. translateEditorLine
    // looks up the flat-source line number for a given editor-source
    // line — identity when there were no includes (lineMap is null),
    // mapped otherwise.
    const capturedLineMap = lineMap;
    return {
      html,
      buildBlockMap: (rootElement: Element) => buildAsciidoctorBlockMap(doc, rootElement),
      translateEditorLine: (editorLine: number) =>
        capturedLineMap ? (capturedLineMap[editorLine - 1] ?? editorLine) : editorLine,
    };
  },

  clearCache() {
    includeCache = new Map<string, string>();
  },
};

// ================= MarkedRenderer =================
//
// Renders GitHub-Flavored Markdown via marked. No include-style
// preprocessing (Markdown has no direct equivalent of AsciiDoc's
// include:: directive), no per-path cache, no scroll-sync block
// map in this first cut — an empty map means syncPreviewToCaret
// returns silently for Markdown buffers, which is the intended
// "not supported yet" behavior. A fuller block map using marked's
// token tree is possible if/when scroll sync is needed here.

// marked options applied on every render:
//   gfm: true     — tables, strikethrough, task lists, autolinks,
//                   fenced code blocks
//   breaks: false — a single newline in source does NOT become a
//                   <br> in output; paragraphs still break on blank
//                   lines. Matches how most documentation is
//                   authored (soft-wrapped prose that should re-flow
//                   in the rendered output). GitHub itself uses
//                   breaks=true for comments/issues and breaks=false
//                   for repository Markdown; we're in
//                   documentation-rendering territory so false.
//   async: false  — marked supports async extensions; we have none,
//                   so this forces synchronous output (string, not
//                   Promise<string>) and TypeScript narrows the
//                   return type accordingly.
const MARKED_OPTIONS = { gfm: true, breaks: false, async: false } as const;

// ================= GFM alerts extension =================
//
// GitHub Flavored Markdown extends the blockquote syntax with
// "alerts" — blockquotes whose first line is `[!TYPE]` where TYPE is
// one of NOTE / TIP / IMPORTANT / WARNING / CAUTION. GitHub renders
// them as colored callouts with a labeled title. Base `marked`
// treats them as ordinary blockquotes, producing `[!IMPORTANT]` as
// visible text on the first line — correct per CommonMark, wrong
// per GFM. This block-level extension intercepts the pattern,
// strips the marker line, and emits custom markup styled by CSS.
//
// Extension shape: tokenizer + renderer pair registered via
// marked.use. The tokenizer runs BEFORE marked's standard
// blockquote tokenizer (extensions have priority), so if the
// pattern matches we claim the input; otherwise marked's default
// handling takes over and the blockquote renders normally.

// The five recognized alert types. Per the GFM spec the marker is
// case-sensitive — only exact uppercase `[!NOTE]` / `[!TIP]` etc.
// are recognized. Anything else (lowercase, typo, custom type)
// falls through to the default blockquote path and renders as a
// regular blockquote.
const GFM_ALERT_TYPES = ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'] as const;
type GfmAlertType = (typeof GFM_ALERT_TYPES)[number];

// Regex for the top of a GFM alert block.
//   ^           — must be at start of a line
//   > ?         — blockquote marker (space optional, matches GitHub's lenient form)
//   \[!(\w+)\]  — the type tag, captured (case matters; see comment above)
//   [^\n]*      — rest of the first line (GitHub ignores content here, but we allow it)
//   \n          — the newline ending that line
//   ((?:>[^\n]*(?:\n|$))*) — remaining blockquote lines, captured
const GFM_ALERT_RE = /^> ?\[!(\w+)\][^\n]*\n((?:> ?[^\n]*(?:\n|$))*)/;

// Octicon SVG markup per alert type, copied verbatim from GitHub's
// markdown API output (POST /markdown with GFM alerts as input).
// Inlined in the rendered HTML so the glyphs inherit `fill:
// currentColor` from the title's color rule — single color rule
// colors border, title text, AND icon together without extra
// per-icon styling.
const GFM_ALERT_OCTICONS: Record<GfmAlertType, string> = {
  NOTE: '<svg class="octicon octicon-info mr-2" viewBox="0 0 16 16" version="1.1" width="16" height="16" aria-hidden="true"><path d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm8-6.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM6.5 7.75A.75.75 0 0 1 7.25 7h1a.75.75 0 0 1 .75.75v2.75h.25a.75.75 0 0 1 0 1.5h-2a.75.75 0 0 1 0-1.5h.25v-2h-.25a.75.75 0 0 1-.75-.75ZM8 6a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z"></path></svg>',
  TIP: '<svg class="octicon octicon-light-bulb mr-2" viewBox="0 0 16 16" version="1.1" width="16" height="16" aria-hidden="true"><path d="M8 1.5c-2.363 0-4 1.69-4 3.75 0 .984.424 1.625.984 2.304l.214.253c.223.264.47.556.673.848.284.411.537.896.621 1.49a.75.75 0 0 1-1.484.211c-.04-.282-.163-.547-.37-.847a8.456 8.456 0 0 0-.542-.68c-.084-.1-.173-.205-.268-.32C3.201 7.75 2.5 6.766 2.5 5.25 2.5 2.31 4.863 0 8 0s5.5 2.31 5.5 5.25c0 1.516-.701 2.5-1.328 3.259-.095.115-.184.22-.268.319-.207.245-.383.453-.541.681-.208.3-.33.565-.37.847a.751.751 0 0 1-1.485-.212c.084-.593.337-1.078.621-1.489.203-.292.45-.584.673-.848.075-.088.147-.173.213-.253.561-.679.985-1.32.985-2.304 0-2.06-1.637-3.75-4-3.75ZM5.75 12h4.5a.75.75 0 0 1 0 1.5h-4.5a.75.75 0 0 1 0-1.5ZM6 15.25a.75.75 0 0 1 .75-.75h2.5a.75.75 0 0 1 0 1.5h-2.5a.75.75 0 0 1-.75-.75Z"></path></svg>',
  IMPORTANT: '<svg class="octicon octicon-report mr-2" viewBox="0 0 16 16" version="1.1" width="16" height="16" aria-hidden="true"><path d="M0 1.75C0 .784.784 0 1.75 0h12.5C15.216 0 16 .784 16 1.75v9.5A1.75 1.75 0 0 1 14.25 13H8.06l-2.573 2.573A1.458 1.458 0 0 1 3 14.543V13H1.75A1.75 1.75 0 0 1 0 11.25Zm1.75-.25a.25.25 0 0 0-.25.25v9.5c0 .138.112.25.25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h6.5a.25.25 0 0 0 .25-.25v-9.5a.25.25 0 0 0-.25-.25Zm7 2.25v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 9a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"></path></svg>',
  WARNING: '<svg class="octicon octicon-alert mr-2" viewBox="0 0 16 16" version="1.1" width="16" height="16" aria-hidden="true"><path d="M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"></path></svg>',
  CAUTION: '<svg class="octicon octicon-stop mr-2" viewBox="0 0 16 16" version="1.1" width="16" height="16" aria-hidden="true"><path d="M4.47.22A.749.749 0 0 1 5 0h6c.199 0 .389.079.53.22l4.25 4.25c.141.14.22.331.22.53v6a.749.749 0 0 1-.22.53l-4.25 4.25A.749.749 0 0 1 11 16H5a.749.749 0 0 1-.53-.22L.22 11.53A.749.749 0 0 1 0 11V5c0-.199.079-.389.22-.53Zm.84 1.28L1.5 5.31v5.38l3.81 3.81h5.38l3.81-3.81V5.31L10.69 1.5ZM8 4a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 8 4Zm0 8a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z"></path></svg>',
};

// Register the extension at module load. marked.use merges the
// tokenizer + renderer into marked's global config. Called once;
// subsequent marked.parse calls pick it up automatically.
marked.use({
  extensions: [
    {
      name: 'gfmAlert',
      level: 'block',
      // Fast-path detector — marked calls start() on the input to
      // decide whether to invoke the tokenizer. Return the index
      // where the token begins, or undefined to skip. Matching
      // "> [!" covers the pattern's entry point without running
      // the full regex on every block.
      start(src: string): number | undefined {
        const m = /^> ?\[!/m.exec(src);
        return m ? m.index : undefined;
      },
      // Full tokenizer. Returns the alert token, or undefined to
      // fall through to the default blockquote handler (which
      // happens when the TYPE tag isn't one of the recognized
      // values — a typo like `> [!NTO]` or a lowercase `> [!note]`
      // renders as a normal blockquote with the raw marker visible,
      // matching GitHub's behavior for unrecognized / wrong-case
      // markers).
      //
      // `this: any` and `token: any` — marked's extension API types
      // don't narrow cleanly through the `{ extensions: [...] }`
      // shape, and typing the custom token precisely would require
      // declaration merging into marked's Tokens namespace. Our
      // codebase already uses `any` at external-library boundaries
      // (see eslint.config.js). The property accesses inside are
      // checked against the local shape we constructed, so the
      // runtime contract is intact.
      tokenizer(this: any, src: string) {
        const match = GFM_ALERT_RE.exec(src);
        if (!match) return undefined;
        // No .toUpperCase() — the GFM spec treats the type tag as
        // case-sensitive. Lowercase `[!note]` or mixed-case `[!Note]`
        // intentionally fails to match here and falls through to
        // marked's default blockquote handler.
        const rawType = match[1] ?? '';
        if (!GFM_ALERT_TYPES.includes(rawType as GfmAlertType)) return undefined;
        const type = rawType as GfmAlertType;

        // Strip the leading `> ` (with optional space) from each
        // remaining line to recover the alert body as ordinary
        // markdown. Trailing newlines are preserved — downstream
        // markdown parsing handles paragraph breaks normally.
        const body = (match[2] ?? '').replace(/^> ?/gm, '');

        // Recursively lex the body so nested markdown (lists,
        // code, emphasis, links) inside the alert works. `this.lexer`
        // is marked's lexer context; blockTokens parses the string
        // as a block-level markdown document.
        const tokens = this.lexer.blockTokens(body);

        return {
          type: 'gfmAlert',
          raw: match[0],
          alertType: type,
          tokens,
        };
      },
      // Renderer. marked hands us the token; we return the HTML
      // string. `this.parser.parse(tokens)` re-serializes the
      // nested tokens the tokenizer captured, preserving full
      // markdown semantics inside the alert body.
      renderer(this: any, token: any): string {
        const type = token.alertType as GfmAlertType;
        const lower = type.toLowerCase();
        // Title shown at the top of the alert block — GitHub uses
        // capitalized-first-letter form ("Note", "Tip", etc.).
        const title = type.charAt(0) + type.slice(1).toLowerCase();
        const icon = GFM_ALERT_OCTICONS[type];
        const body = this.parser.parse(token.tokens) as string;
        // Class names match GitHub's rendered HTML (`markdown-alert`
        // prefix, `markdown-alert-<type>` per variant, title in a
        // `<p class="markdown-alert-title">`) so downstream tooling
        // and anyone familiar with GitHub's output recognizes the
        // shape.
        return `<div class="markdown-alert markdown-alert-${lower}">` +
               `<p class="markdown-alert-title">${icon}${title}</p>` +
               body +
               '</div>';
      },
    },
  ],
});

// ================= Emoji shortcodes extension =================
//
// GitHub-style `:name:` shortcodes in markdown source render as the
// corresponding unicode emoji. The shortcode list is `nameToEmoji`
// from gemoji, a mirror of github/gemoji (the same Ruby gem
// github.com itself uses) — about 1900 entries covering every
// unicode-standard emoji and its GitHub-recognized aliases.
//
// Renderer returns the raw codepoint, so the output is a literal
// unicode character — no <img> tags, no font dependencies, no
// network access. The system emoji font handles glyph display
// (Segoe UI Emoji on Windows, Apple Color Emoji on macOS, Noto
// Color Emoji on Linux). All three are already in our --font-sans
// fallback chain (see styles.css).
//
// GitHub's custom non-unicode shortcodes (:octocat:, :shipit:,
// :trollface:) are NOT in nameToEmoji because they have no unicode
// codepoint — they exist only as PNGs hosted on GitHub. Those names
// pass through unchanged as literal `:octocat:` text. Supporting
// them would require bundling images and rules out the offline
// guarantee, so they're intentionally excluded.
//
// The extension is inline-level (matches inside paragraphs, not
// just at block boundaries) and only claims input where the name
// between colons is in the emoji list — unknown names like
// `:notarealemoji:` fall through unchanged.
marked.use(markedEmoji({
  emojis: nameToEmoji,
  renderer: (token: { emoji: string }) => token.emoji,
}));

export const markedRenderer: Renderer = {
  // Not declared async because nothing in the body awaits anything;
  // marked.parse with async: false is synchronous and DOMPurify is
  // also synchronous. Return Promise.resolve to match the Renderer
  // interface's Promise-returning contract.
  render(source: string, _context: RenderContext): Promise<RenderResult> {
    // marked.parse with async: false returns string synchronously;
    // the overload resolution narrows the return type so no cast
    // is needed. DOMPurify sanitization matches the AsciidoctorRenderer
    // path — same HTML-injection protections for either format.
    const rawHtml = marked.parse(source, MARKED_OPTIONS);
    const html = DOMPurify.sanitize(rawHtml);

    return Promise.resolve({
      html,
      // Scroll-sync block map: empty for now. syncPreviewToCaret
      // guards on blockMap.length, so an empty map silently no-ops
      // the sync action in Markdown buffers.
      buildBlockMap: () => [],
      // No source transformation happens in Markdown rendering (unlike
      // AsciiDoc's include expansion), so editor and output line
      // coordinates coincide — identity translation is correct.
      translateEditorLine: (editorLine: number) => editorLine,
    });
  },

  clearCache() {
    // No per-path state to invalidate.
  },
};

// ================= TextRenderer =================
//
// Pass-through renderer for buffers the user has marked as plain
// text. The preview mirrors the source verbatim in a monospace
// block — no parsing, no transformation. AsciiDoc or Markdown
// syntax typed in a text-mode buffer stays literal in the preview.

// HTML-entity escape for interpolation into the <pre> output. Same
// set of metacharacters preview.ts's error-display path escapes,
// kept as a local helper here so TextRenderer doesn't reach into
// another module. Record<string, string> typing satisfies strict
// mode's noUncheckedIndexedAccess; the `?? c` fallback is defensive
// and unreachable given the regex class.
const TEXT_ESCAPE_MAP: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
const escapeForPre = (s: string): string =>
  s.replace(/[&<>]/g, (c) => TEXT_ESCAPE_MAP[c] ?? c);

export const textRenderer: Renderer = {
  // Not declared async for the same reason as markedRenderer — no
  // awaits inside, Promise.resolve matches the interface contract.
  render(source: string, _context: RenderContext): Promise<RenderResult> {
    // Wrap the escaped source in <pre class="text-verbatim">. The
    // class is a hook for future styling — CSS can target it to
    // adjust font or spacing specifically in text mode without
    // touching the generic <pre> used by AsciiDoc listing blocks.
    // DOMPurify pass is redundant here (our escape produces only
    // entity references, no injection vectors) but cheap and keeps
    // the output path uniform with the other renderers.
    const html = DOMPurify.sanitize(`<pre class="text-verbatim">${escapeForPre(source)}</pre>`);

    return Promise.resolve({
      html,
      buildBlockMap: () => [],
      translateEditorLine: (editorLine: number) => editorLine,
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
// adding a Renderer implementation above and a case here; preview.ts
// doesn't change.
//
// The switch is exhaustive over the Format union — TypeScript will
// flag any missing case if Format gains a new member.
export const getRenderer = (format: Format): Renderer => {
  switch (format) {
    case 'markdown': return markedRenderer;
    case 'text':     return textRenderer;
    case 'asciidoc': return asciidoctorRenderer;
  }
};

// Invalidate every renderer's per-path cache. Called from io.ts on
// file operations that change the buffer's identity (open, save-as,
// new, reload, :e filename) so stale cached state doesn't bleed
// across buffers. Only asciidoctorRenderer has a cache worth
// clearing today; markdown and text no-op. Calling the set lets
// io.ts stay agnostic about which renderer holds cacheable state.
const ALL_RENDERERS: readonly Renderer[] = [
  asciidoctorRenderer,
  markedRenderer,
  textRenderer,
];

export const clearAllRendererCaches = (): void => {
  for (const r of ALL_RENDERERS) r.clearCache();
};
