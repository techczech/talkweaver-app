// Vault-management, thumbnail-cache and asset-sidecar handlers take paths, folder names and slugs
// from the renderer. These tests drive the pure containment check (pathStaysInside) and the path
// function each handler calls (src/main/vault-paths.ts, resolveThumbFile) with hostile and
// legitimate input, act on every answer the way the handler does, and prove that nothing outside
// the scratch vault / userData changes — the "outside" sibling is listed before and after.
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import vm from 'node:vm'
import ts from 'typescript'
import { dirname, join, relative } from 'node:path'
import {
  abstractPath,
  assetSidecarPath,
  createFolderTarget,
  deleteFolderTarget,
  moveTalkTargets,
  newTalkFolder,
  outlineInVault,
  outlineRefusal,
  outlineSaveRefusal,
  renameFolderTargets,
  SET_ROOT_NOT_A_FOLDER,
  SET_ROOT_PICKER_ONLY,
  setRootRefusal,
  siblingTalkFolder,
  talkFolderOfOutline,
  talkFolderPath,
  thumbCacheDir
} from '../src/main/vault-paths.ts'
import { pathStaysInside } from '../src/main/path-containment.ts'
import { resolveThumbFile } from '../src/main/thumb-key-resolution.ts'

const scratch = mkdtempSync(join(tmpdir(), 'talkweaver-vault-paths-'))
const vault = join(scratch, 'vault')
const outside = join(scratch, 'outside')
const userData = join(scratch, 'userData')
const cacheRoot = join(userData, 'thumb-cache-test')
const CZ_NFC = 'Přednášky o agentech'.normalize('NFC')
const CZ_NFD = 'Přednášky o agentech'.normalize('NFD')

mkdirSync(join(vault, 'Work', 'Oxford', 'age-of-the-claw'), { recursive: true })
writeFileSync(join(vault, 'Work', 'Oxford', 'age-of-the-claw', 'age-of-the-claw-outline.md'), '# Claw\n')
mkdirSync(join(vault, CZ_NFC, 'Talk: agenti 2026'), { recursive: true })
writeFileSync(join(vault, CZ_NFC, 'Talk: agenti 2026', 'agenti-outline.md'), '# Agenti\n')
writeFileSync(join(vault, 'root-talk-outline.md'), '# A talk at the vault root\n')
mkdirSync(join(vault, '_assets'), { recursive: true })
mkdirSync(join(outside, 'victim'), { recursive: true })
writeFileSync(join(outside, 'victim', 'victim-outline.md'), '# not yours\n')
writeFileSync(join(outside, 'secret.yml'), 'secret: true\n')
writeFileSync(join(outside, 'secret.png'), 'png')
symlinkSync(outside, join(vault, 'link-out')) // a vault folder that points outside
// A talk folder whose abstract.md is a link to a file outside, and a folder link for sibling names.
writeFileSync(join(outside, 'secret-abstract.md'), 'secret\n')
mkdirSync(join(vault, 'Work', 'abstract-linked'), { recursive: true })
symlinkSync(join(outside, 'secret-abstract.md'), join(vault, 'Work', 'abstract-linked', 'abstract.md'))
symlinkSync(outside, join(vault, 'Work', 'evil'))
symlinkSync(join(vault, 'Work'), join(vault, 'link-in')) // a link that stays inside
symlinkSync(join(scratch, 'nowhere'), join(vault, 'dangling'))
mkdirSync(join(cacheRoot, 'age-of-the-claw'), { recursive: true })
writeFileSync(join(cacheRoot, 'age-of-the-claw', '0123456789abcdef-hashkey.png'), 'png')
symlinkSync(outside, join(cacheRoot, 'linked-out'))

function tree(root) {
  const out = []
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name)
      out.push(relative(scratch, p))
      if (lstatSync(p).isDirectory()) walk(p)
    }
  }
  walk(root)
  return out
}
const treeOutside = () => [...tree(outside), ...readdirSync(scratch).sort()]
const before = treeOutside()
let checks = 0

const real = (p) => realpathSync(p)
const realVault = real(vault)

