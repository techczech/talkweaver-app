// Work-files ticket 15: the participant work page as a file (compiler/scripts/lib/work-page.mjs, through
// src/main/work-page.ts) and its small parts (compiler/assets/runtime/work-page-parts.js).
//   1. the policy: a <meta> first in <head> and the header; scripts only by the hashes of the page's own
//      inline scripts (every one hashed, none other), no 'unsafe-inline' or host for scripts, object-src
//      'none', base-uri 'none', form-action 'self', frames only from the compiler's video players,
//      connections only to the Worker's origin;
//   2. no right answer anywhere in the page; a form that carries one is refused;
//   3. untrusted text (titles, the intro, labels, the run line) never becomes markup: it is JSON with `<`
//      escaped inside the config line, or escaped in <title>;
//   4. only a step's slide is HTML, and only after the step sanitiser (again, here, whoever made it); a poll
//      step's slide is not in the page;
//   5. Mermaid ships only with a diagram, hashed like the page's own script, started with strict security;
//   6. the page's parts: a frame gets `src` only from `data-src` and only for YouTube no-cookie and Vimeo
//      players; the handout link is http(s) or a site path; Mermaid's SVG is walked before it is placed;
//   7. what the builder refuses: a file that is not ready, a phase, an object id, a Worker or handout address.
// Usage: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/test-work-page.mjs
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { JSDOM, VirtualConsole } from 'jsdom'
import { buildWorkPage, buildNotAvailablePage, workPageCsp, WORK_PAGE_FRAME_HOSTS } from '../compiler/scripts/lib/work-page.mjs'
import { workPagePlayerUrl, workPageActivateMedia, workPageHandoutHref, workPageRenderMermaid, workPageStatus, workPageSlideLines, workPageKind, workPageRuntimeSource } from '../compiler/assets/runtime/work-page.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildWorkPageFixture, COMPILER_DIR, PRE_WORK, POST_WORK } from './lib/work-page-fixture.mjs'
import { compileWorkFile } from '../src/main/work-file-compile.ts'
import { buildParticipantWorkPage, WorkPageNotReady } from '../src/main/work-page.ts'

