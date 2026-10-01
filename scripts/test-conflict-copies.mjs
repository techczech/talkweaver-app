// Conflict copies (several-vaults ticket 09; src/main/conflict-copies.mjs header).
// Seams: classifyConflict(listing, canonicalOutline) — pure, table-tested; createConflictScanner —
// over a real temp folder with an injected trash (a folder standing in for the OS Trash); the vault
// walk (createVaultIndex with scanConflicts); the outline pick (talk-scan.mjs pickOutlineName).
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, linkSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import {
  classifyConflict, conflictServiceOf, conflictCandidateNames, hasGitConflictMarkers, createConflictScanner, identicalCopyActivity,
  isMachineName, machineSlug, resolveByRealRoot
} from '../src/main/conflict-copies.mjs'
import { createVaultMachines } from '../src/main/vault-machines.ts'
import { pickOutlineName, pickOutlineEntry, scanTalkFoldersSync } from '../src/main/talk-scan.mjs'
import { createVaultIndex } from '../src/main/vault-index.mjs'
import { pathStaysInside } from '../src/main/path-containment.ts'

let passed = 0
const test = async (name, fn) => { await fn(); passed += 1; console.log(`ok  ${name}`) }

const S = 'ai-workshop-outline.md'
const TEXT = '---\ntitle: AI and assessment workshop\n---\n\n### Slide {id=abc12}\n'

// ── classifier table ──
const table = [
  // [file name, expected service or null, expected source]
  ['ai-workshop-outline-MacBook-Air.md', 'onedrive', 'MacBook-Air'],
  ['ai-workshop-outline-DESKTOP-4F2K9.md', 'onedrive', 'DESKTOP-4F2K9'],
  ['ai-workshop-outline-Dominiks-MacBook-Pro.md', 'onedrive', 'Dominiks-MacBook-Pro'],
  ['ai-workshop-MacBook-Air-outline.md', 'onedrive', 'MacBook-Air'],
  ["ai-workshop-outline (Dominik Lukeš's conflicted copy 2026-09-30).md", 'dropbox', 'Dominik Lukeš'],
  ['ai-workshop-outline (conflicted copy 2026-09-30 091400).md', 'dropbox', null],
  ['ai-workshop-outline (1).md', 'gdrive', null],
  ['ai-workshop-outline(1).md', 'gdrive', null],
  ['ai-workshop-outline (2).md', 'gdrive', null],
  // non-matches: the author's own siblings and other talks
  ['ai-workshop-outline.md', null],
  ['ai-workshop-notes.md', null],
  ['ai-workshop-outline-notes.md', null],
  ['ai-workshop-outline-v2.md', null],
  ['ai-workshop-2-outline.md', null],
  ['ai-workshop-handout-outline.md', null],
  ['other-talk-outline.md', null],
  ['ai-workshop-outline (draft).md', null],
  ['ai-workshop-outline (123).md', null],
  ['ai-workshop-outline-MacBook-Air.txt', null],
  ['xai-workshop-outline-MacBook-Air.md', null],
  ['ai-workshop-outline-Mac Book.md', null],
  // review S3: rule (b) — whole hyphen-separated tokens that name a machine, or Windows' default names
  ['ai-workshop-outline-iMac.md', 'onedrive', 'iMac'],
  ['ai-workshop-outline-Mac-mini.md', 'onedrive', 'Mac-mini'],
  ['ai-workshop-outline-Mini.md', 'onedrive', 'Mini'],
  ['ai-workshop-outline-Dominiks-Air.md', 'onedrive', 'Dominiks-Air'],
  ['ai-workshop-outline-Anna-Studio.md', 'onedrive', 'Anna-Studio'],
  ['ai-workshop-outline-Office-PC.md', 'onedrive', 'Office-PC'],
  ['ai-workshop-outline-LAPTOP-7Q.md', 'onedrive', 'LAPTOP-7Q'],
  ['ai-workshop-outline-desktop-abc12.md', 'onedrive', 'desktop-abc12'],
  // …and nothing else: tags and words that only contain a machine word are the author's own files
  ['ai-workshop-outline-EN.md', null],
  ['ai-workshop-outline-Draft.md', null],
  ['ai-workshop-outline-V2.md', null],
  ['ai-workshop-outline-final.md', null],
  ['ai-workshop-outline-machine.md', null],
  ['ai-workshop-outline-minimal.md', null],
  ['ai-workshop-outline-topcoat.md', null],
  ['ai-workshop-outline-final-draft.md', null],
  ['ai-workshop-outline-home-server.md', null],
  ['ai-workshop-outline-GamingPC.md', null],
  ['ai-workshop-outline-macek.md', null], // a host name no rule can guess: only rule (a)
  ['ai-workshop-outline-DESKTOP.md', null],
  // a lowercase host name this rule cannot know: only rule (a) (see the next test)
  ['ai-workshop-outline-kestrel.md', null]
]
await test(`the naming table (${table.length} rows): each service, and non-matches such as S-notes.md`, () => {
  for (const [name, service, source] of table) {
    const got = conflictServiceOf(name, S)
    assert.equal(got?.service ?? null, service, name)
    if (service) assert.equal(got.source, source, name)
  }
})

