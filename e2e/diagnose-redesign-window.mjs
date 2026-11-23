// ADR-0045, FR1 → FR4 → WN1. Real hidden Electron, with a synthetic Documents folder.
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { _electron as electron } from 'playwright'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { buildPerSlideProjections } from '../compiler/scripts/lib/10-projections.mjs'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'

const root = process.cwd()
await ensureFreshBuild(root)
const scratch = realpathSync(mkdtempSync(join(root, 'node_modules/.tw-redesign-')))
const documents = join(scratch, 'Documents')
const profile = join(scratch, 'profile')
const vault = join(documents, 'TalkWeaver')
const outline = join(vault, 'garden-rota', 'garden-rota-outline.md')
const assets = join(vault, 'garden-rota', 'assets')
const output = resolve('artefacts/redesign-window')
mkdirSync(documents)
mkdirSync(output, { recursive: true })

// Known, real PNG. Sharp and the app have to consume the bytes, not an IPC stub.
const picture = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#157d3c' } }).png().toBuffer()
const env = { TW_E2E: '1' }
for (const name of ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'SHELL', 'DISPLAY']) {
  if (process.env[name] !== undefined) env[name] = process.env[name]
}
const meta = process.platform === 'darwin' ? 'Meta' : 'Control'
const key = (page, number) => page.keyboard.press(`${meta}+${number}`)
let app
async function until(description, check, timeout = 18000) {
  const end = Date.now() + timeout
  do {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 100))
  } while (Date.now() < end)
  throw new Error(description)
}

