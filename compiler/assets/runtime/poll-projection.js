// Local display lifecycle. Server voting/disclosure and ordinary slide navigation are inputs,
// never side effects of showing, hiding or revisiting a poll.
function createPollProjection(options) {
  const display = createPollDisplay();
  const entries = new Map();
  const key = `${options.storageKey}:poll-display`;
  let join = display.safeJoin(null);
  let sequence = 0;
  let quickPollId = null;
  let quickVisible = false;
  let lastRenderKey = '';

  function definitionFor(slide) {
    try {
      const definition = JSON.parse(slide?.dataset.poll || 'null');
      return definition && typeof definition.pollId === 'string' ? { ...definition, slideId: slide.dataset.id } : null;
    } catch { return null; }
  }

  function entryFor(slide) {
    const definition = definitionFor(slide);
    if (!definition) return null;
    if (entries.has(definition.pollId)) return entries.get(definition.pollId);
    const entry = {
      state: display.safeState({ ...definition, type: 'poll.state', pollType: definition.type, open: false, revealed: false }),
      view: 'question', page: 0, started: false,
    };
    entries.set(definition.pollId, entry);
    return entry;
  }

  function snapshot() {
    return {
      version: 1, sessionId: options.sessionId, sequence,
      join: display.safeJoin(join), quickPollId, quickVisible,
      polls: Array.from(entries.values()).map((entry) => ({
        state: display.safeState(entry.state), view: entry.view === 'results' ? 'results' : 'question',
        page: Number.isSafeInteger(entry.page) && entry.page >= 0 ? entry.page : 0, started: entry.started === true,
      })).filter((entry) => entry.state),
    };
  }

  function applySnapshot(value, force = false) {
    if (!value || value.version !== 1 || value.sessionId !== options.sessionId
      || !Number.isSafeInteger(value.sequence) || value.sequence < sequence
      || (!force && value.sequence === sequence) || !Array.isArray(value.polls)) return;
    entries.clear();
    for (const entry of value.polls) {
      const state = display.safeState(entry?.state);
      if (!state) continue;
      entries.set(state.pollId, { state, view: display.viewFor(state, entry.view),
        page: Number.isSafeInteger(entry.page) && entry.page >= 0 ? entry.page : 0, started: entry.started === true });
    }
    sequence = value.sequence;
    join = display.safeJoin(value.join);
    quickPollId = typeof value.quickPollId === 'string' ? value.quickPollId : null;
    quickVisible = value.quickVisible === true;
    render();
  }

  function publish() {
    if (!options.isPresenter || !options.isPaired) return;
    sequence++;
    const value = snapshot();
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* pairing still works without storage */ }
    options.send({ type: 'talkweaver-poll-display', sessionId: options.sessionId, snapshot: value });
    render();
    options.changed?.();
  }

  function receivePeer(message) {
    if (message?.sessionId !== options.sessionId) return;
    if (options.isPresenter) {
      if (message.type === 'talkweaver-poll-display-request') {
        options.send({ type: 'talkweaver-poll-display', sessionId: options.sessionId, snapshot: snapshot() });
      }
    } else if (message.type === 'talkweaver-poll-display') applySnapshot(message.snapshot);
  }

  function update(message) {
    if (!options.isPresenter) return;
    const state = display.safeState(message);
    if (!state) return;
    const previous = entries.get(state.pollId);
    const newlyRevealed = previous && !previous.state.revealed && state.revealed;
    const view = newlyRevealed ? 'results' : previous?.view || (!state.open && state.revealed ? 'results' : 'question');
    entries.set(state.pollId, { state, view: display.viewFor(state, view), page: previous?.page || 0, started: true });
    publish();
  }

  function choose(pollId, view) {
    const entry = entries.get(pollId);
    if (!options.isPresenter || !entry) return;
    entry.view = display.viewFor(entry.state, view);
    entry.page = 0;
    publish();
  }

  function turnPage(pollId, delta) {
    const entry = entries.get(pollId);
    if (!options.isPresenter || !entry) return;
    const info = display.pageInfo(entry.state, entry.view, entry.page);
    entry.page = Math.max(0, Math.min(info.pages - 1, info.page + delta));
    publish();
  }

  function showQuick(pollId, visible = true) {
    if (!options.isPresenter) return;
    quickPollId = pollId;
    quickVisible = visible;
    publish();
  }

  function markup(entry) {
    return entry?.state ? display.markup(entry.state, { ...entry, join }) : '';
  }

  function quickMarkup() {
    const entry = quickVisible && entries.get(quickPollId);
    return entry?.started ? markup(entry) : '';
  }

  // Ticket 5 compiled the poll frame (`[data-poll-frame="compiled"]`, poll-frame.mjs) into the slide;
  // Ticket 23 makes the live poll THAT SAME FRAME with its state filled (renderPollFrame, called by
  // poll-display.js). The live frame is mounted inside `.slide-content` directly after the compiled
  // one — same container, same type scale, same autofit — the compiled frame is hidden while the live
  // one is mounted and restored when the projection leaves, so a poll slide never shows both and never
  // goes blank. A poll slide with no compiled frame (a carousel) gets a paper host over the slide.
  function compiledFrame(slide) { return slide ? slide.querySelector('[data-poll-frame="compiled"]') : null; }
  function liveFrame(slide) { return slide ? slide.querySelector('[data-poll-frame="live"]') : null; }

  function unmount(slide) {
    liveFrame(slide)?.remove();
    slide.querySelector(':scope > .poll-frame-host')?.remove();
    const frame = compiledFrame(slide);
    if (frame) frame.hidden = false;
    slide.classList.remove('has-poll-display');
  }

  function mount(slide, html) {
    const frame = compiledFrame(slide);
    const live = liveFrame(slide);
    if (frame) {
      frame.hidden = true;
      if (live) live.outerHTML = html; else frame.insertAdjacentHTML('afterend', html);
    } else {
      let host = slide.querySelector(':scope > .poll-frame-host');
      if (!host) { host = document.createElement('div'); host.className = 'poll-frame-host'; slide.appendChild(host); }
      host.innerHTML = html;
    }
    slide.classList.add('has-poll-display');
  }

  // The frame's content changed under the deck's fit pass: run it again so a long option list
  // spends its slack exactly as the compiled frame did (autofitActiveSlides is the template's).
  function refit(slide) {
    if (slide.classList.contains('active') && typeof autofitActiveSlides === 'function') autofitActiveSlides();
  }

  function render() {
    if (!options.isPaired) return;
    const slide = options.getSlide();
    if (!slide) return;
    const entry = entryFor(slide);
    const html = markup(entry);
    const popupHtml = quickMarkup();
    const renderKey = `${slide.dataset.id}\0${html}\0${popupHtml}`;
    if (renderKey === lastRenderKey) return;
    lastRenderKey = renderKey;
    document.querySelectorAll('.slide.has-poll-display').forEach((previous) => {
      if (previous === slide && html) return;
      unmount(previous);
    });
    if (html) { mount(slide, html); refit(slide); }
    let popup = document.getElementById('audienceQuickPollPopup');
    if (!options.isPresenter) {
      if (!popup) {
        popup = document.createElement('div');
        popup.id = 'audienceQuickPollPopup';
        popup.className = 'poll-frame-popup';
        popup.setAttribute('role', 'region');
        popup.setAttribute('aria-label', 'Quick poll');
        options.stage.appendChild(popup);
      }
      popup.hidden = !popupHtml;
      popup.innerHTML = popupHtml;
    }
  }

  // The presenter's Current/Next/Then panes clone the slide: give the clone the same live frame
  // (or the compiled frame back) so the presenter sees exactly the composition the audience sees.
  function decoratePreview(clone, isCurrent) {
    const html = markup(entryFor(clone));
    unmount(clone);
    if (html) mount(clone, html);
    if (isCurrent && quickMarkup()) {
      const popup = document.createElement('div');
      popup.className = 'poll-frame-popup'; popup.innerHTML = quickMarkup();
      clone.appendChild(popup);
    }
  }

  function previewKey(slide, isCurrent) {
    return `${markup(entryFor(slide))}\0${isCurrent ? quickMarkup() : ''}`;
  }

  function info(pollId) {
    const entry = entries.get(pollId);
    return entry ? { ...display.pageInfo(entry.state, entry.view, entry.page), started: entry.started } : { view: 'question', page: 0, pages: 1, started: false };
  }

  function setJoin(value) { join = display.safeJoin(value); publish(); }

  function clear() {
    entries.clear(); join = display.safeJoin(null); quickPollId = null; quickVisible = false;
    publish();
  }

  if (options.isPaired) {
    try { const stored = JSON.parse(localStorage.getItem(key) || 'null'); if (stored) applySnapshot(stored, true); } catch { /* fresh display */ }
    window.addEventListener('storage', (event) => {
      if (options.isPresenter || event.key !== key || !event.newValue) return;
      try { applySnapshot(JSON.parse(event.newValue)); } catch { /* malformed storage is inert */ }
    });
    // The template supplies both BroadcastChannel and opener/window message delivery.
    if (!options.isPresenter) queueMicrotask(() => options.send({ type: 'talkweaver-poll-display-request', sessionId: options.sessionId }));
  }
  return { update, choose, turnPage, showQuick, setJoin, clear, render, decoratePreview, previewKey, info, receivePeer,
    quick: () => ({ pollId: quickPollId, visible: quickVisible }), snapshot };
}
