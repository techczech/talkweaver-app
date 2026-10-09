// A compiled talk with embedded local pages, served from http://127.0.0.1, for the embed DOM tests
// (0.38 ticket 11.2: scripts/embed-sandbox-dom.test.mjs, scripts/embed-mirroring-dom.test.mjs).
//
// Why http and not file:// (design section 10): in plain Chromium every file:// document already
// has an opaque origin, so an UNSANDBOXED frame cannot reach its parent there either and the
// reproductions could not fail. Served over http an unsandboxed frame shares the deck's origin.
//
// Slides: start · sim (one ordinary page) · attack (one hostile page) · both (a flooding page, embed
// 0, and the ordinary page, embed 1, on one slide) · end; and with `focusPages` also auto (a page
// with an autofocus field) · loop (a page that focuses itself four times a second) · tail · two (the looping
// page, embed 0, and the ordinary page, embed 1) · after · last. Each page reports that it ran with an image request to this
// server (`/ran?page=<name>`), which is how a test counts runs without reading any frame.
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { prepareSource } from '../../compiler/scripts/lib/08-source-adapters.mjs'
import { buildShareHtml } from '../../compiler/scripts/lib/09-output-builders.mjs'
import { buildHandoutHomePageHtml } from '../../compiler/scripts/lib/handout-home-page.mjs'
import { extractSlides, extractStyles } from '../../compiler/scripts/lib/04-html-extraction.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const { markSlidePreviewHtml } = await import(pathToFileURL(join(here, '..', '..', 'src/shared/slide-preview.ts')).href)

const simPage = (origin) => `<!doctype html>
<html><head><title>Counter &amp; anchors: a page with a title that is rather longer than eighty characters in all, so it is cut</title>
<style>body { margin: 0; font: 14px sans-serif; } #panel { overflow: auto; width: 200px; height: 100px; }</style></head><body>
<h1 id="top">Sim</h1>
<p><a id="jump" href="#far">Jump to the far heading</a></p>
<div id="row">
  <button id="inc">Add</button><span id="count">0</span>
  <input id="name" type="text">
  <select id="sel"><option value="a">a</option><option value="b">b</option><option value="c">c</option></select>
  <input id="pw" type="password">
  <div id="keybox" tabindex="0">keys</div>
</div>
<div id="panel"><div style="width: 600px; height: 1000px">tall</div></div>
<div style="height: 2500px"></div>
<h2 id="far">Far</h2>
<div style="height: 1500px"></div>
<script>
  window.clicks = 0; window.keys = []; window.changes = 0; window.hashChanges = 0;
  new Image().src = ${JSON.stringify(`${origin}/ran?page=sim`)} + '&t=' + Date.now() + Math.random();
  try {
    window.storage = { before: localStorage.getItem('visits'), cookie: document.cookie, error: null };
    localStorage.setItem('visits', '1'); sessionStorage.setItem('visits', '1'); document.cookie = 'a=1';
    window.storage.after = localStorage.getItem('visits');
  } catch (error) { window.storage = { error: String(error) }; }
  document.getElementById('inc').addEventListener('click', function () { window.clicks += 1; document.getElementById('count').textContent = String(window.clicks); });
  document.getElementById('sel').addEventListener('change', function () { window.changes += 1; });
  document.addEventListener('keydown', function (e) { window.keys.push(e.key); });
  window.addEventListener('hashchange', function () { window.hashChanges += 1; });
</script>
</body></html>`

