#!/usr/bin/env node
// {chat} {chat-lanes} {terminal} {terminal-agent}: parser and renderer seams of
// compiler/scripts/lib/simulation-layout.mjs, plus the compile path (08-source-adapters annotate +
// 06-block-renderers render) and the handout static rendering. Spec: the locked AI chat and
// terminal simulation spec in the 2026-10-08 design folder (dev repo only); its section 2 is the
// edge-case table each block below names.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  parseSimulationTurns,
  parseShellSession,
  simulationOptions,
  simulationMode,
  formatSimDuration,
  renderSimulation,
  simulationStatic,
  annotateSimulationLayout
} from '../compiler/scripts/lib/simulation-layout.mjs'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'

let passed = 0
const test = (name, fn) => { fn(); passed += 1; console.log(`PASS ${name}`) }
const codes = (warnings) => warnings.map((w) => w.join(':'))

const EXAMPLE = `user: What changed in our refund policy last month?
model-reasoning (4s): They want last month’s changes.
context-retrieval:
  Refund Policy v4.2 (September 2026)
  - Policy change log, September 2026
tool-call: search_policy_docs {"topic": "refunds"}
tool-results:
  Refund window cut from 30 to 14 days
  Digital goods: refundable only if unused
bot: The refund window shrank from 30 to 14 days.`

// ---- labelled turns (spec 1.5) ----
test('the example parses to one exchange: question, three parts in order, answer', () => {
  const { exchanges, warnings } = parseSimulationTurns(EXAMPLE)
  assert.deepEqual(warnings, [])
  assert.equal(exchanges.length, 1)
  const [ex] = exchanges
  assert.deepEqual(ex.user.paragraphs, ['What changed in our refund policy last month?'])
  assert.deepEqual(ex.parts.map((p) => p.kind), ['reasoning', 'context', 'tool'])
  assert.equal(ex.parts[0].duration, '4 s')
  assert.deepEqual(ex.parts[1].sources, ['Refund Policy v4.2 (September 2026)', 'Policy change log, September 2026'])
  assert.equal(ex.parts[2].name, 'search_policy_docs')
  assert.equal(ex.parts[2].args, '{"topic": "refunds"}')
  assert.deepEqual(ex.parts[2].results, ['Refund window cut from 30 to 14 days', 'Digital goods: refundable only if unused'])
  assert.deepEqual(ex.bot.paragraphs, ['The refund window shrank from 30 to 14 days.'])
})
test('labels are case-insensitive, column 0 only; an indented label line continues the turn', () => {
  const { exchanges } = parseSimulationTurns('USER: one\nline two\n\nsecond paragraph\nBot: answer\n  user: not a label')
  assert.deepEqual(exchanges[0].user.paragraphs, ['one line two', 'second paragraph'])
  assert.deepEqual(exchanges[0].bot.paragraphs, ['answer user: not a label'])
})
test('a column-0 "word:" that is not a label is silent continuation text (Digital goods:, note:)', () => {
  const { exchanges, warnings } = parseSimulationTurns('user: q\nnote: keep this\nbot: a')
  assert.deepEqual(warnings, [])
  assert.deepEqual(exchanges[0].user.paragraphs, ['q note: keep this'])
})
test('duration: (4s) -> 4 s, (250ms), (2min), anything else verbatim; ignored on other labels', () => {
  assert.equal(formatSimDuration('4s'), '4 s')
  assert.equal(formatSimDuration('250ms'), '250 ms')
  assert.equal(formatSimDuration('2min'), '2 min')
  assert.equal(formatSimDuration('about a minute'), 'about a minute')
  const { warnings } = parseSimulationTurns('user (3s): q\nbot: a')
  assert.deepEqual(codes(warnings), ['sim-option-ignored:duration'])
})
test('multi-turn: user: starts a new exchange; a part after a bot starts one with no user', () => {
  const { exchanges } = parseSimulationTurns(`${EXAMPLE}\nuser: Does it apply to August?\nbot: No.\nmodel-reasoning: later thought\nbot: Two bots`)
  assert.equal(exchanges.length, 3)
  assert.equal(exchanges[1].user.paragraphs[0], 'Does it apply to August?')
  assert.equal(exchanges[2].user, null)
  assert.equal(exchanges[2].parts[0].kind, 'reasoning')
})
test('two bot turns in a row: the second starts a new exchange with no user', () => {
  const { exchanges } = parseSimulationTurns('user: q\nbot: one\nbot: two')
  assert.equal(exchanges.length, 2)
  assert.equal(exchanges[1].user, null)
  assert.deepEqual(exchanges[1].bot.paragraphs, ['two'])
})

