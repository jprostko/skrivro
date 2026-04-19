// ================= User config =================
// Holds the parsed skrivro.conf contents loaded from Rust at init.
// Separate from prefs.js (which holds localStorage-backed UI state):
// prefs = browser-local UI preferences (vim mode, titlebar, display
// mode, etc.); userConfig = external config file (fonts, padding,
// theme, Asciidoctor safe mode, cursor position format, etc.).
//
// Populated by main.js at init time via setUserConfig, then read by
// ui.js's applyUserConfig (for DOM-level application) and by specific
// consumer modules at runtime: preview.js reads asciidocSafeMode in
// render(), ui.js reads cursorPositionFormat / softColumnLimit in
// formatCursorPosition(), main.js reads restoreSession for the
// session-restore launch path.
//
// Exported as a live binding — when main.js reassigns via
// setUserConfig, all importers see the new value on next read.

export let userConfig = {};

export const setUserConfig = (cfg) => {
  userConfig = cfg;
};
