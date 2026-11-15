// The stand-in transcript for the recording stages (record-edit-export.mjs).
// If the test-mode transcription gives no words for the fake microphone, the editor's word commands
// cannot be reached; then a stand-in transcript is written over the REAL recording's clock and slide
// marks (phrases with pauses, sentence ends, precise word timing), as the repo's editor e2e does with
// its generated talk. One slide change falls inside continuous speech, with a sentence start 1.5 s before
// it, so the editor finds no clear pause there and starts the slide at that sentence.
//
// That change is chosen by identity, never by timing: the Run's one entry to JOIN_SLIDE, the slide the record
// stage moves to by its id and dwells on (5 s of recording each side, read from the Run's own marks). And the
// speech around it is laid out from that change, not from the phrase grid before it: continuous speech from
// 3 s before the change to 2.5 s after, so no pause in the stand-in falls within two seconds of it whatever the
// key presses' timing (the editor's "no clear pause" window, src/shared/recording-editor.ts).
export const VOCAB = ['walk', 'river', 'path', 'map', 'gate', 'bridge', 'mill', 'water', 'group', 'leader', 'route', 'meadow', 'weather', 'boots', 'stile', 'flask', 'bank', 'reeds', 'heron', 'weir']
/** The slide whose change the stand-in speaks across (a slide id of talk.mjs's fixture talk). */
export const JOIN_SLIDE = 'row3'
const LEAD_MS = 3000, TAIL_MS = 2500, ROOM_MS = 4000

/** The Run time (ms) at which the Run entered `slideId`, from its marks. Throws, saying why, unless the Run
 *  entered it exactly once, not first, with more than ROOM_MS of recording on each side. */
export function joinChange(D, marks, slideId = JOIN_SLIDE) {
  const enters = (marks || []).filter((m) => m && m.event === 'enter' && Number.isFinite(m.tMs)).sort((a, b) => a.tMs - b.tMs)
  const mine = enters.filter((m) => m.slideId === slideId)
  const list = enters.map((m) => `${m.slideId}@${Math.round(m.tMs)}`).join(', ')
  if (mine.length !== 1) throw new Error(`stand-in: the Run entered slide ${slideId} ${mine.length} times, not once (entries: ${list})`)
  const i = enters.indexOf(mine[0]), at = mine[0].tMs
  const before = i > 0 ? at - enters[i - 1].tMs : 0, after = (i + 1 < enters.length ? enters[i + 1].tMs : D) - at
  if (before <= ROOM_MS || after <= ROOM_MS) throw new Error(`stand-in: slide ${slideId}, entered at ${Math.round(at)} ms, has ${Math.round(before)} ms of recording before it and ${Math.round(after)} ms after; more than ${ROOM_MS} ms is needed on each side (entries: ${list})`)
  return at
}

export function standInTranscript(D, marks, slideId = JOIN_SLIDE) {
  const enters = marks.filter((m) => m.event === 'enter').map((m) => m.tMs).sort((a, b) => a - b)
  const joinAt = joinChange(D, marks, slideId)
  // Continuous speech runs over [from, to); phrases stop early enough that their pause ends by `from`.
  const from = joinAt - LEAD_MS, to = joinAt + TAIL_MS
  const words = [], segments = [], silence = [], sentences = []
  let t = 900, k = 0, first = 0
  silence.push({ start: 0, end: t })
  const near = (x) => enters.some((e) => e !== joinAt && x > e - 450 && x < e + 450)
  const endSentence = () => { sentences.push({ id: `sentence-${first}-${words.length - 1}`, firstWord: first, lastWord: words.length - 1, start: words[first].start, end: words.at(-1).end, boundarySource: 'transcriber' }); first = words.length }
  const word = (end) => { const text = VOCAB[k++ % VOCAB.length]; words.push({ text: end ? text + '.' : text, start: t + 150, end: t + 300 + 450, alignment: { status: 'aligned', confidence: 0.9, normalised: text, unsupported: [], start: t, end: t + 300 } }); if (end) endSentence() }
  const PHRASE_MS = 5 * 360 + 300, PAUSE_MS = 850
  while (t < D - 1200) {
    if (t >= from && t < to) {
      // Continuous speech from 3 s before the change to 2.5 s after it; a sentence ends 1.5 s before the change.
      const at = words.length
      while (t < to) { word(t + 360 > joinAt - 1500 && t <= joinAt - 1500); t += 360 }
      words.at(-1).text += '.'; endSentence()
      segments.push({ start: words[at].start, end: words.at(-1).end, text: words.slice(at).map((w) => w.text).join(' ') })
      silence.push({ start: t, end: t + PAUSE_MS }); t += PAUSE_MS; continue
    }
    if (near(t)) { const e = enters.find((e) => t > e - 450 && t < e + 450); silence.push({ start: t, end: e + 500 }); t = e + 500; continue }
    // A phrase and the pause after it end by `from`; if there is no room for one, the pause runs to `from`.
    if (t < from && t + PHRASE_MS + PAUSE_MS > from) { silence.push({ start: t, end: from }); t = from; continue }
    const at = words.length
    for (let j = 0; j < 6 && t < D - 1000; j++) { word(j === 5); t += 300 + (j < 5 ? 60 : 0) }
    if (words.length > at) { if (!/\.$/.test(words.at(-1).text)) { words.at(-1).text += '.'; endSentence() } segments.push({ start: words[at].start, end: words.at(-1).end, text: words.slice(at).map((w) => w.text).join(' ') }) }
    silence.push({ start: t, end: t + PAUSE_MS }); t += PAUSE_MS
  }
  return { engine: 'apple-speech-transcriber', createdAt: new Date().toISOString(), timingClock: 'recording-v2', schemaVersion: 2, locale: 'en-GB', segments, words, silence, sentences,
    alignment: { version: 1, model: 'fixture', revision: '0'.repeat(40), sha256: '0'.repeat(64), alignedAt: new Date().toISOString(), normalisation: 'ctc-nfc-v1', midpoints: words.slice(0, -1).map((w, i) => (w.alignment.end + words[i + 1].alignment.start) / 2) } }
}
