// Onboarding 0.38.1 ticket 03: ⌘K opens Actions here.
//   - the list function (place, registry and chord labels in, grouped rows out);
//   - the old ⌘K context menu's rows are still offered at the matching place, for the editor's slide
//     places, the strip, a talk row, a folder row and a vault row;
//   - the filter, the no-match text and the hand-over to the palette;
//   - the panel's render (rows, task-group headings, effective chords, "no key", All commands…).
// The keyboard behaviour in the real app is e2e/diagnose-actions-here.mjs.
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import {
  actionRowsAt, groupActionRows, filterActionRows, rowChordText, noMatchText, allCommandsHint, actionLabel,
  CARRIED_ROWS, MOVE_TO_PLACES, OLD_SLIDE_MENU_COMMANDS, SECTION_FOLD_COMMAND_IDS, SLIDE_MENU_PLACES, paletteChordText, UNIVERSAL_COMMAND_IDS
} from '../src/shared/actions-here.ts'
import { actionIconName, ROW_ICONS, GROUP_ICONS } from '../src/shared/actions-here-icons.ts'
import * as lucide from 'lucide-react'
import { actionsAt } from '../src/shared/place.ts'
import { PLACES } from '../src/shared/command-places.ts'
import { COMMAND_REGISTRY, MOVE_TO_COMMAND_IDS, QUOTE_FORM_COMMAND_IDS } from '../src/shared/command-registry.ts'
import { TASK_GROUPS } from '../src/shared/task-groups.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const results = []
const test = (name, fn) => { try { fn(); results.push([true, name]) } catch (error) { results.push([false, `${name}: ${error.message}`]) } }
const keys = (rows) => rows.map((row) => row.key)

// What the old ⌘K context menus offered, copied from SlideContextMenu.tsx and talklist/menus.tsx
// as they stood on origin/next/0.38.1 before this ticket, mapped to the id of the row that now
// carries them.
const OLD_SLIDE_MENU = {
  'Set layout…': 'layout', 'Insert icon…': 'icon-picker', 'Insert image from archive…': 'image', 'Tag slide…': 'tag-slide',
  'Insert table': 'insert-object-table', 'Insert mindmap': 'insert-object-mindmap', 'Insert chart': 'insert-object-chart',
  'Insert Mermaid diagram': 'insert-object-mermaid', 'Insert diagram': 'insert-object-diagram', 'Insert SVG': 'insert-object-svg',
  Bold: 'format-bold', Italic: 'format-italic', 'Inline code': 'format-inline-code', Highlight: 'format-highlight',
  Strikethrough: 'format-strikethrough', Underline: 'format-underline', Link: 'format-link',
  'Focus this slide': 'focus-slide', 'Where used & versions': 'where-used', 'Explain rendering': 'explain-rendering',
  'Present from here': 'present-from-here', 'Delete slide': 'delete-slide'
}
const OLD_TALK_MENU = {
  Open: 'browser.open-talk', 'Open in new window': 'open-in-new-window', 'Rename…': 'browser.rename', 'Move to folder…': 'browser.move-talk',
  'Duplicate…': 'browser.duplicate', 'Metadata…': 'talk.metadata', 'Reveal in Finder': 'talk.reveal', 'Open outline file': 'talk.open-file',
  'Copy file path': 'talk.copy-path', 'Move to Bin…': 'browser.delete-talk'
}
const OLD_FOLDER_MENU = {
  'Open in new window': 'open-in-new-window', 'New talk here…': 'new-talk', 'New subfolder…': 'new-folder',
  'Rename folder…': 'folder.rename', 'Delete folder…': 'folder.delete'
}
const OLD_VAULT_MENU = {
  'Edit this vault…': 'vault.edit', 'Show only this vault': 'vault.only', 'Reveal in Finder': 'vault.reveal', 'Close vault': 'vault.close'
}

test('every slide place keeps every row the old slide menu offered', () => {
  for (const place of SLIDE_MENU_PLACES) {
    const have = new Set(keys(actionRowsAt(place)))
    for (const [oldLabel, key] of Object.entries(OLD_SLIDE_MENU)) assert.ok(have.has(key), `${place} lost "${oldLabel}" (${key})`)
  }
})

