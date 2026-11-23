// test:editor-title-enter-objects:dom — three editor fixes from the owner's own words (15 Nov 2026), in the
// real React Editor, in both views, with real key presses and clicks (scripts/editor-dom-harness.mjs).
//
//   A. Enter at the very start of a slide title opens a new empty line above it, the caret on that line,
//      the title untouched. Markdown view: column 0, before the hashes. Plain view: anywhere before the
//      title's first visible character (a click there lands after the hidden marks).
//   B. An object followed directly by a title, another object or the end has an empty line under it (the
//      gap) that the arrows and a click reach; typing, pasting or Enter there makes the line. Opening and
//      saving a talk writes nothing.
//   C. Backspace or Delete on a selected object deletes it whole; the object's header has a Delete button
//      with the same effect; one Undo brings it back. Next to an object, a key never joins a line onto it.
//
// Each case is `[name, before, keys, after]`: `|` is the caret, `[…]` a selection. Run per view.
import { strict as assert } from 'node:assert'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { openEditorHarness } from './editor-dom-harness.mjs'

const CHAT = '```chat\nUser: Hi\nAssistant: Hello\n```'
const TABLE = '| A | B |\n|---|---|\n| 1 | 2 |'
const shotsDir = process.env.TW_SHOTS_DIR ? resolve(process.env.TW_SHOTS_DIR) : null

