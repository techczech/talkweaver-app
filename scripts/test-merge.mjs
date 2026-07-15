// Tests for compiler/scripts/lib/15-slide-merge.mjs (duplicate merge engine, ADR-0032).
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, mkdirSync as mkdirp, writeFileSync as writeF, readFileSync as readF } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractIdSlides, normalizeDepth, listVersions, headVersion, recordOutlineSave, COALESCE_WINDOW_MS,
} from "../compiler/scripts/lib/13-slide-ledger.mjs";
import { mergeDuplicateSlides } from "../compiler/scripts/lib/15-slide-merge.mjs";

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`ok - ${name}`); }
  catch (e) { failures += 1; console.error(`FAIL - ${name}\n  ${e.message}`); }
}

const canon = (md) => normalizeDepth(md).replace(/\n+$/, "");
const T0 = Date.UTC(2026, 6, 4, 10, 0, 0); // 2026-07-04T10:00:00Z
const WIN = COALESCE_WINDOW_MS;

// A one-slide outline. `idToken` (e.g. "id=aa111") or null (unstamped). Copies built with the same
// body are byte-identical MODULO their id — exactly what a duplicate cluster feeds the merge.
const SL = (idToken, body = "- point one\n- point two") => {
  const trigger = idToken ? `{${idToken}} {statement}` : `{statement}`;
  return `# Talk\n\n## Section\n\n### Shared slide\n${trigger}\n\n${body}\n`;
};
const REF = (slug) => ({ outline: `${slug}/${slug}-outline.md`, heading: "### Shared slide", occurrence: 1 });

function newVault() {
  return mkdtempSync(join(tmpdir(), "vault-merge-"));
}
function addOutline(root, rel, text) {
  const abs = join(root, rel);
  mkdirp(join(abs, ".."), { recursive: true });
  writeF(abs, text);
  return abs;
}
const idOf = (root, slug) => {
  const s = extractIdSlides(readF(join(root, `${slug}/${slug}-outline.md`), "utf8"));
  return s.length ? s[0].id : null;
};

// ── minting when nothing is stamped ──────────────────────────────────────────

