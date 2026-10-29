// Shared settings (0.40): the command registry seen by @app-patterns/commands, the settings schema, the
// map to the config.json keys main reads, the move of the old preferences, the overlay, and the
// settings command line. Plain Node, temporary folders only.
import assert from 'node:assert/strict'
import { stripTypeScriptTypes } from 'node:module'
import { runInNewContext } from 'node:vm'
import { mkdtempSync, mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, readdirSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildMenuTemplate, validateMenuCoverage, RESERVED_ESTATE } from '@app-patterns/commands'
import { commandsAdapter } from '@app-patterns/settings'
import { SettingsStore, runSettingsCli, acquireLock } from '@app-patterns/settings/node'
import { COMMAND_REGISTRY } from '../src/shared/command-registry.ts'
import { SHORTCUT_REGISTRY } from '../src/shared/shortcut-registry.ts'
import { registry, MENUS, UNMENUED_GROUPS, REBINDABLE, bridleIdOf, appCommandIdOf, keymapIdOf, bridleIdOfKeymapId } from '../src/shared/bridle-commands.ts'
import { chordFromKeyString, keyStringFromChord } from '../src/shared/bridle-chords.ts'
import { schema, settingsFromConfig, configWithSettings, splitConfigPatch, migrateLegacy, SECRET_KEYS } from '../src/shared/settings-schema.ts'
import { runMigration, STAMP_FILE } from '../src/main/settings-migration.ts'
import { createConfigOverlay } from '../src/main/settings-overlay.ts'
import { createSecretSlots, recordedKeyChange, splitRecordingKeys } from '../src/main/settings-secret-slots.ts'
import { createSettingsKeymap, legacyOverridesArg, overridesArg } from '../src/main/settings-keymap.ts'
import { openSettings, runWithSettings } from '../src/main/settings-open.ts'
import { READS, RECORDING_SETTINGS_ONLY, SETTINGS_WINDOW_ONLY, SHARED_CHANGES, settingsWindowOnly } from '../src/main/settings-window-channels.ts'
import { runTalkWeaverSettings, settingsArguments } from '../src/main/settings-cli.ts'
import { KEYMAP_SETTING, appKeysError, isEditorKeyString, isRegistryChord, overridesFromStore, parseAppKeys, storeWritesFor } from '../src/shared/keymap-overrides.ts'
import { LOCAL_ONLY, LOCAL_ONLY_KEYS, SEPARATE_FOLDER_KEYS, folderInside, folderShapeError, foldersOverlap, separateFolderProblem, siteFolderShapeError } from '../src/shared/settings-folders.ts'
import { placeChipVisibleFrom } from '../src/shared/place-chip-settings.ts'
import { actionBarVisibleFrom } from '../src/shared/action-bar-settings.ts'
import { guideButtonVisibleFrom } from '../src/shared/guide.ts'
import { plainFontFrom, plainTextSizeFrom } from '../src/shared/plain-view-look.ts'
import { DEFAULT_IMPORTER_SETTINGS } from '../src/shared/importer.ts'
import { RECORDING_STORAGE_FIELD, focusSettingField } from '../src/renderer/src/settings-focus.ts'

let passed = 0
const test = async (name, fn) => { await fn(); passed += 1; console.log(`  ok  ${name}`) }
const tmp = () => mkdtempSync(join(tmpdir(), 'tw-shared-settings-'))

console.log('shared settings')

// ── Registry ────────────────────────────────────────────────────────────────────────────────────
await test('every command of the app is in the registry, and only commands', () => {
  const commands = COMMAND_REGISTRY.filter((c) => !c.surface)
  assert.equal(registry.defs.length, commands.length + 2, 'the app commands plus the frame Export / Import Settings')
  for (const c of commands) assert.ok(registry.byId(bridleIdOf(c.id)), c.id)
  for (const d of registry.defs) assert.ok(['export-settings', 'import-settings'].includes(d.id) || COMMAND_REGISTRY.some((c) => c.id === appCommandIdOf(d.id)), d.id)
})

await test('every command is in the menu bar or noMenu with a reason; every task group has a menu', () => {
  assert.deepEqual(validateMenuCoverage(registry, MENUS), [])
  assert.deepEqual(UNMENUED_GROUPS, [])
  for (const d of registry.defs) if (d.noMenu) assert.ok(d.noMenuReason && d.noMenuReason.length > 3, d.id)
})

await test('reserved chords resolve to their surface or stay unbound', () => {
  const b = registry.bindingsOf({})
  const holder = (chord) => registry.commandForChord(b, chord)
  assert.equal(holder('⌘,'), 'settings')
  assert.equal(holder('⌘/'), 'cheat')
  assert.equal(holder('⌘⇧P'), 'app.command-palette')
  assert.equal(holder('⌘K'), 'app.context-menu')
  assert.equal(holder('⌘P'), 'toggle-inspector')
  assert.equal(holder('⌘F'), 'app.find')
  assert.equal(holder('⌘⇧F'), null, 'search everything: no surface, unbound')
  assert.equal(holder('⌘⇧K'), null, 'switcher: no surface, unbound')
  assert.equal(holder('⌘⌥⇧F'), 'focus-slide', 'Focus current slide moved off ⌘⇧F')
  for (const chord of Object.keys(RESERVED_ESTATE)) {
    const id = holder(chord)
    if (id) assert.ok(registry.byId(id)?.fixed, `${chord} is held by a fixed command`)
  }
})

await test('zero chord collisions, every default the shortcut registry gives a main-window command is kept', () => {
  const b = registry.bindingsOf({})
  const seen = new Map()
  for (const [id, chord] of Object.entries(b)) {
    if (!chord) continue
    const scoped = `${registry.byId(id)?.scope ?? 'global'}:${chord}`
    assert.ok(!seen.has(scoped), `${scoped}: ${seen.get(scoped)} and ${id}`)
    seen.set(scoped, id)
  }
  for (const id of ['new-window', 'view-editor', 'undo', 'redo']) assert.ok(b[id], `${id} keeps its key`)
})

await test('menu items show the effective chord, overrides included, and never register it', () => {
  const rebound = registry.bindingsOf({ 'move-slide-up': '⌘⌥⇧9' })
  const menu = buildMenuTemplate({ appName: 'TalkWeaver', registry, menus: MENUS, bindings: rebound, ctx: undefined, run: () => {} })
  assert.equal(menu.filter(item => item.label === 'View' || item.role === 'viewMenu').length, 1)
  assert.ok(!JSON.stringify(menu).includes('forceReload'))
  const view = menu.find(item => item.label === 'View')
  for (const label of ['Research', 'Find in research…']) assert.ok(view.submenu.some(item => item.label === label), label)
  const items = menu.flatMap((m) => m.submenu ?? [])
  const settings = items.find((i) => i.label === 'Settings')
  assert.equal(settings?.accelerator, 'Cmd+,')
  for (const i of items) if (i.accelerator) assert.equal(i.registerAccelerator, false, i.label)
  const newWindow = registry.byId('new-window')
  assert.ok(items.some((i) => i.label === newWindow.label && i.accelerator === 'Cmd+N'))
})

await test('only the keys the app honours overrides for can be rebound', () => {
  const source = readFileSync(new URL('../src/renderer/src/keymap/registry.ts', import.meta.url), 'utf8')
  const local = new Map()
  for (const m of source.matchAll(/^\s+command\('([^']+)'[^\n]*?(?:,\s*'([^']+)'\))?,?\s*$/gm)) local.set(m[2] ?? `editor.${m[1]}`, m[1])
  for (const m of source.matchAll(/surfaceCommand\('([^']+)', '([^']+)'\)/g)) local.set(m[2], m[1])
  // Keys the old Settings could rebind and the new one cannot: the system's Undo / Redo, and keys
  // that act on Enter or Tab where the caret is (one chord space cannot hold them).
  const dropped = ['editor.undo', 'editor.redo', 'editor.object-edit', 'editor.object-raw', 'editor.object-finish', 'editor.object-leave',
    'editor.title-continue', 'editor.protected-line-continue', 'editor.list-continue', 'editor.quote-paragraph', 'editor.list-indent', 'editor.list-outdent']
  for (const [shortcutId, id] of Object.entries(REBINDABLE)) assert.equal(local.get(shortcutId), id, shortcutId)
  for (const shortcutId of local.keys()) assert.ok(Object.hasOwn(REBINDABLE, shortcutId) || dropped.includes(shortcutId), `${shortcutId} is neither rebindable nor listed as dropped`)
  for (const d of registry.defs) {
    const rebindable = keymapIdOf(d.id) !== null || ['export-settings', 'import-settings'].includes(d.id) // the frame's, run by main
    if (!d.fixed) assert.ok(rebindable, `${d.id} can be rebound in Settings but nothing honours it`)
  }
  assert.equal(bridleIdOfKeymapId('move-up'), registry.defs.find((d) => keymapIdOf(d.id) === 'move-up')?.id)
})

