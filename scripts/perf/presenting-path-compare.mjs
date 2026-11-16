#!/usr/bin/env node
/** Markdown table of presenting-path results, side by side.
 * Usage: node scripts/perf/presenting-path-compare.mjs NAME=before.json NAME=after.json [...]
 * Step times are medians (p90 in brackets), in ms. Preview panes leave out slides whose Current pane is a live page
 * (it loads on its own schedule; the script waits at most 5 s for it).
 */
import { readFileSync } from 'node:fs'
const runs = process.argv.slice(2).map((a) => { const i = a.indexOf('='); return [a.slice(0, i), JSON.parse(readFileSync(a.slice(i + 1), 'utf8'))] })
if (!runs.length) throw Error('Expected NAME=file.json ...')
const q = (xs, p) => { const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b); return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))]) : null }
const mp = (xs) => { const m = q(xs, 0.5); return m == null ? '–' : `${m} (${q(xs, 0.9)})` }
const steps = (r, dir, f, keep = () => true) => r.steps.filter((s) => s.key === dir && keep(s)).map(f)
const noLive = (s) => !s.kinds.includes('embed')
const rows = [
  ['Slides', (r) => r.measurements.slides ?? '–'],
  ['Start to Talks list', (r) => r.measurements.startToUsableMs ?? '–'],
  ['Open talk to compiled picture', (r) => r.measurements.openTalk?.toCompiledPreviewMs ?? '–'],
  ['Present to presenter view ready', (r) => r.measurements.present?.toPresenterReadyMs ?? '–'],
  ['Next: presenter frame', (r) => mp(steps(r, 'next', (s) => s.presenterFrameMs))],
  ['Next: audience frame', (r) => mp(steps(r, 'next', (s) => s.audienceFrameMs))],
  ['Next: preview panes loaded', (r) => mp(steps(r, 'next', (s) => s.presenterPanesMs, noLive))],
  ['Back: presenter frame', (r) => mp(steps(r, 'back', (s) => s.presenterFrameMs))],
  ['Back: audience frame', (r) => mp(steps(r, 'back', (s) => s.audienceFrameMs))],
  ['Back: preview panes loaded', (r) => mp(steps(r, 'back', (s) => s.presenterPanesMs, noLive))],
  ['Worst audience frame', (r) => q(r.steps.map((s) => s.audienceFrameMs), 1) ?? '–'],
  ['Steps over 100 ms (stutters)', (r) => `${r.measurements.steps?.stutters ?? '–'} of ${r.steps.length}`],
  ['CPU s for all steps (renderer)', (r) => { const c = r.measurements.steps?.cpuSecondsDuringSteps; return c ? `${c.all} (${c.renderer})` : '–' }],
  ['Idle CPU % on a slide', (r) => r.measurements.idleCpuPercentWhilePresenting?.all ?? '–'],
  ['Memory after steps, MB (all processes)', (r) => r.process.afterSteps?.all.rssMB ?? '–'],
  ['Typing: key to frame', (r) => { const t = r.measurements.typing; return t ? `${Math.round(t.median)} (${Math.round(t.p90)})` : '–' }],
]
console.log(`| | ${runs.map(([n]) => n).join(' | ')} |`)
console.log(`|---|${runs.map(() => '---').join('|')}|`)
for (const [label, f] of rows) console.log(`| ${label} | ${runs.map(([, r]) => f(r)).join(' | ')} |`)
