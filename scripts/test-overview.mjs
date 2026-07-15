// Pure overview-logic guard. Loads real runtime source. Run: node scripts/test-overview.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "compiler", "assets", "runtime", "overview.js"), "utf8");
const { rankSlides, deriveSlideStatus, preferredOverviewRow, clampOverviewHighlight } = new Function(`${src}\nreturn { rankSlides, deriveSlideStatus, preferredOverviewRow: typeof preferredOverviewRow === "function" ? preferredOverviewRow : null, clampOverviewHighlight: typeof clampOverviewHighlight === "function" ? clampOverviewHighlight : null };`)();

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

const slides = [
  { index: 0, title: "Intro", section: "Start", subsection: "", body: "welcome", notes: "" },
  { index: 1, title: "Method notes", section: "Body", subsection: "", body: "we used a survey method", notes: "mention sample" },
  { index: 2, title: "Results", section: "Body", subsection: "", body: "the method produced clear method output", notes: "" },
];

// empty query -> all in order
ok("empty query returns all", JSON.stringify(rankSlides("", slides)) === "[0,1,2]");

// title match ranks above body-only match: query "method" hits slide1 title and slide2 body
{
  const r = rankSlides("method", slides);
  ok("title match first", r[0] === 1);           // "Method notes" title beats body-only
  ok("body match included after", r.includes(2));
}

// Carousel child titles rank their parent at title strength while preserving the public
// parent-index return contract.
{
  const data = [
    { index: 0, title: "Alpha", section: "", subsection: "", body: "", notes: "", subs: [{ title: "Deep method", subIndex: 0, body: "" }] },
    { index: 1, title: "Method parent", section: "", subsection: "", body: "", notes: "", subs: [] },
  ];
  ok("child title prefix ranks parent first", rankSlides("deep", data)[0] === 0);
  ok("child title prefix uses title-level score", rankSlides("method", data)[0] === 1);
}

{
  const data = [
    { index: 0, title: "Alpha", section: "", subsection: "", body: "", notes: "", subs: [{ title: "A deep method", subIndex: 0, body: "" }] },
    { index: 1, title: "Method parent", section: "", subsection: "", body: "", notes: "", subs: [] },
  ];
  const ranked = rankSlides("deep", data);
  ok("child title substring surfaces parent", ranked.includes(0));
  ok("ranking retains parent index array", ranked.every(Number.isInteger));
}

ok("missing subs tolerated", JSON.stringify(rankSlides("intro", slides)) === "[0]");

{
  const data = [
    { index: 0, title: "Parent", section: "", subsection: "", body: "", notes: "", subs: [{ title: "Alpha child", subIndex: 0 }, { title: "Unique child needle", subIndex: 1 }] },
  ];
  ok("preferred overview helper present", typeof preferredOverviewRow === "function");
  if (preferredOverviewRow) {
    ok("unique child-title query prefers child row", JSON.stringify(preferredOverviewRow("needle", data, [0])) === '{"index":0,"subIndex":1}');
    ok("ambiguous child-title query retains parent default", JSON.stringify(preferredOverviewRow("child", data, [0])) === '{"index":0}');
  }
}

ok("highlight clamp helper present", typeof clampOverviewHighlight === "function");
if (clampOverviewHighlight) {
  ok("collapse clamps child highlight to parent row", clampOverviewHighlight(2, 1) === 0);
  ok("valid highlight survives rebuild", clampOverviewHighlight(1, 3) === 1);
}

// prefix beats substring
{
  const data = [
    { index: 0, title: "Overview of methods", section: "", subsection: "", body: "", notes: "" },
    { index: 1, title: "Method", section: "", subsection: "", body: "", notes: "" },
  ];
  ok("prefix beats substring", rankSlides("method", data)[0] === 1);
}

// notes-only match still surfaces (weak)
ok("notes-only surfaces", rankSlides("sample", slides).includes(1));

// no match -> empty
ok("no match empty", rankSlides("zzz", slides).length === 0);

// deriveSlideStatus
{
  const ctx = { shown: new Set([0, 1, 4]), skippedExplicit: new Set([3]), maxShown: 4 };
  ok("shown", deriveSlideStatus(0, ctx).status === "shown");
  ok("explicit skip", deriveSlideStatus(3, ctx).status === "skipped" && deriveSlideStatus(3, ctx).reason === "explicit");
  ok("jumped gap", deriveSlideStatus(2, ctx).status === "skipped" && deriveSlideStatus(2, ctx).reason === "jumped");
  ok("unseen beyond maxShown", deriveSlideStatus(5, ctx).status === "unseen");
}

console.log(`test-overview: ${passed} checks passed`);