await test('rule (a): a machine name known for the vault counts, slugged the way OneDrive writes it', () => {
  const known = { knownMachines: ['kestrel.local', 'Dominik’s studio box'] }
  assert.deepEqual(conflictServiceOf('ai-workshop-outline-kestrel.md', S, known), { service: 'onedrive', source: 'kestrel' })
  assert.deepEqual(conflictServiceOf('ai-workshop-outline-KESTREL.md', S, known)?.service, 'onedrive')
  assert.equal(conflictServiceOf('ai-workshop-outline-Draft.md', S, known), null)
  assert.equal(conflictServiceOf('ai-workshop-outline-macek.md', S, { knownMachines: ['Macek'] })?.source, 'macek')
  assert.equal(conflictServiceOf('ai-workshop-outline-home-server.md', S, { knownMachines: ['home server'] })?.service, 'onedrive')
  assert.equal(machineSlug('Dominik’s MacBook Air'), 'Dominiks-MacBook-Air')
  assert.equal(machineSlug('zeus.local'), 'zeus')
  assert.equal(isMachineName('EN'), false)
  assert.equal(isMachineName('EN', { loose: true }), true, 'the walk hands every suffix to the scanner')
  assert.equal(isMachineName('x-outline', { loose: true }), false)
})

await test('this Mac and machines seen are remembered per vault in app data', () => {
  const base = mkdtempSync(join(tmpdir(), 'tw-machines-'))
  try {
    const file = join(base, 'vault-machines.json')
    let asked = 0
    const m = createVaultMachines({ file, thisMac: () => { asked += 1; return ['kestrel.local', 'Dominik’s MacBook Air'] } })
    assert.equal(asked, 0, 'this Mac is asked on first use, not at creation')
    assert.deepEqual(m.known('v1'), ['kestrel', 'Dominiks-MacBook-Air'])
    m.remember('v1', ['DESKTOP-4F2K9', 'kestrel'])
    assert.deepEqual(createVaultMachines({ file, thisMac: [] }).known('v1'), ['kestrel', 'Dominiks-MacBook-Air', 'DESKTOP-4F2K9'])
    assert.deepEqual(createVaultMachines({ file, thisMac: [] }).known('v2'), [])
    assert.equal(asked, 1)
  } finally { rmSync(base, { recursive: true, force: true }) }
})

await test('conflictCandidateNames keeps listing order and only copies', () => {
  const names = ['ai-workshop-outline.md', 'ai-workshop-outline (1).md', 'ai-workshop-notes.md', 'ai-workshop-outline-MacBook-Air.md']
  assert.deepEqual(conflictCandidateNames(names, S), ['ai-workshop-outline (1).md', 'ai-workshop-outline-MacBook-Air.md'])
})

