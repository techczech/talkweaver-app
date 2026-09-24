// Hidden-Electron checks for the Task 8/13/18 object doors. The builder authors this file but
// does not execute it; a separate tester owns app-driving runs.
import { _electron as electron } from 'playwright'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { createCheckLedger } from './lib/check-ledger.mjs'
import { visibleIntersectionCentre } from './lib/pointer-geometry.mjs'
import { openTalkByTitle } from './lib/talklist.mjs'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { extractSlides, extractStyles } from '../compiler/scripts/lib/04-html-extraction.mjs'
import { buildShareHtml } from '../compiler/scripts/lib/09-output-builders.mjs'
import { fileURLToPath, pathToFileURL } from 'url'
import { dirname, join } from 'path'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = join(__dirname, '..')
const CHECK_NAMES = [
  'Enter in a slide heading preserves its heading and Trigger-line bytes',
  'Enter in the canonical Trigger line creates a body without splitting structure',
  'Enter at the end of a slide heading preserves Trigger-line adjacency',
  'Enter in a block-scoped object token preserves its owned list',
  'TSV paste inserts a rendered GFM table object',
  'setext prose paste does not become a table',
  'thematic-break paste does not become a table',
  'tab-indented code paste does not become a table',
  'space-then-tab code paste does not become a table',
  'tab-bearing slide Markdown with an asset reference does not become a table',
  'triple-backtick opens the slide object menu',
  'triple-backtick highlights the first Insert object command',
  'valid Mermaid renders in the outline widget and compiles to a .mermaid-mm host',
  'valid SVG renders in the outline widget',
  'hostile SVG shows populated raw source and a visible error in the outline widget',
  'the Command-K Chart row eagerly stamps an unstamped slide and writes a fence below it',
  'editing the inserted chart changes only that fence-body line on disk',
  'the closed chart widget re-renders with the edited value visible',
  'the three chart forms render one fence widget and flag both compatibility forms inline',
  'a trigger-line-only chart still renders and edits',
  'the inserted block, Gate shape and compatibility chart compile correctly in deck and handout',
  'the compiled deck paints the chart host in a hidden window',
  'a garbled chart list fails visibly over its raw source',
  'the brace palette chart chain writes the selected fenced form',
  'the Electron windows stay hidden and the editor stays live'
]
const { record, summary } = createCheckLedger(CHECK_NAMES)
const attempted = new Set()

const fixture = [
  '---',
  'title: Object Doors Fixture',
  'auto_title_slide: false',
  'auto_thanks_slide: false',
  '---',
  '',
  '## Objects',
  '{id=objects}',
  '',
  '### Valid Mermaid',
  '{id=valid-mermaid}',
  '',
  '```mermaid',
  'flowchart LR',
  '  A[Draft] --> B[Feedback]',
  '```',
  '',
  '### Valid SVG',
  '{id=valid-svg}',
  '',
  '```svg',
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8"/></svg>',
  '```',
  '',
  '### Hostile SVG',
  '{id=hostile-svg}',
  '',
  '```svg',
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
  '```',
  '',
  '### Protected heading middle',
  '{id=protected-heading}{sidebar}',
  '',
  'Protected heading body',
  '',
  '### Protected title end',
  '{id=protected-title-end}{statement}',
  '',
  'Protected title-end body',
  '',
  '### Protected block token',
  '{id=protected-block-token}',
  '',
  '{chart=bar}',
  '- Alpha: 40',
  '- Beta: 60',
  '',
  '### Chart insertion target',
  '',
  '### Chart edit target',
  '{id=chart-edit}',
  '',
  '```chart=bar',
  '- Alpha: 40',
  '- Beta: 25',
  '- Gamma: 35',
  '```',
  '',
  '### Chart rerender target',
  '{id=chart-rerender}',
  '',
  '{chart=bar}',
  '- Alpha: 40',
  '- Beta: 25',
  '- Gamma: 35',
  '',
  '### Compile insertion target',
  '',
  '### Deck window chart',
  '{id=deck-window-chart}',
  '',
  '{chart=bar}',
  '- Alpha: 40',
  '- Beta: 25',
  '- Gamma: 35',
  '',
  '### Gate contradiction',
  '{id=gate-shape} {chart=bar}',
  '',
  '{piechart}',
  '- Alpha: 40',
  '- Beta: 60',
  '',
  '```chart=line',
  '- 2024: 25',
  '- 2025: 75',
  '```',
  '',
  '### Compatibility chart',
  '{id=compatibility-chart} {chart=bar}',
  '',
  '- Alpha: 40',
  '- Beta: 60',
  '',
  '### Garbled chart',
  '{id=garbled-chart}',
  '',
  '```chart=bar',
  '- Alpha: 40',
  '| This value is garbled',
  '```',
  '',
  '### Brace chart target',
  '{id=brace-chart}',
  '',
  'Brace chart insertion point',
  '',
  '### Paste and fence doors',
  '{id=object-doors}',
  '',
  '### Protected trigger at EOF',
  '{id=protected-trigger}{sidebar}'
].join('\n')

