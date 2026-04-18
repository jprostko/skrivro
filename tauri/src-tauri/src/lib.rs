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
// Skrivro and sends an AppleEvent — Tauri surfaces this as
// RunEvent::Opened { urls }. The CLI argv is typically empty in this
// scenario, so our existing launchInfo.initial_file mechanism doesn't
// see the file.
//
// Linux and Windows don't need this path — on those platforms, file
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
//    RunEvent::Opened again; the handler both pushes to PendingOpens
//    (in case something's still initializing) AND emits a Tauri event
//    that the frontend's live listener catches to open the file in
//    the existing instance.
//
// Both paths converge on frontend's loadFileFromPath, wrapped in
// confirmDiscard so a dropped-in-during-unsaved-work file gets the
// same discard prompt as Ctrl+O would.

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
// for font / size / padding / mode-style overrides. Not required — missing
// file means "use compiled-in defaults." See memory/project_config_file.md
// for the full design rationale and spec.
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
//   edit-font = JetBrains Mono
//   preview-font = Charter
//
//   # All length-typed values (font sizes, padding, pane widths) require
//   # an explicit CSS unit. Bare numbers are rejected — the rule is
//   # uniform across every length-typed key. Valid units: pt, px, rem,
//   # em, %, vw, vh, ch, ex, etc. (we don't maintain an allowlist; the
//   # webview's CSS engine is the ultimate validator).
//   edit-font-size = 14pt
//   preview-font-size = 15pt
//
//   # Padding (editor and preview, x / y axes). Each key accepts one or
//   # two values. One value: applied uniformly to both ends of the axis.
//   # Two values: reading order — for x it's `left right`, for y it's
//   # `top bottom`. Three or more values are rejected. Every token
//   # needs a unit.
//   editor-padding-x = 2.5rem
//   editor-padding-y = 2rem
//   preview-padding-x = 2.5rem
//   preview-padding-y = 2rem
//
//   # Pane widths (single-pane modes). Common choices: px, %, vw, ch.
//   edit-pane-width = 900px
//   preview-pane-width = 80ch
//
//   # Asciidoctor safe mode (set-and-forget; not exposed in UI)
//   asciidoc-safe-mode = unsafe
//
//   # Status bar cursor position format — verbose / compact / ruler
//   cursor-position-format = verbose
//
//   # Status bar mode pill style — canonical / muted
//   statusbar-style = canonical
//
//   # Soft column limit: positive integer, character count, no default.
//   # When set, the Col indicator in the status bar turns peach once the
//   # cursor's column count on the current line exceeds this value —
//   # useful for prose workflows with hard column-width conventions
//   # (80- or 100-char line limits, commit messages, etc.). Tracks the
//   # document column, not the visual wrap column, so soft-wrapped text
//   # that exceeds the limit still triggers the indicator.
//   soft-column-limit = 100
//
// Naming convention across three layers:
//   - Config file:  kebab-case ("edit-font")   — user-facing spec
//   - Rust struct:  snake_case (`edit_font`)   — Rust convention
//   - JSON output:  camelCase  ("editFont")    — via serde rename_all,
//                                                 for idiomatic JS
//                                                 dot-access on the
//                                                 frontend side.
//
// The parser's match arm handles kebab→snake mapping by hand; the serde
// rename attribute handles snake→camel for the JSON boundary. JS code
// then uses `cfg.editFont`, `cfg.asciidocSafeMode`, etc., without any
// bracket-notation gymnastics.

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct SkrivroConfig {
    edit_font: Option<String>,
    preview_font: Option<String>,
    edit_font_size: Option<String>,
    preview_font_size: Option<String>,
    editor_padding_x: Option<String>,
    editor_padding_y: Option<String>,
    preview_padding_x: Option<String>,
    preview_padding_y: Option<String>,
    edit_pane_width: Option<String>,
    preview_pane_width: Option<String>,
    theme: Option<String>,
    asciidoc_safe_mode: Option<String>,
    cursor_position_format: Option<String>,
    statusbar_style: Option<String>,
    // First numeric-typed config key. Previously every field was
    // `Option<String>` for uniformity, but for a strict positive-
    // integer value there's no reason to store a string we'd have
    // to parse on the JS side anyway. Serde serializes Option<u32>
    // as `null | number`, so the frontend reads userConfig.softColumnLimit
    // as `undefined | number` directly — no parseInt, no validation.
    // Rejection logic (non-integer, zero, negative) lives in the
    // parser's match arm; invalid values leave the field None and
    // the frontend falls through to "no limit, no over-limit coloring."
    soft_column_limit: Option<u32>,
    // When true, launch restores the last-opened file's path from
    // session state at $APP_LOCAL_DATA/state.json. Default false —
    // normal launches start blank. Crash recovery via the autosave
    // draft is independent of this setting and takes priority over
    // it; session-restore only fires when no draft is present.
    // See the Session state section below for the state file format
    // and the get_session_state / set_session_state commands.
    restore_session: Option<bool>,
    // Theme colors resolved by load_theme() in get_config(). When the
    // user's `theme` key matches a non-default theme (i.e., anything
    // other than "catppuccin-mocha"), the Rust side loads the theme
    // file, parses it, and attaches the resolved colors here. The
    // frontend's applyUserConfig() iterates these and writes each as
    // an inline :root style, overriding the CSS-default Catppuccin
    // Mocha values. When the theme is catppuccin-mocha (or unset),
    // this field is None and the CSS defaults show through untouched.
    theme_colors: Option<ThemeColors>,
}

