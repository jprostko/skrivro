// ================= UI =================
// Status bar rendering, help dialog, confirm dialog, pref-backed
// toggles (status bar / bar position / help button / gutter / display
// mode / Vim mode),
// Mac help-label rewriting, user config application. Also owns the
// host-level listeners that drive status bar state: keyup for mode
// tracking, focusin/focusout on the Vim command panel input for
// COMMAND mode detection.

import { EditorView } from "@codemirror/view";
import { tr } from "./i18n.js";
import { prefs, savePrefs } from "./prefs.js";
import { isMac } from "./i18n.js";
import {
  Vim,
  editorView,
  setVimMode,
  setSyntaxHighlighting,
  setSpellcheck,
  spellcheckConfigured,
  getCM,
} from "./editor.js";
import { getSpellcheckStatus } from "./spellcheck/index.js";
import { currentBuffer, setBufferFormat, vimMessage, appMessage, type Format } from "./io.js";
import { exitPeek } from "./preview.js";
import { userConfig, type SkrivroConfig } from "./config.js";

// ================= DOM refs =================

// Non-null assertions (`!`) on every DOM query: every ID is in our
// HTML, the module script runs after body parse, so getElementById
// returning null is impossible at runtime. helpDlg additionally
// casts to HTMLDialogElement (the cast subsumes the non-null
// assertion) so its showModal / close / open accesses type-check.
const out = document.getElementById("out")!;
const host = document.getElementById("src-host")!;
const statusBar = document.getElementById("statusbar")!;
const statusMode = document.getElementById("statusMode")!;
const statusFilename = document.getElementById("statusFilename")!;
const statusFiletype = document.getElementById("statusFiletype")!;
const statusPosition = document.getElementById("statusPosition")!;
const statusWordCount = document.getElementById("statusWordCount")!;
const statusSpellcheck = document.getElementById("statusSpellcheck")!;
const helpDlg = document.getElementById("helpDialog") as HTMLDialogElement;
const helpBtn = document.getElementById("helpBtn")!;
const helpCloseBtn = document.getElementById("helpCloseBtn")!;
const appToast = document.getElementById("appToast")!;
const previewPaneEl = document.querySelector(".preview-pane");

// ================= Status bar =================
//
// Layout:
//   - Mode pill (left): canonical Catppuccin colors from catppuccin/nvim
//     (blue/green/mauve/red/peach). Hidden when Vim is off.
//   - Filename (left): dirty indicator + basename
//   - File type (right): the buffer format's display name (FORMAT_LABELS)
//   - Cursor position (right): 'Ln 42, Col 85', 1-indexed, codepoint-aware
//   - In visual modes, cursor position is replaced with selection info

// COMMAND mode tracking. Flipped true when the Vim Ex command panel's
// <input> gains focus, false when it loses focus. Updated by the
// focusin/focusout listeners on host at the bottom of this module.
let inCommandMode = false;

// Read the current Vim mode from @replit/codemirror-vim's state.
// getCM() returns a CM5-compat wrapper whose .state.vim holds the
// Vim mode flags (insertMode, visualMode, visualLine, visualBlock),
// and whose .state.overwrite distinguishes REPLACE from plain INSERT.
//
// Returns null if Vim is off (signals "hide the pill"), and returns
// 'command' if the Ex command panel is currently focused (tracked
// via inCommandMode, set by focusin/focusout listeners registered
// after editor creation).
//
// REPLACE vs INSERT precedence: the plugin models REPLACE as a
// sub-state of INSERT (matching real Vim's internal model):
// pressing R sets vs.insertMode=true AND cm.state.overwrite=true
// via the toggleOverwrite action. insertMode alone is ambiguous,
// so the overwrite flag has to be checked BEFORE falling through
// to 'insert'. Plugin source reference: the `enterInsertMode`
// action with `actionArgs.replace` calls cm.toggleOverwrite(true)
// and sets the keyMap to 'vim-replace'.
export const readVimMode = () => {
  if (!prefs.vimMode) return null;
  if (inCommandMode) return "command";
  if (!editorView) return "normal";
  try {
    const cm = getCM(editorView);
    if (!cm || !cm.state) return "normal";
    const vs = cm.state.vim;
    if (!vs) return "normal";
    if (vs.insertMode && cm.state.overwrite) return "replace";
    if (vs.insertMode) return "insert";
    if (vs.visualMode) return "visual";
    return "normal";
  } catch {
    return "normal";
  }
};

// Sub-classify a visual-mode selection into char / line / block.
// All three share the same pill color (mauve per canonical Catppuccin),
// and only the label text differs: VISUAL, V-LINE, V-BLOCK.
const readVisualVariant = () => {
  if (!editorView) return "char";
  try {
    const cm = getCM(editorView);
    const vs = cm && cm.state && cm.state.vim;
    if (!vs || !vs.visualMode) return "char";
    if (vs.visualBlock) return "block";
    if (vs.visualLine) return "line";
    return "char";
  } catch {
    return "char";
  }
};

const formatModeLabel = (mode: string | null, variant: string | null) => {
  switch (mode) {
    case "insert":
      return tr("INSERT");
    case "replace":
      return tr("REPLACE");
    case "command":
      return tr("COMMAND");
    case "visual":
      if (variant === "line") return tr("V-LINE");
      if (variant === "block") return tr("V-BLOCK"); // V-BLOCK same in Swedish
      return tr("VISUAL");
    default:
      return tr("NORMAL"); // NORMAL same in Swedish
  }
};

// Cursor position as 'Ln X, Col Y' (or a shorter variant), 1-indexed,
// codepoint-aware. Counts Unicode codepoints (via [...str].length)
// rather than JS string length (UTF-16 code units) so emoji and other
// non-BMP characters count as 1. Em-dashes, curly quotes, accented
// letters all count as 1. Prose-correct by construction.
//
// Format is configurable via `cursor-position-format` in skrivro.conf:
//   verbose (default): 'Ln 42, Col 85'  (prose-editor style)
//   compact:           '42:85'           (terse code-editor style)
//   ruler:             '42,85'           (Vim ruler style)
// Stored in userConfig.cursorPositionFormat. Unknown values fall back
// to verbose so a typo in the config doesn't break the status bar.
//
// Returns { text, col }. The `text` is the display string, and `col`
// is the raw numeric column so refreshStatus can compare it against
// userConfig.softColumnLimit without recomputing. `col` is null in
// the pre-editor fallback case where there's no cursor yet, and the
// caller treats null as "never over-limit."
const formatCursorPosition = () => {
  if (!editorView) return { text: `${tr("Ln")} 1, ${tr("Col")} 1`, col: null };
  const head = editorView.state.selection.main.head;
  const line = editorView.state.doc.lineAt(head);
  const textBeforeCursor = line.text.slice(0, head - line.from);
  const col = [...textBeforeCursor].length + 1;
  let text;
  switch (userConfig.cursorPositionFormat) {
    case "compact":
      text = `${line.number}:${col}`;
      break;
    case "ruler":
      text = `${line.number},${col}`;
      break;
    case "verbose":
    default:
      text = `${tr("Ln")} ${line.number}, ${tr("Col")} ${col}`;
      break;
  }
  return { text, col };
};

// Selection info displayed in visual modes in place of cursor position:
//   single-line char selection:  '87 chars'
//   multi-line char / V-LINE:    '3 lines, 240 chars'
//   V-BLOCK:                     '3 × 5' (rows × cols)
const formatSelectionInfo = (variant: string | null) => {
  if (!editorView) return "";
  const state = editorView.state;
  const sel = state.selection.main;
  const doc = state.doc;
  const from = Math.min(sel.anchor, sel.head);
  const to = Math.max(sel.anchor, sel.head);
  const fromLine = doc.lineAt(from).number;
  const toLine = doc.lineAt(to).number;
  const lines = toLine - fromLine + 1;

  if (variant === "block") {
    // V-BLOCK: CM6 represents the rectangular selection as multiple
    // parallel ranges (one per row). Row count = range count. Column
    // width = max codepoint-delta across ranges.
    const ranges = state.selection.ranges;
    const rows = ranges.length > 1 ? ranges.length : lines;
    let cols = 0;
    for (const r of ranges) {
      const rLine = doc.lineAt(r.from);
      const rFromCol = [...rLine.text.slice(0, r.from - rLine.from)].length;
      const rToCol = [...rLine.text.slice(0, r.to - rLine.from)].length;
      cols = Math.max(cols, Math.abs(rToCol - rFromCol));
    }
    return `${rows} × ${cols || 1}`;
  }

  const chars = [...doc.sliceString(from, to)].length;
  if (lines > 1) return `${lines} ${tr("lines")}, ${chars} ${tr("chars")}`;
  return `${chars} ${tr("chars")}`;
};

