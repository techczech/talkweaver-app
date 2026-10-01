// The venue screen's board (ADR-0032, ticket 04). The venue page is a follower: the worker sends it
// the audience view of each board (`poll.state` with `boardState`), and this draws it into the
// board's own slide with the SAME frame the big screen and the audience window use — the poll frame
// renderer (poll-frame.mjs) fed through poll-display.js, then sized by pollFrameFitBoard. Injected
// after both (01-cli-utils boardScreenRuntimeSource), only into the venue page.
//
// options: { slides: () => Element[]   every slide element of the page,
//            join: () => {shortUrl, qrSvg}   the link phones join by (the talk's handout link) }
function createBoardScreen(options) {
  const display = createPollDisplay();
  const states = new Map(); // slideId -> the safe poll state last received for that slide

  const compiledFrame = (slide) => slide.querySelector('[data-poll-frame="compiled"]');
  const liveFrame = (slide) => slide.querySelector('[data-poll-frame="live"]');
  const slideFor = (slideId) => options.slides().find((slide) => slide.dataset.id === slideId) || null;

  function fit(slide) {
    if (!slide.classList.contains('active') || typeof pollFrameFitBoard !== 'function') return;
    slide.querySelectorAll('.poll-frame[data-poll-type="board"]:not([hidden])').forEach(pollFrameFitBoard);
  }

  function paint(slideId) {
    const slide = slideFor(slideId);
    const state = states.get(slideId);
    if (!slide || !state) return;
    const html = display.markup(state, { started: true, view: 'question', page: 0, join: options.join() });
    if (!html) return;
    const compiled = compiledFrame(slide);
    const live = liveFrame(slide);
    if (compiled) {
      compiled.hidden = true;
      if (live) live.outerHTML = html; else compiled.insertAdjacentHTML('afterend', html);
    } else if (live) live.outerHTML = html;
    else return;
    slide.classList.add('has-poll-display');
    fit(slide);
  }

  // A board state from the worker. The slide it belongs to is named by the state itself.
  function receive(message) {
    const state = display.safeState(message);
    if (!state || state.pollType !== 'board' || !state.slideId) return;
    states.set(state.slideId, state);
    paint(state.slideId);
  }

  // The venue moved to another slide: the board now on screen picks its card size (a hidden slide
  // has no layout to measure).
  function slideChanged() {
    for (const slideId of states.keys()) {
      const slide = slideFor(slideId);
      if (slide) fit(slide);
    }
  }

  return { receive, slideChanged };
}
