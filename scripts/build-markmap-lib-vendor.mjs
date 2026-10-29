// Rebuild compiler/assets/vendor/markmap/markmap-lib.min.js from the installed markmap-lib.
// Usage: node scripts/build-markmap-lib-vendor.mjs [--check]
//
// The upstream browser IIFE of markmap-lib@0.18.12 (published June 2025) inlines the markdown-it
// it was built with, so the deck kept the old parser whatever bun.lock resolved. This builds the
// same module graph (markmap-lib's `browser` entry) with esbuild, so markdown-it and the other
// parser dependencies come from node_modules at the versions bun.lock pins.
// Shape kept from the upstream IIFE: one top-level script that MERGES its exports into
// `this.markmap` (markmap-view, loaded before it, put Markmap there) and reads KaTeX from
// `window.katex` (optional; the deck does not ship KaTeX).
// --check rebuilds in memory and fails if the committed file differs.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outFile = join(root, "compiler", "assets", "vendor", "markmap", "markmap-lib.min.js");
const require = createRequire(import.meta.url);
const version = (name) => require(`${name}/package.json`).version;

const versions = { "markmap-lib": version("markmap-lib"), "markdown-it": version("markdown-it"), esbuild: version("esbuild") };

const entry = [
  'import * as lib from "markmap-lib";',
  "const target = globalThis.markmap = globalThis.markmap || {};",
  "for (const key of Object.keys(lib)) if (!(key in target)) target[key] = lib[key];",
].join("\n");

// KaTeX stays external, as in the upstream IIFE: `require("katex")` resolves to window.katex.
const katexFromWindow = {
  name: "katex-from-window",
  setup(b) {
    b.onResolve({ filter: /^katex$/ }, () => ({ path: "katex", namespace: "katex-window" }));
    b.onLoad({ filter: /.*/, namespace: "katex-window" }, () => ({ contents: "module.exports = window.katex;", loader: "js" }));
  },
};

const result = await build({
  stdin: { contents: entry, resolveDir: root, loader: "js", sourcefile: "markmap-lib-vendor-entry.js" },
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2020",
  minify: true,
  legalComments: "none",
  write: false,
  logLevel: "silent",
  plugins: [katexFromWindow],
  banner: { js: `/* markmap-lib@${versions["markmap-lib"]} with markdown-it@${versions["markdown-it"]}, bundled by scripts/build-markmap-lib-vendor.mjs (esbuild@${versions.esbuild}) */` },
});
const output = result.outputFiles[0].text;

if (process.argv.includes("--check")) {
  const current = readFileSync(outFile, "utf8");
  if (current !== output) {
    console.error(`markmap-lib vendor is stale: run node scripts/build-markmap-lib-vendor.mjs (want markdown-it@${versions["markdown-it"]})`);
    process.exit(1);
  }
  console.log(`markmap-lib vendor up to date (markdown-it@${versions["markdown-it"]})`);
} else {
  writeFileSync(outFile, output);
  console.log(`wrote ${outFile} (${output.length} bytes, markdown-it@${versions["markdown-it"]})`);
}
