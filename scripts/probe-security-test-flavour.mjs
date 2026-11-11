import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { _electron as electron } from 'playwright'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
const bundle = resolve(process.argv[2])
const signature = spawnSync('/usr/bin/codesign', ['-dvv', bundle], { encoding: 'utf8' })
assert.equal(signature.status, 0)
assert.match(signature.stderr, /^CodeDirectory .*flags=.*\bruntime\b/m)
assert.match(signature.stderr, /^TeamIdentifier=M7H45AGG8A$/m)
const root = mkdtempSync(join(resolve('.'), '.tw-test-flavour-'))
const profile = join(root, 'profile'), vault = join(root, 'vault'), talk = join(vault, 'fixture')
for (const path of [profile, talk]) mkdirSync(path, { recursive: true })
const outline = join(talk, 'fixture-outline.md'), source = '---\noutline_version: 2\ntitle: Test flavour\n---\n\n### Fixture\n\nFixture text.\n'
writeFileSync(outline, source)
writeFileSync(join(profile, 'config.json'), JSON.stringify({ vaultRoot: vault }))
const external = join(root, 'fixture-page.html'), bytes = '<!doctype html><p>Imported fixture page</p>'
writeFileSync(external, bytes)
const env = { ...process.env, TW_E2E: '1', TW_REC_TEST: '1' }; delete env.ELECTRON_RUN_AS_NODE
let instance
try {
  instance = await electron.launch({ executablePath: join(bundle, 'Contents/MacOS/TalkWeaver Security Test'), args: [`--user-data-dir=${profile}`, '--use-mock-keychain'], env })
  const page = await instance.firstWindow()
  await page.waitForFunction(() => Boolean(window.tw?.talk))
  const state = await instance.evaluate(({ app, BrowserWindow }) => ({ packaged: app.isPackaged, hidden: BrowserWindow.getAllWindows().every(w => !w.isVisible()), windows: BrowserWindow.getAllWindows().length }))
  assert.equal(await instance.evaluate(({ app }) => app.getName()), 'TalkWeaver Security Test')
  assert.equal(state.packaged, true); assert.equal(state.hidden, true); assert.ok(state.windows > 0)
  await page.locator('[data-talk-slug="fixture"]').first().dblclick()
  await page.locator('.cm-content').waitFor()
  await instance.evaluate((_electron, external) => { globalThis.__twE2eHtmlPagePick = external }, external)
  const imported = await page.evaluate(async outline => { const pick = await window.tw.htmlPage.choose(outline); if (!pick?.ok) return pick; return window.tw.htmlPage.import(pick.token, outline) }, outline)
  assert.equal(imported?.ok, true, JSON.stringify(imported))
  assert.equal(readFileSync(join(talk, imported.embedPath), 'utf8'), bytes)
  console.log('PASS signed test-flavour HTML import utility copies fixture bytes')
  const result = await page.evaluate(({ outline, source }) => window.tw.talk.exportHandout(outline, source), { outline, source })
  assert.equal(result.success, true, JSON.stringify(result)); assert.ok(existsSync(result.path))
  console.log('PASS unpublished flavour: Playwright main-process inspector, all windows hidden, renderer IPC and handout export')
} finally { try { if (instance) await instance.close() } finally { rmSync(root, { recursive: true, force: true }) } }
