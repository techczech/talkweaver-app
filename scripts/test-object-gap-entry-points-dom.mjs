// test:object-gap-entry-points:dom — no way in can write onto an object's lines (PR 395 review, 15 Nov 2026).
//
// The place under an object that has no line of its own after it (the gap) is, in the text, the end of
// the object's last line: its closing fence, its `:::`, its `-->`, its last table row or list item, its
// page line. The object source guard (objectBlocks/field.ts) is a rule on the change itself, so every
// way text comes in is tried there, for every kind of object, in three places: at the end of a slide
// (a title follows), at the end of the talk with no line break after it, and at the end of the talk
// with one. After each: the object's text is byte for byte what it was, the new text is on a line of
// its own after one blank line, everything after it is as it was, and one Undo gives back the talk
// exactly. Line commands at the gap act on a new line under the object exactly as on a real line there;
// with the object selected they leave the text as it is. The real React Editor in Chromium
// (scripts/editor-dom-harness.mjs); real keys, a real paste event, the app's Paste command, a real input
// method composition (Chrome DevTools Protocol).
import { strict as assert } from 'node:assert'
import { openEditorHarness } from './editor-dom-harness.mjs'

// Every kind the object reader knows (detect.ts ObjectBlockKind), each written the way an author does.
const OBJECTS = [
  ['chat', 'chat', '```chat\nUser: Hi\nAssistant: Hello\n```'],
  ['chat (tilde fence)', 'chat', '~~~chat\nUser: Hi\n~~~'],
  ['terminal', 'terminal', '```terminal\n$ ls\nfile\n```'],
  ['trace', 'trace', '```trace\nstep one\n```'],
  ['code', 'code', '```js\nlet a = 1\n```'],
  ['table (fence card)', 'code', '```table\n| A | B |\n|---|---|\n| 1 | 2 |\n```'],
  ['table (pipe rows)', 'gfm-table', '| A | B |\n|---|---|\n| 1 | 2 |'],
  ['table (trigger list)', 'trigger-table', '{table}\n- A: 1\n- B: 2'],
  ['chart (fence)', 'chart', '```chart\ntype: bar\nA: 1\nB: 2\n```'],
  ['bar chart (fence)', 'barchart', '```barchart\nA: 1\nB: 2\n```'],
  ['pie chart (fence)', 'piechart', '```piechart\nA: 1\nB: 2\n```'],
  ['line chart (fence)', 'linechart', '```linechart\nA: 1\nB: 2\n```'],
  ['chart (trigger list)', 'chart', '{chart=bar}\n- A: 1\n- B: 2'],
  ['mind map (trigger list)', 'mindmap', '{mindmap}\n- Root\n  - Leaf'],
  ['mermaid diagram', 'mermaid', '```mermaid\ngraph LR\n  A --> B\n```'],
  ['svg picture', 'svg', '```svg\n<svg viewBox="0 0 10 10"><rect width="5" height="5"/></svg>\n```'],
  ['speaker notes', 'notes', ':::notes\nSay hello.\n:::'],
  ['comment', 'comment', '<!-- a private remark -->'],
  ['web page', 'embed', '[Embed: https://example.com]'],
  ['widget (local page)', 'embed', '[Embed: widgets/poll.html]'],
  ['simulation', 'embed', '[Simulation: sims/chat.html]'],
  ['video', 'embed', '[Video: clips/intro.mp4]']
]

// The slide has its id already, so an object insert writes only the object (it stamps one otherwise).
const PLACES = [
  ['end of a slide', (o) => `## One\n{id=s1}\n\nIntro\n\n${o}\n## Next\n{id=s2}\n\nMore\n`],
  ['end of the talk, no line break', (o) => `## One\n{id=s1}\n\nIntro\n\n${o}`],
  ['end of the talk, a line break', (o) => `## One\n{id=s1}\n\nIntro\n\n${o}\n`]
]

const IME_TEXT = '日本'

