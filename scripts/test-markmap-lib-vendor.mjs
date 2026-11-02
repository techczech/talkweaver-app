// The vendored markmap-lib that every compiled deck inlines for {mindmap} slides carries the
// markdown-it bun.lock pins, parses valid mindmaps exactly as the installed library does, and stays
// linear on an unclosed multi-line link reference (GHSA-gfr2-rv44-r23c, fixed in markdown-it 14.3.3).
// Hostile parses run in child processes with a hard timeout, so a regression cannot hang the suite.
import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const vendorFile = join(root, "compiler", "assets", "vendor", "markmap", "markmap-lib.min.js");
const require = createRequire(import.meta.url);
const vendor = readFileSync(vendorFile, "utf8");

// 1. Provenance: the committed bundle is exactly what the builder makes from node_modules.
execFileSync(process.execPath, [join(root, "scripts", "build-markmap-lib-vendor.mjs"), "--check"], { stdio: "pipe" });
const installed = require("markdown-it/package.json").version;
const [major, minor, patch] = installed.split(".").map(Number);
assert.ok(major > 14 || (major === 14 && (minor > 3 || (minor === 3 && patch >= 3))), `markdown-it ${installed} is below the 14.3.3 fix`);
assert.ok(vendor.startsWith(`/* markmap-lib@`) && vendor.includes(` with markdown-it@${installed},`), "vendor banner names the installed markdown-it");
assert.ok(vendor.includes("[/^<![A-Za-z]/,"), "vendor carries the 14.3.x html_block rule");
assert.ok(!vendor.includes("[/^<![A-Z]/,"), "vendor still carries a pre-14.3 markdown-it");
assert.ok(!/<\/?script/i.test(vendor), "vendor must stay inlinable inside one <script>");

// 2. Deck inlining: the compiler's vendor source carries this file, not a stale copy.
const { markmapVendorSource } = await import(join(root, "compiler", "scripts", "lib", "01-cli-utils.mjs"));
assert.ok(markmapVendorSource.includes(vendor), "markmapVendorSource inlines the rebuilt markmap-lib");

// 3. Same global shape as upstream: merges into window.markmap without clobbering markmap-view.
function loadVendor() {
  const sandbox = { document: {} };
  sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
  sandbox.markmap = { Markmap: "from-markmap-view" };
  vm.runInContext(vendor, vm.createContext(sandbox));
  return sandbox.markmap;
}
const mm = loadVendor();
assert.equal(mm.Markmap, "from-markmap-view", "markmap-view's Markmap survives");
assert.deepEqual([...Object.keys(mm)].sort(), ["Markmap", "Transformer", "builtInPlugins", "patchCSSItem", "patchJSItem", "transformerVersions"]);

// 4. Valid mindmaps parse exactly as the installed library parses them (the editor's path).
const { Transformer: LibTransformer } = require("markmap-lib");
const corpus = [
  "# Centre\n## Branch one\n- leaf a\n- leaf b\n  - deeper\n## Branch two\n- leaf c",
  "# **Bold** centre\n## `code` branch\n- [a link](https://example.com)\n- *em* and ~~strike~~\n## Unicode — čeština\n- 日本語 · emoji 🙂",
  "# A & B < C\n## \"quoted\" 'single'\n- escaped \\*stars\\*\n- trailing spaces   ",
  "# Refs\n## Uses [ref]\n- [ref] again\n\n[ref]: https://example.com \"Title\"",
  "# Only root",
  "# Root\n## One\n## Two\n## Three\n- a\n  - b\n    - c\n      - d",
];
// JSON, not deepEqual: the vm sandbox builds its arrays in another realm.
const strip = (node) => JSON.stringify(node, (key, value) => (key === "state" || key === "payload" ? undefined : value));
for (const md of corpus) {
  assert.equal(strip(new mm.Transformer().transform(md).root), strip(new LibTransformer().transform(md).root), `parity: ${JSON.stringify(md.slice(0, 40))}`);
}

// 5. Hostile input stays linear: 4x the lines must cost well under the ~16x a quadratic parser pays.
// Calibrated 2026-10-27 on the pre-fix bundle: 50k lines 430 ms, 200k lines 4,643 ms (ratio 10.8);
// fixed bundle 321 ms and 1,239 ms (ratio 3.9).
const probe = `
const vm = require("node:vm"), fs = require("node:fs");
const s = { document: {} }; s.window = s; s.self = s; s.globalThis = s;
vm.runInContext(fs.readFileSync(process.argv[1], "utf8"), vm.createContext(s));
const src = '[a]: /u "' + "x\\n".repeat(Number(process.argv[2]));
const t = process.hrtime.bigint();
new s.markmap.Transformer().transform(src);
process.stdout.write(String(Number(process.hrtime.bigint() - t) / 1e6));`;
function hostileMs(lines) {
  const run = spawnSync(process.execPath, ["-e", probe, vendorFile, String(lines)], { timeout: 20_000, encoding: "utf8" });
  assert.equal(run.signal, null, `hostile parse of ${lines} lines exceeded 20 s (quadratic markdown-it?)`);
  assert.equal(run.status, 0, run.stderr);
  return Number(run.stdout);
}
const small = Math.min(hostileMs(50_000), hostileMs(50_000));
const large = hostileMs(200_000);
const ratio = large / small;
assert.ok(ratio < 7, `unclosed reference scaled ${ratio.toFixed(1)}x for 4x input (${small.toFixed(0)} -> ${large.toFixed(0)} ms): quadratic`);

console.log(`markmap-lib vendor: markdown-it@${installed}, ${corpus.length} mindmaps match the library, hostile reference ${small.toFixed(0)} -> ${large.toFixed(0)} ms (x${ratio.toFixed(1)} for 4x input)`);
