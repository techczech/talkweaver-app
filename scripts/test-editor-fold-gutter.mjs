// The editor gutter gives each foldable slide heading (or list item) exactly one collapse control and
// leaves image lines without one. The real extensions (slide-number gutter, fold gutter, outline fold
// service, markdown parser with its fold override, image widget with placement chips) are bundled for
// Chromium; fold markers are matched to document lines by position in the rendered DOM.
// SCREENSHOT=<path> saves a picture of the gutter.
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const root = fileURLToPath(new URL('..', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'talk-weaver-fold-gutter-'))
const outfile = join(dir, 'bundle.js')
const entry = `
import { EditorView, keymap } from '@codemirror/view'
import { EditorState, Prec } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { foldGutter, foldable, foldEffect, foldedRanges } from '@codemirror/language'
import { enterFromHeading } from './src/renderer/src/extensions/outliner.ts'
import { buildEditorKeyBindings } from './src/renderer/src/keymap/store.ts'
import { viewModeExtension } from './src/renderer/src/extensions/plainView/index.ts'
import { triggerCompleteExtension } from './src/renderer/src/extensions/triggerComplete.ts'
import { imageWidgetExtension } from './src/renderer/src/extensions/imageWidget.ts'
import { outlineParagraphFolds, outlineFolding, outlineFoldService, revealFoldedLine } from './src/renderer/src/extensions/outlineFold.ts'
import { setSlideNumberLines, slideNumberGutterExtension } from './src/renderer/src/extensions/slideNumberGutter.ts'
// The same extension order as components/Editor.tsx.
window.mountEditor = (doc, slideLines, labels, withEditorKeys = false) => {
  window.__view?.destroy()
  const view = new EditorView({
    parent: document.getElementById('host'),
    state: EditorState.create({
      doc,
      extensions: [
        slideNumberGutterExtension,
        markdown({ base: markdownLanguage, extensions: [outlineParagraphFolds] }),
        outlineFolding,
        foldGutter(),
        outlineFoldService,
        triggerCompleteExtension({
          isMarkdown: () => Boolean(labels),
          onNewHeading: (kind, heading) => { window.pickedSection = { kind, heading } }
        }),
        ...(labels ? [viewModeExtension('markdown'), Prec.highest(keymap.of([{ key: 'Enter', run: enterFromHeading }]))] : []),
        imageWidgetExtension({ vaultRoot: null, talkDir: null, placementForLine: () => ({ kind: 'row', index: 1, count: 2 }) }),
        ...(withEditorKeys ? [keymap.of(buildEditorKeyBindings())] : []),
        EditorView.lineWrapping
      ]
    })
  })
  setSlideNumberLines(view, slideLines, labels && new Map(labels))
  window.__view = view
}
window.foldAt = line => {
  const view = window.__view
  const {from, to} = view.state.doc.line(line)
  const range = foldable(view.state, from, to)
  if (!range) throw new Error('The requested line is not foldable: ' + line)
  const count = view.state.doc.sliceString(range.from, range.to).split('\\n').length - 1
  view.dispatch({ effects: foldEffect.of(range) })
  return { count, folded: foldedRanges(view.state).size }
}
window.foldNavigation = (fromLine, toLine) => {
  const view = window.__view
  const head = view.state.doc.line(fromLine)
  const target = view.state.doc.line(toLine).from
  const range = foldable(view.state, head.from, head.to)
  view.dispatch({ effects: foldEffect.of(range) })
  const before = foldedRanges(view.state).size
  view.dispatch({ effects: revealFoldedLine(view.state, target), selection: { anchor: target } })
  return { before, after: foldedRanges(view.state).size, unchanged: view.state.doc.toString() }
}
// Fold markers by 1-based document line: the gutter element whose top is the line block's top.
window.foldMarkerLines = () => {
  const view = window.__view
  const marks = [...document.querySelectorAll('.cm-foldGutter .cm-gutterElement')].filter((el) => el.textContent.trim() !== '')
  const out = []
  for (const el of marks) {
    const top = el.getBoundingClientRect().top
    for (let n = 1; n <= view.state.doc.lines; n += 1) {
      const block = view.lineBlockAt(view.state.doc.line(n).from)
      if (Math.abs(block.top + view.documentTop - top) < 3) { out.push(n); break }
    }
  }
  return out
}
`
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAMgAAABkCAIAAABM5OhcAAAAFklEQVR4nO3BAQEAAACCIP+vbkhAAQAAAO8GECAAAZf3V9cAAAAASUVORK5CYII='
const outline = `# Talk

## Part

### Full
![full](${PNG})

### Row
![r1](${PNG})
![r2](${PNG})

### Grid
{image-grid}
![g1](${PNG})
![g2](${PNG})

### Beside
![beside](${PNG})

Some words beside the picture
and a second line of prose.

### Indented
  ![i1](${PNG})
   ![i2](${PNG})

### Thumbs
- one
  - nested
- two
![t1](${PNG})

### ID above prose
{id=stamped}
This body starts in the same paragraph.

### Empty
`
const theme = readFileSync(join(root, 'src/renderer/src/app-theme.css'), 'utf8')
const styles = readFileSync(join(root, 'src/renderer/src/styles.css'), 'utf8')
const foldStyles = styles.slice(styles.indexOf('.cm-editor .cm-foldPlaceholder.tw-fold-placeholder {'), styles.indexOf('.cm-trigger-echo'))
const lines = outline.split('\n')
const lineOf = (text) => lines.findIndex((l) => l.startsWith(text)) + 1
const headings = lines.map((l, i) => (/^#{1,6}\s/.test(l) ? i + 1 : 0)).filter(Boolean)
let browser
try {
  await build({ stdin: { contents: entry, resolveDir: root, sourcefile: 'fold-gutter-entry.ts' }, bundle: true, format: 'iife', platform: 'browser', outfile })
  browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1440, height: 1400 } })
  await page.setContent('<!doctype html><body style="margin:0;background:var(--panel)"><div id="host" style="width:880px"></div></body>')
  await page.addStyleTag({ content: theme + foldStyles })
  await page.addScriptTag({ content: readFileSync(outfile, 'utf8') })
  await page.evaluate(([d, h]) => window.mountEditor(d, h), [outline, headings])
  await page.waitForSelector('.cm-foldGutter .cm-gutterElement', { state: 'attached' })
  await page.waitForTimeout(300)
  const marked = await page.evaluate(() => window.foldMarkerLines())
  if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT, clip: { x: 0, y: 0, width: 520, height: 900 } })

  assert.equal(await page.locator('.cm-foldGutter').count(), 1, 'one fold gutter column')
  assert.equal(new Set(marked).size, marked.length, `no line carries two fold markers (${marked})`)
  // Every heading with content below it has exactly one collapse control; the empty one has none.
  for (const text of ['# Talk', '## Part', '### Full', '### Row', '### Grid', '### Beside', '### Indented', '### Thumbs']) {
    assert.equal(marked.filter((n) => n === lineOf(text)).length, 1, `${text} has one collapse control`)
  }
  // Image lines, and the trigger line sitting over them, have none.
  for (let n = 1; n <= lines.length; n += 1) {
    if (/^\s*!\[/.test(lines[n - 1]) || lines[n - 1] === '{image-grid}') assert.ok(!marked.includes(n), `line ${n} (${lines[n - 1].slice(0, 12)}) has no collapse control`)
  }
  // Prose and list folds are unchanged: a two-line paragraph and a list item with children still fold.
  assert.ok(marked.includes(lineOf('Some words')), 'a prose paragraph keeps markdown\'s fold')
  assert.ok(marked.includes(lineOf('- one')), 'a list item with children keeps its fold')
  // Nothing else: every marker sits on a heading, the prose paragraph or a list item.
  assert.ok(!marked.includes(lineOf('{id=stamped}')), 'an ID line has no redundant fold')
  const allowed = new Set([...headings, lineOf('Some words'), lineOf('- one'), lineOf('  - nested'), lineOf('- two')])
  assert.deepEqual(marked.filter((n) => !allowed.has(n)), [], 'no collapse control on any other line')
  const source = [
    '## Section {id=a}', '', '### Subsection {id=b}', '{sub}', '',
    '#### Slide {id=c}', '', '~~~markdown', '## Example', '~~~', '',
    '<!--', '## Hidden', '-->', '', '## Next {id=d}', '- Follow'
  ].join('\n')
  await page.evaluate(text => window.mountEditor(text, [1, 3, 6, 16], [
    [1, { kind: 'Section', sectionNumber: '1' }], [3, { kind: 'Subsection', sectionNumber: '1.1' }],
    [6, { kind: 'Slide' }], [16, { kind: 'Section', sectionNumber: '2' }]
  ]), source)
  const labels = await page.locator('.cm-md-heading-marker').evaluateAll(nodes => nodes.map(node => node.title))
  assert.ok(labels.includes('Section §1') && labels.includes('Subsection §1.1') && labels.includes('Slide 3'))
  const folded = await page.evaluate(() => window.foldAt(6))
  assert.equal(folded.folded, 1)
  assert.ok(folded.count > 1)
  const placeholder = page.locator('.tw-fold-placeholder')
  assert.equal(await placeholder.getAttribute('aria-label'), 'Show ' + folded.count + ' hidden lines')
  assert.equal(await placeholder.innerText(), folded.count + ' lines hidden')
  await placeholder.click()
  await placeholder.waitFor({ state: 'detached' })
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value }, theme)
    const size = kind => page.locator('.cm-line.cm-md-' + kind).first().evaluate(line => parseFloat(getComputedStyle(line).fontSize))
    assert.ok(await size('section') > await size('subsection'))
    assert.ok(await size('subsection') - await size('slide') >= 1.9, 'subsections are visibly larger than slide headings')
    await page.evaluate(() => window.foldAt(6))
    const colors = await placeholder.evaluate(button => ({
      fill: getComputedStyle(button).backgroundColor,
      text: getComputedStyle(button).color,
      fontSize: parseFloat(getComputedStyle(button).fontSize)
    }))
    assert.notEqual(colors.fill, colors.text)
    assert.ok(colors.fontSize >= 12, 'the folded-line chip uses at least 12px text')
    if (process.env.TW_POLISH_LOOK) {
      const shot = await page.screenshot({ type: 'jpeg', quality: 75, clip: { x: 0, y: 0, width: 680, height: 250 } })
      console.log('POLISH_LOOK editor-' + theme + ' ' + shot.toString('base64'))
    }
    await placeholder.click()
  }
  const gutter = page.locator('.cm-lineNumbers')
  const desktopWidth = (await gutter.boundingBox()).width
  const revealed = await page.evaluate(() => window.foldNavigation(1, 6))
  assert.deepEqual(revealed, { before: 1, after: 0, unchanged: source }, 'a jump reveals a folded descendant without editing source')
  assert.equal((await gutter.boundingBox()).width, desktopWidth, 'fold and reveal preserve the heading gutter width')
  await page.setViewportSize({ width: 1000, height: 631 })
  assert.ok((await gutter.boundingBox()).width < desktopWidth, 'the narrow window uses compact heading marks')
  assert.equal(await page.locator('.cm-md-heading-marker[title="Subsection §1.1"] .cm-md-heading-name').first().isVisible(), false)
  await page.setViewportSize({ width: 1440, height: 1400 })
  assert.ok(!(await page.evaluate(() => window.foldMarkerLines())).includes(9), 'a heading inside a fence has no slide fold')
  for (const [prefix, kind, accept] of [['## ', 'section', 'Enter'], ['### ', 'slide', 'Tab'], ['### ', 'subsection', 'click']]) {
    const fixture = '## Part {id=part}\n\n### Slide {id=slide}\n\n'
    await page.evaluate(text => {
      window.mountEditor(text, [1, 3], [[1, { kind: 'Section' }], [3, { kind: 'Slide' }]])
      window.pickedSection = null
      const view = window.__view
      view.dispatch({ selection: { anchor: view.state.doc.length } })
      view.focus()
    }, fixture)
    await page.keyboard.type(prefix)
    const option = page.getByRole('option', { name: 'New ' + kind })
    await option.waitFor()
    if (accept === 'click') await option.click()
    else {
      // The section menu still uses CodeMirror's standard acceptance delay.
      if (accept === 'Enter') await page.waitForTimeout(100)
      await page.keyboard.press(accept)
    }
    assert.deepEqual(await page.evaluate(() => window.pickedSection), {
      kind, heading: { from: fixture.length, text: prefix }
    })
  }
  const headingFixture = '## Part {id=part}\n\n### An existing slide {id=slide}\n\n'
  await page.evaluate(text => {
    window.mountEditor(text, [], [])
    const view = window.__view
    view.dispatch({ selection: { anchor: view.state.doc.length } })
    view.focus()
  }, headingFixture)
  await page.keyboard.type('### ')
  const slideOption = page.getByRole('option', { name: 'New slide', exact: true })
  const subsectionOption = page.getByRole('option', { name: 'New subsection', exact: true })
  await subsectionOption.waitFor()
  await slideOption.waitFor()
  assert.equal(await slideOption.getAttribute('aria-selected'), 'true', 'New slide is offered first')
  await page.keyboard.press('ArrowDown')
  assert.equal(await subsectionOption.getAttribute('aria-selected'), 'true')
  await page.keyboard.press('Enter')
  assert.deepEqual(await page.evaluate(() => window.pickedSection), {
    kind: 'subsection', heading: { from: headingFixture.length, text: '### ' }
  })
  for (const prefix of ['#', '##', '###', '####']) {
    const title = prefix + ' Current'
    const next = prefix + ' Next'
    for (const typed of [false, true]) {
      const trigger = typed ? '' : '\n{id=current}'
      const text = (typed ? '' : title + trigger) + '\n' + next + '\n{id=next}\n'
      await page.evaluate(({ text, typed }) => {
        window.mountEditor(text, [], [])
        const view = window.__view
        view.dispatch({ selection: { anchor: typed ? 0 : view.state.doc.line(1).to } })
        view.focus()
      }, { text, typed })
      if (typed) await page.keyboard.type(title)
      await page.keyboard.press('Enter')
      await page.keyboard.type('Body')
      assert.equal(await page.evaluate(() => window.__view.state.doc.toString()),
        title + trigger + '\nBody\n' + next + '\n{id=next}\n', prefix + ' Enter opens a body line and preserves the following heading')
    }
  }
  const tabSource = '## Section\n\n```py\n# comment\n```\n'
  await page.evaluate(text => window.mountEditor(text, [], [], true), tabSource)
  const tabAt = async (n, offsetFromEnd = 0) => {
    await page.evaluate(({ line, offsetFromEnd }) => {
      const view = window.__view
      view.dispatch({ selection: { anchor: view.state.doc.line(line).to - offsetFromEnd } })
      view.focus()
    }, { line: n, offsetFromEnd })
    await page.keyboard.press('Tab')
    return page.evaluate(() => window.__view.state.doc.toString())
  }
  assert.equal(await tabAt(1), tabSource, 'Tab at a heading end preserves its bytes')
  assert.equal(await tabAt(1, 4), tabSource, 'Tab inside a heading preserves its bytes')
  assert.equal(await tabAt(4), tabSource.replace('# comment', '# comment  '), 'Tab still types an indent inside a code fence')
  const promoteSource = '# Talk\n\n## Section {id=section}\n\n### Slide {id=slide}\n\n- Point\n'
  await page.evaluate(text => {
    window.mountEditor(text, [3, 5], [], true)
    window.addEventListener('tw-toast', event => { window.promoteNotice = event.detail.message })
  }, promoteSource)
  for (const line of [5, 3, 1]) {
    await page.evaluate(n => {
      const view = window.__view
      view.dispatch({ selection: { anchor: view.state.doc.line(n).to } })
      view.focus()
      window.promoteNotice = undefined
    }, line)
    await page.keyboard.press('ControlOrMeta+Shift+ArrowLeft')
    const { text, notice } = await page.evaluate(() => ({
      text: window.__view.state.doc.toString(), notice: window.promoteNotice
    }))
    if (line === 5) {
      assert.equal(text, promoteSource.replace('### Slide', '## Slide'), 'the real shortcut can still promote a slide')
      await page.evaluate(text => window.mountEditor(text, [3, 5], [], true), promoteSource)
    } else {
      assert.equal(text, promoteSource, 'the real shortcut preserves the title and top-level sections')
      assert.equal(notice, 'Sections are the top level')
    }
  }
  console.log(`editor fold gutter: ok (${marked.length} markers: lines ${marked.join(', ')})`)
} finally {
  await browser?.close()
  rmSync(dir, { recursive: true, force: true })
}
