#!/usr/bin/env node
/**
 * The audience page's phone text view renders the slide's outline text, never its authoring
 * syntax (found 2026-09-28: `**bold**`, `{icon=…}` and `[QR: …]` shown raw).
 *
 * Unit level: the transformation from slide-script payload text to display HTML
 * (slide-script-render.mjs) and the payload's code-fence block (slide-script.mjs).
 * The rendered page at 360×740 is covered by test-phone-text-dom.mjs.
 */
import { strict as assert } from 'node:assert'
import { renderScriptInline, renderScriptBlocks, renderSlideNavTitle, isPhoneHref } from '../compiler/scripts/lib/slide-script-render.mjs'
import { isSafeLinkUrl, renderInline } from '../compiler/scripts/lib/00-inline-render.mjs'
import { parseSlideScript } from '../compiler/scripts/lib/slide-script.mjs'

let passed = 0
const check = (name, fn) => {
  fn()
  passed += 1
  console.log(`  ok  ${name}`)
}
const r = renderScriptInline

check('bold renders as <strong>', () => {
  assert.equal(r('A **bold** word'), 'A <strong>bold</strong> word')
})
check('italic renders as <em>', () => {
  assert.equal(r('An *italic* word'), 'An <em>italic</em> word')
})
check('a snake_case_word stays whole', () => {
  assert.equal(r('the snake_case_word stays'), 'the snake_case_word stays')
})
check('a code span keeps its characters exactly', () => {
  assert.equal(r('run `code_with_underscores` now'), 'run <code>code_with_underscores</code> now')
  assert.equal(r('math `a*b*c` and `x\\*y`'), 'math <code>a*b*c</code> and <code>x\\*y</code>')
  assert.equal(r('`<b> & {icon=star}`'), '<code>&lt;b&gt; &amp; {icon=star}</code>')
})
check('a URL with underscores is one link, never emphasis', () => {
  const url = 'https://example.com/some_path/_x_/file_name.html'
  assert.equal(r(`see ${url} here`), `see <a href="${url}" target="_blank" rel="noopener">${url}</a> here`)
  assert.equal(r(`a [link](${url}) here`), `a <a href="${url}" target="_blank" rel="noopener">link</a> here`)
})
check('{icon=star} inside or trailing a line is removed', () => {
  assert.equal(r('Stars {icon=star} inline'), 'Stars inline')
  assert.equal(r('A bullet {icon=star}'), 'A bullet')
  assert.equal(r('A bullet {star}', { listItem: true }), 'A bullet', 'bare icon shorthand trailing a list item, as the lexer strips it')
})
check('braces follow the lexer: only key=value tokens and a trailing list-item icon are removed', () => {
  assert.equal(r('Sized {w=40} thing'), 'Sized thing')
  assert.equal(r('the set {a, b} stays'), 'the set {a, b} stays')
  assert.equal(r('Inline {reveal} trigger'), 'Inline {reveal} trigger', 'the slide shows a mid-line {reveal}')
  assert.equal(r('use {username} and {password}'), 'use {username} and {password}')
  assert.equal(r('Price {x} per unit'), 'Price {x} per unit', '{x} is an icon name, but only a trailing list-item token is one')
  assert.equal(r('Price {x} per unit', { listItem: true }), 'Price {x} per unit')
  assert.equal(r('A paragraph ends {star}'), 'A paragraph ends {star}', 'the lexer strips {NAME} from list items only')
  assert.equal(r('a list item {x}', { listItem: true }), 'a list item')
  assert.equal(r('a list item {username}', { listItem: true }), 'a list item {username}', 'not an icon')
  assert.equal(r('template {{ value }} and {"a": 1}'), 'template {{ value }} and {&quot;a&quot;: 1}')
})
check('a brace token never alters a link target', () => {
  assert.equal(r('[a](https://x/{w=1}/c)'), '<a href="https://x/{w=1}/c" target="_blank" rel="noopener">a</a>')
  assert.equal(r('see https://x/{a=b}/{star}', { listItem: true }),
    'see <a href="https://x/{a=b}/{star}" target="_blank" rel="noopener">https://x/{a=b}/{star}</a>')
})
check('[QR: …] becomes a link to its target, never raw text', () => {
  assert.equal(r('Scan [qr:https://example.com/q_r] now'),
    'Scan <a href="https://example.com/q_r" target="_blank" rel="noopener">https://example.com/q_r</a> now')
  assert.equal(r('[QR: https://example.com/a | Scan me]'),
    '<a href="https://example.com/a" target="_blank" rel="noopener">Scan me</a>')
})
check('an escaped \\* is a literal asterisk', () => {
  assert.equal(r('Escaped \\*not italic\\* here'), 'Escaped *not italic* here')
  assert.equal(r('a \\_b\\_ c \\{icon=star}'), 'a _b_ c {icon=star}')
})
check('HTML in the source is escaped; unsafe link targets are neutralised', () => {
  assert.equal(r('<img src=x onerror=alert(1)> & co'), '&lt;img src=x onerror=alert(1)&gt; &amp; co')
  assert.equal(r('[go](javascript:alert)'), '<a href="#" target="_blank" rel="noopener">go</a>')
})
check('==mark== goes through the compiler renderer', () => {
  assert.equal(r('a ==marked== word'), 'a <mark class="ink-marker">marked</mark> word')
})
check('emphasis spans a code span or link and never enters it', () => {
  assert.equal(r('**bold `a*b` [a *b* c](https://x/_y_/)**'),
    '<strong>bold <code>a*b</code> <a href="https://x/_y_/" target="_blank" rel="noopener">a <em>b</em> c</a></strong>')
})

