// test:embed-channel — embedded pages run in a sandbox (0.38 ticket 11.1): the deck side
// (compiler/assets/runtime/embed-channel.js) with no browser. The clock, the random source, the
// focus reader, the activation reader and the timers are injected.
//
//   1. the handshake answers only the frame's own window;
//   2. a message from an earlier activation is ignored; deactivate drops the record;
//   3. identity comes from the record, never from a message;
//   4. roles: capture mirrors, replay and none mirror nothing; deliver only to a replay frame;
//   5. the rate limit, the burst, the 2,000-drop cut-off, one warning, the reset on deactivate;
//   6. scroll coalescing: the newest position per element per 50 ms;
//   7. the key rule: each condition can refuse on its own; a frame that merely has the focus
//      while the deck is active (a page that focused itself) is refused; Home and End never.
// The three modules together in real sandboxed frames: scripts/embed-channel-dom.test.mjs.
import assert from 'node:assert/strict'
import { embedCreateChannel } from '../compiler/assets/runtime/embed-channel.js'
import { embedLimits } from '../compiler/assets/runtime/embed-protocol.js'

const L = embedLimits()

/** A frame element and its window, as far as the channel looks at them. */
function fakeFrame(name) {
  const win = { name, inbox: [], postMessage(message, target) { assert.equal(target, '*'); this.inbox.push(message) } }
  return { name, contentWindow: win }
}
/** A channel with every reader injected, and what it called. */
function rig(overrides = {}) {
  const state = { now: 1000, active: true, focus: null, events: [], keys: [], ready: [], warnings: [], timers: [], serial: 0 }
  const channel = embedCreateChannel({
    listen: false,
    window: null,
    now: () => state.now,
    randomBytes: (count) => { state.serial += 1; return Uint8Array.from({ length: count }, (_, i) => (state.serial * 31 + i * 7) % 256) },
    isUserActive: () => state.active,
    activeElement: () => state.focus,
    setTimer: (fn, ms) => { const timer = { fn, at: state.now + ms, cancelled: false }; state.timers.push(timer); return timer },
    clearTimer: (timer) => { if (timer) timer.cancelled = true },
    warn: (text) => state.warnings.push(text),
    onEvent: (frame, event) => state.events.push({ frame, event }),
    onKey: (frame, key) => state.keys.push({ frame, key }),
    onReady: (frame) => state.ready.push(frame),
    ...overrides
  })
  /** Move the clock, running the timers that fall due. */
  const advance = (ms) => {
    const until = state.now + ms
    for (;;) {
      const due = state.timers.filter((timer) => !timer.cancelled && timer.at <= until).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      state.timers.splice(state.timers.indexOf(due), 1)
      state.now = Math.max(state.now, due.at)
      due.fn()
    }
    state.now = until
  }
  const from = (frame, data) => channel.handleMessage({ source: frame.contentWindow, data })
  /** Activate, let the agent announce itself, and return the token the deck handed out. */
  const live = (frame, identity) => {
    assert.equal(channel.activate(frame, identity), true)
    from(frame, { tw: 'embed', v: 1, k: 'ready' })
    const hello = frame.contentWindow.inbox.at(-1)
    assert.equal(hello.k, 'hello')
    return hello.t
  }
  return { channel, state, advance, from, live }
}
const msg = (token, k, fields = {}) => ({ tw: 'embed', v: 1, t: token, k, ...fields })
const click = (token, index = 0) => msg(token, 'click', { el: { path: [1, index], tag: 'button' } })
const docScroll = (token, fy) => msg(token, 'scroll', { el: { path: [], tag: '' }, fx: 0, fy })

