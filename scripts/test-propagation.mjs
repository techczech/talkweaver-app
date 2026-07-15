// Tests for compiler/scripts/lib/14-slide-propagation.mjs (propagation engine, ADR-0032).
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, mkdirSync as mkdirp, writeFileSync as writeF, readFileSync as readF } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recordOutlineSave, listVersions, headVersion, normalizeDepth, COALESCE_WINDOW_MS,
} from "../compiler/scripts/lib/13-slide-ledger.mjs";
import {
  replaceSlideBlock, slideStatus, lineDiff, adoptVersion,
} from "../compiler/scripts/lib/14-slide-propagation.mjs";

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`ok - ${name}`); }
  catch (e) { failures += 1; console.error(`FAIL - ${name}\n  ${e.message}`); }
}

const canon = (md) => normalizeDepth(md).replace(/\n+$/, "");
const T0 = Date.UTC(2026, 6, 3, 10, 0, 0); // 2026-07-03T10:00:00Z

function vaultWith(outlineRel, text) {
  const root = mkdtempSync(join(tmpdir(), "vault-"));
  const abs = join(root, outlineRel);
  mkdirp(join(abs, ".."), { recursive: true });
  writeF(abs, text);
  return { root, abs };
}
function addOutline(root, rel, text) {
  const abs = join(root, rel);
  mkdirp(join(abs, ".."), { recursive: true });
  writeF(abs, text);
  return abs;
}

// ── replaceSlideBlock ────────────────────────────────────────────────────────

const TEXT = [
  "# T", "", "## S", "",
  "### One {id=aa111}", "", "- old", "",
  "### Two {id=bb222}", "", "- keep", "",
].join("\n");

check("replaces only the target block, byte-identical elsewhere", () => {
  const out = replaceSlideBlock(TEXT, "aa111", "### One improved {id=aa111}\n\n- new");
  assert.equal(out, [
    "# T", "", "## S", "",
    "### One improved {id=aa111}", "", "- new", "",
    "### Two {id=bb222}", "", "- keep", "",
  ].join("\n"));
});

check("re-depths a ### ledger version into a #### target block", () => {
  const deep = [
    "# T", "", "## S", "",
    "#### Nested {id=cc333}", "", "- old", "",
    "##### Inner", "", "- x", "",
    "### Plain", "", "- after", "",
  ].join("\n");
  const out = replaceSlideBlock(deep, "cc333", "### Nested {id=cc333}\n\n- new\n\n#### Inner\n\n- y");
  assert.ok(out.includes("#### Nested {id=cc333}"), "root re-depthed to the target's ####");
  assert.ok(out.includes("##### Inner"), "child heading shifted with it");
  assert.ok(out.includes("- new") && !out.includes("- old"));
  assert.ok(out.includes("### Plain\n\n- after"), "following ### block untouched");
});

check("returns null when id absent", () => {
  assert.equal(replaceSlideBlock(TEXT, "zzzzz", "### X\n\n- y"), null);
});

check("id on Trigger line (not heading) still found", () => {
  const src = "# T\n\n### One\n{id=tt555} {statement}\n\n- old\n";
  const out = replaceSlideBlock(src, "tt555", "### One\n{id=tt555} {statement}\n\n- new");
  assert.equal(out, "# T\n\n### One\n{id=tt555} {statement}\n\n- new\n");
});

// ── slideStatus ──────────────────────────────────────────────────────────────

const SLIDE = (body) => `# T\n\n## S\n\n### One\n{id=ab12c}\n\n- ${body}\n`;
const BLOCK = (body) => `### One\n{id=ab12c}\n\n- ${body}`; // canonical form of SLIDE's block

