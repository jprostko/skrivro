/// <reference lib="webworker" />
// ================= Render worker =================
//
// Off-main-thread parse + convert. The preview pipeline used to run
// the markup parsers synchronously on the UI thread, freezing the
// editor for the render's whole duration. This Web Worker hosts the
// expensive parsing so a render in progress no longer blocks typing.
//
// Runs here: Asciidoctor load + convert, Markdown render, and the
// source-line extraction for scroll-sync block maps. Stays on the
// main thread (renderer.ts), because each needs an API a worker
// lacks: the AsciiDoc include:: preprocessor (Tauri file IPC),
// DOMPurify sanitization (a DOM), the admonition-icon SVG swap
// (DOMParser), and the rendered-DOM walk that pairs block-map line
// numbers to elements.
//
// The worker receives already-include-expanded source and returns
// raw (unsanitized) HTML plus block-map line data. Raw HTML in
// transit is just a string; the security boundary is DOMPurify on
// the main thread, before the HTML ever reaches the DOM.

import Asciidoctor, {
  type Document as AsciidoctorDocument,
  type AbstractBlock,
} from '@asciidoctor/core';
import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import type StateCore from 'markdown-it/lib/rules_core/state_core.mjs';
import { bare as markdownItEmoji } from 'markdown-it-emoji';
import { nameToEmoji } from 'gemoji';

// ================= Message protocol =================

// Main thread → worker. `source` is the text to render; for AsciiDoc
// it has already had include:: directives expanded on the main
// thread. `attributes` carries the Asciidoctor load attributes the
// main thread assembled (showtitle, icons, and docname/docfile/docdir
// when the buffer has a path); `safe` is the Asciidoctor safe mode.
export interface WorkerRenderRequest {
  id: number;
  kind: 'asciidoc' | 'markdown';
  source: string;
  safe?: string;
  attributes?: Record<string, unknown>;
}

// Worker → main thread. `html` is raw, unsanitized output. `blockLines`
// is the per-block source line list for scroll sync — one entry per
// mappable block in document order, paired against the rendered DOM
// on the main thread (a 0 entry marks a block with no usable source
// location). `tocPosition` is meaningful only for AsciiDoc.
export interface WorkerRenderSuccess {
  id: number;
  ok: true;
  html: string;
  blockLines: number[];
  tocPosition: string | null;
}

export interface WorkerRenderFailure {
  id: number;
  ok: false;
  error: string;
}

export type WorkerRenderResponse = WorkerRenderSuccess | WorkerRenderFailure;

// ================= markdown-it setup =================

// One configured MarkdownIt instance, built once and reused for every
// render. Options match GitHub-Flavored Markdown:
//   html: true    — raw HTML in the source passes through. Raw HTML
//                   is part of CommonMark, and the main thread runs
//                   DOMPurify over the output before it reaches the
//                   DOM, so this is the spec-conforming setting.
//   linkify: true — bare URLs become links (GFM autolinks extension).
//   breaks: false — a lone newline is a CommonMark softbreak, not a
//                   <br>; paragraphs still break on blank lines.
// langPrefix keeps its 'language-' default, so fenced code emits
// <code class="language-xxx"> — the class the preview's syntax CSS
// keys on.
// Exported so the test suite exercises this exact configured instance
// rather than a lookalike.
export const md = new MarkdownIt({ html: true, linkify: true, breaks: false });

// GFM's strikethrough extension renders to <del> (per the GFM spec).
// markdown-it's built-in strikethrough is its own, non-GFM extension
// and emits <s>; override its renderer rules to <del> so the output
// conforms to GFM.
md.renderer.rules.s_open = () => '<del>';
md.renderer.rules.s_close = () => '</del>';

// Raw-HTML blocks are the one top-level token type whose default
// rendering can produce any number of elements — several siblings in
// one blank-line-delimited chunk, or none at all for a comment. That
// breaks the 1:1 token-to-element invariant the scroll-sync pairing
// relies on, shifting every pairing after the block. Wrap each
// html_block's output in a single neutral container so every top-level
// token renders as exactly one element. The wrapper also survives
// sanitization when its content is stripped, so the invariant holds in
// the live DOM.
md.renderer.rules.html_block = (tokens, idx) =>
  `<div class="raw-html-block">${tokens[idx]!.content}</div>`;

