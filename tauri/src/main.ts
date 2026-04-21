// ================= Main entry =================
// Top-level bootstrap. Imports all feature modules, wires init-time
// Tauri command invocations, creates the EditorView, registers the
// window-level keyboard shortcut listener and Tauri window event
// listeners (onCloseRequested, onDragDropEvent, skrivro:open-file).
//
// Init order is load-bearing — read the comments at each step before
// reordering.

// Side-effect CSS import. Vite processes this as part of the module
// graph: in dev, it serves styles.css via the dev server (transformed
// through the HMR pipeline, which causes a brief flash of unstyled
// content before the CSS is injected — a known dev-mode artifact);
// in release, Vite extracts it to a hashed external stylesheet at
// /assets/styles-<hash>.css and emits a <link rel="stylesheet"> in
// the built HTML, which is render-blocking and has no FOUC.
//
// Keeping the CSS in an external file (vs. the original inline
// <style> block) is what prevents Tauri's CSP auto-nonce injection
// from invalidating 'unsafe-inline' in style-src. CodeMirror 6's
// runtime theme injection via style-mod creates dynamic <style>
// elements at init time and relies on 'unsafe-inline' to be allowed
// — with Tauri's auto-nonce on an inline <style>, 'unsafe-inline'
// would be silently disabled per the CSP spec and CM6's theme would
// fail to apply. See commit 1e1de7b's message for the full story.
//
// We tried <link rel="stylesheet"> in the HTML head instead of this
// JS import, expecting the render-blocking <link> to prevent the dev
// flash. It didn't — the flash persisted, apparently because Vite's
// dev server transforms the link path in a way that disables the
// blocking behavior, or because the flash comes from JS init timing
// rather than CSS load order. Since neither approach fixes the dev
// flash and both produce identical release output, we reverted to
// the JS import as the idiomatic Vite pattern.
import './styles.css';

// Font Awesome 4.7.0, bundled locally. Required for Asciidoctor's
// :icons: font output — Asciidoctor's HTML converter hardcodes FA4-
// style class names (`<i class="fa fa-X">`) for every `icon:name[]`
// directive, and those classes need Font Awesome CSS + webfont loaded
// to actually display glyphs. Without this import, icon:: directives
// render as empty invisible <i> elements.
//
// FA4 specifically (not 5/6/7) because Asciidoctor's Ruby source
// hardcodes `"fa fa-#{target}"` at line 357 of lib/asciidoctor.rb,
// and modern FA versions use different class prefixes (fas, far, fab,
// fa-solid, etc.). Using FA4 matches Asciidoctor's output 1:1 with no
// shim CSS, no class rewriting, smallest bundle. See
// memory/project_asciidoctor_includes.md and asciidoctor#2535 for
// the upstream discussion.
//
// License: MIT (CSS) + SIL Open Font License 1.1 (font files).
// Both permissive and compatible with Skrivro's 0BSD source
// license. The OFL has a Reserved Font Name clause for "Font
// Awesome" — we bundle unmodified so that clause doesn't affect
// us. See memory/project_licensing.md for the full aggregation
// rationale. Bundle cost: ~240 KB (CSS ~75 KB, woff2 font ~165 KB).
import 'font-awesome/css/font-awesome.min.css';

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { readTextFile } from '@tauri-apps/plugin-fs';
import { basename } from '@tauri-apps/api/path';

