// =============================================================================
// POLL FRAME — the ONE rendering of an authored poll: at rest (compiled into the slide) and live
// (the projection, the presenter's current-slide preview, the Quick poll popup).
//
// Ticket 5 compiled a `{poll=…}` heading into a presenter-visible frame (question, poll type, the
// authored options, join slot, state chip) so the editor preview, the thumbnails and the handout
// stopped showing an empty slide. The live projection then REPLACED that frame with a second
// composition of its own (poll-display.js `markup`: a 3.25cqw h1, four options per page, a
// "Page 1 of 2" footer) — so what Dominik saw in the preview and what the audience saw once the
// poll opened were two different slides (Ticket 23, 2026-09-13).
//
// This module is now the only place the poll composition is written. The compiler calls
// `renderPollFrame(poll, { title })` for the at-rest frame; the runtime (poll-display.js, injected
// into the deck through `pollFrameRuntimeSource()` alongside it) calls the SAME function with live
// state — votes, counts, open/closed, join URL/QR, the chosen view — and only fills the slots the
// frame defines. The frame is the layout; the runtime is state. Both render inside the slide's own
// `.slide-content`, so the deck's type scale and autofit act on both identically.
//
// Markup grammar (poll-frame.css; the projection, the parity gate and later tickets rely on it):
//   section.poll-frame[data-poll-frame="compiled"|"live"][data-poll-id][data-poll-type]
//                     [data-poll-state="ready|open|stopped"][data-poll-view="question|results"][data-poll-page]
//     header.poll-frame-head > p.poll-frame-eyebrow > span.poll-frame-kind
//                            > h2.poll-frame-question
//     div.poll-frame-body    > div.poll-frame-answers  (options | matrix | responses | warning)
//                            + aside.poll-frame-join > div.poll-frame-qr + p.poll-frame-join-url
//                              (only when a real join link exists — never invented)
//     footer.poll-frame-foot > span.poll-frame-instruction (question view) | span.poll-frame-total (results view)
//                            + p.poll-frame-join-note (until a real join exists)
//                            + span.poll-frame-page (only when the results page)
//                            + span.poll-frame-chip[data-poll-chip]
// Answers:
//   ol.poll-frame-options > li.poll-frame-option > span.poll-frame-letter + span.poll-frame-option-label
//     (choice and ranking; in results view each row also carries span.poll-frame-count and
//      i.poll-frame-bar — the bar sits BEHIND the option text, in the row, never in a second layout;
//      a ranking result letters its rows by place: span.poll-frame-letter.poll-frame-place)
//   ol.poll-frame-matrix > li.poll-frame-matrix-row > p.poll-frame-matrix-item
//                        + p.poll-frame-matrix-summary (results) + div.poll-frame-matrix-labels
//                        > span.poll-frame-matrix-label (> strong.poll-frame-matrix-count in results)
//     (rating and categorisation; scale labels are spans in a div, NOT a nested list — the deck's
//      nested-list rules would force display:block on any list inside a list)
//   div.poll-frame-responses > article.poll-frame-response > p    (open response results)
//   p.poll-frame-empty                                             (open results with nothing to show)
//   p.poll-frame-warning                                           (a poll missing its options)
//   ol.poll-frame-board > li.poll-frame-board-column[data-column-id=<option id>]       (a board, ADR-0032)
//     > p.poll-frame-board-name > span.poll-frame-board-label + span.poll-frame-board-count
//     + p.poll-frame-board-hint (only while the column is empty) + div.poll-frame-board-cards
//       > article.poll-frame-board-card.is-example > p + small  (the example card: first column of an
//         empty board, dashed, never counted)
//     A board's instructions sit under the question: header > p.poll-frame-board-instructions.
//   A LIVE board (ctx.board, ticket 04; every screen renders the worker's `boardView`, it never
//   recomputes what waits) fills the same columns: div.poll-frame-board-cards > article.poll-frame-board-card
//     (a group is .is-group: span.poll-frame-board-num + p + span.poll-frame-board-x ×n), and each
//     column ends with p.poll-frame-board-more "+ n more on your phone" while cards wait. The join
//     strip lives in the foot (span.poll-frame-board-qr + div.poll-frame-board-join); an empty open
//     board puts a large join beside the columns instead (div.poll-frame-board-empty > aside.poll-frame-board-bigjoin).
//     frame[data-board-state="open|closed|frozen"]. pollFrameFitBoard(frame) picks the largest card
//     text at which no column overflows (data-fit-step).
// =============================================================================

