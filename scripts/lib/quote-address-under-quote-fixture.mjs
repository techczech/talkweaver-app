// Quote forms, ticket 10 (an address on its own line under a quote): the proof that existing talks are unchanged.
//
// FORMLESS_SLIDES are quote slides with a bare web address and NO form (no `form=` token, or `form=auto`), in every
// shape the new rule looks at. `formlessHashes` compiles them and returns a sha256 per slide of its layout, its blocks,
// its rendered section and its phone text, plus one of the deck's warnings. `scripts/fixtures/quote-forms/address-under-quote-formless-hashes.json`
// holds the hashes recorded from the compiler as it was BEFORE the ticket (commit 0364c091, the ticket's base);
// scripts/test-quote-forms-address-under-quote.mjs compares the live compiler to them.
//
// Record (once, from the base commit's compiler, in a scratch folder that holds an untouched copy of compiler/ and src/):
//   node scripts/lib/quote-address-under-quote-fixture.mjs --record <root holding compiler/> > address-under-quote-formless-hashes.json
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { talkNamesTitleLook, withoutLaterSlideStamps } from './slide-markup-identity.mjs'

const WEB = 'https://example.org/schemas-and-propositions'
const DOI = 'https://doi.org/10.1000/xyz123'
const VIDEO = 'https://www.youtube.com/watch?v=XXXXXXXXXXX'
const POST = 'https://x.com/sample/status/1234567890123456789'
const WORDS = '> Words of the quotation.'

/** [id, slide text]. None has a set form, so each must compile exactly as it did before the ticket. */
export const FORMLESS_SLIDES = [
  ['f-issue', `### Quote\n{id=f-issue}\n\n${WORDS}\n\n${WEB}`],
  ['f-marked', `### Quote\n{id=f-marked quote}\n\n${WORDS}\n\n${WEB}`],
  ['f-auto', `### Quote\n{id=f-auto quote form=auto}\n\n${WORDS}\n\n${WEB}`],
  ['f-auto-only', `### Quote\n{id=f-auto-only form=auto}\n\n${WORDS}\n\n${WEB}`],
  ['f-doi', `### Quote\n{id=f-doi}\n\n${WORDS}\n\n${DOI}`],
  ['f-doi-marked', `### Quote\n{id=f-doi-marked quote}\n\n${WORDS}\n\n${DOI}`],
  ['f-video', `### Quote\n{id=f-video}\n\n${WORDS}\n\n${VIDEO}`],
  ['f-post', `### Quote\n{id=f-post quote}\n\n${WORDS}\n\n${POST}`],
  ['f-tight', `### Quote\n{id=f-tight}\n\n${WORDS}\n${WEB}`],
  ['f-far', `### Quote\n{id=f-far}\n\n${WORDS}\n\n\n\n${WEB}`],
  ['f-promoted', `### Quote\n{id=f-promoted}\n\n"Words of the quotation."\n\n${WEB}`],
  ['f-source-line', `### Quote\n{id=f-source-line}\n\n${WORDS}\n\n- Author Name, 2024\n\n${WEB}`],
  ['f-two-addresses', `### Quote\n{id=f-two-addresses}\n\n${WORDS}\n\n${WEB}\n\n${DOI}`],
  ['f-above', `### Quote\n{id=f-above}\n\n${WEB}\n\n${WORDS}`],
  ['f-two-quotes', `### Quote\n{id=f-two-quotes}\n\n${WORDS}\n\n> A second quotation.\n\n${WEB}`],
  ['f-other', `### Quote\n{id=f-other}\n\n${WORDS}\n\n${WEB}\n\n- one\n- two`],
  ['f-embed', `### Quote\n{id=f-embed}\n\n${WORDS}\n\n[Embed: ${WEB}]`],
  ['f-only-link', `### Quote\n{id=f-only-link quote}\n\n${WEB}`],
  ['f-title', `### Jane Example\n{id=f-title quote}\n\n${WORDS}\n\n${WEB}`]
]

export const formlessOutline = () => `# Talk\n\n## Section\n\n${FORMLESS_SLIDES.map(([, text]) => text).join('\n\n')}\n`

const sha = (text) => createHash('sha256').update(text).digest('hex')

