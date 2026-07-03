// ================= Offline spellcheck (main-thread client) =================
//
// JS-integrated spellcheck, NOT the browser's native `spellcheck`
// attribute, which is unreliable inside CodeMirror (the editor's
// constant DOM re-render wipes the squiggles in the Chromium / WebKit
// webview family Tauri ships on). Instead the nspell instances and all
// checking live in spellcheck-worker.ts, off the UI thread, and this module
// is the main-thread client. It spawns the worker, posts the editor's
// visible text whenever it changes, and renders the misspelled ranges
// the worker returns as CodeMirror mark decorations.
//
// Why the worker: building nspell parses a multi-megabyte Swedish
// dictionary in one synchronous shot (second-scale CPU that shouldn't
// sit on the UI thread), and it's the async boundary a future
// Hunspell-via-WASM engine would want. See spellcheck-worker.ts for
// the engine side.
//
// Single-editor assumption: the app has one editor window, so the
// worker and its result hook are module-level singletons.

import {
  ViewPlugin,
  Decoration,
  EditorView,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import {
  RangeSetBuilder,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
} from "@codemirror/state";
import { invoke } from "@tauri-apps/api/core";
import type {
  SpellResponse,
  MisspelledRange,
  DictPayload,
  InitRequest,
} from "./spellcheck-worker.js";

// ===== Worker singleton =====

let worker: Worker | null = null;
let workerReady = false;
let readyResolvers: Array<() => void> = [];
// The active plugin instance installs its result hook here, and the
// worker's message listener routes `result` messages to it. One editor →
// one hook.
let applyResult: ((reqId: number, ranges: MisspelledRange[]) => void) | null = null;
// The editor view spellcheck is currently attached to, so a re-check can
// be dispatched from outside the update cycle (e.g. after the custom-word
// set changes). One editor → one active view.
let activeView: EditorView | null = null;

// Pending suggestion requests, keyed by reqId and resolved when the worker
// replies. Right-clicks are infrequent, so a plain map of resolvers is
// enough, no staleness handling needed.
let suggestReqId = 0;
const suggestResolvers = new Map<number, (suggestions: string[]) => void>();

// Lazily construct the worker. `new URL('./spellcheck-worker.ts',
// import.meta.url)` is the Vite worker pattern, recognized statically
// and emitted as its own bundle chunk (the dictionaries are separate
// `?url` assets the worker fetches, so they no longer bloat this chunk).
const getWorker = (): Worker => {
  if (worker) return worker;
  const w = new Worker(new URL("./spellcheck-worker.ts", import.meta.url), {
    type: "module",
  });
  w.addEventListener("message", (e: MessageEvent<SpellResponse>) => {
    const msg = e.data;
    if (msg.type === "ready") {
      workerReady = true;
      const resolvers = readyResolvers;
      readyResolvers = [];
      resolvers.forEach((resolve) => resolve());
    } else if (msg.type === "result") {
      applyResult?.(msg.reqId, msg.ranges);
    } else if (msg.type === "suggestions") {
      const resolve = suggestResolvers.get(msg.reqId);
      if (resolve) {
        suggestResolvers.delete(msg.reqId);
        resolve(msg.suggestions);
      }
    }
  });
  w.addEventListener("error", (e: ErrorEvent) => {
    console.error("spellcheck worker error:", e.message);
  });
  worker = w;
  return w;
};

// The resolved dictionary sources the worker should build. English is always
// available ('bundled' en-US or a user override), while Swedish is a
// user-supplied payload or absent.
export type EnSource = "bundled" | DictPayload | null;
export interface ResolvedDicts {
  en: EnSource;
  sv: DictPayload | null;
}

// Build (or rebuild) the dictionaries in the worker from already-resolved
// content, resolving once the worker signals it's ready. main.ts calls
// this at launch with the output of resolveSpellcheck, then dispatches
// spellcheckRecompute to kick the first check. Nothing to load (both null) →
// no-op, no worker spawned.
export const initSpellcheck = (dicts: ResolvedDicts): Promise<void> => {
  if (!dicts.en && !dicts.sv) return Promise.resolve();
  const w = getWorker();
  workerReady = false;
  const ready = new Promise<void>((resolve) => readyResolvers.push(resolve));
  const init: InitRequest = { type: "init", en: dicts.en, sv: dicts.sv };
  w.postMessage(init);
  return ready;
};

// Status-bar indicator state for spellcheck dictionary resolution, set by
// resolveSpellcheck and read by ui.ts. 'normal' = the configured language(s)
// loaded, while the others flag a missing user-supplied Swedish dictionary.
export type SpellcheckStatus =
  | "normal"
  | "sv-missing-off" // explicit 'sv', no dict: spellcheck off
  | "sv-missing-en-only" // 'both', no sv dict: English only
  | "sv-missing-using-en"; // auto, Swedish locale, no sv dict: English fallback

let spellcheckStatus: SpellcheckStatus = "normal";
export const getSpellcheckStatus = (): SpellcheckStatus => spellcheckStatus;

// Read a user-supplied Hunspell pair from
// <config>/dictionaries/<lang>.{aff,dic} via the Rust command. Returns
// null when the pair is absent or unreadable (a missing file, or a
// non-UTF-8 dictionary the Rust side couldn't decode).
const readUserDictionary = async (lang: string): Promise<DictPayload | null> => {
  try {
    return (await invoke<DictPayload | null>("read_user_dictionary", { lang })) ?? null;
  } catch (e) {
    console.error("[spellcheck] read user dictionary failed:", e);
    return null;
  }
};

// Resolve the configured spellcheck-language to the dictionaries the
// worker should load, reading user files from <config>/dictionaries/ and
// applying the agreed behavior table. Side effect: sets the status-bar
// indicator state. Returns null only for an explicit 'off' (hard off, no
// worker).
//
// The Rust parser maps 'auto' (the default) to None, so an unset value
// means auto: detect from navigator.language (sv* → Swedish, else
// English), independent of the UI `language` setting. English is always
// available (bundled en-US, or a user en.* override). Swedish has no
// bundled fallback, so a missing sv.* turns spellcheck off (explicit
// 'sv') or drops to English ('both', or locale-detected 'auto').
export const resolveSpellcheck = async (cfg: string | undefined): Promise<ResolvedDicts | null> => {
  if (cfg === "off") {
    spellcheckStatus = "normal";
    return null;
  }

  const swedishLocale = /^sv/i.test(navigator.language || "");
  const fromAuto = cfg == null || cfg === "auto";
  const wantEn = cfg === "en" || cfg === "both" || (fromAuto && !swedishLocale);
  const wantSv = cfg === "sv" || cfg === "both" || (fromAuto && swedishLocale);

  // Bundled-or-override English, resolved on demand (a user en.* wins).
  const enSource = async (): Promise<EnSource> => (await readUserDictionary("en")) ?? "bundled";

  if (wantSv) {
    const sv = await readUserDictionary("sv");
    if (sv) {
      // Swedish loaded. English rides along only for explicit 'both'.
      spellcheckStatus = "normal";
      return { en: wantEn ? await enSource() : null, sv };
    }
    // Swedish requested but its file is absent.
    if (cfg === "sv") {
      // Explicit Swedish only: off. Don't check Swedish text against English.
      spellcheckStatus = "sv-missing-off";
      return { en: null, sv: null };
    }
    // 'both' or auto-Swedish: fall back to English.
    spellcheckStatus = fromAuto ? "sv-missing-using-en" : "sv-missing-en-only";
    return { en: await enSource(), sv: null };
  }

  // English only (explicit 'en', or auto in a non-Swedish locale).
  spellcheckStatus = "normal";
  return { en: await enSource(), sv: null };
};

// Kick a re-check, dispatched after the dictionaries finish loading
// (the plugin's first request runs before the worker is ready and
// no-ops). The active plugin posts the current viewport on seeing it.
export const spellcheckRecompute = StateEffect.define<null>();

// Push the custom-word list into the worker and refresh the squiggles
// against it. Called by the custom-words module on load and on every
// add/remove. No-op when the worker hasn't been created (spellcheck off).
export const setPersonalWords = (words: string[]): void => {
  if (!worker) return;
  worker.postMessage({ type: "setPersonal", words });
  activeView?.dispatch({ effects: spellcheckRecompute.of(null) });
};

// Fetch ranked spelling suggestions for a misspelled word from the worker
// (one round-trip). The right-click menu calls this and caps the result for
// display. Resolves to [] when spellcheck isn't running yet.
export const requestSuggestions = (word: string): Promise<string[]> => {
  const w = worker;
  if (!w || !workerReady) return Promise.resolve([]);
  const reqId = ++suggestReqId;
  return new Promise((resolve) => {
    suggestResolvers.set(reqId, resolve);
    w.postMessage({ type: "suggest", reqId, word });
  });
};

// Carries a fresh set of misspelled ranges from a worker reply into
// editor state, and the decoration field rebuilds from it.
const setSpellRanges = StateEffect.define<MisspelledRange[]>();

// One mark decoration, reused for every misspelling. The squiggle itself
// is pure CSS (.cm-spell-error in styles.css), so it survives
// CodeMirror's DOM re-renders.
const misspelledMark = Decoration.mark({ class: "cm-spell-error" });

const buildDeco = (ranges: MisspelledRange[], docLen: number): DecorationSet => {
  const builder = new RangeSetBuilder<Decoration>();
  for (const r of ranges) {
    // Guard against a range from a now-stale check landing out of bounds
    // (belt-and-suspenders, reqId staleness already drops mismatched docs).
    if (r.from >= 0 && r.to <= docLen && r.from < r.to) {
      builder.add(r.from, r.to, misspelledMark);
    }
  }
  return builder.finish();
};

// Holds the RAW misspelled ranges from the worker: every misspelling in
// the viewport, including the word the cursor is in. Maps them through
// edits so they shift with typing until the next worker result refreshes
// them, and rebuilds on a setSpellRanges effect. Not rendered directly:
// caretSkipDisplay below derives the visible squiggles from it (dropping
// the word under the caret), and the right-click menu reads it as the
// ground truth for "is this word misspelled" regardless of what's shown.
const spellDecoField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setSpellRanges)) deco = buildDeco(e.value, tr.newDoc.length);
    }
    return deco;
  },
});

