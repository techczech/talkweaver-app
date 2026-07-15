// Real-Electron harness: EVERY markdown image previews inline in the editor —
// vault asset (img-XXXXXXX), legacy double-prefix (img-img-XXXXXXX), and a path image
// (assets/pic.png via twfile://). Isolated temp vault + userData.
//
// Run: cd talk-weaver && npm run build >/dev/null 2>&1 && node e2e/diagnose-images.mjs
import { _electron as electron } from 'playwright'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { mkdirSync, mkdtempSync, writeFileSync, copyFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = join(__dirname, '..')
const SHOTS = join(__dirname, 'shots')
mkdirSync(SHOTS, { recursive: true })

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

const results = []
function record(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const tempRoot = mkdtempSync(join(tmpdir(), 'tw-e2e-img-' + String(Date.now()) + '-'))
const tempVault = join(tempRoot, 'vault')
const userDataDir = join(tempRoot, 'userData')
const talkDir = join(tempVault, 'img-fixture')
mkdirSync(join(talkDir, 'assets'), { recursive: true })
mkdirSync(userDataDir, { recursive: true })
const outlinePath = join(talkDir, 'img-fixture-outline.md')
writeFileSync(outlinePath, '---\ntitle: Img Fixture\n---\n\n## S\n\n### Slide\n\nplaceholder\n')
writeFileSync(join(userDataDir, 'config.json'), JSON.stringify({ vaultRoot: tempVault }, null, 2))

const app = await electron.launch({ args: ['.', '--user-data-dir=' + userDataDir], cwd: REPO })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1200)

try {
  // Create a real vault asset via paste, then derive the three references from its id.
  const pasted = await page.evaluate((b64) => {
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return window.tw.asset.pasteImage(bytes.buffer, 'png')
  }, PNG_B64)
  record('paste created a vault asset', !!(pasted && pasted.id), pasted ? pasted.id : 'null')
  const id = pasted.id // img-XXXXXXX

  // Copy that asset into the talk's assets/ so the path image resolves. The paste handler
  // normalises to WebP, so use the actual returned extension, not a hard-coded one.
  const ext = pasted.ext || 'png'
  const assetOnDisk = join(tempVault, '_assets', id + '.' + ext)
  const pathImg = join(talkDir, 'assets', 'pic.' + ext)
  if (existsSync(assetOnDisk)) copyFileSync(assetOnDisk, pathImg)
  // The imported-Obsidian case: a file whose REAL name has spaces, referenced URL-encoded.
  const spacedImg = join(talkDir, 'assets', `Pasted image ${ext}.` + ext) // real spaces on disk
  if (existsSync(assetOnDisk)) copyFileSync(assetOnDisk, spacedImg)

  // Write a fixture outline referencing all four image shapes.
  const outline = [
    '---', 'title: Img Fixture', '---', '',
    '## S', '', '### Slide', '',
    `![vault](${id})`, '',
    `![legacy](img-${id})`, '', // ![legacy](img-img-XXXXXXX) — the old double-prefix bug
    `![path](assets/pic.${ext})`, '',
    `![encoded](assets/Pasted%20image%20${ext}.${ext})`, '' // URL-encoded path → real spaced file
  ].join('\n')
  writeFileSync(outlinePath, outline)

  // Open the talk (toggle selection forces a fresh load from disk).
  await page.locator('.talk-item', { hasText: 'Img Fixture' }).first().click()
  await page.waitForSelector('.cm-content', { timeout: 8000 })
  await page.waitForTimeout(2500)

  const info = await page.evaluate(() => {
    const widgets = Array.from(document.querySelectorAll('.cm-content .cm-image-widget'))
    const imgs = widgets.map((w) => w.querySelector('img')).filter(Boolean)
    const loaded = imgs.filter((i) => i.complete && i.naturalWidth > 0)
    const schemes = imgs.map((i) => (i.src.split(':')[0]))
    return {
      widgets: widgets.length,
      imgs: imgs.length,
      loaded: loaded.length,
      twasset: schemes.filter((s) => s === 'twasset').length,
      twfile: schemes.filter((s) => s === 'twfile').length
    }
  })
  await page.screenshot({ path: join(SHOTS, 'img-all-render.png') })

  record('all four image refs render as widgets', info.widgets >= 4, `widgets=${info.widgets}`)
  record('all widget images actually paint (incl. URL-encoded spaced path)', info.loaded >= 4, `loaded=${info.loaded}/${info.imgs}`)
  record('vault + legacy refs use twasset (2)', info.twasset >= 2, `twasset=${info.twasset}`)
  record('both path images use twfile (2)', info.twfile >= 2, `twfile=${info.twfile}`)
} catch (e) {
  record('image harness completed without throwing', false, String(e))
} finally {
  const failed = results.filter((r) => !r.pass)
  console.log(`\n=== IMAGES SUMMARY: ${results.length - failed.length}/${results.length} passed ===`)
  await app.close()
  process.exit(failed.length === 0 ? 0 : 1)
}
