// test:embeds — what the compiler emits for an embed (0.38 ticket 11; design test matrix rows 1
// and 22, and the thumbnail-identity finding of section 9.2).
//
//   1. A local page: an EMPTY frame with sandbox="allow-scripts allow-forms" (never
//      allow-same-origin), no src and no srcdoc, its document in data-embed-doc with the lead
//      (policy, referrer, base, agent), and a labelled placeholder. Same in the share page HTML.
//   2. The placeholder's title: the page's own <title>, cut to 80 characters, else the file name.
//   3. A missing page: the "Missing embed" line, no frame, a warning.
//   4. A remote site: unchanged (ticket 11.4 gives it its sandbox).
//   5. The channel source is inlined only into a deck, or a share page, that has a local page.
//   6. A preview document (markSlidePreviewHtml) contains no embedded document.
//   7. The picture identity of an embed slide changes with its markup, and with the document shell.
//   8. The placeholder is not a step: an embed slide's step plan is that of the same slide with the
//      placeholder taken out (the parity tests cover the plans themselves).
//   9. Reading a large page (where the lead goes, its own base, its title) takes time in proportion
//      to its length: thousands of comments, scripts or tags, or megabytes of text, in milliseconds.
import { mkdtempSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const compilerDir = join(here, '..', 'compiler', 'scripts')
const lib = (name) => pathToFileURL(join(compilerDir, 'lib', name)).href
const { prepareSource, EMBED_PAGE_POLICY } = await import(lib('08-source-adapters.mjs'))
const { buildShareHtml } = await import(lib('09-output-builders.mjs'))
const { extractSlides, extractStyles } = await import(lib('04-html-extraction.mjs'))
const { EMBED_SANDBOX_LOCAL, EMBED_ALLOW_LOCAL, embedPageTitle, embedPosterMarkup, embedLocalFigureMarkup, embedHasOwnBase, embedLeadPosition } = await import(lib('embed-frame.mjs'))
const { buildPerSlideProjections } = await import(lib('10-projections.mjs'))
const { embedAgentSource } = await import(pathToFileURL(join(here, '..', 'compiler/assets/runtime/embed-agent.js')).href)
const { markSlidePreviewHtml } = await import(pathToFileURL(join(here, '..', 'src/shared/slide-preview.ts')).href)

let failures = 0
const check = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); failures++ } }
const unescapeAttr = (text) => text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
const slidesOf = (html) => extractSlides(html).map((slide) => slide.html).join('\n')
const tokens = (frame) => (frame.match(/\ssandbox="([^"]*)"/)?.[1] ?? '').split(/\s+/).filter(Boolean)

const dir = mkdtempSync(join(tmpdir(), 'tw-embed-'))
mkdirSync(join(dir, 'assets'), { recursive: true })
const simHtml = '<!doctype html><html><head><title>A &amp; B sim</title></head><body><h1>SIM-MARKER</h1><script>console.log("x")</script></body></html>'
writeFileSync(join(dir, 'assets', 'sim.html'), simHtml, 'utf8')
writeFileSync(join(dir, 'assets', 'untitled.html'), '<p>UNTITLED-MARKER</p>', 'utf8')
const compile = async (name, content) => {
  const path = join(dir, `${name}-outline.md`)
  writeFileSync(path, content, 'utf8')
  return prepareSource(path, content, name, statSync(path))
}

