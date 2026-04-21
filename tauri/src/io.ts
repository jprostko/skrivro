// ================= I/O =================
// File I/O, dirty-buffer tracking, title + filename state, autosave
// draft, session state, the vim Ex command set, and the quit-command
// helpers. Owns the current buffer's per-buffer state on a single
// `currentBuffer: Buffer` object. Other modules read fields directly;
// mutations use `setDirty(d)` (which also triggers updateTitle) or
// direct property assignment for path / name.

import { open, save } from '@tauri-apps/plugin-dialog';
import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { basename, dirname, resolve, isAbsolute } from '@tauri-apps/api/path';
import { invoke } from '@tauri-apps/api/core';

import { Vim, getCM, getDoc, setDoc, editorView, setEditorLanguage } from './editor.js';
import { render, syncPreviewToCaret } from './preview.js';
import { clearAllRendererCaches } from './renderer.js';
import { userConfig } from './config.js';
import { tr } from './i18n.js';
import { refreshStatus } from './ui.js';

// ================= Constants =================

const LS_KEY       = 'adoc-editor-draft-v1';
export const DEFAULT_NAME = 'untitled.adoc';
export const DEFAULT_DOC  = '';

// ================= DOM refs =================

// Non-null assertions (`!`) on every DOM query: every ID is in our
// HTML, the module script runs after body parse, so getElementById
// returning null is impossible at runtime. The `!` tells TS strict
// null checks to trust us rather than requiring defensive null
// branches at each use site.
const nameEl           = document.getElementById('name')!;
// confirmDlg additionally casts to HTMLDialogElement so showModal() /
// close() type-check (those methods are on HTMLDialogElement, not
// HTMLElement). The cast subsumes the non-null assertion.
const confirmDlg       = document.getElementById('confirmDialog') as HTMLDialogElement;
const confirmMsgEl     = document.getElementById('confirmMessage')!;
const confirmOkBtn     = document.getElementById('confirmOkBtn')!;
const confirmCancelBtn = document.getElementById('confirmCancelBtn')!;

// ================= Current buffer state =================
//
// Per-buffer state lives on a single `currentBuffer: Buffer` object
// rather than as scattered module-level `let` exports. This keeps
// per-buffer concerns (path, name, dirty, format) together so that
// adding future fields, or moving ownership to a per-window context
// if multi-window support ever lands, doesn't require rewiring
// everywhere that reads them.
//
// `currentBuffer` is exported as const, which pins the reference but
// lets callers read and mutate fields. For dirty specifically, use
// `setDirty(d)` — it also triggers updateTitle() to keep the status
// bar / title in sync. path, name, and format are plain assignments;
// by convention, format should be kept in sync with path via
// detectFormat(path) at every site that writes path.

// Markup format associated with the current buffer. Drives which
// Renderer implementation handles render + scroll-sync and which
// CM6 language extension is active in the editor.
export type Format = 'asciidoc' | 'markdown' | 'text';

export interface Buffer {
  path: string | null;
  name: string;
  dirty: boolean;
  format: Format;
}

export const currentBuffer: Buffer = {
  path: null,
  name: DEFAULT_NAME,
  dirty: false,
  format: 'asciidoc',
};

// Detect the markup format for a given path based on its file
// extension. Case-insensitive so FOO.ADOC and foo.adoc are treated
// the same. Paths without a recognized markup extension fall to
// 'text'. A null path (untitled buffer) reads userConfig.defaultFormat
// — set via the `default-format` key in skrivro.conf — and falls
// through to 'asciidoc' when unset or if the config value isn't
// one of the recognized formats. File-extension detection ALWAYS
// wins over the config default: opening foo.md is markdown
// regardless of what default-format says.
//
// Only GFM is supported under 'markdown' — other markdown flavors
// (Pandoc, MultiMarkdown, etc.) still use .md as their conventional
// extension and will render via the same GFM pipeline, which may
// produce imperfect results for flavor-specific syntax. Documented
// as a limitation rather than something we try to auto-detect.
export const detectFormat = (path: string | null): Format => {
  if (!path) {
    // userConfig.defaultFormat is validated Rust-side (accepted:
    // asciidoc / markdown / text), so anything non-null here should
    // be one of those. JS-side narrowing adds a belt-and-suspenders
    // check for any value that slipped through or was mutated
    // after parse.
    const configured = userConfig.defaultFormat;
    if (configured === 'asciidoc' || configured === 'markdown' || configured === 'text') {
      return configured;
    }
    return 'asciidoc';
  }
  const lower = path.toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown';
  if (lower.endsWith('.adoc') || lower.endsWith('.asciidoc')) return 'asciidoc';
  return 'text';
};

