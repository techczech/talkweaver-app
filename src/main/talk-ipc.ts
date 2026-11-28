import { TAKES_OFF_ERROR } from '../shared/recording-takes'
import { saveOfflinePage } from './offline-page'
import type { MediaPublishChoice } from '../shared/publish-status'
import { parseOutlineSaveIdentity } from '../shared/outline-save-identity'
import type { SlideMergeChoices } from '../shared/outline-merge'
import { join, basename, dirname, extname } from 'path'
import { pathToFileURL } from 'url'
import { registerWindowKind } from './window-kinds'
import { canonicalOutlinePath, outlineIdentity } from './outline-identity'
import { readTalkOutline, writeTalkOutline } from './talk-writer'
import { existsSync, statSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { createHash, randomUUID } from 'crypto'
import { resolve as resolvePath } from 'path'
import { thumbCacheDir } from './vault-paths'
import { pathStaysInside } from './path-containment'
import { copySlideLocalFiles, hasSlideLocalFile } from './slide-local-files'
import { copyPastedSlideFiles } from './widget-repair'
import { extractImageRefs, resolveImagePaths } from './slide-image-refs'
import { convertibleImageRefs, planOptimisation, rewriteConvertedRefs, writeNewFile, type AssetContainment } from './optimise-images'
import { preparedTalkGroup } from './prepared-talk-cache'
import { isSuperseded } from './single-flight'
import { BROWSER_THUMBNAIL_LANE, THUMBNAIL_HEAP_WAIT_MAX_MS, heapGuardDecision, thumbnailMediaOptions, waitForHeap } from './thumbnail-media-policy'
import { writableRoot } from './vault-availability'
import { VAULTS_DIR, isPlainSegment, talkThumbDir, thumbLookupDirs, thumbUrl } from './thumb-cache-dirs'
import { selectedThumbnailSlide, thumbnailSlides } from '../shared/slide-preview'
import { readFile as readFileAsync } from 'fs/promises'
import { type RetakeContext } from './recording'
import { runAtHome } from './recording-paths'
import { extractSection, type SectionLocation } from '../shared/insert-section'
import { unresolvedOutboundFailure } from '../shared/layout-doctor'
import { livePresenterContext, type LivePresenterContext } from './live-session-manager'
import { presenterLink } from './presenter-publication'
import { presentedTalkVault } from './presented-vault'
import { isToolsWindowSender } from './talkTextSender'
import { writeGeneratedFile } from './generated-file-write'
import { withoutPreworkSlides, type CompiledPrework } from '../shared/run-prework'
import { prepareCrossVaultInsert, type SlideOrigin } from './cross-vault-insert'
import { deckWindowKeyAction, deckWindowMode } from './deck-window-keys'
import { presentWindowPreferences } from './present-window-prefs'
import { followRemotePages } from './remote-page-follow'
import { pairLivePageHosts } from './live-page-host'
import { pageTitleOf } from '../shared/page-title.ts'
import { plainInlineText } from '../../compiler/scripts/lib/00-inline-render.mjs'
import { withTalkTitle } from './present-title'
import { publishTalkHandout } from './talk-handout-publish'
import type { TalkIpcHost, EmbedStatus, ProjectionRowMain } from './index'

/** Registers talk channels on the app's already guarded IPC object. */
export function registerTalkIpc(host: TalkIpcHost): void {
  const {
    ipcMain, BrowserWindow, E2E, TAKES_ENABLED, app, assetRootsFor, attachLivePageHost, attachLiveWindow,
    browserThumbnailMediaOptions, buildTalkPresentFile, buildVaultAssetIndex,
    cancelQuitAttempt, checkEmbedUrl, crossVaultTools, currentVaultRoot, deckWindowOpenOpts,
    editorRevisions, editorWindows, extractDeckEmbeds, findTalks, getCompilerPath, getConfig, guideLearn,
    htmlPageRunImport, invalidateVaultCaches, lastSaveFailed, lastUnsavedText,
    latestThumbnailRequest, ledgerSeal, livePageAllowance, livePageHosts, livePresenterContexts,
    localHandoutWorkerBaseUrl, logThumbnails, maybeOfferOutlineMigration, metadataDefaults, mkdirInVault,
    normaliseToWebp, ocrCandidates, ocrIndex, openDeckAudience, outlineDiskGuard, outlineRecovery, outlineSlideMerge,
    outlineRefused, outlineUrlOnDisk, pendingOrigins, pictureTextForCompile, plannedRunOf, prepareTalk,
    preparedTalkCache, presentWindows, presentedVaultDeps, presenterAudienceWindows, presenterGuide,
    provenanceStore, refreshDeckFromEditor, resolveOcrBin,
    resolvePooledRefs, rootFs, screen, shell, talkActivity, talkThumbCacheDir, thumbNamespaceDir,
    thumbnailDocumentId, thumbnailTalkOwner, timerSettings, vaultAvailable, vaultIdOf, vaultNameOf,
    variantMedia, vaultRegistry, vaultRootFor, verifiedRunSource, writableRootFor, writableTalkRoot, writableVaultRoot,
    writeOutlineFromEditor,
    captureOfflinePage, clearThumbnailFocus, guardDeckWindowTree, offlineSource, parseRetake,
    recordingAudioArmed, registerRecordingContext, renderThumbnails, sendRecordingCloseOffer,
    setThumbnailFocus, setupRecordingPermissions, shouldOfferRunSave, supersedeThumbnailRender,
    unregisterRecordingContext, updateTestSaveDelay, verifyRetake,
  } = host

  ipcMain.handle('talk:save-offline-page', (_event, input: unknown) => saveOfflinePage(input, {
    writableTalkRoot,
    runImport: htmlPageRunImport,
    capture: async (input, target) => {
      const source = offlineSource(target, input.source, livePageAllowance)
      if (!source) throw Error('Page refused')
      return captureOfflinePage(source, livePageAllowance)
    }
  }))

  // The talk's Activity lines (Inspector), newest first. The talk is named by its outline path; its
  // vault and slug key the local file. A path in no vault has no Activity.
  ipcMain.handle('talk:activity', async (_event, outlinePath: unknown) => {
    if (typeof outlinePath !== 'string' || !outlinePath.endsWith('-outline.md')) return []
    const hit = vaultRegistry.resolve(outlinePath)
    if (!hit) return []
    return talkActivity.list(hit.vault.id, basename(outlinePath).replace(/-outline\.md$/, ''))
  })

  // The editor's live preview. Keyed by window + talk, so a newer revision from the same window drops an
  // older one still waiting on the preparation gate; that caller gets `{ superseded: true }`, which the
  // renderer ignores (a newer reply for the same talk is on its way). Nothing else is ever dropped.
  ipcMain.handle('talk:compile', async (event, outlinePath: string, content: string) => {
    try {
      const prepared = await prepareTalk(outlinePath, content, undefined, undefined, 'live', `${event.sender.id}\0${outlinePath}`)
      return prepared?.rows ?? null
    } catch (e) {
      if (isSuperseded(e)) return { superseded: true as const }
      console.error('[compile]', e)
      return null
    }
  })

  ipcMain.handle('talk:selected-thumbnail', async (_event, outlinePath: string, content: string, slideId: string) => {
    const refusal = outlineRefused(outlinePath) // writes beside the outline: refuse one outside the vault
    if (refusal) return null
    try {
      const prepared = await prepareTalk(outlinePath, content)
      if (!prepared) return null
      const fullHtml = prepared.model.fullHtml
      if (typeof fullHtml !== 'string' || !prepared.rows) return null
      const documentId = thumbnailDocumentId(fullHtml, prepared.previewKey)
      const selected = selectedThumbnailSlide(prepared.rows, String(slideId), documentId)
      if (!selected) return null
      const cacheDir = talkThumbCacheDir(outlinePath, prepared.slug)
      const rendered = await renderThumbnails({ fullHtml, deckKey: prepared.previewKey, preview: prepared.preview, slides: [selected], cacheDir })
      const renderedPath = rendered[selected.key]
      return renderedPath
        ? { slideId: String(slideId), url: thumbUrl(prepared.slug, basename(renderedPath, '.png'), vaultIdOf(outlinePath)) }
        : null
    } catch (e) {
      console.error('[selected-thumbnail]', e)
      return null
    }
  })

  ipcMain.handle('talk:check-embeds', async (_event, outlinePath: string, content: string): Promise<EmbedStatus[]> => {
    const compilerDir = getCompilerPath()
    if (!compilerDir) return []
    try {
      const { parseVideoEmbed } = await import(pathToFileURL(join(compilerDir, 'lib/02-triggers-layout.mjs')).href)
      const prepared = await prepareTalk(outlinePath, content, undefined, undefined, 'variant', undefined, { preview: false })
      if (!prepared) return []
      const embeds = extractDeckEmbeds(String(prepared.model.fullHtml ?? ''))
      if (!embeds.length) return []
      // Check each unique URL once, then map the result back to every slide that uses it.
      const uniqueUrls = Array.from(new Set(embeds.map((e) => e.url)))
      const results = await Promise.all(uniqueUrls.map((u) => checkEmbedUrl(u, parseVideoEmbed)))
      const byUrl = new Map(uniqueUrls.map((u, i) => [u, results[i]]))
      return embeds.map((e) => {
        const r = byUrl.get(e.url)!
        return { slideId: e.slideId, title: e.title, url: e.url, kind: r.kind, status: r.status, detail: r.detail }
      })
    } catch (e) {
      console.error('[check-embeds]', e)
      return []
    }
  })

  // ── Explain rendering (the per-slide decision trace, ADR-0024) ───────────────
  // Reads the ACTUAL compiled decisions off the rendered <section> for one slide — not a guess.
  // The engine stamps every render decision as a data-* attribute on the slide's <section>
  // (data-layout / data-title-layout / data-role / data-mode / data-split),
  // plus the trigger tokens the author wrote. We return those verbatim so the renderer can show
  // "why did this slide look like this" on right-click. Index = the slide's position in the deck
  // (same order as compile()'s projection rows).
  ipcMain.handle('talk:explain-slide', async (_event, outlinePath: string, content: string, index: number) => {
    try {
      const prepared = await prepareTalk(outlinePath, content, undefined, undefined, 'variant', undefined, { preview: false })
      if (!prepared) return null
      const rows = (prepared.rows ?? []) as ProjectionRowMain[]
      const fullHtml = String(prepared.model.fullHtml ?? '')
      // The Nth `<section class="slide" …>` opening tag is this slide's render decisions.
      const tags = fullHtml.match(/<section class="slide"[^>]*>/g) ?? []
      if (index < 0 || index >= tags.length) return null
      const tag = tags[index]
      const attr = (name: string): string => {
        const m = tag.match(new RegExp(`data-${name}="([^"]*)"`))
        return m ? m[1] : ''
      }
      const row = rows[index] ?? ({} as ProjectionRowMain)
      // Trigger tokens the author wrote on the slide's Trigger line (the {…}-only line after the heading).
      const src = String(row.source_markdown ?? '')
      const triggerLine = src.split('\n').slice(1).find((l) => /^\s*(\{[^}]*\}\s*)+$/.test(l)) ?? ''
      const triggers = (triggerLine.match(/\{[^}]*\}/g) ?? [])
      return {
        navTitle: row.nav_title || row.title || '',
        layout: attr('layout'),
        titleLayout: attr('title-layout'), // 'left' | 'top' | '' (none/nav-only)
        role: attr('role'),
        mode: attr('mode'),
        split: attr('split'),
        triggers,
        wordCount: row.word_count ?? 0,
        bulletCount: (row as { bullet_count?: number }).bullet_count ?? 0,
        imageCount: (row as { image_count?: number }).image_count ?? 0,
        warnings: Array.isArray(row.warnings) ? row.warnings : []
      }
    } catch (e) {
      console.error('[explain-slide]', e)
      return null
    }
  })

  // The text read from the pictures each slide block names (the same picture text the Slide Browser's search reads),
  // one string per block, '' when none. The grid and the outline search it for "in picture:" hits (ticket 2).
  // Rises whenever the OCR index changes (a picture read later in the background), so the renderer cache refetches.
  ipcMain.handle('talk:slide-picture-generation', (): number => ocrIndex.generation())

  ipcMain.handle('talk:slide-picture-text', (_event, outlinePath: unknown, blocks: unknown): string[] => {
    if (typeof outlinePath !== 'string' || !Array.isArray(blocks)) return []
    const vaultRoot = vaultRootFor(outlinePath)
    if (!vaultRoot) return blocks.map(() => '')
    const talkDir = dirname(outlinePath)
    return blocks.map((block) => {
      if (typeof block !== 'string' || !block) return ''
      let text = ''
      for (const path of resolveImagePaths(extractImageRefs(block), talkDir, vaultRoot)) {
        const entry = ocrIndex.entry(path)
        if (entry && !entry.failed && !entry.skipped && entry.text) text += (text ? '\n' : '') + entry.text
      }
      return text
    })
  })

  // Manual trigger for the OCR index (command palette): runs whatever the setting says and reports
  // what really happened.
  ipcMain.handle('talk:ocr-index', async () => {
    if (!currentVaultRoot()) return { success: false, error: 'No vault root' }
    if (!resolveOcrBin()) return { success: false, error: 'OCR helper not found (rebuild the app)' }
    const counts = await ocrIndex.runNow(ocrCandidates())
    ocrIndex.flush()
    return { success: true, total: counts.total, read: counts.read, known: counts.known, failed: counts.failed, skipped: counts.skipped, cached: ocrIndex.size(), added: counts.read }
  })

  // `forEditor`: the editor window is loading this talk (Editor.tsx) — the text it gets is the external-
  // change guard's baseline for the file (outline-disk-guard.ts). Every other reader leaves it alone.
  ipcMain.handle('talk:read-outline', async (event, outlinePath: string, opts?: { forEditor?: boolean; revision?: unknown }) => {
    const refusal = outlineRefused(outlinePath) // writes beside the outline: refuse one outside the vault
    if (refusal) return null
    try {
      const savedAt = opts?.forEditor === true ? statSync(outlinePath).mtimeMs : undefined
      const text = await readFileAsync(outlinePath, 'utf8')
      const loaded = await maybeOfferOutlineMigration(outlinePath, text)
      if (opts?.forEditor === true && typeof loaded === 'string') {
        // Only the window that has claimed this talk (window:claim-talk) becomes its guard owner.
        const claimed = editorWindows.get(event.sender.id)?.outlinePath
        if (claimed && outlineIdentity(claimed).key === outlineIdentity(outlinePath).key) {
          outlineDiskGuard.track(String(event.sender.id), outlinePath, loaded, loaded === text ? savedAt : statSync(outlinePath, { throwIfNoEntry: false })?.mtimeMs)
          // The text loaded is the file's, at the editor's revision now (editor-revisions.ts).
          editorRevisions.loaded(event.sender.id, opts.revision)
        } else {
          console.warn(`[outline-guard] an editor load of ${outlinePath} from a window that has not claimed it was not tracked`)
        }
      }
      return loaded
    } catch (e) {
      return null
    }
  })

  // External-change guard (shared-talk ticket 01): the file's text and version as it stands on disk
  // (Reload), and accepting the version the person saw (Keep mine, and Reload once the text is in the
  // editor). See outline-disk-guard.ts.
  // Every request must come from the window that has the talk open (the guard's owner for that file).
  ipcMain.handle('talk:outline-disk-version', async (event, outlinePath: unknown) => {
    if (typeof outlinePath !== 'string' || !outlinePath || !outlineDiskGuard.owns(String(event.sender.id), outlinePath)) return null
    try { return await outlineDiskGuard.diskVersion(outlinePath) } catch (error) {
      // Electron decorates thrown IPC errors with a remote-method prefix; keep UI wording as data.
      return { error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('talk:outline-plan-slide-merge', (event, path: unknown) =>
    typeof path === 'string' ? outlineSlideMerge.plan(String(event.sender.id), path)
      : { ok: false, reason: 'ownership', error: 'A talk open in this window is required.' })
  ipcMain.handle('talk:outline-apply-slide-merge', (event, path: unknown, generation: unknown, choices: unknown) => {
    if (typeof path !== 'string' || typeof generation !== 'string') {
      return { ok: false, reason: 'stale-plan', error: 'Open a merge review first.' }
    }
    if (!choices || typeof choices !== 'object' || Array.isArray(choices)) {
      return { ok: false, reason: 'invalid-choice', keys: [] }
    }
    return outlineSlideMerge.apply(String(event.sender.id), path, generation, choices as SlideMergeChoices)
  })

  // Review pictures are compiled from the trusted snapshots and keyed by source line, including
  // slides that have yet to receive an ID. Render only the rows that the review actually shows.
  ipcMain.handle('talk:slide-merge-pictures', async (event, path: unknown, generation: unknown, side: unknown) => {
    if (typeof path !== 'string' || typeof generation !== 'string' || (side !== 'mine' && side !== 'disk')) return {}
    const source = outlineSlideMerge.pictureSource(String(event.sender.id), path, generation, side)
    if (!source?.lines.length || outlineRefused(path)) return {}
    try {
      const prepared = await prepareTalk(path, source.text, undefined, await variantMedia(), 'variant')
      if (!prepared?.rows || typeof prepared.model.fullHtml !== 'string') return {}
      const { rows } = prepared
      const fullHtml = prepared.model.fullHtml
      const wanted = new Set(source.lines)
      const slides = thumbnailSlides(rows, thumbnailDocumentId(fullHtml, prepared.previewKey)).flatMap(slide => {
        const line = rows[slide.index]?.source_line
        return typeof line === 'number' && wanted.has(line) ? [{ ...slide, line }] : []
      })
      const rendered = await renderThumbnails({
        fullHtml, deckKey: prepared.previewKey, preview: prepared.preview, slides,
        cacheDir: talkThumbCacheDir(path, prepared.slug), requestKey: `merge:${event.sender.id}:${side}`,
      })
      return Object.fromEntries(slides.flatMap(slide => {
        const file = rendered[slide.key]
        if (!file) return []
        return [[slide.line, thumbUrl(prepared.slug, basename(file, '.png'), vaultIdOf(path))]]
      }))
    } catch (error) {
      console.error('[slide-merge-pictures]', error)
      return {}
    }
  })

  ipcMain.handle('talk:outline-accept-disk', async (event, outlinePath: unknown, hash: unknown, opts?: { keepPending?: boolean; revision?: unknown }) => {
    if (typeof outlinePath !== 'string' || !outlinePath || typeof hash !== 'string') return { ok: false, change: null, error: 'Nothing to accept.' }
    const owner = String(event.sender.id), session = outlineDiskGuard.session(owner, outlinePath)
    if (!session) {
      return { ok: false, change: null, error: 'This window does not have that talk open, so nothing was accepted.' }
    }
    try {
      const accepted = await outlineDiskGuard.accept(owner, outlinePath, hash, { keepPending: opts?.keepPending === true })
      // Reopening the same talk is a new session too; owns() alone cannot fence its save state.
      if (outlineDiskGuard.session(owner, outlinePath) !== session) {
        return { ok: false, change: null, error: 'The talk was closed or reloaded before acceptance finished, so nothing was acknowledged.' }
      }
      const revision = opts?.revision
      if (accepted.ok && opts?.keepPending !== true && typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0) {
        editorRevisions.loaded(event.sender.id, revision)
        lastSaveFailed.delete(event.sender.id)
        lastUnsavedText.delete(canonicalOutlinePath(outlinePath))
      }
      return accepted
    } catch (e) {
      return { ok: false, change: null, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // Recovery copies (outline-recovery.ts): the text a refused save kept, for the talk this window has
  // open (the bar's "Restore my unsaved text"), and dropping it (restored and saved, or Discard).
  // Merge inputs are durable before the renderer accepts a disk version or replaces dirty text.
  ipcMain.handle('talk:outline-preserve-merge', async (event, outlinePath: unknown, snapshot: unknown) => {
    if (typeof outlinePath !== 'string' || !outlineDiskGuard.owns(String(event.sender.id), outlinePath)) return null
    if (!snapshot || typeof snapshot !== 'object') return null
    const value = snapshot as Record<string, unknown>
    if (typeof value.base !== 'string' || typeof value.mine !== 'string' || typeof value.disk !== 'string' ||
        (value.draft !== undefined && typeof value.draft !== 'string')) return null
    try {
      const real = canonicalOutlinePath(outlinePath)
      const file = await outlineRecovery.preserveMerge(real, {
        base: value.base, mine: value.mine, disk: value.disk, ...(typeof value.draft === 'string' ? { draft: value.draft } : {}),
      })
      // A crash before autosave first refuses still offers the local text on the next open.
      if (value.draft === undefined && value.mine !== value.base) {
        const previous = await outlineRecovery.read(real)
        if (previous && previous.text !== value.mine && previous.text !== value.base) {
          await outlineRecovery.preserveMerge(real, { base: value.base, mine: previous.text, disk: value.disk })
        }
        await outlineRecovery.save(real, value.mine)
      }
      return file
    } catch { return null }
  })

  ipcMain.handle('talk:outline-recovery', async (event, outlinePath: unknown) => {
    if (typeof outlinePath !== 'string' || !outlinePath || !outlineDiskGuard.owns(String(event.sender.id), outlinePath)) return null
    try { return await outlineRecovery.read(canonicalOutlinePath(outlinePath)) } catch { return null }
  })

  ipcMain.handle('talk:outline-recovery-discard', async (event, outlinePath: unknown) => {
    if (typeof outlinePath !== 'string' || !outlinePath || !outlineDiskGuard.owns(String(event.sender.id), outlinePath)) return false
    try { await outlineRecovery.clear(canonicalOutlinePath(outlinePath)); return true } catch { return false }
  })

  // The talk was removed on disk and the person chose Discard: the window lets the talk go without
  // saving it again, and its recovery copy is dropped. The guard keeps the file tracked (every save still
  // refused, so nothing recreates it) until the window releases the talk.
  ipcMain.handle('talk:outline-discard', async (event, outlinePath: unknown) => {
    if (typeof outlinePath !== 'string' || !outlinePath || !outlineDiskGuard.owns(String(event.sender.id), outlinePath)) return false
    editorRevisions.discarded(event.sender.id)
    try { await outlineRecovery.clear(canonicalOutlinePath(outlinePath)) } catch { /* best effort */ }
    return true
  })

  // Insert section (talk search 07; ADR-0029 §5): the section a picker heading names, read from its
  // talk as it stands now (the open editor's buffer when a window has it, else the file — readTalkOutline,
  // the one writer's read) and cut by the shared headless operation. Read-only: the insert itself happens
  // in the target talk's editor buffer (renderer, lib/outlineMutation) and is saved from there.
  ipcMain.handle('talk:extract-section', async (_event, sourceOutlinePath: string, at: SectionLocation) => {
    let text: string
    try {
      text = await readTalkOutline(sourceOutlinePath)
    } catch (e) {
      return { ok: false, error: `The talk the section comes from could not be read (${e instanceof Error ? e.message : String(e)}). Nothing was inserted.` }
    }
    return extractSection(text, at)
  })

  // Data-loss backstop (2026-07-05): isStructurallyEmptyOutline and its refusal message live in
  // talk-writer.ts, which applies the same backstop to every other origin's writes.
  // Each editor window's last save: failed or not (an update's restart counts an editor as saved only if it did not).
  // Each save carries the revision of the text it sent (editor-revisions.ts): what a close confirms against.
  ipcMain.handle('talk:write-outline', async (event, outlinePath: string, content: string, opts?: { revision?: unknown; expectedDiskHash?: unknown; identity?: unknown; slideMergeGeneration?: unknown }) => {
    const finished = editorRevisions.writeStarted(event.sender.id, opts?.revision)
    try {
      await updateTestSaveDelay() // the update-test flavour's slow save, and a test run's from source; nothing in a release
      if (opts?.expectedDiskHash !== undefined && (typeof opts.expectedDiskHash !== 'string' || !/^[a-f0-9]{64}$/.test(opts.expectedDiskHash))) { lastSaveFailed.add(event.sender.id); finished(false); return { ok: false as const, refused: 'ownership' as const } }
      const identity = parseOutlineSaveIdentity(opts?.identity)
      if (opts?.identity !== undefined && !identity) { lastSaveFailed.add(event.sender.id); finished(false); return { ok: false as const, refused: 'ownership' as const } }
      const generation = opts?.slideMergeGeneration
      const merge = typeof generation === 'string' && typeof outlinePath === 'string' && typeof content === 'string'
        ? outlineSlideMerge.takeWrite(String(event.sender.id), outlinePath, generation, content) : null
      if (generation !== undefined && !merge) { finished(false); return { ok: false as const, refused: 'ownership' as const } }
      try {
        const result = await writeOutlineFromEditor(event, outlinePath, merge?.text ?? content, opts?.expectedDiskHash as string | undefined, identity, merge ?? undefined)
        const ok = !!result && typeof result === 'object' && result.ok === true
        if (ok) lastSaveFailed.delete(event.sender.id)
        else lastSaveFailed.add(event.sender.id)
        finished(ok)
        return result
      } finally {
        merge?.finish({ ok: false, error: 'The editor no longer has permission to save this merge.' })
      }
    } catch (error) { lastSaveFailed.add(event.sender.id); finished(false); throw error }
  })

  ipcMain.handle('talk:present', async (event, outlinePath: string, content: string, mode?: string, startSlideId?: string, pathwayId?: string, plannedRunId?: string, retakeRequest?: unknown, fromEditor?: boolean) => {
    // Record one slide again (the recording editor): a presenter view of its own, at that slide, recording a take.
    const asked = retakeRequest !== undefined && retakeRequest !== null
    const requested = asked ? parseRetake(retakeRequest) : null
    // Refuse a retake in a development build with the feature switched off.
    if (asked && !TAKES_ENABLED) return { success: false, error: TAKES_OFF_ERROR }
    // Only Studio (the Tools window) asks for a retake.
    if (asked && !isToolsWindowSender(event.sender, host.toolsWindow)) return { success: false, error: 'Invalid retake' }
    if (asked && (mode !== 'presenter' || !requested || (typeof plannedRunId === 'string' && plannedRunId) || pathwayId)) return { success: false, error: 'Invalid retake' }
    const openAudience = fromEditor === true && mode === 'presenter' && !asked
    let retake: RetakeContext | null = null
    const refusal = outlineRefused(outlinePath) // writes beside the outline: refuse one outside the vault
    if (refusal) return { success: false, error: refusal }
    const blocked = unresolvedOutboundFailure(content)
    if (blocked) return blocked
    try {
      const build = await buildTalkPresentFile(outlinePath, content, true, pathwayId, startSlideId, typeof plannedRunId === 'string' ? plannedRunId : undefined)
      const { slug, title, presentPath } = build
      startSlideId = build.startSlideId
      if (requested) {
        // The request is checked against the Run on disk, in the presented talk's vault: the Run, the slide
        // and the camera choice are the Run's own, never the renderer's word for them.
        const picked = presentedTalkVault(presentedVaultDeps, outlinePath)
        const root = !picked ? currentVaultRoot() ?? null : 'error' in picked ? null : picked.root
        // The Run at exactly the home the take will be saved in (recording:save uses the same vault), never a
        // Run of that id kept elsewhere: the take is then found beside its Run.
        const verified = verifyRetake(requested, runAtHome(root, app.getPath('userData'), slug, requested.runId), slug)
        if (!verified.ok) return { success: false, error: verified.error }
        if (startSlideId !== requested.slideId) return { success: false, error: 'Invalid retake' }
        retake = verified.retake
      }
      // Read here, after the compile and with no await before the window's context is set: a publication
      // that finished meanwhile is in the file, the Run or the successful-publication cache by now.
      // Earlier renderer text can contain a withdrawn link, so it never restores publication identity.
      const sourceOutline = await verifiedRunSource(outlinePath, slug)
      const presenterContext = (): LivePresenterContext => {
        const localHandoutPath = join(dirname(outlinePath), 'dist', `${slug}-handout.html`)
        const link = presenterLink({
          run: typeof plannedRunId === 'string' && plannedRunId ? plannedRunOf(outlinePath, plannedRunId) : null,
          outlineUrl: outlineUrlOnDisk(outlinePath),
          localUrl: existsSync(localHandoutPath) ? pathToFileURL(localHandoutPath).href : null,
        })
        return livePresenterContext(vaultRegistry, outlinePath, slug, link.shortUrl, link.runLink, sourceOutline)
      }
      // Window title by role + talk (e.g. "TalkWeaver Presenter — AI 2026 Agents") so ⌘` / Mission
      // Control / the Window menu name each deck by what's in it. Kept via page-title-updated below.
      const roleLabel = mode === 'presenter' ? 'Presenter' : mode === 'audience' ? 'Audience' : 'Presentation'
      const winTitle = `TalkWeaver ${roleLabel} — ${title}`

      // Reuse an existing deck window for this talk+mode instead of spawning a duplicate: focus it and
      // refresh it in place with the freshly-compiled file. An editor launch starts at the requested
      // slide or at the start. If a recording is armed, don't reload (that would drop
      // it) — just focus and hint. Menu-launched audience windows dedupe the same way (repeated clicks
      // used to multiply them); the runtime-launched audience (F5 inside the presenter) is a child
      // window that never comes through this handler.
      if ((mode === 'presenter' || mode === 'window' || mode === 'audience') && !retake) {
        for (const [wcId, info] of presentWindows) {
          if (info.outlinePath !== outlinePath || info.mode !== mode || info.pathwayId !== pathwayId || info.retake) continue
          const existing = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.id === wcId)
          if (!existing) continue
          let hash = startSlideId || ''
          let rec = ''
          try {
            const s = await existing.webContents.executeJavaScript(
              "({ h: location.hash.startsWith('#') ? decodeURIComponent(location.hash.slice(1)) : '', r: ((document.getElementById('twrec-module')||{}).dataset||{}).rec || '' })"
            )
            if (!hash && fromEditor !== true) hash = s.h
            rec = s.r
          } catch { /* fall through: refresh from the top */ }
          if (existing.isMinimized()) existing.restore()
          existing.setTitle(winTitle)
          existing.focus()
          const recordingArmed = rec && rec !== 'idle' && rec !== 'saved' && rec !== 'error'
          if (recordingArmed) {
            existing.webContents.send('present:hint', 'Already presenting — stop the recording (⇧R) to refresh this deck.')
          } else {
            // The page is being replaced, so only now is the window this Run's: its publications are this
            // Run's from here on. Refused above, it stays the Run it is recording, with the link it has.
            if (mode === 'presenter') {
              livePresenterContexts.set(wcId, presenterContext())
              const { runId: _previous, ...rest } = info
              presentWindows.set(wcId, typeof plannedRunId === 'string' && plannedRunId ? { ...rest, runId: plannedRunId } : rest)
            }
            // Cache-bust (_r) so the reused window truly reloads the freshly-compiled file.
            const reuseQuery: Record<string, string> =
              mode === 'presenter' ? { presenter: '1', session: randomUUID() } : mode === 'audience' ? { audience: '1' } : {}
            reuseQuery.livepage = '1'
            reuseQuery._r = String(++host.presentReloadNonce)
            const reuseOpts: { query: Record<string, string>; hash?: string } = { query: reuseQuery }
            if (hash) reuseOpts.hash = hash
            await existing.loadFile(presentPath, reuseOpts)
            if (!existing.isDestroyed()) existing.webContents.send('present:hint', '✓ Refreshed with your latest edits')
            void ledgerSeal(outlinePath, content, 'present')
          }
          if (openAudience && !existing.isDestroyed()) {
            await openDeckAudience(existing)
            if (!E2E && !existing.isDestroyed()) existing.focus()
          }
          return { success: true }
        }
      }
      // Recording lives in the presenter view only: attach the opt-in recorder bridge preload there.
      // The recorder bridge ALSO mounts the ⌘E "edit this slide" bridge. A plain presentation window
      // gets the edit-only bridge; the audience view stays preload-less + portable. (These windows are
      // opened BY TalkWeaver, so a preload here never touches the exported portable artifact.)
      // Preload and sandbox per mode: present-window-prefs.ts (only the recorder's window is unsandboxed).
      const recording = mode === 'presenter'
      const deckPrefs = presentWindowPreferences(mode, join(__dirname, '../preload'))
      const win = new BrowserWindow({
        width: 1440, height: 900, fullscreen: false,
        ...(E2E ? { show: false } : {}),
        title: winTitle,
        backgroundColor: '#f7f3ea',
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          // macOS treats covered audience windows as hidden; keep slide updates drawing.
          backgroundThrottling: false,
          ...deckPrefs
        }
      })
      registerWindowKind(win, 'deck')
      // Keep our role+talk title — the deck HTML sets its own <title>, which would otherwise replace it.
      win.on('page-title-updated', (e) => e.preventDefault())
      win.setTitle(winTitle)
      if (recording) {
        // Grant the mic (bridge getUserMedia) and register this window's context so the bridge's
        // recording:context call returns the right talk. Clean up when the window closes.
        setupRecordingPermissions(win)
        const wcId = win.webContents.id
        // timerTargetMin: pacing reference (the presenter clock's warn threshold today; the real
        // talk-length target is refined when Studio surfaces it — Plans 2–3). Not load-bearing here.
        const sourceOutline = await verifiedRunSource(outlinePath, slug)
        registerRecordingContext(wcId, {
          sourceOutline,
          talkSlug: slug,
          talkTitle: title,
          timerTargetMin: timerSettings().warnAtMinutes,
          pathwayId: pathwayId ?? null,
          preferredPlannedRunId: plannedRunId ?? null,
          ...(retake ? { retake } : {})
        })
        win.on('closed', () => unregisterRecordingContext(wcId))
      }
      // mode: 'presenter' → presenter view (notes + controls); 'audience' → chromeless audience view;
      // anything else → the plain presentation window. The deck runtime reads ?presenter=1 / ?audience=1.
      // livepage=1: this deck shows a slide's web page live, in a view of its own (live-page-host.ts).
      const query: Record<string, string> = { ...(mode === 'presenter' ? { presenter: '1', session: randomUUID() } : mode === 'audience' ? { audience: '1' } : {}), livepage: '1' }
      // ⇧F5 present-from-here: the runtime reads location.hash on init and starts on the slide whose
      // dataset.id matches the id (09-output-builders.mjs). An unknown/empty id falls back to slide 0.
      const loadOpts: { query?: Record<string, string>; hash?: string } = {}
      if (retake) query.retake = '1'
      if (query) loadOpts.query = query
      if (startSlideId) loadOpts.hash = startSlideId
      attachLivePageHost(win, mode === 'presenter' ? 'presenter' : mode === 'audience' ? 'audience' : 'window', outlinePath)
      // Track this deck for ⌘R refresh-in-place, and OWN ⌘R here: before-input-event preempts the
      // default menu's Reload accelerator (which would reload to slide 0 without recompiling).
      const deckWcId = win.webContents.id
      presentWindows.set(deckWcId, { outlinePath, mode: mode ?? 'window', pathwayId, ...(retake ? { retake: true } : {}), ...(typeof plannedRunId === 'string' && plannedRunId ? { runId: plannedRunId } : {}) })
      host.updateChecker?.busyChanged()
      if (mode === 'presenter') livePresenterContexts.set(deckWcId, presenterContext())
      win.on('close', (event) => {
        const record = attachLiveWindow(deckWcId)
        const live = !!record && !['ended', 'expired'].includes(record.status)
        const offerRunSave = shouldOfferRunSave(deckWcId)
        const audioArmed = recordingAudioArmed(deckWcId)
        if (!live && !offerRunSave && !audioArmed) return
        event.preventDefault()
        cancelQuitAttempt()
        sendRecordingCloseOffer(win, { live, offerRunSave, audioArmed })
      })
      win.on('closed', () => {
        host.liveSessions?.detach(deckWcId)
        presenterGuide.forget(deckWcId)
        presentWindows.delete(deckWcId)
        livePresenterContexts.delete(deckWcId)
        host.updateChecker?.busyChanged()
      })
      // F5 in the presenter opens the audience view (its Audience button); ⇧F5 there, F5 / ⇧F5 in the
      // other deck windows and ⌘R everywhere refresh the deck in place (deck-window-keys.ts).
      // preventDefault here also keeps the menu's F5 "Present from the top" from firing.
      win.webContents.on('before-input-event', (event, input) => {
        const action = deckWindowKeyAction(deckWindowMode(mode), input)
        if (!action) return
        event.preventDefault()
        // These keys never reach the page, so main reports them to the Guide itself (ticket 10).
        if (action === 'open-audience') {
          openDeckAudience(win).catch((e) => console.warn('[present] F5 audience failed:', e))
          guideLearn.commandRan('presenter.audience', { inExample: false })
        } else {
          void refreshDeckFromEditor(win)
          guideLearn.commandRan('presenter.refresh', { inExample: false })
        }
      })
      // F5 in the presenter opens the audience view via window.open(?audience=1). Send it FULL-SCREEN
      // to a second display if one exists; otherwise leave it as a normal window on this screen.
      // The board's own window is a blank page the presenter window draws into (feedback-boards ticket
      // 05); under its name nothing else opens.
      // Only the deck's own pages and the board open in-app; a web / mail link (target="_blank") goes
      // to the browser, so a remote page never inherits this window's bridges (present-window-open.ts).
      // The same handler goes on every window opened from here, at any depth (presentation → Presenter
      // → Audience is a grandchild).
      guardDeckWindowTree(win.webContents, deckWindowOpenOpts)
      win.webContents.on('did-create-window', (child, details) => {
        // The board's own window (feedback-boards ticket 05, D23): the presenter window draws it. It
        // goes to another display when there is one (not full screen: it is managed there), and it
        // closes with the presenter window it belongs to.
        if (details?.frameName === 'tw-board-window') {
          // Only the blank page this presenter window opened for its board; anything else is closed.
          if (details.url !== 'about:blank' || mode !== 'presenter' || !livePresenterContexts.has(deckWcId)) { if (!child.isDestroyed()) child.destroy(); return }
          child.setMinimumSize(900, 560)
          try {
            const here = screen.getDisplayNearestPoint({ x: win.getBounds().x, y: win.getBounds().y })
            const external = screen.getAllDisplays().find((d) => d.id !== here.id)
            if (external) {
              const { x, y, width, height } = external.workArea
              child.setBounds({ x: x + Math.max(0, Math.round((width - 1440) / 2)), y: y + Math.max(0, Math.round((height - 900) / 2)), width: Math.min(1440, width), height: Math.min(900, height) })
            }
          } catch (e) { console.warn('[present] board window placement failed:', e) }
          const closeChild = () => { if (!child.isDestroyed()) child.close() }
          win.once('closed', closeChild)
          child.once('closed', () => { if (!win.isDestroyed()) win.removeListener('closed', closeChild) })
          return
        }
        // A web page on a slide: the audience side's copy follows the presenter pane's scrolling
        // (remote-page-follow.ts). The presenter's Audience window, or the Presenter window opened from
        // a presentation window (then the presentation window is the audience side).
        const followPair = mode === 'presenter' && details?.url?.includes('audience=1') ? [win.webContents, child.webContents]
          : mode !== 'presenter' && details?.url?.includes('presenter=1') ? [child.webContents, win.webContents] : null
        if (followPair) {
          const stopFollowing = followRemotePages(followPair[0], followPair[1])
          child.once('closed', stopFollowing)
          win.once('closed', stopFollowing)
          // The same pair for a live web page: the child deck window gets its own host (it loads the
          // opener's deck address, livepage=1 included), and the presenter's host leads.
          if (details?.url?.includes('livepage=1')) {
            const childHost = attachLivePageHost(child, mode === 'presenter' ? 'audience' : 'presenter', outlinePath)
            const ownHost = livePageHosts.get(deckWcId) ?? null
            const unpair = mode === 'presenter' ? pairLivePageHosts(ownHost, childHost) : pairLivePageHosts(childHost, ownHost)
            child.once('closed', unpair)
            win.once('closed', unpair)
          }
        }
        if (!details?.url || !details.url.includes('audience=1')) return
        // A freshly loaded presenter has a new session. Replace the audience from its old session.
        if (mode === 'presenter') {
          const previous = presenterAudienceWindows.get(win)
          presenterAudienceWindows.set(win, child)
          child.once('closed', () => {
            if (presenterAudienceWindows.get(win) === child) presenterAudienceWindows.delete(win)
          })
          if (previous && !previous.isDestroyed()) previous.close()
        }
        // The presenter-spawned audience window gets its own role title too.
        child.on('page-title-updated', (e) => e.preventDefault())
        child.setTitle(`TalkWeaver Audience — ${title}`)
        try {
          const here = screen.getDisplayNearestPoint({ x: win.getBounds().x, y: win.getBounds().y })
          const external = screen.getAllDisplays().find((d) => d.id !== here.id)
          if (external) {
            child.setBounds(external.bounds)
            if (!E2E) setTimeout(() => { try { child.setFullScreen(true) } catch { /* ignore */ } }, 120)
          }
        } catch (e) { console.warn('[present] audience display placement failed:', e) }
      })
      await win.loadFile(presentPath, loadOpts)
      if (openAudience && !win.isDestroyed()) {
        await openDeckAudience(win)
        if (!E2E && !win.isDestroyed()) win.focus()
      }
      void ledgerSeal(outlinePath, content, 'present')
      return { success: true }
    } catch (e) {
      console.error('[present]', e)
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('talk:build', async (_event, outlinePath: string, content: string) => {
    const refusal = outlineRefused(outlinePath) // writes beside the outline: refuse one outside the vault
    if (refusal) return { success: false, error: refusal }
    const blocked = unresolvedOutboundFailure(content)
    if (blocked) return blocked
    if (!getCompilerPath()) return { success: false, error: 'Compiler not found' }
    try {
      const prepared = await prepareTalk(outlinePath, content, timerSettings(), {
        pictureText: pictureTextForCompile(outlinePath, content)
      }, 'variant')
      if (!prepared) return { success: false, error: 'Compiler not found' }
      const { slug, model } = prepared
      const html = withTalkTitle(model.fullHtml as string, plainInlineText(pageTitleOf(model, slug)))
      const talkDir = dirname(outlinePath)
      const distDir = join(talkDir, 'dist')
      if (!existsSync(distDir)) mkdirSync(distDir) // only inside a talk folder that is there (a vanished vault is never re-created)
      const outPath = join(distDir, slug + '.html')
      await writeGeneratedFile(outPath, html)
      return { success: true, outPath }
    } catch (e) {
      console.error('[build]', e)
      return { success: false, error: String(e) }
    }
  })

  // ── Build variants (ADR-0012): full + share-notes + share-no-notes + projections JSONL ──
  ipcMain.handle('talk:build-variants', async (_event, outlinePath: string, content: string) => {
    const refusal = outlineRefused(outlinePath) // writes beside the outline: refuse one outside the vault
    if (refusal) return { success: false, error: refusal }
    const blocked = unresolvedOutboundFailure(content)
    if (blocked) return blocked
    const compilerDir = getCompilerPath()
    if (!compilerDir) return { success: false, error: 'Compiler not found' }
    try {
      const prepared = await prepareTalk(outlinePath, content, timerSettings(), undefined, 'variant')
      if (!prepared) return { success: false, error: 'Compiler not found' }
      const { slug, model, rows } = prepared
      const talkDir = dirname(outlinePath)

      const distDir = join(talkDir, 'dist')
      if (!existsSync(distDir)) mkdirSync(distDir) // only inside a talk folder that is there (a vanished vault is never re-created)

      const title = pageTitleOf(model, slug)
      const fullHtml = withTalkTitle(model.fullHtml as string, plainInlineText(title))
      const outPaths: string[] = []

      const fullPath = join(distDir, slug + '-full.html')
      await writeGeneratedFile(fullPath, fullHtml)
      outPaths.push(fullPath)

      // Prefer the real lib builders so share variants match the CLI exactly.
      try {
        const { extractStyles, extractSlides } = await import(
          pathToFileURL(join(compilerDir, 'lib/04-html-extraction.mjs')).href
        )
        const { buildShareHtml } = await import(
          pathToFileURL(join(compilerDir, 'lib/09-output-builders.mjs')).href
        )
        const styles = extractStyles(fullHtml)
        // The share variants are handouts: a {prework} section's slides are never in them.
        const slides = withoutPreworkSlides(extractSlides(fullHtml) as Array<{ id: string; html: string; notes: string }>, model.prework as CompiledPrework | undefined)
        const license = (model as { license?: unknown }).license
        const shareNotes = buildShareHtml({ title, slides, styles, includeNotes: true, slug, license })
        const shareNoNotes = buildShareHtml({ title, slides, styles, includeNotes: false, slug, license })
        const notesPath = join(distDir, slug + '-share-notes.html')
        const noNotesPath = join(distDir, slug + '-share-no-notes.html')
        await writeGeneratedFile(notesPath, shareNotes)
        await writeGeneratedFile(noNotesPath, shareNoNotes)
        outPaths.push(notesPath, noNotesPath)
      } catch (builderErr) {
        // Fallback: full as both, notes crudely stripped. Logged loudly per spec.
        console.warn('[build-variants] real share builders unavailable, using FALLBACK:', builderErr)
        const stripped = fullHtml.replace(
          /<aside\b[^>]*class=["'][^"']*\bnotes\b[^"']*["'][^>]*>[\s\S]*?<\/aside>/gi,
          ''
        )
        const notesPath = join(distDir, slug + '-share-notes.html')
        const noNotesPath = join(distDir, slug + '-share-no-notes.html')
        await writeGeneratedFile(notesPath, fullHtml)
        await writeGeneratedFile(noNotesPath, stripped)
        outPaths.push(notesPath, noNotesPath)
      }

      // Per-slide projections JSONL alongside the variants.
      try {
        if (rows && rows.length) {
          const jsonl = rows.map((r: unknown) => JSON.stringify(r)).join('\n') + '\n'
          const jsonlPath = join(distDir, slug + '-projections.jsonl')
          await writeGeneratedFile(jsonlPath, jsonl)
          outPaths.push(jsonlPath)
        }
      } catch (projErr) {
        console.warn('[build-variants] projections not written:', projErr)
      }

      return { success: true, outPaths }
    } catch (e) {
      console.error('[build-variants]', e)
      return { success: false, error: String(e) }
    }
  })

  // ── Export handout (Phase 1) — the audience-facing reading HTML (ADR-0012 share-no-notes). One
  // focused artefact written to dist/{slug}-handout.html, NOT the whole variant set. Matches the CLI
  // exactly via the real buildShareHtml(includeNotes:false) — the same content the compiler's launcher
  // treats as the handout. Phase 2 (Cloudflare Pages publish) builds on this.
  ipcMain.handle('talk:export-handout', async (_event, outlinePath: string, content: string) => {
    const refusal = outlineRefused(outlinePath) // writes beside the outline: refuse one outside the vault
    if (refusal) return { success: false, error: refusal }
    const blocked = unresolvedOutboundFailure(content)
    if (blocked) return blocked
    const compilerDir = getCompilerPath()
    if (!compilerDir) return { success: false, error: 'Compiler not found' }
    try {
      const prepared = await prepareTalk(outlinePath, content, undefined, {
        pictureText: pictureTextForCompile(outlinePath, content)
      }, 'variant', undefined, { preview: false })
      if (!prepared) return { success: false, error: 'Compiler not found' }
      const { slug, model } = prepared
      const talkDir = dirname(outlinePath)
      const title = pageTitleOf(model, slug)
      const fullHtml = model.fullHtml as string

      const { extractStyles, extractSlides } = await import(
        pathToFileURL(join(compilerDir, 'lib/04-html-extraction.mjs')).href
      )
      const { buildShareHtml } = await import(pathToFileURL(join(compilerDir, 'lib/09-output-builders.mjs')).href)
      const styles = extractStyles(fullHtml)
      // Ticket 09: pre-work steps are never slides of a handout (the evergreen one included).
      const slides = withoutPreworkSlides(extractSlides(fullHtml) as Array<{ id: string; html: string; notes: string }>, model.prework as CompiledPrework | undefined)
      const license = (model as { license?: unknown }).license
      const handoutHtml = buildShareHtml({
        title, slides, styles, includeNotes: false, slug, license,
        workerBaseUrl: localHandoutWorkerBaseUrl(), liveTalkSlug: slug,
      })

      const distDir = join(talkDir, 'dist')
      if (!existsSync(distDir)) mkdirSync(distDir) // only inside a talk folder that is there (a vanished vault is never re-created)
      const handoutPath = join(distDir, slug + '-handout.html')
      await writeGeneratedFile(handoutPath, handoutHtml)
      void ledgerSeal(outlinePath, content, 'export')
      return { success: true, path: handoutPath }
    } catch (e) {
      console.error('[export-handout]', e)
      return { success: false, error: String(e) }
    }
  })

  const activeHandoutPublishes = new Map<number, { requestId?: string; controller: AbortController; canCancel: boolean }>()
  ipcMain.handle('talk:cancel-publish-handout', (event, requestId: unknown) => {
    const active = event?.sender && activeHandoutPublishes.get(event.sender.id)
    if (typeof requestId !== 'string' || active?.requestId !== requestId || !active.canCancel) return false
    active.controller.abort()
    return true
  })
  ipcMain.handle('talk:publish-handout', async (event, outlinePath: string, content: string, mediaChoice?: MediaPublishChoice,
    options?: { requestId?: string; retryAttemptId?: string }) => {
    const sender = event?.sender
    if (sender && activeHandoutPublishes.has(sender.id)) return { success: false, error: 'A handout publish is already running in this window.' }
    const requestId = options?.requestId
    if (requestId !== undefined && (typeof requestId !== 'string' || !/^[0-9a-f-]{36}$/u.test(requestId))) {
      return { success: false, error: 'The publish request could not be read.' }
    }
    const active = { requestId, controller: new AbortController(), canCancel: true }
    if (sender) activeHandoutPublishes.set(sender.id, active)
    try {
      return await publishTalkHandout(host, outlinePath, content, mediaChoice, {
        retryAttemptId: options?.retryAttemptId,
        signal: active.controller.signal,
        onProgress: progress => {
          active.canCancel = progress.canCancel
          if (requestId && sender && !sender.isDestroyed()) sender.send('talk:publish-progress', requestId, progress)
        },
      })
    } finally {
      if (sender) activeHandoutPublishes.delete(sender.id)
    }
  })

  // ── Thumbnails (rendered per-slide PNG previews) ─────────────────────────────
  // Optimize a talk's IMAGES to WebP: imported (Obsidian-era) talks carry large relative-path PNG/JPG
  // images in their own assets/ folder — big files that make previews slow to render (and handouts
  // fat). This converts each to WebP (q82, downscaled to a generous 2560px long side), rewrites the
  // outline refs, and moves the originals to the OS Trash (recoverable). Vault-pool images
  // (`img-XXXXXXX`, already WebP from paste), http/data URLs, and non-image refs are left alone.
  // Returns the rewritten outline so the renderer can adopt it in place (avoiding an autosave clobber).
  ipcMain.handle('talk:optimize-images', async (_event, outlinePath: string, content: string) => {
    const refusal = outlineRefused(outlinePath) // writes beside the outline: refuse one outside the vault
    if (refusal) return { success: false, error: refusal }
    try {
      const sharp = require('sharp')
      const talkDir = dirname(outlinePath)
      // What may be touched is decided by optimise-images.ts (ADR-0036): a plain picture really inside
      // the talk's allowed folders AND in this talk's own folder, whose .webp does not exist yet. Every
      // reference is decided before anything is converted; a picture named several ways is converted
      // once. A reference that is left alone has NOTHING read, written or trashed for it.
      const compilerDir = getCompilerPath()
      if (!compilerDir) return { success: false, error: 'Compiler not found' }
      const { createAssetContainment } = await import(pathToFileURL(join(compilerDir, 'lib/asset-containment.mjs')).href)
      const containment = createAssetContainment(assetRootsFor(outlinePath)) as AssetContainment
      const plan = await planOptimisation(convertibleImageRefs(content), talkDir, containment)
      const converted = new Map<string, string>()
      let pictures = 0
      let savedBytes = 0
      const failed: string[] = []
      for (const skip of plan.skipped) {
        if (skip.reason !== 'missing') console.warn('[optimize-images] left alone (' + skip.reason + '):', skip.ref)
        if (skip.reason !== 'elsewhere' && skip.reason !== 'clash') failed.push(skip.ref)
      }
      for (const conversion of plan.conversions) {
        try {
          const before = statSync(conversion.source).size
          const webp: Buffer = await sharp(conversion.source)
            .resize({ width: 2560, height: 2560, fit: 'inside', withoutEnlargement: true })
            .webp({ quality: 82 })
            .toBuffer()
          // A new file only, never onto one that is there; the original goes to the Trash after it exists.
          await writeNewFile(conversion.output, webp)
          for (const [ref, webpRef] of conversion.refs) converted.set(ref, webpRef)
          pictures += 1
          savedBytes += Math.max(0, before - webp.length)
          try { await shell.trashItem(conversion.source) } catch { /* leave the original if trashing fails */ }
        } catch (convErr) {
          console.warn('[optimize-images] failed for', conversion.refs[0]?.[0], convErr)
          for (const [ref] of conversion.refs) failed.push(ref)
        }
      }
      // Pictures left alone on purpose, by reason (new fields beside `failed`): another talk's or the
      // shared pool's, and ones whose .webp name is taken.
      const leftAlone = plan.skipped.filter((skip) => skip.reason === 'elsewhere').length
      const clashes = plan.skipped.filter((skip) => skip.reason === 'clash').length
      let newContent = content
      if (converted.size > 0) {
        // The same ref rewrites, applied to the talk's CURRENT text — the open editor's buffer when a
        // window has it (talk-writer.ts), so edits made during the conversion survive. Only an image
        // link whose whole target was converted is rewritten.
        const written = await writeTalkOutline(outlinePath, (current) => rewriteConvertedRefs(current, converted), 'optimize-images')
        if (!written.ok) throw new Error(written.error)
        newContent = written.text
        invalidateVaultCaches(outlinePath)
      }
      return { success: true, converted: pictures, savedBytes, failed: failed.length, leftAlone, clashes, newContent }
    } catch (e) {
      console.error('[optimize-images]', e)
      return { success: false, error: String(e) }
    }
  })

  // Cross-talk reuse (ADR-0003/0020): when a slide is inserted from ANOTHER talk, its relative-path
  // images and videos (`assets/foo.png`, relative to the SOURCE talk) would break in the destination talk (no
  // such file beside it → grey placeholder). Materialize each into the VAULT POOL — content-addressed
  // `_assets/<img-or-vid>-<hash>.<ext>`, which resolves from ANY talk. Images may be WebP-normalised;
  // videos retain their bytes. Rewrite refs to the pool id; leave pool / http / data refs alone. Returns the
  // rewritten markdown (the renderer inserts THAT). `sourceOutlinePath` locates the source assets.
  ipcMain.handle('talk:materialize-slide-assets', async (event, sourceOutlinePath: string, markdown: string, targetOutlinePath?: string) => {
    if (targetOutlinePath && editorWindows.get(event.sender.id)?.outlinePath !== targetOutlinePath) {
      return { success: false, error: 'The target talk changed.', markdown }
    }
    const refusal = outlineRefused(sourceOutlinePath) // writes beside the outline: refuse one outside the vault
    if (refusal) return { success: false, error: refusal, markdown }
    const vaultRoot = writableRootFor(sourceOutlinePath)
    if (!vaultRoot) return { success: false, error: 'No vault root', markdown }
    try {
      const srcDir = dirname(sourceOutlinePath)
      const assetsDir = join(vaultRoot, '_assets')
      mkdirInVault(vaultRoot, assetsDir)
      const refs = new Set<string>()
      const re = /!\[[^\]]*\]\(([^)]+)\)/g
      let m: RegExpExecArray | null
      while ((m = re.exec(markdown)) !== null) {
        const raw = m[1].trim().replace(/\s+"[^"]*"$/, '')
        if (/^(https?:|data:|img-|vid-)/.test(raw)) continue
        if (!/\.(png|jpe?g|gif|webp|mp4|mov|m4v|webm)$/i.test(raw)) continue
        refs.add(raw)
      }
      let out = markdown
      let materialized = 0
      let skipped = 0
      for (const ref of refs) {
        let rel = ref
        try { rel = decodeURIComponent(ref) } catch { rel = ref }
        if (rel.toLowerCase().startsWith('file:')) { // a file URL points anywhere on the Mac: never followed
          skipped += 1
          console.warn('[materialize-slide-assets] skipped a file URL reference:', ref)
          continue
        }
        const requested = rel.startsWith('/') ? rel : join(srcDir, rel)
        // Reuse is vault-internal: a source outside the vault (absolute, `..`, or a symlink out) is
        // never copied into _assets, where it would reach slides and published handouts.
        const abs = pathStaysInside(vaultRoot, requested)
        if (!abs) {
          skipped += 1
          console.warn('[materialize-slide-assets] skipped a reference outside the vault:', ref)
          continue
        }
        if (!existsSync(abs)) continue
        try {
          const origBuf = readFileSync(abs)
          const originalFormat = extname(abs).slice(1).toLowerCase() || 'png'
          const isVideo = /^(mp4|mov|m4v|webm)$/.test(originalFormat)
          let storeBuf: Buffer = origBuf
          let storeExt = originalFormat
          if (!isVideo) try {
            const webp = await normaliseToWebp(origBuf)
            if (webp.length > 0 && webp.length <= origBuf.length) { storeBuf = webp; storeExt = 'webp' }
          } catch { /* keep original format */ }
          const hash = createHash('sha256').update(storeBuf).digest('hex').slice(0, 7)
          const id = (isVideo ? 'vid-' : 'img-') + hash
          const assetPath = join(assetsDir, id + '.' + storeExt)
          if (!existsSync(assetPath)) {
            writeFileSync(assetPath, storeBuf)
            const sidecarPath = join(assetsDir, id + '.yml')
            if (!existsSync(sidecarPath)) {
              writeFileSync(sidecarPath, [
                'id: ' + id,
                'created: ' + new Date().toISOString().slice(0, 10),
                'original_format: ' + originalFormat,
                'note: "materialized from cross-talk reuse"',
                'alt: ""', 'caption: ""', 'source: ""', 'tags: []'
              ].join('\n') + '\n', 'utf8')
            }
          }
          // Posters belong to the source clip, never a same-named file elsewhere in the vault.
          if (isVideo) {
            const stem = requested.slice(0, -extname(requested).length)
            for (const extension of ['png', 'jpg', 'jpeg', 'webp']) {
              const candidate = `${stem}.${extension}`
              if (!existsSync(candidate)) continue
              const poster = pathStaysInside(vaultRoot, candidate)
              if (!poster) {
                console.warn('[materialize-slide-assets] skipped a poster outside the vault for:', ref)
                break
              }
              const destination = join(assetsDir, `${id}.${extension}`)
              if (!existsSync(destination)) writeFileSync(destination, readFileSync(poster))
              break
            }
          }
          out = out.split(ref).join(id) // ![alt](assets/foo.png) → ![alt](img-hash)
          materialized += 1
        } catch (e) { console.warn('[materialize-slide-assets] failed for', ref, e) }
      }
      if (targetOutlinePath) {
        const target = editorWindows.get(event.sender.id)?.outlinePath !== targetOutlinePath || outlineRefused(targetOutlinePath) ? null : pathStaysInside(vaultRoot, targetOutlinePath)
        const source = pathStaysInside(vaultRoot, sourceOutlinePath)
        if (!target || !source) return { success: false, error: 'The slide’s talk or its destination is outside the vault.', markdown }
        out = copySlideLocalFiles(dirname(source), dirname(target), out)
      }
      return { success: true, markdown: out, materialized, skipped }
    } catch (e) {
      console.error('[materialize-slide-assets]', e)
      return { success: false, error: String(e), markdown }
    }
  })

  ipcMain.handle('talk:insert-from-vault', async (event, sourceOutlinePath: unknown, targetOutlinePath: unknown, markdown: unknown, liveIds?: unknown) => {
    if (typeof sourceOutlinePath !== 'string' || typeof targetOutlinePath !== 'string' || typeof markdown !== 'string') {
      return { ok: false as const, error: 'Nothing to insert.' }
    }
    if (editorWindows.get(event.sender.id)?.outlinePath !== targetOutlinePath) return { ok: false as const, error: 'The target talk changed.' }
    const from = vaultRegistry.resolve(resolvePath(sourceOutlinePath))
    const to = vaultRegistry.resolve(resolvePath(targetOutlinePath))
    if (!from || !to || !from.vault.open || !to.vault.open) return { ok: false as const, error: 'The slide’s vault or this talk’s vault is not open.' }
    if (from.vault.id === to.vault.id) return { ok: true as const, crossVault: false as const }
    // Ticket 07: an unavailable vault is neither read nor written (its folder is never re-created).
    if (!vaultAvailable(from.vault) || !writableRoot(to.vault.root, rootFs) || !rootFs.isDirectory(from.vault.root)) {
      return { ok: false as const, error: 'The slide’s vault or this talk’s vault is not available on this Mac.' }
    }
    const refusal = outlineRefused(targetOutlinePath) // the target talk must be an outline inside its vault
    if (refusal) return { ok: false as const, error: refusal }
    try {
      const sourceTalk = findTalks(from.vault.root).find((t) => resolvePath(t.outlinePath) === resolvePath(sourceOutlinePath))
      const pending = pendingOrigins.get(to.vault.root)
      const extraTaken = [
        ...(Array.isArray(liveIds) ? liveIds.filter((id): id is string => typeof id === 'string') : []),
        ...(pending ? pending.keys() : [])
      ]
      const tools = await crossVaultTools()
      if (editorWindows.get(event.sender.id)?.outlinePath !== targetOutlinePath) return { ok: false as const, error: 'The target talk changed.' }
      const result = await prepareCrossVaultInsert({
        source: { id: from.vault.id, name: vaultNameOf(from.vault.id), root: from.vault.root },
        target: { id: to.vault.id, name: vaultNameOf(to.vault.id), root: to.vault.root },
        sourceOutlinePath,
        targetOutlinePath,
        canCopyLocalFiles: () => editorWindows.get(event.sender.id)?.outlinePath === targetOutlinePath && !outlineRefused(targetOutlinePath),
        sourceTalkTitle: sourceTalk?.title || basename(sourceOutlinePath).replace(/-outline\.md$/, ''),
        markdown,
        extraTaken,
        // Who inserts it: their "Just for me" author for the target vault, else the Settings author.
        insertedBy: vaultRegistry.personal(to.vault.id).author?.trim() || String(metadataDefaults().author ?? '').trim()
      }, tools, { toWebp: normaliseToWebp })
      if (!result.ok) return result
      const hints = pendingOrigins.get(to.vault.root) ?? new Map<string, SlideOrigin>()
      for (const slide of result.slides) {
        hints.set(slide.id, slide.origin)
        try { provenanceStore().record(to.vault.id, slide.id, slide.privateRecord) } catch (e) { console.warn('[insert-from-vault] private provenance not saved', e) }
      }
      pendingOrigins.set(to.vault.root, hints)
      return {
        ok: true as const, crossVault: true as const, markdown: result.markdown,
        slides: result.slides.map((s) => ({ id: s.id, restamped: s.restamped })),
        materialized: result.materialized, skipped: result.skipped
      }
    } catch (e) {
      console.error('[insert-from-vault]', e)
      return { ok: false as const, error: String(e) }
    }
  })

  // Keep the origin of our own clipboard text in memory only. The system clipboard stays Markdown.
  let slideClipboard: { digest: string; source: string } | undefined
  const clipboardDigest = (text: string): string =>
    createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex')
  ipcMain.handle('talk:remember-slide-copy', (event, source: unknown, markdown: unknown) => {
    if (typeof source !== 'string' || typeof markdown !== 'string' || markdown.length > 1_000_000 ||
        editorWindows.get(event.sender.id)?.outlinePath !== source || outlineRefused(source)) return
    slideClipboard = { source, digest: clipboardDigest(markdown) }
  })

  // Cross-talk reuse via TEXT PASTE: the picker materialises a slide's relative images using its
  // source path, but pasted markdown has none. Resolve each relative `assets/<name>` ref by FILENAME
  // across the vault, copy it into the content-addressed pool (img-<hash>, WebP-normalised), and
  // rewrite the ref — so a pasted sequence's images resolve from any talk. Pool/http/data refs and
  // names not found anywhere are left untouched. Returns the rewritten markdown.
  ipcMain.handle('talk:materialize-pasted-assets', async (event, markdown: string, targetOutlinePath?: string) => {
    if (typeof markdown !== 'string') return { success: false, error: 'Invalid slide text', markdown }
    if (targetOutlinePath && (editorWindows.get(event.sender.id)?.outlinePath !== targetOutlinePath || outlineRefused(targetOutlinePath))) {
      return { success: false, error: 'The target talk changed.', markdown }
    }
    const vaultRoot = targetOutlinePath ? writableRootFor(targetOutlinePath) : writableVaultRoot()
    if (!vaultRoot) return { success: false, error: 'No vault root', markdown }
    try {
      const assetsDir = join(vaultRoot, '_assets')
      mkdirInVault(vaultRoot, assetsDir)
      const refs = new Set<string>()
      const re = /!\[[^\]]*\]\(([^)]+)\)/g
      let m: RegExpExecArray | null
      while ((m = re.exec(markdown)) !== null) {
        const raw = m[1].trim().replace(/\s+"[^"]*"$/, '')
        if (/^(https?:|data:|img-|vid-)/.test(raw)) continue
        if (!/\.(png|jpe?g|gif|webp|mp4|mov|m4v|webm)$/i.test(raw)) continue // images AND videos (2026-07-20: videos were silently dropped)
        refs.add(raw)
      }
      if (targetOutlinePath) {
        const target = pathStaysInside(vaultRoot, targetOutlinePath)
        if (target) {
          const recorded = slideClipboard?.digest === clipboardDigest(markdown) ? slideClipboard?.source : undefined
          const readRoot = recorded && !outlineRefused(recorded) ? writableRootFor(recorded) : undefined
          const source = readRoot && recorded && pathStaysInside(readRoot, recorded)
          markdown = source
            ? copySlideLocalFiles(dirname(source), dirname(target), markdown)
            : copyPastedSlideFiles(vaultRoot, target, markdown, findTalks(vaultRoot))
        }
      }
      if (refs.size === 0) return { success: true, markdown, materialized: 0, skipped: 0 }
      if (!host.vaultAssetIndex) host.vaultAssetIndex = buildVaultAssetIndex(vaultRoot)
      let out = markdown
      let materialized = 0
      let skipped = 0
      for (const ref of refs) {
        let rel = ref
        try { rel = decodeURIComponent(ref) } catch { rel = ref }
        if (rel.toLowerCase().startsWith('file:')) { // a file URL points anywhere on the Mac: never followed
          skipped += 1
          console.warn('[materialize-pasted-assets] skipped a file URL reference:', ref)
          continue
        }
        const base = rel.split('/').pop() || rel
        let found = host.vaultAssetIndex.get(base)
        if (!found || !existsSync(found)) {
          // Rebuild once in case the asset was added since the index was cached.
          host.vaultAssetIndex = buildVaultAssetIndex(vaultRoot)
          found = host.vaultAssetIndex.get(base)
        }
        if (!found || !existsSync(found)) continue
        // The index lists linked files too: one that resolves outside the vault is never copied into
        // _assets, where it would reach slides and published handouts.
        const abs = pathStaysInside(vaultRoot, found)
        if (!abs) {
          skipped += 1
          console.warn('[materialize-pasted-assets] skipped a reference outside the vault:', ref)
          continue
        }
        try {
          const origBuf = readFileSync(abs)
          const originalFormat = extname(abs).slice(1).toLowerCase() || 'png'
          const isVideo = /^(mp4|mov|m4v|webm)$/.test(originalFormat)
          let storeBuf: Buffer = origBuf
          let storeExt = originalFormat
          // Images are WebP-normalised to shrink the pool; videos keep their exact bytes (webp is a
          // still-image codec — never re-encode a clip here).
          if (!isVideo) {
            try {
              const webp = await normaliseToWebp(origBuf)
              if (webp.length > 0 && webp.length <= origBuf.length) { storeBuf = webp; storeExt = 'webp' }
            } catch { /* keep original format */ }
          }
          const hash = createHash('sha256').update(storeBuf).digest('hex').slice(0, 7)
          const id = (isVideo ? 'vid-' : 'img-') + hash // vid- so the resolver emits <video> + finds the poster
          const assetPath = join(assetsDir, id + '.' + storeExt)
          if (!existsSync(assetPath)) {
            writeFileSync(assetPath, storeBuf)
            const sidecarPath = join(assetsDir, id + '.yml')
            if (!existsSync(sidecarPath)) {
              writeFileSync(sidecarPath, [
                'id: ' + id, 'created: ' + new Date().toISOString().slice(0, 10),
                'original_format: ' + originalFormat, 'note: "materialized from pasted cross-talk slide"',
                'alt: ""', 'caption: ""', 'source: ""', 'tags: []'
              ].join('\n') + '\n', 'utf8')
            }
          }
          // A clip's poster is a sibling image with the same stem next to the source video; copy it into
          // the pool as vid-<hash>.<ext> so the compiler paints a first frame before playback.
          if (isVideo) {
            const stem = base.replace(/\.[^.]+$/, '')
            for (const pext of ['png', 'jpg', 'jpeg', 'webp']) {
              const posterFound = host.vaultAssetIndex.get(stem + '.' + pext)
              if (posterFound && existsSync(posterFound)) {
                const posterSrc = pathStaysInside(vaultRoot, posterFound)
                if (!posterSrc) {
                  console.warn('[materialize-pasted-assets] skipped a poster outside the vault for:', ref)
                  break
                }
                const posterDst = join(assetsDir, id + '.' + pext)
                if (!existsSync(posterDst)) writeFileSync(posterDst, readFileSync(posterSrc))
                break
              }
            }
          }
          out = out.split(ref).join(id)
          materialized += 1
        } catch (e) { console.warn('[materialize-pasted-assets] failed for', ref, e) }
      }
      return { success: true, markdown: out, materialized, skipped }
    } catch (e) {
      console.error('[materialize-pasted-assets]', e)
      return { success: false, error: String(e), markdown }
    }
  })

  // Manual rebuild escape hatch: wipe a talk's thumbnail cache so the next thumbnails() call
  // re-renders every slide from scratch. The renderer follows this with a fresh compile + thumbnails.
  // The renderer names the talk by slug only, so every vault's folder for that slug goes (a cache:
  // the other vault's talk re-renders on its next open).
  ipcMain.handle('talk:clear-thumb-cache', (_event, slug: string, outlinePath?: string) => {
    try {
      // Never a path, the vaults folder or an app-level cache (`__ledger__`, `__layout-preview__-…`).
      if (typeof slug !== 'string' || !isPlainSegment(slug) || slug === VAULTS_DIR || slug.startsWith('__')) return false
      // The slug comes from the renderer: only a talk's own folders inside the thumbnail cache.
      const namespaceDir = thumbNamespaceDir()
      const target = thumbCacheDir(namespaceDir, slug)
      if (!target.ok) { console.error('[clear-thumb-cache] refused', target.error); return false }
      // With the talk's path only its own vault's folder goes; without one (or for a path in no vault)
      // every vault's folder for the slug does.
      const ownerId = typeof outlinePath === 'string' && outlinePath ? vaultIdOf(outlinePath) : null
      const ids = ownerId ? [ownerId] : vaultRegistry.list().map((v) => v.id)
      const dirs = ownerId ? [talkThumbDir(namespaceDir, ownerId, slug)] : thumbLookupDirs(namespaceDir, { slug, key: '', vaultId: null }, ids)
      for (const dir of dirs) {
        if (!pathStaysInside(namespaceDir, dir)) { console.error('[clear-thumb-cache] refused', 'outside-vault'); continue }
        if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
      }
      return true
    } catch (e) {
      console.error('[clear-thumb-cache]', e)
      return false
    }
  })

  // Which slides the strip shows (the active slide first, then the visible range): the render for that
  // talk captures them before the rest. Sent by the renderer when they change, throttled there.
  // Only the editor strip reports (no lane), only for a talk inside an open vault, and a window keeps at
  // most one focus entry: reporting a talk replaces whatever that window reported before, so the
  // registry is bounded by the number of windows and a window can only reorder its own editor render.
  ipcMain.on('talk:thumbnail-focus', (event, outlinePath: unknown, indices: unknown) => {
    if (typeof outlinePath !== 'string' || !outlinePath || outlinePath.length > 4096) return
    if (outlineRefused(outlinePath)) return
    clearThumbnailFocus(`editor:${event.sender.id}@`)
    setThumbnailFocus(`editor:${thumbnailTalkOwner(event.sender.id, '', outlinePath)}`, indices)
  })

  // Latest-wins is scoped per OWNER = window + lane (+ talk). One window hosts two independent requesters —
  // the editor strip (re-requests on every compile, 900ms after any content change) and the Slide
  // Browser's background per-talk render. With a window-wide owner the strip's re-request ABORTED
  // the browser's render mid-talk: a partial cache, `{}` back, and the browser marked the talk done —
  // half its cards blank for the rest of the session (2026-09-15).
  ipcMain.handle('talk:thumbnails', async (_event, outlinePath: string, content: string, opts?: { lane?: string; requestId?: string }) => {
    const refusal = outlineRefused(outlinePath) // writes beside the outline: refuse one outside the vault
    if (refusal) return null
    const editorAtRequest = editorWindows.get(_event.sender.id)
    try {
      const lane = typeof opts?.lane === 'string' && /^[a-z-]{1,32}$/.test(opts.lane) ? opts.lane : ''
      const owner = thumbnailTalkOwner(_event.sender.id, lane, outlinePath)
      // Supersede, not cancel: the slide being captured for the older request finishes and is cached
      // (it is content-keyed, so this request finds it on disk), and the rest of that run is dropped.
      supersedeThumbnailRender(`editor:${owner}`)
      latestThumbnailRequest.cancel(owner)
      // Defence in depth. The browser lane walks the whole vault unattended; if the heap is already
      // halfway to the measured 4096MB ceiling, one more full-deck inline is what tips it over.
      //
      // It DEFERS rather than giving up. The first version of this guard returned an empty map
      // immediately, and the Browser counted that as one of a talk's two attempts — so while the
      // editor lane held the heaviest deck inlined (a 3.2GB spike), a whole vault's worth of talks
      // burned both attempts in seconds and every card stayed schematic until relaunch, with the
      // PNGs already on disk. The heap comes down on its own; the sweep can wait for it.
      if (lane === BROWSER_THUMBNAIL_LANE) {
        const slug = basename(outlinePath).replace('-outline.md', '')
        const first = heapGuardDecision(process.memoryUsage().heapUsed)
        if (first.skip) {
          logThumbnails(`heap at ${first.heapMb} MB — deferring ${slug} until it drops`)
          // Outside the single-flight gate on purpose: holding it for up to three minutes would
          // stall the editor lane, which is both the thing using the heap and the thing the user
          // is watching. The wait takes its turn in the gate only when it is ready to prepare.
          const waited = await waitForHeap(() => process.memoryUsage().heapUsed)
          const seconds = Math.round(waited.waitedMs / 1000)
          if (!waited.proceeded) {
            logThumbnails(
              `heap at ${waited.heapMb} MB after ${seconds}s of a ${Math.round(THUMBNAIL_HEAP_WAIT_MAX_MS / 1000)}s wait ` +
              `(${waited.reads} reads) — skipping ${slug} this pass; the Browser will offer it again`
            )
            return {}
          }
          logThumbnails(`heap at ${waited.heapMb} MB after ${seconds}s — resuming ${slug}`)
        }
      }
      const mediaOptions = thumbnailMediaOptions(lane, await browserThumbnailMediaOptions())
      if (lane === BROWSER_THUMBNAIL_LANE && !mediaOptions) {
        // Never fall back to the standing defaults here: inlining every video of every talk in the
        // vault is precisely the crash. A missing thumbnail is the safe answer.
        logThumbnails('the video-free media contract is unavailable — skipping the background pass')
        return {}
      }
      const requestId = typeof opts?.requestId === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(opts.requestId) ? opts.requestId : null
      const progress = requestId ? (thumbnails: Record<string, string>): void => {
        if (!_event.sender.isDestroyed()) _event.sender.send('talk:thumbnail-progress', { outlinePath, requestId, thumbnails })
      } : undefined
      if (editorWindows.get(_event.sender.id) !== editorAtRequest) return {}
      const result = await latestThumbnailRequest(owner, { outlinePath, content, lane, mediaOptions, progress })
      // Backstop for the path the render callback never reaches: a superseded request still
      // PREPARED its deck, and that model would otherwise sit retained with no follow-up to use it.
      if (lane === BROWSER_THUMBNAIL_LANE) {
        preparedTalkCache.evict(preparedTalkGroup(outlinePath, undefined, mediaOptions))
      }
      if (result && Object.keys(result).length === 0 && content.trim()) {
        const message = `request for ${basename(outlinePath)} (owner ${owner}) was superseded or aborted before it finished`
        if (lane === BROWSER_THUMBNAIL_LANE) logThumbnails(message)
        else console.warn(`[thumbnails] ${message}`)
      }
      return result
    } catch (e) {
      console.error('[thumbnails]', e)
      return null
    }
  })

  // The renderer keys its per-file save queue by the identity key (lib/saveQueue.ts), resolved on every
  // write, so every alias of one outline shares one queue and a retargeted link moves to its new file.
  ipcMain.handle('talk:outline-identity', (_event, outlinePath: unknown) =>
    typeof outlinePath === 'string' && outlinePath ? outlineIdentity(outlinePath) : null)
}
