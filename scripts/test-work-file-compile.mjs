// Work-files ticket 05: a work file compiles into the steps participants see (src/main/work-file-compile.ts).
//   1. the ADR example, with media beside it, gives 4 steps: a video that plays in the page, a quick check,
//      a task drawn as title + image beside numbered steps, and a question; the form is accepted by the Worker's parser;
//   2. the right answer appears nowhere in the form or the HTML: no `{right}`, no `right` key, no index;
//   3. step HTML goes through the DOM allowlist: every payload from the 05 review leaves nothing
//      executable (checked by parsing the output in jsdom), and the compiler's own text in alt, title
//      and data-mmd-src comes through exactly;
//   4. a step in a layout outside the six compiles with a visible finding and is not restyled;
//   5. a missing image is a finding, not a crash; a step has the file's own steps only (no bookend slides);
//   6. steps meet their slides by id (a repeated id is the compiler's `-2`), a step with no slide is blocking;
//   7. media from outside the file's folder (.., absolute, symlink, file:) is blocking; a remote video stays a warning;
//   8. the intro is raw text (`introText`), the file need not be on disk, compiler warnings land on the right step.
// Usage: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/test-work-file-compile.mjs
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { compileWorkFile, expectedSlideIds, loadStepSanitiser, removedMarkup } from '../src/main/work-file-compile.ts'
import { parsePreworkForm } from '../worker/prework-protocol.ts'

const COMPILER = join(dirname(fileURLToPath(import.meta.url)), '..', 'compiler', 'scripts')
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
const dir = mkdtempSync(join(tmpdir(), 'tw-work-file-compile-'))
writeFileSync(join(dir, 'shot.png'), PNG)
writeFileSync(join(dir, 'clip.mp4'), Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(100)]))
const sanitise = await loadStepSanitiser(COMPILER)
const compile = (text, name = 'work.md') => { const path = join(dir, name); writeFileSync(path, text); return compileWorkFile({ compilerDir: COMPILER, path, text }) }

const EXAMPLE = [
  '---', 'id: research-teams-intake', 'title: Research teams intake', 'revision: 3', '---',
  'Four short steps before we meet.', '',
  '### Watch: what agents do', '{id=watch}{video}', '![what agents do](clip.mp4)',
  '### What makes something an agent?', '{id=check}{check}{poll=single}',
  '- It uses tools to carry out steps on its own {right}', '- It only answers questions',
  '### Try one prompt on a paper of your own', '{id=try-a-prompt}{task}{minutes=20}', '![the prompt box](shot.png)', '1. Open the assistant', '2. Paste your abstract',
  '### What do you most want from the session?', '{id=what-you-want}{poll=open}', '',
].join('\n')
const workFile = (steps, intro = '') => ['---', 'id: w', 'title: W', 'revision: 1', '---', intro, '', ...steps.flatMap(([id, body]) => [`### Step ${id} {id=${id}}`, body, '']), ''].join('\n')

