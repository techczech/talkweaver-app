// Consistency review, batch 1 (house rules R3, R4, R6, R13): the plain title helper, the presenter's talk
// title, the one name for the talk and the audience window in the command registry, no insert in the action
// bar, and the view keys that replaced the resident key legends (every key a removed legend showed is still
// listed in the ⌘/ sheet, under its view).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const results = []
const test = (name, fn) => { try { fn(); results.push([true, name]) } catch (error) { results.push([false, `${name}: ${error.message}`]) } }

const { plainTalkTitle } = await import(new URL('../src/shared/plain-title.ts', import.meta.url))
const { authoredTalkTitle, withTalkTitle } = await import(new URL('../src/main/present-title.ts', import.meta.url))
const { viewKeySections } = await import(new URL('../src/shared/view-keys.ts', import.meta.url))
const { COMMAND_REGISTRY, toolbarCommands } = await import(new URL('../src/shared/command-registry.ts', import.meta.url))
const { DEFAULT_ACTION_BAR_ITEMS } = await import(new URL('../src/renderer/src/components/actionBar/model.ts', import.meta.url))

test('a talk title is shown without its Markdown emphasis marks', () => {
  assert.equal(plainTalkTitle('TalkWeaver **Embedded Page**'), 'TalkWeaver Embedded Page')
  assert.equal(plainTalkTitle('**About** this _showcase_'), 'About this showcase')
  assert.equal(plainTalkTitle('Plain title'), 'Plain title')
  assert.equal(plainTalkTitle('snake_case_name stays'), 'snake_case_name stays')
  assert.equal(plainTalkTitle(null), '')
})

test('literal asterisks and underscores in a title survive; only paired emphasis is removed', () => {
  assert.equal(plainTalkTitle('A* search'), 'A* search')
  assert.equal(plainTalkTitle('2 * 3 = 6'), '2 * 3 = 6')
  assert.equal(plainTalkTitle('file__name'), 'file__name')
  assert.equal(plainTalkTitle('an *emphasised* word'), 'an emphasised word')
  assert.equal(plainTalkTitle('use `code` here'), 'use code here')
  assert.equal(plainTalkTitle('escaped \\*star\\*'), 'escaped *star*')
  assert.equal(plainTalkTitle('***Human Title***'), 'Human Title')
  assert.equal(plainTalkTitle('`*literal*` stays'), '*literal* stays')
})

test('a frontmatter title loses only a matching pair of enclosing quotes', () => {
  assert.equal(authoredTalkTitle([], "---\ntitle: The speakers'\n---\n"), "The speakers'")
  assert.equal(authoredTalkTitle([], "---\ntitle: 'Twas the night\n---\n"), "'Twas the night")
  assert.equal(authoredTalkTitle([], '---\ntitle: "Quoted title"\n---\n'), 'Quoted title')
})

test('the presenter takes the title from the frontmatter even without a generated title slide', () => {
  const content = '---\ntitle: "Human **Title**"\nauto_title_slide: false\n---\n\n# Human Title\n'
  assert.equal(authoredTalkTitle([{ id: 'abc', title: 'First' }], content), 'Human Title')
  assert.equal(authoredTalkTitle([{ id: 'deck-title', title: 'From slide' }], 'no frontmatter'), 'From slide')
})

test('the presenter shows the talk title, not the file name', () => {
  const slides = [{ id: 'deck-title', title: 'TalkWeaver **Layout** Showcase' }, { id: 'abc', title: 'First' }]
  assert.equal(authoredTalkTitle(slides), 'TalkWeaver Layout Showcase')
  assert.equal(authoredTalkTitle([{ id: 'abc', title: 'No title slide' }]), '')
  const html = '<head><meta name="deck-title" content="layout-showcase"><title>layout-showcase</title></head>'
  assert.equal(withTalkTitle(html, 'A & B'), '<head><meta name="deck-title" content="A &amp; B"><title>A &amp; B</title></head>')
  assert.equal(withTalkTitle(html, ''), html, 'no authored title: untouched')
})

test('the talk is a Talk and the audience window has one name in the command registry', () => {
  const labels = COMMAND_REGISTRY.map((command) => command.label)
  assert.ok(labels.includes('New talk…') && labels.includes('Search talks…') && labels.includes('Talk design…'))
  assert.ok(!labels.some((label) => /presentations?…|\bDeck design|Audience view|Normalize trigger/.test(label)), 'no old name survives')
  assert.equal(COMMAND_REGISTRY.find((command) => command.id === 'present-audience').label, 'Open audience window')
  const toolbar = readFileSync(resolve(root, 'src/renderer/src/components/WorkspaceLayout.tsx'), 'utf8')
  assert.match(toolbar, /label="Talk"/)
  assert.doesNotMatch(toolbar, /label="Deck"/)
})

