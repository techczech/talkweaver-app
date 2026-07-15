import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { PaletteCommandHandlerId } from '../shared/command-registry'

export type TalkInfo = {
  name: string
  path: string
  outlinePath: string
  title: string
  slug: string
}

export type TalkMeta = Record<string, {
  slideCount: number | null
  createdMs: number
  editedMs: number
  // First slide's thumb-cache key — the talk's cover is twthumb://<slug>/<coverKey>. Null until indexed.
  coverKey: string | null
  // Slides with actionable compiler warnings (0 until indexed).
  warningCount: number
  // Frontmatter context (mtime-cached head parse in main); null when the outline has none.
  subtitle: string | null
  event: string | null
  pathwayCount: number
  pathwayNames: string[]
}>

export type BackupRun = {
  at: number
  ok: boolean
  exported: number
  skipped: number
  failed: number
  folder?: string
  error?: string
}

export type BackupSettings = {
  enabled: boolean
  folder: string | null
  intervalMin: number
  lastRun: BackupRun | null
}

export type TimerSettings = {
  warnAtMinutes: number
  urgentAtMinutes: number
}

export type ArchiveImageHit = {
  assetKey: string
  presentationId: string
  relPath: string
  sha256?: string
  ocrText: string
  /** twarchive://<base64url of absolute file path> — renderable thumbnail URL. */
  thumbUrl: string
  deckTitle?: string
}

export type ProjectionRow = {
  slide_id: string
  deck_slug: string
  order: number
  section: string
  subsection: string
  role: string
  layout: string
  nav_title: string
  title: string
  text_excerpt: string
  word_count: number
  bullet_count: number
  image_count: number
  source_markdown: string
  triggers: Record<string, string>
  /** Embed + video blocks on the slide (the projection counts the two together). Absent
   *  only on pre-v0.15 cached index rows. */
  embed_count?: number
  has_quote?: boolean
  has_table?: boolean
  has_code?: boolean
  /** Curated slide tags (ADR-0037): the Trigger line's `tags=` token, lowercase-kebab
   *  normalised; [] when the slide is untagged. Absent only on pre-tags cached index rows. */
  tags?: string[]
  /** 1-based source line of this slide's heading (null for synthesized cover/closing slides) —
   *  the editor↔strip sync reads this directly so it can never drift. */
  source_line?: number | null
  content_hash: string
  /** Hash of the rendered slide MODEL (layout + blocks), not just text — the thumbnail cache key. */
  render_hash: string
  /** Per-slide compiler warnings (e.g. `iconlist-no-icons:<slide-id>`); surfaced as a slide badge. */
  warnings?: string[]
}

// One recorded version of a slide id in the vault's version store (_SLIDE-VERSIONS), as
// 13-slide-ledger's listVersions returns it — `file` is the version's store filename (the
// stable per-version handle version thumbnails and adoption key off).
export type LedgerVersion = {
  file: string
  id: string | null
  talk: string | null
  outline: string | null
  savedAt: number
  sealed: boolean
  sealedBy: string | null
  lineage: string | null
  markdown: string
}

// One where-used row judged against the version being adopted (ADR-0032):
// 'identical' | 'behind' (matches an older recorded version) | 'diverged' (matches none).
// `outline` is vault-relative — pass it straight back to ledger.adopt.
export type LedgerStatusRow = {
  talk: string
  outline: string
  status: 'identical' | 'behind' | 'diverged'
  currentMarkdown: string
  /** 0-based line of the slide's heading in its outline. */
  headingLine: number
}

export type LedgerDiffLine = { kind: 'same' | 'del' | 'add'; text: string }

export type LedgerAdoptResult = {
  replaced: Array<{ talk: string; outline: string }>
  failed: Array<{ talk: string; outline: string; error: string }>
}

// Result of merging a byte-identical cluster to one shared id (ADR-0032). `ok:false` is a whole-call
// refusal (reason: 'no-targets' | 'no-located-targets' | 'not-identical'); `ok:true` reports the
// canonical id every copy now carries, the copies stamped (`oldId` = each copy's prior id, or null
// if it was unstamped) and any per-target failures. null when the IPC call itself was rejected.
export type LedgerMergeResult =
  | { ok: false; reason: string; offending: Array<{ outline: string; heading: string; occurrence: number }> }
  | {
      ok: true
      canonicalId: string
      merged: Array<{ outline: string; oldId: string | null }>
      failed: Array<{ outline: string; error: string }>
    }

// Published handout metadata per Talk, for History's delivered-talks ledger.
export type TalkHandouts = Record<string, { title: string; outlinePath: string; handoutUrl: string | null }>

export type RunStatus = 'planned' | 'delivered'
export type RunSlideSet = { kind: 'full' } | { kind: 'pathway'; pathwayId: string }

export type Pathway = { id: string; name: string; note?: string; slideIds: string[] }
export type ResolvedPathway = Pathway & { present: ProjectionRow[]; missing: string[] }
export type PathwaySnapshot = { slides: ProjectionRow[]; pathways: ResolvedPathway[] }
export type PathwayWindowContext = { outlinePath: string; talkSlug: string; talkTitle: string }

