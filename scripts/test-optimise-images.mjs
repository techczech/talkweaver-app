// 0.38 ticket 10, review round 2 — "Optimise images" stays inside the vault (ADR-0036).
// The command converts a talk's PNG/JPG pictures to WebP, rewrites the references and trashes the
// originals: a destructive write driven by talk content. src/main/optimise-images.ts decides, per
// reference, whether anything may be touched; the handler in index.ts only acts on an `ok` decision.
//
//  1. Which references are considered at all (pooled `img-` ids, web and data: addresses are not).
//  2. The decision for one reference: a plain picture in the talk's OWN folder whose .webp does not
//     exist yet → convert. Outside the vault (`..`, absolute, a file link out, a folder link out) →
//     `outside`. In the vault but not in this talk's folder (another talk's, the pool, a vault-level
//     folder) → `elsewhere`. A link → `linked`. A .webp of that name already there in any form
//     (file, link, hard link) → `clash`.
//  3. The plan for a whole talk: every reference decided first; one picture named several ways is
//     converted once and every spelling rewritten; two pictures that would share one .webp clash.
//  4. The write: a new file only, through a temporary file created exclusively; never onto anything.
//  5. Run as the handler runs it (real sharp conversion, a folder standing in for the Trash): for
//     every refused reference NOTHING outside the talk's folder is created, changed or removed.
//  6. The outline rewrite touches only references that were converted.
//  7. The handler acts only through the plan.
import { strict as assert } from 'node:assert'
import { mkdtemp, mkdir, writeFile, readFile, readdir, symlink, link, lstat, rename, realpath, rm, utimes } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import sharp from 'sharp'

const { createAssetContainment } = await import(pathToFileURL(join(process.cwd(), 'compiler/scripts/lib/asset-containment.mjs')).href)
const { convertibleImageRefs, optimiseDecision, planOptimisation, writeNewFile, rewriteConvertedRefs } = await import(pathToFileURL(join(process.cwd(), 'src/main/optimise-images.ts')).href)

let failures = 0
const check = async (name, fn) => {
  try { await fn(); console.log(`ok   ${name}`) } catch (error) { failures++; console.error(`FAIL ${name}\n     ${error?.message ?? error}`) }
}

// <base>/vault/talk            the talk
// <base>/vault/other-talk      a sibling talk in the same vault
// <base>/vault/_assets         pooled media
// <base>/outside               files that must never be touched
// <base>/trash                 stands in for the system Trash
const base = await mkdtemp(join(tmpdir(), 'tw-optimise-'))
const realBase = await realpath(base)
const vault = join(base, 'vault'), talk = join(vault, 'talk'), other = join(vault, 'other-talk'), pool = join(vault, '_assets')
const outside = join(base, 'outside'), trash = join(base, 'trash')
for (const dir of [join(talk, 'assets'), other, pool, join(outside, 'sub'), trash]) await mkdir(dir, { recursive: true })
const PNG = await sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 200, g: 30, b: 30 } } }).png({ compressionLevel: 0 }).toBuffer()
const put = (path) => writeFile(path, PNG)
await put(join(talk, 'pic.png'))
await put(join(talk, 'photo.JPG'))
await put(join(talk, 'assets', 'Pasted image.png'))
await put(join(talk, 'has-webp.png'))
await writeFile(join(talk, 'has-webp.webp'), 'an older conversion')
await put(join(talk, 'webp-is-a-link.png'))
await put(join(other, 'neighbour.png'))
await put(join(pool, 'img-abc1234.png'))
await put(join(outside, 'secret.png'))
await put(join(outside, 'sub', 'deep.png'))
await writeFile(join(outside, 'victim.webp'), 'do not overwrite me')
await mkdir(join(talk, 'folder.png'))
await symlink(join(outside, 'secret.png'), join(talk, 'link-out.png'))
await symlink(outside, join(talk, 'dir-out'))
await symlink(join(talk, 'pic.png'), join(talk, 'link-in.png'))
await symlink(other, join(talk, 'dir-in'))
await symlink(join(outside, 'victim.webp'), join(talk, 'webp-is-a-link.webp'))
await symlink(join(outside, 'not-there.png'), join(talk, 'dangling.png'))
// A .webp name taken by a HARD link to an outside file: indistinguishable from a plain file.
await put(join(talk, 'webp-is-a-hard-link.png'))
await link(join(outside, 'victim.webp'), join(talk, 'webp-is-a-hard-link.webp'))
// A vault-level shared folder, and a talk nested in this talk's folder is still this talk's folder.
await mkdir(join(vault, 'shared-media'), { recursive: true })
await put(join(vault, 'shared-media', 'logo.png'))
await put(join(talk, 'assets', 'chart.jpeg'))
// Two pictures with one stem.
await put(join(talk, 'stem.png'))
await put(join(talk, 'stem.jpg'))
await put(join(talk, 'Case.png'))
await put(join(talk, 'case-other.png'))
// Old enough that any write would show in the modification time.
const past = new Date('2020-01-01T00:00:00Z')
for (const name of ['secret.png', 'victim.webp', join('sub', 'deep.png')]) await utimes(join(outside, name), past, past)

