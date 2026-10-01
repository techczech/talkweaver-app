// Real-Electron harness for slides across vaults (several-vaults ticket 06; LOCKED-add-slide).
// Three open vaults: Personal, Oxford AICC and the AI and assessment workshop (the open talk's vault).
//
//   (A) CHIPS    — ⌘S opens the Slide Browser with a chip per open vault, the talk's vault first and
//                  marked "this talk", every vault on; results carry their vault's badge and name, the
//                  talk's vault first; a chip leaves its vault out and brings it back; a search with
//                  matches only in a switched-off vault says so and offers "Switch it on".
//   (B) INSERT   — two Personal slides are inserted into the workshop talk: the image travels into the
//                  workshop's _assets, a PDF link and a missing image are cut to their file names, a free
//                  id is kept, an id the workshop already uses is re-stamped, the workshop's slide ledger
//                  records origin {vault_id, vault_name, slide_id, inserted_by} only, and the Personal
//                  vault is untouched.
//   (C) LEAK     — every file written in the workshop vault during the insert is grepped for the Personal
//                  vault's absolute root and its folder names, the temp root and /Users/: none found.
//   (D) INSPECTOR — this Mac: "From: Personal vault · Talk: Metaphor talk 2026". A colleague's Mac (only
//                  the workshop vault, set up by Anna; no private record): "From Dominik Lukeš · Personal
//                  vault · History not available here" — the inserter, as the ledger records it.
//
// Run: cd talk-weaver && npm run build >/dev/null 2>&1 && TW_E2E=1 node e2e/diagnose-slides-across-vaults.mjs
import { _electron as electron } from 'playwright'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { ensureTalksMode, openTalkByTitle } from './lib/talklist.mjs'
import { fileURLToPath } from 'url'
import { basename, dirname, join, relative } from 'path'
import { createHash } from 'crypto'
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

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
const tempRoot = realpathSync(mkdtempSync(join(tmpdir(), 'tw-e2e-xvault-')))
// Folder names differ from the vault names on purpose: the vault name is recorded, folders never are.
const personal = join(tempRoot, 'Dominik Stash')
const oxford = join(tempRoot, 'Oxford Share')
const workshop = join(tempRoot, 'Workshop Shared')
const vaultFile = (root, file) => { mkdirSync(join(root, '.talkweaver'), { recursive: true }); writeFileSync(join(root, '.talkweaver', 'vault.json'), JSON.stringify({ schema: 1, created_at: '2026-09-29T09:00:00.000Z', shared: true, ...file }, null, 2)) }
vaultFile(personal, { id: 'vault-personal-0001', name: 'Personal', shared: false, created_by: 'Dominik Lukeš' })
vaultFile(oxford, { id: 'vault-oxford-0001', name: 'Oxford AICC', created_by: 'Dominik Lukeš' })
// The workshop was set up by Anna: the colleague line must name who INSERTED the slide, not her.
vaultFile(workshop, { id: 'vault-workshop-0001', name: 'AI and assessment workshop', created_by: 'Anna Novak' })

const talk = (root, folder, slug, title, slides) => {
  const dir = join(root, ...folder, slug)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${slug}-outline.md`)
  writeFileSync(path, ['---', `title: ${title}`, 'outline_version: 2', '---', '', '## Section', '', ...slides.flatMap((s) => [s, ''])].join('\n'))
  return path
}
const SRC_OUTLINE = talk(personal, ['private-lectures'], 'metaphor-talk-2026', 'Metaphor talk 2026', [
  `### Metaphors are maps, not mirrors {id=mapx1}\n\nA map keeps what matters and leaves out the rest.\n\n![A map](assets/map.png)\n\n[The handout](<${join(personal, 'private-lectures', 'handout.pdf')}>)\n\n![Old sketch](../other-talk/assets/sketch.png)\n\n<img src="${join(personal, 'private-lectures', 'diagram.png')}" alt="Diagram">\n\n<img srcset="${join(personal, 'private-lectures', 'wide.png')} 2x, ${join(personal, 'private-lectures', 'narrow.png')} 1x" alt="Sizes">\n\nSee the [old deck][deck].\n\n[deck]: ${join(personal, 'private-lectures', 'old deck.pdf')} "Old deck"`,
  '### Slides that scale, like a map {id=zzz99}\n\nA slide is a map of a talk: a metaphor for scale.'
])
mkdirSync(join(dirname(SRC_OUTLINE), 'assets'), { recursive: true })
writeFileSync(join(dirname(SRC_OUTLINE), 'assets', 'map.png'), PNG)
talk(oxford, ['workshops'], 'marking-with-rubrics', 'Marking with rubrics, 2025', [
  '### The rubric is a map {id=rub01}\n\nRubrics show one route through the material: a metaphor.\n\nA compass points one way.'
])
const TARGET = talk(workshop, [], 'ai-and-assessment-workshop', 'AI and assessment workshop', [
  '### Why assessment breaks first {id=zzz99}\n\nAssessment was built on text being scarce.',
  '### Three failure modes {id=fail2}\n\nSubstitution, laundering, scaffolding drift.'
])
talk(workshop, [], 'oral-assessment-pilot', 'Oral assessment pilot', [
  '### Assessment as a river crossing {id=rivr1}\n\nEvery crossing is a route: a metaphor for assessment.'
])

