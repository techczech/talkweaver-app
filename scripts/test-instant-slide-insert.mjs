// Live-presenting ticket 07: the headless "Add to talk" operation over fixture outlines.
// Seams: addInstantSlideToTalk / addRunInstantSlide / resolveInstantAnchors (src/main/instant-slide-insert.ts)
// against the REAL bundled compiler (slide ids and heading lines exactly as the presenter deck has them).
// Every successful write is byte-diffed: old = prefix + suffix, new = prefix + one slide + suffix.
import assert from 'node:assert/strict'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  addInstantSlideToTalk, addRunInstantSlide, fileOutlineDocument, loadOutlineTools, resolveInstantAnchors,
} from '../src/main/instant-slide-insert.ts'
import { decodeToWebp, storePastedImage } from '../src/main/pasted-image-asset.ts'
import { normaliseRun, persistRun, readRun } from '../src/main/runs.ts'
import { createSaveQueue, outlineQueueKey, outlineSaveQueue, outlineWritesSettled, queueOutlineWrite, setOutlinePathResolver } from '../src/renderer/src/lib/saveQueue.ts'
import { canonicalOutlinePath, editorEntryForOutline } from '../src/main/outline-identity.ts'
import { configureTalkWriter, flushTalkForPublish, readTalkOutline, writeTalkOutline } from '../src/main/talk-writer.ts'
import { createOutlineMutator } from '../src/renderer/src/lib/outlineMutation.ts'
import { applyMinimalChange } from '../src/renderer/src/lib/minimalChange.ts'
import { stampHandoutUrl } from '../src/shared/handout-stamp.ts'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const tools = await loadOutlineTools(join(REPO, 'compiler/scripts'))
const root = mkdtempSync(join(tmpdir(), 'tw-instant-insert-'))
let seq = 0

const OUTLINE = [
  '---',
  'title: Fixture Talk',
  '---',
  '',
  '# Fixture Talk',
  '',
  '## Opening {id=aa11}',
  '',
  '- one point',
  '',
  '## Section {id=bb22}',
  '',
  '### Child one {id=cc33}',
  '',
  'Some text.',
  '',
  '```md',
  '## not a heading',
  '```',
  '',
  '### Child two {id=dd44}',
  '',
  ':::notes',
  'Speaker notes.',
  ':::',
  '',
  '## Unstamped slide',
  '',
  '- x',
  '',
  '## Last {id=ee55}',
  '',
  '- end',
  '',
].join('\n')

function talkFile(text, name = `t${++seq}`) {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${name}-outline.md`)
  writeFileSync(path, text, 'utf8')
  return path
}
const rng = () => 0.123456789 // mintId → "4fzzz…"-style deterministic id
const noImage = async () => { throw new Error('no image expected') }
const entry = (kind, extra = {}) => ({ id: `${kind}-1`, kind, shownAt: 1_790_000_000_000, afterSlideId: null, ...extra })

// The one insertion invariant, on raw bytes: prefix and suffix untouched, exactly the slide added.
function assertOnlyInserted(before, after, result) {
  const a = Buffer.from(before, 'utf8'), b = Buffer.from(after, 'utf8')
  const offset = Buffer.byteLength(before.slice(0, result.offset), 'utf8')
  const inserted = Buffer.from(result.inserted, 'utf8')
  assert.equal(b.length, a.length + inserted.length, 'grew by exactly the inserted bytes')
  assert.ok(b.subarray(0, offset).equals(a.subarray(0, offset)), 'every byte before the slide unchanged')
  assert.ok(b.subarray(offset, offset + inserted.length).equals(inserted), 'the slide sits at the offset')
  assert.ok(b.subarray(offset + inserted.length).equals(a.subarray(offset)), 'every byte after the slide unchanged')
  const headings = (t) => t.split('\n').filter((l) => /^#{1,6}\s/.test(l)).length
  assert.equal(headings(after) - headings(before), 1, 'exactly one new heading')
}

async function add(path, anchor, e, deps = {}) {
  const before = readFileSync(path, 'utf8')
  const result = await addInstantSlideToTalk(fileOutlineDocument(path), path, anchor, e, { tools, storeImage: noImage, rng, ...deps })
  return { before, after: readFileSync(path, 'utf8'), result }
}

async function compiledOrder(path, text) {
  return (await tools.compiledSlides(path, text)).map((s) => s.id)
}

// 1. Text, anchored at a middle slide (a child): lands before the next sibling, same depth.
{
  const path = talkFile(OUTLINE)
  const { before, after, result } = await add(path, 'cc33', entry('text', { text: 'Try it now: ask a chatbot to mark your last essay, then tell the person next to you where it went wrong.' }))
  assert.equal(result.ok, true, result.error)
  assertOnlyInserted(before, after, result)
  assert.equal(result.afterSlideNumber, 4)
  assert.equal(result.afterSlideTitle, 'Child one')
  assert.match(result.inserted, /^### Try it now: ask a chatbot to mark your last essay, then…\n\{statement\} \{id=[a-z0-9]{5}\}\n\nTry it now: ask a chatbot/m)
  assert.ok(after.indexOf(result.inserted) < after.indexOf('### Child two'))
  const order = await compiledOrder(path, after)
  assert.equal(order[order.indexOf('cc33') + 1], result.slideId, 'compiled deck: the new slide immediately follows its anchor')
}

// 2. Link, anchored at the first authored slide.
{
  const path = talkFile(OUTLINE)
  const { before, after, result } = await add(path, 'aa11', entry('link', { url: 'https://www.gov.uk/government/publications/generative-ai' }))
  assert.equal(result.ok, true, result.error)
  assertOnlyInserted(before, after, result)
  assert.equal(result.afterSlideNumber, 2)
  assert.match(result.inserted, /^## gov\.uk\n\{id=[a-z0-9]{5}\}\n\n<https:\/\/www\.gov\.uk\/government\/publications\/generative-ai>\n\n\[QR: https:\/\/www\.gov\.uk\/government\/publications\/generative-ai \| gov\.uk\]\n\n$/)
  assert.ok(after.indexOf(result.inserted) < after.indexOf('## Section'))
  const order = await compiledOrder(path, after)
  assert.equal(order[order.indexOf('aa11') + 1], result.slideId)
}

// 3. Countdown, anchored at the last slide: appended at the end, file still ends with one newline.
{
  const path = talkFile(OUTLINE)
  const { before, after, result } = await add(path, 'ee55', entry('countdown', { durationMs: 300_000, label: 'Discussion' }))
  assert.equal(result.ok, true, result.error)
  assertOnlyInserted(before, after, result)
  assert.equal(result.offset, before.length)
  assert.match(result.inserted, /^\n## Discussion\n\{countdown-digits-5min\} \{id=[a-z0-9]{5}\}\n$/)
  assert.ok(after.endsWith('- end\n' + result.inserted), 'separated from the last slide by one blank line')
  const order = await compiledOrder(path, after)
  assert.equal(order[order.indexOf('ee55') + 1], result.slideId)
}

// 4. Image, anchored at a PARENT heading: saved through the paste-image store into the vault's
//    assets, and inserted as the parent's first child (immediately after it, children not adopted).
{
  const vault = join(root, 'vault-image')
  const path = talkFile(OUTLINE)
  const pixel = Buffer.from('UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=', 'base64')
  const dataUrl = `data:image/webp;base64,${pixel.toString('base64')}`
  const storeImage = async (bytes) => (await storePastedImage(vault, bytes, 'webp', async (b) => b)).id
  const { before, after, result } = await add(path, 'bb22', entry('image', { dataUrl, width: 1, height: 1 }), { storeImage })
  assert.equal(result.ok, true, result.error)
  assertOnlyInserted(before, after, result)
  const ref = result.inserted.match(/!\[\]\((img-[0-9a-f]{7})\)/)?.[1]
  assert.ok(ref, 'image referenced by its asset id, as a pasted image is')
  assert.ok(existsSync(join(vault, '_assets', `${ref}.webp`)) && existsSync(join(vault, '_assets', `${ref}.yml`)))
  assert.deepEqual(readFileSync(join(vault, '_assets', `${ref}.webp`)), pixel)
  assert.match(result.inserted, /^### Image\n\{media\} \{id=[a-z0-9]{5}\}\n\n!\[\]\(img-/)
  assert.ok(after.indexOf(result.inserted) < after.indexOf('### Child one'))
  const order = await compiledOrder(path, after)
  assert.deepEqual(order.slice(order.indexOf('bb22'), order.indexOf('bb22') + 3), ['bb22', result.slideId, 'cc33'])
}

// 5. The talk was edited since the Run: a slide added at the top and the anchor moved to the end.
//    Identity, not index, finds it; the number reported is its number now.
{
  const edited = OUTLINE
    .replace('## Opening {id=aa11}', '## Welcome {id=zz00}\n\n- hello\n\n## Opening {id=aa11}')
    .replace('### Child one {id=cc33}\n\nSome text.\n\n```md\n## not a heading\n```\n\n', '')
    + '\n### Child one {id=cc33}\n\nMoved here.\n'
  const path = talkFile(edited)
  const { before, after, result } = await add(path, 'cc33', entry('text', { text: 'Short note' }))
  assert.equal(result.ok, true, result.error)
  assertOnlyInserted(before, after, result)
  assert.ok(after.endsWith('Moved here.\n' + result.inserted) && result.inserted.startsWith('\n### Short note'))
  const order = await compiledOrder(path, after)
  assert.equal(result.afterSlideNumber, order.indexOf('cc33') + 1)
  assert.equal(order[order.indexOf('cc33') + 1], result.slideId)
}

