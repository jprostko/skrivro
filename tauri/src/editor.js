// ================= Editor =================
// CM6 editor setup, AsciiDoc stream highlighter, Catppuccin theme +
// highlight style, and vim compartment. Exports:
//   - editorView (live binding, null until createEditor runs)
//   - vimCompartment (for runtime reconfiguration via toggleVim)
//   - getDoc / setDoc (document read/write helpers)
//   - createEditor(parent, callbacks) — constructs the EditorView
//   - getCM re-export — used by status bar for reading vim mode state

import { EditorState, Compartment } from '@codemirror/state';
import {
  EditorView, keymap,
  lineNumbers, highlightActiveLine, highlightActiveLineGutter,
  drawSelection,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import {
  indentOnInput, bracketMatching, syntaxHighlighting,
  HighlightStyle, defaultHighlightStyle, StreamLanguage,
} from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { vim, Vim, getCM } from '@replit/codemirror-vim';

import { prefs } from './prefs.js';

// Re-exports used by other modules (io for Vim.defineEx, ui for getCM).
export { Vim, getCM };

// Live binding — assigned by createEditor, read by every other module.
export let editorView = null;

// Guards programmatic setDoc dispatches from triggering the
// updateListener's dirty/render/autosave chain. Flipped true inside
// setDoc, cleared in its finally.
let suppressDocEvents = false;

export const getDoc = () => editorView ? editorView.state.doc.toString() : '';

export const setDoc = (text) => {
  suppressDocEvents = true;
  try {
    editorView.dispatch({
      changes: { from: 0, to: editorView.state.doc.length, insert: text },
      selection: { anchor: 0 },
    });
  } finally {
    suppressDocEvents = false;
  }
};

// ================= Catppuccin Mocha editor theme =================

const catppuccinTheme = EditorView.theme({
  '&': {
    color: 'var(--skr-text)',
    backgroundColor: 'var(--skr-bg)',
    height: '100%',
    fontSize: 'var(--edit-font-size)',
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono)',
    lineHeight: '1.6',
    scrollbarColor: 'var(--skr-surface-hover) var(--skr-bg)',
    scrollbarWidth: 'thin',
  },
  // CM6 splits editor padding across two elements. .cm-content is
  // the whole content block, so vertical padding (top above the
  // first line, bottom below the last) belongs there. .cm-line is
  // each individual text line, so horizontal padding belongs there
  // — CM6 uses per-line horizontal padding so that clicking near
  // the far left edge of a line still lands ON the line, rather
  // than outside the click target. padding-block and padding-inline
  // are CSS logical properties that each accept 1 or 2 values, so
  // --editor-padding-x and --editor-padding-y can hold either
  // "2.5rem" (uniform) or "2.5rem 3rem" (asymmetric start/end) and
  // drop straight in.
  '.cm-content': {
    caretColor: 'var(--skr-cursor)',
    paddingBlock: 'var(--editor-padding-y)',
    paddingInline: '0',
  },
  '.cm-line': {
    paddingBlock: '0',
    paddingInline: 'var(--editor-padding-x)',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--skr-cursor)',
    borderLeftWidth: '2px',
  },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--skr-surface-hover)',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--skr-bg)',
    color: 'var(--skr-text-faint)',
    border: 'none',
  },
  '.cm-gutterElement': {
    padding: '0 0.5rem 0 1rem',
    minWidth: '2.5rem',
  },
  '.cm-activeLine': { backgroundColor: 'var(--skr-bg-active-line)' },
  '.cm-activeLineGutter': {
    backgroundColor: 'transparent',
    color: 'var(--skr-text-muted)',
  },
  '.cm-scroller::-webkit-scrollbar': { width: '10px', height: '10px' },
  '.cm-scroller::-webkit-scrollbar-track': { background: 'var(--skr-bg)' },
  '.cm-scroller::-webkit-scrollbar-thumb': {
    background: 'var(--skr-surface-hover)',
    borderRadius: '5px',
    border: '2px solid var(--skr-bg)',
  },
  '.cm-scroller::-webkit-scrollbar-thumb:hover': { background: 'var(--skr-surface-hover)' },
  // Vim block cursor
  '.cm-fat-cursor': {
    background: 'var(--skr-cursor)',
    outline: 'none',
    border: 'none',
  },
  '&:not(.cm-focused) .cm-fat-cursor': {
    background: 'transparent',
    outline: 'solid 1px var(--skr-cursor)',
  },
  // Vim Ex command / search panel at the bottom of the editor.
  // Without these, CM6's built-in dark base theme provides a neutral
  // gray strip and the <input> falls back to the UA's black-on-white
  // field defaults (UA input styling does not inherit from the parent).
  '.cm-panels': {
    backgroundColor: 'var(--skr-bg-panel)',
    color: 'var(--skr-text)',
  },
  '.cm-panels.cm-panels-bottom': {
    borderTop: '1px solid var(--skr-surface)',
  },
  // CM6 (or @replit/codemirror-vim's .cm-vim-panel class) sets 10px
  // of horizontal padding on .cm-panel. The right side shows as a
  // dark sliver in :open and similar Ex-command panels because
  // nothing lives there — the PCRE-hint slot is a separate flex
  // sibling that only exists in search mode. Zero the right padding
  // so the input reaches the panel edge; 10px on the left stays so
  // the : prefix has breathing room.
  '.cm-panel': {
    paddingRight: '0',
  },
  '.cm-panel input, .cm-textfield': {
    backgroundColor: 'var(--skr-surface)',
    color: 'var(--skr-text)',
    border: 'none',
    outline: 'none',
    fontFamily: 'var(--font-mono)',
    padding: '2px 6px',
  },
  // Hide the "(JavaScript regexp: set pcre)" / "(Vim regexp: set nopcre)"
  // hint that @replit/codemirror-vim renders next to the search input.
  // makePrompt() in vim.js builds it as a <span style="color:#888"> that
  // sits as the second flex child of the outer panel div (the first child
  // is the prefix + input span). Adjacent sibling combinator matches only
  // when a second span exists — Ex command panels have only one span
  // child (desc is undefined), so those are untouched. The hint is
  // informational but repetitive; since we already default pcre to false
  // at init, users rarely need to toggle, and the label is clutter in
  // an otherwise clean command bar.
  '.cm-panel span + span': {
    display: 'none',
  },
}, { dark: true });

