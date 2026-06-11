import { defineConfig } from "vite";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  root: "src",
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
    // Tauri desktop app — the JS ships embedded inside the binary and
    // loads from local memory at launch, so chunk size is not a perceived
    // performance concern. Asciidoctor.js alone accounts for most of the
    // ~1.2 MB bundle and cannot be tree-shaken (it's compiled from Ruby
    // via Opal). Raise the threshold so the warning stops firing on
    // every build.
    chunkSizeWarningLimit: 2000,
  },
  // Vitest (pnpm test). The tests are their own target: builds never
  // run them, and no app code imports a test file, so they never
  // bundle. happy-dom supplies the DOM globals that several modules
  // expect at import time.
  test: {
    environment: "happy-dom",
  },
});
