// Gate e2e for the vault file (several-vaults ticket 04; LOCKED-edit-vault.html). Real Electron,
// headless (TW_E2E=1), driving the Add vault / Edit this vault / join sheets through the Talks panel.
//
//   (A) CREATE   — Add vault… on a plain folder opens the New vault sheet; Create vault writes
//                  <root>/.talkweaver/vault.json once (no temp file left), with no absolute path in it,
//                  the logo vault-relative, and the id the registry uses.
//   (B) DEFAULTS — a new talk in that vault starts with the vault's affiliation, style and logo and
//                  this person's author; the Inspector says where they came from.
//   (C) EDIT     — ⋯ › Edit this vault… opens the sheet; Done rewrites the file with unknown keys kept.
//                  A logo chosen outside the vault is copied into _assets/logos on Done (" 2" on a
//                  name clash, the existing logo untouched); a non-image is refused.
//   (C2) PERSONAL — Done on a plain-folder vault with only "Just for me" changed writes no vault file.
//   (D) JOIN     — a folder that already has a vault file opens the join sheet ("set up by …"); Open
//                  vault adds it with the file's id and does not touch the file.
//   (E) REFUSED  — a folder carrying the id of a vault already in the list is refused, naming it; a
//                  folder already open as a vault likewise.
//   (F) QUIET    — close/reopen a vault, then quit and relaunch: no vault file changes (bytes and
//                  mtime), and the migrated plain-folder vault still has no vault file.
//
// Screenshots of the sheets go to docs/design/2026-09-29-multi-vault/build-shots/04-*.png.
// Run: cd talk-weaver && npm run build >/dev/null 2>&1 && TW_E2E=1 node e2e/diagnose-vault-file.mjs
import { _electron as electron } from 'playwright'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { ensureTalksMode, openTalkByTitle } from './lib/talklist.mjs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'fs'
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

const tempRoot = realpathSync(mkdtempSync(join(tmpdir(), 'tw-e2e-vault-file-')))
const personal = join(tempRoot, 'Personal')
const workshops = join(tempRoot, 'Workshops')
const shared = join(tempRoot, 'AI and assessment workshop')
const sharedCopy = join(tempRoot, 'Copy of the workshop')
const userDataDir = join(tempRoot, 'userData')
for (const [folder, title] of [[personal, 'Alpha Talk'], [shared, 'Shared Talk']]) {
  const slug = title.toLowerCase().replace(/\W+/g, '-')
  mkdirSync(join(folder, slug), { recursive: true })
  writeFileSync(join(folder, slug, `${slug}-outline.md`), outline(title, `${title} slide`))
}
mkdirSync(join(workshops, '_assets', 'logos'), { recursive: true })
writeFileSync(join(workshops, '_assets', 'logos', 'aicc.svg'),
  '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="48" viewBox="0 0 120 48"><rect width="120" height="48" rx="6" fill="#0b3a6b"/><text x="60" y="32" font-family="sans-serif" font-size="22" font-weight="800" fill="#fff" text-anchor="middle">AICC</text></svg>')
