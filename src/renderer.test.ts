// Tests for renderer.ts's pure logic: the include preprocessor (the
// attribute parsing and filtering, the recursive expansion, and the
// editor-line to flat-line map that scroll sync depends on) and the
// markdown pairing. The Tauri file APIs are stubbed — readTextFile
// reads from an in-memory file map, and the path helpers get minimal
// POSIX implementations.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/plugin-fs', () => ({ readTextFile: vi.fn() }));
vi.mock('@tauri-apps/api/path', () => ({
  basename: vi.fn((p: string) =>
    Promise.resolve(p.slice(p.lastIndexOf('/') + 1))),
  dirname: vi.fn((p: string) =>
    Promise.resolve(p.slice(0, p.lastIndexOf('/')) || '/')),
  resolve: vi.fn((...segments: string[]) => {
    const parts: string[] = [];
    for (const part of segments.join('/').split('/')) {
      if (part === '' || part === '.') continue;
      if (part === '..') parts.pop();
      else parts.push(part);
    }
    return Promise.resolve('/' + parts.join('/'));
  }),
}));

import { readTextFile } from '@tauri-apps/plugin-fs';
import {
  applyIncludeAttrs, clearAllRendererCaches, pairMarkdownBlockMap,
  parseIncludeAttrs, preprocessSource,
} from './renderer.js';

// ================= Virtual filesystem =================

const files = new Map<string, string>();

vi.mocked(readTextFile).mockImplementation((path) => {
  const content = files.get(path as string);
  if (content === undefined) {
    return Promise.reject(new Error('No such file or directory'));
  }
  return Promise.resolve(content);
});

beforeEach(() => {
  files.clear();
  // Call history would otherwise accumulate across tests; the
  // implementation stays in place, only the counts reset.
  vi.mocked(readTextFile).mockClear();
  // The include cache persists across renders by design; tests need
  // each case to see its own virtual files.
  clearAllRendererCaches();
});

// ================= Include attribute parsing =================

describe('parseIncludeAttrs', () => {
  it('returns an empty object for an empty attribute blob', () => {
    expect(parseIncludeAttrs('')).toEqual({});
  });

  it('parses comma-separated key=value pairs with trimming', () => {
    expect(parseIncludeAttrs('tag=snippet, indent=2')).toEqual({
      tag: 'snippet',
      indent: '2',
    });
  });

  it('ignores positional attributes', () => {
    expect(parseIncludeAttrs('positional,leveloffset=+1')).toEqual({
      leveloffset: '+1',
    });
  });
});

// ================= Include attribute filters =================

describe('applyIncludeAttrs', () => {
  const fiveLines = 'a\nb\nc\nd\ne';

  it('keeps a single line for lines=N', () => {
    expect(applyIncludeAttrs(fiveLines, { lines: '2' })).toBe('b');
  });

  it('keeps multiple ranges for lines=N..M;X', () => {
    expect(applyIncludeAttrs(fiveLines, { lines: '1..2;4' })).toBe('a\nb\nd');
  });

  it('treats an open-ended range as through end of file', () => {
    expect(applyIncludeAttrs(fiveLines, { lines: '4..' })).toBe('d\ne');
  });

  it('clamps ranges that run past the end of the file', () => {
    expect(applyIncludeAttrs(fiveLines, { lines: '4..99' })).toBe('d\ne');
  });

  it('skips unparseable ranges, keeping nothing if none parse', () => {
    expect(applyIncludeAttrs(fiveLines, { lines: 'x..y' })).toBe('');
  });

  const tagged = [
    'before',
    '// tag::keep[]',
    'inside one',
    'inside two',
    '// end::keep[]',
    'after',
    '// tag::other[]',
    'other content',
    '// end::other[]',
  ].join('\n');

  it('keeps only the lines inside the requested tag, stripping delimiters', () => {
    expect(applyIncludeAttrs(tagged, { tag: 'keep' }))
      .toBe('inside one\ninside two');
  });

  it('unions multiple regions for tags=', () => {
    expect(applyIncludeAttrs(tagged, { tags: 'keep;other' }))
      .toBe('inside one\ninside two\nother content');
  });

  it('keeps nothing when the requested tag never appears', () => {
    expect(applyIncludeAttrs(tagged, { tag: 'missing' })).toBe('');
  });

  it('re-indents content to exactly N spaces, leaving blank lines alone', () => {
    const indented = '    deep\n\n      deeper';
    expect(applyIncludeAttrs(indented, { indent: '2' }))
      .toBe('  deep\n\n    deeper');
  });

  it('strips the common indent entirely for indent=0', () => {
    expect(applyIncludeAttrs('  a\n   b', { indent: '0' })).toBe('a\n b');
  });
});

// ================= Include preprocessing =================

