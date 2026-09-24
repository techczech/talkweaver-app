import { isExtendedPoll, normaliseExtendedPollFields, normaliseExtendedPollAggregates, normaliseBallotChoice, samePollChoice, renderExtendedPollResults, createExtendedBallot, extendedPollRuntimeSource } from './poll-extended.js'

/** @typedef {import('../../../worker/protocol').SlideStateMessage | import('../../../worker/protocol').SessionClosedMessage | import('../../../worker/protocol').PollStateMessage} FollowServerMessage */

export function normaliseFocus(value) {
  if (!value || typeof value !== 'object') return null
  if ((value.kind !== 'reveal' && value.kind !== 'focus') || !Number.isInteger(value.step) || value.step < 0) return null
  return { kind: value.kind, step: value.step }
}

export function audienceSocketUrl(baseUrl, sessionId) {
  const url = new URL(baseUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = `/sessions/${encodeURIComponent(sessionId)}/audience`
  url.search = ''
  url.hash = ''
  return url.toString()
}

/** @returns {import('../../../worker/protocol').PollStateMessage|null} */
export function normalisePollState(message) {
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
    if (message?.type === 'poll.state') return normalisePollState(message)
    const focus = message?.focus == null ? null : normaliseFocus(message.focus)
    if (
      message?.type !== 'slide.state' || typeof message.slideId !== 'string' || !message.slideId
      || !Number.isInteger(message.reveal) || message.reveal < 0
      || !Number.isInteger(message.revision) || message.revision < 0
      || (message.focus != null && !focus)
    ) return null
    return { type: 'slide.state', slideId: message.slideId, reveal: message.reveal, focus, revision: message.revision }
  } catch { return null }
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
  const pollMount = document.getElementById('audiencePollSurface')
  const pollRuntime = pollMount ? createAudiencePollRuntime({
    mount: pollMount,
    storage,
    sendVote: (pollId, choice) => client?.sendVote(pollId, choice) || false,
  }) : null

  function renderControls() {
    button.hidden = !sessionLive || diverged
    returnButton.hidden = !sessionLive || !diverged
    button.classList.toggle('is-on', following)
    label.textContent = following ? 'Stop following' : 'Follow live'
    nameWrap.hidden = !sessionLive
    nowLiveBadges.forEach((badge) => { badge.hidden = !sessionLive })
    if (!sessionLive) nameWrap.hidden = true
  }
  function markEnded(reason = 'ended') {
    client?.end()
    client = null
    sessionId = ''
    sessionLive = false
    following = false
    diverged = false
    latestState = null
    pollRuntime?.end()
    renderControls()
    statusEl.textContent = reason === 'expired' ? 'The live session has expired.' : 'The live session has ended.'
    statusEl.hidden = false
  }
  let lastPollSlideId = null
  function receiveLiveState(message) {
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
      storage,
      probe: () => probeAudienceSession(options.liveConfig.workerBaseUrl, sessionId),
      onStatus: (status) => {
        statusEl.textContent = status === 'live' ? 'live'
          : status === 'ended' ? 'the live session has ended'
          : status === 'expired' ? 'the live session has expired'
          : status === 'incompatible' ? 'This handout needs a compatible live service.'
          : 'live paused · reconnecting'
      },
      onSlideState: receiveLiveState,
      onPollState: (message) => pollRuntime?.receive(message),
      onVoteStatus: (receipt) => pollRuntime?.onVoteStatus?.(receipt),
      onEnded: markEnded,
    })
  }
  function resumeFollowing() {
    if (!sessionLive) return
    following = true
    diverged = false
    ensureClient()
    if (latestState && !options.applyLiveSlideState(latestState)) {
      following = false
      diverged = true
    }
    renderControls()
  }
  function viewerMoved() {
    if (!sessionLive || !latestState) return
    diverged = !audiencePositionsMatch(options.getViewerPosition(), latestState)
    if (diverged) following = false
    renderControls()
  }
  returnButton.addEventListener('click', resumeFollowing)
  button.addEventListener('click', () => {
    if (following) {
      following = false
      diverged = false
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
  return { discoverSession, viewerMoved, markEnded }
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
    syncId = ''; nonce = ''
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
  function connect() {
    if (stopped) return
    generation++
    try {
      readPending()
      const url = new URL(audienceSocketUrl(options.baseUrl, options.sessionId))
      url.searchParams.set('protocol', '2')
      url.searchParams.set('participantId', participantId)
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
            for (const poll of polls) options.onPollState?.(poll)
            for (const ack of message.receipts) receipt(ack)
            syncId = ''; attempt = 0
            cancel('handshake'); setStatus('live'); heartbeat(); flushVotes()
            return
          }
          if (message?.type === 'vote.ack') { receipt(message); return }
          if (liveStatus !== 'live') return
          const parsed = parseServerMessage(event.data)
          if (parsed?.type === 'poll.state') options.onPollState?.(parsed)
          else if (parsed?.type === 'slide.state') applySlide(parsed)
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
    status: () => liveStatus,
  }
}

export function liveFollowRuntimeSource() {
  return extendedPollRuntimeSource() + '\n' + [normaliseFocus, audienceSocketUrl, normalisePollState, parseServerMessage, escapePollHtml,
    pollTypeLabel, submissionLimit, renderAudiencePollMarkup, shouldRenderAudiencePollUpdate, createAudiencePollRuntime, reconnectDelay,
    audiencePositionsMatch, createAudienceFollowRuntime, normaliseVoteReceipt, probeAudienceSession, createAudienceFollowClient]
    .map((fn) => fn.toString()).join('\n')
}