// Everything the four reproductions and the ticket's checkboxes name, tried at load. Results stay in
// the page (`window.results`); the tests read them through the browser's debugging connection.
const hostilePage = (origin) => `<!doctype html>
<html><head><title>Hostile</title></head><body>
<h1>Hostile page</h1>
<button id="inc">Add</button>
<script>
  window.clicks = 0;
  document.getElementById('inc').addEventListener('click', function () { window.clicks += 1; });
  new Image().src = ${JSON.stringify(`${origin}/ran?page=hostile`)} + '&t=' + Date.now() + Math.random();
  var results = window.results = { origin: self.origin };
  function attempt(name, fn) { try { results[name] = 'DONE: ' + String(fn()); } catch (error) { results[name] = error.name; } }
  // Reproduction 1: add an image, and a frame, to the deck's document.
  attempt('appendImage', function () { var img = parent.document.createElement('img'); img.setAttribute('data-attack', '1'); img.src = 'file:///etc/hosts'; parent.document.body.appendChild(img); return 'appended'; });
  attempt('appendFrame', function () { var f = parent.document.createElement('iframe'); f.setAttribute('data-attack', '1'); f.src = 'file:///etc/'; parent.document.body.appendChild(f); return 'appended'; });
  // Reproduction 2: the presenter's bridge object on the deck window.
  attempt('bridge', function () { return parent.twLivePollBridge.readClipboard(); });
  attempt('bridgeKeys', function () { return Object.keys(parent.twLivePollBridge).join(); });
  // Reproduction 4: run a script in the deck.
  attempt('appendScript', function () { var s = parent.document.createElement('script'); s.textContent = 'window.__attackRan = true'; parent.document.head.appendChild(s); return 'appended'; });
  attempt('parentEval', function () { return parent.eval('window.__attackRan = true'); });
  // The deck's document, storage and address; any other property of the parent.
  attempt('parentDocument', function () { return parent.document.title; });
  attempt('parentStorage', function () { parent.localStorage.setItem('deck-key', 'changed'); return parent.localStorage.getItem('deck-key'); });
  attempt('parentHref', function () { return parent.location.href; });
  attempt('parentState', function () { return typeof parent.embedChannel + typeof parent.state + typeof parent.slides; });
  attempt('topNavigate', function () { top.location = ${JSON.stringify(`${origin}/hijacked.html`)}; return 'assigned'; });
  attempt('topHref', function () { return top.location.href; });
  attempt('frameElement', function () { return window.frameElement && window.frameElement.tagName; });
  attempt('popup', function () { var w = window.open(${JSON.stringify(`${origin}/popup.html`)}); return w ? 'opened' : 'blocked'; });
  attempt('alert', function () { return typeof alert('x'); });
  // Messages that are not the protocol's, and deck commands a page might guess at.
  attempt('postGuess', function () {
    parent.postMessage({ type: 'html-presentations:state', state: { index: 0, seq: 999999999, updatedAt: Date.now() * 2 } }, '*');
    parent.postMessage({ command: 'print' }, '*');
    parent.postMessage('{"event":"command","func":"playVideo"}', '*');
    return 'posted';
  });
  // What the DECK sends this frame (messages whose source is its parent): everything that arrives is
  // kept, to show it learns no deck state.
  window.received = [];
  window.addEventListener('message', function (event) { if (event.source !== parent) return; window.received.push(typeof event.data === 'string' ? event.data : JSON.stringify(event.data)); });
  // The OTHER deck window. A page embedded in the projector can name the presenter as top.opener
  // (the presenter opened the projector). It posts there what the deck's own windows post to each
  // other: state with a forged slide and a huge sequence number, and every command. The types are
  // the session's real message names, which the test hands over (they are not a secret).
  function reachable() {
    var out = []; var seen = [];
    function add(get, name) { try { var w = get(); if (!w || w === window || seen.indexOf(w) >= 0) return; seen.push(w); out.push({ w: w, name: name }); } catch (error) { /* not reachable */ } }
    add(function () { return parent; }, 'parent');
    add(function () { return top; }, 'top');
    add(function () { return top.opener; }, 'top.opener');
    add(function () { return top.opener.top; }, 'top.opener.top');
    add(function () { return top.opener.opener; }, 'top.opener.opener');
    add(function () { return parent.opener; }, 'parent.opener');
    out.slice().forEach(function (entry) { try { for (var i = 0; i < entry.w.length && i < 12; i += 1) (function (i) { add(function () { return entry.w[i]; }, entry.name + '[' + i + ']'); })(i); } catch (error) { /* not listable */ } });
    return out;
  }
  function peerAttack(types) {
    var targets = reachable();
    var forged = { index: 0, beat: 0, reveal: 0, fontSize: 100, lightbox: { open: false, index: 0 }, talkQr: { open: false, url: '', svg: '' }, mode: { kind: null, step: 0 }, seq: 999999999, updatedAt: Date.now() * 2 };
    var messages = [{ hello: 'peer' }, 'a string', { type: types.message, state: forged }];
    ['print', 'media', 'video', 'audio-state', 'highlight', 'embed', 'embed-ready', 'instant'].forEach(function (command) {
      messages.push({ type: types.command, command: command, slide: command === 'instant' ? { kind: 'text', title: 'FORGED-INSTANT', text: 'FORGED-INSTANT' } : 'start', embedIndex: 0, index: 0, action: 'play', target: 0, slideId: 'start', ranges: [{ block: 0, start: 0, end: 4 }], states: {}, ev: { k: 'click', el: { path: [1, 1], tag: 'button' } }, nonce: 'forged-' + Math.random() });
    });
    var sent = 0;
    targets.forEach(function (target) { messages.forEach(function (message) { try { target.w.postMessage(message, '*'); sent += 1; } catch (error) { /* refused */ } }); });
    var navigated = [];
    ['top.opener'].forEach(function (name) { try { top.opener.location = ${JSON.stringify(`${origin}/hijacked.html`)}; navigated.push('assigned'); } catch (error) { navigated.push(error.name); } });
    var named;
    try { var w = window.open('', types.audienceName); named = w ? 'opened' : 'blocked'; } catch (error) { named = error.name; }
    return { targets: targets.map(function (target) { return target.name; }), sent: sent, openerNavigate: navigated[0], namedWindow: named };
  }
  window.peerAttack = peerAttack;
  // The same from a frame inside this page (a grandchild of the deck).
  var inner = document.createElement('iframe');
  inner.name = 'inner';
  inner.srcdoc = '<script>' + reachable.toString() + peerAttack.toString() + 'window.addEventListener("message", function (e) { if (e.source !== parent || !e.data || !e.data.attack) return; parent.postMessage({ innerResult: peerAttack(e.data.attack) }, "*"); });<\\/script>';
  document.body.appendChild(inner);
  window.addEventListener('message', function (event) { if (event.source === inner.contentWindow && event.data && event.data.innerResult) window.innerResult = event.data.innerResult; });
  window.peerAttackInner = function (types) { window.innerResult = null; inner.contentWindow.postMessage({ attack: types }, '*'); };
  // With no types at all, at load: anything at all, to every window it can name (before this was
  // closed, ANY message made the sender the deck's peer).
  results.peerAtLoad = (function () { var n = 0; reachable().forEach(function (target) { try { target.w.postMessage({ hello: 'peer' }, '*'); n += 1; } catch (error) { /* refused */ } }); return n > 0 ? 'DONE: posted' : 'none'; })();
  // Reproduction 3, last: navigate this frame to a file. The page must still be here afterwards.
  setTimeout(function () {
    attempt('selfToFile', function () { location.href = 'file:///etc/hosts'; return 'assigned'; });
    setTimeout(function () { results.stillHere = document.title; }, 250);
  }, 150);
</script>
</body></html>`