// ── pathStaysInside: the pure containment check every handler goes through ──
{
  const ok = (candidate, expected, allowRoot = false) => {
    assert.equal(pathStaysInside(vault, candidate, allowRoot), expected, `pathStaysInside(${JSON.stringify(candidate)})`)
    checks++
  }
  ok(join(vault, 'Work'), join(realVault, 'Work'))
  ok('Work/Oxford', join(realVault, 'Work', 'Oxford')) // relative to the root
  ok(join(vault, 'Work', 'new', 'deeper'), join(realVault, 'Work', 'new', 'deeper')) // not there yet
  ok(join(vault, CZ_NFD), join(realVault, CZ_NFD)) // NFD spelling of an NFC folder
  ok(join(vault, 'link-in', 'Oxford'), join(realVault, 'Work', 'Oxford')) // a link inside the vault
  ok(vault, null)
  ok(vault, realVault, true)
  ok(join(vault, '..'), null)
  ok(join(vault, '..', 'outside'), null)
  ok('../outside', null)
  ok('/etc', null)
  ok(outside, null)
  ok(join(vault, 'link-out'), null)
  ok(join(vault, 'link-out', 'victim'), null)
  ok(join(vault, 'link-out', 'not-yet'), null)
  ok(join(vault, 'dangling'), null)
  ok(join(vault, 'dangling', 'x'), null)
  ok(join(vault, 'a\0b'), null)
  ok('', null)
  // A root that does not exist yet (a fresh thumbnail cache) still contains its children.
  const fresh = join(userData, 'not-created-yet')
  assert.equal(pathStaysInside(fresh, join(fresh, 'slug')), join(real(userData), 'not-created-yet', 'slug'))
  assert.equal(pathStaysInside(fresh, join(fresh, '..', 'x')), null)
  checks += 2
}

// What each handler does with an answer: act only when ok.
const act = {
  mkdir: (r) => { if (r.ok) mkdirSync(r.path, { recursive: true }) },
  rename: (r) => { if (r.ok && existsSync(r.src) && !existsSync(r.dest)) renameSync(r.src, r.dest) },
  trash: (r) => { if (r.ok && existsSync(r.path)) rmSync(r.path, { recursive: true, force: true }) },
  move: (r) => {
    if (!r.ok) return
    mkdirSync(r.destParent, { recursive: true })
    if (!existsSync(r.dest)) renameSync(r.srcDir, r.dest)
  },
  write: (r) => { if (r.ok) writeFileSync(r.path, 'id: x\n') }
}
const refused = (result, error, label) => {
  assert.equal(result.ok, false, label)
  if (error) assert.equal(result.error, error, label)
  checks++
}

const ESCAPE_RELS = ['..', '../outside', '../outside/victim', '/abs', outside, 'Work/../..', 'Work/../../outside', 'link-out', 'link-out/victim', 'dangling', 'a\0b']

// ── vault:create-folder ──
for (const name of ['', '   ', '.', '..', 'bad\u0001name', null]) {
  const r = createFolderTarget(vault, name, 'Work')
  refused(r, 'unsafe-name', `create-folder refuses name ${JSON.stringify(name)}`)
  act.mkdir(r)
}
for (const parent of ESCAPE_RELS) {
  const r = createFolderTarget(vault, 'New', parent)
  refused(r, null, `create-folder refuses parent ${JSON.stringify(parent)}`)
  act.mkdir(r)
}
refused(createFolderTarget(null, 'New', ''), 'no-vault', 'create-folder needs a vault')
refused(createFolderTarget(vault, 'link-out', ''), 'outside-vault', 'create-folder refuses a name that is a link outside')
for (const [name, parent, expected] of [
  ['Lectures', '', join(vault, 'Lectures')],
  [CZ_NFC, 'Work', join(vault, 'Work', CZ_NFC)],
  ['Talks: 2026', 'Work/Oxford', join(vault, 'Work', 'Oxford', 'Talks: 2026')],
  ['a/b', 'Work', join(vault, 'Work', 'a-b')], // separators still become '-', as before
  [CZ_NFD, undefined, join(vault, CZ_NFD)]
]) {
  const r = createFolderTarget(vault, name, parent)
  assert.deepEqual(r, { ok: true, path: expected }, `create-folder ${JSON.stringify(name)} in ${JSON.stringify(parent)}`)
  act.mkdir(r)
  checks++
}