// Shell CWD captured at launch time, used as a fallback for relative
// :w / :e arguments when no file is currently open. Set by main.ts
// via setLaunchCwd after invoke('get_launch_info').
export let launchCwd: string = '';
export const setLaunchCwd = (cwd: string) => { launchCwd = cwd; };

// ================= Ex command panel messages =================
//
// Surfaces error/info messages to the user via the CM6 vim panel — the
// same bottom bar where the plugin itself shows errors like "Not an
// editor command :foo" and "Invalid regex". Use this anywhere we would
// otherwise console.error() silently and leave the user wondering why
// a command did nothing.
//
// Mechanism: cm.openNotification is the plugin's documented hook (see
// its .d.ts line 665). Class `cm-vim-message` matches the plugin's own
// convention so our messages and the plugin's built-in errors share
// styling; inline white-space:pre preserves any formatting in the
// message text. The plugin inlines color:red on its own notifications,
// which collides with every non-Mocha theme — styles.css overrides
// .cm-vim-message color to the theme's --skr-error slot, which also
// retheme's the plugin's own errors as a side benefit.
//
// Duration 5000ms auto-dismiss. Shorter than the plugin's own 15000ms
// default for errors because 15s is a long time to stare at a short
// message like "E37: No write since last change". Still enough time
// to read a verbose E212 with a long path. Safe to call from any code
// path; if the editor isn't ready yet we no-op silently rather than
// throw.
const vimMessage = (text: string) => {
  if (!editorView) return;
  const cm = getCM(editorView);
  if (!cm) return;
  const div = document.createElement('div');
  div.className = 'cm-vim-message';
  div.style.whiteSpace = 'pre';
  div.textContent = text;
  cm.openNotification(div, { bottom: true, duration: 5000 });
};

// Extract a human-readable message from an unknown thrown value. The
// catch blocks below hand the result to vimMessage so the user sees
// "E212: Can't open file for writing: /path (Permission denied)"
// instead of console-only [object Object] variants.
//
// Tauri's fs plugin wraps OS-level errors with a verbose
// "failed to open file at path: <path> with error: <os msg>" prefix
// (or "failed to write to file at path: ..." on writes). Since our
// Exxx: message already cites the path, that prefix is pure noise —
// stripping it leaves just the meaningful OS error, e.g.:
//
//   before: "failed to open file at path: /foo with error: No such file..."
//   after:  "No such file..."
//
// If the thrown value doesn't match that shape (non-Tauri exception,
// native JS error, etc.) the replace is a no-op and the original
// message passes through unchanged.
const TAURI_FS_PREFIX = /^failed to [^:]+: .+? with error: /;
const errMsg = (e: unknown): string => {
  const raw = e instanceof Error ? e.message : String(e);
  return raw.replace(TAURI_FS_PREFIX, '');
};

// ================= Title / dirty =================

export const updateTitle = () => {
  nameEl.textContent = currentBuffer.name;
  document.body.classList.toggle('is-dirty', currentBuffer.dirty);
  const title = `${currentBuffer.dirty ? '● ' : ''}${currentBuffer.name} — Skrivro`;
  document.title = title;
  // Tauri 2 does not auto-sync document.title to the native window
  // title, unlike browsers. We have to set it explicitly.
  getCurrentWindow().setTitle(title).catch((e) => console.error('setTitle failed:', e));
  // Status bar mirrors filename + dirty indicator; refresh on any title update.
  refreshStatus();
};

export const setDirty = (d: boolean) => {
  if (currentBuffer.dirty === d) return;
  currentBuffer.dirty = d;
  updateTitle();
};

// Canonical mutation helper for currentBuffer.format. Call this
// rather than assigning the field directly so the three side effects
// that should always follow a format change stay in one place:
//
//   1. CM6 language compartment reconfigure (via editor.ts) — swaps
//      the active syntax highlighter. Today always resolves to
//      asciidocLang, but this is where future language choices land.
//   2. Status bar refresh — the filetype slot shows the new format's
//      display name.
//   3. Preview re-render — since the renderer eventually dispatches
//      on format, the preview should reflect the new choice.
//
// No-op when the requested format equals the current one, so
// rapid repeated calls (e.g., Ex command + keyboard both hitting
// the same format) don't thrash.
export const setBufferFormat = (format: Format) => {
  if (currentBuffer.format === format) return;
  currentBuffer.format = format;
  setEditorLanguage(format);
  refreshStatus();
  void render();
};