export const refreshStatus = () => {
  if (!statusBar) return;
  const mode = readVimMode();
  const variant = mode === "visual" ? readVisualVariant() : null;

  // Mode pill
  if (mode) {
    statusMode.hidden = false;
    statusMode.dataset.vimMode = mode;
    statusMode.textContent = formatModeLabel(mode, variant);
  } else {
    statusMode.hidden = true;
  }

  // Position slot: either Vim visual-mode selection info or cursor
  // position. Over-limit coloring only applies to the cursor position
  // branch: selection info is a different display mode and the col
  // concept doesn't map onto it.
  let overLimit = false;
  if (mode === "visual") {
    statusPosition.textContent = formatSelectionInfo(variant);
  } else {
    const { text, col } = formatCursorPosition();
    statusPosition.textContent = text;
    // Soft column limit: if the user set a positive integer limit
    // in skrivro.conf, and the current cursor column is past it,
    // flag the position slot with .over-limit so CSS can paint it
    // peach. `col` is null in the pre-editor fallback case, so the
    // null-check keeps us from flagging over-limit before the editor
    // has even finished constructing.
    //
    // `typeof === 'number'` is the precise guard for softColumnLimit:
    // Rust's `Option<u32>` serializes to `number | null` (serde
    // default, no skip_serializing_if), so when the user has no
    // `soft-column-limit` in their config, `userConfig.softColumnLimit`
    // is `null`. A naive `!== undefined` check passes for null, and
    // then `col > null` coerces null to 0, making the condition
    // effectively `col > 0`, which is always true for any cursor
    // position ≥ 1, so the over-limit class would be applied
    // constantly. typeof is the unambiguous fix: only a real number
    // enables the threshold check.
    overLimit =
      col !== null &&
      typeof userConfig.softColumnLimit === "number" &&
      col > userConfig.softColumnLimit;
  }
  statusPosition.classList.toggle("over-limit", overLimit);

  statusFilename.textContent = currentBuffer.name;
  statusFiletype.textContent = FORMAT_LABELS[currentBuffer.format];

  // Spellcheck indicator: shown when spellcheck is on in config but either
  // toggled off at runtime, or a requested Swedish dictionary is missing
  // (Swedish is user-supplied, see resolveSpellcheck). A normal, working
  // spellcheck shows nothing (the squiggles are the feedback), and config-off
  // has nothing to indicate. The label is wrapped in parens here.
  let spellNote = "";
  if (spellcheckConfigured()) {
    if (!prefs.spellcheck) {
      spellNote = tr("spellcheck off");
    } else {
      switch (getSpellcheckStatus()) {
        case "sv-missing-off":
          spellNote = tr("Swedish dictionary not found");
          break;
        case "sv-missing-en-only":
          spellNote = tr("Swedish dictionary not found, English only");
          break;
        case "sv-missing-using-en":
          spellNote = tr("Swedish dictionary not found, using English");
          break;
      }
    }
  }
  statusSpellcheck.hidden = !spellNote;
  statusSpellcheck.textContent = spellNote ? `(${spellNote})` : "";
};

// Human-readable display name for the filetype slot in the status bar.
// Paralleled by FORMAT_DISPLAY_NAME in io.ts (used by the :format
// readback), kept in sync by convention since the set is three entries.
const FORMAT_LABELS: Record<Format, string> = {
  asciidoc: "AsciiDoc",
  markdown: "Markdown",
  text: "Text",
};

// Cycle through formats in a fixed order: asciidoc → markdown → text
// → asciidoc. Bound to Ctrl+Alt+R / Ctrl+Cmd+R. The mutation work
// (compartment reconfigure, status refresh, re-render) is centralized
// in setBufferFormat, so this just picks the next value and
// delegates.
const FORMAT_CYCLE: readonly Format[] = ["asciidoc", "markdown", "text"];
export const toggleFormat = () => {
  const idx = FORMAT_CYCLE.indexOf(currentBuffer.format);
  // indexOf returns -1 for unknown values. Treat that as "snap back
  // to asciidoc" rather than propagating the -1 into the next
  // lookup, which would pick index 0 anyway but via a bug-adjacent
  // path. Explicit fallback documents the intent.
  const nextIdx = idx === -1 ? 0 : (idx + 1) % FORMAT_CYCLE.length;
  setBufferFormat(FORMAT_CYCLE[nextIdx]!);
};

// Count words in the rendered preview's text content. Visible only in
// preview-only display mode (see the CSS `.status-word-count` rules),
// but computed on every render regardless so the value is current the
// moment the user switches into preview mode, with no "stale until
// first render-in-preview" surprise.
//
// Reading from the rendered DOM rather than the AsciiDoc source means
// directive syntax (`include::`, attribute references, `:toc: left`)
// doesn't inflate the count with non-content tokens. The count
// reflects what a reader of the rendered document actually sees.
//
// For documents with includes, the count reflects the fully-expanded
// preview: opening book.adoc (which include::s chapters) shows the
// book-total, opening chapter-03.adoc directly shows that chapter.
//
// Format uses toLocaleString() with no arg so thousands separators
// match the user's browser locale (comma in en-US, space in sv-SE,
// dot in de-DE, etc.). Singular "1 word" vs plural "N words" handled
// explicitly, since "1 words" reads as broken.
export const updateWordCount = () => {
  if (!statusWordCount) return;
  const text = out.textContent || "";
  const count = text
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0).length;
  const label = count === 1 ? tr("word") : tr("words");
  statusWordCount.textContent = `${count.toLocaleString()} ${label}`;
};

// ================= App toast =================
//
// The window-anchored half of the app's two message channels, see
// appMessage in io.ts for the routing. The Ex panel exists only with
// Vim mode on, so Vim-independent feedback lands here when the panel
// is unavailable. Fixed to the viewport (styles.css .app-toast), so
// it shows in every display mode, with either pane hidden, and with
// the status bar hidden too. Duration matches the Ex panel's 5000ms
// so the same message lives equally long in either channel.
// Re-showing restarts the timer, and the newest message wins.
let appToastTimer: ReturnType<typeof setTimeout> | null = null;

export const showAppToast = (text: string) => {
  appToast.textContent = text;
  appToast.classList.add("visible");
  if (appToastTimer !== null) clearTimeout(appToastTimer);
  appToastTimer = setTimeout(() => {
    appToast.classList.remove("visible");
    appToastTimer = null;
  }, 5000);
};

// ================= Help overlay =================
// Ctrl+Alt+H / ⌃⌘H or the "?" button in the status bar toggles the
// help dialog. Escape (native <dialog> behavior), the close button,
// and clicking the backdrop all dismiss it.
//
// Native <dialog>.close() restores focus to whatever was active
// before showModal(), but WebKit's restoration isn't reliably
// synchronous: a `:` typed immediately after close can fire its
// keydown against <body> and then route its input event to the
// editor's contentDOM once focus lands there, inserting the
// character as text instead of triggering Vim's Ex prompt. Capturing
// the pre-help focus and restoring it explicitly (synchronously)
// sidesteps that race and preserves the user's actual context: if
// they were on the preview pane in split mode before opening help,
// focus goes back to body (where it was), not forced to the editor.
//
// Capture is split across TWO points:
//
//   - helpBtn mousedown: runs BEFORE the browser's native focus
//     change moves focus to the button. Without this, clicking the
//     `?` button captures the button itself as the "previous focus"
//     (wrong: the actual previous focus was whatever the user was
//     doing before they clicked).
//   - showHelp fallback: for the keyboard path (Ctrl+Alt+H / ⌃⌘H), no
//     button mousedown fires, so capture at showHelp time instead.
//
// preHelpFocus is cleared on hideHelp so a subsequent open via
// keyboard doesn't inherit a stale value from a prior mouse click.
let preHelpFocus: HTMLElement | null = null;
helpBtn.addEventListener("mousedown", () => {
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== helpBtn) {
    preHelpFocus = active;
  }
});
export const showHelp = () => {
  if (helpDlg.open) return;
  if (preHelpFocus === null) {
    preHelpFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }
  helpDlg.showModal();
  helpCloseBtn.focus();
};
export const hideHelp = () => {
  if (helpDlg.open) helpDlg.close();
};