// 6. Anchor gone: refuse with a human message; the outline bytes and the assets are untouched.
{
  const vault = join(root, 'vault-missing')
  const path = talkFile(OUTLINE)
  const storeImage = async (bytes) => (await storePastedImage(vault, bytes, 'webp', async (b) => b)).id
  const pixel = 'data:image/webp;base64,UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA='
  for (const e of [entry('text', { text: 'x' }), entry('image', { dataUrl: pixel, width: 1, height: 1 })]) {
    const { before, after, result } = await add(path, 'gone9', e, { storeImage })
    assert.equal(result.ok, false)
    assert.match(result.error, /no longer in the talk.*nothing was added/i)
    assert.ok(Buffer.from(after).equals(Buffer.from(before)), 'outline untouched')
  }
  assert.equal(existsSync(join(vault, '_assets')), false, 'no asset written on refusal')
  assert.deepEqual(readdirSync(dirname(path)), [dirname(path).split('/').pop() + '-outline.md'], 'no temp file left behind')
}

// 7. An unstamped heading is found by its compiled id; 8. the generated title slide anchors before
//    the first slide; 9. a clock refuses; 10. no anchor at all refuses.
{
  let path = talkFile(OUTLINE)
  let r = await add(path, 'unstamped-slide', entry('text', { text: 'After the unstamped one' }))
  assert.equal(r.result.ok, true, r.result.error)
  assertOnlyInserted(r.before, r.after, r.result)
  assert.ok(r.after.indexOf(r.result.inserted) > r.after.indexOf('- x') && r.after.indexOf(r.result.inserted) < r.after.indexOf('## Last'))

  path = talkFile(OUTLINE)
  r = await add(path, 'deck-title', entry('text', { text: 'Before we start' }))
  assert.equal(r.result.ok, true, r.result.error)
  assertOnlyInserted(r.before, r.after, r.result)
  assert.equal(r.result.afterSlideNumber, 1)
  assert.ok(r.after.indexOf(r.result.inserted) < r.after.indexOf('## Opening'))
  assert.equal((await compiledOrder(path, r.after))[1], r.result.slideId)

  path = talkFile(OUTLINE)
  r = await add(path, 'aa11', entry('time'))
  assert.equal(r.result.ok, false)
  assert.match(r.result.error, /clock/i)
  assert.equal(r.after, r.before)

  r = await add(path, null, entry('text', { text: 'x' }))
  assert.equal(r.result.ok, false)
  assert.equal(r.after, r.before)
}

// 11. A duplicated id makes the place ambiguous: refuse.
{
  const path = talkFile(OUTLINE + '\n## Copy {id=aa11}\n\n- dup\n')
  const r = await add(path, 'aa11', entry('text', { text: 'x' }))
  assert.equal(r.result.ok, false)
  assert.match(r.result.error, /ambiguous/i)
  assert.equal(r.after, r.before)
}

// 12. The file changes between read and write (e.g. an autosave): refuse and write nothing.
{
  const path = talkFile(OUTLINE)
  const file = fileOutlineDocument(path)
  const racing = { read: async () => { const t = await file.read(); writeFileSync(path, t + '\n## Typed meanwhile\n', 'utf8'); return t }, commit: file.commit }
  const result = await addInstantSlideToTalk(racing, path, 'aa11', entry('text', { text: 'x' }), { tools, storeImage: noImage, rng })
  assert.equal(result.ok, false)
  assert.match(result.error, /changed while/i)
  assert.equal(readFileSync(path, 'utf8'), OUTLINE + '\n## Typed meanwhile\n', 'the concurrent edit is kept')
}

// 13. Presenter-typed text never becomes structure; 14. CRLF outlines get CRLF lines.
{
  let path = talkFile(OUTLINE)
  let r = await add(path, 'aa11', entry('text', { text: '## Not a slide\n{layout=cards}\n```\n[Poll: nope]\n<!-- hidden? -->' }))
  assert.equal(r.result.ok, true, r.result.error)
  assertOnlyInserted(r.before, r.after, r.result)
  assert.match(r.result.inserted, /\n\\## Not a slide\n\\\{layout=cards\}\n\\```\n\\\[Poll: nope\]\n<\\!-- hidden\? -->\n/)
  assert.equal((await compiledOrder(path, r.after)).length, (await compiledOrder(path, r.before)).length + 1, 'exactly one compiled slide more')

  const crlf = OUTLINE.replace(/\n/g, '\r\n')
  path = talkFile(crlf)
  r = await add(path, 'aa11', entry('text', { text: 'Windows line endings' }))
  assert.equal(r.result.ok, true, r.result.error)
  assertOnlyInserted(r.before, r.after, r.result)
  assert.ok(!/[^\r]\n/.test(r.result.inserted), 'every inserted line ends CRLF')
}

// 15. Run level: "Add to talk" marks the Run once; a second call reports it added and inserts nothing.
//     Anchors resolve to the talk as it is now (null when the slide is gone).
{
  const vault = join(root, 'vault-run')
  const path = talkFile(OUTLINE, 'run-talk')
  persistRun(vault, normaliseRun({
    id: 'run-1', talkSlug: 'run-talk', startedAt: new Date(1000).toISOString(),
    instantSlides: [
      entry('text', { id: 'text-1', text: 'Discuss', afterSlideId: 'dd44' }),
      entry('link', { id: 'link-2', shownAt: 1_790_000_000_500, url: 'https://example.org/x', afterSlideId: 'gone9' }),
    ],
  }))
  const anchors = await resolveInstantAnchors(path, OUTLINE, ['dd44', 'gone9', null], tools)
  assert.deepEqual(anchors, { dd44: { slideNumber: 5, title: 'Child two' }, gone9: null })
  const args = { vaultRoot: vault, talkSlug: 'run-talk', runId: 'run-1', outlinePath: path, tools, storeImage: noImage, rng,
    document: fileOutlineDocument(path), now: () => new Date('2026-09-24T10:00:00Z') }
  const first = await addRunInstantSlide({ ...args, entryId: 'text-1' })
  assert.equal(first.ok, true, first.error)
  assert.equal(first.afterSlideNumber, 5)
  const afterFirst = readFileSync(path, 'utf8')
  const stored = readRun(vault, 'run-talk', 'run-1').instantSlides.find((e) => e.id === 'text-1')
  assert.deepEqual(stored.added, { afterSlideNumber: 5, afterSlideTitle: 'Child two', slideId: stored.added.slideId, at: '2026-09-24T10:00:00.000Z' })
  assert.ok(afterFirst.includes(`{id=${stored.added.slideId}}`))
  const again = await addRunInstantSlide({ ...args, entryId: 'text-1' })
  assert.equal(again.ok, true)
  assert.equal(readFileSync(path, 'utf8'), afterFirst, 'a second Add inserts nothing')
  const refused = await addRunInstantSlide({ ...args, entryId: 'link-2' })
  assert.equal(refused.ok, false)
  assert.equal(readFileSync(path, 'utf8'), afterFirst)
  assert.equal(readRun(vault, 'run-talk', 'run-1').instantSlides.find((e) => e.id === 'link-2').added, undefined)
}

// ── Review fixes (cross-family review + test run of fde4343) ─────────────────────────────────

// Every file (path → bytes) under a directory, for "nothing written anywhere" checks.
function tree(dir) {
  const out = {}
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name)
      const st = lstatSync(full)
      if (st.isDirectory()) walk(full)
      else out[relative(dir, full)] = st.isSymbolicLink() ? 'link' : readFileSync(full, 'base64')
    }
  }
  walk(dir)
  return out
}

