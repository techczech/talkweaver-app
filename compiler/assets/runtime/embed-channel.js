// Embedded pages run in a sandbox (0.38 ticket 11.1): the deck side of the channel. One channel
// per deck window owns the record of every live embedded frame in that window.
// Design: docs/plans/presenting-features-0.38/embed-sandbox-design.md, sections 5.3 to 5.5.
//
//   const channel = embedCreateChannel({ onEvent, onKey, onReady });
//   channel.activate(frame, { slide, index, role });   // BEFORE the frame is given its document
//   channel.deliver(frame, description);               // projector: an event from the presenter
//   channel.deactivate(frame);                         // on leaving the slide
//
// What it guarantees, whatever a frame sends:
//   - a frame is known by `event.source` only. A message from a window with no record is ignored;
//   - the slide and the embed index handed to `onEvent` / `onKey` come from the record made in
//     `activate`. No message has a field for either;
//   - a message counts only with the token of the CURRENT activation of its frame and a kind the
//     frame's role allows; `deactivate` drops the record, so a late message finds nothing;
//   - what reaches `onEvent` is a new object built from validated fields (embed-protocol.js);
//   - per frame at most 60 events a second (burst 120) reach `onEvent`; 2,000 drops within ten
//     seconds stop mirroring from that frame until it is deactivated, with one console warning.
//     A message that fails validation, the token or the role counts as a drop;
//   - scroll is reduced to the newest position per element per 50 ms before it is counted;
//   - `onKey` is called for a stepping key only when the key is in the fixed list, the deck has
//     ENGAGED the frame (`engage(frame)`: the deck's own record of a trusted press the person aimed
//     at that frame; nothing a frame sends can set it), the deck's focused element is that frame,
//     the deck has a live user activation, and fewer than 5 key messages came from the frame in
//     the last second. Escape needs the focus and the rate only.
// The clock, the random source, the focus reader, the activation reader and the timers can be
// injected, which is how scripts/test-embed-channel.mjs runs it without a browser.

import {
  embedLimits, embedValidateMessage, embedBuildMessage, embedEventDescription, embedMessageFromDescription,
  embedAcceptsFromFrame, embedTokenFromBytes, embedKeyDecision, embedCreateLimiter, embedLimiterDrop, embedLimiterTake,
  embedProtocolSource
} from './embed-protocol.js';
import { embedCreateFocusGuard } from './embed-focus.js';

/**
 * @param {object} [options]
 * @param {(frame: { slide: unknown, index: unknown, frame: unknown }, event: object) => void} [options.onEvent]
 *   a validated captured event (`{ k, el, … }`, no token) from a frame with role "capture"
 * @param {(frame: object, key: string) => void} [options.onKey] a navigation key or "Escape" to honour
 * @param {(frame: object) => void} [options.onReady] the frame's agent has been sent `hello`
 * @param {Window} [options.window] the deck window (default: the global `window`)
 * @param {() => number} [options.now] milliseconds, monotonic
 * @param {(count: number) => ArrayLike<number>} [options.randomBytes]
 * @param {() => boolean} [options.isUserActive]
 * @param {() => unknown} [options.activeElement]
 * @param {(fn: () => void, ms: number) => unknown} [options.setTimer]
 * @param {(handle: unknown) => void} [options.clearTimer]
 * @param {(text: string) => void} [options.warn]
 * @param {boolean} [options.listen] false: do not add the `message` listener (call handleMessage)
 */