const gitTable = [
  ['<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> origin/main\n', true],
  ['intro\n<<<<<<< ours\na\n=======\nb\n>>>>>>> theirs\nrest\n', true],
  ['<<<<<<<\na\n=======\nb\n>>>>>>>\n', true],
  ['Title\n=======\n\nText\n', false], // a setext heading underline
  ['  <<<<<<< HEAD\na\n=======\nb\n  >>>>>>> x\n', false], // not at line starts
  ['<<<<<<< HEAD\nno separator\n>>>>>>> x\n', false],
  ['>>>>>>> x\n=======\n<<<<<<< HEAD\n', false], // wrong order
  ['plain text with <<<<<<< inline\n', false],
  // review S2: a conflict shown as code in a fenced block is content, not a conflict
  ['```\n<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> b\n```\n', false],
  ['~~~text\n<<<<<<< HEAD\na\n=======\nb\n>>>>>>> b\n~~~\n', false],
  ['````\n```\n<<<<<<< HEAD\na\n=======\nb\n>>>>>>> b\n````\n', false], // an inner shorter fence does not close
  ['```\ncode\n```\n<<<<<<< HEAD\na\n=======\nb\n>>>>>>> b\n', true] // after the fence closes, it counts
]
await test(`Git markers at line starts only, in order (${gitTable.length} rows)`, () => {
  for (const [text, want] of gitTable) assert.equal(hasGitConflictMarkers(text), want, JSON.stringify(text))
  assert.equal(hasGitConflictMarkers('a\r\n<<<<<<< HEAD\r\nx\r\n=======\r\ny\r\n>>>>>>> b\r\n'), true)
})

await test('classifyConflict: identical bytes, differing bytes, unread bytes, Git markers, non-matches', () => {
  const listing = [
    { name: S, bytes: TEXT },
    { name: 'ai-workshop-outline-MacBook-Air.md', bytes: Buffer.from(TEXT) },
    { name: "ai-workshop-outline (Anna's conflicted copy 2026-09-30).md", bytes: TEXT + 'more\n' },
    { name: 'ai-workshop-outline (1).md' }, // not read: never judged identical
    { name: 'ai-workshop-notes.md', bytes: TEXT },
    { name: 'ai-workshop-outline-notes.md', bytes: TEXT }
  ]
  assert.deepEqual(classifyConflict(listing, { name: S, bytes: TEXT }), [
    { name: 'ai-workshop-outline-MacBook-Air.md', service: 'onedrive', source: 'MacBook-Air', state: 'identical' },
    { name: "ai-workshop-outline (Anna's conflicted copy 2026-09-30).md", service: 'dropbox', source: 'Anna', state: 'differs' },
    { name: 'ai-workshop-outline (1).md', service: 'gdrive', source: null, state: 'differs' }
  ])
  const marked = '---\ntitle: x\n---\n<<<<<<< HEAD\n### A\n=======\n### B\n>>>>>>> theirs\n'
  assert.deepEqual(classifyConflict([{ name: S, bytes: marked }], { name: S, bytes: marked }), [
    { name: S, service: 'git', source: null, state: 'git-markers' }
  ])
  assert.deepEqual(classifyConflict([], { name: S, bytes: TEXT }), [])
  // review T1: an empty outline is never the reference for "identical"
  assert.equal(classifyConflict([{ name: 'ai-workshop-outline (1).md', bytes: '' }], { name: S, bytes: '' })[0].state, 'differs')
  assert.deepEqual(classifyConflict([{ name: 'x.md', bytes: '' }], null), [])
})

await test('the Activity line names the machine when the service does (LOCKED-conflict frame 5)', () => {
  const line = identicalCopyActivity({ name: 'ai-workshop-outline-MacBook-Air.md', service: 'onedrive', source: 'MacBook-Air', state: 'identical' }, '2026-09-30T09:14:00Z')
  assert.equal(line.title, 'Removed an identical copy from MacBook Air')
  assert.equal(line.detail, 'It matched this file byte for byte, so nothing was lost.')
  assert.equal(identicalCopyActivity({ name: 'ai-workshop-outline (1).md', service: 'gdrive', source: null }, 'x').title, 'Removed an identical copy (ai-workshop-outline (1).md)')
})

