// ================= Preview =================
// Preview pane orchestration: calls the active Renderer for source-
// to-HTML conversion, injects the result into the preview container,
// manages scroll-sync state, intercepts every preview link click, and
// owns the peek machinery (rendering a linked document into the
// preview without touching the editor). Markup-specific rendering
// (AsciiDoc include preprocessing, AST walks, DOMPurify, etc.) lives
// in renderer.ts, and preview.ts only knows about the Renderer
// interface.

import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { convertFileSrc } from "@tauri-apps/api/core";
import { basename, dirname, resolve } from "@tauri-apps/api/path";

import { userConfig } from "./config.js";
import { perfLog } from "./perf.js";
import { getDoc, editorView } from "./editor.js";
import { tr } from "./i18n.js";
import { currentBuffer, detectFormat, readDocumentText, FileTooLargeError } from "./io.js";
import { getRenderer, type BlockMapEntry } from "./renderer.js";
import { updateWordCount, setLastTocPosition, readVimMode } from "./ui.js";

// DOM refs owned by preview.ts. Non-null assertions (`!`) because
// every ID is in our HTML and the module runs after body parse.
const out = document.getElementById("out")!;
const statusSyncIndicator = document.getElementById("statusSyncIndicator")!;
const peekBannerLabel = document.getElementById("peekBannerLabel")!;
const peekReturnBtn = document.getElementById("peekReturnBtn")!;
const previewToast = document.getElementById("previewToast")!;

// Escape HTML metacharacters for safe interpolation into an HTML
// string (the render-error fallback below injects into innerHTML).
// The Record<string, string> type on the lookup is what lets TS
// accept the dynamic `ESCAPE_MAP[c]` index, since an object literal
// with specific keys can't be indexed by arbitrary strings under
// strict mode. `?? c` fallback is defensive, since the regex only
// matches the three characters we have mappings for, so the
// fallback is unreachable at runtime.
const ESCAPE_MAP: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
const escapeHtml = (s: string) => s.replace(/[&<>]/g, (c: string) => ESCAPE_MAP[c] ?? c);

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
// translated via tr(), while the literal `allow-external-images`
// config-key name stays English, since input syntax doesn't
// translate (the user types this string into their config file
// regardless of their UI language).
//
// textContent / setAttribute (not innerHTML) so the content can't
// smuggle markup back in. The .image-placeholder class is a hook for
// theme-side styling. Currently unstyled, the user sees the
// bracketed text rendered as plain inline content. The `\n` in the
// title text is honored as a line break by WebKit-family browsers'
// native tooltips.
const replaceImgWithPlaceholder = (img: Element, src: string): void => {
  const span = document.createElement("span");
  span.className = "image-placeholder";
  const label = img.getAttribute("alt") || src;
  span.textContent = `[${tr("image blocked")}: ${label} (${tr("see")} allow-external-images)]`;
  span.title =
    `${tr("External image blocked")}: ${src}\n` +
    tr("To render, set allow-external-images = true in skrivro.conf and restart.");
  img.replaceWith(span);
};

// ================= Render timer =================

let renderTimer: ReturnType<typeof setTimeout> | null = null;

// ================= Scroll-sync state =================
// Scroll-sync state, populated lazily: the block map and
// translateEditorLine callback are supplied by each render's Renderer
// result but computed on demand the first time syncPreviewToCaret
// runs after a render. Users who never trigger sync pay zero cost for
// the map build, while sync users pay the build cost once per render
// cycle, then reuse the cached map across repeated sync triggers
// until the next render invalidates it.
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
// replacement, and combined with the scroll-past-end spacer, that
// means opening a short file after scrolling deep into a long one
// can land the viewport in the new file's spacer region (entirely
// blank). The buffer-swap entry points in io.ts (loadFileFromPath,
// covering the file picker, drag-drop, and OS open events, plus
// newFile and :e filename) call
// requestPreviewScrollToTop() to queue a reset, and render() consumes
// the flag right after writing the new HTML, so the reset lands on
// the fresh content. Intentionally NOT set by edits, saves, or format
// toggles, which keep the user's current scroll position.
let pendingScrollToTop = false;
export const requestPreviewScrollToTop = () => {
  pendingScrollToTop = true;
};

