// Remove the example vault and bring it back (onboarding 0.38.1 ticket 12). Seams: the remover in
// src/main/example-vault-removal.ts over a temporary home (injected; never the real ~/Documents) with an
// injected trash that moves into a stand-in Bin inside this script's temp folder (never the real Bin),
// an injected list of open windows (removal never closes one), the vault registry as index.ts wires it (in-memory config.json, real vault
// files), and ticket 06's writer for restore. Each rule A to I in the module header has a case here.
// Then the e2e stand-in Bin's guard, the registry's remove, the wiring in main and preload, the palette
// command, and render checks of the confirmation (state 15), the ⋯ menu (17), the Guide's link (15, 17)
// and Settings → Get started after removal (16).
import assert from 'node:assert/strict'
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync,
  symlinkSync, writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { ExampleVault, nodeExampleVaultFs } from '../src/main/example-vault.ts'
import {
  ExampleVaultRemoval, EXAMPLE_CONFIRMATION_MS, EXAMPLE_COUNT_LIMIT, EXAMPLE_DISPLAY_PATH, EXAMPLE_REMOVAL_MESSAGES,
  closeExampleTalksFirst, windowsOnExample
} from '../src/main/example-vault-removal.ts'
import { resolveExampleTrash, harnessBinInsideTemp } from '../src/main/example-trash-harness.ts'
import { createVaultRegistry } from '../src/main/vault-registry.ts'
import { createVaultFileStore } from '../src/main/vault-file.ts'
import { EXAMPLE_REMOVAL_TEXT, binDetail } from '../src/shared/example-vault-removal.ts'
import { COMMAND_REGISTRY, paletteCommands } from '../src/shared/command-registry.ts'
import { TEXT } from '../docs/design/2026-10-09-onboarding-and-command-help/mockup-onboarding-talkweaver-text.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE = join(REPO, 'resources', 'example-vault')
const base = realpathSync(mkdtempSync(join(tmpdir(), 'tw-example-removal-')))
const read = (rel) => readFileSync(join(REPO, rel), 'utf8')
let passed = 0
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`PASS  ${name}`) } catch (error) { console.error(`FAIL  ${name}`); throw error }
}
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()

let n = 0
const PROGRESS = {
  guideProgress: { exampleTalkOpened: true },
  guideLearn: { version: 1, ran: ['promote-heading', 'demote-heading'], opened: ['Write the outline'], finished: { 'See the talk': '2026-10-06' }, read: ['how:vaults'] },
  guideButtonVisible: true,
}

/**
 * A fresh home with Documents and a file of the person's own, a stand-in Bin, the registry over an
 * in-memory config (holding progress), the writer, and the remover. `open` writes the example first.
 */
async function harness({ open = true, trash, fs, ownVault = false } = {}) {
  const dir = join(base, `case-${++n}`)
  const home = join(dir, 'home')
  const bin = join(dir, 'Bin')
  mkdirSync(join(home, 'Documents'), { recursive: true })
  mkdirSync(bin)
  writeFileSync(join(home, 'Documents', 'Letter.txt'), 'mine')
  let config = structuredClone(PROGRESS)
  if (ownVault) {
    const own = join(home, 'Documents', 'Talks')
    mkdirSync(join(own, 'alpha'), { recursive: true })
    writeFileSync(join(own, 'alpha', 'alpha-outline.md'), '---\ntitle: Alpha\n---\n')
  }
  let ids = 0
  const registry = createVaultRegistry({
    read: () => structuredClone(config),
    write: (patch) => { config = { ...config, ...structuredClone(patch) } },
    realpath: (p) => realpathSync(p),
    files: createVaultFileStore(),
    newId: () => `reg-${++ids}`
  })
  if (ownVault) registry.add(join(realpathSync(home), 'Documents', 'Talks'))
  const writer = new ExampleVault({ home: () => home, bundleDir: BUNDLE, registry, newId: () => 'example-id-1', now: () => new Date('2026-10-09T12:00:00.000Z') })
  const calls = { trash: [], windows: [], order: [] }
  // The windows showing an example talk, as main's port names them; a test opens and closes them.
  const shown = []
  let clock = 1_000_000
  const logs = []
  const removal = new ExampleVaultRemoval({
    home: () => home,
    registry,
    record: {
      removed: () => config.exampleVaultRemoved === true,
      setRemoved: (removed) => { config = { ...config, exampleVaultRemoved: removed }; return true },
    },
    writer,
    trash: async (path) => {
      calls.trash.push(path); calls.order.push('trash')
      if (trash) return trash(path, bin)
      renameSync(path, join(bin, 'Example vault'))
    },
    openWindows: (root) => {
      calls.windows.push(root); calls.order.push('windows')
      return [...shown]
    },
    fs,
    now: () => clock,
    log: (event, details) => logs.push({ event, details }),
  })
  if (open) {
    const result = await writer.open()
    assert.equal(result.ok, true, JSON.stringify(result))
  }
  const root = join(realpathSync(home), 'Documents', 'TalkWeaver', 'Example vault')
  return {
    home, root, bin, registry, writer, removal, calls, logs, shown,
    config: () => config,
    advance: (ms) => { clock += ms },
    example: () => registry.list().find((v) => v.example === true) ?? null,
  }
}

