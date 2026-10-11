// The numbered states. Each entry returns the window's HTML. Captions live in the text module (STATES).
import { TEXT, PRACTICE, HOW, HOW_STATE } from './mockup-onboarding-talkweaver-text.mjs'
import * as P from './mockup-onboarding-talkweaver-parts.mjs'

const { VAULT: V } = P
const GUIDE_TABS = ['Guide', 'Slides', 'Inspector']
const OWN_LINES = [['h2', 'Opening'], ['h3', 'Why metaphors matter'], ['chip', '{id=s1}'], ['p', 'We think with them before we notice.'],
  ['h3', 'Three kinds'], ['chip', '{id=s2}'], ['li', 'Orientation'], ['li', 'Structure'], ['li', 'Ontology'],
  ['h2', 'Close'], ['h3', 'What to try'], ['chip', '{id=s3}'], ['p', 'Pick one metaphor and follow it for a week.']]
const NEXT_STUB = [['h2', '02 Build a slide'], ['h3', 'Choose a layout'], ['chip', '{id=s5}'], ['p', 'Press `⌘L` to see this slide in each layout.']]
const exLines = (extra = []) => [...PRACTICE.start, ...extra]

const exTalks = (vaults, sel, recent) => ({ vaults, sel, recent })
const exampleOnly = (guide = 'on') => P.sidebar({ guide, talks: exTalks([V.ex], TEXT.talk, [[TEXT.talk, V.ex]]) })
const both = (o = {}) => P.sidebar({ guide: o.guide || 'on', talks: { vaults: [V.own, V.ex], sel: o.sel || 'Metaphor talk 2026', recent: [['Metaphor talk 2026', V.own], [TEXT.talk, V.ex]], menuOn: o.menuOn } })
const ownOnly = (guide = 'off') => P.sidebar({ guide, talks: { vaults: [V.own], sel: 'Metaphor talk 2026', recent: [['Metaphor talk 2026', V.own], ['Slides that scale', V.own]] } })

const exEd = (lines, o = {}) => P.editor(lines, { meta: false, status: P.statusBar(), ...o })
const ownEd = (o = {}) => P.editor(OWN_LINES, { metaTitle: 'Metaphor talk 2026', metaSub: 'For a reading group', status: P.statusBar({ slides: 18, words: 163 }), caret: 1, cur: 1, ...o })
const rightGuide = (inner, i = 0) => P.rtabs(GUIDE_TABS, 0) + P.guide(i, inner)

const firstSteps = (done) => P.stepsCard({ done }) + P.chaptersCard({ startHere: true, rightText: '0 of 10 finished', fresh: true }) + P.removeLink
const tick7 = [...P.WRITE_TRIED, 'Move slide or item down']
const OPEN_WRITE = ['Headings and levels', 'Reorder slides and items']