// Duplicated from src/shared/metadata-registry.ts (the compiler is plain .mjs and cannot import the
// TypeScript registries). scripts/test-poll-frame.mjs asserts parity with the registry, so the frame
// never drifts from the vocabulary the authoring surfaces show.
export const POLL_TYPE_LABELS = {
  single: "Single choice",
  multiple: "Multiple choice",
  open: "Open response",
  ranking: "Ranking",
  rating: "Rating",
  categorisation: "Categorisation",
  board: "Board",
};

// ADR-0017 poll lifecycle as the chip reads it. The compiled frame is always `ready`; the runtime
// supplies `open` and `stopped`. Results are a VIEW of a stopped or live poll, not a fourth state —
// the eyebrow says "Poll results" while the chip keeps telling the audience whether voting is on.
export const POLL_STATE_LABELS = {
  ready: "Ready to open",
  open: "Accepting responses",
  stopped: "Responses closed",
};

// The smallest card text (px on the 1280×720 canvas) a board holds while it stays within its default
// limit of 24 entries (ADR-0032 amendment 3); pollFrameFitBoard's steps down to 1.25cqw = 16px.
// Below it only a board released past the limit ("Show all") is allowed to go.
export const BOARD_MIN_CARD_PX = 16;

export const POLL_JOIN_PLACEHOLDER = "Join link appears when the session is live";
const EYEBROW_QUESTION = "Audience poll";
const EYEBROW_RESULTS = "Poll results";