check('payload blocks carry rendered html; a whole-line QR is its own block', () => {
  const blocks = renderScriptBlocks([
    { type: 'list', items: [{ depth: 0, text: '**One** {icon=star}' }, { depth: 1, text: 'a :: b', pair: '*two*' }] },
    { type: 'p', text: '[QR: https://example.com/x | Handout]' },
    { type: 'quote', text: 'A **strong** quote' },
    { type: 'table', rows: [['*h*', 'k'], ['`v_1`', 'w']] },
    { type: 'code', text: '  x = a*b*c\n  {icon=star}' },
  ])
  assert.deepEqual(blocks, [
    { type: 'list', items: [{ depth: 0, html: '<strong>One</strong>' }, { depth: 1, html: 'a :: b', pairHtml: '<em>two</em>' }] },
    { type: 'qr', html: '<a href="https://example.com/x" target="_blank" rel="noopener">Handout</a>' },
    { type: 'quote', html: 'A <strong>strong</strong> quote' },
    { type: 'table', rows: [['<em>h</em>', 'k'], ['<code>v_1</code>', 'w']] },
    { type: 'code', text: '  x = a*b*c\n  {icon=star}' },
  ])
})

check('a content code fence is one code block, characters kept', () => {
  const blocks = parseSlideScript([
    '### Code', '', '```js', 'const x = a*b*c', '', '  - not_a_bullet {icon=star}', '```', '- after',
  ].join('\n'))
  assert.deepEqual(blocks, [
    { type: 'code', text: 'const x = a*b*c\n\n  - not_a_bullet {icon=star}' },
    { type: 'list', items: [{ depth: 0, text: 'after' }] },
  ])
})

check('the nav title renders from the slide section attribute', () => {
  const html = '<section class="slide" data-id="t" data-nav-title="A **bold** &amp; `co_de` title &quot;q&quot;"><h2>x</h2></section>'
  assert.equal(renderSlideNavTitle(html), 'A <strong>bold</strong> &amp; <code>co_de</code> title &quot;q&quot;')
})

