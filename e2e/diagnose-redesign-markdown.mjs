// ADR-0045 MD1/ST1/PA1. Hidden Electron, real outline writer and one shared history.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { chromium, _electron as electron } from 'playwright'
import { scratchVault } from './lib/scratch-vault.mjs'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { readSlides } from '../src/shared/insert-section.ts'

using fixture = scratchVault('tw-redesign-markdown-')
const root = resolve('.')
const vault = join(fixture.root, 'vault')
const profile = join(fixture.root, 'profile')
const talk = join(vault, 'markdown-garden')
const outline = join(talk, 'markdown-garden-outline.md')
const source = [
  '---', 'outline_version: 2', 'title: Garden', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '',
  '## Season', '{id=season}', '',
  '### Watering', '{id=water}', '', '- Measure the beds', '',
  '### Repair', '{id=repair}', '', '- Fix the fence', '',
  '### Volunteers', '{id=volunteers}', '{sub}{role=subsection-title}', '',
  '#### Seeds', '{id=seeds}', '', '- Share the seeds', '',
  '#### Tools', '{id=tools}', '', '- Bring the tools', '',
  '## Next season', '{id=next}', '',
  '### Compare', '{id=compare}', '', '- Compare the results', ''
].join('\n')
const picture = [...readFileSync(join(root, 'demo-vault/layout-sampler/assets/sample-image.png'))]
mkdirSync(talk, { recursive: true })
mkdirSync(profile)
writeFileSync(outline, source)
writeFileSync(join(profile, 'config.json'), JSON.stringify({ vaultRoot: vault }))
const env = { TW_E2E: '1' }
for (const name of ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'SHELL', 'DISPLAY']) {
  if (process.env[name] !== undefined) env[name] = process.env[name]
}

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const disk = () => readFileSync(outline, 'utf8')
async function until(check, message) {
  const end = Date.now() + 24000
  while (Date.now() < end) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 70))
  }
  throw new Error(message)
}

