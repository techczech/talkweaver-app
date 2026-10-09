// 0.38 ticket 10 — "A talk cannot pull a file from outside its vault into published output" (ADR-0036).
// The compiler side, through `prepareSource`, for every kind of file a talk can name: image, video,
// audio, the title logo, a video's poster, and a local [Embed:] / [Simulation:] page.
//
//  1. A reference that lands outside the allowed roots (.., absolute, a file link, a folder link,
//     percent-encoded ..) puts NOTHING of the outside file in the output: every output file is
//     searched for the file's marker, raw and base64-encoded at every alignment, `assets/` included.
//     The `asset-outside-vault` warning names the reference as written and never the folder it
//     resolved to; the written path is not left in the page for a deck window to load.
//  2. The same kind of reference pointing inside compiles to exactly the bytes of the file, and
//     supplying the vault as the allowed root changes nothing about it.
//  3. With no roots supplied the talk's own folder is the only one. Pooled `_assets` media (an
//     absolute path at the vault root) works when the vault is supplied and is refused when it is not.
//  4. Every main-process compile supplies the roots: the function they share picks the talk's vault,
//     and no `prepareSource` call in the main process is left without them.
import { strict as assert } from 'node:assert'
import { mkdtemp, mkdir, writeFile, readFile, readdir, symlink, copyFile, realpath, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { pathToFileURL } from 'node:url'

const lib = (name) => pathToFileURL(join(process.cwd(), 'compiler/scripts/lib', name)).href
const { prepareSource, EMBED_PAGE_POLICY } = await import(lib('08-source-adapters.mjs'))
const { embedAgentSource } = await import(pathToFileURL(join(process.cwd(), 'compiler/assets/runtime/embed-agent.js')).href)
const { extractSlides } = await import(lib('04-html-extraction.mjs'))
const { remoteReferenceUrl } = await import(lib('asset-containment.mjs'))
const { formatWarning, WARNING_REGISTRY } = await import(lib('warning-registry.mjs'))
const { resolveImageRefs } = await import(pathToFileURL(join(process.cwd(), 'src/main/image-refs.ts')).href)
const { assetRootsForTalk, talkVaultRoot } = await import(pathToFileURL(join(process.cwd(), 'src/main/asset-roots.ts')).href)
const { resolveInVaults } = await import(pathToFileURL(join(process.cwd(), 'src/main/vault-registry.ts')).href)
const { buildSharedTalkPayload } = await import(pathToFileURL(join(process.cwd(), 'src/main/shared-talk-build.ts')).href)

const fsSync = await import('node:fs')
let failures = 0
const check = async (name, fn) => {
  try { await fn(); console.log(`ok   ${name}`) } catch (error) { failures++; console.error(`FAIL ${name}\n     ${error?.message ?? error}`) }
}

// ── The tree ────────────────────────────────────────────────────────────────────────────────────
// <base>/vault/talk/         the talk and its own media
// <base>/vault/_assets/      pooled media, at the vault root
// <base>/outside/            the files a talk must never reach, each carrying its own marker
const base = await mkdtemp(join(tmpdir(), 'tw-media-inside-vault-'))
const realBase = await realpath(base)
const vault = join(base, 'vault')
const talk = join(vault, 'talk')
const outside = join(base, 'outside')
await mkdir(talk, { recursive: true })
await mkdir(join(vault, '_assets'), { recursive: true })
await mkdir(outside, { recursive: true })

const marker = (kind) => `TW-OUTSIDE-${kind.toUpperCase()}-${randomBytes(12).toString('hex')}`
// A real 1×1 PNG header so the image path reads dimensions as it does for any picture; the marker
// rides behind it. Other kinds are read as opaque bytes (or text, for the embed page).
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
const KINDS = {
  image: { ext: 'png', body: (text) => Buffer.concat([PNG_1X1, Buffer.from(text)]), write: (ref) => ({ body: `![A picture](${ref})` }), mime: 'image/png' },
  video: { ext: 'mp4', body: (text) => Buffer.from(`\0\0\0\x18ftypmp42${text}`, 'latin1'), write: (ref) => ({ body: `![A clip](${ref})` }), mime: 'video/mp4' },
  audio: { ext: 'mp3', body: (text) => Buffer.from(`ID3\x03\0\0${text}`, 'latin1'), write: (ref) => ({ body: `![A sound](${ref})` }), mime: 'audio/mpeg' },
  logo: { ext: 'svg', body: (text) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><title>${text}</title></svg>`), write: (ref) => ({ frontmatter: `logo: ${ref}`, body: 'Body.' }), mime: 'image/svg+xml' },
  embed: { ext: 'html', body: (text) => Buffer.from(`<!doctype html><title>${text}</title><p>${text}</p>`), write: (ref) => ({ body: `[Embed: ${ref}]` }) },
  simulation: { ext: 'html', body: (text) => Buffer.from(`<!doctype html><title>${text}</title><p>${text}</p>`), write: (ref) => ({ body: `[Simulation: ${ref}]` }) },
}
const secrets = {} // kind → { marker, bytes, path }
const insides = {} // kind → { marker, bytes, name }
for (const [kind, spec] of Object.entries(KINDS)) {
  const secretMarker = marker(kind)
  const secretBytes = spec.body(secretMarker)
  const secretPath = join(outside, `secret-${kind}.${spec.ext}`)
  await writeFile(secretPath, secretBytes)
  secrets[kind] = { marker: secretMarker, bytes: secretBytes, path: secretPath, name: `secret-${kind}.${spec.ext}` }
  const insideMarker = `TW-INSIDE-${kind.toUpperCase()}-${randomBytes(6).toString('hex')}`
  const insideBytes = spec.body(insideMarker)
  await writeFile(join(talk, `inside-${kind}.${spec.ext}`), insideBytes)
  insides[kind] = { marker: insideMarker, bytes: insideBytes, name: `inside-${kind}.${spec.ext}` }
  // A file link and (once) a folder link that leave the vault.
  await symlink(secretPath, join(talk, `link-out-${kind}.${spec.ext}`))
}
await symlink(outside, join(talk, 'dir-out'))

const outline = ({ frontmatter = '', body }) =>
  ['---', 'title: Containment', 'author: Someone Else', ...(frontmatter ? [frontmatter] : []), '---', '', '### A slide', '', body, ''].join('\n')

async function compile(source, options, name = 'talk-outline.md') {
  const outlinePath = join(talk, name)
  await writeFile(outlinePath, source)
  const model = await prepareSource(outlinePath, source, 'talk', undefined, {}, options ?? {})
  return model
}

// Everything a compile hands on, written out as the files a publish/share/backup would hold:
// the page, the model the app keeps (slides, rows' inputs, warnings) and every file in assets/.
async function writeOutput(model, label) {
  const dir = join(base, 'out', label)
  await mkdir(join(dir, 'assets'), { recursive: true })
  await writeFile(join(dir, 'index.html'), String(model.fullHtml ?? ''))
  await writeFile(join(dir, 'model.json'), JSON.stringify(model))
  for (const asset of model.assets ?? []) await copyFile(asset.absolute, join(dir, 'assets', asset.name))
  return dir
}
async function filesUnder(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...await filesUnder(full))
    else out.push(full)
  }
  return out
}
// The marker as it could appear: raw, or inside base64 at any of the three byte alignments (the
// first and last base64 characters of each alignment depend on the neighbouring bytes: dropped).
function needles(text) {
  const out = [Buffer.from(text)]
  for (let pad = 0; pad < 3; pad++) {
    const encoded = Buffer.concat([Buffer.alloc(pad), Buffer.from(text)]).toString('base64').replace(/=+$/, '')
    const head = pad === 0 ? 0 : pad === 1 ? 2 : 3
    out.push(Buffer.from(encoded.slice(head, encoded.length - 2)))
  }
  return out
}
async function assertNoTrace(dir, secret, label) {
  const files = await filesUnder(dir)
  assert.ok(files.length >= 2, `${label}: output was written`)
  for (const file of files) {
    const bytes = await readFile(file)
    for (const needle of needles(secret.marker)) {
      assert.equal(bytes.includes(needle), false, `${label}: ${file.slice(dir.length + 1)} carries the outside file's bytes`)
    }
    assert.equal(bytes.includes(Buffer.from(secret.bytes.toString('base64'))), false, `${label}: ${file.slice(dir.length + 1)} carries the outside file whole`)
  }
}
// Self-check of the search itself: it must find a marker that IS there, at each alignment.
await check('the search finds a marker that is inlined (raw and base64 at every alignment)', () => {
  const text = marker('probe')
  for (const prefix of ['', 'a', 'ab', 'abc', 'abcd']) {
    const page = Buffer.from(`<img src="data:image/png;base64,${Buffer.from(prefix + text + 'tail').toString('base64')}">`)
    assert.ok(needles(text).some((needle) => page.includes(needle)), `alignment ${prefix.length}`)
  }
  assert.ok(Buffer.from(`<p>${text}</p>`).includes(needles(text)[0]))
})

