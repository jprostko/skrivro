import { createLogger, defineConfig } from "vite-plus";

const host = process.env.TAURI_DEV_HOST;

// Asciidoctor's universal browser build conditionally imports node
// builtins and probes a package-relative data directory for its
// Node-side conveniences, all behind environment guards. In the webview
// those paths are dead: the worker only ever uses the string-in,
// string-out API, and includes are pre-expanded on the main thread. The
// bundler still warns about the externalized builtins and the
// unresolved data URL on every build, which reads as breakage to
// someone building from source. Drop exactly the warnings that name the
// package or its data probe and hand everything else through.
const dropAsciidoctorNoise = (level, log, defaultHandler) => {
  const text = `${log.message} ${log.id ?? ""}`;
  if (level === "warn" && text.includes("@asciidoctor/core")) return;
  if (level === "warn" && text.includes("'../../data'")) return;
  defaultHandler(level, log);
};

// The data-URL warning prints through the logger's deduplicating
// warnOnce channel rather than the rollup log hooks, so the logger
// filters it there, with plain warn covered for the same message shape
// as well.
const isAsciidoctorDataProbe = (msg) =>
  msg.includes("'../../data'") && msg.includes("doesn't exist at build time");
const logger = createLogger();
const warn = logger.warn.bind(logger);
const warnOnce = logger.warnOnce.bind(logger);
logger.warn = (msg, options) => {
  if (!isAsciidoctorDataProbe(msg)) warn(msg, options);
};
logger.warnOnce = (msg) => {
  if (!isAsciidoctorDataProbe(msg)) warnOnce(msg);
};

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  fmt: {
    ignorePatterns: ["src-tauri/about.hbs"],
  },
  lint: {
    plugins: ["typescript"],
    categories: { correctness: "error" },
    env: { builtin: true, browser: true },
    rules: {
      "typescript/no-explicit-any": "off",
      "typescript/no-unsafe-assignment": "off",
      "typescript/no-unsafe-call": "off",
      "typescript/no-unsafe-member-access": "off",
      "typescript/no-unsafe-argument": "off",
      "typescript/no-unsafe-return": "off",
      "typescript/no-misused-spread": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "typescript/no-floating-promises": "error",
      "typescript/no-misused-promises": ["error", { checksVoidReturn: { arguments: false } }],
      "typescript/await-thenable": "error",
      "typescript/require-await": "error",
      "typescript/restrict-plus-operands": "error",
      "typescript/restrict-template-expressions": "error",
    },
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  root: "src",
  customLogger: logger,
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    target: "es2025",
    minify: !process.env.TAURI_DEBUG,
    sourcemap: !!process.env.TAURI_DEBUG,
    // Vite's default 500 KB chunk-size warning targets web apps where
    // bundle size affects download time and first paint. Skrivro is a
    // Tauri desktop app: the JS ships embedded inside the binary and
    // loads from local memory at launch, so chunk size is not a perceived
    // performance concern. Asciidoctor.js dominates the render-worker
    // chunk and cannot be tree-shaken (it's compiled from Ruby via
    // Opal). Raise the threshold so the warning stops firing on every
    // build.
    chunkSizeWarningLimit: 2000,
    rollupOptions: { onLog: dropAsciidoctorNoise },
  },
  // Vitest (pnpm test). The tests are their own target: builds never
  // run them, and no app code imports a test file, so they never
  // bundle. happy-dom supplies the DOM globals that several modules
  // expect at import time.
  test: {
    environment: "happy-dom",
  },
});