async function capture(app, page, browser, path, width, height, scheme) {
  await app.evaluate(({ BrowserWindow }, size) => {
    for (const window of BrowserWindow.getAllWindows()) window.setContentSize(...size)
  }, [width, height])
  await page.emulateMedia({ colorScheme: scheme })
  await page.waitForFunction(({ width, height, scheme }) =>
    innerWidth === width && innerHeight === height && document.documentElement.dataset.theme === scheme,
  { width, height, scheme })
  const snapshot = await page.evaluate(() => ({
    html: document.documentElement.outerHTML,
    css: [...document.styleSheets].flatMap(sheet => {
      try { return [...sheet.cssRules].map(rule => rule.cssText) } catch { return [] }
    }).join('\n'),
    scroll: [...document.querySelectorAll('*')].flatMap((element, index) => element.scrollTop ? [[index, element.scrollTop]] : []),
    thumbs: [...new Set([...document.images].map(img => img.src).filter(src => src.startsWith('twthumb://')))]
  }))
  const thumbs = await app.evaluate(async ({ net }, urls) => Object.fromEntries(await Promise.all(urls.map(async url => {
    const response = await net.fetch(url)
    return [url, response.ok ? 'data:image/png;base64,' + Buffer.from(await response.arrayBuffer()).toString('base64') : '']
  }))), snapshot.thumbs)
  const frames = await Promise.all(page.frames().filter(frame => frame.parentFrame() === page.mainFrame())
    .map(frame => frame.content().then(html => html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')).catch(() => '')))
  const copy = await browser.newPage({ viewport: { width, height }, colorScheme: scheme })
  try {
    await copy.route(/^https?:/, route => route.abort())
    await copy.setContent(snapshot.html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ''), { waitUntil: 'domcontentloaded' })
    await copy.addStyleTag({ content: snapshot.css })
    await copy.evaluate(({ scroll, thumbs, frames }) => {
      for (const image of document.images) {
        if (thumbs[image.src]) image.src = thumbs[image.src]
      }
      const elements = [...document.querySelectorAll('*')]
      for (const [index, top] of scroll) elements[index].scrollTop = top
      document.querySelectorAll('iframe').forEach((frame, index) => {
        frame.removeAttribute('src')
        if (frames[index]) frame.srcdoc = frames[index]
      })
    }, { scroll: snapshot.scroll, thumbs, frames })
    await copy.screenshot({ path, animations: 'disabled' })
  } finally {
    await copy.close()
  }
}

await ensureFreshBuild(root)
const app = await electron.launch({ args: ['.', '--user-data-dir=' + profile], cwd: root, env })
let browser
try {
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await app.evaluate(({ BrowserWindow, session }) => {
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, reply) => reply({ cancel: true }))
    for (const win of BrowserWindow.getAllWindows()) win.setContentSize(1440, 900)
  })
  assert.ok(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(win => !win.isVisible())))
  await page.locator('[data-talk-slug="markdown-garden"]').first().dblclick()
  await page.getByRole('tab', { name: 'Slides', exact: true }).click()
  const panel = page.locator('.tw-structure-panel')
  const inspector = page.locator('.tw-inspector .tw-right-who')
  const toolbar = page.locator('.workspace-centre .tw-action-bar')
  const editor = page.locator('.workspace-centre .cm-content')
  const row = title => panel.locator('[data-line]').filter({ hasText: title }).first()
  await page.getByRole('button', { name: 'Show slides as an outline' }).click()
  await row('Watering').waitFor()
  async function view(number, name) {
    await page.keyboard.press(mod + '+' + number)
    await page.locator('.workspace-centre [data-view="' + name + '"]').waitFor()
  }
  async function caretAt(needle, end = false) {
    await editor.evaluate((element, { needle, end }) => {
      const view = element.cmTile.root.view
      const at = view.state.doc.toString().indexOf(needle)
      if (at < 0) throw Error('Fixture caret target is absent: ' + needle)
      view.dispatch({ selection: { anchor: at + (end ? needle.length : 0) }, scrollIntoView: true })
      view.focus()
    }, { needle, end })
  }
  const live = () => editor.evaluate(el => el.cmTile.root.view.state.doc.toString())
  const caretLine = () => editor.evaluate(el => {
    const { state } = el.cmTile.root.view
    return state.doc.lineAt(state.selection.main.head).text
  })
  async function undo(label, baseline = source) {
    // A file may already be visible on disk while the renderer is still acknowledging the write.
    await page.locator('[data-status-saved]:not([title*="Unsaved"])').waitFor()
    await editor.focus()
    await page.keyboard.press(mod + '+z')
    assert.equal(await live(), baseline, label + ': the editor shares the same Undo')
    await until(() => disk() === baseline, label + ': one Undo did not restore the file bytes')
  }
  const section = async kind => {
    await toolbar.getByRole('button', { name: 'Section', exact: true }).click()
    return page.getByRole('menuitem', { name: kind, exact: false }).first()
  }
  async function fixedIdClick(button) {
    await button.evaluate(element => {
      // Freeze the single ID mint at the command boundary, then leave compile and autosave IDs alone.
      const uuid = crypto.randomUUID
      crypto.randomUUID = () => '53a5c0de-0000-4000-8000-000000000000'
      try { element.click() } finally { crypto.randomUUID = uuid }
    })
  }
  async function editCommand(command) {
    let button = toolbar.locator('button[data-command="' + command + '"]')
    if (!(await button.isVisible())) {
      await toolbar.getByRole('button', { name: 'More actions', exact: true }).click()
      button = toolbar.locator('[role="menuitem"][data-command="' + command + '"]')
    }
    return button
  }
  const shots = process.env.TW_MARKDOWN_SHOTS
  if (shots) {
    mkdirSync(shots, { recursive: true })
    browser = await chromium.launch({ headless: true })
    await view(4, 'markdown')
    await row('Repair').click()
    await until(async () => (await caretLine()).includes('Repair'), 'Markdown is ready for its screenshot')
    for (const [width, height] of [[1000, 631], [1440, 900]]) {
      for (const scheme of ['light', 'dark']) {
        await capture(app, page, browser, join(shots, width + 'x' + height + '-' + scheme + '.png'), width, height, scheme)
      }
    }
    await page.emulateMedia({ colorScheme: 'light' })
  }
  const authoredIds = new Set(readSlides(source).slides.map(slide => slide.id))
  const results = new Map()
  for (const [number, name] of [[1, 'slide'], [4, 'markdown']]) {
    await view(number, name)
    for (const [title, anchor] of [['Watering', '- Measure the beds'], ['Seeds', '- Share the seeds']]) {
      for (const command of ['new-slide', 'new-section', 'new-subsection', 'insert-object-table', 'icon-picker', 'duplicate-slide', 'move-current-slide-down', 'delete-slide']) {
        await row(title).click()
        await until(async () => (await caretLine()).includes(title), name + ' did not visit ' + title)
        await caretAt(anchor)
        let button
        if (command === 'new-section' || command === 'new-subsection') {
          button = await section(command === 'new-section' ? 'New section' : 'New subsection')
        } else button = await editCommand(command)
        assert.ok(await button.isEnabled(), name + ' disabled ' + command)
        await fixedIdClick(button)
        if (command === 'icon-picker') {
          const picker = page.getByRole('dialog', { name: 'Insert icon' })
          await picker.getByRole('textbox', { name: 'Search icons' }).fill('star')
          await picker.locator('[data-icon-key="lucide:star"]').first().click()
        }
        await until(() => disk() !== source, name + ': ' + command + ' did not write bytes')
        let bytes = disk()
        if (command === 'duplicate-slide') {
          // Duplicate mints inside the queued write, after the click's synchronous UUID stub.
          const newIds = readSlides(bytes).slides.filter(slide => !authoredIds.has(slide.id)).map(slide => slide.id)
          assert.equal(newIds.length, 1, 'a duplicate contributes one new slide ID')
          assert.match(newIds[0], /^[a-f0-9]{8}$/)
          const token = '{id=' + newIds[0] + '}'
          assert.equal(bytes.split(token).length, 2, 'the generated ID occurs once')
          bytes = bytes.replace(token, '{id=53a5c0de}')
        }
        const key = title + ' / ' + command
        if (name === 'slide') results.set(key, bytes)
        else assert.equal(bytes, results.get(key), key + ': same saved bytes in Slide and Markdown')
        if (command === 'insert-object-table') await page.keyboard.press('Escape')
        await undo(name + ' ' + key)
      }
    }
  }
  console.log('PASS ' + results.size + ' toolbar pairs saved identical bytes and undid in one step in both views')

  await row('Watering').click()
  await until(async () => (await caretLine()).includes('Watering'), 'outline click did not move the Markdown caret')
  await caretAt('- Fix the fence')
  await until(async () => (await inspector.innerText()).includes('Repair'), 'right panel did not follow the Markdown caret')
  await until(async () => (await row('Repair').getAttribute('class')).includes('so-row--current'), 'outline did not follow the Markdown caret')
  const labels = page.locator('.workspace-centre .cm-lineNumbers')
  await labels.getByTitle('Section §1', { exact: true }).first().waitFor()
  await labels.getByTitle('Subsection §1.1', { exact: true }).first().waitFor()
  await labels.getByTitle(/^Slide \d+$/).first().waitFor()
  await caretAt('## Season')
  const fold = page.locator('.workspace-centre .cm-foldGutter [title="Fold line"]').first()
  await fold.click()
  await page.locator('.workspace-centre .cm-foldPlaceholder').first().waitFor()
  await row('Watering').click()
  await until(async () => (await caretLine()).includes('Watering'), 'the outline jump did not reveal the folded editor section')
  assert.equal(await page.locator('.workspace-centre .cm-foldPlaceholder').count(), 0)
  assert.equal(disk(), source)
  await page.getByRole('button', { name: 'Show slides as previews' }).click()
  await panel.locator('.tw-slide-card').filter({ hasText: 'Repair' }).first().click()
  await until(async () => (await caretLine()).includes('Repair'), 'preview click did not move the Markdown caret')
  await page.locator('.tw-inspector').getByRole('button', { name: 'Next slide', exact: true }).click()
  await until(async () => (await caretLine()).includes('Volunteers'), 'right panel navigation did not move the Markdown caret')
  console.log('PASS editor folds and caret follow across the outline, previews and right panel')

  async function transfer(kind, text, pointer = {}) {
    await editor.evaluate((element, { picture, kind, text, pointer }) => {
      const data = new DataTransfer()
      data.items.add(new File([new Uint8Array(picture)], 'garden.png', { type: 'image/png' }))
      if (text) data.setData('text/plain', text)
      element.dispatchEvent(kind === 'paste'
        ? new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data })
        : new DragEvent(kind, { bubbles: true, cancelable: true, dataTransfer: data, ...pointer }))
    }, { picture, kind, text, pointer })
  }
  let firstPicture
  for (const kind of ['paste', 'drop']) {
    await caretAt('- Fix the fence', true)
    if (kind === 'drop') {
      const target = editor.locator('.cm-line').filter({ hasText: 'Share the seeds' })
      await target.scrollIntoViewIfNeeded()
      const box = await target.boundingBox()
      assert.ok(box, 'the drop target line has coordinates')
      const pointer = { clientX: Math.round(box.x + Math.min(40, box.width / 2)), clientY: Math.round(box.y + box.height / 2) }
      await transfer('dragover', undefined, pointer)
      const indicator = editor.locator('.cm-picture-drop-target').filter({ hasText: 'Share the seeds' })
      await indicator.waitFor()
      assert.match(await caretLine(), /Fix the fence/, 'hover keeps the caret on Repair')
      await transfer('drop', undefined, pointer)
      await indicator.waitFor({ state: 'detached' })
    } else await transfer(kind)
    await until(() => disk().includes('![](assets/pasted-'), kind + ' did not write a scoped picture reference')
    const slide = readSlides(disk()).slides.find(slide => slide.id === (kind === 'drop' ? 'seeds' : 'repair'))
    const ref = slide.content.match(/!\[\]\((assets\/pasted-[a-f\d]{12}(?:-[1-9]\d?)?\.webp)\)/)?.[1]
    assert.ok(ref, kind + ' wrote to ' + slide.id + ': ' + slide.content)
    const bytes = readFileSync(join(talk, ref))
    assert.equal(bytes.toString('ascii', 8, 12), 'WEBP')
    if (!firstPicture) {
      firstPicture = { ref, bytes }
    } else {
      assert.equal(ref, firstPicture.ref.replace(/\.webp$/, '-1.webp'), 'drop writes a new asset for the same picture')
      assert.deepEqual(readFileSync(join(talk, firstPicture.ref)), firstPicture.bytes, 'drop preserves the original image file')
    }
    await undo(kind)
  }
  const files = readdirSync(join(talk, 'assets'))
  await caretAt('- Fix the fence', true)
  await transfer('paste', ' and gate')
  await until(() => disk().includes('Fix the fence and gate'), 'mixed paste did not keep the text')
  assert.deepEqual(readdirSync(join(talk, 'assets')), files)
  await undo('mixed paste')
  console.log('PASS picture paste, file drop, mixed clipboard text and single Undo')

  await caretAt('- Fix the fence', true)
  await page.keyboard.press('Enter')
  await page.keyboard.type('Add a gate')
  assert.match(await live(), /Fix the fence\n- Add a gate/)
  await page.keyboard.press('Tab')
  assert.match(await live(), /Fix the fence\n +-[ ]Add a gate/)
  await page.keyboard.press('Shift+Tab')
  assert.match(await live(), /Fix the fence\n- Add a gate/)
  for (let i = 0; i < 8 && await live() !== source; i++) await page.keyboard.press(mod + '+z')
  await until(() => disk() === source, 'list edits did not unwind')

  for (const [prefix, kind] of [['## ', 'section'], ['### ', 'subsection']]) {
    await caretAt('### Repair')
    // Place the caret on the existing blank line above the heading.
    await page.keyboard.press('ArrowUp')
    await page.keyboard.type(prefix)
    await page.getByRole('option', { name: 'New ' + kind }).waitFor()
    // CodeMirror ignores acceptance during the first 75 ms of a new completion list.
    await page.waitForTimeout(100)
    const typed = await live()
    await page.keyboard.press('Enter')
    await until(() => readSlides(disk()).slides.length === readSlides(source).slides.length + 1,
      'the heading suggestion did not create a ' + kind)
    const created = readSlides(disk()).slides.find(slide => !readSlides(source).slides.some(old => old.id === slide.id))
    assert.match(created.id, /^[a-f0-9]{8}$/)
    assert.equal(created.level, kind === 'section' ? 2 : 3)
    await undo('heading suggestion', typed)
    await undo('typed heading prefix')
  }
  for (const [heading, id] of [['## Season', 'season'], ['### Repair', 'repair'], ['#### Seeds', 'seeds']]) {
    await caretAt(heading, true)
    await page.keyboard.press('Enter')
    assert.equal(await caretLine(), '', heading + ' opens a blank body line at the caret')
    const token = '{id=' + id + '}'
    const expected = source.replace(token, token + '\n')
    assert.equal(await live(), expected, heading + ' keeps the heading, metadata and following source intact')
    await until(() => disk() === expected, heading + ' saves the new line')
    await undo(heading + ' Enter')
  }
  console.log('PASS list continuation, nesting, stable-ID heading suggestions, and Enter after all three heading levels')

  await app.evaluate(({ BrowserWindow }) => {
    for (const win of BrowserWindow.getAllWindows()) win.setContentSize(1000, 631)
  })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.waitForFunction(() => innerWidth === 1000 && innerHeight === 631 && document.documentElement.dataset.theme === 'dark')
  await caretAt('title: Garden', true)
  const narrow = await page.locator('.workspace-centre .cm-scroller').evaluate(scroller => ({
    overflow: scroller.scrollWidth - scroller.clientWidth,
    offset: scroller.scrollLeft
  }))
  assert.ok(narrow.overflow <= 1 && narrow.offset <= 1, '1000×631 Talk details have no horizontal scroll: ' + JSON.stringify(narrow))
  console.log('PASS 1000×631 dark Talk details has no horizontal scrolling')

  assert.deepEqual(errors, [])
  assert.equal(disk(), source, 'all actions unwind to the original bytes')
} finally {
  try { await browser?.close() } finally { await app.close() }
}
