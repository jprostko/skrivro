/// <reference types="vite-plus/client" />

// Custom globals set by Tauri's initialization_script at document-start
// (before any HTML parsing), read by the inline FOUC-prevention scripts
// in index.html and by the module script at init. See lib.rs's
// compute_initial_state for the Rust-side writer.
declare global {
  interface Window {
    // Set by index.html's end-of-body inline <script> after resolving
    // override vs. navigator.language. Read by i18n.ts.
    __SKRIVRO_LANG__?: "en" | "sv";

    // Set by Rust via initialization_script when the user has an
    // explicit `language = en | sv` in their skrivro.conf. Read by
    // the end-of-body inline <script> to override navigator.language
    // auto-detect.
    __SKRIVRO_LANG_OVERRIDE__?: "en" | "sv";

    // Set by Rust via initialization_script with the user-selected
    // theme's color values. Keys are camelCase theme slot names (e.g.
    // `bg`, `bgPanel`, `accentAlt`), and values are CSS color strings
    // or null for slots the theme file didn't set. Read by the inline
    // <script> at the start of <body>, which converts each key to
    // kebab-case and applies as --skr-<kebab> inline CSS var overrides.
    __SKRIVRO_INITIAL_THEME__?: Record<string, string | null>;
  }

  // Keyboard Map API, absent from TypeScript's DOM lib because it is
  // Chromium-only (Mozilla holds a negative standards position on it,
  // hence the optional `keyboard`). Used by main.ts to translate a
  // composed keydown's physical key back to the active layout's base
  // letter for the Windows AltGr chord recovery. Only the one lookup
  // method we call is declared.
  interface KeyboardLayoutMap {
    get(code: string): string | undefined;
  }

  interface NavigatorKeyboard {
    getLayoutMap(): Promise<KeyboardLayoutMap>;
  }

  interface Navigator {
    readonly keyboard?: NavigatorKeyboard;
  }
}

// The `export {}` makes this a module rather than a script, which is
// required for the `declare global` block above to be interpreted as
// an augmentation of the global scope rather than a fresh declaration.
export {};