// ---- spec section 2, row by row ----
test('empty fence: no exchanges, sim-empty', () => {
  assert.deepEqual(codes(parseSimulationTurns('').warnings), ['sim-empty'])
  assert.deepEqual(codes(parseShellSession('').warnings), ['sim-empty'])
})
test('text before the first label is dropped with sim-text-before-label', () => {
  const { exchanges, warnings } = parseSimulationTurns('stray\nuser: q')
  assert.deepEqual(codes(warnings), ['sim-text-before-label'])
  assert.deepEqual(exchanges[0].user.paragraphs, ['q'])
})
test('unknown label: kept as text, warning names the nearest valid label', () => {
  const { exchanges, warnings } = parseSimulationTurns('user: q\nassistant: kept\nthinking: also kept')
  assert.deepEqual(codes(warnings), ['sim-unknown-label:assistant:bot', 'sim-unknown-label:thinking:model-reasoning'])
  assert.deepEqual(exchanges[0].user.paragraphs, ['q assistant: kept thinking: also kept'])
})
test('missing bot and missing user both parse; no warning', () => {
  assert.deepEqual(parseSimulationTurns('user: q\ntool-call: t').warnings, [])
  const { exchanges, warnings } = parseSimulationTurns('model-reasoning: r\nbot: a')
  assert.deepEqual(warnings, [])
  assert.equal(exchanges[0].user, null)
})
test('tool-results without tool-call: a result-only part and sim-results-without-call', () => {
  const { exchanges, warnings } = parseSimulationTurns('user: q\ntool-results:\n  line')
  assert.deepEqual(codes(warnings), ['sim-results-without-call'])
  assert.deepEqual(exchanges[0].parts[0], { kind: 'result-only', lines: ['line'] })
})
test('tool-results attach to the nearest call without results; a second set becomes result-only', () => {
  const { exchanges, warnings } = parseSimulationTurns('user: q\ntool-call: a\ntool-results: r1\ntool-results: r2')
  assert.deepEqual(exchanges[0].parts.map((p) => p.kind), ['tool', 'result-only'])
  assert.deepEqual(codes(warnings), ['sim-results-without-call'])
})
test('tool-results attach to the nearest call WITHOUT results, skipping one that already has them', () => {
  const { exchanges, warnings } = parseSimulationTurns('user: q\ntool-call: a\ntool-call: b\ntool-results: B\ntool-results: A')
  assert.deepEqual(warnings, [])
  assert.deepEqual(exchanges[0].parts.map((p) => [p.kind, p.name, p.results]), [['tool', 'a', ['A']], ['tool', 'b', ['B']]])
})
test('tool payloads are verbatim: internal blank lines and trailing spaces survive', () => {
  const { exchanges } = parseSimulationTurns('user: q\ntool-call: run {"a": 1}  \n  second line\n\n  after a blank  \ntool-results:\n  one  \n\n  three\n\nbot: a')
  const [call] = exchanges[0].parts
  assert.equal(call.args, '{"a": 1}  \nsecond line\n\nafter a blank  ')
  assert.deepEqual(call.results, ['one  ', '', 'three'])
  const [next] = parseSimulationTurns('tool-call: run\n  {"a": 1}').exchanges[0].parts
  assert.equal(next.args, '{"a": 1}', 'arguments starting on the next line lose only the line break')
})
test('payload edges: blank lines at the very start and end are trimmed (decision after lock, 2026-10-09)', () => {
  const [part] = parseSimulationTurns('tool-call:\n\n  run {"a": 1}\n\n  {"b": 2}  \n\n\ntool-results:\n\n  first\n\n  last  \n\n\nbot: a').exchanges[0].parts
  assert.equal(part.name, 'run')
  assert.equal(part.args, '{"a": 1}\n\n{"b": 2}  ', 'leading and trailing blank lines go; the internal blank line and trailing spaces stay')
  assert.deepEqual(part.results, ['first', '', 'last  '])
})
test('context-retrieval with no sources: part omitted, sim-context-empty', () => {
  const { exchanges, warnings } = parseSimulationTurns('user: q\ncontext-retrieval:\nbot: a')
  assert.deepEqual(codes(warnings), ['sim-context-empty'])
  assert.deepEqual(exchanges[0].parts, [])
})
test('tool-call with no arguments: name only', () => {
  const [part] = parseSimulationTurns('tool-call: lookup').exchanges[0].parts
  assert.deepEqual([part.name, part.args, part.results], ['lookup', '', null])
})
test('tool arguments are verbatim, multi-line, not validated as JSON', () => {
  const [part] = parseSimulationTurns('tool-call: run {\n  "a": [1,\n  broken').exchanges[0].parts
  assert.equal(part.args, '{\n"a": [1,\nbroken')
})

