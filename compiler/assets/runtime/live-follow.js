import { validPointer, createPointerOverlay, pointerOverlayRuntimeSource } from './pointer-overlay.js'
import { penInkView, penDraw, penInkRuntimeSource } from './pen-ink.js'
import { isExtendedPoll, normaliseExtendedPollFields, normaliseExtendedPollAggregates, normaliseBallotChoice, samePollChoice, renderExtendedPollResults, createExtendedBallot, extendedPollRuntimeSource } from './poll-extended.js'
import { createInstantSlideSurface, createBreakChime, instantSlideRuntimeSource } from './instant-slide.js'
import { createAudienceReactions, audienceReactionsSupported, audienceReactionsRuntimeSource, audienceReactionIcons } from './audience-reactions.js'
import { createAudienceAsk, audienceAskRuntimeSource } from './audience-ask.js'
import { createQuestionLog, pollAnswerRecord, myNotesPollAnswerKey, audienceMyNotesRuntimeSource } from './audience-my-notes.js'
import { createAudienceBoard, audienceBoardRuntimeSource, audienceBoardIcons, normaliseBoardPoll, normaliseOwnBoards, normaliseCardAck } from './audience-board.js'

/** @typedef {import('../../../worker/protocol').SlideStateMessage | import('../../../worker/protocol').InstantSlideMessage | import('../../../worker/protocol').SessionClosedMessage | import('../../../worker/protocol').PollStateMessage | import('../../../worker/recovery-protocol').SessionPresence | import('../../../worker/protocol').PointerMessage | import('../../../worker/protocol').InkMessage} FollowServerMessage */

export function normaliseFocus(value) {
  if (!value || typeof value !== 'object') return null
  if ((value.kind !== 'reveal' && value.kind !== 'focus') || !Number.isInteger(value.step) || value.step < 0) return null
  return { kind: value.kind, step: value.step }
}

export function normaliseLightbox(value) {
  if (!value || typeof value !== 'object' || typeof value.open !== 'boolean'
    || !Number.isSafeInteger(value.index) || value.index < 0) return null
  return { open: value.open, index: value.index }
}

export function audienceSocketUrl(baseUrl, sessionId) {
  const url = new URL(baseUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = `/sessions/${encodeURIComponent(sessionId)}/audience`
  url.search = ''
  url.hash = ''
  return url.toString()
}

// A board's poll.state (ADR-0032). The worker sends an audience socket the audience view: visible
// cards and groups only. The board itself is checked field by field where it is drawn (poll-display.js
// safeState, the same boundary the audience window uses); here it is only kept as plain data.
function normaliseBoardPollState(message) {
  const plainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  if (typeof message.pollId !== 'string' || !message.pollId || typeof message.question !== 'string'
    || !Array.isArray(message.options) || (message.visibility !== 'live' && message.visibility !== 'held')
    || typeof message.open !== 'boolean' || typeof message.revealed !== 'boolean' || !plainObject(message.board)
    || (message.boardState !== undefined && !plainObject(message.boardState))) return null
  const options = message.options.map((option) => (
    option && typeof option.optionId === 'string' && option.optionId && typeof option.label === 'string' && option.label
      ? { optionId: option.optionId, label: option.label } : null))
  if (options.some((option) => !option)) return null
  return {
    type: 'poll.state', pollId: message.pollId, pollType: 'board', question: message.question, options,
    visibility: message.visibility, open: message.open, revealed: message.revealed,
    ...(typeof message.slideId === 'string' && message.slideId ? { slideId: message.slideId } : {}),
    board: message.board, ...(message.boardState !== undefined ? { boardState: message.boardState } : {}),
  }
}

/** @returns {import('../../../worker/protocol').PollStateMessage|null} */
export function normalisePollState(message) {
  if (message && typeof message === 'object' && message.type === 'poll.state' && message.pollType === 'board') {
    return /** @type {any} */ (normaliseBoardPollState(message))
  }
  if (
    !message || typeof message !== 'object' || message.type !== 'poll.state'
    || typeof message.pollId !== 'string' || !message.pollId
    || (!['single', 'multiple', 'open'].includes(message.pollType) && !isExtendedPoll(message.pollType))
    || typeof message.question !== 'string'
    || !Array.isArray(message.options)
    || (message.visibility !== 'live' && message.visibility !== 'held')
    || typeof message.open !== 'boolean' || typeof message.revealed !== 'boolean'
  ) return null
  if (message.maxSelections !== undefined && (message.pollType !== 'multiple'
    || !Number.isSafeInteger(message.maxSelections) || message.maxSelections < 1 || message.maxSelections > message.options.length)) return null
  if (message.maxSubmissions !== undefined && (message.pollType !== 'open' || (message.maxSubmissions !== null
    && (!Number.isSafeInteger(message.maxSubmissions) || message.maxSubmissions < 1)))) return null
  const options = message.options.map((option) => (
    option && typeof option.optionId === 'string' && option.optionId
      && typeof option.label === 'string' && option.label
      ? { optionId: option.optionId, label: option.label }
      : null
  ))
  if (options.some((option) => !option)) return null
  const extendedFields = normaliseExtendedPollFields(message)
  const extendedResults = normaliseExtendedPollAggregates(message)
  if (!extendedFields || !extendedResults) return null
  const optionIds = new Set(options.map((option) => option.optionId))
  let tallies
  if (message.tallies != null) {
    if (!message.tallies || typeof message.tallies !== 'object' || Array.isArray(message.tallies)) return null
    tallies = {}
    for (const [optionId, count] of Object.entries(message.tallies)) {
      if (!Number.isInteger(count) || count < 0) return null
      if (optionIds.has(optionId)) tallies[optionId] = count
    }
  }
  let responses
  if (message.responses != null) {
    if (!Array.isArray(message.responses)) return null
    responses = message.responses.map((response) => (
      response && typeof response.responseId === 'string' && response.responseId
        && typeof response.text === 'string' && response.text
        ? {
            responseId: response.responseId,
            text: response.text,
            ...(typeof response.name === 'string' && response.name ? { name: response.name } : {}),
            ...(response.hidden === true ? { hidden: true } : {}),
          }
        : null
    ))
    if (responses.some((response) => !response)) return null
  }
  /** @type {import('../../../worker/protocol').PollStateMessage} */
  const normalised = {
    ...extendedFields,
    ...((message.visibility === 'live' || message.revealed === true) ? extendedResults : {}),
    type: 'poll.state', pollId: message.pollId, pollType: message.pollType, question: message.question,
    options, visibility: message.visibility, open: message.open, revealed: message.revealed,
    ...(message.maxSelections !== undefined ? { maxSelections: message.maxSelections } : {}),
    ...(message.maxSubmissions !== undefined ? { maxSubmissions: message.maxSubmissions } : {}),
    ...(typeof message.slideId === 'string' && message.slideId ? { slideId: message.slideId } : {}),
    ...((message.visibility === 'live' || message.revealed === true) && tallies ? { tallies } : {}),
    ...((message.visibility === 'live' || message.revealed === true) && responses
      ? { responses: responses.filter((response) => response.hidden !== true).map((response) => ({ responseId: response.responseId, text: response.text })) }
      : {}),
  }
  return normalised
}

/** @returns {FollowServerMessage|null} */
export function parseServerMessage(value) {
  try {
    const message = JSON.parse(String(value))
    if (message?.type === 'session.closed') return { type: 'session.closed' }
    if (message?.type === 'session.presence' && typeof message.presenterConnected === 'boolean'
      && Number.isSafeInteger(message.venueScreens) && message.venueScreens >= 0) {
      return { type: 'session.presence', presenterConnected: message.presenterConnected, venueScreens: message.venueScreens }
    }
    if (message?.type === 'poll.state') return normalisePollState(message)
    if (message?.type === 'pointer.live') return validPointer(message.pointer) ? { type: 'pointer.live', pointer: message.pointer } : null
    if (message?.type === 'ink.live') {
      // The Pen's ink (ticket 08): checked field by field again here, drawn only by venue screens.
      const ink = penInkView(message.ink)
      return ink ? { type: 'ink.live', ink } : null
    }
    if (message?.type === 'instant.state') {
      const slide = message.slide == null ? null : normaliseInstantSlide(message.slide)
      return message.slide == null || slide ? { type: 'instant.state', slide } : null
    }
    const focus = message?.focus == null ? null : normaliseFocus(message.focus)
    const lightbox = message?.lightbox === undefined ? undefined : normaliseLightbox(message.lightbox)
    if (
      message?.type !== 'slide.state' || typeof message.slideId !== 'string' || !message.slideId
      || !Number.isInteger(message.reveal) || message.reveal < 0
      || !Number.isInteger(message.revision) || message.revision < 0
      || (message.focus != null && !focus)
      || (message.lightbox !== undefined && !lightbox)
      || (message.talkQr !== undefined && typeof message.talkQr !== 'boolean')
    ) return null
    return { type: 'slide.state', slideId: message.slideId, reveal: message.reveal, focus, revision: message.revision,
      ...(lightbox ? { lightbox } : {}), ...(message.talkQr ? { talkQr: true } : {}) }
  } catch { return null }
}

export function normaliseInstantSlide(slide) {
  if (!slide || typeof slide !== 'object' || !Number.isSafeInteger(slide.shownAt)) return null
  // A link is forwarded in its canonical form (new URL(...).href), or the slide is refused: http(s) only, no userinfo,
  // and nothing left that could open an HTML comment (< > " `) or a control character.
  const canonical = (value) => {
    if (typeof value !== 'string' || value.length > 2048 || !/^https?:\/\/[^\s]+$/i.test(value) || /[\u0000-\u001f\u007f]/.test(value)) return null
    try {
      const url = new URL(value)
      if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return null
      return url.href.length <= 2048 && !/[<>"`\u0000-\u001f\u007f]/.test(url.href) ? url.href : null
    } catch { return null }
  }
  const withLink = () => {
    if (slide.link == null) return slide
    const link = canonical(slide.link)
    return link && (slide.linkQrSvg == null || (typeof slide.linkQrSvg === 'string' && /^<svg\b/i.test(slide.linkQrSvg.trim()))) ? { ...slide, link } : null
  }
  if (slide.kind === 'text') return typeof slide.text === 'string' && slide.text.trim() && slide.text.length <= 2000 ? withLink() : null
  if (slide.kind === 'link') return canonical(slide.url)
    && typeof slide.qrSvg === 'string' && /^<svg\b/i.test(slide.qrSvg.trim()) ? { ...slide, url: canonical(slide.url) } : null
  if (slide.kind === 'time') return slide
  if (slide.kind === 'image') return typeof slide.dataUrl === 'string'
    && /^data:image\/webp;base64,[A-Za-z0-9+/]+={0,2}$/.test(slide.dataUrl) && slide.dataUrl.length <= 120000
    && Number.isSafeInteger(slide.width) && Number.isSafeInteger(slide.height)
    && slide.width > 0 && slide.height > 0 && Math.max(slide.width, slide.height) <= 1600 ? slide : null
  if (slide.kind === 'countdown') return Number.isSafeInteger(slide.startedAt) && Number.isSafeInteger(slide.durationMs)
    && slide.durationMs >= 1000 && slide.durationMs <= 86400000 && (slide.label == null || typeof slide.label === 'string')
    && (slide.soundAtEnd == null || typeof slide.soundAtEnd === 'boolean')
    && (slide.endSound == null || slide.endSound === 'none' || slide.endSound === 'chime' || slide.endSound === 'alarm') ? withLink() : null
  return null
}

export function escapePollHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character])
}

