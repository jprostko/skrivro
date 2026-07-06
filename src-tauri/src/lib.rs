use serde::{Deserialize, Serialize};
use std::env;
use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Serialize, Clone)]
struct LaunchInfo {
    initial_file: Option<String>,
    cwd: String,
}

#[tauri::command]
fn get_launch_info(state: tauri::State<LaunchInfo>) -> LaunchInfo {
    state.inner().clone()
}

// ================= File association opens =================
//
// On macOS, file associations work via AppleEvents, not CLI arguments.
// When a user runs `open -a Skrivro foo.adoc` or double-clicks an
// .adoc file in Finder (with Skrivro set as handler), macOS launches
// Skrivro and sends an AppleEvent, which Tauri surfaces as
// RunEvent::Opened { urls }. The CLI argv is typically empty in this
// scenario, so our existing launchInfo.initial_file mechanism doesn't
// see the file.
//
// Linux and Windows don't need this path: on those platforms, file
// associations are invoked by passing the file as a CLI argument to
// the app, which launchInfo.initial_file already handles.
//
// Two-stage handling for the macOS AppleEvents case:
//
// 1. Cold-launch (Skrivro not running): Mac launches the app. Tauri
//    fires RunEvent::Opened possibly before the frontend has
//    registered its event listener. To avoid dropping the event, the
//    RunEvent handler pushes the paths into PendingOpens. The
//    frontend, during init, calls take_pending_opens() to drain any
//    cold-launch paths and opens the first one.
//
// 2. Already-running (Skrivro is open, user triggers another file):
//    Mac activates the running app and sends the event. Tauri fires
//    RunEvent::Opened again, and the handler both pushes to
//    PendingOpens (in case something's still initializing) AND emits a
//    Tauri event that the frontend's live listener catches to open the
//    file in the existing instance.
//
// Both paths converge on frontend's loadFileFromPath, wrapped in
// confirmDiscard so a dropped-in-during-unsaved-work file gets the
// same discard prompt as Ctrl+O / Cmd+O would.

#[derive(Default)]
struct PendingOpens(Mutex<Vec<String>>);

#[tauri::command]
fn take_pending_opens(state: tauri::State<PendingOpens>) -> Vec<String> {
    let mut list = state.0.lock().unwrap();
    std::mem::take(&mut *list)
}

// ================= User config file =================
//
// Skrivro reads a user-editable flat `key = value` config file at startup
// for font / size / padding / mode-style overrides. Not required: missing
// file means "use compiled-in defaults."
//
// File location (resolved via Tauri's app_config_dir, which joins the
// platform's config root with the identifier from tauri.conf.json):
//   Linux:   $XDG_CONFIG_HOME/com.skrivro.editor/skrivro.conf
//            (or $HOME/.config/com.skrivro.editor/skrivro.conf if unset)
//   macOS:   ~/Library/Application Support/com.skrivro.editor/skrivro.conf
//   Windows: %APPDATA%\com.skrivro.editor\skrivro.conf
//
// Format example:
//
//   # Fonts
//   editor-font = JetBrains Mono
//   preview-font = Charter
//
//   # All length-typed values (font sizes, padding) require an
//   # explicit CSS unit. Bare numbers are rejected, and the rule is
//   # uniform across every length-typed key. Valid units: pt, px,
//   # rem, em, %, vw, vh, ch, ex, etc. (we don't maintain an
//   # allowlist, the webview's CSS engine is the ultimate validator).
//   editor-font-size = 14pt
//   preview-font-size = 15pt
//
//   # Padding (editor and preview, x / y axes). Each key accepts one or
//   # two values. One value: applied uniformly to both ends of the axis.
//   # Two values are in reading order: for x `left right`, for y
//   # `top bottom`. Three or more values are rejected. Every token
//   # needs a unit.
//   editor-padding-x = 2.5rem
//   editor-padding-y = 2rem
//   preview-padding-x = 2.5rem
//   preview-padding-y = 2rem
//
//   # Asciidoctor safe mode (set-and-forget, not exposed in UI)
//   asciidoc-safe-mode = unsafe
//
//   # Status bar cursor position format: verbose / compact / ruler
//   cursor-position-format = verbose
//
//   # Status bar mode pill style: canonical / muted
//   statusbar-style = canonical
//
//   # Soft column limit: positive integer, character count, no default.
//   # When set, the Col indicator in the status bar turns peach once the
//   # cursor's column count on the current line exceeds this value,
//   # useful for prose workflows with hard column-width conventions
//   # (80- or 100-char line limits, commit messages, etc.). Tracks the
//   # document column, not the visual wrap column, so soft-wrapped text
//   # that exceeds the limit still triggers the indicator.
//   soft-column-limit = 100
//
// Naming convention across three layers:
//   - Config file:  kebab-case ("editor-font"), the user-facing spec
//   - Rust struct:  snake_case (`editor_font`), Rust convention
//   - JSON output:  camelCase  ("editorFont"), via serde rename_all,
//                                                 for idiomatic JS
//                                                 dot-access on the
//                                                 frontend side.
//
// The parser's match arm handles kebab→snake mapping by hand, and the
// serde rename attribute handles snake→camel for the JSON boundary. JS
// code then uses `cfg.editorFont`, `cfg.asciidocSafeMode`, etc.,
// without any bracket-notation gymnastics.

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct SkrivroConfig {
    editor_font: Option<String>,
    preview_font: Option<String>,
    editor_font_size: Option<String>,
    preview_font_size: Option<String>,
    editor_padding_x: Option<String>,
    editor_padding_y: Option<String>,
    preview_padding_x: Option<String>,
    preview_padding_y: Option<String>,
    theme: Option<String>,
    asciidoc_safe_mode: Option<String>,
    cursor_position_format: Option<String>,
    statusbar_style: Option<String>,
    // Format assigned to an untitled buffer (one with no file on
    // disk). Accepted values: asciidoc, markdown, text. When set,
    // a fresh launch with no CLI argument and no session-restore
    // file (i.e., a brand-new blank buffer) starts in this
    // format rather than the compiled-in 'asciidoc' default.
    // File-extension detection always wins: opening foo.md is
    // always markdown regardless of this setting. Unknown values
    // are rejected with a debug warning and the field stays None.
    default_format: Option<String>,
    // First numeric-typed config key. Previously every field was
    // `Option<String>` for uniformity, but for a strict positive-
    // integer value there's no reason to store a string we'd have
    // to parse on the JS side anyway. Serde serializes Option<u32>
    // as `null | number`, so the frontend reads userConfig.softColumnLimit
    // as `undefined | number` directly, no parseInt, no validation.
    // Rejection logic (non-integer, zero, negative) lives in the
    // parser's match arm, and invalid values leave the field None and
    // the frontend falls through to "no limit, no over-limit coloring."
    soft_column_limit: Option<u32>,
    // Launch restores the last-opened file's path from session state
    // at $APP_LOCAL_DATA/state.json. The frontend defaults this ON
    // when the key is unset (None): a normal launch reopens the most
    // recently touched file. Set restore-session = false to start
    // blank instead. Crash recovery via the autosave draft is
    // independent of this setting and takes priority over it, and
    // session-restore only fires when no draft is present. See the
    // Session state section below for the state file format and the
    // get_session_state / set_session_state commands.
    restore_session: Option<bool>,
    // The preview pane loads images from external HTTPS URLs
    // (e.g., GitHub-hosted README images). The frontend defaults this
    // ON when the key is unset (None). Set allow-external-images =
    // false to block them: external image src attributes are then
    // rewritten to inline placeholders by the frontend's render-time
    // post-processing before any fetch can happen. The CSP relaxation
    // in tauri.conf.json (img-src includes `https:`) is what makes
    // external loading possible WHEN the gate allows. The gate is
    // the actual security boundary, not the CSP.
    //
    // HTTPS-only by deliberate policy: even when this flag is
    // true, `http:` image sources are placeholdered. Setting this
    // requires app restart to take effect, for the same reason every
    // key does: the config file is read once at launch, there is no
    // runtime reload. (The CSP itself is static: img-src allows
    // `https:` unconditionally, and the gate alone decides.)
    allow_external_images: Option<bool>,
    // UI language: "auto" (default if unset, detect from browser
    // locale), "en" (force English), or "sv" (force Swedish). When
    // the config specifies "en" or "sv" explicitly, that overrides
    // the auto-detect and gets passed to the frontend via the
    // initialization_script. When unset or "auto", the frontend
    // picks the language from navigator.language at startup.
    //
    // Unknown languages fall back to English (no-op translation).
    // Swedish is currently the only non-English locale with a
    // translation table.
    language: Option<String>,
    // Offline spellcheck language: "auto" (default), "off", "en" (US
    // English), "sv" (Swedish), or "both" (en + sv). "auto" detects the
    // dictionary from the system locale on the frontend (Swedish locale
    // → Swedish, else English) and is stored here as None, the same as the
    // `language` key's auto, so an unset key, "auto", and an
    // unrecognized value all arrive as None and the frontend treats them
    // as auto. "off" is the one disabling value and a HARD off: no
    // dictionary loads and the runtime Ctrl+Alt+K / ⌃⌘K / :spell toggle
    // is inert. When a language is active the frontend loads the matching
    // Hunspell dictionary into nspell (bundled US English, or user-supplied
    // files from <app_config_dir>/dictionaries/, see the User-supplied
    // dictionaries section below) and underlines misspellings as
    // CodeMirror decorations. Only US English ships in the binary. Other
    // English variants and Swedish are user-supplied.
    spellcheck_language: Option<String>,
    // Theme colors resolved by load_theme() in get_config(). When the
    // user's `theme` key is set, the Rust side resolves the name
    // (user file first, then bundled data) and attaches the resolved
    // colors here. The frontend's applyUserConfig() iterates these
    // and writes each as an inline :root style, overriding the
    // CSS-default Catppuccin Mocha values. When the key is unset, or
    // names catppuccin-mocha without a user override file, this
    // field is None and the CSS defaults show through untouched.
    theme_colors: Option<ThemeColors>,
}

