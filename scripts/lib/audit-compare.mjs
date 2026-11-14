// Compares the before and after measurements of one talk (scripts/audit-talks-look.mjs), state by state and, within a
// state, run by run, so a fault that grows on a slide that already had it is not hidden behind "already failing".
//
// States are matched within a slide by what the audience sees, by stable identities (pairingKey: reveal, emphasis and
// file units by tag and text, card, image, container state). An ambiguous identity (more or fewer after states than
// before states share it) stays unmatched. An after state with no match is "unmatched": it has no before to be
// compared with, so a fault there counts toward the gate. A card or slide Next never shows is shown directly
// (`direct`); such after states are diagnostics outside the gate, while such before states serve as the baseline when
// the after side reaches the card.
//
// Limits: clipping and overlap are compared by presence and key, so worse geometry of an element that already fails
// (it clips further) is not quantified; and drift below the tolerances can add up over several releases unnoticed.
//
// Per state and fault class the result is one of:
//   newly failing  the class fails after and passed before
//   worsened       it fails on both sides and the after side has a run or element the before side did not, or a run
//                  got lower in contrast (more than CONTRAST_TOLERANCE) or smaller (more than FLOOR_TOLERANCE_PX), an
//                  empty band grew (more than EMPTY_TOLERANCE), or more icons were drawn that the author did not name
//   unmatched      the after state has no before state and fails the class
//   improved       it failed before and passes after
//   unchanged      everything else (both pass, or both fail with nothing new or worse)
// Runs are paired by their key (`TAG|index|child|text`, as the floor keys), then by tag and text, then by text, so a
// run whose index moved because the markup changed is still the same run. Clipped and overlapping elements are paired
// by their key (`tag|text`) as a multiset.
export const FAULTS = ['clipping', 'contrast', 'unresolved', 'floor', 'empty', 'overlap', 'autoIcons']
export const CONTRAST_TOLERANCE = 0.1
export const FLOOR_TOLERANCE_PX = 0.5
export const EMPTY_TOLERANCE = 0.05
// single-idea slides (title, divider, statement, quote) leave space around one idea by design
const SPACIOUS = ['section-title', 'title', 'statement', 'quote', 'closing']

const band = (state) => state.emptyBand ?? state.emptyShare ?? 0
export function faultsOf(state) {
  return {
    clipping: state.clips?.length ? 1 : 0,
    contrast: state.contrast?.length ? 1 : 0,
    unresolved: state.unresolved?.length ? 1 : 0,
    floor: state.floor?.length ? 1 : 0,
    empty: band(state) > 0.35 && !SPACIOUS.includes(state.layout) ? 1 : 0,
    overlap: state.overlaps?.length ? 1 : 0,
    autoIcons: state.autoIcons ? 1 : 0,
  }
}

const loose = (key) => { const parts = String(key ?? '').split('|'); return parts.length >= 4 ? `${parts[0]}|${parts.slice(3).join('|')}` : String(key ?? '') }
/** Pairs after runs with before runs: by key, then tag and text, then text. Returns [{ after, before | null }]. */
export function pairRuns(after = [], before = []) {
  const left = before.map((run) => ({ run, used: false }))
  const pairs = after.map((run) => ({ after: run, before: null }))
  for (const ways of [(r) => r.key ?? r.text, (r) => loose(r.key ?? r.text), (r) => r.text]) {
    for (const pair of pairs) {
      if (pair.before) continue
      const want = ways(pair.after)
      const hit = left.find((b) => !b.used && ways(b.run) === want)
      if (hit) { hit.used = true; pair.before = hit.run }
    }
  }
  return pairs
}

// A drawn diagram's generated element id (Mermaid's `#mmd-<random>`) differs on every build, and the key is cut at a
// fixed length, so everything from the id on is dropped: it is not part of the element's identity.
const stableKey = (key) => String(key).replace(/mmd-[a-z0-9].*$/is, 'mmd')
/** Keys in `after` that `before` does not have as often (a multiset difference, ignoring generated ids). */
export function newKeys(after = [], before = []) {
  const left = new Map()
  for (const key of before) left.set(stableKey(key), (left.get(stableKey(key)) ?? 0) + 1)
  const out = []
  for (const key of after) {
    const n = left.get(stableKey(key)) ?? 0
    if (n > 0) left.set(stableKey(key), n - 1)
    else out.push(key)
  }
  return out
}

