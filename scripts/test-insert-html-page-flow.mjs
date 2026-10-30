// Insert › HTML page… — the renderer step (src/renderer/src/lib/insertHtmlPage.ts). Seam: the inserter
// with scripted main answers. What is under test is when the editor may be written: never after
// Cancel or a refusal, never into a talk opened while the picker or the copy was running, exactly
// one caret insert (one Undo step) when the talk is still the one the command ran in.
import assert from 'node:assert/strict'
import { createHtmlPageInserter, htmlPageEmbedLine, HTML_PAGE_INSERT_TEXT } from '../src/renderer/src/lib/insertHtmlPage.ts'

let passed = 0
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ok  ${name}`) } catch (err) { console.error(`  FAIL ${name}`); throw err }
}

const A = '/v/talks/a/a-outline.md'
const B = '/v/talks/b/b-outline.md'
const copied = { ok: true, embedPath: 'assets/map.html', how: 'copied', localReferences: [] }

/** An inserter whose main answers and open talk the test scripts. */
function rig({ talk = A, choose = async () => ({ ok: true, token: 't1', fileName: 'map.html' }), importPage = async () => copied, editor = true } = {}) {
  const log = { chose: [], imported: [], inserted: [], notes: [] }
  const state = { talk }
  const run = createHtmlPageInserter({
    currentTalk: () => state.talk,
    choose: async (outline) => { log.chose.push(outline); return choose(state) },
    importPage: async (token, outline) => { log.imported.push([token, outline]); return importPage(state) },
    insert: (text) => { if (!editor) return false; log.inserted.push(text); return true },
    notify: (message, kind) => log.notes.push([kind, message])
  })
  return { run, log, state }
}

console.log('Insert HTML page (renderer step)')

await test('success: one caret insert of the Embed line, for the talk the command ran in', async () => {
  const { run, log } = rig()
  assert.equal(await run(), 'inserted')
  assert.deepEqual(log.chose, [A])
  assert.deepEqual(log.imported, [['t1', A]])
  assert.deepEqual(log.inserted, ['[Embed: assets/map.html]'])
  assert.deepEqual(log.notes, [['success', `${HTML_PAGE_INSERT_TEXT.inserted('assets/map.html', 'copied')} ${HTML_PAGE_INSERT_TEXT.onlyThisFile}`]])
  assert.equal(htmlPageEmbedLine('sims/demo.html'), '[Embed: sims/demo.html]')
})

await test('Cancel: nothing imported, nothing inserted, nothing said', async () => {
  const { run, log } = rig({ choose: async () => null })
  assert.equal(await run(), 'cancelled')
  assert.deepEqual([log.imported, log.inserted, log.notes], [[], [], []])
})

await test('a refusal from the picker or the copy is said and nothing is inserted', async () => {
  const refused = rig({ choose: async () => ({ ok: false, reason: 'not-html', message: 'Choose an HTML page (.html or .htm).' }) })
  assert.equal(await refused.run(), 'refused')
  assert.deepEqual(refused.log.imported, [])
  assert.deepEqual(refused.log.notes, [['error', 'Choose an HTML page (.html or .htm).']])
  const failed = rig({ importPage: async () => ({ ok: false, reason: 'outside-vault', message: 'outside' }) })
  assert.equal(await failed.run(), 'refused')
  assert.deepEqual(failed.log.inserted, [])
})

await test('another talk opened while the picker was open: no copy and no insert', async () => {
  const { run, log } = rig({ choose: async (state) => { state.talk = B; return { ok: true, token: 't1', fileName: 'map.html' } } })
  assert.equal(await run(), 'talk-changed')
  assert.deepEqual([log.imported, log.inserted], [[], []])
  assert.deepEqual(log.notes, [['warning', HTML_PAGE_INSERT_TEXT.talkChangedBeforeCopy]])
})

await test('another talk opened while the copy ran: no insert, and the message says where the copy is', async () => {
  const { run, log } = rig({ importPage: async (state) => { state.talk = B; return copied } })
  assert.equal(await run(), 'talk-changed')
  assert.deepEqual(log.inserted, [])
  assert.deepEqual(log.notes, [['warning', HTML_PAGE_INSERT_TEXT.talkChangedAfterCopy('assets/map.html')]])
  const closed = rig({ importPage: async (state) => { state.talk = null; return copied } })
  assert.equal(await closed.run(), 'talk-changed', 'a talk closed meanwhile is a change too')
})

await test('no talk open: the picker never opens', async () => {
  const { run, log } = rig({ talk: null })
  assert.equal(await run(), 'no-talk')
  assert.deepEqual(log.chose, [])
  assert.deepEqual(log.notes, [['info', HTML_PAGE_INSERT_TEXT.noTalk]])
  const noEditor = rig({ editor: false })
  assert.equal(await noEditor.run(), 'talk-changed', 'no editor to write into: nothing inserted, and it says so')
})

await test('a second run while one is waiting on the picker is ignored', async () => {
  let release = null
  const { run, log } = rig({ choose: () => (release === null ? new Promise((resolve) => { release = () => resolve(null) }) : Promise.resolve(null)) })
  const first = run()
  assert.equal(await run(), 'busy')
  release()
  assert.equal(await first, 'cancelled')
  assert.equal(log.chose.length, 1, 'the second run never reached the picker')
  assert.equal((await run()), 'cancelled', 'free again once the first has finished')
})

await test('local files named in its tags: inserted, the same note, and the names', async () => {
  const { run, log } = rig({ importPage: async () => ({ ...copied, localReferences: ['style.css', 'app.js'] }) })
  assert.equal(await run(), 'inserted')
  assert.deepEqual(log.notes, [['warning', `${HTML_PAGE_INSERT_TEXT.inserted('assets/map.html', 'copied')} ${HTML_PAGE_INSERT_TEXT.onlyThisFile} ${HTML_PAGE_INSERT_TEXT.namedFiles(['style.css', 'app.js'])}`]])
})

// Review 2026-10-27, F3: valid CSS that loads files beside the page (confirmed by Chromium in the review)
// went through the real importer with no names and got a bare success. Every insert, reused and in-talk
// included, now says that only the HTML file is used, whether or not any names were found.
await test('every insert says only the HTML file is used, names found or not', async () => {
  for (const how of ['copied', 'reused', 'in-talk']) {
    const { run, log } = rig({ importPage: async () => ({ ...copied, how }) })
    assert.equal(await run(), 'inserted')
    assert.equal(log.notes.length, 1)
    assert.ok(log.notes[0][1].includes(HTML_PAGE_INSERT_TEXT.onlyThisFile), `${how}: ${log.notes[0][1]}`)
  }
  assert.match(HTML_PAGE_INSERT_TEXT.onlyThisFile, /not copied and will not show/)
  assert.ok(!/self-contained|everything it needs|complete/i.test(HTML_PAGE_INSERT_TEXT.onlyThisFile + Object.values(HTML_PAGE_INSERT_TEXT).filter((v) => typeof v === 'string').join(' ')), 'no message claims the page is complete')
})

await test('the reviewer’s valid CSS forms, through the real importer: the note is there', async () => {
  const { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { importHtmlPage } = await import('../src/main/html-page-import.ts')
  const { runImportHere } = await import('./lib/html-page-import-here.mjs')
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tw-html-flow-')))
  try {
    for (const [i, html] of ['<style>@import/**/"theme.css";</style>', '<style>body{background:u\\72l(pic.png)}</style>'].entries()) {
      const talk = join(dir, `v${i}`, 'talk')
      mkdirSync(talk, { recursive: true })
      const outline = join(talk, 'talk-outline.md')
      writeFileSync(outline, '# Talk\n')
      writeFileSync(join(dir, `page-${i}.html`), html)
      const result = await importHtmlPage({ root: join(dir, `v${i}`), outlinePath: outline }, join(dir, `page-${i}.html`), async (job) => runImportHere(job))
      assert.equal(result.ok, true, JSON.stringify(result))
      const { run, log } = rig({ talk: outline, importPage: async () => result })
      assert.equal(await run(), 'inserted')
      assert.ok(log.notes[0][1].includes(HTML_PAGE_INSERT_TEXT.onlyThisFile), `${html}: ${JSON.stringify(log.notes)}`)
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

await test('a bridge that throws is said, and the next run is not blocked', async () => {
  let calls = 0
  const { run, log } = rig({ choose: async () => { calls++; if (calls === 1) throw new Error('ipc'); return null } })
  assert.equal(await run(), 'refused')
  assert.equal(log.notes[0][0], 'error')
  assert.equal(await run(), 'cancelled')
})

console.log(`insert html page flow: ${passed} passed`)
