// Layout Doctor, plain view ticket 15: a title's icon left on its layout line, and the move that
// puts it back (src/shared/title-icon-restore.ts).
//
// The earlier preview builds' tidy-up moved `### Title {icon=lucide:star}` to `### Title` /
// `{icon=lucide:star}`, where the compiler draws nothing from it. The Doctor reports such a title
// and moves the icon back in one step. The statement, for any outline the move answers ok on:
//   compile(moved) equals compile(outline) except that the one slide's title now has the icon
//   every line but the title's and its layout line is the same, byte for byte, line ending included
//   tidy(moved) === moved                   when the outline was tidy (the move survives autosave)
//   the move, asked again, changes nothing
// and for the Doctor's button (restoreScannedTitleIcon), which saves at once: an outline the save
// would still change (its tidy-up, or an id stamped under a heading without one) is refused, and so
// is a move whose result the save would change. The file then holds the verified text, byte for byte.
//
// 1. A table: for each rule, whether the Doctor reports the title, and the exact text after the move,
//    with LF and with CRLF line endings.
// 2. A move the check refuses, and the check itself on a text changed elsewhere.
// 3. Generated outlines (fixed seeds): titles written with icons and other groups, put through the
//    tidy-up as it was before the fix, then through today's. The statement on every move; a zero in
//    any of the counts printed is a failure.
// 4. The button, through the one-writer seam (lib/outlineMutation.ts) and the save as the app makes
//    it (scripts/lib/outline-save-chain.mjs: a CodeMirror buffer, the tidy-up, id stamping, UTF-8):
//    a finding read from another text repairs nothing; a talk the save would still change is
//    refused with nothing written, and its next autosave settles it; a settled talk's file holds
//    exactly the verified text. Parts 1 and 3 make every one of their moves through that save too.
//
//   node scripts/test-layout-doctor-restore-title-icon.mjs [--seed=N] [--documents=N]
import assert from 'node:assert/strict'
import { scanOutlineTriggers, unresolvedTriggerFindings } from '../src/shared/layout-doctor.ts'
import { applyScannedTitleIconRestore, restoreScannedTitleIcon, restoreTitleIcon, strandedTitleIcons, titleIconMoveVerified, STRANDED_TITLE_ICON_MESSAGE } from '../src/shared/title-icon-restore.ts'
import { outlineSaveChange } from '../src/shared/outline-save-changes.ts'
import { asSaved, openTalk, savedAs } from './lib/outline-save-chain.mjs'
import { fencedLineFlags, normalizePositions, normalizeTriggerLines } from '../src/shared/outline-normalize.ts'
import { setLineIcon } from '../src/shared/icon-verbs.ts'
import { adaptMarkdownOutlineV2 } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { parseOutlineTree } from '../compiler/scripts/lib/14-outline-tree.mjs'
import { normalizeIconOverrideKey } from '../compiler/scripts/lib/05-icons.mjs'
import { TRIGGER_LINE_RE } from '../compiler/scripts/lib/trigger-tokenizer.mjs'

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1]
const SEEDS = arg('seed') ? [Number(arg('seed')) >>> 0] : [20261013, 51, 52]
const DOCUMENTS = Number(arg('documents') ?? 800)

// ── The real compiler, before and after ─────────────────────────────────────────────────────────

/** Positions move when a line goes; the two quoted fields hold the outline's own text. */
const POSITIONAL = new Set(['sourceLine', 'sourceLines', 'line', 'startLine', 'endLine', 'sourceMarkdown', 'scriptSourceMarkdown'])
const unplaced = (value) => (Array.isArray(value) ? value.map(unplaced)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key]) => !POSITIONAL.has(key)).map(([key, v]) => [key, unplaced(v)]))
    : value)