/// 24 semantic theme color slots. Each field maps to a `--skr-*` CSS
/// custom property. Theme files provide values for these slots in flat
/// `key = value` format (same parser as skrivro.conf). The reference
/// template (resources/themes/catppuccin-mocha.theme.default) documents
/// each slot's purpose.
///
/// All fields are `Option<String>` so a theme file that omits a slot
/// falls through to the CSS-default Catppuccin Mocha value for that
/// slot. A well-authored theme provides all 24, but a partial theme
/// (e.g., one that only overrides backgrounds) is valid and won't break.
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct ThemeColors {
    bg: Option<String>,
    bg_panel: Option<String>,
    bg_inset: Option<String>,
    bg_backdrop: Option<String>,
    bg_stripe: Option<String>,
    bg_active_line: Option<String>,
    shadow: Option<String>,
    surface: Option<String>,
    surface_hover: Option<String>,
    text: Option<String>,
    text_muted: Option<String>,
    text_dim: Option<String>,
    text_faint: Option<String>,
    accent: Option<String>,
    accent_alt: Option<String>,
    accent_minor: Option<String>,
    link: Option<String>,
    emphasis: Option<String>,
    warning: Option<String>,
    error: Option<String>,
    error_hover: Option<String>,
    success: Option<String>,
    feedback: Option<String>,
    cursor: Option<String>,
}

/// Parse a theme file's text into a `ThemeColors`. Same flat key=value
/// format as skrivro.conf: one pair per line, # comments, blank lines
/// ignored, unknown keys warned and skipped.
#[cfg_attr(not(debug_assertions), allow(unused_variables))]
fn parse_theme_file(text: &str) -> ThemeColors {
    let mut t = ThemeColors::default();
    for (idx, raw) in text.lines().enumerate() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some(eq) = line.find('=') else {
            #[cfg(debug_assertions)]
            eprintln!("[skrivro theme] line {}: no '=' found, skipping: {}", idx + 1, line);
            continue;
        };
        let key = line[..eq].trim();
        let val = line[eq + 1..].trim();
        if val.is_empty() {
            continue;
        }
        let val = val.to_string();
        match key {
            "bg"              => t.bg = Some(val),
            "bg-panel"        => t.bg_panel = Some(val),
            "bg-inset"        => t.bg_inset = Some(val),
            "bg-backdrop"     => t.bg_backdrop = Some(val),
            "bg-stripe"       => t.bg_stripe = Some(val),
            "bg-active-line"  => t.bg_active_line = Some(val),
            "shadow"          => t.shadow = Some(val),
            "surface"         => t.surface = Some(val),
            "surface-hover"   => t.surface_hover = Some(val),
            "text"            => t.text = Some(val),
            "text-muted"      => t.text_muted = Some(val),
            "text-dim"        => t.text_dim = Some(val),
            "text-faint"      => t.text_faint = Some(val),
            "accent"          => t.accent = Some(val),
            "accent-alt"      => t.accent_alt = Some(val),
            "accent-minor"    => t.accent_minor = Some(val),
            "link"            => t.link = Some(val),
            "emphasis"        => t.emphasis = Some(val),
            "warning"         => t.warning = Some(val),
            "error"           => t.error = Some(val),
            "error-hover"     => t.error_hover = Some(val),
            "success"         => t.success = Some(val),
            "feedback"        => t.feedback = Some(val),
            "cursor"          => t.cursor = Some(val),
            _ => {
                #[cfg(debug_assertions)]
                eprintln!("[skrivro theme] line {}: unknown key '{}', skipping", idx + 1, key);
            }
        }
    }
    t
}

/// Resolve the user-supplied themes directory. Uses Tauri's app_config_dir,
/// which resolves to:
///   Linux:   $XDG_CONFIG_HOME/com.skrivro.editor/themes/
///            (or $HOME/.config/com.skrivro.editor/themes/ if unset)
///   macOS:   ~/Library/Application Support/com.skrivro.editor/themes/
///   Windows: %APPDATA%\com.skrivro.editor\themes\
///
/// The "com.skrivro.editor" component comes from the identifier field in
/// tauri.conf.json, so renaming the app there propagates to all path
/// resolution automatically. Returns `None` only if Tauri can't locate
/// the user's config directory (broken environment).
fn skrivro_themes_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    app.path().app_config_dir().ok().map(|d| d.join("themes"))
}

/// Load a theme by name. Resolution order:
/// 1. User-supplied file at <app_config_dir>/themes/<name>.theme
/// 2. Bundled theme data embedded at compile time via include_str!()
/// 3. None: caller falls through to CSS defaults (catppuccin-mocha)
///
/// User theme files use the `.theme` extension (matching the bundled
/// templates' `.theme.default` minus the .default suffix that signals
/// "reference template"). The relationship between the two is meant
/// to be visually obvious: copy `<name>.theme.default` from the
/// source tree to `<app_config_dir>/themes/<name>.theme` and edit.
#[cfg_attr(not(debug_assertions), allow(unused_variables))]
fn load_theme(name: &str, app: &tauri::AppHandle) -> Option<ThemeColors> {
    // Check for user-supplied theme file first
    if let Some(dir) = skrivro_themes_dir(app) {
        let path = dir.join(format!("{}.theme", name));
        if let Ok(text) = std::fs::read_to_string(&path) {
            return Some(parse_theme_file(&text));
        }
    }
    // Fall back to bundled themes
    match name {
        // The default theme's values are the compiled-in CSS :root
        // defaults, so it has no bundled data. Reaching this match
        // means no user override file was found, and None lets the
        // defaults show through (and skips the not-found diagnostic
        // below, which would be misleading for the built-in default).
        "catppuccin-mocha" => None,
        "dracula" => Some(parse_theme_file(include_str!("../../resources/themes/dracula.theme.default"))),
        "tokyo-night-moon" => Some(parse_theme_file(include_str!("../../resources/themes/tokyo-night-moon.theme.default"))),
        "nord" => Some(parse_theme_file(include_str!("../../resources/themes/nord.theme.default"))),
        "gruvbox-dark" => Some(parse_theme_file(include_str!("../../resources/themes/gruvbox-dark.theme.default"))),
        "catppuccin-latte" => Some(parse_theme_file(include_str!("../../resources/themes/catppuccin-latte.theme.default"))),
        "tokyo-night-day" => Some(parse_theme_file(include_str!("../../resources/themes/tokyo-night-day.theme.default"))),
        _ => {
            #[cfg(debug_assertions)]
            eprintln!("[skrivro config] theme '{}' not found (no user file, no bundled data)", name);
            None
        }
    }
}

/// Resolve the config file path using Tauri's app_config_dir, which gives
/// the platform-appropriate directory joined with our app identifier:
///
///   Linux:   $XDG_CONFIG_HOME/com.skrivro.editor/skrivro.conf
///            (or $HOME/.config/com.skrivro.editor/skrivro.conf if unset)
///   macOS:   ~/Library/Application Support/com.skrivro.editor/skrivro.conf
///   Windows: %APPDATA%\com.skrivro.editor\skrivro.conf
///
/// Previously this function used hardcoded env::var("XDG_CONFIG_HOME") +
/// $HOME fallback, which worked on Linux but was non-idiomatic on macOS
/// and effectively broken on Windows (where neither env var is typically
/// set in cmd.exe or PowerShell). Switching to app_config_dir fixes both
/// platforms and uses the identifier from tauri.conf.json as the subdir
/// name, so rename in tauri.conf.json propagates everywhere.
///
/// Returns `None` only in a broken environment where Tauri can't resolve
/// the user's config directory, which we treat as "no config available"
/// and fall through to defaults.
fn skrivro_config_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    app.path().app_config_dir().ok().map(|d| d.join("skrivro.conf"))
}

/// Normalize a length value for every length-typed config key (font
/// sizes, padding). All length values REQUIRE an explicit unit
/// suffix: bare numbers are rejected because no single unit
/// assumption is universally intuitive across the different length
/// categories, and requiring units makes user intent unambiguous
/// without parser heuristics.
///
/// Accepted values are anything with a CSS unit suffix: `14pt`, `2rem`,
/// `900px`, `80%`, `60vw`, `80ch`, `1.1em`, etc. We do not maintain an
/// allowlist of valid CSS units: the webview validates far more
/// thoroughly than we ever could, and an allowlist would be maintenance
/// burden with only downside (false positives when new units are added
/// to CSS).
///
/// Multi-token support: `max_tokens` caps the number of whitespace-
/// separated values the key accepts.
/// - Font-size keys pass `1` (only a single length makes sense).
/// - Padding keys pass `2` (one value for uniform, two for asymmetric
///   start/end in reading order).
///
/// Each token is validated independently: any bare number or leading-
/// minus value causes the whole value to be rejected.
///
/// Rejection cases (all emit a debug warning):
/// - More than `max_tokens` whitespace-separated tokens.
/// - Any token is a bare number (parses as f64 with no trailing unit).
///   Examples that trigger: `14`, `2.5`, `.5`, `1e2`.
/// - Any token starts with `-`. CSS would drop negative lengths
///   silently, so catching at parse time makes the diagnostic visible
///   in dev builds.
///
/// Called from `parse_skrivro_config` for:
/// - Font-size keys (`editor-font-size`, `preview-font-size`,
///   max_tokens=1)
/// - Padding keys (`editor/preview-padding-x/y`, max_tokens=2)
#[cfg_attr(not(debug_assertions), allow(unused_variables))]
fn normalize_length(key: &str, val: &str, line_num: usize, max_tokens: usize) -> Option<String> {
    let tokens: Vec<&str> = val.split_whitespace().collect();
    if tokens.is_empty() {
        // Value was whitespace-only. Caller already filters empty strings,
        // but guard here anyway so the function stays self-consistent.
        return None;
    }
    if tokens.len() > max_tokens {
        #[cfg(debug_assertions)]
        eprintln!(
            "[skrivro config] line {}: {} value '{}' has {} tokens, max is {}, skipping",
            line_num,
            key,
            val,
            tokens.len(),
            max_tokens
        );
        return None;
    }
    for token in &tokens {
        // Reject bare numbers (no unit suffix). f64::parse accepts integer,
        // decimal, and scientific forms (14, 14.5, .5, 1e5), and any of
        // those without a trailing unit triggers rejection.
        if token.parse::<f64>().is_ok() {
            #[cfg(debug_assertions)]
            eprintln!(
                "[skrivro config] line {}: {} token '{}' requires an explicit unit (pt, px, rem, em, %, vw, ch, ...). Examples: 14pt, 2.5rem, 80ch, 900px",
                line_num, key, token
            );
            return None;
        }
        // Reject negative values like `-2rem` or `-100px`. CSS would drop
        // these silently, so catching at parse time surfaces the
        // diagnostic.
        if token.starts_with('-') {
            #[cfg(debug_assertions)]
            eprintln!(
                "[skrivro config] line {}: {} token '{}' is negative, skipping",
                line_num, key, token
            );
            return None;
        }
    }
    // All tokens passed validation: trust the user's units and let CSS
    // validate at render time if they typed something exotic.
    Some(tokens.join(" "))
}