const real = (...parts) => join(realBase, ...parts)
const contain = createAssetContainment([vault])
const decide = (ref, containment = contain) => optimiseDecision(ref, talk, containment)

async function snapshot(dir) {
  const out = {}
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    const full = join(entry.parentPath ?? entry.path, entry.name)
    const info = await lstat(full)
    out[full.slice(dir.length + 1)] = info.isFile()
      ? { size: info.size, mtimeMs: info.mtimeMs, sha: createHash('sha256').update(await readFile(full)).digest('hex') }
      : { kind: info.isDirectory() ? 'dir' : 'other', mtimeMs: info.mtimeMs }
  }
  return out
}

await check('which references are considered: PNG/JPG image links; not pooled ids, web or data: addresses', () => {
  const content = [
    '![a](pic.png)', '![b](photo.JPG "A title")', '![c](assets/Pasted%20image.png)', '![again](pic.png)',
    '![pooled](img-abc1234)', '![pooled clip](vid-abc1234)', '![web](https://example.org/x.png)', '![data](data:image/png;base64,AAAA)',
    '![webp](already.webp)', '![svg](drawing.svg)', '[a link, not an image](other.png)', 'plain text pic2.png',
  ].join('\n\n')
  assert.deepEqual(convertibleImageRefs(content), ['pic.png', 'photo.JPG', 'assets/Pasted%20image.png'])
})

await check('a plain picture in the talk\'s own folder, with no .webp yet, is converted beside the real file', async () => {
  assert.deepEqual(await decide('pic.png'), { ok: true, source: real('vault', 'talk', 'pic.png'), output: real('vault', 'talk', 'pic.webp'), webpRef: 'pic.webp' })
  assert.deepEqual(await decide('photo.JPG'), { ok: true, source: real('vault', 'talk', 'photo.JPG'), output: real('vault', 'talk', 'photo.webp'), webpRef: 'photo.webp' })
  assert.deepEqual(await decide('assets/chart.jpeg'), { ok: true, source: real('vault', 'talk', 'assets', 'chart.jpeg'), output: real('vault', 'talk', 'assets', 'chart.webp'), webpRef: 'assets/chart.webp' })
  // The reference keeps its written (percent-encoded) form; the file keeps its real name.
  assert.deepEqual(await decide('assets/Pasted%20image.png'), { ok: true, source: real('vault', 'talk', 'assets', 'Pasted image.png'), output: real('vault', 'talk', 'assets', 'Pasted image.webp'), webpRef: 'assets/Pasted%20image.webp' })
  // An absolute path into the talk's own folder is the talk's own picture.
  assert.equal((await decide(join(talk, 'pic.png'))).ok, true)
})

await check('pooled media: an id is never considered; a pooled file named by its path belongs to the pool and is left alone', async () => {
  // Today (and still): `![](img-abc1234)` is skipped — pooled pictures are WebP from the start.
  assert.deepEqual(convertibleImageRefs('![p](img-abc1234)\n\n![q](img-img-abc1234)'), [])
  const byPath = join(vault, '_assets', 'img-abc1234.png')
  assert.deepEqual(await decide(byPath), { ok: false, reason: 'elsewhere' })
  assert.deepEqual(await decide('../_assets/img-abc1234.png'), { ok: false, reason: 'elsewhere' })
  // For a talk in no vault its own folder is the only allowed one: the pool is outside.
  assert.deepEqual(await decide(byPath, createAssetContainment([talk])), { ok: false, reason: 'outside' })
})