// ================= Peek state =================
// Non-null while the preview shows a linked document instead of the
// user's own (see the Peek section below). `dir` is the peeked file's
// directory, the resolution base for chained relative links, and
// `name` its basename for the banner and toast messages.
//
// peekSeq is the staleness token for the async follow flow: every
// new follow AND every return to the user's document bumps it, and a
// follow whose sequence number no longer matches when its render
// completes discards the result instead of writing stale content.
//
// peekSavedScrollTop holds the user's preview scroll position from
// the moment the FIRST peek replaced their document (chained peeks
// don't overwrite it), and pendingScrollRestore tells renderOnce to
// put it back right after the return render's DOM write.
// syncAfterRender makes a scroll-sync request issued during a peek
// run right after that return render (see syncPreviewToCaret).
let peek: { path: string; dir: string; name: string } | null = null;
let peekSeq = 0;
let peekSavedScrollTop = 0;
let pendingScrollRestore = false;
let syncAfterRender = false;

// ================= Render coalescing =================
//
// render() is async and one pass can be slow: a large document's
// parse runs from hundreds of milliseconds to several seconds. The
// debounce below merges a burst of edits within its window into a
// single render, but it does not stop a render from starting while a
// previous one is still in flight: each fired timer calls render()
// unconditionally. A slow render plus continued editing therefore
// piles up overlapping invocations, each paying a full parse whose
// result is then discarded.
//
// These two flags collapse the pile-up. While a pass runs,
// renderInFlight is set and any further trigger only raises
// renderPending rather than starting a second pass. When the pass
// finishes, a raised renderPending is re-submitted through the
// debounce, see render() below for why the debounce rather than an
// immediate re-run. At most one pass runs at a time, and a burst of
// edits collapses to a single trailing pass.
//
// The old render-staleness token that lived here did two jobs: stop a
// stale render from clobbering a newer one, and stop a superseded
// render from writing its result at all. Coalescing covers the first
// (strictly sequential passes cannot overlap, so a clobber is
// structurally impossible). The buffer-staleness check inside
// renderOnce covers the second.
let renderInFlight = false;
let renderPending = false;

// Wall-clock duration of the most recent render pass, recorded by
// renderOnce. scheduleRender sizes its debounce window to this so the
// window scales with how expensive the document is to render.
let lastRenderMs = 0;

