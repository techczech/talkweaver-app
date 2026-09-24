// DOM-backed object-widget regression suite.
// No jsdom/linkedom/happy-dom dependency is available, so this follows the existing hidden-Electron
// e2e idiom. The builder authors it but does not run it; the driver runs:
//   npm run test:object-widgets:e2e
import { _electron as electron } from 'playwright'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { createCheckLedger } from './lib/check-ledger.mjs'
import { openTalkByTitle } from './lib/talklist.mjs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = join(__dirname, '..')
const CHECK_NAMES = [
  'scrolling sees every fixture object widget despite CodeMirror virtualisation',
  'header grammar is kind, step model, slot chip, raw, and nothing else on every widget',
  'parked zoom control is absent from every widget header',
  'raw-view toggle changes state and restores every object widget',
  'GFM table editor commits cell (0,0) back to pipe-table document bytes',
  'empty-over-nonempty table commit fails closed and leaves the document unchanged',
  'teardown refusal keeps the shell, typed content, and reason while document bytes stay unchanged',
  'legal short-separator GFM table edits in the grid without normalising its separator',
  'Escape commits and leaves from table, mindmap, Mermaid, SVG, and markup panes',
  'Control-Enter finishes from table, mindmap, Mermaid, SVG, and markup panes',
  'trigger-table grid commit preserves nested-list storage and writes no pipe table',
  'mindmap editing preserves the authored star marker without inserting an empty node',
  'empty-over-nonempty guard rejects a fenced Mermaid body and names the inner-source reason',
  'fenced object editing preserves the original SVG info string',
  'all three invalid non-empty sources fail visibly over populated raw text',
  'empty Mermaid and SVG are neutral ready-to-type objects',
  'markmap rendered-node HTML refuses the hostile image',
  'Mermaid SVG innerHTML refuses hostile elements and attributes',
  'valid Mermaid rendered SVG contains its node label text',
  'the DOM suite keeps every Electron test window hidden'
]
const { record, summary } = createCheckLedger(CHECK_NAMES)

const FIXTURE = [
  '---',
  'title: Object Widget DOM Fixture',
  '---',
  '',
  '## Objects',
  '',
  '### Pipe table',
  '{id=pipe-table}',
  '',
  '| Role | Tool |',
  '| --- | --- |',
  '| Builder | TalkWeaver |',
  '|  |  |',
  '| Reviewer | Driver |',
  '',
  '### Legal short-separator table',
  '{id=short-table}',
  '',
  '| Role | Tool |',
  '|-|-|',
  '| Builder | TalkWeaver |',
  '',
  '### Trigger table',
  '{table}{id=trigger-table}',
  '',
  '- Role {icon=lucide:brain}',
  '  - Oracle {brain}',
  '- Tool',
  '  - TalkWeaver',
  '',
  '### Hostile mindmap',
  '{mindmap}{id=hostile-mindmap}',
  '',
  '- <img src=x onerror="window.__twMarkmapXss=1">',
  '  - Safe branch',
  '',
  '### Marker mindmap',
  '{mindmap}{id=marker-mindmap}',
  '',
  '* Root',
  '  * Child',
  '',
  '### Valid Mermaid labels',
  '{id=valid-mermaid}',
  '',
  '```mermaid',
  'flowchart LR',
  '  A[Visible start] --> B[Visible finish]',
  '```',
  '',
  '### Hostile Mermaid label',
  '{id=hostile-mermaid}',
  '',
  '```mermaid',
  'flowchart LR',
  '  A["<img src=x onerror=window.__twMermaidXss=1>"] --> B',
  '```',
  '',
  '### Invalid non-empty Mermaid',
  '{id=invalid-mermaid}',
  '',
  '```mermaid',
  'this is not valid Mermaid syntax',
  '```',
  '',
  '### Empty Mermaid',
  '{id=empty-mermaid}',
  '',
  '```mermaid',
  '',
  '```',
  '',
  '### Valid SVG',
  '{id=valid-svg}',
  '',
  '```SVG preview dark',
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8"/></svg>',
  '```',
  '',
  '### Empty SVG',
  '{id=empty-svg}',
  '',
  '```svg',
  '',
  '```',
  '',
  '### Invalid non-empty SVG',
  '{id=invalid-svg}',
  '',
  '```svg',
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
  '```',
  ''
].join('\n')