const REFUSED = {
  'a .. escape': ['../../outside/secret.png', 'outside'],
  'a deeper .. escape': ['../../outside/sub/deep.png', 'outside'],
  'an absolute path outside': [join(outside, 'secret.png'), 'outside'],
  'percent-encoded ..': ['%2e%2e%2f%2e%2e%2foutside%2fsecret.png', 'outside'],
  'a file link that points out': ['link-out.png', 'outside'],
  'a folder link that points out': ['dir-out/secret.png', 'outside'],
  'a folder link that points out, deeper': ['dir-out/sub/deep.png', 'outside'],
  'a dangling link': ['dangling.png', 'outside'],
  'a file that is not there, outside': ['../../outside/not-there.png', 'outside'],
  'a link that stays inside (the talk named the link, not its target)': ['link-in.png', 'linked'],
  'another talk\'s picture': ['../other-talk/neighbour.png', 'elsewhere'],
  'another talk\'s picture, by absolute path': [join(other, 'neighbour.png'), 'elsewhere'],
  'another talk\'s picture, through a folder link in this talk': ['dir-in/neighbour.png', 'elsewhere'],
  'a pooled file, by path': ['../_assets/img-abc1234.png', 'elsewhere'],
  'a picture in a vault-level shared folder': ['../shared-media/logo.png', 'elsewhere'],
  'a picture whose .webp already exists': ['has-webp.png', 'clash'],
  'a picture whose .webp is a link out': ['webp-is-a-link.png', 'clash'],
  'a picture whose .webp is a hard link to an outside file': ['webp-is-a-hard-link.png', 'clash'],
  'a file that is not there': ['assets/nope.png', 'missing'],
  'a folder with a picture\'s name': ['folder.png', 'missing'],
  'a file: URL': [`file://${join(outside, 'secret.png')}`, 'missing'],
}
for (const [how, [ref, reason]] of Object.entries(REFUSED)) {
  await check(`refused — ${how}`, async () => {
    assert.deepEqual(await decide(ref), { ok: false, reason })
  })
}
await check('with no allowed folder, or one that is not there, nothing is converted', async () => {
  for (const roots of [[], [join(base, 'no-such-vault')], undefined]) {
    assert.equal((await decide('pic.png', createAssetContainment(roots))).ok, false)
  }
})

// ── As the handler runs it ──────────────────────────────────────────────────────────────────
// The same loop as `talk:optimize-images` in src/main/index.ts, with sharp for real and a folder
// for the Trash.
async function runOptimise(content, containment = contain) {
  const plan = await planOptimisation(convertibleImageRefs(content), talk, containment)
  const converted = new Map()
  let pictures = 0
  for (const conversion of plan.conversions) {
    const webp = await sharp(conversion.source).webp({ quality: 82 }).toBuffer()
    await writeNewFile(conversion.output, webp)
    for (const [ref, webpRef] of conversion.refs) converted.set(ref, webpRef)
    pictures += 1
    await rename(conversion.source, join(trash, `${pictures}-${conversion.source.split('/').pop()}`))
  }
  const count = (reason) => plan.skipped.filter((skip) => skip.reason === reason).length
  return { plan, converted, pictures, failed: plan.skipped.filter((skip) => !['elsewhere', 'clash'].includes(skip.reason)).map((skip) => skip.ref), leftAlone: count('elsewhere'), clashes: count('clash'), newContent: rewriteConvertedRefs(content, converted) }
}
const tempsIn = async (dir) => (await readdir(dir, { recursive: true })).filter((name) => name.endsWith('.tmp'))

await check('run over every refused reference: nothing outside the vault is created, changed or removed', async () => {
  const content = Object.values(REFUSED).map(([ref], i) => `![refused ${i}](${ref})`).join('\n\n')
  assert.equal(convertibleImageRefs(content).length, Object.keys(REFUSED).length, 'every refused reference is put to the decision')
  const outsideBefore = await snapshot(outside)
  const vaultBefore = await snapshot(vault)
  const result = await runOptimise(content)
  assert.equal(result.converted.size, 0)
  assert.equal(result.failed.length + result.leftAlone + result.clashes, Object.keys(REFUSED).length)
  assert.equal(result.leftAlone, Object.values(REFUSED).filter(([, reason]) => reason === 'elsewhere').length)
  assert.equal(result.clashes, Object.values(REFUSED).filter(([, reason]) => reason === 'clash').length)
  assert.deepEqual(Object.fromEntries(result.plan.skipped.map((skip) => [skip.ref, skip.reason])), Object.fromEntries(Object.values(REFUSED)))
  assert.equal(result.newContent, content, 'no reference is rewritten')
  assert.deepEqual(await snapshot(outside), outsideBefore, 'the outside folder is exactly as it was: listing, sizes, times, bytes')
  assert.deepEqual(await snapshot(vault), vaultBefore, 'and nothing in the vault was written for a refused reference: not another talk\'s folder, not the pool')
  assert.deepEqual(await readdir(trash), [])
})