// A page that floods: on a message from the test's own real click it posts well-formed events.
const floodPage = (origin) => `<!doctype html>
<html><head><title>Flood</title>
<script>
  // It reads its own token as design 5.4 says a page can.
  (function () {
    var original = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data').get;
    Object.defineProperty(MessageEvent.prototype, 'data', { configurable: true, get: function () {
      var value = original.call(this);
      if (value && value.tw === 'embed' && value.k === 'hello' && window.stolen !== value.t) {
        window.stolen = value.t;
        // With no person involved: put the focus on itself, then ask the deck to move on, the moment
        // the token is known and again a little later (the presenter's own arrival key press is
        // still a live user activation in the deck window then).
        var ask = function () {
          try { window.focus(); document.getElementById('inc').focus(); } catch (error) { /* keep going */ }
          ['End', 'ArrowRight', 'Home', 'PageDown', ' '].forEach(function (key) { parent.postMessage({ tw: 'embed', v: 1, t: window.stolen, k: 'key', key: key }, '*'); });
          window.keysSent = (window.keysSent || 0) + 1;
        };
        setTimeout(ask, 0); setTimeout(ask, 150); setTimeout(ask, 600);
      }
      return value;
    } });
  })();
</script></head><body>
<h1>Flood</h1>
<button id="inc">Add</button><button id="go">Flood</button>
<script>
  window.clicks = 0;
  new Image().src = ${JSON.stringify(`${origin}/ran?page=flood`)} + '&t=' + Date.now() + Math.random();
  document.getElementById('inc').addEventListener('click', function () { window.clicks += 1; });
  var button = { path: [1, 1], tag: 'button', id: 'inc' };
  function post(k, fields, token) { parent.postMessage(Object.assign({ tw: 'embed', v: 1, t: token === undefined ? window.stolen : token, k: k }, fields), '*'); }
  window.attack = function () {
    // Naming the other embed of this slide: there is no such field.
    post('click', { el: { path: [1, 2, 0], tag: 'button', id: 'inc' }, embedIndex: 1 });
    post('click', { el: { path: [1, 2, 0], tag: 'button', id: 'inc' }, index: 1, slide: 'both' });
    // A wrong token, no token.
    post('click', { el: button }, '0123456789abcdef0123456789abcdef');
    parent.postMessage({ tw: 'embed', v: 1, k: 'click', el: button }, '*');
    // 10,000 valid events in a burst.
    for (var i = 0; i < 10000; i += 1) post('click', { el: button });
    window.attacked = true;
  };
  document.getElementById('go').addEventListener('click', window.attack);
</script>
</body></html>`