/// 24 semantic theme color slots. Each field maps to a `--skr-*` CSS
/// custom property. Theme files provide values for these slots in flat
/// `key = value` format (same parser as skrivro.conf). See
/// memory/project_theming.md for the full slot schema and purpose of
/// each.
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
/// format as skrivro.conf — one pair per line, # comments, blank lines
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
/// 1. User-supplied file at <app_config_dir>/themes/<name>.conf
/// 2. Bundled theme data embedded at compile time via include_str!()
/// 3. None — caller falls through to CSS defaults (catppuccin-mocha)
#[cfg_attr(not(debug_assertions), allow(unused_variables))]
fn load_theme(name: &str, app: &tauri::AppHandle) -> Option<ThemeColors> {
    // Check for user-supplied theme file first
    if let Some(dir) = skrivro_themes_dir(app) {
        let path = dir.join(format!("{}.conf", name));
        if let Ok(text) = std::fs::read_to_string(&path) {
            return Some(parse_theme_file(&text));
        }
    }
    // Fall back to bundled themes
    match name {
        "dracula" => Some(parse_theme_file(include_str!("../../themes/dracula.conf.default"))),
        "tokyo-night-moon" => Some(parse_theme_file(include_str!("../../themes/tokyo-night-moon.conf.default"))),
        "nord" => Some(parse_theme_file(include_str!("../../themes/nord.conf.default"))),
        "gruvbox-dark" => Some(parse_theme_file(include_str!("../../themes/gruvbox-dark.conf.default"))),
        "catppuccin-latte" => Some(parse_theme_file(include_str!("../../themes/catppuccin-latte.conf.default"))),
        "tokyo-night-day" => Some(parse_theme_file(include_str!("../../themes/tokyo-night-day.conf.default"))),
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
/// the user's config directory — we treat that as "no config available"
/// and fall through to defaults.
fn skrivro_config_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    app.path().app_config_dir().ok().map(|d| d.join("skrivro.conf"))
}

/// Normalize a length value for every length-typed config key (font
/// sizes, padding, pane widths). All length values REQUIRE an explicit
/// unit suffix — bare numbers are rejected because no single unit
/// assumption is universally intuitive across the different length
/// categories, and requiring units makes user intent unambiguous
/// without parser heuristics.
///
/// Accepted values are anything with a CSS unit suffix: `14pt`, `2rem`,
/// `900px`, `80%`, `60vw`, `80ch`, `1.1em`, etc. We do not maintain an
/// allowlist of valid CSS units — the webview validates far more
/// thoroughly than we ever could, and an allowlist would be maintenance
/// burden with only downside (false positives when new units are added
/// to CSS).
///
/// Multi-token support: `max_tokens` caps the number of whitespace-
/// separated values the key accepts.
/// - Font-size keys pass `1` (only a single length makes sense).
/// - Pane-width keys pass `1` (single length, no reading-order split).
/// - Padding keys pass `2` (one value for uniform, two for asymmetric
///   start/end in reading order).
///
/// Each token is validated independently — any bare number or leading-
/// minus value causes the whole value to be rejected.
///
/// Rejection cases (all emit a debug warning):
/// - More than `max_tokens` whitespace-separated tokens.
/// - Any token is a bare number (parses as f64 with no trailing unit).
///   Examples that trigger: `14`, `2.5`, `.5`, `1e2`.
/// - Any token starts with `-`. CSS would drop negative lengths
///   silently; catching at parse time makes the diagnostic visible
///   in dev builds.
///
/// Called from `parse_skrivro_config` for:
/// - Font-size keys (`edit-font-size`, `preview-font-size`, max_tokens=1)
/// - Padding keys (`edit/preview-padding-x/y`, max_tokens=2)
/// - Pane-width keys (`edit/preview-pane-width`, max_tokens=1)
///
/// Historical note: previously split into two functions (normalize_length
/// for font sizes + padding with `bare = pt` convention, and
/// normalize_dimension for pane widths with strict unit requirement).
/// Merged when the bare-number convention was dropped in favor of
/// "all length values require units." See memory/project_config_file.md
/// for the decision rationale.
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
        // decimal, and scientific forms (14, 14.5, .5, 1e5); any of those
        // without a trailing unit triggers rejection.
        if token.parse::<f64>().is_ok() {
            #[cfg(debug_assertions)]
            eprintln!(
                "[skrivro config] line {}: {} token '{}' requires an explicit unit (pt, px, rem, em, %, vw, ch, ...). Examples: 14pt, 2.5rem, 80ch, 900px",
                line_num, key, token
            );
            return None;
        }
        // Reject negative values like `-2rem` or `-100px`. CSS would drop
        // these silently; catching at parse time surfaces the diagnostic.
        if token.starts_with('-') {
            #[cfg(debug_assertions)]
            eprintln!(
                "[skrivro config] line {}: {} token '{}' is negative, skipping",
                line_num, key, token
            );
            return None;
        }
    }
    // All tokens passed validation — trust the user's units and let CSS
    // validate at render time if they typed something exotic.
    Some(tokens.join(" "))
}

