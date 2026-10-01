import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import vm from 'node:vm'
import ts from 'typescript'
import { outlineRefusal } from '../src/main/vault-paths.ts'
import { pathStaysInside } from '../src/main/path-containment.ts'
import { mkdirBelowRoot } from '../src/main/vault-availability.ts'

// The real write guard (vaults 07): a folder is created only below a vault folder that is there.
const rootFs = { isDirectory: (p) => { try { return fs.statSync(p).isDirectory() } catch { return false } }, mkdir: (p) => fs.mkdirSync(p, { recursive: true }) }
const mkdirInVault = (root, dir) => { if (!fs.existsSync(dir)) mkdirBelowRoot(root, dir, rootFs) }
const writable = (r) => (r && rootFs.isDirectory(r) ? r : undefined)

// Exercise the registered IPC handler with real files, without launching Electron.
const source = fs.readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
const start = source.indexOf("ipcMain.handle('talk:materialize-slide-assets'")
const end = source.indexOf('\n})', start) + 3
let handler
const root = fs.mkdtempSync(path.join(tmpdir(), 'tw-slide-media-'))
let vaultRoot = root
let normalizations = 0
const warnings = []
vm.runInNewContext(ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
  ...fs, ...path, createHash, Buffer, pathStaysInside,
  console: { ...console, warn: (...args) => warnings.push(args.join(' ')) },
  vaultRootFor: () => vaultRoot, // talk-scoped: the vault holding the source outline (registry)
  writableRootFor: () => writable(vaultRoot), mkdirInVault,
  // The real outline guard, with the temp root as the vault.
  outlineRefused: (p) => outlineRefusal(vaultRoot, p),
  ipcMain: { handle: (_name, callback) => { handler = callback } },
  normaliseToWebp: async (bytes) => { normalizations++; return bytes }
})
// The pasted-slide handler and the vault-wide filename index it resolves through.
const pastedStart = source.indexOf('let vaultAssetIndex')
const pastedEnd = source.indexOf('\n})', source.indexOf("ipcMain.handle('talk:materialize-pasted-assets'")) + 3
let pastedHandler
vm.runInNewContext(ts.transpileModule(source.slice(pastedStart, pastedEnd), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
  ...fs, ...path, createHash, Buffer, pathStaysInside,
  console: { ...console, warn: (...args) => warnings.push(args.join(' ')) },
  currentVaultRoot: () => vaultRoot, // vault-wide paste: the current vault (registry)
  writableVaultRoot: () => writable(vaultRoot), mkdirInVault,
  ipcMain: { handle: (_name, callback) => { pastedHandler = callback } },
  normaliseToWebp: async (bytes) => bytes
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

  // Sources must come from inside the vault: absolute, `..` and symlinked escapes are skipped.
  const vault = path.join(root, 'vault')
  const outside = path.join(root, 'outside')
  const talk = path.join(vault, 'talks', 'destination')
  const other = path.join(vault, 'talks', 'other', 'assets')
  fs.mkdirSync(talk, { recursive: true })
  fs.mkdirSync(other, { recursive: true })
  fs.mkdirSync(outside, { recursive: true })
  fs.writeFileSync(path.join(other, 'inside.png'), 'inside image bytes')
  fs.writeFileSync(path.join(other, 'inside.mp4'), 'inside video bytes')
  fs.writeFileSync(path.join(outside, 'x.png'), 'OUTSIDE image bytes')
  fs.writeFileSync(path.join(outside, 'poster.png'), 'OUTSIDE poster bytes')
  fs.symlinkSync(path.join(outside, 'x.png'), path.join(other, 'linked.png'))
  fs.writeFileSync(path.join(talk, 'clip.webm'), 'clip bytes')
  fs.symlinkSync(path.join(outside, 'poster.png'), path.join(talk, 'clip.png'))
  vaultRoot = vault // a fresh vault whose _assets holds only what this call writes
  const outline = path.join(talk, 'destination-outline.md')
  fs.writeFileSync(outline, '# Destination\n')
  const absoluteRef = path.join(outside, 'x.png')
  const refs = [
    '![reused image](../other/assets/inside.png)',
    '![reused video](../other/assets/inside.mp4)',
    `![absolute](${absoluteRef})`,
    '![relative escape](../../../outside/x.png)',
    '![symlink out](../other/assets/linked.png)',
    '![poster out](clip.webm)'
  ]
  warnings.length = 0
  const mixed = await handler(null, outline, refs.join('\n'))
  assert.equal(mixed.success, true, mixed.error)
  const lines = mixed.markdown.split('\n')
  assert.match(lines[0], /^!\[reused image\]\(img-[a-f0-9]{7}\)$/, 'an image in another talk must materialize')
  assert.match(lines[1], /^!\[reused video\]\(vid-[a-f0-9]{7}\)$/, 'a video in another talk must materialize')
  assert.equal(lines[2], refs[2], 'an absolute outside reference stays unchanged')
  assert.equal(lines[3], refs[3], 'a relative escape stays unchanged')
  assert.equal(lines[4], refs[4], 'a symlink to outside stays unchanged')
  assert.match(lines[5], /^!\[poster out\]\(vid-[a-f0-9]{7}\)$/, 'an inside clip still materializes')
  assert.equal(mixed.materialized, 3)
  assert.equal(mixed.skipped, 3)
  const assets = path.join(vault, '_assets')
  const videoId = lines[1].match(/vid-[a-f0-9]{7}/)[0]
  assert.equal(fs.readFileSync(path.join(assets, `${videoId}.png`), 'utf8'), 'inside image bytes', 'an inside poster (same stem) travels with its clip')
  const clipId = lines[5].match(/vid-[a-f0-9]{7}/)[0]
  assert.ok(!fs.readdirSync(assets).some((name) => name.startsWith(clipId) && /\.(png|jpe?g|webp)$/.test(name)), 'a poster symlinked outside is not copied')
  for (const name of fs.readdirSync(assets)) {
    const bytes = fs.readFileSync(path.join(assets, name), 'utf8')
    assert.ok(!bytes.includes('OUTSIDE'), `nothing from outside the vault may reach _assets (${name})`)
  }
  assert.equal(warnings.filter((w) => w.includes('outside the vault')).length, 4, 'three references and one poster are refused with a warning')
  assert.ok(!warnings.some((w) => w.includes(fs.realpathSync(outside)) && !w.includes(absoluteRef)), 'warnings name the reference, not the resolved path')
  console.log('PASS: inside sources materialize; absolute, ../ and symlinked outside sources and posters are skipped')

  // A file URL is never followed: skipped and counted, markdown unchanged.
  const fileUrl = `![file url](file://${path.join(outside, 'x.png')})`
  const viaUrl = await handler(null, outline, fileUrl)
  assert.equal(viaUrl.markdown, fileUrl)
  assert.equal(viaUrl.skipped, 1)
  assert.equal(viaUrl.materialized, 0)

  // Pasted slides resolve by filename across the vault; a linked file pointing outside is skipped.
  const pasteVault = path.join(root, 'paste-vault')
  const pasteAssets = path.join(pasteVault, 'talk-a', 'assets')
  fs.mkdirSync(pasteAssets, { recursive: true })
  fs.writeFileSync(path.join(pasteAssets, 'real.png'), 'pasted inside bytes')
  fs.writeFileSync(path.join(pasteAssets, 'by-url.png'), 'reached only through a file URL')
  fs.symlinkSync(path.join(pasteAssets, 'real.png'), path.join(pasteAssets, 'alias.png')) // a link that stays inside
  fs.symlinkSync(path.join(outside, 'x.png'), path.join(pasteAssets, 'leak.png'))
  fs.writeFileSync(path.join(pasteAssets, 'movie.mp4'), 'pasted clip bytes')
  fs.symlinkSync(path.join(outside, 'poster.png'), path.join(pasteAssets, 'movie.png'))
  vaultRoot = pasteVault
  const pasted = [
    '![real](assets/real.png)',
    '![alias](assets/alias.png)',
    '![leak](assets/leak.png)',
    '![movie](assets/movie.mp4)',
    `![file url](file://${path.join(pasteAssets, 'by-url.png')})`
  ]
  warnings.length = 0
  const pastedResult = await pastedHandler(null, pasted.join('\n'))
  assert.equal(pastedResult.success, true, pastedResult.error)
  const pastedLines = pastedResult.markdown.split('\n')
  assert.match(pastedLines[0], /^!\[real\]\(img-[a-f0-9]{7}\)$/, 'a pasted inside image materializes')
  assert.match(pastedLines[1], /^!\[alias\]\(img-[a-f0-9]{7}\)$/, 'a link that stays inside the vault still materializes')
  assert.equal(pastedLines[2], pasted[2], 'a linked file pointing outside stays unchanged')
  assert.match(pastedLines[3], /^!\[movie\]\(vid-[a-f0-9]{7}\)$/, 'a pasted inside clip materializes')
  assert.equal(pastedLines[4], pasted[4], 'a file URL stays unchanged')
  assert.equal(pastedResult.materialized, 3)
  assert.equal(pastedResult.skipped, 2)
  const pastePool = path.join(pasteVault, '_assets')
  const movieId = pastedLines[3].match(/vid-[a-f0-9]{7}/)[0]
  assert.ok(!fs.readdirSync(pastePool).some((name) => name.startsWith(movieId) && /\.(png|jpe?g|webp)$/.test(name)), 'a pasted poster linked outside is not copied')
  for (const name of fs.readdirSync(pastePool)) {
    assert.ok(!fs.readFileSync(path.join(pastePool, name), 'utf8').includes('OUTSIDE'), `nothing from outside may reach _assets (${name})`)
  }
  assert.equal(warnings.filter((w) => w.includes('outside the vault')).length, 2, 'one reference and one poster are refused with a warning')
  console.log('PASS: file URLs skipped; pasted slides skip linked files and posters that resolve outside, inside links still work')
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