// ================= Image post-processing =================
//
// Two passes in one walk over a detached wrapper element:
//
//   1. Rewrite scheme-less paths (relative or absolute filesystem)
//      to Tauri asset:// URLs via convertFileSrc(). Renderers emit
//      <img src="..."> with paths that the browser would otherwise
//      resolve against tauri://localhost/ and hit Tauri's SPA-
//      fallback handler (returning index.html as the "image"), so
//      the asset-protocol rewrite is what makes local images
//      actually load. Requires tauri.conf.json to have
//      `app.security.assetProtocol` enabled (it is). Relative paths
//      resolve against `baseDir`, the directory of whichever document
//      is being rendered (the buffer's for live renders, the peeked
//      file's for peek renders). A null baseDir (untitled buffer)
//      leaves such srcs alone: they render as broken, which mirrors
//      how a standalone editor would behave for a relative path with
//      no anchor document.
//
//   2. Gate scheme-having URLs based on which scheme they use:
//        - data: and asset: are always allowed (inline data URIs
//          and Tauri's own asset protocol are both safe and
//          intended)
//        - https: is allowed by default, replaced with an inline
//          placeholder only when userConfig.allowExternalImages
//          is explicitly false
//        - http: is always replaced with an inline placeholder
//          (HTTPS-only policy: no opt-in for HTTP, even when
//          allowExternalImages is on)
//        - anything else (file:, ftp:, etc.) gets a placeholder
//
//      Replacing in the detached wrapper BEFORE attaching to the
//      live DOM is what makes the gate effective: browsers don't
//      start loading image src values until the node is attached to
//      a displayed document, so an external URL that gets replaced
//      never triggers a network request. The CSP in tauri.conf.json
//      permits `https:` for img-src, so without this gate, external
//      HTTPS images would freely load: the gate, not the CSP, is
//      the actual security boundary.
//
// Format-agnostic (applies to whatever HTML the active renderer
// produced), so it lives here in preview.ts rather than in a
// specific renderer implementation.
const processImages = async (wrapper: HTMLElement, baseDir: string | null): Promise<void> => {
  const allowExternalImages = userConfig.allowExternalImages !== false;
  for (const img of wrapper.querySelectorAll("img")) {
    const src = img.getAttribute("src");
    if (!src) continue;
    // RFC 3986 scheme: starts with a letter, followed by letters /
    // digits / + / - / ., then a colon. Capture group lets us
    // dispatch on which scheme it is.
    const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(src);
    const scheme = schemeMatch?.[1]?.toLowerCase();
    if (scheme) {
      if (scheme === "data" || scheme === "asset") continue;
      if (scheme === "https" && allowExternalImages) continue;
      // Block: HTTP (always), HTTPS when not allowed, and any
      // other scheme. Replace with a placeholder span showing the
      // alt text (or the URL if no alt was supplied) and put the
      // original URL in the title attribute for hover discovery.
      replaceImgWithPlaceholder(img, src);
      continue;
    }
    // No scheme: a relative or absolute filesystem path. Resolve
    // against baseDir when we have one, see the header comment.
    if (!baseDir) continue;
    try {
      const absPath = await resolve(baseDir, src);
      img.setAttribute("src", convertFileSrc(absPath));
      // Leading-slash paths in markdown source are ambiguous: they
      // can be real filesystem-absolute paths (e.g.,
      // /usr/share/icons/foo.png, which Tauri's asset protocol can
      // serve when scope allows) OR GitHub-convention "repo-rooted"
      // paths (e.g., /Assets/foo.png in a README that GitHub
      // rewrites to its repo root at render time). The resolve()
      // call above handles the filesystem-absolute case correctly,
      // while for the repo-rooted case the literal path doesn't
      // exist and the asset-protocol load fails. Wire a one-shot
      // error handler that retries with the leading slash stripped,
      // so /Assets/foo.png re-resolves under the document's
      // directory (matching what GitHub would have done at render
      // time). Real-fs paths load on the first attempt and never
      // trigger the retry. The `{ once: true }` option ensures the
      // fallback fires at most once per image: if the second
      // attempt also fails the browser shows its native broken-
      // image icon, no infinite retry loop.
      if (src.startsWith("/")) {
        img.addEventListener(
          "error",
          async () => {
            try {
              const altPath = await resolve(baseDir, src.slice(1));
              img.setAttribute("src", convertFileSrc(altPath));
            } catch (e) {
              console.warn("Image fallback resolve failed:", src, e);
            }
          },
          { once: true },
        );
      }
    } catch (e) {
      console.warn("Failed to resolve image path:", src, e);
    }
  }
};

// ================= Render =================