/** What makes the after state worse than the before state in one class (both failing): a list of short reasons. */
export function worsening(k, a, b) {
  switch (k) {
    case 'clipping': return newKeys(a.clips, b.clips).map((key) => `new clip ${key}`)
    case 'overlap': return newKeys(a.overlaps, b.overlaps).map((key) => `new overlap ${key}`)
    case 'contrast': return pairRuns(a.contrast, b.contrast).flatMap(({ after, before }) => !before ? [`new run "${after.text}" ${after.ratio}:1`]
      : after.ratio < before.ratio - CONTRAST_TOLERANCE ? [`"${after.text}" ${before.ratio}:1 to ${after.ratio}:1`] : [])
    case 'floor': return pairRuns(a.floor, b.floor).flatMap(({ after, before }) => !before ? [`new run "${after.text}" ${after.px}px`]
      : after.px < before.px - FLOOR_TOLERANCE_PX ? [`"${after.text}" ${before.px}px to ${after.px}px`] : [])
    case 'unresolved': return pairRuns(a.unresolved, b.unresolved).filter(({ before }) => !before).map(({ after }) => `new run "${after.text}"`)
    case 'empty': return band(a) > band(b) + EMPTY_TOLERANCE ? [`empty band ${Math.round(band(b) * 100)}% to ${Math.round(band(a) * 100)}%`] : []
    case 'autoIcons': return (a.autoIcons ?? 0) > (b.autoIcons ?? 0) ? [`unnamed icons ${b.autoIcons ?? 0} to ${a.autoIcons}`] : []
    default: return []
  }
}

/** What fails in one class, for the report (short). */
export function detailOf(k, st) {
  switch (k) {
    case 'clipping': return (st.clips || []).slice(0, 2).join('; ')
    case 'overlap': return (st.overlaps || []).slice(0, 2).join('; ')
    case 'contrast': return (st.contrast || []).slice(0, 2).map((r) => `"${r.text}" ${r.ratio}:1`).join('; ')
    case 'floor': return (st.floor || []).slice(0, 2).map((r) => `"${r.text}" ${r.px}px`).join('; ')
    case 'unresolved': return (st.unresolved || []).slice(0, 2).map((r) => `"${r.text}"`).join('; ')
    case 'empty': return `empty band ${Math.round(band(st) * 100)}%`
    case 'autoIcons': return `${st.autoIcons} unnamed icons`
    default: return ''
  }
}

/**
 * The pairing identity of a state within its slide: what the audience sees, by stable identities. Reveal, emphasis and
 * file units count by their tag and text, restricted to the units both builds have on this slide (`common`), so text
 * made into an extra reveal unit does not change the identity of the other states; the active card, the open image
 * and the container overlay's state (its text and the tiles marked now, next, done, ...) count as they are. A record
 * without identities falls back to its positional `visual` signature.
 */
export function pairingKey(st, common) {
  if (!st.ident) return st.visual ?? null
  const keep = (list, kind) => (list || []).filter(([key]) => common[kind].has(key))
  return JSON.stringify([keep(st.ident.units, 'units'), keep(st.ident.emphasis, 'emphasis'), keep(st.ident.media, 'media'), st.ident.cards, st.ident.image, st.ident.container])
}
function commonUnits(beforeList, afterList) {
  const keys = (list, kind) => new Set(list.flatMap((st) => (st.ident?.[kind] || []).map(([key]) => key)))
  return Object.fromEntries(['units', 'emphasis', 'media'].map((kind) => {
    const b = keys(beforeList, kind)
    return [kind, new Set([...keys(afterList, kind)].filter((key) => b.has(key)))]
  }))
}

/**
 * Pairs the after states of a talk with its before states. Returns { pairs: [{ after, before | null }], gone: [before
 * states with no after], stepCountChanged: [slide ids] }. Failed measurements (`error`) are left out on both sides.
 *
 * Within a slide, states are grouped by their pairing identity (pairingKey). A group with as many after states as
 * before states is paired in order; a group whose counts differ is ambiguous and stays unmatched (so a fault there
 * counts toward the gate instead of inheriting a failing baseline). Before states measured directly (a card or slide
 * that side's Next skipped) are in the pool, so they are the baseline when the after side reaches that card.
 */
