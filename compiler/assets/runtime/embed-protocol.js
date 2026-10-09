// Embedded pages run in a sandbox (0.38 ticket 11.1): the message vocabulary between the deck and
// the agent script inside an embedded page, and its validation.
// Design: docs/plans/presenting-features-0.38/embed-sandbox-design.md, section 5.
//
// A message is trusted for ONE thing: it describes an event inside the frame it came from. Nothing
// here names a slide or a frame; the deck takes both from its own record of `event.source`.
//
//   { tw: "embed", v: 1, t: "<token>", k: "<kind>", …fields of that kind }
//
//   ready    agent → deck   no fields, no token
//   hello    deck → agent   t, role ("capture" | "replay" | "none")
//   key      agent → deck   t, key (a navigation key or Escape)
//   click    both           t, el
//   input    both           t, el, and exactly one of value (string) or checked (boolean)
//   change   both           as input
//   keydown  both           t, el, key, code
//   scroll   both           t, el, fx, fy (fractions of the scrollable distance, 0 to 1)
//
// `el` is an element address: { path, tag, id?, px?, py? }. `path` is the list of indexes among
// ELEMENT children from the document element. `{ path: [], tag: "" }` means the document itself
// (its scrolling element) and is allowed for scroll only. `px` / `py` (click only) are the click
// point as a fraction of the viewport.
//
// Everything is a pure function: no DOM access outside the arguments, no module state. The same
// function sources are inlined into the embedded page (with the agent, embed-agent.js) and into
// the deck (with the channel, embed-channel.js) through `embedProtocolSource()`, so every name is
// prefixed `embed` and every function is self-contained apart from calls to its siblings here.
// scripts/test-embed-protocol.mjs runs this module and the inlined source.

/** Every limit and list of the protocol, in one frozen object. */
export function embedLimits() {
  if (embedLimits.cache) return embedLimits.cache;
  // A page may ask the deck to STEP, never to jump: no Home, no End (they stay the page's own keys).
  const navKeys = ['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', ' '];
  embedLimits.cache = Object.freeze({
    tag: 'embed',
    version: 1,
    tokenBytes: 16,          // design 5.3: 16 bytes from crypto.getRandomValues
    tokenLength: 32,         // those bytes as lower-case hex
    valueMax: 4096,          // design 5.2: input / change value
    keyMax: 32,              // design 5.2: keydown key
    codeMax: 32,             // design 5.2: keydown code
    idMax: 128,              // design 5.2: element id
    tagMax: 32,              // chosen: longest tag name carried
    pathMax: 64,             // design 5.2: entries in a path
    pathIndexMax: 65535,     // design 5.2: largest path entry
    fractionSlack: 1e-6,     // chosen: rounding tolerance outside 0..1 before a fraction is refused
    ratePerSecond: 60,       // design 5.5
    rateBurst: 120,          // design 5.5
    dropLimit: 2000,         // design 5.5: drops within the window that stop mirroring
    dropWindowMs: 10000,     // design 5.5
    scrollCoalesceMs: 50,    // design 5.5: newest position per element per window
    scrollPendingMax: 32,    // chosen: distinct scrolling elements held per frame per window
    scrollReplaceAllowance: 64, // chosen: superseded scroll messages per window before they count as drops
    keyRateMax: 5,           // design 5.5 (lowered from 20 after review): fewer than this many key messages in the window
    keyRateWindowMs: 1000,   // design 5.5
    helloMax: 8,             // chosen: `ready` messages answered per activation
    navKeys: Object.freeze(navKeys),                        // design 5.5: the stepping keys
    forwardKeys: Object.freeze(navKeys.concat(['Escape'])), // design 5.6
    eventKinds: Object.freeze(['click', 'input', 'change', 'keydown', 'scroll']),
    roles: Object.freeze(['capture', 'replay', 'none'])
  });
  return embedLimits.cache;
}

