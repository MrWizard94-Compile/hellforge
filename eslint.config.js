"use strict";
// Flat ESLint config for HellForge (ESLint 9+).
const js = require("@eslint/js");

module.exports = [
  js.configs.recommended,
  {
    // renderer runs in the browser with globals injected by <script> tags
    files: ["renderer/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        window: "readonly",
        document: "readonly",
        globalThis: "readonly",
        localStorage: "readonly",
        requestAnimationFrame: "readonly",
        setTimeout: "readonly",
        setInterval: "readonly",
        clearTimeout: "readonly",
        AudioContext: "readonly",
        webkitAudioContext: "readonly",
        module: "writable",
        // libraries loaded via <script>
        Terminal: "readonly",
        FitAddon: "readonly",
        WebLinksAddon: "readonly",
        SearchAddon: "readonly",
        HFCore: "readonly",
        HFCouncil: "readonly",
        HFApi: "readonly",
      },
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-undef": "error",
    },
  },
  {
    // Electron main + preload + tests run in Node
    files: ["main.js", "preload.js", "test/**/*.js", "eslint.config.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: {
        require: "readonly",
        module: "writable",
        process: "readonly",
        __dirname: "readonly",
        console: "readonly",
        Buffer: "readonly",
        fetch: "readonly",
        AbortController: "readonly",
        setInterval: "readonly",
        setTimeout: "readonly",
        clearInterval: "readonly",
        clearTimeout: "readonly",
      },
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
  { ignores: ["node_modules/", "dist/", "renderer/projects.js"] },
];
