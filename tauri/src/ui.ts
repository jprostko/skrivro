// ================= UI =================
// Status bar rendering, help dialog, confirm dialog, pref-backed
// toggles (titlebar / gutter / status bar / display mode / vim mode),
// Mac help-label rewriting, user config application. Also owns the
// host-level listeners that drive status bar state: keyup for mode
// tracking, focusin/focusout on the vim command panel input for
// COMMAND mode detection.

import { tr } from './i18n.js';
import { prefs, savePrefs } from './prefs.js';
import { isMac } from './i18n.js';
import { editorView, setVimMode, getCM } from './editor.js';
import { currentName } from './io.js';
import { userConfig, type SkrivroConfig } from './config.js';

// ================= DOM refs =================

const out                 = document.getElementById('out');
const host                = document.getElementById('src-host');
const statusBar           = document.getElementById('statusbar');
const statusMode          = document.getElementById('statusMode');
const statusFilename      = document.getElementById('statusFilename');
const statusPosition      = document.getElementById('statusPosition');
const statusWordCount     = document.getElementById('statusWordCount');
const helpDlg             = document.getElementById('helpDialog');
const helpBtn             = document.getElementById('helpBtn');
const helpCloseBtn        = document.getElementById('helpCloseBtn');

// ================= Status bar =================
//
// See memory/project_status_bar.md for the design spec. Summary:
//   - Mode pill (left): canonical Catppuccin colors from catppuccin/nvim
//     (blue/green/mauve/red/peach). Hidden when vim is off.
//   - Filename (left): dirty indicator + basename
//   - File type (right): hardcoded 'AsciiDoc' for v1
//   - Cursor position (right): 'Ln 42, Col 85', 1-indexed, codepoint-aware
//   - In visual modes, cursor position is replaced with selection info

// COMMAND mode tracking. Flipped true when the vim Ex command panel's
// <input> gains focus, false when it loses focus. Updated by the
// focusin/focusout listeners on host at the bottom of this module.
let inCommandMode = false;

// Read the current vim mode from @replit/codemirror-vim's state.
// getCM() returns a CM5-compat wrapper whose .state.vim holds the
// vim mode flags (insertMode, visualMode, visualLine, visualBlock),
// and whose .state.overwrite distinguishes REPLACE from plain INSERT.
//
// Returns null if vim is off (signals "hide the pill"); returns
// 'command' if the Ex command panel is currently focused (tracked
// via inCommandMode, set by focusin/focusout listeners registered
// after editor creation).
//
// REPLACE vs INSERT precedence: the plugin models REPLACE as a
// sub-state of INSERT (matching real Vim's internal model) —
// pressing R sets vs.insertMode=true AND cm.state.overwrite=true
// via the toggleOverwrite action. insertMode alone is ambiguous,
// so the overwrite flag has to be checked BEFORE falling through
// to 'insert'. Plugin source reference: the `enterInsertMode`
// action with `actionArgs.replace` calls cm.toggleOverwrite(true)
// and sets the keyMap to 'vim-replace'.
const readVimMode = () => {
  if (!prefs.vimMode) return null;
  if (inCommandMode) return 'command';
  if (!editorView) return 'normal';
  try {
    const cm = getCM(editorView);
    if (!cm || !cm.state) return 'normal';
    const vs = cm.state.vim;
    if (!vs) return 'normal';
    if (vs.insertMode && cm.state.overwrite) return 'replace';
    if (vs.insertMode) return 'insert';
    if (vs.visualMode) return 'visual';
    return 'normal';
  } catch {
    return 'normal';
  }
};

// Sub-classify a visual-mode selection into char / line / block.
// All three share the same pill color (mauve per canonical Catppuccin);
// only the label text differs — VISUAL, V-LINE, V-BLOCK.
const readVisualVariant = () => {
  if (!editorView) return 'char';
  try {
    const cm = getCM(editorView);
    const vs = cm && cm.state && cm.state.vim;
    if (!vs || !vs.visualMode) return 'char';
    if (vs.visualBlock) return 'block';
    if (vs.visualLine) return 'line';
    return 'char';
  } catch {
    return 'char';
  }
};