// The ways a reference can leave the vault, as written in the talk.
const attacks = (kind) => {
  const { name, path } = secrets[kind]
  const ext = KINDS[kind].ext
  return {
    'a .. path': `../../outside/${name}`,
    'an absolute path': path,
    'a file link that points out': `link-out-${kind}.${ext}`,
    'a folder link in the middle': `dir-out/${name}`,
    'percent-encoded ..': `%2e%2e%2f%2e%2e%2foutside%2f${name}`,
    'a percent-encoded absolute path': path.split('/').map(encodeURIComponent).join('%2f'),
  }
}
const outsideWarnings = (model) => model.warnings.filter((w) => w.startsWith('asset-outside-vault:'))

for (const kind of Object.keys(KINDS)) {
  for (const [how, ref] of Object.entries(attacks(kind))) {
    for (const [rootsLabel, options] of [['no roots given', {}], ['the vault given', { allowedAssetRoots: [vault] }]]) {
      await check(`${kind}: ${how} is refused (${rootsLabel})`, async () => {
        const model = await compile(outline(KINDS[kind].write(ref)), options)
        const dir = await writeOutput(model, `${kind}-${how.replace(/\W+/g, '-')}-${rootsLabel.replace(/\W+/g, '-')}`)
        await assertNoTrace(dir, secrets[kind], `${kind} / ${how}`)
        const raised = outsideWarnings(model)
        // One per slide that shows the file (the logo is on the title slide and the closing slide).
        assert.equal(raised.length, kind === 'logo' ? 2 : 1, `asset-outside-vault warnings: ${JSON.stringify(model.warnings)}`)
        // As written; an absolute path by its file name alone (a warning never spells out a folder on this Mac).
        const named = ref.startsWith('/') ? ref.slice(ref.lastIndexOf('/') + 1) : ref
        for (const warning of raised) assert.ok(warning.endsWith(`:${named}`), `the warning names the reference: ${warning}`)
        // …and nothing about where it resolved to: not this Mac's folders, in either spelling.
        for (const warning of model.warnings) {
          for (const leak of [realBase, ...(ref.includes('%2f') && ref.includes(encodeURIComponent(base.split('/')[1])) ? [] : [base]), ...(ref.includes('outside') ? [] : [outside, 'outside/'])]) {
            assert.equal(warning.includes(leak), false, `a warning shows a resolved path: ${warning}`)
          }
        }
        assert.equal(model.warnings.some((w) => /^missing-(asset|image):/.test(w)), false, 'refused, not reported as missing')
        assert.deepEqual(model.assets, [], 'nothing is handed on to be copied')
        assert.match(formatWarning(raised[0]), /outside the talk’s vault, so it was not included\./)
        // The written path is not left in the page as something a deck window could load.
        const html = String(model.fullHtml)
        for (const attr of [`src="${ref}"`, `data-src="${ref}"`, `poster="${ref}"`, `href="${ref}"`]) {
          assert.equal(html.includes(attr), false, `the page still points at the outside file: ${attr}`)
        }
      })
    }
  }
}

await check('a video whose sibling poster is a link out of the vault gets no poster', async () => {
  await symlink(secrets.image.path, join(talk, 'inside-video.png'))
  try {
    const model = await compile(outline({ body: '![A clip](inside-video.mp4)' }), { allowedAssetRoots: [vault] })
    await assertNoTrace(await writeOutput(model, 'poster-link-out'), secrets.image, 'poster')
    assert.ok(String(model.fullHtml).includes(insides.video.bytes.toString('base64')), 'the video itself, which is inside, is still included')
    assert.equal(String(model.fullHtml).includes(' poster="data:image/png'), false)
  } finally { await rm(join(talk, 'inside-video.png')) }
})

await check('a video kept as an asset (too big to inline) is refused the same way, and copied when inside', async () => {
  const big = { videoInlineLimitBytes: 1, allowedAssetRoots: [vault] }
  const refusedModel = await compile(outline({ body: `![A clip](../../outside/${secrets.video.name})\n\n![A sound](${secrets.audio.path})` }), big)
  const dir = await writeOutput(refusedModel, 'asset-only-outside')
  await assertNoTrace(dir, secrets.video, 'asset-only video')
  await assertNoTrace(dir, secrets.audio, 'asset-only audio')
  assert.deepEqual(refusedModel.assets, [])
  assert.equal(outsideWarnings(refusedModel).length, 2)
  const kept = await compile(outline({ body: '![A clip](inside-video.mp4)\n\n![A sound](inside-audio.mp3)' }), big)
  assert.deepEqual(kept.assets.map((a) => a.name).sort(), ['inside-audio.mp3', 'inside-video.mp4'])
  for (const asset of kept.assets) assert.ok(asset.absolute.startsWith(join(realBase, 'vault') + '/'), 'what is copied is the checked file, inside the vault')
})

await check('an image past the deck media budget is refused the same way', async () => {
  const model = await compile(outline({ body: `![A picture](${secrets.image.path})` }), { mediaInlineBudgetBytes: 1, allowedAssetRoots: [vault] })
  await assertNoTrace(await writeOutput(model, 'budget-outside'), secrets.image, 'budgeted image')
  assert.deepEqual(model.assets, [])
  assert.equal(outsideWarnings(model).length, 1)
})

await check('an outside picture is never opened: the rows\' picture key does not depend on its bytes', async () => {
  const source = outline({ body: `![A picture](${secrets.image.path})` })
  const before = await compile(source, { projectionsOnly: true, allowedAssetRoots: [vault] })
  await writeFile(secrets.image.path, Buffer.concat([secrets.image.bytes, Buffer.from('changed')]))
  const after = await compile(source, { projectionsOnly: true, allowedAssetRoots: [vault] })
  await writeFile(secrets.image.path, secrets.image.bytes)
  assert.deepEqual(after.pictureKeys, before.pictureKeys)
  // …while an inside picture's key does follow its bytes (the check above is not vacuous).
  const insideSource = outline({ body: '![A picture](inside-image.png)' })
  const one = await compile(insideSource, { projectionsOnly: true })
  await writeFile(join(talk, 'inside-image.png'), Buffer.concat([insides.image.bytes, Buffer.from('changed')]))
  const two = await compile(insideSource, { projectionsOnly: true })
  await writeFile(join(talk, 'inside-image.png'), insides.image.bytes)
  assert.notDeepEqual(two.pictureKeys, one.pictureKeys)
})

await check('remote and data: references are untouched, and a file: URL is not followed', async () => {
  const dataUri = `data:image/png;base64,${PNG_1X1.toString('base64')}`
  const model = await compile(outline({ body: `![Remote](https://example.org/picture.png)\n\n![Inline](${dataUri})\n\n![File URL](file://${secrets.image.path})` }), { allowedAssetRoots: [vault] })
  const html = String(model.fullHtml)
  assert.ok(html.includes('src="https://example.org/picture.png"'))
  assert.ok(html.includes(`src="${dataUri}"`))
  await assertNoTrace(await writeOutput(model, 'file-url'), secrets.image, 'file: URL')
  // A file: URL is read as a relative name under the talk's folder, which is not there: missing.
  assert.deepEqual(model.warnings.filter((w) => /^(missing-image|asset-outside-vault):/.test(w)).map((w) => w.split(':')[0]), ['missing-image'], JSON.stringify(model.warnings))
})

// ── 2. Inside: exactly the file's bytes, with or without the vault supplied ───────────────────
for (const kind of Object.keys(KINDS)) {
  await check(`${kind}: the same reference pointing inside is included, byte for byte, whatever roots are given`, async () => {
    const source = outline(KINDS[kind].write(insides[kind].name))
    const byDefault = await compile(source, {})
    const withVault = await compile(source, { allowedAssetRoots: [vault] })
    const withTalkFolder = await compile(source, { allowedAssetRoots: [talk] })
    assert.equal(withVault.fullHtml, byDefault.fullHtml, 'supplying the vault changes nothing')
    assert.equal(withTalkFolder.fullHtml, byDefault.fullHtml)
    assert.deepEqual(withVault.warnings, byDefault.warnings)
    assert.equal(byDefault.warnings.some((w) => /^(asset-outside-vault|missing-asset|missing-image)/.test(w)), false, JSON.stringify(byDefault.warnings))
    const html = String(byDefault.fullHtml)
    if (KINDS[kind].mime) {
      assert.ok(html.includes(`data:${KINDS[kind].mime};base64,${insides[kind].bytes.toString('base64')}`), 'the data URI is the file, verbatim')
    } else {
      assert.ok(html.includes(insides[kind].marker), 'the page is inlined')
      assert.equal(html.includes('slide-embed-missing'), false)
    }
  })
}

