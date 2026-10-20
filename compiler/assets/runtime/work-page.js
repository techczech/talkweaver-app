// The participant work page (work-files ticket 15; ADR-0040 decisions 2 and 4; locked mockup section 13):
// a Run's pre-work or post-work on its own page, `…/<run>/pre-work` or `…/<run>/post-work`. The 0.37 form
// (prework-form.js) rebuilt as a page of its own: on a laptop a rail of steps with a link back to the
// session handout, the step card and the "Ask about this step" column; on a phone a top bar, the
// handout link under it, the step and the navigation at the bottom. Post-work is the same page headed
// "After the session". Each answer is saved as the person goes; "5 of 7 done" shows when they come back;
// once it has closed the page shows the 0.37 closed banner.
//
// Every function here is one the page embeds by `.toString()` (see workPageRuntimeSource), so each is
// self-contained. The pure parts are the 0.37 model (prework-form-model.js: entries, progress, answers,
// refusals), its Worker client and answer controls, and work-page-parts.js.
//
// Where an answer goes (2026-10-19 prework-responses design): a step the file marks `{local}` is Local only.
// Nothing about it is sent, not even a read or a done mark: its state is kept in the phone's browser
// (work-page-store.js) and the page says so on the step ("Only on this phone"). Every other step is sent
// to the speaker, and says so ("Sent to the speaker", with when). A Sent submission is kept in the browser's
// outbox until the Worker has it, so an answer typed offline, or in a tab that closed, goes on the next
// chance; "Ask about this" is always sent.
//
// Untrusted text (every title, the intro, poll labels, typed answers and questions) is written with
// textContent, never as HTML. What is inserted as HTML: this file's own icons, and a step's slide, which
// arrives already sanitised (src/shared/work-step-html.ts) in the page's inert template and is cloned
// from there. The form carries no right answer.

import { createPreworkClient, preworkFormClientSource } from './prework-form-client.js'
import { createPreworkAnswerControls, preworkAnswerControlsSource } from './prework-form-answer.js'
import { showPreworkClosed, preworkClosedBannerSource } from './prework-closed-banner.js'
import { preworkFormModelSource, preworkIcons, preworkRandomId, preworkMerge, preworkStepState, preworkProgress, preworkMinutesText, preworkWhen, preworkPollHint, preworkAnswerReady, preworkDraftFromEntry, preworkSubmission, preworkEntryFromSubmission, preworkRefusal } from './prework-form-model.js'
import { createWorkPageAsk, workPageAskSource } from './work-page-ask.js'
import { createWorkPageStore, workPageStoreSource } from './work-page-store.js'
import { workPagePartsSource, workPageIcons, workPageActivateMedia, workPageRenderMermaid, workPageSlideLines, workPageWords, workPageFetchStatus, workPageHandoutHref, workPageShownAddress } from './work-page-parts.js'

export * from './work-page-parts.js'
export { createPreworkClient, showPreworkClosed }

/**
 * The kind of a step as the page names it (mockup 13): "Video", "Quick check", "Task · about 15 min",
 * "Open question", "Rating · 1 to 5", "Question", "Slide". `short` gives the rail's first word(s).
 * @param {any} step @param {boolean} video @param {boolean} [short]
 */
export function workPageKind(step, video, short) {
  let icon = 'presentation'
  let label = 'Slide'
  if (video) { icon = 'video'; label = 'Video' }
  else if (step.kind === 'check') { icon = 'list-checks'; label = 'Quick check' }
  else if (step.kind === 'task') { icon = 'pencil-line'; label = 'Task \u00b7 about ' + (Number(step.minutes) > 0 ? Number(step.minutes) : 10) + ' min' }
  else if (step.kind === 'question') {
    const poll = step.poll || {}
    const labels = Array.isArray(poll.labels) ? poll.labels : []
    if (poll.type === 'open') { icon = 'message-circle-question-mark'; label = 'Open question' }
    else if (poll.type === 'rating' && labels.length) {
      icon = 'gauge'
      const end = (item) => String(item.label).split(' \u00b7 ')[0]
      label = 'Rating \u00b7 ' + end(labels[0]) + ' to ' + end(labels[labels.length - 1])
    } else { icon = 'chart-bar'; label = 'Question' }
  }
  return { icon, label: short ? label.split(' \u00b7 ')[0] : label }
}

/**
 * The page. Options: document, mount, config ({ phase, preworkId, workerBaseUrl, form, talkTitle,
 * runLine, handoutUrl, videoSteps }), client (createPreworkClient), storage ({ get, set } or null),
 * random(n), isPhone(), now(), timeZone, schedule(fn, ms), cancelSchedule(handle), frame(fn),
 * stepNode(id) (a fresh copy of the step's sanitised slide, or null), fetchStatus() (→ workPageFetchStatus),
 * mermaid (or null).
 * Methods: start() (asks the Worker and draws), state() (a snapshot for tests).
 * @param {any} options
 */
