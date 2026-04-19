// ================= macOS menu bar =================
//
// Builds and installs Skrivro's macOS menu bar via Tauri's @tauri-apps/api/menu.
// Mac-only; called from main.ts under `if (isMac)`. Linux/Windows don't get
// a menu bar (Tauri menus would render in-window on those platforms, which
// doesn't fit a borderless keyboard-first editor).
//
// Why we need a custom menu at all:
//   1. Tauri's default Mac menu has Window > Minimize / Close items wired to
//      NSWindow.performMiniaturize: / performClose:. On a `decorations: false`
//      window those selectors check the window style mask, find the
//      "miniaturizable" / "closable" bits missing, and beep. Our menu uses
//      custom items that call getCurrentWindow().minimize() / .close()
//      programmatically (which don't gate on style mask) instead.
//   2. The default Quit item calls NSApplication.terminate: directly,
//      bypassing our window's onCloseRequested handler. Means a dirty buffer
//      is silently exited without the discard-changes confirm dialog. Our
//      custom Quit calls getCurrentWindow().close() which DOES route through
//      onCloseRequested → confirmDiscard. Single-window app, so closing the
//      window = quitting the app.
//   3. The default File menu is bare ("Close Window" only). We populate it
//      with New / Open / Save / Save As / Reload so Mac users can discover
//      and invoke file operations through the menu instead of needing to know
//      the keyboard shortcuts.
//
// See pending-features item #21 for the broader analysis. Item #24 covers the
// related silent-Ex-failure pattern that affects the Reload menu item's
// underlying reloadFile() call (we wrap with confirmDiscard here to avoid the
// silent-refuse case until #24 is actually fixed).

import {
  Menu,
  MenuItem,
  PredefinedMenuItem,
  Submenu,
} from '@tauri-apps/api/menu';
import { getCurrentWindow } from '@tauri-apps/api/window';

import {
  openFile, saveFile, saveFileAs, newFile, reloadFile, confirmDiscard,
} from './io.js';
import {
  toggleVim, toggleTitlebar, toggleGutter, toggleStatusBar,
  setDisplayMode, toggleHelp,
} from './ui.js';
import { syncPreviewToCaret } from './preview.js';

// Convenience: the Window > Close, File > Close Window, and App > Quit items
// all do the same thing — close this single window, which routes through
// onCloseRequested → dirty-buffer confirm → window destroy → process exit.
// Defined once so the three menu items can share it.
const closeAction = () => {
  void getCurrentWindow().close();
};

// Toggle Full Screen action. Extracted from the menu builder so the
// `action` property gets a sync `() => void` (the menu API rejects
// async functions there per @typescript-eslint/no-misused-promises).
const toggleFullscreen = async () => {
  const win = getCurrentWindow();
  const isFs = await win.isFullscreen();
  await win.setFullscreen(!isFs);
};