import { isMac, tr, translateStaticText } from './i18n.js';
import {
  userConfig, setUserConfig,
  type LaunchInfo, type SessionState, type SkrivroConfig,
} from './config.js';
import { createEditor, editorView } from './editor.js';
import { render, scheduleRender, syncPreviewToCaret } from './preview.js';
import {
  setDirty, scheduleAutosave, openFile, saveFile, saveFileAs, newFile,
  loadFileFromPath, confirmDiscard, askConfirm,
  writeSessionState, resolveInitialDoc,
  setLaunchCwd, currentBuffer, detectFormat,
  updateTitle,
  DEFAULT_DOC,
} from './io.js';
// ui.js has top-level side effects (help dialog listeners, host-level
// keyup / focusin / focusout, attaches to #src-host). Importing it is
// what registers those listeners. The exported functions are used
// below in the keyboard shortcut handler and the init sequence.
import { installMenu } from './menu.js';
import {
  applyTitlebar, applyGutter, applyStatusBar, applyDisplayMode,
  applyMacModifierLabels, applyUserConfig,
  toggleTitlebar, toggleGutter, toggleStatusBar, toggleVim, toggleHelp,
  setDisplayMode, refreshStatus,
} from './ui.js';

// ================= Keyboard shortcuts =================
// Capture phase so we beat CM6's internal keymap + vim bindings.
//
// Primary modifier (the "this is an app shortcut" key) is platform-strict:
// on Mac it's metaKey (Cmd); on Linux/Windows it's ctrlKey. This leaves
// Ctrl+letter on Mac alone so Vim's Ctrl-based bindings (Ctrl+V for
// V-BLOCK, Ctrl+W for window commands, Ctrl+R for redo, Ctrl+D/U/F/B
// for scrolling, Ctrl+O/I for jumplist, etc.) flow through to the
// CM6 vim plugin unimpeded. On Linux/Windows, metaKey is the Super/Win
// key, which is WM-reserved and virtually never reaches userland, so
// ignoring it there is a no-op with cleaner semantics.
//
// Secondary modifier (the disambiguator for toggle/mode shortcuts) is
// also platform-strict: altKey (Alt) on Linux/Windows; ctrlKey (Ctrl)
// on Mac. Why Ctrl and not Option on Mac? macOS US/Dvorak layouts map
// Option+letter to Unicode glyphs at the layout level (Option+V → √,
// Option+T → †, Option+B → ∫, etc.), and the webview's keydown event
// reports e.key as the COMPOSED character even when Cmd is also held —
// so e.key for Cmd+Option+V is "√", not "v", and a literal letter
// match like `k === 'v'` silently fails. Verified empirically on
// macOS Dvorak. Ctrl doesn't compose, so Cmd+Ctrl+V reports e.key="v"
// cleanly. Bonus: macOS reserves several Cmd+Option+letter combos at
// the system level (Cmd+Option+D toggles Dock auto-hide, Cmd+Option+H
// hides other apps, etc.), so Option would have been a minefield even
// without the composition bug. Cmd+Ctrl has fewer system collisions
// (Cmd+Ctrl+F fullscreen, Cmd+Ctrl+Q lock screen, Cmd+Ctrl+D look up
// word, Cmd+Ctrl+Space emoji picker — none of our letters collide).
// Critically: Cmd+Ctrl+letter is a distinct chord from Vim's plain
// Ctrl+letter, so Vim's namespace stays intact.
//
// Net effect: exactly one app-shortcut chord per platform.
//   Mac:           Cmd+letter (primary), Cmd+Ctrl+letter (secondary)
//   Linux/Windows: Ctrl+letter (primary), Ctrl+Alt+letter (secondary)
window.addEventListener('keydown', (e) => {
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (!mod) return;
  const second = isMac ? e.ctrlKey : e.altKey;
  const k = (e.key || '').toLowerCase();

  // Secondary-modifier shortcuts first — so Ctrl+Alt+S / Cmd+Ctrl+S (split)
  // doesn't match plain Ctrl+S / Cmd+S (save).
  if (second && k === 'v') {
    e.preventDefault(); toggleVim();
  } else if (second && k === 'g') {
    e.preventDefault(); toggleGutter();
  } else if (second && k === 's') {
    e.preventDefault(); setDisplayMode('split');
  } else if (second && k === 'e') {
    e.preventDefault(); setDisplayMode('editor');
  } else if (second && k === 'p') {
    e.preventDefault(); setDisplayMode('preview');
  } else if (second && k === 't') {
    e.preventDefault(); toggleTitlebar();
  } else if (second && k === 'b') {
    e.preventDefault(); toggleStatusBar();
  } else if (second && k === 'l') {
    e.preventDefault(); syncPreviewToCaret();
  } else if (second && k === 'h') {
    e.preventDefault(); toggleHelp();
  }
  // Primary-only shortcuts. Save/Open/New use the primary modifier alone
  // because those are universal cross-platform conventions (Ctrl+S /
  // Cmd+S for save, Ctrl+O / Cmd+O for open, Ctrl+N / Cmd+N for new).
  // Standalone used Ctrl+Alt+O / Ctrl+Alt+N to avoid colliding with the
  // browser's own open-file and new-window shortcuts; Tauri has no such
  // collision, so we move them onto the conventional keys.
  // `void` prefix on each async-returning call: fire-and-forget is
  // the intent (the keydown handler doesn't await anything), and the
  // prefix makes that explicit for both readers and the no-floating-
  // promises lint rule.
  else if (k === 's' && e.shiftKey) {
    e.preventDefault(); void saveFileAs();
  } else if (k === 's') {
    e.preventDefault(); void saveFile();
  } else if (k === 'o') {
    e.preventDefault(); openFile();
  } else if (k === 'n') {
    e.preventDefault(); newFile();
  }
}, { capture: true });

