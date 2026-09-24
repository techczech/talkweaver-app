import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import DOMPurify from 'dompurify'
import { JSDOM } from 'jsdom'
import { installTestDom } from './test-dom.mjs'

const widgets = await import(
  new URL('../src/renderer/src/extensions/objectBlocks/widgets.ts', import.meta.url)
)
const { renderChartBlock } = await import(
  new URL('../compiler/scripts/lib/06-chart-renderer.mjs', import.meta.url)
)
const { LAYOUTS } = await import(
  new URL('../src/shared/layout-registry/entries.ts', import.meta.url)
)
const mermaidRenderer = await import(
  new URL('../src/renderer/src/objects/mermaid-render.ts', import.meta.url)
)
const markmapEditor = await import(
  new URL('../src/renderer/src/objects/markmap-editor.ts', import.meta.url)
)
const mermaidEditor = await import(
  new URL('../src/renderer/src/objects/mermaid-editor.ts', import.meta.url)
)
const svgEditor = await import(
  new URL('../src/renderer/src/objects/svg-editor.ts', import.meta.url)
)
const svgSafety = await import(
  new URL('../src/shared/objects/sanitise-svg.ts', import.meta.url)
)
const objectRegistry = await import(
  new URL('../src/renderer/src/objects/registry.ts', import.meta.url)
)

let failures = 0
async function check(name, run) {
  try {
    await run()
    console.log(`PASS  ${name}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL  ${name} — ${error instanceof Error ? error.message : String(error)}`)
  }
}

await check('async widget height cache is bounded', () => {
  assert.equal(typeof widgets.BoundedHeightCache, 'function', 'BoundedHeightCache is not implemented')
  const cache = new widgets.BoundedHeightCache(2)
  cache.set('a', 100)
  cache.set('b', 110)
  cache.set('c', 120)
  assert.equal(cache.size, 2)
  assert.equal(cache.get('a'), undefined, 'the oldest height is evicted')
  assert.equal(cache.get('c'), 120)
})

await check('trigger-table cells strip lexer icon tokens', () => {
  assert.equal(typeof widgets.triggerTable, 'function', 'triggerTable is not exported for its pure model test')
  const model = widgets.triggerTable([
    '- Role {icon=lucide:brain}',
    '  - Oracle {brain}',
    '- Literal {a, b}',
    '  - Kept'
  ].join('\n'))
  assert.deepEqual(model.cells, [
    ['Role', 'Literal {a, b}'],
    ['Oracle', 'Kept']
  ])
})

await check('empty fenced objects return neutral ready-to-type prompts', () => {
  assert.equal(typeof widgets.emptyObjectPrompt, 'function', 'emptyObjectPrompt is not implemented')
  assert.match(widgets.emptyObjectPrompt('mermaid', ''), /mermaid/i)
  assert.match(widgets.emptyObjectPrompt('svg', ' \n '), /svg/i)
  assert.equal(widgets.emptyObjectPrompt('svg', '<svg/>'), null)
})

await check('mermaid SVG boundary preflight rejects hostile elements and attributes', () => {
  assert.equal(
    typeof svgSafety.renderedSvgPreflightError,
    'function',
    'renderedSvgPreflightError is not implemented'
  )
  for (const [source, reason] of [
    [
      '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><img src="#local" onerror="alert(1)"/></foreignObject></svg>',
      'an event-handler inside foreignObject must be rejected before DOMPurify'
    ],
    [
      '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><img src="https://evil.example/x"/></foreignObject></svg>',
      'an external source inside foreignObject must be rejected before DOMPurify'
    ],
    [
      '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><script>alert(1)</script></foreignObject></svg>',
      'a script inside foreignObject must be rejected before DOMPurify'
    ]
  ]) {
    assert.notEqual(svgSafety.renderedSvgPreflightError(source), null, reason)
  }
  assert.equal(
    svgSafety.renderedSvgPreflightError(
      '<svg xmlns="http://www.w3.org/2000/svg"><style>.node{fill:#fff}</style><g class="node"/></svg>'
    ),
    null,
    'ordinary generated Mermaid SVG styling remains permitted'
  )
})

