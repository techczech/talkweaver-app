import { readFile } from 'node:fs/promises'
import { buildTree, rebaseTalk } from '../src/renderer/src/components/talkTreeNav.ts'
import { flattenSearch, flattenTree } from '../src/renderer/src/components/talklist/model.ts'

let fail = 0
const check = (condition, message) => {
  if (!condition) {
    console.error('FAIL:', message)
    fail += 1
  }
}
const equal = (actual, expected, message) =>
  check(JSON.stringify(actual) === JSON.stringify(expected), `${message} — got ${JSON.stringify(actual)}`)

let windowModel
try {
  windowModel = await import('../src/renderer/src/components/talklist/window.ts')
} catch (error) {
  console.error('FAIL: talk-list window model imports as a pure TypeScript module')
  console.error(String(error))
  process.exit(1)
}

const {
  buildLayout,
  heightOf,
  mergeRowHeights,
  mountedIndices,
  partitionGroups,
  scrollTargetFor,
  windowRange
} = windowModel

const heights = { ledger: 26, shelf: 55, fhead: 25 }
const vaultRoot = '/vault'
const talks = Array.from({ length: 500 }, (_, index) => {
  const folder = `folder-${index % 3}`
  const slug = `talk-${String(index).padStart(3, '0')}`
  return {
    slug,
    title: `Talk ${index}`,
    path: `${vaultRoot}/${folder}/${slug}`,
    outlinePath: `${vaultRoot}/${folder}/${slug}/${slug}-outline.md`
  }
})
const tree = buildTree(talks, ['folder-0', 'folder-1', 'folder-2'], vaultRoot)
const rows = flattenTree(tree, new Set())
const layout = buildLayout(rows, 'shelf', heights)

const expectedTotal = rows.reduce((sum, row) => sum + heightOf(row, 'shelf', heights), 0)
equal(layout.total, expectedTotal, 'layout total equals the sum of row heights')
check(layout.offsets.length === rows.length, 'layout has one offset per row')
check(layout.offsets.every((offset, index) => index === 0 || offset > layout.offsets[index - 1]),
  'layout offsets are strictly increasing')

for (const [scrollTop, viewportH] of [[0, 180], [830, 240], [layout.total - 210, 210]]) {
  const overscanPx = 10 * heights.shelf
  const range = windowRange(layout, scrollTop, viewportH, overscanPx)
  const paddedTop = Math.max(0, scrollTop - overscanPx)
  const paddedBottom = Math.min(layout.total, scrollTop + viewportH + overscanPx)
  rows.forEach((row, index) => {
    const top = layout.offsets[index]
    const bottom = top + heightOf(row, 'shelf', heights)
    const intersects = bottom > paddedTop && top < paddedBottom
    check(intersects === (index >= range.start && index < range.end),
      `window membership matches padded viewport at row ${index}`)
  })

  const mounted = mountedIndices(layout, range, new Set())
  for (const group of layout.groups) {
    const mountedInGroup = [...mounted]
      .filter((index) => index >= group.start && index < group.end)
      .sort((a, b) => a - b)
    const mountedHeight = mountedInGroup.reduce((sum, index) => sum + layout.heights[index], 0)
    let gapsHeight = 0
    let cursor = group.start
    for (const index of mountedInGroup) {
      for (; cursor < index; cursor += 1) gapsHeight += layout.heights[cursor]
      cursor = index + 1
    }
    for (; cursor < group.end; cursor += 1) gapsHeight += layout.heights[cursor]
    const groupHeight = layout.offsets[group.end - 1] + layout.heights[group.end - 1] - layout.offsets[group.start]
    equal(mountedHeight + gapsHeight, groupHeight, `spacer arithmetic preserves group ${group.start}`)
  }
}

const tinyRange = { start: 220, end: 230 }
const alwaysMounted = mountedIndices(layout, tinyRange, new Set())
for (const group of layout.groups) {
  if (group.headerIndex != null) check(alwaysMounted.has(group.headerIndex), `header ${group.headerIndex} is always mounted`)
}
const pinnedIndex = 45
check(mountedIndices(layout, tinyRange, new Set([pinnedIndex])).has(pinnedIndex),
  'pinned drag source stays mounted outside the window')

