import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import vm from 'node:vm'
import ts from 'typescript'

// Exercise the registered IPC handler with real files, without launching Electron.
const source = fs.readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
const start = source.indexOf("ipcMain.handle('talk:materialize-slide-assets'")
const end = source.indexOf('\n})', start) + 3
let handler
const root = fs.mkdtempSync(path.join(tmpdir(), 'tw-slide-media-'))
let normalizations = 0
vm.runInNewContext(ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
  ...fs, ...path, createHash, console, Buffer,
  getConfig: () => root,
  ipcMain: { handle: (_name, callback) => { handler = callback } },
  normaliseToWebp: async (bytes) => { normalizations++; return bytes }
})
try {
  const dir = path.join(root, 'source', 'assets', 'imported-media')
  fs.mkdirSync(dir, { recursive: true })
  for (const extension of ['mp4', 'mov', 'm4v', 'webm']) {
    const bytes = Buffer.from(`exact video bytes ${extension}`)
    const filename = `slide clip.${extension}`
    fs.writeFileSync(path.join(dir, filename), bytes)
    fs.writeFileSync(path.join(dir, 'slide clip.png'), 'poster bytes')
    const ref = `assets/imported-media/slide%20clip.${extension}`
    const result = await handler(null, path.join(root, 'source', 'source-outline.md'), `![Imported video](${ref})`)
    const id = 'vid-' + createHash('sha256').update(bytes).digest('hex').slice(0, 7)
    assert.equal(result.markdown, `![Imported video](${id})`, `${extension} must become a portable video reference`)
    assert.deepEqual(fs.readFileSync(path.join(root, '_assets', `${id}.${extension}`)), bytes)
    assert.equal(fs.readFileSync(path.join(root, '_assets', `${id}.png`), 'utf8'), 'poster bytes')
    assert.equal(result.materialized, 1)
  }
  assert.equal(normalizations, 0, 'videos must never enter image conversion')
  const untouched = '![remote](https://example.org/a.mp4)\n![pooled](vid-abcdef0)'
  assert.equal((await handler(null, path.join(root, 'source.md'), untouched)).markdown, untouched)
  fs.writeFileSync(path.join(dir, 'image.png'), 'image bytes')
  const image = await handler(null, path.join(root, 'source', 'source-outline.md'), '![Image](assets/imported-media/image.png)')
  assert.match(image.markdown, /\(img-[a-f0-9]+\)/)
  assert.equal(normalizations, 1)
  console.log('PASS: four video formats, exact bytes, posters, encoded paths, remote/pool refs, existing images')
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