function pollTypeLabel(pollType) {
  if (pollType === 'ranking') return 'Ranking'
  if (pollType === 'rating') return 'Rating'
  if (pollType === 'categorisation') return 'Categorisation'
  if (pollType === 'multiple') return 'Choice · pick any'
  if (pollType === 'open') return 'Open · text'
  return 'Choice · pick one'
}

function submissionLimit(poll) {
  return poll.pollType === 'open' ? (poll.maxSubmissions === null ? Infinity : poll.maxSubmissions ?? 1) : 1
}

export function renderAudiencePollMarkup(message, localChoice, acceptedCount = localChoice == null ? 0 : 1) {
  if (!message) return ''
  const answered = localChoice != null
  if (answered && message.open && acceptedCount < submissionLimit(message)) {
    return renderAudiencePollMarkup({ ...message, open: false }, localChoice, acceptedCount)
      + renderAudiencePollMarkup(message, null, acceptedCount)
  }
  const disclosed = message.visibility === 'live' || message.revealed === true
  const question = escapePollHtml(message.question)
  // The question is optional — omit the element entirely when blank so there's no empty gap.
  const questionHtml = question ? `<div class="pq poll-question">${question}</div>` : ''
  const typeLabel = escapePollHtml(message.pollType === 'multiple'
    ? `Choice · select up to ${message.maxSelections ?? message.options.length} options` : pollTypeLabel(message.pollType))

  if (disclosed && (answered || !message.open)) {
    if (isExtendedPoll(message.pollType)) return `<article class="pollcard poll-card poll-results"><div class="ptype poll-type">${typeLabel}</div>${questionHtml}${answered ? '<p>Your answer recorded</p>' : ''}${renderExtendedPollResults(message)}</article>`
    if (message.pollType === 'open') {
      let mineUsed = false
      const responses = (message.responses || []).filter((response) => response.hidden !== true).map((response) => {
        const mine = !mineUsed && typeof localChoice === 'string' && response.text === localChoice
        if (mine) mineUsed = true
        return `<div class="rc poll-response${mine ? ' mine' : ''}">${escapePollHtml(response.text)}${mine ? '<div class="who">your answer</div>' : ''}</div>`
      }).join('')
      const responseCount = (message.responses || []).filter((response) => response.hidden !== true).length
      const answerLabel = answered ? `${mineUsed ? 'Your answer is on the board' : 'Your answer is recorded'} · ` : ''
      return `<article class="pollcard poll-card poll-results"><div class="ptype poll-type">${typeLabel}</div>${questionHtml}<div class="results"><div class="rtitle">${answered ? '<span class="ok" aria-hidden="true">✓</span> ' : ''}${answerLabel}${responseCount} responses</div><div class="board">${responses}</div></div></article>`
    }
    const choices = new Set(Array.isArray(localChoice) ? localChoice : localChoice == null ? [] : [localChoice])
    const total = message.options.reduce((sum, option) => sum + (message.tallies?.[option.optionId] || 0), 0)
    const bars = message.options.map((option) => {
      const count = message.tallies?.[option.optionId] || 0
      const percent = total === 0 ? 0 : Math.round((count / total) * 100)
      return `<div class="bar poll-bar${choices.has(option.optionId) ? ' mine' : ''}"><div class="bl"><span>${escapePollHtml(option.label)}</span><span class="pct">${percent}%</span></div><div class="track"><i style="width:${percent}%"></i></div></div>`
    }).join('')
    const countLabel = message.pollType === 'multiple' ? `${total} selections` : `${total} votes`
    const answerLabel = answered ? '<span class="ok" aria-hidden="true">✓</span> Your answer recorded · ' : ''
    return `<article class="pollcard poll-card poll-results"><div class="ptype poll-type">${typeLabel}</div>${questionHtml}<div class="results"><div class="rtitle">${answerLabel}${countLabel}</div>${bars}</div></article>`
  }

  if (answered) {
    return `<article class="pollcard poll-card poll-waiting"><div class="waiting"><div class="ic" aria-hidden="true">✓</div><div class="t">Answer recorded</div><div class="p">The speaker will share the results in a moment.</div></div></article>`
  }

  if (!message.open) {
    return `<article class="pollcard poll-card poll-closed"><div class="waiting"><div class="t">Poll closed</div><div class="p">This poll is no longer accepting answers.</div></div></article>`
  }

  const options = isExtendedPoll(message.pollType) ? '<fieldset class="poll-extended-ballot"><legend class="poll-sr-only">Your ballot</legend><div class="poll-extended-controls"></div></fieldset>' : message.pollType === 'open' ? '' : `<fieldset class="poll-options"><legend class="poll-sr-only">${typeLabel}</legend>${message.options.map((option) => {
    const inputType = message.pollType === 'single' ? 'radio' : 'checkbox'
    return `<label class="opt poll-option ${message.pollType === 'single' ? 'single' : 'multi'}"><input type="${inputType}" name="poll-choice" value="${escapePollHtml(option.optionId)}"><span class="box" aria-hidden="true"></span><span>${escapePollHtml(option.label)}</span></label>`
  }).join('')}</fieldset>`
  const openInput = message.pollType === 'open'
    ? '<label class="poll-open-label"><span class="poll-sr-only">Your answer</span><textarea class="opentext poll-open-text" placeholder="Type your answer…" rows="3"></textarea></label>'
    : ''
  return `<article class="pollcard poll-card poll-vote"><div class="ptype poll-type">${typeLabel}</div>${questionHtml}${options}${openInput}<button class="submit poll-submit" type="button" disabled>Submit</button><div class="poll-inline-status" role="status" aria-live="polite" hidden></div></article>`
}

export function shouldRenderAudiencePollUpdate(current, incoming, localChoice) {
  if (!current || current.pollId !== incoming.pollId) return true
  if (!incoming.open) return true
  return localChoice != null
}