export function createWorkPage(options) {
  const document = options.document
  const mount = options.mount
  const config = options.config
  const form = config.form
  const client = options.client
  const words = workPageWords(config.phase)
  const icons = Object.assign({}, preworkIcons(), workPageIcons())
  const now = options.now || (() => Date.now())
  const schedule = options.schedule || ((fn, ms) => setTimeout(fn, ms))
  const cancelSchedule = options.cancelSchedule || ((handle) => clearTimeout(handle))
  const frame = options.frame || ((fn) => requestAnimationFrame(fn))
  const zone = options.timeZone
  const videos = new Set(Array.isArray(config.videoSteps) ? config.videoSteps : [])
  const handoutHref = workPageHandoutHref(config.handoutUrl)
  const drafts = new Map()
  const asks = new Map()
  const notes = new Map()
  const latest = new Map()
  let entries = []
  let loaded = false
  let loadFailed = false
  let status = null
  let outcome = 'loading' // loading | open | not_yet | closed | unavailable | unreachable
  let view = { type: 'overview' }
  let sheet = null
  let finished = false
  let saveTimer = null
  let els = {}
  let participant = ''
  // Local only entries and the unsent outbox, kept in the browser; both are on the screen from the start.
  const store = createWorkPageStore(options.storage || null, config.preworkId)
  const isLocal = (step) => Boolean(step && step.local === true && step.kind !== 'slide')
  const known = (stepId) => form.steps.some((step) => step.id === stepId)
  const localStep = (stepId) => isLocal(form.steps.find((step) => step.id === stepId))
  // What a Local only step never sends: its answers, reads and done marks. An "Ask about this" question always
  // goes to the speaker, Local only or not, so a queued one is kept and sent.
  const heldLocal = (body) => body.kind !== 'question' && localStep(body.stepId)
  for (const entry of store.localEntries()) if (localStep(entry.stepId)) entries = preworkMerge(entries, entry)
  for (const [, body] of store.outbox()) if (known(body.stepId) && !heldLocal(body)) entries = preworkMerge(entries, preworkEntryFromSubmission(body, now()))

  const phone = () => Boolean(options.isPhone && options.isPhone())
  const svg = (name) => '<svg class="lucide" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (icons[name] || '') + '</svg>'
  function el(tag, cls, text) {
    const node = document.createElement(tag)
    if (cls) node.className = cls
    if (text !== undefined && text !== null) node.textContent = String(text)
    return node
  }
  function icon(name) {
    const span = el('span', 'wp-ico')
    span.innerHTML = svg(name)
    return span
  }
  function button(cls, label, iconName, onClick) {
    const node = el('button', cls)
    node.type = 'button'
    if (iconName) node.appendChild(icon(iconName))
    if (label !== null && label !== undefined) node.appendChild(el('span', 'wp-btn-label', label))
    if (onClick) node.addEventListener('click', onClick)
    return node
  }
  const stepAt = (index) => form.steps[index]
  const stepIndex = (id) => form.steps.findIndex((step) => step.id === id)
  const isVideo = (step) => videos.has(step.id)
  const progress = () => preworkProgress(form, entries)
  const closesText = () => (status && status.closesAt ? preworkWhen(status.closesAt, zone) : '')
  const countLine = (p) => p.doneCount + ' of ' + p.total + ' done' + (closesText() ? ' \u00b7 ' + words.closesWord + ' ' + closesText() : '')

  // ── The device and saving (as the 0.37 form) ───────────────────────────────────────────────
  function participantId() {
    if (participant) return participant
    const key = 'tw-prework-device-' + config.preworkId
    let held = ''
    try { held = options.storage ? String(options.storage.get(key) || '') : '' } catch (_) { held = '' }
    if (!/^[A-Za-z0-9_-]{16,100}$/.test(held)) {
      held = preworkRandomId(options.random, 16)
      try { if (options.storage) options.storage.set(key, held) } catch (_) { /* this page only */ }
    }
    participant = held
    return participant
  }
  const submissionId = () => 's' + preworkRandomId(options.random, 8)
  // A step's status line. `extra.lead` is its bold start ("Sent to the speaker", "Not sent yet."); `extra.warn`
  // a box under it. Tones: ok (sent), info (typing, sending), wait (offline, kept on the phone), error, local.
  function setNote(stepId, tone, text, extra) {
    if (text) notes.set(stepId, { tone, text, lead: extra && extra.lead ? extra.lead : '', warn: extra && extra.warn ? extra.warn : '' }); else notes.delete(stepId)
    if (view.type === 'step' && stepAt(view.index).id === stepId) paintNote(stepId)
  }
  const NOTE_ICONS = { ok: 'check', info: 'clock', wait: 'wifi-off', error: 'clock', local: 'lock' }
  // A Local only step that holds something says, unasked, where it is kept.
  function localNote(stepId) {
    const step = form.steps.find((candidate) => candidate.id === stepId)
    if (!isLocal(step)) return null
    const state = preworkStepState(step, entries)
    return state.done || state.answer ? { tone: 'local', text: 'Clearing this browser\u2019s data would erase it.', lead: '', warn: '' } : null
  }
  function paintNote(stepId) {
    if (!els.note) return
    const note = notes.get(stepId) || localNote(stepId)
    els.note.hidden = !note
    els.note.dataset.tone = note ? note.tone : ''
    els.note.textContent = ''
    if (els.noteWarn) { els.noteWarn.hidden = !(note && note.warn); els.noteWarn.textContent = '' }
    if (note) {
      els.note.appendChild(icon(NOTE_ICONS[note.tone] || 'check'))
      const line = el('span', 'wp-note-text')
      if (note.lead) { line.appendChild(el('b', '', note.lead)); line.appendChild(document.createTextNode(' ')) }
      line.appendChild(document.createTextNode(note.text))
      els.note.appendChild(line)
      if (note.warn && els.noteWarn) { els.noteWarn.appendChild(icon('info')); els.noteWarn.appendChild(el('span', '', note.warn)) }
    }
  }
  const clock = (ms) => { const when = preworkWhen(ms, zone); return when ? when.slice(-5) : '' }
  const untilText = () => ' You can change it until ' + words.lower + ' closes' + (closesText() ? ' on ' + closesText().replace(/ (\d\d:\d\d)$/, ', $1') : '') + '.'
  // What a Sent step says once the Worker has its answer: who has it, when, and until when it can change.
  function sentNote(step, at) {
    const rest = step.kind === 'check' && !words.post ? ' You will see how everyone answered in the session.' : untilText()
    setNote(step.id, 'ok', 'at ' + clock(at) + '.' + rest, { lead: words.sentTitle })
  }
  // What a Sent step says when it did not get there: offline (kept in the outbox), closed, or refused.
  function unsentNote(step, refusal, result) {
    const http = result ? result.status : 0
    if (refusal.closed && result && (result.code === 'prework_closed' || http === 410)) {
      const at = status && status.closesAt ? clock(status.closesAt) : ''
      setNote(step.id, 'error', words.name + ' closed' + (at ? ' at ' + at : '') + ', so the speaker is no longer taking answers. Yours is still saved on this phone.', { lead: 'Could not send.' })
    } else if (refusal.retry && (http === 0 || http >= 500)) {
      setNote(step.id, 'wait', 'It is saved on this phone and will go when you are back online.', {
        lead: 'Not sent yet.', warn: 'Keep this page\u2019s browser as it is until it says Sent. Clearing the browser\u2019s data before then loses the answer.',
      })
    } else setNote(step.id, 'error', refusal.text)
  }
  // Every Sent submission is kept in the browser's outbox until the Worker has it (or refuses it for good),
  // so one typed offline, or in a tab that closed, is sent on the next chance with the same submission id.
  function push(key, body, hooks) {
    latest.set(key, body)
    store.putOutbox(key, body)
    return client.submit(key, body).then((result) => {
      if (result.ok) store.dropOutbox(key, body)
      if (latest.get(key) !== body) return result
      if (result.ok) {
        const at = result.data && result.data.entry && Number.isFinite(result.data.entry.at) ? result.data.entry.at : now()
        entries = preworkMerge(entries, preworkEntryFromSubmission(body, at))
        if (hooks && hooks.saved) hooks.saved()
        paintChrome()
        return result
      }
      const refusal = preworkRefusal(result.status, result.code, result.retryAfterMs, config.phase)
      // Refused for good: nothing more to send. Closed: kept on the phone (a later closing time may take it).
      if (!refusal.retry && !refusal.closed) store.dropOutbox(key, body)
      if (hooks && hooks.failed) hooks.failed(refusal, result)
      if (refusal.closed) recheck()
      else if (refusal.retry) schedule(() => { if (latest.get(key) === body) push(key, body, hooks) }, refusal.waitMs || 8000)
      return result
    })
  }
  // A Local only step's state: kept in the browser, never sent.
  function keepLocal(step, kind, extra) {
    const entry = preworkEntryFromSubmission(preworkSubmission('', 'local', step.id, kind, extra), now())
    store.putLocal(entry)
    entries = preworkMerge(entries, entry)
    return entry
  }
  function markRead(step) {
    if (!step || (step.kind !== 'slide' && step.kind !== 'task')) return
    if (preworkStepState(step, entries).read) return
    if (isLocal(step)) { keepLocal(step, 'read'); return }
    const body = preworkSubmission(participantId(), submissionId(), step.id, 'read')
    entries = preworkMerge(entries, preworkEntryFromSubmission(body, now()))
    push('read:' + step.id, body, null)
  }
  // What the page says while a Sent answer travels, and once it has arrived or not.
  function answerHooks(step) {
    return {
      saved: () => { const held = preworkStepState(step, entries).answer; sentNote(step, held ? held.at : now()) },
      failed: (refusal, result) => unsentNote(step, refusal, result),
    }
  }
  function saveAnswer(step) {
    const ready = preworkAnswerReady(step.poll, drafts.get(step.id))
    if (!ready) { setNote(step.id, 'info', ''); return }
    if (isLocal(step)) {
      keepLocal(step, 'answer', ready)
      setNote(step.id, 'local', 'Saved on this phone. The speaker does not see it.')
      paintChrome()
      return
    }
    const body = preworkSubmission(participantId(), submissionId(), step.id, 'answer', ready)
    setNote(step.id, 'info', 'Sending\u2026')
    push('answer:' + step.id, body, answerHooks(step))
  }
  // The outbox, sent again: on the next visit and when the phone is back online.
  function sendOutbox() {
    for (const [key, body] of store.outbox()) {
      const step = form.steps.find((candidate) => candidate.id === body.stepId)
      if (!step || (isLocal(step) && body.kind !== 'question')) { store.dropOutbox(key, body); continue }
      if (latest.get(key) && latest.get(key) !== body) continue
      push(key, body, body.kind === 'answer' ? answerHooks(step) : { failed: (refusal, result) => unsentNote(step, refusal, result) })
    }
  }
  function flush() {
    if (!saveTimer) return
    cancelSchedule(saveTimer.handle)
    const held = saveTimer
    saveTimer = null
    const step = stepAt(stepIndex(held.stepId))
    if (step) saveAnswer(step)
  }
  // Marks a step done (or not) and saves it: the one path the step's own button and the end page's list both use.
  function setDone(step, done, focus) {
    const scroller = mount.querySelector('.wp-body, .wp-cardbox')
    const scrolled = scroller ? scroller.scrollTop : 0
    const repaint = () => {
      render(focus || '[data-wp-done]')
      const again = mount.querySelector('.wp-body, .wp-cardbox')
      if (again && view.type === 'overview') again.scrollTop = scrolled
    }
    if (isLocal(step)) {
      // Local only: the tick stays on the phone. Nothing is sent, not even as a count.
      keepLocal(step, 'done', { done })
      notes.delete(step.id)
      repaint()
      return
    }
    const body = preworkSubmission(participantId(), submissionId(), step.id, 'done', { done })
    const before = entries.find((entry) => entry.ref === 'done:' + step.id) || null
    entries = preworkMerge(entries, preworkEntryFromSubmission(body, now()))
    repaint()
    push('done:' + step.id, body, {
      failed: (refusal, result) => {
        unsentNote(step, refusal, result)
        if (!refusal.retry && !refusal.closed) {
          entries = before ? preworkMerge(entries, before) : entries.filter((entry) => entry.ref !== 'done:' + step.id)
          repaint()
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
    if (els.askStatus) { els.askStatus.hidden = false; els.askStatus.textContent = 'Sending\u2026' }
  }
  function load() {
    loaded = false
    loadFailed = false
    render()
    return client.load(participantId()).then((result) => {
      loaded = true
      loadFailed = !result.ok
      if (result.ok) {
        let merged = result.entries
        for (const entry of entries) merged = preworkMerge(merged, entry)
        entries = merged
      }
      render()
      sendOutbox()
    })
  }

  // ── Pieces ─────────────────────────────────────────────────────────────────────────────────
  function bar(fraction, cls) {
    const track = el('div', 'wp-track' + (cls ? ' ' + cls : ''))
    track.setAttribute('role', 'progressbar')
    track.setAttribute('aria-valuemin', '0')
    track.setAttribute('aria-valuemax', '100')
    track.setAttribute('aria-valuenow', String(Math.round(fraction * 100)))
    const fill = el('i', 'wp-fill')
    fill.style.width = Math.round(fraction * 100) + '%'
    track.appendChild(fill)
    return track
  }
  function kindLine(step, short) {
    const kind = workPageKind(step, isVideo(step), short)
    const line = el('span', 'wp-kind')
    line.appendChild(icon(kind.icon))
    line.appendChild(el('span', '', kind.label))
    return line
  }
  function stateBadge(row) {
    const badge = el('span', 'wp-state is-' + row.tone)
    badge.appendChild(icon(row.tone === 'done' ? 'circle-check' : row.tone === 'started' ? 'circle-dashed' : 'circle'))
    badge.appendChild(el('span', '', row.tone === 'done' ? 'Done' : row.tone === 'started' ? 'Started' : 'To do'))
    return badge
  }
  function stepRow(row, index, current) {
    const node = el('button', 'wp-row' + (current ? ' is-current' : ''))
    node.type = 'button'
    node.dataset.step = String(index + 1)
    if (current) node.setAttribute('aria-current', 'step')
    node.appendChild(el('span', 'wp-n', index + 1))
    const body = el('span', 'wp-row-body')
    // The Sent / On this phone badge rides the small type line, so the title keeps the row's full width.
    const kind = kindLine(row.step, true)
    const lab = routeLabel(row.step)
    if (lab) kind.appendChild(lab)
    body.appendChild(kind)
    body.appendChild(el('span', 'wp-row-title', row.step.title))
    if (row.questions.length) body.appendChild(el('span', 'wp-row-q', row.questions.length === 1 ? 'Your question is with the speaker' : 'Your ' + row.questions.length + ' questions are with the speaker'))
    node.appendChild(body)
    node.appendChild(stateBadge(row))
    node.addEventListener('click', () => go(index))
    return node
  }
  // "Sent" or "On this phone" on a step that has an answer or a tick (a slide or video has neither).
  function routeLabel(step) {
    if (step.kind === 'slide') return null
    const local = isLocal(step)
    const lab = el('span', 'wp-lab ' + (local ? 'is-local' : 'is-sent'))
    lab.dataset.wpRoute = local ? 'local' : 'sent'
    lab.appendChild(icon(local ? 'lock' : 'send'))
    lab.appendChild(el('span', '', local ? 'On this phone' : 'Sent'))
    return lab
  }
  // The panel under a step's title: who sees what the person gives here.
  function routePanel(step) {
    if (step.kind === 'slide') return null
    const local = isLocal(step)
    // A Sent task's tick is a count, not an answer: the panel is for answers and for anything kept on the phone.
    if (!local && step.kind === 'task') return null
    const panel = el('div', 'wp-route ' + (local ? 'is-local' : 'is-sent'))
    panel.dataset.wpRoutePanel = local ? 'local' : 'sent'
    panel.appendChild(icon(local ? 'lock' : 'send'))
    const text = el('div', 'wp-route-text')
    text.appendChild(el('b', '', local ? words.localTitle : words.sentTitle))
    text.appendChild(el('span', '', local ? words.localBody : words.sentBody))
    panel.appendChild(text)
    return panel
  }
  function stepList(currentIndex) {
    const list = el('div', 'wp-steps')
    progress().steps.forEach((row, index) => list.appendChild(stepRow(row, index, currentIndex === index)))
    return list
  }
  function handoutLink(compact) {
    if (!handoutHref) return null
    const link = el('a', compact ? 'wp-ctx-link' : 'wp-handout')
    link.href = handoutHref
    link.dataset.wpHandout = '1'
    link.appendChild(icon('file-text'))
    if (compact) link.appendChild(el('span', '', 'Handout'))
    else {
      const text = el('span', 'wp-handout-text')
      text.appendChild(el('b', '', 'Session handout'))
      text.appendChild(el('small', '', workPageShownAddress(handoutHref)))
      link.appendChild(text)
      link.appendChild(icon('arrow-up-right'))
    }
    return link
  }
  function rail(currentIndex) {
    const p = progress()
    const nav = el('nav', 'wp-rail')
    nav.setAttribute('aria-label', 'Steps')
    if (words.eyebrow) nav.appendChild(el('p', 'wp-eyebrow', words.eyebrow))
    nav.appendChild(el('p', 'wp-talk-title', config.talkTitle || form.title))
    if (config.runLine) nav.appendChild(el('p', 'wp-runline', config.runLine))
    if (outcome === 'open') {
      els.railCount = el('p', 'wp-railcount', countLine(p))
      nav.appendChild(els.railCount)
      els.railBar = bar(p.total ? p.doneCount / p.total : 0)
      nav.appendChild(els.railBar)
      els.railList = stepList(currentIndex)
      nav.appendChild(els.railList)
    }
    const link = handoutLink(false)
    if (link) nav.appendChild(link)
    return nav
  }
  function phoneTop(center, back) {
    const top = el('div', 'wp-top')
    if (back) top.appendChild(button('wp-tb wp-back', 'Steps', 'chevron-left', () => go(null)))
    else top.appendChild(el('span', 'wp-tb'))
    top.appendChild(el('span', 'wp-stepno', center))
    top.appendChild(el('span', 'wp-tb is-end'))
    return top
  }
  function phoneContext() {
    const ctx = el('div', 'wp-ctx')
    const line = el('span', 'wp-ctx-text')
    if (words.eyebrow) { line.appendChild(el('b', 'wp-ctx-eyebrow', words.eyebrow)); line.appendChild(document.createTextNode(' \u00b7 ' + (config.talkTitle || form.title))) }
    else line.textContent = (config.talkTitle || form.title) + (config.runLine ? ' \u00b7 ' + String(config.runLine).split(' \u00b7 ')[0] : '')
    ctx.appendChild(line)
    const link = handoutLink(true)
    if (link) ctx.appendChild(link)
    return ctx
  }

  // The end page's list: every step not yet done, and for a step that needs "mark as done" the button itself,
  // so a person who forgot can mark it here. Shown once they have started or have pressed Finish.
  function stillToDo(p) {
    if (!(finished || p.started) || p.allDone) return null
    const open = p.steps.map((row, index) => ({ row, index })).filter((item) => item.row.state !== 'done')
    if (!open.length) return null
    const box = el('section', 'wp-todo')
    box.dataset.wpTodo = String(open.length)
    box.appendChild(el('h2', 'wp-todo-title', 'Still to do'))
    box.appendChild(el('p', 'wp-small', open.length === 1 ? '1 step is not finished yet.' : open.length + ' steps are not finished yet.'))
    for (const { row, index } of open) {
      const line = el('div', 'wp-todo-row')
      line.dataset.wpTodoStep = row.step.id
      line.appendChild(el('span', 'wp-n', index + 1))
      const text = el('span', 'wp-row-body')
      text.appendChild(kindLine(row.step, true))
      text.appendChild(el('span', 'wp-row-title', row.step.title))
      text.appendChild(el('span', 'wp-small', row.step.kind === 'task' && row.step.done ? 'Mark it done when you have done it.' : row.label))
      line.appendChild(text)
      if (row.step.kind === 'task' && row.step.done) {
        const mark = button('wp-btn is-primary wp-todo-mark', 'Mark as done', 'square-check', () => setDone(row.step, true, '[data-wp-todo-mark]'))
        mark.dataset.wpTodoMark = row.step.id
        mark.appendChild(mark.firstChild)
        line.appendChild(mark)
      } else {
        line.appendChild(button('wp-link', 'Go to step', null, () => go(index)))
      }
      box.appendChild(line)
    }
    return box
  }

  // What happened to the person's answers, true for this form: what was sent went without a name; what is
  // on this phone stayed there.
  function welcomeRoutes() {
    const answering = form.steps.filter((step) => step.kind !== 'slide')
    const local = answering.filter(isLocal).length
    const place = phone() ? 'this phone' : 'this browser'
    if (!answering.length) return ''
    if (!local) return 'Your answers have gone to the speaker without your name.'
    if (local === answering.length) return 'Your answers stay on ' + place + '; the speaker does not see them.'
    return 'Steps marked Sent have gone to the speaker without your name. Steps marked On this phone stay here.'
  }

  // ── The overview: what the work is, "Start" or "Carry on", the steps ─────────────────────────
  function overviewCard() {
    const p = progress()
    const box = el('div', 'wp-overview')
    if (loadFailed) {
      const warn = el('div', 'wp-banner is-warn')
      warn.setAttribute('role', 'status')
      warn.appendChild(icon('clock'))
      warn.appendChild(el('span', '', 'Could not check your earlier answers.'))
      warn.appendChild(button('wp-link', 'Try again', null, () => load()))
      box.appendChild(warn)
    } else if (p.started && !p.allDone) {
      const back = el('div', 'wp-banner is-info')
      back.setAttribute('role', 'status')
      back.appendChild(icon('history'))
      back.appendChild(el('span', 'wp-welcome', 'Welcome back: ' + p.doneCount + ' of ' + p.total + ' done. ' + welcomeRoutes()))
      box.appendChild(back)
    }
    if (p.allDone) {
      const thanks = el('section', 'wp-thanks')
      thanks.setAttribute('role', 'status')
      const title = el('h2', 'wp-thanks-title')
      title.appendChild(icon('circle-check'))
      title.appendChild(el('span', '', 'All done. Thank you.'))
      thanks.appendChild(title)
      thanks.appendChild(el('p', '', words.thanks + ' You can change an answer until ' + (closesText() ? closesText().replace(/ (\d\d:\d\d)$/, ' at $1') : words.lower + ' closes') + '.'))
      box.appendChild(thanks)
    }
    if (words.eyebrow && phone()) box.appendChild(el('p', 'wp-eyebrow', words.eyebrow))
    box.appendChild(el('h1', 'wp-title', form.title || words.heading))
    const intro = config.introText !== undefined ? config.introText : form.intro
    if (intro) box.appendChild(el('p', 'wp-intro', intro))
    const chips = el('div', 'wp-chips')
    const minutes = preworkMinutesText(form)
    if (minutes) { const chip = el('span', 'wp-chip'); chip.appendChild(icon('clock')); chip.appendChild(el('span', '', minutes)); chips.appendChild(chip) }
    const anon = el('span', 'wp-chip'); anon.appendChild(icon('eye-off')); anon.appendChild(el('span', '', 'No name, no account')); chips.appendChild(anon)
    if (closesText()) { const open = el('span', 'wp-chip'); open.appendChild(icon('clock')); open.appendChild(el('span', '', 'Open until ' + closesText().replace(/ (\d\d:\d\d)$/, ' at $1'))); chips.appendChild(open) }
    box.appendChild(chips)
    const todo = stillToDo(p)
    if (todo) box.appendChild(todo)
    if (!p.allDone) {
      const cta = button('wp-btn is-primary wp-cta', p.started ? 'Carry on: step ' + (p.next === null ? p.total : p.next + 1) : 'Start with step 1', 'arrow-right', () => go(p.next === null ? 0 : p.next))
      cta.dataset.wpCta = '1'
      cta.appendChild(cta.firstChild)
      box.appendChild(cta)
    }
    if (phone()) {
      box.appendChild(el('p', 'wp-count', countLine(p)))
      box.appendChild(stepList(-1))
    }
    return box
  }

  // ── A step ───────────────────────────────────────────────────────────────────────────────────
  function stepMedia(node) {
    const out = []
    if (!node) return out
    for (const media of Array.from(node.querySelectorAll('figure, video'))) {
      if (media.closest('.notes')) continue
      if (media.parentElement && media.parentElement.closest('figure')) continue
      if (media.tagName === 'VIDEO' && media.closest('figure')) continue
      out.push(media)
    }
    return out
  }
  function slideLines(node, cls) {
    const lines = workPageSlideLines(node)
    if (!lines.length) return null
    const box = el('div', cls)
    let list = null
    for (const line of lines) {
      if (!line.item) { list = null; box.appendChild(el('p', 'wp-line', line.text)); continue }
      const tag = line.ordered ? 'OL' : 'UL'
      if (!list || list.tagName !== tag) { list = el(tag.toLowerCase(), 'wp-lines'); box.appendChild(list) }
      list.appendChild(el('li', '', line.text))
    }
    return box
  }
  function activate(node) {
    workPageActivateMedia(node)
    workPageRenderMermaid(node, options.mermaid || null, document)
  }
  function slideCanvas(step) {
    const node = options.stepNode ? options.stepNode(step.id) : null
    if (!node) return null
    const canvas = el('div', 'wp-canvas')
    const inner = el('div', 'wp-canvas-inner')
    const slide = node.querySelector('.slide') || node
    if (slide.classList) slide.classList.add('active')
    for (const notes of Array.from(node.querySelectorAll('.notes'))) notes.remove()
    inner.appendChild(node)
    canvas.appendChild(inner)
    els.canvases.push(canvas)
    els.activate.push(node)
    return canvas
  }
  function answerControls(step) {
    const saved = preworkDraftFromEntry(preworkStepState(step, entries).answer)
    if (!drafts.has(step.id) && saved !== null) drafts.set(step.id, saved)
    const controls = createPreworkAnswerControls({
      document, step, schedule, cancelSchedule,
      draft: () => drafts.get(step.id),
      set: (value) => drafts.set(step.id, value),
      commit: () => saveAnswer(step),
      typing: (text) => {
        if (saveTimer) cancelSchedule(saveTimer.handle)
        setNote(step.id, 'info', text.trim() ? (isLocal(step) ? 'Saving on this phone when you stop typing\u2026' : 'Sending when you stop typing\u2026') : '')
        saveTimer = { stepId: step.id, handle: schedule(() => { saveTimer = null; saveAnswer(step) }, 700) }
      },
      blur: () => flush(),
      clear: () => setNote(step.id, 'info', ''),
    })
    // A rating with one row is a scale (mockup 13 post-work): the row's own label is the step's question,
    // and "1 · not useful" labels show their number in the box and their words at the ends.
    const rows = controls.querySelectorAll('.pw-rate')
    if (step.poll && step.poll.type === 'rating' && rows.length === 1) {
      controls.classList.add('is-scale')
      const ends = []
      for (const label of Array.from(rows[0].querySelectorAll('.pw-opt-label'))) {
        const text = String(label.textContent)
        const at = text.indexOf(' \u00b7 ')
        if (at > 0) { ends.push(text); label.textContent = text.slice(0, at) }
      }
      if (ends.length) {
        const line = el('div', 'wp-scale-ends')
        line.appendChild(el('span', '', ends[0]))
        line.appendChild(el('span', '', ends.length > 1 ? ends[ends.length - 1] : ''))
        controls.appendChild(line)
      }
    }
    return controls
  }
  function pollHint(step) {
    const poll = step.poll || {}
    if (poll.type === 'rating' && Array.isArray(poll.options) && poll.options.length === 1) {
      const numbers = (poll.labels || []).every((label) => /^\d+(?: \u00b7 |$)/.test(String(label.label)))
      return (numbers ? 'Pick one number.' : 'Pick one.') + (closesText() && phone() ? ' Open until ' + closesText() + '.' : '')
    }
    return preworkPollHint(step)
  }
  function noteLine() {
    const box = el('div', 'wp-notebox')
    const note = el('p', 'wp-note')
    note.setAttribute('role', 'status')
    note.hidden = true
    els.note = note
    const warn = el('div', 'wp-warn')
    warn.hidden = true
    els.noteWarn = warn
    box.appendChild(note)
    box.appendChild(warn)
    return box
  }
  function stepContent(step, wide) {
    const box = el('div', 'wp-content')
    if (!wide) box.appendChild(kindLine(step, false))
    if (step.kind === 'check' || step.kind === 'question') {
      box.appendChild(el('h2', 'wp-step-title', step.title))
      const panel = routePanel(step)
      if (panel) box.appendChild(panel)
      box.appendChild(el('p', 'wp-hint', pollHint(step)))
      const question = el('div', 'wp-q')
      if (step.poll && step.poll.question && step.poll.question !== step.title) question.appendChild(el('p', 'wp-prompt', step.poll.question))
      question.appendChild(answerControls(step))
      question.appendChild(noteLine())
      box.appendChild(question)
      return box
    }
    if (wide && !isVideo(step)) {
      const canvas = slideCanvas(step)
      if (canvas) box.appendChild(canvas)
      else box.appendChild(el('h2', 'wp-step-title', step.title))
      const panel = routePanel(step)
      if (panel) box.appendChild(panel)
    } else {
      // A video on a laptop, and every slide on a phone: the step stacks (title, picture or player, text).
      const node = options.stepNode ? options.stepNode(step.id) : null
      const media = stepMedia(node)
      if (!wide) box.appendChild(el('h2', 'wp-step-title', step.title))
      const panel = !wide ? routePanel(step) : null
      if (panel) box.appendChild(panel)
      const holder = el('div', 'wp-media' + (isVideo(step) ? ' is-video' : ''))
      for (const item of media) holder.appendChild(item)
      if (media.length) { box.appendChild(holder); els.activate.push(holder) }
      if (wide) box.appendChild(el('h2', 'wp-step-title', step.title))
      const widePanel = wide ? routePanel(step) : null
      if (widePanel) box.appendChild(widePanel)
      const lines = slideLines(node, wide ? 'wp-hint wp-slide-text' : 'wp-slide-text')
      if (lines) box.appendChild(lines)
    }
    if (wide && step.kind === 'task' && step.done && !isLocal(step)) box.appendChild(el('p', 'wp-hint', step.questions ? words.taskHint : 'When you have done it, mark it done.'))
    box.appendChild(noteLine())
    return box
  }
  function doneControl(step, row, wide) {
    if (step.kind !== 'task' || !step.done) return null
    const node = el('button', 'wp-btn wp-done' + (row.done ? ' is-done' : ' is-todo'))
    node.type = 'button'
    node.dataset.wpDone = row.done ? 'done' : 'todo'
    node.setAttribute('aria-pressed', row.done ? 'true' : 'false')
    node.appendChild(icon(row.done ? 'circle-check' : 'square-check'))
    if (isLocal(step)) {
      // Local only (mockup 03): the tick is the person's own and stays on the phone.
      node.dataset.wpLocal = '1'
      const text = el('span', 'wp-done-text')
      text.appendChild(el('span', '', row.done ? 'Marked done' : 'Mark as done'))
      text.appendChild(el('small', 'wp-done-hint', row.done ? 'Saved on this phone. The speaker does not see it.' : 'Only you see this tick.'))
      node.appendChild(text)
    } else {
      node.appendChild(el('span', '', row.done ? 'Done' : 'Mark as done'))
      if (row.done) node.appendChild(el('span', 'wp-done-hint', wide ? 'Click to untick' : 'Tap to untick'))
    }
    node.addEventListener('click', () => setDone(step, !row.done))
    return node
  }
  const ask = createWorkPageAsk({
    document, el, icon, button, words, asks, zone, now,
    entries: () => entries, els: () => els, sheet: () => sheet, setSheet: (value) => { sheet = value },
    closeSheet: () => closeSheet(), render: (focus) => render(focus), sendQuestion, stepIndex,
  })
  const { questionCards, doneNote, askColumn, sheetView } = ask
  function closeSheet() { sheet = null; render() }

  function stepScreen(root) {
    const index = view.index
    const step = stepAt(index)
    const p = progress()
    const row = p.steps[index]
    const wide = !phone()
    const last = index === form.steps.length - 1
    const prev = button('wp-btn wp-prev', wide ? 'Previous' : null, 'chevron-left', () => go(index - 1))
    prev.setAttribute('aria-label', 'Previous step')
    prev.disabled = index === 0
    const next = last ? button('wp-btn is-primary wp-next', 'Finish', 'check', () => finish()) : button('wp-btn is-primary wp-next', wide ? 'Next step' : 'Next', 'chevron-right', () => go(index + 1))
    next.appendChild(next.firstChild)
    const done = doneControl(step, row, wide)
    if (!wide) {
      root.appendChild(phoneTop('Step ' + (index + 1) + ' of ' + form.steps.length, true))
      els.railBar = bar(p.total ? p.doneCount / p.total : 0, 'is-thin')
      root.appendChild(els.railBar)
      root.appendChild(phoneContext())
      if (done) { const holder = el('div', 'wp-donetop'); done.classList.add('is-wide'); holder.appendChild(done); root.appendChild(holder) }
      const body = el('div', 'wp-body')
      body.appendChild(stepContent(step, false))
      const doneBox = doneNote(row)
      if (doneBox) body.appendChild(doneBox)
      for (const card of questionCards(row)) body.appendChild(card)
      root.appendChild(body)
      const nav = el('div', 'wp-nav')
      nav.appendChild(prev)
      if (step.questions) nav.appendChild(button('wp-btn wp-ask', 'Ask about this', 'message-circle-question-mark', () => { sheet = { stepId: step.id, phase: 'compose' }; render('.wp-sheet textarea') }))
      else nav.appendChild(el('span', 'wp-spacer'))
      nav.appendChild(next)
      root.appendChild(nav)
      if (sheet && sheet.stepId === step.id) root.appendChild(sheetView(step))
      return
    }
    root.appendChild(rail(index))
    const center = el('section', 'wp-center')
    const head = el('div', 'wp-centerhead')
    head.appendChild(el('span', 'wp-stepno', 'Step ' + (index + 1) + ' of ' + form.steps.length))
    head.appendChild(kindLine(step, false))
    const keys = el('span', 'wp-keys')
    keys.appendChild(icon('keyboard'))
    keys.appendChild(el('span', '', '\u2190 \u2192 to move between steps'))
    head.appendChild(keys)
    center.appendChild(head)
    if (done) { const holder = el('div', 'wp-donetop'); holder.appendChild(done); center.appendChild(holder) }
    const card = el('div', 'wp-cardbox')
    card.appendChild(stepContent(step, true))
    center.appendChild(card)
    const actions = el('div', 'wp-actions')
    actions.appendChild(el('span', 'wp-spacer'))
    actions.appendChild(prev)
    actions.appendChild(next)
    center.appendChild(actions)
    root.appendChild(center)
    root.appendChild(askColumn(step, row))
  }
  function messageCard(kind) {
    const box = el('div', 'wp-message')
    box.dataset.wpState = kind
    if (kind === 'closed') {
      const mount = el('div', 'wp-closed-host')
      showPreworkClosed(document, [mount], status, zone, { phase: config.phase, after: handoutHref ? 'The session handout is still open.' : '' })
      box.appendChild(mount)
    } else if (kind === 'unavailable') {
      box.appendChild(el('h1', 'wp-title', 'This page is not available'))
      box.appendChild(el('p', 'wp-intro', 'Ask the person who sent you the link.'))
    } else if (kind === 'not_yet') {
      box.appendChild(el('h1', 'wp-title', form.title || words.heading))
      box.appendChild(el('p', 'wp-intro', status && config.phase !== 'post' && status.opensAt ? 'Pre-work opens ' + preworkWhen(status.opensAt, zone) + '.' : words.notYet))
    } else if (kind === 'unreachable') {
      box.appendChild(el('h1', 'wp-title', form.title || words.heading))
      const warn = el('div', 'wp-banner is-warn')
      warn.setAttribute('role', 'status')
      warn.appendChild(icon('clock'))
      warn.appendChild(el('span', '', 'This page could not reach its service just now.'))
      warn.appendChild(button('wp-link', 'Try again', null, () => start()))
      box.appendChild(warn)
    } else {
      box.appendChild(el('p', 'wp-loading', 'Loading\u2026'))
    }
    if (handoutHref && phone()) { const link = handoutLink(true); box.appendChild(link) }
    return box
  }

  // ── Drawing and moving ───────────────────────────────────────────────────────────────────────
  // The slide is drawn on its 1280x720 stage and scaled to the frame by a transform; the app's own fit
  // pipeline (slide-fit.js, inlined ahead of this file) then runs on it as it does in the presenter, so the
  // list ladder and zoom keep the content inside the frame at any frame width.
  let slideFit = null
  function fitCanvases() {
    if (!slideFit && typeof createSlideFit === 'function') { try { slideFit = createSlideFit() } catch (_) { slideFit = false } }
    for (const canvas of els.canvases || []) {
      const inner = canvas.firstChild
      const width = canvas.clientWidth
      if (inner && width > 0) inner.style.transform = 'scale(' + (width / 1280) + ')'
      const content = slideFit && inner ? inner.querySelector('.slide > .slide-content') : null
      if (content) { try { slideFit.fitContent(content) } catch (_) {} }
    }
  }
  function render(focus) {
    mount.textContent = ''
    const wide = !phone()
    mount.dataset.mode = wide ? 'laptop' : 'phone'
    mount.dataset.phase = config.phase === 'post' ? 'post' : 'pre'
    els = { canvases: [], activate: [] }
    const root = el('div', 'wp' + (wide ? ' is-wide' : ' is-phone'))
    if (outcome !== 'open' || (!loaded && !loadFailed)) {
      const state = outcome === 'open' ? 'loading' : outcome
      if (wide) { root.appendChild(rail(-1)); const center = el('section', 'wp-center'); center.appendChild(messageCard(state)); root.appendChild(center) }
      else { root.appendChild(phoneTop(words.heading, false)); root.appendChild(phoneContext()); const body = el('div', 'wp-body'); body.appendChild(messageCard(state)); root.appendChild(body) }
    } else if (view.type === 'step') {
      stepScreen(root)
    } else if (wide) {
      root.appendChild(rail(-1))
      const center = el('section', 'wp-center')
      const card = el('div', 'wp-cardbox')
      card.appendChild(overviewCard())
      center.appendChild(card)
      root.appendChild(center)
    } else {
      root.appendChild(phoneTop(words.heading, false))
      root.appendChild(phoneContext())
      const body = el('div', 'wp-body')
      body.appendChild(overviewCard())
      root.appendChild(body)
    }
    mount.appendChild(root)
    for (const node of els.activate) activate(node)
    if (view.type === 'step') { paintNote(stepAt(view.index).id); frame(() => { fitCanvases(); frame(fitCanvases) }) }
    if (focus) { const target = mount.querySelector(focus); if (target && target.focus) target.focus() }
  }
  function paintChrome() {
    if (outcome !== 'open') return
    if (view.type === 'overview') { render(); return }
    const p = progress()
    if (els.railCount) els.railCount.textContent = countLine(p)
    if (els.railBar) { const fill = els.railBar.querySelector('.wp-fill'); if (fill) fill.style.width = Math.round((p.total ? p.doneCount / p.total : 0) * 100) + '%' }
    if (els.railList) { const fresh = stepList(view.index); els.railList.replaceWith(fresh); els.railList = fresh }
  }
  function leave() {
    flush()
    if (view.type === 'step') markRead(stepAt(view.index))
  }
  function go(index) {
    leave()
    sheet = null
    view = index === null || index < 0 || index >= form.steps.length ? { type: 'overview' } : { type: 'step', index }
    render(view.type === 'overview' ? '[data-wp-cta]' : null)
    const body = mount.querySelector('.wp-body, .wp-cardbox')
    if (body) body.scrollTop = 0
  }
  function finish() {
    leave()
    finished = true
    view = { type: 'overview' }
    render()
  }
  function recheck() {
    return options.fetchStatus().then((answer) => {
      const before = outcome
      if (answer.status) { status = answer.status; outcome = status.state === 'open' ? 'open' : status.state }
      else if (answer.unavailable) outcome = 'unavailable'
      else outcome = before === 'open' ? 'open' : 'unreachable'
      if (outcome !== before) { flush(); render() }
    })
  }
  function start() {
    outcome = 'loading'
    render()
    return options.fetchStatus().then((answer) => {
      if (answer.status) { status = answer.status; outcome = status.state === 'open' ? 'open' : status.state }
      else outcome = answer.unavailable ? 'unavailable' : 'unreachable'
      if (outcome === 'open') return load()
      render()
      return undefined
    })
  }
  function onKey(event) {
    if (event.key === 'Escape' && sheet) { closeSheet(); return }
    const target = event.target
    const typing = target && target.tagName && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)
    if (typing || event.metaKey || event.ctrlKey || event.altKey || view.type !== 'step' || sheet || outcome !== 'open') return
    if (event.key === 'ArrowRight' && view.index < form.steps.length - 1) { event.preventDefault(); go(view.index + 1) }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); go(view.index === 0 ? null : view.index - 1) }
  }
  const win = document.defaultView
  let wasPhone = phone()
  if (win) {
    win.addEventListener('keydown', onKey)
    win.addEventListener('resize', () => { if (phone() !== wasPhone) { wasPhone = phone(); flush(); render() } else fitCanvases() })
    // Back online: what waited in the outbox goes now (start() sends it after loading).
    win.addEventListener('online', () => { if (outcome === 'unreachable' || loadFailed) start(); else if (outcome === 'open') sendOutbox() })
    win.addEventListener('pagehide', () => leave())
  }
  return {
    start,
    /** A snapshot for tests: the screen, how far the person is, what the Worker said. */
    state() { const p = progress(); return { outcome, view, loaded, loadFailed, doneCount: p.doneCount, total: p.total, next: p.next, entries: entries.slice(), participant, outbox: store.outbox().map(([key]) => key) } },
  }
}

/**
 * Starts the page on load: the config and the step slides come from the page itself (the config line
 * and the inert `<template id="wpSteps">`), the Worker's routes through fetch.
 * @param {any} window @param {any} config
 */
export function startWorkPage(window, config) {
  const document = window.document
  const template = document.getElementById('wpSteps')
  const stepNode = (id) => {
    if (!template || !template.content) return null
    const found = Array.from(template.content.children).find((node) => node.getAttribute('data-wp-step') === id)
    return found ? document.importNode(found, true) : null
  }
  const mermaid = window.mermaid || null
  if (mermaid && typeof mermaid.initialize === 'function') {
    mermaid.initialize({ startOnLoad: false, theme: 'neutral', securityLevel: 'strict', suppressErrorRendering: true, htmlLabels: false, flowchart: { htmlLabels: false } })
  }
  const media = window.matchMedia ? window.matchMedia('(max-width: 760px)') : null
  const fetchImpl = window.fetch.bind(window)
  // A preview (opened on the author's computer, nothing published) never reaches the Worker: it shows
  // as open, keeps answers in the page only, and remembers nothing between visits.
  const preview = config.preview === true
  // The Run's own times when the page was given them; a week from now only when it was not.
  const ownWindow = config.previewWindow
  const previewStatus = ownWindow && Number.isSafeInteger(ownWindow.opensAt) && Number.isSafeInteger(ownWindow.closesAt)
    ? { state: 'open', phase: config.phase, opensAt: ownWindow.opensAt, closesAt: ownWindow.closesAt }
    : { state: 'open', phase: config.phase, opensAt: Date.now() - 60000, closesAt: Date.now() + 7 * 86400000 }
  const page = createWorkPage({
    document, config, stepNode, mermaid,
    mount: document.getElementById('workPage'),
    client: preview
      ? { load: () => Promise.resolve({ ok: true, entries: [] }), submit: () => Promise.resolve({ ok: true, status: 200, data: null }) }
      : createPreworkClient({ fetch: fetchImpl, workerBaseUrl: config.workerBaseUrl, preworkId: config.preworkId }),
    storage: preview ? null : { get: (key) => window.localStorage.getItem(key), set: (key, value) => window.localStorage.setItem(key, value) },
    random: (n) => window.crypto.getRandomValues(new Uint8Array(n)),
    isPhone: () => Boolean(media && media.matches),
    fetchStatus: preview ? () => Promise.resolve({ status: previewStatus }) : () => workPageFetchStatus(fetchImpl, config),
  })
  window.__workPage = page
  void page.start()
  return page
}

export function workPageRuntimeSource() {
  return [preworkFormModelSource(), preworkFormClientSource(), preworkAnswerControlsSource(), preworkClosedBannerSource(), workPagePartsSource(), workPageAskSource(), workPageStoreSource(),
    workPageKind.toString(), createWorkPage.toString(), startWorkPage.toString()].join('\n')
}
