#!/usr/bin/env node
/**
 * Work moved off the main process's thread (2026-11-06 large-talk performance), checked where a
 * mistake would be costly and hard to see in use:
 *
 * 1. Search rows come from the compile's own process (prepare-talk-worker.ts, a rowsOnly job): rows of
 *    the text that was sent (not of an older file), and no deck in the answer.
 * 2. Rows of a revision that changed while they were compiled are never returned: the current one is
 *    compiled once more, else none; rows of a vault that closed meanwhile are dropped
 *    (search-rows-off-process.ts).
 * 3. The preview variant made in the compile's process is byte-for-byte what the main process would
 *    have made, comes back as a file and a descriptor (never as bytes in the main process), and none
 *    is made for a deck with a remote page; the variant folder stays bounded (preview-variant.ts).
 * 4. A generated file is replaced in one step: a write that fails part-way (or takes no bytes) leaves
 *    the previous file whole and no temporary file behind, short writes are continued, and writes to
 *    the same file land in the order asked (generated-file-write.ts).
 */
import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir, symlink, lstat, link, unlink, rename as renamePath } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** The identity a variant descriptor records for the file written this run (preview-variant.ts). */
async function fileIdentity(path) {
  const stats = await lstat(path, { bigint: true })
  return { dev: String(stats.dev), ino: String(stats.ino), size: Number(stats.size), mtimeNs: String(stats.mtimeNs) }
}

const src = (p) => import(pathToFileURL(join(process.cwd(), p)).href)
const { createPrepareTalkOffThread } = await src('src/main/prepare-talk-off-thread.ts')
const { forkNodeCompileChild } = await src('scripts/lib/node-compile-child.mjs')
const { previewVariantBytes: previewVariant, usablePreviewVariant, createPreviewVariantFiles, writePreviewVariant, regularVariantFile, openPreviewVariant, validateVariantFolder } = await src('src/main/preview-variant.ts')
const { prepareSearchRows } = await src('src/main/search-rows-off-process.ts')
const { writeGeneratedFile, writeTextInSlices } = await src('src/main/generated-file-write.ts')
const { markSlidePreviewHtml } = await src('src/shared/slide-preview.ts')

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const base = await mkdtemp(join(tmpdir(), 'tw-main-offload-'))
const compilerDir = join(process.cwd(), 'compiler', 'scripts')
const outline = (title) => ['---', 'title: Offload', '---', '', `### ${title}`, '', 'Body text.', '', '### Second slide', '', 'More text.', ''].join('\n')
const compile = createPrepareTalkOffThread(join(process.cwd(), 'src/main/prepare-talk-worker.ts'), forkNodeCompileChild, 200)

