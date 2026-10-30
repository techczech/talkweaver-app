import type { ResearchWriteOp, ResearchWriteInput, ResearchWriteResult } from '../shared/research'
import type { HtmlPageChoice, HtmlPageImport } from '../shared/html-page-import'
import type { ResearchListInput, ResearchSearchInput, ResearchUsedInput, ResearchListResult, ResearchUsedResult } from '../shared/research'
import type { readAbstract } from '../main/abstract-ipc'
import type { ScratchPreparedInsert, ScratchInsertedRecord, ScratchGroup, ScratchReply, ScratchSlideInput, ScratchSnapshot, ScratchStatus, ScratchVisualImport } from '../shared/scratchpad'
export type { ScratchGroup, ScratchItem, ScratchReply, ScratchSlideInput, ScratchSnapshot, ScratchStatus, ScratchVisualImport } from '../shared/scratchpad'
import type { RecordingRecovery } from '../shared/recording-recovery'
export type { RecordingRecovery } from '../shared/recording-recovery'
import type { InkStroke } from '../../worker/protocol'
import type { RunAudioFields } from '../shared/run-audio'
import type { ImageSearchResult, ImageSearchStatus, ImportedImage, MatchMode, VaultPictureResult } from '../shared/image-search'
import type { VariantThumbnail } from '../shared/variant-thumbnail-result'
import type { EditorDocumentReply, EditorDocumentRequest } from '../shared/editor-document'
import type { RunQuestion, RunReaction } from '../shared/run-feedback'
import type { RunBoard } from '../shared/run-board'
import type { ExampleVaultResult } from '../shared/example-vault'
import type { ExampleRemovalPreview, ExampleRemovalState, ExampleRemoveResult, ExampleRestoreResult } from '../shared/example-vault-removal'
import type { ConnectionRow } from '../shared/guide-connections'
import type { CompactSlideSearchReply } from '../shared/slide-search-reply'
import type { RunPrework } from '../shared/run-prework'
import type { RunWorkSet } from '../shared/run-work'
import type { PickChange } from '../shared/run-prework-results'
import type { PreworkFeed } from '../../compiler/scripts/lib/prework.mjs'
import type { RunPollLike, RunPollResponseLike } from '../shared/run-poll-results'
import type { RunShareInclude, RunShareLifetime } from '../shared/run-results-share'
import type { OutlineChangedOnDiskRefusal, OutlineDiskAccept, OutlineDiskChange, OutlineRecoveryCopy } from '../shared/outline-disk-change'
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { WorkFilesListing } from '../shared/work-files-view'
import type { WorkFileAdd } from '../shared/work-file-write'

type WorkFileWriteResult = { ok: true; fileName: string; relPath: string; id?: string } | { ok: false; error: string }
import type { SessionSource } from '../shared/sessions-list'
import type { RunExtras } from '../shared/run-extras'
import type { RunExtraSlidesState } from '../shared/run-extra-slides'
import type { PublishedPagesInput } from '../shared/published-pages'
import type { PhaseSteps } from '../shared/run-answers'
import type { WorkFileState } from '../shared/run-checklist'
import { isToolsView, parseToolsRunRef, type ToolsRunRef, type ToolsView } from '../shared/tools-views'
import type { PaletteCommandHandlerId } from '../shared/command-registry'
import type { UpdateSnapshot } from '@app-patterns/updates'
import type { WhatsNewItem } from '@app-patterns/updates'
import type { LayoutDoctorFinding } from '../shared/layout-doctor'
import type { SharedTalkInspection, SharedTalkState } from '../shared/shared-talk'
import type { CloudflareStatus } from '../shared/cloudflare-status'
import type { RecordingStorageRow } from '../shared/recording-storage-status'
import type { GoingLiveRow, LiveSetupPrompt } from '../shared/live-service-status'
import type { TranscriptionRow } from '../shared/transcription-status'
import type { PublishNotReady } from '../shared/publish-status'
import type { FeedbackList, FeedbackStatus, FeedbackSummary } from '../shared/feedback'
import type { AcceptRecord } from '../shared/feedback-accept'
import type { TalkFolderCount, TalkSearchOptions, TalkSearchResult } from '../shared/talk-search'
import type { TalkTextModel } from '../main/talkText'
import type { DraftPart, NotesPart } from '../main/rewritePack'
import type { CleanMode, CleanPrepareOptions, TalkTextExportOptions } from '../main/talkTextIpc'
import type {
  ImportPackRequest,
  ImportProgress,
  ImportRunDetail,
  ImportRunManifest,
  ImportSlidePatch,
  ImportSourceInfo,
  ImportSourceSelection,
  ImportStartRequest,
  ImportSuggestion,
  ImporterSettings
} from '../shared/importer'

export type { TalkTextModel, DraftPart, NotesPart, CleanMode, CleanPrepareOptions, TalkTextExportOptions }
export type { TalkFolderCount, TalkSearchOptions, TalkSearchResult, TalkSearchHit, TalkMatchLine } from '../shared/talk-search'
export type { CloudflareStatus } from '../shared/cloudflare-status'
export type { RecordingStorageRow } from '../shared/recording-storage-status'
export type { GoingLiveRow, LiveSetupPrompt } from '../shared/live-service-status'
export type { TranscriptionRow } from '../shared/transcription-status'
export type { PublishNotReady } from '../shared/publish-status'
export type { ImageSearchHit, ImageSearchResult, ImageSearchStatus, ImageSource, ImageUse, ImportedImage, MatchMode, VaultPictureResult } from '../shared/image-search'

/** What outline.setHeadingIcon and outline.setParagraphIcon answer (compiler/scripts/lib/12-outline-edit.mjs). */
export type IconVerbResult =
  | { ok: true; text: string; changed: boolean }
  | { ok: false; text: string; reason: 'slide-not-found' | 'not-a-paragraph' | 'unknown-icon' | 'icon-set-elsewhere' | 'title-not-shown' | 'cannot-place-here' }

/**
 * What a publish that could not start, or that went up without live features, adds to its reply
 * (spec docs/plans/cloudflare-setup-in-app, D7 and the "not ready" table). Fixed sentences only.
 */
export type PublishReplyExtras = {
  /** Publishing could not start: what is missing and the one button that fixes it (the sheet). */
  notReady?: PublishNotReady
  /** "Published. Going live is not set up: Settings → Cloudflare", with the sorted reason when a set-up failed. */
  liveNotice?: string
  /** What lies behind `liveNotice`; shown on request, never as the message. */
  liveDetails?: string
  /** How many handouts an earlier version published with an address on this computer: they need publishing again. */
  earlierNotice?: string
  /** Their names, one to a line; shown on request. */
  earlierDetails?: string
}
// What every Settings → Cloudflare call answers. `error` is always a fixed sentence from the main
// process. The state itself (CloudflareStatus) is a shared type, as SharedTalkState and
// TalkSearchResult are; the reply that carries it over IPC is typed here.
export type CloudflareReply = { ok: true; status: CloudflareStatus } | { ok: false; error: string; status: CloudflareStatus }
/** What "Set up going live" (and Try again, and "Set up going live now") answers: the row, and on failure a fixed sentence with its Details (numbers only). */
export type LiveSetUpReply = { ok: true; row: GoingLiveRow; notice?: string } | { ok: false; error: string; details: string | null; row: GoingLiveRow }
export type {
  ImportPackRequest,
  ImportProgress,
  ImportRunDetail,
  ImportRunManifest,
  ImportSlidePatch,
  ImportSourceInfo,
  ImportSourceSelection,
  ImportStartRequest,
  ImportSuggestion,
  ImporterSettings
}

export type CleanedSlideItem = {
  slideNumber: number
  markdown: string
  approved: boolean
}

export type TalkInfo = {
  name: string
  path: string
  outlinePath: string
  title: string
  slug: string
  /** The vault the talk lives in. Main's scans do not set it; the renderer stamps it from the
   *  vault whose list the talk arrived in. */
  vaultId?: string
  /** Sync-conflict copies of the outline left to compare (several-vaults ticket 09); 0 or absent
   *  when none. Byte-identical copies are moved to the Trash and not counted. */
  conflicts?: number
}

/** One line of a talk's Activity list (Inspector; stored in app data, never in the vault). */
export type TalkActivityEntry = { at: string; kind: string; title: string; detail?: string }

/** A vault as the Talks panel shows it (src/main/vault-view.ts). */
export type VaultView = {
  id: string
  /** The folder. Used to place talks in folders; never displayed. */
  root: string
  open: boolean
  order: number
  /** What every surface calls the vault: `Name · Service` when another vault has the same name. */
  name: string
  /** The vault's own name, without the service suffix. */
  baseName: string
  initial: string
  color: string
  service: 'OneDrive' | 'Dropbox' | 'Google Drive' | 'Git' | 'Local'
  /** From the vault file: others can open it (people mark) or only me (padlock). */
  shared: boolean
  /** The vault file exists; else a plain folder (the file is written on first Save). */
  hasFile: boolean
  createdBy: string | null
  /** Closed as a copy of this vault (the duplicate state). */
  duplicateOf: { id: string; name: string } | null
  /** Its folder is missing or unreadable right now: greyed section, no talks, one action (ticket 07). */
  unavailable: VaultUnavailableInfo | null
  /** The example vault (onboarding ticket 06): Example pill, "Removable · local folder", teal badge. */
  example?: boolean
}
export type VaultUnavailableInfo = {
  reason: 'not-signed-in' | 'folder-moved' | 'no-permission' | 'folder-not-found' | 'not-responding'
  message: string
  action: 'open-service' | 'retry'
  actionLabel: string
}
/** The vault a refusal is about, by name and badge (never a path). */
export type VaultRef = { id: string; name: string; initial: string; color: string; service: VaultView['service'] }
export type VaultActionResult =
  | { ok: true; vault: VaultView }
  | { ok: false; reason: string; message: string; other?: VaultRef | null }
/** The shared group of Edit this vault (written to the vault file). */
export type VaultSharedFields = { name: string; shared: boolean; affiliation: string; style: string; logo: string }
/** "Just for me" (app config, by vault id). */
export type VaultPersonalFields = { author?: string; badgeColour?: string; badgeInitial?: string }
export type VaultStyleOption = { value: string; label: string }
export type ChosenVaultFolder =
  | {
    ok: true
    token: string
    kind: 'new' | 'join'
    folderName: string
    service: VaultView['service']
    vault: (VaultSharedFields & { styleLabel: string; logoPreview: string | null; createdBy: string | null }) | null
    suggested: { name: string; author: string; badgeColour: string; badgeInitial: string }
    swatches: string[]
    styles: VaultStyleOption[]
  }
  | { ok: false; reason: string; message: string; other?: VaultRef | null }
export type VaultSettingsResult =
  | {
    ok: true
    vault: VaultView
    fields: VaultSharedFields
    logoPreview: string | null
    personal: VaultPersonalFields
    appAuthor: string
    swatches: string[]
    styles: VaultStyleOption[]
    fileProblem: string | null
  }
  | { ok: false; reason: string; message: string; other?: VaultRef | null }
/** A logo inside the vault comes back as `logo` (vault-relative); one outside it as `upload` (a token
 *  main holds; the file is copied into <vault>/_assets/logos on Save / Create) with its file name. */
export type ChosenVaultLogo = { ok: true; logo: string; preview: string | null; upload?: string; fileName?: string } | { ok: false; reason: string; message: string }
/** What Create / Save send: the shared fields, plus a pending outside logo's token. */
export type VaultSharedPatch = VaultSharedFields & { logoUpload?: string }
export type TalkVaultDefaults = {
  vault: { id: string; name: string; initial: string; color: string }
  values: Array<{ key: string; label: string; value: string; source: 'vault' | 'personal' | 'app' }>
} | null

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
  // Ticket 11: which talks got no copy, and why — a count alone could not say that a run
  // reporting "3 saved" had quietly refused a fourth for being too large.
  skippedTalks: Array<{ slug: string; reason: string }>
  folder?: string
  error?: string
}

// ADR-0024: the talks backup actually covers — the ones edited IN THE APP, not the vault.
export type BackupTalk = {
  slug: string
  title: string
  enrolled: boolean
  lastAppEditAt: number
  lastBackupAt: number
}

export type BackupSettings = {
  enabled: boolean
  folder: string | null
  intervalMin: number
  lastRun: BackupRun | null
  talks: BackupTalk[]
}

export type TimerSettings = {
  warnAtMinutes: number
  urgentAtMinutes: number
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
  /** Where each image of the slide lands, in outline order (compiler decision; see shared/image-placement.ts). */
  image_placements?: Array<{ kind: string; index: number; count: number }>
  content_hash: string
  /** Hash of the rendered slide MODEL (layout + blocks), not just text — the thumbnail cache key. */
  render_hash: string
  /** Exact compiled artwork plus document styling/media identity. */
  thumbnail_hash?: string
  /** Per-slide compiler warnings (e.g. `iconlist-no-icons:<slide-id>`); surfaced as a slide badge. */
  warnings?: string[]
  /** ADR-0028 §10: the compiled title regime — 'left' (rail), 'top', 'hidden' (no title painted)
   *  or '' (structural). Absent on rows cached before it existed: read as not known. */
  title_layout?: string
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
  /** A slide inserted from another vault (ticket 06): the source vault and slide id only. */
  origin?: { vault_id: string; vault_name: string; slide_id: string; inserted_by?: string } | null
  markdown: string
}

/** Where a slide from another vault came from, as the Inspector shows it (ticket 06). `talkTitle` is
 *  set only on the Mac that inserted it (app data); `badge` only when this Mac knows the source vault. */
export type SlideOriginInfo = {
  vaultId: string
  vaultName: string
  sourceSlideId: string
  insertedAt: string | null
  talkTitle: string | null
  badge: { initial: string; color: string } | null
  /** Who inserted it, as the vault's ledger records it; null when not recorded. */
  insertedBy: string | null
} | null

/** talk.insertFromVault's reply: same vault → crossVault false (use materializeSlideAssets). */
export type InsertFromVaultResult =
  | { ok: true; crossVault: false }
  | { ok: true; crossVault: true; markdown: string; slides: Array<{ id: string; restamped: boolean }>; materialized: number; skipped: number }
  | { ok: false; error: string }

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
export type { ToolsView, ToolsRunRef }
type ToolsShowPayload = { view: ToolsView; sessionId?: string; pathway?: PathwayWindowContext; run?: ToolsRunRef }
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