/** The fields a kind carries beside tw, v and k; null for an unknown kind. A switch, never a lookup
 *  in an object: `k` comes from the message and "constructor" must not find anything. */
export function embedKindFields(kind) {
  switch (kind) {
    case 'ready': return [];
    case 'hello': return ['t', 'role'];
    case 'key': return ['t', 'key'];
    case 'click': return ['t', 'el'];
    case 'input': return ['t', 'el', 'value', 'checked'];
    case 'change': return ['t', 'el', 'value', 'checked'];
    case 'keydown': return ['t', 'el', 'key', 'code'];
    case 'scroll': return ['t', 'el', 'fx', 'fy'];
    default: return null;
  }
}

/** Read the own data properties of a plain object, each exactly once and without running a getter.
 *  Returns a null-prototype holder, or null when the value is not a plain object, has a key outside
 *  `allowed` (symbols included) or has an accessor property. */
export function embedPlainFields(value, allowed) {
  if (value === null || typeof value !== 'object') return null;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length > allowed.length) return null;
  const out = Object.create(null);
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    if (typeof key !== 'string' || allowed.indexOf(key) < 0) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return null;
    out[key] = descriptor.value;
  }
  return out;
}

export function embedIsToken(value) {
  if (typeof value !== 'string' || value.length !== embedLimits().tokenLength) return false;
  for (let i = 0; i < value.length; i += 1) {
    const c = value.charCodeAt(i);
    if (!((c >= 48 && c <= 57) || (c >= 97 && c <= 102))) return false;
  }
  return true;
}

/** 16 random bytes as the token string. Throws on anything else: there is no weaker fallback. */
export function embedTokenFromBytes(bytes) {
  const limits = embedLimits();
  if (!bytes || typeof bytes.length !== 'number' || bytes.length !== limits.tokenBytes) throw new Error('embed: token needs ' + limits.tokenBytes + ' random bytes');
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i];
    if (typeof byte !== 'number' || byte < 0 || byte > 255 || Math.floor(byte) !== byte) throw new Error('embed: token bytes must be bytes');
    out += (byte < 16 ? '0' : '') + byte.toString(16);
  }
  return out;
}

/** A string of 1 to `max` characters (or 0 to `max` with `allowEmpty`). */
export function embedIsText(value, max, allowEmpty) {
  return typeof value === 'string' && value.length <= max && (allowEmpty === true || value.length > 0);
}

/** A tag name as carried in an address: ASCII letters, digits, `-`, `_`, `.`, `:`. */
export function embedIsTagName(value) {
  if (!embedIsText(value, embedLimits().tagMax, false)) return false;
  for (let i = 0; i < value.length; i += 1) {
    const c = value.charCodeAt(i);
    const ok = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45 || c === 95 || c === 46 || c === 58;
    if (!ok) return false;
  }
  return true;
}

/** An element id as carried in an address: 1 to 128 characters, no control characters. */
export function embedIsIdText(value) {
  if (!embedIsText(value, embedLimits().idMax, false)) return false;
  for (let i = 0; i < value.length; i += 1) {
    const c = value.charCodeAt(i);
    if (c < 32 || c === 127) return false;
  }
  return true;
}

/** A fraction: a finite number in 0..1. A rounding error just outside is clamped; anything further
 *  out, NaN and the infinities return null. */