const formatModeLabel = (mode, variant) => {
  switch (mode) {
    case 'insert':  return tr('INSERT');
    case 'replace': return tr('REPLACE');
    case 'command': return tr('COMMAND');
    case 'visual':
      if (variant === 'line')  return tr('V-LINE');
      if (variant === 'block') return tr('V-BLOCK');  // V-BLOCK same in Swedish
      return tr('VISUAL');
    default: return tr('NORMAL');  // NORMAL same in Swedish
  }
};

// Cursor position as 'Ln X, Col Y' (or a shorter variant), 1-indexed,
// codepoint-aware. Counts Unicode codepoints (via [...str].length)
// rather than JS string length (UTF-16 code units) so emoji and other
// non-BMP characters count as 1. Em-dashes, curly quotes, accented
// letters all count as 1. Prose-correct by construction.
//
// Format is configurable via `cursor-position-format` in skrivro.conf:
//   verbose (default): 'Ln 42, Col 85'  — prose-editor style
//   compact:           '42:85'           — terse code-editor style
//   ruler:             '42,85'           — Vim ruler style
// Stored in userConfig.cursorPositionFormat. Unknown values fall back
// to verbose so a typo in the config doesn't break the status bar.
//
// Returns { text, col }. The `text` is the display string; `col` is
// the raw numeric column so refreshStatus can compare it against
// userConfig.softColumnLimit without recomputing. `col` is null in
// the pre-editor fallback case where there's no cursor yet — the
// caller treats null as "never over-limit."
const formatCursorPosition = () => {
  if (!editorView) return { text: `${tr('Ln')} 1, ${tr('Col')} 1`, col: null };
  const head = editorView.state.selection.main.head;
  const line = editorView.state.doc.lineAt(head);
  const textBeforeCursor = line.text.slice(0, head - line.from);
  const col = [...textBeforeCursor].length + 1;
  let text;
  switch (userConfig.cursorPositionFormat) {
    case 'compact': text = `${line.number}:${col}`; break;
    case 'ruler':   text = `${line.number},${col}`; break;
    case 'verbose':
    default:        text = `${tr('Ln')} ${line.number}, ${tr('Col')} ${col}`; break;
  }
  return { text, col };
};

// Selection info displayed in visual modes in place of cursor position:
//   single-line char selection:  '87 chars'
//   multi-line char / V-LINE:    '3 lines, 240 chars'
//   V-BLOCK:                     '3 × 5' (rows × cols)
const formatSelectionInfo = (variant) => {
  if (!editorView) return '';
  const state = editorView.state;
  const sel = state.selection.main;
  const doc = state.doc;
  const from = Math.min(sel.anchor, sel.head);
  const to   = Math.max(sel.anchor, sel.head);
  const fromLine = doc.lineAt(from).number;
  const toLine   = doc.lineAt(to).number;
  const lines = toLine - fromLine + 1;

  if (variant === 'block') {
    // V-BLOCK: CM6 represents the rectangular selection as multiple
    // parallel ranges (one per row). Row count = range count. Column
    // width = max codepoint-delta across ranges.
    const ranges = state.selection.ranges;
    const rows = ranges.length > 1 ? ranges.length : lines;
    let cols = 0;
    for (const r of ranges) {
      const rLine = doc.lineAt(r.from);
      const rFromCol = [...rLine.text.slice(0, r.from - rLine.from)].length;
      const rToCol   = [...rLine.text.slice(0, r.to   - rLine.from)].length;
      cols = Math.max(cols, Math.abs(rToCol - rFromCol));
    }
    return `${rows} × ${cols || 1}`;
  }

  const chars = [...doc.sliceString(from, to)].length;
  if (lines > 1) return `${lines} ${tr('lines')}, ${chars} ${tr('chars')}`;
  return `${chars} ${tr('chars')}`;
};