// A page with an ordinary autofocus field, as a form or a search page has.
const autofocusPage = (origin) => `<!doctype html>
<html><head><title>Autofocus</title></head><body>
<h1>Autofocus</h1>
<input id="field" type="text" autofocus>
<div id="keybox" tabindex="0">keys</div>
<script>
  window.clicks = 0; window.keys = [];
  new Image().src = ${JSON.stringify(`${origin}/ran?page=autofocus`)} + '&t=' + Date.now() + Math.random();
  document.addEventListener('keydown', function (e) { window.keys.push(e.key); });
</script>
</body></html>`

// A page that puts the focus on itself at load and again on a loop for as long as it lives. It
// keeps every key it is given (window.keys), which is how a test sees a key that went astray.
// `how` is the loop: a number of milliseconds for setInterval (0 is as fast as the
// browser allows), "raf" for a requestAnimationFrame loop, "once" for at load only.
const focusLoopPage = (origin, how) => `<!doctype html>
<html><head><title>Focus loop</title></head><body>
<h1>Focus loop</h1>
<button id="grab">Grab</button>
<script>
  window.clicks = 0; window.keys = []; window.grabs = 0;
  new Image().src = ${JSON.stringify(`${origin}/ran?page=loop`)} + '&t=' + Date.now() + Math.random();
  // Every key it is given is also reported to the server (ran('loopkey')): a test can still count
  // them after the page has been unloaded.
  document.addEventListener('keydown', function (e) { window.keys.push(e.key); new Image().src = ${JSON.stringify(`${origin}/ran?page=loopkey`)} + '&t=' + Date.now() + Math.random(); }, true);
  function grab() { try { window.focus(); document.getElementById('grab').focus(); window.grabs += 1; } catch (error) { /* keep going */ } }
  grab();
  ${how === 'once' ? '' : how === 'raf' ? '(function loop() { grab(); requestAnimationFrame(loop); })();' : `setInterval(grab, ${Number(how)});`}
</script>
</body></html>`

/**
 * How often the looping page of the main deck (slides `loop` and `two`) focuses itself: four times a
 * second, for as long as it lives. That is UNDER the focus guard's budget (more than 10 grabs in 2
 * seconds stops a page), so this page keeps running and keeps trying; the faster loops, which are
 * stopped, are the /grab-<how>.html decks.
 */
