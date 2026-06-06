// ================= Spellcheck right-click menu =================
//
// Right-click a misspelled word (a red squiggle) to add it to, or remove
// it from, the custom dictionary. A small themed popup appears at the
// cursor. Right-clicking anything else returns false from the handler, so
// the webview's native menu (copy / paste / select-all) shows untouched.
//
// The popup core (create, position, dismiss) is kept self-contained so it
// can be lifted into a generic primitive if a second right-click menu
// ever appears. (Suggestions land in this same menu in a later step.)

import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { tr } from '../i18n.js';
import { spellRangeAt, requestSuggestions } from './index.js';
import { addCustomWord, removeCustomWord, hasCustomWord } from './custom-words.js';

// Max spelling suggestions shown in the menu. Capped at 4: across 50 common
// typos the intended correction landed in the top 3 for 96% of them (ranks 4
// and 5 were empty), so a short list catches the real word without padding
// the menu with noise.
const MAX_SUGGESTIONS = 4;

let openMenu: HTMLElement | null = null;
let teardown: (() => void) | null = null;

const closeMenu = (): void => {
  teardown?.();
  teardown = null;
  openMenu?.remove();
  openMenu = null;
};

// Place the menu at the click, flipping back inside the viewport near an
// edge. The menu is position:fixed, so client coordinates map directly.
const positionMenu = (menu: HTMLElement, x: number, y: number): void => {
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  menu.style.left = `${x + w > vw ? Math.max(0, vw - w - 4) : x}px`;
  menu.style.top = `${y + h > vh ? Math.max(0, y - h) : y}px`;
};

const showMenu = (
  view: EditorView,
  x: number,
  y: number,
  word: string,
  range: { from: number; to: number } | null,
  suggestions: string[],
): void => {
  closeMenu();
  const inList = hasCustomWord(word);

  const menu = document.createElement('div');
  menu.className = 'spell-menu';
  menu.setAttribute('role', 'menu');

  // Spelling suggestions: clickable items above a separator. Clicking one
  // replaces the misspelled word's range with it in a single transaction
  // (one undo step), then closes the menu and refocuses the editor with the
  // cursor after the inserted word. Present only for a misspelled word
  // (range is set), never for the Remove case.
  if (suggestions.length && range) {
    for (const suggestion of suggestions) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'spell-menu-item';
      row.textContent = suggestion;
      row.addEventListener('click', () => {
        view.dispatch({
          changes: { from: range.from, to: range.to, insert: suggestion },
          selection: { anchor: range.from + suggestion.length },
        });
        closeMenu();
        view.focus();
      });
      menu.appendChild(row);
    }
    const separator = document.createElement('div');
    separator.className = 'spell-menu-separator';
    menu.appendChild(separator);
  }

  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'spell-menu-item';
  item.textContent = inList ? tr('Remove from dictionary') : tr('Add to dictionary');
  item.addEventListener('click', () => {
    void (inList ? removeCustomWord(word) : addCustomWord(word));
    closeMenu();
    view.focus();
  });
  menu.appendChild(item);

  document.body.appendChild(menu);
  openMenu = menu;
  positionMenu(menu, x, y);

  // Dismissal: a click outside, Escape, scroll, window blur, or resize.
  const onPointer = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) closeMenu();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      closeMenu();
      view.focus();
    }
  };
  const onDismiss = () => closeMenu();
  // Defer the outside-pointer listener so the opening right-click's own
  // mousedown doesn't immediately close the menu.
  const armPointer = window.setTimeout(
    () => document.addEventListener('mousedown', onPointer, true),
    0,
  );
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('scroll', onDismiss, true);
  window.addEventListener('blur', onDismiss);
  window.addEventListener('resize', onDismiss);
  teardown = () => {
    window.clearTimeout(armPointer);
    document.removeEventListener('mousedown', onPointer, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', onDismiss, true);
    window.removeEventListener('blur', onDismiss);
    window.removeEventListener('resize', onDismiss);
  };
};

// The extension: a contextmenu handler that opens our menu when the
// right-click lands on a squiggle, and otherwise lets the native menu
// through. editor.ts adds it to the spellcheck compartment, so it's only
// live while spellcheck is on.
export const spellMenuExtension: Extension = EditorView.domEventHandlers({
  contextmenu(event, view) {
    // Map the click to a document position. posAtCoords is reliable across
    // our webviews — it resolves fine even at fractional DPI — and the
    // lookup below reads the raw worker results, so it finds the word even
    // though its on-screen squiggle is hidden the instant the right-click
    // drops the cursor into it.
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos == null) return false;
    // Look up the raw misspelling at the click, also probing pos-1 so a
    // click on the word's trailing edge (cursor offset == range end, which
    // the half-open lookup misses) still resolves. The raw range carries
    // the worker's exact word boundaries, so the word is never cut short
    // (matters for accented / å-ä-ö words).
    const range =
      spellRangeAt(view, pos) ?? (pos > 0 ? spellRangeAt(view, pos - 1) : null);
    if (range) {
      // A misspelled word: offer "Add", with spelling suggestions above it.
      // Suggestions come from the worker (async), so suppress the native
      // menu now and open ours once they arrive. Capture the coordinates,
      // since `event` is read after the await.
      const word = view.state.sliceDoc(range.from, range.to);
      const { clientX, clientY } = event;
      event.preventDefault();
      void requestSuggestions(word).then((suggestions) => {
        showMenu(view, clientX, clientY, word, range, suggestions.slice(0, MAX_SUGGESTIONS));
      });
      return true;
    }
    // A word already in the custom list isn't squiggled (the worker accepts
    // it), so check the list directly and offer "Remove", no suggestions.
    // Any other right-click (a correctly-spelled word, or whitespace) falls
    // through to the native menu, so copy / paste / select-all keep working
    // everywhere else.
    const wordRange = view.state.wordAt(pos);
    if (wordRange) {
      const w = view.state.sliceDoc(wordRange.from, wordRange.to);
      if (hasCustomWord(w)) {
        event.preventDefault();
        showMenu(view, event.clientX, event.clientY, w, null, []);
        return true;
      }
    }
    return false;
  },
});