// Nothing executable or loading is left in `html`: parsed as a browser would, then walked.
const FORBIDDEN = new Set(['script', 'style', 'base', 'meta', 'link', 'form', 'input', 'object', 'embed', 'applet', 'frame', 'frameset', 'math', 'foreignobject', 'animate', 'animatemotion', 'animatetransform', 'set', 'template', 'noscript'])
const VIDEO_PLAYER = /^https:\/\/(?:www\.)?(?:youtube-nocookie\.com\/embed\/|player\.vimeo\.com\/video\/)/
const URL_ATTR = /^(?:href|src|xlink:href|poster|action|formaction|background|cite|data-src|data-embed-url)$/
function assertInert(html, label) {
  const doc = new JSDOM(`<!doctype html><body>${html}</body>`).window.document
  for (const el of doc.body.querySelectorAll('*')) {
    const tag = el.localName.toLowerCase()
    assert.ok(!FORBIDDEN.has(tag), `${label}: <${tag}> left in ${html}`)
    if (tag === 'iframe') {
      assert.match(el.getAttribute('data-src') ?? '', VIDEO_PLAYER, `${label}: a frame that is not a video player`)
      assert.ok(!el.hasAttribute('src') && !el.hasAttribute('srcdoc') && !el.hasAttribute('data-embed-doc'), `${label}: frame content`)
    }
    for (const { name, value } of el.attributes) {
      const lower = name.toLowerCase()
      assert.ok(!lower.startsWith('on'), `${label}: ${tag}[${name}] left in ${html}`)
      assert.ok(!['srcdoc', 'formaction', 'action'].includes(lower), `${label}: ${tag}[${name}]`)
      if (URL_ATTR.test(lower)) {
        const compact = value.replace(/[\u0000-\u0020\u007f-\u00a0]/g, '').toLowerCase()
        const scheme = /^([a-z][a-z0-9+.-]*):/.exec(compact)?.[1]
        const inlined = (tag === 'img' && lower === 'src' && compact.startsWith('data:image/')) || (tag === 'video' && lower === 'src' && compact.startsWith('data:video/'))
        assert.ok(!scheme || scheme === 'http' || scheme === 'https' || inlined, `${label}: ${tag}[${name}=${value.slice(0, 60)}]`)
      }
      if (lower === 'style' || /url\s*\(/i.test(value)) {
        if (lower.startsWith('data-mmd') || lower === 'alt' || lower === 'title') continue
        for (const m of value.matchAll(/url\s*\(\s*['"]?([^)'"]*)/gi)) assert.ok(m[1].startsWith('#') || m[1].startsWith('data:image/'), `${label}: ${tag}[${name}=${value}]`)
        assert.doesNotMatch(value, /expression\s*\(|javascript:|@import|\\/i, `${label}: ${tag}[${name}]`)
      }
    }
  }
}
const attrOf = (html, selector, name) => new JSDOM(`<body>${html}</body>`).window.document.querySelector(selector)?.getAttribute(name)

// The 05 review's direct payloads (probe1).
const PAYLOADS = [
  '<a href="jav&#x61;script:alert(1)">x</a>', '<a href=" &#106;avascript:alert(1)">x</a>', '<a href="java\tscript:alert(1)">x</a>',
  '<a href="JaVaScRiPt:alert(1)">x</a>', '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
  '<iframe srcdoc="&lt;img src=x onerror=alert(1)&gt;"></iframe>', '<iframe src="data:text/html,<script>alert(1)</script>"></iframe>',
  '<object data="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=="></object>', '<embed src="data:image/svg+xml,<svg onload=alert(1)>">',
  '<svg><script>alert(1)</script></svg>', '<svg/onload=alert(1)>', '<img src=x/onerror=alert(1)>', '<img src=x onerror\n=alert(1)>',
  '<img src="x" title=">" onerror="alert(1)">', '<base href="https://evil.example/">', '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
  '<form action="https://evil.example"><input name=p><button>go</button></form>', '<button formaction="javascript:alert(1)">x</button>',
  '<a href="data:text/html,<script>alert(1)</script>">x</a>', '<style>body{background:url(https://evil.example/x)}</style>',
  '<div style="background:url(javascript:alert(1))">x</div>', '<scr<script>ipt>alert(1)</script>', '<script>alert(1)</script\n>', '<script>alert(1)',
  '<!--<img src="--><img src=x onerror=alert(1)//">', '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
  '<a xlink:href="javascript:alert(1)">x</a>', '<svg><a href="javascript:alert(1)"><text>x</text></a></svg>',
  '<svg><animate attributeName="href" values="javascript:alert(1)"/></svg>', '<svg><set attributeName="onmouseover" to="alert(1)"/></svg>',
  '<details open ontoggle=alert(1)>', '<img src="x"onerror="alert(1)">', '<a href=javascript&colon;alert(1)>x</a>',
  // and a few more of the same families
  '<section class="slide"><div style="background-image: u\\rl(https://evil.example/)">x</div></section>',
  '<iframe data-src="https://evil.example/" data-embed-video="1"></iframe>', '<iframe data-src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ" data-embed-video="1" srcdoc="x"></iframe>',
  '<video src="javascript:alert(1)" poster="data:text/html,x"></video>', '<img src="data:text/html;base64,PHNjcmlwdD4=">', '<svg><use href="https://evil.example/s.svg#x"/></svg>',
  '<svg><rect fill="url(https://evil.example/x)"/></svg>', '<a href="file:///etc/passwd">x</a>', '<a data-src="javascript:alert(1)">x</a>',
]

try {
  // 1 + 2
  const out = await compile(EXAMPLE)
  assert.equal(out.ok, true, JSON.stringify(out.findings))
  assert.equal(out.steps.length, 4)
  assert.deepEqual(out.steps.map((s) => [s.id, s.kind]), [['watch', 'video'], ['check', 'check'], ['try-a-prompt', 'task'], ['what-you-want', 'question']])
  assert.deepEqual(out.steps.map((s) => s.id), ['watch', 'check', 'try-a-prompt', 'what-you-want'])
  assert.match(out.steps[0].stepHtml, /<video[^>]*controls/)
  assert.equal(out.steps[2].layout, 'title-image')
  assert.match(out.steps[2].stepHtml, /<h1>Try one prompt/)
  assert.match(out.steps[2].stepHtml, /<img /)
  assert.match(out.steps[2].stepHtml, /fl-numbered/)
  assert.equal(out.revision, 3)
  assert.match(out.hash, /^[0-9a-f]{64}$/)
  assert.ok(out.form)
  assert.equal('value' in parsePreworkForm(out.form), true)
  assert.deepEqual(out.form.steps.map((s) => [s.id, s.kind]), [['watch', 'slide'], ['check', 'check'], ['try-a-prompt', 'task'], ['what-you-want', 'question']])
  assert.deepEqual(out.form.steps[1].poll.options.map((o) => o.label), ['It uses tools to carry out steps on its own', 'It only answers questions'])
  const publicText = JSON.stringify({ form: out.form, steps: out.steps })
  assert.doesNotMatch(publicText, /\{\s*right\s*\}/i)
  assert.doesNotMatch(publicText, /"right"/)
  assert.doesNotMatch(publicText, /correct|answerIndex/i)
  assert.match(out.styles, /@media \(max-width: 640px\)/)

  // 3. safety: the example's own markup comes through untouched; every review payload is inert
  assert.equal(out.findings.some((f) => f.code === 'work-file-markup-removed'), false, JSON.stringify(out.findings))
  assert.match(attrOf(out.steps[0].stepHtml, 'video', 'src'), /^data:video\/mp4;base64,/)
  assert.equal(attrOf(out.steps[2].stepHtml, 'img', 'alt'), 'the prompt box')
  for (const step of out.steps) assertInert(step.stepHtml, step.id)
  const unsafe = await compile(EXAMPLE.replace('2. Paste your abstract', '2. Paste <b onclick="x()">it</b> <script>alert(1)</script> <a href="javascript:alert(2)">go</a>'))
  assertInert(unsafe.steps[2].stepHtml, 'inline markup')
  for (const payload of PAYLOADS) {
    const result = sanitise(payload)
    assertInert(result.html, payload)
    assertInert(sanitise(`<section class="slide">${payload}</section>`).html, `in a slide: ${payload}`)
  }
  assert.ok(sanitise('<p onclick="x()">x</p>').removed.includes('p@onclick'))
  const player = '<figure class="slide-embed slide-embed-video"><iframe data-src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?enablejsapi=1" data-embed-url="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?enablejsapi=1" data-embed-video="1" title="t" loading="lazy" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen=""></iframe></figure>'
  assert.equal(sanitise(player).html, player)
  const resourcePlayer = player.replace('<iframe ', '<iframe data-resource-url="https://www.youtube.com/watch?v=dQw4w9WgXcQ&amp;t=2#view" ')
  assert.equal(sanitise(resourcePlayer).html, resourcePlayer, 'inert original resource metadata does not remove a permitted video player')
  assert.equal(sanitise(resourcePlayer).removed.length, 0)


  // the review's compiled payloads (probe2, probe3)
  const linked = join(dir, 'probe'); mkdirSync(linked)
  writeFileSync(join(dir, 'outside.png'), PNG)
  writeFileSync(join(linked, 'shot.png'), PNG)
  symlinkSync(join(dir, 'outside.png'), join(linked, 'link.png'))
  const probe = await compileWorkFile({ compilerDir: COMPILER, path: join(linked, 'work.md'), text: workFile([
    ['md-js-link', '[click](javascript:alert(1))'], ['md-js-link-ent', '[click](jav&#x61;script:alert(1))'], ['md-js-img', '![x](javascript:alert(1))'],
    ['raw-block', '<div><img src=x onerror=alert(1)></div>'], ['raw-iframe', '<iframe srcdoc="<script>alert(1)</script>"></iframe>'],
    ['html-fence', '```html\n<script>alert(1)</script><img src=x onerror=alert(1)>\n```'],
    ['svg-fence', '```svg\n<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><a href="javascript:alert(1)"><text>x</text></a><image href="x" onerror="alert(1)"/></svg>\n```'],
    ['mermaid', '```mermaid\ngraph TD; A["<img src=x onerror=alert(1)>"]-->B\n```'], ['title-attr', '![a" onerror="alert(1)](x.png)'],
    ['img-title', '![a onx=1](shot.png "/onload=alert(1)//")'], ['img-title2', '![/onload=alert(1)// onx=1](shot.png "/onload=alert(1)// onx=1")'],
    ['mmd', '```mermaid\ngraph TD; A["x onx=1"]-->B["/onload=alert(1)//"]\n```'], ['link', '[t](https://e.example/a%20 "x onx=1")'],
    ['caption', '![x onx=1](shot.png)\n\nCaption text'], ['embed', '{embed}\nhttps://evil.example/'], ['url-video', '![v](https://evil.example/x.mp4)'],
    ['dotdot', '![up](../outside.png)'], ['abs', `![abs](${join(dir, 'outside.png')})`], ['symlink', '![l](link.png)'],
    ['file-url', `![f](file://${join(dir, 'outside.png')})`], ['dotdot-video', '![v](../clip.mp4)'],
  ], 'Intro <img src=x onerror=alert(1)>') })
  for (const step of probe.steps) {
    assert.ok(step.stepHtml.includes('class="slide'), `${step.id} drawn`)
    assertInert(step.stepHtml, step.id)
  }
  const stepNamed = (id) => probe.steps.find((s) => s.id === id)
  // round trip: the compiler's text in alt, title and data-mmd-src is exactly what the author wrote
  assert.equal(attrOf(stepNamed('img-title').stepHtml, 'img', 'alt'), 'a onx=1')
  const captionOf = (html) => new JSDOM(`<body>${html}</body>`).window.document.querySelector('figcaption')?.textContent
  assert.equal(captionOf(stepNamed('img-title').stepHtml), '/onload=alert(1)//')
  assert.equal(attrOf(stepNamed('img-title2').stepHtml, 'img', 'alt'), '/onload=alert(1)// onx=1')
  assert.equal(captionOf(stepNamed('img-title2').stepHtml), '/onload=alert(1)// onx=1')
  assert.equal(attrOf(sanitise('<img alt=" a &quot;b&quot; --> c " title="x ]]> y" src="shot.png">').html, 'img', 'alt'), ' a "b" --> c ')
  assert.equal(attrOf(sanitise('<img alt="a" title="x ]]> y" src="shot.png">').html, 'img', 'title'), 'x ]]> y')
  assert.equal(attrOf(stepNamed('mmd').stepHtml, '[data-mmd-src]', 'data-mmd-src'), 'graph TD; A["x onx=1"]-->B["/onload=alert(1)//"]')
  assert.equal(attrOf(stepNamed('mermaid').stepHtml, '[data-mmd-src]', 'data-mmd-src'), 'graph TD; A["<img src=x onerror=alert(1)>"]-->B')
  assert.equal(attrOf(stepNamed('link').stepHtml, 'a', 'title'), 'x onx=1')
  assert.equal(attrOf(stepNamed('link').stepHtml, 'a', 'href'), 'https://e.example/a%20')
  assert.equal(attrOf(stepNamed('caption').stepHtml, 'img', 'alt'), 'x onx=1')
  assert.equal(new JSDOM(`<body>${stepNamed('raw-block').stepHtml}</body>`).window.document.querySelector('p.content-p')?.textContent, '<div><img src=x onerror=alert(1)></div>')
  // 7. media outside the folder is blocking; the remote video and the remote page stay warnings
  assert.equal(probe.ok, false)
  const outside = probe.findings.filter((f) => f.code === 'work-file-media-outside')
  assert.deepEqual(outside.map((f) => [f.stepId, f.severity]), [['dotdot', 'blocking'], ['abs', 'blocking'], ['symlink', 'blocking'], ['file-url', 'blocking'], ['dotdot-video', 'blocking']])
  for (const id of ['dotdot', 'abs', 'symlink', 'file-url', 'dotdot-video']) assert.doesNotMatch(stepNamed(id).stepHtml, /data:image|outside/, id)
  assert.equal(probe.findings.find((f) => f.detail === 'remote-video:url-video')?.severity, 'warning')
  assert.equal(probe.findings.find((f) => f.detail === 'remote-embed:embed')?.severity, 'warning')
  assert.ok(probe.findings.some((f) => f.code === 'work-file-markup-removed' && f.stepId === 'embed' && f.detail === 'iframe'))
  const youtube = await compile(workFile([['yt', '{video}\nhttps://youtu.be/dQw4w9WgXcQ'], ['vimeo', '{video}\nhttps://player.vimeo.com/video/123456']]))
  assert.equal(youtube.ok, true, JSON.stringify(youtube.findings))
  assert.deepEqual(youtube.findings.map((f) => [f.code, f.stepId, f.severity]), [['work-file-compile-warning', 'yt', 'warning'], ['work-file-compile-warning', 'vimeo', 'warning']])
  assert.match(attrOf(youtube.steps[0].stepHtml, 'iframe', 'data-src'), /^https:\/\/www\.youtube-nocookie\.com\/embed\/dQw4w9WgXcQ/)
  assert.match(attrOf(youtube.steps[1].stepHtml, 'iframe', 'data-src'), /^https:\/\/player\.vimeo\.com\/video\/123456/)
  // 8. the intro is raw text, never escaped; the file need not be on disk; warnings land on the right step
  assert.equal(probe.introText, 'Intro <img src=x onerror=alert(1)>')
  assert.equal('intro' in probe, false)
  const unsaved = await compileWorkFile({ compilerDir: COMPILER, path: join(dir, 'never-saved', 'work.md'), text: workFile([['a', 'Words.'], ['b', '{poll=scale}']]) })
  assert.deepEqual(unsaved.steps.map((s) => [s.id, s.slideId]), [['a', 'a'], ['b', 'b']])
  assert.equal(unsaved.findings.find((f) => f.detail === 'unresolved-trigger:poll=scale')?.stepId, null)
  assert.equal(unsaved.findings.find((f) => f.detail === 'poll-type-unknown:scale')?.stepId, null)
  const named = await compile(workFile([['scale', '{poll=scale}'], ['remote', '{video}\nhttps://youtu.be/dQw4w9WgXcQ']]))
  assert.equal(named.findings.find((f) => f.detail === 'poll-type-unknown:scale')?.stepId, null, 'a poll type is not a step id')
  assert.equal(named.findings.find((f) => f.detail === 'remote-embed:remote')?.stepId, 'remote')

  // 4. a layout outside the six: a visible finding, drawn as the compiler draws it
  const fancy = await compile(['---', 'id: f', 'title: F', 'revision: 1', '---', '### Years {id=years}{timeline}', '- 1990 start', '- 2000 next', '### Ok {id=ok}', 'Words.', ''].join('\n'))
  assert.equal(fancy.ok, false)
  const finding = fancy.findings.find((f) => f.code === 'work-file-layout-unsupported')
  assert.deepEqual([finding.stepId, finding.detail, finding.severity], ['years', 'timeline', 'blocking'])
  assert.equal(fancy.steps[0].layout, null)
  assert.equal(fancy.steps[0].layoutName, 'timeline')
  assert.match(fancy.steps[0].stepHtml, /layout-timeline/)
  assert.equal(fancy.steps.length, 2)

  // 5. a missing image does not crash
  const missing = await compile(['---', 'id: m', 'title: M', 'revision: 1', '---', '### Pic {id=pic}', '![x](nope.png)', ''].join('\n'))
  assert.equal(missing.steps.length, 1)
  assert.ok(missing.steps[0].stepHtml.includes('slide'))

  // 6. steps meet their slides by id
  assert.deepEqual(expectedSlideIds(['a', 'b', 'a', null, 'a', 'a-2']), ['a', 'b', 'a-2', null, 'a-3', 'a-2-2'])
  const twice = await compile(workFile([['same', 'Alpha.'], ['other', 'Beta.'], ['same', 'Gamma.']]))
  assert.deepEqual(twice.steps.map((s) => s.slideId), ['same', 'other', 'same-2'])
  assert.match(twice.steps[0].stepHtml, /Alpha/)
  assert.match(twice.steps[2].stepHtml, /Gamma/)
  assert.doesNotMatch(twice.steps[2].stepHtml, /Alpha/)
  assert.equal(twice.ok, false)
  const badId = await compile(['---', 'id: b', 'title: B', 'revision: 1', '---', '### Fine {id=fine}', 'Fine body.', '### Bad {id=Not_A_Slug}', 'Bad body.', ''].join('\n'))
  assert.deepEqual(badId.steps.map((s) => [s.id, s.slideId, s.stepHtml === '']), [['fine', 'fine', false], [null, null, true]])
  const unmatched = badId.findings.find((f) => f.code === 'work-file-step-unmatched')
  assert.deepEqual([unmatched?.detail, unmatched?.severity], ['Bad', 'blocking'])
  assert.equal(badId.ok, false)
  // 9. ticket 15's hardening (05 re-review): lazy addresses are addresses; a player's `allow` holds only the
  //    compiler's tokens; an SVG link opens no new tab; a reserved step id is its own finding
  for (const name of ['data-lazy-src', 'data-lazy-poster', 'data-lazy-url']) {
    const lazy = sanitise(`<img ${name}="javascript:alert(1)"><div ${name}="data:text/html,x">y</div>`)
    assert.equal(lazy.html.includes(name), false, `${name} with a script address is removed`)
    assert.ok(lazy.removed.includes(`img@${name}`))
    assert.equal(sanitise(`<img ${name}="https://e.example/a.png">`).html.includes(name), true, `${name} with an https address stays`)
  }
  const frameWith = (allow) => `<iframe data-src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ" data-embed-video="1" allow="${allow}"></iframe>`
  for (const allow of ['camera *', 'autoplay; microphone', 'fullscreen https://evil.example', 'autoplay *', 'geolocation']) {
    const kept = sanitise(frameWith(allow)).html
    assert.ok(kept === '' || attrOf(kept, 'iframe', 'allow') === null, `allow="${allow}" never reaches the page: ${kept}`)
  }
  assert.match(sanitise(frameWith('autoplay; encrypted-media; picture-in-picture; fullscreen')).html, /<iframe/)
  assert.match(sanitise(frameWith('fullscreen')).html, /<iframe/)
  // `www.` is YouTube no-cookie's only (ticket 15 review): the sanitiser and the page's frame-src agree.
  const playerFrame = (src) => sanitise(`<iframe data-src="${src}" data-embed-video="1"></iframe>`).html
  assert.match(playerFrame('https://player.vimeo.com/video/123456'), /<iframe/)
  assert.match(playerFrame('https://youtube-nocookie.com/embed/dQw4w9WgXcQ'), /<iframe/)
  assert.doesNotMatch(playerFrame('https://www.player.vimeo.com/video/123456'), /<iframe/, 'www.player.vimeo.com is not a player the page allows')
  const svgLink = sanitise('<svg><a href="https://e.example/" target="_blank"><text>x</text></a></svg>')
  assert.doesNotMatch(svgLink.html, /target=/, 'an SVG link loses target')
  assert.ok(svgLink.removed.includes('a@target'))
  assert.match(sanitise('<a href="https://e.example/" target="_blank">x</a>').html, /rel="noopener noreferrer"/)
  assert.match(sanitise('<a href="//e.example/x">x</a>').html, /href="\/\/e\.example\/x"/, 'a protocol-relative address passes, as the module comment says')
  const reserved = await compile(workFile([['title', 'Words.'], ['links', 'More.'], ['fine', 'Fine.']]))
  assert.deepEqual(reserved.findings.filter((f) => f.code === 'work-file-step-id-reserved').map((f) => [f.stepId, f.detail, f.severity]), [['title', 'title', 'warning'], ['links', 'links', 'warning']])
  assert.equal(reserved.findings.some((f) => f.code === 'work-file-markup-removed' && /@(?:id|name)\b/.test(f.detail)), false, 'a reserved id is not reported as markup removed')

  // A step whose sanitised HTML is empty with nothing reported removed still lost its markup (ticket 15 review).
  for (const only of ['<noframes>x</noframes>', '<title>x</title>']) {
    const clean = sanitise(only)
    assert.equal(clean.html.trim(), '', only)
    assert.deepEqual(removedMarkup(only, clean, false).length > 0, true, `${only}: reported`)
  }
  assert.deepEqual(removedMarkup('<noframes>x</noframes>', { html: '', removed: [] }, false), ['everything'])
  assert.deepEqual(removedMarkup('', { html: '', removed: [] }, false), [], 'nothing in, nothing to report')
  assert.deepEqual(removedMarkup('<p>x</p>', { html: '<p>x</p>', removed: [] }, false), [])
  assert.deepEqual(removedMarkup('<p id="title">x</p>', { html: '<p>x</p>', removed: ['p@id'] }, true), [], 'a reserved id is its own finding')

  console.log('work-file compile ok')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
