// shell:open-path / shell:show-item-in-folder take a path from the renderer (src/main/shell-path-policy.ts):
// only paths inside an open vault, and open-path only folders and documents — never an app bundle,
// installer, script or executable. Real temp folders and symlinks; the callers' real path shapes
// (a talk's outline, <talk>/dist builds and handouts, `${vaultRoot}/${outline}`).
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decideShellPath, isFinderAlias } from '../src/main/shell-path-policy.ts'

const base = realpathSync(mkdtempSync(join(tmpdir(), 'tw-shell-path-')))
const dir = (...parts) => { const p = join(base, ...parts); mkdirSync(p, { recursive: true }); return p }
const file = (path, text = 'x') => { writeFileSync(path, text); return path }

const vaultA = dir('Vault A')
const vaultB = dir('Vault B')
const outside = dir('Elsewhere')
const talk = dir('Vault A', 'Talks', 'My talk')
const outline = file(join(talk, 'my-talk-outline.md'))
const dist = dir('Vault A', 'Talks', 'My talk', 'dist')
const full = file(join(dist, 'my-talk-full.html'))
const handout = file(join(dist, 'my-talk-handout.html'))
const jsonl = file(join(dist, 'my-talk-slides.jsonl'))
const otherOutline = file(join(dir('Vault B', 'Other'), 'other-outline.md'))
const roots = [vaultA, vaultB]

let passed = 0
const test = (name, fn) => {
  try { fn(); passed++; console.log(`  ok  ${name}`) } catch (err) { console.error(`  FAIL ${name}`); throw err }
}
const open = (p, r = roots) => decideShellPath('open', p, r)
const reveal = (p, r = roots) => decideShellPath('reveal', p, r)

console.log('shell path policy')

test('the legitimate callers: outlines, builds, handouts, folders, in any open vault', () => {
  for (const p of [outline, full, handout, jsonl, talk, dist, vaultA, otherOutline, `${vaultA}/Talks/My talk/my-talk-outline.md`]) {
    assert.deepEqual(open(p), { ok: true, path: realpathSync(p) }, p)
    assert.deepEqual(reveal(p), { ok: true, path: p }, p)
  }
})

test('anything outside the open vaults is refused, both actions', () => {
  const stray = file(join(outside, 'notes.md'))
  for (const p of [stray, outside, base, '/etc/passwd', '/Applications/Calculator.app', '/usr/bin/env', join(vaultA, '..', 'Elsewhere', 'notes.md')]) {
    assert.deepEqual(open(p), { ok: false, reason: 'outside-vaults' }, p)
    assert.deepEqual(reveal(p), { ok: false, reason: 'outside-vaults' }, p)
  }
  assert.deepEqual(open(outline, []), { ok: false, reason: 'outside-vaults' }, 'no open vault')
  assert.deepEqual(open(otherOutline, [vaultA]), { ok: false, reason: 'outside-vaults' }, 'a closed vault')
})

test('not a usable path', () => {
  for (const p of [undefined, null, 42, '', 'relative/outline.md', 'Talks/My talk/my-talk-outline.md', `${outline}\0.md`, 'https://example.com/x.html']) {
    assert.deepEqual(open(p), { ok: false, reason: 'not-a-path' }, String(p))
    assert.deepEqual(reveal(p), { ok: false, reason: 'not-a-path' }, String(p))
  }
})

test('a symlink is judged as what it points to', () => {
  const inLink = join(talk, 'link-to-outline.md')
  symlinkSync(outline, inLink)
  assert.deepEqual(open(inLink), { ok: true, path: outline })
  const outLink = join(talk, 'escape.md')
  symlinkSync(file(join(outside, 'secret.md')), outLink)
  assert.deepEqual(open(outLink), { ok: false, reason: 'outside-vaults' })
  assert.deepEqual(reveal(outLink), { ok: false, reason: 'outside-vaults' })
  const dirLink = join(vaultA, 'linked-dir')
  symlinkSync(outside, dirLink)
  assert.deepEqual(open(join(dirLink, 'secret.md')), { ok: false, reason: 'outside-vaults' })
  const disguised = join(talk, 'slides.html')
  symlinkSync(file(join(talk, 'run.command'), '#!/bin/sh\necho hi'), disguised)
  assert.deepEqual(open(disguised), { ok: false, reason: 'not-openable' }, 'an .html link to a script inside the vault')
})