// ================= Close handler =================
// Replaces the web version's beforeunload. When onCloseRequested is
// registered, Tauri's JS library intercepts ALL close requests and
// uses window.destroy() internally to complete the close after the
// handler finishes. This requires core:window:allow-destroy in
// capabilities — without it, destroy() silently fails and the
// window becomes uncloseable.
const appWindow = getCurrentWindow();
// `void` prefix on the listener-registration Promise: Tauri's
// onCloseRequested/onDragDropEvent/listen APIs return a Promise that
// resolves to an unlisten function. We never call unlisten (the
// listeners live for the app's lifetime), so fire-and-forget is the
// correct semantics.
void appWindow.onCloseRequested((event) => {
  if (!currentBuffer.dirty) {
    // Clean close — no-op here; the Tauri library auto-calls destroy()
    // to complete the close after the handler returns. We let io.ts's
    // clean-exit paths (saveFile, newFile, etc.) manage the autosave
    // draft; by the time a clean close happens, there shouldn't be a
    // stale draft to clear.
    return;
  }
  event.preventDefault();
  askConfirm(tr('You have unsaved changes. Discard them?'), () => {
    // "Discard" means actually discard. clearDraft is called by the
    // quitForce path in io.ts; for the close-X variant we inline it
    // by importing from io. Keep the action minimal: the window
    // destroys itself, which triggers process exit.
    void appWindow.destroy();
  });
});

// Drag-and-drop: user drops one or more files onto the Skrivro window
// from a file manager → open the first one in the editor, same flow
// as Ctrl+O would use. Ignores subsequent files (Skrivro is single-
// document). The dirty-buffer check goes through confirmDiscard just
// like openFile, so an accidental drop during unsaved work produces
// the same Discard/Cancel dialog the user is already used to.
//
// Directories or non-text files fail at readTextFile inside
// loadFileFromPath — the catch in that function logs to console and
// leaves the existing buffer untouched. No visible error to the
// user; the dropped-file just doesn't load, buffer stays as it was.
// If this becomes a frequent confusion point we could surface a
// toast or dialog, but for now the silent-on-invalid behavior
// matches how openFile handles readTextFile errors.
void appWindow.onDragDropEvent((event) => {
  if (event.payload.type !== 'drop') return;
  const paths = event.payload.paths;
  if (!paths || paths.length === 0) return;
  // paths[0] is `string | undefined` under noUncheckedIndexedAccess,
  // but the length guard above proves it's present.
  const path = paths[0]!;
  confirmDiscard(() => loadFileFromPath(path));
});