// ── A: Enter from a title ────────────────────────────────────────────────────────────────────────────
const titleCases = (mode) => [
  ['column 0 of a ## title: a line above, caret on it', '## One\n\nText\n\n|## Two\n\nMore\n', ['Enter'], '## One\n\nText\n\n|\n## Two\n\nMore\n'],
  ['column 0 of a ### title', '## One\n\n|### Sub\n\nMore\n', ['Enter'], '## One\n\n|\n### Sub\n\nMore\n'],
  ['the first slide of the talk', '|## One\n\nText\n', ['Enter'], '|\n## One\n\nText\n'],
  ['a title directly after front matter', '---\ntitle: X\n---\n|## One\n\nText\n', ['Enter'], '---\ntitle: X\n---\n|\n## One\n\nText\n'],
  ['twice: two lines above', '## One\n\n|## Two\n', ['Enter', 'Enter'], '## One\n\n\n|\n## Two\n'],
  ['type a new slide on the new line', '## One\n\n|## Two\n', ['Enter', '#', '#', ' ', 'N', 'e', 'w'], '## One\n\n## New|\n## Two\n'],
  // After the marks: the Plain view's start of the title (the marks are hidden); the Markdown view's middle.
  mode === 'plain'
    ? ['Plain: after the marks is the start of the title', '## One\n\n## |Two\n\nMore\n', ['Enter'], '## One\n\n|\n## Two\n\nMore\n']
    : ['Markdown: after the marks is the middle of the title (unchanged)', '## One\n\n## |Two\n\nMore\n', ['Enter'], '## One\n\n## Two\n|\nMore\n'],
  mode === 'plain'
    ? ['Plain: between the marks and the space', '## One\n\n##| Two\n\nMore\n', ['Enter'], '## One\n\n|\n## Two\n\nMore\n']
    : ['Markdown: between the marks and the space (unchanged)', '## One\n\n##| Two\n\nMore\n', ['Enter'], '## One\n\n## Two\n|\nMore\n'],
  mode === 'plain'
    ? ['Plain: the hidden marks selected (a click at the very start can leave them so)', '## One\n\n[## ]Two\n\nMore\n', ['Enter'], '## One\n\n|\n## Two\n\nMore\n']
    : ['Markdown: the marks selected (unchanged: Enter does nothing)', '## One\n\n[## ]Two\n\nMore\n', ['Enter'], '## One\n\n[## ]Two\n\nMore\n'],
  // A title that starts with inline marks: the Plain view hides the marks, so before the first visible
  // letter is still the start of the title; the Markdown view keeps column 0.
  ...[
    ['bold', '## **|Two**', '## **Two**'],
    ['italic', '## *|Two*', '## *Two*'],
    ['italic (underscores)', '## _|Two_', '## _Two_'],
    ['code', '## `|Two` here', '## `Two` here'],
    ['link', '## [|Two](https://example.com)', '## [Two](https://example.com)'],
    ['nested marks', '## **_|Two_**', '## **_Two_**'],
    ['highlight', '## ==|Two==', '## ==Two=='],
    ['between two of the marks', '## *|*Two**', '## **Two**']
  ].map(([what, at, title]) => mode === 'plain'
    ? [`Plain: a title starting with ${what}, before its first letter`, `## One\n\n${at}\n\nMore\n`, ['Enter'], `## One\n\n|\n${title}\n\nMore\n`]
    : [`Markdown: a title starting with ${what}, past column 0 (unchanged)`, `## One\n\n${at}\n\nMore\n`, ['Enter'], `## One\n\n${title}\n|\nMore\n`]),
  ['a title starting with bold, after its first letter (unchanged)', '## One\n\n## **T|wo**\n\nMore\n', ['Enter'], '## One\n\n## **Two**\n|\nMore\n'],
  mode === 'plain'
    ? ['Plain: a title starting with a picture, before it', '## One\n\n## |![](pic.png) Two\n\nMore\n', ['Enter'], '## One\n\n|\n## ![](pic.png) Two\n\nMore\n']
    : ['Markdown: a title starting with a picture, past column 0 (unchanged)', '## One\n\n## |![](pic.png) Two\n\nMore\n', ['Enter'], '## One\n\n## ![](pic.png) Two\n|\nMore\n'],
  ['a title starting with a picture, after it: the picture is the first thing shown (unchanged)', '## One\n\n## ![](pic.png)| Two\n\nMore\n', ['Enter'], '## One\n\n## ![](pic.png) Two\n|\nMore\n'],
  mode === 'plain'
    ? ['Plain: a title with an icon, before its first letter (the icon shows before it)', '## One\n\n## |Two {icon=lucide:route}\n\nMore\n', ['Enter'], '## One\n\n|\n## Two {icon=lucide:route}\n\nMore\n']
    : ['Markdown: a title with an icon, past column 0 (unchanged)', '## One\n\n## |Two {icon=lucide:route}\n\nMore\n', ['Enter'], '## One\n\n## Two {icon=lucide:route}\n|\nMore\n'],
  // Neighbours, unchanged.
  ['middle of a title (unchanged)', '## One\n\n## T|wo\n\nMore\n', ['Enter'], '## One\n\n## Two\n|\nMore\n'],
  ['end of a title with a body line: reuse that line', '## One\n\n## Two|\n\nMore\n', ['Enter'], '## One\n\n## Two\n|\nMore\n'],
  ['column 0 of an ordinary line (unchanged)', '## One\n\n|Text\n', ['Enter'], '## One\n\n\n|Text\n'],
  ['column 0 of a list item (unchanged)', '## One\n\n|- a\n- b\n', ['Enter'], '## One\n\n\n- |- a\n- b\n'],
  ['an unfinished heading: go to its existing body', '## One\n\n## |\nMore\n', ['Enter'], '## One\n\n## \n|More\n'],
  ['end of a title directly before body text: go to the body', '## One|\nMore\n', ['Enter'], '## One\n|More\n'],
  ['end of a stamped title with a body line: reuse it below the ID', '## One|\n{id=one}\n\nMore\n', ['Enter'], '## One\n{id=one}\n|\nMore\n'],
  ['column 0 of the talk title # (unchanged)', '|# Talk\n\n## One\n', ['Enter'], '\n|# Talk\n\n## One\n'],
  ['a selection starting at column 0 of a title (unchanged: Enter does nothing)', '## One\n\n[## Tw]o\n', ['Enter'], '## One\n\n[## Tw]o\n'],
  ['column 0 of an object line opens the object (text unchanged)', `## One\n\n|${CHAT}\n\nMore\n`, ['Enter'], `## One\n\n|${CHAT}\n\nMore\n`],
  // B's other side: a slide that begins with an object gets a line from the title.
  ['end of a title whose slide begins with an object: a line above the object', `## One|\n${CHAT}\n## Two\n`, ['Enter'], `## One\n|\n\n${CHAT}\n## Two\n`],
  ['end of a stamped title before an object: a line below the ID, with a separator', `## One|\n{id=one}\n${CHAT}\n## Two\n`, ['Enter'], `## One\n{id=one}\n|\n\n${CHAT}\n## Two\n`]
]

