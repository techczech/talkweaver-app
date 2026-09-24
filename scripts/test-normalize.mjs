import { strict as assert } from "node:assert";
import {
  collapseDuplicateLayouts,
  fencedLineFlags,
  normalizePositions,
  scanFencedLines,
  normalizeTriggerLines
} from '../src/shared/outline-normalize.ts'

const outlineNormalize = await import('../src/shared/outline-normalize.ts')

let n = 0;
const ok = (m) => { n++; console.log("  ok " + m); };

// 1. Trailing single group is moved below the heading.
assert.equal(
  normalizeTriggerLines('### My title {statement}'),
  '### My title\n{statement}'
);
ok("trailing single group → moved below heading");

// 2. Multiple trailing groups are all moved.
assert.equal(
  normalizeTriggerLines('### My title {statement}{title=side}'),
  '### My title\n{statement}{title=side}'
);
ok("multiple trailing groups → all moved below heading");

// 3. Merge with an existing trigger-only line (prepend title groups).
assert.equal(
  normalizeTriggerLines('### My title {statement}{title=side}\n{existing}'),
  '### My title\n{statement}{title=side}{existing}'
);
ok("merge: title groups prepended to existing trigger line");

// 4. Heading with no trailing braces is unchanged.
assert.equal(
  normalizeTriggerLines('### Clean title'),
  '### Clean title'
);
ok("no trailing braces → heading unchanged");

// 5. The deck title (#) is left alone; every slide heading (##–######) is normalized.
assert.equal(
  normalizeTriggerLines('# Title {group}\n## Section {title=side}\n#### Sub {statement}'),
  '# Title {group}\n## Section\n{title=side}\n#### Sub\n{statement}'
);
ok("deck title untouched; ## and #### slide headings normalized");

// 6. Idempotency — running twice gives the same result.
const once = normalizeTriggerLines('### My title {statement}{title=side}');
const twice = normalizeTriggerLines(once);
assert.equal(once, twice);
ok("idempotent: running twice produces identical output");

// 7. Idempotency with merge case.
const mergeOnce = normalizeTriggerLines('### My title {statement}\n{existing}');
const mergeTwice = normalizeTriggerLines(mergeOnce);
assert.equal(mergeOnce, mergeTwice);
ok("idempotent (merge): running twice produces identical output");

// 8. Other lines (blank, bullets, plain text) are preserved exactly.
const mixed = [
  '# Deck title',
  '',
  '## Section',
  '',
  '### Slide one {statement}',
  'Bullet content',
  '',
  '### Slide two',
  '{cards}',
  'More content',
].join('\n');
const normalized = normalizeTriggerLines(mixed);
const expected = [
  '# Deck title',
  '',
  '## Section',
  '',
  '### Slide one',
  '{statement}',
  'Bullet content',
  '',
  '### Slide two',
  '{cards}',
  'More content',
].join('\n');
assert.equal(normalized, expected);
ok("surrounding content preserved; only h3 trailing groups moved");

// 9. Fenced heading-shaped lines are never touched: a `### x {y}` inside a ``` fence is code —
//    its brace groups stay put, and a fenced `{…}` line is never a merge target.
const fencedDoc = [
  '### Real slide {statement}',
  '```',
  '### fake heading {group}',
  '{fenced-trigger}',
  '```',
].join('\n');
assert.equal(
  normalizeTriggerLines(fencedDoc),
  [
    '### Real slide',
    '{statement}',
    '```',
    '### fake heading {group}',
    '{fenced-trigger}',
    '```',
  ].join('\n')
);
ok("fenced heading-like lines untouched; fenced {…} never a merge target");

// 10. Blank-separated legal form: a clean heading + BLANK + {…} trigger line is LEFT AS-IS (the
//     migrate tool produces this shape; it is legal and must never be re-arranged in a churn loop).
assert.equal(
  normalizeTriggerLines('### Clean title\n\n{image-claim} {id=musc1}\n\n- body'),
  '### Clean title\n\n{image-claim} {id=musc1}\n\n- body'
);
ok("blank-separated trigger line under a clean heading is left untouched (legal form)");