// ── 1. The handshake ──────────────────────────────────────────────────────────────────────────
{
  const { channel, state, from } = rig()
  const frame = fakeFrame('sim')
  const stranger = fakeFrame('stranger')
  assert.equal(channel.activate(frame, { slide: 's4', index: 0, role: 'capture' }), true)
  assert.deepEqual(channel.status(frame), { slide: 's4', index: 0, role: 'capture', ready: false, stopped: false, engaged: false })
  assert.equal(frame.contentWindow.inbox.length, 0, 'nothing is sent before the agent announces itself')

  from(stranger, { tw: 'embed', v: 1, k: 'ready' })
  assert.equal(stranger.contentWindow.inbox.length, 0, 'a window with no record gets no hello')
  assert.equal(frame.contentWindow.inbox.length, 0)
  channel.handleMessage({ source: null, data: { tw: 'embed', v: 1, k: 'ready' } })
  channel.handleMessage({ data: { tw: 'embed', v: 1, k: 'ready' } })
  channel.handleMessage(null)
  assert.equal(frame.contentWindow.inbox.length, 0, 'a message with no source answers nobody')

  from(frame, { tw: 'embed', v: 1, k: 'ready' })
  assert.equal(frame.contentWindow.inbox.length, 1)
  const hello = frame.contentWindow.inbox[0]
  assert.deepEqual(Object.keys(hello).sort(), ['k', 'role', 't', 'tw', 'v'])
  assert.equal(hello.role, 'capture')
  assert.match(hello.t, /^[0-9a-f]{32}$/)
  assert.equal(channel.status(frame).ready, true)
  assert.deepEqual(state.ready, [{ slide: 's4', index: 0, frame }])
  assert.equal(JSON.stringify(channel.status(frame)).includes(hello.t), false, 'the status never carries the token')

  // A page that keeps saying `ready` is answered a bounded number of times.
  for (let i = 0; i < 50; i += 1) from(frame, { tw: 'embed', v: 1, k: 'ready' })
  assert.equal(frame.contentWindow.inbox.length, L.helloMax, 'at most 8 hellos per activation')
  assert.ok(frame.contentWindow.inbox.every((m) => m.t === hello.t), 'always the same token for one activation')

  // A frame that is not in a document has no window: nothing is recorded.
  assert.equal(channel.activate({ contentWindow: null }, { slide: 's1', index: 0, role: 'capture' }), false)
  assert.equal(channel.activate(null, {}), false)
  // No random bytes, no activation: there is no weaker token.
  const weak = rig({ randomBytes: () => { throw new Error('no crypto') } })
  assert.equal(weak.channel.activate(fakeFrame('x'), { role: 'capture' }), false)
  assert.equal(rig({ randomBytes: () => new Uint8Array(4) }).channel.activate(fakeFrame('x'), { role: 'capture' }), false)
  // An unknown role is "none".
  const odd = fakeFrame('odd')
  channel.activate(odd, { slide: 's1', index: 0, role: 'admin' })
  assert.equal(channel.status(odd).role, 'none')
}

// ── 2. Stale activations ──────────────────────────────────────────────────────────────────────
{
  const { channel, state, from, live } = rig()
  const frame = fakeFrame('sim')
  const first = live(frame, { slide: 's4', index: 0, role: 'capture' })
  from(frame, click(first))
  assert.equal(state.events.length, 1)

  // The slide is left and entered again: a new token; the old document's messages are dropped.
  const second = live(frame, { slide: 's4', index: 0, role: 'capture' })
  assert.notEqual(second, first, 'a new token each time a frame is made live')
  from(frame, click(first))
  assert.equal(state.events.length, 1, 'a message with the earlier activation\'s token is ignored')
  from(frame, click(second))
  assert.equal(state.events.length, 2)

  // Deactivated: the record is gone, so even the right token finds nothing.
  assert.equal(channel.deactivate(frame), true)
  assert.equal(channel.status(frame), null)
  from(frame, click(second))
  from(frame, { tw: 'embed', v: 1, k: 'ready' })
  assert.equal(state.events.length, 2)
  assert.equal(frame.contentWindow.inbox.length, 2, 'no hello after deactivate')
  assert.equal(channel.deactivate(frame), false)

  // A frame removed from the document (contentWindow now null) can still be deactivated.
  const gone = fakeFrame('gone')
  const token = live(gone, { slide: 's5', index: 0, role: 'capture' })
  const itsWindow = gone.contentWindow
  gone.contentWindow = null
  assert.equal(channel.deactivate(gone), true)
  channel.handleMessage({ source: itsWindow, data: click(token) })
  assert.equal(state.events.length, 2)

  // deactivateAll and dispose drop everything.
  const a = fakeFrame('a'); const b = fakeFrame('b')
  const ta = live(a, { slide: 's1', index: 0, role: 'capture' }); live(b, { slide: 's1', index: 1, role: 'capture' })
  channel.deactivateAll()
  from(a, click(ta))
  assert.equal(state.events.length, 2)
  assert.equal(channel.status(a), null)
  assert.equal(channel.status(b), null)
}

