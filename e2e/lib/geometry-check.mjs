// Small-window geometry check (consistency review, house rule R17): see
// docs/design/2026-11-05-consistency-review/geometry/README.md for what each check means.
//
// geometryInPage() runs inside a renderer page and only reads the DOM (it never changes it, so it cannot change the
// layout it is measuring). runGeometry() calls it and adds the window's viewport. writeGeometryReport() turns the
// per-state results into geometry-report.json and summary.md and works out the geometry score.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Runs in the page. Must stay self-contained (no imports, no closures over module state). */
export function geometryInPage(opts) {
  const VW = window.innerWidth
  const VH = window.innerHeight
  const violations = []
  const metrics = {}
  const seen = new Set()
  const csCache = new Map()
  const cs = (el) => { let s = csCache.get(el); if (!s) { s = getComputedStyle(el); csCache.set(el, s) } return s }
  const r1 = (n) => Math.round(n * 10) / 10
  const boxOf = (r) => ({ x: r1(r.left), y: r1(r.top), w: r1(r.width), h: r1(r.height) })

  const CHROME_TOOLBAR = '.toolbar-btn, .toolbar-actions button, .workspace-toolbar button'
  const BAR_SEL = ['.status-bar', '.workspace-toolbar', '.toolbar-actions', '.tw-editor-tabs', '[role=tablist]', '[role=toolbar]', '[class*=hintbar]', '[class*=viewtabs]', '.tl-foot', '.tl-keybar', '.pane-tabs-body'].join(',')
  const STATUS_SEL = '.status-bar'
  const INTERACTIVE = 'button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=tab], [role=menuitem], [role=option], [tabindex]:not([tabindex="-1"])'
  const OVERLAY = '[role=dialog], [role=alertdialog], [aria-modal=true], [role=menu], [role=listbox], [role=tooltip], [class*=modal], [class*=popover], [class*=flyout], [class*=backdrop], [class*=scrim], [class*=popup], [class*=toolbar-menu], [class*=command-menu], [class*=palette]'
  const PANE = '[class*=pane], [class*=sidebar], [class*=panel], aside, main, [class*=drawer], [class*=workspace], header, footer, [role=dialog], [class*=modal]'

  function isBottomStrip(e) { if (e.tagName !== 'DIV') return false; const r = e.getBoundingClientRect(); return r.height >= 18 && r.height <= 40 && r.bottom >= VH - 1 && r.width >= 0.5 * VW && getComputedStyle(e).display === 'flex' }
  const visible = (el) => {
    if (!(el instanceof Element)) return false
    if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }
  /** The element's box clipped by every ancestor that clips (overflow other than visible); null when nothing is left. */
  const clipped = (el) => {
    const r = el.getBoundingClientRect()
    let l = r.left, t = r.top, rr = r.right, b = r.bottom
    for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
      const s = cs(p)
      if (s.position === 'fixed' && p !== el.parentElement) { /* still clips its own children */ }
      const ox = s.overflowX !== 'visible'
      const oy = s.overflowY !== 'visible'
      if (!ox && !oy) continue
      const pr = p.getBoundingClientRect()
      if (ox) { l = Math.max(l, pr.left); rr = Math.min(rr, pr.right) }
      if (oy) { t = Math.max(t, pr.top); b = Math.min(b, pr.bottom) }
      if (rr <= l || b <= t) return null
    }
    return { left: l, top: t, right: rr, bottom: b, width: rr - l, height: b - t }
  }
  const textOf = (el) => (el.getAttribute?.('aria-label') || el.innerText || el.textContent || el.getAttribute?.('title') || el.getAttribute?.('placeholder') || '').replace(/\s+/g, ' ').trim().slice(0, 60)
  const selOf = (el) => {
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.') : ''
    return `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}${!cls && isBottomStrip(el) ? '[status-bar]' : ''}`
  }
  const add = (type, severity, el, detail, rect) => {
    const selector = el ? selOf(el) : (opts.windowLabel ?? 'window')
    const text = el ? textOf(el) : ''
    const box = rect ? boxOf(rect) : el ? boxOf(el.getBoundingClientRect()) : { x: 0, y: 0, w: VW, h: VH }
    const key = `${type}|${selector}|${text}|${box.x},${box.y},${box.w},${box.h}`
    if (seen.has(key)) return
    seen.add(key)
    violations.push({ type, severity, selector, text, box, detail })
  }
  const inToolbarButton = (el) => !!el.closest(CHROME_TOOLBAR)
  const inRow = (el) => !!el.closest('li, [role=option], [role=row], [role=listitem], [class*=row], [class*=-item], [class*=card], [class*=entry]')

  // ---- all visible elements, once ------------------------------------------------------------------------------
  const all = [...document.body.querySelectorAll('*')].filter((e) => !['SCRIPT', 'STYLE', 'LINK', 'META', 'SVG', 'PATH'].includes(e.tagName.toUpperCase()) && !e.closest('svg'))
  // Only what can actually be seen: not hidden, not scrolled out of its clipping ancestors, and inside the viewport.
  const inView = (e) => { const c = clipped(e); return !!c && c.right > 0 && c.bottom > 0 && c.left < VW && c.top < VH }
  const vis = all.filter((e) => visible(e) && inView(e))

  // ---- h-overflow -------------------------------------------------------------------------------------------------
  const de = document.documentElement
  if (de.scrollWidth > de.clientWidth + 1) add('h-overflow', 'major', de, `document scrollWidth ${de.scrollWidth} > clientWidth ${de.clientWidth}`)
  if (document.body.scrollWidth > document.body.clientWidth + 1 && document.body.scrollWidth > de.clientWidth + 1) add('h-overflow', 'major', document.body, `body scrollWidth ${document.body.scrollWidth} > clientWidth ${document.body.clientWidth}`)
  for (const el of vis) {
    if (!el.matches(PANE) || el.closest('.cm-editor')) continue
    const s = cs(el)
    if (s.overflowX === 'auto' || s.overflowX === 'scroll') continue
    if (el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1) {
      const by = el.scrollWidth - el.clientWidth
      add('h-overflow', s.overflowX === 'hidden' && by > 8 ? 'major' : 'moderate', el, `scrollWidth ${el.scrollWidth} > clientWidth ${el.clientWidth} (overflow-x ${s.overflowX})`)
    }
  }

  // ---- clipped-text --------------------------------------------------------------------------------------------------
  for (const el of vis) {
    if (el.closest('.cm-editor')) continue
    let hasText = false
    for (const n of el.childNodes) if (n.nodeType === 3 && n.nodeValue.trim()) { hasText = true; break }
    if (!hasText) continue
    const r = el.getBoundingClientRect()
    if (r.width <= 2 || r.height <= 2) continue
    const s = cs(el)
    const isTitle = !!el.closest('.workspace-title')
    const severityFor = (ellipsis) => (isTitle || inToolbarButton(el)) ? 'major' : (ellipsis && inRow(el)) ? 'minor' : ellipsis ? 'moderate' : 'moderate'
    const hiddenX = s.overflowX === 'hidden' || s.overflowX === 'clip'
    const hiddenY = s.overflowY === 'hidden' || s.overflowY === 'clip'
    if (s.display !== 'inline' && hiddenX && el.scrollWidth > el.clientWidth + 1) {
      add('clipped-text', severityFor(s.textOverflow === 'ellipsis'), el, `scrollWidth ${el.scrollWidth} > clientWidth ${el.clientWidth}${s.textOverflow === 'ellipsis' ? ' (ellipsis)' : ' (cut)'}`)
      continue
    }
    if (s.display !== 'inline' && hiddenY && el.scrollHeight > el.clientHeight + 2 && el.clientHeight > 0) {
      add('clipped-text', severityFor(false), el, `scrollHeight ${el.scrollHeight} > clientHeight ${el.clientHeight} (cut, vertical)`)
      continue
    }
    // cut by an ancestor that hides horizontal overflow
    if (s.position === 'fixed') continue
    for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
      const ps = cs(p)
      if (ps.overflowX !== 'hidden' && ps.overflowX !== 'clip') continue
      const pr = p.getBoundingClientRect()
      const beyond = Math.max(r.right - pr.right, pr.left - r.left)
      if (r.right > pr.left && r.left < pr.right && beyond > 2) { add('clipped-text', severityFor(false), el, `cut by ancestor ${selOf(p)}: ${r1(beyond)} px beyond its edge`); break }
    }
  }

  // ---- title-visible-chars ---------------------------------------------------------------------------------------------
  for (const el of document.querySelectorAll('.workspace-title')) {
    const full0 = (el.textContent ?? '').trim()
    const shownBox = el.getBoundingClientRect()
    const c0 = visible(el) ? clipped(el) : null
    if (full0 && full0 !== 'TalkWeaver' && (!c0 || c0.width < 8 || shownBox.right <= 0 || shownBox.left >= VW)) {
      metrics.title = { text: full0.slice(0, 80), chars: full0.length, visible: 0, width: 0 }
      add('title-visible-chars', 'major', el, `0 of ${full0.length} characters visible (title is squeezed out or clipped away)`)
      continue
    }
    if (!visible(el)) continue
    const full = (el.textContent ?? '').trim()
    if (!full || full === 'TalkWeaver') continue
    const node = [...el.childNodes].find((n) => n.nodeType === 3)
    let shown = full.length
    if (node && el.scrollWidth > el.clientWidth + 1) {
      const er = el.getBoundingClientRect()
      const range = document.createRange()
      let lo = 0, hi = node.nodeValue.length
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2)
        range.setStart(node, 0); range.setEnd(node, mid)
        if (range.getBoundingClientRect().right <= er.right + 0.5) lo = mid; else hi = mid - 1
      }
      // the ellipsis takes roughly one character's room
      shown = Math.max(0, lo - 1)
    }
    metrics.title = { text: full.slice(0, 80), chars: full.length, visible: shown, width: r1(el.clientWidth) }
    if (shown < 24 && shown < full.length) add('title-visible-chars', 'major', el, `${shown} of ${full.length} characters visible (under 24)`)
    else if (shown < full.length) add('title-visible-chars', 'major', el, `${shown} of ${full.length} characters visible`)
  }

  // ---- wrap -------------------------------------------------------------------------------------------------------------
  const lineCount = (textNode) => {
    const range = document.createRange()
    range.selectNodeContents(textNode)
    const tops = []
    for (const rc of range.getClientRects()) { if (rc.width < 1 || rc.height < 1) continue; if (!tops.some((t) => Math.abs(t - rc.top) < rc.height * 0.5)) tops.push(rc.top) }
    return tops.length
  }
  // The main window's status bar has no class (inline styles): it is the full-width strip, 18..40 px tall, at the window's bottom edge.
  const bars = vis.filter((e) => (e.matches(BAR_SEL) || isBottomStrip(e)) && !e.closest('.cm-editor'))
  const barSet = new Set(bars)
  const wrapChecked = new Set()
  for (const bar of bars) {
    const isStatus = bar.matches(STATUS_SEL) || isBottomStrip(bar)
    const barStyle = cs(bar)
    const lh = parseFloat(barStyle.lineHeight) || parseFloat(barStyle.fontSize) * 1.25
    const walker = document.createTreeWalker(bar, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.nodeValue.trim()) continue
      const host = n.parentElement
      if (!host || !visible(host) || wrapChecked.has(n)) continue
      wrapChecked.add(n)
      const lines = lineCount(n)
      if (lines > 1) {
        add('wrap', 'major', host, `text runs over ${lines} lines inside ${selOf(bar)}`)
        const hr = host.getBoundingClientRect(), br = bar.getBoundingClientRect()
        const outside = Math.max(br.top - hr.top, hr.bottom - br.bottom)
        if (outside > 2) add('overlap', 'major', host, `wrapped item spills ${r1(outside)} px out of ${selOf(bar)} over the content next to it`, hr)
      }
    }
    for (const child of bar.children) {
      if (!visible(child)) continue
      const cr = child.getBoundingClientRect()
      const cl = parseFloat(cs(child).lineHeight) || lh
      if (isStatus && cr.height > 1.5 * lh && cr.height > 1.5 * cl) add('wrap', 'major', child, `status item is ${r1(cr.height)} px tall, bar line height ${r1(lh)} px`)
      const br = bar.getBoundingClientRect()
      if (cr.bottom > br.bottom + 2 || cr.top < br.top - 2) add('overlap', 'major', child, `item spills out of ${selOf(bar)} (item ${r1(cr.top)}..${r1(cr.bottom)}, bar ${r1(br.top)}..${r1(br.bottom)})`)
    }
  }
  for (const el of vis) {
    if (!el.matches('button, [role=tab], [role=button], .workspace-title') || wrapChecked.size > 20000) continue
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.nodeValue.trim() || wrapChecked.has(n)) continue
      wrapChecked.add(n)
      if (el.closest('.cm-editor')) continue
      const lines = lineCount(n)
      if (lines > 1) add('wrap', inToolbarButton(el) ? 'major' : 'moderate', el, `label runs over ${lines} lines`)
    }
  }

  // ---- overlap --------------------------------------------------------------------------------------------------------------
  const overlayOf = (el) => el.closest(OVERLAY)
  const candidates = []
  for (const el of vis) {
    if (el.closest('.cm-editor') || el.closest('svg')) continue
    const s = cs(el)
    const r = el.getBoundingClientRect()
    if (r.width < 6 || r.height < 6) continue
    const interactive = el.matches(INTERACTIVE) && el.querySelectorAll(INTERACTIVE).length < 3
    const floating = (s.position === 'fixed' || s.position === 'absolute') && r.width >= 12 && r.height >= 12 && r.width * r.height < 0.15 * VW * VH && ((el.innerText ?? '').trim().length > 0 || !!el.querySelector(INTERACTIVE) || interactive)
    const hint = /hint|keybar/.test(typeof el.className === 'string' ? el.className : '') && (el.innerText ?? '').trim().length > 0
    const card = el.matches('.tw-slide-card, [data-slide-index]')
    const statusItem = el.parentElement && barSet.has(el.parentElement) && (el.parentElement.matches(STATUS_SEL) || isBottomStrip(el.parentElement))
    if (!(interactive || floating || hint || card || statusItem)) continue
    const c = clipped(el)
    if (!c || c.width < 4 || c.height < 4) continue
    candidates.push({ el, c, interactive, floating, hint, card, statusItem, ov: overlayOf(el) })
  }
  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      const a = candidates[i], b = candidates[j]
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue
      if ((a.ov && !b.ov) || (!a.ov && b.ov)) continue
      if (a.ov && b.ov && a.ov !== b.ov) continue
      // a pair of in-flow controls never overlaps by design; one of the two must be floating, a hint strip, a card, or both interactive
      const bothInteractive = a.interactive && b.interactive
      if (!(bothInteractive || a.floating || b.floating || a.hint || b.hint || (a.statusItem && b.statusItem) || ((a.card || b.card) && (a.floating || b.floating)))) continue
      const ix = Math.min(a.c.right, b.c.right) - Math.max(a.c.left, b.c.left)
      const iy = Math.min(a.c.bottom, b.c.bottom) - Math.max(a.c.top, b.c.top)
      if (ix <= 4 || iy <= 4) continue
      // skip pairs where the top-most element at the centre of the intersection is neither (something else covers both)
      const cx = Math.max(a.c.left, b.c.left) + ix / 2, cy = Math.max(a.c.top, b.c.top) + iy / 2
      const top = document.elementFromPoint(cx, cy)
      if (top && !(a.el.contains(top) || b.el.contains(top) || top.contains(a.el) || top.contains(b.el))) continue
      const merged = { left: Math.max(a.c.left, b.c.left), top: Math.max(a.c.top, b.c.top), width: ix, height: iy }
      add('overlap', 'major', a.el, `overlaps ${selOf(b.el)} "${textOf(b.el).slice(0, 30)}" by ${r1(ix)} x ${r1(iy)} px`, merged)
    }
  }

  // ---- offscreen-control ------------------------------------------------------------------------------------------------
  for (const el of vis) {
    if (!el.matches(INTERACTIVE) || el.closest('.cm-editor')) continue
    const r = el.getBoundingClientRect()
    if (r.width < 4 || r.height < 4) continue
    const partly = r.left < -1 || r.top < -1 || r.right > VW + 1 || r.bottom > VH + 1
    const wholly = r.right <= 0 || r.bottom <= 0 || r.left >= VW || r.top >= VH
    if (!partly || wholly) continue
    const c = clipped(el)
    if (!c) continue
    if (c.left < -1 || c.top < -1 || c.right > VW + 1 || c.bottom > VH + 1) add('offscreen-control', 'major', el, `box ${r1(r.left)},${r1(r.top)} to ${r1(r.right)},${r1(r.bottom)} leaves the ${VW} x ${VH} viewport`)
  }

  // ---- chrome-rows, content-share, sidebar-share (main workspace only) -------------------------------------------------
  const editors = [...document.querySelectorAll('.cm-editor')].filter(visible)
  const editor = editors.sort((a, b) => b.getBoundingClientRect().width * b.getBoundingClientRect().height - a.getBoundingClientRect().width * a.getBoundingClientRect().height)[0]
  if (editor && document.querySelector('.workspace-toolbar')) {
    const scroller = editor.querySelector('.cm-scroller') ?? editor
    const y0 = scroller.getBoundingClientRect().top
    const found = []
    for (let node = editor; node && node !== document.body; node = node.parentElement) {
      for (let sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) {
        if (!visible(sib)) continue
        const sr = sib.getBoundingClientRect()
        const ss = cs(sib)
        if (ss.position === 'absolute' || ss.position === 'fixed') continue
        if (sr.height < 10 || sr.bottom > y0 + 2 || sr.width < 0.3 * VW) continue
        found.push({ selector: selOf(sib), text: textOf(sib).slice(0, 40), top: r1(sr.top), height: r1(sr.height) })
      }
    }
    const total = found.reduce((n, f) => n + f.height, 0)
    metrics.chrome = { bars: found.length, totalHeight: r1(total), firstLineY: r1(y0), list: found.sort((a, b) => a.top - b.top) }
    if (found.length > 2) add('chrome-rows', 'major', editor, `${found.length} bars above the editor, ${r1(total)} px: ${found.map((f) => `${f.selector} ${f.height}px`).join(', ')}`, { left: 0, top: Math.min(...found.map((f) => f.top)), width: VW, height: total })
    const er = editor.getBoundingClientRect()
    const strip = [...document.querySelectorAll('.pane--strip, .pane--strip-rail')].filter(visible)[0]
    const sw = strip ? strip.getBoundingClientRect().width : 0
    const share = (er.width + sw) / VW
    metrics.contentShare = { editor: r1(er.width), strip: r1(sw), share: Math.round(share * 1000) / 1000 }
    if (share < 0.55) add('content-share', 'major', editor, `editor ${r1(er.width)} + preview ${r1(sw)} px = ${Math.round(share * 100)}% of ${VW} px`)
    const side = [...document.querySelectorAll('aside.talk-list, aside[class*=talk-list], [class*=sidebar]')].filter(visible)[0]
    if (side) {
      const w = side.getBoundingClientRect().width
      metrics.sidebar = { width: r1(w), share: Math.round((w / VW) * 1000) / 1000 }
      if (w / VW > 0.3) add('sidebar-share', 'major', side, `sidebar ${r1(w)} px = ${Math.round((w / VW) * 100)}% of ${VW} px`)
    } else metrics.sidebar = null
  }

  return { viewport: { innerWidth: VW, innerHeight: VH }, metrics, violations }
}