export const refreshStatus = () => {
  if (!statusBar) return;
  const mode = readVimMode();
  const variant = mode === 'visual' ? readVisualVariant() : null;

  // Mode pill
  if (mode) {
    statusMode.hidden = false;
    statusMode.dataset.vimMode = mode;
    statusMode.textContent = formatModeLabel(mode, variant);
  } else {
    statusMode.hidden = true;
  }

  // Position slot: either vim visual-mode selection info or cursor
  // position. Over-limit coloring only applies to the cursor position
  // branch — selection info is a different display mode and the col
  // concept doesn't map onto it.
  let overLimit = false;
  if (mode === 'visual') {
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
    // effectively `col > 0` — which is always true for any cursor
    // position ≥ 1, so the over-limit class would be applied
    // constantly. typeof is the unambiguous fix: only a real number
    // enables the threshold check.
    overLimit = col !== null
      && typeof userConfig.softColumnLimit === 'number'
      && col > userConfig.softColumnLimit;
  }
  statusPosition.classList.toggle('over-limit', overLimit);

  statusFilename.textContent = currentName;
};

// Count words in the rendered preview's text content. Visible only in
// preview-only display mode (see the CSS `.status-word-count` rules),
// but computed on every render regardless so the value is current the
// moment the user switches into preview mode — no "stale until first
// render-in-preview" surprise.
//
// Reading from the rendered DOM rather than the AsciiDoc source means
// directive syntax (`include::`, attribute references, `:toc: left`)
// doesn't inflate the count with non-content tokens. The count
// reflects what a reader of the rendered document actually sees.
//
// For documents with includes, the count reflects the fully-expanded
// preview — opening book.adoc (which include::s chapters) shows the
// book-total, opening chapter-03.adoc directly shows that chapter.
//
// Format uses toLocaleString() with no arg so thousands separators
// match the user's browser locale (comma in en-US, space in sv-SE,
// dot in de-DE, etc.). Singular "1 word" vs plural "N words" handled
// explicitly — "1 words" reads as broken.
export const updateWordCount = () => {
  if (!statusWordCount) return;
  const text = out.textContent || '';
  const count = text.trim().split(/\s+/).filter(w => w.length > 0).length;
  const label = count === 1 ? tr('word') : tr('words');
  statusWordCount.textContent = `${count.toLocaleString()} ${label}`;
};

// ================= Help overlay =================
// Ctrl+Alt+H or the "?" button in the titlebar toggles the help
// dialog. Escape (native <dialog> behavior), the close button,
// and clicking the backdrop all dismiss it.
export const showHelp = () => {
  if (helpDlg.open) return;
  helpDlg.showModal();
  helpCloseBtn.focus();
};
export const hideHelp = () => {
  if (helpDlg.open) helpDlg.close();
};
export const toggleHelp = () => {
  if (helpDlg.open) hideHelp();
  else showHelp();
};
helpBtn.addEventListener('click', showHelp);
helpCloseBtn.addEventListener('click', hideHelp);
// When the click target IS the dialog element itself (as opposed to
// a child), it means the click landed on the backdrop area.
helpDlg.addEventListener('click', (e) => {
  if (e.target === helpDlg) hideHelp();
});

// ================= Toggles =================

export const applyTitlebar = () => {
  document.body.classList.toggle('no-titlebar', prefs.titlebarHidden);
};
export const toggleTitlebar = () => {
  prefs.titlebarHidden = !prefs.titlebarHidden;
  savePrefs();
  applyTitlebar();
};
export const applyGutter = () => {
  document.body.classList.toggle('no-gutter', prefs.gutterHidden);
};
export const toggleGutter = () => {
  prefs.gutterHidden = !prefs.gutterHidden;
  savePrefs();
  applyGutter();
};
export const applyStatusBar = () => {
  document.body.classList.toggle('no-statusbar', prefs.statusBarHidden);
};
export const toggleStatusBar = () => {
  prefs.statusBarHidden = !prefs.statusBarHidden;
  savePrefs();
  applyStatusBar();
};

