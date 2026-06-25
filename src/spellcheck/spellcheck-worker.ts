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
// English ships bundled: its dictionary is vendored under ./dict and
// emitted as a standalone asset via Vite `?url`, then fetched at runtime
// (the wooorm package blocks deep .aff/.dic imports through its `exports`
// field, so the file is vendored locally). Swedish is NOT bundled — it,
// and any English override, are user-supplied files the main thread reads
// from the app config dir and hands in through the init message, so the
// LGPL Swedish dictionary stays out of our binary. Offline either way: the
// bundled asset ships inside the app and `fetch` reads it through the app's
// own asset protocol, and user files never leave the machine.

import nspell from 'nspell';

type NSpell = ReturnType<typeof nspell>;

// ===== Message protocol (shared with the main-thread client) =====

/** A Hunspell dictionary pair, already decoded to UTF-8 text. */
export interface DictPayload {
  aff: string;
  dic: string;
}

export interface InitRequest {
  type: 'init';
  // English source: 'bundled' loads the built-in en-US asset, a payload is
  // a user-supplied override (en_GB, en_AU, ...), null = English not active.
  en: 'bundled' | DictPayload | null;
  // Swedish source: a user-supplied payload, or null when Swedish isn't
  // active. There is no bundled Swedish fallback.
  sv: DictPayload | null;
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
}

export interface SetPersonalRequest {
  type: 'setPersonal';
  /** The full custom-word list; replaces the worker's set wholesale. */
  words: string[];
}

/** Ask for spelling suggestions for one misspelled word. */
export interface SuggestRequest {
  type: 'suggest';
  /** Pairs the reply to this request. */
  reqId: number;
  word: string;
}

export type SpellRequest =
  | InitRequest
  | CheckRequest
  | SetPersonalRequest
  | SuggestRequest;

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

/** Ranked spelling suggestions for a `suggest` request (best first). */
export interface SuggestionsResponse {
  type: 'suggestions';
  reqId: number;
  suggestions: string[];
}

export type SpellResponse = ReadyResponse | ResultResponse | SuggestionsResponse;

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

// Bundled English: fetch the vendored en-US asset. This is the only
// dictionary that ships in the binary; everything else is user-supplied.
const loadEnBundled = async (): Promise<NSpell> => {
  const [affUrl, dicUrl] = await Promise.all([
    import('./dict/en-US.aff?url').then((m) => m.default),
    import('./dict/en-US.dic?url').then((m) => m.default),
  ]);
  const [aff, dic] = await Promise.all([fetchText(affUrl), fetchText(dicUrl)]);
  return nspell(aff, dic);
};

// User-supplied English override (en_GB / en_AU / ...). Plain nspell —
// English variants ship no compound directives.
const buildEn = (d: DictPayload): NSpell => nspell(d.aff, d.dic);

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
// English carries a few compound directives too (bundled en-US and the
// en variants both do), but narrow ones for number/ordinal forms, not
// Swedish's broad single-stem compounding. They don't over-accept, so
// the English path needs no stripping (the tests confirm en-US flags
// garbage unstripped).
const SV_COMPOUND_DIRECTIVE =
  /^(COMPOUNDMIN|COMPOUNDWORDMAX|COMPOUNDRULE|COMPOUNDFLAG|COMPOUNDBEGIN|COMPOUNDMIDDLE|COMPOUNDEND|COMPOUNDPERMITFLAG|COMPOUNDFORBIDFLAG|COMPOUNDROOT|COMPOUNDSYLLABLE|ONLYINCOMPOUND|CHECKCOMPOUND)/;

export const stripCompounding = (aff: string): string =>
  aff
    .split('\n')
    .filter((line) => !SV_COMPOUND_DIRECTIVE.test(line))
    .join('\n');

// User-supplied Swedish. Always routed through stripCompounding: whether
// it's the DSSO dictionary we point users at or another sv variant, nspell's
// partial compound support would otherwise accept essentially any string.
const buildSv = (d: DictPayload): NSpell => nspell(stripCompounding(d.aff), d.dic);

const initSpellcheck = async (req: InitRequest): Promise<void> => {
  wordCache.clear();
  // English first so its suggestions rank ahead of Swedish for `both`.
  const tasks: Array<Promise<NSpell>> = [];
  if (req.en === 'bundled') tasks.push(loadEnBundled());
  else if (req.en) tasks.push(Promise.resolve(buildEn(req.en)));
  if (req.sv) tasks.push(Promise.resolve(buildSv(req.sv)));
  spellers = await Promise.all(tasks);
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
const check = (pieces: CheckPiece[]): MisspelledRange[] => {
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
      // The caret-skip (hiding the word being typed) is a display concern,
      // handled in spellcheck/index.ts. This worker flags every misspelling
      // so the right-click menu can read the full set.
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

// Ranked spelling suggestions for a misspelled word, merged across the
// loaded languages in nspell's own order (best guess first) and deduped
// case-insensitively. nspell already case-matches the input, so a
// capitalized typo yields capitalized suggestions. The display layer caps
// the count.
const suggestFor = (word: string): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const speller of spellers) {
    for (const suggestion of speller.suggest(word)) {
      const key = suggestion.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        out.push(suggestion);
      }
    }
  }
  return out;
};

self.addEventListener('message', (e: MessageEvent<SpellRequest>) => {
  const msg = e.data;
  if (msg.type === 'init') {
    // Build the dictionaries, then announce readiness. A `check` that
    // somehow arrives first finds `spellers` empty and returns [].
    void initSpellcheck(msg).then(() => {
      const ready: ReadyResponse = { type: 'ready' };
      self.postMessage(ready);
    });
  } else if (msg.type === 'check') {
    const result: ResultResponse = {
      type: 'result',
      reqId: msg.reqId,
      ranges: check(msg.pieces),
    };
    self.postMessage(result);
  } else if (msg.type === 'setPersonal') {
    // Replace the custom-word set (lowercased for case-insensitive
    // matching) and clear the memo so previously-cached words get
    // re-judged against the new set on the next check.
    personalWords = new Set(msg.words.map((w) => w.toLowerCase()));
    wordCache.clear();
  } else if (msg.type === 'suggest') {
    const result: SuggestionsResponse = {
      type: 'suggestions',
      reqId: msg.reqId,
      suggestions: suggestFor(msg.word),
    };
    self.postMessage(result);
  }
});