export const EMBED_FIXTURE_LOOP_MS = 250
// A page that never focuses itself: every 40 ms it puts the focus on OTHER frames of the window that
// embeds it (window.focus() is one of the few things a sandboxed page may call on another window).
// `which` is "next" (the frame after its own: on the fixture's slide, the ordinary page) or "all"
// (every frame of the parent in turn, whatever it is: an unloaded page of another slide, a preview).
const crossFocusPage = (origin, which) => `<!doctype html>
<html><head><title>Cross focus</title></head><body>
<h1>Cross focus</h1>
<script>
  window.clicks = 0; window.keys = []; window.asked = 0;
  new Image().src = ${JSON.stringify(`${origin}/ran?page=cross`)} + '&t=' + Date.now() + Math.random();
  document.addEventListener('keydown', function (e) { window.keys.push(e.key); }, true);
  setInterval(function () {
    try {
      var frames = parent.frames; var mine = -1;
      for (var i = 0; i < frames.length; i += 1) if (frames[i] === window) mine = i;
      for (var j = 0; j < frames.length; j += 1) {
        if (j === mine || (${JSON.stringify(which)} === 'next' && j !== mine + 1)) continue;
        try { frames[j].focus(); window.asked += 1; } catch (error) { /* refused */ }
      }
    } catch (error) { /* keep going */ }
  }, 40);
</script>
</body></html>`

// A page for the AUDIENCE window: every 40 ms it puts the focus on every frame of the window that
// opened its own (top.opener is the presenter when the presenter opened the audience window).
const openerFocusPage = (origin) => `<!doctype html>
<html><head><title>Opener focus</title></head><body>
<h1>Opener focus</h1>
<script>
  window.clicks = 0; window.keys = []; window.asked = 0;
  new Image().src = ${JSON.stringify(`${origin}/ran?page=opener`)} + '&t=' + Date.now() + Math.random();
  document.addEventListener('keydown', function (e) { window.keys.push(e.key); }, true);
  setInterval(function () {
    try {
      var frames = top.opener ? top.opener.frames : [];
      for (var i = 0; i < frames.length; i += 1) { try { frames[i].focus(); window.asked += 1; } catch (error) { /* refused */ } }
    } catch (error) { /* no opener, or not reachable */ }
  }, 40);
</script>
</body></html>`

/**
 * /frames.html (with focusPages): frames that are not local pages, and a page that reaches the
 * presenter from the audience window. start · video (a YouTube embed) · remote (a remote site) ·
 * words (text only) · opener (openerFocusPage) · tail. The two remote addresses are not served
 * here: a test routes EMBED_FIXTURE_VIDEO_HOST and EMBED_FIXTURE_REMOTE_URL to documents of its own.
 */
export const EMBED_FIXTURE_VIDEO_HOST = 'www.youtube-nocookie.com'
export const EMBED_FIXTURE_REMOTE_URL = 'https://embed.example.test/grabber'
const FRAMES_OUTLINE = [
  '---', 'title: Frames fixture', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '',
  '### Start', '{id=start}', '', '- Words only', '',
  '### Video', '{id=video}', '', '[Embed: https://www.youtube.com/watch?v=dQw4w9WgXcQ]', '',
  '### Remote', '{id=remote}', '', `[Embed: ${EMBED_FIXTURE_REMOTE_URL}]`, '',
  '### Words', '{id=words}', '', '- Some words on a slide that can be selected for a highlight', '- And a second line of them', '',
  '### Opener', '{id=opener}', '', '[Embed: assets/opener.html]', '',
  '### Tail', '{id=tail}', '', '- Words only', ''
].join('\n')

/** The ways the looping page of a `/grab-<how>.html` deck takes the focus (see focusLoopPage). */
export const GRAB_VARIANTS = ['40', '10', '1', '0', 'raf', 'once']
const GRAB_OUTLINE = [
  '---', 'title: Grab fixture', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '',
  '### Start', '{id=start}', '', '- Words only', '',
  '### Grab', '{id=grab}', '', '[Embed: assets/grab.html]', '',
  '### Tail', '{id=tail}', '', '- Words only', '',
  '### Calm', '{id=calm}', '', '[Embed: assets/sim.html]', '',
  '### Close', '{id=close}', '', '- Words only', ''
].join('\n')

/** Two-page decks: /grab-<name>.html has the named first page and the ordinary page on its `grab` slide. */
export const GRAB_PAIRS = ['cross-next', 'cross-all', 'two40']
const GRAB_PAIR_OUTLINE = GRAB_OUTLINE.replace("'[Embed: assets/grab.html]'", '').replace('[Embed: assets/grab.html]', '[Embed: assets/grab.html]\n\n[Embed: assets/sim.html]')

