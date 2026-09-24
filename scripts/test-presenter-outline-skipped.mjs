import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { _electron as electron } from 'playwright'
import { ensureFreshBuild } from '../e2e/lib/ensure-fresh-build.mjs'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'

const scratch = await mkdtemp(join(tmpdir(), 'talkweaver-outline-skipped-'))
const source = ['---', 'title: Outline skipped filter', 'auto_title_slide: false', 'auto_thanks_slide: false', '---',
  ...Array.from({ length: 8 }, (_, i) => `\n### Slide ${i + 1} {id=slide-${i + 1}}\n\nText ${i + 1}.`)].join('\n')
const sourcePath = join(scratch, 'outline-skipped.md')
await writeFile(sourcePath, source)
const model = await prepareSource(sourcePath, source, 'outline-skipped', statSync(sourcePath))
const htmlPath = join(scratch, 'outline-skipped.html')
await writeFile(htmlPath, model.fullHtml)
const repo = fileURLToPath(new URL('..', import.meta.url))
await ensureFreshBuild(repo)
const app = await electron.launch({ args: ['.', '--user-data-dir=' + join(scratch, 'user-data')], cwd: repo, env: { ...process.env, TW_E2E: '1' } })
try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`${pathToFileURL(htmlPath).href}?presenter=1&session=outline-skipped`)
  const drawer = page.locator('#presenterOutlineDrawer')
  const list = page.locator('#presenterOutline')
  const rows = list.locator('.slide-link')
  const filter = page.locator('#presenterSkippedOnly')
  const search = page.locator('#presenterSearch')
  const count = page.locator('#presenterCount')
  const empty = list.locator('.tw-overview-empty')
  async function assertSlides(numbers) {
    assert.deepEqual(await rows.locator('.slide-link-title > span:last-child').allTextContents(),
      numbers.map((number) => `${number}. Slide ${number}`))
  }
  async function assertEmpty(message) {
    assert.equal(await rows.count(), 0)
    assert.equal(await empty.innerText(), message)
    const before = await count.innerText()
    await search.press('ArrowDown')
    await search.press('ArrowUp')
    await search.press('Enter')
    assert.equal(await count.innerText(), before, 'empty filtered navigation leaves the slide unchanged')
    assert.match(await drawer.getAttribute('class'), /\bopen\b/, 'empty Enter keeps the outline open')
  }
  await page.locator('#outlineBtn').click()
  assert.equal(await filter.count(), 1, 'presenter outline offers a Skipped only checkbox')
  assert.equal(await page.getByRole('checkbox', { name: 'Skipped only', exact: true }).count(), 1)
  assert.equal(await filter.isChecked(), false, 'full outline is the default')
  await assertSlides([1, 2, 3, 4, 5, 6, 7, 8])
  await filter.focus()
  await filter.press('Space')
  assert.equal(await filter.isChecked(), true, 'checkbox supports keyboard activation')
  assert.equal(await count.innerText(), '1 / 8', 'Space on the checkbox does not advance the deck')
  await assertEmpty('No skipped slides')
  console.log('PASS default full list, keyboard filter toggle and empty-state no-op navigation')

  await page.locator('#skipNextBtn').click()
  assert.equal(await count.innerText(), '3 / 8')
  await assertSlides([2])
  assert.equal(await rows.first().getAttribute('title'), 'skipped (explicit)')
  await page.locator('#presenterLast').click()
  await page.locator('#presenterFirst').click()
  await assertSlides([2, 4, 5, 6, 7])
  assert.equal(await rows.nth(1).getAttribute('title'), 'skipped (jumped)')
  assert.equal(await list.locator('.current').count(), 0, 'shown current slide stays outside the skipped results')
  assert.equal(await list.locator('.tw-skipped').count(), 5)
  if (process.env.TW_OUTLINE_SCREENSHOT) {
    await page.setViewportSize({ width: 900, height: 700 })
    await page.screenshot({ path: process.env.TW_OUTLINE_SCREENSHOT })
    await page.setViewportSize({ width: 1280, height: 900 })
  }
  console.log('PASS explicit skip and jumped gaps appear together, excluding shown and unseen slides')

  await search.press('Escape')
  await page.locator('#outlineBtn').click()
  assert.equal(await filter.isChecked(), true, 'closing and reopening retains the filter')
  await assertSlides([2, 4, 5, 6, 7])
  await search.fill('Slide 5')
  await assertSlides([5])
  await page.locator('#presenterOutlineExpand').click()
  assert.match(await list.getAttribute('class'), /\btw-overview-grid\b/)
  await assertSlides([5])
  assert.equal(await list.locator('.tw-thumb').count(), 1)
  await search.fill('Slide 3')
  await assertEmpty('No skipped slides match your search')
  await search.fill('Slide 5')
  await search.press('Enter')
  assert.equal(await count.innerText(), '5 / 8', 'Enter visits the matching skipped slide')
  assert.doesNotMatch(await drawer.getAttribute('class'), /\bopen\b/)
  await page.locator('#outlineBtn').click()
  await assertEmpty('No skipped slides match your search')
  await search.fill('')
  await assertSlides([2, 4, 6, 7])
  console.log('PASS retained filter combines with search and previews; visiting a result removes it')

  await filter.uncheck()
  await assertSlides([1, 2, 3, 4, 5, 6, 7, 8])
  assert.match(await list.locator('.current.tw-highlight').innerText(), /Slide 5$/)
  await page.locator('#presenterLast').click()
  assert.match(await list.locator('.current.tw-highlight').innerText(), /Slide 8$/)
  await page.locator('#presenterOutlineExpand').click()
  assert.match(await list.locator('.current.tw-highlight').innerText(), /Slide 8$/)
  console.log('PASS returning to the full outline resumes current-slide tracking in grid and list views')
} finally {
  await app.close()
  await rm(scratch, { recursive: true, force: true })
}
