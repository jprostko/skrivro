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

import { userConfig } from './config.js';
import { getDoc, editorView } from './editor.js';
import { tr } from './i18n.js';
import { currentBuffer } from './io.js';
import { getRenderer, type BlockMapEntry } from './renderer.js';
import { updateWordCount, setLastTocPosition } from './ui.js';

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

// Replace a blocked-by-the-image-gate <img> with an inline <span>
// placeholder. The visible text shows the alt text (or the URL when
// no alt was supplied) plus the literal config-key name so users
// who land on this with no prior knowledge have a search term that
// will hit the docs / config file / FAQ. The title attribute (browser
// tooltip on hover) gives the full URL and the explicit instruction
// for how to enable, since hover discoverability is bad enough that
// the visible text needs to stand on its own.
//
// Localization: the surrounding chrome ("image blocked", "see",
// "External image blocked", and the full instruction sentence) is
// translated via tr(); the literal `allow-external-images` config-
// key name stays English, matching item #13's policy that input
// syntax doesn't translate (the user types this string into their
// config file regardless of their UI language).
//
// textContent / setAttribute (not innerHTML) so the content can't
// smuggle markup back in. The .image-placeholder class is a hook for
// theme-side styling — currently unstyled, the user sees the
// bracketed text rendered as plain inline content. The `\n` in the
// title text is honored as a line break by WebKit-family browsers'
// native tooltips.
const replaceImgWithPlaceholder = (img: Element, src: string): void => {
  const span = document.createElement('span');
  span.className = 'image-placeholder';
  const label = img.getAttribute('alt') || src;
  span.textContent =
    `[${tr('image blocked')}: ${label} (${tr('see')} allow-external-images)]`;
  span.title =
    `${tr('External image blocked')}: ${src}\n` +
    tr('To render, set allow-external-images = true in skrivro.conf and restart.');
  img.replaceWith(span);
};

// ================= Render timer =================

let renderTimer: ReturnType<typeof setTimeout> | null = null;

// ================= Scroll-sync state =================
// Scroll-sync state, populated lazily — the block map and
// translateEditorLine callback are supplied by each render's Renderer
// result but computed on demand the first time syncPreviewToCaret
// runs after a render. Users who never trigger sync pay zero cost for
// the map build; sync users pay the build cost once per render cycle,
// then reuse the cached map across repeated sync triggers until the
// next render invalidates it.
//
// `blockMap = null` means "not yet built" (either initial state or
// invalidated by a recent render). `latestBuildBlockMap === null`
// means no render has completed yet (fresh app launch, pre-first-
// render). After any successful render, latestBuildBlockMap holds the
// builder closure from result.buildBlockMap, ready to compute the
// map on demand.
let blockMap: BlockMapEntry[] | null = null;
let latestBuildBlockMap: ((rootElement: Element) => BlockMapEntry[]) | null = null;
let translateEditorLine: (editorLine: number) => number = (n) => n;

// "Scroll preview to top on next render" flag. Browsers preserve the
// preview's scrollTop as a literal pixel value across content
// replacement; combined with the scroll-past-end spacer, that means
// opening a short file after scrolling deep into a long one can land
// the viewport in the new file's spacer region (entirely blank). File-
// load entry points (openFile/Ctrl+O, newFile/Ctrl+N, drag-drop,
// :e filename, initial session-restore launch) call
// requestPreviewScrollToTop() to queue a reset; render() consumes the
// flag right after writing the new HTML, so the reset lands on the
// fresh content. Intentionally NOT set by edits, saves, or format
// toggles — those keep the user's current scroll position.
let pendingScrollToTop = false;
export const requestPreviewScrollToTop = () => {
  pendingScrollToTop = true;
};

// Monotonically-increasing token. Each render invocation claims a
// token at entry; after the async render completes it checks the
// token is still current before writing to the DOM. A newer render
// (fired by file open, format toggle, or further edits) advances the
// counter, making any still-in-flight older render a no-op on
// completion. Without this, a slow renderer (asciidoctor can take
// 50-200ms for include-heavy docs) started with stale format/source
// can finish AFTER a fast markdown render and overwrite its output —
// the preview ends up showing asciidoctor output for a markdown
// buffer (or equivalent cross-contamination).
let renderToken = 0;

// ================= Render =================