const OUTLINE = [
  '---', 'title: Embed fixture', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '',
  '### Start', '{id=start}', '', '- Words only', '',
  '### Sim', '{id=sim}', '', '[Simulation: assets/sim.html]', '',
  '### Attack', '{id=attack}', '', '[Embed: assets/hostile.html]', '',
  '### Both', '{id=both}', '', '[Embed: assets/flood.html]', '', '[Embed: assets/sim.html]', '',
  '### End', '{id=end}', '', '- Words only', ''
].join('\n')
// Only with `focusPages` (the focus-rule tests): more slides after `end`.
const FOCUS_SLIDES = [
  '### Auto', '{id=auto}', '', '[Embed: assets/autofocus.html]', '',
  '### Loop', '{id=loop}', '', '[Embed: assets/focus-loop.html]', '',
  '### Tail', '{id=tail}', '', '- Words only', '',
  '### Two', '{id=two}', '', '[Embed: assets/focus-loop.html]', '', '[Embed: assets/sim.html]', '',
  '### After', '{id=after}', '', '- Words only', '',
  '### Last', '{id=last}', '', '- Words only', ''
].join('\n')

/**
 * Compile the fixture talk and serve it. Returns the origin, the compiled deck, a hit counter
 * (`ran(page)` → how many times that page has loaded anywhere; `resetRuns()`), and `close()`.
 *   /deck.html      the compiled deck (plain; ?presenter=1 / ?audience=1 with &session= pair up)
 *   /handout.html   the share page built from it
 *   /preview.html   the deck after markSlidePreviewHtml (what thumbnails and the editor load)
 *   /home.html      the handout's home page, with "sim" as its first slide (the home page has no
 *                   slide links: its stage holds slide 1 until a live session moves it)
 * `focusPages: true` adds the slides auto · loop · tail · two · after · last after `end`, and
 *   /grab-<how>.html and /grab-<how>-handout.html, one small deck (start · grab · tail · calm, with
 *   the ordinary page · close) and its
 *   share page per entry of GRAB_VARIANTS: the page on `grab` focuses itself that way; and per entry
 *   of GRAB_PAIRS, with two pages on `grab`: a page that puts the focus on the next frame
 *   (cross-next) or on every frame (cross-all), or a 40 ms loop (two40), and then the ordinary page.
 */
