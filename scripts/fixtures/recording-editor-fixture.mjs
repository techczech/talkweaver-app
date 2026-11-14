// A generated talk for the recording editor's tests and measurements: words in phrases separated by
// measured pauses, slide changes (some inside a phrase, some with no clear pause near them), steps, a
// marked mistake and one exact repeat. Deterministic (seeded); no real speech, no network.
//
// makeEditorFixture({ slides, wordsPerSlide, aligned, seed, sentences }) → { durationMs, transcript, marks, slideIds }
// `sentences: true` stores sentence boundaries as the transcriber does (transcript-contract mapSentences'
// shape): every phrase ends one (`transcriber`), and a phrase of eight words or more has a second one
// inside it, two words before its middle (`punctuation`), so some sentence starts fall in continuous
// speech and near the slide changes made inside a phrase. Off by default: the words and times are the same.
/** How far the transcriber's own word times are from where the word is said (aligned times). */
export const ORIGINAL_LATE_MS = 150, ORIGINAL_RUN_ON_MS = 450
const VOCAB = ['the', 'talk', 'slide', 'idea', 'and', 'then', 'we', 'build', 'a', 'clear', 'point', 'about', 'how', 'people', 'learn', 'with', 'tools', 'every', 'time', 'it', 'works', 'better', 'when', 'you', 'plan', 'first', 'so', 'this', 'one', 'shows', 'what', 'matters']

function prng(seed) {
  let s = seed >>> 0
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 }
}

export function makeEditorFixture({ slides = 8, wordsPerSlide = 40, aligned = true, seed = 7, sentences = false } = {}) {
  const rnd = prng(seed)
  const words = [], silence = [], segments = [], marks = []
  const slideIds = Array.from({ length: slides }, (_, i) => `s${i + 1}`)
  let t = 4100 // silent start
  silence.push({ start: 0, end: t })
  marks.push({ event: 'enter', slideId: slideIds[0], tMs: 180 })
  let repeated = false, flagged = false
  const phraseText = []
  const ends = [] // [word index, source]
  for (let k = 0; k < slides; k++) {
    let left = wordsPerSlide
    const phrases = []
    while (left > 0) { const len = Math.min(left, 4 + Math.floor(rnd() * 9)); phrases.push(len); left -= len }
    phrases.forEach((len, p) => {
      const segStart = t, first = words.length
      // One exact repeat, early in the talk: "we build a clear point we build a clear point".
      const texts = !repeated && k === 1 && p === 0 && len >= 8 ? (repeated = true, ['we', 'build', 'a', 'clear', 'we', 'build', 'a', 'clear', ...Array.from({ length: len - 8 }, () => VOCAB[Math.floor(rnd() * VOCAB.length)])])
        : Array.from({ length: len }, () => VOCAB[Math.floor(rnd() * VOCAB.length)])
      texts.forEach((text, j) => {
        const dur = 200 + Math.floor(rnd() * 250)
        // The transcriber's times are not the word's: they start late and run on into the pause after it
        // (as returned ranges absorb silence). Precise word timing places the word where it is said.
        const w = { text: j === len - 1 ? `${text}.` : text, start: t + ORIGINAL_LATE_MS, end: t + dur + ORIGINAL_RUN_ON_MS }
        if (aligned) w.alignment = { status: 'aligned', confidence: 0.9, normalised: text, unsupported: [], start: t, end: t + dur }
        words.push(w)
        t += dur
        if (j < len - 1) t += 30 + Math.floor(rnd() * 60)
      })
      segments.push({ start: words[first].start, end: words.at(-1).end }); phraseText.push(texts.map((x, j) => (j === len - 1 ? `${x}.` : x)).join(' '))
      if (len >= 8) ends.push([first + Math.floor(len / 2) - 2, 'punctuation'])
      ends.push([words.length - 1, 'transcriber'])
      // A slide change inside the last phrase of every third slide (the click falls mid-phrase).
      const lastPhrase = p === phrases.length - 1
      if (lastPhrase && k + 1 < slides && k % 3 === 2) marks.push({ event: 'enter', slideId: slideIds[k + 1], tMs: words[first + Math.floor(len / 2)].start - 10 })
      // A mistake marked after the second phrase of slide 4.
      if (!flagged && k === 3 && p === 1) { flagged = true; marks.push({ event: 'flag', slideId: slideIds[k], tMs: t + 120 }) }
      // The pause after the phrase: long now and then, else ordinary; a few short ones (not clean).
      const pause = p % 5 === 4 ? 2400 + Math.floor(rnd() * 3000) : p % 7 === 3 ? 250 : 600 + Math.floor(rnd() * 700)
      if (lastPhrase && k + 1 < slides && k % 3 !== 2) marks.push({ event: 'enter', slideId: slideIds[k + 1], tMs: t + Math.floor(pause / 2) })
      silence.push({ start: t, end: t + pause })
      t += pause
      // Steps on even slides: a reveal after the first phrase.
      if (k % 2 === 0 && p === 0) marks.push({ event: 'reveal', slideId: slideIds[k], hidden: 1, tMs: t - 100 })
    })
  }
  silence.push({ start: t, end: t + 2600 }) // silent end
  t += 2600
  const durationMs = t
  const transcript = { engine: 'apple-speech-transcriber', createdAt: '2026-11-11T10:00:00Z', timingClock: 'recording-v2', schemaVersion: 2, locale: 'en-GB', segments: segments.map((s, i) => ({ ...s, text: phraseText[i] })), words, silence }
  // Every adjacent pair has its shared midpoint (as the aligner stores it); those across two transcript
  // segments (phrases) are unmeasured, so the editor treats them by the pause rule.
  if (sentences) {
    transcript.sentences = []
    let from = 0
    for (const [last, source] of ends) {
      if (source === 'punctuation') words[last].text += '.'
      transcript.sentences.push({ id: `sentence-${from}-${last}`, firstWord: from, lastWord: last, start: words[from].start, end: words[last].end, boundarySource: source })
      from = last + 1
    }
  }
  if (aligned) transcript.alignment = { version: 1, model: 'fixture', revision: '0'.repeat(40), sha256: '0'.repeat(64), alignedAt: '2026-11-11T10:01:00Z', normalisation: 'ctc-nfc-v1', midpoints: words.slice(0, -1).map((w, i) => (w.alignment.end + words[i + 1].alignment.start) / 2) }
  return { durationMs, transcript, marks: marks.sort((a, b) => a.tMs - b.tMs), slideIds }
}