const scratch = mkdtempSync(join(REPO, '.tw-object-doors-'))
const vault = join(scratch, 'vault')
const userData = join(scratch, 'userData')
const talkDir = join(vault, 'object-doors-fixture')
const outlinePath = join(talkDir, 'object-doors-fixture-outline.md')
mkdirSync(talkDir, { recursive: true })
mkdirSync(userData, { recursive: true })
writeFileSync(outlinePath, fixture)
writeFileSync(join(userData, 'config.json'), JSON.stringify({ vaultRoot: vault }, null, 2))

let app = null
let page = null
let editor = null

async function check(name, probe) {
  attempted.add(name)
  try {
    const result = await probe()
    const pass = typeof result === 'object' && result !== null ? Boolean(result.pass) : Boolean(result)
    const detail = typeof result === 'object' && result !== null ? String(result.detail ?? '') : ''
    record(name, pass, detail)
  } catch (error) {
    record(name, false, error instanceof Error ? error.message : String(error))
  }
}

async function editorScrollPositions() {
  return page.locator('.cm-scroller').evaluate((scroller) => {
    const maximum = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
    const step = Math.max(160, Math.floor(scroller.clientHeight * 0.45))
    const positions = []
    for (let top = 0; top < maximum; top += step) positions.push(top)
    positions.push(maximum)
    return [...new Set(positions)]
  })
}

let mountedWidgetTargetSerial = 0

async function pinMountedWidget(title) {
  const targetId = `tw-e2e-object-${mountedWidgetTargetSerial++}`
  const pinned = await page.evaluate(({ wanted, targetId }) => {
    const headings = Array.from(document.querySelectorAll('.cm-content .cm-line'))
      .filter((line) => /^###\s/.test((line.textContent || '').trim()))
    const titleFor = (node) => {
      const preceding = headings.filter((heading) =>
        Boolean(heading.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)
      )
      return (preceding.at(-1)?.textContent || '').trim().replace(/^###\s+/, '')
    }
    const target = Array.from(document.querySelectorAll('[data-object-block]'))
      .find((node) => titleFor(node) === wanted)
    if (!target) return false
    target.setAttribute('data-e2e-object-target', targetId)
    return true
  }, { wanted: title, targetId })
  return pinned ? page.locator(`[data-e2e-object-target="${targetId}"]`) : null
}

async function requireMountedWidget(title) {
  for (const top of await editorScrollPositions()) {
    await page.locator('.cm-scroller').evaluate((scroller, next) => { scroller.scrollTop = next }, top)
    await page.waitForTimeout(180)
    const widget = await pinMountedWidget(title)
    if (widget) {
      await widget.scrollIntoViewIfNeeded()
      return widget
    }
  }
  throw new Error(`Target object widget "${title}" did not mount`)
}

async function mountedWidgetCount(title) {
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
      .filter((node) => titleFor(node) === wanted)
      .length
  }, title)
}

async function pointerHit(locator) {
  await locator.scrollIntoViewIfNeeded()
  const geometry = await locator.evaluate((target) => {
    const rect = target.getBoundingClientRect()
    return {
      rect: {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height
      },
      viewport: {
        width: document.documentElement.clientWidth,
        height: document.documentElement.clientHeight
      }
    }
  })
  const visible = visibleIntersectionCentre(geometry.rect, geometry.viewport)
  if (!visible) {
    return {
      clear: false,
      point: null,
      stack: [],
      targetRect: geometry.rect,
      visibleRect: null,
      viewport: geometry.viewport
    }
  }

  return locator.evaluate((target, hit) => {
    const describe = (node) => {
      const style = getComputedStyle(node)
      return {
        tag: node.tagName.toLowerCase(),
        id: node.id || null,
        class: typeof node.className === 'string' && node.className ? node.className : null,
        role: node.getAttribute('role'),
        ariaLabel: node.getAttribute('aria-label'),
        position: style.position,
        zIndex: style.zIndex,
        pointerEvents: style.pointerEvents
      }
    }
    const stack = document.elementsFromPoint(hit.x, hit.y)
    const top = stack[0] ?? null
    return {
      clear: Boolean(top && (top === target || target.contains(top))),
      point: { x: Math.round(hit.x), y: Math.round(hit.y) },
      stack: stack.slice(0, 5).map(describe),
      targetRect: hit.targetRect,
      visibleRect: hit.visibleRect,
      viewport: hit.viewport
    }
  }, {
    x: visible.x,
    y: visible.y,
    targetRect: geometry.rect,
    visibleRect: visible.rect,
    viewport: geometry.viewport
  })
}

async function requirePointerTarget(locator, label) {
  await locator.scrollIntoViewIfNeeded()
  const hit = await pointerHit(locator)
  if (!hit.clear) {
    const point = hit.point ? `${hit.point.x},${hit.point.y}` : 'no visible point'
    throw new Error(
      `${label} is blocked at ${point}: ${JSON.stringify(hit.stack)}`
      + `; geometry=${JSON.stringify({
        targetRect: hit.targetRect,
        visibleRect: hit.visibleRect,
        viewport: hit.viewport
      })}`
    )
  }
  return hit
}

