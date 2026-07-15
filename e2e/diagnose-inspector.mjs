// Real-Electron host gate for the Inspector pane (ADR-0011 Stage 4).
// HOST-RUN ONLY: node e2e/diagnose-inspector.mjs
import { _electron as electron } from 'playwright'
import { join } from 'path'
import { mkdirSync, mkdtempSync, writeFileSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
const tempRoot = mkdtempSync(join(tmpdir(), 'tw-insp-'))
const vault = join(tempRoot, 'vault')
const ud = join(tempRoot, 'userData')
mkdirSync(ud, { recursive: true })
const dir = join(vault, 'demo-talk')
mkdirSync(dir, { recursive: true })
const probeOutline = `---\ntitle: Demo\n---\n\n## Section A\n{accent=vermilion}\n\n### Contrast slide\n{id=aaaaa}{contrast}\n\n- Old / New\n- Slow / Fast\n\n<!-- from: elsewhere -->\n### Reveal slide\n{id=bbbbb}{reveal}\n\n- One\n- Two\n- Three\n\n## Section B\n\n### Final question - How much are you willing to invest in AI-assisted research?\n{iconlist}\n{id=uyee5} {split=50}\n\n- One\n- Two\n\n### Final question - editor-less\n{iconlist}\n{id=uyef6} {split=50}\n\n- One\n- Two\n\n### Not all Agents are Agents\n{sidebar} {id=hnwcx}\n{layout=media} {id=3plcu}\n\n- One\n- Two\n\n### Image grid slide\n{id=ccccc}{image-grid}\n\n- One\n- Two\n\n### Nested container probe\n{id=nesta}\n\n#### Nested child one\n{id=nestb}\n\n- First\n\n#### Nested child two\n{id=nestc}\n\n- Second\n`
const outlineFile = join(dir, 'demo-talk-outline.md')
writeFileSync(outlineFile, probeOutline)
const directModel = await prepareSource(outlineFile, probeOutline, 'demo-talk', statSync(outlineFile))
const directAccent = directModel.fullHtml.match(/<section[^>]*data-id="aaaaa"[^>]*style="[^"]*--sec-accent:\s*([^;\"]+)/)?.[1]?.trim() ?? ''
writeFileSync(join(ud, 'config.json'), JSON.stringify({ vaultRoot: vault }, null, 2))
const app = await electron.launch({ args: ['.', '--user-data-dir=' + ud], cwd: process.cwd() })
const page = await app.firstWindow()
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message.slice(0, 150)))
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(2500)
let failures = 0
const rec = (n, ok, d) => {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`)
}

const inspectorTitle = async () => (await page.locator('.tw-inspector-title').textContent() ?? '').trim()
const walkInspectorToTitle = async (title) => {
  for (let step = 0; step < 10 && await inspectorTitle() !== title; step += 1) {
    const next = page.locator('.tw-inspector-nav button[aria-label="Next slide"]')
    if (await next.isDisabled()) break
    await next.click()
    await page.waitForTimeout(1200)
  }
  return await inspectorTitle() === title
}
const assertFullDeckPreview = async (label) => {
  await page.waitForTimeout(1000)
  const stage = page.frameLocator('.tw-inspector-stage iframe')
  const slideCount = await stage.locator('.slide').count().catch(() => -1)
  const visibleDeckChrome = await stage.locator('.share-footer:visible, footer.footer:visible, .progress:visible').count().catch(() => -1)
  rec(label, visibleDeckChrome === 0 && slideCount === 13, `slides=${slideCount} visibleChrome=${visibleDeckChrome}`)
}
const frameActivation = async (frameSelector) => page.frameLocator(frameSelector).locator('body').evaluate((body) => ({
  activeSlides: body.querySelectorAll('.slide.active').length,
  slides: body.querySelectorAll('.slide').length,
  activeTitle: body.querySelector('.slide.active')?.getAttribute('data-nav-title') ?? ''
})).catch((error) => ({ activeSlides: -1, slides: -1, activeTitle: '', error: String(error).slice(0, 120) }))
const frameWidth = async (frameSelector) => page.frameLocator(frameSelector).locator('body')
  .evaluate((body) => body.ownerDocument.defaultView.innerWidth).catch(() => -1)
const frameStepState = async () => page.frameLocator('.tw-inspector-stage iframe').locator('body').evaluate((body) => {
  const active = body.querySelector('.slide.active')
  return {
    activeId: active?.getAttribute('data-id') ?? '',
    modeStates: [...(active?.querySelectorAll('[data-mode-state]') ?? [])].map((el) => el.getAttribute('data-mode-state')),
    hiddenFragments: active?.querySelectorAll('.hidden-fragment').length ?? -1,
    activeCard: [...(active?.querySelectorAll('.active-card') ?? [])].map((el) => el.textContent?.trim().slice(0, 40) ?? '')
  }
}).catch((error) => ({ error: String(error).slice(0, 120) }))

await page.locator('.tl-row').first().dblclick()
await page.waitForTimeout(2500)

// Cheap preload tap: count renderPreview calls if the contextBridge object permits replacement.
// If Electron freezes it, the stable base-document assertion below remains the host check.
const previewTap = await page.evaluate(() => {
  const slide = window.tw?.slide
  if (!slide || typeof slide.renderPreview !== 'function') return false
  const original = slide.renderPreview.bind(slide)
  let count = 0
  try {
    slide.renderPreview = (...args) => { count += 1; window.__twPreviewCalls = count; return original(...args) }
    window.__twPreviewCalls = 0
    return slide.renderPreview !== original
  } catch { return false }
})

// 1. Inspector is a mode over the normal strip pane, not a pane state.
await page.keyboard.press('Meta+2')
await page.waitForTimeout(800)
rec('both mode starts with SlideStrip', await page.locator('.pane--strip').count() === 1)
await page.keyboard.press('Meta+p')
await page.waitForTimeout(1200)
rec('⌘P swaps the right strip pane to Inspector',
  await page.locator('.tw-inspector').count() === 1 && await page.locator('.pane--strip').count() === 0)
await page.keyboard.press('Meta+p')
await page.waitForTimeout(800)
rec('⌘P swaps Inspector back to SlideStrip',
  await page.locator('.pane--strip').count() === 1 && await page.locator('.tw-inspector').count() === 0)
await page.keyboard.press('Meta+p')
await page.waitForTimeout(1200)
const pos = await page.locator('.tw-inspector-pos').textContent().catch(() => null)
rec('probe compiles to thirteen slides', !!pos && /\/\s*13$/.test(pos.trim()), pos)

// 2. Heading-is-slide preview: section divider and content slide each compile alone.
rec('navigates to section divider by title', await walkInspectorToTitle('Section A'), await inspectorTitle())
await assertFullDeckPreview('section divider preview uses the full deck with no chrome')
const accentGroup = await page.locator('.tw-inspector-options').textContent().catch(() => '')
rec('section slide offers the accent option group', /vermilion/i.test(accentGroup || '') && /emerald/i.test(accentGroup || '') && /cobalt/i.test(accentGroup || ''), (accentGroup || '').slice(0, 120))
await page.locator('.tw-inspector-options').screenshot({ path: '/tmp/tw-accent-options.png' }).catch(() => {})
await page.locator('.cm-line').filter({ hasText: '### Contrast slide' }).click()
await page.waitForTimeout(600)
rec('editor cursor moves the Inspector to the clicked slide', await inspectorTitle() === 'Contrast slide', await inspectorTitle())
await page.locator('.tw-inspector-stage').screenshot({ path: '/tmp/tw-inspector-stage.png' }).catch(() => {})
const frameState = await page.frameLocator('.tw-inspector-stage iframe').locator('body').evaluate((b) => ({
  activeSlides: b.querySelectorAll('.slide.active').length,
  slideClasses: [...b.querySelectorAll('.slide')].map((el) => el.className).slice(0, 3),
  scripts: b.ownerDocument.scripts.length,
  runtimeRan: typeof b.ownerDocument.defaultView.__twDeckReady !== 'undefined' || b.ownerDocument.body.dataset.runtime || 'unknown',
  slideDisplay: b.querySelector('.slide') ? getComputedStyle(b.querySelector('.slide')).display : 'none-found',
  stageEl: !!b.querySelector('#stage'),
})).catch((e) => ({ err: String(e).slice(0, 100) }))
const frameSrc = await page.locator('.tw-inspector-stage iframe').getAttribute('src')
const frameUrl = await page.locator('.tw-inspector-stage iframe').evaluate((f) => { try { return f.contentWindow.location.href } catch (e) { return 'x-origin:' + String(e).slice(0, 40) } })
console.log('FRAME-SRC:', frameSrc, '| FRAME-URL:', frameUrl)
const exec = await page.frameLocator('.tw-inspector-stage iframe').locator('body').evaluate((b) => {
  const w = b.ownerDocument.defaultView
  return { deckBeats: typeof w.__deckBeats, anyGlobal: Object.keys(w).filter((k) => k.startsWith('__')).slice(0, 5), csp: [...b.ownerDocument.querySelectorAll('meta[http-equiv]')].map((m) => m.getAttribute('content')?.slice(0, 80)) }
})
console.log('FRAME-EXEC:', JSON.stringify(exec))
console.log('FRAME-STATE:', JSON.stringify(frameState))
rec('FRAME-STATE content slide has exactly one active slide', frameState.activeSlides === 1, JSON.stringify(frameState))
await assertFullDeckPreview('content preview keeps the full deck and no footer')
const inspectorLogicalWidth = await frameWidth('.tw-inspector-stage iframe')
rec('Inspector preview renders at the 1280px logical deck width', inspectorLogicalWidth === 1280, String(inspectorLogicalWidth))
const previewAccent = await page.frameLocator('.tw-inspector-stage iframe').locator('.slide.active').evaluate((slide) => getComputedStyle(slide).getPropertyValue('--sec-accent').trim())
rec('Inspector preview accent matches the directly compiled full deck', !!directAccent && previewAccent === directAccent, `direct=${directAccent} preview=${previewAccent}`)

// 3. option commit → trigger line updates + preview recompiles
import('fs').then(() => {})
const before = (await import('fs')).readFileSync(outlineFile, 'utf8')
const optBtns = await page.locator('.tw-inspector-options button, .tw-inspector-options [role=button], .tw-inspector-options [tabindex]').count()
rec('option controls present', optBtns > 0, 'controls=' + optBtns)
// click the Body-size 'L' segmented button (definitely non-default)
await page.screenshot({ path: '/tmp/tw-inspector-options.png' })
await page.locator('.tw-inspector-options button', { hasText: /^L$/ }).first().click()
await page.waitForTimeout(400)
const selState = await page.locator('.tw-inspector-options button', { hasText: /^L$/ }).first().getAttribute('class')
rec('L control shows selected', /on|active|selected/.test(selState || ''), selState)
await page.waitForTimeout(3000) // autosave
const after = (await import('fs')).readFileSync(outlineFile, 'utf8')
const afterLines = after.split('\n')
rec('L commit extends the content slide trigger line',
  before !== after && afterLines.includes('{id=aaaaa}{contrast}{font-body=l}'), JSON.stringify(after.slice(0, 300)))
// Ledger id-stamping may add {id=…} under the divider on save — assert only that OUR token
// did not land there.
const dividerIdx = afterLines.indexOf('## Section A')
const dividerNext = afterLines[dividerIdx + 1] ?? ''
rec('L commit leaves the Section A divider unchanged',
  !dividerNext.includes('font-body'), JSON.stringify(dividerNext))
const postCommitFrameSrc = await page.locator('.tw-inspector-stage iframe').getAttribute('src')
const contrastBaseUrl = (postCommitFrameSrc ?? '').split('#')[0]
const callsBeforeHashNav = await page.evaluate(() => window.__twPreviewCalls ?? -1)

// 4. Section slides changed the indices: find Reveal slide by its nav title.
rec('navigates to Reveal slide by title', await walkInspectorToTitle('Reveal slide'), await inspectorTitle())
const revealFrameSrc = await page.locator('.tw-inspector-stage iframe').getAttribute('src')
const callCountAfterHashNav = await page.evaluate(() => window.__twPreviewCalls ?? -1)
rec('unchanged-content slide navigation reuses the preview document and changes only its hash',
  !!revealFrameSrc && revealFrameSrc.split('#')[0] === contrastBaseUrl && /#bbbbb$/.test(revealFrameSrc),
  `before=${frameSrc} after=${revealFrameSrc}`)
if (previewTap) rec('hash navigation does not invoke renderPreview again', callCountAfterHashNav === callsBeforeHashNav, `before=${callsBeforeHashNav} after=${callCountAfterHashNav}`)
else console.log('HOST CHECK  renderPreview tap unavailable; stable base URL + hash-only navigation asserted')
const steptext = await page.locator('.tw-inspector-stepbar span').first().textContent().catch(() => null)
rec('step bar present on reveal slide', !!steptext && steptext.includes('step'), steptext)
if (steptext) {
  const frameStepBefore = await frameStepState()
  await page.locator('.tw-inspector-stepbar button').nth(1).click()
  await page.waitForTimeout(400)
  const after2 = await page.locator('.tw-inspector-stepbar span').first().textContent()
  rec('▸ advances the step counter', after2 !== steptext, after2)
  const frameStepAfter = await frameStepState()
  rec('▸ changes reveal state inside the preview frame',
    JSON.stringify(frameStepAfter) !== JSON.stringify(frameStepBefore),
    `before=${JSON.stringify(frameStepBefore)} after=${JSON.stringify(frameStepAfter)}`)
}

// 5. Exact A1 shape: bare modifier then id-bearing split line, through both Inspector paths.
rec('navigates to the mounted-editor A1 probe', await walkInspectorToTitle('Final question - How much are you willing to invest in AI-assisted research?'), await inspectorTitle())
let exactPlacementGroup = page.locator('.tw-inspector-group', { hasText: 'Title placement' })
await exactPlacementGroup.getByRole('button', { name: '50', exact: true }).click()
await page.waitForTimeout(2300)
let exactOutline = (await import('fs')).readFileSync(outlineFile, 'utf8')
let exactLines = exactOutline.split('\n')
let exactHeading = exactLines.indexOf('### Final question - How much are you willing to invest in AI-assisted research?')
let exactTriggers = []
for (let line = exactHeading + 1; /^\s*(\{[^}]*\}\s*)+$/.test(exactLines[line] ?? ''); line += 1) exactTriggers.push(exactLines[line])
rec('mounted-editor split commit consolidates the exact A1 block to one line',
  exactTriggers.length === 1 && exactTriggers[0] === '{iconlist}{id=uyee5}{split=50}', exactTriggers.join(' | '))

rec('navigates to the editor-less A1 probe', await walkInspectorToTitle('Final question - editor-less'), await inspectorTitle())
await page.keyboard.press('Meta+3')
await page.waitForTimeout(500)
exactPlacementGroup = page.locator('.tw-inspector-group', { hasText: 'Title placement' })
await exactPlacementGroup.getByRole('button', { name: '50', exact: true }).click()
await page.waitForTimeout(2300)
exactOutline = (await import('fs')).readFileSync(outlineFile, 'utf8')
exactLines = exactOutline.split('\n')
exactHeading = exactLines.indexOf('### Final question - editor-less')
exactTriggers = []
for (let line = exactHeading + 1; /^\s*(\{[^}]*\}\s*)+$/.test(exactLines[line] ?? ''); line += 1) exactTriggers.push(exactLines[line])
rec('editor-less split commit consolidates the exact A1 block to one line',
  exactTriggers.length === 1 && exactTriggers[0] === '{iconlist}{id=uyef6}{split=50}', exactTriggers.join(' | '))
await page.keyboard.press('Meta+2')
await page.waitForTimeout(500)

// 6. Sidebar placement + two-line Trigger integrity.
rec('navigates to the two-line Sidebar probe', await walkInspectorToTitle('Not all Agents are Agents'), await inspectorTitle())
rec('two-line Top probe runs with CodeMirror mounted', await page.locator('.cm-editor .cm-content').count() === 1)
const sidebarPlacementGroup = page.locator('.tw-inspector-group', { hasText: 'Title placement' })
let sidebarClass = await sidebarPlacementGroup.getByRole('button', { name: 'Sidebar', exact: true }).getAttribute('class')
rec('authored Sidebar is selected', /on|active|selected/.test(sidebarClass || ''), sidebarClass)
await sidebarPlacementGroup.getByRole('button', { name: 'Top', exact: true }).click()
await page.waitForTimeout(2300)
let twoLineOutline = (await import('fs')).readFileSync(outlineFile, 'utf8')
let probeLines = twoLineOutline.split('\n')
let probeHeading = probeLines.indexOf('### Not all Agents are Agents')
let probeTriggers = []
for (let line = probeHeading + 1; /^\s*(\{[^}]*\}\s*)+$/.test(probeLines[line] ?? ''); line += 1) probeTriggers.push(probeLines[line])
const probeBlock = twoLineOutline.slice(twoLineOutline.indexOf('### Not all Agents are Agents'), twoLineOutline.indexOf('### Image grid slide'))
rec('Top merges the two-line block, keeps the original lower id and mints no replacement',
  probeTriggers.length === 1 && probeTriggers[0].includes('{titletop}') && probeTriggers[0].includes('{id=3plcu}')
    && !probeBlock.includes('hnwcx') && (probeBlock.match(/\{id=/g) ?? []).length === 1,
  JSON.stringify(probeTriggers))
await sidebarPlacementGroup.getByRole('button', { name: 'Sidebar', exact: true }).click()
await page.waitForTimeout(2300)
twoLineOutline = (await import('fs')).readFileSync(outlineFile, 'utf8')
probeLines = twoLineOutline.split('\n')
probeHeading = probeLines.indexOf('### Not all Agents are Agents')
const restoredTrigger = probeLines[probeHeading + 1] ?? ''
const restoredBlock = twoLineOutline.slice(twoLineOutline.indexOf('### Not all Agents are Agents'), twoLineOutline.indexOf('### Image grid slide'))
sidebarClass = await sidebarPlacementGroup.getByRole('button', { name: 'Sidebar', exact: true }).getAttribute('class')
rec('switching back restores Sidebar on the single Trigger line',
  /on|active|selected/.test(sidebarClass || '') && restoredTrigger.includes('{sidebar}')
    && restoredTrigger.includes('{id=3plcu}') && (restoredBlock.match(/\{id=/g) ?? []).length === 1,
  restoredTrigger)

// 7. Merged title placement: an explicit side width overrides a wide layout, Hidden replaces it,
// and Auto removes the authored placement token entirely.
rec('navigates to image-grid probe slide', await walkInspectorToTitle('Image grid slide'), await inspectorTitle())
const titlePlacementGroup = page.locator('.tw-inspector-group', { hasText: 'Title placement' })
await titlePlacementGroup.getByRole('button', { name: '35', exact: true }).click()
await page.waitForTimeout(2300)
let title = await inspectorTitle()
rec('commit keeps the inspected slide', title === 'Image grid slide', title)
let placementOutline = (await import('fs')).readFileSync(outlineFile, 'utf8')
const sideLayout = await page.frameLocator('.tw-inspector-stage iframe').locator('.slide.active')
  .getAttribute('data-title-layout').catch(() => null)
rec('Side 35 writes one split token and forces the image-grid title left',
  /\{id=ccccc\}\{image-grid\}\{split=35\}/.test(placementOutline) && sideLayout === 'left',
  `layout=${sideLayout} line=${placementOutline.split('\n').find((line) => line.includes('ccccc')) ?? ''}`)
await titlePlacementGroup.getByRole('button', { name: 'Hidden', exact: true }).click()
await page.waitForTimeout(2300)
title = await inspectorTitle()
rec('commit keeps the inspected slide', title === 'Image grid slide', title)
placementOutline = (await import('fs')).readFileSync(outlineFile, 'utf8')
rec('Hidden replaces the side split token with notitle',
  /\{id=ccccc\}\{image-grid\}\{notitle\}/.test(placementOutline) && !placementOutline.includes('{split=35}'),
  placementOutline.split('\n').find((line) => line.includes('ccccc')) ?? '')
await titlePlacementGroup.getByRole('button', { name: 'Auto', exact: true }).click()
await page.waitForTimeout(2300)
title = await inspectorTitle()
rec('commit keeps the inspected slide', title === 'Image grid slide', title)
placementOutline = (await import('fs')).readFileSync(outlineFile, 'utf8')
const imageGridTrigger = placementOutline.split('\n').find((line) => line.includes('ccccc')) ?? ''
rec('Auto removes explicit title placement', !/\{(?:notitle|split=\d+)\}/.test(imageGridTrigger), imageGridTrigger)

// 8. A child-bearing ### gets the same container controls as a ## section.
rec('navigates to nested ### container probe', await walkInspectorToTitle('Nested container probe'), await inspectorTitle())
const containerModeGroup = page.locator('.tw-inspector-group', { hasText: 'Container mode' })
const containerModeText = await containerModeGroup.textContent().catch(() => '')
rec('nested ### shows all Container mode options',
  ['Linear', 'Carousel', 'Contents', 'Grid linear', 'Grid zoom'].every((label) => containerModeText?.includes(label)),
  containerModeText)
await containerModeGroup.getByRole('button', { name: 'Carousel', exact: true }).click()
await page.waitForTimeout(2300)
const containerOutline = (await import('fs')).readFileSync(outlineFile, 'utf8')
const containerLines = containerOutline.split('\n')
const containerHeading = containerLines.indexOf('### Nested container probe')
const containerTrigger = containerLines.slice(containerHeading + 1).find((line) => /^\s*(\{[^}]*\}\s*)+$/.test(line)) ?? ''
rec('committing Carousel writes the parent container mode', containerTrigger.includes('{carousel}'), containerTrigger)
const carouselPreview = await page.frameLocator('.tw-inspector-stage iframe')
  .locator('.slide.active[data-carousel], .slide.active[data-layout="carousel"]').count().catch(() => -1)
rec('committing Carousel folds the child slides into the preview carousel', carouselPreview === 1, String(carouselPreview))

// 9. Slide Focus uses the same fixed-logical-size preview path.
await page.keyboard.press('Meta+Shift+F')
await page.waitForTimeout(1200)
rec('⌘⇧F opens Slide Focus', await page.locator('.lt-focus').count() === 1)
if (await page.locator('.lt-focus').count() === 1) {
  const focusActivation = await frameActivation('.lt-stage-frame iframe')
  rec('Slide Focus stage has exactly one active slide', focusActivation.activeSlides === 1, JSON.stringify(focusActivation))
  const focusLogicalWidth = await frameWidth('.lt-stage-frame iframe')
  rec('Slide Focus preview renders at the 1280px logical deck width', focusLogicalWidth === 1280, String(focusLogicalWidth))
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)
}

// 10. Inspector exit remounts the strip at the active late slide, not at scrollTop 0.
await page.keyboard.press('Meta+p')
await page.waitForTimeout(900)
const activeCardVisibility = await page.locator('.tw-slide-card[data-active="true"]').evaluate((card) => {
  let scroller = card.parentElement
  while (scroller && !(scroller.scrollHeight > scroller.clientHeight && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) {
    scroller = scroller.parentElement
  }
  if (!scroller) return { visible: false, scrollTop: -1 }
  const cardRect = card.getBoundingClientRect()
  const scrollRect = scroller.getBoundingClientRect()
  return { visible: cardRect.top >= scrollRect.top && cardRect.bottom <= scrollRect.bottom, scrollTop: scroller.scrollTop }
}).catch(() => ({ visible: false, scrollTop: -1 }))
rec('Inspector exit restores the active late card inside the visible strip area', activeCardVisibility.visible, JSON.stringify(activeCardVisibility))

// 11. Deck menu item
const menu = await app.evaluate(({ Menu }) => {
  const m = Menu.getApplicationMenu()
  const items = []
  const walk = (list) => list.forEach((i) => { items.push(i.label); if (i.submenu) walk(i.submenu.items) })
  walk(m?.items ?? [])
  return items.filter((l) => /inspector/i.test(l || ''))
})
rec('Deck menu has Inspector item', menu.length > 0, JSON.stringify(menu))

await page.screenshot({ path: '/tmp/tw-inspector-live.png' })
await app.close()
if (failures > 0) {
  console.error(`Inspector gate failed: ${failures} assertion${failures === 1 ? '' : 's'}`)
  process.exitCode = 1
} else {
  console.log('Inspector gate passed')
}
