// Embedded pages run in a sandbox (0.38 ticket 11.1): the agent, the one script of ours that runs
// INSIDE an embedded page. Design: docs/plans/presenting-features-0.38/embed-sandbox-design.md,
// sections 2.2 (storage stand-ins), 5.2 to 5.7.
//
// It does five things and nothing else:
//   1. posts `ready` to its parent and accepts one `hello` (the token and the role) from it;
//   2. role "capture": describes the page's own click / input / change / keydown / scroll events
//      to the parent (never the content of a password, payment or one-time-code field);
//   3. role "replay": applies the event descriptions the parent sends to its own document;
//   4. every role: forwards the navigation keys and Escape to the parent as `key`, with
//      preventDefault, unless they are typed in a text field, a <select> or an editable element;
//   5. gives the page in-memory `localStorage` / `sessionStorage` and an empty `document.cookie`
//      when, and only when, reading the real one throws (a sandbox without allow-same-origin).
//
// Two ways in, one source (`embedAgentSource()`):
//   - a local page: the compiler writes it as the first <script> of the inlined document, so it
//     runs before any script of the page; it removes its own <script> element;
//   - a remote site (ticket 06): the main process runs the same text in the frame with
//     WebFrameMain.executeJavaScript, and again after each navigation. Running it a second time
//     in one document adds no second set of listeners: it makes the first agent announce itself
//     again and accept the next `hello` (a new activation of the same, still loaded document).
//
// What the page it lives in can do. The agent and the page share one script realm, and the design
// (5.4) relies on nothing that would separate them:
//   - the page can post its own well-formed messages to the parent without the agent, and it can
//     make the agent post them by dispatching events; the deck bounds what those achieve (5.5);
//   - the token is held in a closure and is never written to a global, the DOM or storage, and
//     deck messages are stopped before the page's own `message` listeners. A page that replaces
//     the built-ins the agent calls before `hello` arrives (the MessageEvent accessors,
//     structuredClone, Object / Reflect functions) can still read the token. So can a document
//     the frame navigates to, if the deck answers its `ready`;
//   - the page can stop the agent (remove its listeners' effect, set the marker first) and can
//     call the marker function, which only makes the agent post `ready` again.
// No global of the deck is used: everything comes from `win` and from embed-protocol.js.

import {
  embedLimits, embedBuildMessage, embedValidateMessage, embedSendsToFrame, embedDescribeElement, embedResolveElement,
  embedScrollFractions, embedApplyScroll, embedIsSensitiveField, embedIsTextField, embedKeepsKeys, embedFieldState,
  embedProtocolSource
} from './embed-protocol.js';

/** In-memory `localStorage` / `sessionStorage`, and an empty `document.cookie`, each only where
 *  reading the real one throws. Nothing is kept between loads. */
export function embedAgentStandIns(win) {
  function memoryStorage() {
    const items = new Map();
    const api = {
      getItem: function (key) { key = String(key); return items.has(key) ? items.get(key) : null; },
      setItem: function (key, value) { items.set(String(key), String(value)); },
      removeItem: function (key) { items.delete(String(key)); },
      clear: function () { items.clear(); },
      key: function (index) { const keys = Array.from(items.keys()); return index >= 0 && index < keys.length ? keys[index] : null; }
    };
    if (typeof Proxy !== 'function') {
      Object.defineProperty(api, 'length', { get: function () { return items.size; } });
      return api;
    }
    // `localStorage.name`, `localStorage.name = value`, `delete localStorage.name`, Object.keys(…).
    return new Proxy(api, {
      get: function (target, name) {
        if (name === 'length') return items.size;
        if (typeof name !== 'string' || name in target) return target[name];
        return items.has(name) ? items.get(name) : undefined;
      },
      set: function (target, name, value) {
        if (typeof name === 'string' && name !== 'length' && !(name in target)) items.set(name, String(value));
        return true;
      },
      has: function (target, name) { return name === 'length' || name in target || (typeof name === 'string' && items.has(name)); },
      deleteProperty: function (target, name) { if (typeof name === 'string') items.delete(name); return true; },
      ownKeys: function () { return Array.from(items.keys()); },
      getOwnPropertyDescriptor: function (target, name) {
        return typeof name === 'string' && items.has(name) ? { value: items.get(name), writable: true, enumerable: true, configurable: true } : undefined;
      }
    });
  }
  const provided = [];
  ['localStorage', 'sessionStorage'].forEach(function (name) {
    let throws = false;
    try { void win[name]; } catch (error) { throws = true; }
    if (!throws) return;
    try {
      const store = memoryStorage();
      Object.defineProperty(win, name, { configurable: true, enumerable: true, get: function () { return store; } });
      provided.push(name);
    } catch (error) { /* the page keeps the real behaviour */ }
  });
  let cookieThrows = false;
  try { void win.document.cookie; } catch (error) { cookieThrows = true; }
  if (cookieThrows) {
    try {
      Object.defineProperty(win.document, 'cookie', { configurable: true, enumerable: true, get: function () { return ''; }, set: function () {} });
      provided.push('cookie');
    } catch (error) { /* as above */ }
  }
  return provided;
}

