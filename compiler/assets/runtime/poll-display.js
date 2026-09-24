// Injected into the portable presenter runtime AFTER the poll frame renderer (poll-frame.mjs,
// `pollFrameRuntimeSource`). Keep this boundary independent of presenter UI: its return values
// are the only poll data allowed into paired-window messages and storage.
//
// Ticket 23: this module no longer owns a poll composition. It derives STATE — the safe public
// snapshot, the chosen view, the result rows and their shares, the response pages — and hands it
// to `renderPollFrame`, the same function the compiler used to paint the frame into the slide.
// One composition; the runtime only fills the slots the frame defines.
function createPollDisplay() {
  const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;

  function safeState(message) {
    if (!message || typeof message.pollId !== 'string' || !message.pollId
      || !['single', 'multiple', 'open', 'ranking', 'rating', 'categorisation'].includes(message.pollType)
      || !['held', 'live'].includes(message.visibility)) return null;
    const options = (Array.isArray(message.options) ? message.options : [])
      .filter((option) => option && typeof option.optionId === 'string' && typeof option.label === 'string')
      .map((option) => ({ optionId: option.optionId, label: option.label }));
    const safe = {
      type: 'poll.state', pollId: message.pollId, pollType: message.pollType,
      question: typeof message.question === 'string' ? message.question : '',
      options, visibility: message.visibility, open: message.open === true, revealed: message.revealed === true,
      ...(message.pollType === 'multiple' && Number.isSafeInteger(message.maxSelections) && message.maxSelections > 0 && message.maxSelections <= options.length ? { maxSelections: message.maxSelections } : {}),
      ...(message.pollType === 'open' && (message.maxSubmissions === null || (Number.isSafeInteger(message.maxSubmissions) && message.maxSubmissions > 0)) ? { maxSubmissions: message.maxSubmissions } : {}),
      ...(typeof message.slideId === 'string' && message.slideId ? { slideId: message.slideId } : {}),
    };
    if (safe.pollType === 'ranking') {
      if (message.rankCount !== undefined) {
        if (!Number.isSafeInteger(message.rankCount) || message.rankCount < 1 || message.rankCount > options.length) return null;
        safe.rankCount = message.rankCount;
      }
    } else if (isMatrix(safe)) {
      if (!Array.isArray(message.labels) || !message.labels.length
        || (message.allowSkip !== undefined && typeof message.allowSkip !== 'boolean')) return null;
      if (message.labels.some((label) => !label || typeof label.optionId !== 'string' || !label.optionId.trim()
        || typeof label.label !== 'string' || !label.label.trim())
        || new Set(message.labels.map((label) => label.optionId)).size !== message.labels.length) return null;
      safe.labels = message.labels.map((label) => ({ optionId: label.optionId, label: label.label }));
      if (message.allowSkip !== undefined) safe.allowSkip = message.allowSkip;
    }
    if (safe.visibility !== 'live' && !safe.revealed) return safe;
    if (safe.pollType === 'open') {
      safe.responses = (Array.isArray(message.responses) ? message.responses : [])
        .filter((response) => response && response.hidden !== true && typeof response.text === 'string' && typeof response.responseId === 'string')
        .map((response) => ({ responseId: response.responseId, text: response.text }));
    } else if (isMatrix(safe)) {
      safe.categoryTallies = Object.fromEntries(options.map((option) => [option.optionId,
        Object.fromEntries(safe.labels.map((label) => [label.optionId, count(message.categoryTallies?.[option.optionId]?.[label.optionId])]))]));
      safe.responseCount = count(message.responseCount);
    } else {
      if (safe.pollType === 'ranking') {
        safe.firstPlaces = Object.fromEntries(options.map((option) => [option.optionId, count(message.firstPlaces?.[option.optionId])]));
        safe.responseCount = count(message.responseCount);
      }
      safe.tallies = Object.fromEntries(options.map((option) => [option.optionId, count(message.tallies?.[option.optionId])]));
    }
    return safe;
  }

  // QR SVGs are generated in main from the established encoder. Accept only its inert drawing
  // vocabulary and reconstruct attributes; never trust an SVG string from storage as HTML.
  function safeQr(svg) {
    if (typeof svg !== 'string' || svg.length > 250000 || !/^\s*<svg\b/.test(svg)) return '';
    const numeric = /^[\d.\s,+-]+$/;
    const values = {
      viewBox: numeric, x: numeric, y: numeric, width: numeric, height: numeric,
      fill: /^(?:#[\da-fA-F]{3,8}|none|black|white)$/,
      d: /^[MmLlHhVvZz\d.\s,+-]+$/,
      xmlns: /^http:\/\/www\.w3\.org\/2000\/svg$/,
      role: /^img$/, 'aria-label': /^[^<>&]*$/, 'shape-rendering': /^crispEdges$/,
    };
    let valid = true;
    const tags = [];
    const remainder = svg.replace(/<(\/?)([A-Za-z][\w:-]*)([^<>]*)>/g, (_tag, close, name, raw) => {
      if (!['svg', 'g', 'rect', 'path'].includes(name)) { valid = false; return ''; }
      if (close) {
        if (raw.trim()) valid = false;
        tags.push(`</${name}>`);
        return '';
      }
      const attributes = [];
      const rest = raw.replace(/([A-Za-z][\w:.-]*)\s*=\s*"([^"<>]*)"/g, (_attribute, key, value) => {
        if (!values[key]?.test(value)) valid = false;
        else attributes.push(`${key}="${escape(value)}"`);
        return '';
      }).trim();
      if (rest && rest !== '/') valid = false;
      tags.push(`<${name}${attributes.length ? ' ' + attributes.join(' ') : ''}${rest === '/' ? '/' : ''}>`);
      return '';
    });
    return valid && !remainder.trim() && /<\/svg>\s*$/.test(svg) ? tags.join('') : '';
  }

  function safeJoin(join) {
    let shortUrl = '';
    try {
      const url = new URL(join?.shortUrl);
      if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) shortUrl = url.href;
    } catch { /* no public joining link yet */ }
    return { shortUrl, qrSvg: shortUrl ? safeQr(join?.qrSvg) : '' };
  }

  function viewFor(poll, requested) {
    return requested === 'results' && (poll?.visibility === 'live' || poll?.revealed === true) ? 'results' : 'question';
  }

  function splitText(text, limit) {
    const characters = Array.from(text);
    const parts = [];
    while (characters.length > limit) {
      let end = limit;
      for (let i = limit; i > limit * .65; i--) {
        if (/\s/.test(characters[i])) { end = i + 1; break; }
      }
      parts.push(characters.splice(0, end).join(''));
    }
    parts.push(characters.join(''));
    return parts;
  }

  function isMatrix(poll) { return poll?.pollType === 'rating' || poll?.pollType === 'categorisation'; }

  // The poll definition the frame lays out — the same shape the compiler framed at build time.
  function definitionOf(poll) {
    return {
      pollId: poll.pollId, type: poll.pollType, question: poll.question, options: poll.options,
      ...(poll.labels ? { labels: poll.labels } : {}),
      ...(poll.rankCount !== undefined ? { rankCount: poll.rankCount } : {}),
      ...(poll.allowSkip !== undefined ? { allowSkip: poll.allowSkip } : {}),
      ...(poll.maxSelections !== undefined ? { maxSelections: poll.maxSelections } : {}),
      ...(poll.maxSubmissions !== undefined ? { maxSubmissions: poll.maxSubmissions } : {}),
    };
  }

  // Ranking results: points, first places, places shared on equal points (author order breaks
  // nothing — a tie is a tie and says so), unplaced until a ballot arrives.
  function rankingRows(poll) {
    const positions = poll.rankCount ?? poll.options.length;
    const rows = poll.options.map((option, index) => ({ ...option, index, points: poll.tallies?.[option.optionId] || 0 }));
    rows.sort((a, b) => b.points - a.points || a.index - b.index);
    let previous; let place = 0;
    return rows.map((option, order) => {
      if (option.points !== previous) place = order + 1;
      previous = option.points;
      const joint = rows.some((other) => other.optionId !== option.optionId && other.points === option.points);
      const firsts = poll.firstPlaces?.[option.optionId] || 0;
      return {
        ...option,
        place: poll.responseCount > 0 ? place : null, joint,
        percent: poll.responseCount ? Math.min(100, option.points * 100 / (poll.responseCount * positions)) : 0,
        // Two short lines (the count column keeps the label on one line): points, then first places.
        countText: `${option.points} points\n${firsts} first-place ${firsts === 1 ? 'vote' : 'votes'}`,
      };
    });
  }

  // Choice results: counts and shares in AUTHORED order — the audience compares bars, not ranks.
  function choiceRows(poll) {
    const votes = Object.values(poll.tallies || {}).reduce((sum, n) => sum + n, 0);
    return poll.options.map((option, index) => {
      const n = poll.tallies?.[option.optionId] || 0;
      const percent = votes ? Math.round(n * 100 / votes) : 0;
      return { ...option, index, percent, countText: `${n} · ${percent}%` };
    });
  }

  // Matrix results: each item's chips share the item's own denominator (answers to THIS item),
  // with skipped ballots stated when skipping was allowed.
  function matrixResults(poll) {
    return Object.fromEntries(poll.options.map((option) => {
      const counts = poll.categoryTallies?.[option.optionId] || {};
      const answered = poll.labels.reduce((sum, label) => sum + (counts[label.optionId] || 0), 0);
      return [option.optionId, {
        summary: `${answered} answered${poll.allowSkip ? ` · ${Math.max(0, poll.responseCount - answered)} skipped` : ''}`,
        labels: Object.fromEntries(poll.labels.map((label) => {
          const n = counts[label.optionId] || 0;
          return [label.optionId, { count: n, percent: answered ? Math.round(n * 100 / answered) : 0 }];
        })),
      }];
    }));
  }

  // Pages exist for ONE reason: open-response results are runtime content the frame cannot size
  // at compile time, so they page four cards at a time (long responses stand alone, split
  // losslessly). Options and matrix rows never page — the compiled frame shows them all and the
  // live frame must agree with it; the deck's autofit (the same one that fits the compiled frame)
  // spends leading and type down to the floor when a long list needs it.
  function pageInfo(message, requested, selected = 0) {
    const poll = safeState(message);
    const view = viewFor(poll, requested);
    const pages = [];
    let current = [];
    const add = () => { if (current.length) pages.push(current); current = []; };
    if (!poll) {
      /* no poll: one empty page */
    } else if (poll.pollType === 'open') {
      if (view === 'results') for (const response of poll.responses || []) {
        const parts = splitText(response.text, 560);
        if (parts.length > 1 || response.text.length > 220) {
          add();
          parts.forEach((text, index) => pages.push([{ ...response, text, continued: index > 0, large: true }]));
        } else {
          current.push(response);
          if (current.length === 4) add();
        }
      }
    } else {
      // Options and matrix rows: one page, the rows exactly as the frame lays them out (ranking
      // results in place order — the only reordering a poll ever does).
      pages.push(poll.pollType === 'ranking' && view === 'results' ? rankingRows(poll)
        : poll.options.map((option, index) => ({ ...option, index, ...(isMatrix(poll) ? { labels: poll.labels } : {}) })));
    }
    add();
    if (!pages.length) pages.push([]);
    const page = Math.min(pages.length - 1, count(selected));
    return { page, pages: pages.length, items: pages[page], view };
  }

  function totalFor(poll) {
    const votes = Object.values(poll.tallies || {}).reduce((sum, n) => sum + n, 0);
    const positions = poll.rankCount ?? poll.options.length;
    const scoring = positions === 1 ? '1 point for first place.' : `${positions} points for first, down to 1 for last.`;
    if (poll.pollType === 'ranking') return `${poll.responseCount || 0} ballots · ${scoring} Unranked: 0. Equal points share a place.`;
    if (isMatrix(poll)) return `${poll.responseCount || 0} ballots · % of answers to this item`;
    if (poll.pollType === 'open') return `${poll.responses?.length || 0} responses`;
    return `${votes} ${poll.pollType === 'multiple' ? 'selections · % of selections' : 'votes'}`;
  }

  // The live frame: the compiled composition with its state slots filled.
  function markup(message, settings = {}) {
    const poll = safeState(message);
    if (!poll) return '';
    const { page, pages, items, view } = pageInfo(poll, settings.view, settings.page);
    const join = safeJoin(settings.join);
    const state = !settings.started ? 'ready' : poll.open ? 'open' : 'stopped';
    const results = view !== 'results' ? undefined : {
      total: totalFor(poll),
      ...(poll.pollType === 'open' ? { responses: items } : {}),
      ...(poll.pollType === 'ranking' ? { options: rankingRows(poll) } : {}),
      ...(poll.pollType === 'single' || poll.pollType === 'multiple' ? { options: choiceRows(poll) } : {}),
      ...(isMatrix(poll) ? { matrix: matrixResults(poll) } : {}),
    };
    return renderPollFrame(definitionOf(poll), { live: true, state, view, page, pages, join: join.shortUrl ? join : undefined, results });
  }

  return { safeState, safeJoin, viewFor, pageInfo, markup };
}
