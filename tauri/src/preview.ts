// ================= Preview =================
// Asciidoctor integration: rendering, include preprocessing, scroll
// sync. Owns the preview <div> DOM element and the block-map used for
// sync-once navigation from editor caret to preview position.

import Asciidoctor from '@asciidoctor/core';
import DOMPurify from 'dompurify';

import { readTextFile } from '@tauri-apps/plugin-fs';
import { open as shellOpen } from '@tauri-apps/plugin-shell';
import { basename, dirname, resolve } from '@tauri-apps/api/path';
import { convertFileSrc } from '@tauri-apps/api/core';

import { getDoc, editorView } from './editor.js';
import { currentPath } from './io.js';
import { userConfig } from './config.js';
import { updateWordCount } from './ui.js';

const ad = Asciidoctor();

// DOM refs owned by preview.ts. Non-null assertions (`!`) because
// both IDs are in our HTML and the module runs after body parse.
const out = document.getElementById('out')!;
const statusSyncIndicator = document.getElementById('statusSyncIndicator')!;

const escapeHtml = (s) =>
  s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// ================= Render timer =================

let renderTimer = null;

// ================= Include preprocessing state =================
//
// Must run BEFORE Asciidoctor sees the source. Asciidoctor.js's
// browser-side include reader uses synchronous XMLHttpRequest against
// the current page URL; in our Tauri webview the page URL is our own
// index.html, served via Tauri's asset protocol, which has SPA-style
// fallback: any unresolved path returns index.html with a 200 status.
// The result is that every `include::` directive silently "resolves"
// to our own built HTML, which Asciidoctor parses as AsciiDoc content
// and splices into the preview. See memory/project_asciidoctor_includes.md
// for the full story.
//
// Fix: we read each include target directly via Tauri's readTextFile
// (which goes through the actual filesystem, not through the SPA-
// fallback trap), apply any include attributes (lines=, tag=, tags=,
// indent=, leveloffset=), and splice the resolved content inline.
// By the time Asciidoctor sees the source there are no include::
// directives left, so its broken browser include reader never runs.
//
// Caching: includeCache persists file content by absolute path across
// renders. Without this, editing the root document in a 100-chapter
// book would trigger 100 disk reads per keystroke. Cleared explicitly
// on file-open / :e / reload / newFile via clearIncludeCache().
//
// Line mapping: preprocessSource builds includeLineMap so scroll-sync
// can translate editor cursor positions to flat-source line numbers.
// Without it, scroll-sync would point at wrong blocks after the
// first include expansion.
let includeCache = new Map();
let includeLineMap = null;

export const clearIncludeCache = () => {
  includeCache = new Map();
  includeLineMap = null;
};

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
      if (m) minIndent = Math.min(minIndent, m[1].length);
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
const expandOneInclude = async (target, attrsRaw, baseDir, cycle) => {
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
    return `// Unresolved include: ${target} (${(e && e.message) || e})`;
  }
};