/// Parse a Skrivro config file's text into a `SkrivroConfig`.
///
/// Parsing rules (per spec):
/// - One `key = value` per line
/// - Whitespace around `=` is tolerated and stripped
/// - Full-line comments only: `#` at the start of a trimmed line
/// - Blank lines ignored
/// - Unknown keys: warn and skip (forward-compat for future config keys
///   so older binaries don't choke on newer configs)
/// - Malformed lines (missing `=`): warn and skip
/// - Empty values treated as "unset": struct field stays `None`, frontend
///   falls through to compiled-in defaults
/// - All length-valued keys (font sizes, padding) go through
///   `normalize_length`, which REJECTS bare numbers (an explicit CSS
///   unit is required) and rejects negative values. The helper takes
///   a `max_tokens` argument: font-size keys pass `1` (single length
///   only), while padding keys pass `2` to accept both `= 2rem`
///   (uniform) and `= 2rem 3rem` (asymmetric start/end) forms. See that
///   function's doc comment for the full rules.
/// - `soft-column-limit` is parsed inline as a strict positive
///   integer (not a CSS length) and stored in `Option<u32>`, the
///   only numeric-typed field in `SkrivroConfig`. Non-integer, zero,
///   or negative values are warned and skipped.
/// - One bad line does NOT abort loading the rest of the file
///
/// All warning `eprintln!`s are wrapped in `#[cfg(debug_assertions)]` so
/// they only fire in debug builds (visible during `pnpm tauri dev` from
/// a terminal, and compiled out of release builds entirely: zero runtime
/// cost for end users, and no stderr noise from a launched .desktop
/// entry).
fn parse_skrivro_config(text: &str) -> SkrivroConfig {
    let mut cfg = SkrivroConfig::default();
    // `idx` is only referenced inside #[cfg(debug_assertions)] eprintln!s
    // below, so release builds see it as unused. cfg_attr here suppresses
    // the unused_variables warning ONLY when debug_assertions is off,
    // while debug builds still get normal lint coverage.
    #[cfg_attr(not(debug_assertions), allow(unused_variables))]
    for (idx, raw) in text.lines().enumerate() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some(eq) = line.find('=') else {
            #[cfg(debug_assertions)]
            eprintln!(
                "[skrivro config] line {}: no '=' found, skipping: {}",
                idx + 1,
                line
            );
            continue;
        };
        let key = line[..eq].trim();
        let val = line[eq + 1..].trim();
        if val.is_empty() {
            // Empty value = explicit "unset" → leave the struct field None
            // and let the frontend fall through to compiled-in defaults.
            continue;
        }
        match key {
            "editor-font" => cfg.editor_font = Some(val.to_string()),
            "preview-font" => cfg.preview_font = Some(val.to_string()),
            "editor-font-size" => cfg.editor_font_size = normalize_length(key, val, idx + 1, 1),
            "preview-font-size" => cfg.preview_font_size = normalize_length(key, val, idx + 1, 1),
            "editor-padding-x" => cfg.editor_padding_x = normalize_length(key, val, idx + 1, 2),
            "editor-padding-y" => cfg.editor_padding_y = normalize_length(key, val, idx + 1, 2),
            "preview-padding-x" => cfg.preview_padding_x = normalize_length(key, val, idx + 1, 2),
            "preview-padding-y" => cfg.preview_padding_y = normalize_length(key, val, idx + 1, 2),
            "theme" => cfg.theme = Some(val.to_string()),
            "asciidoc-safe-mode" => cfg.asciidoc_safe_mode = Some(val.to_string()),
            "cursor-position-format" => cfg.cursor_position_format = Some(val.to_string()),
            "statusbar-style" => cfg.statusbar_style = Some(val.to_string()),
            "default-format" => {
                // Accepted: asciidoc, markdown, text. Unknown values
                // are rejected with a debug warning rather than silently
                // treated as a fallback, since a typo should surface
                // rather than be swallowed. Field stays None on
                // rejection and the frontend falls through to the
                // compiled-in default.
                match val.to_lowercase().as_str() {
                    "asciidoc" | "markdown" | "text" => {
                        cfg.default_format = Some(val.to_lowercase())
                    }
                    _ => {
                        #[cfg(debug_assertions)]
                        eprintln!(
                            "[skrivro config] line {}: default-format value '{}' not recognized — accepted: asciidoc, markdown, text. Skipping.",
                            idx + 1,
                            val
                        );
                    }
                }
            }
            "spellcheck-language" => {
                // Accepted: auto (default), off, en, sv, both. "auto" maps
                // to None: the frontend detects the dictionary from the
                // system locale, the same representation the `language`
                // key's auto uses. "off" disables the feature entirely (no
                // dictionaries load). Unknown values are rejected with a
                // debug warning and stay None, which the frontend treats as
                // the auto default.
                match val.to_lowercase().as_str() {
                    "off" | "en" | "sv" | "both" => {
                        cfg.spellcheck_language = Some(val.to_lowercase())
                    }
                    "auto" => cfg.spellcheck_language = None,
                    _ => {
                        #[cfg(debug_assertions)]
                        eprintln!(
                            "[skrivro config] line {}: spellcheck-language value '{}' not recognized — accepted: auto, off, en, sv, both. Skipping.",
                            idx + 1,
                            val
                        );
                    }
                }
            }
            "soft-column-limit" => {
                // Strict positive integer. Zero or negative is meaningless
                // (every column would be past the limit / no column could
                // ever be past it), so we reject both alongside non-numeric
                // garbage. No-unit parse, no pt inference: this is a
                // character count, not a CSS length.
                match val.parse::<u32>() {
                    Ok(n) if n > 0 => cfg.soft_column_limit = Some(n),
                    _ => {
                        #[cfg(debug_assertions)]
                        eprintln!(
                            "[skrivro config] line {}: soft-column-limit value '{}' must be a positive integer, skipping",
                            idx + 1,
                            val
                        );
                    }
                }
            }
            "restore-session" => {
                // Boolean-valued key. Accept common spellings of true/false
                // so users don't have to remember one specific form. The
                // frontend reads cfg.restoreSession as `undefined | true | false`
                // and treats undefined as true (restore on by default).
                match val.to_lowercase().as_str() {
                    "true" | "yes" | "on" | "1" => cfg.restore_session = Some(true),
                    "false" | "no" | "off" | "0" => cfg.restore_session = Some(false),
                    _ => {
                        #[cfg(debug_assertions)]
                        eprintln!(
                            "[skrivro config] line {}: restore-session value '{}' must be true or false, skipping",
                            idx + 1,
                            val
                        );
                    }
                }
            }
            "allow-external-images" => {
                // Boolean-valued. Same accepted spellings as restore-session.
                // Default on (None → allowed). When off, the preview gate
                // blocks HTTPS image src attributes instead of letting them
                // load via the CSP-allowed `https:` source. `http:` is always
                // blocked by the gate regardless of this flag (HTTPS-only
                // policy).
                match val.to_lowercase().as_str() {
                    "true" | "yes" | "on" | "1" => cfg.allow_external_images = Some(true),
                    "false" | "no" | "off" | "0" => cfg.allow_external_images = Some(false),
                    _ => {
                        #[cfg(debug_assertions)]
                        eprintln!(
                            "[skrivro config] line {}: allow-external-images value '{}' must be true or false, skipping",
                            idx + 1,
                            val
                        );
                    }
                }
            }
            "language" => {
                // Accepted: auto (default, detect from browser locale), en,
                // sv. Unknown languages are rejected with a debug warning,
                // rather than silently falling back to English, we'd rather
                // surface the typo so the user knows their intent wasn't
                // honored. `auto` is represented as None in the struct
                // (since it means "no override, let the frontend decide").
                match val.to_lowercase().as_str() {
                    "auto" => cfg.language = None,
                    "en" | "sv" => cfg.language = Some(val.to_lowercase()),
                    _ => {
                        #[cfg(debug_assertions)]
                        eprintln!(
                            "[skrivro config] line {}: language value '{}' not recognized — accepted: auto, en, sv. Skipping.",
                            idx + 1,
                            val
                        );
                    }
                }
            }
            _ => {
                #[cfg(debug_assertions)]
                eprintln!(
                    "[skrivro config] line {}: unknown key '{}', skipping",
                    idx + 1,
                    key
                );
            }
        }
    }
    cfg
}