test('open-path refuses apps, installers, scripts and executables inside a vault; reveal still shows them', () => {
  const evil = dir('Vault A', 'Talks', 'My talk', 'assets')
  for (const name of ['run.command', 'run.sh', 'install.pkg', 'disk.dmg', 'setup.exe', 'setup.msi', 'run.bat', 'run.cmd', 'run.ps1',
    'x.js', 'x.vbs', 'x.wsf', 'x.jar', 'x.py', 'x.scpt', 'x.applescript', 'x.terminal', 'x.webloc', 'x.url', 'x.fileloc', 'x.desktop',
    'x.AppImage', 'x.deb', 'x.lnk', 'x.docm', 'x.pptm', 'x.xlsm', 'tool', 'Makefile', '.hidden']) {
    const p = file(join(evil, name))
    assert.equal(open(p).ok, false, name)
    assert.equal(reveal(p).ok, true, name)
  }
  const bin = file(join(evil, 'mach-o-binary'), '\xcf\xfa\xed\xfe'); chmodSync(bin, 0o755)
  assert.deepEqual(open(bin), { ok: false, reason: 'not-openable' }, 'an extensionless executable')
})

test('app bundles: neither the bundle folder nor anything inside it is opened', () => {
  const app = dir('Vault A', 'Talks', 'My talk', 'Thing.app', 'Contents', 'MacOS')
  const exe = file(join(app, 'Thing'))
  const plist = file(join(app, '..', 'Info.plist'))
  const readme = file(join(app, 'readme.md'))
  for (const p of [join(talk, 'Thing.app'), exe, plist, readme]) assert.deepEqual(open(p), { ok: false, reason: 'inside-bundle' }, p)
  for (const name of ['Installer.pkg', 'Flow.workflow', 'Script.scptd', 'Pane.prefPane', 'Ext.APP']) {
    assert.deepEqual(open(dir('Vault A', name)), { ok: false, reason: 'inside-bundle' }, name)
  }
  assert.equal(reveal(join(talk, 'Thing.app')).ok, true)
})

test('documents and media open; extensions are case-insensitive; plain folders with dots open', () => {
  for (const name of ['deck.PDF', 'photo.JPG', 'talk.pptx', 'clip.mp4', 'audio.m4a', 'notes.txt', 'a.svg']) {
    const p = file(join(dist, name))
    assert.equal(open(p).ok, true, name)
  }
  assert.equal(open(dir('Vault A', 'Talk v1.2')).ok, true, 'a folder name with a dot is still a folder')
})

test('a Finder alias is refused, whatever it is named (Codex review, PR #9)', () => {
  // Bookmark-format alias: "book" at byte 0, "mark" at byte 8. Renamed to an allowed suffix it
  // would pass the extension check, and Launch Services would open its target.
  const header = Buffer.concat([Buffer.from('book'), Buffer.alloc(4), Buffer.from('mark'), Buffer.alloc(20)])
  const alias = join(dist, 'report.pdf')
  writeFileSync(alias, header)
  assert.equal(isFinderAlias(alias), true)
  assert.deepEqual(decideShellPath('open', alias, roots), { ok: false, reason: 'finder-alias' })
  assert.equal(decideShellPath('reveal', alias, roots).ok, true, 'revealing it launches nothing')
  assert.equal(isFinderAlias(full), false, 'an ordinary document is not an alias')
  assert.equal(isFinderAlias(join(dist, 'missing.pdf')), false)
  assert.deepEqual(decideShellPath('open', full, roots, { isAlias: () => true }), { ok: false, reason: 'finder-alias' }, 'the alias test decides')
})

test('injected deps: containment and folder test are what decide', () => {
  const calls = []
  const d = decideShellPath('open', '/v/x.md', ['/v', '/w'], { inside: (root, p) => { calls.push(root); return root === '/w' ? p : null }, isDirectory: () => false })
  assert.deepEqual(d, { ok: true, path: '/v/x.md' })
  assert.deepEqual(calls, ['/v', '/w'])
  assert.deepEqual(decideShellPath('open', '/v/folder', ['/v'], { inside: (_r, p) => p, isDirectory: () => true }), { ok: true, path: '/v/folder' })
  assert.deepEqual(decideShellPath('open', '/v/tool', ['/v'], { inside: (_r, p) => p, isDirectory: () => false }), { ok: false, reason: 'not-openable' })
})

console.log(`shell path policy: ${passed} passed`)