/** sha256 per form-less slide (layout, blocks, section markup, phone text) and of the deck's warnings, from the compiler under `compilerRoot`. */
export async function formlessHashes(compilerRoot) {
  const { normalizeEmbedUrl } = await import(pathToFileURL(join(compilerRoot, 'compiler/scripts/lib/02-triggers-layout.mjs')).href)
  const { prepareSource } = await import(pathToFileURL(join(compilerRoot, 'compiler/scripts/lib/08-source-adapters.mjs')).href)
  const { buildDeckHtmlFromModel } = await import(pathToFileURL(join(compilerRoot, 'compiler/scripts/lib/07-assembly.mjs')).href)
  const { buildSlideScriptPayload } = await import(pathToFileURL(join(compilerRoot, 'compiler/scripts/lib/slide-script.mjs')).href)
  const dir = mkdtempSync(join(tmpdir(), 'tw-quote-address-formless-'))
  try {
    const path = join(dir, 'talk.md')
    const text = formlessOutline()
    writeFileSync(path, text)
    const model = await prepareSource(path, text, 'Talk', statSync(path), undefined, { allowedAssetRoots: [dir] })
    const html = await buildDeckHtmlFromModel(model)
    const script = buildSlideScriptPayload(model.slides)
    const out = {}
    for (const [id] of FORMLESS_SLIDES) {
      const slide = model.slides.find((candidate) => candidate.id === id)
      // Stamps a later ticket added to every slide are left out (slide-markup-identity.mjs).
      let section = withoutLaterSlideStamps(html.match(new RegExp(`<section class="slide[^"]*" data-id="${id}"[\\s\\S]*?</section>`))?.[0] ?? '', { talkNamesTitleLook: talkNamesTitleLook(text) })
      if (!slide || !section) throw new Error(`form-less slide ${id} did not compile`)
      // Handout resources now retain the authored URL alongside the normalised player URL.
      // The original compiler comparison predates that metadata. Verify it against the fixture
      // and the player URL before excluding only that addition; keep the original golden hashes.
      const resourceAttrs = new Set()
      const blocks = slide.blocks.map((block) => {
        if (block.type !== 'embed' || !Object.hasOwn(block, 'resourceUrl')) return block
        assert.equal(typeof block.resourceUrl, 'string')
        assert.ok(FORMLESS_SLIDES.find(([key]) => key === id)[1].includes(block.resourceUrl), `${id}: resource URL is authored`)
        assert.equal(normalizeEmbedUrl(block.resourceUrl), block.src, `${id}: resource URL identifies the actual player`)
        resourceAttrs.add(block.resourceUrl.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'))
        const { resourceUrl, ...legacy } = block
        return legacy
      })
      section = section.replace(/ data-resource-url="([^"]*)"/g, (attr, value) => {
        assert.ok(resourceAttrs.has(value), `${id}: rendered resource URL matches the model`)
        return ''
      })
      out[id] = sha(JSON.stringify({ layout: slide.layout, blocks, section, script: script[id] ?? null }))
    }
    out['(warnings)'] = sha(JSON.stringify(model.warnings ?? []))
    return out
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ── Existing slides ─────────────────────────────────────────────────────────────────────────────────────────────────
//
// EXISTING_TALKS are quote slides as talks held them before the ticket: WITH a form and a source line (every form,
// both kinds of quotation, a picture, no source at all, a form from the talk's `triggers:`), and WITHOUT a form; plus
// slides that are not quotes. None has an address on its own line under a set form. The test (section C4) checks on
// the current tree that the mark `quoteFormSet` does not enter any of their picture keys.