await test('chords convert both ways for every key the app writes', () => {
  for (const s of SHORTCUT_REGISTRY) {
    for (const code of s.codes) {
      const chord = chordFromKeyString(code)
      if (!chord) continue
      assert.equal(chordFromKeyString(keyStringFromChord(chord)), chord, code)
    }
  }
  assert.equal(chordFromKeyString('Mod-Shift-t'), '⌘⇧T')
  assert.equal(keyStringFromChord('⌘⌥↑'), 'Mod-Alt-ArrowUp')
  assert.equal(chordFromKeyString('?'), '')
})

await test('app-owned IPC never claims either shared Settings namespace', () => {
  const main = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  for (const match of main.matchAll(/(?:ipcMain\.(?:handle|on)|handleFromSettingsWindow)\(\s*'([^']+)'/g)) {
    assert.ok(!/^(?:settings|bridle-settings):/.test(match[1]), match[1])
  }
})

await test('image-text search keeps main’s enabled default and migrates an explicit opt-out', () => {
  assert.equal(schema.def('general.imageText').default, true)
  assert.deepEqual(settingsFromConfig({ ocrEnabled: false }), { 'general.imageText': false })
  assert.equal(configWithSettings({ ocrEnabled: true }, { 'general.imageText': false }).ocrEnabled, false)
  assert.equal(configWithSettings({ ocrEnabled: false }, {}).ocrEnabled, undefined)
})

await test('enabling image-text search from Settings or the CLI starts main’s background pass', () => {
  const main = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  const source = main.slice(main.indexOf('function preferencesChanged('), main.indexOf('async function startSharedSettings('))
  let enabled = true
  let queued = 0
  const changed = runInNewContext(`${stripTypeScriptTypes(source)}\npreferencesChanged`, {
    getConfig: () => enabled,
    ocrAllVaultImages: () => { queued += 1 },
    KEYMAP_SETTING,
    lastShortcutKeys: '{}',
    settingsKeymap: null
  })
  changed(['general.imageText'], {})
  assert.equal(queued, 1, 'enabling the setting schedules the index without restarting the app')
  enabled = false
  changed(['general.imageText'], {})
  changed(['recording.ffmpeg'], {})
  assert.equal(queued, 1, 'disabling it and unrelated changes never start background work')
})

// ── Schema and the map to config.json ───────────────────────────────────────────────────────────
await test('each schema default is what the old reader fell back to', () => {
  const d = (key) => schema.def(key).default
  assert.equal(d('general.placeChip'), placeChipVisibleFrom(undefined))
  assert.equal(d('general.guideButton'), guideButtonVisibleFrom(undefined))
  assert.equal(d('writing.actionBar'), actionBarVisibleFrom(undefined))
  assert.equal(d('writing.plainFont'), plainFontFrom(undefined))
  assert.equal(d('writing.plainTextSize'), plainTextSizeFrom(undefined))
  assert.equal(d('general.imageText'), true)
  assert.equal(d('presenting.warnAt'), 5)
  assert.equal(d('presenting.urgentAt'), 1)
  assert.equal(d('presenting.backup'), false)
  assert.equal(d('presenting.backupEvery'), 15)
  assert.equal(d('publishing.shortLinks'), false)
  assert.equal(d('publishing.branch'), 'main')
  assert.equal(d('recording.discardShorter'), 20)
  assert.equal(d('importing.includeHidden'), DEFAULT_IMPORTER_SETTINGS.includeHidden)
  assert.equal(d('importing.renderer'), DEFAULT_IMPORTER_SETTINGS.renderer)
  assert.equal(schema.def(SECRET_KEYS.cloudflare).type, 'secret')
  assert.equal(schema.def(SECRET_KEYS.recording).type, 'secret')
})

const OLD_CONFIG = {
  vaults: [{ id: 'v1', root: '/tmp/vault' }], windowBounds: { width: 900, height: 700 }, cfAccountId: 'abc',
  placeChipVisible: true, guideButtonVisible: false, backupEnabled: true, backupIntervalMin: 30,
  timerWarnAtMinutes: 5, recordingDiscardMs: 45000, plainViewFont: 'serif', publishBaseUrl: 'https://h.example.com',
  metadataDefaults: { author: 'Dominik', series: '' }, importerSettings: { includeHidden: false, cleanupPasses: ['layout-repair'] }
}

await test('config.json preferences map to schema keys and back', () => {
  const s = settingsFromConfig(OLD_CONFIG)
  assert.equal(s['general.guideButton'], false)
  assert.equal(s['recording.discardShorter'], 45)
  assert.equal(s['talkDefaults.author'], 'Dominik')
  assert.ok(!('talkDefaults.series' in s), 'a blank default is not a value')
  assert.equal(s['importing.includeHidden'], false)
  const back = configWithSettings({ ...OLD_CONFIG, backupEnabled: false }, s)
  assert.equal(back.backupEnabled, true, 'the store wins over config.json')
  assert.equal(back.recordingDiscardMs, 45000)
  assert.deepEqual(back.importerSettings, { cleanupPasses: ['layout-repair'], includeHidden: false })
  const split = splitConfigPatch({ backupEnabled: false, vaults: [], recordingR2Bucket: undefined })
  assert.deepEqual(split.rest, { vaults: [] })
  assert.deepEqual(split.settings, { 'presenting.backup': false, 'recording.bucket': undefined })
})

// ── Moving the old preferences in ───────────────────────────────────────────────────────────────
const FAKE_SECRETS = { cloudflareToken: 'FAKE-SECRET-cf-0123456789abcdef', recordingSecretAccessKey: 'FAKE-SECRET-r2-abcdef0123456789', apiKey: 'FAKE-SECRET-api-key' }
const LEGACY = { ...OLD_CONFIG, ...FAKE_SECRETS }
const openStore = (dir, who = { kind: 'app-update', version: '0.40.0-alpha.1' }) => new SettingsStore({
  dir, app: schema.app, schema, registry: commandsAdapter(registry), appVersion: '0.40.0-alpha.1', migrate: migrateLegacy, watch: false, who, log: () => {}
})
const noSecretsIn = (dir) => {
  for (const name of readdirSync(dir)) {
    if (name === 'config.json') continue
    const text = readFileSync(join(dir, name), 'utf8')
    for (const v of Object.values(FAKE_SECRETS)) assert.ok(!text.includes(v) && !text.includes('FAKE-SECRET'), `${name} holds a secret`)
  }
}

await test('first launch: a new settings.json, config.json untouched, one app-update entry per changed preference, no secret anywhere', async () => {
  const dir = tmp()
  const legacyText = JSON.stringify(LEGACY)
  writeFileSync(join(dir, 'config.json'), legacyText)
  const outcome = await runMigration(dir, () => openStore(dir))
  assert.equal(outcome.kind, 'first')
  assert.equal(readFileSync(join(dir, 'config.json'), 'utf8'), legacyText, 'the old file is never rewritten')
  assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith('config')), ['config.json'], 'nor copied')
  const store = openStore(dir, { kind: 'you' })
  await store.ready
  const state = store.view()
  assert.equal(store.problem(), undefined)
  assert.equal(state.settings['presenting.backup'], true)
  assert.equal(state.settings['recording.discardShorter'], 45)
  assert.deepEqual([...new Set(state.changes.map((c) => c.who.kind))], ['app-update'])
  const changedKeys = state.changes.map((c) => c.key).sort()
  assert.deepEqual(changedKeys, ['general.guideButton', 'importing.includeHidden', 'presenting.backup', 'presenting.backupEvery', 'publishing.customDomain', 'recording.discardShorter', 'talkDefaults.author', 'writing.plainFont'], 'defaults make no entry')
  assert.ok(!Object.keys(state.settings).some((k) => !schema.def(k)), 'only schema keys')
  await store.close()
  assert.equal(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).format, 'bridle-settings')
  assert.ok(existsSync(join(dir, STAMP_FILE)))
  // An export, too, holds no secret.
  const out = []
  assert.equal(await runSettingsCli(['export', join(dir, 'export.json')], { app: schema.app, appName: 'TalkWeaver', dir, schema, registry: commandsAdapter(registry), version: '0.40.0-alpha.1', migrate: migrateLegacy }, { stdout: (t) => out.push(t), stderr: () => {}, env: {} }), 0)
  noSecretsIn(dir)
  assert.equal((await runMigration(dir, () => openStore(dir))).kind, 'none', 'second launch: nothing to do')
  rmSync(dir, { recursive: true, force: true })
})