// Rewrite the help dialog's modifier keys on Mac. Apple convention
// is symbols with no separator — ⌘S, ⌘⇧N, ⌘⌃T — matching what users
// see in the macOS menu bar, System Settings, and Apple's own
// documentation. Linux and Windows keep the Ctrl+Shift+N form because
// that's what's printed on their physical keys and what every other
// app on those platforms shows.
//
// Two distinct mappings, switched by a CSS class on the <kbd>:
//
//   App-shortcut <kbd>s (default — no `vim` class). The keydown handler
//   binds these. On Mac it accepts only metaKey (Cmd) as primary and
//   ctrlKey (Ctrl) as secondary, so "Ctrl+Alt+T" in source maps to:
//     Ctrl  → ⌘   (primary modifier on Mac is Cmd, not Ctrl)
//     Alt   → ⌃   (secondary modifier on Mac is Ctrl, not Option —
//                  see "Keyboard shortcuts" block in main.js for why
//                  Option doesn't work: macOS layout-level character
//                  composition breaks letter-matching, plus several
//                  Cmd+Option+letter combos are OS-reserved at the
//                  system level)
//     Shift → ⇧
//
//   Vim-binding <kbd>s (kbd class="vim"). These represent literal
//   physical keys that Vim binds inside the editor — we don't capture
//   them in our keydown handler. So "Ctrl+Q" in a vim kbd really means
//   physical Control+Q, not Cmd+Q. Different mapping needed:
//     Ctrl  → ⌃   (literal Control symbol, the actual key Vim uses)
//     Alt   → ⌥   (literal Option symbol)
//     Shift → ⇧
//   Without this distinction, V-BLOCK's "Ctrl+Q" would render as ⌘Q,
//   which on Mac is Quit — actively misleading the reader. Mark a kbd
//   as a vim binding by adding class="vim" in the source HTML.
//
// Other Mac key symbols (Return ↵, Tab ⇥, Escape ⎋, Backspace ⌫)
// aren't used in our current help dialog but could be added to this
// function if we ever show them as shortcuts.
//
// Also strips the .mac-only class from any element inside the help
// dialog. Those elements are hidden by default via styles.css's
// `.mac-only { display: none; }` rule; removing the class on Mac
// makes them visible. Used for advertising Mac-specific alternative
// bindings — e.g., V-BLOCK's Ctrl+V kbd, which only actually works
// on Mac (Linux/Windows webviews intercept Ctrl+V for paste before
// it reaches Vim).
//
// Runs once at init since the help dialog's DOM is static — no need
// to re-run on each dialog open.
//
// Selector scope: .help-dialog kbd. Other <kbd> elements elsewhere
// (if added later) would need to opt in by being inside .help-dialog
// or by extending this function's selector.
export const applyMacModifierLabels = () => {
  if (!isMac) return;
  document.querySelectorAll('.help-dialog .mac-only').forEach((el) => {
    el.classList.remove('mac-only');
  });
  document.querySelectorAll('.help-dialog kbd').forEach((kbd) => {
    const isVim = kbd.classList.contains('vim');
    kbd.textContent = kbd.textContent
      .replace(/\bCtrl\b/g, isVim ? '⌃' : '⌘')
      .replace(/\bAlt\b/g, isVim ? '⌥' : '⌃')
      .replace(/\bShift\b/g, '⇧')
      .replace(/\+/g, '');
  });
};

export const toggleVim = () => {
  prefs.vimMode = !prefs.vimMode;
  savePrefs();
  setVimMode(prefs.vimMode);
  // Show / hide the mode pill immediately on vim toggle.
  refreshStatus();
};