// Focus restoration runs on the dialog's `close` event rather than
// inside hideHelp, because hideHelp is only called from our own
// click handlers (close button, backdrop click), while Escape
// triggers the native close path, which fires the close event but
// doesn't invoke hideHelp. Attaching here handles ALL close paths
// uniformly.
helpDlg.addEventListener("close", () => {
  const restore = preHelpFocus;
  preHelpFocus = null;

  // Preview-only mode: editor stays blurred. Native dialog close can
  // still re-focus the editor via its own restoration logic (the
  // pre-showModal active element, or a focusable-ancestor walk from
  // the dialog), which would re-enable keystrokes into the hidden
  // editor and regress the read-only preview behavior. Force-blur.
  if (prefs.displayMode === "preview") {
    if (editorView) editorView.contentDOM.blur();
    return;
  }

  // Split / editor modes: synchronous focus to the correctly-captured
  // pre-help element. rAF is too slow: a `:` pressed before the
  // next frame fires its keydown against <body>, bypassing Vim's
  // keydown intercept on contentDOM, then the input event arrives at
  // contentDOM once focus catches up and inserts the character as
  // text. Synchronous focus before yielding guarantees the right
  // target for the first keystroke.
  //
  // When restoring to the editor, use editorView.focus() rather than
  // contentDOM.focus() directly. CM6 tracks focus state internally
  // (the Vim plugin consults it before intercepting keydowns), and a
  // bare DOM focus() leaves that internal state stale, so Vim's
  // handler can see "not focused" and pass `:` through to default
  // text insertion. editorView.focus() updates CM6's state coherently.
  if (restore) {
    if (editorView && restore === editorView.contentDOM) {
      editorView.focus();
    } else {
      restore.focus();
    }
  }
});
export const toggleHelp = () => {
  if (helpDlg.open) hideHelp();
  else showHelp();
};
helpBtn.addEventListener("click", showHelp);
helpCloseBtn.addEventListener("click", hideHelp);
// Dismiss the help dialog when the user clicks on its backdrop,
// the ::backdrop pseudo-element rendered outside the dialog's box.
//
// Two pitfalls to avoid:
//
//   1. Click-and-drag for text selection inside the content
//      (mousedown on a child element, mouseup elsewhere) fires a
//      click event whose target is the dialog itself (the deepest
//      common ancestor of the two phases), so checking `e.target
//      === helpDlg` alone would dismiss on every drag-release.
//
//   2. The dialog has no inner wrapper, so h2/h3/div.help-grid are
//      direct children of helpDlg and the whitespace gaps BETWEEN
//      sections are part of the dialog element itself. A click in
//      one of those gaps fires with `e.target === helpDlg` even
//      though it's geometrically inside the dialog's box, not on
//      the backdrop.
//
// Solution: distinguish "click on dialog padding/whitespace" from
// "click on actual backdrop" by checking the event coordinates
// against the dialog's bounding rect. Padding/whitespace clicks
// land INSIDE the rect, while ::backdrop clicks land OUTSIDE it.
// Then require BOTH the mousedown and the resulting click to have
// hit the backdrop, so drag-releases that happen to end on the
// backdrop (or start on the backdrop and end inside) don't
// qualify.
const isHelpBackdropAt = (e: MouseEvent): boolean => {
  if (e.target !== helpDlg) return false;
  const r = helpDlg.getBoundingClientRect();
  return e.clientX < r.left || e.clientX >= r.right || e.clientY < r.top || e.clientY >= r.bottom;
};
let helpMouseDownOnBackdrop = false;
helpDlg.addEventListener("mousedown", (e) => {
  helpMouseDownOnBackdrop = isHelpBackdropAt(e);
});
helpDlg.addEventListener("click", (e) => {
  if (helpMouseDownOnBackdrop && isHelpBackdropAt(e)) hideHelp();
});

// ================= Toggles =================

// A body-class geometry change reflows the editor behind CodeMirror's
// back, and the selection can come out of that reflow silently moved,
// seen on WebKitGTK in Vim normal mode as the block cursor landing on
// a nearby line (blank lines especially) with the editor state moved
// along. The layer responsible is not pinned down (the native caret
// re-anchored mid-reflow and adopted by CodeMirror's DOM observer is
// the leading suspect), so the guard fixes the outcome instead:
// snapshot the selection, apply the flip, have CodeMirror re-measure,
// and restore the snapshot if the selection moved by itself within the
// two-frame reflow window (real input cannot land that fast after a
// toggle chord). When the selection survives intact, the cursor is
// still scrolled back into view, since a reflow can leave it outside
// the visible range and Vim keeps the cursor on a visible line through
// geometry changes (the same courtesy suits non-Vim mode). The restore
// bails if the document changed or the editor was rebuilt in the
// window. Startup calls run before the editor exists and apply the
// flip unguarded.
const guardEditorGeometry = (mutate: () => void) => {
  const view = editorView;
  if (!view) {
    mutate();
    return;
  }
  const sel = view.state.selection;
  const doc = view.state.doc;
  mutate();
  view.requestMeasure();
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (editorView !== view || view.state.doc !== doc) return;
      if (!view.state.selection.eq(sel)) {
        view.dispatch({ selection: sel, scrollIntoView: true });
      } else {
        view.dispatch({
          effects: EditorView.scrollIntoView(view.state.selection.main.head),
        });
      }
    });
  });
};

export const applyBarPosition = () => {
  guardEditorGeometry(() => {
    document.body.classList.toggle("bar-top", prefs.barPosition === "top");
  });
};
export const toggleBarPosition = () => {
  prefs.barPosition = prefs.barPosition === "top" ? "bottom" : "top";
  savePrefs();
  applyBarPosition();
};
export const applyHelpButton = () => {
  document.body.classList.toggle("no-help-button", prefs.helpButtonHidden);
};
export const toggleHelpButton = () => {
  prefs.helpButtonHidden = !prefs.helpButtonHidden;
  savePrefs();
  applyHelpButton();
};
export const applyGutter = () => {
  guardEditorGeometry(() => {
    document.body.classList.toggle("no-gutter", prefs.gutterHidden);
  });
};
export const toggleGutter = () => {
  prefs.gutterHidden = !prefs.gutterHidden;
  savePrefs();
  applyGutter();
};
export const applyStatusBar = () => {
  guardEditorGeometry(() => {
    document.body.classList.toggle("no-statusbar", prefs.statusBarHidden);
  });
};
export const toggleStatusBar = () => {
  prefs.statusBarHidden = !prefs.statusBarHidden;
  savePrefs();
  applyStatusBar();
};
// Flip editor syntax highlighting on/off and persist. Same shape as
// toggleVim + setVimMode: ui.ts owns the pref flip and persistence,
// editor.ts owns the CM6 dispatch. Called by the Ctrl+Alt+Y / ⌃⌘Y
// keybinding and by the :syntax Ex command.
export const toggleSyntaxHighlighting = () => {
  prefs.syntaxHighlighting = !prefs.syntaxHighlighting;
  savePrefs();
  setSyntaxHighlighting(prefs.syntaxHighlighting);
};
// Explicit setter for `:syntax on` / `:syntax off` (as opposed to the
// keybinding, which is a toggle). No-op if the pref is already in the
// requested state, which avoids the needless dispatch.
export const applySyntaxHighlighting = (enabled: boolean) => {
  if (prefs.syntaxHighlighting === enabled) return;
  prefs.syntaxHighlighting = enabled;
  savePrefs();
  setSyntaxHighlighting(enabled);
};

