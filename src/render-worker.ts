/// <reference lib="webworker" />
// ================= Render worker =================
//
// Off-main-thread parse + convert. The preview pipeline used to run
// Asciidoctor / marked synchronously on the UI thread, freezing the
// editor for the render's whole duration. This Web Worker hosts the
// expensive parsing so a render in progress no longer blocks typing.
//
// Runs here: Asciidoctor load + convert, marked parse, and the
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
import { marked } from 'marked';
import { markedEmoji } from 'marked-emoji';
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

// ================= marked setup =================

// marked options applied on every render:
//   gfm: true     — tables, strikethrough, task lists, autolinks
//   breaks: false — a single newline does NOT become <br>; paragraphs
//                   still break on blank lines (documentation-style)
//   async: false  — forces synchronous output (string, not Promise)
const MARKED_OPTIONS = { gfm: true, breaks: false, async: false } as const;

// ---- GFM alerts extension ----
// GFM extends blockquote syntax with "alerts" — a blockquote whose
// first line is `[!TYPE]`. Base marked renders the marker as visible
// text; this block-level extension intercepts the pattern and emits
// custom callout markup. The marker is case-sensitive per the GFM
// spec — wrong-case falls through to a normal blockquote.
const GFM_ALERT_TYPES = ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'] as const;
type GfmAlertType = (typeof GFM_ALERT_TYPES)[number];

const GFM_ALERT_RE = /^> ?\[!(\w+)\][^\n]*\n((?:> ?[^\n]*(?:\n|$))*)/;

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

marked.use({
  extensions: [
    {
      name: 'gfmAlert',
      level: 'block',
      start(src: string): number | undefined {
        const m = /^> ?\[!/m.exec(src);
        return m ? m.index : undefined;
      },
      // `this: any` / `token: any` — marked's extension API types
      // don't narrow through the `{ extensions: [...] }` shape; the
      // property accesses are checked against the local token shape.
      tokenizer(this: any, src: string) {
        const match = GFM_ALERT_RE.exec(src);
        if (!match) return undefined;
        const rawType = match[1] ?? '';
        if (!GFM_ALERT_TYPES.includes(rawType as GfmAlertType)) return undefined;
        const type = rawType as GfmAlertType;
        const body = (match[2] ?? '').replace(/^> ?/gm, '');
        const tokens = this.lexer.blockTokens(body);
        return { type: 'gfmAlert', raw: match[0], alertType: type, tokens };
      },
      renderer(this: any, token: any): string {
        const type = token.alertType as GfmAlertType;
        const lower = type.toLowerCase();
        const title = type.charAt(0) + type.slice(1).toLowerCase();
        const icon = GFM_ALERT_OCTICONS[type];
        const body = this.parser.parse(token.tokens) as string;
        return `<div class="markdown-alert markdown-alert-${lower}">` +
               `<p class="markdown-alert-title">${icon}${title}</p>` +
               body +
               '</div>';
      },
    },
  ],
});

// ---- emoji shortcodes extension ----
// GitHub-style `:name:` shortcodes render as the unicode emoji.
// `nameToEmoji` from gemoji is the shortcode list; the renderer
// returns the raw codepoint so the system emoji font draws it.
marked.use(markedEmoji({
  emojis: nameToEmoji,
  renderer: (token: { emoji: string }) => token.emoji,
}));

// ---- markdown scroll-sync line map ----
// Top-level token types that render to exactly one direct child of
// the parser's output root. The 1:1 invariant lets the main thread
// pair this line list against rootElement.children by index.
const VISIBLE_MD_BLOCK_TYPES = new Set([
  'heading', 'paragraph', 'list', 'blockquote', 'code', 'table', 'hr',
  'gfmAlert',
]);

// Compute starting source-line numbers for marked's visible top-level
// block tokens, accumulating newline counts in each token's `raw`.
const computeMarkdownLineMap = (tokens: { type: string; raw: string }[]): number[] => {
  const lines: number[] = [];
  let cumNewlines = 0;
  for (const t of tokens) {
    if (VISIBLE_MD_BLOCK_TYPES.has(t.type)) lines.push(cumNewlines + 1);
    cumNewlines += (t.raw.match(/\n/g) || []).length;
  }
  return lines;
};

// ================= Asciidoctor setup =================

const ad = Asciidoctor();

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
const extractAsciidoctorBlockLines = (doc: AsciidoctorDocument): number[] => {
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
  // marked.parse runs the full lex→parse pipeline with the extensions
  // applied. A separate marked.lexer pass produces the token list for
  // the scroll-sync line map — marked.parser(tokens) does not apply
  // extensions, so the html must come from marked.parse directly.
  const html = marked.parse(req.source, MARKED_OPTIONS);
  const tokens = marked.lexer(req.source, MARKED_OPTIONS);
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