// ── vault:rename-folder ──
for (const rel of ['', '.', '/', ...ESCAPE_RELS]) {
  const r = renameFolderTargets(vault, rel, 'Renamed')
  refused(r, null, `rename-folder refuses folder ${JSON.stringify(rel)}`)
  act.rename(r)
}
for (const name of ['', '..', '.']) {
  const r = renameFolderTargets(vault, 'Lectures', name)
  refused(r, 'unsafe-name', `rename-folder refuses new name ${JSON.stringify(name)}`)
  act.rename(r)
}
{
  const r = renameFolderTargets(vault, 'Work/Oxford/Talks: 2026', 'Přednášky: 2026')
  assert.deepEqual(r, { ok: true, src: join(vault, 'Work', 'Oxford', 'Talks: 2026'), dest: join(vault, 'Work', 'Oxford', 'Přednášky: 2026') })
  act.rename(r)
  assert.ok(existsSync(join(vault, 'Work', 'Oxford', 'Přednášky: 2026')))
  checks += 2
}

refused(renameFolderTargets(vault, 'Lectures', 'link-out'), 'outside-vault', 'rename-folder refuses a new name that is a link outside')

// ── vault:delete-folder ──
refused(deleteFolderTarget(vault, ''), 'vault-root', 'delete-folder refuses the vault root by name')
refused(renameFolderTargets(vault, '', 'x'), 'vault-root', 'rename-folder refuses the vault root by name')
for (const rel of ['', '.', '/', './', ...ESCAPE_RELS]) {
  const r = deleteFolderTarget(vault, rel)
  refused(r, null, `delete-folder refuses ${JSON.stringify(rel)}`)
  act.trash(r)
}
for (const rel of ['Lectures', `Work/${CZ_NFC}`, 'Work/Oxford/Přednášky: 2026']) {
  const r = deleteFolderTarget(vault, rel)
  assert.equal(r.ok, true, `delete-folder ${rel}`)
  act.trash(r)
  assert.equal(existsSync(r.path), false)
  checks += 2
}

// ── vault:delete-talk ──
const clawOutline = join(vault, 'Work', 'Oxford', 'age-of-the-claw', 'age-of-the-claw-outline.md')
for (const [outline, error] of [
  [join(outside, 'victim', 'victim-outline.md'), 'outside-vault'],
  [join(vault, 'link-out', 'victim', 'victim-outline.md'), 'outside-vault'],
  [join(vault, '..', 'outside', 'victim', 'victim-outline.md'), 'outside-vault'],
  [join(vault, 'root-talk-outline.md'), 'vault-root'],
  [vault, 'outside-vault'],
  ['Work/Oxford/age-of-the-claw/age-of-the-claw-outline.md', 'outside-vault'], // relative: refused
  ['', 'outside-vault'],
  [42, 'outside-vault']
]) {
  const r = talkFolderOfOutline(vault, outline)
  refused(r, error, `delete-talk refuses ${JSON.stringify(outline)}`)
  act.trash(r)
}
{
  // A talk folder inside the vault whose outline is a link to an outline outside it.
  mkdirSync(join(vault, 'Work', 'borrowed'))
  symlinkSync(join(outside, 'victim', 'victim-outline.md'), join(vault, 'Work', 'borrowed', 'borrowed-outline.md'))
  const r = talkFolderOfOutline(vault, join(vault, 'Work', 'borrowed', 'borrowed-outline.md'))
  refused(r, 'outside-vault', 'delete-talk refuses an outline linked outside the vault')
  act.trash(r)
}
{
  // Not talk folders: system areas, hidden folders, a missing outline, a non-outline file, a folder
  // named like an outline. delete-talk and move-talk must leave every one of them where it is.
  const notTalks = [
    join(vault, '_assets', 'not-an-outline'),
    join(vault, '_assets', 'x-outline.md'),
    join(vault, '_PRESENTATIONS', 'some-talk', 'some-talk-outline.md'),
    join(vault, '.hidden', 'h-outline.md'),
    join(vault, 'Work', '_drafts', 'd', 'd-outline.md'),
    join(vault, 'Work', 'ghost', 'ghost-outline.md'), // does not exist
    join(vault, 'Work', 'Oxford', 'notes.md'), // not an outline
    join(vault, 'Work', 'dirlike', 'z-outline.md') // a folder named like an outline
  ]
  for (const p of [notTalks[1], notTalks[2], notTalks[3], notTalks[4], notTalks[6]]) {
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, '# x\n')
  }
  mkdirSync(notTalks[7], { recursive: true })
  const vaultBefore = tree(vault)
  for (const outline of notTalks) {
    const del = talkFolderOfOutline(vault, outline)
    refused(del, 'not-a-talk', `delete-talk refuses ${relative(vault, outline)}`)
    act.trash(del)
    const mv = moveTalkTargets(vault, outline, 'Work')
    refused(mv, 'not-a-talk', `move-talk refuses ${relative(vault, outline)}`)
    act.move(mv)
  }
  assert.deepEqual(tree(vault), vaultBefore, 'no folder in the vault was trashed or moved')
  checks++
}
refused(talkFolderOfOutline(undefined, clawOutline), 'no-vault', 'delete-talk needs a vault')
assert.deepEqual(talkFolderOfOutline(vault, clawOutline), { ok: true, path: join(vault, 'Work', 'Oxford', 'age-of-the-claw') })
assert.deepEqual(talkFolderOfOutline(vault, join(vault, CZ_NFD, 'Talk: agenti 2026', 'agenti-outline.md')), { ok: true, path: join(vault, CZ_NFD, 'Talk: agenti 2026') })
checks += 2

