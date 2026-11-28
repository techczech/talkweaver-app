// Run against the checkout's Electron build, with real files and two disposable vaults.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { closeApp, hardLimit, launch, REPO, tempDir } from '../scripts/journeys/lib.mjs'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'

hardLimit(120000, 'vault-explorer')
const root = tempDir('tw-vault-explorer-')
const userData = join(root, 'profile')
const vaults = [
  { id: 'field', root: join(root, 'Field studies'), open: true, order: 0 },
  { id: 'school', root: join(root, 'School talks'), open: true, order: 1 }
]
const writeTalk = (vault, category, slug, title, text) => {
  const dir = join(vault.root, category, slug)
  mkdirSync(dir, { recursive: true })
  const opening = slug === 'pond-survey' ? 'A quiet pond introduction.' : 'A quiet opening.'
  writeFileSync(join(dir, slug + '-outline.md'),
    `---\noutline_version: 2\ntitle: ${title}\n---\n\n## First slide\n\n${opening}\n\n## Target slide\n\n${text}\n`)
}
writeTalk(vaults[0], 'Workshops/Field notes', 'pond-survey', 'The pond survey', 'See the amphibian transect.')
writeTalk(vaults[0], 'Workshops', 'opening', 'Fieldwork opening', 'Bring a notebook.')
writeTalk(vaults[1], 'Teaching', 'volunteer-briefing', 'Volunteer briefing', 'Bring your binoculars.')
mkdirSync(userData)
writeFileSync(join(userData, 'config.json'), JSON.stringify({
  vaults, vaultRoot: vaults[0].root, vaultRootMirrored: vaults[0].root
}))

await ensureFreshBuild(REPO)
const { app, main: page } = await launch(userData, { fakeMedia: false })
try {
  page.setDefaultTimeout(15000)
  const start = page.getByRole('region', { name: 'Vault Explorer' })
  await start.getByRole('heading', { name: 'Start a new talk' }).waitFor()
  await start.getByRole('button', { name: /^Workshops, 2 talks/ }).click()
  await start.getByRole('button', { name: /^Field notes, 1 talk/ }).click()
  await start.getByRole('button', { name: 'The pond survey', exact: true }).click()
  await page.getByTitle('Talk menu', { exact: true }).getByText('The pond survey', { exact: true }).waitFor()
  console.log('PASS browse through two folder cards and open the real talk')

  await page.getByRole('button', { name: 'Vault Explorer', exact: true }).click()
  const explorer = page.getByRole('dialog', { name: 'Vault Explorer' })
  const search = explorer.getByRole('combobox', { name: 'Search talks' })
  const talkMenu = page.getByTitle('Talk menu', { exact: true })
  const slideCrumb = page.locator('[data-view="slide"] .workspace-slide-crumb strong')
  const openSlideHit = async (hit, key) => {
    await hit.waitFor()
    const label = await hit.getAttribute('aria-label')
    const number = label?.match(/Slide (\d+):/)?.[1]
    assert.ok(number, 'the indexed hit names its slide position')
    await search.press(key)
    await explorer.waitFor({ state: 'hidden' })
    await talkMenu.getByText('The pond survey', { exact: true }).waitFor()
    await slideCrumb.filter({ hasText: new RegExp('^Slide ' + number + ' of ') }).waitFor()
  }
  await search.fill('volunteer briefing')
  await explorer.getByRole('button', { name: 'Volunteer briefing', exact: true }).waitFor()
  assert.match(await explorer.getByRole('group', { name: 'Search results' }).innerText(), /School talks.*Teaching/s)
  await search.press('Enter')
  await explorer.waitFor({ state: 'hidden' })
  await talkMenu.getByText('Volunteer briefing', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Vault Explorer', exact: true }).click()
  await explorer.getByRole('button', { name: 'Slide content', exact: true }).click()
  await search.fill('amphibian transect')
  await openSlideHit(explorer.getByRole('button', { name: /The pond survey.*Target slide/ }), 'Enter')
  console.log('PASS title search, indexed slide-content search, and Enter jumps to the matching slide')

  await page.getByRole('button', { name: 'Vault Explorer', exact: true }).click()
  await search.fill('quiet pond introduction')
  await openSlideHit(explorer.getByRole('button', { name: /The pond survey.*First slide/ }), 'ControlOrMeta+Enter')
  console.log('PASS opening a slide hit for the current talk brings its editor to that slide')

  await page.getByRole('button', { name: 'Vault Explorer', exact: true }).click()
  await explorer.getByRole('button', { name: 'New talk', exact: true }).click()
  await explorer.getByRole('button', { name: 'Change save location' }).click()
  await explorer.getByRole('button', { name: 'School talks', exact: true }).click()
  await explorer.getByRole('button', { name: 'Change save location' }).click()
  await explorer.getByRole('button', { name: 'Teaching', exact: true }).click()
  await explorer.getByRole('textbox', { name: 'Name of the talk' }).fill('Migration patterns')
  await explorer.getByRole('button', { name: /^Start with a slide/ }).click()
  const created = join(vaults[1].root, 'Teaching', 'migration-patterns', 'migration-patterns-outline.md')
  await page.getByTitle('Talk menu', { exact: true }).getByText('Migration patterns', { exact: true }).waitFor()
  assert.match(readFileSync(created, 'utf8'), /Migration patterns/)
  assert.equal(existsSync(join(vaults[0].root, 'migration-patterns')), false)
  console.log('PASS create through the save-location picker and verify the destination on disk')
} catch (error) {
  const state = await page.evaluate(() => ({
    talk: document.querySelector('[title="Talk menu"]')?.textContent,
    explorerOpen: !!document.querySelector('[role="dialog"][aria-label="Vault Explorer"]'),
    slide: document.querySelector('[data-view="slide"] .workspace-slide-crumb strong')?.textContent,
    selectedCard: document.querySelector('.tw-slide-card[data-active="true"]')?.getAttribute('title'),
    alerts: [...document.querySelectorAll('[role="alert"]')].map(node => node.textContent)
  })).catch(() => null)
  console.error('Electron workspace after failure:', JSON.stringify(state))
  throw error
} finally {
  await closeApp(app)
}
