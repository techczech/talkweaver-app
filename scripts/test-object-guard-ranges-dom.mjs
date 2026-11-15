// test:object-guard-ranges:dom — the object source guard never refuses a whole change (PR 395 review, 15 Nov 2026).
//
// The guard (objectBlocks/field.ts) takes out of a transaction only the one change that would break an
// object's opening or closing marker, and applies every other change in it. Here, in the real React
// Editor in Chromium (scripts/editor-dom-harness.mjs):
//   1. Replace All with matches in prose and inside objects' bodies, the caret on the object and
//      elsewhere: every match is replaced, the object still reads as itself, the count announced is
//      the count replaced, one Undo restores the talk.
//   2. Replace All of a character that is also an object's marker (a backtick, a colon, a hyphen, a
//      tilde): the prose and body matches are replaced, the markers stay, the announced count says
//      how many were left, one Undo restores the talk.
//   3. Typing at several places in one change (a prose line, the gap under an object, inside the
//      object's body), the caret in the gap: each goes where it was typed, the gap's on a line of its
//      own after the object.
//   4. A property test: random talks with objects, random ordinary edits (inside prose and inside
//      objects' bodies, away from marker lines, several at once, any caret, any input label) and
//      random line commands on prose lines (not moving a line past a title: the title protection
//      holds that, objects or not). What was asked for is what is applied: a dropped ordinary change
//      fails. SEED=<n> repeats a run; CASES=<n> sets how many talks.
import { strict as assert } from 'node:assert'
import { openEditorHarness } from './editor-dom-harness.mjs'

