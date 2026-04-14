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
        .invoke_handler(tauri::generate_handler![get_launch_info])
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
