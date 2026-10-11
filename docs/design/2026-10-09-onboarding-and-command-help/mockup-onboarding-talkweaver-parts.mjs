// Drawing parts for the TalkWeaver onboarding mockup: window, sidebar with vault sections, outline editor,
// slide strip, Guide pieces, overlays and the presenter. Each returns an HTML string.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TEXT, TASKS, ICONS, HISTORY, HOW, HOW_STATE, DELIGHT, DELIGHT_READ, CONNECTS, MAP, EX_TALKS, CHAPTER_TALK, cmdsOf, isLive, TOPIC_OPEN } from './mockup-onboarding-talkweaver-text.mjs'

export const REPO = process.env.TW_REPO || join(process.env.HOME, 'gitrepos/06_apps-utilities/01_desktop-apps/talk-weaver')

// ── icons: real lucide path data from the repo's lucide-react ──
const iconCache = new Map()
function iconNodes(name) {
  if (iconCache.has(name)) return iconCache.get(name)
  const dir = join(REPO, 'node_modules/lucide-react/dist/esm/icons')
  let src = readFileSync(join(dir, name + '.mjs'), 'utf8')
  const alias = src.match(/export \{ default \} from '\.\/([\w-]+)\.mjs'/)
  if (alias) src = readFileSync(join(dir, alias[1] + '.mjs'), 'utf8')
  const m = src.match(/const __iconNode = (\[[\s\S]*?\]);\nconst /)
  if (!m) throw new Error('icon has no nodes: ' + name)
  const nodes = JSON.parse(m[1].replace(/([{,]\s*)([A-Za-z][\w-]*)\s*:/g, '$1"$2":')) // data literal, never evaluated
  const out = nodes.map(([tag, a]) => `<${tag} ${Object.entries(a).filter(([k]) => k !== 'key').map(([k, v]) => `${k}="${v}"`).join(' ')}/>`).join('')
  iconCache.set(name, out)
  return out
}
export const ic = (name, cls = 'i') => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconNodes(name)}</svg>`

export const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
export const fmt = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '<kbd class="k">$1</kbd>')
const kbd = (c) => `<kbd class="k">${esc(c)}</kbd>`
const chordOf = (r) => (r.chord === '—' ? '' : r.chord)
const shortChord = (c) => { const p = c.split(/ \/ | /); return p.length > 2 ? p.slice(0, 2).join(' ') + ` +${p.length - 2}` : c }
const pick = (task, label) => cmdsOf(task).find((r) => r.label === label || r.label.startsWith(label))

// ── vault badges ──
const VAULTS = {
  own: { name: 'Personal', letter: 'P', c: '#c2410c', sub: ['lock', 'Git · private'], talks: [['Metaphor talk 2026', 18, true], ['Slides that scale', 22]], archive: 5 },
  ex: { name: 'Example vault', letter: 'E', c: '#0f766e', sub: ['graduation-cap', 'Removable · local folder'], talks: EX_TALKS.map(([n, c]) => [n, c]), example: true },
}
const badge = (v, cls = '') => `<span class="vb ${cls}" style="--c:${v.c}">${v.letter}</span>`

function vaultSection(v, o = {}) {
  const rows = v.talks.map(([n, c, mark]) => `<div class="tl-row${o.sel === n ? ' sel' : ''}"><span class="nm">${esc(n)}</span><span class="cnt">${c}</span></div>`).join('')
  return `<div class="vsec" style="--c:${v.c}"><div class="vh${o.menu ? ' menu-on' : ''}"><span class="chev">▾</span>${badge(v)}<div class="two"><div class="l1"><span class="nm">${esc(v.name)}</span></div>
    <div class="l2">${ic(v.sub[0], 'i s10')}<span>${esc(v.sub[1])}</span></div></div>${v.example ? `<span class="svc ex">${TEXT.exampleMark}</span>` : ''}<span class="more${o.menu ? ' on' : ''}">${ic('ellipsis')}</span></div>
    <div class="vbody"><div class="tl-fhead"><span class="tw">▾</span>Talks<span class="c">${v.talks.length}</span></div>${rows}${v.archive ? `<div class="tl-fhead"><span class="tw">▸</span>Archive<span class="c">${v.archive}</span></div>` : ''}</div></div>`
}

const modebar = (labels, on) => `<div class="modebar">${labels.map((l, i) => `<button class="${i === on ? 'on' : ''}">${l}</button>`).join('')}<span class="collapse">${ic('chevron-left')}</span></div>`
const keyHints = `<div class="keyhints">${[['↑↓', 'navigate'], ['←→', 'fold'], ['↵', 'open'], ['⌘↑', 'up'], ['v', 'view'], ['n', 'names'], ['/', 'search'], ['F2', 'rename'], ['⌘K', 'menu']].map(([k, l]) => `<span>${kbd(k)}${l}</span>`).join('')}</div>`

export function talksPanel({ vaults, recent, sel, menuOn }, btn = '') {
  return `<div class="tl-toolbar"><span class="tl-label">${ic('list', 'i s12')} Talks</span><span class="tl-tb">${ic('file-plus')}</span><span class="tl-tb">${ic('folder-plus')}</span><span class="tl-tb">${ic('arrow-up-down')}</span><span class="tl-tb">${ic('refresh-cw')}</span></div>
  <div class="tl-search">${ic('search', 'i s12')}<span>Filter talks…</span><kbd class="k">/</kbd></div>
  <div class="tl-recent"><div class="tl-recent-head"><span class="tw">▾</span>Recent<span class="n">${recent.length}</span></div>${recent.map(([n, v]) => `<div class="tl-recent-row">${badge(v, 'sm')}<span class="nm">${esc(n)}</span></div>`).join('')}</div>
  <div class="tl-scroll">${vaults.map((v) => vaultSection(v, { sel, menu: menuOn === v })).join('')}</div>
  <div class="addrow">${ic('plus')} Add vault…${btn}</div>${keyHints}`
}

export function sidebar({ talks, guide = 'off', width }) {
  // guide: 'off' = button shown, Guide closed; 'on' = button shown, Guide open in the right column; 'none' = button switched off in Settings
  const btn = guide === 'none' ? '' : `<div class="guidebtn${guide === 'on' ? ' on' : ''}">${ic('graduation-cap', 'i s13')}${TEXT.guideBtn}${guide === 'on' ? '<small>open</small>' : ''}</div>`
  return `<div class="sb" style="width:${width || 284}px">${modebar(['Talks', 'Slide outline'], 0)}${talksPanel(talks, btn)}</div>`
}
export const VAULT = VAULTS

// ── outline editor ──
function blanks(lines) {
  const out = []
  lines.forEach((l, i) => {
    out.push({ l, src: i })
    const nx = lines[i + 1]
    if (!nx) return
    const t = l[0], n = nx[0]
    if ((t === 'h3' && n === 'chip') || (t === 'chip' && n === 'chip') || (t === 'li' && n === 'li')) return
    out.push({ blank: true })
  })
  return out
}
const lineHtml = ([t, s]) => ({
  h2: `<span class="mk">## </span>${esc(s)}`, h3: `<span class="mk">### </span>${esc(s)}`, chip: `<span class="tchip">${esc(s)}</span>`,
  p: esc(s).replace(/`(.+?)`/g, '<kbd class="k">$1</kbd>'), li: `<span class="mk">- </span>${esc(s)}`, q: `<span class="mk">&gt; </span>${fmt(s)}`,
}[t])

