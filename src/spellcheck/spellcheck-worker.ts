/// <reference lib="webworker" />
// ================= Spellcheck worker =================
//
// Off-main-thread spellcheck. This worker owns the nspell instance(s)
// and the bundled dictionaries; the main thread (spellcheck/index.ts)
// posts the editor's visible text and gets back the misspelled ranges,
// which it renders as CodeMirror decorations.
//
// Two reasons it lives in a worker rather than on the UI thread:
// building nspell parses the 2.3 MB Swedish dictionary in one
// synchronous call (second-scale CPU that doesn't belong on the thread
// that has to stay responsive), and it's the async boundary a future
// Hunspell-via-WASM engine would want.
//
// Dictionaries are vendored under ./dict and emitted as standalone
// assets via Vite `?url`, then fetched at runtime (the wooorm packages
// block deep .aff/.dic imports through their `exports` field, so the
// files are vendored locally). Each language is its own asset and only
// the configured one is fetched, so an `en`-only build never loads the
// 2.3 MB Swedish dictionary. Fully offline: the assets ship inside the
// app bundle and `fetch` reads them through the app's own asset
// protocol — no network.

import nspell from 'nspell';

type NSpell = ReturnType<typeof nspell>;

// ===== Message protocol (shared with the main-thread client) =====

export interface InitRequest {
  type: 'init';
  /** 'en' | 'sv' | 'both' — already filtered (never 'off') by the caller. */
  lang: string;
}

/** One visible slice of the document: its text and its absolute start offset. */
export interface CheckPiece {
  from: number;
  text: string;
}

export interface CheckRequest {
  type: 'check';
  /** Monotonic id; the main thread applies only the most recent result. */
  reqId: number;
  pieces: CheckPiece[];
  /** Bare-caret offset, or -1 when there's a (non-empty) selection. */
  caret: number;
}

export interface SetPersonalRequest {
  type: 'setPersonal';
  /** The full custom-word list; replaces the worker's set wholesale. */
  words: string[];
}

export type SpellRequest = InitRequest | CheckRequest | SetPersonalRequest;

export interface ReadyResponse {
  type: 'ready';
}

export interface MisspelledRange {
  from: number;
  to: number;
}

export interface ResultResponse {
  type: 'result';
  reqId: number;
  ranges: MisspelledRange[];
}

export type SpellResponse = ReadyResponse | ResultResponse;

// ===== Dictionaries =====

// Loaded checkers — one for 'en' or 'sv', two for 'both'. A word is
// misspelled only if NONE of them accept it (so 'both' passes a word
// either English or Swedish knows — right for mixed-language docs).
let spellers: NSpell[] = [];

// Custom words (the user's personal dictionary), lowercased for
// case-insensitive matching. Replaced wholesale by a `setPersonal`
// message; a word in here is never flagged, in any configured language.
let personalWords = new Set<string>();

// Per-word correctness memo, cleared whenever the dictionary set changes.
// Words recur heavily across a viewport and across keystrokes, so caching
// repeat lookups makes them O(1).
const wordCache = new Map<string, boolean>();

// `?url` gives the bundled asset's URL; fetch reads its text. Same-origin
// (the worker shares the app's origin), so this resolves through the
// app's asset protocol with no network access.
const fetchText = (url: string): Promise<string> => fetch(url).then((r) => r.text());

const loadEn = async (): Promise<NSpell> => {
  const [affUrl, dicUrl] = await Promise.all([
    import('./dict/en-US.aff?url').then((m) => m.default),
    import('./dict/en-US.dic?url').then((m) => m.default),
  ]);
  const [aff, dic] = await Promise.all([fetchText(affUrl), fetchText(dicUrl)]);
  return nspell(aff, dic);
};

// nspell builds Hunspell's COMPOUNDRULE regexes but implements NONE of
// the CHECKCOMPOUND* guard rules that constrain them. The Swedish
// dictionary leans hard on compounding (COMPOUNDMIN 1 over single-
// character stems plus a `0*`-style COMPOUNDRULE), so without the guards
// nspell decomposes and accepts essentially ANY string — every word
// validates and nothing is ever flagged. We strip the compound
// directives before handing the .aff to nspell: base words and the many
// lexicalized compounds already in the 153k-entry dictionary still
// validate and garbage is correctly rejected; the cost is that novel /
// productive compounds not individually listed slip through unflagged.
// ONLYINCOMPOUND is stripped too — the dictionary mis-tags ~2,700
// headwords (1.8%) with it, including everyday standalone words like
// "fick"/"hoppar", and nspell (like real Hunspell) honors it, so keeping
// it squiggles common words. Dropping it lets genuine bound stems
// ("abborr-", "adoptiv-") validate standalone, a near-invisible false
// negative; garbage rejection comes from COMPOUNDRULE and is unaffected.
// English ships with no compound directives, so loadEn needs none of it.
const SV_COMPOUND_DIRECTIVE =
  /^(COMPOUNDMIN|COMPOUNDWORDMAX|COMPOUNDRULE|COMPOUNDFLAG|COMPOUNDBEGIN|COMPOUNDMIDDLE|COMPOUNDEND|COMPOUNDPERMITFLAG|COMPOUNDFORBIDFLAG|COMPOUNDROOT|COMPOUNDSYLLABLE|ONLYINCOMPOUND|CHECKCOMPOUND)/;