// R1. Run path boundary: a Run whose own id is a path, a run id with a path, and a Run naming
//     another talk are all refused, and nothing is written anywhere (outline, Runs, outside).
{
  const box = mkdtempSync(join(tmpdir(), 'tw-instant-boundary-'))
  const vault = join(box, 'vault')
  mkdirSync(join(box, 'outside'), { recursive: true })
  const dir = join(vault, 'talk-a')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'talk-a-outline.md')
  writeFileSync(path, OUTLINE, 'utf8')
  const slide = entry('text', { id: 'text-1', text: 'Discuss', afterSlideId: 'aa11' })
  persistRun(vault, normaliseRun({ id: 'run-b', talkSlug: 'other-talk', startedAt: new Date(1000).toISOString(), instantSlides: [slide] }))
  mkdirSync(join(vault, '_PRESENTATIONS', 'talk-a'), { recursive: true })
  writeFileSync(join(vault, '_PRESENTATIONS', 'talk-a', 'run-1.json'),
    JSON.stringify({ id: '../../../outside/target', talkSlug: 'talk-a', startedAt: new Date(1000).toISOString(), instantSlides: [slide] }))
  writeFileSync(join(vault, '_PRESENTATIONS', 'talk-a', 'run-2.json'),
    JSON.stringify({ id: 'run-2', talkSlug: 'other-talk', startedAt: new Date(1000).toISOString(), instantSlides: [slide] }))
  const before = tree(box)
  const base = { vaultRoot: vault, talkSlug: 'talk-a', entryId: 'text-1', outlinePath: path, tools, storeImage: noImage, rng, document: fileOutlineDocument(path) }
  for (const runId of ['run-1', '../other-talk/run-b', 'run-2', '../../outside/target']) {
    const r = await addRunInstantSlide({ ...base, runId })
    assert.equal(r.ok, false, `refused: ${runId}`)
    assert.match(r.error, /could not be found, so nothing was added/)
  }
  const r = await addRunInstantSlide({ ...base, talkSlug: '../vault/talk-a', runId: 'run-1' })
  assert.equal(r.ok, false)
  assert.deepEqual(tree(box), before, 'nothing written anywhere')
}

// R3a. File route: another writer changes the outline after the new text is staged and before it
//      replaces the file. The last look refuses; the other writer's bytes stay; no temp file is left.
{
  const path = talkFile(OUTLINE)
  const doc = fileOutlineDocument(path, { beforeReplace: async () => { writeFileSync(path, OUTLINE + '\n## Autosaved meanwhile\n', 'utf8') } })
  const result = await addInstantSlideToTalk(doc, path, 'aa11', entry('text', { text: 'x' }), { tools, storeImage: noImage, rng })
  assert.equal(result.ok, false)
  assert.match(result.error, /changed while the slide was being added\. Nothing was written/)
  assert.equal(readFileSync(path, 'utf8'), OUTLINE + '\n## Autosaved meanwhile\n', 'the concurrent write is kept')
  assert.deepEqual(readdirSync(dirname(path)), [dirname(path).split('/').pop() + '-outline.md'], 'no temp file left behind')
}

// R3b. Editor route ordering: the editor's writes run one at a time in the order made. An
//      autosave in flight (slow) settles before the insertion plans; the insertion's save lands
//      after it, never before — so a stale buffer can never overwrite the saved slide.
{
  const queue = createSaveQueue()
  const disk = []
  let releaseAutosave
  const autosave = queue.run(() => new Promise((resolve) => { releaseAutosave = () => { disk.push('stale buffer'); resolve(true) } }))
  assert.equal(queue.busy(), true)
  let planned = false
  const insertion = (async () => {
    await queue.settled() // the D1 seam (lib/outlineMutation.ts) waits here
    planned = true
    return queue.run(async () => { disk.push('buffer with slide'); return true })
  })()
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(planned, false, 'the insertion does not plan while a save is in flight')
  releaseAutosave()
  assert.equal(await autosave, true)
  assert.equal(await insertion, true)
  assert.deepEqual(disk, ['stale buffer', 'buffer with slide'], 'the insertion lands last')
  // A failed write is reported to its caller and does not stall the queue.
  const failed = queue.run(async () => { throw new Error('EACCES') })
  await assert.rejects(failed, /EACCES/)
  assert.equal(await queue.run(async () => 'next'), 'next')
  await queue.settled()
  assert.equal(queue.busy(), false)
}

// R4. Tilde and long-backtick fences inside the anchor slide hide `## …` lines exactly as the
//     compiler's outline tree does: the new slide lands after the fence and compiles as a slide
//     right after its anchor.
for (const fence of [['~~~', '## Fake inside tilde {id=ff66}', '~~~'], ['````md', '```', '## Fake inside four ticks', '```', '````'], ['~~~~', '~~~', '## Fake', '~~~', '~~~~']]) {
  const text = ['---', 'title: Fence', '---', '', '## Opening {id=aa11}', '', ...fence, '', 'After the fence.', '', '## Last {id=ee55}', '', '- end', ''].join('\n')
  const path = talkFile(text)
  const { before, after, result } = await add(path, 'aa11', entry('text', { text: 'After the fenced slide' }))
  assert.equal(result.ok, true, result.error)
  assertOnlyInserted(before, after, result)
  assert.ok(after.indexOf(result.inserted) > after.indexOf('After the fence.'), `lands after the ${fence[0]} fence`)
  assert.ok(after.indexOf(result.inserted) < after.indexOf('## Last'))
  const order = await compiledOrder(path, after)
  assert.equal(order[order.indexOf('aa11') + 1], result.slideId, 'compiles as the slide right after its anchor')
  assert.equal(order.length, (await compiledOrder(path, before)).length + 1)
}
{
  // An id that exists only inside a tilde fence is not an anchor.
  const text = ['## Opening {id=aa11}', '', '~~~', '## Fake {id=cc33}', '~~~', '', '## Last {id=ee55}', ''].join('\n')
  const path = talkFile(text)
  const { before, after, result } = await add(path, 'cc33', entry('text', { text: 'x' }))
  assert.equal(result.ok, false)
  assert.equal(after, before)
}

// R5. A symlinked outline: the link survives, its target gets exactly the insertion.
{
  const dir = join(root, 'linked')
  mkdirSync(join(dir, 'real'), { recursive: true })
  const target = join(dir, 'real', 'real-target.md')
  writeFileSync(target, OUTLINE, 'utf8')
  const link = join(dir, 'linked-outline.md')
  symlinkSync(target, link)
  const result = await addInstantSlideToTalk(fileOutlineDocument(link), link, 'aa11', entry('text', { text: 'Through the link' }), { tools, storeImage: noImage, rng })
  assert.equal(result.ok, true, result.error)
  assert.equal(lstatSync(link).isSymbolicLink(), true, 'the outline path is still a symlink')
  const after = readFileSync(target, 'utf8')
  assertOnlyInserted(OUTLINE, after, result)
  assert.deepEqual(readdirSync(join(dir, 'real')), ['real-target.md'], 'no temp file left beside the target')
  assert.deepEqual(readdirSync(dir), ['linked-outline.md', 'real'])
}

