// ADR-0045 ST1 / LO1 / LO2 / GR1: real hidden Electron, synthetic talk, real writer and Undo.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium, _electron as electron } from 'playwright'
import { readSlides } from '../src/shared/insert-section.ts'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'

const root = resolve('.')
const scratch = mkdtempSync(join(tmpdir(), 'tw-structure-test-'))
const profile = join(scratch, 'profile')
const vault = join(scratch, 'vault')
const talk = join(vault, 'garden-structure')
const outline = join(talk, 'garden-structure-outline.md')
mkdirSync(profile)
mkdirSync(talk, { recursive: true })
const source = [
  '---', 'outline_version: 2', 'title: Garden structure', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '',
  '## This year {id=yr1}', '', '### Watering {id=wat1}', '', '- Measure the beds', '',
  '~~~markdown', '#### Example heading', '~~~', '', '<!--', '## Keep this comment', '-->', '',
  ':::notes', 'Keep the speaker note.', ':::', '',
  '### Dates {id=dat1}', '{carousel}', '', '#### Saturday {id=sat1}', '', '- Morning', '',
  '#### Sunday {id=sun1}', '', '- Afternoon', '',
  '### Repair {id=rep1}', '', '- Fence', '', '### Plant {id=pla1}', '', '- Seeds', '',
  '### Share {id=sha1}', '', '- Tools', '',
  '## Next season {id=nex1}', '', '### Getting involved {id=get1}', '{sub}', '',
  '#### Sign up {id=sig1}', '', '- Names', '', '#### Collect {id=col1}', '', '- Bags', '',
  '### Harvest {id=har1}', '', '- Beans', '', '### Closing notes {id=clo1}', '', '- Finish', ''
].join('\n')
const start = Buffer.from(source)
const baseline = readSlides(source).slides.map(({ id, attrs, content, notes, title }) => [id, attrs, content, notes, title])
writeFileSync(outline, start)
writeFileSync(join(profile, 'config.json'), JSON.stringify({ vaultRoot: vault }))
const env = { TW_E2E: '1' }
for (const name of ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'SHELL', 'DISPLAY']) {
  if (process.env[name] !== undefined) env[name] = process.env[name]
}

async function until(check, message) {
  const end = Date.now() + 18000
  while (Date.now() < end) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 75))
  }
  throw new Error(message)
}