// ── 3. Identity comes from the record ─────────────────────────────────────────────────────────
{
  const { state, from, live } = rig()
  const victim = fakeFrame('victim')
  const hostile = fakeFrame('hostile')
  const victimToken = live(victim, { slide: 's4', index: 0, role: 'capture' })
  const hostileToken = live(hostile, { slide: 's4', index: 1, role: 'capture' })
  assert.notEqual(victimToken, hostileToken)

  from(hostile, click(hostileToken))
  assert.deepEqual(state.events.at(-1).frame, { slide: 's4', index: 1, frame: hostile }, 'the slide and the embed index are the record\'s')
  assert.deepEqual(state.events.at(-1).event, { k: 'click', el: { path: [1, 0], tag: 'button' } }, 'the event carries no token and no envelope')

  // A well-formed event with a field naming another embed is not an event at all.
  const before = state.events.length
  for (const extra of [{ index: 0 }, { embedIndex: 0 }, { slide: 's1' }, { frame: 'victim' }]) from(hostile, { ...click(hostileToken), ...extra })
  assert.equal(state.events.length, before, 'no message has a field for the slide or the frame')
  // Nor does knowing nothing of the victim's token help: the hostile frame's token only counts for the hostile frame…
  from(victim, click(hostileToken))
  assert.equal(state.events.length, before, 'a token is tied to one frame')
  // …and what it sends as itself is always attributed to itself.
  from(hostile, click(hostileToken, 3))
  assert.equal(state.events.at(-1).frame.index, 1)
  assert.equal(state.events.filter((entry) => entry.frame.index === 0).length, 0, 'nothing was ever attributed to the other embed')

  // The object handed on is not the object received.
  const received = msg(hostileToken, 'input', { el: { path: [1, 2], tag: 'input' }, value: 'typed' })
  from(hostile, received)
  const handed = state.events.at(-1).event
  assert.deepEqual(handed, { k: 'input', el: { path: [1, 2], tag: 'input' }, value: 'typed' })
  assert.notEqual(handed.el, received.el)
  assert.notEqual(handed.el.path, received.el.path)
  // An oversized field never arrives, in any size.
  const count = state.events.length
  from(hostile, msg(hostileToken, 'input', { el: { path: [1, 2], tag: 'input' }, value: 'x'.repeat(4097) }))
  from(hostile, msg(hostileToken, 'input', { el: { path: Array.from({ length: 65 }, () => 0), tag: 'input' }, value: 'x' }))
  assert.equal(state.events.length, count)
}

