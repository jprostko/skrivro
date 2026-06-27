// ================= macOS menu bar =================
//
// Builds and installs Skrivro's macOS menu bar via Tauri's @tauri-apps/api/menu.
// Mac-only; called from main.ts under `if (isMac)`. Linux/Windows don't get
// a menu bar (Tauri menus would render in-window on those platforms, which
// doesn't fit a borderless keyboard-first editor).
//
// Window chrome on Mac (set in lib.rs): decorations(true) + Cocoa-level
// hiding of the visible chrome (titlebarAppearsTransparent +
// titleVisibility=.hidden + per-traffic-light standardWindowButton
// setHidden). The style mask keeps the .titled / .closable /
// .miniaturizable / .resizable bits AppKit needs for native menu
// integration, while the window presents visually as borderless.
//
// The implication for this file: most Window menu items are
// PredefinedMenuItem instances — they wire to canonical NSWindow
// selectors (performMiniaturize: / zoom: / toggleFullScreen:) which
// work because the style mask has the bits. The predefined Fullscreen
// item additionally gets AppKit's Big Sur shortcut substitution: shown
// as 🌐F on modern MacBooks, with hardware Fn+F routing to it.
//
// Why we still need a custom menu (rather than letting Tauri use its
// default) — two reasons remain:
//   1. Predefined Quit calls NSApplication.terminate: directly, which
//      bypasses our window's onCloseRequested handler. A dirty buffer
//      would be silently exited without the discard-changes confirm
//      dialog. Our custom Quit calls getCurrentWindow().close() which
//      DOES route through onCloseRequested → confirmDiscard. Single-
//      window app, so closing the window = quitting the app. Same
//      routing reason for File > Close Window and Window > Close
//      Window — all three share closeAction below.
//   2. The default File menu is bare ("Close Window" only). We populate
//      it with New / Open / Save / Save As / Reload so Mac users can
//      discover and invoke file operations through the menu instead of
//      needing to know the keyboard shortcuts.
//
// Reload menu item wraps reloadFile() in confirmDiscard so a dirty
// buffer prompts via our GUI confirm dialog. reloadFile() itself
// doesn't check dirty — it unconditionally overwrites the buffer —
// so without the wrapper the menu item would silently discard unsaved
// changes.

import { Menu, MenuItem, PredefinedMenuItem, Submenu } from "@tauri-apps/api/menu";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";

import { openFile, saveFile, saveFileAs, newFile, reloadFile, confirmDiscard } from "./io.js";
import {
  toggleVim,
  toggleTitlebar,
  toggleGutter,
  toggleStatusBar,
  setDisplayMode,
  toggleHelp,
} from "./ui.js";
import { syncPreviewToCaret } from "./preview.js";

// Convenience: the Window > Close, File > Close Window, and App > Quit items
// all do the same thing — close this single window, which routes through
// onCloseRequested → dirty-buffer confirm → window destroy → process exit.
// Defined once so the three menu items can share it.
const closeAction = () => {
  void getCurrentWindow().close();
};

