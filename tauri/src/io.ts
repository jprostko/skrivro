// ================= I/O =================
// File I/O, dirty-buffer tracking, title + filename state, autosave
// draft, session state, the vim Ex command set, and the quit-command
// helpers. Owns the current-file state (currentPath, currentName,
// dirty) as live bindings so other modules can read current state
// without needing setters.

import { open, save } from '@tauri-apps/plugin-dialog';
import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { basename, dirname, resolve, isAbsolute } from '@tauri-apps/api/path';
import { invoke } from '@tauri-apps/api/core';

import { Vim, getDoc, setDoc, editorView } from './editor.js';
import { render, clearIncludeCache, syncPreviewToCaret } from './preview.js';
import { tr } from './i18n.js';
import { refreshStatus } from './ui.js';

// ================= Constants =================

const LS_KEY       = 'adoc-editor-draft-v1';
export const DEFAULT_NAME = 'untitled.adoc';
export const DEFAULT_DOC  = '';

// ================= DOM refs =================

const nameEl           = document.getElementById('name');
// Cast confirmDlg to HTMLDialogElement so the showModal() / close()
// calls below type-check. document.getElementById returns
// HTMLElement | null, which carries neither the dialog-specific
// methods nor a non-null guarantee; the element is known to exist in
// our HTML and this module script runs after body parse, so the cast
// is safe. Other confirm-dialog refs stay as HTMLElement — they use
// only addEventListener (available on all HTMLElements) and focus()
// (available on HTMLOrSVGElement, which HTMLElement inherits).
const confirmDlg       = document.getElementById('confirmDialog') as HTMLDialogElement;
const confirmMsgEl     = document.getElementById('confirmMessage');
const confirmOkBtn     = document.getElementById('confirmOkBtn');
const confirmCancelBtn = document.getElementById('confirmCancelBtn');

// ================= Current-file state (live bindings) =================

export let currentPath = null;
export let currentName = DEFAULT_NAME;
export let dirty       = false;

// Shell CWD captured at launch time, used as a fallback for relative
// :w / :e arguments when no file is currently open. Set by main.js
// via setLaunchCwd after invoke('get_launch_info').
export let launchCwd = '';
export const setLaunchCwd = (cwd) => { launchCwd = cwd; };

// Setters used by main.js's launch path — avoid exposing raw reassignment.
export const setCurrentPath = (p) => { currentPath = p; };
export const setCurrentName = (n) => { currentName = n; };

// ================= Title / dirty =================

export const updateTitle = () => {
  nameEl.textContent = currentName;
  document.body.classList.toggle('is-dirty', dirty);
  const title = `${dirty ? '● ' : ''}${currentName} — Skrivro`;
  document.title = title;
  // Tauri 2 does not auto-sync document.title to the native window
  // title, unlike browsers. We have to set it explicitly.
  getCurrentWindow().setTitle(title).catch((e) => console.error('setTitle failed:', e));
  // Status bar mirrors filename + dirty indicator; refresh on any title update.
  refreshStatus();
};

export const setDirty = (d) => {
  if (dirty === d) return;
  dirty = d;
  updateTitle();
};

// ================= Autosave draft =================

let autosaveTimer = null;

export const scheduleAutosave = () => {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    // Defense in depth: if the buffer transitioned back to clean
    // (e.g., via save) between when the timer was scheduled and
    // when it fires, skip the write. clearDraft in the save path
    // already cancels pending timers, so this guard is belt-and-
    // suspenders against any future code path that clears dirty
    // without going through clearDraft.
    if (!dirty) return;
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        content: getDoc(),
        name:    currentName,
        path:    currentPath,
        ts:      Date.now(),
      }));
    } catch {}
  }, 500);
};

export const clearDraft = () => {
  // Cancel any pending autosave write. Without this, a scheduled
  // timer could fire AFTER clearDraft removes the LS entry, re-
  // writing a stale draft (e.g., user types → autosave scheduled
  // for t=500ms, user saves at t=100ms → clearDraft runs, but the
  // pending timer at t=500ms resurrects the draft).
  clearTimeout(autosaveTimer);
  autosaveTimer = null;
  try { localStorage.removeItem(LS_KEY); } catch {}
};

