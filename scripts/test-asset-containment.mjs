// 0.38 ticket 10 — "A talk cannot pull a file from outside its vault into published output".
// The containment function on its own (compiler/scripts/lib/asset-containment.mjs, ADR-0036), in a
// folder tree this test builds:
//
//   <base>/vault/                      the allowed root
//     talk/pic.png                     an ordinary file
//     talk/assets/Pasted image.png     a name with a space (written percent-encoded by editors)
//     _assets/img-abc1234.png          pooled media, referenced by absolute path
//     talk/link-in.png      → ../_assets/img-abc1234.png     (a link that stays inside: allowed)
//     talk/link-out.png     → <base>/outside/secret.png      (a file link that leaves)
//     talk/dir-out          → <base>/outside                 (a folder link that leaves)
//     talk/dangling.png     → <base>/outside/not-there.png   (a link to nothing, outside)
//     talk/pipe                                              (a FIFO)
//   <base>/vault-evil/secret.png       a sibling whose name starts with the root's name
//   <base>/outside/secret.png          the file a talk must never reach
//   <base>/vault-link → <base>/vault   the root reached through a link
import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, symlink, realpath, rm } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const { resolveContainedFile, createAssetContainment, isInsideRealRoot, remoteReferenceUrl } = await import(
  pathToFileURL(join(process.cwd(), 'compiler/scripts/lib/asset-containment.mjs')).href
)

let failures = 0
const check = async (name, fn) => {
  try { await fn(); console.log(`ok   ${name}`) } catch (error) { failures++; console.error(`FAIL ${name}\n     ${error?.message ?? error}`) }
}

// tmpdir() is itself behind a symlink on macOS (/var → /private/var): keep the UNRESOLVED form for
// what a caller would pass, and the real form for what the function must answer.
const base = await mkdtemp(join(tmpdir(), 'tw-containment-'))
const realBase = await realpath(base)
const vault = join(base, 'vault')
const talk = join(vault, 'talk')
const outside = join(base, 'outside')
await mkdir(join(talk, 'assets'), { recursive: true })
await mkdir(join(vault, '_assets'), { recursive: true })
await mkdir(outside, { recursive: true })
await mkdir(join(base, 'vault-evil'), { recursive: true })
await mkdir(join(base, 'second-root'), { recursive: true })
await writeFile(join(talk, 'pic.png'), 'INSIDE')
await writeFile(join(talk, 'assets', 'Pasted image.png'), 'INSIDE-SPACE')
await writeFile(join(vault, '_assets', 'img-abc1234.png'), 'POOLED')
await writeFile(join(outside, 'secret.png'), 'SECRET')
await writeFile(join(base, 'vault-evil', 'secret.png'), 'SECRET')
await writeFile(join(base, 'second-root', 'shared.png'), 'SECOND')
await symlink(join('..', '_assets', 'img-abc1234.png'), join(talk, 'link-in.png'))
await symlink(join(outside, 'secret.png'), join(talk, 'link-out.png'))
await symlink(outside, join(talk, 'dir-out'))
await symlink(join(outside, 'not-there.png'), join(talk, 'dangling.png'))
await symlink(vault, join(base, 'vault-link'))
execFileSync('mkfifo', [join(talk, 'pipe')])

const real = (...parts) => join(realBase, ...parts)
const ok = (path) => ({ ok: true, path })
const refused = (reason) => ({ ok: false, reason })

await check('a file inside the root resolves to its real path', async () => {
  assert.deepEqual(await resolveContainedFile([vault], join(talk, 'pic.png')), ok(real('vault', 'talk', 'pic.png')))
})

await check('an absolute path inside the root is allowed: pooled media is referenced that way', async () => {
  assert.deepEqual(await resolveContainedFile([vault], join(vault, '_assets', 'img-abc1234.png')), ok(real('vault', '_assets', 'img-abc1234.png')))
  // …but not when only the talk's own folder is allowed.
  assert.deepEqual(await resolveContainedFile([talk], join(vault, '_assets', 'img-abc1234.png')), refused('outside'))
})

