// Onboarding 0.38.1 ticket 08: Learn the commands, ten chapters with tried-counts.
//   - the strings and tables copied from the drawing (TEXT, CHAPTER_TALK, ICONS in the locked mockup's text
//     module; the live note in its parts module) are the drawing's;
//   - the chapters are derived from the registries: ten, in order, no key inside a surface, live commands
//     listed apart and not counted (decision 7), two-key rows and variants rows folded, a command the build
//     lacks never appears; the derived list and total of each chapter are printed;
//   - the record (events in, chapter states out): a corrupt record reads as empty, a row ticks when any of
//     its commands ran, history reads Not opened / Opened / "N of M tried" / "Finished 6 Oct", finishing
//     keeps its first date, the next chapter is offered;
//   - the main-process store: ids named by command, shortcut or handler tick once; commands that delete tick
//     only inside the example vault (decision 12); live commands are recorded but announce nothing; a failing
//     write or a corrupt record never throws; only the `guideLearn` key is written;
//   - render: each row state of the chapter list and of a chapter, the two key caps of a pair, the variants
//     row, the flash, Open this talk only when the practice talk is not the open one, the live note, and the
//     next chapter after a finished one.
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { COMMAND_REGISTRY } from '../src/shared/command-registry.ts'
import { TASK_GROUPS, SURFACE_KEYS } from '../src/shared/task-groups.ts'
import { PRESENTER_PALETTE } from '../src/shared/presenter-palette.ts'
import {
  CHAPTER_EXCLUDED, CHAPTER_ICONS, CHAPTER_TALK, DELETING_COMMANDS, LIVE_SUBGROUPS, MERGED_ROWS, SUBGROUP_ORDER, chapterCommands, chapterOfCommand, deriveChapters,
  isLiveCommand, resolveCommandId
} from '../src/shared/guide-chapters.ts'
import {
  GUIDE_LEARN_KEY, GUIDE_LEARN_VERSION, chapterComplete, chapterHistory, chapterHistoryText, emptyGuideLearn, finishedCountText, guideDate, guideLearnFrom,
  hasNoProgress, nextChapter, rowTried, triedCount, withChapterFinished, withChapterOpened, withCommandRan, withTopicRead
} from '../src/shared/guide-learn.ts'
import { GUIDE_TEXT } from '../src/shared/guide.ts'
import { GuideLearnStore } from '../src/main/guide-learn-store.ts'
import { TEXT, CHAPTER_TALK as DRAWN_TALK, ICONS as DRAWN_ICONS, MAP } from '../docs/design/2026-10-09-onboarding-and-command-help/mockup-onboarding-talkweaver-text.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(join(REPO, rel), 'utf8')
let passed = 0
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`PASS  ${name}`) } catch (error) { console.error(`FAIL  ${name}`); throw error }
}
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()

