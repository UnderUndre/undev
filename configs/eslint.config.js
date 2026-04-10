/**
 * Shareable ESLint flat config for TypeScript projects.
 *
 * Usage in your project:
 *   import baseConfig from "@underundre/undev/eslint";
 *   export default [...baseConfig, { /* your overrides * / }];
 */

import js from "@eslint/js";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

/** @type {import("eslint").Linter.Config[]} */
export default [
  js.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx", "**/*.mts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        projectService: true,
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      // TypeScript strict
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
      "@typescript-eslint/no-import-type-side-effects": "error",

      // Safety
      "no-console": ["warn", { allow: ["warn", "error"] }],
      "no-debugger": "error",
      "no-eval": "error",
      "no-implied-eval": "error",
      "prefer-const": "error",
      "no-var": "error",
      eqeqeq: ["error", "always"],

      // Style (let prettier handle formatting)
      "no-multiple-empty-lines": ["error", { max: 1 }],
    },
  },
  {
    ignores: [
      "node_modules/",
      "dist/",
      "build/",
      "coverage/",
      "*.min.js",
      ".next/",
      ".nuxt/",
    ],
  },
];