#[tauri::command]
fn get_config(app: tauri::AppHandle) -> SkrivroConfig {
    let Some(path) = skrivro_config_path(&app) else {
        return SkrivroConfig::default();
    };
    let mut cfg = match std::fs::read_to_string(&path) {
        Ok(text) => parse_skrivro_config(&text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // Expected common case: no config file, use defaults. Silent.
            SkrivroConfig::default()
        }
        Err(e) => {
            // Unexpected read error (permission denied, EIO, etc.). Warn
            // in debug builds and fall through to defaults in either case
            // so the app still launches.
            #[cfg(debug_assertions)]
            eprintln!(
                "[skrivro config] failed to read {}: {}",
                path.display(),
                e
            );
            let _ = e;
            SkrivroConfig::default()
        }
    };

    // Resolve theme colors. An unset `theme` key means no override: the
    // CSS defaults are already Catppuccin Mocha and no theme file is
    // consulted. Any explicit name, catppuccin-mocha included, goes
    // through load_theme so a user-supplied .theme file can override.
    // Explicit catppuccin-mocha without a user file resolves to None
    // and the defaults show through.
    if let Some(ref name) = cfg.theme {
        cfg.theme_colors = load_theme(name, &app);
    }

    cfg
}

// ================= Session state =================
//
// Machine-local state persisted across clean exits. Currently just
// stores the last-opened file path for the restore-session feature:
// unless `restore-session = false` is set in skrivro.conf (it defaults
// on), and no CLI argument is given at launch and no crash-recovery
// draft is present, the frontend loads the file at `lastFilePath` here.
//
// File location uses Tauri's platform-appropriate app-local-data dir
// rather than a hardcoded XDG path. This works correctly on all three
// platforms out of the box:
//
//   Linux:   ~/.local/share/com.skrivro.editor/state.json
//   macOS:   ~/Library/Application Support/com.skrivro.editor/state.json
//   Windows: %LOCALAPPDATA%\com.skrivro.editor\state.json
//
// Both skrivro_config_path and skrivro_themes_dir use the same Tauri
// abstraction (app_config_dir) so config, themes, and state all resolve
// to the correct platform locations without any platform-specific
// env-var lookups in our code.
//
// Format:
//   {
//     "version": 1,
//     "lastFilePath": "/absolute/path/to/file.adoc" | null
//   }
//
// The version field is forward-compat insurance for a future multi-
// document model or added state (cursor position, scroll, window
// geometry). On read, unknown versions fall through to the default
// (no state) so a newer state.json written by a future build doesn't
// crash an older binary reading it.

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct SessionState {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    last_file_path: Option<String>,
}

/// Resolve the state file path under Tauri's platform-appropriate
/// app-local-data directory. Returns `None` if Tauri can't locate
/// the directory (extremely unusual, it would mean a broken
/// install environment). Callers treat `None` as "no state
/// available."
fn session_state_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    app.path().app_local_data_dir().ok().map(|d| d.join("state.json"))
}

#[tauri::command]
fn get_session_state(app: tauri::AppHandle) -> SessionState {
    let Some(path) = session_state_path(&app) else {
        return SessionState::default();
    };
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // Expected common case: no prior session. Silent.
            return SessionState::default();
        }
        Err(e) => {
            #[cfg(debug_assertions)]
            eprintln!(
                "[skrivro session] failed to read {}: {}",
                path.display(),
                e
            );
            let _ = e;
            return SessionState::default();
        }
    };
    let state: SessionState = match serde_json::from_str(&text) {
        Ok(s) => s,
        Err(e) => {
            #[cfg(debug_assertions)]
            eprintln!(
                "[skrivro session] failed to parse {}: {}",
                path.display(),
                e
            );
            let _ = e;
            return SessionState::default();
        }
    };
    // Unknown version → treat as no state, don't crash. Lets a future
    // schema bump coexist safely with older binaries.
    if state.version != 1 {
        #[cfg(debug_assertions)]
        eprintln!(
            "[skrivro session] unknown state version {} in {}, ignoring",
            state.version,
            path.display()
        );
        return SessionState::default();
    }
    state
}

#[tauri::command]
fn set_session_state(
    app: tauri::AppHandle,
    state: SessionState,
) -> Result<(), String> {
    let Some(path) = session_state_path(&app) else {
        return Err("no app-local-data dir available".to_string());
    };
    // Ensure parent dir exists: on a fresh install the directory may
    // not have been created yet. Safe to call repeatedly.
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("mkdir {}: {}", parent.display(), e))?;
    }
    let mut text = serde_json::to_string_pretty(&state).map_err(|e| e.to_string())?;
    // Append a trailing newline for POSIX compliance. serde_json's
    // to_string_pretty doesn't add one, and without it, `cat
    // state.json` leaves the zsh `%` no-newline indicator, git-diff
    // shows "No newline at end of file", and any tool that expects
    // text files to end with \n sees the file as malformed. The body
    // is LF-throughout on all platforms (serde_json doesn't produce
    // CRLF), so appending LF stays consistent.
    text.push('\n');
    // Atomic write: write to a sibling temp file, then rename. If the
    // process dies mid-write, the original state.json is untouched,
    // and the orphan .tmp file will be overwritten next time. Rename
    // is atomic within a directory on POSIX and on Windows (NTFS).
    let mut tmp = path.clone().into_os_string();
    tmp.push(".tmp");
    let tmp_path = PathBuf::from(tmp);
    std::fs::write(&tmp_path, &text)
        .map_err(|e| format!("write {}: {}", tmp_path.display(), e))?;
    std::fs::rename(&tmp_path, &path)
        .map_err(|e| format!("rename {} -> {}: {}", tmp_path.display(), path.display(), e))?;
    Ok(())
}

// ================= Custom words (personal spellcheck dictionary) =================
//
// A user-maintained list of words the spellchecker should never flag:
// names, invented terms, domain jargon. Stored as a plain text file at
// <app_config_dir>/custom-words.txt, alongside skrivro.conf and themes/,
// so the file itself is the management UI (edit it to bulk add/remove).
// The frontend owns the in-memory list and the dedup. These two commands
// just read and rewrite the file (resolving the config dir and creating
// it on first write, exactly like set_session_state).

fn custom_words_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("custom-words.txt"))
}

const CUSTOM_WORDS_HEADER: &str = "\
# Skrivro custom words: your personal spellcheck dictionary
#
# Put one word per line. Blank lines and lines starting with # are
# ignored. Words listed here are never flagged as misspelled, in any
# configured language, matched case-insensitively. Edit this file
# freely, and the app rewrites it when you add or remove a word from
# within the editor.

";

#[tauri::command]
fn read_custom_words(app: tauri::AppHandle) -> Vec<String> {
    let Some(path) = custom_words_path(&app) else {
        return Vec::new();
    };
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        // Expected common case: no custom words yet. Silent.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
        Err(e) => {
            #[cfg(debug_assertions)]
            eprintln!("[skrivro custom-words] read {}: {}", path.display(), e);
            let _ = e;
            return Vec::new();
        }
    };
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(str::to_string)
        .collect()
}

#[tauri::command]
fn write_custom_words(app: tauri::AppHandle, words: Vec<String>) -> Result<(), String> {
    let Some(path) = custom_words_path(&app) else {
        return Err("no app-config dir available".to_string());
    };
    // Ensure the config dir exists: on a fresh install it may not yet.
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("mkdir {}: {}", parent.display(), e))?;
    }
    let mut text = String::from(CUSTOM_WORDS_HEADER);
    for w in &words {
        let t = w.trim();
        if !t.is_empty() {
            text.push_str(t);
            text.push('\n');
        }
    }
    // Atomic write (tmp + rename), same as set_session_state.
    let mut tmp = path.clone().into_os_string();
    tmp.push(".tmp");
    let tmp_path = PathBuf::from(tmp);
    std::fs::write(&tmp_path, &text)
        .map_err(|e| format!("write {}: {}", tmp_path.display(), e))?;
    std::fs::rename(&tmp_path, &path)
        .map_err(|e| format!("rename {} -> {}: {}", tmp_path.display(), path.display(), e))?;
    Ok(())
}

// ================= Factory reset =================
//
// The Rust half of :FACTORYRESET (the webview half clears its own
// localStorage). Blanks custom-words.txt back to its header when the
// file exists, never creating or deleting it (the file node is the
// user's, only its content is the app's), deletes state.json, and
// drops a marker the next launch consumes. The window-state file
// can't be deleted here: tauri-plugin-window-state saves on every
// close, so a deletion now would be rewritten on the way out.
// Consuming the marker at startup, before any window exists to
// restore, wins unconditionally. skrivro.conf and themes/ are never
// touched by design.

const FACTORY_RESET_MARKER: &str = "factory-reset-pending";

#[tauri::command]
fn factory_reset(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    if let Some(path) = custom_words_path(&app) {
        if path.exists() {
            write_custom_words(app.clone(), Vec::new())?;
        }
    }
    if let Some(path) = session_state_path(&app) {
        let _ = std::fs::remove_file(path);
    }
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("no app-local-data dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir {}: {}", dir.display(), e))?;
    std::fs::write(dir.join(FACTORY_RESET_MARKER), "")
        .map_err(|e| format!("write marker: {e}"))
}

// ================= User-supplied dictionaries =================
//
// Skrivro bundles only the English (en-US) Hunspell dictionary. Swedish,
// and any non en-US English variant, are user-supplied: the user drops
// <lang>.aff + <lang>.dic into <app_config_dir>/dictionaries/ and the
// frontend loads them at startup, preferring a user file over the bundled
// English. Swedish is deliberately not bundled (its DSSO dictionary is
// LGPL-3.0, and keeping it out of the binary keeps Skrivro's distribution
// permissive). This command reads one language's pair, and the frontend's
// resolver (resolveSpellcheck) decides which language(s) to ask for.
// Mirrors the themes resolver and read_custom_words: app_config_dir joined
// with a fixed subdir.