await check('a link that stays inside the vault is followed; a percent-encoded name with a space still resolves', async () => {
  await writeFile(join(talk, 'Pasted image.png'), insides.image.bytes)
  await symlink(join(talk, 'inside-image.png'), join(talk, 'link-in.png'))
  const model = await compile(outline({ body: '![Linked](link-in.png)\n\n![Spaced](Pasted%20image.png)' }), {})
  assert.equal(model.warnings.some((w) => /^(asset-outside-vault|missing-image)/.test(w)), false, JSON.stringify(model.warnings))
  const uri = `data:image/png;base64,${insides.image.bytes.toString('base64')}`
  assert.equal(String(model.fullHtml).split(uri).length - 1 >= 2, true)
})

await check('a file that is simply not there is still reported as "missing", and its address is emptied too', async () => {
  const model = await compile(outline({ body: '![Gone](assets/gone.png)\n\n![Gone clip](assets/gone.mp4)\n\n![Gone sound](assets/gone.mp3)\n\n[Embed: gone.html]' }), {})
  assert.deepEqual(model.warnings.filter((w) => /^(missing|asset-outside)/.test(w)).sort(),
    ['missing-asset:a-slide:assets/gone.mp3', 'missing-asset:a-slide:assets/gone.mp4', 'missing-asset:a-slide:gone.html', 'missing-image:a-slide:assets/gone.png'])
  const html = String(model.fullHtml)
  for (const gone of ['"assets/gone.png"', '"assets/gone.mp4"', '"assets/gone.mp3"', '"gone.html"']) assert.equal(html.includes(gone), false, `${gone} is left in an attribute`)
  assert.ok(html.includes('Missing embed: gone.html'), 'the embed placeholder still names the file, as text')
})

// ── 3. The default, and pooled media ─────────────────────────────────────────────────────────
const pooled = { id: 'img-abc1234', bytes: Buffer.concat([PNG_1X1, Buffer.from('TW-POOLED-' + randomBytes(6).toString('hex'))]) }
await writeFile(join(vault, '_assets', `${pooled.id}.png`), pooled.bytes)
const pooledUri = `data:image/png;base64,${pooled.bytes.toString('base64')}`
const pooledSource = outline({ body: `![Pooled](${pooled.id})` })

await check('with no roots supplied the talk\'s own folder is the only one', async () => {
  await mkdir(join(vault, 'other-talk'), { recursive: true })
  await writeFile(join(vault, 'other-talk', 'neighbour.png'), insides.image.bytes)
  const source = outline({ body: '![Neighbour](../other-talk/neighbour.png)' })
  const byDefault = await compile(source, {})
  assert.equal(outsideWarnings(byDefault).length, 1, 'a sibling talk\'s folder is outside the talk\'s own folder')
  assert.equal(String(byDefault.fullHtml).includes(insides.image.bytes.toString('base64')), false)
  const withVault = await compile(source, { allowedAssetRoots: [vault] })
  assert.equal(outsideWarnings(withVault).length, 0, 'and inside the vault')
  assert.ok(String(withVault.fullHtml).includes(insides.image.bytes.toString('base64')))
  const noneAllowed = await compile(outline({ body: '![Own](inside-image.png)' }), { allowedAssetRoots: [] })
  assert.equal(outsideWarnings(noneAllowed).length, 1, 'an empty list allows nothing: it is not "use the default"')
})

await check('a pooled _assets reference works when the vault root is supplied and is refused when it is not', async () => {
  const resolved = resolveImageRefs(pooledSource, vault)
  assert.ok(resolved.includes(`](${join(vault, '_assets', pooled.id + '.png')})`), 'the app rewrites the pooled id to an absolute path at the vault root')
  const withVault = await compile(resolved, { allowedAssetRoots: [vault] })
  assert.ok(String(withVault.fullHtml).includes(pooledUri))
  assert.deepEqual(withVault.warnings.filter((w) => /^(asset-outside-vault|missing-image)/.test(w)), [])
  const byDefault = await compile(resolved, {})
  assert.equal(String(byDefault.fullHtml).includes(pooled.bytes.toString('base64')), false)
  assert.equal(outsideWarnings(byDefault).length, 1)
})

// ── 4. The main process supplies the roots on every compile ─────────────────────────────────
const vaults = { resolve: (path) => resolveInVaults([{ id: 'v1', root: vault, open: true, order: 0, name: 'Vault' }], path) }

await check('the roots every main-process compile passes: the talk\'s vault, else its own folder', async () => {
  const outlinePath = join(talk, 'talk-outline.md')
  assert.deepEqual(assetRootsForTalk(vaults, outlinePath), [vault])
  const loose = join(base, 'loose', 'loose-outline.md')
  assert.deepEqual(assetRootsForTalk(vaults, loose), [dirname(loose)], 'a talk in no vault is never given the current vault')
  assert.deepEqual(assetRootsForTalk(vaults, loose, [vault]), [dirname(loose), vault])
  assert.deepEqual(assetRootsForTalk({ resolve: () => null }, outlinePath), [talk])
  assert.deepEqual(assetRootsForTalk({ resolve: () => { throw new Error('registry unavailable') } }, outlinePath), [talk])
  assert.deepEqual(assetRootsForTalk({ resolve: () => ({ vault: { root: 'relative/vault' } }) }, outlinePath), [talk])
})

await check('a pooled image compiles through the roots the main process passes (the shared function + the real rewrite)', async () => {
  const outlinePath = join(talk, 'talk-outline.md')
  await writeFile(outlinePath, pooledSource)
  const options = { allowedAssetRoots: assetRootsForTalk(vaults, outlinePath) }
  for (const extra of [{}, { projectionsOnly: true }, { videoInlineLimitBytes: 0, mediaInlineBudgetBytes: 64 * 1024 * 1024, largeMediaMode: 'poster' }]) {
    const model = await prepareSource(outlinePath, resolveImageRefs(pooledSource, vault), 'talk', undefined, {}, { ...extra, ...options })
    assert.deepEqual(outsideWarnings(model), [], JSON.stringify(extra))
    if (!extra.projectionsOnly) assert.ok(String(model.fullHtml).includes(pooledUri), JSON.stringify(extra))
  }
  // The search rows (projectionsOnly) and the full compile must agree on the picture's identity.
  const full = await prepareSource(outlinePath, resolveImageRefs(pooledSource, vault), 'talk', undefined, {}, options)
  const rowsOnly = await prepareSource(outlinePath, resolveImageRefs(pooledSource, vault), 'talk', undefined, {}, { projectionsOnly: true, ...options })
  assert.deepEqual(rowsOnly.pictureKeys, full.pictureKeys)
})

await check('the shared-talk build: pooled media with the vault supplied, none of it without', async () => {
  const outlinePath = join(talk, 'talk-outline.md')
  await writeFile(outlinePath, pooledSource)
  const input = { compilerDir: join(process.cwd(), 'compiler/scripts'), outlinePath, content: pooledSource, compileContent: resolveImageRefs(pooledSource, vault), slug: 'talk', ownerName: 'Owner', proposals: false }
  const withVault = await buildSharedTalkPayload({ ...input, allowedAssetRoots: assetRootsForTalk(vaults, outlinePath) })
  assert.ok(withVault.html.includes(pooled.bytes.toString('base64')))
  const strict = await buildSharedTalkPayload(input)
  assert.equal(strict.html.includes(pooled.bytes.toString('base64')), false)
  const attack = outline({ body: `![A picture](${secrets.image.path})` })
  await writeFile(outlinePath, attack)
  const shared = await buildSharedTalkPayload({ ...input, content: attack, compileContent: attack, allowedAssetRoots: assetRootsForTalk(vaults, outlinePath) })
  for (const needle of needles(secrets.image.marker)) assert.equal(Buffer.from(shared.html).includes(needle), false, 'a shared talk never carries an outside file')
})