await test('downgrade, save, upgrade: the preferences the old version changed are migrated again; the rest stay', async () => {
  const dir = tmp()
  writeFileSync(join(dir, 'config.json'), JSON.stringify(LEGACY))
  await runMigration(dir, () => openStore(dir))
  // The new version changes one setting.
  const mine = openStore(dir, { kind: 'you' })
  await mine.ready
  assert.equal((await mine.set('presenting.warnAt', 7)).ok, true)
  await mine.close()
  // The old version runs and saves: it changes the clock's amber and drops the custom domain.
  const old = { ...LEGACY, timerUrgentAtMinutes: 3, windowBounds: { width: 1, height: 1 } }
  delete old.publishBaseUrl
  writeFileSync(join(dir, 'config.json'), JSON.stringify(old))
  const outcome = await runMigration(dir, () => openStore(dir))
  assert.deepEqual(outcome, { kind: 'again', keys: ['presenting.urgentAt', 'publishing.customDomain'] })
  const store = openStore(dir, { kind: 'you' })
  await store.ready
  const s = store.view().settings
  assert.equal(s['presenting.urgentAt'], 3)
  assert.equal(s['publishing.customDomain'], undefined, 'removed there: back to default here')
  assert.equal(s['presenting.warnAt'], 7, 'what only the new version changed is kept')
  assert.equal(store.view().changes[0].who.kind, 'app-update')
  await store.close()
  assert.equal((await runMigration(dir, () => openStore(dir))).kind, 'none', 'the stamp was renewed')
  noSecretsIn(dir)
  rmSync(dir, { recursive: true, force: true })
})

await test('a fresh install: no entries, nothing but the new files', async () => {
  const dir = tmp()
  assert.equal((await runMigration(dir, () => openStore(dir))).kind, 'first')
  const store = openStore(dir, { kind: 'you' })
  await store.ready
  assert.deepEqual(store.view().changes, [])
  await store.close()
  assert.ok(!existsSync(join(dir, 'config.json')))
  rmSync(dir, { recursive: true, force: true })
})

// ── The overlay main reads config.json through ──────────────────────────────────────────────────
await test('overlay: a write is read back at once, committed through the store, refused values dropped', async () => {
  let fileConfig = { vaults: [], backupEnabled: true }
  const file = { read: () => ({ ...fileConfig }), write: (p) => { fileConfig = JSON.parse(JSON.stringify({ ...fileConfig, ...p })) } }
  const stored = { 'presenting.backup': false }
  const calls = []
  const fake = {
    view: () => ({ settings: { ...stored } }),
    set: async (key, value) => { calls.push(['set', key, value]); if (key === 'presenting.warnAt' && value > 600) return { ok: false, error: 'Must be at most 600' }; stored[key] = value; return { ok: true } },
    reset: async (key) => { calls.push(['reset', key]); delete stored[key]; return { ok: true } }
  }
  const overlay = createConfigOverlay({ file, store: fake, log: () => {} })
  assert.equal(overlay.read().backupEnabled, undefined, 'the store, not config.json: at its default the reader default applies')
  overlay.write({ backupIntervalMin: 30, windowBounds: { width: 1, height: 2 } })
  assert.equal(overlay.read().backupIntervalMin, 30, 'visible before the store answers')
  assert.deepEqual(fileConfig.windowBounds, { width: 1, height: 2 })
  assert.equal(fileConfig.backupIntervalMin, undefined, 'a preference never goes to config.json')
  overlay.write({ timerWarnAtMinutes: 999, placeChipVisible: true })
  await overlay.settled()
  assert.equal(overlay.read().backupIntervalMin, 30)
  assert.equal(overlay.read().timerWarnAtMinutes, undefined, 'refused: back to the reader default')
  assert.ok(calls.some(([op, key]) => op === 'reset' && key === 'general.placeChip'), 'a value at its default is a reset')
  assert.deepEqual(overlay.storeChanged({ 'presenting.backupEvery': 30, 'writing.actionBar': false }), ['writing.actionBar'])
})

// ── The command line ────────────────────────────────────────────────────────────────────────────
await test('settings CLI: list, set, changes and export through the same file, no key in any output', async () => {
  const dir = tmp()
  const out = []
  const io = { stdout: (t) => out.push(t), stderr: () => {}, env: {} }
  const opts = { app: schema.app, appName: 'TalkWeaver', dir, schema, registry: commandsAdapter(registry), version: '0.40.0-alpha.1', migrate: migrateLegacy }
  assert.equal(await runSettingsCli(['set', 'presenting.warnAt', '10', '--json', '--agent', 'Test agent'], opts, io), 0)
  assert.equal(await runSettingsCli(['get', 'presenting.warnAt'], opts, io), 0)
  assert.match(out.at(-1), /10/)
  assert.equal(await runSettingsCli(['set', SECRET_KEYS.cloudflare, 'x'], opts, io), 2, 'a key cannot be set from the command line')
  out.length = 0
  assert.equal(await runSettingsCli(['changes', '--json'], opts, io), 0)
  const changes = JSON.parse(out.join(''))
  assert.equal(changes.changes[0].who.kind, 'agent')
  assert.equal(changes.changes[0].who.name, 'Test agent')
  const exportPath = join(dir, 'out.json')
  assert.equal(await runSettingsCli(['export', exportPath], opts, io), 0)
  const exported = readFileSync(exportPath, 'utf8')
  assert.ok(!exported.includes('accounts.'), 'no key in an export')
  rmSync(dir, { recursive: true, force: true })
})


// ── Part 2: the re-migration conflict rule and stamping only what landed ─────────────────────────
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms))
const lockedStore = (dir) => new SettingsStore({
  dir, app: schema.app, schema, registry: commandsAdapter(registry), appVersion: '0.42.0-preview.1', migrate: migrateLegacy, watch: false,
  who: { kind: 'app-update', version: '0.42.0-preview.1' }, log: () => {}, lock: { waitMs: 80 }
})
const stampOf = (dir) => JSON.parse(readFileSync(join(dir, STAMP_FILE), 'utf8'))

await test('re-migration: A migrated, B (new version) changes a key, C (old version) changes it after: B is kept; what only C changed is applied', async () => {
  const dir = tmp()
  writeFileSync(join(dir, 'config.json'), JSON.stringify(LEGACY))   // A
  await runMigration(dir, () => openStore(dir))
  await sleepMs(5)
  const mine = openStore(dir, { kind: 'you' })                       // B
  await mine.ready
  assert.equal((await mine.set('presenting.urgentAt', 2)).ok, true)
  await mine.close()
  await sleepMs(5)
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ ...LEGACY, timerUrgentAtMinutes: 4, timerWarnAtMinutes: 9 })) // C, written after B
  const outcome = await runMigration(dir, () => openStore(dir))
  assert.deepEqual(outcome, { kind: 'again', keys: ['presenting.warnAt'], kept: ['presenting.urgentAt'] })
  const store = openStore(dir, { kind: 'you' })
  await store.ready
  assert.equal(store.view().settings['presenting.urgentAt'], 2, 'the change made in the new version since the stamp wins')
  assert.equal(store.view().settings['presenting.warnAt'], 9, 'the old version’s change to a key the new one left alone is applied')
  await store.close()
  assert.equal((await runMigration(dir, () => openStore(dir))).kind, 'none', 'the kept key is stamped: not asked again')
  // App-update entries (the migrations themselves) do not count as the new version changing a key.
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ ...LEGACY, timerUrgentAtMinutes: 4, timerWarnAtMinutes: 11 }))
  assert.deepEqual(await runMigration(dir, () => openStore(dir)), { kind: 'again', keys: ['presenting.warnAt'] })
  rmSync(dir, { recursive: true, force: true })
})