// A single render pass: source -> HTML -> preview DOM. Reached only
// through render() below, which serializes calls, so nothing else
// should invoke it directly.
const renderOnce = async () => {
  const started = performance.now();
  try {
    const r0 = performance.now(); // [perf]
    const source = getDoc();
    // Format-keyed dispatch: the active renderer is chosen per-
    // render based on currentBuffer.format, which is populated from
    // file extension (or the default-format config) and can be
    // changed at runtime via the format toggle / Ex commands.
    // Capture the buffer identity this pass renders against, and
    // the staleness check before the DOM write compares against it.
    const renderedPath = currentBuffer.path;
    const renderedFormat = currentBuffer.format;
    const result = await getRenderer(renderedFormat).render(source, { path: renderedPath });
    const r1 = performance.now(); // [perf]

    // Image post-processing against the buffer's own directory, see
    // processImages above.
    const baseDir = currentBuffer.path ? await dirname(currentBuffer.path) : null;
    const wrapper = document.createElement("div");
    // append() moves the fragment's already-parsed, already-sanitized
    // nodes into the wrapper, no HTML string re-parse. The renderer
    // handed back a DocumentFragment, not a string, and appending it
    // empties the fragment and leaves the nodes as wrapper's children.
    wrapper.append(result.fragment);
    const r2 = performance.now(); // [perf]
    await processImages(wrapper, baseDir);
    // Buffer-staleness check. If a different file was opened or the
    // format toggled while this pass rendered, its result is for a
    // buffer that is no longer current, so discard it rather than
    // write stale content. render()'s renderPending path has already
    // queued a trailing pass for the new buffer.
    if (currentBuffer.path !== renderedPath || currentBuffer.format !== renderedFormat) return;
    // A peek that landed while this pass rendered is newer user
    // intent than the edit that queued the pass: keep the peek on
    // screen and discard this result. The eventual return runs
    // through render(), which clears the peek state and renders the
    // user's document fresh.
    if (peek) return;
    out.replaceChildren(...wrapper.childNodes);

    // Consume the scroll-to-top request, if any. Done right after the
    // DOM write so the reset lands on the fresh content, and any
    // carried-over scrollTop from the previous content (which can
    // now fall into the scroll-past-end spacer on a shorter doc) is
    // cleared.
    if (pendingScrollToTop) {
      out.scrollTop = 0;
      pendingScrollToTop = false;
      // A fresh document outranks a peek return: the saved position
      // belonged to content that is gone.
      pendingScrollRestore = false;
    } else if (pendingScrollRestore) {
      // Returning from a peek: put the user's preview back where it
      // was when the first peek replaced it.
      out.scrollTop = peekSavedScrollTop;
      pendingScrollRestore = false;
    }

    // Invalidate the cached map and stash the new builder for lazy
    // evaluation on the next syncPreviewToCaret call. buildBlockMap
    // is NOT invoked here, since skipping the (potentially
    // non-trivial) map build for every render is the point.
    blockMap = null;
    latestBuildBlockMap = result.buildBlockMap;
    translateEditorLine = result.translateEditorLine;
    updateWordCount();
    // Surface the doc's `:toc:` position to the sidebar
    // table-of-contents layout machinery in ui.ts.
    // setLastTocPosition caches the value AND re-evaluates the
    // layout immediately, so subsequent display-mode / width-mode
    // changes can re-evaluate without re-rendering.
    setLastTocPosition(result.tocPosition);
    // A sync requested during a peek runs now, against the freshly
    // stashed builder for the user's own document.
    if (syncAfterRender) {
      syncAfterRender = false;
      syncPreviewToCaret();
    }
    const r3 = performance.now(); // [perf]
    perfLog(
      `preview render: total ${(r3 - r0).toFixed(0)}ms (renderer ${(r1 - r0).toFixed(0)}, append ${(r2 - r1).toFixed(0)}, attach+rest ${(r3 - r2).toFixed(0)})`,
    );
  } catch (e) {
    console.error("render failed:", e);
    // Catch variable is `unknown` under strict mode. Narrow to Error
    // to pull a message, else coerce to string as a last resort.
    const msg = e instanceof Error ? e.message : String(e);
    out.innerHTML = `<pre class="render-error">Render error: ${escapeHtml(msg)}</pre>`;
    // Error state has no renderable block map, so clear both the
    // cache and the builder so sync attempts after an error are
    // no-ops instead of trying to build from stale (or nonexistent)
    // state.
    blockMap = null;
    latestBuildBlockMap = null;
    // Render error means no doc to read tocPosition from, so
    // reset the cached value so the sidebar layout strips its
    // classes (the error <pre> has no #toc element to lay out).
    setLastTocPosition(null);
    // Intentionally not updating word count on render error: the
    // error message's word count is meaningless, so leaving the
    // previous successful value feels less jarring than showing
    // "3 words" for whatever text is in the <pre class="render-error">.
  } finally {
    // Record this pass's wall-clock cost so scheduleRender can size
    // the next debounce window to it.
    lastRenderMs = performance.now() - started;
  }
};

