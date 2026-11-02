import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectTalkLinks, handoutHomeMarkup } from '../compiler/scripts/lib/handout-home.mjs';
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs';
import { extractSlides } from '../compiler/scripts/lib/04-html-extraction.mjs';
import { renderBlock } from '../compiler/scripts/lib/06-block-renderers.mjs';
import { buildHandoutHomePageHtml } from '../compiler/scripts/lib/handout-home-page.mjs';

const row = (html, extra = {}) => ({ html, ...extra });
const labels = (links) => links.map(l => l.labelHtml);

test('resource labels use anchor text, never the containing slide heading', () => {
  assert.deepEqual(labels(collectTalkLinks([row('<section data-nav-title="Slide heading"><h1>Slide heading</h1><a href="https://example.org/p">Read <em>the paper</em> &amp; methods</a></section>')])), ['Read the paper &amp; methods']);
});

test('resources preserve order and exact URLs; later authored labels upgrade only generic labels', () => {
  const links = collectTalkLinks([row('<iframe data-src="https://example.org/p?b=%2f&amp;a=+#part"></iframe><a class="embed-open-link" href="https://example.org/p?b=%2f&amp;a=+#part">Open example.org ↗</a><a href="https://example.org/p?b=%2f&amp;a=+#other">Other</a><a href="https://example.org/p?b=%2f&amp;a=+#part">The paper</a><a href="https://example.org/p?b=%2f&amp;a=+#part">Later title</a><a href="https://example.org/p/">Slash</a><a href="https://example.org/p">No slash</a>')]);
  assert.deepEqual(links.map(l => l.href), ['https://example.org/p?b=%2f&a=+#part', 'https://example.org/p?b=%2f&a=+#other', 'https://example.org/p/', 'https://example.org/p']);
  assert.deepEqual(labels(links), ['The paper', 'Other', 'Slash', 'No slash']);
});

test('fallbacks describe URLs deterministically; metadata titles and video sources are included', () => {
  const links = collectTalkLinks([row('<iframe data-src="https://www.example.org/path/page?q=x" title="https://www.example.org/path/page?q=x"></iframe><iframe data-embed-url="https://other.test/" title="Existing page title"></iframe><video src="https://media.test/clip.mp4?x=1#t=2"></video><a href="https://bare.test/">https://bare.test/</a>')]);
  assert.deepEqual(labels(links), ['example.org/path/page', 'Existing page title', 'Video: media.test/clip.mp4', 'bare.test']);
});

test('section runs use divider titles, keep intro and repeated runs, and stay flat without sections', () => {
  const slides = [row('<a href="https://a.test/">Intro</a>'), row('<section data-nav-title="First &amp; section"></section>', { role: 'section-title', section: 's1' }), row('<a href="https://b.test/">B</a>', { section: 's1' }), row('<a href="https://c.test/">C</a>', { section: 's2', sectionTitle: 'Second' }), row('<a href="https://d.test/">D</a>', { section: 's1' })];
  const links = collectTalkLinks(slides);
  assert.deepEqual(links.map(l => l.sectionTitle || ''), ['', 'First & section', 'Second', 'First & section']);
  const html = handoutHomeMarkup({ links }, { title: 'Talk' });
  assert.equal((html.match(/<h3>First &amp; section<\/h3>/g) || []).length, 2);
  assert.ok(html.indexOf('>Intro</span>') < html.indexOf('<h3>First'));
  assert.doesNotMatch(handoutHomeMarkup({ links: collectTalkLinks([slides[0]]) }, { title: 'Talk' }), /<h3>/);
});

test('local resources point only to a published slide, never private files or srcdoc contents', () => {
  const local = renderBlock({ type: 'embed', src: '/private/secret/page.html', srcdoc: '<a href="https://private.test/">Private</a>', pageTitle: 'Page <title>' }, new Set());
  const missing = renderBlock({ type: 'embed', src: '/private/secret/missing.html', missing: true }, new Set());
  const links = collectTalkLinks([row(local + missing, { id: 'local & one' })], { slidesFile: 'talk #?.html' });
  assert.deepEqual(links.map(l => l.href), ['talk%20%23%3F.html#local%20%26%20one']);
  assert.deepEqual(labels(links), ['Page &lt;title&gt;']);
  assert.doesNotMatch(JSON.stringify(links), /private|srcdoc|file:|data:/);
  assert.equal(collectTalkLinks([row(local, { id: 'local' })]).length, 0, 'no sibling output, no invented link');
});

test('attribute decoding is single-pass and resource text stays escaped', () => {
  const links = collectTalkLinks([row(`<a href='https://example.org/?a=1&#38;b=2#&amp;quot;'>&lt;img onerror=x&gt; &amp; &#x41;</a><a href="file:///secret">File</a><iframe data-src="data:text/html,secret"></iframe>`)]);
  assert.equal(links[0].href, 'https://example.org/?a=1&b=2#&quot;');
  assert.equal(links[0].labelHtml, '&lt;img onerror=x&gt; &amp; A');
  assert.equal(links.length, 1);
});

