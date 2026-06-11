// ================= Prefs =================
// Per-user preferences persisted to localStorage. Mutable object
// exported as a live binding; other modules read and write properties
// directly (e.g., prefs.vimMode = true), then call savePrefs() to
// persist the change to localStorage. The inline pre-paint script in
// index.html's <head> also reads from PREFS_KEY to apply body classes
// for titlebar/gutter/displayMode/statusBar state on the very first
// frame — FOUC prevention for the UI chrome.

const PREFS_KEY = 'adoc-editor-prefs-v1';

const defaultPrefs = {
  titlebarHidden: false,
  vimMode: false,
  displayMode: 'split',
  gutterHidden: true,
  statusBarHidden: false,
  syntaxHighlighting: true,
  // Runtime spellcheck on/off. Default true so that, when the user has
  // enabled spellcheck in skrivro.conf (spellcheck-language != off),
  // the squiggles show on launch; the Ctrl+Alt+K / ⌃⌘K / :spell toggle
  // then silences/restores them, and that choice persists here. Inert
  // when the config has spellcheck off (nothing to show regardless).
  spellcheck: true,
  widthMode: 'medium',
};

const loadPrefs = () => {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) return { ...defaultPrefs, ...JSON.parse(raw) };
  } catch {}
  return { ...defaultPrefs };
};

export const savePrefs = () => {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch {}
};

export const prefs = loadPrefs();