// ================= Catppuccin highlight style =================

const catppuccinHighlight = HighlightStyle.define([
  { tag: t.heading1, color: 'var(--skr-accent)', fontWeight: 'bold', fontSize: '1.5em' },
  { tag: t.heading2, color: 'var(--skr-accent)', fontWeight: 'bold', fontSize: '1.3em' },
  { tag: t.heading3, color: 'var(--skr-accent-alt)',    fontWeight: 'bold', fontSize: '1.15em' },
  { tag: t.heading4, color: 'var(--skr-accent-alt)',    fontWeight: 'bold' },
  { tag: t.heading5, color: 'var(--skr-accent-minor)',     fontWeight: 'bold' },
  { tag: t.heading6, color: 'var(--skr-accent-minor)',     fontWeight: 'bold' },
  { tag: t.strong,        color: 'var(--skr-text)',    fontWeight: 'bold' },
  { tag: t.emphasis,      color: 'var(--skr-text)',    fontStyle: 'italic' },
  { tag: t.link,          color: 'var(--skr-link)',    textDecoration: 'underline' },
  { tag: t.monospace,     color: 'var(--skr-emphasis)' },
  { tag: t.comment,       color: 'var(--skr-text-faint)', fontStyle: 'italic' },
  { tag: t.list,          color: 'var(--skr-emphasis)' },
  { tag: t.attributeName, color: 'var(--skr-warning)' },
  { tag: t.punctuation,   color: 'var(--skr-text-faint)' },
]);