// The misspelled-word range covering `pos`, or null. The right-click menu
// uses this to act on the squiggle under the cursor. Reading the
// decoration field (rather than the DOM) gives the exact flagged range
// regardless of how the squiggle is split into spans by syntax
// highlighting.
export const spellRangeAt = (
  view: EditorView,
  pos: number,
): { from: number; to: number } | null => {
  const deco = view.state.field(spellDecoField, false);
  if (!deco) return null;
  let found: { from: number; to: number } | null = null;
  deco.between(pos, pos + 1, (from, to) => {
    if (from <= pos && pos < to) {
      found = { from, to };
      return false;
    }
    return undefined;
  });
  return found;
};

// Derive the VISIBLE squiggles from the raw field: every misspelling
// except the word the cursor sits in (or at the trailing edge of). That
// word is likely being typed or edited, so squiggling it mid-keystroke is
// noise, and it gets flagged the moment the cursor leaves. Doing the skip
// here, on the main thread, keeps the raw field complete for the
// right-click menu and costs no worker round-trip (it re-derives instantly
// as the cursor moves).
const buildDisplay = (state: EditorState): DecorationSet => {
  const raw = state.field(spellDecoField);
  const sel = state.selection.main;
  if (!sel.empty) return raw; // a real selection, not a bare caret: show all
  const caret = sel.head;
  const builder = new RangeSetBuilder<Decoration>();
  raw.between(0, state.doc.length, (from, to) => {
    if (caret > from && caret <= to) return; // skip the word under the caret
    builder.add(from, to, misspelledMark);
  });
  return builder.finish();
};