// ---- shell session (spec 1.6) ----
test('shell: path prompts carry forward, output verbatim, cursor appended with the current path', () => {
  const { cmds, cursor, warnings } = parseShellSession('~ $ cd policy\n~/policy $ ls\na  b\n$ git log\nx   y')
  assert.deepEqual(warnings, [])
  assert.deepEqual(cmds.map((c) => [c.prompt, c.command]), [['~ $', 'cd policy'], ['~/policy $', 'ls'], ['~/policy $', 'git log']])
  assert.deepEqual(cmds[1].out, ['a  b'])
  assert.deepEqual(cmds[2].out, ['x   y'])
  assert.equal(cursor.prompt, '~/policy $')
})
test('shell: no path yet gives a bare $; a closing prompt-only line is the cursor line', () => {
  const { cmds, cursor } = parseShellSession('$ echo hi\nhi\n~/x $')
  assert.equal(cmds[0].prompt, '$')
  assert.equal(cmds.length, 1)
  assert.equal(cursor.prompt, '~/x $')
})
test('shell: a backslash-escaped prompt-looking line is output, backslash not rendered', () => {
  const { cmds } = parseShellSession('$ echo\n\\$ 5 off')
  assert.deepEqual(cmds[0].out, ['$ 5 off'])
})

// ---- options (spec 1.3 + decisions after lock) ----
test('option defaults', () => {
  assert.deepEqual(simulationOptions('chat', {}), { reveal: 'all', size: 'compact', sidebar: 'on', stream: 'off', model: 'Model', open: 'none', windowTitle: 'shell', ignored: [] })
  assert.equal(simulationOptions('terminal', {}).windowTitle, 'shell')
  assert.equal(simulationOptions('terminal-agent', {}).windowTitle, 'agent-cli')
})
test('reveal: {reveal}, reveal=steps and mode=reveal all mean steps; reveal=all and unknown values fall back', () => {
  assert.equal(simulationOptions('chat', { mode: 'reveal' }).reveal, 'steps')
  assert.equal(simulationOptions('chat', { reveal: 'steps' }).reveal, 'steps')
  assert.equal(simulationOptions('chat', { reveal: 'all' }).reveal, 'all')
  assert.equal(simulationOptions('chat', { sidebar: 'maybe', open: 'some', size: 'huge' }).sidebar, 'on')
  assert.equal(simulationOptions('chat', { open: 'some' }).open, 'none')
  assert.equal(simulationOptions('chat', { size: 'huge' }).size, 'compact')
})
test('an option given to a layout it does not apply to is listed as ignored', () => {
  assert.deepEqual(simulationOptions('terminal', { sidebar: 'off', model: 'x', open: 'all' }).ignored, ['sidebar', 'model', 'open'])
  assert.deepEqual(simulationOptions('chat', { 'window-title': 'x' }).ignored, ['window-title'])
})
test('focus mode on a simulation slide is treated as reveal; other layouts keep it', () => {
  assert.equal(simulationMode('chat', 'focus'), 'reveal')
  assert.equal(simulationMode('list', 'focus'), 'focus')
})