// Persist the "current file" state for the restore-session feature.
// Fire-and-forget: we don't await this in most callers because the
// write is small and a failure is non-fatal (next session just starts
// blank, which is what would happen without the feature anyway).
// `path` is the absolute file path, or null for an untitled buffer.
export const writeSessionState = async (path) => {
  try {
    await invoke('set_session_state', {
      state: { version: 1, lastFilePath: path }
    });
  } catch (e) {
    console.error('Failed to persist session state:', e);
  }
};

// Resolves the initial doc + name (from saved draft, or defaults).
// Side-effect: may set currentName and currentPath.
export const resolveInitialDoc = () => {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const d = JSON.parse(raw);
      if (typeof d.content === 'string' && d.content.length > 0) {
        currentName = d.name || DEFAULT_NAME;
        if (d.path) currentPath = d.path;
        return { doc: d.content, hasDraft: true };
      }
    }
  } catch {}
  return { doc: DEFAULT_DOC, hasDraft: false };
};

// ================= Confirm dialog =================

let pendingConfirmOk = null;
confirmOkBtn.addEventListener('click', () => {
  const cb = pendingConfirmOk;
  pendingConfirmOk = null;
  confirmDlg.close();
  if (cb) cb();
});
confirmCancelBtn.addEventListener('click', () => {
  pendingConfirmOk = null;
  confirmDlg.close();
});

export const askConfirm = (message, onOk) => {
  confirmMsgEl.textContent = message;
  pendingConfirmOk = onOk;
  confirmDlg.showModal();
  confirmOkBtn.focus();
};

export const confirmDiscard = (onOk) => {
  if (!dirty) { onOk(); return; }
  askConfirm(tr('You have unsaved changes. Discard them?'), onOk);
};

// ================= File ops =================

// POSIX convention: text files end in a newline. Applied at every
// write-to-disk site (not to autosave draft or render input).
const ensureTrailingNewline = (text) => text.endsWith('\n') ? text : text + '\n';

// Internal: load a file from a given absolute path into the editor.
// Does NOT guard against a dirty buffer — callers are responsible for
// running this inside a confirmDiscard wrapper if appropriate.
// Used by openFile (file-picker dialog), the drag-drop handler, and
// could be reused by future entry points like recent-files menus.
export const loadFileFromPath = async (path) => {
  try {
    const content = await readTextFile(path);
    setDoc(content);
    currentPath = path;
    currentName = await basename(path);
    setDirty(false);
    clearDraft();
    clearIncludeCache();
    writeSessionState(currentPath);
    updateTitle();
    render();
  } catch (e) {
    console.error('Failed to load file:', path, e);
  }
};

export const openFile = () => {
  confirmDiscard(async () => {
    try {
      const selected = await open({
        multiple: false,
      });
      if (!selected) return; // user cancelled
      await loadFileFromPath(selected);
    } catch (e) {
      console.error(e);
    }
  });
};

export const saveFile = async () => {
  if (!currentPath) return saveFileAs();
  try {
    await writeTextFile(currentPath, ensureTrailingNewline(getDoc()));
    setDirty(false);
    clearDraft();
  } catch (e) {
    console.error(e);
  }
};

export const saveFileAs = async () => {
  try {
    const selected = await save({
      defaultPath: currentPath || currentName,
    });
    if (!selected) return; // user cancelled
    await writeTextFile(selected, ensureTrailingNewline(getDoc()));
    currentPath = selected;
    currentName = await basename(selected);
    setDirty(false);
    clearDraft();
    writeSessionState(currentPath);
    updateTitle();
  } catch (e) {
    console.error(e);
  }
};

export const newFile = () => {
  confirmDiscard(() => {
    setDoc('');
    currentPath = null;
    currentName = DEFAULT_NAME;
    setDirty(false);
    clearDraft();
    clearIncludeCache();
    writeSessionState(null);
    updateTitle();
    render();
    // Non-null assertion safe here — newFile is user-invoked, only
    // reachable after createEditor has run.
    editorView!.focus();
    // Move cursor to end
    editorView!.dispatch({
      selection: { anchor: editorView!.state.doc.length },
    });
  });
};

