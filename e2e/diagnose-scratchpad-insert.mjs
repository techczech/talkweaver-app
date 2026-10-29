// Slide Scratchpad ticket 2 in the real built app: hidden Electron (TW_E2E), a synthetic vault with a target talk,
// a source talk and a Slide Scratchpad holding one picked slide. Insert whole slide after a chosen place, then one
// Undo in the editor. After each step: the editor text, the Slide outline list, the saved file, the status bar's
// slide count and the editor's slide labels agree; the card says where the slide went, and after the Undo that it
// is no longer in the talk. Change place closes when a place is picked.
import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'

const repo = resolve('.')
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'tw-scratchpad-insert-')))
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }))
const userData = join(scratch, 'userData')
const vault = join(scratch, 'vault')
const talkDir = join(vault, 'target')
const sourceDir = join(vault, 'source')
for (const dir of [userData, join(talkDir, 'scratchpad'), sourceDir]) mkdirSync(dir, { recursive: true })
const outline = join(talkDir, 'target-outline.md')
const front = (title) => `---\noutline_version: 2\ntitle: ${title}\nauto_title_slide: false\nauto_thanks_slide: false\n---\n\n`
const original = `${front('Target talk')}### Opening\n{id=open1}\n\nOpening body.\n\n### Middle\n{id=mid01}\n\nMiddle body.\n\n### Closing\n{id=close}\n\nClosing body.\n`
writeFileSync(outline, original)
const picked = '### What is an agent?\n{id=agent}\n\nAn agent is a model in a loop.\n'
writeFileSync(join(sourceDir, 'source-outline.md'), `${front('Source talk')}${picked}`)
const at = new Date().toISOString()
writeFileSync(join(talkDir, 'scratchpad', 'chart.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#0b3a6b"/></svg>')
// Two agent pages that try to send their own frame away: one to another twpresent:// page (refused by the scratch
// frame rule, navigation-guard frameRule), one to a vault file through twfile:// (Chromium raises no
// will-frame-navigate for it, and the sandboxed frame never shows the file).
const vaultNote = join(talkDir, 'private-notes.txt')
writeFileSync(vaultNote, 'secret vault words')
const probe = (to) => `<!doctype html><p>probe page words</p><script>setTimeout(function () { location.href = ${JSON.stringify(to)} }, 50)</script>`
writeFileSync(join(talkDir, 'scratchpad', 'probe-deck.html'), probe('twpresent://target/target-present.html'))
writeFileSync(join(talkDir, 'scratchpad', 'probe-file.html'), probe(`twfile://f/${Buffer.from(vaultNote, 'utf8').toString('base64url')}`))
writeFileSync(join(talkDir, 'scratchpad', 'scratchpad-state.json'), JSON.stringify({
  version: 1, groups: [],
  items: [{ id: 'sp-agent', kind: 'slide', addedAt: at, batch: { source: 'slide-browser', at }, group: null, status: 'active',
    slide: { talkPath: 'source/source-outline.md', talkTitle: 'Source talk', slideId: 'agent', title: 'What is an agent?', markdown: picked, thumbKey: 'k-agent' } },
  { id: 'sp-chart', kind: 'file', file: 'chart.svg', addedAt: at, batch: { source: 'agent', at }, group: null, status: 'active' }]
}, null, 2))
const mode = process.env.TW_TEST_EDITOR_MODE ?? 'plain'
writeFileSync(join(userData, 'config.json'), JSON.stringify({ vaultRoot: vault, editorViewMode: mode }))

const env = { ...process.env, TW_E2E: '1', TW_REC_TEST: '1' }
delete env.ELECTRON_RUN_AS_NODE
let app
try {
  await ensureFreshBuild(repo)
  app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`, '--use-mock-keychain'], cwd: repo, env })
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every((w) => !w.isVisible())), true, 'windows stay hidden')
  const page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  const saved = () => readFileSync(outline, 'utf8')
  const waitSaved = async (pred, what) => {
    for (let i = 0; i < 80 && !pred(saved()); i++) await page.waitForTimeout(100)
    assert.ok(pred(saved()), what)
  }
  // The Slide outline list (sidebar): each row carries its number in .so-slide-no.
  // Plain view's margin: the slide labels in order ("Slide 1", "Slide 2", …); empty in the Markdown view.
  const marginSlides = () => page.evaluate(() => [...document.querySelectorAll('.cm-plain-margin-slide .cm-plain-margin-word')].map((w) => w.textContent.trim().toLowerCase()))
  const settledMargin = async (n, what) => {
    if (mode !== 'plain') return
    const want = Array.from({ length: n }, (_, k) => `slide ${k + 1}`)
    await page.waitForFunction((w) => JSON.stringify([...document.querySelectorAll('.cm-plain-margin-slide .cm-plain-margin-word')].map((x) => x.textContent.trim().toLowerCase())) === JSON.stringify(w), want, { timeout: 15000 })
      .catch(async () => { throw new Error(`${what}: the margin labels read ${JSON.stringify(await marginSlides())}`) })
  }
  const outlineList = () => page.evaluate(() => [...document.querySelectorAll('.so-slide-no')].map((n) => n.parentElement.textContent.replace(/\s+/g, ' ').trim()))
  // The status bar settles: no in-flight ellipsis, then the count.
  const settledCount = async (n, what) => {
    await page.waitForFunction((want) => [...document.querySelectorAll('*')].some((el) => el.childElementCount === 0 && el.textContent.trim() === `${want} slides`), n, { timeout: 15000 })
      .catch(async () => { throw new Error(`${what}: the status bar never settled at ${n} slides`) })
  }

  await page.locator('[data-talk-slug="target"]').first().dblclick()
  await page.locator('.cm-content').waitFor()
  await settledCount(3, 'after opening')
  await page.getByRole('tab', { name: 'Slide outline', exact: true }).click()
  await page.locator('.so-slide-no').first().waitFor()

  await page.locator('.toolbar-btn', { hasText: 'Insert' }).first().click()
  await page.getByRole('menuitem', { name: /Slide Scratchpad/ }).click()
  await page.locator('.sp-card', { hasText: 'What is an agent?' }).click()

  // Change place: pick "Opening"; the list closes on the pick.
  await page.getByRole('button', { name: 'Change place' }).click()
  const chooser = page.getByRole('dialog', { name: 'Change place' })
  await chooser.waitFor()
  await chooser.getByRole('button', { name: /Opening/ }).click()
  await chooser.waitFor({ state: 'detached', timeout: 3000 }).catch(() => { throw new Error('Change place stayed open after a pick') })
  assert.match(await page.locator('.sp-place-where').innerText(), /Inserts after slide 1 · ‘Opening’/)

  // Insert whole slide: in the editor, the outline list, the saved file, the count.
  await page.getByRole('button', { name: 'Insert whole slide' }).click()
  await page.waitForFunction(() => document.querySelector('.cm-content')?.textContent.includes('What is an agent?'))
  await waitSaved((t) => t.includes('### What is an agent?'), 'the inserted slide is saved')
  const afterInsert = saved()
  assert.ok(afterInsert.indexOf('### Opening') < afterInsert.indexOf('### What is an agent?') && afterInsert.indexOf('### What is an agent?') < afterInsert.indexOf('### Middle'), 'after Opening, before Middle')
  assert.equal(afterInsert.match(/### What is an agent\?/g).length, 1, 'once')
  await page.waitForFunction(() => [...document.querySelectorAll('.so-slide-no')].some((n) => n.parentElement.textContent.includes('What is an agent?')))
  await settledCount(4, 'after the insert')
  await settledMargin(4, 'after the insert')
  assert.deepEqual(await outlineList(), ['01Opening', '02What is an agent?', '03Middle', '04Closing'])
  await page.locator('.sp-card', { hasText: 'What is an agent?' }).locator('.sp-inserted').waitFor()
  assert.equal(await page.locator('.sp-card', { hasText: 'What is an agent?' }).locator('.sp-inserted').innerText(), 'Inserted · ‘What is an agent?’')
  const marked = JSON.parse(readFileSync(join(talkDir, 'scratchpad', 'scratchpad-state.json'), 'utf8')).items[0]
  assert.equal(marked.insertedInto, 'What is an agent?')

  // One Undo with the focus in the editor: exactly that insert goes, the file is saved, counts and labels follow.
  await page.locator('.cm-line').filter({ hasText: 'Closing body.' }).click()
  await page.keyboard.press('ControlOrMeta+z')
  await page.waitForFunction(() => !document.querySelector('.cm-content')?.textContent.includes('What is an agent?'))
  await waitSaved((t) => !t.includes('What is an agent?'), 'the undo is saved')
  assert.equal(saved(), original, 'one undo takes back exactly the insert')
  await page.waitForFunction(() => ![...document.querySelectorAll('.so-slide-no')].some((n) => n.parentElement.textContent.includes('What is an agent?')))
  await settledCount(3, 'after the undo')
  await settledMargin(3, 'after the undo')
  assert.deepEqual(await outlineList(), ['01Opening', '02Middle', '03Closing'])
  await page.locator('.sp-card', { hasText: 'What is an agent?' }).locator('.sp-inserted').waitFor()
  assert.equal(await page.locator('.sp-card', { hasText: 'What is an agent?' }).locator('.sp-inserted').innerText(), 'Inserted before · not in the talk now')

  // The chosen place had moved on to the added slide; with that slide undone, the earlier place is back.
  await page.waitForFunction(() => document.querySelector('.sp-place-where')?.textContent === 'Inserts after slide 1 · ‘Opening’')

  // Mixed selected candidates: reverse tick order, one transaction, exact Undo/Redo.
  await page.locator('.pane-btn[title="Grid"]').click()
  await page.locator('.grid-view').waitFor()
  await page.getByLabel('Select Chart', { exact: true }).check()
  await page.getByLabel('Select What is an agent?', { exact: true }).check()
  await page.getByRole('button', { name: 'Insert selection as slides', exact: true }).dblclick()
  await waitSaved(t => t.includes('### Chart') && t.includes('What is an agent?'), 'the whole batch is saved')
  const batchText = saved()
  assert.equal([...batchText.matchAll(/^#{2,6} What is an agent\?/gm)].length, 1, 'a double-click inserts the batch only once')
  assert.equal([...batchText.matchAll(/^#{2,6} Chart/gm)].length, 1)
  assert.ok(batchText.indexOf('What is an agent?') < batchText.indexOf('### Chart'), 'display order wins over tick order')
  await page.waitForFunction(() => document.querySelectorAll('.sp-card input:checked').length === 0)
  assert.equal(await page.locator('.sp-card input:checked').count(), 0)
  await page.waitForFunction(() => document.querySelectorAll('.grid-cell[data-selected="true"]').length === 2).catch(async error => { console.log('batch grid diagnostic', await page.locator('.grid-cell').evaluateAll(nodes => nodes.map(node=>({selected:node.getAttribute('data-selected'),active:node.getAttribute('data-active'),title:node.textContent.trim().slice(0,90)})))); throw error })
  const selected = await page.locator('.grid-cell[data-selected="true"]').allTextContents()
  assert.ok(selected.some(text => text.includes('What is an agent?')))
  assert.ok(selected.some(text => text.includes('Chart')))
  await page.locator('.grid-view').focus()
  await page.keyboard.press('ControlOrMeta+z')
  await waitSaved(t => t === original, 'one Undo restores the exact original after a batch')
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await waitSaved(t => t === batchText, 'one Redo restores the exact batch')
  await page.keyboard.press('ControlOrMeta+z')
  await waitSaved(t => t === original, 'the batch can be undone again')
  await page.waitForFunction(() => document.querySelector('.sp-place-where')?.textContent === 'Inserts after slide 1 · ‘Opening’')

  await page.locator('.pane-btn[title="Editor + slide strip"]').click()

  // An agent's SVG, visual only, at the chosen place: a new slide after Opening, copied into assets/, the card names
  // the slide by its title (a number would go stale), the agent's file untouched.
  const agentSvg = readFileSync(join(talkDir, 'scratchpad', 'chart.svg'))
  const picture = page.locator('.sp-card', { hasText: 'chart' }).locator('.sp-thumb img')
  const decoded = await picture.evaluate(async (img) => {
    await img.decode()
    return { width: img.naturalWidth, height: img.naturalHeight, checkedCopy: img.src.startsWith('data:image/svg+xml;base64,') }
  })
  assert.deepEqual(decoded, { width: 40, height: 20, checkedCopy: true }, 'the checked SVG snapshot actually renders in its card')
  await page.locator('.sp-card', { hasText: 'chart' }).click()
  await page.getByRole('button', { name: 'Insert visual only' }).click()
  await waitSaved((t) => t.includes('![](assets/chart.svg)'), 'the SVG slide is saved')
  assert.ok(saved().indexOf('### Chart') > saved().indexOf('### Opening') && saved().indexOf('### Chart') < saved().indexOf('### Middle'), saved())
  assert.ok(readFileSync(join(talkDir, 'assets', 'chart.svg')).equals(agentSvg), 'copied byte for byte')
  assert.ok(readFileSync(join(talkDir, 'scratchpad', 'chart.svg')).equals(agentSvg), 'the agent file is untouched')
  await settledCount(4, 'after the SVG insert')
  await settledMargin(4, 'after the SVG insert')
  await page.locator('.sp-card', { hasText: 'chart' }).locator('.sp-inserted').waitFor()
  assert.equal(await page.locator('.sp-card', { hasText: 'chart' }).locator('.sp-inserted').innerText(), 'Inserted · ‘Chart’')
  assert.equal(await page.locator('.sp-place-where').innerText(), 'Inserts after slide 2 · ‘Chart’', 'the place moved on to the new slide, numbered as the outline numbers it')

  // An agent page cannot leave its own preview address for another app page, and no frame shows a vault file.
  const frames = () => app.evaluate(async ({ webContents }) => {
    const out = []
    for (const wc of webContents.getAllWebContents()) {
      for (const f of wc.mainFrame.framesInSubtree) {
        let text = ''
        try { text = String(await f.executeJavaScript('document.body ? document.body.innerText : ""')) } catch { text = '' }
        out.push({ url: f.url, text })
      }
    }
    return out
  })
  const runPreview = async (title) => {
    await page.locator('.sp-card', { hasText: title }).click()
    await page.getByRole('button', { name: 'Open big preview' }).click()
    await page.getByRole('button', { name: 'Run interactive' }).click()
    await page.locator('iframe.sp-preview-frame').waitFor()
    await page.waitForTimeout(1500)
  }
  await runPreview('Probe deck')
  let seen = await frames()
  assert.ok(seen.some((f) => /^twpresent:\/\/preview\/scratch-[0-9a-f]{24}\.html$/.test(f.url) && f.text.includes('probe page words')), `the preview frame stays on its page: ${JSON.stringify(seen.map((f) => f.url))}`)
  assert.ok(!seen.some((f) => f.url.startsWith('twpresent://target')), 'it never reached the talk\'s deck')
  await page.getByRole('button', { name: '← Back to the list' }).click()
  await runPreview('Probe file')
  seen = await frames()
  assert.ok(!seen.some((f) => f.text.includes('secret vault words')), `no frame shows the vault file: ${JSON.stringify(seen.map((f) => f.url))}`)
  // The hidden thumbnail capture: the page that stayed was captured; nothing from the vault file was read.
  const thumbCache = join(userData, 'cache', 'scratchpad-html-thumbs')
  const texts = () => (existsSync(thumbCache) ? readdirSync(thumbCache).filter((f) => f.endsWith('.txt')).map((f) => readFileSync(join(thumbCache, f), 'utf8')) : [])
  for (let i = 0; i < 100 && !texts().some((t) => t.includes('probe page words')); i++) await page.waitForTimeout(100)
  assert.ok(texts().some((t) => t.includes('probe page words')), `the thumbnail captured the page itself: ${JSON.stringify(texts())}`)
  assert.ok(!texts().some((t) => t.includes('secret vault words')), 'no capture read the vault file')

  assert.deepEqual(errors, [])
  if (process.env.SHOTS) await page.screenshot({ path: join(resolve(process.env.SHOTS), 'talkweaver-scratchpad-insert-undo.png') })
  console.log(`PASS (${mode} view) Slide Scratchpad: Change place closes on a pick; Insert whole slide lands, saves, counts; one Undo removes exactly it, saves, counts, labels; mixed batch selects its new grid cards and has exact one-step Undo/Redo; the card and the place follow; an SVG visual goes in as a new slide; an agent page cannot leave its preview or show a vault file`)
} catch (error) {
  if (process.env.SHOTS && app) await (await app.firstWindow()).screenshot({ path: join(resolve(process.env.SHOTS), 'talkweaver-scratchpad-insert-failed.png') }).catch(() => {})
  throw error
} finally {
  await app?.close()
}