// ── vault:move-talk ──
{
  // The destination folder already holds a link, named like the talk, that points outside.
  symlinkSync(outside, join(vault, 'Work', 'age-of-the-claw'))
  const r = moveTalkTargets(vault, clawOutline, 'Work')
  refused(r, 'outside-vault', 'move-talk refuses a destination that is a link outside')
  act.move(r)
  rmSync(join(vault, 'Work', 'age-of-the-claw'))
}
for (const dest of ['..', '../outside', '/abs', outside, 'link-out', 'Work/../..', 'dangling']) {
  const r = moveTalkTargets(vault, clawOutline, dest)
  refused(r, 'outside-vault', `move-talk refuses destination ${JSON.stringify(dest)}`)
  act.move(r)
}
{
  const r = moveTalkTargets(vault, join(outside, 'victim', 'victim-outline.md'), 'Work')
  refused(r, 'outside-vault', 'move-talk refuses a talk outside the vault')
  act.move(r)
  const root = moveTalkTargets(vault, join(vault, 'root-talk-outline.md'), 'Work')
  refused(root, 'vault-root', 'move-talk refuses moving the vault root')
  act.move(root)
}
{
  const r = moveTalkTargets(vault, clawOutline, `${CZ_NFC}/Talk: agenti 2026/..`)
  refused(r, 'outside-vault', 'move-talk refuses a ".." in the destination') // even one that stays inside
  const toCz = moveTalkTargets(vault, clawOutline, CZ_NFD)
  assert.deepEqual(toCz, { ok: true, srcDir: join(vault, 'Work', 'Oxford', 'age-of-the-claw'), destParent: join(vault, CZ_NFD), dest: join(vault, CZ_NFD, 'age-of-the-claw') })
  act.move(toCz)
  const movedOutline = join(vault, CZ_NFD, 'age-of-the-claw', 'age-of-the-claw-outline.md')
  const toRoot = moveTalkTargets(vault, movedOutline, '')
  assert.deepEqual(toRoot, { ok: true, srcDir: join(vault, CZ_NFD, 'age-of-the-claw'), destParent: vault, dest: join(vault, 'age-of-the-claw') })
  act.move(toRoot)
  assert.ok(existsSync(join(vault, 'age-of-the-claw', 'age-of-the-claw-outline.md')))
  checks += 3
}

// ── talk:clear-thumb-cache and twthumb:// ──
for (const slug of ['../outside', '..', '/abs', 'a/b', '', ' padded ', '.hidden', 'linked-out', 42]) {
  const r = thumbCacheDir(cacheRoot, slug)
  refused(r, null, `thumb cache refuses slug ${JSON.stringify(slug)}`)
  act.trash(r)
}
for (const slug of ['age-of-the-claw', CZ_NFC, CZ_NFD, 'Talk: agenti 2026']) {
  assert.deepEqual(thumbCacheDir(cacheRoot, slug), { ok: true, path: join(cacheRoot, slug) }, `thumb cache ${slug}`)
  checks++
}
assert.equal(thumbCacheDir(join(userData, 'fresh-cache'), 'age-of-the-claw').ok, true, 'a cache root that does not exist yet')
checks++
const clawThumbs = join(cacheRoot, 'age-of-the-claw')
for (const key of ['../../../outside/secret', '../linked-out/secret', 'a/b', '..', '.', '', 'x\0y']) {
  assert.equal(resolveThumbFile(clawThumbs, key), null, `twthumb refuses key ${JSON.stringify(key)}`)
  checks++
}
assert.equal(resolveThumbFile(clawThumbs, 'hashkey'), join(clawThumbs, '0123456789abcdef-hashkey.png'), 'bare picture key resolves')
assert.equal(resolveThumbFile(clawThumbs, '0123456789abcdef-hashkey'), join(clawThumbs, '0123456789abcdef-hashkey.png'), 'exact key resolves')
checks += 2
act.trash(thumbCacheDir(cacheRoot, 'age-of-the-claw'))

