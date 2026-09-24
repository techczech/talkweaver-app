import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  approveCleaned,
  approvePart,
  discardCleanedDraft,
  discardPartDraft,
  emptyCleanedStore,
  emptyNotesStore,
  listCleanedDrafts,
  listParts,
  createCleanedMoveUndoStore,
  moveCleanedDrafts,
  readCleanedStore,
  readNotesStore,
  undoCleanedDraftMove,
  writeCleanedDraft,
  writeCleanedStore,
  writeNotesStore
} from '../src/main/rewritePack.ts'

const root = mkdtempSync(join(tmpdir(), 'talkweaver-talktext-safety-'))

let pathSafety = null
let rendererSafety = null
let watcherSafety = null
let senderSafety = null
try {
  pathSafety = await import('../src/main/talkTextPathSafety.ts')
  rendererSafety = await import('../src/renderer/src/lib/talkTextRuntime.ts')
  watcherSafety = await import('../src/main/talkTextWatchers.ts')
  senderSafety = await import('../src/main/talkTextSender.ts')
} catch {
  /* assertions below report the missing safety seam */
}
assert.ok(pathSafety, 'TalkText path safety helpers must exist')
assert.ok(rendererSafety, 'TalkText renderer request safety helpers must exist')
assert.ok(watcherSafety, 'TalkText watcher lifecycle helpers must exist')
assert.ok(senderSafety, 'TalkText sender safety helper must exist')

const toolsSender = { id: 'tools' }
const mainSender = { id: 'main' }
const toolsWindow = { isDestroyed: () => false, webContents: toolsSender }
assert.equal(senderSafety.isToolsWindowSender(toolsSender, toolsWindow), true, 'Tools sender passes while Tools is open')
assert.equal(senderSafety.isToolsWindowSender(mainSender, toolsWindow), false, 'main sender is rejected while Tools is open')
assert.equal(senderSafety.isToolsWindowSender(toolsSender, null), false, 'Tools sender is rejected after Tools closes')
assert.equal(senderSafety.isToolsWindowSender(mainSender, null), false, 'main sender is rejected after Tools closes')

const vault = join(root, 'vault')
const talkDir = join(vault, '_PRESENTATIONS', 'safe-talk')
mkdirSync(talkDir, { recursive: true })
const safePaths = pathSafety.resolveTalkTextPaths(vault, 'safe-talk', 'session-1')
const canonicalVault = realpathSync(vault)
assert.equal(safePaths.packDir, join(canonicalVault, '_PRESENTATIONS', 'safe-talk', 'agent-rewrite', 'session-1'))
assert.equal(safePaths.partsDir, join(safePaths.packDir, 'parts'))
assert.equal(safePaths.cleanedDir, join(safePaths.packDir, 'cleaned'))
assert.equal(safePaths.notesStorePath, join(safePaths.packDir, 'notes.json'))
assert.equal(safePaths.cleanStorePath, join(safePaths.packDir, 'cleaned.json'))

const legacyPackDir = join(canonicalVault, '_PRESENTATIONS', 'safe-talk', 'agent-rewrite')
mkdirSync(join(legacyPackDir, 'parts'), { recursive: true })
mkdirSync(join(legacyPackDir, 'cleaned'), { recursive: true })
writeFileSync(join(legacyPackDir, 'transcript.md'), 'legacy transcript')
writeFileSync(join(legacyPackDir, 'parts', '01-legacy.md'), 'legacy part')
writeFileSync(join(legacyPackDir, 'cleaned', 'slide-1.md'), 'legacy cleaned slide')
writeNotesStore(join(legacyPackDir, 'session-1.notes.json'), approvePart(emptyNotesStore(), {
  slug: 'legacy',
  order: 1,
  markdown: 'legacy approval',
  approvedAt: '2026-07-17T00:00:00Z'
}))
assert.equal(existsSync(join(safePaths.packDir, 'transcript.md')), false, 'legacy transcript must not become this Run transcript')
assert.deepEqual(listParts(safePaths.partsDir), [], 'legacy draft parts must be ignored')
assert.deepEqual(listCleanedDrafts(safePaths.cleanedDir), [], 'legacy cleaned drafts must be ignored')
assert.deepEqual(readNotesStore(safePaths.notesStorePath), emptyNotesStore(), 'legacy approval store must be ignored')
assert.deepEqual(readCleanedStore(safePaths.cleanStorePath), emptyCleanedStore(), 'legacy clean approval store must be ignored')
for (const unsafeSlug of ['../x', 'a/b', '/absolute', '.', '..', '...', '']) {
  assert.throws(() => pathSafety.resolveTalkTextPaths(vault, unsafeSlug, 'session-1'), /invalid-talk-slug/)
}
for (const unsafeSession of ['../x', 'a/b', '/absolute', '.', '..', '...', '']) {
  assert.throws(() => pathSafety.resolveTalkTextPaths(vault, 'safe-talk', unsafeSession), /invalid-session-id/)
}
assert.throws(() => pathSafety.resolveTalkTextPaths(vault, 42, 'session-1'), /invalid-talk-slug/)
assert.throws(() => pathSafety.resolveTalkTextPaths(vault, 'safe-talk', null), /invalid-session-id/)
assert.throws(() => pathSafety.assertPathInsideVault(vault, join(vault, '..', 'outside')), /path-outside-vault/)
const outside = join(root, 'outside')
mkdirSync(outside)
const linkedOutside = join(vault, 'linked-outside')
symlinkSync(outside, linkedOutside)
assert.throws(() => pathSafety.assertPathInsideVault(vault, join(linkedOutside, 'file.md')), /path-outside-vault/)