export function embedReadFraction(value) {
  if (typeof value !== 'number' || value !== value || value === Infinity || value === -Infinity) return null;
  const slack = embedLimits().fractionSlack;
  if (value < -slack || value > 1 + slack) return null;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** A copy of a path: a real, dense array of at most 64 integers 0..65535. Null otherwise. */
export function embedReadPath(value) {
  const limits = embedLimits();
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  const length = lengthDescriptor ? lengthDescriptor.value : -1;
  if (typeof length !== 'number' || length < 0 || length > limits.pathMax) return null;
  if (Reflect.ownKeys(value).length !== length + 1) return null; // a hole, or a key that is not an index
  const out = [];
  for (let i = 0; i < length; i += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return null;
    const entry = descriptor.value;
    if (typeof entry !== 'number' || entry < 0 || entry > limits.pathIndexMax || Math.floor(entry) !== entry) return null;
    out.push(entry);
  }
  return out;
}

/** A rebuilt element address for a message of `kind`, or null. */
export function embedReadAddress(value, kind) {
  const fields = embedPlainFields(value, ['path', 'tag', 'id', 'px', 'py']);
  if (!fields) return null;
  const path = embedReadPath(fields.path);
  if (!path) return null;
  const hasId = 'id' in fields;
  const hasPoint = 'px' in fields || 'py' in fields;
  if (fields.tag === '') {
    // The document itself: scroll only, and nothing else in the address.
    if (kind !== 'scroll' || path.length !== 0 || hasId || hasPoint) return null;
    return { path: path, tag: '' };
  }
  if (!embedIsTagName(fields.tag)) return null;
  if (hasId && !embedIsIdText(fields.id)) return null;
  if (!hasPoint) return hasId ? { path: path, tag: fields.tag, id: fields.id } : { path: path, tag: fields.tag };
  if (kind !== 'click') return null;
  const px = embedReadFraction(fields.px);
  const py = embedReadFraction(fields.py);
  if (px === null || py === null) return null;
  return hasId ? { path: path, tag: fields.tag, id: fields.id, px: px, py: py } : { path: path, tag: fields.tag, px: px, py: py };
}

/** The strict reading behind embedValidateMessage. May throw; the caller turns that into null. */
export function embedReadMessage(message) {
  const limits = embedLimits();
  if (message === null || typeof message !== 'object') return null;
  const head = embedPlainFields(message, ['tw', 'v', 'k', 't', 'role', 'key', 'el', 'value', 'checked', 'code', 'fx', 'fy']);
  if (!head || head.tw !== limits.tag || head.v !== limits.version || typeof head.k !== 'string') return null;
  const kind = head.k;
  const names = embedKindFields(kind);
  if (!names) return null;
  const fields = embedPlainFields(message, ['tw', 'v', 'k'].concat(names));
  if (!fields) return null;
  if (kind === 'ready') return { tw: limits.tag, v: limits.version, k: 'ready' };
  if (!embedIsToken(fields.t)) return null;
  const token = fields.t;
  if (kind === 'hello') {
    if (typeof fields.role !== 'string' || limits.roles.indexOf(fields.role) < 0) return null;
    return { tw: limits.tag, v: limits.version, t: token, k: 'hello', role: fields.role };
  }
  if (kind === 'key') {
    if (typeof fields.key !== 'string' || limits.forwardKeys.indexOf(fields.key) < 0) return null;
    return { tw: limits.tag, v: limits.version, t: token, k: 'key', key: fields.key };
  }
  const el = embedReadAddress(fields.el, kind);
  if (!el) return null;
  if (kind === 'click') return { tw: limits.tag, v: limits.version, t: token, k: 'click', el: el };
  if (kind === 'input' || kind === 'change') {
    const hasValue = 'value' in fields;
    const hasChecked = 'checked' in fields;
    if (hasValue === hasChecked) return null; // exactly one of the two
    if (hasChecked) {
      if (typeof fields.checked !== 'boolean') return null;
      return { tw: limits.tag, v: limits.version, t: token, k: kind, el: el, checked: fields.checked };
    }
    if (!embedIsText(fields.value, limits.valueMax, true)) return null;
    return { tw: limits.tag, v: limits.version, t: token, k: kind, el: el, value: fields.value };
  }
  if (kind === 'keydown') {
    if (!embedIsText(fields.key, limits.keyMax, false) || !embedIsText(fields.code, limits.codeMax, true)) return null;
    return { tw: limits.tag, v: limits.version, t: token, k: 'keydown', el: el, key: fields.key, code: fields.code };
  }
  if (kind === 'scroll') {
    const fx = embedReadFraction(fields.fx);
    const fy = embedReadFraction(fields.fy);
    if (fx === null || fy === null) return null;
    return { tw: limits.tag, v: limits.version, t: token, k: 'scroll', el: el, fx: fx, fy: fy };
  }
  return null;
}

/**
 * Validate a received message. Returns a NEW object built only from validated fields (never the
 * received object, and sharing no object with it), or null. Null for: anything that is not a plain
 * object, an unknown kind, a missing or extra key, a wrong type, a string over its limit, a
 * non-finite or out-of-range number, a path too long, an accessor property, and anything that
 * throws while being read. Where `structuredClone` exists a Proxy anywhere in the message is also
 * refused (a Proxy cannot be cloned); without it the message's values are still read once each.
 */
export function embedValidateMessage(message) {
  try {
    const out = embedReadMessage(message);
    if (!out) return null;
    if (typeof structuredClone === 'function') structuredClone(message);
    return out;
  } catch (error) {
    return null;
  }
}

/** Build an outgoing message of `kind` from `fields` and validate it. Null when it would not pass. */
export function embedBuildMessage(kind, token, fields) {
  const limits = embedLimits();
  const names = embedKindFields(kind);
  if (!names) return null;
  const message = { tw: limits.tag, v: limits.version, k: kind };
  for (let i = 0; i < names.length; i += 1) {
    const name = names[i];
    if (name === 't') message.t = token;
    else if (fields && fields[name] !== undefined) message[name] = fields[name];
  }
  return embedValidateMessage(message);
}

/** A validated event message without its envelope: what the deck forwards to its peer window.
 *  `{ k, el, …fields }`; carries no token. Null for a message that is not one of the five events. */
export function embedEventDescription(message) {
  if (!message || embedLimits().eventKinds.indexOf(message.k) < 0) return null;
  switch (message.k) {
    case 'click': return { k: 'click', el: message.el };
    case 'keydown': return { k: 'keydown', el: message.el, key: message.key, code: message.code };
    case 'scroll': return { k: 'scroll', el: message.el, fx: message.fx, fy: message.fy };
    default:
      return message.checked !== undefined ? { k: message.k, el: message.el, checked: message.checked } : { k: message.k, el: message.el, value: message.value };
  }
}

/** The reverse: a validated message for one frame from an event description received from the
 *  peer window. The description is validated as strictly as a message from a frame. */
export function embedMessageFromDescription(token, description) {
  try {
    const fields = embedPlainFields(description, ['k', 'el', 'value', 'checked', 'key', 'code', 'fx', 'fy']);
    if (!fields || typeof fields.k !== 'string' || embedLimits().eventKinds.indexOf(fields.k) < 0) return null;
    if (typeof structuredClone === 'function') structuredClone(description);
    return embedBuildMessage(fields.k, token, fields);
  } catch (error) {
    return null;
  }
}

/** Kinds the deck accepts FROM a frame it gave `role` (design 5.3). */
export function embedAcceptsFromFrame(role, kind) {
  if (kind === 'ready' || kind === 'key') return true;
  return role === 'capture' && embedLimits().eventKinds.indexOf(kind) >= 0;
}

/** Kinds the deck sends TO a frame it gave `role` (design 5.3). */
export function embedSendsToFrame(role, kind) {
  if (kind === 'hello') return true;
  return role === 'replay' && embedLimits().eventKinds.indexOf(kind) >= 0;
}

/** The role a window gives its live frame: the presenter captures, the projector replays, every
 *  other window (plain deck, share page) only has keys forwarded. */
export function embedRoleForWindow(windowKind) {
  return windowKind === 'presenter' ? 'capture' : windowKind === 'projector' ? 'replay' : 'none';
}

/**
 * The rule for honouring a `key` message (design 5.5).
 *
 * A stepping key (arrows, PageUp, PageDown, Space) needs all of:
 *   - `engaged`: since this frame was made live, the DECK itself observed a trusted press that the
 *     person aimed at this frame (Interact with E or the chip; a click on the presenter's Current
 *     pane), and has observed no trusted press elsewhere since. Nothing a page does sets this: a
 *     page can focus itself, and the deck window's user activation stays live for seconds after
 *     the presenter's own key press, so neither of the next two proves the person is in the page;
 *   - `frameHasFocus`: the deck's focused element is that frame;
 *   - `userActive`: a live user activation in the deck window (the real key press gives one);
 *   - `recentCount` below the limit: key messages from that frame in the last second, this one
 *     not counted.
 * Escape only hands the keyboard back to the deck, so it needs the focus and the rate alone (the
 * Escape key gives no user activation, and a page that focused itself must be leavable).
 */
export function embedKeyDecision(key, engaged, frameHasFocus, userActive, recentCount) {
  const limits = embedLimits();
  if (typeof key !== 'string' || limits.forwardKeys.indexOf(key) < 0) return false;
  if (frameHasFocus !== true) return false;
  if (typeof recentCount !== 'number' || !(recentCount < limits.keyRateMax)) return false;
  if (key === 'Escape') return true;
  return engaged === true && userActive === true;
}

// ── Rate limit ────────────────────────────────────────────────────────────────────────────────
// A token bucket per frame (60 a second, burst 120). Each refusal is a drop; 2,000 drops within
// ten seconds stop the limiter for good (the deck makes a new one when the frame is next live).

export function embedCreateLimiter(now) {
  const limits = embedLimits();
  return { tokens: limits.rateBurst, at: now, dropSlots: [], dropSlotAt: [], stopped: false };
}

/** Count one drop. Returns true when this drop is the one that stops the limiter. */
export function embedLimiterDrop(limiter, now) {
  const limits = embedLimits();
  if (limiter.stopped) return false;
  const slotMs = 1000;
  const slotCount = Math.ceil(limits.dropWindowMs / slotMs) + 1; // the window, plus the slot in progress
  const slot = Math.floor(now / slotMs);
  const index = ((slot % slotCount) + slotCount) % slotCount;
  if (limiter.dropSlotAt[index] !== slot) { limiter.dropSlotAt[index] = slot; limiter.dropSlots[index] = 0; }
  limiter.dropSlots[index] += 1;
  let total = 0;
  for (let i = 0; i < slotCount; i += 1) {
    const at = limiter.dropSlotAt[i];
    if (typeof at === 'number' && slot - at >= 0 && slot - at < slotCount) total += limiter.dropSlots[i];
  }
  if (total < limits.dropLimit) return false;
  limiter.stopped = true;
  return true;
}

/** Take one event from the bucket. True: forward it. False: dropped (and counted). */
export function embedLimiterTake(limiter, now) {
  const limits = embedLimits();
  if (limiter.stopped) return false;
  const elapsed = now > limiter.at ? now - limiter.at : 0;
  limiter.tokens = Math.min(limits.rateBurst, limiter.tokens + (elapsed * limits.ratePerSecond) / 1000);
  if (now > limiter.at) limiter.at = now;
  if (limiter.tokens >= 1) { limiter.tokens -= 1; return true; }
  embedLimiterDrop(limiter, now);
  return false;
}

// ── Elements ──────────────────────────────────────────────────────────────────────────────────
// The DOM is only ever reached through the arguments: a document, an element.

export function embedElementTag(element) {
  if (!element) return '';
  if (typeof element.localName === 'string') return element.localName;
  return typeof element.tagName === 'string' ? element.tagName.toLowerCase() : '';
}

/** The elements carrying exactly this id (an attribute selector, so a duplicate id is seen). */
export function embedElementsWithId(doc, id) {
  if (!embedIsIdText(id) || !doc || typeof doc.querySelectorAll !== 'function') return [];
  return doc.querySelectorAll('[id="' + id.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"]');
}

/**
 * The address of an element: its element-child path from the document element, its tag, its id
 * when that id is unique in the document, and for a click the point (`point` is `{ x, y }` as
 * fractions of the viewport). Null when the element cannot be addressed: not an element, a tag
 * name outside the carried alphabet, or a path beyond the bounds with no unique id to fall back on.
 */
export function embedDescribeElement(doc, element, point) {
  const limits = embedLimits();
  if (!doc || !element || element.nodeType !== 1) return null;
  const tag = embedElementTag(element);
  if (!embedIsTagName(tag)) return null;
  const root = doc.documentElement;
  let path = [];
  let node = element;
  let inBounds = true;
  while (node !== root) {
    const parent = node.parentElement;
    if (!parent || path.length >= limits.pathMax) { inBounds = false; break; }
    const index = Array.prototype.indexOf.call(parent.children, node);
    if (index < 0 || index > limits.pathIndexMax) { inBounds = false; break; }
    path.unshift(index);
    node = parent;
  }
  let id = '';
  if (typeof element.id === 'string' && element.id) {
    const same = embedElementsWithId(doc, element.id);
    if (same.length === 1 && same[0] === element) id = element.id;
  }
  if (!inBounds) {
    if (!id) return null;
    path = [];
  }
  const out = { path: path, tag: tag };
  if (id) out.id = id;
  if (point) {
    const px = embedReadFraction(Math.min(1, Math.max(0, Number(point.x))));
    const py = embedReadFraction(Math.min(1, Math.max(0, Number(point.y))));
    if (px !== null && py !== null) { out.px = px; out.py = py; }
  }
  return out;
}

/**
 * Find the element a validated address names: by id when exactly one element has it and the tag
 * matches; else by path when the tag matches; else, when the address carries a point (a click),
 * the element at that point. The document address gives the scrolling element. Null when nothing
 * resolves.
 */
export function embedResolveElement(doc, address) {
  if (!doc || !address || !doc.documentElement) return null;
  const root = doc.documentElement;
  if (address.tag === '') return address.path.length === 0 ? (doc.scrollingElement || root) : null;
  if (address.id !== undefined) {
    const same = embedElementsWithId(doc, address.id);
    if (same.length === 1 && embedElementTag(same[0]) === address.tag) return same[0];
  }
  let node = root;
  for (let i = 0; i < address.path.length && node; i += 1) {
    const children = node.children;
    node = children && address.path[i] < children.length ? children[address.path[i]] : null;
  }
  if (node && embedElementTag(node) === address.tag) return node;
  if (typeof address.px === 'number' && typeof address.py === 'number' && typeof doc.elementFromPoint === 'function') {
    const view = doc.defaultView;
    const width = view && typeof view.innerWidth === 'number' ? view.innerWidth : root.clientWidth;
    const height = view && typeof view.innerHeight === 'number' ? view.innerHeight : root.clientHeight;
    return doc.elementFromPoint(address.px * width, address.py * height) || null;
  }
  return null;
}

/** Where an element is scrolled to, as fractions of its scrollable distance (0 when it has none). */
export function embedScrollFractions(element) {
  const rangeX = (element.scrollWidth || 0) - (element.clientWidth || 0);
  const rangeY = (element.scrollHeight || 0) - (element.clientHeight || 0);
  const fx = rangeX > 0 ? (element.scrollLeft || 0) / rangeX : 0;
  const fy = rangeY > 0 ? (element.scrollTop || 0) / rangeY : 0;
  return { fx: fx < 0 ? 0 : fx > 1 ? 1 : fx, fy: fy < 0 ? 0 : fy > 1 ? 1 : fy };
}

/** Scroll an element to fractions of ITS scrollable distance (window sizes may differ). */
export function embedApplyScroll(element, fx, fy) {
  const rangeX = (element.scrollWidth || 0) - (element.clientWidth || 0);
  const rangeY = (element.scrollHeight || 0) - (element.clientHeight || 0);
  const left = rangeX > 0 ? fx * rangeX : 0;
  const top = rangeY > 0 ? fy * rangeY : 0;
  // At once, whatever the page's own scroll-behavior: the copy is sent every position on the way,
  // and a smooth scroll restarted for each one would lag behind (and stand still in a hidden window).
  if (typeof element.scrollTo === 'function') {
    try { element.scrollTo({ left: left, top: top, behavior: 'instant' }); return; } catch (error) { /* an older engine: set the properties */ }
  }
  element.scrollLeft = left;
  element.scrollTop = top;
}

/** The `type` of an <input>, lower-case; '' for anything else. */
export function embedInputType(element) {
  if (embedElementTag(element) !== 'input') return '';
  const type = typeof element.type === 'string' && element.type ? element.type : 'text';
  return type.toLowerCase();
}

/**
 * A field whose content is never captured and never replayed into (design 5.2, ticket 06):
 * a password input, or any field whose `autocomplete` has the token one-time-code,
 * current-password or new-password, or a token starting cc- (payment card details).
 */
export function embedIsSensitiveField(element) {
  if (!element || element.nodeType !== 1) return false;
  if (embedInputType(element) === 'password') return true;
  const attribute = typeof element.getAttribute === 'function' ? element.getAttribute('autocomplete') : null;
  if (typeof attribute !== 'string') return false;
  const tokens = attribute.toLowerCase().split(/\s+/);
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === 'one-time-code' || token === 'current-password' || token === 'new-password' || token.indexOf('cc-') === 0) return true;
  }
  return false;
}