// Coalescing entry point for a render. While a pass is already in
// flight, a call here only raises renderPending and returns. Once the
// pass finishes, a raised renderPending is re-submitted through
// scheduleRender (the debounce), NOT re-run immediately.
//
// Why the debounce and not an immediate re-run: a render blocks the
// main thread for its full duration, so keystrokes typed during one
// queue up unprocessed. An immediate re-run starts the next pass
// before the event loop can drain that queue, so the queued
// keystrokes trickle out a few per pass and each batch triggers yet
// another pass, so N keystrokes degrade into N passes. Re-submitting
// through the debounce leaves the thread idle long enough for the
// whole queue to drain at once, and the debounce then collapses that
// burst into a single trailing pass.
//
// Callers invoke this fire-and-forget (`void render()`, or the
// debounced setTimeout in scheduleRender), so returning early without
// awaiting a pass breaks no caller's expectations.
export const render = async () => {
  // Any request to render the user's document ends an active peek:
  // typing, opening a file, toggling format, the banner's return
  // button, an Esc dismissal, and a sync request all funnel through
  // here, so "anything that re-renders your document brings you back"
  // holds by construction. The seq bump discards any peek render
  // still in flight, and the restore flag puts the user's preview
  // scroll position back after the DOM write (see renderOnce).
  if (peek) {
    peek = null;
    peekSeq++;
    document.body.classList.remove("peeking");
    pendingScrollRestore = true;
  }
  if (renderInFlight) {
    renderPending = true;
    return;
  }
  renderInFlight = true;
  renderPending = false;
  try {
    await renderOnce();
  } finally {
    renderInFlight = false;
  }
  // A request that arrived mid-pass: re-submit through the debounce
  // so a burst of edits settles before the trailing pass runs.
  if (renderPending) scheduleRender();
};

// Schedule a render on a debounce whose window is adaptive: it scales
// with the cost of the most recent pass (lastRenderMs), clamped to the
// range [100ms, 1000ms].
//
// A fixed window only coalesces a typing burst when it outlasts the
// gap between keystrokes. At 100ms it does not (real typing leaves
// 150ms+ between keystrokes), so a fixed 100ms window fires a render
// per keystroke. That is invisible when a render costs ~30ms and
// ruinous when it costs seconds (one multi-second pass per keystroke).
// Scaling the window to render cost fixes both ends: a cheap document
// keeps the 100ms floor and stays effectively live, while an expensive
// one gets a window wide enough (up to the 1000ms cap) to swallow a
// whole typing burst into a single trailing pass. The floor preserves
// the current feel for normal documents, and the cap bounds how far
// the preview can lag behind a stopped cursor.
export const scheduleRender = () => {
  if (renderTimer !== null) clearTimeout(renderTimer);
  const delay = Math.min(Math.max(lastRenderMs, 100), 1000);
  renderTimer = setTimeout(render, delay);
};

// ================= Scroll sync =================
// Sync-once: snap the preview to the block containing (or nearest
// preceding) the editor caret's source line. Triggered by Ctrl+Alt+L /
// ⌃⌘L, the :syncpreview Ex command, or gz in Vim normal mode. NOT a
// continuous sync: both panes stay independently scrollable and we
// don't touch them unless the user asks.

// Flash the status bar's sync indicator, a one-shot CSS animation
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
// JS", ugly but stable across every browser we target.
const flashSync = () => {
  if (!statusSyncIndicator) return;
  statusSyncIndicator.classList.remove("flashing");
  void statusSyncIndicator.offsetWidth;
  statusSyncIndicator.classList.add("flashing");
};