const renderDir = mkdtempSync(join(REPO, '.test-guide-chapters-'))
try {
  const chapters = deriveChapters()
  const byTask = Object.fromEntries(chapters.map((c) => [c.task, c]))
  const rowOf = (task, id) => byTask[task].rows.find((r) => r.ids.includes(id))

  await test('the strings and tables are the drawing’s', () => {
    assert.deepEqual(JSON.parse(JSON.stringify(CHAPTER_TALK)), DRAWN_TALK)
    assert.deepEqual(CHAPTER_ICONS, DRAWN_ICONS)
    assert.equal(GUIDE_TEXT.chapters.bar, TEXT.chaptersBar)
    assert.equal(GUIDE_TEXT.chapters.startHere, TEXT.startHere)
    assert.equal(GUIDE_TEXT.chapters.thisChapter, TEXT.thisChapter)
    assert.equal(GUIDE_TEXT.chapters.practiceTalk, TEXT.practiceTalk)
    assert.equal(GUIDE_TEXT.chapters.openInExample, TEXT.openInExample)
    assert.equal(GUIDE_TEXT.chapters.openNow, TEXT.openNow)
    // The history strings: Not opened, Opened, "6 of 24 tried", "Finished 6 Oct".
    assert.equal(chapterHistoryText({ kind: 'not-opened' }), TEXT.status.none)
    assert.equal(chapterHistoryText({ kind: 'opened' }), TEXT.status.opened)
    assert.equal(chapterHistoryText({ kind: 'tried', tried: 6, total: 24 }), TEXT.status.tried(6, 24))
    assert.equal(TEXT.status.finished, 'Finished 6 Oct')
    assert.equal(chapterHistoryText({ kind: 'finished', at: new Date(2026, 9, 6, 12).getTime() }), TEXT.status.finished)
    // The back link, "no key" and the live note are drawn in the parts module.
    const parts = read('docs/design/2026-10-09-onboarding-and-command-help/mockup-onboarding-talkweaver-parts.mjs')
    assert.ok(parts.includes(`'${GUIDE_TEXT.chapters.allChapters}'`), 'All chapters')
    assert.ok(parts.includes(`>${GUIDE_TEXT.chapters.noKey}<`), 'no key')
    const note = GUIDE_TEXT.chapters.liveNote(23)
    assert.ok(parts.includes('live commands</b>'), 'the count is bold')
    assert.ok(parts.includes(note.rest.trim()), 'the live note’s sentence')
    assert.ok(read('docs/design/2026-10-09-onboarding-and-command-help/mockup-onboarding-talkweaver-states.mjs').includes('Ticked · Move slide or item down'), 'the toast')
    assert.equal(GUIDE_TEXT.chapters.ticked, 'Ticked')
  })

  await test('ten chapters, one per task group, in the drawn order', () => {
    assert.deepEqual(chapters.map((c) => c.task), [...TASK_GROUPS])
    assert.deepEqual(chapters.map((c) => c.task), MAP.tasks.map((t) => t.name))
    for (const task of TASK_GROUPS) assert.deepEqual(DRAWN_TALK[task], CHAPTER_TALK[task])
  })

  await test('sub-groups come in the command map’s order; a sub-group the build added comes after them', () => {
    const live = new Set(LIVE_SUBGROUPS)
    for (const task of TASK_GROUPS) {
      const drawn = []
      for (const r of MAP.records) if (r.class === 'command' && r.task === task && !live.has(r.subgroup) && !drawn.includes(r.subgroup)) drawn.push(r.subgroup)
      const got = byTask[task].subgroups.map((g) => g.name).filter((n) => drawn.includes(n))
      assert.deepEqual(got, drawn.filter((n) => got.includes(n)), `${task} keeps the drawn order`)
      for (const name of byTask[task].subgroups.map((g) => g.name)) assert.ok(SUBGROUP_ORDER[task].includes(name), `${task}: ${name} is placed in SUBGROUP_ORDER`)
    }
  })

  await test('derived lists: every row is a command that exists; no key inside a surface; live rows are apart and not counted', () => {
    const exists = new Set([...COMMAND_REGISTRY.map((c) => c.id), ...chapterCommands().map((c) => c.id)])
    for (const chapter of chapters) {
      for (const row of [...chapter.rows, ...chapter.live]) for (const id of row.ids) {
        assert.ok(exists.has(id), `${id} exists in this build`)
        assert.ok(!(id in SURFACE_KEYS), `${id} is a key inside a surface`)
      }
      assert.ok(chapter.rows.every((row) => !LIVE_SUBGROUPS.includes(row.subgroup)), `${chapter.task}: no live row is counted`)
      assert.ok(chapter.live.every((row) => LIVE_SUBGROUPS.includes(row.subgroup)))
      assert.ok(chapter.rows.length > 0, `${chapter.task} has rows`)
      const keys = chapter.rows.map((r) => r.id)
      assert.equal(new Set(keys).size, keys.length, `${chapter.task}: row ids are unique`)
    }
    // Every grouped command lands in exactly one chapter (counted or live), once.
    const placed = chapters.flatMap((c) => [...c.rows, ...c.live].flatMap((r) => [...r.ids]))
    const grouped = chapterCommands().map((c) => c.id).filter((id) => !CHAPTER_EXCLUDED.has(id))
    assert.equal(new Set(placed).size, placed.length, 'a command is in one row only')
    assert.deepEqual([...placed].sort(), [...grouped].sort(), 'every grouped command is in a chapter, except the excluded launches')
    // Owner check 10 Oct: Presentation window and Audience view are not rows of the Present chapter (Launch audience covers them).
    // Plain editing view ticket 01 adds the two editor tabs' commands until the Guide names them (ticket 10).
    // Quote forms (ADR-0038): the seven "Quote form: …" palette commands are not practice rows either.
    assert.deepEqual([...CHAPTER_EXCLUDED].sort(), ['attach-postwork', 'attach-prework', 'change-heading-level', 'change-slide-layout', 'move-section-to', 'move-slide-to', 'outline-collapse-all', 'outline-expand-all', 'present-audience', 'present-window', 'quote-form-auto', 'quote-form-book', 'quote-form-paper', 'quote-form-plain', 'quote-form-tweet', 'quote-form-video', 'quote-form-web',
      // Work files ticket 30: the Tools window's commands, held back with pre-work.
      'tools-copy-invitation', 'tools-copy-link', 'tools-edit-plan', 'tools-go-live', 'tools-new-work-file', 'tools-open-run', 'tools-plan-like-this', 'tools-plan-run', 'tools-publish', 'tools-unpublish', 'tools-view-published', 'tools-view-sessions', 'tools-view-workfiles',
      'view-markdown', 'view-plain'])
    for (const id of CHAPTER_EXCLUDED) {
      assert.ok(chapterCommands().some((c) => c.id === id), `${id} is still a command (palette, menus)`)
      assert.ok(!placed.includes(id), `${id} is in no chapter`)
      assert.ok(!byTask['Present'].rows.some((r) => /^(Presentation window|Audience view)$/.test(r.label)), 'neither label is a Present row')
    }
    // Live: only Present has any, and the drawn 23 are among them.
    assert.ok(byTask['Present'].live.length > 0)
    for (const task of TASK_GROUPS.filter((t) => t !== 'Present')) assert.equal(byTask[task].live.length, 0, `${task} has no live commands`)
  })

  await test('the derived list and total of each chapter (printed for the report)', () => {
    let all = 0
    for (const chapter of chapters) {
      all += chapter.rows.length
      const merged = chapter.rows.filter((r) => r.merged).map((r) => `${r.label} [${r.merged}, ${r.ids.length} commands]`)
      console.log(`  ${chapter.task}: ${chapter.rows.length} rows (${chapter.rows.reduce((n, r) => n + r.ids.length, 0)} commands), ${chapter.live.length} live apart; sub-groups ${chapter.subgroups.map((g) => `${g.name} ${g.rows.length}`).join(' · ')}${merged.length ? `; folded: ${merged.join('; ')}` : ''}`)
    }
    console.log(`  total counted rows: ${all}`)
    assert.ok(all > 100)
  })

  await test('two keys for one idea are one row with two key caps; variants of one setting are one row naming them', () => {
    const pair = rowOf('Present', 'presenter.font-larger')
    assert.equal(pair.merged, 'pair')
    assert.deepEqual([...pair.ids], ['presenter.font-larger', 'presenter.font-smaller'])
    assert.deepEqual([...pair.shortcutIds], ['presenter.font-larger', 'presenter.font-smaller'])
    const pen = rowOf('Present', 'presenter-palette.pen-freehand')
    assert.equal(pen.merged, 'variants')
    assert.deepEqual([...pen.ids], ['presenter-palette.pen-freehand', 'presenter-palette.pen-arrow', 'presenter-palette.pen-rectangle'])
    assert.ok(pen.label.includes('Freehand') && pen.label.includes('Arrow') && pen.label.includes('Rectangle'))
    assert.deepEqual([...pen.shortcutIds], [], 'the palette-only entries have no key')
    for (const set of MERGED_ROWS) {
      const rows = chapters.flatMap((c) => c.rows).filter((r) => r.ids.some((id) => set.ids.includes(id)))
      assert.equal(rows.length, 1, `${set.label} is one row`)
      assert.deepEqual([...rows[0].ids], [...set.ids], 'its members, in its own order')
    }
    // The drawn rows that are two commands in the map but two rows in the drawing stay two rows.
    assert.notEqual(rowOf('Write the outline', 'editor.move-up'), rowOf('Write the outline', 'editor.move-down'))
  })

  await test('a command the build lacks never appears; a set with one member left is that command’s own row', () => {
    const all = chapterCommands()
    const without = all.filter((c) => c.id !== 'presenter-palette.pen-arrow' && c.id !== 'format-bold')
    const built = deriveChapters(without)
    const flat = built.flatMap((c) => [...c.rows, ...c.live]).flatMap((r) => [...r.ids])
    assert.ok(!flat.includes('presenter-palette.pen-arrow') && !flat.includes('format-bold'))
    const pen = built.find((c) => c.task === 'Present').rows.find((r) => r.ids.includes('presenter-palette.pen-freehand'))
    assert.deepEqual([...pen.ids], ['presenter-palette.pen-freehand', 'presenter-palette.pen-rectangle'], 'the set keeps the members the build has')
    const alone = deriveChapters(all.filter((c) => !['presenter-palette.pen-arrow', 'presenter-palette.pen-rectangle'].includes(c.id)))
    const single = alone.find((c) => c.task === 'Present').rows.find((r) => r.ids.includes('presenter-palette.pen-freehand'))
    assert.equal(single.merged, null)
    assert.equal(single.label, 'Pen tool: Freehand')
    assert.equal(built.find((c) => c.task === 'Write the outline').rows.length, byTask['Write the outline'].rows.length - 1)
  })

  await test('commands are named by id, shortcut id or handler id; anything else is nothing', () => {
    assert.equal(resolveCommandId('format-bold'), 'format-bold')
    assert.equal(resolveCommandId('editor.bold'), 'format-bold')
    assert.equal(resolveCommandId('guide.open'), 'get-started-open-guide')
    assert.equal(resolveCommandId('editor.move-down'), 'editor.move-down')
    assert.equal(resolveCommandId('presenter-palette.pen-arrow'), 'presenter-palette.pen-arrow')
    for (const bad of ['', 'nope', 'x'.repeat(200), 42, null, undefined, {}, ['format-bold'], 'editor.rollback-trigger']) assert.equal(resolveCommandId(bad), null, String(bad))
    assert.equal(chapterOfCommand(chapters, 'delete-slide').task, 'Write the outline')
    assert.ok(isLiveCommand(chapters, 'presenter.live'))
    assert.ok(!isLiveCommand(chapters, 'presenter.next'))
    assert.deepEqual([...DELETING_COMMANDS].sort(), ['browser.delete-talk', 'delete-slide', 'pathway.delete'])
    for (const id of DELETING_COMMANDS) assert.equal(resolveCommandId(id), id)
  })

  const drawnTried = ['format-bold', 'format-italic', 'format-highlight', 'fold-all', 'new-slide', 'promote-heading']
  const withRan = (ids, base = emptyGuideLearn()) => ids.reduce((learn, id) => withCommandRan(learn, id), base)

  await test('the record: tolerant read, its own version, and events that change nothing return the same object', () => {
    assert.deepEqual(guideLearnFrom(undefined), emptyGuideLearn())
    for (const junk of ['{"ran":[]}', 7, 'x', [], null, { version: 2, ran: ['a'] }, { ran: ['format-bold'] }, { version: 'one' }]) assert.deepEqual(guideLearnFrom(junk), emptyGuideLearn(), JSON.stringify(junk))
    const read = guideLearnFrom({ version: GUIDE_LEARN_VERSION, ran: ['format-bold', 'format-bold', '', 5, 'a'.repeat(300)], opened: ['Share', 'Nope'], finished: { Present: 12, Nope: 3, Share: 'x' }, read: ['how.3', 9] })
    assert.deepEqual(read, { version: 1, ran: ['format-bold'], opened: ['Share'], finished: { Present: 12 }, read: ['how.3'] })
    assert.equal(GUIDE_LEARN_KEY, 'guideLearn')
    const once = withCommandRan(emptyGuideLearn(), 'format-bold')
    assert.equal(withCommandRan(once, 'format-bold'), once)
    assert.equal(withCommandRan(once, 42), once)
    assert.equal(withChapterOpened(emptyGuideLearn(), 'Nope').opened.length, 0)
    const opened = withChapterOpened(emptyGuideLearn(), 'Share')
    assert.equal(withChapterOpened(opened, 'Share'), opened)
    assert.deepEqual(withTopicRead(emptyGuideLearn(), 'how.1').read, ['how.1'])
    assert.equal(withChapterFinished(withChapterFinished(emptyGuideLearn(), 'Share', 5), 'Share', 9).finished.Share, 5, 'the first date stays')
  })

  await test('history: Not opened, Opened, “6 of N tried”, Finished with the date; Start here only for a person with no progress', () => {
    const write = byTask['Write the outline']
    assert.deepEqual(chapterHistory(emptyGuideLearn(), write), { kind: 'not-opened' })
    assert.ok(hasNoProgress(emptyGuideLearn()))
    const opened = withChapterOpened(emptyGuideLearn(), 'Write the outline')
    assert.deepEqual(chapterHistory(opened, write), { kind: 'opened' })
    assert.ok(!hasNoProgress(opened))
    const six = withRan(drawnTried)
    assert.equal(triedCount(write, six), 6)
    assert.deepEqual(chapterHistory(six, write), { kind: 'tried', tried: 6, total: write.rows.length })
    assert.equal(chapterHistoryText(chapterHistory(six, write)), `6 of ${write.rows.length} tried`)
    assert.ok(!hasNoProgress(six))
    const seven = withCommandRan(six, 'editor.move-down')
    assert.equal(triedCount(write, seven), 7, 'the drawn tick: ⌘⇧↓ takes 6 to 7')
    assert.ok(rowTried(rowOf('Write the outline', 'editor.move-down'), seven))
    const done = withChapterFinished(seven, 'Write the outline', new Date(2026, 9, 6, 12).getTime())
    assert.deepEqual(chapterHistory(done, write), { kind: 'finished', at: new Date(2026, 9, 6, 12).getTime() })
    assert.equal(chapterHistoryText(chapterHistory(done, write)), 'Finished 6 Oct')
    assert.equal(guideDate(new Date(2026, 0, 1, 9).getTime()), '1 Jan')
    assert.equal(finishedCountText(chapters, done), '1 of 10 finished')
    assert.equal(finishedCountText(chapters, emptyGuideLearn()), '0 of 10 finished')
    assert.equal(nextChapter(chapters, 'Write the outline').task, 'Build a slide')
    assert.equal(nextChapter(chapters, 'Set up TalkWeaver'), null)
  })

  await test('a merged row ticks when any of its commands has run; a live command ticks no row and counts toward nothing', () => {
    const present = byTask['Present']
    const pair = rowOf('Present', 'presenter.font-larger')
    assert.ok(!rowTried(pair, emptyGuideLearn()))
    assert.ok(rowTried(pair, withRan(['presenter.font-smaller'])), 'either key')
    assert.ok(rowTried(rowOf('Present', 'presenter-palette.pen-freehand'), withRan(['presenter-palette.pen-rectangle'])))
    assert.equal(triedCount(present, withRan(['presenter.live', 'presenter.poll-primary'])), 0)
    assert.ok(!chapterComplete(present, withRan(['presenter.live'])))
    const every = withRan(present.rows.flatMap((r) => [...r.ids]))
    assert.ok(chapterComplete(present, every))
    const everyOne = withRan(present.rows.map((r) => r.ids[0]))
    assert.ok(chapterComplete(present, everyOne), 'one command per row finishes the chapter')
  })

  // ── the store ──
  const makeStore = (initial, opts = {}) => {
    const cfg = { value: initial, writes: 0, announced: [] }
    const store = new GuideLearnStore({
      read: () => cfg.value,
      write: (record) => { if (opts.failWrite) throw new Error('disk full'); cfg.value = record; cfg.writes += 1 },
      now: () => (opts.now ?? new Date(2026, 9, 6, 12).getTime())
    })
    store.onChange = (record) => { cfg.announced.push(record) }
    return { store, cfg }
  }
  const IN = { inExample: true }
  const OUT = { inExample: false }

  await test('store: a command ticks once, by any of its names, and is announced once', () => {
    const { store, cfg } = makeStore(undefined)
    assert.deepEqual(store.commandRan('editor.bold', OUT), { id: 'format-bold', ticked: true })
    assert.deepEqual(store.commandRan('format-bold', OUT), { id: 'format-bold', ticked: false })
    assert.deepEqual(store.commandRan('nope', OUT), { id: null, ticked: false })
    assert.deepEqual(cfg.value.ran, ['format-bold'])
    assert.equal(cfg.writes, 1)
    assert.equal(cfg.announced.length, 1)
    assert.equal(cfg.value.version, 1)
  })

  await test('store: commands that delete tick only inside the example vault (decision 12)', () => {
    const { store, cfg } = makeStore(undefined)
    for (const id of ['delete-slide', 'editor.delete-slide', 'browser.delete-talk', 'pathway.delete']) {
      assert.deepEqual(store.commandRan(id, OUT).ticked, false, `${id} outside the example`)
    }
    assert.deepEqual(cfg.value, undefined, 'nothing written')
    assert.equal(store.commandRan('editor.delete-slide', IN).ticked, true)
    assert.equal(store.commandRan('browser.delete-talk', IN).ticked, true)
    assert.deepEqual(cfg.value.ran, ['delete-slide', 'browser.delete-talk'])
    // Another command is not affected by where it ran.
    assert.equal(store.commandRan('format-italic', OUT).ticked, true)
  })

  await test('store: a live command is recorded but announces no tick; the chapter finishes with the date of its last row', () => {
    const { store, cfg } = makeStore(undefined)
    assert.deepEqual(store.commandRan('presenter.live', IN), { id: 'presenter.live', ticked: false })
    assert.deepEqual(cfg.value.ran, ['presenter.live'])
    const share = byTask['Share']
    const ids = share.rows.map((r) => r.ids[0])
    ids.slice(0, -1).forEach((id) => assert.equal(store.commandRan(id, OUT).ticked, true))
    assert.equal(cfg.value.finished.Share, undefined, 'not yet')
    assert.equal(store.commandRan(ids.at(-1), OUT).ticked, true)
    assert.equal(cfg.value.finished.Share, new Date(2026, 9, 6, 12).getTime(), 'the last row finishes it')
    assert.ok(store.chapters().find((c) => c.task === 'Share'))
    // Running one again changes nothing.
    const before = cfg.writes
    store.commandRan(ids[0], OUT)
    assert.equal(cfg.writes, before)
  })

  await test('store: a failing write or a corrupt record never throws, and a report never fails a command', () => {
    const failing = makeStore(undefined, { failWrite: true })
    assert.doesNotThrow(() => failing.store.commandRan('format-bold', OUT))
    assert.deepEqual(failing.store.commandRan('format-bold', OUT), { id: 'format-bold', ticked: false }, 'not written, so not ticked')
    for (const corrupt of ['{"ran":', 12, { version: 99 }, { version: 1, ran: 'x' }]) {
      const { store, cfg } = makeStore(corrupt)
      assert.deepEqual(store.read(), emptyGuideLearn())
      assert.equal(store.commandRan('format-bold', OUT).ticked, true)
      assert.deepEqual(cfg.value.ran, ['format-bold'])
    }
    const throwingRead = new GuideLearnStore({ read: () => { throw new Error('unreadable') }, write: () => {} })
    assert.deepEqual(throwingRead.read(), emptyGuideLearn())
    assert.doesNotThrow(() => throwingRead.commandRan('format-bold', OUT))
    const throwingListener = makeStore(undefined)
    throwingListener.store.onChange = () => { throw new Error('window closed') }
    assert.equal(throwingListener.store.commandRan('format-bold', OUT).ticked, true)
  })

  await test('store: chapter opens and read marks are kept; the record is the only thing written, in app config and not in a vault', () => {
    const { store, cfg } = makeStore(undefined)
    assert.equal(store.chapterOpened('Share'), true)
    assert.equal(store.chapterOpened('Share'), false)
    assert.equal(store.chapterOpened('Nope'), false)
    assert.equal(store.topicRead('how.2'), true)
    assert.deepEqual([cfg.value.opened, cfg.value.read], [['Share'], ['how.2']])
    const source = read('src/main/guide-learn-store.ts')
    assert.ok(!/vault/i.test(source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')), 'the store code names no vault')
    const main = read('src/main/index.ts')
    assert.ok(main.includes("read: () => readConfig()[GUIDE_LEARN_KEY]") && main.includes('write: (record: GuideLearn) => writeConfig({ [GUIDE_LEARN_KEY]: record })'), 'main keeps it through the config file’s own atomic write')
    assert.ok(read('src/main/config-file.ts').includes('rename'), 'that write is temp file plus rename')
  })

  await test('main, preload and the mock carry the report; main decides the example from the talk’s path', () => {
    const main = read('src/main/index.ts')
    for (const channel of ['guide:get-learn', 'guide:command-ran', 'guide:chapter-opened', 'guide:topic-read', 'guide:learn-changed']) assert.ok(main.includes(`'${channel}'`), channel)
    assert.ok(main.includes('vaultRegistry.resolve(outlinePath)') && main.includes('hit?.vault.example === true'))
    // Ticket 10: a deck window main opened may report only a well-formed presenter id (src/main/guide-present.ts).
    assert.ok(main.includes('acceptCommandRan({ appWindow, deckWindow: presentWindows.has(event.sender.id) }, id)'), 'a deck window may report only presenter commands')
    assert.ok(read('src/main/guide-present.ts').includes('return sender.deckWindow && isPresenterCommandId(id)'))
    assert.ok(main.includes("guideLearn.commandRan('new-window'"), 'File › New Window reports from main')
    const preload = read('src/preload/index.ts')
    for (const name of ['getLearn', 'commandRan', 'chapterOpened', 'topicRead', 'onLearnChanged']) assert.ok(preload.includes(name), name)
    const mock = read('src/renderer/src/tw-mock.ts')
    for (const name of ['getLearn', 'commandRan', 'chapterOpened', 'topicRead', 'onLearnChanged']) assert.ok(mock.includes(name), name)
    const bridge = read('src/preload/present-edit-bridge.ts')
    assert.ok(read('src/shared/guide-present.ts').includes("GUIDE_COMMAND_RAN_EVENT = 'tw-guide-command-ran'") && bridge.includes('window.addEventListener(GUIDE_COMMAND_RAN_EVENT') && bridge.includes("ipcRenderer.invoke('guide:command-ran', id)"), 'the presenter’s bridge entry point')
  })

  // ── render ──
  const bundle = join(renderDir, 'bundle.mjs')
  await build({
    stdin: {
      contents: [
        "import React from 'react'",
        "import { renderToStaticMarkup } from 'react-dom/server'",
        "import GuideChapters from './src/renderer/src/components/GuideChapters.tsx'",
        "export const render = (props) => renderToStaticMarkup(React.createElement(GuideChapters, props))"
      ].join('\n'),
      resolveDir: REPO,
      sourcefile: 'test-guide-chapters-entry.tsx'
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
  const chordOf = (id) => ({ 'editor.move-down': '⌘⇧↓', 'editor.promote': '⌘⇧←', 'presenter.font-larger': '⌘+', 'presenter.font-smaller': '⌘−', 'editor.bold': '⌘B' })[id] ?? ''
  const base = {
    chapters, learn: emptyGuideLearn(), selected: null, onSelect: noop, onBack: noop, chordOf, flashId: null, onOpenPractice: noop,
    practice: (task) => ({ talk: CHAPTER_TALK[task][0], section: CHAPTER_TALK[task][1], openNow: false })
  }

  await test('render, the list: ten rows with their history; Start here on the first for a person with no progress (state 04)', () => {
    const fresh = m.render(base)
    const rows = [...fresh.matchAll(/data-chapter-row="([^"]+)" data-chapter-state="([^"]+)"/g)].map((x) => [x[1], x[2]])
    assert.deepEqual(rows, TASK_GROUPS.map((t) => [t, 'not-opened']))
    const t = text(fresh)
    assert.ok(t.startsWith('Chapters 0 of 10 finished'))
    assert.ok(t.includes('Write the outline Start here Not opened'))
    assert.equal((fresh.match(/Start here/g) ?? []).length, 1)
    const learn = withChapterFinished(withRan(drawnTried, withChapterOpened(emptyGuideLearn(), 'Build a slide')), 'See the talk', new Date(2026, 9, 6, 12).getTime())
    const html = m.render({ ...base, learn })
    const states = Object.fromEntries([...html.matchAll(/data-chapter-row="([^"]+)" data-chapter-state="([^"]+)"/g)].map((x) => [x[1], x[2]]))
    assert.deepEqual(states, { 'Write the outline': 'tried', 'Build a slide': 'opened', 'Reuse slides': 'not-opened', 'See the talk': 'finished', 'Shape the talk': 'not-opened', 'Present': 'not-opened', 'Share': 'not-opened', 'Manage talks': 'not-opened', 'Check and repair': 'not-opened', 'Set up TalkWeaver': 'not-opened' })
    const u = text(html)
    assert.ok(u.includes(`6 of ${byTask['Write the outline'].rows.length} tried`))
    assert.ok(u.includes('Build a slide Opened') && u.includes('See the talk Finished 6 Oct') && u.includes('1 of 10 finished'))
    assert.ok(!u.includes('Start here'), 'no Start here once there is progress')
    assert.ok(html.includes('guide-mini') && /width:\d+%/.test(html), 'a bar beside the count')
  })

  await test('render, a chapter: back link, title with its count, bar, practice line, This chapter, sub-groups with rows (states 05, 06)', () => {
    const learn = withRan([...drawnTried, 'editor.move-down'])
    const write = byTask['Write the outline']
    const html = m.render({ ...base, learn, selected: 'Write the outline', flashId: 'editor.move-down' })
    const t = text(html)
    assert.ok(html.includes('data-chapter-detail="Write the outline"') && html.includes('data-chapter-back'))
    assert.ok(t.includes('All chapters') && t.includes(`7 of ${write.rows.length} tried`))
    assert.ok(t.includes('Practice talk: The Saturday market, section “01 Write the outline”.'))
    assert.ok(t.includes(`This chapter 7 of ${write.rows.length}`))
    assert.ok(!html.includes('data-guide-steps'), 'the chapter replaces the list; First steps is the pane’s')
    // Sub-groups: names and counts; the open one lists its rows with ticks and chords.
    for (const group of write.subgroups) assert.ok(t.includes(`${group.name} ${group.rows.filter((r) => rowTried(r, learn)).length} of ${group.rows.length}`), group.name)
    const flashed = html.match(/class="guide-vrow[^"]*guide-vrow--flash[^"]*" data-command-row="([^"]+)"/)
    assert.equal(flashed?.[1], 'editor.move-down', 'the ticked row flashes')
    assert.ok(/data-command-row="editor\.move-down" data-ticked="true"[^>]*>.*?<kbd class="guide-key">⌘⇧↓<\/kbd>/.test(html), 'ticked row shows its chord')
    assert.ok(html.includes('data-command-row="format-inline-code" data-ticked="false"'), 'an unticked row in the open sub-group has an empty tick')
    assert.ok(html.includes('guide-nokey') && text(html).includes('no key'), 'a row with no key says so')
    assert.ok(html.includes('role="progressbar"') && html.includes('aria-valuenow="7"'))
    assert.ok(!html.includes('data-chapter-finished'))
  })

  await test('render: Open this talk shows only when the practice talk is not the open one', () => {
    const away = m.render({ ...base, selected: 'Reuse slides' })
    assert.ok(away.includes('data-chapter-open-practice') && text(away).includes('Open this talk'))
    assert.ok(text(away).includes('Practice talk: Garden notes, section “03 Reuse slides”.') && !text(away).includes('(open now)'))
    const here = m.render({ ...base, selected: 'Write the outline', practice: (task) => ({ talk: CHAPTER_TALK[task][0], section: CHAPTER_TALK[task][1], openNow: true }) })
    assert.ok(!here.includes('data-chapter-open-practice'))
    assert.ok(text(here).includes('Practice talk: The Saturday market (open now), section “01 Write the outline”.'))
  })

  await test('render: a pair row has two key caps, a variants row none, the Present chapter names its live commands apart', () => {
    const html = m.render({ ...base, selected: 'Present', learn: withRan(['presenter.font-smaller']), flashId: 'presenter.font-larger' })
    const pair = html.match(/data-command-row="presenter\.font-larger"[^>]*>(.*?)<\/div>/)?.[1] ?? ''
    assert.equal((pair.match(/<kbd/g) ?? []).length, 2, 'two key caps')
    assert.ok(pair.includes('⌘+') && pair.includes('⌘−'))
    assert.ok(/data-command-row="presenter\.font-larger" data-ticked="true"/.test(html), 'ticked by either key')
    assert.ok(html.includes('data-row-kind="pair"'))
    // The variants row (Display modes is open, as the flash opens it): named, with no key cap and no "no key".
    const variants = html.match(/data-command-row="presenter-palette\.pen-freehand"[^>]*>(.*?)<\/div>/)?.[1] ?? ''
    assert.ok(variants.includes('Pen tool: Freehand · Arrow · Rectangle') && !variants.includes('<kbd') && !variants.includes('no key'))
    assert.ok(html.includes('data-row-kind="variants"'))
    assert.ok(text(html).includes(`${byTask['Present'].live.length} live commands are listed apart: going live, polls, questions, boards, venue screen.`))
    assert.ok(html.includes('data-chapter-live-note'))
    assert.ok(!text(html).includes('Go or end live'), 'a live command is not listed')
    const noLive = m.render({ ...base, selected: 'Share' })
    assert.ok(!noLive.includes('data-chapter-live-note'))
  })

  await test('render: a finished chapter reads Finished with the date and offers the next chapter', () => {
    const share = byTask['Share']
    const learn = withChapterFinished(withRan(share.rows.map((r) => r.ids[0])), 'Share', new Date(2026, 9, 6, 12).getTime())
    const html = m.render({ ...base, learn, selected: 'Share' })
    const t = text(html)
    assert.ok(html.includes('data-chapter-finished') && t.includes('Finished 6 Oct'))
    assert.ok(t.includes(`This chapter ${share.rows.length} of ${share.rows.length}`))
    assert.ok(html.includes('data-chapter-next') && t.includes('Next chapter: Manage talks'))
    const last = TASK_GROUPS.at(-1)
    const lastDone = withChapterFinished(withRan(byTask[last].rows.map((r) => r.ids[0])), last, 1)
    assert.ok(!m.render({ ...base, learn: lastDone, selected: last }).includes('data-chapter-next'), 'nothing after the last')
    assert.ok(!m.render({ ...base, learn: withRan(share.rows.slice(0, 2).map((r) => r.ids[0])), selected: 'Share' }).includes('data-chapter-finished'))
  })

  await test('render: the chords are the effective ones (a rebinding shows), and the ten icons are real lucide icons', () => {
    const rebound = m.render({ ...base, selected: 'Write the outline', chordOf: (id) => (id === 'editor.move-down' ? '⌥J' : chordOf(id)), flashId: 'editor.move-down' })
    assert.ok(rebound.includes('⌥J') && !rebound.includes('⌘⇧↓'))
    const list = m.render(base)
    assert.equal((list.match(/<svg[^>]*lucide/g) ?? []).length >= 10, true)
    const source = read('src/renderer/src/components/GuideChapters.tsx')
    for (const name of Object.values(CHAPTER_ICONS)) {
      const component = name.split('-').map((s) => s[0].toUpperCase() + s.slice(1)).join('')
      assert.ok(new RegExp(`\\b${component}\\b`).test(source), `${name} → ${component}`)
    }
  })

  console.log(`\n${passed} passed`)
} finally {
  rmSync(renderDir, { recursive: true, force: true })
  for (const name of readdirSync(REPO)) if (name.startsWith('.test-guide-chapters-')) rmSync(join(REPO, name), { recursive: true, force: true })
}
