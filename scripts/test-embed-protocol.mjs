// test:embed-protocol — embedded pages run in a sandbox (0.38 ticket 11.1; design test matrix
// row 10 and the constants half of row 1).
//
//   1. The constants: the sandbox token lists, the permission lists, every protocol limit.
//   2. Validation: a table of valid messages per kind, and what is refused.
//   3. Building messages and event descriptions.
//   4. The rate limiter and the key rule.
//   5. Element addresses on a fixture tree: round trip, and the id → path → point fallback.
//   6. Scroll fractions; sensitive, text and field classification.
//   7. The inlined source (what a compiled page runs) behaves as the module does.
//   8. The document lead.
// The agent in a real sandboxed frame is scripts/embed-agent-dom.test.mjs; the deck side is
// scripts/test-embed-channel.mjs.
import assert from 'node:assert/strict'
import vm from 'node:vm'
import * as protocol from '../compiler/assets/runtime/embed-protocol.js'
import { embedAgentSource } from '../compiler/assets/runtime/embed-agent.js'
import { embedChannelSource } from '../compiler/assets/runtime/embed-channel.js'
import {
  EMBED_SANDBOX_LOCAL, EMBED_SANDBOX_REMOTE, EMBED_ALLOW_LOCAL, EMBED_ALLOW_REMOTE, EMBED_REFERRER_META, EMBED_BASE_TAG,
  embedSandboxValue, embedFrameAttributes, embedDocumentLead, withEmbedLead, embedHasOwnBase, embedLeadPosition, embedPageTitle
} from '../compiler/scripts/lib/embed-frame.mjs'

const {
  embedLimits, embedValidateMessage, embedBuildMessage, embedEventDescription, embedMessageFromDescription,
  embedAcceptsFromFrame, embedSendsToFrame, embedRoleForWindow, embedKeyDecision, embedCreateLimiter, embedLimiterTake,
  embedLimiterDrop, embedTokenFromBytes, embedIsToken, embedDescribeElement, embedResolveElement, embedScrollFractions,
  embedApplyScroll, embedIsSensitiveField, embedIsTextField, embedKeepsKeys, embedFieldState, embedProtocolSource
} = protocol

// ── 1. Constants ──────────────────────────────────────────────────────────────────────────────
assert.deepEqual([...EMBED_SANDBOX_LOCAL], ['allow-scripts', 'allow-forms'], 'a local page: exactly these two tokens')
assert.equal(EMBED_SANDBOX_LOCAL.includes('allow-same-origin'), false, 'allow-same-origin is never in the local-page list')
assert.ok(Object.isFrozen(EMBED_SANDBOX_LOCAL) && Object.isFrozen(EMBED_SANDBOX_REMOTE), 'the token lists cannot be changed at run time')
assert.deepEqual([...EMBED_SANDBOX_REMOTE], ['allow-scripts', 'allow-same-origin', 'allow-forms', 'allow-presentation'])
for (const refused of ['allow-top-navigation', 'allow-top-navigation-by-user-activation', 'allow-top-navigation-to-custom-protocols', 'allow-modals', 'allow-downloads', 'allow-pointer-lock', 'allow-popups', 'allow-popups-to-escape-sandbox']) {
  assert.equal(EMBED_SANDBOX_LOCAL.includes(refused), false, `local: no ${refused}`)
  assert.equal(EMBED_SANDBOX_REMOTE.includes(refused), false, `remote: no ${refused}`)
}
assert.equal(EMBED_ALLOW_LOCAL, 'autoplay; fullscreen')
assert.equal(EMBED_ALLOW_REMOTE, 'autoplay; encrypted-media; picture-in-picture; fullscreen')
assert.equal(embedSandboxValue('local'), 'allow-scripts allow-forms')
assert.equal(embedSandboxValue('remote'), 'allow-scripts allow-same-origin allow-forms allow-presentation')
assert.throws(() => embedSandboxValue('other'), /unknown embed kind/)
assert.equal(embedFrameAttributes('local'), ' sandbox="allow-scripts allow-forms" credentialless referrerpolicy="no-referrer" allow="autoplay; fullscreen" allowfullscreen scrolling="no"')
assert.equal(embedFrameAttributes('remote'), ' sandbox="allow-scripts allow-same-origin allow-forms allow-presentation" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen')
assert.throws(() => embedFrameAttributes('other'), /unknown embed kind/)

const L = embedLimits()
assert.ok(Object.isFrozen(L) && Object.isFrozen(L.navKeys) && Object.isFrozen(L.forwardKeys) && Object.isFrozen(L.eventKinds) && Object.isFrozen(L.roles))
assert.deepEqual({ ...L, navKeys: [...L.navKeys], forwardKeys: [...L.forwardKeys], eventKinds: [...L.eventKinds], roles: [...L.roles] }, {
  tag: 'embed', version: 1, tokenBytes: 16, tokenLength: 32,
  valueMax: 4096, keyMax: 32, codeMax: 32, idMax: 128, tagMax: 32, pathMax: 64, pathIndexMax: 65535, fractionSlack: 1e-6,
  ratePerSecond: 60, rateBurst: 120, dropLimit: 2000, dropWindowMs: 10000,
  scrollCoalesceMs: 50, scrollPendingMax: 32, scrollReplaceAllowance: 64,
  keyRateMax: 5, keyRateWindowMs: 1000, helloMax: 8,
  navKeys: ['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', ' '],
  forwardKeys: ['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', ' ', 'Escape'],
  eventKinds: ['click', 'input', 'change', 'keydown', 'scroll'],
  roles: ['capture', 'replay', 'none']
}, 'every limit and list, exactly')