/** A Run as the Sessions page names it to main: its vault, talk and Run id. */
export type SessionRunRef = { vaultId: string; talkSlug: string; runId: string }

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
  /** Read-time location only; a kept Run lives in this Mac’s app data. */
  kept?: 'app-data'
  /** Read-time vault root; null selects the kept copy. Never persisted into the Run. */
  home?: string | null
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
  /** Planned Run (ADR-0032 point 5): local start time HH:MM, optional head count, pre-work window. */
  startTime?: string
  expectedPeople?: number
  preworkOpens?: string
  preworkCloses?: string
  /** The IANA zone the pre-work times were entered in (ticket 09); absent on older Runs. */
  timeZone?: string
  slideSet?: RunSlideSet
  handoutUrl?: string
  /** When Unpublish last made the Run's pages "not available" (ticket 17); absent once it is published again. */
  unpublishedAt?: string
  startedAt: string
  endedAt: string
  recordingMs: number
  wallClockMs: number
  timerTargetMin: number
  context: string | null
  pathwayId: string | null
  /** segments/gaps/audioMs/partial: see src/shared/run-audio.ts (how much audio the Run holds). */
  audio: ({ r2Key: string; bytes: number; uploaded: boolean } & RunAudioFields) | null
  transcript: null
  trims?: TrimRange[]
  // enter = slide change · reveal = in-slide build step (hidden = fragments still hidden) ·
  // highlight = live highlight change (marks = count; ranges = reconstructed text spans when available) ·
  // pause/resume. All on the recording clock.
  slideTimeIndex: Array<{ event: string; slideId?: string; tMs: number; hidden?: number; marks?: number; ranges?: HighlightRange[]; ink?: InkStroke[]; space?: 'image'; image?: number; clip?: { src: string; atS: number } }>
  /** Instant slides shown during a live session (ticket 07), oldest first. */
  instantSlides?: RunInstantSlide[]
  /** Reactions from phones (reactions ticket 06): taps and undos, times from the Run's start. */
  reactions?: RunReaction[]
  /** Questions asked on phones (reactions ticket 06), oldest first. */
  questions?: RunQuestion[]
  /** Feedback boards (feedback-boards ticket 06): cards, groups, hidden flags, left open or closed. */
  boards?: RunBoard[]
  /** Pre-work answers mirrored from the handout (feedback-boards ticket 09): reads, answers, done marks, questions. */
  prework?: RunPrework
  /** Post-work answers mirrored from the handout (work-files ticket 13), the same shape. */
  postwork?: RunPrework
  /** The work files attached to the Run, one per phase; an attachment may carry `problem: 'zone-mismatch'` (work-files ticket 03). */
  work?: RunWorkSet
  /** Live polls and their answers, as the Run keeps them (H1). */
  polls?: RunPollLike[]
  pollResponses?: RunPollResponseLike[]
}
export type { RunBoard, RunQuestion, RunReaction }

/** What planning sends for each phase: a work file and its window; `null` removes the phase from the Run (work-files ticket 03). */
export type RunWorkPlan = { pre?: { fileId: string; opens?: string; closes?: string } | null; post?: { fileId: string; opens?: string; closes?: string } | null }

/** A Run's read-only share link as a window sees it (never its owner token). */
export type RunResultsShareState = { url: string; include: RunShareInclude; lifetime: RunShareLifetime; expiresAt: number | null; pushedAt: number }
/** Which round of a Run's work: pre-work before the session, post-work after it (ADR-0040). */
export type RunWorkPhase = 'pre' | 'post'
/** A Run's pre-work or post-work as a window sees it (never its owner token); times in ms. */
export type RunPreworkState = { preworkId: string; phase: RunWorkPhase; opensAt: number; closesAt: number; closedAt?: number; purgedAt?: number; withdrawnAt?: number; withdrawAskedAt?: number; /** Responses waiting on the live service, not pulled yet (the timer's count). */ waiting?: number; /** When the answers were last pulled onto the Run. */ pulledAt?: number }
export type RunPreworkPullResult =
  | { ok: true; run: RecordingSession; added: number; changed: boolean }
  | { ok: false; error: string; run?: RecordingSession }
export type { RunPrework }
export type RunBoardPullResult =
  | { ok: true; run: RecordingSession; added: number; late: number; warning?: string }
  | { ok: false; error: string; run?: RecordingSession }

export type RunInstantSlide = {
  id: string
  kind: 'text' | 'link' | 'time' | 'countdown' | 'image'
  shownAt: number
  afterSlideId: string | null
  text?: string
  url?: string
  link?: string
  durationMs?: number
  label?: string
  dataUrl?: string
  width?: number
  height?: number
  added?: { afterSlideNumber: number; afterSlideTitle: string; slideId: string; at: string }
}
export type { EditorDocumentReply, EditorDocumentRequest }

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
export type LayoutDoctorTalk = {
  talk: string
  slug: string
  outlinePath: string
  findings: LayoutDoctorFinding[]
}

// Slide tags (ADR-0037). A target addresses one slide OCCURRENCE in one outline: by its
// stamped {id=…} when it has one (main tags every block carrying that id in that outline —
// normally exactly one), else by its verbatim heading line + 1-based occurrence.
export type TagTarget = { outline: string; id?: string | null; heading?: string; occurrence?: number }
export type TagApplyResult =
  | { ok: true; applied: Array<{ outline: string; tags: string[][] }>; failed: Array<{ outline: string; error: string }> }
  | { ok: false; reason: string }
export type TagCount = { name: string; count: number }

// Compare and merge a conflict copy (several-vaults ticket 10; src/main/conflict-compare.ts).
export type ConflictSlide = { index: number; id: string | null; title: string; text: string; match: number; differs: boolean; diff?: LedgerDiffLine[] }
export type ConflictSide = { label: string; where: string; savedAt: string | null; text: string; slides: ConflictSlide[] }
export type ConflictCompareLoad =
  | { ok: true; token: string; kind: 'copy' | 'git'; title: string; copyName: string | null; service: 'onedrive' | 'dropbox' | 'gdrive' | 'git'; mine: ConflictSide; theirs: ConflictSide; headDiffers: boolean; remaining: number }
  | { ok: false; error: string }
export type ConflictCompareCheck = { stale: false } | { stale: true; which: 'mine' | 'theirs'; label: string; at: string | null }
export type ConflictMergeResult =
  | { ok: true; added: number; summary: string; text: string; trashed: string[]; copyLeft: boolean; setAsideLeft: string | null }
  | { ok: false; error: string; stale?: boolean; setAsideLeft?: string }