export function matchStates(beforeStates = [], afterStates = []) {
  const bySlide = (list) => {
    const map = new Map()
    for (const st of list) { if (st.error) continue; if (!map.has(st.id)) map.set(st.id, []); map.get(st.id).push(st) }
    return map
  }
  const before = bySlide(beforeStates)
  const after = bySlide(afterStates)
  const pairs = []
  const gone = []
  const stepCountChanged = []
  for (const [id, list] of after) {
    const beforeList = before.get(id) || []
    const common = commonUnits(beforeList, list)
    const walkedBefore = beforeList.filter((st) => !st.direct)
    const walked = list.filter((st) => !st.direct)
    if (walkedBefore.length && walked.length !== walkedBefore.length) stepCountChanged.push(id)
    const used = new Set()
    const pairIn = (afterGroup) => {
      const groups = new Map()
      for (const st of afterGroup) {
        const key = pairingKey(st, common)
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key).push(st)
      }
      for (const [key, sts] of groups) {
        const candidates = key == null ? [] : beforeList.filter((b) => !used.has(b) && pairingKey(b, common) === key)
        const unique = candidates.length === sts.length
        sts.forEach((st, i) => {
          const hit = unique ? candidates[i] : null
          if (hit) used.add(hit)
          pairs.push({ after: st, before: hit })
        })
      }
    }
    pairIn(walked)
    pairIn(list.filter((st) => st.direct))
    gone.push(...walkedBefore.filter((st) => !used.has(st)))
  }
  for (const [id, list] of before) if (!after.has(id)) gone.push(...list.filter((st) => !st.direct))
  // keep the after side's order
  const order = new Map(afterStates.map((st, i) => [st, i]))
  pairs.sort((x, y) => order.get(x.after) - order.get(y.after))
  return { pairs, gone, stepCountChanged }
}

/** The class outcome of one matched pair: 'newly' | 'worsened' | 'unmatched' | 'improved' | 'unchanged' | 'clean'. */
export function outcome(k, a, b) {
  const fa = faultsOf(a)[k]
  if (!b) return fa ? 'unmatched' : 'clean'
  const fb = faultsOf(b)[k]
  if (fa && !fb) return 'newly'
  if (!fa && fb) return 'improved'
  if (!fa) return 'clean'
  return worsening(k, a, b).length ? 'worsened' : 'unchanged'
}

/**
 * The comparison for one talk. `before` and `after` are the sides of its record ({ states, coverage }). Returns
 * { counts: { [class]: { newly, worsened, unmatched, improved, unchanged } }, cases: [{ class, outcome, after, before,
 * why }], skippedCards: { newly, unchanged, improved, cases }, stepCountChanged, gone, unmatchedStates, cleanUnmatched }.
 * `unchanged` counts states that fail the class on both sides with nothing new or worse; states clean on both sides
 * are not counted.
 */
export function compareTalk(before = {}, after = {}) {
  const { pairs, gone, stepCountChanged } = matchStates(before.states, after.states)
  const blank = () => Object.fromEntries(FAULTS.map((k) => [k, { newly: 0, worsened: 0, unmatched: 0, improved: 0, unchanged: 0 }]))
  const counts = blank()
  // An after state measured directly (a card or slide this side's Next never shows) is diagnostic: its card is gated
  // as unreachable (skippedCards), not through the ordinary classes.
  const directCounts = blank()
  const cases = []
  const directCases = []
  let unmatchedStates = 0
  let cleanUnmatched = 0
  for (const { after: a, before: b } of pairs) {
    if (!b && !a.direct) { unmatchedStates += 1; if (!FAULTS.some((k) => faultsOf(a)[k])) cleanUnmatched += 1 }
    for (const k of FAULTS) {
      const o = outcome(k, a, b)
      if (o === 'clean') continue
      ;(a.direct ? directCounts : counts)[k][o] += 1
      const why = o === 'worsened' ? worsening(k, a, b) : o === 'improved' ? [detailOf(k, b)] : [detailOf(k, a)]
      if (o !== 'unchanged') (a.direct ? directCases : cases).push({ class: k, outcome: o, after: a, before: b, why })
    }
  }
  // Cards (and slides, card null) Next never shows, a fault of the deck, compared by slide and card
  const cardKey = (c) => `${c.id}|${c.card}`
  const was = new Set((before.coverage?.neverShown || []).map(cardKey))
  const now = new Set((after.coverage?.neverShown || []).map(cardKey))
  const skippedCards = { newly: 0, unchanged: 0, improved: 0, cases: [] }
  for (const c of after.coverage?.neverShown || []) {
    if (was.has(cardKey(c))) skippedCards.unchanged += 1
    else { skippedCards.newly += 1; skippedCards.cases.push({ outcome: 'newly', ...c }) }
  }
  for (const c of before.coverage?.neverShown || []) if (!now.has(cardKey(c))) { skippedCards.improved += 1; skippedCards.cases.push({ outcome: 'improved', ...c }) }
  return { counts, cases, directCounts, directCases, skippedCards, stepCountChanged, gone: gone.length, unmatchedStates, cleanUnmatched }
}

/** The acceptance gate: per class, walked states newly failing, worsened or unmatched with a fault; plus cards and slides
 *  Next newly never shows. Directly shown states are not in it (directCounts). */
export function gateOf(result) {
  return FAULTS.reduce((sum, k) => sum + result.counts[k].newly + result.counts[k].worsened + result.counts[k].unmatched, 0) + result.skippedCards.newly
}
