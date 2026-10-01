// My Notes on the published audience page (ADR-0033; ticket "My Notes lists everything a person did,
// by slide, with chips, and lets them remove a mark"). Everything here is read from this device:
// highlights and notes (the page's notes key), the reaction marks and bookmarks (the reactions key,
// kept per live run), the questions this device sent (a small record Ask writes when the worker
// confirms one) and the poll answers given (a small record the poll runtime writes when a vote is
// confirmed). Nothing is requested from anywhere and nothing is sent.
//
// Every function is embedded in the page by `.toString()` (see audienceMyNotesRuntimeSource), so each
// is self-contained: no module-level constants. Seams, small to large:
//
//  - gatherMyNotes(options)         read model: one pass over storage → slides in slide order, each with
//                                   its items (marks, poll answer, notes, questions), a slide with nothing absent
//  - viewMyNotes(model, chip)       what one chip shows: the groups holding that kind, and the "Also here" line
//  - removeMyNotesMark(options, ..) clears a bookmark or reaction from every run on this device
//  - noteQuestionText(quote, words) the text a highlight's note sends as a question
//  - createQuestionLog(options)     the record of questions this device sent
//  - pollAnswerRecord / myNotesPollAnswerKey   the record of poll answers, written by the poll runtime
//  - myNotesSlideMarks(model)       the kinds each slide holds (the marks in the slide list)
//  - createSlideMarks(options)      the marks and the legend as DOM, icons only
//  - myNotesMarkdown(model, ..)     the notes as Markdown, every kind, slide order
//  - myNotesPrintHtml(model, ..)    the printable notes page: notes with slide titles, never the slides
//  - createMyNotesDrawer(options)   the drawer: chips, groups, cards, Remove, the empty state. Text only:
//                                   every user, audience and note string goes in with textContent.
import { createReactionMarks } from './audience-reactions.js'

/** The chips, in order: [id, label]. One chip per kind; a note is a Note, a question a Question. */
export function myNotesChips() {
  return [['all', 'All'], ['note', 'Notes'], ['bookmark', 'Bookmarks'], ['puzzled', 'Puzzled'], ['helped', 'Helped'], ['question', 'Questions'], ['poll', 'Poll answers']]
}