describe('preprocessSource', () => {
  it('passes include-free source through with an identity line map', async () => {
    const { source, lineMap } = await preprocessSource('one\ntwo\nthree\n', '/docs');
    expect(source).toBe('one\ntwo\nthree\n');
    expect(lineMap).toEqual([1, 2, 3]);
  });

  it('preserves the absence of a trailing newline', async () => {
    const { source } = await preprocessSource('one\ntwo', '/docs');
    expect(source).toBe('one\ntwo');
  });

  it('inlines an include and maps lines around it', async () => {
    files.set('/docs/inc.adoc', 'first\nsecond');
    const root = 'title\ninclude::inc.adoc[]\ntail';
    const { source, lineMap } = await preprocessSource(root, '/docs');
    expect(source).toBe('title\nfirst\nsecond\ntail');
    // The include line maps to the first expanded line, so syncing on
    // the directive jumps to the top of the included content.
    expect(lineMap).toEqual([1, 2, 4]);
  });

  it('resolves nested includes against the including file, not the root', async () => {
    files.set('/docs/sub/a.adoc', 'a top\ninclude::b.adoc[]');
    files.set('/docs/sub/b.adoc', 'b content');
    const { source } = await preprocessSource('include::sub/a.adoc[]', '/docs');
    expect(source).toBe('a top\nb content');
  });

  it('applies attribute filters on the way through', async () => {
    files.set('/docs/inc.adoc', 'a\nb\nc\nd');
    const { source } = await preprocessSource('include::inc.adoc[lines=2..3]', '/docs');
    expect(source).toBe('b\nc');
  });

  it('wraps leveloffset includes in offset directives and maps past them', async () => {
    files.set('/docs/ch.adoc', 'X');
    const root = 'include::ch.adoc[leveloffset=+1]\ntail';
    const { source, lineMap } = await preprocessSource(root, '/docs');
    expect(source).toBe('\n:leveloffset: +1\n\nX\n\n:leveloffset: -1\ntail');
    expect(lineMap).toEqual([1, 7]);
  });

  it('replaces a missing file with a visible placeholder line', async () => {
    const root = 'include::missing.adoc[]\ntail';
    const { source, lineMap } = await preprocessSource(root, '/docs');
    expect(source).toBe(
      '// Unresolved include: missing.adoc (No such file or directory)\ntail',
    );
    expect(lineMap).toEqual([1, 2]);
  });

  it('breaks include cycles with a placeholder instead of recursing forever', async () => {
    files.set('/docs/a.adoc', 'in a\ninclude::b.adoc[]');
    files.set('/docs/b.adoc', 'in b\ninclude::a.adoc[]');
    const { source } = await preprocessSource('include::a.adoc[]', '/docs');
    expect(source).toBe('in a\nin b\n// Unresolved include (cycle): a.adoc');
  });

  it('collapses an empty include without disturbing the line map', async () => {
    files.set('/docs/empty.adoc', '');
    const root = 'a\ninclude::empty.adoc[]\nb';
    const { source, lineMap } = await preprocessSource(root, '/docs');
    expect(source).toBe('a\nb');
    expect(lineMap).toEqual([1, 2, 2]);
  });

  it('reads each include target once and serves repeats from the cache', async () => {
    files.set('/docs/inc.adoc', 'cached');
    const root = 'include::inc.adoc[]\ninclude::inc.adoc[]';
    const { source } = await preprocessSource(root, '/docs');
    expect(source).toBe('cached\ncached');
    expect(vi.mocked(readTextFile)).toHaveBeenCalledTimes(1);
  });
});

// ================= Markdown block-map pairing =================

const containerWith = (count: number): Element => {
  const el = document.createElement('div');
  for (let i = 0; i < count; i++) {
    el.appendChild(document.createElement('p'));
  }
  return el;
};

describe('pairMarkdownBlockMap', () => {
  it('pairs lines to children by index', () => {
    const container = containerWith(3);
    const map = pairMarkdownBlockMap([2, 5, 9], container);
    expect(map.map((entry) => entry.line)).toEqual([2, 5, 9]);
    expect(map.map((entry) => entry.el)).toEqual([...container.children]);
  });

  it('keeps zero-line entries in place so later pairs stay aligned', () => {
    // A token with no source map contributes a 0. It still occupies
    // its slot, so the entries after it pair with the right elements.
    const container = containerWith(3);
    const map = pairMarkdownBlockMap([4, 0, 9], container);
    expect(map[1]!.line).toBe(0);
    expect(map[2]!.line).toBe(9);
    expect(map[2]!.el).toBe(container.children[2]);
  });

  it('stops at the shorter of the two lists', () => {
    expect(pairMarkdownBlockMap([1, 2, 3, 4, 5], containerWith(3)).length).toBe(3);
    expect(pairMarkdownBlockMap([1, 2], containerWith(6)).length).toBe(2);
  });
});
