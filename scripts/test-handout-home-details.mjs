// The handout home page's words about the talk (locked design 2026-10-07, "Handout 4b"): the parts of the
// navy band, the planned start that keeps the page on its "before the talk" layout, the "Before the
// session" steps and the links mentioned.
import assert from 'node:assert/strict'
import { handoutDayLabel, handoutHomeDetails, handoutHomePostwork, handoutHomePrework, handoutLookAhead, LOOK_AHEAD_OFF_WORDS } from '../src/shared/handout-home.ts'
import { collectTalkLinks, handoutHomeMarkup } from '../compiler/scripts/lib/handout-home.mjs'
import { DECK_FLAG_OFF } from '../compiler/scripts/lib/deck-settings.mjs'
import { buildShareHtml } from '../compiler/scripts/lib/09-output-builders.mjs'

const outline = '---\ntitle: "Agents"\nauthor: Dominik Lukeš\nseries: ITSS Briefing Sept 2026\n---\n\n# Agents\n'
assert.equal(handoutDayLabel('2026-10-06'), 'Tue 6 Oct 2026')
assert.equal(handoutDayLabel('2026-10-06', false), 'Tue 6 Oct')
assert.equal(handoutDayLabel('soon'), '')

// A talk published on its own: series and speaker as separate parts, no day, no start.
assert.deepEqual(handoutHomeDetails({ outline }), { day: '', date: '', startTime: '', event: 'ITSS Briefing Sept 2026', author: 'Dominik Lukeš', subtitle: '', affiliation: '', startsAt: null, lookAhead: true })
assert.deepEqual(handoutHomeDetails({ outline: '# No frontmatter\n' }), { day: '', date: '', startTime: '', event: '', author: '', subtitle: '', affiliation: '', startsAt: null, lookAhead: true })
// Subtitle and affiliation come from the frontmatter the talk already has.
const withMore = handoutHomeDetails({ outline: '---\ntitle: Agents\nsubtitle: "What changed"\naffiliation: University of Oxford\n---\n' })
assert.equal(withMore.subtitle, 'What changed')
assert.equal(withMore.affiliation, 'University of Oxford')

// A planned Run: day, start time, the Run's event (over the series) and the start in the Run's own zone.
const planned = handoutHomeDetails({ outline, run: { status: 'planned', plannedDate: '2026-10-06', startTime: '10:00', timeZone: 'Europe/London', eventTitle: 'ITSS Briefing, IT Services' } })
assert.deepEqual(planned, { day: 'Tue 6 Oct', date: 'Tue 6 Oct 2026', startTime: '10:00', event: 'ITSS Briefing, IT Services', author: 'Dominik Lukeš', subtitle: '', affiliation: '', startsAt: Date.UTC(2026, 9, 6, 9, 0), lookAhead: true }, '10:00 in London in October is 09:00 UTC')
// A delivered Run keeps its day and time for the band but has no start to wait for; nor has one without a time.
const delivered = handoutHomeDetails({ outline, run: { status: 'delivered', plannedDate: '2026-10-06', startTime: '10:00' } })
assert.deepEqual([delivered.date, delivered.startTime, delivered.startsAt], ['Tue 6 Oct 2026', '10:00', null])
const untimed = handoutHomeDetails({ outline, run: { status: 'planned', plannedDate: '2026-10-06', startTime: 'soon' } })
assert.deepEqual([untimed.day, untimed.startTime, untimed.startsAt], ['Tue 6 Oct', '', null])