// ── 4. Roles ──────────────────────────────────────────────────────────────────────────────────
{
  const { channel, state, from, live } = rig()
  const presenter = fakeFrame('presenter')
  const projector = fakeFrame('projector')
  const plain = fakeFrame('plain')
  const tPresenter = live(presenter, { slide: 's2', index: 0, role: 'capture' })
  const tProjector = live(projector, { slide: 's2', index: 0, role: 'replay' })
  const tPlain = live(plain, { slide: 's2', index: 0, role: 'none' })
  assert.deepEqual([presenter, projector, plain].map((frame) => frame.contentWindow.inbox[0].role), ['capture', 'replay', 'none'])

  // Each kind, from the capture frame.
  const kinds = [
    click(tPresenter),
    msg(tPresenter, 'input', { el: { path: [1, 1], tag: 'input' }, value: 'a' }),
    msg(tPresenter, 'change', { el: { path: [1, 1], tag: 'input' }, checked: true }),
    msg(tPresenter, 'keydown', { el: { path: [1], tag: 'body' }, key: 'Enter', code: 'Enter' })
  ]
  kinds.forEach((message) => from(presenter, message))
  assert.deepEqual(state.events.map((entry) => entry.event.k), ['click', 'input', 'change', 'keydown'])

  // The projector's and the plain deck's frames mirror nothing, whatever they send.
  const count = state.events.length
  for (const [frame, token] of [[projector, tProjector], [plain, tPlain]]) {
    from(frame, click(token))
    from(frame, docScroll(token, 0.5))
    from(frame, msg(token, 'input', { el: { path: [1, 1], tag: 'input' }, value: 'a' }))
  }
  assert.equal(state.events.length, count, 'role replay and role none: no event leaves the window')
  // A frame cannot say hello.
  from(presenter, msg(tPresenter, 'hello', { role: 'replay' }))
  assert.equal(channel.status(presenter).role, 'capture')

  // Role none still forwards keys (once the deck has engaged the frame).
  state.focus = plain
  channel.engage(plain)
  from(plain, msg(tPlain, 'key', { key: 'ArrowRight' }))
  from(plain, msg(tPlain, 'key', { key: 'Escape' }))
  assert.deepEqual(state.keys, [{ frame: { slide: 's2', index: 0, frame: plain }, key: 'ArrowRight' }, { frame: { slide: 's2', index: 0, frame: plain }, key: 'Escape' }])

  // deliver: only to a replay frame, only a valid event, with that frame's own token.
  const description = { k: 'click', el: { path: [1, 0], tag: 'button' } }
  assert.equal(channel.deliver(projector, description), true)
  assert.deepEqual(projector.contentWindow.inbox.at(-1), msg(tProjector, 'click', { el: { path: [1, 0], tag: 'button' } }))
  assert.equal(channel.deliver(presenter, description), false, 'not into a capture frame')
  assert.equal(channel.deliver(plain, description), false, 'not into a role-none frame')
  assert.equal(channel.deliver(fakeFrame('unknown'), description), false)
  const sent = projector.contentWindow.inbox.length
  for (const bad of [null, 'click', { k: 'hello', role: 'capture' }, { k: 'key', key: 'ArrowRight' }, { ...description, t: 'f'.repeat(32) }, { ...description, index: 1 }, { k: 'input', el: description.el, value: 'x'.repeat(4097) }, { k: 'click' }]) {
    assert.equal(channel.deliver(projector, bad), false)
  }
  assert.equal(projector.contentWindow.inbox.length, sent, 'a bad description posts nothing')
  // Not before the agent has announced itself.
  const late = fakeFrame('late')
  channel.activate(late, { slide: 's2', index: 1, role: 'replay' })
  assert.equal(channel.deliver(late, description), false)
  assert.equal(late.contentWindow.inbox.length, 0)
  // The captured description is exactly what deliver takes.
  for (const entry of state.events) assert.equal(channel.deliver(projector, JSON.parse(JSON.stringify(entry.event))), true)
}