const tempRoot = mkdtempSync(join(tmpdir(), `tw-object-widgets-${Date.now()}-`))
const vault = join(tempRoot, 'vault')
const userData = join(tempRoot, 'userData')
const talkDir = join(vault, 'object-widget-dom-fixture')
const outlinePath = join(talkDir, 'object-widget-dom-fixture-outline.md')
mkdirSync(talkDir, { recursive: true })
mkdirSync(userData, { recursive: true })
writeFileSync(outlinePath, FIXTURE)
writeFileSync(join(userData, 'config.json'), JSON.stringify({ vaultRoot: vault }, null, 2))

let app = null
let page = null

const EXPECTED_WIDGET_TITLES = [
  'Pipe table',
  'Legal short-separator table',
  'Trigger table',
  'Hostile mindmap',
  'Marker mindmap',
  'Valid Mermaid labels',
  'Hostile Mermaid label',
  'Invalid non-empty Mermaid',
  'Empty Mermaid',
  'Valid SVG',
  'Empty SVG',
  'Invalid non-empty SVG'
]

async function scrollPositions() {
  return page.locator('.cm-scroller').evaluate((scroller) => {
    const maximum = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
    const step = Math.max(160, Math.floor(scroller.clientHeight * 0.45))
    const positions = []
    for (let top = 0; top < maximum; top += step) positions.push(top)
    positions.push(maximum)
    return [...new Set(positions)]
  })
}

async function setEditorScroll(top) {
  await page.locator('.cm-scroller').evaluate((scroller, next) => { scroller.scrollTop = next }, top)
  await page.waitForTimeout(180)
}