test('universal editing basics (Cut, Copy, Paste, Undo, Redo, Select all) are offered at no place (owner check 10 Oct)', () => {
  for (const place of PLACES) {
    const contexts = place === 'talk' || place === 'vault' ? [{ row: 'talk' }, { row: 'folder' }, { row: 'vault' }] : [{}]
    for (const context of contexts) {
      const have = keys(actionRowsAt(place, context))
      for (const key of UNIVERSAL_COMMAND_IDS) assert.ok(!have.includes(key), `${place} still offers ${key}`)
    }
  }
  assert.ok(!CARRIED_ROWS.some((row) => UNIVERSAL_COMMAND_IDS.has(row.id)), 'no carried row is a universal action')
  // the filter also drops one that a registry declared by place
  const extra = { ...COMMAND_REGISTRY.find((command) => command.id === 'layout'), id: 'copy', label: 'Copy' }
  assert.ok(!keys(actionRowsAt('slide-heading', {}, [...COMMAND_REGISTRY, extra])).includes('copy'))
})

test('the strip keeps Explain rendering', () => {
  assert.ok(keys(actionRowsAt('strip-slide')).includes('explain-rendering'))
})

test('a talk row, a folder row and a vault row keep the old row menus', () => {
  const talk = new Set(keys(actionRowsAt('talk', { row: 'talk' })))
  for (const [label, key] of Object.entries(OLD_TALK_MENU)) assert.ok(talk.has(key), `talk lost "${label}" (${key})`)
  const folder = new Set(keys(actionRowsAt('vault', { row: 'folder' })))
  for (const [label, key] of Object.entries(OLD_FOLDER_MENU)) assert.ok(folder.has(key), `folder lost "${label}" (${key})`)
  const vault = new Set(keys(actionRowsAt('vault', { row: 'vault' })))
  for (const [label, key] of Object.entries(OLD_VAULT_MENU)) assert.ok(vault.has(key), `vault lost "${label}" (${key})`)
  // The vault menu's other states: a closed vault offers Open vault, an unavailable one only Close vault.
  assert.deepEqual(keys(actionRowsAt('vault', { row: 'vault', vault: 'closed' })), ['vault.open'])
  assert.deepEqual(keys(actionRowsAt('vault', { row: 'vault', vault: 'unavailable' })), ['vault.close'])
  // A folder row has no vault rows and a vault row has no folder rows.
  assert.ok(!folder.has('vault.edit') && !vault.has('folder.rename'))
})

test('the drawn rows come first and in the drawn order, inside each task group', () => {
  for (const place of PLACES) {
    const drawn = actionsAt(place).map((command) => command.id)
    const rows = actionRowsAt(place, place === 'vault' ? { row: 'vault' } : {})
    assert.deepEqual(rows.filter((row) => !row.carried).map((row) => row.key), drawn, place)
    for (const group of groupActionRows(rows)) {
      const flags = group.rows.map((row) => row.carried)
      assert.deepEqual(flags, [...flags].sort((a, b) => Number(a) - Number(b)), `${place} / ${group.taskGroup}`)
    }
  }
})

test('rows are grouped in task-group order and each group appears once', () => {
  for (const place of PLACES) {
    const groups = groupActionRows(actionRowsAt(place, place === 'vault' ? { row: 'vault' } : {})).map((group) => group.taskGroup)
    assert.equal(new Set(groups).size, groups.length, place)
    const order = groups.map((group) => TASK_GROUPS.indexOf(group))
    assert.ok(order.every((index) => index >= 0), place)
    assert.deepEqual(order, [...order].sort((a, b) => a - b), place)
  }
})

test('every row is a registry command or a carried row, and no row repeats', () => {
  const ids = new Set(COMMAND_REGISTRY.map((command) => command.id))
  const carried = new Set(CARRIED_ROWS.map((row) => row.id))
  assert.equal(carried.size, CARRIED_ROWS.length)
  for (const id of OLD_SLIDE_MENU_COMMANDS) assert.ok(ids.has(id), id)
  for (const place of PLACES) {
    const rows = actionRowsAt(place, place === 'vault' ? { row: 'vault' } : {})
    assert.equal(new Set(keys(rows)).size, rows.length, `${place} repeats a row`)
    for (const row of rows) assert.ok(row.commandId ? ids.has(row.commandId) : carried.has(row.key), `${place} ${row.key}`)
  }
})