// ================= Minimal AsciiDoc stream highlighter =================
// Not a full parser — just enough to color what you'll actually see:
// headings, attributes, comments, lists, block titles, listing blocks,
// and inline emphasis/code/links.
const asciidocLang = StreamLanguage.define({
  name: 'asciidoc',
  startState: () => ({ listing: false }),
  token(stream, state) {
    // Inside a ---- listing block, the whole line is monospace
    // until we see a closing ----.
    if (state.listing) {
      if (stream.sol() && stream.match(/-{4,}\s*$/)) {
        state.listing = false;
        return 'punctuation';
      }
      stream.skipToEnd();
      return 'monospace';
    }

    if (stream.sol()) {
      // Open listing block
      if (stream.match(/-{4,}\s*$/)) {
        state.listing = true;
        return 'punctuation';
      }
      // Line comment
      if (stream.match(/\/\/.*$/)) return 'comment';
      // Heading: 1..6 leading '=' followed by space + content
      const h = stream.match(/(={1,6})\s+/);
      if (h) {
        stream.skipToEnd();
        return 'heading' + h[1].length;
      }
      // Document / block attribute entry: :name: value
      if (stream.match(/:[\w-]+:/)) {
        stream.skipToEnd();
        return 'attributeName';
      }
      // Block title: .Some title
      if (stream.match(/\.[A-Za-z].*$/)) {
        return 'emphasis';
      }
      // Unordered list markers: *, **, ***, -
      if (stream.match(/[*\-]+\s+/)) return 'list';
      // Ordered list markers: ., .., ...
      if (stream.match(/\.{1,5}\s+/)) return 'list';
      // Horizontal rule: '''
      if (stream.match(/'{3,}\s*$/)) return 'punctuation';
    }

    // Inline tokens
    if (stream.match(/`[^`\n]+`/))              return 'monospace';
    if (stream.match(/\*[^*\s][^*\n]*\*/))      return 'strong';
    if (stream.match(/_[^_\s][^_\n]*_/))        return 'emphasis';
    if (stream.match(/https?:\/\/\S+/))         return 'link';

    stream.next();
    return null;
  },
  tokenTable: {
    heading1:      t.heading1,
    heading2:      t.heading2,
    heading3:      t.heading3,
    heading4:      t.heading4,
    heading5:      t.heading5,
    heading6:      t.heading6,
    monospace:     t.monospace,
    strong:        t.strong,
    emphasis:      t.emphasis,
    link:          t.link,
    list:          t.list,
    attributeName: t.attributeName,
    comment:       t.comment,
    punctuation:   t.punctuation,
  },
});

// ================= Vim compartment =================
// Reconfigured at runtime when the user toggles vim mode.
export const vimCompartment = new Compartment();

// ================= Editor extensions =================

const makeExtensions = (callbacks) => [
  // vim must come before the default keymap so it wins when enabled
  vimCompartment.of(prefs.vimMode ? [vim()] : []),

  // Enable CM6 multi-range selections. Required for vim visual-block
  // mode (Ctrl+Q / Ctrl+V) to extend vertically — the @replit/codemirror-vim
  // plugin represents a V-BLOCK selection as multiple parallel ranges
  // (one per row) and dispatches them via cm6.dispatch({ selection: ... }).
  // CM6 silently collapses multi-range selections to a single range
  // unless allowMultipleSelections is explicitly enabled. Without this
  // facet, pressing j/k in V-BLOCK appears to enter block mode (the
  // plugin's internal vim.visualBlock=true is set) but the visible CM6
  // selection never grows beyond one row. The plugin itself doesn't
  // set this facet — consuming code has to.
  EditorState.allowMultipleSelections.of(true),

  // base editing
  lineNumbers(),
  // drawSelection() renders CM6's internal selection state as
  // .cm-selectionBackground DOM elements. Without this extension CM6
  // relies on the browser's native ::selection pseudo-element, which
  // only shows actual browser text selection (from mouse drag), NOT
  // internal selection state set programmatically. That means vim
  // visual mode (which dispatches selection changes via CM6's state)
  // tracks the selection internally but has no visible highlight —
  // pressing v + motions appears to do nothing. drawSelection() fixes
  // that by rendering the internal selection as visible highlights.
  // It's also what renders the fat vim block cursor.
  drawSelection(),
  highlightActiveLineGutter(),
  highlightActiveLine(),
  history(),
  indentOnInput(),
  bracketMatching(),
  EditorView.lineWrapping,

  // language — minimal adoc stream highlighter
  asciidocLang,

  // highlighting
  syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
  syntaxHighlighting(catppuccinHighlight),

  // theme
  catppuccinTheme,

  // base keymap
  keymap.of([...defaultKeymap, ...historyKeymap]),

  // change listener -> callback chain (set up by main.js)
  EditorView.updateListener.of((update) => {
    if (update.docChanged && !suppressDocEvents) {
      callbacks.onDocChange && callbacks.onDocChange();
    }
    if (update.docChanged || update.selectionSet) {
      callbacks.onSelectionChange && callbacks.onSelectionChange();
    }
  }),
];

// Construct the EditorView and assign to the live-binding export.
// `parent` is the host DOM element; `callbacks` supplies onDocChange
// (for dirty / render / autosave) and onSelectionChange (for status
// bar refresh). Call order: must be invoked AFTER applyUserConfig
// so the theme extension sees the user's CSS variable overrides at
// construction time.
export const createEditor = (parent, initialDoc, callbacks) => {
  editorView = new EditorView({
    doc: initialDoc,
    parent,
    extensions: makeExtensions(callbacks),
  });
  return editorView;
};

// Runtime vim toggle — reconfigure the vim compartment so vim mode
// can be flipped on/off without a full editor rebuild.
export const setVimMode = (on) => {
  editorView.dispatch({
    effects: vimCompartment.reconfigure(on ? [vim()] : []),
  });
};