#[derive(serde::Serialize)]
struct UserDictionary {
    aff: String,
    dic: String,
}

fn skrivro_dictionaries_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("dictionaries"))
}

/// A Hunspell `.dic` begins with a word-count integer (optionally behind
/// a UTF-8 BOM). A `.aff` never does: it starts with directives or `#`
/// comment lines. So if the file in the `.dic` slot doesn't begin with a
/// count, the pair is swapped or the file isn't a dictionary, and we treat
/// it as absent rather than feed nspell garbage (a swapped pair makes it
/// flag every word). This also rejects the hyph_*.dic hyphenation files
/// (whose first line is the charset, not a count). The leading BOM is
/// stripped only when present, so a BOM-less `.dic` is never truncated.
fn dic_starts_with_count(dic: &str) -> bool {
    dic.strip_prefix('\u{feff}')
        .unwrap_or(dic)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .and_then(|line| line.split_whitespace().next())
        .is_some_and(|token| token.parse::<u64>().is_ok())
}

/// Read the user-supplied Hunspell pair for `lang` from
/// <app_config_dir>/dictionaries/<lang>.{aff,dic}. Returns Some only when
/// BOTH files are present, valid UTF-8, and the `.dic` is shaped like a real
/// dictionary (see dic_starts_with_count). A missing, unreadable, non-UTF-8,
/// or swapped/malformed file yields None, which the frontend surfaces as
/// "dictionary not found". `lang` is whitelisted to the known slots so it can
/// never escape the dictionaries directory.
#[tauri::command]
fn read_user_dictionary(app: tauri::AppHandle, lang: String) -> Option<UserDictionary> {
    if lang != "en" && lang != "sv" {
        return None;
    }
    let dir = skrivro_dictionaries_dir(&app)?;
    let aff = std::fs::read_to_string(dir.join(format!("{lang}.aff"))).ok()?;
    let dic = std::fs::read_to_string(dir.join(format!("{lang}.dic"))).ok()?;
    if !dic_starts_with_count(&dic) {
        #[cfg(debug_assertions)]
        eprintln!(
            "[skrivro dictionaries] {lang}.dic does not start with a word count \
             (swapped with {lang}.aff, or not a Hunspell dictionary?)"
        );
        return None;
    }
    Some(UserDictionary { aff, dic })
}

// ================= Initial theme state (FOUC prevention) =================
//
// The default CSS in index.html uses Catppuccin Mocha values. If the user
// has selected a different theme via skrivro.conf, there's a visible flash
// between the first HTML paint (Mocha defaults) and when the frontend's
// applyUserConfig() finishes the async get_config round-trip and applies
// the selected theme's color overrides.
//
// To eliminate the flash, we do two things at window-creation time:
//   1. Set the native window's background_color to the selected theme's
//      `bg` slot value (so the native frame doesn't briefly show Mocha
//      before the webview paints).
//   2. Inject an initialization_script (runs at document-start, before
//      any HTML parsing) that sets `window.__SKRIVRO_INITIAL_THEME__` to
//      a JSON object with all theme slot values. An inline script in
//      index.html's <body> reads this global and applies the values to
//      :root via document.documentElement.style.setProperty() before the
//      stylesheet is applied and first paint occurs.
//
// Both steps require knowing the user's theme BEFORE the window exists,
// so this runs synchronously during setup() before the WebviewWindowBuilder
// constructs the window.
//
// Fallbacks (all yield Mocha bg + empty init script, matching the
// compiled-in CSS defaults):
//   - No skrivro.conf on disk
//   - Config doesn't specify a `theme` key
//   - Theme is "catppuccin-mocha" with no user override file (the CSS
//     defaults already match, nothing to load)
//   - Theme name isn't resolvable (not bundled, no user file)
//   - JSON serialization of ThemeColors fails (shouldn't happen)

/// Compute the initial app state as (native_bg_hex, init_script_js).
/// The init script combines two FOUC-prevention concerns:
///
///   1. Theme override: sets `window.__SKRIVRO_INITIAL_THEME__` with
///      resolved theme color values so the frontend's inline script
///      can apply CSS variable overrides before first paint. See the
///      module-level comment above for the theme-FOUC rationale.
///
///   2. Language override: sets `window.__SKRIVRO_LANG_OVERRIDE__` to
///      the user's explicit `language` config value, if any. When
///      unset, the frontend auto-detects from `navigator.language` and
///      falls back to English for unsupported locales. Presence of the
///      override wins over auto-detect. See the inline script at the
///      end of index.html's body for the frontend resolution logic.
///
/// Either or both parts may be empty. The combined script string is
/// passed verbatim to `WebviewWindowBuilder::initialization_script`,
/// which runs at document-start before any HTML is parsed, so the
/// globals are available to the inline scripts that consume them.
fn compute_initial_state(app: &tauri::AppHandle) -> (String, String) {
    let mocha_bg = "#1e1e2e".to_string();

    // Read config once, use it to compute both the theme state and the
    // language override. Returns (native_bg_hex, combined_init_script).
    // On any config-read failure, returns Mocha bg + empty script,
    // same fallback semantics as before the language additions.
    let Some(path) = skrivro_config_path(app) else {
        return (mocha_bg, String::new());
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return (mocha_bg, String::new());
    };
    let cfg = parse_skrivro_config(&text);

    // Script parts accumulate into one init script, staying empty
    // when neither theme override nor language override is
    // configured.
    let mut parts: Vec<String> = Vec::new();

    // Theme part: compute bg color and generate theme override script.
    let bg = match cfg.theme.as_deref() {
        None => mocha_bg.clone(),
        Some(theme_name) => match load_theme(theme_name, app) {
            Some(colors) => {
                parts.push(generate_theme_init_script(&colors));
                colors.bg.clone().unwrap_or_else(|| mocha_bg.clone())
            }
            None => mocha_bg.clone(),
        },
    };

    // Language part: emit a global only if config explicitly set it,
    // otherwise the frontend's inline script auto-detects from
    // navigator.language at startup. serde_json handles escaping, so
    // the embedded string is safe regardless of future locale
    // names with special chars.
    if let Some(lang) = cfg.language.as_ref() {
        parts.push(format!(
            "window.__SKRIVRO_LANG_OVERRIDE__ = {};",
            serde_json::to_string(lang).unwrap_or_else(|_| "null".to_string())
        ));
    }

    let init_script = parts.join("\n");
    (bg, init_script)
}

/// Generate a JS snippet that sets `window.__SKRIVRO_INITIAL_THEME__` to
/// a JSON object with the theme's color values. The object keys are
/// camelCase via serde's `rename_all = "camelCase"` attribute on
/// `ThemeColors`, and the inline script in index.html converts them to
/// kebab-case when setting `--skr-*` CSS custom properties.
fn generate_theme_init_script(colors: &ThemeColors) -> String {
    match serde_json::to_string(colors) {
        Ok(json) => format!("window.__SKRIVRO_INITIAL_THEME__ = {};", json),
        Err(_) => String::new(),
    }
}

/// Parse a hex color string like "#1e1e2e" into a Tauri Color (RGBA with
/// alpha=255). Returns `None` for malformed input, so callers should
/// fall back to a sensible default.
fn parse_hex_color(hex: &str) -> Option<tauri::webview::Color> {
    let hex = hex.trim_start_matches('#');
    if hex.len() != 6 {
        return None;
    }
    let r = u8::from_str_radix(&hex[0..2], 16).ok()?;
    let g = u8::from_str_radix(&hex[2..4], 16).ok()?;
    let b = u8::from_str_radix(&hex[4..6], 16).ok()?;
    Some(tauri::webview::Color(r, g, b, 255))
}