test('a carried row with no registry command has a handler in WorkspaceLayout or TalkList', () => {
  const layout = readFileSync(join(root, 'src/renderer/src/components/WorkspaceLayout.tsx'), 'utf8')
  const list = readFileSync(join(root, 'src/renderer/src/components/talklist/TalkList.tsx'), 'utf8')
  for (const row of CARRIED_ROWS) {
    const handled = row.places.every((place) => ['talk', 'vault'].includes(place))
      ? list.includes(`'${row.id}'`)
      : layout.includes(`case '${row.id}'`)
    assert.ok(handled, `${row.id} has no handler`)
  }
})

// Fix round after preview.10: ⌘K with the keyboard in the Slide outline did nothing. The handler lives
// in WorkspaceLayout's window keydown listener, which no test mounts: this reads that the branch is
// there, takes the outline's selected row, and opens the panel for a slide (the strip-slide rows).
test('⌘K in the Slide outline opens Actions here for the selected row', () => {
  const layout = readFileSync(join(root, 'src/renderer/src/components/WorkspaceLayout.tsx'), 'utf8')
  const at = layout.indexOf("active.closest('[data-slides-organizer]')) {")
  assert.ok(at > 0, 'the outline branch of the ⌘K handler')
  const branch = layout.slice(at, layout.indexOf('// The strip or the grid: Actions here for the selected slide.', at))
  assert.ok(branch.length > 0 && branch.length < 1600)
  assert.ok(branch.includes('getOutlineSelection()'), 'for the row selected in the outline')
  assert.ok(branch.includes('selectSlideRef.current(index)'), 'whose slide becomes the selected slide')
  assert.ok(branch.includes("openActionsHereRef.current({ region: 'strip', at })"), 'opened at the row')
  // The rows it shows there are a slide's, with the whole-slide and all-sections actions among them.
  const have = keys(actionRowsAt('strip-slide'))
  for (const id of ['move-slide-to', 'move-section-to', 'slide-cut', 'slide-copy', 'slide-paste-after', 'outline-collapse-all', 'outline-expand-all']) assert.ok(have.includes(id), id)
})

test('the old rows are not duplicated by their registry twin (Present from here shows once)', () => {
  const rows = actionRowsAt('slide-heading')
  assert.equal(rows.filter((row) => row.label === 'Present from here').length, 1)
  assert.equal(rows.filter((row) => row.label === 'Explain rendering').length, 1)
})

test('labels drop a trailing explanation in brackets', () => {
  assert.equal(actionLabel('Focus on this slide (scoped editing + live preview)'), 'Focus on this slide')
  assert.equal(actionLabel('Tag current slide… (curated labels, shared vault-wide)'), 'Tag current slide…')
  assert.equal(actionLabel('Slide: where used & versions'), 'Slide: where used & versions')
  const heading = actionRowsAt('slide-heading')
  assert.ok(heading.every((row) => !/\)$/.test(row.label) || !/\(/.test(row.label)), 'a bracketed explanation is left in a label')
})

test('effective chords: a rebound chord shows, no chord shows "no key"', () => {
  const rows = actionRowsAt('slide-heading')
  const layout = rows.find((row) => row.key === 'layout')
  assert.equal(rowChordText(layout, (id) => (id === layout.shortcutId ? '⌘⌥L' : '')), '⌘⌥L')
  assert.equal(rowChordText(layout, () => 'no default'), 'no key')
  assert.equal(rowChordText(layout, () => ''), 'no key')
  const tag = rows.find((row) => row.key === 'tag-slide')
  assert.equal(tag.shortcutId, null)
  assert.equal(rowChordText(tag, () => '⌘T'), 'no key')
  const presentHere = rows.find((row) => row.key === 'present-from-here')
  assert.equal(rowChordText(presentHere, (id) => (id === 'app.present-current' ? '⇧F5' : '')), '⇧F5')
})