const api = {
  app: {
    version: (): Promise<string> => ipcRenderer.invoke('app:version'),
    onCommand: (cb: (command: PaletteCommandHandlerId) => void): (() => void) => {
      const listener = (_event: unknown, command: PaletteCommandHandlerId): void => cb(command)
      ipcRenderer.on('app:command', listener)
      return () => ipcRenderer.removeListener('app:command', listener)
    },
    // A command chosen from the menu bar (generated from the command registry, 0.42): its app
    // command id, run as its palette row runs it.
    onRunCommand: (cb: (commandId: string) => void): (() => void) => {
      const listener = (_event: unknown, commandId: string): void => cb(commandId)
      ipcRenderer.on('app:run-command', listener)
      return () => ipcRenderer.removeListener('app:run-command', listener)
    },
    // Asked from the Settings window's Get started page: open the Guide, show the example vault again, add a vault.
    onEditorAction: (cb: (action: 'open-guide' | 'restore-example' | 'add-vault') => void): (() => void) => {
      const listener = (_event: unknown, action: 'open-guide' | 'restore-example' | 'add-vault'): void => cb(action)
      ipcRenderer.on('settings-window:editor-action', listener)
      return () => ipcRenderer.removeListener('settings-window:editor-action', listener)
    }
  },
  // The shared Settings window (0.42): its own window, opened at a section when one is named.
  settingsWindow: {
    open: (section?: string): Promise<boolean> => ipcRenderer.invoke('settings-window:open', section)
  },
  // The editor keymap's overrides, kept by main in the settings store (keymap/store.ts holds the last ones sent).
  keymap: {
    get: (): Promise<Record<string, string>> => ipcRenderer.invoke('keymap:get'),
    set: (overrides: Record<string, string>): Promise<{ ok: boolean; overrides: Record<string, string> }> => ipcRenderer.invoke('keymap:set', overrides),
    moveLegacy: (overrides: Record<string, string>): Promise<{ outcome: 'consumed' | 'retry'; overrides: Record<string, string> }> => ipcRenderer.invoke('keymap:move-legacy', overrides),
    onChanged: (cb: (overrides: Record<string, string>) => void): (() => void) => {
      const listener = (_event: unknown, overrides: Record<string, string>): void => cb(overrides)
      ipcRenderer.on('keymap:changed', listener)
      return () => ipcRenderer.removeListener('keymap:changed', listener)
    }
  },
  // Ticket 10: the compare screen. load reads both versions (writes nothing); check tells whether
  // either file changed since; merge writes once through the normal save path; cancel writes nothing.
  conflict: {
    load: (outlinePath: string): Promise<ConflictCompareLoad> => ipcRenderer.invoke('conflict:load', outlinePath),
    check: (token: string): Promise<ConflictCompareCheck> => ipcRenderer.invoke('conflict:check', token),
    merge: (token: string, pick: { keep: 'mine' | 'theirs'; pull: number[] }): Promise<ConflictMergeResult> => ipcRenderer.invoke('conflict:merge', token, pick),
    cancel: (token: string): Promise<boolean> => ipcRenderer.invoke('conflict:cancel', token),
    /** Pictures of one compared version, keyed by slide id (compiled on the uncached 'variant' lane). */
    pictures: (token: string, side: 'mine' | 'theirs'): Promise<Record<string, string>> => ipcRenderer.invoke('conflict:pictures', token, side)
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
  layoutDoctor: {
    scan: (): Promise<LayoutDoctorTalk[]> => ipcRenderer.invoke('layout:doctor')
  },
  vault: {
    getRoot: (): Promise<string | null> => ipcRenderer.invoke('vault:get-root'),
    // Test-only (TW_E2E=1); the app changes the root with chooseRoot.
    setRoot: (path: string): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('vault:set-root', path),
    chooseRoot: (): Promise<string | null> => ipcRenderer.invoke('vault:choose-root'),
    // Open example vault (onboarding ticket 06): no argument; main writes to its fixed path.
    openExample: (): Promise<ExampleVaultResult> => ipcRenderer.invoke('vault:open-example'),
    // Remove the example vault and bring it back (onboarding ticket 12). No path crosses: the preview's
    // token is all Remove gives back; main checks the window and the folder itself.
    exampleState: (): Promise<ExampleRemovalState> => ipcRenderer.invoke('example:state'),
    exampleRemovalPreview: (): Promise<ExampleRemovalPreview> => ipcRenderer.invoke('example:removal-preview'),
    removeExample: (token: string): Promise<ExampleRemoveResult> => ipcRenderer.invoke('example:remove', token),
    restoreExample: (): Promise<ExampleRestoreResult> => ipcRenderer.invoke('example:restore'),
    onExampleChanged: (cb: (event: { removed: boolean; moved: boolean }) => void): (() => void) => {
      const listener = (_e: unknown, event: { removed: boolean; moved: boolean }): void => cb(event)
      ipcRenderer.on('example:changed', listener)
      return () => ipcRenderer.removeListener('example:changed', listener)
    },
    // Every vault, open or closed, with its name, badge colour and initial, and service label.
    list: (): Promise<VaultView[]> => ipcRenderer.invoke('vault:list'),
    // ⋯ › Reveal in Finder: main resolves the folder from the vault id (an unknown id is refused).
    // "Check again": look at every open vault's folder now (true when a vault came back or went away).
    recheck: (): Promise<boolean> => ipcRenderer.invoke('vault:recheck'),
    reveal: (vaultId: string): Promise<{ ok: boolean; reason?: 'unknown-vault' | 'unavailable' }> => ipcRenderer.invoke('vault:reveal', vaultId),
    // The unavailable section's action when its cloud service is not signed in: open that service's app.
    openService: (vaultId: string): Promise<boolean> => ipcRenderer.invoke('vault:open-service', vaultId),
    // Add a vault. Without a path the folder picker opens (null = cancelled); a refusal (a folder inside
    // another vault, or already added) comes back as { ok: false, message }.
    add: (path?: string): Promise<VaultActionResult | null> =>
      path === undefined ? ipcRenderer.invoke('vault:add') : ipcRenderer.invoke('vault:add', path),
    // Add vault… (ticket 04): pick a folder (path only under TW_E2E). Answers what it is — a new vault
    // or one set up elsewhere (join) — or a refusal naming the vault it clashes with. Writes nothing.
    chooseFolder: (path?: string): Promise<ChosenVaultFolder | null> =>
      path === undefined ? ipcRenderer.invoke('vault:choose-folder') : ipcRenderer.invoke('vault:choose-folder', path),
    // Create vault: writes the vault file once, adds the vault, stores the personal settings.
    create: (token: string, shared: VaultSharedPatch, personal: VaultPersonalFields): Promise<VaultActionResult> =>
      ipcRenderer.invoke('vault:create', token, shared, personal),
    // Open vault (a folder already a vault): adds it with the file's id; stores only personal settings.
    join: (token: string, personal: VaultPersonalFields): Promise<VaultActionResult> => ipcRenderer.invoke('vault:join', token, personal),
    // Edit this vault.
    getSettings: (vaultId: string): Promise<VaultSettingsResult> => ipcRenderer.invoke('vault:get-settings', vaultId),
    // shared null leaves the vault file alone (read-only shared group).
    saveSettings: (vaultId: string, shared: VaultSharedPatch | null, personal: VaultPersonalFields): Promise<VaultActionResult> =>
      ipcRenderer.invoke('vault:save-settings', vaultId, shared, personal),
    // A logo inside the vault (by vault id, or the token of a folder being added); path only under TW_E2E.
    chooseLogo: (target: { vaultId: string } | { token: string }, path?: string): Promise<ChosenVaultLogo | null> =>
      path === undefined ? ipcRenderer.invoke('vault:choose-logo', target) : ipcRenderer.invoke('vault:choose-logo', target, path),
    // What the talk's vault gives new talks, and where each value comes from (Inspector).
    talkDefaults: (outlinePath: string): Promise<TalkVaultDefaults> => ipcRenderer.invoke('vault:talk-defaults', outlinePath),
    // Open or close a vault in this app's list. Nothing in the folder changes. The last open vault stays open.
    setOpen: (vaultId: string, open: boolean): Promise<VaultActionResult> => ipcRenderer.invoke('vault:set-open', vaultId, open),
    onVaultsChanged: (cb: () => void): (() => void) => {
      const listener = (): void => cb()
      ipcRenderer.on('vault:vaults-changed', listener)
      return () => ipcRenderer.removeListener('vault:vaults-changed', listener)
    },
    // One vault's talks (vaultId); without it, the first open vault. Batches name their vault.
    listTalks: (vaultId?: string): Promise<TalkInfo[]> =>
      vaultId === undefined ? ipcRenderer.invoke('vault:list-talks') : ipcRenderer.invoke('vault:list-talks', vaultId),
    onTalksBatch: (cb: (payload: { vaultId: string; batch: TalkInfo[]; reset: boolean; done: boolean }) => void): (() => void) => {
      const listener = (_event: unknown, payload: { vaultId: string; batch: TalkInfo[]; reset: boolean; done: boolean }): void => cb(payload)
      ipcRenderer.on('vault:talks-batch', listener)
      return () => ipcRenderer.removeListener('vault:talks-batch', listener)
    },
    // Ticket 09: a scan of the open talk's folder recounted its conflict copies.
    onTalkConflicts: (cb: (payload: { vaultId: string; outlinePath: string; conflicts: number }) => void): (() => void) => {
      const listener = (_event: unknown, payload: { vaultId: string; outlinePath: string; conflicts: number }): void => cb(payload)
      ipcRenderer.on('vault:talk-conflicts', listener)
      return () => ipcRenderer.removeListener('vault:talk-conflicts', listener)
    },
    // Ticket 09: the talk's Activity lines, newest first (identical conflict copies removed, …).
    talkActivity: (outlinePath: string): Promise<TalkActivityEntry[]> => ipcRenderer.invoke('talk:activity', outlinePath),
    onTalkActivityChanged: (cb: (payload: { vaultId: string; slug: string }) => void): (() => void) => {
      const listener = (_event: unknown, payload: { vaultId: string; slug: string }): void => cb(payload)
      ipcRenderer.on('talk:activity-changed', listener)
      return () => ipcRenderer.removeListener('talk:activity-changed', listener)
    },
    talkMeta: (): Promise<TalkMeta> => ipcRenderer.invoke('vault:talk-meta'),
    // Fires when talk facts changed and windows should re-read them: search-index counts landed
    // (the background warmer), pathways changed, or a delivery session was saved (T29 — the
    // status-bar dates refresh without a reload). Returns an unsubscribe fn.
    onTalkMetaUpdated: (cb: () => void): (() => void) => {
      const listener = (): void => cb()
      ipcRenderer.on('vault:talk-meta-updated', listener)
      return () => ipcRenderer.removeListener('vault:talk-meta-updated', listener)
    },
    createTalk: (opts: { title: string; slug: string; topicFolder?: string; vaultId?: string }): Promise<TalkInfo | null> =>
      ipcRenderer.invoke('vault:create-talk', opts),
    // Clone a talk (copy its folder, retitle, strip the published handout link). Lands as a sibling.
    cloneTalk: (outlinePath: string, newTitle: string): Promise<TalkInfo | null> =>
      ipcRenderer.invoke('vault:clone-talk', outlinePath, newTitle),
    // Rename a talk in place (retitle frontmatter; new slug ⇒ folder + slug files renamed).
    // Errors: 'open-elsewhere' (another window holds it), 'target-exists' (slug folder taken).
    renameTalk: (outlinePath: string, newTitle: string): Promise<TalkInfo | { error: string } | null> =>
      ipcRenderer.invoke('vault:rename-talk', outlinePath, newTitle),
    // Folder management — folders are real vault subfolders (paths are vault-relative, '' = root).
    // The folder calls take an optional vault id (default: the first open vault).
    createFolder: (name: string, parentRel?: string, vaultId?: string): Promise<string | null> =>
      ipcRenderer.invoke('vault:create-folder', name, parentRel, vaultId),
    renameFolder: (folderRel: string, newName: string, vaultId?: string): Promise<string | null> =>
      ipcRenderer.invoke('vault:rename-folder', folderRel, newName, vaultId),
    moveTalk: (outlinePath: string, destFolderRel: string): Promise<TalkInfo | null> =>
      ipcRenderer.invoke('vault:move-talk', outlinePath, destFolderRel),
    // Category folders (vault-rel paths), INCLUDING empty ones, so a just-created folder is visible.
    listFolders: (vaultId?: string): Promise<string[]> => ipcRenderer.invoke('vault:list-folders', vaultId),
    // Delete → OS Trash (recoverable), for talks/folders created by accident.
    deleteTalk: (outlinePath: string): Promise<boolean> => ipcRenderer.invoke('vault:delete-talk', outlinePath),
    deleteFolder: (folderRel: string, vaultId?: string): Promise<boolean> => ipcRenderer.invoke('vault:delete-folder', folderRel, vaultId)
  },
  settings: {
    // Configured folders the app reads from. A null override = the auto-detected default is in use.
    getPaths: (): Promise<{
      vaultRoot: string | null
      archiveRoot: string | null
      archiveDefault: string
      archiveAvailable: boolean
    }> => ipcRenderer.invoke('preferences:get-paths'),
    chooseArchive: (): Promise<string | null> => ipcRenderer.invoke('preferences:choose-archive'),
    clearArchive: (): Promise<string> => ipcRenderer.invoke('preferences:clear-archive'),
    // Presentation backup (ADR-0028 sibling feature): auto-write each Talk's full presenter HTML to a
    // folder inside OneDrive/Dropbox on a timer, so a forgotten laptop never blocks presenting.
    getBackup: (): Promise<BackupSettings> => ipcRenderer.invoke('preferences:get-backup'),
    setBackup: (patch: { enabled?: boolean; intervalMin?: number }): Promise<BackupSettings> =>
      ipcRenderer.invoke('preferences:set-backup', patch),
    chooseBackupFolder: (): Promise<BackupSettings> => ipcRenderer.invoke('preferences:choose-backup-folder'),
    clearBackupFolder: (): Promise<BackupSettings> => ipcRenderer.invoke('preferences:clear-backup-folder'),
    // Presenter clock amber/dark-amber thresholds (Task 3): global default; a deck's own
    // frontmatter `warn-at:`/`urgent-at:` overrides these per-talk.
    getTimer: (): Promise<TimerSettings> => ipcRenderer.invoke('preferences:get-timer'),
    setTimer: (patch: { warnAtMinutes?: number; urgentAtMinutes?: number }): Promise<TimerSettings> =>
      ipcRenderer.invoke('preferences:set-timer', patch),
    // Local transcription paths (optional; spec D16). Non-secret; unset by default. An empty ffmpeg
    // uses the one that ships with the app.
    getTranscription: (): Promise<TranscriptionSettings> => ipcRenderer.invoke('preferences:get-transcription'),
    // The paths are changed only in the Settings window (src/preload/settings.ts; main refuses any other sender).
    // The Transcription row: whether it can run, or the one missing thing (never a path).
    transcriptionStatus: (): Promise<TranscriptionRow> => ipcRenderer.invoke('transcription:status'),
    // "Copy instructions for your agent": the prompt, with this computer's set-up and user-data folders.
    transcriptionAgentPrompt: (): Promise<string> => ipcRenderer.invoke('transcription:agent-prompt'),
    // Opens the set-up folder that ships with the app (SETUP.md, the script, requirements.txt).
    openTranscriptionSetupFolder: (): Promise<boolean> => ipcRenderer.invoke('transcription:open-setup-folder'),
    // Presenter identity and deck defaults (Ticket 9b): one map of metadata-registry key → the
    // value pre-filled into new talks. A blank value clears that default; nothing is ever
    // overwritten in an existing outline without an explicit click.
    getMetadataDefaults: (): Promise<Record<string, string>> =>
      ipcRenderer.invoke('preferences:get-metadata-defaults'),
    setMetadataDefaults: (patch: Record<string, string>): Promise<Record<string, string>> =>
      ipcRenderer.invoke('preferences:set-metadata-defaults', patch),
    // Settings changelog (Gate-5): every settings change recorded old → new in a per-machine
    // userData JSON log; Settings → Changes lists it with a per-entry Reset. Never secret values.
    getChangelog: (): Promise<SettingsChangeEntry[]> => ipcRenderer.invoke('preferences:changelog-get'),
    logChange: (entry: { key: string; label: string; from: string; to: string }): Promise<SettingsChangeEntry[]> =>
      ipcRenderer.invoke('preferences:changelog-log', entry),
    // Action bar (ADR-0025): one app-wide visibility flag; `items` is the RAW stored button list
    // (left untyped here — the renderer parses it tolerantly, and the configure sheet that will
    // write it is a later parcel). The broadcast lets one window's toggle redraw every open window.
    getActionBar: (): Promise<{ visible: boolean; items: unknown }> =>
      ipcRenderer.invoke('preferences:get-action-bar'),
    setActionBarVisible: (visible: boolean): Promise<boolean> =>
      ipcRenderer.invoke('preferences:set-action-bar-visible', visible),
    getEditorViewMode: (): Promise<'plain' | 'markdown'> =>
      ipcRenderer.invoke('preferences:get-editor-view-mode'),
    setEditorViewMode: (mode: 'plain' | 'markdown'): Promise<'plain' | 'markdown'> =>
      ipcRenderer.invoke('preferences:set-editor-view-mode', mode),
    onEditorViewModeChanged: (cb: (mode: 'plain' | 'markdown') => void): (() => void) => {
      const listener = (_e: unknown, mode: 'plain' | 'markdown'): void => cb(mode)
      ipcRenderer.on('editor-view-mode:changed', listener)
      return () => ipcRenderer.removeListener('editor-view-mode:changed', listener)
    },
    getPlainLook: (): Promise<{ font: 'sans' | 'serif'; size: number }> =>
      ipcRenderer.invoke('preferences:get-plain-look'),
    setPlainLook: (change: { font?: 'sans' | 'serif'; size?: number }): Promise<{ font: 'sans' | 'serif'; size: number }> =>
      ipcRenderer.invoke('preferences:set-plain-look', change),
    onPlainLookChanged: (cb: (look: { font: 'sans' | 'serif'; size: number }) => void): (() => void) => {
      const listener = (_e: unknown, look: { font: 'sans' | 'serif'; size: number }): void => cb(look)
      ipcRenderer.on('plain-look:changed', listener)
      return () => ipcRenderer.removeListener('plain-look:changed', listener)
    },
    onActionBarChanged: (cb: (state: { visible: boolean; items: unknown }) => void): (() => void) => {
      const listener = (_e: unknown, state: { visible: boolean; items: unknown }): void => cb(state)
      ipcRenderer.on('action-bar:changed', listener)
      return () => ipcRenderer.removeListener('action-bar:changed', listener)
    },
    // The status-bar place chip (onboarding ticket 02): one app-wide flag, broadcast to every window.
    getPlaceChip: (): Promise<{ visible: boolean }> =>
      ipcRenderer.invoke('preferences:get-place-chip'),
    setPlaceChipVisible: (visible: boolean): Promise<boolean> =>
      ipcRenderer.invoke('preferences:set-place-chip-visible', visible),
    onPlaceChipChanged: (cb: (state: { visible: boolean }) => void): (() => void) => {
      const listener = (_e: unknown, state: { visible: boolean }): void => cb(state)
      ipcRenderer.on('place-chip:changed', listener)
      return () => ipcRenderer.removeListener('place-chip:changed', listener)
    },
    // The Guide button in the sidebar (onboarding ticket 07): one app-wide flag, broadcast to every window.
    getGuideButton: (): Promise<{ visible: boolean }> =>
      ipcRenderer.invoke('preferences:get-guide-button'),
    setGuideButtonVisible: (visible: boolean): Promise<boolean> =>
      ipcRenderer.invoke('preferences:set-guide-button-visible', visible),
    onGuideButtonChanged: (cb: (state: { visible: boolean }) => void): (() => void) => {
      const listener = (_e: unknown, state: { visible: boolean }): void => cb(state)
      ipcRenderer.on('guide-button:changed', listener)
      return () => ipcRenderer.removeListener('guide-button:changed', listener)
    }
  },
  // The Guide's progress (onboarding ticket 07): app config, outside every vault.
  guide: {
    getProgress: (): Promise<{ exampleTalkOpened: boolean }> => ipcRenderer.invoke('guide:get-progress'),
    noteExampleTalkOpened: (): Promise<{ exampleTalkOpened: boolean }> => ipcRenderer.invoke('guide:note-example-talk-opened'),
    onProgressChanged: (cb: (progress: { exampleTalkOpened: boolean }) => void): (() => void) => {
      const listener = (_e: unknown, progress: { exampleTalkOpened: boolean }): void => cb(progress)
      ipcRenderer.on('guide:progress-changed', listener)
      return () => ipcRenderer.removeListener('guide:progress-changed', listener)
    },
    // Chapter progress (ticket 08). `commandRan` is the one report every route makes (the renderer's
    // commands/command-ran.ts calls it); `outlinePath` is the talk the window is in, for decision 12.
    getLearn: (): Promise<unknown> => ipcRenderer.invoke('guide:get-learn'),
    // The presenter's "All chapters" link: main brings this window forward and says so; no payload.
    onShowChapterList: (cb: () => void): (() => void) => {
      const listener = (): void => cb()
      ipcRenderer.on('guide:show-chapter-list', listener)
      return () => ipcRenderer.removeListener('guide:show-chapter-list', listener)
    },
    commandRan: (id: string, outlinePath?: string): Promise<{ id: string | null; ticked: boolean }> => ipcRenderer.invoke('guide:command-ran', id, outlinePath),
    chapterOpened: (task: string): Promise<boolean> => ipcRenderer.invoke('guide:chapter-opened', task),
    topicRead: (topic: string): Promise<boolean> => ipcRenderer.invoke('guide:topic-read', topic),
    // What it connects to (ticket 11): read-only probes of this Mac, run on ask; `openLink` names a link main holds.
    connections: (): Promise<ConnectionRow[]> => ipcRenderer.invoke('guide:connections'),
    openLink: (id: 'slidewell-download' | 'online-content-report'): Promise<boolean> => ipcRenderer.invoke('guide:open-link', id),
    onLearnChanged: (cb: (record: unknown) => void): (() => void) => {
      const listener = (_e: unknown, record: unknown): void => cb(record)
      ipcRenderer.on('guide:learn-changed', listener)
      return () => ipcRenderer.removeListener('guide:learn-changed', listener)
    }
  },
  backup: {
    // Back up every enrolled talk now (ADR-0024: the enrolled set, never the vault).
    runNow: (): Promise<BackupRun> => ipcRenderer.invoke('backup:run-now'),
    setEnrolled: (slug: string, enrolled: boolean): Promise<BackupSettings> =>
      ipcRenderer.invoke('backup:set-enrolled', slug, enrolled),
    // Subscribe to backup-run status pushes; returns an unsubscribe fn.
    onStatus: (cb: (run: BackupRun) => void): (() => void) => {
      const listener = (_e: unknown, run: BackupRun): void => cb(run)
      ipcRenderer.on('backup:status', listener)
      return () => ipcRenderer.removeListener('backup:status', listener)
    }
  },
  talk: {
    // `forEditor`: only the editor's own load (and Reload) — its text becomes the external-change
    // guard's baseline for the file (shared-talk ticket 01).
    readOutline: (outlinePath: string, opts?: { forEditor?: boolean }): Promise<string | null> =>
      ipcRenderer.invoke('talk:read-outline', outlinePath, opts),
    // External-change guard: the file's text + version on disk now (Reload), and accepting the version
    // the person saw (Keep mine / Reload); a newer change refuses with it.
    outlineDiskVersion: (outlinePath: string): Promise<{ text: string; hash: string } | null> =>
      ipcRenderer.invoke('talk:outline-disk-version', outlinePath),
    // `keepPending`: a save follows (Keep mine, Save it again, Save again) — the difference stays until it lands.
    acceptOutlineDiskVersion: (outlinePath: string, hash: string, opts?: { keepPending?: boolean }): Promise<OutlineDiskAccept> =>
      ipcRenderer.invoke('talk:outline-accept-disk', outlinePath, hash, opts),
    // The recovery copy a refused save kept for this talk (userData/recovery), and dropping it.
    outlineRecovery: (outlinePath: string): Promise<OutlineRecoveryCopy | null> =>
      ipcRenderer.invoke('talk:outline-recovery', outlinePath),
    discardOutlineRecovery: (outlinePath: string): Promise<boolean> =>
      ipcRenderer.invoke('talk:outline-recovery-discard', outlinePath),
    // The talk was removed on disk and the person chose Discard: main stops guarding it.
    discardRemovedOutline: (outlinePath: string): Promise<boolean> =>
      ipcRenderer.invoke('talk:outline-discard', outlinePath),
    // Main's push: the window is closing (or ⌘Q) while its talk differs from the disk — show the sheet.
    onCloseRequested: (cb: (request: { quit: boolean }) => void): (() => void) => {
      const listener = (_e: unknown, request: { quit: boolean }): void => cb(request)
      ipcRenderer.on('outline:close-requested', listener)
      return () => ipcRenderer.removeListener('outline:close-requested', listener)
    },
    // The close request arrived (the sheet is up): main's 5-second fallback close is off.
    ackCloseRequest: (): Promise<boolean> => ipcRenderer.invoke('window:close-request-ack'),
    // The sheet's choice completed: close (and quit, when ⌘Q asked).
    confirmClose: (opts: { quit: boolean }): Promise<boolean> =>
      ipcRenderer.invoke('window:confirm-close', opts),
    // Main's push: the open talk's outline changed on disk (change), or no longer differs (null).
    onOutlineChangedOnDisk: (cb: (event: { outlinePath: string; change: OutlineDiskChange | null }) => void): (() => void) => {
      const listener = (_e: unknown, event: { outlinePath: string; change: OutlineDiskChange | null }): void => cb(event)
      ipcRenderer.on('outline:changed-on-disk', listener)
      return () => ipcRenderer.removeListener('outline:changed-on-disk', listener)
    },
    // Insert section (talk search 07): the section headed at `at` in the talk at `sourceOutlinePath`,
    // read as the talk stands now (its open buffer, else the file). Read-only.
    extractSection: (
      sourceOutlinePath: string,
      at: { line: number; heading: string }
    ): Promise<{ ok: true; markdown: string; level: number; slides: number; line: number } | { ok: false; error: string }> =>
      ipcRenderer.invoke('talk:extract-section', sourceOutlinePath, at),
    // Truthy on success (callers only truth-test it); `collisions` lists slide ids saved into a
    // second talk while another head exists (Slide Ledger, ADR-0032). False on write failure.
    // `{ ok: false, refused: 'empty-over-nonempty' }` when the data-loss backstop declined to
    // overwrite a non-empty outline with a structurally-empty payload (main process guard).
    // `content` (heading-is-slide, Task 8) is present when save-time id stamping changed the
    // bytes on disk: it is the STAMPED text the main process actually wrote. The caller should
    // adopt it into its buffer (Editor.tsx does, via minimalChange) so the next save sends
    // already-stamped text — otherwise the main process falls back to id reuse by heading.
    // `{ ok: false, refused: 'outside-vault', error }`: the outline is not in the current vault (a window
    // still holding a talk after the vault root changed) — nothing was written; `error` says so.
    // `{ ok: false, refused: 'changed-on-disk', change }`: the file changed on disk since the editor read
    // it (external-change guard) — nothing was written until the person picks Reload or Keep mine.
    writeOutline: (
      outlinePath: string,
      content: string
    ): Promise<{ ok: true; collisions: string[]; content?: string } | { ok: false; refused: 'empty-over-nonempty' } | { ok: false; refused: 'outside-vault'; error: string } | OutlineChangedOnDiskRefusal | false> =>
      ipcRenderer.invoke('talk:write-outline', outlinePath, content),
    compile: (outlinePath: string, content: string): Promise<ProjectionRow[] | null> =>
      ipcRenderer.invoke('talk:compile', outlinePath, content),
    selectedThumbnail: (
      outlinePath: string,
      content: string,
      slideId: string
    ): Promise<{ slideId: string; url: string } | null> =>
      ipcRenderer.invoke('talk:selected-thumbnail', outlinePath, content, slideId),
    // ADR-0032 §6: the CURRENT slide (by {id}) rendered from `outline` with `layout` (and option
    // choices) applied — a picture for the picker / Inspector. Writes nothing; cached by content.
    // The answer says what happened: a picture, the layout cannot take the slide (grey), a bad
    // request, a failed render (retry), or superseded by a newer request with the same `requestKey`.
    layoutVariantThumbnail: (
      outlinePath: string,
      outline: string,
      slide: string | { headingLine: number },
      layout: string,
      options?: Array<{ group: string; token: string }>,
      requestKey?: string
    ): Promise<VariantThumbnail> =>
      ipcRenderer.invoke('layout:variant-thumbnail', outlinePath, outline, slide, layout, options, requestKey),
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
    // Publish the handout to the user's Cloudflare Pages site (Settings → Cloudflare). Returns the
    // live URL; `updatedOutline` reports the handout_url stamp main wrote through the one writer (the
    // renderer does not adopt it: it stamps its own buffer as it stands, WorkspaceLayout).
    publishHandout: (
      outlinePath: string,
      content: string
    ): Promise<{
      success: boolean
      url?: string
      display?: string
      error?: string
      /** What lies behind `error` (e.g. which bundled file is missing); shown on request, never as the message. */
      details?: string
      updatedOutline?: string
      warning?: string
    } & PublishReplyExtras> => ipcRenderer.invoke('talk:publish-handout', outlinePath, content),
    // `lane` separates independent requesters inside ONE window: the editor strip and the Slide
    // Browser's background per-talk render must not supersede each other (2026-09-15).
    thumbnails: (outlinePath: string, content: string, opts?: { lane?: string; requestId?: string }): Promise<Record<string, string> | null> =>
      ipcRenderer.invoke('talk:thumbnails', outlinePath, content, opts),
    /** Pictures for one correlated request, cached first and then as each slide finishes. */
    onThumbnailProgress: (cb: (payload: { outlinePath: string; requestId: string; thumbnails: Record<string, string> }) => void): (() => void) => {
      const listener = (_event: unknown, payload: { outlinePath: string; requestId: string; thumbnails: Record<string, string> }): void => cb(payload)
      ipcRenderer.on('talk:thumbnail-progress', listener)
      return () => ipcRenderer.removeListener('talk:thumbnail-progress', listener)
    },
    // The text read from the pictures each slide block names, one string per block ('' when none): the grid's and the outline's search.
    slidePictureText: (outlinePath: string, blocks: string[]): Promise<string[]> => ipcRenderer.invoke('talk:slide-picture-text', outlinePath, blocks),
    slidePictureGeneration: (): Promise<number> => ipcRenderer.invoke('talk:slide-picture-generation'),
    // Manual rebuild: wipe this talk's thumbnail cache so the next compile re-renders from scratch.
    // outlinePath names the talk's vault, so only that vault's pictures go (without it, every vault's folder for the slug).
    clearThumbCache: (slug: string, outlinePath?: string): Promise<boolean> => ipcRenderer.invoke('talk:clear-thumb-cache', slug, outlinePath),
    // Convert a talk's relative PNG/JPG images to WebP (smaller → faster previews + handouts).
    // Returns the rewritten outline; originals go to the OS Trash (recoverable).
    // `failed`: could not be converted (missing, outside the vault, a link). `leftAlone`: pictures that
    // belong to another talk or the shared pool. `clashes`: a .webp of that name already exists.
    optimizeImages: (
      outlinePath: string,
      content: string
    ): Promise<{ success: boolean; converted?: number; savedBytes?: number; failed?: number; leftAlone?: number; clashes?: number; newContent?: string; error?: string }> =>
      ipcRenderer.invoke('talk:optimize-images', outlinePath, content),
    // Cross-talk reuse: materialize a slide's relative images into the vault pool (img-<hash>) so they
    // resolve in the destination talk. Returns the rewritten markdown.
    materializeSlideAssets: (
      sourceOutlinePath: string,
      markdown: string
    ): Promise<{ success: boolean; markdown: string; materialized?: number; skipped?: number; error?: string }> =>
      ipcRenderer.invoke('talk:materialize-slide-assets', sourceOutlinePath, markdown),
    // Slides across vaults (ticket 06): a slide from ANOTHER vault is copied into the target talk's
    // vault (media, a re-stamped id on collision, provenance). `liveIds`: ids in the talk's live text.
    insertFromVault: (sourceOutlinePath: string, targetOutlinePath: string, markdown: string, liveIds: string[]): Promise<InsertFromVaultResult> =>
      ipcRenderer.invoke('talk:insert-from-vault', sourceOutlinePath, targetOutlinePath, markdown, liveIds),
    // Cross-talk reuse for TEXT-PASTED slides (no source path): resolve relative assets/<name> refs
    // by filename across the vault, copy into the pool (img-<hash>), rewrite. Returns rewritten markdown.
    materializePastedAssets: (
      markdown: string
    ): Promise<{ success: boolean; markdown: string; materialized?: number; skipped?: number; error?: string }> =>
      ipcRenderer.invoke('talk:materialize-pasted-assets', markdown),
    // OCR-index the vault's images (native macOS Vision) so search matches text INSIDE images.
    ocrIndex: (): Promise<{ success: boolean; total?: number; read?: number; known?: number; failed?: number; skipped?: number; cached?: number; added?: number; error?: string }> =>
      ipcRenderer.invoke('talk:ocr-index')
  },
  // Slide Ledger (ADR-0032): per-slide identity, history, and cross-talk usage.
  ledger: {
    // Every talk whose outline currently contains the slide id.
    whereUsed: (id: string): Promise<Array<{ talk: string; outline: string }>> =>
      ipcRenderer.invoke('ledger:where-used', id),
    // Version history for a slide id (head first).
    versions: (id: string): Promise<LedgerVersion[]> => ipcRenderer.invoke('ledger:versions', id),
    // Where a slide in this talk came from when it was inserted from another vault; null otherwise.
    origin: (outlinePath: string, slideId: string): Promise<SlideOriginInfo> => ipcRenderer.invoke('ledger:origin', outlinePath, slideId),
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
    // Cloudflare Pages publishing config (Settings → Cloudflare). getConfig NEVER returns the token —
    // only hasToken. The token is saved and removed through `cloudflare` below.
    getConfig: (): Promise<{
      accountId: string
      project: string
      baseUrl: string
      workerBaseUrl: string
      useShortIds: boolean
      // Share link domain (ticket 07): the bare host, e.g. "drafts.handouts.fyi" — '' when unset,
      // in which case a colleague's share link falls back to the live Worker's own origin.
      shareDomain: string
      hasToken: boolean
    }> => ipcRenderer.invoke('publish:get-config'),
    setConfig: (cfg: {
      accountId: string
      project: string
      baseUrl: string
      workerBaseUrl: string
      useShortIds: boolean
      shareDomain: string
      // Invalid shareDomain (not a bare hostname): refused whole, with a plain-language error, and
      // never saved — see isValidShareDomain in src/shared/shared-talk.ts.
    }): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('publish:set-config', cfg),
  },
  // Settings → Cloudflare (spec docs/plans/cloudflare-setup-in-app): the one token, the account it
  // reaches and the Publishing handouts row. The token only ever travels INTO the main process
  // (saveToken); every reply and every push is a CloudflareStatus, which holds states, an account's
  // name and id and fixed sentences, never the token. A call resolves when its work is done, but
  // nothing in the window waits on it: `onStatus` delivers each change as it happens.
  // Update notices (ADR-0041, src/main/update-notices.ts). The windows send no address: Download opens the
  // link the last validated feed gave for this computer, and the notes link is built from a version.
  updates: {
    get: (): Promise<UpdateSnapshot> => ipcRenderer.invoke('updates:get'),
    /** Check for Updates…: always checks (a Store copy and a development run answer without a request). */
    check: (): Promise<UpdateSnapshot> => ipcRenderer.invoke('updates:check'),
    skip: (version: string): Promise<UpdateSnapshot> => ipcRenderer.invoke('updates:skip', version),
    stopSkipping: (): Promise<UpdateSnapshot> => ipcRenderer.invoke('updates:stop-skipping'),
    notNow: (): Promise<UpdateSnapshot> => ipcRenderer.invoke('updates:not-now'),
    /** The setting `updates.checkForNewVersions`. */
    setEnabled: (on: boolean): Promise<UpdateSnapshot> => ipcRenderer.invoke('updates:set-enabled', on),
    download: (): Promise<boolean> => ipcRenderer.invoke('updates:download'),
    openNotes: (version: string): Promise<boolean> => ipcRenderer.invoke('updates:open-notes', version),
    openStore: (): Promise<boolean> => ipcRenderer.invoke('updates:open-store'),
    /** The notes shipped for the running version, or null. */
    whatsNew: (): Promise<{ version: string; from: string | null; items: WhatsNewItem[] } | null> => ipcRenderer.invoke('updates:whats-new'),
    dismissWhatsNew: (): Promise<UpdateSnapshot> => ipcRenderer.invoke('updates:dismiss-whats-new'),
    onChange: (cb: (snapshot: UpdateSnapshot) => void): (() => void) => {
      const listener = (_e: unknown, snapshot: UpdateSnapshot): void => cb(snapshot)
      ipcRenderer.on('updates:changed', listener)
      return () => ipcRenderer.removeListener('updates:changed', listener)
    },
    /** The answer of a Check for Updates… that waited for a talk to end. */
    onAnswer: (cb: (snapshot: UpdateSnapshot) => void): (() => void) => {
      const listener = (_e: unknown, snapshot: UpdateSnapshot): void => cb(snapshot)
      ipcRenderer.on('updates:answered', listener)
      return () => ipcRenderer.removeListener('updates:answered', listener)
    }
  },
  cloudflare: {
    status: (): Promise<CloudflareStatus> => ipcRenderer.invoke('cloudflare:status'),
    /** `opened`: Settings → Cloudflare was opened (the main process checks at most once a minute). */
    check: (reason: 'asked' | 'opened' = 'asked'): Promise<CloudflareReply> => ipcRenderer.invoke('cloudflare:check', reason),
    /** Save or replace the token; the check follows by itself. */
    saveToken: (token: string): Promise<CloudflareReply> => ipcRenderer.invoke('cloudflare:save-token', token),
    chooseAccount: (accountId: string): Promise<CloudflareReply> => ipcRenderer.invoke('cloudflare:choose-account', accountId),
    /** Make the Pages site the Publishing handouts row names. Settings window only: main refuses an editor window (the type is shared with Settings → Cloudflare). */
    createSite: (): Promise<CloudflareReply> => ipcRenderer.invoke('cloudflare:create-site'),
    /** Remove the token. Nothing at Cloudflare is touched. */
    disconnect: (): Promise<CloudflareReply> => ipcRenderer.invoke('cloudflare:disconnect'),
    /**
     * The Share-link domain row's button, "Use share.<handout domain>": the main process saves the
     * address the row suggests (it takes none from the window) and, with the live service set up and
     * the permission there, attaches it now.
     */
    useShareDomain: (): Promise<CloudflareReply> => ipcRenderer.invoke('cloudflare:use-share-domain'),
    onStatus: (listener: (status: CloudflareStatus) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, status: CloudflareStatus): void => listener(status)
      ipcRenderer.on('cloudflare:status', handler)
      return () => { ipcRenderer.removeListener('cloudflare:status', handler) }
    },
    /**
     * "Open Settings" from a publish sheet or notice: brings the editor window forward with
     * Settings → Cloudflare showing. Works from any window (History has no Settings of its own).
     * False when there is no editor window to show it in.
     */
    openSettings: (): Promise<boolean> => ipcRenderer.invoke('cloudflare:open-settings'),
    /** The editor window: asked to show Settings → Cloudflare. */
    onShowSettings: (listener: () => void): (() => void) => {
      const handler = (): void => listener()
      ipcRenderer.on('cloudflare:show-settings', handler)
      return () => { ipcRenderer.removeListener('cloudflare:show-settings', handler) }
    }
  },
  // Going live and sharing (spec D9, ticket 05): its Settings row, the set-up, and what the person is
  // told while the live service is set up or updated. A row holds states, the service's address and
  // build, and fixed sentences; never a key.
  liveService: {
    status: (): Promise<GoingLiveRow> => ipcRenderer.invoke('live-service:status'),
    /** "Set up going live", Try again or "Set up going live now". Resolves when the set-up has finished. Settings window only: main refuses an editor window (the type is shared with Settings → Cloudflare). */
    setUp: (): Promise<LiveSetUpReply> => ipcRenderer.invoke('live-service:set-up'),
    onStatus: (listener: (row: GoingLiveRow) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, row: GoingLiveRow): void => listener(row)
      ipcRenderer.on('live-service:status', handler)
      return () => { ipcRenderer.removeListener('live-service:status', handler) }
    },
    /** "Updating the live service…" (before a use), "Setting up going live…". */
    onNotice: (listener: (message: string) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, message: string): void => listener(message)
      ipcRenderer.on('live-service:notice', handler)
      return () => { ipcRenderer.removeListener('live-service:notice', handler) }
    },
  },
  // Capture embed… (src/main/live-page-capture-window.ts): a window for one slide's web page, in which
  // the person captures views of it; main checks every field and binds the window to that slide and
  // page. images/alts: the slide's {capture} lines now, for the window's list. close: this editor's
  // window closes (another talk).
  livePage: {
    openCapture: (request: { outlinePath: string; slideId: string; pageUrl: string; title: string; images: string[]; alts: string[] }): Promise<{ ok: true } | { ok: false; message: string }> =>
      ipcRenderer.invoke('live-page:open-capture', request),
    closeCapture: (): Promise<boolean> => ipcRenderer.invoke('live-page:close-capture'),
  },
  // Object cards' file status (src/main/object-status.ts): for the talk this window has open only.
  objects: {
    status: (outlinePath: string, refs: string[]): Promise<
      | { ok: true; statuses: Array<{ ref: string; state: 'present' | 'missing' | 'outside' | 'remote' | 'invalid' | 'unchecked'; path?: string }> }
      | { ok: false; reason: string }
    > => ipcRenderer.invoke('object:status', outlinePath, refs),
    /** A web page's views saved before {capture} lines existed, for Place earlier views. */
    earlierViews: (outlinePath: string, pageUrl: string): Promise<
      | { ok: true; views: Array<{ image: string; capturedAt: string; mode?: 'page' }> }
      | { ok: false; reason: string }
    > => ipcRenderer.invoke('object:earlier-views', outlinePath, pageUrl),
  },
  // Insert › HTML page… (src/main/html-page-import.ts). choose opens the native picker for the named
  // talk and writes nothing (null = cancelled); import copies the chosen page into that talk's assets
  // folder and answers the reference for the `[Embed: …]` line, which the editor writes.
  htmlPage: {
    choose: (outlinePath: string): Promise<HtmlPageChoice | null> => ipcRenderer.invoke('talk:choose-html-page', outlinePath),
    import: (token: string, outlinePath: string): Promise<HtmlPageImport> => ipcRenderer.invoke('talk:import-html-page', token, outlinePath),
  },
  asset: {
    // outlinePath: the talk being edited; the image goes to that talk's vault (default: the current vault).
    pasteImage: (bytes: ArrayBuffer, ext?: string, outlinePath?: string): Promise<{ id: string; ext: string; path: string } | null> =>
      ipcRenderer.invoke('asset:paste-image', bytes, ext ?? 'png', outlinePath),
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
  // The research folder beside a talk (knowledge step two). `capture` calls the main-process verb that runs
  // `scout capture`; `revealFolder` creates `<talk>/research/` when absent and shows it in Finder.
  research: {
    write: (op: ResearchWriteOp, input: Omit<ResearchWriteInput, 'op'>): Promise<ResearchWriteResult> => ipcRenderer.invoke('research:write', op, input),
    destinations: (): Promise<{ path: string; title: string }[]> => ipcRenderer.invoke('research:destinations'),
    revealSource: (file: string): Promise<{ ok: true } | { ok: false; error: { code: string; message: string } }> => ipcRenderer.invoke('research:reveal-source', { file }),
    list: (input: ResearchListInput): Promise<ResearchListResult> => ipcRenderer.invoke('research:list', input),
    insert: (file: string, slide = false): Promise<{ ok: true } | { ok: false; error: { code: string; message: string } }> => ipcRenderer.invoke('research:insert', { file }, slide),
    cancelUsage: (requestId: string): void => ipcRenderer.send('research:cancel-usage', requestId),
    whereUsed: (input: ResearchUsedInput): Promise<ResearchUsedResult> => ipcRenderer.invoke('research:where-used', input),
    search: (input: ResearchSearchInput): Promise<ResearchListResult> => ipcRenderer.invoke('research:search', input),
    capture: (input: {
      talkDir: string; title: string; kind: string; prompt?: string; sources?: string[]; artefact?: string; body: string
    }): Promise<{ ok: true; file: string; corpus: string | null; indexed: boolean } | { ok: false; error: { code: string; message: string } }> =>
      ipcRenderer.invoke('research:capture', input),
    revealFolder: (talkDir: string): Promise<{ ok: true; path: string } | { ok: false; error: { code: string; message: string } }> =>
      ipcRenderer.invoke('research:reveal-folder', talkDir)
  },
  // Slide Scratchpad (src/main/scratchpad-ipc.ts, spec docs/design/2026-10-27-slide-scratchpad). The renderer
  // names no path: every call acts on the talk this window has open. Agent files are read-only to all of it;
  // only the app-owned state file changes. `subscribe` answers the snapshot and then `onChanged` carries every
  // later one (folder watch, or a change made from any window on the talk); `unsubscribe` stops it.
  scratchpad: {
    setSort: (sort: 'newest' | 'manual', expectedOutline: string): Promise<ScratchReply<{ snapshot: ScratchSnapshot }>> => ipcRenderer.invoke('scratchpad:set-sort', sort, expectedOutline),
    reorder: (visible: string[], next: string[], expectedOutline: string): Promise<ScratchReply<{ snapshot: ScratchSnapshot }>> => ipcRenderer.invoke('scratchpad:reorder', visible, next, expectedOutline),
    prepareInsert: (ids: string[], expectedOutline: string): Promise<ScratchReply<{ entries: ScratchPreparedInsert[] }>> => ipcRenderer.invoke('scratchpad:prepare-insert', ids, expectedOutline),
    markInsertedMany: (records: ScratchInsertedRecord[], expectedOutline: string): Promise<ScratchReply<{ snapshot: ScratchSnapshot }>> => ipcRenderer.invoke('scratchpad:mark-inserted-many', records, expectedOutline),
    setAside: (slides: ScratchSlideInput[], expectedOutline: string): Promise<ScratchReply<{ snapshot: ScratchSnapshot }>> => ipcRenderer.invoke('scratchpad:set-aside', slides, expectedOutline),
    subscribe: (): Promise<ScratchReply<{ snapshot: ScratchSnapshot }>> => ipcRenderer.invoke('scratchpad:subscribe'),
    unsubscribe: (): Promise<{ ok: true }> => ipcRenderer.invoke('scratchpad:unsubscribe'),
    load: (): Promise<ScratchReply<{ snapshot: ScratchSnapshot }>> => ipcRenderer.invoke('scratchpad:load'),
    addSlides: (slides: ScratchSlideInput[]): Promise<ScratchReply<{ snapshot: ScratchSnapshot; added: number; skipped: number }>> =>
      ipcRenderer.invoke('scratchpad:add-slides', slides),
    setStatus: (ids: string[], status: ScratchStatus): Promise<ScratchReply<{ snapshot: ScratchSnapshot }>> =>
      ipcRenderer.invoke('scratchpad:set-status', ids, status),
    /** group null = Ungrouped. */
    setGroup: (ids: string[], group: string | null): Promise<ScratchReply<{ snapshot: ScratchSnapshot }>> =>
      ipcRenderer.invoke('scratchpad:set-group', ids, group),
    createGroup: (name: string): Promise<ScratchReply<{ snapshot: ScratchSnapshot; group: ScratchGroup }>> =>
      ipcRenderer.invoke('scratchpad:create-group', name),
    /** Takes "File missing" items out of the state; never touches a file. */
    removeMissing: (ids: string[]): Promise<ScratchReply<{ snapshot: ScratchSnapshot }>> => ipcRenderer.invoke('scratchpad:remove-missing', ids),
    /** The live page of an agent's HTML item: shown in an iframe with exactly this sandbox, no other. */
    htmlPreview: (id: string): Promise<ScratchReply<{ url: string; sandbox: string }>> => ipcRenderer.invoke('scratchpad:html-preview', id),
    /** A PNG data address for an HTML item's thumbnail (url null: none yet or none possible). */
    htmlThumb: (id: string): Promise<ScratchReply<{ url: string | null }>> => ipcRenderer.invoke('scratchpad:html-thumb', id),
    revealFolder: (): Promise<ScratchReply> => ipcRenderer.invoke('scratchpad:reveal-folder'),
    // Inserting (ticket 2). Main copies the file a visual needs into this talk's vault and answers the line; the
    // renderer writes the outline itself, through the editor. None of these touches the outline or an agent file.
    /** An agent file's visual: picture → vault pool, SVG / HTML page → the talk's assets folder (a copy). */
    importVisual: (id: string): Promise<ScratchVisualImport> => ipcRenderer.invoke('scratchpad:import-visual', id),
    /** A picked slide's SVG file or page (`ref` as the snapshot names it), copied from its talk into this one. */
    importSlideVisual: (id: string, ref: string): Promise<ScratchVisualImport> => ipcRenderer.invoke('scratchpad:import-slide-visual', id, ref),
    /** The outline a picked slide came from, for the slide insert's media path. */
    slideSource: (id: string): Promise<ScratchReply<{ outlinePath: string }>> => ipcRenderer.invoke('scratchpad:slide-source', id),
    /** After an insert: records when, and the title of the slide it went into. */
    markInserted: (id: string, slideTitle: string): Promise<ScratchReply<{ snapshot: ScratchSnapshot }>> => ipcRenderer.invoke('scratchpad:mark-inserted', id, slideTitle),
    onChanged: (callback: (snapshot: ScratchSnapshot) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, snapshot: ScratchSnapshot): void => callback(snapshot)
      ipcRenderer.on('scratchpad:changed', handler)
      return () => ipcRenderer.removeListener('scratchpad:changed', handler)
    }
  },
  abstract: {
    read: (
      talkPath: string
    ): Promise<ReturnType<typeof readAbstract>> =>
      ipcRenderer.invoke('abstract:read', talkPath),
    write: (talkPath: string, raw: string): Promise<boolean> =>
      ipcRenderer.invoke('abstract:write', talkPath, raw)
  },
  outline: {
    // Live-presenting ticket 07: main routes an "Add to talk" insertion through the editor that has
    // the talk open (read its buffer, then apply-if-unchanged). The handler's result is the reply.
    onEditorDocumentRequest: (handler: (request: EditorDocumentRequest) => Promise<EditorDocumentReply>): (() => void) => {
      const listener = (_e: unknown, request: EditorDocumentRequest): void => {
        void Promise.resolve().then(() => handler(request))
          .catch((): EditorDocumentReply => ({ ok: false, error: 'The editor could not apply the change.' }))
          .then((reply) => ipcRenderer.invoke('outline:editor-reply', request.requestId, reply))
      }
      ipcRenderer.on('outline:editor-request', listener)
      return () => ipcRenderer.removeListener('outline:editor-request', listener)
    },
    // The outline's real file (symlinks resolved). null for an empty path.
    canonicalPath: (outlinePath: string): Promise<string | null> =>
      ipcRenderer.invoke('outline:canonical-path', outlinePath),
    // The file's identity (one-writer spec D3): `key` is device + inode (the real path while the file
    // does not exist yet), so every alias of one outline — symlink, linked folder, hard link — shares
    // one save queue (lib/saveQueue.ts). Resolved on every write. null for an empty path.
    identity: (outlinePath: string): Promise<{ key: string; realPath: string } | null> =>
      ipcRenderer.invoke('talk:outline-identity', outlinePath),
    // Pin (or clear, iconKey=null) the icon on ONE top-level list item of a slide, by writing the
    // canonical `{icon=KEY}` token at the end of that bullet's line. The item is addressed by
    // `itemLine`, its 1-based line in `content`, under the slide whose heading line is
    // `slideHeading`. The line is the only address. Returns the rewritten outline text, or null on
    // error, without a line, and when the engine's setListItemIcon refuses (the line is not a list
    // item of a slide's content, or the finished slide would not show the icon there).
    setItemIcon: (
      content: string,
      slideHeading: string,
      iconKey: string | null,
      itemLine: number
    ): Promise<string | null> =>
      ipcRenderer.invoke('outline:set-item-icon', content, slideHeading, iconKey, itemLine),
    // Set (or remove, iconKey=null) the `{icon=KEY}` token on a slide's heading line: the icon on
    // the slide's title. Only that token changes. The verb checks its edit by compiling: the answer
    // is { ok: true, text, changed } or a refusal { ok: false, text (as given), reason } to show
    // (`slide-not-found`, `unknown-icon`, `icon-set-elsewhere`, `cannot-place-here`). null on error.
    setHeadingIcon: (
      content: string,
      slideHeading: string,
      slideOccurrence: number,
      iconKey: string | null
    ): Promise<IconVerbResult | null> =>
      ipcRenderer.invoke('outline:set-heading-icon', content, slideHeading, slideOccurrence, iconKey),
    // Set (or remove, iconKey=null) the `{icon=KEY}` token at the end of one paragraph: the icon
    // beside it. `line` is the 1-based number of any line of the paragraph (the caret's line).
    // Same answer as setHeadingIcon; a line that is not in a visible paragraph is refused with
    // `not-a-paragraph`.
    setParagraphIcon: (
      content: string,
      line: number,
      iconKey: string | null
    ): Promise<IconVerbResult | null> =>
      ipcRenderer.invoke('outline:set-paragraph-icon', content, line, iconKey),
    // Merge a picker-chosen trigger onto the slide under the caret line: same-key tokens
    // replaced (Trigger Dictionary), {id=…} and every other token kept verbatim (ADR-0032).
    mergeTrigger: (content: string, lineNumber: number, trigger: string): Promise<string | null> =>
      ipcRenderer.invoke('outline:merge-trigger', content, lineNumber, trigger)
  },
  talks: {
    // Talk search (ADR-0029 §1, §2): ranked talks for plain words and field prefixes, each with the line saying what
    // matched; `within` limits results to a folder (vault-relative) and its subfolders.
    search: (query: string, options?: TalkSearchOptions): Promise<TalkSearchResult> =>
      ipcRenderer.invoke('talks:search', query, options ?? {}),
    // The fo: completion source: every folder holding talks (any depth), with the talks directly
    // in it; ancestors listed with 0. Same talk scan as search.
    folders: (): Promise<TalkFolderCount[]> => ipcRenderer.invoke('talks:folders'),
    // Folders left open or closed in the Talks browser (ADR-0029 §3), for the current vault:
    // vault-relative folder path → open. Stored in <userData>/config.json (`talkListFolders`).
    folderState: (): Promise<Record<string, boolean>> => ipcRenderer.invoke('talks:folder-state'),
    // Merge choices (path → open) and persist; resolves to the vault's stored map.
    setFolderState: (changes: Record<string, boolean>): Promise<Record<string, boolean>> =>
      ipcRenderer.invoke('talks:set-folder-state', changes)
  },
  search: {
    // Accepts either a bare string (legacy all-fields all-words) or the renderer's structured,
    // scoped query (t:/s:/i:/e: parsed via parseSearchQuery). Rows carry `titleHit` so the
    // Browser can float title matches to the front.
    // options.vaultIds limits the search to those open vaults; without it, the first open vault.
    // options.requestId + supersedeKey: a newer request with the same key from this window stops this scan (it answers []).
    allSlides: (
      query:
        | string
        | { scope: 'all' | 'title' | 'body' | 'image'; exact: boolean; text: string; terms: string[] },
      options?: { vaultIds?: string[]; requestId?: number; supersedeKey?: string }
    ): Promise<
      Array<ProjectionRow & { vaultId?: string; talkSlug: string; talkTitle: string; outlinePath: string; titleHit?: boolean }> | null
    > => options === undefined ? ipcRenderer.invoke('search:all-slides', query) : ipcRenderer.invoke('search:all-slides', query, options),
    // The Slide Browser's form of allSlides: each talk once, rows pointing at it, unread fields
    // dropped (shared/slide-search-reply.ts; expandSlideSearchReply restores the row type).
    allSlidesCompact: (
      query: { scope: 'all' | 'title' | 'body' | 'image'; exact: boolean; text: string; terms: string[] },
      options: { vaultIds?: string[]; requestId?: number; supersedeKey?: string }
    ): Promise<CompactSlideSearchReply | ProjectionRow[] | null> =>
      ipcRenderer.invoke('search:all-slides', query, { ...options, compact: true }),
    // The stamp a whole-index scan of these vaults would carry now (main/search-index-stamp.ts): the
    // Browser reuses its held rows only while it equals theirs. null = nothing to search.
    indexStamp: (options: { vaultIds?: string[] }): Promise<string | null> =>
      ipcRenderer.invoke('search:index-stamp', options)
  },
  // The image search seam (ticket 10): SlideWell's shared store when present, else the archive.
  // search() returns words hits first, then picture matches (match 'both' by default).
  images: {
    status: (): Promise<ImageSearchStatus> => ipcRenderer.invoke('images:status'),
    search: (query: string, opts?: { match?: MatchMode }): Promise<ImageSearchResult | null> =>
      ipcRenderer.invoke('images:search', query, opts),
    // The pictures already in the open vaults' _assets (the In your talks tab). Null when the query is refused or the read fails.
    searchVault: (query: string): Promise<VaultPictureResult | null> => ipcRenderer.invoke('images:search-vault', query),
    // talkPath: the talk the picture is for. Main copies it into THAT talk's vault (worked out from the path),
    // and imports nothing for a talk in no open vault.
    importImage: (thumbUrl: string, talkPath: string): Promise<ImportedImage | null> => ipcRenderer.invoke('images:import', thumbUrl, talkPath)
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
    // Free-text icon search over the engine's vocabulary (Lucide names/tags + SVGL brands +
    // the full Tabler collection), backed by 05-icons.mjs searchIcons. Returns the top matches as
    // {key, source} where key is `lucide:name`, `svgl:name` or `tabler:name`. The icon picker
    // calls this per (debounced) keystroke, and deliberately sees the WHOLE Tabler collection —
    // the compiler's mood-*-only auto-match gate restricts what the compiler GUESSES, not what a
    // person may deliberately pick via an explicit search.
    search: (query: string): Promise<Array<{ key: string; source: 'lucide' | 'svgl' | 'tabler' }>> =>
      ipcRenderer.invoke('icons:search', query),
    // Render one icon key to its SVG markup (currentColor / brand fill), via 05-icons.mjs iconSvg.
    // Returns null when the key resolves to no drawable glyph.
    svg: (key: string): Promise<string | null> => ipcRenderer.invoke('icons:svg', key),
    // Every name of the Lucide set as a key (`lucide:name`), in the set's order: what the Plain
    // view's Command-I picker lists before a search is typed. Empty when the set cannot be read.
    names: (): Promise<string[]> => ipcRenderer.invoke('icons:names')
  },
  // TalkWeaver History (ADR-0035). The renderer joins these handout records with recorded
  // Sessions; live checks are cached in main and can be forced by the user's explicit re-check.
  history: {
    talkHandouts: (vaultId?: string): Promise<TalkHandouts> => vaultId ? ipcRenderer.invoke('history:talk-handouts', vaultId) : ipcRenderer.invoke('history:talk-handouts'),
    checkLive: (url: string, force = false): Promise<HistoryLiveCheck> =>
      ipcRenderer.invoke('history:check-live', url, force),
    /** `vaultId`: that open vault's Runs (the Sessions view's selected Run); none: the current vault's. */
    listRuns: (talkSlug?: string, vaultId?: string): Promise<RecordingSession[]> => vaultId ? ipcRenderer.invoke('history:list-runs', talkSlug, vaultId) : ipcRenderer.invoke('history:list-runs', talkSlug),
    createPlannedRun: (input: {
      talkSlug: string; talkTitle: string; plannedDate: string; eventTitle: string; audience: string; slideSet: RunSlideSet
      startTime?: string; expectedPeople?: number; preworkOpens?: string; preworkCloses?: string; timeZone?: string
      work?: RunWorkPlan
      /** The vault of the talk: the Run is written there (refused when it is not open). None: the current vault. */
      vaultId?: string
    }): Promise<{ ok: boolean; run?: RecordingSession; error?: string }> => ipcRenderer.invoke('history:create-planned-run', input),
    updatePlannedRun: (talkSlug: string, runId: string, patch: Partial<{
      plannedDate: string; eventTitle: string; audience: string; slideSet: RunSlideSet
      startTime: string | null; expectedPeople: number | null; preworkOpens: string | null; preworkCloses: string | null; timeZone: string | null
      work: RunWorkPlan
    }>, vaultId?: string): Promise<{ ok: boolean; run?: RecordingSession; error?: string }> =>
      ipcRenderer.invoke('history:update-planned-run', { talkSlug, runId, patch, ...(vaultId ? { vaultId } : {}) }),
    deletePlannedRun: (talkSlug: string, runId: string, vaultId?: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('history:delete-planned-run', { talkSlug, runId, ...(vaultId ? { vaultId } : {}) }),
    buildRunHandout: (talkSlug: string, runId: string): Promise<{
      success: boolean; path?: string; slideIds?: string[]; missing?: string[]; error?: string
    }> => ipcRenderer.invoke('run:build-handout', { talkSlug, runId }),
    // `vaultId`: the Run's own vault (the Sessions view sends it); main acts there only and refuses a vault that is not open.
    publishRunHandout: (talkSlug: string, runId: string, vaultId?: string): Promise<{
      success: boolean; url?: string; path?: string; slideIds?: string[]; missing?: string[]; error?: string; details?: string; warning?: string
    } & PublishReplyExtras> => ipcRenderer.invoke('run:publish-handout', { talkSlug, runId, ...(vaultId ? { vaultId } : {}) }),
    unpublishRunHandout: (talkSlug: string, runId: string, vaultId?: string): Promise<{ success: boolean; error?: string; details?: string } & Pick<PublishReplyExtras, 'notReady'>> =>
      ipcRenderer.invoke('run:unpublish-handout', { talkSlug, runId, ...(vaultId ? { vaultId } : {}) }),
    // Live-presenting ticket 07 (L6): where each recorded instant slide's anchor sits in the talk NOW
    // (null = that slide is no longer in the talk), and "Add to talk" for one of them.
    instantAnchors: (talkSlug: string, runId: string, home?: string | null): Promise<Record<string, { slideNumber: number; title: string } | null>> =>
      ipcRenderer.invoke('history:instant-anchors', { talkSlug, runId, ...(home !== undefined ? { home } : {}) }),
    // Reactions ticket 06: slide number and title NOW for each slide the Run's questions and
    // reactions name (null = no longer in the talk).
    feedbackSlides: (talkSlug: string, runId: string, home?: string | null): Promise<Record<string, { slideNumber: number; title: string } | null>> =>
      ipcRenderer.invoke('history:feedback-slides', { talkSlug, runId, ...(home !== undefined ? { home } : {}) }),
    addInstantSlide: (talkSlug: string, runId: string, entryId: string, home?: string | null): Promise<
      { ok: true; afterSlideNumber: number; afterSlideTitle: string; run: RecordingSession; warning?: string } | { ok: false; error: string }
    > => ipcRenderer.invoke('history:add-instant-slide', { talkSlug, runId, entryId, ...(home !== undefined ? { home } : {}) }),
    // Feedback-boards ticket 06: a board left open (Refresh from the board, Close it now, and every
    // such board on Re-check live), Put back on a hidden card, and the Run's read-only share link.
    boardRefresh: (talkSlug: string, runId: string, home?: string | null): Promise<RunBoardPullResult> =>
      ipcRenderer.invoke('history:board-refresh', { talkSlug, runId, ...(home !== undefined ? { home } : {}) }),
    boardClose: (talkSlug: string, runId: string, home?: string | null): Promise<RunBoardPullResult> =>
      ipcRenderer.invoke('history:board-close', { talkSlug, runId, ...(home !== undefined ? { home } : {}) }),
    recheckBoards: (): Promise<{ runs: RecordingSession[]; late: number; warning?: string }> => ipcRenderer.invoke('history:recheck-boards'),
    // A board is named by its poll and its live session (the same board in two sessions is two boards).
    boardPutBack: (talkSlug: string, runId: string, boardId: string, sessionId: string | undefined, cardId: string, putBack: boolean, home?: string | null): Promise<
      { ok: true; run: RecordingSession; warning?: string } | { ok: false; error: string }
    > => ipcRenderer.invoke('history:board-put-back', { talkSlug, runId, boardId, sessionId, cardId, putBack, ...(home !== undefined ? { home } : {}) }),
    resultsShareStatus: (talkSlug: string, runId: string, home?: string | null): Promise<RunResultsShareState | null> =>
      ipcRenderer.invoke('history:results-share-status', { talkSlug, runId, ...(home !== undefined ? { home } : {}) }),
    resultsShare: (talkSlug: string, runId: string, include: { board: boolean; polls: boolean }, lifetime: RunShareLifetime, title?: string, home?: string | null): Promise<
      { ok: true; share: RunResultsShareState } | { ok: false; error: string }
    > => ipcRenderer.invoke('history:results-share', { talkSlug, runId, include, lifetime, title, ...(home !== undefined ? { home } : {}) }),
    resultsShareStop: (talkSlug: string, runId: string, home?: string | null): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke('history:results-share-stop', { talkSlug, runId, ...(home !== undefined ? { home } : {}) }),
    // Feedback-boards ticket 09, work-files ticket 13: a Run's pre-work or post-work (`phase`, pre-work
    // when left out) — whether it has one, pull the answers onto the Run now, and close it now (then
    // one last pull).
    // `vaultId` (the Run page sends the Run's own): the Run is read and written in that vault; none: the current vault.
    preworkStatus: (talkSlug: string, runId: string, phase: RunWorkPhase = 'pre', vaultId?: string): Promise<RunPreworkState | null> =>
      ipcRenderer.invoke('history:prework-status', { talkSlug, runId, phase, ...(vaultId ? { vaultId } : {}) }),
    preworkRefresh: (talkSlug: string, runId: string, phase: RunWorkPhase = 'pre', vaultId?: string): Promise<RunPreworkPullResult> =>
      ipcRenderer.invoke('history:prework-refresh', { talkSlug, runId, phase, ...(vaultId ? { vaultId } : {}) }),
    preworkClose: (talkSlug: string, runId: string, phase: RunWorkPhase = 'pre', vaultId?: string): Promise<RunPreworkPullResult> =>
      ipcRenderer.invoke('history:prework-close', { talkSlug, runId, phase, ...(vaultId ? { vaultId } : {}) }),
    /** One change to a step's picks, applied by main to the Run as it is then. */
    preworkPick: (talkSlug: string, runId: string, stepId: string, change: PickChange, phase: RunWorkPhase = 'pre', vaultId?: string): Promise<{ ok: true; run: RecordingSession } | { ok: false; error: string }> =>
      ipcRenderer.invoke('history:prework-pick', { talkSlug, runId, stepId, change, phase, ...(vaultId ? { vaultId } : {}) }),
    /** The board slides each pre-work step feeds, with the compiler's slide ids; `ok: false` when the talk cannot be compiled. */
    preworkFeeds: (talkSlug: string, vaultId?: string): Promise<{ ok: true; feeds: PreworkFeed[] } | { ok: false }> =>
      ipcRenderer.invoke('history:prework-feeds', { talkSlug, ...(vaultId ? { vaultId } : {}) }),
    preworkQuestion: (talkSlug: string, runId: string, entryId: string, patch: { answered?: boolean; inTalk?: { slideId: string | null } | null }, phase: RunWorkPhase = 'pre', vaultId?: string): Promise<{ ok: true; run: RecordingSession } | { ok: false; error: string }> =>
      ipcRenderer.invoke('history:prework-question', { talkSlug, runId, entryId, patch, phase, ...(vaultId ? { vaultId } : {}) }),
    /** The Run page's read state: leaving the Run, Mark all read, or one response kept unread by its dot. */
    preworkSeen: (talkSlug: string, runId: string, change: { type: 'leave' } | { type: 'all' } | { type: 'keep'; id: string; unread: boolean }, phase: RunWorkPhase = 'pre', vaultId?: string): Promise<{ ok: true; run: RecordingSession } | { ok: false; error: string }> =>
      ipcRenderer.invoke('history:prework-seen', { talkSlug, runId, change, phase, ...(vaultId ? { vaultId } : {}) })
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
  talktext: {
    model: (talkSlug: string, sessionId: string): Promise<TalkTextModel | null> =>
      ipcRenderer.invoke('talktext:model', talkSlug, sessionId),
    export: (
      talkSlug: string,
      sessionId: string,
      options: TalkTextExportOptions
    ): Promise<string | null> => ipcRenderer.invoke('talktext:export', talkSlug, sessionId, options)
  },
  rewrite: {
    preparePack: (
      talkSlug: string,
      sessionId: string
    ): Promise<{ ok: boolean; packDir?: string; error?: string }> =>
      ipcRenderer.invoke('rewrite:prepare-pack', talkSlug, sessionId),
    listParts: (talkSlug: string, sessionId: string): Promise<DraftPart[]> =>
      ipcRenderer.invoke('rewrite:list-parts', talkSlug, sessionId),
    notes: (
      talkSlug: string,
      sessionId: string
    ): Promise<{ parts: NotesPart[]; markdown: string } | null> =>
      ipcRenderer.invoke('rewrite:notes', talkSlug, sessionId),
    approvePart: (
      talkSlug: string,
      sessionId: string,
      slug: string
    ): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('rewrite:approve-part', talkSlug, sessionId, slug),
    unapprovePart: (
      talkSlug: string,
      sessionId: string,
      slug: string
    ): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('rewrite:unapprove-part', talkSlug, sessionId, slug),
    openPart: (talkSlug: string, sessionId: string, slug: string): Promise<boolean> =>
      ipcRenderer.invoke('rewrite:open-part', talkSlug, sessionId, slug),
    discardPart: (talkSlug: string, sessionId: string, slug: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('rewrite:discard-part', talkSlug, sessionId, slug),
    revealFolder: (talkSlug: string, sessionId: string): Promise<boolean> =>
      ipcRenderer.invoke('rewrite:reveal-folder', talkSlug, sessionId),
    copyPrompt: (talkSlug: string, sessionId: string): Promise<string | null> =>
      ipcRenderer.invoke('rewrite:copy-prompt', talkSlug, sessionId),
    onPartsChanged: (
      cb: (payload: { talkSlug: string; sessionId: string }) => void
    ): (() => void) => {
      const listener = (_event: unknown, payload: { talkSlug: string; sessionId: string }): void => cb(payload)
      ipcRenderer.on('talktext:parts-changed', listener)
      return () => ipcRenderer.removeListener('talktext:parts-changed', listener)
    }
  },
  clean: {
    prepare: (
      talkSlug: string,
      sessionId: string,
      options: CleanPrepareOptions
    ): Promise<{ ok: boolean; cleanedDir?: string; error?: string }> =>
      ipcRenderer.invoke('clean:prepare', talkSlug, sessionId, options),
    list: (talkSlug: string, sessionId: string): Promise<CleanedSlideItem[]> =>
      ipcRenderer.invoke('clean:list', talkSlug, sessionId),
    approve: (
      talkSlug: string,
      sessionId: string,
      slideNumber: number
    ): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('clean:approve', talkSlug, sessionId, slideNumber),
    unapprove: (
      talkSlug: string,
      sessionId: string,
      slideNumber: number
    ): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('clean:unapprove', talkSlug, sessionId, slideNumber),
    open: (talkSlug: string, sessionId: string, slideNumber: number): Promise<boolean> =>
      ipcRenderer.invoke('clean:open', talkSlug, sessionId, slideNumber),
    save: (
      talkSlug: string,
      sessionId: string,
      slideNumber: number,
      markdown: string,
      keepApproval: boolean,
      allowEmpty?: boolean
    ): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('clean:save', talkSlug, sessionId, slideNumber, markdown, keepApproval, allowEmpty),
    move: (
      talkSlug: string,
      sessionId: string,
      source: { slideNumber: number; markdown: string },
      destination: { slideNumber: number; markdown: string }
    ): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('clean:move', talkSlug, sessionId, source, destination),
    undoMove: (
      talkSlug: string,
      sessionId: string
    ): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('clean:undoMove', talkSlug, sessionId),
    revealFolder: (talkSlug: string, sessionId: string): Promise<boolean> =>
      ipcRenderer.invoke('clean:reveal-folder', talkSlug, sessionId),
    copyPrompt: (talkSlug: string, sessionId: string): Promise<string | null> =>
      ipcRenderer.invoke('clean:copy-prompt', talkSlug, sessionId),
    discard: (
      talkSlug: string,
      sessionId: string,
      slideNumber: number
    ): Promise<{ ok: boolean }> => ipcRenderer.invoke('clean:discard', talkSlug, sessionId, slideNumber),
    onChanged: (
      cb: (payload: { talkSlug: string; sessionId: string }) => void
    ): (() => void) => {
      const listener = (_event: unknown, payload: { talkSlug: string; sessionId: string }): void => cb(payload)
      ipcRenderer.on('talktext:cleaned-changed', listener)
      return () => ipcRenderer.removeListener('talktext:cleaned-changed', listener)
    }
  },
  importer: {
    capabilities: (): Promise<{ available: boolean; platform: string; renderer: import('../shared/importer').ImportRendererRecord }> =>
      ipcRenderer.invoke('importer:capabilities'),
    chooseSources: (mode: 'files' | 'folder'): Promise<ImportSourceSelection> =>
      ipcRenderer.invoke('importer:choose-sources', mode),
    chooseDestination: (): Promise<string | null> =>
      ipcRenderer.invoke('importer:choose-destination'),
    start: (request: ImportStartRequest): Promise<ImportRunDetail> =>
      ipcRenderer.invoke('importer:start', request),
    resume: (runId: string): Promise<ImportRunDetail> =>
      ipcRenderer.invoke('importer:resume', runId),
    listRuns: (): Promise<ImportRunManifest[]> =>
      ipcRenderer.invoke('importer:list-runs'),
    getRun: (runId: string): Promise<ImportRunDetail> =>
      ipcRenderer.invoke('importer:get-run', runId),
    updateSlide: (runId: string, slideNumber: number, patch: ImportSlidePatch): Promise<ImportRunDetail> =>
      ipcRenderer.invoke('importer:update-slide', runId, slideNumber, patch),
    resetSlide: (runId: string, slideNumber: number): Promise<ImportRunDetail> =>
      ipcRenderer.invoke('importer:reset-slide', runId, slideNumber),
    preparePack: (request: ImportPackRequest): Promise<{ packId: string; packDir: string }> =>
      ipcRenderer.invoke('importer:prepare-pack', request),
    listSuggestions: (runId: string, packId: string): Promise<{ suggestions: ImportSuggestion[]; errors: string[] }> =>
      ipcRenderer.invoke('importer:list-suggestions', runId, packId),
    applySuggestion: (runId: string, packId: string, slideNumber: number): Promise<ImportRunDetail> =>
      ipcRenderer.invoke('importer:apply-suggestion', runId, packId, slideNumber),
    getSettings: (): Promise<ImporterSettings> =>
      ipcRenderer.invoke('importer:get-settings'),
    setSettings: (patch: Partial<ImporterSettings>): Promise<ImporterSettings> =>
      ipcRenderer.invoke('importer:set-settings', patch),
    revealRun: (runId: string): Promise<boolean> =>
      ipcRenderer.invoke('importer:reveal-run', runId),
    originalDataUrl: (runId: string, slideNumber: number): Promise<string> =>
      ipcRenderer.invoke('importer:original-data-url', runId, slideNumber),
    onProgress: (cb: (payload: ImportProgress) => void): (() => void) => {
      const listener = (_event: unknown, payload: ImportProgress): void => cb(payload)
      ipcRenderer.on('importer:progress', listener)
      return () => ipcRenderer.removeListener('importer:progress', listener)
    }
  },
  // The Tools window's Work files view (work-files ticket 06). Read only; opening a file goes through shell.openPath.
  workFiles: {
    /** The work files of one open vault (vaultId); without it, every open vault's (each item carries its vaultId), as the Work files view lists them. */
    list: (vaultId?: string): Promise<WorkFilesListing | null> =>
      vaultId === undefined ? ipcRenderer.invoke('work-files:list') : ipcRenderer.invoke('work-files:list', vaultId),
    // Work-files ticket 07: writes go only into the vault's `Work files/` folder.
    create: (input: { title: string; presetId?: string | null; adds?: WorkFileAdd[]; vaultId?: string }): Promise<WorkFileWriteResult> => ipcRenderer.invoke('work-files:create', input),
    addStep: (fileName: string, add: WorkFileAdd, vaultId?: string): Promise<WorkFileWriteResult> => ipcRenderer.invoke('work-files:add-step', { fileName, add, vaultId }),
    /** Where a step's answer goes: `local` true writes `{local}` (Local only), false takes it out (Sent to you). In the named vault, or the current one. */
    setStepLocal: (fileName: string, stepId: string, local: boolean, vaultId?: string): Promise<WorkFileWriteResult> => ipcRenderer.invoke('work-files:set-step-local', { fileName, stepId, local, vaultId }),
    /** Work-files ticket 28: move a retired `{prework}` section of the talk into a work file, name it in the talk's `prework:` and remove the section. */
    movePrework: (outlinePath: string): Promise<WorkFileWriteResult & { stepIds?: string[] }> => ipcRenderer.invoke('work-files:move-prework', { outlinePath })
  },
  sessions: {
    /** Every planned and delivered Run of every open vault, plus the Runs a live session is bound to (`talkSlug/runId`). */
    list: (): Promise<{ runs: SessionSource[]; live: string[] }> => ipcRenderer.invoke('sessions:list'),
    /** How each work file attached to a Run reads: title, step count and its first blocking finding in words. */
    runFiles: (run: SessionRunRef): Promise<{ ok: true; files: { pre?: WorkFileState; post?: WorkFileState } } | { ok: false; error: string }> => ipcRenderer.invoke('sessions:run-files', run),
    /** Each attached phase's steps (from its work file, or the talk's `{prework}` section) and the Run's answers for the phase. */
    runAnswers: (run: SessionRunRef): Promise<{ ok: true; pre?: PhaseSteps; post?: PhaseSteps; prework?: RunPrework; postwork?: RunPrework; writable: boolean; ownerUnknown?: RunWorkPhase[] } | { ok: false; error: string }> => ipcRenderer.invoke('sessions:run-answers', run),
    /** A planned Run given without presenting from the app becomes delivered. */
    markDelivered: (run: SessionRunRef): Promise<{ ok: true } | { ok: false; error: string }> => ipcRenderer.invoke('sessions:mark-delivered', run),
    /** The Run's attached work file for one phase, opened in the OS's editor. */
    openWorkFile: (run: SessionRunRef, phase: 'pre' | 'post'): Promise<{ ok: true; fileName: string; vaultId: string } | { ok: false; error: string }> => ipcRenderer.invoke('sessions:open-work-file', { ...run, phase }),
    /** The presenter window of the Run's live session, brought forward. */
    openLiveView: (run: SessionRunRef): Promise<{ ok: true } | { ok: false; error: string }> => ipcRenderer.invoke('sessions:open-live-view', run),
    /** Preview page: the Run's participant page built on this computer and opened; nothing is uploaded. */
    previewPage: (run: SessionRunRef): Promise<{ ok: true } | { ok: false; error: string }> => ipcRenderer.invoke('sessions:preview-page', run),
    /** The QR code of one of the Run's published links, as SVG. */
    runQr: (url: string): Promise<{ ok: true; svg: string } | { ok: false; error: string }> => ipcRenderer.invoke('sessions:run-qr', { url }),
    /** Extras for this run: the intro note and links kept on the Run (null takes them away); shown on its handout from the next publish. */
    setExtras: (run: SessionRunRef, extras: RunExtras | null): Promise<{ ok: true; extras: RunExtras | null } | { ok: false; error: string }> =>
      ipcRenderer.invoke('sessions:set-extras', { ...run, extras }),
    /** Extra slides of the Run (ticket 25), kept on the Run record, and the Run's slides for "Place after". */
    extraSlides: (run: SessionRunRef): Promise<({ ok: true } & RunExtraSlidesState) | { ok: false; error: string }> =>
      ipcRenderer.invoke('sessions:extra-slides', run),
    /** Adds an extra slide (no id: main makes it) or changes one (its id); kept on the Run, never in the talk's outline. */
    saveExtraSlide: (run: SessionRunRef, slide: { id?: string; title: string; text: string; after: string }): Promise<({ ok: true } & RunExtraSlidesState) | { ok: false; error: string }> =>
      ipcRenderer.invoke('sessions:save-extra-slide', { ...run, slide }),
    /** Removes an extra slide from the Run. */
    removeExtraSlide: (run: SessionRunRef, id: string): Promise<({ ok: true } & RunExtraSlidesState) | { ok: false; error: string }> =>
      ipcRenderer.invoke('sessions:remove-extra-slide', { ...run, id })
  },
  published: {
    /** Work-files ticket 22: every Run with a link and every talk with `handout_url`, in every open vault, each with its folder in the site, and this computer's copy of the site (shared/published-pages.ts makes the rows). */
    list: (): Promise<PublishedPagesInput> => ipcRenderer.invoke('published:list'),
    /** Unpublish a talk's evergreen handout: its folder leaves the site, then `handout_url` leaves the talk. Run handouts are not touched. The talk is named by its outline, relative to its vault's folder. */
    unpublishTalk: (vaultId: string, outline: string): Promise<{ success: boolean; error?: string; details?: string; notReady?: PublishNotReady }> =>
      ipcRenderer.invoke('published:unpublish-talk', { vaultId, outline })
  },
  tools: {
    open: (view: ToolsView, sessionId?: string, run?: ToolsRunRef): Promise<{ success: boolean; error?: string }> =>
      isToolsView(view) ? ipcRenderer.invoke('tools:open', view, sessionId, run) : Promise.resolve({ success: false, error: 'Unknown Tools view.' }),
    /** Sessions on one Run; with vaultId, that vault's Run when two vaults hold the same talk and Run id. */
    openRun: (talkSlug: string, runId: string, vaultId?: string, home?: string | null): Promise<{ success: boolean; error?: string }> => {
      const ref = parseToolsRunRef({ talkSlug, runId, ...(vaultId ? { vaultId } : {}) })
      return ref ? ipcRenderer.invoke('tools:open', 'sessions', undefined, { ...ref, ...(home !== undefined ? { home } : {}) }) : Promise.resolve({ success: false, error: 'Unknown Run.' })
    },
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
    // File-list "Open in new window": a talk opens in a new window (or its existing window is
    // focused); a folder opens a new window with the file list scoped to it.
    openInNewWindow: (target: { kind: 'talk'; outlinePath: string } | { kind: 'folder'; topic: string; vaultId?: string }): Promise<{ ok: boolean; focused?: boolean; reason?: string }> =>
      ipcRenderer.invoke('window:open-in-new-window', target),
    // A window started by openInNewWindow asks, once, what it was opened for (null for a plain ⌘N window).
    takeOpenRequest: (): Promise<{ kind: 'talk'; outlinePath: string } | { kind: 'folder'; topic: string; vaultId?: string } | null> =>
      ipcRenderer.invoke('window:take-open-request'),
    claimTalk: (outlinePath: string | null): Promise<{ ok: boolean; reason?: string }> =>
      ipcRenderer.invoke('window:claim-talk', outlinePath)
  },
  // Share for comments (ticket 03). The owner token stays in main; these states never carry it.
  sharedTalk: {
    status: (outlinePath: string): Promise<SharedTalkState | null> => ipcRenderer.invoke('shared-talk:status', outlinePath),
    // The sheet's first look: this Mac's share, or a share_url in the outline from another Mac.
    inspect: (outlinePath: string): Promise<SharedTalkInspection> => ipcRenderer.invoke('shared-talk:inspect', outlinePath),
    list: (): Promise<SharedTalkState[]> => ipcRenderer.invoke('shared-talk:list'),
    // Creates the share (or returns the talk's existing one) and pushes revision 1.
    /** `setup`: no live service to share with, and what the sheet offers for it (Open Settings, or Set up going live now).
     *  `stopped`: a Stop overtook this Share (ticket 12) — no link; `shareId` is the closed share, or null. */
    share: (outlinePath: string, title?: string): Promise<{ success: boolean; share?: SharedTalkState; stopped?: true; shareId?: string | null; error?: string; setup?: LiveSetupPrompt }> =>
      ipcRenderer.invoke('shared-talk:share', outlinePath, title),
    // `stopped`: the share was stopped while the change ran (ticket 12) — no link, as for share().
    setOptions: (outlinePath: string, options: { liveUpdates?: boolean; proposals?: boolean }): Promise<{ success: boolean; share?: SharedTalkState; stopped?: true; shareId?: string | null; error?: string }> =>
      ipcRenderer.invoke('shared-talk:set-options', outlinePath, options),
    // "Update shared copy": push the talk as it is now, whatever switch 1 says.
    update: (outlinePath: string): Promise<{ success: boolean; share?: SharedTalkState; stopped?: true; shareId?: string | null; error?: string }> =>
      ipcRenderer.invoke('shared-talk:update', outlinePath),
    // serverClosed false: the Worker refused the owner token; the share is stopped here and `message`
    // says so (the link retires on its own).
    stop: (outlinePath: string): Promise<{ success: boolean; serverClosed?: boolean; message?: string | null; error?: string }> =>
      ipcRenderer.invoke('shared-talk:stop', outlinePath),
    // Fires for every change to any share (created, pushed, failed, options, stopped → state null).
    // `previousKey`: the same share re-keyed (its outline was replaced by a new file) — one event.
    onChanged: (cb: (change: { key: string; state: SharedTalkState | null; previousKey?: string }) => void): (() => void) => {
      const listener = (_event: unknown, change: { key: string; state: SharedTalkState | null; previousKey?: string }): void => cb(change)
      ipcRenderer.on('shared-talk:changed', listener)
      return () => ipcRenderer.removeListener('shared-talk:changed', listener)
    },
    // Feedback rail (ticket 05). Counts and the owner socket's state for every share.
    feedbackSummaries: (): Promise<FeedbackSummary[]> => ipcRenderer.invoke('shared-talk:feedback-summaries'),
    // The talk's feedback as its feedback file holds it (null when the talk is not shared).
    feedbackList: (outlinePath: string): Promise<FeedbackList | null> => ipcRenderer.invoke('shared-talk:feedback-list', outlinePath),
    // Done / Dismiss / Accept / back to new (Undo): the file first, then the Worker. An accept carries
    // the splice it made to the outline (the editor made it; main only records it, for Undo).
    setFeedbackStatus: (outlinePath: string, itemId: string, status: FeedbackStatus, edit?: AcceptRecord | null): Promise<{ success: boolean; list?: FeedbackList | null; error?: string }> =>
      ipcRenderer.invoke('shared-talk:feedback-set-status', outlinePath, itemId, status, edit ?? undefined),
    // Fires when an item arrives, a status changes or the owner socket drops / comes back.
    onFeedbackChanged: (cb: (change: { shareId: string; summary: FeedbackSummary | null }) => void): (() => void) => {
      const listener = (_event: unknown, change: { shareId: string; summary: FeedbackSummary | null }): void => cb(change)
      ipcRenderer.on('shared-talk:feedback-changed', listener)
      return () => ipcRenderer.removeListener('shared-talk:feedback-changed', listener)
    }
  },
  // Presentation recording (ADR-0035). The REC control itself lives in the presenter (injected by
  // the recorder bridge, not this API); here is the app-side config for where audio uploads.
  recording: {
    // R2 destination + discard threshold. NEVER returns the access keys — only hasKeys.
    getStorage: (): Promise<{
      endpoint: string
      bucket: string
      discardSeconds: number
      hasKeys: boolean
    }> => ipcRenderer.invoke('recording:get-storage'),
    // The endpoint, bucket and access keys are changed only in the Settings window (its preload,
    // src/preload/settings.ts; main refuses any other sender).
    // The Recording storage row of Settings → Cloudflare: its state, the bucket's name and fixed
    // sentences. Never a key. `checkStorage` lists the bucket once (a read; it writes nothing).
    storageStatus: (): Promise<RecordingStorageRow> => ipcRenderer.invoke('recording:storage-status'),
    checkStorage: (): Promise<RecordingStorageRow> => ipcRenderer.invoke('recording:check-storage'),
    onStorageStatus: (listener: (row: RecordingStorageRow) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, row: RecordingStorageRow): void => listener(row)
      ipcRenderer.on('recording:storage-status', handler)
      return () => { ipcRenderer.removeListener('recording:storage-status', handler) }
    },
    // "Recording storage: enter your access keys" for an install that took its keys from Bitwarden:
    // answered once, then null for good.
    takeSetupNotice: (): Promise<string | null> => ipcRenderer.invoke('recording:take-setup-notice'),
    // Sessions recorded for a talk, from the Vault Presentation Ledger (newest first) — the
    // minimum Studio/History (Plans 2–3) read. Each is the session.json data model (ADR-0035).
    listSessions: (talkSlug: string): Promise<RecordingSession[]> =>
      ipcRenderer.invoke('recording:list-sessions', talkSlug),
    // Every Session across all talks (Studio's rail), newest first.
    listAllSessions: (): Promise<RecordingSession[]> => ipcRenderer.invoke('recording:list-all-sessions'),
    listRecovery: (): Promise<RecordingRecovery[]> => ipcRenderer.invoke('recording:list-recovery'),
    // Upload ONE session to R2 — direct and ONLY on request (never automatic). On failure the
    // recording stays local, untouched. `error` is a fixed word, never an error's text: an
    // UploadFailure ('not-set-up' / 'keys-rejected' / 'bucket-not-found' / 'offline' / 'failed' /
    // 'audio-missing') or a local reason; uploadFailureMessage (shared/recording-storage-status.ts) turns it into the sentence.
    upload: (talkSlug: string, sessionId: string, home?: string | null): Promise<{ ok: boolean; uploaded?: boolean; error?: string }> =>
      ipcRenderer.invoke('recording:upload', { talkSlug, sessionId, home }),
    // Edit (or clear) a session's context label.
    setContext: (talkSlug: string, sessionId: string, context: string, home?: string | null): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('recording:set-context', { talkSlug, sessionId, context, home }),
    setKind: (
      talkSlug: string,
      sessionId: string,
      kind: RecordingKind,
      home?: string | null
    ): Promise<{ ok: boolean; kind?: RecordingKind; error?: string }> =>
      ipcRenderer.invoke('recording:set-kind', { talkSlug, sessionId, kind, home }),
    setTrims: (
      talkSlug: string,
      sessionId: string,
      trims: TrimRange[],
      home?: string | null
    ): Promise<{ ok: boolean; trims?: TrimRange[]; error?: string }> =>
      ipcRenderer.invoke('recording:set-trims', { talkSlug, sessionId, trims, home }),
    // Delete a session — session.json + local audio go to the OS Trash (recoverable).
    deleteSession: (talkSlug: string, sessionId: string, home?: string | null): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('recording:delete-session', { talkSlug, sessionId, home })
  }
}

contextBridge.exposeInMainWorld('tw', api)

declare global {
  interface Window {
    tw: typeof api
  }
}
