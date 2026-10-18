// Real installed public NSIS build, synthetic local profile, public demo plus a bounded fixture.
import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, isAbsolute } from 'node:path'

assert.equal(process.platform, 'win32')
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
const scratch = process.env.TW_NSIS_SCRATCH
const install = process.env.TW_NSIS_INSTALL
const executable = process.env.TW_NSIS_EXE
const vault = process.env.TW_NSIS_VAULT
assert.ok(scratch && install && executable && vault)
for (const path of [install, executable, vault]) {
  const rel = relative(scratch, path)
  assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel), 'every test path must stay inside the isolated directory')
}
assert.ok(existsSync(join(vault, 'ai-chat-and-terminal-slides', 'ai-chat-and-terminal-slides-outline.md')))
const profile = join(scratch, 'profile')
const talkDir = join(vault, 'windows-installer-smoke')
const evidence = join(process.cwd(), 'nsis-evidence')
mkdirSync(profile, { recursive: true })
mkdirSync(talkDir, { recursive: true })
mkdirSync(evidence, { recursive: true })
writeFileSync(join(profile, 'config.json'), JSON.stringify({ vaultRoot: vault }))
writeFileSync(join(talkDir, 'diagram.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="600"><rect width="1200" height="600" fill="#263c51"/><text x="90" y="200" fill="white" font-size="68">From outline to presentation</text><text x="90" y="340" fill="#97d8ca" font-size="42">Write → preview → present</text></svg>')
const outline = join(talkDir, 'windows-installer-smoke-outline.md')
const fixture = `---
title: Windows installer smoke
outline_version: 2
---

# Windows installer smoke

## A local presentation
{id=local01}

### What should your audience remember?
{id=message01}

- One central idea gives the talk a purpose.
- An outline makes the argument visible.

### Bring the story together
{id=story01}

![The presentation workflow](diagram.svg)

### Ready to present
{id=ready01}

- Keep the source in your own Markdown files.
- Present from the same outline you edit.
`
writeFileSync(outline, fixture)
const checks = []
const pass = name => { checks.push(name); console.log(`PASS ${name}`) }
let app
try {
  const env = { ...process.env, TW_E2E: '1', TW_MIGRATE_PROMPT: '0' }
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ executablePath: executable, args: [`--user-data-dir=${profile}`], env, timeout: 60000 })
  const identity = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, version: app.getVersion(), appPath: app.getAppPath(), profile: app.getPath('userData') }))
  assert.equal(identity.packaged, true)
  assert.equal(identity.version, '0.39.0')
  assert.ok(identity.appPath.toLowerCase().startsWith(install.toLowerCase() + '\\'))
  assert.equal(identity.profile.toLowerCase(), profile.toLowerCase())
  writeFileSync(join(evidence, 'installed-runtime.json'), JSON.stringify(identity, null, 2))
  pass('actual NSIS-installed executable launches with an isolated profile')
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1920, 1080))
  await page.locator('.tl-row', { hasText: 'AI chat and terminal slides' }).first().dblclick({ timeout: 60000 })
  await page.locator('.cm-content').first().waitFor({ timeout: 60000 })
  assert.match(await page.locator('.cm-content').first().innerText(), /Chat plus behind the scenes/)
  pass('installed app opens a copied official public demo talk without Cloudflare setup')
  await page.locator('.tl-row', { hasText: 'Windows installer smoke' }).first().dblclick()
  const read = await page.evaluate(path => window.tw.talk.readOutline(path, { forEditor: true }), outline)
  assert.match(read, /One central idea/)
  const edited = read.replace('One central idea gives the talk a purpose.', 'One central idea gives your presentation a purpose.')
  const saved = await page.evaluate(({ path, content }) => window.tw.talk.writeOutline(path, content), { path: outline, content: edited })
  assert.equal(saved?.ok, true)
  const disk = readFileSync(outline, 'utf8')
  assert.match(disk, /gives your presentation a purpose/)
  pass('installed preload IPC reads and saves a local outline, verified on disk')
  const compiled = await page.evaluate(({ path, content }) => window.tw.talk.compile(path, content), { path: outline, content: disk })
  assert.ok(Array.isArray(compiled) && compiled.length >= 3)
  pass('the installed compiler renders rows from the saved outline')
  await page.screenshot({ path: join(evidence, 'windows-installed-editor.png') })
  const result = await page.evaluate(({ path, content }) => window.tw.talk.present(path, content, 'window'), { path: outline, content: disk })
  assert.equal(result?.success, true, result?.error)
  let deck
  for (let attempt = 0; attempt < 30 && !deck; attempt++) {
    deck = app.windows().find(window => window !== page && /file:.*-present\.html/.test(window.url()))
    if (!deck) await new Promise(resolve => setTimeout(resolve, 500))
  }
  assert.ok(deck, 'a local presentation window must open')
  await deck.waitForLoadState('domcontentloaded')
  assert.ok(await deck.locator('section').count() >= 3)
  const src = await deck.locator('img').evaluateAll(images => images.find(image => image.getAttribute('alt') === 'The presentation workflow')?.src)
  assert.ok(src)
  assert.equal(await deck.evaluate(async src => { const image = new Image(); image.src = src; try { await image.decode(); return image.naturalWidth > 0 } catch { return false } }, src), true)
  pass('installed app presents local slides and decodes local SVG media')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.setContentSize(1920, 1080)))
  await deck.screenshot({ path: join(evidence, 'windows-installed-presentation.png') })
  writeFileSync(join(evidence, 'smoke-results.json'), JSON.stringify({ checks, passed: checks.length, platform: process.platform }, null, 2))
} finally {
  if (app) await app.close().catch(() => {})
}
