// Journey stage `setup-folder` (0.45, two Macs): two app instances, each on its own profile, its own vault and
// its own Mac name, share one set-up folder in a temporary "Dropbox". The first Mac chooses the folder and sets a
// shortcut, the publishing site and a handout address; the second chooses the same folder, reads what applying
// changes, applies, and then shows the same shortcut and site. A later change on the first arrives on the second,
// listed with Undo. Every state of Settings › Set-up folder is shot at 1000 px (artefacts/journey/setup-folder/).
// Deterministic: each Mac reads and writes when Read now is pressed, never on a timer the stage waits for.
//   node scripts/journeys/setup-folder.mjs
import { mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { launch, closeApp, runFolders, ledger, shooter, pause, hardLimit, tempDir } from './lib.mjs'
import { makeVault } from './talk.mjs'
import { testProfileEnv } from '../../e2e/lib/test-profile.mjs'
import { openSettingsWindow } from '../../e2e/lib/settings-window.mjs'

hardLimit(Number(process.env.TW_LIMIT_MS || 300000), 'setup-folder')
const { out, state } = runFolders('setup-folder')
const { record, harness } = ledger(out, 'setup-folder')
const shot = shooter(out)
const shared = join(tempDir('tw-journey-shared-'), 'Dropbox')
mkdirSync(shared, { recursive: true })
const setupDir = join(shared, 'TalkWeaver set-up')
const SITE = 'journey-talks'
const COMMAND = 'research-panel'
const CHORD = '⌘⌥⇧9'
const HANDOUTS = 'https://handouts.example.org'

function profile(tag, computerName) {
  const { vault } = makeVault(join(state, tag))
  const userData = join(tempDir(`tw-journey-${tag}-`), 'userData')
  mkdirSync(userData, { recursive: true })
  writeFileSync(join(userData, 'config.json'), JSON.stringify({ vaultRoot: vault, theme: 'light', computerName }))
  return userData
}
const waitFor = async (fn, ms = 20000) => { const until = Date.now() + ms; while (Date.now() < until) { const v = await fn().catch(() => null); if (v) return v; await pause(150) } return null }
const stateOf = (sw) => sw.locator('[data-settings-page="setup-folder"]').getAttribute('data-setup-folder-state').catch(() => null)
const view = (sw) => sw.evaluate(async () => { const v = await window.bridleSettings.view(); return { settings: v.state.settings, keys: v.state.keys } })
const readNow = async (sw) => { await sw.locator('[data-setup-folder="read-now"]').click(); await pause(300); await sw.locator('[data-setup-folder="read-now"]:not([disabled])').waitFor({ timeout: 15000 }) }
/** Nothing sideways out of the page at 1000 px: no horizontal scroll, no element past the pane's edges. */
const fits = (sw) => sw.evaluate(() => {
  const section = document.querySelector('[data-settings-page="setup-folder"]')
  const pane = section?.parentElement
  if (!section || !pane) return { ok: false, why: 'no page' }
  const box = pane.getBoundingClientRect()
  const outside = [...section.querySelectorAll('*')].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (r.left < box.left - 0.5 || r.right > box.right + 0.5) })
    .slice(0, 4).map((el) => `${el.tagName.toLowerCase()} "${(el.textContent ?? '').trim().slice(0, 30)}"`)
  const wide = Math.max(document.documentElement.scrollWidth - document.documentElement.clientWidth, pane.scrollWidth - pane.clientWidth)
  return { ok: window.innerWidth === 1000 && wide <= 0 && outside.length === 0, width: window.innerWidth, wide, outside }
})
const fitLog = []
const shotAt = async (sw, name) => { const f = await fits(sw); fitLog.push({ name, ...f }); return shot(sw, name) }

