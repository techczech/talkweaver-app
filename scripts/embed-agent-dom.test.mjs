// 0.38 ticket 11.1 — the embed agent (compiler/assets/runtime/embed-agent.js) inside real frames.
//
// A host page served from http://127.0.0.1 (never file://: design section 10) holds the fixture
// page in <iframe sandbox="allow-scripts allow-forms" srcdoc>, with the document lead the compiler
// will write (policy, referrer, base, agent). The host stands in for the deck: it records what the
// frame posts and posts what the test tells it to. Input is real (Playwright mouse and keyboard).
//
//   1. the agent runs before the page's first script, removes its own <script>, posts `ready`;
//   2. `hello`: only from the parent, only the first; a wrong token is ignored;
//   3. capture: click, input, change, keydown, scroll as valid protocol messages, with element
//      paths that resolve and scroll as fractions;
//   4. password, payment and one-time-code fields are never captured and never replayed into;
//   5. replay changes the document as a user event would, and refuses what does not resolve;
//   6. navigation keys and Escape are forwarded with preventDefault, except from a text field, a
//      <select> or an editable element;
//   7. storage and cookie stand-ins where the real ones throw, and only there;
//   8. the agent run twice posts each event once; injected again it takes a new `hello`;
//   9. after the frame navigates, an injected agent starts afresh.
// Headless Chromium only (never the installed Chrome).
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { chromium } from 'playwright'
import { embedAgentSource } from '../compiler/assets/runtime/embed-agent.js'
import { embedValidateMessage, embedLimits } from '../compiler/assets/runtime/embed-protocol.js'
import { withEmbedLead, embedSandboxValue } from '../compiler/scripts/lib/embed-frame.mjs'
import { EMBED_PAGE_POLICY } from '../compiler/scripts/lib/08-source-adapters.mjs'

const POLICY_META = `<meta http-equiv="Content-Security-Policy" content="${EMBED_PAGE_POLICY}">`
const SANDBOX = embedSandboxValue('local')
const T1 = 'a1'.repeat(16)
const T2 = 'b2'.repeat(16)
const T3 = 'c3'.repeat(16)

const FIXTURE = `<!doctype html>
<html><head><title>Fixture</title>
<script>
  // The page's first script: what was there before any script of the page ran.
  window.atFirstScript = {
    agentMarker: typeof window[Symbol.for('tw.embed.agent')],
    scripts: document.scripts.length,
    agentScriptVisible: Array.from(document.scripts).some(function (s) { return s.textContent.indexOf('embedAgent' + 'Main(') >= 0; })
  };
  window.storage = {};
  try {
    localStorage.setItem('k', 'v'); localStorage.other = 'w'; sessionStorage.setItem('s', '1');
    document.cookie = 'tw=1';
    window.storage = {
      ok: true, kind: Object.prototype.toString.call(localStorage), k: localStorage.getItem('k'), other: localStorage.other, missing: localStorage.getItem('nope'),
      length: localStorage.length, keys: Object.keys(localStorage).sort().join(), first: localStorage.key(0), session: sessionStorage.getItem('s'), cookie: document.cookie
    };
    localStorage.removeItem('other');
    window.storage.afterRemove = localStorage.length;
  } catch (error) { window.storage = { ok: false, error: String(error) }; }
  window.log = { clicks: 0, inputs: 0, changes: 0, checkChanges: 0, checkClicks: 0, keys: [], prevented: [], pageMessages: 0 };
  window.addEventListener('message', function () { log.pageMessages += 1; });
</script>
<style>body { margin: 0; font: 14px sans-serif; } #panel { overflow: auto; width: 200px; height: 100px; } #spacer { height: 3000px; }</style>
</head><body>
<h1>Fixture</h1>
<div id="row">
  <button id="inc">Add</button><span id="count">0</span>
  <button class="plain">No id</button>
  <input id="name" type="text"><span id="echo"></span>
  <label id="lab" for="check">Tick</label><input id="check" type="checkbox">
  <select id="sel"><option value="a">a</option><option value="b">b</option><option value="c">c</option></select>
  <input id="pw" type="password"><button id="show">Show</button>
  <input id="card" type="text" autocomplete="cc-number">
  <input id="otp" type="text" autocomplete="one-time-code">
  <textarea id="area"></textarea>
  <div id="edit" contenteditable="true">edit</div>
  <div id="keybox" tabindex="0">keys</div>
  <input id="locked" type="text" readonly value="fixed">
  <input id="off" type="text" disabled value="off">
</div>
<div id="panel"><div style="width: 600px; height: 1000px">tall</div></div>
<div id="spacer"></div>
<script>
  document.getElementById('inc').addEventListener('click', function () { log.clicks += 1; document.getElementById('count').textContent = String(log.clicks); });
  document.getElementById('name').addEventListener('input', function (e) { log.inputs += 1; document.getElementById('echo').textContent = e.target.value; });
  document.getElementById('name').addEventListener('change', function () { log.changes += 1; });
  document.getElementById('check').addEventListener('change', function () { log.checkChanges += 1; });
  document.getElementById('check').addEventListener('click', function () { log.checkClicks += 1; });
  document.getElementById('sel').addEventListener('change', function () { log.changes += 1; });
  document.getElementById('show').addEventListener('click', function () { document.getElementById('pw').type = 'text'; });
  document.addEventListener('keydown', function (e) { log.keys.push(e.key); if (e.defaultPrevented) log.prevented.push(e.key); });
</script>
</body></html>`