async function openObjectEditor(title, expectedSurface) {
  const widget = await requireMountedWidget(title)
  await widget.scrollIntoViewIfNeeded()
  const hit = await requirePointerTarget(widget, `Object widget "${title}"`)
  if (!hit.point) throw new Error(`Object widget "${title}" has no pointer target`)
  // Playwright's locator.dblclick() emits both clicks in the same millisecond. The first click
  // selects and re-renders a closed CodeMirror widget, so its second mousedown can hit the transient
  // source line before the selected widget remounts. Preserve real double-click detail with a
  // human-scale interval between the two browser-level clicks.
  await page.mouse.move(hit.point.x, hit.point.y)
  await page.mouse.down({ button: 'left', clickCount: 1 })
  await page.mouse.up({ button: 'left', clickCount: 1 })
  await page.waitForTimeout(50)
  await page.mouse.down({ button: 'left', clickCount: 2 })
  await page.mouse.up({ button: 'left', clickCount: 2 })
  const shell = page.locator('.oe')
  await shell.waitFor({ state: 'visible', timeout: 3000 })
  await shell.locator(expectedSurface).waitFor({ state: 'visible', timeout: 3000 })
  return shell
}

async function closeObjectEditor(shell) {
  if (!await shell.isVisible().catch(() => false)) return
  await page.keyboard.press('Escape')
  await shell.waitFor({ state: 'hidden', timeout: 3000 })
}

async function closeFenceMenu(menu) {
  if (!await menu.isVisible().catch(() => false)) return
  await page.keyboard.press('Escape')
  await menu.waitFor({ state: 'hidden', timeout: 3000 })
}

function slideMarkup(html, id) {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return html.match(new RegExp(`<section\\b[^>]*data-id="${escaped}"[^>]*>[\\s\\S]*?<\\/section>`))?.[0] ?? ''
}

async function focusEditorLine(text) {
  const line = await requireMountedEditorLine(text)
  await requirePointerTarget(line, `Editor line "${text}"`)
  await line.click()
  await page.keyboard.press('End')
  return line
}

async function findExactMountedLine(text) {
  const lines = page.locator('.cm-content .cm-line').filter({ hasText: text })
  for (let index = 0; index < await lines.count(); index += 1) {
    const line = lines.nth(index)
    if ((await line.textContent())?.trim() === text) return line
  }
  return null
}

async function requireMountedEditorLine(text) {
  const scroller = page.locator('.cm-scroller')
  for (const top of await editorScrollPositions()) {
    await scroller.evaluate((element, next) => { element.scrollTop = next }, top)
    await page.waitForTimeout(180)
    const line = await findExactMountedLine(text)
    if (line) {
      await line.scrollIntoViewIfNeeded()
      return line
    }
  }
  // Async object widgets can increase the document height while the snapshotted positions above
  // are being visited. Retry once at the current live bottom so an EOF line is not skipped.
  await scroller.evaluate((element) => { element.scrollTop = element.scrollHeight })
  await page.waitForTimeout(180)
  const line = await findExactMountedLine(text)
  if (line) {
    await line.scrollIntoViewIfNeeded()
    return line
  }
  throw new Error(`Editor line "${text}" did not mount`)
}

async function focusEditorLineAt(text, column) {
  const line = await focusEditorLine(text)
  await line.scrollIntoViewIfNeeded()
  await page.keyboard.press('Home')
  for (let index = 0; index < column; index += 1) {
    await page.keyboard.press('ArrowRight')
  }
}

function structuralWitness(source, {
  heading,
  trigger,
  blockToken = null,
  firstListItem = null
}) {
  const lines = source.split('\n')
  const headingIndexes = lines.flatMap((line, index) => line === heading ? [index] : [])
  const headingIndex = headingIndexes[0] ?? -1
  const triggerAdjacent = headingIndex >= 0 && lines[headingIndex + 1] === trigger
  const tokenIndex = blockToken == null ? -1 : lines.indexOf(blockToken, headingIndex + 2)
  const listAdjacent = blockToken == null
    || (tokenIndex >= 0 && lines[tokenIndex + 1] === firstListItem)
  return {
    pass: headingIndexes.length === 1 && triggerAdjacent && listAdjacent,
    detail: `headingCount=${headingIndexes.length} triggerAdjacent=${triggerAdjacent} tokenIndex=${tokenIndex} listAdjacent=${listAdjacent}`
  }
}

async function waitForOutlineSaveToSettle() {
  const unsaved = page.getByText('● Unsaved', { exact: true })
  await unsaved.waitFor({ state: 'visible', timeout: 3000 })
  await unsaved.waitFor({ state: 'hidden', timeout: 8000 })
}

async function pasteAtEnd(text) {
  await editor.scrollIntoViewIfNeeded()
  await requirePointerTarget(editor, 'Editor')
  await editor.click()
  await page.keyboard.press('Meta+End')
  await page.keyboard.press('Enter')
  const delimiterRowsBefore = countTableDelimiterRows(readFileSync(outlinePath, 'utf8'))
  const before = await page.locator('[data-object-block="table"]').count()
  await editor.evaluate((target, pasted) => {
    const transfer = new DataTransfer()
    transfer.setData('text/plain', pasted)
    target.dispatchEvent(new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer
    }))
  }, text)
  await page.waitForTimeout(1800)
  const after = await page.locator('[data-object-block="table"]').count()
  const delimiterRowsAfter = countTableDelimiterRows(readFileSync(outlinePath, 'utf8'))
  return { before, after, delimiterRowsBefore, delimiterRowsAfter }
}