export const installMenu = async () => {
  // --- App menu (Skrivro) ---
  const appMenu = await Submenu.new({
    text: "Skrivro",
    items: [
      // About item takes an AboutMetadata object (or null for defaults
      // from tauri.conf.json). null is fine — productName "Skrivro" is
      // already in our Tauri config and Tauri reads from there.
      await PredefinedMenuItem.new({ item: { About: null } }),
      await PredefinedMenuItem.new({ item: "Separator" }),
      await PredefinedMenuItem.new({ item: "Services" }),
      await PredefinedMenuItem.new({ item: "Separator" }),
      await PredefinedMenuItem.new({ item: "Hide" }),
      await PredefinedMenuItem.new({ item: "HideOthers" }),
      await PredefinedMenuItem.new({ item: "ShowAll" }),
      await PredefinedMenuItem.new({ item: "Separator" }),
      await MenuItem.new({
        text: "Quit Skrivro",
        accelerator: "Cmd+Q",
        action: closeAction,
      }),
    ],
  });

  // --- File menu ---
  // Default Tauri menu's File only has "Close Window". We add the standard
  // file-op set so Mac users can discover and invoke them through the menu.
  // All actions call the same JS handlers that the keyboard shortcuts in
  // main.ts's keydown listener call — no logic duplication, just a second
  // entry point.
  const fileMenu = await Submenu.new({
    text: "File",
    items: [
      await MenuItem.new({
        text: "New",
        accelerator: "Cmd+N",
        action: newFile,
      }),
      await MenuItem.new({
        text: "Open…",
        accelerator: "Cmd+O",
        action: openFile,
      }),
      await PredefinedMenuItem.new({ item: "Separator" }),
      await MenuItem.new({
        text: "Save",
        accelerator: "Cmd+S",
        action: () => {
          void saveFile();
        },
      }),
      await MenuItem.new({
        text: "Save As…",
        accelerator: "Cmd+Shift+S",
        action: () => {
          void saveFileAs();
        },
      }),
      await MenuItem.new({
        // No keyboard shortcut: Cmd+E is taken by View > Editor Only, and
        // there's no other obvious pick. Vim users can still type :e
        // (or :e! to force-discard a dirty buffer) for the same action.
        text: "Reload from Disk",
        action: () => {
          // Wrap with confirmDiscard so a dirty buffer prompts via our
          // GUI confirm dialog. reloadFile itself doesn't check dirty;
          // without this wrapper, the menu item would silently discard
          // unsaved changes.
          confirmDiscard(() => {
            void reloadFile();
          });
        },
      }),
      await PredefinedMenuItem.new({ item: "Separator" }),
      await MenuItem.new({
        text: "Close Window",
        accelerator: "Cmd+W",
        action: closeAction,
      }),
    ],
  });

  // --- Edit menu ---
  // All standard predefined items. macOS auto-injects AutoFill / Start
  // Dictation / Emoji & Symbols below these — we don't (and can't) add
  // those.
  const editMenu = await Submenu.new({
    text: "Edit",
    items: [
      await PredefinedMenuItem.new({ item: "Undo" }),
      await PredefinedMenuItem.new({ item: "Redo" }),
      await PredefinedMenuItem.new({ item: "Separator" }),
      await PredefinedMenuItem.new({ item: "Cut" }),
      await PredefinedMenuItem.new({ item: "Copy" }),
      await PredefinedMenuItem.new({ item: "Paste" }),
      await PredefinedMenuItem.new({ item: "SelectAll" }),
    ],
  });

  // --- View menu ---
  // Surfaces our app's display toggles and modes via the menu, with the
  // Ctrl+Cmd+letter accelerators we chose for Mac.
  // Enter/Exit Full Screen is here (Apple HIG convention).
  // Placing Fullscreen in the Window menu instead of here breaks
  // AppKit's Fn+F → Fullscreen-menu-item registration in ways our
  // workarounds couldn't fix cleanly.
  const viewMenu = await Submenu.new({
    text: "View",
    items: [
      await MenuItem.new({
        text: "Toggle Vim Mode",
        accelerator: "Cmd+Ctrl+V",
        action: toggleVim,
      }),
      await MenuItem.new({
        text: "Toggle Titlebar",
        accelerator: "Cmd+Ctrl+T",
        action: toggleTitlebar,
      }),
      await MenuItem.new({
        text: "Toggle Gutter",
        accelerator: "Cmd+Ctrl+G",
        action: toggleGutter,
      }),
      await MenuItem.new({
        text: "Toggle Status Bar",
        accelerator: "Cmd+Ctrl+B",
        action: toggleStatusBar,
      }),
      await PredefinedMenuItem.new({ item: "Separator" }),
      await MenuItem.new({
        text: "Editor Only",
        accelerator: "Cmd+Ctrl+E",
        action: () => {
          setDisplayMode("editor");
        },
      }),
      await MenuItem.new({
        text: "Split",
        accelerator: "Cmd+Ctrl+S",
        action: () => {
          setDisplayMode("split");
        },
      }),
      await MenuItem.new({
        text: "Preview Only",
        accelerator: "Cmd+Ctrl+P",
        action: () => {
          setDisplayMode("preview");
        },
      }),
      await PredefinedMenuItem.new({ item: "Separator" }),
      await MenuItem.new({
        text: "Sync Preview to Cursor",
        accelerator: "Cmd+Ctrl+L",
        action: syncPreviewToCaret,
      }),
      await PredefinedMenuItem.new({ item: "Separator" }),
      await PredefinedMenuItem.new({ item: "Fullscreen" }),
    ],
  });

  // --- Window menu ---
  // Minimize and Maximize (Mac calls it Zoom) are PredefinedMenuItem
  // instances. They wire to the canonical NSWindow selectors
  // (performMiniaturize: / zoom:) which work because lib.rs gives the
  // Mac window the .titled / .closable / .miniaturizable / .resizable
  // style mask bits via decorations(true).
  //
  // Fullscreen lives in View, not here (Apple HIG + empirical: putting
  // it here broke AppKit's Fn+F → Fullscreen-menu-item registration).
  //
  // Close Window stays custom: predefined Close routes through
  // performClose: which doesn't invoke our onCloseRequested handler
  // for the dirty-buffer confirm dialog. Custom item shares closeAction
  // with File > Close Window and App > Quit so the three entry points
  // all route through the same confirm path.
  //
  // macOS auto-injects Move & Resize / Full Screen Tile / Fill /
  // Center / Remove Window from Set / Bring All to Front / per-window
  // list when this submenu is registered as NSApp.windowsMenu —
  // which happens automatically because we set the submenu id to the
  // canonical __tauri_window_menu__ value below (Tauri's init_app_menu
  // handles the set_as_windows_menu_for_nsapp call for us).
  const windowMenu = await Submenu.new({
    // Tauri's init_app_menu helper (tauri-2.10.3/src/app.rs:2336-2351)
    // looks for this exact literal id and, when found, calls
    // Submenu::set_as_windows_menu_for_nsapp on the same main-thread
    // turn as init_for_nsapp (setMainMenu). Without this id, Tauri's
    // helper skips the setWindowsMenu call and we'd have to invoke it
    // ourselves — but a manual invoke on a later runloop turn breaks
    // AppKit's Big-Sur Fn+F → Fullscreen-menu-item registration.
    // Using the canonical id is what lets Tauri keep both calls on
    // the same turn. Constant value:
    // pub const WINDOW_SUBMENU_ID: &str = "__tauri_window_menu__";
    // (tauri-2.10.3/src/menu/menu.rs:19).
    id: "__tauri_window_menu__",
    text: "Window",
    items: [
      await PredefinedMenuItem.new({ item: "Minimize" }),
      await PredefinedMenuItem.new({ item: "Maximize" }),
      await PredefinedMenuItem.new({ item: "Separator" }),
      await MenuItem.new({
        text: "Close Window",
        accelerator: "Cmd+W",
        action: closeAction,
      }),
    ],
  });

  // --- Help menu ---
  // macOS auto-injects a Search field at the top. Below it we add our
  // help-dialog opener using the same accelerator the Ctrl+Alt+H shortcut
  // uses elsewhere (Ctrl+Cmd+H on Mac after the platform-strict modifier
  // remap).
  const helpMenu = await Submenu.new({
    // Sibling of the Window menu id above — Tauri's init_app_menu
    // helper also handles set_as_help_menu_for_nsapp for this id.
    // HELP_SUBMENU_ID = "__tauri_help_menu__" (tauri-2.10.3/src/menu/menu.rs:21).
    id: "__tauri_help_menu__",
    text: "Help",
    items: [
      await MenuItem.new({
        text: "Show Keyboard Shortcuts",
        accelerator: "Cmd+Ctrl+H",
        action: toggleHelp,
      }),
    ],
  });

  const menu = await Menu.new({
    items: [appMenu, fileMenu, editMenu, viewMenu, windowMenu, helpMenu],
  });
  await menu.setAsAppMenu();

  // Re-apply collectionBehavior flags in case the invisible helper
  // NSWindow was created lazily (after hide_macos_chrome's setup-time
  // pass). See the Rust side for details.
  await invoke("apply_collection_behavior");

  // No manual setWindowsMenu/setMainMenu calls needed. With the
  // Window and Help submenus carrying Tauri's canonical
  // __tauri_window_menu__ / __tauri_help_menu__ ids above, Tauri's
  // init_app_menu (invoked synchronously inside menu.setAsAppMenu)
  // calls set_as_windows_menu_for_nsapp and set_as_help_menu_for_nsapp
  // on the same main-thread turn as init_for_nsapp.
};