const BASE = 'https://worker.example.test'
const pass = (name) => console.log(`PASS  ${name}`)
const directives = (csp) => Object.fromEntries(csp.split(';').map((part) => part.trim()).filter(Boolean).map((part) => { const [name, ...values] = part.split(/\s+/); return [name, values] }))
const inlineScripts = (html) => [...html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map((match) => ({ attrs: match[1] || '', text: match[2] }))
const sha = (text) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`
// The compiler's stylesheet has rules jsdom's CSS parser does not know; its complaints are not findings.
const dom = (html) => new JSDOM(html, { virtualConsole: new VirtualConsole() })
const outsideTemplate = (html) => html.replace(/<template id="wpSteps">[\s\S]*?<\/template>/, '')

// ── 1. The policy ───────────────────────────────────────────────────────────────────────────────
const pre = await buildWorkPageFixture({ preworkId: 'pre0001', workerBaseUrl: `${BASE}/` })
{
  const head = pre.html.slice(pre.html.indexOf('<head>') + 6, pre.html.indexOf('</head>'))
  const tags = [...head.matchAll(/<([a-z]+)\b[^>]*>/g)].map((match) => match[0])
  assert.equal(tags[0], '<meta charset="utf-8">')
  assert.match(tags[1], /^<meta http-equiv="Content-Security-Policy" content="/, 'the policy is the first thing after the charset')
  const meta = dom(pre.html).window.document.querySelector('meta[http-equiv="Content-Security-Policy"]').getAttribute('content')
  assert.equal(meta, pre.csp)
  const policy = directives(pre.csp)
  assert.deepEqual(policy['default-src'], ["'none'"])
  assert.ok(policy['script-src'].length >= 1)
  for (const source of policy['script-src']) assert.match(source, /^'sha256-[A-Za-z0-9+/]+=*'$/, `script-src holds only hashes, not ${source}`)
  assert.deepEqual(policy['object-src'], ["'none'"])
  assert.deepEqual(policy['base-uri'], ["'none'"])
  assert.deepEqual(policy['form-action'], ["'self'"])
  assert.deepEqual(policy['frame-src'], [...WORK_PAGE_FRAME_HOSTS])
  assert.deepEqual(WORK_PAGE_FRAME_HOSTS, ['https://www.youtube-nocookie.com', 'https://youtube-nocookie.com', 'https://player.vimeo.com'])
  assert.deepEqual(policy['connect-src'], [BASE], 'the page talks to the Worker\'s origin only')
  assert.equal(pre.csp.includes('unsafe-eval'), false)
  assert.equal(/script-src[^;]*unsafe-inline/.test(pre.csp), false)
  assert.equal('frame-ancestors' in policy, false, 'a <meta> cannot carry frame-ancestors')
  assert.equal(pre.headers['Content-Security-Policy'], `${pre.csp}; frame-ancestors 'none'`)
  assert.equal(pre.headers['Referrer-Policy'], 'no-referrer')
  assert.equal(pre.headers['X-Content-Type-Options'], 'nosniff')
  const scripts = inlineScripts(pre.html)
  assert.equal(scripts.length, policy['script-src'].length, 'every inline script has its hash and there is no other hash')
  for (const script of scripts) {
    assert.equal(script.attrs.trim(), '', 'no script has a src or a type')
    assert.ok(policy['script-src'].includes(sha(script.text)), 'the hash is of the script exactly as served')
  }
  const doc = dom(pre.html).window.document
  for (const node of doc.querySelectorAll('*')) for (const attr of node.attributes) assert.equal(/^on/i.test(attr.name), false, `no handler: ${node.localName}[${attr.name}]`)
  assert.throws(() => workPageCsp({ scriptHashes: [], workerOrigin: BASE }), /script hashes/)
  assert.throws(() => workPageCsp({ scriptHashes: ["'unsafe-inline'"], workerOrigin: BASE }), /script hashes/)
  pass('the policy: meta first, every inline script hashed and nothing else, object/base/form/frames/connect pinned')
}

// ── 2. No right answer ────────────────────────────────────────────────────────────────────────────
{
  assert.doesNotMatch(pre.html, /\{\s*right\s*\}/i)
  assert.doesNotMatch(pre.html, /"right"\s*:|data-right|is-right|"correct"|answerIndex/i)
  const config = JSON.parse(inlineScripts(pre.html).at(-1).text.match(/startWorkPage\(window, (\{[\s\S]*\})\);\n\}\)\(\);/)[1])
  const check = config.form.steps.find((step) => step.id === 'quick-check')
  assert.deepEqual(check.poll.options.map((option) => Object.keys(option).sort()), [['label', 'optionId'], ['label', 'optionId'], ['label', 'optionId']])
  assert.deepEqual(Object.keys(check).sort(), ['id', 'kind', 'n', 'poll', 'questions', 'title'])
  const tampered = structuredClone(pre.form)
  tampered.steps[1].poll.options[0].right = true
  assert.throws(() => buildWorkPage({ phase: 'pre', preworkId: 'x1', workerBaseUrl: BASE, form: tampered, steps: [] }), /right answer/)
  const nested = structuredClone(pre.form)
  nested.steps[1].correct = 0
  assert.throws(() => buildWorkPage({ phase: 'pre', preworkId: 'x1', workerBaseUrl: BASE, form: nested, steps: [] }), /right answer/)
  pass('no right answer anywhere in the page; a form carrying one is refused')
}

// ── 3. Untrusted text is text ─────────────────────────────────────────────────────────────────────
{
  const hostile = '</script><script>alert(1)</script><img src=x onerror=alert(2)><!--'
  const text = PRE_WORK.replace('title: Research teams intake', `title: "Intake ${hostile.replace(/"/g, '')}"`)
    .replace('Four short steps before we meet.', `Intro ${hostile}`)
    .replace('- The title', `- The title ${hostile}`)
    .replace('### Quick check', `### Quick check ${hostile}`)
  const page = await buildWorkPageFixture({ text, preworkId: 'pre0002', workerBaseUrl: BASE, talkTitle: `Talk ${hostile}`, runLine: `Run ${hostile}` })
  const outside = outsideTemplate(page.html)
  assert.equal((outside.match(/<script>/g) || []).length, inlineScripts(page.html).length, 'no script element but the page\'s own')
  assert.doesNotMatch(outside, /<img src=x|<script>alert|<\/script><script>alert/)
  const doc = dom(page.html).window.document
  assert.equal(doc.querySelectorAll('script').length, inlineScripts(page.html).length)
  assert.equal(doc.querySelectorAll('body > img, head > img, body > script:not(:last-of-type)').length, 0)
  assert.equal(doc.title, `Before the session · Talk ${hostile}`, 'the <title> carries the text, escaped')
  const config = JSON.parse(inlineScripts(page.html).at(-1).text.match(/startWorkPage\(window, (\{[\s\S]*\})\);\n\}\)\(\);/)[1])
  assert.equal(config.talkTitle, `Talk ${hostile}`)
  assert.equal(config.runLine, `Run ${hostile}`)
  assert.match(config.introText, /^Intro <\/script>/)
  assert.ok(config.form.steps[1].poll.options.some((option) => option.label === `The title ${hostile}`))
  pass('titles, the intro, labels and the run line reach the page as JSON text, never as markup')
}