export function embedCreateChannel(options) {
  const settings = options || {};
  const limits = embedLimits();
  const host = settings.window || (typeof window !== 'undefined' ? window : null);
  const now = settings.now || function () { return host && host.performance ? host.performance.now() : Date.now(); };
  const randomBytes = settings.randomBytes || function (count) { return host.crypto.getRandomValues(new Uint8Array(count)); };
  // No userActivation API (an old browser): keys are never honoured there. Refusing is the safe side.
  const isUserActive = settings.isUserActive || function () { return Boolean(host && host.navigator && host.navigator.userActivation && host.navigator.userActivation.isActive); };
  const activeElement = settings.activeElement || function () { return host && host.document ? host.document.activeElement : null; };
  const setTimer = settings.setTimer || function (fn, ms) { return host.setTimeout(fn, ms); };
  const clearTimer = settings.clearTimer || function (handle) { host.clearTimeout(handle); };
  const warn = settings.warn || function (text) { if (typeof console !== 'undefined') console.warn(text); };
  const records = new Map(); // the frame's contentWindow → its record

  function identity(record) { return { slide: record.slide, index: record.index, frame: record.frame }; }
  function call(fn, record, value) {
    if (typeof fn !== 'function') return;
    try { fn(identity(record), value); } catch (error) { /* a consumer's error is not the frame's business */ }
  }
  function isCurrent(record) { return records.get(record.window) === record; }
  function clearScroll(record) {
    if (record.scrollTimer !== null) { clearTimer(record.scrollTimer); record.scrollTimer = null; }
    record.scroll.clear();
  }
  // Every count goes through these two, so the moment a frame is cut off is seen exactly once.
  function noteStop(record, wasStopped) {
    if (wasStopped || !record.limiter.stopped) return;
    clearScroll(record);
    warn('TalkWeaver: an embedded page sent too many messages; copying it to the other screen is off until its slide is left.');
  }
  function drop(record, at) {
    const wasStopped = record.limiter.stopped;
    embedLimiterDrop(record.limiter, at);
    noteStop(record, wasStopped);
  }
  function take(record, at) {
    const wasStopped = record.limiter.stopped;
    const allowed = embedLimiterTake(record.limiter, at);
    noteStop(record, wasStopped);
    return allowed;
  }
  function flushScroll(record) {
    record.scrollTimer = null;
    if (!isCurrent(record) || record.limiter.stopped) { record.scroll.clear(); return; }
    const at = now();
    const pending = Array.from(record.scroll.values());
    record.scroll.clear();
    record.scrollReplaced = 0;
    record.scrollFlushedAt = at;
    for (let i = 0; i < pending.length && !record.limiter.stopped; i += 1) {
      if (take(record, at)) call(settings.onEvent, record, embedEventDescription(pending[i]));
    }
  }
  function queueScroll(record, message, at) {
    const key = message.el.path.join('.') + '|' + message.el.tag + '|' + (message.el.id === undefined ? '' : message.el.id);
    if (record.scroll.has(key)) {
      record.scrollReplaced += 1;
      if (record.scrollReplaced > limits.scrollReplaceAllowance) {
        drop(record, at);
        if (record.limiter.stopped) return;
      }
    } else if (record.scroll.size >= limits.scrollPendingMax) {
      drop(record, at);
      return;
    }
    record.scroll.set(key, message);
    if (record.scrollTimer !== null) return;
    const wait = record.scrollFlushedAt + limits.scrollCoalesceMs - at;
    if (wait <= 0) flushScroll(record);
    else record.scrollTimer = setTimer(function () { flushScroll(record); }, wait);
  }
  function handleKey(record, message, at) {
    const times = record.keyTimes;
    while (times.length > 0 && at - times[0] >= limits.keyRateWindowMs) times.shift();
    const recent = times.length;
    times.push(at);
    if (times.length > limits.keyRateMax) times.shift();
    if (!embedKeyDecision(message.key, record.engaged === true, activeElement() === record.frame, isUserActive() === true, recent)) return;
    call(settings.onKey, record, message.key);
  }

  /** The deck window's one `message` listener for embedded frames. */
  function handleMessage(event) {
    if (!event) return;
    const source = event.source;
    if (!source) return;
    const record = records.get(source);
    if (!record) return; // not a live embedded frame of this window
    const data = event.data;
    if (data === null || typeof data !== 'object') return; // a string (a video player's command) is not ours
    const at = now();
    const message = embedValidateMessage(data);
    if (!message) { drop(record, at); return; }
    if (message.k === 'ready') {
      if (record.hellos >= limits.helloMax) { drop(record, at); return; }
      record.hellos += 1;
      const hello = embedBuildMessage('hello', record.token, { role: record.role });
      // The target cannot be an origin: a sandboxed frame's origin is opaque.
      try { record.window.postMessage(hello, '*'); } catch (error) { return; }
      record.ready = true;
      call(settings.onReady, record, undefined);
      return;
    }
    if (message.t !== record.token || !embedAcceptsFromFrame(record.role, message.k)) { drop(record, at); return; }
    if (message.k === 'key') { handleKey(record, message, at); return; }
    if (record.limiter.stopped) return;
    if (message.k === 'scroll') { queueScroll(record, message, at); return; }
    if (take(record, at)) call(settings.onEvent, record, embedEventDescription(message));
  }

  function find(frame) {
    let found = null;
    records.forEach(function (record) { if (record.frame === frame) found = record; });
    return found;
  }

  /**
   * Start an activation of `frame`: a new token, a new limiter, a new record. Call it before the
   * frame is given its document, so the agent's `ready` finds the record. `identity.role` is
   * "capture", "replay" or "none" (anything else is "none"). False when the frame has no window
   * (it is not in a document) or no token could be made; nothing is recorded then.
   */
  function activate(frame, frameIdentity) {
    deactivate(frame);
    const target = frame ? frame.contentWindow : null;
    if (!target) return false;
    let token;
    try { token = embedTokenFromBytes(randomBytes(limits.tokenBytes)); } catch (error) { return false; }
    const given = frameIdentity || {};
    const at = now();
    records.set(target, {
      frame: frame,
      window: target,
      slide: given.slide,
      index: given.index,
      role: limits.roles.indexOf(given.role) >= 0 ? given.role : 'none',
      token: token,
      limiter: embedCreateLimiter(at),
      ready: false,
      engaged: false,
      hellos: 0,
      keyTimes: [],
      scroll: new Map(),
      scrollTimer: null,
      scrollFlushedAt: -Infinity,
      scrollReplaced: 0
    });
    return true;
  }

  /** End the frame's activation. Messages still on their way from it are ignored. */
  function deactivate(frame) {
    const record = find(frame);
    if (!record) return false;
    clearScroll(record);
    records.delete(record.window);
    return true;
  }

  function deactivateAll() {
    Array.from(records.values()).forEach(function (record) { clearScroll(record); });
    records.clear();
  }

  /**
   * Send an event description (as `onEvent` produced it in the other window) to the frame's agent.
   * Only for a frame activated with role "replay" whose agent has announced itself. The
   * description is validated again here. True when a message was posted.
   */
  function deliver(frame, description) {
    const record = find(frame);
    if (!record || record.role !== 'replay' || !record.ready) return false;
    const message = embedMessageFromDescription(record.token, description);
    if (!message) return false;
    try { record.window.postMessage(message, '*'); } catch (error) { return false; }
    return true;
  }

  /**
   * The deck has just observed a trusted press that the person aimed at this frame (Interact with
   * E or the chip, a click on the presenter's Current pane). Only the deck calls this; no message
   * from a frame can. From now until `disengage`, or until the frame is deactivated, a stepping
   * key the frame forwards may be honoured.
   */
  function engage(frame) {
    const record = find(frame);
    if (!record) return false;
    record.engaged = true;
    return true;
  }
  /** The person has left the page (Escape, a press elsewhere in the deck). */
  function disengage(frame) {
    const record = find(frame);
    if (record) record.engaged = false;
  }
  function disengageAll() {
    records.forEach(function (record) { record.engaged = false; });
  }

  /** For the deck and for tests: null when the frame is not live. Never includes the token. */
  function status(frame) {
    const record = find(frame);
    return record ? { slide: record.slide, index: record.index, role: record.role, ready: record.ready, stopped: record.limiter.stopped, engaged: record.engaged } : null;
  }

  function dispose() {
    deactivateAll();
    if (host && settings.listen !== false && typeof host.removeEventListener === 'function') host.removeEventListener('message', handleMessage);
  }

  if (host && settings.listen !== false && typeof host.addEventListener === 'function') host.addEventListener('message', handleMessage);

  return { activate: activate, deactivate: deactivate, deactivateAll: deactivateAll, deliver: deliver, engage: engage, disengage: disengage, disengageAll: disengageAll, status: status, handleMessage: handleMessage, dispose: dispose };
}

/**
 * The protocol, the channel and the focus guard (embed-focus.js) as one script text for the deck
 * template and the share runtime.
 */
export function embedChannelSource() {
  return embedProtocolSource() + '\n' + embedCreateChannel.toString() + '\n' + embedCreateFocusGuard.toString();
}