// ── 2. Validation ─────────────────────────────────────────────────────────────────────────────
const T = '0123456789abcdef0123456789abcdef'
const env = (k, fields = {}) => ({ tw: 'embed', v: 1, t: T, k, ...fields })
const button = { path: [1, 0, 2], tag: 'button' }
const withId = { path: [1, 3], tag: 'input', id: 'name' }
const valid = [
  ['ready', { tw: 'embed', v: 1, k: 'ready' }],
  ['hello capture', env('hello', { role: 'capture' })],
  ['hello replay', env('hello', { role: 'replay' })],
  ['hello none', env('hello', { role: 'none' })],
  ...L.forwardKeys.map((key) => [`key ${JSON.stringify(key)}`, env('key', { key })]),
  ['click by path', env('click', { el: button })],
  ['click with id and point', env('click', { el: { path: [0], tag: 'a', id: 'next', px: 0.25, py: 1 } })],
  ['click on the document element', env('click', { el: { path: [], tag: 'html' } })],
  ['click in an svg', env('click', { el: { path: [1, 0, 0], tag: 'foreignObject' } })],
  ['input value', env('input', { el: withId, value: 'hello' })],
  ['input empty value', env('input', { el: withId, value: '' })],
  ['input value at the limit', env('input', { el: withId, value: 'x'.repeat(4096) })],
  ['input checked', env('input', { el: withId, checked: true })],
  ['change value', env('change', { el: { path: [1, 4], tag: 'select' }, value: 'b' })],
  ['change checked', env('change', { el: withId, checked: false })],
  ['keydown', env('keydown', { el: button, key: 'Enter', code: 'Enter' })],
  ['keydown with no code', env('keydown', { el: button, key: 'a', code: '' })],
  ['scroll of the document', env('scroll', { el: { path: [], tag: '' }, fx: 0, fy: 0.5 })],
  ['scroll of an element', env('scroll', { el: { path: [1, 2], tag: 'div', id: 'panel' }, fx: 1, fy: 0 })],
  ['a path at both bounds', env('click', { el: { path: Array.from({ length: 64 }, () => 65535), tag: 'p' } })]
]
/** True when no object inside `a` is also inside `b`. */
function sharesNothing(a, b) {
  const seen = new Set()
  const walk = (value) => { if (value && typeof value === 'object') { seen.add(value); Object.values(value).forEach(walk) } }
  walk(b)
  let shared = false
  const check = (value) => { if (value && typeof value === 'object') { if (seen.has(value)) shared = true; Object.values(value).forEach(check) } }
  check(a)
  return !shared
}
for (const [name, message] of valid) {
  const out = embedValidateMessage(message)
  assert.deepEqual(out, message, `valid: ${name}`)
  assert.notEqual(out, message, `${name}: the result is a new object`)
  assert.ok(sharesNothing(out, message), `${name}: the result shares no object with the input`)
  assert.equal(Object.getPrototypeOf(out), Object.prototype)
  // A null-prototype object is plain too (what structured clone never makes, but harmless).
  assert.deepEqual(embedValidateMessage(Object.assign(Object.create(null), message)), message, `${name}: null-prototype input`)
}
// A fraction a rounding error outside 0..1 is clamped, not carried.
assert.deepEqual(embedValidateMessage(env('scroll', { el: { path: [], tag: '' }, fx: -1e-9, fy: 1 + 1e-9 })), env('scroll', { el: { path: [], tag: '' }, fx: 0, fy: 1 }))