// Message shown when the runtime spellcheck toggle is used while the
// config has spellcheck off. The toggle is inert in that state (no
// dictionary is loaded), so it tells the user where to enable it
// rather than appearing to do nothing.
const SPELLCHECK_OFF_MSG = "Spellcheck is disabled in config (spellcheck-language = off)";

// Flip editor spellcheck on/off and persist. Same shape as the syntax-
// highlighting toggle, plus a config gate: when spellcheck-language is
// explicitly 'off' no dictionary is loaded, so instead of toggling, this
// shows a message that spellcheck is disabled in config. Called by
// Ctrl+Alt+K / ⌃⌘K and the :spell Ex command.
export const toggleSpellcheck = () => {
  if (!spellcheckConfigured()) {
    appMessage(tr(SPELLCHECK_OFF_MSG));
    return;
  }
  prefs.spellcheck = !prefs.spellcheck;
  savePrefs();
  setSpellcheck(prefs.spellcheck);
  refreshStatus();
};
// Explicit setter for `:spell on` / `:spell off`. Same config gate,
// and a no-op when already in the requested state.
export const applySpellcheck = (enabled: boolean) => {
  if (!spellcheckConfigured()) {
    vimMessage(tr(SPELLCHECK_OFF_MSG));
    return;
  }
  if (prefs.spellcheck === enabled) return;
  prefs.spellcheck = enabled;
  savePrefs();
  setSpellcheck(enabled);
  refreshStatus();
};

// ================= Width mode =================
// Four named width caps for the single-pane scrollers (editor-only
// and preview-only display modes). Same ch value applied to both
// panes. The natural mono-vs-proportional width difference gives
// the editor a wider visual cap than the preview at the same mode
// setting.
//
// 65ch (narrow):  prose-optimal line length, comfortable for
//   novels, essays, anything pure-prose.
// 90ch (medium):  good for manuals, owner docs, mixed content.
//   Geometric midpoint between narrow and wide.
// 125ch (wide):   wider columns for technical references, API
//   docs, anything code- or table-heavy.
// 100vw (full):   no cap. Pane fills available width: for
//   ultrawide monitors, single-tile-half-screen tiling, or users
//   who prefer maximum screen utilization. The 100% safety net
//   in the rules still applies but is moot since 100vw ≥ 100%
//   of the parent in single-pane modes.
export const WIDTH_MODES = ["narrow", "medium", "wide", "full"];
// The `& { medium: string }` types the medium entry as a known
// property so applyWidthMode's `|| WIDTH_CAPS.medium` fallback
// resolves to string, not string | undefined (a bare Record index
// is optional under noUncheckedIndexedAccess).
const WIDTH_CAPS: Record<string, string> & { medium: string } = {
  narrow: "65ch",
  medium: "90ch",
  wide: "125ch",
  full: "100vw",
};

// Sidebar table-of-contents width per width mode, mapping the
// Asciidoctor spec values (15em / 20em from their stylesheet)
// onto our modes. Narrow mode never activates sidebar layout
// (see evaluateTocLayout below) so its value is unreachable in
// practice, but included for completeness and to keep the
// lookup total. (`& { medium: string }`, same reason as
// WIDTH_CAPS above.)
const TOC_SIDEBAR_WIDTHS: Record<string, string> & { medium: string } = {
  narrow: "15em",
  medium: "15em",
  wide: "15em",
  full: "20em",
};

// Push the active mode's cap into the --width-cap CSS variable
// that the .cm-scroller and .preview-pane rules consume, and the
// matching sidebar width into --toc-sidebar-width. Defensive
// fallback to medium if the persisted pref is somehow invalid.
// Re-evaluates the sidebar table-of-contents layout, since
// narrow disables it, so transitioning in/out of narrow needs to
// recompute the layout class set.
export const applyWidthMode = () => {
  guardEditorGeometry(() => {
    const cap = WIDTH_CAPS[prefs.widthMode] || WIDTH_CAPS.medium;
    const tocSidebar = TOC_SIDEBAR_WIDTHS[prefs.widthMode] || TOC_SIDEBAR_WIDTHS.medium;
    document.documentElement.style.setProperty("--width-cap", cap);
    document.documentElement.style.setProperty("--toc-sidebar-width", tocSidebar);
    evaluateTocLayout();
  });
};

// Explicit setter for `:width <mode>`. No-op when the pref is
// already in the requested state.
export const setWidthMode = (mode: string) => {
  if (!WIDTH_CAPS[mode] || prefs.widthMode === mode) return;
  prefs.widthMode = mode;
  savePrefs();
  applyWidthMode();
};

// Cycle narrow → medium → wide → full → narrow. Bound to
// Ctrl+Alt+C / ⌃⌘C.
export const cycleWidthMode = () => {
  const i = WIDTH_MODES.indexOf(prefs.widthMode);
  const next = WIDTH_MODES[(i + 1) % WIDTH_MODES.length];
  setWidthMode(next === undefined ? "medium" : next);
};

// ================= Sidebar table of contents layout =================
// When the active document has `:toc: left` or `:toc: right`,
// honor it as a sidebar layout, but only when the surrounding
// conditions can support it. Otherwise, fall back to the default
// top-of-content placement that Asciidoctor's embedded
// output produces.
//
// Conditions for sidebar layout (all must hold):
//   1. Document has toc-position 'left' or 'right' (read from
//      the Asciidoctor doc object after load: embedded HTML
//      doesn't carry classes that distinguish the variants, so
//      RenderResult.tocPosition surfaces it).
//   2. Display mode is preview-only. Split mode's preview pane
//      shares the window 50/50 with the editor, too narrow per
//      pane for a meaningful sidebar plus content. Editor-only
//      mode hides the preview entirely so the layout is moot.
//   3. Width mode is not narrow. Narrow's text budget can't
//      accommodate a sidebar without compromising prose comfort.

// Cached toc-position from the most recent successful render.
// Lets display-mode and width-mode changes re-evaluate the
// layout without re-rendering. Set via setLastTocPosition,
// called from preview.ts after each render.
let lastTocPosition: string | null = null;

// User-controlled override for table of contents visibility,
// toggled via Ctrl+Alt+I / ⌃⌘I or `:toc on|off`. Session-scoped
// (not persisted to localStorage), defaulting to false on every
// launch so a fresh document load always shows whatever the
// source requested. Reasoning: tocHidden is a per-view override
// ("I don't want this doc's table of contents right now"), not
// a permanent UI preference. Persisting it would surprise the
// user on the next launch ("where is my table of contents?")
// with no preview-scroll restoration to compensate.
let tocHidden = false;

export const setLastTocPosition = (pos: string | null) => {
  lastTocPosition = pos;
  evaluateTocLayout();
};

export const evaluateTocLayout = () => {
  if (!previewPaneEl) return;
  previewPaneEl.classList.remove("has-sidebar-toc", "toc-left", "toc-right", "toc-hidden");
  if (tocHidden) {
    previewPaneEl.classList.add("toc-hidden");
    return;
  }
  if (lastTocPosition !== "left" && lastTocPosition !== "right") return;
  if (prefs.displayMode !== "preview") return;
  if (prefs.widthMode === "narrow") return;
  previewPaneEl.classList.add("has-sidebar-toc");
  previewPaneEl.classList.add(lastTocPosition === "left" ? "toc-left" : "toc-right");
};

// Flip the table of contents visibility override and
// re-evaluate the layout. Bound to Ctrl+Alt+I / ⌃⌘I.
export const toggleTocVisibility = () => {
  tocHidden = !tocHidden;
  evaluateTocLayout();
};

// Explicit setter for `:toc on` / `:toc off`. No-op when already
// in the requested state.
export const applyTocVisibility = (visible: boolean) => {
  const targetHidden = !visible;
  if (tocHidden === targetHidden) return;
  tocHidden = targetHidden;
  evaluateTocLayout();
};

export const isTocHidden = () => tocHidden;

