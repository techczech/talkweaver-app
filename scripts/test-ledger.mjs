// Tests for compiler/scripts/lib/13-slide-ledger.mjs (Slide Ledger core, ADR-0032).
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, mkdirSync as mkdirp, writeFileSync as writeF, readFileSync as readF, readdirSync as readdirF } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractIdSlides, normalizeDepth, mintId, ID_TOKEN_RE,
  formatVersion, parseVersion, versionFileName, listVersions, headVersion,
  recordOutlineSave, COALESCE_WINDOW_MS, sealOutline, whereUsed, sealSlideHead
} from "../compiler/scripts/lib/13-slide-ledger.mjs";

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`ok - ${name}`); }
  catch (e) { failures += 1; console.error(`FAIL - ${name}\n  ${e.message}`); }
}

const OUTLINE = [
  "# My Talk",
  "",
  "## Section one",
  "",
  "### First slide",
  "{id=ab12c} {statement}",
  "",
  "- point one",
  "",
  "### No id here",
  "",
  "- unstamped",
  "",
  "### Second slide {id=zz9y8}",
  "",
  "- heading-carried id",
  "",
  "#### Box inside",
  "",
  "- stays inside the block",
  "",
].join("\n");

check("extractIdSlides finds trigger-line and heading ids, skips unstamped", () => {
  const slides = extractIdSlides(OUTLINE);
  assert.equal(slides.length, 2);
  assert.equal(slides[0].id, "ab12c");
  assert.ok(slides[0].markdown.startsWith("### First slide"));
  assert.ok(slides[0].markdown.includes("- point one"));
  assert.ok(!slides[0].markdown.includes("### No id here"));
  assert.equal(slides[1].id, "zz9y8");
  // Heading-is-slide model (Task 8): every heading is its own separate slide now, so an unstamped
  // nested #### is its own (unledgered, since it carries no id) block — it never rides along
  // inside its parent's markdown the way pre-refactor ###-only scanning absorbed it.
  assert.ok(!slides[1].markdown.includes("#### Box inside"), "nested heading is its own block, not absorbed");
});

check("extractIdSlides returns duplicates (collision detection is the caller's job)", () => {
  const dup = "### A\n{id=same1}\n\n- a\n\n### B\n{id=same1}\n\n- b\n";
  assert.equal(extractIdSlides(dup).length, 2);
});

check("normalizeDepth shifts a #### block to ### with children", () => {
  const block = "#### Deep slide {id=q1w2e}\n\n- x\n\n##### Inner box\n\n- y";
  const out = normalizeDepth(block);
  assert.ok(out.startsWith("### Deep slide"));
  assert.ok(out.includes("#### Inner box"));
});

check("normalizeDepth leaves ### blocks alone", () => {
  const block = "### Fine {id=a}\n\n- x";
  assert.equal(normalizeDepth(block), block);
});

check("mintId avoids taken ids and matches the token alphabet", () => {
  const seq = [0.111, 0.111, 0.999];
  let i = 0;
  const rng = () => seq[Math.min(i++, seq.length - 1)];
  const first = mintId(rng);
  const second = mintId(rng, new Set([first]));
  assert.notEqual(second, first);
  assert.match(`{id=${first}}`, ID_TOKEN_RE);
});

const T0 = Date.UTC(2026, 6, 3, 10, 0, 0); // 2026-07-03T10:00:00Z

check("formatVersion/parseVersion round-trip incl. lineage and seal", () => {
  const src = {
    id: "ab12c", talk: "ai-history", outline: "ai-history/ai-history-outline.md",
    savedAt: T0, sealedBy: "publish", lineage: "zz9y8",
    markdown: "#### Deep {id=ab12c}\n\n- x",
  };
  const text = formatVersion(src);
  const back = parseVersion(text);
  assert.equal(back.id, "ab12c");
  assert.equal(back.talk, "ai-history");
  assert.equal(back.savedAt, T0);
  assert.equal(back.sealed, true);
  assert.equal(back.sealedBy, "publish");
  assert.equal(back.lineage, "zz9y8");
  assert.ok(back.markdown.startsWith("### Deep"), "body stored at canonical depth");
});

check("unsealed version parses sealed:false, no lineage key", () => {
  const text = formatVersion({ id: "a", talk: "t", outline: "t/t-outline.md", savedAt: T0, markdown: "### A {id=a}\n\n- x" });
  const back = parseVersion(text);
  assert.equal(back.sealed, false);
  assert.equal(back.lineage, null);
});

check("versionFileName is UTC, sortable, slug-suffixed", () => {
  assert.equal(versionFileName(T0, "ai-history"), "20260703-100000--ai-history.md");
});