// ── B: the line after an object ─────────────────────────────────────────────────────────────────────
const gapCases = [
  ['ArrowDown from an object before a title: the gap', `## One\n\n|${CHAT}\n## Two\n`, ['ArrowDown'], `## One\n\n${CHAT}|\n## Two\n`],
  ['type at the gap: blank line, then the text', `## One\n\n|${CHAT}\n## Two\n`, ['ArrowDown', 'O', 'k'], `## One\n\n${CHAT}\n\nOk|\n## Two\n`],
  ['Enter at the gap: blank line, caret on a new line', `## One\n\n|${CHAT}\n## Two\n`, ['ArrowDown', 'Enter'], `## One\n\n${CHAT}\n\n|\n## Two\n`],
  ['ArrowDown again: onto the title below', `## One\n\n|${CHAT}\n## Two\n`, ['ArrowDown', 'ArrowDown'], `## One\n\n${CHAT}\n|## Two\n`],
  ['ArrowUp from the title below: the gap', `## One\n\n${CHAT}\n## T|wo\n`, ['ArrowUp'], `## One\n\n${CHAT}|\n## Two\n`],
  ['ArrowUp twice: the object', `## One\n\n${CHAT}\n## T|wo\n`, ['ArrowUp', 'ArrowUp'], `## One\n\n|${CHAT}\n## Two\n`],
  ['ArrowRight from the object: the gap', `## One\n\n|${CHAT}\n## Two\n`, ['ArrowRight'], `## One\n\n${CHAT}|\n## Two\n`],
  ['ArrowLeft from the gap: the object', `## One\n\n${CHAT}|\n## Two\n`, ['ArrowLeft'], `## One\n\n|${CHAT}\n## Two\n`],
  ['an object at the end of the talk: ArrowDown writes nothing', `## One\n\n|${CHAT}`, ['ArrowDown'], `## One\n\n${CHAT}|`],
  ['an object at the end of the talk: type there', `## One\n\n|${CHAT}`, ['ArrowDown', 'O', 'k'], `## One\n\n${CHAT}\n\nOk|`],
  ['two objects in a row: a gap between them', `## One\n\n|${CHAT}\n${TABLE}\n\nMore\n`, ['ArrowDown', 'O', 'k'], `## One\n\n${CHAT}\n\nOk|\n${TABLE}\n\nMore\n`],
  ['a table before a title: text never joins the table', `## One\n\n|${TABLE}\n## Two\n`, ['ArrowDown', 'O', 'k'], `## One\n\n${TABLE}\n\nOk|\n## Two\n`],
  ['an object with a blank line after it has no gap (the blank line is the line)', `## One\n\n|${CHAT}\n\n## Two\n`, ['ArrowDown'], `## One\n\n${CHAT}\n|\n## Two\n`]
]

// ── C: deleting an object ───────────────────────────────────────────────────────────────────────────
const deleteCases = [
  ['Backspace on a selected chat', `## One\n\nIntro\n\n|${CHAT}\n\nMore\n`, ['Backspace'], '## One\n\nIntro\n\n|More\n'],
  ['Delete on a selected chat', `## One\n\nIntro\n\n|${CHAT}\n\nMore\n`, ['Delete'], '## One\n\nIntro\n\n|More\n'],
  ['Backspace on a selected table before a title', `## One\n\n|${TABLE}\n## Two\n`, ['Backspace'], '## One\n\n|## Two\n'],
  ['Backspace on the last object of the talk', `## One\n\nIntro\n\n|${CHAT}`, ['Backspace'], '## One\n\nIntro\n|'],
  ['Backspace at the start of the title below: gap, then object, then deleted', `## One\n\nIntro\n${CHAT}\n|## Two\n`, ['Backspace', 'Backspace', 'Backspace'], '## One\n\nIntro\n|## Two\n'],
  ['Backspace at the start of text below: selects, never joins', `## One\n\n${CHAT}\n|More\n`, ['Backspace'], `## One\n\n|${CHAT}\nMore\n`],
  ['Backspace on an empty line below: takes the empty line', `## One\n\n${CHAT}\n|\n## Two\n`, ['Backspace'], `## One\n\n${CHAT}|\n## Two\n`],
  ['Delete at the end of the line above: selects, never joins', `## One\n\nIntro|\n${CHAT}\n## Two\n`, ['Delete'], `## One\n\nIntro\n|${CHAT}\n## Two\n`],
  ['Delete at the gap does nothing', `## One\n\n${CHAT}|\n## Two\n`, ['Delete'], `## One\n\n${CHAT}|\n## Two\n`],
  // A table read from a trigger list owns its `{table}`: deleting the table takes it too.
  ['Backspace on a table list takes its {table} line with it', '## One\n\nIntro\n\n{table}\n|- A: 1\n- B: 2\n\nMore\n', ['Backspace'], '## One\n\nIntro\n\n|More\n'],
  ['Backspace on a table list whose {table} shares the line with the id: only the token goes', '## One\n{table id=s1}\n\n|- A: 1\n- B: 2\n\n## Two\n', ['Backspace'], '## One\n{id=s1}\n\n|## Two\n'],
  ['Backspace on a table list, then Undo: list and {table} back exactly', '## One\n\nIntro\n\n{table}\n|- A: 1\n- B: 2\n\nMore\n', ['Backspace', 'ControlOrMeta+z'], '## One\n\nIntro\n\n{table}\n|- A: 1\n- B: 2\n\nMore\n'],
  ['Backspace on a selected object, then Undo: back whole', `## One\n\n|${CHAT}\n\nMore\n`, ['Backspace', 'ControlOrMeta+z'], `## One\n\n|${CHAT}\n\nMore\n`]
]