class Thing { constructor(fields) { Object.assign(this, fields) } }
const cyclic = env('click'); cyclic.el = { path: [0], tag: 'p' }; cyclic.el.path.push(cyclic.el.path)
const selfRef = env('click'); selfRef.el = selfRef
const throwingGetter = { tw: 'embed', v: 1, t: T, k: 'click' }
Object.defineProperty(throwingGetter, 'el', { enumerable: true, get() { throw new Error('boom') } })
let getterRan = false
const quietGetter = { tw: 'embed', v: 1, t: T, k: 'click' }
Object.defineProperty(quietGetter, 'el', { enumerable: true, get() { getterRan = true; return button } })
const sparse = []; sparse[2] = 1
const pathWithExtra = [0, 1]; pathWithExtra.extra = 1
class FakeArray extends Array {}
const hidden = env('click', { el: button }); Object.defineProperty(hidden, 'extra', { enumerable: false, value: 1 })
const symbolKey = env('click', { el: button }); symbolKey[Symbol('x')] = 1
const protoKey = JSON.parse(`{"tw":"embed","v":1,"t":"${T}","k":"click","el":{"path":[0],"tag":"p"},"__proto__":{"polluted":true}}`)
const elProtoKey = JSON.parse(`{"tw":"embed","v":1,"t":"${T}","k":"click","el":{"path":[0],"tag":"p","__proto__":{"polluted":true}}}`)
const invalid = [
  ['null', null], ['undefined', undefined], ['a string', 'embed'], ['a number', 1], ['a function', () => {}],
  ['a video player command string', '{"event":"command","func":"playVideo","args":""}'],
  ['an array', ['embed']], ['an array of a message', [env('click', { el: button })]],
  ['a class instance', new Thing(env('click', { el: button }))],
  ['a Map', new Map(Object.entries(env('click', { el: button })))],
  ['a Proxy over a valid message', new Proxy(env('click', { el: button }), {})],
  ['a Proxy as el', env('click', { el: new Proxy({ path: [0], tag: 'p' }, {}) })],
  ['a Proxy as path', env('click', { el: { path: new Proxy([0], {}), tag: 'p' } })],
  ['a class instance as el', env('click', { el: new Thing(button) })],
  ['a subclassed array as path', env('click', { el: { path: FakeArray.from([0]), tag: 'p' } })],
  ['an empty object', {}],
  ['a wrong tw', { ...env('click', { el: button }), tw: 'other' }],
  ['a wrong version', { ...env('click', { el: button }), v: 2 }],
  ['a version as a string', { ...env('click', { el: button }), v: '1' }],
  ['no kind', { tw: 'embed', v: 1, t: T }],
  ['an unknown kind', env('snapshot', { el: button })],
  ['kind "constructor"', env('constructor')], ['kind "__proto__"', env('__proto__')], ['kind "toString"', env('toString')],
  ['a kind that is not a string', env(1)],
  ['ready with a token', env('ready')],
  ['ready with an extra key', { tw: 'embed', v: 1, k: 'ready', slide: 3 }],
  ['an extra key', env('click', { el: button, slide: 2 })],
  ['an extra key naming an embed', env('click', { el: button, embedIndex: 1 })],
  ['a field of another kind', env('click', { el: button, value: 'x' })],
  ['an extra key set to undefined', env('click', { el: button, value: undefined })],
  ['a non-enumerable extra key', hidden],
  ['a symbol key', symbolKey],
  ['an own "__proto__" key', protoKey],
  ['an own "__proto__" key in el', elProtoKey],
  ['a "constructor" key', env('click', { el: button, constructor: {} })],
  ['a "constructor" key in el', env('click', { el: { ...button, constructor: {} } })],
  ['a getter that throws', throwingGetter],
  ['a getter that answers', quietGetter],
  ['a cyclic path', cyclic],
  ['el that is the message', selfRef],
  ['no token', { tw: 'embed', v: 1, k: 'click', el: button }],
  ['a short token', { ...env('click', { el: button }), t: T.slice(1) }],
  ['a long token', { ...env('click', { el: button }), t: `${T}0` }],
  ['an upper-case token', { ...env('click', { el: button }), t: T.toUpperCase() }],
  ['a token with another character', { ...env('click', { el: button }), t: `${T.slice(0, 31)}g` }],
  ['a token that is not a string', { ...env('click', { el: button }), t: 1 }],
  ['hello without a role', env('hello')],
  ['hello with an unknown role', env('hello', { role: 'admin' })],
  ['key outside the list', env('key', { key: 'Enter' })],
  ['key with a modifier field', env('key', { key: 'ArrowRight', ctrlKey: true })],
  ['key that is a letter', env('key', { key: 'a' })],
  ['key that is not a string', env('key', { key: 39 })],
  ['key "constructor"', env('key', { key: 'constructor' })],
  ['click without el', env('click')],
  ['el that is a string', env('click', { el: 'button' })],
  ['el that is an array', env('click', { el: [0] })],
  ['el without a path', env('click', { el: { tag: 'p' } })],
  ['el without a tag', env('click', { el: { path: [0] } })],
  ['el with an extra key', env('click', { el: { ...button, html: '<p>' } })],
  ['a path that is a string', env('click', { el: { path: '0.1', tag: 'p' } })],
  ['a path that is an array-like object', env('click', { el: { path: { 0: 1, length: 1 }, tag: 'p' } })],
  ['a path of 65 entries', env('click', { el: { path: Array.from({ length: 65 }, () => 0), tag: 'p' } })],
  ['a path of 100,000 entries', env('click', { el: { path: Array.from({ length: 100000 }, () => 0), tag: 'p' } })],
  ['a path entry of 65536', env('click', { el: { path: [65536], tag: 'p' } })],
  ['a negative path entry', env('click', { el: { path: [-1], tag: 'p' } })],
  ['a fractional path entry', env('click', { el: { path: [0.5], tag: 'p' } })],
  ['a NaN path entry', env('click', { el: { path: [NaN], tag: 'p' } })],
  ['an infinite path entry', env('click', { el: { path: [Infinity], tag: 'p' } })],
  ['a string path entry', env('click', { el: { path: ['0'], tag: 'p' } })],
  ['a nested path', env('click', { el: { path: [[0]], tag: 'p' } })],
  ['a sparse path', env('click', { el: { path: sparse, tag: 'p' } })],
  ['a path with a named property', env('click', { el: { path: pathWithExtra, tag: 'p' } })],
  ['a tag of 33 characters', env('click', { el: { path: [0], tag: 'a'.repeat(33) } })],
  ['a tag with markup in it', env('click', { el: { path: [0], tag: 'p><script' } })],
  ['a tag that is not a string', env('click', { el: { path: [0], tag: 1 } })],
  ['an empty tag on a click', env('click', { el: { path: [], tag: '' } })],
  ['an empty tag on a keydown', env('keydown', { el: { path: [], tag: '' }, key: 'a', code: 'KeyA' })],
  ['an empty tag with a path', env('scroll', { el: { path: [0], tag: '' }, fx: 0, fy: 0 })],
  ['an empty tag with an id', env('scroll', { el: { path: [], tag: '', id: 'x' }, fx: 0, fy: 0 })],
  ['an id of 129 characters', env('click', { el: { ...button, id: 'i'.repeat(129) } })],
  ['an empty id', env('click', { el: { ...button, id: '' } })],
  ['an id that is a number', env('click', { el: { ...button, id: 7 } })],
  ['an id with a control character', env('click', { el: { ...button, id: 'a\nb' } })],
  ['px without py', env('click', { el: { ...button, px: 0.5 } })],
  ['px out of range', env('click', { el: { ...button, px: 1.5, py: 0.5 } })],
  ['py not finite', env('click', { el: { ...button, px: 0.5, py: Infinity } })],
  ['px as a string', env('click', { el: { ...button, px: '0.5', py: 0.5 } })],
  ['a point on an input', env('input', { el: { ...withId, px: 0.5, py: 0.5 }, value: 'x' })],
  ['a point on a scroll', env('scroll', { el: { path: [1], tag: 'div', px: 0.5, py: 0.5 }, fx: 0, fy: 0 })],
  ['input with neither value nor checked', env('input', { el: withId })],
  ['input with both value and checked', env('input', { el: withId, value: 'x', checked: true })],
  ['a value of 4,097 characters', env('input', { el: withId, value: 'x'.repeat(4097) })],
  ['a value of a megabyte', env('change', { el: withId, value: 'x'.repeat(1 << 20) })],
  ['a value that is a number', env('input', { el: withId, value: 5 })],
  ['a value that is an object', env('input', { el: withId, value: { toString: () => 'x' } })],
  ['checked that is a string', env('change', { el: withId, checked: 'true' })],
  ['checked that is a number', env('change', { el: withId, checked: 1 })],
  ['keydown without a key', env('keydown', { el: button, code: 'KeyA' })],
  ['keydown without a code', env('keydown', { el: button, key: 'a' })],
  ['keydown with an empty key', env('keydown', { el: button, key: '', code: 'KeyA' })],
  ['a key of 33 characters', env('keydown', { el: button, key: 'k'.repeat(33), code: 'KeyA' })],
  ['a code of 33 characters', env('keydown', { el: button, key: 'a', code: 'c'.repeat(33) })],
  ['keydown with a modifier field', env('keydown', { el: button, key: 'a', code: 'KeyA', metaKey: true })],
  ['scroll without fy', env('scroll', { el: { path: [], tag: '' }, fx: 0 })],
  ['scroll with pixels', env('scroll', { el: { path: [], tag: '' }, scrollTop: 10, scrollLeft: 0 })],
  ['a NaN fraction', env('scroll', { el: { path: [], tag: '' }, fx: NaN, fy: 0 })],
  ['an infinite fraction', env('scroll', { el: { path: [], tag: '' }, fx: 0, fy: Infinity })],
  ['a negative infinite fraction', env('scroll', { el: { path: [], tag: '' }, fx: -Infinity, fy: 0 })],
  ['a fraction above 1', env('scroll', { el: { path: [], tag: '' }, fx: 0, fy: 1.01 })],
  ['a fraction below 0', env('scroll', { el: { path: [], tag: '' }, fx: -0.01, fy: 0 })],
  ['a fraction as a string', env('scroll', { el: { path: [], tag: '' }, fx: '0', fy: 0 })],
  ['a fraction as a BigInt', env('scroll', { el: { path: [], tag: '' }, fx: 0n, fy: 0 })]
]
for (const [name, message] of invalid) assert.equal(embedValidateMessage(message), null, `refused: ${name}`)
assert.equal(getterRan, false, 'an accessor property is refused without being run')
assert.equal({}.polluted, undefined, 'nothing reached Object.prototype')
// A Proxy that throws from every trap is refused, not thrown onwards.
const angry = new Proxy({}, { getPrototypeOf() { throw new Error('no') }, ownKeys() { throw new Error('no') }, getOwnPropertyDescriptor() { throw new Error('no') } })
assert.equal(embedValidateMessage(angry), null)
// A Proxy that answers differently each time it is asked is read once, then refused.
let asked = 0
const shifty = new Proxy(env('input', { el: withId, value: 'ok' }), { getOwnPropertyDescriptor(target, key) { asked += 1; return Reflect.getOwnPropertyDescriptor(target, key) } })
assert.equal(embedValidateMessage(shifty), null)
assert.ok(asked > 0)