// File-association open events: on macOS, if the user does
// `open -a Skrivro foo.adoc` (or double-clicks an .adoc with Skrivro
// as handler) while Skrivro is ALREADY RUNNING, the Rust-side
// RunEvent::Opened handler fires and emits this event. We load the
// dropped file in the existing instance, same flow as drag-drop.
//
// The cold-launch case (Skrivro NOT already running when the user
// triggers the file open) is handled at init-time below by
// take_pending_opens — any paths that arrived before this listener
// was registered are picked up there. This listener handles every
// subsequent open event for the lifetime of the app.
//
// On Linux and Windows, RunEvent::Opened doesn't fire (file assoc
// there passes the file as a CLI arg which respawns the app, not
// sends an event to an existing instance). For those platforms,
// "open another file while Skrivro is running" is now routed to
// the existing window via tauri-plugin-single-instance which also
// emits this same skrivro:open-file event.
void listen('skrivro:open-file', (event) => {
  const path = event.payload;
  if (typeof path !== 'string' || !path) return;
  confirmDiscard(() => loadFileFromPath(path));
});

// ================= Init =================

// Install the macOS menu bar before any user-visible state. The menu
// only ships on Mac — Linux/Windows would render Tauri menus in-window
// (below the titlebar), which doesn't fit our borderless keyboard-first
// layout there. Custom items are needed because the default menu's
// Minimize / Close / Quit selectors don't route through our dirty-buffer
// confirm flow; see menu.ts for the full rationale.
if (isMac) {
  await installMenu();
}

applyTitlebar();
applyGutter();
applyStatusBar();
applyDisplayMode();
applyMacModifierLabels();
translateStaticText();

// Query Rust for launch-time info (CLI argument, shell CWD). If a file
// path was passed on the command line, that wins over the autosave draft.
let launchInfo: LaunchInfo = { initial_file: null, cwd: '' };
try {
  launchInfo = await invoke<LaunchInfo>('get_launch_info');
} catch (e) {
  console.error('Failed to get launch info:', e);
}
setLaunchCwd(launchInfo.cwd || '');

// Query Rust for user config file overrides. Missing / malformed /
// unreadable file is not an error — the Rust side silently returns a
// default SkrivroConfig with all fields undefined, and we fall through
// to compiled-in defaults via applyUserConfig's `if (cfg.X)` guards.
//
// applyUserConfig MUST run before the EditorView is constructed below,
// because the CM6 theme extension reads --edit-font-size and
// --editor-padding at construction time. Setting them afterwards
// would require a dispatched reconfigure.
//
// See memory/project_config_file.md for the full spec.
try {
  setUserConfig(await invoke<SkrivroConfig>('get_config'));
} catch (e) {
  console.error('Failed to get user config:', e);
  setUserConfig({});
}
applyUserConfig(userConfig);

// Determine the initial document content. Priority order:
//   1. CLI argument — always wins, even over crash recovery
//   2. OS-dispatched file open (macOS AppleEvents via RunEvent::Opened,
//      delivered to us through invoke('take_pending_opens')) — same
//      user intent as a CLI arg, just a different transport
//   3. Autosave draft — crash recovery, always wins over session restore
//   4. Session restore — only if `restore-session = true` in the user
//      config AND a prior clean exit left a non-null lastFilePath
//      AND that file exists/is readable now
//   5. Default blank buffer
//
// Drain pending OS-dispatched opens regardless of whether we'll use
// them — the list should never accumulate across launches.
let pendingOpen: string | null = null;
try {
  const pending = await invoke<string[]>('take_pending_opens');
  if (pending && pending.length > 0) {
    // `pending[0] ?? null` converts the `string | undefined` that
    // noUncheckedIndexedAccess yields into the `string | null` shape
    // pendingOpen is declared with. The length guard makes the
    // undefined branch unreachable at runtime; the ?? null is for
    // the type system.
    pendingOpen = pending[0] ?? null;
    // If more than one file was dispatched (e.g., multi-select open),
    // ignore the rest — Skrivro is single-document.
  }
} catch (e) {
  console.error('Failed to take pending opens:', e);
}

