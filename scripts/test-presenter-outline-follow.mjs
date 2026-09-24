import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { _electron as electron } from 'playwright'
import { ensureFreshBuild } from '../e2e/lib/ensure-fresh-build.mjs'
import { fileURLToPath } from 'node:url'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'

const scratch = await mkdtemp(join(tmpdir(), 'talkweaver-outline-follow-'))
const source = ['---', 'title: Outline follow', 'auto_title_slide: false', 'auto_thanks_slide: false', '---',
  ...Array.from({ length: 45 }, (_, i) => `\n### Slide ${i + 1} {id=slide-${i + 1}}\n\nText ${i + 1}.`)].join('\n')
const sourcePath = join(scratch, 'outline-follow.md')
await writeFile(sourcePath, source)
const model = await prepareSource(sourcePath, source, 'outline-follow', statSync(sourcePath))
const htmlPath = join(scratch, 'outline-follow.html')
await writeFile(htmlPath, model.fullHtml)
const repo = fileURLToPath(new URL('..', import.meta.url))
await ensureFreshBuild(repo)
const app = await electron.launch({ args: ['.', '--user-data-dir=' + join(scratch, 'user-data')], cwd: repo, env: { ...process.env, TW_E2E: '1' } })
try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.goto(`${pathToFileURL(htmlPath).href}?presenter=1&session=outline-follow`)
  const current = page.locator('#presenterOutline .current')
  const highlighted = page.locator('#presenterOutline .tw-highlight')
  const search = page.locator('#presenterSearch')
  async function assertFollowing(title) {
    assert.match(await current.innerText(), new RegExp(`${title}$`))
    assert.equal(await highlighted.innerText(), await current.innerText(), 'keyboard selection follows current slide')
    await page.waitForFunction(() => {
      const list = document.querySelector('#presenterOutline').getBoundingClientRect()
      const row = document.querySelector('#presenterOutline .current').getBoundingClientRect()
      return row.top >= list.top - 1 && row.bottom <= list.bottom + 1
    }, undefined, { timeout: 3000 })
  }
  await page.locator('#presenterLast').click()
  await page.locator('#outlineBtn').click()
  await assertFollowing('Slide 45')
  console.log('PASS opening a long outline reveals and selects the current slide')
  await page.locator('#presenterFirst').click()
  await assertFollowing('Slide 1')
  await page.locator('#presenterLast').click()
  await assertFollowing('Slide 45')
  console.log('PASS open outline follows forward and backward presentation jumps')
  await search.press('ArrowUp')
  assert.match(await highlighted.innerText(), /Slide 44$/)
  await page.locator('#presenterOutlineExpand').click()
  assert.match(await highlighted.innerText(), /Slide 44$/, 'preview toggle preserves manual selection')
  await page.locator('#presenterOutlineExpand').click()
  await search.fill('Slide 12')
  assert.match(await highlighted.innerText(), /Slide 12$/)
  await page.locator('#presenterFirst').click()
  assert.match(await highlighted.innerText(), /Slide 12$/, 'live navigation preserves filtered search selection')
  await search.fill('')
  await assertFollowing('Slide 1')
  console.log('PASS manual selection and search remain usable; clearing search resumes following')
  await search.press('Escape')
  await page.locator('#presenterLast').click()
  await page.locator('#outlineBtn').click()
  await assertFollowing('Slide 45')
  await page.locator('#presenterOutlineExpand').click()
  await assertFollowing('Slide 45')
  console.log('PASS reopening and switching to thumbnail previews retain the current position')
} finally {
  await app.close()
  await rm(scratch, { recursive: true, force: true })
}