/** The lucide bodies the drawer draws, checked against compiler/assets/icons/lucide.json by the unit test. */
export function myNotesIcons() {
  return {
    'pen-line': '<path d="M13 21h8"/><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/>',
    'chart-no-axes-column': '<path d="M5 21v-6"/><path d="M12 21V3"/><path d="M19 21V9"/>',
    send: '<path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/>',
    'arrow-right': '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
    'refresh-cw': '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
    'loader-circle': '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>',
    'circle-x': '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
    'arrow-up-right': '<path d="M7 7h10v10"/><path d="M7 17 17 7"/>',
    'trash-2': '<path d="M10 11v6"/><path d="M14 11v6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    printer: '<path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6"/><rect x="6" y="14" width="12" height="8" rx="1"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    'bookmark-check': '<path d="M17 3a2 2 0 0 1 2 2v15a1 1 0 0 1-1.496.868l-4.512-2.578a2 2 0 0 0-1.984 0l-4.512 2.578A1 1 0 0 1 5 20V5a2 2 0 0 1 2-2z"/><path d="m9 10 2 2 4-4"/>',
    frown: '<circle cx="12" cy="12" r="10"/><path d="M16 16s-1.5-2-4-2-4 2-4 2"/><line x1="9" x2="9.01" y1="9" y2="9"/><line x1="15" x2="15.01" y1="9" y2="9"/>',
    lightbulb: '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>',
    'message-circle-question-mark': '<path d="M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  }
}

/** The key one poll answer is kept under on this device (the poll runtime writes it, gatherMyNotes reads it). */
export function myNotesPollAnswerKey(sessionId, pollId) {
  return 'talkweaver:poll-answer:' + sessionId + ':' + pollId
}

/**
 * What to keep of a poll answer so My Notes can show it a week later with no live talk: the slide, the
 * question and the answer as words. Null when the poll is not tied to a slide (it cannot be listed by slide).
 * @param {any} poll the poll state the page holds { slideId, question, options, labels? }
 * @param {any} choice the stored choice: an option id, a list of ids (multiple, ranking), a map (rating,
 *   categorisation) or the text of an open answer
 * @param {number} at epoch milliseconds
 */
export function pollAnswerRecord(poll, choice, at) {
  if (!poll || typeof poll.slideId !== 'string' || !poll.slideId || choice === null || choice === undefined) return null
  const options = Array.isArray(poll.options) ? poll.options : []
  const labels = Array.isArray(poll.labels) ? poll.labels : []
  const optionLabel = (id) => { const found = options.find((option) => option && option.optionId === id); return found && typeof found.label === 'string' ? found.label : String(id) }
  const scaleLabel = (id) => { const found = labels.find((label) => label && label.optionId === id); return found && typeof found.label === 'string' ? found.label : String(id) }
  let answer = ''
  if (typeof choice === 'string') answer = poll.pollType === 'open' ? choice : optionLabel(choice)
  else if (Array.isArray(choice)) answer = choice.map(optionLabel).join(poll.pollType === 'ranking' ? ' > ' : ', ')
  else if (typeof choice === 'object') {
    answer = Object.entries(choice).map(([id, value]) => optionLabel(id) + ': ' + (typeof value === 'string' ? scaleLabel(value) : String(value))).join(', ')
  }
  answer = answer.trim()
  if (!answer) return null
  return { slideId: poll.slideId, question: typeof poll.question === 'string' ? poll.question : '', answer, at: new Date(at).toISOString() }
}

/**
 * The text of the question a highlight's note sends to the speaker. The worker's question carries text, name,
 * slide and time and nothing else, so the quote goes in front of the words: “quote”, a blank line, the words.
 * The quote is cut to 140 characters and the whole stays within the 500 a question may have.
 * @param {string} quote @param {string} words @returns {string}
 */
export function noteQuestionText(quote, words) {
  const flat = String(quote || '').replace(/\s+/g, ' ').trim()
  const body = String(words || '').trim()
  const room = Math.max(20, Math.min(140, 500 - body.length - 4))
  const cut = flat.length > room ? flat.slice(0, room - 1).trimEnd() + '\u2026' : flat
  return (cut ? '\u201c' + cut + '\u201d' + '\n\n' : '') + body
}

/**
 * The record of questions this device sent, beside the notes key. Written by Ask when the worker
 * confirms a question: `{ submissionId, slideId, text, name, at }`. Every read goes to storage afresh, so
 * two tabs never overwrite each other; a confirmation seen twice is kept once (by submission id).
 * Storage that is blocked keeps the record for this page only.
 * @param {{ storage?: any, key: string }} options
 */
export function createQuestionLog(options) {
  const storage = options.storage || null
  let memo = []
  function read() {
    try {
      const saved = storage ? JSON.parse(storage.getItem(options.key) || 'null') : null
      if (saved && saved.v === 1 && Array.isArray(saved.items)) memo = saved.items.filter((item) => item && typeof item.slideId === 'string' && typeof item.text === 'string')
    } catch { /* unreadable: keep this page's copy */ }
    return memo
  }
  return {
    all() { return read().map((item) => ({ ...item })) },
    add(record) {
      if (!record || typeof record.slideId !== 'string' || typeof record.text !== 'string' || !record.text.trim()) return false
      const items = read()
      if (record.submissionId && items.some((item) => item.submissionId === record.submissionId)) return false
      memo = [...items, {
        submissionId: typeof record.submissionId === 'string' ? record.submissionId : '', slideId: record.slideId, text: record.text,
        name: typeof record.name === 'string' ? record.name : '', at: typeof record.at === 'string' ? record.at : new Date().toISOString(),
      }]
      try { if (storage) storage.setItem(options.key, JSON.stringify({ v: 1, items: memo })) } catch { /* full or blocked: kept for this page */ }
      return true
    },
  }
}

/**
 * The read model. Options: storage, keys { notes, reactions, questions }, slides [{ id, title }] in slide
 * order, and optionally `notes` (the page's own list, used instead of reading the notes key, so a page whose
 * storage is blocked still lists what it holds). Returns
 *   { groups: [{ index, number, slideId, title, items }] }
 * with groups in slide order and each group's items in this order: bookmark, puzzled, helped, poll answer,
 * notes (newest first), questions. A slide with nothing has no group. A kind a slide holds appears once
 * however many live runs marked it; a reaction taken back is not stored and so appears nowhere. Marks,
 * questions and poll answers for a slide the talk no longer has are left out (they cannot be placed).
 * Items: { kind: 'bookmark'|'puzzled'|'helped' } · { kind: 'poll', question, answer, at } ·
 * { kind: 'note', id, type: 'text'|'image'|'slide', quote, words, at, sentAt, sendState } · { kind: 'question', id, text, name, at }.
 * @param {any} options
 */
export function gatherMyNotes(options) {
  const slides = options.slides || []
  const keys = options.keys || {}
  const storage = options.storage || null
  const indexOf = new Map()
  slides.forEach((slide, index) => { if (slide.id) indexOf.set(slide.id, index) })
  const groups = new Map()
  const rank = { bookmark: 0, puzzled: 1, helped: 2, poll: 3, note: 4, question: 5 }
  const group = (index, title) => {
    if (!groups.has(index)) groups.set(index, { index, number: index + 1, slideId: slides[index] ? slides[index].id : '', title: title || (slides[index] && slides[index].title) || '', items: [] })
    return groups.get(index)
  }
  const readJson = (key) => { try { return storage && key ? JSON.parse(storage.getItem(key) || 'null') : null } catch { return null } }

  // Reaction marks: the kinds each slide holds in any run, once each.
  if (keys.reactions) {
    const runs = createReactionMarks({ storage, key: keys.reactions }).all()
    const held = new Map()
    for (const run of Object.values(runs)) {
      for (const [slideId, mark] of Object.entries(run)) {
        if (!indexOf.has(slideId)) continue
        if (!held.has(slideId)) held.set(slideId, new Set())
        if (mark.b) held.get(slideId).add('bookmark')
        if (mark.r === 'puzzled' || mark.r === 'helped') held.get(slideId).add(mark.r)
      }
    }
    for (const [slideId, kinds] of held) for (const kind of kinds) group(indexOf.get(slideId)).items.push({ kind })
  }

  // Poll answers: every stored answer record, oldest first.
  const answers = []
  try {
    for (let i = 0; storage && i < (storage.length || 0); i++) {
      const key = storage.key(i)
      if (!key || key.indexOf('talkweaver:poll-answer:') !== 0) continue
      const record = readJson(key)
      if (record && typeof record.slideId === 'string' && typeof record.answer === 'string' && indexOf.has(record.slideId)) answers.push({ key, record })
    }
  } catch { /* unreadable storage: no poll answers */ }
  answers.sort((a, b) => String(a.record.at || '').localeCompare(String(b.record.at || '')) || a.key.localeCompare(b.key))
  for (const { key, record } of answers) group(indexOf.get(record.slideId)).items.push({ kind: 'poll', id: key, question: String(record.question || ''), answer: record.answer, at: String(record.at || '') })

  // Highlights and notes: the page's notes, newest first within a slide. A note with a slide id the talk
  // still has is placed by it; an older one keeps the position it was made at.
  let notes = options.notes
  if (!Array.isArray(notes)) { const saved = readJson(keys.notes); notes = Array.isArray(saved) ? saved : [] }
  for (const note of notes.slice().reverse()) {
    if (!note || typeof note !== 'object') continue
    const index = indexOf.has(note.slideId) ? indexOf.get(note.slideId) : Number.isInteger(note.slideIndex) && note.slideIndex >= 0 && note.slideIndex < slides.length ? note.slideIndex : -1
    if (index < 0) continue
    const sendState = (entry) => {
      const held = !entry.sentAt && options.sendStates ? options.sendStates[entry.id] : null
      return held && (held.state === 'sending' || held.state === 'failed') ? { state: held.state, retry: held.retry !== false, reason: typeof held.reason === 'string' ? held.reason : '' } : { state: '', retry: false, reason: '' }
    }
    const image = note.type === 'image'
    const slideNote = note.type === 'slide'
    group(index, slides[index].title || note.slideTitle).items.push({
      kind: 'note', id: String(note.id || ''), type: image ? 'image' : slideNote ? 'slide' : 'text',
      quote: image ? '[Image: ' + (note.alt || 'image') + ']' : String(note.quote || ''), words: String(note.note || ''), at: String(note.createdAt || ''),
      sentAt: typeof note.sentAt === 'string' ? note.sentAt : '',
      // 'sending' while a send made on this page is in flight, 'failed' when it was refused or lost (page-supplied).
      sendState: sendState(note).state, sendRetry: sendState(note).retry, sendReason: sendState(note).reason,
    })
  }

  // Questions this device sent, in the order they were confirmed.
  if (keys.questions) {
    const log = readJson(keys.questions)
    const items = log && log.v === 1 && Array.isArray(log.items) ? log.items : []
    items.forEach((item, at) => {
      if (!item || typeof item.slideId !== 'string' || typeof item.text !== 'string' || !indexOf.has(item.slideId)) return
      group(indexOf.get(item.slideId)).items.push({ kind: 'question', id: String(item.submissionId || 'question-' + at), text: item.text, name: String(item.name || ''), at: String(item.at || '') })
    })
  }

  const ordered = [...groups.values()].sort((a, b) => a.index - b.index)
  for (const g of ordered) g.items = g.items.map((item, at) => ({ item, at })).sort((a, b) => rank[a.item.kind] - rank[b.item.kind] || a.at - b.at).map((entry) => entry.item)
  return { groups: ordered }
}

/**
 * What one chip shows of a read model: `{ chip, empty, groups, nothing }`. `empty` is true when this device
 * holds nothing at all (the empty state); `nothing` is the sentence for a chip whose kind is not held
 * anywhere. Each group keeps only the items of the chip's kind; in the Bookmarks, Puzzled and Helped views
 * it also carries `also`, one line saying what else is on that slide.
 * @param {{ groups: any[] }} model @param {string} chip
 */
export function viewMyNotes(model, chip) {
  const only = chip || 'all'
  const groups = model.groups
    .map((g) => ({ ...g, all: g.items, items: only === 'all' ? g.items : g.items.filter((item) => item.kind === only || (only === 'question' && item.kind === 'note' && item.sentAt)) }))
    .filter((g) => g.items.length)
  const others = ['bookmark', 'puzzled', 'helped']
  for (const g of groups) {
    if (!others.includes(only)) { delete g.all; continue }
    const count = (kind) => g.all.filter((item) => item.kind === kind || (kind === 'question' && item.kind === 'note' && item.sentAt)).length
    const parts = []
    if (only !== 'bookmark' && count('bookmark')) parts.push('a bookmark')
    if (only !== 'puzzled' && count('puzzled')) parts.push('puzzled')
    if (only !== 'helped' && count('helped')) parts.push('helped')
    if (count('note')) parts.push(count('note') + (count('note') > 1 ? ' notes' : ' note'))
    if (count('question')) parts.push(count('question') + (count('question') > 1 ? ' questions' : ' question'))
    if (count('poll')) parts.push(count('poll') > 1 ? count('poll') + ' poll answers' : 'a poll answer')
    g.also = parts.length ? 'Also here: ' + parts.join(', ') : 'Nothing else written here.'
    delete g.all
  }
  const nothing = { note: 'No notes yet.', bookmark: 'No slide is bookmarked.', puzzled: 'No slide is marked Puzzled.', helped: 'No slide is marked Helped.', question: 'You have not sent a question.', poll: 'You have not answered a poll.' }
  return { chip: only, empty: !model.groups.length, groups, nothing: groups.length ? '' : nothing[only] || '' }
}

/**
 * Take a bookmark or a reaction off a slide on this device, in every live run that holds it, so it leaves
 * My Notes and the bar. Sends nothing: the worker's counts are not touched. Returns how many runs changed.
 * @param {{ storage?: any, key: string }} options @param {string} slideId @param {'bookmark'|'puzzled'|'helped'} kind
 */
export function removeMyNotesMark(options, slideId, kind) {
  const marks = createReactionMarks({ storage: options.storage, key: options.key })
  let changed = 0
  for (const [runId, run] of Object.entries(marks.all())) {
    const held = run[slideId]
    if (!held) continue
    if (kind === 'bookmark' && held.b) { marks.set(slideId, runId, { b: false }); changed += 1 }
    else if (kind !== 'bookmark' && held.r === kind) { marks.set(slideId, runId, { r: null }); changed += 1 }
  }
  return changed
}

/**
 * The drawer. Options: document, panel (#myNotesPanel: the head, an empty `.mn-body` and the foot are
 * already in the page), gather() → read model, isPhone(), onOpenSlide(index), onJump(note id, slide index),
 * onDeleteNote(id), onEditNote(id, text), onRemoveMark(slideId, kind), onRetryNote(id) (a note whose send did not land).
 * The chip is kept for as long as the drawer is open or only stepped aside, and cleared by resetChip()
 * (the page calls it when the drawer is closed).
 * @param {any} options
 */
export function createMyNotesDrawer(options) {
  const document = options.document
  const panel = options.panel
  const icons = myNotesIcons()
  const body = panel.querySelector('.mn-body')
  const kinds = {
    note: { icon: 'pen-line', words: 'Note' },
    bookmark: { icon: 'bookmark-check', words: 'Bookmark' },
    puzzled: { icon: 'frown', words: 'Puzzled by this' },
    helped: { icon: 'lightbulb', words: 'Helped me understand' },
    question: { icon: 'message-circle-question-mark', words: 'Question' },
    poll: { icon: 'chart-no-axes-column', words: 'Poll answer' },
  }
  let chip = 'all'
  let editing = ''

  const phone = () => Boolean(options.isPhone && options.isPhone())
  function el(tag, cls, text) {
    const node = document.createElement(tag)
    if (cls) node.className = cls
    if (text !== undefined) node.textContent = text
    return node
  }
  function icon(name) {
    const holder = document.createElement('span')
    holder.className = 'mn-ico'
    holder.setAttribute('aria-hidden', 'true')
    holder.innerHTML = '<svg class="lucide lucide-' + name + '" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + (icons[name] || '') + '</svg>'
    return holder
  }
  function button(cls, label, act, iconName, hiddenLabel) {
    const node = el('button', cls)
    node.type = 'button'
    node.setAttribute('data-act', act)
    if (iconName) node.appendChild(icon(iconName))
    node.appendChild(el('span', hiddenLabel ? 'lbl' : '', label))
    return node
  }
  function clock(iso) {
    const date = new Date(iso)
    if (!iso || Number.isNaN(date.getTime())) return ''
    return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0')
  }

  function noteCard(item, group) {
    const card = el('div', 'mn-card')
    card.setAttribute('data-kind', 'note')
    card.setAttribute('data-note-row', item.id)
    if (item.quote) card.appendChild(el('p', 'mn-quote', item.quote))
    if (editing === item.id && !item.sentAt) {
      const input = el('textarea', 'mn-edit')
      input.setAttribute('aria-label', 'Your words for this note')
      input.setAttribute('placeholder', 'Add your comment')
      input.value = item.words
      input.addEventListener('input', () => { if (options.onEditNote) options.onEditNote(item.id, input.value) })
      input.addEventListener('blur', () => { editing = ''; render() })
      input.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.stopPropagation(); input.blur() } })
      card.appendChild(input)
      setTimeout(() => { if (input.isConnected) input.focus() }, 0)
    } else if (item.sentAt || item.sendState === 'sending') {
      // A note sent as a question (or on its way) is fixed: the speaker holds the words, so they are not edited here.
      card.appendChild(el('p', 'mn-words', item.words))
    } else {
      const words = el('p', item.words ? 'mn-words editable' : 'mn-words editable empty', item.words || 'Add your comment')
      words.tabIndex = 0
      words.setAttribute('role', 'button')
      words.setAttribute('aria-label', item.words ? 'Edit your words for this note' : 'Add your comment')
      words.setAttribute('data-act', 'edit')
      words.setAttribute('data-id', item.id)
      card.appendChild(words)
    }
    const row = el('div', 'mn-foot-row')
    const at = clock(item.at)
    if (item.sendState === 'sending') {
      const wait = el('span', 'mn-pill')
      wait.setAttribute('data-send-state', 'sending')
      wait.appendChild(icon('loader-circle'))
      wait.appendChild(document.createTextNode('Sending\u2026'))
      row.appendChild(wait)
    } else if (item.sendState === 'failed') {
      const lost = el('span', 'mn-pill failed')
      lost.setAttribute('data-send-state', 'failed')
      lost.appendChild(icon('circle-x'))
      lost.appendChild(document.createTextNode('Not sent'))
      row.appendChild(lost)
    } else if (item.sentAt) {
      const sent = el('span', 'mn-pill sent')
      sent.setAttribute('data-sent', 'true')
      sent.appendChild(icon('send'))
      const sentClock = clock(item.sentAt)
      sent.appendChild(document.createTextNode('Sent as a question' + (sentClock ? ' · ' + sentClock : '')))
      row.appendChild(sent)
    } else row.appendChild(el('span', 'mn-meta', (item.type === 'image' ? 'Image' : item.type === 'slide' ? 'Slide note' : 'Highlight') + (at ? ' · ' + at : '')))
    const tools = el('div', 'mn-tools')
    const del = button('', 'Delete', 'delete', 'trash-2', phone())
    del.setAttribute('aria-label', 'Delete this note')
    del.setAttribute('data-id', item.id)
    // A slide note has no highlight on the slide to jump to.
    if (item.type !== 'slide') {
      const jump = button('', 'Jump', 'jump', 'arrow-up-right', phone())
      jump.setAttribute('aria-label', 'Jump to this note on the slide')
      jump.setAttribute('data-id', item.id)
      jump.setAttribute('data-index', String(group.index))
      tools.appendChild(jump)
    }
    tools.appendChild(del)
    row.appendChild(tools)
    card.appendChild(row)
    if (item.sendState === 'failed') {
      if (item.sendReason) card.appendChild(el('p', 'mn-meta', 'Your note is saved. ' + item.sendReason))
      if (item.sendRetry) {
        const retry = button('mn-retry', 'Try again', 'retry-send', 'refresh-cw')
        retry.setAttribute('data-id', item.id)
        retry.setAttribute('aria-label', 'Try again to send this note to the speaker')
        card.appendChild(retry)
      }
    }
    return card
  }

  function questionCard(item) {
    const card = el('div', 'mn-card')
    card.setAttribute('data-kind', 'question')
    const pill = el('span', 'mn-pill sent')
    pill.appendChild(icon('message-circle-question-mark'))
    const at = clock(item.at)
    pill.appendChild(document.createTextNode('Question' + (at ? ' · sent ' + at : ' · sent')))
    card.appendChild(pill)
    card.appendChild(el('p', 'mn-words', item.text))
    if (item.name) card.appendChild(el('p', 'mn-meta', 'Sent as ' + item.name))
    return card
  }

  function pollCard(item) {
    const card = el('div', 'mn-card')
    card.setAttribute('data-kind', 'poll')
    const pill = el('span', 'mn-pill')
    pill.appendChild(icon(kinds.poll.icon))
    pill.appendChild(document.createTextNode(kinds.poll.words))
    card.appendChild(pill)
    if (item.question) card.appendChild(el('p', 'mn-poll-q', item.question))
    card.appendChild(el('p', 'mn-poll-a', 'You chose: ' + item.answer))
    return card
  }

  function marksRow(items, group) {
    const marks = items.filter((item) => item.kind === 'bookmark' || item.kind === 'puzzled' || item.kind === 'helped')
    if (!marks.length) return null
    const row = el('div', 'mn-pills')
    for (const mark of marks) {
      const one = el('div', 'mn-mark')
      one.setAttribute('data-mark', mark.kind)
      const pill = el('span', 'mn-pill')
      pill.appendChild(icon(kinds[mark.kind].icon))
      pill.appendChild(document.createTextNode(kinds[mark.kind].words))
      const remove = button('mn-remove', 'Remove', 'remove', 'x')
      remove.setAttribute('aria-label', 'Remove ' + kinds[mark.kind].words + ' from My Notes')
      remove.setAttribute('title', 'Removes it from this ' + (phone() ? 'phone' : 'device') + ' only. The speaker is not told.')
      remove.setAttribute('data-kind', mark.kind)
      remove.setAttribute('data-slide-id', group.slideId)
      one.append(pill, remove)
      row.appendChild(one)
    }
    return row
  }

  function groupSection(group) {
    const section = el('section', 'mn-group')
    section.setAttribute('data-slide', String(group.number))
    const head = el('div', 'mn-ghead')
    const title = el('h3')
    title.appendChild(document.createTextNode('Slide ' + group.number + ' — ' + group.title))
    head.appendChild(title)
    const open = button('mn-open', 'Open slide', 'open', 'arrow-right')
    open.setAttribute('data-index', String(group.index))
    head.appendChild(open)
    section.appendChild(head)
    const marks = marksRow(group.items, group)
    if (marks) section.appendChild(marks)
    if (group.also) section.appendChild(el('p', 'mn-also', group.also))
    for (const item of group.items) {
      if (item.kind === 'poll') section.appendChild(pollCard(item))
    }
    for (const item of group.items) {
      if (item.kind === 'note') section.appendChild(noteCard(item, group))
    }
    for (const item of group.items) {
      if (item.kind === 'question') section.appendChild(questionCard(item))
    }
    return section
  }

  function render(focus) {
    const keepScroll = body.scrollTop
    const view = viewMyNotes(options.gather(), chip)
    const here = phone() ? 'this phone' : 'this device'
    body.textContent = ''
    panel.classList.toggle('mn-is-empty', view.empty)
    if (view.empty) {
      const empty = el('div', 'mn-empty')
      empty.appendChild(el('p', 'mn-lead', 'Your notes stay on the device you took them on.'))
      empty.appendChild(el('p', 'mn-how', phone() ? 'Tap Note under a slide to write a note.' : 'Select text on a slide to highlight it and add a note.'))
      body.appendChild(empty)
      return
    }
    body.appendChild(el('p', 'mn-privacy', 'Everything here stays on ' + here + '. Only a question you send leaves it, and only when you choose.'))
    const chips = el('div', 'mn-chips')
    chips.setAttribute('role', 'group')
    chips.setAttribute('aria-label', 'Show')
    for (const [id, label] of myNotesChips()) {
      const one = el('button', 'mn-chip', label)
      one.type = 'button'
      one.setAttribute('data-chip', id)
      one.setAttribute('aria-pressed', id === view.chip ? 'true' : 'false')
      chips.appendChild(one)
    }
    body.appendChild(chips)
    if (view.nothing) body.appendChild(el('p', 'mn-nothing', view.nothing))
    for (const group of view.groups) body.appendChild(groupSection(group))
    body.scrollTop = keepScroll
    if (focus) { const target = body.querySelector(focus); if (target && target.focus) target.focus({ preventScroll: true }) }
  }

  body.addEventListener('click', (event) => {
    const target = event.target && event.target.closest ? event.target.closest('[data-chip], [data-act]') : null
    if (!target || !body.contains(target)) return
    if (target.hasAttribute('data-chip')) { chip = target.getAttribute('data-chip'); render('.mn-chip[data-chip="' + chip + '"]'); return }
    const act = target.getAttribute('data-act')
    if (act === 'open' && options.onOpenSlide) options.onOpenSlide(Number(target.getAttribute('data-index')))
    else if (act === 'jump' && options.onJump) options.onJump(target.getAttribute('data-id'), Number(target.getAttribute('data-index')))
    else if (act === 'retry-send' && options.onRetryNote) options.onRetryNote(target.getAttribute('data-id'))
    else if (act === 'delete' && options.onDeleteNote) options.onDeleteNote(target.getAttribute('data-id'))
    else if (act === 'remove' && options.onRemoveMark) options.onRemoveMark(target.getAttribute('data-slide-id'), target.getAttribute('data-kind'))
    else if (act === 'edit') { editing = target.getAttribute('data-id'); render() }
  })
  body.addEventListener('keydown', (event) => {
    const target = event.target
    if ((event.key === 'Enter' || event.key === ' ') && target && target.getAttribute && target.getAttribute('data-act') === 'edit') {
      event.preventDefault(); event.stopPropagation(); editing = target.getAttribute('data-id'); render()
    }
  })

  return {
    render,
    /** Start editing one note's words in place (a new image note opens this way). */
    edit(id) { editing = id; render() },
    chip() { return chip },
    resetChip() { chip = 'all'; editing = '' },
  }
}