let app
let captureBrowser
const shots = process.env.TW_STRUCTURE_SHOTS
async function capture(page, frame, hoveredAddLine) {
  if (!shots) return
  mkdirSync(shots, { recursive: true })
  captureBrowser ??= await chromium.launch({ headless: true })
  const { width, height, markup, styles, scroll, thumbnailUrls } = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    markup: document.documentElement.outerHTML,
    thumbnailUrls: [...new Set([...document.images].map(img => img.src).filter(src => src.startsWith('twthumb://')))],
    styles: [...document.styleSheets].flatMap(sheet => {
      try { return [...sheet.cssRules].map(rule => rule.cssText) } catch { return [] }
    }).join('\n'),
    scroll: [...document.querySelectorAll('*')].flatMap((element, index) => element.scrollTop ? [[index, element.scrollTop]] : [])
  }))
  // Electron supplies the live DOM. A separate Chromium headless shell paints the screenshot.
  const frames = await Promise.all(page.frames().filter(child => child.parentFrame() === page.mainFrame()).map(child =>
    child.content().then(html => html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')).catch(() => '')
  ))
  const thumbnails = await app.evaluate(async ({ net }, urls) => {
    const pairs = await Promise.all(urls.map(async url => {
      try {
        const res = await net.fetch(url)
        if (!res.ok) return undefined
        return [url, `data:image/png;base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}`]
      } catch { return undefined }
    }))
    return Object.fromEntries(pairs.filter(Boolean))
  }, thumbnailUrls)
  const copy = await captureBrowser.newPage({ viewport: { width, height } })
  try {
    await copy.route(/^https?:/, route => route.abort())
    await copy.setContent(markup.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ''), { waitUntil: 'domcontentloaded' })
    await copy.addStyleTag({ content: styles })
    await copy.evaluate(({ scroll, frames, thumbnails }) => {
      for (const img of document.images) {
        if (thumbnails[img.src]) img.src = thumbnails[img.src]
      }
      const elements = document.querySelectorAll('*')
      scroll.forEach(([at, y]) => { if (elements[at]) elements[at].scrollTop = y })
      document.querySelectorAll('iframe').forEach((iframe, index) => {
        iframe.removeAttribute('src')
        if (frames[index]) iframe.srcdoc = frames[index]
      })
    }, { scroll, frames, thumbnails })
    if (hoveredAddLine !== undefined) {
      const add = copy.locator('.tw-structure-panel .tw-structure-add-line').nth(hoveredAddLine)
      const trigger = add.getByRole('button', { name: 'Insert here', exact: true })
      await trigger.hover({ force: true })
      assert.equal(await trigger.evaluate(el => getComputedStyle(el, '::before').borderTopStyle), 'dotted')
      assert.equal(await add.getByRole('button', { name: 'Section', exact: true }).count(), 0)
    }
    await copy.screenshot({ path: join(shots, `${frame}.png`), animations: 'disabled' })
  } finally { await copy.close() }
}
try {
  await ensureFreshBuild(root)
  app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], cwd: root, env })
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', error => { console.error('[renderer]', error.message); errors.push(error.message) })
  page.setDefaultTimeout(15000)
  await app.evaluate(({ BrowserWindow, session }) => {
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, reply) => reply({ cancel: true }))
    for (const win of BrowserWindow.getAllWindows()) win.setContentSize(1440, 900)
  })
  assert.ok(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(win => !win.isVisible())))
  await page.locator('[data-talk-slug="garden-structure"]').first().dblclick()
  await page.locator('.workspace-view-titlebar').waitFor()
  await page.getByRole('tab', { name: 'Slides', exact: true }).click()
  const panel = page.locator('.tw-structure-panel')
  const outlineButton = page.getByRole('button', { name: 'Show slides as an outline' })
  await outlineButton.click()
  const row = title => panel.locator('[data-line]').filter({ hasText: title }).first()
  const pick = title => row(title).click()
  const toolbar = page.locator('.workspace-centre .tw-action-bar')
  const toolbarSection = () => toolbar.getByRole('button', { name: 'Section', exact: true }).click()
  const primary = process.platform === 'darwin' ? 'Meta' : 'Control'
  const sectionChord = 'Control+Meta+s'
  const subsectionChord = 'Control+Meta+Shift+s'
  const read = () => readFileSync(outline)
  await row('Watering').waitFor()
  assert.deepEqual(read(), start, 'seeing the talk leaves its file byte for byte')
  await panel.getByLabel('Current slide preview').waitFor()
  if (shots) {
    await panel.locator('.tw-structure-pinned img').waitFor()
    await page.locator('[data-option-pictures="container-mode"] .opt-pic img').first().waitFor()
  }
  await capture(page, 'LO1-outline')
  await capture(page, 'ST2-section-slide')
  if (shots) {
    const inspector = page.locator('.tw-structure-inspector')
    await inspector.getByRole('button', { name: /Colour/ }).click()
    await inspector.locator('[data-option-pictures="section-colour"] .opt-pic img').first().waitFor()
    await capture(page, 'ST3-section-colour')
    await pick('Getting involved')
    await inspector.getByRole('button', { name: /Colour/ }).click()
    await capture(page, 'ST3-subsection-colour')
    await inspector.getByRole('button', { name: 'Change colour on its section' }).click()
    await pick('Dates')
    await inspector.getByRole('button', { name: /Subslides/ }).click()
    await capture(page, 'IN6-subslides')
  }

  async function changed(label, verify, undo = 'keyboard') {
    await until(() => !read().equals(start), `${label} did not write the outline`)
    const text = read().toString()
    const actual = readSlides(text).slides.filter(slide => baseline.some(([id]) => id === slide.id))
      .map(({ id, attrs, content, notes, title }) => [id, attrs, content, notes, title])
    assert.deepEqual(actual.slice().sort(), baseline.slice().sort(), `${label}: only structure and the new heading can differ`)
    verify(text)
    if (label === 'New section after Watering') {
      await page.locator('[data-status-notice] [data-toast-action]').getByText('Undo', { exact: true }).waitFor()
      await capture(page, 'ST1-section-created')
    }
    if (undo === 'notice') {
      await page.locator('[data-status-notice] [data-toast-action]').getByText('Undo', { exact: true }).click()
    } else {
      await page.keyboard.press(`${primary}+z`)
    }
    try {
      await until(() => read().equals(start), `${label}: Undo did not restore starting bytes`)
    } catch (error) {
      const snapshot = await page.evaluate(() => {
        const editor = document.querySelector('.cm-content')?.cmTile?.root?.view
        return { document: editor?.state?.doc?.toString(), notices: document.querySelector('[data-status-notice]')?.textContent }
      })
      const disk = read().toString()
      const summary = value => value == null ? 'unavailable' : {
        equalsApplied: value === text,
        bytes: Buffer.byteLength(value),
        firstChangedLine: source.split('\n').findIndex((line, index) => line !== value.split('\n')[index]) + 1
      }
      console.error(JSON.stringify({ disk: summary(disk), editor: summary(snapshot.document), notices: snapshot.notices }))
      throw error
    }
    assert.deepEqual(read(), start, label)
    console.log(`PASS ${label}: one Undo restored ${start.length} bytes`)
  }

  const created = (text, kind) => {
    const slides = readSlides(text).slides
    const inserted = slides.find(slide => !baseline.some(([id]) => id === slide.id))
    assert.ok(inserted, kind)
    assert.equal(inserted.level, kind === 'section' ? 2 : 3)
    return { slides, inserted }
  }
  for (const [index, title] of ['Watering', 'Saturday', 'Repair', 'Sign up', 'Harvest'].entries()) {
    await pick(title)
    if (index === 0) {
      await toolbarSection()
      await capture(page, 'ST1-section-menu')
      await page.getByRole('menuitem', { name: 'New section', exact: false }).first().click()
    } else await page.keyboard.press(sectionChord)
    await changed(`New section after ${title}`, text => {
      const { slides, inserted } = created(text, 'section')
      if (title === 'Saturday') assert.ok(slides.find(slide => slide.id === 'sun1').line < inserted.line, 'the whole carousel remains before the section')
    }, index === 0 ? 'notice' : 'keyboard')
  }
  for (const [index, title] of ['This year', 'Watering', 'Repair', 'Sign up', 'Harvest'].entries()) {
    await pick(title)
    if (index === 0) {
      await panel.locator('.tw-slides-footer').getByRole('button', { name: 'Section', exact: true }).click()
      await page.getByRole('menuitem', { name: /New subsection/ }).click()
    } else await page.keyboard.press(subsectionChord)
    await changed(`New subsection after ${title}`, text => created(text, 'subsection'))
  }

  // Both editor views use the same authoring command and write the same source.
  for (const [number, name] of [[3, 'Outline'], [4, 'Markdown']]) {
    await page.keyboard.press(`${primary}+${number}`)
    await pick('Share')
    if (name === 'Outline') await capture(page, 'OU1-outline')
    await toolbarSection()
    await page.getByRole('menuitem', { name: 'New section', exact: false }).first().click()
    await changed(`New section in ${name} view`, text => created(text, 'section'))
  }

  // Selection follows the same slide IDs into Grid and groups exactly the selected siblings.
  await pick('Repair')
  await row('Plant').click({ modifiers: ['Shift'] })
  await page.keyboard.press(`${primary}+2`)
  await page.locator('[data-view="grid"] [data-selected="true"]').first().waitFor()
  await capture(page, 'GR1-several-selected')
  await panel.getByRole('button', { name: 'Make a section', exact: true }).click()
  await changed('Make a section from Repair and Plant', text => {
    const { slides, inserted } = created(text, 'subsection')
    const parent = slides.indexOf(inserted)
    assert.deepEqual(slides.filter(slide => slide.ancestors.includes(parent)).map(slide => slide.id), ['rep1', 'pla1'])
  })

  await page.keyboard.press(`${primary}+1`)
  // Drag across section levels so the writer must preserve IDs while re-levelling.
  const destination = row('Getting involved')
  const rect = await destination.boundingBox()
  assert.ok(rect)
  const transfer = await page.evaluateHandle(() => new DataTransfer())
  await row('Repair').dispatchEvent('dragstart', { dataTransfer: transfer })
  await destination.dispatchEvent('dragover', { dataTransfer: transfer, clientX: rect.x + 65, clientY: rect.y + rect.height / 2 })
  await panel.getByText('In Getting involved', { exact: true }).waitFor()
  await capture(page, 'LO2-drag-into-subsection')
  await destination.dispatchEvent('drop', { dataTransfer: transfer, clientX: rect.x + 65, clientY: rect.y + rect.height / 2 })
  await changed('Drag Repair into Getting involved', text => {
    const slides = readSlides(text).slides
    const moved = slides.find(slide => slide.id === 'rep1')
    assert.equal(moved.level, 4)
    assert.equal(slides[moved.ancestors.at(-1)].id, 'get1')
  })
  await page.getByRole('button', { name: 'Show slides as previews' }).click()
  const previewCard = title => panel.locator('.tw-slide-card').filter({ hasText: title }).first()
  const targetCard = previewCard('Repair')
  await targetCard.waitFor()
  const cardBox = await targetCard.boundingBox()
  assert.ok(cardBox)
  const previewDrag = await page.evaluateHandle(() => new DataTransfer())
  await previewCard('Plant').dispatchEvent('dragstart', { dataTransfer: previewDrag })
  const targetEvent = { dataTransfer: previewDrag, clientX: cardBox.x + 6, clientY: cardBox.y + 4 }
  await targetCard.dispatchEvent('dragover', targetEvent)
  await panel.getByText('In This year', { exact: true }).waitFor()
  await capture(page, 'LO2-drag-in-previews')
  await targetCard.dispatchEvent('drop', targetEvent)
  await changed('Drag Plant before Repair in previews', text => {
    const ids = readSlides(text).slides.map(slide => slide.id)
    assert.equal(ids[ids.indexOf('rep1') - 1], 'pla1')
  })
  await outlineButton.click()
  const carousel = row('Dates')
  assert.equal(await carousel.locator('[data-so-section-no]').count(), 0)
  assert.match(await carousel.locator('[data-so-no]').innerText(), /^\d+$/)
  await row('This year').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'New section after', exact: false }).click()
  await changed('New section after the whole This year section', text => {
    const { slides, inserted } = created(text, 'section')
    assert.equal(slides[slides.indexOf(inserted) - 1].id, 'sha1')
    assert.equal(slides[slides.indexOf(inserted) + 1].id, 'nex1')
    assert.equal(slides.some(slide => slide.ancestors.includes(slides.indexOf(inserted))), false)
  })

  // Enter leaves the divider and the next keystroke edits the child title, with its heading intact.
  const editor = page.locator('.workspace-centre .cm-content')
  const liveText = () => editor.evaluate(element => element.cmTile.root.view.state.doc.toString())
  const childTitle = /^### XDates(?: \{id=dat1\})?$/m
  for (const [number, name] of [[1, 'Slide'], [3, 'Outline'], [4, 'Markdown']]) {
    await page.keyboard.press(`${primary}+${number}`)
    await page.locator(`.workspace-centre [data-view="${name.toLowerCase()}"]`).waitFor()
    await pick('Watering')
    await toolbarSection()
    await page.getByRole('menuitem', { name: 'New section', exact: false }).first().click()
    await until(() => !read().equals(start), `${name}: the new divider did not reach disk before naming`)
    if (name === 'Slide') await editor.getByText('Section name', { exact: true }).waitFor()
    // The writer finishes before the compiled divider is selected for naming.
    await until(() => editor.evaluate(element => {
      const view = element.cmTile.root.view
      return view.hasFocus && /^##  \{id=[\w-]+\}$/.test(view.state.doc.lineAt(view.state.selection.main.head).text)
    }), `${name}: the new divider title did not take focus`)
    assert.equal(await editor.getByText('First point', { exact: true }).count(), 0, name)
    await page.keyboard.type('Money')
    const named = await liveText()
    assert.match(named, /(?:^|\n)## Money(?: \{id=|\n)/, `${name}: the typed name has a separator before its ID`)
    await page.keyboard.press('Enter')
    await until(async () => (await carousel.getAttribute('class'))?.includes('so-row--current'),
      `${name}: Enter did not select the first slide in the section`)
    assert.equal(await liveText(), named, `${name}: Enter navigates without writing into the section`)
    await page.keyboard.type('X')
    assert.match(await liveText(), childTitle, `${name}: the next key belongs inside the child slide title`)
    await until(() => childTitle.test(read().toString()), `${name}: the edited child title did not reach disk`)
    await page.keyboard.press(`${primary}+z`)
    assert.equal(await liveText(), named, `${name}: one Undo restores the child heading`)
    await page.keyboard.press(`${primary}+z`)
    await page.keyboard.press(`${primary}+z`)
    await until(() => read().equals(start), `${name}: Undo after naming did not restore the original bytes`)
    console.log(`PASS ${name}: Enter lands inside the first slide title and Undo restores ${start.length} bytes`)
  }

  if (shots) {
    await page.keyboard.press(`${primary}+1`)
    await page.getByRole('button', { name: 'Show slides as previews' }).click()
    const footer = panel.locator('.tw-slides-footer')
    for (const [width, height] of [[1000, 631], [1440, 900]]) {
      for (const scheme of ['light', 'dark']) {
        const tag = `${width}x${height}-${scheme}`
        await app.evaluate(({ BrowserWindow }, size) => {
          for (const win of BrowserWindow.getAllWindows()) win.setContentSize(...size)
        }, [width, height])
        await page.emulateMedia({ colorScheme: scheme })
        await until(() => page.evaluate(({ width, height, scheme }) =>
          innerWidth === width && innerHeight === height && document.documentElement.dataset.theme === scheme,
        { width, height, scheme }), `Window did not settle at ${tag}`)
        await previewCard('Watering').click()
        const geometry = await toolbar.evaluate(bar => {
          const box = bar.getBoundingClientRect()
          const buttons = [...bar.querySelectorAll('button')].filter(button => button.getClientRects().length)
          return buttons.every(button => button.getBoundingClientRect().left >= box.left - 1 &&
            button.getBoundingClientRect().right <= box.right + 1)
        })
        assert.ok(geometry, `toolbar buttons fit at ${tag}`)
        assert.ok(await toolbar.getByRole('button', { name: 'New slide', exact: true }).locator('svg').isVisible(), tag)
        const subslide = panel.getByRole('button', { name: 'Saturday', exact: true })
        assert.equal(await subslide.getByText('Saturday', { exact: false }).isVisible(), width >= 1200, tag)
        for (const [name, number] of [['This year', '§1'], ['Next season', '§2'], ['Getting involved', '§2.1']]) {
          const band = panel.locator('.tw-structure-section-band').getByRole('button', { name, exact: true })
          assert.equal(await band.getAttribute('title'), name, tag)
          assert.equal(await band.locator('.tw-structure-section-title').isVisible(), width >= 1200, tag)
          const mark = band.locator('.tw-structure-section-mark')
          assert.equal(await mark.isVisible(), width < 1200, tag)
          assert.equal(await mark.textContent(), number, tag)
        }
        const footerNewSlide = footer.getByRole('button', { name: 'New slide', exact: true })
        assert.ok(await footerNewSlide.locator('svg').isVisible(), tag)
        assert.equal(await footerNewSlide.getByText('New slide', { exact: true }).isVisible(), width >= 1200, tag)
        assert.ok(await footer.getByRole('button', { name: 'Section', exact: true }).locator('svg').first().isVisible(), tag)
        await capture(page, `${tag}-previews`)
        const add = panel.locator('.tw-structure-add-line').nth(1)
        const trigger = add.getByRole('button', { name: 'Insert here', exact: true })
        await trigger.hover()
        await capture(page, `${tag}-add-line`, 1)
        await trigger.click()
        const addBounds = await panel.boundingBox()
        assert.ok(addBounds)
        for (const label of ['Slide', 'Section', 'Subsection']) {
          const box = await add.getByRole('button', { name: label, exact: true }).boundingBox()
          assert.ok(box && box.x >= addBounds.x - 1 && box.x + box.width <= addBounds.x + addBounds.width + 1, `${label} fits at ${tag}`)
        }
        await capture(page, `${tag}-add-choices`)
        await previewCard('Repair').click()
        await previewCard('Plant').click({ modifiers: ['Shift'] })
        await footer.getByRole('button', { name: 'Make a section', exact: true }).waitFor()
        assert.ok(await footer.getByRole('button', { name: 'Make a section', exact: true }).locator('svg').isVisible(), tag)
        await capture(page, `${tag}-selection`)
        await footer.getByRole('button', { name: 'Done', exact: true }).click()
      }
    }
  }
  assert.deepEqual(errors, [])
} finally {
  try { await captureBrowser?.close(); await app?.close() } finally { rmSync(scratch, { recursive: true, force: true }) }
}
