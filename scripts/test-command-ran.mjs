// Onboarding 0.38.1 ticket 08: ONE notifier, `commandRan(id)`, that every route by which a command runs
// reports to.
//   - the single-notifier test: every command in a chapter (the registry's grouped commands and the presenter
//     palette's key-less entries) has a reporting route, found in the source: the handler map (every handler
//     is wrapped by `reportingHandlers`), the editor keymap (`buildEditorKeyBindings` reports a key that
//     acted), or a literal `commandRan('<id>')` in a file that imports the notifier (or in main). A command
//     with a key of its own in the main window needs a reporting key route too. The test fails when a
//     command has none, and the written list of ACCEPTED exceptions below is the only way out;
//   - the notifier's own behaviour (jsdom-free: a fake `window.tw`): it names the command, tells main once
//     per session (except commands that delete, which ask every time), passes the talk's path, never throws,
//     and announces a first tick to listeners;
//   - the handler wrapper: every handler reports its own id after it ran; one that throws is not a run.
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { chapterCommands, deriveChapters, resolveCommandId } from '../src/shared/guide-chapters.ts'
import { COMMAND_REGISTRY } from '../src/shared/command-registry.ts'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(join(REPO, rel), 'utf8')
let passed = 0
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`PASS  ${name}`) } catch (error) { console.error(`FAIL  ${name}`); throw error }
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(p)
  }
  return out
}

/**
 * Commands that have no reporting route in this build, each with its reason. Anything not listed here
 * and not found in the source fails the test.
 */
const ACCEPTED = {
  'editor.protect-heading-delete': 'Not an action the person runs: the Delete key on a heading is refused by the identity guard (idProtect.ts), which has nothing to report. The row can only be ticked by the Guide’s own limit: it stays unticked.',
  'editor.object-row-up': 'A real key, bound in the chat, terminal and trace row editor (objects/card-editors.ts, chordMatches) and in both registries. That plain-DOM editor does not import the notifier, so a press is not counted toward the Guide’s tried-counts: a reporting gap, not a dead command.',
  'editor.object-row-down': 'The same key family as editor.object-row-up (⌃⌘↓): bound and working in objects/card-editors.ts, not counted toward the Guide’s tried-counts.'
}
const accepted = (id) => ACCEPTED[id] ?? null

// ── The presenter's routes (ticket 10) ──
// The presenter template reports every command it runs through one function, reportGuideCommand, from four
// routes: a default key handleKey acted on (guideKeyCommand reads the registry's codes), a rebound key (the
// override match), the palette (runPaletteEntry), and a press on a control (PRESENTER_CONTROL_COMMANDS, or a
// key-less palette entry's control). Keys bound outside the template report for themselves: the preloads'
// keys with a literal reportGuideCommand('<id>'), and F5 / ⌘R, which main intercepts, with a literal
// guideLearn.commandRan('<id>'). The bridge preload forwards the page's event to main (guide:command-ran).
const TEMPLATE = read('compiler/assets/templates/presenter-popup-single-html.html')
const generated = (name) => { const m = TEMPLATE.match(new RegExp(`const ${name} = (.*);\n`)); return m ? JSON.parse(m[1]) : null }
const PRESENTER_COMMAND_KEYS = generated('PRESENTER_COMMAND_KEYS')
const PRESENTER_CONTROL_COMMANDS = generated('PRESENTER_CONTROL_COMMANDS')
const PRESENTER_PALETTE_DATA = generated('PRESENTER_PALETTE')
const PRELOAD_BOUND = {
  'presenter.record': 'src/preload/present-rec-ui.ts', 'presenter.record-pause': 'src/preload/present-rec-ui.ts',
  'presenter.save-run-as': 'src/preload/present-rec-ui.ts', 'presenter.save-run': 'src/preload/present-rec-ui.ts',
  'presenter.live': 'src/preload/present-live-bridge.ts', 'presenter.edit': 'src/preload/present-edit-bridge.ts',
  'presenter.guide': 'src/preload/present-guide.ts'
}
const MAIN_BOUND = ['presenter.audience', 'presenter.refresh']
/** The presenter's route for a presenter command, or null when it has none. */
function presenterRoute(id) {
  if (PRELOAD_BOUND[id]) return read(PRELOAD_BOUND[id]).includes(`reportGuideCommand('${id}')`) ? `key in ${PRELOAD_BOUND[id].split('/').pop()}` : null
  if (MAIN_BOUND.includes(id)) return read('src/main/index.ts').includes(`guideLearn.commandRan('${id}'`) ? 'key in main' : null
  if (id.startsWith('presenter-palette.')) {
    const entry = PRESENTER_PALETTE_DATA.flatMap(([, entries]) => entries).find((e) => `presenter-palette.${e.id}` === id && !e.shortcut)
    return entry && entry.controls.length ? 'palette + its control' : null
  }
  const key = PRESENTER_COMMAND_KEYS.find((c) => c.id === id && c.codes.length)
  const control = Object.values(PRESENTER_CONTROL_COMMANDS).includes(id)
  return key || control ? [key && 'key', control && 'control'].filter(Boolean).join(' + ') : null
}

