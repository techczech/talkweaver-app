import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'

const root = process.cwd()
const scratch = mkdtempSync(join(tmpdir(), 'tw-venue-publish-'))
const userData = join(scratch, 'userData')
const vault = join(scratch, 'vault')
const slug = 'venue-publish-probe'
const talkDir = join(vault, slug)
const runDir = join(vault, '_PRESENTATIONS', slug)
mkdirSync(userData, { recursive: true })
mkdirSync(talkDir, { recursive: true })
mkdirSync(runDir, { recursive: true })
writeFileSync(join(talkDir, `${slug}-outline.md`), [
  '---', 'title: Venue publish probe', 'outline_version: 2', 'handout_url: https://handouts.fyi/k7m2', '---', '',
  '### Title', '{id=title}', '', 'Venue publish probe.', '',
  '### Content', '{id=content}', '', 'Follow this slide.',
].join('\n'))
writeFileSync(join(runDir, 'run-venue.json'), JSON.stringify({
  id: 'run-venue', talkSlug: slug, talkTitle: 'Venue publish probe', kind: 'delivery', status: 'delivered',
  eventTitle: 'Venue event', slideSet: { kind: 'full' }, startedAt: '2026-09-24T09:00:00.000Z',
  endedAt: '2026-09-24T10:00:00.000Z',
}))
writeFileSync(join(userData, 'config.json'), JSON.stringify({
  vaultRoot: vault, cfPagesProject: 'talkweaver-test', publishBaseUrl: 'https://handouts.fyi',
  publishUseShortIds: true, liveWorkerBaseUrl: 'https://live.example.test',
}))

let app
try {
  await ensureFreshBuild(root)
  app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`], cwd: root,
    env: { ...process.env, TW_E2E: '1', TW_REC_TEST: '1' },
  })
  const editor = await app.firstWindow()
  await editor.waitForLoadState('domcontentloaded')
  await editor.getByText('Venue publish probe', { exact: true }).first().click()
  await editor.waitForSelector('.workspace')
  await editor.evaluate(() => {
    window.__copiedVenueLink = ''
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (text) => { window.__copiedVenueLink = text },
    } })
  })
  await editor.keyboard.press('Meta+Shift+P')
  await editor.getByRole('dialog', { name: 'Command palette' }).getByRole('option', { name: 'Copy venue-screen link' }).click()
  await editor.waitForFunction(() => window.__copiedVenueLink === 'https://handouts.fyi/k7m2/p')
  const result = await editor.evaluate(async ({ slug }) => window.tw.history.publishRunHandout(slug, 'run-venue'), { slug })
  assert.equal(result.success, true, result.error)
  const site = join(userData, 'cloudflare-pages-site')
  const registry = JSON.parse(readFileSync(join(userData, 'handout-registry.json'), 'utf8'))
  const publishedSlug = Object.keys(registry)[0]
  const id = registry[publishedSlug]
  assert.equal(result.url, `https://handouts.fyi/${id}`)
  const venuePath = join(site, publishedSlug, 'p', 'index.html')
  assert.equal(existsSync(venuePath), true)
  assert.match(readFileSync(venuePath, 'utf8'), /Click anywhere for full screen/)
  assert.match(readFileSync(join(site, '_redirects'), 'utf8'), new RegExp(`/${id}/p  /${publishedSlug}/p/  302`))
  assert.match(readFileSync(join(site, '404.html'), 'utf8'), /This talk isn’t available/)
  const removed = await editor.evaluate(async ({ slug }) => window.tw.history.unpublishRunHandout(slug, 'run-venue'), { slug })
  assert.equal(removed.success, true, removed.error)
  assert.equal(existsSync(venuePath), false)
  console.log('venue publish: run page, short redirect, unavailable page and unpublish passed')
} finally {
  await app?.close()
  rmSync(scratch, { recursive: true, force: true })
}
