// DECK STABILITY GUARD. Records the COMPLETE ordered icon-candidate list for every corpus item
// and fails if an item that resolves today ever resolves differently.
//
// THE INVARIANT. If an item's recorded candidate list was NON-EMPTY, the complete ordered list
// must stay identical: a change at any position, and any change in length, is a failure. Only an
// item that resolved to NOTHING may acquire candidates. That is the one thing a genuine fallback
// tier (Tabler, Simple Icons) is allowed to do, because it is wired to contribute only when the
// existing sets produced nothing. A diff here is the signal that a new tier has been wired as a
// PEER of Lucide/svgl instead of below them.
//
// WHY THE WHOLE LIST AND NOT A TOP-N PREFIX. The top candidate is not "what renders".
// assignFeatureIconsV3 walks DOWN the whole candidate array whenever the top glyph is already
// bound to another concept deck-wide (`iconFree`) or already showing on the same slide
// (`usableHere`). Every position can therefore reach a real slide, so an APPENDED candidate is as
// visible as a spliced one, and anything inserted below whatever depth a prefix rule picked is
// invisible to that rule. Only the entire list is a sound record, and comparing it exactly is
// both simpler and strictly stronger than any prefix.
//
// RECORD SHAPE, per item: [candidateCount, hash of the complete ordered key list, …up to three
// leading keys]. Count and hash carry the comparison; the keys are a diagnostic prefix so failure
// messages and a hand read of the baseline say something human. They are never compared.
//
//   node scripts/test-icon-parity.mjs                  # check against the golden file
//   node scripts/test-icon-parity.mjs --update-golden  # re-record the COMMITTED golden file
//   TW_PARITY_VAULT=<path> node scripts/test-icon-parity.mjs
//                                                     # also sweep the real outline Vault
//   TW_PARITY_VAULT=<path> node scripts/test-icon-parity.mjs --update-vault
//                                                     # write the Vault baseline (only if absent)
//   … --update-vault --force-vault-baseline           # overwrite an EXISTING Vault baseline
//
// THE VAULT BASELINE IS IRREPLACEABLE. It records how ~6,400 real outlines resolve BEFORE any new
// tier lands; once a tier is wired it can never be recaptured. It is git-ignored, so an accidental
// overwrite leaves no diff and nothing to recover from. Hence the refusal to overwrite without an
// explicit flag, and hence golden and Vault have SEPARATE update flags.
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve, dirname, relative } from "node:path";
import { createHash } from "node:crypto";
import { iconCandidatesV3, classifyFeatureList } from "../compiler/scripts/lib/05-icons.mjs";

// 3 = [count, hash, …diagnostic keys] per item, exact whole-list comparison.
// 2 = top-3 key array, prefix comparison. Baselines below 3 are rejected as stale.
const FORMAT = 3;
const DIAG_KEYS = 3; // how many keys to keep for reading; cosmetic, never compared
const OVERWRITE_VAULT_FLAG = "--force-vault-baseline";

const corpusPath = resolve("scripts/fixtures/icon-parity-corpus.json");
const goldenPath = resolve("scripts/fixtures/icon-parity-golden.json");
const vaultBaselinePath = resolve(".superpowers/icon-parity-vault-baseline.json");

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
if (has("--update")) {
  console.error(
    "--update is gone. It wrote BOTH the committed golden file and the irreplaceable, git-ignored\n" +
    "Vault baseline in one stroke. Use --update-golden or --update-vault (see the header)."
  );
  process.exit(2);
}
const updateGolden = has("--update-golden");
const updateVault = has("--update-vault");