export const DISPLAY_MODES = ['split', 'editor', 'preview'];
export const applyDisplayMode = () => {
  const cl = document.body.classList;
  for (const m of DISPLAY_MODES) cl.remove(`mode-${m}`);
  cl.add(`mode-${prefs.displayMode}`);
};
export const setDisplayMode = (mode) => {
  if (!DISPLAY_MODES.includes(mode)) return;
  prefs.displayMode = mode;
  savePrefs();
  applyDisplayMode();
};

// ================= User config application =================
//
// Apply overrides from the user's skrivro.conf file to :root CSS custom
// properties and body classes. The CSS variables (--font-mono,
// --font-sans, --edit-font-size, --preview-font-size,
// --editor-padding-x, --editor-padding-y, --preview-padding-x,
// --preview-padding-y, --edit-pane-width, --preview-pane-width)
// are all consumed by the CM6 theme and the .preview / .cm-scroller
// CSS rules, so a single assignment here propagates to every
// rendered element that reads them. No CM6 dispatch effects, no
// theme reconfiguration dance — this is why CSS variables are
// strictly simpler than CM6 Compartments for this use case.
//
// Runtime-read keys (asciidocSafeMode, cursorPositionFormat) are NOT
// handled here — render() and formatCursorPosition() read them
// directly from the module-level userConfig each time they run.
//
// Call order: must run BEFORE `createEditor(...)` in the init block,
// because the CM6 theme extension reads CSS variables at editor
// construction time. Overriding afterwards would require a dispatched
// reconfigure.
//
// See memory/project_config_file.md for the spec.
export const applyUserConfig = (cfg: SkrivroConfig) => {
  const root = document.documentElement;

  // Font overrides: prepend the user's font to the existing stack so
  // their choice wins if the font is installed on the system, and the
  // original fallback chain kicks in if not. Without prepending, a
  // user who sets `edit-font = Codelia` on a machine without Codelia
  // installed would get the browser's default monospace (usually ugly)
  // instead of our curated stack. Read the current stack via
  // getComputedStyle — it's defined in styles.css, not as a JS
  // constant, so we can't inline the default here.
  if (cfg.editFont) {
    const current = getComputedStyle(root).getPropertyValue('--font-mono').trim();
    root.style.setProperty('--font-mono', `${cfg.editFont}, ${current}`);
  }
  if (cfg.previewFont) {
    const current = getComputedStyle(root).getPropertyValue('--font-sans').trim();
    root.style.setProperty('--font-sans', `${cfg.previewFont}, ${current}`);
  }

  // Font size overrides: direct CSS variable assignment propagates
  // automatically to the CM6 theme (fontSize: 'var(--edit-font-size)')
  // and the .preview CSS rule (font-size: var(--preview-font-size)).
  if (cfg.editFontSize) {
    root.style.setProperty('--edit-font-size', cfg.editFontSize);
  }
  if (cfg.previewFontSize) {
    root.style.setProperty('--preview-font-size', cfg.previewFontSize);
  }

  // Padding overrides (editor and preview, x and y axes). Four
  // independent variables, one per axis per pane. The editor side
  // consumes --editor-padding-y on .cm-content's padding-block and
  // --editor-padding-x on .cm-line's padding-inline (see the CM6
  // theme above for why the split is load-bearing). The preview
  // side consumes both on the .preview element directly via
  // padding-block and padding-inline (.preview is a single <div>,
  // no DOM split needed, but we keep the two-variable shape for
  // consistency with the editor so the user has one mental model).
  //
  // Each variable's value is the user's raw string — one or two
  // whitespace-separated CSS length tokens. The Rust-side
  // normalize_length helper has already validated token count
  // (max 2) and rejected any bare numbers, so whatever arrives
  // here has unit suffixes and is ready to substitute directly
  // into CSS.
  if (cfg.editorPaddingX) {
    root.style.setProperty('--editor-padding-x', cfg.editorPaddingX);
  }
  if (cfg.editorPaddingY) {
    root.style.setProperty('--editor-padding-y', cfg.editorPaddingY);
  }
  if (cfg.previewPaddingX) {
    root.style.setProperty('--preview-padding-x', cfg.previewPaddingX);
  }
  if (cfg.previewPaddingY) {
    root.style.setProperty('--preview-padding-y', cfg.previewPaddingY);
  }

  // Pane width overrides: affect only the single-pane display modes.
  // In editor-only mode the constraint is applied to `.cm-scroller`
  // (see the long comment in styles.css) rather than `.editor-pane`
  // so that the CM6 vim command panel and search bar escape the
  // reading-column constraint and span the full window — matching
  // Vim's convention for the Ex command line. In preview-only mode
  // the constraint is applied to `.preview` directly since there
  // are no CM6 panels in the preview side. Split mode doesn't read
  // these vars — each pane is 50% of the window via flexbox.
  //
  // Values are required to carry an explicit unit by the Rust-side
  // normalize_length helper (the same helper now used for font
  // sizes and padding), so whatever arrives here is already known
  // to be a valid CSS length string (or at least has a unit suffix
  // we trust CSS to validate).
  if (cfg.editPaneWidth) {
    root.style.setProperty('--edit-pane-width', cfg.editPaneWidth);
  }
  if (cfg.previewPaneWidth) {
    root.style.setProperty('--preview-pane-width', cfg.previewPaneWidth);
  }

  // Status bar mode pill style: canonical (default, bright Catppuccin
  // blue/green/mauve/red/peach from catppuccin/nvim's lualine.lua)
  // vs muted (LazyVim-inspired, normal = surface0 + subtext0, visual
  // = pink + base, other modes stay canonical). Implementation is a
  // body class that CSS conditionally overrides the canonical pill
  // colors when set. Unknown values fall through to canonical with
  // a warning.
  if (cfg.statusbarStyle === 'muted') {
    document.body.classList.add('mode-pill-muted');
  } else if (cfg.statusbarStyle && cfg.statusbarStyle !== 'canonical') {
    console.warn(
      `[skrivro config] statusbar-style '${cfg.statusbarStyle}' not ` +
      `recognized (expected 'canonical' or 'muted'), using canonical`
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
        const kebab = key.replace(/[A-Z]/g, m => '-' + m.toLowerCase());
        root.style.setProperty(`--skr-${kebab}`, value);
      }
    }
  }

  // asciidocSafeMode and cursorPositionFormat are not applied here —
  // they're read directly from userConfig by render() and
  // formatCursorPosition() at the points where they take effect.
};