await test('a held lock: nothing that did not land is stamped, and it is tried again next time (first move and re-migration)', async () => {
  const dir = tmp()
  writeFileSync(join(dir, 'config.json'), JSON.stringify(LEGACY))
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ format: 'talkweaver-config-preferences', settings: {} })) // a first move begun earlier
  let lock = await acquireLock(join(dir, 'settings.json'), { waitMs: 200 })
  assert.equal((await runMigration(dir, () => lockedStore(dir))).kind, 'not-saved')
  assert.ok(!existsSync(join(dir, STAMP_FILE)), 'no stamp while nothing landed')
  await lock.release()
  assert.equal((await runMigration(dir, () => openStore(dir))).kind, 'first', 'the next launch moves them, from config.json as it is now')
  const s1 = openStore(dir, { kind: 'you' }); await s1.ready
  assert.equal(s1.view().settings['presenting.backup'], true); await s1.close()
  const before = stampOf(dir).hashes['presenting.urgentAt']
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ ...LEGACY, timerUrgentAtMinutes: 3 }))
  lock = await acquireLock(join(dir, 'settings.json'), { waitMs: 200 })
  const held = await runMigration(dir, () => lockedStore(dir))
  assert.deepEqual(held, { kind: 'again', keys: [], notSaved: ['presenting.urgentAt'] })
  assert.equal(stampOf(dir).hashes['presenting.urgentAt'], before, 'the failed write keeps its old stamp')
  await lock.release()
  assert.deepEqual(await runMigration(dir, () => openStore(dir)), { kind: 'again', keys: ['presenting.urgentAt'] }, 'tried again and landed')
  // The CLI path runs the same migration first, with the same rule.
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ ...LEGACY, timerUrgentAtMinutes: 6 }))
  lock = await acquireLock(join(dir, 'settings.json'), { waitMs: 200 })
  const out = []
  const io = { stdout: (t) => out.push(t), stderr: () => {}, env: {} }
  await runTalkWeaverSettings(['get', 'presenting.urgentAt', '--json'], { dir, version: '0.42.0-preview.1', io, lock: { waitMs: 80 } })
  assert.notEqual(stampOf(dir).hashes['presenting.urgentAt'], undefined)
  await lock.release()
  out.length = 0
  assert.equal(await runTalkWeaverSettings(['get', 'presenting.urgentAt'], { dir, version: '0.42.0-preview.1', io }), 0)
  assert.match(out.join(''), /6/, 'the CLI moved it once the lock was free')
  rmSync(dir, { recursive: true, force: true })
})

// ── Import never applies what runs something or sends somewhere; separate folders ────────────────
await test('import: settings that name something to run or somewhere to send data are skipped as set on this Mac only', async () => {
  for (const key of LOCAL_ONLY_KEYS) assert.equal(schema.def(key)?.canApply?.('x', {}), LOCAL_ONLY, key)
  const dir = tmp()
  const store = openStore(dir, { kind: 'you' })
  await store.ready
  const file = { format: 'bridle-settings-export', version: 1, app: schema.app, settings: { 'recording.transcriptionPython': '/usr/bin/python3', 'recording.endpoint': 'https://x.example.com', 'presenting.warnAt': 9 }, keys: {} }
  const fromStore = store.exportFile({ hostName: 'test' })
  const preview = store.previewImport(JSON.stringify({ ...fromStore, settings: file.settings }), { pathExists: () => true })
  const skipped = Object.fromEntries(preview.skipped.map((s) => [s.key, s.reason]))
  assert.equal(skipped['recording.transcriptionPython'], LOCAL_ONLY)
  assert.equal(skipped['recording.endpoint'], LOCAL_ONLY)
  assert.ok(preview.changes.some((c) => c.key === 'presenting.warnAt'), 'an ordinary preference is imported')
  await store.close()
  rmSync(dir, { recursive: true, force: true })
})

await test('separate folders: the backup and site folders are checked when set and again on use', () => {
  assert.deepEqual([...SEPARATE_FOLDER_KEYS].sort(), ['presenting.backupFolder', 'publishing.siteFolder'])
  assert.equal(folderShapeError('relative/folder') !== null, true)
  assert.equal(folderShapeError('~/OneDrive/Backups'), null)
  assert.equal(siteFolderShapeError('site'), null, 'the old relative override, inside the app folder')
  assert.notEqual(siteFolderShapeError('../../elsewhere'), null)
  assert.equal(schema.def('presenting.backupFolder')?.validate?.('relative'), folderShapeError('relative'))
  assert.ok(foldersOverlap('/a/b', '/a/b/c') && foldersOverlap('/A/B/', '/a/b') && !foldersOverlap('/a/b', '/a/bc'))
  assert.ok(folderInside('/v/site', '/v') && !folderInside('/v', '/v/site'))
  assert.match(separateFolderProblem('/x/backups', 'Backing up', [{ path: '/x', name: 'the published site folder' }]), /overlaps the published site folder/)
  assert.equal(separateFolderProblem('/x/backups', 'Backing up', [{ path: '/y', name: 'the published site folder' }]), null)
  const main = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  assert.match(main, /const overlap = backupFolderOverlap\(folder\)/, 'a backup run checks again')
  assert.match(main, /siteFolderOverlap\(siteDir\) \?\? pagesBundlingHazard/, 'a publish checks again')
})

// ── Accounts and keys ───────────────────────────────────────────────────────────────────────────
await test('key slots: connected or missing only, the value goes one way, recording keys typed as id:secret', async () => {
  const seen = { cf: null, rec: null }
  let cf = false
  let rec = false
  const slots = createSecretSlots({
    cloudflare: { has: () => cf, save: (t) => { seen.cf = t; cf = true; return { ok: true } }, disconnect: () => { cf = false; return { ok: true } } },
    recording: { has: () => rec, save: (k) => { seen.rec = k; rec = true; return { success: true } }, clear: () => { rec = false; return { success: true } } }
  })
  assert.deepEqual((await slots.list()).map((s) => [s.id, s.status, 'last4' in s, 'detail' in s]), [[SECRET_KEYS.cloudflare, 'missing', false, false], [SECRET_KEYS.recording, 'missing', false, false]])
  const r1 = await slots.set(SECRET_KEYS.cloudflare, FAKE_SECRETS.cloudflareToken)
  assert.deepEqual(r1, { ok: true })
  assert.equal(seen.cf, FAKE_SECRETS.cloudflareToken)
  assert.deepEqual(await slots.set(SECRET_KEYS.recording, 'no-colon'), { ok: false, error: 'That does not look like the right kind of key' })
  const r2 = await slots.set(SECRET_KEYS.recording, `AKID:${FAKE_SECRETS.recordingSecretAccessKey}`)
  assert.deepEqual(r2, { ok: true })
  assert.deepEqual(seen.rec, { accessKeyId: 'AKID', secretAccessKey: FAKE_SECRETS.recordingSecretAccessKey })
  assert.ok(!JSON.stringify(await slots.list()).includes('FAKE-SECRET'), 'no value in what the window sees')
  assert.deepEqual(await slots.remove(SECRET_KEYS.cloudflare), { ok: true })
  assert.equal((await slots.list())[0].status, 'missing')
  assert.deepEqual(splitRecordingKeys('id:sec:ret'), { accessKeyId: 'id', secretAccessKey: 'sec:ret' })
  const failing = createSecretSlots({
    cloudflare: { has: () => { throw new Error('x') }, save: () => ({ ok: false, error: `refused ${FAKE_SECRETS.cloudflareToken}` }), disconnect: () => ({ ok: true }) },
    recording: { has: () => false, save: () => ({ success: true }), clear: () => ({ success: true }) }
  })
  assert.equal((await failing.list())[0].status, 'problem')
  assert.ok(!JSON.stringify(await failing.set(SECRET_KEYS.cloudflare, FAKE_SECRETS.cloudflareToken)).includes('FAKE-SECRET'), 'a holder’s own words are never passed on')
})

// ── The keymap's overrides in the store ─────────────────────────────────────────────────────────
await test('keymap: chords are registry shortcuts, bare keys and keyless commands the app layer, a removed key stays removed', async () => {
  const ids = { bridleIdOfKeymapId, keymapIdOf }
  assert.ok(isRegistryChord('Mod-Alt-h') && !isRegistryChord('Enter') && !isRegistryChord('Shift-Tab') && !isRegistryChord('b'))
  const dir = tmp()
  const store = openStore(dir, { kind: 'you' })
  await store.ready
  const km = createSettingsKeymap(store, ids)
  const r = await km.set({ highlight: 'Mod-Alt-h', 'move-up': 'Alt-k', bold: '', 'list-indent': 'Ctrl-i', undo: '', 'select-whole-section': 'Alt-Enter' })
  assert.equal(r.ok, true)
  const v = store.view()
  assert.equal(v.keys[bridleIdOfKeymapId('highlight')], '⌘⌥H')
  assert.equal(v.keys[bridleIdOfKeymapId('bold')], '', 'removed: the registry holds no shortcut')
  const app = JSON.parse(v.settings[KEYMAP_SETTING])
  assert.equal(app.undo, '', 'a keyless command removed on purpose stays removed')
  assert.equal(app['list-indent'], 'Ctrl-i', 'a command the registry has no chord for is the app’s own layer')
  assert.equal(km.overrides().bold, '', 'read back as removed, not as the default')
  assert.equal(km.overrides().highlight, 'Mod-Alt-h')
  // A rebind in the Settings window (the registry) wins over an older app-layer key for the same command.
  assert.deepEqual(overridesFromStore({ [bridleIdOfKeymapId('bold')]: '⌘⇧B' }, JSON.stringify({ bold: 'b' }), ids).bold, 'Mod-Shift-b')
  // Back to no overrides: every registry key reset and the app layer emptied.
  await km.set({})
  assert.deepEqual(Object.keys(store.view().keys).filter((id) => keymapIdOf(id)), [])
  assert.equal(store.view().settings[KEYMAP_SETTING], undefined)
  // The localStorage overrides of an earlier version move once.
  let moved = false
  const once = await km.moveLegacy({ italic: 'Mod-Alt-i' }, () => moved, () => { moved = true })
  assert.equal(once.outcome, 'consumed')
  assert.equal(moved, true)
  assert.equal(km.overrides().italic, 'Mod-Alt-i')
  const again = await km.moveLegacy({ italic: 'Mod-Alt-j' }, () => moved, () => { moved = true })
  assert.equal(again.outcome, 'consumed', 'moved before: the old copy may go')
  assert.equal(km.overrides().italic, 'Mod-Alt-i', 'never twice')
  assert.equal(overridesArg({ a: 1 }), null)
  assert.equal(overridesArg([]), null)
  assert.deepEqual(storeWritesFor({ 'move-up': 'Mod-Alt-ArrowUp' }, {}, ids).rebind.length, 1)
  await store.close()
  rmSync(dir, { recursive: true, force: true })
})

