// Real-Electron harness for the Show filter, the vault menu, unavailable vaults and same-name vaults
// (several-vaults ticket 07; LOCKED-sidebar frames 2A-D, 3G and section 4).
//
//   (A) HIDDEN    — with one open vault there is no Show control.
//   (B) SAME NAME — two vaults called Workshops read "Workshops · Local" and "Workshops · Git" in the
//                   sidebar, the Show menu and the Slide Browser chips; the vault file's own name is
//                   still plain.
//   (C) SHOW      — the Show menu scopes the panel to one vault (others one line each, Recent narrows)
//                   and is remembered across a reload; "Show only this vault" sets the same filter; x
//                   brings every vault back.
//   (D) REVEAL    — vault:reveal refuses an id the registry does not have (the folder never comes from
//                   the renderer). The real Reveal is not run here: it would open Finder.
//   (E) UNMOUNT   — the vault folder is renamed while the app runs: on the next window focus the
//                   section is unavailable (reason, one action, no talks, no crash), its Slide Browser
//                   chip is greyed and cannot be switched on; the folder is renamed back and the section
//                   comes back without a restart, with its talks.
//   (G) NO WRITES INTO AN UNAVAILABLE VAULT (review S1/S2/S3) — the FIRST vault's folder is renamed
//                   away: New talk from the palette, the panel's New talk and Enter on the unavailable
//                   note never re-create it; create-talk / create-folder with its id are refused; a
//                   create with no id lands in the next available vault. Search: an empty vault list
//                   searches nothing, the unavailable vault's talks are not found (Talks panel, Find a
//                   talk, talk facts), and a Show filter set to it lets go. The palette's Add vault…
//                   (was "Change vault folder…") opens the Add vault flow and replaces nothing.
//   (F) CHANGE VAULT — the toolbar button opens the Add vault flow (a folder already open is refused,
//                   nothing is replaced); vault:choose-root still adopts a folder (first-run path).
//
// Run: cd talk-weaver && npm run build >/dev/null 2>&1 && TW_E2E=1 node e2e/diagnose-vault-menu.mjs
import { _electron as electron } from 'playwright'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { ensureTalksMode, openTalkByTitle } from './lib/talklist.mjs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = join(__dirname, '..')
const SHOTS = join(REPO, 'docs', 'design', '2026-09-29-multi-vault', 'build-shots')
mkdirSync(SHOTS, { recursive: true })

const results = []
function record(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}
const outline = (title, slide) => ['---', `title: ${title}`, 'outline_version: 2', '---', '', '## Section', '',
  `### ${slide} {id=${slide.toLowerCase().replace(/\W+/g, '')}}`, '', 'Body one.', ''].join('\n')

const tempRoot = realpathSync(mkdtempSync(join(tmpdir(), 'tw-e2e-vault-menu-')))
const personal = join(tempRoot, 'Personal')
const wsLocal = join(tempRoot, 'local', 'Workshops')
const wsGit = join(tempRoot, 'git', 'Workshops')
const oxford = join(tempRoot, 'Oxford AICC')
const userData = join(tempRoot, 'userData')
for (const [root, title, slide] of [
  [personal, 'Metaphor talk 2026', 'Metaphor slide'], [wsLocal, 'Feedback that lands', 'Feedback slide'],
  [wsGit, 'Keynote sandbox', 'Keynote slide'], [oxford, 'Marking with rubrics', 'Rubric slide']
]) {
  const slug = title.toLowerCase().replace(/\W+/g, '-')
  mkdirSync(join(root, slug), { recursive: true })
  writeFileSync(join(root, slug, `${slug}-outline.md`), outline(title, slide))
}
mkdirSync(join(wsGit, '.git'), { recursive: true })
mkdirSync(userData, { recursive: true })
writeFileSync(join(userData, 'config.json'), JSON.stringify({ vaultRoot: personal }, null, 2))

await ensureFreshBuild(REPO)
const app = await electron.launch({ args: ['.', '--user-data-dir=' + userData], cwd: REPO, env: { ...process.env, TW_E2E: '1' } })
let page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) w.setSize(1440, 900) })
await page.waitForTimeout(1200)