// ── outline pick ──
const dirent = (name, file = true) => ({ name, isFile: () => file, isDirectory: () => !file })
await test('outline pick: a single outline is the talk, whatever its name (no change for existing talks)', () => {
  const singles = [
    [['ai-workshop-outline.md', 'notes.md'], 'ai-workshop'],
    [['talk-outline.md'], 'a folder with another name'],
    [['foo-MacBook-outline.md'], 'foo'],
    [['README.md', 'x-outline.md', 'y.md'], 'x'],
    [['ai-workshop-outline-MacBook-Air.md', 'ai-workshop-outline.md'], 'ai-workshop'] // the copy is not *-outline.md
  ]
  for (const [names, folder] of singles) {
    const old = names.find((n) => n.endsWith('-outline.md')) ?? null
    assert.equal(pickOutlineName(names, folder), old, names.join(','))
    assert.equal(pickOutlineEntry(names.map((n) => dirent(n)), folder)?.name ?? null, old)
  }
  assert.equal(pickOutlineName(['notes.md'], 'x'), null)
  assert.equal(pickOutlineEntry([dirent('dir-outline.md', false)], 'dir'), null)
})
await test('outline pick with several outlines: the folder slug wins; a conflict copy never shadows the original', () => {
  assert.equal(pickOutlineName(['foo-MacBook-outline.md', 'foo-outline.md'], 'foo'), 'foo-outline.md')
  assert.equal(pickOutlineName(['foo-MacBook-outline.md', 'foo-outline.md'], 'Foo talk (renamed folder)'), 'foo-outline.md')
  assert.equal(pickOutlineName(['bar-outline.md', 'foo-outline.md'], 'foo'), 'foo-outline.md')
  assert.equal(pickOutlineName(['bar-outline.md', 'foo-outline.md'], 'other'), 'bar-outline.md') // no rule applies: the first, as before
})
await test('the synchronous walk uses the fixed pick', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tw-conflict-walk-')))
  try {
    mkdirSync(join(root, 'foo'))
    writeFileSync(join(root, 'foo', 'foo-MacBook-outline.md'), TEXT)
    writeFileSync(join(root, 'foo', 'foo-outline.md'), TEXT)
    assert.deepEqual(scanTalkFoldersSync(root).map((t) => t.outlineName), ['foo-outline.md'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// ── scanner over a real folder, injected trash ──
function harness({ canTouch = () => true, withLock, knownMachines, rememberMachines } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'tw-conflict-scan-')))
  const folder = join(base, 'vault', 'ai-workshop')
  const trash = join(base, 'Trash')
  mkdirSync(folder, { recursive: true })
  mkdirSync(trash)
  writeFileSync(join(folder, S), TEXT)
  const trashed = []
  const lines = []
  const scanner = createConflictScanner({
    trashItem: async (p) => { trashed.push(p); renameSync(p, join(trash, basename(p))) },
    staysInside: pathStaysInside,
    activity: { append: async (vaultId, slug, entry) => { lines.push({ vaultId, slug, entry }) } },
    canTouch,
    ...(withLock ? { withLock } : {}),
    ...(knownMachines ? { knownMachines } : {}),
    ...(rememberMachines ? { rememberMachines } : {}),
    now: () => '2026-09-30T09:14:00.000Z'
  })
  const scan = (names) => scanner.scanFolder({ vaultId: 'v1', folder, outlineName: S, slug: 'ai-workshop', names })
  return { base, folder, trash, trashed, lines, scan, done: () => rmSync(base, { recursive: true, force: true }) }
}

await test('an identical copy goes to the Trash (never unlinked) with one Activity line; nothing is counted', async () => {
  const h = harness()
  try {
    writeFileSync(join(h.folder, 'ai-workshop-outline-MacBook-Air.md'), TEXT)
    const r = await h.scan()
    assert.deepEqual(r, { conflicts: 0, copies: [], trashed: ['ai-workshop-outline-MacBook-Air.md'] })
    assert.deepEqual(readdirSync(h.trash), ['ai-workshop-outline-MacBook-Air.md'])
    assert.equal(readFileSync(join(h.trash, 'ai-workshop-outline-MacBook-Air.md'), 'utf8'), TEXT)
    assert.equal(readFileSync(join(h.folder, S), 'utf8'), TEXT, 'the outline is untouched')
    assert.equal(h.lines.length, 1)
    assert.deepEqual(h.lines[0], { vaultId: 'v1', slug: 'ai-workshop', entry: {
      at: '2026-09-30T09:14:00.000Z', kind: 'identical-copy-removed', copyName: 'ai-workshop-outline-MacBook-Air.md', service: 'onedrive',
      title: 'Removed an identical copy from MacBook Air', detail: 'It matched this file byte for byte, so nothing was lost.'
    } })
  } finally { h.done() }
})

await test('the last byte check and the move run under the outline lock (review T1)', async () => {
  let held = false
  const events = []
  const h = harness({ withLock: async (path, work) => { events.push(`lock ${basename(path)}`); held = true; try { return await work() } finally { held = false } } })
  try {
    writeFileSync(join(h.folder, 'ai-workshop-outline-MacBook-Air.md'), TEXT)
    const origTrash = h.trashed.push.bind(h.trashed)
    h.trashed.push = (p) => { events.push(`trash while locked=${held}`); return origTrash(p) }
    await h.scan()
    assert.deepEqual(events, [`lock ${S}`, 'trash while locked=true'])
  } finally { h.done() }
})

await test('an empty outline and an empty copy: nothing is trashed (review T1)', async () => {
  const h = harness()
  try {
    writeFileSync(join(h.folder, S), '')
    writeFileSync(join(h.folder, 'ai-workshop-outline-MacBook-Air.md'), '')
    const r = await h.scan()
    assert.equal(h.trashed.length, 0)
    assert.equal(r.conflicts, 1)
  } finally { h.done() }
})

await test('the scanner uses the vault’s known machines and remembers the ones it sees; tags like -EN stay', async () => {
  const remembered = []
  const h = harness({ knownMachines: async () => ['kestrel'], rememberMachines: (v, names) => remembered.push(v, ...names) })
  try {
    writeFileSync(join(h.folder, 'ai-workshop-outline-kestrel.md'), TEXT)
    writeFileSync(join(h.folder, 'ai-workshop-outline-EN.md'), TEXT) // an intentional identical sibling
    writeFileSync(join(h.folder, 'ai-workshop-outline-Draft.md'), TEXT)
    const r = await h.scan()
    assert.deepEqual(r.trashed, ['ai-workshop-outline-kestrel.md'])
    assert.ok(existsSync(join(h.folder, 'ai-workshop-outline-EN.md')) && existsSync(join(h.folder, 'ai-workshop-outline-Draft.md')))
    assert.deepEqual(remembered, ['v1', 'kestrel'])
  } finally { h.done() }
})

await test('a vault root registered through a symlink is found from a real path (review S1)', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'tw-conflict-real-')))
  try {
    mkdirSync(join(base, 'real', 'talks', 'foo'), { recursive: true })
    symlinkSync(join(base, 'real'), join(base, 'link'))
    const vaults = [{ id: 'other', root: join(base, 'nowhere') }, { id: 'linked', root: join(base, 'link') }]
    const hit = resolveByRealRoot(vaults, join(base, 'real', 'talks', 'foo'), realpathSync)
    assert.equal(hit.vault.id, 'linked')
    assert.equal(hit.rel, 'talks/foo')
    assert.equal(resolveByRealRoot(vaults, join(base, 'elsewhere'), realpathSync), null)
  } finally { rmSync(base, { recursive: true, force: true }) }
})

