// Work-files ticket 10: the Run page (src/shared/run-page.ts, src/main/run-page.ts, RunPage.tsx).
//   1. every checklist action has the effect the ticket names (ticket 16 wires Publish and Preview page);
//   2. a work file reads as a checklist file state (title, steps, first blocking finding in words);
//   3. the page renders from the checklist model for the four drawn Runs: counters (N of M), step order,
//      current step, the Mark as delivered action on the Delivered step, Go live before the date,
//      Open results disabled with its reason before the session, Publish for this run and Preview page
//      enabled; while publishing, a progress row; once published, the three links, the QR code of the link
//      runQrTarget names, Copy invitation text and Unpublish (ticket 16);
//   3b. the Unpublish confirmation (ticket 17): the locked text naming the pages the Run published and the
//      real answer count, the sheet's markup, and that Unpublish asks before it does anything;
//   3c. the confirmation is a modal: background inert, Tab kept inside, Return only from Unpublish (jsdom);
//   3d. (2026-10-19 prework-responses) the answers section in jsdom: status strip with the new count and the
//      last pull, route tags, a Local only step, the New divider and dots, filters, Mark all read, Copy and
//      Export with no participant ids, read state on leaving the Run; offline, all Local only, no live service, none yet;
//   4. main: files read from the vault's Work files folder; Mark as delivered writes the Run through the
//      atomic writer and refuses an unsafe talk slug, an unsafe Run id, a vault that is not open and a
//      Run that is not planned; Open file opens only the Run's own attached file inside the vault;
//      Preview page builds inside the vault and opens only there; the QR handler takes http(s) links only;
//      Extras for this run (ticket 24) are checked, kept on the Run through the checked writer, refused in words;
//   5. (issue 256) two open vaults with the same talk and Run id: Go live reads the Run and its outline from the
//      selected Run's vault, Open results names that vault and History refuses a vault it does not list, and
//      Open live view asks for the session of the named vault only.
// Usage: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/test-run-page.mjs
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { runActionEffect, runPageChecklist, unpublishConfirmText, workFileState } from '../src/shared/run-page.ts'
import { registerRunPageIpc } from '../src/main/run-page.ts'
import { GO_LIVE_REFUSED, goLiveFromSessions, openResultsFromSessions } from '../src/renderer/src/lib/session-run-actions.ts'
import { RESULTS_OTHER_VAULT, historyResultsRefusal } from '../src/shared/tools-views.ts'

const repo = fileURLToPath(new URL('..', import.meta.url))
const TZ = 'Europe/London'
const NOW = new Date('2026-10-14T10:00:00Z')
const PUB = '2026-10-14T08:00:00Z'
const PRE = { title: 'Research teams intake', steps: 4 }
const POST = { title: 'Session feedback', steps: 3 }

// ---- 1. actions
{
  const effects = {
    'edit-plan': 'plan-sheet', 'change-pre-time': 'plan-sheet', 'change-post-time': 'plan-sheet', 'open-pre-file': 'open-work-file', 'open-post-file': 'open-work-file',
    'go-live': 'go-live', 'open-live-view': 'open-live-view', 'open-results': 'open-results', 'mark-delivered': 'mark-delivered'
  }
  for (const [id, kind] of Object.entries(effects)) assert.equal(runActionEffect(id)?.kind, kind, id)
  assert.equal(runActionEffect('open-pre-file').phase, 'pre')
  assert.equal(runActionEffect('open-post-file').phase, 'post')
  for (const id of ['publish', 'publish-again']) assert.equal(runActionEffect(id)?.kind, 'publish', id)
  assert.equal(runActionEffect('preview-page')?.kind, 'preview-page')
  console.log('ok  1 actions')
}

// ---- 2. work file state
{
  const good = ['---', 'id: research-teams-intake', 'title: Research teams intake', 'revision: 1', '---', 'Hello.', '', '### Watch', '{id=watch}{video}', '', '### Try', '{id=try}{task}', ''].join('\n')
  assert.deepEqual(workFileState(good), { title: 'Research teams intake', steps: 2 })
  const bad = good.replace('{id=try}{task}', '{id=watch}{task}')
  const state = workFileState(bad)
  assert.equal(state.steps, 2)
  assert.match(state.blocking, /share the id “watch”/)
  assert.match(workFileState('---\nid: x\ntitle: X\n---\nNo steps.\n').blocking, /no steps/)
  console.log('ok  2 work file state')
}

// ---- 3. the page
// One bundle holds the page, react and the server renderer, so there is a single copy of react.
const bundled = await build({
  stdin: { contents: "export { RunPage } from './src/renderer/src/components/RunPage.tsx'; export { UnpublishRunConfirm } from './src/renderer/src/components/UnpublishRunConfirm.tsx'; export { createElement } from 'react'; export { renderToStaticMarkup } from 'react-dom/server'", resolveDir: repo, loader: 'tsx' },
  bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', logLevel: 'silent', loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"production"' }
})
const dir = mkdtempSync(join(tmpdir(), 'tw-run-page-'))
writeFileSync(join(dir, 'page.cjs'), bundled.outputFiles[0].text)
const { RunPage, UnpublishRunConfirm, createElement, renderToStaticMarkup } = createRequire(join(dir, 'x.cjs'))('./page.cjs')
const page = (source, now, options = {}) => {
  const checklist = runPageChecklist(source, now, options)
  return { checklist, html: renderToStaticMarkup(createElement(RunPage, { source, checklist, onEffect() {}, onCopy() {}, block: options.block })) }
}

