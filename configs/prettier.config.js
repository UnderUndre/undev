/**
 * Shareable Prettier config.
 *
 * Usage in your project's package.json:
 *   "prettier": "@underundre/undev/prettier"
 *
 * Or in prettier.config.js:
 *   import config from "@underundre/undev/prettier";
 *   export default { ...config, /* overrides */ };
 */

/** @type {import("prettier").Config} */
export default {
  semi: true,
  singleQuote: false,
  tabWidth: 2,
  trailingComma: "all",
  printWidth: 100,
  bracketSpacing: true,
  arrowParens: "always",
  endOfLine: "lf",
  plugins: [],
};