await test('a differing copy is counted and nothing is written or moved', async () => {
  const h = harness()
  try {
    writeFileSync(join(h.folder, 'ai-workshop-outline (1).md'), TEXT + 'changed\n')
    writeFileSync(join(h.folder, "ai-workshop-outline (Anna's conflicted copy 2026-09-30).md"), 'other\n')
    const before = readdirSync(h.folder).sort()
    const r = await h.scan()
    assert.equal(r.conflicts, 2)
    assert.deepEqual(r.copies.map((c) => c.state), ['differs', 'differs'])
    assert.deepEqual(readdirSync(h.folder).sort(), before)
    assert.equal(h.trashed.length + h.lines.length, 0)
  } finally { h.done() }
})

await test('Git markers in the outline count as one conflict; the outline is never trashed', async () => {
  const h = harness()
  try {
    const marked = TEXT + '<<<<<<< HEAD\n### A\n=======\n### B\n>>>>>>> theirs\n'
    writeFileSync(join(h.folder, S), marked)
    const r = await h.scan()
    assert.equal(r.conflicts, 1)
    assert.equal(r.copies[0].state, 'git-markers')
    assert.equal(readFileSync(join(h.folder, S), 'utf8'), marked)
    assert.equal(h.trashed.length, 0)
  } finally { h.done() }
})