/**
 * Which kinds each slide holds, for the slide list (Overview on a laptop, the list on a phone): one entry per
 * slide index that holds anything, its kinds in the legend's order, once each. A note sent as a question is
 * both a Note and a Question; a note whose send has not landed is a Note only.
 * @param {{ groups: any[] }} model @returns {Record<number, string[]>}
 */
export function myNotesSlideMarks(model) {
  const order = ['note', 'bookmark', 'puzzled', 'helped', 'question', 'poll']
  /** @type {Record<number, string[]>} */
  const marks = {}
  for (const g of model.groups) {
    const held = new Set()
    for (const item of g.items) {
      if (item.kind === 'note') { held.add('note'); if (item.sentAt) held.add('question') } else held.add(item.kind)
    }
    marks[g.index] = order.filter((kind) => held.has(kind))
  }
  return marks
}

/**
 * The slide list's marks and legend as DOM. Options: document, gather() → read model. `refresh()` re-reads the
 * device once; `marksFor(index)` is a `.mn-marks` span of icons (each named for a screen reader) or null when the
 * slide holds nothing; `legend()` a fresh `.mn-legend`; `slides()` how many slides hold something. Icons only,
 * so nothing a person typed reaches the list.
 * @param {any} options
 */
export function createSlideMarks(options) {
  const document = options.document
  const icons = myNotesIcons()
  const kinds = {
    note: ['pen-line', 'Note'], bookmark: ['bookmark-check', 'Bookmark'], puzzled: ['frown', 'Puzzled'],
    helped: ['lightbulb', 'Helped'], question: ['message-circle-question-mark', 'Question'], poll: ['chart-no-axes-column', 'Poll answer'],
  }
  let marks = {}
  const svg = (name) => '<svg class="lucide lucide-' + name + '" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + (icons[name] || '') + '</svg>'
  function refresh() { marks = myNotesSlideMarks(options.gather()) }
  refresh()
  return {
    refresh,
    slides() { return Object.keys(marks).length },
    marksFor(index) {
      const held = marks[index]
      if (!held || !held.length) return null
      const row = document.createElement('span')
      row.className = 'mn-marks'
      row.setAttribute('data-marks', held.join(' '))
      for (const kind of held) {
        const one = document.createElement('span')
        one.className = 'mn-mark-ico'
        one.setAttribute('role', 'img')
        one.setAttribute('aria-label', kinds[kind][1])
        one.setAttribute('title', kinds[kind][1])
        one.innerHTML = svg(kinds[kind][0])
        row.appendChild(one)
      }
      return row
    },
    legend() {
      const box = document.createElement('div')
      box.className = 'mn-legend'
      box.setAttribute('aria-label', 'What the marks mean')
      const head = document.createElement('span')
      head.className = 'mn-legend-h'
      head.textContent = 'Marks'
      box.appendChild(head)
      for (const kind of ['note', 'bookmark', 'puzzled', 'helped', 'question', 'poll']) {
        const one = document.createElement('span')
        one.setAttribute('data-kind', kind)
        one.innerHTML = svg(kinds[kind][0])
        one.appendChild(document.createTextNode(kinds[kind][1]))
        box.appendChild(one)
      }
      return box
    },
  }
}