test('every row at every place has a real lucide icon', () => {
  const seen = new Set()
  for (const place of PLACES) {
    const contexts = place === 'talk' || place === 'vault'
      ? [{ row: 'talk' }, { row: 'folder' }, ...['open', 'closed', 'unavailable'].map((vault) => ({ row: 'vault', vault }))]
      : [{}]
    for (const context of contexts) for (const row of actionRowsAt(place, context)) {
      seen.add(row.key)
      const name = actionIconName(row.key, row.taskGroup)
      assert.ok(typeof lucide[name] === 'object' || typeof lucide[name] === 'function', `${row.key} icon ${name} is not exported by lucide-react`)
      assert.ok(ROW_ICONS[row.key], `${row.key} has no icon of its own (it would take its group's)`)
    }
  }
  for (const name of [...Object.values(ROW_ICONS), ...Object.values(GROUP_ICONS)]) assert.ok(lucide[name], `${name} is not a lucide icon`)
  for (const key of Object.keys(ROW_ICONS)) assert.ok(seen.has(key), `${key} has an icon but no place offers it`)
})

test('the filter: every word must match the label, a keyword or the task group', () => {
  const rows = actionRowsAt('slide-heading')
  assert.deepEqual(keys(filterActionRows(rows, '')), keys(rows))
  assert.ok(keys(filterActionRows(rows, 'bold')).includes('format-bold'))
  assert.ok(keys(filterActionRows(rows, 'focus')).includes('focus-slide'))
  assert.deepEqual(keys(filterActionRows(rows, 'reuse tag')), ['tag-slide'])
  assert.deepEqual(filterActionRows(rows, 'publish'), [])
  assert.deepEqual(filterActionRows(rows, 'zzzz nothing'), [])
})

test('the palette chord reads as drawn, ⇧⌘P, unless it is rebound', () => {
  assert.equal(paletteChordText('⌘⇧P'), '⇧⌘P')
  assert.equal(paletteChordText('⌘⌥P'), '⌘⌥P')
})

test('no match: the drawn words, with the typed text kept for the palette', () => {
  assert.equal(noMatchText('publish'), 'No “publish” action here')
  assert.equal(allCommandsHint('publish'), 'Return opens the palette with “publish” kept')
  assert.equal(noMatchText('  publish '), 'No “publish” action here')
})

test('the count is the list: groups hold exactly the rows', () => {
  for (const place of PLACES) {
    const rows = actionRowsAt(place, place === 'vault' ? { row: 'vault' } : {})
    assert.equal(groupActionRows(rows).reduce((sum, group) => sum + group.rows.length, 0), rows.length, place)
  }
})

test('removing a carried entry removes its row (the data is the whole list)', () => {
  const before = actionRowsAt('slide-heading').length
  const slideRows = CARRIED_ROWS.filter((row) => row.places.includes('slide-heading')).length
  const carriedCommands = OLD_SLIDE_MENU_COMMANDS.filter((id) => !actionsAt('slide-heading').some((command) => command.id === id)).length
  // Plus the rows every slide place carries beside the drawn ones: Move slide to…, Move section to…,
  // Collapse all sections and Expand all sections.
  assert.equal(before, actionsAt('slide-heading').length + slideRows + carriedCommands + MOVE_TO_COMMAND_IDS.length + SECTION_FOLD_COMMAND_IDS.length)
})