// ── `TalkWeaver settings …` ─────────────────────────────────────────────────────────────────────
await test('TalkWeaver settings: found at the command position, moves the preferences first, lists them as JSON with no key', async () => {
  assert.deepEqual(settingsArguments(['/Applications/TalkWeaver.app/Contents/MacOS/TalkWeaver', 'settings', 'list', '--json'], false), ['list', '--json'])
  assert.deepEqual(settingsArguments(['electron', '.', 'settings', 'get', 'presenting.warnAt'], true), ['get', 'presenting.warnAt'])
  assert.equal(settingsArguments(['/x/TalkWeaver', 'setup', 'status'], false), null)
  const dir = tmp()
  writeFileSync(join(dir, 'config.json'), JSON.stringify(LEGACY))
  const out = []
  const io = { stdout: (t) => out.push(t), stderr: () => {}, env: {} }
  assert.equal(await runTalkWeaverSettings(['list', '--json'], { dir, version: '0.42.0-preview.1', io }), 0)
  const text = out.join('')
  assert.ok(!text.includes('FAKE-SECRET'))
  assert.match(text, /presenting\.backupEvery/)
  assert.ok(existsSync(join(dir, STAMP_FILE)), 'the migration ran first')
  noSecretsIn(dir)
  rmSync(dir, { recursive: true, force: true })
})


// ── Sol review 1: the fixes ─────────────────────────────────────────────────────────────────────
await test('review #1: a first migration hands over only values the schema accepts and stamps only what reads back from the store', async () => {
  const dir = tmp()
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ plainViewTextSize: 22, publishBaseUrl: 'https://' + 'x'.repeat(1_100_000), timerWarnAtMinutes: 9 }))
  const outcome = await runMigration(dir, () => openStore(dir))
  assert.equal(outcome.kind, 'first')
  assert.equal(outcome.notSaved, undefined)
  const store = openStore(dir, { kind: 'you' }); await store.ready
  assert.equal(store.problem(), undefined, 'the hand-over was not set aside as damaged')
  assert.equal(store.view().settings['writing.plainTextSize'], 22, 'the font size landed')
  assert.equal(store.view().settings['publishing.customDomain'], undefined, 'the oversized address was never handed over')
  await store.close()
  const hashes = stampOf(dir).hashes
  assert.ok(hashes['writing.plainTextSize'] && hashes['writing.plainTextSize'] !== 'not-saved')
  assert.equal((await runMigration(dir, () => openStore(dir))).kind, 'none', 'the refused value is not retried for ever')
  rmSync(dir, { recursive: true, force: true })

  // A store that sets the hand-over aside and loads defaults: nothing that did not read back is stamped as moved.
  const dir2 = tmp()
  writeFileSync(join(dir2, 'config.json'), JSON.stringify({ plainViewTextSize: 20, timerWarnAtMinutes: 9 }))
  const setsAside = () => {
    const real = openStore(dir2)
    return {
      ready: (async () => { renameSync(join(dir2, 'settings.json'), join(dir2, 'settings.json.damaged-1')); writeFileSync(join(dir2, 'settings.json'), JSON.stringify({ format: 'bridle-settings', version: 1, app: schema.app, settings: {}, keys: {}, changes: [] })); await real.ready })(),
      problem: () => undefined,
      view: () => ({ settings: {}, changes: [] }),
      set: async () => ({ ok: false, error: 'x' }), reset: async () => ({ ok: false, error: 'x' }),
      close: () => real.close()
    }
  }
  const lost = await runMigration(dir2, setsAside)
  assert.deepEqual(lost, { kind: 'first', preferences: 0, notSaved: ['writing.plainTextSize', 'presenting.warnAt'] })
  assert.equal(stampOf(dir2).hashes['writing.plainTextSize'], 'not-saved')
  assert.deepEqual(await runMigration(dir2, () => openStore(dir2)), { kind: 'again', keys: ['writing.plainTextSize', 'presenting.warnAt'] }, 'set again at the next launch')
  const s2 = openStore(dir2, { kind: 'you' }); await s2.ready
  assert.equal(s2.view().settings['writing.plainTextSize'], 20)
  await s2.close()
  rmSync(dir2, { recursive: true, force: true })
})

await test('review #8: an unreadable or malformed config.json stops the migration; only a missing one means nothing to migrate', async () => {
  const dir = tmp()
  writeFileSync(join(dir, 'config.json'), JSON.stringify(LEGACY))
  await runMigration(dir, () => openStore(dir))
  const stampText = readFileSync(join(dir, STAMP_FILE), 'utf8')
  for (const bad of ['{"timerWarnAtMinutes": 9,', '[1,2]', '"text"']) {
    writeFileSync(join(dir, 'config.json'), bad)
    assert.deepEqual(await runMigration(dir, () => openStore(dir)), { kind: 'unreadable' }, bad)
  }
  rmSync(join(dir, 'config.json'))
  mkdirSync(join(dir, 'config.json')) // a read error (EISDIR), not a missing file
  assert.deepEqual(await runMigration(dir, () => openStore(dir)), { kind: 'unreadable' })
  rmSync(join(dir, 'config.json'), { recursive: true })
  assert.deepEqual(await runMigration(dir, () => openStore(dir)), { kind: 'none' }, 'missing: nothing to migrate, nothing reset')
  assert.equal(readFileSync(join(dir, STAMP_FILE), 'utf8'), stampText, 'the stamp never advanced')
  const store = openStore(dir, { kind: 'you' }); await store.ready
  assert.equal(store.view().settings['presenting.backup'], true, 'the migrated preference is still there')
  assert.equal(store.view().settings['publishing.customDomain'], 'https://h.example.com')
  await store.close()
  // A first launch whose config.json cannot be read writes no settings file; once it reads, it moves in.
  const dir2 = tmp()
  writeFileSync(join(dir2, 'config.json'), '{"backupEnabled": tr')
  assert.deepEqual(await runMigration(dir2, () => openStore(dir2)), { kind: 'unreadable' })
  assert.ok(!existsSync(join(dir2, 'settings.json')) && !existsSync(join(dir2, STAMP_FILE)))
  // Meanwhile the app opened its store and the person changed a preference.
  const mine = openStore(dir2, { kind: 'you' }); await mine.ready
  assert.equal((await mine.set('presenting.warnAt', 8)).ok, true); await mine.close()
  writeFileSync(join(dir2, 'config.json'), JSON.stringify({ backupEnabled: true, timerWarnAtMinutes: 3 }))
  assert.deepEqual(await runMigration(dir2, () => openStore(dir2)), { kind: 'again', keys: ['presenting.backup'], kept: ['presenting.warnAt'] })
  rmSync(dir, { recursive: true, force: true })
  rmSync(dir2, { recursive: true, force: true })
})

await test('review #3: import never applies a path setting; the image archive folder is set on this Mac only', async () => {
  const paths = schema.settings.filter((d) => d.type === 'path').map((d) => d.key)
  assert.deepEqual(paths.filter((k) => !LOCAL_ONLY_KEYS.includes(k)), [], 'every path setting is local only')
  assert.ok(paths.includes('general.imageArchive'))
  const dir = tmp()
  const store = openStore(dir, { kind: 'you' }); await store.ready
  const preview = store.previewImport(JSON.stringify({ ...store.exportFile({ hostName: 'test' }), settings: { 'general.imageArchive': '/tmp/untrusted-archive', 'presenting.warnAt': 9 } }), { pathExists: () => true })
  assert.equal(Object.fromEntries(preview.skipped.map((x) => [x.key, x.reason]))['general.imageArchive'], LOCAL_ONLY)
  assert.ok(!preview.changes.some((c) => c.key === 'general.imageArchive'))
  await store.close()
  rmSync(dir, { recursive: true, force: true })
})

