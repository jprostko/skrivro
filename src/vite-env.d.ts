/// <reference types="vite/client" />

// Custom globals set by Tauri's initialization_script at document-start
// (before any HTML parsing), read by the inline FOUC-prevention scripts
// in index.html and by the module script at init. See lib.rs's
// compute_initial_state for the Rust-side writer.
declare global {
  interface Window {
    // Set by index.html's end-of-body inline <script> after resolving
    // override vs. navigator.language. Read by i18n.ts.
    __SKRIVRO_LANG__?: 'en' | 'sv';

    // Set by Rust via initialization_script when the user has an
    // explicit `language = en | sv` in their skrivro.conf. Read by
    // the end-of-body inline <script> to override navigator.language
    // auto-detect.
    __SKRIVRO_LANG_OVERRIDE__?: 'en' | 'sv';

    // Set by Rust via initialization_script with the user-selected
    // theme's color values. Keys are camelCase theme slot names (e.g.
    // `bg`, `bgPanel`, `accentAlt`); values are CSS color strings or
    // null for slots the theme file didn't set. Read by the head
    // inline <script> which converts each key to kebab-case and
    // applies as --skr-<kebab> inline CSS var overrides.
    __SKRIVRO_INITIAL_THEME__?: Record<string, string | null>;
  }
}

// The `export {}` makes this a module rather than a script, which is
// required for the `declare global` block above to be interpreted as
// an augmentation of the global scope rather than a fresh declaration.
export {};
