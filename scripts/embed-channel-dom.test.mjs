// 0.38 ticket 11.1 — the protocol, the agent and the deck-side channel together, in real frames.
//
// One host page served from http://127.0.0.1 stands in for both deck windows. It runs the inlined
// channel source (what the deck template will carry) twice: a "presenter" channel whose frames
// have role capture, and a "projector" channel whose frames have role replay. What the presenter
// channel hands to `onEvent` is sent, as JSON, to the projector channel's `deliver` for the frame
// with the same slide and embed index: the wiring ticket 11.2 will do over the deck's command
// channel. Every embedded page is <iframe sandbox="allow-scripts allow-forms" srcdoc> with the
// compiler's document lead.
//
//   embed 0: an ordinary page, in both windows (frames `a` and `a2`, of different sizes);
//   embed 1: a hostile page, in both windows (`h` and `h2`). It learns its own token (design 5.4
//            says it can) and sends well-formed messages.
//
//   1. click, type and scroll in the presenter's copy: the projector's copy follows; a password
//      does not; the hostile embed's copy is untouched;
//   2. the hostile page cannot drive the other embed, cannot grow a message, cannot flood the
//      channel, and gains nothing by posting to its sibling frames;
//   3. a `key` is refused with no press at all, refused when the deck's focus is on another frame,
//      refused for a page that focused itself after a real key press in the deck, and honoured
//      only for a frame the deck itself engaged; Home and End never.
// Headless Chromium only (never the installed Chrome).
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { chromium } from 'playwright'
import { embedChannelSource } from '../compiler/assets/runtime/embed-channel.js'
import { embedLimits } from '../compiler/assets/runtime/embed-protocol.js'
import { withEmbedLead, embedSandboxValue } from '../compiler/scripts/lib/embed-frame.mjs'
import { EMBED_PAGE_POLICY } from '../compiler/scripts/lib/08-source-adapters.mjs'

const L = embedLimits()
const POLICY_META = `<meta http-equiv="Content-Security-Policy" content="${EMBED_PAGE_POLICY}">`