// Rewrite the help dialog's modifier keys on Mac. Apple convention is
// symbols with no separator, in a fixed order: Control, Option, Shift,
// Command, with Command always LAST (next to the key). So ⌘S, ⇧⌘N, ⌃⌘T,
// matching the macOS menu bar, System Settings, and Apple's own
// documentation. We emit the symbols in that canonical order rather than
// substituting in place, because the source token order (Ctrl, Alt, Shift)
// maps to a different symbol order under the app's Mac binding (Ctrl
// becomes ⌘, which then has to move to the end). Linux and Windows keep
// the Ctrl+Shift+N form, which is what's printed on their physical keys.
//
// Two distinct mappings, switched by a CSS class on the <kbd>:
//
//   App-shortcut <kbd>s (default, no `vim` class). The keydown handler
//   binds these. On Mac it accepts only metaKey (Cmd) as primary and
//   ctrlKey (Ctrl) as secondary, so "Ctrl+Alt+T" in source maps to:
//     Ctrl  → ⌘   (primary modifier on Mac is Cmd, not Ctrl)
//     Alt   → ⌃   (secondary modifier on Mac is Ctrl, not Option,
//                  see "Keyboard shortcuts" block in main.ts for why
//                  Option doesn't work: macOS layout-level character
//                  composition breaks letter-matching, plus several
//                  Option+Cmd+letter combos are OS-reserved at the
//                  system level)
//     Shift → ⇧
//
//   Vim-binding <kbd>s (kbd class="vim"). These represent literal
//   physical keys that Vim binds inside the editor. We don't capture
//   them in our keydown handler. So "Ctrl+Q" in a Vim kbd really means
//   physical Control+Q, not Cmd+Q. Different mapping needed:
//     Ctrl  → ⌃   (literal Control symbol, the actual key Vim uses)
//     Alt   → ⌥   (literal Option symbol)
//     Shift → ⇧
//   Without this distinction, V-BLOCK's "Ctrl+Q" would render as ⌘Q,
//   which on Mac is Quit, actively misleading the reader. Mark a kbd
//   as a Vim binding by adding class="vim" in the source HTML.
//
// Other Mac key symbols (Return ↵, Tab ⇥, Escape ⎋, Backspace ⌫)
// aren't used in our current help dialog but could be added to this
// function if we ever show them as shortcuts.
//
// Also strips the .mac-only class from any element inside the help
// dialog. Those elements are hidden by default via styles.css's
// `.mac-only { display: none; }` rule. Removing the class on Mac
// makes them visible. Used for advertising Mac-specific alternative
// bindings, e.g., V-BLOCK's Ctrl+V kbd, which only actually works
// on Mac (Linux/Windows webviews intercept Ctrl+V for paste before
// it reaches Vim).
//
// .non-mac is the inverse: visible by default (no CSS rule needed),
// removed here on Mac. Used where the authored Linux/Windows chord
// would rewrite into a wrong or unbound Mac chord, e.g., redo's
// Ctrl+Y, whose Mac form is Shift+Cmd+Z rather than Cmd+Y, so the
// help row pairs a .non-mac Ctrl+Y with a .mac-only Ctrl+Shift+Z.
//
// Runs once at init since the help dialog's DOM is static, no need
// to re-run on each dialog open.
//
// Selector scope: .help-dialog kbd. Other <kbd> elements elsewhere
// (if added later) would need to opt in by being inside .help-dialog
// or by extending this function's selector.
export const applyMacModifierLabels = () => {
  if (!isMac) return;
  document.querySelectorAll(".help-dialog .mac-only").forEach((el) => {
    el.classList.remove("mac-only");
  });
  document.querySelectorAll(".help-dialog .non-mac").forEach((el) => {
    el.remove();
  });
  // Apple's canonical modifier order, with Command last.
  const order = "⌃⌥⇧⌘";
  document.querySelectorAll(".help-dialog kbd").forEach((kbd) => {
    const isVim = kbd.classList.contains("vim");
    // App shortcuts are authored as Ctrl+Alt+key (Linux/Windows form).
    // On Mac the same chord is Cmd+Control (Cmd primary, Control
    // secondary), so the authored Ctrl maps to ⌘ and the authored Alt
    // to ⌃. Vim kbds are physical keys: Ctrl stays ⌃, Alt stays ⌥.
    const toSymbol: Record<string, string> = isVim
      ? { Ctrl: "⌃", Alt: "⌥", Shift: "⇧" }
      : { Ctrl: "⌘", Alt: "⌃", Shift: "⇧" };
    const mods: string[] = [];
    const keys: string[] = [];
    for (const part of (kbd.textContent ?? "").split("+")) {
      const symbol = toSymbol[part];
      if (symbol) mods.push(symbol);
      else keys.push(part);
    }
    // A kbd with no modifier tokens (:w <var>filename</var>, zg) has
    // nothing to rewrite, and reassigning textContent would flatten
    // its inner markup (the <var> placeholders). Leave it untouched.
    if (mods.length === 0) return;
    mods.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    kbd.textContent = mods.join("") + keys.join("");
  });
  // The bar's "?" button names the same help shortcut in its accessible
  // name. That's a plain-text attribute, so it can't carry <kbd> and the
  // loop above doesn't reach it. Rewrite the keybind to the Mac form here
  // so screen readers announce the right chord (Ctrl+Alt+H -> Ctrl+Cmd+H).
  const helpLabel = helpBtn.getAttribute("aria-label");
  if (helpLabel) {
    helpBtn.setAttribute("aria-label", helpLabel.replace("Ctrl+Alt+H", "Ctrl+Cmd+H"));
  }
};

export const toggleVim = () => {
  prefs.vimMode = !prefs.vimMode;
  savePrefs();
  setVimMode(prefs.vimMode);
  // Show / hide the mode pill immediately on Vim toggle.
  refreshStatus();
};

export const DISPLAY_MODES = ["split", "editor", "preview"];
export const applyDisplayMode = () => {
  guardEditorGeometry(() => {
    const cl = document.body.classList;
    for (const m of DISPLAY_MODES) cl.remove(`mode-${m}`);
    cl.add(`mode-${prefs.displayMode}`);
  });
};
// Toggle keyboard focus between the editor pane and the preview pane.
// Only meaningful in split mode: in editor-only and preview-only
// modes there's only one pane and nothing to toggle, so the call is
// a no-op. Pairs with the :focus-within outline rule in styles.css
// that visually marks the active pane. Each press moves focus AND
// the outline to the other pane.
//
// "Has focus" is read via editorView.hasFocus, which is true only
// when the editor's contentDOM itself is the active element (a
// focused search or Vim Ex panel input reads as false, and toggling
// from those lands back on the editor content, not the preview). If
// the editor has focus, move to the preview element (which is
// programmatically focusable via tabindex="-1" on the div). Otherwise
// move to the editor. This covers both the "preview is focused" case
// and the "neither pane is focused" case (e.g., focus is on a
// chrome element), both of which should land the user back in the
// editor.
export const togglePaneFocus = () => {
  if (prefs.displayMode !== "split") return;
  if (!editorView) return;
  if (editorView.hasFocus) {
    out.focus();
  } else {
    editorView.focus();
  }
};

// Remembers which pane was focused in split mode the last time we left
// split for a single-pane mode. Read by setDisplayMode when returning
// to split so a round-trip through editor-only or preview-only lands
// back on the pane the user had before the trip.
//
// Mental model: entering editor-only or preview-only is an attention
// shift comparable to switching to a different app. Returning to split
// should resume the prior state, not reset to a default, for the same
// a browser's tab focus doesn't reset when you alt-tab away and back.
//
// Seeded to 'editor' because that's the pane the app starts focused
// on at cold launch. If the very first mode transition is preview-only
// → split (rare: requires saved displayMode = preview-only and no
// prior in-session split activity), we land on editor, which is still
// a reasonable default.
let lastSplitFocus: "editor" | "preview" = "editor";

