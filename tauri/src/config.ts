// ================= User config =================
// Holds the parsed skrivro.conf contents loaded from Rust at init.
// Separate from prefs.ts (which holds localStorage-backed UI state):
// prefs = browser-local UI preferences (vim mode, titlebar, display
// mode, etc.); userConfig = external config file (fonts, padding,
// theme, Asciidoctor safe mode, cursor position format, etc.).
//
// Populated by main.ts at init time via setUserConfig, then read by
// ui.ts's applyUserConfig (for DOM-level application) and by specific
// consumer modules at runtime: preview.ts reads asciidocSafeMode in
// render(), ui.ts reads cursorPositionFormat / softColumnLimit in
// formatCursorPosition(), main.ts reads restoreSession for the
// session-restore launch path.
//
// Exported as a live binding — when main.ts reassigns via
// setUserConfig, all importers see the new value on next read.

// ================= Types =================
//
// These interfaces mirror the Rust struct shapes returned by the
// Tauri commands. Field names match the JSON keys that serde emits,
// NOT the Rust field names directly:
//
//   - SkrivroConfig: Rust struct uses `#[serde(rename_all = "camelCase")]`,
//     so field names arrive as camelCase in JS (edit_font → editFont).
//   - ThemeColors: same — `bg_panel` (Rust) → `bgPanel` (JS).
//   - SessionState: same — `last_file_path` (Rust) → `lastFilePath` (JS).
//   - LaunchInfo: NO rename annotation in Rust, so field names stay
//     snake_case (`initial_file`, `cwd`).
//
// Every field is optional on the TS side because Rust's `Option<T>`
// serializes to `T | null`, and we treat undefined / null interchangeably
// at read sites. The `| null` on softColumnLimit is explicit because the
// comparison in ui.ts uses a `typeof === 'number'` guard precisely to
// distinguish null from undefined-or-number.
//
// If the Rust struct grows a new field, adding it here is enough for
// consumers to see it — TS will error at any usage site that doesn't
// know about it, which is a feature.

export interface ThemeColors {
  // 24 semantic color slots. All optional because a theme file may set
  // only a subset, and Rust's Option<String> for each means a missing
  // field arrives as null. Keys match the CSS variable naming after
  // kebab-case conversion: themeColors.bgPanel → --skr-bg-panel.
  bg?: string | null;
  bgPanel?: string | null;
  bgInset?: string | null;
  bgBackdrop?: string | null;
  bgStripe?: string | null;
  bgActiveLine?: string | null;
  shadow?: string | null;
  surface?: string | null;
  surfaceHover?: string | null;
  text?: string | null;
  textMuted?: string | null;
  textDim?: string | null;
  textFaint?: string | null;
  accent?: string | null;
  accentAlt?: string | null;
  accentMinor?: string | null;
  link?: string | null;
  emphasis?: string | null;
  warning?: string | null;
  error?: string | null;
  errorHover?: string | null;
  success?: string | null;
  feedback?: string | null;
  cursor?: string | null;

  // Index signature: allows Object.entries(themeColors) to yield typed
  // `[string, string | null | undefined]` pairs instead of
  // `[string, any]`. Without this, the applyUserConfig iteration in
  // ui.ts would treat values as unknown and fail the setProperty call.
  // The `| undefined` is required because the named fields above are
  // marked optional (the `?` expands to `| undefined`), and TS requires
  // the index signature to be compatible with every declared property.
  [key: string]: string | null | undefined;
}

export interface SkrivroConfig {
  // Fonts (CSS font-family values — the user's input is prepended to
  // the built-in stack in applyUserConfig).
  editFont?: string;
  previewFont?: string;

  // Lengths (explicit CSS unit required by the Rust-side
  // normalize_length helper; bare numbers are rejected before we see
  // them, so what arrives here is always a valid CSS length string).
  editFontSize?: string;
  previewFontSize?: string;
  editorPaddingX?: string;
  editorPaddingY?: string;
  previewPaddingX?: string;
  previewPaddingY?: string;
  editPaneWidth?: string;
  previewPaneWidth?: string;

  // Theme name (informational — the actual colors are pre-resolved by
  // Rust and arrive as themeColors below).
  theme?: string;
  themeColors?: ThemeColors | null;

  // Mode knobs. String types kept broad (not unioned literals) because
  // the Rust-side parser may produce unknown values on typos — consumer
  // code validates and falls through to defaults for unknown strings.
  asciidocSafeMode?: string;
  cursorPositionFormat?: string;
  statusbarStyle?: string;

  // Numeric: Option<u32> in Rust serializes to `null | number`.
  softColumnLimit?: number | null;

  // Boolean: Option<bool> serializes to `null | boolean`.
  restoreSession?: boolean | null;

  // UI language override. Frontend validates and falls through to
  // auto-detect if the value isn't 'en' or 'sv'.
  language?: string;
}

// Rust-side: struct LaunchInfo { initial_file: Option<String>, cwd: String }.
// NO camelCase rename — field names arrive as-is.
export interface LaunchInfo {
  initial_file: string | null;
  cwd: string;
}

// Rust-side: struct SessionState { version: u32, last_file_path:
// Option<String> } with `#[serde(rename_all = "camelCase")]`.
export interface SessionState {
  version: number;
  lastFilePath: string | null;
}

// ================= State =================

export let userConfig: SkrivroConfig = {};

export const setUserConfig = (cfg: SkrivroConfig) => {
  userConfig = cfg;
};