// ================= Autosave draft =================

// `ReturnType<typeof setTimeout>` handles both DOM (number) and Node
// (Timer) environments. Our Vite+webview environment is DOM, so this
// resolves to number, but the typeof wrapper keeps the code portable
// if we ever run under different typings.
let autosaveTimer: ReturnType<typeof setTimeout> | null = null;

export const scheduleAutosave = () => {
  if (autosaveTimer !== null) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    // Defense in depth: if the buffer transitioned back to clean
    // (e.g., via save) between when the timer was scheduled and
    // when it fires, skip the write. clearDraft in the save path
    // already cancels pending timers, so this guard is belt-and-
    // suspenders against any future code path that clears dirty
    // without going through clearDraft.
    if (!currentBuffer.dirty) return;
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        content: getDoc(),
        name:    currentBuffer.name,
        path:    currentBuffer.path,
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
  if (autosaveTimer !== null) clearTimeout(autosaveTimer);
  autosaveTimer = null;
  try { localStorage.removeItem(LS_KEY); } catch {}
};

// Persist the "current file" state for the restore-session feature.
// Fire-and-forget: we don't await this in most callers because the
// write is small and a failure is non-fatal (next session just starts
// blank, which is what would happen without the feature anyway).
// `path` is the absolute file path, or null for an untitled buffer.
export const writeSessionState = async (path: string | null) => {
  try {
    await invoke('set_session_state', {
      state: { version: 1, lastFilePath: path }
    });
  } catch (e) {
    console.error('Failed to persist session state:', e);
  }
};

// Resolves the initial doc + name (from saved draft, or defaults).
// Side-effect: may set currentBuffer.name and currentBuffer.path.
export const resolveInitialDoc = () => {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const d = JSON.parse(raw);
      if (typeof d.content === 'string' && d.content.length > 0) {
        currentBuffer.name = d.name || DEFAULT_NAME;
        if (d.path) currentBuffer.path = d.path;
        currentBuffer.format = detectFormat(currentBuffer.path);
        return { doc: d.content, hasDraft: true };
      }
    }
  } catch {}
  return { doc: DEFAULT_DOC, hasDraft: false };
};

// ================= Confirm dialog =================

// Callback stashed between askConfirm and the OK-button click handler.
// Null when no confirm is pending. Typed so strict mode sees both the
// assignment site (null or function) and the invocation site (function
// after null check).
type ConfirmCallback = () => void;
let pendingConfirmOk: ConfirmCallback | null = null;
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

export const askConfirm = (message: string, onOk: ConfirmCallback) => {
  confirmMsgEl.textContent = message;
  pendingConfirmOk = onOk;
  confirmDlg.showModal();
  confirmOkBtn.focus();
};

export const confirmDiscard = (onOk: ConfirmCallback) => {
  if (!currentBuffer.dirty) { onOk(); return; }
  askConfirm(tr('You have unsaved changes. Discard them?'), onOk);
};

// ================= File ops =================

// POSIX convention: text files end in a newline. Applied at every
// write-to-disk site (not to autosave draft or render input).
const ensureTrailingNewline = (text: string) => text.endsWith('\n') ? text : text + '\n';