/// Parse a Skrivro config file's text into a `SkrivroConfig`.
///
/// Parsing rules (per spec):
/// - One `key = value` per line
/// - Whitespace around `=` is tolerated and stripped
/// - Full-line comments only — `#` at the start of a trimmed line
/// - Blank lines ignored
/// - Unknown keys: warn and skip (forward-compat for future config keys
///   so older binaries don't choke on newer configs)
/// - Malformed lines (missing `=`): warn and skip
/// - Empty values treated as "unset" — struct field stays `None`, frontend
///   falls through to compiled-in defaults
/// - All length-valued keys (font sizes, padding, pane widths) go
///   through `normalize_length`, which REJECTS bare numbers (an
///   explicit CSS unit is required) and rejects negative values. The
///   helper takes a `max_tokens` argument: font-size and pane-width
///   keys pass `1` (single length only); padding keys pass `2` to
///   accept both `= 2rem` (uniform) and `= 2rem 3rem` (asymmetric
///   start/end) forms. See that function's doc comment for the full
///   rules and the rationale for dropping the historical `bare = pt`
///   convention.
/// - `soft-column-limit` is parsed inline as a strict positive
///   integer (not a CSS length) and stored in `Option<u32>` — the
///   only numeric-typed field in `SkrivroConfig`. Non-integer, zero,
///   or negative values are warned and skipped.
/// - One bad line does NOT abort loading the rest of the file
///
/// All warning `eprintln!`s are wrapped in `#[cfg(debug_assertions)]` so
/// they only fire in debug builds (visible during `npm run tauri dev` from
/// a terminal; compiled out of release builds entirely — zero runtime cost
/// for end users, and no stderr noise from a launched .desktop entry).
fn parse_skrivro_config(text: &str) -> SkrivroConfig {
    let mut cfg = SkrivroConfig::default();
    // `idx` is only referenced inside #[cfg(debug_assertions)] eprintln!s
    // below, so release builds see it as unused. cfg_attr here suppresses
    // the unused_variables warning ONLY when debug_assertions is off —
    // debug builds still get normal lint coverage.
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
            "edit-font" => cfg.edit_font = Some(val.to_string()),
            "preview-font" => cfg.preview_font = Some(val.to_string()),
            "edit-font-size" => cfg.edit_font_size = normalize_length(key, val, idx + 1, 1),
            "preview-font-size" => cfg.preview_font_size = normalize_length(key, val, idx + 1, 1),
            "editor-padding-x" => cfg.editor_padding_x = normalize_length(key, val, idx + 1, 2),
            "editor-padding-y" => cfg.editor_padding_y = normalize_length(key, val, idx + 1, 2),
            "preview-padding-x" => cfg.preview_padding_x = normalize_length(key, val, idx + 1, 2),
            "preview-padding-y" => cfg.preview_padding_y = normalize_length(key, val, idx + 1, 2),
            "edit-pane-width" => cfg.edit_pane_width = normalize_length(key, val, idx + 1, 1),
            "preview-pane-width" => cfg.preview_pane_width = normalize_length(key, val, idx + 1, 1),
            "theme" => cfg.theme = Some(val.to_string()),
            "asciidoc-safe-mode" => cfg.asciidoc_safe_mode = Some(val.to_string()),
            "cursor-position-format" => cfg.cursor_position_format = Some(val.to_string()),
            "statusbar-style" => cfg.statusbar_style = Some(val.to_string()),
            "soft-column-limit" => {
                // Strict positive integer. Zero or negative is meaningless
                // (every column would be past the limit / no column could
                // ever be past it), so we reject both alongside non-numeric
                // garbage. No-unit parse, no pt inference — this is a
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
                // and treats undefined the same as false (default off).
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
            // Expected common case — no config file, use defaults. Silent.
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

    // Resolve theme colors. "catppuccin-mocha" (or unset) → no override
    // needed, CSS defaults are already Catppuccin Mocha. Any other value
    // triggers load_theme which checks for a user-supplied .conf first,
    // then falls back to bundled theme data.
    if let Some(ref name) = cfg.theme {
        if name != "catppuccin-mocha" {
            cfg.theme_colors = load_theme(name, &app);
        }
    }

    cfg
}

// ================= Session state =================
//
// Machine-local state persisted across clean exits. Currently just
// stores the last-opened file path for the restore-session feature —
// when `restore-session = true` is set in skrivro.conf and no CLI
// argument is given at launch and no crash-recovery draft is present,
// the frontend loads the file at `lastFilePath` from here.
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
/// the directory (extremely unusual — would mean a broken install
/// environment). Callers treat `None` as "no state available."
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
            // Expected common case — no prior session. Silent.
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
    // Ensure parent dir exists — on a fresh install the directory may
    // not have been created yet. Safe to call repeatedly.
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("mkdir {}: {}", parent.display(), e))?;
    }
    let mut text = serde_json::to_string_pretty(&state).map_err(|e| e.to_string())?;
    // Append a trailing newline for POSIX compliance. serde_json's
    // to_string_pretty doesn't add one; without it, `cat state.json`
    // leaves the zsh `%` no-newline indicator, git-diff shows
    // "No newline at end of file", and any tool that expects text
    // files to end with \n sees the file as malformed. The body is
    // LF-throughout on all platforms (serde_json doesn't produce
    // CRLF), so appending LF stays consistent.
    text.push('\n');
    // Atomic write: write to a sibling temp file, then rename. If the
    // process dies mid-write, the original state.json is untouched;
    // the orphan .tmp file will be overwritten next time. Rename is
    // atomic within a directory on POSIX and on Windows (NTFS).
    let mut tmp = path.clone().into_os_string();
    tmp.push(".tmp");
    let tmp_path = PathBuf::from(tmp);
    std::fs::write(&tmp_path, &text)
        .map_err(|e| format!("write {}: {}", tmp_path.display(), e))?;
    std::fs::rename(&tmp_path, &path)
        .map_err(|e| format!("rename {} -> {}: {}", tmp_path.display(), path.display(), e))?;
    Ok(())
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
//   - Theme is "catppuccin-mocha" (matches CSS defaults already — no
//     override needed)
//   - Theme name isn't resolvable (not bundled, no user file)
//   - JSON serialization of ThemeColors fails (shouldn't happen)

