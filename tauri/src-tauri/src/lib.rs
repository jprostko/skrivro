use serde::Serialize;
use std::env;
use std::path::PathBuf;

#[derive(Serialize, Clone)]
struct LaunchInfo {
    initial_file: Option<String>,
    cwd: String,
}

#[tauri::command]
fn get_launch_info(state: tauri::State<LaunchInfo>) -> LaunchInfo {
    state.inner().clone()
}

// ================= User config file =================
//
// Skrivro reads a user-editable flat `key = value` config file at startup
// for font / size / padding / mode-style overrides. Not required — missing
// file means "use compiled-in defaults." See memory/project_config_file.md
// for the full design rationale and spec.
//
// File location: $XDG_CONFIG_HOME/skrivro/skrivro.conf, falling back to
// $HOME/.config/skrivro/skrivro.conf if XDG_CONFIG_HOME is unset.
//
// Format example:
//
//   # Fonts
//   edit-font = JetBrains Mono
//   preview-font = Charter
//
//   # Lengths (font sizes): a bare positive number is assumed to be pt,
//   # so `14` and `14pt` produce the same result. An explicit unit (px,
//   # rem, em, %, ...) is passed through to CSS unchanged.
//   edit-font-size = 14
//   preview-font-size = 15
//
//   # Padding (editor and preview, x / y axes). Each key accepts one or
//   # two values. One value: applied uniformly to both ends of the axis.
//   # Two values: reading order — for x it's `left right`, for y it's
//   # `top bottom`. Bare numbers are assumed pt; any value with an
//   # explicit unit passes through. Three or more values are rejected.
//   editor-padding-x = 2.5rem
//   editor-padding-y = 2rem
//   preview-padding-x = 2.5rem
//   preview-padding-y = 2rem
//
//   # Dimensions (pane widths in single-pane modes): unit is REQUIRED.
//   # A bare number like `900` is rejected because no unit assumption is
//   # universally intuitive for layout. Common choices: px, %, vw, ch.
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

/// Resolve the theme directory path under XDG config.
fn skrivro_themes_dir() -> Option<PathBuf> {
    let base = env::var("XDG_CONFIG_HOME")
        .ok()
        .map(PathBuf::from)
        .or_else(|| env::var("HOME").ok().map(|h| PathBuf::from(h).join(".config")))?;
    Some(base.join("skrivro").join("themes"))
}

/// Load a theme by name. Resolution order:
/// 1. User-supplied file at $XDG_CONFIG_HOME/skrivro/themes/<name>.conf
/// 2. Bundled theme data embedded at compile time via include_str!()
/// 3. None — caller falls through to CSS defaults (catppuccin-mocha)
#[cfg_attr(not(debug_assertions), allow(unused_variables))]
fn load_theme(name: &str) -> Option<ThemeColors> {
    // Check for user-supplied theme file first
    if let Some(dir) = skrivro_themes_dir() {
        let path = dir.join(format!("{}.conf", name));
        if let Ok(text) = std::fs::read_to_string(&path) {
            return Some(parse_theme_file(&text));
        }
    }
    // Fall back to bundled themes
    match name {
        "dracula" => Some(parse_theme_file(include_str!("../../themes/dracula.conf"))),
        "tokyo-night-moon" => Some(parse_theme_file(include_str!("../../themes/tokyo-night-moon.conf"))),
        "nord" => Some(parse_theme_file(include_str!("../../themes/nord.conf"))),
        "gruvbox-dark" => Some(parse_theme_file(include_str!("../../themes/gruvbox-dark.conf"))),
        _ => {
            #[cfg(debug_assertions)]
            eprintln!("[skrivro config] theme '{}' not found (no user file, no bundled data)", name);
            None
        }
    }
}

/// Resolve the config file path per XDG Base Directory Spec.
///
/// Checks `$XDG_CONFIG_HOME` first, falling back to `$HOME/.config` if the
/// XDG var is unset (which is what virtually all Linux setups use). Returns
/// `None` if neither env var is set — unusual, effectively a sandboxed or
/// broken environment; we treat it as "no config available" and fall
/// through to defaults.
fn skrivro_config_path() -> Option<PathBuf> {
    let base = env::var("XDG_CONFIG_HOME")
        .ok()
        .map(PathBuf::from)
        .or_else(|| env::var("HOME").ok().map(|h| PathBuf::from(h).join(".config")))?;
    Some(base.join("skrivro").join("skrivro.conf"))
}