export const reloadFile = async () => {
  if (!currentPath) return;
  try {
    setDoc(await readTextFile(currentPath));
    setDirty(false);
    clearDraft();
    clearIncludeCache();
    render();
  } catch (e) {
    console.error(e);
  }
};

// Vim-style path resolution for :w / :e arguments.
// - Absolute paths are returned as-is.
// - Relative paths resolve against the directory of the current file
//   (matching Vim's behavior).
// - If there is no current file, relative paths resolve against the
//   shell CWD captured at launch time (from Rust).
// - If neither is available, the raw argument is returned as a last resort.
const resolveArgPath = async (arg) => {
  if (await isAbsolute(arg)) return arg;
  if (currentPath) {
    return await resolve(await dirname(currentPath), arg);
  }
  if (launchCwd) {
    return await resolve(launchCwd, arg);
  }
  return arg;
};

// ================= Vim Ex commands =================

// Parse an Ex command's argString into a normalized { bang, arg } pair.
//
// @replit/codemirror-vim exposes the ! bang suffix to user-defined
// commands via params.argString (as a leading "!"), NOT via params.bang
// — params.bang is undefined for every command registered through
// Vim.defineEx. Naively checking params.bang silently treats every
// bang variant as the non-bang form, and naively trimming argString
// treats the leading "!" as part of the filename argument. Both
// mistakes are easy to make (I made both), so all Ex handlers that
// care about either the bang or the argument should go through this
// helper.
//
// Returns { bang: boolean, arg: string|null } where arg is the
// argument text with the leading ! stripped and whitespace trimmed,
// or null if no argument was given.
const parseExArgs = (params) => {
  let s = ((params && params.argString) || '').trim();
  const bang = s.startsWith('!');
  if (bang) s = s.slice(1).trim();
  return { bang, arg: s || null };
};

Vim.defineEx('write', 'w', async (cm, params) => {
  const { arg } = parseExArgs(params);
  // Bang has no additional effect in our :w path — vim's :w! forces
  // write to a readonly file, and Skrivro has no readonly concept.
  if (arg) {
    // :w filename / :w! filename — write the buffer's content to
    // `filename`, but do NOT change the buffer's current file. The
    // buffer stays associated with its original file, dirty flag
    // unchanged. Matches Vim semantics: `:w bar.adoc` followed by
    // `:w` still saves to the original file. Relative paths resolve
    // against the current file's directory (or the shell CWD at
    // launch if no current file).
    try {
      const targetPath = await resolveArgPath(arg);
      await writeTextFile(targetPath, ensureTrailingNewline(getDoc()));
    } catch (e) {
      console.error(e);
    }
  } else {
    // :w or :w! — save to current file
    saveFile();
  }
});

Vim.defineEx('saveas', 'sav', async (cm, params) => {
  const { arg } = parseExArgs(params);
  // Bang has no additional effect — vim's :saveas! forces overwrite
  // of an existing file, and Skrivro's writeTextFile has no such
  // refuse-if-exists check to override.
  if (arg) {
    // :saveas filename / :saveas! filename — write to the given path
    // AND rename the buffer. Future :w calls will save to this new
    // path. Matches Vim semantics: this is the buffer-renaming
    // counterpart to :w filename's pure-write. Relative paths resolve
    // the same way as :w filename.
    try {
      const targetPath = await resolveArgPath(arg);
      await writeTextFile(targetPath, ensureTrailingNewline(getDoc()));
      currentPath = targetPath;
      currentName = await basename(targetPath);
      setDirty(false);
      clearDraft();
      writeSessionState(currentPath);
      updateTitle();
    } catch (e) {
      console.error(e);
    }
  } else {
    // :saveas (no args) — non-standard: show the save dialog. Real Vim
    // errors with "Argument required" here, but a dialog is friendlier
    // for a GUI editor and matches what Ctrl+Shift+S does.
    saveFileAs();
  }
});