// Renders the squiggles. Rebuilds the visible set when the document
// changes, when the cursor moves (so the caret-skip follows it), or when a
// fresh worker result lands in the raw field.
const caretSkipDisplay = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDisplay(view.state);
    }

    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.selectionSet ||
        update.startState.field(spellDecoField) !== update.state.field(spellDecoField)
      ) {
        this.decorations = buildDisplay(update.state);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

// Posts the visible text to the worker on edits and scrolls, and applies
// whichever reply is most recent. Older replies are dropped by reqId: a
// result landing after a newer change is ignored because a newer request
// is already in flight for the current state, so the applied ranges always
// match the current document.
const spellcheckPlugin = ViewPlugin.fromClass(
  class {
    private reqId = 0;
    private destroyed = false;
    private readonly hook: (reqId: number, ranges: MisspelledRange[]) => void;

    constructor(private readonly view: EditorView) {
      this.hook = (reqId, ranges) => {
        if (this.destroyed || reqId !== this.reqId) return;
        this.view.dispatch({ effects: setSpellRanges.of(ranges) });
      };
      applyResult = this.hook;
      activeView = view;
      this.request();
    }

    update(update: ViewUpdate) {
      // selectionSet is intentionally absent: a cursor move doesn't need a
      // worker re-check, since the caret-skip is applied on the main thread
      // by caretSkipDisplay.
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.transactions.some((tr) => tr.effects.some((e) => e.is(spellcheckRecompute)))
      ) {
        this.request();
      }
    }

    private request() {
      if (!workerReady || !worker) return; // dictionaries not built yet
      const { state } = this.view;
      const pieces = this.view.visibleRanges.map(({ from, to }) => ({
        from,
        text: state.doc.sliceString(from, to),
      }));
      this.reqId += 1;
      worker.postMessage({ type: "check", reqId: this.reqId, pieces });
    }

    destroy() {
      this.destroyed = true;
      // Only relinquish the hook/view if they're still ours, since a
      // compartment reconfigure may have already installed a new one's.
      if (applyResult === this.hook) applyResult = null;
      if (activeView === this.view) activeView = null;
    }
  },
);

// Field + plugins. editor.ts places this in the spellcheck compartment
// when the feature is active, and swapping the compartment to [] removes
// them all: the squiggles vanish and spellcheckPlugin's destroy() unhooks
// from the worker (which stays alive, dictionaries intact, for the next
// toggle-on).
export const spellcheckExtension: Extension = [spellDecoField, spellcheckPlugin, caretSkipDisplay];
