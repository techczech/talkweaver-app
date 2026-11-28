// Settings and Tools fixtures use the real renderer and a synthetic preload.
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const root = resolve(import.meta.dirname, '..')
const dir = await mkdtemp(join(tmpdir(), 'tw-final-check-polish-'))
let browser
try {
  await build({
    stdin: {
      contents: `
import React from 'react'
import { createRoot } from 'react-dom/client'
import { emptyState } from '@app-patterns/settings'
import { schema } from './src/shared/settings-schema.ts'
import ShareSheet from './src/renderer/src/components/ShareSheet.tsx'
import Studio from './src/renderer/src/components/Studio.tsx'
import { RunsView } from './src/renderer/src/components/RunsView.tsx'
import { ToolsPalette } from './src/renderer/src/components/ToolsPalette.tsx'
import './src/renderer/src/styles.css'
const noop = () => {}
const off = () => noop
const talk = { slug: 'allotment', title: 'Allotment society update', outlinePath: '/fixture/allotment.md' }
const run = { ...talk, runId: 'fixture-run', talkSlug: talk.slug, talkTitle: talk.title, vaultId: 'fixture',
  status: 'delivered', kind: 'delivery', startedAt: '2026-11-20T12:00:00Z' }
window.tw = {
  app: { onRunCommand: off },
  alignment: { models: async () => [], onModels: off, status: async () => null, onState: off },
  history: {
    listRuns: async () => [],
    talkHandouts: async () => ({}),
    preworkFeeds: async () => ({ ok: false })
  },
  liveService: { onStatus: off, status: async () => null },
  recording: { listRecovery: async () => [], listAllSessions: async () => [{
    ...run, id: run.runId, recordingMs: 1000, wallClockMs: 1000, audio: { mime: 'audio/wav' },
    slideTimeIndex: [{ event: 'enter', slideId: 'deck-title', tMs: 0 }], trims: []
  }] },
  replay: { build: async () => ({ success: false }) },
  sessions: {
    list: async () => ({ runs: [run], live: [] }),
    runFiles: async () => ({ ok: true }),
    runAnswers: async () => ({ ok: false }),
    extraSlides: async () => ({ ok: false })
  },
  settings: {
    nativeSpeechInventory: async () => ({ available: true, installed: ['en_GB', 'en_US', 'cs_CZ'],
      supported: ['en_GB', 'en_US', 'cs_CZ', 'fr_FR', 'de_DE'], dictationInstalled: ['en-GB'] }),
    transcriptionStatus: async () => ({ state: 'not-set-up' })
  },
  sharedTalk: {
    onChanged: off, inspect: async () => ({ share: null, foreignShareUrl: null }),
    share: async () => ({ success: false, error: 'Going live is not set up: Settings → Cloudflare', setup: 'open-settings' })
  },
  transcript: { get: async () => null, attempt: async () => null, onProgress: off },
  vault: { listTalks: async () => [], onTalkMetaUpdated: off }
}
const view = location.hash.slice(1)
if (view === 'settings') {
  window.bridleSettings = {
    view: async () => ({ state: emptyState(schema.app), slots: [], appInfo: { name: 'TalkWeaver', version: '0.45.3' } }),
    onChanged: off, onSection: off
  }
  void import('./src/renderer/src/settings-main.tsx')
} else {
  const root = createRoot(document.getElementById('root'))
  root.render(view === 'share' ? <ShareSheet talk={talk} title={talk.title} onClose={noop} />
    : view === 'studio' ? <Studio isOpen onClose={noop} />
    : <><RunsView run={run} onSelect={noop} planPending={false} onPlanHandled={noop} resultsRequest={0}
        onOpenStudio={noop} onOpenNotes={noop} onShowWorkFile={noop} /><ToolsPalette active /></>)
}
`,
      sourcefile: 'final-check-polish.tsx', loader: 'tsx', resolveDir: root
    },
    bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
    loader: { '.svg': 'dataurl', '.woff2': 'empty', '.woff': 'empty' },
    define: { __TW_SECURITY_TEST__: 'false', 'import.meta.env.DEV': 'false' },
    outfile: join(dir, 'fixture.js')
  })
  const file = join(dir, 'fixture.html')
  await writeFile(file, '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>')
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page.setDefaultTimeout(6000)
  const errors = []
  page.on('pageerror', error => { errors.push(error.message); console.error(error) })
  const open = async view => {
    await page.goto('about:blank')
    await page.goto(pathToFileURL(file).href + '#' + view)
  }

  await open('share')
  const share = page.getByTestId('share-sheet')
  const setup = share.getByTestId('share-live-setup')
  await setup.getByText('Sharing needs going live to be set up.', { exact: true }).waitFor()
  assert.equal(await setup.count(), 1)
  assert.equal(await share.getByTestId('share-status').count(), 0)
  assert.equal(await setup.getByRole('button', { name: 'Open Settings' }).count(), 1)
  const copy = share.getByRole('button', { name: 'Copy link' })
  assert(await copy.isDisabled())
  assert.equal(await copy.getAttribute('title'), 'There is no link until sharing is set up')
  console.log('W3: one sharing setup message and a reason the link cannot be copied')

  await open('studio')
  await page.getByText('This slide has changed since the recording. The recording still plays.', { exact: true }).waitFor()
  assert.equal(await page.locator('.tws-sid').count(), 0)
  console.log('W2: Studio gives the missing slide message without an id')

  await open('runs')
  const runName = 'Allotment society update'
  const row = page.locator('[data-sessions-row="allotment/fixture-run"]')
  await row.waitFor()
  assert.equal(await row.locator('.nm').innerText(), runName)
  assert.doesNotMatch(await row.innerText(), /\ballotment\b(?! society update)/i)
  assert.equal(await row.getByText(runName, { exact: true }).count(), 1)
  await page.locator('[data-sessions-detail]').getByRole('heading', { name: runName, exact: true }).waitFor()
  assert.equal(await page.locator('[data-sessions-detail] .sub').getByText(runName, { exact: true }).count(), 0)
  console.log('W4: the Run shows the talk title once in the row and once on its page')

  await page.keyboard.press('ControlOrMeta+Shift+P')
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await palette.waitFor()
  assert(await palette.locator('[data-task-group]').count() > 0)
  assert.equal(await palette.getByText('0 commands', { exact: true }).count(), 0)
  console.log('L5: the Tools palette only offers groups with commands')

  await open('settings')
  const nav = page.getByRole('navigation', { name: 'Settings sections' })
  await nav.getByText('Get started', { exact: true }).click()
  const summary = page.getByText('Show languages', { exact: true })
  await summary.waitFor()
  const details = summary.locator('..')
  const speech = details.locator('..')
  assert.match(await speech.innerText(), /Installed: 3 languages\. 2 more can be downloaded\./)
  assert.doesNotMatch(await speech.innerText(), /\b\w{2}_\w{2}\b/)
  assert.equal(await details.getAttribute('open'), null)
  await summary.click()
  assert.match(await details.innerText(), /Czech/)
  assert.match(await details.innerText(), /French/)
  console.log('W5: speech inventory counts distinct locales and shows names on demand')

  await nav.getByText('Writing', { exact: true }).click()
  await page.getByText('Outline view font', { exact: true }).waitFor()
  assert.equal(await page.getByText('Keys changed inside the editor', { exact: true }).count(), 0)
  console.log('W6: the Writing page hides the saved keymap row')

  await nav.getByText('Presenting', { exact: true }).click()
  for (const [width, height] of [[1440, 900], [1000, 631]]) {
    await page.setViewportSize({ width, height })
    for (const label of ['Clock turns amber before the end', 'Clock turns dark amber before the end']) {
      const row = page.locator('.bsw-row').filter({ has: page.getByText(label, { exact: true }) })
      await row.waitFor()
      const unit = row.locator('.bsw-num .bsw-u')
      assert.equal(await unit.innerText(), 'min')
      assert((await row.boundingBox()).height <= 44, label + ' row at ' + width)
      assert((await unit.boundingBox()).height <= 20, label + ' unit at ' + width)
    }
  }
  console.log('L7: both clock rows and units fit at 1440 and 1000 pixels wide')
  assert.deepEqual(errors, [])
} finally {
  await browser?.close()
  await rm(dir, { recursive: true, force: true })
}
