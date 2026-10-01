// The pre-work form on the published handout (ADR-0032 amendment point 2; feedback-boards ticket 10;
// drawings round-2 W1-W12 on a phone, round-3 L3-L5 on a laptop). While the Worker says the Run's
// pre-work is open, this takes the place of the handout's slide list: an overview of the steps, then
// one step per screen, each answer saved as the person goes, "Ask about this" on any step that takes
// questions, "5 of 7" when they come back, and a banner over the slide list once it has closed.
//
// Every function here is one the page runtime embeds by `.toString()` (see preworkFormRuntimeSource), so
// each is self-contained: no module-level constants of its own. The pure parts (what a step's entries
// say, the answer a poll accepts, every refusal's sentence, the icons) are in prework-form-model.js and
// re-exported from here. This file is the screens (createPreworkForm), with the parts that stand alone
// beside it: prework-form-client.js (the Worker's routes: "mine" and one
// submission at a time per thing, so the latest answer always wins on the Worker too),
// prework-form-answer.js (the controls of a step's poll) and prework-closed-banner.js (the closed page).
//
// Participant and author text is untrusted: every text is written with textContent, never as HTML. The
// only markup written as HTML is this file's own icons. The form carries no right answer (the Worker
// refuses a form that does), so a quick check shows "Saved", never a mark.

import { createPreworkClient, preworkFormClientSource } from './prework-form-client.js'
import { createPreworkAnswerControls, preworkAnswerControlsSource } from './prework-form-answer.js'
import { showPreworkClosed, preworkClosedBannerSource } from './prework-closed-banner.js'
import { preworkFormModelSource, preworkIcons, preworkRandomId, preworkMerge, preworkStepState, preworkProgress, preworkMinutesText, preworkKindLabel, preworkKindIcon, preworkWhen, preworkDay, preworkPollHint, preworkAnswerReady, preworkDraftFromEntry, preworkSubmission, preworkEntryFromSubmission, preworkRefusal, preworkSlideLines } from './prework-form-model.js'

export * from './prework-form-model.js'
export { createPreworkClient, createPreworkAnswerControls, showPreworkClosed }
export { preworkFormStyles } from './prework-form-styles.js'

/**
 * The screens. Options: document, mount (the element the form fills), config ({ preworkId, form }),
 * client (createPreworkClient), storage ({ get(key), set(key, value) } or null), random(n) → n random
 * bytes, fitSlide(el) (the page's slide fit), isPhone(), now(), timeZone, deckTitle, schedule(),
 * cancelSchedule(), recheck() (ask the Worker for the status again), onClosed().
 * Methods: setStatus(status, stepSlides), refresh(), state() (a snapshot for tests).
 * @param {any} options
 */