// ---- GFM alerts ----
// GFM extends blockquote syntax with "alerts" — a blockquote whose
// first line is `[!TYPE]`. markdown-it parses such input as an
// ordinary blockquote; the gfmAlert core rule below retags those
// blockquote tokens as alert tokens, and the renderer rules emit the
// callout markup. The marker is case-sensitive — a wrong-case
// `[!type]` falls through as a normal blockquote, matching GitHub.
const GFM_ALERT_TYPES = ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'] as const;
type GfmAlertType = (typeof GFM_ALERT_TYPES)[number];

// Matches the alert marker at the start of the blockquote's first
// paragraph — markdown-it has already stripped the `> ` prefix.
// Capture group 1 is the type word; any text after `[!TYPE]` on the
// marker line is matched and discarded.
const GFM_ALERT_MARKER_RE = /^\[!(\w+)\][^\n]*(?:\n|$)/;

// Octicon SVG markup per alert type, copied verbatim from GitHub's
// markdown API output. Inlined so the glyphs inherit `fill:
// currentColor` from the title's color rule.
const GFM_ALERT_OCTICONS: Record<GfmAlertType, string> = {
  NOTE: '<svg class="octicon octicon-info mr-2" viewBox="0 0 16 16" version="1.1" width="16" height="16" aria-hidden="true"><path d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm8-6.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM6.5 7.75A.75.75 0 0 1 7.25 7h1a.75.75 0 0 1 .75.75v2.75h.25a.75.75 0 0 1 0 1.5h-2a.75.75 0 0 1 0-1.5h.25v-2h-.25a.75.75 0 0 1-.75-.75ZM8 6a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z"></path></svg>',
  TIP: '<svg class="octicon octicon-light-bulb mr-2" viewBox="0 0 16 16" version="1.1" width="16" height="16" aria-hidden="true"><path d="M8 1.5c-2.363 0-4 1.69-4 3.75 0 .984.424 1.625.984 2.304l.214.253c.223.264.47.556.673.848.284.411.537.896.621 1.49a.75.75 0 0 1-1.484.211c-.04-.282-.163-.547-.37-.847a8.456 8.456 0 0 0-.542-.68c-.084-.1-.173-.205-.268-.32C3.201 7.75 2.5 6.766 2.5 5.25 2.5 2.31 4.863 0 8 0s5.5 2.31 5.5 5.25c0 1.516-.701 2.5-1.328 3.259-.095.115-.184.22-.268.319-.207.245-.383.453-.541.681-.208.3-.33.565-.37.847a.751.751 0 0 1-1.485-.212c.084-.593.337-1.078.621-1.489.203-.292.45-.584.673-.848.075-.088.147-.173.213-.253.561-.679.985-1.32.985-2.304 0-2.06-1.637-3.75-4-3.75ZM5.75 12h4.5a.75.75 0 0 1 0 1.5h-4.5a.75.75 0 0 1 0-1.5ZM6 15.25a.75.75 0 0 1 .75-.75h2.5a.75.75 0 0 1 0 1.5h-2.5a.75.75 0 0 1-.75-.75Z"></path></svg>',
  IMPORTANT: '<svg class="octicon octicon-report mr-2" viewBox="0 0 16 16" version="1.1" width="16" height="16" aria-hidden="true"><path d="M0 1.75C0 .784.784 0 1.75 0h12.5C15.216 0 16 .784 16 1.75v9.5A1.75 1.75 0 0 1 14.25 13H8.06l-2.573 2.573A1.458 1.458 0 0 1 3 14.543V13H1.75A1.75 1.75 0 0 1 0 11.25Zm1.75-.25a.25.25 0 0 0-.25.25v9.5c0 .138.112.25.25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h6.5a.25.25 0 0 0 .25-.25v-9.5a.25.25 0 0 0-.25-.25Zm7 2.25v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 9a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"></path></svg>',
  WARNING: '<svg class="octicon octicon-alert mr-2" viewBox="0 0 16 16" version="1.1" width="16" height="16" aria-hidden="true"><path d="M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"></path></svg>',
  CAUTION: '<svg class="octicon octicon-stop mr-2" viewBox="0 0 16 16" version="1.1" width="16" height="16" aria-hidden="true"><path d="M4.47.22A.749.749 0 0 1 5 0h6c.199 0 .389.079.53.22l4.25 4.25c.141.14.22.331.22.53v6a.749.749 0 0 1-.22.53l-4.25 4.25A.749.749 0 0 1 11 16H5a.749.749 0 0 1-.53-.22L.22 11.53A.749.749 0 0 1 0 11V5c0-.199.079-.389.22-.53Zm.84 1.28L1.5 5.31v5.38l3.81 3.81h5.38l3.81-3.81V5.31L10.69 1.5ZM8 4a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 8 4Zm0 8a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z"></path></svg>',
};

