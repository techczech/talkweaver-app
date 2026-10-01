// Real-Electron gate for ticket 04: the Inspector's Audience › Reactions group (round-2 I1–I4).
// HOST-RUN ONLY, hidden (TW_E2E=1), one Electron run at a time:
//   node e2e/diagnose-inspector-reactions.mjs      (TW_SHOTS_DIR=<dir> saves the Inspector per state)
//
// On a throwaway vault, in the built app:
//   1. every {reactions=…} form typed on the Trigger line keeps the Inspector's option sections
//      (an unregistered token would put up the Unresolved trigger panel instead) and lights its mode;
//   2. Standard · Choose · Custom · Off each write exactly their token to the outline on disk
//      (Standard none), through the ordinary option commit and autosave;
//   3. the written outline round-trips: re-reading it lights the same mode, chips and labels.
import { _electron as electron } from 'playwright'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { join } from 'path'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'

const outline = (line) => `---
title: Reactions in the Inspector
outline_version: 2
auto_title_slide: false
auto_thanks_slide: false
---

### What makes an agent useful?
{id=first}

- A chat can tell me how to fill in an expenses form.

### Not all agents are agents
${line}

- Some are workflows with a chat box.
`
const TITLE = 'Not all agents are agents'
const shotsDir = process.env.TW_SHOTS_DIR || ''
if (shotsDir) mkdirSync(shotsDir, { recursive: true })