export function editor(lines, { meta = true, caret, cur, status = '', startNo = 6, metaTitle = TEXT.talk, metaSub = 'A demo talk to practise on' } = {}) {
  let no = startNo
  const rows = [{ blank: true }, ...blanks(lines)].map((r) => {
    const n = no++
    if (r.blank) return `<div class="row"><span class="n">${n}</span><span class="t"></span></div>`
    const [t] = r.l
    const mine = r.src === caret, curr = r.src === cur
    return `<div class="row ${t}${curr ? ' cur' : ''}"><span class="n">${n}</span><span class="t">${lineHtml(r.l)}${mine ? '<i class="caret"></i>' : ''}</span></div>`
  }).join('')
  const metaCard = meta ? `<div class="meta"><div class="meta-h">Metadata<span class="raw">${ic('chevron-right', 'i s10')} raw</span></div>
    ${[['Title', metaTitle], ['Subtitle / event', metaSub], ['outline_version', '2']].map(([k, v]) => `<div class="mrow"><span>${k}</span><span class="mf">${esc(v)}</span></div>`).join('')}</div>` : ''
  return `<div class="editor"><div class="ed-scroll">${metaCard}${rows}</div>${status}</div>`
}

export function statusBar({ chip = true, slides = 22, words = 214, flash = '' } = {}) {
  return `<div class="status">${chip ? `<span class="place">${ic('map-pin', 'i s11')}${TEXT.chip.slide} · ${TEXT.chip.count} actions ${kbd('⌘K')}</span>` : ''}<span>v0.38.0</span><span class="sep">|</span><span>${slides} slides</span><span class="sep">|</span><span>${words} words</span>${flash ? `<span class="flash-note">${esc(flash)}</span>` : ''}</div>`
}