check("listVersions/headVersion: newest first, empty dir tolerated", () => {
  const root = mkdtempSync(join(tmpdir(), "ledger-"));
  try {
    // Legacy dir must exist BEFORE the first ledger call for this vault: the
    // _ledger -> _SLIDE-VERSIONS migration is memoised per vault per process.
    const dir = join(root, "_ledger", "ab12c");
    mkdirp(dir, { recursive: true });
    writeF(join(dir, versionFileName(T0, "t1")), formatVersion({ id: "ab12c", talk: "t1", outline: "t1/t1-outline.md", savedAt: T0, markdown: "### A {id=ab12c}\n\n- v1" }));
    writeF(join(dir, versionFileName(T0 + 60_000, "t2")), formatVersion({ id: "ab12c", talk: "t2", outline: "t2/t2-outline.md", savedAt: T0 + 60_000, markdown: "### A {id=ab12c}\n\n- v2" }));
    assert.equal(headVersion(root, "n0dir"), null, "absent id tolerated");
    const versions = listVersions(root, "ab12c");
    assert.equal(versions.length, 2);
    assert.equal(versions[0].talk, "t2");
    assert.equal(headVersion(root, "ab12c").talk, "t2");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function vaultWith(outlineRel, text) {
  const root = mkdtempSync(join(tmpdir(), "vault-"));
  const abs = join(root, outlineRel);
  mkdirp(join(abs, ".."), { recursive: true });
  writeF(abs, text);
  return { root, abs };
}
const SLIDE = (body) => `# T\n\n## S\n\n### One\n{id=ab12c}\n\n- ${body}\n`;

check("first save creates a version; identical re-save is unchanged", () => {
  const { root, abs } = vaultWith("mytalk/mytalk-outline.md", SLIDE("v1"));
  try {
    const r1 = recordOutlineSave(root, abs, SLIDE("v1"), { now: T0 });
    assert.deepEqual(r1.versioned, ["ab12c"]);
    const r2 = recordOutlineSave(root, abs, SLIDE("v1"), { now: T0 + 1000 });
    assert.deepEqual(r2.unchanged, ["ab12c"]);
    assert.equal(listVersions(root, "ab12c").length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

check("edit within the window coalesces; after the window appends", () => {
  const { root, abs } = vaultWith("mytalk/mytalk-outline.md", SLIDE("v1"));
  try {
    recordOutlineSave(root, abs, SLIDE("v1"), { now: T0 });
    const r2 = recordOutlineSave(root, abs, SLIDE("v2"), { now: T0 + 60_000 });
    assert.deepEqual(r2.coalesced, ["ab12c"]);
    assert.equal(listVersions(root, "ab12c").length, 1);
    assert.ok(headVersion(root, "ab12c").markdown.includes("v2"));
    const r3 = recordOutlineSave(root, abs, SLIDE("v3"), { now: T0 + COALESCE_WINDOW_MS + 60_000 });
    assert.deepEqual(r3.versioned, ["ab12c"]);
    assert.equal(listVersions(root, "ab12c").length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

check("a different talk never coalesces another talk's head", () => {
  const a = vaultWith("talk-a/talk-a-outline.md", SLIDE("v1"));
  try {
    recordOutlineSave(a.root, a.abs, SLIDE("v1"), { now: T0 });
    const bAbs = join(a.root, "talk-b", "talk-b-outline.md");
    mkdirp(join(a.root, "talk-b"), { recursive: true });
    writeF(bAbs, SLIDE("v1 tweaked in b"));
    const r = recordOutlineSave(a.root, bAbs, SLIDE("v1 tweaked in b"), { now: T0 + 1000 });
    assert.deepEqual(r.versioned, ["ab12c"]);
    assert.equal(listVersions(a.root, "ab12c").length, 2);
  } finally { rmSync(a.root, { recursive: true, force: true }); }
});

check("in-outline id collision is reported and NOT versioned", () => {
  const dup = "### A\n{id=same1}\n\n- a\n\n### B\n{id=same1}\n\n- b\n";
  const { root, abs } = vaultWith("t/t-outline.md", dup);
  try {
    const r = recordOutlineSave(root, abs, dup, { now: T0 });
    assert.deepEqual(r.collisions, ["same1"]);
    assert.equal(listVersions(root, "same1").length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

check("lineageHints lands on the first version only", () => {
  const { root, abs } = vaultWith("t/t-outline.md", SLIDE("v1"));
  try {
    recordOutlineSave(root, abs, SLIDE("v1"), { now: T0, lineageHints: new Map([["ab12c", "parent"]]) });
    assert.equal(headVersion(root, "ab12c").lineage, "parent");
    recordOutlineSave(root, abs, SLIDE("v2"), { now: T0 + COALESCE_WINDOW_MS + 1000, lineageHints: new Map([["ab12c", "wrong"]]) });
    assert.equal(headVersion(root, "ab12c").lineage, null, "hint ignored once versions exist");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

check("lineage survives a coalesce", () => {
  const { root, abs } = vaultWith("t/t-outline.md", SLIDE("v1"));
  try {
    recordOutlineSave(root, abs, SLIDE("v1"), { now: T0, lineageHints: new Map([["ab12c", "parent"]]) });
    const r = recordOutlineSave(root, abs, SLIDE("v2"), { now: T0 + 60_000 });
    assert.deepEqual(r.coalesced, ["ab12c"]);
    assert.equal(listVersions(root, "ab12c").length, 1);
    assert.equal(headVersion(root, "ab12c").lineage, "parent", "coalesce carries the head's lineage forward");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

check("sealed head + same-second change appends, never clobbers the seal", () => {
  const { root, abs } = vaultWith("t/t-outline.md", SLIDE("v2"));
  try {
    const dir = join(root, "_ledger", "ab12c");
    mkdirp(dir, { recursive: true });
    writeF(join(dir, versionFileName(T0, "t")), formatVersion({ id: "ab12c", talk: "t", outline: "t/t-outline.md", savedAt: T0, sealedBy: "publish", markdown: "### One\n{id=ab12c}\n\n- v1" }));
    const r = recordOutlineSave(root, abs, SLIDE("v2"), { now: T0 });
    assert.deepEqual(r.versioned, ["ab12c"]);
    const versions = listVersions(root, "ab12c");
    assert.equal(versions.length, 2, "same-second save appends a second version");
    const sealed = versions.find((v) => v.sealed);
    assert.ok(sealed, "sealed version still present");
    assert.ok(sealed.markdown.includes("v1"), "sealed content untouched");
    assert.ok(headVersion(root, "ab12c").markdown.includes("v2"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

check("sealed head + identical content is unchanged", () => {
  const { root, abs } = vaultWith("t/t-outline.md", SLIDE("v1"));
  try {
    const dir = join(root, "_ledger", "ab12c");
    mkdirp(dir, { recursive: true });
    writeF(join(dir, versionFileName(T0, "t")), formatVersion({ id: "ab12c", talk: "t", outline: "t/t-outline.md", savedAt: T0, sealedBy: "publish", markdown: "### One\n{id=ab12c}\n\n- v1" }));
    const r = recordOutlineSave(root, abs, SLIDE("v1"), { now: T0 + 1000 });
    assert.deepEqual(r.unchanged, ["ab12c"]);
    assert.equal(listVersions(root, "ab12c").length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

check("sealOutline versions then seals the head; first seal wins", () => {
  const { root, abs } = vaultWith("t/t-outline.md", SLIDE("v1"));
  try {
    const r = sealOutline(root, abs, SLIDE("v1"), "publish", { now: T0 });
    assert.deepEqual(r.sealed, ["ab12c"]);
    const head = headVersion(root, "ab12c");
    assert.equal(head.sealedBy, "publish");
    sealOutline(root, abs, SLIDE("v1"), "present", { now: T0 + 1000 });
    assert.equal(headVersion(root, "ab12c").sealedBy, "publish", "first seal wins");
    // sealed head + later edit => append, not coalesce (proven via recordOutlineSave)
    const r2 = recordOutlineSave(root, abs, SLIDE("v2"), { now: T0 + 60_000 });
    assert.deepEqual(r2.versioned, ["ab12c"]);
    assert.equal(listVersions(root, "ab12c").length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

check("whereUsed finds every outline carrying the id, skips _ledger", () => {
  const { root } = vaultWith("talk-a/talk-a-outline.md", SLIDE("v1"));
  try {
    mkdirp(join(root, "talk-b"), { recursive: true });
    writeF(join(root, "talk-b", "talk-b-outline.md"), SLIDE("local tweak"));
    mkdirp(join(root, "talk-c"), { recursive: true });
    writeF(join(root, "talk-c", "talk-c-outline.md"), "### Unrelated\n{id=other0}\n\n- z\n");
    const hits = whereUsed(root, "ab12c");
    assert.deepEqual(hits.map((h) => h.talk).sort(), ["talk-a", "talk-b"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

import { duplicateSlide, duplicateSlideWithLineage, detachSlideId, listSlideBlocks, setSlideId, setListItemIcon } from "../compiler/scripts/lib/12-outline-edit.mjs";

// Heading-is-slide model: listSlideBlocks addresses EVERY ##–###### heading as its own block
// (children are separate blocks; the deck title # is a boundary only). {heading, occurrence} stays
// on the verbatim line, byte-compatible with the editor's getCursorListItemContext.
check("listSlideBlocks addresses any-depth headings; # is never a block", () => {
  const src = "# Deck\n## S\n### sub\n- s1\n#### card\n- c1\n- c2\n##### deep\n### tail\n";
  const blocks = listSlideBlocks(src);
  assert.deepEqual(blocks.map((b) => b.heading), ["## S", "### sub", "#### card", "##### deep", "### tail"]);
  assert.deepEqual(blocks.map((b) => b.title), ["S", "sub", "card", "deep", "tail"]);
  // a #### heading ENDS the ### block above it (each heading is its own slide now)
  const sub = blocks[1];
  assert.equal(src.split("\n")[sub.end], "#### card");
  // item indexing + icon write inside a #### block: c2 is item index 1 of "#### card"
  const stamped = setListItemIcon(src, { heading: "#### card", occurrence: 1 }, 1, "star");
  assert.ok(stamped.includes("- c2 {icon=star}"));
  assert.ok(stamped.includes("- c1\n"), "other items untouched");
});

const DUP_SRC = "### Alpha\n{id=ab12c} {statement}\n\n- a\n\n### Beta\n\n- unstamped\n";
const refOf = (text, i) => {
  const b = listSlideBlocks(text)[i];
  return { heading: b.heading, occurrence: b.occurrence };
};

check("duplicateSlideWithLineage mints a fresh id for the copy", () => {
  const { text, minted } = duplicateSlideWithLineage(DUP_SRC, refOf(DUP_SRC, 0), () => 0.123456789);
  assert.ok(minted && minted.fromId === "ab12c" && minted.newId !== "ab12c");
  const ids = [...text.matchAll(/\{id=([A-Za-z0-9_-]+)\}/g)].map((m) => m[1]);
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1]);
});

check("duplicate of an unstamped slide mints nothing", () => {
  const { text, minted } = duplicateSlideWithLineage(DUP_SRC, refOf(DUP_SRC, 1));
  assert.equal(minted, null);
  assert.equal((text.match(/### Beta/g) || []).length, 2);
});

check("duplicateSlide wrapper returns text and still de-duplicates the id", () => {
  const text = duplicateSlide(DUP_SRC, refOf(DUP_SRC, 0));
  const ids = [...text.matchAll(/\{id=([A-Za-z0-9_-]+)\}/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length);
});

check("detachSlideId swaps the id in place and reports old/new", () => {
  const r = detachSlideId(DUP_SRC, refOf(DUP_SRC, 0));
  assert.ok(r && r.oldId === "ab12c" && r.newId !== "ab12c");
  assert.ok(!r.text.includes("{id=ab12c}"));
  assert.equal(detachSlideId(DUP_SRC, refOf(DUP_SRC, 1)), null);
});

// ── setSlideId (ADR-0032 merge/unify: stamp a SUPPLIED id) ───────────────────

check("setSlideId replaces an existing Trigger-line id in place, keeps other triggers", () => {
  const out = setSlideId(DUP_SRC, refOf(DUP_SRC, 0), "zz9y8");
  assert.ok(out.includes("{id=zz9y8} {statement}"), "id token swapped in place on the Trigger line");
  assert.ok(!out.includes("{id=ab12c}"), "old id gone");
  const slides = extractIdSlides(out);
  assert.equal(slides.find((s) => s.markdown.startsWith("### Alpha")).id, "zz9y8", "extractIdSlides reports the supplied id");
});

check("setSlideId replaces an existing heading id in place (stays on the heading)", () => {
  const src = "### Alpha {id=ab12c}\n\n- a\n";
  const out = setSlideId(src, refOf(src, 0), "zz9y8");
  assert.equal(out, "### Alpha {id=zz9y8}\n\n- a\n");
  assert.equal(extractIdSlides(out)[0].id, "zz9y8");
});

check("setSlideId stamps an UNSTAMPED slide onto a fresh Trigger line", () => {
  const src = "### Beta\n\n- unstamped\n";
  const out = setSlideId(src, refOf(src, 0), "zz9y8");
  assert.equal(out, "### Beta\n{id=zz9y8}\n\n- unstamped\n");
  assert.equal(extractIdSlides(out)[0].id, "zz9y8", "extractIdSlides reports the supplied id");
});

check("setSlideId on an unstamped slide with an existing trigger line keeps the id its OWN group", () => {
  // The ADR-0032 id-loss trap: folding {id=…} into a shared {statement id=…} group hides it from
  // extractIdSlides. setSlideId must render {statement} {id=zz9y8} (own group), still matchable.
  const src = "### Gamma\n{statement}\n\n- x\n";
  const out = setSlideId(src, refOf(src, 0), "zz9y8");
  assert.ok(out.includes("{statement} {id=zz9y8}"), "id written as its own group beside {statement}");
  assert.equal(extractIdSlides(out)[0].id, "zz9y8", "extractIdSlides still reports the id");
});

check("setSlideId ignores a literal {id=…} in the BODY, stamps the Trigger line, loses no content", () => {
  // A slide ABOUT the {id=…} syntax: unstamped at the heading/Trigger line but with a body token.
  // setSlideId must NOT rewrite the body token (silent content loss) and must NOT treat it as
  // already-stamped — it stamps the Trigger line (own group) and leaves the body byte-for-byte.
  const src = "### Delta\n\n- a normal bullet\n- talking about {id=body1} in prose\n";
  const out = setSlideId(src, refOf(src, 0), "zz9y8");
  assert.equal(out, "### Delta\n{id=zz9y8}\n\n- a normal bullet\n- talking about {id=body1} in prose\n");
  assert.ok(out.includes("{id=body1}"), "body id token preserved byte-for-byte");
  assert.equal(extractIdSlides(out)[0].id, "zz9y8", "extractIdSlides reports the supplied id, not the body token");
});

// ── Fence-awareness + block-bounded trigger line (final review fixes) ────────

const FENCED_OUTLINE = [
  "### Fenced {id=fn1ce}",
  "",
  "```python",
  "# comment",
  "### not a heading",
  "```",
  "",
  "- after the fence",
  "",
  "### Next {id=nx2t0}",
  "",
  "- next body",
  "",
].join("\n");

check("extractIdSlides keeps fenced #-lines inside the block (no truncation)", () => {
  const slides = extractIdSlides(FENCED_OUTLINE);
  assert.equal(slides.length, 2);
  assert.equal(slides[0].id, "fn1ce");
  assert.ok(slides[0].markdown.includes("# comment"), "fenced comment stays in block");
  assert.ok(slides[0].markdown.includes("### not a heading"), "fenced ### is not a boundary");
  assert.ok(slides[0].markdown.includes("- after the fence"), "post-fence content stays in block");
  assert.equal(slides[1].id, "nx2t0");
  assert.ok(slides[1].markdown.startsWith("### Next"));
});

check("normalizeDepth never re-depths fenced lines", () => {
  const block = [
    "#### Deep {id=d33p1}",
    "",
    "```",
    "#### fenced-looking line",
    "```",
    "",
    "##### Inner box",
    "",
    "- y",
  ].join("\n");
  const out = normalizeDepth(block);
  assert.ok(out.startsWith("### Deep"), "root shifted to ###");
  assert.ok(out.includes("#### fenced-looking line"), "fenced line untouched");
  assert.ok(out.includes("#### Inner box"), "real sub-heading shifted");
});

const ADJACENT = "### Empty one\n### Real {id=zz9y8}\n\n- x\n";

check("adjacent stamped heading is not read as the previous block's trigger line", () => {
  const slides = extractIdSlides(ADJACENT);
  assert.equal(slides.length, 1);
  assert.equal(slides[0].id, "zz9y8");
  assert.ok(slides[0].markdown.startsWith("### Real"));
});

check("adjacent stamped heading: no spurious collision, id gets versioned", () => {
  const { root, abs } = vaultWith("t/t-outline.md", ADJACENT);
  try {
    const r = recordOutlineSave(root, abs, ADJACENT, { now: T0 });
    assert.deepEqual(r.collisions, []);
    assert.deepEqual(r.versioned, ["zz9y8"]);
    assert.equal(listVersions(root, "zz9y8").length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── mergeTriggerAtLine (⌘L id-loss fix, 2026-07-03) ─────────────────────────
import { mergeTriggerAtLine } from "../compiler/scripts/lib/12-outline-edit.mjs";

const MERGE_SRC = [
  "# Talk",
  "",
  "### Styled slide",
  '{id=ab12c} {contrast} {kicker="Hi there"}',
  "",
  "- point",
  "",
  "### Bare slide",
  "",
  "- other",
  "",
].join("\n");

check("mergeTriggerAtLine replaces same-key layout, keeps id and kicker verbatim", () => {
  const out = mergeTriggerAtLine(MERGE_SRC, 6, "{statement}");
  const line = out.split("\n")[3];
  assert.equal(line, '{id=ab12c} {kicker="Hi there"} {statement}');
  assert.ok(!out.includes("{contrast}"));
});

check("mergeTriggerAtLine creates the trigger line when missing", () => {
  const out = mergeTriggerAtLine(MERGE_SRC, 10, "{statement}");
  const lines = out.split("\n");
  assert.equal(lines[7], "### Bare slide");
  assert.equal(lines[8], "{statement}");
});

check("mergeTriggerAtLine dedupes explicit key=value against bare word", () => {
  const src = "### T\n{id=a1b2c} {layout=contrast}\n\n- x\n";
  const out = mergeTriggerAtLine(src, 4, "{statement}");
  assert.equal(out.split("\n")[1], "{id=a1b2c} {statement}");
});

check("mergeTriggerAtLine scrubs same-key heading tokens, keeps others", () => {
  const src = "### T {contrast} {frame=tight}\n{id=a1b2c}\n\n- x\n";
  const out = mergeTriggerAtLine(src, 4, "{statement}");
  const lines = out.split("\n");
  assert.equal(lines[0], "### T {frame=tight}");
  assert.equal(lines[1], "{id=a1b2c} {statement}");
});

check("mergeTriggerAtLine returns null with no heading above", () => {
  assert.equal(mergeTriggerAtLine("plain text\nno headings\n", 2, "{statement}"), null);
});

check("mergeTriggerAtLine collapses consecutive Trigger lines and keeps the final id", () => {
  const src = "### Not all Agents are Agents\n{sidebar} {id=hnwcx}\n{layout=media} {id=3plcu}\n\n- body\n";
  const out = mergeTriggerAtLine(src, 5, "{font-body=l}");
  assert.equal(
    out,
    "### Not all Agents are Agents\n{sidebar} {layout=media} {id=3plcu} {font-body=l}\n\n- body\n"
  );
});

// ── _SLIDE-VERSIONS store dir (renamed from _ledger, 2026-07-03) ─────────────
import { STORE_DIR } from "../compiler/scripts/lib/13-slide-ledger.mjs";
import { existsSync as existsF } from "node:fs";

check("store dir is _SLIDE-VERSIONS with a README; saves land there", () => {
  const { root, abs } = vaultWith("t/t-outline.md", SLIDE("v1"));
  try {
    recordOutlineSave(root, abs, SLIDE("v1"), { now: T0 });
    assert.equal(STORE_DIR, "_SLIDE-VERSIONS");
    assert.ok(existsF(join(root, "_SLIDE-VERSIONS", "ab12c")));
    assert.ok(existsF(join(root, "_SLIDE-VERSIONS", "README.md")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

check("legacy _ledger vault migrates to _SLIDE-VERSIONS on first ledger call", () => {
  const root = mkdtempSync(join(tmpdir(), "vault-"));
  try {
    const legacyDir = join(root, "_ledger", "mig01");
    mkdirp(legacyDir, { recursive: true });
    writeF(
      join(legacyDir, versionFileName(T0, "old-talk")),
      formatVersion({ id: "mig01", talk: "old-talk", outline: "old-talk/old-talk-outline.md", savedAt: T0, markdown: "### Old {id=mig01}\n\n- x" })
    );
    const versions = listVersions(root, "mig01");
    assert.equal(versions.length, 1);
    assert.equal(versions[0].talk, "old-talk");
    assert.ok(existsF(join(root, "_SLIDE-VERSIONS", "mig01")), "store renamed");
    assert.ok(!existsF(join(root, "_ledger")), "legacy dir gone");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── Task 1: comment-aware block scan, sealSlideHead, atomic writes ──────────

check("extractIdSlides: comment-hidden heading does not terminate a block", () => {
  const text = [
    "### Alpha {id=aaaaa}", "", "- alpha body", "",
    "<!--", "### ghost heading inside comment", "-->", "",
    "- more alpha", "", "### Beta {id=bbbbb}", "", "- beta",
  ].join("\n");
  const slides = extractIdSlides(text);
  assert.equal(slides.length, 2);
  assert.ok(slides[0].markdown.includes("- more alpha"), "block runs past the comment");
});

check("extractIdSlides: single-line comment heading ignored", () => {
  const text = ["### A {id=aaaaa}", "", "<!-- ### hidden -->", "- tail", "", "### B {id=bbbbb}"].join("\n");
  const slides = extractIdSlides(text);
  assert.ok(slides[0].markdown.includes("- tail"));
});

check("sealSlideHead seals only the given id", () => {
  const content = "### One {id=idone}\n\n- x\n\n### Two {id=idtwo}\n\n- y\n";
  const { root, abs } = vaultWith("t/talk-outline.md", content);
  try {
    recordOutlineSave(root, abs, content, { now: T0 });
    sealSlideHead(root, "idone", "adopt-replace");
    assert.equal(headVersion(root, "idone").sealed, true);
    assert.equal(headVersion(root, "idtwo").sealed, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

check("sealSlideHead returns false when the id has no versions", () => {
  const root = mkdtempSync(join(tmpdir(), "vault-"));
  try {
    assert.equal(sealSlideHead(root, "n0ver", "adopt-replace"), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

check("sealSlideHead on an already-sealed head returns false; first seal wins", () => {
  const content = "### One {id=idone}\n\n- x\n";
  const { root, abs } = vaultWith("t/talk-outline.md", content);
  try {
    recordOutlineSave(root, abs, content, { now: T0 });
    assert.equal(sealSlideHead(root, "idone", "first-reason"), true);
    assert.equal(sealSlideHead(root, "idone", "second-reason"), false);
    assert.equal(headVersion(root, "idone").sealedBy, "first-reason", "sealedBy not overwritten");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

check("version writes leave no .tmp files behind", () => {
  const { root, abs } = vaultWith("t/talk-outline.md", "### A {id=atomi}\n\n- a\n");
  try {
    recordOutlineSave(root, abs, "### A {id=atomi}\n\n- a\n", { now: T0 });
    const files = readdirF(join(root, "_SLIDE-VERSIONS", "atomi"));
    assert.ok(files.every((f) => !f.endsWith(".tmp")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── Task 8: all heading levels ledgered; function + hasContent per version ──

check("extractIdSlides walks ALL heading levels (## through ######), not just ###", () => {
  const text = [
    "## Top {id=aaaaa}", "", "- top body", "",
    "### Mid {id=bbbbb}", "", "- mid body", "",
    "###### Deepest {id=ccccc}", "", "- deep body", "",
  ].join("\n");
  const slides = extractIdSlides(text);
  assert.deepEqual(slides.map((s) => s.id), ["aaaaa", "bbbbb", "ccccc"]);
});

check("extractIdSlides: section node (has children) carries function: 'section'", () => {
  const text = ["## Section {id=sec01}", "", "### Child {id=chd01}", "", "- x", ""].join("\n");
  const slides = extractIdSlides(text);
  assert.equal(slides.find((s) => s.id === "sec01").function, "section");
  assert.equal(slides.find((s) => s.id === "chd01").function, "leaf");
});

check("extractIdSlides: title-only section has hasContent: false; a leaf with a bullet has hasContent: true", () => {
  const text = ["## Section {id=sec02}", "", "### Child {id=chd02}", "", "- has a bullet", ""].join("\n");
  const slides = extractIdSlides(text);
  assert.equal(slides.find((s) => s.id === "sec02").hasContent, false, "title-only section: no body of its own");
  assert.equal(slides.find((s) => s.id === "chd02").hasContent, true);
});

check("extractIdSlides: a leaf with only blank lines has hasContent: false", () => {
  const text = ["### Leaf {id=leaf01}", "", "", ""].join("\n");
  assert.equal(extractIdSlides(text)[0].hasContent, false);
});

check("recordOutlineSave: a saved version carries function and has_content in its frontmatter", () => {
  const text = ["## Section {id=sc003}", "", "### Child {id=ch003}", "", "- body text", ""].join("\n");
  const { root, abs } = vaultWith("t/t-outline.md", text);
  try {
    recordOutlineSave(root, abs, text, { now: T0 });
    const sectionHead = headVersion(root, "sc003");
    const childHead = headVersion(root, "ch003");
    assert.equal(sectionHead.function, "section");
    assert.equal(sectionHead.hasContent, false);
    assert.equal(childHead.function, "leaf");
    assert.equal(childHead.hasContent, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

check("recordOutlineSave: a save with an id-less #### heading stamps + versions it once stamped", () => {
  // recordOutlineSave itself never mints (that's the save-path job, stampMissingIds) — this proves
  // that once a #### heading IS stamped (by stampMissingIds, exercised below), the ledger records
  // it like any other level.
  const { text: stamped } = stampMissingIds("#### Deep\n\n- x\n");
  const id = stamped.match(/\{id=([A-Za-z0-9_-]+)\}/)[1];
  const { root, abs } = vaultWith("t/t-outline.md", stamped);
  try {
    const r = recordOutlineSave(root, abs, stamped, { now: T0 });
    assert.deepEqual(r.versioned, [id]);
    assert.equal(headVersion(root, id).function, "leaf");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── stampMissingIds (save-path stamping, Task 8) ─────────────────────────────
import { stampMissingIds, preferredIdsFromText, insertSlide, relevelBlock } from "../compiler/scripts/lib/12-outline-edit.mjs";

check("stampMissingIds stamps every id-less heading at any depth, leaves stamped ones alone", () => {
  const text = [
    "## Already {id=have1}", "", "- x", "",
    "### Unstamped", "", "- y", "",
    "###### Also unstamped", "", "- z", "",
  ].join("\n");
  const { text: out, stamped } = stampMissingIds(text);
  assert.equal(stamped.length, 2);
  const ids = extractIdSlides(out).map((s) => s.id);
  assert.equal(ids.length, 3);
  assert.ok(ids.includes("have1"), "pre-existing id untouched");
  assert.equal(new Set(ids).size, 3, "no collisions among stamped + pre-existing ids");
});

check("stampMissingIds is a no-op (empty stamped list) when every heading already has an id", () => {
  const text = "### One {id=aaaaa}\n\n- x\n\n#### Two {id=bbbbb}\n\n- y\n";
  const { text: out, stamped } = stampMissingIds(text);
  assert.equal(stamped.length, 0);
  assert.equal(out, text);
});

check("stampMissingIds writes a new Trigger line through setSlideId, never a raw splice (heading untouched)", () => {
  const text = "### Plain heading\n\n- body\n";
  const { text: out, stamped } = stampMissingIds(text);
  assert.equal(stamped.length, 1);
  assert.equal(out.split("\n")[0], "### Plain heading", "heading line byte-identical");
  assert.equal(out.split("\n")[1], `{id=${stamped[0].id}}`);
});

check("stampMissingIds matches the document's dominant EOL when minting a new Trigger line (CRLF doc)", () => {
  const text = "### Plain heading\r\n\r\n- body\r\n";
  const { text: out } = stampMissingIds(text);
  const lines = out.split("\n");
  assert.ok(lines[1].endsWith("\r"), "newly-created Trigger line matches the document's CRLF");
});

// ── Id churn guard (Task 8 follow-up): byte-stable ids across saves ──────────
// The renderer save flow is: buffer → save (main stamps + writes + returns stamped content) →
// buffer ADOPTS stamped content → next save. These tests prove ZERO new ids get minted on the
// second save in BOTH worlds: (a) adoption succeeded (stamping is a fixpoint), and (b) adoption
// was dropped because the doc moved on (main-process id reuse via preferredIdsFromText).

check("CRITICAL churn guard: save → adopt → second save mints ZERO new ids (fixpoint)", () => {
  const buffer = "## Sec\n\n### One\n\n- a\n\n#### Two\n\n- b\n";
  // save 1: main stamps
  const save1 = stampMissingIds(buffer);
  assert.equal(save1.stamped.length, 3);
  // renderer adopts save1.text; save 2 sends the ADOPTED buffer
  const save2 = stampMissingIds(save1.text);
  assert.equal(save2.stamped.length, 0, "second save mints ZERO new ids");
  assert.equal(save2.text, save1.text, "byte-stable across saves");
  // ledger view: recording the adopted buffer twice creates ONE version per id, no churn
  const { root, abs } = vaultWith("t/t-outline.md", save1.text);
  try {
    recordOutlineSave(root, abs, save1.text, { now: T0 });
    const r2 = recordOutlineSave(root, abs, save2.text, { now: T0 + 1000 });
    assert.equal(r2.unchanged.length, 3, "all ids unchanged on re-save");
    for (const s of save1.stamped) assert.equal(listVersions(root, s.id).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

check("CRITICAL churn guard: adoption dropped (stale buffer re-sent) → preferred ids from disk are REUSED, zero new ids", () => {
  const buffer = "## Sec\n\n### One\n\n- a\n\n#### Two\n\n- b\n";
  // save 1: disk now holds the stamped text; renderer adoption raced and was dropped
  const disk = stampMissingIds(buffer).text;
  // save 2: the UNSTAMPED buffer is sent again; main builds preferred from the on-disk file
  const preferred = preferredIdsFromText(disk);
  const save2 = stampMissingIds(buffer, undefined, { preferred });
  assert.equal(save2.text, disk, "second save converges on the on-disk stamped text byte-for-byte");
  const diskIds = new Set(extractIdSlides(disk).map((s) => s.id));
  for (const s of save2.stamped) assert.ok(diskIds.has(s.id), `reused disk id, never re-minted (${s.id})`);
});

check("preferredIdsFromText reads heading-carried and Trigger-line-carried ids, keyed by normalised heading + occurrence", () => {
  const disk = "### Alpha {id=head1}\n\n- a\n\n### Beta\n{id=trig1}\n\n- b\n\n### Beta\n{id=trig2}\n\n- c\n";
  const map = preferredIdsFromText(disk);
  assert.equal(map.get("### Alpha 1"), "head1");
  assert.equal(map.get("### Beta 1"), "trig1");
  assert.equal(map.get("### Beta 2"), "trig2", "second occurrence keyed separately");
});

check("preferred id already used elsewhere in the buffer → fresh mint, never a duplicate", () => {
  // The disk said "### Foo" should be id dup01 — but the buffer already carries dup01 on another
  // slide (e.g. user pasted it). Reuse would create a collision; a fresh id must be minted.
  const buffer = "### Foo\n\n- a\n\n### Bar {id=dup01}\n\n- b\n";
  const preferred = new Map([["### Foo 1", "dup01"]]);
  const { text: out, stamped } = stampMissingIds(buffer, undefined, { preferred });
  assert.equal(stamped.length, 1);
  assert.notEqual(stamped[0].id, "dup01", "taken preferred id is never duplicated");
  const ids = extractIdSlides(out).map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, "all ids unique after stamping");
});

// ── Blank-separated Trigger line (id-churn hotfix, 2026-07-10) ──────────────
// The corpus is full of `### Heading\n\n{…} {id=x}` — a {…}-only Trigger line separated from its
// heading by one or more BLANK lines (the migrate tool tolerated this, the compiler and tree parser
// tolerate it, but the save-path id readers used to inspect ONLY the line directly below the heading).
// The blind read declared the slide unstamped every save → stampMissingIds minted a fresh id →
// mergeTriggerAtLine (which DOES skip blanks) clobbered the real id with it → 2125x→bp5kv→aqst8 churn,
// a fresh _SLIDE-VERSIONS folder each time, and the slide's real ledger history was never recorded.

const BLANK_SEP = [
  "# Talk", "",
  "## Section", "",
  "{id=sect0}", "",
  "### You cannot build muscle this way", "",
  "{image-claim} {id=musc1}", "",
  "- some body", "",
].join("\n");

check("extractIdSlides reads a blank-separated Trigger line id (heading + BLANK + {id=…})", () => {
  const ids = extractIdSlides(BLANK_SEP).map((s) => s.id).sort();
  assert.deepEqual(ids, ["musc1", "sect0"], "both blank-separated ids are read, none missed");
});

check("CRITICAL churn: blank-separated form is byte-stable, mints ZERO ids, no churn folders (save-path composition x2)", () => {
  const { root, abs } = vaultWith("muscle/muscle-outline.md", BLANK_SEP);
  try {
    // The EXACT main-process save-path composition (src/main/index.ts writeOutline):
    // preferred (from on-disk) → stampMissingIds → write → recordOutlineSave.
    const savePath = (buffer, now) => {
      const preferred = preferredIdsFromText(readF(abs, "utf8"));
      const stamped = stampMissingIds(buffer, undefined, { preferred });
      const toWrite = stamped.text && stamped.stamped.length ? stamped.text : buffer;
      writeF(abs, toWrite);
      recordOutlineSave(root, abs, toWrite, { now });
      return { toWrite, minted: stamped.stamped.length };
    };
    const s1 = savePath(BLANK_SEP, T0);
    assert.equal(s1.minted, 0, "save 1 mints ZERO new ids");
    assert.equal(s1.toWrite, BLANK_SEP, "save 1 is byte-stable");
    const s2 = savePath(s1.toWrite, T0 + 1000);
    assert.equal(s2.minted, 0, "save 2 mints ZERO new ids");
    assert.equal(s2.toWrite, BLANK_SEP, "save 2 is byte-stable");
    // The real ids are ledgered (one version each); the churn produced no stray folders.
    assert.equal(listVersions(root, "musc1").length, 1, "muscle slide id ledgered under its own id");
    assert.equal(listVersions(root, "sect0").length, 1);
    const dirs = readdirF(join(root, "_SLIDE-VERSIONS")).filter((d) => d !== "README.md").sort();
    assert.deepEqual(dirs, ["musc1", "sect0"], "no churn-minted id folders");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

check("setSlideId replaces a blank-separated Trigger-line id in place (never clobbers via a fresh line)", () => {
  const src = "### Slide\n\n{image-claim} {id=musc1}\n\n- body\n";
  const out = setSlideId(src, refOf(src, 0), "zz9y8");
  assert.ok(out.includes("{image-claim} {id=zz9y8}"), "id swapped in place on the blank-separated Trigger line");
  assert.ok(!out.includes("{id=musc1}"), "old id gone, not duplicated");
  assert.equal(extractIdSlides(out)[0].id, "zz9y8");
});

check("stampMissingIds treats a blank-separated id as stamped (no-op, byte-stable)", () => {
  const src = "### Slide\n\n{image-claim} {id=musc1}\n\n- body\n";
  const { text: out, stamped } = stampMissingIds(src);
  assert.equal(stamped.length, 0, "already stamped via blank-separated Trigger line");
  assert.equal(out, src);
});

check("stampMissingIds sees an id anywhere in a consecutive Trigger-line block", () => {
  const src = "### Not all Agents are Agents\n{sidebar}\n{layout=media} {id=3plcu}\n\n- body\n";
  const { text: out, stamped } = stampMissingIds(src);
  assert.equal(stamped.length, 0, "lower Trigger-line id suppresses minting");
  assert.equal(out, src, "stamper leaves the hand-authored block byte-identical");
});

for (const lines of [
  ["### Trying and making skills", "{id=7ely8}", "{"],
  ["### Trying and making skills", "{", "{id=7ely8}"],
]) {
  check(`stampMissingIds sees an id across the mid-typing window (${JSON.stringify(lines.slice(1))})`, () => {
    const src = [...lines, "", "- body", ""].join("\n");
    const { text: out, stamped } = stampMissingIds(src, () => 0.12345);
    assert.equal(stamped.length, 0, "the existing id suppresses minting in either line order");
    assert.equal(out, src, "the mid-typing source remains byte-identical");
    assert.equal((out.match(/\{id=/g) || []).length, 1, "no second id is created");
  });
}

check("stampMissingIds parks an id-less slide until its unclosed brace closes", () => {
  const typing = "### Waiting for completion\n{\n\n- body\n";
  const parked = stampMissingIds(typing, () => 0.12345);
  assert.equal(parked.stamped.length, 0, "no mint while the author is mid-keystroke");
  assert.equal(parked.text, typing);

  const closed = typing.replace("\n{\n", "\n{statement}\n");
  const stamped = stampMissingIds(closed, () => 0.12345);
  assert.equal(stamped.stamped.length, 1, "mint resumes after the brace closes");
  assert.equal((stamped.text.match(/\{id=/g) || []).length, 1);
});

check("preferredIdsFromText reads a blank-separated Trigger-line id", () => {
  const disk = "### Slide\n\n{image-claim} {id=musc1}\n\n- body\n";
  assert.equal(preferredIdsFromText(disk).get("### Slide 1"), "musc1");
});

check("empty-write backstop compatibility: stamping an empty/heading-less payload is a no-op (cannot manufacture content)", () => {
  // The main-process backstop (isStructurallyEmptyOutline, 2026-07-05) runs BEFORE stamping and
  // refuses empty-over-nonempty; stamping must never turn a structurally-empty payload into
  // something that looks real. No headings in → no-op out, byte-identical.
  for (const payload of ["", "   \n\n  ", "just prose, no headings\n"]) {
    const { text: out, stamped } = stampMissingIds(payload);
    assert.equal(stamped.length, 0);
    assert.equal(out, payload);
  }
});

// ── insertSlide re-levelling (Task 8 step 4) ─────────────────────────────────

check("insertSlide legacy call (no opts) is unchanged: fixed ### stub, plain string return", () => {
  const text = "###### Deep parent {id=dp001}\n\n- x\n";
  const out = insertSlide(text, { heading: "###### Deep parent {id=dp001}", occurrence: 1 });
  assert.equal(typeof out, "string");
  assert.ok(out.includes("### New slide"), "stub stays at fixed ### regardless of context");
});

check("insertSlide re-levels a supplied block relative to the insertion point's parent: ## under ### parent → ####, subtree shifts uniformly", () => {
  const text = "### Parent {id=par001}\n\n- parent body\n";
  const ref = { heading: "### Parent {id=par001}", occurrence: 1 };
  const block = "## Child\n\nSome text\n\n### Grandchild\n\n- y\n";
  const { text: out, warning } = insertSlide(text, ref, undefined, { markdown: block });
  assert.equal(warning, undefined);
  assert.ok(out.includes("#### Child"), "root of inserted block becomes parent-depth+1");
  assert.ok(out.includes("##### Grandchild"), "nested heading shifts by the SAME delta (uniform subtree shift)");
});

check("insertSlide clamps a deepening-past-6 insert and returns a warning (never silent)", () => {
  const text = "###### Deep parent {id=dp002}\n\n- x\n";
  const ref = { heading: "###### Deep parent {id=dp002}", occurrence: 1 };
  const { text: out, warning } = insertSlide(text, ref, undefined, { markdown: "## Overflow\n\n- z\n" });
  assert.ok(warning && /clamp/i.test(warning), "warning present and mentions clamping");
  assert.ok(out.includes("###### Overflow"), "clamped to max depth 6, never past it");
});

check("insertSlide with a supplied block and no ref lands it at top level (depth 2)", () => {
  const out = insertSlide("### Existing\n\n- x\n", null, undefined, { markdown: "#### Anything\n\n- y\n" });
  assert.ok(out.text.includes("## Anything"), "no insertion-point context → top-level depth 2");
});

check("relevelBlock leaves a block with no leading heading (e.g. fenced-only) unchanged", () => {
  const block = "```\n### not a heading\n```\n";
  const { text: out, clamped } = relevelBlock(block, 4);
  assert.equal(out, block);
  assert.equal(clamped, false);
});

process.exit(failures ? 1 : 0);