export const setDisplayMode = (mode: string) => {
  if (!DISPLAY_MODES.includes(mode)) return;
  const prevMode = prefs.displayMode;
  // Capture the in-split focus before leaving split, so we can restore
  // it on the return trip. Only fires on split → single-pane transitions:
  // split → split is a no-op (shouldn't happen since applyDisplayMode
  // would already have the right class), and single → single has no
  // split state worth recording. If focus is on neither pane (e.g., on
  // the help button, status bar, or body), keep the previous
  // lastSplitFocus unchanged, since overwriting with "nothing" would lose
  // the last real value and we'd fall back to the default on return.
  if (prevMode === "split" && mode !== "split" && editorView) {
    if (editorView.hasFocus) {
      lastSplitFocus = "editor";
    } else if (document.activeElement === out) {
      lastSplitFocus = "preview";
    }
  }
  prefs.displayMode = mode;
  savePrefs();
  applyDisplayMode();
  // Hiding the preview ends any active peek: the peek is a transient
  // reading surface and never outlives its pane. No-op when idle.
  if (mode === "editor") exitPeek();
  if (!editorView) return;
  // Focus/blur the editor explicitly on mode transition so the
  // newly-visible surface has predictable focus state:
  //
  //   - 'preview': blur the editor and focus the preview. The blur
  //     is needed because WebKit doesn't reliably blur a focused
  //     contenteditable when its ancestor becomes display:none (via
  //     body.mode-preview → .editor-pane), so keystrokes could
  //     still reach the invisible editor and modify the source
  //     behind the user's back. The out.focus() puts keyboard focus
  //     on the visible preview surface so arrow keys / Page Up /
  //     Page Down actually scroll the preview. Without it, focus
  //     falls to <body>, which doesn't react to those keys at all
  //     in this layout.
  //   - 'editor': focus the editor. With the preview hidden, the
  //     editor is the only input surface, so it should always be
  //     ready to receive keystrokes, regardless of what was focused
  //     before the mode switch (often body, after a prior
  //     preview-mode blur or a click on preview in split mode).
  //     Without this, opening the help dialog straight after
  //     switching to edit-only captures `body` as pre-help focus,
  //     restoration lands on body (no-op), and `:` silently fails.
  //   - 'split' from a single-pane mode: restore focus to whichever
  //     pane was last focused in split before the round-trip, tracked
  //     in lastSplitFocus. See the comment above that variable for
  //     the "attention shift" rationale.
  //   - 'split' from 'split': no-op. Same-mode calls (shouldn't occur
  //     in practice) don't clobber the user's current in-split focus.
  if (mode === "preview") {
    editorView.contentDOM.blur();
    out.focus();
  } else if (mode === "editor") {
    editorView.focus();
  } else if (mode === "split" && prevMode !== "split") {
    if (lastSplitFocus === "preview") {
      out.focus();
    } else {
      editorView.focus();
    }
  }
  // Sidebar table-of-contents layout is preview-only.
  // Re-evaluate preview mode strips the sidebar classes (and
  // entering it applies them if conditions hold).
  evaluateTocLayout();
};

// ================= User config application =================
//
// Apply overrides from the user's skrivro.conf file to :root CSS custom
// properties and body classes. The CSS variables (--font-mono,
// --font-sans, --editor-font-size, --preview-font-size,
// --editor-padding-x, --editor-padding-y, --preview-padding-x,
// --preview-padding-y) are all consumed by the CM6 theme and the
// pane / scroll-container CSS rules, so a single assignment here
// propagates to every rendered element that reads them. No CM6
// dispatch effects, no theme reconfiguration dance. This is why
// CSS variables are strictly simpler than CM6 Compartments for
// this use case.
//
// Runtime-read keys (asciidocSafeMode, cursorPositionFormat) are NOT
// handled here: render() and formatCursorPosition() read them
// directly from the module-level userConfig each time they run.
//
// Call order: runs before `createEditor(...)` in the init block so
// the first paint carries the user's values. The CM6 theme references
// these variables via var(), which the browser resolves live (see the
// font-size note below), so a later assignment would still apply.
// The ordering is for a clean first frame.
export const applyUserConfig = (cfg: SkrivroConfig) => {
  const root = document.documentElement;

  // Font overrides: prepend the user's font to the existing stack so
  // their choice wins if the font is installed on the system, and the
  // original fallback chain kicks in if not. Without prepending, a
  // user whose `editor-font` names a font the machine doesn't have
  // would get the browser's default monospace (usually ugly) instead
  // of our curated stack. Read the current stack via getComputedStyle,
  // since it's defined in styles.css, not as a JS constant, so we
  // can't inline the default here.
  if (cfg.editorFont) {
    const current = getComputedStyle(root).getPropertyValue("--font-mono").trim();
    root.style.setProperty("--font-mono", `${cfg.editorFont}, ${current}`);
  }
  if (cfg.previewFont) {
    const current = getComputedStyle(root).getPropertyValue("--font-sans").trim();
    root.style.setProperty("--font-sans", `${cfg.previewFont}, ${current}`);
  }

  // Font size overrides: direct CSS variable assignment propagates
  // automatically to the CM6 theme (fontSize: 'var(--editor-font-size)')
  // and the .preview-scroll CSS rule (font-size: var(--preview-font-size)).
  if (cfg.editorFontSize) {
    root.style.setProperty("--editor-font-size", cfg.editorFontSize);
  }
  if (cfg.previewFontSize) {
    root.style.setProperty("--preview-font-size", cfg.previewFontSize);
  }

  // Padding overrides (editor and preview, x and y axes). Four
  // independent variables, one per axis per pane.
  //
  // Editor side. --editor-padding-y is consumed by .cm-scroller's
  // margin-block in styles.css. Margin on .cm-scroller (rather than
  // padding on .editor-pane) keeps CM6's .cm-panels-bottom (the
  // container for Vim's Ex bar) anchored to the pane's bottom
  // rather than floating above a padded gap. --editor-padding-x is
  // consumed by .cm-line's padding-inline (in the CM6 theme) because
  // per-line horizontal padding is what keeps clicks near the far-
  // left of a line landing on the line rather than in a dead zone.
  //
  // Preview side. --preview-padding-y drives the top/bottom offsets
  // of the inner .preview-scroll element (`top: var(--preview-padding-y)`
  // and `bottom: var(--preview-padding-y)` in the CSS), so scrolled
  // content is clipped away from the outer .preview-pane's edges.
  // --preview-padding-x is consumed by .preview-scroll's padding-inline.
  //
  // Each variable's value is the user's raw string: one or two
  // whitespace-separated CSS length tokens. The Rust-side
  // normalize_length helper has already validated token count
  // (max 2) and rejected any bare numbers, so whatever arrives
  // here has unit suffixes and is ready to substitute directly
  // into CSS.
  if (cfg.editorPaddingX) {
    root.style.setProperty("--editor-padding-x", cfg.editorPaddingX);
  }
  if (cfg.editorPaddingY) {
    root.style.setProperty("--editor-padding-y", cfg.editorPaddingY);
  }
  if (cfg.previewPaddingX) {
    root.style.setProperty("--preview-padding-x", cfg.previewPaddingX);
  }
  if (cfg.previewPaddingY) {
    root.style.setProperty("--preview-padding-y", cfg.previewPaddingY);
  }

  // Status bar mode pill style: canonical (default, bright Catppuccin
  // blue/green/mauve/red/peach from catppuccin/nvim's lualine.lua)
  // vs muted (LazyVim-inspired, normal = surface0 + subtext0, visual
  // = pink + base, other modes stay canonical). Implementation is a
  // body class that CSS conditionally overrides the canonical pill
  // colors when set. Unknown values fall through to canonical with
  // a warning.
  if (cfg.statusbarStyle === "muted") {
    document.body.classList.add("mode-pill-muted");
  } else if (cfg.statusbarStyle && cfg.statusbarStyle !== "canonical") {
    console.warn(
      `[skrivro config] statusbar-style '${cfg.statusbarStyle}' not ` +
        `recognized (expected 'canonical' or 'muted'), using canonical`,
    );
  }

  // Theme colors: when the user selects a non-default theme via
  // `theme = dracula` (or any name other than catppuccin-mocha), the
  // Rust side resolves the theme file and attaches the parsed colors
  // as cfg.themeColors. We iterate the object and write each value
  // as an inline :root style, overriding the CSS-default Catppuccin
  // Mocha values. When themeColors is null/undefined (catppuccin-mocha
  // or unset), this block is skipped and the CSS defaults show through.
  //
  // The camelCase→kebab-case conversion (e.g., bgPanel → bg-panel)
  // maps the serde-generated JSON key names back to CSS custom
  // property names: userConfig.themeColors.bgPanel sets
  // --skr-bg-panel on :root.
  if (cfg.themeColors) {
    for (const [key, value] of Object.entries(cfg.themeColors)) {
      if (value != null) {
        // Convert camelCase to kebab-case: bgPanel → bg-panel
        const kebab = key.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
        root.style.setProperty(`--skr-${kebab}`, value);
      }
    }
  }

  // asciidocSafeMode and cursorPositionFormat are not applied here:
  // they're read directly from userConfig by render() and
  // formatCursorPosition() at the points where they take effect.
};