await test('several copies: identical ones go, differing ones are counted', async () => {
  const h = harness()
  try {
    writeFileSync(join(h.folder, 'ai-workshop-outline-MacBook-Air.md'), TEXT)
    writeFileSync(join(h.folder, 'ai-workshop-outline(1).md'), TEXT)
    writeFileSync(join(h.folder, 'ai-workshop-outline-DESKTOP-1.md'), 'x')
    writeFileSync(join(h.folder, 'ai-workshop-outline (2).md'), 'y')
    const r = await h.scan()
    assert.equal(r.conflicts, 2)
    assert.deepEqual(readdirSync(h.trash).sort(), ['ai-workshop-outline(1).md', 'ai-workshop-outline-MacBook-Air.md'])
    assert.equal(h.lines.length, 2)
  } finally { h.done() }
})

await test('a symlink or hard link to the outline is never trashed; symlinks are not listed (files only)', async () => {
  const h = harness()
  try {
    symlinkSync(join(h.folder, S), join(h.folder, 'ai-workshop-outline-MacBook-Air.md'))
    linkSync(join(h.folder, S), join(h.folder, 'ai-workshop-outline (1).md'))
    writeFileSync(join(h.base, 'outside.md'), TEXT)
    symlinkSync(join(h.base, 'outside.md'), join(h.folder, 'ai-workshop-outline (2).md'))
    const r = await h.scan()
    assert.equal(h.trashed.length, 0)
    // Files only, as the walk lists them (review T2): the two symlinks are not candidates at all; the
    // hard link is a file, refused for the Trash, so it is shown.
    assert.equal(r.conflicts, 1)
    assert.ok(existsSync(join(h.folder, S)))
  } finally { h.done() }
})

await test('a copy that changes between the scan and the move stays (bytes re-checked right before)', async () => {
  const h = harness()
  try {
    const copy = join(h.folder, 'ai-workshop-outline-MacBook-Air.md')
    writeFileSync(copy, TEXT)
    // A listing that raced: the scan reads bytes, then the copy changes before the trash step.
    let reads = 0
    const scanner = createConflictScanner({
      trashItem: async (p) => { h.trashed.push(p) },
      staysInside: pathStaysInside,
      activity: { append: async () => { h.lines.push(1) } },
      fs: { readFile: async (p) => { const b = readFileSync(p); if (p === copy && ++reads === 1) writeFileSync(copy, TEXT + 'edited\n'); return b } }
    })
    const r = await scanner.scanFolder({ vaultId: 'v1', folder: h.folder, outlineName: S, slug: 'ai-workshop' })
    assert.equal(h.trashed.length, 0)
    assert.equal(h.lines.length, 0)
    assert.equal(r.conflicts, 1, 'shown as a differing copy')
  } finally { h.done() }
})

