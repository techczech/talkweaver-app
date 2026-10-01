// Vault file (several-vaults ticket 04). Seam: src/main/vault-file.ts — parse, build (what Save and
// Create write), the vault-relative logo rule and the atomic, contained write. Real temp folders stand
// in for vaults so containment and symlinks are checked against a real disk.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildVaultFile, copyLogoIntoVault, createVaultFileStore, fileSchemaIsOurs, fileText, freeLogoName, looksAbsolute, parseVaultFile, sameVaultFile,
  validateVaultFields, vaultFilePath, vaultRelativeLogo, VaultFileError
} from '../src/main/vault-file.ts'
import { isSafeVaultRelativePath, resolveNewTalkDefaults } from '../src/shared/vault-defaults.ts'

const base = realpathSync(mkdtempSync(join(tmpdir(), 'tw-vault-file-')))
const dir = (...parts) => { const p = join(base, ...parts); mkdirSync(p, { recursive: true }); return p }
const V = dir('Workshops')
const OTHER = dir('Other')
mkdirSync(join(V, '_assets', 'logos'), { recursive: true })
writeFileSync(join(V, '_assets', 'logos', 'oxford.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
writeFileSync(join(OTHER, 'logo.png'), 'x')

let passed = 0
const test = (name, fn) => {
  try { fn(); passed++; console.log(`  ok  ${name}`) } catch (err) { console.error(`  FAIL ${name}`); throw err }
}
const init = { id: 'vid-1', createdBy: 'Dominik Lukeš', createdAt: '2026-09-30T10:00:00.000Z' }
/** Every string anywhere in a value. */
const strings = (v) => typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : []

console.log('vault file')

test('a new file has the schema, the id, the shared fields and who set it up', () => {
  const f = buildVaultFile(V, null, { name: 'Workshops', shared: true, affiliation: 'University of Oxford', style: 'green', logo: '_assets/logos/oxford.svg' }, init)
  assert.deepEqual(f, {
    schema: 1, id: 'vid-1', name: 'Workshops', shared: true,
    affiliation: 'University of Oxford', style: 'green', logo: '_assets/logos/oxford.svg',
    created_by: 'Dominik Lukeš', created_at: '2026-09-30T10:00:00.000Z'
  })
})

test('unknown keys are preserved on save, in place, and created_by/created_at are not rewritten', () => {
  const existing = parseVaultFile(JSON.stringify({
    schema: 1, id: 'vid-9', name: 'Old', futureKey: { nested: [1, 2] }, shared: false, created_by: 'Anna Novak', created_at: '2025-01-01T00:00:00Z', x_colleague: 'kept'
  })).file
  const f = buildVaultFile(V, existing, { name: 'New name', affiliation: 'Oxford' }, init)
  assert.deepEqual(f.futureKey, { nested: [1, 2] })
  assert.equal(f.x_colleague, 'kept')
  assert.equal(f.id, 'vid-9', 'the id is the file’s, never replaced')
  assert.equal(f.created_by, 'Anna Novak')
  assert.equal(f.created_at, '2025-01-01T00:00:00Z')
  assert.equal(f.name, 'New name')
  assert.deepEqual(Object.keys(f).slice(0, 4), ['schema', 'id', 'name', 'futureKey'], 'key order kept')
})

test('a blank affiliation, style or logo removes the key; the name is required', () => {
  const existing = buildVaultFile(V, null, { name: 'W', affiliation: 'A', style: 'green', logo: '_assets/logos/oxford.svg' }, init)
  const f = buildVaultFile(V, existing, { affiliation: ' ', style: '', logo: '' }, init)
  assert.equal('affiliation' in f, false)
  assert.equal('style' in f, false)
  assert.equal('logo' in f, false)
  assert.throws(() => buildVaultFile(V, existing, { name: '  ' }, init), (e) => e instanceof VaultFileError && e.reason === 'no-name')
})

test('the vault file never contains an absolute path', () => {
  for (const bad of ['/Users/dominik/talks', '~/talks', 'C:\\talks', '\\\\server\\share', 'file:///Users/x']) {
    assert.equal(looksAbsolute(bad), true, bad)
    assert.throws(() => buildVaultFile(V, null, { name: bad }, init), VaultFileError, `name ${bad}`)
    assert.throws(() => buildVaultFile(V, null, { name: 'W', affiliation: bad }, init), VaultFileError, `affiliation ${bad}`)
  }
  assert.throws(() => buildVaultFile(V, null, { name: 'W' }, { ...init, createdBy: '/Users/x' }), VaultFileError, 'created_by')
  // A logo chosen as an absolute path inside the vault is stored vault-relative.
  const f = buildVaultFile(V, null, { name: 'W', logo: join(V, '_assets', 'logos', 'oxford.svg') }, init)
  assert.equal(f.logo, '_assets/logos/oxford.svg')
  for (const s of strings(f)) assert.equal(looksAbsolute(s), false, `stored value ${s}`)
  assert.equal(JSON.stringify(f).includes(base), false, 'no part of the vault path is stored')
})

test('logo path is vault-relative and must resolve inside the vault', () => {
  assert.equal(vaultRelativeLogo(V, '_assets/logos/oxford.svg'), '_assets/logos/oxford.svg')
  assert.equal(vaultRelativeLogo(V, './_assets/logos/oxford.svg'), '_assets/logos/oxford.svg')
  assert.equal(vaultRelativeLogo(V, join(V, '_assets', 'logos', 'oxford.svg')), '_assets/logos/oxford.svg')
  assert.equal(vaultRelativeLogo(V, ''), '')
  for (const bad of ['../Other/logo.png', join(OTHER, 'logo.png'), '_assets/../../Other/logo.png', 'https://example.com/x.png']) {
    assert.throws(() => vaultRelativeLogo(V, bad), (e) => e instanceof VaultFileError && e.reason === 'logo-outside', bad)
  }
  // A link inside the vault that points out of it is outside.
  symlinkSync(OTHER, join(V, 'escape'))
  assert.throws(() => vaultRelativeLogo(V, 'escape/logo.png'), (e) => e instanceof VaultFileError && e.reason === 'logo-outside')
  assert.throws(() => buildVaultFile(V, null, { name: 'W', logo: 'escape/logo.png' }, init), VaultFileError)
})

test('parse: invalid JSON, an array, no id or an id outside [A-Za-z0-9_-]{1,64} is invalid', () => {
  assert.deepEqual(parseVaultFile('{nope'), { state: 'invalid', reason: 'not-json' })
  assert.deepEqual(parseVaultFile('[]'), { state: 'invalid', reason: 'not-json' })
  assert.deepEqual(parseVaultFile('{"name":"x"}'), { state: 'invalid', reason: 'no-id' })
  for (const bad of ['../x', 'a b', '__proto__/x', 'x'.repeat(65), 'é']) {
    assert.deepEqual(parseVaultFile(JSON.stringify({ id: bad })), { state: 'invalid', reason: 'bad-id' }, bad)
  }
  assert.equal(parseVaultFile(JSON.stringify({ id: '6717d1f2-1237-4db3-b276-3269df8b2626' })).state, 'ok')
  assert.equal(parseVaultFile(JSON.stringify({ id: 'anna_vault-01' })).state, 'ok')
})

test('S1: a logo that could leave the vault reads as unset, and never reaches a new talk', () => {
  for (const bad of ['../../../Users/x/secret.svg', '/Users/x/secret.svg', '\\\\server\\x.svg', 'C:\\x.svg', 'C:x.svg', 'https://evil.example/x.svg', 'file:///etc/x.svg', '_assets/../../x.svg', '~/x.svg']) {
    const r = parseVaultFile(JSON.stringify({ id: 'a', name: 'A', logo: bad }))
    assert.equal(r.state, 'ok')
    assert.equal('logo' in r.file, false, bad)
    assert.equal(isSafeVaultRelativePath(bad), false, bad)
    // …and even handed to the resolver directly, it is not used
    assert.equal(resolveNewTalkDefaults({ vaultFile: { logo: bad }, talkFolderRel: 'a/b' }).defaults.logo, undefined, bad)
  }
  const ok = parseVaultFile(JSON.stringify({ id: 'a', logo: '_assets/logos/x.svg' }))
  assert.equal(ok.file.logo, '_assets/logos/x.svg')
})

test('H4: known keys a newer build stored as other types are kept verbatim; schema is read only as a number', () => {
  const text = JSON.stringify({ schema: 1, id: 'a', name: 'A', shared: true, affiliation: { en: 'Oxford', cs: 'Oxford' }, style: ['green', 'dark'], created_by: { name: 'Anna' }, extra: 1 })
  const r = parseVaultFile(text)
  assert.equal(r.state, 'ok')
  assert.deepEqual(r.file.affiliation, { en: 'Oxford', cs: 'Oxford' })
  // The sheet shows these blank and sends blanks back: they stay as they were.
  const saved = buildVaultFile(V, r.file, { name: 'A', shared: true, affiliation: '', style: '', logo: '' }, init)
  assert.deepEqual(saved.affiliation, { en: 'Oxford', cs: 'Oxford' })
  assert.deepEqual(saved.style, ['green', 'dark'])
  assert.deepEqual(saved.created_by, { name: 'Anna' })
  // A real value replaces it.
  assert.equal(buildVaultFile(V, r.file, { affiliation: 'University of Oxford' }, init).affiliation, 'University of Oxford')
  assert.equal(fileText(r.file, 'affiliation'), '')
  assert.equal(fileSchemaIsOurs(parseVaultFile(JSON.stringify({ id: 'a' })).file), true)
  assert.equal(fileSchemaIsOurs(parseVaultFile(JSON.stringify({ id: 'a', schema: 1 })).file), true)
  for (const schema of [2, '1', '2', null, { v: 2 }]) {
    assert.equal(fileSchemaIsOurs(parseVaultFile(JSON.stringify({ id: 'a', schema })).file), false, JSON.stringify(schema))
  }
})

test('H3: a vault file with a "__proto__" key parses into an object with no prototype to reach', () => {
  const r = parseVaultFile('{"id":"a","__proto__":{"polluted":true}}')
  assert.equal(r.state, 'ok')
  assert.equal(({}).polluted, undefined)
  assert.equal(Object.getPrototypeOf(r.file), null)
})

test('store: read never writes; write is atomic, leaves no temp file, and reads back the same', () => {
  const store = createVaultFileStore()
  assert.deepEqual(store.read(V), { state: 'none' })
  assert.equal(existsSync(join(V, '.talkweaver')), false, 'reading created nothing')
  const f = buildVaultFile(V, null, { name: 'Workshops', shared: false }, init)
  store.write(V, f)
  assert.deepEqual(readdirSync(join(V, '.talkweaver')), ['vault.json'])
  const back = store.read(V)
  assert.equal(back.state, 'ok')
  assert.equal(sameVaultFile(back.file, f), true)
  assert.deepEqual(JSON.parse(readFileSync(vaultFilePath(V), 'utf8')), f)
})

test('H2: a vault file over 1 MiB is not read', () => {
  const B = dir('big')
  mkdirSync(join(B, '.talkweaver'), { recursive: true })
  writeFileSync(vaultFilePath(B), JSON.stringify({ id: 'a', pad: 'x'.repeat(1024 * 1024) }))
  assert.deepEqual(createVaultFileStore().read(B), { state: 'invalid', reason: 'too-large' })
})

test('removeIfUnchanged takes back only the bytes it wrote', () => {
  const R = dir('undo')
  const store = createVaultFileStore()
  const f = buildVaultFile(R, null, { name: 'R' }, init)
  store.write(R, f)
  assert.equal(store.removeIfUnchanged(R, f), true)
  assert.equal(existsSync(join(R, '.talkweaver')), false, 'the emptied folder goes too')
  store.write(R, f)
  writeFileSync(vaultFilePath(R), JSON.stringify({ ...f, name: 'changed since' }))
  assert.equal(store.removeIfUnchanged(R, f), false)
  assert.equal(existsSync(vaultFilePath(R)), true, 'a changed file is left in place')
})

test('store: a .talkweaver that links out of the vault is neither read nor written', () => {
  const X = dir('X')
  const target = dir('target')
  writeFileSync(join(target, 'vault.json'), JSON.stringify({ schema: 1, id: 'stolen', name: 'Elsewhere', shared: false }))
  symlinkSync(target, join(X, '.talkweaver'))
  const store = createVaultFileStore()
  assert.deepEqual(store.read(X), { state: 'invalid', reason: 'outside-vault' })
  const before = readFileSync(join(target, 'vault.json'), 'utf8')
  assert.throws(() => store.write(X, { schema: 1, id: 'x', name: 'X', shared: false }), (e) => e instanceof VaultFileError && e.reason === 'outside-vault')
  assert.equal(readFileSync(join(target, 'vault.json'), 'utf8'), before, 'the file outside is unchanged')
})

test('outside logo: copied into _assets/logos, " 2" on a clash, never overwriting; path vault-relative', () => {
  const L = dir('logo-vault')
  const brand = dir('brand')
  writeFileSync(join(brand, 'oxford.svg'), '<svg id="new"/>')
  mkdirSync(join(L, '_assets', 'logos'), { recursive: true })
  writeFileSync(join(L, '_assets', 'logos', 'oxford.svg'), '<svg id="old"/>')
  const rel = copyLogoIntoVault(L, join(brand, 'oxford.svg'))
  assert.equal(rel, '_assets/logos/oxford 2.svg')
  assert.equal(readFileSync(join(L, '_assets', 'logos', 'oxford.svg'), 'utf8'), '<svg id="old"/>', 'the existing logo is untouched')
  assert.equal(readFileSync(join(L, '_assets', 'logos', 'oxford 2.svg'), 'utf8'), '<svg id="new"/>')
  assert.equal(copyLogoIntoVault(L, join(brand, 'oxford.svg')), '_assets/logos/oxford 3.svg')
  // into a vault with no _assets yet
  const fresh = dir('logo-fresh')
  assert.equal(copyLogoIntoVault(fresh, join(brand, 'oxford.svg')), '_assets/logos/oxford.svg')
  assert.equal(buildVaultFile(fresh, null, { name: 'F', logo: '_assets/logos/oxford.svg' }, init).logo, '_assets/logos/oxford.svg')
  assert.equal(freeLogoName('a.png', (n) => ['a.png', 'a 2.png'].includes(n)), 'a 3.png')
})

test('outside logo: only the image types the app accepts; a missing file or a linked-out _assets is refused', () => {
  const M = dir('logo-refuse')
  const brand = dir('brand2')
  writeFileSync(join(brand, 'notes.txt'), 'x')
  writeFileSync(join(brand, 'logo.PNG'), 'x')
  assert.throws(() => copyLogoIntoVault(M, join(brand, 'notes.txt')), (e) => e instanceof VaultFileError && e.reason === 'not-an-image')
  assert.throws(() => copyLogoIntoVault(M, join(brand, 'gone.svg')), (e) => e instanceof VaultFileError && e.reason === 'logo-missing')
  assert.equal(existsSync(join(M, '_assets')), false, 'nothing created when refused')
  const K = dir('logo-linked')
  const elsewhere = dir('elsewhere-assets')
  symlinkSync(elsewhere, join(K, '_assets'))
  assert.throws(() => copyLogoIntoVault(K, join(brand, 'logo.PNG')), (e) => e instanceof VaultFileError && e.reason === 'outside-vault')
  assert.deepEqual(readdirSync(elsewhere), [], 'nothing written through the link')
})

test('validateVaultFields checks the text fields before any logo is copied', () => {
  assert.throws(() => validateVaultFields({ name: ' ' }, true), (e) => e.reason === 'no-name')
  assert.throws(() => validateVaultFields({}, true), (e) => e.reason === 'no-name')
  assert.doesNotThrow(() => validateVaultFields({ affiliation: 'Oxford' }, false))
  assert.throws(() => validateVaultFields({ name: 'W', affiliation: '/Users/x' }, true), (e) => e.reason === 'absolute-path')
})

rmSync(base, { recursive: true, force: true })
console.log(`vault file: ${passed} passed`)
