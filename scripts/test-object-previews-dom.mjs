import { strict as assert } from 'node:assert'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openEditorHarness } from './editor-dom-harness.mjs'

const source = [
  '## Objects',
  '',
  'Intro.',
  '',
  '```chat',
  'user: Show me the quarterly results.',
  'bot: Revenue was up 12%.',
  '```',
  '',
  '## Terminal',
  '',
  '```terminal',
  '$ ls',
  'report.md',
  '```',
  '',
  '## Widget',
  '',
  '[Embed: assets/widget.html]',
  '',
  '## Numbers',
  '',
  '| Quarter | Revenue |',
  '|---------|--------:|',
  '| Q1      |      15 |',
  '',
  '```barchart',
  '- January: 8',
  '- February: 12',
  '```'
].join('\n')

const fixtureHtml = '<!doctype html><style>h2{color:rgb(21, 96, 84)}p{background-image:url(https://example.invalid/style.png)}</style><h2>Quarterly report</h2>'
  + '<p>A local HTML widget.</p><script>document.body.dataset.ran="true"</script>'
  + '<a href="https://example.invalid/leave">Details</a><img src="https://example.invalid/image.png">'

const diagramCases = [
  {
    kind: 'svg',
    body: '```svg\n<svg viewBox="0 0 100 100"><rect width="40" height="20" /></svg>\n```',
    child: 'svg[viewBox="0 0 100 100"] rect[width="40"][height="20"]'
  },
  {
    kind: 'mermaid',
    body: '```mermaid\ngraph LR\n  A[Draft] --> B[Publish]\n```',
    child: 'svg text',
    label: 'Publish'
  },
  {
    kind: 'mindmap',
    body: '{mindmap}\n- Research\n  - Interview',
    child: 'svg .markmap-node',
    label: 'Interview'
  }
]

const shots = process.argv[2]
if (shots) mkdirSync(shots, { recursive: true })
const h = await openEditorHarness({ appCsp: true })
try {
  const remote = []
  // Chromium reports requests blocked by CSP to DevTools too. Intercept at the network boundary.
  await h.page.route('https://example.invalid/**', async (route) => {
    remote.push(route.request().url())
    await route.abort()
  })
  await h.page.evaluate((html) => { window.previewPages['assets/widget.html'] = html }, fixtureHtml)
  for (const mode of ['plain', 'markdown']) {
    await h.mount(source.replace('## Objects\n', '## Objects\n|'), mode)
    const theme = mode === 'plain' ? 'light' : 'dark'
    await h.page.evaluate((theme) => { document.documentElement.dataset.theme = theme }, theme)
    const chat = h.page.locator('.tw-obj-preview-chat')
    await chat.waitFor({ timeout: 5000 })
    assert.match(await chat.textContent(), /Show me the quarterly results/)
    assert.match(await chat.textContent(), /Revenue was up 12%/)
    const terminal = h.page.locator('.tw-obj-preview-terminal')
    await terminal.waitFor({ timeout: 5000 })
    assert.match(await terminal.textContent(), /\$ ls[\s\S]*report\.md/)

    const frame = h.page.locator('iframe.tw-obj-preview-page')
    await frame.waitFor({ timeout: 5000 })
    assert.equal(await frame.getAttribute('sandbox'), '')
    const document = frame.contentFrame()
    assert.equal(await document.locator('h2').textContent(), 'Quarterly report')
    assert.equal(await document.locator('h2').evaluate((node) => getComputedStyle(node).color), 'rgb(21, 96, 84)')
    assert.equal(await document.locator('script').count(), 0)
    assert.equal(await document.locator('a').getAttribute('href'), null)
    assert.equal(await document.locator('img').getAttribute('src'), null)
    assert.deepEqual(remote, [])
    assert.equal(await h.page.locator('.tw-obj-table').locator('td').first().textContent(), 'Q1')
    assert.equal(await h.page.locator('.tw-obj-chart .chart-bar').count(), 2)

    if (shots) await h.page.locator('.cm-editor').screenshot({ path: join(shots, `${mode}-${theme}.png`) })

    const card = h.page.locator('[data-object-block="chat"]')
    await card.getByRole('button', { name: 'Show the source' }).click()
    assert.match(await card.locator('.tw-obj-rawsrc').textContent(), /\`\`\`chat/)
    assert.equal(await chat.count(), 0)
    await card.getByRole('button', { name: 'Hide the source' }).click()
    await chat.waitFor({ timeout: 5000 })
    assert.deepEqual(await h.page.evaluate(() => [window.view().state.doc.toString(), window.depth(), window.writes]), [source, 0, []])
    const pageCard = h.page.locator('[data-object-block="embed"]')
    await h.page.evaluate(() => {
      window.heldPreview = window.document.querySelector('iframe.tw-obj-preview-page')
      window.entry.insertAt(window.view().state.doc.toString().indexOf('Intro.'), 'A short ', 'input.test')
    })
    assert.equal(await frame.evaluate((node) => node === window.heldPreview), true, 'reuse the iframe when earlier text moves the card')
    await pageCard.getByRole('button', { name: 'Show the source' }).click()
    assert.match(await pageCard.locator('.tw-obj-rawsrc').textContent(), /assets\/widget\.html/)
    await h.page.evaluate(() => window.undoOnce())
    assert.equal(await h.page.evaluate(() => window.view().state.doc.toString()), source)

    for (const { kind, body, child, label } of diagramCases) {
      const outline = `## Diagram\n\n${body}\n`
      await h.mount(outline.replace('## Diagram\n', '## Diagram\n|'), mode)
      const rendered = h.page.locator(`[data-object-block="${kind}"] .tw-obj-body ${child}`)
      const diagram = label ? rendered.filter({ hasText: label }) : rendered
      await diagram.first().waitFor({ state: 'visible', timeout: 10000 })
      assert.deepEqual(await h.page.evaluate(() => [window.view().state.doc.toString(), window.depth(), window.writes]), [outline, 0, []])
    }
  }

  const big = '## Start\n|' + '\nOrdinary text.\n'.repeat(200)
    + Array.from({ length: 300 }, (_, i) => `\n## Slide ${i}\n\n[Embed: assets/slide-${i}.html]\n`).join('')
  await h.page.evaluate(() => { window.previewReads = [] })
  await h.mount(big, 'plain')
  assert.equal(await h.page.locator('iframe.tw-obj-preview-page').count(), 0)
  assert.deepEqual(await h.page.evaluate(() => window.previewReads), [], 'opening a talk does not read offscreen pages')
  assert.deepEqual(h.errors, [])
  console.log('PASS object previews in Outline and Markdown, including charts, tables, SVG, Mermaid and mindmaps, source and Undo preserved, local HTML isolated and offscreen pages deferred')
} finally {
  await h.close()
}