await check('one picture written several ways is converted once, and every spelling is rewritten in its own form', async () => {
  // Is this volume case-insensitive (the macOS default)? Then `Pic.png` is the same file too.
  const caseInsensitive = existsSync(join(talk, 'PIC.PNG'))
  const content = [
    '![a](pic.png)', '![b](./pic.png)', '![c](%70ic.png)', '![d](pic.png "With a title")', '![e](assets/../pic.png)',
    ...(caseInsensitive ? ['![f](Pic.png)'] : []),
    '![other](photo.JPG)',
  ].join('\n\n')
  const outsideBefore = await snapshot(outside)
  const result = await runOptimise(content)
  assert.equal(result.pictures, 2, 'two pictures, however many ways they are written')
  assert.deepEqual(result.plan.skipped, [])
  assert.equal(result.plan.conversions.find((c) => c.source === real('vault', 'talk', 'pic.png')).refs.length, caseInsensitive ? 5 : 4)
  assert.equal(result.newContent, [
    '![a](pic.webp)', '![b](./pic.webp)', '![c](%70ic.webp)', '![d](pic.webp "With a title")', '![e](assets/../pic.webp)',
    ...(caseInsensitive ? ['![f](Pic.webp)'] : []),
    '![other](photo.webp)',
  ].join('\n\n'))
  assert.ok(existsSync(join(talk, 'pic.webp')) && !existsSync(join(talk, 'pic.png')), 'converted, original moved to the Trash')
  assert.equal((await sharp(join(talk, 'pic.webp')).metadata()).format, 'webp')
  assert.deepEqual((await readdir(trash)).sort(), ['1-pic.png', '2-photo.JPG'])
  // No reference is left pointing at a trashed picture: every rewritten one resolves.
  for (const ref of convertibleImageRefs(content)) assert.equal((await contain.reference(talk, ref)).ok, false, `${ref} is gone`)
  for (const match of result.newContent.matchAll(/\]\(([^)\s]+)/g)) assert.equal((await contain.reference(talk, match[1])).ok, true, `${match[1]} resolves`)
  assert.deepEqual(await tempsIn(vault), [])
  assert.deepEqual(await snapshot(outside), outsideBefore)
})

await check('two pictures with one stem clash: neither is converted, nothing is overwritten', async () => {
  const content = '![png](stem.png)\n\n![jpg](stem.jpg)\n\n![fine](case-other.png)'
  const vaultBefore = await snapshot(vault)
  const plan = await planOptimisation(convertibleImageRefs(content), talk, contain)
  assert.deepEqual(plan.skipped, [{ ref: 'stem.png', reason: 'clash' }, { ref: 'stem.jpg', reason: 'clash' }])
  assert.deepEqual(plan.conversions.map((c) => c.refs), [[['case-other.png', 'case-other.webp']]])
  assert.deepEqual(await snapshot(vault), vaultBefore, 'planning touches nothing')
  // Names that differ only by case would be one .webp on a case-insensitive volume: also a clash.
  await put(join(talk, 'assets', 'Mixed.png'))
  await put(join(talk, 'assets', 'mixed.jpg'))
  const byCase = await planOptimisation(['assets/Mixed.png', 'assets/mixed.jpg', 'Case.png'], talk, contain)
  assert.deepEqual(byCase.skipped, [{ ref: 'assets/Mixed.png', reason: 'clash' }, { ref: 'assets/mixed.jpg', reason: 'clash' }])
  assert.deepEqual(byCase.conversions.map((c) => c.refs), [[['Case.png', 'Case.webp']]])
  const result = await runOptimise(content)
  assert.equal(result.pictures, 1)
  assert.equal(result.clashes, 2)
  assert.deepEqual(result.failed, [])
  assert.equal(result.newContent, '![png](stem.png)\n\n![jpg](stem.jpg)\n\n![fine](case-other.webp)')
  assert.ok(existsSync(join(talk, 'stem.png')) && existsSync(join(talk, 'stem.jpg')) && !existsSync(join(talk, 'stem.webp')))
})

