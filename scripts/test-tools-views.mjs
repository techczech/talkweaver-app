// The Tools window's one view list (src/shared/tools-views.ts): every surface accepts exactly the
// listed views, the rail always shows its five items, and a Run reference is checked.
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { TOOLS_VIEWS, canonicalToolsView, isToolsView, isOpenableToolsView, isShowableToolsView, railItemFor, toolsRail, parseToolsRunRef } from '../src/shared/tools-views.ts'

assert.deepEqual([...TOOLS_VIEWS], ['studio', 'runs', 'talktext', 'importer', 'published', 'workfiles', 'history', 'sessions'])
// History and Sessions are one Runs view (R5): the old names are accepted and folded into it.
assert.equal(canonicalToolsView('history'), 'runs')
assert.equal(canonicalToolsView('sessions'), 'runs')
assert.equal(canonicalToolsView('runs'), 'runs')
assert.equal(canonicalToolsView('studio'), 'studio')
assert.equal(railItemFor('history'), 'runs')
assert.equal(railItemFor('talktext'), null)
for (const view of TOOLS_VIEWS) assert(isToolsView(view), view)
for (const bad of ['', 'Studio', 'settings', 'constructor', '__proto__', null, undefined, 3, {}, ['studio']]) {
  assert.equal(isToolsView(bad), false, String(bad))
  assert.equal(isOpenableToolsView(bad), false, String(bad))
  assert.equal(isShowableToolsView(bad), false, String(bad))
}

// Every view but Pathways opens through the generic call; Pathways opens only through its own call.
for (const view of ['studio', 'runs', 'talktext', 'importer', 'published', 'workfiles', 'history', 'sessions']) {
  assert.equal(isOpenableToolsView(view), true, view)
  assert.equal(isShowableToolsView(view), true, view)
}
assert.equal(isOpenableToolsView('pathways'), false)
assert.equal(isShowableToolsView('pathways'), false)

// The rail: Studio, Runs, Importer, Published pages and Work files, with no switch to turn on.
assert.deepEqual(toolsRail().map((i) => i.label), ['Studio', 'Runs', 'Importer', 'Published pages', 'Work files'])
assert.equal(toolsRail().find((i) => i.view === 'workfiles').icon, 'files')

assert.deepEqual(parseToolsRunRef({ talkSlug: 'ai-agents', runId: '2026-10-21-said' }), { talkSlug: 'ai-agents', runId: '2026-10-21-said' })
// A vault id, when given, rides along (the editor's strips open that vault's Run); a malformed one is refused.
assert.deepEqual(parseToolsRunRef({ talkSlug: 'a', runId: 'r', vaultId: 'v-1' }), { talkSlug: 'a', runId: 'r', vaultId: 'v-1' })
for (const bad of [{ talkSlug: 'a', runId: 'r', vaultId: '' }, { talkSlug: 'a', runId: 'r', vaultId: 'x/y' }, { talkSlug: 'a', runId: 'r', vaultId: 3 }]) assert.equal(parseToolsRunRef(bad), null, JSON.stringify(bad))
for (const bad of [null, 'x', {}, { talkSlug: 'a' }, { talkSlug: '', runId: 'r' }, { talkSlug: '../a', runId: 'r' }, { talkSlug: 'a', runId: 'b/c' }, { talkSlug: 1, runId: 'r' }]) {
  assert.equal(parseToolsRunRef(bad), null, JSON.stringify(bad))
}

// Main, preload and renderer take their view type and checks from the shared module, not their own lists.
for (const file of ['src/main/index.ts', 'src/preload/index.ts', 'src/renderer/src/App.tsx']) {
  const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
  assert(text.includes('shared/tools-views'), `${file} imports the shared list`)
  assert.equal(/'studio' \| 'history' \| 'pathways'/.test(text), false, `${file} has no private view list`)
}

// Plan a Run (issue 234, R5): the Plan a Run command switches the Tools window to its one Runs view, which hosts the
// one sheet; no other view and no second host draws it. The command does not write anything itself.
{
  const app = readFileSync(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8')
  const view = readFileSync(new URL('../src/renderer/src/components/RunsView.tsx', import.meta.url), 'utf8')
  assert.equal(/<PlanRunSheet\b/.test(app), false, 'App no longer hosts a Plan a Run sheet of its own')
  assert((view.match(/<PlanRunSheet\b/g) ?? []).length === 1, 'the Runs view hosts the one Plan a Run sheet')
  const planRun = /const planRun = \(\): void => \{([^}]*)\}/.exec(app)?.[1] ?? ''
  assert(/setView\('runs'\)/.test(planRun) && /setPlanPending\(true\)/.test(planRun), `the Plan a Run command lands in the Runs view and asks it for the sheet: ${planRun}`)
}
// The Runs rail badge (2026-10-19 prework-responses, mockup 05): Runs with responses waiting, none at 0.
{
  const { build } = await import('esbuild')
  const { createRequire } = await import('node:module')
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const bundled = await build({
    stdin: { contents: "export { ToolsRail } from './src/renderer/src/components/ToolsRail.tsx'; export { createElement } from 'react'; export { renderToStaticMarkup } from 'react-dom/server'", resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'tsx' },
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', logLevel: 'silent', loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"production"' }
  })
  const dir = mkdtempSync(join(tmpdir(), 'tw-tools-rail-'))
  writeFileSync(join(dir, 'rail.cjs'), bundled.outputFiles[0].text)
  const { ToolsRail, createElement, renderToStaticMarkup } = createRequire(join(dir, 'x.cjs'))('./rail.cjs')
  const html = renderToStaticMarkup(createElement(ToolsRail, { view: 'runs', onSelect() {}, badges: { runs: 2 } }))
  assert.match(html, /data-tools-rail="runs"[^>]*title="Runs: 2 with responses waiting"/)
  assert.match(html, /data-tools-rail-badge="runs">2</)
  assert.equal([...html.matchAll(/data-tools-rail-badge=/g)].length, 1, 'only Runs carries a badge')
  const none = renderToStaticMarkup(createElement(ToolsRail, { view: 'runs', onSelect() {}, badges: { runs: 0 } }))
  assert.equal(none.includes('data-tools-rail-badge'), false, 'no badge at 0')
  const app = readFileSync(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8')
  assert(/badges=\{\{ runs: runsWithResponsesNow \}\}/.test(app), 'the Tools window passes the Runs count to the rail')
}
console.log('PASS tools views: one list, five rail items with pre-work on and two off, Run reference checked, three surfaces use it')