export async function serveEmbedFixture({ focusPages = false } = {}) {
  const outline = focusPages ? `${OUTLINE}\n${FOCUS_SLIDES}` : OUTLINE
  const runs = new Map()
  const pages = {}
  const hijack = []
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname === '/ran') {
      const page = url.searchParams.get('page') || '?'
      runs.set(page, (runs.get(page) || 0) + 1)
      res.writeHead(204, { 'access-control-allow-origin': '*' }); res.end(); return
    }
    if (url.pathname === '/hijacked.html' || url.pathname === '/popup.html') { hijack.push(url.pathname); res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>hijacked</title>'); return }
    if (pages[url.pathname]) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(pages[url.pathname]); return }
    res.writeHead(404); res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`

  const dir = await mkdtemp(join(tmpdir(), 'tw-embed-fixture-'))
  await mkdir(join(dir, 'assets'), { recursive: true })
  await writeFile(join(dir, 'assets', 'sim.html'), simPage(origin), 'utf8')
  await writeFile(join(dir, 'assets', 'hostile.html'), hostilePage(origin), 'utf8')
  await writeFile(join(dir, 'assets', 'flood.html'), floodPage(origin), 'utf8')
  await writeFile(join(dir, 'assets', 'autofocus.html'), autofocusPage(origin), 'utf8')
  await writeFile(join(dir, 'assets', 'focus-loop.html'), focusLoopPage(origin, EMBED_FIXTURE_LOOP_MS), 'utf8')
  const path = join(dir, 'embed-fixture.md')
  await writeFile(path, outline, 'utf8')
  const model = await prepareSource(path, outline, null, await stat(path), {}, {})
  const deck = model.fullHtml
  pages['/deck.html'] = deck
  pages['/handout.html'] = buildShareHtml({ title: 'Embed fixture', slug: 'embed-fixture', includeNotes: false, license: null, slides: extractSlides(deck), styles: extractStyles(deck) })
  pages['/preview.html'] = markSlidePreviewHtml(deck)
  const shared = extractSlides(deck)
  pages['/home.html'] = buildHandoutHomePageHtml({
    title: 'Embed fixture', slug: 'embed-fixture', license: null, styles: extractStyles(deck),
    slides: [shared[1], shared[0], ...shared.slice(2)], workerBaseUrl: 'https://live.example.test',
    home: { url: 'https://handouts.example.test/embed', qr: '<svg aria-label="QR code"></svg>' }
  })
  if (focusPages) {
    const framesDir = await mkdtemp(join(tmpdir(), 'tw-embed-frames-'))
    await mkdir(join(framesDir, 'assets'), { recursive: true })
    await writeFile(join(framesDir, 'assets', 'opener.html'), openerFocusPage(origin), 'utf8')
    const framesPath = join(framesDir, 'frames-fixture.md')
    await writeFile(framesPath, FRAMES_OUTLINE, 'utf8')
    pages['/frames.html'] = (await prepareSource(framesPath, FRAMES_OUTLINE, null, await stat(framesPath), {}, {})).fullHtml
    for (const how of [...GRAB_VARIANTS, ...GRAB_PAIRS]) {
      const grabDir = await mkdtemp(join(tmpdir(), 'tw-embed-grab-'))
      await mkdir(join(grabDir, 'assets'), { recursive: true })
      const first = how === 'cross-next' ? crossFocusPage(origin, 'next') : how === 'cross-all' ? crossFocusPage(origin, 'all') : focusLoopPage(origin, how === 'two40' ? 40 : /^\d+$/.test(how) ? Number(how) : how)
      await writeFile(join(grabDir, 'assets', 'grab.html'), first, 'utf8')
      await writeFile(join(grabDir, 'assets', 'sim.html'), simPage(origin), 'utf8')
      const grabOutline = GRAB_PAIRS.includes(how) ? GRAB_PAIR_OUTLINE : GRAB_OUTLINE
      const grabPath = join(grabDir, 'grab-fixture.md')
      await writeFile(grabPath, grabOutline, 'utf8')
      const grabDeck = (await prepareSource(grabPath, grabOutline, null, await stat(grabPath), {}, {})).fullHtml
      pages[`/grab-${how}.html`] = grabDeck
      pages[`/grab-${how}-handout.html`] = buildShareHtml({ title: 'Grab fixture', slug: `grab-${how}`, includeNotes: false, license: null, slides: extractSlides(grabDeck), styles: extractStyles(grabDeck) })
    }
  }
  return {
    origin, deck, model, pages, dir,
    ran: (page) => runs.get(page) || 0,
    resetRuns: () => runs.clear(),
    hijacked: () => [...hijack],
    close: () => new Promise((resolve) => server.close(resolve))
  }
}

/**
 * The frames of `page` that hold an embedded local page, with where each sits: `live` (its figure
 * is live, or it is the presenter's Current-pane copy), `pane`, the slide id, and the Playwright
 * frame for reading the page from the test's side.
 */
export async function embedFrames(page) {
  const out = []
  for (const frame of page.frames()) {
    if (frame === page.mainFrame() || frame.parentFrame() !== page.mainFrame()) continue
    let element
    try { element = await frame.frameElement() } catch { continue }
    const info = await element.evaluate((el) => {
      const pane = el.matches('iframe.live-sim-frame[data-embed-local]')
      const figure = el.closest('figure.slide-embed[data-embed="local"]')
      if (!pane && !figure) return null
      return {
        pane,
        live: pane || figure.getAttribute('data-embed-state') === 'live',
        slide: pane ? null : el.closest('.slide')?.dataset.id ?? null,
        active: pane ? true : Boolean(el.closest('.slide.active')),
        sandbox: el.getAttribute('sandbox'),
        hasSrc: el.hasAttribute('src'),
        hasSrcdoc: el.hasAttribute('srcdoc'),
        visible: getComputedStyle(el).visibility !== 'hidden' && el.getClientRects().length > 0
      }
    })
    if (info) out.push({ ...info, frame, url: frame.url() })
  }
  return out
}