const pre = (opens, closes, extra = {}) => ({ fileId: 'research-teams-intake', opens, closes, timeZone: TZ, ...extra })
const post = (closes, extra = {}) => ({ fileId: 'session-feedback', opens: 'session-end', closes, timeZone: TZ, ...extra })
const FOUR = {
  said: { vaultId: 'v1', talkSlug: 'ai-research', runId: 'said', talkTitle: 'AI for research teams', eventTitle: 'Saïd workshop', status: 'planned', plannedDate: '2026-10-21', startTime: '14:00', expectedPeople: 18, timeZone: TZ, handoutUrl: 'https://handouts.fyi/dl/said-21-oct', answers: { pre: 7 }, sent: ['pre', 'post'],
    work: { pre: pre('2026-10-14T09:00', '2026-10-21T13:00', { publishedAt: PUB }), post: post('2026-11-04T17:00', { publishedAt: PUB }) } },
  keble: { vaultId: 'v1', talkSlug: 'ai-teaching', runId: 'keble', talkTitle: 'Generative AI in teaching', eventTitle: 'Keble', status: 'planned', plannedDate: '2026-10-28', startTime: '16:00', expectedPeople: 40, timeZone: TZ, handoutUrl: 'https://handouts.fyi/dl/keble-28-oct', answers: { pre: 31 }, sent: ['pre'],
    work: { pre: pre('2026-10-12T09:00', '2026-10-28T15:00', { publishedAt: '2026-10-12T08:00:00Z' }) } },
  med: { vaultId: 'v1', talkSlug: 'ai-research', runId: 'med', talkTitle: 'AI for research teams', eventTitle: 'Medical Sciences', status: 'planned', plannedDate: '2026-11-04', startTime: '10:00', expectedPeople: 24, timeZone: TZ,
    work: { pre: pre('2026-10-28T09:00', '2026-11-04T09:00'), post: post('2026-11-18T17:00') } },
  itlc: { vaultId: 'v1', talkSlug: 'ai-teaching', runId: 'itlc', talkTitle: 'Generative AI in teaching', eventTitle: 'ITLC lunchtime', status: 'delivered', plannedDate: '2026-10-09', startTime: '12:30', expectedPeople: 15, timeZone: TZ, handoutUrl: 'https://handouts.fyi/dl/itlc-9-oct', answers: { pre: 12 }, endedAt: '2026-10-09T11:30:00Z',
    work: { pre: pre('2026-10-01T09:00', '2026-10-09T11:30', { publishedAt: '2026-10-01T08:00:00Z' }) } }
}
const stepIds = (html) => [...html.matchAll(/data-run-step="([a-z-]+)" data-state="([a-z]+)"/g)].map((m) => `${m[1]}:${m[2]}`).join(' ')
const actionsIn = (html, id) => {
  const start = html.indexOf(`data-run-step="${id}"`)
  const rest = html.slice(start + 10)
  const end = rest.search(/data-run-step=/)
  const body = end < 0 ? rest : rest.slice(0, end)
  return [...body.matchAll(/<button type="button" class="[^"]*" data-run-action="([a-z-]+)"([^>]*)>/g)].map((m) => `${m[1]}${/disabled=""/.test(m[2]) ? '!' : ''}`)
}
{
  const files = { pre: PRE, post: POST }
  const said = page(FOUR.said, NOW, { files })
  assert.match(said.html, /data-run-counter[^>]*>3 of 8</)
  assert.equal(stepIds(said.html), 'planned:done pre-ready:done published:done pre-closes:current delivered:todo post-open:todo post-closes:todo results:todo')
  assert.match(said.html, /data-run-pill[^>]*>Published</)
  assert.match(said.html, /<h1>Saïd workshop<\/h1>/)
  assert.deepEqual(actionsIn(said.html, 'delivered'), ['go-live', 'mark-delivered'], 'Go live is allowed before the session date, Mark as delivered beside it')
  assert.deepEqual(actionsIn(said.html, 'results'), ['open-results!'])
  assert.match(said.html, /title="Available after the session"/)
  assert.deepEqual(actionsIn(said.html, 'planned'), ['edit-plan'])
  assert.deepEqual(actionsIn(said.html, 'pre-ready'), ['open-pre-file'])
  assert.deepEqual(actionsIn(said.html, 'pre-closes'), ['change-pre-time'])
  assert.equal([...said.html.matchAll(/data-run-link="/g)].length, 3, 'handout, pre-work and post-work links')
  // Ticket 16: each link has its own copy button, breaks only between segments, and the post-work link says when it opens.
  assert.equal([...said.html.matchAll(/data-run-link="[a-z-]+"[\s\S]*?class="cp"/g)].length, 3, 'a copy button per link')
  assert.match(said.html, /<span>handouts\.fyi<\/span><span><wbr\/><span>\/dl<\/span><\/span><span><wbr\/><span>\/said-21-oct<\/span>/, 'a link breaks only before a segment')
  assert.match(said.html, /data-run-link="pre-work"[\s\S]*?said-21-oct<\/span><\/span><span><wbr\/><span>\/pre-work</)
  assert.match(said.html, /data-run-link="post-work"[\s\S]*?Post-work · opens after the session/)
  assert.match(said.html, /data-run-published-block[\s\S]*data-run-qr="pre-work"[\s\S]*QR · pre-work/, 'pre-work is open: the QR code is the pre-work link')
  assert.deepEqual([...said.html.matchAll(/data-run-action="(copy-invitation|unpublish)"/g)].map((m) => m[1]), ['copy-invitation', 'unpublish'])
  assert.match(said.html, />Copy invitation text</)
  assert.doesNotMatch(said.html, /<img alt="QR/, 'no QR picture until main has made it')
  const withQr = page(FOUR.said, NOW, { files, block: { qrSvg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' } })
  assert.match(withQr.html, /<img alt="QR code for the pre-work link" src="data:image\/svg\+xml;charset=utf-8,%3Csvg/)
  const after = page(FOUR.said, new Date('2026-10-22T10:00:00Z'), { files })
  assert.match(after.html, /QR · handout/, 'between the windows (post-work not yet open): the handout')
  assert.match(said.html, /data-run-section="pre-answers"[\s\S]*7\/18 answered/)
  assert.match(said.html, /data-run-section="post-answers"/)
  assert.match(said.html, /data-run-section="extras"/)
  // Ticket 24: Extras for this run. None: the summary says so and the Add bar offers Intro note, Link and Slide (Slide is ticket 25).
  assert.match(said.html, /data-run-section="extras"[\s\S]*?data-run-extras-summary="true">none</)
  assert.deepEqual([...said.html.matchAll(/data-run-extra-add="([a-z]+)"([^>]*)>/g)].map((m) => `${m[1]}${/disabled=""/.test(m[2]) ? '!' : ''}`), ['intro', 'link', 'slide!'])
  const withExtras = page({ ...FOUR.said, extras: { intro: 'Bring a laptop <b>now</b>', links: [{ url: 'https://example.org/reading', label: 'Reading list' }, { url: 'https://www.example.net/x' }] } }, NOW, { files })
  assert.match(withExtras.html, /data-run-extras-summary="true">intro note · 2 links</)
  assert.match(withExtras.html, /data-run-extra="intro"[\s\S]*?<small>Bring a laptop &lt;b&gt;now&lt;\/b&gt;<\/small>/, 'the note is text, never markup')
  assert.match(withExtras.html, /data-run-extra="link"[\s\S]*?<b>Reading list<\/b><small>https:\/\/example.org\/reading<\/small>/)
  assert.match(withExtras.html, /<b>example.net<\/b>/, 'a link without a name shows its host')
  assert.deepEqual([...withExtras.html.matchAll(/data-run-extra-add="([a-z]+)"([^>]*)>/g)].map((m) => `${m[1]}${/disabled=""/.test(m[2]) ? '!' : ''}`), ['intro!', 'link', 'slide!'], 'one intro note per Run')

  const med = page(FOUR.med, NOW, { files })
  assert.match(med.html, /data-run-counter[^>]*>2 of 8</)
  assert.match(med.html, /data-run-pill[^>]*>Not published</)
  assert.deepEqual(actionsIn(med.html, 'published'), ['publish', 'preview-page'], 'Publish for this run and Preview page are wired')
  assert.match(med.html, /data-run-action="publish"[^>]*>.*Publish for this run</)
  assert.doesNotMatch(med.html, /data-run-progress/)
  const publishing = page(FOUR.med, NOW, { files, publishing: true })
  assert.match(publishing.html, /data-run-progress[^>]*>.*Uploading page</, 'publishing shows a progress row')
  assert.deepEqual(actionsIn(publishing.html, 'published'), ['publish!'], 'and the publish button waits')
  assert.match(publishing.html, /tw-spin/)
  // the primary Publish is rendered primary
  assert.match(med.html, /class="tw-sess-btn sm pri" data-run-action="publish"/)

  const keble = page(FOUR.keble, NOW, { files: { pre: PRE } })
  assert.match(keble.html, /data-run-counter[^>]*>3 of 6</)
  assert.doesNotMatch(keble.html, /post-answers/)

  const itlc = page(FOUR.itlc, NOW, { files: { pre: PRE } })
  assert.match(itlc.html, /data-run-counter[^>]*>6 of 6</)
  assert.match(itlc.html, /data-run-pill[^>]*>Delivered</)
  assert.deepEqual(actionsIn(itlc.html, 'delivered'), [], 'a delivered Run has no Mark as delivered')
  assert.deepEqual(actionsIn(itlc.html, 'results'), ['open-results'])

  const live = page(FOUR.said, new Date('2026-10-21T13:10:00Z'), { files, live: true })
  assert.deepEqual(actionsIn(live.html, 'delivered'), ['open-live-view'])
  assert.match(live.html, /data-run-pill[^>]*>Live now</)
  assert.deepEqual(actionsIn(live.html, 'results'), ['open-results'], 'results open while the session is live')

  const blocked = page(FOUR.said, NOW, { files: { pre: { ...PRE, blocking: 'The file has no steps' }, post: POST } })
  assert.match(blocked.html, /The file has no steps/)
  console.log('ok  3 the page')
}

// ---- 3b. the Unpublish confirmation (ticket 17; locked mockup state 12)
{
  const said = unpublishConfirmText(FOUR.said)
  assert.deepEqual(said, {
    title: 'Unpublish Saïd workshop?',
    body: 'The handout, the pre-work page and the post-work page will show “This page is not available”. The 7 answers are kept.',
  }, 'the locked text, naming the post-work page and the real count')
  assert.equal(unpublishConfirmText(FOUR.keble).body, 'The handout and the pre-work page will show “This page is not available”. The 31 answers are kept.', 'pre-work only')
  assert.equal(unpublishConfirmText({ ...FOUR.said, answers: { pre: 7, post: 5 } }).body.endsWith('The 12 answers are kept.'), true, 'pre-work and post-work answers together')
  assert.equal(unpublishConfirmText({ ...FOUR.said, answers: { pre: 1 } }).body.endsWith('The 1 answer is kept.'), true)
  assert.equal(unpublishConfirmText({ ...FOUR.said, answers: {} }).body, 'The handout, the pre-work page and the post-work page will show “This page is not available”.', 'no answers: no count')
  assert.equal(unpublishConfirmText({ ...FOUR.said, sent: ['post'] }).body.startsWith('The handout and the post-work page will show'), true, 'post-work only')
  // A phase that never went out is not named; a Run with its handout only is taken off the site.
  assert.equal(unpublishConfirmText({ ...FOUR.said, sent: ['pre'] }).body.startsWith('The handout and the pre-work page will'), true)
  // Ticket 17 round 3 (finding 4): THE sent set main hands in, not the attachments. Pre-work detached after
  // it went out (no attachment, no stamp) is still withdrawn by the job, so the confirmation names its page
  // and the answers kept; an attachment stamped published that is not in the set is not named.
  const detached = { ...FOUR.said, work: { post: FOUR.said.work.post }, sent: ['pre', 'post'], answers: { pre: 7 } }
  assert.equal(unpublishConfirmText(detached).body, 'The handout, the pre-work page and the post-work page will show “This page is not available”. The 7 answers are kept.', 'detached pre-work: named, answers kept')
  assert.equal(unpublishConfirmText({ ...FOUR.said, work: undefined, sent: ['pre'] }).body, 'The handout and the pre-work page will show “This page is not available”. The 7 answers are kept.', 'no attachment at all: from the sent set')
  assert.equal(unpublishConfirmText({ ...FOUR.said, sent: undefined }).body, 'The handout will be taken off the site.', 'the attachments alone are never read')
  assert.deepEqual(unpublishConfirmText({ talkTitle: 'Generative AI in teaching', answers: {} }), { title: 'Unpublish Generative AI in teaching?', body: 'The handout will be taken off the site.' })
  // The sheet: its title, its sentence, Cancel and Unpublish (danger, solid), as drawn.
  const html = renderToStaticMarkup(createElement(UnpublishRunConfirm, { ...said, onCancel() {}, onConfirm() {} }))
  assert.match(html, /role="alertdialog"[^>]*aria-labelledby="tw-unpub-title"/)
  assert.match(html, /<h2 id="tw-unpub-title">Unpublish Saïd workshop\?<\/h2>/)
  assert.match(html, /id="tw-unpub-body">The handout, the pre-work page and the post-work page will show “This page is not available”\. The 7 answers are kept\.</)
  assert.deepEqual([...html.matchAll(/class="([^"]+)" data-unpublish-action="([a-z]+)"/g)].map((m) => `${m[2]}:${m[1]}`), ['cancel:tw-sess-btn', 'confirm:tw-sess-btn dng solid'])
  assert.match(html, />Cancel<\/button>[\s\S]*>Unpublish<\/button>/)
  const busy = renderToStaticMarkup(createElement(UnpublishRunConfirm, { ...said, busy: true, onCancel() {}, onConfirm() {} }))
  assert.equal([...busy.matchAll(/disabled=""/g)].length, 2, 'both buttons wait while it runs')
  // The Run page's Unpublish opens the confirmation (SessionsView), never unpublishes straight away.
  const view = readFileSync(join(repo, 'src/renderer/src/components/SessionsView.tsx'), 'utf8')
  assert.match(view, /onUnpublish: \(\) => \{ if \(runKey\) setConfirming\(runKey\) \}/)
  assert.match(view, /<UnpublishRunConfirm[\s\S]*onConfirm=\{\(\) => \{ void unpublish\(\) \}\}/)
  console.log('ok  3b unpublish confirmation')
}
{
  // 3c. The confirmation is a modal (ticket 17 fix round): the rest of the window is inert while it is open,
  // Tab and Shift+Tab go round its two buttons only, and Return unpublishes only from the Unpublish button.
  // In jsdom (keys are dispatched as the sheet's own handler sees them; jsdom does not move focus itself).
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<!doctype html><body><div id="app"><nav id="rail"><button id="rail-button">Talks</button></nav><div id="view"><section id="page"><button id="page-button">Publish</button></section><div id="host"></div></div></div><aside id="already" inert><button>Kept</button></aside></body>', { pretendToBeVisual: true })
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLButtonElement', 'KeyboardEvent', 'Node', 'Element']) {
    Object.defineProperty(globalThis, name, { value: name === 'window' ? dom.window : dom.window[name], configurable: true, writable: true })
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const domBundle = await build({
    stdin: { contents: "export { UnpublishRunConfirm } from './src/renderer/src/components/UnpublishRunConfirm.tsx'; export { createElement } from 'react'; export { createRoot } from 'react-dom/client'; export { act } from 'react'", resolveDir: repo, loader: 'tsx' },
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', logLevel: 'silent', loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"development"' }
  })
  writeFileSync(join(dir, 'dom.cjs'), domBundle.outputFiles[0].text)
  const R = createRequire(join(dir, 'x.cjs'))('./dom.cjs')
  const doc = dom.window.document
  const calls = []
  const root = R.createRoot(doc.getElementById('host'))
  const show = (busy = false) => R.act(() => root.render(R.createElement(R.UnpublishRunConfirm, { title: 'Unpublish Saïd workshop?', body: 'Body.', busy, onCancel: () => calls.push('cancel'), onConfirm: () => calls.push('confirm') })))
  const key = (keyName, init = {}) => R.act(() => { doc.activeElement.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: keyName, bubbles: true, cancelable: true, ...init })) })
  const action = () => doc.activeElement?.getAttribute('data-unpublish-action') ?? doc.activeElement?.id ?? null
  show()
  assert.equal(action(), 'confirm', 'Unpublish has the focus when the sheet opens')
  assert.deepEqual(['rail', 'page', 'already'].map((id) => doc.getElementById(id).hasAttribute('inert')), [true, true, true], 'everything outside the sheet is inert')
  assert.equal(doc.querySelector('[data-unpublish-layer]').hasAttribute('inert'), false, 'the sheet is not')
  key('Tab'); assert.equal(action(), 'cancel', 'Tab goes round to Cancel')
  key('Tab'); assert.equal(action(), 'confirm', 'and back to Unpublish, never out of the sheet')
  key('Tab', { shiftKey: true }); assert.equal(action(), 'cancel', 'Shift+Tab the other way')
  key('Enter'); assert.deepEqual(calls.splice(0), ['cancel'], 'Return on Cancel cancels')
  // Focus somehow outside the sheet (inert stops it in a browser; jsdom lets it through): Return does nothing, Tab comes back.
  doc.getElementById('page-button').focus()
  key('Enter'); assert.deepEqual(calls.splice(0), [], 'Return from anywhere but the sheet\'s buttons does nothing')
  key('Tab'); assert.equal(action(), 'cancel', 'Tab brings the focus back into the sheet')
  doc.querySelector('[data-unpublish-action="confirm"]').focus()
  key('Enter'); assert.deepEqual(calls.splice(0), ['confirm'], 'Return on Unpublish unpublishes')
  key('Escape'); assert.deepEqual(calls.splice(0), ['cancel'], 'Esc cancels')
  // While it runs: both buttons disabled, Return and Esc do nothing, Tab keeps the focus on the sheet.
  show(true)
  key('Tab'); assert.equal(doc.activeElement, doc.querySelector('[data-unpublish-confirm]'))
  key('Enter'); key('Escape'); assert.deepEqual(calls.splice(0), [])
  R.act(() => root.unmount())
  assert.deepEqual(['rail', 'page', 'already'].map((id) => doc.getElementById(id).hasAttribute('inert')), [false, false, true], 'closed: the window is live again; what was inert before stays inert')
  console.log('ok  3c unpublish confirmation is a modal: background inert, focus kept inside, Return only from Unpublish')
}

{
  // 3d. The answers section (2026-10-19 prework-responses, mockups 05 and 06), in jsdom with a stand-in window.tw.
  const { JSDOM } = await import('jsdom')
  const { stepsFromWorkFile, applySeenChange } = await import('../src/shared/run-answers.ts')
  const { normaliseRunPrework } = await import('../src/shared/run-prework.ts')
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>', { pretendToBeVisual: true })
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLButtonElement', 'KeyboardEvent', 'MouseEvent', 'Event', 'Node', 'Element']) {
    Object.defineProperty(globalThis, name, { value: name === 'window' ? dom.window : dom.window[name], configurable: true, writable: true })
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  // React's async act queues its tasks on a MessageChannel when bundled (it cannot reach Node's timers), and each
  // open port would keep the process alive after the test: a stand-in channel delivers on setImmediate instead.
  const NodeMessageChannel = globalThis.MessageChannel
  globalThis.MessageChannel = class { constructor() { const port1 = { onmessage: null }; this.port1 = port1; this.port2 = { postMessage: () => setImmediate(() => port1.onmessage?.({ data: undefined })) } } }
  const bundle = await build({
    stdin: { contents: "export { RunAnswers, LIVE_SERVICE_OUTDATED } from './src/renderer/src/components/RunAnswers.tsx'; export { createElement, useState } from 'react'; export { createRoot } from 'react-dom/client'; export { act } from 'react'", resolveDir: repo, loader: 'tsx' },
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', logLevel: 'silent', loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"development"' }
  })
  writeFileSync(join(dir, 'answers.cjs'), bundle.outputFiles[0].text)
  const R = createRequire(join(dir, 'x.cjs'))('./answers.cjs')
  const doc = dom.window.document
  const FILE = ['---', 'id: intake', 'title: Intake', 'revision: 1', '---', '',
    '### What do you hope for?', '{id=hope}{poll=open}', '', '### Try a prompt', '{id=try}{task}{local}', ''].join('\n')
  const ALL_LOCAL = FILE.replace('{id=hope}{poll=open}', '{id=hope}{poll=open}{local}')
  const person = (n) => n.toString(16).padStart(16, '0')
  const at = (minute) => Date.UTC(2026, 9, 20, 18, minute)
  const answer = (n, minute, text) => ({ id: `${person(n)}:answer:hope`, participant: person(n), stepId: 'hope', kind: 'answer', at: at(minute), text })
  const BASE_PREWORK = normaliseRunPrework({ entries: [answer(1, 1, 'Faster reviews'), answer(2, 31, 'Better abstracts'), answer(3, 32, 'Fewer citations made up'),
    { id: `${person(4)}:q:s4`, participant: person(4), stepId: 'hope', kind: 'question', at: at(33), text: 'Is it safe?', name: 'Alex' }], seen: { through: at(10), at: at(12) } })
  const source = { vaultId: 'v1', talkSlug: 'ai-research', runId: 'said', talkTitle: 'AI for research teams', eventTitle: 'Saïd workshop', status: 'planned', expectedPeople: 18,
    work: { pre: { fileId: 'intake', opens: '2026-10-14T09:00', closes: '2026-10-21T13:00', timeZone: TZ } } }
  const URLs = []
  globalThis.URL.createObjectURL = (blob) => { URLs.push(blob); return 'blob:answers' }
  globalThis.URL.revokeObjectURL = () => {}
  dom.window.HTMLAnchorElement.prototype.click = function click() { URLs.push(this.download) }
  const flush = async () => { for (let i = 0; i < 6; i += 1) await R.act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) }) }
  const text = (selector) => doc.querySelector(selector)?.textContent ?? null
  const click = async (element) => { await R.act(async () => { element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) }); await flush() }
  // `refresh`: 'ok', 'offline', or a function (the call's number) returning the reply; `parent`: a parent that renders
  // again on every pull with a new onPulled, as SessionsView does; `pulls` counts the pulls asked of main.
  async function open({ file = FILE, prework = BASE_PREWORK, status = { pulledAt: Date.UTC(2026, 9, 20, 9, 12) }, refresh = 'ok', live = 'ready', runPhase = 'published', parent = false, pullTimeoutMs, statusHang = false } = {}) {
    const seen = []
    const pulls = { n: 0 }
    const statusCalls = { n: 0 }
    let held = prework
    window.tw = {
      sessions: { runAnswers: async () => ({ ok: true, pre: { source: 'file', steps: stepsFromWorkFile(file) }, ...(held ? { prework: held } : {}), writable: true }) },
      history: {
        // `statusHang`: the first status (the row check on opening) answers; every later one never does.
        preworkStatus: async () => {
          statusCalls.n += 1
          if (statusHang && statusCalls.n > 1) return new Promise(() => {})
          return status ? { preworkId: 'pw00000a', phase: 'pre', opensAt: 0, closesAt: 0, ...status } : null
        },
        preworkRefresh: async () => {
          pulls.n += 1
          if (typeof refresh === 'function') return refresh(pulls.n, held)
          return refresh === 'ok' ? { ok: true, run: { prework: held }, added: 0, changed: false } : { ok: false, error: 'Pre-work: the pre-work service could not be reached. Try again.', run: { prework: held } }
        },
        preworkSeen: async (_slug, _run, change) => { seen.push(change); held = applySeenChange(held, change, at(50)) ?? held; return { ok: true, run: { prework: held } } },
        preworkPick: async () => ({ ok: false, error: 'not here' }), preworkQuestion: async () => ({ ok: false, error: 'not here' }), preworkFeeds: async () => ({ ok: false })
      },
      liveService: { status: async () => (live === 'hang' ? new Promise(() => {}) : typeof live === 'string' ? { state: live } : live), setUp: async () => ({}) }
    }
    const host = doc.getElementById('host')
    const root = R.createRoot(host)
    const props = { source, runPhase, onOpenWorkFile: () => seen.push('open-work-file'), ...(pullTimeoutMs ? { pullTimeoutMs } : {}) }
    function Parent() {
      const [renders, setRenders] = R.useState(0)
      // A new onPulled on every render, the way SessionsView passes `() => { void load() }`.
      return R.createElement(R.RunAnswers, { ...props, onPulled: () => { seen.push('pulled'); setRenders(renders + 1) } })
    }
    await R.act(async () => { root.render(parent ? R.createElement(Parent) : R.createElement(R.RunAnswers, props)) })
    await flush()
    return { seen, root, pulls, close: async () => { await R.act(async () => { root.unmount() }); await flush() } }
  }

  // Answers in, two of them since he last looked, and a question about the step.
  let view = await open()
  assert.equal(text('[data-run-new-count]'), '3 new since you last looked', 'two answers and the question are new')
  assert.match(text('[data-run-pulled]'), /^Pulled (\d\d:\d\d|\S+ \d+ \w+ \d\d:\d\d) · live service reached$/)
  assert.equal(text('[data-run-route="sent"]'), 'Sent to you')
  assert.equal(text('[data-run-route="local"]'), 'Local only')
  assert.match(text('[data-run-local-step="try"]'), /Marked Local only\. Answers stay on each phone/)
  assert.match(text('[data-run-answer-step="hope"] .sum'), /3 answers · 3 new$/)
  assert.match(text('[data-run-new-divider="hope"]'), /^2 new · arrived since \w{3} 20 Oct \d\d:\d\d$/)
  assert.deepEqual([...doc.querySelectorAll('[data-run-answer]')].map((row) => [row.querySelector('.tx').textContent, row.getAttribute('data-new')]),
    [['Faster reviews', null], ['Better abstracts', 'true'], ['Fewer citations made up', 'true']], 'old rows, then the divider, then the new ones with a dot')
  assert.deepEqual([...doc.querySelectorAll('[data-run-filter]')].map((chip) => chip.textContent), ['All', 'New · 3', 'Starred · 0', 'Questions · 1'])
  // Filters: New keeps only what is new, the question included.
  await click(doc.querySelector('[data-run-filter="new"]'))
  assert.deepEqual([...doc.querySelectorAll('[data-run-answer]')].map((row) => row.querySelector('.tx').textContent), ['Better abstracts', 'Fewer citations made up'])
  assert.equal(doc.querySelectorAll('[data-run-question]').length, 1)
  await click(doc.querySelector('[data-run-filter="questions"]'))
  assert.deepEqual([doc.querySelectorAll('[data-run-answer]').length, doc.querySelectorAll('[data-run-question]').length], [0, 1])
  await click(doc.querySelector('[data-run-filter="all"]'))
  // A dot keeps one unread; Copy and Export carry no participant or entry id.
  await click(doc.querySelector('[data-run-answer] [data-run-keep-unread]'))
  assert.deepEqual(view.seen.at(-1), { type: 'keep', id: `${person(2)}:answer:hope`, unread: true })
  assert.equal(doc.querySelector('[data-run-answer] [data-run-keep-unread]').getAttribute('aria-pressed'), 'true')
  await click(doc.querySelector('[data-run-export="export"]'))
  assert.deepEqual([...doc.querySelectorAll('[data-run-export-menu] b')].map((b) => b.textContent), ['Copy as text', 'Copy starred only', 'Export section as CSV', 'Export section as Markdown'])
  await click(doc.querySelector('[data-run-download="csv"]'))
  await click(doc.querySelector('[data-run-export="export"]'))
  await click(doc.querySelector('[data-run-download="md"]'))
  const files = await Promise.all(URLs.filter((item) => typeof item !== 'string').map((blob) => blob.text()))
  assert.deepEqual(URLs.filter((item) => typeof item === 'string'), ['ai-research-said-pre-work-answers.csv', 'ai-research-said-pre-work-answers.md'])
  for (const out of files) for (let n = 1; n <= 4; n += 1) assert.equal(out.includes(person(n)), false, 'no participant id in an export')
  assert.match(files[0], /"question","Is it safe\?","[^"]+","no","no","Alex"/)
  // Mark all read, then leaving the Run marks what was on show read.
  await click(doc.querySelector('[data-run-mark-all-read]'))
  assert.deepEqual(view.seen.at(-1), { type: 'all' })
  assert.equal(doc.querySelector('[data-run-new-count]'), null, 'nothing new after Mark all read')
  await view.close()
  assert.deepEqual(view.seen.at(-1), { type: 'leave' }, 'leaving the Run marks it read')

  // Offline: the last pull, Try again, and the reassurance that nothing is lost.
  view = await open({ refresh: 'offline' })
  assert.equal(text('[data-run-offline]'), 'Cannot reach the live service')
  assert.match(text('[data-run-pulled]'), /^Last pulled /)
  assert.equal(text('[data-run-pull="pre"]'), 'Try again')
  assert.match(text('[data-run-offline-note]'), /Nothing is lost: participants’ answers are kept on the live service until you pull them/)
  assert.match(text('[data-run-answered]'), /answered when last pulled$/)
  assert.equal(doc.querySelector('[data-run-answers-notice]'), null, 'the unreachable service is the strip, not a notice')
  await view.close()

  // Every answer step Local only: nothing collected, by design, and the way to the file.
  view = await open({ file: ALL_LOCAL, prework: null })
  assert.equal(text('[data-run-answers-local] h3'), 'Every answer step is Local only')
  assert.equal(text('[data-run-answered]'), '0 collected by design')
  await click(doc.querySelector('[data-run-open-work-file="pre"]'))
  assert.equal(view.seen.at(-1), 'open-work-file')
  await view.close()
  assert.equal(view.seen.includes('leave') || view.seen.some((change) => change?.type === 'leave'), false, 'nothing was on show, so nothing is marked read')

  // Never sent and no live service: a full-state message with the set-up button.
  view = await open({ prework: null, status: null, live: 'not-set-up' })
  assert.equal(text('[data-run-answers-nolive] h3'), 'Responses need the live service')
  assert.equal(text('[data-run-set-up-live]'), 'Set up the live service')
  await view.close()

  // Published, nothing in yet: when it closes, Pull now, and how many steps are Local only.
  view = await open({ prework: null })
  assert.equal(text('[data-run-answers-none] h3'), 'No responses yet')
  assert.match(text('[data-run-answers-none] p'), /^The pre-work page closes .+\. When someone sends an answer or a question/)
  assert.equal(text('[data-run-local-count]'), 'Steps marked Local only never appear here: 1 of 2 steps.')
  assert.equal(text('[data-run-answers-none] [data-run-pull="pre"]'), 'Pull now')
  await view.close()
  // 3e. Every pull ends in a plain state; none stays on "Pulling…" (0.41.0-preview.3: the strip never left it).
  const pullState = () => doc.querySelector('[data-run-pulled]')?.getAttribute('data-run-pull-state') ?? null
  const pullButton = () => doc.querySelector('[data-run-strip="pre"] [data-run-pull="pre"]')
  const settle = async () => { for (let i = 0; i < 4; i += 1) await flush() }

  // A parent that renders again on every pull (a new onPulled each time) gets exactly one pull on opening.
  view = await open({ parent: true, refresh: (n, held) => ({ ok: true, run: { prework: held }, added: 0, changed: n === 1 }) })
  await settle()
  assert.equal(view.pulls.n, 1, 'opening the Run pulls once, however often the parent renders again')
  assert.equal(view.seen.filter((item) => item === 'pulled').length, 1)
  assert.equal(doc.querySelector('[data-run-pulling]'), null, 'the strip left "Pulling…"')
  assert.equal(pullState(), 'pulled')
  assert.match(text('[data-run-pulled]'), / · live service reached$/)
  // Pull now: exactly one pull, the button disabled while it runs, and a second click then does nothing.
  let release
  await view.close()
  view = await open({ parent: true, refresh: (n, held) => (n === 1 ? { ok: true, run: { prework: held }, added: 0, changed: false } : new Promise((resolve) => { release = () => resolve({ ok: true, run: { prework: held }, added: 0, changed: false }) })) })
  assert.equal(view.pulls.n, 1)
  assert.equal(pullButton().textContent, 'Pull now')
  await click(pullButton())
  assert.equal(view.pulls.n, 2, 'Pull now pulls once')
  assert.ok(doc.querySelector('[data-run-pulling]'), 'pulling while the pull runs')
  assert.equal(pullButton().disabled, true, 'Pull now is disabled while a pull runs')
  await R.act(async () => { pullButton().disabled = false; pullButton().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  await flush()
  assert.equal(view.pulls.n, 2, 'a click while a pull runs starts no second pull')
  await R.act(async () => { release() })
  await settle()
  assert.equal(view.pulls.n, 2, 'and none after it ends')
  assert.equal(pullState(), 'pulled')
  assert.equal(pullButton().disabled, false)
  await view.close()

  // Pre-work closed: what was pulled, and when.
  view = await open({ runPhase: 'pre-closed' })
  assert.match(text('[data-run-pulled]'), /^Pre-work closed · last pulled (\d\d:\d\d|\S+ \d+ \w+ \d\d:\d\d)$/)
  assert.equal(pullButton().textContent, 'Pull now')
  await view.close()

  // Refused (the same Run in another vault): the reason as a notice, the last pull, Try again.
  const OTHER = 'These answers belong to the same Run in another vault, so nothing was changed here.'
  view = await open({ refresh: (_n, held) => ({ ok: false, error: OTHER, run: { prework: held } }) })
  assert.equal(pullState(), 'refused')
  assert.match(text('[data-run-pulled]'), /^Last pulled /)
  assert.equal(text('[data-run-answers-notice="pre"]'), OTHER)
  assert.equal(pullButton().textContent, 'Try again')
  await view.close()

  // An older live service (its build is not this app's) refusing the pull: it needs an update.
  view = await open({ refresh: (_n, held) => ({ ok: false, error: 'The answers could not be read (HTTP 404).', run: { prework: held } }), live: { state: 'ready', build: '24-live-recovery', appBuild: '25-prework-responses' } })
  assert.equal(pullState(), 'outdated')
  assert.equal(text('[data-run-outdated]'), R.LIVE_SERVICE_OUTDATED)
  assert.equal(R.LIVE_SERVICE_OUTDATED, 'The live service needs an update before answers can be pulled')
  assert.match(text('[data-run-outdated-note]'), /updates the live service before you next go live/)
  assert.match(text('[data-run-pulled]'), /^Last pulled /)
  assert.equal(pullButton().textContent, 'Try again')
  await view.close()

  // Deleted after 60 days: the reason, the last pull, and no button (nothing is left to pull).
  view = await open({ refresh: (_n, held) => ({ ok: false, error: 'Pre-work: Pre-work was deleted after 60 days without activity; the answers already pulled stay on the Run.', run: { prework: held } }) })
  assert.equal(pullState(), 'purged')
  assert.match(text('[data-run-answers-notice="pre"]'), /deleted after 60 days/)
  assert.equal(pullButton(), null)
  await view.close()

  // The bridge throwing: offline, never "Pulling…".
  view = await open({ refresh: () => { throw new Error('no reply') } })
  assert.equal(pullState(), 'offline')
  assert.equal(text('[data-run-offline]'), 'Cannot reach the live service')
  await view.close()

  // No reply at all: after the page's own timeout it is offline, with Try again; a later answer is still taken.
  let late
  view = await open({ pullTimeoutMs: 40, refresh: (n, held) => (n === 1 ? new Promise((resolve) => { late = () => resolve({ ok: true, run: { prework: held }, added: 0, changed: false }) }) : { ok: true, run: { prework: held }, added: 0, changed: false }) })
  assert.ok(doc.querySelector('[data-run-pulling]'), 'pulling until the timeout')
  await R.act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)) })
  await settle()
  assert.equal(pullState(), 'offline', 'the timeout ends the pull as offline')
  assert.equal(pullButton().textContent, 'Try again')
  assert.equal(pullButton().disabled, false)
  await R.act(async () => { late() })
  await settle()
  assert.equal(pullState(), 'pulled', 'the late answer is taken')
  await view.close()

  // (Review round 1.) Every deferred request below is answered before the next case: an unanswered one is shared
  // with any page that opens the same Run and phase.
  const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done }); return { promise, resolve } }
  const okReply = (held) => ({ ok: true, run: { prework: held }, added: 0, changed: true })

  // Try again during an unresolved pull after the timeout sends no second request; the answer then lands once.
  let reply = deferred()
  view = await open({ parent: true, pullTimeoutMs: 40, refresh: () => reply.promise })
  await R.act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)) })
  await settle()
  assert.equal(pullState(), 'offline')
  await click(pullButton())
  assert.equal(view.pulls.n, 1, 'Try again while the first request is unanswered sends no second request')
  assert.ok(doc.querySelector('[data-run-pulling]'), 'Try again shows the pull again')
  // A late answer to the first pull, after a newer one started: applied once, by the newer pull only.
  await R.act(async () => { reply.resolve(okReply(BASE_PREWORK)) })
  await settle()
  assert.equal(pullState(), 'pulled')
  assert.equal(view.seen.filter((item) => item === 'pulled').length, 1, 'onPulled once: the older pull applied nothing')
  assert.equal(view.pulls.n, 1)
  await view.close()

  // The page opened again while a pull is unanswered: no second request; the closed page hears nothing.
  reply = deferred()
  const first = await open({ parent: true, pullTimeoutMs: 5000, refresh: () => reply.promise })
  assert.equal(first.pulls.n, 1)
  await first.close()
  view = await open({ pullTimeoutMs: 5000, refresh: () => { throw new Error('a second request') } })
  assert.equal(view.pulls.n, 0, 'the page opened again waits for the same request')
  assert.ok(doc.querySelector('[data-run-pulling]'))
  await R.act(async () => { reply.resolve(okReply(BASE_PREWORK)) })
  await settle()
  assert.equal(pullState(), 'pulled', 'the reopened page takes the shared answer')
  assert.equal(first.seen.includes('pulled'), false, 'the closed page does not call onPulled')
  await view.close()

  // A status lookup that never answers still ends the pull, well within the timeout.
  view = await open({ statusHang: true, pullTimeoutMs: 5000 })
  assert.equal(doc.querySelector('[data-run-pulling]'), null)
  assert.equal(pullState(), 'pulled')
  await view.close()
  // An older-build lookup that never answers ends in the plain refusal by the deadline.
  view = await open({ live: 'hang', pullTimeoutMs: 40, refresh: (_n, held) => ({ ok: false, error: 'The answers could not be read (HTTP 404).', run: { prework: held } }) })
  await R.act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)) })
  await settle()
  assert.equal(doc.querySelector('[data-run-pulling]'), null, 'the deadline ends the pull though the lookup never answered')
  assert.equal(pullState(), 'refused')
  await view.close()

  // (Review round 2.) Pre-work's request hangs past the deadline: post-work is still asked and settles; pre-work's
  // late answer then applies once, and onPulled fires once for each phase.
  {
    const preReply = deferred()
    const calls = []
    const heard = []
    const twoPhase = { ...source, work: { ...source.work, post: { fileId: 'intake', opens: 'session-end', closes: '2026-10-22T13:00', timeZone: TZ } } }
    window.tw = {
      sessions: { runAnswers: async () => ({ ok: true, pre: { source: 'file', steps: stepsFromWorkFile(FILE) }, post: { source: 'file', steps: stepsFromWorkFile(FILE) }, prework: BASE_PREWORK, postwork: BASE_PREWORK, writable: true }) },
      history: {
        preworkStatus: async (_slug, _run, phase) => ({ preworkId: phase === 'post' ? 'pw00000b' : 'pw00000a', phase, opensAt: 0, closesAt: 0, pulledAt: at(0) }),
        preworkRefresh: async (_slug, _run, phase) => { calls.push(phase); return phase === 'pre' ? preReply.promise : { ok: true, run: { postwork: BASE_PREWORK }, added: 0, changed: true } },
        preworkSeen: async () => ({ ok: false, error: 'not here' }), preworkPick: async () => ({ ok: false, error: 'not here' }), preworkQuestion: async () => ({ ok: false, error: 'not here' }), preworkFeeds: async () => ({ ok: false })
      },
      liveService: { status: async () => ({ state: 'ready' }), setUp: async () => ({}) }
    }
    const root = R.createRoot(doc.getElementById('host'))
    await R.act(async () => { root.render(R.createElement(R.RunAnswers, { source: twoPhase, runPhase: 'published', pullTimeoutMs: 40, onPulled: () => heard.push('pulled') })) })
    await flush()
    const stateOf = (phase) => doc.querySelector(`[data-run-strip="${phase}"] [data-run-pulled]`)?.getAttribute('data-run-pull-state') ?? null
    assert.deepEqual(calls, ['pre'], 'pre-work is asked first')
    await R.act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)) })
    await settle()
    assert.deepEqual(calls, ['pre', 'post'], 'post-work is asked once pre-work passed its deadline, though pre-work has not answered')
    assert.equal(stateOf('pre'), 'offline')
    assert.equal(stateOf('post'), 'pulled', 'post-work settles while pre-work still waits')
    assert.equal(heard.length, 1, 'onPulled for post-work')
    await R.act(async () => { preReply.resolve(okReply(BASE_PREWORK)) })
    await settle()
    assert.equal(stateOf('pre'), 'pulled', 'pre-work\'s late answer applies')
    assert.equal(heard.length, 2, 'onPulled once more, for pre-work')
    assert.deepEqual(calls, ['pre', 'post'], 'no further requests')
    await R.act(async () => { root.unmount() })
    await flush()
  }

  // Another Run opened while a pull is unanswered: nothing of it reaches the new Run, and onPulled is not called.
  {
    reply = deferred()
    const calls = []
    const other = { ...source, runId: 'other', eventTitle: 'Other workshop' }
    const FROM_A = normaliseRunPrework({ entries: [answer(9, 40, 'From run A only')] })
    window.tw = {
      sessions: { runAnswers: async ({ runId }) => ({ ok: true, pre: { source: 'file', steps: stepsFromWorkFile(FILE) }, ...(runId === 'said' ? { prework: BASE_PREWORK } : {}), writable: true }) },
      history: {
        preworkStatus: async (_slug, runId) => (runId === 'said' ? { preworkId: 'pw00000a', phase: 'pre', opensAt: 0, closesAt: 0, pulledAt: at(0) } : null),
        preworkRefresh: async (_slug, runId) => { calls.push(runId); return runId === 'said' ? reply.promise : okReply(null) },
        preworkSeen: async () => ({ ok: false, error: 'not here' }), preworkPick: async () => ({ ok: false, error: 'not here' }), preworkQuestion: async () => ({ ok: false, error: 'not here' }), preworkFeeds: async () => ({ ok: false })
      },
      liveService: { status: async () => ({ state: 'ready' }), setUp: async () => ({}) }
    }
    const heard = []
    const root = R.createRoot(doc.getElementById('host'))
    const show = async (src) => { await R.act(async () => { root.render(R.createElement(R.RunAnswers, { source: src, runPhase: 'published', pullTimeoutMs: 5000, onPulled: () => heard.push(src.runId) })) }); await flush() }
    await show(source)
    assert.deepEqual(calls, ['said'])
    await show(other)
    await R.act(async () => { reply.resolve({ ok: true, run: { prework: FROM_A }, added: 1, changed: true }) })
    await settle()
    assert.equal(doc.body.textContent.includes('From run A only'), false, 'the first Run\'s answer is not shown on the other Run')
    assert.equal(doc.querySelector('[data-run-strip="pre"]'), null, 'the other Run (never sent) has no strip')
    assert.deepEqual(heard, [], 'onPulled is not called for the Run left behind')
    await R.act(async () => { root.unmount() })
    await flush()
  }

  // Nothing in yet, offline: the empty state says so beside its Pull now.
  view = await open({ prework: null, refresh: 'offline' })
  assert.equal(doc.querySelector('[data-run-answers-none] [data-run-pull-state]').getAttribute('data-run-pull-state'), 'offline')
  assert.match(text('[data-run-answers-none] [data-run-pull-state]'), /^Cannot reach the live service · Last pulled /)
  assert.equal(text('[data-run-answers-none] [data-run-pull="pre"]'), 'Try again')
  await view.close()
  console.log('ok  3e every pull ends in a state: pulled once on opening, Pull now pulls once and is disabled meanwhile, closed, refused, outdated, purged, thrown, timed out, empty and offline; shared request on Try again and reopening, hanging lookups, late answers, Run switched; a hung pre-work does not hold post-work')

  dom.window.close()
  globalThis.MessageChannel = NodeMessageChannel
  console.log('ok  3d answers section: strip, routes, Local only, divider and dots, filters, Mark all read, exports without ids, read on leaving; offline, all local, no live service, none yet')
}