const generation = rendererSafety.createRequestGeneration()
const stale = generation.begin()
const current = generation.begin()
const committed = []
assert.equal(generation.commit(stale, () => committed.push('stale')), false)
assert.equal(generation.commit(current, () => committed.push('current')), true)
assert.deepEqual(committed, ['current'], 'a superseded request must not commit stale state')

const surfaceGeneration = rendererSafety.createSurfaceRequestGeneration()
let surfaceLoading = false
const visibleRefresh = surfaceGeneration.begin(true, (loading) => { surfaceLoading = loading })
const quietRefresh = surfaceGeneration.begin(false, (loading) => { surfaceLoading = loading })
assert.equal(surfaceLoading, true, 'a quiet refresh inherits the visible refresh loading state')
assert.equal(surfaceGeneration.settle(visibleRefresh, (loading) => { surfaceLoading = loading }), false)
assert.equal(surfaceLoading, true, 'a superseded visible refresh cannot settle newer work')
assert.equal(surfaceGeneration.settle(quietRefresh, (loading) => { surfaceLoading = loading }), true)
assert.equal(surfaceLoading, false, 'the latest quiet refresh clears inherited loading when it settles')

const slideIndex = rendererSafety.buildSlideIndex([8, 3, 13])
assert.deepEqual([...slideIndex], [[8, 0], [3, 1], [13, 2]])

const audio = { readyState: 1, currentTime: 4, paused: true }
assert.equal(rendererSafety.seekLoadedAudio(audio, 12_500, 20_000), true)
assert.equal(audio.currentTime, 12.5, 'explicit slide navigation seeks loaded audio')
assert.equal(audio.paused, true, 'seeking does not change paused playback state')
const unloadedAudio = { readyState: 0, currentTime: 4, paused: false }
assert.equal(rendererSafety.seekLoadedAudio(unloadedAudio, 12_500, 20_000), false)
assert.equal(unloadedAudio.currentTime, 4, 'explicit slide navigation leaves unloaded audio alone')

const mergedNotes = rendererSafety.mergeNoteSources([
  { slug: 'draft', order: 1, fileName: '01-draft.md', markdown: 'Draft markdown' },
  { slug: 'shared', order: 3, fileName: '03-shared.md', markdown: 'Outdated draft' }
], [
  { slug: 'approved-only', order: 2, markdown: 'Approved without a draft', approvedAt: '2026-07-17T00:00:00Z' },
  { slug: 'shared', order: 3, markdown: 'Approved snapshot', approvedAt: '2026-07-17T00:01:00Z' }
])
assert.deepEqual(mergedNotes.map(({ slug, order, markdown, approved }) => ({ slug, order, markdown, approved })), [
  { slug: 'draft', order: 1, markdown: 'Draft markdown', approved: false },
  { slug: 'approved-only', order: 2, markdown: 'Approved without a draft', approved: true },
  { slug: 'shared', order: 3, markdown: 'Approved snapshot', approved: true }
])