export function createAudiencePollRuntime(options) {
  const mount = options.mount
  const document = mount.ownerDocument || globalThis.document
  const storage = options.storage || null
  const localChoices = new Map()
  const acceptedReceipts = new Map()
  const pollStates = new Map()
  const pollIdsBySlide = new Map()
  const drafts = new Map()
  const pendingBySubmission = new Map()
  const pendingByPoll = new Map()
  const voteErrors = new Map()
  let sessionId = ''
  let current = null
  let selectedSlideId = null
  let dismissedPollId = null // audience hid this poll to get back to the slides
  let hiddenForSlidePollId = null
  let extendedBallot = null
  let sendingVote = false
  const synchronousStatuses = new Map()

  function storageKey(pollId) { return `talkweaver:poll-vote:${sessionId}:${pollId}` }
  function localChoice(pollId) {
    if (localChoices.has(pollId)) return localChoices.get(pollId)
    try {
      const saved = storage?.getItem(storageKey(pollId))
      if (saved != null) {
        const choice = normaliseBallotChoice(JSON.parse(saved))
        if (choice !== null) {
          localChoices.set(pollId, choice)
          return choice
        }
      }
    } catch {}
    return null
  }
  function receiptPrefix(pollId) { return `talkweaver:poll-receipt:${sessionId}:${pollId}:` }
  function receiptsFor(pollId) {
    if (!acceptedReceipts.has(pollId)) {
      const receipts = new Set()
      try {
        const prefix = receiptPrefix(pollId)
        for (let i = 0; i < (storage?.length || 0); i++) {
          const key = storage.key(i)
          if (key?.startsWith(prefix)) receipts.add(key.slice(prefix.length))
        }
      } catch {}
      acceptedReceipts.set(pollId, receipts)
    }
    return acceptedReceipts.get(pollId)
  }
  function acceptedCount(pollId) {
    return Math.max(receiptsFor(pollId).size, localChoice(pollId) == null ? 0 : 1)
  }
  function canAnswer(poll) { return poll.open && acceptedCount(poll.pollId) < submissionLimit(poll) }
  function saveReceipt(pollId, submissionId, choice) {
    receiptsFor(pollId).add(submissionId)
    try { storage?.setItem(receiptPrefix(pollId) + submissionId, '1') } catch {}
    saveChoice(pollId, choice)
  }
  function saveChoice(pollId, choice) {
    localChoices.set(pollId, choice)
    try { storage?.setItem(storageKey(pollId), JSON.stringify(choice)) } catch {}
    keepAnswerForMyNotes(pollId, choice)
  }
  // My Notes lists the answer by slide a week later with no live talk, so the slide, the question and the
  // answer as words are kept beside the vote. Kept once: a receipt replayed on reconnect changes nothing.
  function keepAnswerForMyNotes(pollId, choice) {
    try {
      const key = myNotesPollAnswerKey(sessionId, pollId)
      if (!storage || storage.getItem(key) !== null) return
      const record = pollAnswerRecord(pollStates.get(pollId), choice, Date.now())
      if (!record) return
      storage.setItem(key, JSON.stringify(record))
      options.onAnswered?.()
    } catch {}
  }
  function draftFor(poll) {
    if (!drafts.has(poll.pollId)) {
      const initial = poll.pollType === 'ranking' ? (poll.rankCount === undefined ? poll.options.map(option => option.optionId) : [])
        : poll.pollType === 'rating' || poll.pollType === 'categorisation' ? {} : poll.pollType === 'multiple' ? [] : ''
      drafts.set(poll.pollId, initial)
    }
    return drafts.get(poll.pollId)
  }
  function validSelection(poll = current) {
    if (!poll) return null
    const selected = draftFor(poll)
    if (poll.pollType === 'ranking') return Array.isArray(selected) && selected.length === (poll.rankCount ?? poll.options.length) ? [...selected] : null
    if (poll.pollType === 'rating' || poll.pollType === 'categorisation') {
      const count = selected && typeof selected === 'object' ? Object.keys(selected).length : 0
      return count > 0 && (poll.allowSkip || count === poll.options.length) ? { ...selected } : null
    }
    if (poll.pollType === 'single') return typeof selected === 'string' && selected ? selected : null
    if (poll.pollType === 'multiple') return Array.isArray(selected) && selected.length > 0 && selected.length <= (poll.maxSelections ?? poll.options.length) ? [...selected] : null
    return typeof selected === 'string' && selected.trim() ? selected.trim() : null
  }
  function render() {
    extendedBallot?.destroy()
    extendedBallot = null
    if (!current || current.pollId === dismissedPollId) {
      mount.innerHTML = ''
      mount.hidden = true
      return
    }
    const choice = localChoice(current.pollId)
    mount.innerHTML = renderAudiencePollMarkup(current, choice, acceptedCount(current.pollId))
    const remaining = submissionLimit(current) - acceptedCount(current.pollId)
    const allowance = document.createElement('p')
    allowance.className = 'poll-allowance'
    allowance.setAttribute('role', 'status')
    allowance.textContent = remaining === Infinity ? 'Unlimited submissions per participant. Submissions are final.'
      : remaining <= 0 ? 'No submissions remaining.'
      : `${remaining} submission${remaining === 1 ? '' : 's'} remaining. Submissions are final.`
    mount.appendChild(allowance)
    mount.hidden = false
    // Dismiss control: let the audience clear the poll and return to the slides — the presenter
    // closing a poll leaves the final results up, and without this there is no way to get rid of it.
    const card = mount.querySelector('.poll-card')
    if (card) {
      const dismiss = document.createElement('button')
      dismiss.type = 'button'
      dismiss.className = 'poll-dismiss'
      dismiss.setAttribute('aria-label', 'Dismiss and return to the slides')
      dismiss.title = 'Back to slides'
      dismiss.textContent = '×'
      dismiss.addEventListener('click', () => { dismissedPollId = current ? current.pollId : null; render() })
      card.appendChild(dismiss)
    }
    if (!canAnswer(current)) return
    const submit = mount.querySelector('.poll-submit')
    const status = mount.querySelector('.poll-inline-status')
    if (!submit) return
    const pollId = current.pollId
    const draft = draftFor(current)
    if (isExtendedPoll(current.pollType)) {
      const host = mount.querySelector('.poll-extended-controls')
      extendedBallot = createExtendedBallot(host, current, (value, nextDraft) => {
        drafts.set(pollId, nextDraft)
        submit.disabled = !value || pendingByPoll.has(pollId)
      }, draft)
    } else if (current.pollType === 'open') {
      const textarea = mount.querySelector('.poll-open-text')
      if (textarea) textarea.value = typeof draft === 'string' ? draft : ''
      textarea?.addEventListener('input', () => {
        drafts.set(pollId, textarea.value)
        voteErrors.delete(pollId)
        if (status) status.hidden = true
        submit.disabled = !validSelection()
      })
    } else {
      function updateSelectionLimit() {
        const count = Array.isArray(drafts.get(pollId)) ? drafts.get(pollId).length : 0
        mount.querySelectorAll('input[name="poll-choice"]').forEach((input) => {
          input.disabled = current.pollType === 'multiple' && !input.checked
            && count >= (current.maxSelections ?? current.options.length)
        })
      }
      mount.querySelectorAll('input[name="poll-choice"]').forEach((input) => {
        input.checked = current.pollType === 'single'
          ? draft === input.value
          : Array.isArray(draft) && draft.includes(input.value)
        input.closest('.poll-option')?.classList.toggle('sel', input.checked)
        input.addEventListener('change', () => {
          if (current?.pollId !== pollId) return
          if (current.pollType === 'single') drafts.set(pollId, input.value)
          else {
            const choices = new Set(Array.isArray(drafts.get(pollId)) ? drafts.get(pollId) : [])
            if (input.checked) choices.add(input.value); else choices.delete(input.value)
            drafts.set(pollId, [...choices])
          }
          voteErrors.delete(pollId)
          if (status) status.hidden = true
          input.closest('.poll-option')?.classList.toggle('sel', input.checked)
          mount.querySelectorAll('input[name="poll-choice"]').forEach((other) => {
            other.closest('.poll-option')?.classList.toggle('sel', other.checked)
          })
          updateSelectionLimit()
          submit.disabled = !validSelection()
        })
      })
      updateSelectionLimit()
    }
    submit.disabled = !validSelection()
    const pendingSubmissionId = pendingByPoll.get(pollId)
    if (pendingSubmissionId) {
      submit.disabled = true
      submit.textContent = 'Submitting…'
      mount.querySelectorAll('input, textarea, .poll-extended-ballot').forEach((input) => { input.disabled = true })
      if (status) { status.textContent = 'Submitting your answer…'; status.hidden = false }
    } else if (voteErrors.has(pollId) && status) {
      status.textContent = voteErrors.get(pollId)
      status.hidden = false
    }
    submit.addEventListener('click', () => {
      if (pendingByPoll.has(pollId) || current?.pollId !== pollId || !canAnswer(current)) return
      const choiceToSend = validSelection()
      if (choiceToSend == null) return
      let submissionId = false
      sendingVote = true
      try { submissionId = options.sendVote(pollId, choiceToSend) } catch {}
      sendingVote = false
      if (typeof submissionId !== 'string' || !submissionId || pendingBySubmission.has(submissionId)) {
        synchronousStatuses.clear()
        voteErrors.set(pollId, 'Unable to submit. Please try again.')
        render()
        return
      }
      const pending = { submissionId, pollId, choice: normaliseBallotChoice(choiceToSend) }
      pendingBySubmission.set(submissionId, pending)
      pendingByPoll.set(pollId, submissionId)
      voteErrors.delete(pollId)
      render()
      const synchronous = synchronousStatuses.get(submissionId)
      if (synchronous) {
        synchronousStatuses.delete(submissionId)
        applyVoteStatus(synchronous)
      }
      synchronousStatuses.clear()
    })
  }
  function applyVoteStatus(status) {
    const pending = pendingBySubmission.get(status.submissionId)
    if (!pending || pending.pollId !== status.pollId) return
    if (status.status === 'confirmed' && status.choice !== undefined
      && !samePollChoice(status.choice, pending.choice)) return
    if (status.status === 'pending') {
      if (current?.pollId === pending.pollId && dismissedPollId !== pending.pollId) render()
      return
    }
    pendingBySubmission.delete(status.submissionId)
    if (pendingByPoll.get(pending.pollId) === status.submissionId) pendingByPoll.delete(pending.pollId)
    if (status.status === 'confirmed') {
      saveReceipt(pending.pollId, status.submissionId, pending.choice)
      drafts.delete(pending.pollId)
      voteErrors.delete(pending.pollId)
    } else if (status.status === 'rejected') {
      voteErrors.set(pending.pollId, typeof status.error === 'string' && status.error.trim()
        ? ({ already_answered: 'Your answer has already been recorded. Submissions are final.', submission_limit_reached: 'You have used all your submissions for this poll.' }[status.error] || status.error.trim())
        : 'Your answer was not accepted. Please try again.')
    }
    if (current?.pollId === pending.pollId && dismissedPollId !== pending.pollId) render()
  }
  function onVoteStatus(status) {
    if (!status || typeof status !== 'object'
      || typeof status.submissionId !== 'string' || !status.submissionId
      || typeof status.pollId !== 'string' || !status.pollId
      || (status.status !== 'pending' && status.status !== 'confirmed' && status.status !== 'rejected')) return
    if (!pendingBySubmission.has(status.submissionId)) {
      if (sendingVote) {
        synchronousStatuses.set(status.submissionId, status)
        return
      }
      const receiptChoice = normaliseBallotChoice(status.choice)
      if (status.status === 'confirmed' && receiptChoice != null) {
        saveReceipt(status.pollId, status.submissionId, receiptChoice)
        voteErrors.delete(status.pollId)
        if (current?.pollId === status.pollId && dismissedPollId !== status.pollId) render()
      }
      return
    }
    applyVoteStatus(status)
  }
  function startSession(nextSessionId) {
    if (sessionId === nextSessionId) return
    sessionId = nextSessionId
    localChoices.clear()
    acceptedReceipts.clear()
    pollStates.clear()
    pollIdsBySlide.clear()
    drafts.clear()
    pendingBySubmission.clear()
    pendingByPoll.clear()
    voteErrors.clear()
    synchronousStatuses.clear()
    current = null
    selectedSlideId = null
    dismissedPollId = null
    hiddenForSlidePollId = null
    render()
  }
  function receive(message) {
    const safe = normalisePollState(message)
    if (!safe) return
    const safeSlideId = /** @type {any} */ (safe).slideId
    const previous = pollStates.get(safe.pollId) || null
    pollStates.set(safe.pollId, safe)
    if (safeSlideId) pollIdsBySlide.set(safeSlideId, safe.pollId)

    if (safeSlideId && safeSlideId !== selectedSlideId) {
      if (current?.pollId === safe.pollId) current = safe
      return
    }
    if (safe.pollId === hiddenForSlidePollId) return

    const changedPoll = !current || current.pollId !== safe.pollId
    if (changedPoll && !safeSlideId && !safe.open) return
    if (changedPoll) {
      current = safe
      dismissedPollId = null
      hiddenForSlidePollId = null
      render()
      return
    }
    current = safe
    if (dismissedPollId === safe.pollId) return
    const hasUnconfirmedForm = canAnswer(safe) && mount.querySelector('.poll-vote')
    if (hasUnconfirmedForm && previous?.open !== false && previous?.maxSelections === safe.maxSelections && previous?.maxSubmissions === safe.maxSubmissions) {
      // Refresh the results independently: typing another answer must not freeze live/revealed results.
      const results = mount.querySelector('.poll-card:not(.poll-vote)')
      if (results && localChoice(safe.pollId) != null) {
        const template = document.createElement('template')
        template.innerHTML = renderAudiencePollMarkup({ ...safe, open: false }, localChoice(safe.pollId), acceptedCount(safe.pollId))
        const updated = template.content.firstElementChild
        const dismiss = results.querySelector('.poll-dismiss')
        if (dismiss) updated.appendChild(dismiss)
        results.replaceWith(updated)
      }
      return
    }
    render()
  }
  function selectSlide(slideId) {
    const changedSlide = selectedSlideId !== slideId
    selectedSlideId = typeof slideId === 'string' && slideId ? slideId : null
    const pollId = selectedSlideId ? pollIdsBySlide.get(selectedSlideId) : null
    current = pollId ? pollStates.get(pollId) || null : null
    hiddenForSlidePollId = null
    if (changedSlide) dismissedPollId = null
    render()
  }
  // Moving to another slide also clears the poll — the room should be looking at the new slide.
  function hideForSlideChange() {
    if (!current || current.pollId === dismissedPollId) return
    hiddenForSlidePollId = current.pollId
    current = null
    render()
  }
  function end() {
    current = null
    selectedSlideId = null
    pendingBySubmission.clear()
    pendingByPoll.clear()
    synchronousStatuses.clear()
    render()
  }
  render()
  return { startSession, receive, selectSlide, onVoteStatus, end, hideForSlideChange }
}