// ── Hostile input (security review 2026-09-28) ──────────────────────────────────────────────
// Every tag the phone renderer emits is one of these; an href is never built from anything but a
// token's raw target text. A QR held as a finished anchor inside a link target or bare URL once
// closed the outer href and ran the author's text as event handlers.
const TAG_RE = /<[^>]*>/g
const OPEN_A_RE = /^<a href="([^"<>]*)" target="_blank" rel="noopener">$/
const SIMPLE_TAGS = new Set(['<strong>', '</strong>', '<em>', '</em>', '<code>', '</code>', '<mark class="ink-marker">', '</mark>', '</a>'])
const decode = (v) => v.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
const SCRIPT_SCHEME_RE = /^[\s\u0000-\u001f]*(?:j\s*a\s*v\s*a\s*s\s*c\s*r\s*i\s*p\s*t|data|vbscript)\s*:/i

/** Assert html is only renderer-built tags around escaped text; return its hrefs, decoded. */
function inspectFragment(html, where) {
  const hrefs = []
  let depth = 0
  const text = html.replace(TAG_RE, (tag) => {
    const a = tag.match(OPEN_A_RE)
    if (a) {
      depth += 1
      assert.equal(depth, 1, `${where}: an anchor inside an anchor: ${html}`)
      hrefs.push(decode(a[1]))
      return ''
    }
    assert.ok(SIMPLE_TAGS.has(tag), `${where}: a tag the renderer never builds: ${tag}\n  in ${html}`)
    if (tag === '</a>') depth -= 1
    return ''
  })
  assert.equal(depth, 0, `${where}: unbalanced anchors: ${html}`)
  assert.ok(!/[<>"]/.test(text), `${where}: raw < > or " outside a tag: ${html}`)
  assert.ok(!/￼/.test(html), `${where}: a fragment marker leaked: ${html}`)
  for (const href of hrefs) {
    assert.ok(href === '#' || (isPhoneHref(href) && isSafeLinkUrl(href)), `${where}: unsafe href ${JSON.stringify(href)}`)
    assert.ok(!SCRIPT_SCHEME_RE.test(href) && !/[\s-]/.test(href), `${where}: script scheme or bad char in ${JSON.stringify(href)}`)
  }
  return hrefs
}
const slideHrefs = (text) => [...renderInline(text).matchAll(/<a href="([^"]*)"/g)].map((m) => decode(m[1]))

const QR_HANDLER = 'https://a onmouseover=alert(1) x'
const HOSTILE = [
  // the reviewer's exploit: a QR inside a link target, inside a bare URL, a QR target with spaces
  `[a](https://x/[QR: ${QR_HANDLER}])`,
  'see https://x/[QR: https://a onfocus=alert(1) autofocus x] now',
  `==mark [a](https://x/[QR: ${QR_HANDLER}])==`,
  `**[a](https://x/[QR: ${QR_HANDLER}])**`,
  '[QR: https://a onfocus=alert(1) autofocus tabindex=0 x | label]',
  `[a]([QR: ${QR_HANDLER}])`,
  `(https://x/[QR: ${QR_HANDLER}])`,
  // script schemes, case, entities, whitespace and control prefixes
  '[x](javascript:alert(1))', '[x](JaVaScRiPt:alert(1))', '[x]( javascript:alert(1))', '[x](\tjavascript:alert(1))',
  '[x](&#106;avascript:alert(1))', '[x](&#x6A;avascript:alert(1))', '[x](java&#115;cript:alert(1))',
  '[x](\u0001javascript:alert(1))', '[x](\u0000javascript:alert(1))', '[x](​javascript:alert(1))',
  '[x](data:text/html,<script>alert(1)</script>)', '[x](vbscript:msgbox)', '[x](%6Aavascript:alert(1))',
  '[QR: javascript:alert(1) | hi]', '[QR: JaVaScRiPt:alert(1)]', '[QR: data:text/html,x | d]',
  // quotes and > in hrefs and link text
  '[x](https://a"onmouseover=alert(1))', "[x](https://a'onmouseover=alert(1))", '[x](https://a>b)',
  '[x"><img src=x onerror=alert(1)>](https://a)', '[QR: https://a" onmouseover="alert(1) | l"><b>x]',
  '[l](https://a "t\\" onmouseover=alert(1) x")', 'see https://a"onmouseover=alert(1) now', '[a](https://x/`"q`)', '[a](https://x/\\")',
  // raw HTML
  '<img src=x onerror=alert(1)>', '<svg onload=alert(1)>', '</script><script>alert(1)</script>',
  '\\<img src=x onerror=alert(1)\\>', '{icon=x"><img src=x onerror=alert(1)>}', '<scr{reveal}ipt>alert(1)</scr{x=1}ipt>',
  // private-use characters (the old placeholder alphabet) in text and URLs
  '0 ', '[a](https://x/0)', 'https://x/0 here', '[QR: https://x/0 | q]',
  '￼ [a](https://x) ￼', 'a 󰀀 b [c](https://x/󰀀)',
  // nested constructs
  '[see https://b.example](https://a.example)', '[a [b](https://b)](https://a)',
  '[QR: https://a | see [x](https://b)]', '[QR: https://a | **b** <i>]', '`[QR: https://a onfocus=alert(1) x]`',
  '`[a](javascript:alert(1))`', '[`code`](https://a)', '[x](https://a)[y](javascript:1)',
]

check('hostile input: only renderer-built tags, only validated hrefs, never more permissive than the slide', () => {
  for (const input of HOSTILE) {
    for (const options of [{}, { listItem: true }, { links: false }]) {
      const where = `${JSON.stringify(input)} ${JSON.stringify(options)}`
      const html = r(input, options)
      const hrefs = inspectFragment(html, where)
      if (options.links === false) assert.deepEqual(hrefs, [], `${where}: links disabled at source`)
      const slide = slideHrefs(input)
      for (const href of hrefs) {
        if (href !== '#') assert.ok(slide.includes(href), `${where}: phone links to ${href}; the slide does not (${JSON.stringify(slide)})`)
      }
    }
  }
})

check('hostile input: a QR inside a link target or bare URL stays text, never an attribute', () => {
  assert.equal(r(`[a](https://x/[QR: ${QR_HANDLER}])`),
    '[a](<a href="https://x/[QR" target="_blank" rel="noopener">https://x/[QR</a>: '
    + '<a href="https://a" target="_blank" rel="noopener">https://a</a> onmouseover=alert(1) x])')
  assert.equal(r('see https://x/[QR: https://a onfocus=alert(1) autofocus x] now'),
    'see <a href="https://x/[QR" target="_blank" rel="noopener">https://x/[QR</a>: '
    + '<a href="https://a" target="_blank" rel="noopener">https://a</a> onfocus=alert(1) autofocus x] now')
  assert.equal(r('[QR: https://a onfocus=alert(1) x | label]'), '<a href="#" target="_blank" rel="noopener">label</a>',
    'a QR target with spaces is not a URL')
  assert.equal(r('`[QR: https://a onfocus=alert(1) x]`'), '<code>[QR: https://a onfocus=alert(1) x]</code>')
  assert.equal(r('[QR: https://a | see [x](https://b)]'),
    '<a href="https://a" target="_blank" rel="noopener">see [x</a>(<a href="https://b" target="_blank" rel="noopener">https://b</a>)]')
  assert.equal(r('[see https://b.example](https://a.example)'),
    '<a href="https://a.example" target="_blank" rel="noopener">see https://b.example</a>', 'a link label never holds a link')
})

check('isPhoneHref: the slide rule plus a character check', () => {
  for (const ok of ['https://example.com/a_b?x=1&y=2#h', 'http://a', 'mailto:a@b.c', '#top', './x', '/x', '../x'])
    assert.equal(isPhoneHref(ok), true, ok)
  for (const bad of ['', 'javascript:alert(1)', 'JaVaScRiPt:x', ' https://a', '\u0001https://a', 'https://a b', 'https://a\tb',
    'https://a"b', "https://a'b", 'https://a<b', 'https://a>b', 'https://a`b', 'https://a​b', 'https://a‮b',
    'https://a/', 'https://a/￼', 'https://a/󰀀', 'data:text/html,x', 'vbscript:x', '&#106;avascript:x', 'ftp://a'])
    assert.equal(isPhoneHref(bad), false, JSON.stringify(bad))
})

check('hostile titles: decoded once, then rendered; links disabled at source for rows and the bar', () => {
  const section = (title) => `<section class="slide" data-nav-title="${title}"><h2>x</h2></section>`
  const exploit = section('Title [t](https://x/[QR: https://a onfocus=window.__pwn=1 autofocus x]) end')
  for (const links of [true, false]) inspectFragment(renderSlideNavTitle(exploit, { links }), `exploit title links=${links}`)
  assert.equal(renderSlideNavTitle(section('A [link](https://a) and https://b **b**'), { links: false }),
    'A link and https://b <strong>b</strong>')
  assert.equal(renderSlideNavTitle(section('[x](&amp;#106;avascript:alert(1))')),
    '<a href="#" target="_blank" rel="noopener">x</a>)', 'an entity in the outline stays an entity, and fails the check')
  assert.equal(renderSlideNavTitle(section('[x](&#106;avascript:alert(1))')),
    '<a href="#" target="_blank" rel="noopener">x</a>)', 'an attribute entity is decoded before the check')
  assert.equal(renderSlideNavTitle(section('&lt;img src=x onerror=alert(1)&gt; &quot;q&quot;')),
    '&lt;img src=x onerror=alert(1)&gt; &quot;q&quot;')
})

check('hostile own-line QR block: target validated, label escaped', () => {
  const blocks = renderScriptBlocks([
    { type: 'p', text: '[QR: https://a onfocus=alert(1) x | l"><img src=x onerror=alert(1)>]' },
    { type: 'p', text: '[QR: javascript:alert(1)]' },
    { type: 'list', items: [{ depth: 0, text: `[a](https://x/[QR: ${QR_HANDLER}])` }] },
    { type: 'table', rows: [[`[c](https://x/[QR: ${QR_HANDLER}])`]] },
  ])
  assert.equal(blocks[0].html, '<a href="#" target="_blank" rel="noopener">l&quot;&gt;&lt;img src=x onerror=alert(1)&gt;</a>')
  assert.equal(blocks[1].html, '<a href="#" target="_blank" rel="noopener">javascript:alert(1)</a>')
  inspectFragment(blocks[2].items[0].html, 'list item')
  inspectFragment(blocks[3].rows[0][0], 'table cell')
})

check('a diagram fence is one Diagram row, never its source', () => {
  const blocks = parseSlideScript([
    '### Diagrams', '', '```mermaid', 'graph TD', '  A-->B', '```', '', '~~~svg', '<svg onload=alert(1)></svg>', '~~~', '',
    '```js', 'const x = 1', '```', '',
  ].join('\n'))
  assert.deepEqual(blocks, [{ type: 'diagram' }, { type: 'diagram' }, { type: 'code', text: 'const x = 1' }])
  assert.deepEqual(renderScriptBlocks(blocks), [{ type: 'diagram' }, { type: 'diagram' }, { type: 'code', text: 'const x = 1' }])
})

check('a code fence closed inside a folded child never carries into the next child', () => {
  const blocks = parseSlideScript([
    '### Cols {columns}', '', '#### Left', '', '```js', 'x = 1', '```', '', '#### Right', '', '- b',
  ].join('\n'))
  assert.deepEqual(blocks, [
    { type: 'p', text: 'Left' }, { type: 'code', text: 'x = 1' }, { type: 'p', text: 'Right' },
    { type: 'list', items: [{ depth: 0, text: 'b' }] },
  ])
})

console.log(`phone text inline: ${passed} checks passed`)