const sorted = (object) => Object.fromEntries(Object.entries(object).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
function headingsOf(text) {
  const tree = parseOutlineTree(text)
  const out = []
  const walk = (node) => {
    if (node.level > 0) out.push({ level: node.level, title: node.title, titleIcon: node.titleIcon ?? '', id: node.id ?? '', attrs: sorted(node.attrs), content: node.contentLines, notes: node.notesLines })
    node.children.forEach(walk)
  }
  walk(tree.root)
  return { headings: out, deckTitleIcon: tree.deckTitleIcon, deckTitle: tree.meta.title }
}
// A level gap is named by its line, which moves when a layout line goes.
const unlined = (warnings) => warnings.map((warning) => String(warning).replace(/^heading-level-gap:\d+$/, 'heading-level-gap'))
const compile = (text) => {
  const talk = unplaced(adaptMarkdownOutlineV2(text, 'Fallback', {}))
  return { talk: { ...talk, warnings: unlined(talk.warnings ?? []) }, outline: headingsOf(text) }
}
function differences(was, now, path = '', out = []) {
  if (JSON.stringify(was) === JSON.stringify(now)) return out
  if (was && now && typeof was === 'object' && typeof now === 'object' && Array.isArray(was) === Array.isArray(now)) {
    for (const key of new Set([...Object.keys(was), ...Object.keys(now)])) differences(was[key], now[key], `${path}.${key}`, out)
  } else out.push({ path, was, now })
  return out
}
const show = (text) => text.split('\n').map((line, i) => `${String(i + 1).padStart(3)} ${JSON.stringify(line)}`).join('\n')

/** The statement: the compiled talks differ in one slide's title icon (and where it is placed), and in nothing else. */
function assertOnlyTheTitleIcon(was, now, key, label) {
  const diffs = differences(compile(was), compile(now))
  const context = `${label}\n${JSON.stringify(diffs.slice(0, 6), null, 1)}\n\n${show(was)}\n\nafter the move:\n${show(now)}`
  const slide = diffs.filter((d) => /^\.talk\.slides\.\d+\.titleIcon$/.test(d.path))
  const heading = diffs.filter((d) => /^\.outline\.headings\.\d+\.titleIcon$/.test(d.path))
  assert.equal(slide.length, 1, `one compiled slide's title takes the icon: ${context}`)
  assert.equal(slide[0].was, undefined, `the slide's title had no icon: ${context}`)
  assert.equal(slide[0].now, normalizeIconOverrideKey(key), `the slide's title has the icon: ${context}`)
  assert.equal(heading.length, 1, `one heading takes the icon: ${context}`)
  assert.deepEqual([heading[0].was, heading[0].now], ['', key], `the heading's icon: ${context}`)
  const placed = `${slide[0].path}At`
  const others = diffs.filter((d) => d !== slide[0] && d !== heading[0] && !(d.path === placed && d.was === undefined && d.now === 'above'))
  assert.deepEqual(others, [], `nothing else in the compiled talk changed: ${context}`)
}

const MOVED_ON = 'The outline changed before the icon was moved, so nothing was changed.'
const UNSETTLED = 'This talk has tidy-ups waiting for its next save, so nothing was changed. Make any edit to the talk, wait a moment, then try again.'
const NOT_SAFE = 'The icon could not be moved to the title safely, so nothing was changed.'
/** The Doctor's findings as its panel asks for them. */
const doctorScan = (text) => scanOutlineTriggers(text, undefined, { strandedTitleIcons: true })
const findingOf = (at) => ({ headingLine: at.headingLine + 1, token: `icon=${at.key}`, slideTitle: at.title })
/** How the button answered on the outlines moved by hand below, and which step of the save refused it. */
const clicks = { settled: 0, unsettled: 0, resultUnsettled: 0, why: {} }
/** The Doctor's click on an open talk (WorkspaceLayout handleDoctorRestoreTitleIcon). */
const click = (talk, scanned, finding) => applyScannedTitleIconRestore((mutate, options) => talk.apply(mutate, options), scanned, finding)
/** The click on a talk open on `text`: what it answered, and that a refusal changed and wrote nothing. */
async function clickOn(text, finding, label) {
  const talk = openTalk(text)
  assert.equal(talk.text(), text, `${label}: the editor holds the text`)
  const answer = await click(talk, text, finding)
  if (answer !== null) assert.deepEqual([talk.text(), talk.writes], [text, []], `${label}: a refused click changes nothing and writes nothing`)
  return { answer, talk }
}

/** One move, with everything that must hold of it. Returns the moved outline, or null when it was refused (the outline unchanged). */
async function moveAndCheck(text, at, label) {
  const moved = restoreTitleIcon(text, at.headingLine)
  if (!moved.ok) {
    assert.equal(moved.text, text, `${label}: a refused move leaves the outline as it was`)
    return null
  }
  assertOnlyTheTitleIcon(text, moved.text, at.key, label)
  // The same bytes everywhere but the two lines: the two changes, applied to the outline, give the result.
  let rebuilt = text
  for (const change of moved.changes) rebuilt = rebuilt.slice(0, change.from) + change.insert + rebuilt.slice(change.to)
  assert.equal(rebuilt, moved.text, `${label}: the result is the outline with the two changes`)
  // Directly: every line but the title's and its layout line is the line it was, its line ending (a
  // `\r` before the `\n`) included; when the layout line went, the later lines are one line up.
  {
    const was = text.split('\n')
    const now = moved.text.split('\n')
    const gone = was.length - now.length
    assert.ok(gone === 0 || gone === 1, `${label}: at most one line went`)
    assert.equal(gone === 1, moved.changes[0].insert === '' , `${label}: a line went exactly when the layout line was removed`)
    let compared = 0
    for (let line = 0; line < was.length; line += 1) {
      if (line === at.headingLine || line === at.triggerLine) continue
      assert.equal(now[gone && line > at.triggerLine ? line - 1 : line], was[line], `${label}: line ${line + 1} is byte for byte the line it was\n${show(text)}\n\nafter the move:\n${show(moved.text)}`)
      compared += 1
    }
    assert.equal(compared, now.length - (gone ? 1 : 2), `${label}: every line of the result but the title's and its layout line was compared`)
  }
  // Asked again: nothing to move there, and nothing changes.
  const again = restoreTitleIcon(moved.text, at.headingLine)
  assert.deepEqual([again.ok, again.text], [false, moved.text], `${label}: the move, asked again, changes nothing`)
  assert.ok(!strandedTitleIcons(moved.text).some((entry) => entry.headingLine === at.headingLine), `${label}: the title is no longer reported`)
  // The button (it saves at once). The save is made as the app makes it: on a settled outline the
  // file then holds this same move and nothing else; on any other the button refuses.
  const finding = findingOf(at)
  const clicked = restoreScannedTitleIcon(text, text, finding)
  const why = outlineSaveChange(text)
  assert.equal(why !== null, (await savedAs(text)) !== text, `${label}: the settled check agrees with what a save of the outline writes\n${show(text)}`)
  // A CodeMirror buffer never holds a `\r`, so such a text cannot be opened as it is: the verb alone answers.
  const openable = !text.includes('\r')
  if (why !== null) {
    assert.deepEqual([clicked.ok, clicked.reason, clicked.detail, clicked.text], [false, 'unsettled', UNSETTLED, text], `${label}: the button refuses an outline the save would still change (${why})\n${show(text)}`)
    if (openable) assert.equal((await clickOn(text, finding, label)).answer, UNSETTLED, `${label}: refused in plain words`)
    clicks.unsettled += 1
    clicks.why[why] = (clicks.why[why] ?? 0) + 1
  } else if ((await savedAs(moved.text)) !== moved.text) {
    assert.notEqual(outlineSaveChange(moved.text), null, `${label}: the settled check sees that the save would change the moved outline`)
    assert.deepEqual([clicked.ok, clicked.reason, clicked.detail, clicked.text], [false, 'not-verified', NOT_SAFE, text], `${label}: the button refuses a move the save would then change\n${show(moved.text)}`)
    assert.equal((await clickOn(text, finding, label)).answer, NOT_SAFE, `${label}: refused in plain words`)
    clicks.resultUnsettled += 1
  } else {
    assert.equal(outlineSaveChange(moved.text), null, `${label}: the settled check agrees that the save leaves the moved outline as it is`)
    assert.deepEqual([clicked.ok, clicked.text], [true, moved.text], `${label}: the button makes the same move`)
    assert.equal(normalizeTriggerLines(moved.text), moved.text, `${label}: the tidy-up leaves the moved outline as it is\n${show(moved.text)}`)
    assert.equal(normalizePositions(moved.text), moved.text, `${label}: both passes of the tidy-up leave it as it is\n${show(moved.text)}`)
    const { answer, talk } = await clickOn(text, finding, label)
    assert.equal(answer, null, `${label}: the click moves the icon`)
    assert.deepEqual(talk.writes, [moved.text], `${label}: one save, of exactly the verified text\n${show(text)}`)
    assert.ok(Buffer.from(talk.file(), 'utf8').equals(Buffer.from(moved.text, 'utf8')), `${label}: the file's bytes are the verified text's`)
    assert.equal(talk.text(), moved.text, `${label}: the editor holds the verified text`)
    clicks.settled += 1
  }
  return moved.text
}

// ── 1. The table ────────────────────────────────────────────────────────────────────────────────

const doc = (...lines) => ['# Talk', '', '## Part', '', ...lines].join('\n')
const STAR = '{icon=lucide:star}'
/** [name, lines, lines after the move (null: the Doctor does not report the title)]. The title asked about is the first heading after `## Part`, unless `at` names another line. */
const TABLE = [
  ['the icon between a layout and an id', ['### Title', `{cards} ${STAR} {id=a1}`, '- A', '- B'], ['### Title {icon=lucide:star}', '{cards} {id=a1}', '- A', '- B']],
  ['the icon first, written against the id', ['### Title', `${STAR}{id=a1}`, 'Text.'], ['### Title {icon=lucide:star}', '{id=a1}', 'Text.']],
  ['the icon first, a space before the next group', ['### Title', `${STAR} {reveal}`, 'Text.'], ['### Title {icon=lucide:star}', '{reveal}', 'Text.']],
  ['the icon last', ['### Title', `{reveal}${STAR}`, 'Text.'], ['### Title {icon=lucide:star}', '{reveal}', 'Text.']],
  ['the icon alone: the layout line goes', ['### Title', STAR, 'Text.'], ['### Title {icon=lucide:star}', 'Text.']],
  ['the icon alone on the outline\'s last line', ['### Title', STAR], ['### Title {icon=lucide:star}']],
  ['the icon alone, an empty line after it', ['### Title', STAR, ''], ['### Title {icon=lucide:star}', '']],
  ['the icon alone after a blank line', ['### Title', '', STAR, 'Text.'], ['### Title {icon=lucide:star}', '', 'Text.']],
  ['spaces after the title stay after the icon, as Command-I writes it', ['### Title  ', STAR, 'Text.'], ['### Title {icon=lucide:star}  ', 'Text.']],
  ['an indented layout line keeps its indent', ['### Title', `  ${STAR} {reveal}  `, 'Text.'], ['### Title {icon=lucide:star}', '  {reveal}  ', 'Text.']],
  ['a quoted icon is written plainly', ['### Title', '{icon="lucide:sun"} {reveal}', 'Text.'], ['### Title {icon=lucide:sun}', '{reveal}', 'Text.']],
  ['the icon placed above the title', ['### Title', `${STAR} {title-icon=above}`, 'Text.'], ['### Title {icon=lucide:star}', '{title-icon=above}', 'Text.']],
  ['a level 2 title', ['## Title', `${STAR}{id=s1}`, '', '### Inside', 'Text.'], ['## Title {icon=lucide:star}', '{id=s1}', '', '### Inside', 'Text.']],
  ['a level 4 title', ['### Above', 'Text.', '', '#### Title', STAR, 'More.'], ['### Above', 'Text.', '', '#### Title {icon=lucide:star}', 'More.'], 7],
  ['a cards slide with its cards under it', ['### Title', `{cards}${STAR}`, '', '#### One', 'A.', '', '#### Two', 'B.'], ['### Title {icon=lucide:star}', '{cards}', '', '#### One', 'A.', '', '#### Two', 'B.']],
  ['a carousel slide', ['### Title', `{carousel} ${STAR}`, '', '#### One', 'A.', '', '#### Two', 'B.'], ['### Title {icon=lucide:star}', '{carousel}', '', '#### One', 'A.', '', '#### Two', 'B.']],
  ['a carousel item draws no title icon: not reported', ['### Deck', '{carousel}', '', '#### Title', STAR, 'A.', '', '#### Two', 'B.'], null, 7],
  ['the title already has an icon', ['### Title {icon=lucide:flag}', STAR, 'Text.'], null],
  ['the title has another group after it (the tidy-up moves it first)', ['### Title {reveal}', STAR, 'Text.'], null],
  ['two icons on the layout line', ['### Title', `${STAR} {icon=lucide:flag}`, 'Text.'], null],
  ['an icon with another token in its braces', ['### Title', '{icon=lucide:star reveal}', 'Text.'], null],
  ['an empty icon', ['### Title', '{icon=}', 'Text.'], null],
  ['the colon form', ['### Title', '{icon:lucide:star}', 'Text.'], null],
  ['a bare name, which only the icon sets can tell from a word', ['### Title', '{icon=star}', 'Text.'], null],
  ['another icon on a later layout line', ['### Title', STAR, 'Text.', '', '{icon=lucide:flag}'], null],
  ['the icon on a later line, not the layout line', ['### Title', 'Text.', STAR], null],
  ['a comment on the layout line', ['### Title', `${STAR} <!-- why -->`, 'Text.'], null],
  ['inside a code fence', ['### Real', '```', '### Title', STAR, '```'], null, 6],
  ['inside an HTML comment', ['### Real', '<!--', '### Title', STAR, '-->'], null, 6],
  ['under notes', ['### Title', ':::notes', STAR, ':::'], null],
  ['a title with no layout line', ['### Title', 'Text.'], null]
]
let tableMoved = 0
let tableAsSaved = 0
const settledBeforeTable = clicks.settled
for (const [name, before, after, at = 4] of TABLE) {
  for (const eol of ['\n', '\r\n']) {
    const label = `${name}${eol === '\r\n' ? ' (CRLF)' : ''}`
    const text = doc(...before).split('\n').join(eol)
    const found = strandedTitleIcons(text).filter((entry) => entry.headingLine === at)
    const reported = doctorScan(text).filter((finding) => finding.kind === 'stranded-title-icon')
    assert.equal(found.length, after ? 1 : 0, `${label}: reported`)
    assert.equal(strandedTitleIcons(text).length, found.length, `${label}: no other title is reported`)
    assert.equal(reported.length, found.length, `${label}: the Doctor's finding`)
    if (!after) {
      const refused = restoreTitleIcon(text, at)
      assert.deepEqual([refused.ok, refused.reason, refused.text], [false, 'nothing-to-move', text], `${label}: nothing is moved`)
      continue
    }
    assert.deepEqual(
      { ...reported[0], token: undefined },
      { kind: 'stranded-title-icon', token: undefined, line: found[0].triggerLine + 1, headingLine: at + 1, slideTitle: 'Title', detail: STRANDED_TITLE_ICON_MESSAGE },
      `${label}: the finding names the title and the layout line`
    )
    assert.equal(reported[0].token, `icon=${found[0].key}`)
    const moved = await moveAndCheck(text, found[0], label)
    assert.equal(moved, doc(...after).split('\n').join(eol), `${label}: the text after the move, byte for byte`)
    tableMoved += 1
    if (eol !== '\n') continue
    // The same talk as the app's saves leave it (tidied, an id under every heading): each title still
    // reported there is moved through the real save.
    const saved = await asSaved(text)
    for (const entry of strandedTitleIcons(saved)) {
      await moveAndCheck(saved, entry, `${label} (as saved)`)
      tableAsSaved += 1
    }
  }
}
assert.equal(STRANDED_TITLE_ICON_MESSAGE, 'This slide\'s icon is on the layout line, so it is not drawn on the title.')
assert.deepEqual(unresolvedTriggerFindings(doc('### Title', STAR, 'Text.')), [], 'the finding never blocks publishing')
// The title line is the line Command-I writes for the same icon.
{
  const written = setLineIcon(doc('### Title  ', '{reveal}', 'Text.'), 4, 'lucide:star', () => true)
  const moved = restoreTitleIcon(doc('### Title  ', `${STAR} {reveal}`, 'Text.'), 4)
  assert.ok(written.ok && moved.ok)
  assert.equal(moved.text, written.text, 'the moved outline is the outline Command-I writes')
}
// A surface that showed another icon or title is refused.
{
  const text = doc('### Title', STAR, 'Text.')
  assert.equal(restoreTitleIcon(text, 4, { key: 'lucide:star', title: 'Title' }).ok, true)
  for (const expect of [{ key: 'lucide:flag', title: 'Title' }, { key: 'lucide:star', title: 'Other' }]) {
    const refused = restoreTitleIcon(text, 4, expect)
    assert.deepEqual([refused.ok, refused.reason, refused.text], [false, 'moved-on', text])
  }
  assert.equal(restoreTitleIcon(text, 5, { key: 'lucide:star', title: 'Title' }).reason, 'moved-on')
}
console.log(`table: ${TABLE.length} cases × LF and CRLF, ${tableMoved} moved, each byte for byte and with the compiled talk the same but for the title's icon; ${tableAsSaved} more on the same talks as saved, ${clicks.settled - settledBeforeTable} of them through the save with the file holding exactly the verified text`)
assert.ok(clicks.settled - settledBeforeTable >= 10, 'few table moves went through the save: the pass proves little of it')

// ── 2. A move the check refuses ─────────────────────────────────────────────────────────────────

// With the icon's line gone the chart's own line would be the first under the title, and the compiler
// would read it as the slide's layout line, no longer as the chart that owns the list.
for (const eol of ['\n', '\r\n']) {
  const text = doc('### Title', STAR, '{chart=bar}', '- A: 1', '- B: 2').split('\n').join(eol)
  assert.equal(strandedTitleIcons(text).length, 1, 'the title is reported')
  const refused = restoreTitleIcon(text, 4)
  assert.deepEqual([refused.ok, refused.reason, refused.text], [false, 'not-verified', text], 'the move is refused and the outline comes back unchanged')
  assert.equal(refused.detail, 'The icon could not be moved to the title safely, so nothing was changed.')
  const forced = text.replace(`${STAR}${eol}`, '').replace('### Title', `### Title ${STAR}`)
  assert.notDeepEqual(differences(compile(text), compile(forced)).filter((d) => !/titleIcon$/.test(d.path)), [], 'the refused move would have changed the compiled talk')
}
{
  const text = doc('### Title', `${STAR} {reveal}`, 'Text.', '', '### Other', 'More.')
  const [at] = strandedTitleIcons(text)
  const moved = restoreTitleIcon(text, 4)
  assert.ok(moved.ok)
  assert.equal(titleIconMoveVerified(text, moved.text, at, false), true, 'the check accepts the move')
  for (const [why, other] of [
    ['a word of the slide changed', moved.text.replace('Text.', 'Texts.')],
    ['another slide changed', moved.text.replace('More.', 'More!')],
    ['another token went', moved.text.replace('{reveal}', '{}')],
    ['another icon was written', moved.text.replace('lucide:star', 'lucide:flag')],
    ['the icon was not moved', text],
    ['the other slide took an icon too', moved.text.replace('### Other', `### Other ${STAR}`)]
  ]) assert.equal(titleIconMoveVerified(text, other, at, false), false, `the check refuses when ${why}`)
}
console.log('refusals: a move that would change the compiled talk is refused; the check refuses six other texts')

// ── 3. Generated outlines ───────────────────────────────────────────────────────────────────────

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** The tidy-up as it was before the fix: every group after a title goes to the line under it, a title's icon too. */
function tidyAsItWas(text) {
  const lines = text.split('\n')
  const fenced = fencedLineFlags(lines)
  const out = []
  for (let i = 0; i < lines.length; i += 1) {
    const m = !fenced[i] && /^#{2,6} /.test(lines[i]) ? lines[i].match(/\s*(\{[^}]*\}(?:\s*\{[^}]*\})*)\s*$/) : null
    if (!m) { out.push(lines[i]); continue }
    out.push(lines[i].slice(0, lines[i].length - m[0].length))
    let j = i + 1
    while (j < lines.length && lines[j].trim() === '') j += 1
    if (j < lines.length && !fenced[j] && TRIGGER_LINE_RE.test(lines[j].trim())) { out.push(m[1] + lines[j].trim()); i = j } else out.push(m[1])
  }
  return out.join('\n')
}

const ICONS = ['{icon=lucide:star}', '{icon=lucide:star}', '{icon=lucide:flag}', '{icon=svgl:moon}', '{icon=tabler:bolt}', '{icon="lucide:sun"}', '{ icon=lucide:star }', '{icon=lucide:zzz-not-an-icon}', '{icon=}', '{icon=star}', '{icon:lucide:star}', '{icon=lucide:star title-icon=above}']
const GROUPS = ['{reveal}', '{id=a1}', '{id=b_2}', '{cards}', '{carousel}', '{statement}', '{cols=2}', '{title-icon=above}', '{accent=cobalt}', '{numbered}', '{iconlist}', '{quote}', '{nostep}', '{cards reveal}', '{unknownword}', '{chart=bar}']
const WORDS = ['Alpha', 'Beta gamma', 'A longer line of plain words', 'Text with `code`', 'After', 'See https://example.org/', 'Ends in a brace }']
const BODIES = [
  ['- A', '- B', '- C'], ['- A: 1', '- B: 2'], ['A paragraph.'], ['A paragraph. {icon=lucide:flag}'], ['- A {icon=lucide:flag}', '- B'], ['> A quotation'], ['![x](a.png)', '![y](b.png)'],
  ['{chart=bar}', '- A: 1', '- B: 2'], ['```', '### Code {icon=lucide:star}', '{icon=lucide:star}', '```'], [':::notes', '{icon=lucide:star}', 'A note.', ':::'], ['<!--', '{icon=lucide:star}', '-->', 'Text.'],
  ['Text.', '', '{icon=lucide:flag}'], ['{reveal}', 'Text.'], ['{id=c3}', 'Text.'], []
]

function generator(seed) {
  const random = mulberry32(seed)
  const pick = (list) => list[Math.floor(random() * list.length)]
  const int = (lo, hi) => lo + Math.floor(random() * (hi - lo + 1))
  // What was written after a title: most often its icon, with up to three other groups around it.
  const tail = () => {
    const r = random()
    if (r < 0.2) return ''
    const parts = Array.from({ length: int(0, 3) }, () => pick(GROUPS))
    if (r < 0.9) parts.splice(int(0, parts.length), 0, pick(ICONS))
    if (random() < 0.06) parts.push(pick(ICONS))
    return parts.length ? pick([' ', ' ', '  ']) + parts.reduce((line, part) => line + (line ? pick(['', ' ', ' ']) : '') + part, '') : ''
  }
  const slide = (level) => {
    // An icon's line with a chart's own line right under it: the one shape the check refuses (part 2).
    if (random() < 0.03) return [`${'#'.repeat(level)} ${pick(WORDS)}`, '{icon=lucide:star}', '{chart=bar}', '- A: 1', '- B: 2']
    const lines = [`${'#'.repeat(level)} ${pick(WORDS)}${tail()}`]
    if (random() < 0.1) lines.push('')
    if (random() < 0.35) lines.push(Array.from({ length: int(1, 2) }, () => pick(GROUPS)).join(pick(['', ' '])) + (random() < 0.05 ? ' <!-- why -->' : ''))
    if (random() < 0.15) lines.push('')
    lines.push(...pick(BODIES))
    return lines
  }
  return async () => {
    const lines = []
    if (random() < 0.3) lines.push('---', 'title: Generated', ...(random() < 0.5 ? [pick(['triggers: reveal', 'triggers: iconlist', 'triggers: layout=cards'])] : []), '---')
    lines.push(`# Talk${random() < 0.1 ? ' {icon=lucide:star}' : ''}`, '', `## Part one${random() < 0.4 ? tail() : ''}`, '')
    for (let k = int(2, 8); k > 0; k -= 1) {
      lines.push(...slide(random() < 0.12 ? 2 : random() < 0.75 ? 3 : 4))
      lines.push(...(random() < 0.85 ? [''] : []))
    }
    // Saved by an earlier preview build, then (most often) by today's, which tidies and stamps an id
    // under every heading; sometimes tidied only (ids still to stamp); now and then as typed, never saved.
    const typed = lines.join('\n') + (random() < 0.5 ? '\n' : '')
    const kind = random()
    const text = kind < 0.72 ? await asSaved(tidyAsItWas(typed), 1 + Math.floor(random() * 1e6)) : kind < 0.92 ? normalizePositions(tidyAsItWas(typed)) : typed
    const r = random()
    const eol = r < 0.2 ? () => '\r\n' : r < 0.25 ? () => (random() < 0.5 ? '\r\n' : '\n') : () => '\n'
    return { text: text.split('\n').map((line, index, all) => (index + 1 < all.length ? line + eol() : line)).join('') }
  }
}

const total = { documents: 0, reported: 0, moved: 0, linesRemoved: 0, crlf: 0, withMoves: 0, levels: {}, refused: {} }
for (const SEED of SEEDS) {
  const next = generator(SEED)
  const started = Date.now()
  const counts = { reported: 0, moved: 0 }
  for (let n = 0; n < DOCUMENTS; n += 1) {
    const generated = await next()
    let text = generated.text
    total.documents += 1
    const skipped = new Set()
    let moves = 0
    try {
      for (;;) {
        // From the last title up, so the lines of the titles still to do stay where they are.
        const at = strandedTitleIcons(text).filter((entry) => !skipped.has(entry.headingLine)).at(-1)
        if (!at) break
        counts.reported += 1
        assert.ok(doctorScan(text).some((finding) => finding.kind === 'stranded-title-icon' && finding.headingLine === at.headingLine + 1), 'the Doctor reports what the reader finds')
        const moved = await moveAndCheck(text, at, `document ${n + 1} of seed ${SEED}, line ${at.headingLine + 1}`)
        if (moved === null) {
          const reason = restoreTitleIcon(text, at.headingLine).reason
          total.refused[reason] = (total.refused[reason] ?? 0) + 1
          skipped.add(at.headingLine)
          continue
        }
        if (moved.split('\n').length < text.split('\n').length) total.linesRemoved += 1
        if (text.includes('\r')) total.crlf += 1
        const level = text.split('\n')[at.headingLine].match(/^#+/)[0].length
        total.levels[level] = (total.levels[level] ?? 0) + 1
        text = moved
        moves += 1
        counts.moved += 1
      }
    } catch (error) {
      console.error(`\nFAILED on document ${n + 1} of seed ${SEED} (reproduce: --seed=${SEED})\n${error.message}`)
      process.exit(1)
    }
    if (moves) total.withMoves += 1
  }
  total.reported += counts.reported
  total.moved += counts.moved
  console.log(`seed ${SEED}: ${DOCUMENTS} documents, ${counts.reported} titles reported, ${counts.moved} icons moved (${Date.now() - started} ms)`)
}
console.log(`generated: ${total.documents} documents; ${total.reported} titles reported; ${total.moved} icons moved in ${total.withMoves} documents, the compiled talk the same but for the title's icon after each; ${total.linesRemoved} layout lines removed; ${total.crlf} moves in outlines with CRLF; by title level ${JSON.stringify(total.levels)}; refused ${JSON.stringify(total.refused)}`)
assert.ok(total.documents >= 2000 || arg('documents') || arg('seed'), 'at least 2,000 generated documents')
assert.ok(total.moved > 500, 'few icons were moved: the pass proves little')
assert.ok(total.linesRemoved > 0 && total.crlf > 0, 'no layout line was removed, or no outline had CRLF: the pass proves nothing of them')
for (const level of [2, 3, 4]) assert.ok(total.levels[level] > 0, `no level ${level} title had its icon moved`)
assert.ok((total.refused['not-verified'] ?? 0) > 0, 'the check refused no generated move: the pass proves nothing of it')
assert.deepEqual(Object.keys(total.refused), ['not-verified'], 'a move was refused for another reason')
console.log(`the button on those outlines: ${clicks.settled} moves made on settled outlines, each saved as exactly the verified text; ${clicks.unsettled} refused because the save would still change the outline (by step ${JSON.stringify(clicks.why)}); ${clicks.resultUnsettled} refused because it would change the result`)
assert.ok(clicks.settled > 500 && clicks.unsettled > 0, 'the button was not tried on both settled and unsettled outlines')
for (const step of ['line-endings', 'tidy-up', 'ids']) assert.ok(clicks.why[step] > 0 || arg('documents') || arg('seed'), `no outline was refused for its ${step}: the pass proves nothing of that step of the save`)

// ── 4. The button, through the one-writer seam and the real save ────────────────────────────────

/** A talk as saved: an id under every heading. */
const talkOf = (...lines) => ['# Talk', '', '## Part', '{id=part}', '', ...lines].join('\n')
const STAR_ID = (id) => `${STAR} {id=${id}}`
const strandedFindings = (text) => doctorScan(text).filter((finding) => finding.kind === 'stranded-title-icon')

// Finding from one text, click on another: two slides with the same title and icon; the first is
// deleted, so the second stands on the first one's lines. Nothing is repaired.
{
  const scanned = talkOf('### Title', STAR_ID('t1'), 'First.', '', '### Title', STAR_ID('t2'), 'Second.')
  assert.equal(outlineSaveChange(scanned), null, 'the talk is settled')
  const [first, second] = strandedFindings(scanned)
  assert.deepEqual([first.headingLine, second.headingLine], [6, 10])
  const live = talkOf('### Title', STAR_ID('t2'), 'Second.')
  assert.deepEqual(strandedFindings(live).map(({ headingLine, token, slideTitle }) => ({ headingLine, token, slideTitle })), [{ headingLine: first.headingLine, token: first.token, slideTitle: first.slideTitle }], 'the other slide now answers to the first finding\'s line, title and icon')
  const ed = openTalk(live)
  assert.equal(await click(ed, scanned, first), MOVED_ON, 'a finding read from another text is refused')
  assert.deepEqual([ed.text(), ed.writes], [live, []], 'the other slide is not repaired and nothing is saved')
  // Any difference at all, wherever it is.
  for (const [why, other] of [['a line ending was added at the end', `${scanned}\n`], ['a word of another slide changed', scanned.replace('Second.', 'Second!')], ['a space was added in the first line', scanned.replace('# Talk', '# Talk ')]]) {
    const changed = openTalk(other)
    assert.equal(await click(changed, scanned, first), MOVED_ON, `refused when ${why}`)
    assert.deepEqual([changed.text(), changed.writes], [other, []], `nothing is changed or saved when ${why}`)
    const pure = restoreScannedTitleIcon(other, scanned, first)
    assert.deepEqual([pure.ok, pure.reason, pure.text], [false, 'moved-on', other])
  }
  // The comparison is made on the text the seam hands over, each time it hands one over: a seam that
  // works the change out a second time against a newer buffer gets the newer buffer back unchanged.
  const handed = []
  const twice = await applyScannedTitleIconRestore(async (mutate) => {
    handed.push(mutate(scanned), mutate(live))
    return { ok: true }
  }, scanned, first)
  assert.equal(handed[0], restoreTitleIcon(scanned, 5).text, 'the scanned text itself is repaired')
  assert.equal(handed[1], live, 'the newer text comes back unchanged')
  assert.equal(twice, MOVED_ON, 'and the last attempt\'s refusal is what is shown')
  // The same text: the first slide's icon is moved, and the file holds the verified text.
  const same = openTalk(scanned)
  assert.equal(await click(same, scanned, first), null)
  const verified = talkOf('### Title {icon=lucide:star}', '{id=t1}', 'First.', '', '### Title', STAR_ID('t2'), 'Second.')
  assert.deepEqual([same.writes, same.file(), same.text()], [[verified], verified, verified])
}

// An outline the save would still tidy: the save that follows the move would also move `{reveal}`
// under the other heading, a change nothing here has checked. Refused until the talk is settled.
{
  const typed = talkOf('### Title', STAR_ID('t1'), 'Text.', '', '### Other {reveal}', '{id=o1}', 'More.')
  assert.equal(outlineSaveChange(typed), 'tidy-up')
  const [finding] = strandedFindings(typed)
  assert.equal(finding.headingLine, 6)
  const ed = openTalk(typed)
  assert.equal(await click(ed, typed, finding), UNSETTLED, 'unsettled text is refused in plain words')
  assert.deepEqual([ed.text(), ed.writes], [typed, []], 'nothing is changed or saved')
  const pure = restoreScannedTitleIcon(typed, typed, finding)
  assert.deepEqual([pure.ok, pure.reason, pure.detail, pure.text], [false, 'unsettled', UNSETTLED, typed])
  // Once the autosave has tidied it, the same click moves the icon, and only that is written.
  await ed.autosave()
  const settled = ed.text()
  assert.equal(settled, talkOf('### Title', STAR_ID('t1'), 'Text.', '', '### Other', '{reveal}{id=o1}', 'More.'))
  assert.equal(await click(ed, settled, strandedFindings(settled)[0]), null)
  const verified = talkOf('### Title {icon=lucide:star}', '{id=t1}', 'Text.', '', '### Other', '{reveal}{id=o1}', 'More.')
  assert.deepEqual([ed.writes, ed.file(), ed.text()], [[settled, verified], verified, verified], 'the saved talk is the verified move and nothing else')
}

// A talk opened and not edited, with a heading that has no id yet: the save that follows the move
// would also stamp `{id=…}` under Other. Refused with nothing written; any edit, once its autosave
// has run, settles the talk (the autosave stamps the id and the editor takes it up), and then the
// click writes the move and nothing else.
{
  const opened = ['---', 'outline_version: 2', '---', '# Talk', '', '## Part', '{id=part}', '', '### Title', '{icon=lucide:star} {id=title}', 'Text.', '', '### Other', 'More.', ''].join('\n')
  assert.equal(normalizePositions(opened), opened, 'the tidy-up has nothing to do')
  assert.equal(outlineSaveChange(opened), 'ids', 'but a save would stamp an id')
  assert.match(await savedAs(opened), /### Other\n\{id=[a-z0-9]{5}\}\nMore\./, 'the save itself stamps the id under Other')
  const [finding] = strandedFindings(opened)
  assert.deepEqual([finding.headingLine, finding.slideTitle, finding.token], [9, 'Title', 'icon=lucide:star'])
  const pure = restoreScannedTitleIcon(opened, opened, finding)
  assert.deepEqual([pure.ok, pure.reason, pure.detail, pure.text], [false, 'unsettled', UNSETTLED, opened])
  const ed = openTalk(opened)
  assert.equal(await click(ed, opened, finding), UNSETTLED, 'a talk whose save would stamp an id is refused in plain words')
  assert.deepEqual([ed.text(), ed.writes, ed.file()], [opened, [], opened], 'nothing is changed and nothing is written')
  // The person makes any edit and waits for the autosave.
  ed.type(opened.replace('More.', 'More!'))
  await ed.autosave()
  const settled = ed.text()
  assert.match(settled, /### Other\n\{id=[a-z0-9]{5}\}\nMore!/, 'the autosave stamped the id and the editor took it up')
  assert.deepEqual([ed.file(), outlineSaveChange(settled)], [settled, null], 'the talk is settled')
  const [again] = strandedFindings(settled)
  assert.equal(await click(ed, settled, again), null, 'the same click now moves the icon')
  const verified = settled.replace('### Title\n{icon=lucide:star} {id=title}', '### Title {icon=lucide:star}\n{id=title}')
  assert.notEqual(verified, settled)
  assert.deepEqual([ed.writes.at(-1), ed.file(), ed.text()], [verified, verified, verified], 'and the file differs from the file before by that one move')
}

// A settled outline whose verified move the save would then tidy (with the icon's line gone, the
// tidy-up pulls the next layout line up against the title): refused, so the saved text is never
// other than the text that was verified.
{
  const text = talkOf('### Title', STAR, '', '{id=a1}')
  assert.equal(outlineSaveChange(text), null, 'the outline is settled')
  const plain = restoreTitleIcon(text, 5)
  assert.ok(plain.ok, 'the move itself is verified')
  assert.equal(outlineSaveChange(plain.text), 'tidy-up', 'but the save would change it further')
  const [finding] = strandedFindings(text)
  const pure = restoreScannedTitleIcon(text, text, finding)
  assert.deepEqual([pure.ok, pure.reason, pure.detail, pure.text], [false, 'not-verified', NOT_SAFE, text])
  const ed = openTalk(text)
  assert.equal(await click(ed, text, finding), NOT_SAFE)
  assert.deepEqual([ed.text(), ed.writes], [text, []], 'nothing is changed or saved')
}

// The other two steps of the save: a `\r` (a CodeMirror buffer reads it back as `\n`) and half of a
// surrogate pair (UTF-8 writes U+FFFD for it).
{
  const crlf = talkOf('### Title', STAR_ID('t1'), 'Text.').split('\n').join('\r\n')
  assert.equal(outlineSaveChange(crlf), 'line-endings')
  assert.notEqual(await savedAs(crlf), crlf)
  const lone = talkOf('### Title', STAR_ID('t1'), 'Half a pair: \uD83D.')
  assert.equal(outlineSaveChange(lone), 'encoding')
  assert.notEqual(await savedAs(lone), lone)
  assert.equal(outlineSaveChange(talkOf('### Title', STAR_ID('t1'), 'A whole pair: 😀.')), null)
  for (const text of [crlf, lone]) {
    const pure = restoreScannedTitleIcon(text, text, { headingLine: 6, token: 'icon=lucide:star', slideTitle: 'Title' })
    assert.deepEqual([pure.ok, pure.reason, pure.text], [false, 'unsettled', text])
  }
}
console.log('the button: a finding read from another text repairs nothing; a talk the save would tidy or stamp is refused with nothing written, and its next autosave settles it; a result the save would change is refused; a settled talk\'s file holds exactly the verified move')
console.log('PASS test-layout-doctor-restore-title-icon')
