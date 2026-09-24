// T29: the shared talk-facts store (`src/renderer/src/lib/talkFacts.ts`) against a stubbed
// window.tw. Covers: two subscribers → ONE fetch; an onTalkMetaUpdated ping reaches both
// subscribers with the fresh meta (one extra fetch, not one per subscriber); concurrent
// reloads share one fetch; lastDelivered ignores rehearsal/recording sessions; and the
// status-bar dates label (`Created … · Edited … · Delivered never`).
let fail = 0
const check = (condition, message) => {
  if (!condition) {
    console.error('FAIL:', message)
    fail += 1
  }
}
const equal = (actual, expected, message) =>
  check(JSON.stringify(actual) === JSON.stringify(expected), `${message} — got ${JSON.stringify(actual)}`)

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const DAY = 86_400_000
const now = Date.now()

// ── stub window.tw BEFORE importing the module under test ──
globalThis.window = globalThis
let metaCalls = 0
let sessionCalls = 0
let handoutCalls = 0
let onMetaUpdated = null
let currentMeta = {
  'talk-alpha': { slideCount: 3, createdMs: now - 40 * DAY, editedMs: now - 4 * DAY, coverKey: 'k1', warningCount: 0, subtitle: null, event: null, pathwayCount: 0, pathwayNames: [] },
  'talk-beta': { slideCount: 6, createdMs: now - 90 * DAY, editedMs: now - 2 * DAY, coverKey: 'k2', warningCount: 1, subtitle: null, event: null, pathwayCount: 0, pathwayNames: [] }
}
let currentSessions = [
  { talkSlug: 'talk-alpha', kind: 'delivery', startedAt: new Date(now - 3 * DAY).toISOString() },
  { talkSlug: 'talk-beta', kind: 'rehearsal', startedAt: new Date(now - 1 * DAY).toISOString() },
  { talkSlug: 'talk-beta', kind: 'recording', startedAt: new Date(now - 2 * DAY).toISOString() }
]
window.tw = {
  vault: {
    talkMeta: async () => { metaCalls += 1; return currentMeta },
    onTalkMetaUpdated: (cb) => { onMetaUpdated = cb; return () => { onMetaUpdated = null } }
  },
  recording: {
    listAllSessions: async () => { sessionCalls += 1; return currentSessions }
  },
  history: {
    talkHandouts: async () => { handoutCalls += 1; return ({}) }
  }
}

const { subscribeTalkFacts, refreshTalkFacts, formatTalkDates } =
  await import('../src/renderer/src/lib/talkFacts.ts')

// ── two subscribers → one fetch; both see the same facts ──
const seenA = []
const seenB = []
const unsubA = subscribeTalkFacts((facts) => seenA.push(facts))
const unsubB = subscribeTalkFacts((facts) => seenB.push(facts))
await tick(); await tick()
equal(metaCalls, 1, 'two subscribers cause exactly one talkMeta fetch')
equal(sessionCalls, 1, 'two subscribers cause exactly one listAllSessions fetch')
equal(handoutCalls, 1, 'two subscribers cause exactly one talkHandouts fetch')
equal(seenA.length, 1, 'subscriber A was notified')
equal(seenB.length, 1, 'subscriber B was notified')
check(seenA[0] === seenB[0], 'both subscribers received the identical facts object')
equal(seenA[0].lastDelivered, { 'talk-alpha': Date.parse(currentSessions[0].startedAt) },
  'lastDelivered counts only delivery sessions (rehearsal/recording ignored)')

// ── onTalkMetaUpdated → both subscribers see the new meta, one extra fetch ──
currentMeta = {
  ...currentMeta,
  'talk-alpha': { ...currentMeta['talk-alpha'], slideCount: 9 }
}
check(typeof onMetaUpdated === 'function', 'the store subscribed to onTalkMetaUpdated')
onMetaUpdated()
await tick(); await tick()
equal(metaCalls, 2, 'the update ping causes one shared re-fetch')
check(seenA.at(-1).meta['talk-alpha'].slideCount === 9, 'subscriber A sees the fresh meta')
check(seenB.at(-1).meta['talk-alpha'].slideCount === 9, 'subscriber B sees the fresh meta')

// ── concurrent reloads share one fetch ──
const before = metaCalls
await Promise.all([refreshTalkFacts(), refreshTalkFacts(), refreshTalkFacts()])
equal(metaCalls, before + 1, 'three concurrent reloads share one fetch')

// ── unsubscribing the last listener drops the IPC subscription ──
unsubA()
unsubB()
check(onMetaUpdated === null, 'the last unsubscribe removes the onTalkMetaUpdated listener')

// ── the status-bar dates label ──
// 40 days back is always outside the 7-day recency window, but in early January it falls in
// the PREVIOUS year — then the year legitimately appears and the bare day-month text does not.
const sameYear = new Date(now - 40 * DAY)
const crossYear = sameYear.getFullYear() !== new Date(now).getFullYear()
const localeDay = (d) => d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })

const parts = formatTalkDates({
  createdMs: sameYear.getTime(),
  editedMs: new Date(now - 4 * DAY).getTime(),
  deliveredMs: null
})
equal(parts.length, 3, 'created/edited/delivered render as three parts')
if (!crossYear) {
  check(parts[0].text === `Created ${localeDay(sameYear)}`, `Created uses the card's short-date format — got ${parts[0].text}`)
  check(!/\d{4}/.test(parts[0].text), 'current-year dates carry no year')
} else {
  check(/\d{4}/.test(parts[0].text), 'dates outside the current year include the year')
}
equal(parts[1].text, 'Edited 4d ago', 'recent edits read as the card\'s recency form')
equal(parts[2].text, 'Delivered never', 'no delivery reads as "Delivered never"')
check(parts.every((p) => p.title === undefined || typeof p.title === 'string'), 'titles are strings or absent')

const oldYear = new Date(now - 500 * DAY) // ≈1.4 years back — always a different year
const oldParts = formatTalkDates({ createdMs: oldYear.getTime(), editedMs: null, deliveredMs: now })
equal(oldParts.length, 2, 'a missing editedMs renders no Edited part (no placeholder dashes)')
check(/\d{4}/.test(oldParts[0].text), 'dates outside the current year include the year')
check(oldParts[1].text.startsWith('Delivered '), `a delivery date renders after Delivered — got ${oldParts[1].text}`)
check((oldParts[0].title ?? '').length > 0 && /\d/.test(oldParts[0].title), 'each dated part carries a full date+time title')

equal(formatTalkDates({}).length, 1, 'no metadata at all renders only the Delivered part')
equal(formatTalkDates({}).at(0).text, 'Delivered never', 'the bare segment reads Delivered never')
if (fail) process.exit(1)
console.log('PASS: shared talk-facts store + status-bar dates label')
