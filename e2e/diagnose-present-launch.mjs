import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { _electron as electron } from 'playwright'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { openTalkByTitle } from './lib/talklist.mjs'

const repo = process.cwd()
await ensureFreshBuild(repo)
const scratch = mkdtempSync(join(tmpdir(), 'tw-present-launch-'))
const vault = join(scratch, 'vault')
const userData = join(scratch, 'userData')
const title = 'Present launch fixture'
const outline = join(vault, 'present-launch', 'present-launch-outline.md')
mkdirSync(dirname(outline), { recursive: true })
mkdirSync(userData)
writeFileSync(join(userData, 'config.json'), JSON.stringify({ vaultRoot: vault }))
writeFileSync(outline, [
  '---', 'outline_version: 2', 'title: ' + title,
  'auto_title_slide: false', 'auto_thanks_slide: false', '---', '',
  '## Launch slides', '{id=launch-section}', '',
  '### Launch first', '{id=launch-first}', '', '- First slide text', '',
  '### Launch middle', '{id=launch-middle}', '', '- Middle slide text', '',
  '### Launch last', '{id=launch-last}', '', '- Last slide text', ''
].join('\n'))

let app
const role = page => {
  const url = new URL(page.url())
  if (url.searchParams.has('presenter')) return 'presenter'
  if (url.searchParams.has('audience')) return 'audience'
  return 'single'
}
const decks = () => app.windows().filter(page => !page.isClosed() && new URL(page.url()).pathname.endsWith('-present.html'))
async function until(condition, description) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (await condition()) return
    await delay(100)
  }
  assert.fail(description + ' (open decks: ' + decks().map(page => page.url()).join(', ') + ')')
}
const activeSlide = (page, id) => page.locator('.slide.active[data-id="' + id + '"]')

try {
  const env = { ...process.env, TW_E2E: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: ['.', '--user-data-dir=' + userData, '--use-mock-keychain'], cwd: repo, env, timeout: 60_000 })
  const editor = await app.firstWindow()
  editor.setDefaultTimeout(30_000)
  await openTalkByTitle(editor, title)
  const titleBar = editor.locator('.workspace-view-titlebar')
  await titleBar.getByRole('button', { name: 'Grid', exact: true }).click()
  const middle = editor.locator('.grid-cell').filter({ hasText: 'Launch middle' })
  await middle.click()
  await editor.locator('.grid-cell[data-active="true"]').filter({ hasText: 'Launch middle' }).waitFor()

  await titleBar.getByRole('button', { name: 'Present', exact: true }).click()
  await until(() => decks().map(role).sort().join(',') === 'audience,presenter', 'Present should open one presenter and one audience window')
  const presenter = decks().find(page => role(page) === 'presenter')
  const audience = decks().find(page => role(page) === 'audience')
  for (const page of [presenter, audience]) await activeSlide(page, 'launch-middle').waitFor({ state: 'attached' })
  const session = page => new URL(page.url()).searchParams.get('session')
  assert.ok(session(presenter))
  assert.equal(session(presenter), session(audience))
  for (const control of ['#twClockBtn', '#presenterNotes', '#nextPreview']) {
    await presenter.locator(control).waitFor({ state: 'visible' })
  }
  assert.equal(await audience.locator('#presenterNotes').isVisible(), false)
  await presenter.keyboard.press('ArrowRight')
  for (const page of [presenter, audience]) await activeSlide(page, 'launch-last').waitFor({ state: 'attached' })
  console.log('PASS Present opens the paired presenter and audience on the current slide. Audience follows the presenter.')

  const choosePresent = async name => {
    await titleBar.getByRole('button', { name: 'Other ways to present', exact: true }).click()
    await titleBar.getByRole('menuitem', { name }).click()
  }
  await choosePresent(/^Presenter view from the start\b/)
  await until(() => audience.isClosed() && decks().map(role).sort().join(',') === 'audience,presenter',
    'Starting over should reuse the presenter and replace its old audience')
  const restartedAudience = decks().find(page => role(page) === 'audience')
  // The compiled deck begins with the section divider, before the first content slide.
  for (const page of [presenter, restartedAudience]) {
    await activeSlide(page, 'launch-section').waitFor({ state: 'attached' })
  }
  assert.equal(session(presenter), session(restartedAudience))
  await presenter.close()
  await until(() => decks().length === 0, 'The audience should close with its presenter')
  console.log('PASS From the start reuses the presenter, replaces the paired audience and starts both at the beginning.')

  await choosePresent(/^Present in single screen from this slide$/)
  await until(() => decks().map(role).join(',') === 'single', 'Single-screen mode should open one plain presentation')
  const single = decks()[0]
  await activeSlide(single, 'launch-middle').waitFor({ state: 'attached' })
  assert.deepEqual(decks().map(role), ['single'])
  assert.equal(await single.locator('#presenterNotes').isVisible(), false)
  console.log('PASS Present in single screen opens only the plain presentation on the current slide.')
  console.log('Physical displays in this hidden run: ' + await app.evaluate(({ screen }) => screen.getAllDisplays().length))
} finally {
  await app?.close()
  rmSync(scratch, { recursive: true, force: true })
}
