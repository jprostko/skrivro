// Tests for the pairing half of markdown scroll sync: zipping the
// worker's per-token line list against the preview's rendered
// top-level elements. renderer.ts pulls in the Tauri file APIs at
// import time for the include preprocessor, stubbed here — pairing is
// pure numbers-and-DOM logic.
import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/plugin-fs', () => ({ readTextFile: vi.fn() }));
vi.mock('@tauri-apps/api/path', () => ({
  basename: vi.fn(), dirname: vi.fn(), resolve: vi.fn(),
}));

import { pairMarkdownBlockMap } from './renderer.js';

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