const header = (name) => page.locator(`[data-vault-header][data-vault-name="${name}"]`)
const hasTalk = async (title) => (await page.locator(`.tl-tree [data-talk-title="${title}"]`).count()) > 0
const shot = (name) => page.screenshot({ path: join(SHOTS, `07-${name}.png`) })
const focusWindow = async () => { await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await page.waitForTimeout(700) }
const showBtn = () => page.locator('[data-show-filter] .tl-show')
const vaultList = () => page.evaluate(() => window.tw.vault.list())

try {
  await ensureTalksMode(page)
  await header('Personal').waitFor({ state: 'attached', timeout: 10000 })

  // ── (A) hidden with one open vault ──
  record('one open vault: no Show control', await page.locator('[data-show-filter]').count() === 0)

  // ── (B) same-name vaults ──
  for (const root of [wsLocal, wsGit, oxford]) {
    const r = await page.evaluate((p) => window.tw.vault.add(p), root)
    if (!r?.ok) record(`added ${root}`, false, JSON.stringify(r))
  }
  await header('Workshops · Git').waitFor({ state: 'attached', timeout: 10000 })
  await page.waitForTimeout(800)
  const names = (await vaultList()).map((v) => v.name)
  record('two vaults called Workshops read "Name · Service" in the sidebar', await header('Workshops · Local').count() === 1 && await header('Workshops · Git').count() === 1, JSON.stringify(names))
  record('a vault with its own name stays plain', await header('Personal').count() === 1 && await header('Oxford AICC').count() === 1)
  record('the view keeps the plain name for Edit this vault', (await vaultList()).filter((v) => v.baseName === 'Workshops').length === 2)
  record('with two or more open vaults the Show control appears, on All vaults', await showBtn().count() === 1 && (await showBtn().getAttribute('data-show-value')) === 'all')
  await shot('same-name-vaults')

  // ── (C) Show filter ──
  await showBtn().click()
  const optionIds = await page.locator('[data-show-option]').evaluateAll((els) => els.map((e) => e.textContent))
  record('the Show menu lists All vaults and each vault with the service suffix', optionIds.length === 5 && optionIds.some((t) => t.includes('Workshops · Local')) && optionIds.some((t) => t.includes('Workshops · Git')), JSON.stringify(optionIds))
  await shot('show-menu-open')
  const oxfordId = (await vaultList()).find((v) => v.name === 'Oxford AICC').id
  await page.locator(`[data-show-option="${oxfordId}"]`).click()
  await page.waitForTimeout(500)
  record('choosing a vault scopes the panel: its talk shows, the other vaults are one line each', await hasTalk('Marking with rubrics') && !(await hasTalk('Metaphor talk 2026')) && await page.locator('[data-vault-compact="true"]').count() === 3)
  record('the control takes the vault name and shows a clear button', (await showBtn().innerText()).includes('Oxford AICC') && await page.locator('[data-show-clear]').count() === 1)
  record('one-line rows say how many talks are hidden', (await page.locator('[data-vault-header][data-vault-name="Personal"]').innerText()).includes('1 hidden'))
  record('Recent narrows to the shown vault', JSON.stringify(await page.locator('.tl-recent-name').allInnerTexts().catch(() => [])) === '[]' || (await page.locator('.tl-recent-name').allInnerTexts()).every((n) => n === 'Marking with rubrics'))
  await shot('show-one-vault')
  const stored = await page.evaluate(() => localStorage.getItem('tw-talks-show-vault'))
  record('the choice is remembered', stored === oxfordId)
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(1500)
  await ensureTalksMode(page)
  await header('Oxford AICC').waitFor({ state: 'attached', timeout: 10000 })
  record('…across a reload', (await showBtn().getAttribute('data-show-value')) === oxfordId && !(await hasTalk('Metaphor talk 2026')))
  await page.locator('[data-show-clear]').click()
  await page.waitForTimeout(400)
  record('x brings every vault back', (await showBtn().getAttribute('data-show-value')) === 'all' && await hasTalk('Metaphor talk 2026') && await hasTalk('Marking with rubrics'))

  // "Show only this vault" from the ⋯ menu
  await header('Workshops · Git').locator('.tl-vmore').click()
  const items = await page.getByRole('menuitem').allInnerTexts()
  record('the ⋯ menu offers Edit this vault…, Show only this vault, Reveal in Finder, Close vault', JSON.stringify(items.map((t) => t.trim().split('\n')[0])) === JSON.stringify(['Edit this vault…', 'Show only this vault', 'Reveal in Finder', 'Close vault']), JSON.stringify(items))
  await shot('vault-menu')
  await page.getByRole('menuitem', { name: 'Show only this vault' }).click()
  await page.waitForTimeout(500)
  const gitId = (await vaultList()).find((v) => v.name === 'Workshops · Git').id
  record('Show only this vault sets the same filter', (await showBtn().getAttribute('data-show-value')) === gitId && await hasTalk('Keynote sandbox') && !(await hasTalk('Feedback that lands')))
  await page.locator('[data-show-clear]').click()
  await page.waitForTimeout(300)

  // ── (D) Reveal refuses an unknown id ──
  const unknown = await page.evaluate(() => window.tw.vault.reveal('no-such-vault'))
  const notString = await page.evaluate(() => window.tw.vault.reveal(/** @type {any} */ ({ root: '/etc' })))
  record('vault:reveal refuses an id the registry does not have', unknown?.ok === false && unknown.reason === 'unknown-vault', JSON.stringify(unknown))
  record('vault:reveal refuses a non-id argument', notString?.ok === false, JSON.stringify(notString))

  // ── (E) unmount, then remount ──
  const moved = `${wsLocal}-away`
  renameSync(wsLocal, moved)
  // Focus checks are at least 10 s apart (review S4): wait that out, then focus the window.
  await page.waitForTimeout(10_500)
  await focusWindow()
  const local = header('Workshops · Local')
  await page.waitForFunction(() => document.querySelector('[data-vault-header][data-vault-name="Workshops · Local"]')?.getAttribute('data-vault-unavailable'), null, { timeout: 8000 })
  record('an unmounted vault turns unavailable on the next focus, with its reason', (await local.getAttribute('data-vault-unavailable')) === 'folder-moved' && (await local.innerText()).includes('folder moved'), await local.innerText())
  record('the unavailable section says so and offers one action', await page.locator('[data-vault-unavailable-note]').count() === 1 && await page.locator('[data-vault-unavailable-action]').count() === 1 && (await page.locator('[data-vault-unavailable-note]').innerText()).includes('unavailable on this Mac'))
  record('it lists no talks and the app is still up', !(await hasTalk('Feedback that lands')) && await hasTalk('Metaphor talk 2026'))
  record('the note shows no folder path', !(await page.locator('[data-vault-unavailable-note]').innerText()).includes(tempRoot))
  record('the note says copied slides still say where they came from (frame 2C)', (await page.locator('[data-vault-unavailable-note]').innerText()).includes('Slides already copied from Workshops · Local still work, and still say \u201cFrom: Workshops · Local vault\u201d.'))
  // Enter on the note presses its button (Check again), never New talk (review S1).
  await header('Workshops · Local').click()
  await page.waitForTimeout(150)
  if (await page.locator('[data-vault-unavailable-note]').count() === 0) { await header('Workshops · Local').click(); await page.waitForTimeout(150) }
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(700)
  record('Enter on the unavailable note opens no New talk and re-creates nothing', await page.locator('.dialog-card').count() === 0 && !existsSync(wsLocal))
  await shot('vault-unavailable')
  const scanned = await page.evaluate((id) => window.tw.vault.listTalks(id), (await vaultList()).find((v) => v.baseName === 'Workshops' && v.unavailable).id)
  record('listing an unavailable vault returns nothing', Array.isArray(scanned) && scanned.length === 0)
  await header('Workshops · Local').locator('.tl-vmore').click()
  record('its ⋯ menu offers only Close vault', JSON.stringify((await page.getByRole('menuitem').allInnerTexts()).map((t) => t.trim())) === JSON.stringify(['Close vault']))
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)

  // Slide Browser chip
  await openTalkByTitle(page, 'Metaphor talk 2026')
  await page.waitForTimeout(600)
  await page.locator('.cm-content .cm-line', { hasText: 'Body one.' }).first().click()
  await page.keyboard.press('Meta+s')
  await page.locator('.lt-browser-root').waitFor({ state: 'visible', timeout: 8000 })
  await page.locator('[data-vault-chip]').first().waitFor({ state: 'visible', timeout: 8000 })
  const gone = page.locator('[data-vault-unavailable="true"][data-vault-chip]')
  record('its Slide Browser chip is greyed and says unavailable', await gone.count() === 1 && (await gone.innerText()).includes('unavailable'))
  await gone.click({ force: true })
  record('the greyed chip cannot be switched on', (await gone.getAttribute('aria-pressed')) === 'false' && (await gone.innerText()).includes('unavailable'))
  await shot('chip-unavailable')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  await ensureTalksMode(page)

  renameSync(moved, wsLocal)
  await page.evaluate(() => window.tw.vault.recheck()) // "Check again"
  await focusWindow()
  await page.waitForFunction(() => !document.querySelector('[data-vault-header][data-vault-name="Workshops · Local"]')?.getAttribute('data-vault-unavailable'), null, { timeout: 8000 })
  await page.waitForTimeout(800)
  record('renamed back: the section is available again without a restart, with its talks', await hasTalk('Feedback that lands') && await page.locator('[data-vault-unavailable-note]').count() === 0)

  // ── (G) the first vault's folder goes away: no writes into it, no search of it ──
  await openTalkByTitle(page, 'Marking with rubrics') // a talk in another vault stays open
  await page.waitForTimeout(600)
  await ensureTalksMode(page)
  const personalId = (await vaultList()).find((v) => v.name === 'Personal').id
  await showBtn().click()
  await page.locator(`[data-show-option="${personalId}"]`).click()
  await page.waitForTimeout(400)
  const personalAway = `${personal}-away`
  renameSync(personal, personalAway)
  const changed = await page.evaluate(() => window.tw.vault.recheck())
  await focusWindow()
  await page.waitForFunction(() => document.querySelector('[data-vault-header][data-vault-name="Personal"]')?.getAttribute('data-vault-unavailable'), null, { timeout: 8000 })
  record('the first vault turns unavailable on Check again', changed === true)
  record('a Show filter set to it lets go: every other vault is back in view', (await showBtn().getAttribute('data-show-value')) === 'all' && await hasTalk('Marking with rubrics'))
  // S1: New talk three ways
  const paletteNew = async () => {
    await page.keyboard.press('Meta+Shift+p')
    await page.waitForSelector('.command-menu', { timeout: 4000 })
    await page.locator('.command-menu-input').fill('New presentation')
    await page.waitForTimeout(200)
    await page.locator('.command-menu-item', { hasText: 'New presentation' }).first().click()
    await page.waitForTimeout(600)
  }
  await paletteNew()
  const dialogUp = await page.locator('.dialog-card').count() === 1
  if (dialogUp) {
    await page.locator('.dialog-card input').first().fill('Palette talk')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(1200)
  }
  record('palette New presentation… with the first vault unavailable does not re-create its folder', !existsSync(personal), `dialog=${dialogUp}`)
  const paletteTalk = (await vaultList()).length && readdirSync(tempRoot, { recursive: true }).filter((p) => String(p).endsWith('palette-talk-outline.md'))
  record('…and the new talk lands in an available vault', Array.isArray(paletteTalk) && paletteTalk.length === 1 && !String(paletteTalk[0]).startsWith('Personal'), JSON.stringify(paletteTalk))
  if (await page.locator('.dialog-card').count()) { await page.keyboard.press('Escape'); await page.waitForTimeout(300) }
  await ensureTalksMode(page)
  // the panel's New talk with the unavailable vault's header focused
  await header('Personal').click()
  await page.waitForTimeout(200)
  const newTalkBtn = page.locator('button[aria-label="New talk"], button[title^="New talk"]').first()
  if (await newTalkBtn.count()) {
    await newTalkBtn.click()
    await page.waitForTimeout(500)
    if (await page.locator('.dialog-card').count()) { await page.keyboard.press('Escape'); await page.waitForTimeout(300) }
  }
  record('the panel New talk with the unavailable header focused does not re-create its folder', !existsSync(personal), `button=${await newTalkBtn.count()}`)
  // Enter on the note
  const pNote = page.locator(`[data-vault-unavailable-note="${personalId}"]`)
  if (await pNote.count() === 0) { await header('Personal').click(); await page.waitForTimeout(200) }
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(600)
  record('Enter on its note opens no New talk', await page.locator('.dialog-card').count() === 0 && !existsSync(personal))
  if (await page.locator('.dialog-card').count()) { await page.keyboard.press('Escape'); await page.waitForTimeout(300) }
  // the IPC itself
  const byId = await page.evaluate((id) => window.tw.vault.createTalk({ title: 'Ghost', slug: 'ghost', vaultId: id }), personalId)
  const folderById = await page.evaluate((id) => window.tw.vault.createFolder('Ghost folder', '', id), personalId)
  const noId = await page.evaluate(() => window.tw.vault.createTalk({ title: 'Fallback talk', slug: 'fallback-talk' }))
  record('create-talk and create-folder into the unavailable vault are refused', byId === null && folderById === null)
  record('create-talk with no vault id (the current vault = the first open one) is refused, not re-targeted', noId === null && !existsSync(personal), JSON.stringify(noId))
  // Writes bound to "the current vault" (first open) are refused while it is unavailable; the next
  // vault is never written instead (Fable review S-1).
  const others = [wsLocal, wsGit, oxford]
  const snapshot = () => others.map((r) => readdirSync(r, { recursive: true }).map(String).sort().join('|')).join('#')
  const before07 = snapshot()
  const video = await page.evaluate(() => window.tw.asset.addVideo({ bytes: new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]).buffer, ext: 'mp4' }))
  const tagged = await page.evaluate((o) => window.tw.tags.apply([{ outline: o }], ['moved'], []), 'metaphor-talk-2026/metaphor-talk-2026-outline.md')
  const adopted = await page.evaluate((o) => window.tw.ledger.adopt('metaphorslide', '### Metaphor slide {id=metaphorslide}\n\nNew body.\n', [o]), 'metaphor-talk-2026/metaphor-talk-2026-outline.md')
  record('asset:add-video, tags:apply and ledger:adopt for the unavailable first vault are refused', video?.success === false && tagged === null && adopted === null, JSON.stringify({ video, tagged, adopted }))
  record('…and the other vaults are untouched', snapshot() === before07 && !existsSync(personal))
  record('the unavailable vault folder was never re-created', !existsSync(personal))
  // S2: search
  const q = async (opts) => page.evaluate((o) => window.tw.talks.search('Metaphor', o), opts)
  const byIds = await q({ vaultIds: [personalId] })
  const none = await q({ vaultIds: [] })
  const first = await q({})
  const oneId = await q({ vaultId: personalId })
  record('talk search: an empty vault list searches nothing', none.hits.length === 0)
  record('talk search: the unavailable vault is not searched (by id, by list, or as the first vault — Find a talk)', byIds.hits.length === 0 && oneId.hits.length === 0 && first.hits.length === 0, JSON.stringify([byIds.hits.length, oneId.hits.length, first.hits.length]))
  const listed = await page.evaluate(() => window.tw.vault.listTalks())
  record('the first-vault talk list skips the unavailable vault', !listed.some((t) => t.title === 'Metaphor talk 2026'))
  const meta = await page.evaluate(() => window.tw.vault.talkMeta())
  record('talk facts carry nothing from the unavailable vault', !Object.keys(meta).includes('metaphor-talk-2026'), Object.keys(meta).join())
  const slides = await page.evaluate(() => window.tw.search.allSlides('Metaphor', { vaultIds: [] }))
  record('slide search over no vaults finds nothing', Array.isArray(slides) && slides.length === 0)
  await page.locator('.tl-search input, input[placeholder^="Search talks"]').first().fill('Metaphor')
  await page.waitForTimeout(900)
  record('the Talks panel search does not find the unavailable vault’s talk', !(await hasTalk('Metaphor talk 2026')))
  await page.locator('.tl-search input, input[placeholder^="Search talks"]').first().fill('')
  await page.waitForTimeout(300)
  // S3: the palette's Add vault…
  const beforeIds = (await vaultList()).map((v) => v.id).sort().join()
  const rootBeforeAdd = await page.evaluate(() => window.tw.vault.getRoot())
  await app.evaluate(({ dialog }, folder) => { const original = dialog.showOpenDialog; dialog.showOpenDialog = async () => { dialog.showOpenDialog = original; return { canceled: false, filePaths: [folder] } } }, oxford)
  await page.keyboard.press('Meta+Shift+p')
  await page.waitForSelector('.command-menu', { timeout: 4000 })
  await page.locator('.command-menu-input').fill('Add vault')
  await page.waitForTimeout(200)
  const addItems = await page.locator('.command-menu-item', { hasText: 'Add vault…' }).count()
  const changeItems = await page.locator('.command-menu-item', { hasText: 'Change vault folder' }).count()
  await page.locator('.command-menu-item', { hasText: 'Add vault…' }).first().click()
  await page.locator('[data-vault-sheet="refused"]').waitFor({ state: 'visible', timeout: 8000 }).catch(() => {})
  record('the palette lists Add vault… (no Change vault folder…)', addItems >= 1 && changeItems === 0)
  record('the palette Add vault… opens the Add vault flow (an open vault is refused, by name)', (await page.locator('[data-vault-sheet="refused"]').getAttribute('data-refusal').catch(() => null)) === 'duplicate')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  record('…and replaces nothing', beforeIds === (await vaultList()).map((v) => v.id).sort().join() && rootBeforeAdd === await page.evaluate(() => window.tw.vault.getRoot()))
  // back
  renameSync(personalAway, personal)
  await page.evaluate(() => window.tw.vault.recheck())
  await focusWindow()
  await page.waitForFunction(() => !document.querySelector('[data-vault-header][data-vault-name="Personal"]')?.getAttribute('data-vault-unavailable'), null, { timeout: 8000 })
  await page.waitForTimeout(800)
  record('the first vault back: its talks are listed and found again', await hasTalk('Metaphor talk 2026') && (await q({})).hits.length > 0)

  // ── (F) toolbar "Change vault" is now Add vault ──
  const before = (await vaultList()).map((v) => v.id).sort().join()
  const rootBefore = await page.evaluate(() => window.tw.vault.getRoot())
  await ensureTalksMode(page)
  const btn = page.locator('button[aria-label="Add vault"]')
  record('the toolbar button is labelled Add vault…', await btn.count() === 1 && (await btn.getAttribute('title')) === 'Add vault…')
  const pick = (p) => app.evaluate(({ dialog }, folder) => { const original = dialog.showOpenDialog; dialog.showOpenDialog = async () => { dialog.showOpenDialog = original; return { canceled: false, filePaths: [folder] } } }, p)
  await pick(personal) // a folder that is already a vault
  await btn.click()
  await page.locator('[data-vault-sheet="refused"]').waitFor({ state: 'visible', timeout: 8000 })
  record('the button opens the Add vault flow (an open vault is refused, by name)', (await page.locator('[data-vault-sheet="refused"]').getAttribute('data-refusal')) === 'duplicate' && (await page.locator('[data-vault-sheet="refused"]').innerText()).includes('Personal'))
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  record('nothing was replaced or removed', before === (await vaultList()).map((v) => v.id).sort().join() && rootBefore === await page.evaluate(() => window.tw.vault.getRoot()))
  // vault:choose-root (first-run setup) still adopts a folder as the first open vault
  const other = join(tempRoot, 'Elsewhere', 'Fresh')
  mkdirSync(other, { recursive: true })
  await pick(other)
  const chosen = await page.evaluate(() => window.tw.vault.chooseRoot())
  record('vault:choose-root still adopts the chosen folder', chosen === other && (await page.evaluate(() => window.tw.vault.getRoot())) === other, String(chosen))
} catch (e) {
  record('vault-menu harness completed without throwing', false, String(e && e.stack ? e.stack : e))
} finally {
  const failed = results.filter((r) => !r.pass)
  console.log(`\n=== VAULT-MENU SUMMARY: ${results.length - failed.length}/${results.length} passed ===`)
  await app.close()
  process.exit(failed.length ? 1 : 0)
}