// --- prototype-safe records ----------------------------------------------------------------
// A corpus entry or a Vault bullet literally reading "constructor", "__proto__", "toString" or
// "valueOf" must behave like any other string. Maps internally; Object.create(null) on the way
// out to JSON; Object.hasOwn on the way back in.
const toRecord = (map) => Object.assign(Object.create(null), Object.fromEntries(map));
const fromRecord = (obj) => {
  const m = new Map();
  for (const k of Object.keys(obj)) if (Object.hasOwn(obj, k)) m.set(k, obj[k]);
  return m;
};
const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 1)}\n`);
};

// --- resolution ------------------------------------------------------------------------------
const recordCache = new Map();
const recordFor = (keys) => [
  keys.length,
  createHash("sha256").update(JSON.stringify(keys)).digest("hex").slice(0, 12),
  ...keys.slice(0, DIAG_KEYS),
];
const resolveRecord = (text) => {
  let v = recordCache.get(text);
  if (v === undefined) {
    v = recordFor(iconCandidatesV3(text).map((c) => c.key));
    recordCache.set(text, v);
  }
  return v;
};

const countOf = (rec) => (Array.isArray(rec) ? rec[0] : 0);
const hashOf = (rec) => (Array.isArray(rec) ? rec[1] : "");
const keysOf = (rec) => (Array.isArray(rec) ? rec.slice(2) : []);

// "same" — the complete candidate list is unchanged.
// "filled" — the item recorded NO candidates and now has some. The one legitimate fallback move.
// "changed" — a non-empty list is no longer identical. That is a peer tier, and it is a failure.
const compareRecords = (was, now) => {
  if (!Array.isArray(was) || !Array.isArray(now)) return "changed";
  if (countOf(was) === countOf(now) && hashOf(was) === hashOf(now)) return "same";
  return countOf(was) === 0 ? "filled" : "changed";
};

const fmt = (rec) => {
  const n = countOf(rec);
  if (!n) return "(none)";
  const keys = keysOf(rec);
  return `${n} candidate(s): ${keys.join(" | ")}${n > keys.length ? " | …" : ""}`;
};

// Returns the parsed baseline, or null when it is absent or in an older format. A stale format is
// fatal on a CHECK run — an old record cannot answer the exact question this guard now asks, so
// silently checking against it would be worse than not checking. On an update run it is tolerated
// and the file is re-recorded, subject to the same overwrite protection as any other rewrite.
const readBaseline = (path, what, tolerateStale) => {
  let raw;
  try { raw = JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
  if (raw && raw.format === FORMAT) return raw;
  const msg = `${what} at ${path} is in an old format (recorded as ${raw ? raw.format : "unreadable"}, now ${FORMAT}). It cannot answer the whole-list question.`;
  if (tolerateStale) { console.log(`${msg} Re-recording.`); return null; }
  console.error(`${msg}\nRe-record it (see the header) before trusting this guard.`);
  process.exit(2);
  return null;
};

// --- committed corpus --------------------------------------------------------------------
const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));
const current = new Map(corpus.map((t) => [t, resolveRecord(t)]));

let fail = 0;

// Compare FIRST, always — including in update mode, so "review the diff" has machine support.
const compareCorpus = (golden) => {
  let changed = 0;
  let filled = 0;
  let gone = 0;
  for (const [text, was] of golden) {
    const now = current.get(text);
    // A corpus entry vanishing shrinks the guard's OWN test surface — that is corpus erosion, not
    // content drift, and the guard's entire power lives in that surface. It fails as loudly as an
    // unreviewed new entry does.
    if (now === undefined) { console.error(`GONE FROM CORPUS: ${JSON.stringify(text)}`); gone += 1; continue; }
    const verdict = compareRecords(was, now);
    if (verdict === "same") continue;
    if (verdict === "filled") {
      console.log(`  filled: ${JSON.stringify(text)}\n    was: ${fmt(was)}\n    now: ${fmt(now)}`);
      filled += 1;
      continue;
    }
    console.error(`CHANGED: ${JSON.stringify(text)}\n    was: ${fmt(was)}\n    now: ${fmt(now)}`);
    changed += 1;
  }
  let added = 0;
  for (const text of corpus) if (!golden.has(text)) added += 1;
  return { changed, filled, added, gone };
};

// Stale is tolerated on ANY update run so that `--update-vault` is not blocked by a golden file
// that is about to be re-recorded separately; it stays fatal on a check run.
const goldenFile = readBaseline(goldenPath, "The golden file", updateGolden || updateVault);
const goldenItems = goldenFile ? fromRecord(goldenFile.items) : null;

if (goldenItems) {
  const { changed, filled, added, gone } = compareCorpus(goldenItems);
  if (updateGolden) {
    console.log(`golden diff: ${changed} changed, ${filled} filled, ${added} new corpus entries, ${gone} gone from corpus`);
  } else {
    fail += changed + gone;
    for (const text of corpus) {
      if (!goldenItems.has(text)) {
        console.error(`NEW CORPUS ENTRY not in golden: ${JSON.stringify(text)} — run --update-golden`);
        fail += 1;
      }
    }
  }
} else if (!updateGolden) {
  console.error(`no usable golden file at ${goldenPath} (absent or stale) — run --update-golden`);
  fail += 1;
}

if (updateGolden) {
  writeJson(goldenPath, { format: FORMAT, items: toRecord(current) });
  console.log(`recorded ${corpus.length} corpus entries (complete candidate lists) — REVIEW THE DIFF before committing`);
}

// --- optional sweep of the real Vault -----------------------------------------------------
// Skipped when the env var is unset (i.e. in CI). The Vault has its OWN baseline, written to a
// git-ignored file, because Vault item texts are not in the committed corpus — comparing them
// against `golden` would find nothing for almost every line and silently verify nothing.
const vault = process.env.TW_PARITY_VAULT;
if (vault) {
  const vaultRoot = resolve(vault);
  const files = [];
  // A file or directory can disappear between readdirSync listing it and statSync/readFileSync
  // touching it — TalkWeaver rewrites its own snapshot files while the app is running. Skip and
  // count rather than crash; the count is reported below, never hidden.
  let skipped = 0;
  const walk = (d) => {
    let entries;
    try { entries = readdirSync(d); } catch { skipped += 1; return; }
    for (const n of entries) {
      // _SLIDE-VERSIONS/ holds TalkWeaver's own auto-rotated snapshots of outlines already swept
      // elsewhere — machine-generated duplicates, not authored content, and 41% of the Vault's
      // files. Sweeping them inflates the baseline with pure churn. Skipping the directory also
      // means we never descend into one TalkWeaver may be rewriting mid-walk.
      if (n === "_SLIDE-VERSIONS") continue;
      const p = join(d, n);
      let isDir;
      try { isDir = statSync(p).isDirectory(); } catch { skipped += 1; continue; }
      if (isDir) walk(p);
      else if (n.endsWith(".md") && !n.endsWith("-present.md")) files.push(p);
    }
  };
  walk(vaultRoot);

  const BULLET = /^\s*[-*]\s+(.*\S)\s*$/;
  const ORDERED = /^\s*\d+[.)]\s+(.*\S)\s*$/;
  const seen = new Map();
  const census = new Map(); // classifyFeatureList kind → count, whole-Vault total
  const listKinds = new Map(); // "relative/path.md#index" → kind
  let items = 0;
  let lists = 0;

  for (const f of files) {
    let fileText;
    try { fileText = readFileSync(f, "utf8"); } catch { skipped += 1; continue; }
    const rel = relative(vaultRoot, f);
    let idx = 0;
    // Group CONSECUTIVE bullet lines into a list, then classify it. A blank line or any
    // non-bullet line closes the run. An ordered run is classified with ordered = true.
    const closeList = (run, ordered) => {
      if (!run.length) return;
      lists += 1;
      const kind = classifyFeatureList(run, ordered).kind;
      census.set(kind, (census.get(kind) || 0) + 1);
      listKinds.set(`${rel}#${idx}`, kind);
      idx += 1;
    };
    let run = [];
    let runOrdered = false;
    for (const line of fileText.split("\n")) {
      const b = BULLET.exec(line);
      const o = b ? null : ORDERED.exec(line);
      if (!b && !o) { closeList(run, runOrdered); run = []; runOrdered = false; continue; }
      const ordered = Boolean(o);
      const text = (b || o)[1];
      if (run.length && ordered !== runOrdered) { closeList(run, runOrdered); run = []; }
      runOrdered = ordered;
      run.push(text);
      if (b) { // only unordered bullets feed the per-item key record
        items += 1;
        if (!seen.has(text)) seen.set(text, resolveRecord(text));
      }
    }
    closeList(run, runOrdered);
  }

  const baseline = readBaseline(vaultBaselinePath, "The Vault baseline", updateVault);
  const record = () => ({
    format: FORMAT,
    recordShape: "[candidateCount, sha256-12 of the complete ordered key list, …up to 3 diagnostic keys]",
    items: toRecord(seen),
    lists: toRecord(census), // whole-Vault kind → count, for at-a-glance reading
    listKinds: toRecord(listKinds), // per-list identity → kind, for the impact report
  });
  // Any rewrite over an EXISTING file destroys irreplaceable pre-tier evidence, whether that file
  // is current or merely stale. Same gate either way.
  const guardOverwrite = () => {
    if (!existsSync(vaultBaselinePath) || has(OVERWRITE_VAULT_FLAG)) return;
    console.error(
      `\nREFUSING to overwrite the existing Vault baseline at ${vaultBaselinePath}.\n` +
      "It records pre-tier resolution over ~6,400 real outlines and cannot be recaptured\n" +
      `once a tier is wired. Back it up, then pass ${OVERWRITE_VAULT_FLAG}.`
    );
    process.exit(2);
  };

  if (baseline) {
    // Compare FIRST, in update mode too.
    let changed = 0;
    let filled = 0;
    let gone = 0;
    const baseItems = fromRecord(baseline.items);
    for (const [text, was] of baseItems) {
      const now = seen.get(text);
      // An item that has VANISHED from the Vault (outline edited or deleted) is not a resolver
      // change — but it is counted and reported, never silently skipped.
      if (now === undefined) { gone += 1; continue; }
      const verdict = compareRecords(was, now);
      if (verdict === "same") continue;
      if (verdict === "filled") { filled += 1; continue; }
      console.error(`VAULT CHANGED: ${JSON.stringify(text)}\n    was: ${fmt(was)}\n    now: ${fmt(now)}`);
      changed += 1;
    }
    let added = 0;
    for (const text of seen.keys()) if (!baseItems.has(text)) added += 1;

    // CLASSIFICATION-IMPACT REPORT — REPORT-ONLY, AND IT MUST STAY THAT WAY.
    //
    // classifyFeatureList decides what a list COULD become, not what a slide renders: since icons
    // became opt-in via {iconlist}/{logolist}, the default branch keeps a list plain whatever this
    // returns. So the delta is an impact estimate, useful to read, and nothing here is a verdict
    // on the deck.
    //
    // It cannot be a gate. A list is identified by "relativePath#index", and that identity does
    // not survive ordinary editing: inserting, removing or editing an earlier list shifts every
    // later index, so the comparison then puts two unrelated lists side by side. Over a corpus
    // Dominik edits continuously there is no way to tell an authoring edit from a resolver change
    // through this lens, and it produced false failures on a clean tree with an unmodified
    // resolver in two separate repair attempts. Item-level comparison above is the gate; this is
    // the report. Do not reconnect it to `fail`.
    // `numbers` comes from the ordered flag alone, before any icon resolution runs, so it has no
    // rank and is left out of the movement note.
    const KIND_RANK = { plain: 0, "icon-resolvable": 1, icons: 2 };
    const baseListKinds = fromRecord(baseline.listKinds || {});
    const backwards = [];
    let listsAdded = 0;
    let listsRemoved = 0;
    for (const [id, wasKind] of baseListKinds) {
      const nowKind = listKinds.get(id);
      if (nowKind === undefined) { listsRemoved += 1; continue; }
      if (wasKind === nowKind) continue;
      if (!(wasKind in KIND_RANK) || !(nowKind in KIND_RANK)) continue;
      if (KIND_RANK[wasKind] > KIND_RANK[nowKind]) backwards.push(`${id}: ${wasKind} → ${nowKind}`);
    }
    for (const id of listKinds.keys()) if (!baseListKinds.has(id)) listsAdded += 1;

    const oldTally = new Map();
    for (const kind of baseListKinds.values()) oldTally.set(kind, (oldTally.get(kind) || 0) + 1);
    const deltas = [];
    for (const kind of [...new Set([...census.keys(), ...oldTally.keys()])].sort()) {
      const was = oldTally.get(kind) || 0;
      const now = census.get(kind) || 0;
      if (was !== now) deltas.push(`${kind}: ${was} → ${now} (${now - was > 0 ? "+" : ""}${now - was})`);
    }
    console.log("");
    console.log("=== CLASSIFICATION-IMPACT REPORT (what lists could become; report-only) ===");
    if (deltas.length) for (const d of deltas) console.log(`  ${d}`);
    else console.log("  no change in whole-Vault kind totals");
    console.log(`  ${listsAdded} list positions added, ${listsRemoved} removed since the baseline`);
    if (backwards.length) {
      console.log(`  ${backwards.length} matched position(s) classify lower than the baseline recorded`);
      console.log("  (the position may hold a different list after editing — read, do not assume):");
      for (const b of backwards.slice(0, 20)) console.log(`    ${b}`);
      if (backwards.length > 20) console.log(`    … and ${backwards.length - 20} more`);
    }
    console.log("");

    const summary =
      `vault sweep: ${files.length} live outlines, ${items} list items, ${seen.size} distinct, ` +
      `${lists} lists, ${changed} changed, ${filled} filled, ${added} new, ${gone} gone, ${skipped} skipped`;
    if (updateVault) {
      console.log(`would rewrite baseline — ${summary}`);
      guardOverwrite();
      writeJson(vaultBaselinePath, record());
      console.log(`vault baseline OVERWRITTEN: ${files.length} outlines, ${seen.size} distinct items, ${lists} lists`);
    } else {
      fail += changed;
      console.log(summary);
    }
  } else if (updateVault) {
    guardOverwrite();
    writeJson(vaultBaselinePath, record());
    console.log(`vault baseline recorded: ${files.length} outlines, ${seen.size} distinct items, ${lists} lists`);
  } else {
    console.error(`no usable Vault baseline at ${vaultBaselinePath} — run --update-vault`);
    fail += 1;
  }
}

// Check the failure count FIRST. An update run must not exit 0 while `fail` holds real findings —
// TW_PARITY_VAULT=… --update-golden still runs a normal CHECK of the Vault.
if (fail) { console.error(`\n${fail} parity failure(s)`); process.exit(1); }
if (updateGolden || updateVault) process.exit(0);
console.log(`PASS: icon parity (${corpus.length} corpus entries, complete candidate lists)`);
