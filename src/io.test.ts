// Tests for io.ts's pure helpers. Importing io.ts wires the Vim Ex
// commands and the file pipeline as a side effect, so its sibling
// modules and the Tauri APIs are stubbed out — the subjects here are
// the pure functions, not the wiring.
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  stat: vi.fn(),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    setTitle: vi.fn(),
    onCloseRequested: vi.fn(),
    close: vi.fn(),
    destroy: vi.fn(),
    onDragDropEvent: vi.fn(),
  }),
}));
vi.mock("@tauri-apps/api/path", () => ({
  basename: vi.fn(),
  dirname: vi.fn(),
  resolve: vi.fn(),
  isAbsolute: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@codemirror/search", () => ({ openSearchPanel: vi.fn() }));
vi.mock("./editor.js", () => ({
  Vim: { defineEx: vi.fn(), map: vi.fn(), setOption: vi.fn(), unmap: vi.fn() },
  getCM: () => null,
  getDoc: () => "",
  setDoc: vi.fn(),
  editorView: null,
  setEditorLanguage: vi.fn(),
  spellcheckConfigured: () => false,
}));
vi.mock("./spellcheck/custom-words.js", () => ({
  addCustomWord: vi.fn(),
  removeCustomWord: vi.fn(),
}));
vi.mock("./preview.js", () => ({
  render: vi.fn(),
  syncPreviewToCaret: vi.fn(),
  requestPreviewScrollToTop: vi.fn(),
}));
vi.mock("./renderer.js", () => ({ clearAllRendererCaches: vi.fn() }));
vi.mock("./ui.js", () => ({
  refreshStatus: vi.fn(),
  applySyntaxHighlighting: vi.fn(),
  applySpellcheck: vi.fn(),
  setWidthMode: vi.fn(),
  WIDTH_MODES: ["narrow", "medium", "wide", "full"],
  applyTocVisibility: vi.fn(),
  isTocHidden: () => false,
}));

// io.ts grabs its dialog elements at import time, so the DOM they live
// in has to exist before the module loads — hence the scaffold plus a
// dynamic import (a static import would hoist above the scaffold).
document.body.innerHTML = `
  <span id="name"></span>
  <dialog id="confirmDialog">
    <p id="confirmMessage"></p>
    <button id="confirmOkBtn"></button>
    <button id="confirmCancelBtn"></button>
  </dialog>
`;

const { detectFormat } = await import("./io.js");
const { setUserConfig } = await import("./config.js");

afterEach(() => {
  setUserConfig({});
});

describe("detectFormat", () => {
  it("detects markdown extensions case-insensitively", () => {
    expect(detectFormat("/notes/file.md")).toBe("markdown");
    expect(detectFormat("/notes/file.markdown")).toBe("markdown");
    expect(detectFormat("/notes/README.MD")).toBe("markdown");
  });

  it("detects asciidoc extensions case-insensitively", () => {
    expect(detectFormat("/docs/book.adoc")).toBe("asciidoc");
    expect(detectFormat("/docs/book.asciidoc")).toBe("asciidoc");
    expect(detectFormat("/docs/BOOK.ADOC")).toBe("asciidoc");
  });

  it("falls back to text for unknown or missing extensions", () => {
    expect(detectFormat("/tmp/notes.txt")).toBe("text");
    expect(detectFormat("/tmp/Makefile")).toBe("text");
    expect(detectFormat("/tmp/archive.tar.gz")).toBe("text");
  });

  it("matches the extension only at the end of the path", () => {
    expect(detectFormat("/tmp/file.md.bak")).toBe("text");
    expect(detectFormat("/tmp/adoc/notes.txt")).toBe("text");
  });

  it("uses the configured default format for a null path", () => {
    setUserConfig({ defaultFormat: "markdown" });
    expect(detectFormat(null)).toBe("markdown");
    setUserConfig({ defaultFormat: "text" });
    expect(detectFormat(null)).toBe("text");
  });

  it("falls back to asciidoc when no default is configured or it is invalid", () => {
    setUserConfig({});
    expect(detectFormat(null)).toBe("asciidoc");
    setUserConfig({ defaultFormat: "bogus" });
    expect(detectFormat(null)).toBe("asciidoc");
  });
});