/** A place where keys are text: a textarea, an editable element, or an input that takes typing. */
export function embedIsTextField(element) {
  if (!element || element.nodeType !== 1) return false;
  if (element.isContentEditable === true) return true;
  const tag = embedElementTag(element);
  if (tag === 'textarea') return true;
  if (tag !== 'input') return false;
  const notTyped = ['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image', 'hidden'];
  return notTyped.indexOf(embedInputType(element)) < 0;
}

/** Where a navigation key belongs to the page and is not forwarded to the deck (design 5.6):
 *  a text field, a <select> or an editable element. */
export function embedKeepsKeys(element) {
  return embedIsTextField(element) || embedElementTag(element) === 'select';
}

/**
 * What an `input` / `change` event on this element carries: `{ checked }` for a checkbox or radio,
 * `{ value }` for another input, a textarea or a select, null for anything else (a file input, an
 * editable element, a custom element). Says nothing about sensitivity; the caller checks that.
 */
export function embedFieldState(element) {
  if (!element || element.nodeType !== 1) return null;
  const tag = embedElementTag(element);
  if (tag === 'input') {
    const type = embedInputType(element);
    if (type === 'checkbox' || type === 'radio') return { checked: element.checked === true };
    if (type === 'file' || type === 'button' || type === 'submit' || type === 'reset' || type === 'image' || type === 'hidden') return null;
    return typeof element.value === 'string' ? { value: element.value } : null;
  }
  if (tag === 'textarea' || tag === 'select') return typeof element.value === 'string' ? { value: element.value } : null;
  return null;
}

/** The functions above as script text, for inlining beside the agent or the channel. */
export function embedProtocolSource() {
  return [
    embedLimits, embedKindFields, embedPlainFields, embedIsToken, embedTokenFromBytes, embedIsText, embedIsTagName,
    embedIsIdText, embedReadFraction, embedReadPath, embedReadAddress, embedReadMessage, embedValidateMessage,
    embedBuildMessage, embedEventDescription, embedMessageFromDescription, embedAcceptsFromFrame, embedSendsToFrame,
    embedRoleForWindow, embedKeyDecision, embedCreateLimiter, embedLimiterDrop, embedLimiterTake, embedElementTag,
    embedElementsWithId, embedDescribeElement, embedResolveElement, embedScrollFractions, embedApplyScroll,
    embedInputType, embedIsSensitiveField, embedIsTextField, embedKeepsKeys, embedFieldState
  ].map((fn) => fn.toString()).join('\n');
}
