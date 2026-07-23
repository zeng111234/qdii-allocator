const js = require("@eslint/js");

const commonGlobals = {
  Buffer: "readonly",
  URL: "readonly",
  __dirname: "readonly",
  __filename: "readonly",
  clearInterval: "readonly",
  clearTimeout: "readonly",
  console: "readonly",
  exports: "writable",
  fetch: "readonly",
  global: "readonly",
  globalThis: "readonly",
  module: "writable",
  process: "readonly",
  require: "readonly",
  setInterval: "readonly",
  setTimeout: "readonly"
};

module.exports = [
  {
    ignores: [
      "node_modules/**",
      "coverage/**",
      "docs/**",
      "data/**",
      "*.min.js"
    ]
  },
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: "commonjs",
      globals: commonGlobals
    },
    rules: {
      "no-var": "error",
      "prefer-const": "warn",
      eqeqeq: ["error", "always"],
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-console": "off",
      "no-prototype-builtins": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-constant-condition": ["error", { checkLoops: false }],
      semi: ["warn", "always"],
      "no-trailing-spaces": "warn",
      "no-multiple-empty-lines": ["warn", { max: 2 }]
    }
  }
];