// ── asset:read-sidecar / asset:write-sidecar ──
for (const id of ['../outside/secret', '../../outside/secret', 'a/b', '..', '.hidden', '', '-x', 'x\0y', 42]) {
  const r = assetSidecarPath(vault, id)
  refused(r, 'unsafe-id', `sidecar refuses id ${JSON.stringify(id)}`)
  act.write(r)
}
refused(assetSidecarPath(null, 'img-a3f9b2'), 'no-vault', 'sidecar needs a vault')
for (const id of ['img-a3f9b2c', 'img-img-a3f9b2c', 'vid-1234567']) {
  const r = assetSidecarPath(vault, id)
  assert.deepEqual(r, { ok: true, path: join(vault, '_assets', `${id}.yml`) }, `sidecar ${id}`)
  act.write(r)
  checks++
}
{
  // An _assets folder that is a link to somewhere outside the vault is refused.
  const linked = join(scratch, 'vault2')
  mkdirSync(linked)
  symlinkSync(outside, join(linked, '_assets'))
  const r = assetSidecarPath(linked, 'secret')
  refused(r, 'outside-vault', 'sidecar refuses _assets linked outside')
  act.write(r)
  rmSync(linked, { recursive: true, force: true })
}

// ── abstract:read / abstract:write ──
for (const [talkPath, error] of [
  [join(outside, 'victim'), 'outside-vault'],
  [join(vault, 'link-out', 'victim'), 'outside-vault'],
  [join(vault, '..', 'outside', 'victim'), 'outside-vault'],
  [vault, 'vault-root'],
  [join(vault, '.'), 'vault-root'],
  ['Work/abstract-linked', 'outside-vault'], // relative: refused
  ['', 'outside-vault'],
  [42, 'outside-vault'],
  [join(vault, 'Work', 'abstract-linked'), 'outside-vault'] // abstract.md is a link to a file outside
]) {
  const r = abstractPath(vault, talkPath)
  refused(r, error, `abstract refuses ${JSON.stringify(talkPath)}`)
  act.write(r)
}
refused(talkFolderPath(vault, vault), 'vault-root', 'talk folder is never the vault root')
refused(talkFolderPath(vault, join(outside, 'victim')), 'outside-vault', 'talk folder outside the vault')
refused(talkFolderPath(vault, join(vault, 'link-out', 'victim')), 'outside-vault', 'talk folder through a link outside')
{
  // A relative path is refused even when the working directory is inside the vault (cwd is a real
  // path, so the vault is named by its real path here too).
  const cwd = process.cwd()
  process.chdir(join(vault, 'Work'))
  try {
    refused(talkFolderPath(realVault, 'abstract-linked'), 'outside-vault', 'relative talk folder refused')
    refused(talkFolderOfOutline(realVault, 'abstract-linked/x-outline.md'), 'outside-vault', 'relative outline refused')
  } finally {
    process.chdir(cwd)
  }
}
refused(abstractPath(null, join(vault, 'Work')), 'no-vault', 'abstract needs a vault')
for (const talkDir of [join(vault, CZ_NFD, 'Talk: agenti 2026'), join(vault, 'age-of-the-claw'), join(vault, 'Work', 'new talk: not yet made')]) {
  const r = abstractPath(vault, talkDir)
  assert.deepEqual(r, { ok: true, path: join(talkDir, 'abstract.md') }, `abstract ${talkDir}`)
  mkdirSync(talkDir, { recursive: true })
  act.write(r)
  checks++
}