// Fix round after preview.10: typing these names in Actions here found nothing but All commands….
test('typing finds the whole-slide and all-sections actions on a slide and on a row or card of the outline, strip or grid', () => {
  const want = {
    'Collapse all sections': 'outline-collapse-all', 'Expand all sections': 'outline-expand-all',
    'Cut slide': 'slide-cut', 'Copy slide': 'slide-copy', 'Paste slide after': 'slide-paste-after',
    'Move slide to…': 'move-slide-to', 'Move section to…': 'move-section-to'
  }
  assert.deepEqual([...MOVE_TO_PLACES].sort(), [...SLIDE_MENU_PLACES, 'strip-slide'].sort(), 'every slide place of the editor, and a row or card (strip-slide)')
  for (const place of MOVE_TO_PLACES) {
    const rows = actionRowsAt(place)
    for (const [label, key] of Object.entries(want)) {
      for (const query of [label, label.toLowerCase(), label.replace('…', '')]) {
        const found = filterActionRows(rows, query)
        assert.ok(found.some((row) => row.key === key && row.label === label), `${place}: "${query}" finds ${label}`)
      }
      // The first match is the row itself, so Return runs it. (Move section to… comes second: Move
      // slide to… has "section" among its keywords and is listed before it.)
      if (key !== 'move-section-to') assert.equal(filterActionRows(rows, label)[0].key, key, `${place}: "${label}" lists it first`)
    }
    // What the tester typed: one word.
    assert.deepEqual(keys(filterActionRows(rows, 'cut')), ['slide-cut'], `${place}: "cut"`)
    assert.deepEqual(keys(filterActionRows(rows, 'copy')), ['slide-copy'], `${place}: "copy"`)
    assert.deepEqual(keys(filterActionRows(rows, 'paste')), ['slide-paste-after'], `${place}: "paste"`)
  }
  // The universal text Cut, Copy and Paste stay out, and the drawn table gained no row.
  for (const place of PLACES) {
    const drawn = actionsAt(place).map((command) => command.id)
    for (const id of [...Object.values(want)]) assert.ok(!drawn.includes(id), `${place}: ${id} is not a drawn row`)
  }
  for (const place of ['talk-title', 'metadata', 'talk', 'vault']) {
    const have = keys(actionRowsAt(place, { row: 'talk' }))
    for (const id of Object.values(want)) assert.ok(!have.includes(id), `${place}: ${id} is not offered away from a slide`)
  }
  // Each whole-slide row has its own icon and its handler (the handler check above reads WorkspaceLayout).
  for (const id of ['slide-cut', 'slide-copy', 'slide-paste-after', 'outline-collapse-all', 'outline-expand-all']) assert.ok(ROW_ICONS[id], id)
})

test('the seven Quote form commands are offered on a quote slide only', () => {
  assert.equal(QUOTE_FORM_COMMAND_IDS.length, 7)
  for (const place of ['slide-heading', 'layout-line', 'slide-text', 'list', 'quotation', 'strip-slide']) {
    const on = keys(actionRowsAt(place, { quoteSlide: true }))
    assert.deepEqual(QUOTE_FORM_COMMAND_IDS.filter((id) => !on.includes(id)), [], `${place}: all seven on a quote slide`)
    for (const context of [{}, { quoteSlide: false }]) {
      const off = keys(actionRowsAt(place, context))
      assert.deepEqual(QUOTE_FORM_COMMAND_IDS.filter((id) => off.includes(id)), [], `${place}: none on another slide`)
    }
  }
  for (const place of ['talk-title', 'metadata', 'talk', 'vault']) {
    assert.deepEqual(keys(actionRowsAt(place, { quoteSlide: true, row: 'talk' })).filter((id) => QUOTE_FORM_COMMAND_IDS.includes(id)), [], `${place}: never`)
  }
})

test('typing a Quote form name narrows to that form; the shared words list all seven', () => {
  const rows = actionRowsAt('slide-heading', { quoteSlide: true })
  const idOf = { Automatic: 'auto', Plain: 'plain', Tweet: 'tweet', Video: 'video', Book: 'book', Paper: 'paper', Web: 'web' }
  for (const [name, id] of Object.entries(idOf)) {
    for (const query of [name, name.toLowerCase(), `Quote form: ${name}`]) {
      assert.deepEqual(keys(filterActionRows(rows, query)).filter((key) => QUOTE_FORM_COMMAND_IDS.includes(key)), [`quote-form-${id}`], `"${query}" lists its own form only, so Return runs it`)
    }
  }
  assert.equal(keys(filterActionRows(rows, 'quote form')).filter((key) => QUOTE_FORM_COMMAND_IDS.includes(key)).length, 7)
})

