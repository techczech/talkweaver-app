// The handout home page's words about the talk (design 2026-10-02 B): the line under the title, the
// planned start that drives "Not live yet", the "Before the session" row and the links from the talk.
import assert from 'node:assert/strict'
import { handoutDayLabel, handoutHomeDetails, handoutHomePrework } from '../src/shared/handout-home.ts'
import { collectTalkLinks, handoutHomeMarkup } from '../compiler/scripts/lib/handout-home.mjs'

const outline = '---\ntitle: "Agents"\nauthor: Dominik Lukeš\nseries: ITSS Briefing Sept 2026\n---\n\n# Agents\n'
assert.equal(handoutDayLabel('2026-10-06'), 'Tue 6 Oct 2026')
assert.equal(handoutDayLabel('2026-10-06', false), 'Tue 6 Oct')
assert.equal(handoutDayLabel('soon'), '')

// A talk published on its own: series and speaker, no start time, no "not live yet" line.
assert.deepEqual(handoutHomeDetails({ outline }), { meta: 'ITSS Briefing Sept 2026 · Dominik Lukeš', startsAt: null, notLive: null })
assert.equal(handoutHomeDetails({ outline: '# No frontmatter\n' }).meta, '')

// A planned Run: date · event · speaker, and the start in the Run's own zone.
const planned = handoutHomeDetails({ outline, run: { status: 'planned', plannedDate: '2026-10-06', startTime: '10:00', timeZone: 'Europe/London', eventTitle: 'ITSS Briefing, IT Services' } })
assert.equal(planned.meta, 'Tue 6 Oct 2026 · ITSS Briefing, IT Services · Dominik Lukeš')
assert.equal(planned.startsAt, Date.UTC(2026, 9, 6, 9, 0), '10:00 in London in October is 09:00 UTC')
assert.equal(planned.notLive.today, 'Not live yet. The talk starts at 10:00. Polls, questions and reactions appear on this page when it does.')
assert.match(planned.notLive.later, /^Not live yet\. The talk starts on Tue 6 Oct at 10:00\./)
// A delivered Run, or one without a start time, says nothing about starting.
assert.equal(handoutHomeDetails({ outline, run: { status: 'delivered', plannedDate: '2026-10-06', startTime: '10:00' } }).notLive, null)
assert.equal(handoutHomeDetails({ outline, run: { status: 'planned', plannedDate: '2026-10-06' } }).startsAt, null)

assert.equal(handoutHomePrework(null), null)
assert.deepEqual(handoutHomePrework({ title: '', steps: [{ minutes: 2 }, {}, { minutes: 3 }] }), { label: '3 steps to do before the session', detail: '5 min' })
assert.deepEqual(handoutHomePrework({ title: 'Three questions to answer before Monday', steps: [{}] }), { label: 'Three questions to answer before Monday', detail: '1 step' })

// Links: http(s) only, once each, never the page's own address; labelled with the slide's title.
const slides = [
  { html: '<section class="slide" data-id="a" data-nav-title="Title"><a href="https://handouts.fyi/737u">x</a></section>' },
  { html: '<section class="slide" data-id="b" data-nav-title="Join &lt;b&gt;us&lt;/b&gt;"><a href="https://news.test/?a=1&amp;b=2">x</a><a href="javascript:alert(1)">y</a><a href="mailto:a@b.test">z</a></section>' },
  { html: '<section class="slide" data-id="c" data-nav-title="Again"><a href="https://news.test/?a=1&amp;b=2">x</a></section>' },
]
const links = collectTalkLinks(slides, { exclude: ['https://handouts.fyi/737u/'] })
assert.deepEqual(links.map((link) => link.href), ['https://news.test/?a=1&b=2'])
assert.ok(!/<b>/.test(links[0].labelHtml), 'a slide title with markup stays text')
const markup = handoutHomeMarkup({ slidesHref: 'agents.html', url: 'https://handouts.fyi/737u', qr: '', links, meta: '<i>m</i>', prework: { label: '<b>x</b>', detail: '2 min' } }, { title: '<script>t</script> **Agents**', slideCount: 3 })
assert.ok(markup.includes('href="https://news.test/?a=1&amp;b=2"') && markup.includes('rel="noopener noreferrer"'))
assert.ok(!/<script|<i>m|<b>x/.test(markup), 'title, meta and pre-work label are escaped')
assert.ok(markup.includes('<strong>Agents</strong>'), 'the title keeps its inline formatting')
console.log('PASS handout home details: meta line, planned start, pre-work row, links from the talk, escaping')