const vaults = [
  { id: 'vault-personal-0001', root: personal, open: true, order: 0 },
  { id: 'vault-oxford-0001', root: oxford, open: true, order: 1 },
  { id: 'vault-workshop-0001', root: workshop, open: true, order: 2 }
]
const config = (list, author) => JSON.stringify({ vaults: list, vaultRoot: list[0].root, vaultRootMirrored: list[0].root, vaultPersonal: Object.fromEntries(list.map((v) => [v.id, { author }])) }, null, 2)
const userData = join(tempRoot, 'userData-dominik')
const annaData = join(tempRoot, 'userData-anna')
for (const [dir, list, author] of [[userData, vaults, 'Dominik Lukeš'], [annaData, [{ ...vaults[2], order: 0 }], 'Anna Novak']]) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), config(list, author))
}

const walk = (dir) => existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]) : []
const fingerprint = (root) => new Map(walk(root).map((f) => [f, createHash('sha256').update(readFileSync(f)).digest('hex')]))
const shot = (page, name) => page.screenshot({ path: join(SHOTS, `06-${name}.png`) })

await ensureFreshBuild(REPO)
async function launch(dir) {
  const app = await electron.launch({ args: ['.', '--user-data-dir=' + dir], cwd: REPO, env: { ...process.env, TW_E2E: '1' } })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) w.setSize(1440, 900) })
  await page.waitForTimeout(1200)
  return { app, page }
}
async function showInspectorFor(page, headingText) {
  await page.locator('.cm-content .cm-line', { hasText: headingText }).first().click()
  await page.waitForTimeout(300)
  if (await page.locator('.tw-inspector').count() === 0) {
    await page.keyboard.press('Meta+p')
    await page.waitForTimeout(600)
  }
  // The Inspector follows the caret once the talk has compiled: move the caret onto the heading again.
  for (let i = 0; i < 3; i += 1) {
    await page.locator('.cm-content .cm-line', { hasText: headingText }).first().click().catch(() => {})
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowUp')
    if (await page.locator('.tw-inspector', { hasText: headingText }).count() > 0) break
    await page.waitForTimeout(1200)
  }
  const card = page.locator('[data-slide-provenance]')
  const shown = await card.waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false)
  if (shown) await card.scrollIntoViewIfNeeded()
  return shown ? card : null
}

