// ADR-0045 SK1–SK4, SP1 and CA1. Synthetic vault only, real hidden Electron and disk bytes.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { _electron as electron } from 'playwright'
import { readSlides } from '../src/shared/insert-section.ts'
import { SAMPLE_SKETCH } from '../src/shared/sketch-sample.ts'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'

const root = resolve('.')
const scratch = mkdtempSync(join(process.env.TW_SKETCH_E2E_ROOT ?? tmpdir(), 'tw-sketch-e2e-'))
console.log('[scratch]', scratch)
const profile = join(scratch, 'profile')
const documents = join(scratch, 'Documents')
const vault = join(documents, 'TalkWeaver')
const dir = join(vault, 'community-garden-update')
const outline = join(dir, 'community-garden-update-outline.md')
const size = (process.env.TW_SKETCH_E2E_SIZE ?? '1280x800').split('x').map(Number)
const colour = process.env.TW_SKETCH_E2E_COLOUR === 'dark' ? 'dark' : 'light'
const screenshots = process.env.TW_SKETCH_E2E_SCREENSHOTS
const env = { TW_E2E: '1' }
for (const name of ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'SHELL', 'DISPLAY']) {
  if (process.env[name] !== undefined) env[name] = process.env[name]
}
mkdirSync(documents)
await ensureFreshBuild(root)
const app = await electron.launch({ cwd: root, args: ['.', `--user-data-dir=${profile}`], env })
let page
async function until(check, why) {
  const end = Date.now() + 20000
  while (Date.now() < end) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(why)
}

