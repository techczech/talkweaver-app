// test:guide-topics — onboarding 0.38.1 ticket 11, How it works and Features to delight you.
//   - the four Features section headings are the drawing's (DELIGHT); How it works and Features wording is the
//     owner's of 10 Oct (plain sentences, no slogan contrasts), checked for shape and for forbidden patterns;
//   - topic 3's claim is checked against the real compiler on a fixture outline (lock decision 6): every
//     heading (##, ###, ####) becomes one slide, a word in braces under it picks its layout, `{statement}`
//     makes a statement slide, and a heading with no word does not;
//   - every topic has one working Try it: an example talk that exists in the bundle and says what its
//     caption says, or a registered command that needs no talk open; every picture is drawn;
//   - read marks: opening a topic or a feature row is kept by the progress module, survives a restart (a new
//     store over the same config), and does not change the chapters' record or the example vault's;
//   - render: the list (state 08), a topic open (state 09), the Features sections (states 10 and 18).
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { writeFileSync, statSync } from 'node:fs'
import { build } from 'esbuild'
import {
  HOW_TOPICS, FEATURE_SECTIONS, FEATURE_ROWS, TOPIC_STATUS, TOPIC_TRY_LABEL, CONNECTIONS_SECTION_TITLE,
  howReadCount, isFeatureId, isHowTopicId, isRead, topicBody, topicStatusText
} from '../src/shared/guide-topics.ts'
import { emptyGuideLearn, guideLearnFrom, withChapterOpened, withCommandRan, withTopicRead } from '../src/shared/guide-learn.ts'
import { GuideLearnStore } from '../src/main/guide-learn-store.ts'
import { COMMAND_REGISTRY } from '../src/shared/command-registry.ts'
import { talkTitle } from '../src/shared/practice-coverage.ts'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { buildPerSlideProjections } from '../compiler/scripts/lib/10-projections.mjs'
import { DELIGHT, TEXT } from '../docs/design/2026-10-09-onboarding-and-command-help/mockup-onboarding-talkweaver-text.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE = join(REPO, 'resources', 'example-vault')
let passed = 0
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`PASS  ${name}`) } catch (error) { console.error(`FAIL  ${name}`); throw error }
}
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()

const FORBIDDEN = [
  [/\bhere\b[^.]*\bis\b/i, '"X is Y; here Z is W"'],
  [/;\s*(here|in TalkWeaver)\b/i, 'a semicolon antithesis'],
  [/\bnot (a|an|the)\b[^.]*\bbut\b/i, '"not A but B"'],
  [/\bno canvas\b|\bimprove a slide once\b|\bnothing to draw\b/i, 'a slogan fragment'],
  [/—/, 'a dash used as a flourish']
]
const prose = (t) => (t.sentences ?? [t.title ?? '']).join(' ')

await test('How it works: ten topics, one to three plain sentences each, in the owner’s words for the outline topic', () => {
  assert.equal(HOW_TOPICS.length, 10)
  HOW_TOPICS.forEach((topic, i) => {
    assert.equal(topic.id, `how.${i + 1}`)
    assert.ok(topic.title.trim())
    assert.ok(topic.sentences.length >= 1 && topic.sentences.length <= 3, `topic ${i + 1} has one to three sentences`)
    assert.ok(topic.sentences.join(' ').match(/[.!?]/g).length <= 4, `topic ${i + 1} stays short`)
    for (const [pattern, name] of FORBIDDEN) assert.ok(!pattern.test(`${topic.title} ${topic.sentences.join(' ')}`), `topic ${i + 1} uses ${name}`)
  })
  assert.equal(HOW_TOPICS[0].sentences[0], 'In PowerPoint each presentation is a single file. In TalkWeaver the core is a text outline, and all its assets are in an easy-to-review folder.')
  // The differences from PowerPoint or Keynote the owner asked for are stated, where they apply.
  const body = (id) => topicBody(HOW_TOPICS.find((t) => t.id === id))
  for (const id of ['how.1', 'how.3', 'how.4', 'how.5', 'how.6', 'how.7', 'how.8', 'how.10']) assert.ok(/PowerPoint/.test(body(id)), `${id} says what PowerPoint does`)
  assert.equal(TEXT.status.none, TOPIC_STATUS.none)
  assert.equal(TEXT.status.read, TOPIC_STATUS.read)
  assert.equal(TEXT.tryIt, TOPIC_TRY_LABEL)
  // Menu routes named in the sentences exist in the Share menu.
  const layout = readFileSync(join(REPO, 'src/renderer/src/components/WorkspaceLayout.tsx'), 'utf8')
  for (const label of ["'HTML presentation (reveal in Finder)'", "'Share for comments…'", "'Handout (reveal in Finder)'", "'Publish to Cloudflare'"]) assert.ok(layout.includes(`label: ${label}`) || layout.includes(label), label)
  for (const route of ['Share › HTML presentation', 'Share › Share for comments', 'Share › Handout', 'Share › Publish to Cloudflare']) assert.ok(HOW_TOPICS.some((t) => t.sentences.join(' ').includes(route)), route)
})

