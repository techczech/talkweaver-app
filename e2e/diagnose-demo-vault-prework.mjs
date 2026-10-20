// Work-files ticket 28, in the real app (hidden window, temp copy of demo-vault, isolated userData, no network).
//   (a) the demo vault's pre-work workshop opens and its strips read "Pre-work · … · 5 steps · not sent to anyone"
//       and the post-work survey's strip;
//   (b) a talk that still has a {prework} section: the Layout Doctor notes "Pre-work now lives in a work file" and
//       offers "Move to a work file"; choosing it writes Work files/<name>.md, names it in the talk's `prework:`,
//       removes the section, keeps every step id and {right}, and the Doctor's note is gone.
// Run: cd talk-weaver && node e2e/diagnose-demo-vault-prework.mjs
import { _electron as electron } from 'playwright'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { openTalkByTitle } from './lib/talklist.mjs'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let failures = 0
const rec = (name, ok, detail) => { if (!ok) failures += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`) }
await ensureFreshBuild(process.cwd())

const root = mkdtempSync(join(tmpdir(), 'tw-demo-prework-e2e-'))
const vault = join(root, 'vault'); const ud = join(root, 'userData')
mkdirSync(ud, { recursive: true })
cpSync(join(process.cwd(), 'demo-vault'), vault, { recursive: true })
const LEGACY = ['---', 'title: Legacy Section', '---', '# Legacy', '', '## Before the session', '{id=pwform}{prework}', '', 'Two quick steps.', '',
  '### Quick check', '{poll=single}{id=quiz}{check}', '', '- Wrong', '- Right one {right}', '', '### Hopes', '{poll=open}{id=hopes}', '',
  '## Opening', '{id=open}', '', '### What you knew', '{id=quizresults}{results=quiz}', ''].join('\n')
mkdirSync(join(vault, 'legacy-section'))
const legacyPath = join(vault, 'legacy-section', 'legacy-section-outline.md')
writeFileSync(legacyPath, LEGACY)
writeFileSync(join(ud, 'config.json'), JSON.stringify({ vaultRoot: vault, editorViewMode: 'markdown' }, null, 2))

const env = { ...process.env, TW_E2E: '1', TW_REC_TEST: '1' }
let app
for (let attempt = 1; attempt <= 3 && !app; attempt += 1) {
  try { app = await electron.launch({ args: ['.', '--user-data-dir=' + ud], cwd: process.cwd(), env, timeout: 60_000 }) }
  catch (error) { if (attempt === 3) throw error; await new Promise((r) => setTimeout(r, 15_000)) }
}
const page = await app.firstWindow()
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message.slice(0, 150)))
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(2500)
const strip = (phase) => page.locator(`[data-work-strip="${phase}"]`)
const text = async (phase) => ((await strip(phase).innerText()) ?? '').replace(/\s+/g, ' ').trim()
const palette = async (label) => {
  await page.keyboard.press('Meta+Shift+P')
  await page.waitForTimeout(250)
  await page.keyboard.type(label)
  await page.waitForTimeout(300)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(450)
}

try {
  // (a) the demo talk
  await openTalkByTitle(page, 'TalkWeaver **Pre-work Workshop**')
  await page.waitForFunction(() => document.querySelector('[data-work-strip="pre"]')?.textContent?.includes('not sent'), null, { timeout: 10_000 }).catch(() => {})
  const pre = await text('pre')
  rec('demo talk: pre-work strip', pre.startsWith('Pre-work · Pre-work workshop intake · 5 steps · not sent to anyone'), pre)
  const post = await text('post')
  rec('demo talk: post-work strip', post.startsWith('Post-work · Pre-work workshop: what was learnt · 2 steps'), post)

  // (b) the Doctor's move
  await openTalkByTitle(page, 'Legacy Section')
  await page.waitForSelector('.cm-content', { timeout: 10_000 })
  await page.waitForTimeout(2500) // the compile that carries the warning
  await palette('Layout Doctor (trigger-line health)…')
  await page.waitForSelector('[data-doctor-prework-retired]', { timeout: 10_000 })
  const note = ((await page.locator('[data-doctor-prework-retired]').innerText()) ?? '').replace(/\s+/g, ' ')
  rec('the Doctor notes the section and offers the move', note.includes('Pre-work now lives in a work file') && note.includes('Move to a work file'), note)
  await page.locator('[data-doctor-move-prework]').click()
  await page.waitForFunction(() => document.querySelector('[data-doctor-prework-retired]')?.textContent?.includes('Moved to Work files/'), null, { timeout: 10_000 }).catch(() => {})
  rec('the Doctor says where it went', ((await page.locator('[data-doctor-prework-retired]').innerText()) ?? '').includes('Moved to Work files/legacy-section-pre-work.md'))
  await page.waitForTimeout(3500) // the editor's own save settles
  const file = join(vault, 'Work files', 'legacy-section-pre-work.md')
  const fileText = existsSync(file) ? readFileSync(file, 'utf8') : ''
  rec('the work file is written with the step ids and {right}', fileText.includes('{id=quiz}') && fileText.includes('{id=hopes}') && fileText.includes('- Right one {right}') && fileText.includes('Two quick steps.'), JSON.stringify(readdirSync(join(vault, 'Work files'))))
  const outline = readFileSync(legacyPath, 'utf8')
  rec('the outline lost the section and names the file', !outline.includes('{prework}') && !outline.includes('Before the session') && outline.includes('prework: legacy-section-pre-work'))
  rec('the results slide still resolves', outline.includes('{results=legacy-section-pre-work/quiz}'))
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)
  await page.waitForFunction(() => document.querySelector('[data-work-strip="pre"]')?.textContent?.includes('2 steps'), null, { timeout: 10_000 }).catch(() => {})
  rec('the strip now shows the file', (await text('pre')).startsWith('Pre-work · Legacy Section pre-work · 2 steps'), await text('pre'))
  await palette('Layout Doctor (trigger-line health)…')
  await page.waitForSelector('[role="dialog"][aria-label^="Layout Doctor"]', { timeout: 10_000 })
  await page.waitForTimeout(1500)
  rec('the Doctor warning is gone after the move', await page.locator('[data-doctor-prework-retired]').count() === 0)
} finally { await app.close().catch(() => {}) }

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED')
process.exit(failures ? 1 : 0)