await test('a vault that may not be touched (closed or unavailable) is not read and nothing moves', async () => {
  const h = harness({ canTouch: () => false })
  try {
    writeFileSync(join(h.folder, 'ai-workshop-outline-MacBook-Air.md'), TEXT)
    assert.equal(await h.scan(), null)
    assert.equal(h.trashed.length, 0)
    assert.ok(existsSync(join(h.folder, 'ai-workshop-outline-MacBook-Air.md')))
  } finally { h.done() }
})

await test('a trash that fails leaves the copy shown, never hidden', async () => {
  const h = harness()
  try {
    writeFileSync(join(h.folder, 'ai-workshop-outline-MacBook-Air.md'), TEXT)
    const scanner = createConflictScanner({
      trashItem: async () => { throw new Error('no Trash') },
      staysInside: pathStaysInside,
      activity: { append: async () => { h.lines.push(1) } }
    })
    const r = await scanner.scanFolder({ vaultId: 'v1', folder: h.folder, outlineName: S, slug: 'ai-workshop' })
    assert.equal(r.conflicts, 1)
    assert.equal(h.lines.length, 0)
  } finally { h.done() }
})

// ── the vault walk hands only folders with candidates to the scanner ──
await test('the vault walk: conflicts per talk, the scanner called only where a candidate or marker is, no second walk', async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'tw-conflict-index-')))
  try {
    const root = join(base, 'V')
    const mk = (slug, text = TEXT) => { mkdirSync(join(root, slug), { recursive: true }); writeFileSync(join(root, slug, `${slug}-outline.md`), text) }
    mk('clean'); mk('copy'); mk('marked', TEXT + '<<<<<<< a\nx\n=======\ny\n>>>>>>> b\n'); mk('shadow')
    writeFileSync(join(root, 'copy', 'copy-outline (1).md'), 'differs')
    writeFileSync(join(root, 'clean', 'clean-notes.md'), 'mine')
    writeFileSync(join(root, 'shadow', 'shadow-MacBook-outline.md'), TEXT)
    const calls = []
    const index = createVaultIndex({ dir: join(base, 'idx'), scanConflicts: async (input) => { calls.push(input.slug); return input.slug === 'shadow' ? 0 : null } })
    const talks = await index.refresh({ id: 'v', root })
    const by = Object.fromEntries(talks.map((t) => [t.slug, t]))
    assert.deepEqual(Object.keys(by).sort(), ['clean', 'copy', 'marked', 'shadow'], 'the shadowing copy is not a talk of its own')
    assert.equal(by.shadow.outlinePath, join(root, 'shadow', 'shadow-outline.md'))
    assert.deepEqual(calls.sort(), ['copy', 'marked', 'shadow'])
    assert.equal(by.clean.conflicts, 0)
    assert.equal(by.copy.conflicts, 1)
    assert.equal(by.marked.conflicts, 1)
    assert.equal(by.shadow.conflicts, 0, 'the scanner count wins')
    assert.equal('gitMarkers' in by.marked, false, 'internal fields stay out of the public talk')
    // A second refresh with nothing changed reads no outline in full again (mtime-cached markers) and
    // still counts; setConflicts updates the held snapshot.
    calls.length = 0
    const again = await index.refresh({ id: 'v', root })
    assert.equal(again.find((t) => t.slug === 'marked').conflicts, 1)
    assert.equal(index.setConflicts('v', by.copy.outlinePath, 0).conflicts, 0)
    assert.equal((await index.cached({ id: 'v', root })).find((t) => t.slug === 'copy').conflicts, 0)
    assert.equal(index.setConflicts('v', join(root, 'nope-outline.md'), 1), null)
    // A closed vault is never walked, so never scanned.
    calls.length = 0
    assert.deepEqual(await index.refresh({ id: 'v', root, open: false }), [])
    assert.deepEqual(calls, [])
  } finally { rmSync(base, { recursive: true, force: true }) }
})

console.log(`\n${passed} passed`)
