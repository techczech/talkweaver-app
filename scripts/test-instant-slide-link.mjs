// Instant slide Link field: what is accepted (and how it is written and encoded) and what is refused.
// Seam: normaliseInstantLink (compiler/assets/runtime/instant-slide.js).
import assert from 'node:assert/strict'
import { normaliseInstantLink, instantSlideFromText } from '../compiler/assets/runtime/instant-slide.js'

// [typed, url encoded in the QR and linked, link as written on the slide]
const accepted = [
  ['example.com/form', 'https://example.com/form', 'example.com/form'],
  ['  example.com/form  ', 'https://example.com/form', 'example.com/form'],
  ['https://example.com/form', 'https://example.com/form', 'example.com/form'],
  ['http://example.com/form', 'http://example.com/form', 'example.com/form'],
  ['HTTPS://Example.com/Form', 'https://example.com/Form', 'example.com/Form'],
  ['https://bücher.example/x', 'https://xn--bcher-kva.example/x', 'xn--bcher-kva.example/x'],
  ['пример.рф', 'https://xn--e1afmkfd.xn--p1ai/', 'xn--e1afmkfd.xn--p1ai'],
  ['www.example.com', 'https://www.example.com/', 'example.com'],
  ['example.com', 'https://example.com/', 'example.com'],
  ['example.com/', 'https://example.com/', 'example.com'],
  ['//example.com/form', 'https://example.com/form', 'example.com/form'],
  ['example.com:8080/form', 'https://example.com:8080/form', 'example.com:8080/form'],
  ['sub.example.co.uk/a/b?x=1&y=2#top', 'https://sub.example.co.uk/a/b?x=1&y=2#top', 'sub.example.co.uk/a/b?x=1&y=2#top'],
  ['forms.office.com/r/AbC123', 'https://forms.office.com/r/AbC123', 'forms.office.com/r/AbC123'],
]
for (const [typed, url, written] of accepted) {
  assert.deepEqual(normaliseInstantLink(typed), { url, written }, typed)
}

for (const typed of ['', '   ', null, undefined]) assert.deepEqual(normaliseInstantLink(typed), { empty: true }, JSON.stringify(typed))

// The canonical href is what is stored and written: < > \" and path backticks are percent-encoded.
const encoded = [
  ['https://x.com/a>b', 'https://x.com/a%3Eb'], ['https://x.com/<!--', 'https://x.com/%3C!--'], ['x.com/a"b', 'https://x.com/a%22b'],
  ['x.com/a`b', 'https://x.com/a%60b'], ['https://x.com/<!--x-->', 'https://x.com/%3C!--x--%3E'], ['x.com/p?q=<a>#f"g', 'https://x.com/p?q=%3Ca%3E#f%22g'],
]
for (const [typed, url] of encoded) {
  const result = normaliseInstantLink(typed)
  assert.equal(result.url, url, typed)
  assert.ok(!/[<>"`]/.test(result.url), typed + ' leaves nothing that could open a comment')
}

const refused = [
  'https://x.com/p?q=`', 'x.com/a\u0001b', 'https://x.com/a\u007fb',
  'javascript:alert(1)', 'JavaScript:alert(1)', ' javascript:alert(1)', 'javascript://example.com/%0aalert(1)',
  'data:text/html,<script>alert(1)</script>', 'file:///etc/passwd', 'file://example.com/x', 'ftp://example.com/x',
  'vbscript:msgbox(1)', 'mailto:a@example.com', 'tel:+441234', 'blob:https://example.com/abc', 'about:blank',
  'https://good.example@evil.example/x', 'good.example@evil.example/x', 'https://user:pw@example.com/x', 'http://a@b.example',
  'https://', 'https:///nothing', 'two words.com', 'localhost', 'hello', 'x'.repeat(2100) + '.com',
]
for (const typed of refused) {
  const result = normaliseInstantLink(typed)
  assert.equal(typeof result.error, 'string', typed + ' is refused with a note')
  assert.equal(result.url, undefined, typed + ' yields no url')
}
assert.match(normaliseInstantLink('javascript:alert(1)').error, /http/i, 'the note says what is accepted')

// A lone address typed into the Text field alone is still a link slide, as before.
assert.equal(instantSlideFromText('https://example.com/x', 5).kind, 'link')
assert.equal(instantSlideFromText('Please fill in example.com/x', 5).kind, 'text')

console.log('instant-slide link tests passed')