const FRAME_HTML = withEmbedLead(FIXTURE, POLICY_META)
// The lead written twice: two agent scripts in one document.
const TWICE_HTML = withEmbedLead(FRAME_HTML, POLICY_META)
// A sibling frame that tries to say hello to, and drive, the frame beside it.
const SIBLING_HTML = `<!doctype html><script>
  window.addEventListener('message', function (e) {
    if (!e.data || e.data.cmd !== 'attack') return;
    var target = parent.frames[e.data.index];
    target.postMessage({ tw: 'embed', v: 1, t: e.data.token, k: 'hello', role: e.data.role }, '*');
    target.postMessage({ tw: 'embed', v: 1, t: e.data.token, k: 'click', el: { path: [1, 1, 0], tag: 'button', id: 'inc' } }, '*');
    parent.postMessage({ done: true }, '*');
  });
</script>`

const HOST = `<!doctype html><html><head><title>Host</title></head><body>
<script>
  window.msgs = [];
  window.held = {};
  window.addEventListener('message', function (event) {
    Object.keys(held).forEach(function (name) {
      if (event.source === held[name].contentWindow) msgs.push({ from: name, data: event.data, origin: event.origin });
    });
  });
  window.mount = function (name, html, sandbox, width, height) {
    var frame = document.createElement('iframe');
    if (sandbox !== null) frame.setAttribute('sandbox', sandbox);
    frame.name = name;
    frame.style.cssText = 'display:block;border:0;width:' + (width || 600) + 'px;height:' + (height || 400) + 'px';
    document.body.appendChild(frame);
    held[name] = frame;
    frame.srcdoc = html;
  };
  window.send = function (name, data) { held[name].contentWindow.postMessage(data, '*'); };
</script>
</body></html>`

