// 0.37 preview.4: a title written with inline markdown (**Pre-work Workshop**) shows its bold on the
// handout landing page, and reads as plain text where HTML cannot go (the <title> element, meta tags).
// Everything else in a title is escaped: a title is never a way to put markup on the page.
import { strict as assert } from 'node:assert'
import { resolve } from 'node:path'
import { viewerPageHtml } from '../src/main/handout-viewer-page.ts'
import { plainInlineText } from '../compiler/scripts/lib/00-inline-render.mjs'
import { buildShareHtml } from '../compiler/scripts/lib/09-output-builders.mjs'

const page = async (title) => viewerPageHtml({ title, handoutFile: 't.html', url: 'https://x.test/t', qr: '' }, resolve(import.meta.dirname, '../compiler/scripts'))
const between = (html, tag) => html.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))[1]

const bold = await page('TalkWeaver **Pre-work Workshop**')
assert.equal(between(bold, 'h1'), 'TalkWeaver <strong>Pre-work Workshop</strong>', 'the heading renders **bold**')
assert.equal(between(bold, 'title'), 'TalkWeaver Pre-work Workshop — handout', 'the <title> has no markers')
assert(!/\*/.test(between(bold, 'title')) && !/\*/.test(between(bold, 'h1')), 'no asterisks survive anywhere in the title')
assert.equal(between(await page('An *italic* and `code` title'), 'h1'), 'An <em>italic</em> and <code>code</code> title')
assert.equal(plainInlineText('An *italic* and `code` [link](https://a.test) title'), 'An italic and code link title')
assert.equal(plainInlineText('snake_case_name stays'), 'snake_case_name stays', 'underscores inside words are not emphasis')

const hostile = await page('<script>alert(1)</script> **bold** <img src=x onerror=alert(1)>')
assert(!/<script|<img/i.test(hostile), 'a title with markup stays text')
assert(between(hostile, 'h1').includes('&lt;script&gt;') && between(hostile, 'h1').includes('<strong>bold</strong>'))
assert(between(hostile, 'title').includes('&lt;script&gt;'), 'the <title> is escaped too')
assert(!/href="javascript:/i.test(await page('[x](javascript:alert(1))')), 'an unsafe link target does not become an href')

const share = buildShareHtml({ title: 'TalkWeaver **Pre-work Workshop**', slides: [], styles: '', includeNotes: false, slug: 't' })
assert.equal(between(share, 'title'), 'TalkWeaver Pre-work Workshop')
assert(share.includes('<meta name="deck-title" content="TalkWeaver Pre-work Workshop">'))
console.log('PASS handout title: heading renders bold, <title> and deck-title are plain, hostile titles stay text')