// 11. Merge across blanks: braces on the heading merge INTO the blank-separated existing trigger
//     line and the line moves DIRECTLY below the heading — never a duplicate trigger line above it.
assert.equal(
  normalizeTriggerLines('### My title {statement}\n\n{id=musc1}\n\n- body'),
  '### My title\n{statement}{id=musc1}\n\n- body'
);
ok("merge across blanks: no duplicate trigger line, merged line sits directly below heading");

// 12. Idempotency of the blank-separated merge case.
const blankMergeOnce = normalizeTriggerLines('### My title {statement}\n\n{id=musc1}\n\n- body');
assert.equal(normalizeTriggerLines(blankMergeOnce), blankMergeOnce);
ok("idempotent (blank-separated merge): running twice produces identical output");

// 13. A CRLF Trigger line is still the existing merge target. The normaliser has always emitted
//     LF for lines it rewrites; the regression is that it must not insert a duplicate Trigger line.
assert.equal(
  normalizeTriggerLines('### T {quote}\r\n{statement}\r\n'),
  '### T\n{quote}{statement}\n'
);
ok("CRLF trigger line remains the merge target; no duplicate line is inserted");

// 14. Trailing whitespace on a Trigger line is tolerated by the read rule and must not make the
//     normaliser insert a second Trigger line above it.
assert.equal(
  normalizeTriggerLines('### T {quote}\n{statement}   \n'),
  '### T\n{quote}{statement}\n'
);
ok("trailing-space trigger line remains the merge target; no duplicate line is inserted");

// 15. Position-only normalisation removes blanks between a heading and its Trigger line.
assert.equal(normalizePositions('### T\n\n\n{statement}\nBody'), '### T\n{statement}\nBody')
ok("position pass removes blanks between heading and Trigger line")

// 16. Position-only normalisation includes the existing title-brace pull-down.
assert.equal(normalizePositions('### T {statement}\nBody'), '### T\n{statement}\nBody')
ok("position pass pulls title braces down")

// 17. Position-only normalisation never changes authored tokens.
assert.equal(normalizePositions('### T\n{statement}{quote}\nBody'), '### T\n{statement}{quote}\nBody')
ok("position pass leaves tokens byte-identical")

// 18. Fenced content is never structurally normalised.
assert.equal(normalizePositions('```\n### T {x}\n```'), '```\n### T {x}\n```')
ok("position pass leaves fenced content untouched")

// 18b. The autosave position pass uses the compiler's complete Markdown-fence rule. A tilde
//      fence is just as opaque as a backtick fence, including heading- and Trigger-shaped lines.
const tildeFencedPositionSource = [
  '### Real slide',
  '{id=real-slide}',
  '',
  '~~~md',
  '### Example title {statement}{title=side}',
  '{chart=pie}',
  '~~~',
].join('\n')
assert.equal(
  normalizePositions(tildeFencedPositionSource),
  tildeFencedPositionSource,
  'normalizePositions must leave a tilde-fenced heading and trigger-shaped line byte-identical'
)
ok("position pass leaves tilde-fenced heading and trigger-shaped lines untouched")

// 18c. The Doctor's whole-document reset scan must stay linear even when every slide contains an
// unterminated fence. Count line reads instead of timing a particular machine.
const resetStressLines = Array.from(
  { length: 400 },
  (_, index) => index % 2 === 0 ? `### Slide ${index / 2 + 1}` : '```text'
)
let resetStressReads = 0
const countedResetStressLines = new Proxy(resetStressLines, {
  get(target, property, receiver) {
    if (typeof property === 'string' && /^\d+$/.test(property)) resetStressReads += 1
    return Reflect.get(target, property, receiver)
  }
})
scanFencedLines(countedResetStressLines, {
  resetAtLine: (line) => /^### /.test(line)
})
assert(
  resetStressReads <= resetStressLines.length * 6,
  `fence-reset scan read ${resetStressReads} line slots for ${resetStressLines.length} lines`
)
ok("unterminated-fence reset lookahead performs a linear number of line reads")

// 19. Duplicate layouts collapse to the compiler's final authored winner and report the change.
const collapsed = collapseDuplicateLayouts('### T\n{statement}{quote}\nBody')
assert.equal(collapsed.text, '### T\n{quote}\nBody')
assert.deepEqual(collapsed.tokenChanges, ['duplicate-layout:quote'])
ok("duplicate layouts collapse to the last layout and report it")