const server = createServer((req, res) => {
  const path = req.url.split('?')[0]
  if (path === '/host.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(HOST); return }
  if (path === '/other.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<!doctype html><title>Other</title><button id="inc">Other</button><script>document.getElementById("inc").addEventListener("click", function () { window.otherClicks = (window.otherClicks || 0) + 1; });</script>'); return }
  res.writeHead(404); res.end()
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

const browser = await chromium.launch({ headless: true })
let failures = 0
const check = async (name, fn) => {
  try { await fn(); console.log(`PASS ${name}`) } catch (error) { failures += 1; console.error(`FAIL ${name}\n  ${error.stack || error}`) }
}

/** A host page with the fixture mounted in named frames. */
async function host(frames) {
  const context = await browser.newContext({ viewport: { width: 1300, height: 900 } })
  const page = await context.newPage()
  page.on('pageerror', (error) => { failures += 1; console.error(`FAIL page error: ${error.message}`) })
  await page.goto(`${origin}/host.html`, { waitUntil: 'load' })
  for (const [name, html, sandbox = SANDBOX] of frames) {
    await page.evaluate(([n, h, s]) => window.mount(n, h, s), [name, html, sandbox])
    await page.waitForFunction((n) => window.msgs.some((m) => m.from === n && m.data && m.data.k === 'ready') || !/embedAgentMain/.test(window.held[n].srcdoc), name)
  }
  const frame = (name) => page.frames().find((candidate) => candidate.name() === name)
  const msgs = async (name, kind) => (await page.evaluate(() => window.msgs)).filter((m) => m.from === name && (!kind || (m.data && m.data.k === kind))).map((m) => m.data)
  const waitFor = (name, kind, count = 1) => page.waitForFunction(([n, k, c]) => window.msgs.filter((m) => m.from === n && m.data && m.data.k === k).length >= c, [name, kind, count], { timeout: 5000 })
  const send = (name, data) => page.evaluate(([n, d]) => window.send(n, d), [name, data])
  const hello = (name, token, role) => send(name, { tw: 'embed', v: 1, t: token, k: 'hello', role })
  const clear = () => page.evaluate(() => { window.msgs.length = 0 })
  const settle = () => page.waitForTimeout(150)
  return { context, page, frame, msgs, waitFor, send, hello, clear, settle }
}
/** The element an address names, as the agent's own document sees it: its id, or its tag. */
const resolveIn = (frame, address) => frame.evaluate((el) => {
  let node = document.documentElement
  for (const index of el.path) node = node && node.children[index]
  return node ? { tag: node.localName, id: node.id } : null
}, address)

try {
  // ── 1. Start ────────────────────────────────────────────────────────────────────────────────
  await check('the agent runs first, removes its own script and posts ready once', async () => {
    const { context, page, frame, msgs, settle } = await host([['sim', FRAME_HTML]])
    await settle()
    const all = await page.evaluate(() => window.msgs)
    assert.deepEqual(all, [{ from: 'sim', data: { tw: 'embed', v: 1, k: 'ready' }, origin: 'null' }], 'one ready, no token, from an opaque origin')
    const sim = frame('sim')
    const seen = await sim.evaluate(() => ({
      origin: self.origin,
      atFirstScript: window.atFirstScript,
      agentScripts: Array.from(document.scripts).filter((s) => s.textContent.includes('embedAgentMain')).length,
      scripts: document.scripts.length,
      mode: document.compatMode,
      base: document.querySelector('base').getAttribute('href'),
      globals: Object.getOwnPropertyNames(window).filter((name) => /^embed|^tw/i.test(name)),
      markerEnumerable: Object.keys(window).includes('tw.embed.agent')
    }))
    assert.equal(seen.origin, 'null', 'the frame has an opaque origin')
    assert.deepEqual(seen.atFirstScript, { agentMarker: 'function', scripts: 1, agentScriptVisible: false }, 'before the page\'s first script: the agent has run and its script element is gone')
    assert.equal(seen.agentScripts, 0, 'no script element holds the agent')
    assert.equal(seen.scripts, 2, 'only the page\'s two scripts remain')
    assert.equal(seen.mode, 'CSS1Compat', 'standards mode')
    assert.equal(seen.base, 'about:srcdoc')
    assert.deepEqual(seen.globals, [], 'the agent leaves no named global: no function, no token')
    assert.equal(seen.markerEnumerable, false)
    assert.equal((await msgs('sim')).length, 1)
    await context.close()
  })

  await check('a page that starts with a comment before its doctype stays in standards mode, and the agent still runs first', async () => {
    const page = '<!-- saved from somewhere; mentions <base href="https://elsewhere.example/"> -->\n<!DOCTYPE html><html><head><script>window.first = typeof window[Symbol.for("tw.embed.agent")];</script></head><body><a id="j" href="#far">jump</a><div style="height:3000px"></div><h2 id="far">Far</h2></body></html>'
    const { context, frame } = await host([['commented', withEmbedLead(page, POLICY_META)]])
    const seen = await frame('commented').evaluate(() => ({ mode: document.compatMode, first: window.first, base: document.querySelector('base')?.getAttribute('href') ?? null, origin: self.origin }))
    assert.deepEqual(seen, { mode: 'CSS1Compat', first: 'function', base: 'about:srcdoc', origin: 'null' }, 'standards mode; the agent before the page\'s first script; our base, the comment\'s mention notwithstanding')
    // And so its #anchor link scrolls inside the frame.
    await frame('commented').click('#j')
    await frame('commented').waitForFunction(() => location.hash === '#far' && document.scrollingElement.scrollTop > 1000)
    await context.close()
  })

  await check('a page that starts with an XML prolog before its doctype stays in standards mode, and the agent still runs first', async () => {
    const body = '<html><head><script>window.first = typeof window[Symbol.for("tw.embed.agent")];</script></head><body><p>x</p></body></html>'
    const page = `<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>${body}`
    const { context, page: hostPage, frame } = await host([['prolog', withEmbedLead(page, POLICY_META)], ['declared', withEmbedLead(`<!foo>\n<!-- c --><!DOCTYPE html>${body}`, POLICY_META)]])
    // The page as its author wrote it, with no lead, in the same sandbox: what the lead must not change.
    await hostPage.evaluate(([n, h, s]) => window.mount(n, h, s), ['bare', page, SANDBOX])
    const bare = frame('bare')
    await bare.waitForFunction(() => document.readyState === 'complete' && document.body && document.body.textContent === 'x')
    assert.equal(await bare.evaluate(() => document.compatMode), 'CSS1Compat', 'the page itself is in standards mode')
    for (const name of ['prolog', 'declared']) {
      const seen = await frame(name).evaluate(() => ({ mode: document.compatMode, first: window.first, base: document.querySelector('base')?.getAttribute('href') ?? null, origin: self.origin, doctype: document.doctype ? document.doctype.name : null }))
      assert.deepEqual(seen, { mode: 'CSS1Compat', first: 'function', base: 'about:srcdoc', origin: 'null', doctype: 'html' }, `${name}: standards mode with the lead in place; the agent before the page's first script`)
    }
    assert.ok(withEmbedLead(page, POLICY_META).startsWith('<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html><meta http-equiv="Content-Security-Policy"'), 'the lead is directly after the doctype')
    await context.close()
  })

  // ── 2. hello ────────────────────────────────────────────────────────────────────────────────
  await check('hello: nothing before it; only the parent\'s; only the first; a wrong token is ignored', async () => {
    const { context, page, frame, msgs, waitFor, send, hello, clear, settle } = await host([['sim', FRAME_HTML], ['sibling', SIBLING_HTML, 'allow-scripts']])
    const sim = frame('sim')
    await clear()
    // Before hello: the page works, nothing is posted, keys are the page's.
    await sim.click('#inc')
    await sim.focus('#keybox')
    await page.keyboard.press('ArrowRight')
    await settle()
    assert.deepEqual(await msgs('sim'), [], 'no hello yet: nothing is sent')
    assert.deepEqual(await sim.evaluate(() => [log.clicks, log.keys, log.prevented]), [1, ['ArrowRight'], []], 'no hello yet: the key is not taken from the page')

    // A sibling frame says hello (as "capture") and sends a click: both are ignored.
    await send('sibling', { cmd: 'attack', index: 0, token: T3, role: 'capture' })
    await page.waitForFunction(() => window.msgs.some((m) => m.from === 'sibling' && m.data && m.data.done))
    await sim.click('#inc')
    await settle()
    assert.deepEqual(await msgs('sim'), [], 'a hello from a sibling frame gives the agent no token')
    assert.equal(await sim.evaluate(() => log.clicks), 2, 'and its click was not replayed')

    // The page posting to itself is not the parent either.
    await sim.evaluate((token) => window.postMessage({ tw: 'embed', v: 1, t: token, k: 'hello', role: 'capture' }, '*'), T3)
    await sim.click('#inc')
    await settle()
    assert.deepEqual(await msgs('sim'), [])

    // Malformed hellos from the parent leave it waiting.
    await send('sim', { tw: 'embed', v: 1, t: 'short', k: 'hello', role: 'capture' })
    await send('sim', { tw: 'embed', v: 1, t: T3, k: 'hello', role: 'admin' })
    await send('sim', { tw: 'embed', v: 1, t: T3, k: 'hello', role: 'capture', extra: 1 })
    await sim.click('#inc')
    await settle()
    assert.deepEqual(await msgs('sim'), [])

    // The parent's hello.
    await hello('sim', T1, 'capture')
    await sim.click('#inc')
    await waitFor('sim', 'click')
    assert.equal((await msgs('sim', 'click'))[0].t, T1)
    // A second hello does not replace the first.
    await hello('sim', T2, 'none')
    await clear()
    await sim.click('#inc')
    await waitFor('sim', 'click')
    assert.equal((await msgs('sim', 'click'))[0].t, T1, 'only the first hello counts')
    // Deck messages are stopped before the page's own listeners.
    assert.equal(await sim.evaluate(() => log.pageMessages), 3, 'the page saw the sibling\'s two messages and its own one, and none of the deck\'s')

    // A capture frame replays nothing, even with the right token.
    const before = await sim.evaluate(() => log.clicks)
    await send('sim', { tw: 'embed', v: 1, t: T1, k: 'click', el: { path: [1, 1, 0], tag: 'button', id: 'inc' } })
    await settle()
    assert.equal(await sim.evaluate(() => log.clicks), before, 'role capture: an incoming event is not replayed')
    await context.close()
  })

  // ── 3. Capture ──────────────────────────────────────────────────────────────────────────────
  await check('capture: each kind is a valid message with a path that resolves', async () => {
    const { context, page, frame, msgs, waitFor, hello, clear, settle } = await host([['sim', FRAME_HTML]])
    const sim = frame('sim')
    await hello('sim', T1, 'capture')
    await clear()

    await sim.click('#inc')
    await waitFor('sim', 'click')
    const [click] = await msgs('sim', 'click')
    assert.deepEqual(Object.keys(click).sort(), ['el', 'k', 't', 'tw', 'v'])
    assert.deepEqual({ path: click.el.path, tag: click.el.tag, id: click.el.id }, { path: [1, 1, 0], tag: 'button', id: 'inc' }, 'element children from the document element: body, #row, the button')
    assert.ok(click.el.px > 0 && click.el.px < 1 && click.el.py > 0 && click.el.py < 1, 'the click point as a fraction of the viewport')
    assert.deepEqual(await resolveIn(sim, click.el), { tag: 'button', id: 'inc' })

    await clear()
    await sim.click('.plain')
    await waitFor('sim', 'click')
    const [plain] = await msgs('sim', 'click')
    assert.equal('id' in plain.el, false, 'no id: the path alone')
    assert.deepEqual(plain.el.path, [1, 1, 2])

    // Typing: input per keystroke with the value; change when the field is left; no keydown.
    await clear()
    await sim.click('#name')
    await page.keyboard.type('hi')
    await waitFor('sim', 'input', 2)
    assert.deepEqual((await msgs('sim', 'input')).map((m) => [m.el.id, m.value]), [['name', 'h'], ['name', 'hi']])
    await sim.click('#keybox')
    await waitFor('sim', 'change')
    assert.deepEqual((await msgs('sim', 'change')).map((m) => [m.el.id, m.value]), [['name', 'hi']])
    assert.deepEqual(await msgs('sim', 'keydown'), [], 'a keydown in a text field is not sent; input carries the value')

    // A key in a target that is not a text field.
    await clear()
    await page.keyboard.press('x')
    await waitFor('sim', 'keydown')
    assert.deepEqual((await msgs('sim', 'keydown')).map((m) => [m.el.id, m.key, m.code]), [['keybox', 'x', 'KeyX']])
    assert.deepEqual(await msgs('sim', 'key'), [], 'a letter is not a navigation key')

    // A checkbox through its label: the label's click, then the state. The click the browser
    // makes on the checkbox itself is not sent (the other copy's label click makes it too).
    await clear()
    await sim.click('#lab')
    await waitFor('sim', 'change')
    assert.deepEqual((await msgs('sim', 'click')).map((m) => m.el.id), ['lab'])
    assert.deepEqual((await msgs('sim', 'input')).map((m) => [m.el.id, m.checked, 'value' in m]), [['check', true, false]])
    assert.deepEqual((await msgs('sim', 'change')).map((m) => [m.el.id, m.checked]), [['check', true]])
    // The checkbox clicked directly: its own click is sent.
    await clear()
    await sim.click('#check')
    await waitFor('sim', 'change')
    assert.deepEqual((await msgs('sim', 'click')).map((m) => m.el.id), ['check'])
    assert.deepEqual((await msgs('sim', 'change')).map((m) => m.checked), [false])

    // A select changed from the keyboard.
    await clear()
    await sim.focus('#sel')
    await page.keyboard.type('b')
    await waitFor('sim', 'change')
    assert.deepEqual((await msgs('sim', 'change')).map((m) => [m.el.id, m.el.tag, m.value]), [['sel', 'select', 'b']])

    // Scroll: an inner panel and the document, as fractions.
    await clear()
    await sim.evaluate(() => { document.getElementById('panel').scrollTop = 450; })
    await waitFor('sim', 'scroll')
    const [panel] = await msgs('sim', 'scroll')
    assert.equal(panel.el.id, 'panel')
    assert.ok(Math.abs(panel.fy - 0.5) < 0.01 && panel.fx === 0, `the panel at half its 900px range: ${panel.fy}`)
    await clear()
    await sim.hover('h1')
    await page.mouse.wheel(0, 600)
    await waitFor('sim', 'scroll')
    await settle()
    const scrolls = await msgs('sim', 'scroll')
    const last = scrolls.at(-1)
    assert.deepEqual(last.el, { path: [], tag: '' }, 'the document itself: the empty address')
    const expected = await sim.evaluate(() => document.scrollingElement.scrollTop / (document.scrollingElement.scrollHeight - document.scrollingElement.clientHeight))
    assert.ok(expected > 0 && Math.abs(last.fy - expected) < 0.001, `the document's fraction ${last.fy} of ${expected}`)
    // Many positions in one frame of animation become one message per element.
    await clear()
    await sim.evaluate(() => { for (let i = 0; i < 200; i += 1) document.getElementById('panel').scrollTop = i; })
    await waitFor('sim', 'scroll')
    await settle()
    assert.ok((await msgs('sim', 'scroll')).length <= 3, 'at most one scroll message per element per animation frame')

    // An event the page dispatches itself is not captured.
    await clear()
    await sim.evaluate(() => { document.getElementById('inc').click(); document.getElementById('name').dispatchEvent(new Event('input', { bubbles: true })); })
    await settle()
    assert.deepEqual(await msgs('sim'), [], 'only events the browser made are described')

    // Everything the agent ever posted validates.
    await sim.click('#inc')
    const everything = await page.evaluate(() => window.msgs.map((m) => m.data))
    for (const message of everything) assert.deepEqual(embedValidateMessage(message), message)

    // A value over the limit is not sent, and not cut.
    await clear()
    await sim.evaluate(() => { document.getElementById('area').value = 'x'.repeat(4096); })
    await sim.focus('#area')
    await page.keyboard.type('y')
    await settle()
    assert.deepEqual(await msgs('sim', 'input'), [], 'a 4,097-character value is dropped whole')
    await context.close()
  })

  // ── 4. Sensitive fields ─────────────────────────────────────────────────────────────────────
  await check('password, payment and one-time-code fields are never captured nor replayed into', async () => {
    const { context, page, frame, msgs, send, hello, clear, settle } = await host([['sim', FRAME_HTML], ['twin', FRAME_HTML]])
    const sim = frame('sim')
    const twin = frame('twin')
    await hello('sim', T1, 'capture')
    await hello('twin', T2, 'replay')
    await clear()
    const secrets = { pw: 'hunter2-secret', card: '4111111111111111', otp: '918273' }
    for (const [id, text] of Object.entries(secrets)) {
      await sim.click(`#${id}`)
      await page.keyboard.type(text)
      await page.keyboard.press('Tab')
    }
    // "Show password" turns the field into type=text: it is still never captured.
    await sim.click('#show')
    await sim.click('#pw')
    await page.keyboard.type('more')
    await page.keyboard.press('Tab')
    await settle()
    const posted = await msgs('sim')
    const typed = await sim.evaluate(() => document.getElementById('pw').value)
    assert.ok(typed.length === 18 && typed.includes('more'), 'the typing did reach the field')
    assert.deepEqual(posted.filter((m) => m.k === 'input' || m.k === 'change' || m.k === 'keydown'), [], 'no input, change or keydown for those fields')
    const text = JSON.stringify(posted)
    for (const secret of [...Object.values(secrets), 'more']) assert.equal(text.includes(secret), false, 'nothing typed there is in any message')
    assert.ok(posted.filter((m) => m.k === 'click').length >= 4, 'the clicks themselves are described (they carry no content)')

    // Replay into them is refused; into a plain field beside them it works.
    const address = async (id) => twin.evaluate((wanted) => {
      const node = document.getElementById(wanted); const path = []
      for (let el = node; el !== document.documentElement; el = el.parentElement) path.unshift(Array.prototype.indexOf.call(el.parentElement.children, el))
      return { path, tag: node.localName, id: wanted }
    }, id)
    for (const id of ['pw', 'card', 'otp']) {
      await send('twin', { tw: 'embed', v: 1, t: T2, k: 'input', el: await address(id), value: 'injected' })
      await send('twin', { tw: 'embed', v: 1, t: T2, k: 'change', el: await address(id), value: 'injected' })
      await send('twin', { tw: 'embed', v: 1, t: T2, k: 'keydown', el: await address(id), key: 'a', code: 'KeyA' })
    }
    await send('twin', { tw: 'embed', v: 1, t: T2, k: 'input', el: await address('name'), value: 'allowed' })
    await twin.waitForFunction(() => document.getElementById('name').value === 'allowed')
    assert.deepEqual(await twin.evaluate(() => ['pw', 'card', 'otp'].map((id) => document.getElementById(id).value)), ['', '', ''], 'nothing is written into a sensitive field')
    assert.deepEqual(await twin.evaluate(() => log.keys), [], 'and no key is replayed into one')
    await context.close()
  })

  // ── 5. Replay ───────────────────────────────────────────────────────────────────────────────
  await check('replay: each kind changes the document as a user event would; what does not resolve is refused', async () => {
    const { context, frame, msgs, send, hello, clear, settle } = await host([['twin', FRAME_HTML, SANDBOX]])
    const twin = frame('twin')
    await hello('twin', T2, 'replay')
    await clear()
    const play = (k, fields, token = T2) => send('twin', { tw: 'embed', v: 1, t: token, k, ...fields })
    const row = (index, tag, id) => ({ path: [1, 1, index], tag, ...(id ? { id } : {}) })

    await play('click', { el: row(0, 'button', 'inc') })
    await twin.waitForFunction(() => document.getElementById('count').textContent === '1')
    await play('click', { el: row(0, 'button') })
    await twin.waitForFunction(() => document.getElementById('count').textContent === '2', null, { timeout: 5000 })

    await play('input', { el: row(3, 'input', 'name'), value: 'typed' })
    await twin.waitForFunction(() => document.getElementById('echo').textContent === 'typed')
    assert.deepEqual(await twin.evaluate(() => [document.getElementById('name').value, log.inputs, log.changes]), ['typed', 1, 0], 'input sets the value and fires input')
    await play('change', { el: row(3, 'input', 'name'), value: 'typed' })
    await twin.waitForFunction(() => log.changes === 1)

    // A checkbox: the click toggles it and fires change; the state that follows is already true,
    // so the page's listener runs once, as it did in the other copy.
    await play('click', { el: row(6, 'input', 'check') })
    await play('input', { el: row(6, 'input', 'check'), checked: true })
    await play('change', { el: row(6, 'input', 'check'), checked: true })
    await twin.waitForFunction(() => document.getElementById('check').checked === true)
    await settle()
    assert.deepEqual(await twin.evaluate(() => [log.checkChanges, log.checkClicks]), [1, 1], 'one click, one change')
    // The state alone (the copies had drifted): set and announced.
    await play('change', { el: row(6, 'input', 'check'), checked: false })
    await twin.waitForFunction(() => document.getElementById('check').checked === false)
    assert.equal(await twin.evaluate(() => log.checkChanges), 2)
    // Through the label: the browser clicks the checkbox itself.
    await play('click', { el: row(5, 'label', 'lab') })
    await twin.waitForFunction(() => document.getElementById('check').checked === true)

    await play('change', { el: row(7, 'select', 'sel'), value: 'c' })
    await twin.waitForFunction(() => document.getElementById('sel').value === 'c')

    await play('keydown', { el: row(14, 'div', 'keybox'), key: 'x', code: 'KeyX' })
    await twin.waitForFunction(() => log.keys.includes('x'))

    await play('scroll', { el: { path: [1, 2], tag: 'div', id: 'panel' }, fx: 0, fy: 0.5 })
    await twin.waitForFunction(() => document.getElementById('panel').scrollTop === 450)
    await play('scroll', { el: { path: [], tag: '' }, fx: 0, fy: 0.25 })
    await twin.waitForFunction(() => document.scrollingElement.scrollTop > 0)
    const at = await twin.evaluate(() => document.scrollingElement.scrollTop / (document.scrollingElement.scrollHeight - document.scrollingElement.clientHeight))
    assert.ok(Math.abs(at - 0.25) < 0.002, `the document at a quarter: ${at}`)

    // Refused: nothing below changes anything.
    const before = await twin.evaluate(() => JSON.stringify([log, document.getElementById('name').value, document.getElementById('locked').value, document.getElementById('off').value, document.getElementById('edit').textContent]))
    await play('click', { el: { path: [1, 1, 99], tag: 'button' } })                          // a path that runs off the tree
    await play('click', { el: { path: [1, 1, 0], tag: 'a' } })                                // the path resolves to another tag
    await play('click', { el: { path: [9, 9], tag: 'button', id: 'missing' } })               // neither id nor path
    await play('input', { el: row(0, 'button', 'inc'), value: 'x' })                          // a value into a button
    await play('input', { el: row(3, 'input', 'name'), checked: true })                       // checked into a text field
    await play('input', { el: row(6, 'input', 'check'), value: 'x' })                         // a value into a checkbox
    await play('input', { el: row(15, 'input', 'locked'), value: 'changed' })                 // a read-only field
    await play('input', { el: row(16, 'input', 'off'), value: 'changed' })                    // a disabled field
    await play('input', { el: row(13, 'div', 'edit'), value: 'changed' })                     // an editable element has no value
    await play('keydown', { el: row(3, 'input', 'name'), key: 'x', code: 'KeyX' })            // a key into a text field
    await play('click', { el: row(0, 'button', 'inc') }, T1)                                  // another token
    await play('click', { el: row(0, 'button', 'inc'), slide: 3 })                            // an extra key
    await play('input', { el: row(3, 'input', 'name'), value: 'x'.repeat(4097) })             // over the limit
    await play('hello', { role: 'capture' })                                                  // a second hello
    await settle()
    assert.equal(await twin.evaluate(() => JSON.stringify([log, document.getElementById('name').value, document.getElementById('locked').value, document.getElementById('off').value, document.getElementById('edit').textContent])), before, 'every refused message left the document as it was')

    // A replay frame describes nothing of what is replayed into it.
    assert.deepEqual((await msgs('twin')).filter((m) => m.k !== 'ready'), [], 'role replay: no event is captured, replayed or real')
    await context.close()
  })

  // ── 6. Keys ─────────────────────────────────────────────────────────────────────────────────
  await check('keys: the fixed list and Escape are forwarded; not from a text field, a select or an editable element', async () => {
    for (const role of ['capture', 'replay', 'none']) {
      const { context, page, frame, msgs, hello, clear, settle } = await host([['sim', FRAME_HTML]])
      const sim = frame('sim')
      await hello('sim', T1, role)
      await clear()
      const keys = [...embedLimits().forwardKeys]
      await sim.click('#keybox')
      await clear()
      for (const key of keys) await page.keyboard.press(key === ' ' ? 'Space' : key)
      await settle()
      assert.deepEqual((await msgs('sim', 'key')).map((m) => m.key), keys, `${role}: every listed key is forwarded, in order`)
      assert.deepEqual((await msgs('sim', 'key')).map((m) => Object.keys(m).sort().join()), keys.map(() => 'k,key,t,tw,v'), 'a key message carries the key and nothing else')
      assert.deepEqual(await sim.evaluate(() => log.prevented), keys, `${role}: each with preventDefault`)
      assert.equal(await sim.evaluate(() => document.scrollingElement.scrollTop), 0, 'so Space and the arrows did not scroll the page')
      assert.equal((await msgs('sim', 'keydown')).length, role === 'capture' ? keys.length : 0, `${role}: keydown is mirrored only when capturing`)

      // Not forwarded: other keys, keys with a modifier.
      await clear()
      for (const key of ['a', 'Enter', 'Tab', 'Shift+ArrowRight', 'Alt+ArrowUp', 'Control+Home', 'Shift+Space']) { await sim.focus('#keybox'); await page.keyboard.press(key) }
      await settle()
      assert.deepEqual(await msgs('sim', 'key'), [], `${role}: nothing outside the list, nothing with a modifier`)

      // Not forwarded: typing places.
      for (const selector of ['#name', '#area', '#edit', '#sel', '#pw']) {
        await sim.evaluate(() => { log.prevented.length = 0 })
        await sim.focus(selector)
        await clear()
        for (const key of ['Space', 'ArrowRight', 'Home', 'Escape']) await page.keyboard.press(key)
        await settle()
        assert.deepEqual(await msgs('sim', 'key'), [], `${role}: no key is forwarded from ${selector}`)
        assert.deepEqual(await sim.evaluate(() => log.prevented), [], `${role}: and none is taken from ${selector}`)
      }
      assert.equal(await sim.evaluate(() => document.getElementById('name').value), ' ', 'Space typed in a text field is a space')

      // A key event the page makes up is not forwarded.
      await clear()
      await sim.evaluate(() => document.getElementById('keybox').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
      await settle()
      assert.deepEqual(await msgs('sim', 'key'), [], `${role}: a synthetic keydown is not forwarded`)
      await context.close()
    }
  })

  // ── 7. Storage ──────────────────────────────────────────────────────────────────────────────
  await check('storage and cookie stand-ins: where the real ones throw, and only there', async () => {
    const { context, page, frame } = await host([['boxed', FRAME_HTML], ['open', FRAME_HTML, null]])
    const boxed = await frame('boxed').evaluate(() => window.storage)
    assert.deepEqual(boxed, { ok: true, kind: '[object Object]', k: 'v', other: 'w', missing: null, length: 2, keys: 'k,other', first: 'k', session: '1', cookie: '', afterRemove: 1 },
      'sandboxed: the page reads and writes storage with no error; the cookie reads empty')
    assert.equal(await frame('boxed').evaluate(() => { localStorage.clear(); return localStorage.length + sessionStorage.length }), 1)
    // Without the agent the same page throws: the stand-in is what makes it work.
    await page.evaluate(([html, sandbox]) => window.mount('bare', html, sandbox), [FIXTURE, SANDBOX])
    for (let i = 0; i < 100 && !frame('bare'); i += 1) await page.waitForTimeout(50)
    await frame('bare').waitForFunction(() => window.storage && 'ok' in window.storage)
    const bare = await frame('bare').evaluate(() => window.storage)
    assert.equal(bare.ok, false)
    assert.match(bare.error, /SecurityError/)
    // Nothing survives a reload.
    await frame('boxed').evaluate(() => { window.oldDocument = true; localStorage.setItem('persist', '1'); sessionStorage.setItem('persist', '1') })
    await page.evaluate(() => { window.held.boxed.srcdoc = window.held.boxed.srcdoc })
    await frame('boxed').waitForFunction(() => window.oldDocument === undefined && window.storage && window.storage.ok === true)
    assert.deepEqual(await frame('boxed').evaluate(() => [localStorage.getItem('persist'), sessionStorage.getItem('persist'), window.storage.length]), [null, null, 2], 'a fresh, empty store on each load')

    // A frame that shares the host's origin has working storage: the agent leaves it alone.
    const open = await frame('open').evaluate(() => ({ storage: window.storage, origin: self.origin, isStorage: localStorage instanceof Storage, own: Object.getOwnPropertyDescriptor(document, 'cookie') === undefined }))
    assert.equal(open.origin, origin)
    assert.equal(open.storage.kind, '[object Storage]', 'the real localStorage is not shadowed')
    assert.equal(open.isStorage, true)
    assert.equal(open.own, true, 'document.cookie is not redefined')
    assert.match(open.storage.cookie, /tw=1/, 'the real cookie works')
    assert.equal(await page.evaluate(() => localStorage.getItem('k')), 'v', 'what it stored is in the host origin\'s real storage')
    // And the channel works there the same way.
    assert.equal(await page.evaluate(() => window.msgs.filter((m) => m.from === 'open' && m.data.k === 'ready').length), 1)
    await context.close()
  })

  // ── 8. Twice ────────────────────────────────────────────────────────────────────────────────
  await check('the agent run twice posts each event once; injected again it takes a new hello', async () => {
    const { context, page, frame, msgs, waitFor, hello, clear, settle } = await host([['sim', TWICE_HTML]])
    const sim = frame('sim')
    assert.equal(await sim.evaluate(() => Array.from(document.scripts).filter((s) => s.textContent.includes('embedAgentMain')).length), 0, 'both script elements are gone')
    await waitFor('sim', 'ready', 2)
    await settle()
    assert.equal((await msgs('sim', 'ready')).length, 2, 'the second run made the first agent announce itself again')
    await hello('sim', T1, 'capture')
    await clear()
    await sim.click('#inc')
    await sim.click('#name')
    await page.keyboard.type('a')
    await sim.click('#keybox')
    await page.keyboard.press('ArrowRight')
    await sim.evaluate(() => { document.getElementById('panel').scrollTop = 90; })
    await waitFor('sim', 'scroll')
    await settle()
    const counts = {}
    for (const message of await msgs('sim')) counts[message.k] = (counts[message.k] || 0) + 1
    assert.deepEqual(counts, { click: 3, input: 1, change: 1, key: 1, keydown: 1, scroll: 1 }, 'one message per event, not two')
    assert.deepEqual(await sim.evaluate(() => log.prevented), ['ArrowRight'])

    // Injected again, as the main process will for a remote site (ticket 06): no second set of
    // listeners; the agent announces itself and takes the next hello, with a new token and role.
    await clear()
    await sim.evaluate(embedAgentSource())
    await waitFor('sim', 'ready')
    assert.equal((await msgs('sim', 'ready')).length, 1)
    await hello('sim', T2, 'capture')
    await hello('sim', T3, 'capture')
    await clear()
    await sim.click('#inc')
    await waitFor('sim', 'click')
    await settle()
    assert.deepEqual((await msgs('sim')).map((m) => [m.k, m.t]), [['click', T2]], 'one click, with the new activation\'s token; the hello after it was ignored')
    // The marker is a function the page can call; it only announces.
    await clear()
    await sim.evaluate(() => window[Symbol.for('tw.embed.agent')]())
    await waitFor('sim', 'ready')
    assert.deepEqual(await msgs('sim'), [{ tw: 'embed', v: 1, k: 'ready' }])
    await context.close()
  })

  // ── 9. A frame that navigates ───────────────────────────────────────────────────────────────
  await check('after the frame navigates: no agent, nothing sent; an injected agent starts afresh', async () => {
    const { context, page, frame, msgs, waitFor, send, hello, clear, settle } = await host([['sim', FRAME_HTML]])
    await hello('sim', T1, 'replay')
    const windowBefore = await page.evaluateHandle(() => window.held.sim.contentWindow)
    await frame('sim').evaluate((url) => { location.href = url }, `${origin}/other.html`)
    await page.waitForTimeout(100)
    await frame('sim').waitForFunction(() => document.title === 'Other')
    assert.equal(await page.evaluate((before) => before === window.held.sim.contentWindow, windowBefore), true, 'the window reference names the frame, not the document in it')
    await clear()
    // The old token means nothing to the new document.
    await send('sim', { tw: 'embed', v: 1, t: T1, k: 'click', el: { path: [1, 0], tag: 'button', id: 'inc' } })
    await frame('sim').click('#inc')
    await settle()
    assert.equal(await frame('sim').evaluate(() => window.otherClicks), 1, 'only the real click; the deck\'s message was not replayed')
    assert.deepEqual(await msgs('sim'), [], 'a document without the agent sends nothing')

    // Injected into the new document (ticket 06): a fresh agent, a fresh hello.
    assert.equal(await frame('sim').evaluate(`${embedAgentSource()}; typeof window[Symbol.for('tw.embed.agent')]`), 'function')
    await waitFor('sim', 'ready')
    await hello('sim', T2, 'replay')
    await send('sim', { tw: 'embed', v: 1, t: T1, k: 'click', el: { path: [1, 0], tag: 'button', id: 'inc' } })
    await send('sim', { tw: 'embed', v: 1, t: T2, k: 'click', el: { path: [1, 0], tag: 'button', id: 'inc' } })
    await frame('sim').waitForFunction(() => window.otherClicks === 2)
    await settle()
    assert.equal(await frame('sim').evaluate(() => window.otherClicks), 2, 'the new token replays; the old one does not')
    assert.deepEqual(await frame('sim').evaluate(() => Object.getOwnPropertyNames(window).filter((name) => /^embed/i.test(name))), [], 'injection leaves no named global either')
    await context.close()
  })
} finally {
  await browser.close()
  await new Promise((resolve) => server.close(resolve))
}

if (failures) { console.error(`${failures} failure(s)`); process.exit(1) }
console.log('embed-agent-dom passed')