export const installMenu = async () => {
  // --- App menu (Skrivro) ---
  const appMenu = await Submenu.new({
    text: 'Skrivro',
    items: [
      // About item takes an AboutMetadata object (or null for defaults
      // from tauri.conf.json). null is fine — productName "Skrivro" is
      // already in our Tauri config and Tauri reads from there.
      await PredefinedMenuItem.new({ item: { About: null } }),
      await PredefinedMenuItem.new({ item: 'Separator' }),
      await PredefinedMenuItem.new({ item: 'Services' }),
      await PredefinedMenuItem.new({ item: 'Separator' }),
      await PredefinedMenuItem.new({ item: 'Hide' }),
      await PredefinedMenuItem.new({ item: 'HideOthers' }),
      await PredefinedMenuItem.new({ item: 'ShowAll' }),
      await PredefinedMenuItem.new({ item: 'Separator' }),
      await MenuItem.new({
        text: 'Quit Skrivro',
        accelerator: 'Cmd+Q',
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
    text: 'File',
    items: [
      await MenuItem.new({
        text: 'New',
        accelerator: 'Cmd+N',
        action: newFile,
      }),
      await MenuItem.new({
        text: 'Open…',
        accelerator: 'Cmd+O',
        action: openFile,
      }),
      await PredefinedMenuItem.new({ item: 'Separator' }),
      await MenuItem.new({
        text: 'Save',
        accelerator: 'Cmd+S',
        action: () => { void saveFile(); },
      }),
      await MenuItem.new({
        text: 'Save As…',
        accelerator: 'Cmd+Shift+S',
        action: () => { void saveFileAs(); },
      }),
      await MenuItem.new({
        // No keyboard shortcut: Cmd+E is taken by View > Editor Only, and
        // there's no other obvious pick. Vim users can still type :e (or
        // :e! on a dirty buffer — see pending-features #24 about :e's
        // current silent-refuse behavior).
        text: 'Reload from Disk',
        action: () => {
          // Wrap with confirmDiscard so a dirty buffer prompts the user
          // rather than inheriting reloadFile's no-check overwrite. This
          // sidesteps the silent-refuse pattern documented in pending-
          // features #24 for the menu-driven entry point.
          confirmDiscard(() => { void reloadFile(); });
        },
      }),
      await PredefinedMenuItem.new({ item: 'Separator' }),
      await MenuItem.new({
        text: 'Close Window',
        accelerator: 'Cmd+W',
        action: closeAction,
      }),
    ],
  });

  // --- Edit menu ---
  // All standard predefined items. macOS auto-injects AutoFill / Start
  // Dictation / Emoji & Symbols below these — we don't (and can't) add
  // those.
  const editMenu = await Submenu.new({
    text: 'Edit',
    items: [
      await PredefinedMenuItem.new({ item: 'Undo' }),
      await PredefinedMenuItem.new({ item: 'Redo' }),
      await PredefinedMenuItem.new({ item: 'Separator' }),
      await PredefinedMenuItem.new({ item: 'Cut' }),
      await PredefinedMenuItem.new({ item: 'Copy' }),
      await PredefinedMenuItem.new({ item: 'Paste' }),
      await PredefinedMenuItem.new({ item: 'SelectAll' }),
    ],
  });

  // --- View menu ---
  // Surfaces our app's display toggles and modes via the menu, with the
  // Cmd+Ctrl+letter accelerators we chose for Mac in commit c57e42e.
  // Enter/Exit Full Screen lives under Window — better conceptual fit
  // with the other window-state ops (Minimize / Zoom / Close) than with
  // these content-presentation toggles, and matches how third-party Mac
  // apps like Ghostty group their menu.
  const viewMenu = await Submenu.new({
    text: 'View',
    items: [
      await MenuItem.new({
        text: 'Toggle Vim Mode',
        accelerator: 'Cmd+Ctrl+V',
        action: toggleVim,
      }),
      await MenuItem.new({
        text: 'Toggle Titlebar',
        accelerator: 'Cmd+Ctrl+T',
        action: toggleTitlebar,
      }),
      await MenuItem.new({
        text: 'Toggle Gutter',
        accelerator: 'Cmd+Ctrl+G',
        action: toggleGutter,
      }),
      await MenuItem.new({
        text: 'Toggle Status Bar',
        accelerator: 'Cmd+Ctrl+B',
        action: toggleStatusBar,
      }),
      await PredefinedMenuItem.new({ item: 'Separator' }),
      await MenuItem.new({
        text: 'Editor Only',
        accelerator: 'Cmd+Ctrl+E',
        action: () => { setDisplayMode('editor'); },
      }),
      await MenuItem.new({
        text: 'Split',
        accelerator: 'Cmd+Ctrl+S',
        action: () => { setDisplayMode('split'); },
      }),
      await MenuItem.new({
        text: 'Preview Only',
        accelerator: 'Cmd+Ctrl+P',
        action: () => { setDisplayMode('preview'); },
      }),
      await PredefinedMenuItem.new({ item: 'Separator' }),
      await MenuItem.new({
        text: 'Sync Preview to Cursor',
        accelerator: 'Cmd+Ctrl+L',
        action: syncPreviewToCaret,
      }),
    ],
  });

  // --- Window menu ---
  // Custom Minimize, Zoom, Enter/Exit Full Screen, and Close items. The
  // predefined variants for all four hit the same root cause as the
  // original Cmd+M / Cmd+W beep: they map to NSWindow selectors
  // (performMiniaturize: / zoom: / toggleFullScreen: / performClose:)
  // that gate on style mask bits stripped by `decorations: false`.
  // Calling minimize() / toggleMaximize() / setFullscreen() / close()
  // programmatically via Tauri's JS API bypasses the gate.
  //
  // The fullscreen item is created out-of-line so the post-install
  // syncFullscreenText() helper below can update its text via
  // setText() to follow macOS convention ("Enter Full Screen" /
  // "Exit Full Screen"). No dedicated fullscreen event in Tauri 2 —
  // we hook onResized which fires after the transition completes.
  //
  // The accelerator 'Cmd+Ctrl+F' binds ⌃⌘F (canonical macOS fullscreen
  // shortcut). On modern MacBooks, macOS auto-renders this in the menu
  // as 🌐F (Globe/Fn glyph) — same binding, modern display style.
  // Both ⌃⌘F and fn+F at the keyboard trigger our action. We can't
  // bind to fn/Globe directly: muda's parser doesn't accept it, muda's
  // macOS bridge doesn't translate it, and Apple reserved the Fn key
  // for system applications in macOS 12. Three independent gates,
  // all closed.
  //
  // macOS auto-injects Move & Resize / Full Screen Tile / Remove
  // Window from Set into this menu — we don't define those.
  const fullscreenItem = await MenuItem.new({
    text: 'Enter Full Screen', // overwritten by syncFullscreenText() below
    accelerator: 'Cmd+Ctrl+F',
    action: () => { void toggleFullscreen(); },
  });

  const windowMenu = await Submenu.new({
    text: 'Window',
    items: [
      await MenuItem.new({
        text: 'Minimize',
        accelerator: 'Cmd+M',
        action: () => { void getCurrentWindow().minimize(); },
      }),
      await MenuItem.new({
        text: 'Zoom',
        action: () => { void getCurrentWindow().toggleMaximize(); },
      }),
      fullscreenItem,
      await PredefinedMenuItem.new({ item: 'Separator' }),
      await MenuItem.new({
        text: 'Close Window',
        accelerator: 'Cmd+W',
        action: closeAction,
      }),
    ],
  });

  // --- Help menu ---
  // macOS auto-injects a Search field at the top. Below it we add our
  // help-dialog opener using the same accelerator the Ctrl+Alt+H shortcut
  // uses elsewhere (Cmd+Ctrl+H on Mac after the platform-strict modifier
  // remap in c57e42e).
  const helpMenu = await Submenu.new({
    text: 'Help',
    items: [
      await MenuItem.new({
        text: 'Show Keyboard Shortcuts',
        accelerator: 'Cmd+Ctrl+H',
        action: toggleHelp,
      }),
    ],
  });

  const menu = await Menu.new({
    items: [appMenu, fileMenu, editMenu, viewMenu, windowMenu, helpMenu],
  });
  await menu.setAsAppMenu();

  // Sync the Window > Enter/Exit Full Screen menu item's text to the
  // current window state, then keep it in sync. Tauri 2 has no
  // dedicated fullscreen event; onResized fires after the macOS
  // fullscreen transition completes, which is the moment we want the
  // text to flip anyway. Listener lives for the app's lifetime — no
  // unlisten needed in this single-window app.
  const win = getCurrentWindow();
  const syncFullscreenText = async () => {
    const isFs = await win.isFullscreen();
    await fullscreenItem.setText(isFs ? 'Exit Full Screen' : 'Enter Full Screen');
  };
  await syncFullscreenText();
  await win.onResized(() => { void syncFullscreenText(); });
};