await check('the write makes a new file only: never onto a file, a link, a dangling link or a hard link', async () => {
  const dir = join(talk, 'write')
  await mkdir(dir)
  const bytes = Buffer.from('new webp bytes')
  // The ordinary case: the file appears, complete, and no temporary file is left.
  await writeNewFile(join(dir, 'fresh.webp'), bytes)
  assert.deepEqual(await readFile(join(dir, 'fresh.webp')), bytes)
  assert.ok((await lstat(join(dir, 'fresh.webp'))).isFile())
  assert.deepEqual(await readdir(dir), ['fresh.webp'])
  // Something took the name after the decision: each form is refused, the thing is untouched.
  await writeFile(join(dir, 'file.webp'), 'already here')
  await symlink(join(outside, 'victim.webp'), join(dir, 'link.webp'))
  await symlink(join(outside, 'never-created.webp'), join(dir, 'dangling.webp'))
  await link(join(outside, 'victim.webp'), join(dir, 'hard.webp'))
  const outsideBefore = await snapshot(outside)
  for (const name of ['file.webp', 'link.webp', 'dangling.webp', 'hard.webp']) {
    await assert.rejects(writeNewFile(join(dir, name), bytes), (error) => error?.code === 'EEXIST', name)
  }
  assert.equal(await readFile(join(dir, 'file.webp'), 'utf8'), 'already here')
  assert.equal(await readFile(join(outside, 'victim.webp'), 'utf8'), 'do not overwrite me')
  assert.equal(existsSync(join(outside, 'never-created.webp')), false, 'a dangling link is not written through')
  assert.deepEqual(await snapshot(outside), outsideBefore)
  assert.deepEqual((await readdir(dir)).sort(), ['dangling.webp', 'file.webp', 'fresh.webp', 'hard.webp', 'link.webp'], 'no temporary file is left after a refusal')
  // A folder that is not there: fails, leaves nothing.
  await assert.rejects(writeNewFile(join(dir, 'no-such-folder', 'x.webp'), bytes))
  assert.deepEqual(await tempsIn(vault), [])
})

await check('run over a mixed talk: this talk\'s pictures are converted, the rest are left and said', async () => {
  const content = [
    '![inside](assets/chart.jpeg "Kept title")',
    '![encoded](assets/Pasted%20image.png)',
    `![escape](../../outside/secret.png)`,
    `![absolute](${join(outside, 'secret.png')})`,
    '![same name, elsewhere](dir-out/pic.png)',
    '![link](link-out.png)',
    '![neighbour](../other-talk/neighbour.png)',
    '![pool by path](../_assets/img-abc1234.png)',
    '![taken](has-webp.png)',
    'Prose that mentions assets/chart.jpeg and a [link](assets/chart.jpeg) keeps its text.',
    '![pooled](img-abc1234)',
  ].join('\n\n')
  const outsideBefore = await snapshot(outside)
  const otherBefore = await snapshot(other)
  const poolBefore = await snapshot(pool)
  const result = await runOptimise(content)
  assert.deepEqual([...result.converted], [['assets/chart.jpeg', 'assets/chart.webp'], ['assets/Pasted%20image.png', 'assets/Pasted%20image.webp']])
  assert.deepEqual(result.failed, ['../../outside/secret.png', join(outside, 'secret.png'), 'dir-out/pic.png', 'link-out.png'])
  assert.equal(result.leftAlone, 2)
  assert.equal(result.clashes, 1)
  assert.equal(result.newContent, content.replace('![inside](assets/chart.jpeg "Kept title")', '![inside](assets/chart.webp "Kept title")').replace('![encoded](assets/Pasted%20image.png)', '![encoded](assets/Pasted%20image.webp)'))
  assert.ok(existsSync(join(talk, 'assets', 'Pasted image.webp')) && existsSync(join(talk, 'assets', 'chart.webp')))
  assert.equal(await readFile(join(talk, 'has-webp.webp'), 'utf8'), 'an older conversion', 'an existing .webp is not replaced')
  assert.ok(existsSync(join(talk, 'has-webp.png')))
  assert.deepEqual(await snapshot(outside), outsideBefore, 'the outside folder is exactly as it was')
  assert.deepEqual(await snapshot(other), otherBefore, 'another talk\'s folder is exactly as it was')
  assert.deepEqual(await snapshot(pool), poolBefore, 'the pool is exactly as it was')
  assert.equal(await readFile(join(outside, 'victim.webp'), 'utf8'), 'do not overwrite me')
})