const BODY = `
<h1>Page</h1>
<div id="row">
  <button id="inc">Add</button><span id="count">0</span>
  <input id="name" type="text">
  <input id="pw" type="password">
  <div id="keybox" tabindex="0">keys</div>
</div>
<div id="panel" style="overflow: auto; width: 200px; height: 100px"><div style="width: 600px; height: 1000px">tall</div></div>
<div style="height: 3000px"></div>
<script>
  window.clicks = 0;
  document.getElementById('inc').addEventListener('click', function () { window.clicks += 1; document.getElementById('count').textContent = String(window.clicks); });
</script>`
const ORDINARY = withEmbedLead(`<!doctype html><html><head><title>Ordinary</title><style>body { margin: 0 }</style></head><body>${BODY}</body></html>`, POLICY_META)
// The hostile page: its first script wraps the MessageEvent `data` accessor before `hello` can
// arrive, so it reads the token the deck gives its frame. Then it posts what it likes.
const hostilePage = (autoKey) => withEmbedLead(`<!doctype html><html><head><title>Hostile</title><style>body { margin: 0 }</style>
<script>
  (function () {
    var original = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data').get;
    Object.defineProperty(MessageEvent.prototype, 'data', { configurable: true, get: function () {
      var value = original.call(this);
      if (value && value.tw === 'embed' && value.k === 'hello' && window.stolen !== value.t) {
        window.stolen = value.t; window.stolenRole = value.role;
        // With no person involved at all: ask the deck to change slide the moment the token is known.
        if (${autoKey}) setTimeout(function () { window.attack.key(3); }, 0);
      }
      return value;
    } });
    var button = { path: [1, 1, 0], tag: 'button', id: 'inc' };
    function post(k, fields, token) { parent.postMessage(Object.assign({ tw: 'embed', v: 1, t: token === undefined ? window.stolen : token, k: k }, fields), '*'); }
    window.attack = {
      own: function () { post('click', { el: button }); },
      forge: function () {
        post('click', { el: button, index: 0 }); post('click', { el: button, embedIndex: 0 }); post('click', { el: button, slide: 's1', frame: 'a' });
        post('input', { el: { path: [1, 1, 2], tag: 'input', id: 'name' }, value: 'forged', index: 0 });
      },
      wrongToken: function () { for (var i = 0; i < 20; i += 1) post('click', { el: button }, '0123456789abcdef0123456789abcdef'); post('click', { el: button }, ''); parent.postMessage({ tw: 'embed', v: 1, k: 'click', el: button }, '*'); },
      oversize: function () {
        post('input', { el: { path: [1, 1, 2], tag: 'input', id: 'name' }, value: new Array(1024 * 1024 + 1).join('x') });
        post('click', { el: { path: new Array(1000).fill(0), tag: 'button' } });
        post('click', { el: { path: [1, 1, 0], tag: 'button', id: new Array(10001).join('i') } });
        post('keydown', { el: button, key: new Array(1001).join('k'), code: 'KeyK' });
        post('scroll', { el: { path: [], tag: '' }, fx: 1e308 * 10, fy: 0.5 });
        post('scroll', { el: { path: [], tag: '' }, fx: 7, fy: 0.5 });
      },
      flood: function (count) { for (var i = 0; i < count; i += 1) post('click', { el: button }); },
      key: function (count) { for (var i = 0; i < (count || 1); i += 1) post('key', { key: 'ArrowRight' }); },
      // What a page can do with no gesture at all: put the focus on itself, then ask to move, to jump.
      selfFocus: function () { window.focus(); document.getElementById('inc').focus(); ['ArrowRight', 'End', 'Home', 'PageDown', ' '].forEach(function (key) { post('key', { key: key }); }); },
      hello: function () { post('hello', { role: 'capture' }); post('ready', {}); parent.postMessage({ tw: 'embed', v: 1, k: 'ready' }, '*'); },
      siblings: function () {
        for (var i = 0; i < parent.frames.length; i += 1) {
          if (parent.frames[i] === window) continue;
          parent.frames[i].postMessage({ tw: 'embed', v: 1, t: window.stolen, k: 'hello', role: 'replay' }, '*');
          parent.frames[i].postMessage({ tw: 'embed', v: 1, t: window.stolen, k: 'click', el: button }, '*');
        }
      },
      reach: function () {
        var out = {};
        try { out.document = String(parent.document); } catch (error) { out.document = error.name; }
        try { out.channel = String(parent.presenter); } catch (error) { out.channel = error.name; }
        try { out.top = String(top.location.href); } catch (error) { out.top = error.name; }
        return out;
      }
    };
  })();
</script></head><body>${BODY}</body></html>`, POLICY_META)
const HOSTILE = hostilePage(false)
const HOSTILE_AUTO = hostilePage(true)
const SANDBOX = embedSandboxValue('local')
/** Text for a classic script: as a JS value, with no "<" for the HTML parser to find. */
const asScriptValue = (value) => JSON.stringify(value).replace(/</g, '\\u003c')

