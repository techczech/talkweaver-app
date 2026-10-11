// The Importer's note about slide-picture tools (decision D17, docs/plans/cloudflare-setup-in-app,
// ticket 09), with no network and no browser:
// 1. the message function (src/shared/importer-renderer-notice.ts): tools present, either missing, not yet known;
// 2. the Importer panel in jsdom: with the tools missing the pointer and its button show and the button asks the
//    app to open the one fixed address; with the tools present the panel is as before and has no pointer;
// 3. no text a person sees says "LibreOffice not found" or "pdftoppm not found" (sources, including the error recorded for a missing tool).
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { JSDOM } from 'jsdom'
import { build } from 'esbuild'
import {
  PPT_EXTRACTOR_BUTTON, PPT_EXTRACTOR_POINTER, PPT_EXTRACTOR_URL, rendererNotice
} from '../src/shared/importer-renderer-notice.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const ready = { name: 'libreoffice', status: 'ready', officePath: '/o/soffice', rasterPath: '/p/pdftoppm', officeVersion: 'v', rasterVersion: 'v' }
const noOffice = { name: 'none', status: 'blocked', officePath: null, rasterPath: '/p/pdftoppm', officeVersion: null, rasterVersion: null }
const noPoppler = { name: 'none', status: 'blocked', officePath: '/o/soffice', rasterPath: null, officeVersion: null, rasterVersion: null }
const neither = { name: 'none', status: 'blocked', officePath: null, rasterPath: null, officeVersion: null, rasterVersion: null }

// 1. message function
assert.deepEqual(rendererNotice(ready), { statusLabel: 'ready', ready: true, paths: ['/o/soffice', '/p/pdftoppm'], showPointer: false })
assert.equal(rendererNotice(noOffice).showPointer, true)
assert.equal(rendererNotice(noPoppler).showPointer, true)
assert.deepEqual(rendererNotice(neither), { statusLabel: 'Not available', ready: false, paths: [], showPointer: true })
assert.deepEqual(rendererNotice(null), { statusLabel: 'checking', ready: false, paths: [], showPointer: false })
assert.match(PPT_EXTRACTOR_URL, /^https:\/\/talkweaver\.app\/tools\/ppt-extractor$/)
assert.match(PPT_EXTRACTOR_POINTER, /separate TalkWeaver PPT Extractor app/)
assert.match(PPT_EXTRACTOR_POINTER, /Text, notes and media import without it/)

// 2. the panel
const dir = mkdtempSync(join(tmpdir(), 'tw-importer-notice-'))
try {
  await build({
    stdin: {
      contents: "export { default as Importer } from './src/renderer/src/components/Importer.tsx'\nexport { default as React } from 'react'\nexport { createRoot } from 'react-dom/client'\nexport { act } from 'react'",
      resolveDir: root, sourcefile: 'importer-notice-entry.tsx', loader: 'tsx'
    },
    bundle: true, format: 'esm', platform: 'browser', jsx: 'automatic', outfile: join(dir, 'bundle.mjs'),
    loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"development"' }, logLevel: 'silent'
  })
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true, url: 'https://talkweaver.test/' })
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver']) {
    Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? dom.window : dom.window[name] })
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window)
  globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window)
  const { Importer, React, createRoot, act } = await import(pathToFileURL(join(dir, 'bundle.mjs')).href)
  const settings = { includeHidden: false, preserveNotes: true, extractMedia: true, fallbackPolicy: 'uncertain', renderer: 'automatic' }

  async function panelText(renderer) {
    const opened = []
    window.tw = {
      shell: { openExternal: async (url) => { opened.push(url); return true } },
      importer: {
        listRuns: async () => [], getSettings: async () => settings, onProgress: () => () => {},
        capabilities: async () => ({ available: true, platform: 'darwin', renderer })
      },
      talk: {}
    }
    const host = document.createElement('div'); document.body.appendChild(host)
    const rootEl = createRoot(host)
    await act(async () => { rootEl.render(React.createElement(Importer, { isOpen: true, onClose() {}, onShowStudio() {}, onShowHistory() {} })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    await act(async () => { host.querySelector('button[title="Importer settings"]').click() })
    const health = host.querySelector('.twi-health')
    const pointer = host.querySelector('[data-testid="importer-extractor-pointer"]')
    const result = { healthText: [...health.children].slice(0, 2).map((c) => c.textContent).join(' ') + [...health.children].slice(2).map((c) => c.textContent).join(''), pointer, button: pointer?.querySelector('button'), opened, host, rootEl }
    return result
  }

  const absent = await panelText(neither)
  assert(absent.pointer, 'pointer shows with the tools absent')
  assert.equal(absent.pointer.querySelector('small').textContent, PPT_EXTRACTOR_POINTER)
  assert.equal(absent.button.textContent, PPT_EXTRACTOR_BUTTON)
  assert.equal(absent.healthText, 'Slide pictures Not available')
  assert.equal(absent.host.querySelector('.twi-health').children.length, 2, 'label and status are separate elements')
  assert.doesNotMatch(absent.host.textContent, /LibreOffice|pdftoppm|not found|Renderer/i)
  assert.doesNotMatch(document.body.textContent, /Renderer/)
  await act(async () => { absent.button.click() })
  assert.deepEqual(absent.opened, [PPT_EXTRACTOR_URL], 'the button opens the one fixed address')
  await act(async () => absent.rootEl.unmount())

  const present = await panelText(ready)
  assert.doesNotMatch(present.host.textContent, /Renderer/)
  assert.equal(present.pointer, null, 'no pointer with the tools present')
  assert.equal(present.healthText, 'Slide pictures ready/o/soffice/p/pdftoppm', 'status wording as before with the tools present, under the new label')
  await act(async () => present.rootEl.unmount())
} finally {
  rmSync(dir, { recursive: true, force: true })
}

// 3b. no user-facing source string says the old words
for (const file of ['src/renderer/src/components/Importer.tsx', 'src/shared/importer-renderer-notice.ts', 'src/main/importer/pptx.ts']) {
  assert.doesNotMatch(readFileSync(join(root, file), 'utf8'), /LibreOffice not found|pdftoppm not found|Missing LibreOffice|Missing \$\{/, file)
}
console.log('importer renderer notice: message function, panel pointer, button address and wording passed')
process.exit(0) // jsdom and the bundled React scheduler keep timers alive