test('compiler preserves authored YouTube and Vimeo references offline, including all embed forms', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-handout-resource-links-'));
  const previous = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = () => { fetchCalls++; throw new Error('resource compilation must be offline'); };
  try {
    const urls = ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=01%3a02&x=+#t=9', 'https://vimeo.com/76979871?foo=%2f&x=+#t=30', 'https://youtu.be/dQw4w9WgXcQ?si=A%2fb#fragment'];
    writeFileSync(join(dir, 'local.html'), '<title>Contained page</title><a href="https://private.test/">Do not extract</a>');
    const outline = `---\ntitle: Resources\nauto_title_slide: false\nauto_thanks_slide: false\n---\n\n### Video one {id=one}\n\n[Video: ${urls[0]}]\n\n### Video two {id=two}\n\n[Embed: ${urls[1]}]\n\n### Video three {id=three}\n\n${urls[2]}\n\n## Section name {id=section}\n\n### Page {id=local}\n\n[Embed: local.html]\n\n### Missing {id=missing}\n\n[Embed: missing.html]\n\n### Refused {id=refused}\n\n[Embed: /private/secret/not-published.html]\n`;
    const path = join(dir, 'outline.md');
    writeFileSync(path, outline);
    const model = await prepareSource(path, outline, null, statSync(path), {}, {});
    const slides = extractSlides(model.fullHtml);
    const links = collectTalkLinks(slides, { slidesFile: 'talk #.html' });
    assert.deepEqual(links.map(l => l.href), [...urls, 'talk%20%23.html#local']);
    assert.match(slides.find(s => s.id === 'one').html, /data-src="https:\/\/www.youtube-nocookie.com\/embed\//, 'playback still uses the normalised player');
    assert.equal(links.at(-1).labelHtml, 'Contained page');
    assert.equal(links.at(-1).sectionTitle, 'Section name');
    const home = buildHandoutHomePageHtml({ title: 'Resources', slides, styles: '', slug: 'talk #', license: null });
    assert.match(home, /href="talk%20%23.html#local"/);
    assert.equal(fetchCalls, 0, 'compilation and handout resource extraction never fetch metadata');
  } finally {
    globalThis.fetch = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('saved capture embeds retain the resource and never promote generated Open labels', () => {
  const html = renderBlock({ type: 'embed', src: 'https://capture.test/page?x=1#view', title: 'Authored resource', savedViews: [{ src: 'data:image/jpeg;base64,YQ==', capturedAt: '2026-10-27' }] }, new Set());
  assert.deepEqual(labels(collectTalkLinks([row(html)])), ['Authored resource']);
});

test('normalised player URLs are generic labels; authored anchors outrank page metadata', () => {
  const links = collectTalkLinks([row('<iframe data-resource-url="https://vimeo.com/123?x=%2f#t=2" data-src="https://player.vimeo.com/video/123" title="https://player.vimeo.com/video/123"></iframe><iframe data-src="https://paper.test/" title="Page metadata"></iframe><a href="https://paper.test/">Authored paper name</a>')]);
  assert.deepEqual(labels(links), ['Vimeo video 123', 'Authored paper name']);
});

test('untitled local embeds use a safe basename and anchors can carry accessible authored labels', () => {
  const local = renderBlock({ type: 'embed', src: 'assets/example.html', srcdoc: '<p>No title</p>' }, new Set());
  const links = collectTalkLinks([row(local + '<a href="https://label.test/" aria-label="Read the resource"><img src="data:image/png,x" alt="Picture"></a>', { id: 'local' })], { slidesFile: 'talk.html' });
  assert.deepEqual(labels(links), ['example.html', 'Read the resource']);
});

test('a section with content supplies its actual section title without requiring a divider role', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-handout-resource-links-'));
  try {
    const source = '---\ntitle: Resources\nauto_title_slide: false\nauto_thanks_slide: false\n---\n\n## Real section title {id=section-root role=content}\n\n[Read](https://root.test/)\n\n### Unrelated slide heading {id=child}\n\n[Paper](https://child.test/)\n';
    const path = join(dir, 'outline.md');
    writeFileSync(path, source);
    const slides = extractSlides((await prepareSource(path, source, null, statSync(path), {}, {})).fullHtml);
    assert.deepEqual(collectTalkLinks(slides).map(l => l.sectionTitle), ['Real section title', 'Real section title']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('untitled watch videos have distinct structural video labels', () => {
  const links = collectTalkLinks([row('<iframe data-embed-video="1" data-src="https://youtube.com/watch?v=dQw4w9WgXcQ"></iframe><iframe data-embed-video="1" data-src="https://youtube.com/watch?v=abcdefghijk"></iframe>')]);
  assert.deepEqual(labels(links), ['YouTube video dQw4w9WgXcQ', 'YouTube video abcdefghijk']);
});

test('every local HTML resource on a slide is listed even when their navigation target matches', () => {
  const html = ['Alpha', 'Beta'].map(pageTitle => renderBlock({ type: 'embed', src: 'page.html', srcdoc: '<p>Page</p>', pageTitle }, new Set())).join('');
  const links = collectTalkLinks([row(html, { id: 'both' })], { slidesFile: 'talk.html' });
  assert.deepEqual(labels(links), ['Alpha', 'Beta']);
  assert.deepEqual(links.map(l => l.href), ['talk.html#both', 'talk.html#both']);
});

test('a section group ends before later unsectioned resources', () => {
  const links = collectTalkLinks([row('<a href="https://one.test/">One</a>', { section: 's', sectionTitle: 'Actual section' }), row('<a href="https://two.test/">Two</a>')]);
  const html = handoutHomeMarkup({ links }, { title: 'Talk' });
  assert.match(html, /<section class="hh-resource-group">[^]*?<h3>Actual section<\/h3>[^]*?>One<\/span>[^]*?<\/section><a class="hh-row"[^]*?>Two<\/span>/);
});

test('a generated citation host label uses the more specific URL fallback', () => {
  assert.deepEqual(labels(collectTalkLinks([row('<cite><a href="https://example.com/paper/123">example.com</a></cite>')])), ['example.com/paper/123']);
});