// R7. An image record that is over the live cap or is not a real WebP/PNG/JPEG is refused before
//     anything is stored; a real one is stored with the extension its bytes say.
{
  const vault = join(root, 'vault-bad-image')
  const path = talkFile(OUTLINE)
  let stores = 0
  // The stub "WebP" is larger than the original, so the original bytes and type are kept.
  const storeImage = async (bytes, format) => { stores += 1; return (await storePastedImage(vault, bytes, format, async (b) => Buffer.concat([b, b]))).id }
  const pixel = 'UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA='
  const bad = [
    `data:image/webp;base64,${pixel}${'A'.repeat(120_004 - pixel.length - 23)}`,
    `data:image/webp;base64,${Buffer.from('#!/bin/sh\necho not an image\n').toString('base64')}`,
    `data:image/webp;base64,${Buffer.from('RIFF\0\0\0\0WAVEfmt ').toString('base64')}`,
    `data:image/webp;base64,${Buffer.from('RIFF\x08\0\0\0WEBPVP8 ').toString('base64')}`, // round 2: header only
  ]
  assert.ok(bad[0].length > 120_000)
  for (const dataUrl of bad) {
    const { before, after, result } = await add(path, 'aa11', entry('image', { dataUrl, width: 1, height: 1 }), { storeImage })
    assert.equal(result.ok, false)
    assert.match(result.error, /not a usable picture.*nothing was added/)
    assert.equal(after, before)
  }
  assert.equal(stores, 0, 'storeImage never called')
  assert.equal(existsSync(join(vault, '_assets')), false, 'no asset written')
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')
  const { result } = await add(path, 'aa11', entry('image', { dataUrl: `data:image/webp;base64,${png.toString('base64')}`, width: 1, height: 1 }), { storeImage })
  assert.equal(result.ok, true, result.error)
  const ref = result.inserted.match(/!\[\]\((img-[0-9a-f]{7})\)/)[1]
  assert.ok(existsSync(join(vault, '_assets', `${ref}.png`)), 'stored as .png, as its signature says')
}

// R8. Typed text never becomes media: image/video syntax, a lone URL (an embedded page), a quote,
//     a table row and a Timeline block all stay text on the inserted slide.
{
  const adapters = await import(pathToFileURL(join(REPO, 'compiler/scripts/lib/08-source-adapters.mjs')).href)
  const path = talkFile(OUTLINE)
  const text = ['Look at this:', '', '![](https://example.org/pixel)', '', 'https://example.org/page', '', '![clip](https://example.org/a.mp4)', '', '> not a quote', '', '| a | b |', '|---|---|', '', '**Timeline:**', '- 2020 x'].join('\n')
  const { before, after, result } = await add(path, 'aa11', entry('text', { text }))
  assert.equal(result.ok, true, result.error)
  assertOnlyInserted(before, after, result)
  assert.ok(result.inserted.includes('\n\\![]\\(https://example.org/pixel)\n'), 'image syntax escaped')
  assert.ok(result.inserted.includes('\n[https://example.org/page](https://example.org/page)\n'), 'a lone URL becomes a link showing the URL')
  const model = await adapters.prepareSource(path, after, 'fixture', undefined, undefined, { projectionsOnly: true })
  const slide = model.slides.find((s) => s.id === result.slideId)
  assert.ok(slide, 'the inserted slide compiles')
  const types = slide.blocks.map((b) => b.type)
  for (const media of ['image', 'video', 'embed', 'quote', 'table', 'timeline', 'qr', 'action']) assert.ok(!types.includes(media), `no ${media} block (got ${types.join(',')})`)
  const shown = JSON.stringify(slide.blocks)
  assert.ok(shown.includes('![]\\\\(https://example.org/pixel)') && shown.includes('https://example.org/page') && shown.includes('not a quote'), 'the text is shown as text')
}

// ── Round 2 (re-review of 743fef9) ───────────────────────────────────────────────────────────

// P1. The replacement keeps the outline's permissions whatever the process umask.
{
  const path = talkFile(OUTLINE)
  chmodSync(path, 0o644)
  const previous = process.umask(0o077)
  try {
    const { before, after, result } = await add(path, 'aa11', entry('text', { text: 'Mode kept' }))
    assert.equal(result.ok, true, result.error)
    assertOnlyInserted(before, after, result)
  } finally { process.umask(previous) }
  assert.equal(statSync(path).mode & 0o777, 0o644, 'mode 0644 survives a 077 umask')
  const second = talkFile(OUTLINE) // a fresh file: the fixed rng would mint the same id again
  chmodSync(second, 0o640)
  const again = await add(second, 'aa11', entry('text', { text: 'Group mode kept' }))
  assert.equal(again.result.ok, true, again.result.error)
  assert.equal(statSync(second).mode & 0o777, 0o640)
}

// P2. A read-only outline (0444) is refused with a human message and left exactly as it is, even
//     though its folder is writable (a rename would otherwise replace it).
{
  const path = talkFile(OUTLINE)
  chmodSync(path, 0o444)
  const { before, after, result } = await add(path, 'aa11', entry('text', { text: 'Not allowed' }))
  assert.equal(result.ok, false)
  assert.match(result.error, /read-only.*Nothing was written/)
  assert.equal(after, before)
  assert.equal(statSync(path).mode & 0o777, 0o444, 'still read-only')
  assert.deepEqual(readdirSync(dirname(path)), [dirname(path).split('/').pop() + '-outline.md'], 'no temp file left behind')
  chmodSync(path, 0o644)
}

// I1. "Add to talk" stores an image only if it decodes: a WebP whose header is complete but whose
//     pixels are garbage is refused and no asset is written (the paste route's keep-the-original
//     fallback does not apply here). The paste route itself is unchanged.
{
  const sharp = createRequire(import.meta.url)('sharp')
  const vault = join(root, 'vault-undecodable')
  const path = talkFile(OUTLINE)
  const strictStore = async (bytes, format) => (await storePastedImage(vault, bytes, format, (buf) => decodeToWebp(sharp, buf), { requireDecode: true })).id
  const pixel = Buffer.from('UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=', 'base64')
  const garbage = Buffer.from(pixel); for (let i = 30; i < garbage.length; i += 1) garbage[i] = 0xff
  const { before, after, result } = await add(path, 'aa11', entry('image', { dataUrl: `data:image/webp;base64,${garbage.toString('base64')}`, width: 1, height: 1 }), { storeImage: strictStore })
  assert.equal(result.ok, false)
  assert.match(result.error, /could not be decoded as a picture, so nothing was added/)
  assert.equal(after, before)
  assert.equal(existsSync(join(vault, '_assets')), false, 'no asset written')
  // A converter that fails outright: refused, nothing written.
  await assert.rejects(storePastedImage(vault, pixel, 'webp', async () => { throw new Error('sharp missing') }, { requireDecode: true }), /image-not-decodable/)
  await assert.rejects(storePastedImage(vault, pixel, 'webp', async () => Buffer.alloc(0), { requireDecode: true }), /image-not-decodable/)
  assert.equal(existsSync(join(vault, '_assets')), false, 'still no asset written')
  // A real picture decodes and is stored as WebP.
  const good = await add(path, 'aa11', entry('image', { dataUrl: `data:image/webp;base64,${pixel.toString('base64')}`, width: 1, height: 1 }), { storeImage: strictStore })
  assert.equal(good.result.ok, true, good.result.error)
  const ref = good.result.inserted.match(/!\[\]\((img-[0-9a-f]{7})\)/)[1]
  assert.ok(existsSync(join(vault, '_assets', `${ref}.webp`)))
  // The clipboard paste route (no requireDecode) still never fails: it keeps the original bytes.
  const pasteVault = join(root, 'vault-paste')
  const pasted = await storePastedImage(pasteVault, garbage, 'webp', async () => { throw new Error('sharp missing') })
  assert.ok(readFileSync(pasted.path).equals(garbage))
}