await test('Features to delight you: four section headings the drawing’s; every row is something to do, with a key or menu route', () => {
  assert.equal(FEATURE_SECTIONS.length, 4)
  DELIGHT.forEach(([title], i) => assert.equal(FEATURE_SECTIONS[i].title, title))
  assert.equal(FEATURE_SECTIONS[3].title, CONNECTIONS_SECTION_TITLE)
  assert.equal(FEATURE_SECTIONS[3].groups.length, 0, 'section four holds What it connects to, not rows')
  assert.deepEqual(FEATURE_SECTIONS[1].groups.map((g) => g.sub), ['Without any connection', 'Live, if you choose to connect'])
  FEATURE_ROWS.forEach((row, i) => {
    assert.equal(row.n, i + 1)
    assert.equal(row.id, `feature.${i + 1}`)
    assert.match(row.title, /^(Make|Ask|Search|Reveal|Start|Scroll|Paste|Open|Read|Copy|Show|Record|Publish|Send)\b/, `${row.id} starts with a verb: ${row.title}`)
    assert.ok(/[⌘⇧⌥]|›|\bmenu\b|^[A-Z](, [A-Z])*$|Copy venue-screen link/.test(row.hint), `${row.id} names a key or a menu route: ${row.hint}`)
    for (const [pattern, name] of FORBIDDEN) assert.ok(!pattern.test(row.title), `${row.id} uses ${name}`)
    assert.ok(!HOW_TOPICS.some((t) => t.title.toLowerCase() === row.title.toLowerCase().replace(/\.$/, '')), `${row.id} repeats a How it works topic`)
  })
  assert.equal(FEATURE_ROWS.length, 16)
  assert.deepEqual(FEATURE_SECTIONS.slice(0, 3).map((s) => s.groups.reduce((a, g) => a + g.rows.length, 0)), [3, 9, 4])
  // Rows that only described how TalkWeaver works moved to How it works (owner check 10 Oct).
  for (const gone of ['A talk is a folder.', 'A handout comes with every talk.', 'Every delivery is on record.']) assert.ok(!FEATURE_ROWS.some((r) => r.title === gone), gone)
})

