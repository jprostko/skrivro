// ESLint flat config (ESLint 9+). Runs via `npm run lint`.
//
// Philosophy: enable the rules that catch real bugs tsc doesn't — async
// correctness, promise safety, dangerous coercions — and skip purely
// stylistic rules (quote style, semicolon placement, arrow parens, etc.).
// Style is maintained by hand in this codebase deliberately; we don't
// want ESLint fighting the author's intentional formatting.
//
// If we ever add Prettier, stylistic rules go there; ESLint stays
// focused on bug-catching.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  // Ignore generated output and dependencies. `dist/` is Vite's build
  // folder; `src-tauri/target/` is Rust's cargo output; node_modules is
  // obvious. Nothing in these should be linted.
  {
    ignores: ['dist/**', 'src-tauri/target/**', 'node_modules/**'],
  },

  // Base JavaScript rules (applies to everything, including this config
  // file and vite.config.js).
  js.configs.recommended,

  // Node globals for build tooling that runs in a Node context
  // (vite.config.js uses process.env). Without this, the base
  // `no-undef` rule fires on `process` references because the default
  // environment is browser-only.
  {
    files: ['vite.config.js', 'eslint.config.js'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },

  // TypeScript rules with type-aware checking — only for src/**/*.ts.
  // The type-checked rule set requires parser services backed by
  // tsconfig.json's project; applying it globally (to eslint.config.js,
  // vite.config.js, etc.) would fail because those files aren't in
  // tsconfig.json's `include`. Scoping to the TS sources is the
  // documented pattern from typescript-eslint's typed-linting guide.
  {
    files: ['src/**/*.ts'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      // We use `any` deliberately at external-library boundaries
      // (Asciidoctor AST walk children — @asciidoctor/core's own types
      // declare getBlocks() as any[]; and @replit/codemirror-vim's cm
      // parameter in Vim Ex handlers, which we never reference). See
      // the project_pending_features.md item #20 DONE stub for the
      // rationale. Turning off no-explicit-any AND the no-unsafe-*
      // family that cascades from it, because they only add value if
      // you can commit to zero any — which we can't without the
      // upstream type libraries tightening their own declarations.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',

      // Prefer underscore prefix for intentionally-unused parameters
      // and variables, matching our existing `_cm: any` convention in
      // io.ts's Vim Ex handlers.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
);