// ── 5. Rate limit, burst, cut-off ─────────────────────────────────────────────────────────────
{
  const { channel, state, advance, from, live } = rig()
  const frame = fakeFrame('flood')
  const token = live(frame, { slide: 's4', index: 0, role: 'capture' })
  for (let i = 0; i < 1000; i += 1) from(frame, click(token))
  assert.equal(state.events.length, L.rateBurst, 'a burst: 120 pass, 880 are dropped')
  assert.equal(channel.status(frame).stopped, false)
  assert.equal(state.warnings.length, 0)
  advance(1000)
  for (let i = 0; i < 1000; i += 1) from(frame, click(token))
  assert.equal(state.events.length, L.rateBurst + L.ratePerSecond, 'a second later: 60 more')
  // 1,820 drops so far. The 2,000th cuts the frame off.
  for (let i = 0; i < 179; i += 1) from(frame, click(token))
  assert.equal(channel.status(frame).stopped, false, '1,999 drops')
  from(frame, click(token))
  assert.equal(channel.status(frame).stopped, true, '2,000 drops within ten seconds')
  assert.equal(state.warnings.length, 1, 'one console warning')
  const passed = state.events.length
  advance(60000)
  for (let i = 0; i < 500; i += 1) from(frame, click(token))
  from(frame, docScroll(token, 0.3))
  advance(1000)
  assert.equal(state.events.length, passed, 'mirroring from that frame stays off, however long it waits')
  assert.equal(state.warnings.length, 1, 'still one warning')
  // Keys are not mirroring: they still follow their own rule.
  state.focus = frame
  channel.engage(frame)
  from(frame, msg(token, 'key', { key: 'ArrowRight' }))
  assert.equal(state.keys.length, 1)

  // Another frame was never affected.
  const calm = fakeFrame('calm')
  const calmToken = live(calm, { slide: 's4', index: 1, role: 'capture' })
  from(calm, click(calmToken))
  assert.equal(state.events.length, passed + 1, 'the limit is per frame')

  // Leaving the slide and coming back resets it.
  channel.deactivate(frame)
  const again = live(frame, { slide: 's4', index: 0, role: 'capture' })
  assert.equal(channel.status(frame).stopped, false)
  from(frame, click(again))
  assert.equal(state.events.length, passed + 2, 'a new activation mirrors again')
}
{
  // Messages that fail validation, the token or the role are drops too: a flood of them cuts the
  // frame off even though none was ever forwarded.
  for (const [name, make] of [
    ['malformed', () => ({ tw: 'embed', v: 1, k: 'click', junk: true })],
    ['wrong token', () => click('f'.repeat(32))],
    ['oversized', (token) => msg(token, 'input', { el: { path: [0], tag: 'input' }, value: 'x'.repeat(5000) })]
  ]) {
    const { channel, state, from, live } = rig()
    const frame = fakeFrame(name)
    const token = live(frame, { slide: 's4', index: 0, role: 'capture' })
    for (let i = 0; i < 1999; i += 1) from(frame, make(token))
    assert.equal(channel.status(frame).stopped, false, `${name}: 1,999`)
    from(frame, make(token))
    assert.equal(channel.status(frame).stopped, true, `${name}: 2,000`)
    assert.equal(state.events.length, 0)
    assert.equal(state.warnings.length, 1)
    from(frame, click(token))
    assert.equal(state.events.length, 0, `${name}: a good event after the cut-off is not mirrored`)
  }
  // What is not an object is not ours and is not counted (a video player's command string).
  const { channel, state, from, live } = rig()
  const frame = fakeFrame('strings')
  const token = live(frame, { slide: 's4', index: 0, role: 'capture' })
  for (let i = 0; i < 5000; i += 1) from(frame, '{"event":"command","func":"playVideo"}')
  for (let i = 0; i < 5000; i += 1) from(frame, i)
  assert.equal(channel.status(frame).stopped, false)
  from(frame, click(token))
  assert.equal(state.events.length, 1)
}
{
  // A steady, legitimate rate is never dropped: 50 events a second for a minute.
  const { channel, state, advance, from, live } = rig()
  const frame = fakeFrame('steady')
  const token = live(frame, { slide: 's4', index: 0, role: 'capture' })
  for (let i = 0; i < 3000; i += 1) { from(frame, click(token)); advance(20) }
  assert.equal(state.events.length, 3000)
  assert.equal(channel.status(frame).stopped, false)
}

