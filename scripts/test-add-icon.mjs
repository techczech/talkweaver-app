// Verifies the pure helpers behind add-icon.mjs: entry construction, provenance
// refusal and token derivation. No network — the acquisition scripts inject fetch.
import { buildIconEntry, normaliseSvg, deriveTokens } from "./lib/icon-entry.mjs";
import { stripSvgPreamble } from "./lib/svg-preamble.mjs";

let fail = 0;
const ck = (c, m) => { if (!c) { console.error("FAIL:", m); fail++; } };

// (1) A complete entry is built in the extra.json shape.
const entry = buildIconEntry({
  key: "moonshot", title: "Moonshot AI", tokens: ["moonshot"],
  svg: '<svg viewBox="0 0 24 24">\n  <path d="M0 0h24v24H0z"/>\n</svg>',
  source: "https://example.com/brand", license: "Trademark of Moonshot AI",
  date: "2026-07-22",
});
ck(entry.title === "Moonshot AI", "entry keeps its title");
ck(Array.isArray(entry.tokens) && entry.tokens[0] === "moonshot", "entry keeps its tokens");
ck(entry.source === "https://example.com/brand", "entry records its source");
ck(entry.license === "Trademark of Moonshot AI", "entry records its licence");
ck(entry.date === "2026-07-22", "entry records its acquisition date");
ck(!/\n/.test(entry.svg), "entry svg is single-line");

// (2) Provenance is mandatory — each missing field is refused by name.
for (const missing of ["source", "license", "date"]) {
  const args = {
    key: "x", title: "X", tokens: ["x"], svg: "<svg></svg>",
    source: "s", license: "l", date: "2026-07-22",
  };
  delete args[missing];
  let threw = null;
  try { buildIconEntry(args); } catch (e) { threw = e; }
  ck(threw instanceof Error, `missing ${missing} throws`);
  ck(threw && threw.message.includes(missing), `missing ${missing} names the field in the message`);
}

// (3) An entry without an <svg> root is refused — a 404 body must never be written.
let badSvg = null;
try {
  buildIconEntry({ key: "x", title: "X", tokens: ["x"], svg: "Not Found", source: "s", license: "l", date: "2026-07-22" });
} catch (e) { badSvg = e; }
ck(badSvg instanceof Error, "non-SVG payload throws");

// (4) normaliseSvg collapses whitespace without touching path data.
ck(normaliseSvg('<svg>\n  <path d="M0 0 L1 1"/>\n</svg>') === '<svg><path d="M0 0 L1 1"/></svg>',
  "normaliseSvg collapses inter-tag whitespace and preserves path data");

// (5) deriveTokens lowercases and splits, dropping punctuation.
ck(JSON.stringify(deriveTokens("Moonshot AI")) === JSON.stringify(["moonshot", "ai"]), "deriveTokens splits and lowercases");
ck(JSON.stringify(deriveTokens("Z.Ai")) === JSON.stringify(["z", "ai"]), "deriveTokens splits on punctuation");

// (6) --svg-file path: a real-world press-kit download carries a UTF-8 BOM and an XML
// prolog before <svg>. stripSvgPreamble must remove both so the cleaned payload is
// accepted by buildIconEntry's strict `/^<svg[\s>]/i` guard (which stays strict).
const pressKitPayload = "\uFEFF" + '<?xml version="1.0" encoding="UTF-8"?>\n<svg viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>';
const stripped = stripSvgPreamble(pressKitPayload);
ck(/^<svg/.test(stripped), "stripSvgPreamble leaves the payload starting with <svg");
const pressKitEntry = buildIconEntry({
  key: "presskit", title: "Press Kit", tokens: ["presskit"],
  svg: stripped, source: "https://example.com/presskit", license: "Trademark of Example Inc.",
  date: "2026-07-22",
});
ck(pressKitEntry.svg.startsWith("<svg"), "a BOM+prolog svg-file payload yields an entry whose svg starts with <svg");

// (7) Real downloaded brand SVGs also carry a leading DOCTYPE, in several shapes.
// stripSvgPreamble must strip all of them, not just the bare form.
const bareDoctype = '<!DOCTYPE svg>\n<svg viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>';
ck(/^<svg/.test(stripSvgPreamble(bareDoctype)), "stripSvgPreamble strips a bare <!DOCTYPE svg>");

const publicDoctype = '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n<svg viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>';
ck(/^<svg/.test(stripSvgPreamble(publicDoctype)), "stripSvgPreamble strips a standard W3C PUBLIC DOCTYPE with quoted URLs");

const subsetDoctype = '<!DOCTYPE svg [\n  <!ENTITY ns_extend "http://ns.adobe.com/Extensibility/1.0/">\n]>\n<svg viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>';
ck(/^<svg/.test(stripSvgPreamble(subsetDoctype)), "stripSvgPreamble strips a DOCTYPE with an internal [...] subset");

if (fail) { console.error(`\n${fail} check(s) failed`); process.exit(1); }
console.log("PASS: icon entry helpers");
