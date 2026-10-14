// The "Quote form: …" commands (palette and Actions here) against the editor's real change guards.
// A chosen form was sometimes dropped with no notice: the command dispatched its change as user input
// (`input.quote-form`), the protected-token guard treated it as typing, and a change whose span reached the
// `{id=…}` token's opening brace was refused. This drives setQuoteFormAtCursor on an EditorState carrying
// the production guards, five choices in a row, and asserts the layout line after each.
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const bundleDir = mkdtempSync(join(tmpdir(), 'talk-weaver-quote-form-command-'))
const bundleUrl = pathToFileURL(join(bundleDir, 'bundle.mjs'))
let runtime
try {
  await build({
    stdin: {
      contents: [
        "export { setQuoteFormAtCursor } from './src/renderer/src/extensions/outliner.ts'",
        "export { idProtectExtension } from './src/renderer/src/extensions/idProtect.ts'",
        "export { EditorState } from '@codemirror/state'"
      ].join('\n'),
      resolveDir: fileURLToPath(new URL('..', import.meta.url)),
      sourcefile: 'test-quote-form-command-entry.ts'
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: fileURLToPath(bundleUrl)
  })
  runtime = await import(`${bundleUrl.href}?t=${Date.now()}`)
} finally {
  rmSync(bundleDir, { recursive: true, force: true })
}
const { setQuoteFormAtCursor, idProtectExtension, EditorState } = runtime

const doc = [
  '# Talk', '', '## Section', '',
  '### Quote', '{quote}{id=qnoln}', '',
  '> A superhuman thing.', '',
  '- Someone, 2026 https://x.com/someone/status/1234567890123456789', ''
].join('\n')

// A view with the two members the command uses; state.update runs the real filters, so a refused change leaves state alone.
function fakeView(text, caret) {
  const view = {
    state: EditorState.create({ doc: text, selection: { anchor: caret }, extensions: [idProtectExtension] }),
    dispatch(spec) { view.state = view.state.update(spec).state },
    focus() {}
  }
  return view
}
const layoutLine = (view) => view.state.doc.toString().split('\n').find((l) => l.startsWith('{quote}'))

const view = fakeView(doc, doc.indexOf('A superhuman'))
const sequence = [
  ['tweet', '{quote}{form=tweet}{id=qnoln}'],
  ['auto', '{quote}{id=qnoln}'],
  ['plain', '{quote}{form=plain}{id=qnoln}'],
  ['tweet', '{quote}{form=tweet}{id=qnoln}'],
  ['web', '{quote}{form=web}{id=qnoln}'],
  ['auto', '{quote}{id=qnoln}'],
  ['video', '{quote}{form=video}{id=qnoln}'],
  ['book', '{quote}{form=book}{id=qnoln}'],
  ['paper', '{quote}{form=paper}{id=qnoln}'],
  ['auto', '{quote}{id=qnoln}']
]
for (const [form, want] of sequence) {
  setQuoteFormAtCursor(view, form)
  assert.equal(layoutLine(view), want, `Quote form: ${form} must leave ${want}`)
}
assert.ok(view.state.doc.toString().includes('{id=qnoln}'), 'the id token survives every choice')
console.log(`quote form command ok (${sequence.length} choices in a row)`)

// A quote-only slide with no `{quote}` token is a quote slide the compiler draws with the quote layout (the editor passes the
// compiled row's layout to the command; the layout resolution itself is under test in test-quote-forms.mjs); the same
// ten choices write only `{form=…}` (with the id token kept), and Automatic returns the document byte for byte.
for (const [label, lines, idToken] of [
  ['an {id} line only', ['# Talk', '', '## Section', '', '### Inferred', '{id=qinf}', '', '> A superhuman thing.', '', '- Someone, 2026 https://x.com/someone/status/1234567890123456789', ''], '{id=qinf}'],
  ['no layout line', ['# Talk', '', '## Section', '', '### Inferred', '', '> A superhuman thing.', '', '- Someone, 2026 https://x.com/someone/status/1234567890123456789', ''], '']
]) {
  const inferredDoc = lines.join('\n')
  const inferred = fakeView(inferredDoc, inferredDoc.indexOf('A superhuman'))
  const triggerOf = (v) => v.state.doc.toString().split('\n').slice(5, 6)[0]
  const withForm = (form) => `${idToken ? `${idToken} ` : ''}{form=${form}}`
  const steps = [
    ['tweet', withForm('tweet')], ['auto', null], ['plain', withForm('plain')], ['tweet', withForm('tweet')],
    ['web', withForm('web')], ['auto', null], ['video', withForm('video')], ['book', withForm('book')],
    ['paper', withForm('paper')], ['auto', null]
  ]
  for (const [form, want] of steps) {
    setQuoteFormAtCursor(inferred, form, () => 'quote') // the compiled row's layout, which the editor passes in
    if (want === null) assert.equal(inferred.state.doc.toString(), inferredDoc, `${label}: Quote form: ${form} restores the original document byte for byte`)
    else assert.equal(triggerOf(inferred), want, `${label}: Quote form: ${form} must leave ${want}`)
  }
}
{
  // Without the compiled layout there is nothing to say the slide is a quote: the command changes nothing.
  const doc2 = ['# Talk', '', '## Section', '', '### Inferred', '', '> Words.', ''].join('\n')
  globalThis.window = { dispatchEvent() { return true } } // the refusal toasts through window
  globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail } }
  const untouched = fakeView(doc2, doc2.indexOf('Words'))
  setQuoteFormAtCursor(untouched, 'tweet')
  assert.equal(untouched.state.doc.toString(), doc2)
}
console.log('quote form command ok on a quote slide with no {quote} token (ten choices, byte-for-byte return)')