export function reconnectDelay(attempt) {
  return Math.min(8000, 500 * (2 ** Math.max(0, Number(attempt) || 0)))
}

/** @param {any} viewer @param {any} live */
export function audiencePositionsMatch(viewer, live) {
  if (!viewer || !live || viewer.slideId !== live.slideId || viewer.reveal !== live.reveal) return false
  const viewerFocus = viewer.focus || null
  const liveFocus = live.focus || null
  return viewerFocus?.kind === liveFocus?.kind && viewerFocus?.step === liveFocus?.step
}

/** @param {any} options */
export function createAudienceFollowRuntime(options) {
  const document = options.document
  const button = document.getElementById('followLiveBtn')
  const label = button?.querySelector('.btn-label')
  const statusEl = document.getElementById('liveFollowStatus')
  const returnButton = document.getElementById('returnToPresenterBtn')
  const nowLiveBadges = Array.from(document.querySelectorAll('.now-live-badge'))
  const nameWrap = document.getElementById('liveNameWrap')
  const nameInput = document.getElementById('liveName')
  if (!button || !label || !statusEl || !returnButton || nowLiveBadges.length === 0 || !nameWrap || !nameInput) return null

  const storage = options.storage || (typeof localStorage === 'undefined' ? null : localStorage)
  const nameKey = 'talkweaver:live-name'
  try { nameInput.value = storage?.getItem(nameKey) || '' } catch {}
  nameInput.addEventListener('input', () => { try { storage?.setItem(nameKey, nameInput.value) } catch {} })

  let sessionId = ''
  let client = null
  let latestState = null
  let sessionLive = false
  let following = false
  let diverged = false
  let presenterConnected = true
  const pollMount = document.getElementById('audiencePollSurface')
  const pollRuntime = pollMount ? createAudiencePollRuntime({
    mount: pollMount,
    storage,
    onAnswered: () => options.onPollAnswered?.(),
    sendVote: (pollId, choice) => client?.sendVote(pollId, choice) || false,
  }) : null
  const pointer = options.venue && document.body ? createPointerOverlay({ document, staleMs: 2000, drawInk: penDraw, surface: () => {
    const image = document.getElementById('lightboxImg')
    const box = document.getElementById('lightbox')
    const zoomed = box?.classList.contains('open')
    const target = zoomed ? image : document.querySelector('.stage')
    return target ? { element: target, rect: target.getBoundingClientRect(),
      canvasScale: document.querySelector('.stage').getBoundingClientRect().width / 1280,
      space: zoomed ? 'image' : 'slide', image: zoomed ? Math.max(0, Number(box?.dataset.index) || 0) : undefined,
      slideId: options.getViewerPosition()?.slideId } : null
  } }) : null
  const instantSurface = document.body ? createInstantSlideSurface(document.body, options.venue
    // The venue screen is a room display: it shows the talk's QR and plays the end-of-break chime.
    // Phones (not venue) get neither, no QR code at all, and their link stays clickable.
    ? { qr: options.breakQr || undefined, showQr: true, clickable: false, chime: createBreakChime(document.defaultView) } : {}) : { show() {} }
  // The reaction bar (ADR-0027): drawn only where the page carries its dock (never the venue screen).
  const reactionDock = options.reactions ? document.getElementById('rxDock') : null
  let ask = null
  let board = null
  let lateBoardShown = ''
  // The questions this device sent, kept for My Notes when the worker confirms them.
  const questionLog = options.reactions?.questionsKey ? createQuestionLog({ storage, key: options.reactions.questionsKey }) : null
  const reactions = reactionDock ? createAudienceReactions({
    document, dock: reactionDock, storage, storageKey: options.reactions.storageKey,
    getSlideId: () => (options.getViewerPosition() || {}).slideId || '',
    // The slide's own set from its {reactions=…} (ticket 04); null is the standard three.
    getSlideReactions: options.reactions.getSlideReactions,
    isPhone: options.reactions.isPhone,
    isConnected: () => Boolean(client && client.status() === 'live'),
    sendReaction: (item) => (client ? client.sendReaction(item) : false),
    onAsk: () => ask?.open(),
    // Note (phone): the note sheet is the question box's sheet; the count is the page's notes for the slide.
    onNote: options.reactions.onSlideNote ? () => ask?.openNote() : undefined,
    getNoteCount: options.reactions.getNoteCount,
    onMarksChanged: options.reactions.onMarksChanged,
  }) : null
  // Ask the speaker (ADR-0027): the question box opens from the bar's Ask button and from the A key,
  // and only where the bar is showing. Questions go through the same queue as reactions.
  ask = reactions ? createAudienceAsk({
    document, storage, nameKey, nameField: nameInput, icons: audienceReactionIcons(),
    isPhone: options.reactions.isPhone,
    isConnected: () => Boolean(client && client.status() === 'live'),
    getSlideId: () => (options.getViewerPosition() || {}).slideId || '',
    getSlideInfo: options.reactions.getSlideInfo,
    isAvailable: () => reactions.isVisible() && reactions.questionsAllowed(),
    isBlocked: options.reactions.isBlocked,
    sendQuestion: (item) => (client ? client.sendQuestion(item) : false),
    refusalReason: () => (client ? client.questionRefusal() : 'ended'),
    notify: (note, ms) => reactions.notify(note, ms),
    onQuestionKept: (record) => { if (questionLog && questionLog.add(record)) options.reactions.onQuestionKept?.() },
    onNoteQuestion: options.reactions.onNoteQuestion,
    onSlideNote: options.reactions.onSlideNote,
  }) : null
  // The board (ADR-0032): the column tabs, the card box and this device's own cards, shown while a board
  // slide is live and the person follows it. Cards go through the same queue as reactions and questions.
  const boardMount = options.reactions ? document.getElementById('bdPanel') : null
  board = boardMount && reactions ? createAudienceBoard({
    document, mount: boardMount, icons: { ...audienceReactionIcons(), ...audienceBoardIcons() },
    isPhone: options.reactions.isPhone,
    isConnected: () => Boolean(client && client.status() === 'live'),
    getSlideId: () => (options.getViewerPosition() || {}).slideId || '',
    getSlideInfo: options.reactions.getSlideInfo,
    getName: () => nameInput.value,
    isAskAvailable: () => Boolean(reactions.isVisible() && reactions.questionsAllowed()),
    onAsk: () => ask?.open(),
    sendCard: (item) => (client ? client.sendCard(item) : false),
    pendingCards: () => (client ? client.pendingCards() : []),
    onActiveChange: (active) => reactions.setBoardSlide(active),
  }) : null
  // The bar only shows against a worker whose /capabilities build takes reactions; until that is known
  // (or when it cannot be read) it stays away, and the next discovery poll asks again.
  let reactionsKnown = false, reactionsChecking = false
  function checkReactionSupport() {
    if (!reactions || reactionsKnown || reactionsChecking) return
    reactionsChecking = true
    const request = options.fetchCapabilities
      ? Promise.resolve(options.fetchCapabilities())
      : fetch(options.liveConfig.workerBaseUrl + '/capabilities').then((response) => { if (!response.ok) throw new Error('Capabilities unavailable'); return response.json() })
    request.then((capabilities) => { reactionsKnown = true; reactions.setSupported(audienceReactionsSupported(capabilities)) })
      .catch(() => {}).then(() => { reactionsChecking = false })
  }
  let currentInstant = null
  // The handout home page holds the full-screen instant slide back while the person reads the Handout
  // tab (instantAllowed), says so on its Live tab (onInstantChanged) and shows it on return (refreshInstant).
  function showInstant(slide) {
    instantSurface.show(slide && (!options.instantAllowed || options.instantAllowed()) ? slide : null)
  }
  function receiveInstant(slide) {
    currentInstant = slide
    showInstant(following ? slide : null)
    options.onInstantChanged?.(following ? slide : null)
  }

  function renderControls() {
    button.hidden = !sessionLive || diverged
    returnButton.hidden = !sessionLive || !diverged
    button.classList.toggle('is-on', following)
    reactions?.setVisible(sessionLive && following)
    board?.setVisible(sessionLive && following)
    label.textContent = following ? 'Stop following' : 'Follow live'
    nameWrap.hidden = !sessionLive
    nowLiveBadges.forEach((badge) => { badge.hidden = !sessionLive })
    if (!sessionLive) nameWrap.hidden = true
    options.reactions?.onSwitchesChanged?.()
    // The handout home page shows its Live tab while a session is live (design 2026-10-02 B).
    options.onLiveChanged?.(sessionLive)
  }
  function markEnded(reason = 'ended') {
    lateBoardShown = ''
    client?.end()
    client = null
    sessionId = ''
    sessionLive = false
    following = false
    diverged = false
    latestState = null
    // The talk's drawings end with it.
    pointer?.ink(null)
    options.releaseLiveSlideState?.()
    presenterConnected = true
    currentInstant = null
    instantSurface.show(null)
    options.onInstantChanged?.(null)
    pollRuntime?.end()
    reactions?.end()
    board?.end()
    ask?.end()
    reactionsKnown = false
    renderControls()
    options.onEnded?.(reason)
    statusEl.textContent = reason === 'expired' ? 'The live session has expired.' : 'The live session has ended.'
    statusEl.hidden = false
  }
  let lastPollSlideId = null
  function receiveLiveState(message) {
    options.onLiveSlideState?.(message.slideId)
    // Presenter moved on → clear any poll card so the room sees the new slide.
    if (message.slideId !== lastPollSlideId) {
      lastPollSlideId = message.slideId
      if (pollRuntime?.selectSlide) pollRuntime.selectSlide(message.slideId)
      else pollRuntime?.hideForSlideChange()
    }
    latestState = message
    if (!following) {
      if (diverged) diverged = !audiencePositionsMatch(options.getViewerPosition(), message)
      renderControls()
      return
    }
    const applied = options.applyLiveSlideState(message)
    following = Boolean(applied)
    diverged = !applied
    renderControls()
  }
  function ensureClient() {
    if (!sessionId || client) return
    statusEl.textContent = 'connecting…'
    statusEl.hidden = false
    client = (options.createClient || createAudienceFollowClient)({
      baseUrl: options.liveConfig.workerBaseUrl,
      sessionId,
      kind: options.venue ? 'screen' : undefined,
      storage,
      probe: () => probeAudienceSession(options.liveConfig.workerBaseUrl, sessionId),
      onStatus: (status) => {
        if (status !== 'live') presenterConnected = true
        ask?.connectionChanged()
        board?.connectionChanged()
        statusEl.textContent = status === 'live' ? 'live'
          : status === 'ended' ? 'the live session has ended'
          : status === 'expired' ? 'the live session has expired'
          : status === 'incompatible' ? 'This handout needs a compatible live service.'
          : 'live paused · reconnecting'
      },
      onPointer: (value) => { if (following) pointer?.show(value) },
      // The Pen's ink: kept for its own layer; the overlay draws it only while that layer is on screen.
      onInk: (value) => { pointer?.ink(value) },
      onSlideState: (value) => { pointer?.show('gone'); receiveLiveState(value); },
      onPresence: (presence) => {
        const reconnected = !presenterConnected && presence.presenterConnected
        presenterConnected = presence.presenterConnected
        if (options.venue && sessionLive && reconnected && latestState) options.applyLiveSlideState(latestState)
      },
      onInstantSlide: receiveInstant,
      // A board is drawn into its slide by the venue screen (onBoardState); phones and laptops draw it in
      // their own board panel, from the same message checked field by field (normaliseBoardPoll).
      onPollState: (message) => {
        if (message?.pollType !== 'board') { pollRuntime?.receive(message); return }
        options.onBoardState?.(message)
        const own = board ? normaliseBoardPoll(message) : null
        if (!own) return
        board.receive({ ...message, ...own })
        // A phone that joins after End live (boards kept open) gets no slide state: take it to the open board once.
        if (!latestState && message.open && message.slideId && lateBoardShown !== message.pollId && options.showSlide) {
          lateBoardShown = message.pollId
          options.showSlide(message.slideId)
        }
      },
      onBoardSnapshot: (own) => board?.setOwn(own),
      onCardStatus: (receipt) => board?.onCardStatus(receipt),
      onVoteStatus: (receipt) => pollRuntime?.onVoteStatus?.(receipt),
      onSwitches: (switches) => { reactions?.setSwitches(switches); ask?.refresh(); board?.refresh(); options.reactions?.onSwitchesChanged?.() },
      onReactionStatus: (receipt) => reactions?.onReactionStatus(receipt),
      onQuestionStatus: (receipt) => ask?.onQuestionStatus(receipt),
      onEnded: markEnded,
    })
  }
  function resumeFollowing() {
    if (!sessionLive) return
    following = true
    showInstant(currentInstant)
    diverged = false
    ensureClient()
    if (latestState && !options.applyLiveSlideState(latestState)) {
      following = false
      instantSurface.show(null)
      diverged = true
    }
    renderControls()
  }
  function viewerMoved() {
    if (!sessionLive || !latestState) return
    diverged = !audiencePositionsMatch(options.getViewerPosition(), latestState)
    if (diverged) following = false
    if (diverged) instantSurface.show(null)
    renderControls()
  }
  returnButton.addEventListener('click', resumeFollowing)
  button.addEventListener('click', () => {
    if (following) {
      following = false
      diverged = false
      // The page keeps the slide but drops what only a follower shows (emphasis steps, ADR-0035).
      options.releaseLiveSlideState?.()
      renderControls()
      return
    }
    resumeFollowing()
  })

  function discoverSession() {
    const request = options.fetchSession
      ? Promise.resolve(options.fetchSession())
      : fetch(options.liveConfig.workerBaseUrl + '/session/' + encodeURIComponent(options.liveConfig.talkSlug))
        .then((response) => { if (!response.ok) throw new Error('Live discovery unavailable'); return response.json() })
    return request.then((discovery) => {
      if (!discovery?.live || !discovery.sessionId) {
        if (sessionLive || client || sessionId) markEnded()
        else renderControls()
        return
      }
      const isNewSession = !sessionLive || sessionId !== discovery.sessionId
      sessionLive = true
      sessionId = discovery.sessionId
      pollRuntime?.startSession(sessionId)
      reactions?.startSession(sessionId)
      board?.startSession(sessionId)
      checkReactionSupport()
      if (isNewSession) {
        client?.end()
        client = null
        latestState = null
        following = true
        diverged = false
        ensureClient()
      }
      renderControls()
    }).catch(() => {})
  }
  void discoverSession()
  ;(options.scheduleDiscovery || ((callback) => window.setInterval(callback, 5000)))(discoverSession)
  return { discoverSession, viewerMoved, markEnded, refreshInstant: () => showInstant(following ? currentInstant : null), slideChanged: () => { pointer?.show('gone'); reactions?.slideChanged(); board?.slideChanged() }, reactions, ask, board, venueKeyboardAvailable: () => Boolean(options.venue && !(sessionLive && presenterConnected)) }
}