Vim.defineEx('edit', 'e', async (cm, params) => {
  const { bang, arg } = parseExArgs(params);
  // Refuse to discard a dirty buffer without the force bang. Applies
  // to both :e (reload current file from disk) and :e filename (open
  // a new one).
  if (dirty && !bang) return;
  if (arg) {
    // :e filename or :e! filename — open specific file by path.
    // Same vim-style path resolution as :w filename.
    try {
      const sourcePath = await resolveArgPath(arg);
      const content = await readTextFile(sourcePath);
      setDoc(content);
      currentPath = sourcePath;
      currentName = await basename(sourcePath);
      setDirty(false);
      clearDraft();
      clearIncludeCache();
      writeSessionState(currentPath);
      updateTitle();
      render();
    } catch (e) {
      console.error(e);
    }
  } else {
    // :e or :e! — reload current file from disk
    reloadFile();
  }
});

Vim.defineEx('enew', 'ene', () => {
  newFile();
});

Vim.defineEx('new', 'new', () => {
  newFile();
});

// :open / :op — non-standard, shows the native file picker dialog.
// Vim has no canonical Ex command for "show file browser"; this is
// our addition so vim-mode users don't have to leave the command line.
Vim.defineEx('open', 'op', () => {
  openFile();
});

// :syncpreview / :syncp — snap the preview to the block containing
// the editor caret's source line. Same action as Ctrl+Alt+L.
Vim.defineEx('syncpreview', 'syncp', () => {
  syncPreviewToCaret();
});

// ================= Quit commands (Tauri only) =================
//
// Clean-quit commands call getCurrentWindow().close(), which flows
// through the onCloseRequested handler below. That handler checks
// dirty state and shows the custom Catppuccin confirm dialog if
// there are unsaved changes — matching the behavior of clicking the
// window's X button, for UI consistency with the rest of Skrivro.
//
// The force variants (:q!, ZQ) call destroy() directly, bypassing
// onCloseRequested so no prompt appears. clearDraft() runs first so
// the next launch starts clean — without it, the autosave draft
// restoration would bring the "discarded" content back.
//
// :wq vs :x semantics match vim faithfully:
//   :wq ALWAYS calls saveFile(), so the filesystem mtime is bumped
//       even on an unchanged buffer (unconditional write).
//   :x  only calls saveFile() when dirty — on a clean buffer, mtime
//       is not touched. Matters for tools that watch mtime.
//
// :wq! and :x! accept the bang but have no additional effect here.
// Vim's :wq! forces write to a readonly file; Skrivro has no
// readonly concept. Vim's :x! forces write even when the buffer is
// clean, which in our context is literally what :wq does. Both
// resolve to "always write and quit" for our purposes.
//
// After saveFile() we check `dirty` to detect save failure or a
// cancelled save-as dialog: on success, saveFile() sets dirty=false;
// on error or cancel, dirty stays true. If dirty is still true we
// return without closing, so a cancelled save never drops the user
// out of the editor unexpectedly.

const quitClean = () => {
  getCurrentWindow().close();
};

const quitForce = () => {
  clearDraft();
  getCurrentWindow().destroy();
};

const quitHandler = (cm, params) => {
  if (parseExArgs(params).bang) quitForce();
  else quitClean();
};

const writeAndQuit = async () => {
  await saveFile();
  if (dirty) return; // save failed or user cancelled save-as dialog
  getCurrentWindow().close();
};

const exitIfDirty = async (cm, params) => {
  if (dirty || parseExArgs(params).bang) {
    await saveFile();
    if (dirty) return; // save failed or user cancelled save-as dialog
  }
  getCurrentWindow().close();
};

// Note on aliases: Vim.defineEx(name, shortName, handler) requires
// shortName to be a LITERAL prefix of name — the plugin throws if
// you pass e.g. ('quitall', 'qa', ...) because 'qa' is not a prefix
// of 'quitall'. Vim's own command table aliases :qa to :quitall via
// internal alias logic, but the plugin's defineEx has no such logic.
// Workaround: register each alias form as its own command with a
// valid prefix relationship (or with shortName === name for forms
// that have no shorter alias).

// :q / :quit  (plus :q! / :quit! bang variant for force-quit)
Vim.defineEx('quit', 'q', quitHandler);
// :quitall — full form, registered as a standalone command since
// 'qa' is not a prefix of 'quitall'.
Vim.defineEx('quitall', 'quitall', quitHandler);
// :qall / :qa — registered together because 'qa' IS a prefix of
// 'qall'. This is the registration that covers the common 2-letter
// muscle memory (:qa) and the 4-letter form (:qall).
Vim.defineEx('qall', 'qa', quitHandler);