await test('review #7: editor keys are whole CodeMirror keys on every route (store, CLI, import, main, renderer)', async () => {
  for (const k of ['b', 'Mod-b', 'Mod-Alt-ArrowUp', 'Shift-Tab', 'Ctrl-/', 'Alt-Enter', 'F5', 'Space', 'Mod-Shift-[', 'Cmd-k', 'c-x']) assert.ok(isEditorKeyString(k), k)
  for (const k of ['Bogus-b', 'Mod-Mod-b', 'Mod-', '', ' ', 'Ctrl-a b', 'Mod-Bogus', 'Hyper-x', 'Mod-ArrowSideways']) assert.ok(!isEditorKeyString(k), k)
  for (const [id] of Object.entries(REBINDABLE)) for (const code of SHORTCUT_REGISTRY.find((x) => x.id === id)?.codes ?? []) assert.ok(isEditorKeyString(code), `${id}: ${code}`)
  const bogus = JSON.stringify({ bold: 'Bogus-b' })
  assert.match(appKeysError(bogus), /not a key/)
  assert.equal(appKeysError(JSON.stringify({ bold: 'b', undo: '' })), null)
  assert.deepEqual(parseAppKeys(JSON.stringify({ bold: 'Bogus-b', italic: 'i' })), { italic: 'i' }, 'a stored bad key is never handed to the editor')
  assert.equal(overridesArg({ bold: 'Bogus-b' }), null, 'keymap:set refuses it')
  assert.deepEqual(legacyOverridesArg({ bold: 'Bogus-b', italic: 'Mod-Alt-i' }), { italic: 'Mod-Alt-i' }, 'the old localStorage copy drops it')
  const dir = tmp()
  const store = openStore(dir, { kind: 'you' }); await store.ready
  assert.equal((await store.set(KEYMAP_SETTING, bogus)).ok, false, 'the store refuses it')
  const preview = store.previewImport(JSON.stringify({ ...store.exportFile({ hostName: 'test' }), settings: { [KEYMAP_SETTING]: bogus } }), { pathExists: () => true })
  assert.ok(!preview.changes.some((c) => c.key === KEYMAP_SETTING), 'import does not apply it')
  await store.close()
  const io = { stdout: () => {}, stderr: () => {}, env: {} }
  assert.notEqual(await runTalkWeaverSettings(['set', KEYMAP_SETTING, bogus], { dir, version: '0.42.0-preview.2', io }), 0, 'the CLI refuses it')
  const renderer = readFileSync(new URL('../src/renderer/src/keymap/store.ts', import.meta.url), 'utf8')
  assert.match(renderer, /export function isValidKeyString\(s: unknown\): s is string \{\s*return isEditorKeyString\(s\)/, 'the renderer applies the same check')
  rmSync(dir, { recursive: true, force: true })
})

await test('review #5: a shortcut reset in Settings shows the default, never an older app-layer key under it', async () => {
  const ids = { bridleIdOfKeymapId, keymapIdOf }
  const dir = tmp()
  const store = openStore(dir, { kind: 'you' }); await store.ready
  const km = createSettingsKeymap(store, ids)
  const bold = bridleIdOfKeymapId('bold')
  await km.set({ bold: 'b', italic: 'i' })
  assert.equal(km.overrides().bold, 'b')
  // The Settings window rebinds Bold (the package's own channel): main sees the registry change.
  let before = { ...store.view().keys }
  assert.equal((await store.rebind(bold, '⌘⇧B')).ok, true)
  await km.registryChanged(before, store.view().keys)
  assert.equal(km.overrides().bold, 'Mod-Shift-b')
  assert.deepEqual(parseAppKeys(store.view().settings[KEYMAP_SETTING]), { italic: 'i' }, 'the hidden bare key is gone; others stay')
  before = { ...store.view().keys }
  assert.equal((await store.reset({ commandId: bold })).ok, true)
  await km.registryChanged(before, store.view().keys)
  assert.equal(km.overrides().bold, undefined, 'reset: the default, not "b"')
  assert.equal(km.overrides().italic, 'i')
  // km.set writes both layers together: a registry change seen while it writes is its own and not undone.
  const writing = km.set({ bold: 'b', italic: 'i' })
  await km.registryChanged({ [bold]: '⌘⇧B' }, {})
  await writing
  assert.equal(km.overrides().bold, 'b')
  // Only the command whose registry shortcut changed loses its app-layer key.
  await km.registryChanged({}, { [bridleIdOfKeymapId('highlight')]: '⌘⌥H' })
  assert.deepEqual(parseAppKeys(store.view().settings[KEYMAP_SETTING]), { bold: 'b', italic: 'i' })
  await store.close()
  rmSync(dir, { recursive: true, force: true })
})

await test('review #9: a keyboard move that could not be written answers retry and keeps its source; consumed once it lands', async () => {
  const ids = { bridleIdOfKeymapId, keymapIdOf }
  const dir = tmp()
  const opened = openStore(dir, { kind: 'you' }); await opened.ready; await opened.close() // the file exists
  const store = lockedStore(dir); await store.ready
  const km = createSettingsKeymap(store, ids)
  let moved = false
  const lock = await acquireLock(join(dir, 'settings.json'), { waitMs: 200 })
  const held = await km.moveLegacy({ italic: 'Mod-Alt-i' }, () => moved, () => { moved = true })
  assert.equal(held.outcome, 'retry')
  assert.equal(moved, false, 'not marked: tried again at the next launch')
  await lock.release()
  assert.equal((await km.moveLegacy({ italic: 'Mod-Alt-i' }, () => moved, () => { moved = true })).outcome, 'consumed')
  assert.equal(moved, true)
  await store.close()
  const renderer = readFileSync(new URL('../src/renderer/src/keymap/store.ts', import.meta.url), 'utf8')
  assert.match(renderer, /if \(legacy !== null && r\?\.outcome === 'consumed'\) \{ try \{ window\.localStorage\.removeItem\(STORAGE_KEY\)/, 'the renderer deletes its copy only on consumed')
  assert.equal((renderer.match(/localStorage\.removeItem/g) ?? []).length, 1)
  const main = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  assert.match(main, /if \(!settingsKeymap \|\| !overrides\) return \{ outcome: 'retry'/, 'no store yet: retry')
  rmSync(dir, { recursive: true, force: true })
})

await test('review #6: setup opens the shared store after the migration and reads and writes through it, never config.json', async () => {
  const dir = tmp()
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ vaults: [], recordingR2Endpoint: 'https://old.example.com' }))
  let fileConfig = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
  const file = { read: () => ({ ...fileConfig }), write: (p) => { fileConfig = { ...fileConfig, ...p }; writeFileSync(join(dir, 'config.json'), JSON.stringify(fileConfig)) } }
  // The app ran: moved in, then the endpoint changed in Settings.
  const app = await openSettings({ dir, appVersion: '0.42.0-preview.2', file, watch: false, log: () => {} })
  assert.equal(app.migration.kind, 'first')
  app.overlay.write({ recordingR2Endpoint: 'https://new.example.com' })
  await app.close()
  // `setup recording` reads the shared value and its write lands in the store.
  const setup = await openSettings({ dir, appVersion: '0.42.0-preview.2', file, watch: false, log: () => {} })
  assert.equal(setup.overlay.read().recordingR2Endpoint, 'https://new.example.com', 'setup sees the store, not config.json')
  setup.overlay.write({ recordingR2Endpoint: 'https://setup.example.com' })
  await setup.close()
  assert.equal(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).recordingR2Endpoint, 'https://old.example.com', 'config.json is not written')
  const again = await openSettings({ dir, appVersion: '0.42.0-preview.2', file, watch: false, log: () => {} })
  assert.equal(again.migration.kind, 'none', 'the next launch keeps setup’s value')
  assert.equal(again.overlay.read().recordingR2Endpoint, 'https://setup.example.com')
  await again.close()
  const main = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  const setupFn = main.slice(main.indexOf('async function runSetupCommand('), main.indexOf('// ── App lifecycle'))
  assert.ok(setupFn.indexOf('() => openSettings(') > 0 && setupFn.indexOf('() => openSettings(') < setupFn.indexOf('createSetupOperations('), 'the store is opened before setup reads anything')
  assert.match(setupFn, /settingsOverlay = opened\.overlay/)
  assert.match(setupFn, /const code = await runWithSettings\(/, 'no usable store: setup does nothing rather than use config.json (runWithSettings)')
  rmSync(dir, { recursive: true, force: true })
})

await test('review #2: every change the Settings window’s own pages make is refused from any other sender', () => {
  const preload = readFileSync(new URL('../src/preload/settings.ts', import.meta.url), 'utf8')
  const invoked = [...new Set([...preload.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((m) => m[1]))]
  const lists = [SETTINGS_WINDOW_ONLY, Object.keys(SHARED_CHANGES), READS]
  for (const ch of invoked) assert.equal(lists.filter((l) => l.includes(ch)).length, 1, `${ch} is classified once`)
  for (const l of lists) for (const ch of l) assert.ok(invoked.includes(ch), `${ch} is a channel of the Settings preload`)
  const main = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  assert.match(main, /function fromSettingsWindow\(event: IpcMainInvokeEvent\): boolean \{\s*return sharedSettings\?\.host\.isSettingsWindowSender\(event\) === true/, 'the whole event goes to the host')
  assert.match(main, /ipcMain\.handle\(channel, settingsWindowOnly\(fromSettingsWindow, refused, handler\)\)/)
  for (const ch of SETTINGS_WINDOW_ONLY) {
    assert.match(main, new RegExp(`handleFromSettingsWindow\\(\\s*'${ch}'`), `${ch} goes through the guard`)
    assert.ok(!main.includes(`ipcMain.handle('${ch}'`), `${ch} has no unguarded handler`)
  }
})

await test('review #4: the Cloudflare page’s Save and Disconnect log the token as connected / missing in Changes', async () => {
  const dir = tmp()
  const store = openStore(dir, { kind: 'you' }); await store.ready
  let token = null
  const record = (from, to) => store.recordSecret(SECRET_KEYS.cloudflare, from, to)
  let told = 0
  const saved = await recordedKeyChange({ has: () => token !== null, run: () => { token = FAKE_SECRETS.cloudflareToken; return { ok: true, status: {} } }, record, changed: () => { told += 1 } })
  assert.equal(saved.ok, true)
  assert.deepEqual([store.view().changes[0].key, store.view().changes[0].from, store.view().changes[0].to], [SECRET_KEYS.cloudflare, 'missing', 'connected'])
  await recordedKeyChange({ has: () => token !== null, run: () => ({ ok: false, error: 'refused', status: {} }), record })
  assert.equal(store.view().changes.length, 1, 'a refused save logs nothing')
  await recordedKeyChange({ has: () => token !== null, run: () => { token = null; return { ok: true, status: {} } }, record, changed: () => { told += 1 } })
  assert.deepEqual([store.view().changes[0].from, store.view().changes[0].to], ['connected', 'missing'])
  assert.equal(told, 2, 'the key list is read again after each change')
  assert.ok(!readFileSync(join(dir, 'settings.json'), 'utf8').includes('FAKE-SECRET'), 'never the value')
  await store.close()
  const main = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  assert.match(main, /handleFromSettingsWindow\('cloudflare:save-token', cloudflareSettingsOnly, \(_event, token: unknown\) => recordedCloudflareKeyChange\(/)
  assert.match(main, /handleFromSettingsWindow\('cloudflare:disconnect', cloudflareSettingsOnly, \(\) => recordedCloudflareKeyChange\(/)
  assert.match(main, /sharedSettings\.store\.recordSecret\(SECRET_KEYS\.cloudflare, from, to\)/)
  rmSync(dir, { recursive: true, force: true })
})

// ── Sol review 2 ────────────────────────────────────────────────────────────────────────────────
/** A settings file written by a newer version of the format: the store opens it, reports newer-version, and refuses changes. */
const newerFormatDir = async () => {
  const dir = tmp()
  const s = openStore(dir, { kind: 'you' }); await s.ready
  assert.equal((await s.set('presenting.warnAt', 7)).ok, true)
  await s.close()
  const raw = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
  assert.equal(typeof raw.version, 'number')
  raw.version += 1
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(raw, null, 2))
  return { dir, text: readFileSync(join(dir, 'settings.json'), 'utf8') }
}

await test('every Settings-window-only change, the recording storage and transcription paths included: the editor window is refused and the handler never runs; the Settings window is allowed', () => {
  const top = { routingId: 1 }
  const child = { routingId: 2 }
  const SETTINGS = 20, EDITOR = 7
  // The settings host's check takes the whole event; a stand-in that knows only the Settings window's own page.
  const fromSettingsWindow = (event) => event.sender?.id === SETTINGS && event.senderFrame === top
  const from = (id, frame = top) => ({ sender: { id, mainFrame: top }, senderFrame: frame })
  for (const ch of ['recording:set-storage', 'recording:set-keys', 'recording:clear-keys', 'preferences:set-transcription']) assert.ok(SETTINGS_WINDOW_ONLY.includes(ch), `${ch} is Settings-window-only`)
  const FAKE_KEYS = { accessKeyId: 'fake-id-0000', secretAccessKey: 'fake-secret-0000' }
  for (const ch of SETTINGS_WINDOW_ONLY) {
    const ran = []
    const guarded = settingsWindowOnly(fromSettingsWindow, () => RECORDING_SETTINGS_ONLY, (_event, ...args) => { ran.push(args); return { success: true } })
    assert.deepEqual(guarded(from(EDITOR), FAKE_KEYS), RECORDING_SETTINGS_ONLY, `${ch}: the editor window is refused`)
    assert.deepEqual(guarded(from(SETTINGS, child), FAKE_KEYS), RECORDING_SETTINGS_ONLY, `${ch}: a frame inside the Settings window is refused`)
    assert.equal(ran.length, 0, `${ch}: the handler did not run for a refused sender`)
    assert.deepEqual(guarded(from(SETTINGS), FAKE_KEYS), { success: true }, `${ch}: the Settings window is allowed`)
    assert.deepEqual(ran, [[FAKE_KEYS]], `${ch}: the handler got the arguments`)
  }
  assert.deepEqual(RECORDING_SETTINGS_ONLY, { success: false, error: 'This can be changed only in the Settings window.' })
  const main = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  for (const ch of ['recording:set-storage', 'recording:set-keys', 'recording:clear-keys']) {
    assert.match(main, new RegExp(`handleFromSettingsWindow\\(\\s*'${ch}',\\s*\\(\\) => RECORDING_SETTINGS_ONLY`), `${ch}: refused with the recording reply`)
  }
  // The editor window's preload no longer has these calls at all.
  const editorPreload = readFileSync(new URL('../src/preload/index.ts', import.meta.url), 'utf8')
  for (const ch of [...SETTINGS_WINDOW_ONLY.filter((c) => c.startsWith('recording:')), 'preferences:set-transcription']) assert.ok(!editorPreload.includes(`'${ch}'`), `${ch} is not in the editor preload`)
  // The transcription paths: refused with the paths as they are (the reply its callers read), never through an unguarded handler.
  assert.match(main, /handleFromSettingsWindow\('preferences:set-transcription', \(\) => transcriptionSettings\(\), async/)
})

await test('Set up recording storage on the Cloudflare page goes to Recording with the Storage endpoint field focused', () => {
  assert.deepEqual(RECORDING_STORAGE_FIELD, { section: 'recording', key: 'recording.endpoint' })
  const def = schema.settings.find((d) => d.key === RECORDING_STORAGE_FIELD.key)
  assert.ok(def && def.section === RECORDING_STORAGE_FIELD.section && def.label === 'Storage endpoint', 'the key names the Recording page’s Storage endpoint row')
  // A stand-in for the window's DOM: rows carry data-key; each holds its field.
  const log = []
  const field = { focus: (o) => log.push(['focus', o]) }
  const row = { scrollIntoView: (o) => log.push(['scroll', o]), querySelector: (sel) => (sel === 'input, select, textarea' ? field : null) }
  const root = (rows) => ({ querySelector: (sel) => rows[sel] ?? null })
  assert.equal(focusSettingField(root({ '[data-key="recording.endpoint"]': row }), 'recording.endpoint'), true)
  assert.deepEqual(log, [['scroll', { block: 'center' }], ['focus', { preventScroll: true }]], 'brought into view (the bucket row under it too), then focused')
  assert.equal(focusSettingField(root({}), 'recording.endpoint'), false, 'not on screen yet: tried again later')
  assert.equal(focusSettingField(root({ '[data-key="recording.endpoint"]': { querySelector: () => null } }), 'recording.endpoint'), false, 'a row with no field')
  // The wiring: the page's button calls goToSetting with that field, which reopens the window at the section with the key selected.
  const mainTsx = readFileSync(new URL('../src/renderer/src/settings-main.tsx', import.meta.url), 'utf8')
  assert.match(mainTsx, /<CloudflarePage onSetUpRecording=\{\(\) => goToSetting\(RECORDING_STORAGE_FIELD\.section, RECORDING_STORAGE_FIELD\.key\)\} \/>/)
  assert.match(mainTsx, /focusSettingField\(document, key\)/)
  const pages = readFileSync(new URL('../src/renderer/src/components/SettingsWindowPages.tsx', import.meta.url), 'utf8')
  assert.match(pages, /<CloudflareSettings[\s\S]*?onSetUpRecording=\{onSetUpRecording\}/, 'the page passes the button through, not an empty handler')
})

await test('Sol review 4: Create site and setting up going live are Settings-window-only; editor, Tools and Pathways windows are refused; editor UI opens Settings instead', () => {
  const top = { routingId: 1 }
  const child = { routingId: 2 }
  const SETTINGS = 20, EDITOR = 7, TOOLS = 11, PATHWAYS = 12
  // The settings host's check takes the whole event; a stand-in that knows only the Settings window's own page.
  const fromSettingsWindow = (event) => event.sender?.id === SETTINGS && event.senderFrame === top
  const from = (id, frame = top) => ({ sender: { id, mainFrame: top }, senderFrame: frame })
  const main = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  const REFUSED = { ok: false, error: 'refused' }
  for (const ch of ['cloudflare:create-site', 'live-service:set-up']) {
    assert.ok(SETTINGS_WINDOW_ONLY.includes(ch), `${ch} is Settings-window-only`)
    assert.ok(!(ch in SHARED_CHANGES), `${ch} is no longer a shared change`)
    let ran = 0
    const guarded = settingsWindowOnly(fromSettingsWindow, () => REFUSED, () => { ran += 1; return { ok: true } })
    for (const [who, event] of [['an editor window’s top frame', from(EDITOR)], ['the Tools window', from(TOOLS)], ['the Pathways window', from(PATHWAYS)], ['a frame inside an editor window', from(EDITOR, child)], ['a frame inside the Settings window', from(SETTINGS, child)]]) {
      assert.deepEqual(guarded(event), REFUSED, `${ch}: ${who} is refused`)
    }
    assert.equal(ran, 0, `${ch}: nothing ran for a refused sender`)
    assert.deepEqual(guarded(from(SETTINGS)), { ok: true }, `${ch}: the Settings window is allowed`)
    assert.equal(ran, 1)
    assert.match(main, new RegExp(`handleFromSettingsWindow\\(\\s*'${ch}'`), `${ch} goes through the guard`)
    assert.equal((main.match(new RegExp(`'${ch}'`, 'g')) ?? []).length, 1, `${ch}: one handler`)
  }
  assert.deepEqual(Object.keys(SHARED_CHANGES).filter((ch) => !ch.startsWith('updates:')), [], 'only update-notice preferences and state are shared with the editor')
  assert.ok(!/setUpAllowedFrom|sharedChangeAllowed/.test(main), 'no editor exception is left in main')
  // The editor entry points open Settings → Cloudflare instead of asking main to do it.
  const component = (name) => readFileSync(new URL(`../src/renderer/src/components/${name}`, import.meta.url), 'utf8')
  const sheet = component('PublishNotReadySheet.tsx')
  assert.ok(!/createSite\(/.test(sheet) && /window\.tw\.cloudflare\.openSettings\(\)/.test(sheet), 'the publish sheet’s fix opens Settings → Cloudflare')
  const answers = component('RunAnswers.tsx')
  assert.ok(!/liveService\.setUp\(/.test(answers) && /data-run-set-up-live onClick=\{\(\) => \{ void window\.tw\.cloudflare\.openSettings\(\)/.test(answers), 'the Run answers page opens Settings → Cloudflare')
  // Only Settings → Cloudflare (CloudflareSettings.tsx, mounted only by the Settings window's page) calls them.
  const dir = new URL('../src/renderer/src/', import.meta.url)
  const files = []
  const walk = (d) => { for (const f of readdirSync(d)) { const full = join(d, f); if (statSync(full).isDirectory()) walk(full); else if (/\.tsx?$/.test(f)) files.push(full) } }
  walk(dir.pathname)
  const callers = files.filter((f) => /\.createSite\(|liveService\.setUp\(/.test(readFileSync(f, 'utf8'))).map((f) => f.slice(dir.pathname.length))
  assert.deepEqual(callers, ['components/CloudflareSettings.tsx'])
  const mounts = files.filter((f) => /import CloudflareSettings from/.test(readFileSync(f, 'utf8'))).map((f) => f.slice(dir.pathname.length))
  assert.deepEqual(mounts, ['components/SettingsWindowPages.tsx'], 'the Cloudflare page is mounted only in the Settings window')
})

await test('review r2 #9: a newer-format settings file answers retry for the old keyboard shortcuts and keeps their source', async () => {
  const { dir, text } = await newerFormatDir()
  const store = openStore(dir, { kind: 'you' }); await store.ready
  assert.equal(store.problem()?.code, 'newer-version')
  const km = createSettingsKeymap(store, { bridleIdOfKeymapId, keymapIdOf })
  let marked = false
  const r = await km.moveLegacy({ bold: 'b' }, () => marked, () => { marked = true })
  assert.equal(r.outcome, 'retry', 'never consumed: the renderer keeps localStorage')
  assert.equal(marked, false, 'not marked moved')
  assert.equal(readFileSync(join(dir, 'settings.json'), 'utf8'), text, 'the file is left as it is')
  // A store-level refusal of the write itself (no problem() reported) is retry too.
  const refusing = { view: () => ({ settings: {}, keys: {} }), set: async () => ({ ok: false, code: 'refused', error: 'x' }), reset: async () => ({ ok: false, code: 'refused', error: 'x' }), rebindMany: async () => ({ ok: false, code: 'refused', error: 'x' }) }
  assert.equal((await createSettingsKeymap(refusing, { bridleIdOfKeymapId, keymapIdOf }).moveLegacy({ bold: 'b' }, () => false, () => { marked = true })).outcome, 'retry')
  assert.equal(marked, false)
  await store.close()
  rmSync(dir, { recursive: true, force: true })
})

await test('review r2 new: recording setup against a newer-format settings file does nothing, exits non-zero and leaves the file unchanged', async () => {
  const { dir, text } = await newerFormatDir()
  let fileConfig = { vaults: [] }
  const file = { read: () => ({ ...fileConfig }), write: (p) => { fileConfig = { ...fileConfig, ...p } } }
  const errs = []
  let ran = false
  // The recording step as setup runs it: it writes the endpoint and bucket through the overlay and answers success.
  const recordingSetup = async (opened) => { ran = true; opened.overlay.write({ recordingR2Endpoint: 'https://setup.example.com', recordingR2Bucket: 'talks' }); return 0 }
  const code = await runWithSettings(() => openSettings({ dir, appVersion: '0.42.0-preview.3', file, watch: false, log: () => {} }), recordingSetup, (l) => errs.push(l))
  assert.notEqual(code, 0, 'not ok')
  assert.equal(ran, false, 'nothing was done')
  assert.ok(errs.some((l) => /Nothing was done\./.test(l)), errs.join('\n'))
  assert.equal(readFileSync(join(dir, 'settings.json'), 'utf8'), text, 'the settings file is unchanged')
  assert.equal(fileConfig.recordingR2Endpoint, undefined, 'config.json not written either')
  // A usable store whose write fails: setup reports failure although the step answered success.
  const ok = tmp()
  const errs2 = []
  const badWrite = async (opened) => { opened.overlay.write({ recordingDiscardMs: 'not a number' }); return 0 }
  const failed = await runWithSettings(() => openSettings({ dir: ok, appVersion: '0.42.0-preview.3', file, watch: false, log: () => {} }), badWrite, (l) => errs2.push(l))
  assert.notEqual(failed, 0, 'an unsaved preference fails setup')
  assert.ok(errs2.some((l) => /A setting was not saved/.test(l)), errs2.join('\n'))
  const fine = await runWithSettings(() => openSettings({ dir: ok, appVersion: '0.42.0-preview.3', file, watch: false, log: () => {} }), async (opened) => { opened.overlay.write({ recordingR2Bucket: 'talks' }); return 0 }, () => {})
  assert.equal(fine, 0, 'a saved write: success')
  rmSync(dir, { recursive: true, force: true })
  rmSync(ok, { recursive: true, force: true })
})

console.log(`shared settings: ${passed} passed`)