// ── 3. Building ───────────────────────────────────────────────────────────────────────────────
assert.deepEqual(embedBuildMessage('ready', '', null), { tw: 'embed', v: 1, k: 'ready' })
assert.deepEqual(embedBuildMessage('ready', T, { anything: 1 }), { tw: 'embed', v: 1, k: 'ready' }, 'ready never carries the token')
assert.deepEqual(embedBuildMessage('hello', T, { role: 'replay' }), env('hello', { role: 'replay' }))
assert.deepEqual(embedBuildMessage('click', T, { el: button, slide: 9 }), env('click', { el: button }), 'only the fields of the kind are taken')
assert.equal(embedBuildMessage('click', '', { el: button }), null, 'no token yet: nothing to send')
assert.equal(embedBuildMessage('input', T, { el: withId, value: 'x'.repeat(4097) }), null, 'an over-long value is not sent, and not cut')
assert.equal(embedBuildMessage('nothing', T, {}), null)
for (const [name, message] of valid) {
  const description = embedEventDescription(message)
  if (!L.eventKinds.includes(message.k)) { assert.equal(description, null, `${name}: not an event`); continue }
  assert.equal('t' in description || 'tw' in description || 'v' in description, false, `${name}: a description carries no token`)
  assert.deepEqual(embedMessageFromDescription(T, description), message, `${name}: description and back`)
  assert.deepEqual(embedMessageFromDescription(T, JSON.parse(JSON.stringify(description))), message, `${name}: across a channel`)
}
assert.equal(embedMessageFromDescription(T, { k: 'hello', role: 'capture' }), null, 'only events are delivered')
assert.equal(embedMessageFromDescription(T, { k: 'key', key: 'ArrowRight' }), null)
assert.equal(embedMessageFromDescription(T, { k: 'click', el: button, t: 'f'.repeat(32) }), null, 'a description cannot bring its own token')
assert.equal(embedMessageFromDescription(T, { k: 'click', el: button, index: 2 }), null)
assert.equal(embedMessageFromDescription(T, null), null)
assert.equal(embedMessageFromDescription(T, new Proxy({ k: 'click', el: button }, {})), null)
assert.equal(embedMessageFromDescription('nope', { k: 'click', el: button }), null)

assert.equal(embedTokenFromBytes(new Uint8Array(16)), '0'.repeat(32))
assert.equal(embedTokenFromBytes(Uint8Array.from({ length: 16 }, (_, i) => i * 17)), '00112233445566778899aabbccddeeff')
assert.ok(embedIsToken(embedTokenFromBytes(crypto.getRandomValues(new Uint8Array(16)))))
assert.throws(() => embedTokenFromBytes(new Uint8Array(8)), /16 random bytes/)
assert.throws(() => embedTokenFromBytes(null), /16 random bytes/)
assert.throws(() => embedTokenFromBytes(Array.from({ length: 16 }, () => 0.5)), /must be bytes/)

for (const kind of ['click', 'input', 'change', 'keydown', 'scroll']) {
  assert.equal(embedAcceptsFromFrame('capture', kind), true)
  assert.equal(embedAcceptsFromFrame('replay', kind), false, `the projector accepts no ${kind} from its frame`)
  assert.equal(embedAcceptsFromFrame('none', kind), false)
  assert.equal(embedSendsToFrame('replay', kind), true)
  assert.equal(embedSendsToFrame('capture', kind), false)
  assert.equal(embedSendsToFrame('none', kind), false)
}
for (const role of L.roles) {
  assert.equal(embedAcceptsFromFrame(role, 'ready'), true)
  assert.equal(embedAcceptsFromFrame(role, 'key'), true)
  assert.equal(embedAcceptsFromFrame(role, 'hello'), false, 'a frame never says hello')
  assert.equal(embedSendsToFrame(role, 'hello'), true)
  assert.equal(embedSendsToFrame(role, 'key'), false)
}
assert.deepEqual(['presenter', 'projector', 'deck', 'share', undefined].map(embedRoleForWindow), ['capture', 'replay', 'none', 'none', 'none'])

// ── 4. The rate limiter and the key rule ──────────────────────────────────────────────────────
{
  const limiter = embedCreateLimiter(0)
  let passed = 0
  for (let i = 0; i < 500; i += 1) if (embedLimiterTake(limiter, 0)) passed += 1
  assert.equal(passed, 120, 'a burst of 120, then nothing in the same instant')
  passed = 0
  for (let i = 0; i < 500; i += 1) if (embedLimiterTake(limiter, 1000)) passed += 1
  assert.equal(passed, 60, 'one second later: 60 more')
  assert.equal(embedLimiterTake(limiter, 999), false, 'a clock that runs backwards refills nothing')
  assert.equal(limiter.stopped, false, '881 drops so far')
  passed = 0
  for (let i = 0; i < 500; i += 1) if (embedLimiterTake(limiter, 60000)) passed += 1
  assert.equal(passed, 120, 'a long pause refills to the burst, not beyond')
}
{
  // Sustained: 100 a second for 5 seconds. 120 + 60 × 5 pass; the 80 dropped are far below the cut-off.
  const limiter = embedCreateLimiter(0)
  let passed = 0
  for (let ms = 0; ms < 5000; ms += 10) if (embedLimiterTake(limiter, ms)) passed += 1
  assert.ok(passed >= 418 && passed <= 421, `sustained rate: ${passed}`)
  assert.equal(limiter.stopped, false)
}
{
  // The flood threshold: the 2,000th drop within ten seconds stops the limiter for good.
  const limiter = embedCreateLimiter(0)
  for (let i = 0; i < 120; i += 1) embedLimiterTake(limiter, 0)
  for (let i = 0; i < 1999; i += 1) embedLimiterTake(limiter, 0)
  assert.equal(limiter.stopped, false, '1,999 drops: still running')
  assert.equal(embedLimiterTake(limiter, 0), false)
  assert.equal(limiter.stopped, true, '2,000 drops: stopped')
  assert.equal(embedLimiterTake(limiter, 3600000), false, 'time does not restart it')
  assert.equal(embedLimiterDrop(limiter, 3600000), false, 'and it reports the stop once')
}
{
  // Drops spread wider than the window do not add up: 150 a second for 13 seconds, never 2,000 in ten.
  const limiter = embedCreateLimiter(0)
  for (let second = 0; second < 13; second += 1) for (let i = 0; i < 150; i += 1) embedLimiterDrop(limiter, second * 1000 + i)
  assert.equal(limiter.stopped, false, '1,950 drops in 13 seconds, at most 1,650 in any 11')
  // 200 a second reaches 2,000 inside ten seconds.
  const fast = embedCreateLimiter(0)
  let stoppedAt = -1
  for (let second = 0; second < 13 && stoppedAt < 0; second += 1) for (let i = 0; i < 200; i += 1) if (embedLimiterDrop(fast, second * 1000 + i)) stoppedAt = second
  assert.equal(stoppedAt, 9, '200 a second: stopped in the tenth second')
}
// (key, engaged, frameHasFocus, userActive, recentCount)
assert.equal(embedKeyDecision('ArrowRight', true, true, true, 0), true)
assert.equal(embedKeyDecision(' ', true, true, true, 4), true)
assert.equal(embedKeyDecision('Enter', true, true, true, 0), false, 'refused: a key outside the list')
assert.equal(embedKeyDecision('F5', true, true, true, 0), false)
assert.equal(embedKeyDecision('Home', true, true, true, 0), false, 'refused: Home is not a stepping key')
assert.equal(embedKeyDecision('End', true, true, true, 0), false, 'refused: End is not a stepping key')
assert.equal(embedKeyDecision('ArrowRight', false, true, true, 0), false, 'refused: the deck has not engaged the frame (a page that focused itself)')
assert.equal(embedKeyDecision('ArrowRight', true, false, true, 0), false, 'refused: the deck\'s focus is not on that frame')
assert.equal(embedKeyDecision('ArrowRight', true, true, false, 0), false, 'refused: no press in the deck')
assert.equal(embedKeyDecision('ArrowRight', true, true, true, 5), false, 'refused: 5 already in the last second')
assert.equal(embedKeyDecision('ArrowRight', 1, true, true, 0), false, 'truthy is not true')
assert.equal(embedKeyDecision('ArrowRight', true, 1, 'yes', 0), false)
assert.equal(embedKeyDecision('ArrowRight', true, true, true, NaN), false)
// Escape hands the keyboard back and nothing else: the focus and the rate are enough.
assert.equal(embedKeyDecision('Escape', false, true, false, 0), true)
assert.equal(embedKeyDecision('Escape', false, false, false, 0), false)
assert.equal(embedKeyDecision('Escape', true, true, true, 5), false)
for (const key of ['Home', 'End']) assert.equal(embedValidateMessage(env('key', { key })), null, `a key message cannot carry ${key}`)