// ── vault:clone-talk / vault:rename-talk: the new sibling folder ──
const clawDir = join(vault, 'age-of-the-claw')
for (const [slug, error] of [['..', 'unsafe-name'], ['.', 'unsafe-name'], ['a/b', 'unsafe-name'], ['', 'unsafe-name'], ['x\0y', 'unsafe-name'], [42, 'unsafe-name']]) {
  const r = siblingTalkFolder(vault, clawDir, slug)
  refused(r, error, `sibling refuses slug ${JSON.stringify(slug)}`)
  act.mkdir(r)
}
{
  const r = siblingTalkFolder(vault, join(vault, 'Work', 'abstract-linked'), 'evil')
  refused(r, 'outside-vault', 'sibling refuses a name that is a link outside')
  act.mkdir(r)
  refused(siblingTalkFolder(null, clawDir, 'x'), 'no-vault', 'sibling needs a vault')
}
for (const [src, slug, expected] of [
  [clawDir, 'age-of-the-claw-copy', join(vault, 'age-of-the-claw-copy')],
  [join(vault, CZ_NFC, 'Talk: agenti 2026'), 'agenti-2', join(vault, CZ_NFC, 'agenti-2')]
]) {
  const r = siblingTalkFolder(vault, src, slug)
  assert.deepEqual(r, { ok: true, path: expected }, `sibling ${slug}`)
  act.mkdir(r)
  checks++
}

// ── Outline-writing handlers (write-outline, build, export/publish handout, present, thumbnails…) ──
symlinkSync(join(outside, 'victim', 'victim-outline.md'), join(vault, 'Work', 'linked-outline.md'))
for (const outline of [
  join(outside, 'victim', 'victim-outline.md'),
  join(vault, 'link-out', 'victim', 'victim-outline.md'),
  join(vault, '..', 'outside', 'victim', 'victim-outline.md'),
  join(vault, 'Work', 'linked-outline.md'), // a link to an outline outside
  join(vault, 'Work', 'notes.md'), // not an outline
  'age-of-the-claw/age-of-the-claw-outline.md', // relative
  '', 42, null
]) {
  const r = outlineInVault(vault, outline)
  refused(r, 'outside-vault', `outline refuses ${JSON.stringify(outline)}`)
  act.write(r)
}
refused(outlineInVault(null, join(vault, 'root-talk-outline.md')), 'no-vault', 'outline needs a vault')
for (const outline of [
  join(vault, 'root-talk-outline.md'),
  join(vault, 'age-of-the-claw', 'age-of-the-claw-outline.md'),
  join(vault, CZ_NFD, 'Talk: agenti 2026', 'agenti-outline.md'),
  join(vault, 'Work', 'not-yet-created-outline.md')
]) {
  assert.deepEqual(outlineInVault(vault, outline), { ok: true, path: outline }, `outline ${outline}`)
  checks++
}

// ── The replies the outline handlers return (never throw) for an outline outside the vault ──
{
  const inVault = join(vault, 'age-of-the-claw', 'age-of-the-claw-outline.md')
  const out = join(outside, 'victim', 'victim-outline.md')
  // The case that lost typing: a window still holding a talk after the vault root changed.
  const otherVault = join(scratch, 'other-vault')
  mkdirSync(otherVault)
  assert.deepEqual(outlineSaveRefusal(otherVault, inVault), {
    ok: false, refused: 'outside-vault',
    error: "This talk is not in your current vault; it was not saved. Switch back to that vault to keep editing it."
  }, 'write-outline refusal shape after a vault switch')
  assert.equal(outlineSaveRefusal(vault, inVault), null, 'write-outline allowed in the vault')
  assert.equal(outlineSaveRefusal(vault, out)?.refused, 'outside-vault', 'write-outline refused outside')
  assert.equal(outlineSaveRefusal(null, inVault)?.refused, 'outside-vault', 'write-outline refused with no vault')
  assert.equal(outlineRefusal(otherVault, inVault), 'This talk is not in your current vault, so nothing was written.', 'other handlers get a sentence')
  assert.equal(outlineRefusal(vault, inVault), null, 'other handlers allowed in the vault')
  rmSync(otherVault, { recursive: true })
  checks += 6
}