await check('rendered SVG admits benign foreignObject and rechecks DOMPurify output', () => {
  const originalParser = globalThis.DOMParser
  const originalSanitise = DOMPurify.sanitize
  const originalRemoved = DOMPurify.removed
  const benign = '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject width="120" height="30"><div xmlns="http://www.w3.org/1999/xhtml">Safe label</div></foreignObject></svg>'
  globalThis.DOMParser = class {
    parseFromString() {
      return {
        querySelector: () => null,
        documentElement: { localName: 'svg' }
      }
    }
  }
  try {
    DOMPurify.sanitize = (source, config) => {
      DOMPurify.removed = []
      assert.deepEqual(
        config?.ADD_TAGS,
        ['foreignobject'],
        'the rendered-SVG DOMPurify boundary must admit Mermaid foreignObject output'
      )
      return source
    }
    assert.deepEqual(svgSafety.sanitiseRenderedSvg(benign), { svg: benign })

    for (const [sanitised, error] of [
      [
        '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><img src="#local" onerror="alert(1)"/></foreignObject></svg>',
        /unsafe event/
      ],
      [
        '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><img src="https://evil.example/x"/></foreignObject></svg>',
        /stay inside/
      ],
      [
        '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><script>alert(1)</script></foreignObject></svg>',
        /unsafe element/
      ]
    ]) {
      DOMPurify.sanitize = () => {
        DOMPurify.removed = []
        return sanitised
      }
      const result = svgSafety.sanitiseRenderedSvg(benign)
      assert.equal('error' in result, true, 'hostile DOMPurify output must fail closed')
      assert.match(result.error, error)
    }
  } finally {
    globalThis.DOMParser = originalParser
    DOMPurify.sanitize = originalSanitise
    DOMPurify.removed = originalRemoved
  }
})

await check('mermaid renders labels as SVG text instead of HTML-in-SVG', () => {
  assert.equal(mermaidRenderer.MERMAID_CONFIG.htmlLabels, false)
  assert.deepEqual(mermaidRenderer.MERMAID_CONFIG.flowchart, { htmlLabels: false })
  assert.equal('class' in mermaidRenderer.MERMAID_CONFIG, false)
})

await check('rendered SVG fails visibly when the sanitiser removes an element', () => {
  const originalParser = globalThis.DOMParser
  const originalSanitise = DOMPurify.sanitize
  const originalRemoved = DOMPurify.removed
  const clean = '<svg xmlns="http://www.w3.org/2000/svg"><text>Visible label</text></svg>'
  globalThis.DOMParser = class {
    parseFromString() {
      return {
        querySelector: () => null,
        documentElement: { localName: 'svg' }
      }
    }
  }
  DOMPurify.sanitize = (source) => String(source).replace('<text>Visible label</text>', '')
  DOMPurify.removed = [{ element: { nodeName: 'foreignObject' } }]
  try {
    assert.deepEqual(
      svgSafety.sanitiseRenderedSvg(clean),
      { error: 'Unsafe SVG content was removed. Edit the source before it can be previewed.' }
    )
    DOMPurify.sanitize = (source) => source
    DOMPurify.removed = [{ element: { nodeName: 'BODY' } }]
    assert.deepEqual(svgSafety.sanitiseRenderedSvg(clean), { svg: clean })
  } finally {
    globalThis.DOMParser = originalParser
    DOMPurify.sanitize = originalSanitise
    DOMPurify.removed = originalRemoved
  }
})