/**
 * Start the agent in `win`. Returns "started", "again" (an agent was already running in this
 * document and has announced itself again) or "alone" (the document is not inside a frame, so
 * there is no parent to talk to; only the storage stand-ins apply).
 */
export function embedAgentMain(win) {
  const doc = win.document;
  const limits = embedLimits();

  // Our own <script> element goes first, whatever happens next. Injected by the main process there
  // is no element (`currentScript` is null).
  try {
    const own = doc.currentScript;
    if (own && own.parentNode) own.parentNode.removeChild(own);
  } catch (error) { /* nothing to remove */ }

  // One agent per document. The marker is the one thing the agent leaves on a global: a function
  // that re-announces, under a registered symbol, holding no token.
  const marker = Symbol.for('tw.embed.agent');
  let earlier;
  try { earlier = win[marker]; } catch (error) { earlier = null; }
  if (earlier !== undefined) {
    if (typeof earlier === 'function') { try { earlier(); } catch (error) { /* not ours to repair */ } }
    return 'again';
  }

  embedAgentStandIns(win);

  let parentWindow = null;
  try { parentWindow = win.parent; } catch (error) { parentWindow = null; }
  if (!parentWindow || parentWindow === win) {
    try { Object.defineProperty(win, marker, { value: function () {} }); } catch (error) { /* a second run repeats the stand-in check, harmlessly */ }
    return 'alone';
  }

  let token = '';        // closure only
  let role = 'none';
  let awaitingHello = false;

  function post(kind, fields) {
    const message = embedBuildMessage(kind, token, fields);
    if (!message) return;
    // The target cannot be an origin: from file:// the deck's origin is opaque (design 5.3).
    try { parentWindow.postMessage(message, '*'); } catch (error) { /* the parent is gone */ }
  }
  function announce() {
    awaitingHello = true;
    post('ready', null);
  }

  // ── Fields that are never captured and never replayed into ──────────────────────────────────
  // A field seen as sensitive stays so for this document, so a "show password" control that
  // turns type=password into type=text does not start a capture.
  const seenSensitive = new WeakSet();
  function isSensitive(element) {
    if (!element || element.nodeType !== 1) return false;
    if (embedIsSensitiveField(element)) { seenSensitive.add(element); return true; }
    return seenSensitive.has(element);
  }

  // ── Capture ─────────────────────────────────────────────────────────────────────────────────
  // Only events the browser made (isTrusted): an event a page script dispatches is the page's own
  // behaviour and happens again by itself in the other copy.
  function capturing(event) { return role === 'capture' && token !== '' && event.isTrusted === true; }

  // A click on a <label> makes the browser click the labelled control straight after. The other
  // copy does the same from the label's click, so the second click is not sent.
  let labelledControl = null;
  function onClick(event) {
    if (!capturing(event)) return;
    const target = event.target;
    if (!target || target.nodeType !== 1) return;
    if (labelledControl !== null && target === labelledControl) { labelledControl = null; return; }
    labelledControl = null;
    const label = typeof target.closest === 'function' ? target.closest('label') : null;
    const control = label ? label.control : null;
    if (control && control !== target && !control.contains(target)) {
      labelledControl = control;
      win.setTimeout(function () { labelledControl = null; }, 0);
    }
    const width = win.innerWidth || 0;
    const height = win.innerHeight || 0;
    const point = width > 0 && height > 0 ? { x: event.clientX / width, y: event.clientY / height } : null;
    const el = embedDescribeElement(doc, target, point);
    if (el) post('click', { el: el });
  }

  function onValue(event) {
    if (!capturing(event)) return;
    const target = event.target;
    if (!target || target.nodeType !== 1 || isSensitive(target)) return;
    const state = embedFieldState(target);
    if (!state) return;
    const el = embedDescribeElement(doc, target, null);
    if (!el) return;
    // A value over the limit fails validation in post(): it is not sent, never cut short.
    post(event.type === 'change' ? 'change' : 'input', state.checked !== undefined ? { el: el, checked: state.checked } : { el: el, value: state.value });
  }

  function onKeydown(event) {
    if (token === '' || event.isTrusted !== true) return;
    const target = event.target;
    const element = target && target.nodeType === 1 ? target : null;
    const sensitive = isSensitive(element);
    const plain = !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && event.isComposing !== true;
    if (plain && limits.forwardKeys.indexOf(event.key) >= 0 && !embedKeepsKeys(element) && !sensitive) {
      event.preventDefault();
      post('key', { key: event.key });
    }
    if (role !== 'capture' || !element || sensitive || embedIsTextField(element)) return;
    const el = embedDescribeElement(doc, element, null);
    if (el) post('keydown', { el: el, key: String(event.key), code: String(event.code || '') });
  }

  // Scroll: at most one message per element per animation frame.
  const scrolled = new Set();
  let scrollScheduled = false;
  function flushScroll() {
    scrollScheduled = false;
    const targets = Array.from(scrolled);
    scrolled.clear();
    if (role !== 'capture' || token === '') return;
    for (let i = 0; i < targets.length; i += 1) {
      const target = targets[i];
      if (target === doc) {
        const scroller = doc.scrollingElement || doc.documentElement;
        if (!scroller) continue;
        const at = embedScrollFractions(scroller);
        post('scroll', { el: { path: [], tag: '' }, fx: at.fx, fy: at.fy });
        continue;
      }
      if (isSensitive(target)) continue;
      const described = embedDescribeElement(doc, target, null);
      if (!described) continue;
      const where = embedScrollFractions(target);
      post('scroll', { el: described, fx: where.fx, fy: where.fy });
    }
  }
  function onScroll(event) {
    if (role !== 'capture' || token === '') return;
    const target = event.target;
    if (target !== doc && (!target || target.nodeType !== 1)) return;
    if (!scrolled.has(target) && scrolled.size >= limits.scrollPendingMax) return;
    scrolled.add(target);
    if (scrollScheduled) return;
    scrollScheduled = true;
    if (typeof win.requestAnimationFrame === 'function') win.requestAnimationFrame(flushScroll);
    else win.setTimeout(flushScroll, 16);
  }

  // ── Replay ──────────────────────────────────────────────────────────────────────────────────
  function replay(message) {
    const target = embedResolveElement(doc, message.el);
    if (!target) return;
    if (message.k === 'scroll') {
      if (!isSensitive(target)) embedApplyScroll(target, message.fx, message.fy);
      return;
    }
    if (message.k === 'click') {
      const x = typeof message.el.px === 'number' ? message.el.px * (win.innerWidth || 0) : 0;
      const y = typeof message.el.py === 'number' ? message.el.py * (win.innerHeight || 0) : 0;
      target.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true, composed: true, view: win, clientX: x, clientY: y }));
      return;
    }
    if (isSensitive(target)) return;
    if (message.k === 'keydown') {
      if (embedIsTextField(target)) return;
      target.dispatchEvent(new win.KeyboardEvent('keydown', { key: message.key, code: message.code, bubbles: true, cancelable: true, composed: true, view: win }));
      return;
    }
    // input / change: only into a field of the same sort, and never one a person could not change.
    const state = embedFieldState(target);
    if (!state || target.disabled === true) return;
    if (message.checked !== undefined) {
      if (state.checked === undefined) return;
      // The replayed click has usually set it already, and fired the page's listeners itself.
      if (target.checked === message.checked) return;
      target.checked = message.checked;
    } else {
      if (state.value === undefined || target.readOnly === true) return;
      if (target.value !== message.value) target.value = message.value;
    }
    target.dispatchEvent(new win.Event(message.k, { bubbles: true, composed: true }));
  }

  // ── Messages from the deck ──────────────────────────────────────────────────────────────────
  function onMessage(event) {
    try {
      if (event.source !== parentWindow) return; // a sibling frame, a child frame, the page itself
      const data = event.data;
      if (data === null || typeof data !== 'object' || data.tw !== limits.tag) return; // not ours: the page's own traffic
      event.stopImmediatePropagation();
      const message = embedValidateMessage(data);
      if (!message) return;
      if (message.k === 'hello') {
        if (!awaitingHello) return; // only the first one after an announcement
        awaitingHello = false;
        token = message.t;
        role = message.role;
        return;
      }
      if (token === '' || message.t !== token) return;
      if (!embedSendsToFrame(role, message.k)) return;
      replay(message);
    } catch (error) { /* a bad message changes nothing */ }
  }

  win.addEventListener('message', onMessage, true);
  doc.addEventListener('click', onClick, true);
  doc.addEventListener('input', onValue, true);
  doc.addEventListener('change', onValue, true);
  doc.addEventListener('keydown', onKeydown, true);
  doc.addEventListener('scroll', onScroll, true);
  doc.addEventListener('focusin', function (event) { isSensitive(event.target); }, true);

  try { Object.defineProperty(win, marker, { value: announce }); } catch (error) { /* a second run would then start a second agent; the deck's record is per frame, so nothing else changes */ }
  announce();
  return 'started';
}

/** The agent with the protocol it needs, as one self-contained script text. It contains neither
 *  "</script" nor "<!--", so it can be written into a <script> element as it is. */
export function embedAgentSource() {
  return [
    '(function () {',
    '"use strict";',
    embedProtocolSource(),
    embedAgentStandIns.toString(),
    embedAgentMain.toString(),
    'embedAgentMain(window);',
    '})();'
  ].join('\n');
}
