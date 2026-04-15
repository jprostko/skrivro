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
//   edit-font-size = 14pt
//   preview-font-size = 15pt
//   editor-padding = 16pt
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
        let val = val.to_string();
        match key {
            "edit-font" => cfg.edit_font = Some(val),
            "preview-font" => cfg.preview_font = Some(val),
            "edit-font-size" => cfg.edit_font_size = Some(val),
            "preview-font-size" => cfg.preview_font_size = Some(val),
            "editor-padding" => cfg.editor_padding = Some(val),
            "theme" => cfg.theme = Some(val),
            "asciidoc-safe-mode" => cfg.asciidoc_safe_mode = Some(val),
            "cursor-position-format" => cfg.cursor_position_format = Some(val),
            "statusbar-style" => cfg.statusbar_style = Some(val),
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
