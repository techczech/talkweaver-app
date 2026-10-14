// The page half of case S of test:quote-form-typed-slide-editor (quote forms ticket 11, fourth review): sequences of
// editor operations drawn at random from a fixed seed, with an oracle that does not use the typing watch.
//
// Bundled into the test page by the main script (which puts `window.mount` and `window.viewNow` there). The editor is
// the one every other case uses; only its history is configured, so that how undo steps are grouped does not depend on
// the clock: `newGroupDelay` is beyond any run, changes join the step before them wherever they lie
// (`joinToEvent: () => true`), and a pause longer than the grouping delay is the operation `pause`, an empty
// transaction with `isolateHistory.of('full')`. So a program's change shares an undo step with the typing around it
// unless a pause or a caret move comes between: the grouping the fourth review's reproduction needs, and its opposite.
//
// The oracle: whose every character is. A second editor state (no view, no watch, the same history configuration)
// holds a text of the same length in which every character stands for who put it there: `o` it was in the talk when
// the editor was mounted, `u` the user typed it (a transaction this file dispatched as the user: a typed character,
// the Enter key), `p` anything else (a program's change, a save's adoption, the rule's own write). A line break stays
// a line break. Every transaction of the real editor is repeated there with the same positions, selection, user event
// and history annotations, and every undo and redo is an undo and redo of that state's own history: what an undo
// restores there is whose the restored text was, by the history's own working and nothing of the watch's.
// "The link is not the user's": the link in the slide, with the character on either side of it, holds no `u`. Then
// nothing the user typed that is still in effect is in it or against it, and no form may be written.
// What that cannot see is a deletion (nothing is left to mark, and a mark put on a neighbour would make the two
// histories group differently). So once the user deletes a character in or against a link of the slide, the oracle
// says nothing about that link for the rest of the episode (`silent`); the other assertions still hold there.
//
// Asserted after every operation: the two states agree (length, line breaks, selection, undo depth); no form outside
// the slide typed on; and when a form appears: the slide has a link, and the oracle does not say that link is not the
// user's. The form is then undone step by step: at no step does it stand without its link. Then the next episode
// begins on a newly mounted editor.
import { EditorSelection, EditorState, Transaction } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { history, isolateHistory, redo, undo, undoDepth } from '@codemirror/commands'
import { adoptSavedText } from '../../src/renderer/src/extensions/savedTextAdoption.ts'

const ALICE = 'https://example.org/alice'
const BOB = 'https://example.org/bob'
const LINK = /https?:\/\/[^\s]+/g

/** The links of the slide typed on, by their extent in the text. */
function linksOf(text) {
  const from = text.indexOf('### One')
  return [...text.slice(from, text.indexOf('### Two')).matchAll(LINK)].map((m) => ({ from: from + m.index, to: from + m.index + m[0].length }))
}