// ── vault:create-talk ──
for (const [slug, topic, error] of [
  ['..', '', 'unsafe-name'], ['a/b', '', 'unsafe-name'], ['', '', 'unsafe-name'], ['.', 'Work', 'unsafe-name'],
  ['new-talk', '..', 'outside-vault'], ['new-talk', '../outside', 'outside-vault'], ['new-talk', outside, 'outside-vault'],
  ['new-talk', 'link-out', 'outside-vault'], ['evil', 'Work', 'outside-vault'] // Work/evil is a link outside
]) {
  const r = newTalkFolder(vault, slug, topic)
  refused(r, error, `create-talk refuses ${JSON.stringify(slug)} in ${JSON.stringify(topic)}`)
  act.mkdir(r)
}
for (const [slug, topic, expected] of [
  ['brand-new', '', join(vault, 'brand-new')],
  ['brand-new', undefined, join(vault, 'brand-new')],
  ['agenti-3', CZ_NFD, join(vault, CZ_NFD, 'agenti-3')],
  ['deep', 'Work/Oxford', join(vault, 'Work', 'Oxford', 'deep')]
]) {
  const r = newTalkFolder(vault, slug, topic)
  assert.deepEqual(r, { ok: true, path: expected }, `create-talk ${slug} in ${JSON.stringify(topic)}`)
  act.mkdir(r)
  checks++
}

// ── vault:set-root: refused outside the E2E test mode; in it, an absolute existing folder only ──
{
  // The registered handler, lifted from src/main/index.ts and run with spies for the registry
  // adoption (the only way a root is written) and for any direct config write (never).
  const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  const start = source.indexOf("ipcMain.handle('vault:set-root'")
  const code = ts.transpileModule(source.slice(start, source.indexOf('\n})', start) + 3), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const setRootWith = (testMode) => {
    const writes = []
    const adopted = []
    const warnings = []
    let handler
    vm.runInNewContext(code, {
      E2E: testMode, setRootRefusal,
      writeConfig: (patch) => writes.push(patch),
      vaultRegistry: { adoptRoot: (root) => adopted.push(root) },
      searchCache: { clear() {} }, invalidateTalkCache() {}, scheduleVaultWarm() {},
      console: { warn: (...args) => warnings.push(args.join(' ')) },
      ipcMain: { handle: (_name, callback) => { handler = callback } }
    })
    // Objects from the handler's context are compared by value (another realm's prototypes).
    return { call: (path) => JSON.parse(JSON.stringify(handler(null, path))), writes, adopted, warnings }
  }
  const app = setRootWith(false)
  for (const hostile of [vault, '/', join(scratch, '.ssh'), outside, undefined]) {
    assert.deepEqual(app.call(hostile), { success: false, error: SET_ROOT_PICKER_ONLY }, `set-root outside test mode refuses ${hostile}`)
    checks++
  }
  assert.deepEqual(app.writes, [], 'set-root outside test mode writes no config')
  assert.deepEqual(app.adopted, [], 'set-root outside test mode adopts no vault')
  assert.equal(app.warnings.filter((w) => w.includes('[vault:set-root] refused')).length, 5, 'each refusal is logged')
  checks += 2
  const e2e = setRootWith(true)
  writeFileSync(join(scratch, 'a-file'), 'x')
  for (const bad of ['relative/vault', join(scratch, 'missing'), join(scratch, 'a-file'), '', 42, null, vault + '\0']) {
    assert.deepEqual(e2e.call(bad), { success: false, error: SET_ROOT_NOT_A_FOLDER }, `set-root in test mode refuses ${JSON.stringify(bad)}`)
    checks++
  }
  assert.deepEqual(e2e.writes, [], 'a refused path in test mode writes no config')
  assert.deepEqual(e2e.adopted, [], 'a refused path in test mode adopts no vault')
  assert.deepEqual(e2e.call(vault), { success: true }, 'set-root in test mode accepts an existing absolute folder')
  assert.deepEqual(e2e.adopted, [vault], 'an accepted root is adopted through the vault registry')
  assert.deepEqual(e2e.writes, [], 'the handler never writes config directly')
  assert.equal(setRootRefusal(true, outside), null)
  checks += 4
  rmSync(join(scratch, 'a-file'))
}

// ── Nothing outside the scratch vault / userData changed ──
assert.deepEqual(treeOutside(), before, 'tree outside the vault and userData is unchanged')
checks++

rmSync(scratch, { recursive: true, force: true })
console.log(`vault paths: ${checks} checks passed`)
