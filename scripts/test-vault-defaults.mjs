// New-talk defaults in a vault (several-vaults ticket 04). Seam: resolveNewTalkDefaults in
// src/shared/vault-defaults.ts — vault file (affiliation, style, logo) → personal (author) → app.
import assert from 'node:assert/strict'
import { relativeWithinVault, resolveNewTalkDefaults, vaultStyleOptions, VAULT_STYLE_KEY } from '../src/shared/vault-defaults.ts'
import { METADATA_REGISTRY } from '../src/shared/metadata-registry.ts'

let passed = 0
const test = (name, fn) => {
  try { fn(); passed++; console.log(`  ok  ${name}`) } catch (err) { console.error(`  FAIL ${name}`); throw err }
}
const app = { author: 'Settings Name', affiliation: 'App Uni', palette: '', logo: 'app-logo.svg', license: 'CC BY 4.0' }

console.log('vault defaults')

test('order: the vault file wins for affiliation, style and logo; personal for author; app for the rest', () => {
  const { defaults, sources } = resolveNewTalkDefaults({
    vaultFile: { affiliation: 'University of Oxford', style: 'green', logo: '_assets/logos/oxford.svg' },
    personal: { author: 'Dominik Lukeš' },
    app,
    talkFolderRel: ''
  })
  assert.equal(defaults.affiliation, 'University of Oxford')
  assert.equal(defaults[VAULT_STYLE_KEY], 'green')
  assert.equal(defaults.logo, '_assets/logos/oxford.svg')
  assert.equal(defaults.author, 'Dominik Lukeš')
  assert.equal(defaults.license, 'CC BY 4.0')
  assert.deepEqual(sources, { author: 'personal', affiliation: 'vault', logo: 'vault', license: 'app', [VAULT_STYLE_KEY]: 'vault' })
})

test('a blank vault value or personal author falls through to the app default', () => {
  const { defaults, sources } = resolveNewTalkDefaults({ vaultFile: { affiliation: '  ', style: '' }, personal: { author: '' }, app })
  assert.equal(defaults.affiliation, 'App Uni')
  assert.equal(sources.affiliation, 'app')
  assert.equal(defaults.author, 'Settings Name')
  assert.equal(sources.author, 'app')
  assert.equal(defaults.logo, 'app-logo.svg')
  assert.equal(VAULT_STYLE_KEY in defaults, false, 'a blank palette writes nothing')
})

test('no vault file and no personal settings: the app defaults alone', () => {
  const { defaults } = resolveNewTalkDefaults({ vaultFile: null, personal: null, app })
  assert.deepEqual(defaults, { author: 'Settings Name', affiliation: 'App Uni', logo: 'app-logo.svg', license: 'CC BY 4.0' })
})

test('the vault logo is rewritten relative to the new talk’s folder', () => {
  const at = (folder) => resolveNewTalkDefaults({ vaultFile: { logo: '_assets/logos/oxford.svg' }, talkFolderRel: folder }).defaults.logo
  assert.equal(at(''), '_assets/logos/oxford.svg')
  assert.equal(at('my-talk'), '../_assets/logos/oxford.svg')
  assert.equal(at('Workshops/my-talk'), '../../_assets/logos/oxford.svg')
  assert.equal(at('_assets/deck'), '../logos/oxford.svg')
  assert.equal(relativeWithinVault('a/b', 'a/c/x.svg'), '../c/x.svg')
})

test('the style menu is the registry’s palette choices, and every key it fills is a defaultable key', () => {
  const palette = METADATA_REGISTRY.find((e) => e.key === VAULT_STYLE_KEY)
  assert.ok(palette && palette.defaultable, 'palette is a defaultable frontmatter key')
  assert.deepEqual(vaultStyleOptions().map((o) => o.value), palette.vocabulary.options.map((o) => o.value))
  assert.equal(vaultStyleOptions()[0].label, 'TalkWeaver default')
  for (const key of ['affiliation', 'logo', 'author']) assert.ok(METADATA_REGISTRY.find((e) => e.key === key)?.defaultable, key)
})

test('S1: a vault logo that escapes the vault is never written into a talk', () => {
  for (const logo of ['../../../Users/x/secret.svg', '/etc/x.svg', 'C:\\x.svg', 'https://x.example/l.svg', 'a/../../b.svg']) {
    const { defaults, sources } = resolveNewTalkDefaults({ vaultFile: { logo }, app: { logo: 'app.svg' }, talkFolderRel: 'talk' })
    assert.equal(defaults.logo, 'app.svg', logo)
    assert.equal(sources.logo, 'app', logo)
  }
})

console.log(`vault defaults: ${passed} passed`)