// ── 5. Element addresses on a fixture tree ────────────────────────────────────────────────────
/** A small stand-in for a DOM tree: only what the protocol functions read. */
function el(tag, attrs = {}, children = []) {
  const node = { nodeType: 1, localName: tag, id: attrs.id || '', type: attrs.type, attrs, children, parentElement: null, isContentEditable: attrs.contenteditable === true }
  node.getAttribute = (name) => (name in attrs ? String(attrs[name]) : null)
  for (const child of children) child.parentElement = node
  return node
}
function fixtureDocument(body) {
  const root = el('html', {}, [el('head', {}, [el('title')]), body])
  const all = []
  const walk = (node) => { all.push(node); node.children.forEach(walk) }
  walk(root)
  return {
    documentElement: root,
    scrollingElement: root,
    defaultView: { innerWidth: 1000, innerHeight: 500 },
    all,
    pointed: null,
    querySelectorAll(selector) {
      const match = /^\[id="((?:[^"\\]|\\.)*)"\]$/.exec(selector)
      assert.ok(match, `unexpected selector ${selector}`)
      const id = match[1].replace(/\\(.)/g, '$1')
      return all.filter((node) => node.id === id)
    },
    elementFromPoint(x, y) { this.pointed = [x, y]; return this.atPoint || null }
  }
}
const make = () => {
  const go = el('button', { id: 'go' })
  const twinA = el('span', { id: 'twin' })
  const twinB = el('span', { id: 'twin' })
  const odd = el('p', { id: 'a"b\\c' })
  const text = el('input', { id: 'name', type: 'text' })
  const deepLeaf = el('em', { id: 'deep' })
  let deep = deepLeaf
  for (let i = 0; i < 70; i += 1) deep = el('div', {}, [deep])
  const noIdLeaf = el('em')
  let deepNoId = noIdLeaf
  for (let i = 0; i < 70; i += 1) deepNoId = el('div', {}, [deepNoId])
  const body = el('body', {}, [el('h1'), el('div', {}, [go, twinA, twinB, odd, text]), deep, deepNoId, el('my-widget')])
  return { doc: fixtureDocument(body), go, twinA, twinB, odd, text, deepLeaf, noIdLeaf, body }
}
{
  const { doc, go, twinA, twinB, odd, text, deepLeaf, noIdLeaf, body } = make()
  assert.deepEqual(embedDescribeElement(doc, go), { path: [1, 1, 0], tag: 'button', id: 'go' }, 'element children only, from the document element')
  assert.deepEqual(embedDescribeElement(doc, twinB), { path: [1, 1, 2], tag: 'span' }, 'a duplicated id is not carried')
  assert.deepEqual(embedDescribeElement(doc, odd), { path: [1, 1, 3], tag: 'p', id: 'a"b\\c' })
  assert.deepEqual(embedDescribeElement(doc, doc.documentElement), { path: [], tag: 'html' })
  assert.deepEqual(embedDescribeElement(doc, body.children[4]), { path: [1, 4], tag: 'my-widget' })
  assert.deepEqual(embedDescribeElement(doc, go, { x: 0.25, y: 2 }), { path: [1, 1, 0], tag: 'button', id: 'go', px: 0.25, py: 1 }, 'the point is clamped to the viewport')
  assert.deepEqual(embedDescribeElement(doc, deepLeaf), { path: [], tag: 'em', id: 'deep' }, 'deeper than 64: the unique id alone')
  assert.equal(embedDescribeElement(doc, noIdLeaf), null, 'deeper than 64 with no id: not addressable')
  assert.equal(embedDescribeElement(doc, { nodeType: 3 }), null, 'a text node')
  assert.equal(embedDescribeElement(doc, el('p')), null, 'an element outside the document')
  assert.equal(embedDescribeElement(doc, el('weird tag')), null)
  // Every address the describer makes passes validation and comes back to the same element.
  const other = make()
  for (const node of doc.all) {
    const address = embedDescribeElement(doc, node)
    if (!address) continue
    const message = embedValidateMessage(env('click', { el: address }))
    assert.ok(message, `the address of <${node.localName}> validates`)
    assert.equal(embedResolveElement(doc, message.el), node, `<${node.localName}> round-trips in its own document`)
    const twin = embedResolveElement(other.doc, message.el)
    assert.equal(twin && twin.localName, node.localName, `<${node.localName}> resolves in a second copy of the document`)
    assert.equal(embedDescribeElement(other.doc, twin).path.join(), address.path.join())
  }
  // Fallback order: id, then path, then the point.
  assert.equal(embedResolveElement(doc, { path: [0, 0], tag: 'button', id: 'go' }), go, 'the id wins over a path that names another element')
  assert.equal(embedResolveElement(doc, { path: [1, 1, 4], tag: 'input', id: 'twin' }), text, 'a duplicated id: the path')
  assert.equal(embedResolveElement(doc, { path: [1, 1, 4], tag: 'input', id: 'gone' }), text, 'an id that is not there: the path')
  assert.equal(embedResolveElement(doc, { path: [1, 1, 0], tag: 'button', id: 'name' }), go, 'an id on an element of another tag: the path')
  assert.equal(embedResolveElement(doc, { path: [1, 1, 0], tag: 'a' }), null, 'the path resolves but the tag differs: nothing')
  assert.equal(embedResolveElement(doc, { path: [1, 9], tag: 'p' }), null, 'a path that runs off the tree: nothing')
  assert.equal(embedResolveElement(doc, { path: [1, 1, 0, 0, 0], tag: 'p' }), null)
  assert.equal(doc.pointed, null, 'no point in the address: the point is never asked')
  doc.atPoint = twinA
  assert.equal(embedResolveElement(doc, { path: [1, 9], tag: 'p', px: 0.5, py: 0.5 }), twinA, 'neither id nor path: the element at the point')
  assert.deepEqual(doc.pointed, [500, 250], 'the point is a fraction of THIS window\'s viewport')
  assert.equal(embedResolveElement(doc, { path: [1, 1, 0], tag: 'button', px: 0.5, py: 0.5 }), go, 'the path wins over the point')
  doc.atPoint = null
  assert.equal(embedResolveElement(doc, { path: [1, 9], tag: 'p', px: 0.5, py: 0.5 }), null)
  assert.equal(embedResolveElement(doc, { path: [], tag: '' }), doc.scrollingElement, 'the document address: its scrolling element')
  assert.equal(embedResolveElement(doc, { path: [0], tag: '' }), null)
  assert.equal(embedResolveElement(null, { path: [], tag: 'html' }), null)
}