const HOST = `<!doctype html><html><head><title>Deck stand-in</title></head><body>
<script>${embedChannelSource()}</script>
<script>
  window.forwarded = [];
  window.keys = [];
  window.fromProjector = [];
  window.twins = {};
  window.held = {};
  window.presenter = embedCreateChannel({
    onEvent: function (who, event) {
      forwarded.push({ slide: who.slide, index: who.index, event: event });
      var twin = twins[who.slide + ':' + who.index];
      // Across the deck's command channel an event is plain data: JSON here.
      if (twin) projector.deliver(twin, JSON.parse(JSON.stringify(event)));
    },
    onKey: function (who, key) { keys.push({ deck: 'presenter', slide: who.slide, index: who.index, key: key }); }
  });
  window.projector = embedCreateChannel({
    onEvent: function (who, event) { fromProjector.push({ index: who.index, event: event }); },
    onKey: function (who, key) { keys.push({ deck: 'projector', slide: who.slide, index: who.index, key: key }); }
  });
  window.mount = function (deck, name, index, html, sandbox, width, height) {
    var frame = held[name] || document.createElement('iframe');
    frame.setAttribute('sandbox', sandbox);
    frame.name = name;
    frame.style.cssText = 'display:inline-block;border:0;width:' + width + 'px;height:' + height + 'px';
    if (!held[name]) {
      document.body.appendChild(frame);
      // The deck's own control for this frame: a trusted press on it is how the deck knows the
      // person chose to use the page (the template's Interact key, chip and Current-pane cover).
      var button = document.createElement('button');
      button.id = 'engage-' + name;
      button.textContent = 'Use ' + name;
      button.addEventListener('click', function (event) { if (!event.isTrusted) return; window[deck].engage(frame); frame.focus(); });
      document.body.appendChild(button);
    }
    held[name] = frame;
    // The record first, then the document: the agent's ready must find it.
    var ok = window[deck].activate(frame, { slide: 's1', index: index, role: deck === 'presenter' ? 'capture' : 'replay' });
    if (deck === 'projector') twins['s1:' + index] = frame;
    frame.srcdoc = html;
    return ok;
  };
  window.statusOf = function (deck, name) { return window[deck].status(held[name]); };
  // As the deck does: a trusted press this document receives anywhere ends every engagement (a
  // press on an engage button engages again straight after, in its click).
  ['pointerdown', 'keydown'].forEach(function (type) {
    window.addEventListener(type, function (event) { if (event.isTrusted) { presenter.disengageAll(); projector.disengageAll(); } }, true);
  });
  // What the deck's own state was each time a key message arrived, whoever sent it.
  window.keyArrivals = [];
  window.addEventListener('message', function (event) {
    if (!event.data || event.data.k !== 'key') return;
    Object.keys(held).forEach(function (name) {
      if (event.source === held[name].contentWindow) keyArrivals.push({ from: name, active: navigator.userActivation.isActive, focused: document.activeElement === held[name] });
    });
  });
  // ?auto=1: the page mounts everything itself at load and puts the deck's focus on the hostile
  // frame, with no key, no mouse and no script run from outside (which would count as a gesture).
  if (location.search.indexOf('auto=1') >= 0) {
    var pages = ${asScriptValue({ ordinary: ORDINARY, hostile: HOSTILE_AUTO, sandbox: SANDBOX })};
    mount('presenter', 'a', 0, pages.ordinary, pages.sandbox, 600, 400);
    mount('projector', 'a2', 0, pages.ordinary, pages.sandbox, 760, 300);
    mount('presenter', 'h', 1, pages.hostile, pages.sandbox, 600, 400);
    mount('projector', 'h2', 1, pages.hostile, pages.sandbox, 760, 300);
    held.h.focus();
  }
</script>
</body></html>`

const server = createServer((req, res) => {
  if (req.url.split('?')[0] === '/host.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(HOST); return }
  res.writeHead(404); res.end()
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

const browser = await chromium.launch({ headless: true })
let failures = 0
const check = async (name, fn) => {
  try { await fn(); console.log(`PASS ${name}`) } catch (error) { failures += 1; console.error(`FAIL ${name}\n  ${error.stack || error}`) }
}

async function deck() {
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } })
  const page = await context.newPage()
  const warnings = []
  page.on('pageerror', (error) => { failures += 1; console.error(`FAIL page error: ${error.message}`) })
  page.on('console', (message) => { if (message.type() === 'warning') warnings.push(message.text()) })
  await page.goto(`${origin}/host.html`, { waitUntil: 'load' })
  const sandbox = SANDBOX
  const mount = (deckName, name, index, html, width, height) => page.evaluate((args) => window.mount(...args), [deckName, name, index, html, sandbox, width, height])
  // The projector's copies are a different size from the presenter's.
  assert.equal(await mount('presenter', 'a', 0, ORDINARY, 600, 400), true)
  assert.equal(await mount('projector', 'a2', 0, ORDINARY, 760, 300), true)
  assert.equal(await mount('presenter', 'h', 1, HOSTILE, 600, 400), true)
  assert.equal(await mount('projector', 'h2', 1, HOSTILE, 760, 300), true)
  const ready = () => page.waitForFunction(() => ['a', 'h'].every((n) => window.statusOf('presenter', n).ready) && ['a2', 'h2'].every((n) => window.statusOf('projector', n).ready))
  await ready()
  const frame = (name) => page.frames().find((candidate) => candidate.name() === name)
  await frame('h').waitForFunction(() => typeof window.stolen === 'string')
  await frame('h2').waitForFunction(() => typeof window.stolen === 'string')
  const state = () => page.evaluate(() => ({ forwarded: window.forwarded, keys: window.keys, fromProjector: window.fromProjector }))
  const settle = () => page.waitForTimeout(200)
  return { context, page, frame, state, settle, warnings, mount, ready }
}

