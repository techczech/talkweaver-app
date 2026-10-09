// Embedded pages and the keyboard (0.38 ticket 11): one guard per window that shows embedded local
// pages, used by the deck template and by the share runtime (inlined with the channel:
// embedChannelSource in embed-channel.js).
// Design: docs/plans/presenting-features-0.38/embed-sandbox-design.md, sections 5.5 and 5.6.
//
//   const guard = embedCreateFocusGuard({ channel, livePresent, inUse, pages, onStopped });
//   guard.visit(slideKey);  // whenever the host lays out its pages: a new key is a new visit
//   guard.watch();          // whenever a page is made live or announces itself
//   guard.release(frame);   // BEFORE a frame is unloaded or removed
//   guard.check();          // the rule, now (the guard also runs it on its own triggers)
//
// THE RULE: an embedded-page frame that the window has not engaged never holds the window's focus.
// A page can put the keyboard focus on itself with no gesture (focus() at load, on a timer). Its
// keys then move nothing (it is not engaged), but the person's own next key press would go to the
// page instead of the deck. So whenever the window's focused element is a live page's frame that
// is not engaged, the window takes the focus back. An engaged frame got its focus from the person
// and is left alone; so are the window's own fields and buttons, the remote site in use and a
// video. A page can also put the focus on ANOTHER frame of the window (window.focus() may be
// called across origins), so the rule covers every frame nobody can have focused by hand: the
// host names them (`guarded`: unloaded pages, frames of slides not shown, previews).
//
// What the rule can see is `document.activeElement`. That is NOT dependable while another frame
// holds the focus because the window's own script put it there (which is what engaging a page
// does): a second page that then focuses itself gets the keyboard while `activeElement` still
// names the first frame, and the window is told nothing. The host therefore keeps no other local
// page live while one embed is in use (the suspension in the template and the share runtime);
// this guard does not try to detect that state.
//
// THE TRIGGERS, all of them: the window's `blur` (a page took the focus from a focused window: at
// once, when the page's script has returned, and a task later), the window's `focus` and
// `visibilitychange` (back from another application or tab), `focusin` in the document, every
// call of watch() (a frame made live, the page's `ready`, the end of an engagement), and an
// interval while a page is live, because the browser raises no event in the window when a page
// takes the focus while the window's own document does not hold it.
//
// A TEXT FIELD of the window (a composer, a search box, a notes field) that a page took the focus
// FROM gets it back, so typing there goes on. Only a loss the PAGE caused counts: a field that
// lost the focus in the same turn as a trusted press of the person's in this document (a pointer
// press anywhere, or Tab, Escape or Enter) was left on purpose and is never given it back, nor is
// one after any such press that came later, nor while an embed is in use, nor a field that is no
// longer in the document or not visible. There is no limit on give-backs: nothing here ever
// leaves a typed character to go to the deck instead of the field.
//
// THE BUDGET. Pages that keep taking the focus are what gets stopped, never the person's typing.
// It is counted per VISIT to a slide, for the window, not per frame: which script asked for a
// focus cannot be known here (a page can put the focus on ANOTHER page's frame, and the frame that
// ends up focused is all this window sees), so a count per frame would stop the wrong page and
// let the one that asked go on. Each time the focus is taken back from a page's frame, in a
// window that HAS the focus and while no embed is in use, is one grab (take-backs less than
// `grabGapMs` apart are one grab: one focus() call can need two; a frame with no record that this
// guard knows counts too; a take-back in the same turn as a trusted press of the person's in this
// window, or within 100 ms after one, is NOT a grab: clicking a page's cover and then the deck,
// over and over, moves the focus on and off the page with no page asking for anything). More than `grabLimit` grabs within `grabWindowMs` (more than 10 within
// 2 seconds) and EVERY page of the slide that is not in use is stopped: `pages()` names them (by
// embed index), they are recorded here, and `onStopped()` tells the host to unload them to their
// placeholders. A page that focuses itself at load, or a few times on timers, stays far below
// that; a loop at any interval up to about 180 ms goes over it within two seconds. A window that
// does not have the focus counts nothing: a page that focuses itself there takes no key from
// anyone (the take-back still happens).
//
// THE RECORD of stopped pages is kept here, in one place, for the deck's slides, the presenter's
// Current pane and the share page alike: `visit(key)` (the host calls it whenever it lays out
// its pages; a new key is a new visit and clears the record and the count), `isStopped(index)`,
// `resume(index)` (the person chose that page: it may run, and is then engaged).