// :wq (plus :wq! bang, which is a no-op — see note above)
Vim.defineEx('wq', 'wq', writeAndQuit);
// :wqall / :wqa — 'wqa' is a prefix of 'wqall', so one registration
// gives both forms.
Vim.defineEx('wqall', 'wqa', writeAndQuit);

// :x  — short form, registered as its own command because 'x' is
// not a prefix of 'exit'. Accepts the :x! bang to force save.
Vim.defineEx('x', 'x', exitIfDirty);
// :exit — full form, standalone registration (can't use 'e' as its
// short form because that would clash with the existing :edit / :e).
Vim.defineEx('exit', 'exit', exitIfDirty);
// :xit — another valid vim alias for :exit.
Vim.defineEx('xit', 'xit', exitIfDirty);
// :xall / :xa — 'xa' is a prefix of 'xall', so one registration
// gives both forms.
Vim.defineEx('xall', 'xa', exitIfDirty);

// Normal-mode mapping: gz → :syncpreview<CR>. gz is in vim's `g`
// namespace for extended commands and is unused in standard vim.
// Wrapped in try/catch because Vim.map's exact signature in
// @replit/codemirror-vim isn't documented; if it fails, the Ex
// command and Ctrl+Alt+L both still work.
try {
  Vim.map('gz', ':syncpreview<CR>', 'normal');
} catch (e) {
  console.error('Vim.map gz failed:', e);
}

// Normal mode: ZZ = :x (save if dirty, quit), ZQ = :q! (discard, quit).
// Classic vim shortcuts that correspond to the Ex commands defined
// above. Separate try/catch from the gz mapping so one failure doesn't
// silently prevent the other from registering.
try {
  Vim.map('ZZ', ':x<CR>', 'normal');
  Vim.map('ZQ', ':q!<CR>', 'normal');
} catch (e) {
  console.error('Vim.map ZZ/ZQ failed:', e);
}

// Note on visual block mode: Ctrl+V is intercepted by the webview's
// paste handler on Linux (webkit2gtk) and Windows (WebView2) before
// it reaches CM6's key handler, so Ctrl+V is unreachable as a vim
// binding on those platforms. The plugin's defaultKeymap binds both
// Ctrl+V and Ctrl+Q to V-BLOCK as a cross-platform compat measure
// (Vim itself uses Ctrl+Q on Windows, where Ctrl+V is system paste).
// On Linux/Windows, the dual binding is invisible — only Ctrl+Q
// reaches Vim — so users press Ctrl+Q.
//
// On Mac, paste is Cmd+V, so physical Ctrl+V flows through to Vim
// cleanly and both keys enter V-BLOCK. We tried Vim.unmap('<C-q>',
// 'normal') to remove the redundant Ctrl+Q binding on Mac (so
// V-BLOCK would have exactly one entry key matching the canonical
// Vim convention) — the call doesn't throw but also doesn't unbind
// the key, presumably because plugin-default bindings live outside
// the user-keymap layer that Vim.unmap operates on. The plugin's
// API isn't documented enough to know the right approach, so we
// accept the dual-binding reality on Mac and have the help dialog
// advertise both keys (the Ctrl+V kbd is marked .mac-only so it
// only shows on Mac; Linux/Windows users still see only Ctrl+Q).

// Default regex engine to Vim magic-mode translation instead of raw
// JavaScript RegExp. The plugin ships with pcre=true (shown in the
// search panel hint as "JavaScript regexp: set pcre"), which lets JS
// regex syntax pass through untranslated — an odd default for a vim
// emulator, since Vim users expect \(foo\|bar\), \<word\>, and other
// magic-mode syntax to work as written. Flipping pcre off enables
// the plugin's Vim-to-JS regex translation layer. Try/catch for the
// same reason as Vim.map above: Vim.setOption's exact API in
// @replit/codemirror-vim isn't documented.
try {
  Vim.setOption('pcre', false);
} catch (e) {
  console.error('Vim.setOption pcre failed:', e);
}