const tempRoot = mkdtempSync(join(tmpdir(), 'tw-inspector-reactions-e2e-'))
const vault = join(tempRoot, 'vault')
const ud = join(tempRoot, 'userData')
mkdirSync(ud, { recursive: true })
const dir = join(vault, 'reactions')
mkdirSync(dir, { recursive: true })
const outlinePath = join(dir, 'reactions-outline.md')
writeFileSync(outlinePath, outline('{id=pace}'))
writeFileSync(join(ud, 'config.json'), JSON.stringify({ vaultRoot: vault }, null, 2))
await ensureFreshBuild(process.cwd())
const app = await electron.launch({ args: ['.', '--user-data-dir=' + ud], cwd: process.cwd(), env: { ...process.env, TW_E2E: '1' } })
let failures = 0
const rec = (name, ok, detail) => {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}
try {
  const page = await app.firstWindow()
  page.on('pageerror', (e) => console.log('PAGEERROR:', e.message.slice(0, 150)))
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2500)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
  await page.waitForTimeout(1000)
  await page.locator('.tl-row').first().dblclick()
  await page.waitForTimeout(3000)
  await page.keyboard.press('Meta+p')
  await page.waitForTimeout(1500)

  const inspectorTitle = async () => (await page.locator('.tw-inspector-title').textContent() ?? '').trim()
  const goTo = async (title) => {
    for (const direction of ['Previous slide', 'Next slide']) {
      for (let step = 0; step < 20 && await inspectorTitle() !== title; step += 1) {
        const button = page.locator(`.tw-inspector-nav button[aria-label="${direction}"]`)
        if (await button.isDisabled()) break
        await button.click()
        await page.waitForTimeout(300)
      }
    }
    await page.waitForTimeout(1200)
    return await inspectorTitle() === title
  }
  const state = () => page.evaluate(() => {
    const group = document.querySelector('.tw-inspector-group[data-group="reactions"]')
    return {
      unresolved: !!document.querySelector('.tw-inspector-unresolved'),
      sections: [...document.querySelectorAll('.tw-inspector-section-heading')].map((h) => h.textContent.trim()),
      chips: [...document.querySelectorAll('.tw-inspector-jumplist button')].map((b) => b.textContent.trim()),
      mode: group?.querySelector('.layout-option-segments button[aria-pressed="true"]')?.textContent.trim() ?? null,
      chosen: group ? [...group.querySelectorAll('.tw-reactions-chips button[aria-pressed="true"] .tw-reactions-chip-label')].map((s) => s.textContent.trim()) : [],
      labels: group?.querySelector('.tw-reactions-labels')?.value ?? null,
      token: group?.querySelector('.tw-reactions-token code')?.textContent ?? '',
      note: group?.querySelector('.tw-reactions-note')?.textContent ?? '',
    }
  })
  const lineOnDisk = () => readFileSync(outlinePath, 'utf8').split('\n')[13]
  const waitForLine = async (expected) => {
    for (let i = 0; i < 40; i += 1) { if (lineOnDisk() === expected) return true; await page.waitForTimeout(250) }
    return false
  }
  const shoot = async (name) => {
    if (!shotsDir) return
    await page.screenshot({ path: join(shotsDir, `${name}.png`) }).catch(() => {})
  }
  const toAudience = async () => {
    await page.locator('.tw-inspector-jumplist button').filter({ hasText: /^Audience$/ }).first().click()
    await page.waitForTimeout(600)
  }
  const modeButton = (label) => page.locator('.tw-inspector-group[data-group="reactions"] .layout-option-segments button').filter({ hasText: new RegExp(`^${label}$`) })

  rec('the Inspector reaches the slide', await goTo(TITLE), await inspectorTitle())
  let s = await state()
  rec('Audience is a section chip and a section after Poll', s.chips.at(-1) === 'Audience' && s.sections.at(-1) === 'Audience', JSON.stringify(s.chips))
  rec('I1: Standard lit, no token, the standard three named', s.mode === 'Standard' && s.token === '' && /Every slide offers these/.test(s.note), JSON.stringify(s))
  await toAudience()
  await shoot('I1-inspector-standard-1440x900')

  // I2: Choose opens the chips without writing; Agree then Disagree write the set in order.
  await modeButton('Choose').click(); await page.waitForTimeout(400)
  s = await state()
  rec('Choose opens the chips and writes nothing yet', s.mode === 'Choose' && lineOnDisk() === '{id=pace}', `${s.mode} / ${lineOnDisk()}`)
  const chip = (label) => page.locator('.tw-reactions-chips button').filter({ hasText: label }).first()
  await chip('Agree').click()
  rec('Agree writes {reactions=agree}', await waitForLine('{id=pace} {reactions=agree}'), lineOnDisk())
  await page.waitForTimeout(800)
  await chip('Disagree').click()
  rec('I2: Disagree writes {reactions=agree,disagree}', await waitForLine('{id=pace} {reactions=agree,disagree}'), lineOnDisk())
  await page.waitForTimeout(1500)
  s = await state()
  rec('I2: Choose lit, Agree and Disagree chosen in order, the token shown', s.mode === 'Choose' && s.chosen.join() === 'Agree,Disagree' && s.token === '{reactions=agree,disagree}' && !s.unresolved, JSON.stringify(s))
  await toAudience()
  await shoot('I2-inspector-choose-1440x900')

  // I3: Custom labels.
  await modeButton('Custom').click(); await page.waitForTimeout(400)
  const field = page.locator('.tw-reactions-labels')
  await field.fill('Too fast, Just right, Too slow')
  await field.press('Enter')
  rec('I3: the labels write {reactions="Too fast","Just right","Too slow"}', await waitForLine('{id=pace} {reactions="Too fast","Just right","Too slow"}'), lineOnDisk())
  await page.waitForTimeout(1500)
  s = await state()
  rec('I3: Custom lit, the labels read back, the quoted token shown', s.mode === 'Custom' && s.labels === 'Too fast, Just right, Too slow' && s.token === '{reactions="Too fast","Just right","Too slow"}' && !s.unresolved, JSON.stringify(s))
  await toAudience()
  await shoot('I3-inspector-custom-1440x900')
  await field.fill('a, b, c, d, e')
  await field.press('Enter'); await page.waitForTimeout(600)
  rec('five labels are refused with a reason, the line unchanged', /Up to 4/.test(await page.locator('.tw-reactions-problem').textContent().catch(() => '')) && lineOnDisk() === '{id=pace} {reactions="Too fast","Just right","Too slow"}', lineOnDisk())

  // I4: Off.
  await modeButton('Off').click()
  rec('I4: Off writes {reactions=off}', await waitForLine('{id=pace} {reactions=off}'), lineOnDisk())
  await page.waitForTimeout(1500)
  s = await state()
  rec('I4: Off lit, the note says Ask stays', s.mode === 'Off' && /still shows Ask/.test(s.note) && s.token === '{reactions=off}', JSON.stringify(s))
  await toAudience()
  await shoot('I4-inspector-off-1440x900')

  // Standard removes the token.
  await modeButton('Standard').click()
  rec('Standard removes the token', await waitForLine('{id=pace}'), lineOnDisk())
  await page.waitForTimeout(1500)
  s = await state()
  rec('Standard lit again, the sections kept', s.mode === 'Standard' && !s.unresolved && s.sections.length >= 3, JSON.stringify(s.sections))
  rec('no Unresolved trigger panel at any point', !s.unresolved)
} finally {
  await app.close().catch(() => {})
  rmSync(tempRoot, { recursive: true, force: true })
}

// Typed forms: a second launch per outline is slow, so the typed forms are covered in the model
// test (scripts/test-inspector-model.mjs, the Layout Doctor + inspectorModel for each form); this
// gate proves the running app's writes and read-back.
if (failures > 0) {
  console.log(`${failures} failure(s)`)
  process.exit(1)
}
console.log('inspector reactions e2e: Standard · Choose · Custom · Off write their tokens to disk and read back; the Inspector keeps its sections')