// ---- 4. main
{
  const root = mkdtempSync(join(tmpdir(), 'tw-run-page-vault-'))
  const outside = mkdtempSync(join(tmpdir(), 'tw-run-page-outside-'))
  mkdirSync(join(root, '_PRESENTATIONS', 'ai-research'), { recursive: true })
  mkdirSync(join(root, 'Work files'), { recursive: true })
  const runFile = (slug, id) => join(root, '_PRESENTATIONS', slug, `${id}.json`)
  const record = (id, extra = {}) => ({ id, talkSlug: 'ai-research', talkTitle: 'AI for research teams', kind: 'delivery', status: 'planned', slideSet: { kind: 'full' }, plannedDate: '2026-10-21', startTime: '14:00', timeZone: TZ, eventTitle: 'Saïd workshop', startedAt: '2026-10-21T00:00:00.000Z', endedAt: '', recordingMs: 0, wallClockMs: 0, timerTargetMin: 0, context: null, pathwayId: null, audio: null, transcript: null, slideTimeIndex: [], polls: [], pollResponses: [], work: { pre: pre('2026-10-14T09:00', '2026-10-21T13:00') }, ...extra })
  writeFileSync(runFile('ai-research', 'said'), JSON.stringify(record('said')))
  writeFileSync(runFile('ai-research', 'done'), JSON.stringify(record('done', { status: 'delivered', endedAt: '2026-10-21T15:00:00.000Z' })))
  writeFileSync(runFile('ai-research', 'gone'), JSON.stringify(record('gone', { work: { pre: pre('2026-10-14T09:00', '2026-10-21T13:00', { fileId: 'not-there' }) } })))
  writeFileSync(join(root, 'Work files', 'research-teams-intake.md'), ['---', 'id: research-teams-intake', 'title: Research teams intake', 'revision: 1', '---', '', '### Watch', '{id=watch}{video}', ''].join('\n'))
  writeFileSync(join(outside, 'secret.md'), 'x')

  const handlers = new Map()
  const opened = []
  const delivered = []
  let focus = false
  registerRunPageIpc({
    ipcMain: { handle: (channel, listener) => handlers.set(channel, listener) },
    vaults: () => [{ id: 'v1', root }], openPath: async (path) => { opened.push(path); return '' }, focusLive: () => focus, onDelivered: (slug, id, vaultRoot) => delivered.push(`${slug}/${id}${vaultRoot === root ? '' : ' in another vault'}`)
  })
  const call = (channel, payload) => handlers.get(channel)({}, payload)
  const said = { vaultId: 'v1', talkSlug: 'ai-research', runId: 'said' }

  assert.deepEqual(await call('sessions:run-files', said), { ok: true, files: { pre: { title: 'Research teams intake', steps: 1 } } })
  const noFile = await call('sessions:run-files', { ...said, runId: 'gone' })
  assert.deepEqual(noFile.files, {}, 'an attached file that is not there reads as absent')

  for (const bad of [{ ...said, talkSlug: '../escape' }, { ...said, runId: '../../x' }, { ...said, talkSlug: '/abs' }, { ...said, vaultId: 'other' }, { ...said, vaultId: 7 }, null, 'said'])
    for (const channel of ['sessions:run-files', 'sessions:mark-delivered', 'sessions:open-work-file']) assert.equal((await call(channel, bad)).ok, false, `${channel} ${JSON.stringify(bad)}`)
  assert.equal(delivered.length, 0)

  const marked = await call('sessions:mark-delivered', said)
  assert.deepEqual(marked, { ok: true })
  const stored = JSON.parse(readFileSync(runFile('ai-research', 'said'), 'utf8'))
  assert.equal(stored.status, 'delivered')
  assert.ok(Date.parse(stored.endedAt) >= Date.parse(stored.startedAt) && stored.endedAt, 'ends no earlier than it started')
  assert.equal(stored.eventTitle, 'Saïd workshop')
  assert.equal(stored.work.pre.closes, '2026-10-21T13:00', 'the plan is kept')
  assert.deepEqual(readdirSync(join(root, '_PRESENTATIONS', 'ai-research')).sort(), ['done.json', 'gone.json', 'said.json'], 'no temporary file is left')
  assert.deepEqual(delivered, ['ai-research/said'])
  assert.equal((await call('sessions:mark-delivered', said)).ok, false, 'a delivered Run is not marked again')
  assert.equal((await call('sessions:mark-delivered', { ...said, runId: 'done' })).ok, false)

  const open = await call('sessions:open-work-file', { ...said, phase: 'pre' })
  assert.equal(open.ok, true)
  assert.equal(open.fileName, 'research-teams-intake.md', 'Open file names the work file for the Work files view')
  assert.equal(open.vaultId, 'v1', 'and the vault it is in')
  assert.equal(opened.length, 0, 'Open file never hands the work file to the operating system')
  assert.equal((await call('sessions:open-work-file', { ...said, phase: 'post' })).ok, false, 'no post-work attached')
  const missing = await call('sessions:open-work-file', { ...said, runId: 'gone', phase: 'pre' })
  assert.equal(missing.ok, false)
  assert.match(missing.error, /not-there/, 'a file that is not there is named')
  assert.equal(opened.length, 0)
  assert.equal((await call('sessions:open-work-file', { ...said, phase: '../x' })).ok, false)
  writeFileSync(runFile('ai-research', 'evil'), JSON.stringify(record('evil', { work: { pre: pre('2026-10-14T09:00', '2026-10-21T13:00', { fileId: '../../outside' }) } })))
  assert.equal((await call('sessions:open-work-file', { ...said, runId: 'evil', phase: 'pre' })).ok, false, 'a hostile file id opens nothing')
  assert.equal(opened.length, 0)

  // Answers: the outline of a Run from an old talk is read from the Run's own vault, and `writable` says whether
  // that vault can be written now (pulls and marks go to the Run's own vault, not only the current one).
  writeFileSync(runFile('ai-research', 'old'), JSON.stringify(record('old', { work: undefined, preworkOpens: '2026-10-14T09:00' })))
  const asked = []
  let writableIds = new Set(['v1'])
  const checkedIds = []
  registerRunPageIpc({
    ipcMain: { handle: (channel, listener) => handlers.set(channel, listener) },
    vaults: () => [{ id: 'v1', root }], openPath: async () => '', focusLive: () => focus,
    readOutline: (vaultRoot, slug) => { asked.push([vaultRoot, slug]); return '# Talk\n\n## Before the session {prework}\n\n### Say hello {id=hello}{poll=open}\n' },
    writableVault: (id) => { checkedIds.push(id); return writableIds.has(id) }
  })
  const old = await call('sessions:run-answers', { ...said, runId: 'old' })
  assert.deepEqual(asked.slice(0, 1), [[root, 'ai-research']], 'the outline is read from the Run\'s own vault root')
  assert.equal(old.writable, true)
  assert.equal(old.pre.source, 'outline')
  assert.deepEqual(checkedIds, ['v1'], 'the Run\'s own vault is the one checked')
  writableIds = new Set(['v2'])
  assert.equal((await call('sessions:run-answers', { ...said, runId: 'old' })).writable, false, 'a Run whose own vault cannot be written now is read-only')
  writableIds = new Set()
  assert.equal((await call('sessions:run-answers', { ...said, runId: 'old' })).writable, false, 'and so is any Run while no vault can be written')
  assert.equal(old.ownerUnknown, undefined, 'no ownerUnknown dep: nothing said')
  // Issue 256 round 2: a phase whose only object is from before 0.41 with no vault recorded is named, for the Run's own vault.
  const unknownAsked = []
  registerRunPageIpc({
    ipcMain: { handle: (channel, listener) => handlers.set(channel, listener) },
    vaults: () => [{ id: 'v1', root }], openPath: async () => '', focusLive: () => focus,
    readOutline: () => '# Talk\n\n## Before the session {prework}\n\n### Say hello {id=hello}{poll=open}\n',
    ownerUnknown: (vaultRoot, run) => { unknownAsked.push([vaultRoot, run.id]); return ['pre', 'post'] },
  })
  const unknown = await call('sessions:run-answers', { ...said, runId: 'old' })
  assert.deepEqual(unknown.ownerUnknown, ['pre'], 'only phases the Run has are named')
  assert.deepEqual(unknownAsked, [[root, 'old']], 'asked of the Run\'s own vault')

  // Ticket 16: Preview page and the QR code.
  const previews = []
  const qrs = []
  registerRunPageIpc({
    ipcMain: { handle: (channel, listener) => handlers.set(channel, listener) },
    vaults: () => [{ id: 'v1', root }], openPath: async (path) => { opened.push(path); return '' }, focusLive: () => focus,
    previewPage: async (vaultRoot, run) => { previews.push([vaultRoot, run.id]); const path = join(vaultRoot, '_PRESENTATIONS', 'ai-research', 'said', 'preview-pre.html'); mkdirSync(join(vaultRoot, '_PRESENTATIONS', 'ai-research', 'said'), { recursive: true }); writeFileSync(path, '<!doctype html>'); return { ok: true, path } },
    qrSvg: async (url) => { qrs.push(url); return '<svg viewBox="0 0 1 1"></svg>' }
  })
  const preview = await call('sessions:preview-page', said)
  assert.equal(preview.ok, true, JSON.stringify(preview))
  assert.deepEqual(previews, [[root, 'said']])
  assert.ok(opened.at(-1).endsWith(join('said', 'preview-pre.html')), 'the preview is opened from the vault')
  const openedBefore = opened.length
  registerRunPageIpc({
    ipcMain: { handle: (channel, listener) => handlers.set(channel, listener) },
    vaults: () => [{ id: 'v1', root }], openPath: async (path) => { opened.push(path); return '' }, focusLive: () => focus,
    previewPage: async () => ({ ok: true, path: join(outside, 'secret.md') })
  })
  assert.equal((await call('sessions:preview-page', said)).ok, false, 'a preview outside the vault is never opened')
  assert.equal(opened.length, openedBefore)
  for (const bad of [{ ...said, talkSlug: '../escape' }, null]) assert.equal((await call('sessions:preview-page', bad)).ok, false)
  registerRunPageIpc({
    ipcMain: { handle: (channel, listener) => handlers.set(channel, listener) },
    vaults: () => [{ id: 'v1', root }], openPath: async () => '', focusLive: () => focus, qrSvg: async (url) => { qrs.push(url); return '<svg viewBox="0 0 1 1"></svg>' }
  })
  assert.deepEqual(await call('sessions:run-qr', { url: 'https://handouts.fyi/dl/said/pre-work' }), { ok: true, svg: '<svg viewBox="0 0 1 1"></svg>' })
  for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', '', 7, null, `https://x.test/${'a'.repeat(2100)}`]) assert.equal((await call('sessions:run-qr', { url: bad })).ok, false, `QR of ${String(bad).slice(0, 30)}`)
  assert.deepEqual(qrs, ['https://handouts.fyi/dl/said/pre-work'])

  // Ticket 24: sessions:set-extras checks what is sent, keeps it on the Run (planned or delivered) through the
  // checked writer, and refuses in words; a Run that is not there or a hostile name writes nothing.
  {
    const done = { ...said, runId: 'done' }
    const kept = await call('sessions:set-extras', { ...done, extras: { intro: ' Bring a laptop. ', links: [{ url: 'example.org/reading', label: 'Reading list' }] } })
    assert.deepEqual(kept, { ok: true, extras: { intro: 'Bring a laptop.', links: [{ url: 'https://example.org/reading', label: 'Reading list' }] } })
    const storedDone = JSON.parse(readFileSync(runFile('ai-research', 'done'), 'utf8'))
    assert.deepEqual(storedDone.extras, kept.extras)
    assert.deepEqual([storedDone.status, storedDone.eventTitle, storedDone.endedAt], ['delivered', 'Saïd workshop', '2026-10-21T15:00:00.000Z'], 'the rest of the Run is kept')
    for (const [extras, words] of [[{ links: [{ url: 'javascript:alert(1)' }] }, /web address/], [{ links: [{ url: 'data:text/html,x' }] }, /web address/], [{ intro: 'x'.repeat(1001) }, /too long/], ['x', /could not be read/]]) {
      const refused = await call('sessions:set-extras', { ...done, extras })
      assert.equal(refused.ok, false)
      assert.match(refused.error, words)
    }
    assert.deepEqual(JSON.parse(readFileSync(runFile('ai-research', 'done'), 'utf8')).extras, kept.extras, 'a refusal changes nothing')
    for (const bad of [{ ...said, talkSlug: '../escape' }, { ...said, runId: '../../x' }, { ...said, vaultId: 'other' }, { ...said, runId: 'nope' }, null]) {
      assert.equal((await call('sessions:set-extras', bad && { ...bad, extras: { intro: 'x' } })).ok, false, `set-extras ${JSON.stringify(bad)}`)
    }
    assert.deepEqual(await call('sessions:set-extras', { ...done, extras: null }), { ok: true, extras: null })
    assert.equal(readFileSync(runFile('ai-research', 'done'), 'utf8').includes('extras'), false, 'taken away')
  }

  // Round 2: a Run file whose JSON names another talk and Run is not the Run asked for. Every handler refuses
  // it, and no write reaches either file (the requested one or the one its JSON names).
  {
    mkdirSync(join(root, '_PRESENTATIONS', 'talk-a'), { recursive: true })
    mkdirSync(join(root, '_PRESENTATIONS', 'talk-b'), { recursive: true })
    writeFileSync(runFile('talk-a', 'run-a'), JSON.stringify(record('run-b', { talkSlug: 'talk-b' })))
    writeFileSync(runFile('talk-b', 'run-b'), JSON.stringify(record('run-b', { talkSlug: 'talk-b', extras: { intro: 'Real B.' } })))
    const before = [readFileSync(runFile('talk-a', 'run-a')), readFileSync(runFile('talk-b', 'run-b'))]
    const runA = { vaultId: 'v1', talkSlug: 'talk-a', runId: 'run-a' }
    const deliveredBefore = delivered.length
    for (const [channel, extra] of [['sessions:set-extras', { extras: { intro: 'Overwrite.' } }], ['sessions:mark-delivered', {}], ['sessions:run-files', {}], ['sessions:run-answers', {}], ['sessions:open-work-file', { phase: 'pre' }]]) {
      const refused = await call(channel, { ...runA, ...extra })
      assert.deepEqual(refused, { ok: false, error: 'That Run is no longer there.' }, `${channel} refuses a mismatched Run file`)
    }
    assert.ok(readFileSync(runFile('talk-a', 'run-a')).equals(before[0]), 'run A is unchanged')
    assert.ok(readFileSync(runFile('talk-b', 'run-b')).equals(before[1]), 'run B is unchanged')
    assert.equal(delivered.length, deliveredBefore, 'nothing is reported delivered')
  }

  // Open file in a second open vault: the answer carries that vault, and the file is read from that vault's Work files folder.
  const root2 = mkdtempSync(join(tmpdir(), 'tw-run-page-vault2-'))
  mkdirSync(join(root2, '_PRESENTATIONS', 'prework-test'), { recursive: true })
  mkdirSync(join(root2, 'Work files'), { recursive: true })
  writeFileSync(join(root2, 'Work files', 'second-only.md'), ['---', 'id: second-only', 'title: Second only', 'revision: 1', '---', '', '### Watch', '{id=watch}{video}', ''].join('\n'))
  writeFileSync(join(root2, '_PRESENTATIONS', 'prework-test', 'r2.json'), JSON.stringify({ ...record('r2'), talkSlug: 'prework-test', work: { pre: pre('2026-10-14T09:00', '2026-10-21T13:00', { fileId: 'second-only' }), post: pre('2026-10-22T09:00', '2026-10-28T13:00', { fileId: 'second-only' }) } }))
  registerRunPageIpc({
    ipcMain: { handle: (channel, listener) => handlers.set(channel, listener) },
    vaults: () => [{ id: 'v1', root }, { id: 'v2', root: root2 }], openPath: async (path) => { opened.push(path); return '' },
    focusLive: (talkSlug, runId, vaultRoot) => { focusedIn.push(`${vaultRoot}|${talkSlug}/${runId}`); return focus }
  })
  const focusedIn = []
  const second = { vaultId: 'v2', talkSlug: 'prework-test', runId: 'r2' }
  assert.deepEqual(await call('sessions:open-work-file', { ...second, phase: 'pre' }), { ok: true, fileName: 'second-only.md', vaultId: 'v2' }, 'pre-work Open file names the second vault')
  assert.deepEqual(await call('sessions:open-work-file', { ...second, phase: 'post' }), { ok: true, fileName: 'second-only.md', vaultId: 'v2' }, 'post-work too')
  assert.equal((await call('sessions:open-work-file', { ...second, vaultId: 'v1', phase: 'pre' })).ok, false, 'the same Run named in the first vault is not found there')
  // The view selects that exact file: the request carries the vault, and the selection key includes it.
  {
    const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
    assert.match(read('src/renderer/src/components/SessionsView.tsx'), /onShowWorkFile\(result\.fileName, result\.vaultId\)/)
    assert.match(read('src/renderer/src/components/WorkFilesView.tsx'), /setSelected\(workFileKey\(request\.vaultId, request\.fileName\)\)/)
  }
  rmSync(root2, { recursive: true, force: true })

  assert.equal((await call('sessions:open-live-view', said)).ok, false)
  focus = true
  assert.equal((await call('sessions:open-live-view', said)).ok, true)
  // Issue 256, finding 4: Open live view asks for the Run of the vault named, so another vault's session of the
  // same talk and Run id is never brought forward; a reference with no vault, or an unknown one, asks nothing.
  focusedIn.length = 0
  assert.equal((await call('sessions:open-live-view', { ...said, vaultId: 'v2' })).ok, true)
  assert.deepEqual(focusedIn, [`${root2}|ai-research/said`], 'the second vault\'s root is asked, not the first\'s')
  assert.equal((await call('sessions:open-live-view', { talkSlug: 'ai-research', runId: 'said' })).ok, false, 'no vault: refused')
  assert.equal((await call('sessions:open-live-view', { ...said, vaultId: 'v9' })).ok, false, 'a vault that is not open: refused')
  assert.equal(focusedIn.length, 1)
  assert.equal(existsSync(join(outside, 'secret.md')), true)
  console.log('ok  4 main')
}
// ── 5. Issue 256: Go live and Open results from the Sessions page carry the Run's vault ────────────────────────
{
  // Two open vaults hold talk `same-talk` with Run `r1`; v1 is the first vault (what calls with no vault read).
  const vaults = {
    v1: { runs: [{ id: 'r1', talkSlug: 'same-talk', from: 'v1' }], talks: { 'same-talk': { outlinePath: '/vault-one/same-talk-outline.md' } } },
    v2: { runs: [{ id: 'r1', talkSlug: 'same-talk', from: 'v2' }, { id: 'r2', talkSlug: 'same-talk', from: 'v2' }], talks: { 'same-talk': { outlinePath: '/vault-two/same-talk-outline.md' } } },
  }
  const asked = []
  const presented = []
  const api = {
    listRuns: async (talkSlug, vaultId) => { asked.push(`runs ${vaultId}`); return vaults[vaultId ?? 'v1'].runs.filter((run) => run.talkSlug === talkSlug) },
    talkHandouts: async (vaultId) => { asked.push(`talks ${vaultId}`); return vaults[vaultId ?? 'v1'].talks },
    present: async (run, outlinePath) => { presented.push([run.from, outlinePath]); return { ok: true } },
  }
  assert.deepEqual(await goLiveFromSessions({ vaultId: 'v2', talkSlug: 'same-talk', runId: 'r1' }, api), { ok: true })
  assert.deepEqual(asked.sort(), ['runs v2', 'talks v2'], 'Go live reads the second vault, never the first')
  assert.deepEqual(presented, [['v2', '/vault-two/same-talk-outline.md']], 'the second vault\'s Run, with its own outline')
  // A Run only the second vault holds is presented too (before: refused, as the first vault does not have it).
  presented.length = 0
  assert.deepEqual(await goLiveFromSessions({ vaultId: 'v2', talkSlug: 'same-talk', runId: 'r2' }, api), { ok: true })
  assert.deepEqual(presented, [['v2', '/vault-two/same-talk-outline.md']])
  assert.deepEqual(await goLiveFromSessions({ vaultId: 'v1', talkSlug: 'same-talk', runId: 'r2' }, api), { ok: false, error: GO_LIVE_REFUSED }, 'a Run the vault does not hold is refused')

  const opens = []
  await openResultsFromSessions({ vaultId: 'v2', talkSlug: 'same-talk', runId: 'r1' }, async (view, sessionId, run) => { opens.push([view, sessionId, run]); return { success: true } })
  assert.deepEqual(opens, [['history', 'results:same-talk/r1', { vaultId: 'v2', talkSlug: 'same-talk', runId: 'r1' }]], 'Open results names the Run\'s vault')
  const open = (...ids) => (id) => ids.includes(id)
  assert.equal(historyResultsRefusal({ vaultId: 'v2', talkSlug: 'same-talk', runId: 'r1' }, open('v1', 'v2')), null, 'a Run in a second open vault opens its results')
  assert.equal(historyResultsRefusal({ vaultId: 'v2', talkSlug: 'same-talk', runId: 'r1' }, open('v1')), RESULTS_OTHER_VAULT, 'a Run in a vault that is not open is refused')
  assert.equal(historyResultsRefusal({ vaultId: 'v1', talkSlug: 'same-talk', runId: 'r1' }, open('v1')), null, 'with one vault open, its Run opens as before')
  assert.equal(historyResultsRefusal({ talkSlug: 'same-talk', runId: 'r1' }, open()), null, 'a reference with no vault is History\'s own')

  // The view and main use them: SessionsView's two actions, and the Tools window's open.
  const read = (path) => readFileSync(join(repo, path), 'utf8')
  const view = read('src/renderer/src/components/SessionsView.tsx')
  assert.match(view, /goLiveFromSessions\(ref, \{\s*listRuns: \(talkSlug, vaultId\) => window\.tw\.history\.listRuns\(talkSlug, vaultId\),\s*talkHandouts: \(vaultId\) => window\.tw\.history\.talkHandouts\(vaultId\)/)
  assert.match(view, /openResultsFromSessions\(ref, /)
  assert.doesNotMatch(view, /window\.tw\.history\.listRuns\(source\.talkSlug\)/, 'no call to the first vault\'s Runs is left')
  assert.match(view, /live\.has\(sessionLiveKey\(source\.vaultId, source\)\)/, 'Live now on the Run page names the vault')
  assert.match(read('src/main/index.ts'), /const refused = historyResultsRefusal\(runRef, \(id\) => rootOfVault\(id\) !== undefined\)/)
  assert.match(read('src/renderer/src/App.tsx'), /\.\.\.\(run\?\.vaultId \? \{ vaultId: run\.vaultId \} : \{\}\), nonce:/, 'App keeps the Run\'s vault in the results request')
  const history = read('src/renderer/src/components/History.tsx')
  assert.match(history, /window\.tw\.history\.listRuns\(undefined, readVaultId\)/, 'History reads the named vault\'s Runs')
  assert.match(history, /window\.tw\.history\.talkHandouts\(readVaultId\)/)
  assert.match(history, /resultsRequest\.vaultId !== readVaultId\) \{ setReadVaultId\(resultsRequest\.vaultId\)/)
  console.log('ok  5 issue 256: Go live and Open results carry the Run\'s vault')
}
console.log('ALL PASSED')