await check('the rewrite changes an image link only when its whole target was converted', () => {
  const converted = new Map([['pic.png', 'pic.webp'], ['a b.png', 'a b.webp']])
  const text = ['![x](pic.png)', '![x](  pic.png  "T" )', '![y](../elsewhere/pic.png)', '![z](pic.png.bak)', '![w](mypic.png)', '[link](pic.png)', 'pic.png in prose', '`![code](pic.png)` is an image link too', '![s](a b.png)'].join('\n')
  assert.equal(rewriteConvertedRefs(text, converted),
    ['![x](pic.webp)', '![x](  pic.webp  "T" )', '![y](../elsewhere/pic.png)', '![z](pic.png.bak)', '![w](mypic.png)', '[link](pic.png)', 'pic.png in prose', '`![code](pic.webp)` is an image link too', '![s](a b.webp)'].join('\n'))
  assert.equal(rewriteConvertedRefs(text, new Map()), text)
})

await check('the handler acts only through the plan', () => {
  const source = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')
  const start = source.indexOf("ipcMain.handle('talk:optimize-images'")
  const handler = source.slice(start, source.indexOf('\n})', start))
  assert.match(handler, /createAssetContainment\(assetRootsFor\(outlinePath\)\)/, 'the talk\'s allowed folders, by the compiler\'s containment')
  assert.match(handler, /const plan = await planOptimisation\(convertibleImageRefs\(content\), talkDir, containment\)/, 'every reference is decided before anything is converted')
  // Every call in the handler that opens, reads, writes, moves or removes a file, with its first argument.
  const FILE_CALLS = /\b(sharp|statSync|lstatSync|existsSync|readFileSync|writeFileSync|appendFileSync|copyFileSync|renameSync|unlinkSync|rmSync|mkdirSync|cpSync|openSync|createReadStream|createWriteStream|readFile|writeFile|appendFile|copyFile|rename|unlink|rm|rmdir|mkdir|cp|open|link|symlink|truncate|trashItem|toFile|writeNewFile)\(\s*([^,)]*)/g
  const touched = [...handler.matchAll(FILE_CALLS)].map((m) => `${m[1]}(${m[2].trim()})`)
  assert.deepEqual([...new Set(touched)].sort(), ['sharp(conversion.source)', 'statSync(conversion.source)', 'trashItem(conversion.source)', 'writeNewFile(conversion.output)'])
  assert.equal(/\.toFile\(/.test(handler), false, 'sharp never writes to a path: the bytes go through writeNewFile')
  assert.equal(/fs\.promises|fsPromises|require\('fs'\)|from 'fs/.test(handler), false, 'no other way to the file system in the handler')
  assert.equal(/join\(talkDir,/.test(handler), false, 'no path is built from the reference in the handler')
  // The original is trashed only after the new file exists.
  assert.ok(handler.indexOf('await writeNewFile(conversion.output, webp)') > 0 && handler.indexOf('await writeNewFile(conversion.output, webp)') < handler.indexOf('shell.trashItem(conversion.source)'))
  assert.match(handler, /rewriteConvertedRefs\(current, converted\)/)
  assert.match(handler, /failed: failed\.length, leftAlone, clashes, newContent/)
  // The module itself writes only in writeNewFile, and only by exclusive create, link or exclusive copy.
  const module = readFileSync(join(process.cwd(), 'src/main/optimise-images.ts'), 'utf8')
  const writes = [...module.matchAll(/\b(open|link|copyFile|unlink|writeFile|rename|rm|mkdir|symlink)\(\s*([^)]*)\)/g)].map((m) => `${m[1]}(${m[2].trim()})`)
  assert.deepEqual(writes.sort(), ["copyFile(temp, output, constants.COPYFILE_EXCL)", "link(temp, output)", "open(temp, 'wx', 0o644)", 'unlink(temp)', 'writeFile(bytes)'])
})

await rm(base, { recursive: true, force: true })

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1) }
console.log('\noptimise images: all checks passed')
