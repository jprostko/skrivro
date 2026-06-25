// Tests for the spellcheck worker, driven through its real message
// protocol. Under happy-dom the worker's `self` is the window, so
// dispatching MessageEvents exercises the actual handler, and its
// postMessage replies come back as window message events — the same
// black-box surface the main thread sees. The dictionary `?url`
// imports resolve to asset paths; fetch is stubbed to read those
// files from disk, so the suite runs against the real vendored
// dictionaries.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  MisspelledRange, ResultResponse, SpellRequest,
} from './spellcheck-worker.js';
import { stripCompounding } from './spellcheck-worker.js';

// The module's `?url` imports resolve to server-rooted asset paths, so
// the stub maps them to the dictionary files on disk. The directory is
// found from the process working directory, which is the repo root or
// the Vite root depending on how the runner was started.
const dictDir = ['src/spellcheck/dict', 'spellcheck/dict']
  .map((dir) => resolve(process.cwd(), dir))
  .find((dir) => existsSync(dir))!;

vi.stubGlobal('fetch', (input: unknown) => {
  const url = String(input);
  const name = url.slice(url.lastIndexOf('/') + 1);
  return Promise.resolve({
    text: () => readFile(resolve(dictDir, name), 'utf-8'),
  });
});

const send = (msg: SpellRequest): void => {
  window.dispatchEvent(new MessageEvent('message', { data: msg }));
};

// Arm the reply listener before sending, since the handler runs
// synchronously on dispatch.
const request = <T>(msg: SpellRequest, matches: (data: T) => boolean): Promise<T> =>
  new Promise((resolve) => {
    const onMessage = (e: MessageEvent) => {
      const data = e.data as T;
      if (data && matches(data)) {
        window.removeEventListener('message', onMessage as EventListener);
        resolve(data);
      }
    };
    window.addEventListener('message', onMessage as EventListener);
    send(msg);
  });

let nextReqId = 1;

const check = async (
  pieces: Array<{ from: number; text: string }>,
): Promise<MisspelledRange[]> => {
  const reqId = nextReqId++;
  const reply = await request<ResultResponse>(
    { type: 'check', reqId, pieces },
    (data) => data.type === 'result' && data.reqId === reqId,
  );
  return reply.ranges;
};

const flaggedWords = async (text: string): Promise<string[]> => {
  const ranges = await check([{ from: 0, text }]);
  return ranges.map((r) => text.slice(r.from, r.to));
};

beforeAll(async () => {
  await request(
    { type: 'init', en: 'bundled', sv: null },
    (data: { type: string }) => data.type === 'ready',
  );
});

describe('check', () => {
  it('flags misspelled words at their absolute offsets', async () => {
    const ranges = await check([{ from: 100, text: 'teh cat' }]);
    expect(ranges).toEqual([{ from: 100, to: 103 }]);
  });

  it('checks every piece and returns ranges in order', async () => {
    const ranges = await check([
      { from: 0, text: 'wrold' },
      { from: 50, text: 'fine text then qqqz' },
    ]);
    expect(ranges).toEqual([
      { from: 0, to: 5 },
      { from: 65, to: 69 },
    ]);
  });

  it('accepts words with internal apostrophes', async () => {
    expect(await flaggedWords("don't and we're")).toEqual([]);
  });

  it('treats a curly apostrophe as part of one token', async () => {
    // The whole token is flagged as one range, not split at the
    // apostrophe into two fragments.
    expect(await flaggedWords('xqzv’t')).toEqual(['xqzv’t']);
  });

  it('skips letter runs adjacent to digits', async () => {
    // qqqz alone is a misspelling; against a digit it reads as an
    // identifier and stays unflagged on either side.
    expect(await flaggedWords('qqqz')).toEqual(['qqqz']);
    expect(await flaggedWords('qqqz1 2qqqz utf8')).toEqual([]);
  });

  it('ignores single-letter tokens', async () => {
    expect(await flaggedWords('q x q')).toEqual([]);
  });
});

describe('setPersonal', () => {
  it('unflags custom words in any casing and reflags on removal', async () => {
    expect(await flaggedWords('zzqx')).toEqual(['zzqx']);

    send({ type: 'setPersonal', words: ['Zzqx'] });
    expect(await flaggedWords('zzqx')).toEqual([]);
    expect(await flaggedWords('ZZQX')).toEqual([]);

    send({ type: 'setPersonal', words: [] });
    expect(await flaggedWords('zzqx')).toEqual(['zzqx']);
  });
});

// stripCompounding is Skrivro's own logic: nspell builds Hunspell's
// COMPOUNDRULE patterns without the guard rules that constrain them, so the
// raw Swedish .aff makes it accept any string. We strip the compound
// directives (including ONLYINCOMPOUND, which the DSSO dictionary mis-applies
// to everyday standalone words) before handing the .aff to nspell. The live
// Swedish behavior is validated manually against a user-supplied dictionary;
// here we pin the filter itself, which is the part that's our code.
describe('stripCompounding', () => {
  it('drops every compound directive and keeps the rest of the .aff', () => {
    const aff = [
      'SET UTF-8',
      'COMPOUNDMIN 1',
      'COMPOUNDRULE 2',
      'COMPOUNDRULE n*',
      'COMPOUNDFLAG z',
      'ONLYINCOMPOUND x',
      'SFX A Y 1',
      'SFX A 0 s .',
    ].join('\n');
    const lines = stripCompounding(aff).split('\n');
    expect(lines).toContain('SET UTF-8');
    expect(lines).toContain('SFX A Y 1');
    expect(lines).toContain('SFX A 0 s .');
    expect(lines.some((l) => /^COMPOUND/.test(l))).toBe(false);
    expect(lines.some((l) => /^ONLYINCOMPOUND/.test(l))).toBe(false);
  });
});

// A tiny synthetic Hunspell pair (no compounding) standing in for a
// user-supplied Swedish dictionary. The real DSSO dictionary is LGPL and no
// longer bundled, so the worker's user-supplied-content path is exercised
// with a controlled fixture rather than the shipped dictionary.
const userSv = { aff: 'SET UTF-8\n', dic: '3\nförälder\nbarn\npäron\n' };

describe('user-supplied Swedish dictionary', () => {
  beforeAll(async () => {
    await request(
      { type: 'init', en: null, sv: userSv },
      (data: { type: string }) => data.type === 'ready',
    );
  });

  it('accepts words from the supplied dictionary, including diacritics', async () => {
    expect(await flaggedWords('förälder barn päron')).toEqual([]);
  });

  it('flags words outside it', async () => {
    expect(await flaggedWords('thoroughly')).toEqual(['thoroughly']);
  });

  it('keeps a diacritic word as a single token', async () => {
    expect(await flaggedWords('päronx')).toEqual(['päronx']);
  });
});

describe('both languages', () => {
  beforeAll(async () => {
    await request(
      { type: 'init', en: 'bundled', sv: userSv },
      (data: { type: string }) => data.type === 'ready',
    );
  });

  it('accepts a word when either dictionary knows it', async () => {
    expect(await flaggedWords('keyboard förälder qzqzqzqz')).toEqual(['qzqzqzqz']);
  });
});
