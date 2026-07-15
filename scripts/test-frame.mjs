// Replica test for resolveSlideFrame. The functions below MUST match
// compiler/scripts/lib/11-frame.mjs verbatim; if that file changes, update here.
import { strict as assert } from "node:assert";

const FRAME_BUILTINS = { title: "top", section: "off", image: "left", align: "center", icons: "off" };
// ---- BEGIN MUST-MATCH (copy of 11-frame.mjs) ----
function normTitle(v){ if(v==null)return null; const s=String(v).toLowerCase(); if(v===true||s==="side"||s==="sidebar")return "side"; if(s==="off"||s==="none"||s==="hide")return "off"; if(s==="top")return "top"; return null; }
function normSection(v){ if(v==null)return null; const s=String(v).toLowerCase(); if(s==="corner"||v===true||s==="on"||s==="show")return "corner"; if(s==="off"||v===false||s==="none"||s==="hide")return "off"; return null; }
function normImage(v){ if(v==null)return null; const s=String(v).toLowerCase(); return s==="right"?"right":s==="left"?"left":null; }
function normAlign(v){ if(v==null)return null; const s=String(v).toLowerCase(); return s==="top"?"top":(s==="center"||s==="centre"||s==="middle")?"center":null; }
function normIcons(v){ if(v==null)return null; const s=String(v).toLowerCase(); if(s==="all")return "all"; if(s==="off"||s==="none"||v===false)return "off"; if(v===true||s==="on"||s==="top"||s==="yes")return "top"; return null; }
const NORMALISERS={title:normTitle,section:normSection,image:normImage,align:normAlign,icons:normIcons};
function readKey(key,src){ if(!src||typeof src!=="object")return undefined; if(key in src)return src[key]; if(key==="title"&&"sidebar" in src)return src.sidebar; if(key==="image"&&"media" in src)return src.media; return undefined; }
function resolveSlideFrame(slideAttrs={},sectionDefaults={},deckDefaults={}){ const out={}; for(const key of Object.keys(FRAME_BUILTINS)){ const norm=NORMALISERS[key]; let value=null; for(const src of [slideAttrs,sectionDefaults,deckDefaults]){ const v=norm(readKey(key,src)); if(v!=null){value=v;break;} } out[key]=value!=null?value:FRAME_BUILTINS[key]; } return out; }
// ---- END MUST-MATCH ----

let n = 0; const ok = (m) => { n++; console.log("  ok " + m); };

// 1. empty → built-ins
assert.deepEqual(resolveSlideFrame({}, {}, {}), FRAME_BUILTINS); ok("empty → built-ins");
// 2. deck default applies
assert.equal(resolveSlideFrame({}, {}, { title: "side" }).title, "side"); ok("deck default");
// 3. section beats deck
assert.equal(resolveSlideFrame({}, { title: "top" }, { title: "side" }).title, "top"); ok("section > deck");
// 4. slide beats section + deck
assert.equal(resolveSlideFrame({ title: "off" }, { title: "top" }, { title: "side" }).title, "off"); ok("slide > all");
// 5. {sidebar} alias → title side
assert.equal(resolveSlideFrame({ sidebar: true }, {}, {}).title, "side"); ok("sidebar alias");
// 6. {media=right} alias → image right
assert.equal(resolveSlideFrame({ media: "right" }, {}, {}).image, "right"); ok("media alias");
// 7. icons on/all/off/absent
assert.equal(resolveSlideFrame({ icons: true }, {}, {}).icons, "top"); ok("icons true → top");
assert.equal(resolveSlideFrame({ icons: "all" }, {}, {}).icons, "all"); ok("icons all");
assert.equal(resolveSlideFrame({}, {}, { icons: "on" }).icons, "top"); ok("icons on(default) → top");
assert.equal(resolveSlideFrame({}, {}, {}).icons, "off"); ok("icons absent → off");
// 8. invalid value ignored → falls through to next source / built-in
assert.equal(resolveSlideFrame({ title: "bogus" }, {}, { title: "side" }).title, "side"); ok("invalid slide value ignored");

// 9. parseInlineMap — YAML inline-map parsing (replica used in 08-source-adapters.mjs)
function parseYamlScalarLocal(value) {
  const trimmed = String(value).trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (trimmed === "[]") return [];
  if (/^["'].*["']$/.test(trimmed)) return trimmed.slice(1, -1);
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}
function parseInlineMap(s) {
  const body = s.trim().replace(/^\{/, "").replace(/\}$/, "");
  const obj = {};
  for (const pair of body.split(",")) {
    const i = pair.indexOf(":"); if (i < 0) continue;
    obj[pair.slice(0, i).trim()] = parseYamlScalarLocal(pair.slice(i + 1).trim());
  }
  return obj;
}
assert.deepEqual(parseInlineMap("{ title: side, icons: on }"), { title: "side", icons: "on" }); ok("parseInlineMap basic");

console.log(`\nframe-resolution: all ${n} checks passed`);