try {
  app = await electron.launch({ cwd: root, args: ['.', `--user-data-dir=${profile}`], env })
  const page = await app.firstWindow()
  page.on('pageerror', error => console.error('[renderer]', error.message))
  await app.evaluate(({ app, BrowserWindow, session, shell }, dir) => {
    app.setPath('documents', dir)
    shell.openExternal = async () => {}
    shell.openPath = async () => ''
    shell.showItemInFolder = () => {}
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, reply) => reply({ cancel: true }))
    for (const win of BrowserWindow.getAllWindows()) win.setContentSize(1400, 860)
  }, documents)
  const welcome = page.locator('.tw-welcome')
  await welcome.waitFor()
  await page.waitForFunction(() => document.activeElement?.id === 'tw-welcome-title')
  await page.waitForFunction(() => {
    const footer = document.querySelector('.tw-welcome-foot')
    const buttons = [...footer.querySelectorAll('button')].map(button => button.getBoundingClientRect())
    return buttons.every(rect => Math.abs(rect.y - buttons[0].y) < 2 && rect.right <= footer.getBoundingClientRect().right)
  })
  await page.screenshot({ path: join(output, 'FR1-welcome.png') })
  await page.getByLabel('Name of the talk').fill('Garden Rota')
  await page.getByRole('button', { name: /Start with a slide/ }).click()
  const editor = page.locator('[data-view="slide"] .cm-content')
  await editor.waitFor()
  await until('talk source was not written', () => existsSync(outline))
  assert.match(readFileSync(outline, 'utf8'), /defaults:\n  title: top\n/)
  await page.waitForFunction(() => document.querySelector('[data-view="slide"] .workspace-slide-stage iframe'))
  await page.waitForFunction(() => document.activeElement?.matches('.cm-content') &&
    document.querySelector('[data-view="slide"] .workspace-slide-crumb strong')?.textContent?.startsWith('Slide 2 of '))
  const generatedClosing = page.locator('[data-slides-mode="previews"] [data-generated-closing]')
  const closingLabel = generatedClosing.getByText('Closing', { exact: true })
  await closingLabel.waitFor()
  assert.equal(await closingLabel.getAttribute('title'), 'Generated closing slide')
  await page.locator('.workspace-empty-preview').getByText('Slide title', { exact: true }).waitFor()
  await page.locator('.workspace-empty-text').getByText('First point', { exact: true }).waitFor()
  assert.doesNotMatch(readFileSync(outline, 'utf8'), /Slide title|First point/)
  assert.equal(await page.getByText('Untitled section', { exact: true }).count(), 0)
  await page.locator('[data-slides-mode="previews"]').getByText('New slide', { exact: true }).first().waitFor()
  await page.frameLocator('.workspace-slide-stage iframe').locator('.slide.active[data-layout="list"]').waitFor()
  await page.screenshot({ path: join(output, 'FR2-first-slide.png') })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark')
  assert.equal(await page.locator('.workspace-empty-preview').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(245, 247, 252)')
  await page.screenshot({ path: join(output, 'FR2-first-slide-dark.png') })
  await page.emulateMedia({ colorScheme: 'light' })
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')
  await editor.focus()
  await page.keyboard.type('Watering rota')
  for (const point of ['Repair the beds', 'Bring spare gloves', 'Share the tools']) {
    await page.keyboard.press('Enter')
    await page.keyboard.type(point)
  }
  try {
    await until('title and three real bullets did not save', () =>
      /^### Watering rota[^\n]*\n(?:\{[^\n]+\}\n)*\s*- Repair the beds\n- Bring spare gloves\n- Share the tools/m.test(readFileSync(outline, 'utf8')))
  } catch (error) {
    console.error('Synthetic outline:', readFileSync(outline, 'utf8'))
    console.error('Editor:', await page.evaluate(() => document.querySelector('.cm-content')?.textContent), 'selection:', await page.evaluate(() => window.getSelection()?.focusNode?.textContent))
    await page.screenshot({ path: join(output, 'diagnostic-typing.png') })
    throw error
  }
  const slide = page.frameLocator('.workspace-slide-stage iframe').locator('.slide.active')
  await slide.getByText('Watering rota', { exact: true }).waitFor()
  await slide.locator('li').getByText('Share the tools', { exact: true }).waitFor()
  assert.equal(await slide.getAttribute('data-layout'), 'list')
  await page.locator('.workspace-empty-preview').waitFor({ state: 'hidden' })
  await page.screenshot({ path: join(output, 'FR3-typed.png') })
  const pathBeforeDuplicate = readFileSync(outline, 'utf8')
  const collision = await page.evaluate(() => window.tw.vault.createTalk({ title: 'Replaced', slug: 'garden-rota' }))
  assert.equal(collision, null)
  assert.equal(readFileSync(outline, 'utf8'), pathBeforeDuplicate)

  // Use Chromium's events with a real PNG and the same mixed flavours Office supplies.
  async function addPicture({ drop = false, selector, plain, html } = {}) {
    await page.evaluate(({ bytes, drop, selector, plain, html }) => {
      const data = new DataTransfer()
      if (plain !== undefined) data.setData('text/plain', plain)
      if (html !== undefined) data.setData('text/html', html)
      data.items.add(new File([new Uint8Array(bytes)], 'garden.png', { type: 'image/png' }))
      const target = document.querySelector(selector ?? (drop ? '.workspace-panes' : '.cm-content')) ?? document.body
      target.dispatchEvent(drop
        ? new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data })
        : new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }))
    }, { bytes: [...picture], drop, selector, plain, html })
  }
  const stage = '.workspace-slide-stage'
  await editor.focus()
  await addPicture({ plain: ' and seedlings', html: '<strong>unused HTML</strong>' })
  await until('mixed plain text did not paste into Slide text', () => readFileSync(outline, 'utf8').includes('Share the tools and seedlings'))
  await addPicture({ html: '<span> tomorrow</span><style>unused CSS</style>' })
  await until('HTML-only text in a mixed clipboard did not paste into Slide text', () => readFileSync(outline, 'utf8').includes('Share the tools and seedlings tomorrow'))
  assert.doesNotMatch(readFileSync(outline, 'utf8'), /unused HTML|unused CSS/)
  assert.equal(existsSync(assets), false)

  const pathBeforePictures = readFileSync(outline, 'utf8')
  const badPicture = await page.evaluate(({ path, bytes }) =>
    window.tw.asset.pasteTalkPictures(path, [new Uint8Array(bytes).buffer, new Uint8Array([1, 2, 3]).buffer]),
  { path: outline, bytes: [...picture] })
  assert.equal(badPicture, null)
  assert.equal(existsSync(assets), false)
  assert.equal(readFileSync(outline, 'utf8'), pathBeforePictures)
  await page.locator(stage).focus()
  await addPicture({ selector: stage, plain: 'Picture caption' })
  await until('Slide paste did not land', () => existsSync(assets) && readFileSync(outline, 'utf8').includes('![](assets/pasted-'))
  const [first] = readdirSync(assets)
  assert.match(first, /^pasted-[a-f\d]+\.webp$/)
  const firstBytes = readFileSync(join(assets, first))
  const firstWriteTime = statSync(join(assets, first), { bigint: true }).mtimeNs
  assert.equal(firstBytes.toString('ascii', 8, 12), 'WEBP')
  await page.screenshot({ path: join(output, 'PA1-picture.png') })
  await page.getByRole('button', { name: /Speaker notes/ }).click()
  const notes = page.getByRole('textbox', { name: 'Speaker notes' })
  await editor.locator('.cm-line').filter({ hasText: 'Share the tools and seedlings tomorrow' }).click()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await page.keyboard.type('{')
  await until('there was no unfinished layout code at the caret', async () => await editor.evaluate(el => {
    const caret = document.getSelection()?.focusNode
    if (!caret || !el.contains(caret)) return false
    const element = caret instanceof Element ? caret : caret.parentElement
    return element?.closest('.cm-line')?.textContent?.replaceAll('\u200b', '').trim() === '{'
  }))
  assert.doesNotMatch(readFileSync(outline, 'utf8'), /^[ \t]*\{[ \t]*$/m)
  // Start typing in the notes in the same task as blur, before CodeMirror's rollback timer.
  assert.equal(await notes.evaluate(field => {
    field.focus()
    return document.execCommand('insertText', false, 'Mention the late delivery.')
  }), true)
  await until('notes did not save privately', () => /:::notes\nMention the late delivery\.\n:::/.test(readFileSync(outline, 'utf8')))
  assert.doesNotMatch(readFileSync(outline, 'utf8'), /^[ \t]*\{[ \t]*$/m)
  await addPicture({ selector: 'textarea[aria-label="Speaker notes"]', html: '<span> Bring a spare.</span>' })
  await until('HTML-only text in a mixed clipboard did not paste into the notes field', () =>
    /:::notes\nMention the late delivery\. Bring a spare\.\n:::/.test(readFileSync(outline, 'utf8')))
  assert.deepEqual(readdirSync(assets), [first])
  await page.screenshot({ path: join(output, 'NT1-notes.png') })
  console.log('Mixed plain/HTML and HTML-only copies preserved text in typing targets. Stage focus kept the image. Notes survived layout-code rollback.')

  for (const [number, view] of [[2, 'grid'], [3, 'outline'], [4, 'markdown']]) {
    await key(page, number)
    await page.locator(`[data-view="${view}"]`).first().waitFor()
    if (view === 'grid') {
      assert.equal(await page.locator('[data-right-column]').count(), 0)
      assert.equal(await page.locator('[data-grid-toolbar]').count(), 0)
      assert.equal(await page.getByText('(no section)', { exact: true }).count(), 0)
    }
    const before = readFileSync(outline, 'utf8')
    await addPicture({ drop: view === 'grid', plain: view === 'grid' ? 'A drop still inserts its file' : undefined })
    await until(`${view} paste did not land`, () => readFileSync(outline, 'utf8') !== before)
    assert.deepEqual(readFileSync(join(assets, first)), firstBytes)
    assert.equal(statSync(join(assets, first), { bigint: true }).mtimeNs, firstWriteTime)
    await page.screenshot({ path: join(output, `${view}.png`) })
  }
  assert.equal(readdirSync(assets).length, 4)
  const sourceAfterPictures = readFileSync(outline, 'utf8')
  assert.equal((sourceAfterPictures.match(/!\[\]\(assets\//g) ?? []).length, 4)
  await page.locator('[data-view="markdown"] .cm-content').focus()
  await page.keyboard.press(`${meta}+z`)
  await until('one Undo did not remove just the latest insertion', () => (readFileSync(outline, 'utf8').match(/!\[\]\(assets\//g) ?? []).length === 3)
  assert.match(readFileSync(outline, 'utf8'), /Share the tools/)
  assert.deepEqual(readFileSync(join(assets, first)), firstBytes)

  await key(page, 1)
  await page.locator('[data-view="slide"]').waitFor()
  await page.waitForFunction(() => document.querySelector('.workspace-slide-view')?.scrollTop === 0)
  await until('Slide view showed notes outside their field', async () =>
    !(await editor.innerText()).includes('Mention the late delivery.'))
  await page.getByRole('button', { name: 'Show slides as an outline' }).click()
  await page.locator('[data-slides-mode="outline"]').waitFor()
  await page.getByRole('button', { name: 'Show slides as previews' }).click()
  await page.locator('[data-slides-mode="previews"] .tw-slide-card').first().waitFor()
  await page.getByRole('button', { name: 'Present', exact: true }).click()
  const isDeck = window => window !== page && /\/garden-rota-present\.html(?:[?#]|$)/.test(window.url())
  await until('presentation window did not open', () => app.windows().some(isDeck), 25000)
  const deck = app.windows().find(isDeck)
  assert.equal(decodeURIComponent(new URL(deck.url()).hash.slice(1)), readFileSync(outline, 'utf8').match(/\{id=([^}]+)\}/)?.[1])
  await deck.locator('.slide.active').waitFor()
  assert.ok(!(await deck.locator('.slide.active').innerText()).includes('Mention the late delivery.'))
  await deck.screenshot({ path: join(output, 'FR6-present.png') })
  const legacyOutlines = [
    ['garden-archive', 'Garden Archive', '', '## The garden {id=sec1}\n\n### Archive {id=sub1}\n\n- Earlier notes\n'],
    ['old-rail', 'Old rail', 'defaults:\n  title: side\n', '### With a rail {id=rail1}\n\n- First\n- Second\n'],
    ['old-hidden-title', 'Hidden title', '', '### Quotation {id=q01}\n{quote}{notitle}\n\n> Kept the wording\n']
  ]
  const artwork = rows => rows.map(row => [row.slide_id, row.title_layout, row.render_hash])
  for (const [slug, title, defaults, content] of legacyOutlines) {
    const oldDir = join(vault, slug)
    const oldPath = join(oldDir, slug + '-outline.md')
    const oldText = `---\ntitle: ${title}\noutline_version: 2\n${defaults}---\n\n${content}`
    mkdirSync(oldDir)
    writeFileSync(oldPath, oldText)
    const baseModel = await prepareSource(oldPath, oldText, slug, statSync(oldPath))
    const baseline = artwork(buildPerSlideProjections(baseModel, slug))
    const compiled = await page.evaluate(async ({ path, text }) => window.tw.talk.compile(path, text), { path: oldPath, text: oldText })
    assert.ok(Array.isArray(compiled), slug)
    assert.deepEqual(artwork(compiled), baseline, slug)
    assert.equal(readFileSync(oldPath, 'utf8'), oldText, slug)
  }
  console.log('Three synthetic legacy outlines preserved byte for byte. Layouts and render hashes match the unchanged base compiler.')

  await app.evaluate(({ BrowserWindow }) => {
    const editor = BrowserWindow.getAllWindows().find(win => /index\.html/.test(win.webContents.getURL()))
    editor?.setContentSize(1000, 631)
  })
  await page.waitForFunction(() => innerWidth === 1000 && innerHeight === 631)
  const bars = await page.evaluate(() => [...document.querySelectorAll('.workspace-view-titlebar, .workspace-centre > .tw-action-bar')]
    .map(bar => Math.round(bar.getBoundingClientRect().height)))
  assert.deepEqual(bars, [46, 46])
  assert.equal(await page.locator('[data-slides-mode="previews"]').evaluate(el => Math.round(el.getBoundingClientRect().width)), 86)
  await closingLabel.waitFor()
  await page.locator('[data-slides-mode="previews"] .tw-slide-card:not([data-generated-closing]) .tw-strip-caption').first().waitFor({ state: 'hidden' })
  const lockedButtons = ['format-bold', 'format-italic', 'format-link', 'bulleted-list', 'numbered-list']
  for (const id of lockedButtons) {
    await page.locator(`.workspace-edit-controls > button[data-command="${id}"]`).waitFor()
  }
  const savedStatus = page.locator('[data-status-saved]')
  await savedStatus.filter({ hasText: /^Saved / }).waitFor()
  assert.equal(await savedStatus.evaluate(el => {
    const item = el.getBoundingClientRect()
    const left = el.parentElement.getBoundingClientRect()
    const pill = document.querySelector('[data-status-pill-slot]').getBoundingClientRect()
    return item.width > 12 && item.right <= left.right + 1 && item.right <= pill.left &&
      getComputedStyle(el).textOverflow === 'ellipsis'
  }), true, 'Saved stays inside its status area and clear of the Scratchpad at 1000 px')
  await page.screenshot({ path: join(output, 'WN1-1000x631.png') })

  // A second window uses the established vault and the same welcome entry point.
  const newWindow = app.waitForEvent('window', candidate => candidate !== page && candidate !== deck)
  assert.equal((await page.evaluate(() => window.tw.windows.open())).ok, true)
  const outlinePage = await newWindow
  const outlineWelcome = outlinePage.locator('.tw-welcome')
  await outlineWelcome.waitFor()
  await outlineWelcome.getByText('Saved in Documents/TalkWeaver.', { exact: true }).waitFor()
  await outlinePage.getByLabel('Name of the talk').fill('Neighbour checklist')
  await outlinePage.getByRole('button', { name: /Start with an outline/ }).click()
  const sketchEditor = outlinePage.getByRole('textbox', { name: 'Sketch text' })
  await sketchEditor.waitFor()
  assert.equal(await sketchEditor.inputValue(), '')
  const outlineStarted = join(vault, 'neighbour-checklist', 'neighbour-checklist-outline.md')
  await sketchEditor.fill('### Look after the beds\n- Check the watering')
  await outlinePage.getByRole('button', { name: 'Break into slides', exact: true }).click()
  await outlinePage.getByRole('button', { name: /^As marked/ }).click()
  await outlinePage.getByRole('button', { name: 'Add 1 slide to the talk', exact: true }).click()
  await outlinePage.locator('[data-view="outline"] .cm-content').waitFor()
  await until('the Sketch start did not write the title and a bullet', () =>
    existsSync(outlineStarted) && /^### Look after the beds[^\n]*\n(?:\{[^\n]+\}\n)*\s*- Check the watering/m.test(readFileSync(outlineStarted, 'utf8')))

  // Edit one slide, select another, then Undo and Redo from the scoped Slide view.
  await outlinePage.locator('.workspace-edit-controls > button[data-command="new-slide"]').click()
  const firstEditable = outlinePage.locator('[data-slides-mode="previews"] .tw-slide-card[data-slide-index="1"]')
  const secondEditable = outlinePage.locator('[data-slides-mode="previews"] .tw-slide-card[data-slide-index="2"]:not([data-generated-closing])')
  await secondEditable.waitFor()
  await outlinePage.waitForFunction(() => document.activeElement?.matches('.cm-content') &&
    document.querySelector('.tw-slide-card[data-slide-index="2"]')?.getAttribute('data-active') === 'true')
  await outlinePage.keyboard.type('Review the hinges')
  await until('the second slide title did not save', () => readFileSync(outlineStarted, 'utf8').includes('### Review the hinges'))
  await firstEditable.click()
  await key(outlinePage, 1)
  const scoped = outlinePage.locator('[data-view="slide"] .cm-content')
  await scoped.locator('.cm-line').filter({ hasText: 'Look after the beds' }).waitFor()
  await scoped.focus()
  await outlinePage.keyboard.press(`${meta}+z`)
  try {
    await until('Undo did not remove the other slide’s title', () => !readFileSync(outlineStarted, 'utf8').includes('### Review the hinges'))
    await secondEditable.and(outlinePage.locator('[data-active="true"]')).waitFor({ timeout: 7000 })
    await outlinePage.locator('.workspace-empty-text').getByText('Slide title', { exact: true }).waitFor({ timeout: 7000 })
  } catch (error) {
    console.error('Synthetic outline after Undo:', readFileSync(outlineStarted, 'utf8'))
    console.error('Slide selection after Undo:', await outlinePage.evaluate(() => ({
      selected: document.querySelector('.tw-slide-card[data-active="true"]')?.textContent,
      caret: document.getSelection()?.focusNode?.textContent,
      editor: document.querySelector('[data-view="slide"] .cm-content')?.textContent,
      crumb: document.querySelector('[data-view="slide"] .workspace-slide-crumb')?.textContent
    })))
    await outlinePage.screenshot({ path: join(output, 'diagnostic-slide-undo.png') })
    throw error
  }
  await firstEditable.click()
  await scoped.locator('.cm-line').filter({ hasText: 'Look after the beds' }).waitFor()
  await scoped.focus()
  await outlinePage.keyboard.press(`${meta}+Shift+z`)
  await scoped.locator('.cm-line').filter({ hasText: 'Review the hinges' }).waitFor()
  assert.equal(await secondEditable.getAttribute('data-active'), 'true')

  const outlineClosing = outlinePage.locator('[data-slides-mode="previews"] [data-generated-closing]')
  const lastAuthored = outlinePage.locator('[data-slides-mode="previews"] .tw-slide-card[data-slide-index="3"]:not([data-generated-closing])')
  const editControls = outlinePage.locator('.workspace-edit-controls')
  async function appendFromClosing() {
    await outlineClosing.click()
    await outlineClosing.and(outlinePage.locator('[data-active="true"]')).waitFor()
    await editControls.locator('button[data-command="new-slide"]').click()
    await lastAuthored.and(outlinePage.locator('[data-active="true"]')).waitFor()
    assert.equal(await outlineClosing.getAttribute('data-slide-index'), '4')
    await until('New slide did not append after both authored slides', () =>
      /### Look after the beds[^]*### Review the hinges[^]*### \{id=[^}]+\}\n\{list\}/m.test(readFileSync(outlineStarted, 'utf8')))
  }
  await appendFromClosing()
  await outlinePage.waitForFunction(() => document.activeElement?.matches('[data-view="slide"] .cm-content'))
  await outlinePage.keyboard.type('Temporary last slide')
  await until('temporary slide title did not save', () => readFileSync(outlineStarted, 'utf8').includes('### Temporary last slide'))
  await editControls.locator('button[data-command="delete-slide"]').click()
  await until('Delete did not remove the temporary slide', () => !readFileSync(outlineStarted, 'utf8').includes('### Temporary last slide'))
  await outlineClosing.and(outlinePage.locator('[data-slide-index="3"]')).waitFor()
  await appendFromClosing()

  await outlinePage.locator('.workspace-view-titlebar').getByRole('button', { name: 'Tools', exact: true }).click()
  const moreMenu = outlinePage.getByRole('menu')
  for (const label of ['Studio: record and edit', 'Sessions with an audience', 'Import PowerPoint…', 'All commands']) {
    await moreMenu.getByText(label, { exact: true }).waitFor()
  }
  await moreMenu.getByRole('menuitem', { name: 'Guide', exact: true }).click()
  await outlinePage.locator('[data-guide]').waitFor()
  console.log('More labels, Guide, narrow save status and append before Closing passed.')

  console.log('FR1 → FR4 → WN1 passed. Three authored bullets compiled as list. Same-name creation refused. 4 picture files preserved. One Undo removed one reference. Presentation opened on the selected slide.')
} finally {
  await app?.close()
  rmSync(scratch, { recursive: true, force: true })
}
