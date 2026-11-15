// What an exported video should hold, worked out from the Run, its edits and the fixture (not from the app's
// export code): kept spans on the 30 fps frame grid the export cuts on, the sections on screen in them, the
// words kept; and readers for the caption files. Pure functions (record-edit-export.mjs, the export stage).

/** Kept spans of [0, D] after the cuts, on the export's 30 fps frame grid, with their edited-time starts. */
export function keptOnFrames(cuts, D) {
  const fr = (ms) => Math.round((ms * 30) / 1000), ms = (f) => (f * 1000) / 30
  const total = fr(D)
  const cs = cuts.map((c) => [Math.max(0, fr(c.start)), Math.min(total, fr(c.end))]).filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0])
  const spans = []
  let cursor = 0, edited = 0
  const push = (a, b) => { if (b > a) { spans.push({ startMs: ms(a), endMs: ms(b), editedStartMs: ms(edited), editedEndMs: ms(edited + b - a) }); edited += b - a } }
  for (const [a, b] of cs) { push(cursor, a); cursor = Math.max(cursor, b) }
  push(cursor, total)
  return spans
}
// One timestamp in the format's own syntax: SubRip separates milliseconds with a comma, WebVTT with a full stop;
// minutes and seconds are 00 to 59. Anything else is not a number (so the cue is reported as invalid).
const stampMs = (t, sep) => { const m = t.match(sep === ',' ? /^(\d{2}):([0-5]\d):([0-5]\d),(\d{3})$/ : /^(\d{2,}):([0-5]\d):([0-5]\d)\.(\d{3})$/); return m ? ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4]) : NaN }
/** SubRip: numbered cues 1..n, "hh:mm:ss,mmm --> hh:mm:ss,mmm", one or more text lines, blank line between. */
export function parseSrt(text) {
  const problems = [], cues = []
  const blocks = text.replace(/\r/g, '').trim().split(/\n{2,}/).filter((b) => b.trim())
  blocks.forEach((b, i) => {
    const [n, time, ...lines] = b.split('\n')
    const m = time?.match(/^(\S+) --> (\S+)$/)
    if (Number(n) !== i + 1) problems.push(`cue ${i + 1} is numbered "${n}"`)
    if (!m || Number.isNaN(stampMs(m[1], ',')) || Number.isNaN(stampMs(m[2], ','))) { problems.push(`cue ${i + 1} has no valid time line: "${time}"`); return }
    cues.push({ start: stampMs(m[1], ','), end: stampMs(m[2], ','), text: lines.join(' ').trim() })
  })
  return { cues, problems }
}
/** WebVTT: "WEBVTT" header, cues "hh:mm:ss.mmm --> hh:mm:ss.mmm" (an optional id line before), text lines. */
export function parseVtt(text) {
  const problems = [], cues = []
  const blocks = text.replace(/\r/g, '').trim().split(/\n{2,}/)
  if (!/^WEBVTT(\s|$)/.test(blocks[0] || '')) problems.push('no WEBVTT header')
  blocks.slice(1).filter((b) => b.trim()).forEach((b, i) => {
    let lines = b.split('\n')
    if (!/-->/.test(lines[0])) lines = lines.slice(1)
    const m = lines[0]?.match(/^(\S+) --> (\S+)/)
    if (!m || Number.isNaN(stampMs(m[1], '.')) || Number.isNaN(stampMs(m[2], '.'))) { problems.push(`cue ${i + 1} has no valid time line: "${lines[0]}"`); return }
    cues.push({ start: stampMs(m[1], '.'), end: stampMs(m[2], '.'), text: lines.slice(1).join(' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim() })
  })
  return { cues, problems }
}

/** The chapters the kept video should have: the sections of the slides on screen, in order, one per run of a
 *  section, none of zero length. A slide's time is its Run mark (a moved slide start at its new place); a slide
 *  entered inside a cut counts only if it is still showing when the cut ends. */
export function expectedChaptersOf({ visits, boundaries, kept, sectionOf }) {
  const moved = new Map(boundaries.map((b) => [b.change, b.at]))
  const marks = visits.map((v, k) => ({ slideId: v.slideId, t: k === 0 ? 0 : moved.get(v.change) ?? v.enterMs }))
  const unknown = marks.filter((m) => !sectionOf[m.slideId]).map((m) => m.slideId)
  const points = []
  marks.forEach((m, i) => {
    const span = kept.find((sp) => m.t < sp.endMs)
    if (!span) return
    if (m.t < span.startMs && (marks[i + 1]?.t ?? Infinity) < span.startMs) return
    const at = m.t < span.startMs ? span.editedStartMs : span.editedStartMs + (m.t - span.startMs)
    if (points.length && Math.abs(points.at(-1).at - at) < 1) points.pop()
    points.push({ at, title: sectionOf[m.slideId] ?? `(unknown slide ${m.slideId})` })
  })
  const total = kept.at(-1)?.editedEndMs ?? 0
  const chapters = points.filter((p, i) => (points[i + 1]?.at ?? total) - p.at > 0).filter((p, i, all) => i === 0 || p.title !== all[i - 1].title)
  if (chapters.length) chapters[0].at = 0
  return { chapters, unknown }
}

/** The caption words against the transcript's words (editor times): every word wholly inside a kept span must be
 *  there, in order; a word straddling a cut edge may be there or not; nothing else may be. */
export function captionWordsMatch(words, kept, cues) {
  const expect = words.map((w) => ({ text: w.text, kind: kept.some((sp) => w.start >= sp.startMs && w.end <= sp.endMs) ? 'kept' : kept.some((sp) => w.end > sp.startMs && w.start < sp.endMs) ? 'edge' : 'cut' })).filter((w) => w.kind !== 'cut')
  const stream = cues.flatMap((c) => c.text.split(/\s+/).filter(Boolean))
  let j = 0, n = 0, problem = null
  for (const w of expect) {
    if (stream[j] === w.text) j++
    else if (w.kind === 'kept') { problem = `kept word ${n} "${w.text}" is not caption word ${j} ("${stream[j] ?? '(end)'}")`; break }
    if (w.kind === 'kept') n++
  }
  if (!problem && j !== stream.length) problem = `caption words not among the kept words, from caption word ${j}: "${stream.slice(j, j + 5).join(' ')}"`
  return { problem, stream, kept: expect.filter((w) => w.kind === 'kept').length }
}