// live_look_ahead: on unless the talk turns it off, read with the compiler's own flag words.
assert.deepEqual(LOOK_AHEAD_OFF_WORDS, DECK_FLAG_OFF, 'the home page reads off the way the compiler does')
assert.equal(handoutHomeDetails({ outline: '---\ntitle: A\nlive_look_ahead: false\n---\n' }).lookAhead, false)
assert.equal(handoutLookAhead('---\nlive-look-ahead: "no"\n---\n'), false, 'the alias and a quoted word')
assert.equal(handoutLookAhead('---\nlive_look_ahead: Off\n---\n'), false)
assert.equal(handoutLookAhead('---\nlive_look_ahead: true\n---\n'), true)
assert.equal(handoutLookAhead('---\nlive_look_ahead: perhaps\n---\n'), true, 'an unreadable value keeps the default (the compiler warns)')
assert.equal(handoutLookAhead('# body\nlive_look_ahead: false\n'), true, 'only the frontmatter counts')

// Pre-work: the one-row summary, the minutes added up, and each step with its own minutes.
assert.equal(handoutHomePrework(null), null)
assert.equal(handoutHomePrework({ title: 'Empty', steps: [] }), null)
assert.deepEqual(handoutHomePrework({ title: '', steps: [{ title: 'Try one agent', kind: 'task', minutes: 2 }, { title: ' ', kind: 'slide' }, { title: 'Read this', kind: 'task', minutes: 3 }] }), {
  label: '3 steps to do before the session', detail: '5 min', minutes: 5,
  steps: [{ label: 'Try one agent', minutes: 2, kind: 'task' }, { label: 'Step 2', minutes: null, kind: 'slide' }, { label: 'Read this', minutes: 3, kind: 'task' }],
})
assert.deepEqual(handoutHomePrework({ title: 'Three questions to answer before Monday', steps: [{}] }), { label: 'Three questions to answer before Monday', detail: '1 step', minutes: 0, steps: [{ label: 'Step 1', minutes: null, kind: '' }] })

// Links: http(s) only, once each, never the page's own address; labelled with authored link text.
const slides = [
  { html: '<section class="slide" data-id="a" data-nav-title="Title"><a href="https://handouts.fyi/737u">x</a></section>' },
  { html: '<section class="slide" data-id="b" data-nav-title="Join &lt;b&gt;us&lt;/b&gt;"><a href="https://news.test/?a=1&amp;b=2">x</a><a href="javascript:alert(1)">y</a><a href="mailto:a@b.test">z</a></section>' },
  { html: '<section class="slide" data-id="c" data-nav-title="Again"><a href="https://news.test/?a=1&amp;b=2">x</a></section>' },
]
const links = collectTalkLinks(slides, { exclude: ['https://handouts.fyi/737u/'] })
assert.deepEqual(links.map((link) => link.href), ['https://news.test/?a=1&b=2'])
assert.equal(links[0].labelHtml, 'x', 'the authored anchor labels the resource')
const home = { slidesHref: 'agents.html', downloadHref: 'agents-download.html', url: 'https://handouts.fyi/737u', qr: '', links,
  day: '<i>d</i>', date: '<i>dd</i>', startTime: '<i>t</i>', event: '<i>e</i>', author: '<i>a</i>', subtitle: '<i>s</i>', affiliation: '<i>f</i>' }