// ── slides (the ADR-0005 skin) ──
export function slide(kind, title, body = []) {
  if (kind === 'statement') return `<div class="slide stm"><div class="s-left"><b>${esc(title)}</b></div><div class="s-right">${body.map(esc).join('<br>')}</div></div>`
  if (kind === 'quote') return `<div class="slide ql"><div class="in"><div class="k">TRY IT</div><h4>${esc(title)}</h4><p>${body.map(fmt).join('<br>')}</p></div></div>`
  return `<div class="slide ls"><div class="in"><div class="k">SECTION</div><h4>${esc(title)}</h4><ul>${body.map((b) => `<li>${esc(b)}</li>`).join('')}</ul></div></div>`
}
const EX_CARDS = [['01', 'Start here', 'statement', ['This talk is the example. Each section teaches one task.']], ['02', 'Four stalls', 'list', ['Bread and cakes', 'Vegetables', 'Plants']], ['03', 'Opening hours', 'statement', ['Saturdays, eight until one.']]]
const OWN_CARDS = [['02', 'Why metaphors matter', 'statement', ['We think with them before we notice.']], ['03', 'Three kinds', 'list', ['Orientation', 'Structure', 'Ontology']], ['04', 'What to try', 'statement', ['Pick one and follow it for a week.']]]
export function strip({ active = 1, own = false } = {}) {
  const cards = own ? OWN_CARDS : EX_CARDS
  return `<div class="strip"><div class="strip-h">${own ? 18 : 22} slides <span class="okc">✓</span></div><div class="strip-sec"><span>▾ ${own ? 'Opening' : 'Writing'}</span><span>3</span></div>${cards.map(([n, t, k, b], i) => `<div class="card${i === active ? ' act' : ''}">${slide(k, t, b)}<div class="cap"><span class="no">${n}</span>${esc(t)}<span class="lay">${k === 'list' ? 'list' : 'statement'}</span></div></div>`).join('')}</div>`
}
export const rtabs = (labels, on) => `<div class="rtabs">${labels.map((l, i) => `<button class="${i === on ? 'on' : ''}">${l}${l === 'Guide' ? ' <span class="tx">×</span>' : ''}</button>`).join('')}</div>`

// ── Guide pieces ──
const seg = (i) => `<div class="seg">${TEXT.segments.map((s, k) => `<button class="${k === i ? 'on' : ''}">${s}</button>`).join('')}</div>`
const card = (bar, right, body) => `<div class="gcard"><div class="gcard-h"><b>${bar}</b><span>${right || ''}</span></div>${body}</div>`
const count = (t) => cmdsOf(t).length
const statusOf = (t, fresh) => {
  const h = fresh ? {} : HISTORY[t]
  if (h.finished) return `<span class="st ok">${ic('check', 'i s12')}${TEXT.status.finished}</span>`
  if (h.tried) return `<span class="st tr"><i class="mini"><u style="width:${Math.round(h.tried / count(t) * 100)}%"></u></i>${TEXT.status.tried(h.tried, count(t))}</span>`
  if (h.opened) return `<span class="st">${TEXT.status.opened}</span>`
  return `<span class="st dim">${TEXT.status.none}</span>`
}
export function chaptersCard({ startHere = false, rightText, fresh = false } = {}) {
  const rows = TASKS.map((t, i) => `<div class="crow${startHere && i === 0 ? ' hl' : ''}"><span class="cic">${ic(ICONS[t], 'i s15')}</span><span class="nm">${t}</span>${startHere && i === 0 ? `<span class="pill">${TEXT.startHere}</span>` : ''}${statusOf(t, fresh)}${ic('chevron-right', 'i s12 chv')}</div>`).join('')
  return card(TEXT.chaptersBar, rightText ?? '1 of 10 finished', rows)
}
export function stepsCard({ done = [] } = {}) {
  const rows = TEXT.steps.rows.map((r, i) => `<div class="srow ${done.includes(i) ? 'done' : ''}"><span class="tick">${done.includes(i) ? ic('check', 'i s11') : ''}</span><span class="nm">${r.label}</span>${done.includes(i) ? `<span class="st dim">${r.done}</span>` : `<span class="gbtn">${r.action}</span>`}</div>`).join('')
  return card(TEXT.steps.bar, `${done.length} of 3`, rows)
}
export const removeLink = `<div class="rm-wrap"><span class="rm">${ic('trash-2', 'i s12')}${TEXT.removeExample}</span></div>`
export const guide = (i, body) => `<div class="guide">${seg(i)}<div class="g-scr">${body}</div></div>`

