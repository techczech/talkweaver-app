// Onboarding 0.38.1 ticket 07: the Guide tab, the Guide button in the left sidebar, the Settings switch.
//   - the Guide's strings are the drawing's (TEXT in the locked mockup's text file);
//   - the three first steps tick from real state (a non-example vault, a talk in one, the example talk opened);
//   - the switch and the progress are read tolerantly from app config; main, preload and the mock carry them;
//   - the two palette commands are registered with a task group and places (tickets 01 and 02 tests also run);
//   - render: the tab row with and without the Guide, the sidebar foot with the button on, open and off,
//     each first-step state, the three segments with their empty slots, and Settings → Get started first.
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import {
  GUIDE_TEXT, GUIDE_SEGMENTS, GUIDE_DEFAULT_SEGMENT, GUIDE_BUTTON_VISIBLE_DEFAULT, GUIDE_BUTTON_VISIBLE_KEY, GUIDE_PROGRESS_KEY,
  guideButtonVisibleFrom, guideProgressFrom, firstSteps, firstStepsCount, rightColumnTabs
} from '../src/shared/guide.ts'
import { COMMAND_REGISTRY, paletteCommands } from '../src/shared/command-registry.ts'
import { TEXT } from '../docs/design/2026-10-09-onboarding-and-command-help/mockup-onboarding-talkweaver-text.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(join(REPO, rel), 'utf8')
let passed = 0
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`PASS  ${name}`) } catch (error) { console.error(`FAIL  ${name}`); throw error }
}
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()