/**
 * The notes as Markdown, every kind, in slide order: `# Notes: <talk>`, the date, then one `## Slide N: <title>`
 * per slide that holds anything and one list item per thing kept (marks, poll answer, notes, questions; a
 * highlight is `- > quote` with its words under it). A pure function of the read model. Nothing is escaped:
 * it is the person's own text, and a quote is flattened to one line so it stays one blockquote.
 * @param {{ groups: any[] }} model @param {{ title?: string, date?: string }} options
 */
export function myNotesMarkdown(model, options) {
  const title = String((options && options.title) || '')
  const date = String((options && options.date) || '')
  const clock = (iso) => {
    const at = new Date(iso)
    return !iso || Number.isNaN(at.getTime()) ? '' : String(at.getHours()).padStart(2, '0') + ':' + String(at.getMinutes()).padStart(2, '0')
  }
  const flat = (text) => String(text).replace(/\s+/g, ' ').trim()
  const wrap = (text) => String(text).replace(/\r\n?/g, '\n').trim().split('\n').join('\n  ')
  const at = (iso) => (clock(iso) ? ' (' + clock(iso) + ')' : '')
  const words = { bookmark: 'Bookmarked', puzzled: 'Puzzled by this', helped: 'Helped me understand' }
  const lines = ['# Notes: ' + title, '']
  if (date) lines.push(date, '')
  if (!model.groups.length) lines.push('Nothing has been kept yet.')
  for (const group of model.groups) {
    lines.push('## Slide ' + group.number + ': ' + flat(group.title), '')
    for (const item of group.items) {
      if (words[item.kind]) lines.push('- ' + words[item.kind])
      else if (item.kind === 'poll') lines.push('- Poll answer' + (item.question ? ': ' + flat(item.question) : ''), '  You chose: ' + wrap(item.answer))
      else if (item.kind === 'question') lines.push('- Question sent to the speaker' + at(item.at) + ': ' + wrap(item.text))
      else if (item.kind === 'note') {
        const head = item.type === 'image' ? '- ' + flat(item.quote) : item.quote ? '- > ' + flat(item.quote) : '- Note on the slide' + (item.words ? ':' : '')
        const body = item.words ? (item.quote ? '\n  ' : ' ') + wrap(item.words) : ''
        lines.push(head + body)
        if (item.sentAt) lines.push('  Sent to the speaker as a question' + at(item.sentAt))
      }
    }
    lines.push('')
  }
  return lines.join('\n').trim() + '\n'
}