// L1. Typed link syntax stays the characters the audience saw: `[label](url)` with a non-empty
//     label and `![alt](url)` mid-line and at line start render with their URL visible and no hidden
//     link; a line starting with `!` is kept (the lexer drops it otherwise); `<!--` hides nothing;
//     the generated title is escaped the same way.
{
  const adapters = await import(pathToFileURL(join(REPO, 'compiler/scripts/lib/08-source-adapters.mjs')).href)
  const { renderInline } = await import(pathToFileURL(join(REPO, 'compiler/scripts/lib/00-inline-render.mjs')).href)
  const path = talkFile(OUTLINE)
  const text = ['Read [the report](https://example.org/report) today', '', 'See ![a chart](https://example.org/chart.png) here',
    '', '![alt text](https://example.org/pixel)', '', '!!! Break time', '', 'a <!-- not hidden --> b'].join('\n')
  const { before, after, result } = await add(path, 'aa11', entry('text', { text }))
  assert.equal(result.ok, true, result.error)
  assertOnlyInserted(before, after, result)
  const model = await adapters.prepareSource(path, after, 'fixture', undefined, undefined, { projectionsOnly: true })
  const slide = model.slides.find((s) => s.id === result.slideId)
  assert.ok(slide, 'the inserted slide compiles')
  const rendered = [renderInline(slide.title), ...slide.blocks.map((b) => renderInline(b.text ?? ''))].join('\n')
  for (const label of ['the report', 'a chart', 'alt text']) {
    assert.ok(!new RegExp(`<a [^>]*>${label}</a>`).test(rendered), `“${label}” is not a link hiding its URL:\n${rendered}`)
    assert.ok(rendered.includes(`[${label}]`), `“${label}” is shown in its brackets`)
  }
  for (const url of ['https://example.org/report', 'https://example.org/chart.png', 'https://example.org/pixel']) {
    assert.ok(rendered.includes(`>${url}</a>`) || rendered.includes(`(${url})`), `${url} is visible`)
  }
  assert.ok(rendered.includes('!!! Break time'), 'a line starting with ! is kept')
  assert.ok(rendered.includes('not hidden'), 'a comment opener hides nothing')
  assert.ok(!slide.blocks.some((b) => ['image', 'video', 'embed'].includes(b.type)), 'no media block')
  assert.ok(!/<a [^>]*>the report<\/a>/.test(renderInline(slide.title)), 'the title shows no hidden link')
}

// Q1. Every renderer outline write for one file shares ONE queue (lib/saveQueue outlineSaveQueue):
//     a workspace write that is delayed in flight, queued before an instant-slide save made through
//     the editor, lands before it — never after it, erasing the slide.
{
  const outline = '/vault/talk/talk-outline.md'
  const disk = []
  let releaseWorkspace
  // WorkspaceLayout.writeOutline → queueOutlineWrite(path, …): the IPC round trip is held open.
  const workspace = queueOutlineWrite(outline, () => new Promise((resolve) => { releaseWorkspace = () => { disk.push('workspace text'); resolve({ ok: true }) } }))
  // The D1 seam (lib/outlineMutation.ts applyFromMain): waits for the file's queue, then saves through the same queue.
  const insertion = (async () => {
    await outlineWritesSettled(outline)
    return queueOutlineWrite(outline, async () => { disk.push('text with instant slide'); return { ok: true } })
  })()
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(disk, [], 'the instant-slide save waits while the workspace write is in flight')
  releaseWorkspace()
  await workspace
  await insertion
  assert.deepEqual(disk, ['workspace text', 'text with instant slide'], 'the instant-slide save lands last')
  assert.equal(outlineSaveQueue(await outlineQueueKey(outline)), outlineSaveQueue(await outlineQueueKey(outline)), 'one queue per outline file')
  assert.notEqual(await outlineQueueKey(outline), await outlineQueueKey('/vault/other/other-outline.md'), 'other files are not held up')
  // Guard: no renderer module sends talk.writeOutline except through queueOutlineWrite.
  const offenders = []
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name)
      if (statSync(full).isDirectory()) { walk(full); continue }
      if (!/\.(ts|tsx)$/.test(name) || name === 'tw-mock.ts') continue
      readFileSync(full, 'utf8').split('\n').forEach((line, i) => {
        if (/\.talk\.writeOutline\(/.test(line) && !/queueOutlineWrite\(/.test(line)) offenders.push(`${relative(REPO, full)}:${i + 1}`)
      })
    }
  }
  walk(join(REPO, 'src/renderer/src'))
  assert.deepEqual(offenders, [], 'every renderer outline write goes through the shared queue')
}

// Q2. One queue per REAL file (third review): the same outline reached through a symlinked file, a
//     symlinked folder and its real path shares one queue (keys resolved by the main process's
//     canonicalOutlinePath), so a delayed write through one alias still lands before an Add-shaped
//     save through another. Writes reach their queue in call order even while an alias's first
//     resolution is slow.
{
  const dir = mkdtempSync(join(tmpdir(), 'tw-queue-alias-'))
  const realDir = join(dir, 'real-talk')
  mkdirSync(realDir)
  const real = join(realDir, 'real-talk-outline.md')
  writeFileSync(real, OUTLINE)
  const fileLink = join(dir, 'link-outline.md')
  symlinkSync(real, fileLink)
  const dirLink = join(dir, 'linked-talk')
  symlinkSync(realDir, dirLink)
  const viaFolder = join(dirLink, 'real-talk-outline.md')
  setOutlinePathResolver(async (p) => canonicalOutlinePath(p))
  try {
    const keys = await Promise.all([real, fileLink, viaFolder].map((p) => outlineQueueKey(p)))
    assert.equal(new Set(keys).size, 1, `all aliases share one key: ${keys.join(' | ')}`)
    assert.equal(outlineSaveQueue(keys[1]), outlineSaveQueue(keys[0]), 'all aliases share one queue')
    const disk = []
    let release
    const older = queueOutlineWrite(fileLink, () => new Promise((resolve) => { release = () => { disk.push('older text'); resolve({ ok: true }) } }))
    const insertion = (async () => {
      await outlineWritesSettled(viaFolder)
      return queueOutlineWrite(real, async () => { disk.push('text with instant slide'); return { ok: true } })
    })()
    await new Promise((r) => setTimeout(r, 20))
    assert.deepEqual(disk, [], 'a save through another alias waits for the write in flight')
    release()
    await older
    await insertion
    assert.deepEqual(disk, ['older text', 'text with instant slide'], 'the instant-slide save lands last whichever alias each side uses')

    // A slow first resolution for one alias must not let a later write through another alias overtake it.
    setOutlinePathResolver(async (p) => {
      if (p === fileLink) await new Promise((r) => setTimeout(r, 40))
      return canonicalOutlinePath(p)
    })
    const order = []
    const first = queueOutlineWrite(fileLink, async () => { order.push('first (slow alias)') })
    const second = queueOutlineWrite(real, async () => { order.push('second') })
    await Promise.all([first, second])
    assert.deepEqual(order, ['first (slow alias)', 'second'], 'writes reach the file queue in call order')
  } finally {
    setOutlinePathResolver(null)
  }

  // The main process's editor-window lookup (index.ts editorWindowForOutline) finds the window that
  // has the talk open whichever alias History or the window uses, and answers with the window's path.
  const claim = (win, outlinePath) => ({ win, outlinePath })
  const other = join(dir, 'other-outline.md')
  writeFileSync(other, OUTLINE)
  for (const windowPath of [real, fileLink, viaFolder]) {
    const entries = [claim('idle', null), claim('other', other), claim('editor', windowPath)]
    for (const historyPath of [real, fileLink, viaFolder]) {
      const found = editorEntryForOutline(entries, historyPath, () => true)
      assert.equal(found?.win, 'editor', `window on ${relative(dir, windowPath)} found via ${relative(dir, historyPath)}`)
      assert.equal(found?.outlinePath, windowPath, 'requests go out in the window\'s own path')
    }
  }
  assert.equal(editorEntryForOutline([claim('closed', fileLink)], real, (w) => w !== 'closed'), null, 'a destroyed window is skipped')
  assert.equal(editorEntryForOutline([claim('other', other)], fileLink, () => true), null, 'a different file is not matched')
}