// No import: this file is also inlined into the deck runtime (pollFrameRuntimeSource), so it must
// stand alone. Same escaping as 00-html.mjs escapeHtml.
function pollFrameEscape(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function pollFrameIsMatrix(type) {
  return type === "rating" || type === "categorisation";
}

// A poll slide is framed when the compiler produced a poll definition for it. A carousel slide
// builds its own stepped body, so it keeps that body and is left alone.
export function pollFrameEligible(slide) {
  const poll = slide?.poll;
  if (!poll || typeof poll !== "object" || typeof poll.pollId !== "string" || !poll.pollId) return false;
  if (!Object.hasOwn(POLL_TYPE_LABELS, poll.type)) return false;
  return !(Array.isArray(slide.carousel) && slide.carousel.length);
}

// What the audience does — one sentence, printed once, in the footer. The phone form and the
// projection read this same line because they read this same function.
export function pollFrameInstruction(poll, options) {
  if (poll.type === "board") {
    const cards = Number(poll.board?.cardsPerPhone) || 5;
    const length = Number(poll.board?.cardChars) || 140;
    return `Add up to ${cards} card${cards === 1 ? "" : "s"}, ${length} characters each.`;
  }
  const positions = poll.rankCount ?? options.length;
  if (poll.type === "ranking") {
    return positions === options.length
      ? `Rank all ${positions} choices.`
      : `Rank your top ${positions} choices.`;
  }
  if (pollFrameIsMatrix(poll.type)) return `Choose one label for each item.${poll.allowSkip ? " You may skip items." : ""}`;
  if (poll.type === "single") return "Choose one answer.";
  if (poll.type === "multiple") return `Select up to ${poll.maxSelections ?? options.length} options.`;
  if (poll.maxSubmissions === null) return "Submit as many answers as you like.";
  const submissions = poll.maxSubmissions ?? 1;
  return `Submit up to ${submissions} answer${submissions === 1 ? "" : "s"} per participant.`;
}

function pollFrameLetter(index) {
  return index < 26 ? String.fromCharCode(65 + index) : String(index + 1);
}

// Choice and ranking polls show lettered lanes; the audience reads the same letters on their
// phone, so the frame must letter them identically. In results view each lane carries its count
// and a bar behind the text (`--poll-fill`), and a ranking lane is lettered by its place.
function pollFrameRenderOptions(rows, results) {
  const items = rows.map((row, index) => {
    const letter = results && row.place !== undefined
      ? `<span class="poll-frame-letter poll-frame-place">${row.place === null ? "" : pollFrameEscape(`${row.joint ? "Joint " : ""}${row.place}.`)}</span>`
      : `<span class="poll-frame-letter">${pollFrameEscape(pollFrameLetter(row.index ?? index))}</span>`;
    const label = `<span class="poll-frame-option-label">${row.continued ? '<small class="poll-frame-continued">Continued: </small>' : ""}${pollFrameEscape(row.label)}</span>`;
    if (!results) return `<li class="poll-frame-option">${letter}${label}</li>`;
    const percent = Math.max(0, Math.min(100, Number(row.percent) || 0));
    return `<li class="poll-frame-option is-result" style="--poll-fill:${percent}%">${letter}${label}<span class="poll-frame-count">${pollFrameEscape(row.countText ?? "")}</span><i class="poll-frame-bar" aria-hidden="true"></i></li>`;
  }).join("");
  // A shared place ("Joint 1.") needs a wider lane than a letter; every row in the list takes it so
  // the lanes stay aligned.
  const joint = results && rows.some((row) => row.joint && row.place !== null);
  return `<ol class="poll-frame-options${joint ? " has-joint" : ""}">${items}</ol>`;
}

// Rating and categorisation lay every item against every scale label — the comparison grid
// ADR-0022 locked for the projection, at rest and live. In results view every chip carries its
// count and share and fills behind its text (`--poll-fill`); the row states its denominator.
function pollFrameRenderMatrix(options, labels, matrix) {
  const rows = options.map((option, index) => {
    const result = matrix?.[option.optionId];
    const chips = labels.map((label) => {
      const cell = result?.labels?.[label.optionId];
      if (!cell) return `<span class="poll-frame-matrix-label">${pollFrameEscape(label.label)}</span>`;
      const percent = Math.max(0, Math.min(100, Number(cell.percent) || 0));
      return `<span class="poll-frame-matrix-label is-result" style="--poll-fill:${percent}%"><span class="poll-frame-matrix-label-text">${pollFrameEscape(label.label)}</span><strong class="poll-frame-matrix-count">${cell.count} <small>(${percent}%)</small></strong></span>`;
    }).join("");
    const summary = result?.summary ? `<p class="poll-frame-matrix-summary">${pollFrameEscape(result.summary)}</p>` : "";
    return `<li class="poll-frame-matrix-row"><p class="poll-frame-matrix-item"><span class="poll-frame-matrix-number">${index + 1}</span><span class="poll-frame-matrix-text">${pollFrameEscape(option.label)}</span></p>${summary}<div class="poll-frame-matrix-labels" style="--poll-frame-columns:${Math.max(1, labels.length)}">${chips}</div></li>`;
  }).join("");
  return `<ol class="poll-frame-matrix">${rows}</ol>`;
}

function pollFrameRenderResponses(responses) {
  if (!responses.length) return `<p class="poll-frame-empty">No responses to show yet.</p>`;
  const long = responses.some((response) => response.large);
  return `<div class="poll-frame-responses${long ? " is-long-response" : ""}">${responses.map((response) => `<article class="poll-frame-response">${response.continued ? '<small class="poll-frame-continued">Continued</small>' : ""}<p>${pollFrameEscape(response.text)}</p></article>`).join("")}</div>`;
}

// ADR-0032 (round-3 A5, rule 4): the board's columns (its options) with their names and counts; a
// column's hint (board.hints, keyed by option id) shows while it is empty, and the example card sits
// dashed in the first column of an empty board. At rest every column is empty. Text only, escaped.
// `live` (ticket 04) is the render model poll-display.js builds from the worker's boardView:
// { open, frozen, cardCount, columns: [{ columnId, count, waiting, entries: [{ text, group?, count? }] }] }.
function pollFrameRenderBoard(options, board, live) {
  const hints = board?.hints && typeof board.hints === "object" ? board.hints : {};
  const columns = options.map((option) => ({ columnId: option.optionId, label: option.label, hint: typeof hints[option.optionId] === "string" ? hints[option.optionId] : "" }));
  if (!columns.length) {
    return `<p class="poll-frame-warning">This board has no columns yet — add a list of two to four columns under the heading.</p>`;
  }
  const example = typeof board?.example === "string" ? board.example.trim() : "";
  const views = new Map((live && Array.isArray(live.columns) ? live.columns : []).map((view) => [view.columnId, view]));
  const empty = Boolean(live) && !(live.cardCount > 0);
  const items = columns.map((column, index) => {
    const view = views.get(column.columnId);
    const entries = Array.isArray(view?.entries) ? view.entries : [];
    const shown = Number.isSafeInteger(view?.count) ? view.count : 0;
    const waiting = Number.isSafeInteger(view?.waiting) ? view.waiting : 0;
    const hint = typeof column.hint === "string" && column.hint.trim() && (!live || (!entries.length && !shown))
      ? `<p class="poll-frame-board-hint">${pollFrameEscape(column.hint)}</p>` : "";
    const exampleCard = index === 0 && example && (!live || empty)
      ? `<article class="poll-frame-board-card is-example"><p>${pollFrameEscape(example)}</p><small>Example</small></article>` : "";
    const cards = entries.map((entry) => entry.group
      ? `<article class="poll-frame-board-card is-group" data-group="${pollFrameEscape(String(entry.group))}"><span class="poll-frame-board-num">${pollFrameEscape(String(entry.group))}</span><p>${pollFrameEscape(entry.text)}</p>${entry.count > 1 ? `<span class="poll-frame-board-x">×${pollFrameEscape(String(entry.count))}</span>` : ""}</article>`
      : `<article class="poll-frame-board-card"><p>${pollFrameEscape(entry.text)}</p></article>`).join("");
    const more = waiting > 0 ? `<p class="poll-frame-board-more"><b>+ ${waiting} more</b> on your phone</p>` : "";
    return `<li class="poll-frame-board-column" data-column-id="${pollFrameEscape(String(column.columnId ?? ""))}">`
      + `<p class="poll-frame-board-name"><span class="poll-frame-board-label">${pollFrameEscape(column.label)}</span><span class="poll-frame-board-count">${shown}</span></p>`
      + `${hint}<div class="poll-frame-board-cards">${exampleCard}${cards}</div>${more}</li>`;
  }).join("");
  return `<ol class="poll-frame-board" style="--poll-frame-board-columns:${columns.length}">${items}</ol>`;
}

// The join strip of a live board: the QR small, the link large. Only when a real link exists.
function pollFrameRenderBoardJoin(join, big) {
  const shortUrl = typeof join?.shortUrl === "string" ? join.shortUrl : "";
  if (!shortUrl) return "";
  const written = shortUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const qr = typeof join.qrSvg === "string" && join.qrSvg.startsWith("<svg") ? `<span class="poll-frame-board-qr">${join.qrSvg}</span>` : "";
  const label = `<span class="poll-frame-board-join-label">Add a card: open the link or scan</span><span class="poll-frame-board-join-url">${pollFrameEscape(written)}</span>`;
  return big
    ? `<aside class="poll-frame-board-bigjoin">${qr}${label}</aside>`
    : `${qr}<div class="poll-frame-board-join">${label}</div>`;
}

// The foot's lead and chip for a live board, by state: open, closed to new cards, frozen (final).
function pollFrameBoardFoot(live, join) {
  const written = typeof join?.shortUrl === "string" && join.shortUrl ? join.shortUrl.replace(/^https?:\/\//, "").replace(/\/$/, "") : "";
  const total = Number.isSafeInteger(live.cardCount) ? live.cardCount : 0;
  const cards = `${total} card${total === 1 ? "" : "s"}`;
  if (live.frozen) {
    return { state: "frozen", chip: `Final board · ${cards}`,
      lead: `<span class="poll-frame-board-note">The board as the room left it.${written ? ` Slides and links: <b>${pollFrameEscape(written)}</b>` : ""}</span>` };
  }
  if (!live.open) {
    return { state: "closed", chip: `Closed to new cards · ${total}`,
      lead: `<span class="poll-frame-board-note">Closed to new cards.${written ? ` Read the whole board at <b>${pollFrameEscape(written)}</b>` : ""}</span>` };
  }
  if (!written) return { state: "open", chip: `Open · ${cards}`, lead: `<span class="poll-frame-board-note">${POLL_JOIN_PLACEHOLDER}</span>` };
  return { state: "open", chip: `Open · ${cards}`,
    lead: total > 0 ? pollFrameRenderBoardJoin(join, false) : `<span class="poll-frame-board-note">Cards appear here as they arrive. No names are shown.</span>` };
}

// Pick the largest card text at which no column overflows. The steps run from the stage type floor
// down (font size in canvas units, cards per row); the first step where every column's card area
// fits wins. Steps above BOARD_MIN_CQW hold up to the default limit of 24 entries; the lower steps
// exist for a board the presenter has released past the limit ("Show all"). `frame` is a mounted,
// visible poll frame; the result is left on `--poll-frame-board-fs`, `--poll-frame-board-per-row`
// and `data-fit-step`.
export function pollFrameFitBoard(frame) {
  const steps = [["var(--type-floor)", 1], ["1.7cqw", 1], ["1.7cqw", 2], ["1.5cqw", 2], ["1.35cqw", 2], ["1.25cqw", 2], ["1.25cqw", 3], ["1.1cqw", 3], ["0.95cqw", 3], ["0.85cqw", 4], ["0.75cqw", 4]];
  const areas = Array.from(frame.querySelectorAll(".poll-frame-board-cards"));
  if (!areas.length) return "";
  for (const [size, perRow] of steps) {
    frame.style.setProperty("--poll-frame-board-fs", size);
    frame.style.setProperty("--poll-frame-board-per-row", String(perRow));
    if (areas.every((area) => area.scrollHeight <= area.clientHeight + 1)) {
      frame.dataset.fitStep = `${size} x${perRow}`;
      return frame.dataset.fitStep;
    }
  }
  frame.dataset.fitStep = "overflow";
  return "overflow";
}

function pollFrameRenderAnswers(poll, options, labels, view, results, live, join) {
  if (poll.type === "board") {
    const columns = pollFrameRenderBoard(options, poll.board, live);
    if (!live || live.cardCount > 0 || !live.open || live.frozen) return columns;
    const bigJoin = pollFrameRenderBoardJoin(join, true);
    return bigJoin ? `<div class="poll-frame-board-empty">${columns}${bigJoin}</div>` : columns;
  }
  // A poll whose type needs options but carries none must SAY so on the slide. The compiler already
  // warns in the build log (poll-authoring.mjs); an author looking at the slide sees nothing there.
  if (poll.type !== "open" && !options.length) {
    return `<p class="poll-frame-warning">This poll has no options yet — add a list of choices under the heading.</p>`;
  }
  if (pollFrameIsMatrix(poll.type)) {
    if (!labels.length) {
      return `<p class="poll-frame-warning">This poll has no scale labels yet — add a [scale: …] or [categories: …] line under the heading.</p>`;
    }
    return pollFrameRenderMatrix(options, labels, view === "results" ? results?.matrix : null);
  }
  if (poll.type === "open") {
    return view === "results" ? pollFrameRenderResponses(Array.isArray(results?.responses) ? results.responses : []) : "";
  }
  if (view === "results") {
    const rows = Array.isArray(results?.options) && results.options.length ? results.options : options.map((option, index) => ({ ...option, index, percent: 0, countText: "" }));
    return pollFrameRenderOptions(rows, true);
  }
  return pollFrameRenderOptions(options.map((option, index) => ({ ...option, index })), false);
}

// A live session supplies the joining link and its QR; at compile time there is none, so the slot
// says so rather than inventing a URL. The join column exists ONLY when a real link exists (T19):
// the pending note lives in the footer, never as an empty right column.
function pollFrameRenderJoin(join) {
  const shortUrl = typeof join?.shortUrl === "string" ? join.shortUrl : "";
  if (!shortUrl) {
    return "";
  }
  const written = shortUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const qr = typeof join.qrSvg === "string" && join.qrSvg.startsWith("<svg") ? `<div class="poll-frame-qr">${join.qrSvg}</div>` : "";
  return `<aside class="poll-frame-join">${qr}<p class="poll-frame-join-url">${pollFrameEscape(written)}</p></aside>`;
}

/**
 * Render the poll frame for one poll definition — at rest (compiler) or live (runtime).
 *
 * @param {object} poll  A `pollDefinitionFor` result (pollId, type, question, options, labels, …).
 * @param {{
 *   title?: string,
 *   state?: "ready"|"open"|"stopped",
 *   view?: "question"|"results",
 *   live?: boolean,
 *   join?: {shortUrl?: string, qrSvg?: string},
 *   page?: number, pages?: number,
 *   results?: {
 *     options?: Array<{optionId: string, label: string, index?: number, percent: number, countText: string, place?: number|null, joint?: boolean, continued?: boolean}>,
 *     matrix?: Record<string, {summary?: string, labels: Record<string, {count: number, percent: number}>}>,
 *     responses?: Array<{responseId: string, text: string, continued?: boolean, large?: boolean}>,
 *     total?: string,
 *   },
 * }} [ctx]
 * @returns {string} HTML for one `section.poll-frame`, or "" when there is no poll to frame.
 */
export function renderPollFrame(poll, ctx = {}) {
  if (!poll || typeof poll !== "object" || !Object.hasOwn(POLL_TYPE_LABELS, poll.type)) return "";
  const options = Array.isArray(poll.options) ? poll.options.filter((option) => option && typeof option.label === "string") : [];
  const labels = Array.isArray(poll.labels) ? poll.labels.filter((label) => label && typeof label.label === "string") : [];
  const question = String(poll.question ?? ctx.title ?? "").trim();
  // A live board (ctx.board) has its own three states; the frame's data-poll-state follows them.
  const live = poll.type === "board" && ctx.board && typeof ctx.board === "object" ? ctx.board : null;
  const boardFoot = live ? pollFrameBoardFoot(live, ctx.join) : null;
  const state = boardFoot ? (boardFoot.state === "open" ? "open" : "stopped")
    : Object.hasOwn(POLL_STATE_LABELS, ctx.state) ? ctx.state : "ready";
  const view = ctx.view === "results" && !live ? "results" : "question";
  const kind = POLL_TYPE_LABELS[poll.type];
  const questionHtml = question ? `<h2 class="poll-frame-question">${pollFrameEscape(question)}</h2>` : "";
  const boardInstructions = poll.type === "board" && typeof poll.board?.instructions === "string" && poll.board.instructions.trim()
    ? `<p class="poll-frame-board-instructions">${pollFrameEscape(poll.board.instructions)}</p>` : "";
  const instruction = options.length || poll.type === "open" || poll.type === "board" ? pollFrameInstruction(poll, options) : "";
  // A live board puts its join in the foot (or large beside an empty board), never in the body.
  const joinHtml = live ? "" : pollFrameRenderJoin(ctx.join);
  const pendingJoinHtml = joinHtml || live ? "" : `<p class="poll-frame-join-note">${POLL_JOIN_PLACEHOLDER}</p>`;
  const pages = Number.isSafeInteger(ctx.pages) && ctx.pages > 1 ? ctx.pages : 1;
  const page = Number.isSafeInteger(ctx.page) && ctx.page >= 0 ? Math.min(ctx.page, pages - 1) : 0;
  const footLead = boardFoot ? boardFoot.lead : view === "results"
    ? (ctx.results?.total ? `<span class="poll-frame-total">${pollFrameEscape(ctx.results.total)}</span>` : "")
    : (instruction ? `<span class="poll-frame-instruction">${pollFrameEscape(instruction)}</span>` : "");
  const pageHtml = pages > 1 ? `<span class="poll-frame-page">Page ${page + 1} of ${pages}</span>` : "";
  const chipText = boardFoot ? boardFoot.chip : POLL_STATE_LABELS[state];
  const boardAttr = boardFoot ? ` data-board-state="${boardFoot.state}"` : "";
  return `<section class="poll-frame${ctx.live ? " is-live" : ""}" data-poll-frame="${ctx.live ? "live" : "compiled"}" data-poll-id="${pollFrameEscape(String(poll.pollId ?? ""))}" data-poll-type="${pollFrameEscape(poll.type)}" data-poll-state="${pollFrameEscape(state)}" data-poll-view="${view}" data-poll-page="${page}"${boardAttr}>`
    + `<header class="poll-frame-head"><p class="poll-frame-eyebrow">${view === "results" ? EYEBROW_RESULTS : EYEBROW_QUESTION}<span class="poll-frame-sep" aria-hidden="true"> · </span><span class="poll-frame-kind">${pollFrameEscape(kind)}</span></p>${questionHtml}${boardInstructions}</header>`
    + `<div class="poll-frame-body"><div class="poll-frame-answers">${pollFrameRenderAnswers(poll, options, labels, view, ctx.results, live, ctx.join)}</div>${joinHtml}</div>`
    + `<footer class="poll-frame-foot">${footLead}${pendingJoinHtml}${pageHtml}<span class="poll-frame-chip" data-poll-chip="${pollFrameEscape(state)}">${pollFrameEscape(chipText)}</span></footer>`
    + `</section>`;
}

// The runtime twin: this module's rendering functions, serialised for the deck's inline script
// (07-assembly injects it before poll-display.js). One source; the compiled frame and the live
// frame cannot drift because they are the same code.
export function pollFrameRuntimeSource() {
  return [
    `const POLL_TYPE_LABELS = ${JSON.stringify(POLL_TYPE_LABELS)};`,
    `const POLL_STATE_LABELS = ${JSON.stringify(POLL_STATE_LABELS)};`,
    `const POLL_JOIN_PLACEHOLDER = ${JSON.stringify(POLL_JOIN_PLACEHOLDER)};`,
    `const EYEBROW_QUESTION = ${JSON.stringify(EYEBROW_QUESTION)};`,
    `const EYEBROW_RESULTS = ${JSON.stringify(EYEBROW_RESULTS)};`,
    ...[pollFrameEscape, pollFrameIsMatrix, pollFrameInstruction, pollFrameLetter, pollFrameRenderOptions, pollFrameRenderMatrix,
      pollFrameRenderResponses, pollFrameRenderBoard, pollFrameRenderBoardJoin, pollFrameBoardFoot, pollFrameFitBoard, pollFrameRenderAnswers, pollFrameRenderJoin, renderPollFrame].map((fn) => fn.toString()),
  ].join("\n");
}
