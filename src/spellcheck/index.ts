// ================= Offline spellcheck =================
//
// JS-integrated spellcheck — NOT the browser's native `spellcheck`
// attribute. Native spellcheck is unreliable inside CodeMirror (the
// editor's constant DOM re-render wipes the squiggles in Chromium /
// WebKit, which is the whole webview family Tauri ships on), so we do
// it ourselves: `nspell` (a Hunspell-compatible checker) loads bundled
// dictionaries and tells us which words are misspelled, and we draw the
// squiggles as CodeMirror mark decorations. This is deterministic
// across every webview because it never touches the browser's speller.
//
// Dictionaries are vendored under ./dict (sourced from the wooorm
// `dictionary-en` (US) and `dictionary-sv` packages — their `exports`
// field blocks importing the raw .aff/.dic from node_modules, so we
// vendor and import the local copies with Vite `?raw`). They're loaded
// via dynamic import so Vite code-splits each language into its own
// chunk and only the configured one is fetched at runtime.

import {
  ViewPlugin,
  Decoration,
  type DecorationSet,
  type EditorView,
  type ViewUpdate,
} from '@codemirror/view';
import { RangeSetBuilder, StateEffect, type Extension } from '@codemirror/state';
import nspell from 'nspell';

type NSpell = ReturnType<typeof nspell>;

// Loaded checkers — one for 'en' or 'sv', two for 'both'. A word is
// misspelled only if NONE of them accept it (so 'both' passes a word
// that either English or Swedish knows — right for mixed-language docs).
let spellers: NSpell[] = [];

// Per-word correctness memo. Words recur heavily across a viewport and
// across keystrokes; nspell lookups are cheap but re-tokenizing and
// re-checking the whole viewport on every update adds up, so caching
// makes repeat checks O(1). Cleared whenever the dictionary set changes.
const wordCache = new Map<string, boolean>();

// Dispatched after the async dictionary load finishes, to force the
// view plugin to recompute decorations — the dictionaries weren't
// ready when the plugin first ran, so the initial pass found nothing.
export const spellcheckRecompute = StateEffect.define<null>();

// Load the bundled dictionary(ies) for the configured language and
// build the nspell instance(s). 'off' / undefined / unknown → no-op
// (spellers stays empty, so the plugin decorates nothing). Idempotent:
// safe to call again on a config change.
export const initSpellcheck = async (lang: string | undefined): Promise<void> => {
  wordCache.clear();
  const loaders: Array<Promise<NSpell>> = [];
  if (lang === 'en' || lang === 'both') loaders.push(loadEn());
  if (lang === 'sv' || lang === 'both') loaders.push(loadSv());
  spellers = await Promise.all(loaders);
};

const loadEn = async (): Promise<NSpell> => {
  const [aff, dic] = await Promise.all([
    import('./dict/en-US.aff?raw').then((m) => m.default),
    import('./dict/en-US.dic?raw').then((m) => m.default),
  ]);
  return nspell(aff, dic);
};

// nspell builds Hunspell's COMPOUNDRULE regexes but implements NONE of
// the CHECKCOMPOUND* guard rules that constrain them. The Swedish
// dictionary leans hard on compounding (COMPOUNDMIN 1 over single-
// character stems plus a `0*`-style COMPOUNDRULE), so without the
// guards nspell decomposes and accepts essentially ANY string — every
// word validates and nothing is ever flagged. We strip the compound
// directives before handing the .aff to nspell: base words and the many
// lexicalized compounds already in the 153k-entry dictionary still
// validate and garbage is correctly rejected; the cost is that novel /
// productive compounds not individually listed slip through unflagged.
// ONLYINCOMPOUND is stripped too. This dictionary applies that flag to
// ~2,700 headwords (1.8%), and the set is noisy: it tags everyday
// standalone words like "fick" (past of få) and "hoppar" (present of
// hoppa), not just genuine bound stems. nspell honors ONLYINCOMPOUND
// (so does real Hunspell), so keeping it squiggles those common words —
// the worst failure mode for a checker. Dropping it lets the genuine
// bound stems ("abborr-", "adoptiv-") validate standalone too, but
// that's a near-invisible false negative (nobody types those fragments
// alone) and garbage rejection is unaffected (that comes from
// COMPOUNDRULE). English ships with no compound directives, so loadEn
// needs none of this.
//
// (When spellcheck moves to a Web Worker, a real Hunspell-via-WASM
// engine — which does compounding correctly — becomes the natural
// upgrade. Note it would still need this ONLYINCOMPOUND override: the
// flag's mis-tagging is in the dictionary data, not in nspell.)
const SV_COMPOUND_DIRECTIVE =
  /^(COMPOUNDMIN|COMPOUNDWORDMAX|COMPOUNDRULE|COMPOUNDFLAG|COMPOUNDBEGIN|COMPOUNDMIDDLE|COMPOUNDEND|COMPOUNDPERMITFLAG|COMPOUNDFORBIDFLAG|COMPOUNDROOT|COMPOUNDSYLLABLE|ONLYINCOMPOUND|CHECKCOMPOUND)/;