const WITH_FORM = [
  ['web-source-line', `{id=web-source-line quote form=web}\n\n${WORDS}\n\n- Jane Example, "A page" ${WEB}`],
  ['web-no-quote-word', `{id=web-no-quote-word form=web}\n\n${WORDS}\n\n- Jane Example ${WEB}`],
  ['web-source-in-quotation', `{id=web-source-in-quotation quote form=web}\n\n${WORDS}\n> — Jane Example ${WEB}`],
  ['web-link-only', `{id=web-link-only quote form=web}\n\n${WORDS}\n\n- ${WEB}`],
  ['web-no-source', `{id=web-no-source quote form=web}\n\n${WORDS}`],
  ['web-quoted-paragraph', `{id=web-quoted-paragraph form=web}\n\n"Words of the quotation."\n\n- Jane Example ${WEB}`],
  ['web-quoted-paragraph-tail', `{id=web-quoted-paragraph-tail form=web}\n\n"Words of the quotation." — Jane Example ${WEB}`],
  ['web-with-picture', `{id=web-with-picture quote form=web}\n\n![The page](assets/page.png)\n\n${WORDS}\n\n- Jane Example ${WEB}`],
  ['web-title-shown', `{id=web-title-shown quote form=web title=show}\n\n${WORDS}\n\n- Jane Example ${WEB}`],
  ['paper-source-line', `{id=paper-source-line quote form=paper}\n\n${WORDS}\n\n- A One and B Two, "A paper", *Journal of Samples*, 2020 ${DOI}`],
  ['plain-source-line', `{id=plain-source-line quote form=plain}\n\n${WORDS}\n\n- Jane Example ${WEB}`],
  ['plain-no-quote-word', `{id=plain-no-quote-word form=plain}\n\n${WORDS}\n\n- Jane Example`],
  ['tweet-source-line', `{id=tweet-source-line quote form=tweet}\n\n${WORDS}\n\n- Sample Name (@samplehandle), 4 Oct 2026, 2:33 PM ${POST}`],
  ['video-source-line', `{id=video-source-line quote form=video}\n\n${WORDS}\n\n- Sample Speaker, "A talk", 12:40 ${VIDEO}`],
  ['book-source-line', `{id=book-source-line quote form=book}\n\n${WORDS}\n\n- A One, *A Book*, Sample Press, 1980, p. 5`],
  ['web-other-content', `{id=web-other-content quote form=web}\n\n${WORDS}\n\n- Jane Example ${WEB}\n\nA sentence beside it.`],
  ['web-two-quotations', `{id=web-two-quotations quote form=web}\n\n${WORDS}\n\n- Jane Example ${WEB}\n\n> A second quotation.`]
]
const WITHOUT_FORM = [
  ['formless-source-line', `{id=formless-source-line quote}\n\n${WORDS}\n\n- Jane Example ${WEB}`],
  ['formless-no-quote-word', `{id=formless-no-quote-word}\n\n${WORDS}\n\n- Jane Example`],
  ['formless-doi', `{id=formless-doi quote}\n\n${WORDS}\n\n- A One, "A paper", *Journal of Samples*, 2020 ${DOI}`],
  ['formless-post', `{id=formless-post quote}\n\n${WORDS}\n\n- Sample Name (@samplehandle), 4 Oct 2026 ${POST}`],
  ['formless-quoted-paragraph', `{id=formless-quoted-paragraph quote}\n\n"Words of the quotation."\n\n- Jane Example ${WEB}`],
  ['formless-address', `{id=formless-address}\n\n${WORDS}\n\n${WEB}`],
  ['automatic-source-line', `{id=automatic-source-line quote form=auto}\n\n${WORDS}\n\n- Jane Example ${WEB}`],
  ['a-list', `{id=a-list}\n\n- one\n- two\n- three`],
  ['a-statement', `{id=a-statement statement}\n\nOne sentence that stands alone.`]
]
const slidesText = (slides) => slides.map(([, body]) => `### Quote\n${body}`).join('\n\n')

/** [name, outline]. The second talk gives every slide `form=web` from its frontmatter. */
export const EXISTING_TALKS = [
  ['forms-on-slides', `# Talk\n\n## Section\n\n${slidesText([...WITH_FORM, ...WITHOUT_FORM])}\n`],
  ['form-from-talk-settings', `---\noutline_version: 2\ntriggers: "{form=web}"\n---\n# Talk\n\n## Section\n\n${slidesText([
    ['inherited-source-line', `{id=inherited-source-line quote}\n\n${WORDS}\n\n- Jane Example ${WEB}`],
    ['inherited-no-quote-word', `{id=inherited-no-quote-word}\n\n${WORDS}\n\n- Jane Example ${WEB}`],
    ['inherited-automatic', `{id=inherited-automatic quote form=auto}\n\n${WORDS}\n\n- Jane Example ${WEB}`],
    ['inherited-a-list', `{id=inherited-a-list}\n\n- one\n- two`]
  ])}\n`]
]

if (import.meta.url === pathToFileURL(process.argv[1]).href && process.argv[2] === '--record') {
  console.log(JSON.stringify(await formlessHashes(resolve(process.argv[3])), null, 1))
}
