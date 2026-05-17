// ================= Render-timing instrumentation =================
//
// PERF is a compile-time switch. false (the default) ships silent;
// set it to true and rebuild to emit the [perf] render-timing lines
// to the console. The instrumentation stays in the tree behind this
// flag rather than being stripped, so render cost can be re-measured
// later without re-deriving it.
//
// Typed `: boolean` rather than left to inference so the value is not
// narrowed to the literal `false` — that keeps `if (PERF)` below from
// being treated as unreachable code while the switch is off.
export const PERF: boolean = false;

// Emit one [perf] line when PERF is on; a no-op when off. Callers
// build the message string unconditionally — it is one short string
// per render pass, not a hot path, so there is no thunk indirection.
export const perfLog = (message: string): void => {
  if (PERF) console.log(`[perf] ${message}`);
};