// Binary search for the greatest block with line <= caretLine, then
// scroll its DOM element to the top of the preview viewport.
//
// The Renderer supplies translateEditorLine (captured at render time)
// to handle coordinate-system differences. For AsciiDoc with includes,
// the editor cursor is positioned against the ROOT document source,
// but blockMap line numbers come from Asciidoctor's source map, which
// reflects the FLATTENED (post-include-expansion) source. The two
// coordinate systems diverge after the first include expansion:
// editor line N could map to flat line N+500 if the first include
// expanded to 500 lines of content. translateEditorLine applies the
// include line map. For renderers that don't transform source, it's
// the identity function.
export const syncPreviewToCaret = () => {
  // During a peek the preview shows a different document, so there
  // is nothing to sync against. Per design the request itself ends
  // the peek: render() clears the peek state, and renderOnce runs
  // the sync right after the user's document is back (it consumes
  // syncAfterRender). Deliberate, so a sync keypress is never a
  // silent no-op while peeking, and doubles as a quick way back.
  if (peek) {
    syncAfterRender = true;
    void render();
    return;
  }
  if (!editorView) return;
  // Build the block map lazily: the FIRST sync after each render
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
  // Flash the sync indicator after the guards pass: the guards
  // protect against no-op invocations (empty document, pre-init
  // editor) where the sync command is semantically meaningless.
  // Any invocation that gets past them is a "real" sync attempt
  // that deserves feedback, regardless of whether the preview
  // actually ends up scrolling to a new position.
  flashSync();
  const pos = editorView.state.selection.main.head;
  const editorCaretLine = editorView.state.doc.lineAt(pos).number;
  const caretLine = translateEditorLine(editorCaretLine);
  let lo = 0,
    hi = blockMap.length - 1,
    found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    // blockMap[mid] and blockMap[found] both safe: mid = (lo+hi)>>1
    // with lo ≥ 0, hi < blockMap.length, and found starts 0 and
    // only advances to a valid mid. noUncheckedIndexedAccess can't
    // prove any of that, so the `!` documents the invariant.
    if (blockMap[mid]!.line <= caretLine) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const target = blockMap[found]!.el;
  if (target) target.scrollIntoView({ block: "start" });
};

// ================= Peek =================
//
// Clicking a relative link to a known text-document format renders
// that file read-only in the preview pane, without touching the
// editor, the buffer, or its dirty state. A banner pinned at the top
// of the preview names the peeked file and carries the return
// control. Relative links inside a peeked document chain onward,
// resolved against the peeked document's own directory, with no
// history kept: the banner and a plain Esc always return straight to
// the user's document, and so does any live render (see render()).
//
// The peeked DOM must never pair against the editor's scroll-sync
// coordinates, so entering a peek clears the block map AND the
// builder (same treatment as a render error), and the return render
// re-establishes both.

// Extensions the peek will follow. Deliberately NOT detectFormat's
// mapping: that one falls back to "text" for every unknown extension
// so any file can be OPENED as text on purpose, whereas following a
// link into a binary blob by accident helps no one. Targets that
// pass this gate then take detectFormat's mapping for real.
const PEEKABLE_EXT = /\.(adoc|asciidoc|md|markdown|txt)$/i;

let toastTimer: ReturnType<typeof setTimeout> | null = null;

// Transient pane-local message for swallowed link clicks. Lives in
// the preview pane rather than the Ex panel (hidden with the editor
// in preview-only mode) or the status bar (hideable outright), so it
// is visible in every mode that can produce a link click. Re-showing
// restarts the timer, and the newest message wins.
const showPreviewToast = (text: string) => {
  previewToast.textContent = text;
  previewToast.classList.add("visible");
  if (toastTimer !== null) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    previewToast.classList.remove("visible");
    toastTimer = null;
  }, 4000);
};

// End an active peek and bring the user's document back. No-op when
// idle. The state clearing itself lives in render() so every return
// path (this button, typing, file open, format toggle, sync) shares
// one implementation.
export const exitPeek = () => {
  if (!peek) return;
  void render();
};
peekReturnBtn.addEventListener("click", exitPeek);