// Core rule: scan the block-token stream for blockquotes whose first
// paragraph opens with a valid `[!TYPE]` marker and retag them as
// alerts. Registered after `block` (so blockquotes are tokenized) and
// before `inline` (so the marker text can be cut from the still-raw
// paragraph content). Nested alerts work for free — the loop visits
// every blockquote_open token, inner ones included.
const gfmAlertRule = (state: StateCore): void => {
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i++) {
    const open = tokens[i];
    if (!open || open.type !== 'blockquote_open') continue;

    // A blockquote's first child must be a paragraph for it to be an
    // alert — the `[!TYPE]` marker is always plain text.
    const paraOpen = tokens[i + 1];
    const inline = tokens[i + 2];
    const paraClose = tokens[i + 3];
    if (!paraOpen || paraOpen.type !== 'paragraph_open') continue;
    if (!inline || inline.type !== 'inline') continue;

    const m = GFM_ALERT_MARKER_RE.exec(inline.content);
    if (!m) continue;
    const rawType = m[1] ?? '';
    if (!GFM_ALERT_TYPES.includes(rawType as GfmAlertType)) continue;
    const type = rawType as GfmAlertType;

    // Find the matching blockquote_close, tracking nesting depth so a
    // nested blockquote's close is not taken for this one's. Leave the
    // blockquote untouched if the stream is malformed and no matching
    // close is found.
    let depth = 1;
    let closeTok: Token | null = null;
    for (let j = i + 1; j < tokens.length; j++) {
      const t = tokens[j];
      if (!t) continue;
      if (t.type === 'blockquote_open') {
        depth++;
      } else if (t.type === 'blockquote_close') {
        depth--;
        if (depth === 0) { closeTok = t; break; }
      }
    }
    if (!closeTok) continue;

    // Retag the wrapper tokens; the gfm_alert_open / gfm_alert_close
    // renderer rules emit the callout <div> and its title.
    open.type = 'gfm_alert_open';
    open.tag = 'div';
    open.meta = { type };
    closeTok.type = 'gfm_alert_close';
    closeTok.tag = 'div';

    // Strip the marker line from the first paragraph. If the marker
    // was the whole paragraph, hide the now-empty wrapper so it does
    // not render as <p></p>; otherwise keep the paragraph minus its
    // first line.
    const rest = inline.content.slice(m[0].length);
    if (rest.length === 0) {
      paraOpen.hidden = true;
      if (paraClose && paraClose.type === 'paragraph_close') {
        paraClose.hidden = true;
      }
      inline.content = '';
    } else {
      inline.content = rest;
    }
  }
};