async function mountedWidgetIndex(title) {
  return page.evaluate((wanted) => {
    const headings = Array.from(document.querySelectorAll('.cm-content .cm-line'))
      .filter((line) => /^###\s/.test((line.textContent || '').trim()))
    const titleFor = (node) => {
      const preceding = headings.filter((heading) =>
        Boolean(heading.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)
      )
      return (preceding.at(-1)?.textContent || '').trim().replace(/^###\s+/, '')
    }
    return Array.from(document.querySelectorAll('[data-object-block]'))
      .findIndex((node) => titleFor(node) === wanted)
  }, title)
}

async function requireMountedWidget(title) {
  for (const top of await scrollPositions()) {
    await setEditorScroll(top)
    const index = await mountedWidgetIndex(title)
    if (index < 0) continue
    const widget = page.locator('[data-object-block]').nth(index)
    if (await widget.count() === 1) return widget
  }
  throw new Error(`Target object widget "${title}" is not mounted before its probe`)
}

async function scanMountedWidgets() {
  return page.evaluate(() => {
    const headings = Array.from(document.querySelectorAll('.cm-content .cm-line'))
      .filter((line) => /^###\s/.test((line.textContent || '').trim()))
    const titleFor = (node) => {
      const preceding = headings.filter((heading) =>
        Boolean(heading.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)
      )
      return (preceding.at(-1)?.textContent || '').trim().replace(/^###\s+/, '')
    }
    return Array.from(document.querySelectorAll('[data-object-block]')).map((node) => {
      const header = node.querySelector(':scope > .tw-obj-head')
      const zoom = header?.querySelector(':scope > .tw-obj-zoom')
      return {
        title: titleFor(node),
        kind: node.getAttribute('data-object-block'),
        headerClasses: header ? Array.from(header.children).map((child) => child.className) : [],
        failed: node.classList.contains('tw-obj-failed'),
        empty: node.classList.contains('tw-obj-empty'),
        rawPopulated: Boolean(node.querySelector(':scope > .tw-obj-rawsrc')?.textContent?.trim()),
        errorPopulated: Boolean(node.querySelector(':scope > .tw-obj-error')?.textContent?.trim()),
        neutralPrompt: /ready|press ↵|type/i.test(node.textContent || ''),
        zoomAbsent: !zoom
      }
    })
  })
}

async function rawState(widget) {
  const toggle = widget.locator(':scope > .tw-obj-head > .tw-obj-raw')
  return {
    active: await toggle.evaluate((node) => node.classList.contains('is-active')),
    rawCount: await widget.locator(':scope > .tw-obj-rawsrc').count()
  }
}

async function requirePainted(locator, label) {
  const count = await locator.count()
  if (count !== 1) throw new Error(`${label} must exist exactly once before its paint check; count=${count}`)
  const painted = await locator.evaluate((node) => {
    const rect = node.getBoundingClientRect()
    const style = getComputedStyle(node)
    return rect.width > 0
      && rect.height > 0
      && style.display !== 'none'
      && style.visibility !== 'hidden'
  })
  if (!painted) throw new Error(`${label} exists but is not painted`)
}

async function waitForOutlineSaveToSettle() {
  const unsaved = page.getByText('● Unsaved', { exact: true })
  await unsaved.waitFor({ state: 'visible', timeout: 3000 })
  await unsaved.waitFor({ state: 'hidden', timeout: 8000 })
}

async function openObjectEditor(title, expectedSurface) {
  const widget = await requireMountedWidget(title)
  await requirePainted(widget, `${title} closed widget`)
  await widget.dblclick()
  const shell = page.locator('.oe')
  await shell.waitFor({ state: 'visible' })
  await requirePainted(shell, `${title} editor shell`)
  const surface = shell.locator(expectedSurface)
  await requirePainted(surface, `${title} ${expectedSurface} surface`)
  return shell
}

async function rawObjectSource(title) {
  let widget = await requireMountedWidget(title)
  await widget.locator(':scope > .tw-obj-head > .tw-obj-raw').dispatchEvent('mousedown')
  await page.waitForTimeout(160)
  widget = await requireMountedWidget(title)
  const raw = widget.locator(':scope > .tw-obj-rawsrc')
  await requirePainted(raw, `${title} raw source`)
  const source = await raw.textContent()
  await widget.locator(':scope > .tw-obj-head > .tw-obj-raw').dispatchEvent('mousedown')
  await page.waitForTimeout(160)
  return { source: source ?? '' }
}

try {
  await ensureFreshBuild(REPO)
  app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    cwd: REPO,
    env: { ...process.env, TW_E2E: '1' }
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await openTalkByTitle(page, 'Object Widget DOM Fixture')
  await page.waitForSelector('[data-object-block]', { timeout: 8000 })
  await page.waitForTimeout(1800)

  const accumulated = new Map()
  for (const top of await scrollPositions()) {
    await setEditorScroll(top)
    await page.waitForTimeout(450)
    for (const snapshot of await scanMountedWidgets()) {
      if (!snapshot.title) continue
      const previous = accumulated.get(snapshot.title)
      accumulated.set(snapshot.title, {
        ...snapshot,
        failed: Boolean(previous?.failed || snapshot.failed),
        empty: Boolean(previous?.empty || snapshot.empty),
        rawPopulated: Boolean(previous?.rawPopulated || snapshot.rawPopulated),
        errorPopulated: Boolean(previous?.errorPopulated || snapshot.errorPopulated),
        neutralPrompt: Boolean(previous?.neutralPrompt || snapshot.neutralPrompt)
      })
    }
  }
  const accumulatedTitles = [...accumulated.keys()]
  const allWidgetsSeen = EXPECTED_WIDGET_TITLES.every((title) => accumulated.has(title))
  record(
    'scrolling sees every fixture object widget despite CodeMirror virtualisation',
    allWidgetsSeen && accumulated.size === EXPECTED_WIDGET_TITLES.length,
    `seen=${JSON.stringify(accumulatedTitles)}`
  )

  const expectedHeader = [
    'tw-obj-kind',
    'tw-obj-step',
    'tw-obj-slot',
    'tw-obj-raw'
  ]
  const headerGrammar = EXPECTED_WIDGET_TITLES.every((title) =>
    JSON.stringify(accumulated.get(title)?.headerClasses) === JSON.stringify(expectedHeader)
  )
  record(
    'header grammar is kind, step model, slot chip, raw, and nothing else on every widget',
    headerGrammar,
    `checked=${accumulated.size}`
  )

  // The convergence plan parks fidelity zoom, so the shipped header must not render its affordance.
  const zoomContract = headerGrammar
    && EXPECTED_WIDGET_TITLES.every((title) => accumulated.get(title)?.zoomAbsent)
  record(
    'parked zoom control is absent from every widget header',
    zoomContract,
    `checked=${accumulated.size}`
  )

  let everyRawToggle = true
  for (const title of EXPECTED_WIDGET_TITLES) {
    let widget = await requireMountedWidget(title)
    const before = await rawState(widget)
    await widget.locator(':scope > .tw-obj-head > .tw-obj-raw').dispatchEvent('mousedown')
    await page.waitForTimeout(160)
    widget = await requireMountedWidget(title)
    const afterOpen = await rawState(widget)

    await widget.locator(':scope > .tw-obj-head > .tw-obj-raw').dispatchEvent('mousedown')
    await page.waitForTimeout(160)
    widget = await requireMountedWidget(title)
    const afterClose = await rawState(widget)
    everyRawToggle = everyRawToggle
      && afterOpen.active !== before.active
      && afterOpen.rawCount === 1
      && afterClose.active === before.active
      && afterClose.rawCount === before.rawCount
  }
  record('raw-view toggle changes state and restores every object widget', everyRawToggle)

  // O-C editing loop. Each target is asserted to exist and be painted before behaviour is probed;
  // CodeMirror only mounts block widgets in the viewport, so requireMountedWidget scrolls first.
  let shell = await openObjectEditor('Pipe table', '.tge')
  const firstCell = shell.locator('.tge textarea[data-row="0"][data-column="0"]')
  await requirePainted(firstCell, 'pipe-table cell (0,0)')
  await firstCell.fill('Edited role')
  await firstCell.press('Meta+Enter')
  await shell.waitFor({ state: 'detached' })
  await waitForOutlineSaveToSettle()
  const editedPipe = await rawObjectSource('Pipe table')
  const editedPipeFile = readFileSync(outlinePath, 'utf8')
  record(
    'GFM table editor commits cell (0,0) back to pipe-table document bytes',
    editedPipe.source.includes('| Edited role | Tool |')
      && editedPipeFile.includes('| Edited role | Tool |')
      && editedPipe.source.includes('|  |  |'),
    JSON.stringify({ source: editedPipe.source, fileHasEdit: editedPipeFile.includes('| Edited role | Tool |') })
  )

  // A blank markup commit is refused. The shell and visible note remain; the temp vault also stays
  // byte-identical after the refusal, proving the hidden canonical doc was not changed.
  shell = await openObjectEditor('Pipe table', '.tge')
  const markupTab = shell.locator('.oe-tabs button', { hasText: 'Markup' })
  await requirePainted(markupTab, 'pipe-table Markup tab')
  await markupTab.click()
  const markup = shell.locator('.oe-markup')
  await requirePainted(markup, 'pipe-table markup textarea')
  await markup.fill('')
  // The preceding write crossed the app's own saved/dirty boundary before this editor opened, so
  // the fixture file is now a deterministic no-write witness for the deliberate refusal.
  const beforeRefusal = readFileSync(outlinePath, 'utf8')
  await markup.press('Meta+Enter')
  await requirePainted(shell, 'refused pipe-table editor shell')
  const refusalNote = shell.locator('.oe-parse-note')
  await requirePainted(refusalNote, 'refused pipe-table parse note')
  await page.waitForTimeout(700)
  const afterRefusal = readFileSync(outlinePath, 'utf8')
  record(
    'empty-over-nonempty table commit fails closed and leaves the document unchanged',
    beforeRefusal === afterRefusal
      && beforeRefusal.includes('| Edited role | Tool |')
      && await shell.count() === 1,
    `note=${JSON.stringify(await refusalNote.textContent())}`
  )

  // A document update above the open object makes CodeMirror offer a replacement editor widget.
  // Insert and remove one heading character so the canonical bytes end where they began; the first
  // transaction still exercises the teardown preflight against the deliberately invalid pane.
  const headingLine = page.locator('.cm-line').filter({ hasText: '## Objects' }).first()
  await headingLine.scrollIntoViewIfNeeded()
  await headingLine.click()
  await page.keyboard.press('End')
  await page.keyboard.insertText('x')
  await page.keyboard.press('Backspace')
  await page.waitForTimeout(250)
  await requirePainted(shell, 'table shell retained after teardown refusal')
  await requirePainted(refusalNote, 'teardown refusal reason retained in shell')
  await waitForOutlineSaveToSettle()
  const afterTeardownRefusal = readFileSync(outlinePath, 'utf8')
  record(
    'teardown refusal keeps the shell, typed content, and reason while document bytes stay unchanged',
    beforeRefusal === afterTeardownRefusal
      && await shell.count() === 1
      && await markup.inputValue() === ''
      && /not saved.*inner source was empty.*text is still here/i.test(
        await refusalNote.textContent() ?? ''
      ),
    `note=${JSON.stringify(await refusalNote.textContent())}`
  )
  // Restore the valid source through the still-open markup editor so the remainder of this suite
  // is not held hostage by the deliberate refusal.
  await markup.fill(editedPipe.source.trimEnd())
  await markup.press('Meta+Enter')
  await shell.waitFor({ state: 'detached' })

  shell = await openObjectEditor('Legal short-separator table', '.tge')
  const shortCell = shell.locator('.tge textarea[data-row="0"][data-column="0"]')
  await requirePainted(shortCell, 'short-separator table cell (0,0)')
  await shortCell.fill('Edited role')
  await shortCell.press('Meta+Enter')
  await shell.waitFor({ state: 'detached' })
  const editedShortTable = await rawObjectSource('Legal short-separator table')
  record(
    'legal short-separator GFM table edits in the grid without normalising its separator',
    editedShortTable.source.includes('| Edited role | Tool |')
      && editedShortTable.source.includes('|-|-|')
      && !editedShortTable.source.includes('| :--- |'),
    JSON.stringify({ source: editedShortTable.source })
  )

  shell = await openObjectEditor('Legal short-separator table', '.tge')
  await shell.locator('.tge textarea[data-row="0"][data-column="0"]').press('Escape')
  await shell.press('Escape')
  await shell.waitFor({ state: 'detached' })
  for (const [title, surface, target] of [
    ['Marker mindmap', '.oe-outline', '.oe-node input[data-node="0"]'],
    ['Valid Mermaid labels', '.oe-mermaid', '.oe-mermaid textarea'],
    ['Valid SVG', '.oe-svg', '.oe-svg textarea']
  ]) {
    shell = await openObjectEditor(title, surface)
    await shell.locator(target).press('Escape')
    await shell.waitFor({ state: 'detached' })
  }
  shell = await openObjectEditor('Legal short-separator table', '.tge')
  await shell.locator('.oe-tabs button', { hasText: 'Markup' }).click()
  await shell.locator('.oe-markup').press('Escape')
  await shell.waitFor({ state: 'detached' })
  record(
    'Escape commits and leaves from table, mindmap, Mermaid, SVG, and markup panes',
    (await rawObjectSource('Legal short-separator table')).source.includes('|-|-|')
  )

  for (const [title, surface, target, openMarkup] of [
    ['Legal short-separator table', '.tge', '.tge textarea[data-row="0"][data-column="0"]', false],
    ['Marker mindmap', '.oe-outline', '.oe-node input[data-node="0"]', false],
    ['Valid Mermaid labels', '.oe-mermaid', '.oe-mermaid textarea', false],
    ['Valid SVG', '.oe-svg', '.oe-svg textarea', false],
    ['Legal short-separator table', '.tge', '.oe-markup', true]
  ]) {
    shell = await openObjectEditor(title, surface)
    if (openMarkup) {
      await shell.locator('.oe-tabs button', { hasText: 'Markup' }).click()
    }
    await shell.locator(target).press('Control+Enter')
    await shell.waitFor({ state: 'detached' })
  }
  record(
    'Control-Enter finishes from table, mindmap, Mermaid, SVG, and markup panes',
    true
  )

  shell = await openObjectEditor('Trigger table', '.tge')
  const triggerCell = shell.locator('.tge textarea[data-row="0"][data-column="0"]')
  await requirePainted(triggerCell, 'trigger-table cell (0,0)')
  await triggerCell.fill('Edited trigger role')
  await triggerCell.press('Meta+Enter')
  await shell.waitFor({ state: 'detached' })
  await waitForOutlineSaveToSettle()
  const editedTrigger = await rawObjectSource('Trigger table')
  const editedTriggerFile = readFileSync(outlinePath, 'utf8')
  record(
    'trigger-table grid commit preserves nested-list storage and writes no pipe table',
    editedTrigger.source.includes('- Edited trigger role')
      && !editedTrigger.source.split('\n').some((line) => /^\s*\|/.test(line))
      && editedTriggerFile.includes('- Edited trigger role'),
    JSON.stringify({
      source: editedTrigger.source,
      fileHasEdit: editedTriggerFile.includes('- Edited trigger role')
    })
  )

  shell = await openObjectEditor('Marker mindmap', '.oe-outline')
  const markerRoot = shell.locator('.oe-node input[data-node="0"]')
  await requirePainted(markerRoot, 'marker-mindmap root input')
  await markerRoot.fill('Root edited')
  await markerRoot.press('Meta+Enter')
  await shell.waitFor({ state: 'detached' })
  const editedMarkerMindmap = await rawObjectSource('Marker mindmap')
  record(
    'mindmap editing preserves the authored star marker without inserting an empty node',
    editedMarkerMindmap.source.includes('* Root edited')
      && editedMarkerMindmap.source.includes('  * Child')
      && !editedMarkerMindmap.source.includes('- * Root')
      && !editedMarkerMindmap.source.split('\n').some((line) => /^\s*[-*]\s*$/.test(line)),
    JSON.stringify({ source: editedMarkerMindmap.source })
  )

  shell = await openObjectEditor('Valid Mermaid labels', '.oe-mermaid')
  const mermaidMarkupTab = shell.locator('.oe-tabs button', { hasText: 'Markup' })
  await mermaidMarkupTab.click()
  const mermaidMarkup = shell.locator('.oe-markup')
  await mermaidMarkup.fill('')
  await mermaidMarkup.press('Meta+Enter')
  const mermaidRefusal = shell.locator('.oe-parse-note')
  await requirePainted(mermaidRefusal, 'empty Mermaid refusal reason')
  record(
    'empty-over-nonempty guard rejects a fenced Mermaid body and names the inner-source reason',
    await shell.count() === 1
      && /inner source was empty/i.test(await mermaidRefusal.textContent() ?? '')
  )
  await mermaidMarkup.fill('flowchart LR\n  A[Visible start] --> B[Visible finish]')
  await mermaidMarkup.press('Meta+Enter')
  await shell.waitFor({ state: 'detached' })

  shell = await openObjectEditor('Valid SVG', '.oe-svg')
  const svgMarkupTab = shell.locator('.oe-tabs button', { hasText: 'Markup' })
  await svgMarkupTab.click()
  const svgMarkup = shell.locator('.oe-markup')
  await svgMarkup.fill(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><rect x="2" y="2" width="16" height="16"/></svg>'
  )
  await svgMarkup.press('Meta+Enter')
  await shell.waitFor({ state: 'detached' })
  const editedSvg = await rawObjectSource('Valid SVG')
  record(
    'fenced object editing preserves the original SVG info string',
    editedSvg.source.includes('```SVG preview dark')
      && editedSvg.source.includes('<rect'),
    JSON.stringify({ source: editedSvg.source })
  )

  const failedTitles = [
    'Hostile Mermaid label',
    'Invalid non-empty Mermaid',
    'Invalid non-empty SVG'
  ]
  const failedSeen = EXPECTED_WIDGET_TITLES.filter((title) => accumulated.get(title)?.failed)
  let invalidVisible =
    JSON.stringify(failedSeen) === JSON.stringify(failedTitles)
    && failedTitles.every((title) =>
      accumulated.get(title)?.rawPopulated && accumulated.get(title)?.errorPopulated
    )
  for (const title of failedTitles) {
    let widget = await requireMountedWidget(title)
    await page.waitForTimeout(900)
    widget = await requireMountedWidget(title)
    invalidVisible = invalidVisible && await widget.evaluate((node) => {
      const raw = node.querySelector(':scope > .tw-obj-rawsrc')
      const error = node.querySelector(':scope > .tw-obj-error')
      return node.classList.contains('tw-obj-failed')
        && Boolean(raw?.textContent?.trim() && error?.textContent?.trim())
    })
  }
  record(
    'all three invalid non-empty sources fail visibly over populated raw text',
    invalidVisible,
    `failed=${JSON.stringify(failedSeen)}`
  )

  const emptyTitles = ['Empty Mermaid', 'Empty SVG']
  const emptySeen = EXPECTED_WIDGET_TITLES.filter((title) => accumulated.get(title)?.empty)
  let emptyNeutral =
    JSON.stringify(emptySeen) === JSON.stringify(emptyTitles)
    && emptyTitles.every((title) => accumulated.get(title)?.neutralPrompt)
  for (const title of emptyTitles) {
    const widget = await requireMountedWidget(title)
    emptyNeutral = emptyNeutral && await widget.evaluate((node) =>
      node.classList.contains('tw-obj-empty')
      && !node.classList.contains('tw-obj-failed')
      && /ready|press ↵|type/i.test(node.textContent || '')
    )
  }
  record('empty Mermaid and SVG are neutral ready-to-type objects', emptyNeutral, `empty=${JSON.stringify(emptySeen)}`)

  let target = await requireMountedWidget('Hostile mindmap')
  await page.waitForTimeout(900)
  target = await requireMountedWidget('Hostile mindmap')
  const markmapSafe = await target.evaluate((node) => ({
    handlers: node.querySelectorAll('[onerror], [onclick]').length,
    images: node.querySelectorAll('img').length,
    fired: Boolean(window.__twMarkmapXss)
  }))
  record(
    'markmap rendered-node HTML refuses the hostile image',
    markmapSafe.handlers === 0 && markmapSafe.images === 0 && !markmapSafe.fired,
    JSON.stringify(markmapSafe)
  )

  target = await requireMountedWidget('Hostile Mermaid label')
  await page.waitForTimeout(900)
  target = await requireMountedWidget('Hostile Mermaid label')
  const mermaidSafe = await target.evaluate((node) => ({
    mounted: node.isConnected,
    failed: node.classList.contains('tw-obj-failed'),
    handlers: node.querySelectorAll('[onerror], [onclick]').length,
    scripts: node.querySelectorAll('script').length,
    fired: Boolean(window.__twMermaidXss)
  }))
  record(
    'Mermaid SVG innerHTML refuses hostile elements and attributes',
    mermaidSafe.mounted
      && mermaidSafe.failed
      && mermaidSafe.handlers === 0
      && mermaidSafe.scripts === 0
      && !mermaidSafe.fired,
    JSON.stringify(mermaidSafe)
  )

  target = await requireMountedWidget('Valid Mermaid labels')
  await page.waitForTimeout(900)
  target = await requireMountedWidget('Valid Mermaid labels')
  const mermaidLabelsVisible = await target.evaluate((node) => {
    const svg = node.querySelector(':scope > .tw-obj-body svg')
    const text = svg?.textContent || ''
    return Boolean(svg && text.includes('Visible start') && text.includes('Visible finish'))
  })
  record(
    'valid Mermaid rendered SVG contains its node label text',
    mermaidLabelsVisible
  )

  const hidden = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().every((window) => !window.isVisible())
  )
  record('the DOM suite keeps every Electron test window hidden', hidden)
} catch (error) {
  console.error(
    `SUITE ABORT  ${error instanceof Error ? error.stack || error.message : String(error)}`
  )
} finally {
  const outcome = summary('OBJECT WIDGET SUMMARY')
  if (app) await app.close()
  process.exit(outcome.exitCode)
}