// 20. Non-layout tokens ride along untouched.
assert.equal(collapseDuplicateLayouts('### T\n{statement}{reveal}\n').text, '### T\n{statement}{reveal}\n')
ok("non-layout tokens survive duplicate-layout pass")

// 21. A clean outline reports no token changes.
assert.deepEqual(collapseDuplicateLayouts('### T\n{statement}\n').tokenChanges, [])
ok("clean outline reports no token changes")

// 22. The flagged same-key pass keeps the compiler-effective final id and preserves provenance.
assert.equal(typeof outlineNormalize.collapseDuplicateKeys, 'function',
  'manual normalise exposes the flagged duplicate-key pass')
const duplicateIds = outlineNormalize.collapseDuplicateKeys(
  '### Reused\n{id=B1 layout=statement}{from=source-talk}{id=faio6}\nBody'
)
assert.equal(
  duplicateIds.text,
  '### Reused\n{layout=statement}{from=source-talk}{id=faio6}\nBody'
)
assert.deepEqual(duplicateIds.tokenChanges, ['duplicate-key:id:faio6'])
ok("duplicate ids collapse to the last id with provenance intact")

// 23. A single id is byte-identical and unreported.
assert.deepEqual(
  outlineNormalize.collapseDuplicateKeys('### T\n{id=only}{statement}\n'),
  { text: '### T\n{id=only}{statement}\n', tokenChanges: [] }
)
ok("single id is untouched by the duplicate-key pass")

// 24. Provenance keys are append-only evidence, even if the same key occurs more than once.
assert.deepEqual(
  outlineNormalize.collapseDuplicateKeys('### T\n{from=one}{from=two}{clonedFrom=three}{clonedFrom=four}\n'),
  {
    text: '### T\n{from=one}{from=two}{clonedFrom=three}{clonedFrom=four}\n',
    tokenChanges: []
  }
)
ok("from and clonedFrom provenance tokens are never collapsed")

// 25. Removing a now-empty group removes its preceding space run with it.
assert.equal(
  outlineNormalize.collapseDuplicateKeys('### T\n{statement}   {id=old}  {id=new}\n').text,
  '### T\n{statement}  {id=new}\n'
)
ok("empty duplicate-key groups and their preceding spaces are removed")

// 26. Removing a token from inside one group also removes its orphaned comma separator.
assert.equal(
  outlineNormalize.collapseDuplicateKeys('{id=old,id=new}').text,
  '{id=new}'
)
ok("duplicate token inside one group leaves no orphaned separator")

// 27. Removing a line-leading group consumes its following separator space.
assert.equal(
  outlineNormalize.collapseDuplicateKeys('{id=old} {id=new}{reveal}').text,
  '{id=new}{reveal}'
)
ok("line-leading duplicate group leaves no leading space")

// 28. Removing the first trigger group after heading text preserves the heading separator.
assert.equal(
  outlineNormalize.collapseDuplicateKeys('### T {id=old}{id=new}').text,
  '### T {id=new}'
)
ok("heading keeps one space before its surviving trigger group")

// 29. The silent automatic path remains position-only and never collapses duplicate ids.
assert.equal(
  normalizePositions('### T\n\n{id=old}{id=new}\nBody'),
  '### T\n{id=old}{id=new}\nBody'
)
ok("auto normalise moves positions only and leaves duplicate ids authored")

// 30. Tabs are token separators too, so removing an in-group duplicate consumes the tab.
assert.equal(
  outlineNormalize.collapseDuplicateKeys('{id=old\tid=new}').text,
  '{id=new}'
)
ok("duplicate token inside one group consumes an adjacent tab separator")

// 31. Braces in heading prose do not make the first trailing trigger group eat its separator.
assert.equal(
  outlineNormalize.collapseDuplicateKeys('### Use {curly} here {id=old}{id=new}').text,
  '### Use {curly} here {id=new}'
)
ok("braces in a heading title do not remove the space before its first trigger group")

console.log(`\nnormalize-trigger-lines: all ${n} checks passed`);
