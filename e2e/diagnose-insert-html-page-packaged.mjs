// PACKAGED variant of diagnose-insert-html-page.mjs: drives the signed TalkWeaver.app given as argv[2] (executablePath),
// so the copy runs in the packaged html-page-import-worker.js utility process. Scratch lives under argv[3].
// Insert › HTML page… in the real built app: hidden Electron, a synthetic vault, the OS file picker
// replaced by the TW_E2E answer main reads (globalThis.__twE2eHtmlPagePick; src/main/index.ts).
// Checks: the item is in the Insert menu; Cancel changes nothing; a page from outside the vault is
// copied byte for byte into the talk's assets folder and its Embed line lands at the caret without
// losing unsaved typing; one Undo takes back only the line; the slide compiles the page.
import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const appBundle = resolve(process.argv[2])
const tmpdir = () => resolve(process.argv[3])
const executable = join(appBundle, 'Contents/MacOS/TalkWeaver')
const scratchRoots = []
process.on('exit', () => { for (const dir of scratchRoots) rmSync(dir, { recursive: true, force: true }) })
for (const mode of process.env.TW_TEST_EDITOR_MODE ? [process.env.TW_TEST_EDITOR_MODE] : ['markdown', 'plain']) {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'tw-insert-html-page-')))
  scratchRoots.push(scratch)
  const userData = join(scratch, 'userData')
  const vault = join(scratch, 'vault')
  const talkDir = join(vault, 'html-page')
  const materials = join(scratch, 'materials')
  for (const dir of [userData, talkDir, materials]) mkdirSync(dir, { recursive: true })
  const outline = join(talkDir, 'html-page-outline.md')
  const source = '---\noutline_version: 2\ntitle: HTML page fixture\nauto_title_slide: false\nauto_thanks_slide: false\n---\n\n### First slide\n{id=first}\n\nFirst slide body.\n\n### Map slide\n{id=map}\n\nMap slide body.\n'
  writeFileSync(outline, source)
  const pageBytes = Buffer.from('<!doctype html><html><head><title>Energy domain map</title></head><body><h1>ENERGY-MAP-MARKER</h1><script>document.body.dataset.ran = "yes"</script></body></html>', 'utf8')
  const external = join(materials, 'energy-domain-map.html')
  writeFileSync(external, pageBytes)
  writeFileSync(join(userData, 'config.json'), JSON.stringify({ vaultRoot: vault, editorViewMode: mode }))

  const env = { ...process.env, TW_E2E: '1', TW_REC_TEST: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  let app
  try {
    app = await electron.launch({ executablePath: executable, args: [`--user-data-dir=${userData}`], env })
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every((w) => !w.isVisible())), true, 'windows stay hidden')
    const pid = app.process().pid
    console.log(`packaged ${executable} pid ${pid} version ${await app.evaluate(({ app: a }) => `${a.getVersion()} packaged=${a.isPackaged} electron=${process.versions.electron}`)}`)
    const page = await app.firstWindow()
    page.setDefaultTimeout(15000)
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    const editorText = () => page.evaluate(() => [...document.querySelectorAll('.cm-content .cm-line')].map((l) => l.textContent).join('\n'))
    const pick = (path) => app.evaluate((_electron, value) => { globalThis.__twE2eHtmlPagePick = value; globalThis.__twE2eHtmlPagePickOptions = undefined }, path)
    const pickerOptions = () => app.evaluate(() => globalThis.__twE2eHtmlPagePickOptions ?? null)
    const insertHtmlPage = async () => {
      await page.locator('.toolbar-btn', { hasText: 'Insert' }).first().click()
      await page.getByRole('menuitem', { name: /HTML page…/ }).click()
    }

    await page.locator('[data-talk-slug="html-page"]').first().dblclick()
    await page.locator('.cm-content').waitFor()
    // Unsaved typing at the caret: the insert must keep it.
    await page.locator('.cm-line').filter({ hasText: 'Map slide body.' }).click()
    await page.keyboard.press('End')
    await page.keyboard.type(' Typed before inserting.')
    await page.waitForTimeout(700) // its own Undo group

    // Cancel: nothing written, nothing inserted.
    await pick(null)
    const beforeCancel = await editorText()
    await insertHtmlPage()
    await page.waitForTimeout(300)
    const options = await pickerOptions()
    assert.deepEqual(options?.properties, ['openFile'], 'the picker opened for one file')
    assert.deepEqual(options?.filters, [{ name: 'HTML pages', extensions: ['html', 'htm'] }], 'HTML pages only')
    assert.equal(await editorText(), beforeCancel, 'Cancel leaves the text as it was')
    assert.equal(existsSync(join(talkDir, 'assets')), false, 'Cancel writes no file')

    // A page from outside the vault.
    await pick(external)
    await insertHtmlPage()
    await page.waitForFunction(() => document.querySelector('.cm-content')?.textContent.includes('[Embed: assets/energy-domain-map.html]'))
    const afterInsert = await editorText()
    assert.ok(afterInsert.includes('Map slide body. Typed before inserting.'), 'the unsaved typing is kept')
    assert.ok(afterInsert.indexOf('[Embed: assets/energy-domain-map.html]') > afterInsert.indexOf('Typed before inserting.'), 'the line lands at the caret, after the typing')
    assert.ok(readFileSync(join(talkDir, 'assets', 'energy-domain-map.html')).equals(pageBytes), 'copied byte for byte')
    assert.ok(readFileSync(external).equals(pageBytes), 'the original is untouched')
    // The editor's autosave writes the outline through a temporary `.tw-write` file and renames it; wait
    // for a save in flight to land before listing (the import itself runs in its own process now).
    for (let i = 0; i < 30 && readdirSync(talkDir).some((name) => name.endsWith('.tw-write')); i++) await page.waitForTimeout(100)
    assert.deepEqual(readdirSync(talkDir).sort(), ['assets', 'html-page-outline.md'], 'nothing else is written into the talk folder')
    // The ordinary save path writes the line to the outline.
    for (let i = 0; i < 50 && !readFileSync(outline, 'utf8').includes('[Embed: assets/energy-domain-map.html]'); i++) await page.waitForTimeout(100)
    assert.ok(readFileSync(outline, 'utf8').includes('[Embed: assets/energy-domain-map.html]'), 'autosave writes the inserted line')
    // The compiled slide carries the page (the strip compiles through talk:compile).
    // (That the line compiles to the inlined page is checked in scripts/test-html-page-import.mjs; rows
    // carry no slide HTML.) Here: the slide's row counts the embed and carries no missing/outside warning.
    const mapRow = await page.evaluate(async (path) => {
      const rows = await window.tw.talk.compile(path, await window.tw.talk.readOutline(path))
      const row = (rows ?? []).find((r) => r.slide_id === 'map')
      return row ? { embeds: row.embed_count, warnings: row.warnings ?? [] } : null
    }, outline)
    assert.equal(mapRow?.embeds, 1, 'the compiled Map slide has the embed')
    assert.deepEqual(mapRow.warnings.filter((w) => /asset|embed/.test(w)), [], 'no missing or outside-vault warning')

    // One Undo takes back the line and only the line.
    await page.locator('.cm-content').click()
    await page.locator('.cm-line').filter({ hasText: 'First slide body.' }).click()
    await page.keyboard.press('ControlOrMeta+z')
    await page.waitForFunction(() => !document.querySelector('.cm-content')?.textContent.includes('[Embed: assets/energy-domain-map.html]'))
    assert.ok((await editorText()).includes('Map slide body. Typed before inserting.'), 'Undo keeps the earlier typing')

    // The same page again: reused, not copied twice.
    await page.keyboard.press('ControlOrMeta+Shift+z')
    await page.waitForFunction(() => document.querySelector('.cm-content')?.textContent.includes('[Embed: assets/energy-domain-map.html]'))
    await page.locator('.cm-line').filter({ hasText: 'First slide body.' }).click()
    await page.keyboard.press('End')
    await insertHtmlPage()
    await page.waitForFunction(() => (document.querySelector('.cm-content')?.textContent.match(/\[Embed: assets\/energy-domain-map\.html\]/g) ?? []).length === 2)
    assert.deepEqual(readdirSync(join(talkDir, 'assets')), ['energy-domain-map.html'], 'one copy for the same page')

    assert.deepEqual(errors, [])
    if (process.env.SHOTS) await page.screenshot({ path: join(resolve(process.env.SHOTS), `talkweaver-insert-html-page-${mode}.png`) })
    console.log(`PASS (${mode} view) Insert › HTML page…: menu, Cancel, copy, caret insert, unsaved typing kept, one-step Undo, reuse`)
  } finally {
    await app?.close()
    rmSync(scratch, { recursive: true, force: true })
  }
}
