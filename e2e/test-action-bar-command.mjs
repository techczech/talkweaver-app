import { strict as assert } from 'node:assert'
import { _electron as electron } from 'playwright'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { openTalkByTitle } from './lib/talklist.mjs'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const repo = resolve(import.meta.dirname, '..')
const root = mkdtempSync(join(tmpdir(), 'tw-action-bar-'))
const vault = join(root, 'vault')
const userData = join(root, 'userData')
const talk = join(vault, 'action-bar-fixture')
mkdirSync(talk, { recursive: true })
mkdirSync(userData, { recursive: true })
writeFileSync(join(talk, 'action-bar-fixture-outline.md'), '---\ntitle: Action Bar Fixture\n---\n\n## Slide\n\nAlpha\n')
writeFileSync(join(userData, 'config.json'), JSON.stringify({ vaultRoot: vault }))
await ensureFreshBuild(repo)
const app = await electron.launch({ args: ['.', '--user-data-dir=' + userData], cwd: repo, env: { ...process.env, TW_E2E: '1' } })
try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await openTalkByTitle(page, 'Action Bar Fixture')
  const line = page.locator('.cm-content .cm-line', { hasText: 'Alpha' }).first()
  await line.click()
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('cm-content')), true, 'outline editor has focus')
  async function pressBar(id) {
    const direct = page.locator(`.tw-action-bar-btn[data-command="${id}"]`)
    if (await direct.count()) await direct.click()
    else {
      await page.locator('.tw-action-bar-btn[aria-label="More actions"]').click()
      await page.locator(`.tw-action-bar-menu-item[data-command="${id}"]`).click()
    }
  }
  await pressBar('bulleted-list')
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('cm-content')), true, 'bar press preserves editor focus')
  assert.equal(await page.locator('.cm-content').innerText().then((text) => text.includes('- Alpha')), true, 'registered Bulleted list command changed the outline')
  await pressBar('undo')
  const content = await page.locator('.cm-content').innerText()
  assert(content.includes('Alpha') && !content.includes('- Alpha'), 'registered Undo command restores the outline')
  console.log('action bar command path: bullet then undo passed')
} finally {
  await app.close()
}