try {
  // 1. Search rows from the compile's process: the revision sent, rows only.
  {
    const vault = join(base, 'vault-a')
    const talkDir = join(vault, 'talk')
    await mkdir(talkDir, { recursive: true })
    const outlinePath = join(talkDir, 'talk-outline.md')
    await writeFile(outlinePath, outline('Old title on disk'))
    const answer = await compile({
      compilerDir, outlinePath, text: outline('New title in the editor'), slug: 'talk', rowsOnly: true,
      options: { projectionsOnly: true, allowedAssetRoots: [vault] }
    })
    assert.ok(Array.isArray(answer.rows) && answer.rows.length >= 2, `the slides give search rows (got ${JSON.stringify(answer.rows?.map((r) => r.title ?? r.nav_title))})`)
    const titles = answer.rows.map((row) => row.title ?? row.nav_title)
    assert.ok(titles.includes('New title in the editor'), `rows are of the text sent, not the file on disk (got ${titles.join(', ')})`)
    assert.ok(!titles.includes('Old title on disk'), 'no row of the older revision')
    assert.deepEqual(answer.model, {}, 'a rowsOnly answer carries no model (no deck reaches the main process)')
    assert.equal(answer.preview, undefined, 'and no preview')
    assert.equal(answer.previewKey, undefined, 'and no preview key')

    // A job without its vault's roots is refused, as every compile is.
    await assert.rejects(compile({ compilerDir, outlinePath, text: outline('x'), slug: 'talk', rowsOnly: true, options: { projectionsOnly: true } }))

    // 3a. A full compile hands back the preview variant: exactly the main process's own marking.
    // The main process makes and validates the folder (createPreviewVariantFiles) and hands the worker
    // its identity; the worker checks it again before writing.
    const previewPath = join(base, 'preview-variants')
    await mkdir(previewPath)
    const previewDir = await validateVariantFolder(previewPath)
    const full = await compile({ compilerDir, outlinePath, text: outline('Full'), slug: 'talk', previewDir, options: { allowedAssetRoots: [vault] } })
    assert.equal(typeof full.model.fullHtml, 'string')
    assert.ok(full.preview, 'a deck with no remote page gets a preview variant')
    const expected = Buffer.from(markSlidePreviewHtml(full.model.fullHtml, { localPages: true }), 'utf8')
    assert.equal(full.preview.bytes, undefined, 'only a descriptor crosses to the main process, never the bytes (no second deck in main)')
    assert.equal(full.preview.path, join(previewPath, `${full.preview.key}.html`), 'the variant is a file named by its hash, in the folder given')
    assert.ok((await readFile(full.preview.path)).equals(expected), 'the file is the marked deck, byte for byte')
    assert.equal(full.preview.key, createHash('sha256').update(expected).digest('hex'), 'its key is the sha256 the thumbnail window keys on')
    assert.equal(full.preview.size, expected.byteLength)
    assert.ok(usablePreviewVariant(full.preview, previewDir), 'a variant that came back is usable')
    assert.equal(usablePreviewVariant(full.preview, { ...previewDir, ino: '1' }), undefined, 'but not from a folder of another identity')
    // An entry replaced after the write (another file, a hard link, an in-place rewrite) is refused at
    // use, by the preview server and the thumbnail window alike; the original descriptor no longer fits.
    {
      const variant = usablePreviewVariant(full.preview, previewDir)
      assert.ok(regularVariantFile(variant), 'the file written this run is accepted')
      assert.equal(usablePreviewVariant({ ...full.preview, file: undefined }, previewDir), undefined, 'a descriptor without the written file identity is not used')
      const original = await readFile(variant.path)
      const elsewhere = join(base, 'elsewhere.html')
      await writeFile(elsewhere, original)
      await renamePath(elsewhere, variant.path)
      assert.equal(regularVariantFile(variant), false, 'a same-bytes file renamed over the entry afterwards is refused')
      assert.equal(await openPreviewVariant(variant), null, 'and never served')
      const fresh = await compile({ compilerDir, outlinePath, text: outline('Full'), slug: 'talk', previewDir, options: { allowedAssetRoots: [vault] } })
      const second = usablePreviewVariant(fresh.preview, previewDir)
      assert.ok(regularVariantFile(second), 'a fresh write is accepted again')
      const linked = join(base, 'hard-link.html')
      await link(second.path, linked)
      assert.equal(regularVariantFile(second), false, 'a hard link made to the entry afterwards makes it refused')
      await unlink(linked)
    }
    const unasked = await compile({ compilerDir, outlinePath, text: outline('Full'), slug: 'talk', options: { allowedAssetRoots: [vault] } })
    assert.equal(unasked.preview, undefined, 'a compile that does not ask for the variant gets none')
  }

  // 3b. A deck with a remote page gets no variant (the main process must turn it into pixels first);
  // a local widget frame or a validated player keeps the variant.
  {
    const deck = (body) => `<html><head></head><body><section class="slide">${body}</section></body></html>`
    assert.equal(previewVariant(deck('<iframe data-src="https://example.org/page"></iframe>')), undefined, 'remote page: no variant')
    assert.equal(previewVariant(deck('<iframe srcdoc="<p>x</p>"></iframe>')), undefined, 'srcdoc frame: no variant (it is replaced too)')
    assert.ok(previewVariant(deck('<iframe class="widget"></iframe>')), 'an empty local frame keeps the variant')
    assert.ok(previewVariant(deck('<iframe data-embed-video="1" src="https://www.youtube-nocookie.com/embed/abcdefghijk"></iframe>')), 'a validated player keeps the variant')
    assert.equal(previewVariant(''), undefined, 'an empty deck has no variant')
    assert.equal(usablePreviewVariant({ path: '/x/not-a-hash.html', key: 'not-a-hash', size: 1, folder: { path: '/x', dev: '1', ino: '1' } }), undefined, 'a malformed variant is not used')
  }

  // 4b. The variant folder: cleaned at start (variant files only), then kept to its limits, least
  // recently used first.
  {
    const dir = join(base, 'variant-folder')
    await mkdir(dir)
    const staleName = `${'e'.repeat(64)}.html`
    await writeFile(join(dir, staleName), 'old variant')
    await writeFile(join(dir, `${staleName}.0123456789ab.tmp`), 'old temp')
    await writeFile(join(dir, 'notes.txt'), 'not ours')
    await writeFile(join(dir, `${'f'.repeat(64)}.htm`), 'near miss')
    const files = createPreviewVariantFiles(dir, { maxFiles: 3, maxBytes: 1000, keepNewest: 1, graceMs: 0, log: () => {} })
    assert.equal(await files.ready, true, 'a real folder of this user: variants on')
    assert.deepEqual((await readdir(dir)).sort(), ['f'.repeat(64) + '.htm', 'notes.txt'], 'only variant files and their temp files of an earlier run are removed; anything else stays')
    await rm(join(dir, 'notes.txt')); await rm(join(dir, `${'f'.repeat(64)}.htm`))
    const folder = files.folder()
    const make = async (n, size = 10) => {
      const key = createHash('sha256').update(String(n)).digest('hex')
      const path = join(dir, `${key}.html`)
      await writeFile(path, 'x'.repeat(size))
      return { path, key, size, folder, file: await fileIdentity(path) }
    }
    const [a, b, c, d] = [await make(1), await make(2), await make(3), await make(4)]
    for (const v of [a, b, c]) files.note(v)
    files.note(a) // used again: now the most recent
    files.note(d) // a fourth: the least recently used (b) goes
    await wait(20)
    assert.deepEqual(files.kept(), [c.key, a.key, d.key])
    assert.equal(existsSync(b.path), false, 'the least recently used file is deleted')
    assert.ok(existsSync(a.path) && existsSync(c.path) && existsSync(d.path))
    const big = await make(5, 2000)
    files.note(big) // over the byte budget: everything older goes, the newest is always kept
    await wait(20)
    assert.deepEqual(files.kept(), [big.key])
    assert.ok(existsSync(big.path))
  }

  // 3c. The same key written again (each write is a fresh file): a held descriptor of the earlier write
  // is refused on its own but recovers through the newest noted write; a foreign file never does.
  {
    const dir = join(base, 'variant-rewrite')
    await mkdir(dir)
    const files = createPreviewVariantFiles(dir, { log: () => {} })
    assert.equal(await files.ready, true)
    const deck = '<html><head></head><body><section class="slide"><p>same</p></section></body></html>'
    const first = await writePreviewVariant(deck, files.folder())
    files.note(first)
    const second = await writePreviewVariant(deck, files.folder())
    files.note(second)
    assert.equal(first.key, second.key, 'same deck, same key')
    assert.equal(await openPreviewVariant(first), null, 'the held earlier descriptor alone is refused (fresh file since)')
    const current = files.current(first.key)
    assert.ok(current && current.file.ino === second.file.ino, 'the newest noted write is current for the key')
    const body = await openPreviewVariant(current)
    assert.ok(body, 'and is served')
    await body.cancel()
    const foreign = join(base, 'foreign.html')
    await writeFile(foreign, await readFile(second.path))
    await renamePath(foreign, second.path)
    assert.equal(files.current(first.key), undefined, 'a file put under the name afterwards is never current')
  }

  // 3. Pruning never deletes the two newest, nor anything noted in the last minute; a pruned (missing)
  // file is refused at use, which is what makes a consumer fall back to fullHtml.
  {
    const dir = join(base, 'variant-grace')
    await mkdir(dir)
    let clock = 1_000_000
    const files = createPreviewVariantFiles(dir, { maxFiles: 1, now: () => clock, log: () => {} })
    await files.ready
    const folder = files.folder()
    const made = []
    for (let n = 0; n < 4; n++) {
      const key = createHash('sha256').update(`g${n}`).digest('hex')
      const path = join(dir, `${key}.html`)
      await writeFile(path, 'x')
      made.push({ path, key, size: 1, folder, file: await fileIdentity(path) })
    }
    files.note(made[0]); files.note(made[1]); files.note(made[2])
    await wait(20)
    assert.equal(files.kept().length, 3, 'all noted within the last minute: none deleted, though over the limit')
    clock += 61_000
    files.note(made[3])
    await wait(20)
    assert.deepEqual(files.kept(), [made[2].key, made[3].key], 'past the grace period the older go, the two newest stay')
    assert.ok(!existsSync(made[0].path) && !existsSync(made[1].path) && existsSync(made[2].path) && existsSync(made[3].path))
    assert.equal(regularVariantFile(made[0]), false, 'a pruned file is refused at use (the thumbnail render then loads fullHtml)')
    assert.equal(await openPreviewVariant(made[0]), null, 'and the preview answers not found')
    assert.equal(regularVariantFile(made[3]), true)
    const body = await openPreviewVariant(made[3])
    assert.ok(body, 'a kept variant is served')
    assert.equal(await new Response(body).text(), 'x')
  }

  // 1. A variant folder that is a link (or not a folder): variants off, nothing behind it touched.
  {
    const outside = join(base, 'somebody-elses-folder')
    await mkdir(outside)
    const precious = ['a'.repeat(64) + '.html', 'b'.repeat(64) + '.html.0123456789ab.tmp', 'work.docx']
    for (const name of precious) await writeFile(join(outside, name), 'precious')
    const linked = join(base, 'linked-variants')
    await symlink(outside, linked)
    const logs = []
    const files = createPreviewVariantFiles(linked, { log: (m) => logs.push(m) })
    assert.equal(await files.ready, false, 'a linked folder turns variants off')
    assert.equal(files.enabled(), false)
    assert.equal(logs.length, 1, 'and says so once')
    assert.deepEqual((await readdir(outside)).sort(), precious.slice().sort(), 'nothing behind the link is deleted, variant-named or not')
    assert.equal(await validateVariantFolder(linked), null)
    const deck = '<html><head></head><body><section class="slide">x</section></body></html>'
    const outsideStats = await lstat(outside, { bigint: true })
    assert.equal(await writePreviewVariant(deck, { path: linked, dev: String(outsideStats.dev), ino: String(outsideStats.ino) }), undefined, 'no variant is written through a linked folder')
    assert.deepEqual((await readdir(outside)).sort(), precious.slice().sort())
    files.note({ path: join(linked, precious[0]), key: 'a'.repeat(64), size: 1, folder: { path: linked, dev: '0', ino: '0' } })
    assert.deepEqual(files.kept(), [], 'nothing is noted (or pruned) while variants are off')
    const notFolder = join(base, 'not-a-folder')
    await writeFile(notFolder, 'file')
    assert.equal(await createPreviewVariantFiles(notFolder, { log: () => {} }).ready, false)
    assert.equal(await readFile(notFolder, 'utf8'), 'file')
  }

  // 1b. The folder replaced by another directory after it was validated: prune, serve and write all
  // refuse, variants turn off (once), and nothing in the replacement is deleted.
  {
    const dir = join(base, 'variant-swapped')
    await mkdir(dir)
    const logs = []
    const files = createPreviewVariantFiles(dir, { maxFiles: 1, keepNewest: 0, graceMs: 0, log: (m) => logs.push(m) })
    assert.equal(await files.ready, true)
    const folder = files.folder()
    const deck = '<html><head></head><body><section class="slide">swap</section></body></html>'
    const written = await writePreviewVariant(deck, folder)
    assert.ok(written && regularVariantFile(written))
    // Between runs or while running: the folder is moved away and another directory takes its name,
    // holding variant-named files of its own.
    await renamePath(dir, join(base, 'variant-swapped-original'))
    await mkdir(dir)
    const theirs = [`${'1'.repeat(64)}.html`, written.path.split('/').pop()]
    for (const name of theirs) await writeFile(join(dir, name), 'not ours')
    assert.equal(regularVariantFile({ ...written }), false, 'a variant is refused once its folder is another directory')
    assert.equal(await openPreviewVariant(written), null, 'and not served')
    assert.equal(await writePreviewVariant(deck, folder), undefined, 'and nothing is written into the replacement')
    const k1 = { path: join(dir, theirs[0]), key: '1'.repeat(64), size: 1, folder }
    files.note(k1) // would prune: the folder check turns variants off instead
    files.note({ ...written })
    await wait(20)
    assert.equal(files.check(), false, 'variants are off for the run')
    assert.equal(files.folder(), null)
    assert.equal(logs.length, 1, 'said once')
    assert.deepEqual((await readdir(dir)).sort(), theirs.slice().sort(), 'nothing in the replacement directory is deleted')
  }

  // 2. Entries under a variant name that are not the variant: a link, a hard link, an unrelated
  // regular file. None is trusted as content; each is replaced by fresh bytes, and whatever it pointed
  // to (or its other link) is untouched.
  {
    const dir = join(base, 'variant-links')
    await mkdir(dir)
    const folder = await validateVariantFolder(dir)
    const deck = (n) => `<html><head></head><body><section class="slide">deck ${n}</section></body></html>`
    const nameOf = (d) => `${previewVariant(d).key}.html`

    const secret = join(base, 'secret.html')
    await writeFile(secret, 'secret')
    await symlink(secret, join(dir, nameOf(deck(1))))
    const linkEntry = { path: join(dir, nameOf(deck(1))), key: previewVariant(deck(1)).key, size: 1, folder }
    assert.equal(regularVariantFile(linkEntry), false, 'a link under a variant name is refused at use')
    assert.equal(await openPreviewVariant(linkEntry), null, 'and never served')
    const viaLink = await writePreviewVariant(deck(1), folder)
    assert.ok(viaLink && (await lstat(viaLink.path)).isFile(), 'written fresh as a regular file in place of the link')
    assert.ok((await readFile(viaLink.path)).equals(previewVariant(deck(1)).bytes))
    assert.equal(await readFile(secret, 'utf8'), 'secret', 'the link target is untouched')

    const elsewhere = join(base, 'hard-linked-original.html')
    await writeFile(elsewhere, 'the other link keeps this')
    await link(elsewhere, join(dir, nameOf(deck(2))))
    const viaHardLink = await writePreviewVariant(deck(2), folder)
    assert.ok((await readFile(viaHardLink.path)).equals(previewVariant(deck(2)).bytes), 'a hard-linked entry is replaced by fresh bytes')
    assert.equal(await readFile(elsewhere, 'utf8'), 'the other link keeps this', 'and its other link is untouched')

    await writeFile(join(dir, nameOf(deck(3))), 'unrelated content under the right name')
    const viaUnrelated = await writePreviewVariant(deck(3), folder)
    assert.ok((await readFile(viaUnrelated.path)).equals(previewVariant(deck(3)).bytes), 'a regular file under the name is not trusted: rewritten')

    // A cleanup at start leaves a variant-named link alone (not a regular file) and its target untouched.
    const otherName = `${'c'.repeat(64)}.html`
    await symlink(secret, join(dir, otherName))
    await createPreviewVariantFiles(dir, { log: () => {} }).ready
    assert.equal(await readFile(secret, 'utf8'), 'secret', 'cleanup never follows a link')
    assert.ok((await lstat(join(dir, otherName))).isSymbolicLink())
  }

  // 2. Rows judged against the stamp before and after the compile.
  {
    // The "source" is the revision on disk; rows say which revision they were compiled from.
    let disk = { vaultOpen: true, revision: 'A' }
    const read = () => disk.revision
    const rowsOf = async (source) => [{ revision: source }]

    const kept = await prepareSearchRows({ stamp: () => disk, read, compile: rowsOf })
    assert.deepEqual(kept, { rows: [{ revision: 'A' }], source: 'A', stale: false }, 'nothing moved: the rows of A')

    // Saved as B while A compiled: A's rows are never returned; the retry compiles B.
    let saves = ['B']
    const once = await prepareSearchRows({ stamp: () => disk, read, compile: async (source) => { if (saves.length) disk = { vaultOpen: true, revision: saves.shift() }; return rowsOf(source) } })
    assert.deepEqual(once, { rows: [{ revision: 'B' }], source: 'B', stale: false }, 'a save during the compile: the current revision is compiled and returned')

    // Saved during the retry as well: no rows at all, marked stale.
    disk = { vaultOpen: true, revision: 'C' }
    saves = ['D', 'E']
    const moving = await prepareSearchRows({ stamp: () => disk, read, compile: async (source) => { if (saves.length) disk = { vaultOpen: true, revision: saves.shift() }; return rowsOf(source) } })
    assert.deepEqual(moving, { rows: null, stale: true }, 'still moving after one retry: no rows, never stale ones')

    // Renamed during the compile (the outline is gone: its mtime reads null): no stale rows either.
    disk = { vaultOpen: true, revision: 'F' }
    const renamed = await prepareSearchRows({ stamp: () => disk, read: () => { if (disk.revision === 'null') throw new Error('ENOENT'); return disk.revision }, compile: async (source) => { disk = { vaultOpen: true, revision: 'null' }; return rowsOf(source) } })
      .catch((error) => ({ error: error.message }))
    assert.deepEqual(renamed, { error: 'ENOENT' }, 'a renamed outline yields no rows (the read of the gone file fails)')

    disk = { vaultOpen: true, revision: 'G' }
    const closed = await prepareSearchRows({ stamp: () => disk, read, compile: async (source) => { disk = { vaultOpen: false, revision: 'G' }; return rowsOf(source) } })
    assert.deepEqual(closed, { rows: null, stale: false }, 'the vault closed meanwhile: rows of the wrong vault are dropped')

    const none = await prepareSearchRows({ stamp: () => ({ vaultOpen: true, revision: 'x' }), read, compile: async () => null })
    assert.deepEqual(none, { rows: null, stale: false }, 'no rows: none returned')
  }

  // 4. Generated files: replaced whole or not at all.
  {
    const dir = join(base, 'generated')
    await mkdir(dir)
    const path = join(dir, 'talk-present.html')
    await writeGeneratedFile(path, '<html>first</html>')
    assert.equal(await readFile(path, 'utf8'), '<html>first</html>')
    await writeGeneratedFile(path, new TextEncoder().encode('<html>second</html>'))
    assert.equal(await readFile(path, 'utf8'), '<html>second</html>', 'bytes are written as given')

    // Written a slice at a time: the bytes are exactly the UTF-8 of the whole text, also where a slice
    // boundary falls inside a surrogate pair (an emoji) or a multi-byte character.
    const text = 'ab😀c' + 'é'.repeat(5) + '😀'.repeat(7) + 'z'
    for (const size of [1, 2, 3, 4, 5, 7, 1000]) {
      const sliced = join(dir, `sliced-${size}.html`)
      await writeTextInSlices(sliced, text, size)
      assert.ok((await readFile(sliced)).equals(Buffer.from(text, 'utf8')), `slices of ${size} characters write the same bytes`)
      await rm(sliced)
    }

    // A file system that takes a few bytes per call: every byte still arrives, in order.
    const shortWrites = []
    const shortHandle = () => ({
      async write(buffer, offset, length) { const n = Math.min(3, length); shortWrites.push(Buffer.from(buffer.subarray(offset, offset + n))); return { bytesWritten: n } },
      async close() {},
    })
    await writeTextInSlices('/unused', text, 4, async () => shortHandle())
    assert.ok(Buffer.concat(shortWrites).equals(Buffer.from(text, 'utf8')), 'short writes are continued until every byte is written')
    // One that takes nothing: a failure, never a file published as complete.
    const stuck = { async write() { return { bytesWritten: 0 } }, async close() {} }
    await assert.rejects(writeTextInSlices('/unused', text, 4, async () => stuck), /no bytes/)
    const stuckPath = join(dir, 'stuck-present.html')
    await writeFile(stuckPath, 'previous')
    const stuckOps = { writeFile: (p, data) => writeTextInSlices(p, String(data), 4, async () => stuck), rename: (await import('node:fs/promises')).rename, unlink: (await import('node:fs/promises')).unlink }
    await assert.rejects(writeGeneratedFile(stuckPath, 'newer', stuckOps), /no bytes/)
    assert.equal(await readFile(stuckPath, 'utf8'), 'previous', 'a write that made no progress publishes nothing')

    // Two writes to the same file, the older one slow: they rename in the order asked, so the newer
    // revision is what stays.
    {
      const ordered = join(dir, 'ordered-present.html')
      const real = await import('node:fs/promises')
      const slowOps = { writeFile: async (p, data) => { await wait(60); await real.writeFile(p, data) }, rename: real.rename, unlink: real.unlink }
      const older = writeGeneratedFile(ordered, '<html>older, slow</html>', slowOps)
      const newer = writeGeneratedFile(ordered, '<html>newer, fast</html>')
      await Promise.all([older, newer])
      assert.equal(await readFile(ordered, 'utf8'), '<html>newer, fast</html>', 'the newer request lands last')
      // A failed earlier write does not stop the next one.
      const failing = writeGeneratedFile(ordered, 'x', { writeFile: async () => { throw new Error('boom') }, rename: real.rename, unlink: real.unlink })
      const after = writeGeneratedFile(ordered, '<html>after a failure</html>')
      await assert.rejects(failing, /boom/)
      await after
      assert.equal(await readFile(ordered, 'utf8'), '<html>after a failure</html>')
      await rm(ordered)
      await rm(stuckPath)
    }

    // Temporary files are created exclusively: an entry already under the temporary name is never
    // written through; the write takes another name.
    {
      const target = join(dir, 'collide-present.html')
      const taken = `${target}.aaaaaaaaaaaa.tmp`
      await writeFile(taken, 'someone else')
      const outsideTarget = join(base, 'collide-elsewhere.txt')
      await writeFile(outsideTarget, 'outside')
      const linkedTemp = `${target}.bbbbbbbbbbbb.tmp`
      await symlink(outsideTarget, linkedTemp)
      const real = await import('node:fs/promises')
      const names = ['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'cccccccccccc']
      const ops = { writeFile: (p, data) => writeTextInSlices(p, String(data)), rename: real.rename, unlink: real.unlink, tempSuffix: () => names.shift() }
      await writeGeneratedFile(target, '<html>written</html>', ops)
      assert.equal(await readFile(target, 'utf8'), '<html>written</html>', 'written under the third name')
      assert.equal(await readFile(taken, 'utf8'), 'someone else', 'a file already under a temporary name is left as it was')
      assert.equal(await readFile(outsideTarget, 'utf8'), 'outside', 'a link under a temporary name is not written through')
      // Every name taken: the write fails (EEXIST) and touches nothing.
      const allTaken = ['aaaaaaaaaaaa', 'aaaaaaaaaaaa', 'aaaaaaaaaaaa']
      await assert.rejects(writeGeneratedFile(target, 'never', { ...ops, tempSuffix: () => allTaken.shift() }), (error) => error.code === 'EEXIST')
      assert.equal(await readFile(taken, 'utf8'), 'someone else')
      assert.equal(await readFile(target, 'utf8'), '<html>written</html>')
      for (const p of [target, taken, linkedTemp]) await rm(p)
    }

    // A burst of writes to one file: at most one waits behind the running write. Writes overtaken
    // before they started are never written; their callers settle when the write that replaced them
    // does, and the file then holds that newer content.
    {
      const burst = join(dir, 'burst-present.html')
      const real = await import('node:fs/promises')
      const written = []
      let release
      const gate = new Promise((resolve) => { release = resolve })
      const ops = { writeFile: async (p, data) => { written.push(String(data)); if (String(data) === 'v0') await gate; await real.writeFile(p, data) }, rename: real.rename, unlink: real.unlink }
      const settledWith = []
      const calls = ['v0', 'v1', 'v2', 'v3'].map((v) => writeGeneratedFile(burst, v, ops).then(async () => { settledWith.push(`${v}:${await readFile(burst, 'utf8')}`) }))
      await wait(10)
      assert.deepEqual(written, ['v0'], 'only the running write has started')
      release()
      await Promise.all(calls)
      assert.deepEqual(written, ['v0', 'v3'], 'v1 and v2 were displaced by v3 and never written')
      assert.equal(await readFile(burst, 'utf8'), 'v3')
      assert.deepEqual(settledWith.slice(1).sort(), ['v1:v3', 'v2:v3', 'v3:v3'], 'displaced callers settle once the newer content is in the file')
      // A displaced caller shares the failure of the write that replaced it.
      let releaseB
      const gateB = new Promise((resolve) => { releaseB = resolve })
      const opsB = { writeFile: async (p, data) => { if (String(data) === 'w0') await gateB; if (String(data) === 'w2') throw new Error('disk full'); await real.writeFile(p, data) }, rename: real.rename, unlink: real.unlink }
      const w0 = writeGeneratedFile(burst, 'w0', opsB)
      const w1 = writeGeneratedFile(burst, 'w1', opsB)
      const w2 = writeGeneratedFile(burst, 'w2', opsB)
      releaseB()
      await w0
      await assert.rejects(w1, /disk full/)
      await assert.rejects(w2, /disk full/)
      assert.equal(await readFile(burst, 'utf8'), 'w0', 'the failed write left the previous file whole')
      await rm(burst)
    }

    // A write that dies half-way: half the bytes reach the temporary file, then the disk fails.
    const real = await import('node:fs/promises')
    const failingWrite = {
      writeFile: async (p, data) => { await real.writeFile(p, String(data).slice(0, 5)); throw new Error('disk full') },
      rename: real.rename,
      unlink: real.unlink,
    }
    await assert.rejects(writeGeneratedFile(path, '<html>third, never whole</html>', failingWrite), /disk full/)
    assert.equal(await readFile(path, 'utf8'), '<html>second</html>', 'a failed write leaves the previous file whole')
    assert.deepEqual(await readdir(dir), ['talk-present.html'], 'and no temporary file behind')

    // The rename fails (the target became a folder): no partial file at the target, temp removed.
    const blocked = join(dir, 'blocked-present.html')
    await mkdir(join(blocked, 'inside'), { recursive: true })
    await assert.rejects(writeGeneratedFile(blocked, '<html>x</html>'))
    assert.deepEqual((await readdir(dir)).sort(), ['blocked-present.html', 'talk-present.html'], 'a failed rename leaves no temporary file')

    // While a write is under way the real name only ever holds a whole document.
    const big = '<html>' + 'x'.repeat(8 * 1024 * 1024) + '</html>'
    let seen = new Set()
    const watching = (async () => {
      for (let i = 0; i < 200; i++) {
        try { const text = await readFile(path, 'utf8'); seen.add(text === big ? 'big' : text === '<html>second</html>' ? 'old' : 'partial') } catch { seen.add('missing') }
      }
    })()
    await writeGeneratedFile(path, big)
    await watching
    assert.ok(!seen.has('partial') && !seen.has('missing'), `a reader sees the old or the new file, never part of one (saw ${[...seen].join(', ')})`)
  }
  console.log('main offload: all checks passed')
} finally {
  await rm(base, { recursive: true, force: true })
}
