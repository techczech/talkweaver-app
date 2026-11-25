import { readPresenterTemplate } from '../compiler/scripts/lib/presenter-template.mjs'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { SHORTCUT_REGISTRY, shortcutEventMatches } = await import(
  new URL('../src/shared/shortcut-registry.ts', import.meta.url)
)

let failures = 0
const fail = (message) => { failures += 1; console.error(`  ✗ ${message}`) }
const ok = (message) => console.log(`  ✓ ${message}`)

// ── Presenter key truth (presenter redesign ticket 07) ──────────────────────────────────────────
// The presenter's ? sheet and command palette list the registry's presenter scope, so that scope
// must be exactly the keys the presenter binds. Every key comparison in the presenter's key
// handlers (the template's handleKey as it runs in the presenter, the palette's own keys, and the
// preloads' handlers) must be claimed below by a registry id, or marked as not reaching the
// presenter (`!isPresenter`); every presenter-scope entry must be claimed by a binding that
// exists. A listed key with no binding fails ("listed but not bound"); a binding with no listed
// key fails ("bound but not listed").
console.log('Presenter key truth:')
const { deckWindowKeyAction } = await import(new URL('../src/main/deck-window-keys.ts', import.meta.url))
const { PRESENTER_KEY_NEEDS } = await import(new URL('../src/shared/presenter-palette.ts', import.meta.url))
const presenterTemplate = readPresenterTemplate()
function sourceRegion(source, from, to, { skipBlocks = [] } = {}) {
  const start = source.indexOf(from)
  if (start < 0) return null
  const end = source.indexOf(to, start + from.length)
  if (end < 0) return null
  let text = source.slice(start, end + to.length)
  // Blocks that never run in the presenter (the audience branch): cut from their opening brace
  // to the matching closing one.
  for (const opener of skipBlocks) {
    const at = text.indexOf(opener)
    if (at < 0) return null
    let depth = 0
    let i = at + opener.length - 1
    for (; i < text.length; i += 1) {
      if (text[i] === '{') depth += 1
      else if (text[i] === '}') { depth -= 1; if (depth === 0) break }
    }
    text = text.slice(0, at) + text.slice(i + 1)
  }
  return text
}
const PRESENTER_KEY_REGIONS = [
  ['template handleKey', presenterTemplate, 'function handleKey(event) {', 'else if (isPresenter) return;', { skipBlocks: ['if (isAudience) {'] }],
  ['template isTalkQrKey', presenterTemplate, 'function isTalkQrKey(event) {', '\n  }'],
  ['template paletteKey', presenterTemplate, 'function paletteKey(event) {', '\n  }'],
  // ⌘V is the system paste: the presenter binds the paste event, not a key.
  ['template paste', presenterTemplate, "window.addEventListener('paste', (event) => {", '\n  });'],
  ['present-rec-ui', readFileSync(join(root, 'src/preload/present-rec-ui.ts'), 'utf8'), "window.addEventListener('keydown', (e: KeyboardEvent) => {", '}, true)'],
  ['present-live-bridge', readFileSync(join(root, 'src/preload/present-live-bridge.ts'), 'utf8'), "window.addEventListener('keydown', (event) => {", '}, true)'],
  ['present-edit-bridge', readFileSync(join(root, 'src/preload/present-edit-bridge.ts'), 'utf8'), "'keydown',", 'true\n  )'],
  ['present-guide', readFileSync(join(root, 'src/preload/present-guide.ts'), 'utf8'), "window.addEventListener('keydown', (event: KeyboardEvent) => {", '}, true)'],
  ['deck-window-keys', readFileSync(join(root, 'src/main/deck-window-keys.ts'), 'utf8'), 'export function', '\n}'],
  // The board panel (feedback-boards ticket 05): inlined into the presenter template, so its keys are
  // the template's own (no preload needed).
  ['template board panel', readFileSync(join(root, 'compiler/assets/runtime/board-panel.js'), 'utf8'), 'function boardUndoKey(event) {', '\n  return {']
]
const KEY_COMPARISON = /event\.key\.toLowerCase\(\) === 'i'|\b(?:key|code|e\.key|event\.key|event\.code|input\.key)(?:\.toLowerCase\(\))?\s*[!=]==\s*['"]|\.test\((?:key|e\.key|event\.key)\)|new Set\(\[\s*["']|(?<!function )isTalkQrKey\(event\)|addEventListener\('paste'/
// [region, line pattern, registry ids]. An empty id list needs `!isPresenter` in the line.
const PRESENTER_KEY_CLAIMS = [
  ['template handleKey', /event\.metaKey && event\.shiftKey && !event\.altKey && event\.key\.toLowerCase\(\) === 'p'/, ['presenter.command-palette']],
  ['template handleKey', /event\.metaKey && event\.altKey && !event\.shiftKey && event\.key\.toLowerCase\(\) === 'i'/, ['presenter.instant-compose']],
  ['template handleKey', /event\.key === ["']Escape["']/, ['presenter.close']],
  // ↵ in the instant and Quick-poll composers acts as their Show / Open poll button: composer-local.
  ['template handleKey', /event\.key === ["']Enter["'] && !event\.shiftKey/, ['picker.choose']],
  ['template handleKey', /instantActive && !lightboxActiveHere\(\) && event\.key === 'ArrowRight'/, ['presenter.instant-return']],
  ['template handleKey', /event\.key === "F5"/, ['presenter.audience']],
  ['template handleKey', /event\.key === "\?"/, ['presenter.help']],
  ['template handleKey', /key === "k" \|\| key === "K"/, ['presenter.poll-compose']],
  ['template handleKey', /key === "a" \|\| key === "A"/, ['presenter.questions']],
  ['template handleKey', /key === "q" \|\| key === "Q"/, ['presenter.poll-primary', 'presenter.poll-reveal']],
  ['template handleKey', /const nextKeys = |const nextCodes = /, ['presenter.next']],
  ['template handleKey', /const previousKeys = |const previousCodes = /, ['presenter.previous']],
  // While the talk QR is up: Esc or U return; navigation is swallowed there.
  ['template handleKey', /key === "Escape" \|\| \(isPresenter && isTalkQrKey\(event\)\)/, ['presenter.close', 'presenter.talk-qr']],
  ['template handleKey', /if \(isNextKey \|\| isPreviousKey \|\| key === "Home" \|\| key === "End"\)/, ['presenter.talk-qr']],
  ['template handleKey', /if \(isPresenter && isTalkQrKey\(event\)\)/, ['presenter.talk-qr']],
  ['template handleKey', /key === "Escape" \|\| key === "Enter" \|\| key === " " \|\| code === "Space"\) \{ event\.preventDefault\(\); closeQrFullscreen/, ['presenter.close']],
  // The open gallery: Esc / Z close, V full screen, Home / End first and last image.
  ['template handleKey', /key === "Escape" \|\| key === "z" \|\| key === "Z"/, ['presenter.gallery', 'presenter.close']],
  ['template handleKey', /\(key === "v" \|\| key === "V"\) && slideVideos\(\)\.length > 0\) \{ event\.preventDefault\(\); videoFullscreenCommand\(\); return; \}/, ['presenter.video-fullscreen']],
  ['template handleKey', /if \(key === "(?:Home|End)"\) \{ event\.preventDefault\(\); publish\(\{ lightbox/, ['presenter.gallery']],
  ['template handleKey', /key === "Escape" && livePage\.interact/, ['presenter.close']],
  ['template handleKey', /key === "Escape" && interactingFrame/, ['presenter.close']],
  ['template handleKey', /key === "Escape" && livePage\.interact/, ['presenter.close']],
  // Esc puts the slide back when its embedded page is full screen and not in use (ticket 13).
  ['template handleKey', /key === "Escape" && embedFullScreenOn\(\)/, ['presenter.close']],
  ['template handleKey', /key === "e" \|\| key === "E"/, ['presenter.embed']],
  ['template handleKey', /\/\^\[1-9\]\$\/\.test\(key\)/, ['presenter.grid-child', 'presenter.video-marker']],
  ['template handleKey', /isPresenter && key === "Escape"/, ['presenter.close']],
  ['template handleKey', /key === "j" \|\| key === "J"/, ['presenter.notes-scroll']],
  ['template handleKey', /\.presenter-notes-more/, ['presenter.notes-scroll']],
  ['template handleKey', /key === "r" \|\| key === "R"/, ['presenter.reveal']],
  ['template handleKey', /key === "f" \|\| key === "F"/, ['presenter.focus']],
  ['template handleKey', /if \(key === "Escape"\) \{ event\.preventDefault\(\); exitMode/, ['presenter.close']],
  ['template handleKey', /if \(key === "Home"\) \{ event\.preventDefault\(\); goTo\(0, 0\)|else if \(key === "Home"\)/, ['presenter.first']],
  ['template handleKey', /if \(key === "End"\) \{ event\.preventDefault\(\); goTo\(total - 1, 0\)|else if \(key === "End"\)/, ['presenter.last']],
  ['template handleKey', /isPresenter && key === "\+"/, ['presenter.font-larger']],
  ['template handleKey', /isPresenter && key === "-"/, ['presenter.font-smaller']],
  ['template handleKey', /key === "o" \|\| key === "O"/, ['presenter.overview']],
  ['template handleKey', /isPresenter && key === "[[\]]"/, ['presenter.preview-size']],
  ['template handleKey', /key === "t" \|\| key === "T"/, ['presenter.duration']],
  ['template handleKey', /key === "p" \|\| key === "P"/, ['presenter.timer']],
  ['template handleKey', /event\.key\.toLowerCase\(\) === 'i'/, ['presenter.pointer']],
  ['template handleKey', /event\.key === 'Escape' && pointerArmed/, ['presenter.close']],
  // The Pen (0.38 ticket 08): Esc abandons a drag or turns it off; D, W / ⇧W, X / ⇧X, ⌘Z while on.
  ['template handleKey', /event\.key === 'Escape' && penArmed/, ['presenter.close']],
  ['template handleKey', /event\.key\.toLowerCase\(\) === 'd'/, ['presenter.pen']],
  ['template handleKey', /event\.key\.toLowerCase\(\) === 'w'/, ['presenter.pen-tool']],
  ['template handleKey', /event\.key\.toLowerCase\(\) === 'x'/, ['presenter.ink-clear', 'presenter.ink-clear-all']],
  ['template handleKey', /penArmed && \(event\.metaKey \|\| event\.ctrlKey\).*event\.key\.toLowerCase\(\) === 'z'/, ['presenter.ink-undo']],
  ['template handleKey', /key === "h" \|\| key === "H"/, ['presenter.highlight']],
  ['template handleKey', /key === "m" \|\| key === "M"/, ['presenter.media']],
  ['template handleKey', /const offset = event\.key === "," \? -5 : event\.key === "\." \? 5 : undefined;/, ['presenter.video-back', 'presenter.video-forward']],
  ['template handleKey', /event\.key === "0" \|\| offset !== undefined\) && seekPresenterVideo\(offset\)/, ['presenter.video-restart']],
  ['template handleKey', /isPresenter && \(key === "z" \|\| key === "Z"\)/, ['presenter.gallery', 'presenter.embed-fullscreen']],
  ['template handleKey', /isPresenter && \(key === "v" \|\| key === "V"\)/, ['presenter.video-fullscreen']],
  ['template handleKey', /key === "s" \|\| key === "S"/, ['presenter.skip']],
  ['template handleKey', /key === "b" \|\| key === "B"/, ['presenter.return']],
  // Keys that are not the presenter's: C pins the deck's control bar, N steps a mode, Enter / Space
  // open a slide's QR code, all in the audience and plain deck windows only.
  ['template handleKey', /!isPresenter && /, []],
  ['template isTalkQrKey', /event\.key === "u" \|\| event\.key === "U"/, ['presenter.talk-qr']],
  ['template paste', /addEventListener\('paste'/, ['presenter.instant-paste']],
  ['template paletteKey', /key === ',' && paletteHighlight/, ['presenter.rebind']],
  ['template paletteKey', /key === 'Escape'/, ['picker.close']],
  ['template paletteKey', /key === 'ArrowDown' \|\| key === 'ArrowUp'/, ['picker.navigate']],
  ['template paletteKey', /key === 'Enter'/, ['picker.choose']],
  // Tab is held in the search field (no focus walk out of the open palette).
  ['template paletteKey', /key === 'Tab'/, ['picker.close']],
  // The short-recording question on the cluster: ↵ keeps, Esc discards.
  ['present-rec-ui', /e\.key === 'Enter'\) \{ e\.preventDefault\(\); e\.stopImmediatePropagation\(\); void controller\.confirmSave\(true\)/, ['picker.choose']],
  ['present-rec-ui', /e\.key === 'Escape'\) \{ e\.preventDefault\(\); e\.stopImmediatePropagation\(\); void controller\.confirmSave\(false\)/, ['picker.close']],
  ['present-rec-ui', /e\.key === 'L' \|\| e\.key === 'l'/, ['presenter.save-run-as']],
  ['present-rec-ui', /saveToast\.classList\.contains\('show'\) && e\.key === 'Enter'/, ['presenter.save-run']],
  ['present-rec-ui', /e\.key === 'R' \|\| e\.key === 'r'/, ['presenter.record']],
  ['present-rec-ui', /e\.key === 'M' \|\| e\.key === 'm'/, ['presenter.record-flag']],
  ['present-rec-ui', /e\.key === 'P' \|\| e\.key === 'p'/, ['presenter.record-pause']],
  ['present-live-bridge', /event\.key === 'Escape' && !panel\.hidden/, ['presenter.close']],
  ['present-live-bridge', /event\.key === 'g' \|\| event\.key === 'G'/, ['presenter.live']],
  ['present-edit-bridge', /e\.key !== 'e' && e\.key !== 'E'/, ['presenter.edit']],
  ['present-guide', /event\.key !== 'c' && event\.key !== 'C'/, ['presenter.guide']],
  // F5 opens the audience view; ⇧F5 refreshes (the routes themselves: deckWindowKeyTruth below).
  // The board panel: ⌘Z undoes the last board change while it shows; ⌥↵ picks up and drops; Esc
  // closes its menu, puts a held card down or leaves full screen; ↵ / Space on a card open its menu
  // (on a button they press it); in the board's own window Q opens or closes the board, as beside the slide.
  ['template board panel', /event\.key\.toLowerCase\(\) === 'z'/, ['presenter.board-undo']],
  ['template board panel', /event\.key === 'Enter'\) \{/, ['presenter.board-pick']],
  ['template board panel', /event\.key === 'Enter' \|\| event\.key === ' '/, ['picker.choose']],
  ['template board panel', /event\.key === 'q' \|\| event\.key === 'Q'/, ['presenter.poll-primary']],
  ['template board panel', /event\.key === 'Escape'/, ['presenter.close']],
  ['deck-window-keys', /input\.key === 'F5'/, ['presenter.audience', 'presenter.refresh']],
  ['deck-window-keys', /input\.key\.toLowerCase\(\) === 'r'/, ['presenter.refresh']]
]
const PRESENTER_ALLOWED_CLAIM_SCOPES = new Set(['presenter', 'picker'])
// A key set literal (the template's nextKeys / nextCodes …) names DOM key values and codes; the
// registry names codes. Space has three spellings, and the keypad's Enter is Enter.
const SET_KEY_SPELLING = { ' ': 'Space', Spacebar: 'Space', NumpadEnter: 'Enter' }
// Ticket 08: a presenter key set (nextKeys …) must list only keys its claimed entries list (Return
// advanced the slide unlisted), and a key bound only by a preload or the main process must name
// that preload in PRESENTER_KEY_NEEDS, so the ? sheet hides it where the preload is absent (G was
// listed in a presenter window opened without the live preload). `needs` turns the second check on.
function presenterKeyTruth(registry, regions, claims, { needs } = {}) {
  const problems = []
  const lines = []
  const boundIn = new Map()
  for (const [name, source, from, to, options] of regions) {
    const text = sourceRegion(source, from, to, options)
    if (text == null) { problems.push(`presenter key region "${name}" not found`); continue }
    text.split('\n').forEach((line, index) => { if (KEY_COMPARISON.test(line)) lines.push({ name, index, line: line.trim() }) })
  }
  const used = new Set()
  const bound = new Set()
  for (const hit of lines) {
    const matched = claims.filter(([region, pattern]) => region === hit.name && pattern.test(hit.line))
    if (!matched.length) { problems.push(`bound but not listed: ${hit.name}: ${hit.line.slice(0, 140)}`); continue }
    for (const claim of matched) {
      used.add(claim)
      if (claim[2].length === 0 && !/!isPresenter/.test(hit.line)) problems.push(`${hit.name}: a claim with no key must be guarded by !isPresenter: ${hit.line.slice(0, 140)}`)
      for (const id of claim[2]) {
        bound.add(id)
        if (!boundIn.has(id)) boundIn.set(id, new Set())
        boundIn.get(id).add(hit.name)
      }
    }
    const set = /new Set\(\[([^\]]*)\]\)/.exec(hit.line)
    if (set) {
      const ids = matched.flatMap((claim) => claim[2])
      const codes = new Set(ids.flatMap((id) => registry.find((item) => item.id === id)?.codes ?? []))
      for (const [, literal] of set[1].matchAll(/["']([^"']*)["']/g)) {
        const code = SET_KEY_SPELLING[literal] ?? literal
        if (!codes.has(code)) problems.push(`bound but not listed: ${hit.name}: key "${literal}" in ${hit.line.slice(0, 60)}… is not a key of ${ids.join(', ')}`)
      }
    }
  }
  for (const claim of claims) {
    if (!used.has(claim)) problems.push(`stale presenter key claim ${claim[0]} ${claim[1]} (no such binding)`)
    for (const id of claim[2]) {
      const entry = registry.find((item) => item.id === id)
      if (!entry) problems.push(`bound but not listed: ${claim[0]} ${claim[1]} → "${id}" is not in the registry`)
      else if (!PRESENTER_ALLOWED_CLAIM_SCOPES.has(entry.scope)) problems.push(`${claim[0]} ${claim[1]} → "${id}" is a ${entry.scope} key, not the presenter's`)
    }
  }
  for (const entry of registry.filter((item) => item.scope === 'presenter' && !item.unbound)) {
    if (!bound.has(entry.id)) problems.push(`listed but not bound: presenter key ${entry.keys} (${entry.id}, "${entry.label}") has no binding in the presenter`)
    const where = [...(boundIn.get(entry.id) ?? [])]
    if (needs && where.length && where.every((name) => !name.startsWith('template')) && !needs[entry.id]) {
      problems.push(`listed without its preload: presenter key ${entry.keys} (${entry.id}) is bound only in ${where.join(', ')}; name that preload in PRESENTER_KEY_NEEDS`)
    }
  }
  return { problems, lines }
}
// The main process's deck-window keys (src/main/deck-window-keys.ts), by what the module does
// rather than how it reads: every key it routes in a presenter window must be a key of the
// registry entry for that action (⇧F5 refreshed a presenter window unlisted until ticket 08).
const DECK_ACTION_IDS = { 'open-audience': 'presenter.audience', refresh: 'presenter.refresh' }
const DECK_PROBE_KEYS = [...Array.from({ length: 12 }, (_, i) => `F${i + 1}`), ...'abcdefghijklmnopqrstuvwxyz0123456789'.split(''),
  'Enter', 'Escape', 'Tab', 'Backspace', ' ', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']
function deckWindowKeyTruth(registry, action) {
  const problems = []
  let routed = 0
  for (const key of DECK_PROBE_KEYS) {
    for (let mods = 0; mods < 16; mods += 1) {
      const input = { type: 'keyDown', key, shift: Boolean(mods & 1), meta: Boolean(mods & 2), control: Boolean(mods & 4), alt: Boolean(mods & 8) }
      const result = action('presenter', input)
      if (!result) continue
      routed += 1
      const named = `${input.control ? '⌃' : ''}${input.alt ? '⌥' : ''}${input.shift ? '⇧' : ''}${input.meta ? '⌘' : ''}${key.length === 1 ? key.toUpperCase() : key}`
      const id = DECK_ACTION_IDS[result]
      const entry = id ? registry.find((item) => item.id === id) : null
      const event = { key: input.shift && key.length === 1 ? key.toUpperCase() : key, shiftKey: input.shift, metaKey: input.meta, ctrlKey: input.control, altKey: input.alt }
      if (!entry) problems.push(`bound but not listed: deck-window-keys routes ${named} in a presenter window to "${result}", which is no presenter key`)
      else if (!entry.codes.some((code) => shortcutEventMatches(event, id, code))) problems.push(`bound but not listed: deck-window-keys routes ${named} in a presenter window to "${result}", but ${id} lists only ${entry.keys}`)
    }
  }
  return { problems, routed }
}
// The checker itself: a listed key with no binding and a binding with no listed key both fail.
{
  const fakeRegistry = [
    { id: 'presenter.a', scope: 'presenter', keys: 'A', label: 'A' },
    { id: 'presenter.orphan', scope: 'presenter', keys: 'X', label: 'Listed, unbound' }
  ]
  const fakeSource = 'function handleKey(event) {\n  if (key === "a") a();\n  if (key === "z") z();\n  else if (isPresenter) return;'
  const { problems } = presenterKeyTruth(fakeRegistry, [['fake', fakeSource, 'function handleKey(event) {', 'else if (isPresenter) return;']], [['fake', /key === "a"/, ['presenter.a']]])
  assert(problems.some((p) => p.startsWith('listed but not bound: presenter key X')), 'the key-truth check fails on a listed key with no binding')
  assert(problems.some((p) => p.startsWith('bound but not listed: fake: if (key === "z")')), 'the key-truth check fails on a binding with no listed key')
  // A key set with a key its entry does not list (Return in nextKeys before ticket 08).
  const setSource = 'function handleKey(event) {\n  const nextKeys = new Set(["ArrowRight", " ", "Enter"]);\n  else if (isPresenter) return;'
  const setTruth = presenterKeyTruth([{ id: 'presenter.a', scope: 'presenter', keys: '→ Space', label: 'A', codes: ['ArrowRight', 'Space'] }], [['fake', setSource, 'function handleKey(event) {', 'else if (isPresenter) return;']], [['fake', /const nextKeys = /, ['presenter.a']]])
  assert.deepEqual(setTruth.problems.map((p) => p.replace(/ in .*? is/, ' is')), ['bound but not listed: fake: key "Enter" is not a key of presenter.a'], 'the key-truth check fails on a key in a key set that its entry does not list')
  // A key bound only by a preload, listed with no PRESENTER_KEY_NEEDS entry (G before ticket 08).
  const preloadSource = "window.addEventListener('keydown', (event) => {\n  if (event.key === 'g' || event.key === 'G') live()\n}, true)"
  const preloadRegion = ['preload', preloadSource, "window.addEventListener('keydown', (event) => {", '}, true)']
  const preloadRegistry = [{ id: 'presenter.live', scope: 'presenter', keys: 'G', label: 'Live', codes: ['g'] }]
  const preloadClaims = [['preload', /event\.key === 'g'/, ['presenter.live']]]
  assert(presenterKeyTruth(preloadRegistry, [preloadRegion], preloadClaims, { needs: {} }).problems.some((p) => p.startsWith('listed without its preload: presenter key G')), 'the key-truth check fails on a preload-only key the sheet would list without its preload')
  assert.deepEqual(presenterKeyTruth(preloadRegistry, [preloadRegion], preloadClaims, { needs: { 'presenter.live': '[data-live]' } }).problems, [], 'a preload-only key named in PRESENTER_KEY_NEEDS passes')
  // The deck-window module's ⇧F5 route, against a registry whose refresh lists only ⌘R.
  const staleRegistry = [
    { id: 'presenter.audience', scope: 'presenter', keys: 'F5', codes: ['F5'] },
    { id: 'presenter.refresh', scope: 'presenter', keys: '⌘R', codes: ['Mod-r'] }
  ]
  const stale = deckWindowKeyTruth(staleRegistry, deckWindowKeyAction)
  assert.deepEqual(stale.problems, ['bound but not listed: deck-window-keys routes ⇧F5 in a presenter window to "refresh", but presenter.refresh lists only ⌘R'], 'the key-truth check fails on the deck-window module\'s unlisted ⇧F5 route')
}
const truth = presenterKeyTruth(SHORTCUT_REGISTRY, PRESENTER_KEY_REGIONS, PRESENTER_KEY_CLAIMS, { needs: PRESENTER_KEY_NEEDS })
for (const problem of truth.problems) fail(problem)
if (truth.problems.length === 0) ok(`${truth.lines.length} presenter key bindings claimed; every presenter key in the registry is bound; preload-only keys name their preload`)
const deckTruth = deckWindowKeyTruth(SHORTCUT_REGISTRY, deckWindowKeyAction)
for (const problem of deckTruth.problems) fail(problem)
if (deckTruth.problems.length === 0) ok(`${deckTruth.routed} presenter-window key routes in the main process are all listed`)
// ── Slide picker and file list key truth (talk search 08) ────────────────────────────────────
// The ⌘S slide picker (its capture handler and the Find a talk box) and the file list (the Talks
// panel's key handler) bind exactly the keys the registry lists for them: every key comparison in
// those handlers is claimed by a registry id (or, with no id, carries the reason it binds nothing),
// every claim still matches a line, and every key the registry lists for the surface is claimed.
// A rebindable key is compared through surfaceKey(event, '<local id>'); its claim must name the
// registry id that local id stands for (src/renderer/src/keymap/surfaceKeys.ts).
console.log('Slide picker and file list key truth:')
const slideBrowserSource = readFileSync(join(root, 'src/renderer/src/components/slide-browser/useSlideBrowserKeys.ts'), 'utf8')
const findTalkSource = readFileSync(join(root, 'src/renderer/src/components/browser-rail/FindTalk.tsx'), 'utf8')
const talkPanelSource = readFileSync(join(root, 'src/renderer/src/components/talklist/useKeyboard.ts'), 'utf8')
const surfaceKeysSource = readFileSync(join(root, 'src/renderer/src/keymap/surfaceKeys.ts'), 'utf8')
const SURFACE_KEY_IDS = Object.fromEntries(
  [...(surfaceKeysSource.match(/export const SURFACE_KEYS = \{([\s\S]*?)\}/)?.[1] ?? '').matchAll(/'([^']+)':\s*'([^']+)'/g)]
    .map((match) => [match[1], match[2]])
)
assert.equal(Object.keys(SURFACE_KEY_IDS).length, 47, 'the rebindable structure, view, Slide navigation, presentation, talk-search and research keys are read from surfaceKeys.ts')
assert.equal(SURFACE_KEY_IDS['previous-slide'], 'app.previous-slide')
assert.equal(SURFACE_KEY_IDS['next-slide'], 'app.next-slide')
const SURFACE_KEY_COMPARISON = /\be\.key\s*[!=]==|\.includes\(e\.key\)|\.test\(e\.key\)|surfaceKey\(|findBoxOwnsKey\(e\.key/
const PICKER_REGIONS = [
  ['picker', slideBrowserSource, 'function handleKey(e: KeyboardEvent): void {', "window.addEventListener('keydown', handleKey, { capture: true })"],
  ['find box', findTalkSource, 'function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {', "if (e.key === 'Enter') choose(activeRow(), false)"]
]
const FILE_LIST_REGIONS = [
  ['file list', talkPanelSource, 'return function handlePanelKey(e: ReactKeyboardEvent<HTMLElement>): void {', '\n  }\n}']
]
// [region, line pattern, registry ids, reason when the ids are empty]
const PICKER_CLAIMS = [
  ['picker', /findBoxOwnsKey\(e\.key/, [], 'hands ↑↓ ↵ Esc to Find a talk while it lists talks (the find-box claims below)'],
  ['picker', /e\.key === 'Tab' && rootRef\.current/, ['slide-picker.tab']],
  ['picker', /e\.key === 'Escape' && el instanceof HTMLInputElement && el\.dataset\.railEsc === '1'/, [], 'hands Esc to a rail vocabulary input, which clears its own words first'],
  ['picker', /e\.key !== 'Escape' && besideOn && keyFree && surfaceKey\(e, 'close-beside'\)/, ['slide-picker.close-beside']],
  ['picker', /^if \(e\.key === 'Escape'\) \{$/, ['slide-picker.close', 'slide-picker.close-beside']],
  ['picker', /surfaceKey\(e, 'select-whole-section'\)/, ['slide-picker.select-whole-section']],
  ['picker', /surfaceKey\(e, 'talk-beside'\)/, ['slide-picker.talk-beside']],
  ['picker', /mod && !e\.shiftKey && e\.key === 'Enter'/, ['slide-picker.insert']],
  ['picker', /^if \(e\.key === 'ArrowDown' \|\| e\.key === 'ArrowUp' \|\| e\.key === 'ArrowLeft' \|\| e\.key === 'ArrowRight'\) \{$/, ['slide-picker.move', 'slide-picker.extend']],
  ['picker', /inField && \(e\.key === 'ArrowLeft' \|\| e\.key === 'ArrowRight'\)\) return/, [], '← → move the caret while typing'],
  ['picker', /e\.key === 'Backspace' && !mod && !e\.altKey/, ['slide-picker.clear-scope']],
  ['picker', /\['2', '3', '4', '5', '6'\]\.includes\(e\.key\)/, ['slide-picker.density']],
  ['picker', /e\.key === 'x' \|\| e\.key === 'X'/, ['slide-picker.toggle-selection']],
  ['picker', /e\.key === 's' \|\| e\.key === 'S'/, ['slide-picker.select-section']],
  ['picker', /e\.key === 't' \|\| e\.key === 'T'/, ['slide-picker.tags']],
  ['picker', /plain && e\.key === ' ' && onButton\) return/, [], 'Space on a focused button is that button’s click'],
  ['picker', /e\.key === ' ' \|\| e\.key === 'p' \|\| e\.key === 'P'/, ['slide-picker.preview']],
  ['picker', /e\.key === 'i' \|\| e\.key === 'I'/, ['slide-picker.rail']],
  ['picker', /e\.key === 'e' \|\| e\.key === 'E'/, ['slide-picker.versions']],
  ['picker', /e\.key === 'u' \|\| e\.key === 'U'/, ['slide-picker.near']],
  ['picker', /plain && e\.key === 'Enter'/, ['slide-picker.view']],
  ['find box', /e\.key === 'Backspace' && query === '' && props\.chips\.length > 0/, ['slide-picker.remove-chip']],
  ['find box', /surfaceKey\(e\.nativeEvent, 'add-beside'\)/, ['slide-picker.add-beside']],
  ['find box', /findBoxOwnsKey\(e\.key/, [], 'the keys below are the box’s only while it lists talks, completes or holds words'],
  ['find box', /e\.key === 'Escape'\) \{ onQueryChange\(''\)/, ['picker.close']],
  ['find box', /e\.key === 'Arrow(?:Down|Up)'\) \{ setActive/, ['picker.navigate']],
  ['find box', /e\.key === 'Enter'\) choose\(activeRow\(\), false\)/, ['picker.choose']]
]
const FILE_LIST_CLAIMS = [
  ['file list', /t\.tagName === 'BUTTON' && \(e\.key === 'Enter' \|\| e\.key === ' '\)\) return/, [], 'a focused toolbar button keeps its own ↵ and Space'],
  ['file list', /e\.key === 'v' \|\| e\.key === 'V'/, ['browser.talk-view']],
  ['file list', /e\.key === 'n' \|\| e\.key === 'N'/, ['browser.talk-names']],
  ['file list', /e\.key === 's' \|\| e\.key === 'S'/, ['browser.sort']],
  ['file list', /d\.sortPopOpen && \/\^\[1-5\]\$\/\.test\(e\.key\)/, ['browser.sort']],
  ['file list', /e\.key === 'm' \|\| e\.key === 'M'/, ['browser.move-talk']],
  ['file list', /e\.key === '\/'/, ['browser.filter']],
  ['file list', /^if \(e\.key === 'Escape'\) \{$/, ['browser.close']],
  ['file list', /^if \(e\.key === 'ArrowDown' \|\| e\.key === 'ArrowUp'\) \{$/, ['browser.move']],
  ['file list', /^const dir = e\.key === 'ArrowDown'/, ['browser.move']],
  ['file list', /^if \(e\.key === 'Arrow(?:Right|Left)'\) \{$/, ['browser.move']],
  ['file list', /^if \(e\.key === 'Enter'\) \{$/, ['browser.open']],
  ['file list', /e\.key === 'F2'/, ['browser.rename']],
  ['file list', /e\.key === 'o' \|\| e\.key === 'O'/, ['browser.open-talk']],
  ['file list', /e\.key === 'ArrowUp'\) \{ e\.preventDefault\(\); e\.stopPropagation\(\); d\.upOneLevel/, ['browser.up-level']],
  ['file list', /e\.key === 'Arrow(?:Left|Right)'\) \{ e\.preventDefault\(\); e\.stopPropagation\(\); d\.(?:collapse|expand)AllInView/, ['browser.fold-all']],
  ['file list', /e\.key === 'd' \|\| e\.key === 'D'/, ['browser.duplicate']],
  ['file list', /e\.key === 'Backspace'\) \{ e\.preventDefault\(\); d\.startDelete/, ['browser.delete-talk']]
]
function surfaceKeyTruth(registry, regions, claims, { owns, scopes }) {
  const problems = []
  const lines = []
  for (const [name, source, from, to] of regions) {
    const text = sourceRegion(source, from, to)
    if (text == null) { problems.push(`key region "${name}" not found`); continue }
    text.split('\n').forEach((line) => { if (SURFACE_KEY_COMPARISON.test(line)) lines.push({ name, line: line.trim() }) })
  }
  const used = new Set()
  const bound = new Set()
  for (const hit of lines) {
    const matched = claims.filter(([region, pattern]) => region === hit.name && pattern.test(hit.line))
    if (!matched.length) { problems.push(`bound but not listed: ${hit.name}: ${hit.line.slice(0, 140)}`); continue }
    const local = /surfaceKey\([^,]+,\s*'([^']+)'\)/.exec(hit.line)?.[1]
    for (const claim of matched) {
      used.add(claim)
      if (claim[2].length === 0 && !claim[3]) problems.push(`${hit.name}: a claim with no key must say why: ${hit.line.slice(0, 140)}`)
      if (local && !claim[2].includes(SURFACE_KEY_IDS[local])) problems.push(`${hit.name}: surfaceKey '${local}' is ${SURFACE_KEY_IDS[local] ?? 'no surface key'}, but the line is claimed for ${claim[2].join(', ')}`)
      for (const id of claim[2]) bound.add(id)
    }
  }
  for (const claim of claims) {
    if (!used.has(claim)) problems.push(`stale key claim ${claim[0]} ${claim[1]} (no such binding)`)
    for (const id of claim[2]) {
      const entry = registry.find((item) => item.id === id)
      if (!entry) problems.push(`bound but not listed: ${claim[0]} ${claim[1]} → "${id}" is not in the registry`)
      else if (!scopes.has(entry.scope)) problems.push(`${claim[0]} ${claim[1]} → "${id}" is a ${entry.scope} key, not this surface's`)
    }
  }
  for (const entry of registry.filter((item) => owns(item) && !item.unbound)) {
    if (!bound.has(entry.id)) problems.push(`listed but not bound: ${entry.keys} (${entry.id}, "${entry.label}") has no binding`)
  }
  return { problems, lines }
}
// The checker itself fails on a listed key with no binding, a binding with no listed key, and a
// rebindable key claimed for the wrong command.
{
  const fakeRegistry = [
    { id: 'slide-picker.a', scope: 'slide-picker', keys: 'A', label: 'A' },
    { id: 'slide-picker.orphan', scope: 'slide-picker', keys: 'W', label: 'Listed, unbound' },
    { id: 'slide-picker.talk-beside', scope: 'slide-picker', keys: 'O', label: 'Beside' }
  ]
  const fakeSource = "function handleKey(e: KeyboardEvent): void {\n  if (e.key === 'a') a()\n  if (e.key === 'z') z()\n  if (surfaceKey(e, 'talk-beside')) beside()\n  window.addEventListener('keydown', handleKey, { capture: true })"
  const fakeRegion = [['picker', fakeSource, 'function handleKey(e: KeyboardEvent): void {', "window.addEventListener('keydown', handleKey, { capture: true })"]]
  const owns = (entry) => entry.scope === 'slide-picker'
  const scopes = new Set(['slide-picker'])
  const { problems } = surfaceKeyTruth(fakeRegistry, fakeRegion, [['picker', /e\.key === 'a'/, ['slide-picker.a']], ['picker', /surfaceKey\(e, 'talk-beside'\)/, ['slide-picker.a']]], { owns, scopes })
  assert(problems.some((p) => p.startsWith('listed but not bound: W (slide-picker.orphan')), 'the picker key-truth check fails on a listed key with no binding')
  assert(problems.some((p) => p.startsWith("bound but not listed: picker: if (e.key === 'z')")), 'the picker key-truth check fails on a binding with no listed key')
  assert(problems.some((p) => p.startsWith("picker: surfaceKey 'talk-beside' is slide-picker.talk-beside, but the line is claimed for slide-picker.a")), 'the picker key-truth check fails on a rebindable key claimed for the wrong command')
}
const pickerTruth = surfaceKeyTruth(SHORTCUT_REGISTRY, PICKER_REGIONS, PICKER_CLAIMS, {
  owns: (entry) => entry.scope === 'slide-picker',
  scopes: new Set(['slide-picker', 'picker'])
})
for (const problem of pickerTruth.problems) fail(problem)
if (pickerTruth.problems.length === 0) ok(`${pickerTruth.lines.length} slide picker key bindings claimed; every slide picker key in the registry is bound`)
const fileListTruth = surfaceKeyTruth(SHORTCUT_REGISTRY, FILE_LIST_REGIONS, FILE_LIST_CLAIMS, {
  owns: (entry) => entry.scope === 'browser' && entry.group === 'Talks panel',
  scopes: new Set(['browser'])
})
for (const problem of fileListTruth.problems) fail(problem)
if (fileListTruth.problems.length === 0) ok(`${fileListTruth.lines.length} file list key bindings claimed; every Talks panel key in the registry is bound`)

if (failures > 0) {
  console.error(`\ntest-presenter-key-truth: ${failures} failure(s).`)
  process.exit(1)
}
console.log('\ntest-presenter-key-truth: all checks passed.')
