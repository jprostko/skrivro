// ================= Offline spellcheck (main-thread client) =================
//
// JS-integrated spellcheck — NOT the browser's native `spellcheck`
// attribute, which is unreliable inside CodeMirror (the editor's
// constant DOM re-render wipes the squiggles in the Chromium / WebKit
// webview family Tauri ships on). Instead the nspell instances and all
// checking live in spellcheck-worker.ts, off the UI thread; this module
// is the main-thread client. It spawns the worker, posts the editor's
// visible text whenever it changes, and renders the misspelled ranges
// the worker returns as CodeMirror mark decorations.
//
// Why the worker: building nspell parses the 2.3 MB Swedish dictionary
// in one synchronous shot — second-scale CPU that shouldn't sit on the
// UI thread — and it's the async boundary a future Hunspell-via-WASM
// engine would want. See spellcheck-worker.ts for the engine side.
//
// Single-editor assumption: the app has one editor window, so the
// worker and its result hook are module-level singletons.

import {
  ViewPlugin,
  Decoration,
  EditorView,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import {
  RangeSetBuilder,
  StateEffect,
  StateField,
  type Extension,
} from '@codemirror/state';
import type { SpellResponse, MisspelledRange } from './spellcheck-worker.js';

// ===== Worker singleton =====

let worker: Worker | null = null;
let workerReady = false;
let readyResolvers: Array<() => void> = [];
// The active plugin instance installs its result hook here; the worker's
// message listener routes `result` messages to it. One editor → one hook.
let applyResult: ((reqId: number, ranges: MisspelledRange[]) => void) | null = null;
// The editor view spellcheck is currently attached to, so a re-check can
// be dispatched from outside the update cycle (e.g. after the custom-word
// set changes). One editor → one active view.
let activeView: EditorView | null = null;

// Lazily construct the worker. `new URL('./spellcheck-worker.ts',
// import.meta.url)` is the Vite worker pattern — recognized statically
// and emitted as its own bundle chunk (the dictionaries are separate
// `?url` assets the worker fetches, so they no longer bloat this chunk).
const getWorker = (): Worker => {
  if (worker) return worker;
  const w = new Worker(new URL('./spellcheck-worker.ts', import.meta.url), {
    type: 'module',
  });
  w.addEventListener('message', (e: MessageEvent<SpellResponse>) => {
    const msg = e.data;
    if (msg.type === 'ready') {
      workerReady = true;
      const resolvers = readyResolvers;
      readyResolvers = [];
      resolvers.forEach((resolve) => resolve());
    } else if (msg.type === 'result') {
      applyResult?.(msg.reqId, msg.ranges);
    }
  });
  w.addEventListener('error', (e: ErrorEvent) => {
    console.error('spellcheck worker error:', e.message);
  });
  worker = w;
  return w;
};

// Build (or rebuild) the dictionaries in the worker for `lang`; resolves
// once the worker signals it's ready. main.ts calls this at launch when
// spellcheck-language is configured, then dispatches spellcheckRecompute
// to kick the first check. 'off' / undefined → no-op (no worker spawned).
export const initSpellcheck = (lang: string | undefined): Promise<void> => {
  if (!lang || lang === 'off') return Promise.resolve();
  const w = getWorker();
  workerReady = false;
  const ready = new Promise<void>((resolve) => readyResolvers.push(resolve));
  w.postMessage({ type: 'init', lang });
  return ready;
};

// Kick a re-check — dispatched after the dictionaries finish loading
// (the plugin's first request runs before the worker is ready and
// no-ops). The active plugin posts the current viewport on seeing it.
export const spellcheckRecompute = StateEffect.define<null>();

// Push the custom-word list into the worker and refresh the squiggles
// against it. Called by the custom-words module on load and on every
// add/remove. No-op when the worker hasn't been created (spellcheck off).
export const setPersonalWords = (words: string[]): void => {
  if (!worker) return;
  worker.postMessage({ type: 'setPersonal', words });
  activeView?.dispatch({ effects: spellcheckRecompute.of(null) });
};

// Carries a fresh set of misspelled ranges from a worker reply into
// editor state; the decoration field rebuilds from it.
const setSpellRanges = StateEffect.define<MisspelledRange[]>();

// One mark decoration, reused for every misspelling. The squiggle itself
// is pure CSS (.cm-spell-error in styles.css), so it survives
// CodeMirror's DOM re-renders.
const misspelledMark = Decoration.mark({ class: 'cm-spell-error' });

const buildDeco = (ranges: MisspelledRange[], docLen: number): DecorationSet => {
  const builder = new RangeSetBuilder<Decoration>();
  for (const r of ranges) {
    // Guard against a range from a now-stale check landing out of bounds
    // (belt-and-suspenders; reqId staleness already drops mismatched docs).
    if (r.from >= 0 && r.to <= docLen && r.from < r.to) {
      builder.add(r.from, r.to, misspelledMark);
    }
  }
  return builder.finish();
};

// Holds the squiggle decorations. Maps them through edits so they shift
// with typing until the next worker result refreshes them, and rebuilds
// on a setSpellRanges effect.
const spellDecoField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setSpellRanges)) deco = buildDeco(e.value, tr.newDoc.length);
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// Posts the visible text to the worker on edits / scrolls / cursor moves,
// and applies whichever reply is most recent. Older replies are dropped
// by reqId: a result landing after a newer change is ignored because a
// newer request is already in flight for the current state, so the
// applied ranges always match the current document.
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
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.selectionSet ||
        update.transactions.some((tr) =>
          tr.effects.some((e) => e.is(spellcheckRecompute)),
        )
      ) {
        this.request();
      }
    }

    private request() {
      if (!workerReady || !worker) return; // dictionaries not built yet
      const { state } = this.view;
      const caret = state.selection.main.empty ? state.selection.main.head : -1;
      const pieces = this.view.visibleRanges.map(({ from, to }) => ({
        from,
        text: state.doc.sliceString(from, to),
      }));
      this.reqId += 1;
      worker.postMessage({ type: 'check', reqId: this.reqId, pieces, caret });
    }

    destroy() {
      this.destroyed = true;
      // Only relinquish the hook/view if they're still ours — a
      // compartment reconfigure may have already installed a new one's.
      if (applyResult === this.hook) applyResult = null;
      if (activeView === this.view) activeView = null;
    }
  },
);

// Field + plugin. editor.ts places this in the spellcheck compartment
// when the feature is active; swapping the compartment to [] removes
// both — the squiggles vanish and the plugin's destroy() unhooks from
// the worker (which stays alive, dictionaries intact, for the next
// toggle-on).
export const spellcheckExtension: Extension = [spellDecoField, spellcheckPlugin];
