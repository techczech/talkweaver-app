import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { launchEditorTestBrowser } from './lib/editor-test-browser.mjs'

const scratch = mkdtempSync(join(tmpdir(), 'tw-start-screen-'))
const look = process.argv.includes('--look')
let browser
try {
  await build({
    stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
import './src/renderer/src/lib/appTheme.ts'
import { createRoot } from 'react-dom/client'
import App from './src/renderer/src/App.tsx'
import WindowChrome from './src/renderer/src/components/WindowChrome.tsx'
import { installMock } from './src/renderer/src/tw-mock.ts'
import { setOverride } from './src/renderer/src/keymap/store.ts'
import { emptyTalkSearchResult } from './src/shared/talk-search.ts'
import './src/renderer/src/styles.css'
import './src/renderer/src/talklist-vaults.css'
import './src/renderer/src/vault-sheet.css'
import './src/renderer/src/guide.css'

installMock()
window.twMacInset = true
window.setSearchBinding = keys => setOverride('sidebar.talks', keys)
const year = new Date().getFullYear()
const root = '/Users/you/Documents/TalkWeaver'
const otherRoot = '/mock/other'
const vaults = [root, otherRoot].map((root, order) => ({
  id: 'garden-' + order, root, order, open: true, name: order ? 'School talks' : 'Garden talks',
  baseName: order ? 'School talks' : 'Garden talks', initial: order ? 'S' : 'G', color: '#497653',
  service: 'Local', unavailable: null
}))
const talks = [
  ['Community garden update', 'committee', 24, year, 10, 24],
  ['Allotment society annual meeting', 'committee', 71, year, 10, 23],
  ['Composting for beginners', 'workshops', 107, year, 10, 20],
  ['Seed swap welcome talk', 'workshops', 18, year, 10, 18],
  ['Water butts and the watering rota', 'committee', 29, year, 10, 12],
  ['Autumn planting workshop', 'workshops', 136, year, 10, 3],
  ['Funding bid for the tool shed', 'funding', 57, year, 9, 19],
  ['New growers induction', 'committee', 70, year, 8, 12],
  ['Planting day volunteer briefing', 'committee', 22, year, 8, 9],
  ['Companion planting basics', 'workshops', 48, year, 5, 17],
  ['What to plant in March', 'schools', 35, year, 2, 2],
  ['Planting calendar for schools', 'schools/2025', 64, year - 1, 10, 12],
  ['Bulb planting with Year 4', 'schools/2025', 19, year - 1, 9, 7],
  ...Array.from({ length: 130 }, (_, i) => ['Archived garden talk ' + (i + 1), 'archive', 12, year - 2, 0, 1])
].map(([title, folder, slideCount, y, m, d], index) => {
  const vault = vaults[index === 11 || index === 12 ? 1 : 0]
  // The two talks with the same slug deliberately live in different vaults.
  const slug = index === 11 ? 'garden-0' : 'garden-' + index
  const path = vault.root + '/' + folder + '/' + slug
  return { title, slug, path, folder, slideCount, editedMs: new Date(y, m, d, 12).getTime(),
    name: slug, vaultId: vault.id, outlinePath: path + '/' + slug + '-outline.md' }
})
const firstRun = location.hash === '#first'
window.claimed = []
window.creates = []
window.searches = []
Object.assign(window.tw.vault, {
  list: async () => firstRun ? [] : vaults,
  listTalks: async id => talks.filter(talk => talk.vaultId === id),
  listFolders: async () => ['archive', 'committee', 'funding', 'schools', 'workshops'],
  talkMeta: async () => Object.fromEntries(talks.flatMap(talk => [
    [talk.outlinePath, { editedMs: talk.editedMs, slideCount: talk.slideCount }],
    [talk.slug, { editedMs: talk.editedMs, slideCount: talk.slideCount }]
  ])),
  createTalk: async options => {
    window.creates.push(options)
    const path = root + '/' + options.slug
    return { ...options, name: options.slug, path, outlinePath: path + '/' + options.slug + '-outline.md' }
  }
})
window.tw.recording.listAllSessions = async () => []
window.tw.history = { ...window.tw.history, talkHandouts: async () => ({}) }
window.tw.windows.claimTalk = async path => { window.claimed.push(path); return { ok: true } }
window.tw.talks = { search: async (query, options) => {
  window.searches.push({ query, options })
  // Return oldest first so the renderer's default sort is exercised.
  const hits = talks.filter(talk => options.vaultIds.includes(talk.vaultId)
    && talk.title.toLowerCase().includes(query.toLowerCase())).reverse().map(talk => {
    const start = talk.title.toLowerCase().indexOf(query.toLowerCase())
    return { ...talk, titleHighlights: [[start, start + query.length]], match: null, lastGiven: null }
  })
  return { ...emptyTalkSearchResult(query, null), hits, everywhereCount: hits.length }
} }
createRoot(document.getElementById('root')).render(<WindowChrome><App /></WindowChrome>)
` },
    bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
    loader: { '.svg': 'dataurl', '.woff2': 'dataurl' },
    define: { __TW_SECURITY_TEST__: 'false', 'import.meta.env.DEV': 'false' },
    outfile: join(scratch, 'fixture.js')
  })
  const html = join(scratch, 'fixture.html')
  writeFileSync(html, '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>')
  browser = await launchEditorTestBrowser()
  const page = await browser.newPage({ viewport: { width: 1000, height: 631 }, reducedMotion: 'reduce' })
  await page.route(/^https?:/, route => route.abort())
  page.setDefaultTimeout(12000)
  const errors = []
  page.on('pageerror', error => { errors.push(error.message); console.error(error) })
  const url = pathToFileURL(html).href
  const search = page.getByPlaceholder('Search all your talks')
  const name = page.getByRole('textbox', { name: 'Name of the talk' })
  const open = page.getByRole('region', { name: 'Open a talk' })
  const row = title => open.getByRole('button', { name: new RegExp(title, 'i') })
  const focus = locator => locator.evaluate(el => document.activeElement === el)
  const searchFor = async (query, heading) => { await search.fill(query); await open.getByText(heading, { exact: true }).waitFor() }
  const opened = async (title, slug) => {
    await page.getByTitle('Talk menu', { exact: true }).getByText(title, { exact: true }).waitFor()
    assert.ok((await page.evaluate(() => window.claimed.at(-1))).endsWith('/' + slug + '-outline.md'))
  }

  await page.goto(url)
  await open.getByText('Recent talks', { exact: true }).waitFor()
  await row('Community garden update').waitFor()
  assert.equal(await open.locator('tbody tr').count(), 8)
  assert.equal(await focus(search), true)
  await page.evaluate(() => window.setSearchBinding('Mod-Shift-y'))
  await open.locator('kbd').getByText(/Y$/i).waitFor()
  await name.focus()
  await page.keyboard.press('ControlOrMeta+Shift+y')
  assert.equal(await focus(search), true)
  await page.getByRole('button', { name: 'Show all 143 talks' }).click()
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Talks browser')
  await searchFor('plant', '6 talks match “plant”')
  assert.equal(await open.locator('tbody tr').first().locator('mark').innerText(), 'plant')
  assert.match(await row('Planting calendar for schools').locator('xpath=ancestor::tr').innerText(), /64\s+\w{3} 12 Nov \d{4}/)
  assert.deepEqual(await page.evaluate(() => window.searches.at(-1).options.vaultIds), ['garden-0', 'garden-1'])
  await open.getByRole('button', { name: 'Slides', exact: true }).click()
  assert.match(await open.locator('tbody tr').first().innerText(), /Autumn planting workshop/)
  await search.press('ArrowDown')
  await search.press('Enter')
  await opened('Planting calendar for schools', 'garden-0')
  assert.match(await page.evaluate(() => window.claimed.at(-1)), /^\/mock\/other\//)

  await page.reload()
  await row('Community garden update').click()
  await opened('Community garden update', 'garden-0')

  await page.reload()
  await searchFor('budget 2027', 'No talk matches “budget 2027”.')
  await page.getByRole('button', { name: 'Name a new talk “budget 2027”', exact: true }).click()
  assert.equal(await name.inputValue(), 'budget 2027')
  assert.equal(await focus(name), true)
  assert.deepEqual(await page.evaluate(() => window.creates), [])
  await name.press('Enter')
  await opened('budget 2027', 'budget-2027')
  assert.deepEqual(await page.evaluate(() => window.creates), [
    { title: 'budget 2027', slug: 'budget-2027', vaultId: 'garden-0', startWithSketch: false }
  ])

  if (look) {
    for (const [width, height] of [[1000, 631], [1440, 900]]) {
      await page.setViewportSize({ width, height })
      for (const theme of ['light', 'dark']) {
        await page.goto(url)
        await page.reload()
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme }, theme)
        const expand = page.getByRole('button', { name: 'Show sidebar', exact: true })
        const collapse = page.getByRole('button', { name: 'Hide sidebar', exact: true })
        const capture = async state => console.log('START_LOOK ' + state + '-' + theme + '-' + width + 'x' + height + ' '
          + (await page.screenshot({ animations: 'disabled' })).toString('base64'))
        await row('New growers induction').waitFor()
        if (await expand.isVisible()) await expand.click()
        await search.focus()
        await capture('recent')
        await collapse.click()
        await searchFor('plant', '6 talks match “plant”')
        await capture('results')
        await expand.click()
        await searchFor('budget 2027', 'No talk matches “budget 2027”.')
        await capture('nomatch')
        await page.goto(url + '#first')
        await page.reload()
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme }, theme)
        await page.getByRole('button', { name: 'Open the example talks', exact: true }).waitFor()
        assert.equal(await focus(name), true)
        assert.equal(await page.locator('.workspace-toolbar, [data-sidebar]').count(), 0)
        await capture('first')
      }
    }
  }
  assert.deepEqual(errors, [])
  console.log('PASS start screen: search and recents open through the guarded route, and naming creates only on submit')
} finally {
  try { await browser?.close() } finally { rmSync(scratch, { recursive: true, force: true }) }
}