check("identical / behind / diverged judged against ledger history", () => {
  const { root, abs } = vaultWith("talk-a/talk-a-outline.md", SLIDE("v1"));
  try {
    recordOutlineSave(root, abs, SLIDE("v1"), { now: T0 });
    writeF(abs, SLIDE("v2"));
    recordOutlineSave(root, abs, SLIDE("v2"), { now: T0 + COALESCE_WINDOW_MS + 1000 });
    addOutline(root, "talk-b/talk-b-outline.md", SLIDE("v1")); // behind
    addOutline(root, "talk-c/talk-c-outline.md", SLIDE("local edit")); // diverged
    const v2 = headVersion(root, "ab12c").markdown;
    assert.equal(v2, BLOCK("v2"), "test premise: head is v2");
    const rows = slideStatus(root, "ab12c", v2);
    assert.equal(rows.length, 3);
    const byTalk = Object.fromEntries(rows.map((r) => [r.talk, r]));
    assert.equal(byTalk["talk-a"].status, "identical");
    assert.equal(byTalk["talk-b"].status, "behind");
    assert.equal(byTalk["talk-c"].status, "diverged");
    assert.equal(byTalk["talk-a"].outline, "talk-a/talk-a-outline.md");
    assert.ok(byTalk["talk-c"].currentMarkdown.includes("local edit"));
    assert.equal(typeof byTalk["talk-a"].headingLine, "number");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── blank-separated trigger line (id-churn hotfix stragglers, 2026-07-10) ────
// The block locator's one-line-below fallback read used to miss a `{id=…}` separated from its
// heading by a blank line, so adopt/status on such a block reported "not in text" (fail-safe but
// wrong). Both paths now use the shared blank-tolerant read (idLineIndex).

const SLIDE_BLANK = (body) => `# T\n\n## S\n\n### One\n\n{id=ab12c} {statement}\n\n- ${body}\n`;

check("status + adopt find a blank-separated-id block", () => {
  const { root, abs } = vaultWith("talk-a/talk-a-outline.md", SLIDE_BLANK("v1"));
  try {
    recordOutlineSave(root, abs, SLIDE_BLANK("v1"), { now: T0 });
    const v1 = headVersion(root, "ab12c").markdown;
    assert.ok(v1.includes("- v1"), "test premise: blank-separated block was ledgered");
    // status: the blank-separated block is FOUND and judged identical, not skipped as "not in text"
    const rows = slideStatus(root, "ab12c", v1);
    assert.equal(rows.length, 1, "blank-separated block found by status");
    assert.equal(rows[0].status, "identical");
    // adopt: a new version replaces the blank-separated block in place, byte-precise elsewhere
    const v2 = "### One\n\n{id=ab12c} {statement}\n\n- v2";
    const r = adoptVersion(root, "ab12c", v2, ["talk-a/talk-a-outline.md"], { now: T0 + 1000 });
    assert.deepEqual(r.failed, [], "adopt does not report the blank-separated block as missing");
    assert.equal(r.replaced.length, 1);
    const after = readF(abs, "utf8");
    assert.ok(after.includes("- v2"), "outline rewritten with the adopted version");
    assert.ok(after.startsWith("# T\n\n## S\n"), "bytes outside the block untouched");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

check("replaceSlideBlock locates a deeper blank-separated-id block (fallback path)", () => {
  // A #### root block: locateBlock's fallback scan handles re-indented placements; its id read must
  // tolerate the blank-separated Trigger line too.
  const src = "# T\n\n#### Deep\n\n{id=dd444}\n\n- old\n\n### Plain\n\n- after\n";
  const out = replaceSlideBlock(src, "dd444", "### Deep\n\n{id=dd444}\n\n- new");
  assert.ok(out !== null, "blank-separated id found");
  assert.ok(out.includes("#### Deep\n\n{id=dd444}\n\n- new"), "replaced at the block's own depth");
  assert.ok(out.includes("### Plain\n\n- after"), "following block untouched");
});

// ── lineDiff ─────────────────────────────────────────────────────────────────

check("same/del/add classification on a small edit", () => {
  assert.deepEqual(lineDiff("a\nb\nc", "a\nx\nc"), [
    { kind: "same", text: "a" },
    { kind: "del", text: "b" },
    { kind: "add", text: "x" },
    { kind: "same", text: "c" },
  ]);
});

check("pure addition and pure deletion", () => {
  assert.deepEqual(lineDiff("a", "a\nb"), [
    { kind: "same", text: "a" },
    { kind: "add", text: "b" },
  ]);
  assert.deepEqual(lineDiff("a\nb", "b"), [
    { kind: "del", text: "a" },
    { kind: "same", text: "b" },
  ]);
});

// ── adoptVersion — THE loss-proof property ───────────────────────────────────

check("diverged target content is versioned before being replaced", () => {
  const { root, abs } = vaultWith("talk-a/talk-a-outline.md", SLIDE("v1"));
  try {
    recordOutlineSave(root, abs, SLIDE("v1"), { now: T0 });
    writeF(abs, SLIDE("v2"));
    recordOutlineSave(root, abs, SLIDE("v2"), { now: T0 + COALESCE_WINDOW_MS + 1000 });
    addOutline(root, "talk-c/talk-c-outline.md", SLIDE("diverged, never saved"));
    const v2 = headVersion(root, "ab12c").markdown;
    const r = adoptVersion(root, "ab12c", v2, ["talk-c/talk-c-outline.md"], { now: T0 + COALESCE_WINDOW_MS + 2000 });
    assert.deepEqual(r.failed, []);
    assert.deepEqual(r.replaced, [{ talk: "talk-c", outline: "talk-c/talk-c-outline.md" }]);
    const versions = listVersions(root, "ab12c");
    const preserved = versions.find((v) => v.markdown === BLOCK("diverged, never saved"));
    assert.ok(preserved, "diverged content versioned before replacement");
    assert.equal(preserved.sealedBy, "replaced-by-adoption");
    assert.equal(headVersion(root, "ab12c").markdown, BLOCK("v2"), "adopted state is head");
    assert.ok(readF(join(root, "talk-c/talk-c-outline.md"), "utf8").includes("- v2"), "outline rewritten");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

check("adoption within the coalesce window still preserves the replaced version", () => {
  const { root, abs } = vaultWith("talk-a/talk-a-outline.md", SLIDE("v1"));
  try {
    recordOutlineSave(root, abs, SLIDE("v1"), { now: T0 });
    const cAbs = addOutline(root, "talk-c/talk-c-outline.md", SLIDE("diverged and saved"));
    const tSave = T0 + COALESCE_WINDOW_MS + 1000;
    recordOutlineSave(root, cAbs, SLIDE("diverged and saved"), { now: tSave });
    const v1 = listVersions(root, "ab12c").find((v) => v.markdown === BLOCK("v1")).markdown;
    // Adopt v1 into talk-c ten minutes after C's save — INSIDE the coalesce
    // window. Without sealSlideHead the post-adoption record would coalesce
    // over C's diverged head and destroy it. This is the trap ADR-0032's
    // ordering exists for.
    const r = adoptVersion(root, "ab12c", v1, ["talk-c/talk-c-outline.md"], { now: tSave + 600_000 });
    assert.deepEqual(r.failed, []);
    const versions = listVersions(root, "ab12c");
    const preserved = versions.find((v) => v.markdown === BLOCK("diverged and saved"));
    assert.ok(preserved, "replaced version survived inside the coalesce window");
    assert.equal(preserved.sealedBy, "replaced-by-adoption");
    assert.equal(headVersion(root, "ab12c").markdown, BLOCK("v1"), "adopted state is head");
    assert.ok(readF(cAbs, "utf8").includes("- v1"), "outline carries the adopted version");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

check("one unwritable target does not abort the others", () => {
  const { root, abs } = vaultWith("talk-a/talk-a-outline.md", SLIDE("v1"));
  try {
    recordOutlineSave(root, abs, SLIDE("v1"), { now: T0 });
    addOutline(root, "talk-b/talk-b-outline.md", SLIDE("b local"));
    const v1 = headVersion(root, "ab12c").markdown;
    // Broken target FIRST so success proves the loop kept going.
    const r = adoptVersion(root, "ab12c", v1,
      ["ghost/ghost-outline.md", "talk-b/talk-b-outline.md"], { now: T0 + 1000 });
    assert.equal(r.failed.length, 1);
    assert.equal(r.failed[0].talk, "ghost");
    assert.equal(r.failed[0].outline, "ghost/ghost-outline.md");
    assert.ok(r.failed[0].error, "failure carries an error message");
    assert.deepEqual(r.replaced, [{ talk: "talk-b", outline: "talk-b/talk-b-outline.md" }]);
    assert.ok(readF(join(root, "talk-b/talk-b-outline.md"), "utf8").includes("- v1"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

check("target missing the id fails cleanly without sealing the head", () => {
  const { root, abs } = vaultWith("talk-a/talk-a-outline.md", SLIDE("v1"));
  try {
    recordOutlineSave(root, abs, SLIDE("v1"), { now: T0 });
    addOutline(root, "talk-d/talk-d-outline.md", "### Other {id=zz9y8}\n\n- z\n");
    const v1 = headVersion(root, "ab12c").markdown;
    const r = adoptVersion(root, "ab12c", v1, ["talk-d/talk-d-outline.md"], { now: T0 + 1000 });
    assert.equal(r.replaced.length, 0);
    assert.equal(r.failed.length, 1);
    assert.equal(headVersion(root, "ab12c").sealed, false, "no-op adoption must not seal the head");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

process.exit(failures ? 1 : 0);
