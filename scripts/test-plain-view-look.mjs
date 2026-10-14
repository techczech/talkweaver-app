// test:plain-view-look — the Plain tab's font and text size settings (plain editing view, spec T13).
//   - reading is tolerant: unset, junk, out-of-range and non-whole sizes fall back to Sans / 16;
//   - the values persist through the config file the main process uses and survive a new reader;
//   - the +/- steps stay inside 13-22;
//   - the Settings rows render the drawing's wording, the current choice, a sample that follows it,
//     and call back with the change; the buttons stop at the ends;
//   - the main process, preload and mock carry the same three calls.
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import {
  PLAIN_FONT_KEY, PLAIN_TEXT_SIZE_KEY, PLAIN_FONTS, plainFontFrom, plainTextSizeFrom, plainLookFrom,
  stepPlainTextSize, plainFontStack, PLAIN_LOOK_DEFAULT
} from '../src/shared/plain-view-look.ts'
import { createConfigFile } from '../src/main/config-file.ts'

const root = fileURLToPath(new URL('..', import.meta.url))

assert.equal(PLAIN_FONT_KEY, 'plainViewFont')
assert.equal(PLAIN_TEXT_SIZE_KEY, 'plainViewTextSize')
assert.deepEqual(PLAIN_LOOK_DEFAULT, { font: 'sans', size: 16 })
assert.deepEqual(PLAIN_FONTS.map((f) => f.label), ['Sans', 'Serif'])
assert.equal(plainFontStack('sans'), "-apple-system, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif")
assert.equal(plainFontStack('serif'), "Charter, 'Iowan Old Style', Georgia, serif")

for (const junk of [undefined, null, 'Serif', 'mono', 3, {}]) assert.equal(plainFontFrom(junk), 'sans', 'font junk: ' + String(junk))
assert.equal(plainFontFrom('serif'), 'serif')
for (const junk of [undefined, null, '18', 12, 23, 0, -1, 16.5, NaN, Infinity, {}]) assert.equal(plainTextSizeFrom(junk), 16, 'size junk: ' + String(junk))
for (const ok of [13, 16, 20, 22]) assert.equal(plainTextSizeFrom(ok), ok)
assert.deepEqual(plainLookFrom({}), { font: 'sans', size: 16 })
assert.deepEqual(plainLookFrom({ plainViewFont: 'serif', plainViewTextSize: 20 }), { font: 'serif', size: 20 })

assert.equal(stepPlainTextSize(16, 1), 17)
assert.equal(stepPlainTextSize(16, -1), 15)
assert.equal(stepPlainTextSize(22, 1), 22)
assert.equal(stepPlainTextSize(13, -1), 13)