test('the action bar holds no insert: the Insert menu owns them', () => {
  const insertIds = new Set(toolbarCommands('insert').map((command) => command.id))
  const doubled = DEFAULT_ACTION_BAR_ITEMS.filter((id) => insertIds.has(id))
  assert.deepEqual(doubled, [], `in both: ${doubled.join(', ')}`)
})

// What each removed legend or hand-written sheet listed, by view: [label fragment, keys]. Every pair must
// be in the view's section of the ⌘/ sheet.
const LEGENDS = {
  talks: [['Move selection', '↑ ↓ ← →'], ['Open', '↵'], ['Up one folder level', '⌘↑'], ['Switch talk view', 'V'], ['Titles or filenames', 'N'], ['Focus filter', '/'], ['Rename', 'F2'], ['Actions menu', '⌘K']],
  'slide-picker': [['Move through', '↑ ↓ ← →'], ['Select a range', '⇧ click'], ['Select or deselect', 'X'], ['Select section', 'S'], ['Tag selected', 'T'], ['Preview', 'Space / P'], ['Cards across', '2–6'], ['Close', 'Esc']],
  studio: [['Play / pause', 'Space'], ['Previous slide', '←'], ['Next slide', '→'], ['Nudge back', ','], ['Nudge on', '.'], ['transcript segment', '['], ['transcript segment', ']'], ['Trim', 'T'], ['recording', '↑ ↓'], ['Upload', 'U'], ['Search recordings', '⌘F']],
  runs: [['Move through', '↑ ↓'], ['Open the recording in Studio', '↵'], ['Copy the handout link', 'C'], ['Open the handout', 'O'], ['Cycle grouping', 'G'], ['Search', '⌘F']],
  notes: [['Notes mode', 'N'], ['Script mode', 'S'], ['Open rewrite', 'R'], ['Show slide', '1–9'], ['Previous slide', '['], ['Next slide', ']'], ['Play / pause', 'Space'], ['Copy', 'C']],
  importer: [['Previous or next slide', 'J / K'], ['flagged', 'F'], ['Search imported', '⌘F'], ['Apply', '⌘↵'], ['Reset', '⌥R'], ['Close', 'Esc']],
  'slide-focus': [['Previous or next slide', '← →'], ['Adopt', 'A'], ['Detach', '⇧D'], ['Back to where', 'Esc']],
  'image-drawer': [['Insert at caret', '⌘↵'], ['Close', 'Esc']],
  pathways: [['Move pathway slide', '⌘↑ / ⌘↓'], ['Reorder slides', 'drag'], ['Remove a slide', '×']]
}
const sections = viewKeySections()
for (const [view, pairs] of Object.entries(LEGENDS)) {
  test(`the ${view} keys a removed legend showed are listed in the sheet`, () => {
    const section = sections.find((candidate) => candidate.id === view)
    assert.ok(section, `no section for ${view}`)
    for (const [label, keys] of pairs) {
      assert.ok(section.rows.some((row) => row.label.toLowerCase().includes(label.toLowerCase()) && row.keys === keys), `${view}: ${label} ${keys}`)
    }
  })
}

test('no resident key legend or stale promise is left in the views', () => {
  const read = (path) => readFileSync(resolve(root, path), 'utf8')
  for (const [path, needle] of [
    ['src/renderer/src/components/talklist/TalkList.tsx', 'tl-keybar'],
    ['src/renderer/src/components/Studio.tsx', 'tws-hintbar'],
    ['src/renderer/src/components/RunsView.tsx', 'twh-hintbar'],
    ['src/renderer/src/components/TalkText.tsx', 'tt-hintbar'],
    ['src/renderer/src/components/SlideFocus.tsx', 'lt-focus-hint'],
    ['src/renderer/src/components/ImageDrawer.tsx', 'image-drawer__foot'],
    ['src/renderer/src/components/SlideBrowser.tsx', 'SlidePickerHints'],
    ['src/renderer/src/components/SlideFocus.tsx', 'arriving in the next update'],
    ['src/renderer/src/components/RunsView.tsx', 'live-audience feature']
  ]) assert.ok(!read(path).includes(needle), `${path} still has ${needle}`)
})

const failed = results.filter(([ok]) => !ok)
for (const [ok, name] of results) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
if (failed.length) { console.log(`${failed.length} failed`); process.exit(1) }
console.log(`consistency batch 1: ${results.length} passed`)