// ================= macOS chrome hiding =================
//
// Hides the standard macOS window chrome (title bar text, three traffic
// light buttons) without stripping the underlying NSWindowStyleMask
// bits. This is the Ghostty pattern from HiddenTitlebarTerminalWindow.swift:
// keep .titled / .closable / .miniaturizable / .resizable so AppKit's
// menu integration (predefined Minimize / Maximize / Fullscreen items,
// Big Sur Fn+F shortcut routing) works, but visually present as
// borderless to match the app's keyboard-first aesthetic.
//
// Three Cocoa calls do the work:
//   1. setTitlebarAppearsTransparent: YES, so the title bar background
//      blends with the window content, no visible bar.
//   2. setTitleVisibility: NSWindowTitleHidden, so title text doesn't
//      render. Tauri sets the window title to "Skrivro" via the
//      WebviewWindowBuilder, which would otherwise show in the bar.
//   3. standardWindowButton(.closeButton/.miniaturizeButton/.zoomButton)
//      .setHidden: YES, which hides the three traffic lights individually.
//
// Ghostty additionally walks the view tree to find NSTitlebarContainerView
// and hides it ("nuke from orbit"), to handle a macOS edge case where
// a thin chrome strip can remain after the above calls. We're not
// doing that yet: start with the basic three calls and see whether
// the strip actually appears in our app. If it does, add the subview
// walk in a follow-up.
//
// Re-application on title set or fullscreen exit: also a Ghostty
// belt-and-suspenders step we're skipping initially. We don't change
// the window title at runtime (the document filename lives in our
// app's own titlebar widget, not the native title), and Tauri's
// fullscreen exit path may or may not re-show chrome. Test first, and
// add re-apply hooks only if needed.
#[cfg(target_os = "macos")]
fn hide_macos_chrome(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    use objc2::rc::Retained;
    use objc2_app_kit::{
        NSWindow, NSWindowButton, NSWindowCollectionBehavior, NSWindowTitleVisibility,
    };

    let ns_window_ptr = window.ns_window()?;
    // SAFETY: window.ns_window() returns the raw NSWindow pointer Tauri
    // owns for this WebviewWindow. The NSWindow lives for the duration
    // of the window (well past this setup-time call), so casting to a
    // short-lived &NSWindow reference is safe. We don't retain or
    // outlive the underlying Tauri-owned object.
    let ns_window: &NSWindow = unsafe { &*ns_window_ptr.cast::<NSWindow>() };

    // Wrap with Retained to satisfy objc2's expected receiver type for
    // the methods below. This bumps the retain count for the duration
    // of our calls and releases on drop, no ownership transfer.
    let ns_window: Retained<NSWindow> = unsafe { Retained::retain(ns_window as *const NSWindow as *mut NSWindow) }
        .expect("ns_window pointer is non-null");

    // Method calls on Retained<NSWindow> don't require an unsafe block
    // in objc2, since the wrapper already maintains the invariants.
    // The only unsafe ops in this function are the raw pointer deref
    // and the Retained::retain call above.
    ns_window.setTitlebarAppearsTransparent(true);
    ns_window.setTitleVisibility(NSWindowTitleVisibility::Hidden);
    for kind in [
        NSWindowButton::CloseButton,
        NSWindowButton::MiniaturizeButton,
        NSWindowButton::ZoomButton,
    ] {
        if let Some(button) = ns_window.standardWindowButton(kind) {
            button.setHidden(true);
        }
    }

    // Add collectionBehavior flags AppKit checks before auto-injecting
    // the Window menu's Move & Resize submenu / Full Screen Tile
    // submenu / Bring All to Front / per-window list items. tao creates
    // the window with collectionBehavior=0 (default) on current
    // versions, which empirically makes AppKit skip those auto-inject
    // items on macOS 26.
    //
    //   - FullScreenPrimary: marks this as a primary fullscreen-capable
    //     window. Apple's documented canonical flag for apps that want
    //     native fullscreen integration.
    //   - FullScreenAllowsTiling: opts in to the Sequoia/Tahoe window
    //     tiling features. This is the specific flag AppKit uses to
    //     decide whether to auto-inject the Move & Resize submenu.
    //
    // Apply to ALL windows in the app (not just our main one). The
    // menu-diag dump surfaced a second invisible helper NSWindow that
    // Tauri/wry creates internally, with collectionBehavior=0x0. If
    // AppKit's auto-inject iterates NSApp.windows and bails when any
    // window lacks tiling flags, that invisible helper would suppress
    // auto-inject even after we fix our main window. Setting the flags
    // on every window (real and helper) rules that out.
    //
    // OR'd with current behavior rather than overwriting in case tao
    // sets anything else we'd want to preserve.
    let mtm = objc2::MainThreadMarker::from(&*ns_window);
    let app = objc2_app_kit::NSApplication::sharedApplication(mtm);
    let windows = app.windows();
    for i in 0..windows.count() {
        if let Some(any_window) = windows.objectAtIndex(i).downcast_ref::<NSWindow>() {
            let current = any_window.collectionBehavior();
            any_window.setCollectionBehavior(
                current
                    | NSWindowCollectionBehavior::FullScreenPrimary
                    | NSWindowCollectionBehavior::FullScreenAllowsTiling,
            );
        }
    }

    Ok(())
}