/// Compute the initial theme state as (native_bg_hex, init_script_js).
/// See the module-level comment above for the design rationale.
fn compute_initial_theme_state(app: &tauri::AppHandle) -> (String, String) {
    let mocha_bg = "#1e1e2e".to_string();
    let empty_script = String::new();

    let Some(path) = skrivro_config_path(app) else {
        return (mocha_bg, empty_script);
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return (mocha_bg, empty_script);
    };
    let cfg = parse_skrivro_config(&text);
    let Some(theme_name) = cfg.theme else {
        return (mocha_bg, empty_script);
    };
    if theme_name == "catppuccin-mocha" {
        return (mocha_bg, empty_script);
    }
    let Some(colors) = load_theme(&theme_name, app) else {
        return (mocha_bg, empty_script);
    };

    let bg = colors.bg.clone().unwrap_or(mocha_bg);
    let init_script = generate_theme_init_script(&colors);
    (bg, init_script)
}

/// Generate a JS snippet that sets `window.__SKRIVRO_INITIAL_THEME__` to
/// a JSON object with the theme's color values. The object keys are
/// camelCase via serde's `rename_all = "camelCase"` attribute on
/// `ThemeColors`; the inline script in index.html converts them to
/// kebab-case when setting `--skr-*` CSS custom properties.
fn generate_theme_init_script(colors: &ThemeColors) -> String {
    match serde_json::to_string(colors) {
        Ok(json) => format!("window.__SKRIVRO_INITIAL_THEME__ = {};", json),
        Err(_) => String::new(),
    }
}