// Each way in: what it writes, and how to make it write at the caret (the gap).
const ENTRY_POINTS = [
  ['typing', 'Ok', async (h) => { await h.page.keyboard.type('Ok') }],
  ['Enter (an empty line, the caret on it)', '', async (h) => { await h.page.keyboard.press('Enter') }],
  ['input method composition', IME_TEXT, async (h) => {
    await h.cdp.send('Input.imeSetComposition', { text: 'に', selectionStart: 1, selectionEnd: 1 })
    await h.page.waitForTimeout(30)
    await h.cdp.send('Input.imeSetComposition', { text: 'にほ', selectionStart: 2, selectionEnd: 2 })
    await h.page.waitForTimeout(30)
    await h.cdp.send('Input.insertText', { text: IME_TEXT })
    await h.page.waitForTimeout(30)
  }],
  ['paste event (⌘V)', 'Pasted', async (h) => {
    await h.page.evaluate(() => {
      const data = new DataTransfer()
      data.setData('text/plain', 'Pasted')
      window.view().contentDOM.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    })
  }],
  ['Paste command (Edit menu, palette)', 'Pasted', async (h) => {
    await h.page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: async () => 'Pasted' } })
      window.cmd.pasteClipboard()
    })
    await h.page.waitForFunction(() => window.view().state.doc.toString().includes('Pasted'), null, { timeout: 2000 })
  }],
  ['pasted table (recognised clipboard table)', '| X | Y |', async (h) => {
    await h.page.evaluate(() => window.entry.pasteBlock('| X | Y |\n|---|---|\n| 3 | 4 |\n'))
  }],
  ['replace the selection (no event name)', 'Ok', async (h) => { await h.page.evaluate(() => window.entry.replaceSelection('Ok')) }],
  ['drop', 'Dropped', async (h) => {
    await h.page.evaluate(() => { const v = window.view(); window.entry.insertAt(v.state.selection.main.head, 'Dropped', 'input.drop') })
  }],
  ['Find and Replace', 'Ok', async (h) => {
    // A match that starts at the gap: the line break after the object and the title after it. (At the
    // end of the talk nothing comes after the object for a match to start with.)
    // The title itself is protected, so the match is the line break before it.
    const replaced = await h.page.evaluate(() => window.entry.replaceAll('\\n(?=## Next)', 'Ok\\n', true))
    if (!replaced) throw new Error('nothing replaced')
  }, (place) => place === 'end of a slide'],
  ['insert at the caret (Scratchpad, archive picture, searched slide)', 'Inserted', async (h) => {
    await h.page.evaluate(() => window.insertAtCaret('Inserted'))
  }],
  ['insert speaker notes (command)', ':::notes', async (h) => {
    await h.page.evaluate(() => window.entry.insertNotes())
  }, (place, objectName) => objectName !== 'speaker notes'],
  ['insert an object (Insert menu)', '```mermaid', async (h) => {
    await h.page.evaluate(() => window.insertObject('mermaid'))
  }]
]