// ================= Host-level status-bar listeners =================
//
// The CM6 updateListener (editor.js, inside makeExtensions) catches doc
// and selection changes via onSelectionChange, which covers most Vim
// mode transitions, since most mode changes also tend to change selection
// (v → visual starts a selection, Esc from insert → cursor moves back
// by 1, etc.). But pure-mode transitions like `i` (normal → insert at
// the current position) don't touch doc or selection, so onSelectionChange
// never fires for those. A keyup listener on the editor host catches
// them: every mode transition goes through a keypress, so reading mode
// state on every keyup is sufficient. Cheap because refreshStatus just
// reads a few DOM properties and dispatches no CM state updates.
host.addEventListener("keyup", refreshStatus);

// COMMAND mode detection. The Vim command panel is rendered as a
// CM6 panel containing an <input> element. Pressing `:` focuses
// the input, and completing or canceling the command blurs it.
// Tracking focus/blur on the input is the simplest signal, no
// MutationObserver needed. The check matches any <input> inside the
// editor host, which today means the Vim Ex input and the
// find/replace panel's fields, so the pill also reads COMMAND while
// the search panel has focus.
// `e.target instanceof HTMLInputElement` narrows EventTarget to the
// specific <input> type we care about. Equivalent to the prior
// `e.target.tagName === 'INPUT'` check but type-aware: TS sees
// e.target as HTMLInputElement inside the guard block, and no cast
// is needed to access input-specific methods/properties later if we
// ever add any.
host.addEventListener("focusin", (e) => {
  if (e.target instanceof HTMLInputElement) {
    inCommandMode = true;
    refreshStatus();
  }
});
host.addEventListener("focusout", (e) => {
  if (e.target instanceof HTMLInputElement) {
    inCommandMode = false;
    refreshStatus();
  }
});

// Keep the editor focused when clicking non-content regions of the
// editor pane: gutter (line numbers), scrollbar, pane padding, and
// the empty space around the scroller. Without this, clicking any of
// those moves focus to <body>, and subsequent keystrokes, Vim
// commands, and Ex commands (`:w`, `:e`, etc.) silently don't reach
// the editor until the user clicks back into the content. The
// scrollbar case produced an especially confusing symptom: the FIRST
// `:` after a scrollbar click was swallowed (focus moving back to
// the editor mid-keystroke), and only the second `:` opened the Ex
// prompt.
//
// .cm-content is CM6's contenteditable surface, the one place where
// clicks legitimately move focus. CM6 handles cursor placement there,
// so we skip our redirect. Input elements (CM6's search panel, the
// Vim Ex input) are also skipped so their own focus semantics work.
//
// requestAnimationFrame defers the focus call to AFTER the browser's
// default focus change from the mousedown, which would otherwise
// override an immediate .focus() and move focus to <body> anyway.
host.addEventListener("mousedown", (e) => {
  if (!(e.target instanceof Element)) return;
  if (e.target.closest(".cm-content")) return;
  if (e.target instanceof HTMLInputElement) return;
  requestAnimationFrame(() => {
    if (editorView) editorView.contentDOM.focus();
  });
});

// ================= Single-pane scroll + focus routing =================
//
// In editor-only and preview-only modes, the inner scrollable
// element (.cm-scroller for editor, .preview-scroll for preview) is
// centered with margin-auto inside its pane and capped to a width
// less than the pane. The empty margin space around the scroller
// lives in flex containers without overflow, so user input over
// that space (wheel events, mousedowns) has no scrollable / focus
// target ancestor by default. The handlers below forward those
// events to the inner element so single-pane modes behave
// consistently no matter where in the pane the cursor is.
//
// Skipped in split mode because the cap rules (`body.mode-editor` /
// `body.mode-preview` scoping) don't apply there: each pane fills
// its half of .wrap with no margin gap to worry about.

const wrapEl = document.querySelector(".wrap");
if (wrapEl) {
  // Wheel forwarder: scroll the inner scroller via scrollBy when the
  // wheel event lands outside it. passive: false because we
  // preventDefault.
  wrapEl.addEventListener(
    "wheel",
    (e: Event) => {
      const we = e as WheelEvent;
      let scroller: Element | null;
      if (prefs.displayMode === "editor") {
        scroller = editorView ? editorView.scrollDOM : null;
      } else if (prefs.displayMode === "preview") {
        scroller = out;
      } else {
        return; // split: each pane handles its own wheel
      }
      if (!scroller) return;
      if (!(we.target instanceof Node)) return;
      if (scroller.contains(we.target)) return; // landed on inner scroller
      we.preventDefault();
      scroller.scrollBy({ top: we.deltaY, left: we.deltaX });
    },
    { passive: false },
  );

  // Preview-only margin click: clicks on the margin areas (outside
  // the capped-width preview content but still inside .wrap) take
  // focus off the preview and put it on <body>, which breaks
  // keyboard navigation. preventDefault + synchronous focus is the
  // working pattern (queueMicrotask deferred runs AFTER the default
  // focus shift, so focus ricochets).
  wrapEl.addEventListener("mousedown", (e: Event) => {
    if (prefs.displayMode !== "preview") return;
    const me = e as MouseEvent;
    if (!(me.target instanceof Node)) return;
    if (out.contains(me.target)) return;
    me.preventDefault();
    out.focus();
  });

  // Editor-only margin click: clicks on the margin areas around
  // .cm-scroller can blur the editor's contentDOM. CM6 has its own
  // mousedown handler that catches margin clicks and places the
  // cursor on the nearest line: for different-Y clicks this works
  // and keeps focus, but for same-Y clicks CM6 sees "no cursor
  // movement needed" and silently doesn't refocus contentDOM, so
  // the editor blurs.
  //
  // preventDefault + synchronous focus stops two default behaviors:
  //   1. The browser's focus shift to <body> for clicks on a non-
  //      focusable target (which would override our focus call).
  //   2. CM6's margin-click cursor placement at different Y. That
  //      jump is gone here, a deliberate trade-off. Margin clicks
  //      as a way to navigate to a specific line are unusual: most
  //      users click the text directly or use keyboard navigation.
  //      Losing that path is preferable to losing focus on accidental
  //      margin clicks.
  //
  // The .cm-panels skip is so clicks on the Vim Ex command bar (or
  // CM6's search panel) don't get their focus stolen by the editor.
  // The existing host mousedown listener above also fires (it's on
  // .editor-pane which is inside .wrap), but the rAF refocus there
  // is a harmless no-op when we've already synchronously focused
  // the editor here.
  wrapEl.addEventListener("mousedown", (e: Event) => {
    if (prefs.displayMode !== "editor") return;
    if (!editorView) return;
    const me = e as MouseEvent;
    if (!(me.target instanceof Element)) return;
    if (editorView.scrollDOM.contains(me.target)) return;
    if (me.target.closest(".cm-panels")) return;
    me.preventDefault();
    editorView.focus();
  });
}