// Re-apply collectionBehavior flags on every NSWindow. Same logic as
// the setup-time pass inside hide_macos_chrome, exposed as a Tauri
// command so JS can call it after the frontend has fully initialized.
// Needed because wry creates an invisible helper NSWindow lazily
// (AFTER hide_macos_chrome runs at setup), and AppKit's Window-menu
// auto-inject machinery iterates NSApp.windows and bails if any
// window lacks the tiling flags. Calling this from JS after
// installMenu() catches the helper once it's been created.
#[tauri::command]
fn apply_collection_behavior() {
    #[cfg(target_os = "macos")]
    {
        use objc2::MainThreadMarker;
        use objc2_app_kit::{NSApplication, NSWindow, NSWindowCollectionBehavior};

        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let app = NSApplication::sharedApplication(mtm);
        let windows = app.windows();
        for i in 0..windows.count() {
            if let Some(any_window) = windows.objectAtIndex(i).downcast_ref::<NSWindow>() {
                let current = any_window.collectionBehavior();
                any_window.setCollectionBehavior(
                    current
                        | NSWindowCollectionBehavior::FullScreenPrimary
                        | NSWindowCollectionBehavior::FullScreenAllowsTiling,
                );
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Wayland app_id workaround: set GLib's program name to the Tauri
    // identifier BEFORE any GTK code runs.
    //
    // Why this exists: on Wayland, the compositor's concept of "window
    // class" comes from xdg_toplevel.app_id. GDK-Wayland populates that
    // field by calling g_get_prgname(), NOT by reading GtkApplication's
    // application_id, even though GTK's own documentation suggests
    // application_id should be the canonical source of identity.
    //
    // tao's Linux event loop (see
    // platform_impl/linux/event_loop.rs::new_gtk) calls gtk::init()
    // before anything has a chance to override the default. gtk::init()
    // locks in `prgname` from argv[0], the executable name "skrivro"
    // (from Cargo's [package] name). Without intervention, Wayland
    // compositors see our window class as "skrivro" instead of
    // "com.skrivro.editor".
    //
    // tauri.conf.json has `enableGTKAppId = true`, which makes Tauri
    // pass our identifier to `GtkApplication::new()` as application_id.
    // That setting is DEFENSIVE, not load-bearing for the Wayland case:
    // it makes the identifier available for GTK consumers that DO
    // read application_id (D-Bus service dispatch, GNOME .desktop
    // matching, various future integrations), but it does NOT fix
    // xdg_toplevel.app_id on its own. tao's source has an acknowledging
    // comment near the gtk::init() call: "This should be done by
    // gtk::Application::new, but does not work properly."
    //
    // The actual fix: set the prgname ourselves, BEFORE calling into
    // Tauri/tao. When tao's gtk::init() runs, it reads our already-set
    // value instead of falling back to argv[0]. When GDK-Wayland then
    // reads prgname for xdg_toplevel.app_id, it gets the right value.
    //
    // So the load-bearing piece for Wayland window class is THIS line
    // (the set_prgname call), not the Tauri config. If this ever gets
    // removed, `hyprctl clients` will report the window class as
    // "skrivro" regardless of what tauri.conf.json says.
    //
    // Must stay in sync with `identifier` in tauri.conf.json. If we
    // ever rename the app again, both need to change, since there's no
    // way to read the Tauri config before calling into Tauri itself,
    // which is exactly what we need to avoid here since Tauri/tao's
    // init is the thing that's locking in the wrong prgname.
    #[cfg(target_os = "linux")]
    glib::set_prgname(Some("com.skrivro.editor"));

    // Capture launch-time info: CLI argument (if any) and current working
    // directory. Resolved once at startup so the frontend has an absolute
    // path regardless of where the binary was launched from.
    let cwd_path = env::current_dir().ok();
    let cwd = cwd_path
        .as_ref()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    let initial_file = env::args().nth(1).map(|arg| {
        let p = PathBuf::from(&arg);
        if p.is_absolute() {
            p.to_string_lossy().to_string()
        } else if let Some(ref base) = cwd_path {
            base.join(&p).to_string_lossy().to_string()
        } else {
            p.to_string_lossy().to_string()
        }
    });

    let launch_info = LaunchInfo { initial_file, cwd };

    tauri::Builder::default()
        .manage(launch_info)
        .manage(PendingOpens::default())
        // Single-instance plugin must be registered FIRST, before any
        // other plugin or state that depends on app identity. When a
        // second `skrivro foo.adoc` is launched while an existing
        // instance is running, the plugin intercepts: second process
        // sends its argv + cwd to the first via IPC and exits, and
        // the callback here fires on the first instance with the
        // second's args. We route the incoming file path through the
        // same PendingOpens + event-emit pipeline used for file
        // associations on macOS. The frontend's live listener
        // (skrivro:open-file) picks it up and opens the file in the
        // existing window, with a dirty-buffer confirmDiscard prompt
        // if needed.
        //
        // On macOS this plugin is largely a no-op: macOS enforces
        // single-instance for .app bundles at the OS level, so a
        // second "process" doesn't actually spawn to forward args.
        // The file-association path for Mac uses RunEvent::Opened
        // (see the .run() callback at the end of this function).
        .plugin(tauri_plugin_single_instance::init(|app_handle, argv, cwd| {
            use tauri::{Emitter, Manager};

            // Bring the existing window to the front so the user sees
            // the action. set_focus behavior on Wayland is subject to
            // compositor focus-stealing-prevention rules. On Hyprland
            // the default setup honors app-initiated focus requests
            // from the same session.
            if let Some(window) = app_handle.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }

            // Resolve the file argument (if any). argv[0] is the
            // executable path, and argv[1] is the first file arg by
            // convention. Relative paths resolve against the SECOND
            // instance's cwd (not the first's), which matches what
            // the user typed from their shell.
            if let Some(arg) = argv.get(1) {
                let p = std::path::PathBuf::from(arg);
                let resolved = if p.is_absolute() {
                    p.to_string_lossy().to_string()
                } else {
                    std::path::PathBuf::from(&cwd)
                        .join(&p)
                        .to_string_lossy()
                        .to_string()
                };

                let pending = app_handle.state::<PendingOpens>();
                let mut list = pending.0.lock().unwrap();
                list.push(resolved.clone());
                let _ = app_handle.emit("skrivro:open-file", resolved);
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin({
            // Configure the plugin to exclude DECORATIONS from the
            // state it saves and restores. The plugin's on_window_ready
            // hook automatically calls restore_state(state_flags) for
            // every window using these flags.
            //
            // Decorations is a build-time platform decision in our app
            // (false on Linux/Windows, true on macOS, see the
            // WebviewWindowBuilder below), not a user-toggleable
            // runtime preference. Letting the plugin restore a stale
            // saved value on top of our build-time setting on macOS
            // would strip the .titled / .closable bits AppKit needs
            // for predefined menu items and Big Sur Fn+F routing.
            //
            // The plugin's grab-bag default of saving everything is a
            // footgun for apps that don't expose the corresponding
            // runtime toggles.
            use tauri_plugin_window_state::{Builder, StateFlags};
            Builder::default()
                .with_state_flags(StateFlags::all() & !StateFlags::DECORATIONS)
                .build()
        })
        .invoke_handler(tauri::generate_handler![
            get_launch_info,
            get_config,
            get_session_state,
            set_session_state,
            read_custom_words,
            write_custom_words,
            factory_reset,
            read_user_dictionary,
            take_pending_opens,
            apply_collection_behavior
        ])
        .setup(|app| {
            // Factory-reset marker (see factory_reset): consumed here,
            // before the window exists, so deleting the window-state
            // file can't be undone by the plugin's save-on-close. The
            // filename matches tauri-plugin-window-state's
            // DEFAULT_FILENAME, which we don't customize.
            {
                use tauri::Manager;
                if let Ok(dir) = app.path().app_local_data_dir() {
                    let marker = dir.join(FACTORY_RESET_MARKER);
                    if marker.exists() {
                        let _ = std::fs::remove_file(dir.join(".window-state.json"));
                        let _ = std::fs::remove_file(dir.join("state.json"));
                        let _ = std::fs::remove_file(marker);
                    }
                }
            }

            // Create the main window programmatically (rather than via
            // tauri.conf.json's app.windows array) so we can compute the
            // background_color and initialization_script dynamically from
            // the user's selected theme. This eliminates the FOUC flash
            // that would otherwise occur between the Catppuccin Mocha
            // compiled-in CSS defaults and the user's applied theme
            // overrides. See compute_initial_state above for the full
            // rationale. The init script also carries the language
            // override (if any) for localization FOUC prevention.
            let (bg_hex, init_script) = compute_initial_state(&app.handle());
            let bg_color = parse_hex_color(&bg_hex)
                .unwrap_or(tauri::webview::Color(30, 30, 46, 255)); // #1e1e2e fallback

            let mut builder = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("Skrivro")
            .inner_size(1280.0, 720.0)
            .background_color(bg_color);

            // Mac gets decorations(true) to land the full style mask
            // (.titled / .closable / .miniaturizable / .resizable) that
            // AppKit's predefined menu items need. Linux / Windows stay
            // decorations(false) (tiling WMs / consistency).
            #[cfg(target_os = "macos")]
            {
                builder = builder.decorations(true);
            }
            #[cfg(not(target_os = "macos"))]
            {
                builder = builder.decorations(false);
            }

            if !init_script.is_empty() {
                builder = builder.initialization_script(&init_script);
            }

            let window = builder.build()?;

            // Window state restore (size, position, maximized, fullscreen,
            // visible) happens automatically via the tauri-plugin-window-state
            // plugin's on_window_ready hook, using the StateFlags configured
            // at plugin registration above (excludes DECORATIONS, see the
            // plugin block for why). On first launch or after `rm`ing the
            // plugin's state file, the restore is a no-op and the window
            // keeps the inner_size(1280, 720) default from the builder.
            // On subsequent launches, the window is reshaped/moved to
            // match wherever the user had it when they last closed Skrivro.
            //
            // There is a brief reshape visible at launch as the default
            // size/position snaps to the restored values, accepted as a
            // minor cosmetic cost for the persistence win. If this becomes
            // annoying, the fix is to read the plugin's saved state
            // manually before building the window and pass the restored
            // values into .inner_size() / .position(), rather than
            // letting the plugin restore after build.

            // Hide the visible Mac chrome (title bar + traffic lights).
            // We keep the .titled / .closable / .miniaturizable bits in
            // the style mask (set via decorations(true) above) so AppKit's
            // predefined menu items work, but visually present as
            // borderless. See hide_macos_chrome above for the full
            // rationale and the three Cocoa calls it makes.
            #[cfg(target_os = "macos")]
            {
                if let Err(e) = hide_macos_chrome(&window) {
                    #[cfg(debug_assertions)]
                    eprintln!("[skrivro chrome] failed to hide macOS chrome: {}", e);
                    let _ = e;
                }
            }

            // On Linux, webkit2gtk inherits GTK's text-widget context menu,
            // which includes an "Insert Unicode Control Character" submenu
            // full of BiDi marks (LRM/RLM/LRE/etc.) and zero-width characters
            // (ZWS/ZWJ/ZWNJ). These serve no purpose for AsciiDoc writers in
            // LTR scripts: the AsciiDoc language has no syntax that uses
            // them, Asciidoctor has no built-in RTL/BiDi handling (Asciidoctor
            // issue #1601 has been open since 2015), and the submenu is noise
            // in a right-click menu that should focus on basic edit ops.
            //
            // Strip the Unicode submenu via webkit's context-menu signal.
            // Cut/Copy/Paste/Delete/Select All and the emoji picker stay
            // (they have legitimate use). The Input Methods submenu, only
            // present when a GTK input method daemon like fcitx5 or ibus is
            // active, also stays, since IME users genuinely need it.
            #[cfg(target_os = "linux")]
            {
                window.with_webview(|webview| {
                    use webkit2gtk::{
                        ContextMenuAction, ContextMenuExt, ContextMenuItemExt, WebViewExt,
                    };
                    let wv = webview.inner();
                    wv.connect_context_menu(|_wv, menu, _event, _hit| {
                        for item in menu.items() {
                            // The Unicode submenu (rationale above) and
                            // webkit's page-navigation items, which do
                            // nothing in a single-window app.
                            if matches!(
                                item.stock_action(),
                                ContextMenuAction::Unicode
                                    | ContextMenuAction::Reload
                                    | ContextMenuAction::Stop
                                    | ContextMenuAction::GoBack
                                    | ContextMenuAction::GoForward
                            ) {
                                menu.remove(&item);
                            }
                        }
                        // If the removals emptied the menu, suppress it rather
                        // than show an empty popup. A menu that still has items
                        // (Cut/Copy/Paste in a field, Inspect in a dev build)
                        // shows as normal.
                        menu.items().is_empty()
                    });
                })?;
            }

            // Suppress unused-variable warning on non-Linux platforms where
            // the cfg-gated block above does not compile.
            #[cfg(not(target_os = "linux"))]
            let _ = window;

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Handle RunEvent::Opened for macOS AppleEvents file opens
            // (see the PendingOpens section near the top of this file
            // for the full design rationale). RunEvent::Opened is
            // gated to macOS, iOS, and Android in Tauri's source: it
            // does not exist as a variant on Linux or Windows. On
            // those platforms file associations pass the file as a
            // CLI argument handled by launch_info.
            //
            // The cfg gate here mirrors the gate on the variant
            // definition in tauri's src/app.rs (ours omits android
            // since we don't build for it). Without the gate, this
            // code fails to compile on Linux/Windows with "variant
            // not found in RunEvent".
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            if let tauri::RunEvent::Opened { urls } = &event {
                use tauri::{Emitter, Manager};
                let pending = app_handle.state::<PendingOpens>();
                let mut list = pending.0.lock().unwrap();
                for url in urls {
                    // url.to_file_path() succeeds for file:// URLs,
                    // fails for other schemes (http://, custom://, etc.).
                    // We only care about local files.
                    if let Ok(path) = url.to_file_path() {
                        let path_str = path.to_string_lossy().to_string();
                        list.push(path_str.clone());
                        // Emit for any frontend listener (already-running
                        // case). If the frontend isn't listening yet
                        // (cold-launch), the event is a no-op and the
                        // path sits in PendingOpens for the frontend to
                        // drain during init.
                        let _ = app_handle.emit("skrivro:open-file", path_str);
                    }
                }
            }
            // Suppress unused warnings on platforms where the above
            // cfg-gated block doesn't compile.
            let _ = (app_handle, event);
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    // ----- normalize_length ------------------------------------------

    #[test]
    fn length_accepts_single_value_with_unit() {
        assert_eq!(
            normalize_length("editor-font-size", "1.2rem", 1, 1),
            Some("1.2rem".to_string())
        );
    }

    #[test]
    fn length_rejects_bare_numbers() {
        // A unitless value is ambiguous (px? rem? pt?), so the parser
        // refuses to guess. Anything f64 can parse counts as bare:
        // integers, decimals, leading-dot fractions, and scientific
        // notation.
        for bare in ["14", "2.5", ".5", "1e2"] {
            assert_eq!(normalize_length("editor-font-size", bare, 1, 1), None);
        }
    }

    #[test]
    fn length_rejects_negative_values() {
        // "-1rem" survives the bare-number check (the unit suffix makes
        // the f64 parse fail), so the explicit sign check has to catch
        // it. Negative paddings and font sizes are never meaningful.
        assert_eq!(normalize_length("editor-padding-x", "-1rem", 1, 2), None);
        assert_eq!(
            normalize_length("editor-padding-x", "1rem -2rem", 1, 2),
            None
        );
    }

    #[test]
    fn length_normalizes_whitespace_between_tokens() {
        // The accepted value is re-joined with single spaces so the
        // frontend can drop it straight into a CSS custom property.
        assert_eq!(
            normalize_length("editor-padding-y", "  1rem \t  2rem  ", 1, 2),
            Some("1rem 2rem".to_string())
        );
    }

    #[test]
    fn length_enforces_the_token_cap() {
        // Font sizes take exactly one value, while padding takes one
        // or two (CSS shorthand). Anything past the cap is dropped
        // whole.
        assert_eq!(normalize_length("editor-font-size", "1rem 2rem", 1, 1), None);
        assert_eq!(
            normalize_length("editor-padding-x", "1rem 2rem 3rem", 1, 2),
            None
        );
    }

    #[test]
    fn length_rejects_whitespace_only_values() {
        assert_eq!(normalize_length("editor-font-size", "   ", 1, 1), None);
    }

    #[test]
    fn length_drops_the_whole_pair_when_either_token_is_bad() {
        // One valid token doesn't excuse the other. The whole value is
        // rejected so the frontend falls back to its default instead of
        // applying half a padding declaration.
        assert_eq!(normalize_length("editor-padding-x", "1rem 2", 1, 2), None);
        assert_eq!(normalize_length("editor-padding-x", "2 1rem", 1, 2), None);
    }

    // ----- parse_skrivro_config --------------------------------------

    #[test]
    fn config_defaults_to_all_unset() {
        let cfg = parse_skrivro_config("");
        assert_eq!(cfg.editor_font, None);
        assert_eq!(cfg.theme, None);
        assert_eq!(cfg.default_format, None);
        assert_eq!(cfg.soft_column_limit, None);
        assert_eq!(cfg.restore_session, None);
        assert_eq!(cfg.language, None);
    }

    #[test]
    fn config_ignores_comments_and_blank_lines() {
        let cfg = parse_skrivro_config(
            "# leading comment\n\n   \n   # indented comment\ntheme = nord\n",
        );
        assert_eq!(cfg.theme.as_deref(), Some("nord"));
    }

    #[test]
    fn config_trims_whitespace_around_key_and_value() {
        let cfg = parse_skrivro_config("   editor-font   =   Hack   \n");
        assert_eq!(cfg.editor_font.as_deref(), Some("Hack"));
    }

    #[test]
    fn config_preserves_internal_value_spacing() {
        // Font names and other free-string values keep their internal
        // spaces. Only the surrounding whitespace is trimmed.
        let cfg = parse_skrivro_config("editor-font = JetBrains Mono\n");
        assert_eq!(cfg.editor_font.as_deref(), Some("JetBrains Mono"));
    }

    #[test]
    fn config_has_no_trailing_comments() {
        // Comments are full-line only: a '#' after the '=' belongs to
        // the value. Pinned so the parser never grows mid-line comment
        // stripping that would corrupt values legitimately containing
        // '#' (color-like strings, font names).
        let cfg = parse_skrivro_config("theme = nord # my favourite\n");
        assert_eq!(cfg.theme.as_deref(), Some("nord # my favourite"));
    }

    #[test]
    fn config_skips_malformed_lines_and_continues() {
        let cfg = parse_skrivro_config(
            "editor-font = Hack\nthis line has no equals sign\npreview-font = Source Serif\n",
        );
        assert_eq!(cfg.editor_font.as_deref(), Some("Hack"));
        assert_eq!(cfg.preview_font.as_deref(), Some("Source Serif"));
    }

    #[test]
    fn config_skips_unknown_keys() {
        // Keys are exact and case-sensitive: a typo or a case variant
        // is an unknown key, not a fuzzy match.
        let cfg = parse_skrivro_config("editor-fnot = Hack\nEDITOR-FONT = Hack\n");
        assert_eq!(cfg.editor_font, None);
    }

    #[test]
    fn config_treats_empty_value_as_unset() {
        let cfg = parse_skrivro_config("theme =\n");
        assert_eq!(cfg.theme, None);
        // An empty value is "no opinion", not "reset": it cannot clear
        // a value an earlier line already set.
        let cfg = parse_skrivro_config("theme = nord\ntheme =\n");
        assert_eq!(cfg.theme.as_deref(), Some("nord"));
    }

    #[test]
    fn config_duplicate_key_last_wins() {
        let cfg = parse_skrivro_config("theme = nord\ntheme = dracula\n");
        assert_eq!(cfg.theme.as_deref(), Some("dracula"));
    }

    #[test]
    fn config_font_sizes_take_one_unit_value() {
        let cfg = parse_skrivro_config("editor-font-size = 1.1rem\npreview-font-size = 16\n");
        assert_eq!(cfg.editor_font_size.as_deref(), Some("1.1rem"));
        assert_eq!(cfg.preview_font_size, None);
    }

    #[test]
    fn config_padding_takes_one_or_two_values() {
        let cfg = parse_skrivro_config(
            "editor-padding-x = 2rem\neditor-padding-y = 1rem 2rem\npreview-padding-x = 1rem 2rem 3rem\n",
        );
        assert_eq!(cfg.editor_padding_x.as_deref(), Some("2rem"));
        assert_eq!(cfg.editor_padding_y.as_deref(), Some("1rem 2rem"));
        assert_eq!(cfg.preview_padding_x, None);
    }

    #[test]
    fn config_default_format_is_validated_and_lowercased() {
        let cfg = parse_skrivro_config("default-format = Markdown\n");
        assert_eq!(cfg.default_format.as_deref(), Some("markdown"));
        let cfg = parse_skrivro_config("default-format = docx\n");
        assert_eq!(cfg.default_format, None);
    }

    #[test]
    fn config_spellcheck_language_is_validated_and_lowercased() {
        let cfg = parse_skrivro_config("spellcheck-language = BOTH\n");
        assert_eq!(cfg.spellcheck_language.as_deref(), Some("both"));
        // auto is the default and maps to None, the same representation
        // the language key's auto uses (the frontend detects the locale).
        let cfg = parse_skrivro_config("spellcheck-language = auto\n");
        assert_eq!(cfg.spellcheck_language, None);
        // Unrecognized values are rejected and also leave it None, which
        // the frontend treats as the auto default.
        let cfg = parse_skrivro_config("spellcheck-language = de\n");
        assert_eq!(cfg.spellcheck_language, None);
    }

    #[test]
    fn config_soft_column_limit_requires_a_positive_integer() {
        let cfg = parse_skrivro_config("soft-column-limit = 80\n");
        assert_eq!(cfg.soft_column_limit, Some(80));
        for bad in ["0", "-5", "8.5", "abc", "80px"] {
            let cfg = parse_skrivro_config(&format!("soft-column-limit = {bad}\n"));
            assert_eq!(cfg.soft_column_limit, None, "value {bad:?} should be rejected");
        }
    }

    #[test]
    fn config_bool_keys_accept_common_spellings() {
        for yes in ["true", "YES", "on", "1"] {
            let cfg = parse_skrivro_config(&format!("restore-session = {yes}\n"));
            assert_eq!(cfg.restore_session, Some(true), "value {yes:?} should mean true");
        }
        for no in ["false", "No", "off", "0"] {
            let cfg = parse_skrivro_config(&format!("restore-session = {no}\n"));
            assert_eq!(cfg.restore_session, Some(false), "value {no:?} should mean false");
        }
        let cfg = parse_skrivro_config("restore-session = maybe\n");
        assert_eq!(cfg.restore_session, None);
        // allow-external-images shares the same accepted spellings.
        let cfg = parse_skrivro_config("allow-external-images = yes\n");
        assert_eq!(cfg.allow_external_images, Some(true));
    }

    #[test]
    fn config_language_auto_means_no_override() {
        let cfg = parse_skrivro_config("language = SV\n");
        assert_eq!(cfg.language.as_deref(), Some("sv"));
        let cfg = parse_skrivro_config("language = auto\n");
        assert_eq!(cfg.language, None);
        // "auto" is an active reset, not a skip: it clears an override
        // set by an earlier line.
        let cfg = parse_skrivro_config("language = en\nlanguage = auto\n");
        assert_eq!(cfg.language, None);
        let cfg = parse_skrivro_config("language = fi\n");
        assert_eq!(cfg.language, None);
    }

    #[test]
    fn config_one_bad_line_does_not_abort_the_rest() {
        let text = "\
editor-font = Hack
soft-column-limit = ninety
!!! not a config line
preview-font-size = -2rem
theme = gruvbox-dark
";
        let cfg = parse_skrivro_config(text);
        assert_eq!(cfg.editor_font.as_deref(), Some("Hack"));
        assert_eq!(cfg.theme.as_deref(), Some("gruvbox-dark"));
        assert_eq!(cfg.soft_column_limit, None);
        assert_eq!(cfg.preview_font_size, None);
    }

    // ----- dic_starts_with_count (user-dictionary sanity check) -------

    #[test]
    fn dic_accepts_a_word_count_header() {
        // Normal Hunspell .dic shape: a count line, then words.
        assert!(dic_starts_with_count("153714\nfönster/ACFJUXY\n"));
        // A count followed by junk still passes on the first token.
        assert!(dic_starts_with_count("97199 ignored\nword\n"));
        // Leading blank lines are skipped to the first real line.
        assert!(dic_starts_with_count("\n  \n42\nword\n"));
    }

    #[test]
    fn dic_accepts_a_bom_prefixed_count() {
        // en_GB.dic / en_ZA.dic ship a UTF-8 BOM before the count, and it is
        // stripped only when present, so a BOM-less .dic is never truncated.
        assert!(dic_starts_with_count("\u{feff}97199\nword\n"));
    }

    #[test]
    fn dic_rejects_aff_content_so_a_swap_is_caught() {
        // A swapped pair puts .aff content in the .dic slot. Affix files lead
        // with SET or # comment lines, never a count.
        assert!(!dic_starts_with_count("SET UTF-8\nTRY esianrtolcd\n"));
        assert!(!dic_starts_with_count(
            "# Affix file for British English Hunspell dictionary.\nSET UTF-8\n"
        ));
        // hyph_*.dic hyphenation files lead with the charset, not a count.
        assert!(!dic_starts_with_count("UTF-8\nLEFTHYPHENMIN 2\n"));
        // Empty / whitespace-only is not a dictionary.
        assert!(!dic_starts_with_count(""));
        assert!(!dic_starts_with_count("   \n\n"));
    }
}
