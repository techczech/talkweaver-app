// Vendor a whole Iconify collection to compiler/assets/icons/<prefix>.json.
// Usage: node scripts/vendor-icon-set.mjs tabler --license MIT
// Bodies are stored verbatim: Tabler and Simple Icons carry their own paint
// attributes, unlike Lucide whose bare paths are wrapped by iconSvg().
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

const [prefix, ...rest] = process.argv.slice(2);
if (!prefix) { console.error("usage: vendor-icon-set.mjs <iconify-prefix> --license <spdx>"); process.exit(1); }
const licenseIdx = rest.indexOf("--license");
const license = licenseIdx >= 0 ? rest[licenseIdx + 1] : "";
if (!license) { console.error("--license is required: provenance is never omitted"); process.exit(1); }

// The upstream collection's own semver (e.g. Simple Icons' npm version), when Iconify's registry
// reports one — the surest way to name the exact vendored snapshot later. Not every collection
// carries one (this endpoint 404s for some prefixes), so absence is tolerated: the content digest
// below (computed over the actually-vendored bodies, not this metadata) is never optional and
// identifies the snapshot even when no upstream version exists.
let upstreamVersion = null;
try {
  const collectionsRes = await fetch(`https://api.iconify.design/collections?prefix=${prefix}`);
  if (collectionsRes.ok) {
    const info = await collectionsRes.json();
    upstreamVersion = info?.[prefix]?.version || null;
  }
} catch { /* graceful: version is a nice-to-have, never blocks a vendor run */ }

const listRes = await fetch(`https://api.iconify.design/collection?prefix=${prefix}`);
if (!listRes.ok) { console.error(`collection ${prefix} not reachable: ${listRes.status}`); process.exit(1); }
const list = await listRes.json();
const names = [
  ...(list.uncategorized || []),
  ...Object.values(list.categories || {}).flat(),
];
if (!names.length) { console.error(`collection ${prefix} listed no icons`); process.exit(1); }
console.error(`${prefix}: ${names.length} icons to fetch`);

// Chunked so no single request URL grows unbounded. A silently short or failed
// chunk must never produce a silently incomplete collection — the next task
// vendors Tabler (~5,900 icons over ~30 chunks), and a gap here would only
// surface much later as a mysterious "this icon does not exist".
const CHUNK = 200;
const icons = {};
let width = 24, height = 24;
for (let i = 0; i < names.length; i += CHUNK) {
  const slice = names.slice(i, i + CHUNK);
  const res = await fetch(`https://api.iconify.design/${prefix}.json?icons=${encodeURIComponent(slice.join(","))}`);
  if (!res.ok) {
    console.error(`chunk [${i}, ${i + slice.length}) failed: HTTP ${res.status}`);
    process.exit(1);
  }
  const data = await res.json();
  width = data.width || width; height = data.height || height;
  for (const [name, entry] of Object.entries(data.icons || {})) {
    icons[name] = { body: entry.body, w: entry.width || data.width || width, h: entry.height || data.height || height };
  }
  console.error(`  ${Object.keys(icons).length}/${names.length}`);
}

const writtenCount = Object.keys(icons).length;
if (writtenCount < names.length) {
  const missing = names.filter((n) => !(n in icons));
  const sample = missing.slice(0, 10).join(", ");
  console.error(`${prefix}: incomplete — ${missing.length} of ${names.length} icons missing`);
  console.error(`  missing (sample of ${Math.min(10, missing.length)}): ${sample}`);
  process.exit(1);
}

// Content digest over the actually-vendored bodies (name + body + w + h, sorted by name so key
// order in the upstream response never perturbs it). Identifies THIS exact snapshot regardless of
// whether upstream reports a version, and changes if a re-vendor ever pulls different artwork for
// the same names.
const digest = createHash("sha256")
  .update(JSON.stringify(Object.keys(icons).sort().map((n) => [n, icons[n].body, icons[n].w, icons[n].h])))
  .digest("hex")
  .slice(0, 16);

const out = {
  _meta: {
    source: `Iconify collection "${prefix}" via https://api.iconify.design/`,
    license,
    version: upstreamVersion,
    digest,
    date: new Date().toISOString().slice(0, 10),
    requested: names.length,
    count: writtenCount,
    defaultBox: { w: width, h: height },
  },
  ...icons,
};
const path = resolve(process.cwd(), "compiler/assets/icons", `${prefix}.json`);
writeFileSync(path, JSON.stringify(out));
console.error(`wrote ${path} (${writtenCount} icons)`);