// ── One writer for talk files, D1 (spec 2026-09-27, test 3): buffer-first mutations ───────────
// A fake editor window stands in for Editor.tsx + WorkspaceLayout: a buffer with a debounced
// autosave, undo history and the registerReplaceDoc / registerReadDoc behaviour (minimal change;
// `save` supersedes the autosave). Its mutations run through the REAL seam (lib/outlineMutation.ts)
// over the REAL shared save queue, and main's routed writes through the REAL talk-writer.ts, whose
// editor route calls the seam exactly as index.ts editorOutlineDocument does. Disk is a temp file.
// In every case the person keeps typing around the change; the final file must hold both.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function fakeEditorWindow(path, { autosaveMs = 25 } = {}) {
  const ed = { doc: readFileSync(path, 'utf8'), caret: 0, undo: [], timer: null, holdNextSave: null, saves: [] }
  const save = (text) => queueOutlineWrite(path, async () => {
    const hold = ed.holdNextSave
    ed.holdNextSave = null
    if (hold) await hold
    writeFileSync(path, text, 'utf8')
    ed.saves.push(text)
    return { ok: true, collisions: [] }
  })
  const schedule = () => {
    if (ed.timer) clearTimeout(ed.timer)
    ed.timer = setTimeout(() => { ed.timer = null; ed.autosave = save(ed.doc) }, autosaveMs)
  }
  const dispatch = (next) => {
    const change = applyMinimalChange(ed.doc, next)
    if (!change) return
    ed.undo.push({ from: change.from, to: change.from + change.insert.length, insert: ed.doc.slice(change.from, change.to) })
    ed.doc = ed.doc.slice(0, change.from) + change.insert + ed.doc.slice(change.to)
    // The caret is mapped through the change as CodeMirror maps the selection (an insertion AT the
    // caret stays after it; a caret inside a replaced span goes to its start).
    if (ed.caret > change.to || (ed.caret === change.to && change.to > change.from)) ed.caret += change.insert.length - (change.to - change.from)
    else if (ed.caret > change.from) ed.caret = change.from
    schedule() // the update listener schedules the debounced autosave
  }
  ed.type = (after, text) => {
    const at = ed.doc.indexOf(after)
    assert.ok(at >= 0, `anchor for typing: ${after}`)
    dispatch(ed.doc.slice(0, at + after.length) + text + ed.doc.slice(at + after.length))
    ed.caret = at + after.length + text.length // typing leaves the caret after the typed text
  }
  // registerReplaceDoc WITHOUT `save` (the old post-adopt re-read used it): the text goes in, the
  // normal autosave follows.
  ed.replace = (text) => dispatch(text)
  const buffer = {
    read: (p) => p === path ? ed.doc : null,
    apply: (p, next) => {
      if (p !== path) return null
      dispatch(next)
      if (ed.timer) { clearTimeout(ed.timer); ed.timer = null } // save: true supersedes the autosave
      return ed.doc
    },
    adopt: (p, sent, saved) => { if (p === path && ed.doc === sent) dispatch(saved) },
    // Editor.tsx registerInsert: the block goes in at the END of the caret's line, surrounded by blank
    // lines, and the caret moves after it.
    insertAtCaret: (p, block) => {
      if (p !== path) return false
      const lineEnd = ed.doc.indexOf('\n', ed.caret)
      const at = lineEnd < 0 ? ed.doc.length : lineEnd
      const insert = '\n\n' + block.replace(/^\n+/, '').replace(/\n+$/, '') + '\n'
      dispatch(ed.doc.slice(0, at) + insert + ed.doc.slice(at))
      ed.caret = at + insert.length
      return true
    },
  }
  ed.mutator = createOutlineMutator({ bufferFor: (p) => p === path ? buffer : null, settled: outlineWritesSettled, write: (_p, text) => save(text) })
  // Main's view of this window (index.ts editorOutlineDocument over outline:editor-request).
  ed.editorBuffer = {
    async read() { const r = await ed.mutator.readForMain(path); if (!r.ok) throw new Error(r.error); return r.text },
    commit: (base, next) => ed.mutator.applyFromMain(path, base, next),
  }
  ed.idle = async () => {
    while (ed.timer) await sleep(autosaveMs)
    await outlineWritesSettled(path)
  }
  return ed
}
const outlineEdit = await import(pathToFileURL(join(REPO, 'compiler/scripts/lib/12-outline-edit.mjs')).href)
function tagSlide(text, id, tag) {
  let out = text
  for (const ref of outlineEdit.blockRefsForId(out, id)) out = outlineEdit.applySlideTags(out, ref, { add: [tag], remove: [] }, outlineEdit.dominantEol(out)).text
  return out
}
// Moves the "## Last" slide to the top (the grid's reorder result shape: whole blocks moved).
function lastSlideFirst(text) {
  const i = text.indexOf('## Last {id=ee55}'), j = text.indexOf('## Opening {id=aa11}')
  const block = text.slice(i).replace(/\n*$/, '\n\n')
  return (text.slice(0, j) + block + text.slice(j, i)).replace(/\n*$/, '\n')
}

// D1a. Reorder, then autosave. An autosave of the person's typing is IN FLIGHT when the reorder
//      starts, they type again while the reorder is worked out (an IPC round trip), and again after
//      it: the file ends with the reorder and all three edits, and the reorder is one undo step.
{
  const path = talkFile(OUTLINE)
  const ed = fakeEditorWindow(path)
  ed.type('- one point', '\n- typed before the move')
  let release
  ed.holdNextSave = new Promise((r) => { release = r })
  await sleep(40) // the autosave fires and is held in flight
  const undoBefore = ed.undo.length
  const reorder = ed.mutator.apply(path, async (text) => {
    await sleep(10)
    if (!ed.doc.includes('typed during the move')) ed.type('Some text.', ' typed during the move') // mid round trip
    return lastSlideFirst(text)
  })
  await sleep(20)
  release()
  const result = await reorder
  assert.equal(result.ok, true, result.error)
  assert.equal(result.changed, true)
  assert.ok(result.base.includes('typed during the move'), 'worked out again against the buffer as it now stands')
  ed.type('- end', '\n- typed after the move')
  await ed.idle()
  const disk = readFileSync(path, 'utf8')
  assert.ok(disk.indexOf('## Last {id=ee55}') < disk.indexOf('## Opening {id=aa11}'), 'the reorder is on disk')
  for (const typed of ['typed before the move', 'typed during the move', 'typed after the move']) assert.ok(disk.includes(typed), `"${typed}" is on disk`)
  assert.equal(disk, ed.doc, 'disk is the buffer')
  assert.equal(ed.undo.length - undoBefore, 3, 'typing, the reorder (ONE change) and typing — no remount, history kept')
}

// D1b. Tag apply (main's tags:apply routed to the window), then autosave. The person's typing is
//      waiting on its debounce when the tag lands; they type again afterwards. Both survive, and
//      main never wrote the file behind the buffer.
{
  const path = talkFile(OUTLINE)
  const ed = fakeEditorWindow(path)
  configureTalkWriter({ editorBufferFor: (p) => p === path ? ed.editorBuffer : null })
  try {
    ed.type('- one point', '\n- typed before the tag')
    const written = await writeTalkOutline(path, (text) => tagSlide(text, 'cc33', 'demo'), 'tags')
    assert.equal(written.ok, true, written.error)
    assert.equal(written.via, 'editor', 'an open talk is written through its window')
    ed.type('- end', '\n- typed after the tag')
    await ed.idle()
    const disk = readFileSync(path, 'utf8')
    assert.match(disk.slice(disk.indexOf('{id=cc33}'), disk.indexOf('### Child two')), /tags=demo/, 'the tag is on disk, on its slide')
    assert.ok(disk.includes('typed before the tag') && disk.includes('typed after the tag'), 'both edits are on disk')
    assert.equal(disk, ed.doc)
    assert.ok(ed.saves.every((t) => t.includes('typed before the tag')), 'no save ever carried the file without the typing')
  } finally {
    configureTalkWriter({ editorBufferFor: () => null })
  }
}