// ================= Host-level status-bar listeners =================
//
// The CM6 updateListener (editor.js, inside makeExtensions) catches doc
// and selection changes via onSelectionChange, which covers most vim
// mode transitions — most mode changes also tend to change selection
// (v → visual starts a selection, Esc from insert → cursor moves back
// by 1, etc.). But pure-mode transitions like `i` (normal → insert at
// the current position) don't touch doc or selection, so onSelectionChange
// never fires for those. A keyup listener on the editor host catches
// them: every mode transition goes through a keypress, so reading mode
// state on every keyup is sufficient. Cheap because refreshStatus just
// reads a few DOM properties and dispatches no CM state updates.
host.addEventListener('keyup', refreshStatus);

// COMMAND mode detection. The vim command panel is rendered as a
// CM6 panel containing an <input> element; pressing `:` focuses
// the input, and completing or cancelling the command blurs it.
// Tracking focus/blur on the input is the simplest signal — no
// MutationObserver needed. The panel input is the only <input>
// inside the editor host, so a tag-name check is precise enough.
host.addEventListener('focusin', (e) => {
  if (e.target && e.target.tagName === 'INPUT') {
    inCommandMode = true;
    refreshStatus();
  }
});
host.addEventListener('focusout', (e) => {
  if (e.target && e.target.tagName === 'INPUT') {
    inCommandMode = false;
    refreshStatus();
  }
});