/**
 * The printable notes page: a complete HTML document of the notes with their slide titles (never the slides),
 * one section per slide that holds anything, in slide order. Black text, every mark in words. Options: title,
 * screenBar (the on-screen bar with the print button, hidden when printed; default true). An empty My Notes is
 * one line. Every string is escaped; the page carries no script (the opener wires the button).
 * @param {{ groups: any[] }} model @param {{ title?: string, screenBar?: boolean }} options
 */
export function myNotesPrintHtml(model, options) {
  const title = String((options && options.title) || '')
  const bar = !options || options.screenBar !== false
  const icons = myNotesIcons()
  const esc = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const svg = (name) => '<svg class="lucide" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (icons[name] || '') + '</svg>'
  const clock = (iso) => {
    const at = new Date(iso)
    return !iso || Number.isNaN(at.getTime()) ? '' : String(at.getHours()).padStart(2, '0') + ':' + String(at.getMinutes()).padStart(2, '0')
  }
  const at = (iso) => (clock(iso) ? ' · ' + clock(iso) : '')
  const mark = { bookmark: ['bookmark-check', 'Bookmarked'], puzzled: ['frown', 'Puzzled by this'], helped: ['lightbulb', 'Helped me understand'] }
  let kept = 0
  const item = (it) => {
    kept += 1
    if (it.kind === 'poll') return '<div class="it"><div class="lab">Poll answer</div>' + (it.question ? '<p class="q">' + esc(it.question) + '</p>' : '') + '<p class="a">You chose: ' + esc(it.answer) + '</p></div>'
    if (it.kind === 'question') return '<div class="it"><div class="lab">Question sent to the speaker' + esc(at(it.at)) + '</div><p>' + esc(it.text) + '</p></div>'
    return '<div class="it">' + (it.quote ? '<blockquote>' + esc(it.quote) + '</blockquote>' : '<div class="lab">Note on the slide</div>')
      + (it.words ? '<p>' + esc(it.words) + '</p>' : '') + (it.sentAt ? '<div class="lab">Sent to the speaker as a question' + esc(at(it.sentAt)) + '</div>' : '') + '</div>'
  }
  const section = (group) => {
    const marks = group.items.filter((it) => mark[it.kind])
    kept += marks.length
    const row = marks.length ? '<div class="marks">' + marks.map((it) => '<span class="mk">' + svg(mark[it.kind][0]) + mark[it.kind][1] + '</span>').join('') + '</div>' : ''
    return '<section><h2><span class="no">Slide ' + group.number + '</span> ' + esc(group.title) + '</h2>' + row + group.items.filter((it) => !mark[it.kind]).map(item).join('') + '</section>'
  }
  const sections = model.groups.map(section).join('')
  const body = model.groups.length ? sections : '<p class="nothing">There is nothing to print yet. No notes have been made on this device.</p>'
  const end = model.groups.length ? '<p class="end">' + model.groups.length + (model.groups.length === 1 ? ' slide' : ' slides') + ' · ' + kept + (kept === 1 ? ' thing' : ' things') + ' kept</p>' : ''
  const css = '@page{size:A4;margin:18mm 18mm 20mm}*{box-sizing:border-box}html{background:#e9e7df}body{margin:0;color:#17202a;font:11pt/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}'
    + '.bar{position:sticky;top:0;z-index:3;display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:10px 16px;background:#fffdf2;border-bottom:1px solid #17202a22;font:14px system-ui,sans-serif}.bar p{margin:0;flex:1 1 260px;color:#384452}'
    + '.bar button{appearance:none;display:inline-flex;align-items:center;gap:8px;height:40px;padding:0 16px;border:0;border-radius:9px;background:#0f4bd8;color:#fff;font:700 15px system-ui,sans-serif;cursor:pointer}.bar button svg{width:18px;height:18px}'
    + '.sheet{max-width:794px;margin:24px auto 40px;padding:18mm;background:#fff;box-shadow:0 8px 30px #0002}'
    + 'h1{margin:0 0 4px;font-size:20pt;line-height:1.2;letter-spacing:-.01em;overflow-wrap:anywhere}.sub{margin:0 0 14pt;font-size:9.5pt;color:#4b5563}'
    + 'section{margin:0 0 13pt;break-inside:avoid}h2{margin:0 0 5pt;padding-top:7pt;border-top:1.5px solid #17202a;font-size:12pt;line-height:1.3;overflow-wrap:anywhere}h2 .no{margin-right:6px;font-weight:500;color:#4b5563}'
    + '.marks{display:flex;flex-wrap:wrap;gap:4px 14px;margin:0 0 5pt;font-size:10pt;font-weight:700}.mk{display:inline-flex;align-items:center;gap:5px}.mk svg{width:14px;height:14px}'
    + '.it{margin:0 0 7pt;overflow-wrap:anywhere}.it p{margin:0;white-space:pre-wrap}.it .lab{font-size:9pt;color:#4b5563}'
    + 'blockquote{margin:0 0 2pt;padding:1pt 0 1pt 9px;border-left:3px solid #17202a;font-style:italic}.q{color:#4b5563;font-size:10pt}.a{font-weight:700}'
    + '.nothing{margin:18pt 0;font-size:13pt}.end{margin:14pt 0 0;padding-top:6pt;border-top:1px solid #c9ccd2;font-size:9pt;color:#4b5563}'
    + '@media print{.bar{display:none}html{background:#fff}.sheet{max-width:none;margin:0;padding:0;box-shadow:none}}'
  const top = bar ? '<div class="bar" role="region" aria-label="Print"><p>Your notes, ready to print. In the print window, choose “Save as PDF” as the destination to keep a copy.</p><button type="button" id="printNow">' + svg('printer') + 'Print or save as PDF</button></div>' : ''
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Notes: ' + esc(title) + '</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>' + css + '</style></head><body>'
    + top + '<main class="sheet"><h1>Notes — ' + esc(title) + '</h1><p class="sub">Printed from the handout link · notes made on this device</p>' + body + end + '</main></body></html>'
}

