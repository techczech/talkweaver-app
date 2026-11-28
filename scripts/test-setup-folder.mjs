// The set-up folder (0.45, two Macs): src/shared/setup-folder.ts and src/main/setup-folder.ts, driven
// with REAL settings stores, two or three simulated Macs each with its own user-data folder, sharing
// one set-up folder (or, in the property test, each with its own copy of it and a simulated sync
// service between them). Temporary folders only; nothing of the owner's is read.
//
//   node scripts/test-setup-folder.mjs            every table, then the property test (200 runs)
//   SETUP_FOLDER_SEED=123 node scripts/…          the property test from one seed (printed on failure)
import assert from 'node:assert/strict'
import { constants as fsConstants, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, statSync, copyFileSync, truncateSync, renameSync, openSync, closeSync, chmodSync } from 'node:fs'
import { availableParallelism, tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { isMainThread, Worker, workerData } from 'node:worker_threads'
import { commandsAdapter } from '@app-patterns/settings'
import { SETTINGS_FILE_NAME, SettingsStore } from '@app-patterns/settings/node'
import { registry, APP_ID } from '../src/shared/bridle-commands.ts'
import { schema } from '../src/shared/settings-schema.ts'
import { LOCAL_ONLY_KEYS } from '../src/shared/settings-folders.ts'
// Imported whole, so this file also loads against an earlier engine (each regression below was checked to fail on
// b6f75ef1 (round 1) or 91da8024 (round 2)).
import * as shared from '../src/shared/setup-folder.ts'
import * as engineModule from '../src/main/setup-folder.ts'
const { createSetupFolderEngine, nodeSetupFs, STATE_FILE, lookAtSetupFolder } = engineModule
const AWAIT_POINTS = engineModule.AWAIT_POINTS ?? ['read', 'temp-read', 'temp-removed', 'batch-saved', 'imported', 'batch-finished', 'write-id-saved', 'temp-written', 'destination-read', 'renamed']
const {
  SETUP_FOLDER_NAME, SETUP_FILE_FORMAT, classifyName, macFileName, newestWins, parseMacFile, resolveSetupFolder, travellingSettingKeys, stayingSettingKeys,
  localStamp, PER_MAC_KEYS, SETUP_FOLDER_SETTING, STAYS_ON_THIS_MAC, unlistedSettingKeys, serialiseSetting, serialiseVaultField, serialiseSuggestion,
  entryJudge, EARLIEST_AT, CLOCK_MARGIN_MS = 5 * 60_000, ASK_FIRST = ['publishing.cloudflareAccount', 'publishing.cloudflareSite', 'publishing.branch'], cleanMacName
} = shared
const MAX_PLAIN = 200
const TRAVELLING = shared.TRAVELLING ?? Object.fromEntries(travellingSettingKeys(schema).map((k) => [k, null]))
const { cleanPersonal } = await import('../src/shared/vault-personal.ts').catch(() => import('../src/main/vault-registry.ts'))
import { startSetupFolderHost } from '../src/main/setup-folder-host.ts'
import { runTalkWeaverSettings } from '../src/main/settings-cli.ts'
import { testScratchDir } from './lib/test-scratch.mjs'

let passed = 0
const failed = []
// SETUP_FOLDER_ONLY=<text>: only the tests whose name has it. SETUP_FOLDER_KEEP_GOING=1: report each failure and go on.
const test = async (name, fn) => {
  if (!isMainThread) return
  if (process.env.SETUP_FOLDER_ONLY && !name.includes(process.env.SETUP_FOLDER_ONLY)) return
  try { await fn() } catch (error) {
    if (!process.env.SETUP_FOLDER_KEEP_GOING) throw error
    failed.push(name); console.log(`  FAIL  ${name}\n        ${String(error?.message ?? error).split('\n')[0].slice(0, 200)}`); return
  }
  passed += 1; console.log(`  ok  ${name}`)
}
const scratch = isMainThread ? testScratchDir(join(tmpdir(), 'tw-setup-folder-')) : workerData.scratch
const tmp = (tag = 'x') => mkdtempSync(join(scratch, `${tag}-`))
const commands = commandsAdapter(registry)
const DAY = 86_400_000
const T0 = Date.UTC(2026, 10, 16, 9, 0, 0)

if (isMainThread) console.log('set-up folder')

// ── A simulated Mac ─────────────────────────────────────────────────────────────────────────────

/** A file system that records every call; `refuse(op, path)` may throw to simulate a kill. */
function recordingFs(owner, refuse = () => {}, transform = (_path, text) => text) {
  const calls = []
  const wrap = (op, fn) => async (...args) => { calls.push({ op, path: args[0], to: op === 'rename' ? args[1] : undefined, owner }); refuse(op, args[0], args[1]); return fn(...args) }
  return {
    calls,
    fs: {
      readdir: wrap('readdir', nodeSetupFs.readdir), lstat: wrap('lstat', nodeSetupFs.lstat),
      // `transform` plays a file that changes between reads, or a read that never answers.
      readText: wrap('readText', async (path, max) => transform(path, await nodeSetupFs.readText(path, max))),
      mkdir: wrap('mkdir', nodeSetupFs.mkdir), writeNew: wrap('writeNew', nodeSetupFs.writeNew), rename: wrap('rename', nodeSetupFs.rename),
      unlink: wrap('unlink', nodeSetupFs.unlink), syncDir: wrap('syncDir', nodeSetupFs.syncDir)
    }
  }
}

const macs = []
// One world clock: every simulated Mac reads it, plus its own offset (a Mac whose clock is wrong).
let worldTick = 0
let machines = 0

function openStore(dir, now) {
  return new SettingsStore({ dir, app: APP_ID, schema, registry: commands, appVersion: '0.45.0', watch: false, log: () => {}, now })
}

async function makeMac(name, opts = {}) {
  const dir = opts.dir ?? tmp(name.replace(/\W/g, ''))
  // Each simulated Mac is its own computer (its own fingerprint) unless told otherwise; null = cannot be told.
  const machine = opts.machine === undefined ? `machine-${name.replace(/\W/g, '')}-${++machines}` : opts.machine
  const mac = { name, dir, machine, offset: opts.offset ?? 0, tick: 0, chosen: opts.chosen ?? '', vaults: opts.vaults ?? [], personal: opts.personal ?? {}, suggestionValues: opts.suggestions ?? { handoutAddress: '', shareLinkAddress: '' }, used: [] }
  mac.clock = () => T0 + mac.offset + worldTick
  mac.advance = (ms = 1000) => { worldTick += ms }
  mac.store = openStore(dir, mac.clock)
  await mac.store.ready
  mac.rec = recordingFs(name, (op, path, to) => mac.refuse?.(op, path, to), (path, text) => (mac.transformRead ? mac.transformRead(path, text) : text))
  mac.engine = createSetupFolderEngine({
    dir, store: storePort(mac.store, mac), schema, commands, commandLabel: (id) => id,
    chosen: () => (opts.chosenFromStore ? String(mac.store.view().settings[SETUP_FOLDER_SETTING] ?? '') : mac.chosen), macName: () => mac.name, appVersion: '0.45.0',
    vaults: {
      list: () => mac.vaults,
      personal: (id) => ({ ...(mac.personal[id] ?? {}) }),
      // As the vault registry does: merge, then keep only what its cleaner keeps.
      setPersonal: (id, patch) => {
        mac.beforeSetPersonal?.(id, patch)
        const merged = { ...cleanPersonal(mac.personal[id]) }
        for (const [k, v] of Object.entries(patch)) merged[k] = v
        const clean = cleanPersonal(merged)
        if (Object.keys(clean).length) mac.personal[id] = clean; else delete mac.personal[id]
        mac.afterSetPersonal?.(id, patch)
      }
    },
    suggestions: {
      current: () => ({ ...mac.suggestionValues }),
      canUse: () => ({ ok: true }),
      use: async (kind, value) => { mac.suggestionValues[kind] = value; mac.used.push([kind, value]); return { ok: true } }
    },
    fs: mac.rec.fs, home: '/home/test', now: () => mac.clock(), fingerprint: () => mac.machine, readBudgetMs: opts.readBudgetMs,
    awaited: (point) => mac.awaited?.(point)
  })
  mac.restart = async () => {
    await mac.store.close()
    const again = await makeMac(name, { ...opts, dir, machine: mac.machine, offset: mac.offset, chosen: mac.chosen, vaults: mac.vaults, personal: mac.personal, suggestions: mac.suggestionValues })
    return again
  }
  mac.value = (key) => { const s = mac.store.view().settings; return Object.hasOwn(s, key) ? s[key] : schema.def(key).default }
  mac.chord = (cmd) => { const k = mac.store.view().keys; return Object.hasOwn(k, cmd) ? k[cmd] : commands.defaultChord(cmd) }
  mac.set = async (key, value) => { mac.advance(); const r = await mac.store.set(key, value); assert.ok(r.ok, `${name} set ${key}: ${r.error}`) }
  mac.sync = async () => { mac.advance(); return mac.engine.sync('demand') }
  macs.push(mac)
  return mac
}
function storePort(store, mac) {
  return {
    view: () => store.view(),
    problem: () => store.problem(),
    previewImport: (file) => store.previewImport(file),
    applyImport: (preview, opts) => store.applyImport(preview, opts),
    // `mac.undoBatchFails`: the store refuses to undo (a settings file that cannot be written, say).
    undoBatch: async (id) => (mac.undoBatchFails ? { ok: false, error: 'could not write the settings file' } : store.undoBatch(id))
  }
}
const sharedFolder = () => { const root = tmp('shared'); return root }
async function join2(a, b) {
  // a joins first (an empty folder: joined at once), b joins and applies the preview.
  await a.sync()
  let s = await b.sync()
  if (s.state === 'joining') { const r = await b.engine.applyJoin(s.preview.token); assert.ok(r.ok, r.error); s = r.status }
  assert.equal(s.state, 'joined')
  return s
}
const filesIn = (folder) => readdirSync(folder).filter((n) => !n.startsWith('.'))
const readMacFile = (folder, mac) => JSON.parse(readFileSync(join(folder, macFileName(mac.engine.macId())), 'utf8'))

/** F1 at the file-system layer: no Mac ever opened, renamed over or removed another Mac's file. */
function assertOnlyOwnWrites(list) {
  for (const mac of list) {
    const own = mac.engine.macId()
    for (const c of mac.rec.calls) {
      if (!['writeNew', 'rename', 'unlink', 'mkdir'].includes(c.op)) continue
      for (const p of [c.path, c.to].filter(Boolean)) {
        const kind = classifyName(basename(p))
        if (kind.kind === 'ignore') { assert.equal(c.op, 'mkdir', `${mac.name} ${c.op} ${p}`); continue }
        assert.equal(kind.macId, own, `${mac.name} ${c.op} touched another Mac's file ${p}`)
        assert.ok(kind.kind === 'mac' || kind.kind === 'temp', `${mac.name} ${c.op} ${p}`)
      }
    }
  }
}

// ── Pure parts ──────────────────────────────────────────────────────────────────────────────────

await test('names: only mac-<uuid>.json is a Mac file; copies, placeholders and temps are named as such', () => {
  const id = '0f8fad5b-d9cb-469f-a165-70867728950e'
  const table = [
    [`mac-${id}.json`, 'mac'],
    [`mac-${id} 2.json`, 'copy'], // iCloud
    [`mac-${id} (MacBook Air's conflicted copy 2026-11-16).json`, 'copy'], // Dropbox
    [`mac-${id}-MacBookAir.json`, 'copy'], // OneDrive
    [`mac-${id}.sync-conflict-20261116-101010-ABCDEFG.json`, 'copy'], // Syncthing
    [`mac-${id} (1).json`, 'copy'], // Google Drive
    [`.mac-${id}.json.icloud`, 'placeholder'],
    [`.mac-${id}.json.7d0c.tmp`, 'temp'],
    ['.DS_Store', 'ignore'], ['notes.txt', 'ignore'], [`mac-${id.toUpperCase()}.json`, 'ignore']
  ]
  for (const [name, kind] of table) assert.equal(classifyName(name).kind, kind, name)
})

await test('the folder: a TalkWeaver set-up folder is made inside the one chosen, unless it is one', () => {
  assert.equal(resolveSetupFolder('', '/h'), '')
  assert.equal(resolveSetupFolder('/Users/a/Dropbox', '/h'), `/Users/a/Dropbox/${SETUP_FOLDER_NAME}`)
  assert.equal(resolveSetupFolder('/Users/a/Dropbox/', '/h'), `/Users/a/Dropbox/${SETUP_FOLDER_NAME}`)
  assert.equal(resolveSetupFolder(`/Users/a/Dropbox/${SETUP_FOLDER_NAME}`, '/h'), `/Users/a/Dropbox/${SETUP_FOLDER_NAME}`)
  assert.equal(resolveSetupFolder('~/iCloud', '/Users/b'), `/Users/b/iCloud/${SETUP_FOLDER_NAME}`)
})

await test('what travels is an explicit allow-list: every setting is named in TRAVELLING or STAYS_ON_THIS_MAC, never both', () => {
  const unlisted = unlistedSettingKeys(schema)
  assert.deepEqual(unlisted, [], `These settings are in the schema but in neither list in src/shared/setup-folder.ts: ${unlisted.join(', ')}. Add each to TRAVELLING (with the rule that writes or refuses its value) or to STAYS_ON_THIS_MAC (with why). Until then it does not travel.`)
  for (const key of Object.keys(TRAVELLING)) assert.ok(schema.def(key), `TRAVELLING names ${key}, which the schema does not have`)
  for (const key of Object.keys(STAYS_ON_THIS_MAC)) assert.ok(schema.def(key), `STAYS_ON_THIS_MAC names ${key}, which the schema does not have`)
  for (const key of Object.keys(TRAVELLING)) assert.ok(!Object.hasOwn(STAYS_ON_THIS_MAC, key), `${key} is in both lists`)
  const travelling = travellingSettingKeys(schema)
  const staying = stayingSettingKeys(schema)
  for (const d of schema.settings) {
    const t = travelling.includes(d.key)
    assert.notEqual(t, staying.includes(d.key), d.key)
    if (d.type === 'secret' || d.type === 'path' || LOCAL_ONLY_KEYS.includes(d.key) || Object.hasOwn(PER_MAC_KEYS, d.key)) assert.equal(t, false, d.key)
  }
  assert.ok(travelling.includes('publishing.cloudflareAccount') && travelling.includes('publishing.cloudflareSite'), 'the Cloudflare account and site travel')
  for (const k of ASK_FIRST) assert.ok(travelling.includes(k), k)
  assert.ok(!travelling.includes(SETUP_FOLDER_SETTING))
  // A setting added to the schema later does not travel until it is added to the table.
  const later = { ...schema, settings: [...schema.settings, { key: 'later.setting', label: 'Later', section: 'general', type: 'text', default: '' }] }
  assert.ok(!travellingSettingKeys(later).includes('later.setting'))
  assert.deepEqual(unlistedSettingKeys(later), ['later.setting'])
  console.log(`      ${travelling.length} settings travel; ${staying.length} stay on each Mac`)
})

await test('the merge, as a table: newest wins per target; a tie goes to this Mac; between others, to the larger id', () => {
  const m = (entries) => new Map(Object.entries(entries).map(([k, [value, at]]) => [k, { value, at }]))
  const rows = [
    // [own, remotes, expected winner per target as [value, from]]
    [{ a: [1, 10] }, [['m1', { a: [2, 20] }]], { a: [2, 'm1'] }],
    [{ a: [1, 30] }, [['m1', { a: [2, 20] }]], { a: [1, null] }],
    [{ a: [1, 20] }, [['m1', { a: [2, 20] }]], { a: [1, null] }],
    [{}, [['m1', { a: [2, 20] }], ['m2', { a: [3, 20] }]], { a: [3, 'm2'] }],
    [{}, [['m2', { a: [3, 20] }], ['m1', { a: [2, 20] }]], { a: [3, 'm2'] }],
    [{ b: [true, 5] }, [['m1', { a: ['x', 1] }]], { a: ['x', 'm1'], b: [true, null] }]
  ]
  for (const [own, remotes, want] of rows) {
    const { winners } = newestWins(m(own), remotes.map(([macId, e]) => ({ macId, entries: m(e) })))
    for (const [t, [value, from]] of Object.entries(want)) assert.deepEqual([winners.get(t).value, winners.get(t).from], [value, from], JSON.stringify({ own, remotes, t }))
  }
  assert.equal(localStamp(100, { value: 1, at: 500 }), 501, 'a change here is later than what it replaced')
  assert.equal(localStamp(900, { value: 1, at: 500 }), 900)
  assert.equal(localStamp(0, undefined), EARLIEST_AT, 'a value of unknown age is the oldest valid time')
})

await test('a file is read only when it is whole: Git markers, newer formats, a different Mac inside, impossible times are refused', () => {
  const id = '0f8fad5b-d9cb-469f-a165-70867728950e'
  const judge = entryJudge(schema, commands, T0)
  const ok = { format: SETUP_FILE_FORMAT, version: 1, macId: id, macName: 'A', appVersion: '0.45.0', writtenAt: T0, writeId: 'w', settings: { 'presenting.warnAt': { value: 7, at: T0 - 3 } }, shortcuts: {}, vaults: {}, suggestions: {} }
  assert.equal(parseMacFile(JSON.stringify(ok), id, judge).ok, true)
  assert.equal(parseMacFile(`<<<<<<< HEAD\n${JSON.stringify(ok)}\n=======\n{}\n>>>>>>> other\n`, id, judge).reason, 'git-conflict')
  assert.equal(parseMacFile(JSON.stringify({ ...ok, version: 2 }), id, judge).reason, 'newer')
  assert.equal(parseMacFile(JSON.stringify(ok), '1f8fad5b-d9cb-469f-a165-70867728950e', judge).reason, 'wrong-mac')
  assert.equal(parseMacFile('{"format":', id, judge).reason, 'unreadable')
  for (const writtenAt of [1e300, 1, -1, 1.5 + T0, Number.MAX_VALUE, '2026']) assert.equal(parseMacFile(JSON.stringify({ ...ok, writtenAt }), id, judge).reason, 'bad-time', String(writtenAt))
  // A file written by a Mac whose clock is ahead is read; its entries timed more than five minutes ahead are left out and counted.
  const ahead = parseMacFile(JSON.stringify({ ...ok, writtenAt: T0 + 3 * DAY, settings: { 'presenting.warnAt': { value: 7, at: T0 + CLOCK_MARGIN_MS + 1 }, 'presenting.urgentAt': { value: 3, at: T0 + CLOCK_MARGIN_MS } } }), id, judge)
  assert.equal(ahead.ok, true)
  assert.deepEqual(Object.keys(ahead.file.settings), ['presenting.urgentAt'], 'five minutes ahead is taken; a millisecond more is not')
  assert.deepEqual(ahead.rejected, { time: 1, value: 0, key: 0 })
  const bad = parseMacFile(JSON.stringify({ ...ok, settings: { x: { value: { nested: 1 }, at: T0 }, y: { value: 2, at: -1 }, 'presenting.urgentAt': { value: 3, at: T0 - 4 }, 'presenting.warnAt': { value: 9, at: 1e300 }, 'writing.plainTextSize': { value: 999, at: T0 }, 'recording.microphone': { value: 'Mic', at: T0 } } }), id, judge)
  assert.deepEqual(Object.keys(bad.file.settings), ['presenting.urgentAt'], 'a malformed, unknown, out-of-window or invalid entry is left out, not guessed at')
  assert.deepEqual(bad.rejected, { time: 1, value: 1, key: 3 })
})

await test('the settings command line sets and shows the folder (TalkWeaver settings set|get setup.folder); a relative path is refused', async () => {
  const dir = tmp('cli')
  const out = []
  const io = { stdout: (t) => out.push(t), stderr: (t) => out.push(t), env: {} }
  assert.equal(await runTalkWeaverSettings(['set', SETUP_FOLDER_SETTING, '/Users/someone/Dropbox'], { dir, version: '0.45.0', io }), 0)
  out.length = 0
  assert.equal(await runTalkWeaverSettings(['get', SETUP_FOLDER_SETTING], { dir, version: '0.45.0', io }), 0)
  assert.match(out.join(''), /\/Users\/someone\/Dropbox/)
  assert.notEqual(await runTalkWeaverSettings(['set', SETUP_FOLDER_SETTING, 'Dropbox'], { dir, version: '0.45.0', io }), 0)
})

// ── Two and three Macs ──────────────────────────────────────────────────────────────────────────

await test('two Macs: a preference and a shortcut changed on one arrive on the other, listed with where they came from', async () => {
  const folder = sharedFolder()
  const a = await makeMac('MacBook Air', { chosen: folder })
  const b = await makeMac('Mac mini', { chosen: folder })
  await a.set('presenting.warnAt', 9)
  await join2(a, b)
  assert.equal(b.value('presenting.warnAt'), 9)
  const cmd = 'research-panel'
  a.advance(); assert.ok((await a.store.rebind(cmd, '⌘⌥⇧9')).ok)
  await a.sync(); const s = await b.sync()
  assert.equal(b.chord(cmd), '⌘⌥⇧9')
  assert.equal(s.history[0].macName, 'MacBook Air')
  assert.ok(s.history[0].rows.some((r) => r.label.includes(cmd) && r.to === '⌘⌥⇧9'))
  const batchEntry = b.store.view().changes.find((e) => e.commandId === cmd)
  assert.equal(batchEntry.who.kind, 'import'); assert.equal(batchEntry.who.file, 'MacBook Air (set-up folder)')
  assertOnlyOwnWrites([a, b])
})

await test('the merge across Macs: newest per key; ties; a week offline; a key only one Mac knows; a key the schema dropped', async () => {
  const folder = sharedFolder()
  const a = await makeMac('A', { chosen: folder })
  const b = await makeMac('B', { chosen: folder })
  await join2(a, b)
  // Newest per key: A changes warnAt, B changes urgentAt afterwards; both keep both.
  await a.set('presenting.warnAt', 11); await b.set('presenting.urgentAt', 3)
  await a.sync(); await b.sync(); await a.sync()
  for (const m of [a, b]) assert.deepEqual([m.value('presenting.warnAt'), m.value('presenting.urgentAt')], [11, 3], m.name)
  // The same key on both, B later: B wins on both.
  await a.set('presenting.warnAt', 12); await b.set('presenting.warnAt', 13)
  await a.sync(); await b.sync(); await a.sync()
  for (const m of [a, b]) assert.equal(m.value('presenting.warnAt'), 13, m.name)
  // B is away for a week, changes nothing; A changes. B comes back: takes A's, gives nothing old back.
  b.advance(7 * DAY); a.advance(7 * DAY)
  await a.set('writing.plainTextSize', 20); await a.sync()
  await b.sync(); await a.sync()
  for (const m of [a, b]) assert.deepEqual([m.value('writing.plainTextSize'), m.value('presenting.warnAt')], [20, 13], m.name)
  // A key only one Mac knows, and a key this schema no longer has: in a file, never applied, nothing breaks.
  const path = join(resolveSetupFolder(folder, '/'), macFileName(a.engine.macId()))
  const file = JSON.parse(readFileSync(path, 'utf8'))
  file.settings['future.setting'] = { value: true, at: a.clock() + 1 }
  file.settings['recording.microphone'] = { value: 'Evil Mic', at: a.clock() + 1 } // a local-only key: never applied
  file.writeId = a.engine.macId() // irrelevant to B
  writeFileSync(path, JSON.stringify(file)) // the test plays a newer A here; A's own engine is not used again below
  const s = await b.sync()
  assert.equal(b.value('recording.microphone'), '')
  assert.ok(!s.notices.some((n) => n.kind === 'not-applied'), 'unknown and local-only keys are not even offered to the import')
  assert.ok(s.notices.some((n) => n.kind === 'rejected' && n.text.startsWith(macFileName(a.engine.macId())) && n.text.includes('2 entries not read')), 'and they are counted, by file name')
  // A tie: the same change time, a different value. This Mac keeps its own and says so.
  const fileB = JSON.parse(readFileSync(join(resolveSetupFolder(folder, '/'), macFileName(b.engine.macId())), 'utf8'))
  const tie = fileB.settings['presenting.warnAt']
  file.settings['presenting.warnAt'] = { value: 99, at: tie.at }
  writeFileSync(path, JSON.stringify(file))
  const st = await b.sync()
  assert.equal(b.value('presenting.warnAt'), tie.value)
  assert.ok(st.notices.some((n) => n.kind === 'tie' && n.text.includes('Clock turns amber') && n.text.includes(' A ')), 'the tie is told')
})

await test('three Macs: every Mac ends with the newest value of each key, whoever made it', async () => {
  const folder = sharedFolder()
  const [a, b, c] = [await makeMac('A', { chosen: folder }), await makeMac('B', { chosen: folder }), await makeMac('C', { chosen: folder })]
  await join2(a, b); let s = await c.sync(); if (s.state === 'joining') s = (await c.engine.applyJoin(s.preview.token)).status
  await a.set('presenting.warnAt', 21); await b.set('presenting.urgentAt', 4); await c.set('writing.plainTextSize', 18)
  await b.set('presenting.warnAt', 22)
  for (let i = 0; i < 2; i++) for (const m of [a, b, c]) await m.sync()
  for (const m of [a, b, c]) assert.deepEqual([m.value('presenting.warnAt'), m.value('presenting.urgentAt'), m.value('writing.plainTextSize')], [22, 4, 18], m.name)
  assertOnlyOwnWrites([a, b, c])
})

await test('nothing that stays on a Mac is ever in a file: generated from the schema, values planted on every Mac', async () => {
  const folder = sharedFolder()
  const a = await makeMac('A', { chosen: folder, vaults: [{ id: 'vault-1', name: 'Talks', travels: true }], personal: { 'vault-1': { author: 'Dominik' } } })
  const b = await makeMac('B', { chosen: folder })
  const markers = []
  for (const key of stayingSettingKeys(schema)) {
    const d = schema.def(key)
    if (d.type === 'secret' || key === SETUP_FOLDER_SETTING) continue
    let value
    if (d.type === 'path') value = `/Users/marker/${key.replace(/\W/g, '')}-PATHMARK`
    else if (d.type === 'choice') value = d.options.find((o) => o.value !== d.default)?.value
    else if (d.type === 'text') value = key === 'publishing.customDomain' ? 'https://custom-marker.example.com' : key === 'publishing.branch' ? 'markbranch' : `${key.replace(/\W/g, '')}MARK`
    if (value === undefined) continue
    for (const m of [a, b]) { const r = await m.store.set(key, value); assert.ok(r.ok, `${key}: ${r.error}`) }
    if (typeof value === 'string') markers.push(value)
  }
  await join2(a, b)
  await a.set('presenting.warnAt', 8); await a.sync(); await b.sync()
  const secretAndPathKeys = schema.settings.filter((d) => d.type === 'secret' || d.type === 'path' || LOCAL_ONLY_KEYS.includes(d.key)).map((d) => d.key)
  const written = [...filesIn(resolveSetupFolder(folder, '/')).map((n) => join(resolveSetupFolder(folder, '/'), n)), join(a.dir, STATE_FILE), join(b.dir, STATE_FILE)]
  assert.ok(written.length >= 4)
  for (const f of written) {
    const text = readFileSync(f, 'utf8')
    for (const key of secretAndPathKeys) assert.ok(!text.includes(`"${key}"`) && !text.includes(`s:${key}"`), `${basename(f)} holds ${key}`)
    for (const marker of markers) assert.ok(!text.includes(marker), `${basename(f)} holds ${marker}`)
    assert.ok(!text.includes(a.dir) && !text.includes(b.dir), `${basename(f)} holds a path`)
    // The set-up folder's files name no place at all; this Mac's own record (app data, never shared) names only the set-up folder it uses.
    if (basename(f) !== STATE_FILE) assert.ok(!text.includes(folder) && !/"\/(Users|home|Volumes|private)\//.test(text), `${basename(f)} holds a path`)
    else assert.deepEqual([...text.matchAll(/"(\/[^"]*)"/g)].map((m) => m[1]).filter((p) => p !== resolveSetupFolder(folder, '/')), [], `${basename(f)}: only the set-up folder`)
  }
  assert.equal(b.personal['vault-1'], undefined, 'B has no such vault: nothing applied, nothing invented')
})

await test('per-vault personal settings travel by the vault’s own id; a vault without a vault file stays and is named', async () => {
  const folder = sharedFolder()
  const a = await makeMac('A', { chosen: folder, vaults: [{ id: 'vault-1', name: 'Talks', travels: true }, { id: 'local-2', name: 'Scratch', travels: false }], personal: { 'vault-1': { author: 'Dominik', badgeColour: '#112233' }, 'local-2': { author: 'Only here' } } })
  const b = await makeMac('B', { chosen: folder, vaults: [{ id: 'vault-1', name: 'Talks (B path)', travels: true }] })
  const s = await join2(a, b)
  assert.deepEqual(b.personal['vault-1'], { author: 'Dominik', badgeColour: '#112233' })
  const sa = await a.sync()
  assert.ok(sa.notices.some((n) => n.kind === 'vault-unmatched' && n.text.includes('Scratch')))
  assert.ok(!readFileSync(join(resolveSetupFolder(folder, '/'), macFileName(a.engine.macId())), 'utf8').includes('Only here'))
  void s
})

await test('the same key given to two different commands on two Macs: neither Mac guesses; both keep theirs and say so', async () => {
  const folder = sharedFolder()
  const a = await makeMac('A', { chosen: folder }); const b = await makeMac('B', { chosen: folder })
  await join2(a, b)
  a.advance(); assert.ok((await a.store.rebind('research-panel', '⌘⌥⇧5')).ok)
  b.advance(); assert.ok((await b.store.rebind('research-find', '⌘⌥⇧5')).ok)
  const sa1 = await a.sync(); const sb = await b.sync(); const sa = await a.sync()
  void sa1
  assert.equal(a.chord('research-panel'), '⌘⌥⇧5'); assert.equal(b.chord('research-find'), '⌘⌥⇧5')
  assert.ok(sb.notices.some((n) => n.kind === 'not-applied' && n.text.includes('research-panel') && n.text.includes('from A')), 'told on B')
  assert.ok(sa.notices.some((n) => n.kind === 'not-applied' && n.text.includes('research-find') && n.text.includes('from B')), 'told on A')
})

// ── Safety ──────────────────────────────────────────────────────────────────────────────────────

await test('unreadable, conflicted, placeholder, not-downloaded and newer files are skipped and named; nothing is repaired', async () => {
  const folder = sharedFolder()
  const a = await makeMac('A', { chosen: folder })
  const b = await makeMac('B', { chosen: folder })
  await join2(a, b)
  const dir = resolveSetupFolder(folder, '/')
  const aFile = join(dir, macFileName(a.engine.macId()))
  const ghost = '9b2b6f0e-1c1c-4a4a-9b9b-0123456789ab'
  const plant = {
    [`mac-${a.engine.macId()} 2.json`]: readFileSync(aFile, 'utf8'),
    [`mac-${ghost}.json`]: '<<<<<<< HEAD\n{}\n=======\n{}\n>>>>>>> theirs\n',
    [`.mac-${ghost}.json.icloud`]: 'bplist',
    ['mac-1a2b3c4d-1c1c-4a4a-9b9b-0123456789ab.json']: JSON.stringify({ format: SETUP_FILE_FORMAT, version: 99, macId: '1a2b3c4d-1c1c-4a4a-9b9b-0123456789ab' }),
    ['mac-2a2b3c4d-1c1c-4a4a-9b9b-0123456789ab.json']: '{ not json'
  }
  for (const [n, t] of Object.entries(plant)) writeFileSync(join(dir, n), t)
  // A dataless file (blocks 0, as iCloud and Dropbox leave one not downloaded): made here as a sparse file.
  const sparse = join(dir, 'mac-3a2b3c4d-1c1c-4a4a-9b9b-0123456789ab.json')
  closeSync(openSync(sparse, 'w')); truncateSync(sparse, 4096)
  const before = Object.fromEntries(readdirSync(dir).map((n) => [n, readFileSync(join(dir, n))]))
  const s = await b.sync()
  const byFile = Object.fromEntries(s.skipped.map((k) => [k.file, k.reason]))
  assert.equal(byFile[`mac-${a.engine.macId()} 2.json`], 'copy')
  assert.equal(byFile[`mac-${ghost}.json`], 'git-conflict')
  assert.equal(byFile[`.mac-${ghost}.json.icloud`], 'placeholder')
  assert.equal(byFile['mac-1a2b3c4d-1c1c-4a4a-9b9b-0123456789ab.json'], 'newer')
  assert.equal(byFile['mac-2a2b3c4d-1c1c-4a4a-9b9b-0123456789ab.json'], 'unreadable')
  if (statSync(sparse).blocks === 0) assert.equal(byFile['mac-3a2b3c4d-1c1c-4a4a-9b9b-0123456789ab.json'], 'not-downloaded')
  for (const [n, bytes] of Object.entries(before)) if (n !== macFileName(b.engine.macId())) assert.deepEqual(readFileSync(join(dir, n)), bytes, `${n} changed`)
  // The read for `setup status` (another process) names the same files, and writes nothing.
  const look = await lookAtSetupFolder({ dir: b.dir, chosen: folder, home: '/', now: b.clock() })
  assert.equal(look.macs.length, 2); assert.ok(look.skipped.length >= 5); assert.equal(look.joined, true)
  assertOnlyOwnWrites([a, b])
})

await test('this Mac’s file write is atomic: a kill at each step leaves the old file or the new one, and the next start finishes', async () => {
  for (const step of ['writeNew', 'rename', 'syncDir']) {
    const folder = sharedFolder()
    let a = await makeMac('A', { chosen: folder })
    await a.sync()
    const dir = resolveSetupFolder(folder, '/')
    const path = join(dir, macFileName(a.engine.macId()))
    const old = readFileSync(path, 'utf8')
    await a.set('presenting.warnAt', 31)
    a.refuse = (op) => { if (op === step) throw Object.assign(new Error(`killed at ${step}`), { code: 'KILLED' }) }
    const s = await a.sync()
    const now = readFileSync(path, 'utf8')
    const parsed = JSON.parse(now)
    assert.ok(now === old || parsed.settings['presenting.warnAt']?.value === 31, `${step}: the file is the old one or the new one`)
    assert.ok(s.notices.some((n) => n.text.includes('could not be written')) || step === 'syncDir', step)
    a.refuse = null
    a = await a.restart()
    a.refuse = null
    await a.sync()
    assert.equal(readMacFile(dir, a).settings['presenting.warnAt'].value, 31, `${step}: written after the restart`)
    assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith('.tmp')), [], `${step}: no temporary file left`)
  }
})

await test('finding 2: a copied profile (Migration Assistant, a restored backup) on another Mac takes its own id before the original writes again; the original’s file is never touched', async () => {
  const folder = sharedFolder()
  const dir = resolveSetupFolder(folder, '/')
  const a = await makeMac('A', { chosen: folder })
  await a.set('presenting.warnAt', 40); await a.sync()
  const path = join(dir, macFileName(a.engine.macId()))
  const bytes = readFileSync(path)
  // The whole profile copied to another computer: the record, its id and its recent writes come along.
  const copyDir = tmp('copy')
  copyFileSync(join(a.dir, STATE_FILE), join(copyDir, STATE_FILE))
  const twin = await makeMac('A copy', { chosen: folder, dir: copyDir })
  assert.notEqual(twin.engine.macId(), a.engine.macId(), 'a new id on the other computer')
  await twin.set('presenting.warnAt', 42)
  const s = await twin.sync()
  assert.deepEqual(readFileSync(path), bytes, 'A’s file is untouched')
  assert.ok(existsSync(join(dir, macFileName(twin.engine.macId()))), 'the copy keeps its own file')
  assert.ok(s.notices.some((n) => n.kind === 'copied' && n.text.includes('copied from A')), 'told once')
  // The fingerprint (in the app a hash of the hardware id, which itself is kept nowhere) stays in app data; the shared file has only a mark derived from it and the Mac id.
  for (const m of [a, twin]) assert.ok(!readFileSync(join(dir, macFileName(m.engine.macId())), 'utf8').includes(m.machine), 'no fingerprint in the shared file')
  // A, the original, goes on as before and reads the copy's change like any other Mac's.
  await a.sync()
  assert.equal(a.value('presenting.warnAt'), 42)
  assertOnlyOwnWrites([a, twin])
  // The same profile copied again, this time from a record that had no fingerprint yet (an older version):
  // the mark in A's file tells the copy it is another computer, before it replaces anything.
  const legacyDir = tmp('legacy')
  const rec = JSON.parse(readFileSync(join(a.dir, STATE_FILE), 'utf8')); delete rec.fingerprint
  writeFileSync(join(legacyDir, STATE_FILE), JSON.stringify(rec))
  const legacy = await makeMac('A legacy copy', { chosen: folder, dir: legacyDir })
  assert.equal(legacy.engine.macId(), a.engine.macId(), 'not told by the record')
  const before = readFileSync(path)
  await legacy.set('presenting.warnAt', 43)
  const sl = await legacy.sync()
  assert.notEqual(legacy.engine.macId(), a.engine.macId())
  assert.deepEqual(readFileSync(path), before, 'A’s file is still untouched')
  assert.ok(sl.notices.some((n) => n.kind === 'copied'))
})

// ── Clocks ──────────────────────────────────────────────────────────────────────────────────────

await test('clocks: a change timed more than five minutes after this Mac’s clock is left out and reported; the message says which clock looks wrong when it can be told', async () => {
  // Two Macs, one a day ahead. The one with the right clock leaves the other's changes out, and cannot tell whose clock is wrong.
  const folder = sharedFolder()
  const right = await makeMac('Right', { chosen: folder })
  const wrong = await makeMac('Wrong', { chosen: folder, offset: DAY })
  await join2(right, wrong)
  await wrong.set('presenting.warnAt', 51); await wrong.sync()
  const s = await right.sync()
  assert.equal(right.value('presenting.warnAt'), 5, 'a change a day ahead is not taken')
  const clock = s.notices.filter((n) => n.kind === 'clock')
  assert.equal(clock.length, 1, JSON.stringify(s.notices))
  assert.ok(clock[0].text.startsWith('Wrong’s clock and this Mac’s do not agree') && clock[0].text.includes('about 1 day') && clock[0].text.includes('One of the two clocks is wrong'), clock[0].text)
  assert.ok(s.notices.some((n) => n.kind === 'rejected' && n.text.includes('more than five minutes ahead')), 'the entry left out is named')
  // A change made on the Mac with the right clock still reaches the other one (its times are behind that clock, not ahead).
  await right.set('presenting.urgentAt', 2); await right.sync(); await wrong.sync()
  assert.equal(wrong.value('presenting.urgentAt'), 2)
  // Within the margin: taken.
  const f1 = sharedFolder()
  const here = await makeMac('Here', { chosen: f1 }); const near = await makeMac('Near', { chosen: f1, offset: 4 * 60_000 })
  await join2(here, near)
  await near.set('presenting.warnAt', 8); await near.sync()
  const sh = await here.sync()
  assert.equal(here.value('presenting.warnAt'), 8, 'four minutes ahead is taken')
  assert.ok(!sh.notices.some((n) => n.kind === 'clock'))
  // Three Macs, one ahead of the other two: that Mac's clock is named.
  const f3 = sharedFolder()
  const r1 = await makeMac('First', { chosen: f3 }); const r2 = await makeMac('Second', { chosen: f3 }); const w = await makeMac('Fast', { chosen: f3, offset: DAY })
  await join2(r1, r2); let sw = await w.sync(); if (sw.state === 'joining') sw = (await w.engine.applyJoin(sw.preview.token)).status
  await r2.sync()
  const s1 = await r1.sync()
  const c1 = s1.notices.filter((n) => n.kind === 'clock')
  assert.equal(c1.length, 1, JSON.stringify(s1.notices))
  assert.ok(c1[0].text.startsWith('Fast’s clock looks ahead') && c1[0].text.includes('about 1 day'), c1[0].text)
  // This Mac behind every other: this Mac's clock is named.
  const slow = await makeMac('Slow', { chosen: f3, offset: -DAY })
  let ss = await slow.sync(); if (ss.state === 'joining') ss = (await slow.engine.applyJoin(ss.preview.token)).status
  ss = await slow.sync()
  const cs = ss.notices.filter((n) => n.kind === 'clock')
  assert.equal(cs.length, 1, JSON.stringify(ss.notices))
  assert.ok(cs[0].text.startsWith('This Mac’s clock looks behind'), cs[0].text)
})

// ── First join, undo ────────────────────────────────────────────────────────────────────────────

await test('first join shows what changes and changes nothing until Apply; Not now writes nothing either', async () => {
  const folder = sharedFolder()
  const a = await makeMac('MacBook Air', { chosen: folder, suggestions: { handoutAddress: 'https://handouts.example.com', shareLinkAddress: 'share.handouts.example.com' } })
  await a.set('publishing.cloudflareAccount', '0123456789abcdef0123456789abcdef'); await a.set('publishing.cloudflareSite', 'talks'); await a.set('presenting.warnAt', 3)
  a.advance(); await a.store.rebind('research-panel', '⌘⌥⇧8')
  await a.sync()
  const b = await makeMac('Mac mini', { chosen: folder })
  const before = JSON.stringify(b.store.view())
  const s = await b.sync()
  assert.equal(s.state, 'joining')
  assert.deepEqual(s.preview.fromMacs, ['MacBook Air'])
  const labels = s.preview.rows.map((r) => r.label)
  for (const want of ['Cloudflare account', 'Publishing site', 'Clock turns amber before the end', 'Shortcut: research-panel']) assert.ok(labels.includes(want), want)
  assert.equal(JSON.stringify(b.store.view()), before, 'nothing changed in the settings')
  assert.deepEqual(filesIn(resolveSetupFolder(folder, '/')), [macFileName(a.engine.macId())], 'nothing written to the folder')
  b.engine.notNow()
  await b.sync()
  assert.equal(JSON.stringify(b.store.view()), before)
  assert.deepEqual(filesIn(resolveSetupFolder(folder, '/')), [macFileName(a.engine.macId())])
  const applied = await b.engine.applyJoin((await b.sync()).preview.token)
  assert.ok(applied.ok)
  assert.equal(b.value('publishing.cloudflareSite'), 'talks'); assert.equal(b.chord('research-panel'), '⌘⌥⇧8')
  // Suggestions: shown, never applied by the read; Use on this Mac goes through the port.
  assert.deepEqual(applied.status.suggestions.map((x) => [x.kind, x.value, x.macName]), [['handoutAddress', 'https://handouts.example.com', 'MacBook Air'], ['shareLinkAddress', 'share.handouts.example.com', 'MacBook Air']])
  assert.deepEqual(b.used, [])
  const used = await b.engine.useSuggestion('shareLinkAddress')
  assert.ok(used.ok); assert.deepEqual(b.used, [['shareLinkAddress', 'share.handouts.example.com']])
  assert.deepEqual(used.status.suggestions.map((x) => x.kind), ['handoutAddress'])
})

await test('a preview that changed before Apply is shown again, not applied', async () => {
  const folder = sharedFolder()
  const a = await makeMac('A', { chosen: folder }); await a.set('presenting.warnAt', 3); await a.sync()
  const b = await makeMac('B', { chosen: folder })
  const s = await b.sync()
  await a.set('presenting.warnAt', 4); await a.sync()
  const r = await b.engine.applyJoin(s.preview.token)
  assert.equal(r.ok, false)
  assert.equal(b.value('presenting.warnAt'), 5)
  assert.ok(r.status.preview.rows.some((row) => row.to.startsWith('4')))
})

await test('undo restores exactly, and the earlier values travel back to the other Mac', async () => {
  const folder = sharedFolder()
  const a = await makeMac('A', { chosen: folder, vaults: [{ id: 'v', name: 'Talks', travels: true }] })
  const b = await makeMac('B', { chosen: folder, vaults: [{ id: 'v', name: 'Talks', travels: true }], personal: { v: { author: 'Before' } } })
  await b.set('presenting.urgentAt', 2)
  await join2(a, b)
  const stateBefore = JSON.stringify({ settings: b.store.view().settings, keys: b.store.view().keys, personal: b.personal })
  await a.set('presenting.urgentAt', 9); await a.set('writing.plainTextSize', 22); a.advance(); await a.store.rebind('research-panel', '⌘⌥⇧7')
  a.personal.v = { author: 'After' }
  await a.sync()
  const s = await b.sync()
  assert.equal(b.value('presenting.urgentAt'), 9); assert.equal(b.personal.v.author, 'After')
  const r = await b.engine.undo(s.history[0].id)
  assert.ok(r.ok, r.error)
  assert.equal(JSON.stringify({ settings: b.store.view().settings, keys: b.store.view().keys, personal: b.personal }), stateBefore, 'exactly as before')
  assert.equal(r.status.history[0].undone, true)
  await a.sync()
  assert.deepEqual([a.value('presenting.urgentAt'), a.value('writing.plainTextSize'), a.personal.v.author], [2, schema.def('writing.plainTextSize').default, 'Before'])
})

await test('leaving: the folder off stops reading and writing, the file stays; only this Mac’s own file can be removed', async () => {
  const folder = sharedFolder()
  const a = await makeMac('A', { chosen: folder }); const b = await makeMac('B', { chosen: folder })
  await join2(a, b)
  const dir = resolveSetupFolder(folder, '/')
  const r0 = await b.engine.removeOwnFile()
  assert.equal(r0.ok, false, 'not while the folder is in use')
  b.chosen = ''
  const callsBefore = b.rec.calls.length
  const off = await b.sync()
  assert.equal(off.state, 'off'); assert.equal(b.rec.calls.length, callsBefore, 'nothing read or written while off')
  assert.ok(existsSync(join(dir, macFileName(b.engine.macId()))))
  assert.equal(off.leftFile.file, macFileName(b.engine.macId()))
  const r = await b.engine.removeOwnFile()
  assert.ok(r.ok)
  assert.deepEqual(filesIn(dir), [macFileName(a.engine.macId())])
  assertOnlyOwnWrites([a, b])
})

// ── Review round 1 (Sol): the seven findings, each as it was reproduced ──────────────────────────

/** Every file the feature writes: the set-up folder's files, temporary ones included, and each Mac's own record. */
const writtenFiles = (folder, list) => [
  ...(existsSync(resolveSetupFolder(folder, '/')) ? readdirSync(resolveSetupFolder(folder, '/')).map((n) => join(resolveSetupFolder(folder, '/'), n)) : []),
  ...list.map((m) => join(m.dir, STATE_FILE))
]

/**
 * Hostile spellings of a value, each carrying `m` (lower-case letters and digits): every path spelling, addresses
 * written every way a parser forgives (protocol-relative, scheme without slashes, mixed case), user names and
 * passwords, token queries, percent-encoding, look-alike slashes and colons, direction and zero-width marks,
 * quotes and the characters plain text leaves out, and over-long text. The first four are the leaks reproduced
 * in round 2 (through talkDefaults.credits).
 */
const hostileSpellings = (m) => [
  `assets/${m}.png`, `Read\u2014/opt/${m}.txt`, `//example.com/a?token=${m}`, `https:example.com/a?token=${m}`,
  `/Users/someone/${m}`, `~/${m}`, `./${m}`, `../${m}`, `${m}/notes.txt`, `C:\\${m}`, `\\\\server\\${m}`, `C:/${m}`, `file:///${m}`, `file:${m}`, `Users/${m}`, `see ~/Documents/${m}`, `${m}\\x`,
  `https://example.com/a?token=${m}`, `https://someone:${m}@example.com/a`, `https://${m}@example.com/`, `someone:${m}@example.com`, `http://example.com/%2FUsers%2F${m}`, `https://example.com/${m}%3Ftoken`,
  `HTTPS://example.com/${m}`, `Https://example.com/${m}`, `https:/example.com/${m}`, `https://example.com\\${m}`, `https://example.com/${m}#frag`, `https://example.com/ ${m}`, ` https://example.com/${m}`,
  `javascript:${m}`, `ftp://example.com/${m}`, `data:text/plain,${m}`, `mailto:${m}@example.com`, `Slides at https://example.com/s?access_token=${m}`,
  `\u2215Users\u2215${m}`, `\uff0fUsers\uff0f${m}`, `C\ua789\\${m}`, `https\ufe55//example.com/${m}`, `https\uff1a//example.com/${m}`, `\u2044tmp\u2044${m}`, `\u29f8tmp\u29f8${m}`, `a\u0338${m}`, `x\u20e5${m}`,
  `${m}\u202eexe.png`, `\u2066${m}\u2069`, `${m}\u200b`, `${m}\u200dx`, `${m}\ufeff`, `${m}\u00a0x`, `${m}\nsecond line`, `${m}\tx`, `${m}\u0000`, `${m}\u2028x`,
  `"${m}"`, `\u201c${m}\u201d`, `<b>${m}</b>`, `token=${m}&x=1`, `#${m}`, `100%${m}`, `~${m}`, `${m}?`, `${m}:`, `${m};x`, `@${m}`, `${m}*`, `${m}|x`, `{${m}}`, `[${m}]`, `\`${m}\``,
  `${m}${'x'.repeat(MAX_PLAIN + 1)}`
]
// Values a person enters: they travel unchanged.
const ORDINARY_TEXT = ['Zoë O’Brien', 'José Álvarez-Núñez', 'D\'Arcy Smith', 'Smith and Jones', 'Dept. of Education (Oxford)', 'Łukasz Żółć', 'Thank you!', 'Ed Tech – Research', 'AI & Expertise series', 'C++ Club', 'Doğan Ünlü', '李小龍', 'Ελένη Παπαδοπούλου', 'محمد', 'हिन्दी नाम', 'Dominik Lukeš, University of Oxford', 'CC BY 4.0, except the photographs']
const ORDINARY = {
  'plain-text': ORDINARY_TEXT,
  address: ['https://example.com', 'https://example.com/licence', 'http://talks.example.org/a/b-c', 'https://creativecommons.org/licenses/by/4.0/'],
  'publishing.cloudflareAccount': ['0123456789abcdef0123456789abcdef'], 'publishing.cloudflareSite': ['my-talks'], 'publishing.branch': ['release-1.2', 'main'],
  'talkDefaults.section-colours': ['blue, light'], 'talkDefaults.triggers': ['reveal numbered'], 'writing.editorKeys': ['{"undo":"Mod-u"}'], 'talkDefaults.web': ['example.com', 'https://example.com/me']
}

await test('regression 1 and 2 (round 2): only text that cannot be unsafe travels; every travelling key has a kind, and none is free text', () => {
  const KINDS = ['plain-text', 'address', 'identifier', 'number', 'toggle', 'choice']
  const counts = {}
  for (const key of Object.keys(TRAVELLING)) {
    const t = TRAVELLING[key]
    assert.ok(t && KINDS.includes(t.kind), `${key} has no kind (one of ${KINDS.join(', ')})`)
    const type = schema.def(key).type
    if (['number', 'toggle', 'choice'].includes(type)) assert.equal(t.kind, type, `${key}: a ${type} by its schema`)
    else assert.ok(['plain-text', 'address', 'identifier'].includes(t.kind), `${key}: text is plain text, an address or an identifier`)
    counts[t.kind] = (counts[t.kind] ?? 0) + 1
  }
  for (const k of Object.keys(shared.VAULT_FIELD_KIND ?? {})) assert.ok(KINDS.includes(shared.VAULT_FIELD_KIND[k]), k)
  assert.deepEqual(Object.keys(shared.VAULT_FIELD_KIND ?? {}), ['author', 'badgeColour', 'badgeInitial'])
  assert.deepEqual(Object.keys(shared.SUGGESTION_KIND ?? {}), ['handoutAddress', 'shareLinkAddress'])
  // Credits and the call to action hold links and colons by design: they stay, with why.
  for (const k of ['talkDefaults.credits', 'talkDefaults.cta']) assert.ok(Object.hasOwn(STAYS_ON_THIS_MAC, k), `${k} stays on this Mac`)
  console.log(`      ${Object.keys(TRAVELLING).length} settings travel: ${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ')}`)
})

await test('regression 1 and 2 (round 2): for every travelling key of each kind, every hostile spelling is refused by its rule, and ordinary values pass unchanged', () => {
  let i = 0
  for (const key of Object.keys(TRAVELLING)) for (const v of hostileSpellings(`hx${i++}q`)) { const r = serialiseSetting(schema, key, v); assert.ok(!r.ok, `${key} would write ${JSON.stringify(v).slice(0, 80)}`) }
  for (const f of ['author', 'badgeColour', 'badgeInitial']) for (const v of hostileSpellings(`hv${i++}q`)) assert.equal(serialiseVaultField(f, v).ok, false, `vault ${f}: ${JSON.stringify(v)}`)
  for (const k of ['handoutAddress', 'shareLinkAddress']) for (const v of hostileSpellings(`hs${i++}q`)) assert.equal(serialiseSuggestion(k, v).ok, false, `${k}: ${JSON.stringify(v)}`)
  for (const v of hostileSpellings(`hn${i++}q`)) assert.equal(cleanMacName(v), 'A Mac', `Mac name: ${JSON.stringify(v)}`)
  for (const key of Object.keys(TRAVELLING)) {
    const kind = TRAVELLING[key].kind
    for (const v of ORDINARY[key] ?? ORDINARY[kind] ?? []) { const r = serialiseSetting(schema, key, v); assert.ok(r.ok && r.value === v, `${key} refuses ${v}: ${r.why}`) }
  }
  for (const v of ORDINARY_TEXT) { assert.equal(serialiseVaultField('author', v).value, v); assert.equal(cleanMacName(v), v) }
  assert.equal(serialiseSuggestion('handoutAddress', 'https://handouts.example.com').ok, true)
  assert.equal(serialiseSuggestion('shareLinkAddress', 'share.example.com').ok, true)
})

await test('regression 1 and 2 (round 2): through the app, no hostile spelling of any travelling value reaches any file the feature writes (asserted on the bytes); ordinary values travel; text that stays is named, unaltered and not overwritten', async () => {
  const folder = sharedFolder()
  const vaults = [{ id: 'v1', name: 'Talks', travels: true }]
  const a = await makeMac('A', { chosen: folder, vaults })
  const b = await makeMac('B', { chosen: folder, vaults })
  await join2(a, b)
  const keys = Object.keys(TRAVELLING)
  const spellings = hostileSpellings('x').length
  let planted = 0
  for (let round = 0; round < spellings; round++) {
    const markers = []
    for (let k = 0; k < keys.length; k++) {
      const marker = `hx${round}k${k}q`
      const value = hostileSpellings(marker)[round]
      a.advance()
      if ((await a.store.set(keys[k], value)).ok) { markers.push(marker); planted += 1 }
    }
    // The four reproduced leaks went through credits: it is planted too (it stays on this Mac now).
    const cm = `hc${round}q`
    if ((await a.store.set('talkDefaults.credits', hostileSpellings(cm)[round])).ok) markers.push(cm)
    const vm = `hv${round}q`; a.personal.v1 = { author: hostileSpellings(vm)[round] }; markers.push(vm)
    const sm = `hs${round}q`; a.suggestionValues.handoutAddress = hostileSpellings(sm)[round]; markers.push(sm)
    const nm = `hn${round}q`; a.name = hostileSpellings(nm)[round]; markers.push(nm)
    await a.sync(); await b.sync(); await a.sync()
    // The engines have finished all writes for this round. Check every marker against the same bytes.
    const files = writtenFiles(folder, [a, b]).map((path) => ({ name: basename(path), bytes: readFileSync(path) }))
    for (const m of markers) {
      const leaked = files.filter(({ bytes }) => bytes.includes(m, 'utf8')).map(({ name }) => name)
      assert.deepEqual(leaked, [], `${m} (${JSON.stringify(hostileSpellings(m)[round]).slice(0, 60)}) reached a file`)
    }
  }
  a.name = 'A'
  assert.ok(planted >= 200, `planted ${planted} values the store accepted`)
  for (const key of keys) assert.ok(!/hx\d+k\d+q/.test(String(b.value(key))), `B's ${key} came from a planted value`)
  // Ordinary values: each travelling text key, on A, arrives on B unchanged, and is in A's file byte for byte.
  const dir = resolveSetupFolder(folder, '/')
  for (const key of keys) {
    const kind = TRAVELLING[key].kind
    for (const v of ORDINARY[key] ?? ORDINARY[kind] ?? []) {
      a.advance(); const r = await a.store.set(key, v); assert.ok(r.ok, `${key}=${v}: ${r.error}`)
      await a.sync(); await b.sync()
      // Where publishing goes is offered on the other Mac (Use on this Mac), never applied by a read.
      if (ASK_FIRST.includes(key) && b.value(key) !== v) { const u = await b.engine.useSuggestion(key); assert.ok(u.ok, `${key}: ${u.error}`) }
      assert.equal(b.value(key), v, `${key}: ${v} travels`)
      assert.ok(readFileSync(join(dir, macFileName(a.engine.macId()))).includes(Buffer.from(JSON.stringify(v).slice(1, -1), 'utf8')), `${key}: ${v} is in A's file`)
    }
  }
  a.personal.v1 = { author: 'Zoë O’Brien' }; await a.sync(); await b.sync()
  assert.equal(b.personal.v1.author, 'Zoë O’Brien')
  // Text that stays: named on the page with why, left exactly as it is, and not overwritten by another Mac's newer value.
  const held = 'Thanks: see https://example.com/q?x=1'
  a.advance(); assert.ok((await a.store.set('talkDefaults.author', held)).ok)
  a.advance(); assert.ok((await a.store.set('talkDefaults.affiliation', 'Read/Write Lab')).ok)
  const sa = await a.sync()
  for (const label of ['Author', 'Affiliation']) {
    assert.ok(sa.notices.some((n) => n.kind === 'held' && n.text === `${label} stays on this Mac and is not changed from the folder: it contains characters that are not sent to the set-up folder.`), `${label} named: ${JSON.stringify(sa.notices.filter((n) => n.kind === 'held'))}`)
  }
  b.advance(); assert.ok((await b.store.set('talkDefaults.author', 'Someone Else')).ok)
  await b.sync(); await a.sync()
  assert.equal(a.value('talkDefaults.author'), held, 'not altered, not overwritten from the folder')
  assert.equal(a.value('talkDefaults.affiliation'), 'Read/Write Lab')
})

await test('finding 3: Apply applies the plan the preview showed; a value written between the preview and Apply is never applied unseen, and where publishing goes is then offered, not applied', async () => {
  const folder = sharedFolder()
  const a = await makeMac('A', { chosen: folder }); await a.set('presenting.warnAt', 3); await a.sync()
  const b = await makeMac('B', { chosen: folder })
  // Every read of A's file after the second has publishing.branch = "unreviewed" in it, newer than anything.
  let reads = 0
  b.transformRead = (path, text) => {
    if (typeof text !== 'string' || !path.endsWith(macFileName(a.engine.macId()))) return text
    reads += 1
    if (reads < 3) return text
    const f = JSON.parse(text); f.settings['publishing.branch'] = { value: 'unreviewed', at: b.clock() + 1000 }
    return JSON.stringify(f)
  }
  const s = await b.sync()
  assert.equal(s.state, 'joining')
  assert.ok(!s.preview.rows.some((r) => r.label === 'Production branch'))
  const r = await b.engine.applyJoin(s.preview.token)
  assert.ok(r.ok, r.error)
  assert.equal(b.value('presenting.warnAt'), 3, 'what the preview showed is applied')
  assert.equal(b.value('publishing.branch'), 'main', 'nothing the owner did not see')
  // Joined: the next read sees the new branch. It is offered (Use on this Mac), never applied by the read.
  const later = await b.sync()
  assert.equal(b.value('publishing.branch'), 'main')
  const offer = later.suggestions.find((x) => x.kind === 'publishing.branch')
  assert.ok(offer && offer.value === 'unreviewed' && offer.macName === 'A', JSON.stringify(later.suggestions))
  const used = await b.engine.useSuggestion('publishing.branch')
  assert.ok(used.ok, used.error)
  assert.equal(b.value('publishing.branch'), 'unreviewed')
  assert.ok(used.status.history[0].rows.some((row) => row.label === 'Production branch' && row.to === 'unreviewed'), 'listed with Undo')
  // A change of the folder between the preview and Apply: a fresh preview, never a silent difference.
  const c = await makeMac('C', { chosen: folder })
  const sc = await c.sync()
  await a.set('presenting.warnAt', 4); await a.sync()
  const rc = await c.engine.applyJoin(sc.preview.token)
  assert.equal(rc.ok, false)
  assert.ok(rc.status.preview.rows.some((row) => row.to.startsWith('4')))
  assert.equal(c.value('presenting.warnAt'), 5)
})

await test('finding 4: an invalid vault value from another Mac is refused and named; a valid one is kept, and Undo puts back exactly what was there', async () => {
  const folder = sharedFolder()
  const vaults = [{ id: 'v', name: 'Talks', travels: true }]
  const a = await makeMac('A', { chosen: folder, vaults })
  const b = await makeMac('B', { chosen: folder, vaults, personal: { v: { badgeColour: '#112233' } } })
  await join2(a, b)
  const dir = resolveSetupFolder(folder, '/')
  const path = join(dir, macFileName(a.engine.macId()))
  const f = JSON.parse(readFileSync(path, 'utf8'))
  f.vaults.v = { badgeColour: { value: 'not-a-colour', at: b.clock() + 1000 } }
  writeFileSync(path, JSON.stringify(f))
  const s = await b.sync()
  assert.equal(b.personal.v.badgeColour, '#112233', 'the valid colour is kept')
  assert.ok(s.notices.some((n) => n.kind === 'rejected' && n.text.startsWith(macFileName(a.engine.macId()))), 'named by file')
  assert.ok(!s.history.some((h) => h.rows.some((r) => r.label === 'Talks: Badge colour')), 'nothing applied, nothing listed')
  // A valid colour from A in mixed case: what travels is the cleaner's form; Undo compares exactly that.
  a.personal.v = { badgeColour: '#AABBCC' }
  await a.sync(); const s2 = await b.sync()
  assert.equal(b.personal.v.badgeColour, '#aabbcc')
  const u = await b.engine.undo(s2.history[0].id)
  assert.ok(u.ok, u.error)
  assert.equal(b.personal.v.badgeColour, '#112233', 'Undo put the earlier colour back')
})

await test('finding 5: change times are whole milliseconds between 2020 and five minutes ahead; 1e300 in an entry or a file is refused and named, and the cycle goes on', async () => {
  const folder = sharedFolder()
  const a = await makeMac('A', { chosen: folder }); const b = await makeMac('B', { chosen: folder })
  await join2(a, b)
  const dir = resolveSetupFolder(folder, '/')
  const path = join(dir, macFileName(a.engine.macId()))
  const f = JSON.parse(readFileSync(path, 'utf8'))
  f.settings['presenting.warnAt'] = { value: 9, at: 1e300 }
  f.settings['presenting.urgentAt'] = { value: 4, at: 0.5 + b.clock() }
  writeFileSync(path, JSON.stringify(f))
  const s = await b.sync()
  assert.deepEqual([b.value('presenting.warnAt'), b.value('presenting.urgentAt')], [5, 1], 'neither applied')
  assert.ok(s.notices.some((n) => n.kind === 'rejected' && n.text.includes('2 entries not read')))
  // A change here is still later than anything this Mac holds, and its time is a real one.
  await b.set('presenting.warnAt', 7); await b.sync()
  const at = readMacFile(dir, b).settings['presenting.warnAt'].at
  assert.ok(Number.isSafeInteger(at) && at <= b.clock() + CLOCK_MARGIN_MS && at > b.clock() - DAY, `a real time: ${at}`)
  // The file's own time impossible: the file is skipped and named; the cycle does not throw.
  writeFileSync(path, JSON.stringify({ ...f, writtenAt: 1e300 }))
  const s2 = await b.sync()
  assert.equal(s2.skipped.find((k) => k.file === macFileName(a.engine.macId()))?.reason, 'bad-time')
  assert.equal(s2.state, 'joined')
})

await test('finding 6: a kill around a vault change leaves a saved batch that the next start finishes (listed with Undo) or puts back, and says which', async () => {
  for (const stage of ['after-change', 'before-change']) {
    const folder = sharedFolder()
    const vaults = [{ id: 'v', name: 'Talks', travels: true }]
    const a = await makeMac('A', { chosen: folder, vaults })
    let b = await makeMac('B', { chosen: folder, vaults, personal: { v: { author: 'Before' } } })
    await join2(a, b)
    a.personal.v = { author: 'After' }
    if (stage === 'before-change') await a.set('presenting.warnAt', 17)
    await a.sync()
    // The kill: from that moment nothing more of this Mac's app data is written (its folder made read-only),
    // and, before the change, the change itself does not happen.
    const kill = () => chmodSync(b.dir, 0o500)
    if (stage === 'after-change') b.afterSetPersonal = kill
    else b.beforeSetPersonal = () => { kill(); throw new Error('killed') }
    try { await b.sync() } catch { /* a killed cycle may stop anywhere */ }
    chmodSync(b.dir, 0o700)
    b.afterSetPersonal = null; b.beforeSetPersonal = null
    b = await b.restart()
    const s = await b.sync()
    if (stage === 'after-change') {
      assert.equal(b.personal.v.author, 'After')
      assert.ok(s.notices.some((n) => n.kind === 'interrupted' && n.text.includes('kept')), 'says it was finished')
      const entry = s.history.find((h) => h.rows.some((r) => r.label === 'Talks: Author' && r.to === 'After'))
      assert.ok(entry && !entry.undone, 'the change is listed with Undo')
      const u = await b.engine.undo(entry.id)
      assert.ok(u.ok, u.error)
      assert.equal(b.personal.v.author, 'Before', 'and Undo puts it back')
    } else {
      assert.ok(s.notices.some((n) => n.kind === 'interrupted' && n.text.includes('put back')), 'says what landed was put back')
      // Read again in the same cycle: both changes made, one batch, listed with Undo.
      assert.deepEqual([b.personal.v.author, b.value('presenting.warnAt')], ['After', 17])
      const entry = s.history[0]
      assert.deepEqual(entry.rows.map((r) => r.label).sort(), ['Clock turns amber before the end', 'Talks: Author'])
      const u = await b.engine.undo(entry.id)
      assert.ok(u.ok, u.error)
      assert.deepEqual([b.personal.v.author, b.value('presenting.warnAt')], ['Before', 5])
    }
  }
})

await test('finding 7: clearing the folder during a read stops the cycle before any change; Stop waits for it, and nothing is reported joined', async () => {
  const folder = sharedFolder()
  const a = await makeMac('A', { chosen: folder }); const b = await makeMac('B', { chosen: folder })
  await join2(a, b)
  await a.set('presenting.warnAt', 33); await a.sync()
  const dir = resolveSetupFolder(folder, '/')
  // The owner clears the choice while B is reading A's file.
  b.transformRead = (path, text) => { if (path.endsWith(macFileName(a.engine.macId()))) b.chosen = ''; return text }
  const writesBefore = b.rec.calls.filter((c) => ['writeNew', 'rename', 'unlink'].includes(c.op)).length
  const bytes = readFileSync(join(dir, macFileName(b.engine.macId())))
  const s = await b.sync()
  assert.equal(s.state, 'off')
  assert.equal(b.value('presenting.warnAt'), 5, 'nothing applied')
  assert.equal(b.rec.calls.filter((c) => ['writeNew', 'rename', 'unlink'].includes(c.op)).length, writesBefore, 'nothing written to the folder')
  assert.deepEqual(readFileSync(join(dir, macFileName(b.engine.macId()))), bytes)
  // Stop while a read hangs: Stop resolves once the cycle has stopped, and that cycle changed nothing.
  b.chosen = folder
  const readStarted = Promise.withResolvers()
  const gate = Promise.withResolvers()
  b.transformRead = async (path, text) => {
    if (path.endsWith(macFileName(a.engine.macId()))) {
      readStarted.resolve()
      await gate.promise
    }
    return text
  }
  let done = false
  const running = b.engine.sync('demand').then((x) => { done = true; return x })
  await Promise.race([readStarted.promise, running.then(() => assert.fail('the cycle finished before the stalled read'))])
  b.chosen = ''
  const stopped = b.engine.folderChanged()
  gate.resolve()
  await stopped
  assert.equal(done, true, 'Stop waited for the cycle')
  assert.equal((await running).state, 'off')
  assert.equal(b.value('presenting.warnAt'), 5)
  // Another folder chosen during a read is the same: the old folder's values are not applied.
  b.transformRead = (path, text) => { if (path.endsWith(macFileName(a.engine.macId()))) b.chosen = sharedFolder(); return text }
  b.chosen = folder
  await b.sync()
  assert.equal(b.value('presenting.warnAt'), 5)
})

// ── Review round 2 (Sol): the reproduced scenarios ──────────────────────────────────────────────

await test('regression 3 (round 2): a profile copied to a Mac whose fingerprint cannot be read never takes over the original’s file; that Mac writes nothing and still takes changes', async () => {
  const folder = sharedFolder()
  const dir = resolveSetupFolder(folder, '/')
  const a = await makeMac('A', { chosen: folder })
  await a.set('presenting.warnAt', 44); await a.sync()
  const aPath = join(dir, macFileName(a.engine.macId()))
  // The record (its id and recent write ids) copied to B before A writes again; B cannot read its fingerprint.
  const bDir = tmp('nofp'); copyFileSync(join(a.dir, STATE_FILE), join(bDir, STATE_FILE))
  const b = await makeMac('B', { chosen: folder, dir: bDir, machine: null })
  const before = readFileSync(aPath)
  await b.set('presenting.warnAt', 45)
  const sb = await b.sync()
  assert.deepEqual(readFileSync(aPath), before, 'A’s file is untouched')
  assert.deepEqual(b.rec.calls.filter((c) => ['writeNew', 'rename', 'unlink', 'mkdir'].includes(c.op)).map((c) => `${c.op} ${basename(c.path)}`), [], 'B writes nothing to the folder')
  assert.ok(sb.notices.some((n) => n.kind === 'read-only' && n.text === 'This Mac cannot keep its own file in the set-up folder (it could not identify itself); it still takes changes from your other Macs.'), JSON.stringify(sb.notices))
  // B still takes A's changes, through the same plan.
  await a.set('presenting.urgentAt', 3); await a.sync()
  await b.sync()
  assert.equal(b.value('presenting.urgentAt'), 3)
  assert.equal(b.value('presenting.warnAt'), 45, 'its own later change is kept')
  assert.deepEqual(readFileSync(aPath).equals(before), false, 'A writes its own file as before')
  assert.equal(JSON.parse(readFileSync(aPath, 'utf8')).settings['presenting.warnAt'].value, 44, 'and nothing of B’s is in it')
  // Nor can B remove a file there.
  const r = await b.engine.removeOwnFile()
  assert.equal(r.ok, false)
  // A Mac with no fingerprint on its own: no file, no folder made; a fresh one on its own reads an empty folder.
  const f2 = sharedFolder()
  const p = await makeMac('P', { chosen: f2, machine: null })
  await p.set('presenting.warnAt', 9)
  const sp = await p.sync()
  assert.ok(!existsSync(resolveSetupFolder(f2, '/')), 'nothing made')
  assert.ok(sp.notices.some((n) => n.kind === 'read-only'))
})

await test('regression 4 (round 2): Stop during the destination read or the temporary-file sweep writes and removes nothing; Stop at every await of the cycle leaves the folder as it was', async () => {
  const setup = async () => {
    const folder = sharedFolder()
    const vaults = [{ id: 'v', name: 'Talks', travels: true }]
    const a = await makeMac('A', { chosen: folder, vaults }); const b = await makeMac('B', { chosen: folder, vaults, personal: { v: { author: 'Before' } } })
    await join2(a, b)
    const dir = resolveSetupFolder(folder, '/')
    // A leftover temporary file of B's (a write stopped after the temporary file, before the rename).
    await b.set('presenting.urgentAt', 2)
    b.refuse = (op) => { if (op === 'rename' || op === 'unlink') throw Object.assign(new Error('killed'), { code: 'KILLED' }) }
    await b.sync()
    b.refuse = null
    const temps = readdirSync(dir).filter((n) => n.startsWith(`.mac-${b.engine.macId()}`))
    assert.equal(temps.length, 1, 'a leftover temporary file')
    // A's change for B to take, and B's own change to write.
    await a.set('presenting.warnAt', 33); a.personal.v = { author: 'After' }; await a.sync()
    await b.set('writing.plainTextSize', 20)
    return { folder, dir, a, b, temp: join(dir, temps[0]), own: join(dir, macFileName(b.engine.macId())) }
  }
  const writes = (b, from) => b.rec.calls.slice(from).filter((c) => ['writeNew', 'rename', 'unlink', 'mkdir'].includes(c.op)).map((c) => `${c.op} ${basename(c.path)}`)
  // As reproduced: the folder cleared while the cycle reads its own file again before the replace.
  {
    const { b, own } = await setup()
    const bytes = readFileSync(own)
    let reads = 0
    let at = -1
    b.transformRead = (path, text) => { if (path === own && ++reads === 2) { b.chosen = ''; at = b.rec.calls.length } return text }
    const s = await b.sync()
    assert.ok(at >= 0, 'the cycle read its own file again before the replace')
    assert.equal(s.state, 'off')
    assert.deepEqual(readFileSync(own), bytes, 'the shared file is not replaced')
    assert.deepEqual(writes(b, at), [], 'nothing renamed or removed after the read')
  }
  // As reproduced: the folder cleared while the sweep reads its own temporary file.
  {
    const { b, temp } = await setup()
    b.transformRead = (path, text) => { if (path === temp) b.chosen = ''; return text }
    const from = b.rec.calls.length
    await b.sync()
    assert.ok(existsSync(temp), 'the temporary file is not removed after the folder was cleared')
    assert.deepEqual(writes(b, from), [])
  }
  // Every await between the read and the last write in the folder: Stop there, and nothing more is written or removed.
  for (const point of AWAIT_POINTS) {
    const { b, own } = await setup()
    let at = -1
    let bytes = null
    b.awaited = (p) => { if (p === point && at < 0) { at = b.rec.calls.length; bytes = existsSync(own) ? readFileSync(own) : null; b.chosen = ''; void b.engine.folderChanged() } }
    const s = await b.sync()
    b.awaited = null
    assert.ok(at >= 0, `the cycle passed ${point}`)
    assert.deepEqual(writes(b, at), [], `${point}: nothing written or removed in the folder after Stop`)
    assert.deepEqual(existsSync(own) ? readFileSync(own) : null, bytes, `${point}: the shared file as it was at Stop`)
    assert.equal(s.state, 'off', point)
  }
})

await test('regression 5 (round 2): Undo that cannot put a value back fails, names it, keeps the batch listed and undoable; a partial failure (two of three) does the same; a retry finishes it', async () => {
  const folder = sharedFolder()
  const vaults = [{ id: 'v', name: 'Talks', travels: true }]
  const a = await makeMac('A', { chosen: folder, vaults })
  const b = await makeMac('B', { chosen: folder, vaults, personal: { v: { author: 'Before' } } })
  await join2(a, b)
  // One value: the vault setter throws during Undo.
  a.personal.v = { author: 'After' }; await a.sync()
  const s = await b.sync()
  const id = s.history[0].id
  b.beforeSetPersonal = (_id, patch) => { if (patch.author === 'Before') throw new Error('the vault file is read-only') }
  const u = await b.engine.undo(id)
  assert.equal(u.ok, false, 'Undo fails')
  assert.ok(u.error.includes('Talks: Author'), u.error)
  assert.equal(b.personal.v.author, 'After')
  const listed = u.status.history.find((h) => h.id === id)
  assert.ok(listed && !listed.undone && listed.undoable, 'still listed, Undo still offered')
  assert.ok(u.status.notices.some((n) => n.kind === 'not-restored' && n.text.includes('Talks: Author')), 'the page says what could not be put back')
  b.beforeSetPersonal = null
  const again = await b.engine.undo(id)
  assert.ok(again.ok, again.error)
  assert.equal(b.personal.v.author, 'Before')
  assert.equal(again.status.history.find((h) => h.id === id).undone, true)
  // Three values, two put back: two settings and the vault author; only the author fails.
  await a.sync()
  await a.set('presenting.warnAt', 9); await a.set('presenting.urgentAt', 4); a.personal.v = { author: 'Third' }; await a.sync()
  const prev = { warnAt: b.value('presenting.warnAt'), urgentAt: b.value('presenting.urgentAt'), author: b.personal.v.author }
  const s3 = await b.sync()
  const batch = s3.history.find((h) => h.rows.length === 3)
  assert.ok(batch, JSON.stringify(s3.history.map((h) => h.rows.map((r) => r.label))))
  assert.deepEqual([b.value('presenting.warnAt'), b.value('presenting.urgentAt'), b.personal.v.author], [9, 4, 'Third'])
  b.beforeSetPersonal = (_id, patch) => { if (patch.author !== undefined) throw new Error('the vault file is read-only') }
  const u3 = await b.engine.undo(batch.id)
  assert.equal(u3.ok, false)
  assert.ok(u3.error.startsWith('Talks: Author could not be put back'), u3.error)
  assert.deepEqual([b.value('presenting.warnAt'), b.value('presenting.urgentAt'), b.personal.v.author], [prev.warnAt, prev.urgentAt, 'Third'], 'two of three put back')
  assert.equal(u3.status.history.find((h) => h.id === batch.id).undone, false)
  b.beforeSetPersonal = null
  const r3 = await b.engine.undo(batch.id)
  assert.ok(r3.ok, r3.error)
  assert.deepEqual([b.value('presenting.warnAt'), b.value('presenting.urgentAt'), b.personal.v.author], [prev.warnAt, prev.urgentAt, prev.author], 'the rest put back; the settings not undone twice')
  // The settings store refusing to undo: the settings are named, the batch stays.
  await a.sync(); await a.set('presenting.warnAt', 12); await a.sync()
  const s4 = await b.sync()
  b.undoBatchFails = true
  const u4 = await b.engine.undo(s4.history[0].id)
  b.undoBatchFails = false
  assert.equal(u4.ok, false)
  assert.ok(u4.error.includes('Clock turns amber'), u4.error)
  assert.equal(u4.status.history[0].undone, false)
})

await test('regression 5 (round 2): a batch stopped part-way whose putting back fails stays pending, listed with Undo; the page does not say it was put back; nothing more is taken until it is', async () => {
  const folder = sharedFolder()
  const vaults = [{ id: 'v', name: 'Talks', travels: true }]
  const a = await makeMac('A', { chosen: folder, vaults })
  let b = await makeMac('B', { chosen: folder, vaults, personal: { v: { author: 'Before', badgeColour: '#112233' } } })
  await join2(a, b)
  a.personal.v = { author: 'After', badgeColour: '#aabbcc' }; await a.sync()
  // Killed after the author changed, before the badge: nothing more of B's app data is written.
  b.beforeSetPersonal = (_id, patch) => { if (patch.badgeColour !== undefined) { chmodSync(b.dir, 0o500); throw new Error('killed') } }
  try { await b.sync() } catch { /* a killed cycle may stop anywhere */ }
  chmodSync(b.dir, 0o700)
  b.beforeSetPersonal = null
  b = await b.restart()
  assert.equal(b.personal.v.author, 'After', 'the author had changed')
  // On start the author cannot be put back.
  b.beforeSetPersonal = (_id, patch) => { if (patch.author === 'Before') throw new Error('the vault file is read-only') }
  await a.set('presenting.warnAt', 21); await a.sync()
  const s = await b.sync()
  assert.ok(!s.notices.some((n) => n.kind === 'interrupted' && n.text.includes('put back')), 'it does not say the changes were put back')
  assert.ok(s.notices.some((n) => n.kind === 'not-restored' && n.text.includes('Talks: Author')), JSON.stringify(s.notices))
  const pending = JSON.parse(readFileSync(join(b.dir, STATE_FILE), 'utf8')).pending
  assert.ok(pending && pending.items.some((i) => i.target === 'v:v:author'), 'still pending')
  assert.equal(b.value('presenting.warnAt'), 5, 'nothing more taken from the folder until it is put back')
  const row = s.history[0]
  assert.ok(row.unfinished && row.undoable && !row.undone, 'listed, with Undo')
  // Still failing on the next read: still pending.
  const s2 = await b.sync()
  assert.ok(s2.notices.some((n) => n.kind === 'not-restored'))
  // Undo tries again; once it is put back the folder is read again.
  b.beforeSetPersonal = null
  const u = await b.engine.undo(row.id)
  assert.ok(u.ok, u.error)
  assert.equal(JSON.parse(readFileSync(join(b.dir, STATE_FILE), 'utf8')).pending, null)
  assert.deepEqual([b.personal.v.author, b.personal.v.badgeColour, b.value('presenting.warnAt')], ['After', '#aabbcc', 21])
})

await test('availability: a stalled read is cut off by the read budget and later requests go on; a folder missing at start is tried again until it is back', async () => {
  const folder = sharedFolder()
  const a = await makeMac('A', { chosen: folder }); const b = await makeMac('B', { chosen: folder, readBudgetMs: 300 })
  await join2(a, b)
  await a.set('presenting.warnAt', 21); await a.sync()
  b.transformRead = (path, text) => (path.endsWith(macFileName(a.engine.macId())) ? new Promise(() => {}) : text)
  const t0 = Date.now()
  const s = await b.sync()
  assert.ok(Date.now() - t0 < 3000, 'the read gave up in time')
  assert.equal(s.skipped.find((k) => k.file === macFileName(a.engine.macId()))?.reason, 'not-read')
  assert.equal(b.value('presenting.warnAt'), 5)
  b.transformRead = null
  await b.sync()
  assert.equal(b.value('presenting.warnAt'), 21, 'the next request is not held up')
  // The host: unavailable at start, then back.
  let calls = 0
  const statusOf = (state) => ({ state, folder: '/x', chosen: '/x', problem: state === 'unavailable' ? 'gone' : null, thisMac: { name: 'M', file: 'f' }, macs: [], lastRead: null, skipped: [], preview: null, history: [], suggestions: [], notices: [], leftFile: null })
  const engine = { sync: async () => statusOf(++calls < 3 ? 'unavailable' : 'joined'), status: () => statusOf('off'), folderChanged: async () => {} }
  const host = startSetupFolderHost({ engine, changed: () => {}, watch: () => null, retryMs: 20 })
  await new Promise((r) => setTimeout(r, 250))
  host.dispose()
  assert.equal(calls, 3, 'tried again until it was back, then no more')
})

await test('reset all settings while joined: this Mac stops using the folder; the files in it are left as they are', async () => {
  const folder = sharedFolder()
  const a = await makeMac('A', { chosen: folder })
  const b = await makeMac('B', { chosenFromStore: true })
  assert.ok((await b.store.set(SETUP_FOLDER_SETTING, folder)).ok)
  await join2(a, b)
  const dir = resolveSetupFolder(folder, '/')
  const before = Object.fromEntries(readdirSync(dir).map((n) => [n, readFileSync(join(dir, n))]))
  assert.ok((await b.store.resetAll()).ok)
  const s = await b.sync()
  assert.equal(s.state, 'off')
  assert.equal(s.leftFile?.file, macFileName(b.engine.macId()), 'its file is offered for removal, not removed')
  for (const [n, bytes] of Object.entries(before)) assert.deepEqual(readFileSync(join(dir, n)), bytes, `${n} changed`)
})

// ── The property test ───────────────────────────────────────────────────────────────────────────

/** A small deterministic generator (mulberry32). */
function rng(seed) { let t = seed >>> 0; return () => { t += 0x6d2b79f5; let r = Math.imul(t ^ (t >>> 15), 1 | t); r ^= r + Math.imul(r ^ (r >>> 7), 61 | r); return ((r ^ (r >>> 14)) >>> 0) / 4294967296 } }
/** Values for a travelling key, from the allow-list itself: candidates of its type, kept when the key's own rule returns them unchanged. */
function candidatesOf(key) {
  const d = schema.def(key)
  let list
  if (d.type === 'toggle') list = [true, false]
  else if (d.type === 'choice') list = d.options.map((o) => o.value)
  else if (d.type === 'number') list = [d.min ?? 0, d.default, d.max ?? 100, Math.round(((d.min ?? 0) + (d.max ?? 100)) / 2)]
  else list = ['', d.default, 'alpha', 'beta-2', 'Gamma words', 'Zoë O’Brien', 'https://a.example/x', 'example.org', 'blue', 'blue, light', 'off', 'oxford', 'main', 'release-1.2', 'reveal numbered', '0123456789abcdef0123456789abcdef', 'fedcba9876543210fedcba9876543210', '{"undo":"Mod-u"}', '{}']
  const ok = [...new Set(list)].filter((v) => v !== null && v !== undefined).filter((v) => { const r = serialiseSetting(schema, key, v); return r.ok && Object.is(r.value, v) })
  assert.ok(ok.length >= 2, `the property test has fewer than two values for ${key}: add candidates of its kind`)
  return ok
}
// Every key the allow-list lets travel: a new key in TRAVELLING is in the property test without a change here.
const KEYS = Object.keys(TRAVELLING).map((k) => [k, candidatesOf(k)])
// Each command its own pool of keys: the same key on two commands is a different case (tested above: kept and told).
const SHORTCUTS = { 'research-panel': ['', '⌘⌥⇧1', '⌘⇧R'], 'research-find': ['', '⌘⌥⇧2', '⌘⌥R'] }
const accepted = (key, value) => { const r = serialiseSetting(schema, key, value); return r.ok && Object.is(r.value, value) }

/** A file another Mac might find: a real version, made hostile one way. Nothing of it may be applied. */
function hostile(text, pick, now) {
  const f = JSON.parse(text)
  const kind = pick(['time-far', 'time-huge', 'time-fraction', 'time-old', 'invalid-value', 'unknown-key', 'oversized', 'path-value', 'written-at', 'not-a-file'])
  const [key] = pick(KEYS.filter(([k]) => schema.def(k).type !== 'toggle'))
  const at = now + 1000
  switch (kind) {
    case 'time-far': f.settings[key] = { value: pick(KEYS.find(([k]) => k === key)[1]), at: now + CLOCK_MARGIN_MS + 60_000 }; break
    case 'time-huge': f.settings[key] = { value: pick(KEYS.find(([k]) => k === key)[1]), at: 1e300 }; break
    case 'time-fraction': f.settings[key] = { value: pick(KEYS.find(([k]) => k === key)[1]), at: at + 0.5 }; break
    case 'time-old': f.settings[key] = { value: pick(KEYS.find(([k]) => k === key)[1]), at: 5 }; break
    case 'invalid-value': f.settings[key] = { value: schema.def(key).type === 'number' ? 1e9 : '/Users/hostile/HOSTILEMARK', at }; break
    case 'unknown-key': f.settings['recording.microphone'] = { value: 'HOSTILEMARK Mic', at }; f.settings['future.thing'] = { value: true, at }; break
    case 'oversized': f.settings['talkDefaults.thanks'] = { value: `HOSTILEMARK${'x'.repeat(5000)}`, at }; f.shortcuts['research-panel'] = { value: 'x'.repeat(500), at }; break
    case 'path-value': f.settings['talkDefaults.affiliation'] = { value: '/Users/hostile/HOSTILEMARK.png', at }; f.settings['publishing.branch'] = { value: '/Users/HOSTILEMARK', at }; break
    case 'written-at': f.writtenAt = 1e300; f.settings[key] = { value: pick(KEYS.find(([k]) => k === key)[1]), at }; break
    default: return `{"format":"talkweaver-setup","version":1,"macId":"${f.macId}","settings":"HOSTILEMARK"}`
  }
  return JSON.stringify(f)
}

const LOCAL_ONLY_PROFILE = {
  A: { 'recording.microphone': 'Mic A', 'publishing.customDomain': 'https://a.example' },
  B: { 'recording.microphone': 'Mic B', 'publishing.customDomain': 'https://b.example' }
}

async function prepareProfiles() {
  const profiles = {}
  for (const [name, values] of Object.entries(LOCAL_ONLY_PROFILE)) {
    const store = openStore(tmp(`profile-${name}`), () => T0 + (name === 'B' ? 7 : 0))
    try {
      await store.ready
      for (const [key, value] of Object.entries(values)) assert.ok((await store.set(key, value)).ok, `${name}: seed ${key}`)
      profiles[name] = store.path
    } finally {
      await store.close()
    }
  }
  return profiles
}

async function property(seed, profiles) {
  const r = rng(seed)
  const pick = (list) => list[Math.floor(r() * list.length)]
  // Each Mac has its own copy of the folder. The "sync service" keeps every version each Mac ever wrote and
  // delivers any of them, late, out of order, more than once, as conflict copies, and sometimes made hostile.
  const fa = tmp('pa'); const fb = tmp('pb')
  const setup = async (name, chosen, offset) => {
    const dir = tmp(name)
    // Copy only the settings. The engine still creates a fresh identity and writes its own records.
    copyFileSync(profiles[name], join(dir, SETTINGS_FILE_NAME), fsConstants.COPYFILE_FICLONE)
    const mac = await makeMac(name, { dir, chosen, offset })
    for (const [key, value] of Object.entries(LOCAL_ONLY_PROFILE[name])) assert.equal(mac.value(key), value, `seed ${seed}: ${name} started with the wrong ${key}`)
    return mac
  }
  let A = await setup('A', fa, 0)
  let B = await setup('B', fb, 7) // a different millisecond phase: no exact-time ties between the two
  const versions = { A: [], B: [] }
  const ownFile = (m) => join(resolveSetupFolder(m.chosen, '/'), macFileName(m.engine.macId()))
  const keep = (m) => { const p = ownFile(m); if (!existsSync(p)) return; const t = readFileSync(p, 'utf8'); const q = versions[m.name]; if (q[q.length - 1]?.text !== t) q.push({ text: t, id: m.engine.macId() }) }
  const put = (to, name, text) => { const dst = resolveSetupFolder(to.chosen, '/'); mkdirSync(dst, { recursive: true }); const t = join(dst, `.incoming-${name}`); writeFileSync(t, text); renameSync(t, join(dst, name)) }
  const deliver = (from, to, how) => {
    const q = versions[from.name]
    if (!q.length) return
    const v = how === 'latest' ? q[q.length - 1] : pick(q)
    const name = macFileName(v.id)
    if (how === 'copy') put(to, name.replace('.json', ' 2.json'), v.text)
    else if (how === 'hostile') put(to, name, hostile(v.text, pick, to.clock()))
    else put(to, name, v.text)
  }
  const sync = async (m) => { const s0 = await m.engine.sync('demand'); const s = s0.state === 'joining' ? (await m.engine.applyJoin(s0.preview.token)).status : s0; keep(m); return s }
  const useOffers = async (m) => { for (const o of (await m.engine.sync('demand')).suggestions.filter((x) => ASK_FIRST.includes(x.kind))) { const u = await m.engine.useSuggestion(o.kind); assert.ok(u.ok, `seed ${seed}: use ${o.kind}: ${u.error}`) } keep(m) }
  /** No Mac ever holds a value the allow-list would not write, and nothing local-only ever changes. */
  const clean = (label) => {
    for (const m of [A, B]) {
      for (const [k] of KEYS) {
        const value = m.value(k)
        if (!accepted(k, value)) assert.fail(`seed ${seed} ${label}: ${m.name} holds ${k}=${String(value).slice(0, 60)}\n${trace.join('\n')}`)
      }
      for (const [key, value] of Object.entries(LOCAL_ONLY_PROFILE[m.name])) assert.equal(m.value(key), value, `seed ${seed} ${label}: ${key} changed on ${m.name}`)
    }
  }
  const trace = []
  const steps = 30 + Math.floor(r() * 30)
  for (let i = 0; i < steps; i++) {
    const [m, other] = r() < 0.5 ? [A, B] : [B, A]
    const op = r()
    m.advance(1000 + Math.floor(r() * 5000) * 2)
    if (op < 0.28) { const [k, values] = pick(KEYS); const v = pick(values); trace.push(`${m.name} set ${k}=${v}`); await m.store.set(k, v) }
    else if (op < 0.36) { const c = pick(Object.keys(SHORTCUTS)); const ch = pick(SHORTCUTS[c]); trace.push(`${m.name} key ${c}=${ch}`); await m.store.rebind(c, ch) }
    else if (op < 0.56) { trace.push(`${m.name} sync`); await sync(m) }
    else if (op < 0.70) { trace.push(`deliver some version ${m.name}→${other.name}`); deliver(m, other, 'any') }
    else if (op < 0.74) { trace.push(`conflict copy ${m.name}→${other.name}`); deliver(m, other, 'copy') }
    else if (op < 0.80) { trace.push(`hostile file ${m.name}→${other.name}`); deliver(m, other, 'hostile') }
    else if (op < 0.84) { trace.push(`${m.name} uses offers`); await useOffers(m) }
    else if (op < 0.93) { trace.push(`restart ${m.name}`); const again = await m.restart(); if (m === A) A = again; else B = again }
    else {
      const step = pick(['writeNew', 'rename'])
      trace.push(`kill ${m.name} at ${step}`)
      m.refuse = (o) => { if (o === step) throw new Error('killed') }
      await m.engine.sync('demand').catch(() => {})
      const again = await m.restart(); if (m === A) A = again; else B = again
    }
    clean(`step ${i}`)
  }
  // Settle: each Mac reads, uses what is offered, writes; the service delivers the latest of each.
  for (let round = 0; round < 4; round++) {
    for (const m of [A, B]) { m.advance(2000); await sync(m); await useOffers(m) }
    deliver(A, B, 'latest'); deliver(B, A, 'latest')
  }
  const sa = await sync(A); const sb = await sync(B)
  const tied = new Set([...sa.notices, ...sb.notices].filter((n) => n.kind === 'tie').map((n) => n.text))
  for (const [k] of KEYS) if (![...tied].some((t) => t.startsWith(schema.def(k).label))) assert.deepEqual(A.value(k), B.value(k), `seed ${seed}: ${k} differs\n${trace.join('\n')}`)
  for (const c of Object.keys(SHORTCUTS)) assert.equal(A.chord(c), B.chord(c), `seed ${seed}: shortcut ${c} differs\n${trace.join('\n')}`)
  clean('settled')
  // Quiescence: both Macs have read both latest files; more cycles change nothing (no imports, no file written, stable times).
  if (!tied.size) {
    const still = (m) => ({ file: readFileSync(ownFile(m), 'utf8'), own: JSON.parse(readFileSync(join(m.dir, STATE_FILE), 'utf8')).own, history: m.engine.status().history.length, changes: m.store.view().changes.length })
    deliver(A, B, 'latest'); deliver(B, A, 'latest')
    const before = { A: still(A), B: still(B) }
    for (let round = 0; round < 2; round++) {
      for (const m of [A, B]) { m.advance(2000); const s = await sync(m); assert.ok(!s.suggestions.some((x) => ASK_FIRST.includes(x.kind)), `seed ${seed}: an offer is still open on ${m.name}`) }
      deliver(A, B, 'latest'); deliver(B, A, 'latest')
    }
    for (const m of [A, B]) assert.deepEqual(still(m), before[m.name], `seed ${seed}: ${m.name} is not quiet\n${trace.join('\n')}`)
  }
  assertOnlyOwnWrites([A, B])
  for (const m of [A, B]) for (const f of [...readdirSync(resolveSetupFolder(m.chosen, '/')).filter((n) => classifyName(n).kind === 'mac' && classifyName(n).macId === m.engine.macId()).map((n) => join(resolveSetupFolder(m.chosen, '/'), n)), join(m.dir, STATE_FILE)]) {
    assert.ok(!readFileSync(f, 'utf8').includes('HOSTILEMARK'), `seed ${seed}: ${basename(f)} took something from a hostile file`)
  }
}

async function runSeeds(seeds, profiles) {
  for (const seed of seeds) {
    const firstMac = macs.length
    worldTick = 0
    try {
      await property(seed, profiles)
    } catch (error) {
      console.error(`  property test failed with seed ${seed} (SETUP_FOLDER_SEED=${seed} to run it alone)`)
      throw error
    } finally {
      await Promise.all(macs.splice(firstMac).map((mac) => mac.store.close()))
    }
  }
}

async function runPropertyCases(seeds) {
  if (seeds.length === 0) return
  const profiles = await prepareProfiles()
  // Each worker gets its own clock and fresh folders. Synchronous file writes on one cannot block the other seeds.
  const count = Math.min(4, availableParallelism(), seeds.length)
  if (count === 1) return runSeeds(seeds, profiles)
  const shards = Array.from({ length: count }, (_, shard) => seeds.filter((_, index) => index % count === shard))
  const results = await Promise.allSettled(shards.map((seeds) => new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: { seeds, profiles, scratch } })
    worker.once('error', reject)
    worker.once('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`Property worker exited with code ${code} (seeds: ${seeds.join(', ')})`))
    })
  })))
  const failure = results.find((result) => result.status === 'rejected')
  if (failure) throw failure.reason
}

if (isMainThread) {
  const only = process.env.SETUP_FOLDER_SEED
  const runs = only ? [Number(only)] : Array.from({ length: Number(process.env.SETUP_FOLDER_RUNS ?? 200) }, (_, i) => 1000 + i)
  await test(`property: every travelling key, random changes, syncs, every file version delivered out of order with duplicates, hostile files, restarts and kills on two Macs end in agreement and then stay quiet (${runs.length} runs)`, () => runPropertyCases(runs))
  for (const m of macs) { try { await m.store.close() } catch { /* closed */ } }
  if (failed.length) { console.log(`${passed} passed, ${failed.length} failed`); process.exit(1) }
  console.log(`${passed} passed`)
} else {
  await runSeeds(workerData.seeds, workerData.profiles)
}
