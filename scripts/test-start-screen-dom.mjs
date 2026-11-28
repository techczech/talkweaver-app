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
import './src/renderer/src/styles.css'
import './src/renderer/src/talklist-vaults.css'
import './src/renderer/src/vault-sheet.css'
import './src/renderer/src/guide.css'

installMock()
window.twMacInset = true
window.setSearchBinding = keys => setOverride('sidebar.talks', keys)
const year = new Date().getFullYear()
const root = '/fixture-home/example-user/Documents/TalkWeaver'
const otherRoot = '/mock/other'
const vaults = [root, otherRoot].map((root, order) => ({
  id: 'garden-' + order, root, order, open: true, name: order ? 'School talks' : 'Garden talks',
  baseName: order ? 'School talks' : 'Garden talks', initial: order ? 'S' : 'G', color: order ? '#146e76' : '#b34618',
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
  ['Companion planting basics', 'workshops/Field notes', 48, year, 5, 17],
  ['What to plant in March', 'schools', 35, year, 2, 2],
  ['Planting calendar for schools', 'schools/2025', 64, year - 1, 10, 12],
  ['Bulb planting with Year 4', 'schools/2025', 19, year - 1, 9, 7],
  ...Array.from({ length: 130 }, (_, i) => ['Archived garden talk ' + (i + 1), 'archive', 12, year - 2, 0, 1])
].map(([title, folder, slideCount, y, m, d], index) => {
  const vault = vaults[index === 1 || index === 11 || index === 12 ? 1 : 0]
  // The two talks with the same slug deliberately live in different vaults.
  const slug = index === 11 ? 'garden-0' : 'garden-' + index
  const path = vault.root + '/' + folder + '/' + slug
  return { title, slug, path, folder, slideCount, editedMs: new Date(y, m, d, 12).getTime(),
    name: slug, vaultId: vault.id, outlinePath: path + '/' + slug + '-outline.md' }
})
let firstRun = location.hash === '#first'
if (location.hash === '#offline') vaults[1].unavailable = { message: 'Storage is offline.' }
window.claimed = []
window.creates = []
window.newWindows = []
Object.assign(window.tw.vault, {
  list: async () => firstRun ? [] : vaults,
  useDefaultRoot: async () => { firstRun = false; return root },
  galleryCatalogue: async generation => ({ generation, rootGeneration: 1, vaults: [] }),
  galleryTalk: async (id, rel) => talks.find(t => t.vaultId === id && t.outlinePath === vaults.find(v => v.id === id).root + '/' + rel),
  galleryClaim: async (id, rel) => { window.claimed.push(vaults.find(v => v.id === id).root + '/' + rel); return { ok: true } },
  gallerySettle: async () => ({ ok: true }),
  galleryFacts: async (id, rel, cover) => {
    const talk = await window.tw.vault.galleryTalk(id, rel)
    if (!talk) return null
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90" viewBox="0 0 160 90"><rect width="160" height="90" fill="#fbfbfb"/><circle cx="138" cy="45" r="35" fill="#1d756c"/><text x="8" y="42" font-family="sans-serif" font-size="7" font-weight="700">' + talk.title.slice(0, 30) + '</text></svg>'
    return { revision: rel, slideCount: talk.slideCount, editedMs: talk.editedMs,
      preview: cover ? 'ready' : 'pending', coverUrl: cover ? 'data:image/svg+xml,' + encodeURIComponent(svg) : null }
  },
  galleryHandouts: async () => ({ status: 'unpublished', records: [], partial: false, note: null }),
  listTalks: async id => talks.filter(talk => talk.vaultId === id),
  listFolders: async id => id === 'garden-1' ? ['schools', 'schools/2025'] : ['archive', 'committee', 'funding', 'schools', 'workshops', 'workshops/Field notes'],
  talkMeta: async () => Object.fromEntries(talks.flatMap(talk => [
    [talk.outlinePath, { editedMs: talk.editedMs, slideCount: talk.slideCount }],
    [talk.slug, { editedMs: talk.editedMs, slideCount: talk.slideCount }]
  ])),
  createTalk: async options => {
    window.creates.push(options)
    const path = [vaults.find(v => v.id === options.vaultId).root, options.topicFolder, options.slug].filter(Boolean).join('/')
    return { ...options, name: options.slug, path, outlinePath: path + '/' + options.slug + '-outline.md' }
  }
})
window.tw.search.allSlidesCompact = async query => {
  const text = query.text.toLowerCase()
  const talk = talks[11]
  const result = (order, title, source_markdown, fields) => ({
    title, order, source_markdown, slide_id: 'slide-' + order, content_hash: 'hash-' + order,
    outlinePath: talk.outlinePath, talkSlug: talk.slug, talkTitle: talk.title, vaultId: talk.vaultId,
    matchEvidence: { fields }
  })
  if (text === 'planting calendar') return [result(0, 'Planning', '- Plan the planting calendar.', { text: true })]
  if (query.scope === 'widget' && (text === 'watering schedule' || text === '')) return [{
    ...result(0, 'Planning', '[Simulation: garden-planner.html]', { widget: true }),
    widget_titles: ['Watering schedule']
  }]
  if (text !== 'survey') return []
  return [
    result(0, 'Survey method', '## Survey method', { title: true }),
    result(1, 'Field notes', '- A survey by foot.', { text: true }),
    result(2, 'Results', '![Plot of the survey](waterside.png)', { picture: true }),
    result(3, 'Map', '![Field map](survey-area.png)', { picture: true }),
    ...Array.from({ length: 197 }, (_, i) => result(i + 4, 'Survey notes', '', { title: true }))
  ]
}
window.tw.recording.listAllSessions = async () => []
window.tw.history = { ...window.tw.history, talkHandouts: async () => ({}) }
window.tw.windows.claimTalk = async path => { window.claimed.push(path); return { ok: true } }
window.tw.windows.openInNewWindow = async target => { window.newWindows.push(target); return { ok: true } }
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
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  await page.route(/^https?:/, route => route.abort())
  page.setDefaultTimeout(12000)
  const errors = []
  page.on('pageerror', error => { errors.push(error.message); console.error(error) })
  const url = pathToFileURL(html).href
  const explorer = page.getByRole('region', { name: 'Vault Explorer' })
  const search = explorer.getByRole('combobox', { name: 'Search talks' })
  const name = explorer.getByRole('textbox', { name: 'Name of the talk' })
  const recent = explorer.getByRole('group', { name: 'Recent talks' })
  const results = explorer.getByRole('group', { name: 'Search results' })
  const opened = async (title, suffix) => {
    await page.getByTitle('Talk menu', { exact: true }).getByText(title, { exact: true }).waitFor()
    assert.ok((await page.evaluate(() => window.claimed.at(-1))).endsWith(suffix))
  }
  const capture = async state => {
    if (!look) return
    await explorer.locator('.vx-content .vx-cover img').first().waitFor()
    console.log('EXPLORER_LOOK ' + state + ' ' + (await page.screenshot({ animations: 'disabled' })).toString('base64'))
  }

  await page.goto(url)
  await recent.getByRole('button', { name: 'Community garden update', exact: true }).waitFor()
  assert.equal(await recent.locator('.vx-talk-open').count(), 5)
  assert.equal(await explorer.getByRole('complementary', { name: 'Vaults and folders' }).count(), 0)
  const inset = await explorer.getByRole('button', { name: 'Folders sidebar' }).evaluate(el => ({
    left: el.getBoundingClientRect().left,
    reserved: Number.parseFloat(getComputedStyle(el).getPropertyValue('--tw-native-fallback-inline'))
  }))
  assert.ok(inset.reserved > 0 && inset.left >= inset.reserved, 'Explorer protects the window controls')
  await capture('start')

  await page.evaluate(() => window.setSearchBinding('Mod-Shift-y'))
  await name.focus()
  await page.keyboard.press('ControlOrMeta+Shift+y')
  assert.ok(await search.evaluate(el => document.activeElement === el), 'the reassigned search key focuses Explorer search')
  await explorer.getByRole('button', { name: 'Folders sidebar' }).click()
  await explorer.getByRole('button', { name: 'New talk', exact: true }).click()
  await explorer.getByRole('button', { name: /^workshops, 4 talks/ }).click()
  await explorer.getByRole('navigation', { name: 'Location' }).getByRole('button', { name: 'workshops' }).waitFor()
  await explorer.getByRole('button', { name: 'Composting for beginners', exact: true }).waitFor()
  if (look) await explorer.getByRole('button', { name: 'Gallery', exact: true }).click()
  await capture('folder')
  if (look) await explorer.getByRole('button', { name: 'List', exact: true }).click()

  await explorer.getByRole('navigation', { name: 'Location' }).getByRole('button', { name: 'All talks' }).click()
  await explorer.getByRole('button', { name: 'Folders sidebar' }).click()
  await explorer.getByRole('button', { name: 'New talk', exact: true }).click()
  await search.fill('planting calendar')
  const match = results.getByRole('button', { name: 'Planting calendar for schools', exact: true })
  await match.waitFor()
  assert.match(await results.innerText(), /School talks.*schools.*2025/s)
  assert.equal(await results.locator('mark').count(), 2)
  await explorer.getByText('Also on 1 slide', { exact: false }).waitFor()
  await capture('search')
  await match.click({ button: 'right' })
  await explorer.getByRole('menuitem', { name: 'Open in new window' }).click()
  assert.match(await page.evaluate(() => window.newWindows.at(-1).outlinePath), /^\/mock\/other\//)
  await search.press('ControlOrMeta+Enter')
  assert.equal(await page.evaluate(() => window.newWindows.length), 2)
  await search.press('Enter')
  await opened('Planting calendar for schools', '/mock/other/schools/2025/garden-0/garden-0-outline.md')

  await page.reload()
  await recent.getByRole('button', { name: 'Community garden update', exact: true }).click()
  await opened('Community garden update', '/committee/garden-0/garden-0-outline.md')

  await page.reload()
  await search.fill('survey')
  await explorer.getByText('Slide content: 201 slides.').waitFor()
  await explorer.getByRole('button', { name: 'Search slide content', exact: true }).click()
  await explorer.getByRole('heading', { name: '201 slides in 1 talk match', exact: true }).waitFor()
  const foundIn = explorer.getByRole('group', { name: 'Found in' })
  assert.deepEqual(await foundIn.getByRole('button').allTextContents(), ['Slide title', 'Text', 'Image'])
  const imageFilter = foundIn.getByRole('button', { name: 'Image', exact: true })
  await imageFilter.click()
  await explorer.getByRole('heading', { name: '2 slides in 1 talk match', exact: true }).waitFor()
  assert.equal(await results.locator('.vx-row').count(), 2)
  await imageFilter.click()
  await explorer.getByRole('heading', { name: '201 slides in 1 talk match', exact: true }).waitFor()
  assert.equal(await results.locator('.vx-row').count(), 200)
  assert.equal(await results.getByRole('button', { name: /: Field notes$/ }).locator('.vx-slide-hit').textContent(), 'A survey by foot.')
  for (const [title, text, kind] of [['Results', 'Plot of the survey', 'Image description'], ['Map', 'survey-area.png', 'Image name']]) {
    const hit = results.getByRole('button', { name: new RegExp(': ' + title + '$') })
    assert.equal(await hit.locator('.vx-slide-hit').textContent(), text)
    assert.equal(await hit.locator('.vx-hit-kind').textContent(), kind)
  }
  await explorer.getByRole('button', { name: /^Show more/ }).click()
  assert.equal(await results.locator('.vx-row').count(), 201)
  await search.fill('widget:watering schedule')
  const widgetHit = results.getByRole('button', { name: /: Planning$/ })
  await widgetHit.waitFor()
  assert.equal(await widgetHit.locator('.vx-slide-hit').textContent(), 'Watering schedule')
  assert.equal(await widgetHit.locator('.vx-hit-kind').textContent(), 'Widget')
  await foundIn.getByRole('button', { name: 'Widget', exact: true }).waitFor()
  await search.fill('widget:')
  await widgetHit.locator('.vx-slide-hit').waitFor({ state: 'detached' })
  await widgetHit.waitFor()
  assert.equal(await widgetHit.locator('.vx-hit-kind').textContent(), 'Widget')
  await explorer.getByRole('button', { name: 'Titles', exact: true }).click()
  await search.fill('budget 2027')
  await explorer.getByRole('heading', { name: 'No matches' }).waitFor()
  await explorer.getByRole('button', { name: 'Change save location' }).click()
  await explorer.getByRole('button', { name: 'School talks', exact: true }).click()
  await explorer.getByRole('button', { name: 'Change save location' }).click()
  await explorer.getByRole('button', { name: '2025', exact: true }).click()
  await name.fill('budget 2027')
  assert.deepEqual(await page.evaluate(() => window.creates), [])
  await name.press('Enter')
  await opened('budget 2027', '/schools/2025/budget-2027/budget-2027-outline.md')
  assert.deepEqual(await page.evaluate(() => window.creates), [
    { title: 'budget 2027', slug: 'budget-2027', vaultId: 'garden-1', topicFolder: 'schools/2025', startWithSketch: false }
  ])

  await page.setViewportSize({ width: 800, height: 600 })
  await page.reload()
  await recent.waitFor()
  assert.equal(await name.count(), 0, 'at 800×600 the start panel is closed')
  await explorer.getByRole('button', { name: 'New talk', exact: true }).click()
  await name.waitFor()
  const drawer = explorer.getByRole('complementary', { name: 'Start a new talk' })
  assert.ok((await drawer.boundingBox()).width >= 320, 'the narrow new-talk drawer has a usable width')
  await explorer.getByRole('button', { name: 'Folders sidebar' }).click()
  const sidebar = explorer.getByRole('complementary', { name: 'Vaults and folders' })
  assert.ok((await sidebar.boundingBox()).width >= 240, 'the narrow folders drawer has a usable width')
  assert.equal(await name.count(), 0, 'only one drawer is open')
  assert.equal(await explorer.locator('.vx-content').evaluate(el => el.scrollWidth > el.clientWidth), false)
  await page.goto(url + '#offline')
  await page.reload()
  await recent.getByRole('button', { name: 'Allotment society annual meeting', exact: true }).waitFor()
  assert.equal(await recent.getByRole('button', { name: 'Allotment society annual meeting', exact: true }).isDisabled(), true)
  await explorer.getByText('Last seen with 3 talks.').waitFor()
  await explorer.getByText(/Nothing has been deleted/).waitFor()
  await page.goto(url + '#first')
  await page.reload()
  await explorer.getByRole('heading', { name: 'Choose where to keep your talks' }).waitFor()
  assert.equal(await explorer.getByRole('button', { name: 'New talk', exact: true }).count(), 0)
  await explorer.getByRole('button', { name: /Make a vault in Documents/ }).click()
  await recent.waitFor()
  assert.deepEqual(errors, [])
  console.log('PASS start screen: real renderer journeys through folders, search, window actions, and save location')

} finally {
  try { await browser?.close() } finally { rmSync(scratch, { recursive: true, force: true }) }
}