// ── 6. Scroll fractions and field classification ──────────────────────────────────────────────
{
  const box = { scrollWidth: 300, clientWidth: 100, scrollHeight: 1100, clientHeight: 100, scrollLeft: 50, scrollTop: 250 }
  assert.deepEqual(embedScrollFractions(box), { fx: 0.25, fy: 0.25 })
  const small = { scrollWidth: 150, clientWidth: 50, scrollHeight: 600, clientHeight: 200, scrollLeft: 0, scrollTop: 0 }
  embedApplyScroll(small, 0.25, 0.25)
  assert.deepEqual([small.scrollLeft, small.scrollTop], [25, 100], 'the same fraction in a window of another size')
  assert.deepEqual(embedScrollFractions({ scrollWidth: 100, clientWidth: 100, scrollHeight: 100, clientHeight: 100, scrollLeft: 0, scrollTop: 0 }), { fx: 0, fy: 0 }, 'nothing to scroll: 0, never NaN')
  assert.deepEqual(embedScrollFractions({ scrollWidth: 200, clientWidth: 100, scrollHeight: 200, clientHeight: 100, scrollLeft: 150, scrollTop: -20 }), { fx: 1, fy: 0 }, 'overscroll is clamped')
  const fixed = { scrollWidth: 100, clientWidth: 100, scrollHeight: 100, clientHeight: 100, scrollLeft: 5, scrollTop: 5 }
  embedApplyScroll(fixed, 1, 1)
  assert.deepEqual([fixed.scrollLeft, fixed.scrollTop], [0, 0])
}
const input = (attrs) => el('input', attrs)
for (const [name, node] of [
  ['a password input', input({ type: 'password' })],
  ['a password input, type in capitals', input({ type: 'PASSWORD' })],
  ['autocomplete one-time-code', input({ type: 'text', autocomplete: 'one-time-code' })],
  ['autocomplete current-password', input({ type: 'text', autocomplete: 'current-password' })],
  ['autocomplete new-password', input({ type: 'text', autocomplete: 'new-password' })],
  ['autocomplete cc-number', input({ type: 'text', autocomplete: 'cc-number' })],
  ['autocomplete cc-csc', input({ type: 'tel', autocomplete: 'cc-csc' })],
  ['autocomplete cc-exp', input({ type: 'text', autocomplete: 'CC-EXP' })],
  ['autocomplete with a section and a card token', input({ type: 'text', autocomplete: 'section-pay billing cc-name' })],
  ['a select of card types', el('select', { autocomplete: 'cc-type' })],
  ['a textarea marked one-time-code', el('textarea', { autocomplete: 'one-time-code' })]
]) assert.equal(embedIsSensitiveField(node), true, `sensitive: ${name}`)
for (const [name, node] of [
  ['a text input', input({ type: 'text' })], ['an input with no type', input({})], ['autocomplete name', input({ type: 'text', autocomplete: 'name' })],
  ['autocomplete off', input({ type: 'text', autocomplete: 'off' })], ['a token that only contains cc-', input({ type: 'text', autocomplete: 'acc-number' })],
  ['a button', el('button')], ['a text node', { nodeType: 3 }], ['nothing', null]
]) assert.equal(embedIsSensitiveField(node), false, `not sensitive: ${name}`)
assert.deepEqual(['text', undefined, 'search', 'email', 'number', 'password', 'checkbox', 'radio', 'range', 'button', 'submit', 'file', 'color'].map((type) => embedIsTextField(input({ type }))),
  [true, true, true, true, true, true, false, false, false, false, false, false, false])
assert.equal(embedIsTextField(el('textarea')), true)
assert.equal(embedIsTextField(el('div', { contenteditable: true })), true)
assert.equal(embedIsTextField(el('select')), false)
assert.equal(embedIsTextField(el('button')), false)
assert.equal(embedKeepsKeys(el('select')), true, 'a select keeps its arrow keys')
assert.equal(embedKeepsKeys(input({ type: 'text' })), true)
assert.equal(embedKeepsKeys(el('div', { contenteditable: true })), true)
assert.equal(embedKeepsKeys(el('button')), false)
assert.equal(embedKeepsKeys(input({ type: 'checkbox' })), false)
assert.equal(embedKeepsKeys(null), false)
assert.deepEqual(embedFieldState(Object.assign(input({ type: 'checkbox' }), { checked: true })), { checked: true })
assert.deepEqual(embedFieldState(Object.assign(input({ type: 'radio' }), { checked: false })), { checked: false })
assert.deepEqual(embedFieldState(Object.assign(input({ type: 'text' }), { value: 'abc' })), { value: 'abc' })
assert.deepEqual(embedFieldState(Object.assign(input({ type: 'range' }), { value: '7' })), { value: '7' })
assert.deepEqual(embedFieldState(Object.assign(el('select'), { value: 'b' })), { value: 'b' })
assert.deepEqual(embedFieldState(Object.assign(el('textarea'), { value: '' })), { value: '' })
assert.equal(embedFieldState(Object.assign(input({ type: 'file' }), { value: 'C:\\fakepath\\secret.pdf' })), null, 'a file input is never described')
assert.equal(embedFieldState(el('div', { contenteditable: true })), null)
assert.equal(embedFieldState(Object.assign(el('my-widget'), { value: 'x' })), null)