/** The drawer's look: today's drawer (right edge, 460px, paper) with a scrolling body and a foot that stays. */
export const audienceMyNotesStyles = `
body:has(.mynotes-panel.open) .help-fab{visibility:hidden}
.mynotes-panel{display:flex;flex-direction:column;padding:0;overflow:hidden;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
.mn-head{flex:none;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:16px 18px 8px}
.mn-head h2{margin:0;font-size:19px;letter-spacing:-.01em}
.mn-head .btn,.mn-foot .btn{background:#fff;border:1px solid #17202a24;color:#17202a}
.mn-head .btn{display:inline-flex;align-items:center;gap:6px;min-height:36px;padding:0 12px;font-size:13.5px;font-weight:600}
.mn-body{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:0 18px 14px}
.mn-ico{display:inline-flex;flex:none}
.mn-ico svg{width:15px;height:15px}
.mn-privacy{margin:0 0 12px;font-size:13px;line-height:1.4;color:#5b6572}
.mn-chips{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 14px}
.mn-chip{appearance:none;height:36px;padding:0 13px;border:1px solid #d5d2c9;border-radius:999px;background:#fff;color:#17202a;font:600 13.5px system-ui,sans-serif;cursor:pointer}
.mn-chip[aria-pressed="true"]{background:#e8eefc;border-color:#0f4bd8;color:#0f4bd8;box-shadow:inset 0 0 0 1px #0f4bd8}
.mn-chip:focus-visible,.mn-open:focus-visible,.mn-remove:focus-visible,.mn-tools button:focus-visible,.mn-words.editable:focus-visible,.mn-edit:focus-visible,.mn-foot .btn:focus-visible,.mn-head .btn:focus-visible{outline:3px solid #0f4bd8;outline-offset:2px}
.mn-group{margin:0 0 18px}
.mn-ghead{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin:0 0 6px}
.mn-ghead h3{flex:1 1 auto;min-width:0;margin:0;padding-top:6px;font-size:14px;line-height:1.35;letter-spacing:-.005em;overflow-wrap:anywhere}
.mn-open{flex:none;appearance:none;display:inline-flex;align-items:center;gap:5px;min-height:32px;padding:0 8px;border:0;border-radius:7px;background:transparent;color:#0f4bd8;font:600 13px system-ui,sans-serif;cursor:pointer;white-space:nowrap}
.mn-open:hover{background:#e8eefc}
.mn-open .mn-ico{order:2}
.mn-open svg{width:15px;height:15px}
.mn-pills{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 8px}
.mn-mark{display:inline-flex;align-items:center;gap:2px}
.mn-pill{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 10px 0 8px;border-radius:999px;background:#e8eefc;color:#0f4bd8;font:600 12.5px system-ui,sans-serif;white-space:nowrap}
.mn-pill svg{width:14px;height:14px;flex:none}
.mn-pill.failed{background:#fdecea;color:#8c2a20}
.mn-retry{appearance:none;justify-self:start;display:inline-flex;align-items:center;gap:6px;min-height:32px;padding:0 12px;border:1px solid #0f4bd8;border-radius:7px;background:#fff;color:#0f4bd8;font:600 13px system-ui,sans-serif;cursor:pointer}
.mn-retry svg{width:14px;height:14px}
.mn-retry:focus-visible{outline:3px solid #0f4bd8;outline-offset:2px}
.mn-remove{appearance:none;display:inline-flex;align-items:center;gap:4px;min-height:32px;padding:0 8px;border:0;border-radius:7px;background:transparent;color:#5b6572;font:600 12.5px system-ui,sans-serif;cursor:pointer}
.mn-remove:hover{background:#17202a0d;color:#17202a}
.mn-remove svg{width:13px;height:13px}
.mn-also{margin:0 0 4px;font-size:13px;line-height:1.4;color:#5b6572}
.mn-card>.mn-pill{justify-self:start}
.mn-card{display:grid;gap:6px;margin:0 0 8px;padding:9px 10px;border:1px solid #17202a22;border-radius:8px;background:#fff}
.mn-quote{margin:0;padding-left:8px;border-left:3px solid #f59e0b;font-size:13px;line-height:1.4;color:#384452;overflow-wrap:anywhere}
.mn-words{margin:0;font-size:14px;line-height:1.4;color:#17202a;white-space:pre-wrap;overflow-wrap:anywhere}
.mn-words.editable{cursor:text;border-radius:4px}
.mn-words.editable.empty{color:#5b6572}
.mn-edit{width:100%;box-sizing:border-box;min-height:56px;border:1px solid #17202a33;border-radius:6px;padding:6px;font:14px/1.4 system-ui,sans-serif}
.mn-poll-q{margin:0;font-size:13px;color:#5b6572;overflow-wrap:anywhere}
.mn-poll-a{margin:0;font-size:14px;font-weight:700;overflow-wrap:anywhere}
.mn-foot-row{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
.mn-meta{display:inline-flex;align-items:center;gap:6px;margin:0;font-size:12.5px;color:#5b6572;overflow-wrap:anywhere}
.mn-tools{display:flex;gap:6px;margin-left:auto}
.mn-tools button{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:5px;min-height:32px;padding:0 10px;border:1px solid #17202a24;border-radius:6px;background:#fff;color:#384452;font:600 12.5px system-ui,sans-serif;cursor:pointer}
.mn-tools button svg{width:14px;height:14px}
.mn-nothing{margin:8px 0 0;padding:12px;border:1px dashed #c9ccd2;border-radius:8px;font-size:14px;color:#5b6572}
.mn-foot{flex:none;display:grid;gap:8px;padding:12px 18px 14px;border-top:1px solid #17202a22;background:#fffdf2}
.mn-foot-h{margin:0;font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#5b6572}
.mn-foot-actions{display:flex;flex-wrap:nowrap;gap:8px}
.mn-foot-actions .btn{flex:1 1 0;min-width:0;justify-content:center;min-height:36px;padding:0 8px;gap:6px;white-space:nowrap;font-size:13.5px;font-weight:600}
.mn-foot .btn.mn-primary{justify-content:center;width:100%;min-height:40px;border:0;background:#0f4bd8;color:#fff;font-size:14.5px;font-weight:700}
.mn-foot .btn.mn-primary:focus-visible{outline:3px solid #17202a;outline-offset:2px}
.mynotes-panel.mn-is-empty .mn-foot .btn.mn-primary{background:#fff;color:#17202a;border:1px solid #c9ccd2}
.mn-marks{display:inline-flex;align-items:center;gap:7px;margin-left:auto;flex:none;color:#0f4bd8}
.mn-mark-ico{display:inline-flex}
.mn-marks svg{width:16px;height:16px}
.slide-link .slide-link-title{display:flex;align-items:center;gap:10px;width:100%}
.slide-link .slide-link-title>span:not(.mn-marks):not(.tw-status){min-width:0;flex:1 1 auto}
.mn-legend{position:sticky;top:0;z-index:4;display:flex;flex-wrap:wrap;gap:4px 12px;margin:0 0 6px;padding:6px 0;background:#fffdf2;border-bottom:1px solid #17202a14;font:12.5px/1.3 system-ui,sans-serif;color:#384452}
.mn-legend span{display:inline-flex;align-items:center;gap:4px;white-space:nowrap}
.mn-legend svg{width:15px;height:15px;color:#0f4bd8;flex:none}
.mn-legend-h{flex:none;margin-right:2px;font-weight:700;color:#5b6572}
.nav-panel .mn-legend{top:-18px;padding-top:24px}
.mn-listhead{position:sticky;top:0;z-index:5;padding:8px 12px 6px;background:#fdfdfb;border-bottom:1px solid #e3e2dc;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
.mn-listhead .mn-open-notes{appearance:none;display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;min-height:48px;padding:0 14px;border:1px solid #0f4bd8;border-radius:10px;background:#e8eefc;color:#0f4bd8;font:700 15px system-ui,sans-serif;text-align:left;margin-bottom:8px;cursor:pointer;touch-action:manipulation}
.mn-listhead .mn-open-notes small{font:500 13px system-ui,sans-serif;color:#384452}
.mn-listhead .mn-open-notes:focus-visible{outline:3px solid #0f4bd8;outline-offset:2px}
.mn-listhead .mn-legend{position:static;margin:0;padding:0 0 4px;background:transparent;border:0}
.pslide-label .mn-marks{align-self:center}
.mn-empty{padding:26px 4px 20px}
.mn-empty p{margin:0}
.mn-empty .mn-lead{font-size:18px;line-height:1.35;font-weight:700;letter-spacing:-.01em}
.mn-empty .mn-how{margin-top:10px;font-size:14.5px;line-height:1.45;color:#384452}
@media (max-width:699px){
  .mn-head{padding:12px 14px 6px}
  .mn-head .btn{min-height:44px;padding:0 14px;font-size:14px}
  .mn-body{padding:0 14px 14px}
  .mn-privacy{font-size:13.5px}
  .mn-chip{height:44px;min-width:48px;padding:0 11px}
  .mn-open{min-height:44px}
  .mn-ghead h3{padding-top:12px;font-size:14.5px}
  .mn-pill{height:30px;font-size:13px}
  .mn-remove{min-height:44px;padding:0 10px;font-size:13px}
  .mn-retry{min-height:44px;padding:0 16px;font-size:14px}
  .mn-tools button{min-height:44px;min-width:44px;padding:0}
  .mn-tools button svg{width:18px;height:18px}
  .mn-tools button .lbl{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
  .mn-tools button{position:relative}
  .mn-foot{padding:10px 14px 12px}
  .mn-foot-actions .btn{min-height:44px}
  .mn-foot .btn.mn-primary{min-height:48px}
  .mn-foot-h{display:none}
}
`

export function audienceMyNotesRuntimeSource() {
  return [myNotesChips, myNotesIcons, myNotesPollAnswerKey, pollAnswerRecord, noteQuestionText, createQuestionLog, gatherMyNotes, viewMyNotes, removeMyNotesMark, myNotesSlideMarks, createSlideMarks, myNotesMarkdown, myNotesPrintHtml, createMyNotesDrawer]
    .map((fn) => fn.toString()).join('\n')
}
