// 0.45, second Mac: the Kept edits sheet, the Start new edits dialog and the notice line, rendered with the app's
// own styles at 1000 px wide (Playwright's bundled Chromium). The sheet lists each kind of kept copy with when,
// which Mac and which TalkWeaver saved it; Open and Restore are offered only where they can work; the dialog
// says where the old edits go and how to get them back; nothing overlaps. Screenshots go to
// artefacts/kept-edits/ (ignored).
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const root = resolve(import.meta.dirname, '..'), scratch = mkdtempSync(join(tmpdir(), 'tw-kept-edits-'))
const shots = join(root, 'artefacts', 'kept-edits'); mkdirSync(shots, { recursive: true })
let browser, checks = 0
const test = async (name, fn) => { await fn(); checks++; console.log('PASS ' + name) }
const LIST = [
  { id: 'run-1.edits.changed-2026-11-15T09-12-00-000Z.json', file: 'run-1.edits.changed-2026-11-15T09-12-00-000Z.json', reason: 'changed', at: '2026-11-15T09:11:40.000Z', by: { mac: 'Dominik’s MacBook Pro', app: '0.45.0', at: '2026-11-15T09:11:40.000Z' }, version: 5, state: 'ok', summary: '4 cuts, 1 slide left out' },
  { id: 'run-1.edits.kept-2026-11-14T17-02-00-000Z.json', file: 'run-1.edits.kept-2026-11-14T17-02-00-000Z.json', reason: 'set-aside', at: '2026-11-14T16:58:00.000Z', by: { mac: 'Dominik’s MacBook Air with a rather long computer name', app: '0.45.0', at: '2026-11-14T16:58:00.000Z' }, version: 5, state: 'ok', summary: '12 cuts, 3 slide starts moved, 2 slides with their own face position' },
  { id: 'run-1.edits.kept-2026-11-14T17-02-00-000Z.json#1', file: 'run-1.edits.kept-2026-11-14T17-02-00-000Z.json', reason: 'git-side', side: 1, at: '2026-11-14T15:00:00.000Z', by: null, version: 5, state: 'ok', summary: '2 cuts' },
  { id: 'run-1.edits.version-4.json', file: 'run-1.edits.version-4.json', reason: 'older-format', at: '2026-11-12T10:00:00.000Z', by: null, version: 4, state: 'ok', summary: '1 cut' },
  { id: 'run-1.edits (Dominik’s conflicted copy).json', file: 'x', reason: 'sync-copy', service: 'Dropbox', at: '2026-11-11T10:00:00.000Z', by: { mac: 'Studio', app: '0.46.0', at: '2026-11-11T10:00:00.000Z' }, version: 6, state: 'newer', summary: null },
  { id: 'run-1.edits.kept-2026-11-10T10-00-00-000Z.json', file: 'run-1.edits.kept-2026-11-10T10-00-00-000Z.json', reason: 'set-aside', at: '2026-11-10T10:00:00.000Z', by: null, version: null, state: 'unreadable', summary: null },
  // 0.45 final: every save keeps the version before it (identical ones as one row); a save that did not finish; details read when opened.
  { id: 'run-1.edits.before-2026-11-09T10-00-00-000Z-a.json', file: 'run-1.edits.before-2026-11-09T10-00-00-000Z-a.json', reason: 'before-save', at: '2026-11-09T10:00:00.000Z', by: { mac: 'Dominik’s MacBook Air', app: '0.45.0', at: '2026-11-09T10:00:00.000Z' }, version: 5, state: 'ok', summary: '2 cuts', same: ['run-1.edits.before-2026-11-09T09-00-00-000Z-b.json', 'run-1.edits.before-2026-11-09T08-00-00-000Z-c.json'] },
  { id: 'run-1.edits.unfinished-2026-11-08T10-00-00-000Z-d.json', file: 'run-1.edits.unfinished-2026-11-08T10-00-00-000Z-d.json', reason: 'unfinished', at: '2026-11-08T10:00:00.000Z', by: { mac: 'Dominik’s MacBook Air', app: '0.45.0', at: '2026-11-08T10:00:00.000Z' }, version: 5, state: 'ok', summary: '3 cuts' },
  { id: 'run-1.edits 2.json', file: 'run-1.edits 2.json', reason: 'sync-copy', service: 'iCloud Drive', at: '2026-11-07T10:00:00.000Z', by: null, version: null, state: 'unknown', summary: null },
  // R1a: this Mac's previous save, from its app data (not a file in the vault).
  { id: 'this-mac:previous-save', file: '', reason: 'previous-save', local: true, at: '2026-11-15T09:20:00.000Z', by: { mac: 'Dominik’s MacBook Air', app: '0.45.0', at: '2026-11-15T09:20:00.000Z' }, version: 5, state: 'ok', summary: '5 cuts' },
]
try {
  await build({
    stdin: {
      contents: `import React from 'react'; import { createRoot } from 'react-dom/client'
import { KeptEditsSheet, StartNewEditsSheet, EditsNoticeNote } from './src/renderer/src/components/recording/KeptEdits.tsx'
import './src/renderer/src/styles.css'
import './src/renderer/src/ui-kit.css'
import './src/renderer/src/components/recording/recording-editor.css'
window.calls = []
window.tw = { recordingVideo: {
  keptList: async () => ({ ok: true, kept: ${JSON.stringify(LIST)} }),
  keptOpen: async (ref, id) => { window.calls.push(['open', id]); return { ok: true, kept: ${JSON.stringify(LIST)}.find((k) => k.id === id), edits: { cuts: [] } } },
  keptRestore: async (ref, id) => { window.calls.push(['restore', id]); return { ok: true, edits: { edits: { revision: 9 }, problem: null, notice: { kind: 'restored', copy: 'x', from: 'today, 09:11' } } } },
} }
function App() {
  const [sheet, setSheet] = React.useState(null)
  window.show = setSheet
  const runRef = React.useMemo(() => ({ talkSlug: 't', runId: 'run-1' }), [])
  return <div className="tre lt" style={{ height: '100vh' }}>
    <div className="tre-list" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <button id="opener">Kept edits</button>
      <EditsNoticeNote notice={{ kind: 'changed', copy: 'c', by: { mac: 'Dominik’s MacBook Pro', app: '0.45.0', at: new Date().toISOString() } }} onKept={() => setSheet('kept')} onDismiss={() => window.calls.push(['dismiss'])} />
      <EditsNoticeNote notice={{ kind: 'replaced', copy: 'c', mine: { mac: 'Air', app: '0.45.0', at: new Date().toISOString() }, by: { mac: 'Dominik’s MacBook Pro', app: '0.45.0', at: new Date().toISOString() }, gone: false }} onKept={() => setSheet('kept')} onDismiss={() => {}} />
      <EditsNoticeNote notice={{ kind: 'replaced', copy: 'c', mine: null, by: null, gone: false, older: true }} onKept={() => setSheet('kept')} onDismiss={() => {}} />
      <EditsNoticeNote notice={{ kind: 'interrupted', copy: 'u', restored: true }} onKept={() => setSheet('kept')} onDismiss={() => {}} />
    </div>
    {sheet === 'kept' ? <KeptEditsSheet runRef={runRef} onOpen={(k) => { window.calls.push(['opened', k.id]); setSheet(null) }} onRestored={(s) => { window.calls.push(['restored', s.edits.revision]); setSheet(null) }} onClose={() => { window.calls.push(['close']); setSheet(null) }} /> : null}
    {sheet === 'start' || sheet === 'start-git' ? <StartNewEditsSheet where="editor" gitConflict={sheet === 'start-git'} onStart={() => { window.calls.push(['start']); setSheet(null) }} onClose={() => { window.calls.push(['close']); setSheet(null) }} /> : null}
  </div>
}
createRoot(document.getElementById('root')).render(<App />)`,
      resolveDir: root, loader: 'tsx', sourcefile: 'kept-edits-dom.tsx'
    },
    bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', outfile: join(scratch, 'test.js'), logLevel: 'error', loader: { '.woff2': 'empty', '.woff': 'empty', '.ttf': 'empty' }
  })
  writeFileSync(join(scratch, 'test.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="test.css"><div id="root"></div><script src="test.js"></script>')
  browser = await chromium.launch({ headless: true, executablePath: process.env.TW_CHROMIUM_HEADLESS_SHELL || undefined })
  const page = await browser.newPage({ viewport: { width: 1000, height: 760 } })
  page.setDefaultTimeout(6000)
  const errors = []; page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(pathToFileURL(join(scratch, 'test.html')).href)
  /** Boxes of the visible elements matching `sel` inside `scope` that overlap each other or leave the window. */
  const overlaps = (sel) => page.evaluate((sel) => {
    const els = [...document.querySelectorAll(sel)].filter((e) => e.offsetParent !== null || e.closest('dialog[open]'))
    // What shows of an element inside a scrolling list: its box cut to the list's own (rows scrolled away do not count).
    const visible = (e) => {
      const r = e.getBoundingClientRect(), list = e.closest('.tre-sheet-body')
      if (!list) return r
      const l = list.getBoundingClientRect()
      const top = Math.max(r.top, l.top), bottom = Math.min(r.bottom, l.bottom)
      return { left: r.left, right: r.right, top, bottom, width: bottom > top ? r.width : 0 }
    }
    const boxes = els.map((e) => ({ e, r: visible(e) })).filter((b) => b.r.width > 0)
    const bad = []
    for (const b of boxes) if (b.r.left < 0 || b.r.right > innerWidth + 0.5) bad.push(`${b.e.className || b.e.tagName} leaves the window`)
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i].r, c = boxes[j].r
      if (boxes[i].e.contains(boxes[j].e) || boxes[j].e.contains(boxes[i].e)) continue
      if (a.left < c.right - 0.5 && c.left < a.right - 0.5 && a.top < c.bottom - 0.5 && c.top < a.bottom - 0.5) bad.push(`${boxes[i].e.className || boxes[i].e.textContent} overlaps ${boxes[j].e.className || boxes[j].e.textContent}`)
    }
    return bad
  }, sel)

  await test('the notice lines name the other Mac and its version, and offer Kept edits; nothing overlaps at 1000 px', async () => {
    const texts = await page.locator('[data-edits-notice]').allInnerTexts()
    assert.match(texts[0], /These edits were also changed elsewhere while you had them open \(Edited on Dominik’s MacBook Pro with TalkWeaver 0\.45\.0, today, \d\d:\d\d\)\. Your edits are saved, and that version is kept as a copy\./)
    assert.match(texts[1], /The edits you saved on this Mac \(today, \d\d:\d\d\) were replaced by a version edited on Dominik’s MacBook Pro with TalkWeaver 0\.45\.0\. Yours are kept as a copy\./)
    assert.match(texts[2], /were replaced by a version saved by an earlier version of TalkWeaver, which does not record which Mac it was on\. Yours are kept as a copy\./)
    assert.match(texts[3], /A save of these edits did not finish\. What it was saving is kept as a copy: open Kept edits to see it or restore it\. The edits as they were before that save are back\./)
    assert.deepEqual(await overlaps('[data-edits-notice] > *'), [])
    await page.screenshot({ path: join(shots, 'notices-1000.png') })
  })

  await test('Kept edits lists every kind of copy with when, which Mac and which TalkWeaver; Open and Restore only where they work', async () => {
    await page.locator('[data-edits-notice] button', { hasText: 'Kept edits…' }).first().click()
    const dialog = page.getByRole('dialog', { name: 'Kept edits' })
    await dialog.waitFor()
    assert.equal(await dialog.evaluate((d) => d.matches(':modal')), true)
    await page.locator('[data-kept-id]').first().waitFor()
    const rows = await page.locator('[data-kept-id]').count()
    assert.equal(rows, LIST.length)
    const row = (id) => page.locator(`[data-kept-id="${id}"]`)
    assert.match(await row(LIST[0].id).innerText(), /(today|\d{1,2} Nov), \d\d:\d\d · Dominik’s MacBook Pro · TalkWeaver 0\.45\.0[\s\S]*The edits this Mac last had, kept when something else replaced them[\s\S]*4 cuts, 1 slide left out/)
    assert.match(await row(LIST[6].id).innerText(), /The edits in place before a save replaced them, kept as a copy[\s\S]*2 cuts[\s\S]*Identical to 2 other kept copies/)
    assert.match(await row(LIST[7].id).innerText(), /From a save that did not finish[\s\S]*3 cuts/)
    assert.match(await row(LIST[8].id).innerText(), /A copy made by iCloud Drive[\s\S]*Details are read when it is opened\./)
    assert.match(await row(LIST[2].id).innerText(), /Mac not recorded · an earlier TalkWeaver[\s\S]*One of two versions in a Git conflict \(version 1 of 2\)/)
    assert.match(await row(LIST[3].id).innerText(), /What an older TalkWeaver saved \(format 4\)/)
    assert.match(await row(LIST[4].id).innerText(), /A copy made by Dropbox[\s\S]*Made by a newer version of TalkWeaver \(Edited on Studio with TalkWeaver 0\.46\.0\)\. Open it there\./)
    assert.match(await row(LIST[5].id).innerText(), /This copy could not be read\./)
    assert.match(await row(LIST[9].id).innerText(), /Dominik’s MacBook Air · TalkWeaver 0\.45\.0[\s\S]*Previous save on this Mac \(kept on this Mac only, not beside the recording\)[\s\S]*5 cuts/)
    for (const [k, open, restore] of [[0, 1, 1], [3, 1, 1], [4, 0, 0], [5, 0, 0], [6, 1, 1], [7, 1, 1], [8, 1, 1], [9, 1, 1]]) {
      assert.equal(await row(LIST[k].id).getByRole('button', { name: 'Open' }).count(), open, `${LIST[k].reason} Open`)
      assert.equal(await row(LIST[k].id).getByRole('button', { name: 'Restore' }).count(), restore, `${LIST[k].reason} Restore`)
    }
    assert.deepEqual(await overlaps('dialog[open] .tre-kept-text, dialog[open] .tre-kept-acts button, dialog[open] header, dialog[open] footer > *'), [])
    const box = await dialog.boundingBox()
    assert.ok(box.x >= 0 && box.x + box.width <= 1000, 'the sheet fits the window')
    await page.screenshot({ path: join(shots, 'kept-edits-sheet-1000.png') })
    await row(LIST[0].id).getByRole('button', { name: 'Open' }).click()
    await dialog.waitFor({ state: 'detached' })
    assert.deepEqual(await page.evaluate(() => window.calls.slice(-2)), [['open', LIST[0].id], ['opened', LIST[0].id]])
    await page.evaluate(() => window.show('kept'))
    await page.locator(`[data-kept-id="${LIST[1].id}"]`).getByRole('button', { name: 'Restore' }).click()
    await dialog.waitFor({ state: 'detached' })
    assert.deepEqual(await page.evaluate(() => window.calls.slice(-2)), [['restore', LIST[1].id], ['restored', 9]])
  })

  await test('Start new edits asks first and says where the old edits go and how to get them back', async () => {
    await page.evaluate(() => window.show('start-git'))
    const dialog = page.getByRole('dialog', { name: 'Start new edits?' })
    await dialog.waitFor()
    const text = await dialog.innerText()
    assert.match(text, /The saved edits are not deleted: they are kept as a copy beside the recording\. To see them again or restore them, choose Kept edits \(the clock button at the top of this editor\)\./)
    assert.match(text, /Kept edits lists each of them, and either can be restored\./)
    assert.deepEqual(await overlaps('dialog[open] header, dialog[open] .tre-sheet-body, dialog[open] footer button'), [])
    await page.screenshot({ path: join(shots, 'start-new-edits-1000.png') })
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'detached' })
    assert.deepEqual(await page.evaluate(() => window.calls.at(-1)), ['close'], 'Escape cancels')
    await page.evaluate(() => window.show('start'))
    await dialog.getByRole('button', { name: 'Start new edits' }).click()
    assert.deepEqual(await page.evaluate(() => window.calls.at(-1)), ['start'])
  })

  assert.deepEqual(errors, [])
  console.log(`\n${checks} passed; screenshots in ${shots}`)
} finally {
  await browser?.close().catch(() => {})
  rmSync(scratch, { recursive: true, force: true })
}