export function createPreworkForm(options) {
  const document = options.document
  const mount = options.mount
  const config = options.config
  const form = config.form
  const client = options.client
  const icons = preworkIcons()
  const now = options.now || (() => Date.now())
  const schedule = options.schedule || ((fn, ms) => setTimeout(fn, ms))
  const cancelSchedule = options.cancelSchedule || ((handle) => clearTimeout(handle))
  const zone = options.timeZone
  const stepSlides = new Map() // step id → the slide element from the handout's template
  const drafts = new Map() // step id → what the controls hold (a text, an option id, a list, a map)
  const asks = new Map() // step id → { text, name } typed in the ask box and not yet sent
  const notes = new Map() // step id → { tone, text } under the answer
  const latest = new Map() // key → the newest body sent for it
  let entries = []
  let loaded = false
  let loadFailed = false
  let status = null
  let view = { type: 'overview' }
  let sheet = null // the phone's ask sheet: { stepId, phase: 'compose' | 'sent', sent }
  let saveTimer = null // the open answer waiting to be saved: { stepId, handle }
  let els = {}
  let opened = false
  let fullscreen = null
  let participant = ''

  const phone = () => Boolean(options.isPhone && options.isPhone())
  const svg = (name, cls) => '<svg class="lucide' + (cls ? ' ' + cls : '') + '" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (icons[name] || '') + '</svg>'
  function el(tag, cls, text) {
    const node = document.createElement(tag)
    if (cls) node.className = cls
    if (text !== undefined && text !== null) node.textContent = String(text)
    return node
  }
  function icon(name, cls) {
    const span = el('span', 'pw-ico' + (cls ? ' ' + cls : ''))
    span.innerHTML = svg(name)
    return span
  }
  function button(cls, label, iconName, onClick) {
    const node = el('button', cls)
    node.type = 'button'
    if (iconName) node.appendChild(icon(iconName))
    if (label !== null && label !== undefined) node.appendChild(el('span', 'pw-btn-label', label))
    if (onClick) node.addEventListener('click', onClick)
    return node
  }
  const stepAt = (index) => form.steps[index]
  const stepIndex = (id) => form.steps.findIndex((step) => step.id === id)
  const progress = () => preworkProgress(form, entries)
  const closesText = () => (status && status.closesAt ? preworkWhen(status.closesAt, zone) : '')
  const clip = (text, max) => { const chars = Array.from(String(text || '')); return chars.length > max ? chars.slice(0, max - 1).join('') + '\u2026' : chars.join('') }

  // ── The device ─────────────────────────────────────────────────────────────────────────────
  function participantId() {
    if (participant) return participant
    const key = 'tw-prework-device-' + config.preworkId
    let held = ''
    try { held = options.storage ? String(options.storage.get(key) || '') : '' } catch (_) { held = '' }
    if (!/^[A-Za-z0-9_-]{16,100}$/.test(held)) {
      held = preworkRandomId(options.random, 16)
      try { if (options.storage) options.storage.set(key, held) } catch (_) { /* kept in this page only */ }
    }
    participant = held
    return participant
  }
  const submissionId = () => 's' + preworkRandomId(options.random, 8)

  // ── Sending ────────────────────────────────────────────────────────────────────────────────
  function setNote(stepId, tone, text) {
    if (text) notes.set(stepId, { tone, text }); else notes.delete(stepId)
    if (view.type === 'step' && stepAt(view.index).id === stepId) paintNote(stepId)
  }
  function paintNote(stepId) {
    if (!els.note) return
    const note = notes.get(stepId)
    els.note.hidden = !note
    els.note.dataset.tone = note ? note.tone : ''
    els.note.textContent = ''
    if (note) {
      els.note.appendChild(icon(note.tone === 'error' ? 'clock' : 'eye'))
      els.note.appendChild(el('span', '', note.text))
    }
  }
  function push(key, body, hooks) {
    latest.set(key, body)
    return client.submit(key, body).then((result) => {
      if (latest.get(key) !== body) return result
      if (result.ok) {
        const at = result.data && result.data.entry && Number.isFinite(result.data.entry.at) ? result.data.entry.at : now()
        entries = preworkMerge(entries, preworkEntryFromSubmission(body, at))
        if (hooks && hooks.saved) hooks.saved()
        paintChrome()
        return result
      }
      const refusal = preworkRefusal(result.status, result.code, result.retryAfterMs)
      if (hooks && hooks.failed) hooks.failed(refusal)
      if (refusal.closed) { if (options.recheck) options.recheck() }
      else if (refusal.retry) schedule(() => { if (latest.get(key) === body) push(key, body, hooks) }, refusal.waitMs || 8000)
      return result
    })
  }
  function markRead(step) {
    if (step.kind !== 'slide' && step.kind !== 'task') return
    if (preworkStepState(step, entries).read) return
    const body = preworkSubmission(participantId(), submissionId(), step.id, 'read')
    entries = preworkMerge(entries, preworkEntryFromSubmission(body, now()))
    push('read:' + step.id, body, null)
    paintChrome()
  }
  function saveAnswer(step) {
    const ready = preworkAnswerReady(step.poll, drafts.get(step.id))
    if (!ready) { setNote(step.id, 'info', ''); return }
    const body = preworkSubmission(participantId(), submissionId(), step.id, 'answer', ready)
    setNote(step.id, 'info', 'Saving\u2026')
    push('answer:' + step.id, body, {
      saved: () => setNote(step.id, 'info', step.kind === 'check' ? 'Saved. You will see how everyone answered in the session.' : 'Saved. You can change it until pre-work closes.'),
      failed: (refusal) => setNote(step.id, 'error', refusal.text),
    })
  }
  function flush() {
    if (!saveTimer) return
    cancelSchedule(saveTimer.handle)
    const held = saveTimer
    saveTimer = null
    const step = stepAt(stepIndex(held.stepId))
    if (step) saveAnswer(step)
  }
  function setDone(step, done) {
    const body = preworkSubmission(participantId(), submissionId(), step.id, 'done', { done })
    const before = entries.find((entry) => entry.ref === 'done:' + step.id) || null
    entries = preworkMerge(entries, preworkEntryFromSubmission(body, now()))
    render('[data-pw-done]')
    push('done:' + step.id, body, {
      failed: (refusal) => {
        setNote(step.id, 'error', refusal.text)
        if (!refusal.retry) {
          entries = before ? preworkMerge(entries, before) : entries.filter((entry) => entry.ref !== 'done:' + step.id)
          render('[data-pw-done]')
        }
      },
    })
  }
  function sendQuestion(step, text, name, then, failed) {
    const clean = String(text || '').trim()
    if (!clean) return
    const id = submissionId()
    const body = preworkSubmission(participantId(), id, step.id, 'question', { text: clean, name })
    const entry = preworkEntryFromSubmission(body, now())
    asks.delete(step.id)
    push('q:' + id, body, {
      saved: () => { if (then) then(entry) },
      failed: (refusal) => { setNote(step.id, 'error', refusal.text); if (!refusal.retry && failed) failed() },
    })
    // A question shows as sent when the Worker has it; until then it stays in the box's place.
    if (els.askStatus) { els.askStatus.hidden = false; els.askStatus.textContent = 'Sending\u2026' }
  }

  // ── Loading what this person already did ("coming back later") ─────────────────────────────
  function load() {
    loaded = false
    loadFailed = false
    render()
    client.load(participantId()).then((result) => {
      loaded = true
      loadFailed = !result.ok
      if (result.ok) {
        let merged = result.entries
        // What was done in this page while the load was in flight wins over what the Worker had.
        for (const entry of entries) merged = preworkMerge(merged, entry)
        entries = merged
      }
      render()
    })
  }

  // ── Pieces ─────────────────────────────────────────────────────────────────────────────────
  function bar(fraction, cls) {
    const track = el('div', 'pw-track' + (cls ? ' ' + cls : ''))
    track.setAttribute('role', 'progressbar')
    track.setAttribute('aria-valuemin', '0')
    track.setAttribute('aria-valuemax', '100')
    track.setAttribute('aria-valuenow', String(Math.round(fraction * 100)))
    const fill = el('span', 'pw-fill')
    fill.style.width = Math.round(fraction * 100) + '%'
    track.appendChild(fill)
    return track
  }
  function stateBadge(row) {
    const badge = el('span', 'pw-state pw-state-' + row.tone)
    badge.appendChild(icon(row.tone === 'done' ? 'circle-check' : row.tone === 'started' ? 'circle-dashed' : 'circle'))
    badge.appendChild(el('span', '', row.label))
    return badge
  }
  function kindLine(step, long) {
    const line = el('span', 'pw-kind')
    line.appendChild(icon(preworkKindIcon(step)))
    line.appendChild(el('span', '', preworkKindLabel(step, long)))
    return line
  }
  function questionsLine(row) {
    const count = row.questions.length
    if (!count) return null
    const line = el('span', 'pw-row-q')
    line.appendChild(icon('message-circle-question-mark'))
    line.appendChild(el('span', '', count === 1 ? 'Your question is with the speaker' : 'Your ' + count + ' questions are with the speaker'))
    return line
  }
  function stepRow(row, index, opts) {
    const node = el('button', 'pw-row' + (opts && opts.current ? ' is-current' : ''))
    node.type = 'button'
    node.dataset.step = String(index + 1)
    if (opts && opts.current) node.setAttribute('aria-current', 'step')
    node.appendChild(el('span', 'pw-n', index + 1))
    const body = el('span', 'pw-row-body')
    body.appendChild(kindLine(row.step, false))
    body.appendChild(el('span', 'pw-row-title', row.step.title))
    if (!(opts && opts.rail)) { const q = questionsLine(row); if (q) body.appendChild(q) }
    node.appendChild(body)
    node.appendChild(stateBadge(row))
    node.addEventListener('click', () => go(index))
    return node
  }
  function stepList(opts) {
    const list = el('div', 'pw-steps')
    progress().steps.forEach((row, index) => list.appendChild(stepRow(row, index, { current: opts && opts.currentIndex === index, rail: opts && opts.rail })))
    return list
  }
  function talkTitle() { return String(options.deckTitle || '') }
  function ctaLabel(p) { return p.started ? 'Carry on: step ' + (p.next === null ? p.total : p.next + 1) : 'Start with step 1' }

  // ── The overview (W1, W10, W11, L3) ────────────────────────────────────────────────────────
  function overview() {
    const p = progress()
    const wide = !phone()
    const page = el('div', 'pw-overview' + (wide ? ' is-wide' : ''))
    els = {}
    const main = el('div', 'pw-main')
    if (!wide) {
      const head = el('div', 'pw-talkbar')
      head.appendChild(el('p', 'pw-talk-title', talkTitle()))
      page.appendChild(head)
      const meter = el('div', 'pw-meter')
      meter.appendChild(el('span', 'pw-count', p.doneCount + ' of ' + p.total + ' done'))
      meter.appendChild(bar(p.total ? p.doneCount / p.total : 0))
      meter.appendChild(el('span', 'pw-closes', closesText() ? 'Closes ' + closesText() : ''))
      page.appendChild(meter)
    }
    if (loadFailed) {
      const warn = el('div', 'pw-banner pw-banner-warn')
      warn.setAttribute('role', 'status')
      warn.appendChild(icon('clock'))
      warn.appendChild(el('span', '', 'Could not check your earlier answers.'))
      warn.appendChild(button('pw-link', 'Try again', null, () => load()))
      main.appendChild(warn)
    } else if (p.started && !p.allDone) {
      const back = el('div', 'pw-banner pw-banner-info')
      back.setAttribute('role', 'status')
      back.appendChild(icon('history'))
      back.appendChild(el('span', '', 'Welcome back. Your answers are kept ' + (wide ? 'in this browser' : 'on this phone\u2019s browser') + ', not under your name.'))
      main.appendChild(back)
    }
    if (p.allDone) {
      const thanks = el('section', 'pw-thanks')
      thanks.setAttribute('role', 'status')
      const title = el('h2', 'pw-thanks-title')
      title.appendChild(icon('circle-check'))
      title.appendChild(el('span', '', 'All done. Thank you.'))
      thanks.appendChild(title)
      thanks.appendChild(el('p', '', 'The speaker reads your answers before the session; some will be on the slides on the day. You can change an answer or untick a task until ' + (closesText() ? closesText().replace(/ (\d\d:\d\d)$/, ' at $1') : 'pre-work closes') + '.'))
      main.appendChild(thanks)
    }
    main.appendChild(el('h1', 'pw-title', form.title || 'Before the session'))
    if (form.intro) main.appendChild(el('p', 'pw-intro', form.intro))
    const chips = el('div', 'pw-chips')
    const minutes = preworkMinutesText(form)
    if (minutes) { const chip = el('span', 'pw-chip'); chip.appendChild(icon('clock')); chip.appendChild(el('span', '', minutes)); chips.appendChild(chip) }
    const anon = el('span', 'pw-chip'); anon.appendChild(icon('eye-off')); anon.appendChild(el('span', '', 'No name, no account')); chips.appendChild(anon)
    if (wide && closesText()) { const open = el('span', 'pw-chip'); open.appendChild(icon('clock')); open.appendChild(el('span', '', 'Open until ' + closesText().replace(/ (\d\d:\d\d)$/, ' at $1'))); chips.appendChild(open) }
    main.appendChild(chips)
    if (!wide && !p.allDone) {
      const cta = button('pw-primary pw-cta', ctaLabel(p), 'arrow-right', () => go(p.next === null ? 0 : p.next))
      cta.dataset.pwCta = '1'
      main.appendChild(cta)
    }
    if (!wide) main.appendChild(el('h2', 'pw-h2', 'The steps'))
    main.appendChild(stepList())
    page.appendChild(main)
    if (wide) {
      const side = el('aside', 'pw-side')
      const card = el('div', 'pw-card')
      card.appendChild(el('p', 'pw-talk-title', talkTitle()))
      side.appendChild(card)
      const meter = el('div', 'pw-card')
      meter.appendChild(el('p', 'pw-count', p.doneCount + ' of ' + p.total + ' done'))
      meter.appendChild(bar(p.total ? p.doneCount / p.total : 0))
      meter.appendChild(el('p', 'pw-small', 'Each answer saves as you go. Do the steps in any order and come back to this page later.'))
      side.appendChild(meter)
      if (!p.allDone) {
        const cta = button('pw-primary pw-cta', ctaLabel(p), 'arrow-right', () => go(p.next === null ? 0 : p.next))
        cta.dataset.pwCta = '1'
        cta.appendChild(cta.firstChild) // on a laptop the arrow follows the words (L3)
        side.appendChild(cta)
      }
      page.appendChild(side)
    }
    return page
  }

  // ── A step (W2-W9, L4, L5) ─────────────────────────────────────────────────────────────────
  function slideCanvas(step) {
    const source = stepSlides.get(step.id)
    if (!source) return null
    const canvas = el('div', 'pw-canvas')
    const inner = el('div', 'pw-inner')
    const copy = source.cloneNode(true)
    copy.classList.add('active')
    copy.removeAttribute('id')
    const notes = copy.querySelector('.notes')
    if (notes) notes.remove()
    inner.appendChild(copy)
    canvas.appendChild(inner)
    const fit = () => {
      const width = canvas.clientWidth
      if (width > 0) inner.style.transform = 'scale(' + (width / 1280) + ')'
      if (options.fitSlide) options.fitSlide(copy)
    }
    canvas._fit = fit
    els.canvases.push(canvas)
    return canvas
  }
  function answerControls(step) {
    const saved = preworkDraftFromEntry(preworkStepState(step, entries).answer)
    if (!drafts.has(step.id) && saved !== null) drafts.set(step.id, saved)
    return createPreworkAnswerControls({
      document, step, schedule, cancelSchedule,
      draft: () => drafts.get(step.id),
      set: (value) => drafts.set(step.id, value),
      commit: () => saveAnswer(step),
      typing: (text) => {
        if (saveTimer) cancelSchedule(saveTimer.handle)
        setNote(step.id, 'info', text.trim() ? 'Typing\u2026' : '')
        saveTimer = { stepId: step.id, handle: schedule(() => { saveTimer = null; saveAnswer(step) }, 700) }
      },
      blur: () => flush(),
      clear: () => setNote(step.id, 'info', ''),
    })
  }
  function doneControl(step, row, compact) {
    if (step.kind !== 'task' || !step.done) return null
    const node = el('button', row.done ? 'pw-done is-done' : 'pw-done pw-done-todo')
    node.type = 'button'
    node.dataset.pwDone = row.done ? 'done' : 'todo'
    node.setAttribute('aria-pressed', row.done ? 'true' : 'false')
    node.appendChild(icon(row.done ? 'circle-check' : 'square-check'))
    node.appendChild(el('span', 'pw-done-main', row.done ? 'Done' : 'Mark as done'))
    if (row.done) node.appendChild(el('span', 'pw-done-hint', compact ? 'Click to untick' : 'Tap to untick'))
    node.addEventListener('click', () => setDone(step, !row.done))
    return node
  }
  function questionCards(step, row) {
    const out = []
    if (row.questions.length === 0) return out
    for (const q of row.questions) {
      const card = el('div', 'pw-yourq')
      card.dataset.pwQuestion = '1'
      const head = el('p', 'pw-yourq-head')
      head.appendChild(icon('message-circle-question-mark'))
      head.appendChild(el('span', '', 'Your question'))
      card.appendChild(head)
      card.appendChild(el('p', 'pw-yourq-text', q.text || ''))
      card.appendChild(el('p', 'pw-small', 'With the speaker \u00b7 answered in the session'))
      out.push(card)
    }
    return out
  }
  function doneNote(row) {
    if (!row.done) return null
    const entry = entries.find((item) => item.ref === 'done:' + row.step.id)
    const box = el('div', 'pw-donenote')
    box.setAttribute('role', 'status')
    const head = el('p', 'pw-donenote-head')
    head.appendChild(icon('circle-check'))
    head.appendChild(el('span', '', 'Done \u00b7 marked ' + preworkDay(entry ? entry.at : now(), zone)))
    box.appendChild(head)
    box.appendChild(el('p', '', 'The speaker sees how many people have done each task, not who.'))
    return box
  }
  function stepHead(step) {
    const head = el('div', 'pw-stephead')
    head.appendChild(kindLine(step, true))
    head.appendChild(el('h2', 'pw-step-title', step.title))
    return head
  }
  function pollIntro(step) {
    const wrap = el('div', 'pw-pollintro')
    if (step.poll && step.poll.question && step.poll.question !== step.title) wrap.appendChild(el('p', 'pw-prompt', step.poll.question))
    wrap.appendChild(el('p', 'pw-hint', preworkPollHint(step)))
    return wrap
  }
  function stepContent(step, row, wide) {
    const box = el('div', 'pw-content')
    if (step.kind === 'check' || step.kind === 'question') {
      box.appendChild(stepHead(step))
      box.appendChild(pollIntro(step))
      box.appendChild(answerControls(step))
      const note = el('p', 'pw-note')
      note.setAttribute('role', 'status')
      note.hidden = true
      els.note = note
      box.appendChild(note)
      return box
    }
    const canvas = slideCanvas(step)
    if (canvas) box.appendChild(canvas)
    if (!wide) {
      box.appendChild(stepHead(step))
      const lines = preworkSlideLines(stepSlides.get(step.id))
      if (lines.length) {
        const list = el('ul', 'pw-lines')
        for (const line of lines) list.appendChild(el('li', line.item ? 'is-item' : 'is-para', line.text))
        box.appendChild(list)
      }
      if (step.kind === 'task' && step.done) box.appendChild(el('p', 'pw-hint', 'When you have done it, mark it done.' + (step.questions ? ' Stuck? Ask about it: the speaker reads questions before the session.' : '')))
    }
    const note = el('p', 'pw-note')
    note.setAttribute('role', 'status')
    note.hidden = true
    els.note = note
    box.appendChild(note)
    return box
  }
  function stepFooter(step, index, row, wide) {
    const foot = el('div', 'pw-foot')
    const last = index === form.steps.length - 1
    const done = doneControl(step, row, wide)
    const prev = button('pw-prev', wide ? 'Previous' : null, 'chevron-left', () => go(index - 1))
    prev.setAttribute('aria-label', 'Previous step')
    prev.disabled = index === 0
    const next = last
      ? button('pw-primary pw-next', 'Finish', 'check', () => finish())
      : button('pw-primary pw-next', wide ? 'Next step' : 'Next', 'chevron-right', () => go(index + 1))
    next.appendChild(next.firstChild) // the arrow (or the tick) follows the word
    if (wide) {
      const bar = el('div', 'pw-actions')
      if (done) bar.appendChild(done)
      const spacer = el('span', 'pw-spacer')
      bar.appendChild(spacer)
      bar.appendChild(prev)
      bar.appendChild(next)
      return bar
    }
    if (done) foot.appendChild(done)
    const nav = el('div', 'pw-nav')
    nav.appendChild(prev)
    if (step.questions) nav.appendChild(button('pw-ask', 'Ask about this', 'message-circle-question-mark', () => { sheet = { stepId: step.id, phase: 'compose' }; render('.pw-sheet textarea') }))
    else nav.appendChild(el('span', 'pw-spacer'))
    nav.appendChild(next)
    foot.appendChild(nav)
    return foot
  }
  function askColumn(step, row) {
    const col = el('aside', 'pw-askcol')
    col.appendChild(el('h2', 'pw-ask-title', 'Ask about this step'))
    if (!step.questions) {
      col.appendChild(el('p', 'pw-small', 'Questions are off for this step.'))
      return col
    }
    for (const card of questionCards(step, row)) col.appendChild(card)
    const done = doneNote(row)
    if (done) col.appendChild(done)
    if (row.questions.length === 0) col.appendChild(el('p', 'pw-small', 'Stuck, or not sure what is meant? Ask here. The speaker reads questions before the session and answers them in it. Nobody else sees yours.'))
    const held = asks.get(step.id) || { text: '', name: '' }
    const text = document.createElement('textarea')
    text.className = 'pw-text pw-asktext'
    text.rows = 3
    text.maxLength = 500
    text.placeholder = 'Type your question'
    text.setAttribute('aria-label', 'Your question')
    text.value = held.text
    const name = document.createElement('input')
    name.className = 'pw-name'
    name.type = 'text'
    name.maxLength = 60
    name.placeholder = 'No name'
    name.autocomplete = 'off'
    name.setAttribute('aria-label', 'Your name (optional)')
    name.value = held.name
    const send = button('pw-send', 'Send', 'send', () => {
      send.disabled = true // one press, one question, until the Worker has it
      sendQuestion(step, text.value, name.value, () => { asks.delete(step.id); render('.pw-asktext') }, () => { send.disabled = !text.value.trim() })
    })
    send.disabled = !text.value.trim()
    const keep = () => { asks.set(step.id, { text: text.value, name: name.value }); send.disabled = !text.value.trim() }
    text.addEventListener('input', keep)
    name.addEventListener('input', keep)
    text.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !send.disabled) { event.preventDefault(); send.click() }
    })
    col.appendChild(text)
    const line = el('div', 'pw-askline')
    line.appendChild(icon('eye-off'))
    line.appendChild(name)
    line.appendChild(send)
    col.appendChild(line)
    const sending = el('p', 'pw-small pw-askstatus')
    sending.hidden = true
    sending.setAttribute('role', 'status')
    els.askStatus = sending
    col.appendChild(sending)
    return col
  }
  function sheetView(step, row) {
    const wrap = el('div', 'pw-sheet-wrap')
    wrap.addEventListener('click', (event) => { if (event.target === wrap) closeSheet() })
    const panel = el('div', 'pw-sheet')
    panel.setAttribute('role', 'dialog')
    panel.setAttribute('aria-modal', 'true')
    panel.setAttribute('aria-label', 'Ask about this step')
    panel.appendChild(el('span', 'pw-grip'))
    const head = el('div', 'pw-sheet-head')
    head.appendChild(el('h2', 'pw-sheet-title', 'Ask about this step'))
    const x = button('pw-x', null, 'x', () => closeSheet())
    x.setAttribute('aria-label', 'Close')
    head.appendChild(x)
    panel.appendChild(head)
    const about = el('p', 'pw-about')
    about.appendChild(icon('message-circle-question-mark'))
    about.appendChild(el('b', '', 'Step ' + (stepIndex(step.id) + 1) + ' \u00b7 ' + (step.kind === 'check' ? 'quick check' : step.kind === 'task' ? 'pre-task' : step.kind)))
    about.appendChild(el('span', '', clip(step.title, 30)))
    if (sheet.phase === 'sent') {
      const ok = el('p', 'pw-sent')
      ok.appendChild(icon('circle-check'))
      ok.appendChild(el('span', '', 'Sent to the speaker'))
      panel.appendChild(ok)
      const quote = el('blockquote', 'pw-quote', sheet.sent.text || '')
      panel.appendChild(quote)
      panel.appendChild(el('p', 'pw-small', 'About Step ' + (stepIndex(step.id) + 1) + ' \u00b7 ' + step.title + ' \u00b7 ' + (sheet.sent.name ? sheet.sent.name : 'no name')))
      panel.appendChild(el('p', 'pw-small', 'Only the speaker sees it.'))
      const actions = el('div', 'pw-sheet-actions')
      actions.appendChild(button('pw-secondary', 'Ask another', 'message-circle-question-mark', () => { sheet = { stepId: step.id, phase: 'compose' }; render('.pw-sheet textarea') }))
      actions.appendChild(button('pw-primary', 'Done', null, () => closeSheet()))
      panel.appendChild(actions)
    } else {
      panel.appendChild(about)
      const held = asks.get(step.id) || { text: '', name: '' }
      const label = el('label', 'pw-label', 'Your question')
      const text = document.createElement('textarea')
      text.className = 'pw-text pw-asktext'
      text.rows = 4
      text.maxLength = 500
      text.value = held.text
      label.appendChild(text)
      panel.appendChild(label)
      const nameLabel = el('label', 'pw-label', 'Your name (optional)')
      const name = document.createElement('input')
      name.className = 'pw-name pw-name-block'
      name.type = 'text'
      name.maxLength = 60
      name.placeholder = 'Leave empty to ask without a name'
      name.autocomplete = 'off'
      name.value = held.name
      nameLabel.appendChild(name)
      panel.appendChild(nameLabel)
      const privacy = el('p', 'pw-privacy')
      privacy.appendChild(icon('eye-off'))
      privacy.appendChild(el('span', '', 'Only the speaker sees this. Nobody else in the room does.'))
      panel.appendChild(privacy)
      const send = button('pw-primary pw-send-wide', 'Send', 'send', () => {
        send.disabled = true // one press, one question, until the Worker has it
        sendQuestion(step, text.value, name.value, (entry) => {
          if (sheet && sheet.stepId === step.id) { sheet = { stepId: step.id, phase: 'sent', sent: { text: entry.text, name: entry.name } }; render('.pw-sheet .pw-primary') }
        }, () => { send.disabled = !text.value.trim() })
      })
      send.disabled = !text.value.trim()
      const keep = () => { asks.set(step.id, { text: text.value, name: name.value }); send.disabled = !text.value.trim() }
      text.addEventListener('input', keep)
      name.addEventListener('input', keep)
      panel.appendChild(send)
      const sending = el('p', 'pw-small pw-askstatus')
      sending.hidden = true
      sending.setAttribute('role', 'status')
      els.askStatus = sending
      panel.appendChild(sending)
    }
    wrap.appendChild(panel)
    return wrap
  }
  function closeSheet() { sheet = null; render() }

  function stepScreen() {
    const index = view.index
    const step = stepAt(index)
    const p = progress()
    const row = p.steps[index]
    const wide = !phone()
    els = { canvases: [] }
    const root = el('div', 'pw-stepview' + (wide ? ' is-wide' : ''))
    const fullBtn = () => {
      if (step.kind !== 'slide' && step.kind !== 'task') return el('span', 'pw-spacer')
      return button('pw-top-btn pw-full', 'Full screen', 'maximize-2', () => openFullscreen(step))
    }
    if (!wide) {
      const top = el('div', 'pw-top')
      top.appendChild(button('pw-top-btn pw-back', 'Steps', 'chevron-left', () => go(null)))
      top.appendChild(el('span', 'pw-stepno', 'Step ' + (index + 1) + ' of ' + form.steps.length))
      top.appendChild(fullBtn())
      root.appendChild(top)
      root.appendChild(bar(index / form.steps.length, 'pw-thin'))
      const body = el('div', 'pw-body')
      body.appendChild(stepContent(step, row, false))
      const done = doneNote(row)
      if (done) body.appendChild(done)
      for (const card of questionCards(step, row)) body.appendChild(card)
      root.appendChild(body)
      root.appendChild(stepFooter(step, index, row, false))
      if (sheet && sheet.stepId === step.id) root.appendChild(sheetView(step, row))
      paintNote(step.id)
      return root
    }
    const rail = el('nav', 'pw-rail')
    rail.setAttribute('aria-label', 'Steps')
    els.rail = rail
    rail.appendChild(el('p', 'pw-talk-title', talkTitle()))
    const meter = el('p', 'pw-railcount', p.doneCount + ' of ' + p.total + ' done' + (closesText() ? ' \u00b7 closes ' + closesText() : ''))
    els.railCount = meter
    rail.appendChild(meter)
    els.railBar = bar(p.total ? p.doneCount / p.total : 0)
    rail.appendChild(els.railBar)
    els.railList = stepList({ currentIndex: index, rail: true })
    rail.appendChild(els.railList)
    root.appendChild(rail)
    const center = el('section', 'pw-center')
    const head = el('div', 'pw-centerhead')
    head.appendChild(el('span', 'pw-stepno', 'Step ' + (index + 1) + ' of ' + form.steps.length))
    head.appendChild(kindLine(step, true))
    head.appendChild(el('span', 'pw-spacer'))
    const keys = el('span', 'pw-keys')
    keys.appendChild(icon('keyboard'))
    keys.appendChild(el('span', '', '\u2190 \u2192 to move between steps'))
    head.appendChild(keys)
    center.appendChild(head)
    const card = el('div', 'pw-cardbox')
    card.appendChild(stepContent(step, row, true))
    center.appendChild(card)
    center.appendChild(stepFooter(step, index, row, true))
    root.appendChild(center)
    root.appendChild(askColumn(step, row))
    paintNote(step.id)
    return root
  }

  // ── Screens and moving between them ────────────────────────────────────────────────────────
  function fitCanvases() {
    if (!els.canvases) return
    for (const canvas of els.canvases) if (canvas._fit) canvas._fit()
  }
  function render(focus) {
    if (!opened) return
    mount.textContent = ''
    mount.dataset.mode = phone() ? 'phone' : 'laptop'
    els = {}
    if (!loaded && !loadFailed) {
      mount.appendChild(el('p', 'pw-loading', 'Loading\u2026'))
      return
    }
    const scroller = el('div', 'pw-scroll')
    scroller.appendChild(view.type === 'step' ? stepScreen() : overview())
    mount.appendChild(scroller)
    if (view.type === 'step') {
      const schedule2 = options.frame || ((fn) => requestAnimationFrame(fn))
      schedule2(() => { fitCanvases(); schedule2(fitCanvases) })
    }
    if (focus) {
      const target = mount.querySelector(focus)
      if (target && target.focus) target.focus()
    }
  }
  function paintChrome() {
    // A save that lands while the overview is showing (Finish, or Steps, right after typing) updates it.
    if (view.type === 'overview' && opened && loaded) { const held = mount.querySelector('.pw-scroll'); const top = held ? held.scrollTop : 0; render(); const fresh = mount.querySelector('.pw-scroll'); if (fresh) fresh.scrollTop = top; return }
    if (view.type !== 'step' || !els.rail) return
    const p = progress()
    if (els.railCount) els.railCount.textContent = p.doneCount + ' of ' + p.total + ' done' + (closesText() ? ' \u00b7 closes ' + closesText() : '')
    if (els.railBar) { const fill = els.railBar.querySelector('.pw-fill'); if (fill) fill.style.width = Math.round((p.total ? p.doneCount / p.total : 0) * 100) + '%' }
    if (els.railList) {
      const fresh = stepList({ currentIndex: view.index, rail: true })
      els.railList.replaceWith(fresh)
      els.railList = fresh
    }
  }
  function go(index) {
    flush()
    sheet = null
    if (index === null || index < 0 || index >= form.steps.length) {
      view = { type: 'overview' }
      render('[data-pw-cta]')
      const scroller = mount.querySelector('.pw-scroll')
      if (scroller) scroller.scrollTop = 0
      return
    }
    view = { type: 'step', index }
    render()
    markRead(stepAt(index))
    paintChrome()
    const scroller = mount.querySelector('.pw-scroll')
    if (scroller) scroller.scrollTop = 0
  }
  function finish() {
    flush()
    view = { type: 'overview' }
    render()
  }
  function openFullscreen(step) {
    const source = stepSlides.get(step.id)
    if (!source || fullscreen) return
    const layer = el('div', 'pw-fsview')
    layer.setAttribute('role', 'dialog')
    layer.setAttribute('aria-modal', 'true')
    layer.setAttribute('aria-label', 'Slide full screen')
    const inner = el('div', 'pw-fsinner')
    const copy = source.cloneNode(true)
    copy.classList.add('active')
    copy.removeAttribute('id')
    const notes = copy.querySelector('.notes')
    if (notes) notes.remove()
    inner.appendChild(copy)
    layer.appendChild(inner)
    const close = button('pw-fsclose', null, 'x', () => closeFullscreen())
    close.setAttribute('aria-label', 'Close full screen')
    layer.appendChild(close)
    mount.appendChild(layer)
    fullscreen = layer
    const fit = () => {
      const frame = document.defaultView
      const scale = Math.min(frame.innerWidth / 1280, frame.innerHeight / 720)
      inner.style.transform = 'translate(-50%, -50%) scale(' + scale + ')'
      if (options.fitSlide) options.fitSlide(copy)
    }
    layer._fit = fit
    fit()
    close.focus()
  }
  function closeFullscreen() {
    if (!fullscreen) return
    fullscreen.remove()
    fullscreen = null
  }
  function onKey(event) {
    if (!opened || mount.hidden) return
    // While the form is on the page the handout's own shortcuts (?, /, O, N, the arrows) stay quiet.
    if (!event.metaKey && !event.ctrlKey && !event.altKey) event.stopPropagation()
    if (event.key === 'Escape') {
      if (fullscreen) { closeFullscreen(); return }
      if (sheet) { closeSheet(); return }
    }
    const target = event.target
    const typing = target && target.tagName && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)
    if (typing || event.metaKey || event.ctrlKey || event.altKey || view.type !== 'step' || sheet) return
    if (event.key === 'ArrowRight' && view.index < form.steps.length - 1) { event.preventDefault(); go(view.index + 1) }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); go(view.index === 0 ? null : view.index - 1) }
  }
  const win = document.defaultView
  if (win) win.addEventListener('keydown', onKey, true)
  let wasPhone = phone()
  if (win) win.addEventListener('resize', () => {
    if (!opened) return
    if (phone() !== wasPhone) { wasPhone = phone(); flush(); render() } else { fitCanvases(); if (fullscreen && fullscreen._fit) fullscreen._fit() }
  })
  if (win) win.addEventListener('online', () => { if (opened && loadFailed) load() })

  return {
    /**
     * The Worker's answer and the handout's step slides. Open: the form takes the page. Anything else:
     * it goes away (the page's own slide list and, once closed, its banner are the page's).
     */
    setStatus(next, slideElements) {
      status = next
      for (const slide of slideElements || []) { const id = slide.dataset && slide.dataset.id ? slide.dataset.id : slide.id; if (id) stepSlides.set(id, slide) }
      const open = Boolean(next && next.state === 'open')
      if (open && !opened) {
        opened = true
        mount.hidden = false
        if (mount.ownerDocument && mount.ownerDocument.body) mount.ownerDocument.body.classList.add('pw-open')
        load()
      } else if (!open && opened) {
        opened = false
        flush()
        mount.hidden = true
        mount.textContent = ''
        if (mount.ownerDocument && mount.ownerDocument.body) mount.ownerDocument.body.classList.remove('pw-open')
        if (options.onClosed) options.onClosed(next)
      } else if (open) render()
    },
    refresh() { render() },
    /** A snapshot for tests: which screen, how far the person is, what the Worker last said. */
    state() { const p = progress(); return { view, loaded, loadFailed, doneCount: p.doneCount, total: p.total, next: p.next, entries: entries.slice(), participant } },
  }
}

export function preworkFormRuntimeSource() {
  return [preworkFormModelSource(), preworkFormClientSource(), preworkAnswerControlsSource(), createPreworkForm.toString(), preworkClosedBannerSource()].join('\n')
}