export async function runGeometry(page, windowLabel) {
  const result = await page.evaluate(geometryInPage, { windowLabel })
  return result
}

// ---- report -----------------------------------------------------------------------------------------------------------
const TYPE_ORDER = ['title-visible-chars', 'overlap', 'wrap', 'chrome-rows', 'sidebar-share', 'content-share', 'offscreen-control', 'h-overflow', 'clipped-text']
const SEVERITIES = ['major', 'moderate', 'minor']

export function scoreOf(states) {
  const keys = new Set()
  for (const s of states) {
    if (!s.base) continue
    for (const v of s.violations ?? []) if (v.severity === 'major') keys.add(`${s.state}|${v.type}|${v.selector}|${v.text}`)
  }
  return keys.size
}

export function writeGeometryReport(out, report) {
  const states = report.states
  const score = scoreOf(states)
  report.geometry_score = score
  writeFileSync(join(out, 'geometry-report.json'), JSON.stringify(report, null, 2))

  const all = states.flatMap((s) => (s.violations ?? []).map((v) => ({ ...v, state: s.state, base: s.base, screenshot: s.screenshot })))
  const tally = (list) => {
    const m = {}
    for (const v of list) { m[v.type] = m[v.type] ?? { major: 0, moderate: 0, minor: 0 }; m[v.type][v.severity] += 1 }
    return m
  }
  const table = (title, list) => {
    const m = tally(list)
    const rows = TYPE_ORDER.filter((t) => m[t]).concat(Object.keys(m).filter((t) => !TYPE_ORDER.includes(t)))
    const lines = [`### ${title}`, '', '| Type | Major | Moderate | Minor |', '|---|---|---|---|']
    for (const t of rows) lines.push(`| ${t} | ${m[t].major} | ${m[t].moderate} | ${m[t].minor} |`)
    const tot = SEVERITIES.map((sv) => list.filter((v) => v.severity === sv).length)
    lines.push(`| **total** | ${tot[0]} | ${tot[1]} | ${tot[2]} |`, '')
    return lines
  }
  const baseStates = states.filter((s) => s.base)
  const L = []
  L.push('---', `title: "TalkWeaver geometry check: ${report.size}"`, `date: ${String(report.generated).slice(0, 10)}`, 'phase: geometry', '---', '')
  L.push(`# Geometry check at ${report.size}`, '')
  L.push(`**Geometry score: ${score}** (major violations across the ${baseStates.length} base states; lower is better; R17 is met at 0).`, '')
  L.push(`Generated ${report.generated}. App ${report.app_version ?? 'unknown'}. Requested content size ${report.size}; the pages reported ${report.viewport_report}.`, '')
  if (report.viewport_mismatches?.length) L.push(`Viewport mismatches: ${report.viewport_mismatches.join('; ')}`, '')
  L.push('## Counts', '')
  L.push(...table('Base states only (the score)', all.filter((v) => v.base)))
  L.push(...table('Everything checked (base states and tour surfaces)', all))
  L.push('## Base states', '', '| State | Measured | Major | Moderate | Minor | Screenshot |', '|---|---|---|---|---|---|')
  for (const s of baseStates) {
    const c = SEVERITIES.map((sv) => (s.violations ?? []).filter((v) => v.severity === sv).length)
    L.push(`| ${s.state} | ${s.status === 'opened' ? 'yes' : s.status + (s.reason ? ': ' + s.reason.slice(0, 60) : '')} | ${c[0]} | ${c[1]} | ${c[2]} | ${s.screenshot ? `[shot](${s.screenshot})` : '-'} |`)
  }
  L.push('')
  const rank = (v) => [SEVERITIES.indexOf(v.severity), v.base ? 0 : 1, TYPE_ORDER.indexOf(v.type) < 0 ? 99 : TYPE_ORDER.indexOf(v.type)]
  const worst = [...all].sort((a, b) => { const ra = rank(a), rb = rank(b); for (let i = 0; i < 3; i += 1) if (ra[i] !== rb[i]) return ra[i] - rb[i]; return 0 }).slice(0, 20)
  L.push('## Worst 20 violations', '', 'Major first, base states before tour surfaces, then in the order of the type list. Only base states have screenshots.', '', '| # | State | Type | Severity | Element | Box (x,y,w,h) | Detail | Screenshot |', '|---|---|---|---|---|---|---|---|')
  worst.forEach((v, i) => L.push(`| ${i + 1} | ${v.state} | ${v.type} | ${v.severity} | \`${v.selector}\`${v.text ? ' "' + v.text.replace(/\|/g, '/').slice(0, 30) + '"' : ''} | ${v.box.x},${v.box.y},${v.box.w},${v.box.h} | ${String(v.detail).replace(/\|/g, '/').slice(0, 110)} | ${v.screenshot ? `[shot](${v.screenshot})` : '-'} |`))
  L.push('')
  const unmeasured = states.filter((s) => s.status !== 'opened')
  L.push(`## Not measured (${unmeasured.length})`, '')
  if (!unmeasured.length) L.push('Every listed state opened and was measured.', '')
  else { L.push('| State | Status | Reason |', '|---|---|---|'); for (const s of unmeasured) L.push(`| ${s.state}${s.base ? ' (base)' : ''} | ${s.status} | ${(s.reason ?? '').replace(/\|/g, '/').slice(0, 120)} |`); L.push('') }
  writeFileSync(join(out, 'summary.md'), L.join('\n'))
  return score
}