// Cached liveness probe for a published handout URL. Main treats any failure as offline.
export type HistoryLiveCheck = { status: 'live' | 'offline'; checkedAt: string }
export type ToolsView = 'studio' | 'history' | 'pathways'
type ToolsShowPayload = { view: ToolsView; sessionId?: string; pathway?: PathwayWindowContext }
export type RecordingKind = 'delivery' | 'rehearsal' | 'recording'
export type HighlightRange = { block: number; start: number; end: number }
export type TranscriptSegment = { start: number; end: number; text: string }
export type Transcript = { engine: 'parakeet'; createdAt: string; segments: TranscriptSegment[] }
export type TrimRange = { start: number; end: number }
export type TranscriptionSettings = {
  python: string
  script: string
  ffmpeg: string
  defaultPython: string
  defaultScript: string
}
// One recorded settings change (Gate-5 settings changelog): old → new, when, per machine.
export type SettingsChangeEntry = { at: number; key: string; label: string; from: string; to: string }

let lastToolsShow: ToolsShowPayload | null = null
const toolsShowSubscribers = new Set<(payload: ToolsShowPayload) => void>()

ipcRenderer.on('tools:show', (_event, payload: ToolsShowPayload) => {
  lastToolsShow = payload
  toolsShowSubscribers.forEach((cb) => cb(payload))
})

// One recorded Session (ADR-0035) as it lives in the Vault Presentation Ledger — audio + a
// slide-time index keyed to Slide Ledger ids, plus timing. `slideTimeIndex` marks are enter
// (with slideId) / pause / resume, on the pause-aware recording clock.
export type RecordingSession = {
  id: string
  talkSlug: string
  talkTitle: string
  /** Missing on legacy session.json files; main normalises it to delivery when reading. */
  kind: RecordingKind
  /** Missing on legacy records; main/History interprets it as delivered without rewriting. */
  status?: RunStatus
  plannedDate?: string
  eventTitle?: string
  audience?: string
  slideSet?: RunSlideSet
  handoutUrl?: string
  startedAt: string
  endedAt: string
  recordingMs: number
  wallClockMs: number
  timerTargetMin: number
  context: string | null
  pathwayId: string | null
  audio: { r2Key: string; bytes: number; uploaded: boolean } | null
  transcript: null
  trims?: TrimRange[]
  // enter = slide change · reveal = in-slide build step (hidden = fragments still hidden) ·
  // highlight = live highlight change (marks = count; ranges = reconstructed text spans when available) ·
  // pause/resume. All on the recording clock.
  slideTimeIndex: Array<{ event: string; slideId?: string; tMs: number; hidden?: number; marks?: number; ranges?: HighlightRange[] }>
}

// Metadata Registry surfaces (ADR-0036). The registry itself (key definitions, explanations,
// vocabularies) is shared code — src/shared/metadata-registry.ts — imported directly by the
// renderer; these IPCs are the vault-wide services only.
export type MetadataDoctorTalk = {
  talk: string
  slug: string
  outlinePath: string
  unregistered: Array<{ key: string; value: string }>
}
export type MetadataVocabulary = Record<string, Array<{ value: string; count: number }>>
export type FrontmatterEdit = { key: string; value: string | null; aliases?: string[] }

// Slide tags (ADR-0037). A target addresses one slide OCCURRENCE in one outline: by its
// stamped {id=…} when it has one (main tags every block carrying that id in that outline —
// normally exactly one), else by its verbatim heading line + 1-based occurrence.
export type TagTarget = { outline: string; id?: string | null; heading?: string; occurrence?: number }
export type TagApplyResult =
  | { ok: true; applied: Array<{ outline: string; tags: string[][] }>; failed: Array<{ outline: string; error: string }> }
  | { ok: false; reason: string }
export type TagCount = { name: string; count: number }