await check('no compile in the main process is left without allowed roots', () => {
  const calls = []
  for (const file of ['src/main/index.ts', 'src/main/shared-talk-build.ts', 'src/main/layout-variant-thumbnail.ts', 'src/main/thumbnails.ts', 'src/main/backup-sweep.mjs', 'src/main/run-prework.ts', 'src/main/talk-search.ts']) {
    const lines = readFileSync(join(process.cwd(), file), 'utf8').split('\n')
    lines.forEach((line, index) => {
      // A call (awaited or passed to the gate), not the import, a type or a comment.
      if (/(?:await |=> )prepareSource\(/.test(line) && !/^\s*(\/\/|\*)/.test(line)) calls.push({ file, line: index + 1, text: line.trim() })
    })
  }
  assert.ok(calls.length >= 12, `expected the main process's compiles, found ${calls.length}`)
  const without = calls.filter((call) => !/allowedAssetRoots|compileOptions/.test(call.text))
  assert.deepEqual(without, [], 'a prepareSource call with no allowedAssetRoots would lose pooled _assets media')
  const index = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')
  assert.match(index, /const compileOptions = \{ \.\.\.\(options \?\? \{\}\), allowedAssetRoots: assetRootsFor\(outlinePath\) \}/)
  assert.match(readFileSync(join(process.cwd(), 'src/main/shared-talk-build.ts'), 'utf8'), /const compileOptions = input\.allowedAssetRoots \? \{ allowedAssetRoots: input\.allowedAssetRoots \} : \{\}/)
  assert.match(index, /allowedAssetRoots: assetRootsFor\(outlinePath\),\n\s+\/\/ The talk's vault's personal author/)
})

// ── 5. The output property: no local address the compiler did not resolve ────────────────────
// Every attribute of a compiled slide that a browser loads from must hold one of four things: a
// data: URI, `assets/<name>` for a file in the assets list, an http(s) URL, or nothing.
const LOADED_ATTRS = ['src', 'poster', 'data-src', 'data-embed-url', 'data-lazy-src', 'data-lazy-poster', 'srcset', 'data', 'action', 'background']
const unescapeAttr = (text) => text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
function addressesIn(html, names = LOADED_ATTRS) {
  const found = []
  // The inlined embed document is the page's own content, under its own policy and in a sandboxed
  // frame (data-embed-doc since ticket 11; srcdoc before it): taken out first.
  const withoutSrcdoc = html.replace(/\s(?:srcdoc|data-embed-doc)="[^"]*"/g, ' ')
  for (const match of withoutSrcdoc.matchAll(/\s([a-zA-Z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    if (names.includes(match[1].toLowerCase())) found.push({ attr: match[1].toLowerCase(), value: unescapeAttr(match[2] ?? match[3] ?? match[4] ?? '') })
  }
  return found
}
function unresolvedAddresses(html, assets = []) {
  const assetPaths = new Set(assets.map((asset) => `assets/${asset.name}`))
  const slides = extractSlides(html).map((slide) => slide.html).join('\n')
  return addressesIn(slides).filter(({ value }) => {
    if (value === '' || /^data:/i.test(value) || assetPaths.has(value)) return false
    return !(remoteReferenceUrl(value) === value && /^https?:\/\//.test(value))
  })
}
await check('the address check itself: it sees a local address in every attribute and quoting it knows', () => {
  const page = '<!doctype html><html><body><section class="slide" id="s1"><img src="../x.png"><video poster=\'file:///p.png\' src=a\\b.mp4></video><iframe data-src="//h/x"></iframe><img src="https://example.org/a.png"><img src="data:image/png;base64,AA"><img src=""><img src="assets/kept.png"></section></body></html>'
  assert.equal(extractSlides(page).length, 1)
  assert.deepEqual(unresolvedAddresses(page, [{ name: 'kept.png' }]).map((a) => a.value), ['../x.png', 'file:///p.png', 'a\\b.mp4', '//h/x'])
})

// By the BROWSER's reading each of these names the outside file (or would, were it there).
const browserForms = (kind) => {
  const { path, name } = secrets[kind]
  return {
    'a file: URL': `file://${path}`,
    'a file: URL with one slash': `file:${path}`,
    'a file: URL naming localhost': `file://localhost${path}`,
    'FILE: in capitals': `FILE://${path}`,
    'a file: URL with a relative path': `file:../../outside/${name}`,
    'backslash traversal': `..\\..\\outside\\${name}`,
    'backslashes after a slash': `./..\\..\\outside/${name}`,
    'percent-encoded backslashes': `..%5c..%5coutside%5c${name}`,
    'percent-encoded dots': `%2e%2e/%2E%2e/outside/${name}`,
    'dots then a semicolon': `..;/..;/outside/${name}`,
    'a ../ path with a query': `../../outside/${name}?v=1`,
    'a ../ path with a fragment': `../../outside/${name}#t=1`,
    'an absolute path with a query': `${path}?v=1`,
    'an absolute path with a trailing %20': `${path}%20`,
    'a scheme-relative path': `//localhost${path}`,
    'a ../ path to a file that is not there': `../../outside/not-there.${KINDS[kind].ext}`,
    'an inside path that is not there': `assets/not-there.${KINDS[kind].ext}`,
    'a blob: URL': `blob:null/${name}`,
    'a filesystem: URL': `filesystem:file:///temporary/${name}`,
    'a javascript: URL': `javascript:fetch('file://${path}')`,
    'a data: URL of the wrong kind': 'data:text/html,<script>parent.document.title=1</script>',
    'an unknown extension': `../../outside/${name}.bmp`,
  }
}
for (const kind of Object.keys(KINDS)) {
  await check(`${kind}: whatever the spelling, the page holds no local address the compiler did not resolve`, async () => {
    const problems = []
    for (const [how, ref] of Object.entries(browserForms(kind))) {
      const model = await compile(outline(KINDS[kind].write(ref)), { allowedAssetRoots: [vault] })
      const html = String(model.fullHtml)
      const left = unresolvedAddresses(html, model.assets)
      if (left.length) problems.push(`${how}: ${JSON.stringify(left)}`)
      if (model.assets.length) problems.push(`${how}: something was handed on to be copied`)
      for (const needle of needles(secrets[kind].marker)) if (Buffer.from(html).includes(needle)) problems.push(`${how}: the outside file is in the page`)
      // Nothing of the reference survives in an attribute a browser loads from, in any slide.
      const slides = extractSlides(html).map((slide) => slide.html).join('\n')
      for (const { attr, value } of addressesIn(slides)) {
        if (/file:|\\|%5c|outside|blob:|filesystem:|javascript:|text\/html/i.test(value) && !/^data:(image|video|audio)\//i.test(value)) problems.push(`${how}: ${attr}=${JSON.stringify(value.slice(0, 80))}`)
      }
    }
    assert.deepEqual(problems, [])
  })
}

await check('the shared-talk page holds no unresolved local address either', async () => {
  const outlinePath = join(talk, 'talk-outline.md')
  const body = Object.entries(browserForms('image')).map(([, ref]) => `![A picture](${ref})`).join('\n\n')
    + `\n\n![A clip](file://${secrets.video.path})\n\n![A sound](..\\..\\outside\\${secrets.audio.name})\n\n[Embed: file://${secrets.embed.path}]`
  const source = outline({ frontmatter: `logo: file://${secrets.logo.path}`, body })
  await writeFile(outlinePath, source)
  const shared = await buildSharedTalkPayload({ compilerDir: join(process.cwd(), 'compiler/scripts'), outlinePath, content: source, compileContent: source, slug: 'talk', ownerName: 'Owner', proposals: false, allowedAssetRoots: [vault] })
  const left = addressesIn(shared.html).filter(({ value }) => /file:|\\|%5c|\.\.\/|outside/i.test(value) && !/^data:/i.test(value))
  assert.deepEqual(left, [])
  for (const kind of ['image', 'video', 'audio', 'logo', 'embed']) for (const needle of needles(secrets[kind].marker)) assert.equal(Buffer.from(shared.html).includes(needle), false, kind)
})

await check('remote is decided by parsing: only http and https, in any spelling a browser accepts', async () => {
  const model = await compile(outline({ body: [
    '![Plain](https://example.org/a.png)', '![Capitals](HTTPS://EXAMPLE.org/b.png)', '![No slashes](https:example.org/c.png)',
    '![Backslashes](http:\\\\example.org\\d.png)', '![Clip](https://example.org/e.mp4)', '![Sound](HTTP://example.org/f.mp3)', '[Embed: https://example.org/page]',
  ].join('\n\n') }), { allowedAssetRoots: [vault] })
  const html = String(model.fullHtml)
  assert.deepEqual(unresolvedAddresses(html, model.assets), [])
  for (const url of ['https://example.org/a.png', 'https://example.org/b.png', 'https://example.org/c.png', 'http://example.org/d.png', 'https://example.org/e.mp4', 'http://example.org/f.mp3']) {
    assert.ok(html.includes(`src="${url}"`), `${url} is emitted in its parsed form`)
  }
  assert.ok(html.includes('data-src="https://example.org/page"'))
  assert.equal(model.warnings.some((w) => /^(missing|asset-outside|unknown-image)/.test(w)), false, JSON.stringify(model.warnings))
})

// Links are followed on a click, never loaded by the page, and keep their own rule (isSafeLinkUrl:
// http, https, mailto, `#`, and paths starting `.` or `/`). What this pins: no link form turns a
// `file:` (or script) address into an href, the licence link included. A PATH written as a link
// target (`/Users/…`, `../x`) is still a link: that behaviour is pinned by the inline-render corpus
// and is reported to the coordinator rather than changed here.
await check('no link form emits a file: (or script) address, and no link is something the page loads', async () => {
  const target = `file://${secrets.image.path}`
  const model = await compile(outline({ frontmatter: `license: CC BY\nlicense-url: ${target}\nweb: ${target}\nhandout_url: ${target}`, body: [
    `Inline [a link](${target}) and <${target}> and bare ${target} and [ref][r] and [js](javascript:alert(1)) and [caps](FILE://${secrets.image.path}).`, '', `[r]: ${target}`, '',
    `- [in a list](${target})`, '', `> [in a quote](${target})`, '',
    '[beside](./notes.html) [anchor](#a-slide) [web](https://example.org/page) [mail](mailto:someone@example.org)',
  ].join('\n') }), { allowedAssetRoots: [vault] })
  const html = String(model.fullHtml)
  // Every href in the whole page (slides, title poster, licence, chrome), not only in slides.
  const hrefs = addressesIn(html.replace(/<script[\s\S]*?<\/script>/g, ''), ['href']).map((a) => a.value)
  assert.deepEqual(hrefs.filter((href) => !/^(https?:|mailto:|#|\.\/|data:,$)/i.test(href)), [], JSON.stringify(hrefs))
  for (const kept of ['./notes.html', '#a-slide', 'https://example.org/page', 'mailto:someone@example.org']) assert.ok(hrefs.includes(kept), `${kept} is still a link: ${JSON.stringify(hrefs)}`)
  assert.equal(html.includes(`href="${target}"`), false)
  assert.deepEqual(unresolvedAddresses(html, model.assets), [])
})

await check('an inlined embed page carries its policy before anything the page wrote', async () => {
  const cases = {
    'doctype.html': ['<!DOCTYPE html>\n<html><head><title>x</title></head><body>one</body></html>', '<!DOCTYPE html>'],
    'no-doctype.html': ['<html><head><title>x</title></head><body>two</body></html>', ''],
    'comment-first.html': ['<!-- <!doctype html><head> --><script>window.early = 1</script><p>three</p>', ''],
    'bare.html': ['<p>four</p>', ''],
  }
  for (const [name, [page, lead]] of Object.entries(cases)) {
    await writeFile(join(talk, name), page)
    const model = await compile(outline({ body: `[Embed: ${name}]` }), { allowedAssetRoots: [vault] })
    const slide = extractSlides(String(model.fullHtml)).map((entry) => entry.html).join('\n')
    const srcdoc = unescapeAttr(slide.match(/\sdata-embed-doc="([^"]*)"/)[1])
    const meta = `<meta http-equiv="Content-Security-Policy" content="${EMBED_PAGE_POLICY}">`
    // The policy is first, then the rest of the lead (referrer, base, the agent); nothing the page
    // wrote comes before any of it, and the page follows unchanged.
    const rest = '<meta name="referrer" content="no-referrer"><base href="about:srcdoc"><script>' + embedAgentSource() + '</script>'
    assert.equal(srcdoc, lead + meta + rest + page.slice(lead.length), name)
    assert.equal(srcdoc.indexOf(meta), lead.length, `${name}: the policy is the first element`)
    // The document is in an inert attribute of a sandboxed frame that loads nothing by itself.
    const frame = slide.match(/<iframe\b[^>]*>/)[0]
    assert.match(frame, /^<iframe data-embed-doc="[^"]*" sandbox="allow-scripts allow-forms" credentialless referrerpolicy="no-referrer" /, name)
    assert.equal(/\s(?:src|srcdoc|data-src)=/.test(frame), false, `${name}: no src, no srcdoc`)
  }
  // A page that is missing, or outside the allowed folders, has no frame and no document at all.
  for (const body of ['[Embed: not-there.html]', `[Embed: ${secrets.embed.path}]`, '[Simulation: ../../outside/secret.html]']) {
    const model = await compile(outline({ body }), { allowedAssetRoots: [vault] })
    const slide = extractSlides(String(model.fullHtml)).map((entry) => entry.html).join('\n')
    assert.ok(slide.includes('slide-embed-missing'), body)
    assert.equal(/data-embed-doc|<iframe\b|srcdoc=/.test(slide), false, `${body}: no frame, no document`)
  }
  assert.equal(/'self'|file:|\*/.test(EMBED_PAGE_POLICY), false, 'the policy names no local source')
  assert.match(EMBED_PAGE_POLICY, /^default-src /)
})

await check('a pooled name that is a link out of the vault compiles the same whether or not its target exists', async () => {
  const linkTarget = join(outside, 'pooled-target.png')
  const pooledLink = { id: 'img-0000abc' }
  await symlink(linkTarget, join(vault, '_assets', `${pooledLink.id}.png`))
  const source = outline({ body: `![Pooled link](${pooledLink.id})` })
  const run = async () => {
    const resolved = resolveImageRefs(source, vault)
    const model = await compile(resolved, { allowedAssetRoots: [vault] })
    return { resolved, html: String(model.fullHtml), warnings: model.warnings, keys: model.pictureKeys, assets: model.assets }
  }
  const absent = await run()
  await writeFile(linkTarget, Buffer.concat([PNG_1X1, Buffer.from(secrets.image.marker)]))
  const present = await run()
  assert.equal(present.resolved, absent.resolved, 'the rewrite does not look through the link')
  assert.equal(present.html, absent.html, 'the compiled page is byte-identical')
  assert.deepEqual(present.warnings, absent.warnings)
  assert.deepEqual(present.keys, absent.keys)
  assert.deepEqual(present.warnings.filter((w) => /^(asset-outside-vault|missing|unknown-image)/.test(w)), [`asset-outside-vault:a-slide:_assets/${pooledLink.id}.png`], 'refused as outside, named without the vault\'s location')
  for (const warning of present.warnings) assert.equal(warning.includes(base) || warning.includes(realBase), false, warning)
  for (const needle of needles(secrets.image.marker)) assert.equal(Buffer.from(present.html).includes(needle), false)
  assert.deepEqual(unresolvedAddresses(present.html, present.assets), [])
})

// ── 5b. Nested shapes ────────────────────────────────────────────────────────────────────────
// A picture is not always a slide's own block: it sits in a card, a grid cell, a compare half, a
// carousel step, a claim, a quote, a pre-work step. Each shape below is compiled twice: with the
// picture inside the vault (it must be INLINED, which proves the fixture really carries a picture
// through that shape) and outside (nothing of it in any output, the warning raised, no address left).
//
// Two layers resolve these. The visitor has a branch for the containers it knows (`cards`,
// `image-grid`, `image-claim`, `image-quote`, `cta-screenshots`, carousel steps); pass 2 (the sweep)
// walks every slide whole and resolves whatever the visitor did not reach. `{compare}` is the shape
// with NO visitor branch — its pictures sit in `compare.halves[].blocks` — so its two rows are the
// standing proof that the sweep works on its own. `{contrast}` and `{cards=grid}` go through the
// `cards` branch; with that branch deleted the sweep still resolves them (mutation check in the
// ticket report: branch removed → green; branch and sweep removed → red).
const twoGroups = (token) => [`### Nested ${token}`, '', '#### One', '', '![a](REF)', '', 'Text one.', '', '#### Two', '', '![b](REF)', '', 'Text two.']
const NESTED = {
  'cards ({cards} with #### cards)': { lines: twoGroups('{cards}'), pictures: 2 },
  'bare #### cards': { lines: ['### Nested', '', '#### One', '', '![a](REF)', '', '#### Two', '', 'Text.'], pictures: 1 },
  'carousel sub-slides ({carousel})': { lines: twoGroups('{carousel}'), pictures: 2 },
  'a section carousel': { lines: ['## Section {carousel}', '', '### One', '', '![a](REF)', '', '### Two', '', 'Text.'], pictures: 1 },
  'columns ({columns})': { lines: ['### Nested {columns}', '', '#### Left', '', '![a](REF)', '', '#### Right', '', '- item'], pictures: 1 },
  'compare halves ({compare}): the sweep alone': { lines: twoGroups('{compare}'), pictures: 2 },
  'contrast ({contrast}): the cards branch': { lines: twoGroups('{contrast}'), pictures: 2 },
  'a static cards grid ({cards=grid}): the cards branch': { lines: twoGroups('{cards=grid}'), pictures: 2 },
  'image-grid cells': { lines: ['### Nested {image-grid}', '', '![a](REF)', '', '![b](REF)'], pictures: 2 },
  'image-grid cells from #### cards': { lines: twoGroups('{image-grid}'), pictures: 2 },
  'an image row': { lines: ['### Nested', '', '![a](REF)', '', '![b](REF)', '', '![c](REF)'], pictures: 3 },
  'image + claim ({image-claim})': { lines: ['### Nested {image-claim}', '', '![a](REF)', '', '- one', '- two'], pictures: 1 },
  'copy + visual': { lines: ['### Nested', '', '![a](REF)', '', 'A paragraph of copy beside the picture.'], pictures: 1 },
  'image + quote ({image-quote})': { lines: ['### Nested {image-quote}', '', '![a](REF)', '', '> A quote.', '', '- Someone'], pictures: 1 },
  'CTA + screenshots ({cta-screenshots})': { lines: ['### Nested {cta-screenshots}', '', '![a](REF)', '', '- Bring one', '- [Action: Go → https://example.com]'], pictures: 1 },
  'a pre-work step': { lines: ['## Before', '{prework}', '', 'Intro.', '', '### Welcome', '{noask}', '', '![a](REF)', '', '- Read', '', '## Talk', '', '### Slide', '', 'Body.'], pictures: 1 },
  // Not media at all: inside a list item, a table cell or a quotation the image syntax is inline
  // text (it renders as a link under the link rule), so there is no picture, no read and no warning.
  'inside a list item (inline text, not media)': { lines: ['### Nested', '', '- ![a](REF)', '- text ![b](REF) more'], pictures: 0 },
  'inside a table cell (inline text, not media)': { lines: ['### Nested', '', '| A | B |', '| --- | --- |', '| ![a](REF) | x |'], pictures: 0 },
  'inside a quotation (inline text, not media)': { lines: ['### Nested', '', '> ![a](REF)'], pictures: 0 },
}
// Every slide of the layout sampler that shows a picture, with its pictures pointed at REF: the
// shapes above are hand-written; this is every layout the app documents, as it is authored.
const samplerText = readFileSync(join(process.cwd(), 'docs/layout-sampler-outline.md'), 'utf8').replace(/^---[\s\S]*?\n---\n/, '')
const samplerSlides = samplerText.split(/\n(?=### )/).filter((part) => /!\[[^\]]*\]\(assets\/[^)\s]+\.(png|webp|jpe?g|svg)/.test(part))
samplerSlides.forEach((part, i) => {
  const pictures = (part.match(/!\[[^\]]*\]\(assets\/[^)\s]+\.(png|webp|jpe?g|svg)/g) || []).length
  NESTED[`sampler slide ${i + 1}: ${part.split('\n')[0].slice(4, 60)}`] = { lines: part.replace(/(!\[[^\]]*\]\()assets\/[^)\s]+\.(?:png|webp|jpe?g|svg)/g, '$1REF').split('\n'), pictures, sampler: true }
})
await check('the sampler supplies its picture slides (the nested table is not hand-written alone)', () => {
  assert.ok(samplerSlides.length >= 15, `picture slides found in the sampler: ${samplerSlides.length}`)
})
const insidePictureUri = () => `data:image/png;base64,${insides.image.bytes.toString('base64')}`
for (const [shape, spec] of Object.entries(NESTED)) {
  await check(`nested — ${shape}: an outside picture never reaches the output`, async () => {
    const deck = (ref) => ['---', 'title: Nested', '---', '', ...spec.lines, ''].join('\n').replaceAll('REF', ref)
    // Inside: the picture is inlined, once per place it is shown at least.
    const inside = await compile(deck('inside-image.png'), { allowedAssetRoots: [vault] })
    const inlined = String(inside.fullHtml).split(insidePictureUri()).length - 1
    if (spec.pictures) assert.ok(inlined >= spec.pictures, `the inside picture is inlined ${inlined} time(s), expected at least ${spec.pictures}`)
    else assert.equal(inlined, 0, 'not media in this place')
    assert.deepEqual(outsideWarnings(inside), [])
    assert.deepEqual(unresolvedAddresses(String(inside.fullHtml), inside.assets), [])
    // Outside, in the two spellings a compiler and a browser read differently.
    for (const ref of [`../../outside/${secrets.image.name}`, secrets.image.path, `file://${secrets.image.path}`]) {
      const model = await compile(deck(ref), { allowedAssetRoots: [vault] })
      const dir = await writeOutput(model, `nested-${Object.keys(NESTED).indexOf(shape)}-${ref.length}`)
      await assertNoTrace(dir, secrets.image, shape)
      assert.deepEqual(model.assets, [])
      assert.deepEqual(unresolvedAddresses(String(model.fullHtml), model.assets), [], 'no address is left for a browser to load')
      const raised = model.warnings.filter((w) => /^(asset-outside-vault|missing-image):/.test(w)).length
      if (spec.pictures) assert.ok(raised >= spec.pictures, `${ref}: ${raised} warning(s) for ${spec.pictures} picture(s): ${JSON.stringify(model.warnings)}`)
      else assert.equal(raised, 0)
      if (spec.pictures && !ref.startsWith('file:')) assert.ok(outsideWarnings(model).length >= spec.pictures, 'refused as outside the vault')
    }
  })
}

// ── 5c. A source project (a folder with presentation.structure.json) ─────────────────────────
// This path renders each slide's Markdown through the plain paragraph/list renderer and never
// through the media visitor. Pinned here: it emits NO picture, player or frame from project
// content. An image line becomes a link (the link rule applies: a `file:` target is `#`), an
// [Embed:] line stays text, raw HTML is escaped; nothing is read except the slide sources, which
// are contained. So the output property holds on this path because it has no media at all.
await check('a source project emits no media address from its content, and its slide sources are contained', async () => {
  const project = join(vault, 'project')
  await mkdir(project, { recursive: true })
  await writeFile(join(outside, 'slide.md'), `# Outside\n\n${secrets.embed.marker}\n`)
  await writeFile(join(project, 'presentation.structure.json'), JSON.stringify({ title: 'P', logo: secrets.logo.path, slides: [
    { id: 's1', source: 's1.md', image: secrets.image.path }, { id: 's2', source: '../../outside/slide.md' }, { id: 's3', source: join(outside, 'slide.md') },
  ] }))
  await writeFile(join(project, 's1.md'), ['---', 'title: One', `image: ${secrets.image.path}`, `logo: ${secrets.logo.path}`, '---', '# One', '',
    `![pic](${secrets.image.path})`, '', `Text [link](file://${secrets.image.path}) and ![inline](../../outside/${secrets.image.name})`, '',
    `- item ![li](file://${secrets.image.path})`, '', `[Embed: ${secrets.embed.path}]`, '', `<img src="${secrets.image.path}">`, '', `![video](${secrets.video.path})`, ''].join('\n'))
  const { statSync } = fsSync
  const model = await prepareSource(project, '', 'P', statSync(project))
  const html = String(model.fullHtml)
  const slides = extractSlides(html).map((slide) => slide.html).join('\n')
  assert.ok(slides.includes('One'), 'the contained slide is rendered')
  assert.ok(slides.includes('&lt;img src=&quot;'), 'raw HTML is escaped text')
  assert.deepEqual(addressesIn(slides.replace(/&lt;[\s\S]*?&gt;/g, '')), [], 'no src, poster, data-src, srcdoc or data-embed-doc comes from project content')
  assert.equal(/<(img|video|audio|iframe|source|object|embed)\b/i.test(slides), false, 'no media element at all')
  assert.equal(addressesIn(slides, ['href']).some((a) => /^\s*file:/i.test(a.value)), false, 'a file: link target is not a link')
  for (const kind of ['image', 'logo', 'embed', 'video']) for (const needle of needles(secrets[kind].marker)) assert.equal(Buffer.from(html).includes(needle), false, `${kind}: outside bytes in the page`)
  assert.deepEqual(model.warnings.filter((w) => w.startsWith('asset-outside-vault:')), ['asset-outside-vault:s2:../../outside/slide.md', `asset-outside-vault:s3:${join(outside, 'slide.md')}`].map((w) => w.replace(join(outside, 'slide.md'), 'slide.md')))
})

// ── 5d. A reference's TEXT in output never spells out a folder ───────────────────────────────
// Refusing to read a file is not enough if the page then prints where it was: the "Missing embed"
// line, the phone text view (the twSlideScript payload in every page) and a player's file name are
// published with the talk. A reference that is absolute or leaves the talk's folder is named there
// by its file name alone (shown-reference.mjs); one inside the talk's folder is shown as written.
const { shownReference, referenceFileName } = await import(lib('shown-reference.mjs'))
const privateFolderName = `private-folder-${randomBytes(8).toString('hex')}`
const privateFolder = join(base, privateFolderName)
await mkdir(privateFolder, { recursive: true })
const baseName = base.split('/').pop()
const SHOWN_KINDS = {
  image: { ext: 'png', write: (ref) => ({ body: `![A picture](${ref})` }) },
  'image, no alt': { ext: 'png', write: (ref) => ({ body: `![](${ref})` }) },
  video: { ext: 'mp4', write: (ref) => ({ body: `![A clip](${ref})` }) },
  'video directive': { ext: 'mp4', write: (ref) => ({ body: `[Video: ${ref}]` }) },
  audio: { ext: 'mp3', write: (ref) => ({ body: `![A sound](${ref})` }) },
  'audio, no title (the chip is named from the file)': { ext: 'mp3', write: (ref) => ({ body: `![](${ref})` }) },
  logo: { ext: 'svg', write: (ref) => ({ frontmatter: `logo: ${ref}`, body: 'Body.' }) },
  embed: { ext: 'html', write: (ref) => ({ body: `[Embed: ${ref}]` }) },
  simulation: { ext: 'html', write: (ref) => ({ body: `[Simulation: ${ref}]` }) },
  'image in a contrast card': { ext: 'png', write: (ref) => ({ body: `#### One\n\n![a](${ref})\n\nText.\n\n#### Two\n\nText.`, token: ' {contrast}' }) },
}
for (const [kind, spec] of Object.entries(SHOWN_KINDS)) {
  await check(`${kind}: no output names the folder of a reference outside the talk's folder`, async () => {
    const existing = join(privateFolder, `there-${Object.keys(SHOWN_KINDS).indexOf(kind)}.${spec.ext}`)
    await writeFile(existing, KINDS.image.body('x'))
    const missing = join(privateFolder, `not-there.${spec.ext}`)
    const forms = {
      'an absolute path to a file that exists': existing,
      'an absolute path to a file that does not': missing,
      'a file: URL': `file://${existing}`,
      'a .. climb': `../../${privateFolderName}/${existing.split('/').pop()}`,
      'a .. climb to a missing file': `../../${privateFolderName}/not-there.${spec.ext}`,
      'backslashes': `..\\..\\${privateFolderName}\\not-there.${spec.ext}`,
      'percent-encoded': existing.split('/').map(encodeURIComponent).join('%2F'),
    }
    const problems = []
    for (const [how, ref] of Object.entries(forms)) {
      const written = spec.write(ref)
      const source = ['---', 'title: Shown', ...(written.frontmatter ? [written.frontmatter] : []), '---', '', `### A slide${written.token ?? ''}`, '', written.body, ''].join('\n')
      const outlinePath = join(talk, 'talk-outline.md')
      await writeFile(outlinePath, source)
      const model = await prepareSource(outlinePath, source, 'talk', undefined, {}, { allowedAssetRoots: [vault] })
      const shared = await buildSharedTalkPayload({ compilerDir: join(process.cwd(), 'compiler/scripts'), outlinePath, content: source, compileContent: source, slug: 'talk', ownerName: 'Owner', proposals: false, allowedAssetRoots: [vault] })
      const outputs = { 'the deck page (slides, phone text payload, everything)': String(model.fullHtml), 'the shared page': shared.html }
      for (const [where, text] of Object.entries(outputs)) {
        for (const needle of [privateFolderName, baseName, encodeURIComponent(privateFolder)]) {
          const at = text.indexOf(needle)
          if (at >= 0) problems.push(`${how}: ${where} holds ${JSON.stringify(text.slice(Math.max(0, at - 60), at + needle.length + 30))}`)
        }
      }
      // The phone text payload is in the page; checked on its own as well, parsed.
      const script = String(model.fullHtml).match(/<script[^>]*id="twSlideScript"[^>]*>([\s\S]*?)<\/script>/)
      assert.ok(script, 'the page carries the phone text payload')
      if (script[1].includes(privateFolderName)) problems.push(`${how}: the phone text payload names the folder`)
    }
    assert.deepEqual(problems, [])
  })
}

await check('what the page calls an unresolved reference: its file name; as written only inside the talk\'s folder', async () => {
  const model = await compile(outline({ body: [
    `[Embed: ${join(privateFolder, 'report.html')}]`, '[Embed: assets/gone.html]', `[Simulation: ../../${privateFolderName}/sim.html]`,
    `[Embed: ${join(vault, 'other-talk', 'page.html')}]`,
  ].join('\n\n') }), { allowedAssetRoots: [vault] })
  const html = String(model.fullHtml)
  for (const shown of ['Missing embed: report.html<', 'Missing embed: assets/gone.html<', 'Missing embed: sim.html<', 'Missing embed: other-talk/page.html<']) assert.ok(html.includes(shown), shown)
  // The phone text view names them the same way (an absolute path by file name alone).
  const script = JSON.parse(html.match(/<script[^>]*id="twSlideScript"[^>]*>([\s\S]*?)<\/script>/)[1])
  const lines = JSON.stringify(script)
  for (const shown of ['[Embed: report.html]', '[Embed: assets/gone.html]', '[Simulation: sim.html]', '[Embed: page.html]']) assert.ok(lines.includes(shown), `${shown} in ${lines.slice(0, 400)}`)
  // A remote embed's address is its own and is shown as written.
  const remote = await compile(outline({ body: '[Embed: https://example.org/a/b/page.html]' }), {})
  assert.ok(String(remote.fullHtml).includes('[Embed: https://example.org/a/b/page.html]'))
  // The rule itself.
  for (const [written, shown] of [
    ['assets/sim.html', 'assets/sim.html'], ['./a/../b.html', './a/../b.html'], ['assets/Pasted%20image.png', 'assets/Pasted%20image.png'],
    ['/Users/alice/private/secret.html', 'secret.html'], ['../../outside/x.html', 'x.html'], ['a/../../x.html', 'x.html'],
    ['file:///Users/alice/private/secret.html', 'secret.html'], ['..\\..\\outside\\x.html', 'x.html'], ['%2FUsers%2Falice%2Fx.html', 'x.html'],
    ['%2e%2e/%2e%2e/outside/x.html', 'x.html'], ['//host/share/x.html', 'x.html'], ['C:\\Users\\a\\x.html', 'x.html'], ['', ''],
  ]) assert.equal(shownReference(written), shown, written)
  assert.equal(referenceFileName('/Users/alice/private/'), 'private')
  assert.equal(referenceFileName('..\\..'), '')
})

// NOT covered, pinned so it is not mistaken for covered: the shared-talk payload also carries each
// slide's outline SOURCE (`slides[].text`). It is the author's text, shared on purpose as the base
// that proposals are compared against (feedback-accept.ts), so it is sent as written, references
// included. Changing it would make every proposal on such a slide look stale. Reported for a decision.
await check('known gap: a shared talk\'s slide SOURCE text is sent as the author wrote it', async () => {
  const ref = join(privateFolder, 'report.html')
  const source = outline({ body: `[Embed: ${ref}]` })
  const outlinePath = join(talk, 'talk-outline.md')
  await writeFile(outlinePath, source)
  const shared = await buildSharedTalkPayload({ compilerDir: join(process.cwd(), 'compiler/scripts'), outlinePath, content: source, compileContent: source, slug: 'talk', ownerName: 'Owner', proposals: false, allowedAssetRoots: [vault] })
  assert.equal(shared.html.includes(privateFolderName), false, 'the page itself does not name the folder')
  assert.ok(shared.slides.some((slide) => slide.text.includes(`[Embed: ${ref}]`)), 'the source text does: it is the outline as written')
})

// ── 6. Main-process readers beside the compiler ──────────────────────────────────────────────
// Two small functions in src/main/index.ts follow a talk's files without compiling: the size of a
// talk's assets folder (the backup's skip decision) and the picture a slide's recognised text is
// looked up for. They are taken out of the source and run here against real files.
const ts = (await import('typescript')).default
const pathNode = await import('node:path')
const { pathStaysInside } = await import(pathToFileURL(join(process.cwd(), 'src/main/path-containment.ts')).href)
function mainFunction(name) {
  const source = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')
  const start = source.indexOf(`\nfunction ${name}(`)
  assert.ok(start >= 0, `${name} is in src/main/index.ts`)
  const text = source.slice(start, source.indexOf('\n}\n', start) + 3)
  const js = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const deps = { ...fsSync, ...pathNode, pathStaysInside }
  delete deps.default
  return { text, fn: Function(...Object.keys(deps), `${js}\nreturn ${name}`)(...Object.values(deps)) }
}

await check('the assets-folder size never counts a file elsewhere: links are not followed', async () => {
  const { fn: talkAssetsBytes } = mainFunction('talkAssetsBytes')
  const sized = join(vault, 'sized-talk')
  await mkdir(join(sized, 'assets'), { recursive: true })
  await writeFile(join(sized, 'assets', 'own.bin'), Buffer.alloc(1000))
  const outlinePath = join(sized, 'sized-talk-outline.md')
  assert.equal(talkAssetsBytes(outlinePath), 1000)
  await writeFile(join(outside, 'huge.bin'), Buffer.alloc(50_000))
  await symlink(join(outside, 'huge.bin'), join(sized, 'assets', 'link.bin'))
  await symlink(join(outside, 'never-there.bin'), join(sized, 'assets', 'dangling.bin'))
  assert.equal(talkAssetsBytes(outlinePath), 1000, 'a link to a file outside adds nothing, whether or not the file exists')
  // The folder itself a link to a folder elsewhere: nothing is listed.
  const linked = join(vault, 'linked-talk')
  await mkdir(linked, { recursive: true })
  await symlink(outside, join(linked, 'assets'))
  assert.equal(talkAssetsBytes(join(linked, 'linked-talk-outline.md')), 0)
})

await check('a slide\'s recognised-text lookup names only pictures really inside the vault', async () => {
  const { fn: resolveImageAbs } = mainFunction('resolveImageAbs')
  assert.equal(resolveImageAbs('inside-image.png', talk, vault), join(talk, 'inside-image.png'))
  assert.equal(resolveImageAbs(pooled.id, talk, vault), join(vault, '_assets', `${pooled.id}.png`))
  for (const ref of [secrets.image.path, `../../outside/${secrets.image.name}`, `%2e%2e/%2e%2e/outside/${secrets.image.name}`, `link-out-image.png`, `dir-out/${secrets.image.name}`, 'img-0000abc']) {
    assert.equal(resolveImageAbs(ref, talk, vault), null, ref)
  }
  // …and the pass that fills the text cache skips a picture that is a link out of the vault.
  const { text } = mainFunction('gatherVaultImages')
  assert.match(text, /pathStaysInside\(vaultRoot, full\) && statSync\(full\)\.isFile\(\)/)
})

await check('the instant-slide path opens no file a talk names: no allowed folder, so no picture digest', async () => {
  const source = readFileSync(join(process.cwd(), 'src/main/instant-slide-insert.ts'), 'utf8')
  assert.match(source, /\{ projectionsOnly: true, allowedAssetRoots: \[\] \}/)
  const insideSource = outline({ body: '![A picture](inside-image.png)' })
  const one = await compile(insideSource, { projectionsOnly: true, allowedAssetRoots: [] })
  await writeFile(join(talk, 'inside-image.png'), Buffer.concat([insides.image.bytes, Buffer.from('changed')]))
  const two = await compile(insideSource, { projectionsOnly: true, allowedAssetRoots: [] })
  await writeFile(join(talk, 'inside-image.png'), insides.image.bytes)
  assert.deepEqual(two.pictureKeys, one.pictureKeys, 'the key does not follow the file: it was not read')
  assert.deepEqual(one.assets, [])
  assert.equal(one.fullHtml, '')
})

// ── 7. A talk in no vault ────────────────────────────────────────────────────────────────────
await check('a loose talk\'s pooled id is not pointed at the current vault, and no warning spells out where that vault is', async () => {
  const looseDir = join(base, 'loose')
  await mkdir(looseDir, { recursive: true })
  const loosePath = join(looseDir, 'loose-outline.md')
  await writeFile(loosePath, pooledSource)
  // The rewrite is skipped for a talk that is not in the vault it is given…
  assert.equal(resolveImageRefs(pooledSource, vault, loosePath), pooledSource)
  // …and done for a talk that is, whichever spelling of the folder either side uses.
  const inVault = join(talk, 'talk-outline.md')
  await writeFile(inVault, pooledSource)
  const rewritten = resolveImageRefs(pooledSource, vault, inVault)
  assert.ok(rewritten.includes(join(vault, '_assets', `${pooled.id}.png`)))
  assert.equal(resolveImageRefs(pooledSource, vault, join(realBase, 'vault', 'talk', 'talk-outline.md')), rewritten)
  assert.equal(resolveImageRefs(pooledSource, join(realBase, 'vault'), inVault).includes('_assets'), true)
  assert.equal(resolveImageRefs(pooledSource, vault), rewritten, 'no talk given: as before')
  assert.equal(resolveImageRefs(pooledSource, vault, join(base, 'vault-evil', 't-outline.md')), pooledSource, 'a sibling whose name starts with the vault\'s is not in it')
  const roots = assetRootsForTalk(vaults, loosePath)
  assert.deepEqual(roots, [looseDir])
  const asTheAppCompiles = await prepareSource(loosePath, resolveImageRefs(pooledSource, vault, loosePath), 'loose', undefined, {}, { allowedAssetRoots: roots })
  // Even if a path into the vault does reach the compiler for a loose talk, the warning names the file only.
  const worstCase = await prepareSource(loosePath, rewritten, 'loose', undefined, {}, { allowedAssetRoots: roots })
  assert.deepEqual(worstCase.warnings.filter((w) => /^asset-outside-vault/.test(w)), [`asset-outside-vault:a-slide:${pooled.id}.png`])
  for (const model of [asTheAppCompiles, worstCase]) {
    for (const warning of model.warnings) for (const leak of [base, realBase, 'vault/', '_assets']) assert.equal(warning.includes(leak), false, warning)
    assert.equal(String(model.fullHtml).includes(pooled.bytes.toString('base64')), false)
    assert.deepEqual(unresolvedAddresses(String(model.fullHtml), model.assets), [])
  }
  // In the app the rewrite goes through one function that takes the talk's own vault.
  const index = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')
  assert.match(index, /function resolvePooledRefs\(content: string, outlinePath: string\): string \{\n  const root = talkVaultRoot\(vaultRegistry, outlinePath\)\n  return root \? resolveImageRefs\(content, root, outlinePath\) : content\n\}/)
  assert.ok([...index.matchAll(/resolvePooledRefs\((\w+), outlinePath\)/g)].length >= 10)
  // No handler is left rewriting against "the current vault" (vaultRootFor's fallback): the direct
  // calls that remain are the vault scans (their own vault, with the talk) and the staged version preview.
  const direct = [...index.matchAll(/resolveImageRefs\(([^)]*)\)/g)].map((m) => m[1])
  assert.deepEqual(direct.sort(), ['content, root, outlinePath', 'content, vaultRoot, talk.outlinePath', 'content, vaultRoot, talk.outlinePath', 'outline, vaultRoot'])
})

await check('a talk in a registered vault that is not the current one gets its OWN vault\'s pooled pictures', async () => {
  // Vault A is open and current; vault B is registered but closed. The talk is in B.
  const vaultB = join(base, 'vault-b')
  const talkB = join(vaultB, 'talk-b')
  await mkdir(talkB, { recursive: true })
  await mkdir(join(vaultB, '_assets'), { recursive: true })
  const pooledB = { id: 'img-b0b0b0b', bytes: Buffer.concat([PNG_1X1, Buffer.from('TW-POOLED-B-' + randomBytes(6).toString('hex'))]) }
  await writeFile(join(vaultB, '_assets', `${pooledB.id}.png`), pooledB.bytes)
  // The same id also exists in A with other bytes: the wrong pool must not be used.
  await writeFile(join(vault, '_assets', `${pooledB.id}.png`), Buffer.concat([PNG_1X1, Buffer.from('WRONG-POOL')]))
  const registry = { resolve: (path) => resolveInVaults([{ id: 'a', root: vault, open: true, order: 0, name: 'A' }, { id: 'b', root: vaultB, open: false, order: 1, name: 'B' }], path) }
  const outlinePath = join(talkB, 'talk-b-outline.md')
  const source = outline({ body: `![Pooled in B](${pooledB.id})` })
  await writeFile(outlinePath, source)
  assert.equal(talkVaultRoot(registry, outlinePath), vaultB)
  assert.equal(talkVaultRoot(registry, join(base, 'loose', 'loose-outline.md')), undefined)
  assert.equal(talkVaultRoot(registry, join(talk, 'talk-outline.md')), vault)
  assert.deepEqual(assetRootsForTalk(registry, outlinePath), [vaultB])
  // As resolvePooledRefs does it: the talk's own vault, then the compile with that vault allowed.
  const resolved = resolveImageRefs(source, talkVaultRoot(registry, outlinePath), outlinePath)
  assert.ok(resolved.includes(join(vaultB, '_assets', `${pooledB.id}.png`)))
  const model = await prepareSource(outlinePath, resolved, 'talk-b', undefined, {}, { allowedAssetRoots: assetRootsForTalk(registry, outlinePath) })
  assert.ok(String(model.fullHtml).includes(pooledB.bytes.toString('base64')), 'the picture from B\'s pool is inlined')
  assert.equal(String(model.fullHtml).includes(Buffer.from('WRONG-POOL').toString('base64').slice(0, 10)), false)
  assert.deepEqual(model.warnings.filter((w) => /^(asset-outside-vault|missing-image|unknown-image)/.test(w)), [])
  // What happened before: the current vault (A) was handed in, the talk is not in A, nothing was rewritten.
  assert.equal(resolveImageRefs(source, vault, outlinePath), source)
})

await check('the warning is registered, in plain English', () => {
  const definition = WARNING_REGISTRY.find((entry) => entry.id === 'asset-outside-vault')
  assert.ok(definition)
  assert.equal(definition.severity, 'error')
  const text = formatWarning('asset-outside-vault:s1:../../somewhere/secret.png')
  assert.ok(text.includes('../../somewhere/secret.png'))
  assert.ok(text.includes('This file is outside the talk’s vault, so it was not included.'))
})

await rm(base, { recursive: true, force: true })

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1) }
console.log('\nmedia inside the vault: all checks passed')
