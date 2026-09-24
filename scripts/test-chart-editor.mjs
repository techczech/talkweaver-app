import { strict as assert } from 'node:assert'
import { installTestDom, TestEvent } from './test-dom.mjs'

const { mountChartEditor } = await import(
  new URL('../src/renderer/src/objects/chart-editor.ts', import.meta.url)
)

const dom = installTestDom()
try {
  const source = '- Alpha: 40\n- Beta: 25\n- Gamma: 35'
  const editor = mountChartEditor(source, 'bar')
  assert(editor, 'a readable chart list mounts the outline editor')
  assert.equal(editor.element.classList.contains('oe-outline'), true)
  const inputs = editor.element.querySelectorAll('input')
  assert.deepEqual(
    inputs.map((input) => input.value),
    ['Alpha: 40', 'Beta: 25', 'Gamma: 35'],
    'the chart editor exposes one outline row per authored list item'
  )
  assert.match(
    editor.element.querySelector('.oe-chart-preview')?.innerHTML ?? '',
    /class="chart-cols/,
    'the chart editor uses the shared bar-chart renderer for its live preview'
  )

  inputs[1].value = 'Beta: 99'
  inputs[1].dispatchEvent(new TestEvent('input'))
  assert.equal(
    editor.serialise(),
    '- Alpha: 40\n- Beta: 99\n- Gamma: 35',
    'editing one value changes only that authored list line'
  )
  assert.match(
    editor.element.querySelector('.oe-chart-preview')?.innerHTML ?? '',
    />99</,
    'the chart preview immediately reflects the edited value'
  )

  assert.equal(
    mountChartEditor('- Alpha: 40\nnot a list item', 'bar'),
    null,
    'the visual editor is never constructed for unreadable list bytes'
  )
  assert.equal(
    mountChartEditor('- Alpha\n- Beta', 'bar'),
    null,
    'the visual editor is never constructed when the compiler cannot parse chart values'
  )
} finally {
  dom.restore()
}

console.log('test:chart-editor OK')