export const WRITE_TRIED = ['Bold', 'Italic', 'Highlight', 'Fold all sections', 'New slide', 'Promote heading']
export function chapterDetail({ task = 'Write the outline', tried = WRITE_TRIED, open = [], flash, away = false, dark = false, exclude = isLive, note, remaining, here = false } = {}) {
  const [pt, ps] = CHAPTER_TALK[task]
  const all = cmdsOf(task).filter((r) => !(exclude && exclude(r)))
  const n = all.length, d = all.filter((r) => tried.includes(r.label)).length
  const groups = [...new Set(all.map((r) => r.subgroup))]
  const gh = groups.map((g) => {
    const rs = all.filter((r) => r.subgroup === g), gd = rs.filter((r) => tried.includes(r.label)).length, isOpen = open.includes(g)
    const body = isOpen ? rs.map((r) => {
      const on = tried.includes(r.label), c = chordOf(r)
      return `<div class="vrow${on ? ' ticked' : ''}${flash === r.label ? ' flash' : ''}"><span class="tick">${on ? ic('check', 'i s11') : ''}</span><span class="nm">${esc(r.label.replace(/ \(.*/, ''))}</span>${c ? kbd(shortChord(c)) : '<span class="nokey">no key</span>'}</div>`
    }).join('') : ''
    return `<div class="cg"><div class="cg-h"><span class="tw">${isOpen ? '▾' : '▸'}</span><b>${g.replace(' (added)', '')}</b><span class="gd">${gd} of ${rs.length}</span></div>${body}</div>`
  }).join('')
  return `<div class="cd-top"><span class="back">${ic('chevron-left', 'i s12')} ${dark ? 'Chapters' : 'All chapters'}</span></div>
    <div class="cd-title"><span class="cic big">${ic(ICONS[task], 'i s18')}</span><div><b>${task}</b><small>${TEXT.status.tried(d, n)}</small></div></div>
    <div class="bar"><u style="width:${Math.round(d / n * 100)}%"></u></div>
    <div class="gnote"><b>${TEXT.practiceTalk}:</b> ${esc(pt)}${here ? ' (' + TEXT.openNow + ')' : ''}, section “${esc(ps)}”.${note ? ' ' + note : ''}</div>${away ? `<div class="gbtn wide">${ic('external-link', 'i s12')} ${TEXT.openInExample}</div>` : ''}
    <div class="gcard"><div class="gcard-h"><b>${TEXT.thisChapter}</b><span>${d} of ${n}</span></div>${gh}</div>${remaining || ''}`
}

