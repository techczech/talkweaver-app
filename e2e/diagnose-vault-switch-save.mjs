// Real-Electron harness: an editor still holding a talk after the vault root changes.
//
// The outline-writing handlers refuse an outline that is not inside the CURRENT vault. The refusal
// must come back as each handler's own reply — never a thrown error, which reaches the renderer as a
// rejected invoke: the autosave (inside a setTimeout) would then fail silently, the status bar keep
// "Saved", and the typing be lost with no notice.
//
//   (D) DIRECT — writeOutline / readOutline / build / thumbnails on an outline outside the vault
//       RESOLVE (no rejection) with the refusal shape, and write nothing.
//   (S) SWITCH — open a talk, change the vault root, type: the "not in your current vault … not
//       saved" notice appears, and nothing is written anywhere (both vaults listed before/after).
//
// Run: cd talk-weaver && npm run build >/dev/null 2>&1 && node e2e/diagnose-vault-switch-save.mjs
import { _electron as electron } from 'playwright'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { openTalkByTitle } from './lib/talklist.mjs'
import { fileURLToPath } from 'url'
import { dirname, join, relative } from 'path'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = join(__dirname, '..')

const results = []
function record(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const TITLE = 'Switch Talk'
const OUTLINE = ['---', `title: ${TITLE}`, 'outline_version: 2', '---', '', '## Section', '',
  '### First slide {id=sw1}', '', 'Body one.', '', '### Second slide {id=sw2}', '', 'Body two.', ''].join('\n')

const tempRoot = mkdtempSync(join(tmpdir(), 'tw-e2e-vault-switch-'))
const vaultA = join(tempRoot, 'vault-a')
const vaultB = join(tempRoot, 'vault-b')
const outside = join(tempRoot, 'outside')
const userDataDir = join(tempRoot, 'userData')
const talkDir = join(vaultA, 'switch-talk')
const OUTLINE_PATH = join(talkDir, 'switch-talk-outline.md')
const OUTSIDE_PATH = join(outside, 'loose-talk', 'loose-talk-outline.md')
mkdirSync(talkDir, { recursive: true })
mkdirSync(join(vaultB, 'other-talk'), { recursive: true })
writeFileSync(join(vaultB, 'other-talk', 'other-talk-outline.md'), OUTLINE.replace(TITLE, 'Other Talk'))
mkdirSync(dirname(OUTSIDE_PATH), { recursive: true })
writeFileSync(OUTSIDE_PATH, OUTLINE.replace(TITLE, 'Loose Talk'))
writeFileSync(OUTLINE_PATH, OUTLINE)
mkdirSync(userDataDir, { recursive: true })
writeFileSync(join(userDataDir, 'config.json'), JSON.stringify({ vaultRoot: vaultA }, null, 2))

// Every file under the two vaults and the outside folder, with its size and content hash stand-in.
function snapshot() {
  const out = []
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name)
      const st = statSync(p)
      if (st.isDirectory()) { out.push(relative(tempRoot, p) + '/'); walk(p) } else out.push(`${relative(tempRoot, p)} ${st.size} ${readFileSync(p, 'utf8').length}`)
    }
  }
  for (const root of [vaultA, vaultB, outside]) walk(root)
  return out.join('\n')
}

await ensureFreshBuild(REPO)
const app = await electron.launch({ args: ['.', '--user-data-dir=' + userDataDir], cwd: REPO, env: { ...process.env, TW_E2E: '1' } })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1200)

async function toastText() {
  return page.locator('[role="status"]').innerText().catch(() => '')
}

try {
  // ── (D) DIRECT: refusals resolve with each handler's shape and write nothing ──
  const before = snapshot()
  const direct = await page.evaluate(async (outsidePath) => {
    const settle = async (p) => { try { return { resolved: true, value: await p } } catch (e) { return { resolved: false, error: String(e) } } }
    return {
      write: await settle(window.tw.talk.writeOutline(outsidePath, '---\ntitle: X\n---\n\n### Hacked {id=h1}\n\nnew\n')),
      read: await settle(window.tw.talk.readOutline(outsidePath)),
      build: await settle(window.tw.talk.build(outsidePath, '---\ntitle: X\n---\n\n### A\n')),
      thumbs: await settle(window.tw.talk.thumbnails(outsidePath, '---\ntitle: X\n---\n\n### A\n')),
    }
  }, OUTSIDE_PATH)
  record('DIRECT: writeOutline outside the vault resolves {ok:false, refused:"outside-vault"} (no rejection)',
    direct.write.resolved && direct.write.value?.ok === false && direct.write.value?.refused === 'outside-vault' && /not in your current vault/.test(direct.write.value?.error ?? ''),
    JSON.stringify(direct.write))
  record('DIRECT: readOutline outside the vault resolves null', direct.read.resolved && direct.read.value === null, JSON.stringify(direct.read))
  record('DIRECT: build outside the vault resolves {success:false, error}', direct.build.resolved && direct.build.value?.success === false && /not in your current vault/.test(direct.build.value?.error ?? ''), JSON.stringify(direct.build))
  record('DIRECT: thumbnails outside the vault resolves null', direct.thumbs.resolved && direct.thumbs.value === null, JSON.stringify(direct.thumbs))
  record('DIRECT: nothing was written anywhere', snapshot() === before)

  // ── (S) SWITCH: an open talk from the previous vault is never saved, and says so ──
  await openTalkByTitle(page, TITLE)
  await page.waitForSelector('.cm-content', { timeout: 8000 })
  await page.waitForTimeout(1500)
  const beforeSwitch = snapshot()
  await page.evaluate((root) => window.tw.vault.setRoot(root), vaultB)
  await page.waitForTimeout(400)
  await page.locator('.cm-content .cm-line', { hasText: 'Body two.' }).first().click()
  await page.keyboard.press('End')
  await page.keyboard.type(' TYPED-AFTER-SWITCH')
  await page.waitForTimeout(2600) // > 1500ms autosave debounce
  const text = await toastText()
  record('SWITCH: typing after the vault changed shows the not-saved notice',
    /not in your current vault; it was not saved/.test(text), JSON.stringify(text.slice(0, 200)))
  const after = snapshot()
  record('SWITCH: nothing was written in either vault or outside',
    after === beforeSwitch && !readFileSync(OUTLINE_PATH, 'utf8').includes('TYPED-AFTER-SWITCH'))
  const body = await page.locator('body').innerText().catch(() => '')
  record('SWITCH: the status bar shows the edits as unsaved, not "Saved"', body.includes('● Unsaved') && !/Saved just now/.test(body))
} catch (e) {
  record('vault-switch harness completed without throwing', false, String(e && e.stack ? e.stack : e))
} finally {
  const failed = results.filter((r) => !r.pass)
  console.log(`\n=== VAULT-SWITCH-SAVE SUMMARY: ${results.length - failed.length}/${results.length} passed ===`)
  await app.close()
  process.exit(failed.length === 0 ? 0 : 1)
}