/**
 * @param {object} options
 * @param {{ status: (frame: unknown) => ({ engaged: boolean } | null) }} options.channel
 * @param {() => boolean} options.livePresent whether any embedded local page is live in this window
 * @param {() => unknown} [options.inUse] the embed the person is using now (engaged), or null
 * @param {Window} [options.window] default: the global `window`
 * @param {number} [options.watchMs] the interval while a page is live (default 200)
 * @param {number} [options.restoreMs] how recently a field must have lost the focus (default 400)
 * @param {(frame: Element) => boolean} [options.guarded] a frame without a record that may not hold the focus either
 * @param {() => number[]} [options.pages] the embed indexes of the slide's local pages that are not in use
 * @param {() => void} [options.onStopped] the record of stopped pages has grown: unload them
 * @param {number} [options.grabLimit] default 10
 * @param {number} [options.grabWindowMs] default 2000
 * @param {number} [options.grabGapMs] default 20
 */
export function embedCreateFocusGuard(options) {
  const settings = options || {};
  const host = settings.window || window;
  const doc = host.document;
  const channel = settings.channel;
  const livePresent = settings.livePresent || function () { return false; };
  const inUse = settings.inUse || function () { return null; };
  const watchMs = settings.watchMs || 200;
  const restoreMs = settings.restoreMs || 400;
  const grabLimit = settings.grabLimit || 10;
  const grabWindowMs = settings.grabWindowMs || 2000;
  const grabGapMs = settings.grabGapMs || 20;
  const pressGraceMs = 100;
  const now = function () { return host.performance.now(); };

  // The person's own presses in this document. `pressing` is true for the rest of the turn in
  // which one arrived: a focus change in that turn is theirs. `pressCount` lets a deferred
  // give-back see that a press came after it was scheduled.
  let pressCount = 0;
  let pressing = false;
  let pressedAt = -Infinity;
  // What this window can know of a press INSIDE a frame (it receives no event for one): the frame
  // the pointer is over (boundary events arrive here), and, for a frame of this window's own
  // origin, a trusted pointerdown heard inside it. `permitted` is the frame the person was found
  // to have put the focus on, for as long as it keeps it. `pressedIn` allows ONE arrival of the
  // focus on its frame and is then spent; unspent, it ends with the person's next press anywhere
  // in this document, with a press inside another frame, and with the visit to the slide. It is
  // kept with the DOCUMENT it was heard in ({ frame, inner, at }): a frame whose document has been
  // replaced since (a pane rebuilt between the press and the focus) is not the frame that was
  // pressed. A press inside the frame that already holds the focus by leave makes no record (it
  // has nothing to allow), and whenever a frame's leave ends, for whatever reason, a press still
  // recorded for that frame ends with it (withdraw): nothing is left over to allow a later return.
  let hovered = null;
  let pressedIn = null;
  let permitted = null;
  function withdraw(frame) {
    if (pressedIn && pressedIn.frame === frame) pressedIn = null;
    if (permitted === frame) permitted = null;
  }
  const wired = new WeakSet();
  // The text field that last lost the focus without a press: { el, at, presses }.
  let lost = null;
  let timer = null;
  // This visit: its key, the take-backs counted in it, the embed indexes stopped in it.
  let visitKey = null;
  let grabTimes = [];
  const stopped = new Set();
  // Every LOCAL PAGE's frame (one with a record in the channel) that this guard has been handed or
  // has taken the focus from. A page goes on running for a moment after its frame is emptied
  // (until the empty document replaces it), and its timers can take the focus in that moment: the
  // rule holds for such a frame too, record or no record. No other frame is ever put here: a
  // video or a copy of a slide is asked about again each time the focus arrives on it (`guarded`).
  const known = new WeakSet();
  function remember(frame) { if (channel && channel.status(frame)) known.add(frame); }

  function isTextField(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable) return true;
    return el.tagName === 'INPUT' && !/^(button|checkbox|radio|range|color|file|image|reset|submit)$/i.test(el.type);
  }
  function isShown(el) {
    if (!el.isConnected) return false;
    if (typeof el.checkVisibility === 'function') return el.checkVisibility({ visibilityProperty: true });
    return el.getClientRects().length > 0;
  }
  // One more grab on this slide. True when the slide's pages are now over the budget.
  function overBudget() {
    const at = now();
    if (grabTimes.length > 0 && at - grabTimes[grabTimes.length - 1] < grabGapMs) return false;
    grabTimes = grabTimes.filter(function (time) { return at - time < grabWindowMs; });
    grabTimes.push(at);
    return grabTimes.length > grabLimit;
  }
  // A take-back has just been made from `frame`, in a window that had the focus: count it, and
  // over the budget stop every page of the slide that is not in use.
  function countGrab(frame) {
    if (typeof settings.pages !== 'function' || inUse() || !overBudget()) return;
    grabTimes = [];
    let indexes = [];
    try { indexes = settings.pages() || []; } catch (error) { /* the host's affair */ }
    indexes.forEach(function (index) { stopped.add(index); });
    try { if (typeof settings.onStopped === 'function') settings.onStopped(); } catch (error) { /* the host's affair */ }
    // This may be running inside a page's own focus() call, which puts the focus back on the frame
    // as it returns: take it off the emptied frame when that call is over. (What a page does until
    // it has unloaded is caught as for any frame this guard knows.)
    const letGo = function () { takeBack(frame); };
    host.queueMicrotask(letGo);
    host.setTimeout(letGo, 0);
  }
  /** The host lays out its pages for the slide `key`. True when that is a new visit (the record and the count are cleared). */
  function visit(key) {
    if (key === visitKey) return false;
    visitKey = key;
    pressedIn = null;
    permitted = null;
    grabTimes = [];
    stopped.clear();
    return true;
  }
  function isStopped(index) { return stopped.has(index); }
  /** The person chose this page: it is no longer stopped. */
  function resume(index) { stopped.delete(index); }
  // After the turn the press arrived in. Ahead of timers where the browser can say so: a page's
  // own overdue timer must not run while the press still counts.
  function afterThisTurn(fn) {
    if (host.scheduler && typeof host.scheduler.postTask === 'function') {
      host.scheduler.postTask(fn, { priority: 'user-blocking' }).catch(function () { /* aborted with the page */ });
    } else host.setTimeout(fn, 0);
  }
  function onPress(event) {
    if (!event.isTrusted) return;
    if (event.type === 'keydown' && event.key !== 'Tab' && event.key !== 'Escape' && event.key !== 'Enter') return;
    pressCount += 1;
    pressing = true;
    pressedAt = now();
    lost = null;
    // A press in this document (one inside a frame is not heard here): whatever a press inside a
    // frame still allowed is over, and so is a frame's leave to hold the focus once it has lost it.
    pressedIn = null;
    if (permitted && doc.activeElement !== permitted) withdraw(permitted);
    const mine = pressCount;
    afterThisTurn(function () { if (pressCount === mine) pressing = false; });
  }

  /**
   * Move the focus from `frame`, when it holds it, to the window's own document. Also the unload
   * step: a frame removed or emptied while it holds the focus leaves the document with no focus at
   * all (document.hasFocus() false), and the browser then reports nothing when the next page takes
   * it. True when the frame held the focus.
   */
  function release(frame) {
    if (!frame) return false;
    remember(frame);
    // The frame is going (unloaded, emptied, removed): no press in it and no leave outlives that.
    withdraw(frame);
    return takeBack(frame);
  }
  // The same without the record: the rule's own take-back, from any frame.
  function takeBack(frame) {
    if (!frame || doc.activeElement !== frame) return false;
    // Only a window that has the focus asks for it: a window behind another application must not
    // come to the front because a page focused itself.
    const windowFocused = doc.hasFocus();
    const field = lost;
    lost = null;
    try { frame.blur(); } catch (error) { /* ignore */ }
    if (windowFocused) { try { host.focus(); } catch (error) { /* ignore */ } }
    if (field && now() - field.at <= restoreMs) {
      // Not here: this may be running inside the page's own focus() call (the window's `blur` is
      // raised from within it), and a focus set there is undone when that call completes: the
      // field would look focused while the keys went to the page. As soon as the page's script
      // has returned (a microtask), and once more a task later. Each time, everything is asked again.
      const giveBack = function () {
        if (field.given || field.presses !== pressCount || pressing || inUse()) return;
        // The focus is on the document, or on a frame the rule would take it from anyway (a page
        // can go on to a second frame in the same script): the field takes it. On anything else
        // (another field, a button, a frame that may hold it) it stays where it is.
        const active = doc.activeElement;
        if (active && active !== doc.body && active !== frame && !mayNotHoldFocus(active)) return;
        if (!isShown(field.el)) return;
        field.given = true;
        try { field.el.focus({ preventScroll: true }); } catch (error) { /* ignore */ }
      };
      host.queueMicrotask(giveBack);
      host.setTimeout(giveBack, 0);
    }
    return true;
  }

  // Whether the rule takes the focus from this element: a page's frame that is not engaged; a
  // frame with no record that this guard has known as a page's (a page a moment ago), or one the host says
  // nobody can have put the focus on by hand (`guarded`: an unloaded page, a frame of a slide that
  // is not shown, a preview): a page can put the focus on ANY frame of the window. Anything else
  // (a video the person clicked, the remote site in use) is left alone.
  function mayNotHoldFocus(el) {
    if (!channel || !el || el.tagName !== 'IFRAME') return false;
    const status = channel.status(el);
    if (status) return !status.engaged;
    return known.has(el) || (typeof settings.guarded === 'function' && Boolean(settings.guarded(el)));
  }

  // A frame of this window's own origin: hear the person's presses inside it.
  function wire(frame) {
    try {
      const inner = frame.contentDocument;
      if (!inner || wired.has(inner)) return;
      wired.add(inner);
      frame.contentWindow.addEventListener('pointerdown', function (event) {
        if (!event.isTrusted) return;
        // Inside the frame that holds the focus by leave: nothing to record. A leave that names a
        // frame the focus is no longer on (this one, or another) is over, with anything recorded for it.
        if (permitted === frame && doc.activeElement === frame) return;
        if (permitted) withdraw(permitted);
        pressedIn = { frame: frame, inner: inner, at: now() };
      }, true);
    } catch (error) { /* another origin: nothing can be heard there */ }
  }
  /**
   * Did the PERSON put the focus on this frame? For the host's `guarded`, about a frame that takes
   * presses (a video, a copy of a slide the person selects text in). A frame of this window's own
   * origin: only when a trusted pointerdown was heard inside it just before. A frame of another
   * origin: nothing can be heard, so when the pointer is over it (which a press needs; a script
   * that focuses a frame the pointer happens to rest on is not told apart). Once found so, the
   * frame may keep the focus until the focus goes elsewhere. Asking SPENDS the press heard inside
   * the frame: it allows this one arrival of the focus, never a later one (a script that puts the
   * focus back on the frame after the person has gone elsewhere finds nothing to go by).
   */
  function pressedOn(frame) {
    const press = pressedIn && pressedIn.frame === frame ? pressedIn : null;
    if (press) pressedIn = null;
    if (permitted === frame) return true;
    let inner = null;
    try { inner = frame.contentDocument; } catch (error) { inner = null; }
    const yes = inner ? Boolean(press && press.inner === inner && frame.isConnected && now() - press.at < 1000) : hovered === frame;
    if (yes) permitted = frame;
    return yes;
  }

  /** The rule, now. True when the focus was taken back from a frame. */
  function check() {
    const el = doc.activeElement;
    if (permitted && el !== permitted) withdraw(permitted);
    if (!mayNotHoldFocus(el)) return false;
    const windowFocused = doc.hasFocus();
    // A press of the person's own in this window, in this turn or just before: the focus is on its
    // way somewhere because of it (the end of an engagement is checked before the press has moved
    // the focus off the page). The focus is still taken back; it is not a grab by a page.
    const byThePerson = pressing || now() - pressedAt < pressGraceMs;
    remember(el);
    if (!takeBack(el)) return false;
    // The budget (the field the focus was taken from is given it back as after any other grab).
    if (windowFocused && !byThePerson) countGrab(el);
    return true;
  }

  /** Check now, and keep checking while any page is live in this window. The interval ends itself. */
  function watch() {
    check();
    if (timer !== null || !channel) return;
    timer = host.setInterval(function () {
      if (!livePresent()) { host.clearInterval(timer); timer = null; return; }
      check();
    }, watchMs);
  }

  if (channel) {
    host.addEventListener('blur', function () { check(); host.queueMicrotask(check); host.setTimeout(check, 0); });
    host.addEventListener('focus', function () { check(); });
    doc.addEventListener('visibilitychange', function () { check(); });
    // Focus arriving on an element of this document: the rule first; any other arrival means the
    // person (or the window's own code) has put the focus somewhere, and no field is owed anything.
    doc.addEventListener('focusin', function () { if (!check()) lost = null; }, true);
    doc.addEventListener('focusout', function (event) {
      lost = !pressing && isTextField(event.target) ? { el: event.target, at: now(), presses: pressCount, given: false } : null;
    }, true);
    // Where the pointer is, as far as frames go; and a listener inside a frame of our own origin
    // the moment the pointer reaches it (before any press there).
    doc.addEventListener('pointerover', function (event) {
      const target = event.target;
      hovered = target && target.tagName === 'IFRAME' ? target : null;
      if (hovered) wire(hovered);
    }, true);
    doc.documentElement.addEventListener('pointerleave', function () { hovered = null; });
    // A touch moves the focus when the finger lifts, a mouse when the button goes down.
    ['pointerdown', 'pointerup', 'mousedown', 'click', 'keydown'].forEach(function (type) { host.addEventListener(type, onPress, true); });
  }

  return { check: check, watch: watch, release: release, visit: visit, isStopped: isStopped, resume: resume, pressedOn: pressedOn };
}