export function topicList(items, states, bar, right) {
  const rows = items.map(([t], i) => `<div class="trow"><span class="no">${i + 1}</span><span class="nm">${esc(t)}</span><span class="st${states[i] === 'read' ? ' ok2' : ' dim'}">${states[i] === 'read' ? ic('check', 'i s11') + 'Read' : TEXT.status.none}</span></div>`).join('')
  return card(bar, right, rows)
}
export function pictureHeadings() {
  return `<div class="pic"><div class="p-ed"><div><span class="mk">### </span>Four stalls</div><div><span class="tchip">{statement}</span></div><div class="dimt">Bread, veg, plants, books</div></div><div class="p-arrow">${ic('arrow-right', 'i s18')}</div>${slide('statement', 'Four stalls', ['Bread, veg, plants, books'])}</div>`
}
export function topicDetail() {
  const [title] = HOW[TOPIC_OPEN.index]
  return `<div class="td-nav"><span class="back">${ic('chevron-left', 'i s12')} ${TEXT.segments[1]}</span><span class="pos">3 of 9</span><span class="arrows"><i>${ic('chevron-left', 'i s12')}</i><i>${ic('chevron-right', 'i s12')}</i></span></div>
    <h3 class="td-h">${esc(title)}</h3>${TOPIC_OPEN.sentences.map((s) => `<p class="td-p">${fmt(s)}</p>`).join('')}${pictureHeadings()}
    <div class="tryit"><span class="gbtn pri">${ic('play-circle', 'i s13')} ${TEXT.tryIt}</span><span class="try-d"><b>${TOPIC_OPEN.tryChord}.</b> ${fmt(TOPIC_OPEN.tryDoes)}</span></div>`
}
export function delightList(section) {
  const secs = DELIGHT.map(([name, rows], si) => {
    let n = DELIGHT.slice(0, si).reduce((a, [, r]) => a + r.filter((x) => x[0] !== 'sub').length, 0)
    const body = rows.map(([t, r]) => t === 'sub' ? `<div class="subh">${r}</div>` : `<div class="trow"><span class="no">${++n}</span><span class="nm">${esc(t)}</span>${DELIGHT_READ.has(t) ? `<span class="st ok2">${ic('check', 'i s11')}Read</span>` : `<span class="st dim hint">${esc(r)}</span>`}</div>`).join('')
    return `<div class="gcard"><div class="gcard-h"><b>${si + 1}. ${name}</b></div>${body}</div>`
  })
  return secs.slice(0, 3).map((x, i) => x.replace('class="gcard"', `class="gcard" id="sec${i + 1}"`)).join('') + `<span id="sec4"></span>` + connects()
}
export function connects() {
  const rows = CONNECTS.map((c) => `<div class="conn ${c.tone}"><span class="cic">${ic(c.icon, 'i s15')}</span><div class="cb"><div class="l1"><b>${esc(c.name)}</b><span class="cstate ${c.tone}">${esc(c.state)}</span></div><small>${esc(c.need)}</small><small class="wo">Without it: ${esc(c.without)}.</small></div>${c.action ? `<span class="gbtn${c.tone === 'wait' ? ' off' : ''}">${esc(c.action)}</span>` : ''}</div>`).join('')
  return `<div class="gcard"><div class="gcard-h"><b>4. How you connect, and what each needs</b></div><div class="g-lead">${TEXT.connectsBar}. States are read from this Mac.</div>${rows}</div>`
}

// ── window ──
const lights = '<div class="lights"><i></i><i></i><i></i></div>'
function toolbar({ title = TEXT.talk, v, panes = 1, present = true }) {
  const pt = [['text-align-start'], ['columns-2'], ['list'], ['layout-grid']].map(([i], k) => `<i class="${k === panes ? 'on' : ''}">${ic(i)}</i>`).join('')
  return `<div class="ws-toolbar"><div class="ws-title">${v ? badge(v, 'sm') : ''}${esc(title)}</div><div class="pane-toggle">${pt}</div>
    <div class="tb-actions"><span class="tbtn">${ic('share')}Share${ic('chevron-down', 'i s11')}</span><span class="tbtn">${ic('plus')}Insert${ic('chevron-down', 'i s11')}</span><span class="tbtn">${ic('sliders-horizontal')}Deck${ic('chevron-down', 'i s11')}</span><span class="tbtn">${ic('wrench')}Tools${ic('chevron-down', 'i s11')}</span><span class="tbtn primary">${ic('presentation')}Present${ic('chevron-down', 'i s11')}</span></div></div>`
}
export function app({ side, title, v, ed, right, overlay = '', toast = '', panes = 1 }) {
  return `<div class="win">${lights}<div class="app">${side}<div class="ws">${toolbar({ title, v, panes })}<div class="panes">${ed}<div class="rcol">${right}</div></div></div></div>${toast}${overlay}</div>`
}
export function firstLaunch() {
  const f = TEXT.firstLaunch
  return `<div class="win">${lights}<div class="vault-setup"><div class="vs-card"><div class="vs-logo">TalkWeaver</div><h1>${f.h1}</h1><p>${fmt(f.p)}</p><span class="btn-primary">${f.btn}</span><p class="hint">${fmt(f.hint)}</p>
    <div class="vs-or"><span>${f.or}</span></div>
    <div class="vs-ex">${badge(VAULTS.ex, 'xl')}<div class="vs-ex-t"><b>${f.exTitle}<span class="svc ex">${TEXT.exampleMark}</span></b><span>${f.exSub}</span><small>${f.exPath}</small></div><span class="btn-sec">${f.exBtn}</span></div></div></div></div>`
}

