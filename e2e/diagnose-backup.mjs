// Real-Electron harness: presentation backup (the "present from anywhere" safety net).
// Verifies: a sweep writes one <slug>-backup.html per talk into the backup folder; the file is the
// FULL presenter HTML (contains presenter-sync code that share exports strip); change-detection
// re-exports only changed talks; the timer/enable path triggers a sweep.
import { _electron as electron } from 'playwright'
import { fileURLToPath } from 'url'; import { dirname, join } from 'path'
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readdirSync, readFileSync, appendFileSync } from 'fs'; import { tmpdir } from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url)); const REPO = join(__dirname, '..')
const results = []
const rec = (n, p, d) => { results.push({ n, p }); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const root = mkdtempSync(join(tmpdir(), 'tw-e2e-backup-'))
const vault = join(root, 'v'); const ud = join(root, 'ud'); const backupDir = join(root, 'onedrive-backup')
mkdirSync(ud, { recursive: true }); mkdirSync(backupDir, { recursive: true })
for (const [slug, title] of [['talk-a', 'Talk A'], ['talk-b', 'Talk B']]) {
  const d = join(vault, slug); mkdirSync(d, { recursive: true })
  writeFileSync(join(d, `${slug}-outline.md`), `---\ntitle: ${title}\n---\n\n### ${title} opening\n\n- point one\n- point two\n\n### A second slide\n\nSome content.\n`)
}
writeFileSync(join(ud, 'config.json'), JSON.stringify({ vaultRoot: vault, backupFolder: backupDir, backupEnabled: false, backupIntervalMin: 15 }))

const app = await electron.launch({ args: ['.', '--user-data-dir=' + ud], cwd: REPO })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded'); await page.waitForTimeout(800)

const htmlFiles = () => readdirSync(backupDir).filter((f) => f.endsWith('.html'))
try {
  // 1. Force a sweep → one -backup.html per talk.
  const run1 = await page.evaluate(() => window.tw.backup.runNow())
  rec('backup sweep exports all talks', run1 && run1.ok && run1.exported === 2, JSON.stringify(run1))
  const files = htmlFiles()
  rec('one file per talk', files.length === 2, files.join(', '))
  rec('files named *-backup.html', files.every((f) => f.endsWith('-backup.html')) && files.includes('talk-a-backup.html'), files.join(', '))

  // 2. Files are the FULL presenter HTML (presenter-sync code present; share exports strip it) + notes-capable.
  const a = existsSync(join(backupDir, 'talk-a-backup.html')) ? readFileSync(join(backupDir, 'talk-a-backup.html'), 'utf8') : ''
  rec('backup is the full presenter HTML (has presenter sync)', /BroadcastChannel/.test(a) && /<section/.test(a) && a.length > 2000, `len=${a.length} sync=${/BroadcastChannel/.test(a)}`)
  rec('backup contains the talk content', /Talk A opening/.test(a))

  // 3. Change-detection: a non-forced sweep (triggered by enabling) skips unchanged talks.
  await page.evaluate(() => window.tw.settings.setBackup({ enabled: true }))
  await sleep(1500)
  const afterEnable = await page.evaluate(() => window.tw.settings.getBackup())
  rec('unchanged talks are skipped, not re-written', afterEnable?.lastRun && afterEnable.lastRun.exported === 0 && afterEnable.lastRun.skipped === 2, JSON.stringify(afterEnable?.lastRun))

  // 4. Editing one talk → only that talk is re-exported on the next sweep.
  appendFileSync(join(vault, 'talk-a', 'talk-a-outline.md'), '\n### Added later\n\nNew slide.\n')
  await page.evaluate(() => window.tw.settings.setBackup({ enabled: true })) // re-triggers a non-forced sweep
  await sleep(1500)
  const afterEdit = await page.evaluate(() => window.tw.settings.getBackup())
  rec('only the changed talk is re-exported', afterEdit?.lastRun && afterEdit.lastRun.exported === 1 && afterEdit.lastRun.skipped === 1, JSON.stringify(afterEdit?.lastRun))
} catch (e) {
  rec('backup harness completed without throwing', false, String(e && e.stack ? e.stack : e))
} finally {
  const failed = results.filter((r) => !r.p)
  console.log(`\n=== BACKUP SUMMARY: ${results.length - failed.length}/${results.length} passed ===`)
  await app.close()
  process.exit(failed.length === 0 ? 0 : 1)
}
