// Deck window key routing (src/main/deck-window-keys.ts): which keys the main process takes from a
// presenter, audience or plain presentation window before the page and the application menu.
// 0.34.0-preview.3 check: "pressing F5 in presenter view does not open Audience view". Since
// 2026-07-08 (28ed6ca) the deck window's before-input-event refreshed on F5 in every deck window,
// so the presenter page's F5 (presenter.audience) never ran.
// Usage: node scripts/test-deck-window-keys.mjs
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const { deckWindowKeyAction, deckWindowMode, OPEN_AUDIENCE_SCRIPT } = await import(
  new URL('../src/main/deck-window-keys.ts', import.meta.url)
)
const { SHORTCUT_REGISTRY } = await import(new URL('../src/shared/shortcut-registry.ts', import.meta.url))

const key = (k, mods = {}) => ({ type: 'keyDown', key: k, shift: false, meta: false, control: false, alt: false, ...mods })

// ── F5 in the presenter opens the audience view; everything else keeps the refresh.
assert.equal(deckWindowKeyAction('presenter', key('F5')), 'open-audience', 'F5 in a presenter window opens the audience view')
assert.equal(deckWindowKeyAction('presenter', key('F5', { shift: true })), 'refresh', '⇧F5 in a presenter window refreshes it in place')
assert.equal(deckWindowKeyAction('audience', key('F5')), 'refresh', 'F5 in the audience window refreshes it in place')
assert.equal(deckWindowKeyAction('window', key('F5')), 'refresh', 'F5 in a plain presentation window refreshes it in place')
assert.equal(deckWindowKeyAction('window', key('F5', { shift: true })), 'refresh', '⇧F5 in a plain presentation window refreshes it in place')
for (const mode of ['presenter', 'audience', 'window']) {
  assert.equal(deckWindowKeyAction(mode, key('r', { meta: true })), 'refresh', `⌘R refreshes the ${mode} window`)
  assert.equal(deckWindowKeyAction(mode, key('R', { control: true })), 'refresh', `⌃R refreshes the ${mode} window`)
  assert.equal(deckWindowKeyAction(mode, key('r', { meta: true, shift: true })), null, `⌘⇧R is left to the page in the ${mode} window`)
  assert.equal(deckWindowKeyAction(mode, key('F5', { meta: true })), null, `⌘F5 is left alone in the ${mode} window`)
  assert.equal(deckWindowKeyAction(mode, key('F5', { alt: true })), null, `⌥F5 is left alone in the ${mode} window`)
  assert.equal(deckWindowKeyAction(mode, { ...key('F5'), type: 'keyUp' }), null, `F5 key-up does nothing in the ${mode} window`)
  assert.equal(deckWindowKeyAction(mode, key('j')), null, `J goes to the page in the ${mode} window`)
  assert.equal(deckWindowKeyAction(mode, key('r')), null, `R (reveal) goes to the page in the ${mode} window`)
}

// The present handler's mode strings.
assert.equal(deckWindowMode('presenter'), 'presenter')
assert.equal(deckWindowMode('audience'), 'audience')
assert.equal(deckWindowMode('window'), 'window')
assert.equal(deckWindowMode(undefined), 'window')

// The action is the presenter's Audience button, so F5 and the button cannot drift apart.
assert.match(OPEN_AUDIENCE_SCRIPT, /getElementById\("presenterAudienceApp"\)\?\.click\(\)/, 'F5 clicks the presenter Audience button')
const template = readFileSync(new URL('../compiler/assets/templates/presenter-popup-single-html.html', import.meta.url), 'utf8')
assert.match(template, /id="presenterAudienceApp"/, 'the presenter template has the Audience button')
assert.match(template, /els\.presenterAudienceApp\.addEventListener\("click", openAudienceChromeless\)/, 'the Audience button opens the audience view')

// ── The registry says the same: presenter F5 = audience; editor F5 / ⇧F5 = present.
const entry = (id) => SHORTCUT_REGISTRY.find((e) => e.id === id)
assert.deepEqual(entry('presenter.audience')?.codes, ['F5'], 'the registry binds F5 in the presenter to Launch audience')
assert.deepEqual(entry('app.present')?.codes, ['F5'], 'the registry binds F5 in the editor to Present from the top')
assert.deepEqual(entry('app.present-current')?.codes, ['Shift-F5'], 'the registry binds ⇧F5 in the editor to Present from current slide')
assert.deepEqual(entry('presenter.refresh')?.codes, ['Mod-r', 'Shift-F5'], 'the registry binds ⌘R, and ⇧F5 in a presenter window, to Refresh with latest edits')

// ── The deck window's before-input-event routes through this module, with no inline F5 rule left.
const main = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
const handler = /win\.webContents\.on\('before-input-event', \(event, input\) => \{([\s\S]*?)\n    \}\)/.exec(main)
assert.ok(handler, 'the deck window has a before-input-event handler')
assert.match(handler[1], /deckWindowKeyAction\(deckWindowMode\(mode\), input\)/, 'the deck window asks deckWindowKeyAction with its mode')
assert.match(handler[1], /executeJavaScript\(OPEN_AUDIENCE_SCRIPT, true\)/, 'open-audience runs the Audience button with a user gesture')
assert.doesNotMatch(main, /input\.key === 'F5'/, 'no inline F5 rule in the main process bypasses deckWindowKeyAction')

console.log('deck window keys: presenter F5 opens the audience view; ⇧F5, audience/plain F5 and ⌘R refresh; registry agrees')