// ── overlays ──
export const scrim = '<div class="scrim"></div>'
export function menu({ left, top }) {
  const items = TEXT.menu.map((m, i) => `<div class="mi">${ic(['pencil', 'eye', 'folder-open', 'x'][i])}${m}</div>`).join('')
  return `<div class="menu" style="left:${left}px;top:${top}px">${items}<div class="msep"></div><div class="mi danger hl">${ic('trash-2')}${TEXT.menuRemove}</div></div>`
}
export function confirmSheet() {
  const c = TEXT.confirm
  const list = (bar, items, tone) => `<div class="cf-g ${tone}"><div class="cf-h">${bar}</div>${items.map((i) => `<div class="cf-i">${Array.isArray(i) ? `<b>${esc(i[0])}</b><span>${esc(i[1])}</span>` : esc(i)}</div>`).join('')}</div>`
  return `${scrim}<div class="sheet cf"><div class="cf-top">${badge(VAULTS.ex, 'lg')}<div><h2>${c.title}</h2><p>${c.lead}</p></div></div>
    ${list(c.binBar, c.bin, 'bin')}${list(c.offBar, c.off.map((x) => x), 'off')}${list(c.keptBar, c.kept, 'kept')}
    <div class="cf-foot"><span class="bigbtn plain">${c.cancel}</span><span class="bigbtn danger">${c.ok}</span></div></div>`
}
const HERE_ROWS = [['Write the outline', ['Promote heading', 'Demote heading', 'Move slide or item up', 'Move slide or item down', 'Delete current slide', 'Make heading at same level', 'Make subheading']],
  ['Build a slide', ['Layout…', 'Image…', 'Icon…', 'Inspector mode']], ['Reuse slides', ['Slide: where used & versions', 'Tag current slide…']], ['See the talk', ['Focus on this slide']]]