const markup = handoutHomeMarkup({ ...home, prework: { label: '<b>x</b>', detail: '2 min', minutes: 2, steps: [{ label: '<b>step</b>', minutes: 2, kind: 'task' }] } }, { title: '<script>t</script> **Agents**', slideCount: 3, firstSlideId: 'a"b' })
assert.ok(markup.includes('href="https://news.test/?a=1&amp;b=2"') && markup.includes('rel="noopener noreferrer"'))
assert.ok(!/<script|<i>|<b>(x|step)/.test(markup), 'title, band parts and pre-work labels are escaped')
for (const part of ['d', 'dd', 't', 'e', 'a', 's', 'f']) assert.ok(markup.includes(`&lt;i&gt;${part}&lt;/i&gt;`), `the band draws "${part}" as text`)
assert.ok(markup.includes('&lt;b&gt;step&lt;/b&gt;') && markup.includes('About 2 min'), 'the steps are listed, with the total')
assert.ok(!markup.includes('&lt;b&gt;x&lt;/b&gt;'), 'with steps listed, the one-row summary is not drawn as well')
assert.ok(markup.includes('<strong>Agents</strong>'), 'the title keeps its inline formatting')
assert.ok(markup.includes('href="agents.html#a&quot;b"'), 'Start from slide 1 names the first slide, escaped')
assert.ok(markup.includes('href="agents-download.html" download="agents.html"'), 'Download saves the self-contained file under the handout\'s name')
assert.ok(markup.includes('Start the pre-work') && markup.includes('Get ready'))
assert.ok(markup.includes('Open slides</a>') && !markup.includes('hh-label">Open slides') && !markup.includes('Read the slides'), 'the button reads "Open slides" with no label repeating it (Dominik 2026-10-08)')
assert.ok(!/<p class="hh-label">Open slides/.test(handoutHomeMarkup({ slidesHref: 'agents.html', url: '', qr: '' }, { title: 'Agents', slideCount: 3 })), 'the band with no pre-work has no label above Open slides')
assert.ok(markup.includes('id="hhStepBack"') && markup.includes('id="hhStepForward"') && markup.includes('id="hhToSpeaker"') && markup.includes('id="hhFull"'), 'the live slide has its step and full-screen controls')
// A pre-work summary with no steps listed (the earlier shape) keeps its one row.
const oneRow = handoutHomeMarkup({ ...home, prework: { label: 'Three questions', detail: '1 step' } }, { title: 'Agents', slideCount: 1 })
assert.match(oneRow, /<span class="hh-row-text">Three questions<\/span><span class="hh-row-detail">1 step<\/span>/)
assert.ok(oneRow.includes('1 slide<') && !oneRow.includes('1 slides'), 'one slide is singular')
// No pre-work, no day, no event, no speaker: no button for it and no empty lines in the band.
const bare = handoutHomeMarkup({ slidesHref: 'agents.html', url: '', qr: '' }, { title: 'Agents', slideCount: 3 })
assert.ok(!/Start the pre-work|hhPrework|hh-chip" data-hh-for="before"|hh-event|hh-sub|hh-speaker|hhShare|hhLinks/.test(bare), 'nothing is drawn for what the talk does not have')
// Nothing without behaviour behind it, in any layout.
assert.doesNotMatch(markup, /Feedback|Add to calendar|About the talk|Email me|Recording|Search|Download PDF|Talk ended|role="tab/)

// The slides view links back to the home page when it is published beside one; nothing else does.
const shareSlides = [{ id: 'a', html: '<section class="slide" data-id="a" data-nav-title="A"><h1>A</h1></section>', notes: '' }]
const shareArgs = { title: 'Agents', slides: shareSlides, styles: '', includeNotes: false, slug: 'agents', license: null }
const withHome = buildShareHtml({ ...shareArgs, homeHref: './' })
assert.ok(withHome.includes('<a class="btn share-home" id="shareHome" href="./">') && withHome.includes('<a class="phone-home" id="phoneHome" href="./">'), 'the slides view: Handout home in the footer and above the phone list')
assert.ok(!buildShareHtml(shareArgs).includes('id="shareHome"'), 'the download file and other exports have no home link')
assert.ok(!buildShareHtml({ ...shareArgs, homeHref: '"><script>' }).includes('"><script>'), 'the link target is escaped')
assert.ok(!buildShareHtml({ ...shareArgs, homeHref: './', home: { slidesHref: 'agents.html' } }).includes('id="shareHome"'), 'the home page itself has no link to itself')
// Work-files ticket 16: the pre-work rows and "Start the pre-work" go to the Run's pre-work page; post-work has its own card.
{
  assert.equal(handoutHomePrework({ title: 'Intake', steps: [{ title: 'Watch', kind: 'video' }] }, 'pre-work/').href, 'pre-work/')
  assert.deepEqual(handoutHomePostwork({ title: 'After the session' }, 'post-work/'), { href: 'post-work/', label: 'After the session' })
  assert.equal(handoutHomePostwork({ title: 'x' }, ''), null)
  assert.equal(handoutHomePostwork(null, 'post-work/'), null)
  const both = handoutHomeMarkup({ ...home, prework: { label: 'Intake', detail: '1 step', href: 'pre-work/', steps: [{ label: 'Watch', minutes: null, kind: 'video' }] }, postwork: { label: 'After the session', href: 'post-work/' } }, { title: 'Agents', slideCount: 1 })
  assert.match(both, /id="hhPrework"[^]*?<a class="hh-row" href="pre-work\/">/)
  assert.match(both, /id="hhStartPrework" href="pre-work\/"/)
  assert.match(both, /id="hhPostwork" data-hh-for="handout"[^]*?<h2>After the session<\/h2>[^]*?href="post-work\/"/)
  for (const bad of ['javascript:alert(1)', '"><script>', '//evil.test/', '../../x/y', 'file:///etc']) {
    const html = handoutHomeMarkup({ ...home, postwork: { label: 'P', href: bad } }, { title: 'Agents', slideCount: 1 })
    assert.equal(html.includes('id="hhPostwork"'), false, `a post-work link ${bad} is not drawn`)
  }
  assert.ok(!handoutHomeMarkup({ ...home }, { title: 'Agents', slideCount: 1 }).includes('hhPostwork'), 'no post-work, no card')
}

// Work-files ticket 24: a Run's extras card. Without extras the markup is exactly what it was (the talk's
// home page never has them); with them, every value is escaped and only http(s) links are drawn.
{
  const plain = handoutHomeMarkup({ ...home }, { title: 'Agents', slideCount: 1 })
  for (const none of [null, undefined, {}, 'note', { intro: '  ', links: [] }, { links: [{ url: 'javascript:alert(1)' }] }]) {
    assert.equal(handoutHomeMarkup({ ...home, extras: none }, { title: 'Agents', slideCount: 1 }), plain, `no card, the same markup: ${JSON.stringify(none)}`)
  }
  const html = handoutHomeMarkup({ ...home, extras: { intro: 'A & B <b>\nnext', links: [
    { url: 'https://example.org/?q=1&r=2', label: '<i>Read</i>' }, { url: 'https://www.example.net/x' },
    { url: 'javascript:alert(1)', label: 'js' }, { url: 'data:text/html,x', label: 'data' }, { url: 'https://x.test/"onmouseover=alert(1)', label: 'quote' }, { url: '//evil.test/', label: 'rel' },
  ] } }, { title: 'Agents', slideCount: 1 })
  const card = /<section class="hh-card hh-list" id="hhExtras" data-hh-for="before handout"><h2>For this session<\/h2>[^]*?<\/section>/.exec(html)?.[0]
  assert.ok(card)
  assert.ok(card.includes('<p class="hh-note">A &amp; B &lt;b&gt;<br>next</p>'))
  assert.ok(card.includes('href="https://example.org/?q=1&amp;r=2"') && card.includes('&lt;i&gt;Read&lt;/i&gt;'))
  assert.ok(card.includes('<span class="hh-row-text">example.net</span>'), 'no name: the host')
  assert.equal((card.match(/class="hh-row"/g) || []).length, 2, 'only the two http(s) links are drawn')
  assert.equal(/javascript:|data:|onmouseover|evil\.test/.test(card), false)
  const introOnly = handoutHomeMarkup({ ...home, extras: { intro: 'Hi' } }, { title: 'Agents', slideCount: 1 })
  assert.match(introOnly, /<section class="hh-card" id="hhExtras" data-hh-for="before handout"><h2>For this session<\/h2><p class="hh-note">Hi<\/p><\/section>/)
}

await import('./test-handout-resource-links.mjs')

console.log('PASS handout home details: band parts, planned start, look-ahead setting, pre-work steps, links mentioned, escaping, nothing drawn without data, slides view link home, Run extras card')