const renderDir = mkdtempSync(join(REPO, '.test-guide-'))
try {
  await test('the Guide’s strings are the drawing’s', () => {
    assert.deepEqual([...GUIDE_TEXT.segments], TEXT.segments)
    assert.equal(GUIDE_TEXT.stepsBar, TEXT.steps.bar)
    TEXT.steps.rows.forEach((row, i) => {
      assert.equal(GUIDE_TEXT.steps[i].label, row.label)
      assert.equal(GUIDE_TEXT.steps[i].action, row.action)
    })
    assert.equal(GUIDE_TEXT.openedResult, TEXT.steps.rows[2].done)
    assert.equal(GUIDE_TEXT.button, TEXT.guideBtn)
    assert.equal(GUIDE_TEXT.buttonOpen, 'open', 'state 02 draws "Guide open"')
    assert.equal(GUIDE_TEXT.offFlash, TEXT.guideOffFlash)
    assert.equal(GUIDE_TEXT.settings.section, TEXT.settings.section)
    assert.equal(GUIDE_TEXT.settings.row, 'Get started')
    assert.equal(GUIDE_TEXT.settings.open, TEXT.settings.b2)
    assert.equal(GUIDE_TEXT.settings.switchTitle, TEXT.settings.switchT)
    assert.equal(GUIDE_TEXT.settings.switchSub, TEXT.settings.switchS)
    const rows = TEXT.palette.rows.map((r) => r[0])
    assert.ok(rows.includes(GUIDE_TEXT.paletteOpen) && rows.includes(GUIDE_TEXT.paletteShowButton))
    assert.deepEqual(GUIDE_SEGMENTS.map((s) => s.label), TEXT.segments)
    assert.equal(GUIDE_DEFAULT_SEGMENT, 'commands')
  })

  const own = { id: 'p', name: 'Personal', open: true }
  const example = { id: 'e', name: 'Example vault', example: true, open: true }
  const noProgress = { exampleTalkOpened: false }

  await test('first steps: nothing done with only the example vault and no talk opened', () => {
    const steps = firstSteps({ vaults: [example], talks: [{ vaultId: 'e', title: 'The Saturday market' }], progress: noProgress })
    assert.deepEqual(steps.map((s) => [s.id, s.done, s.result]), [['own-vault', false, null], ['first-talk', false, null], ['example-talk', false, null]])
    assert.equal(firstStepsCount(steps), '0 of 3')
    assert.deepEqual(steps.map((s) => s.action), ['Add vault…', 'New presentation…', 'Open'])
  })

  await test('first steps: a vault of one’s own ticks step 1 with its name; a talk in the example does not tick step 2', () => {
    const steps = firstSteps({ vaults: [own, example], talks: [{ vaultId: 'e', title: 'The Saturday market' }], progress: noProgress })
    assert.deepEqual(steps.map((s) => [s.done, s.result]), [[true, 'Personal'], [false, null], [false, null]])
  })

  await test('first steps: a talk in one’s own vault ticks step 2 with the talk’s name', () => {
    const steps = firstSteps({ vaults: [own, example], talks: [{ vaultId: 'e', title: 'The Saturday market' }, { vaultId: 'p', title: 'Metaphor talk 2026' }], progress: noProgress })
    assert.deepEqual(steps.map((s) => [s.done, s.result]), [[true, 'Personal'], [true, 'Metaphor talk 2026'], [false, null]])
  })

  await test('first steps: the example talk opened ticks step 3 as “Opened”, drawn as state 02 (1 of 3)', () => {
    const steps = firstSteps({ vaults: [own, example], talks: [], progress: { exampleTalkOpened: true } })
    assert.deepEqual(steps.map((s) => s.done), [true, false, true])
    assert.equal(steps[2].result, 'Opened')
    const state02 = firstSteps({ vaults: [example], talks: [], progress: { exampleTalkOpened: true } })
    assert.deepEqual(state02.map((s) => s.done), [false, false, true])
    assert.equal(firstStepsCount(state02), '1 of 3')
  })

  await test('first steps: a talk whose vault is unknown ticks nothing', () => {
    assert.equal(firstSteps({ vaults: [own], talks: [{ vaultId: null, title: 'x' }, { title: 'y' }], progress: noProgress })[1].done, false)
  })

  await test('the switch: on by default; anything but a boolean reads as never set; the key is fixed', () => {
    assert.equal(GUIDE_BUTTON_VISIBLE_DEFAULT, true)
    assert.equal(GUIDE_BUTTON_VISIBLE_KEY, 'guideButtonVisible')
    for (const odd of [undefined, null, 'off', 0, 1, {}, []]) assert.equal(guideButtonVisibleFrom(odd), true, String(odd))
    assert.equal(guideButtonVisibleFrom(false), false)
    assert.equal(guideButtonVisibleFrom(true), true)
  })

  await test('progress: read tolerantly, and kept apart from the switch (turning the switch off keeps progress)', () => {
    assert.equal(GUIDE_PROGRESS_KEY, 'guideProgress')
    for (const odd of [undefined, null, 'x', 3, [], {}, { exampleTalkOpened: 'yes' }]) assert.deepEqual(guideProgressFrom(odd), { exampleTalkOpened: false })
    assert.deepEqual(guideProgressFrom({ exampleTalkOpened: true, later: 1 }), { exampleTalkOpened: true })
    assert.notEqual(GUIDE_BUTTON_VISIBLE_KEY, GUIDE_PROGRESS_KEY)
  })

  await test('main, preload and the mock carry the switch and the progress; the switch broadcasts to every window', () => {
    const main = read('src/main/index.ts')
    for (const needle of ["'preferences:get-guide-button'", "'preferences:set-guide-button-visible'", "'guide:get-progress'", "'guide:note-example-talk-opened'", "'guide-button:changed'", "'guide:progress-changed'", 'BrowserWindow.getAllWindows()']) {
      assert.ok(main.includes(needle), `main: ${needle}`)
    }
    // Turning the switch off writes the switch only: the progress key is not in that handler.
    const setter = main.slice(main.indexOf('function setGuideButtonVisible('), main.indexOf("ipcMain.handle('guide:get-progress'"))
    assert.ok(setter.includes('guideButtonVisible') && !setter.includes('guideProgress'), 'the switch leaves progress alone')
    const preload = read('src/preload/index.ts')
    for (const needle of ['getGuideButton', 'setGuideButtonVisible', 'onGuideButtonChanged', 'getProgress', 'noteExampleTalkOpened', 'onProgressChanged']) assert.ok(preload.includes(needle), `preload: ${needle}`)
    const mock = read('src/renderer/src/tw-mock.ts')
    for (const needle of ['getGuideButton', 'setGuideButtonVisible', 'onGuideButtonChanged', 'noteExampleTalkOpened']) assert.ok(mock.includes(needle), `mock: ${needle}`)
  })

  await test('the two commands are registered: task group Set up TalkWeaver, places declared, handlers present, no key', () => {
    for (const [id, label, handler] of [['get-started-open-guide', GUIDE_TEXT.paletteOpen, 'guide.open'], ['get-started-show-guide-button', GUIDE_TEXT.paletteShowButton, 'guide.show-button']]) {
      const command = COMMAND_REGISTRY.find((c) => c.id === id)
      assert.ok(command, id)
      assert.equal(command.label, label)
      assert.equal(command.taskGroup, 'Set up TalkWeaver')
      assert.equal(command.subgroup, 'Get started')
      assert.ok(command.places, `${id}: places declared`)
      assert.equal(command.handlerId, handler)
      assert.ok(paletteCommands().some((c) => c.id === id), `${id}: in the palette`)
      assert.ok(read('src/renderer/src/components/WorkspaceLayout.tsx').includes(`'${handler}':`), `${id}: renderer handler`)
    }
    const app = read('src/renderer/src/App.tsx')
    assert.ok(app.includes("'tw-guide-open'") && app.includes("'tw-guide-show-button'"))
  })

  await test('the right column’s tabs: none without the Guide; Guide first with it; only the Guide with no talk', () => {
    assert.deepEqual(rightColumnTabs({ guideUp: false, hasTalk: true }), [])
    assert.deepEqual(rightColumnTabs({ guideUp: true, hasTalk: true }), ['guide', 'slides', 'inspector'])
    assert.deepEqual(rightColumnTabs({ guideUp: true, hasTalk: false }), ['guide'])
  })

  // ── render ──
  const bundle = join(renderDir, 'bundle.mjs')
  await build({
    stdin: {
      contents: [
        "import React from 'react'",
        "import { renderToStaticMarkup } from 'react-dom/server'",
        "import GuidePane from './src/renderer/src/components/GuidePane.tsx'",
        "import RightColumnTabs from './src/renderer/src/components/RightColumnTabs.tsx'",
        "import SidebarFoot from './src/renderer/src/components/talklist/SidebarFoot.tsx'",
        "import { GetStartedRows } from './src/renderer/src/components/SettingsWindowPages.tsx'",
        "export const pane = (props) => renderToStaticMarkup(React.createElement(GuidePane, props))",
        "export const tabs = (props) => renderToStaticMarkup(React.createElement(RightColumnTabs, props))",
        "export const foot = (props) => renderToStaticMarkup(React.createElement(SidebarFoot, props))",
        "export const settings = (props) => renderToStaticMarkup(React.createElement(GetStartedRows, props))"
      ].join('\n'),
      resolveDir: REPO,
      sourcefile: 'test-guide-entry.tsx'
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    jsx: 'automatic',
    loader: { '.css': 'empty' },
    external: ['react', 'react/*', 'react-dom', 'react-dom/*', 'lucide-react'],
    outfile: bundle,
    logLevel: 'silent'
  })
  const m = await import(pathToFileURL(bundle).href)
  const noop = () => {}
// Ticket 08 fills the Chapters slot; this test renders the pane around an empty list (test-guide-chapters.mjs tests the chapters).
const CHAPTERS_STUB = { chapters: [], learn: { version: 1, ran: [], opened: [], finished: {}, read: [] }, selected: null, onSelect: noop, onBack: noop, chordOf: () => '', practice: () => ({ talk: '', section: '', openNow: false }), onOpenPractice: noop, flashId: null }
// Ticket 11 fills the other two slots (test-guide-topics.mjs tests them); this test renders the pane around them.
const HOW_STUB = { learn: CHAPTERS_STUB.learn, openId: null, onOpen: noop, onBack: noop, onTry: noop }
const FEATURES_STUB = { learn: CHAPTERS_STUB.learn, onRead: noop, readConnections: async () => [], onAction: noop }

  await test('tab row: with the Guide it reads Guide, Slides, Inspector with a close mark on the Guide; without it nothing is drawn', () => {
    const base = { hasTalk: true, active: 'guide', onSelect: noop, onCloseGuide: noop }
    const html = m.tabs({ ...base, guideUp: true })
    assert.deepEqual([...html.matchAll(/data-rc-tab="(\w+)"/g)].map((x) => x[1]), ['guide', 'slides', 'inspector'])
    assert.equal(text(html).replace(/\s+/g, ' ').trim(), 'Guide Slides Inspector')
    assert.ok(html.includes('data-guide-close') && html.includes('aria-label="Close the Guide"'))
    assert.equal((html.match(/data-guide-close/g) ?? []).length, 1, 'one close mark, on the Guide only')
    assert.ok(/data-rc-tab="guide"/.test(html) && /rc-tab rc-tab--on" data-rc-tab="guide"/.test(html), 'the Guide is the one showing')
    assert.ok(/rc-tab rc-tab--on" data-rc-tab="inspector"/.test(m.tabs({ ...base, guideUp: true, active: 'inspector' })))
    assert.equal(m.tabs({ ...base, guideUp: false }), '')
    assert.deepEqual([...m.tabs({ ...base, guideUp: true, hasTalk: false }).matchAll(/data-rc-tab="(\w+)"/g)].map((x) => x[1]), ['guide'])
  })

  await test('sidebar foot: Add vault… with the Guide button on, open, and off', () => {
    const on = m.foot({ onAddVault: noop, guide: { open: false, onToggle: noop } })
    assert.ok(text(on).includes('Add vault…') && text(on).includes('Guide') && !text(on).includes('Guide open'))
    assert.ok(on.includes('data-guide-button') && !on.includes('tl-guide--open') && on.includes('M22 10v6'), 'the graduation cap')
    assert.ok(on.indexOf('data-add-vault') < on.indexOf('data-guide-button'), 'beside Add vault…, after it')
    const open = m.foot({ onAddVault: noop, guide: { open: true, onToggle: noop } })
    assert.ok(text(open).includes('Guide open') && open.includes('tl-guide--open') && open.includes('aria-pressed="true"'))
    const off = m.foot({ onAddVault: noop, guide: null })
    assert.ok(text(off).includes('Add vault…') && !off.includes('data-guide-button') && !text(off).includes('Guide'))
  })

  const stepsFor = (progress, vaults, talks) => firstSteps({ vaults, talks, progress })
  await test('the Guide: three segments, First steps and its slots; each step state as drawn', () => {
    const steps = stepsFor(noProgress, [example], [])
    const html = m.pane({ segment: 'commands', onSegment: noop, steps, onStep: noop, chapters: CHAPTERS_STUB, how: HOW_STUB, features: FEATURES_STUB })
    assert.deepEqual([...html.matchAll(/data-guide-segment="(\w+)"/g)].map((x) => x[1]), ['commands', 'how', 'features'])
    const t = text(html)
    for (const s of TEXT.segments) assert.ok(t.includes(s), s)
    assert.ok(t.includes('First steps') && t.includes('0 of 3'))
    assert.equal((html.match(/data-guide-step-action/g) ?? []).length, 3)
    for (const a of ['Add vault…', 'New presentation…', 'Open']) assert.ok(t.includes(a), a)
    assert.ok(html.includes('data-guide-slot="chapters"'), 'ticket 08’s slot')
    assert.equal((html.match(/guide-segment--on/g) ?? []).length, 1, 'one segment showing')
    assert.ok(/guide-segment guide-segment--on" data-guide-segment="commands"/.test(html), 'Learn the commands first')
    // state 02: the example talk opened.
    const s02 = m.pane({ segment: 'commands', onSegment: noop, steps: stepsFor({ exampleTalkOpened: true }, [example], []), onStep: noop, chapters: CHAPTERS_STUB, how: HOW_STUB, features: FEATURES_STUB })
    assert.ok(text(s02).includes('1 of 3') && text(s02).includes('Opened'))
    assert.equal((s02.match(/data-guide-step-action/g) ?? []).length, 2)
    assert.ok(/data-guide-step="example-talk" data-done="true"/.test(s02) && /data-guide-step="own-vault" data-done="false"/.test(s02))
    // state 03 and beyond: own vault and a talk.
    const s03 = m.pane({ segment: 'commands', onSegment: noop, steps: stepsFor({ exampleTalkOpened: true }, [own, example], [{ vaultId: 'p', title: 'Metaphor talk 2026' }]), onStep: noop, chapters: CHAPTERS_STUB, how: HOW_STUB, features: FEATURES_STUB })
    assert.ok(text(s03).includes('3 of 3') && text(s03).includes('Personal') && text(s03).includes('Metaphor talk 2026'))
    assert.ok(!s03.includes('data-guide-step-action'))
  })

  await test('the other two segments show their names and their own slot; no First steps there', () => {
    for (const [segment, slot] of [['how', 'how-it-works'], ['features', 'features']]) {
      const html = m.pane({ segment, onSegment: noop, steps: stepsFor(noProgress, [example], []), onStep: noop, chapters: CHAPTERS_STUB, how: HOW_STUB, features: FEATURES_STUB })
      assert.ok(html.includes(`data-guide-slot="${slot}"`) && !html.includes('data-guide-steps'))
      assert.ok(text(html).includes('Learn the commands') && text(html).includes('How it works') && text(html).includes('Features to delight you'))
    }
  })

  await test('Settings: Get started is a page of the Settings window with Open the Guide; the Guide switch and the place-chip switch are General rows', async () => {
    // 0.42: Settings is its own window; the switches are schema settings (src/shared/settings-schema.ts).
    const html = m.settings({ exampleRemoved: false, onAction: noop })
    const t = text(html)
    assert.ok(t.includes('Get started'), 'page')
    assert.ok(t.includes('Open the Guide') && html.includes('data-open-guide'))
    const { schema } = await import('../src/shared/settings-schema.ts')
    const guide = schema.def('general.guideButton')
    assert.equal(guide?.label, TEXT.settings.switchT)
    assert.equal(guide?.help, TEXT.settings.switchS)
    assert.equal(guide?.type, 'toggle')
    const chip = schema.def('general.placeChip')
    assert.equal(chip?.label, 'Show where I am in the status bar')
    assert.equal(chip?.section, 'general')
    assert.equal(guide?.section, 'general')
  })

  console.log(`\n${passed} passed`)
} finally {
  rmSync(renderDir, { recursive: true, force: true })
  for (const name of readdirSync(REPO)) if (/^\.test-guide-[A-Za-z0-9]{6}$/.test(name)) rmSync(join(REPO, name), { recursive: true, force: true })
}