// Keep a pane focused when clicking the status bar (split and
// editor-only modes only: in preview-only mode the editor is
// intentionally blurred by setDisplayMode). The bar carries
// `data-tauri-drag-region`, which sometimes consumes the mousedown
// event (preserving pane focus as a side effect) and sometimes lets
// it through (focus moves to <body>, and Ex commands silently fail
// until the user clicks back into a pane). The flakiness is a Tauri
// drag-region quirk. The redirect below makes focus preservation
// deterministic regardless of how Tauri handles any given click.
//
// In split mode, the redirect preserves whichever pane was focused
// before the click, since clicking chrome should be a no-op for focus
// state, not a pane switch from preview to editor. In editor-only
// mode there's only one pane anyway, so this collapses to the old
// "always editor" behavior. The wasPreviewFocused capture is
// synchronous (mousedown fires before the browser's default focus
// change), so it reflects the pre-click state even though the
// .focus() call is deferred to the next frame via rAF.
//
// Skip clicks on buttons (the help `?` button) and inputs, since
// those have their own focus semantics that shouldn't be overridden.
// In preview mode, skip the redirect so the editor stays blurred and
// the preview remains the read-only surface.
const chromeFocusRedirect = (e: MouseEvent) => {
  if (prefs.displayMode === "preview") return;
  if (!(e.target instanceof Element)) return;
  if (e.target instanceof HTMLButtonElement) return;
  if (e.target instanceof HTMLInputElement) return;
  const wasPreviewFocused = prefs.displayMode === "split" && document.activeElement === out;
  requestAnimationFrame(() => {
    if (wasPreviewFocused) {
      out.focus();
    } else if (editorView) {
      editorView.contentDOM.focus();
    }
  });
};
statusBar.addEventListener("mousedown", chromeFocusRedirect as EventListener);

// `:` auto-capture in split mode. If the editor doesn't have focus
// when `:` is pressed (typically because the user clicked the preview
// pane to scroll or select), hand the key directly to Vim via the
// plugin's handleKey entry point. Opens the Ex prompt on the FIRST
// keystroke instead of requiring the user to click back into the
// editor first. Focus shifts to the Ex panel's input, same as a
// normal `:` press inside the editor would produce.
//
// Scope is deliberately narrow:
//
//   - Split mode only. Editor-only mode already focuses the editor
//     on mode switch (so `:` naturally works there), and preview-
//     only mode intentionally doesn't accept input, so auto-capture
//     there would either open an invisible Ex prompt in the hidden
//     editor or force a mode switch, both worse than doing nothing.
//   - Plain `:` only, no modifiers. Ctrl/Alt/Cmd+`:` might be a
//     shortcut in some layout, so don't swallow.
//   - Skip when contentDOM already has focus (the normal Vim path
//     handles it) and when an input/textarea has focus (the CM6
//     search panel, the Vim Ex panel itself, confirm-dialog inputs).
//   - Skip when Vim mode is disabled: `:` has no Ex meaning without
//     Vim, so swallowing it would just lose the keystroke.
//
// Capture phase beats CM6's keymap (same rationale as the existing
// window shortcut listener in main.ts).
window.addEventListener(
  "keydown",
  (e) => {
    if (e.key !== ":") return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (prefs.displayMode !== "split") return;
    if (!prefs.vimMode) return;
    if (!editorView) return;
    const active = document.activeElement;
    if (active === editorView.contentDOM) return;
    if (active instanceof HTMLInputElement) return;
    if (active instanceof HTMLTextAreaElement) return;
    const cm = getCM(editorView);
    if (!cm) return;
    e.preventDefault();
    // `'user'` origin mirrors how the plugin labels user-initiated
    // keystrokes internally (vs. replayed macros).
    Vim.handleKey(cm, ":", "user");
  },
  { capture: true },
);

// Suppress the native context menu in the preview pane unless the
// user has selected text inside the preview itself. The webview's
// default menu in the preview is just browser-navigation junk
// (Back / Forward / Stop / Reload) which doesn't belong in a desktop
// app. Reload specifically reloads the entire frontend and wipes
// in-memory editor state down to the autosave's 500ms-window
// granularity. With a selection, however, the native menu adds a
// useful Copy item, so we let it through in that case.
//
// Scope: listener on `.preview-pane` (the outer wrapper, not
// `.preview-scroll`) so right-clicks on the padding region between
// `.preview-scroll` and the visible pane edges are also caught. The
// editor pane is left alone: CM6's default context menu provides
// useful items (Copy, Paste, Select All, Undo, Redo) there.
//
// Selection check confines the "let menu through" path to selections
// anchored within the preview pane itself. A selection still active
// in the editor (where the user copied something earlier) doesn't
// count, since it'd surface a Copy item that copies from the editor
// when the user is right-clicking in the preview, which is
// confusing.
if (previewPaneEl) {
  previewPaneEl.addEventListener("contextmenu", (e) => {
    const selection = window.getSelection();
    const hasPreviewSelection =
      selection !== null &&
      !selection.isCollapsed &&
      selection.anchorNode !== null &&
      previewPaneEl.contains(selection.anchorNode);
    if (!hasPreviewSelection) {
      e.preventDefault();
    }
  });
}

// In production, kill the webview's native context menu on non-editable
// surfaces (its reload/back/etc. items). Editable targets keep their
// cut/copy/paste, while dev keeps the full menu so Inspect stays. The
// find/replace panel lives inside .cm-editor, so we key off
// contenteditable + inputs rather than excluding .cm-editor.
if (import.meta.env.PROD) {
  document.addEventListener("contextmenu", (e) => {
    const target = e.target as Element | null;
    if (!target?.closest("input, textarea, [contenteditable]")) {
      e.preventDefault();
    }
  });
}

// Scope Ctrl+A (Cmd+A on Mac) to the preview's content when the
// preview pane is the focused element. WebKit's default behavior on
// Ctrl+A applied to a focused non-editable div with `tabindex="-1"`
// is "select everything in the document", which in split mode means
// selecting both panes plus chrome text simultaneously. That sprawl
// is what makes Ctrl+A appear broken in split-preview mode (the
// selection IS happening, just unscoped). Confirmed via DevTools:
// `document.activeElement` is correctly `.preview-scroll`, but the
// resulting `window.getSelection()` returns the editor's source
// content alongside the preview's rendered text.
//
// We replace that webview default with a deterministic Range that
// scopes to `out` (the `.preview-scroll` element). Same behavior
// users already get reliably in preview-only mode (where the editor
// pane is `display: none` and therefore excluded from the webview's
// implicit document-wide select-all anyway).
//
// Editor focus path is left untouched. When `.cm-content` has focus,
// CM6's default keymap handles Mod-a → selectAll (non-Vim), and the
// Vim plugin handles Ctrl+A → increment-number (Vim mode). Both
// behaviors are preserved by the early return below.
window.addEventListener(
  "keydown",
  (e) => {
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (!mod) return;
    if ((e.key || "").toLowerCase() !== "a") return;
    // Reject if the secondary modifier or Shift is also held: this
    // handler is for plain Ctrl+A / Cmd+A only, not Ctrl+Alt+A or
    // Ctrl+Cmd+A or Ctrl+Shift+A. Secondary modifier is Alt on
    // Linux/Windows, Ctrl on Mac (since primary is Cmd there), the
    // same mapping main.ts uses for app shortcuts.
    const second = isMac ? e.ctrlKey : e.altKey;
    if (e.shiftKey || second) return;
    // Scope to the preview when:
    //   (a) preview element is the currently-focused element (split or
    //       preview-only after explicit focus via Ctrl+Alt+W / ⌃⌘W or
    //       click), OR
    //   (b) we're in preview-only mode regardless of where focus
    //       actually lives. After setDisplayMode('preview') blurs the
    //       editor, focus typically lands on <body>, and Ctrl+A on body
    //       falls through to the webview's default "select entire
    //       visible document," which sweeps in the status bar text
    //       (filename, format, word count) alongside the rendered
    //       preview content. In preview-only there's no other pane the
    //       user could possibly mean (preview is the sole visible
    //       surface), so we scope unambiguously.
    // Split mode with focus on body is intentionally NOT covered here:
    // the user could mean either pane and we'd be guessing.
    const previewFocused = document.activeElement === out;
    const previewOnlyMode = prefs.displayMode === "preview";
    if (!previewFocused && !previewOnlyMode) return;
    e.preventDefault();
    const range = document.createRange();
    range.selectNodeContents(out);
    const selection = window.getSelection();
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(range);
    }
  },
  { capture: true },
);