/// Normalize a length value for the font-size / padding keys.
///
/// Users writing a config file overwhelmingly think in points, so a bare
/// positive number (integer or decimal) is treated as pt — `14` becomes
/// `14pt`, `10.5` becomes `10.5pt`. Any value that does NOT parse as a
/// bare number is passed through unchanged on the assumption that it
/// already carries a CSS unit suffix (`14px`, `1.1rem`, `16em`, `80%`,
/// etc.). We deliberately do not maintain an allowlist of valid CSS
/// length units: the CSS engine in the webview already validates far
/// more thoroughly than we ever could, and a user who types `14potato`
/// will see their setting silently drop — which is noisier than getting
/// zero help from us but less noisy than a false-positive reject from
/// an outdated allowlist.
///
/// Zero or negative values are rejected with a debug warning. CSS
/// length ≤ 0 is almost never what the user intended (no editor wants
/// a negative font size), and trying to render `font-size: -5pt` would
/// drop the declaration anyway. Rejecting in the parser makes the
/// diagnostic visible in dev builds instead of leaving the user to
/// puzzle out why their setting "didn't work."
///
/// Multi-token support: `max_tokens` caps the number of whitespace-
/// separated values the key accepts. Font-size keys pass `1` (only a
/// single length makes sense for `font-size`). Padding-x / padding-y
/// keys pass `2` (one value for uniform, two for asymmetric start/end).
/// Values exceeding the cap are rejected with a debug warning. Each
/// token is normalized independently using the rules above — so
/// `editor-padding-y = 10 20` becomes `10pt 20pt`, and
/// `editor-padding-y = 2rem 10` becomes `2rem 10pt`.
///
/// Called from `parse_skrivro_config` for the font-size keys
/// (`edit-font-size`, `preview-font-size`, max_tokens=1) and the
/// padding keys (`edit/preview-padding-x/y`, max_tokens=2).
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
    let mut out = Vec::with_capacity(tokens.len());
    for token in &tokens {
        if let Ok(n) = token.parse::<f64>() {
            if n > 0.0 {
                // Bare positive number — assume pt
                out.push(format!("{}pt", token));
            } else {
                // Zero or negative → almost certainly a mistake
                #[cfg(debug_assertions)]
                eprintln!(
                    "[skrivro config] line {}: {} token '{}' must be positive, skipping whole value '{}'",
                    line_num, key, token, val
                );
                return None;
            }
        } else {
            // Not a bare number — trust the user's unit suffix (or let
            // CSS drop it if they typed garbage).
            out.push(token.to_string());
        }
    }
    Some(out.join(" "))
}