function countTableDelimiterRows(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => /^\s*\|(?:\s*:?-{3,}:?\s*\|){2,}\s*$/.test(line))
    .length
}

function noTableWasAdded(result) {
  return {
    pass: result.delimiterRowsAfter === result.delimiterRowsBefore && result.after === result.before,
    detail: `delimiterRows ${result.delimiterRowsBefore} -> ${result.delimiterRowsAfter}; DOM tables ${result.before} -> ${result.after}`
  }
}

async function openFenceMenu() {
  const menu = page.locator('[data-slide-menu]')
  if (await menu.isVisible().catch(() => false)) {
    throw new Error('A slide object menu leaked from an earlier check')
  }
  await editor.scrollIntoViewIfNeeded()
  await requirePointerTarget(editor, 'Editor')
  await editor.click()
  await page.keyboard.press('Meta+End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('```')
  await menu.waitFor({ state: 'visible', timeout: 3000 })
  return menu
}

async function insertDefaultChart(title, nextTitle) {
  const menu = page.locator('[data-slide-menu]')
  let shell = null
  try {
    await focusEditorLine(`### ${title}`)
    await page.keyboard.press('Meta+k')
    await menu.waitFor({ state: 'visible', timeout: 3000 })
    await menu.locator('[data-slide-action="insert-chart"]').click()
    shell = page.locator('.oe')
    await shell.waitFor({ state: 'visible', timeout: 3000 })
    const outline = shell.locator('.oe-chart-outline')
    await outline.waitFor({ state: 'visible', timeout: 3000 })
    await waitForOutlineSaveToSettle()
    const source = readFileSync(outlinePath, 'utf8')
    const slideSource = source.slice(
      source.indexOf(`### ${title}`),
      source.indexOf(`### ${nextTitle}`)
    )
    const idMatch = slideSource.match(
      new RegExp(`^### ${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\n\\{id=([A-Za-z0-9_-]+)\\}\\n\\n\`\`\`chart=bar\\n`, 'm')
    )
    return {
      id: idMatch?.[1] ?? null,
      shell,
      slideSource,
      source
    }
  } catch (error) {
    if (shell) await closeObjectEditor(shell)
    if (await menu.isVisible().catch(() => false)) await closeFenceMenu(menu)
    throw error
  }
}