// ── 7. The inlined source ─────────────────────────────────────────────────────────────────────
{
  // As a classic script in a realm of its own: the same answers as the module.
  const context = vm.createContext({ structuredClone })
  vm.runInContext(embedProtocolSource(), context)
  const run = (message) => JSON.parse(vm.runInContext(`JSON.stringify(embedValidateMessage(${JSON.stringify(message)}))`, context))
  for (const [name, message] of valid) assert.deepEqual(run(message), message, `inlined source, valid: ${name}`)
  assert.equal(run(env('click', { el: button, slide: 2 })), null)
  assert.equal(run(env('snapshot')), null)
  assert.equal(vm.runInContext('JSON.stringify(embedLimits())', context), JSON.stringify(L), 'the inlined limits are the module\'s')
  // A message made in ANOTHER realm is not a plain object of this one: refused (what crosses a
  // window boundary is always rebuilt in the receiving realm by structured clone).
  assert.equal(embedValidateMessage(vm.runInContext('({ tw: "embed", v: 1, k: "ready" })', context)), null)
  // Without structuredClone the strict read still decides.
  const bare = vm.createContext({})
  vm.runInContext(embedProtocolSource(), bare)
  assert.equal(vm.runInContext(`JSON.stringify(embedValidateMessage(${JSON.stringify(valid[5][1])}))`, bare), JSON.stringify(valid[5][1]))
  assert.equal(vm.runInContext(`embedValidateMessage(${JSON.stringify(env('click', { el: button, extra: 1 }))})`, bare), null)
}
for (const [name, source] of [['agent', embedAgentSource()], ['channel', embedChannelSource()], ['protocol', embedProtocolSource()]]) {
  assert.doesNotMatch(source, /<\/script/i, `${name} source: no "</script"`)
  assert.equal(source.includes('<!--'), false, `${name} source: no "<!--"`)
  assert.doesNotThrow(() => new vm.Script(source), `${name} source parses as a classic script`)
  assert.doesNotMatch(source, /\bimport\b|\bexport\b/, `${name} source: no module syntax`)
}
assert.ok(embedAgentSource().includes(embedProtocolSource()), 'the agent carries the same protocol source')
assert.ok(embedChannelSource().includes(embedProtocolSource()), 'the channel carries the same protocol source')
assert.doesNotMatch(embedAgentSource(), /Math\.random/, 'no weak randomness anywhere')
assert.doesNotMatch(embedChannelSource(), /Math\.random/)
{
  // The channel source defines embedCreateChannel as a classic script.
  const context = vm.createContext({ structuredClone })
  vm.runInContext(embedChannelSource(), context)
  assert.equal(vm.runInContext('typeof embedCreateChannel', context), 'function')
}