let { app, page } = await launch(userData)
let before = null
try {
  await ensureTalksMode(page)
  await openTalkByTitle(page, 'AI and assessment workshop')
  await page.waitForTimeout(600)
  // The caret at the end of the talk: the inserted slides land after its last slide.
  await page.locator('.cm-content .cm-line', { hasText: 'Substitution, laundering' }).first().click()
  await page.keyboard.press('Meta+ArrowDown')

  // ── (A) CHIPS ──
  await page.keyboard.press('Meta+s')
  await page.locator('.lt-browser-root').waitFor({ state: 'visible', timeout: 8000 })
  const chips = page.locator('[data-vault-chip]')
  await chips.first().waitFor({ state: 'visible', timeout: 8000 })
  const chipNames = await chips.evaluateAll((els) => els.map((e) => e.getAttribute('data-vault-name')))
  record('a chip per open vault, the talk’s vault first', JSON.stringify(chipNames) === JSON.stringify(['AI and assessment workshop', 'Personal', 'Oxford AICC']), JSON.stringify(chipNames))
  record('the talk’s vault chip says “this talk”; every chip is on', (await chips.first().innerText()).includes('this talk') && (await page.locator('[data-vault-chip][aria-pressed="false"]').count()) === 0)
  record('no chip names a folder', !(await page.locator('[data-vault-chips]').innerText()).includes('Stash') && !(await page.locator('[data-vault-chips]').innerText()).includes(tempRoot))
  await shot(page, 'chips')

  await page.locator('.lt-searchfield input').first().fill('metaphor')
  await page.waitForTimeout(1500)
  const cardVaults = async () => page.locator('.lt-card:not(.skeleton)').evaluateAll((els) => els.map((e) => e.querySelector('[data-vault-label]')?.getAttribute('data-vault-label') ?? ''))
  const labelled = await cardVaults()
  record('every result names its vault', labelled.length >= 4 && labelled.every(Boolean), JSON.stringify(labelled))
  const firstOther = labelled.findIndex((v) => v !== 'vault-workshop-0001')
  record('the talk’s vault’s results come first', labelled[0] === 'vault-workshop-0001' && labelled.slice(firstOther).every((v) => v !== 'vault-workshop-0001'), JSON.stringify(labelled))
  record('each chip counts its vault’s matches (Personal: cover, two slides)', (await page.locator('[data-vault-chip="vault-personal-0001"] .n').innerText()) === '3' && (await page.locator('[data-vault-chip="vault-oxford-0001"] .n').innerText()) === '1')
  await shot(page, 'labelled-results')

  await page.locator('[data-vault-chip="vault-oxford-0001"]').click()
  await page.waitForTimeout(400)
  const withoutOxford = await cardVaults()
  record('a chip click leaves that vault out (OFF, count kept)', !withoutOxford.includes('vault-oxford-0001') && (await page.locator('[data-vault-chip="vault-oxford-0001"]').innerText()).includes('OFF') && (await page.locator('[data-vault-chip="vault-oxford-0001"] .n').innerText()) === '1', JSON.stringify(withoutOxford))
  await shot(page, 'chip-off')
  await page.locator('.lt-searchfield input').first().fill('compass')
  await page.waitForTimeout(1300)
  const offNote = page.locator('[data-off-vault-matches]')
  record('no results in the vaults on: the switched-off vault with matches is named, with Switch it on', await offNote.isVisible().catch(() => false) && /1 match in\s*O\s*Oxford AICC, which is off/.test((await offNote.innerText()).replace(/\n/g, ' ')), await offNote.innerText().catch(() => ''))
  await shot(page, 'off-vault-matches')
  await page.locator('[data-switch-on="vault-oxford-0001"]').click()
  await page.waitForTimeout(400)
  record('Switch it on brings the vault back', (await cardVaults()).includes('vault-oxford-0001') && (await page.locator('[data-vault-chip="vault-oxford-0001"]').getAttribute('aria-pressed')) === 'true')

  // ── (B) INSERT two Personal slides (one keeps its id, one collides with the workshop's zzz99) ──
  await page.locator('.lt-searchfield input').first().fill('map')
  await page.waitForTimeout(1300)
  before = fingerprint(workshop)
  const sourceBefore = fingerprint(personal)
  const pick = async (title) => page.locator('.lt-card:not(.skeleton)', { has: page.locator('.lt-l-title', { hasText: title }) }).first().click()
  await pick('Metaphors are maps, not mirrors')
  await pick('Slides that scale, like a map')
  await page.waitForTimeout(200)
  await page.keyboard.press('Meta+Enter')
  await page.waitForTimeout(3000)
  record('⌘↵ inserts and closes the Browser', await page.locator('.lt-browser-root').count() === 0)
  const text = readFileSync(TARGET, 'utf8')
  const scaleId = text.match(/### Slides that scale, like a map[^\n]*\{id=([a-z0-9]+)\}|### Slides that scale, like a map\s*\n\s*\{id=([a-z0-9]+)\}/)
  const newScaleId = scaleId ? (scaleId[1] ?? scaleId[2]) : null
  const sourceAfter = fingerprint(personal)
  record('the SOURCE vault is untouched by the insert', sourceBefore.size === sourceAfter.size && [...sourceBefore].every(([f, h]) => sourceAfter.get(f) === h), `${sourceBefore.size} -> ${sourceAfter.size} files`)
  record('a link to an absolute PDF and a missing relative image are cut to their file names', text.includes('[The handout](handout.pdf)') && text.includes('![Old sketch](sketch.png)') && !text.includes('other-talk'))
  record('an HTML <img> with an absolute src is cut to its file name', text.includes('<img src="diagram.png" alt="Diagram">'))
  record('a srcset and a ref-def with spaces in its absolute path keep only file names', text.includes('<img srcset="wide.png 2x, narrow.png 1x" alt="Sizes">') && text.includes('[deck]: old deck.pdf "Old deck"'), text.split('\n').filter((l) => /srcset|\[deck\]:/.test(l)).join(' | '))
  record('a free id is kept', /### Metaphors are maps, not mirrors(\s*\n\s*| )\{id=mapx1\}/.test(text), text.slice(-400))
  record('an id the workshop already uses is re-stamped', !!newScaleId && newScaleId !== 'zzz99' && (text.match(/\{id=zzz99\}/g) ?? []).length === 1, `new id ${newScaleId}`)
  record('the image travels into the workshop’s pool and the ref is a pool id', /!\[A map\]\((img-[0-9a-f]{7})\)/.test(text) && readdirSync(join(workshop, '_assets')).some((f) => /^img-[0-9a-f]{7}\.(webp|png)$/.test(f)))
  const versionOf = (id) => { const dir = join(workshop, '_SLIDE-VERSIONS', id); return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => readFileSync(join(dir, f), 'utf8')) : [] }
  const originOf = (id) => { const line = versionOf(id).map((b) => b.split('\n').find((l) => l.startsWith('origin: '))).find(Boolean); return line ? JSON.parse(line.slice(8)) : null }
  record('the workshop ledger records origin for the kept id: vault id, vault name, slide id, who inserted it', JSON.stringify(originOf('mapx1')) === JSON.stringify({ vault_id: 'vault-personal-0001', vault_name: 'Personal', slide_id: 'mapx1', inserted_by: 'Dominik Lukeš' }), JSON.stringify(originOf('mapx1')))
  record('… and for the re-stamped id, naming the source slide id', !!newScaleId && JSON.stringify(originOf(newScaleId)) === JSON.stringify({ vault_id: 'vault-personal-0001', vault_name: 'Personal', slide_id: 'zzz99', inserted_by: 'Dominik Lukeš' }), JSON.stringify(newScaleId && originOf(newScaleId)))
  record('the workshop’s own zzz99 keeps no origin', originOf('zzz99') === null)
  const privateFile = join(userData, 'provenance.json')
  const priv = existsSync(privateFile) ? JSON.parse(readFileSync(privateFile, 'utf8')) : null
  record('the source talk and path stay in app data, keyed by <target vault>/<slide id>', !!priv && priv.entries['vault-workshop-0001/mapx1']?.source_talk_title === 'Metaphor talk 2026' && priv.entries['vault-workshop-0001/mapx1']?.source_outline_path === SRC_OUTLINE)

  // ── (C) LEAK SWEEP over every file written in the workshop vault ──
  const after = fingerprint(workshop)
  const written = [...after.keys()].filter((f) => before.get(f) !== after.get(f))
  const needles = [personal, basename(personal), 'private-lectures', 'metaphor-talk-2026', tempRoot, '/Users/', '/private/var/', 'Dominik Stash']
  const leaks = []
  for (const f of written) {
    const body = readFileSync(f).toString('latin1')
    for (const n of needles) if (body.includes(n)) leaks.push(`${relative(workshop, f)} ∋ ${n}`)
  }
  record(`leak sweep: ${written.length} files written in the workshop vault name no source path or folder`, written.length >= 4 && leaks.length === 0, leaks.join('; ') || written.map((f) => relative(workshop, f)).join(', '))

  // ── (D) INSPECTOR on this Mac ──
  const owner = await showInspectorFor(page, 'Metaphors are maps, not mirrors')
  const ownerSummary = owner ? await owner.getAttribute('data-summary') : null
  record('this Mac’s Inspector: From: Personal vault · Talk: Metaphor talk 2026', ownerSummary === 'From: Personal vault · Talk: Metaphor talk 2026' && (await owner.getAttribute('data-slide-provenance')) === 'owner', ownerSummary ?? 'no card')
  if (owner) await shot(page, 'inspector-owner')
  const plain = await showInspectorFor(page, 'Three failure modes')
  record('a slide made here shows no “Where it came from”', plain === null)
} catch (e) {
  record('run', false, String(e && e.stack || e))
} finally {
  await app.close().catch(() => {})
}

// ── (D) a colleague's Mac: only the workshop vault, no private record ──
;({ app, page } = await launch(annaData))
try {
  await ensureTalksMode(page)
  await openTalkByTitle(page, 'AI and assessment workshop')
  await page.waitForTimeout(600)
  const theirs = await showInspectorFor(page, 'Metaphors are maps, not mirrors')
  if (!theirs) {
    const dbg = await page.evaluate(async () => ({ vaults: await window.tw.vault.list(), inspector: document.querySelector('.tw-inspector')?.textContent?.slice(0, 300) ?? null }))
    const outlineNow = await page.evaluate(() => document.querySelector('.cm-content')?.textContent?.slice(0, 400))
    const origin = await page.evaluate((p) => window.tw.ledger.origin(p, 'mapx1'), TARGET)
    console.log('DEBUG', JSON.stringify({ dbg, outlineNow, origin }).slice(0, 1500))
  }
  const summary = theirs ? await theirs.getAttribute('data-summary') : null
  record('a colleague’s Inspector names who inserted it, not who set up the vault: From Dominik Lukeš · Personal vault · History not available here', summary === 'From Dominik Lukeš · Personal vault · History not available here' && (await theirs.getAttribute('data-slide-provenance')) === 'colleague', summary ?? 'no card')
  record('the colleague’s card names no talk and no path', theirs ? !/Metaphor talk 2026|Stash|private-lectures/.test(await theirs.innerText()) : false)
  if (theirs) await shot(page, 'inspector-colleague')
} catch (e) {
  record('colleague run', false, String(e && e.stack || e))
} finally {
  await app.close().catch(() => {})
}

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