const fakeWatchers = []
const watcherRegistry = watcherSafety.createDirectoryWatcherRegistry((_directory, _onChange) => {
  const fake = { closed: false, close() { this.closed = true }, on() { return this } }
  fakeWatchers.push(fake)
  return fake
})
watcherRegistry.acquire('/vault/talk/agent-rewrite/run-a/parts', 'run-a', () => {})
watcherRegistry.acquire('/vault/talk/agent-rewrite/run-a/parts', 'run-a', () => {})
watcherRegistry.acquire('/vault/talk/agent-rewrite/run-a/parts', 'secondary-owner', () => {})
assert.equal(fakeWatchers.length, 1, 'a canonical directory gets one filesystem watcher')
watcherRegistry.releaseOwner('run-a')
assert.equal(fakeWatchers[0].closed, false, 'watcher stays open while another owner references it')
watcherRegistry.releaseOwner('secondary-owner')
assert.equal(fakeWatchers[0].closed, true, 'watcher closes when its last owner releases it')

watcherRegistry.acquire('/vault/talk/agent-rewrite/run-a/cleaned', 'run-a', () => {})
watcherRegistry.acquire('/vault/talk/agent-rewrite/run-b/cleaned', 'run-b', () => {})
watcherRegistry.releaseAllExcept('run-b')
assert.equal(fakeWatchers[1].closed, true, 'session switch closes the previous Run watcher')
assert.equal(fakeWatchers[2].closed, false, 'session switch keeps the active Run watcher')
watcherRegistry.releaseAll()
assert.equal(fakeWatchers[2].closed, true, 'Tools window destruction closes remaining watchers')