await test('topic 3 is true in the compiler: headings become slides; a word in braces under one picks its layout', async () => {
  const outline = [
    '---', 'title: Fixture talk', 'outline_version: 2', '---', '',
    '# Fixture talk', '',
    '## 01 First section', '',
    '### Four stalls', '{statement}', '', 'Bread, veg, plants, books', '',
    '### Plain slide', '', '- one', '- two', '',
    '### Quoted', '{quote}', '', '> Words', '',
    '## 02 Second section', '',
    '### Parent slide', '', 'Text', '',
    '#### Child slide', '{statement}', '', 'End', ''
  ].join('\n')
  const dir = mkdtempSync(join(tmpdir(), 'tw-topics-'))
  try {
    const path = join(dir, 'fixture-outline.md')
    writeFileSync(path, outline)
    const model = await prepareSource(path, outline, 'fixture', statSync(path))
    const slides = buildPerSlideProjections(model, 'fixture')
    // The sentence: each heading in the outline becomes a slide, in order, carrying the heading's words.
    const headings = outline.split('\n').map((line, i) => ({ line, at: i + 1 })).filter(({ line }) => /^#{2,4} /.test(line)).map(({ line, at }) => ({ title: line.replace(/^#+ /, ''), at }))
    const made = slides.filter((s) => s.role !== 'opening' && s.role !== 'ending')
    assert.deepEqual(made.map((s) => s.title), headings.map((h) => h.title), 'one slide per ##, ### and #### heading, in order')
    assert.deepEqual(made.map((s) => s.source_line), headings.map((h) => h.at), 'each slide starts at its heading')
    // The # line is the talk's title: it becomes the opening slide, not another slide.
    assert.equal(slides[0].role, 'opening')
    assert.equal(slides[0].title, 'Fixture talk')
    // The sentence: a word in braces under the heading picks its layout.
    const layout = (title) => slides.find((s) => s.title === title).layout
    assert.equal(layout('Four stalls'), 'statement', '{statement} makes a statement slide')
    assert.equal(layout('Child slide'), 'statement', 'also under a deeper heading')
    assert.equal(layout('Quoted'), 'quote', 'another word picks another layout')
    assert.notEqual(layout('Plain slide'), 'statement', 'a heading with no word does not')
    assert.equal(layout('Plain slide'), 'list')
    // The same outline with the word added to the plain slide picks the layout, so the word is what picks it.
    const withWord = outline.replace('### Plain slide\n', '### Plain slide\n{statement}\n')
    writeFileSync(path, withWord)
    const again = buildPerSlideProjections(await prepareSource(path, withWord, 'fixture', statSync(path)), 'fixture')
    assert.equal(again.find((s) => s.title === 'Plain slide').layout, 'statement', 'the same slide, with the word, is a statement slide')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

const talks = readdirSync(BUNDLE, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('_')).map((e) => {
  const file = join(BUNDLE, e.name, `${e.name}-outline.md`)
  const body = readFileSync(file, 'utf8')
  return { slug: e.name, text: body, title: talkTitle(body) }
})
const byTitle = new Map(talks.map((t) => [t.title, t]))

await test('every topic has one working Try it: an example talk that exists, or a registered command that needs no talk', async () => {
  const commandHandlers = { 'search-talks': 'search-talks', history: 'history', settings: 'settings' }
  for (const topic of HOW_TOPICS) {
    const { target, lead, does } = topic.tryIt
    assert.ok(lead.trim() && does.trim(), `${topic.id} says what Try it does`)
    if (target.kind === 'talk') assert.ok(byTitle.has(target.talk), `${topic.id}: ${target.talk} is in the example vault`)
    else {
      const command = COMMAND_REGISTRY.find((c) => c.id === target.id)
      assert.ok(command, `${topic.id}: command ${target.id} is registered`)
      assert.equal(command.handlerId, commandHandlers[target.id])
    }
  }
  // The App runs commands through three window events; each has a listener there and nowhere needs a talk open.
  const app = readFileSync(join(REPO, 'src/renderer/src/App.tsx'), 'utf8')
  for (const event of ['tw-open-settings', 'tw-open-history', 'tw-search-talks']) assert.ok(app.includes(`addEventListener('${event}'`), event)
  assert.deepEqual(new Set(HOW_TOPICS.filter((t) => t.tryIt.target.kind === 'command').map((t) => t.tryIt.target.id)), new Set(['search-talks', 'history', 'settings']))
})

await test('each Try it caption says what the example talk holds', async () => {
  const market = byTitle.get('The Saturday market').text
  assert.ok(/### Start here\n\{id=s1\}\n\{statement\}/.test(market), 'Start here is a statement slide')
  // Topic 3's Try it, compiled: the slide called Start here has the statement layout.
  const dir = mkdtempSync(join(tmpdir(), 'tw-topics-'))
  try {
    const path = join(dir, 'the-saturday-market-outline.md')
    writeFileSync(path, market)
    const slides = buildPerSlideProjections(await prepareSource(path, market, 'market', statSync(path)), 'market')
    assert.equal(slides.find((s) => s.title === 'Start here').layout, 'statement')
  } finally { rmSync(dir, { recursive: true, force: true }) }
  const ids = (t) => new Set([...t.text.matchAll(/\{id=(s\d+)\}/g)].map((m) => m[1]))
  const shared = [...ids(byTitle.get('Garden notes'))].filter((id) => ids(byTitle.get('The Saturday market')).has(id))
  assert.ok(shared.length >= 3, 'Garden notes shares three slides with The Saturday market')
  const manifest = JSON.parse(readFileSync(join(BUNDLE, '_PRESENTATIONS', 'walking-the-old-town', 'manifest.json'), 'utf8'))
  assert.ok(manifest.pathways.some((p) => p.name === 'Ten minutes'), 'a ten-minute pathway')
  const lightning = byTitle.get('Lightning round').text
  const noteBlocks = (lightning.match(/^:::notes$/gm) ?? []).length
  assert.ok(noteBlocks >= 5, `speaker notes (${noteBlocks} slides have them)`)
  assert.ok(readdirSync(join(BUNDLE, '_PRESENTATIONS', 'lightning-round')).some((f) => f.startsWith('delivery-')), 'one kept delivery for History to list')
})

await test('read marks: kept by the progress module, across a restart, apart from the chapters and the example vault', () => {
  let learn = emptyGuideLearn()
  assert.equal(howReadCount(learn), '0 of 10 read')
  assert.equal(topicStatusText(learn, 'how.3'), 'Not opened')
  learn = withTopicRead(learn, 'how.3')
  assert.equal(topicStatusText(learn, 'how.3'), 'Read')
  assert.equal(howReadCount(learn), '1 of 10 read')
  assert.equal(withTopicRead(learn, 'how.3'), learn, 'opening again changes nothing')
  assert.equal(withTopicRead(learn, ''), learn)
  assert.equal(withTopicRead(learn, 42), learn)
  assert.ok(isHowTopicId('how.9') && isHowTopicId('how.10') && !isHowTopicId('how.11') && isFeatureId('feature.16') && !isFeatureId('feature.17'))
  // The two lists keep their marks side by side, and a chapter or a command does not touch them.
  learn = withTopicRead(withChapterOpened(withCommandRan(learn, 'palette-1'), 'Present'), 'feature.2')
  assert.ok(isRead(learn, 'how.3') && isRead(learn, 'feature.2'))
  assert.equal(howReadCount(learn), '1 of 10 read', 'feature marks are not topics')
  // Main is the one writer: a store over a config, then a new store (a restart) over what was saved.
  let saved
  const heard = []
  const store = new GuideLearnStore({ read: () => saved, write: (record) => { saved = JSON.parse(JSON.stringify(record)) } })
  store.onChange = (record) => heard.push(record)
  assert.equal(store.topicRead('how.1'), true)
  assert.equal(store.topicRead('how.1'), false, 'no second save')
  assert.equal(store.topicRead('feature.5'), true)
  assert.equal(heard.length, 2, 'every window hears each change')
  const restarted = new GuideLearnStore({ read: () => saved, write: (record) => { saved = record } })
  assert.deepEqual(restarted.read().read, ['how.1', 'feature.5'])
  // The record is app config, not a vault: removing and restoring the example vault never reads or writes it.
  const example = readFileSync(join(REPO, 'src/main/example-vault.ts'), 'utf8')
  assert.ok(!example.includes('guideLearn') && !example.includes('GUIDE_LEARN_KEY'), 'the example vault code never touches the read marks')
  assert.deepEqual(guideLearnFrom({ version: 1, ran: [], opened: [], finished: {}, read: ['how.2', 7, 'feature.1'] }).read, ['how.2', 'feature.1'])
})

const renderDir = mkdtempSync(join(REPO, '.test-guide-topics-'))
try {
  const bundle = join(renderDir, 'bundle.mjs')
  await build({
    stdin: {
      contents: [
        "import React from 'react'",
        "import { renderToStaticMarkup } from 'react-dom/server'",
        "import GuideHowItWorks from './src/renderer/src/components/GuideHowItWorks.tsx'",
        "import GuideFeatures from './src/renderer/src/components/GuideFeatures.tsx'",
        "import TopicPicture from './src/renderer/src/components/GuideTopicPictures.tsx'",
        "export const how = (props) => renderToStaticMarkup(React.createElement(GuideHowItWorks, props))",
        "export const features = (props) => renderToStaticMarkup(React.createElement(GuideFeatures, props))",
        "export const picture = (key) => renderToStaticMarkup(React.createElement(TopicPicture, { picture: key }))"
      ].join('\n'),
      resolveDir: REPO,
      sourcefile: 'test-guide-topics-entry.tsx'
    },
    bundle: true, format: 'esm', platform: 'node', jsx: 'automatic', loader: { '.css': 'empty' },
    external: ['react', 'react/*', 'react-dom', 'react-dom/*', 'lucide-react'],
    outfile: bundle, logLevel: 'silent'
  })
  const m = await import(pathToFileURL(bundle).href)
  const noop = () => {}
  const learn = { ...emptyGuideLearn(), read: ['how.1', 'how.2', 'feature.1', 'feature.6'] }

  await test('render, state 08: ten topics, two Read, the rest Not opened', () => {
    const html = m.how({ learn, openId: null, onOpen: noop, onBack: noop, onTry: noop })
    assert.equal((html.match(/data-topic-row=/g) ?? []).length, 10)
    assert.equal((html.match(/data-topic-state="read"/g) ?? []).length, 2)
    assert.equal((html.match(/Not opened/g) ?? []).length, 8)
    const t = text(html)
    assert.ok(t.includes('How it works') && t.includes('2 of 10 read'))
    for (const topic of HOW_TOPICS) assert.ok(t.includes(topic.title), topic.title)
  })

  await test('render, state 09: a topic is a heading, its sentences, one picture and one Try it', () => {
    const html = m.how({ learn, openId: 'how.3', onOpen: noop, onBack: noop, onTry: noop })
    const t = text(html)
    assert.ok(t.includes('3 of 10') && t.includes('Headings become slides.'))
    for (const s of HOW_TOPICS[2].sentences) assert.ok(t.includes(s.replace(/`/g, '')), s)
    assert.equal((html.match(/data-topic-sentence/g) ?? []).length, 2)
    assert.equal((html.match(/data-guide-picture=/g) ?? []).length, 1)
    assert.equal((html.match(/data-topic-try-button/g) ?? []).length, 1)
    assert.ok(t.includes('Try it') && t.includes('Open the Start here slide.'))
    assert.ok(html.includes('<code class="guide-code">{statement}</code>'), 'the trigger is drawn as code')
    const button = (page, name) => page.match(new RegExp(`<button[^>]*${name}[^>]*>`))[0]
    assert.ok(!button(html, 'data-topic-prev').includes('disabled') && !button(html, 'data-topic-next').includes('disabled'))
    assert.ok(button(m.how({ learn, openId: 'how.1', onOpen: noop, onBack: noop, onTry: noop }), 'data-topic-prev').includes('disabled'), 'no previous before the first')
    assert.ok(button(m.how({ learn, openId: 'how.10', onOpen: noop, onBack: noop, onTry: noop }), 'data-topic-next').includes('disabled'), 'no next after the last')
  })

  await test('every topic draws its own picture', () => {
    const keys = HOW_TOPICS.map((t) => t.picture)
    assert.equal(new Set(keys).size, 10)
    for (const key of keys) assert.ok(m.picture(key).includes(`data-guide-picture="${key}"`) && m.picture(key).includes('<rect'), key)
  })

  await test('render, states 10 and 18: the sections, the hints, Read on the opened rows; section four reads this Mac', () => {
    const html = m.features({ learn, onRead: noop, readConnections: async () => [], onAction: noop })
    const t = text(html)
    for (const [title] of DELIGHT) assert.ok(t.includes(title), title)
    for (const row of FEATURE_ROWS) assert.ok(t.includes(row.title), row.title)
    assert.ok(t.includes('1. What presentations are') && t.includes('4. How you connect, and what each needs'))
    assert.ok(t.includes('Without any connection') && t.includes('Live, if you choose to connect'))
    assert.equal((html.match(/data-feature-row=/g) ?? []).length, 16)
    assert.equal((html.match(/data-feature-state="read"/g) ?? []).length, 2)
    assert.ok(t.includes('Share menu') && t.includes('Tools › Studio'))
    assert.ok(t.includes('What it connects to. States are read from this Mac.'))
    assert.ok(html.includes('data-connections-refresh'))
  })
} finally {
  rmSync(renderDir, { recursive: true, force: true })
}
console.log(`\n${passed} passed`)