let appA, appB
try {
  const userA = profile('a', 'Journey Mac A')
  const userB = profile('b', 'Journey Mac B')
  ;({ app: appA } = await launch(userA, { extraEnv: testProfileEnv(userA) }))
  const mainA = await appA.firstWindow()
  const swA = await openSettingsWindow(appA, mainA, 'setup-folder')
  await waitFor(async () => (await stateOf(swA)) === 'off')
  await shotAt(swA, 'a-off')

  // Mac A: the folder (through the Set-up folder setting, as its search row and the settings command line set it),
  // a shortcut, the publishing site and a handout address. Read now writes A's file.
  await swA.evaluate(async ({ folder, site, command, chord, handouts }) => {
    await window.bridleSettings.set('setup.folder', folder)
    await window.bridleSettings.set('publishing.cloudflareSite', site)
    await window.bridleSettings.set('publishing.customDomain', handouts)
    await window.bridleSettings.rebind(command, chord)
  }, { folder: shared, site: SITE, command: COMMAND, chord: CHORD, handouts: HANDOUTS })
  const joinedA = await waitFor(async () => (await stateOf(swA)) === 'joined')
  await readNow(swA)
  const filesA = readdirSync(setupDir).filter((n) => /^mac-[0-9a-f-]{36}\.json$/.test(n))
  const fileA = filesA[0] ? JSON.parse(readFileSync(join(setupDir, filesA[0]), 'utf8')) : null
  const listedA = await swA.locator('[data-setup-folder-mac="Journey Mac A"]').count()
  record('setup-folder.first-mac', !!joinedA && filesA.length === 1 && fileA?.settings?.['publishing.cloudflareSite']?.value === SITE && fileA?.shortcuts?.[COMMAND]?.value === CHORD && listedA === 1,
    `joined ${!!joinedA}; files ${filesA.join(', ')}; site in file ${fileA?.settings?.['publishing.cloudflareSite']?.value}; shortcut ${fileA?.shortcuts?.[COMMAND]?.value}; listed ${listedA}`, await shotAt(swA, 'a-joined'))

  // Mac B: the same folder. What applying changes is shown first; nothing changes until Apply.
  ;({ app: appB } = await launch(userB, { extraEnv: testProfileEnv(userB) }))
  const mainB = await appB.firstWindow()
  const swB = await openSettingsWindow(appB, mainB, 'setup-folder')
  await waitFor(async () => (await stateOf(swB)) === 'off')
  await shotAt(swB, 'b-off')
  const beforeB = await view(swB)
  await swB.evaluate((folder) => window.bridleSettings.set('setup.folder', folder), shared)
  const joining = await waitFor(async () => (await stateOf(swB)) === 'joining' && (await swB.locator('[data-setup-folder="preview"]').count()) === 1)
  const rows = await swB.locator('[data-setup-folder="preview"] [data-setup-folder-row]').evaluateAll((els) => els.map((e) => e.getAttribute('data-setup-folder-row')))
  const previewShot = await shotAt(swB, 'b-preview')
  const duringB = await view(swB)
  const writtenByB = readdirSync(setupDir).filter((n) => /^mac-/.test(n)).length
  const unchanged = JSON.stringify({ s: { ...duringB.settings, 'setup.folder': undefined }, k: duringB.keys }) === JSON.stringify({ s: { ...beforeB.settings, 'setup.folder': undefined }, k: beforeB.keys })
  record('setup-folder.preview-first', !!joining && rows.includes('Publishing site') && rows.some((r) => r.startsWith('Shortcut:')) && unchanged && writtenByB === 1,
    `preview rows: ${rows.join(' | ')}; settings unchanged before Apply ${unchanged}; files in the folder ${writtenByB}`, previewShot)

  // Not now: nothing changes; Review and apply brings the preview back.
  await swB.locator('[data-setup-folder="not-now"]').click()
  await swB.locator('[data-setup-folder="not-applied"]').waitFor({ timeout: 10000 })
  await shotAt(swB, 'b-not-now')
  await swB.getByRole('button', { name: 'Review and apply…' }).click()
  await swB.locator('[data-setup-folder="apply"]').click()
  const joinedB = await waitFor(async () => (await stateOf(swB)) === 'joined')
  const afterB = await view(swB)
  const afterA = await view(swA)
  const same = afterB.settings['publishing.cloudflareSite'] === SITE && afterA.settings['publishing.cloudflareSite'] === SITE && afterB.keys[COMMAND] === CHORD && afterA.keys[COMMAND] === CHORD
  await swB.locator('[data-setup-folder-suggestion="handoutAddress"]').waitFor({ timeout: 10000 }).catch(() => {})
  const suggestion = await swB.locator('[data-setup-folder-suggestion="handoutAddress"]').count()
  const handoutKept = (afterB.settings['publishing.customDomain'] ?? '') === ''
  record('setup-folder.apply-same', !!joinedB && same && suggestion === 1 && handoutKept,
    `B site ${afterB.settings['publishing.cloudflareSite']}, A site ${afterA.settings['publishing.cloudflareSite']}; B ${COMMAND} ${afterB.keys[COMMAND]}, A ${afterA.keys[COMMAND]}; handout address offered to confirm ${suggestion === 1}, not applied ${handoutKept}`, await shotAt(swB, 'b-joined'))

  // A later change on A arrives on B, listed as from A, with Undo.
  await swA.evaluate(() => window.bridleSettings.set('presenting.warnAt', 12))
  await readNow(swA)
  await readNow(swB)
  const arrived = await waitFor(async () => (await view(swB)).settings['presenting.warnAt'] === 12, 10000)
  const batch = swB.locator('[data-setup-folder-batch="Journey Mac A"]').first()
  const batchText = await batch.innerText().catch(() => '')
  const undo = await batch.locator('[data-setup-folder="undo"]').count()
  record('setup-folder.later-change', !!arrived && batchText.includes('Clock turns amber') && undo === 1,
    `B warnAt ${(await view(swB)).settings['presenting.warnAt']}; newest batch "${batchText.replace(/\s+/g, ' ').slice(0, 160)}"; Undo ${undo}`, await shotAt(swB, 'b-later-change'))

  // A conflict copy of A's file is not read and is named, with Show in Finder.
  if (filesA[0]) copyFileSync(join(setupDir, filesA[0]), join(setupDir, filesA[0].replace('.json', ' 2.json')))
  await readNow(swB)
  const skipped = swB.locator('[data-setup-folder-skipped="copy"]')
  await skipped.first().waitFor({ timeout: 10000 }).catch(() => {})
  const skippedText = await skipped.first().innerText().catch(() => '')
  record('setup-folder.skipped-named', skippedText.includes(' 2.json') && skippedText.includes('Show in Finder'), skippedText.replace(/\s+/g, ' ').slice(0, 200), await shotAt(swB, 'b-skipped'))

  // Nothing in the folder names a place or a key.
  const texts = readdirSync(setupDir).map((n) => readFileSync(join(setupDir, n), 'utf8'))
  const leaks = texts.flatMap((t) => [...['/Users/', '/private/', '/var/folders', userA, userB, 'accounts.cloudflare', 'accounts.recording', 'setup.folder', 'recording.microphone', 'publishing.customDomain'].filter((x) => t.includes(x))])
  record('setup-folder.no-secret-or-path', leaks.length === 0 && texts.length >= 3, `files ${texts.length}; found: ${leaks.join(', ') || 'nothing'}`)

  // Stop using the folder on B: the file stays, Remove this Mac's file is offered. Then a folder that is not there.
  await swB.locator('[data-setup-folder="stop"]').click()
  await waitFor(async () => (await stateOf(swB)) === 'off')
  await swB.locator('[data-setup-folder="left-file"]').waitFor({ timeout: 10000 }).catch(() => {})
  await shotAt(swB, 'b-left')
  await swB.evaluate((folder) => window.bridleSettings.set('setup.folder', folder), join(shared, 'gone', 'away'))
  await waitFor(async () => (await stateOf(swB)) === 'unavailable')
  await shotAt(swB, 'b-unavailable')

  const bad = fitLog.filter((f) => !f.ok)
  record('setup-folder.fits-1000', fitLog.length >= 8 && bad.length === 0, `${fitLog.length} states at 1000 px; ${bad.length ? JSON.stringify(bad).slice(0, 600) : 'all fit'}`, '', { states: fitLog })
} catch (e) {
  harness(String(e?.stack || e).slice(0, 900))
} finally {
  await closeApp(appB)
  await closeApp(appA)
}