const talkTextComponent = readFileSync(new URL('../src/renderer/src/components/TalkText.tsx', import.meta.url), 'utf8')
assert.match(talkTextComponent, /createRequestGeneration\(\)/)
assert.match(talkTextComponent, /createSurfaceRequestGeneration\(\)/)
assert.match(talkTextComponent, /requestGeneration\.current\.commit\(/)
assert.match(talkTextComponent, /notesGeneration\.current\.settle\(/)
assert.match(talkTextComponent, /cleanGeneration\.current\.settle\(/)
assert.match(talkTextComponent, /buildSlideIndex\(orderedNumbers\)/)
assert.doesNotMatch(talkTextComponent, /orderedNumbers\.indexOf\(/)
assert.match(talkTextComponent, /const ScriptSlideText = memo\(/)
assert.match(talkTextComponent, /const diff = useMemo\(/)
assert.match(talkTextComponent, /function PlaybackController\(/)
assert.match(talkTextComponent, /mergeNoteSources\(draftParts, approvedParts\)/)
assert.match(talkTextComponent, /const navigateToSlide = useCallback\(/)
assert.match(talkTextComponent, /if \(!follow \|\| !playing \|\| playingNumber == null\) return\s+showSlide\(playingNumber\)/)

const talkTextIpc = readFileSync(new URL('../src/main/talkTextIpc.ts', import.meta.url), 'utf8')
const handlerCount = [...talkTextIpc.matchAll(/ipcMain\.handle\('/g)].length
assert.equal(handlerCount, 22, 'the sender regression must cover every TalkText handler')
assert.equal(
  [...talkTextIpc.matchAll(/if \(!isToolsSender\(event\)\) return BAD_SENDER/g)].length,
  handlerCount,
  'every TalkText handler rejects senders other than the Tools window'
)
assert.match(
  talkTextIpc,
  /moveUndo\.releaseAllExcept\(watcherOwner\(talkSlug, sessionId\)\)/,
  'the handler session-switch path releases the previous Run undo with its watchers'
)
assert.match(
  talkTextIpc,
  /moveUndo\.releaseAll\(\)/,
  'the Tools-window-close path clears the remaining move undo'
)

const corruptNotesPath = join(root, 'corrupt.notes.json')
writeFileSync(corruptNotesPath, '{not-json')
assert.throws(
  () => writeNotesStore(corruptNotesPath, approvePart(readNotesStore(corruptNotesPath), {
    slug: 'intro',
    order: 1,
    markdown: 'Approved introduction',
    approvedAt: '2026-07-17T00:00:00Z'
  })),
  /Unexpected token|JSON/
)
assert.equal(readFileSync(corruptNotesPath, 'utf8'), '{not-json', 'corrupt store must be preserved')

const invalidCleanedPath = join(root, 'invalid.cleaned.json')
writeFileSync(invalidCleanedPath, '{}')
assert.throws(() => readCleanedStore(invalidCleanedPath), /approval-store-schema-invalid/)
assert.equal(readFileSync(invalidCleanedPath, 'utf8'), '{}', 'schema-invalid store must be preserved')
const unreadableNotesPath = join(root, 'unreadable.notes.json')
mkdirSync(unreadableNotesPath)
assert.throws(() => readNotesStore(unreadableNotesPath), /EISDIR|illegal operation on a directory/)
assert.deepEqual(readNotesStore(join(root, 'missing.notes.json')), emptyNotesStore())
assert.deepEqual(readCleanedStore(join(root, 'missing.cleaned.json')), emptyCleanedStore())
const unreadableCleanedPath = join(root, 'unreadable-cleaned')
writeFileSync(unreadableCleanedPath, 'not a directory')
assert.throws(() => listCleanedDrafts(unreadableCleanedPath), /ENOTDIR/)

const atomicPath = join(root, 'atomic.notes.json')
const originalNotes = approvePart(emptyNotesStore(), {
  slug: 'original',
  order: 1,
  markdown: 'Original',
  approvedAt: '2026-07-17T00:00:00Z'
})
const replacementNotes = approvePart(originalNotes, {
  slug: 'replacement',
  order: 2,
  markdown: 'Replacement',
  approvedAt: '2026-07-17T00:01:00Z'
})
writeNotesStore(atomicPath, originalNotes)
assert.throws(
  () => writeNotesStore(atomicPath, replacementNotes, { beforeCommit: () => { throw new Error('simulated-interruption') } }),
  /simulated-interruption/
)
assert.deepEqual(readNotesStore(atomicPath), originalNotes, 'failed atomic write must leave a valid original store')
assert.equal(readdirSync(root).some((name) => name.endsWith('.tmp')), false, 'failed atomic write must clean its temp file')
writeNotesStore(atomicPath, replacementNotes)
assert.deepEqual(readNotesStore(atomicPath), replacementNotes)
assert.deepEqual(JSON.parse(readFileSync(`${atomicPath}.bak`, 'utf8')), originalNotes, 'successful write must back up the prior store')

const cleanedDir = join(root, 'cleaned')
const cleanedStorePath = join(root, 'session.cleaned.json')
writeCleanedDraft(cleanedDir, 1, 'Source text')
writeCleanedDraft(cleanedDir, 2, 'Destination text')
const approved = approveCleaned(approveCleaned(emptyCleanedStore(), {
  slideNumber: 1,
  markdown: 'Source text',
  approvedAt: '2026-07-17T00:00:00Z'
}), {
  slideNumber: 2,
  markdown: 'Destination text',
  approvedAt: '2026-07-17T00:00:00Z'
})
writeCleanedStore(cleanedStorePath, approved)

const steps = []
assert.throws(() => moveCleanedDrafts({
  cleanedDir,
  cleanStorePath: cleanedStorePath,
  source: { slideNumber: 1, markdown: 'Source' },
  destination: { slideNumber: 2, markdown: 'text\n\nDestination text' },
  afterDraftWrite: (step) => {
    steps.push(step)
    if (step === 'destination') throw new Error('simulated-source-failure')
  }
}), /simulated-source-failure/)
assert.deepEqual(steps, ['destination'], 'transaction must write the destination first')
assert.equal(readFileSync(join(cleanedDir, 'slide-1.md'), 'utf8'), 'Source text\n')
assert.equal(readFileSync(join(cleanedDir, 'slide-2.md'), 'utf8'), 'Destination text\n')
assert.deepEqual(readCleanedStore(cleanedStorePath), approved, 'failed move must preserve approval state')

const rollbackDestination = join(cleanedDir, 'slide-2.md')
assert.throws(() => moveCleanedDrafts({
  cleanedDir,
  cleanStorePath: cleanedStorePath,
  source: { slideNumber: 1, markdown: 'Source changed' },
  destination: { slideNumber: 2, markdown: 'Destination changed' },
  afterDraftWrite: (step) => {
    if (step !== 'source') return
    const sourcePath = join(cleanedDir, 'slide-1.md')
    unlinkSync(sourcePath)
    mkdirSync(sourcePath)
    throw new Error('simulated-rollback-with-source-restore-failure')
  }
}))
assert.equal(
  readFileSync(rollbackDestination, 'utf8'),
  'Destination text\n',
  'destination restoration must still run when source restoration fails'
)
rmdirSync(join(cleanedDir, 'slide-1.md'))
writeFileSync(join(cleanedDir, 'slide-1.md'), 'Source text\n')

moveCleanedDrafts({
  cleanedDir,
  cleanStorePath: cleanedStorePath,
  source: { slideNumber: 1, markdown: 'Source' },
  destination: { slideNumber: 2, markdown: 'text\n\nDestination text' }
})
assert.equal(readFileSync(join(cleanedDir, 'slide-1.md'), 'utf8'), 'Source\n')
assert.equal(readFileSync(join(cleanedDir, 'slide-2.md'), 'utf8'), 'text\n\nDestination text\n')
assert.deepEqual(readCleanedStore(cleanedStorePath), emptyCleanedStore(), 'successful move returns both slides to review')

const undoDir = join(root, 'undo-cleaned')
const undoStorePath = join(root, 'undo.cleaned.json')
mkdirSync(undoDir, { recursive: true })
const sourceBefore = 'Source text with exact trailing bytes\n\n'
const destinationBefore = 'Destination text without a final newline'
writeFileSync(join(undoDir, 'slide-1.md'), sourceBefore)
writeFileSync(join(undoDir, 'slide-2.md'), destinationBefore)
const undoApproved = approveCleaned(approveCleaned(emptyCleanedStore(), {
  slideNumber: 1,
  markdown: 'Approved source',
  approvedAt: '2026-07-17T01:00:00Z'
}), {
  slideNumber: 2,
  markdown: 'Approved destination',
  approvedAt: '2026-07-17T01:01:00Z'
})
writeCleanedStore(undoStorePath, undoApproved)
const undoSnapshot = moveCleanedDrafts({
  cleanedDir: undoDir,
  cleanStorePath: undoStorePath,
  source: { slideNumber: 1, markdown: 'Moved source remainder' },
  destination: { slideNumber: 2, markdown: 'Moved text\n\nDestination' }
})
undoCleanedDraftMove({ cleanedDir: undoDir, cleanStorePath: undoStorePath, snapshot: undoSnapshot })
assert.equal(readFileSync(join(undoDir, 'slide-1.md'), 'utf8'), sourceBefore, 'undo restores source bytes exactly')
assert.equal(readFileSync(join(undoDir, 'slide-2.md'), 'utf8'), destinationBefore, 'undo restores destination bytes exactly')
assert.deepEqual(readCleanedStore(undoStorePath), undoApproved, 'undo restores both approval entries exactly')

function sessionMoveFixture(name, key, sourceBefore, destinationBefore) {
  const dir = join(root, name)
  const storePath = join(root, `${name}.cleaned.json`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'slide-1.md'), sourceBefore)
  writeFileSync(join(dir, 'slide-2.md'), destinationBefore)
  writeCleanedStore(storePath, emptyCleanedStore())
  const snapshot = moveCleanedDrafts({
    cleanedDir: dir,
    cleanStorePath: storePath,
    source: { slideNumber: 1, markdown: `${name} source after move` },
    destination: { slideNumber: 2, markdown: `${name} destination after move` }
  })
  return { dir, storePath, key, snapshot, sourceBefore, destinationBefore }
}

function assertMoveStateUnchanged(fixture, sourceBytes, destinationBytes, message) {
  assert.equal(readFileSync(join(fixture.dir, 'slide-1.md'), 'utf8'), sourceBytes, `${message}: source`)
  assert.equal(readFileSync(join(fixture.dir, 'slide-2.md'), 'utf8'), destinationBytes, `${message}: destination`)
}

const releasedMoves = createCleanedMoveUndoStore()
const releasedRunA = sessionMoveFixture(
  'undo-released-run-a',
  'safe-talk\u0000run-a',
  'Run A source before\n',
  'Run A destination before\n'
)
releasedMoves.remember(releasedRunA.key, releasedRunA.snapshot)
const releasedSourceAfter = readFileSync(join(releasedRunA.dir, 'slide-1.md'), 'utf8')
const releasedDestinationAfter = readFileSync(join(releasedRunA.dir, 'slide-2.md'), 'utf8')
releasedMoves.releaseAllExcept('safe-talk\u0000run-b')
assert.throws(
  () => releasedMoves.undo(releasedRunA.key, releasedRunA.dir, releasedRunA.storePath),
  /undo-stale/,
  'a Run released by the session-switch path cannot execute its old undo'
)
assertMoveStateUnchanged(
  releasedRunA,
  releasedSourceAfter,
  releasedDestinationAfter,
  'released Run undo leaves its files untouched'
)

const closedWindowMoves = createCleanedMoveUndoStore()
const closedWindowRun = sessionMoveFixture(
  'undo-tools-window-closed',
  'safe-talk\u0000window-run',
  'Window source before\n',
  'Window destination before\n'
)
closedWindowMoves.remember(closedWindowRun.key, closedWindowRun.snapshot)
closedWindowMoves.releaseAll()
assert.throws(
  () => closedWindowMoves.undo(closedWindowRun.key, closedWindowRun.dir, closedWindowRun.storePath),
  /cleaned-draft-move-undo-unavailable/,
  'Tools-window teardown clears the owned move snapshot'
)

const latestMoves = createCleanedMoveUndoStore()
const latestRunA = sessionMoveFixture('undo-latest-run-a', 'safe-talk\u0000run-a', 'A source\n', 'A destination\n')
latestMoves.remember(latestRunA.key, latestRunA.snapshot)
const latestRunB = sessionMoveFixture('undo-latest-run-b', 'safe-talk\u0000run-b', 'B source\n', 'B destination\n')
latestMoves.remember(latestRunB.key, latestRunB.snapshot)
const latestRunASourceAfter = readFileSync(join(latestRunA.dir, 'slide-1.md'), 'utf8')
const latestRunADestinationAfter = readFileSync(join(latestRunA.dir, 'slide-2.md'), 'utf8')
assert.throws(
  () => latestMoves.undo(latestRunA.key, latestRunA.dir, latestRunA.storePath),
  /undo-stale/,
  'a move in Run B replaces Run A as the only undoable move'
)
assertMoveStateUnchanged(
  latestRunA,
  latestRunASourceAfter,
  latestRunADestinationAfter,
  'replaced Run A undo leaves Run A files untouched'
)
latestMoves.undo(latestRunB.key, latestRunB.dir, latestRunB.storePath)
assertMoveStateUnchanged(
  latestRunB,
  latestRunB.sourceBefore,
  latestRunB.destinationBefore,
  "a refused stale undo must not destroy the rightful owner's slot"
)
const winningMoves = createCleanedMoveUndoStore()
const supersededRunA = sessionMoveFixture('undo-superseded-run-a', 'safe-talk\u0000run-a', 'A2 source\n', 'A2 destination\n')
winningMoves.remember(supersededRunA.key, supersededRunA.snapshot)
const winningRunB = sessionMoveFixture('undo-winning-run-b', 'safe-talk\u0000run-b', 'B2 source\n', 'B2 destination\n')
winningMoves.remember(winningRunB.key, winningRunB.snapshot)
winningMoves.undo(winningRunB.key, winningRunB.dir, winningRunB.storePath)
assertMoveStateUnchanged(
  winningRunB,
  winningRunB.sourceBefore,
  winningRunB.destinationBefore,
  'after Run A then Run B moves, the matching Run B undo restores exact bytes'
)

const matchingMoves = createCleanedMoveUndoStore()
const matchingRun = sessionMoveFixture(
  'undo-matching-session',
  'safe-talk\u0000matching-run',
  'Matching source without newline',
  'Matching destination\n\n'
)
matchingMoves.remember(matchingRun.key, matchingRun.snapshot)
matchingMoves.undo(matchingRun.key, matchingRun.dir, matchingRun.storePath)
assertMoveStateUnchanged(
  matchingRun,
  matchingRun.sourceBefore,
  matchingRun.destinationBefore,
  'matching-session undo restores exact bytes'
)

function staleUndoFixture(name, sourceSlide, destinationSlide) {
  const dir = join(root, name)
  const storePath = join(root, `${name}.cleaned.json`)
  const moves = createCleanedMoveUndoStore()
  const key = `${name}\u0000session-1`
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `slide-${sourceSlide}.md`), 'Source before\n')
  writeFileSync(join(dir, `slide-${destinationSlide}.md`), 'Destination before\n')
  writeCleanedStore(storePath, emptyCleanedStore())
  moves.remember(key, moveCleanedDrafts({
    cleanedDir: dir,
    cleanStorePath: storePath,
    source: { slideNumber: sourceSlide, markdown: 'Source after move' },
    destination: { slideNumber: destinationSlide, markdown: 'Destination after move' }
  }))
  return { dir, storePath, moves, key }
}

function assertStaleSnapshotCleared(fixture) {
  assert.throws(
    () => fixture.moves.undo(fixture.key, fixture.dir, fixture.storePath),
    /cleaned-draft-move-undo-unavailable/,
    'a stale undo attempt clears its snapshot'
  )
}

const externalDestination = staleUndoFixture('undo-external-destination', 7, 8)
const externalDestinationPath = join(externalDestination.dir, 'slide-8.md')
const externalDestinationBytes = 'Agent changed the destination without a final newline'
writeFileSync(externalDestinationPath, externalDestinationBytes)
assert.throws(
  () => externalDestination.moves.undo(externalDestination.key, externalDestination.dir, externalDestination.storePath),
  /undo-stale/,
  'undo refuses an external destination edit'
)
assert.equal(readFileSync(externalDestinationPath, 'utf8'), externalDestinationBytes, 'refused undo preserves destination bytes exactly')
assertStaleSnapshotCleared(externalDestination)

const externalSource = staleUndoFixture('undo-external-source', 9, 10)
const externalSourcePath = join(externalSource.dir, 'slide-9.md')
const externalSourceBytes = 'Agent changed the source\n\n'
writeFileSync(externalSourcePath, externalSourceBytes)
assert.throws(
  () => externalSource.moves.undo(externalSource.key, externalSource.dir, externalSource.storePath),
  /undo-stale/,
  'undo refuses an external source edit'
)
assert.equal(readFileSync(externalSourcePath, 'utf8'), externalSourceBytes, 'refused undo preserves source bytes exactly')
assertStaleSnapshotCleared(externalSource)

const externalDelete = staleUndoFixture('undo-external-delete', 11, 12)
const externallyDeletedPath = join(externalDelete.dir, 'slide-12.md')
unlinkSync(externallyDeletedPath)
assert.throws(
  () => externalDelete.moves.undo(externalDelete.key, externalDelete.dir, externalDelete.storePath),
  /undo-stale/,
  'undo refuses an externally deleted moved file'
)
assert.equal(existsSync(externallyDeletedPath), false, 'refused undo preserves the external deletion')
assertStaleSnapshotCleared(externalDelete)

const externalApproval = staleUndoFixture('undo-external-approval', 13, 14)
const externallyChangedStore = approveCleaned(emptyCleanedStore(), {
  slideNumber: 14,
  markdown: 'Approved after the move',
  approvedAt: '2026-07-17T02:00:00Z'
})
writeCleanedStore(externalApproval.storePath, externallyChangedStore)
assert.throws(
  () => externalApproval.moves.undo(externalApproval.key, externalApproval.dir, externalApproval.storePath),
  /undo-stale/,
  'undo refuses an externally changed approval entry'
)
assert.deepEqual(readCleanedStore(externalApproval.storePath), externallyChangedStore, 'refused undo preserves external approval state')
assertStaleSnapshotCleared(externalApproval)

const absentDestinationDir = join(root, 'undo-absent-destination')
const absentDestinationStorePath = join(root, 'undo-absent-destination.cleaned.json')
mkdirSync(absentDestinationDir, { recursive: true })
writeFileSync(join(absentDestinationDir, 'slide-3.md'), 'Only source existed\n')
writeCleanedStore(absentDestinationStorePath, approveCleaned(emptyCleanedStore(), {
  slideNumber: 3,
  markdown: 'Only source existed',
  approvedAt: '2026-07-17T01:02:00Z'
}))
const absentDestinationSnapshot = moveCleanedDrafts({
  cleanedDir: absentDestinationDir,
  cleanStorePath: absentDestinationStorePath,
  source: { slideNumber: 3, markdown: 'Source remainder' },
  destination: { slideNumber: 4, markdown: 'Moved into a new draft' }
})
undoCleanedDraftMove({
  cleanedDir: absentDestinationDir,
  cleanStorePath: absentDestinationStorePath,
  snapshot: absentDestinationSnapshot
})
assert.equal(existsSync(join(absentDestinationDir, 'slide-4.md')), false, 'undo removes a destination draft that was previously absent')

const undoMoves = createCleanedMoveUndoStore()
const invalidationKey = 'safe-talk\u0000session-1'
const invalidationSnapshot = moveCleanedDrafts({
  cleanedDir: absentDestinationDir,
  cleanStorePath: absentDestinationStorePath,
  source: { slideNumber: 3, markdown: 'Changed again' },
  destination: { slideNumber: 4, markdown: 'New destination' }
})
undoMoves.remember(invalidationKey, invalidationSnapshot)
writeCleanedDraft(absentDestinationDir, 3, 'Intervening save')
undoMoves.invalidate(invalidationKey, 3)
assert.throws(
  () => undoMoves.undo(invalidationKey, absentDestinationDir, absentDestinationStorePath),
  /cleaned-draft-move-undo-unavailable/,
  'saving either moved slide invalidates its undo snapshot'
)
assert.equal(readFileSync(join(absentDestinationDir, 'slide-3.md'), 'utf8'), 'Intervening save\n')

const corruptUndoDir = join(root, 'undo-corrupt-store')
const corruptUndoStorePath = join(root, 'undo-corrupt-store.cleaned.json')
mkdirSync(corruptUndoDir, { recursive: true })
writeFileSync(join(corruptUndoDir, 'slide-5.md'), 'Before source\n')
writeFileSync(join(corruptUndoDir, 'slide-6.md'), 'Before destination\n')
writeCleanedStore(corruptUndoStorePath, emptyCleanedStore())
const corruptUndoSnapshot = moveCleanedDrafts({
  cleanedDir: corruptUndoDir,
  cleanStorePath: corruptUndoStorePath,
  source: { slideNumber: 5, markdown: 'Current source' },
  destination: { slideNumber: 6, markdown: 'Current destination' }
})
const currentSource = readFileSync(join(corruptUndoDir, 'slide-5.md'), 'utf8')
const currentDestination = readFileSync(join(corruptUndoDir, 'slide-6.md'), 'utf8')
const corruptUndoMoves = createCleanedMoveUndoStore()
const corruptUndoKey = 'undo-corrupt-store\u0000session-1'
corruptUndoMoves.remember(corruptUndoKey, corruptUndoSnapshot)
writeFileSync(corruptUndoStorePath, '{not-json')
assert.throws(
  () => corruptUndoMoves.undo(corruptUndoKey, corruptUndoDir, corruptUndoStorePath),
  /undo-stale/
)
assert.equal(readFileSync(join(corruptUndoDir, 'slide-5.md'), 'utf8'), currentSource, 'corrupt store leaves current source intact')
assert.equal(readFileSync(join(corruptUndoDir, 'slide-6.md'), 'utf8'), currentDestination, 'corrupt store leaves current destination intact')
assert.equal(readFileSync(corruptUndoStorePath, 'utf8'), '{not-json', 'corrupt store is not overwritten during failed undo')
assertStaleSnapshotCleared({ dir: corruptUndoDir, storePath: corruptUndoStorePath, moves: corruptUndoMoves, key: corruptUndoKey })

assert.throws(
  () => writeCleanedDraft(cleanedDir, 2, '', { allowEmpty: false }),
  /empty-cleaned-slide-requires-confirmation/
)
assert.equal(readFileSync(join(cleanedDir, 'slide-2.md'), 'utf8'), 'text\n\nDestination text\n')
writeCleanedDraft(cleanedDir, 2, '', { allowEmpty: true })
assert.equal(readFileSync(join(cleanedDir, 'slide-2.md'), 'utf8'), '\n')

const corruptDiscardNotesStore = join(root, 'discard-corrupt.notes.json')
const discardPartPath = join(root, 'discard-part.md')
writeFileSync(corruptDiscardNotesStore, '{not-json')
writeFileSync(discardPartPath, 'keep this part')
assert.throws(() => discardPartDraft(discardPartPath, corruptDiscardNotesStore, 'part'), /Unexpected token|JSON/)
assert.equal(existsSync(discardPartPath), true, 'corrupt notes store must leave the part draft in place')

const corruptDiscardCleanStore = join(root, 'discard-corrupt.cleaned.json')
const discardCleanPath = join(root, 'discard-clean.md')
writeFileSync(corruptDiscardCleanStore, '{not-json')
writeFileSync(discardCleanPath, 'keep this clean draft')
assert.throws(() => discardCleanedDraft(discardCleanPath, corruptDiscardCleanStore, 3), /Unexpected token|JSON/)
assert.equal(existsSync(discardCleanPath), true, 'corrupt clean store must leave the cleaned draft in place')

assert.equal(existsSync(`${cleanedStorePath}.bak`), true)
console.log('talktext safety: fail-closed stores, atomic writes, transactional moves and empty-write guard passed')
