import assert from 'node:assert/strict'
import { resolve } from 'node:path'
// VG_SRC points the same assertions at another source tree (used to prove they fail on the reviewed commit).
const src = resolve(import.meta.dirname, '..', process.env.VG_SRC ?? 'src')
const { folderPaths, treeNodes, browseRows, compareBy, shortLocation, crumbParts, formatBytes, formatBytesAtLeast, folderRole, inspectOnlyPath, readView, talkFolder, knownTalkCount, nextSort } = await import(src + '/shared/vault-gallery-browse.ts')
const t = (o, title = o) => ({ vaultId: 'v', relativeOutline: o, title, slug: 's' })
const talks = [
  t('root-talk/root-talk-outline.md'),
  t('agents/a/a-outline.md'), t('agents/b/b-outline.md'),
  t('ext/Day 1/x/x-outline.md'), t('ext/Day 1/x2/x2-outline.md'), t('ext/Day 2/y/y-outline.md'),
  t('ext/Day 1/x/x-outline.md', 'Duplicate leaf'),
]
assert.equal(talkFolder(talks[0]), '')
assert.equal(talkFolder(talks[3]), 'ext/Day 1')
const folders = folderPaths(talks, ['handout-data'])
assert.deepEqual(folders, ['agents', 'ext', 'ext/Day 1', 'ext/Day 2', 'handout-data'])
assert.equal(knownTalkCount(talks, 'ext'), 4)
assert.equal(knownTalkCount(talks, 'handout-data'), 0, 'empty registry folder stays at a known zero')
// direct contents, not recursive; recursive counts stay recursive
const root = browseRows(talks, folders, { kind: 'folder', path: '' }, '')
assert.deepEqual(root.folders.map(f => [f.name, f.count]), [['agents', 2], ['ext', 4], ['handout-data', 0]])
assert.deepEqual(root.talks.map(x => x.relativeOutline), ['root-talk/root-talk-outline.md'])
assert.equal(root.flat, false)
const ext = browseRows(talks, folders, { kind: 'folder', path: 'ext' }, '')
assert.deepEqual(ext.folders.map(f => f.path), ['ext/Day 1', 'ext/Day 2'])
assert.equal(ext.talks.length, 0)
// All talks is a separate, flat, recursive scope
const all = browseRows(talks, folders, { kind: 'all' }, '')
assert.equal(all.talks.length, 7); assert.equal(all.flat, true); assert.equal(all.folders.length, 0)
// search recurses from the current folder
const found = browseRows(talks, folders, { kind: 'folder', path: 'ext' }, 'day 1')
assert.equal(found.flat, true); assert.deepEqual(found.folders.map(f => f.path), ['ext/Day 1'])
// tree
const nodes = treeNodes(talks, folders, new Set())
assert.deepEqual(nodes.map(n => [n.name, n.count, n.hasChildren, n.expanded]), [['agents', 2, false, false], ['ext', 4, true, false], ['handout-data', 0, false, false]])
assert.deepEqual(treeNodes(talks, folders, new Set(['ext'])).map(n => n.path), ['agents', 'ext', 'ext/Day 1', 'ext/Day 2', 'handout-data'])
// unknown sorts last in both directions
const row = (name, size) => ({ name, location: '', facts: { slides: null, images: null, size, handouts: null, modified: null } })
for (const dir of ['asc', 'desc']) assert.deepEqual([row('a', null), row('b', 5), row('c', 9)].sort((x, y) => compareBy('size', dir, x, y)).map(r => r.name).at(-1), 'a')
assert.deepEqual(nextSort({ key: 'name', dir: 'asc' }, 'name'), { key: 'name', dir: 'desc' })
assert.equal(shortLocation('external-workshops/Day 1/x', 'V'), 'external-workshops / … / x')
assert.equal(shortLocation('', 'V'), 'V')
assert.deepEqual(crumbParts('a/b/c/d/e').map(c => c.label), ['a', '…', 'd', 'e'])
assert.equal(formatBytes(null), 'Unknown'); assert.equal(formatBytes(318e6), '318 MB'); assert.equal(formatBytes(3.8e6), '3.8 MB')
assert.equal(readView(null), 'List'); assert.equal(readView('garbage'), 'List'); assert.equal(readView('Gallery'), 'Gallery')
// unknown sorts last in both directions, checked on the order itself (not only on aria-sort)
const rows4 = [row('u', undefined), row('z', 0), row('n', null), row('a', 5)]
for (const dir of ['asc', 'desc']) { const order = [...rows4].sort((x, y) => compareBy('size', dir, x, y)).map(r => r.name); assert.deepEqual(order.slice(-2).sort(), ['n', 'u']); assert.equal(order[0], dir === 'asc' ? 'z' : 'a') }
// unit rollover and honest lower bounds
assert.equal(formatBytes(999999), '1 MB'); assert.equal(formatBytes(999), '999 B'); assert.equal(formatBytes(0), '0 B')
assert.equal(formatBytesAtLeast(462_900_000), '≥ 462 MB', 'a lower bound rounds down')
assert.equal(formatBytesAtLeast(999_999), '≥ 999 KB'); assert.equal(formatBytesAtLeast(1_999_000), '≥ 1.9 MB')
assert.equal(shortLocation('ext/Day 1', 'V'), 'ext / Day 1')
// folders the browser never manages, by name, whatever the registry says
assert.deepEqual(['assets', '_assets', 'Assets', '_PRESENTATIONS', '.git', 'Research', 'research/x', 'node_modules', 'agents', 'my-assets'].map(folderRole), ['assets', 'assets', 'assets', 'system', 'system', 'research', 'research', 'system', 'ordinary', 'ordinary'])
assert.equal(inspectOnlyPath('Work/assets/deep'), true); assert.equal(inspectOnlyPath('Work/deep'), false); assert.equal(inspectOnlyPath(''), false)
console.log('PASS browse model: direct contents, recursive known counts, All talks scope, search recursion, tree, unknown-last sort, remembered view fallback')