/// Parse a hex color string like "#1e1e2e" into a Tauri Color (RGBA with
/// alpha=255). Returns `None` for malformed input; callers should fall
/// back to a sensible default.
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Wayland app_id workaround: set GLib's program name to the Tauri
    // identifier BEFORE any GTK code runs.
    //
    // Why this exists: on Wayland, the compositor's concept of "window
    // class" comes from xdg_toplevel.app_id. GDK-Wayland populates that
    // field by calling g_get_prgname(), NOT by reading GtkApplication's
    // application_id — even though GTK's own documentation suggests
    // application_id should be the canonical source of identity.
    //
    // tao's Linux event loop (tao-0.34.8, see
    // platform_impl/linux/event_loop.rs::new_gtk) calls gtk::init()
    // before anything has a chance to override the default. gtk::init()
    // locks in `prgname` from argv[0] — the executable name "skrivro"
    // (from Cargo's [package] name). Without intervention, Hyprland and
    // any other Wayland compositor see our window class as "skrivro"
    // instead of "com.skrivro.editor".
    //
    // tauri.conf.json has `enableGTKAppId = true`, which makes Tauri
    // pass our identifier to `GtkApplication::new()` as application_id.
    // That setting is DEFENSIVE, not load-bearing for the Wayland case
    // — it makes the identifier available for GTK consumers that DO
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
    // ever rename the app again, both need to change — there's no way
    // to read the Tauri config before calling into Tauri itself, which
    // is exactly what we need to avoid here since Tauri/tao's init is
    // the thing that's locking in the wrong prgname.
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
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            get_launch_info,
            get_config,
            get_session_state,
            set_session_state,
            take_pending_opens
        ])
        .setup(|app| {
            // Create the main window programmatically (rather than via
            // tauri.conf.json's app.windows array) so we can compute the
            // background_color and initialization_script dynamically from
            // the user's selected theme. This eliminates the FOUC flash
            // that would otherwise occur between the Catppuccin Mocha
            // compiled-in CSS defaults and the user's applied theme
            // overrides. See compute_initial_theme_state above for the
            // full rationale.
            let (bg_hex, init_script) = compute_initial_theme_state(&app.handle());
            let bg_color = parse_hex_color(&bg_hex)
                .unwrap_or(tauri::webview::Color(30, 30, 46, 255)); // #1e1e2e fallback

            let mut builder = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("Skrivro")
            .inner_size(1280.0, 720.0)
            .decorations(false)
            .background_color(bg_color);

            if !init_script.is_empty() {
                builder = builder.initialization_script(&init_script);
            }

            let window = builder.build()?;

            // Restore window state (size, position, maximized, fullscreen)
            // from the tauri-plugin-window-state saved state, if any. On
            // first launch or after `rm`ing the plugin's state file, this
            // is a no-op and the window keeps the inner_size(1280, 720)
            // default from the builder above. On subsequent launches, the
            // window is reshaped/moved to match wherever the user had it
            // when they last closed Skrivro.
            //
            // There is a brief reshape visible at launch as the default
            // size/position snaps to the restored values — accepted as a
            // minor cosmetic cost for the persistence win. If this becomes
            // annoying, the fix is to read the plugin's saved state
            // manually before building the window and pass the restored
            // values into .inner_size() / .position(), rather than
            // restoring after build.
            {
                use tauri_plugin_window_state::{StateFlags, WindowExt};
                let _ = window.restore_state(StateFlags::all());
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
            // (they have legitimate use). The Input Methods submenu — only
            // present when a GTK input method daemon like fcitx5 or ibus is
            // active — also stays, since IME users genuinely need it.
            #[cfg(target_os = "linux")]
            {
                window.with_webview(|webview| {
                    use webkit2gtk::{
                        ContextMenuAction, ContextMenuExt, ContextMenuItemExt, WebViewExt,
                    };
                    let wv = webview.inner();
                    wv.connect_context_menu(|_wv, menu, _event, _hit| {
                        for item in menu.items() {
                            if item.stock_action() == ContextMenuAction::Unicode {
                                menu.remove(&item);
                            }
                        }
                        // false = let webkit display the (modified) menu;
                        // true would suppress the menu entirely.
                        false
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
            // gated to macOS and iOS in Tauri's source — it does not
            // exist as a variant on Linux or Windows. On those
            // platforms file associations pass the file as a CLI
            // argument handled by launch_info.
            //
            // The cfg gate here mirrors the gate on the variant
            // definition itself (see app.rs:232-238 in tauri 2.10.x).
            // Without the gate, this code fails to compile on
            // Linux/Windows with "variant not found in RunEvent".
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