const stripCompounding = (aff: string): string =>
  aff
    .split('\n')
    .filter((line) => !SV_COMPOUND_DIRECTIVE.test(line))
    .join('\n');

const loadSv = async (): Promise<NSpell> => {
  const [affUrl, dicUrl] = await Promise.all([
    import('./dict/sv.aff?url').then((m) => m.default),
    import('./dict/sv.dic?url').then((m) => m.default),
  ]);
  const [aff, dic] = await Promise.all([fetchText(affUrl), fetchText(dicUrl)]);
  return nspell(stripCompounding(aff), dic);
};

const initSpellcheck = async (lang: string): Promise<void> => {
  wordCache.clear();
  const loaders: Array<Promise<NSpell>> = [];
  if (lang === 'en' || lang === 'both') loaders.push(loadEn());
  if (lang === 'sv' || lang === 'both') loaders.push(loadSv());
  spellers = await Promise.all(loaders);
};

// ===== Checking =====

// Word-ish token: a run of Unicode letters with optional internal
// apostrophes (covers "don't", "we're", and accented letters like
// "café" / "naïve" / Swedish "förälder"). Hyphens are NOT included, so
// "well-known" is checked as "well" and "known" separately.
const wordRe = /\p{L}[\p{L}'’]*/gu;

const isMisspelled = (word: string): boolean => {
  const cached = wordCache.get(word);
  if (cached !== undefined) return !cached;
  // Correct if it's a custom word, or ANY loaded speller accepts it.
  const ok =
    personalWords.has(word.toLowerCase()) || spellers.some((s) => s.correct(word));
  wordCache.set(word, ok);
  return !ok;
};

// Tokenize the visible pieces and return the misspelled words' absolute
// ranges, in ascending order (pieces arrive ordered and wordRe scans
// left-to-right, so the main thread can feed them straight into a
// RangeSetBuilder).
const check = (pieces: CheckPiece[], caret: number): MisspelledRange[] => {
  if (spellers.length === 0) return [];
  const ranges: MisspelledRange[] = [];
  for (const { from, text } of pieces) {
    wordRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = wordRe.exec(text)) !== null) {
      const word = m[0];
      if (!word || word.length < 2) continue;
      const localStart = m.index;
      const start = from + localStart;
      const end = start + word.length;
      // Skip the word under the caret (inside it or at its trailing edge)
      // — it's being typed. Typing any boundary moves the caret past
      // `end`, so the word gets checked on the next request.
      if (caret > start && caret <= end) continue;
      // Skip a letter-run that sits against a digit ("h1", "utf8", "v2")
      // — an identifier, not prose. Adjacency is read from this slice via
      // charAt, which returns '' past either edge, so a word at the slice
      // boundary sees no neighbour and isn't skipped — a negligible
      // difference confined to viewport edges.
      const before = text.charAt(localStart - 1);
      const after = text.charAt(localStart + word.length);
      if (/\d/.test(before) || /\d/.test(after)) continue;
      if (isMisspelled(word)) ranges.push({ from: start, to: end });
    }
  }
  return ranges;
};

// ===== Message handler =====

self.addEventListener('message', (e: MessageEvent<SpellRequest>) => {
  const msg = e.data;
  if (msg.type === 'init') {
    // Build the dictionaries, then announce readiness. A `check` that
    // somehow arrives first finds `spellers` empty and returns [].
    void initSpellcheck(msg.lang).then(() => {
      const ready: ReadyResponse = { type: 'ready' };
      self.postMessage(ready);
    });
  } else if (msg.type === 'check') {
    const result: ResultResponse = {
      type: 'result',
      reqId: msg.reqId,
      ranges: check(msg.pieces, msg.caret),
    };
    self.postMessage(result);
  } else if (msg.type === 'setPersonal') {
    // Replace the custom-word set (lowercased for case-insensitive
    // matching) and clear the memo so previously-cached words get
    // re-judged against the new set on the next check.
    personalWords = new Set(msg.words.map((w) => w.toLowerCase()));
    wordCache.clear();
  }
});