try {
  await ensureFreshBuild(REPO)
  app = await electron.launch({
    args: ['.', '--user-data-dir=' + userData],
    cwd: REPO,
    env: { ...process.env, TW_E2E: '1' }
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(1200)
  await openTalkByTitle(page, 'Object Doors Fixture')
  await page.waitForSelector('.cm-content', { timeout: 8000 })
  editor = page.locator('.cm-content')

  await check('the Command-K Chart row eagerly stamps an unstamped slide and writes a fence below it', async () => {
    let insertion = null
    try {
      insertion = await insertDefaultChart('Chart insertion target', 'Chart edit target')
      const expectedFence = '```chart=bar\n- Alpha: 40\n- Beta: 25\n- Gamma: 35\n```'
      return {
        pass: insertion.id !== null
          && insertion.slideSource.includes(expectedFence)
          && !insertion.slideSource.includes('{chart=bar}')
          && await insertion.shell.locator('.oe-tabs button', { hasText: 'Editor' }).count() === 1
          && await insertion.shell.locator('.oe-tabs button', { hasText: 'Markup' }).count() === 1,
        detail: `idOnlyTrigger=${insertion.id !== null} fenceBelow=${insertion.slideSource.includes(expectedFence)}`
      }
    } finally {
      if (insertion?.shell) await closeObjectEditor(insertion.shell)
    }
  })

  await check('Enter in a slide heading preserves its heading and Trigger-line bytes', async () => {
    const before = readFileSync(outlinePath, 'utf8')
    await focusEditorLineAt('### Protected heading middle', 9)
    await page.keyboard.press('Enter')
    const after = readFileSync(outlinePath, 'utf8')
    const witness = structuralWitness(after, {
      heading: '### Protected heading middle',
      trigger: '{id=protected-heading}{sidebar}'
    })
    return {
      pass: after === before && witness.pass,
      detail: `byteExact=${after === before} ${witness.detail}`
    }
  })
  await check('Enter in the canonical Trigger line creates a body without splitting structure', async () => {
    const before = readFileSync(outlinePath, 'utf8')
    await focusEditorLineAt('{id=protected-trigger}{sidebar}', 0)
    await page.keyboard.press('Enter')
    await waitForOutlineSaveToSettle()
    const after = readFileSync(outlinePath, 'utf8')
    const witness = structuralWitness(after, {
      heading: '### Protected trigger at EOF',
      trigger: '{id=protected-trigger}{sidebar}'
    })
    return {
      pass: after === `${before}\n` && witness.pass,
      detail: `onlyBodyLineAdded=${after === `${before}\n`} ${witness.detail}`
    }
  })
  await check('Enter at the end of a slide heading preserves Trigger-line adjacency', async () => {
    const before = readFileSync(outlinePath, 'utf8')
    await focusEditorLine('### Protected title end')
    await page.keyboard.press('Enter')
    const after = readFileSync(outlinePath, 'utf8')
    const witness = structuralWitness(after, {
      heading: '### Protected title end',
      trigger: '{id=protected-title-end}{statement}'
    })
    return {
      pass: after === before && witness.pass,
      detail: `byteExact=${after === before} ${witness.detail}`
    }
  })
  await check('Enter in a block-scoped object token preserves its owned list', async () => {
    const before = readFileSync(outlinePath, 'utf8')
    await focusEditorLineAt('{chart=bar}', 0)
    await page.keyboard.press('Enter')
    const after = readFileSync(outlinePath, 'utf8')
    const witness = structuralWitness(after, {
      heading: '### Protected block token',
      trigger: '{id=protected-block-token}',
      blockToken: '{chart=bar}',
      firstListItem: '- Alpha: 40'
    })
    return {
      pass: after === before && witness.pass,
      detail: `byteExact=${after === before} ${witness.detail}`
    }
  })
  await check('TSV paste inserts a rendered GFM table object', async () => {
    const result = await pasteAtEnd('Model\tFit\nGPT\tDrafting')
    return {
      pass: result.delimiterRowsAfter === result.delimiterRowsBefore + 1 && result.after === result.before + 1,
      detail: `delimiterRows ${result.delimiterRowsBefore} -> ${result.delimiterRowsAfter}; DOM tables ${result.before} -> ${result.after}`
    }
  })
  await check('setext prose paste does not become a table', async () => {
    return noTableWasAdded(await pasteAtEnd('A heading\n---'))
  })
  await check('thematic-break paste does not become a table', async () => {
    return noTableWasAdded(await pasteAtEnd('---'))
  })
  await check('tab-indented code paste does not become a table', async () => {
    return noTableWasAdded(await pasteAtEnd('\tconst value = 1\n\tconsole.log(value)'))
  })
  await check('space-then-tab code paste does not become a table', async () => {
    return noTableWasAdded(await pasteAtEnd('  \tfoo\tbar\n  \tbaz\tqux'))
  })
  await check('tab-bearing slide Markdown with an asset reference does not become a table', async () => {
    return noTableWasAdded(await pasteAtEnd('### Pasted slide\n\n![](assets/example.png)\tcaption'))
  })
  await check('triple-backtick opens the slide object menu', async () => {
    const menu = await openFenceMenu()
    try {
      return menu.isVisible()
    } finally {
      await closeFenceMenu(menu)
    }
  })
  await check('triple-backtick highlights the first Insert object command', async () => {
    const menu = await openFenceMenu()
    try {
      return menu.locator('[data-slide-action="insert-table"].tl-mi--kbd').count().then((count) => count === 1)
    } finally {
      await closeFenceMenu(menu)
    }
  })
  await check('valid Mermaid renders in the outline widget and compiles to a .mermaid-mm host', async () => {
    let widget = await requireMountedWidget('Valid Mermaid')
    await page.waitForTimeout(900)
    widget = await requireMountedWidget('Valid Mermaid')
    const outlineRendered = await widget.locator(':scope > .tw-obj-body svg').count() === 1
    const compiled = await prepareSource(outlinePath, fixture, 'object-doors-fixture', statSync(outlinePath))
    const compilerHost = compiled.fullHtml.includes('class="mermaid-mm"')
    return { pass: outlineRendered && compilerHost, detail: `outlineSvg=${outlineRendered} compilerHost=${compilerHost}` }
  })
  await check('valid SVG renders in the outline widget', async () => {
    let widget = await requireMountedWidget('Valid SVG')
    await page.waitForTimeout(300)
    widget = await requireMountedWidget('Valid SVG')
    return widget.locator(':scope > .tw-obj-body svg').count().then((count) => count === 1)
  })
  await check('hostile SVG shows populated raw source and a visible error in the outline widget', async () => {
    let widget = await requireMountedWidget('Hostile SVG')
    await page.waitForTimeout(300)
    widget = await requireMountedWidget('Hostile SVG')
    return widget.evaluate((node) => ({
      pass: node.classList.contains('tw-obj-failed')
        && Boolean(node.querySelector(':scope > .tw-obj-rawsrc')?.textContent?.trim())
        && Boolean(node.querySelector(':scope > .tw-obj-error')?.textContent?.trim()),
      detail: `failed=${node.classList.contains('tw-obj-failed')}`
    }))
  })
  await check('editing the inserted chart changes only that fence-body line on disk', async () => {
    const before = readFileSync(outlinePath, 'utf8')
    const shell = await openObjectEditor('Chart insertion target', '.oe-chart-outline')
    try {
      const beta = shell.locator('.oe-node input[data-node="1"]')
      await beta.fill('Beta: 72')
      await beta.press('Meta+Enter')
      await shell.waitFor({ state: 'detached', timeout: 3000 })
      await waitForOutlineSaveToSettle()
      const after = readFileSync(outlinePath, 'utf8')
      const insertedId = before.slice(
        before.indexOf('### Chart insertion target'),
        before.indexOf('### Chart edit target')
      ).match(/\{id=([A-Za-z0-9_-]+)\}/)?.[1]
      const chartBefore = `### Chart insertion target\n{id=${insertedId}}\n\n\`\`\`chart=bar\n- Alpha: 40\n- Beta: 25\n- Gamma: 35\n\`\`\``
      const chartAfter = chartBefore.replace('- Beta: 25', '- Beta: 72')
      const expected = before.replace(chartBefore, chartAfter)
      return {
        pass: insertedId !== undefined && after === expected,
        detail: `insertedId=${insertedId ?? 'missing'} expectedLength=${expected.length} actualLength=${after.length}`
      }
    } finally {
      await closeObjectEditor(shell)
    }
  })
  await check('the closed chart widget re-renders with the edited value visible', async () => {
    const shell = await openObjectEditor('Chart rerender target', '.oe-chart-outline')
    try {
      const beta = shell.locator('.oe-node input[data-node="1"]')
      await beta.fill('Beta: 73')
      await beta.press('Meta+Enter')
      await shell.waitFor({ state: 'detached', timeout: 3000 })
      await waitForOutlineSaveToSettle()
    } finally {
      await closeObjectEditor(shell)
    }
    const widget = await requireMountedWidget('Chart rerender target')
    const host = widget.locator(':scope > .tw-obj-body > .chart-cols')
    await host.waitFor({ state: 'visible', timeout: 3000 })
    return host.evaluate((node) => {
      const rect = node.getBoundingClientRect()
      return {
        pass: rect.width > 0
          && rect.height > 0
          && Array.from(node.querySelectorAll('.chart-val'))
            .some((value) => value.textContent?.trim() === '73'),
        detail: `pixels=${Math.round(rect.width)}x${Math.round(rect.height)} text=${node.textContent?.trim()}`
      }
    })
  })
  await check('the three chart forms render one fence widget and flag both compatibility forms inline', async () => {
    const widget = await requireMountedWidget('Gate contradiction')
    const oneFenceWidget = await mountedWidgetCount('Gate contradiction') === 1
      && await widget.locator(':scope > .tw-obj-body > .chart-line').count() === 1
      && await widget.locator(':scope > .tw-obj-body > .chart-pie').count() === 0

    await focusEditorLine('### Gate contradiction')
    const triggerLine = await requireMountedEditorLine('{id=gate-shape} {chart=bar}')
    const blockLine = await requireMountedEditorLine('{piechart}')
    const inlineState = await Promise.all([triggerLine, blockLine].map((line) =>
      line.evaluate((node) => ({
        redLine: node.classList.contains('cm-inline-conflict-line'),
        redToken: Boolean(node.querySelector('.cm-inline-conflict-token')),
        warningPoint: Boolean(node.querySelector('[data-warning-point="true"]'))
      }))
    ))
    const bothInline = inlineState.every(({ redLine, redToken, warningPoint }) =>
      redLine && redToken && warningPoint
    )

    const doctor = page.getByRole('dialog', { name: 'Layout Doctor — Object Doors Fixture' })
    try {
      await page.keyboard.press('Meta+Shift+p')
      await page.locator('.command-menu-input').fill('Layout Doctor')
      await page.locator('.command-menu-item', { hasText: 'Layout Doctor' }).first().click()
      await doctor.waitFor({ state: 'visible', timeout: 3000 })
      const doctorText = await doctor.innerText()
      const visibleConflict = doctorText.includes('Trigger conflict')
        && doctorText.includes('chart=bar')
        && doctorText.includes('piechart')
        && doctorText.includes('chart=line')
        && doctorText.includes('Gate contradiction')
        && doctorText.includes('shadowed by fence')
      await page.keyboard.press('Escape')
      const doctorClosed = await doctor.waitFor({ state: 'hidden', timeout: 3000 })
        .then(() => true)
        .catch(() => false)
      await editor.scrollIntoViewIfNeeded()
      const editorHit = await pointerHit(editor)
      return {
        pass: oneFenceWidget && bothInline && visibleConflict && doctorClosed && editorHit.clear,
        detail: `oneFenceWidget=${oneFenceWidget} inline=${JSON.stringify(inlineState)} visibleConflict=${visibleConflict} doctorClosed=${doctorClosed} editorHit=${JSON.stringify(editorHit)}`
      }
    } finally {
      if (await doctor.isVisible().catch(() => false)) {
        await doctor.getByRole('button', { name: 'Close Layout Doctor' }).click()
        await doctor.waitFor({ state: 'hidden', timeout: 3000 })
      }
    }
  })
  await check('a trigger-line-only chart still renders and edits', async () => {
    let widget = await requireMountedWidget('Compatibility chart')
    const rendered = await widget.locator(':scope > .tw-obj-body > .chart-cols').count() === 1
    const before = readFileSync(outlinePath, 'utf8')
    const shell = await openObjectEditor('Compatibility chart', '.oe-chart-outline')
    try {
      const beta = shell.locator('.oe-node input[data-node="1"]')
      await beta.fill('Beta: 61')
      await beta.press('Meta+Enter')
      await shell.waitFor({ state: 'detached', timeout: 3000 })
      await waitForOutlineSaveToSettle()
      const after = readFileSync(outlinePath, 'utf8')
      const compatibilityBefore = '### Compatibility chart\n{id=compatibility-chart} {chart=bar}\n\n- Alpha: 40\n- Beta: 60'
      const compatibilityAfter = compatibilityBefore.replace('- Beta: 60', '- Beta: 61')
      widget = await requireMountedWidget('Compatibility chart')
      return {
        pass: rendered
          && after === before.replace(compatibilityBefore, compatibilityAfter)
          && await widget.locator(':scope > .tw-obj-body > .chart-cols').count() === 1,
        detail: `rendered=${rendered} byteExact=${after === before.replace(compatibilityBefore, compatibilityAfter)}`
      }
    } finally {
      await closeObjectEditor(shell)
    }
  })
  await check('the inserted block, Gate shape and compatibility chart compile correctly in deck and handout', async () => {
    let insertion = null
    try {
      insertion = await insertDefaultChart('Compile insertion target', 'Deck window chart')
    } finally {
      if (insertion?.shell) await closeObjectEditor(insertion.shell)
    }
    const compileSource = [
      '---',
      'title: Object Doors Compile Fixture',
      'auto_title_slide: false',
      'auto_thanks_slide: false',
      '---',
      '',
      '## Objects',
      '{id=objects}',
      '',
      insertion.slideSource.trimEnd(),
      '',
      '### Gate contradiction',
      '{id=gate-shape} {chart=bar}',
      '',
      '{piechart}',
      '- Alpha: 40',
      '- Beta: 60',
      '',
      '```chart=line',
      '- 2024: 25',
      '- 2025: 75',
      '```',
      '',
      '### Compatibility chart',
      '{id=compatibility-chart} {chart=bar}',
      '',
      '- Alpha: 40',
      '- Beta: 60',
      ''
    ].join('\n')
    const compiled = await prepareSource(
      outlinePath,
      compileSource,
      'object-doors-compile-fixture',
      statSync(outlinePath)
    )
    const handout = buildShareHtml({
      title: compiled.title,
      slides: extractSlides(compiled.fullHtml),
      styles: extractStyles(compiled.fullHtml),
      includeNotes: false,
      slug: 'object-doors-compile-fixture',
      license: null
    })
    const expected = [
      [insertion.id, 'chart-cols'],
      ['gate-shape', 'chart-line'],
      ['compatibility-chart', 'chart-cols']
    ].filter(([id]) => id !== null)
    const results = expected.map(([id, chartClass]) => ({
      id,
      deck: slideMarkup(compiled.fullHtml, id).includes(`class="${chartClass}`),
      handout: slideMarkup(handout, id).includes(`class="${chartClass}`)
    }))
    return {
      pass: insertion.id !== null
        && results.every(({ deck, handout: handoutMatch }) => deck && handoutMatch),
      detail: JSON.stringify(results)
    }
  })
  await check('the compiled deck paints the chart host in a hidden window', async () => {
    const compiled = await prepareSource(
      outlinePath,
      fixture,
      'object-doors-fixture',
      statSync(outlinePath)
    )
    const compiledPath = join(scratch, 'compiled-chart.html')
    writeFileSync(compiledPath, compiled.fullHtml)
    const compiledUrl = pathToFileURL(compiledPath)
    compiledUrl.hash = 'deck-window-chart'
    const compiledHref = compiledUrl.href
    let compiledPage = null
    let compiledWindowId = null
    try {
      const compiledPagePromise = app.waitForEvent('window', { timeout: 3000 })
      const compiledWindowPromise = app.evaluate(async ({ BrowserWindow }, url) => {
        const window = new BrowserWindow({
          show: false,
          width: 1280,
          height: 720,
          webPreferences: {
            sandbox: true,
            backgroundThrottling: false
          }
        })
        globalThis.__twObjectDoorsCompiledWindow = window
        await window.loadURL(url)
        return window.id
      }, compiledHref)
      ;[compiledPage, compiledWindowId] = await Promise.all([
        compiledPagePromise,
        compiledWindowPromise
      ])
      await compiledPage.waitForLoadState('domcontentloaded')
      const host = compiledPage.locator(
        'section.slide[data-id="deck-window-chart"].active .chart-cols'
      )
      await host.waitFor({ state: 'visible', timeout: 5000 })
      const geometry = await host.evaluate((node) => {
        const rect = node.getBoundingClientRect()
        const bars = Array.from(node.querySelectorAll('.chart-bar')).map((bar) => {
          const box = bar.getBoundingClientRect()
          return {
            width: box.width,
            height: box.height,
            bottom: box.bottom
          }
        })
        return {
          width: rect.width,
          height: rect.height,
          bars
        }
      })
      const baseline = Math.max(...geometry.bars.map((bar) => bar.bottom))
      const barsPainted = geometry.bars.length === 3
        && geometry.bars.every((bar) =>
          bar.width > 0
          && bar.height > 0
          && Math.abs(bar.bottom - baseline) < 1.5
        )
      const hidden = await app.evaluate(({ BrowserWindow }, id) => {
        return BrowserWindow.fromId(id)?.isVisible() === false
      }, compiledWindowId)
      return {
        pass: compiled.fullHtml.includes('class="chart-cols')
          && geometry.width > 0
          && geometry.height > 0
          && barsPainted
          && hidden,
        detail: `host=${compiled.fullHtml.includes('class="chart-cols')} pixels=${Math.round(geometry.width)}x${Math.round(geometry.height)} bars=${JSON.stringify(geometry.bars.map(({ width, height }) => ({ width: Math.round(width), height: Math.round(height) })))} hidden=${hidden}`
      }
    } finally {
      if (compiledWindowId !== null) {
        await app.evaluate(({ BrowserWindow }, id) => {
          BrowserWindow.fromId(id)?.close()
          if (globalThis.__twObjectDoorsCompiledWindow?.id === id) {
            delete globalThis.__twObjectDoorsCompiledWindow
          }
        }, compiledWindowId).catch(() => {})
      } else if (compiledPage) {
        await compiledPage.close().catch(() => {})
      }
    }
  })
  await check('a garbled chart list fails visibly over its raw source', async () => {
    const widget = await requireMountedWidget('Garbled chart')
    return widget.evaluate((node) => {
      const raw = node.querySelector(':scope > .tw-obj-rawsrc')
      const error = node.querySelector(':scope > .tw-obj-error')
      return {
        pass: node.classList.contains('tw-obj-failed')
          && raw?.textContent?.includes('| This value is garbled')
          && Boolean(error?.textContent?.trim()),
        detail: `failed=${node.classList.contains('tw-obj-failed')} raw=${JSON.stringify(raw?.textContent)}`
      }
    })
  })
  await check('the brace palette chart chain writes the selected fenced form', async () => {
    const shell = page.locator('.oe')
    try {
      await focusEditorLine('Brace chart insertion point')
      await page.keyboard.type('{cha')
      const entryPopup = page.locator('.cm-tooltip-autocomplete').first()
      await entryPopup.waitFor({ state: 'visible', timeout: 3000 })
      await page.keyboard.press('Enter')
      const optionPopup = page.locator('.cm-tooltip-autocomplete.tw-inline-option-palette').first()
      await optionPopup.waitFor({ state: 'visible', timeout: 3000 })
      const optionsVisible = /Bars/.test(await optionPopup.textContent() ?? '')
      await page.keyboard.press('2')
      await waitForOutlineSaveToSettle()
      await shell.waitFor({ state: 'visible', timeout: 3000 })
      const saved = readFileSync(outlinePath, 'utf8')
      const braceSlide = saved.slice(
        saved.indexOf('### Brace chart target'),
        saved.indexOf('### Paste and fence doors')
      )
      return {
        pass: optionsVisible
          && braceSlide.includes('Brace chart insertion point\n\n```chart=bar\n- Alpha: 40\n- Beta: 25\n- Gamma: 35\n```')
          && braceSlide.includes('{id=brace-chart}')
          && !braceSlide.includes('{chart=bar}'),
        detail: `options=${optionsVisible} trigger=${braceSlide.match(/\{chart[^}]*\}/g)?.join(',')}`
      }
    } finally {
      await closeObjectEditor(shell)
    }
  })
  await check('the Electron windows stay hidden and the editor stays live', async () => {
    const openShells = await page.locator('.oe').count()
    const openSlideMenus = await page.locator('[data-slide-menu]').count()
    const openDoctors = await page.getByRole('dialog', { name: 'Layout Doctor — Object Doors Fixture' }).count()
    const windows = await app.evaluate(({ BrowserWindow }) => {
      return BrowserWindow.getAllWindows().map((window) => ({
        hidden: !window.isVisible(),
        title: window.getTitle(),
        url: window.webContents.getURL()
      }))
    })
    const editorWindow = windows.find((window) =>
      /\/out\/renderer\/index\.html(?:[?#]|$)/.test(window.url)
      || window.title.startsWith('TalkWeaver')
    )
    const allHidden = windows.every((window) => window.hidden)
    const sentinel = `tw-live-${Date.now()}`
    await editor.scrollIntoViewIfNeeded()
    const editorHit = await requirePointerTarget(editor, 'Editor')
    await editor.click()
    await page.keyboard.press('Meta+End')
    await page.keyboard.type(sentinel)
    const typed = (await editor.innerText()).includes(sentinel)
    const raf = await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(true))))
    return {
      pass: Boolean(editorWindow)
        && allHidden
        && openShells === 0
        && openSlideMenus === 0
        && openDoctors === 0
        && editorHit.clear
        && typed
        && raf === true,
      detail: `count=${windows.length} allHidden=${allHidden} editorPresent=${Boolean(editorWindow)} overlays=shell:${openShells},menu:${openSlideMenus},doctor:${openDoctors} editorHit=${JSON.stringify(editorHit)} typed=${typed} raf=${raf}`
    }
  })
} catch (error) {
  const detail = `suite setup failed: ${error instanceof Error ? error.message : String(error)}`
  console.error(detail)
  for (const name of CHECK_NAMES) {
    if (!attempted.has(name)) {
      attempted.add(name)
      record(name, false, detail)
    }
  }
} finally {
  const result = summary('OBJECT DOORS SUMMARY')
  if (app) await app.close()
  rmSync(scratch, { recursive: true, force: true })
  process.exit(result.exitCode)
}