// Expand include directives inside content that itself came from an
// expanded include. This variant does NOT build a line map — nested
// includes are invisible to the editor's cursor position, so their
// internal line coordinates aren't needed for scroll sync.
const expandRecursively = async (source, baseDir, cycle) => {
  const includeRe = /^include::([^\[\n]+)\[([^\]]*)\]\s*$/;
  const lines = source.split('\n');
  const out = [];
  for (const line of lines) {
    const m = line.match(includeRe);
    if (m) {
      out.push(await expandOneInclude(m[1].trim(), m[2], baseDir, cycle));
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
const preprocessSource = async (rootSource, baseDir) => {
  const includeRe = /^include::([^\[\n]+)\[([^\]]*)\]\s*$/;
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
    const line = rootLines[i];
    const m = line.match(includeRe);
    if (m) {
      lineMap[i] = flatLine;
      let expanded = await expandOneInclude(m[1].trim(), m[2], baseDir, new Set());
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

// ================= Render =================

export const render = async () => {
  try {
    let source = getDoc();
    // Pre-expand `include::` directives if we know where the document
    // lives on disk. Without a currentPath, we have no base directory
    // for resolving relative include paths, so we skip preprocessing
    // and let Asciidoctor see the raw source — which for any document
    // with includes means the SPA-fallback trap will bleed our own
    // HTML into the preview. Save the document first if you're
    // working with includes in an unsaved-new buffer.
    let lineMap = null;
    let baseDir = null;
    // Asciidoctor safe mode: config-file override via
    // userConfig.asciidocSafeMode (set-and-forget knob, no UI), falling
    // back to 'unsafe' which allows all features (docinfo, book-mode
    // doctype, includes across directories, etc.). Valid values per
    // Asciidoctor: unsafe / safe / server / secure. See
    // memory/project_config_file.md for why safe mode is config-only.
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

    if (currentPath) {
      baseDir = await dirname(currentPath);
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
      // docname to the basename (without extension) of currentPath
      // makes the ifeval pattern work as the document author
      // intended.
      const name = await basename(currentPath);
      const docname = name.replace(/\.[^.]+$/, '');
      loadOpts.attributes = {
        ...loadOpts.attributes,
        docname,
        docfile: currentPath,
        docdir: baseDir,
      };
    }
    includeLineMap = lineMap;

    // Load first (so we get the AST for the scroll-sync block map),
    // then convert. sourcemap=true is a TOP-LEVEL option to load(),
    // NOT nested under attributes — this is what makes Asciidoctor
    // annotate blocks with their source line numbers. Getting this
    // wrong silently produces blocks with null source locations.
    // safe: 'unsafe' allows all Asciidoctor features: docinfo
    // injection, custom :doctype: (e.g. book), :source-highlighter:,
    // image:: with absolute paths, and so on.
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
    // This is also a planned config-file knob — users who prefer a
    // stricter mode can override it via skrivro.conf (see the
    // config spec in memory).
    const doc = ad.load(source, loadOpts);
    const html = DOMPurify.sanitize(doc.convert({ standalone: false }));

    // Image path post-processing.
    //
    // Asciidoctor emits <img src="..."> with paths that are either
    // relative to :imagesdir: or absolute filesystem paths. Either
    // way, the browser resolves them against the current page URL
    // (tauri://localhost/) and hits Tauri's SPA-fallback handler,
    // which returns our own index.html for any unresolved path and
    // the image silently fails to load. To actually reach files on
    // disk we have to rewrite the src attributes to use Tauri's
    // asset protocol via convertFileSrc().
    //
    // Pattern: parse the rendered HTML into a detached wrapper
    // element, walk its <img> elements, rewrite any relative or
    // absolute-filesystem src to a Tauri asset URL, then move the
    // children to `out`. Doing this in a detached element avoids
    // a flash of broken images — browsers don't start loading image
    // src values until the node is attached to a displayed document.
    //
    // URLs with an explicit scheme (http://, https://, data:, etc.)
    // are left alone — those are genuine external URLs that should
    // either be loaded via CSP-allowed origins or blocked by CSP if
    // they're not. Our asset-protocol rewrite is only for paths that
    // look like local files (no scheme).
    //
    // Requires tauri.conf.json to have `app.security.assetProtocol`
    // enabled with an appropriate scope — without that, the Tauri
    // backend won't serve files at the rewritten URLs.
    if (baseDir) {
      const wrapper = document.createElement('div');
      wrapper.innerHTML = html;
      for (const img of wrapper.querySelectorAll('img')) {
        const src = img.getAttribute('src');
        if (!src) continue;
        // Skip URLs with any scheme (http, https, data, asset, etc.).
        // The RFC 3986 scheme regex: starts with a letter, followed
        // by letters/digits/+/-/., then a colon.
        if (/^[a-z][a-z0-9+.-]*:/i.test(src)) continue;
        try {
          const absPath = await resolve(baseDir, src);
          img.setAttribute('src', convertFileSrc(absPath));
        } catch (e) {
          console.warn('Failed to resolve image path:', src, e);
        }
      }
      out.replaceChildren(...wrapper.childNodes);
    } else {
      out.innerHTML = html;
    }

    buildBlockMap(doc);
    updateWordCount();
  } catch (e) {
    console.error('render failed:', e);
    out.innerHTML =
      `<pre class="render-error">Render error: ${escapeHtml(e.message || String(e))}</pre>`;
    blockMap = [];
    // Intentionally not updating word count on render error — the
    // error message's word count is meaningless, so leaving the
    // previous successful value feels less jarring than showing
    // "3 words" for whatever text is in the <pre class="render-error">.
  }
};

export const scheduleRender = () => {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(render, 100);
};

// ================= Scroll sync =================
// Sync-once: snap the preview to the block containing (or nearest
// preceding) the editor caret's source line. Triggered by Ctrl+Alt+L,
// the :syncpreview Ex command, or gz in vim normal mode. NOT a
// continuous sync — both panes stay independently scrollable and we
// don't touch them unless the user asks.

const MAPPABLE_CONTEXTS = new Set([
  'paragraph', 'listing', 'literal', 'example', 'sidebar',
  'admonition', 'quote', 'verse', 'image', 'ulist', 'olist', 'dlist',
  'section', 'open', 'table',
]);

const DOM_BLOCK_SELECTOR = [
  '.paragraph', '.listingblock', '.literalblock', '.exampleblock',
  '.sidebarblock', '.admonitionblock', '.quoteblock', '.verseblock',
  '.imageblock', '.ulist', '.olist', '.dlist',
  '.sect1', '.sect2', '.sect3', '.sect4', '.sect5',
  '.openblock', 'table.tableblock',
].join(', ');

let blockMap = []; // Array<{ line: number, el: Element }>, sorted by line

// Walk the parsed AST and the rendered DOM in parallel, building a
// map from source line to preview block element. Walks the tree
// manually via getBlocks() rather than findBy() for robustness
// against API surprises. Relies on Asciidoctor emitting blocks in
// document order in both the AST walk and the rendered HTML (via
// querySelectorAll). The i-th matching AST block aligns with the
// i-th matching DOM element.
const buildBlockMap = (doc) => {
  try {
    const ast = [];
    const walk = (block) => {
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

    const dom = Array.from(out.querySelectorAll(DOM_BLOCK_SELECTOR));
    const map = [];
    const n = Math.min(ast.length, dom.length);
    for (let i = 0; i < n; i++) {
      try {
        const line = ast[i].getSourceLocation().getLineNumber();
        if (typeof line === 'number') {
          map.push({ line, el: dom[i] });
        }
      } catch {}
    }
    map.sort((a, b) => a.line - b.line);
    blockMap = map;
    console.log(`[skrivro] buildBlockMap: ast=${ast.length} dom=${dom.length} map=${map.length}`);
  } catch (e) {
    console.error('buildBlockMap failed:', e);
    blockMap = [];
  }
};

// Flash the status bar's sync indicator — a one-shot CSS animation
// that briefly brightens the → glyph from its dim resting color to
// the Catppuccin teal, then decays back over ~500ms. The flash
// confirms the user's keystroke even when the preview doesn't
// visibly move (e.g., the caret line was already at the top of the
// visible block, so scrollIntoView is a no-op).
//
// CSS-animation restart trick: removing and re-adding the `flashing`
// class in the same tick doesn't re-trigger the animation because
// the browser batches the class changes. Forcing a synchronous
// reflow via `void element.offsetWidth` between the remove and the
// add flushes the pending style changes, so the subsequent add is
// recognized as a state transition and the animation fires again.
// This is the canonical pattern for "restart a CSS animation from
// JS" — ugly but stable across every browser we target.
const flashSync = () => {
  if (!statusSyncIndicator) return;
  statusSyncIndicator.classList.remove('flashing');
  void statusSyncIndicator.offsetWidth;
  statusSyncIndicator.classList.add('flashing');
};

// Binary search for the greatest block with line <= caretLine, then
// scroll its DOM element to the top of the preview viewport.
//
// Include-aware translation: blockMap line numbers come from
// Asciidoctor's source map, which reflects the FLATTENED (post-
// include-expansion) source. The editor cursor is positioned
// against the ROOT document source. For documents with includes,
// the two line-number coordinate systems diverge after the first
// include expansion — editor line N could map to flat line N+500
// if the first include expanded to 500 lines of content. We use
// includeLineMap (built by preprocessSource) to translate the
// editor's caret line into the flat-source coordinate system
// before the binary search. Without this, scroll-sync on a
// post-include editor position would silently land on the wrong
// block. For documents with no includes, includeLineMap is null
// and we use the editor line directly (identity translation).
export const syncPreviewToCaret = () => {
  if (!blockMap.length || !editorView) return;
  // Flash the sync indicator after the guards pass — the guards
  // protect against no-op invocations (empty document, pre-init
  // editor) where the sync command is semantically meaningless.
  // Any invocation that gets past them is a "real" sync attempt
  // that deserves feedback, regardless of whether the preview
  // actually ends up scrolling to a new position.
  flashSync();
  const pos = editorView.state.selection.main.head;
  const editorCaretLine = editorView.state.doc.lineAt(pos).number;
  const caretLine = includeLineMap
    ? (includeLineMap[editorCaretLine - 1] || editorCaretLine)
    : editorCaretLine;
  let lo = 0, hi = blockMap.length - 1, found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (blockMap[mid].line <= caretLine) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const target = blockMap[found].el;
  if (target) target.scrollIntoView({ block: 'start' });
};

// ================= External link handling =================
//
// Hand off clicks on http(s) links in the preview pane to the user's
// system browser via the Tauri shell plugin. Without this, clicking
// a link in a rendered AsciiDoc document does nothing: Tauri 2 blocks
// webview navigation to arbitrary external URLs by default as a
// security measure (preventing phishing-style webview hijacking), so
// default click behavior on an external <a> is silently swallowed.
//
// Delegation (listener on the preview container, closest() lookup)
// catches every re-render's links without re-attaching per-render.
// Only http:// and https:// schemes are intercepted — fragment links
// (#section) fall through to default scroll-to-anchor behavior, and
// other schemes (mailto:, ftp:, etc.) are left to whatever the
// webview does with them (usually nothing, which is fine).
//
// Requires the `shell:allow-open` capability to have been granted
// with a URL scope that permits the href we're opening. See
// src-tauri/capabilities/default.json — scoped to ^https?:// so that
// the shell plugin will only hand off web URLs to the OS, not e.g.
// file:// URLs that could be used to open arbitrary local files.
out.addEventListener('click', (e) => {
  // e.target is typed as EventTarget, which doesn't have closest().
  // Narrow to Element to get closest() — and to guard against the
  // runtime case where the target is something exotic (a Document or
  // Window, say) that isn't in the DOM tree.
  if (!(e.target instanceof Element)) return;
  const a = e.target.closest('a');
  if (!a) return;
  const href = a.getAttribute('href');
  if (!href) return;
  if (/^https?:\/\//i.test(href)) {
    e.preventDefault();
    shellOpen(href).catch((err) =>
      console.error('Failed to open external URL:', href, err));
  }
});