const h = await openEditorHarness()
let ran = 0
const failures = []
async function run(mode, [name, before, keys, after]) {
  ran += 1
  try {
    await h.mount(before, mode)
    for (const key of keys) await h.press(key)
    assert.equal(await h.shown(), after)
    assert.deepEqual(h.errors, [])
  } catch (error) {
    failures.push(`${mode}: ${name}\n    ${String(error.message).split('\n').join('\n    ')}`)
  }
}
async function check(mode, name, body) {
  ran += 1
  try { await body() } catch (error) { failures.push(`${mode}: ${name}\n    ${error.message}`) }
}

try {
  for (const mode of ['markdown', 'plain']) {
    for (const c of titleCases(mode)) await run(mode, c)
    for (const c of gapCases) await run(mode, c)
    for (const c of deleteCases) await run(mode, c)

    if (mode === 'markdown') {
      for (let level = 1; level <= 6; level++) {
        const marks = '#'.repeat(level)
        await check(mode, `Enter immediately after ${marks} preserves nearby headings and stays before the next title`, async () => {
          const before = level === 1 ? '' : '# Talk title\n\n'
          const role = level === 2 ? '{role=section-title}' : level === 3 ? '{sub}{role=subsection-title}' : ''
          const metadata = level === 1 ? '' : `{id=current}${role}\n`
          const next = `${'#'.repeat(Math.min(level + 1, 6))} Next title {id=next}\n- Point\n\n## Another title {id=another}\n`
          await h.mount(`${before}${marks}| Current title\n${metadata}\n${next}`, mode)
          await h.press('Enter')
          const result = await h.page.evaluate(() => {
            const { doc, selection } = window.view().state
            return { text: doc.toString(), caret: selection.main.head, sectionChild: window.sectionChild }
          })
          assert.ok(result.text.startsWith(before), 'earlier title bytes are unchanged')
          assert.ok(result.text.endsWith(next), 'later title and ID bytes are unchanged')
          assert.equal(result.sectionChild, null, 'Enter does not ask the workspace to open the next title')
          assert.ok(result.caret < result.text.length - next.length, 'the caret stays before the next title')
        })
      }
    }

    await check(mode, 'A: one Undo restores the text and the caret exactly', async () => {
      await h.mount('## One\n\nText\n\n|## Two\n\nMore\n', mode)
      await h.press('Enter')
      assert.equal(await h.page.evaluate(() => window.depth()), 1)
      await h.press('ControlOrMeta+z')
      assert.equal(await h.shown(), '## One\n\nText\n\n|## Two\n\nMore\n')
    })

    await check(mode, 'A: Enter while an input method is composing is not taken', async () => {
      await h.mount('## One\n\n|## Two\n', mode)
      await h.page.evaluate(() => {
        const dom = window.view().contentDOM
        dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }))
        dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true, bubbles: true, cancelable: true }))
        dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }))
      })
      assert.equal(await h.page.evaluate(() => window.view().state.doc.toString()), '## One\n\n## Two\n')
    })

    await check(mode, 'A: a click at the very start of the title, then Enter', async () => {
      await h.mount('## One\n\nText\n\n## Two\n\nMore\n|', mode)
      const box = await h.page.locator('.cm-line', { hasText: 'Two' }).boundingBox()
      await h.page.mouse.click(box.x + 1, box.y + box.height / 2)
      await h.press('Enter')
      assert.equal(await h.shown(), '## One\n\nText\n\n|\n## Two\n\nMore\n')
    })

    await check(mode, 'B: the gap shows the caret, and a click on it puts the caret there', async () => {
      const text = `## One\n\n${CHAT}\n## Two\n\nMore\n`
      await h.mount(text + '|', mode)
      assert.equal(await h.page.locator('.tw-obj-gap').count(), 1, 'one gap, under the object before the title')
      await h.page.locator('.tw-obj-gap').click()
      assert.equal(await h.shown(), `## One\n\n${CHAT}|\n## Two\n\nMore\n`)
      assert.equal(await h.page.locator('.tw-obj-gap.is-caret').count(), 1)
      assert.equal(await h.page.locator('.tw-obj-selected').count(), 0, 'the object is not selected while the caret is under it')
      if (shotsDir && mode === 'plain') {
        mkdirSync(shotsDir, { recursive: true })
        await h.page.screenshot({ path: join(shotsDir, 'caret-after-trailing-object.png') })
      }
      await h.page.keyboard.type('Next')
      assert.equal(await h.shown(), `## One\n\n${CHAT}\n\nNext|\n## Two\n\nMore\n`)
    })

    await check(mode, 'B: paste at the gap goes on the new line', async () => {
      await h.mount(`## One\n\n${CHAT}|\n## Two\n`, mode)
      await h.page.evaluate(() => {
        const data = new DataTransfer()
        data.setData('text/plain', 'Pasted')
        window.view().contentDOM.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
      })
      assert.equal(await h.shown(), `## One\n\n${CHAT}\n\nPasted|\n## Two\n`)
    })

    await check(mode, 'B: opening, moving round and saving an untouched talk writes nothing', async () => {
      const text = `---\ntitle: Kept\n---\n## One\n${CHAT}\n## Two\n\n${TABLE}\n${CHAT}`
      await h.mount(`|${text}`, mode)
      for (const key of ['ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowUp', 'ArrowUp']) await h.press(key)
      await h.page.locator('.tw-obj-gap').last().click()
      await h.page.evaluate(() => window.cmd.flushSave())
      await h.page.waitForTimeout(1700)
      assert.deepEqual(await h.page.evaluate(() => window.writes), [], 'no write')
      assert.equal(await h.page.evaluate(() => window.view().state.doc.toString()), text, 'the text is byte-identical')
    })

    for (const [kind, object] of [['chat card', CHAT], ['table', TABLE], ['mermaid diagram', '```mermaid\ngraph LR\n  A --> B\n```']]) {
      await check(mode, `C: the ${kind}'s Delete button deletes it whole; one Undo brings it back`, async () => {
        const text = `## One\n\nIntro\n\n${object}\n\nMore\n`
        await h.mount(`## One\n\nIntro\n\n|${object}\n\nMore\n`, mode)
        const button = h.page.locator('.tw-obj .tw-obj-action-remove').first()
        assert.equal((await button.textContent()).trim(), 'Delete')
        if (shotsDir && mode === 'plain' && kind === 'table') {
          await h.page.locator('.tw-obj').first().hover()
          mkdirSync(shotsDir, { recursive: true })
          await h.page.screenshot({ path: join(shotsDir, 'object-delete-button.png') })
        }
        await button.click()
        assert.equal(await h.page.evaluate(() => window.view().state.doc.toString()), '## One\n\nIntro\n\nMore\n')
        await h.press('ControlOrMeta+z')
        assert.equal(await h.page.evaluate(() => window.view().state.doc.toString()), text)
      })
    }
  }
} finally {
  await h.close()
}

if (failures.length) {
  console.error(`test:editor-title-enter-objects:dom — ${failures.length} of ${ran} cases failed:\n  ${failures.join('\n  ')}`)
  process.exit(1)
}
console.log(`test:editor-title-enter-objects:dom — ${ran} cases passed in both views`)