await check('a .. escape is refused, and a .. that stays inside is not', async () => {
  assert.deepEqual(await resolveContainedFile([vault], join(talk, '..', '..', 'outside', 'secret.png')), refused('outside'))
  assert.deepEqual(await resolveContainedFile([vault], `${talk}${sep}..${sep}..${sep}outside${sep}secret.png`), refused('outside'))
  assert.deepEqual(await resolveContainedFile([vault], `${talk}${sep}..${sep}_assets${sep}img-abc1234.png`), ok(real('vault', '_assets', 'img-abc1234.png')))
})

await check('an absolute path outside is refused', async () => {
  assert.deepEqual(await resolveContainedFile([vault], join(outside, 'secret.png')), refused('outside'))
  assert.deepEqual(await resolveContainedFile([vault], '/etc/hosts'), refused('outside'))
})

await check('a file symlink pointing out is refused', async () => {
  assert.deepEqual(await resolveContainedFile([vault], join(talk, 'link-out.png')), refused('outside'))
})

await check('a folder symlink in the middle of the path pointing out is refused', async () => {
  assert.deepEqual(await resolveContainedFile([vault], join(talk, 'dir-out', 'secret.png')), refused('outside'))
})

await check('a symlink pointing to another place inside is allowed, and answers with the real file', async () => {
  assert.deepEqual(await resolveContainedFile([vault], join(talk, 'link-in.png')), ok(real('vault', '_assets', 'img-abc1234.png')))
})

await check('a sibling whose name starts with the root name is outside', async () => {
  assert.deepEqual(await resolveContainedFile([vault], join(base, 'vault-evil', 'secret.png')), refused('outside'))
  assert.equal(isInsideRealRoot('/tmp/x/vault', '/tmp/x/vault-evil/secret.png'), false)
  assert.equal(isInsideRealRoot('/tmp/x/vault', '/tmp/x/vault/a.png'), true)
  assert.equal(isInsideRealRoot('/tmp/x/vault', '/tmp/x/vault'), true)
  assert.equal(isInsideRealRoot('/tmp/x/vault', '/tmp/x/vaul'), false)
  assert.equal(isInsideRealRoot('/tmp/x/vault', '/tmp/x'), false)
  assert.equal(isInsideRealRoot('', '/tmp/x'), false)
})

await check('a root written with a trailing slash is the same root', async () => {
  assert.deepEqual(await resolveContainedFile([vault + sep], join(talk, 'pic.png')), ok(real('vault', 'talk', 'pic.png')))
  assert.deepEqual(await resolveContainedFile([vault + sep], join(base, 'vault-evil', 'secret.png')), refused('outside'))
})

await check('a root that is itself a symlink allows what is inside the real root, and nothing else', async () => {
  const link = join(base, 'vault-link')
  assert.deepEqual(await resolveContainedFile([link], join(link, 'talk', 'pic.png')), ok(real('vault', 'talk', 'pic.png')))
  assert.deepEqual(await resolveContainedFile([link], join(talk, 'pic.png')), ok(real('vault', 'talk', 'pic.png')))
  assert.deepEqual(await resolveContainedFile([link], join(link, 'talk', 'link-out.png')), refused('outside'))
  assert.deepEqual(await resolveContainedFile([link], join(outside, 'secret.png')), refused('outside'))
})

await check('a file that is not there is missing inside and outside outside, whatever is or is not there', async () => {
  assert.deepEqual(await resolveContainedFile([vault], join(talk, 'nope.png')), refused('missing'))
  assert.deepEqual(await resolveContainedFile([vault], join(talk, 'no-such-folder', 'deep', 'nope.png')), refused('missing'))
  assert.deepEqual(await resolveContainedFile([vault], join(talk, 'pic.png', 'below-a-file.png')), refused('missing'))
  // Outside: the answer is the same whether or not the outside file exists.
  assert.deepEqual(await resolveContainedFile([vault], join(outside, 'not-there.png')), refused('outside'))
  assert.deepEqual(await resolveContainedFile([vault], join(outside, 'secret.png')), refused('outside'))
})

await check('a path that does not exist yet behind a symlinked parent is judged by where it would land', async () => {
  assert.deepEqual(await resolveContainedFile([vault], join(talk, 'dir-out', 'not-yet.png')), refused('outside'))
  assert.deepEqual(await resolveContainedFile([vault], join(talk, 'dir-out', 'new-folder', 'not-yet.png')), refused('outside'))
  assert.deepEqual(await resolveContainedFile([vault], join(talk, 'dangling.png')), refused('outside'))
})