const SRC = join(REPO, 'src')
const files = walk(SRC)
const importsNotifier = (text) => /from '(?:\.\.?\/)+(?:commands\/)?command-ran'/.test(text) || /from '\.\/commands\/command-ran'/.test(text)
const evidenceFiles = files.filter((f) => importsNotifier(readFileSync(f, 'utf8')) && !f.endsWith(join('commands', 'command-ran.ts')))
const evidenceText = evidenceFiles.map((f) => readFileSync(f, 'utf8')).join('\n') + '\n' + read('src/main/index.ts')
const mentions = (id) => evidenceText.includes(`'${id}'`) || evidenceText.includes(`"${id}"`)

const layout = read('src/renderer/src/components/WorkspaceLayout.tsx')
const mapStart = layout.indexOf('commandHandlersRef.current = reportingHandlers({')
const mapEnd = layout.indexOf('}, (handlerId) => { if (!SELF_REPORTING_HANDLERS.has(handlerId)) commandRan(handlerId) })', mapStart)
const handlerMap = mapStart >= 0 && mapEnd > mapStart ? layout.slice(mapStart, mapEnd) : ''
const handlerIds = new Set([...handlerMap.matchAll(/^ {4}(?:'([^']+)'|([A-Za-z][\w]*)):/gm)].map((x) => x[1] ?? x[2]))

const keymapSource = read('src/renderer/src/keymap/registry.ts')
const editorKeymapIds = new Set()
for (const line of keymapSource.split('\n')) {
  const m = line.match(/^\s*command\('([^']+)',/)
  if (!m) continue
  const registryId = line.match(/,\s*'((?:app|editor)\.[\w.-]+)'\)\s*,?\s*$/)
  editorKeymapIds.add(registryId ? registryId[1] : `editor.${m[1]}`)
}

await test('the handler map is one object, wrapped by reportingHandlers; no other assignment to it', () => {
  assert.ok(handlerMap.length > 0, 'the wrapped map is found')
  assert.equal((layout.match(/commandHandlersRef\.current = /g) ?? []).length, 1, 'one assignment')
  assert.ok(handlerIds.size > 60, `the map’s handler ids were read (${handlerIds.size})`)
  assert.ok(handlerIds.has('format-bold') && handlerIds.has('guide.open') && handlerIds.has('app.command-palette'))
  // Handlers that report for themselves (they can decline): runPickerCommand reports once the action acted.
  for (const id of ['add-talk-beside', 'talk-beside', 'close-talk-beside', 'select-whole-section']) {
    assert.ok(layout.includes(`'${id}': () => runPickerCommand(`) && layout.includes(`, '${id}')`), id)
  }
  assert.ok(/runPickerCommand = \(run[^)]*\)[^{]*\{[\s\S]*?else commandRan\(id\)/.test(layout), 'the picker route reports on success only')
  // Every route into the map goes through the one ref: the palette, the menus, the action bar and the native menu.
  assert.ok(layout.includes('window.tw.app?.onCommand?.(runRegisteredCommand)'), 'the native menu')
  assert.ok(layout.includes('run: () => runRegisteredCommand(command.handlerId)'), 'the action bar')
  assert.ok(layout.includes('onClick: handler,'), 'the Insert, Deck, Tools and Present menus run the map’s handlers')
})

await test('the editor keymap reports a key that acted, under the key’s shortcut id', () => {
  const store = read('src/renderer/src/keymap/store.ts')
  assert.ok(store.includes('const acted = c.run(view)') && store.includes('if (acted) commandRan(c.shortcutId)'))
  assert.ok(editorKeymapIds.has('editor.bold') && editorKeymapIds.has('app.sidebar-talks') && editorKeymapIds.has('editor.list-continue'))
  assert.ok(!editorKeymapIds.has('app.find-talk'), 'surface commands are not editor bindings')
})

await test('every command in a chapter has a reporting route; a key of its own in the main window has a reporting key route; the rest is the written ACCEPTED list', () => {
  const rows = []
  const unreported = []
  for (const command of chapterCommands()) {
    if (command.id.startsWith('presenter.') || command.id.startsWith('presenter-palette.')) {
      const route = presenterRoute(command.id)
      if (route) rows.push([command.id, `presenter: ${route}`])
      else unreported.push(`${command.id} (presenter)`)
      continue
    }
    const why = accepted(command.id)
    const byHandler = command.handlerId !== undefined && handlerIds.has(command.handlerId)
    const byKeymap = editorKeymapIds.has(command.shortcutId ?? command.id) || editorKeymapIds.has(command.id)
    const literal = mentions(command.id) || (command.shortcutId !== undefined && mentions(command.shortcutId)) || (command.handlerId !== undefined && mentions(command.handlerId))
    const routes = [byHandler && 'handler', byKeymap && 'editor keymap', literal && 'literal'].filter(Boolean)
    if (why) { rows.push([command.id, `accepted: ${why.slice(0, 40)}…`]); continue }
    if (routes.length === 0) { unreported.push(command.id); continue }
    // A key of its own in the main window (not the editor keymap) needs a reporting key route: a literal
    // report at the key's handler, or the key running the map's handler by `runRegisteredCommand('<id>')`.
    const registry = COMMAND_REGISTRY.find((c) => c.id === command.id)
    const hasMainWindowKey = registry?.shortcutId && ['app', 'deck'].includes(registry.scope)
    if (hasMainWindowKey && !byKeymap) {
      const keyRoute = literal || layout.includes(`runRegisteredCommand('${command.handlerId}')`)
      if (!keyRoute) unreported.push(`${command.id} (its key, ${registry.shortcutId})`)
    }
    rows.push([command.id, routes.join(' + ')])
  }
  assert.deepEqual(unreported, [], `commands with no reporting route: ${unreported.join(', ')}`)
  const acceptedIds = rows.filter((r) => String(r[1]).startsWith('accepted')).map((r) => r[0])
  const presenterRows = rows.filter((r) => String(r[1]).startsWith('presenter:'))
  console.log(`  routes found for ${rows.length - acceptedIds.length} commands (${presenterRows.length} in the presenter); accepted without a route: ${acceptedIds.length} (${acceptedIds.join(', ')})`)
})

await test('the accepted exceptions are real, and are only what they say; the presenter is no longer one', () => {
  const ids = new Set(chapterCommands().map((c) => c.id))
  assert.ok(ids.has('editor.protect-heading-delete'))
  assert.deepEqual(Object.keys(ACCEPTED), ['editor.protect-heading-delete', 'editor.object-row-up', 'editor.object-row-down'])
  assert.ok(ids.has('editor.object-row-up') && ids.has('editor.object-row-down'))
  const rowEditor = read('src/renderer/src/objects/card-editors.ts')
  assert.ok(rowEditor.includes("'editor.object-row-up'") && rowEditor.includes("'editor.object-row-down'"), 'the accepted row keys are really bound in the row editor')
  const presenter = [...ids].filter((id) => id.startsWith('presenter.') || id.startsWith('presenter-palette.'))
  assert.ok(presenter.length > 30)
  assert.deepEqual(presenter.filter((id) => !presenterRoute(id)), [], 'every presenter command has a route')
  assert.equal(resolveCommandId('editor.protect-heading-delete'), 'editor.protect-heading-delete')
})

await test('the presenter template reports through one function, from its four routes, once per page', () => {
  assert.ok(PRESENTER_COMMAND_KEYS && PRESENTER_CONTROL_COMMANDS && PRESENTER_PALETTE_DATA, 'the generated blocks are read')
  assert.equal((TEMPLATE.match(/new CustomEvent\("tw-guide-command-ran"/g) ?? []).length, 1, 'one dispatch site')
  assert.ok(TEMPLATE.includes('if (!isPresenter || isReplay || typeof id !== "string" || !id || guideReported.has(id)) return;'), 'presenter only, once per id')
  assert.ok(TEMPLATE.includes('if (isPresenter && !acted && event.defaultPrevented && !shortcutForwarded.has(event)) reportGuideCommand(guideKeyCommand(event));'), 'a default key that acted')
  assert.ok(TEMPLATE.includes('reportGuideCommand(guideIdOfOverride(match.id));'), 'a rebound key')
  assert.ok(TEMPLATE.includes('if (action) reportGuideCommand(guideIdOfEntry(entry));'), 'the palette, when the entry applies')
  assert.ok(TEMPLATE.includes('document.addEventListener("click", (event) => reportGuideCommand(guideControlCommand(event.target)), true);'), 'a press on a control')
  const bridge = read('src/preload/present-edit-bridge.ts')
  assert.ok(bridge.includes("void ipcRenderer.invoke('guide:command-ran', id)") && bridge.includes('sent.has(id)'), 'the bridge forwards each id once')
})

await test('the routes outside the main window report through the same preload: Pathways, notes, Importer, Studio, the Talks panel', () => {
  const need = {
    'src/renderer/src/components/Pathways.tsx': ['pathway.new', 'pathway.rename', 'pathway.delete', 'pathway.drop-missing', 'pathway.move-item', 'pathway.present', 'pathway.reorder', 'pathway.previews', 'pathway.help', 'pathway.grid', 'pathway.list', 'pathway.matrix'],
    'src/renderer/src/components/TalkText.tsx': ['talktext.notes', 'talktext.script', 'talktext.rewrite', 'talktext.copy', 'talktext.help'],
    'src/renderer/src/components/Importer.tsx': ['importer.flagged', 'importer.search', 'importer.apply', 'importer.reset', 'importer.views', 'importer.help'],
    'src/renderer/src/components/Studio.tsx': ['studio.sidebar-toggle'],
    'src/renderer/src/components/talklist/TalkList.tsx': ['browser.talk-view', 'browser.talk-names', 'browser.filter', 'browser.sort', 'browser.open-talk', 'browser.up-level', 'browser.fold-all'],
    'src/renderer/src/components/talklist/actions.ts': ['browser.rename', 'browser.duplicate', 'browser.move-talk', 'browser.delete-talk', 'browser.open-talk']
  }
  for (const [file, ids] of Object.entries(need)) {
    const source = read(file)
    assert.ok(importsNotifier(source), `${file} imports the notifier`)
    for (const id of ids) assert.ok(source.includes(`'${id}'`), `${file} reports ${id}`)
  }
  const pathways = read('src/renderer/src/components/Pathways.tsx')
  assert.ok(pathways.includes('outlinePath: context?.outlinePath'), 'the Pathways window says which talk it is in (decision 12)')
  const actions = read('src/renderer/src/components/talklist/actions.ts')
  assert.ok(actions.includes("commandRan('browser.delete-talk', { outlinePath: talk.outlinePath })"), 'Move talk to Bin reports the talk’s path, once it has moved')
})

// ── the notifier's own behaviour ──
const renderDir = mkdtempSync(join(REPO, '.test-command-ran-'))
try {
  const bundle = join(renderDir, 'bundle.mjs')
  await build({
    entryPoints: [join(REPO, 'src/renderer/src/commands/command-ran.ts')],
    bundle: true, format: 'esm', platform: 'node', outfile: bundle, logLevel: 'silent'
  })
  const m = await import(pathToFileURL(bundle).href)
  const calls = []
  let outcome = { id: 'format-bold', ticked: true }
  let fail = null
  globalThis.window = { tw: { guide: { commandRan: (...args) => { calls.push(args); if (fail === 'throw') throw new Error('sync'); return fail === 'reject' ? Promise.reject(new Error('main gone')) : Promise.resolve(outcome) } } } }
  const settle = () => new Promise((r) => setTimeout(r, 10))

  await test('commandRan names the command, tells main once per session, and announces a first tick', async () => {
    const ticked = []
    const off = m.onCommandTicked((id) => ticked.push(id))
    const ran = []
    const offRan = m.onCommandRan((id) => ran.push(id))
    m.commandRan('editor.bold')
    await settle()
    assert.deepEqual(calls, [['format-bold', undefined]], 'the canonical id')
    assert.deepEqual(ticked, ['format-bold'])
    m.commandRan('format-bold')
    m.commandRan('editor.bold')
    await settle()
    assert.equal(calls.length, 1, 'once per session')
    assert.deepEqual(ran, ['format-bold', 'format-bold', 'format-bold'], 'but every run reaches the local listeners')
    m.commandRan('not-a-command')
    m.commandRan('')
    await settle()
    assert.equal(calls.length, 1, 'an id that is no command is not sent')
    off(); offRan()
  })

  await test('commands that delete are told to main every time, with the talk’s path (decision 12 is main’s)', async () => {
    calls.length = 0
    outcome = { id: 'delete-slide', ticked: false }
    m.setCommandRanContext(() => ({ outlinePath: '/v/talk/talk-outline.md' }))
    m.commandRan('delete-slide')
    m.commandRan('editor.delete-slide')
    m.commandRan('browser.delete-talk', { outlinePath: '/v/other/other-outline.md' })
    await settle()
    assert.deepEqual(calls, [['delete-slide', '/v/talk/talk-outline.md'], ['delete-slide', '/v/talk/talk-outline.md'], ['browser.delete-talk', '/v/other/other-outline.md']])
    calls.length = 0
    m.commandRan('format-italic')
    await settle()
    assert.deepEqual(calls, [['format-italic', '/v/talk/talk-outline.md']], 'any report carries the window’s talk')
  })

  await test('a report never fails a command: a throwing or rejecting main, no bridge at all, a throwing listener', async () => {
    for (const mode of ['throw', 'reject']) {
      fail = mode
      assert.doesNotThrow(() => m.commandRan('format-underline'))
      await settle()
    }
    fail = null
    const saved = globalThis.window.tw
    globalThis.window.tw = undefined
    assert.doesNotThrow(() => m.commandRan('format-strikethrough'))
    globalThis.window.tw = {}
    assert.doesNotThrow(() => m.commandRan('format-link'))
    globalThis.window.tw = saved
    const off = m.onCommandRan(() => { throw new Error('listener') })
    assert.doesNotThrow(() => m.commandRan('format-inline-code'))
    off()
    const offTick = m.onCommandTicked(() => { throw new Error('tick listener') })
    outcome = { id: 'fold-all', ticked: true }
    assert.doesNotThrow(() => m.commandRan('fold-all'))
    await settle()
    offTick()
  })

  await test('reportingHandlers: each handler runs, then reports its own id; a handler that throws is not a run', () => {
    const order = []
    const reported = []
    const wrapped = m.reportingHandlers({
      'format-bold': () => order.push('bold'),
      boom: () => { throw new Error('declined by throwing') }
    }, (id) => reported.push(id))
    wrapped['format-bold']()
    assert.deepEqual([order, reported], [['bold'], ['format-bold']])
    assert.throws(() => wrapped.boom(), /declined/)
    assert.deepEqual(reported, ['format-bold'], 'a throwing handler reports nothing')
    // The default reporter is the notifier: a handler id that is a registry command resolves.
    assert.equal(resolveCommandId('guide.open'), 'get-started-open-guide')
    const route = []
    const ranFn = m.ran('format-bold', (...args) => route.push(args))
    ranFn(1, 2)
    assert.deepEqual(route, [[1, 2]])
  })

  await test('every grouped command resolves, so a route that reports its id, its shortcut id or its handler id is never lost', () => {
    for (const command of chapterCommands()) {
      assert.equal(resolveCommandId(command.id), command.id)
      if (command.shortcutId) assert.equal(resolveCommandId(command.shortcutId), command.id, `${command.shortcutId} → ${command.id}`)
      if (command.handlerId) assert.equal(resolveCommandId(command.handlerId), command.id, `${command.handlerId} → ${command.id}`)
    }
    assert.equal(deriveChapters().length, 10)
  })

  console.log(`\n${passed} passed`)
} finally {
  rmSync(renderDir, { recursive: true, force: true })
  for (const name of readdirSync(REPO)) if (name.startsWith('.test-command-ran-')) rmSync(join(REPO, name), { recursive: true, force: true })
}