const h = await openEditorHarness()
const failures = []
let ran = 0
const doc = () => h.page.evaluate(() => window.view().state.doc.toString())
const announced = () => h.page.evaluate(() => document.querySelector('.cm-announced')?.textContent ?? '')
const objectsIn = (text) => h.page.evaluate((t) => window.entry.objects(t), text)
const pageErrors = () => h.errors.filter((message) => !/SVGLength': Could not resolve relative length/.test(message))

async function mountAt(text, caret, mode = 'plain') {
  await h.page.evaluate(({ text, mode }) => window.mount(text, mode), { text, mode })
  await h.page.waitForFunction((t) => window.view()?.state.doc.toString() === t, text)
  await h.page.evaluate((caret) => window.setCaret(caret), caret)
  await h.page.waitForTimeout(40)
}

async function check(name, fn) {
  ran += 1
  h.errors.length = 0
  try {
    await fn()
    assert.deepEqual(pageErrors(), [])
  } catch (error) {
    failures.push(`${name}\n    ${String(error.message).split('\n').join('\n    ')}`)
  }
}

const slide = (body) => `## One\n{id=s1}\n\nA cat sat here.\n\n${body}\n## Next\n{id=s2}\n\nMore cat\n`

// 1. Matches in prose and inside the object's body.
const BODY_MATCHES = [
  ['code', 'code', '```js\nlet cat = 1\n```'],
  ['chat', 'chat', '```chat\nUser: cat\nAssistant: Hello\n```'],
  ['mermaid diagram', 'mermaid', '```mermaid\ngraph LR\n  cat --> B\n```'],
  ['speaker notes', 'notes', ':::notes\nSay cat.\n:::'],
  ['comment', 'comment', '<!-- a cat remark -->'],
  ['table (pipe rows)', 'gfm-table', '| A | B |\n|---|---|\n| cat | 2 |'],
  ['table (trigger list)', 'trigger-table', '{table}\n- A: cat\n- B: 2'],
  ['web page', 'embed', '[Embed: https://example.com/cat]']
]
for (const [name, kind, object] of BODY_MATCHES) {
  for (const caretAt of ['on the object', 'elsewhere']) {
    await check(`Replace All in prose and body · ${name} · caret ${caretAt}`, async () => {
      const text = slide(object)
      const found = (await objectsIn(text)).find((b) => b.kind === kind)
      assert.ok(found, `the sample reads as ${kind}`)
      const matches = text.split('cat').length - 1
      await mountAt(text, caretAt === 'on the object' ? found.from : text.indexOf('sat'))
      assert.ok(await h.page.evaluate(() => window.entry.replaceAll('cat', 'dog', false)), 'Replace All ran')
      const after = await doc()
      assert.equal(after, text.replaceAll('cat', 'dog'), 'every match is replaced, in the prose and in the object')
      assert.ok((await objectsIn(after)).some((b) => b.kind === kind && b.from === found.from), 'the object still reads as itself')
      assert.equal(await announced(), `replaced ${matches} matches.`, 'the count announced is the count replaced')
      await h.page.evaluate(() => window.undoOnce())
      assert.equal(await doc(), text, 'one Undo restores the talk')
    })
  }
}

// 2. A character that is also a marker: [name, kind, text, find, replace, expected text, matches left].
const MARKER_CHARACTERS = [
  ['backtick, code fence', 'code', slide('Use `x` here.\n\n```js\nlet a = 1\n```'), '`', "'",
    slide("Use 'x' here.\n\n```js\nlet a = 1\n```"), 6],
  ['tilde, tilde fence', 'chat', slide('About ~5 people.\n\n~~~chat\nUser: ~hi\n~~~'), '~', '≈',
    slide('About ≈5 people.\n\n~~~chat\nUser: ≈hi\n~~~'), 6],
  ['colon, notes block', 'notes', slide('Time: now.\n\n:::notes\nSay: hello.\n:::'), ':', ';',
    slide('Time; now.\n\n:::notes\nSay; hello.\n:::'), 6],
  ['hyphen, comment', 'comment', slide('A well-known fact.\n\n<!-- a so-so remark -->'), '-', '–',
    slide('A well–known fact.\n\n<!-- a so–so remark -->'), 4]
]
for (const [name, kind, text, find, replace, expected, left] of MARKER_CHARACTERS) {
  for (const caretAt of ['on the object', 'elsewhere']) {
    await check(`Replace All of a marker character · ${name} · caret ${caretAt}`, async () => {
      const found = (await objectsIn(text)).find((b) => b.kind === kind)
      assert.ok(found, `the sample reads as ${kind}`)
      const matches = text.split(find).length - 1
      await mountAt(text, caretAt === 'on the object' ? found.from : text.indexOf('sat'))
      assert.ok(await h.page.evaluate(({ find, replace }) => window.entry.replaceAll(find, replace, false), { find, replace }), 'Replace All ran')
      const after = await doc()
      assert.equal(after, expected, 'the prose and body matches are replaced, the markers stay')
      assert.ok((await objectsIn(after)).some((b) => b.kind === kind && b.from === found.from && b.to === found.to), 'the object still reads as itself')
      const said = await announced()
      assert.ok(said.startsWith(`replaced ${matches - left} matches. ${left} were left as they were`), `the announced count: ${JSON.stringify(said)}`)
      await h.page.evaluate(() => window.undoOnce())
      assert.equal(await doc(), text, 'one Undo restores the talk')
    })
  }
}

// 2b. An allowed replacement that touches a protected one is still made (a fence's info string beside its
// backticks), and a closing line keeps the line break before it however it is indented.
{
  const text = slide('A jar.\n\n```js\nlet x = 1\n```')
  await check('Replace All: an info-string match beside the backticks is replaced', async () => {
    await mountAt(text, text.indexOf('```js'))
    assert.ok(await h.page.evaluate(() => window.entry.replaceAll('[`j]', 'X', true)), 'Replace All ran')
    const after = await doc()
    assert.equal(after, text.replaceAll('j', 'X'), 'every j is replaced, in the prose and in the info string; the backticks stay')
    assert.ok((await objectsIn(after)).some((b) => b.kind === 'code'), 'the object still reads as code')
    await h.page.evaluate(() => window.undoOnce())
    assert.equal(await doc(), text, 'one Undo restores the talk')
  })
  const indented = slide('```js\ncat\n  ```')
  await check('Replace All: the line break before an indented closing fence stays', async () => {
    const before = (await objectsIn(indented)).find((b) => b.kind === 'code')
    assert.ok(before, 'the sample reads as code')
    await mountAt(indented, indented.indexOf('sat'))
    assert.ok(await h.page.evaluate(() => window.entry.replaceAll('cat\\n', 'dog', true)), 'Replace All ran')
    const after = await doc()
    assert.ok(after.includes('```js\ncat\n  ```'), `the object is untouched: ${JSON.stringify(after)}`)
    assert.ok(after.endsWith('More dog'), 'the prose match is replaced')
    assert.ok((await objectsIn(after)).some((b) => b.kind === 'code' && b.from === before.from), 'the object still closes')
    await h.page.evaluate(() => window.undoOnce())
    assert.equal(await doc(), indented, 'one Undo restores the talk')
  })
}

// 3. Typing at several places in one change, the caret in the gap. (The editor has one caret; a change
// at several places comes from a command or another writer, as here.)
const SEVERAL = [
  ['code', '```js\nlet a = 1\n```', 'let a'],
  ['speaker notes', ':::notes\nSay hello.\n:::', 'Say'],
  ['table (pipe rows)', '| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |', '| 1']
]
for (const [name, object, bodyText] of SEVERAL) {
  for (const withBody of [false, true]) {
    await check(`typing at several places, the caret in the gap · ${name}${withBody ? ' · and in the body' : ''}`, async () => {
      const text = slide(object)
      const end = text.indexOf(object) + object.length
      const prose = text.indexOf(' sat')
      const body = text.indexOf(bodyText) + bodyText.length
      await mountAt(text, end)
      const changes = [{ from: prose, insert: 'Ok' }, ...(withBody ? [{ from: body, insert: 'Ok' }] : []), { from: end, insert: 'Ok' }]
      await h.page.evaluate((changes) => window.view().dispatch({ changes, userEvent: 'input.type' }), changes)
      await h.page.waitForTimeout(20)
      const expected = text.slice(0, prose) + 'Ok' + (withBody ? text.slice(prose, body) + 'Ok' + text.slice(body, end) : text.slice(prose, end)) +
        '\n\nOk' + text.slice(end)
      assert.equal(await doc(), expected, 'the prose and body text typed in place, the gap text on its own line after the object')
      await h.page.evaluate(() => window.undoOnce())
      assert.equal(await doc(), text, 'one Undo restores the talk')
    })
  }
}

// 4. The property test.
const OBJECTS = [
  ['chat', '```chat\nUser: Hi there\nAssistant: Hello you\n```'],
  ['chat (tilde fence)', '~~~chat\nUser: Hi there\n~~~'],
  ['terminal', '```terminal\n$ ls -la\nfile one\n```'],
  ['trace', '```trace\nstep one\nstep two\n```'],
  ['code', '```js\nlet a = 1\nlet b = 2\n```'],
  ['table (fence card)', '```table\n| A | B |\n|---|---|\n| 1 | 2 |\n```'],
  ['table (pipe rows)', '| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |'],
  ['table (trigger list)', '{table}\n- A: 1\n- B: 2\n- C: 3'],
  ['chart (fence)', '```chart\ntype: bar\nA: 1\nB: 2\n```'],
  ['bar chart (fence)', '```barchart\nA: 1\nB: 2\n```'],
  ['pie chart (fence)', '```piechart\nA: 1\nB: 2\n```'],
  ['mind map (trigger list)', '{mindmap}\n- Root\n  - Leaf one\n  - Leaf two'],
  ['mermaid diagram', '```mermaid\ngraph LR\n  A --> B\n  B --> C\n```'],
  ['speaker notes', ':::notes\nSay hello.\nThen go on.\n:::'],
  ['comment', '<!-- a private remark -->'],
  ['web page', '[Embed: https://example.com]']
]
const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel']
const COMMANDS = [
  ['bulleted list', () => h.page.evaluate(() => window.entry.actionBar('bulleted-list'))],
  ['numbered list', () => h.page.evaluate(() => window.entry.actionBar('numbered-list'))],
  ['indent (Tab)', () => h.press('Tab')],
  ['outdent (⇧Tab)', () => h.press('Shift+Tab')],
  ['indent more (⌘])', () => h.press('Meta+BracketRight')],
  ['comment the line (⌘/)', () => h.press('Meta+Slash')],
  ['move line up (⌥↑)', () => h.press('Alt+ArrowUp')],
  ['move line down (⌥↓)', () => h.press('Alt+ArrowDown')],
  ['copy line down (⇧⌥↓)', () => h.press('Shift+Alt+ArrowDown')],
  ['delete line (⌘⇧K)', () => h.press('Meta+Shift+k')],
  ['make heading at the same level (⌘⌥↑)', () => h.press('Meta+Alt+ArrowUp')],
  ['make subheading (⌘⌥↓)', () => h.press('Meta+Alt+ArrowDown')],
  ['move item up (⌘⇧↑)', () => h.press('Meta+Shift+ArrowUp')],
  ['move item down (⌘⇧↓)', () => h.press('Meta+Shift+ArrowDown')]
]
const seed = Number(process.env.SEED ?? Date.now() % 1e9)
let state = seed >>> 0
const random = () => {
  state = (state + 0x6d2b79f5) >>> 0
  let t = state
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const pick = (list) => list[Math.floor(random() * list.length)]
const word = () => pick(WORDS)

function randomTalk() {
  const parts = []
  const slides = 2 + Math.floor(random() * 3)
  for (let s = 1; s <= slides; s += 1) {
    parts.push(`## Slide ${s}\n{id=p${s}}\n`)
    const blocks = 1 + Math.floor(random() * 4)
    for (let b = 0; b < blocks; b += 1) {
      const r = random()
      if (r < 0.45) parts.push('\n' + pick(OBJECTS)[1] + '\n')
      else if (r < 0.75) parts.push(`\n${word()} ${word()} ${word()}, ${word()} ${word()}.\n`)
      else parts.push(`\n- ${word()} ${word()}\n- ${word()} ${word()}\n`)
    }
  }
  return parts.join('')
}

/** Where an object's last line starts and ends (objectEnd in objectBlocks/field.ts). */
function lastLineOf(text, block) {
  const at = Math.max(block.from, Math.min(block.to, text.length) - 1)
  const from = text.lastIndexOf('\n', at - 1) + 1
  const to = text.indexOf('\n', at)
  return { from, to: to < 0 ? text.length : to }
}

/** Lines an ordinary edit may touch: prose lines (no title, no `{…}` line, not blank) and the body
 *  lines of objects (not an object's first or last line, which hold its markers or end it). */
function editableLines(text, objects) {
  const lines = []
  let from = 0
  const edges = new Set()
  const inside = []
  for (const block of objects) {
    const last = lastLineOf(text, block)
    edges.add(block.from)
    edges.add(last.from)
    inside.push([block.from, last.to])
  }
  for (const line of text.split('\n')) {
    const to = from + line.length
    const inObject = inside.some(([a, b]) => from >= a && from <= b)
    const prose = !inObject && line.trim() && !/^#{1,6}\s/.test(line) && !/^\s*\{/.test(line)
    const body = inObject && !edges.has(from) && line.trim()
    if (prose || body) lines.push({ from, to, text: line, body: Boolean(body) })
    from = to + 1
  }
  return lines
}

function randomEdits(lines) {
  const chosen = [...lines].sort(() => random() - 0.5).slice(0, 1 + Math.floor(random() * 3)).sort((a, b) => a.from - b.from)
  return chosen.map((line) => {
    // Inside the line's words: past any list or prompt marks at its start, never at its very end.
    const lead = /^\s*(?:[-*]\s+|\d+\.\s+|\|\s*|\$\s+)?/.exec(line.text)[0].length
    const room = line.to - line.from - lead
    const at = line.from + lead + Math.floor(random() * Math.max(1, room - 1))
    const kind = random()
    if (kind < 0.4 || room < 3) return { from: at, insert: ` ${word()}` }
    const to = Math.min(line.to - 1, at + 1 + Math.floor(random() * 3))
    return kind < 0.7 ? { from: at, to } : { from: at, to, insert: word() }
  })
}

const CASES = Number(process.env.CASES ?? 160)
for (let n = 0; n < CASES; n += 1) {
  const text = randomTalk()
  const objects = await objectsIn(text)
  const lines = editableLines(text, objects)
  if (!lines.length || !objects.length) continue
  // The caret: on an object, at an object's end (the gap when nothing follows), or in prose.
  const object = pick(objects)
  const caretKind = pick(['on an object', 'at an object\'s end', 'in prose'])
  const prose = lines.filter((line) => !line.body)
  const caret = caretKind === 'on an object' ? object.from
    : caretKind === 'at an object\'s end' ? lastLineOf(text, object).to
      : prose.length ? pick(prose).from + 1 : 0
  const edits = randomEdits(lines)
  const userEvent = pick(['input.type', 'input.replace.all', 'input.paste', 'input', 'delete.selection', null])
  await check(`ordinary edits applied (seed ${seed}, case ${n}): ${edits.length} change${edits.length > 1 ? 's' : ''}, caret ${caretKind}, ${userEvent ?? 'no input label'}`, async () => {
    await mountAt(text, caret)
    const result = await h.page.evaluate(({ edits, userEvent }) => {
      const v = window.view()
      const asked = v.state.update({ changes: edits, filter: false }).newDoc.toString()
      v.dispatch({ changes: edits, ...(userEvent ? { userEvent } : {}) })
      return { asked, now: v.state.doc.toString() }
    }, { edits, userEvent })
    assert.equal(result.now, result.asked, `every ordinary change applies: ${JSON.stringify(edits)}`)
  })
  // A line command on a prose line: what it asks for is what is applied.
  if (prose.length) {
    const line = pick(prose)
    const [commandName, run] = pick(COMMANDS)
    await check(`line command applied (seed ${seed}, case ${n}): ${commandName} on ${JSON.stringify(line.text)}`, async () => {
      await mountAt(text, line.from + Math.floor(random() * (line.to - line.from)))
      // Record what the command asks for: its first change, built without the filters.
      await h.page.evaluate(() => {
        const v = window.view()
        const proto = Object.getPrototypeOf(v.state)
        const update = proto.update
        window.asked = null
        window.restoreUpdate = () => { proto.update = update }
        proto.update = function (...specs) {
          if (window.asked === null && this === v.state && !specs.some((spec) => spec && spec.filter === false)) {
            const tr = update.call(this, ...specs, { filter: false })
            // A change to a title or a `{…}` line (moving a line past a title) is the title protection's
            // to hold, not the object guard's: such a command is not checked here.
            let titles = false
            tr.changes.iterChangedRanges((fromA, toA) => {
              const lines = this.doc.sliceString(this.doc.lineAt(fromA).from, this.doc.lineAt(toA).to)
              if (/^(#{1,6}\s|\s*\{)/m.test(lines)) titles = true
            })
            if (tr.docChanged) window.asked = titles ? undefined : tr.newDoc.toString()
          }
          return update.apply(this, specs)
        }
      })
      try {
        await run()
        await h.page.waitForTimeout(20)
      } finally {
        await h.page.evaluate(() => window.restoreUpdate())
      }
      const asked = await h.page.evaluate(() => window.asked)
      if (typeof asked === 'string') assert.equal(await doc(), asked, 'the command\'s change applies as it asked')
    })
  }
}

await h.close()
if (failures.length) {
  console.error(`test:object-guard-ranges:dom — ${failures.length} of ${ran} cases failed:\n  ${failures.join('\n  ')}`)
  process.exit(1)
}
console.log(`test:object-guard-ranges:dom — ${ran} cases passed (Replace All, marker characters, several places at once, ${CASES} random talks; seed ${seed})`)