// Commands that work on "the caret's line". With the caret in the gap that line is the line under the
// object: each acts as it does on a real empty line there (the oracle: the same command, the caret on
// that line made by hand), in one undo step, and never on the object's lines. A command that does
// nothing on an empty line (moving it, promoting it) does nothing at the gap either: no line is made.
// Each case remounts the editor and starts with fresh undo history. Read the command's
// transaction after the key press without the shared harness's inter-key delay.
const LINE_COMMANDS = [
  ['move up (⌘⇧↑)', (h) => h.page.keyboard.press('ControlOrMeta+Shift+ArrowUp')],
  ['move down (⌘⇧↓)', (h) => h.page.keyboard.press('ControlOrMeta+Shift+ArrowDown')],
  ['move line up (⌥↑)', (h) => h.page.keyboard.press('Alt+ArrowUp')],
  ['copy line down (⇧⌥↓)', (h) => h.page.keyboard.press('Shift+Alt+ArrowDown')],
  ['promote (⌘⇧←)', (h) => h.page.keyboard.press('ControlOrMeta+Shift+ArrowLeft')],
  ['demote (⌘⇧→)', (h) => h.page.keyboard.press('ControlOrMeta+Shift+ArrowRight')],
  ['promote with subtree (⌘⌥⇧←)', (h) => h.page.keyboard.press('ControlOrMeta+Alt+Shift+ArrowLeft')],
  ['make heading at the same level (⌘⌥↑)', (h) => h.page.keyboard.press('ControlOrMeta+Alt+ArrowUp')],
  ['make subheading (⌘⌥↓)', (h) => h.page.keyboard.press('ControlOrMeta+Alt+ArrowDown')],
  ['delete line (⌘⇧K)', (h) => h.page.keyboard.press('ControlOrMeta+Shift+k')],
  ['indent (Tab)', (h) => h.page.keyboard.press('Tab')],
  ['outdent (⇧Tab)', (h) => h.page.keyboard.press('Shift+Tab')],
  ['indent more (⌘])', (h) => h.page.keyboard.press('ControlOrMeta+BracketRight')],
  ['comment the line (⌘/)', (h) => h.page.keyboard.press('ControlOrMeta+Slash')],
  ['bold (⌘B)', (h) => h.page.keyboard.press('ControlOrMeta+b')],
  ['bulleted list (action bar)', (h) => h.page.evaluate(() => window.entry.actionBar('bulleted-list'))],
  ['numbered list (action bar)', (h) => h.page.evaluate(() => window.entry.actionBar('numbered-list'))]
]
// These write something on an empty line, so at the gap their effect must show (never "no change").
const WRITES_ON_AN_EMPTY_LINE = /^(copy line|demote|make heading|make subheading|delete line|indent \(|indent more|comment|bold|bulleted|numbered)/

const [shardArg, ...extraArgs] = process.argv.slice(2)
const shard = shardArg && /^--shard=([1-9]\d*)\/([1-9]\d*)$/.exec(shardArg)
if (extraArgs.length || (shardArg && (!shard || Number(shard[1]) > Number(shard[2]) || Number(shard[2]) > OBJECTS.length))) {
  throw new Error('Use --shard=<1-based index>/<count>, with count no greater than the number of object fixtures')
}
const fixtures = shard ? OBJECTS.filter((_, index) => index % Number(shard[2]) === Number(shard[1]) - 1) : OBJECTS

const h = await openEditorHarness()
h.cdp = await h.page.context().newCDPSession(h.page)
const failures = []
let ran = 0
const doc = () => h.page.evaluate(() => window.view().state.doc.toString())

// The samples hold `|` and `[`, which the harness's mount reads as the caret, so the caret is put directly.
function setCaretWhenReady({ text, caret, mode }) {
  if (mode) window.mount(text, mode)
  if (window.view()?.state.doc.toString() !== text) return false
  window.setCaret(caret)
  return true
}

async function mountAt(text, caret, mode) {
  if (await h.page.evaluate(setCaretWhenReady, { text, caret, mode })) return
  const ready = await h.page.waitForFunction(setCaretWhenReady, { text, caret })
  await ready.dispose()
}

// Record the edited buffer and its parsed objects before Undo, then record the restored buffer.
function editAndUndo(before, { refocus = false, inspect = true } = {}) {
  return h.page.evaluate(({ before, refocus, inspect }) => {
    const view = window.view()
    const after = view.state.doc.toString()
    const objects = inspect ? window.entry.objects(after) : []
    if (after !== before) {
      if (refocus) view.focus()
      window.undoOnce()
    }
    return { after, objects, restored: view.state.doc.toString() }
  }, { before, refocus, inspect })
}

async function tryEntry(mode, [objectName, kind, object], [placeName, place], [entryName, marker, act, applies], selected = false) {
  if (applies && !applies(placeName, objectName)) return
  ran += 1
  h.errors.length = 0
  const text = place(object)
  const from = text.indexOf(object)
  const end = from + object.length
  try {
    const found = await h.page.evaluate((t) => window.entry.objects(t), text)
    // (A trigger list object starts at its list; its `{…}` line is above it.)
    const isIt = (b) => b.kind === kind && b.from >= from && b.from < end
    assert.ok(found.some(isIt), `the sample reads as ${kind}: ${JSON.stringify(found.map((b) => b.kind))}`)
    // At the gap (the end of the object's last line), or with the object selected (the caret at its start).
    await mountAt(text, selected ? found.find(isIt).from : end, mode)
    await act(h)
    const { after, objects, restored } = await editAndUndo(text, { refocus: true })
    assert.equal(after.slice(0, end), text.slice(0, end), 'the object and everything before it are unchanged')
    // On a line of its own: after a blank line, or (the talk ending in a line break, so a real line is
    // already there under the object) on that line.
    const blank = after.startsWith('\n\n', end)
    assert.ok(blank || (placeName.endsWith('a line break') && after[end] === '\n'), `the new text is after a blank line: ${JSON.stringify(after.slice(end, end + 12))}`)
    const line = after.slice(end + (blank ? 2 : 1)).split('\n')[0]
    assert.ok(line.startsWith(marker), `the new text starts its own line: ${JSON.stringify(line)}`)
    assert.ok(after.endsWith(text.slice(blank ? end : end + 1)), 'everything after the object is as it was')
    assert.ok(objects.some(isIt), 'the object still reads as itself')
    assert.equal(restored, text, 'one Undo restores the talk exactly')
    // (The mind map's preview measures its SVG before the harness page lays it out; that is the preview
    // library's message, not this test's.)
    assert.deepEqual(h.errors.filter((message) => !/SVGLength': Could not resolve relative length/.test(message)), [])
  } catch (error) {
    failures.push(`${mode}: ${objectName} · ${placeName} · ${entryName}\n    ${String(error.message).split('\n').join('\n    ')}`)
  }
}

try {
  for (const object of fixtures) {
    for (const place of PLACES) {
      for (const entry of ENTRY_POINTS) await tryEntry('plain', object, place, entry)
    }
  }
  // With the object selected (the caret at its start), text never goes into it either: it goes after it.
  for (const object of fixtures) {
    for (const entry of ENTRY_POINTS.filter(([name]) => /^(typing|input method|paste event|Paste command|replace the selection|insert at the caret|insert an object)/.test(name))) {
      await tryEntry('plain · object selected', object, PLACES[0], entry, true)
    }
  }
  // Line commands at the gap: the command's effect on a new line under the object, the object's text
  // byte for byte as it was, one Undo back to the talk.
  for (const [objectName, kind, object] of fixtures) {
    for (const [placeName, place] of PLACES) {
      for (const [commandName, act] of LINE_COMMANDS) {
        ran += 1
        h.errors.length = 0
        const text = place(object)
        const end = text.indexOf(object) + object.length
        try {
          // The oracle: the line under the object made by hand (as the gap makes it), the command there.
          const made = text.slice(0, end) + '\n\n' + text.slice(end)
          await mountAt(made, end + 2, 'plain')
          await act(h)
          const oracle = await doc()
          const expected = oracle === made ? text : oracle
          if (WRITES_ON_AN_EMPTY_LINE.test(commandName)) assert.notEqual(expected, text, 'the oracle: the command writes on an empty line')
          await mountAt(text, end, 'plain')
          await act(h)
          const { after, objects, restored } = await editAndUndo(text)
          assert.equal(after, expected, 'the command acts on the line under the object, as on a real line there')
          assert.equal(after.slice(0, end), text.slice(0, end), 'the object and everything before it are unchanged')
          const start = text.indexOf(object)
          assert.ok(objects.some((b) => b.kind === kind && b.from >= start && b.from < end), 'the object still reads as itself')
          if (after !== text) assert.equal(restored, text, 'one Undo restores the talk exactly')
          assert.deepEqual(h.errors.filter((message) => !/SVGLength': Could not resolve relative length/.test(message)), [])
        } catch (error) {
          failures.push(`plain · line command: ${objectName} · ${placeName} · ${commandName}\n    ${String(error.message).split('\n').join('\n    ')}`)
        }
      }
      // A new slide (a slide command, not a line command): its title on a line of its own after the object.
      ran += 1
      h.errors.length = 0
      const text = place(object)
      const end = text.indexOf(object) + object.length
      try {
        await mountAt(text, end, 'plain')
        await h.page.evaluate(() => window.entry.actionBar('new-slide'))
        const { after, restored } = await editAndUndo(text, { inspect: false })
        assert.equal(after.slice(0, end), text.slice(0, end), 'the object and everything before it are unchanged')
        assert.match(after.slice(end), /^\n+## \n/, 'the new title is on its own line after the object')
        assert.equal(restored, text, 'one Undo restores the talk exactly')
      } catch (error) {
        failures.push(`plain · new slide: ${objectName} · ${placeName}\n    ${String(error.message).split('\n').join('\n    ')}`)
      }
    }
  }
  // With the object selected (the caret at its start), a line command has nothing to act on: the talk
  // is unchanged. (Bold is not a line command.)
  for (const [objectName, kind, object] of fixtures) {
    for (const [commandName, act] of LINE_COMMANDS.filter(([name]) => !/^bold/.test(name))) {
      ran += 1
      h.errors.length = 0
      const text = PLACES[0][1](object)
      const start = text.indexOf(object)
      try {
        const found = await h.page.evaluate((t) => window.entry.objects(t), text)
        await mountAt(text, found.find((b) => b.kind === kind && b.from >= start).from, 'plain')
        await act(h)
        const after = await doc()
        assert.equal(after, text, 'nothing changes')
        assert.deepEqual(h.errors.filter((message) => !/SVGLength': Could not resolve relative length/.test(message)), [])
      } catch (error) {
        failures.push(`plain · line command, object selected: ${objectName} · ${commandName}\n    ${String(error.message).split('\n').join('\n    ')}`)
      }
    }
  }
  // The Markdown view: the ways in that go through the page's own input (the rest are the same code).
  for (const object of fixtures) {
    for (const place of PLACES) {
      for (const entry of ENTRY_POINTS.filter(([name]) => /^(typing|input method|paste event|Paste command)/.test(name))) {
        await tryEntry('markdown', object, place, entry)
      }
    }
  }
} finally {
  await h.close()
}

if (failures.length) {
  console.error(`test:object-gap-entry-points:dom — ${failures.length} of ${ran} cases failed:\n  ${failures.join('\n  ')}`)
  process.exit(1)
}
console.log(`test:object-gap-entry-points:dom — ${ran} cases passed (${fixtures.length} kinds × ${PLACES.length} places × the ways in, both views)`)