// ── 4. Only a step's slide is HTML, and only sanitised ────────────────────────────────────────────
{
  const steps = pre.compiled.steps.map((step) => ({ id: step.id, kind: step.kind, stepHtml: step.stepHtml }))
  const evil = '<section class="slide"><p>Slide words</p><script>alert(1)</script><img src="x" onerror="alert(2)"><iframe src="https://evil.example/"></iframe><a href="javascript:alert(3)">x</a><iframe data-src="https://evil.example/" data-embed-video="1"></iframe></section>'
  steps[2] = { ...steps[2], stepHtml: evil }
  steps[1] = { ...steps[1], stepHtml: '<section class="slide"><p>POLL-SLIDE-MARKER</p></section>' }
  const page = buildWorkPage({ phase: 'pre', preworkId: 'pre0003', workerBaseUrl: BASE, form: pre.form, steps, styles: '' })
  const template = dom(page.html).window.document.getElementById('wpSteps').content
  const wrappers = [...template.children]
  assert.deepEqual(wrappers.map((node) => node.getAttribute('data-wp-step')), ['watch', 'try-a-prompt'], 'only slide and task steps carry a slide; poll steps are drawn from the form')
  assert.doesNotMatch(page.html, /POLL-SLIDE-MARKER/)
  assert.equal(template.querySelectorAll('script, [onerror]').length, 0)
  assert.equal([...template.querySelectorAll('iframe')].every((frame) => workPagePlayerUrl(frame.getAttribute('data-src')) && !frame.hasAttribute('src')), true, 'only the player frame is left, with no src')
  assert.equal(template.querySelector('a[href^="javascript"]'), null)
  assert.match(template.textContent, /Slide words/)
  const styled = buildWorkPage({ phase: 'pre', preworkId: 'pre0003', workerBaseUrl: BASE, form: pre.form, steps, styles: 'p{color:red}</style><script>alert(1)</script>' })
  const styledScripts = dom(styled.html).window.document.querySelectorAll('script')
  assert.equal(styledScripts.length, 1, 'the stylesheet cannot end its <style> early')
  assert.match(styledScripts[0].textContent, /startWorkPage\(window/)
  pass('a step\'s slide is sanitised again here; a poll step\'s slide is not in the page')
}

// ── 5. Mermaid ───────────────────────────────────────────────────────────────────────────────────
{
  assert.equal(inlineScripts(pre.html).length, 1, 'no diagram, no Mermaid')
  const text = PRE_WORK.replace('### What do you most want from the session?', '### A diagram\n{id=diagram}\n\n```mermaid\ngraph TD; A["<img src=x onerror=alert(1)>"]-->B\n```\n\n### What do you most want from the session?')
  // A diagram is a layout a work file may not use (a blocking finding), so the app never builds this page;
  // the page still runs Mermaid strictly should a diagram reach a step.
  const dir = mkdtempSync(join(tmpdir(), 'tw-work-page-mmd-'))
  const compiled = await compileWorkFile({ compilerDir: COMPILER_DIR, path: join(dir, 'work.md'), text })
  rmSync(dir, { recursive: true, force: true })
  assert.equal(compiled.ok, false)
  assert.match(compiled.steps.find((step) => step.id === 'diagram').stepHtml, /mermaid-mm/)
  const page = buildWorkPage({ phase: 'pre', preworkId: 'pre0004', workerBaseUrl: BASE, form: compiled.form, steps: compiled.steps, styles: '' })
  const scripts = inlineScripts(page.html)
  assert.equal(scripts.length, 2)
  assert.match(scripts[0].text, /BEGIN VENDOR mermaid/)
  const policy = directives(page.csp)
  assert.deepEqual(policy['script-src'], scripts.map((script) => sha(script.text)))
  assert.match(workPageRuntimeSource(), /securityLevel: 'strict'/)
  assert.doesNotMatch(workPageRuntimeSource(), /securityLevel: '(?:loose|antiscript|sandbox)'/)
  pass('Mermaid ships only with a diagram, hashed, started with strict security')
}

// ── 6. The page's parts ──────────────────────────────────────────────────────────────────────────
{
  for (const url of ['https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ', 'https://youtube-nocookie.com/embed/dQw4w9WgXcQ?start=30', 'https://player.vimeo.com/video/123456']) assert.equal(workPagePlayerUrl(url), true, url)
  for (const url of ['https://www.youtube.com/embed/dQw4w9WgXcQ', 'http://www.youtube-nocookie.com/embed/dQw4w9WgXcQ', 'https://www.youtube-nocookie.com.evil.example/embed/dQw4w9WgXcQ',
    'https://player.vimeo.com.evil.example/video/1', 'https://evil.example/?https://player.vimeo.com/video/1', 'javascript:alert(1)', 'data:text/html,x', '//player.vimeo.com/video/1',
    'https://player.vimeo.com/video/1"onload="x', ' https://player.vimeo.com/video/1', 'https://www.player.vimeo.com/video/1', null, 42]) assert.equal(workPagePlayerUrl(url), false, String(url))
  const { document } = dom('<body></body>').window
  const root = document.createElement('div')
  root.innerHTML = '<iframe id="ok" data-embed-video="1" data-src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"></iframe>'
    + '<iframe id="evil" data-embed-video="1" data-src="https://evil.example/"></iframe>'
    + '<iframe id="unmarked" data-src="https://player.vimeo.com/video/1"></iframe>'
    + '<iframe id="other" data-embed-video="1" data-embed-url="https://player.vimeo.com/video/1"></iframe>'
    + '<video data-src="https://evil.example/v.mp4"></video>'
  workPageActivateMedia(root)
  assert.equal(root.querySelector('#ok').getAttribute('src'), 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ')
  assert.deepEqual(['evil', 'unmarked', 'other'].map((id) => root.querySelector(`#${id}`)), [null, null, null], 'any other frame is taken out')
  assert.equal(root.querySelector('video').hasAttribute('src'), false, 'data-src moves to src for a player frame only')
  for (const [value, expected] of [['https://handouts.fyi/dl/said-21-oct', 'https://handouts.fyi/dl/said-21-oct'], ['/dl/said-21-oct', '/dl/said-21-oct'], ['../', '../'],
    ['javascript:alert(1)', ''], ['data:text/html,x', ''], ['//evil.example/x', ''], ['https://e.example/"onmouseover="x', ''], ['/a:b', ''], [' https://x', '']]) {
    assert.equal(workPageHandoutHref(value), expected, String(value))
  }
  // Mermaid's SVG is walked before it is placed; a failed diagram is its source as text.
  const host = document.createElement('div')
  host.innerHTML = '<div class="mermaid-mm" data-mmd-src="graph TD; A[&quot;&lt;img src=x onerror=alert(1)&gt;&quot;]"></div><div class="mermaid-mm" data-mmd-src="&lt;b&gt;bad&lt;/b&gt;"></div>'
  const fake = { render: (_id, src) => src.startsWith('graph') ? Promise.resolve({ svg: '<svg><style>.a{fill:red}</style><script>alert(1)</script><g onload="alert(2)"><a href="javascript:alert(3)"><text>x</text></a><foreignObject><img src=x onerror=alert(4)></foreignObject><use href="https://evil.example/s.svg#x"/><path d="M0 0" fill="url(#g)"/></g></svg>' }) : Promise.reject(new Error('bad')) }
  workPageRenderMermaid(host, fake, document)
  await new Promise((resolve) => setTimeout(resolve, 20))
  const [drawn, failed] = host.querySelectorAll('.mermaid-mm')
  assert.ok(drawn.querySelector('svg path'), 'the diagram is drawn')
  assert.equal(drawn.querySelectorAll('script, foreignObject, a, use, img, [onload]').length, 0, drawn.innerHTML)
  assert.equal(drawn.querySelector('style').textContent, '.a{fill:red}')
  // CSS in the diagram names only #fragments (ticket 15 review): another url() is `none`; CSS that could still reach out is dropped.
  const styled = document.createElement('div')
  styled.innerHTML = '<div class="mermaid-mm" data-mmd-src="graph A"></div><div class="mermaid-mm" data-mmd-src="graph B"></div>'
  const svgs = { 'graph A': '<svg><style>.a{fill:url(#g)}.b{background:url("https://evil.example/t.png")}.c{background:url(//evil.example/x)}</style><g style="fill:url(https://evil.example/y)"><path d="M0 0" fill="url(#g)"/></g></svg>',
    'graph B': '<svg><style>@import "https://evil.example/s.css";.a{fill:red}</style><style>.b{background:u\\72l(https://evil.example/z)}</style><path d="M0 0"/></svg>' }
  workPageRenderMermaid(styled, { render: (_id, src) => Promise.resolve({ svg: svgs[src] }) }, document)
  await new Promise((resolve) => setTimeout(resolve, 20))
  const [cleanA, cleanB] = styled.querySelectorAll('.mermaid-mm')
  assert.equal(cleanA.querySelector('style').textContent, '.a{fill:url(#g)}.b{background:none}.c{background:none}')
  assert.equal(cleanA.querySelector('g').getAttribute('style'), 'fill:none')
  assert.equal(cleanA.querySelector('path').getAttribute('fill'), 'url(#g)')
  assert.equal(cleanB.querySelectorAll('style').length, 0, 'an @import or an escape drops the style whole')
  assert.equal(/evil\.example/.test(styled.innerHTML), false, styled.innerHTML)
  assert.equal(failed.querySelector('b'), null)
  assert.equal(failed.textContent, '<b>bad</b>')
  // the status, the kinds, a slide's lines
  assert.deepEqual(workPageStatus({ state: 'open', opensAt: 1, closesAt: 2, phase: 'post' }, 'post'), { state: 'open', opensAt: 1, closesAt: 2 })
  assert.equal(workPageStatus({ state: 'open', opensAt: 1, closesAt: 2, phase: 'pre' }, 'post').state, 'unavailable', 'another phase\'s object is not this page')
  assert.equal(workPageStatus({ state: 'weird', opensAt: 1, closesAt: 2 }, 'pre'), null)
  assert.deepEqual(workPageKind({ kind: 'question', poll: { type: 'rating', labels: [{ label: '1 · not useful' }, { label: '5 · very useful' }] } }, false), { icon: 'gauge', label: 'Rating · 1 to 5' })
  assert.deepEqual(workPageKind({ kind: 'task', minutes: 20 }, false, true), { icon: 'pencil-line', label: 'Task' })
  assert.deepEqual(workPageKind({ kind: 'slide' }, true), { icon: 'video', label: 'Video' })
  const slide = document.createElement('div')
  slide.innerHTML = '<section class="slide"><div class="slide-content"><header class="slide-head"><h1>T</h1></header><p>Para &lt;b&gt;</p><ul class="feature-list fl-numbered"><li><span class="fl-icon fl-num">1</span><span class="fl-text">One</span></li></ul><figure><figcaption>no</figcaption></figure></div></section>'
  assert.deepEqual(workPageSlideLines(slide), [{ text: 'Para <b>', item: false, ordered: false }, { text: 'One', item: true, ordered: true }])
  pass('a frame gets src only from data-src, only for a no-cookie YouTube or Vimeo player; links, Mermaid, status and kinds')
}

// ── 7. What the builder refuses ──────────────────────────────────────────────────────────────────
{
  const base = { phase: 'pre', preworkId: 'pre0005', workerBaseUrl: BASE, form: pre.form, steps: [] }
  assert.ok(buildWorkPage(base).html)
  assert.throws(() => buildWorkPage({ ...base, phase: 'during' }), /phase/)
  for (const preworkId of ['', 'a/b', 'a"b', 'x'.repeat(129)]) assert.throws(() => buildWorkPage({ ...base, preworkId }), /object id/, preworkId)
  for (const workerBaseUrl of ['javascript:alert(1)', 'not a url', 'https://user:pw@worker.example.test', 'ftp://worker.example.test']) assert.throws(() => buildWorkPage({ ...base, workerBaseUrl }), /Worker address/, workerBaseUrl)
  for (const handoutUrl of ['javascript:alert(1)', 'data:text/html,x', '//evil.example/']) assert.throws(() => buildWorkPage({ ...base, handoutUrl }), /handout link/, handoutUrl)
  assert.throws(() => buildWorkPage({ ...base, form: { ...pre.form, steps: [{ ...pre.form.steps[0], id: 'Bad"Id' }] } }), /slug/)
  const notReady = { ...pre.compiled, ok: false }
  await assert.rejects(buildParticipantWorkPage({ compilerDir: '/nowhere', compiled: notReady, phase: 'pre', preworkId: 'p1', workerBaseUrl: BASE, talkTitle: 'T' }), (error) => error instanceof WorkPageNotReady && error.reason === 'work-file-not-ready')
  await assert.rejects(buildParticipantWorkPage({ compilerDir: '/nowhere', compiled: { ...pre.compiled, form: null }, phase: 'pre', preworkId: 'p1', workerBaseUrl: BASE, talkTitle: 'T' }), (error) => error instanceof WorkPageNotReady && error.reason === 'work-file-no-form')
  const post = await buildWorkPageFixture({ phase: 'post', preworkId: 'post0001', workerBaseUrl: BASE, text: POST_WORK })
  assert.match(post.html, /<title>After the session · AI for research teams<\/title>/)
  assert.match(post.html, /<div id="workPage" data-phase="post">/)
  pass('refused: a file not ready or without a form, a phase, an object id, a Worker or handout address; post-work is headed After the session')
}

// ── 8. The look is the handout's: its tokens, its typeface, no beige and no serif ──────────────────
{
  const { handoutTokens, handoutTokenCss } = await import('../compiler/assets/runtime/handout-tokens.js')
  const { handoutHomeStyles } = await import('../compiler/assets/runtime/handout-home-styles.js')
  for (const phase of ['pre', 'post']) {
    const page = await buildWorkPageFixture({ phase, preworkId: phase + '0008', workerBaseUrl: BASE, text: phase === 'pre' ? PRE_WORK : POST_WORK })
    const css = [...dom(page.html).window.document.querySelectorAll('style')].pop().textContent
    assert.ok(css.includes(`--wp-sans:${handoutTokens.font}`), phase + ': the page types in the handout\'s system sans-serif')
    assert.ok(css.includes(`--wp-page:${handoutTokens.page}`) && css.includes(`--wp-oxford:${handoutTokens.navy}`), phase + ': the page and button colours are the handout\'s tokens')
    assert.ok(handoutHomeStyles.includes(handoutTokens.page) && handoutHomeStyles.includes(handoutTokens.navy), 'the handout home page reads the same tokens')
    assert.doesNotMatch(css, /Fraunces|Georgia|Alegreya/, phase + ': no serif face is named')
    assert.doesNotMatch(css.replace(/sans-serif/g, ''), /serif/i, phase + ': nothing is set in a serif family')
    assert.doesNotMatch(css, /#faf8f3|#f4efe4|#fffdf8|#e3dccd/i, phase + ': none of the old beige values is left')
    assert.doesNotMatch(css, /@font-face/, phase + ': no fonts are embedded')
  }
  const na = buildNotAvailablePage().html
  const naCss = [...dom(na).window.document.querySelectorAll('style')].pop().textContent
  assert.ok(naCss.includes(handoutTokens.page) && naCss.includes(handoutTokens.font) && naCss.includes(handoutTokens.ink), 'not available: the handout\'s page colour, ink and system sans-serif')
  assert.doesNotMatch(naCss, /Fraunces|Georgia|Alegreya|@font-face|#faf8f3|#ece6d9|#2b2620|#6b6355|#7d7462/i, 'not available: no serif, no embedded font, no beige')
  assert.doesNotMatch(naCss.replace(/sans-serif/g, ''), /serif/i, 'not available: nothing is set in a serif family')
  assert.match(handoutTokenCss, /--hd-navy:#0b3a6b/)
  pass('pre-work and post-work pages use the handout\'s tokens and system sans-serif: no beige panels, no serif, no embedded fonts')
}

console.log('\nwork-page: ok')