const widgetsSource = readFileSync(
  new URL('../src/renderer/src/extensions/objectBlocks/widgets.ts', import.meta.url),
  'utf8'
)
await check('widgets do not import their owning StateField module', () => {
  assert.equal(
    /from\s+['"]\.\/field(?:\.ts)?['"]/.test(widgetsSource),
    false,
    'widgets.ts still imports field.ts and keeps the field ↔ widgets cycle'
  )
})

await check('widgets derive the markmap root type from the direct markmap-lib dependency', () => {
  assert.equal(
    /from\s+['"]markmap-common['"]/.test(widgetsSource),
    false,
    'widgets.ts imports undeclared markmap-common instead of deriving transform() root'
  )
  assert.match(
    widgetsSource,
    /ReturnType<Transformer\[['"]transform['"]\]>\[['"]root['"]\]/,
    'widgets.ts does not derive the markmap root type from Transformer.transform()'
  )
})

await check('markmap transformation disables raw HTML', async () => {
  assert.equal(
    typeof widgets.transformMindmapSource,
    'function',
    'transformMindmapSource is not implemented'
  )
  const root = await widgets.transformMindmapSource('- <img src=x onerror=alert(1)>')
  const content = []
  const walk = (node) => {
    content.push(String(node?.content ?? ''))
    for (const child of node?.children ?? []) walk(child)
  }
  walk(root)
  assert.equal(content.some((value) => /<img\b/i.test(value)), false)
  assert.equal(content.some((value) => /&lt;img\b/i.test(value)), true)
})

await check('editing previews enforce hostile-content boundaries behaviourally', async () => {
  assert.equal(typeof markmapEditor.transformEditorMindmap, 'function')
  const root = await markmapEditor.transformEditorMindmap('- <img src=x onerror=alert(1)>')
  const content = []
  const walk = (node) => {
    content.push(String(node?.content ?? ''))
    for (const child of node?.children ?? []) walk(child)
  }
  walk(root)
  assert.equal(content.some((value) => /<img\b/i.test(value)), false)
  assert.equal(content.some((value) => /&lt;img\b/i.test(value)), true)

  assert.equal(typeof mermaidEditor.sanitiseMermaidPreview, 'function')
  assert.match(
    mermaidEditor.sanitiseMermaidPreview(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
    ).error,
    /unsafe element/
  )

  assert.equal(typeof svgEditor.sanitiseSvgPreview, 'function')
  assert.match(
    svgEditor.sanitiseSvgPreview(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
    ).error,
    /not allowed/
  )
})

await check('unknown object kinds fall back to visible raw markup without throwing', () => {
  const dom = installTestDom()
  const originalError = console.error
  const errors = []
  console.error = (...args) => { errors.push(args.map(String).join(' ')) }
  try {
    const block = {
      kind: 'future-object-kind',
      from: 0,
      to: 19,
      source: '{future-object-kind}',
    }
    let widget
    assert.doesNotThrow(() => {
      widget = widgets.widgetForObjectBlock(block, false, false)
    })
    assert.equal(
      widget instanceof widgets.RawMarkupWidget,
      true,
      'unknown dispatch returns the raw-markup fallback widget'
    )
    const shell = widget.toDOM({ dispatch() {}, focus() {} })
    assert.equal(
      shell.querySelector('.tw-obj-rawsrc')?.textContent,
      block.source,
      'the fallback keeps the exact source visible in the outline'
    )
    assert.equal(
      shell.querySelector('.tw-obj-raw'),
      null,
      'the fallback does not render an inert raw toggle'
    )
    assert.equal(
      errors.some((message) => message.includes('future-object-kind')),
      true,
      'unknown dispatch reports the missing registry widget to the console'
    )
  } finally {
    console.error = originalError
    dom.restore()
  }
})

await check('unknown editor dispatch mounts raw markup without touching document bytes', () => {
  const dom = installTestDom()
  const mindmap = LAYOUTS.find((entry) => entry.name === 'mindmap')
  const originalEditor = mindmap.object.editor
  const originalError = console.error
  const errors = []
  let commits = 0
  console.error = (...args) => { errors.push(args.map(String).join(' ')) }
  try {
    mindmap.object.editor = 'future-editor'
    const source = '- Root\n  - Child'
    const block = {
      kind: 'mindmap',
      from: 0,
      to: source.length,
      source,
    }
    const shell = objectRegistry.mountObjectEditor(block, {
      preflight: () => ({ ok: true }),
      commit: () => {
        commits += 1
        return { ok: true }
      },
    })
    assert(shell, 'unknown editor dispatch mounts a fallback shell instead of a blank box')
    assert.equal(
      shell.querySelector('.oe-markup')?.value,
      source,
      'the fallback shell exposes the exact object markup'
    )
    assert.equal(commits, 0, 'mounting the fallback never writes document bytes')
    assert.equal(block.source, source, 'the source object remains byte-identical after mounting')
    assert.equal(
      errors.some((message) => message.includes('future-editor')),
      true,
      'unknown editor dispatch reports the missing registry editor'
    )
  } finally {
    mindmap.object.editor = originalEditor
    console.error = originalError
    dom.restore()
  }
})

await check('widget dispatch follows the registry and the parked zoom control is absent', () => {
  const dom = installTestDom()
  const mindmap = LAYOUTS.find((entry) => entry.name === 'mindmap')
  const originalWidget = mindmap.object.widget
  try {
    mindmap.object.widget = 'svg'
    const widget = widgets.widgetForObjectBlock(
      {
        kind: 'mindmap',
        from: 0,
        to: 7,
        source: '- Root\n',
      },
      false,
      true,
      () => {},
    )
    assert.equal(
      widget instanceof widgets.SvgWidget,
      true,
      'the registry widget declaration selects the rendered widget'
    )
    const shell = widget.toDOM({ dispatch() {}, focus() {} })
    assert.equal(
      shell.querySelector('.tw-obj-zoom'),
      null,
      'the parked fidelity-zoom affordance is absent even when an onZoom callback exists'
    )
  } finally {
    mindmap.object.widget = originalWidget
    dom.restore()
  }
})

await check('chart widgets render every trigger-owned shape inside the locked shell', () => {
  const dom = installTestDom()
  try {
    for (const [kind, triggerToken, chartClass, shape] of [
      ['chart', 'chart=bar', 'chart-cols', 'bar'],
      ['chart', 'chart=pie', 'chart-pie', 'pie'],
      ['linechart', 'linechart', 'chart-line', 'line'],
    ]) {
      const source = '- Alpha: 40\n- Beta: 25\n- Gamma: 35'
      const widget = widgets.widgetForObjectBlock(
        { kind, triggerToken, from: 0, to: source.length, source },
        false,
        false,
      )
      assert.equal(widget instanceof widgets.ChartWidget, true)
      const shell = widget.toDOM({ dispatch() {}, focus() {} })
      assert.equal(shell.querySelector('.tw-obj-kind')?.textContent, 'chart')
      assert.match(shell.querySelector('.tw-obj-step')?.textContent ?? '', new RegExp(`^${shape}\\b`))
      assert.match(shell.querySelector('.tw-obj-body')?.innerHTML ?? '', new RegExp(`class="${chartClass}`))
    }
  } finally {
    dom.restore()
  }
})

await check('fenced chart widgets render the body and keep invalid source visible', () => {
  const dom = installTestDom()
  try {
    const source = '```chart=pie\n- Alpha: 40\n- Beta: 60\n```\n'
    const bodyFrom = source.indexOf('\n') + 1
    const bodyTo = source.lastIndexOf('\n```')
    const rendered = widgets.widgetForObjectBlock(
      {
        kind: 'chart',
        triggerToken: 'chart=pie',
        from: 0,
        to: source.length,
        source,
        bodyFrom,
        bodyTo,
      },
      false,
      false,
    ).toDOM({ dispatch() {}, focus() {} })
    assert.match(rendered.querySelector('.tw-obj-body')?.innerHTML ?? '', /class="chart-pie/)

    const invalidSource = '```chart=bar\n- Alpha: 40\n| Beta: 60\n```\n'
    const invalid = widgets.widgetForObjectBlock(
      {
        kind: 'chart',
        triggerToken: 'chart=bar',
        from: 0,
        to: invalidSource.length,
        source: invalidSource,
        bodyFrom: invalidSource.indexOf('\n') + 1,
        bodyTo: invalidSource.lastIndexOf('\n```'),
      },
      false,
      false,
    ).toDOM({ dispatch() {}, focus() {} })
    assert.equal(invalid.classList.contains('tw-obj-failed'), true)
    assert.equal(invalid.querySelector('.tw-obj-rawsrc')?.textContent, invalidSource)
    assert.match(invalid.querySelector('.tw-obj-error')?.textContent ?? '', /list item/i)
  } finally {
    dom.restore()
  }
})

await check('chart widgets expose raw errors and a ready-to-type empty state', () => {
  const dom = installTestDom()
  try {
    const invalidSource = '- Alpha: 40\nthis is not a list item'
    const invalid = widgets.widgetForObjectBlock(
      {
        kind: 'chart',
        triggerToken: 'chart=bar',
        from: 0,
        to: invalidSource.length,
        source: invalidSource,
      },
      false,
      false,
    ).toDOM({ dispatch() {}, focus() {} })
    assert.equal(invalid.classList.contains('tw-obj-failed'), true)
    assert.equal(invalid.querySelector('.tw-obj-rawsrc')?.textContent, invalidSource)
    assert.match(invalid.querySelector('.tw-obj-error')?.textContent ?? '', /list item/i)

    const empty = widgets.widgetForObjectBlock(
      { kind: 'chart', triggerToken: 'chart=bar', from: 0, to: 0, source: '' },
      false,
      false,
    ).toDOM({ dispatch() {}, focus() {} })
    assert.equal(empty.classList.contains('tw-obj-empty'), true)
    assert.match(empty.querySelector('.tw-obj-ready')?.textContent ?? '', /chart/i)
  } finally {
    dom.restore()
  }
})

await check('unresolved chart triggers fail visibly instead of falling back to bars', () => {
  const dom = installTestDom()
  try {
    const source = '- Alpha: 40\n- Beta: 25'
    const invalid = widgets.widgetForObjectBlock(
      {
        kind: 'barchart',
        triggerToken: 'barchart=pie',
        from: 0,
        to: source.length,
        source,
      },
      false,
      false,
    ).toDOM({ dispatch() {}, focus() {} })
    assert.equal(invalid.classList.contains('tw-obj-failed'), true)
    assert.equal(invalid.querySelector('.tw-obj-rawsrc')?.textContent, source)
    assert.match(invalid.querySelector('.tw-obj-error')?.textContent ?? '', /trigger/i)
    assert.equal(invalid.querySelector('.chart-cols'), null)
    assert.equal(invalid.querySelector('.chart-pie'), null)
  } finally {
    dom.restore()
  }
})

await check('widget chart styles stay scoped and compute sane labels at widget width', () => {
  const chartCss = readFileSync(
    new URL('../src/renderer/src/chart-widget.css', import.meta.url),
    'utf8',
  )
  const appCss = readFileSync(
    new URL('../src/renderer/src/styles.css', import.meta.url),
    'utf8',
  )
  assert.doesNotMatch(
    appCss,
    /compiler\/assets\/styles\/(?:layouts|skin)\/charts\.css/,
    'deck chart CSS is not imported into the app globally',
  )
  assert.match(chartCss, /\.tw-obj-chart\s*\{[^}]*container-type:\s*inline-size/s)
  assert.doesNotMatch(
    chartCss,
    /(?:^|})\s*\.chart-(?:cols|pie|line)\b/m,
    'chart geometry is never declared outside the widget wrapper',
  )

  const rendered = [
    '<div class="tw-obj-chart">',
    '<div class="tw-obj-chart-body">',
    renderChartBlock({
      type: 'chart',
      shape: 'bar',
      points: [{ value: 40, valueText: '40', label: 'Alpha' }],
    }),
    renderChartBlock({
      type: 'chart',
      shape: 'pie',
      points: [{ value: 40, valueText: '40', label: 'Alpha' }],
    }),
    renderChartBlock({
      type: 'chart',
      shape: 'line',
      points: [{ value: 40, valueText: '40', label: 'Alpha' }],
    }),
    '</div>',
    '</div>',
  ].join('')
  const styleDom = new JSDOM(`<style>${chartCss}</style>${rendered}`)
  try {
    const computed = styleDom.window.getComputedStyle.bind(styleDom.window)
    for (const selector of ['.chart-label', '.chart-leg-label', '.chart-label-svg', '.chart-val-svg']) {
      const fontSize = Number.parseFloat(computed(styleDom.window.document.querySelector(selector)).fontSize)
      assert(
        fontSize >= 10 && fontSize <= 16,
        `${selector} computes to a widget-scale font size; got ${fontSize}px`,
      )
    }
    const legendItem = computed(styleDom.window.document.querySelector('.chart-legend li'))
    assert.match(
      legendItem.gridTemplateColumns,
      /minmax\(8ch,\s*1fr\)/,
      'pie legend items keep a non-collapsing label column at widget width',
    )
    const legendLabel = computed(styleDom.window.document.querySelector('.chart-leg-label'))
    assert.equal(legendLabel.minWidth, '8ch', 'pie legend labels reserve a readable word-width column')
    assert.equal(legendLabel.wordBreak, 'normal', 'pie legend labels do not break one letter per line')
  } finally {
    styleDom.window.close()
  }
})

await check('unreadable chart lists open markup fallback without an outline editor', () => {
  const dom = installTestDom()
  try {
    const source = '- Alpha: 40\nnot a list item'
    const shell = objectRegistry.mountObjectEditor(
      {
        kind: 'chart',
        triggerToken: 'chart=bar',
        from: 0,
        to: source.length,
        source,
      },
      {
        preflight: () => ({ ok: true }),
        commit: () => ({ ok: true }),
      },
    )
    assert.equal(shell.querySelector('.oe-outline'), null)
    assert.equal(shell.querySelector('.oe-markup')?.value, source)
  } finally {
    dom.restore()
  }
})

if (failures) {
  console.error(`\n${failures} object-widget regression(s) failed`)
  process.exit(1)
}
console.log('test:object-widgets OK')