// Renderer rules for the retagged alert tokens. gfm_alert_open emits
// the callout <div> plus the icon-and-label title <p>; the alert body
// (every token between open and close) renders in between as usual;
// gfm_alert_close emits the closing </div>. The markup is identical
// to what the previous (marked-based) renderer produced.
md.renderer.rules.gfm_alert_open = (tokens, idx) => {
  const token = tokens[idx];
  if (!token) return '';
  const type = token.meta.type as GfmAlertType;
  const lower = type.toLowerCase();
  const title = type.charAt(0) + type.slice(1).toLowerCase();
  return `<div class="markdown-alert markdown-alert-${lower}">` +
         `<p class="markdown-alert-title">${GFM_ALERT_OCTICONS[type]}${title}</p>`;
};
md.renderer.rules.gfm_alert_close = () => '</div>';

// ---- GFM task lists ----
// `- [ ]` / `- [x]` list items. markdown-it has no native task-list
// support; this core rule reproduces the GFM `tasklist` extension.
// For each list item whose first block is a paragraph beginning with
// a marker, it replaces the marker text with an <input type="checkbox">
// at the start of that paragraph's content — the same place cmark-gfm
// (GitHub's reference implementation) puts it. Registered before
// `inline` so the marker can be cut from the still-raw paragraph text.
const GFM_TASK_MARKER_RE = /^\[([ \txX])\][ \t]+/;

const gfmTaskListRule = (state: StateCore): void => {
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i++) {
    const liOpen = tokens[i];
    if (!liOpen || liOpen.type !== 'list_item_open') continue;

    // The first block of the item must be a paragraph — tight-list
    // paragraphs are hidden but still present as paragraph_open /
    // inline tokens.
    const paraOpen = tokens[i + 1];
    const inline = tokens[i + 2];
    if (!paraOpen || paraOpen.type !== 'paragraph_open') continue;
    if (!inline || inline.type !== 'inline') continue;

    const m = GFM_TASK_MARKER_RE.exec(inline.content);
    if (!m) continue;
    const marker = m[1] ?? ' ';
    const checked = marker !== ' ' && marker !== '\t';

    // Replace the marker text with the checkbox at the start of the
    // paragraph's inline content. With html:true the inline parser
    // turns the <input> into an html_inline token, so the checkbox
    // shares the item text's inline flow — checkbox and text stay on
    // one line in both tight and loose lists. Injecting it instead as
    // a separate block-level token would put a block boundary between
    // the checkbox and the text of a loose-list item, breaking them
    // onto two lines.
    const checkbox = `<input ${checked ? 'checked="" ' : ''}disabled="" type="checkbox"> `;
    inline.content = checkbox + inline.content.slice(m[0].length);

    // Tag the <li> so the preview stylesheet can hide its bullet —
    // GitHub marks task-list items with this same class. Keying the
    // CSS on the class covers tight and loose items alike, unlike a
    // structural selector that must know where the <input> sits.
    liOpen.attrJoin('class', 'task-list-item');
  }
};

md.core.ruler.after('block', 'gfm_alert', gfmAlertRule);
md.core.ruler.after('block', 'gfm_task_list', gfmTaskListRule);

// ---- emoji shortcodes ----
// GitHub-style `:name:` shortcodes render as the unicode emoji. The
// `bare` markdown-it-emoji plugin ships no emoji data of its own;
// feeding it gemoji's nameToEmoji preserves the exact shortcode set
// the previous (marked-emoji) renderer used. `:)`-style shortcuts
// stay off — the plugin's default.
md.use(markdownItEmoji, { defs: nameToEmoji });

// ---- markdown scroll-sync line map ----
// One source-line entry per top-level rendered block, in document
// order, for the main thread to pair against the preview's top-level
// elements. markdown-it tags every token with a nesting `level` and a
// `[startLine, endLine]` source `map`; a top-level block is any
// level-0 token that is not a closing tag (a block_open, or a self-
// contained block such as fence / hr / html_block). A block token
// with no map contributes a 0, which the pairing step skips.
export const computeMarkdownLineMap = (tokens: Token[]): number[] => {
  const lines: number[] = [];
  for (const t of tokens) {
    if (t.level === 0 && t.nesting !== -1) {
      lines.push(t.map ? t.map[0] + 1 : 0);
    }
  }
  return lines;
};