let initialDoc = DEFAULT_DOC;
let hasDraft = false;
if (launchInfo.initial_file) {
  // CLI argument wins — skip draft and session-restore entirely.
  try {
    initialDoc = await readTextFile(launchInfo.initial_file);
    currentBuffer.path = launchInfo.initial_file;
    currentBuffer.name = await basename(launchInfo.initial_file);
    currentBuffer.format = detectFormat(launchInfo.initial_file);
    // Record the CLI-opened file as the current session state,
    // so a subsequent launch without CLI args (and with
    // restore-session enabled) will pick up where this session
    // left off. Fire-and-forget — failure doesn't block launch.
    void writeSessionState(launchInfo.initial_file);
  } catch (e) {
    console.error('Failed to load file from CLI argument:', e);
    // Fall back to draft / default (skip session restore — a CLI arg
    // that failed to load is a different failure mode than a normal
    // launch, and we don't want to silently substitute a different
    // file than the user asked for).
    const r = resolveInitialDoc();
    initialDoc = r.doc;
    hasDraft = r.hasDraft;
  }
} else if (pendingOpen) {
  // OS told us to open this file (macOS `open -a Skrivro foo.adoc` or
  // double-click with Skrivro as handler). Same user intent as a CLI
  // arg; same behavior — take precedence over draft / session restore.
  try {
    initialDoc = await readTextFile(pendingOpen);
    currentBuffer.path = pendingOpen;
    currentBuffer.name = await basename(pendingOpen);
    currentBuffer.format = detectFormat(pendingOpen);
    void writeSessionState(pendingOpen);
  } catch (e) {
    console.error('Failed to load file from OS open event:', pendingOpen, e);
    const r = resolveInitialDoc();
    initialDoc = r.doc;
    hasDraft = r.hasDraft;
  }
} else {
  // No CLI arg — try draft first (crash recovery), then session
  // restore if configured, then default.
  const r = resolveInitialDoc();
  if (r.hasDraft) {
    initialDoc = r.doc;
    hasDraft = true;
  } else if (userConfig.restoreSession) {
    try {
      const state = await invoke<SessionState>('get_session_state');
      if (state && state.lastFilePath) {
        try {
          initialDoc = await readTextFile(state.lastFilePath);
          currentBuffer.path = state.lastFilePath;
          currentBuffer.name = await basename(state.lastFilePath);
          currentBuffer.format = detectFormat(state.lastFilePath);
        } catch (e) {
          // File was deleted, moved, or is unreadable. Fall through
          // to blank buffer rather than surfacing an error dialog.
          // State is intentionally NOT cleared here — if the file
          // comes back (network mount, temporary permission issue)
          // the next launch will pick it up. Next file operation
          // will overwrite state with the new current file anyway.
          console.error(
            'Session restore: failed to read',
            state.lastFilePath,
            e
          );
          initialDoc = DEFAULT_DOC;
        }
      }
    } catch (e) {
      console.error('Session restore: failed to read state:', e);
    }
  }
}

const host = document.getElementById('src-host')!;
createEditor(host, initialDoc, {
  onDocChange: () => {
    setDirty(true);
    scheduleRender();
    scheduleAutosave();
  },
  onSelectionChange: refreshStatus,
});

if (hasDraft) setDirty(true);
updateTitle();
void render();
// Non-null assertion: createEditor has just run above and assigned
// the editor.ts live binding, so editorView is guaranteed non-null
// here. strict mode's null typing doesn't track the assignment
// across module boundaries.
editorView!.focus();