const brand = join(tempRoot, 'Brand kit')
mkdirSync(brand, { recursive: true })
writeFileSync(join(brand, 'aicc.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="48"><rect width="120" height="48" rx="6" fill="#9f1239"/></svg>')
writeFileSync(join(brand, 'notes.txt'), 'not a logo')
const annaFile = { schema: 1, id: 'anna-vault-0001', name: 'AI and assessment workshop', shared: true, affiliation: 'University of Oxford', style: 'green', created_by: 'Anna Novak', created_at: '2026-09-28T09:00:00.000Z', annaOnlyKey: 'from a newer build' }
for (const folder of [shared, sharedCopy]) {
  mkdirSync(join(folder, '.talkweaver'), { recursive: true })
  writeFileSync(join(folder, '.talkweaver', 'vault.json'), JSON.stringify(annaFile, null, 2))
}
mkdirSync(userDataDir, { recursive: true })
writeFileSync(join(userDataDir, 'config.json'), JSON.stringify({ vaultRoot: personal, metadataDefaults: { author: 'Settings Author', affiliation: 'App Default Uni' } }, null, 2))

const vaultJson = (root) => join(root, '.talkweaver', 'vault.json')
const snap = (root) => existsSync(vaultJson(root)) ? { bytes: readFileSync(vaultJson(root), 'utf8'), mtime: statSync(vaultJson(root)).mtimeMs } : null
const strings = (v) => typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : []
const looksAbsolute = (s) => /^([/~\\]|[a-zA-Z]:[\\/]|file:)/.test(s.trim())

await ensureFreshBuild(REPO)
async function launch() {
  const app = await electron.launch({ args: ['.', '--user-data-dir=' + userDataDir], cwd: REPO, env: { ...process.env, TW_E2E: '1' } })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) w.setSize(1440, 900) })
  await page.waitForTimeout(1200)
  await page.locator('[data-vault-header]').first().waitFor({ state: 'attached', timeout: 10000 })
  return { app, page }
}
/** The next folder or file picker answers with path (the real picker is the system dialog). */
async function nextPick(app, path) {
  await app.evaluate(({ dialog }, p) => {
    const original = dialog.showOpenDialog
    dialog.showOpenDialog = async () => { dialog.showOpenDialog = original; return { canceled: false, filePaths: [p] } }
  }, path)
}
const header = (page, name) => page.locator(`[data-vault-header][data-vault-name="${name}"]`)
const shot = (page, name) => page.screenshot({ path: join(SHOTS, `04-${name}.png`) })

