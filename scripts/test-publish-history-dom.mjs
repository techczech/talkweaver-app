import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { fileURLToPath } from 'node:url'

// Feed the loopback publisher's persisted records into the real status bar, details sheet and history panel.
const tap = execFileSync(process.execPath, [
  '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--test', '--test-reporter=tap', '--test-name-pattern=^publish diagnostic:',
  fileURLToPath(new URL('./test-per-talk-publishing.mjs', import.meta.url)),
], { encoding: 'utf8', env: { ...process.env, TW_PUBLISH_DIAGNOSTIC_FIXTURES: '1' } })
const fixturePrefix = '# DIAGNOSTIC_FIXTURE '
const fixtures = tap.split('\n').filter(line => line.startsWith(fixturePrefix)).map(line => JSON.parse(line.slice(fixturePrefix.length)))
assert.equal(fixtures.length, 8)
const expectedCause = {
  'token failure': 'Check your token and its Pages permission',
  'check-missing timeout': 'Check your internet connection',
  'asset HTTP 400': 'Fixture refused.',
  'deployment POST failure': 'Send the deployment',
  'user cancel': 'You cancelled before the deployment was sent',
  'network intermediary 403': 'A network in between refused the upload',
}
const renderer = fileURLToPath(new URL('../src/renderer/src/', import.meta.url))
const bundle = await build({
  stdin: {
    contents: `
      import React, {useState} from 'react'
      import {createRoot} from 'react-dom/client'
      import Panel from './components/PublishHistoryPanel'
      import StatusBar from './components/StatusBar'
      import Sheet from './components/PublishDetailsSheet'
      import {publishProgressText} from '../../shared/publish-diagnostic'
      function Harness({fixture}) {
        const [open, setOpen] = useState(false)
        const diagnostic = fixture?.row.events.at(-1)?.diagnostic
        const published = fixture?.row.outcome === 'published'
        return <>
          <StatusBar minimal buildStatus={published ? 'done' : 'idle'} buildPath={published ? 'https://handouts.test/talk-a/' : null}
            publishIssue={diagnostic && {diagnostic, onClick: () => setOpen(true)}} />
          {fixture?.retry && <p role="status">{publishProgressText({
            ...fixture.retry, retry: {...fixture.retry.retry, at: Date.now() + fixture.retry.retry.delayMs}
          }, 0)}</p>}
          {open && <Sheet diagnostic={diagnostic} close={() => setOpen(false)} retry={() => { window.didRetryFromBadge = true; setOpen(false) }} />}
          <Panel />
        </>
      }
      const root = createRoot(document.getElementById('root'))
      window.showFixture = fixture => root.render(<Harness key={fixture?.name ?? 'empty'} fixture={fixture}/>)
      window.showFixture(null)
    `,
    resolveDir: renderer, loader: 'tsx',
  },
  bundle: true, write: false, outdir: 'out', format: 'iife', platform: 'browser', jsx: 'automatic',
  define: { 'import.meta.env': '{}' },
})
const browser = await chromium.launch({headless:true})
try {
  const page = await browser.newPage()
  await page.route('**/*', route => route.abort())
  // A secure document matches the Electron renderer's availability of randomUUID and clipboard APIs.
  await page.route('https://talkweaver.test/', route => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><div id="root"></div>',
  }))
  await page.goto('https://talkweaver.test/')
  await page.evaluate(() => {
    let rows = []
    window.tw = {
      talk: { retryHandoutPublish: async attemptId => { window.retryAttempt = attemptId; return { success: true } } },
      publish: {
        history: async () => ({ ok: true, attempts: rows }),
        checkSite: async () => ({state:'in-step',checkedAt:'2026-11-17T10:00:00Z'}),
      },
    }
    window.setRows = next => { rows = next }
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.copied = value } } })
  })
  await page.addScriptTag({content:bundle.outputFiles.find(file => file.path.endsWith('.js')).text})
  await page.getByText('No publishing attempts have been recorded on this Mac yet.').waitFor()
  await page.getByRole('button',{name:'Check this Mac against the site'}).click()
  await page.getByRole('status').filter({hasText:'This Mac and the site are in step for the last confirmed publication.'}).waitFor()
  await page.evaluate(() => { window.tw.publish.checkSite = async()=>({state:'changed',checkedAt:'2026-11-17T10:01:00Z'}) })
  await page.getByRole('button',{name:'Check this Mac against the site'}).click()
  await page.getByRole('status').filter({hasText:'The site has changed since this Mac’s last confirmed publication.'}).waitFor()
  assert.equal(await page.getByRole('button',{name:'Check this Mac against the site'}).isEnabled(),true)
  for (const fixture of fixtures) {
    await page.evaluate(fixture => {
      window.setRows([fixture.row])
      window.showFixture(fixture)
      window.copied = ''
    }, fixture)
    const published = fixture.row.outcome === 'published'
    if (published) {
      await page.getByRole('button', { name: 'Published ✓ handouts.test/talk-a/' }).waitFor()
      await page.getByText(/TalkWeaver|publish/).first().waitFor()
      const seconds = fixture.name.includes('429') ? 8 : 1
      await page.getByText(new RegExp('Cloudflare is busy, retrying in ' + seconds + ' s .*attempt 2 of 5')).waitFor()
      assert.equal(await page.getByRole('button', { name: 'Publish failed' }).count(), 0)
      assert.equal(await page.getByRole('dialog').count(), 0)
      continue
    }
    const title = fixture.row.outcome === 'cancelled' ? 'Publish cancelled' : 'Publish failed'
    assert.equal(await page.getByText('Build failed', { exact: true }).count(), 0)
    await page.getByRole('button', { name: title, exact: true }).click()
    const sheet = page.getByRole('dialog', { name: title })
    await sheet.locator('p').filter({ hasText: expectedCause[fixture.name] }).waitFor()
    await sheet.getByText('Nothing on the live site changed.', { exact: false }).waitFor()
    await sheet.getByRole('button', { name: 'Copy details' }).click()
    const copied = await page.evaluate(() => window.copied)
    assert.match(copied, /Step: .+\nResult:/u)
    assert.match(copied, /Files acknowledged: \d+ of \d+/u)
    assert.doesNotMatch(copied, /Authorization|fakeKey1234|bW9ja3BheWxvYWQ|test-outline.md/iu)
    await sheet.getByRole('button', { name: 'Try again' }).click()
    assert.equal(await page.evaluate(() => window.didRetryFromBadge), true)
    await page.locator('section[aria-label="Publishing history"] summary').filter({ hasText: title }).click()
    await page.getByRole('button', { name: 'Publish details' }).click()
    await sheet.locator('p').filter({ hasText: expectedCause[fixture.name] }).waitFor()
    await sheet.getByRole('button', { name: 'Try again' }).click()
    await page.getByText('Handout published.', { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => window.retryAttempt), fixture.row.id)
  }
  console.log('Publish history DOM: 3 history checks and 8 loopback publish outcomes, including retry and clipboard paths.')
} finally { await browser.close() }