/** Every path under dir (relative) with type, size and mtime. */
function listing(dir) {
  const out = new Map()
  const walk = (d, rel) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      const r = rel ? `${rel}/${name}` : name
      const st = lstatSync(p)
      out.set(r, `${st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : 'file'}:${st.isFile() ? st.size : ''}:${st.mtimeMs}`)
      if (st.isDirectory() && !st.isSymbolicLink()) walk(p, r)
    }
  }
  walk(dir, '')
  return out
}
const outsideExample = (m) => new Map([...m].filter(([k]) => !k.startsWith('Documents/TalkWeaver/Example vault')))
const progressOf = (config) => JSON.stringify({ guideProgress: config.guideProgress, guideLearn: config.guideLearn, guideButtonVisible: config.guideButtonVisible })
const bundleFiles = () => {
  const out = []
  const walk = (d, rel) => {
    for (const name of readdirSync(d).sort()) {
      if (name === '.DS_Store') continue
      const p = join(d, name)
      const r = rel ? `${rel}/${name}` : name
      if (statSync(p).isDirectory()) walk(p, r)
      else out.push(r)
    }
  }
  walk(BUNDLE, '')
  return out
}

const renderDir = mkdtempSync(join(REPO, '.test-example-removal-'))
try {
  // ── strings ──
  await test('the fixed strings are the drawing’s (states 15, 16, 16b, 17)', () => {
    const c = EXAMPLE_REMOVAL_TEXT.confirm
    assert.equal(c.title, TEXT.confirm.title)
    assert.equal(c.lead, TEXT.confirm.lead)
    assert.equal(c.binBar, TEXT.confirm.binBar)
    assert.equal(c.offBar, TEXT.confirm.offBar)
    // Review round 1: removal closes no window, so the drawn second line (“…closes first; its changes
    // are saved before the move”) is replaced; the departure is recorded in the ticket.
    assert.equal(c.off[0], TEXT.confirm.off[0])
    assert.equal(c.off.length, TEXT.confirm.off.length)
    assert.notEqual(c.off[1], TEXT.confirm.off[1])
    assert.ok(!/closes|saved/.test(c.off[1]), 'the sheet promises no closing and no saving')
    assert.equal(c.keptBar, TEXT.confirm.keptBar)
    assert.deepEqual([...c.kept], TEXT.confirm.kept)
    assert.equal(c.cancel, TEXT.confirm.cancel)
    assert.equal(c.ok, TEXT.confirm.ok)
    assert.equal(EXAMPLE_REMOVAL_TEXT.removedFlash, TEXT.removedFlash)
    assert.equal(EXAMPLE_REMOVAL_TEXT.menuRemove, TEXT.menuRemove)
    assert.equal(EXAMPLE_REMOVAL_TEXT.guideRemove, TEXT.removeExample)
    assert.equal(EXAMPLE_REMOVAL_TEXT.settingsNote, TEXT.settings.note)
    assert.equal(EXAMPLE_REMOVAL_TEXT.settingsShow, TEXT.settings.b1)
    assert.equal(EXAMPLE_REMOVAL_TEXT.paletteShow, TEXT.palette.rows[0][0])
    // The drawn line, built from the real count.
    assert.deepEqual([EXAMPLE_DISPLAY_PATH, binDetail(5)], TEXT.confirm.bin[0])
    assert.equal(binDetail(1), '1 talk, with any change you made to them')
  })

  // ── success, rules A to E, H ──
  await test('success: preview shows the real folder and 5 talks; remove asks for open windows (none), then moves exactly the fixed path to the Bin; the list loses the example; progress, settings and every other file are untouched', async () => {
    const h = await harness({ ownVault: true })
    const before = listing(h.home)
    const progressBefore = progressOf(h.config())
    const preview = await h.removal.preview(7)
    assert.equal(preview.ok, true, JSON.stringify(preview))
    assert.equal(preview.folder, '~/Documents/TalkWeaver/Example vault')
    assert.equal(preview.talks, 5)
    assert.match(preview.token, /^[0-9a-f]{64}$/)
    assert.equal(h.calls.trash.length, 0, 'the preview reads only')
    const result = await h.removal.remove(preview.token, 7)
    assert.deepEqual(result, { ok: true, outcome: 'moved-to-bin' })
    assert.deepEqual(h.calls.order, ['windows', 'windows', 'trash'], 'asked at preview, and again last before the trash')
    assert.deepEqual(h.calls.windows, [h.root, h.root])
    assert.deepEqual(h.calls.trash, [h.root], 'one call, the fixed path')
    assert.ok(!existsSync(h.root), 'gone from Documents')
    assert.ok(existsSync(join(h.bin, 'Example vault', 'the-saturday-market', 'the-saturday-market-outline.md')), 'in the stand-in Bin, whole')
    assert.equal(h.example(), null, 'the example left the list')
    assert.equal(h.registry.list().length, 1, 'the person’s own vault stays')
    assert.equal(h.config().exampleVaultRemoved, true)
    assert.equal(h.removal.wasRemoved(), true)
    assert.equal(progressOf(h.config()), progressBefore, 'progress is untouched')
    const after = listing(h.home)
    const changed = [...outsideExample(before)].filter(([k, v]) => after.get(k) !== v && k !== 'Documents/TalkWeaver').map(([k]) => k)
    assert.deepEqual(changed, [], 'no other file changes (TalkWeaver itself loses one entry)')
    assert.ok(existsSync(join(h.home, 'Documents', 'TalkWeaver')), 'the TalkWeaver folder stays')
    assert.ok(h.logs.every((l) => !JSON.stringify(l).includes(h.home)), 'the log holds no paths')
  })

  // ── rule H: the token ──
  await test('token: a wrong window, a reused token, an expired one, a malformed one, and one replaced by a newer preview all change nothing', async () => {
    const h = await harness()
    let p = await h.removal.preview(7)
    assert.deepEqual(await h.removal.remove(p.token, 8), { ok: false, message: EXAMPLE_REMOVAL_MESSAGES.lookAgain }, 'wrong sender')
    assert.deepEqual(await h.removal.remove(p.token, 7), { ok: false, message: EXAMPLE_REMOVAL_MESSAGES.lookAgain }, 'used up by the wrong-sender call')
    p = await h.removal.preview(7)
    h.advance(EXAMPLE_CONFIRMATION_MS)
    assert.equal((await h.removal.remove(p.token, 7)).ok, false, 'five minutes old')
    p = await h.removal.preview(7)
    for (const bad of [undefined, null, 42, '', p.token.toUpperCase(), '../../x', { token: p.token }]) {
      assert.equal((await h.removal.remove(bad, 7)).ok, false, String(bad))
    }
    const old = await h.removal.preview(7)
    const fresh = await h.removal.preview(7)
    assert.equal((await h.removal.remove(old.token, 7)).ok, false, 'a newer preview replaces the token')
    assert.equal((await h.removal.remove(fresh.token, 7)).ok, false, 'and the failed call used the newer one up')
    const ok = await h.removal.preview(7)
    h.advance(EXAMPLE_CONFIRMATION_MS - 1)
    assert.equal((await h.removal.remove(ok.token, 7)).ok, true, 'just under five minutes is still live')
    assert.equal(h.calls.trash.length, 1)
  })

  await test('token: two removals with one token reach the trash once (one at a time, used up at the call)', async () => {
    const h = await harness()
    const p = await h.removal.preview(7)
    const [a, b] = await Promise.all([h.removal.remove(p.token, 7), h.removal.remove(p.token, 7)])
    assert.deepEqual([a.ok, b.ok], [true, false])
    assert.equal(h.calls.trash.length, 1)
  })

  await test('count changed between preview and remove: a file added, a talk added, or the folder swapped for a copy: nothing binned', async () => {
    const h = await harness()
    let p = await h.removal.preview(7)
    writeFileSync(join(h.root, 'garden-notes', 'extra.txt'), 'x')
    assert.deepEqual(await h.removal.remove(p.token, 7), { ok: false, message: EXAMPLE_REMOVAL_MESSAGES.lookAgain })
    p = await h.removal.preview(7)
    rmSync(join(h.root, 'garden-notes', 'extra.txt'))
    assert.equal((await h.removal.remove(p.token, 7)).ok, false, 'a file removed')
    // The same count in a different folder (renamed away, a copy put in its place): device and inode differ.
    p = await h.removal.preview(7)
    const aside = join(dirname(h.root), 'aside')
    renameSync(h.root, aside)
    mkdirSync(h.root)
    for (const name of readdirSync(aside)) renameSync(join(aside, name), join(h.root, name))
    assert.deepEqual(await h.removal.remove(p.token, 7), { ok: false, message: EXAMPLE_REMOVAL_MESSAGES.lookAgain })
    assert.equal(h.calls.trash.length, 0)
    assert.ok(h.example(), 'still listed')
  })

  // ── rule I: open windows; removal never closes one ──
  await test('an example window open: the preview is refused with one sentence naming it, no token; nothing binned', async () => {
    const h = await harness()
    h.shown.push('The Saturday market')
    const p = await h.removal.preview(7)
    assert.deepEqual(p, { ok: false, message: 'Close the example talks first: The Saturday market.' })
    assert.equal('token' in p, false, 'no token while a window is open')
    assert.equal((await h.removal.remove('a'.repeat(64), 7)).ok, false)
    assert.equal(h.calls.trash.length, 0)
    assert.ok(existsSync(h.root) && h.example(), 'folder and list unchanged')
    assert.equal(h.config().exampleVaultRemoved, undefined)
    h.shown.push('Lightning round', 'Garden notes', 'Walking the old town', 'Harvest supper (draft)')
    assert.equal((await h.removal.preview(7)).message, 'Close the example talks first: The Saturday market, Lightning round, Garden notes and 2 more.')
    assert.equal(closeExampleTalksFirst(['A', 'B']), 'Close the example talks first: A, B.')
    assert.equal(closeExampleTalksFirst(['A', 'B', 'C', 'D']), 'Close the example talks first: A, B, C and 1 more.')
  })

  await test('a window opened between preview and remove: remove aborts with the sentence, nothing binned, the token is used up', async () => {
    const h = await harness()
    const before = listing(h.home)
    const progress = progressOf(h.config())
    const p = await h.removal.preview(7)
    assert.equal(p.ok, true)
    h.shown.push('Lightning round')
    assert.deepEqual(await h.removal.remove(p.token, 7), { ok: false, message: 'Close the example talks first: Lightning round.' })
    assert.equal(h.calls.trash.length, 0)
    assert.deepEqual(listing(h.home), before, 'nothing on disk changes')
    assert.ok(h.example(), 'still listed')
    assert.equal(h.config().exampleVaultRemoved, undefined)
    assert.equal(progressOf(h.config()), progress)
    h.shown.length = 0
    assert.deepEqual(await h.removal.remove(p.token, 7), { ok: false, message: EXAMPLE_REMOVAL_MESSAGES.lookAgain }, 'the token was used up by the aborted call')
    assert.equal(h.calls.trash.length, 0)
  })

  await test('a window opened while remove runs its folder checks: refused; the window question is the last thing before the trash', async () => {
    let onRead = null
    const fs = { ...nodeExampleVaultFs, opendir: async (path) => { onRead?.(path); return nodeExampleVaultFs.opendir(path) } }
    const h = await harness({ fs })
    const p = await h.removal.preview(7)
    onRead = () => { if (h.shown.length === 0) h.shown.push('Garden notes') }
    assert.deepEqual(await h.removal.remove(p.token, 7), { ok: false, message: 'Close the example talks first: Garden notes.' })
    assert.equal(h.calls.trash.length, 0)
  })

  await test('every example window closed: the refused preview becomes a confirmation, and Remove moves it to the Bin', async () => {
    const h = await harness()
    h.shown.push('The Saturday market')
    assert.equal((await h.removal.preview(7)).ok, false)
    h.shown.length = 0
    const p = await h.removal.preview(7)
    assert.equal(p.ok, true)
    assert.deepEqual(await h.removal.remove(p.token, 7), { ok: true, outcome: 'moved-to-bin' })
    assert.deepEqual(h.calls.trash, [h.root])
  })

  await test('the window port failing (it throws, or answers with no list): refused, nothing binned', async () => {
    for (const bad of [() => { throw new Error('boom') }, () => undefined]) {
      const h = await harness()
      const removal = new ExampleVaultRemoval({ home: () => h.home, registry: h.registry, record: { removed: () => false, setRemoved: () => true }, writer: h.writer, trash: async () => { throw new Error('never') }, openWindows: bad })
      assert.deepEqual(await removal.preview(7), { ok: false, message: EXAMPLE_REMOVAL_MESSAGES.windowsUnknown })
    }
  })

  await test('which windows count (main’s bookkeeping): editor, deck and Pathways by their talk; Tools always; a window opened from a deck unless its page is a file outside the example and the temp folder', () => {
    const root = '/h/Documents/TalkWeaver/Example vault'
    const inExample = (p) => p === root || p.startsWith(root + '/')
    const filePathOf = (url) => (url.startsWith('file:') ? fileURLToPath(url) : null)
    const ex = (slug) => `${root}/${slug}/${slug}-outline.md`
    const names = windowsOnExample([
      { kind: 'editor', outlinePath: ex('the-saturday-market'), title: 'The Saturday market' },
      { kind: 'editor', outlinePath: '/h/Talks/alpha/alpha-outline.md', title: 'Alpha' },
      { kind: 'editor', outlinePath: null, title: '' },
      { kind: 'deck', outlinePath: ex('the-saturday-market'), title: 'The Saturday market' },
      { kind: 'deck', outlinePath: ex('lightning-round'), title: 'Lightning round' },
      { kind: 'deck', outlinePath: '/h/Talks/alpha/alpha-outline.md', title: 'Alpha' },
      { kind: 'pathways', outlinePath: ex('garden-notes'), title: 'Garden notes' },
      { kind: 'other', url: `${pathToFileURL(`${root}/garden-notes/garden-notes-present.html`).href}?audience=1`, title: 'TalkWeaver Audience — Garden notes' },
      { kind: 'other', url: 'file:///h/Talks/alpha/alpha-present.html', title: 'TalkWeaver Audience — Alpha' },
      { kind: 'other', url: 'file:///tmp/x/walking-present.html', title: 'TalkWeaver Presenter — Walking' },
      { kind: 'other', url: 'about:blank', title: '' },
    ], inExample, '/tmp/x', filePathOf)
    assert.deepEqual(names, ['The Saturday market', 'Lightning round', 'Garden notes', 'TalkWeaver Audience — Garden notes', 'TalkWeaver Presenter — Walking', 'A presentation window'])
    assert.deepEqual(windowsOnExample([{ kind: 'tools', title: 'TalkWeaver Tools' }], inExample, '/tmp/x', filePathOf), ['TalkWeaver Tools'])
    assert.deepEqual(windowsOnExample([{ kind: 'pathways', outlinePath: '/h/Talks/alpha/alpha-outline.md', title: 'Alpha' }], inExample, '/tmp/x', filePathOf), [])
    assert.deepEqual(windowsOnExample([{ kind: 'editor', outlinePath: ex('x'), title: 'X' }], () => { throw new Error('no') }, '/tmp/x', filePathOf), ['X'], 'a window that cannot be placed counts')
  })

  // ── rule E: the trash ──
  await test('trash failing (it throws, or returns with the folder still there): the list, the record and the folder are unchanged', async () => {
    for (const trash of [async () => { throw Object.assign(new Error('no'), { code: 'EPERM' }) }, async () => {}]) {
      const h = await harness({ trash })
      const before = listing(h.home)
      const p = await h.removal.preview(7)
      assert.deepEqual(await h.removal.remove(p.token, 7), { ok: false, message: EXAMPLE_REMOVAL_MESSAGES.trashFailed })
      assert.ok(h.example(), 'still listed')
      assert.equal(h.config().exampleVaultRemoved, undefined)
      const after = listing(h.home)
      assert.deepEqual([...before].filter(([k, v]) => after.get(k) !== v), [], 'nothing else changes')
    }
  })

  await test('already gone (binned in Finder): Remove takes it off the list with no trash call; Settings then offers it again', async () => {
    const h = await harness()
    renameSync(h.root, join(h.bin, 'by hand'))
    const p = await h.removal.preview(7)
    assert.equal(p.ok, true)
    assert.equal(p.talks, 0, 'the real count: nothing there')
    assert.deepEqual(await h.removal.remove(p.token, 7), { ok: true, outcome: 'already-gone' })
    assert.equal(h.calls.trash.length, 0)
    assert.equal(h.example(), null)
    assert.equal(h.removal.wasRemoved(), true)
  })

  // ── rules C and D: refusals ──
  await test('a symlinked TalkWeaver, a symlinked Documents, or Example vault itself a link: refused in one sentence, nothing binned', async () => {
    for (const which of ['parent', 'documents', 'root']) {
      const h = await harness()
      const real = realpathSync(h.home)
      const elsewhere = join(dirname(h.home), `elsewhere-${which}`)
      if (which === 'parent') {
        renameSync(join(real, 'Documents', 'TalkWeaver'), elsewhere)
        symlinkSync(elsewhere, join(real, 'Documents', 'TalkWeaver'))
      } else if (which === 'documents') {
        renameSync(join(real, 'Documents'), elsewhere)
        symlinkSync(elsewhere, join(real, 'Documents'))
      } else {
        renameSync(h.root, elsewhere)
        symlinkSync(elsewhere, h.root)
      }
      const p = await h.removal.preview(7)
      assert.equal(p.ok, false, which)
      assert.ok([EXAMPLE_REMOVAL_MESSAGES.notPlain, EXAMPLE_REMOVAL_MESSAGES.noHome].includes(p.message), `${which}: ${p.message}`)
      assert.equal(h.calls.trash.length, 0)
      assert.ok(existsSync(join(elsewhere, which === 'root' ? 'garden-notes' : which === 'parent' ? 'Example vault' : 'TalkWeaver')), 'the far end untouched')
    }
  })

  await test('a link swapped in after the preview: refused at remove, nothing binned', async () => {
    const h = await harness()
    const p = await h.removal.preview(7)
    const parent = dirname(h.root)
    const elsewhere = join(dirname(h.home), 'swap')
    renameSync(parent, elsewhere)
    symlinkSync(elsewhere, parent)
    assert.equal((await h.removal.remove(p.token, 7)).ok, false)
    assert.equal(h.calls.trash.length, 0)
  })

  await test('a foreign folder at the path (no vault file, a vault file not flagged, or another id): refused, nothing binned', async () => {
    for (const how of ['no-file', 'not-flagged', 'other-id']) {
      const h = await harness()
      const file = join(h.root, '.talkweaver', 'vault.json')
      const data = JSON.parse(readFileSync(file, 'utf8'))
      if (how === 'no-file') rmSync(join(h.root, '.talkweaver'), { recursive: true })
      else writeFileSync(file, JSON.stringify(how === 'not-flagged' ? { ...data, example: false } : { ...data, id: 'someone-else' }))
      const p = await h.removal.preview(7)
      assert.deepEqual(p, { ok: false, message: EXAMPLE_REMOVAL_MESSAGES.notExample }, how)
      assert.equal(h.calls.trash.length, 0)
    }
  })

  await test('the list’s example flag missing, or nothing listed at the fixed path: refused, nothing binned', async () => {
    const h = await harness({ open: false })
    assert.deepEqual(await h.removal.preview(7), { ok: false, message: EXAMPLE_REMOVAL_MESSAGES.notListed })
    // A folder of the person's own at the path, added as an ordinary vault (no flag).
    mkdirSync(h.root, { recursive: true })
    writeFileSync(join(h.root, 'mine.md'), 'mine')
    h.registry.add(h.root)
    assert.deepEqual(await h.removal.preview(7), { ok: false, message: EXAMPLE_REMOVAL_MESSAGES.notListed })
    assert.equal(h.calls.trash.length, 0)
    assert.ok(existsSync(join(h.root, 'mine.md')))
  })

  await test('more than 10,000 entries: not the example, no token, nothing binned', async () => {
    let fake = null
    const fs = {
      ...nodeExampleVaultFs,
      opendir: async (path) => {
        if (fake && path === fake) {
          return (async function * () {
            for (let i = 0; i <= EXAMPLE_COUNT_LIMIT + 5; i += 1) yield { name: `f${i}`, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false }
          })()
        }
        return nodeExampleVaultFs.opendir(path)
      }
    }
    const h = await harness({ fs })
    fake = h.root
    assert.deepEqual(await h.removal.preview(7), { ok: false, message: EXAMPLE_REMOVAL_MESSAGES.tooMany })
    assert.equal(h.calls.trash.length, 0)
  })

  await test('no home for this run: nothing to remove', async () => {
    const h = await harness()
    const none = new ExampleVaultRemoval({ home: () => null, registry: h.registry, record: { removed: () => false, setRemoved: () => true }, writer: h.writer, trash: async () => { throw new Error('never') }, openWindows: () => [] })
    assert.equal((await none.preview(1)).ok, false)
  })

  // ── rule F: restore ──
  await test('restore after removal: a fresh copy of the five talks, the vault back in the list, the record cleared, progress as it was', async () => {
    const h = await harness()
    const progress = progressOf(h.config())
    const p = await h.removal.preview(7)
    await h.removal.remove(p.token, 7)
    const result = await h.removal.restore()
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.outcome, 'written')
    assert.ok(result.startTalk?.endsWith('the-saturday-market-outline.md'))
    for (const f of bundleFiles()) assert.deepEqual(readFileSync(join(h.root, f)), readFileSync(join(BUNDLE, f)), f)
    assert.ok(h.example(), 'listed again, flagged')
    assert.equal(h.config().exampleVaultRemoved, false)
    assert.equal(h.removal.wasRemoved(), false)
    assert.equal(progressOf(h.config()), progress, 'ticks and read marks restored as they were (never touched)')
    assert.ok(existsSync(join(h.bin, 'Example vault')), 'the binned copy is left in the Bin')
  })

  await test('restore with the binned folder put back by hand adopts it (it holds the example vault file); a foreign folder is in the way and nothing changes', async () => {
    const h = await harness()
    const p = await h.removal.preview(7)
    await h.removal.remove(p.token, 7)
    renameSync(join(h.bin, 'Example vault'), h.root)
    const adopted = await h.removal.restore()
    assert.equal(adopted.ok && adopted.outcome, 'adopted')
    const h2 = await harness()
    const p2 = await h2.removal.preview(7)
    await h2.removal.remove(p2.token, 7)
    mkdirSync(h2.root)
    writeFileSync(join(h2.root, 'mine.txt'), 'mine')
    const before = listing(h2.home)
    const refused = await h2.removal.restore()
    assert.equal(refused.ok, false)
    assert.match(refused.message, /already in Documents › TalkWeaver/)
    assert.deepEqual(listing(h2.home), before, 'nothing written')
    assert.equal(h2.removal.wasRemoved(), true, 'still removed')
  })

  // ── the e2e stand-in Bin ──
  await test('the e2e Bin: a normal launch gets the system Bin; a harness run gets the stand-in only unpackaged and inside the temp folder; never elsewhere', async () => {
    const system = async () => {}
    assert.equal(resolveExampleTrash({ isPackaged: true, env: {}, systemTrash: system }), system)
    assert.equal(resolveExampleTrash({ isPackaged: false, env: { TW_E2E_BIN: '/tmp/x' }, systemTrash: system }), system, 'no flag, no stand-in')
    await assert.rejects(resolveExampleTrash({ isPackaged: true, env: { TW_E2E: '1', TW_E2E_BIN: base }, systemTrash: system })('/x'), /No Bin/)
    await assert.rejects(resolveExampleTrash({ isPackaged: false, env: { TW_E2E: '1' }, systemTrash: system })('/x'), /No Bin/)
    const outside = join(REPO, '.test-example-removal-outside')
    mkdirSync(outside, { recursive: true })
    try {
      await assert.rejects(resolveExampleTrash({ isPackaged: false, env: { TW_E2E: '1', TW_E2E_BIN: outside }, systemTrash: system })('/x'), /temp/)
    } finally { rmSync(outside, { recursive: true, force: true }) }
    const realBin = join(base, 'standin-bin')
    mkdirSync(realBin)
    const linkBin = join(base, 'link-bin')
    symlinkSync(realBin, linkBin)
    assert.equal(await harnessBinInsideTemp(linkBin, tmpdir()), null, 'a link is refused')
    assert.equal(await harnessBinInsideTemp('relative/bin', tmpdir()), null)
    assert.equal(await harnessBinInsideTemp(realBin, tmpdir()), realBin)
    const victim = join(base, 'victim')
    mkdirSync(victim)
    await resolveExampleTrash({ isPackaged: false, env: { TW_E2E: '1', TW_E2E_BIN: realBin }, systemTrash: system })(victim)
    assert.ok(!existsSync(victim) && readdirSync(realBin).length === 1, 'moved into the stand-in Bin')
  })

  // ── the registry's remove ──
  await test('the registry’s remove: config only, renumbered, an unknown id refused, the folder untouched', async () => {
    const h = await harness({ ownVault: true })
    const before = listing(h.home)
    const id = h.example().id
    assert.throws(() => h.registry.remove('nope'), /No vault/)
    h.registry.remove(id)
    assert.deepEqual(h.registry.list().map((v) => v.order), [0])
    assert.deepEqual(listing(h.home), before, 'nothing on disk')
  })

  // ── the wiring ──
  await test('main: no path crosses; only app windows ask; the trash is shell.trashItem through the harness guard; open windows are named from main’s bookkeeping and none is closed', () => {
    const main = read('src/main/index.ts')
    const block = main.slice(main.indexOf('// ── Remove the example vault and bring it back'), main.indexOf("ipcMain.handle('vault:add'"))
    for (const needle of ["'example:state'", "'example:removal-preview'", "'example:remove'", "'example:restore'", "'example:changed'", 'isAppWindow(event.sender.id)', 'exampleRemoval.preview(event.sender.id)', 'exampleRemoval.remove(token, event.sender.id)', 'resolveExampleTrash(', 'shell.trashItem(path)', 'openWindows: windowsShowingExample', 'windowsOnExample(', 'editorWindows.values()', 'presentWindows.get(id)', 'pathwayWindowContext?.outlinePath', 'toolsWindow', 'isHiddenRenderer(id)']) {
      assert.ok(block.includes(needle), needle)
    }
    for (const gone of ["'outline:close-requested'", '.close()', 'createWindow()', 'closeWindows', "once('closed'"]) assert.ok(!block.includes(gone), `no window is closed or opened by removal: ${gone}`)
    assert.ok(!/rmSync|unlink|rimraf|fs\.rm\(|\brm\(/.test(block), 'no delete in the wiring')
    const remover = read('src/main/example-vault-removal.ts')
    assert.ok(!/from 'node:fs\/promises'|unlink|rmdir|\brm\b\(|rename\(/.test(remover), 'the remover imports no filesystem writer')
    const preload = read('src/preload/index.ts')
    for (const needle of ['exampleRemovalPreview', "ipcRenderer.invoke('example:remove', token)", "ipcRenderer.invoke('example:restore')", 'onExampleChanged']) assert.ok(preload.includes(needle), needle)
  })

  await test('the palette: “Get started: show the example vault again” first of the three Get started rows, Set up TalkWeaver, no key, not by place, handled in the renderer', () => {
    const command = COMMAND_REGISTRY.find((c) => c.id === 'get-started-show-example')
    assert.ok(command)
    assert.equal(command.label, EXAMPLE_REMOVAL_TEXT.paletteShow)
    assert.equal(command.taskGroup, 'Set up TalkWeaver')
    assert.equal(command.subgroup, 'Get started')
    assert.ok(command.places)
    assert.equal(command.shortcutId, undefined)
    const rows = paletteCommands().filter((c) => c.label.toLowerCase().includes('get started')).map((c) => c.label)
    assert.deepEqual(rows, TEXT.palette.rows.map((r) => r[0]), 'state 16b, in the drawn order')
    assert.ok(read('src/renderer/src/components/WorkspaceLayout.tsx').includes("'example.restore':"))
    assert.ok(read('src/renderer/src/App.tsx').includes("'tw-restore-example'"))
  })

  // ── render ──
  const bundle = join(renderDir, 'bundle.mjs')
  await build({
    stdin: {
      contents: [
        "import React from 'react'",
        "import { renderToStaticMarkup } from 'react-dom/server'",
        "import RemoveExampleConfirm from './src/renderer/src/components/RemoveExampleConfirm.tsx'",
        "import GuidePane from './src/renderer/src/components/GuidePane.tsx'",
        "import SettingsPanel from './src/renderer/src/components/SettingsPanel.tsx'",
        "import { VaultContextMenu } from './src/renderer/src/components/talklist/menus.tsx'",
        "export const confirm = (props) => renderToStaticMarkup(React.createElement(RemoveExampleConfirm, props))",
        "export const pane = (props) => renderToStaticMarkup(React.createElement(GuidePane, props))",
        "export const settings = (props) => renderToStaticMarkup(React.createElement(SettingsPanel, props))",
        "export const vaultMenu = (props) => renderToStaticMarkup(React.createElement(VaultContextMenu, props))"
      ].join('\n'),
      resolveDir: REPO,
      sourcefile: 'test-example-removal-entry.tsx'
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    jsx: 'automatic',
    loader: { '.css': 'empty' },
    external: ['react', 'react/*', 'react-dom', 'react-dom/*', 'lucide-react'],
    outfile: bundle,
    logLevel: 'silent'
  })
  const m = await import(pathToFileURL(bundle).href)
  const noop = () => {}
  const vault = { color: '#0f766e', initial: 'E', name: 'Example vault' }

  await test('the confirmation (state 15): title, lead, the three bounded lists in order with the real folder and count, Cancel and Remove example vault', () => {
    const html = m.confirm({ vault, preview: { ok: true, folder: '~/Documents/TalkWeaver/Example vault', talks: 5, token: 'a'.repeat(64) }, busy: false, error: null, onCancel: noop, onConfirm: noop })
    const t = text(html)
    const c = TEXT.confirm
    assert.ok(t.includes(c.title) && t.includes(c.lead))
    assert.deepEqual([...html.matchAll(/data-rx-group="(\w+)"/g)].map((x) => x[1]), ['bin', 'off', 'kept'])
    assert.ok(t.indexOf(c.binBar) < t.indexOf(c.offBar) && t.indexOf(c.offBar) < t.indexOf(c.keptBar))
    assert.ok(t.includes(`${c.bin[0][0]} ${c.bin[0][1]}`), 'the drawn folder line, from the real count')
    for (const line of [...EXAMPLE_REMOVAL_TEXT.confirm.off, ...c.kept]) assert.ok(t.includes(line.replace(/’/g, '’')), line)
    assert.ok(t.endsWith(`${c.cancel} ${c.ok}`))
    assert.ok(html.includes('role="dialog"') && html.includes('aria-modal="true"'))
    assert.ok(!/data-rx-confirm[^>]*disabled/.test(html), 'Remove is live once the preview is in')
    assert.ok(html.includes('>E<'), 'the example vault’s badge')
  })

  await test('the confirmation while main reads the folder, after a refusal, and while removing: Remove is not live; the sentence shows', () => {
    const loading = m.confirm({ vault, preview: null, busy: false, error: null, onCancel: noop, onConfirm: noop })
    assert.ok(/<button[^>]*disabled=""[^>]*data-rx-confirm|data-rx-confirm[^>]*disabled=""/.test(loading))
    const refused = m.confirm({ vault, preview: { ok: false, message: EXAMPLE_REMOVAL_MESSAGES.notExample }, busy: false, error: null, onCancel: noop, onConfirm: noop })
    assert.ok(text(refused).includes(EXAMPLE_REMOVAL_MESSAGES.notExample) && refused.includes('data-rx-error'))
    const busy = m.confirm({ vault, preview: { ok: true, folder: 'f', talks: 5, token: 'a'.repeat(64) }, busy: true, error: null, onCancel: noop, onConfirm: noop })
    assert.equal((busy.match(/disabled=""/g) ?? []).length, 2, 'both buttons wait')
    const open = closeExampleTalksFirst(['The Saturday market'])
    const failed = m.confirm({ vault, preview: { ok: false, message: open }, busy: false, error: open, onCancel: noop, onConfirm: noop })
    assert.ok(text(failed).includes(open))
    assert.ok(/<button[^>]*disabled=""[^>]*data-rx-confirm|data-rx-confirm[^>]*disabled=""/.test(failed), 'no Remove while a window is open')
  })

  await test('the ⋯ menu (state 17): the example vault ends with Remove example vault… after a rule, with the trash-2 icon; other vaults do not have it', () => {
    const ex = m.vaultMenu({ x: 0, y: 0, open: true, example: true, onAction: noop, onClose: noop })
    const t = text(ex)
    assert.ok(t.endsWith(TEXT.menuRemove), t)
    for (const item of TEXT.menu) assert.ok(t.includes(item), item)
    assert.ok(ex.lastIndexOf('<hr') > ex.indexOf('Close vault'), 'a rule before Remove')
    assert.ok(ex.includes('M10 11v6'), 'lucide trash-2')
    const own = m.vaultMenu({ x: 0, y: 0, open: true, onAction: noop, onClose: noop })
    assert.ok(!text(own).includes('Remove example vault'))
    const gone = m.vaultMenu({ x: 0, y: 0, open: true, unavailable: true, example: true, onAction: noop, onClose: noop })
    assert.ok(text(gone).includes('Close vault') && text(gone).endsWith(TEXT.menuRemove), 'binned in Finder: Remove still offered')
  })

  const CHAPTERS_STUB = { chapters: [], learn: { version: 1, ran: [], opened: [], finished: {}, read: [] }, selected: null, onSelect: noop, onBack: noop, chordOf: () => '', practice: () => ({ talk: '', section: '', openNow: false }), onOpenPractice: noop, flashId: null }
  await test('the Guide’s first screen (states 15, 17): Remove the example vault… after the chapters while the example is listed; gone after removal and inside a chapter', () => {
    const steps = []
    const on = m.pane({ segment: 'commands', onSegment: noop, steps, onStep: noop, chapters: CHAPTERS_STUB, onRemoveExample: noop })
    assert.ok(text(on).includes(TEXT.removeExample) && on.includes('data-guide-remove-example'))
    assert.ok(on.indexOf('data-guide-slot="chapters"') < on.indexOf('data-guide-remove-example'), 'under the chapters')
    const off = m.pane({ segment: 'commands', onSegment: noop, steps, onStep: noop, chapters: CHAPTERS_STUB })
    assert.ok(!off.includes('data-guide-remove-example'))
    const inChapter = m.pane({ segment: 'commands', onSegment: noop, steps, onStep: noop, chapters: { ...CHAPTERS_STUB, selected: 'Present' }, onRemoveExample: noop })
    assert.ok(!inChapter.includes('data-guide-remove-example'))
  })

  await test('Settings → Get started after removal (state 16): “The example vault was removed.”, Show the example vault again, Open the Guide; before removal only Open the Guide', () => {
    const removed = m.settings({ isOpen: true, onClose: noop, vaultRoot: '/v', onChangeVault: noop, onOpenGuide: noop, exampleRemoved: true, onRestoreExample: noop })
    const row = removed.slice(removed.indexOf('data-setting="get-started"'), removed.indexOf('data-setting="guide-button"'))
    const t = text(row)
    assert.ok(t.includes('Get started') && t.includes(TEXT.settings.note), t)
    assert.ok(t.indexOf(TEXT.settings.b1) < t.indexOf(TEXT.settings.b2), 'Show the example vault again, then Open the Guide')
    assert.ok(row.includes('data-restore-example') && row.includes('data-open-guide'))
    const before = m.settings({ isOpen: true, onClose: noop, vaultRoot: '/v', onChangeVault: noop, onOpenGuide: noop })
    assert.ok(!before.includes('data-restore-example') && !text(before).includes(TEXT.settings.note))
  })

  console.log(`\n${passed} passed`)
} finally {
  rmSync(renderDir, { recursive: true, force: true })
  for (const name of readdirSync(REPO)) if (name.startsWith('.test-example-removal-')) rmSync(join(REPO, name), { recursive: true, force: true })
  rmSync(base, { recursive: true, force: true })
}