// ── 1. A local page ───────────────────────────────────────────────────────────────────────────
const okModel = await compile('ok', '# Embed Test\n\n### Sim slide\n\n[Simulation: assets/sim.html]\n\n### Second\n\n[Embed: assets/untitled.html]\n')
const okHtml = okModel.fullHtml
const okSlides = slidesOf(okHtml)
const shareHtml = buildShareHtml({ title: 'Embed Test', slug: 'embed-test', includeNotes: false, license: null, slides: extractSlides(okHtml), styles: extractStyles(okHtml) })
const shareSlides = shareHtml.slice(shareHtml.indexOf('<section'), shareHtml.lastIndexOf('</section>'))
for (const [where, markup] of [['deck', okSlides], ['share page', shareSlides]]) {
  const frames = markup.match(/<iframe\b[^>]*>/g) || []
  const local = frames.filter((frame) => /\sdata-embed-doc="/.test(frame))
  check(local.length === 2, `${where}: two frames carry data-embed-doc (found ${local.length})`)
  check(frames.length === local.length, `${where}: every frame of these slides is a local-page frame`)
  for (const frame of local) {
    check(JSON.stringify(tokens(frame)) === JSON.stringify(['allow-scripts', 'allow-forms']), `${where}: sandbox tokens are exactly allow-scripts allow-forms (${tokens(frame).join(' ')})`)
    check(!tokens(frame).includes('allow-same-origin'), `${where}: no allow-same-origin`)
    check(!/\ssrc=/.test(frame) && !/\ssrcdoc=/.test(frame) && !/\sdata-src=/.test(frame), `${where}: the frame has no src, srcdoc or data-src`)
    check(/\scredentialless[\s>]/.test(frame) && /\sreferrerpolicy="no-referrer"/.test(frame), `${where}: credentialless and no-referrer`)
    check(frame.includes(` allow="${EMBED_ALLOW_LOCAL}"`), `${where}: the local permission list`)
    check(!/\sloading=/.test(frame), `${where}: no loading attribute; the runtime decides when the frame loads`)
  }
  check(!/<iframe\s+srcdoc=/.test(markup), `${where}: no frame that loads by itself`)
  check((markup.match(/<figure class="slide-embed[^"]*" data-embed="local" data-embed-state="idle"/g) || []).length === 2, `${where}: the figure is marked local and idle`)
  check((markup.match(/class="embed-interact-chip"/g) || []).length === 2, `${where}: the Interact chip is still in the figure`)
  check(!/data-src="assets\/sim\.html"/.test(markup) && !markup.includes('"assets/sim.html"'), `${where}: no reference to the external file`)
}
check(EMBED_SANDBOX_LOCAL.includes('allow-same-origin') === false && EMBED_SANDBOX_LOCAL.join(' ') === 'allow-scripts allow-forms', 'the compiler\'s local constant has no allow-same-origin')
const doc = unescapeAttr(okSlides.match(/\sdata-embed-doc="([^"]*)"/)[1])
const lead = `<meta http-equiv="Content-Security-Policy" content="${EMBED_PAGE_POLICY}"><meta name="referrer" content="no-referrer"><base href="about:srcdoc"><script>${embedAgentSource()}</script>`
check(doc === `<!doctype html>${lead}${simHtml.slice('<!doctype html>'.length)}`, 'the inlined document is the page with the lead directly after its doctype')
check(doc.includes('SIM-MARKER'), 'the document holds the page')

// ── 2. The placeholder ────────────────────────────────────────────────────────────────────────
const posters = okSlides.match(/<span class="embed-poster"[\s\S]*?<\/span><\/span>/g) || []
check(posters.length === 2, 'each local page has a placeholder')
check(posters[0]?.includes('<span class="embed-poster-kind">Interactive page</span>'), 'the placeholder names the kind')
check(posters[0]?.includes('<span class="embed-poster-title">A &amp; B sim</span>'), 'the title is the page\'s own <title>, as text')
check(posters[0]?.includes('<span class="embed-poster-note">Runs when this slide is presented</span>'), 'the placeholder says when the page runs')
check(posters[1]?.includes('<span class="embed-poster-title">assets/untitled.html</span>'), 'no <title>: the file name as it may be shown')
check(posters.every((poster) => !/<(?!\/?(?:span|svg|path|circle|rect|line|polyline|polygon|g|ellipse)\b)/.test(poster)), 'the placeholder is spans and an icon only')
check(/<iframe [^>]*title="Interactive page: A &amp; B sim"/.test(okSlides), 'the frame is named for assistive technology')
check(embedPageTitle('<title>  One\n two </title>') === 'One two', 'white space in a title is collapsed')
check(embedPageTitle(`<TITLE lang="en">${'x'.repeat(200)}</TITLE>`) === 'x'.repeat(80), 'a title is cut to 80 characters')
check(embedPageTitle('<title><b>Bold</b> &lt;script&gt;</title>') === 'Bold <script>', 'a title is read as text')
check(embedPageTitle('<p>no title</p>') === '' && embedPageTitle(null) === '', 'no title: empty')
check(embedPosterMarkup({ kind: 'K', title: '<img src=x onerror=alert(1)>', note: '"n"' }).includes('&lt;img src=x onerror=alert(1)&gt;'), 'the placeholder escapes its title')
check(!embedPosterMarkup({ kind: 'K', title: '<img src=x>', note: 'n' }).includes('<img'), 'no markup from a title reaches the placeholder')
const crafted = embedLocalFigureMarkup({ doc: '"><script>alert(1)</script>', title: '" onload="alert(1)' })
check(!crafted.includes('<script>alert(1)') && !/title="[^"]*" onload=/.test(crafted), 'the document and the title are escaped into their attributes')
writeFileSync(join(dir, 'assets', 'hostile-title.html'), '<title>&lt;/span&gt;&lt;script&gt;alert(1)&lt;/script&gt; "x"</title><p>T</p>', 'utf8')
const hostileTitle = slidesOf((await compile('title', '# T\n\n### One\n\n[Embed: assets/hostile-title.html]\n')).fullHtml)
check(hostileTitle.includes('<span class="embed-poster-title">&lt;/span&gt;&lt;script&gt;alert(1)&lt;/script&gt; &quot;x&quot;</span>'), 'a page title cannot write markup into the slide')

// ── 3. A missing page ─────────────────────────────────────────────────────────────────────────
const missModel = await compile('miss', '# Embed Test\n\n### Missing slide\n\n[Simulation: assets/nope.html]\n')
const missSlides = slidesOf(missModel.fullHtml)
check(/slide-embed-missing/.test(missSlides), 'missing embed should render the placeholder class')
check(!/data-embed-doc|<iframe\b|embed-poster/.test(missSlides), 'a missing embed has no frame, no document and no page placeholder')
check((missModel.warnings || []).some((w) => w.startsWith('missing-asset:')), 'missing embed should warn missing-asset')

// ── 4. A remote site: as before this ticket ───────────────────────────────────────────────────
const remoteModel = await compile('remote', '# Embed Test\n\n### Remote slide\n\n[Embed: https://example.com/page]\n')
const remoteHtml = remoteModel.fullHtml
const remoteSlides = slidesOf(remoteHtml)
check(/class="embed-open-link"/.test(remoteSlides), 'remote embed should render the Open-link caption')
check(/data-embed-url="https:\/\/example\.com\/page"/.test(remoteSlides), 'remote embed should still carry the live iframe data-embed-url')
check(remoteSlides.includes('example.com'), 'caption should name the host')
check(!/data-embed-doc|data-embed="local"|embed-poster/.test(remoteSlides), 'a remote embed has no local-page markup')

// ── 5. The channel source ─────────────────────────────────────────────────────────────────────
check(okHtml.includes('function embedCreateChannel('), 'a deck with a local page carries the channel')
check(!remoteHtml.includes('function embedCreateChannel(') && !missModel.fullHtml.includes('function embedCreateChannel('), 'a deck without one does not')
check(!remoteHtml.includes('EMBED_CHANNEL_RUNTIME') && !okHtml.includes('EMBED_CHANNEL_RUNTIME'), 'the placeholder never reaches a compiled deck')
check(shareHtml.includes('function embedCreateChannel('), 'a share page with a local page carries the channel')
const remoteShare = buildShareHtml({ title: 'R', slug: 'r', includeNotes: false, license: null, slides: extractSlides(remoteHtml), styles: extractStyles(remoteHtml) })
check(!remoteShare.includes('function embedCreateChannel('), 'a share page without one does not')
for (const [where, html] of [['deck', okHtml], ['share page', shareHtml]]) {
  check(!/blobifySrcdocSims|simBlobSrc|createObjectURL\(new Blob\(\[html/.test(html), `${where}: the blob swap is gone`)
  check(!/attachEmbedCapture|resolveEmbedPath|contentDocument[^\n]*sim/i.test(html), `${where}: nothing reaches into an embedded document`)
}

// ── 6. A preview document ─────────────────────────────────────────────────────────────────────
const preview = markSlidePreviewHtml(okHtml)
check(!preview.includes('data-embed-doc'.concat('="')), 'a preview document has no data-embed-doc attribute')
check(!preview.includes('SIM-MARKER') && !preview.includes('UNTITLED-MARKER'), 'nothing of the page is in a preview document')
check((slidesOf(preview).match(/class="embed-poster"/g) || []).length === 2, 'the placeholders are')
check(/<iframe sandbox="allow-scripts allow-forms"/.test(slidesOf(preview)), 'the empty frame keeps its sandbox')
check(markSlidePreviewHtml(preview) === preview, 'marking twice changes nothing')

// ── 7. Picture identity ───────────────────────────────────────────────────────────────────────
// The thumbnail cache key is thumbnail_hash (the document shell plus the slide's markup) and
// render_hash (the slide model). Both change for an embed slide with this ticket, and the shell
// (the template) changed for every slide, so no picture taken before it is reused.
const rows = buildPerSlideProjections(okModel, 'embed-test')
const row = rows.find((entry) => entry.slide_id === 'sim-slide')
check(Boolean(row?.thumbnail_hash) && Boolean(row?.render_hash), 'an embed slide has both picture hashes')
writeFileSync(join(dir, 'assets', 'sim.html'), simHtml.replace('SIM-MARKER', 'SIM-CHANGED'), 'utf8')
const changed = await compile('ok', '# Embed Test\n\n### Sim slide\n\n[Simulation: assets/sim.html]\n\n### Second\n\n[Embed: assets/untitled.html]\n')
const changedRows = buildPerSlideProjections(changed, 'embed-test')
const changedRow = changedRows.find((entry) => entry.slide_id === 'sim-slide')
check(changedRow && changedRow.thumbnail_hash !== row.thumbnail_hash && changedRow.render_hash !== row.render_hash, 'a change inside the embedded page changes the slide\'s picture identity')
const other = changedRows.find((entry) => entry.slide_id === 'second')
const otherBefore = rows.find((entry) => entry.slide_id === 'second')
check(other && otherBefore && other.render_hash === otherBefore.render_hash, 'and leaves the other slide\'s model identity alone')

// ── 8. Step plans ─────────────────────────────────────────────────────────────────────────────
const stepped = await compile('steps', '# Embed Test\n\n### Steps\n{emphasis-steps}\n\n- A **bold** point\n- Another ==marked== one\n\n[Simulation: assets/sim.html]\n')
const steppedSlide = slidesOf(stepped.fullHtml)
const withoutPoster = steppedSlide.replace(/<span class="embed-poster"[\s\S]*?<\/span><\/span>/g, '')
check(withoutPoster !== steppedSlide, 'the stepped slide has a placeholder')
const count = (markup) => (markup.match(/data-emph-step="/g) || []).length
check(count(steppedSlide) === 2 && count(steppedSlide) === count(withoutPoster), `the placeholder adds no emphasis step (${count(steppedSlide)} steps)`)
check(!/<span class="embed-poster"[\s\S]*?data-emph-step[\s\S]*?<\/span><\/span>/.test(steppedSlide), 'no step is marked inside the placeholder')

// ── 9. A large page is read in time proportional to its length ────────────────────────────────
// Each document is read by the three functions the compiler calls on every embedded page. Measured
// on the build machine (2026-10-07): 2 to 25 ms per document. Before the fix the first document took
// about 15 s (each comment searched to the end of the document for a terminator the page never
// uses) and the last about 6 s (each "<" in an unclosed title searched to the end for a ">").
{
  const DOC = '<!doctype html>'
  const TAIL = '<title>Perf &amp; size</title><base href="https://example.org/">'
  const fill = 'x'.repeat(200)
  const BOUND_MS = 500
  const large = [
    // 10,000 comments before the doctype (the lead position reads them) and 10,000 after it.
    ['20,000 comments in 2 MB', `${'<!-- -->\n'.repeat(10000)}${DOC}<html><body>${`<!-- --><p>${fill}</p>\n`.repeat(10000)}${TAIL}</body></html>`, { base: true, at: 90000 + DOC.length, title: 'Perf & size' }],
    ['20,000 script elements', `${DOC}<html><body>${`<script>var s = "<base href=x><title>no</title>";</script>\n`.repeat(20000)}${TAIL}</body></html>`, { base: true, at: DOC.length, title: 'Perf & size' }],
    ['60,000 tags', `${DOC}<html><body>${`<div class="c" data-n='1'><span>t</span><i>x</i></div>\n`.repeat(20000)}${TAIL}</body></html>`, { base: true, at: DOC.length, title: 'Perf & size' }],
    ['5 MB of plain text', 'plain text, no markup at all. '.repeat(Math.ceil(5 * 1024 * 1024 / 30)), { base: false, at: 0, title: '' }],
    ['an unclosed title with 20,000 "<"', `${DOC}<title>${'a < b and so on, for a long while yet; '.repeat(20000)}`, { base: false, at: DOC.length, title: 'a < b and so on, for a long while yet; '.repeat(3).slice(0, 80) }]
  ]
  check(large[0][1].length > 2 * 1024 * 1024 && large[3][1].length >= 5 * 1024 * 1024, 'the large documents have the sizes they are named for')
  for (const [name, page, expected] of large) {
    const started = performance.now()
    const seen = { base: embedHasOwnBase(page), at: embedLeadPosition(page), title: embedPageTitle(page) }
    const took = performance.now() - started
    check(JSON.stringify(seen) === JSON.stringify(expected), `${name}: read correctly (${JSON.stringify(seen)})`)
    check(took < BOUND_MS, `${name}: read in ${took.toFixed(0)} ms, over the ${BOUND_MS} ms bound`)
  }
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1) }
console.log('PASS: a local page compiles to an empty sandboxed frame with its document and a placeholder; missing and remote embeds are as before')