/** @param {any} message */
export function normaliseVoteReceipt(message) {
  if (!message || message.type !== 'vote.ack' || typeof message.submissionId !== 'string'
    || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/.test(message.submissionId)
    || typeof message.pollId !== 'string' || !message.pollId
    || (message.status !== 'confirmed' && message.status !== 'rejected')) return null
  const choice = normaliseBallotChoice(message.choice)
  if (message.status === 'confirmed' && choice === null) return null
  return { submissionId: message.submissionId, pollId: message.pollId, status: message.status,
    ...(choice !== null ? { choice } : {}), ...(typeof message.error === 'string' ? { error: message.error } : {}) }
}

/** The sender's receipt for a reaction (`reaction.ack`) or a question (`question.ack`), or null when
 *  it is malformed.
 *  @param {any} message */
export function normaliseReactionAck(message) {
  if (!message || (message.type !== 'reaction.ack' && message.type !== 'question.ack') || typeof message.submissionId !== 'string'
    || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/.test(message.submissionId)
    || (message.status !== 'confirmed' && message.status !== 'rejected')) return null
  return { submissionId: message.submissionId, status: message.status, ...(typeof message.error === 'string' ? { error: message.error } : {}) }
}

/** The speaker's pause switches as the worker sends them (`switches.state`, and `switches` in a snapshot), or null when malformed.
 *  @param {any} value */