const hereRows = () => HERE_ROWS.map(([t, ls]) => [t, ls.map((l) => { const r = pick(t, l); return [r.label.replace(/ \(.*/, ''), chordOf(r)] })])
export function actionsPanel({ filter = '', none = false } = {}) {
  const a = TEXT.actions
  const body = none ? `<div class="ak-none">${a.none(filter)}</div>` : hereRows().map(([t, rs]) => `<div class="ak-g">${t}</div>${rs.map(([l, c]) => `<div class="ak-r"><span>${esc(l)}</span>${c ? kbd(c) : ''}</div>`).join('')}`).join('')
  return `<div class="ak" style="width:400px"><div class="ak-f">${ic('search', 'i s12')}<span class="${filter ? 'typed' : ''}">${filter || a.filter}</span><em>${none ? '0' : TEXT.chip.count}</em></div><div class="ak-b">${body}</div>
    <div class="ak-all${none ? ' hl' : ''}">${a.all}${none ? `<small>Return opens the palette with “${esc(filter)}” kept</small>` : ''}<kbd class="k">${a.allChord}</kbd></div></div>`
}
export function kbdSheet() {
  const s = TEXT.sheet
  const left = `<div class="ks-l"><div class="ks-i on">${ic('map-pin', 'i s13')}${s.here}<em>${TEXT.chip.count}</em></div><div class="ks-sep"></div>${TASKS.map((t) => `<div class="ks-i">${ic(ICONS[t], 'i s13')}${t}<em>${count(t)}</em></div>`).join('')}</div>`
  const right = `<div class="ks-r"><div class="ks-rh">${s.here}</div>${hereRows().map(([t, rs]) => `<div class="ak-g">${t}</div>${rs.map(([l, c]) => `<div class="ak-r"><span>${esc(l)}</span>${c ? kbd(c) : ''}</div>`).join('')}`).join('')}</div>`
  return `${scrim}<div class="sheet ks"><div class="ks-top"><b>${s.title}</b><div class="ks-f">${ic('search', 'i s12')}${s.filter}</div><span class="x">${ic('x', 'i s14')}</span></div><div class="ks-body">${left}${right}</div></div>`
}
export function settingsSheet({ btnOn = true } = {}) {
  const t = TEXT.settings
  return `${scrim}<div class="sheet set"><div class="set-top"><b>${t.title}</b><div class="ks-f">${ic('search', 'i s12')}Search settings</div><span class="x">${ic('x', 'i s14')}</span></div>
    <div class="set-body"><div class="set-h">${t.section}</div>
    <div class="set-r"><div><b>Get started</b><small>${t.note}</small></div><span class="bigbtn plain">${t.b1}</span><span class="bigbtn plain">${t.b2}</span></div>
    <div class="set-r"><div><b>${t.switchT}</b><small>${t.switchS}</small></div><span class="toggle${btnOn ? '' : ' off'}"></span></div>
    <div class="set-r"><div><b>Show where I am in the status bar</b><small>The place chip: “On a slide heading · 14 actions ⌘K”.</small></div><span class="toggle"></span></div>
    <div class="set-h">Folders</div><div class="set-r dim"><div><b>Vaults</b><small>Personal · ~/Documents/talks</small></div></div></div></div>`
}
export function palette() {
  const p = TEXT.palette
  const rows = p.rows.map(([l], i) => `<div class="pl-r${i === 0 ? ' hl' : ''}"><span>${esc(l)}</span><span class="grp">Set up TalkWeaver</span></div>`).join('')
  return `<div class="palette"><div class="pl-in">${ic('search', 'i s13')}<span>${p.filter}</span></div><div class="pl-l">${rows}</div></div>`
}

// ── presenter (dark; own window; drawn from presenter-popup-single-html.html) ──
export function presenter({ tried, open }) {
  const guideCol = `<div class="pguide"><div class="pd-h"><b>${ic('graduation-cap', 'i s14')} Guide</b><span class="x">${ic('x', 'i s14')}</span></div><div class="pd-s">${chapterDetail({ task: 'Present', tried, open, dark: true, flash: 'Outline', here: true, remaining: `<div class="live-note">${ic('radio', 'i s13')}<span><b>${cmdsOf('Present').filter(isLive).length} live commands</b> are listed apart: going live, polls, questions, boards, venue screen. They are practised after the live service is set up.</span></div>` })}</div></div>`
  const stage = slide('quote', 'Move through the talk', ['Open the presenter with `F5`.', '**Try it.** Press `→` for the next slide, `←` to go back, and the letter **O** for the outline.'])
  return `<div class="win pres">${lights}<div class="p-root"><div class="p-top"><span class="p-title">Lightning round</span><span class="p-clock">04:12</span><span class="p-slide">Slide <b>3</b> / 8</span>
    <span class="p-guide">${ic('graduation-cap', 'i s13')} Guide · Present <b>13 of 43</b> ${kbd('C')}</span><span class="p-geo">Window widened by 400 px: Next and Notes keep their width</span><span class="p-sp"></span><span class="p-menu">${ic('radio', 'i s13')} Live ${ic('chevron-down', 'i s11')}</span><span class="p-menu">${ic('monitor', 'i s13')} Poll ${ic('chevron-down', 'i s11')}</span><span class="p-menu">${ic('layout-template', 'i s13')} View ${ic('chevron-down', 'i s11')}</span></div>
    <div class="p-main"><div class="p-stage">${stage}</div><div class="p-side"><div class="p-pan"><b>NEXT</b> · next slide<div class="p-th">${slide('statement', 'Thank you', ['Questions, then coffee.'])}</div></div><div class="p-pan"><b>NOTES</b><p>Open the presenter, step through, then show the outline.</p></div></div>${guideCol}</div>
    <div class="p-bot"><span class="pb">${ic('list-tree', 'i s13')} Outline</span><span class="p-sp"></span><span class="pb">${ic('chevron-left', 'i s13')} Previous</span><span class="pb blue">Next ${ic('arrow-right', 'i s13')}</span><span class="pb">${ic('chevron-right', 'i s13')}</span><span class="pb">${ic('sparkles', 'i s13')} Instant slide</span><span class="pb">${ic('eye', 'i s13')} Focus</span><span class="pb">${ic('pencil', 'i s13')} Highlight</span><span class="pb">${ic('ellipsis', 'i s13')}</span></div></div></div>`
}
