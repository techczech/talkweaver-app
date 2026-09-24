// Acquire ONE icon into compiler/assets/icons/extra.json.
//   node scripts/add-icon.mjs <term> --set simple-icons
//   node scripts/add-icon.mjs moonshot --svg-file ./moonshot.svg \
//        --source https://... --license "Trademark of Moonshot AI" --title "Moonshot AI"
//   node scripts/add-icon.mjs --from-gaps <outline.md>
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildIconEntry, deriveTokens } from "./lib/icon-entry.mjs";
import { stripSvgPreamble } from "./lib/svg-preamble.mjs";

const argv = process.argv.slice(2);

// --from-gaps <outline.md>: compile one outline and list the icon terms it could not
// resolve. Reporting only — each term is then acquired with an explicit add-icon run,
// so nothing is written to extra.json without a human choosing the source.
if (argv[0] === "--from-gaps") {
  const outline = resolve(process.cwd(), argv[1] || "");
  const { prepareSource } = await import("../compiler/scripts/lib/08-source-adapters.mjs");
  const { statSync } = await import("node:fs");
  const content = readFileSync(outline, "utf8");
  const model = await prepareSource(outline, content, "gaps", statSync(outline));
  const terms = [...new Set((model.warnings || [])
    .filter((w) => String(w).startsWith("icon-gap:"))
    .map((w) => String(w).slice("icon-gap:".length)))];
  if (!terms.length) { console.log("no icon gaps in this outline"); process.exit(0); }
  console.log(`${terms.length} unresolved term(s):`);
  for (const t of terms) console.log(`  ${t}\n    node scripts/add-icon.mjs ${JSON.stringify(t)} --set simple-icons`);
  process.exit(0);
}

const term = argv[0];
if (!term || term.startsWith("--")) { console.error("usage: add-icon.mjs <term> [--set <prefix>|--svg-file <path>] ..."); process.exit(1); }
const opt = (n, d = "") => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes(`--${n}`);

const extraPath = resolve(process.cwd(), "compiler/assets/icons/extra.json");
const extra = JSON.parse(readFileSync(extraPath, "utf8"));
const key = opt("key", term.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""));
if (extra[key] && !has("force")) { console.error(`${key} already exists — pass --force to replace`); process.exit(1); }

const title = opt("title", term);
const date = new Date().toISOString().slice(0, 10);
let svg, source, license;

if (has("svg-file")) {
  // A payload that begins with a UTF-8 BOM, an XML prolog (`<?xml version="1.0"?>`) or a
  // DOCTYPE declaration is still a perfectly good SVG — it is simply how company press
  // kits export their marks — but buildIconEntry's guard deliberately rejects anything
  // whose text does not begin with `<svg`. Rather than weaken that guard, normalise the
  // input here, on the acquisition path only, before it ever reaches buildIconEntry.
  svg = stripSvgPreamble(readFileSync(resolve(process.cwd(), opt("svg-file")), "utf8"));
  source = opt("source");
  license = opt("license");
  // buildIconEntry refuses if either is blank — a hand-supplied mark without a
  // recorded origin is exactly the case that must never reach the repo.
} else {
  const set = opt("set", "simple-icons");
  const res = await fetch(`https://api.iconify.design/${set}.json?icons=${encodeURIComponent(key)}`);
  const data = await res.json();
  const icon = (data.icons || {})[key];
  if (!icon) { console.error(`${key} not found in ${set}`); process.exit(1); }
  const w = icon.width || data.width || 24, h = icon.height || data.height || 24;
  svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" fill="currentColor" aria-hidden="true">${icon.body}</svg>`;
  source = `Iconify (${set}:${key}) via https://api.iconify.design/`;
  license = opt("license", set === "simple-icons" ? "CC0-1.0 (shape); trademark of its owner." : "");
}

extra[key] = buildIconEntry({ key, title, tokens: deriveTokens(title), svg, source, license, date });
writeFileSync(extraPath, `${JSON.stringify(extra, null, 1)}\n`);
console.error(`added ${key} — now render the affected slide and LOOK at it before committing.`);
