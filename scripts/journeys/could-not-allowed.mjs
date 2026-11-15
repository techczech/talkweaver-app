// The only checks that may end COULD-NOT without failing the journey. Each has a reason and a condition on
// the evidence the check recorded (the row's `data`); a COULD-NOT outside this list, or one whose condition
// does not hold, fails the run. Each condition is bounded to the measured known fault: the parts the fault does
// not touch must be measured and as expected, and only the fault itself is excused. Remove an entry when its
// fault is fixed: the check then has to pass.

// ── Presenter status bar at 1280 px ──
// Measured: every status-bar item (.tw-st) with its text and width. The fault: the presenter tools collapse to
// zero width. Not touched by it, so required: the recording item ("Not recording") and the live item ("Not
// live", with End) shown with width; every tool still in the bar by its words.
const BAR_SHOWN = [/^Not recording\b/, /^Not live/]
const BAR_TOOLS = ['Spotlight', 'Pointer', 'Pen', 'Clear drawing', 'Highlight', 'Section']
const barItems = (d) => (Array.isArray(d?.items) && d.items.length && d.items.every((i) => typeof i?.t === 'string' && Number.isFinite(i?.w)) ? d.items.map((i) => ({ t: i.t.replace(/\s+/g, ' ').trim(), w: i.w })) : null)
/** The bar as measured has its recording and live items shown and every tool in it. */
export function statusBarMeasured(d) {
  const items = barItems(d)
  return !!items && BAR_SHOWN.every((rx) => items.some((i) => rx.test(i.t) && i.w > 0)) && BAR_TOOLS.every((name) => items.some((i) => i.t.startsWith(name)))
}
/** The known fault: the bar as measured, with items at zero width, none of them the recording or live item. */
export function statusBarKnownCollapse(d) {
  if (!statusBarMeasured(d)) return false
  const collapsed = barItems(d).filter((i) => i.w === 0)
  return collapsed.length > 0 && collapsed.every((i) => !BAR_SHOWN.some((rx) => rx.test(i.t)))
}

// ── Saved note and "Start again" after recording ──
// Measured: the saved note's text and line count, and "Start again" (while recording): element, name, size, and
// whether it is drawn as a button (a fill or a border). The fault: the note wraps to a second line, or "Start
// again" is drawn as text. Required: the note's expected words, at most two lines, "Start again" a visible button.
const SAVED_NOTE = /^Saved to History as Delivery · \d{2}:\d{2} · Voice saved · slides: complete · camera: complete$/
export function savedNoteMeasured(d) {
  const n = d?.savedNote, a = d?.startAgain
  return !!n && typeof n.text === 'string' && SAVED_NOTE.test(n.text) && (n.lines === 1 || n.lines === 2)
    && !!a && a.tag === 'BUTTON' && /^Start again\b/.test(a.text ?? '') && a.visible === true && a.w > 0 && a.h > 0 && typeof a.buttonLike === 'boolean'
}
export function savedNoteKnownFault(d) {
  return savedNoteMeasured(d) && (d.savedNote.lines === 2 || d.startAgain.buttonLike === false)
}

// ── "Start at the sentence" ──
// Decided from the transcript and the Run's slide marks with the editor's row rule (record-edit-export.mjs):
// `rows` (every slide visit: no clear pause? sentence start near? its first word), `eligible` (rows that offer
// it). Allowed only when the rule was evaluated over every row the screen shows (same count, same slides), the
// transcript has sentences, no row is eligible, and the screen agrees (no button, no "A sentence starts at").
export function sentenceNotReached(d) {
  const rows = Array.isArray(d?.rows) ? d.rows : null
  return !!rows && rows.length > 0 && rows.every((r) => Number.isInteger(r?.index) && typeof r?.noClearPause === 'boolean' && (r.sentenceNear === null || Number.isInteger(r.sentenceNear)) && Number.isInteger(r?.firstWord))
    && d.uiRows === rows.length && Array.isArray(d.uiSlides) && d.uiSlides.length === rows.length && d.uiSlides.every((s, i) => s === rows[i].slideId)
    && Number.isInteger(d.sentences) && d.sentences > 0
    && Array.isArray(d.eligible) && d.eligible.length === 0 && !rows.some((r) => r.noClearPause && r.sentenceNear !== null && r.sentenceNear !== r.firstWord)
    && d.buttons === 0 && d.uiSentenceElsewhere === 0
}

export const COULD_NOT_ALLOWED = {
  'present.status-bar-1280': {
    reason: 'Known fault, tracked: the presenter status bar collapses its tools to nothing at 1280 px. Allowed only when the recording and live items are shown with their words, every tool is still in the bar, and only other items are at zero width.',
    when: statusBarKnownCollapse,
  },
  'record.audience-counts-1280': {
    reason: 'Known, tracked: reactions and questions are counted only while live, and the journey is not live. Allowed only when the presenter says "Not live".',
    when: (d) => d?.live === 'Not live',
  },
  'record.saved-note': {
    reason: 'Known fault, tracked: after recording, "Start again" is drawn as text and the saved note can run to two lines. Allowed only when the note has its expected words on at most two lines and "Start again" is a visible button with its words.',
    when: savedNoteKnownFault,
  },
  'edit.start-at-sentence': {
    reason: 'The fixture does not reach it: by the transcript and the slide marks (the editor\'s row rule) no row has a sentence start near a slide change with no clear pause that is not already the slide\'s start, so the editor has nothing to offer. Allowed only with that evaluation over every row on screen and the screen agreeing (no button, no "A sentence starts at" note).',
    when: sentenceNotReached,
  },
}
