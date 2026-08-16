// Tests for the worker's Markdown scroll-sync pieces: the per-token
// line map and the invariant it depends on: every top-level token
// renders as exactly one top-level element, so the main thread can
// pair lines to elements by index. The worker registers its message
// handler at import time, and happy-dom supplies the
// addEventListener global it expects.
import { describe, expect, it } from "vite-plus/test";
import { load } from "@asciidoctor/core";

import { computeMarkdownLineMap, extractAsciidoctorBlockLines, md } from "./render-worker.js";

const parseAndRender = (source: string) => {
  const env = {};
  const tokens = md.parse(source, env);
  const html = md.renderer.render(tokens, md.options, env);
  const body = new DOMParser().parseFromString(html, "text/html").body;
  return { tokens, body };
};

describe("computeMarkdownLineMap", () => {
  it("maps each top-level block to its 1-based start line", () => {
    const source = [
      "# Title", // line 1
      "",
      "para text", // line 3
      "",
      "- a", // line 5
      "- b",
      "",
      "```", // line 8
      "code",
      "```",
    ].join("\n");
    const { tokens } = parseAndRender(source);
    expect(computeMarkdownLineMap(tokens)).toEqual([1, 3, 5, 8]);
  });

  it("emits one entry per top-level block and none for nested blocks", () => {
    // The blockquote contains a paragraph, and only the blockquote
    // itself is top-level, so the map has exactly two entries.
    const source = "> quoted text\n\ntail paragraph\n";
    const { tokens, body } = parseAndRender(source);
    const map = computeMarkdownLineMap(tokens);
    expect(map).toEqual([1, 3]);
    expect(body.children.length).toBe(2);
  });
});

describe("token-to-element pairing invariant", () => {
  // Raw HTML is the one block type whose natural rendering breaks the
  // one-element-per-token rule: a blank-line-delimited chunk of
  // sibling elements is a single token, and a comment renders as no
  // element at all. The html_block wrapper restores the rule, which
  // is what keeps scroll sync aligned past raw HTML.
  const source = [
    "<div>a</div>", // line 1: one token, three sibling divs
    "<div>b</div>",
    "<div>c</div>",
    "",
    "<!-- hidden -->", // line 5: one token, no visible element
    "",
    "<div>d</div>", // line 7: one token, two sibling divs
    "<div>e</div>",
    "",
    "## After the HTML", // line 10
    "",
    "tail paragraph", // line 12
  ].join("\n");

  it("renders every top-level token as exactly one element", () => {
    const { tokens, body } = parseAndRender(source);
    const map = computeMarkdownLineMap(tokens);
    expect(map).toEqual([1, 5, 7, 10, 12]);
    expect(body.children.length).toBe(map.length);
  });

  it("wraps each raw-HTML block in a single container", () => {
    const { body } = parseAndRender(source);
    const wrappers = body.querySelectorAll(":scope > .raw-html-block");
    expect(wrappers.length).toBe(3);
    expect(wrappers[0]!.querySelectorAll("div").length).toBe(3);
    expect(wrappers[1]!.children.length).toBe(0);
    expect(wrappers[2]!.querySelectorAll("div").length).toBe(2);
  });

  it("keeps lines aligned to elements across raw HTML", () => {
    const { tokens, body } = parseAndRender(source);
    const map = computeMarkdownLineMap(tokens);
    const children = [...body.children];
    const headingIndex = children.findIndex((el) => el.tagName === "H2");
    expect(map[headingIndex]).toBe(10);
    const paragraphIndex = children.findIndex((el) => el.tagName === "P");
    expect(map[paragraphIndex]).toBe(12);
  });
});

describe("extractAsciidoctorBlockLines", () => {
  it("collects one source line per mappable block in document order", async () => {
    const fixture = [
      "== Section", // line 1
      "",
      "para one", // line 3
      "",
      "* a", // line 5
      "* b",
      "",
      "----", // line 8
      "code",
      "----",
      "",
      "NOTE: heads up", // line 12
    ].join("\n");
    const doc = await load(fixture, { sourcemap: true, safe: "unsafe" });
    expect(extractAsciidoctorBlockLines(doc)).toEqual([1, 3, 5, 8, 12]);
  });

  // The walk is duck-typed over getBlocks / getContext /
  // getSourceLocation, so hand-built trees can exercise the paths a
  // real parse rarely produces.
  const stubBlock = (ctx: string, line: number | null, children: unknown[] = []) => ({
    getContext: () => ctx,
    getSourceLocation: () => (line === null ? null : { getLineNumber: () => line }),
    getBlocks: () => children,
  });
  const stubDoc = (children: unknown[]) => ({ getBlocks: () => children });

  it("emits a 0 for a block with no source location, holding its slot", () => {
    const doc = stubDoc([
      stubBlock("paragraph", 4),
      stubBlock("paragraph", null),
      stubBlock("paragraph", 9),
    ]);
    expect(extractAsciidoctorBlockLines(doc as never)).toEqual([4, 0, 9]);
  });

  it("emits a 0 for a non-numeric line number", () => {
    const doc = stubDoc([
      {
        getContext: () => "paragraph",
        getSourceLocation: () => ({ getLineNumber: () => undefined }),
        getBlocks: () => [],
      },
    ]);
    expect(extractAsciidoctorBlockLines(doc as never)).toEqual([0]);
  });

  it("recurses through non-mappable containers without counting them", () => {
    const doc = stubDoc([stubBlock("preamble", 1, [stubBlock("paragraph", 2)])]);
    expect(extractAsciidoctorBlockLines(doc as never)).toEqual([2]);
  });
});
