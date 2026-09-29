// One writer for talk files (spec 2026-09-27, D3; test 2): a talk's identity is its device + inode,
// resolved at every comparison. Seams: outlineIdentity / editorEntryForOutline
// (src/main/outline-identity.ts) over a temp folder of real files, links and hard links, and the
// atomic replace in writeTalkOutline (src/main/talk-writer.ts), which must not change a talk's key.
import assert from 'node:assert/strict'
import { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { editorEntryForOutline, outlineIdentity } from '../src/main/outline-identity.ts'
import { configureTalkWriter, writeTalkOutline } from '../src/main/talk-writer.ts'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'tw-outline-identity-')))
const OUTLINE = '---\ntitle: Identity Talk\n---\n\n## One {id=aa11}\n\n- x\n'
const write = (path, text = OUTLINE) => { writeFileSync(path, text); return path }

try {
  // 1. Two hard links to one file are one talk: one key (a realpath comparison gave two).
  const a = write(join(root, 'a-outline.md'))
  const b = join(root, 'b-outline.md')
  linkSync(a, b)
  assert.equal(statSync(a).nlink, 2, 'fixture: two links to one inode')
  assert.equal(outlineIdentity(a).key, outlineIdentity(b).key, 'hard-link pair → one key')
  assert.notEqual(outlineIdentity(a).realPath, outlineIdentity(b).realPath, 'each link keeps its own real path')
  const st = statSync(a)
  assert.equal(outlineIdentity(a).key, `${st.dev}:${st.ino}`, 'the key is device:inode')

  // 2. A symlink has its target's key; so does a path through a symlinked folder.
  const realDir = join(root, 'real-talk')
  mkdirSync(realDir)
  const target = write(join(realDir, 'real-talk-outline.md'))
  const fileLink = join(root, 'link-outline.md')
  symlinkSync(target, fileLink)
  const dirLink = join(root, 'linked-talk')
  symlinkSync(realDir, dirLink)
  const viaFolder = join(dirLink, 'real-talk-outline.md')
  assert.equal(outlineIdentity(fileLink).key, outlineIdentity(target).key, 'symlink → same key as its target')
  assert.equal(outlineIdentity(viaFolder).key, outlineIdentity(target).key, 'linked folder → same key')
  assert.equal(outlineIdentity(fileLink).realPath, target, 'realPath is the target')

  // 3. Retargeting the link changes its key on the next resolve (nothing is cached).
  const other = write(join(root, 'other-outline.md'), OUTLINE.replace('Identity', 'Other'))
  const before = outlineIdentity(fileLink).key
  unlinkSync(fileLink)
  symlinkSync(other, fileLink)
  const after = outlineIdentity(fileLink)
  assert.notEqual(after.key, before, 'retargeted link → new key')
  assert.equal(after.key, outlineIdentity(other).key, 'the new key is the new target\'s')
  assert.equal(after.realPath, other, 'and so is the real path')

  // 4. A file that does not exist yet: the key falls back to its real path (through a real folder).
  const missing = join(dirLink, 'not-yet-outline.md')
  const id = outlineIdentity(missing)
  assert.equal(id.realPath, join(realDir, 'not-yet-outline.md'), 'missing file resolves through its folder')
  assert.equal(id.key, id.realPath, 'missing file → the key is the real path')

  // 5. The one-window guard (index.ts window:claim-talk → editorEntryForOutline with the asking
  //    window excepted) refuses a second window for a hard-linked alias, and finds the holder by any alias.
  const entries = [{ win: 'idle', outlinePath: null }, { win: 'other', outlinePath: other }, { win: 'first', outlinePath: a }]
  const holder = (path, asking) => editorEntryForOutline(entries, path, () => true, asking)?.win ?? null
  assert.equal(holder(b, 'second'), 'first', 'a second window opening the hard-linked alias is refused (the first window holds it)')
  assert.equal(holder(a, 'first'), null, 'the holder itself re-claiming its own talk is not refused')
  assert.equal(holder(target, 'second'), null, 'an unrelated talk is free')
  assert.equal(editorEntryForOutline(entries, b, (w) => w !== 'first'), null, 'a destroyed window does not hold anything')
  const found = editorEntryForOutline(entries, b, () => true)
  assert.equal(found?.outlinePath, a, 'requests go out in the window\'s own path')

  // 6. The key is stable across writes: the one writer writes in place, so the inode — and with it
  //    the window guard's, the renderer queue's and the lock's key — never moves; a hard-linked pair
  //    stays one talk after a write. A missing file's key changes once, when it is created.
  configureTalkWriter({ editorBufferFor: () => null })
  const solo = write(join(root, 'solo-outline.md'))
  const soloKey = outlineIdentity(solo).key
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await writeTalkOutline(solo, OUTLINE + `\n## Save ${i}\n`, 'editor')).ok, true, 'fixture write succeeded')
    assert.equal(outlineIdentity(solo).key, soloKey, `the key is stable across writes (write ${i + 1})`)
  }
  assert.equal((await writeTalkOutline(a, OUTLINE + '\n## Via a\n', 'tags')).ok, true)
  assert.equal(outlineIdentity(a).key, outlineIdentity(b).key, 'the hard-link pair is still one key after a write')
  assert.equal(readFileSync(b, 'utf8'), OUTLINE + '\n## Via a\n', 'and still one file')
  const fresh = join(root, 'fresh-outline.md')
  assert.equal(outlineIdentity(fresh).key, fresh, 'missing: the path key')
  assert.equal((await writeTalkOutline(fresh, OUTLINE, 'create-talk')).ok, true)
  const created = outlineIdentity(fresh).key
  const fst = statSync(fresh)
  assert.equal(created, `${fst.dev}:${fst.ino}`, 'created: the device:inode key')
  assert.equal((await writeTalkOutline(fresh, OUTLINE + '\n## Next\n', 'editor')).ok, true)
  assert.equal(outlineIdentity(fresh).key, created, 'and stable from then on')
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('outline identity: hard links, symlinks, linked folders, retarget, missing-file fallback, window guard on a hard-linked alias, key stable across writes passed')
