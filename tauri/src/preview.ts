// ================= Preview =================
// Preview pane orchestration: calls the active Renderer for source-
// to-HTML conversion, injects the result into the preview container,
// manages scroll-sync state, and handles external-link delegation.
// Markup-specific rendering (AsciiDoc include preprocessing, AST walks,
// DOMPurify, etc.) lives in renderer.ts — preview.ts only knows about
// the Renderer interface.

import { open as shellOpen } from '@tauri-apps/plugin-shell';
import { convertFileSrc } from '@tauri-apps/api/core';
import { dirname, resolve } from '@tauri-apps/api/path';

import { getDoc, editorView } from './editor.js';
import { currentBuffer } from './io.js';
import { asciidoctorRenderer, type BlockMapEntry } from './renderer.js';
import { updateWordCount } from './ui.js';

// DOM refs owned by preview.ts. Non-null assertions (`!`) because
// both IDs are in our HTML and the module runs after body parse.
const out = document.getElementById('out')!;
const statusSyncIndicator = document.getElementById('statusSyncIndicator')!;

// Escape HTML metacharacters for safe interpolation into an HTML
// string (the render-error fallback below injects into innerHTML).
// The Record<string, string> type on the lookup is what lets TS
// accept the dynamic `ESCAPE_MAP[c]` index — an object literal with
// specific keys can't be indexed by arbitrary strings under strict
// mode. `?? c` fallback is defensive; the regex only matches the
// three characters we have mappings for, so the fallback is
// unreachable at runtime.
const ESCAPE_MAP: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
const escapeHtml = (s: string) =>
  s.replace(/[&<>]/g, (c: string) => ESCAPE_MAP[c] ?? c);

// ================= Render timer =================

let renderTimer: ReturnType<typeof setTimeout> | null = null;

// ================= Scroll-sync state =================
// Populated by each successful render via the Renderer's callbacks.
// blockMap is consumed by syncPreviewToCaret's binary search;
// translateEditorLine converts editor-source lines into the coordinate
// system blockMap.line uses (identity for renderers that don't
// transform source, include-aware for AsciiDoc).
let blockMap: BlockMapEntry[] = [];
let translateEditorLine: (editorLine: number) => number = (n) => n;

// ================= Render =================

export const render = async () => {
  try {
    const source = getDoc();
    const result = await asciidoctorRenderer.render(source, { path: currentBuffer.path });

    // Image path post-processing.
    //
    // Renderers emit <img src="..."> with paths that are either
    // relative to the document's base directory or absolute filesystem
    // paths. Either way, the browser resolves them against the current
    // page URL (tauri://localhost/) and hits Tauri's SPA-fallback
    // handler, which returns our own index.html for any unresolved
    // path and the image silently fails to load. To actually reach
    // files on disk we have to rewrite the src attributes to use
    // Tauri's asset protocol via convertFileSrc().
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
    //
    // This DOM post-processing is format-agnostic — applies equally to
    // whatever HTML the active renderer produced — so it lives in
    // preview.ts rather than in a specific renderer implementation.
    if (currentBuffer.path) {
      const baseDir = await dirname(currentBuffer.path);
      const wrapper = document.createElement('div');
      wrapper.innerHTML = result.html;
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
      out.innerHTML = result.html;
    }

    blockMap = result.buildBlockMap(out);
    translateEditorLine = result.translateEditorLine;
    updateWordCount();
  } catch (e) {
    console.error('render failed:', e);
    // Catch variable is `unknown` under strict mode. Narrow to Error
    // to pull a message, else coerce to string as a last resort.
    const msg = e instanceof Error ? e.message : String(e);
    out.innerHTML =
      `<pre class="render-error">Render error: ${escapeHtml(msg)}</pre>`;
    blockMap = [];
    // Intentionally not updating word count on render error — the
    // error message's word count is meaningless, so leaving the
    // previous successful value feels less jarring than showing
    // "3 words" for whatever text is in the <pre class="render-error">.
  }
};

export const scheduleRender = () => {
  if (renderTimer !== null) clearTimeout(renderTimer);
  renderTimer = setTimeout(render, 100);
};

// ================= Scroll sync =================
// Sync-once: snap the preview to the block containing (or nearest
// preceding) the editor caret's source line. Triggered by Ctrl+Alt+L,
// the :syncpreview Ex command, or gz in vim normal mode. NOT a
// continuous sync — both panes stay independently scrollable and we
// don't touch them unless the user asks.

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
// The Renderer supplies translateEditorLine (captured at render time)
// to handle coordinate-system differences. For AsciiDoc with includes,
// the editor cursor is positioned against the ROOT document source,
// but blockMap line numbers come from Asciidoctor's source map, which
// reflects the FLATTENED (post-include-expansion) source. The two
// coordinate systems diverge after the first include expansion —
// editor line N could map to flat line N+500 if the first include
// expanded to 500 lines of content. translateEditorLine applies the
// include line map. For renderers that don't transform source, it's
// the identity function.
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
  const caretLine = translateEditorLine(editorCaretLine);
  let lo = 0, hi = blockMap.length - 1, found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    // blockMap[mid] and blockMap[found] both safe: mid = (lo+hi)>>1
    // with lo ≥ 0, hi < blockMap.length; found starts 0 and only
    // advances to a valid mid. noUncheckedIndexedAccess can't prove
    // any of that, so the `!` documents the invariant.
    if (blockMap[mid]!.line <= caretLine) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const target = blockMap[found]!.el;
  if (target) target.scrollIntoView({ block: 'start' });
};

// ================= External link handling =================
//
// Hand off clicks on http(s) links in the preview pane to the user's
// system browser via the Tauri shell plugin. Without this, clicking
// a link in a rendered document does nothing: Tauri 2 blocks webview
// navigation to arbitrary external URLs by default as a security
// measure (preventing phishing-style webview hijacking), so default
// click behavior on an external <a> is silently swallowed.
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