// D1c. Publish handout: the forced flush saves the buffer as it stands; the person types during the
//      deploy and again while main stamps (so main's first apply-if-unchanged is refused, and main
//      works the stamp out again against the buffer as it now stands — talk-writer's bounded retry);
//      the renderer then stamps the buffer as it stands (WorkspaceLayout.handlePublishHandout: a no-op
//      now), and they type again. The file ends with the stamp and every edit — never the text the
//      publish started from.
{
  const path = talkFile(OUTLINE)
  const ed = fakeEditorWindow(path)
  const url = 'https://talks.example/fixture'
  let typeDuringStamp = false
  configureTalkWriter({ editorBufferFor: (p) => p === path ? {
    async read() {
      const text = await ed.editorBuffer.read()
      if (typeDuringStamp) { typeDuringStamp = false; ed.type('Speaker notes.', ' Typed while main stamped.') }
      return text
    },
    commit: ed.editorBuffer.commit,
  } : null })
  try {
    ed.type('- one point', '\n- typed before publishing')
    const startedFrom = ed.doc // the `content` the publish request carries
    const flushed = await flushTalkForPublish(path)
    assert.equal(flushed.ok, true, flushed.error)
    assert.equal(readFileSync(path, 'utf8'), startedFrom, 'the flush saved the buffer as it stood')
    ed.type('- x', '\n- typed during the deploy')
    typeDuringStamp = true
    const stamped = await writeTalkOutline(path, (current) => stampHandoutUrl(current, url), 'publish-handout')
    assert.equal(stamped.ok && stamped.via, 'editor', 'main\'s stamp lands through the buffer, worked out again after the buffer moved')
    assert.ok(ed.doc.includes(`handout_url: ${url}`) && ed.doc.includes('Typed while main stamped.'), 'the stamp is on top of the typing made while it was worked out')
    const adopted = await ed.mutator.apply(path, (current) => stampHandoutUrl(current, url))
    assert.equal(adopted.ok, true, adopted.error)
    assert.equal(adopted.changed, false, 'the renderer\'s own stamp finds it already there')
    ed.type('- end', '\n- typed after publishing')
    await ed.idle()
    const disk = readFileSync(path, 'utf8')
    assert.ok(disk.includes(`handout_url: ${url}`), 'the stamp is on disk')
    for (const typed of ['typed before publishing', 'typed during the deploy', 'Typed while main stamped.', 'typed after publishing']) assert.ok(disk.includes(typed), `"${typed}" is on disk`)
    assert.equal(disk, ed.doc)
    // Stamping the buffer again (main's stamp landed after all) is a no-op: no change, no save.
    const saves = ed.saves.length
    const again = await ed.mutator.apply(path, (current) => stampHandoutUrl(current, url))
    assert.deepEqual([again.ok, again.changed, ed.saves.length], [true, false, saves])
  } finally {
    configureTalkWriter({ editorBufferFor: () => null })
  }
}

// D1d. A talk not open in this window is not the seam's to write: it answers not-open, writes nothing.
{
  const path = talkFile(OUTLINE)
  const ed = fakeEditorWindow(path)
  const other = talkFile(OUTLINE)
  const result = await ed.mutator.apply(other, (text) => text + '\nnope\n')
  assert.deepEqual([result.ok, result.reason], [false, 'not-open'])
  assert.equal(readFileSync(other, 'utf8'), OUTLINE)
}

// D1e. Adopt a ledger version (PropagationChecklist → ledger:adopt) into the open talk, then type.
//      main's engine write (14-slide-propagation adoptVersion over talkOutlineIO) goes through the
//      window's buffer; the host then does NOTHING to the buffer (WorkspaceLayout has no onAdopted
//      re-read any more — `hostAfterAdopt` below mirrors it). The typing after the adopt survives
//      its save, and the adopted version survives the typing's autosave.
const propagation = await import(pathToFileURL(join(REPO, 'compiler/scripts/lib/14-slide-propagation.mjs')).href)
const hostAfterAdopt = async (_ed, _path) => {} // WorkspaceLayout: no onAdopted re-read (one-writer T3)
{
  const vault = mkdtempSync(join(tmpdir(), 'tw-d1-adopt-'))
  mkdirSync(join(vault, 'adopt'), { recursive: true })
  const path = join(vault, 'adopt', 'adopt-outline.md')
  writeFileSync(path, OUTLINE, 'utf8')
  const ed = fakeEditorWindow(path)
  configureTalkWriter({ editorBufferFor: (p) => p === path ? ed.editorBuffer : null })
  try {
    ed.type('- one point', '\n- typed before the adopt')
    const version = '### Child one {id=cc33}\n\nThe adopted version of child one.\n'
    const io = {
      read: (abs) => readTalkOutline(abs), // index.ts talkOutlineIO('ledger-adopt')
      write: (abs, transform, opts) => writeTalkOutline(abs, transform, 'ledger-adopt', opts),
    }
    const adopted = await propagation.adoptVersion(vault, 'cc33', version, ['adopt/adopt-outline.md'], { io })
    assert.deepEqual(adopted.failed, [], JSON.stringify(adopted.failed))
    assert.equal(adopted.replaced.length, 1)
    assert.ok(ed.doc.includes('The adopted version of child one.'), 'the adopt landed in the buffer')
    ed.type('- end', '\n- typed after the adopt') // before the host has reacted to the adopt
    await hostAfterAdopt(ed, path)
    await ed.idle()
    const disk = readFileSync(path, 'utf8')
    assert.ok(disk.includes('The adopted version of child one.'), 'the adopted version is on disk')
    assert.ok(!disk.includes('Some text.'), 'the old body of the adopted slide is gone')
    for (const typed of ['typed before the adopt', 'typed after the adopt']) assert.ok(disk.includes(typed), `"${typed}" is on disk`)
    assert.equal(disk, ed.doc, 'disk is the buffer')
  } finally {
    configureTalkWriter({ editorBufferFor: () => null })
  }
}

// D1f. Icon pick (WorkspaceLayout.handleIconPicked), then autosave. The pin is worked out by main's
//      setListItemIcon over the BUFFER's text; the person types while that round trip runs and again
//      afterwards. The pin and every edit are on disk, and the pin is one undo step.
{
  const path = talkFile(OUTLINE)
  const ed = fakeEditorWindow(path)
  ed.type('Speaker notes.', ' Typed before the icon.')
  const undoBefore = ed.undo.length
  const picked = ed.mutator.apply(path, async (text) => {
    await sleep(10) // the outline:set-item-icon round trip
    if (!ed.doc.includes('typed during the icon')) ed.type('- end', ' typed during the icon')
    return outlineEdit.setListItemIcon(text, { heading: '## Opening {id=aa11}', occurrence: 1 }, 0, 'star')
  })
  const result = await picked
  assert.equal(result.ok, true, result.error)
  assert.equal(readFileSync(path, 'utf8'), result.text, 'the pin was saved at once, not left to the autosave')
  ed.type('- x', '\n- typed after the icon')
  await ed.idle()
  const disk = readFileSync(path, 'utf8')
  assert.ok(disk.includes('- one point {icon=star}\n'), 'the pin is on disk, on its bullet')
  for (const typed of ['Typed before the icon.', 'typed during the icon', 'typed after the icon']) assert.ok(disk.includes(typed), `"${typed}" is on disk`)
  assert.equal(disk, ed.doc, 'disk is the buffer')
  assert.equal(ed.undo.length - undoBefore, 3, 'typing, the pin (ONE change) and typing — no remount, history kept')
}

// D1g. Archive image insert (WorkspaceLayout.handleArchiveInsert), then autosave. The person's
//      typing is being saved (held in flight) when the image goes in at the caret; they type again
//      afterwards. The ref sits right after the caret's line, it reached disk as soon as the insert
//      resolved (after the save in flight), and every edit survives.
{
  const path = talkFile(OUTLINE)
  const ed = fakeEditorWindow(path)
  ed.type('- one point', ' typed before the image') // caret now at the end of the Opening bullet
  let release
  ed.holdNextSave = new Promise((r) => { release = r })
  await sleep(40) // the autosave fires and is held in flight
  const undoBefore = ed.undo.length
  const savesBefore = ed.saves.length
  const inserting = ed.mutator.insertAtCaret(path, '![](img-abc123)')
  await sleep(10)
  release()
  const result = await inserting
  assert.equal(result.ok, true, result.error)
  const afterInsert = readFileSync(path, 'utf8')
  assert.ok(afterInsert.includes('- one point typed before the image\n\n![](img-abc123)\n'), 'the ref is on disk at the caret as soon as the insert resolves')
  assert.equal(ed.saves.length - savesBefore, 2, 'two writes through the queue: the autosave in flight, then the insert\'s own save')
  assert.equal(ed.saves.at(-1), afterInsert, 'the insert\'s save (through writeOutline\'s queue) wrote the buffer with the ref')
  assert.ok(!ed.saves.at(-2).includes('img-abc123'), 'and it came after the save that was in flight')
  ed.type('- end', '\n- typed after the image')
  await ed.idle()
  const disk = readFileSync(path, 'utf8')
  assert.equal((disk.match(/!\[\]\(img-abc123\)/g) || []).length, 1, 'the ref is on disk once')
  assert.ok(disk.indexOf('![](img-abc123)') < disk.indexOf('## Section {id=bb22}'), 'at the caret, not appended at the end')
  for (const typed of ['typed before the image', 'typed after the image']) assert.ok(disk.includes(typed), `"${typed}" is on disk`)
  assert.equal(disk, ed.doc, 'disk is the buffer')
  assert.equal(ed.undo.length - undoBefore, 2, 'the insert (ONE change) and typing')
  // Not loaded in this window: nothing is inserted anywhere.
  const other = talkFile(OUTLINE)
  const refused = await ed.mutator.insertAtCaret(other, '![](img-zzz)')
  assert.deepEqual([refused.ok, refused.reason, refused.applied], [false, 'not-open', false])
  assert.ok(!ed.doc.includes('img-zzz') && readFileSync(other, 'utf8') === OUTLINE)
}