let { app, page } = await launch()
try {
  await ensureTalksMode(page)
  // ── (A) CREATE ──
  await nextPick(app, workshops)
  await page.locator('[data-add-vault]').click()
  const sheet = page.locator('[data-vault-sheet="new"]')
  await sheet.waitFor({ state: 'visible', timeout: 8000 })
  record('Add vault… on a plain folder opens the New vault sheet named after the folder', (await page.locator('[data-vault-sheet-title]').innerText()) === 'Workshops')
  record('the New vault sheet shows no folder path', !(await sheet.innerText()).includes(tempRoot))
  record('Just for me starts from Settings › Presenter identity', (await page.locator('[data-field="author"]').inputValue()) === 'Settings Author')
  await shot(page, 'new-vault')
  await page.locator('[data-field="name"]').fill('')
  await page.locator('[data-field="name"]').blur()
  record('an empty name disables Create vault and says why', await page.locator('[data-vault-sheet-submit]').isDisabled() && (await sheet.innerText()).includes('A vault needs a name.'))
  await shot(page, 'new-vault-no-name')
  await page.locator('[data-field="name"]').fill('Workshops')
  await page.locator('[data-field="affiliation"]').fill('University of Oxford')
  await page.locator('[data-field="style"]').selectOption('green')
  await nextPick(app, join(workshops, '_assets', 'logos', 'aicc.svg'))
  await page.locator('[data-choose-logo]').click()
  await page.waitForFunction(() => document.querySelector('[data-vault-logo]')?.getAttribute('data-vault-logo') === '_assets/logos/aicc.svg', null, { timeout: 5000 })
  record('Choose… takes a logo inside the vault, stored vault-relative', true)
  await page.locator('[data-field="author"]').fill('Dominik Lukeš')
  await page.locator('[data-swatch="#0f766e"]').click()
  await shot(page, 'new-vault-filled')
  record('nothing is written before Create vault', !existsSync(join(workshops, '.talkweaver')))
  await page.locator('[data-vault-sheet-submit]').click()
  await header(page, 'Workshops').waitFor({ state: 'attached', timeout: 8000 })
  const vaults1 = await page.evaluate(() => window.tw.vault.list())
  const ws = vaults1.find((v) => v.name === 'Workshops')
  const created = JSON.parse(readFileSync(vaultJson(workshops), 'utf8'))
  record('Create vault writes the vault file, and the registry uses its id', !!ws && created.id === ws.id && created.name === 'Workshops', JSON.stringify(created))
  record('the vault file has affiliation, style, logo (vault-relative) and who set it up',
    created.affiliation === 'University of Oxford' && created.style === 'green' && created.logo === '_assets/logos/aicc.svg' && created.created_by === 'Dominik Lukeš' && created.schema === 1)
  record('the vault file never contains an absolute path', strings(created).every((s) => !looksAbsolute(s)) && !JSON.stringify(created).includes(tempRoot))
  record('the write left no temp file beside it', JSON.stringify(readdirSync(join(workshops, '.talkweaver'))) === '["vault.json"]')
  record('the badge is the colour chosen in Just for me', ws?.color === '#0f766e')
  const afterCreate = snap(workshops)
  await page.waitForTimeout(1500)
  record('the vault file is written once (unchanged after the panel settles)', JSON.stringify(snap(workshops)) === JSON.stringify(afterCreate))

  // ── (B) DEFAULTS on a new talk ──
  const talk = await page.evaluate((id) => window.tw.vault.createTalk({ title: 'Untitled talk', slug: 'untitled-talk', vaultId: id }), ws.id)
  const talkText = talk ? readFileSync(talk.outlinePath, 'utf8') : ''
  record('a new talk takes the vault’s affiliation, style and logo and this person’s author',
    /^affiliation: University of Oxford$/m.test(talkText) && /^palette: green$/m.test(talkText) && /^logo: \.\.\/_assets\/logos\/aicc\.svg$/m.test(talkText) && /^author: Dominik Lukeš$/m.test(talkText), talkText.split('---')[1])
  record('app defaults do not override the vault', !talkText.includes('App Default Uni') && !talkText.includes('Settings Author'))
  const origin = await page.evaluate((p) => window.tw.vault.talkDefaults(p), talk.outlinePath)
  record('the talk’s vault says where each value comes from', !!origin && origin.values.filter((v) => v.source === 'vault').length === 3 && origin.values.some((v) => v.key === 'author' && v.source === 'personal'), JSON.stringify(origin))
  await page.locator('aside.talk-list button[aria-label="Refresh"]').click()
  await page.waitForTimeout(800)
  const opened = await openTalkByTitle(page, 'Untitled talk').then(() => true).catch(() => false)
  if (opened && await page.locator('.tw-inspector').count() === 0) {
    await page.locator('.cm-content').first().click()
    await page.keyboard.press('Meta+p') // Inspector mode
  }
  const originSection = page.locator('[data-vault-origin]')
  if (opened && await originSection.waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false)) {
    await originSection.scrollIntoViewIfNeeded()
    await shot(page, 'new-talk-where-from')
    record('the Inspector shows “Where these come from” on the title slide', (await originSection.innerText()).includes('come from Workshops'))
  } else {
    record('the Inspector shows “Where these come from” on the title slide', false, `opened=${opened}`)
  }
  await ensureTalksMode(page)

  // ── (C) EDIT ──
  const withUnknown = { ...created, fromANewerBuild: { keep: true } }
  writeFileSync(vaultJson(workshops), JSON.stringify(withUnknown, null, 2))
  await header(page, 'Workshops').locator('.tl-vmore').click()
  await page.getByRole('menuitem', { name: 'Edit this vault…' }).click()
  const edit = page.locator('[data-vault-sheet="edit"]')
  await edit.waitFor({ state: 'visible', timeout: 8000 })
  record('⋯ › Edit this vault… opens the sheet with the vault’s values', (await page.locator('[data-field="affiliation"]').inputValue()) === 'University of Oxford' && (await page.locator('[data-field="author"]').inputValue()) === 'Dominik Lukeš')
  await page.locator('[data-field="shared"]').click()
  await shot(page, 'edit-vault')
  await nextPick(app, join(brand, 'notes.txt'))
  await page.locator('[data-choose-logo]').click()
  await page.locator('[data-vault-sheet-error]').waitFor({ state: 'visible', timeout: 5000 })
  record('a non-image logo is refused with a message', /SVG, PNG, JPEG, WebP or GIF/.test(await page.locator('[data-vault-sheet-error]').innerText()))
  const insideLogoBefore = readFileSync(join(workshops, '_assets', 'logos', 'aicc.svg'), 'utf8')
  await nextPick(app, join(brand, 'aicc.svg'))
  await page.locator('[data-choose-logo]').click()
  await page.waitForFunction(() => document.querySelector('[data-vault-logo]')?.getAttribute('data-vault-logo') === 'upload:aicc.svg', null, { timeout: 5000 })
  record('a logo outside the vault is accepted and not copied before Done', JSON.stringify(readdirSync(join(workshops, '_assets', 'logos'))) === '["aicc.svg"]')
  await shot(page, 'edit-vault-outside-logo')
  await page.locator('[data-field="affiliation"]').fill('Oxford AI Competency Centre')
  await page.locator('[data-vault-sheet-submit]').click()
  await edit.waitFor({ state: 'detached', timeout: 8000 })
  const edited = JSON.parse(readFileSync(vaultJson(workshops), 'utf8'))
  record('Done rewrites the vault file with unknown keys kept and the id unchanged',
    edited.affiliation === 'Oxford AI Competency Centre' && edited.shared === true && edited.fromANewerBuild?.keep === true && edited.id === ws.id && edited.created_by === 'Dominik Lukeš')
  record('Done copies the outside logo into _assets/logos with " 2" on the name clash and stores that path',
    edited.logo === '_assets/logos/aicc 2.svg' && readFileSync(join(workshops, '_assets', 'logos', 'aicc 2.svg'), 'utf8') === readFileSync(join(brand, 'aicc.svg'), 'utf8'), edited.logo)
  record('the existing logo of the same name is not overwritten', readFileSync(join(workshops, '_assets', 'logos', 'aicc.svg'), 'utf8') === insideLogoBefore)
  record('the vault file still holds no absolute path', strings(edited).every((x) => !looksAbsolute(x)) && !JSON.stringify(edited).includes(tempRoot))

  // ── (C2) PERSONAL-only save on a plain folder ──
  await header(page, 'Personal').locator('.tl-vmore').click()
  await page.getByRole('menuitem', { name: 'Edit this vault…' }).click()
  const plainEdit = page.locator('[data-vault-sheet="edit"]')
  await plainEdit.waitFor({ state: 'visible', timeout: 8000 })
  await page.locator('[data-field="author"]').fill('Dominik (personal vault)')
  await page.locator('[data-swatch="#be185d"]').click()
  await page.locator('[data-vault-sheet-submit]').click()
  await plainEdit.waitFor({ state: 'detached', timeout: 8000 })
  await page.waitForTimeout(400)
  const personalView = (await page.evaluate(() => window.tw.vault.list())).find((v) => v.name === 'Personal')
  record('a personal-only save on a plain folder leaves no .talkweaver folder', !existsSync(join(personal, '.talkweaver')))
  record('…and the personal settings are kept (badge colour)', personalView?.color === '#be185d', personalView?.color)
  await page.waitForTimeout(500)
  record('the header shows the shared mark', await header(page, 'Workshops').locator('[data-vault-shared]').count() === 1)

  // ── (D) JOIN ──
  const annaBefore = snap(shared)
  await nextPick(app, shared)
  await page.locator('[data-add-vault]').click()
  const join_ = page.locator('[data-vault-sheet="join"]')
  await join_.waitFor({ state: 'visible', timeout: 8000 })
  const joinText = await join_.innerText()
  record('a folder with a vault file opens “This folder is already a vault”, set up by its creator', /already a vault/i.test(joinText) && joinText.includes('Set up by Anna Novak'))
  record('the join sheet asks only for your name and badge (shared values read-only)', await join_.locator('input').count() === 2 && (await join_.locator('label').first().innerText()) === 'Your name in this vault')
  await page.locator('[data-field="author"]').fill('Dominik Lukeš')
  await shot(page, 'join-vault')
  await page.locator('[data-vault-sheet-submit]').click()
  await header(page, 'AI and assessment workshop').waitFor({ state: 'attached', timeout: 8000 })
  const vaults2 = await page.evaluate(() => window.tw.vault.list())
  record('Open vault adopts the file’s id', vaults2.some((v) => v.id === annaFile.id && v.name === annaFile.name && v.shared), JSON.stringify(vaults2.map((v) => [v.id, v.name])))
  record('joining does not touch the vault file', JSON.stringify(snap(shared)) === JSON.stringify(annaBefore))

  // ── (E) REFUSED ──
  await nextPick(app, sharedCopy)
  await page.locator('[data-add-vault]').click()
  const refused = page.locator('[data-vault-sheet="refused"]')
  await refused.waitFor({ state: 'visible', timeout: 8000 })
  const refusedText = await refused.innerText()
  record('a second folder with the same vault id is refused, naming the first', (await refused.getAttribute('data-refusal')) === 'duplicate-id' && refusedText.includes('AI and assessment workshop') && !refusedText.includes(tempRoot), refusedText)
  await shot(page, 'duplicate-refused')
  await page.locator('[data-show-vault]').click()
  await refused.waitFor({ state: 'detached', timeout: 5000 })
  const vaults3 = await page.evaluate(() => window.tw.vault.list())
  record('nothing was added', vaults3.length === vaults2.length)
  await nextPick(app, workshops)
  await page.locator('[data-add-vault]').click()
  await refused.waitFor({ state: 'visible', timeout: 8000 })
  record('a folder already open as a vault is refused with “Show Workshops”', (await refused.getAttribute('data-refusal')) === 'duplicate' && (await page.locator('[data-show-vault]').innerText()) === 'Show Workshops')
  await shot(page, 'already-open-refused')
  await page.keyboard.press('Escape')

  // ── (F) QUIET: open/close, relaunch ──
  const before = { workshops: snap(workshops), shared: snap(shared), copy: snap(sharedCopy) }
  const wsId = ws.id
  await page.evaluate((id) => window.tw.vault.setOpen(id, false), wsId)
  await page.waitForTimeout(400)
  await page.evaluate((id) => window.tw.vault.setOpen(id, true), wsId)
  await page.waitForTimeout(800)
  await app.close()
  ;({ app, page } = await launch())
  await page.waitForTimeout(1500)
  await page.evaluate(() => window.tw.vault.list())
  const after = { workshops: snap(workshops), shared: snap(shared), copy: snap(sharedCopy) }
  record('open, close, relaunch and list write no vault file (bytes and mtime)', JSON.stringify(after) === JSON.stringify(before), JSON.stringify({ before: Object.fromEntries(Object.entries(before).map(([k, v]) => [k, v?.mtime])), after: Object.fromEntries(Object.entries(after).map(([k, v]) => [k, v?.mtime])) }))
  record('the migrated vault (from vaultRoot) is still a plain folder: no vault file', !existsSync(join(personal, '.talkweaver')))
  const relaunched = await page.evaluate(() => window.tw.vault.list())
  record('ids survive the relaunch', relaunched.some((v) => v.id === wsId) && relaunched.some((v) => v.id === annaFile.id))
} catch (e) {
  record('vault-file harness completed without throwing', false, String(e && e.stack ? e.stack : e))
} finally {
  const failed = results.filter((r) => !r.pass)
  console.log(`\n=== VAULT-FILE SUMMARY: ${results.length - failed.length}/${results.length} passed ===`)
  await app.close().catch(() => {})
  process.exit(failed.length ? 1 : 0)
}
