// Fourth review round of quote forms ticket 10 (13 October): `set-quote-picture` reads the slide as the compiler does.
// Run by scripts/test-quote-forms-address-under-quote.mjs (section E3). Plain Node.
//
//   - A Trigger line among the content that holds image syntax (`{reveal ![x](a.png)}`) is folded into the slide by
//     the compiler: it is no picture and the verb never writes to it. The real picture line is replaced or removed;
//     with no real picture, setting adds a picture line where it goes on a slide with none, and removing changes
//     nothing. What is written recompiles to a quote slide with the picture that was set, or none.
//   - On a slide with no Trigger line among its content the verb returns, byte for byte, what it returned before the
//     round (scripts/lib/set-quote-picture-frozen.ts), over generated slides: pictures above and below, speaker
//     notes, comments, a video in image syntax, a source line, LF and CRLF; set, set with alt text, remove.
import { strict as assert } from 'node:assert'
import { setQuotePicture } from '../../src/shared/layout-verbs.ts'
import { setQuotePictureFrozen } from './set-quote-picture-frozen.ts'
import { compilerIn, NOTES } from './quote-notes-compile-check-cases.mjs'

const HEAD = '# Talk\n\n## Section\n\n'
const TRIGGER = '{reveal ![x](a.png)}'

export async function pictureVerbCases(dir) {
  const compileText = compilerIn(dir)
  const slide = (id, lines) => `### Q\n{id=${id} quote form=web}\n\n${lines.join('\n')}\n`
  // The reviewer's slide, and the Trigger line in each place it can stand; with a real picture and with none.
  const shapes = [
    ['real picture under the Trigger line', ['> Words.', TRIGGER, '', '![real](real.png)'], true],
    ['real picture above, Trigger line under the quotation', ['![real](real.png)', '', '> Words.', TRIGGER], true],
    ['Trigger line first, then the picture', [TRIGGER, '', '![real](real.png)', '', '> Words.'], true],
    ['no real picture, Trigger line under the quotation', ['> Words.', TRIGGER], false],
    ['no real picture, Trigger line above the quotation', ['', TRIGGER, '', '> Words.', '', '- Jane Example https://example.org'], false],
    ['no real picture, a quoted paragraph', ['"Words."', '', TRIGGER], false]
  ]
  const results = []
  for (const eol of ['\n', '\r\n']) {
    for (const [label, lines, hasPicture] of shapes) {
      const outline = `${HEAD}${slide('q', lines)}\n${slide('next', ['> Other words.'])}`.replace(/\n/g, eol)
      const triggerLine = `${TRIGGER}${eol === '\r\n' ? '\r' : ''}`
      const where = `${label}${eol === '\r\n' ? ' (CRLF)' : ''}`
      const set = setQuotePicture(outline, 'q', 'b.png', undefined, 'quote').outline
      const removed = setQuotePicture(outline, 'q', null, undefined, 'quote').outline
      for (const [verb, text] of [['set', set], ['remove', removed]]) {
        assert.equal(text.split('\n').filter((line) => line === triggerLine).length, 1, `${verb}, ${where}: the Trigger line is as typed`)
        assert.equal(text.slice(text.indexOf('### Q', text.indexOf('### Q') + 1)), outline.slice(outline.indexOf('### Q', outline.indexOf('### Q') + 1)), `${verb}, ${where}: the next slide is untouched`)
      }
      if (hasPicture) {
        assert.equal(set, outline.replace('![real](real.png)', '![real](b.png)'), `set, ${where}: the real picture line takes the path, its alt text kept`)
        assert(!removed.includes('real.png') && removed.includes('Words.'), `remove, ${where}: the real picture line goes`)
      } else {
        assert.equal(removed, outline, `remove, ${where}: a slide with no picture is unchanged`)
        // The picture line goes where it goes on the same slide with the Trigger line taken out.
        const without = outline.split('\n').filter((line) => line !== triggerLine).join('\n')
        assert.equal(set.split('\n').filter((line) => line !== triggerLine).join('\n'), setQuotePicture(without, 'q', 'b.png', undefined, 'quote').outline, `set, ${where}: the picture line is added as on the slide without the Trigger line`)
        assert.equal(set.split('\n').filter((line) => /^!\[\]\(b\.png\)\r?$/.test(line)).length, 1, `set, ${where}: one picture line`)
      }
      results.push({ where, hasPicture, set, removed })
    }
  }
  // What was written is what the compiler draws: the picture that was set (or none), the same words, the Trigger line folded.
  for (const result of results) {
    for (const [verb, text, expected] of [['set', result.set, 'b.png'], ['remove', result.removed, null]]) {
      const compiled = await compileText(text)
      const compiledSlide = compiled.slides.find((candidate) => candidate.id === 'q')
      // The files are not there, so the compiler names each picture it reads in a `missing-image` warning.
      const pictures = (compiled.warnings ?? []).filter((warning) => warning.startsWith('missing-image:q:')).map((warning) => warning.slice('missing-image:q:'.length))
      assert.deepEqual(pictures, expected ? [expected] : [], `${verb}, ${result.where}: the compiler reads ${expected ?? 'no picture'}`)
      assert.equal(compiledSlide.blocks.filter((block) => block.type === 'image').length, expected ? 1 : 0, `${verb}, ${result.where}: ${expected ? 'one picture' : 'no picture'} is drawn`)
      assert.deepEqual(compiledSlide.blocks.find((block) => block.type === 'quote')?.paragraphs, ['Words.'], `${verb}, ${result.where}: the same words`)
      assert.equal(compiledSlide.layout, 'quote', `${verb}, ${result.where}: still a quote slide`)
    }
  }

  // Byte for byte as before on slides with no Trigger line among the content.
  const ABOVE = [[], ['![The page](assets/page.png)'], ['![The page](assets/page.png "A caption") and words'], [NOTES], [NOTES, '', '![The page](assets/page.png)'], ['![The page](assets/page.png)', NOTES], ['<!-- a comment -->'], ['![Video](movie.mp4)'], ['![a](assets/a.png) ![b](assets/b.png)']]
  const WORDS = [['> Words of the quotation.'], ['> Words of the quotation.', '> — Jane Example'], ['"Words of the quotation."'], []]
  const BELOW = [[], ['- Jane Example https://example.org'], ['![Second](assets/second.png)'], [NOTES], ['![Second](assets/second.png)', NOTES, 'https://example.org'], ['https://example.org', '', ':::notes', '![in the notes](assets/n.png)', ':::']]
  const OPERATIONS = [['b.png', undefined], ['assets/new.png', 'New [alt] text'], [' spaced.png ', ''], [null, undefined]]
  const counts = { slides: 0, calls: 0, changed: 0, threw: 0, withNotes: 0 }
  const run = (verb, ...args) => {
    try { return { outline: verb(...args).outline } } catch (error) { return { error: `${error.constructor.name}: ${error.message}` } }
  }
  for (const eol of ['\n', '\r\n']) for (const trigger of ['{id=q quote}', '{id=q quote form=web}', '{id=q}', null]) for (const above of ABOVE) for (const words of WORDS) for (const below of BELOW) for (const gap of ['', '\n']) for (const tail of [true, false]) {
    const body = [...above.flatMap((line) => [line, ...(gap ? [''] : [])]), ...words, '', ...below.flatMap((line) => [line, ...(gap ? [''] : [])])].join('\n').trimEnd()
    const outline = `${HEAD}### Q${trigger ? '' : ' {id=q}'}\n${trigger ? `${trigger}\n` : ''}\n${body}\n${tail ? '\n### Next\n{id=next quote}\n\n> Other words.\n' : ''}`.replace(/\n/g, eol)
    counts.slides += 1
    if (outline.includes(':::notes')) counts.withNotes += 1
    for (const [path, alt] of OPERATIONS) for (const ref of ['q', { headingLine: 5 }]) {
      const now = run(setQuotePicture, outline, ref, path, alt, 'quote')
      const then = run(setQuotePictureFrozen, outline, ref, path, alt, 'quote')
      assert.deepEqual(now, then, `set-quote-picture(${JSON.stringify(path)}, ${JSON.stringify(alt)}) differs from before the round on ${JSON.stringify(outline)}`)
      counts.calls += 1
      if (now.error) counts.threw += 1
      else if (now.outline !== outline) counts.changed += 1
    }
  }
  assert(counts.slides >= 3000 && counts.changed >= 10000 && counts.withNotes >= 1000 && counts.threw === 0, `the statement is not empty: ${JSON.stringify(counts)}`)
  // The frozen copy is the old verb: on the reviewer's slide it rewrites the Trigger line, which the verb no longer does.
  const reviewers = `${HEAD}${slide('q', ['> Words.', TRIGGER, '', '![real](real.png)'])}`
  assert(setQuotePictureFrozen(reviewers, 'q', 'b.png', undefined, 'quote').outline.includes('{reveal ![x](b.png)}'), 'the copy kept for comparison is the verb as it was')
  return `set-quote-picture: a Trigger line holding image syntax is never written to (${results.length} slides, set and remove, recompiled); on ${counts.slides} slides with no Trigger line among the content (${counts.withNotes} with speaker notes) ${counts.calls} calls return what they returned before the round, ${counts.changed} of them a changed outline`
}