try {
  const errors = []
  page = await app.firstWindow()
  await page.emulateMedia({ colorScheme: colour })
  page.on('pageerror', error => { errors.push(error.message); console.error('[renderer]', error) })
  page.setDefaultTimeout(15000)
  await app.evaluate(({ app, BrowserWindow, session, shell }, { documents, size }) => {
    app.setPath('documents', documents)
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, reply) => reply({ cancel: true }))
    shell.showItemInFolder = () => {}
    for (const window of BrowserWindow.getAllWindows()) window.setContentSize(size[0], size[1])
  }, { documents, size })
  assert.ok(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(window => !window.isVisible())))
  const shot = async name => {
    if (screenshots) await page.screenshot({ path: join(screenshots, `${size.join('x')}-${colour}-${name}.png`) })
  }
  const button = (name) => page.getByRole('button', { name, exact: typeof name === 'string' })
  const editor = page.getByRole('textbox', { name: 'Sketch text' })
  await page.getByLabel('Name of the talk').fill('Community Garden Update')
  await button(/Start with an outline/).click()
  await editor.waitFor()
  assert.equal(await editor.inputValue(), '')
  const start = readFileSync(outline)
  const picker = page.locator('.tw-sketch-picker')
  const pickSketch = () => page.getByRole('button', { name: /^Sketches for this talk/ }).click()
  const newSketch = async () => { await pickSketch(); await page.getByRole('menuitem', { name: 'New sketch', exact: true }).click() }
  const openSketchPath = async () => {
    await page.locator('.tw-sketch-picker[data-sketch-name$=".md"]').waitFor()
    return join(dir, 'scratchpad', await picker.getAttribute('data-sketch-name'))
  }
  assert.equal(await picker.getAttribute('data-sketch-name'), '')
  await editor.focus()
  await page.keyboard.insertText(SAMPLE_SKETCH)
  const firstSketch = await openSketchPath()
  await until(() => existsSync(firstSketch) && readFileSync(firstSketch, 'utf8') === SAMPLE_SKETCH, 'pasted sample was not saved')
  assert.equal(SAMPLE_SKETCH.split('\n').length, 21)
  assert.deepEqual(readFileSync(outline), start)
  await pickSketch()
  await page.getByRole('menuitem', { name: 'Rename this sketch' }).click()
  await page.getByRole('textbox', { name: 'Sketch name', exact: true }).fill('Members’ meeting sketch')
  await button('Save name').click()
  await page.getByRole('button', { name: 'Sketches for this talk, Members’ meeting sketch' }).waitFor()
  await editor.evaluate(el => { el.scrollTop = 0 })
  await shot('sketch')

  const prompt = async (title, withMarkers = false) => {
    await button('Copy for agent').click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('heading', { name: title }).waitFor()
    await page.waitForFunction(() => document.querySelector('[aria-label="Request for agent"]')?.value.includes('Do not edit the talk file'))
    const request = await dialog.getByLabel('Request for agent').inputValue()
    assert.match(request, /Do not edit the talk file/)
    if (withMarkers) assert.match(request, /## .*### /)
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  }
  await prompt('Copy for agent: this sketch')

  const allIds = new Set(readSlides(start.toString()).slides.map(slide => slide.id))
  const keepMissingPictureInSketch = async () => {
    const missing = page.locator('.tw-sketch-line-choice', { hasText: 'This picture is missing from the talk' })
    if (await missing.count()) await missing.getByRole('button', { name: 'Leave it in the sketch' }).click()
  }
  async function applyAndUndo({ choice, count, file, sample, decide, copySplit }) {
    await button('Break into slides').click()
    if (copySplit) {
      await page.getByRole('heading', { name: 'Three ways to break this into slides' }).waitFor()
      await shot('breakdowns')
      await prompt('Copy for agent: the breakdown', true)
    }
    if (choice === 'one') await page.locator('[data-breakdown="one"]').click()
    else await button(choice).click()
    const add = button(/^Add \d+ slides? to the talk$/)
    if (copySplit) await shot('review')
    if (decide) {
      assert.equal(await add.isDisabled(), true, 'an undecided line blocks Add')
      await page.locator('.tw-sketch-line-choice', { hasText: 'Thanks to everyone' })
        .getByRole('button', { name: 'Put it in the notes of the slide above' }).click()
    }
    await keepMissingPictureInSketch()
    assert.equal(await add.isEnabled(), true)
    assert.match(await add.textContent(), new RegExp(`Add ${count} slides?`))
    await add.click()
    await page.locator('[data-view="outline"]').waitFor()
    await until(() => !readFileSync(outline).equals(start), `${choice} did not apply`)
    assert.equal(readFileSync(file, 'utf8'), sample)
    const added = readSlides(readFileSync(outline, 'utf8')).slides
    assert.ok(added.length >= count)
    for (const { id } of added) {
      assert.ok(id)
      assert.ok(!allIds.has(id), `id ${id} was taken from a prior apply`)
      allIds.add(id)
    }
    await page.locator('[data-toast-action="success"]').filter({ hasText: 'Undo' }).click()
    await until(() => readFileSync(outline).equals(start), `Undo for ${choice} did not restore the original outline bytes`)
    assert.equal(readFileSync(file, 'utf8'), sample)
    await button('Cancel').click()
    await editor.waitFor()
    console.log(`PASS ${choice}: apply and Undo restored every talk byte and preserved every sketch byte`)
  }
  for (const [choice, count] of [[/^By main point/, 5], [/^One slide per section/, 3], [/^One idea per slide/, 8]]) {
    await applyAndUndo({ choice, count, file: firstSketch, sample: SAMPLE_SKETCH, decide: true, copySplit: count === 5 })
  }

  await newSketch()
  await page.waitForFunction(() => document.querySelector('[aria-label="Sketch text"]')?.value === '')
  const marked = SAMPLE_SKETCH.split('\n').map((line, index) => [0, 9, 18].includes(index) ? '## ' + line
    : [1, 5, 10, 14, 19].includes(index) ? '### ' + line.replace(/^- /, '') : line).join('\n')
  await editor.fill(marked)
  const markedSketch = await openSketchPath()
  assert.notEqual(markedSketch, firstSketch)
  await applyAndUndo({ choice: /^As marked/, count: 5, file: markedSketch, sample: marked })

  await newSketch()
  await page.waitForFunction(() => document.querySelector('[aria-label="Sketch text"]')?.value === '')
  const prose = 'The beans did well. We shared sixty kilos.\n\nThe slugs ate the lettuce.'
  await editor.fill(prose)
  const proseSketch = await openSketchPath()
  for (const [choice, count] of [[/^One slide per paragraph/, 2], [/^One slide per sentence/, 3], ['one', 1]]) {
    await applyAndUndo({ choice, count, file: proseSketch, sample: prose })
  }
  await pickSketch()
  await page.getByRole('menu', { name: 'Sketches for this talk' }).locator(`[data-sketch-file="${basename(firstSketch)}"]`).click()
  await page.waitForFunction(sample => document.querySelector('[aria-label="Sketch text"]')?.value === sample, SAMPLE_SKETCH)
  await button('Break into slides').click()
  await button(/^By main point/).click()
  await page.locator('.tw-sketch-line-choice', { hasText: 'Thanks to everyone' }).getByRole('button', { name: 'Leave it in the sketch' }).click()
  await keepMissingPictureInSketch()
  await button('Not yet: keep in Scratchpad').first().click()
  await button('Add 4 slides to the talk').click()
  await page.locator('[data-view="outline"]').waitFor()
  await until(() => !readFileSync(outline).equals(start), 'final apply did not reach the outline')
  const applied = readFileSync(outline)
  assert.doesNotMatch(applied.toString(), /garden-beds\.jpg/)
  assert.equal(readFileSync(firstSketch, 'utf8'), SAMPLE_SKETCH)

  await page.evaluate(() => window.dispatchEvent(new Event('tw-new-talk')))
  await page.locator('#talk-title').fill('Garden Supplies')
  await button('Create').click()
  await page.locator('.workspace-view-titlebar').getByRole('button', { name: 'Garden Supplies', exact: true }).waitFor()
  await page.getByRole('tab', { name: 'Talks', exact: true }).click()
  await page.locator('[data-talk-slug="community-garden-update"]').first().dblclick()
  await page.locator('.workspace-view-titlebar').getByRole('button', { name: 'Community Garden Update', exact: true }).waitFor()
  await button(/^Slide Scratchpad, \d+\. Expand/).click()
  await button('Dock to the right').click()
  const dock = page.locator('[data-right-column] .sp-panel--docked')
  await dock.waitFor()
  assert.equal(await page.getByRole('tab', { name: 'Scratchpad', exact: true }).getAttribute('aria-selected'), 'true')
  const dockCards = dock.locator('.sp-card')
  await dockCards.nth(1).waitFor()
  const firstCard = await dockCards.nth(0).boundingBox()
  const secondCard = await dockCards.nth(1).boundingBox()
  assert.ok(firstCard && secondCard && secondCard.x > firstCard.x && Math.abs(firstCard.y - secondCard.y) < 2,
    'the first two docked cards share a row')
  await shot('docked-all')
  await dock.getByRole('tab', { name: /^Proposed slides/ }).click()
  await dock.getByRole('button', { name: 'What we grew', exact: true }).click()
  const card = await dock.locator('.sp-card').first().boundingBox()
  const list = await dock.locator('.sp-main').boundingBox()
  assert.ok(card && list && card.y >= list.y - 1 && card.y + card.height <= list.y + list.height + 1,
    `a whole card must fit with a selection, card ${JSON.stringify(card)}, list ${JSON.stringify(list)}`)
  await shot('docked')
  await dock.getByRole('button', { name: 'Compare with this slide' }).click()
  await dock.getByText('In the talk now', { exact: true }).waitFor()
  assert.doesNotMatch(await dock.locator('.sp-compare').innerText(), /:::notes|:::/)
  await shot('compare')
  await dock.getByRole('button', { name: '← Back to the list' }).click()
  await dock.getByRole('button', { name: 'What we grew', exact: true }).click()
  await prompt('Copy for agent: this Scratchpad item')
  await dock.getByRole('button', { name: 'Keep for library' }).click()
  await dock.getByRole('tab', { name: /^Kept/ }).click()
  await dock.getByRole('button', { name: 'What we grew', exact: true }).waitFor()
  await dock.getByRole('tab', { name: /^Sketches/ }).click()
  await dock.getByLabel('Search the Slide Scratchpad').fill('August')
  const originalSketchCard = dock.locator(`.sp-card[data-sketch-file="${basename(firstSketch)}"]`)
  await originalSketchCard.click()
  await dock.getByRole('button', { name: 'Open sketch', exact: true }).click()
  await page.getByText(/This sketch was broken into slides on/).waitFor()
  assert.equal(await editor.inputValue(), SAMPLE_SKETCH)
  assert.equal(readFileSync(firstSketch, 'utf8'), SAMPLE_SKETCH)
  assert.deepEqual(readFileSync(outline), applied)
  assert.deepEqual(errors, [])
  console.log('PASS Apply → switch talk → reopen. The original sketch and applied talk bytes survived; proposals, search, dock, Compare, Keep and scoped Copy were reachable.')
} catch (error) {
  if (existsSync(outline)) console.error('[outline at failure]', readFileSync(outline, 'utf8').slice(0, 4000))
  if (page) console.error('[workspace at failure]', (await page.locator('.workspace').first().innerText().catch(() => '')).slice(-3600))
  throw error
} finally {
  await app.close()
}