const api = {
  app: {
    onCommand: (cb: (command: PaletteCommandHandlerId) => void): (() => void) => {
      const listener = (_event: unknown, command: PaletteCommandHandlerId): void => cb(command)
      ipcRenderer.on('app:command', listener)
      return () => ipcRenderer.removeListener('app:command', listener)
    }
  },
  tags: {
    // Merge-only tag write across outlines (engine applySlideTags): `add` joins each slide's
    // existing tags, `remove` leaves everything else untouched; other Trigger tokens (incl.
    // {id=…}) are byte-preserved. Callers flush the active talk's autosave FIRST and re-read
    // the outline afterwards (adoption pattern). Null = the whole call was rejected.
    apply: (targets: TagTarget[], add: string[], remove: string[]): Promise<TagApplyResult | null> =>
      ipcRenderer.invoke('tags:apply', targets, add, remove),
    // Every tag observed across the vault with occurrence counts (live search index).
    vocabulary: (): Promise<TagCount[]> => ipcRenderer.invoke('tags:vocabulary')
  },
  metadata: {
    // Unregistered frontmatter keys per outline (5s-cached vault scan; ignore list respected).
    doctor: (): Promise<MetadataDoctorTalk[]> => ipcRenderer.invoke('metadata:doctor'),
    // Observed values for declared open-vocabulary keys, vault-wide, with usage counts.
    vocabulary: (): Promise<MetadataVocabulary> => ipcRenderer.invoke('metadata:vocabulary'),
    // "Keep (ignore)": stop the doctor flagging `key` in THIS outline (userData ignore list).
    ignoreKey: (outlinePath: string, key: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('metadata:ignore-key', outlinePath, key),
    // In-place frontmatter edit (set value / null = remove). Returns the full new outline text —
    // the caller MUST adopt it into any live editor buffer (publish-handout adoption pattern).
    editFrontmatter: (
      outlinePath: string,
      edits: FrontmatterEdit[]
    ): Promise<{ ok: true; content: string; changed: boolean } | { ok: false; error: string }> =>
      ipcRenderer.invoke('metadata:edit-frontmatter', outlinePath, edits)
  },
  vault: {
    getRoot: (): Promise<string | null> => ipcRenderer.invoke('vault:get-root'),
    setRoot: (path: string): Promise<void> => ipcRenderer.invoke('vault:set-root', path),
    chooseRoot: (): Promise<string | null> => ipcRenderer.invoke('vault:choose-root'),
    listTalks: (): Promise<TalkInfo[]> => ipcRenderer.invoke('vault:list-talks'),
    onTalksBatch: (cb: (payload: { batch: TalkInfo[]; reset: boolean; done: boolean }) => void): (() => void) => {
      const listener = (_event: unknown, payload: { batch: TalkInfo[]; reset: boolean; done: boolean }): void => cb(payload)
      ipcRenderer.on('vault:talks-batch', listener)
      return () => ipcRenderer.removeListener('vault:talks-batch', listener)
    },
    talkMeta: (): Promise<TalkMeta> => ipcRenderer.invoke('vault:talk-meta'),
    // Fires when the search index (source of slide counts) has new data — e.g. the background
    // warmer finished indexing talks that had no cached count yet. Returns an unsubscribe fn.
    onTalkMetaUpdated: (cb: () => void): (() => void) => {
      const listener = (): void => cb()
      ipcRenderer.on('vault:talk-meta-updated', listener)
      return () => ipcRenderer.removeListener('vault:talk-meta-updated', listener)
    },
    createTalk: (opts: { title: string; slug: string; topicFolder?: string }): Promise<TalkInfo | null> =>
      ipcRenderer.invoke('vault:create-talk', opts),
    // Clone a talk (copy its folder, retitle, strip the published handout link). Lands as a sibling.
    cloneTalk: (outlinePath: string, newTitle: string): Promise<TalkInfo | null> =>
      ipcRenderer.invoke('vault:clone-talk', outlinePath, newTitle),
    // Rename a talk in place (retitle frontmatter; new slug ⇒ folder + slug files renamed).
    // Errors: 'open-elsewhere' (another window holds it), 'target-exists' (slug folder taken).
    renameTalk: (outlinePath: string, newTitle: string): Promise<TalkInfo | { error: string } | null> =>
      ipcRenderer.invoke('vault:rename-talk', outlinePath, newTitle),
    // Folder management — folders are real vault subfolders (paths are vault-relative, '' = root).
    createFolder: (name: string, parentRel?: string): Promise<string | null> =>
      ipcRenderer.invoke('vault:create-folder', name, parentRel),
    renameFolder: (folderRel: string, newName: string): Promise<string | null> =>
      ipcRenderer.invoke('vault:rename-folder', folderRel, newName),
    moveTalk: (outlinePath: string, destFolderRel: string): Promise<TalkInfo | null> =>
      ipcRenderer.invoke('vault:move-talk', outlinePath, destFolderRel),
    // Category folders (vault-rel paths), INCLUDING empty ones, so a just-created folder is visible.
    listFolders: (): Promise<string[]> => ipcRenderer.invoke('vault:list-folders'),
    // Delete → OS Trash (recoverable), for talks/folders created by accident.
    deleteTalk: (outlinePath: string): Promise<boolean> => ipcRenderer.invoke('vault:delete-talk', outlinePath),
    deleteFolder: (folderRel: string): Promise<boolean> => ipcRenderer.invoke('vault:delete-folder', folderRel)
  },
  settings: {
    // Configured folders the app reads from. A null override = the auto-detected default is in use.
    getPaths: (): Promise<{
      vaultRoot: string | null
      archiveRoot: string | null
      archiveDefault: string
      archiveAvailable: boolean
    }> => ipcRenderer.invoke('settings:get-paths'),
    chooseArchive: (): Promise<string | null> => ipcRenderer.invoke('settings:choose-archive'),
    clearArchive: (): Promise<string> => ipcRenderer.invoke('settings:clear-archive'),
    // Presentation backup (ADR-0028 sibling feature): auto-write each Talk's full presenter HTML to a
    // folder inside OneDrive/Dropbox on a timer, so a forgotten laptop never blocks presenting.
    getBackup: (): Promise<BackupSettings> => ipcRenderer.invoke('settings:get-backup'),
    setBackup: (patch: { enabled?: boolean; intervalMin?: number }): Promise<BackupSettings> =>
      ipcRenderer.invoke('settings:set-backup', patch),
    chooseBackupFolder: (): Promise<BackupSettings> => ipcRenderer.invoke('settings:choose-backup-folder'),
    clearBackupFolder: (): Promise<BackupSettings> => ipcRenderer.invoke('settings:clear-backup-folder'),
    // Presenter clock amber/dark-amber thresholds (Task 3): global default; a deck's own
    // frontmatter `warn-at:`/`urgent-at:` overrides these per-talk.
    getTimer: (): Promise<TimerSettings> => ipcRenderer.invoke('settings:get-timer'),
    setTimer: (patch: { warnAtMinutes?: number; urgentAtMinutes?: number }): Promise<TimerSettings> =>
      ipcRenderer.invoke('settings:set-timer', patch),
    // Local Parakeet bridge paths. These are non-secret and default to the speech-to-text skill.
    getTranscription: (): Promise<TranscriptionSettings> => ipcRenderer.invoke('settings:get-transcription'),
    setTranscription: (cfg: { python: string; script: string; ffmpeg: string }): Promise<TranscriptionSettings> =>
      ipcRenderer.invoke('settings:set-transcription', cfg),
    // Settings changelog (Gate-5): every settings change recorded old → new in a per-machine
    // userData JSON log; Settings → Changes lists it with a per-entry Reset. Never secret values.
    getChangelog: (): Promise<SettingsChangeEntry[]> => ipcRenderer.invoke('settings:changelog-get'),
    logChange: (entry: { key: string; label: string; from: string; to: string }): Promise<SettingsChangeEntry[]> =>
      ipcRenderer.invoke('settings:changelog-log', entry)
  },
  backup: {
    // Force a backup of every Talk now (ignores change-detection).
    runNow: (): Promise<BackupRun> => ipcRenderer.invoke('backup:run-now'),
    // Subscribe to backup-run status pushes; returns an unsubscribe fn.
    onStatus: (cb: (run: BackupRun) => void): (() => void) => {
      const listener = (_e: unknown, run: BackupRun): void => cb(run)
      ipcRenderer.on('backup:status', listener)
      return () => ipcRenderer.removeListener('backup:status', listener)
    }
  },
  talk: {
    readOutline: (outlinePath: string): Promise<string | null> =>
      ipcRenderer.invoke('talk:read-outline', outlinePath),
    // Truthy on success (callers only truth-test it); `collisions` lists slide ids saved into a
    // second talk while another head exists (Slide Ledger, ADR-0032). False on write failure.
    // `{ ok: false, refused: 'empty-over-nonempty' }` when the data-loss backstop declined to
    // overwrite a non-empty outline with a structurally-empty payload (main process guard).
    // `content` (heading-is-slide, Task 8) is present when save-time id stamping changed the
    // bytes on disk: it is the STAMPED text the main process actually wrote. The caller should
    // adopt it into its buffer (Editor.tsx does, via minimalChange) so the next save sends
    // already-stamped text — otherwise the main process falls back to id reuse by heading.
    writeOutline: (
      outlinePath: string,
      content: string
    ): Promise<{ ok: true; collisions: string[]; content?: string } | { ok: false; refused: 'empty-over-nonempty' } | false> =>
      ipcRenderer.invoke('talk:write-outline', outlinePath, content),
    compile: (outlinePath: string, content: string): Promise<ProjectionRow[] | null> =>
      ipcRenderer.invoke('talk:compile', outlinePath, content),
    // Embed preflight: per embed, whether it will actually display when presenting (catches
    // embedding-disabled YouTube videos, private/deleted videos, and sites that refuse framing).
    checkEmbeds: (
      outlinePath: string,
      content: string
    ): Promise<Array<{
      slideId: string
      title: string
      url: string
      kind: 'youtube' | 'vimeo' | 'site'
      status: 'ok' | 'embedding-disabled' | 'not-found' | 'refuses-framing' | 'unreachable' | 'unknown'
      detail: string
    }>> => ipcRenderer.invoke('talk:check-embeds', outlinePath, content),
    // "Explain rendering" (ADR-0024): the actual render decisions for slide #index, read off the
    // compiled <section> data-* attributes — so the UI can show WHY a slide rendered as it did.
    explainSlide: (
      outlinePath: string,
      content: string,
      index: number
    ): Promise<{
      navTitle: string
      layout: string
      titleLayout: string
      role: string
      mode: string
      split: string
      triggers: string[]
      wordCount: number
      bulletCount: number
      imageCount: number
      warnings: string[]
    } | null> => ipcRenderer.invoke('talk:explain-slide', outlinePath, content, index),
    present: (
      outlinePath: string,
      content: string,
      mode?: 'window' | 'presenter' | 'audience',
      // Ledger {id=…} to open on. The deck runtime reads the URL hash on init and starts on the
      // slide whose dataset.id matches (present-from-here / ⇧F5). Omit to start at the top.
      startSlideId?: string,
      plannedRunId?: string
    ): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('talk:present', outlinePath, content, mode, startSlideId, undefined, plannedRunId),
    build: (outlinePath: string, content: string): Promise<{ success: boolean; outPath?: string; error?: string }> =>
      ipcRenderer.invoke('talk:build', outlinePath, content),
    buildVariants: (
      outlinePath: string,
      content: string
    ): Promise<{ success: boolean; outPaths?: string[]; error?: string }> =>
      ipcRenderer.invoke('talk:build-variants', outlinePath, content),
    // Export just the audience-facing handout HTML (share-no-notes) → dist/{slug}-handout.html.
    exportHandout: (
      outlinePath: string,
      content: string
    ): Promise<{ success: boolean; path?: string; error?: string }> =>
      ipcRenderer.invoke('talk:export-handout', outlinePath, content),
    // Publish the handout to the user's Cloudflare Pages site (Settings → Publishing). Returns the
    // live URL; `updatedOutline` reflects the handout_url stamp written into the outline (the
    // renderer must adopt it so autosave doesn't erase the stamp).
    publishHandout: (
      outlinePath: string,
      content: string
    ): Promise<{
      success: boolean
      url?: string
      display?: string
      error?: string
      updatedOutline?: string
    }> => ipcRenderer.invoke('talk:publish-handout', outlinePath, content),
    thumbnails: (outlinePath: string, content: string): Promise<Record<string, string> | null> =>
      ipcRenderer.invoke('talk:thumbnails', outlinePath, content),
    // Manual rebuild: wipe this talk's thumbnail cache so the next compile re-renders from scratch.
    clearThumbCache: (slug: string): Promise<boolean> => ipcRenderer.invoke('talk:clear-thumb-cache', slug),
    // Convert a talk's relative PNG/JPG images to WebP (smaller → faster previews + handouts).
    // Returns the rewritten outline; originals go to the OS Trash (recoverable).
    optimizeImages: (
      outlinePath: string,
      content: string
    ): Promise<{ success: boolean; converted?: number; savedBytes?: number; failed?: number; newContent?: string; error?: string }> =>
      ipcRenderer.invoke('talk:optimize-images', outlinePath, content),
    // Cross-talk reuse: materialize a slide's relative images into the vault pool (img-<hash>) so they
    // resolve in the destination talk. Returns the rewritten markdown.
    materializeSlideAssets: (
      sourceOutlinePath: string,
      markdown: string
    ): Promise<{ success: boolean; markdown: string; materialized?: number; error?: string }> =>
      ipcRenderer.invoke('talk:materialize-slide-assets', sourceOutlinePath, markdown),
    // Cross-talk reuse for TEXT-PASTED slides (no source path): resolve relative assets/<name> refs
    // by filename across the vault, copy into the pool (img-<hash>), rewrite. Returns rewritten markdown.
    materializePastedAssets: (
      markdown: string
    ): Promise<{ success: boolean; markdown: string; materialized?: number; error?: string }> =>
      ipcRenderer.invoke('talk:materialize-pasted-assets', markdown),
    // OCR-index the vault's images (native macOS Vision) so search matches text INSIDE images.
    ocrIndex: (): Promise<{ success: boolean; total?: number; cached?: number; added?: number; error?: string }> =>
      ipcRenderer.invoke('talk:ocr-index')
  },
  // Slide Ledger (ADR-0032): per-slide identity, history, and cross-talk usage.
  ledger: {
    // Every talk whose outline currently contains the slide id.
    whereUsed: (id: string): Promise<Array<{ talk: string; outline: string }>> =>
      ipcRenderer.invoke('ledger:where-used', id),
    // Version history for a slide id (head first).
    versions: (id: string): Promise<LedgerVersion[]> => ipcRenderer.invoke('ledger:versions', id),
    // Fork a shared slide in place: mint a fresh id for THIS occurrence, write the outline,
    // and record the lineage (new id ← old id). Null if the slide could not be found.
    detach: (outlinePath: string, content: string, ref: { heading: string; occurrence: number }): Promise<{ text: string; oldId: string; newId: string } | null> =>
      ipcRenderer.invoke('ledger:detach', outlinePath, content, ref),
    // Per-outline adoption status for a slide id, judged against `adoptMarkdown` (the version
    // being adopted). Null on any failure — the ledger never throws into the renderer.
    status: (id: string, adoptMarkdown: string): Promise<LedgerStatusRow[] | null> =>
      ipcRenderer.invoke('ledger:status', id, adoptMarkdown),
    // Loss-proof adoption (ADR-0032): version-then-replace `id`'s block with `versionMarkdown`
    // in each vault-relative target outline. Per-target isolation — one failure lands in
    // `failed`, the rest proceed. Null if the whole call was rejected (bad id / path outside vault).
    adopt: (id: string, versionMarkdown: string, targetOutlines: string[]): Promise<LedgerAdoptResult | null> =>
      ipcRenderer.invoke('ledger:adopt', id, versionMarkdown, targetOutlines),
    // Duplicate merge (ADR-0032): unify a byte-identical cluster under ONE shared {id=…} so the
    // ledger holds a single entry (where-used across N talks) and future searches show just one
    // card. `targets` address each copy by { outline, heading, occurrence }. Loss-proof — every
    // re-id is versioned first. Null if the whole call was rejected (bad target / path outside vault).
    mergeDuplicates: (
      targets: Array<{ outline: string; heading: string; occurrence: number }>
    ): Promise<LedgerMergeResult | null> => ipcRenderer.invoke('ledger:merge-duplicates', targets),
    // Real compiled thumbnail per recorded version of `id`: { versionFile: 'twthumb://…' }.
    // Content-addressed and rendered in one hidden-window batch; {} when the id has no versions.
    versionThumbnails: (id: string): Promise<Record<string, string> | null> =>
      ipcRenderer.invoke('ledger:version-thumbnails', id),
    // Human-readable side-by-side line diff (classic LCS, computed in the engine).
    diff: (a: string, b: string): Promise<LedgerDiffLine[]> => ipcRenderer.invoke('ledger:diff', a, b)
  },
  slide: {
    // Compile the full live outline through the presentation pipeline and return its stable
    // twpresent:// document URL. The renderer adds a slide-id hash for navigation.
    renderPreview: (outlinePath: string, outlineContent: string): Promise<string | null> =>
      ipcRenderer.invoke('slide:render-preview', outlinePath, outlineContent)
  },
  publish: {
    // Cloudflare Pages publishing config (Settings → Publishing). getConfig NEVER returns the token —
    // only hasToken. The token is stored OS-keychain-encrypted in the main process via safeStorage.
    getConfig: (): Promise<{
      accountId: string
      project: string
      baseUrl: string
      useShortIds: boolean
      hasToken: boolean
    }> => ipcRenderer.invoke('publish:get-config'),
    setConfig: (cfg: {
      accountId: string
      project: string
      baseUrl: string
      useShortIds: boolean
    }): Promise<{ success: boolean }> => ipcRenderer.invoke('publish:set-config', cfg),
    setToken: (token: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('publish:set-token', token),
    clearToken: (): Promise<{ success: boolean }> => ipcRenderer.invoke('publish:clear-token')
  },
  asset: {
    pasteImage: (bytes: ArrayBuffer, ext?: string): Promise<{ id: string; ext: string; path: string } | null> =>
      ipcRenderer.invoke('asset:paste-image', bytes, ext ?? 'png'),
    // Ingest a video / animated GIF (ADR-0028). Pass a file `path` (drag-drop) or `bytes` (paste).
    // GIFs convert to MP4; the result is content-addressed as `vid-<id>` with a generated poster.
    // `origin`: 'gif' (autoplay/loop), 'video' (manual), or 'image' (static GIF / conversion fallback → img-).
    addVideo: (input: { path?: string; bytes?: ArrayBuffer; ext?: string }): Promise<
      { success: boolean; id?: string; ext?: string; origin?: 'gif' | 'video' | 'image'; warning?: string; error?: string }
    > => ipcRenderer.invoke('asset:add-video', input),
    // Absolute path of a dropped File (Electron 42 removed File.path; webUtils is the replacement).
    pathForFile: (file: File): string => webUtils.getPathForFile(file),
    readSidecar: (
      id: string
    ): Promise<{ id: string; alt: string; caption: string; source: string; tags: string[] } | null> =>
      ipcRenderer.invoke('asset:read-sidecar', id),
    writeSidecar: (
      id: string,
      meta: { alt: string; caption: string; source: string; tags: string[] }
    ): Promise<boolean> => ipcRenderer.invoke('asset:write-sidecar', id, meta)
  },
  abstract: {
    read: (
      talkPath: string
    ): Promise<{ raw: string; frontmatter: Record<string, any>; body: string } | null> =>
      ipcRenderer.invoke('abstract:read', talkPath),
    write: (talkPath: string, raw: string): Promise<boolean> =>
      ipcRenderer.invoke('abstract:write', talkPath, raw)
  },
  outline: {
    reorder: (outlinePath: string, fromIndex: number, toIndex: number): Promise<string | null> =>
      ipcRenderer.invoke('outline:reorder', outlinePath, fromIndex, toIndex),
    // Pin (or clear, iconKey=null) the icon on ONE top-level list item of a slide, by writing the
    // canonical `{icon=KEY}` token at the end of that bullet's line. The item is addressed by its
    // 0-based position among the slide block's top-level list-item lines (the same indexing the
    // engine's setListItemIcon uses). Returns the rewritten outline text or null on error.
    setItemIcon: (
      content: string,
      slideHeading: string,
      slideOccurrence: number,
      itemIndex: number,
      iconKey: string | null
    ): Promise<string | null> =>
      ipcRenderer.invoke('outline:set-item-icon', content, slideHeading, slideOccurrence, itemIndex, iconKey),
    // Merge a picker-chosen trigger onto the slide under the caret line: same-key tokens
    // replaced (Trigger Dictionary), {id=…} and every other token kept verbatim (ADR-0032).
    mergeTrigger: (content: string, lineNumber: number, trigger: string): Promise<string | null> =>
      ipcRenderer.invoke('outline:merge-trigger', content, lineNumber, trigger)
  },
  search: {
    // Accepts either a bare string (legacy all-fields all-words) or the renderer's structured,
    // scoped query (t:/s:/i:/e: parsed via parseSearchQuery). Rows carry `titleHit` so the
    // Browser can float title matches to the front.
    allSlides: (
      query:
        | string
        | { scope: 'all' | 'title' | 'body' | 'image'; exact: boolean; text: string; terms: string[] }
    ): Promise<
      Array<ProjectionRow & { talkSlug: string; talkTitle: string; outlinePath: string; titleHit?: boolean }> | null
    > => ipcRenderer.invoke('search:all-slides', query)
  },
  archive: {
    available: (): Promise<boolean> => ipcRenderer.invoke('archive:available'),
    searchImages: (query: string): Promise<ArchiveImageHit[] | null> =>
      ipcRenderer.invoke('archive:search-images', query),
    importImage: (thumbUrlOrPath: string): Promise<{ id: string; ext: string; path: string } | null> =>
      ipcRenderer.invoke('archive:import-image', thumbUrlOrPath)
  },
  shell: {
    openPath: (path: string): Promise<boolean> => ipcRenderer.invoke('shell:open-path', path),
    openExternal: (url: string): Promise<boolean> => ipcRenderer.invoke('shell:open-external', url),
    // Reveal a file in Finder (select it in its folder) rather than opening it.
    showInFolder: (path: string): Promise<boolean> => ipcRenderer.invoke('shell:show-item-in-folder', path)
  },
  layout: {
    // Blank Markdown templates per layout (single source: html-presentations
    // reference/layout-templates.mjs). `templates` is keyed by bare trigger; `aliases` maps
    // alternate trigger words onto a template key. The picker uses these for ⌘-Enter / Space.
    templates: (): Promise<{ templates: Record<string, string>; aliases: Record<string, string> } | null> =>
      ipcRenderer.invoke('layout:templates'),
    // Real compiled preview per layout (Feature #3): { layoutName: twthumb://… } where each URL is
    // a PNG of that layout's canonical Reference fixture, rendered offscreen by the engine pipeline.
    // The picker fetches this once on first open and shows the real render, falling back to its
    // hand-drawn preview for any layout the map omits. Null on error (picker stays fully hand-drawn).
    previewThumbnails: (): Promise<Record<string, string> | null> =>
      ipcRenderer.invoke('layout:preview-thumbnails')
  },
  icons: {
    // Free-text icon search over the engine's vocabulary (Lucide names/tags + SVGL brands),
    // backed by 05-icons.mjs searchIcons. Returns the top matches as {key, source} where key is
    // `lucide:name` or `svgl:name`. The icon picker calls this per (debounced) keystroke.
    search: (query: string): Promise<Array<{ key: string; source: 'lucide' | 'svgl' }>> =>
      ipcRenderer.invoke('icons:search', query),
    // Render one icon key to its SVG markup (currentColor / brand fill), via 05-icons.mjs iconSvg.
    // Returns null when the key resolves to no drawable glyph.
    svg: (key: string): Promise<string | null> => ipcRenderer.invoke('icons:svg', key)
  },
  // TalkWeaver History (ADR-0035). The renderer joins these handout records with recorded
  // Sessions; live checks are cached in main and can be forced by the user's explicit re-check.
  history: {
    talkHandouts: (): Promise<TalkHandouts> => ipcRenderer.invoke('history:talk-handouts'),
    checkLive: (url: string, force = false): Promise<HistoryLiveCheck> =>
      ipcRenderer.invoke('history:check-live', url, force),
    listRuns: (talkSlug?: string): Promise<RecordingSession[]> => ipcRenderer.invoke('history:list-runs', talkSlug),
    createPlannedRun: (input: {
      talkSlug: string; talkTitle: string; plannedDate: string; eventTitle: string; audience: string; slideSet: RunSlideSet
    }): Promise<{ ok: boolean; run?: RecordingSession; error?: string }> => ipcRenderer.invoke('history:create-planned-run', input),
    updatePlannedRun: (talkSlug: string, runId: string, patch: Partial<{
      plannedDate: string; eventTitle: string; audience: string; slideSet: RunSlideSet
    }>): Promise<{ ok: boolean; run?: RecordingSession; error?: string }> =>
      ipcRenderer.invoke('history:update-planned-run', { talkSlug, runId, patch }),
    deletePlannedRun: (talkSlug: string, runId: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('history:delete-planned-run', { talkSlug, runId }),
    buildRunHandout: (talkSlug: string, runId: string): Promise<{
      success: boolean; path?: string; slideIds?: string[]; missing?: string[]; error?: string
    }> => ipcRenderer.invoke('run:build-handout', { talkSlug, runId }),
    publishRunHandout: (talkSlug: string, runId: string): Promise<{
      success: boolean; url?: string; path?: string; slideIds?: string[]; missing?: string[]; error?: string
    }> => ipcRenderer.invoke('run:publish-handout', { talkSlug, runId }),
    unpublishRunHandout: (talkSlug: string, runId: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('run:unpublish-handout', { talkSlug, runId })
  },
  replay: {
    // Build a fresh present HTML for this Talk and return a twpresent:// replay iframe URL.
    build: (talkSlug: string): Promise<{ success: boolean; url?: string; error?: string }> =>
      ipcRenderer.invoke('replay:build', talkSlug)
  },
  transcript: {
    // On-demand transcript for one recorded Run. Progress is pushed separately as readable notes.
    run: (talkSlug: string, sessionId: string): Promise<{ ok: boolean; segments?: TranscriptSegment[]; error?: string }> =>
      ipcRenderer.invoke('transcript:run', talkSlug, sessionId),
    get: (talkSlug: string, sessionId: string): Promise<Transcript | null> =>
      ipcRenderer.invoke('transcript:get', talkSlug, sessionId),
    cancel: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('transcript:cancel'),
    onProgress: (cb: (event: { sessionId: string; note: string }) => void): (() => void) => {
      const listener = (_e: unknown, event: { sessionId: string; note: string }): void => cb(event)
      ipcRenderer.on('transcript:progress', listener)
      return () => ipcRenderer.removeListener('transcript:progress', listener)
    }
  },
  tools: {
    open: (view: ToolsView, sessionId?: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('tools:open', view, sessionId),
    onShow: (cb: (payload: ToolsShowPayload) => void): (() => void) => {
      toolsShowSubscribers.add(cb)
      if (lastToolsShow) queueMicrotask(() => cb(lastToolsShow as ToolsShowPayload))
      return () => toolsShowSubscribers.delete(cb)
    },
    openPathways: (context: PathwayWindowContext): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('tools:open-pathways', context)
  },
  pathways: {
    onChanged: (cb: (event: { outlinePath: string }) => void): (() => void) => {
      const listener = (_event: unknown, payload: { outlinePath: string }): void => cb(payload)
      ipcRenderer.on('pathways:changed', listener)
      return () => ipcRenderer.removeListener('pathways:changed', listener)
    },
    read: (outlinePath: string, content: string): Promise<PathwaySnapshot | { error: string }> =>
      ipcRenderer.invoke('pathways:read', outlinePath, content),
    create: (outlinePath: string, content: string, name: string, note?: string): Promise<PathwaySnapshot | { error: string }> =>
      ipcRenderer.invoke('pathways:create', outlinePath, content, name, note),
    rename: (outlinePath: string, content: string, id: string, name: string): Promise<PathwaySnapshot | { error: string }> =>
      ipcRenderer.invoke('pathways:rename', outlinePath, content, id, name),
    delete: (outlinePath: string, content: string, id: string): Promise<PathwaySnapshot | { error: string }> =>
      ipcRenderer.invoke('pathways:delete', outlinePath, content, id),
    setSlideIds: (outlinePath: string, content: string, id: string, slideIds: string[]): Promise<PathwaySnapshot | { error: string }> =>
      ipcRenderer.invoke('pathways:set-slide-ids', outlinePath, content, id, slideIds),
    present: (outlinePath: string, content: string, id: string, plannedRunId?: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('talk:present', outlinePath, content, 'presenter', undefined, id, plannedRunId)
  },
  // Live deck windows (presenter / presentation window) → editor. ⌘E in a deck window asks main
  // to bring this editor window forward and jump to that slide; main forwards the deck's current
  // slide here (its ledger id + compiled index). Returns an unsubscribe fn.
  present: {
    onEditSlide: (cb: (payload: { slideId?: string; index?: number }) => void): (() => void) => {
      const listener = (_e: unknown, payload: { slideId?: string; index?: number }): void => cb(payload)
      ipcRenderer.on('present:edit-slide', listener)
      return () => ipcRenderer.removeListener('present:edit-slide', listener)
    },
    // ⌘R in a deck window asks the editor (here) for the talk's current content; we hand it back via
    // rebuild(), which recompiles + reloads the deck at its slide. onRefresh returns an unsubscribe fn.
    onRefresh: (
      cb: (payload: { outlinePath: string; slideId?: string; deckWcId: number }) => void
    ): (() => void) => {
      const listener = (_e: unknown, payload: { outlinePath: string; slideId?: string; deckWcId: number }): void => cb(payload)
      ipcRenderer.on('present:refresh', listener)
      return () => ipcRenderer.removeListener('present:refresh', listener)
    },
    rebuild: (deckWcId: number, outlinePath: string, content: string, slideId?: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('present:rebuild', deckWcId, outlinePath, content, slideId)
  },
  // Multi-window editing (⌘N): open a second editor window, and claim a talk for THIS window. A talk
  // can only be active in one window at a time — claimTalk returns { ok:false, reason:'open-elsewhere' }
  // (and focuses the window that has it) so the caller keeps its current talk. Pass null to release.
  windows: {
    open: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('window:new'),
    claimTalk: (outlinePath: string | null): Promise<{ ok: boolean; reason?: string }> =>
      ipcRenderer.invoke('window:claim-talk', outlinePath)
  },
  // Presentation recording (ADR-0035). The REC control itself lives in the presenter (injected by
  // the recorder bridge, not this API); here is the app-side config for where audio uploads.
  recording: {
    // R2 destination + discard threshold. NEVER returns the access keys — only hasKeys.
    getStorage: (): Promise<{
      endpoint: string
      bucket: string
      credsSource: 'bws' | 'settings'
      bwsSecretId: string
      discardSeconds: number
      hasKeys: boolean
    }> => ipcRenderer.invoke('recording:get-storage'),
    setStorage: (cfg: {
      endpoint: string
      bucket: string
      credsSource: 'bws' | 'settings'
      bwsSecretId: string
      discardSeconds: number
    }): Promise<{ success: boolean }> => ipcRenderer.invoke('recording:set-storage', cfg),
    // Store the R2 access keys (OS-keychain-encrypted in main; never read back to the renderer).
    setKeys: (keys: { accessKeyId: string; secretAccessKey: string }): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('recording:set-keys', keys),
    clearKeys: (): Promise<{ success: boolean }> => ipcRenderer.invoke('recording:clear-keys'),
    // Sessions recorded for a talk, from the Vault Presentation Ledger (newest first) — the
    // minimum Studio/History (Plans 2–3) read. Each is the session.json data model (ADR-0035).
    listSessions: (talkSlug: string): Promise<RecordingSession[]> =>
      ipcRenderer.invoke('recording:list-sessions', talkSlug),
    // Every Session across all talks (Studio's rail), newest first.
    listAllSessions: (): Promise<RecordingSession[]> => ipcRenderer.invoke('recording:list-all-sessions'),
    // Upload ONE session to R2 — direct and ONLY on request (never automatic). On failure the
    // recording stays local; error is 'r2-not-configured' / 'r2-no-credentials' / a network error.
    upload: (talkSlug: string, sessionId: string): Promise<{ ok: boolean; uploaded?: boolean; error?: string }> =>
      ipcRenderer.invoke('recording:upload', { talkSlug, sessionId }),
    // Edit (or clear) a session's context label.
    setContext: (talkSlug: string, sessionId: string, context: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('recording:set-context', { talkSlug, sessionId, context }),
    setKind: (
      talkSlug: string,
      sessionId: string,
      kind: RecordingKind
    ): Promise<{ ok: boolean; kind?: RecordingKind; error?: string }> =>
      ipcRenderer.invoke('recording:set-kind', { talkSlug, sessionId, kind }),
    setTrims: (
      talkSlug: string,
      sessionId: string,
      trims: TrimRange[]
    ): Promise<{ ok: boolean; trims?: TrimRange[]; error?: string }> =>
      ipcRenderer.invoke('recording:set-trims', { talkSlug, sessionId, trims }),
    // Delete a session — session.json + local audio go to the OS Trash (recoverable).
    deleteSession: (talkSlug: string, sessionId: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('recording:delete-session', { talkSlug, sessionId })
  }
}

contextBridge.exposeInMainWorld('tw', api)

declare global {
  interface Window {
    tw: typeof api
  }
}
