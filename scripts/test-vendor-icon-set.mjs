// Verifies vendor-icon-set.mjs's completeness guard. A whole Iconify collection
// (Tabler is next: ~5,900 icons over 30 chunked requests) must never be vendored
// partially — a bad chunk has to fail loudly here, not surface as a mysterious
// "this icon does not exist" much later. No real network: fetch is replaced with
// a fake before the script is imported, per chunk-request response.
import { existsSync, unlinkSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

let fail = 0;
const ck = (c, m) => { if (!c) { console.error("FAIL:", m); fail++; } };

const PREFIX = "test-vendor-guard";
const outPath = resolve(process.cwd(), "compiler/assets/icons", `${PREFIX}.json`);
const cleanup = () => { if (existsSync(outPath)) unlinkSync(outPath); };

function jsonRes(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

// Runs the script fresh (each call imports a distinct module instance via a
// cache-busting query string, since top-level ESM code only runs once per
// specifier) with argv and fetch stubbed for the duration of the import.
async function runVendorScript(names, chunkHandler) {
  cleanup();
  process.argv = ["node", "scripts/vendor-icon-set.mjs", PREFIX, "--license", "MIT"];
  globalThis.fetch = async (url) => {
    if (url.includes("/collection?")) return jsonRes({ uncategorized: names });
    return chunkHandler(url);
  };
  let exitCode = null;
  const realExit = process.exit;
  process.exit = (code) => { exitCode = code ?? 0; throw new Error("__test_exit__"); };
  try {
    await import(`./vendor-icon-set.mjs?run=${Date.now()}-${Math.random()}`);
  } catch (e) {
    if (e.message !== "__test_exit__") throw e;
  } finally {
    process.exit = realExit;
  }
  return exitCode;
}

const namesOf = (n) => Array.from({ length: n }, (_, i) => `icon-${i}`);
const iconsOf = (names) => Object.fromEntries(names.map((n) => [n, { body: `<path d="${n}"/>` }]));

// (1) A non-ok HTTP response for a chunk is a hard failure: exit non-zero, write nothing.
{
  const names = namesOf(5);
  const exitCode = await runVendorScript(names, async () => jsonRes({}, { ok: false, status: 503 }));
  ck(exitCode !== null && exitCode !== 0, "a non-ok chunk response exits non-zero");
  ck(!existsSync(outPath), "a non-ok chunk response writes no file");
}

// (2) A chunk that silently returns fewer icons than requested is a hard failure too —
// this is the exact scenario the reviewer reproduced: 5 requested, one chunk returns 2.
{
  const names = namesOf(5);
  const short = names.slice(0, 2);
  const exitCode = await runVendorScript(names, async () =>
    jsonRes({ width: 24, height: 24, icons: iconsOf(short) }));
  ck(exitCode !== null && exitCode !== 0, "a short chunk (2 of 5) exits non-zero");
  ck(!existsSync(outPath), "a short chunk (2 of 5) writes no file");
}

// (3) A complete fetch still succeeds and writes both the requested and written counts,
// so the guard has no false positive and the written file is unambiguous about its
// own completeness.
{
  const names = namesOf(5);
  const exitCode = await runVendorScript(names, async () =>
    jsonRes({ width: 24, height: 24, icons: iconsOf(names) }));
  ck(exitCode === null, "a complete fetch does not call process.exit");
  ck(existsSync(outPath), "a complete fetch writes the collection file");
  if (existsSync(outPath)) {
    const written = JSON.parse(readFileSync(outPath, "utf8"));
    ck(written._meta.requested === 5, "_meta records the requested count");
    ck(written._meta.count === 5, "_meta records the written count");
    ck(Object.keys(written).filter((k) => k !== "_meta").length === 5, "all 5 icons are present");
  }
}

cleanup();

if (fail) { console.error(`\n${fail} check(s) failed`); process.exit(1); }
console.log("PASS: vendor-icon-set completeness guard");