// ── 8. The document lead ──────────────────────────────────────────────────────────────────────
{
  const POLICY = '<meta http-equiv="Content-Security-Policy" content="default-src data:">'
  const lead = embedDocumentLead(POLICY)
  assert.ok(lead.startsWith(`${POLICY}${EMBED_REFERRER_META}${EMBED_BASE_TAG}<script>`), 'policy, referrer, base, agent: in that order')
  assert.ok(lead.endsWith('</script>'))
  assert.equal(lead.match(/<\/script>/g).length, 1, 'one script element, closed once')
  assert.equal(lead, `${POLICY}${EMBED_REFERRER_META}${EMBED_BASE_TAG}<script>${embedAgentSource()}</script>`)
  assert.equal(embedDocumentLead(POLICY, { ownBase: true }).includes('<base'), false, 'a page with its own base is not given ours')
  const page = '<html><body><h1>Sim</h1></body></html>'
  assert.equal(withEmbedLead(page, POLICY), lead + page, 'no doctype: the lead is the very start')
  assert.equal(withEmbedLead(`<!DOCTYPE html>\n${page}`, POLICY), `<!DOCTYPE html>${lead}\n${page}`, 'directly after a leading doctype')
  assert.equal(withEmbedLead(`\uFEFF <!doctype html>${page}`, POLICY), `\uFEFF <!doctype html>${lead}${page}`)
  const own = '<!doctype html><html><head><base href="https://example.org/"></head><body></body></html>'
  const withOwn = withEmbedLead(own, POLICY)
  assert.equal(withOwn.includes(EMBED_BASE_TAG), false)
  assert.ok(withOwn.indexOf(POLICY) < withOwn.indexOf('<base href="https://example.org/">'), 'the policy still precedes everything of the page')
  assert.equal(withEmbedLead('<p>database</p>', POLICY).includes(EMBED_BASE_TAG), true, 'a word starting "base" is not a base element')

  // A base of its own is a real <base> element with an href, not a mention of one.
  const oursIn = (pageText) => withEmbedLead(pageText, POLICY).includes(EMBED_BASE_TAG)
  for (const [name, pageText] of [
    ['base in a comment', '<!doctype html><!-- use <base href="https://x.example/"> here --><a href="#s">s</a>'],
    ['base in a comment before the doctype', '<!-- <base href="https://x.example/"> --><!doctype html><p>x</p>'],
    ['base in a script string', '<!doctype html><script>var s = \'<base href="https://x.example/">\';</script><p>x</p>'],
    ['base in a script comment', '<!doctype html><script>// <base href=x>\n</script><p>x</p>'],
    ['base in a style', '<style>/* <base href="x"> */ p::before { content: "<base href=y>" }</style><p>x</p>'],
    ['base in a textarea', '<textarea><base href="https://x.example/"></textarea>'],
    ['base in the title', '<title>About <base href="x"></title><p>x</p>'],
    ['base in a template', '<template><base href="https://x.example/"></template><p>x</p>'],
    ['base in a noscript', '<noscript><base href="https://x.example/"></noscript><p>x</p>'],
    ['base in an xmp', '<xmp><base href="https://x.example/"></xmp>'],
    ['base in an attribute value', '<p title="<base href=x>">x</p><a data-x=\'<base href="y">\'>y</a>'],
    ['an svg element called base', '<svg><base href="https://x.example/"></base></svg><p>x</p>'],
    ['a base with no href', '<!doctype html><head><base target="_blank"></head><p>x</p>'],
    ['a base with an attribute that only ends in href', '<base data-href="x" xhref="y">'],
    ['a basefont', '<basefont href="x"><p>x</p>'],
    ['an end tag', '</base href="x"><p>x</p>'],
    ['a base cut off by an unterminated comment', '<p>x</p><!-- <base href="x">'],
    ['escaped markup', '&lt;base href="x"&gt;'],
    ['nothing at all', '']
  ]) assert.equal(oursIn(pageText), true, `given our base: ${name}`)
  for (const [name, pageText] of [
    ['a real base', '<!doctype html><html><head><base href="https://example.org/"></head><body></body></html>'],
    ['upper case', '<BASE HREF="https://example.org/">'],
    ['mixed case, single quotes', "<Base Href='https://example.org/'>"],
    ['unquoted', '<base href=https://example.org/>'],
    ['href after another attribute', '<base target="_blank" href="https://example.org/">'],
    ['href before another attribute', '<base href="https://example.org/" target=_blank>'],
    ['self-closing, on several lines', '<base\n  target="_top"\n  href = "https://example.org/"\n/>'],
    ['slash for a space', '<base/href="https://example.org/">'],
    ['an empty href', '<base href="">'],
    ['a bare href', '<base href>'],
    ['in the body', '<p>x</p><base href="https://example.org/">'],
    ['after a mention in a comment', '<!-- <base> --><base href="https://example.org/">'],
    ['after a script that mentions one', '<script>"<base>"</script><base href="https://example.org/">'],
    ['after an attribute value holding ">"', '<p title="a > b"><base href="https://example.org/">']
  ]) assert.equal(oursIn(pageText), false, `keeps its own base: ${name}`)
  assert.equal(embedHasOwnBase('<base href="x">'), true)
  assert.equal(embedHasOwnBase('<!-- <base href="x"> -->'), false)
  // A base with no href: ours is given, and comes before it.
  const noHref = withEmbedLead('<head><base target="_blank"></head>', POLICY)
  assert.ok(noHref.indexOf(EMBED_BASE_TAG) >= 0 && noHref.indexOf(EMBED_BASE_TAG) < noHref.indexOf('<base target'))

  // Where the lead goes: after a doctype that the parser will take as the document's, comments,
  // a byte-order mark and white space before it included; else the very start. A processing
  // instruction and a "<!…>" that is not a doctype are comments to the parser (bogus comments,
  // ended by the first ">"), so an XML prolog before the doctype leaves it the document's own.
  const DOC = '<!doctype html>'
  for (const [name, before] of [
    ['a comment before the doctype', '<!-- saved from somewhere -->'],
    ['two comments and white space', '<!-- a -->\n\t <!-- b -->\r\n'],
    ['a byte-order mark and a comment', '﻿<!-- a -->'],
    ['an empty comment', '<!---->'],
    ['the short empty comments', '<!--><!--->'],
    ['a comment closed with --!>', '<!-- a --!>'],
    ['a comment holding a doctype and a script', '<!-- <!doctype html><script>x()</script> -->'],
    ['white space only', ' \n\f\t'],
    ['an XML prolog', '<?xml version="1.0"?>'],
    ['a declaration that is not a doctype', '<!foo>'],
    ['a prolog, a comment and white space', '<?xml version="1.0" encoding="utf-8"?>\n<!-- saved -->\n\t '],
    ['a byte-order mark, a prolog and an empty declaration', '\uFEFF<?xml version="1.0"?>\n<!>'],
    ['a CDATA section, which is a bogus comment in HTML', '<![CDATA[ x ]]>'],
    ['a declaration that only starts like a doctype', '<!doc type>'],
    ['nothing', '']
  ]) {
    const pageText = `${before}${DOC}<html><body>x</body></html>`
    assert.equal(embedLeadPosition(pageText), before.length + DOC.length, `after the doctype: ${name}`)
    assert.equal(withEmbedLead(pageText, POLICY), `${before}${DOC}${lead}<html><body>x</body></html>`, name)
  }
  assert.equal(embedLeadPosition('<!-- a --><!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd"><html>'), '<!-- a --><!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd">'.length)
  for (const [name, pageText] of [
    ['a script between an empty comment and the doctype', `<!--><script>early()</script><!-- -->${DOC}<p>x</p>`],
    ['the same with <!--->', `<!---><script>early()</script><!-- -->${DOC}<p>x</p>`],
    ['an element before the doctype', `<meta charset="utf-8">${DOC}<p>x</p>`],
    ['text before the doctype', `hello ${DOC}<p>x</p>`],
    ['a no-break space before the doctype', ` ${DOC}<p>x</p>`],
    ['a comment that never ends', `<!-- ${DOC}<p>x</p>`],
    ['a doctype only inside a comment', `<!-- ${DOC} --><script>window.early = 1</script><p>x</p>`],
    ['a prolog and no doctype', '<?xml version="1.0"?><html><body>x</body></html>'],
    ['a prolog that is never closed and takes the doctype with it', `<?xml version="1.0" ${DOC}<p>x</p>`],
    ['a declaration whose first ">" is inside it', `<!foo a="b>c">${DOC}<p>x</p>`],
    ['a prolog, then a script, then the doctype', `<?xml version="1.0"?><script>early()</script>${DOC}<p>x</p>`],
    ['no doctype', '<html><body>x</body></html>']
  ]) {
    assert.equal(embedLeadPosition(pageText), 0, `the very start: ${name}`)
    assert.ok(withEmbedLead(pageText, POLICY).startsWith(POLICY), `${name}: the policy is the first thing in the document`)
  }

  // The page's own title, as text.
  for (const [pageText, title] of [
    ['<title>Caf&#233; &#x2014; R&amp;D&nbsp;notes</title>', 'Café — R&D notes'],
    ['<title>&#60;b&#62; &#x3C;i&#x3e; &#34;q&#34; &#39;s&#39;</title>', '<b> <i> "q" \'s\''],
    ['<title>emoji &#x1F600; &#128512;</title>', 'emoji 😀 😀'],
    ['<title>bad &#0; &#xD800; &#x110000; &#99999999; &#9;tab</title>', 'bad � � � � tab'],
    ['<title>kept &copy; &notanentity; &#; &#x;</title>', 'kept &copy; &notanentity; &#; &#x;'],
    ['<!-- <title>In a comment</title> --><title>Real</title>', 'Real'],
    ['<script>var t = "<title>In a script</title>"</script><title>Real</title>', 'Real'],
    ['<svg><title>Icon</title></svg><title>Real</title>', 'Real'],
    ['<TITLE\n lang="en">Upper</TITLE >', 'Upper'],
    ['<title>Never closed', 'Never closed'],
    ['<svg><title>Only an icon</title></svg>', '']
  ]) assert.equal(embedPageTitle(pageText), title, `title of ${JSON.stringify(pageText.slice(0, 40))}`)
}

console.log('test:embed-protocol passed')