// ── 6. Scroll coalescing ──────────────────────────────────────────────────────────────────────
{
  const { channel, state, advance, from, live } = rig()
  const frame = fakeFrame('scroller')
  const token = live(frame, { slide: 's4', index: 0, role: 'capture' })
  const panel = (fy) => msg(token, 'scroll', { el: { path: [1, 2], tag: 'div' }, fx: 0, fy })
  const scrolls = () => state.events.filter((entry) => entry.event.k === 'scroll').map((entry) => [entry.event.el.tag, entry.event.fy])

  from(frame, docScroll(token, 0.1))
  assert.deepEqual(scrolls(), [['', 0.1]], 'the first position goes at once')
  // 16 ms apart, as an agent sends them: three inside one 50 ms window.
  advance(16); from(frame, docScroll(token, 0.2))
  advance(16); from(frame, docScroll(token, 0.3))
  advance(16); from(frame, docScroll(token, 0.4))
  assert.deepEqual(scrolls(), [['', 0.1]], 'nothing more inside the window')
  advance(2)
  assert.deepEqual(scrolls(), [['', 0.1], ['', 0.4]], 'at 50 ms: the newest position only')
  // Two elements are coalesced separately.
  advance(10)
  from(frame, docScroll(token, 0.5)); from(frame, panel(0.1)); from(frame, panel(0.2)); from(frame, docScroll(token, 0.6)); from(frame, panel(0.9))
  assert.equal(scrolls().length, 2)
  advance(50)
  assert.deepEqual(scrolls().slice(2), [['', 0.6], ['div', 0.9]], 'one position per element')
  // The final position always arrives.
  advance(500)
  from(frame, docScroll(token, 1))
  assert.deepEqual(scrolls().at(-1), ['', 1])
  assert.equal(state.timers.filter((timer) => !timer.cancelled).length, 0, 'no timer left running')

  // A second of scrolling at 60 a second in one element: about 20 forwarded, none dropped.
  const before = scrolls().length
  for (let i = 0; i < 60; i += 1) { advance(1000 / 60); from(frame, docScroll(token, i / 60)) }
  advance(60)
  const sent = scrolls().length - before
  assert.ok(sent >= 19 && sent <= 22, `60 scroll messages in a second become ${sent}`)
  assert.deepEqual(scrolls().at(-1), ['', 59 / 60])
  assert.equal(channel.status(frame).stopped, false)

  // A pending position does not outlive its activation.
  advance(100)
  from(frame, docScroll(token, 0.11)); from(frame, docScroll(token, 0.12))
  const count = state.events.length
  channel.deactivate(frame)
  advance(1000)
  assert.equal(state.events.length, count, 'deactivate cancels the pending scroll')
}
{
  // Flooding scroll: distinct elements beyond the held number, and endless positions for one.
  const { channel, state, advance, from, live } = rig()
  const frame = fakeFrame('scroll-flood')
  const token = live(frame, { slide: 's4', index: 0, role: 'capture' })
  from(frame, docScroll(token, 0))
  for (let i = 0; i < 5000; i += 1) from(frame, msg(token, 'scroll', { el: { path: [1, i], tag: 'div' }, fx: 0, fy: 0.5 }))
  assert.equal(channel.status(frame).stopped, true, 'more distinct scrolling elements than are held: dropped, then cut off')
  advance(1000)
  assert.ok(state.events.length <= 1 + L.scrollPendingMax, `at most the held number was forwarded (${state.events.length})`)
  assert.equal(state.warnings.length, 1)

  const one = rig()
  const single = fakeFrame('one-element')
  const singleToken = one.live(single, { slide: 's4', index: 0, role: 'capture' })
  for (let i = 0; i < 5000; i += 1) one.from(single, docScroll(singleToken, (i % 100) / 100))
  assert.equal(one.channel.status(single).stopped, true, 'thousands of positions for one element in one instant: cut off')
  one.advance(1000)
  assert.ok(one.state.events.length <= 2, `and almost none forwarded (${one.state.events.length})`)
}