const stripCompounding = (aff: string): string =>
  aff
    .split('\n')
    .filter((line) => !SV_COMPOUND_DIRECTIVE.test(line))
    .join('\n');

const loadSv = async (): Promise<NSpell> => {
  const [aff, dic] = await Promise.all([
    import('./dict/sv.aff?raw').then((m) => m.default),
    import('./dict/sv.dic?raw').then((m) => m.default),
  ]);
  return nspell(stripCompounding(aff), dic);
};

// True once at least one dictionary has finished loading.
export const spellcheckReady = (): boolean => spellers.length > 0;

// One mark decoration, reused for every misspelling. The squiggle is
// pure CSS (.cm-spell-error in styles.css).
const misspelledMark = Decoration.mark({ class: 'cm-spell-error' });

// Word-ish token: a run of Unicode letters with optional internal
// apostrophes (covers "don't", "we're", and accented letters like
// "café" / "naïve" / Swedish "förälder"). Hyphens are NOT included, so
// "well-known" is checked as "well" and "known" separately — matching
// how Hunspell treats hyphen-joined compounds.
const wordRe = /\p{L}[\p{L}'’]*/gu;

const isMisspelled = (word: string): boolean => {
  const cached = wordCache.get(word);
  if (cached !== undefined) return !cached;
  // Correct if ANY loaded speller accepts it.
  const ok = spellers.some((s) => s.correct(word));
  wordCache.set(word, ok);
  return !ok;
};

// Build the decoration set for the editor's currently-visible ranges
// only — checking the whole document on every keystroke would not
// scale, and off-screen squiggles aren't visible anyway. RangeSetBuilder
// requires ranges added in ascending order; wordRe yields matches left-
// to-right and visibleRanges are already ordered, so the order holds.
const computeDecorations = (view: EditorView): DecorationSet => {
  if (spellers.length === 0) return Decoration.none;
  const builder = new RangeSetBuilder<Decoration>();
  const { doc, selection } = view.state;
  const docLen = doc.length;
  // The word the caret is sitting in (or just after) is being actively
  // typed/edited — don't flag it mid-keystroke, the way LibreOffice et al.
  // hold off until the word is finished. Only applies to a bare caret; a
  // non-empty selection isn't "typing", so -1 disables the skip there.
  const caret = selection.main.empty ? selection.main.head : -1;
  for (const { from, to } of view.visibleRanges) {
    const text = doc.sliceString(from, to);
    wordRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = wordRe.exec(text)) !== null) {
      const word = m[0];
      if (!word || word.length < 2) continue;
      const start = from + m.index;
      const end = start + word.length;
      // Skip the word currently under the caret (caret inside it or at
      // its trailing edge) — it's being typed. Typing any boundary moves
      // the caret past `end`, so the word gets checked on the next update.
      if (caret > start && caret <= end) continue;
      // Skip tokens that sit against a digit — they're part of an
      // identifier ("h1", "utf8", "v2"), not prose, and flagging their
      // letter-run produces false-positive squiggle noise.
      const before = start > 0 ? doc.sliceString(start - 1, start) : '';
      const after = end < docLen ? doc.sliceString(end, end + 1) : '';
      if (/\d/.test(before) || /\d/.test(after)) continue;
      if (isMisspelled(word)) builder.add(start, end, misspelledMark);
    }
  }
  return builder.finish();
};

// View plugin holding the live decoration set. Recomputes on document
// change, viewport change (scroll / resize brings new lines into view),
// selection change (so a word left un-flagged because the caret was in
// it gets re-checked the moment the caret leaves, even with no edit),
// and the spellcheckRecompute effect (fired once the async dictionary
// load completes).
const spellcheckPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = computeDecorations(view);
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
        this.decorations = computeDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

// The extension placed in editor.ts's spellcheck compartment when the
// feature is active. Empty (`[]`) when off — the compartment swaps
// between this and [] for the runtime toggle.
export const spellcheckExtension: Extension = [spellcheckPlugin];
