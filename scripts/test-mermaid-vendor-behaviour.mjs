import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { chromium } from 'playwright'

// Review M5 (2026-07-28): the deck runtime assigns Mermaid's returned SVG to innerHTML without a
// second deck sanitiser. This gate pins the ACTUAL vendored bundle's strict-mode behaviour.
const vendorPath = fileURLToPath(
  new URL('../compiler/assets/vendor/mermaid/mermaid.min.js', import.meta.url)
)

function extractMermaidConfig(source, label) {
  const marker = 'window.mermaid && window.mermaid.initialize('
  const markerIndex = source.indexOf(marker)
  assert(markerIndex >= 0, `${label}: Mermaid initialize call exists`)
  assert.equal(source.indexOf(marker, markerIndex + marker.length), -1, `${label}: one Mermaid initialize call`)
  const start = source.indexOf('{', markerIndex + marker.length)
  assert(start >= 0, `${label}: Mermaid config object starts`)
  let depth = 0
  let quote = ''
  let escaped = false
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]
    if (quote) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        const literal = source.slice(start, index + 1)
        return JSON.parse(JSON.stringify(runInNewContext(`(${literal})`)))
      }
    }
  }
  assert.fail(`${label}: Mermaid config object closes`)
}

const presenterConfig = extractMermaidConfig(
  readFileSync(new URL('../compiler/assets/templates/presenter-popup-single-html.html', import.meta.url), 'utf8'),
  'presenter runtime'
)
const outputBuilderConfig = extractMermaidConfig(
  readFileSync(new URL('../compiler/scripts/lib/09-output-builders.mjs', import.meta.url), 'utf8'),
  'share runtime'
)
assert.deepEqual(outputBuilderConfig, presenterConfig, 'presenter and share runtimes use the same Mermaid config')
const config = presenterConfig
const hostileSources = [
  {
    name: 'node text event handler',
    source: 'flowchart LR\n  A["<img src=x onerror=alert(1)>"] --> B[Safe]'
  },
  {
    name: 'node text script element',
    source: 'flowchart LR\n  A["<script>alert(1)</script>"] --> B[Safe]'
  },
  {
    name: 'javascript click callback link',
    source: 'flowchart LR\n  A[Unsafe link] --> B[Safe]\n  click A "javascript:alert(1)"'
  },
  {
    name: 'source init security downgrade probe',
    source: '%%{init: {"securityLevel": "loose", "flowchart": {"htmlLabels": true}}}%%\nflowchart LR\n  A["<img src=x onerror=alert(1)>"] --> B'
  }
]

const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage()
  await page.setContent('<!doctype html><html><body></body></html>')
  await page.addScriptTag({ path: vendorPath })
  const renders = await page.evaluate(async ({ init, cases }) => {
    window.mermaid.initialize(init)
    const out = []
    for (const [index, item] of cases.entries()) {
      const rendered = await window.mermaid.render(`m5-${index}`, item.source)
      out.push({ name: item.name, svg: rendered.svg })
    }
    return out
  }, { init: config, cases: hostileSources })

  for (const item of renders) {
    assert.match(item.svg, /^<svg\b/i, `${item.name}: Mermaid returned SVG`)
    assert(!/<script\b/i.test(item.svg), `${item.name}: no script element survives`)
    assert(!/\son[a-z][\w.-]*\s*=/i.test(item.svg), `${item.name}: no event handler survives`)
    assert(!/\bjavascript\s*:/i.test(item.svg), `${item.name}: no javascript URL survives`)
    assert(!/\ssrcdoc\s*=/i.test(item.svg), `${item.name}: no srcdoc survives`)
  }
  console.log(`Mermaid vendor behaviour: runtime configs agree; ${renders.length}/${renders.length} hostile renders contain no executable SVG`)
} finally {
  await browser.close()
}