/** mulberry32: the same numbers for the same seed, everywhere. */
function numbers(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const talk = (withId, source) => [
  '# Talk', '',
  '## Part one', '{id=p1}', '',
  '### One', ...(withId ? ['{id=s1}'] : []), '', '> Words one.', '', source, '',
  '### Two', '', '> Words two.', '', '- Bob', '',
  '### Three', '', '- a point', '- another point', ''
].join('\n')

// What follows what more often than chance: the shapes the reviews found (a change that is not the user's, typing
// straight after it, an undo, the line left).
const AFTER = {
  pDel: ['link', 'link', 'link', 'type'],
  pRep: ['link', 'type', 'undo', 'back'],
  pIns: ['type', 'back', 'undo', 'enter'],
  link: ['leave', 'leave', 'type', 'type', 'enter', 'pause', 'undo', 'back'],
  type: ['undo', 'undo', 'undo', 'leave', 'leave', 'pDel', 'back'],
  back: ['undo', 'undo', 'leave', 'type'],
  wipe: ['link', 'undo'],
  undo: ['leave', 'leave', 'undo', 'redo', 'redo', 'type'],
  redo: ['leave', 'leave', 'redo', 'undo', 'enter'],
  enter: ['enter', 'enter', 'enter', 'undo', 'leave'],
  leave: ['clickSrc'],
  clickSrc: ['link', 'type', 'pDel', 'pDel', 'pRep', 'pIns', 'undo', 'enter'],
  clickBelow: ['type', 'back', 'enter', 'undo'],
  pause: ['type', 'link', 'pDel', 'pIns', 'undo'],
  adopt: ['type', 'undo', 'link']
}
const WEIGHTS = { type: 16, link: 10, back: 12, wipe: 3, pIns: 6, pDel: 7, pRep: 5, pause: 12, undo: 12, redo: 7, enter: 6, leave: 6, clickSrc: 8, clickBelow: 2, adopt: 3 }

window.randomRun = async ({ seed, ops: total, episodeOps, minDepth }) => {
  const random = numbers(seed)
  const pick = (list) => list[Math.floor(random() * list.length)]
  const weighted = () => {
    let at = random() * Object.values(WEIGHTS).reduce((a, b) => a + b, 0)
    for (const [name, weight] of Object.entries(WEIGHTS)) { at -= weight; if (at < 0) return name }
    return 'type'
  }
  const config = { newGroupDelay: 1e9, joinToEvent: () => true, ...(minDepth ? { minDepth } : {}) }
  const result = { ops: 0, episodes: 0, forms: 0, judged: 0, undone: 0, deepest: 0, dropped: 0, failure: null }
  let view = null
  let shadow = null
  let actor = 'program'
  let silent = false
  const mirror = EditorView.updateListener.of((update) => {
    for (const tr of update.transactions) {
      const target = { state: shadow, dispatch: (next) => { shadow = next.state } }
      if (tr.isUserEvent('undo')) { undo(target); continue }
      if (tr.isUserEvent('redo')) { redo(target); continue }
      const letter = actor === 'user' ? 'u' : 'p'
      const changes = []
      const links = actor === 'user' ? linksOf(tr.startState.doc.toString()) : []
      tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        changes.push({ from: fromA, to: toA, insert: inserted.toString().replace(/[^\n]/g, letter) })
        // The user deleted in or against a link of the slide.
        if (toA > fromA && links.some((link) => toA >= link.from - 1 && fromA <= link.to + 1)) silent = true
      })
      const annotations = []
      const userEvent = tr.annotation(Transaction.userEvent)
      if (userEvent) annotations.push(Transaction.userEvent.of(userEvent))
      if (tr.annotation(Transaction.addToHistory) === false) annotations.push(Transaction.addToHistory.of(false))
      const isolate = tr.annotation(isolateHistory)
      if (isolate) annotations.push(isolateHistory.of(isolate))
      shadow = shadow.update({ changes, selection: tr.selection ? tr.state.selection : undefined, annotations }).state
    }
  })

  /** The slide typed on: its lines' extent, its links, whether it carries a form. */
  const read = () => {
    const text = view.state.doc.toString()
    const from = text.indexOf('### One')
    const to = text.indexOf('### Two')
    const block = text.slice(from, to)
    const links = linksOf(text)
    return { text, from, to, links, formed: /\bform=/.test(block), formedElsewhere: /\bform=/.test(text.slice(0, from) + text.slice(to)) }
  }
  /** No edit of the user's that is still in effect touched this link. */
  const notTheUsers = (link) => !/u/.test(shadow.doc.sliceString(Math.max(0, link.from - 1), Math.min(shadow.doc.length, link.to + 1)))
  const agree = () => {
    const doc = view.state.doc.toString()
    const whose = shadow.doc.toString()
    if (doc.length !== whose.length) return 'the two states differ in length'
    for (let n = 0; n < doc.length; n += 1) if ((doc[n] === '\n') !== (whose[n] === '\n')) return `the two states differ in their line breaks at ${n}`
    if (!view.state.selection.eq(shadow.selection)) return 'the two states differ in their selection'
    if (undoDepth(view.state) !== undoDepth(shadow)) return 'the two states differ in their undo depth'
    return ''
  }
  const sourceLine = () => {
    const { from, to } = read()
    const doc = view.state.doc
    for (let n = doc.lineAt(from).number + 1; n <= doc.lines && doc.line(n).from < to; n += 1) if (/^\s*- Author/.test(doc.line(n).text)) return doc.line(n)
    return null
  }
  const asUser = (run) => { actor = 'user'; try { run() } finally { actor = 'program' } }
  const typeText = (text) => asUser(() => {
    for (const char of text) {
      const { from, to } = view.state.selection.main
      view.dispatch({ changes: { from, to, insert: char }, selection: EditorSelection.cursor(from + 1), userEvent: 'input.type' })
    }
  })
  const backspace = (count) => asUser(() => {
    for (let n = 0; n < count; n += 1) {
      const head = view.state.selection.main.head
      if (head <= view.state.doc.lineAt(head).from) return
      view.dispatch({ changes: { from: head - 1, to: head }, selection: EditorSelection.cursor(head - 1), userEvent: 'delete.backward' })
    }
  })
  let stamped = 0
  const OPS = {
    type: () => typeText(pick(['x', 'y', ' ', 'z'])),
    link: () => typeText(` ${random() < 0.8 ? ALICE : BOB}`),
    back: () => backspace(1 + Math.floor(random() * 3)),
    wipe: () => backspace(30),
    pIns: () => { const line = sourceLine(); if (line) view.dispatch({ changes: { from: line.to, insert: ` ${pick([ALICE, BOB])}` } }) },
    pDel: () => {
      const line = sourceLine()
      const found = line && [...line.text.matchAll(LINK)][0]
      if (!found) return
      const from = line.from + found.index
      view.dispatch({ changes: { from: line.text[found.index - 1] === ' ' ? from - 1 : from, to: from + found[0].length } })
    },
    pRep: () => {
      const line = sourceLine()
      const found = line && [...line.text.matchAll(LINK)][0]
      if (found) view.dispatch({ changes: { from: line.from + found.index, to: line.from + found.index + found[0].length, insert: found[0] === ALICE ? BOB : ALICE } })
    },
    pause: () => view.dispatch({ annotations: isolateHistory.of('full') }),
    undo: () => { undo(view) },
    redo: () => { redo(view) },
    // The Enter key, through the editor's own keymaps (the app's Enter commands first).
    enter: () => asUser(() => { view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true })) }),
    leave: () => view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(1).to), userEvent: 'select' }),
    clickSrc: () => { const line = sourceLine(); if (line) view.dispatch({ selection: EditorSelection.cursor(line.to), userEvent: 'select.pointer' }) },
    clickBelow: () => { const line = sourceLine(); if (line && line.number < view.state.doc.lines) view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(line.number + 1).to), userEvent: 'select.pointer' }) },
    // A save: the next heading with no id gets one, and the editor adopts the saved text (the app's own adoption).
    adopt: () => {
      const sent = view.state.doc.toString()
      const lines = sent.split('\n')
      const at = lines.findIndex((line, n) => /^#{2,3} /.test(line) && !(lines[n + 1] ?? '').includes('{id='))
      if (at < 0) return
      stamped += 1
      lines.splice(at + 1, 0, `{id=r${stamped}}`)
      adoptSavedText(view, sent, lines.join('\n'))
    }
  }
  const settled = async () => { await null; await null; await null }

  while (result.ops < total && !result.failure) {
    result.episodes += 1
    const start = talk(random() < 0.6, pick(['- Author', '- Author', `- Author ${ALICE}`, `- Author ${ALICE}`, '']))
    window.mount(start, 'none', config, [mirror])
    view = window.viewNow()
    shadow = EditorState.create({ doc: start.replace(/[^\n]/g, 'o'), selection: view.state.selection, extensions: [history(config)] })
    const trace = []
    silent = false
    const fail = (what) => { result.failure = { what, seed, episode: result.episodes, start, trace: trace.slice(-40), text: view.state.doc.toString(), whose: shadow.doc.toString() } }
    let last = 'leave'
    for (let n = 0; n < episodeOps && result.ops < total && !result.failure; n += 1) {
      const caret = view.state.selection.main.head
      const slide = read()
      let name = random() < 0.75 ? pick(AFTER[last]) : weighted()
      if ((caret < slide.from || caret >= slide.to) && random() < 0.7) name = 'clickSrc'
      const before = slide.formed
      const depth = undoDepth(view.state)
      OPS[name]()
      await settled()
      result.ops += 1
      result.deepest = Math.max(result.deepest, undoDepth(view.state))
      // The history lost steps (its oldest ones at its limit; a step a save's adoption left empty): an undo alone takes one.
      if (undoDepth(view.state) < depth - 1) result.dropped += 1
      trace.push(name)
      last = name
      const wrong = agree()
      if (wrong) { fail(`the oracle lost the editor: ${wrong}`); break }
      const now = read()
      if (now.formedElsewhere) { fail('a form outside the slide typed on'); break }
      if (!now.formed || before) continue
      // A form appeared.
      result.forms += 1
      if (now.links.length === 0) { fail('a form written with no link in the slide'); break }
      if (!silent) result.judged += 1
      if (!silent && now.links.every(notTheUsers)) { fail('a form written for a link that is not the user\'s'); break }
      // Undone step by step: it never stands without its link.
      for (let step = 0; step < 40 && undoDepth(view.state) > 0 && read().formed; step += 1) {
        undo(view)
        await settled()
        result.undone += 1
        trace.push('undo (after the form)')
        const then = read()
        if (then.formed && then.links.length === 0) { fail('the form stands without its link after an undo'); break }
      }
      break
    }
  }
  return result
}
