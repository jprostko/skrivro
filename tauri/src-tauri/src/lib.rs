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
//   # Lengths (font sizes, padding): a bare positive number — integer or
//   # decimal — is assumed to be pt, so `14` and `14pt` produce the same
//   # result. An explicit unit (px, rem, em, %, ...) is passed through to
//   # CSS unchanged for users who know what they want.
//   edit-font-size = 14
//   preview-font-size = 15
//   editor-padding = 16
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
    editor_padding: Option<String>,
    edit_pane_width: Option<String>,
    preview_pane_width: Option<String>,
    theme: Option<String>,
    asciidoc_safe_mode: Option<String>,
    cursor_position_format: Option<String>,
    statusbar_style: Option<String>,
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
/// Called from `parse_skrivro_config` for exactly three keys:
/// `edit-font-size`, `preview-font-size`, `editor-padding`.
#[cfg_attr(not(debug_assertions), allow(unused_variables))]
fn normalize_length(key: &str, val: &str, line_num: usize) -> Option<String> {
    if let Ok(n) = val.parse::<f64>() {
        if n > 0.0 {
            // Bare positive number — assume pt
            return Some(format!("{}pt", val));
        }
        // Zero or negative → almost certainly a mistake
        #[cfg(debug_assertions)]
        eprintln!(
            "[skrivro config] line {}: {} value '{}' must be positive, skipping",
            line_num, key, val
        );
        return None;
    }
    // Not a bare number — trust the user's unit suffix (or let CSS drop
    // it if they typed garbage).
    Some(val.to_string())
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
/// - Length-valued keys (edit-font-size, preview-font-size,
///   editor-padding) go through `normalize_length` which maps bare
///   positive numbers to pt and rejects zero/negative. See that
///   function's doc comment for the full rules.
/// - Dimension-valued keys (edit-pane-width, preview-pane-width) go
///   through `normalize_dimension`, which REJECTS bare numbers and
///   requires an explicit CSS unit. No unit assumption is universally
///   intuitive for layout widths, so the user must say what they mean.
///   See that function's doc comment for the full rules.
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
            "edit-font-size" => cfg.edit_font_size = normalize_length(key, val, idx + 1),
            "preview-font-size" => cfg.preview_font_size = normalize_length(key, val, idx + 1),
            "editor-padding" => cfg.editor_padding = normalize_length(key, val, idx + 1),
            "edit-pane-width" => cfg.edit_pane_width = normalize_dimension(key, val, idx + 1),
            "preview-pane-width" => cfg.preview_pane_width = normalize_dimension(key, val, idx + 1),
            "theme" => cfg.theme = Some(val.to_string()),
            "asciidoc-safe-mode" => cfg.asciidoc_safe_mode = Some(val.to_string()),
            "cursor-position-format" => cfg.cursor_position_format = Some(val.to_string()),
            "statusbar-style" => cfg.statusbar_style = Some(val.to_string()),
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
    match std::fs::read_to_string(&path) {
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
    }
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