const firstGroup = layout.groups[0]
const descendant = firstGroup.headerIndex + 4
const descendantTop = layout.offsets[descendant]
const descendantHeight = layout.heights[descendant]
equal(scrollTargetFor(layout, descendant, descendantTop + 200, 300), descendantTop - heights.fhead,
  'row above viewport scrolls to just under its sticky header')
equal(scrollTargetFor(layout, descendant, 0, 100), descendantTop + descendantHeight - 100,
  'row below viewport bottom-aligns')
equal(scrollTargetFor(layout, descendant, descendantTop - heights.fhead, 300), null,
  'fully visible row needs no scroll')
equal(scrollTargetFor(layout, rows.length - 1, 0, 100), layout.total - 100,
  'scroll target clamps at the maximum scrollTop')
equal(scrollTargetFor(layout, firstGroup.headerIndex, 100, 100), 0,
  'scroll target clamps at zero')

const groups = partitionGroups(rows)
equal(groups.flatMap((group) => rows.slice(group.start, group.end)), rows,
  'group slices preserve the exact keyboard row sequence')

const searchRows = flattenSearch(talks.slice(0, 12))
const searchLayout = buildLayout(searchRows, 'ledger', heights)
equal(searchLayout.groups, [{ headerIndex: null, start: 0, end: searchRows.length }],
  'search mode is one headerless group')
equal(buildLayout([], 'ledger', heights).groups, [], 'empty vault has no render groups')

// Measurement folds into the current heights; an unchanged pass returns the SAME object, so
// the panel writes state only for a real change (ticket 09: an equal-but-new heights object on
// every render re-ran the scroll effect until React gave up).
const current = { ledger: 26, shelf: 55, fhead: 24, ledgerTwo: 36, shelfTwo: 69 }
const none = { ledger: undefined, shelf: undefined, fhead: undefined, ledgerTwo: undefined, shelfTwo: undefined }
check(mergeRowHeights(current, none) === current, 'no mounted samples keeps the current heights object')
check(mergeRowHeights(current, { ...none, ledger: 26, fhead: 24 }) === current, 'equal samples keep the current heights object')
check(mergeRowHeights(current, { ...none, shelf: 0 }) === current, 'a zero-height sample (not laid out) is ignored')
const measured = mergeRowHeights(current, { ...none, shelf: 57 })
check(measured !== current, 'a changed sample yields a new heights object')
equal(measured, { ...current, shelf: 57 }, 'only the measured kind changes')
check(mergeRowHeights(measured, { ...none, shelf: 57 }) === measured, 'measuring the same geometry again is a no-op')

const treeSource = await readFile(new URL('../src/renderer/src/components/talklist/Tree.tsx', import.meta.url), 'utf8')
check(/\brows\b/.test(treeSource) && /partitionGroups|layout\.groups/.test(treeSource),
  'Tree renders the shared rows array through the grouped window model')

// Ticket 08: after a folder rename the open talk is re-selected at its new path.
{
  const t = { name: 'held', title: 'Held', slug: 'held', path: '/v/topic/sub/held', outlinePath: '/v/topic/sub/held/held-outline.md' }
  equal(rebaseTalk(t, '/v/', 'topic', 'renamed'), { ...t, path: '/v/renamed/sub/held', outlinePath: '/v/renamed/sub/held/held-outline.md' },
    'a talk nested inside the renamed folder moves under its new name')
  equal(rebaseTalk(t, '/v', 'topic/sub', 'topic/other'), { ...t, path: '/v/topic/other/held', outlinePath: '/v/topic/other/held/held-outline.md' },
    'a renamed subfolder')
  equal(rebaseTalk(t, '/v', 'top', 'x'), null, 'a folder whose name is only a prefix does not hold the talk')
  equal(rebaseTalk(t, '/v', 'elsewhere', 'x'), null, 'a talk outside the folder is not moved')
}

if (fail) process.exit(1)
console.log('PASS: talk-list grouped window model')