// D1h. The window's refusals name the writer (outline:editor-request carries the origin): "Add to
//      talk" (no origin, or instant-slide) keeps its exact words; every other writer is named by its
//      noun. A moved buffer is flagged so main can work the change out again.
{
  const path = talkFile(OUTLINE)
  const ed = fakeEditorWindow(path)
  const stale = ed.doc
  ed.type('- one point', ' moved on')
  const add = await ed.mutator.applyFromMain(path, stale, stale + 'x\n')
  const addNamed = await ed.mutator.applyFromMain(path, stale, stale + 'x\n', 'instant-slide')
  const tags = await ed.mutator.applyFromMain(path, stale, stale + 'x\n', 'tags')
  const meta = await ed.mutator.applyFromMain(path, stale, stale + 'x\n', 'frontmatter')
  assert.deepEqual(add, { ok: false, error: 'The talk was edited while the slide was being added. Nothing was changed; try again.', moved: true })
  assert.deepEqual(addNamed, add, 'origin instant-slide keeps the "Add to talk" words')
  assert.deepEqual(tags, { ok: false, error: 'The talk was edited while applying the tags. Nothing was changed; try again.', moved: true })
  assert.equal(meta.error, 'The talk was edited while applying the metadata. Nothing was changed; try again.')
  const other = talkFile(OUTLINE)
  const notReady = await ed.mutator.applyFromMain(other, OUTLINE, OUTLINE + 'x\n', 'tags')
  assert.deepEqual(notReady, { ok: false, error: 'The talk is not ready in its editor window, so applying the tags changed nothing. Try again.' })
  assert.equal((await ed.mutator.applyFromMain(other, OUTLINE, OUTLINE + 'x\n')).error, 'The talk is not ready in its editor window. Nothing was added; try again.')
  // Through main's writer: a tag write that keeps meeting a moved buffer ends with the tags' words.
  configureTalkWriter({ editorBufferFor: (p) => p === path ? {
    read: ed.editorBuffer.read,
    async commit(base, next, origin) { ed.type('- end', ' typing'); return ed.mutator.applyFromMain(path, base, next, origin) },
  } : null })
  try {
    const routed = await writeTalkOutline(path, (text) => tagSlide(text, 'cc33', 'demo'), 'tags')
    assert.deepEqual(routed, { ok: false, error: 'The talk was edited while applying the tags. Nothing was changed; try again.' })
    assert.ok(!ed.doc.includes('tags=demo'), 'nothing applied')
  } finally {
    configureTalkWriter({ editorBufferFor: () => null })
  }
  await ed.idle()
}

// D1i. "Add to talk" whose main-side read is overtaken by a strip reorder (2026-09-27 walk): the
//      editor refuses the stale apply as moved, and the insertion is planned again ONCE against the
//      buffer as it now stands — the slide lands after its anchor in the reordered talk, the reorder
//      is kept, disk is the buffer. Overtaken on the retry too: the "Add to talk" refusal stands,
//      after exactly two applies, and nothing is changed.
{
  const path = talkFile(OUTLINE)
  const ed = fakeEditorWindow(path)
  let reorderOnRead = 1
  const applies = []
  const reads = []
  const document = {
    async read() {
      reads.push(Date.now())
      const text = await ed.editorBuffer.read()
      // The read's reply is on its way to main when the strip's reorder lands in the buffer.
      if (reorderOnRead > 0) { reorderOnRead -= 1; const r = await ed.mutator.apply(path, lastSlideFirst); assert.equal(r.ok, true, r.error) }
      return text
    },
    async commit(base, next) { const reply = await ed.editorBuffer.commit(base, next); applies.push(reply.ok ? 'ok' : reply.error); if (!reply.ok) refusedAt = Date.now(); return reply },
  }
  let refusedAt = 0
  const result = await addInstantSlideToTalk(document, path, 'aa11', entry('text', { text: 'Added after a reorder' }), { tools, storeImage: noImage, rng })
  assert.equal(result.ok, true, result.error)
  assert.deepEqual(applies, ['The talk was edited while the slide was being added. Nothing was changed; try again.', 'ok'], 'the stale apply was refused as moved, then the retry applied')
  assert.ok(reads[1] - refusedAt >= 15, `the retry pauses first (the talk writer's retryPause, 20 ms): ${reads[1] - refusedAt} ms`)
  await ed.idle()
  const disk = readFileSync(path, 'utf8')
  assert.equal(disk, ed.doc, 'disk is the buffer')
  assert.ok(disk.indexOf('## Last {id=ee55}') < disk.indexOf('## Opening {id=aa11}'), 'the reorder is kept')
  const added = disk.indexOf('Added after a reorder')
  assert.ok(added > disk.indexOf('- one point') && added < disk.indexOf('## Section {id=bb22}'), 'the slide sits right after its anchor (Opening) in the reordered talk')
  assert.equal(result.afterSlideTitle, 'Opening')
  assert.equal((disk.match(/Added after a reorder/g) || []).length, 2, 'once (its heading and its text)')

  // Overtaken again on the retry: refuse with the same words; nothing added.
  const path2 = talkFile(OUTLINE)
  const ed2 = fakeEditorWindow(path2)
  let n = 0
  const applies2 = []
  const typing = {
    async read() { const text = await ed2.editorBuffer.read(); ed2.type('- end', ` typing ${++n}`); return text },
    async commit(base, next) { const reply = await ed2.editorBuffer.commit(base, next); applies2.push(reply.ok ? 'ok' : reply.error); return reply },
  }
  const refused = await addInstantSlideToTalk(typing, path2, 'bb22', entry('text', { text: 'Never lands' }), { tools, storeImage: noImage, rng })
  assert.deepEqual(refused, { ok: false, error: 'The talk was edited while the slide was being added. Nothing was changed; try again.' })
  assert.equal(applies2.length, 2, 'one retry, no more')
  await ed2.idle()
  assert.ok(!ed2.doc.includes('Never lands') && !readFileSync(path2, 'utf8').includes('Never lands'), 'nothing was added')
  assert.ok(ed2.doc.includes('typing 1') && ed2.doc.includes('typing 2'), 'the typing is kept')
}

// Non-UTF-8 outline bytes would not survive a text round trip: refuse, write nothing.
{
  const path = talkFile('')
  const bytes = Buffer.concat([Buffer.from(OUTLINE.slice(0, 40)), Buffer.from([0xff, 0xfe]), Buffer.from(OUTLINE.slice(40))])
  writeFileSync(path, bytes)
  const result = await addInstantSlideToTalk(fileOutlineDocument(path), path, 'aa11', entry('text', { text: 'x' }), { tools, storeImage: noImage, rng })
  assert.equal(result.ok, false)
  assert.match(result.error, /not plain UTF-8/)
  assert.ok(readFileSync(path).equals(bytes))
}

console.log('instant-slide insert: text, link, countdown, image; first/middle/last/parent/moved/generated anchors; refusals; byte diffs; Run marking; Run path boundary; staged-write race; save ordering; tilde fences; symlinks; image checks; media escaping; round 2 (mode, read-only, decode, links, shared queue); round 3 (one queue and one editor window per real file); D1 buffer-first reorder, tag, publish stamp, adopt, icon pick, archive insert (saved through the queue at once), refusal wording per origin, Add to talk retried once after a reorder passed')