// ================= Asciidoctor setup =================

// Exported so the test suite exercises this exact configured instance
// rather than a lookalike.
export const ad = Asciidoctor();

// Asciidoctor block contexts that map to a scrollable preview
// element. Excludes purely structural contexts (document, preamble)
// and inline-level blocks with no preview container of their own.
const MAPPABLE_CONTEXTS = new Set([
  'paragraph', 'listing', 'literal', 'example', 'sidebar',
  'admonition', 'quote', 'verse', 'image', 'ulist', 'olist', 'dlist',
  'section', 'open', 'table',
]);

// Walk the parsed AST and collect the source line number of each
// mappable block, in document order. The main thread pairs this list
// index-for-index against the rendered DOM (querySelectorAll order),
// so it must hold exactly one entry per mappable block. A 0 entry
// marks a block with no usable source line — either no source
// location at all, or a non-numeric line number — which the main
// thread skips while keeping the index aligned. getBlocks() is typed
// `any[]` by @asciidoctor/core, so the children walked here are
// effectively untyped.
export const extractAsciidoctorBlockLines = (doc: AsciidoctorDocument): number[] => {
  const out: number[] = [];
  try {
    const walk = (block: AbstractBlock): void => {
      if (!block || typeof block.getBlocks !== 'function') return;
      for (const child of block.getBlocks()) {
        let ctx: string | null = null;
        try { ctx = child.getContext(); } catch { /* untyped API */ }
        if (ctx && MAPPABLE_CONTEXTS.has(ctx)) {
          let loc = null;
          try { loc = child.getSourceLocation(); } catch { /* untyped API */ }
          // Push exactly one entry per mappable block — unconditionally,
          // even when getSourceLocation() returned nothing — so the
          // count stays aligned with the DOM elements the main thread
          // pairs this against. A 0 marks a block with no usable source
          // line: pairing skips it, but the index still advances.
          const line = loc ? loc.getLineNumber() : null;
          out.push(typeof line === 'number' ? line : 0);
        }
        walk(child);
      }
    };
    walk(doc);
  } catch (e) {
    console.error('extractAsciidoctorBlockLines failed:', e);
  }
  return out;
};

// ================= Render functions =================

const renderAsciidoc = (req: WorkerRenderRequest): WorkerRenderSuccess => {
  // Load first (so the AST is available for the block-line walk),
  // then convert. sourcemap: true is what annotates blocks with
  // source line numbers.
  const doc = ad.load(req.source, {
    safe: req.safe || 'unsafe',
    sourcemap: true,
    attributes: req.attributes ?? {},
  });
  const blockLines = extractAsciidoctorBlockLines(doc);
  const html = doc.convert({ standalone: false });
  return {
    id: req.id,
    ok: true,
    html,
    blockLines,
    tocPosition: doc.getAttribute('toc-position') || null,
  };
};

const renderMarkdown = (req: WorkerRenderRequest): WorkerRenderSuccess => {
  // One parse yields the token stream; the renderer turns that same
  // stream into HTML and computeMarkdownLineMap walks it for the
  // scroll-sync map — no second pass. (marked needed a separate lexer
  // call because marked.parser skipped extensions; markdown-it has no
  // such split.) `env` is markdown-it's per-render sandbox, passed to
  // both parse and render so reference definitions resolve.
  const env = {};
  const tokens = md.parse(req.source, env);
  const html = md.renderer.render(tokens, md.options, env);
  return {
    id: req.id,
    ok: true,
    html,
    blockLines: computeMarkdownLineMap(tokens),
    tocPosition: null,
  };
};

// ================= Message handler =================

addEventListener('message', (e: MessageEvent<WorkerRenderRequest>) => {
  const req = e.data;
  try {
    const result = req.kind === 'asciidoc'
      ? renderAsciidoc(req)
      : renderMarkdown(req);
    postMessage(result);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const failure: WorkerRenderFailure = { id: req.id, ok: false, error };
    postMessage(failure);
  }
});