export const render = async () => {
  const myToken = ++renderToken;
  try {
    const source = getDoc();
    // Format-keyed dispatch — the active renderer is chosen per-
    // render based on currentBuffer.format, which is populated from
    // file extension (or the default-format config) and can be
    // changed at runtime via the format toggle / Ex commands.
    const result = await getRenderer(currentBuffer.format).render(source, { path: currentBuffer.path });

    // Staleness check: if a newer render fired while we were awaiting
    // (because the user opened a different file, toggled format, or
    // rapidly edited), abort — let the newer render's output be
    // authoritative. Otherwise this render's now-stale HTML would
    // clobber the fresher result.
    if (myToken !== renderToken) return;

    // Image post-processing — two passes in one walk:
    //
    //   1. Rewrite scheme-less paths (relative or absolute filesystem)
    //      to Tauri asset:// URLs via convertFileSrc(). Renderers emit
    //      <img src="..."> with paths that the browser would otherwise
    //      resolve against tauri://localhost/ and hit Tauri's SPA-
    //      fallback handler (returning index.html as the "image"); the
    //      asset-protocol rewrite is what makes local images actually
    //      load. Requires tauri.conf.json to have
    //      `app.security.assetProtocol` enabled (it is).
    //
    //   2. Gate scheme-having URLs based on which scheme they use:
    //        - data:, asset: — always allow (inline data URIs and
    //          Tauri's own asset protocol are both safe and intended)
    //        - https: — allow only if userConfig.allowExternalImages
    //          is true; otherwise replace with an inline placeholder
    //        - http: — always replace with an inline placeholder
    //          (HTTPS-only policy: no opt-in for HTTP, even if
    //          allowExternalImages is true)
    //        - anything else (file:, ftp:, etc.) — placeholder
    //
    //      Replacing in the detached wrapper element BEFORE attaching
    //      to the live DOM is what makes the gate effective: browsers
    //      don't start loading image src values until the node is
    //      attached to a displayed document, so an external URL that
    //      gets replaced never triggers a network request. The CSP in
    //      tauri.conf.json permits `https:` for img-src, so without
    //      this gate, external HTTPS images would freely load — the
    //      gate, not the CSP, is the actual security boundary.
    //
    // Format-agnostic — applies to whatever HTML the active renderer
    // produced — so it lives here in preview.ts rather than in a
    // specific renderer implementation.
    const allowExternalImages = userConfig.allowExternalImages === true;
    const baseDir = currentBuffer.path ? await dirname(currentBuffer.path) : null;
    const wrapper = document.createElement('div');
    wrapper.innerHTML = result.html;
    for (const img of wrapper.querySelectorAll('img')) {
      const src = img.getAttribute('src');
      if (!src) continue;
      // RFC 3986 scheme: starts with a letter, followed by letters /
      // digits / + / - / ., then a colon. Capture group lets us
      // dispatch on which scheme it is.
      const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(src);
      const scheme = schemeMatch?.[1]?.toLowerCase();
      if (scheme) {
        if (scheme === 'data' || scheme === 'asset') continue;
        if (scheme === 'https' && allowExternalImages) continue;
        // Block: HTTP (always), HTTPS when not allowed, and any
        // other scheme. Replace with a placeholder span showing the
        // alt text (or the URL if no alt was supplied) and put the
        // original URL in the title attribute for hover discovery.
        replaceImgWithPlaceholder(img, src);
        continue;
      }
      // No scheme — relative or absolute filesystem path. Resolve
      // against the document's directory if we have one. Untitled
      // buffers have no baseDir; leave such srcs alone (they'll
      // render as broken in the preview, which mirrors how a
      // standalone editor would behave for a relative path with no
      // anchor document).
      if (!baseDir) continue;
      try {
        const absPath = await resolve(baseDir, src);
        img.setAttribute('src', convertFileSrc(absPath));
      } catch (e) {
        console.warn('Failed to resolve image path:', src, e);
      }
    }
    out.replaceChildren(...wrapper.childNodes);

    // Consume the scroll-to-top request, if any. Done right after the
    // DOM write so the reset lands on the fresh content; any carried-
    // over scrollTop from the previous content (which can now fall
    // into the scroll-past-end spacer on a shorter doc) is cleared.
    if (pendingScrollToTop) {
      out.scrollTop = 0;
      pendingScrollToTop = false;
    }

    // Invalidate the cached map and stash the new builder for lazy
    // evaluation on the next syncPreviewToCaret call. buildBlockMap
    // is NOT invoked here — skipping the (potentially non-trivial)
    // map build for every render is the point.
    blockMap = null;
    latestBuildBlockMap = result.buildBlockMap;
    translateEditorLine = result.translateEditorLine;
    updateWordCount();
    // Surface the doc's `:toc:` position to the sidebar-TOC
    // layout machinery in ui.ts. setLastTocPosition caches the
    // value AND re-evaluates the layout immediately, so subsequent
    // display-mode / width-mode changes can re-evaluate without
    // re-rendering.
    setLastTocPosition(result.tocPosition);
  } catch (e) {
    console.error('render failed:', e);
    // Same staleness check as the success path — if a newer render
    // has started/completed, don't clobber its output with an error
    // from an already-superseded render.
    if (myToken !== renderToken) return;
    // Catch variable is `unknown` under strict mode. Narrow to Error
    // to pull a message, else coerce to string as a last resort.
    const msg = e instanceof Error ? e.message : String(e);
    out.innerHTML =
      `<pre class="render-error">Render error: ${escapeHtml(msg)}</pre>`;
    // Error state has no renderable block map; clear both the cache
    // and the builder so sync attempts after an error are no-ops
    // instead of trying to build from stale (or nonexistent) state.
    blockMap = null;
    latestBuildBlockMap = null;
    // Render error means no doc to read tocPosition from; reset
    // the cached value so the sidebar layout strips its classes
    // (the error <pre> has no #toc element to lay out).
    setLastTocPosition(null);
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
  if (!editorView) return;
  // Build the block map lazily — the FIRST sync after each render
  // pays the lexer+walk cost, subsequent syncs reuse the cached map
  // until the next render invalidates it. Users who never trigger
  // sync pay nothing. `latestBuildBlockMap` is null pre-first-render
  // and after a render error, which both correctly short-circuit to
  // a no-op sync.
  if (blockMap === null) {
    if (!latestBuildBlockMap) return;
    blockMap = latestBuildBlockMap(out);
  }
  if (!blockMap.length) return;
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