// ── the panel's render ─────────────────────────────────────────────────────────
const bundleDir = mkdtempSync(join(root, '.test-actions-here-'))
try {
  const bundle = join(bundleDir, 'bundle.mjs')
  await build({
    stdin: {
      contents: [
        "import React from 'react'",
        "import { renderToStaticMarkup } from 'react-dom/server'",
        "import ActionsHerePanel from './src/renderer/src/components/ActionsHerePanel.tsx'",
        "import { actionRowsAt } from './src/shared/actions-here.ts'",
        "const noop = () => {}",
        "export const panel = (place, chordOf, context) => renderToStaticMarkup(React.createElement(ActionsHerePanel, { x: 100, y: 100, rows: actionRowsAt(place, context), chordOf, paletteChord: '⇧⌘P', onRun: noop, onAllCommands: noop, onClose: noop }))"
      ].join('\n'),
      resolveDir: root,
      sourcefile: 'test-actions-here-entry.tsx'
    },
    bundle: true, format: 'esm', platform: 'node', jsx: 'automatic',
    external: ['react', 'react/*', 'react-dom', 'react-dom/*', 'lucide-react'],
    outfile: bundle, logLevel: 'silent'
  })
  const { panel } = await import(pathToFileURL(bundle).href)
  const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ')

  test('the panel: filter, count, task-group headings, rows with chords, All commands… ⇧⌘P last', () => {
    const rows = actionRowsAt('slide-heading')
    const html = panel('slide-heading', (id) => (id === 'app.layout-picker' ? '⌘⌥L' : id === 'app.image-search' ? 'no default' : '⌘1'))
    assert.match(html, /role="dialog"[^>]*aria-labelledby="actions-here-title"/)
    assert.match(html, /<div class="actions-here-title" id="actions-here-title"[^>]*>Actions here<\/div>/, 'the panel shows its name, "Actions here", at the top')
    assert.ok(html.indexOf('actions-here-title') < html.indexOf('actions-here-filter'), 'the name sits above the filter field')
    assert.match(html, /aria-label="Filter actions"/)
    assert.match(html, /placeholder="Filter actions"/)
    assert.match(html, new RegExp(`data-actions-here-count="true">${rows.length}<`))
    for (const group of groupActionRows(rows)) assert.ok(html.includes(`>${group.taskGroup}</div>`), group.taskGroup)
    assert.equal((html.match(/data-actions-here-row="/g) ?? []).length, rows.length)
    assert.ok(html.indexOf('data-actions-here-all') > html.lastIndexOf('data-actions-here-row="'), 'All commands… is the last row')
    assert.ok(text(html).includes('All commands… ⇧⌘P'))
    assert.equal((html.match(/data-actions-here-icon="/g) ?? []).length, rows.length + 1, 'every row and All commands… carries an icon')
    assert.ok(/data-actions-here-row="layout"[^>]*><span[^>]*data-actions-here-icon="LayoutTemplate"[^>]*><svg/.test(html), 'Layout… carries its lucide icon')
    assert.ok(/data-actions-here-row="layout"[^>]*>.*?⌘⌥L/.test(html), 'a rebound chord shows')
    assert.ok(/data-actions-here-row="image"[^>]*>.*?actions-here-chord--none">no key</.test(html), 'an unbound command shows "no key"')
    assert.ok(/data-actions-here-row="delete-slide"[^>]*actions-here-row--danger|actions-here-row--danger[^>]*data-actions-here-row="delete-slide"/.test(html), 'Delete is drawn as the dangerous row')
  })

  test('the panel on a talk row: the old row menu\'s rows, with the Talks panel chords', () => {
    const html = panel('talk', () => '⌘1', { row: 'talk' })
    for (const label of ['Metadata…', 'Reveal in Finder', 'Open outline file', 'Copy file path', 'Rename', 'Duplicate talk', 'Move talk to Bin']) {
      assert.ok(text(html).includes(label), label)
    }
  })
} finally {
  rmSync(bundleDir, { recursive: true, force: true })
}

for (const [pass, name] of results) console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`)
const failed = results.filter(([pass]) => !pass).length
console.log(`${results.length - failed}/${results.length} passed`)
if (failed) process.exit(1)