// Esc dismisses the peek, layered so modal muscle memory survives.
// Focused text fields defer entirely: an Esc typed into the Vim Ex
// prompt or the find panel belongs to that field's own dismissal, so
// the first press closes the field and the next one returns (same
// focused-input skip the `:` auto-capture and Ctrl+A handlers use).
// With focus on the editor content, Vim keeps its own Esc jobs:
// insert, visual, and replace each eat the first press, and only a
// NORMAL-mode press returns. CM6's hasFocus is literally
// "activeElement == contentDOM" (panel inputs make it false), which
// is exactly the surface the vim gate wants once the field guard
// above has run. readVimMode is null with Vim off, so non-vim editors
// return on every press. With focus anywhere else (the preview pane
// after a click, or nothing focused as in preview-only mode), Esc
// always returns. The event is deliberately NOT preventDefault'ed: a
// normal-mode Esc may still have vim work to do (canceling a pending
// operator or count), and swallowing it would leave that state armed,
// so the rare pending-operator press cancels AND returns, backing out
// both layers at once. Open dialogs and the spellcheck menu keep Esc
// entirely to themselves (dismissing them is the whole intent of the
// press). Capture phase so a vim handler that consumes the key can't
// starve this listener.
window.addEventListener(
  "keydown",
  (e) => {
    if (e.key !== "Escape") return;
    if (!peek) return;
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    if (document.querySelector("dialog[open], .spell-menu")) return;
    const active = document.activeElement;
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
    if (editorView && editorView.hasFocus) {
      const mode = readVimMode();
      if (mode !== null && mode !== "normal") return;
    }
    exitPeek();
  },
  { capture: true },
);

// Follow a relative link into the preview. The resolution base is
// the peeked document's directory while peeking (so chains resolve
// exactly as if the documents were opened directly), else the
// buffer's. Every failure mode surfaces as a toast, never silence:
// unresolvable (untitled buffer), non-document extension, missing or
// unreadable target, oversized target, render failure.
const followRelativeLink = async (href: string) => {
  const hashIdx = href.indexOf("#");
  const rawPath = hashIdx === -1 ? href : href.slice(0, hashIdx);
  const fragment = hashIdx === -1 ? null : href.slice(hashIdx + 1);
  // Renderers percent-encode link destinations (markdown-it's
  // normalizeLink, Asciidoctor on spaces), so decode before touching
  // the filesystem. A malformed sequence keeps the raw string.
  let relPath = rawPath;
  try {
    relPath = decodeURIComponent(rawPath);
  } catch {}
  const baseDir = peek ? peek.dir : currentBuffer.path ? await dirname(currentBuffer.path) : null;
  if (!baseDir || !PEEKABLE_EXT.test(relPath)) {
    showPreviewToast(tr("Unable to follow this link"));
    return;
  }
  const seq = ++peekSeq;
  const targetPath = await resolve(baseDir, relPath);
  const name = await basename(targetPath);
  let content: string;
  try {
    content = await readDocumentText(targetPath);
  } catch (e) {
    // The oversize error carries its own ready-to-display message
    // (with the size and the limit), everything else reads as "the
    // link points at nothing readable."
    showPreviewToast(
      e instanceof FileTooLargeError ? e.message : tr("Link target not found: %s", name),
    );
    return;
  }
  try {
    const targetDir = await dirname(targetPath);
    const result = await getRenderer(detectFormat(targetPath)).render(content, {
      path: targetPath,
    });
    const wrapper = document.createElement("div");
    wrapper.append(result.fragment);
    await processImages(wrapper, targetDir);
    // Superseded while rendering: a newer follow, or any return to
    // the user's document (render() bumps peekSeq). Discard.
    if (seq !== peekSeq) return;
    // Save the user's preview scroll position on the FIRST peek
    // only, so a chain of follows still returns to where their own
    // document was left.
    if (!peek) peekSavedScrollTop = out.scrollTop;
    peek = { path: targetPath, dir: targetDir, name };
    out.replaceChildren(...wrapper.childNodes);
    out.scrollTop = 0;
    // A fragment on the link (chapter.adoc#section) scrolls the
    // peeked render to its anchor, mirroring in-page behavior.
    if (fragment) {
      out.querySelector(`#${CSS.escape(fragment)}`)?.scrollIntoView({ block: "start" });
    }
    // The peeked DOM has no editor to sync against: clear both the
    // cached map and the builder, exactly like the render-error
    // path, so a stale builder can never pair the user's caret
    // against foreign elements.
    blockMap = null;
    latestBuildBlockMap = null;
    updateWordCount();
    setLastTocPosition(result.tocPosition);
    peekBannerLabel.textContent = tr("Viewing %s", name);
    document.body.classList.add("peeking");
  } catch (e) {
    console.error("peek render failed:", targetPath, e);
    showPreviewToast(tr("Unable to follow this link"));
  }
};

