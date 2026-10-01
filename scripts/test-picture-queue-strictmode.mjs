// Fix round 4 (B): under React StrictMode (dev, main.tsx) effects mount, clean up and mount again. The
// picker's own-slide pictures (useOwnSlidePictures) and the Inspector's option pictures
// (InspectorOptionPictures) used to create their picture queue once in a ref and dispose it in the first
// cleanup, so the remount found a dead queue and no picture was ever asked for. Both are mounted here
// under StrictMode, in jsdom with React's development build, and must ask main for their pictures.
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dir = mkdtempSync(join(root, '.test-picture-strictmode-'))
const bundle = join(dir, 'bundle.mjs')

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'https://talkweaver.test/' })
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? dom.window : dom.window[key] })
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const asked = []
dom.window.tw = {
  talk: {
    layoutVariantThumbnail: (outlinePath, outline, slide, layout, options, requestKey) => {
      const slideId = typeof slide === 'string' ? slide : `line:${slide.headingLine}`
      asked.push({ slideId, slide, layout, options, requestKey })
      return Promise.resolve({ status: 'ok', slideId, url: `twthumb://t/${layout}-${asked.length}`, cached: false })
    }
  }
}
const wait = (ms) => new Promise((done) => setTimeout(done, ms))

try {
  await build({
    stdin: {
      contents: [
        "import React from 'react'",
        "import { createRoot } from 'react-dom/client'",
        "import { useOwnSlidePictures } from './src/renderer/src/components/useOwnSlidePictures.ts'",
        "import InspectorOptionPictures from './src/renderer/src/components/InspectorOptionPictures.tsx'",
        "export { React, createRoot }",
        "export function PickerProbe(props) {",
        "  const pictures = useOwnSlidePictures(props)",
        "  return React.createElement('output', { 'data-pictures': JSON.stringify(pictures) })",
        "}",
        "export { InspectorOptionPictures }"
      ].join('\n'),
      resolveDir: root,
      sourcefile: 'test-picture-strictmode-entry.tsx',
      loader: 'tsx'
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react/*', 'react-dom', 'react-dom/*'],
    outfile: bundle
  })
  const { React, createRoot, PickerProbe, InspectorOptionPictures } = await import(pathToFileURL(bundle).href)
  const { act } = React

  // The layout picker's rows.
  const outline = '### S\n{id=s1}\n\n- one\n- two\n'
  const pickerRoot = createRoot(document.getElementById('root'))
  await act(async () => {
    pickerRoot.render(React.createElement(React.StrictMode, null,
      React.createElement(PickerProbe, { outlinePath: '/v/t/t-outline.md', outline, slide: 's1', wanted: ['cards', 'numbered'] })))
  })
  await act(async () => { await wait(400) })
  assert.deepEqual(asked.filter((ask) => ask.requestKey === 'picker').map((ask) => ask.layout).sort(), ['cards', 'numbered'],
    'under StrictMode the picker asks for its pictures, once each')
  const shown = JSON.parse(document.querySelector('output').getAttribute('data-pictures'))
  assert(typeof shown.cards === 'string' && typeof shown.numbered === 'string', 'and shows them')
  // A slide with no {id=} yet is asked for by its heading line, and the line follows the slide as text above it grows.
  asked.length = 0
  const bare = '### S\n\n- one\n- two\n'
  await act(async () => {
    pickerRoot.render(React.createElement(PickerProbe, { outlinePath: '/v/t/t-outline.md', outline: bare, slide: { headingLine: 1 }, wanted: ['cards'] }))
  })
  await act(async () => { await wait(400) })
  assert.deepEqual(asked.filter((ask) => ask.requestKey === 'picker').map((ask) => ask.slideId), ['line:1'], 'an unstamped slide is asked for by its heading line')
  assert(typeof JSON.parse(document.querySelector('output').getAttribute('data-pictures')).cards === 'string', 'and its picture shows')
  await act(async () => {
    pickerRoot.render(React.createElement(PickerProbe, { outlinePath: '/v/t/t-outline.md', outline: '# top\n\n' + bare, slide: { headingLine: 3 }, wanted: ['cards'] }))
  })
  await act(async () => { await wait(400) })
  assert.equal(asked.filter((ask) => ask.requestKey === 'picker').at(-1)?.slideId, 'line:3', 'after lines shift above it the new line is asked for')
  await act(async () => { pickerRoot.unmount() })

  // The Inspector's option pictures.
  const host = document.createElement('div')
  document.body.appendChild(host)
  const inspectorRoot = createRoot(host)
  const set = { layout: 'cards', pictured: [{ token: '', label: 'Grid' }, { token: 'cards=rows', label: 'Rows' }], rest: [] }
  await act(async () => {
    inspectorRoot.render(React.createElement(React.StrictMode, null,
      React.createElement(InspectorOptionPictures, {
        outlinePath: '/v/t/t-outline.md', outline, slide: 's1', groupKey: 'form', groupLabel: 'Form', set,
        selectedToken: '', commitToken: (value) => value.token, onSelect() {}
      })))
  })
  await act(async () => { await wait(400) })
  const inspectorAsks = asked.filter((ask) => ask.requestKey === 'inspector:form')
  assert.equal(inspectorAsks.length, 2, `under StrictMode the Inspector asks for each option picture once (${inspectorAsks.length})`)
  assert.equal(host.querySelectorAll('.opt-pic img').length, 2, 'and draws them')
  await act(async () => { inspectorRoot.unmount() })
  console.log('ok: under StrictMode the picker and the Inspector still ask for and show their pictures')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