export const STATE_HTML = {
  '01': () => P.firstLaunch(),
  '02': () => P.app({ side: exampleOnly(), title: TEXT.talk, v: V.ex, ed: P.editor(exLines(PRACTICE.write(false)), { caret: 1, cur: 1, status: P.statusBar() }), right: rightGuide(firstSteps([2])) }),
  '03': () => P.app({ side: both(), title: 'Metaphor talk 2026', v: V.own, ed: ownEd(), right: rightGuide(P.stepsCard({ done: [0, 1] }) + P.chaptersCard({ startHere: true, rightText: '0 of 10 finished', fresh: true }) + P.removeLink) }),
  '17': () => P.app({ side: both({ menuOn: V.ex }), title: 'Metaphor talk 2026', v: V.own, ed: ownEd(), right: rightGuide(P.stepsCard({ done: [0, 1] }) + P.chaptersCard({ startHere: true, rightText: '0 of 10 finished', fresh: true }) + P.removeLink), overlay: P.menu({ left: 150, top: 424 }) }),
  '04': () => P.app({ side: both({ sel: TEXT.talk }), title: TEXT.talk, v: V.ex, ed: exEd(exLines(PRACTICE.write(false)), { caret: 1, cur: 1 }), right: rightGuide(P.chaptersCard() + P.removeLink) }),
  '05': () => P.app({ side: both({ sel: TEXT.talk }), title: TEXT.talk, v: V.ex, ed: P.editor([...PRACTICE.write(false), ...NEXT_STUB], { meta: false, startNo: 33, caret: 1, cur: 1, status: P.statusBar() }), right: rightGuide(P.chapterDetail({ open: OPEN_WRITE, here: true })) }),
  '06': () => P.app({ side: both({ sel: TEXT.talk }), title: TEXT.talk, v: V.ex, ed: P.editor([...PRACTICE.write(true), ...NEXT_STUB], { meta: false, startNo: 33, caret: 4, cur: 4, status: P.statusBar() }),
    right: rightGuide(P.chapterDetail({ open: OPEN_WRITE, tried: tick7, flash: 'Move slide or item down', here: true })),
    toast: `<div class="toast">${P.ic('check', 'i s13')}Ticked · Move slide or item down <kbd class="k">⌘⇧↓</kbd></div>` }),
  '07': () => P.presenter({ tried: ['Presenter view', 'Presentation window', 'Launch audience', 'Next', 'Previous', 'First slide', 'Last slide', 'Outline', 'Start or pause timer', 'Set duration', 'Reveal mode', 'Focus mode', 'Highlight'], open: ['Move through slides'] }),
  '08': () => P.app({ side: both({ sel: TEXT.talk }), title: TEXT.talk, v: V.ex, ed: exEd(exLines(PRACTICE.write(false)), { caret: 1, cur: 1 }), right: rightGuide(P.topicList(HOW, HOW_STATE, 'How it works', '2 of 9 read'), 1) }),
  '09': () => P.app({ side: both({ sel: TEXT.talk }), title: TEXT.talk, v: V.ex, ed: exEd(exLines(PRACTICE.write(false)), { caret: 1, cur: 1 }), right: rightGuide(P.topicDetail(), 1) }),
  '10': () => P.app({ side: both({ sel: TEXT.talk }), title: TEXT.talk, v: V.ex, ed: exEd(exLines(PRACTICE.write(false)), { caret: 1, cur: 1 }), right: rightGuide(P.delightList(), 2) }),
  '18': () => P.app({ side: both({ sel: TEXT.talk }), title: TEXT.talk, v: V.ex, ed: exEd(exLines(PRACTICE.write(false)), { caret: 1, cur: 1 }), right: rightGuide(P.delightList(), 2).replace('class="g-scr"', 'class="g-scr" data-scroll-to="#sec3" data-scroll-pad="6"') }),
  '11': () => P.app({ side: both({ sel: TEXT.talk }), title: TEXT.talk, v: V.ex, ed: exEd(exLines(PRACTICE.write(false)), { caret: 1, cur: 1 }), right: rightGuide(P.delightList(), 2).replace('class="g-scr"', 'class="g-scr" data-scroll-end="1"') }),
  '12': () => P.app({ side: ownOnly(), title: 'Metaphor talk 2026', v: V.own, ed: ownEd(), right: P.strip({ active: 0, own: true }), overlay: P.actionsPanel() }),
  '13': () => P.app({ side: ownOnly(), title: 'Metaphor talk 2026', v: V.own, ed: ownEd(), right: P.strip({ active: 0, own: true }), overlay: P.actionsPanel({ filter: 'publish', none: true }) }),
  '14': () => P.app({ side: ownOnly(), title: 'Metaphor talk 2026', v: V.own, ed: ownEd(), right: P.strip({ active: 0, own: true }), overlay: P.kbdSheet() }),
  '15': () => P.app({ side: both({ menuOn: V.ex }), title: 'Metaphor talk 2026', v: V.own, ed: ownEd(), right: rightGuide(P.chaptersCard() + P.removeLink), overlay: P.confirmSheet() }),
  '16': () => P.app({ side: ownOnly(), title: 'Metaphor talk 2026', v: V.own, ed: ownEd({ status: P.statusBar({ slides: 18, words: 163, chip: true }) }), right: P.strip({ active: 0, own: true }), overlay: P.settingsSheet(),
    toast: `<div class="toast wide">${P.ic('check', 'i s13')}${TEXT.removedFlash}</div>` }),
  '19': () => P.app({ side: ownOnly('none'), title: 'Metaphor talk 2026', v: V.own, ed: ownEd(), right: P.strip({ active: 0, own: true }), overlay: P.settingsSheet({ btnOn: false }),
    toast: `<div class="toast wide">${P.ic('check', 'i s13')}${TEXT.guideOffFlash}</div>` }),
  '16b': () => P.app({ side: ownOnly(), title: 'Metaphor talk 2026', v: V.own, ed: ownEd(), right: P.strip({ active: 0, own: true }), overlay: P.scrim + P.palette() }),
}