// ── 7. The key rule ───────────────────────────────────────────────────────────────────────────
{
  const { channel, state, advance, from, live } = rig()
  const frame = fakeFrame('keys')
  const other = fakeFrame('other')
  const token = live(frame, { slide: 's7', index: 0, role: 'capture' })
  const key = (name, t = token) => msg(t, 'key', { key: name })
  const stepping = L.forwardKeys.filter((name) => name !== 'Escape')
  state.focus = frame
  state.active = true

  // The reviewer's reproduction: the frame has the deck's focus (a page can focus itself) and the
  // deck has a live user activation (the presenter's own key press), and nothing more.
  assert.equal(channel.status(frame).engaged, false, 'a frame is not engaged when it is made live')
  for (const name of stepping) { from(frame, key(name)); advance(300) }
  assert.deepEqual(state.keys, [], 'refused: focus and activation alone do not move the deck')
  // No message can engage a frame.
  for (const extra of [{ engaged: true }, { engage: 1 }]) from(frame, { ...key('ArrowRight'), ...extra })
  from(frame, msg(token, 'engage', {}))
  from(frame, msg(token, 'hello', { role: 'capture' }))
  advance(1500)
  from(frame, key('ArrowRight'))
  assert.deepEqual(state.keys, [], 'and nothing a frame sends engages it')
  assert.equal(channel.status(frame).engaged, false)
  advance(1500)

  // The deck engages it (it saw a trusted press aimed at the frame): every stepping key is honoured.
  assert.equal(channel.engage(frame), true)
  assert.equal(channel.engage(other), false, 'a frame with no record cannot be engaged')
  for (const name of stepping) { from(frame, key(name)); advance(300) }
  assert.deepEqual(state.keys.map((entry) => entry.key), stepping, 'engaged, focused, active: every stepping key is honoured')
  assert.deepEqual(state.keys[0].frame, { slide: 's7', index: 0, frame })
  advance(2000)
  const base = state.keys.length
  const honoured = () => state.keys.length - base

  // Home and End are not keys a page may forward at all: validation refuses them.
  for (const name of ['Home', 'End']) { from(frame, key(name)); advance(300) }
  assert.equal(honoured(), 0, 'Home and End are never honoured')
  assert.equal(L.forwardKeys.includes('Home') || L.forwardKeys.includes('End'), false)
  // Condition: the key list.
  for (const name of ['Enter', 'a', 'F5', 'Tab', 'Meta', 'ArrowRight ']) { from(frame, key(name)); advance(300) }
  assert.equal(honoured(), 0, 'refused: a key outside the list')
  // Condition: engaged. The deck saw a press elsewhere (or Escape): no longer.
  channel.disengage(frame)
  from(frame, key('ArrowRight'))
  assert.equal(honoured(), 0, 'refused: not engaged')
  channel.engage(frame)
  channel.disengageAll()
  advance(300)
  from(frame, key('ArrowRight'))
  assert.equal(honoured(), 0, 'refused: disengageAll')
  channel.engage(frame)
  advance(1500)
  // Condition: the deck's focused element is that frame.
  for (const focus of [other, null, frame.contentWindow]) { state.focus = focus; from(frame, key('ArrowRight')); advance(300) }
  assert.equal(honoured(), 0, 'refused: the focus is elsewhere')
  state.focus = frame
  // Condition: a live user activation in the deck.
  state.active = false
  from(frame, key('ArrowRight'))
  assert.equal(honoured(), 0, 'refused: no press')
  state.active = true
  // The token and the record still apply.
  advance(1500)
  from(frame, key('ArrowRight', 'f'.repeat(32)))
  from(other, key('ArrowRight'))
  assert.equal(honoured(), 0, 'refused: wrong token, or a window with no record')
  // With everything back, it passes.
  advance(2000)
  from(frame, key('ArrowRight'))
  assert.equal(honoured(), 1)

  // Condition: fewer than 5 in the last second.
  advance(2000)
  const start = state.keys.length
  for (let i = 0; i < 100; i += 1) from(frame, key('ArrowRight'))
  assert.equal(state.keys.length - start, L.keyRateMax, 'the 6th key message within a second is refused')
  assert.equal(L.keyRateMax, 5)
  // A flood that never pauses is never let through again; refused messages count as arrivals.
  for (let i = 0; i < 300; i += 1) { advance(10); from(frame, key('ArrowRight')) }
  assert.equal(state.keys.length - start, L.keyRateMax, 'a steady 100 a second: none after the first 5')
  advance(1001)
  from(frame, key('ArrowLeft'))
  assert.equal(state.keys.length - start, L.keyRateMax + 1, 'a second of quiet: honoured again')
  // A refusal for focus or activation still counts as an arrival.
  advance(2000)
  state.active = false
  for (let i = 0; i < 25; i += 1) from(frame, key('ArrowRight'))
  state.active = true
  const before = state.keys.length
  from(frame, key('ArrowRight'))
  assert.equal(state.keys.length, before, 'key messages sent without a press use up the second')

  // Escape only hands the keyboard back: it needs the focus and the rate, not engagement and not
  // an activation (the Escape key gives none).
  advance(2000)
  channel.disengageAll()
  state.active = false
  from(frame, key('Escape'))
  assert.deepEqual(state.keys.at(-1), { frame: { slide: 's7', index: 0, frame }, key: 'Escape' }, 'Escape is honoured for a frame that has the focus')
  state.focus = other
  const escapes = state.keys.length
  from(frame, key('Escape'))
  assert.equal(state.keys.length, escapes, 'but not for a frame without it')

  // Engagement belongs to one activation: leaving the slide and coming back ends it.
  state.focus = frame
  state.active = true
  channel.engage(frame)
  const again = live(frame, { slide: 's7', index: 0, role: 'capture' })
  assert.equal(channel.status(frame).engaged, false, 'a new activation is not engaged')
  advance(2000)
  const count = state.keys.length
  from(frame, key('ArrowRight', again))
  assert.equal(state.keys.length, count, 'refused until the deck engages the new activation')
}

