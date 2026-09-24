// Real-Electron harness: handout PUBLISH integration (Phase 2) — WITHOUT a real deploy. We point
// handoutPublisherPath at a STUB publish script that mimics the real one's contract (stamps
// handout_url, prints `RESULT {json}`). This verifies TalkWeaver's invocation mechanics: publisher
// resolution, node spawn + arg, RESULT parsing, and adopting the stamped outline. The real script
// (dominiks-handouts/scripts/publish-handout.mjs) is the proven process we reuse verbatim.
import { _electron as electron } from 'playwright'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { openFirstTalk } from './lib/talklist.mjs'
import { fileURLToPath } from 'url'; import { dirname, join } from 'path'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'fs'; import { tmpdir } from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url)); const REPO = join(__dirname, '..')
const results = []
const record = (n, p, d) => { results.push({ n, p }); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`) }

const root = mkdtempSync(join(tmpdir(), 'tw-e2e-pub-'))
const vault = join(root, 'v'); const ud = join(root, 'ud'); const td = join(vault, 'pub-fixture')
const handoutsRepo = join(root, 'dominiks-handouts'); const scriptsDir = join(handoutsRepo, 'scripts')
mkdirSync(td, { recursive: true }); mkdirSync(ud, { recursive: true }); mkdirSync(scriptsDir, { recursive: true })

const fxPath = join(td, 'pub-fixture-outline.md')
writeFileSync(fxPath, ['---', 'title: Pub Fixture', '---', '', '### A slide', '', 'Body.', ''].join('\n'))

// STUB publisher: mimics the real script's observable contract (arg = talk dir, stamps handout_url,
// emits a RESULT line). NO build, NO deploy, NO git.
writeFileSync(join(scriptsDir, 'publish-handout.mjs'), `
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
const talkDir = process.argv[2]
const slug = basename(talkDir)
const outline = join(talkDir, slug + '-outline.md')
const url = 'https://handouts.fyi/tst1'
if (existsSync(outline)) {
  let t = readFileSync(outline, 'utf8')
  if (!/^handout_url:/m.test(t)) { t = t.replace(/^---\\n/, '---\\nhandout_url: ' + url + '\\n'); writeFileSync(outline, t) }
}
console.log('RESULT ' + JSON.stringify({ ok: true, verified: 'skipped', url, display: 'handouts.fyi/tst1', buildId: 'stub' }))
console.log('Handout URL: ' + url)
`)

writeFileSync(join(ud, 'config.json'), JSON.stringify({
  vaultRoot: vault,
  handoutPublisherPath: join(scriptsDir, 'publish-handout.mjs')
}))

await ensureFreshBuild(REPO)
const app = await electron.launch({ args: ['.', '--user-data-dir=' + ud], cwd: REPO, env: { ...process.env, TW_E2E: '1' } })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded'); await page.waitForTimeout(1200)

try {
  await openFirstTalk(page)
  await page.waitForSelector('.cm-content', { timeout: 8000 })
  await page.waitForTimeout(300)

  record('toolbar has a Publish button', await page.locator('.toolbar-btn', { hasText: 'Publish' }).count() > 0)

  const content = readFileSync(fxPath, 'utf8')
  const res = await page.evaluate(
    ({ p, c }) => window.tw.talk.publishHandout(p, c),
    { p: fxPath, c: content }
  )
  record('publishHandout succeeds via the publisher script', !!(res && res.success), `res=${JSON.stringify(res)}`)
  record('returns the short handouts.fyi link', res?.url === 'https://handouts.fyi/tst1', `url=${res?.url}`)
  record('returns updatedOutline carrying the handout_url stamp', !!(res?.updatedOutline && res.updatedOutline.includes('handout_url: https://handouts.fyi/tst1')), `stamped=${res?.updatedOutline?.includes('handout_url')}`)
  record('the stamp was written to the outline on disk', readFileSync(fxPath, 'utf8').includes('handout_url: https://handouts.fyi/tst1'))
} catch (e) {
  record('publish harness completed without throwing', false, String(e && e.stack ? e.stack : e))
} finally {
  const failed = results.filter((r) => !r.p)
  console.log(`\n=== PUBLISH-HANDOUT SUMMARY: ${results.length - failed.length}/${results.length} passed ===`)
  await app.close()
  process.exit(failed.length === 0 ? 0 : 1)
}