// Internal: load a file from a given absolute path into the editor.
// Does NOT guard against a dirty buffer — callers are responsible for
// running this inside a confirmDiscard wrapper if appropriate.
// Used by openFile (file-picker dialog), the drag-drop handler, and
// could be reused by future entry points like recent-files menus.
export const loadFileFromPath = async (path: string) => {
  try {
    const content = await readTextFile(path);
    setDoc(content);
    currentBuffer.path = path;
    currentBuffer.name = await basename(path);
    currentBuffer.format = detectFormat(path);
    setDirty(false);
    clearDraft();
    clearAllRendererCaches();
    // `void` prefix on fire-and-forget async calls: writeSessionState
    // is async (awaits invoke(...)) but failure is non-fatal and
    // handled internally; render is async but we don't need its result.
    // Prefix makes the fire-and-forget intent explicit for both readers
    // and the no-floating-promises lint rule.
    void writeSessionState(currentBuffer.path);
    updateTitle();
    void render();
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
  if (!currentBuffer.path) return saveFileAs();
  try {
    await writeTextFile(currentBuffer.path, ensureTrailingNewline(getDoc()));
    setDirty(false);
    clearDraft();
  } catch (e) {
    console.error(e);
    vimMessage(`E212: Can't open file for writing: ${currentBuffer.path} (${errMsg(e)})`);
  }
};

export const saveFileAs = async () => {
  let selected: string | null = null;
  try {
    selected = await save({
      defaultPath: currentBuffer.path || currentBuffer.name,
    });
    if (!selected) return; // user cancelled — silent, the user knows
    await writeTextFile(selected, ensureTrailingNewline(getDoc()));
    currentBuffer.path = selected;
    currentBuffer.name = await basename(selected);
    currentBuffer.format = detectFormat(selected);
    setDirty(false);
    clearDraft();
    void writeSessionState(currentBuffer.path);
    updateTitle();
  } catch (e) {
    console.error(e);
    // `selected` is captured outside the try so the message can cite
    // the target path even if the write threw after the dialog
    // resolved. If the dialog itself threw, selected is still null
    // and we fall back to a generic message.
    vimMessage(selected
      ? `E212: Can't open file for writing: ${selected} (${errMsg(e)})`
      : `E212: Can't open file for writing (${errMsg(e)})`);
  }
};

export const newFile = () => {
  confirmDiscard(() => {
    setDoc('');
    currentBuffer.path = null;
    currentBuffer.name = DEFAULT_NAME;
    currentBuffer.format = detectFormat(null);
    setDirty(false);
    clearDraft();
    clearAllRendererCaches();
    void writeSessionState(null);
    updateTitle();
    void render();
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
  if (!currentBuffer.path) return;
  try {
    setDoc(await readTextFile(currentBuffer.path));
    setDirty(false);
    clearDraft();
    clearAllRendererCaches();
    void render();
  } catch (e) {
    console.error(e);
    vimMessage(`E484: Can't open file ${currentBuffer.path} (${errMsg(e)})`);
  }
};

// Vim-style path resolution for :w / :e arguments.
// - Absolute paths are returned as-is.
// - Relative paths resolve against the directory of the current file
//   (matching Vim's behavior).
// - If there is no current file, relative paths resolve against the
//   shell CWD captured at launch time (from Rust).
// - If neither is available, the raw argument is returned as a last resort.
const resolveArgPath = async (arg: string): Promise<string> => {
  if (await isAbsolute(arg)) return arg;
  if (currentBuffer.path) {
    return await resolve(await dirname(currentBuffer.path), arg);
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
// The vim plugin calls Ex handlers with (cm, params) where params
// carries argString among other fields. The plugin's types aren't
// formally exposed, so we use `any` for cm (we never reference it)
// and a structural type for params. Broader `any` on params would
// work but loses the intent documentation that argString is the
// field we care about.
interface VimExParams {
  argString?: string;
}
const parseExArgs = (params: VimExParams) => {
  let s = ((params && params.argString) || '').trim();
  const bang = s.startsWith('!');
  if (bang) s = s.slice(1).trim();
  return { bang, arg: s || null };
};

Vim.defineEx('write', 'w', async (_cm: any, params: VimExParams) => {
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
    let targetPath: string | null = null;
    try {
      targetPath = await resolveArgPath(arg);
      await writeTextFile(targetPath, ensureTrailingNewline(getDoc()));
    } catch (e) {
      console.error(e);
      vimMessage(targetPath
        ? `E212: Can't open file for writing: ${targetPath} (${errMsg(e)})`
        : `E212: Can't open file for writing (${errMsg(e)})`);
    }
  } else {
    // :w or :w! — save to current file. Error reporting happens inside
    // saveFile / saveFileAs.
    void saveFile();
  }
});

Vim.defineEx('saveas', 'sav', async (_cm: any, params: VimExParams) => {
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
    let targetPath: string | null = null;
    try {
      targetPath = await resolveArgPath(arg);
      await writeTextFile(targetPath, ensureTrailingNewline(getDoc()));
      currentBuffer.path = targetPath;
      currentBuffer.name = await basename(targetPath);
      currentBuffer.format = detectFormat(targetPath);
      setDirty(false);
      clearDraft();
      void writeSessionState(currentBuffer.path);
      updateTitle();
    } catch (e) {
      console.error(e);
      vimMessage(targetPath
        ? `E212: Can't open file for writing: ${targetPath} (${errMsg(e)})`
        : `E212: Can't open file for writing (${errMsg(e)})`);
    }
  } else {
    // :saveas (no args) — non-standard: show the save dialog. Real Vim
    // errors with "Argument required" here, but a dialog is friendlier
    // for a GUI editor and matches what Ctrl+Shift+S does. Error
    // reporting happens inside saveFileAs.
    void saveFileAs();
  }
});

Vim.defineEx('edit', 'e', async (_cm: any, params: VimExParams) => {
  const { bang, arg } = parseExArgs(params);
  // Refuse to discard a dirty buffer without the force bang. Applies
  // to both :e (reload current file from disk) and :e filename (open
  // a new one). Match vim's exact wording — users who know the E37
  // code from vim recognise it instantly.
  if (currentBuffer.dirty && !bang) {
    vimMessage('E37: No write since last change (add ! to override)');
    return;
  }
  if (arg) {
    // :e filename or :e! filename — open specific file by path.
    // Same vim-style path resolution as :w filename.
    let sourcePath: string | null = null;
    try {
      sourcePath = await resolveArgPath(arg);
      const content = await readTextFile(sourcePath);
      setDoc(content);
      currentBuffer.path = sourcePath;
      currentBuffer.name = await basename(sourcePath);
      currentBuffer.format = detectFormat(sourcePath);
      setDirty(false);
      clearDraft();
      clearAllRendererCaches();
      void writeSessionState(currentBuffer.path);
      updateTitle();
      void render();
    } catch (e) {
      console.error(e);
      vimMessage(sourcePath
        ? `E484: Can't open file ${sourcePath} (${errMsg(e)})`
        : `E484: Can't open file (${errMsg(e)})`);
    }
  } else {
    // :e or :e! — reload current file from disk. Error reporting
    // happens inside reloadFile.
    void reloadFile();
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

// ================= Format commands =================
//
// :format (no arg) shows the current format.
// :format <name> sets the format — asciidoc / markdown / text.
// Unknown values surface an E-style error in the vim panel.
//
// :asciidoc / :markdown / :text are direct one-shot aliases so the
// user doesn't have to remember the `:format <name>` form. Each
// sets the buffer's format to the command name.

// Narrow an arbitrary string to the Format union, or null if it
// isn't one of the three accepted values. Used by :format's
// validation path.
const parseFormat = (s: string): Format | null => {
  const lower = s.toLowerCase();
  if (lower === 'asciidoc' || lower === 'markdown' || lower === 'text') {
    return lower;
  }
  return null;
};

// Human-readable name for the format, used in the :format (no arg)
// readback and in error messages. Parallels FORMAT_LABELS in ui.ts;
// duplicated here rather than imported to avoid a circular import
// (ui.ts already imports from io.ts). The set is three entries —
// keeping it in sync manually is trivial.
const FORMAT_DISPLAY_NAME: Record<Format, string> = {
  asciidoc: 'AsciiDoc',
  markdown: 'Markdown',
  text: 'Text',
};

Vim.defineEx('format', 'format', (_cm: any, params: VimExParams) => {
  const { arg } = parseExArgs(params);
  if (!arg) {
    vimMessage(`Format: ${FORMAT_DISPLAY_NAME[currentBuffer.format]}`);
    return;
  }
  const fmt = parseFormat(arg);
  if (!fmt) {
    vimMessage(`E474: Invalid format "${arg}" (expected asciidoc, markdown, or text)`);
    return;
  }
  setBufferFormat(fmt);
});

Vim.defineEx('asciidoc', 'asciidoc', () => { setBufferFormat('asciidoc'); });
Vim.defineEx('markdown', 'markdown', () => { setBufferFormat('markdown'); });
Vim.defineEx('text', 'text', () => { setBufferFormat('text'); });

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

// getCurrentWindow().close() and .destroy() return Promise<void>. We
// don't care about the result — once fired, the app is going away —
// so `void` prefix marks them fire-and-forget.
const quitClean = () => {
  void getCurrentWindow().close();
};

const quitForce = () => {
  clearDraft();
  void getCurrentWindow().destroy();
};

const quitHandler = (_cm: any, params: VimExParams) => {
  if (parseExArgs(params).bang) quitForce();
  else quitClean();
};

const writeAndQuit = async () => {
  await saveFile();
  if (currentBuffer.dirty) return; // save failed or user cancelled save-as dialog
  void getCurrentWindow().close();
};

const exitIfDirty = async (_cm: any, params: VimExParams) => {
  if (currentBuffer.dirty || parseExArgs(params).bang) {
    await saveFile();
    if (currentBuffer.dirty) return; // save failed or user cancelled save-as dialog
  }
  void getCurrentWindow().close();
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