await check('a folder, the root itself and a FIFO are not files', async () => {
  assert.deepEqual(await resolveContainedFile([vault], join(talk, 'assets')), refused('missing'))
  assert.deepEqual(await resolveContainedFile([vault], vault), refused('missing'))
  assert.deepEqual(await resolveContainedFile([vault], join(talk, 'pipe')), refused('missing'))
  assert.deepEqual(await resolveContainedFile([vault], outside), refused('outside'))
  assert.deepEqual(await resolveContainedFile([vault], '/dev/null'), refused('outside'))
})

await check('several roots: inside any one of them is inside', async () => {
  const roots = [vault, join(base, 'second-root')]
  assert.deepEqual(await resolveContainedFile(roots, join(talk, 'pic.png')), ok(real('vault', 'talk', 'pic.png')))
  assert.deepEqual(await resolveContainedFile(roots, join(base, 'second-root', 'shared.png')), ok(real('second-root', 'shared.png')))
  assert.deepEqual(await resolveContainedFile(roots, join(outside, 'secret.png')), refused('outside'))
  assert.deepEqual(await resolveContainedFile([join(base, 'second-root')], join(talk, 'pic.png')), refused('outside'))
})

await check('no usable root allows nothing', async () => {
  for (const roots of [[], undefined, null, 'vault', [''], [null], [42], ['vault'], ['relative/vault'], [join(base, 'no-such-root')], [vault + '\0']]) {
    assert.deepEqual(await resolveContainedFile(roots, join(talk, 'pic.png')), refused('outside'), JSON.stringify(roots))
  }
})

await check('a candidate that is not an absolute path is refused, never resolved against the working folder', async () => {
  for (const candidate of ['pic.png', 'talk/pic.png', '', null, undefined, 42, join(talk, 'pic.png') + '\0', '.png']) {
    assert.deepEqual(await resolveContainedFile([vault], candidate), refused('outside'), String(candidate))
  }
})

await check('the comparison is exact: a differently-cased spelling is never treated as a different, allowed place', async () => {
  // On a case-insensitive volume <base>/VAULT/talk/pic.png IS the inside file; on a case-sensitive
  // one it does not exist. Either answer is safe; allowing an OUTSIDE file is the only wrong one.
  const upper = await resolveContainedFile([vault], join(base, 'VAULT', 'talk', 'pic.png'))
  if (upper.ok) assert.equal(upper.path, real('vault', 'talk', 'pic.png'))
  else assert.ok(['missing', 'outside'].includes(upper.reason))
  // A root spelled in the wrong case must not widen to the sibling.
  const viaUpperRoot = await resolveContainedFile([join(base, 'VAULT')], join(base, 'vault-evil', 'secret.png'))
  assert.deepEqual(viaUpperRoot, refused('outside'))
})

const contain = createAssetContainment([vault])

await check('a reference as written: the written form first, then its percent-decoded form', async () => {
  assert.deepEqual(await contain.reference(talk, 'pic.png'), { ok: true, path: real('vault', 'talk', 'pic.png'), lexical: join(talk, 'pic.png') })
  assert.deepEqual(await contain.reference(talk, 'assets/Pasted%20image.png'),
    { ok: true, path: real('vault', 'talk', 'assets', 'Pasted image.png'), lexical: join(talk, 'assets', 'Pasted image.png') })
  assert.deepEqual(await contain.reference(talk, join(vault, '_assets', 'img-abc1234.png')),
    { ok: true, path: real('vault', '_assets', 'img-abc1234.png'), lexical: join(vault, '_assets', 'img-abc1234.png') })
  assert.deepEqual(await contain.reference(talk, 'nope.png'), refused('missing'))
})

await check('percent-encoded .. is refused: the decoded retry is under the same rule', async () => {
  for (const written of [
    '%2e%2e%2f%2e%2e%2foutside%2fsecret.png',
    '%2E%2E/%2E%2E/outside/secret.png',
    '..%2f..%2foutside%2fsecret.png',
    '../../outside/secret.png',
    'dir-out%2fsecret.png',
    'link-out%2epng',
    encodeURIComponent(join(outside, 'secret.png')),
    join(outside, 'secret.png'),
    'dir-out/secret.png',
    'link-out.png',
    '../../vault-evil/secret.png',
  ]) {
    assert.deepEqual(await contain.reference(talk, written), refused('outside'), written)
  }
})