export function normaliseSwitches(value) {
  if (!value || typeof value.questionsAllowed !== 'boolean' || typeof value.reactionsAllowed !== 'boolean') return null
  return { questionsAllowed: value.questionsAllowed, reactionsAllowed: value.reactionsAllowed }
}

/** @param {string} baseUrl @param {string} sessionId */
export async function probeAudienceSession(baseUrl, sessionId) {
  const capabilities = await fetch(baseUrl + '/capabilities', { signal: AbortSignal.timeout(5000) })
  if (capabilities.status === 404) return 'incompatible'
  if (!capabilities.ok) return null
  if ((await capabilities.json()).protocol !== 2) return 'incompatible'
  const response = await fetch(baseUrl + '/sessions/' + encodeURIComponent(sessionId) + '/status', { signal: AbortSignal.timeout(5000) })
  if (response.status === 404) return 'ended'
  if (!response.ok) return null
  const status = (await response.json()).status
  return status === 'ended' || status === 'expired' ? status : null
}

/** @param {any} options */
export function createAudienceFollowClient(options) {
  const createSocket = options.createSocket || ((url) => new WebSocket(url))
  const schedule = options.schedule || ((fn, delay) => setTimeout(fn, delay))
  const cancelSchedule = options.cancelSchedule || ((handle) => clearTimeout(handle))
  const storage = options.storage || (typeof localStorage === 'undefined' ? null : localStorage)
  const random = options.random || Math.random
  const identityKey = 'talkweaver:live-participant:' + options.sessionId
  const pendingPrefix = 'talkweaver:live-pending:' + options.sessionId + ':'
  // Reactions queue first-in first-out on this device (durable, one key per session) and go one at
  // a time over the one socket, each waiting for its ack: the worker applies them in arrival order.
  const reactionKey = 'talkweaver:live-reactions:' + options.sessionId
  /** @type {any[]} */
  let reactionQueue = []
  let reactionInFlight = ''
  let questionRefusal = 'ended'
  const pending = new Map()
  const timers = new Map()
  let participantId = options.participantId || ''
  let liveStatus = 'paused-reconnecting', socket = null
  let stopped = false, attempt = 0, generation = 0, revision = -1
  let syncId = '', nonce = ''
  const uuid = () => crypto.randomUUID()

  function cancel(name) {
    if (timers.has(name)) cancelSchedule(timers.get(name))
    timers.delete(name)
  }
  function later(name, fn, delay) {
    cancel(name)
    timers.set(name, schedule(() => { timers.delete(name); fn() }, delay))
  }
  function setStatus(status) {
    if (liveStatus === status) return
    liveStatus = status; options.onStatus?.(status)
  }
  function dispose() {
    const previous = socket
    socket = null
    for (const name of [...timers.keys()]) cancel(name)
    try { previous?.close() } catch {}
    syncId = ''; nonce = ''; reactionInFlight = ''
  }
  function terminal(status) {
    if (stopped) return
    stopped = true; generation++; dispose(); setStatus(status)
    if (status === 'ended' || status === 'expired') options.onEnded?.(status)
  }
  function fail() {
    if (stopped) return
    dispose()
    const currentGeneration = ++generation
    setStatus('paused-reconnecting')
    later('reconnect', connect, reconnectDelay(attempt++) * (0.8 + 0.4 * random()))
    if (options.probe) void options.probe().then((status) => {
      if (!stopped && currentGeneration === generation && status) terminal(status)
    }).catch(() => {})
  }
  function send(message) {
    if (stopped || !socket || socket.readyState !== 1) return false
    try { socket.send(JSON.stringify(message)); return true } catch { fail(); return false }
  }
  function readPending() {
    try {
      for (let i = 0; i < (storage?.length || 0); i++) {
        const key = storage.key(i)
        if (!key?.startsWith(pendingPrefix)) continue
        const value = JSON.parse(storage.getItem(key))
        if (value && typeof value.submissionId === 'string' && typeof value.pollId === 'string'
          && key === pendingPrefix + value.submissionId) pending.set(value.submissionId, value)
      }
    } catch {}
  }
  function receipt(message) {
    const normalised = normaliseVoteReceipt(message)
    if (!normalised) return
    const waiting = pending.get(normalised.submissionId)
    if (waiting && waiting.pollId !== normalised.pollId) return
    // The UI persists the confirmed answer, including receipts replayed after a reload.
    options.onVoteStatus?.(normalised)
    storage?.removeItem(pendingPrefix + normalised.submissionId)
    pending.delete(normalised.submissionId)
    if (!pending.size) cancel('votes')
  }
  function flushVotes() {
    if (liveStatus !== 'live' || stopped || !pending.size) return
    for (const value of pending.values()) {
      if (!send({ type: 'vote.submit', ...value })) return
    }
    later('votes', fail, 10_000)
  }
  const now = options.now || (() => Date.now())
  const reactionKeyPrefix = 'talkweaver:live-reactions:'
  // A queued item is a reaction (`reaction`) or a question (`kind: 'question'` with `text`); both go
  // through the one first-in first-out queue over the one socket.
  const validReaction = (item) => Boolean(item && typeof item.submissionId === 'string'
    && (item.kind === 'card' ? typeof item.pollId === 'string' && item.pollId.length > 0 && (item.op === 'add' || item.op === 'edit' || item.op === 'withdraw')
      : item.kind === 'question' ? typeof item.text === 'string' && item.text.length > 0 : typeof item.reaction === 'string')
    && typeof item.slideId === 'string' && Number.isSafeInteger(item.tMs))
  // The stored queue is `{ at, items }` (`at` stamps the last write). Every change re-reads storage and
  // changes only its own item, so a second tab of the same talk never loses an item to stale memory.
  function readStoredQueue() {
    try {
      const saved = JSON.parse(storage?.getItem(reactionKey) || 'null')
      return saved && Array.isArray(saved.items) ? saved.items.filter(validReaction) : []
    } catch { return [] }
  }
  function changeStoredQueue(change) {
    try {
      if (!storage) return false
      const items = change(readStoredQueue())
      if (items.length) storage.setItem(reactionKey, JSON.stringify({ at: now(), items }))
      else storage.removeItem(reactionKey)
      return true
    } catch { return false }
  }
  // Queues left by other sessions and not written for 7 days are of no use to anyone: remove them.
  function sweepReactionQueues() {
    try {
      const cutoff = now() - 7 * 24 * 60 * 60 * 1000
      const stale = []
      for (let i = 0; i < (storage?.length || 0); i++) {
        const key = storage.key(i)
        if (!key?.startsWith(reactionKeyPrefix) || key === reactionKey) continue
        let at = 0
        try { at = JSON.parse(storage.getItem(key)).at } catch {}
        if (!(Number(at) >= cutoff)) stale.push(key)
      }
      for (const key of stale) storage.removeItem(key)
    } catch {}
  }
  function readReactionQueue() {
    const known = new Set(reactionQueue.map((item) => item.submissionId))
    for (const item of readStoredQueue()) if (!known.has(item.submissionId)) reactionQueue.push(item)
  }
  // Another tab of the same session shares the stored queue: an item it has already settled is gone
  // from storage, and this tab must not send it again. Storage that cannot be read changes nothing.
  function dropSettledElsewhere() {
    try {
      if (!storage) return
      const saved = JSON.parse(storage.getItem(reactionKey) || 'null')
      const ids = new Set(saved && Array.isArray(saved.items) ? saved.items.map((item) => item && item.submissionId) : [])
      reactionQueue = reactionQueue.filter((item) => ids.has(item.submissionId))
    } catch {}
  }
  function flushReactions() {
    if (liveStatus !== 'live' || stopped || reactionInFlight) return
    dropSettledElsewhere()
    if (!reactionQueue.length) return
    const head = reactionQueue[0]
    const { submissionId, reaction, slideId, tMs, withdrawn } = head
    reactionInFlight = submissionId
    const message = head.kind === 'card'
      ? (head.op === 'add' ? { type: 'card.add', submissionId, pollId: head.pollId, column: head.column, text: head.text, ...(head.name ? { name: head.name } : {}) }
        : head.op === 'edit' ? { type: 'card.edit', submissionId, pollId: head.pollId, cardId: head.cardId, text: head.text }
        : { type: 'card.withdraw', submissionId, pollId: head.pollId, cardId: head.cardId })
      : head.kind === 'question'
      ? { type: 'question.submit', submissionId, text: head.text, ...(head.name ? { name: head.name } : {}), slideId, tMs }
      : { type: 'reaction.send', submissionId, reaction, slideId, tMs, ...(withdrawn ? { withdrawn: true } : {}) }
    if (send(message)) later('reaction', reactionTimedOut, 10_000)
    else reactionInFlight = ''
  }
  // Every answer settles the head: a refusal stored nothing (a pause refusal included, so the item is
  // dropped here rather than resent after the resume), and a refusal is shown, never retried.
  function settleReaction(head, result) {
    reactionQueue = reactionQueue.filter((item) => item.submissionId !== head.submissionId)
    reactionInFlight = ''
    changeStoredQueue((items) => items.filter((item) => item.submissionId !== head.submissionId))
    cancel('reaction')
    const receipt = { submissionId: head.submissionId, ...result, item: head }
    if (head.kind === 'card') options.onCardStatus?.(receipt)
    else if (head.kind === 'question') options.onQuestionStatus?.(receipt)
    else options.onReactionStatus?.(receipt)
    flushReactions()
  }
  function reactionReceipt(message) {
    /** @type {any} */
    const normalised = message?.type === 'card.ack' ? normaliseCardAck(message) : normaliseReactionAck(message)
    const head = reactionQueue[0]
    // Another tab of this device sent the card: this tab only learns how many cards the device has used.
    if (normalised && message.type === 'card.ack' && normalised.status === 'confirmed' && normalised.cardsUsed !== undefined
      && !reactionQueue.some((item) => item.submissionId === normalised.submissionId)) {
      options.onCardStatus?.({ submissionId: normalised.submissionId, status: 'confirmed', pollId: normalised.pollId, cardsUsed: normalised.cardsUsed, item: null })
      return
    }
    if (!normalised || !head || head.submissionId !== normalised.submissionId) return
    settleReaction(head, { status: normalised.status, ...(normalised.error ? { error: normalised.error } : {}),
      ...(head.kind === 'card' ? { ...(normalised.cardId ? { cardId: normalised.cardId } : {}), ...(normalised.cardsUsed !== undefined ? { cardsUsed: normalised.cardsUsed } : {}) } : {}) })
  }
  // A worker that does not take reactions answers with a protocol error and never an ack. Ten seconds
  // without an answer reconnects and resends; a third silent try drops the item so it cannot block the
  // queue or loop the connection for ever (the count is stored with the item, across reloads).
  function reactionTimedOut() {
    const head = reactionQueue[0]
    if (!head || head.submissionId !== reactionInFlight) return
    head.tries = (head.tries || 0) + 1
    changeStoredQueue((items) => items.map((item) => item.submissionId === head.submissionId ? { ...item, tries: head.tries } : item))
    if (head.tries >= 3) settleReaction(head, { status: 'rejected', error: 'no_answer' })
    else fail()
  }
  function heartbeat() {
    later('heartbeat', () => {
      nonce = uuid()
      if (send({ type: 'session.ping', nonce })) later('pong', fail, options.heartbeatTimeoutMs ?? 10_000)
    }, options.heartbeatIntervalMs ?? 15_000)
  }
  function applySlide(message, snapshot = false) {
    const parsed = parseServerMessage(JSON.stringify(message))
    if (!parsed || parsed.type !== 'slide.state' || (!snapshot && parsed.revision <= revision)) return
    revision = parsed.revision
    options.onSlideState?.(parsed)
  }
  function applyInstant(message) {
    const parsed = parseServerMessage(JSON.stringify(message))
    if (parsed?.type === 'instant.state') options.onInstantSlide?.(parsed.slide)
  }
  function connect() {
    if (stopped) return
    generation++
    try {
      readPending()
      sweepReactionQueues()
      readReactionQueue()
      const url = new URL(audienceSocketUrl(options.baseUrl, options.sessionId))
      url.searchParams.set('protocol', '2')
      url.searchParams.set('participantId', participantId)
      if (options.kind === 'screen') url.searchParams.set('kind', 'screen')
      const current = createSocket(url.toString())
      socket = current
      later('handshake', fail, options.handshakeTimeoutMs ?? 10_000)
      current.onopen = () => {}
      current.onclose = () => { if (socket === current && !stopped) fail() }
      current.onerror = () => { if (socket === current && !stopped) fail() }
      current.onmessage = (event) => {
        if (socket !== current || stopped) return
        try {
          const message = JSON.parse(String(event.data))
          if (message?.type === 'session.closed') { terminal(message.reason === 'expired' ? 'expired' : 'ended'); return }
          if (message?.type === 'session.hello' && message.protocol === 2) {
            syncId = uuid()
            send({ type: 'session.sync', syncId })
            return
          }
          if (message?.type === 'session.pong') {
            if (message.nonce === nonce) { cancel('pong'); nonce = ''; heartbeat() }
            return
          }
          if (message?.type === 'session.snapshot') {
            if (message.protocol !== 2 || message.sessionId !== options.sessionId || !syncId || message.syncId !== syncId
              || !Array.isArray(message.polls) || !Array.isArray(message.receipts)) return
            const polls = message.polls.map(normalisePollState)
            const receipts = message.receipts.map(normaliseVoteReceipt)
            if (polls.some((p) => !p) || receipts.some((r) => !r)) return
            if (message.slideState) {
              const state = parseServerMessage(JSON.stringify(message.slideState))
              if (state?.type !== 'slide.state') return
              applySlide(state, true)
            }
            if (message.presence) {
              const presence = parseServerMessage(JSON.stringify({ type: 'session.presence', ...message.presence }))
              if (presence) options.onPresence?.(presence)
            }
            applyInstant({ type: 'instant.state', slide: message.instantSlide ?? null })
            const switches = normaliseSwitches(message.switches)
            if (switches) options.onSwitches?.(switches)
            for (const poll of polls) options.onPollState?.(poll)
            options.onBoardSnapshot?.(normaliseOwnBoards(message))
            for (const ack of message.receipts) receipt(ack)
            syncId = ''; attempt = 0
            cancel('handshake'); setStatus('live'); heartbeat(); flushVotes(); flushReactions()
            return
          }
          if (message?.type === 'vote.ack') { receipt(message); return }
          if (message?.type === 'reaction.ack' || message?.type === 'question.ack' || message?.type === 'card.ack') { reactionReceipt(message); return }
          if (message?.type === 'switches.state') {
            const switches = normaliseSwitches(message)
            if (switches) options.onSwitches?.(switches)
            return
          }
          if (message?.type === 'protocol.error' && reactionInFlight && reactionQueue[0]?.submissionId === reactionInFlight) {
            settleReaction(reactionQueue[0], { status: 'rejected', error: 'protocol_error' })
            return
          }
          if (liveStatus !== 'live') return
          const parsed = parseServerMessage(event.data)
          if (parsed?.type === 'poll.state') options.onPollState?.(parsed)
          else if (parsed?.type === 'slide.state') applySlide(parsed)
          else if (parsed?.type === 'session.presence') options.onPresence?.(parsed)
          else if (parsed?.type === 'pointer.live') { if (options.kind === 'screen') options.onPointer?.(parsed.pointer) }
          else if (parsed?.type === 'ink.live') { if (options.kind === 'screen') options.onInk?.(parsed.ink) }
          else if (parsed?.type === 'instant.state') applyInstant(parsed)
        } catch { fail() }
      }
    } catch { fail() }
  }
  function start() {
    if (stopped) return
    if (!participantId) {
      try {
        participantId = storage?.getItem(identityKey) || ''
        if (!participantId) {
          participantId = uuid()
          storage?.setItem(identityKey, participantId)
        }
      } catch { participantId = uuid() }
    }
    connect()
  }
  // Simultaneously opened tabs initialise one browser/session identity under the same lock.
  if (!participantId && typeof navigator !== 'undefined' && navigator.locks) {
    void navigator.locks.request(identityKey, start).catch(start)
  } else start()
  return {
    end() { if (!stopped) { stopped = true; generation++; dispose(); setStatus('ended') } },
    reconnect() { if (!stopped) fail() },
    sendVote(pollId, choice) {
      if (stopped || !pollId) return false
      const existing = [...pending.values()].find((v) => v.pollId === pollId)
      if (existing) return existing.submissionId
      const submissionId = uuid()
      const value = { submissionId, pollId, choice }
      try {
        if (!storage) return false
        storage.setItem(pendingPrefix + submissionId, JSON.stringify(value))
      } catch { return false }
      pending.set(submissionId, value)
      options.onVoteStatus?.({ submissionId, pollId, status: 'pending' })
      flushVotes()
      return submissionId
    },
    /** Queue one reaction (`{ reaction, slideId, tMs, withdrawn?, local? }`): durable, sent in order.
     *  Returns its submission id, or false when it cannot be kept. */
    sendReaction(input) {
      if (stopped || !input || typeof input.reaction !== 'string' || typeof input.slideId !== 'string' || !Number.isSafeInteger(input.tMs)) return false
      if (reactionQueue.length >= 200) return false
      const submissionId = uuid()
      const item = { ...input, submissionId }
      if (!changeStoredQueue((items) => [...items, item])) return false
      reactionQueue = [...reactionQueue, item]
      flushReactions()
      return submissionId
    },
    /** Queue one question (`{ text, name?, slideId, tMs, submissionId? }`): the same durable queue as
     *  reactions, first in first out. A retry passes the submission id it had, so a question the worker
     *  already stored is answered from its receipt and never counted twice. Returns the submission id,
     *  or false when the question cannot be kept (a stopped client, no text, a full or blocked queue). */
    sendQuestion(input) {
      questionRefusal = 'ended'
      if (stopped || !input || typeof input.text !== 'string' || !input.text.trim() || typeof input.slideId !== 'string' || !Number.isSafeInteger(input.tMs)) return false
      // From here the session is up but the question cannot be kept on this device.
      questionRefusal = 'not_kept'
      if (reactionQueue.length >= 200) return false
      const submissionId = typeof input.submissionId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/.test(input.submissionId) ? input.submissionId : uuid()
      if (reactionQueue.some((queued) => queued.submissionId === submissionId)) return submissionId
      const name = typeof input.name === 'string' ? input.name.trim() : ''
      const item = { kind: 'question', submissionId, text: input.text.trim(), ...(name ? { name } : {}), slideId: input.slideId, tMs: input.tMs }
      if (!changeStoredQueue((items) => [...items, item])) return false
      reactionQueue = [...reactionQueue, item]
      flushReactions()
      return submissionId
    },
    /** Queue one card change (`{ op: 'add' | 'edit' | 'withdraw', pollId, column?, text?, cardId?, name?, slideId, tMs }`):
     *  the same durable first-in first-out queue as reactions and questions, so a card typed offline is sent once
     *  the device reconnects. Returns its submission id, or false when it cannot be kept. A refusal stores nothing
     *  on the worker and drops the item here; the box keeps the person's text. */
    sendCard(input) {
      if (stopped || !input || (input.op !== 'add' && input.op !== 'edit' && input.op !== 'withdraw') || typeof input.pollId !== 'string' || !input.pollId
        || typeof input.slideId !== 'string' || !Number.isSafeInteger(input.tMs)) return false
      if (input.op === 'add' ? typeof input.column !== 'string' || !input.column || typeof input.text !== 'string' || !input.text.trim()
        : typeof input.cardId !== 'string' || !input.cardId || (input.op === 'edit' && (typeof input.text !== 'string' || !input.text.trim()))) return false
      if (reactionQueue.length >= 200) return false
      const submissionId = uuid()
      const name = typeof input.name === 'string' ? input.name.trim() : ''
      const item = { kind: 'card', submissionId, op: input.op, pollId: input.pollId,
        ...(input.column ? { column: input.column } : {}), ...(typeof input.text === 'string' ? { text: input.text.trim() } : {}),
        ...(input.cardId ? { cardId: input.cardId } : {}), ...(name && input.op === 'add' ? { name } : {}), slideId: input.slideId, tMs: input.tMs }
      if (!changeStoredQueue((items) => [...items, item])) return false
      reactionQueue = [...reactionQueue, item]
      flushReactions()
      return submissionId
    },
    /** The card changes still in the queue (waiting to send, or sent and not yet answered), oldest first. */
    pendingCards() { return reactionQueue.filter((item) => item.kind === 'card') },
    /** Why the last sendQuestion returned false: 'ended' (stopped or invalid) or 'not_kept' (queue or storage full). */
    questionRefusal: () => questionRefusal,
    status: () => liveStatus,
  }
}

export function liveFollowRuntimeSource() {
  return pointerOverlayRuntimeSource() + '\n' + penInkRuntimeSource() + '\n' + extendedPollRuntimeSource() + '\n' + instantSlideRuntimeSource() + '\n' + audienceReactionsRuntimeSource() + '\n' + audienceAskRuntimeSource() + '\n' + audienceBoardRuntimeSource() + '\n' + audienceMyNotesRuntimeSource() + '\n' + [normaliseFocus, normaliseLightbox, audienceSocketUrl, normaliseBoardPollState, normalisePollState, normaliseInstantSlide, parseServerMessage, escapePollHtml,
    pollTypeLabel, submissionLimit, renderAudiencePollMarkup, shouldRenderAudiencePollUpdate, createAudiencePollRuntime, reconnectDelay,
    audiencePositionsMatch, createAudienceFollowRuntime, normaliseVoteReceipt, normaliseReactionAck, normaliseSwitches, probeAudienceSession, createAudienceFollowClient]
    .map((fn) => fn.toString()).join('\n')
}