const dir = mkdtempSync(join(tmpdir(), 'talk-weaver-plain-look-'))
const renderDir = mkdtempSync(join(root, '.test-plain-look-'))
try {
  const file = createConfigFile(join(dir, 'config.json'))
  assert.deepEqual(plainLookFrom(file.read()), { font: 'sans', size: 16 }, 'fresh config')
  file.write({ vaultName: 'kept' })
  file.write({ [PLAIN_FONT_KEY]: 'serif', [PLAIN_TEXT_SIZE_KEY]: 20 })
  assert.deepEqual(plainLookFrom(createConfigFile(join(dir, 'config.json')).read()), { font: 'serif', size: 20 }, 'survives a new reader')
  assert.equal(file.read().vaultName, 'kept')

  // The rows.
  const bundle = join(renderDir, 'bundle.mjs')
  await build({
    stdin: {
      contents: [
        "import React from 'react'",
        "import { renderToStaticMarkup } from 'react-dom/server'",
        "import PlainLookRows from './src/renderer/src/components/PlainLookRows.tsx'",
        "export const rows = (props) => renderToStaticMarkup(React.createElement(PlainLookRows, props))",
        "export const tree = (props) => PlainLookRows(props)"
      ].join('\n'),
      resolveDir: root, sourcefile: 'plain-look-entry.tsx'
    },
    bundle: true, format: 'esm', platform: 'node', jsx: 'automatic', loader: { '.css': 'empty' },
    external: ['react', 'react/*', 'react-dom', 'react-dom/*'], outfile: bundle, logLevel: 'silent'
  })
  const m = await import(pathToFileURL(bundle).href)
  const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&minus;|−/g, '-').replace(/\s+/g, ' ').trim()
  const html = m.rows({ look: { font: 'sans', size: 16 }, onChange: () => {} })
  const t = text(html)
  assert.ok(t.includes('Plain view font'), 'font row label')
  assert.ok(t.includes('The font used in the Plain tab. The Markdown tab always uses the code font.'), 'font row note')
  assert.ok(t.includes('Text size') && t.includes('16 px'), 'size row')
  assert.ok(t.includes('Steepest rises: 2018 , the station opens; 2022, e-bikes arrive .'.replace(' ,', ',').replace(' .', '.')) || t.includes('Steepest rises:'), 'sample line')
  assert.match(html, /data-font="sans"[^>]*>Sans/)
  assert.match(html, /aria-checked="true"[^>]*data-font="sans"|data-font="sans"[^>]*aria-checked="true"/, 'Sans is the chosen one')
  assert.match(html, /aria-checked="false"[^>]*data-font="serif"|data-font="serif"[^>]*aria-checked="false"/)
  assert.match(html, /data-plain-sample[^>]*font-family:-apple-system/, 'sample follows the font')
  assert.match(html, /data-plain-sample[^>]*font-size:16px/)
  const serif20 = m.rows({ look: { font: 'serif', size: 20 }, onChange: () => {} })
  assert.match(serif20, /data-plain-sample[^>]*font-family:Charter/, 'sample follows Serif')
  assert.match(serif20, /font-size:20px/)
  assert.ok(text(serif20).includes('20 px'))
  assert.match(m.rows({ look: { font: 'sans', size: 22 }, onChange: () => {} }), /data-step="up"[^>]*disabled|disabled[^>]*data-step="up"/, '+ stops at 22')
  assert.match(m.rows({ look: { font: 'sans', size: 13 }, onChange: () => {} }), /data-step="down"[^>]*disabled|disabled[^>]*data-step="down"/, '- stops at 13')
  assert.doesNotMatch(html, /disabled/, 'nothing disabled at 16')

  // Clicks call back with the change (walk the element tree).
  const calls = []
  const found = []
  const walk = (el) => {
    if (!el || typeof el !== 'object') return
    if (Array.isArray(el)) return el.forEach(walk)
    if (el.props) {
      if (el.props['data-font'] || el.props['data-step']) found.push(el.props)
      walk(el.props.children)
    }
  }
  walk(m.tree({ look: { font: 'sans', size: 16 }, onChange: (c) => calls.push(c) }))
  found.find((p) => p['data-font'] === 'serif').onClick()
  found.find((p) => p['data-step'] === 'up').onClick()
  found.find((p) => p['data-step'] === 'down').onClick()
  found.find((p) => p['data-font'] === 'sans').onClick()
  assert.deepEqual(calls, [{ font: 'serif' }, { size: 17 }, { size: 15 }], 'Serif, larger, smaller; the chosen font is not re-sent')

  // The wiring: main, preload and the dev mock carry the same calls.
  const main = readFileSync(join(root, 'src/main/index.ts'), 'utf8')
  const preload = readFileSync(join(root, 'src/preload/index.ts'), 'utf8')
  const mock = readFileSync(join(root, 'src/renderer/src/tw-mock.ts'), 'utf8')
  for (const ch of ['settings:get-plain-look', 'settings:set-plain-look', 'plain-look:changed']) {
    assert.ok(main.includes(ch) && preload.includes(ch), ch + ' in main and preload')
  }
  for (const fn of ['getPlainLook', 'setPlainLook', 'onPlainLookChanged']) assert.ok(preload.includes(fn) && mock.includes(fn), fn + ' in preload and mock')
  console.log('plain view look: ok')
} finally {
  rmSync(dir, { recursive: true, force: true })
  rmSync(renderDir, { recursive: true, force: true })
}