try {
  await check('handshake: four live frames, opaque origins, the roles the deck gave', async () => {
    const { context, page, frame } = await deck()
    assert.deepEqual(await page.evaluate(() => [window.statusOf('presenter', 'a'), window.statusOf('projector', 'a2'), window.statusOf('presenter', 'h'), window.statusOf('projector', 'h2')]), [
      { slide: 's1', index: 0, role: 'capture', ready: true, stopped: false, engaged: false }, { slide: 's1', index: 0, role: 'replay', ready: true, stopped: false, engaged: false },
      { slide: 's1', index: 1, role: 'capture', ready: true, stopped: false, engaged: false }, { slide: 's1', index: 1, role: 'replay', ready: true, stopped: false, engaged: false }
    ])
    for (const name of ['a', 'a2', 'h', 'h2']) assert.equal(await frame(name).evaluate(() => self.origin), 'null')
    // The hostile page did read its own tokens, one per frame, as design 5.4 says it can.
    const tokens = [await frame('h').evaluate(() => [window.stolen, window.stolenRole]), await frame('h2').evaluate(() => [window.stolen, window.stolenRole])]
    assert.match(tokens[0][0], /^[0-9a-f]{32}$/)
    assert.notEqual(tokens[0][0], tokens[1][0], 'each frame has its own token')
    assert.deepEqual([tokens[0][1], tokens[1][1]], ['capture', 'replay'])
    // And it reaches nothing of the deck.
    assert.deepEqual(await frame('h').evaluate(() => window.attack.reach()), { document: 'SecurityError', channel: 'SecurityError', top: 'SecurityError' })
    // Neither channel is confused by the other's frames: a frame is live in one deck only.
    assert.deepEqual(await page.evaluate(() => [window.statusOf('projector', 'a'), window.statusOf('presenter', 'a2')]), [null, null])
    await context.close()
  })

  await check('click, type and scroll in the presenter\'s copy: the projector\'s copy follows', async () => {
    const { context, page, frame, state, settle } = await deck()
    const a = frame('a'); const a2 = frame('a2'); const h2 = frame('h2')

    await a.click('#inc')
    await a.click('#inc')
    await a2.waitForFunction(() => document.getElementById('count').textContent === '2')

    await a.click('#name')
    await page.keyboard.type('hello there')
    await a2.waitForFunction(() => document.getElementById('name').value === 'hello there')

    // A password is typed in the presenter's copy and never leaves it.
    await a.click('#pw')
    await page.keyboard.type('s3cret-word')
    await a.click('#keybox')
    await settle()
    assert.equal(await a.evaluate(() => document.getElementById('pw').value), 's3cret-word')
    assert.equal(await a2.evaluate(() => document.getElementById('pw').value), '', 'the password field of the other copy stays empty')
    assert.equal(JSON.stringify((await state()).forwarded).includes('s3cret'), false, 'and it is in nothing the deck forwarded')

    // Scroll: an inner panel, then the document, to the same RELATIVE position in a frame of another size.
    await a.evaluate(() => { document.getElementById('panel').scrollTop = 450; document.getElementById('panel').scrollLeft = 100; })
    await a2.waitForFunction(() => document.getElementById('panel').scrollTop === 450 && document.getElementById('panel').scrollLeft === 100)
    await a.hover('h1')
    await page.mouse.wheel(0, 900)
    await a.waitForFunction(() => document.scrollingElement.scrollTop > 0)
    const fraction = (target) => target.evaluate(() => document.scrollingElement.scrollTop / (document.scrollingElement.scrollHeight - document.scrollingElement.clientHeight))
    await page.waitForFunction(() => window.forwarded.some((entry) => entry.event.k === 'scroll' && entry.event.el.tag === ''))
    await settle()
    const [at, at2] = [await fraction(a), await fraction(a2)]
    assert.ok(at > 0.1 && Math.abs(at - at2) < 0.005, `both copies at the same fraction: ${at} and ${at2}`)
    assert.notEqual(await a.evaluate(() => document.scrollingElement.scrollTop), await a2.evaluate(() => document.scrollingElement.scrollTop), 'the pixel positions differ: the frames are different sizes')
    // And back up.
    await page.mouse.wheel(0, -5000)
    await a2.waitForFunction(() => document.scrollingElement.scrollTop === 0)

    const { forwarded, keys, fromProjector } = await state()
    assert.ok(forwarded.length > 10)
    assert.ok(forwarded.every((entry) => entry.slide === 's1' && entry.index === 0), 'every event carries the identity of the record of frame a')
    assert.ok(forwarded.every((entry) => !('t' in entry.event) && !('tw' in entry.event)), 'nothing forwarded carries a token')
    assert.deepEqual(fromProjector, [], 'the replayed events are not captured again in the projector')
    assert.deepEqual(keys, [])
    // The other embed's copy saw none of it.
    assert.deepEqual(await h2.evaluate(() => [window.clicks, document.getElementById('name').value, document.scrollingElement.scrollTop]), [0, '', 0])
    await context.close()
  })

  await check('a hostile page with a valid token cannot drive the other embed, grow a message or flood', async () => {
    const { context, page, frame, state, settle, warnings, mount, ready } = await deck()
    const a = frame('a'); const a2 = frame('a2'); const h = frame('h'); const h2 = frame('h2')
    const victim = () => a2.evaluate(() => [window.clicks, document.getElementById('name').value])

    // Its messages are well formed and accepted: it can operate its OWN copy on the other screen.
    await h.evaluate(() => window.attack.own())
    await h2.waitForFunction(() => window.clicks === 1)
    assert.deepEqual((await state()).forwarded.map((entry) => [entry.index, entry.event.k]), [[1, 'click']], 'attributed to embed 1, from the deck\'s record')

    // Naming another embed: there is no such field, so the whole message is dropped.
    await h.evaluate(() => window.attack.forge())
    // A wrong token, an empty token, no token.
    await h.evaluate(() => window.attack.wrongToken())
    // Oversized fields: a megabyte of value, a path of 1,000, an id of 10,000, a huge key, wild fractions.
    await h.evaluate(() => window.attack.oversize())
    // Pretending to be the deck, or a new agent.
    await h.evaluate(() => window.attack.hello())
    // Posting straight to the sibling frames (its own token, a hello, a click).
    await h.evaluate(() => window.attack.siblings())
    await h2.evaluate(() => window.attack.siblings())
    // The projector's copy of the hostile page sends events too: a replay frame mirrors nothing.
    await h2.evaluate(() => { window.attack.own(); window.attack.flood(50); })
    await settle()
    const after = await state()
    assert.deepEqual(after.forwarded.map((entry) => [entry.index, entry.event.k]), [[1, 'click']], 'none of those messages was forwarded')
    assert.deepEqual(after.fromProjector, [], 'nothing leaves the projector')
    assert.deepEqual(await victim(), [0, ''], 'the other embed\'s copy is untouched')
    assert.deepEqual(await a.evaluate(() => [window.clicks, document.getElementById('name').value]), [0, ''], 'and so is the presenter\'s copy of it')
    assert.equal(await h2.evaluate(() => window.clicks), 1)
    assert.equal((await page.evaluate(() => window.statusOf('presenter', 'a'))).role, 'capture', 'a sibling\'s hello changed no role')
    // The victim still mirrors normally.
    await a.click('#inc')
    await a2.waitForFunction(() => window.clicks === 1)

    // A flood of 10,000 valid events: the burst passes, the rest are dropped, mirroring from that frame stops.
    const before = (await state()).forwarded.length
    await h.evaluate(() => window.attack.flood(10000))
    await page.waitForFunction(() => window.statusOf('presenter', 'h').stopped === true)
    await settle()
    const flooded = (await state()).forwarded.length - before
    assert.ok(flooded >= 100 && flooded <= L.rateBurst + 30, `of 10,000 at most the burst reached the peer channel: ${flooded}`)
    assert.equal(await h2.evaluate(() => window.clicks), 1 + flooded, 'its own copy took exactly what was forwarded')
    assert.equal(warnings.filter((text) => text.includes('too many messages')).length, 1, 'one console warning')
    await h.evaluate(() => window.attack.flood(5000))
    await h.click('#inc')
    await settle()
    assert.equal((await state()).forwarded.length - before, flooded, 'after the cut-off nothing from that frame is mirrored, real or not')
    assert.equal(warnings.filter((text) => text.includes('too many messages')).length, 1)
    // The limit is per frame: the other embed still mirrors.
    await a.click('#inc')
    await a2.waitForFunction(() => window.clicks === 2)
    assert.deepEqual(await page.evaluate(() => [window.statusOf('presenter', 'a').stopped, window.statusOf('presenter', 'h').stopped]), [false, true])
    assert.deepEqual(await victim(), [2, ''])

    // Its slide is left and entered again: a new activation, a new token, mirroring again.
    const oldToken = await h.evaluate(() => window.stolen)
    await mount('presenter', 'h', 1, HOSTILE, 600, 400)
    await mount('projector', 'h2', 1, HOSTILE, 760, 300)
    await ready()
    await frame('h').waitForFunction((old) => typeof window.stolen === 'string' && window.stolen !== old, oldToken)
    await frame('h2').waitForFunction(() => typeof window.clicks === 'number' && window.clicks === 0)
    assert.equal((await page.evaluate(() => window.statusOf('presenter', 'h'))).stopped, false)
    const count = (await state()).forwarded.length
    await frame('h').click('#inc')
    await frame('h2').waitForFunction(() => window.clicks === 1)
    // A message carrying the earlier activation's token is ignored.
    await frame('h').evaluate((old) => parent.postMessage({ tw: 'embed', v: 1, t: old, k: 'click', el: { path: [1, 1, 0], tag: 'button', id: 'inc' } }, '*'), oldToken)
    await settle()
    assert.equal((await state()).forwarded.length, count + 1, 'the stale token forwards nothing')
    await context.close()
  })

  await check('no press at all: a key message from the focused frame is refused', async () => {
    // Nothing touches this page from outside until the attack is over: Playwright's evaluate
    // carries a user gesture, which is exactly what must be absent here.
    const context = await browser.newContext({ viewport: { width: 1600, height: 900 } })
    const page = await context.newPage()
    await page.goto(`${origin}/host.html?auto=1`, { waitUntil: 'load' })
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const seen = await page.evaluate(() => ({ arrivals: window.keyArrivals, keys: window.keys, ready: window.statusOf('presenter', 'h').ready, forwarded: window.forwarded.length }))
    assert.equal(seen.ready, true)
    assert.deepEqual(seen.arrivals.filter((entry) => entry.from === 'h'), [{ from: 'h', active: false, focused: true }, { from: 'h', active: false, focused: true }, { from: 'h', active: false, focused: true }],
      'three key messages arrived from the frame the deck has focused, and the deck had no user activation')
    assert.equal(seen.arrivals.filter((entry) => entry.from === 'h2').length, 3)
    assert.deepEqual(seen.keys, [], 'none was honoured')
    await context.close()
  })

  await check('a key is honoured only for a frame the deck itself engaged; a page that focuses itself is refused', async () => {
    const { context, page, frame, state, settle } = await deck()
    const a = frame('a'); const h = frame('h'); const h2 = frame('h2')
    const deckSees = () => page.evaluate(() => ({ active: navigator.userActivation.isActive, focus: Object.keys(window.held).find((name) => document.activeElement === window.held[name]) ?? null }))

    // The deck has a user activation here (the test's own script calls count as a gesture) but its
    // focus is on no frame: a well-formed key message with a valid token does nothing.
    await h.evaluate(() => window.attack.key(3))
    await h2.evaluate(() => window.attack.key(3))
    await settle()
    assert.deepEqual((await state()).keys, [], 'the deck\'s focus is not on the frame: refused')

    // THE REVIEWER'S CASE. A real key press in the deck itself (the presenter arriving at the
    // slide), then the page puts the focus on itself and asks: the deck is active, its focused
    // element IS that frame, and still nothing moves, because the deck never engaged the frame.
    await page.locator('body').press('ArrowRight')
    await page.waitForTimeout(1100)
    await h.evaluate(() => window.attack.selfFocus())
    await settle()
    assert.deepEqual(await deckSees(), { active: true, focus: 'h' }, 'the page did take the focus, and the deck is active')
    assert.deepEqual((await state()).keys, [], 'a page that focused itself moves nothing')
    assert.equal(await page.evaluate(() => window.statusOf('presenter', 'h').engaged), false)
    // A real click INSIDE a page the deck has not engaged, then a real key: in this stand-in the
    // frames take the pointer directly, so the deck saw neither. That is not enough either.
    await page.waitForTimeout(1100)
    await a.click('#keybox')
    await page.keyboard.press('ArrowRight')
    await settle()
    assert.deepEqual(await deckSees(), { active: true, focus: 'a' })
    assert.deepEqual((await state()).keys, [], 'a press the deck did not see does not engage the frame')

    // The person presses the deck's own control for frame a, then a key inside the page.
    await page.waitForTimeout(1100)
    await page.click('#engage-a')
    await a.click('#keybox')
    await page.keyboard.press('ArrowRight')
    await page.waitForFunction(() => window.keys.length === 1)
    await page.keyboard.press('Home')
    await page.keyboard.press('End')
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => window.keys.length === 2)
    assert.deepEqual((await state()).keys, [{ deck: 'presenter', slide: 's1', index: 0, key: 'ArrowRight' }, { deck: 'presenter', slide: 's1', index: 0, key: 'Escape' }], 'ArrowRight once, Escape; Home and End are the page\'s own keys')
    // Typed into a text field they are the page's.
    await a.click('#name')
    await page.keyboard.press('Space')
    await page.keyboard.press('ArrowLeft')
    await settle()
    assert.equal((await state()).keys.length, 2, 'Space in a text field does not reach the deck')
    assert.equal(await a.evaluate(() => document.getElementById('name').value), ' ')

    // While frame a is engaged, the other page focusing itself and asking is still refused.
    await h.evaluate(() => window.attack.selfFocus())
    await settle()
    assert.equal((await state()).keys.length, 2, 'engagement is per frame')
    // A press anywhere else in the deck ends frame a's engagement.
    await page.waitForTimeout(1100)
    await page.click('#engage-a')
    assert.equal(await page.evaluate(() => window.statusOf('presenter', 'a').engaged), true)
    await page.mouse.click(5, 890)
    assert.equal(await page.evaluate(() => window.statusOf('presenter', 'a').engaged), false, 'a press elsewhere in the deck ends it')

    // In the projector's copy a real key is forwarded the same way (role replay forwards keys).
    await page.click('#engage-a2')
    await frame('a2').click('#keybox')
    await page.keyboard.press('PageDown')
    await page.waitForFunction(() => window.keys.length === 3)
    assert.deepEqual((await state()).keys[2], { deck: 'projector', slide: 's1', index: 0, key: 'PageDown' })

    // The stated bound (design 5.5): once the person HAS chosen to use the hostile page, that page
    // can step for the seconds the activation lasts: stepping keys only, at most 5 a second, and
    // it cannot name a slide or jump to an end.
    await page.waitForTimeout(1100) // the refused messages above have left the one-second window
    await page.click('#engage-h')
    await h.click('#keybox')
    await h.evaluate(() => { window.attack.selfFocus(); window.attack.key(200) })
    await settle()
    const fromHostile = (await state()).keys.slice(3)
    assert.equal(fromHostile.length, L.keyRateMax, 'after the person engaged it: 5 of 205, then refused')
    assert.ok(fromHostile.every((entry) => entry.index === 1 && ['ArrowRight', 'PageDown', ' '].includes(entry.key) && Object.keys(entry).length === 4), 'stepping keys only: no Home, no End')
    await context.close()
  })
} finally {
  await browser.close()
  await new Promise((resolve) => server.close(resolve))
}

if (failures) { console.error(`${failures} failure(s)`); process.exit(1) }
console.log('embed-channel-dom passed')