/// Normalize a dimension value for the pane-width keys.
///
/// Different from `normalize_length`: dimension keys REJECT bare numbers
/// outright, because no single unit assumption is universally intuitive
/// for layout measurements. For font sizes and padding, pt is a natural
/// default (print-typography convention carries over). For widths,
/// there is no equivalent convention: a user writing `edit-pane-width =
/// 900` could reasonably mean 900 px, 900 pt (= 1200 px at 96 dpi), or
/// something else entirely. Ghostty's config format reached the same
/// conclusion for its window-size option, and we follow their rule:
/// "a bare value without a suffix is a config error."
///
/// Accepted values are anything with a CSS unit suffix — `900px`, `80%`,
/// `60vw`, `40rem`, `80ch`, etc. We do not maintain an allowlist of
/// valid CSS units (same rationale as `normalize_length`): the webview
/// validates far more thoroughly than we ever could, and an allowlist
/// would be maintenance with a pure downside.
///
/// Values that start with `-` are rejected as negatives. CSS would drop
/// `max-width: -100px` anyway, but catching it at parse time makes the
/// diagnostic visible in dev builds instead of silently dropping.
///
/// Called from `parse_skrivro_config` for exactly two keys:
/// `edit-pane-width`, `preview-pane-width`.
#[cfg_attr(not(debug_assertions), allow(unused_variables))]
fn normalize_dimension(key: &str, val: &str, line_num: usize) -> Option<String> {
    if val.parse::<f64>().is_ok() {
        // Bare number — ambiguous, reject with a pointer to valid units
        #[cfg(debug_assertions)]
        eprintln!(
            "[skrivro config] line {}: {} value '{}' requires an explicit unit (px, %, vw, rem, ch, ...). Examples: 900px, 80ch, 60%",
            line_num, key, val
        );
        return None;
    }
    if val.starts_with('-') {
        // Explicit negative like `-100px` — CSS would drop it silently,
        // so catch it here where the user can see the warning in dev.
        #[cfg(debug_assertions)]
        eprintln!(
            "[skrivro config] line {}: {} value '{}' is negative, skipping",
            line_num, key, val
        );
        return None;
    }
    // Has a unit suffix — trust it and let CSS validate at render time.
    Some(val.to_string())
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
/// - Length-valued keys go through `normalize_length` which maps bare
///   positive numbers to pt, passes through explicit-unit values, and
///   rejects zero/negative. The helper takes a `max_tokens` argument:
///   font-size keys (`edit-font-size`, `preview-font-size`) pass `1`
///   since CSS font-size is single-valued; padding keys
///   (`editor/preview-padding-x/y`) pass `2` to accept both
///   `= 2rem` (uniform) and `= 2rem 3rem` (asymmetric start/end) forms.
///   See that function's doc comment for the full rules.
/// - Dimension-valued keys (edit-pane-width, preview-pane-width) go
///   through `normalize_dimension`, which REJECTS bare numbers and
///   requires an explicit CSS unit. No unit assumption is universally
///   intuitive for layout widths, so the user must say what they mean.
///   See that function's doc comment for the full rules.
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
            "edit-pane-width" => cfg.edit_pane_width = normalize_dimension(key, val, idx + 1),
            "preview-pane-width" => cfg.preview_pane_width = normalize_dimension(key, val, idx + 1),
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
fn get_config() -> SkrivroConfig {
    let Some(path) = skrivro_config_path() else {
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
            cfg.theme_colors = load_theme(name);
        }
    }

    cfg
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Wayland app_id workaround: set GLib's program name to the Tauri
    // identifier BEFORE any GTK code runs.
    //
    // Why this exists: Tauri's tauri.conf.json has `app.enableGTKAppId =
    // true` set, which makes Tauri pass our identifier ("com.skrivro.editor")
    // as the app_id to wry/tao. tao in turn passes it to
    // `gtk::Application::new(Some("com.skrivro.editor"), ...)`. In theory
    // GTK should use that application_id as the Wayland `xdg_toplevel.app_id`
    // for our windows — that's what the GtkApplication docs say.
    //
    // In practice tao's Linux event loop (tao-0.34.8, see
    // platform_impl/linux/event_loop.rs::new_gtk) calls `gtk::init()`
    // before `gtk::Application::new()`. GTK's init locks in the internal
    // `prgname` from `argv[0]` at that point — which is the executable
    // name "skrivro" (from Cargo's [package] name). The GtkApplication
    // constructed afterwards doesn't override this. And the Wayland
    // backend of GDK sets `xdg_toplevel.app_id` from `g_get_prgname()`,
    // NOT from the GtkApplication's application_id. The net effect is
    // that Hyprland (and any other Wayland compositor) sees our window
    // class as "skrivro" instead of "com.skrivro.editor".
    //
    // There's even an acknowledging comment in tao's source near the
    // gtk::init() call: "This should be done by gtk::Application::new,
    // but does not work properly."
    //
    // The workaround: set the prgname ourselves, BEFORE calling into
    // Tauri/tao. When tao's gtk::init() runs, it reads our already-set
    // value instead of falling back to argv[0]. When GDK-Wayland then
    // reads prgname for the xdg_toplevel.app_id, it gets the right value.
    //
    // Must stay in sync with `identifier` in tauri.conf.json. If we ever
    // rename the app again, both need to change — there's no way to
    // read the Tauri config before calling into Tauri itself, which is
    // exactly what we need to avoid here since Tauri/tao's init is the
    // thing that's locking in the wrong prgname.
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
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![get_launch_info, get_config])
        .setup(|app| {

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
                use tauri::Manager;
                let window = app
                    .get_webview_window("main")
                    .ok_or("main window not found")?;
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
            let _ = app;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