// ---- annotate + render ----
const annotate = (layout, text, attrs = {}, lang = layout.startsWith('terminal') ? 'terminal' : 'chat') => {
  const block = { type: 'code', lang, text }
  const warnings = []
  annotateSimulationLayout([block], layout, attrs, { id: 's1', title: 'Refund <policy>' }, (w) => warnings.push(w))
  return { block, warnings, html: renderSimulation(block) }
}
test('stream=on|off on the chat layouts (owner request 2026-10-09): off by default, unknown values fall back', () => {
  assert.equal(simulationOptions('chat', { stream: 'on' }).stream, 'on')
  assert.equal(simulationOptions('chat-lanes', { stream: 'off' }).stream, 'off')
  assert.equal(simulationOptions('chat', { stream: '70' }).stream, 'off')
  assert.deepEqual(simulationOptions('terminal', { stream: 'on' }).ignored, ['stream'])
  assert.match(annotate('chat', EXAMPLE, { stream: 'on' }).html, /^<div class="sim sim-chat sim-chat-rows" data-sidebar="on" data-open="none" data-stream="on">/)
  assert.ok(!annotate('chat-lanes', EXAMPLE).html.includes('data-stream'), 'no attribute unless streaming')
})
test('chat-lanes markup: open by construction, first question is the anchor, connectors, aria wiring', () => {
  const { html, warnings } = annotate('chat-lanes', EXAMPLE, { model: 'Example model' })
  assert.deepEqual(warnings, [])
  assert.match(html, /^<div class="sim sim-chat sim-chat-lanes" data-sidebar="on" data-open="none">/)
  assert.match(html, /<div class="sim-window" aria-hidden="true">/)
  assert.match(html, /<p class="sim-panel-title">Behind the scenes<\/p>/)
  assert.match(html, /<div class="sim-turn sim-user"><p class="sim-bubble">/)
  assert.match(html, /sim-link sim-link-out" aria-hidden="true"/)
  assert.match(html, /sim-link sim-link-in" aria-hidden="true"/)
  assert.match(html, /Reasoning · 4 s/)
  assert.match(html, /Context retrieved/)
  const button = html.match(/<button class="sim-toggle sim-toggle-results" type="button" aria-expanded="true" aria-controls="([^"]+)">/)
  assert.ok(button, 'tool part with results carries the Show/Hide control')
  assert.match(html, new RegExp(`<div class="sim-body" id="${button[1]}">`))
  assert.equal((html.match(/class="sim-toggle/g) || []).length, 1, 'chat-lanes: only tool results disclose')
  assert.deepEqual([...html.matchAll(/class="sim-(?:part|turn) [^"]*"/g)].map((m) => m[0].includes('sim-step')), [false, true, true, true, true])
})
test('chat rows: one toggle per part with the spec labels; DOM order is reading order', () => {
  const { html } = annotate('chat', EXAMPLE)
  assert.deepEqual([...html.matchAll(/<button class="sim-toggle"[^>]*>.*?<span>([^<]*)<\/span>/g)].map((m) => m[1]), ['Thought for 4 s', 'Searched 2 sources', 'Used search_policy_docs'])
  const order = ['sim-user', 'sim-reasoning', 'sim-context', 'sim-tool', 'sim-answer'].map((c) => html.indexOf(c))
  assert.deepEqual(order, [...order].sort((a, b) => a - b))
  assert.ok(!html.includes('sim-link'), 'no connectors in chat rows')
  assert.ok(!html.includes('sim-panel'), 'no panel in chat rows')
})
test('sidebar=off removes the sidebar; the slide title fills the highlighted entry, escaped', () => {
  assert.match(annotate('chat', EXAMPLE).html, /<div class="sim-recent sim-recent-current">Refund &lt;policy&gt;<\/div>/)
  assert.ok(!annotate('chat', EXAMPLE, { sidebar: 'off' }).html.includes('sim-sidebar'))
})
test('author text is escaped everywhere: turns, tool payloads, model, titles', () => {
  const hostile = 'user: <img src=x onerror=alert(1)>\ntool-call: <b>x</b> {"a":"</code>"}\ntool-results:\n  <script>1</script>\nbot: a & b'
  for (const layout of ['chat', 'chat-lanes', 'terminal-agent']) {
    const { html } = annotate(layout, hostile, { model: '<i>m</i>', 'window-title': '<u>t</u>' })
    assert.ok(!/<img|<script|<b>x|<i>m|<u>t|<\/code>"/.test(html), `${layout}: no raw author markup`)
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/)
  }
  const shell = annotate('terminal', '$ echo "<b>"\n<script>', { 'window-title': '<u>t</u>' }).html
  assert.ok(!/<script>|<u>t|"<b>"/.test(shell))
})
test('missing bot: no avatar, solo outgoing connector; missing user: no outgoing connector', () => {
  const noBot = annotate('chat-lanes', 'user: q\ntool-call: t').html
  assert.ok(!noBot.includes('sim-avatar'))
  assert.match(noBot, /sim-link sim-link-out sim-link-solo/)
  const noUser = annotate('chat-lanes', 'tool-call: t\nbot: a').html
  assert.ok(!noUser.includes('sim-link-out'))
  assert.match(noUser, /sim-link sim-link-in sim-link-solo/)
})
test('tool-call without results: chat-lanes has no control; result-only part is magenta with its control', () => {
  assert.ok(!annotate('chat-lanes', 'user: q\ntool-call: t').html.includes('sim-toggle'))
  const ro = annotate('chat-lanes', 'user: q\ntool-results: r').html
  assert.match(ro, /sim-part sim-result-only sim-step/)
  assert.match(ro, /sim-toggle-results/)
})
test('terminal-agent: header, first prompt box anchor, thinking, Read(N documents), name(args), +N lines, status', () => {
  const { html } = annotate('terminal-agent', `${EXAMPLE}\nuser: and August?\nbot: no`, { model: 'example-model', 'window-title': 'agent-cli · x' })
  assert.match(html, /^<div class="sim sim-terminal sim-terminal-agent" data-open="none">/)
  assert.match(html, /<div class="sim-agent-head">◆ agent-cli · x<\/div>/)
  assert.match(html, /<div class="sim-promptbox"><span class="sim-gt">&gt;<\/span>What changed/)
  assert.match(html, /<div class="sim-promptbox sim-step">/)
  assert.match(html, /✻ Thinking for 4 s… <span class="sim-dim">/)
  assert.match(html, /<b>Read<\/b>\(2 documents\)/)
  assert.match(html, /<b>search_policy_docs<\/b>\(\{&quot;topic&quot;: &quot;refunds&quot;\}\)/)
  assert.match(html, /… \+1 line \(click to expand\)/)
  assert.match(html, /<div class="sim-status" aria-hidden="true"><span>⏵⏵ tools auto-approved<\/span><span>example-model · 12% context used<\/span>/)
})
test('terminal-agent: one result line has no +N control; no arguments renders name()', () => {
  const { html } = annotate('terminal-agent', 'user: q\ntool-call: lookup\ntool-results: one')
  assert.ok(!html.includes('sim-more'))
  assert.match(html, /<b>lookup<\/b>\(\)/)
})
test('terminal-agent empty fence: header, empty prompt box, status line', () => {
  const { html, warnings } = annotate('terminal-agent', '')
  assert.deepEqual(warnings, ['sim-empty:s1'])
  assert.match(html, /sim-agent-head[\s\S]*<div class="sim-promptbox"><span class="sim-gt">&gt;<\/span><\/div>[\s\S]*sim-status/)
})
test('terminal: window title, first command anchor, later commands step, cursor rides the last command', () => {
  const { html } = annotate('terminal', '~ $ cd p\n$ ls\na', { 'window-title': 'policy — shell' })
  assert.match(html, /<span class="sim-term-title">policy — shell<\/span>/)
  assert.match(html, /<div class="sim-cmd"><div class="sim-line"><span class="sim-prompt">~ \$<\/span> <kbd class="sim-typed">cd p<\/kbd>/)
  assert.match(html, /<div class="sim-cmd sim-step">.*<span class="sim-cursor" aria-hidden="true"><\/span><\/div><\/div><\/div>/)
  assert.match(annotate('terminal', '').html, /<div class="sim-cmd"><div class="sim-line"><span class="sim-prompt">\$<\/span> <span class="sim-cursor"/)
})
test('size=large marks the root; compact (default) does not', () => {
  assert.match(annotate('chat', EXAMPLE, { size: 'large' }).html, /^<div class="sim sim-chat sim-chat-rows sim-large"/)
  assert.ok(!annotate('terminal', '$ ls').html.includes('sim-large'))
})
test('annotate warnings: extra fence, ignored option, fence/tag mismatch, no fence', () => {
  const blocks = [{ type: 'code', lang: 'chat', text: '$ ls' }, { type: 'code', lang: 'terminal', text: '$ pwd' }]
  const warnings = []
  annotateSimulationLayout(blocks, 'terminal', { sidebar: 'off' }, { id: 's1', title: 'T' }, (w) => warnings.push(w))
  assert.deepEqual(warnings, ['sim-extra-fence:s1', 'sim-option-ignored:s1:sidebar', 'sim-fence-tag-mismatch:s1'])
  assert.ok(blocks[0].sim && blocks[1].simIgnored)
  const none = []
  annotateSimulationLayout([{ type: 'paragraph', text: 'x' }], 'chat', {}, { id: 's2' }, (w) => none.push(w))
  assert.deepEqual(none, ['sim-no-fence:s2'])
  const quiet = []
  annotateSimulationLayout([{ type: 'code', lang: 'terminal', text: 'user: q' }], 'chat', {}, { id: 's3' }, (w) => quiet.push(w))
  assert.deepEqual(quiet, [], '```terminal under {chat} is accepted silently')
})
test('handout static rendering: sim-static root, controls out of the tab order, other slides untouched', () => {
  const html = annotate('chat', EXAMPLE).html
  const out = simulationStatic(`<section class="slide">${html}</section>`)
  assert.match(out, /<div class="sim sim-static sim-chat sim-chat-rows"/)
  assert.equal((out.match(/<button tabindex="-1" class="sim-toggle/g) || []).length, 3)
  assert.equal(simulationStatic(out), out, 'idempotent')
  const plain = '<section class="slide"><p>Hello</p></section>'
  assert.equal(simulationStatic(plain), plain)
})

// ---- compile path: inference, layout tags, warnings with the slide id ----
const compile = async (md) => prepareSource('/tmp/sim-test-outline.md', md, 'sim', { mtimeMs: 0, size: md.length, isDirectory: () => false })
{
  const model = await compile(`# Deck\n\n## S\n\n### Chat\n\n\`\`\`chat\nuser: q\nbot: a\n\`\`\`\n\n### Shell\n\n\`\`\`terminal\n$ ls\n\`\`\`\n\n### Lanes\n{chat-lanes reveal=steps model="Example model"}\n\n\`\`\`chat\nuser: q\nmodel-reasoning: r\nbot: a\n\`\`\`\n\n### Agent\n{terminal-agent mode=focus}\n\n\`\`\`terminal\nuser: q\nbot: a\n\`\`\`\n`)
  const byTitle = Object.fromEntries(model.slides.map((s) => [s.title, s]))
  test('compile: ```chat infers chat, ```terminal infers terminal; tags pick the design', () => {
    assert.equal(byTitle.Chat.layout, 'chat')
    assert.equal(byTitle.Shell.layout, 'terminal')
    assert.equal(byTitle.Lanes.layout, 'chat-lanes')
    assert.equal(byTitle.Agent.layout, 'terminal-agent')
  })
  test('compile: reveal=steps and mode=focus both reach the slide as reveal', () => {
    assert.match(model.fullHtml, /data-id="lanes"[^>]*data-mode="reveal"|data-mode="reveal"[^>]*data-id="lanes"/)
    assert.match(model.fullHtml, /data-id="agent"[^>]*data-mode="reveal"|data-mode="reveal"[^>]*data-id="agent"/)
  })
  test('compile: the simulation renders, the quoted model reaches the picker, no stray warnings', () => {
    assert.match(model.fullHtml, /<span class="sim-model">Example model<svg/)
    assert.deepEqual(model.warnings.filter((w) => /^(sim-|unknown-trigger|unresolved-trigger)/.test(w)), [])
  })
}

// ---- stylesheet facts the spec fixes ----
test('stylesheet: size=large lifts running text to the ADR-0005 floor (stage.css token)', () => {
  const stage = readFileSync(new URL('../compiler/assets/styles/stage.css', import.meta.url), 'utf8')
  const css = readFileSync(new URL('../compiler/assets/styles/layouts/simulation.css', import.meta.url), 'utf8')
  const floorCqw = Number(stage.match(/--type-floor:\s*([\d.]+)cqw/)[1])
  const z = (sel) => Number(css.match(new RegExp(`\\.${sel}\\.sim-large \\{ --z: ([\\d.]+); \\}`))[1])
  assert.ok(Math.abs((28 * z('sim-chat')) / 19.2 - floorCqw) < 0.001, 'chat bubble/answer (28px) at the floor')
  assert.ok(Math.abs((26 * z('sim-terminal')) / 19.2 - floorCqw) < 0.001, 'terminal text (26px) at the floor')
  assert.ok(!/\b\d+px\b/.test(css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--type-floor: 0px/, '')), 'no px sizes (cqw via --u only)')
  assert.match(css, /\.slide\.mode-reveal \.sim \.mode-el\[data-mode-state="soft"\] \{ opacity: 1; \}/)
  assert.match(css, /@media print \{[\s\S]*\.sim \.is-closed \.sim-body \{ display: block !important; \}/)
})

console.log(`simulation layouts: ${passed} checks passed`)
