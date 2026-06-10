import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: {
        ...globals.browser,
        // Build-time constant injected by vite `define` (vite.config.js).
        __APP_VERSION__: 'readonly',
      },
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]', argsIgnorePattern: '^_' }],
      // Swallowed errors are deliberate throughout (best-effort localStorage,
      // IDB reads, token cleanup) — an empty `catch {}` is the intent, not a bug.
      'no-empty': ['error', { allowEmptyCatch: true }],
      // React Compiler is NOT enabled in the build (no babel-plugin-react-compiler
      // in vite.config). This rule only audits whether the compiler could preserve
      // hand-written useMemo/useCallback — advisory noise with no compiler running.
      'react-hooks/preserve-manual-memoization': 'off',
    },
  },
  {
    // AudioNode is a TipTap extension module: it must export the `AudioNode`
    // node and its palette/ranking helpers alongside the NodeView component.
    // Fast Refresh can't hot-reload a TipTap node anyway, so the rule offers no
    // value here — disable it for this one tightly-coupled file rather than
    // splitting it apart.
    files: ['src/components/editor/AudioNode.jsx'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
])