await check('odd references are refused or missing, never thrown', async () => {
  assert.deepEqual(await contain.reference(talk, 'pic.png\0.txt'), refused('outside'))
  assert.deepEqual(await contain.reference(talk, 'pic%00.png'), refused('missing'))
  assert.deepEqual(await contain.reference(talk, '%E0%A4%A'), refused('missing')) // not valid percent-encoding
  assert.deepEqual(await contain.reference(talk, ''), refused('missing')) // the talk folder itself: a folder
  assert.deepEqual(await contain.reference(talk, 42), refused('outside'))
  assert.deepEqual(await contain.reference('talk', 'pic.png'), refused('outside'))
  // A file: URL is not read as a URL: it is a relative name like any other, and it is not there.
  assert.deepEqual(await contain.reference(talk, `file://${join(outside, 'secret.png')}`), refused('missing'))
  assert.deepEqual(await contain.reference(talk, '//outside/secret.png'), refused('outside'))
})

await check('a warning names a reference as written, except an absolute path: from its root, or by file name alone', () => {
  assert.equal(contain.label('../../outside/secret.png'), '../../outside/secret.png')
  assert.equal(contain.label(join(outside, 'secret.png')), 'secret.png', 'an absolute path under no root is shown by its file name alone')
  assert.equal(contain.label(join(vault, '_assets', 'img-abc1234.png')), '_assets/img-abc1234.png', 'the vault\'s own location is not spelled out')
  assert.equal(contain.label(join(base, 'vault-evil', 'secret.png')), 'secret.png')
  assert.equal(contain.label(vault), 'vault')
  assert.equal(createAssetContainment([]).label(join(vault, '_assets', 'img-abc1234.png')), 'img-abc1234.png', 'no root to shorten against: still no folders')
  for (const shown of [contain.label(join(outside, 'secret.png')), contain.label(join(vault, 'talk', 'pic.png')), createAssetContainment([talk]).label(join(vault, '_assets', 'x.png'))]) assert.equal(shown.startsWith('/'), false)
  assert.equal(contain.label(''), '')
  assert.equal(contain.label(undefined), '')
})

await check('remote is an allow-list on the parsed address: http and https only', () => {
  // Emitted as written when written the plain way…
  for (const plain of ['https://example.org/a.png', 'http://example.org/a.png?x=1#y', 'https://example.org']) assert.equal(remoteReferenceUrl(plain), plain)
  // …and in parsed form for every other spelling a browser reads as http(s).
  assert.equal(remoteReferenceUrl('HTTPS://EXAMPLE.org/a.png'), 'https://example.org/a.png')
  assert.equal(remoteReferenceUrl('  https://example.org/a.png\n'), 'https://example.org/a.png')
  assert.equal(remoteReferenceUrl('https:example.org/a.png'), 'https://example.org/a.png')
  assert.equal(remoteReferenceUrl('http:\\\\example.org\\a.png'), 'http://example.org/a.png')
  assert.equal(remoteReferenceUrl('ht\ttps://example.org/a b.png'), 'https://example.org/a%20b.png')
  // Everything else is local, whatever it looks like: never decided by spotting a bad scheme.
  for (const local of [
    'pic.png', './pic.png', '../pic.png', '/Users/someone/pic.png', '//example.org/pic.png', '\\\\example.org\\pic.png',
    'file:///Users/someone/pic.png', 'file:/Users/someone/pic.png', 'file://localhost/Users/someone/pic.png', 'FILE:///x', 'file:../x', ' file:///x',
    'blob:https://example.org/1', 'blob:null/1', 'filesystem:https://example.org/temporary/x', 'javascript:alert(1)', 'data:text/html,x', 'data:image/png;base64,AA',
    'ftp://example.org/x', 'ws://example.org/x', 'about:blank', 'view-source:https://example.org', 'https://', 'http:', 'https:///x'.replace('///x', '://'), '', null, undefined, 42, {},
  ]) assert.equal(remoteReferenceUrl(local), null, String(local))
})

await rm(base, { recursive: true, force: true })

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1) }
console.log('\nasset containment: all checks passed')