// ── A consumer that throws does not break the channel ─────────────────────────────────────────
{
  const calls = []
  const { from, live } = rig({ onEvent: () => { calls.push(1); throw new Error('consumer') } })
  const frame = fakeFrame('thrower')
  const token = live(frame, { slide: 's1', index: 0, role: 'capture' })
  assert.doesNotThrow(() => { from(frame, click(token)); from(frame, click(token)) })
  assert.equal(calls.length, 2)
}

// ── With a real EventTarget as the window: one listener, removed by dispose ───────────────────
{
  const host = new EventTarget()
  const events = []
  const channel = embedCreateChannel({ window: host, now: () => 0, randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)), isUserActive: () => false, activeElement: () => null, setTimer: setTimeout, clearTimer: clearTimeout, warn: () => {}, onEvent: (frame, event) => events.push(event) })
  const frame = fakeFrame('real')
  channel.activate(frame, { slide: 's1', index: 0, role: 'capture' })
  const send = (data) => { const event = new Event('message'); event.source = frame.contentWindow; event.data = data; host.dispatchEvent(event) }
  send({ tw: 'embed', v: 1, k: 'ready' })
  const token = frame.contentWindow.inbox[0].t
  send(click(token))
  assert.equal(events.length, 1)
  channel.dispose()
  channel.activate(frame, { slide: 's1', index: 0, role: 'capture' })
  send({ tw: 'embed', v: 1, k: 'ready' })
  assert.equal(frame.contentWindow.inbox.length, 1, 'after dispose the window is no longer listened to')
}

console.log('test:embed-channel passed')
