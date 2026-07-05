// ================= Prefs =================
// Per-user preferences persisted to localStorage. Mutable object
// exported as a live binding, and other modules read and write
// properties directly (e.g., prefs.vimMode = true), then call
// savePrefs() to persist the change to localStorage. The inline
// pre-paint script at the start of index.html's <body> also reads
// from PREFS_KEY to apply body classes for bar/gutter/displayMode
// state on the very first frame, FOUC prevention for the UI chrome.

const PREFS_KEY = "adoc-editor-prefs-v1";

const defaultPrefs = {
  vimMode: false,
  displayMode: "split",
  gutterHidden: true,
  statusBarHidden: false,
  // Where the bar sits: "bottom" (default) or "top". Flipped by
  // Ctrl+Alt+T / ⌃⌘T.
  barPosition: "bottom",
  // The bar's "?" help button, hidden via Ctrl+Alt+X / ⌃⌘X for users
  // who reach help by keyboard and want the chrome minimal.
  helpButtonHidden: false,
  syntaxHighlighting: true,
  // Runtime spellcheck on/off. Default true so that, when spellcheck is
  // active (spellcheck-language is anything but off, and auto is now the
  // default), the squiggles show on launch, and the Ctrl+Alt+K / ⌃⌘K /
  // :spell toggle then silences/restores them, and that choice persists
  // here. Inert when the config has spellcheck off (nothing to show
  // regardless).
  spellcheck: true,
  widthMode: "medium",
  // Directory of the last file opened or saved through a real path.
  // Feeds the file dialogs' starting location in io.ts. Empty string
  // means no history yet, which lets the dialog fall through to the
  // platform default.
  lastFileDir: "",
};

const loadPrefs = () => {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) return { ...defaultPrefs, ...JSON.parse(raw) };
  } catch {}
  return { ...defaultPrefs };
};

export const savePrefs = () => {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {}
};

export const prefs = loadPrefs();
