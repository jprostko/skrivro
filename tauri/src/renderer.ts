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

import { readTextFile } from '@tauri-apps/plugin-fs';
import { basename, dirname, resolve } from '@tauri-apps/api/path';

import { userConfig } from './config.js';

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
      attributes: { showtitle: true },
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
    const html = DOMPurify.sanitize(doc.convert({ standalone: false }));

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