check("all-unstamped copies get a freshly minted shared id", () => {
  const root = newVault();
  try {
    addOutline(root, "a/a-outline.md", SL(null));
    addOutline(root, "b/b-outline.md", SL(null));
    const r = mergeDuplicateSlides(root, [REF("a"), REF("b")], { now: T0 });
    assert.equal(r.ok, true);
    assert.match(r.canonicalId, /^[A-Za-z0-9_-]{5}$/, "a 5-char id was minted");
    assert.deepEqual(r.failed, []);
    assert.equal(r.merged.length, 2);
    assert.deepEqual(r.merged.map((m) => m.oldId), [null, null], "unstamped copies report oldId null");
    assert.equal(idOf(root, "a"), r.canonicalId);
    assert.equal(idOf(root, "b"), r.canonicalId);
    // loss-proof: canonical's head version equals the stamped block content, byte-for-byte.
    const head = headVersion(root, r.canonicalId);
    assert.ok(head, "canonical id has a head version");
    assert.equal(head.markdown, canon(extractIdSlides(readF(join(root, "a/a-outline.md"), "utf8"))[0].markdown));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── reuse the id with the most history ───────────────────────────────────────

check("canonical is the id with the most ledger versions", () => {
  const root = newVault();
  try {
    const aAbs = addOutline(root, "a/a-outline.md", SL("id=aaaaa", "- draft one"));
    recordOutlineSave(root, aAbs, SL("id=aaaaa", "- draft one"), { now: T0 });
    const s2 = SL("id=aaaaa", "- draft two");
    writeF(aAbs, s2); recordOutlineSave(root, aAbs, s2, { now: T0 + WIN });
    const s3 = SL("id=aaaaa"); // final on disk, identical-modulo-id to b
    writeF(aAbs, s3); recordOutlineSave(root, aAbs, s3, { now: T0 + 2 * WIN });
    const bAbs = addOutline(root, "b/b-outline.md", SL("id=bbbbb"));
    recordOutlineSave(root, bAbs, SL("id=bbbbb"), { now: T0 });
    assert.equal(listVersions(root, "aaaaa").length, 3, "premise: aaaaa has 3 versions");
    assert.equal(listVersions(root, "bbbbb").length, 1, "premise: bbbbb has 1 version");

    const r = mergeDuplicateSlides(root, [REF("a"), REF("b")], { now: T0 + 3 * WIN });
    assert.equal(r.ok, true);
    assert.equal(r.canonicalId, "aaaaa", "the richer-history id wins");
    assert.equal(idOf(root, "b"), "aaaaa", "b re-stamped to the canonical id");
    assert.equal(idOf(root, "a"), "aaaaa", "a already canonical, unchanged");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

check("tie on version count breaks to the lexicographically first id", () => {
  const root = newVault();
  try {
    // Neither id was ever recorded → both 0 versions → tie → lexicographically first (aa111).
    addOutline(root, "z/z-outline.md", SL("id=zz999"));
    addOutline(root, "a/a-outline.md", SL("id=aa111"));
    const r = mergeDuplicateSlides(root, [REF("z"), REF("a")], { now: T0 });
    assert.equal(r.ok, true);
    assert.equal(r.canonicalId, "aa111");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── re-id distinct ids to the canonical, with lineage ────────────────────────

check("re-id distinct ids to the canonical, recording lineage on its first version", () => {
  const root = newVault();
  try {
    // Both stamped but NEVER recorded (0 versions each) → tie → aa111 wins. Process the CHANGED
    // copy (bb222) FIRST so canonical's first version carries the lineage hint.
    addOutline(root, "b/b-outline.md", SL("id=bb222"));
    addOutline(root, "a/a-outline.md", SL("id=aa111"));
    const r = mergeDuplicateSlides(root, [REF("b"), REF("a")], { now: T0 });
    assert.equal(r.ok, true);
    assert.equal(r.canonicalId, "aa111");
    assert.equal(idOf(root, "b"), "aa111");
    assert.equal(idOf(root, "a"), "aa111");
    const bMerged = r.merged.find((m) => m.outline === "b/b-outline.md");
    assert.equal(bMerged.oldId, "bb222", "the re-stamped copy reports its prior id");
    const versions = listVersions(root, "aa111");
    assert.ok(versions.some((v) => v.lineage === "bb222"), "canonical's first version records the prior id");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── the identity guard ───────────────────────────────────────────────────────

check("identity guard refuses a non-identical cluster and changes nothing", () => {
  const root = newVault();
  try {
    const aAbs = addOutline(root, "a/a-outline.md", SL("id=aa111", "- point one\n- point two"));
    const bAbs = addOutline(root, "b/b-outline.md", SL("id=bb222", "- a completely different body"));
    const before = [readF(aAbs, "utf8"), readF(bAbs, "utf8")];
    const r = mergeDuplicateSlides(root, [REF("a"), REF("b")], { now: T0 });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "not-identical");
    assert.equal(r.offending.length, 1);
    assert.equal(r.offending[0].outline, "b/b-outline.md");
    assert.equal(readF(aAbs, "utf8"), before[0], "outline a untouched");
    assert.equal(readF(bAbs, "utf8"), before[1], "outline b untouched");
    assert.equal(listVersions(root, "aa111").length, 0, "no version written on refusal");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

check("copies identical MODULO their id (heading id vs Trigger-line id vs none) still merge", () => {
  const root = newVault();
  try {
    addOutline(root, "a/a-outline.md", "### Shared slide {id=aa111}\n{statement}\n\n- point one\n- point two\n"); // id on heading
    addOutline(root, "b/b-outline.md", SL("id=bb222")); // id on Trigger line
    addOutline(root, "c/c-outline.md", SL(null)); // unstamped
    // A heading-stamped copy's VERBATIM heading line carries its id — exactly what the browser
    // passes (source_markdown's first line). The Trigger-line / unstamped copies keep the bare heading.
    const r = mergeDuplicateSlides(root, [
      { outline: "a/a-outline.md", heading: "### Shared slide {id=aa111}", occurrence: 1 },
      REF("b"),
      REF("c")
    ], { now: T0 });
    assert.equal(r.ok, true, "id position/absence differences do not defeat the guard");
    assert.equal(idOf(root, "a"), r.canonicalId);
    assert.equal(idOf(root, "b"), r.canonicalId);
    assert.equal(idOf(root, "c"), r.canonicalId);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── per-target isolation ─────────────────────────────────────────────────────

check("a missing target outline is isolated; the rest still merge", () => {
  const root = newVault();
  try {
    addOutline(root, "a/a-outline.md", SL(null));
    addOutline(root, "b/b-outline.md", SL(null));
    // Broken target FIRST so success proves the loop kept going.
    const r = mergeDuplicateSlides(
      root,
      [{ outline: "ghost/ghost-outline.md", heading: "### Shared slide", occurrence: 1 }, REF("a"), REF("b")],
      { now: T0 }
    );
    assert.equal(r.ok, true);
    assert.equal(r.failed.length, 1);
    assert.equal(r.failed[0].outline, "ghost/ghost-outline.md");
    assert.ok(r.failed[0].error, "failure carries an error message");
    assert.equal(r.merged.length, 2);
    assert.equal(idOf(root, "a"), r.canonicalId);
    assert.equal(idOf(root, "b"), r.canonicalId);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

check("a wrong-occurrence target that locates a different block is isolated, not mis-merged", () => {
  const root = newVault();
  try {
    addOutline(root, "a/a-outline.md", SL(null));
    addOutline(root, "b/b-outline.md", SL(null));
    // occurrence 2 does not exist in b (only one Shared slide) → located as a failure.
    const r = mergeDuplicateSlides(
      root,
      [REF("a"), { outline: "b/b-outline.md", heading: "### Shared slide", occurrence: 2 }],
      { now: T0 }
    );
    assert.equal(r.ok, true);
    assert.equal(r.merged.length, 1, "only the locatable copy merged");
    assert.equal(r.failed.length, 1, "the bad occurrence is isolated");
    assert.equal(idOf(root, "a"), r.canonicalId);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── the whole-cluster property across many talks ─────────────────────────────

check("post-merge every outline reports the SAME canonical id; head equals content (loss-proof)", () => {
  const root = newVault();
  try {
    for (const slug of ["a", "b", "c"]) addOutline(root, `${slug}/${slug}-outline.md`, SL(null));
    const r = mergeDuplicateSlides(root, [REF("a"), REF("b"), REF("c")], { now: T0 });
    assert.equal(r.ok, true);
    const ids = ["a", "b", "c"].map((slug) => idOf(root, slug));
    assert.deepEqual(ids, [r.canonicalId, r.canonicalId, r.canonicalId], "one shared id across all copies");
    const head = headVersion(root, r.canonicalId);
    assert.equal(
      head.markdown,
      canon(extractIdSlides(readF(join(root, "a/a-outline.md"), "utf8"))[0].markdown),
      "loss-proof: the head version equals the stamped block content"
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── F5: Phase-4 stamp read-back verification ─────────────────────────────────

check("a stamp that does not read back lands in failed, not merged", () => {
  const root = newVault();
  try {
    addOutline(root, "a/a-outline.md", SL(null));
    addOutline(root, "b/b-outline.md", SL(null));
    // Inject a broken stamp that leaves the text unchanged: the canonical id can never read back,
    // so BOTH targets must be reported FAILED — never a silent merged success.
    const r = mergeDuplicateSlides(root, [REF("a"), REF("b")], { now: T0, _setSlideId: (t) => t });
    assert.equal(r.ok, true, "the identity guard still passed");
    assert.equal(r.merged.length, 0, "nothing is claimed as merged");
    assert.equal(r.failed.length, 2, "both unreadable stamps are reported failed");
    assert.ok(r.failed.every((f) => /did not read back/.test(f.error)), "the failure names the read-back guard");
    assert.equal(idOf(root, "a"), null, "outline a left unstamped");
    assert.equal(idOf(root, "b"), null, "outline b left unstamped");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── blank-separated ids (id-churn hotfix stragglers, 2026-07-10) ─────────────
// blockIdOf used to read one-line-below only: a merge whose targets ALL carried blank-separated
// ids saw existingIds=[] and minted a fresh canonical id, then the (blank-tolerant) setSlideId
// replaced every REAL id in place — one-shot orphaning of those slides' ledger histories.

// Same body as SL, but the Trigger line is separated from its heading by a BLANK line.
const SLB = (idToken, body = "- point one\n- point two") => {
  const trigger = idToken ? `{${idToken}} {statement}` : `{statement}`;
  return `# Talk\n\n## Section\n\n### Shared slide\n\n${trigger}\n\n${body}\n`;
};

check("targets with ONLY blank-separated ids: canonical is an EXISTING id, zero mints", () => {
  const root = newVault();
  try {
    addOutline(root, "a/a-outline.md", SLB("id=aa111"));
    addOutline(root, "b/b-outline.md", SLB("id=bb222"));
    const r = mergeDuplicateSlides(root, [REF("a"), REF("b")], { now: T0 });
    assert.equal(r.ok, true);
    assert.ok(["aa111", "bb222"].includes(r.canonicalId), `canonical must be an EXISTING id, never a fresh mint (got ${r.canonicalId})`);
    assert.equal(r.canonicalId, "aa111", "zero-version tie breaks lexicographically");
    assert.equal(idOf(root, "a"), "aa111");
    assert.equal(idOf(root, "b"), "aa111", "blank-separated id replaced in place with the canonical");
    const bMerged = r.merged.find((m) => m.outline === "b/b-outline.md");
    assert.equal(bMerged.oldId, "bb222", "prior blank-separated id reported, not null");
    // the blank between heading and Trigger line survives the stamp (in-place token replace)
    assert.ok(readF(join(root, "b/b-outline.md"), "utf8").includes("### Shared slide\n\n{id=aa111} {statement}"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

check("blank-separated stamped + blank-separated unstamped cluster reuses the existing id", () => {
  const root = newVault();
  try {
    addOutline(root, "a/a-outline.md", SLB("id=aa111")); // blank-separated id
    addOutline(root, "b/b-outline.md", SLB(null));       // unstamped, same blank-separated shape
    const r = mergeDuplicateSlides(root, [REF("a"), REF("b")], { now: T0 });
    assert.equal(r.ok, true);
    assert.equal(r.canonicalId, "aa111", "the one existing (blank-separated) id wins over minting");
    assert.equal(idOf(root, "b"), "aa111", "unstamped copy stamped by merging into its blank-separated trigger line");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── input hardening ──────────────────────────────────────────────────────────

check("empty target list is refused, not crashed", () => {
  const root = newVault();
  try {
    const r = mergeDuplicateSlides(root, [], { now: T0 });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "no-targets");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

process.exit(failures ? 1 : 0);
