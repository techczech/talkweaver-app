// ADR-0044 §6, rule A: every window main creates has a kind, and the restart treats each kind by its class (editor:
// closed under rule B; blocker: the person closes it; helper: stopped and closed). This fails for a `new BrowserWindow`
// in src/main without a registration next to it, for a kind missing from WINDOW_KINDS or from the ADR's table, and for
// a Settings window made somewhere new. Plain Node, no Electron.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WINDOW_KINDS, WINDOW_KIND_NAMES, registerWindowKind, windowBlockerOf, windowClassOf, windowKindOf, markHiddenRenderer, isHiddenRenderer } from '../src/main/window-kinds.ts'
import { RESTART_BLOCKERS, WINDOW_BLOCKERS } from '../src/shared/update-install.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
let passed = 0
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`PASS  ${name}`) } catch (error) { console.error(`FAIL  ${name}`); throw error }
}
const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name)
  return statSync(path).isDirectory() ? walk(path) : path.endsWith('.ts') ? [path] : []
})

/** Every `new BrowserWindow(` in src/main, with the kind registered for it (or null). */
export function windowRegistrations(root = ROOT) {
  const out = []
  for (const file of walk(join(root, 'src/main'))) {
    const text = readFileSync(file, 'utf8')
    const lines = text.split('\n')
    lines.forEach((line, i) => {
      if (!/new BrowserWindow\(/.test(line)) return
      const name = /(?:const|let|var)?\s*(\w+)\s*=\s*new BrowserWindow\(/.exec(line)?.[1] ?? null
      let kind = null
      for (let j = i + 1; j < Math.min(lines.length, i + 60); j++) {
        if (/new BrowserWindow\(/.test(lines[j])) break
        const m = new RegExp(`(?:registerWindowKind|markHiddenRenderer)\\(${name}, '([a-z-]+)'\\)`).exec(lines[j])
        if (m) { kind = m[1]; break }
      }
      out.push({ file: relative(root, file), line: i + 1, name, kind })
    })
  }
  return out
}

await test('every new BrowserWindow in src/main registers its kind where it is created, and the kind is in the table', () => {
  const found = windowRegistrations()
  assert.ok(found.length >= 9, `the windows were found (${found.length})`)
  for (const w of found) {
    assert.ok(w.kind, `${w.file}:${w.line} (${w.name}) creates a window without registerWindowKind / markHiddenRenderer within 60 lines`)
    assert.ok(WINDOW_KIND_NAMES.includes(w.kind), `${w.file}:${w.line}: kind '${w.kind}' is not in WINDOW_KINDS`)
  }
  const kinds = new Set(found.map((w) => w.kind))
  for (const kind of ['editor', 'tools', 'capture-embed', 'deck', 'thumbnail', 'scratchpad-capture', 'offline-page-capture', 'embed-preview-artwork', 'presenter-layers-source']) assert.ok(kinds.has(kind), `${kind} is registered somewhere`)
})

await test('windows opened by a deck window, at any depth, are registered as deck-child; the Settings window is known by identity', () => {
  const open = readFileSync(join(ROOT, 'src/main/present-window-open.ts'), 'utf8')
  assert.match(open, /contents\.on\('did-create-window', \(child\) => \{\n    try \{ opts\.childOpened\?\.\(child\) \}/)
  const index = readFileSync(join(ROOT, 'src/main/index.ts'), 'utf8')
  assert.match(index, /childOpened: \(child: unknown\) => registerWindowKind\(child as BrowserWindow, 'deck-child'\)/)
  assert.match(index, /guardDeckWindowTree\(win\.webContents, deckWindowOpenOpts\)/)
  assert.match(index, /return settingsWindow && !settingsWindow\.isDestroyed\(\) && settingsWindow === win \? 'settings' : null/)
  // The settings host makes one window, the Settings window. A second would need a kind of its own.
  const dist = join(ROOT, 'node_modules/@app-patterns/settings-electron/dist')
  const made = readdirSync(dist).filter((f) => f.endsWith('.js')).reduce((n, f) => n + (readFileSync(join(dist, f), 'utf8').match(/new BrowserWindow\(/g) ?? []).length, 0)
  assert.equal(made, 1, 'the settings host creates exactly one kind of window')
  // No other dependency main loads makes windows of its own (electron-updater makes none).
  assert.equal((readFileSync(join(ROOT, 'node_modules/electron-updater/out/MacUpdater.js'), 'utf8').match(/new BrowserWindow\(/g) ?? []).length, 0)
})

await test('each kind has one class, and a blocker kind names a restart blocker; a window of no known kind is a blocker', () => {
  for (const [kind, row] of Object.entries(WINDOW_KINDS)) {
    assert.ok(['editor', 'blocker', 'helper'].includes(row.class), kind)
    if (row.class === 'blocker') assert.ok(RESTART_BLOCKERS.includes(row.blocker), `${kind}: ${row.blocker} is a restart blocker`)
    else assert.equal(row.blocker, null, `${kind}: an ${row.class} raises no blocker`)
    assert.equal(windowClassOf(kind), row.class)
    assert.equal(windowBlockerOf(kind), row.blocker)
  }
  assert.equal(windowClassOf(null), 'blocker')
  assert.equal(windowBlockerOf(null), 'window')
  for (const b of ['tools', 'settings', 'capture']) assert.ok(WINDOW_BLOCKERS.includes(b))
  assert.deepEqual(Object.entries(WINDOW_KINDS).filter(([, r]) => r.class === 'editor').map(([k]) => k), ['editor'], 'only one kind of window is closed by the restart under rule B')
})

await test('ADR-0044 §6 lists every kind with its class (and nothing it does not have)', () => {
  const adr = readFileSync(join(ROOT, '_ADR/0044-in-place-updates.md'), 'utf8')
  const table = adr.slice(adr.indexOf('**Every window main creates**'), adr.indexOf('**How an editor\'s close ends**'))
  const rows = [...table.matchAll(/^\| `([a-z-]+)` \|[^|]*\|[^|]*\| (editor|blocker|helper)\b/gm)].map((m) => [m[1], m[2]])
  assert.deepEqual(rows.map(([k]) => k).sort(), [...WINDOW_KIND_NAMES].sort(), 'the table and WINDOW_KINDS name the same kinds')
  for (const [kind, cls] of rows) assert.equal(cls, WINDOW_KINDS[kind].class, `${kind}: the ADR says ${cls}`)
  assert.match(table, /\| \(none\) \| a window nobody registered \|[^\n]*blocker \(`window`\)/)
})

await test('a registration lasts until the window closes; a hidden renderer is a helper of its kind', () => {
  const fake = (id) => { const l = {}; return { webContents: { id }, once: (e, f) => { l[e] = f }, close: () => l.closed?.() } }
  const w = fake(9001)
  registerWindowKind(w, 'tools')
  assert.equal(windowKindOf(9001), 'tools')
  w.close()
  assert.equal(windowKindOf(9001), null)
  const h = fake(9002)
  markHiddenRenderer(h, 'thumbnail')
  assert.equal(windowKindOf(9002), 'thumbnail')
  assert.equal(isHiddenRenderer(9002), true)
  assert.equal(windowClassOf(windowKindOf(9002)), 'helper')
  h.close()
  assert.equal(isHiddenRenderer(9002), false)
})

console.log(`window kinds: ${passed} checks passed`)