// ================= Preview link handling =================
//
// Delegated click interception for every link in the rendered
// preview. One listener on the preview container with a closest()
// lookup covers every re-render's links without re-attaching per
// render. The governing rule: no click in the preview may navigate
// the webview away from the app. Navigation would unload the app (a
// relative href resolves inside the app origin, which the webview
// will navigate to, and an empty href resolves to the current URL),
// forcing a reboot-and-restore cycle.
//
// http(s) links are handed off to the user's system browser via the
// Tauri shell plugin. Tauri 2 blocks webview navigation to arbitrary
// external URLs by default as a security measure (preventing
// phishing-style webview hijacking), so without the handoff these
// clicks would be silently swallowed.
//
// Pure fragment links (#section) fall through to the webview's
// default scroll-to-anchor behavior, inside peeked content too (the
// rendered ids live in the same document either way).
//
// Relative paths to known document formats peek (see the Peek section
// above). Everything else is swallowed with preventDefault() and
// answered with a toast so no click is ever a silent mystery: other
// schemes (mailto:, ftp:, etc.), protocol-relative URLs, empty hrefs
// (Markdown emits one for [text]()), non-document targets, and
// unresolvable or unreadable targets.
//
// The handoff requires the `shell:allow-open` capability to have been
// granted with a URL scope that permits the href we're opening. See
// src-tauri/capabilities/default.json, scoped to ^https?:// so that
// the shell plugin will only hand off web URLs to the OS, not e.g.
// file:// URLs that could be used to open arbitrary local files.
out.addEventListener("click", (e) => {
  // e.target is typed as EventTarget, which doesn't have closest().
  // Narrow to Element to get closest(), and to guard against the
  // runtime case where the target is something exotic (a Document or
  // Window, say) that isn't in the DOM tree.
  if (!(e.target instanceof Element)) return;
  const a = e.target.closest("a");
  if (!a) return;
  const href = a.getAttribute("href");
  // Null means the <a> has no href attribute at all, so a click on it
  // cannot navigate. An empty string gets no such pass: it is a real
  // href that resolves to the current URL, so it takes the swallow
  // path below.
  if (href === null) return;
  if (/^https?:\/\//i.test(href)) {
    e.preventDefault();
    shellOpen(href).catch((err) => console.error("Failed to open external URL:", href, err));
    return;
  }
  // In-page anchors keep the webview's native scroll-to-anchor.
  if (href.startsWith("#")) return;
  e.preventDefault();
  // Non-http(s) schemes (mailto:, ftp:, a Windows drive letter, and
  // so on), protocol-relative URLs, and empty hrefs are never
  // followable: say so instead of silently doing nothing.
  if (href === "" || href.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(href)) {
    showPreviewToast(tr("Unable to follow this link"));
    return;
  }
  // A relative path: try to peek it. followRelativeLink surfaces
  // every failure as a toast.
  void followRelativeLink(href);
});
