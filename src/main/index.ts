import { createLatestThumbnailRequestHandler } from './thumbnail-queue'
import { app, BrowserWindow, ipcMain, dialog, Menu, net, protocol, shell, session, safeStorage, screen, powerMonitor, type MenuItemConstructorOptions } from 'electron'
import { join, basename, dirname, extname } from 'path'

// EPIPE guard: when the packaged binary is launched with stdout/stderr piped and the pipe
// dies, any console.log (prerenderAllThumbnails logs a lot) would otherwise throw an
// uncaught EPIPE and crash the main process with a dialog. Swallow stream errors — logging
// must never kill the app.
process.stdout.on('error', () => {})
process.stderr.on('error', () => {})

const E2E = process.env.TW_E2E === '1'

// Renderer heap headroom (2026-07-20). NOTE (2026-09-15): this switch reaches RENDERER processes
// only — Electron honours --js-flags for the main process solely when it is passed on the command
// line that launched the binary, so the main process keeps V8's own ceiling whatever is appended
// here. That ceiling was MEASURED on this build at 4096 MB
// (`ELECTRON_RUN_AS_NODE=1 TalkWeaver -e 'console.log(require("v8").getHeapStatistics().heap_size_limit)'`),
// and the main process died against it twice on 2026-09-15 while the Slide Browser rendered
// thumbnails for the whole vault. The fix is to make main-process work FIT 4096 MB — one deck
// inlined at a time, no video in a thumbnail render, nothing retained after a background pass —
// never to raise the ceiling. See thumbnail-media-policy.ts and [[talkweaver-vault-scale]].
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=8192')

// Crash safety net: Electron embeds Node, whose default --unhandled-rejections=throw turns
// ANY unhandled promise rejection into a fatal abort (SIGTRAP) — e.g. a best-effort cache
// write that fails under file-descriptor pressure during a vault rescan of a large imported
// deck. A presentation tool must never hard-crash on a stray async error, so log and swallow;
// genuine bugs still surface in the log. (The specific offenders are also guarded at source.)
// Swallowing keeps the app alive, but a console the user never sees makes any real crash
// undiagnosable — and a SILENTLY swallowed uncaughtException can leave corrupt state that later
// traps natively (SIGTRAP). So also APPEND every main-process error to a log file on disk with a
// full stack, so the next occurrence is diagnosable from the user's machine (2026-07-19, after a
// SIGTRAP on delete whose symbolicated stack was unusable).
function logMainError(kind: string, err: unknown): void {
  try { console.error(`[main] ${kind}:`, err) } catch {}
  try {
    const e = err as Error
    const line = `\n[${new Date().toISOString()}] ${kind}: ${e?.stack || e?.message || String(err)}\n`
    const dir = app.getPath('userData')
    appendFileSync(join(dir, 'tw-main-errors.log'), line)
  } catch {
    // app not ready yet, or disk unavailable — the console.error above still fired.
  }
}
process.on('unhandledRejection', (reason) => { logMainError('unhandledRejection', reason) })
process.on('uncaughtException', (error) => { logMainError('uncaughtException', error) })

// Custom schemes must be registered as privileged BEFORE app ready so the renderer
// treats twasset:// and twthumb:// as standard secure schemes (CSP matching,
// no mixed-content blocking). The file handlers themselves are registered in whenReady.
protocol.registerSchemesAsPrivileged([
  { scheme: 'twasset', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: 'twthumb', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  // Serves read-only image files out of the old-PowerPoint archive (twarchive://<b64url>).
  { scheme: 'twarchive', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  // Serves local image files referenced by path in an outline (twfile://f/<b64url>), guarded
  // to the vault root. Lets the editor preview path-based images from the dev http origin too.
  { scheme: 'twfile', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  // Serves a recorded Session's local audio (twrec://<sessionId>) to Studio's <audio>. `stream`
  // enables Range requests so the player can seek/scrub without downloading the whole file.
  { scheme: 'twrec', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  // Serves the compiled present HTML and sibling assets for Studio replay iframes.
  { scheme: 'twpresent', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])
import { pathToFileURL } from 'url'
import { homedir, hostname, tmpdir } from 'os'
import { canonicalOutlinePath, editorEntryForOutline, outlineIdentity, type EditorWindowEntry } from './outline-identity'
import {
  configureTalkWriter, emptyOverNonemptyMessage, flushTalkForPublish, isStructurallyEmptyOutline, readTalkOutline, withTalkFileLock, writeTalkOutline,
  type EditorBuffer, type TalkWriteOptions, type TalkWriteOrigin,
} from './talk-writer'
import { createOutlineDiskGuard } from './outline-disk-guard'
import { createOutlineRecovery } from './outline-recovery'
import { createDirectoryWatcherRegistry } from './talkTextWatchers'
import type { OutlineDiskChange } from '../shared/outline-disk-change'
import { type Dirent, existsSync, readdirSync, statSync, readFileSync, writeFileSync, mkdirSync, realpathSync, cpSync, rmSync, renameSync, createReadStream, mkdtempSync, openSync, readSync, closeSync, appendFileSync, watch } from 'fs'
import { createHash, randomBytes } from 'crypto'
import { execFile, execFileSync, spawn, type ChildProcessByStdio } from 'child_process'
import type { Readable } from 'stream'
import { resolve as resolvePath, sep as pathSep, relative as relativePath } from 'path'
import { renderThumbnails } from './thumbnails'
import { createVariantThumbnailHandler, createVariantThumbnailRenderer, mediaFingerprint } from './layout-variant-thumbnail'
import { resolveThumbFile } from './thumb-key-resolution'
import {
  abstractPath,
  assetSidecarPath,
  createFolderTarget,
  deleteFolderTarget,
  moveTalkTargets,
  newTalkFolder,
  outlineRefusal,
  outlineSaveRefusal,
  renameFolderTargets,
  setRootRefusal,
  siblingTalkFolder,
  talkFolderOfOutline,
  thumbCacheDir
} from './vault-paths'
import { pathStaysInside } from './path-containment'
import { resolveImageRefs } from './image-refs'
import { isSearchIndexEntryFresh } from './search-index-freshness'
import { sweepOrphanedThumbCaches } from './thumbnail-cache-gc'
import { createPreparationRoute, createPreparedTalkCache, memoiseUntilFailure, preparedTalkGroup, type PreparationLane } from './prepared-talk-cache'
import { createSingleFlight } from './single-flight'
import {
  BROWSER_THUMBNAIL_LANE,
  THUMBNAIL_HEAP_WAIT_MAX_MS,
  heapGuardDecision,
  thumbnailMediaOptions,
  waitForHeap
} from './thumbnail-media-policy'
import { createAppendLog } from './main-log'
import {
  contentHashForPrerender,
  loadPrerenderLedger,
  recordSuccessfulPrerender,
  savePrerenderLedger,
  shouldPrerenderTalk
} from './prerender-ledger'
import { createVaultListHandler } from './vault-list-handler.mjs'
import { createBackupSweep } from './backup-sweep.mjs'
import {
  loadScope, recordAppEdit, recordAppOpen, recordBackup, setEnrolled, enrolledSlugs,
  appEditedTalks, expireStale, enrolmentDecision, applyEnrolmentChoice, talksNeedingLaunchBackup,
  AUTO_ENROL_LIMIT, SAVE_DEBOUNCE_MS, type BackupScopeState
} from './backup-scope.mjs'
import { pickOutlineName, scanTalkFoldersSync } from './talk-scan.mjs'
import { createConflictScanner, resolveByRealRoot } from './conflict-copies.mjs'
import { createVaultMachines } from './vault-machines'
import { createTalkActivity } from './talk-activity'
import { createConflictCompare } from './conflict-compare'
import { createTalkSearch, handleTalkSearchRequest } from './talk-search'
import { emptyTalkSearchResult, mergeTalkSearchResults } from '../shared/talk-search'
import { createTalkFolderStateStore, type StoredFolderStates } from './talk-folder-state'
import { createVaultRegistry, resolveInVaults, type Vault, type VaultPersonal } from './vault-registry'
import { viewVaults, refusalMessage, serviceFor, type AddVaultOutcome, type VaultService } from './vault-view'
import { createVaultAvailability, nodeAvailabilityProbe, SERVICE_APPS, mkdirBelowRoot, writableRoot, type LastGood } from './vault-availability'
import { createVaultFileStore, fileText } from './vault-file'
import { registerVaultSettingsIpc, refusalOutcome, talkFolderRelOf } from './vault-settings-ipc'
import { resolveNewTalkDefaults } from '../shared/vault-defaults'
import { pathsInVault, pathsOutsideOpenVaults, searchVaults } from './vault-scope'
import { VAULTS_DIR, adoptLegacyThumbDirs, isPlainSegment, parseThumbUrl, talkThumbDir, thumbLookupDirs, thumbUrl, touchNamespace } from './thumb-cache-dirs'
import { createConfigFile, type ConfigFile } from './config-file'
import {
  createSlidePreviewStore,
  markSlidePreviewHtml,
  slidePreviewIdFromUrl,
  slidePreviewUrl,
  selectedThumbnailSlide,
  thumbnailSlides
} from '../shared/slide-preview'
import { readFile as readFileAsync, readdir as readdirAsync } from 'fs/promises'
import {
  setupRecordingPermissions,
  registerRecordingIpc,
  registerRecordingContext,
  unregisterRecordingContext,
  shouldOfferRunSave,
  recordingAudioArmed,
  recordingRunReference,
  sendRecordingCloseOffer,
  recordingAudioPath
} from './recording'
import { registerHistoryIpc } from './history'
import {
  DEFAULT_TRANSCRIPTION_PYTHON,
  DEFAULT_TRANSCRIPTION_SCRIPT,
  registerTranscriptionIpc
} from './transcription'
import { registerTalkTextIpc } from './talkTextIpc'
import { registeredKeyNames, openVocabularyFrontmatterKeys, METADATA_REGISTRY } from '../shared/metadata-registry'
import {
  applyMetadataDefaults,
  normaliseMetadataDefaults,
  type MetadataDefaults
} from '../shared/metadata-surfaces'
import { editFrontmatterText, parseFrontmatterPairs } from '../shared/frontmatter-editor'
import { extractSection, type SectionLocation } from '../shared/insert-section'
import { commandElectronAccelerator, menuCommands } from '../shared/command-registry'
import { actionBarVisibleFrom } from '../shared/action-bar-settings'
import {
  LAYOUT_DOCTOR_VOCABULARY,
  scanOutlineTriggers,
  unresolvedOutboundFailure,
  unresolvedTriggerBlock,
  type LayoutDoctorFinding
} from '../shared/layout-doctor'
import { DEFAULT_IMPORTER_SETTINGS, type ImporterSettings } from '../shared/importer'
import { registerImporterIpc } from './importer/ipc'
import { vocabularyFromTagLists } from '../shared/tags'
import {
  createPathwayInManifest,
  deletePathwayInManifest,
  injectPathwayRuntime,
  invalidatePathwaySummary,
  readPathwayManifest,
  readPathwaySummary,
  renamePathwayInManifest,
  resolvePathways,
  setPathwaySlideIdsInManifest,
  injectPresenterNotice,
  presentStartOutsidePrework,
  withoutPresenterSlides,
  writePathwayManifest,
  type PathwaySlideRow
} from './pathways'
import {
  clearRunHandoutUrl,
  injectRunCoverMetadata,
  persistRun,
  preworkWindow,
  readRun,
  readRunForTalk,
  runHandoutSlug,
  setRunHandoutUrl,
  type RunRecord
} from './runs'
import {
  checkPreconditions,
  resolveBase,
  publishUrl,
  augmentedPath,
  readHandoutUrl,
  recoverIdFromUrl,
  generateShortId,
  pickShortId,
  buildRedirects,
  stampHandoutUrl
} from './publishing-logic'
import { isTerminalLiveStatus, type LiveStatus } from './live-presenter-client'
import { createLiveSessionManager } from './live-session-manager'
import { createLiveSessionStore, type SessionRecoveryRecord } from './live-session-store'
import { closeLiveBoardsLeftOpen, flushLiveSessionHistory, recoverFinalLiveHistory } from './live-session-history'
import { registerRunBoardIpc } from './run-board-ipc'
import { createRunResultsShares } from './run-results-share'
import { seedPollForRun, withoutSeed } from './run-prework-seed'
import { answerPreworkTrayQuestion, isPreworkQuestionId, preworkTrayForSession } from './prework-tray'
import type { PollDefinition } from '../../worker/protocol'
import type { PreworkFeed } from '../../compiler/scripts/lib/prework.mjs'
import { createRunPrework, registerRunPreworkIpc, startRunPreworkTimer, type RunPreworkService } from './run-prework'
import { preworkWindowMs, publicPreworkForm, withoutPreworkSlides, type CompiledPrework, type HandoutPreworkConfig } from '../shared/run-prework'
import { LIVE_WORKER_BUILD, supportsCurrentLiveWorker } from '../../worker/recovery-protocol'
import { fitInstantImage } from './instant-image'
import { decodeToWebp, storePastedImage } from './pasted-image-asset'
import { prepareCrossVaultInsert, type CrossVaultTools, type SlideOrigin } from './cross-vault-insert'
import { createProvenanceStore, originHintsFor } from './provenance-store'
import {
  addRunInstantSlide, fileOutlineDocument, loadOutlineTools, OutlineRefusal, resolveInstantAnchors,
  type OutlineDocument, type OutlineTools
} from './instant-slide-insert'
import { changeNoun, INSTANT_SLIDE_ORIGIN, type EditorDocumentReply, type EditorDocumentRequestBody } from '../shared/editor-document'
import { resolveLiveWorkerCloudflareToken } from './live-worker-cloudflare-token'
import { createSharedTalks, readRevisionSnapshot, type SharedTalks } from './shared-talk'
import { createFeedbackMirror } from './feedback-mirror'
import { createSharedTalkFeedback, type SharedTalkFeedback } from './shared-talk-feedback'
import { parseAcceptRecord, type FeedbackStatus } from '../shared/feedback'
// What the rail may set: Done, Dismiss, Accept (with the splice it made, for Undo) and back to new
// (Undo). Every status reaches the Worker from here, never from the renderer.
const RAIL_STATUSES: readonly FeedbackStatus[] = ['done', 'dismissed', 'accepted', 'new']
import { buildSharedTalkPayload, ownerNameFrom } from './shared-talk-build'
import { stampShareUrl } from '../shared/handout-stamp'
import { isValidShareDomain } from '../shared/shared-talk'
import { deckWindowKeyAction, deckWindowMode, OPEN_AUDIENCE_SCRIPT } from './deck-window-keys'
import { isPresenterBoardMessage, parsePresenterMessage, parseSlideLightbox } from '../../worker/protocol'
import { viewerPageHtml } from './handout-viewer-page'
import { preworkEnabled } from '../shared/prework-flag'

const slidePreviewStore = createSlidePreviewStore(8)

// Simple JSON config — avoids ESM/CJS issues with electron-store
type Config = {
  // Vault list (several vaults, ticket 01). Owned by the VaultRegistry (src/main/vault-registry.ts):
  // nothing else reads `vaultRoot` or `vaults`. `vaultRoot` stays as a mirror of the first open vault
  // so older builds on the same user-data dir still find it; `vaultRootMirrored` lets the registry
  // tell its own mirror from a root an older build (or a test harness) wrote.
  vaultRoot?: string
  vaults?: Vault[]
  vaultRootMirrored?: string
  // Personal per-vault settings (several-vaults ticket 04): vault id → author, badge colour, badge
  // initial. "Just for me" in Edit this vault; never written into a vault.
  vaultPersonal?: Record<string, VaultPersonal>
  // The name and service each vault had when it was last reachable (ticket 07), so a vault that is
  // unavailable at launch keeps its name. Local to this Mac, never written into a vault.
  vaultLastSeen?: Record<string, LastGood>
  windowBounds?: { x?: number; y?: number; width: number; height: number }
  toolsWindowBounds?: { x?: number; y?: number; width: number; height: number }
  pathwayWindowBounds?: { x?: number; y?: number; width: number; height: number }
  archiveRoot?: string
  // Cloudflare Pages publishing (Settings → Publishing). NON-SECRET config only — the API token is
  // stored separately, OS-keychain-encrypted, via safeStorage ({userData}/cf-pages-token.bin),
  // NEVER in this file.
  cfAccountId?: string
  cfPagesProject?: string
  publishBaseUrl?: string // optional custom domain, e.g. https://handouts.example.com
  liveWorkerBaseUrl?: string // deployed Worker origin; empty means auto-deploy or local wrangler dev
  liveWorkerVersion?: string // LIVE_WORKER_VERSION last deployed to liveWorkerBaseUrl; mismatch → re-deploy
  // Share for comments: the host colleagues' links use (ticket 07 sets https://drafts.handouts.fyi once
  // the Worker has that route). Empty = the Worker origin serves shares at /shares/<id>.
  sharedTalkLinkBase?: string
  publishUseShortIds?: boolean // <base>/<id> links instead of <base>/<slug>/
  publishSiteDir?: string // advanced override; default {userData}/cloudflare-pages-site
  publishProdBranch?: string // advanced override; default 'main'
  // Presentation backup (a "present from anywhere" safety net): periodically write each Talk's
  // full self-contained presenter HTML to a folder the user puts inside OneDrive/Dropbox, so a
  // forgotten laptop never blocks presenting. TalkWeaver only writes files; the sync client syncs.
  // Opt-in (default off) background OCR of vault images for image-text search (SCALE policy, 2026-07-20).
  ocrEnabled?: boolean
  backupEnabled?: boolean
  backupFolder?: string
  backupIntervalMin?: number
  // Presenter clock amber/dark-amber thresholds (Task 3 — Settings → Timer). Whole minutes before
  // the deadline; a deck's own frontmatter `warn-at:`/`urgent-at:` overrides these per-talk.
  timerWarnAtMinutes?: number
  timerUrgentAtMinutes?: number
  // Presentation recording (ADR-0035). A run shorter than this is auto-discarded as an accidental
  // open (Settings → Recording). The R2 destination is Settings-configurable; the access keys are
  // NEVER in this file — 'settings' keys are OS-keychain-encrypted via safeStorage
  // ({userData}/recording-r2-creds.bin), 'bws' resolves them from Bitwarden Secrets at upload time.
  recordingDiscardMs?: number
  recordingR2Endpoint?: string
  recordingR2Bucket?: string
  recordingR2CredsSource?: 'bws' | 'settings'
  recordingR2BwsSecretId?: string
  // Transcription engine (Settings -> Transcription). Non-secret local paths to Dominik's
  // speech-to-text skill; defaults are expanded at runtime so config.json stays portable.
  transcriptionPython?: string
  transcriptionScript?: string
  transcriptionFfmpeg?: string
  importerSettings?: ImporterSettings
  // Presenter identity and deck defaults (Ticket 9b — Settings). One map of metadata-registry key
  // → the value to pre-fill into NEW talks, so the author line, affiliation, licence and house
  // style are not retyped per talk. Only registry keys marked `defaultable` are ever stored, and
  // a blank default is deleted rather than kept as an empty string. Applying a default NEVER
  // overwrites an authored value except on an explicit click in Deck settings.
  metadataDefaults?: MetadataDefaults
  // Action bar (ADR-0025): one app-wide visibility flag, OFF until switched on in Settings, plus
  // the bar's ordered button list (command ids with '|' separator tokens). Only the default
  // populates the list today — the configure sheet is a later parcel. Both are read tolerantly on
  // the renderer side (src/shared/action-bar-settings.ts); a malformed list falls back to the
  // default rather than breaking the bar.
  actionBarVisible?: boolean
  actionBarItems?: string[]
  // Talks browser folders left open or closed (ADR-0029 §3): vault root → vault-relative folder
  // path → open. Only the user's choices; read tolerantly (src/main/talk-folder-state.ts).
  talkListFolders?: StoredFolderStates
}
function configPath() {
  return join(app.getPath('userData'), 'config.json')
}
// Atomic (temp file + rename, config-file.ts): a crash mid-write leaves the old config.json, never a
// truncated one that reads back as {} and loses the vault list.
function configFile(): ConfigFile<Config> {
  return createConfigFile<Config>(configPath())
}
function readConfig(): Config {
  return configFile().read()
}
function writeConfig(patch: Partial<Config>) {
  configFile().write(patch)
}
function getConfig<K extends keyof Config>(key: K, fallback: Config[K]): Config[K] {
  return readConfig()[key] ?? fallback
}

// ── Vaults ────────────────────────────────────────────────────────────────────
// Every main-process vault lookup goes through the registry. Until vault-scoped handlers take a
// vaultId (later several-vaults tickets), vault-wide work uses the first open vault, and talk-scoped
// work resolves the vault from the talk's path. With one vault both are that vault.
// The vault file (<root>/.talkweaver/vault.json) is read for names, ids and defaults, and written
// only by Create vault and Edit this vault › Save (ticket 04).
const vaultFiles = createVaultFileStore()
const vaultRegistry = createVaultRegistry({ read: () => readConfig(), write: (patch) => writeConfig(patch), realpath: (p) => realpathSync(p), files: vaultFiles })
// Availability (ticket 07): whether each open vault's folder answers, checked asynchronously with a
// timeout and throttled (vault-availability.ts). An unavailable vault is skipped by every vault-wide
// lookup below and refused by every write (invariant 5); the answer is a cache, so a write also looks
// at the folder right before it (writableRoot / mkdirBelowRoot): a moved vault folder is never
// re-created.
const vaultServiceProbe = { home: homedir(), exists: (p: string) => existsSync(p), realpath: (p: string) => realpathSync(p) }
const vaultAvailability = createVaultAvailability({
  probe: nodeAvailabilityProbe(homedir()),
  serviceOf: (root) => serviceFor(root, vaultServiceProbe),
  serviceFromPath: (root) => serviceFor(root, { home: homedir(), exists: () => false }),
  readLastGood: () => readConfig().vaultLastSeen,
  writeLastGood: (all) => writeConfig({ vaultLastSeen: all })
})
const rootFs = {
  isDirectory: (p: string): boolean => { try { return statSync(p).isDirectory() } catch { return false } },
  mkdir: (p: string): void => { mkdirSync(p, { recursive: true }) }
}
/** An open vault whose folder answered the last check (or has not been checked yet). */
function vaultAvailable(v: Vault | null | undefined): v is Vault {
  return !!v && v.open && !vaultAvailability.isUnavailable(v.id)
}
/** The open vaults whose folders are there: what is scanned, indexed and searched. */
function availableVaults(): Vault[] {
  return vaultRegistry.list().filter(vaultAvailable)
}
/** The first open vault whose folder is there (the single-vault shims' vault), or null. */
function primaryVault(): Vault | null {
  return availableVaults()[0] ?? null
}
/** Root of the first open, available vault (what vault:get-root answers), or undefined when none.
 *  Goes when vault-wide handlers take a vaultId. */
function currentVaultRoot(): string | undefined {
  return primaryVault()?.root
}
/** Root of the open vault holding absPath; undefined when that vault is unavailable; a path in no
 *  open vault falls back to the current vault. */
function vaultRootFor(absPath: string | null | undefined): string | undefined {
  const hit = typeof absPath === 'string' && absPath ? vaultRegistry.resolve(absPath) : null
  if (hit && hit.vault.open) return vaultAvailable(hit.vault) ? hit.vault.root : undefined
  return currentVaultRoot()
}
/** vaultRootFor for a write: a path in no open vault falls back to writableVaultRoot(), never to the
 *  next available vault. */
function writableTalkRoot(absPath: string | null | undefined): string | undefined {
  const hit = typeof absPath === 'string' && absPath ? vaultRegistry.resolve(absPath) : null
  if (hit && hit.vault.open) return vaultAvailable(hit.vault) ? writableRoot(hit.vault.root, rootFs) ?? undefined : undefined
  return writableVaultRoot()
}
/** The current vault's root for a write: the FIRST OPEN vault, and only while its folder is there.
 *  When that vault is unavailable the write is refused, never re-targeted to the next vault (reads
 *  and lists skip to the next available vault through currentVaultRoot()). */
function writableVaultRoot(): string | undefined {
  const first = vaultRegistry.primary()
  if (!first || vaultAvailability.isUnavailable(first.id)) return undefined
  return writableRoot(first.root, rootFs) ?? undefined
}
/** The root of the vault holding absPath for a write (see vaultRootFor): only when it is there now. */
function writableRootFor(absPath: string | null | undefined): string | undefined {
  return writableTalkRoot(absPath)
}
/** Create dir below root (never root itself or above it, and only while root is there). */
function mkdirInVault(root: string, dir: string): void {
  if (!existsSync(dir)) mkdirBelowRoot(root, dir, rootFs)
}
/** This person's author name for the vault holding absPath ('' when none is set). */
function vaultPersonalAuthor(absPath: string | null | undefined): string {
  const id = vaultIdOf(absPath)
  return id ? vaultRegistry.personal(id).author ?? '' : ''
}
/** The vault whose root is exactly root (open or closed), or null. */
function vaultOfRoot(root: string | null | undefined): Vault | null {
  const hit = typeof root === 'string' && root ? vaultRegistry.resolve(root) : null
  return hit && hit.rel === '' ? hit.vault : null
}
/** Id of the vault holding absPath (open or closed), or null for a path in no vault. */
function vaultIdOf(absPath: string | null | undefined): string | null {
  return typeof absPath === 'string' && absPath ? vaultRegistry.resolve(absPath)?.vault.id ?? null : null
}

/** Root of the open vault named by vaultId; the current vault when no id is given; undefined for an
 *  unknown, closed or unavailable vault. The vault-wide folder handlers take an optional vault id this way. */
function rootOfVault(vaultId: unknown): string | undefined {
  if (typeof vaultId !== 'string' || !vaultId) return currentVaultRoot()
  const vault = vaultRegistry.get(vaultId)
  return vaultAvailable(vault) ? vault.root : undefined
}
/** rootOfVault for a write: only when the folder is there right now; with no id, the current vault
 *  as writableVaultRoot() binds it (refused while the first open vault is unavailable). */
function writableRootOfVault(vaultId: unknown): string | undefined {
  if (typeof vaultId !== 'string' || !vaultId) return writableVaultRoot()
  return writableRoot(rootOfVault(vaultId), rootFs) ?? undefined
}

// Vault list changes (Add vault, open/close, a set-root, and a root an older build chose that the
// registry adopts on read) reach the caches here. A new first open vault is today's "change vault":
// the whole slide-text cache and the talk caches go and the warm pass restarts, as vault:set-root
// has always done. Any other change drops only slide text of talks in no open vault.
let lastPrimaryRoot: string | null | undefined
let vaultWarmTimer: ReturnType<typeof setTimeout> | null = null
function onVaultsChanged(vaults: Vault[]): void {
  const primaryRoot = vaults.find((v) => vaultAvailable(v))?.root ?? null
  if (primaryRoot !== lastPrimaryRoot) searchCache.clear()
  else for (const key of pathsOutsideOpenVaults(searchCache.keys(), vaults)) searchCache.delete(key)
  lastPrimaryRoot = primaryRoot
  invalidateTalkCache()
  scheduleVaultWarm()
}
/** One warm pass 200 ms after the last vault change (a set-root also emits a registry change). */
function scheduleVaultWarm(): void {
  if (vaultWarmTimer) clearTimeout(vaultWarmTimer)
  vaultWarmTimer = setTimeout(() => { vaultWarmTimer = null; warmSearchIndex().catch(() => {}) }, 200)
}
vaultRegistry.onChange(onVaultsChanged)

registerImporterIpc({
  ipcMain,
  dialog,
  shell,
  platform: process.platform,
  getVaultRoot: () => writableVaultRoot() ?? null, // imports write talks: only into a vault folder that is there
  getSettings: () => getConfig('importerSettings', DEFAULT_IMPORTER_SETTINGS) ?? DEFAULT_IMPORTER_SETTINGS,
  setSettings: (settings) => writeConfig({ importerSettings: settings }),
  resourcesDir: app.isPackaged ? join(process.resourcesPath, 'agent-import') : join(process.cwd(), 'resources', 'agent-import'),
  onVaultChanged: () => invalidateTalkCache()
})
// Window drags fire resize/move continuously, and each writeConfig is a synchronous
// read+rewrite of config.json on the main process — jank for the whole drag. Coalesce to a
// single write after the drag settles. Callers must guard against a destroyed window.
function debouncedConfigWrite(read: () => Partial<Config>): () => void {
  let timer: NodeJS.Timeout | null = null
  return () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      try { writeConfig(read()) } catch { /* window gone mid-debounce */ }
    }, 500)
  }
}
function expandHomePath(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

// ── Cloudflare publishing: secure token storage (safeStorage / OS keychain) ──────────────────
// The API token is NEVER stored in config.json. It is encrypted with the OS keychain and written
// to its own blob; only a hasToken boolean is ever exposed to the renderer.
function tokenBlobPath(): string {
  return join(app.getPath('userData'), 'cf-pages-token.bin')
}
function tokenExists(): boolean {
  return existsSync(tokenBlobPath())
}
function readToken(): string | null {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null
    if (!tokenExists()) return null
    return safeStorage.decryptString(readFileSync(tokenBlobPath()))
  } catch {
    return null
  }
}

// Share link domain (ticket 07): Settings shows and takes a bare hostname ("drafts.handouts.fyi");
// the share module and the live-Worker deploy both want it as a full origin, so config keeps the
// one canonical value (`sharedTalkLinkBase`) and this pair converts at the Settings boundary only.
// `hostname` throughout, never `.host` (which can carry a port isValidShareDomain must refuse).
function shareDomainFromLinkBase(): string {
  const base = getConfig('sharedTalkLinkBase', undefined)
  if (!base) return ''
  try { return new URL(base).hostname } catch { return '' }
}

ipcMain.handle('publish:get-config', () => ({
  accountId: getConfig('cfAccountId', undefined) ?? '',
  project: getConfig('cfPagesProject', undefined) ?? '',
  baseUrl: getConfig('publishBaseUrl', undefined) ?? '',
  workerBaseUrl: getConfig('liveWorkerBaseUrl', undefined) ?? '',
  useShortIds: getConfig('publishUseShortIds', false) ?? false,
  shareDomain: shareDomainFromLinkBase(),
  hasToken: tokenExists()
}))

ipcMain.handle(
  'publish:set-config',
  (_event, cfg: { accountId?: string; project?: string; baseUrl?: string; workerBaseUrl?: string; useShortIds?: boolean; shareDomain?: string }):
    { success: true } | { success: false; error: string } => {
    const hostnameInput = (cfg.shareDomain || '').trim().toLowerCase()
    if (hostnameInput && !isValidShareDomain(hostnameInput)) {
      return {
        success: false,
        error: 'Share link domain must be a bare hostname, like drafts.example.com — no https://, port, path, space, wildcard, IP address or localhost.'
      }
    }
    const nextLinkBase = hostnameInput ? `https://${hostnameInput}` : undefined
    const previousLinkBase = getConfig('sharedTalkLinkBase', undefined)
    writeConfig({
      cfAccountId: (cfg.accountId || '').trim() || undefined,
      cfPagesProject: (cfg.project || '').trim() || undefined,
      publishBaseUrl: (cfg.baseUrl || '').trim() || undefined,
      liveWorkerBaseUrl: (cfg.workerBaseUrl || '').trim().replace(/\/+$/, '') || undefined,
      publishUseShortIds: !!cfg.useShortIds,
      sharedTalkLinkBase: nextLinkBase,
      // A domain set, changed or cleared means the deployed Worker's route no longer matches
      // Settings — mark the deploy stale so ensureLiveWorker redeploys before the next share link
      // is issued, rather than a colleague's link 404ing until some unrelated redeploy catches up.
      ...(nextLinkBase !== previousLinkBase ? { liveWorkerVersion: undefined } : {})
    })
    return { success: true }
  }
)

function attachLiveWindow(wcId: number) {
  const context = livePresenterContexts.get(wcId)
  if (context) liveSessions?.attach(wcId, context.talkSlug, (currentVaultRoot() ?? null))
  liveSessions?.bindRun(wcId, recordingRunReference(wcId))
  return liveSessions?.record(wcId) ?? null
}

ipcMain.handle('live:go', async (event) => {
  const wcId = event.sender.id
  const context = livePresenterContexts.get(wcId)
  if (!context) return { success: false, error: 'Live sessions are available in the presenter window only.' }
  try {
    if (!liveSessions || !liveRecoveryStore) throw new Error('Secure live session recovery is unavailable. Restart TalkWeaver to retry.')
    liveRecoveryStore.check()
    const existing = attachLiveWindow(wcId)
    if (existing && !isTerminalLiveStatus(existing.status)) return { success: true, ...liveSessions.snapshot(wcId) }
    if (liveSessions.inUse(context.talkSlug, (currentVaultRoot() ?? null), wcId)) throw new Error('This talk is already live in another presenter window. Close that presentation and keep it live before reopening it here.')
    if (!context.shortUrl) throw new Error('Publish or export this handout before going live.')
    const endpoint = await ensureLiveWorker()
    const capabilityResponse = await fetch(`${endpoint.baseUrl}/capabilities`, { signal: AbortSignal.timeout(10_000) })
    const capabilities = capabilityResponse.ok ? await capabilityResponse.json() as { protocol?: number; build?: string } : null
    if (!supportsCurrentLiveWorker(capabilities)) throw new Error('The live service needs updating before you can go live.')
    const joinUrl = await ensureLiveJoinUrl(context)
    const compilerDir = getCompilerPath()
    if (!compilerDir) throw new Error('Compiler not found.')
    const { makeQrSvg } = await import(pathToFileURL(join(compilerDir, 'lib/01-cli-utils.mjs')).href)
    const qrSvg = String(makeQrSvg(joinUrl) || '')
    const response = await fetch(`${endpoint.baseUrl}/sessions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${endpoint.adminSecret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ talkSlug: context.talkSlug }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error(await liveHttpError(response, 'Could not create a live session.'))
    const created = await response.json() as { sessionId: string; presenterToken: string; shortId: string; expiresAt: number }
    if (!created.sessionId || !created.presenterToken || !created.shortId || !Number.isFinite(created.expiresAt)) throw new Error('The live service returned an incomplete session.')
    const record: SessionRecoveryRecord = {
      ...created, baseUrl: endpoint.baseUrl, shortUrl: joinUrl, qrSvg,
      talkSlug: context.talkSlug, vaultRoot: (currentVaultRoot() ?? null),
      status: 'connecting', startedAtMs: Date.now(), endRequested: false,
      latest: null, pending: [], polls: [], voteRecords: [], cursor: 0,
    }
    liveSessions.detach(wcId)
    liveSessions.create(record, wcId)
    liveSessions.bindRun(wcId, recordingRunReference(wcId))
    return { success: true, ...liveSessions.snapshot(wcId) }
  } catch (cause) {
    return { success: false, error: cause instanceof Error ? cause.message : String(cause) }
  }
})

// Feedback-boards ticket 06 (D20): the boards still open in this window's session, so End live can
// ask whether to close them or keep them open for late cards.
ipcMain.handle('live:open-boards', (event) => {
  attachLiveWindow(event.sender.id)
  return liveSessions?.openBoards(event.sender.id) ?? []
})
ipcMain.handle('live:end', async (event, options: unknown) => {
  try {
    attachLiveWindow(event.sender.id)
    const keepBoardsOpen = !!options && typeof options === 'object' && (options as { keepBoardsOpen?: unknown }).keepBoardsOpen === true
    return await liveSessions?.end(event.sender.id, { keepBoardsOpen }) ?? { success: true, status: 'ended' }
  } catch (cause) {
    return { success: false, error: cause instanceof Error ? cause.message : String(cause) }
  }
})
ipcMain.handle('live:snapshot', (event) => {
  const record = attachLiveWindow(event.sender.id)
  const snapshot = liveSessions?.snapshot(event.sender.id) ?? null
  // The Run's pre-work questions put in the talk's questions ride beside the phones' (never sent to the Worker).
  return snapshot ? { ...snapshot, preworkQuestions: preworkEnabled() ? preworkTrayForSession(currentVaultRoot() ?? null, record) : [] } : null
})
ipcMain.handle('live:status', (event): LiveStatus => attachLiveWindow(event.sender.id)?.status ?? 'ended')
ipcMain.on('live:publish-slide', (event, state: { slideId?: string; reveal?: number; focus?: unknown; lightbox?: unknown; talkQr?: unknown }) => {
  if (!state || typeof state.slideId !== 'string' || !Number.isInteger(state.reveal) || Number(state.reveal) < 0) return
  const focus = state.focus == null ? null : state.focus as { kind: 'reveal' | 'focus'; step: number }
  if (focus && ((focus.kind !== 'reveal' && focus.kind !== 'focus') || !Number.isInteger(focus.step) || focus.step < 0)) return
  const lightbox = state.lightbox === undefined ? undefined : parseSlideLightbox(state.lightbox)
  if (state.lightbox !== undefined && !lightbox) return
  if (state.talkQr !== undefined && typeof state.talkQr !== 'boolean') return
  try {
    attachLiveWindow(event.sender.id)
    liveSessions?.publish(event.sender.id, { slideId: state.slideId, reveal: Number(state.reveal), focus,
      ...(lightbox ? { lightbox } : {}), ...(state.talkQr ? { talkQr: true } : {}) })
  } catch { event.sender.send('live:status', 'paused-reconnecting') }
})
// A board slide fed by a pre-work step opens with the Run's picked answers (feedback-boards ticket 11);
// the glue is seedPollForRun. Only main adds a seed: a window's own is dropped in the live:poll-open handler.
function seedFromRunPrework(wcId: number, poll: PollDefinition): Promise<PollDefinition> {
  const outlinePath = presentWindows.get(wcId)?.outlinePath ?? null
  return seedPollForRun(poll, liveSessions?.record(wcId) ?? null, {
    vaultRoot: () => writableVaultRoot() ?? null, // writes: only a vault folder that is there (ticket 07)
    readOutline: () => (outlinePath ? readFileSync(outlinePath, 'utf8') : null),
    feeds: async (outline) => (outlinePath ? ((await prepareTalk(outlinePath, outline))?.model?.prework as { feeds?: PreworkFeed[] } | undefined)?.feeds ?? null : null),
  })
}
type LivePollMessage = NonNullable<ReturnType<typeof parsePresenterMessage>>
function parseLivePoll(wcId: number, value: unknown): { message: LivePollMessage } | { error: string } {
  attachLiveWindow(wcId)
  const message = parsePresenterMessage(JSON.stringify(value))
  // Board operations (message.type 'board.*') reach the worker through the presenter's board panel, not this route.
  if (!message || message.type === 'slide.publish' || message.type === 'question.answer' || message.type === 'switches.set'
    || isPresenterBoardMessage(message)) {
    return { error: 'Invalid poll control.' }
  }
  if (message.type === 'poll.open' && !message.poll.slideId) message.poll.slideId = liveSessions?.record(wcId)?.latest?.slideId
  return { message }
}
function queueLivePoll(wcId: number, value: unknown) {
  try {
    const parsed = parseLivePoll(wcId, value)
    if ('error' in parsed) return { success: false, error: parsed.error }
    return liveSessions?.poll(wcId, parsed.message as never) ?? { success: false, error: 'No live session.' }
  } catch (cause) { return { success: false, error: cause instanceof Error ? cause.message : String(cause) } }
}
// Opening a poll: a board slide fed by a pre-work step opens with the Run's answers. A window may not put
// cards on a board, so any `seed` it sends is dropped first; only main adds one.
ipcMain.handle('live:poll-open', async (event, poll: unknown) => {
  try {
    const parsed = parseLivePoll(event.sender.id, { type: 'poll.open', poll })
    if ('error' in parsed) return { success: false, error: parsed.error }
    const message = parsed.message
    if (message.type === 'poll.open') message.poll = await seedFromRunPrework(event.sender.id, withoutSeed(message.poll))
    return liveSessions?.poll(event.sender.id, message as never) ?? { success: false, error: 'No live session.' }
  } catch (cause) { return { success: false, error: cause instanceof Error ? cause.message : String(cause) } }
})
ipcMain.handle('live:poll-close', (event, pollId: unknown) => queueLivePoll(event.sender.id, { type: 'poll.close', pollId }))
ipcMain.handle('live:poll-reveal', (event, pollId: unknown) => queueLivePoll(event.sender.id, { type: 'poll.reveal', pollId }))
ipcMain.handle('live:poll-hide', (event, pollId: unknown, responseId: unknown, hidden: unknown) => queueLivePoll(event.sender.id, { type: 'poll.hide', pollId, responseId, hidden }))
// The presenter's board panel (feedback-boards ticket 05): one board operation, checked with the
// worker's own parser, through the same acknowledged operation queue as the poll controls. Only a
// presenter window may send one.
ipcMain.handle('live:board-action', (event, value: unknown) => {
  try {
    attachLiveWindow(event.sender.id)
    if (!livePresenterContexts.has(event.sender.id)) return { success: false, error: 'The board is sorted in the presenter window only.' }
    const message = parsePresenterMessage(JSON.stringify(value))
    if (!message || !isPresenterBoardMessage(message)) return { success: false, error: 'Invalid board operation.' }
    return liveSessions?.poll(event.sender.id, message) ?? { success: false, error: 'No live session.' }
  } catch (cause) { return { success: false, error: cause instanceof Error ? cause.message : String(cause) } }
})
ipcMain.handle('live:question-answer', (event, questionId: unknown, answered: unknown) => {
  try {
    attachLiveWindow(event.sender.id)
    if (!livePresenterContexts.has(event.sender.id)) return { success: false, error: 'Questions are answered in the presenter window only.' }
    // A pre-work question in the tray belongs to the Run: the mark is written there and never reaches the Worker.
    if (isPreworkQuestionId(questionId)) {
      const result = answerPreworkTrayQuestion(writableVaultRoot() ?? null, liveSessions?.record(event.sender.id) ?? null, questionId, answered !== false)
      if (result.success) event.sender.send('live:prework-questions', result.questions)
      return result.success ? { success: true, status: 'confirmed' as const } : { success: false, status: 'rejected' as const, error: result.error }
    }
    const message = parsePresenterMessage(JSON.stringify({ type: 'question.answer', questionId, answered }))
    if (!message || message.type !== 'question.answer') return { success: false, error: 'Invalid question.' }
    return liveSessions?.poll(event.sender.id, message) ?? { success: false, error: 'No live session.' }
  } catch (cause) { return { success: false, error: cause instanceof Error ? cause.message : String(cause) } }
})
ipcMain.handle('live:switches', (event, patch: unknown) => {
  try {
    attachLiveWindow(event.sender.id)
    if (!livePresenterContexts.has(event.sender.id)) return { success: false, error: 'The phone switches belong to the presenter window.' }
    const { questionsAllowed, reactionsAllowed } = (patch && typeof patch === 'object' ? patch : {}) as { questionsAllowed?: unknown; reactionsAllowed?: unknown }
    const message = parsePresenterMessage(JSON.stringify({ type: 'switches.set',
      ...(typeof questionsAllowed === 'boolean' ? { questionsAllowed } : {}), ...(typeof reactionsAllowed === 'boolean' ? { reactionsAllowed } : {}) }))
    if (!message || message.type !== 'switches.set') return { success: false, error: 'Invalid switch.' }
    return liveSessions?.poll(event.sender.id, message) ?? { success: false, error: 'No live session.' }
  } catch (cause) { return { success: false, error: cause instanceof Error ? cause.message : String(cause) } }
})
ipcMain.handle('live:instant-action', async (event, action: unknown) => {
  const wcId = event.sender.id
  if (!livePresenterContexts.has(wcId)) return { success: false, error: 'Instant slides are available in the presenter window only.' }
  const candidate = action && typeof action === 'object' ? { ...(action as Record<string, unknown>) } : {}
  if (candidate.type === 'instant.show' && candidate.slide && typeof candidate.slide === 'object') {
    const slide = { ...(candidate.slide as Record<string, unknown>) }
    if (slide.kind === 'link' && typeof slide.url === 'string') {
      try {
        const url = new URL(slide.url)
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only web links can be shown.')
        const compilerDir = getCompilerPath()
        if (!compilerDir) throw new Error('Compiler not found.')
        const { makeQrSvg } = await import(pathToFileURL(join(compilerDir, 'lib/01-cli-utils.mjs')).href)
        slide.qrSvg = String(makeQrSvg(slide.url) || '')
      } catch (error) { return { success: false, error: error instanceof Error ? error.message : 'Invalid link.' } }
    }
    candidate.slide = slide
  }
  const message = parsePresenterMessage(JSON.stringify(candidate))
  if (!message || (message.type !== 'instant.show' && message.type !== 'instant.clear')) return { success: false, error: 'Invalid instant slide.' }
  const result = liveSessions?.poll(wcId, message) ?? { success: false, error: 'No live session.' }
  return !result.success && message.type === 'instant.show' ? { ...result, slide: message.slide } : result
})
ipcMain.handle('live:fit-instant-image', async (event, bytes: Uint8Array) => {
  if (!livePresenterContexts.has(event.sender.id)) return { success: false, error: 'Open the presenter window to show an image.' }
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > 50_000_000) return { success: false, error: 'This image is too large to process. Try a smaller screenshot.' }
  return fitInstantImage(bytes)
})

ipcMain.handle('publish:set-token', (_event, token: string) => {
  if (!safeStorage.isEncryptionAvailable()) {
    return { success: false, error: 'OS keychain encryption unavailable; cannot store the token securely.' }
  }
  const t = (token || '').trim()
  if (!t) return { success: false, error: 'Empty token.' }
  try {
    writeFileSync(tokenBlobPath(), safeStorage.encryptString(t))
    return { success: true }
  } catch (e) {
    return { success: false, error: String(e) }
  }
})

ipcMain.handle('publish:clear-token', () => {
  try {
    if (tokenExists()) rmSync(tokenBlobPath())
  } catch {
    /* ignore */
  }
  return { success: true }
})

// ── Recording storage (Settings → Recording) — R2 destination + access keys ──
// Mirrors the publishing-config pattern: non-secret config in config.json; the R2 access keys go
// to their own safeStorage blob and are NEVER returned to the renderer (only a hasKeys boolean).
function r2CredsBlobPath(): string {
  return join(app.getPath('userData'), 'recording-r2-creds.bin')
}
function r2KeysExist(): boolean {
  return existsSync(r2CredsBlobPath())
}
function readR2Keys(): { accessKeyId: string; secretAccessKey: string } | null {
  try {
    if (!safeStorage.isEncryptionAvailable() || !r2KeysExist()) return null
    const parsed = JSON.parse(safeStorage.decryptString(readFileSync(r2CredsBlobPath()))) as {
      accessKeyId?: string
      secretAccessKey?: string
    }
    if (parsed.accessKeyId && parsed.secretAccessKey) {
      return { accessKeyId: parsed.accessKeyId, secretAccessKey: parsed.secretAccessKey }
    }
    return null
  } catch {
    return null
  }
}

ipcMain.handle('recording:get-storage', () => ({
  endpoint: getConfig('recordingR2Endpoint', undefined) ?? '',
  bucket: getConfig('recordingR2Bucket', undefined) ?? '',
  credsSource: getConfig('recordingR2CredsSource', 'settings') ?? 'settings',
  bwsSecretId: getConfig('recordingR2BwsSecretId', undefined) ?? '',
  discardSeconds: Math.round((getConfig('recordingDiscardMs', 20000) ?? 20000) / 1000),
  hasKeys: r2KeysExist()
}))

ipcMain.handle(
  'recording:set-storage',
  (
    _event,
    cfg: {
      endpoint?: string
      bucket?: string
      credsSource?: 'bws' | 'settings'
      bwsSecretId?: string
      discardSeconds?: number
    }
  ) => {
    writeConfig({
      recordingR2Endpoint: (cfg.endpoint || '').trim() || undefined,
      recordingR2Bucket: (cfg.bucket || '').trim() || undefined,
      recordingR2CredsSource: cfg.credsSource === 'bws' ? 'bws' : 'settings',
      recordingR2BwsSecretId: (cfg.bwsSecretId || '').trim() || undefined,
      recordingDiscardMs: Number.isFinite(cfg.discardSeconds)
        ? Math.max(0, Math.round((cfg.discardSeconds as number) * 1000))
        : undefined
    })
    return { success: true }
  }
)

ipcMain.handle('recording:set-keys', (_event, keys: { accessKeyId?: string; secretAccessKey?: string }) => {
  if (!safeStorage.isEncryptionAvailable()) {
    return { success: false, error: 'OS keychain encryption unavailable; cannot store the keys securely.' }
  }
  const accessKeyId = (keys.accessKeyId || '').trim()
  const secretAccessKey = (keys.secretAccessKey || '').trim()
  if (!accessKeyId || !secretAccessKey) return { success: false, error: 'Both an access key id and secret are required.' }
  try {
    writeFileSync(r2CredsBlobPath(), safeStorage.encryptString(JSON.stringify({ accessKeyId, secretAccessKey })))
    return { success: true }
  } catch (e) {
    return { success: false, error: String(e) }
  }
})

ipcMain.handle('recording:clear-keys', () => {
  try {
    if (r2KeysExist()) rmSync(r2CredsBlobPath())
  } catch {
    /* ignore */
  }
  return { success: true }
})

// ── Transcription engine (Settings → Transcription) ─────────────────────────
// Non-secret local paths only. Runtime callers receive expanded paths; Settings also receives the
// unexpanded defaults so it can show exactly what the machine convention is.
function transcriptionSettings(): { python: string; script: string; ffmpeg: string; defaultPython: string; defaultScript: string } {
  return {
    python: getConfig('transcriptionPython', undefined) ?? DEFAULT_TRANSCRIPTION_PYTHON,
    script: getConfig('transcriptionScript', undefined) ?? DEFAULT_TRANSCRIPTION_SCRIPT,
    ffmpeg: getConfig('transcriptionFfmpeg', undefined) ?? '',
    defaultPython: DEFAULT_TRANSCRIPTION_PYTHON,
    defaultScript: DEFAULT_TRANSCRIPTION_SCRIPT
  }
}

ipcMain.handle('settings:get-transcription', () => transcriptionSettings())

ipcMain.handle('settings:set-transcription', (_event, cfg: { python?: string; script?: string; ffmpeg?: string }) => {
  writeConfig({
    transcriptionPython: (cfg.python || '').trim() || undefined,
    transcriptionScript: (cfg.script || '').trim() || undefined,
    transcriptionFfmpeg: (cfg.ffmpeg || '').trim() || undefined
  })
  return transcriptionSettings()
})

function createWindow(): BrowserWindow {
  const bounds = getConfig('windowBounds', { width: 1400, height: 900 })

  const win = new BrowserWindow({
    ...bounds,
    ...(E2E ? { show: false } : {}),
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#f7f3ea',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      ...(E2E ? { backgroundThrottling: false } : {})
    }
  })

  // Cascade a second/third window so it doesn't stack exactly on the first (⌘N, two talks at once).
  if (editorWindows.size > 0) {
    const [x, y] = win.getPosition()
    const step = 32 * editorWindows.size
    win.setPosition(x + step, y + step)
  }

  win.on('resize', debouncedConfigWrite(() => {
    if (win.isDestroyed()) return {}
    const [width, height] = win.getSize()
    return { windowBounds: { width, height } }
  }))

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // Track every editor window + the talk it currently has active (renderer reports via
  // window:claim-talk). Deck ⌘E/⌘R target the window whose active talk matches; mainWindow is the
  // last-focused editor window, used as the fallback target and by app:activate. Capture the
  // webContents id NOW — in 'closed' the webContents is already destroyed, so reading win.webContents
  // there throws "Object has been destroyed" and aborts app quit (this crashed ⌘Q in 0.9.11).
  const wcId = win.webContents.id
  editorWindows.set(wcId, { win, outlinePath: null })
  mainWindow = win
  win.on('focus', () => {
    mainWindow = win
    // External-change guard: a sync client can change the file without a watcher event reaching us
    // (network folders, files on demand); coming back to the window is a natural moment to look.
    const open = editorWindows.get(wcId)?.outlinePath
    if (open) void outlineDiskGuard.check(open).catch(() => undefined)
  })
  // External-change guard: while this window's talk differs from its file on disk (the bar is up), a
  // close — the window's own, or one ⌘Q asks for — waits for the person's choice. The renderer shows
  // the same sheet as a talk switch (Reload / Keep mine / Stay here) and calls window:confirm-close
  // once the choice has completed; Stay here leaves the window (and cancels the quit).
  // If the renderer does not acknowledge the request within 5 s (hung, crashed), main lets the close go
  // ahead after writing the recovery copy from the last text the editor tried to save.
  win.on('close', (event) => {
    const pending = outlineDiskGuard.pendingFor(String(wcId))
    if (closeConfirmed.has(wcId) || !pending) return
    event.preventDefault()
    const quit = quitting
    quitting = false // this quit is cancelled until the person chooses (it resumes via confirm-close)
    clearTimeout(closeHolds.get(wcId))
    closeHolds.set(wcId, setTimeout(() => {
      closeHolds.delete(wcId)
      if (win.isDestroyed()) return
      const real = canonicalOutlinePath(pending.outlinePath)
      const text = lastUnsavedText.get(real)
      console.warn(`[outline-guard] the window did not answer the close request within 5 s; closing it${text !== undefined ? ' after keeping its unsaved text in a recovery copy' : ''} (${pending.outlinePath})`)
      const finish = (): void => {
        closeConfirmed.add(wcId)
        if (quit) app.quit()
        else if (!win.isDestroyed()) win.close()
      }
      if (text === undefined) { finish(); return }
      outlineRecovery.save(real, text).catch((e) => console.error('[outline-recovery] save', e)).finally(finish)
    }, 5000))
    try { win.webContents.send('outline:close-requested', { quit }) } catch { /* destroyed: the timer closes it */ }
  })
  win.on('closed', () => {
    clearTimeout(closeHolds.get(wcId))
    closeHolds.delete(wcId)
    closeConfirmed.delete(wcId)
    outlineDiskGuard.release(String(wcId))
    editorWindows.delete(wcId)
    if (mainWindow === win) mainWindow = editorWindows.size ? [...editorWindows.values()][0].win : null
  })

  return win
}

// Editor windows and the talk each currently has active (outlinePath), so a deck's ⌘E/⌘R targets the
// RIGHT window and the same-talk guard can block opening one talk in two windows. mainWindow is the
// last-focused editor window (fallback target + activate). Every "same talk" comparison is by file
// identity (outline-identity.ts), resolved at the comparison, so an alias or a replaced inode matches.
const editorWindows = new Map<number, EditorWindowEntry<BrowserWindow>>()
const liveWindow = (win: BrowserWindow): boolean => !win.isDestroyed()
// The editor window, other than `except`, whose open talk is the same file as `outlinePath`.
function otherEditorHolding(outlinePath: string, except: BrowserWindow | undefined): BrowserWindow | null {
  return editorEntryForOutline(editorWindows.values(), outlinePath, liveWindow, except)?.win ?? null
}
let mainWindow: BrowserWindow | null = null

// The editor window currently showing `outlinePath` (a deck's ⌘E/⌘R target), else the last-focused
// editor window, else any. Never returns a destroyed window.
function targetEditorFor(outlinePath: string | null): BrowserWindow | null {
  if (outlinePath) {
    const holder = otherEditorHolding(outlinePath, undefined)
    if (holder) return holder
  }
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow
  for (const { win } of editorWindows.values()) if (!win.isDestroyed()) return win
  return null
}

function installApplicationMenu(): void {
  const customMenus = new Map<string, MenuItemConstructorOptions[]>()
  for (const command of menuCommands()) {
    const menuName = command.menu?.path[0]
    if (!menuName) continue
    const items = customMenus.get(menuName) ?? []
    items.push({
      label: command.label,
      accelerator: commandElectronAccelerator(command),
      click: () => targetEditorFor(null)?.webContents.send('app:command', command.handlerId)
    })
    customMenus.set(menuName, items)
  }
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    // File menu: the OS-standard role PLUS a discoverable "New Window" (⌘N). New Window is driven
    // from MAIN so it opens a window regardless of which surface has focus, and is prepended so it
    // reads first. Working on two presentations at once (2026-07-19).
    {
      label: 'File',
      submenu: [
        { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: () => { createWindow() } },
        { type: 'separator' },
        { role: 'close' }
      ]
    },
    { role: 'editMenu' },
    ...[...customMenus].map(([label, submenu]) => ({ label, submenu })),
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// Live deck windows opened by talk:present, so ⌘R (refresh-in-place) can recompile the right talk
// and reload the deck at its current slide. wcId → { outlinePath, mode }.
const presentWindows = new Map<number, { outlinePath: string; mode: string; pathwayId?: string }>()
const livePresenterContexts = new Map<number, { talkSlug: string; shortUrl: string | null }>()
let liveSessions: ReturnType<typeof createLiveSessionManager> | null = null
let liveRecoveryStore: ReturnType<typeof createLiveSessionStore> | null = null

async function probeLiveSession(record: SessionRecoveryRecord): Promise<LiveStatus | null> {
  if (record.expiresAt <= Date.now()) return 'expired'
  const response = await fetch(`${record.baseUrl}/sessions/${encodeURIComponent(record.sessionId)}/status`, {
    headers: { authorization: `Bearer ${record.presenterToken}` }, signal: AbortSignal.timeout(10_000),
  })
  if (response.status === 401 || response.status === 403) return 'authentication-failed'
  if (response.status === 404) return 'ended'
  if (!response.ok) return null
  const result = await response.json() as { protocol?: number; status?: string }
  if (result.protocol !== 2) return 'incompatible'
  return result.status === 'ended' || result.status === 'expired' ? result.status : null
}
async function closeLiveWorkerSession(record: SessionRecoveryRecord): Promise<'ended' | 'expired'> {
  if (record.expiresAt <= Date.now()) return 'expired'
  // End live's answer about boards still open travels with every retry (ticket 06).
  const response = await fetch(`${record.baseUrl}/sessions/${encodeURIComponent(record.sessionId)}/close`, {
    method: 'POST', headers: { authorization: `Bearer ${record.presenterToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ keepBoardsOpen: record.keepBoardsOpen === true }), signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok && response.status !== 404) throw new Error('Could not confirm that the live session has ended.')
  return 'ended'
}
function initialiseLiveSessions() {
  try {
    liveRecoveryStore = createLiveSessionStore(join(app.getPath('userData'), 'live-sessions.enc'), safeStorage)
    liveSessions = createLiveSessionManager({
      load: () => liveRecoveryStore!.load(), save: (records) => liveRecoveryStore!.save(records),
      endRemote: closeLiveWorkerSession, probe: probeLiveSession,
      recoverFinal: (record, afterReactionSequence) => recoverFinalLiveHistory(record, afterReactionSequence),
      closeBoards: (record) => closeLiveBoardsLeftOpen(record),
      notify: (id, channel, value) => {
        const win = BrowserWindow.getAllWindows().find((item) => item.webContents.id === id)
        if (win && !win.isDestroyed()) win.webContents.send(channel, value)
      },
      flushHistory: flushLiveSessionHistory,
      diagnostic: (event) => console.info('[live-recovery]', JSON.stringify(event)),
    })
    liveSessions.restore()
    powerMonitor.on('resume', () => liveSessions?.reconnect())
    powerMonitor.on('unlock-screen', () => liveSessions?.reconnect())
  } catch { console.error('[live-recovery] Secure recovery store unavailable; live session creation is disabled.') }
}

// Bumped on every deck reload and appended as a ?_r= cache-buster: reloading to the exact same
// file:// URL + #hash is a same-document no-op in Chromium (the recompiled file never re-reads), so a
// distinct URL each time forces a real navigation that picks up the fresh HTML.
let presentReloadNonce = 0

// ⌘R in a deck window: recompile from the EDITOR's live content (so an unsaved fix is included) and
// reload the deck at its current slide. Refuses while a recording is armed (a reload would drop it).
// The actual recompile+reload happens in the present:rebuild handler after the editor hands back its
// current content — this only reads the deck's state and asks the editor for it.
async function refreshDeckFromEditor(win: BrowserWindow): Promise<void> {
  const info = presentWindows.get(win.webContents.id)
  if (!info) return
  // The recorder UI stamps its state onto #twrec-module[data-rec]; read it (+ the current slide id)
  // straight from the deck's DOM — no cross-process recorder state needed.
  let state: { slideId: string; rec: string } = { slideId: '', rec: '' }
  try {
    state = await win.webContents.executeJavaScript(
      "({ slideId: location.hash.startsWith('#') ? decodeURIComponent(location.hash.slice(1)) : '', rec: ((document.getElementById('twrec-module')||{}).dataset||{}).rec || '' })"
    )
  } catch { /* fall through with empty state — refresh from the top */ }
  if (state.rec && state.rec !== 'idle' && state.rec !== 'saved' && state.rec !== 'error') {
    win.webContents.send('present:hint', 'Stop the recording before refreshing (⇧R) — a reload would drop it.')
    return
  }
  const editor = targetEditorFor(info.outlinePath)
  if (!editor || editor.isDestroyed()) {
    win.webContents.send('present:hint', 'Open TalkWeaver to refresh this deck.')
    return
  }
  editor.webContents.send('present:refresh', { outlinePath: info.outlinePath, slideId: state.slideId, deckWcId: win.webContents.id })
}

type ToolsView = 'studio' | 'history' | 'pathways' | 'talktext' | 'importer'
type PathwayWindowContext = { outlinePath: string; talkSlug: string; talkTitle: string }
let toolsWindow: BrowserWindow | null = null
let talkTextIpcController: ReturnType<typeof registerTalkTextIpc> | null = null
let pathwayWindow: BrowserWindow | null = null
let pathwayWindowContext: PathwayWindowContext | null = null

function isToolsView(view: unknown): view is Exclude<ToolsView, 'pathways'> {
  return view === 'studio' || view === 'history' || view === 'talktext' || view === 'importer'
}

function loadRenderer(win: BrowserWindow, view?: ToolsView): void {
  if (process.env['ELECTRON_RENDERER_URL']) {
    const url = new URL(process.env['ELECTRON_RENDERER_URL'])
    if (view) url.searchParams.set('view', view)
    void win.loadURL(url.toString())
  } else if (view) {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { query: { view } })
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function sendToolsShow(win: BrowserWindow, view: ToolsView, sessionId?: string, pathway?: PathwayWindowContext): void {
  const payload = { view, sessionId: sessionId || undefined, pathway }
  const send = (): void => {
    if (!win.isDestroyed()) win.webContents.send('tools:show', payload)
  }
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send)
  else send()
}

function createToolsWindow(view: ToolsView, sessionId?: string): BrowserWindow {
  const bounds = getConfig('toolsWindowBounds', { width: 1400, height: 900 })
  const win = new BrowserWindow({
    ...bounds,
    ...(E2E ? { show: false } : {}),
    minWidth: 1000,
    minHeight: 680,
    title: 'TalkWeaver Tools',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#f7f3ea',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      ...(E2E ? { backgroundThrottling: false } : {})
    }
  })

  const persistBounds = debouncedConfigWrite(() =>
    win.isDestroyed() ? {} : { toolsWindowBounds: win.getBounds() }
  )
  win.on('resize', persistBounds)
  win.on('move', persistBounds)
  win.on('closed', () => {
    talkTextIpcController?.releaseAllWatchers()
    if (toolsWindow === win) toolsWindow = null
  })

  toolsWindow = win
  loadRenderer(win, view)
  sendToolsShow(win, view, sessionId)
  return win
}

function openToolsWindow(view: ToolsView, sessionId?: string): void {
  const existing = toolsWindow && !toolsWindow.isDestroyed() ? toolsWindow : null
  const win = existing ?? createToolsWindow(view, sessionId)
  if (win.isMinimized()) win.restore()
  win.focus()
  if (existing) sendToolsShow(win, view, sessionId)
}

ipcMain.handle('tools:open', (_event, view: unknown, sessionId?: string) => {
  if (!isToolsView(view)) return { success: false, error: 'Unknown Tools view.' }
  openToolsWindow(view, sessionId)
  return { success: true }
})

function openPathwayWindow(context: PathwayWindowContext): void {
  const existing = pathwayWindow && !pathwayWindow.isDestroyed() ? pathwayWindow : null
  const win = existing ?? new BrowserWindow({
    ...getConfig('pathwayWindowBounds', { width: 1240, height: 820 }),
    ...(E2E ? { show: false } : {}),
    minWidth: 960,
    minHeight: 620,
    title: 'TalkWeaver Pathways',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#f7f3ea',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      ...(E2E ? { backgroundThrottling: false } : {})
    }
  })
  if (!existing) {
    const persistBounds = debouncedConfigWrite(() =>
      win.isDestroyed() ? {} : { pathwayWindowBounds: win.getBounds() }
    )
    win.on('resize', persistBounds)
    win.on('move', persistBounds)
    win.on('focus', () => {
      if (pathwayWindowContext) notifyPathwaysChanged(pathwayWindowContext.outlinePath)
    })
    win.on('closed', () => {
      if (pathwayWindow === win) {
        pathwayWindow = null
        pathwayWindowContext = null
      }
    })
    pathwayWindow = win
    loadRenderer(win, 'pathways')
  }
  pathwayWindowContext = context
  if (win.isMinimized()) win.restore()
  win.focus()
  sendToolsShow(win, 'pathways', undefined, context)
}

function notifyPathwaysChanged(outlinePath: string): void {
  if (
    !pathwayWindow ||
    pathwayWindow.isDestroyed() ||
    pathwayWindowContext?.outlinePath !== outlinePath
  ) return
  pathwayWindow.webContents.send('pathways:changed', { outlinePath })
}

function notifyTalkMetaUpdated(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    try { win.webContents.send('vault:talk-meta-updated') } catch { /* window closing */ }
  }
}

ipcMain.handle('tools:open-pathways', (_event, context: PathwayWindowContext) => {
  if (!context || typeof context.outlinePath !== 'string' || typeof context.talkSlug !== 'string' || typeof context.talkTitle !== 'string') {
    return { success: false, error: 'Invalid Pathway window context.' }
  }
  openPathwayWindow(context)
  return { success: true }
})

// ── Vault IPC ──────────────────────────────────────────────────────────────

// vault:get-root / set-root / choose-root are single-vault shims over the registry (several vaults,
// ticket 01): get answers the first open vault; set and choose make the folder the first open vault
// (reusing its id when it is already a vault) and close the previous one — today's "change vault".
ipcMain.handle('vault:get-root', () => currentVaultRoot() ?? null)

// Test-only (TW_E2E=1): the vault root bounds every containment guard, so a renderer-supplied
// root is refused in the app itself (no config write); Settings and first-run setup use
// vault:choose-root, a dialog in the main process. In test mode the folder must be an existing
// absolute directory, and it is adopted through the vault registry.
ipcMain.handle('vault:set-root', (_event, path: string) => {
  const refusal = setRootRefusal(E2E, path)
  if (refusal) {
    console.warn('[vault:set-root] refused:', refusal)
    return { success: false, error: refusal }
  }
  vaultRegistry.adoptRoot(path)
  searchCache.clear()
  invalidateTalkCache()
  scheduleVaultWarm()
  return { success: true }
})

ipcMain.handle('vault:choose-root', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Choose Vault Root',
    message: 'Select the folder containing your Talk folders',
    properties: ['openDirectory']
  })
  if (result.canceled || !result.filePaths.length) return null
  const chosen = result.filePaths[0]
  vaultRegistry.adoptRoot(chosen)
  searchCache.clear()
  invalidateTalkCache()
  scheduleVaultWarm()
  return chosen
})

// The Talks panel's vault list (ticket 03): every vault, open or closed, with a name, badge and
// service label derived locally. Adding checks the folder here; the registry refuses nesting and
// duplicates. A path argument skips the folder picker only under TW_E2E; otherwise the picker is
// always used.
const vaultProbe = vaultServiceProbe
// The vault file of each vault, as last read while its folder answered (ticket 07): views built for a
// single field (a name for a provenance line, a service for Open settings) never touch the disk.
// vault:list re-reads the files of available vaults; a registry change drops the cache.
const vaultFileCache = new Map<string, ReturnType<typeof vaultFiles.read>>()
vaultRegistry.onChange((vaults) => {
  vaultFileCache.clear()
  const known = readConfig().vaultLastSeen ?? {}
  for (const id of Object.keys(known)) if (!vaults.some((v) => v.id === id)) vaultAvailability.forget(id)
})
/** Every vault as the panel shows it. fresh: re-read the vault files of available vaults (vault:list);
 *  otherwise the cached reads (no disk for a vault already read). An unavailable vault is never read:
 *  it keeps the name and service it had when it was last reachable. */
const vaultViews = (opts: { fresh?: boolean } = {}) => {
  const vaults = vaultRegistry.list()
  const fileOf = (v: Vault): ReturnType<typeof vaultFiles.read> | null => {
    if (!v.open || vaultAvailability.isUnavailable(v.id)) return vaultFileCache.get(v.id) ?? null
    if (!opts.fresh && vaultFileCache.has(v.id)) return vaultFileCache.get(v.id)!
    const read = vaultFiles.read(v.root)
    vaultFileCache.set(v.id, read)
    return read
  }
  const views = viewVaults(vaults, vaultProbe, (v) => {
    const first = vaultRegistry.duplicateOf(v.id)
    const duplicateOf = first ? { id: first.id, name: basename(first.root) } : null // withDisplayNames names it as the panel does
    const personal = vaultRegistry.personal(v.id)
    const unavailable = v.open ? vaultAvailability.status(v.id) : null
    const service = vaultAvailability.service(v)
    if (unavailable) {
      const kept = vaultAvailability.lastGood(v.id)
      return { file: vaultFileCache.get(v.id) ?? null, name: kept?.name ?? undefined, personal, duplicateOf, unavailable, service: kept?.service ?? service }
    }
    return { file: fileOf(v), personal, duplicateOf, unavailable: null, service }
  })
  for (const view of views) {
    if (view.open && !view.unavailable) vaultAvailability.remember(view.id, { name: view.baseName, service: view.service })
  }
  return views
}
/** Check the open vaults' folders (throttled unless forced). A change reaches the caches, the warm
 *  pass and every window's vault list. */
async function checkVaultAvailability(force = false): Promise<boolean> {
  const changed = await vaultAvailability.check(vaultRegistry.list(), { force })
  if (changed) {
    invalidateTalkCache()
    scheduleVaultWarm()
    // Every window re-reads its vault list (a vault went away or came back), whoever asked.
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        if (win.isDestroyed()) continue
        win.webContents.send('vault:vaults-changed')
        win.webContents.send('vault:talk-meta-updated')
      } catch { /* window closing */ }
    }
  }
  return changed
}
// vault:list waits for the (asynchronous, time-limited) folder check; it never stats a folder itself.
ipcMain.handle('vault:list', async () => {
  await checkVaultAvailability().catch(() => false)
  return vaultViews({ fresh: true })
})
// The unavailable section's "Check again": look at every open vault's folder now.
ipcMain.handle('vault:recheck', () => checkVaultAvailability(true).catch(() => false))
// ⋯ › Reveal in Finder (ticket 07): the folder comes from the registry by vault id, never from the
// renderer. An unknown id, or a folder that is not there, is refused.
ipcMain.handle('vault:reveal', (_event, vaultId: unknown): { ok: boolean; reason?: 'unknown-vault' | 'unavailable' } => {
  const vault = typeof vaultId === 'string' ? vaultRegistry.get(vaultId) : null
  if (!vault) return { ok: false, reason: 'unknown-vault' }
  if (vaultAvailability.isUnavailable(vault.id)) return { ok: false, reason: 'unavailable' }
  shell.showItemInFolder(vault.root)
  return { ok: true }
})
// The unavailable section's one action when the cloud service is not signed in: open that service's
// app (a fixed list of apps, never a renderer-supplied path).
ipcMain.handle('vault:open-service', async (_event, vaultId: unknown): Promise<boolean> => {
  const vault = typeof vaultId === 'string' ? vaultRegistry.get(vaultId) : null
  if (!vault) return false
  const service = vaultAvailability.lastGood(vault.id)?.service ?? vaultAvailability.service(vault)
  const app = SERVICE_APPS[service]
  if (!app || !existsSync(app)) return false
  return (await shell.openPath(app)) === ''
})
registerVaultSettingsIpc({
  ipcMain,
  dialog,
  windowOf: (sender) => BrowserWindow.fromWebContents(sender),
  registry: vaultRegistry,
  views: vaultViews,
  probe: vaultProbe,
  appAuthor: () => String(metadataDefaults().author ?? ''),
  appDefaults: () => metadataDefaults(),
  e2e: E2E
})

ipcMain.handle('vault:add', async (event, path?: unknown): Promise<AddVaultOutcome | null> => {
  let chosen: string
  if (E2E && typeof path === 'string' && path) chosen = path
  else {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      title: 'Add a vault',
      message: 'Choose the folder that holds the talks',
      properties: ['openDirectory', 'createDirectory']
    }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths.length) return null
    chosen = result.filePaths[0]
  }
  try {
    if (!statSync(chosen).isDirectory()) return { ok: false, reason: 'not-a-folder', message: refusalMessage('not-a-folder', null) }
  } catch {
    return { ok: false, reason: 'not-a-folder', message: refusalMessage('not-a-folder', null) }
  }
  try {
    const added = vaultRegistry.add(chosen)
    const view = vaultViews().find((v) => v.id === added.id)
    return view ? { ok: true, vault: view } : null
  } catch (error) {
    return refusalOutcome(error, vaultViews)
  }
})

// Open or close one vault. Closing hides its talks everywhere; nothing in the folder changes. The
// last open vault stays open (the app needs a vault to work in).
ipcMain.handle('vault:set-open', (_event, vaultId: unknown, open: unknown): AddVaultOutcome => {
  if (typeof vaultId !== 'string') return { ok: false, reason: 'unknown-vault', message: refusalMessage('unknown-vault', null) }
  try {
    if (open !== true && vaultRegistry.list().filter((v) => v.open && v.id !== vaultId).length === 0 && vaultRegistry.get(vaultId)?.open) {
      return { ok: false, reason: 'last-open', message: refusalMessage('last-open', null) }
    }
    vaultRegistry.setOpen(vaultId, open === true)
    const view = vaultViews().find((v) => v.id === vaultId)
    return view ? { ok: true, vault: view } : { ok: false, reason: 'unknown-vault', message: refusalMessage('unknown-vault', null) }
  } catch (error) {
    return refusalOutcome(error, vaultViews)
  }
})
vaultRegistry.onChange(() => {
  for (const win of BrowserWindow.getAllWindows()) {
    try { if (!win.isDestroyed()) win.webContents.send('vault:vaults-changed') } catch { /* window closing */ }
  }
})

// ── Settings IPC (folders the app reads from) ────────────────────────────────
// The Settings panel reads these to show the configured folders and let the user change them.
// archiveDefault is always null — the archive is config-only (no hardcoded fallback).
// detectArchiveRoot is declared lower in this file; these handlers run lazily (at call time,
// after the module is fully initialised) so the forward reference is safe.
ipcMain.handle('settings:get-paths', () => {
  const c = readConfig()
  return {
    vaultRoot: currentVaultRoot() ?? null,
    archiveRoot: c.archiveRoot ?? null,
    archiveDefault: null,
    archiveAvailable: detectArchiveRoot() != null
  }
})

ipcMain.handle('settings:choose-archive', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Choose Image Archive Root',
    message: 'Select the folder containing the old-PowerPoint image archive (registry/media.db)',
    properties: ['openDirectory']
  })
  if (result.canceled || !result.filePaths.length) return null
  const chosen = result.filePaths[0]
  writeConfig({ archiveRoot: chosen })
  searchCache.clear()
  invalidateTalkCache()
  return chosen
})

ipcMain.handle('settings:clear-archive', () => {
  const c = readConfig()
  delete c.archiveRoot
  configFile().replace(c)
  searchCache.clear()
  invalidateTalkCache()
  return null
})

// ── Presentation backup ──────────────────────────────────────────────────────
// Write every Talk's full self-contained presenter HTML (presenter view + speaker notes — the same
// artifact `Present` uses, NOT the presenter-stripped share export) to a user-chosen folder on a
// timer. The folder lives inside OneDrive/Dropbox, whose own client does the cloud sync — so this
// needs no logins or APIs. Files are named `<slug>-backup.html` so they can't be mistaken for
// originals, and only changed Talks are re-written (so the sync client isn't churned).
type BackupSkip = { slug: string; reason: string }
type BackupRun = {
  at: number
  ok: boolean
  exported: number
  skipped: number
  failed: number
  // Added by Ticket 11: which talks did NOT get a copy, and why. The counts alone could not say
  // whether a run that reported "3 saved" had quietly refused a fourth.
  skippedTalks: BackupSkip[]
  folder?: string
  error?: string
}
let lastBackup: BackupRun | null = null
let backupSweep: ReturnType<typeof createBackupSweep> | null = null
let enrolmentAskOpen = false
const backupDebounce = new Map<string, ReturnType<typeof setTimeout>>()

function backupStateFile(): string { return join(app.getPath('userData'), 'backup-state.json') }
function loadBackupScope(): BackupScopeState {
  try { return loadScope(JSON.parse(readFileSync(backupStateFile(), 'utf8'))) } catch { return loadScope(null) }
}
function saveBackupScope(state: BackupScopeState): void {
  try { writeFileSync(backupStateFile(), JSON.stringify(state), 'utf8') } catch { /* ignore */ }
}
function backupSlugFor(outlinePath: string): string {
  return basename(outlinePath).replace('-outline.md', '')
}
// The size the backup export would have to inline. Measured from the LOCAL assets folder, which is
// where the 208MB deck kept its thirteen videos.
function talkAssetsBytes(outlinePath: string): number {
  try {
    const assetsDir = join(dirname(outlinePath), 'assets')
    let total = 0
    for (const f of readdirSync(assetsDir)) { try { total += statSync(join(assetsDir, f)).size } catch { /* skip */ } }
    return total
  } catch { return 0 }
}
// Build a Talk's full self-contained HTML from its on-disk outline (same pipeline as present/build,
// but under the backup media budget — see BACKUP_EXPORT_MEDIA_OPTIONS).
async function buildTalkFullHtml(
  outlinePath: string,
  prepareSource: (...a: unknown[]) => Promise<{ [k: string]: unknown }>,
  mediaOptions: Record<string, unknown>
): Promise<string> {
  const stat = statSync(outlinePath)
  const slug = backupSlugFor(outlinePath)
  const content = readFileSync(outlinePath, 'utf8')
  const vaultRoot = vaultRootFor(outlinePath)
  const resolved = vaultRoot ? resolveImageRefs(content, vaultRoot) : content
  const model = await prepareSource(outlinePath, resolved, slug, stat, timerSettings(), mediaOptions)
  return String(model.fullHtml ?? '')
}

// Export exactly the talks handed in — never a vault scan (ADR-0024). The caller has already
// decided who is enrolled; this only compiles, writes and records.
async function runBackupFor(talks: Array<{ slug: string; outlinePath: string }>): Promise<BackupRun> {
  const folder = getConfig('backupFolder', undefined)
  const compilerDir = getCompilerPath()
  const empty = { at: Date.now(), ok: false, exported: 0, skipped: 0, failed: 0, skippedTalks: [] as BackupSkip[] }
  if (!folder) return (lastBackup = { ...empty, error: 'No backup folder set' })
  if (!compilerDir) return (lastBackup = { ...empty, error: 'No compiler' })
  if (!talks.length) return (lastBackup = { ...empty, ok: true, folder })
  const { prepareSource, BACKUP_EXPORT_MEDIA_OPTIONS } = await import(
    pathToFileURL(join(compilerDir, 'lib/08-source-adapters.mjs')).href
  )
  const state = loadBackupScope()
  backupSweep = createBackupSweep({
    assetBytesOf: talkAssetsBytes,
    buildHtml: (outlinePath: string) =>
      buildTalkFullHtml(outlinePath, prepareSource as never, BACKUP_EXPORT_MEDIA_OPTIONS),
    writeFile: (dest: string, html: string) => writeFileSync(dest, html, 'utf8'),
    destFor: (folderPath: string, slug: string) => join(folderPath, slug + '-backup.html'),
    ensureDir: (folderPath: string) => { if (!existsSync(folderPath)) mkdirSync(folderPath, { recursive: true }) },
    onExported: (slug: string) => { recordBackup(state, slug, Date.now()) },
    log: (line: string) => console.error(line)
  })
  lastBackup = await backupSweep.run({ folder, talks })
  saveBackupScope(state)
  try { BrowserWindow.getAllWindows()[0]?.webContents.send('backup:status', lastBackup) } catch { /* ignore */ }
  return lastBackup
}

// A save made IN THE APP — the only event that can enrol a talk (ADR-0024 §1). An outline whose
// mtime moved because of a migration, an importer, an agent or OneDrive never reaches here.
function noteAppEdit(outlinePath: string): void {
  if (!getConfig('backupEnabled', false)) return
  const slug = backupSlugFor(outlinePath)
  const state = loadBackupScope()
  recordAppEdit(state, { slug, title: slug, outlinePath, atMs: Date.now() })
  expireStale(state, Date.now())
  const decision = enrolmentDecision(appEditedTalks(state), enrolledSlugs(state))
  if (decision.kind === 'auto') {
    for (const s of decision.enrol) setEnrolled(state, s, true, Date.now())
    saveBackupScope(state)
  } else {
    saveBackupScope(state)
    void askEnrolment(decision)
  }
  if (loadBackupScope().talks[slug]?.enrolled) scheduleBackup(slug, outlinePath)
}

// Opening a talk keeps an enrolled talk alive against the 14-day expiry without enrolling it.
function noteAppOpen(outlinePath: string): void {
  if (!getConfig('backupEnabled', false)) return
  const state = loadBackupScope()
  recordAppOpen(state, { slug: backupSlugFor(outlinePath), title: backupSlugFor(outlinePath), outlinePath, atMs: Date.now() })
  saveBackupScope(state)
}

// Backup on save, debounced: he saves constantly, and a backup is a full compile.
function scheduleBackup(slug: string, outlinePath: string): void {
  const pending = backupDebounce.get(slug)
  if (pending) clearTimeout(pending)
  backupDebounce.set(slug, setTimeout(() => {
    backupDebounce.delete(slug)
    runBackupFor([{ slug, outlinePath }]).catch(() => {})
  }, SAVE_DEBOUNCE_MS))
}

// The third-talk question. Native message box — the same surface the app already uses for the
// outline-migration choice. It carries the candidate list and pre-selects the two most recently
// app-edited; per-talk ticking lives in Settings, which is where the set is managed.
async function askEnrolment(decision: { candidates: Array<{ slug: string; title: string; lastAppEditAt: number }>; defaults: string[] }): Promise<void> {
  if (enrolmentAskOpen) return
  enrolmentAskOpen = true
  try {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const lines = decision.candidates.map((c) => {
      const mark = decision.defaults.includes(c.slug) ? '✓' : '·'
      return `${mark} ${c.title} — last edited ${new Date(c.lastAppEditAt).toLocaleString()}`
    })
    const opts: Electron.MessageBoxOptions = {
      type: 'question',
      buttons: ['Back up these', 'Not now'],
      defaultId: 0,
      cancelId: 1,
      message: 'Back up the talks you are working on?',
      detail: `TalkWeaver keeps presentable copies of the ${AUTO_ENROL_LIMIT} talks you are working on.\n\n${lines.join('\n')}\n\nThe ticked talks will be backed up. Change the set any time in Settings.`
    }
    const { response } = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
    if (response !== 0) return
    const state = loadBackupScope()
    applyEnrolmentChoice(state, decision.defaults, Date.now())
    saveBackupScope(state)
    const due = talksNeedingLaunchBackup(state)
    if (due.length) await runBackupFor(due)
  } catch { /* a failed prompt must never break the save that triggered it */ }
  finally { enrolmentAskOpen = false }
}

// One pass at launch over the ENROLLED talks whose in-app edit is newer than their last backup —
// so a crash or a quit before the debounce elapsed still lands a copy. No vault scan, no timer.
async function runLaunchBackup(): Promise<BackupRun | null> {
  if (!getConfig('backupEnabled', false) || !getConfig('backupFolder', undefined)) return null
  const state = loadBackupScope()
  const dropped = expireStale(state, Date.now())
  if (dropped.length) saveBackupScope(state)
  const due = talksNeedingLaunchBackup(state)
  if (!due.length) return null
  return runBackupFor(due)
}

function backupSettings(): {
  enabled: boolean
  folder: string | null
  intervalMin: number
  lastRun: BackupRun | null
  talks: Array<{ slug: string; title: string; enrolled: boolean; lastAppEditAt: number; lastBackupAt: number }>
} {
  const state = loadBackupScope()
  return {
    enabled: getConfig('backupEnabled', false) ?? false,
    folder: getConfig('backupFolder', undefined) ?? null,
    intervalMin: getConfig('backupIntervalMin', 15) ?? 15,
    lastRun: lastBackup,
    talks: Object.entries(state.talks)
      .filter(([, r]) => r.enrolled || r.appEditedAt > 0)
      .sort((a, b) => b[1].appEditedAt - a[1].appEditedAt)
      .map(([slug, r]) => ({
        slug, title: r.title, enrolled: r.enrolled, lastAppEditAt: r.appEditedAt, lastBackupAt: r.lastBackupAt
      }))
  }
}

// ── Action bar (ADR-0025): one app-wide visibility setting + the stored button list ────────
// The renderer parses `items` tolerantly (missing/malformed → default), so the main process hands
// back the raw stored value untouched. A change is broadcast to EVERY window, so a toggle in one
// window's Settings redraws the bar in the others without a restart.
function actionBarState(): { visible: boolean; items: unknown } {
  const config = readConfig()
  return { visible: actionBarVisibleFrom(config.actionBarVisible), items: config.actionBarItems ?? null }
}
function broadcastActionBar(): void {
  const state = actionBarState()
  for (const win of BrowserWindow.getAllWindows()) {
    try { if (!win.isDestroyed()) win.webContents.send('action-bar:changed', state) } catch { /* window closing */ }
  }
}
ipcMain.handle('settings:get-action-bar', () => actionBarState())
ipcMain.handle('settings:set-action-bar-visible', (_event, visible: boolean) => {
  writeConfig({ actionBarVisible: visible === true })
  broadcastActionBar()
  return actionBarState().visible
})

ipcMain.handle('settings:get-backup', () => backupSettings())

ipcMain.handle('settings:set-backup', (_event, patch: { enabled?: boolean; intervalMin?: number }) => {
  const next: Partial<Config> = {}
  if (typeof patch.enabled === 'boolean') next.backupEnabled = patch.enabled
  if (Number.isFinite(patch.intervalMin)) next.backupIntervalMin = Math.max(5, Math.round(patch.intervalMin as number))
  writeConfig(next)
  // Turning it on backs up whatever is already enrolled and stale — it never scans the vault.
  if (getConfig('backupEnabled', false) && getConfig('backupFolder', undefined)) {
    setTimeout(() => { runLaunchBackup().catch(() => {}) }, 400)
  }
  return backupSettings()
})

ipcMain.handle('settings:choose-backup-folder', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Choose Backup Folder',
    message: 'Pick a folder inside your OneDrive/Dropbox — TalkWeaver saves presentable HTML backups there',
    properties: ['openDirectory', 'createDirectory']
  })
  if (result.canceled || !result.filePaths.length) return backupSettings()
  writeConfig({ backupFolder: result.filePaths[0] })
  if (getConfig('backupEnabled', false)) setTimeout(() => { runLaunchBackup().catch(() => {}) }, 400)
  return backupSettings()
})

ipcMain.handle('settings:clear-backup-folder', () => {
  const c = readConfig()
  delete c.backupFolder
  configFile().replace(c)
  return backupSettings()
})

// Presenter clock amber/dark-amber thresholds (Task 3): the Settings → Timer global default. A
// deck's frontmatter `warn-at:`/`urgent-at:` overrides this per-talk (resolved in the compiler).
function timerSettings(): { warnAtMinutes: number; urgentAtMinutes: number } {
  return {
    warnAtMinutes: getConfig('timerWarnAtMinutes', 5) ?? 5,
    urgentAtMinutes: getConfig('timerUrgentAtMinutes', 1) ?? 1
  }
}

ipcMain.handle('settings:get-timer', () => timerSettings())

ipcMain.handle('settings:set-timer', (_event, patch: { warnAtMinutes?: number; urgentAtMinutes?: number }) => {
  const next: Partial<Config> = {}
  if (Number.isFinite(patch.warnAtMinutes)) next.timerWarnAtMinutes = Math.max(1, Math.round(patch.warnAtMinutes as number))
  if (Number.isFinite(patch.urgentAtMinutes)) next.timerUrgentAtMinutes = Math.max(1, Math.round(patch.urgentAtMinutes as number))
  writeConfig(next)
  return timerSettings()
})

// ── Presenter identity and deck defaults (Ticket 9b) ─────────────────────────
// The SAME config.json the rest of Settings uses. The renderer renders the section from the
// metadata registry; this end only stores and sanitises.
function metadataDefaults(): MetadataDefaults {
  return normaliseMetadataDefaults(METADATA_REGISTRY, getConfig('metadataDefaults', {}) ?? {})
}

ipcMain.handle('settings:get-metadata-defaults', () => metadataDefaults())

ipcMain.handle('settings:set-metadata-defaults', (_event, patch: MetadataDefaults) => {
  writeConfig({ metadataDefaults: normaliseMetadataDefaults(METADATA_REGISTRY, { ...metadataDefaults(), ...(patch ?? {}) }) })
  return metadataDefaults()
})

// ── Settings changelog (Gate-5) ──────────────────────────────────────────────
// Every settings change is recorded (old → new, when) in a per-machine userData JSON log, so
// a tweak the user forgot making is one click to find — and to undo via the per-entry Reset
// in Settings → Changes. Values only, never secrets (the renderer logs those as presence).
type SettingsChangeEntry = { at: number; key: string; label: string; from: string; to: string }
function settingsChangelogFile(): string { return join(app.getPath('userData'), 'settings-changelog.json') }
function readSettingsChangelog(): SettingsChangeEntry[] {
  try {
    const raw = JSON.parse(readFileSync(settingsChangelogFile(), 'utf8'))
    return Array.isArray(raw) ? (raw as SettingsChangeEntry[]) : []
  } catch { return [] }
}
ipcMain.handle('settings:changelog-get', () => readSettingsChangelog())
ipcMain.handle('settings:changelog-log', (_event, entry: { key: string; label: string; from: string; to: string }) => {
  if (
    typeof entry?.key !== 'string' || typeof entry?.label !== 'string' ||
    typeof entry?.from !== 'string' || typeof entry?.to !== 'string'
  ) return readSettingsChangelog()
  const list = readSettingsChangelog()
  list.unshift({ at: Date.now(), key: entry.key, label: entry.label, from: entry.from, to: entry.to })
  const trimmed = list.slice(0, 200) // a per-machine audit trail, not an archive
  try { writeFileSync(settingsChangelogFile(), JSON.stringify(trimmed, null, 2), 'utf8') } catch { /* log-only */ }
  return trimmed
})

// Manual "Back up now" — force-exports every Talk regardless of change signature.
ipcMain.handle('backup:run-now', async () => {
  const state = loadBackupScope()
  const talks = enrolledSlugs(state).map((slug) => ({ slug, outlinePath: state.talks[slug].outlinePath }))
  return runBackupFor(talks.filter((t) => t.outlinePath))
})

// Settings: tick/untick a talk. Unticking is how a talk leaves the set before the 14 days are up.
ipcMain.handle('backup:set-enrolled', (_event, slug: string, enrolled: boolean) => {
  const state = loadBackupScope()
  setEnrolled(state, slug, enrolled, Date.now())
  saveBackupScope(state)
  return backupSettings()
})

// ── Talk discovery ─────────────────────────────────────────────────────────

interface TalkInfo {
  name: string
  path: string
  outlinePath: string
  title: string
  slug: string
}

// findTalks is a full synchronous vault walk (statSync per entry). It used to run per search
// keystroke, per sidebar meta refresh, and — via talkBySlug in the twpresent:// protocol
// handler — per Studio replay asset request. Cache the walk briefly; every vault-mutating IPC
// (create/clone/move/rename/delete, set-root) calls invalidateTalkCache() so the sidebar never
// sees a stale list after its own operation.
// Per vault (several-vaults ticket 02): vault root → that vault's walk.
const talkCache = new Map<string, { at: number; talks: TalkInfo[] }>()
// productName is TalkWeaver, so this resolves to ~/Library/Application Support/TalkWeaver/.
// One persisted snapshot per vault: vault-index/<vault id>.json. The single-vault
// vault-index.json of older builds seeds the vault it names and is left for them.
// Conflict copies (several-vaults ticket 09; conflict-copies.mjs): the vault walk hands each talk
// folder with a sync-conflict candidate (or Git markers) to the scanner. A byte-identical copy goes to
// the OS Trash (never unlink) with an Activity line in app data; a differing one is only counted.
// A closed or unavailable vault is never touched (invariant 5): canTouch asks at scan time, and the
// trash re-checks that the vault's folder is there (writableRootFor) right before the move.
const talkActivity = createTalkActivity({ dir: join(app.getPath('userData'), 'talk-activity') })
talkActivity.onAppend((vaultId, slug) => {
  for (const win of BrowserWindow.getAllWindows()) {
    try { if (!win.isDestroyed()) win.webContents.send('talk:activity-changed', { vaultId, slug }) } catch { /* window closing */ }
  }
})
/** The OS Trash. Test mode only (TW_E2E=1 with TW_E2E_TRASH_DIR): the file is moved into that folder
 *  instead, so the gate e2e can see what went to the Trash (the real Trash is not inspectable). */
async function trashConflictCopy(path: string): Promise<void> {
  const root = writableRootFor(path)
  if (!root || !pathStaysInside(root, path)) throw new Error('the vault is not available')
  const testTrash = E2E ? process.env.TW_E2E_TRASH_DIR : undefined
  if (testTrash) {
    mkdirSync(testTrash, { recursive: true })
    renameSync(path, join(testTrash, `${Date.now()}-${basename(path)}`))
    return
  }
  await shell.trashItem(path)
}
// This Mac's names as OneDrive writes them into a copy's name (review S3 rule (a)): the host name and,
// on macOS, the Computer Name ("Dominik’s MacBook Air" → "Dominiks-MacBook-Air").
function thisMacNames(): string[] {
  const names = [hostname()]
  if (process.platform === 'darwin') {
    try { names.push(execFileSync('/usr/sbin/scutil', ['--get', 'ComputerName'], { encoding: 'utf8', timeout: 2000 }).trim()) } catch { /* not available */ }
  }
  return names.filter(Boolean)
}
const vaultMachines = createVaultMachines({ file: join(app.getPath('userData'), 'vault-machines.json'), thisMac: thisMacNames })
const conflictScanner = createConflictScanner({
  trashItem: trashConflictCopy,
  // The last byte check and the move run under the outline's write lock (review T1).
  withLock: (outlinePath, work) => withTalkFileLock(outlinePath, () => work()),
  knownMachines: (vaultId: string) => vaultMachines.known(vaultId),
  rememberMachines: (vaultId: string, names: string[]) => vaultMachines.remember(vaultId, names),
  staysInside: (root: string, candidate: string) => pathStaysInside(root, candidate),
  activity: talkActivity,
  canTouch: (vaultId: string) => vaultAvailable(vaultRegistry.get(vaultId)),
  log: (message: string) => console.log(message)
})
const vaultIndex = createVaultListHandler({
  dir: join(app.getPath('userData'), 'vault-index'),
  legacyCachePath: join(app.getPath('userData'), 'vault-index.json'),
  log: (message: string) => console.log(message),
  scanConflicts: async ({ vault, folder, outlineName, slug, names }) => {
    const found = await conflictScanner.scanFolder({ vaultId: vault.id, folder, outlineName, slug, names })
    return found ? found.conflicts : null
  }
})
// The talk's Activity lines (Inspector), newest first. The talk is named by its outline path; its
// vault and slug key the local file. A path in no vault has no Activity.
ipcMain.handle('talk:activity', async (_event, outlinePath: unknown) => {
  if (typeof outlinePath !== 'string' || !outlinePath.endsWith('-outline.md')) return []
  const hit = vaultRegistry.resolve(outlinePath)
  if (!hit) return []
  return talkActivity.list(hit.vault.id, basename(outlinePath).replace(/-outline\.md$/, ''))
})
// The open talk's folder changed (the external-change guard's watcher, or the talk was just opened):
// scan that one folder, debounced, and tell every window the talk's new count.
const conflictScanTimers = new Map<string, ReturnType<typeof setTimeout>>()
function scheduleConflictScan(outlineRealPath: string): void {
  const folder = dirname(outlineRealPath)
  const prior = conflictScanTimers.get(folder)
  if (prior) clearTimeout(prior)
  conflictScanTimers.set(folder, setTimeout(() => {
    conflictScanTimers.delete(folder)
    void scanOpenTalkFolder(folder).catch((error) => console.error('[conflict-copies]', error))
  }, 250))
}
async function scanOpenTalkFolder(realFolder: string): Promise<void> {
  // The guard hands a real path; a vault registered through a symlink is found by its real root
  // (review S1), and the scan then works on the vault's own spelling of the folder, as the walk does.
  const hit = vaultRegistry.resolve(realFolder) ?? resolveByRealRoot(vaultRegistry.list().filter((v) => v.open), realFolder, (p) => realpathSync(p))
  if (!hit || !vaultAvailable(hit.vault)) return // closed, unavailable or no vault: never scanned
  const folder = hit.rel ? join(hit.vault.root, hit.rel) : hit.vault.root
  let names: string[]
  try {
    names = (await readdirAsync(folder, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name) // files only, as the walk
  } catch { return }
  const outlineName = pickOutlineName(names, basename(folder))
  if (!outlineName) return
  const slug = outlineName.replace(/-outline\.md$/, '')
  const found = await conflictScanner.scanFolder({ vaultId: hit.vault.id, folder, outlineName, slug, names })
  if (!found) return
  const outlinePath = join(folder, outlineName)
  const talk = vaultIndex.setConflicts(hit.vault.id, outlinePath, found.conflicts)
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (!win.isDestroyed()) win.webContents.send('vault:talk-conflicts', { vaultId: hit.vault.id, outlinePath: talk?.outlinePath ?? outlinePath, conflicts: found.conflicts })
    } catch { /* window closing */ }
  }
}
// Compare and merge a conflict copy (several-vaults ticket 10; conflict-compare.ts header). The one
// write goes through the normal save path (writeTalkOutline, origin 'conflict-merge'), then a ledger
// save; the version not kept goes to the OS Trash (trashConflictCopy: test trash under TW_E2E).
const conflictCompare = createConflictCompare({
  outlineLib: async () => {
    const dir = getCompilerPath()
    const [edit, ledger, propagation] = await Promise.all([
      import(pathToFileURL(join(dir, 'lib/12-outline-edit.mjs')).href),
      import(pathToFileURL(join(dir, 'lib/13-slide-ledger.mjs')).href),
      import(pathToFileURL(join(dir, 'lib/14-slide-propagation.mjs')).href)
    ])
    return { listSlideBlocks: edit.listSlideBlocks, mintId: ledger.mintId, lineDiff: propagation.lineDiff }
  },
  readTalk: (outlinePath) => readTalkOutline(outlinePath),
  writeTalk: (outlinePath, next, opts) => writeTalkOutline(outlinePath, next, 'conflict-merge', opts),
  withLock: (outlinePath, work) => withTalkFileLock(outlinePath, () => work()),
  trashItem: trashConflictCopy,
  writableRoot: (outlinePath) => writableRootFor(outlinePath),
  staysInside: (root, candidate) => pathStaysInside(root, candidate),
  vaultIdOf: (outlinePath) => vaultIdOf(outlinePath),
  knownMachines: (vaultId) => vaultMachines.known(vaultId),
  activity: talkActivity,
  ledgerSave: async (outlinePath, text, lineage) => {
    await ledgerRecord(outlinePath, text, lineage)
    frontmatterCache.delete(outlinePath)
    invalidateTalkCache(outlinePath)
  },
  rescan: async (folder) => { await scanOpenTalkFolder(realpathSync(folder)) },
  log: (message) => console.log(message)
})
ipcMain.handle('conflict:load', (_event, outlinePath: unknown) => conflictCompare.load(typeof outlinePath === 'string' ? outlinePath : ''))
ipcMain.handle('conflict:check', (_event, token: unknown) => conflictCompare.check(String(token ?? '')))
ipcMain.handle('conflict:merge', (_event, token: unknown, pick: unknown) => {
  const p = (pick ?? {}) as { keep?: unknown; pull?: unknown }
  const keep = p.keep === 'theirs' ? 'theirs' : p.keep === 'mine' ? 'mine' : null
  if (!keep) return { ok: false as const, error: 'Choose the version to keep.' }
  const pull = Array.isArray(p.pull) ? p.pull.filter((n): n is number => typeof n === 'number') : []
  return conflictCompare.merge(String(token ?? ''), { keep, pull })
})
ipcMain.handle('conflict:cancel', (_event, token: unknown) => { conflictCompare.cancel(String(token ?? '')); return true })
/** Persisted talks of the vault whose root is root; [] for a folder that is no vault. */
function listIndexedTalks(root: string): Promise<TalkInfo[]> {
  const vault = vaultOfRoot(root)
  return vault ? vaultIndex.cached(vault) : Promise.resolve([])
}
// Talk search (ADR-0029 §1, talk-search.ts): the one search for talks. It searches the Talks
// browser's own list (the persisted vault index) and reads slide text from the slide-search cache
// below; talks not read yet start the warm pass. The closures run at call time only, so the later
// `searchCache` / `warmSearchIndex` bindings are initialised by then.
const talkSearch = createTalkSearch({
  vaultRoot: () => currentVaultRoot() ?? null,
  talks: async () => {
    const vault = primaryVault()
    if (!vault) return []
    const listed = await vaultIndex.cached(vault)
    return listed.length > 0 ? listed : findTalks(vault.root)
  },
  slideRows: (outlinePath) => searchCache.get(outlinePath)?.rows ?? (slideTextUnreadable.has(outlinePath) ? [] : null),
  onSlideTextMissing: () => { void warmSearchIndex() }
})
// A search over one named vault (the Talks panel searches each open vault's section); the first open
// vault uses talkSearch above. Made on first use for a vault the registry knows; the entry goes when
// its vault is closed or removed (see the registry listener below).
const vaultTalkSearches = new Map<string, ReturnType<typeof createTalkSearch>>()
vaultRegistry.onChange((vaults) => {
  for (const id of [...vaultTalkSearches.keys()]) {
    if (!vaults.some((v) => v.id === id && v.open)) vaultTalkSearches.delete(id)
  }
})
function talkSearchFor(vaultId: unknown) {
  const primary = primaryVault()
  if (typeof vaultId !== 'string' || !vaultId) return primary ? talkSearch : null
  if (vaultId === primary?.id) return talkSearch
  if (!vaultRegistry.get(vaultId)) return null // an id the registry does not know gets no search (and no entry)
  if (vaultAvailability.isUnavailable(vaultId)) return null // an unavailable vault is not searched (invariant 5)
  let search = vaultTalkSearches.get(vaultId)
  if (!search) {
    const vaultOpen = (): Vault | null => {
      const v = vaultRegistry.get(vaultId)
      return vaultAvailable(v) ? v : null
    }
    search = createTalkSearch({
      vaultRoot: () => vaultOpen()?.root ?? null,
      talks: async () => {
        const vault = vaultOpen()
        if (!vault) return []
        const listed = await vaultIndex.cached(vault)
        return listed.length > 0 ? listed : findTalks(vault.root)
      },
      slideRows: (outlinePath) => searchCache.get(outlinePath)?.rows ?? (slideTextUnreadable.has(outlinePath) ? [] : null),
      onSlideTextMissing: () => { void warmSearchIndex() }
    })
    vaultTalkSearches.set(vaultId, search)
  }
  return search
}
const TALK_CACHE_TTL_MS = 5_000
/** Drop the talk list caches of the vault holding scopePath (a vault root or any path in it); of
 *  every vault when scopePath is omitted or in no vault. Other vaults' caches stay as they are. */
function invalidateTalkCache(scopePath?: string | null): void {
  const vault = typeof scopePath === 'string' && scopePath ? vaultRegistry.resolve(scopePath)?.vault ?? null : null
  if (vault) {
    talkCache.delete(vault.root)
    vaultIndex.invalidate(vault.id)
  } else {
    talkCache.clear()
    vaultIndex.invalidate()
  }
  // Talk search, the metadata scans and the layout doctor read the first open vault only.
  talkSearch.invalidate()
  for (const search of vaultTalkSearches.values()) search.invalidate()
  // The metadata doctor/vocabulary scans walk the same outlines — a vault mutation staleness
  // window there would show phantom unregistered keys. Declared below (ADR-0036 section);
  // only ever called at runtime, so the later `let` cache binding is initialised by then.
  invalidateMetadataCaches()
  invalidateLayoutDoctorCache()
}

/** Slide text of the vault holding scopePath goes, with its talk list caches (a vault mutation).
 *  Other vaults' slide text is kept. With no vault for scopePath, everything goes. */
function invalidateVaultCaches(scopePath: string | null | undefined): void {
  const vaultId = vaultIdOf(scopePath)
  if (vaultId) {
    const vaults = vaultRegistry.list()
    for (const key of pathsInVault(searchCache.keys(), vaults, vaultId)) searchCache.delete(key)
  } else {
    searchCache.clear()
  }
  invalidateTalkCache(scopePath)
}

function findTalks(root: string): TalkInfo[] {
  const held = talkCache.get(root)
  if (held && Date.now() - held.at < TALK_CACHE_TTL_MS) return held.talks
  const talks = scanTalks(root)
  talkCache.set(root, { at: Date.now(), talks })
  return talks
}

// Sidebar-facing frontmatter fields, parsed from an outline's HEAD (first ~2KB) and cached by
// mtime — so the 5s-cached vault walk pays one small read per outline only when it changed.
// Shared by scanTalks (real titles at the root) and vault:talk-meta (subtitle/event).
type OutlineFrontmatter = { title: string | null; subtitle: string | null; event: string | null }
const frontmatterCache = new Map<string, { mtimeMs: number; fm: OutlineFrontmatter }>()
function outlineFrontmatter(outlinePath: string, mtimeMs: number): OutlineFrontmatter {
  const cached = frontmatterCache.get(outlinePath)
  if (cached && cached.mtimeMs === mtimeMs) return cached.fm
  const fm: OutlineFrontmatter = { title: null, subtitle: null, event: null }
  try {
    const fd = openSync(outlinePath, 'r')
    const buf = Buffer.alloc(2048)
    const n = readSync(fd, buf, 0, 2048, 0)
    closeSync(fd)
    const head = buf.subarray(0, n).toString('utf8')
    if (head.startsWith('---')) {
      const end = head.indexOf('\n---', 3)
      const block = end === -1 ? head.slice(3) : head.slice(3, end)
      for (const key of ['title', 'subtitle', 'event'] as const) {
        const m = block.match(new RegExp(`^${key}:[ \\t]*(.+)$`, 'm'))
        if (m) {
          const v = m[1].trim().replace(/^["']|["']$/g, '').trim()
          if (v) fm[key] = v
        }
      }
    }
  } catch {
    // An unreadable head falls back to the slug-derived title — never fail the scan.
  }
  frontmatterCache.set(outlinePath, { mtimeMs, fm })
  return fm
}

// The synchronous walk behind findTalks (slide text warm pass, slide search, thumbnails). Its
// depth limit and skip rule are the persisted vault index's (talk-scan.mjs): a talk the Talks
// browser lists must also get slide text (talk search ticket 01; the York talks sit 4 levels down).
function scanTalks(root: string): TalkInfo[] {
  if (!existsSync(root)) return []
  const talks: TalkInfo[] = []
  for (const { dir, outlineName } of scanTalkFoldersSync(root)) {
    const outlinePath = join(dir, outlineName)
    const slug = outlineName.replace('-outline.md', '')
    // The REAL title lives in the outline's frontmatter; the slug-derived title-case form is
    // only the fallback (it capitalises every word and loses punctuation — live finding, 0.14.0).
    const fallback = slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
    let title = fallback
    try {
      title = outlineFrontmatter(outlinePath, statSync(outlinePath).mtimeMs).title ?? fallback
    } catch {
      // stat raced a rename/delete — the fallback title still lists the talk.
    }
    talks.push({ name: slug, path: dir, outlinePath, title, slug })
  }
  return talks.sort((a, b) => a.title.localeCompare(b.title))
}

// The talks of one vault: vaultId names it; without one, the first open vault (today's single list).
// A closed or unknown vault lists nothing and is not scanned. Batches carry the vault id.
ipcMain.handle('vault:list-talks', async (event, vaultId?: unknown) => {
  const vault = typeof vaultId === 'string' ? vaultRegistry.get(vaultId) : primaryVault()
  if (!vault || !vault.open) return []
  if (vaultAvailability.isUnavailable(vault.id)) return [] // unmounted: not listed, not scanned (ticket 07)
  const cached = await vaultIndex.handle(vault, (batch, reset, done) => {
    if (!event.sender.isDestroyed()) event.sender.send('vault:talks-batch', { vaultId: vault.id, batch, reset, done })
  })
  void vaultIndex.refreshDone(vault.id).then((talks) => {
    talkCache.set(vault.root, { at: Date.now(), talks })
  }).catch((error) => console.error('[vault-index]', error))
  return cached
})

// Warning types an author must act on (mirrors the renderer's SURFACED_WARNINGS filter —
// hints like icon-suggested would make every talk look broken).
const SURFACED_WARNING_TYPES = new Set(['iconlist-no-icons'])
function surfacedWarningCount(rows: ProjectionRowMain[]): number {
  let n = 0
  for (const r of rows) {
    const ws = Array.isArray(r.warnings) ? (r.warnings as unknown[]) : []
    if (ws.some((w) => SURFACED_WARNING_TYPES.has(String(w).split(':')[0]))) n += 1
  }
  return n
}

// Facts about every talk of every open vault, keyed by slug (the first open vault wins a slug that
// two vaults share; a per-vault key is a later ticket).
ipcMain.handle('vault:talk-meta', async () => {
  try {
    type Meta = {
      slideCount: number | null
      createdMs: number
      editedMs: number
      // First slide's thumb-cache key → the talk's cover (twthumb://slug/coverKey); null until indexed.
      coverKey: string | null
      // Slides with actionable compiler warnings (0 until indexed).
      warningCount: number
      // Frontmatter context lines (mtime-cached parse shared with scanTalks); null when absent.
      subtitle: string | null
      event: string | null
      pathwayCount: number
      pathwayNames: string[]
    }
    const out: Record<string, Meta> = {}
    for (const vault of availableVaults()) {
      const root = vault.root
      const persisted = await vaultIndex.metadata(vault)
      for (const talk of await vaultIndex.cached(vault)) {
        if (out[talk.slug]) continue
        const cached = searchCache.get(talk.outlinePath)
        const first = cached?.rows?.[0] as (ProjectionRowMain & { render_hash?: string }) | undefined
        const meta = persisted[talk.slug]
        const pathwaySummary = readPathwaySummary(root, talk.slug)
        out[talk.slug] = {
          slideCount: cached ? cached.rows.length : null,
          createdMs: meta?.createdMs ?? 0,
          editedMs: meta?.editedMs ?? 0,
          coverKey: first ? (first.render_hash || first.content_hash || first.slide_id || null) : null,
          warningCount: cached ? surfacedWarningCount(cached.rows) : 0,
          subtitle: meta?.subtitle ?? null,
          event: meta?.event ?? null,
          pathwayCount: pathwaySummary.count,
          pathwayNames: pathwaySummary.names
        }
      }
    }
    return out
  } catch {
    return {}
  }
})

// ── Compiler ───────────────────────────────────────────────────────────────

// The compiler ships INSIDE the app (compiler/scripts) — rendering never depends on an external
// repo. Dev loads it from the project root; a packaged build loads the copy electron-builder placed
// in Resources/ (see build.extraResources). asar is off, so dynamic import() of these on-disk ESM
// modules works in both. The mirrored layout (compiler/scripts + sibling compiler/{reference,assets})
// keeps the compiler's scriptDir-relative asset reads and every join(compilerDir, '..', ...) valid.
function getCompilerPath(): string {
  const dir = app.isPackaged
    ? join(process.resourcesPath, 'compiler', 'scripts')
    : join(app.getAppPath(), 'compiler', 'scripts')
  if (!existsSync(join(dir, 'lib/08-source-adapters.mjs'))) {
    console.error(
      '[talk-weaver] Bundled compiler missing at ' +
        dir +
        ' — build is broken (compiler/ not vendored, or extraResources not configured).'
    )
  }
  return dir
}

// ── Slide Ledger (ADR-0032) ─────────────────────────────────────────────────
// Every ledger call is wrapped: a ledger failure must NEVER make a save return false
// or block present/export/publish.
async function ledgerLib(): Promise<any | null> {
  const compilerDir = getCompilerPath()
  if (!compilerDir) return null
  return import(pathToFileURL(join(compilerDir, 'lib/13-slide-ledger.mjs')).href)
}

// Cross-vault inserts (ticket 06) promise an origin for a slide id's first record in the target
// vault; the save that first ledgers the id writes it, then the promise is dropped. Keyed by root.
const pendingOrigins = new Map<string, Map<string, SlideOrigin>>()
// The owner's private provenance (userData/provenance.json, keyed <targetVaultId>/<slideId>).
let provenanceStoreInstance: ReturnType<typeof createProvenanceStore> | null = null
function provenanceStore(): ReturnType<typeof createProvenanceStore> {
  return (provenanceStoreInstance ??= createProvenanceStore(join(app.getPath('userData'), 'provenance.json')))
}

async function ledgerRecord(outlinePath: string, content: string, lineageHints: Map<string, string> | null = null): Promise<string[]> {
  try {
    const vaultRoot = vaultRootFor(outlinePath)
    const lib = await ledgerLib()
    if (!vaultRoot || !lib) return []
    const pending = pendingOrigins.get(vaultRoot) ?? null
    // An id's first record takes the origin an insert promised, or — after a refused save or a
    // restart — the one rebuilt from this Mac's private record (ticket 06).
    const originHints = originHintsFor(vaultIdOf(outlinePath), pending, provenanceStore())
    const result = lib.recordOutlineSave(vaultRoot, outlinePath, content, { now: Date.now(), originHints, lineageHints })
    if (pending) {
      for (const id of [...result.versioned, ...result.coalesced, ...result.unchanged]) pending.delete(id)
      if (pending.size === 0) pendingOrigins.delete(vaultRoot)
    }
    return result.collisions
  } catch { return [] }
}

async function ledgerSeal(outlinePath: string, content: string, reason: string): Promise<void> {
  try {
    const vaultRoot = vaultRootFor(outlinePath)
    const lib = await ledgerLib()
    if (vaultRoot && lib) lib.sealOutline(vaultRoot, outlinePath, content, reason, { now: Date.now() })
  } catch { /* sealing must never break present/export/publish */ }
}

// Thumbnail cache dir name that AUTO-BUSTS when the compiler/renderer/template changes. render_hash
// keys thumbnails by the slide MODEL, so a pure renderer or CSS edit (which leaves the model
// unchanged) would otherwise serve a stale image. Hashing the key compiler files into the dir name
// forces fresh thumbnails on any such change. Computed once per session.
let thumbCacheTag: string | null = null
function thumbCacheRoot(): string {
  if (thumbCacheTag) return thumbCacheTag
  const dir = getCompilerPath()
  let tag = 'base'
  if (dir) {
    try {
      // Hash EVERY compiler lib file (not a cherry-picked subset) + the template, so ANY rendering
      // change — lexer, triggers, adapters, renderers, assembly, projections — busts the cache. A
      // hand-picked list once omitted 03-markdown-lexer.mjs, so a lexer fix left stale thumbnails.
      const libDir = join(dir, 'lib')
      const files = readdirSync(libDir)
        .filter((f) => f.endsWith('.mjs'))
        .sort()
        .map((f) => join(libDir, f))
      files.push(join(dir, '..', 'assets', 'templates', 'presenter-popup-single-html.html'))
      const h = createHash('sha256')
      for (const f of files) if (existsSync(f)) h.update(readFileSync(f))
      tag = h.digest('hex').slice(0, 8)
    } catch {
      tag = 'base'
    }
  }
  // v9: picture keys now include referenced media bytes and are shared by both compile modes.
  thumbCacheTag = 'thumb-cache-v9-' + tag
  return thumbCacheTag
}

// Per-vault thumbnail folders (thumb-cache-dirs.ts): a talk's pictures live under its vault's id,
// so two vaults with the same talk slug never share a folder. The per-slug folders an older build
// left in the live namespace move under the first open vault once per session, before any lookup.
function thumbNamespaceDir(): string {
  return join(app.getPath('userData'), thumbCacheRoot())
}
let legacyThumbsAdopted = false
function adoptLegacyThumbsOnce(): void {
  if (legacyThumbsAdopted) return
  const primary = vaultRegistry.primary()
  if (!primary) return
  legacyThumbsAdopted = true
  const moved = adoptLegacyThumbDirs(thumbNamespaceDir(), primary.id)
  if (moved) console.log(`[thumbnails] moved ${moved} talk cache folder(s) under vault ${primary.id}`)
}
// Older builds (0.35 beta) sweep a namespace whose folder and immediate children look idle for 7
// days; renders now land under @vaults/<id>/<slug>, so the namespace folder's own mtime is bumped
// when a talk's cache folder is first handed out, and again at most hourly.
const NAMESPACE_TOUCH_EVERY_MS = 60 * 60 * 1000
let namespaceTouchedAt = 0
/** The cache folder for a talk's thumbnails: its vault's folder, or the namespace level for a talk
 *  in no vault. */
function touchNamespaceHourly(): void {
  if (Date.now() - namespaceTouchedAt >= NAMESPACE_TOUCH_EVERY_MS) {
    namespaceTouchedAt = Date.now()
    touchNamespace(thumbNamespaceDir())
  }
}
function talkThumbCacheDir(outlinePath: string, slug: string): string {
  adoptLegacyThumbsOnce()
  touchNamespaceHourly()
  return talkThumbDir(thumbNamespaceDir(), vaultIdOf(outlinePath), slug)
}

// A changed compiler starts a new cache namespace. Do not migrate prior namespaces here:
// this runs on the main thread during deck opening, and long-lived profiles can contain
// hundreds of thousands of historical PNGs. Render only requested slides in the current
// namespace; same-version thumbnails are still reused. Keep old caches untouched.

// Blank Layout templates (ADR-0021): the single source lives beside the Reference Deck fixtures
// in html-presentations (reference/layout-templates.mjs). The picker imports these so ⌘-Enter
// inserts a scaffold and Space previews it. Cached after first load.
let layoutTemplatesCache: { templates: Record<string, string>; aliases: Record<string, string> } | null = null
ipcMain.handle('layout:templates', async () => {
  if (layoutTemplatesCache) return layoutTemplatesCache
  const compilerDir = getCompilerPath()
  if (!compilerDir) return null
  try {
    const url = pathToFileURL(join(compilerDir, '..', 'reference', 'layout-templates.mjs')).href
    const mod = await import(url)
    layoutTemplatesCache = {
      templates: (mod.LAYOUT_TEMPLATES ?? {}) as Record<string, string>,
      aliases: (mod.ALIASES ?? {}) as Record<string, string>
    }
    return layoutTemplatesCache
  } catch (e) {
    console.warn('[talk-weaver] layout:templates failed', e)
    return null
  }
})

// Layout preview thumbnails (Feature #3): render ONE real compiled slide per layout from the
// engine's canonical Reference fixtures, so the "/" picker shows a true render instead of a
// hand-drawn placeholder — and the preview can never drift from the compiler. The engine owns the
// fixtures (reference/fixtures.mjs), the outline assembly (reference/reference-outline.mjs) and the
// picker-name → fixture-id map (reference/layout-fixture-map.mjs); we compile that ONE outline via
// the live pipeline (exactly like talk:compile) and render each fixture's slide through the same
// offscreen renderThumbnails path as talk:thumbnails. Cached on disk under a version derived from
// the fixtures so a fixture change invalidates stale PNGs, and in-process so the picker pays the
// render cost at most once per session. Returns { layoutName: twthumb://… } or null on error.
// The picker's layout names (mirrors renderer data/layouts.ts; the engine's layoutFixtureMap
// resolves each to its Reference fixture id, omitting any that has no fixture). Kept here so the
// main process need not import the renderer bundle.
const LAYOUT_PREVIEW_NAMES = [
  'statement', 'list', 'iconlist', 'numbered', 'quote', 'contrast-cards', 'annotated', 'sidebar',
  'media', 'contrast', 'copy-visual', 'cards', 'title', 'section', 'subsection', 'closing',
  'timeline', 'timelinevertical', 'timelinehorizontal', 'timelinespine', 'timeline-pills', 'grid',
  'system-map', 'smartart', 'flow', 'image-claim', 'cta-screenshots', 'trace', 'trace-dialogue',
  'code', 'table', 'qr', 'action', 'embed', 'auto-embed', 'logolist', 'image-quote', 'image-grid',
  'barchart', 'piechart', 'linechart', 'sigmoid', 'timetable', 'table-outline', 'columns', 'pyramid',
  'orgchart', 'mindmap', 'conceptmap', 'stats', 'process', 'steps', 'iconrow', 'cycle', 'equation',
  'reveal', 'group', 'focus', 'trigger-line', 'countdown'
]
let layoutPreviewThumbsCache: Record<string, string> | null = null
ipcMain.handle('layout:preview-thumbnails', async () => {
  if (layoutPreviewThumbsCache) return layoutPreviewThumbsCache
  const compilerDir = getCompilerPath()
  if (!compilerDir) return null
  try {
    const refDir = join(compilerDir, '..', 'reference')
    const { fixtures } = await import(pathToFileURL(join(refDir, 'fixtures.mjs')).href)
    const { buildReferenceOutline } = await import(pathToFileURL(join(refDir, 'reference-outline.mjs')).href)
    const { layoutFixtureMap } = await import(pathToFileURL(join(refDir, 'layout-fixture-map.mjs')).href)
    const { prepareSource } = await import(pathToFileURL(join(compilerDir, 'lib/08-source-adapters.mjs')).href)
    const { buildPerSlideProjections } = await import(pathToFileURL(join(compilerDir, 'lib/10-projections.mjs')).href)

    const slug = 'reference-deck'
    const outline = buildReferenceOutline() as string
    // Write the outline to a real temp dir with the fixtures' assets copied alongside as assets/,
    // so the image/media fixtures' relative refs (assets/two-box.svg) inline exactly as in the
    // Reference Deck build — the renders are then true, not blank. prepareSource resolves relative
    // assets against dirname(sourcePath).
    const refWork = join(tmpdir(), `tw-layout-preview-${randomBytes(6).toString('hex')}`)
    mkdirSync(join(refWork, 'assets'), { recursive: true })
    const fixturesAssets = join(refDir, 'fixtures-assets')
    if (existsSync(fixturesAssets)) {
      cpSync(fixturesAssets, join(refWork, 'assets'), { recursive: true })
    }
    const outlinePath = join(refWork, `${slug}-outline.md`)
    writeFileSync(outlinePath, outline, 'utf8')
    const stat = statSync(outlinePath)
    const model = await prepareSource(outlinePath, outline, slug, stat)
    const rows = (buildPerSlideProjections(model, slug) ?? []) as Array<{
      slide_id?: string
      render_hash?: string
      content_hash?: string
      layout?: string
      triggers?: Record<string, string>
    }>

    // Render every slide (in deck order) keyed by render_hash, reusing the offscreen path. The
    // cache slug folds in a fixtures-derived version so editing a fixture re-renders, never serves
    // a stale picture; old version folders are simply left unused (harmless, tiny PNGs).
    const buildMap = (layoutFixtureMap as (names: string[]) => Record<string, string>)(LAYOUT_PREVIEW_NAMES)
    const version = createHash('sha256')
      .update(
        JSON.stringify(
          (fixtures as Array<{ id: string; markdown: string }>).map((f) => [f.id, f.markdown])
        )
      )
      .digest('hex')
      .slice(0, 12)
    const cacheSlug = `__layout-preview__-${version}`
    const slides = rows
      .map((r) => ({ key: r.render_hash || r.content_hash || r.slide_id || '', layout: r.triggers?.layout ?? r.layout }))
      .filter((s) => s.key)
    const cacheDir = join(app.getPath('userData'), thumbCacheRoot(), cacheSlug)
    await renderThumbnails({ fullHtml: model.fullHtml as string, slides, cacheDir })

    // fixture id → its slide's render_hash (the cache key). Structural section/subsection dividers
    // render to `<id>-title`, so accept that fallback exactly like the Reference Deck builder.
    const keyByFixtureId: Record<string, string> = {}
    for (const r of rows) {
      const id = r.slide_id || ''
      const key = r.render_hash || r.content_hash || ''
      if (id && key) keyByFixtureId[id] = key
    }
    const out: Record<string, string> = {}
    for (const [layoutName, fixtureId] of Object.entries(buildMap)) {
      const key = keyByFixtureId[fixtureId] || keyByFixtureId[`${fixtureId}-title`]
      if (key) out[layoutName] = 'twthumb://' + cacheSlug + '/' + key
    }
    layoutPreviewThumbsCache = out
    return out
  } catch (e) {
    console.error('[layout:preview-thumbnails]', e)
    return null
  }
})

// Icon vocabulary (ADR-0021 icon picker): the engine's 05-icons.mjs owns the Lucide + SVGL
// brand sets and the Tabler gap-fill tier, and renders glyphs deterministically. Cache the
// imported module so per-keystroke search and per-result svg() don't re-import it. Invalidated
// when getCompilerPath() changes.
type IconsModule = {
  searchIcons: (q: string, n?: number) => Array<{ key: string; source: string }>
  iconSvg: (key: string) => string
}
let iconsModuleCache: { dir: string; mod: IconsModule } | null = null
async function loadIconsModule(): Promise<IconsModule | null> {
  const compilerDir = getCompilerPath()
  if (!compilerDir) return null
  if (iconsModuleCache && iconsModuleCache.dir === compilerDir) return iconsModuleCache.mod
  const url = pathToFileURL(join(compilerDir, 'lib/05-icons.mjs')).href
  const mod = (await import(url)) as IconsModule
  iconsModuleCache = { dir: compilerDir, mod }
  return mod
}

ipcMain.handle('icons:search', async (_event, query: string) => {
  try {
    const mod = await loadIconsModule()
    if (!mod) return []
    const hits = mod.searchIcons(query ?? '', 40) ?? []
    // Narrow source to the picker's union; the engine emits 'lucide' | 'svgl' | 'tabler' here —
    // the picker deliberately searches the WHOLE Tabler collection (an explicit user action),
    // even though the compiler's auto-match gate only ever reaches its mood-* family.
    return hits.map((h) => ({ key: h.key, source: h.source as 'lucide' | 'svgl' | 'tabler' }))
  } catch (e) {
    console.error('[icons:search]', e)
    return []
  }
})

ipcMain.handle('icons:svg', async (_event, key: string) => {
  try {
    const mod = await loadIconsModule()
    if (!mod) return null
    const svg = mod.iconSvg(key ?? '')
    return svg || null
  } catch (e) {
    console.error('[icons:svg]', e)
    return null
  }
})

// Prepared-model memo: talk:compile and talk:thumbnails fire back-to-back on the SAME
// (outlinePath, content) after every edit-pause debounce, and each prepareSource pass walks and
// inlines the whole deck. Coalesce simultaneous requests and keep one revision per path/defaults
// group. Bound retained HTML at 256 MiB (estimated UTF-16 bytes), except one oversized current
// document retained alone for the follow-up thumbnail request. This is not a total heap limit.
interface PreparedTalk {
  slug: string
  model: { fullHtml?: unknown; [k: string]: unknown }
  rows: Array<{ [k: string]: unknown }> | null
}
const preparedTalkCache = createPreparedTalkCache<PreparedTalk>({
  maxEntries: 6,
  maxBytes: 256 * 1024 * 1024,
  sizeOf: (entry) => typeof entry.model.fullHtml === 'string' ? entry.model.fullHtml.length * 2 : 0
})

// One full-deck preparation in flight at a time. prepareSource base64-inlines a whole deck into a
// single enormous string; two lanes preparing at once (the editor strip and the Slide Browser's
// background sweep) put two of them in the heap together. The render QUEUE serialises renders, not
// preparation — this gate is what makes T11's "one deck in memory" law hold here (2026-09-15 OOM).
const preparePass = createSingleFlight()
// A live compile: cached, on the gate's ordinary lane. A layout variant: uncached, on its background lane.
const routePreparation = createPreparationRoute(preparedTalkCache, preparePass)

async function prepareTalk(
  outlinePath: string,
  content: string,
  defaults?: Record<string, unknown>,
  options?: Record<string, unknown>,
  /** 'variant' for a compile that is not the live deck (a layout variant): uncached, so it neither
   *  displaces the live deck's retained model nor stays retained itself, and on the preparation gate's
   *  background lane, so the live deck's compile never waits behind it (createPreparationRoute). */
  lane: PreparationLane = 'live'
): Promise<PreparedTalk | null> {
  const compilerDir = getCompilerPath()
  if (!compilerDir) return null
  const stat = statSync(outlinePath)
  const slug = basename(outlinePath).replace('-outline.md', '')
  const vaultRoot = vaultRootFor(outlinePath)
  const resolved = vaultRoot ? resolveImageRefs(content, vaultRoot) : content
  const group = preparedTalkGroup(outlinePath, defaults, options)
  const key = group + '\0' + createHash('sha256').update(resolved).digest('hex')
  const load = async (gated: <R>(task: () => Promise<R>) => Promise<R>): Promise<PreparedTalk> => {
    if (process.env.TW_REC_TEST === '1') {
      const testGlobal = globalThis as typeof globalThis & { __twPrepareCount?: number }
      testGlobal.__twPrepareCount = (testGlobal.__twPrepareCount ?? 0) + 1
    }
    const { prepareSource } = await import(
      pathToFileURL(join(compilerDir, 'lib/08-source-adapters.mjs')).href
    )
    const { buildPerSlideProjections } = await import(
      pathToFileURL(join(compilerDir, 'lib/10-projections.mjs')).href
    )
    const model = await gated(() => prepareSource(outlinePath, resolved, slug, stat, defaults, options ?? {})) as PreparedTalk['model']
    const rows = buildPerSlideProjections(model, slug) ?? null
    return { slug, model, rows }
  }
  return routePreparation(lane, key, group, load)
}

// The background thumbnail lane decides things on its own — defer, skip, evict — and the packaged
// app has no console to say so in. Everything it does goes to {userData}/tw-thumbnails.log as well
// as stdout, so the next blank-card report can be read instead of inferred (2026-09-15).
let thumbnailLogFile: ((message: string) => void) | null = null
function logThumbnails(message: string): void {
  try { console.log(`[thumbnails] ${message}`) } catch { /* EPIPE-guarded above */ }
  try {
    if (!thumbnailLogFile) {
      thumbnailLogFile = createAppendLog(join(app.getPath('userData'), 'tw-thumbnails.log'))
    }
    thumbnailLogFile(`[thumbnails] ${message}`)
  } catch { /* logging must never take the app down */ }
}

/** The compiler's video-free thumbnail media contract, loaded from the live compiler directory. */
async function browserThumbnailMediaOptions(): Promise<Record<string, unknown> | undefined> {
  const compilerDir = getCompilerPath()
  if (!compilerDir) return undefined
  try {
    const { THUMBNAIL_MEDIA_OPTIONS } = await import(
      pathToFileURL(join(compilerDir, 'lib/08-source-adapters.mjs')).href
    )
    return THUMBNAIL_MEDIA_OPTIONS as Record<string, unknown> | undefined
  } catch (e) {
    console.error('[thumbnails] could not load the thumbnail media contract', e)
    return undefined
  }
}

async function pathwaySnapshot(outlinePath: string, content: string) {
  const vaultRoot = vaultRootFor(outlinePath)
  if (!vaultRoot) throw new Error('Choose a Vault before managing pathways.')
  const prepared = await prepareTalk(outlinePath, content)
  if (!prepared?.rows) throw new Error('The outline could not be compiled.')
  const manifest = readPathwayManifest(vaultRoot, prepared.slug)
  const slides = prepared.rows as PathwaySlideRow[]
  return { slides, pathways: resolvePathways(manifest.pathways, slides), manifest }
}

ipcMain.handle('pathways:read', async (_event, outlinePath: string, content: string) => {
  try {
    const { slides, pathways } = await pathwaySnapshot(outlinePath, content)
    return { slides, pathways }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
})

async function mutatePathways(
  outlinePath: string,
  content: string,
  mutation: (text: string) => string
) {
  const before = await pathwaySnapshot(outlinePath, content)
  const text = mutation(before.manifest.text)
  writePathwayManifest(before.manifest.path, text)
  const vaultRoot = vaultRootFor(outlinePath) as string
  const talkSlug = basename(dirname(before.manifest.path))
  invalidatePathwaySummary(vaultRoot, talkSlug)
  notifyPathwaysChanged(outlinePath)
  notifyTalkMetaUpdated()
  const pathways = resolvePathways(readPathwayManifest(
    vaultRoot,
    talkSlug
  ).pathways, before.slides)
  return { slides: before.slides, pathways }
}

ipcMain.handle('pathways:create', async (_event, outlinePath: string, content: string, name: string, note?: string) => {
  try {
    const id = 'path-' + randomBytes(6).toString('hex')
    return await mutatePathways(outlinePath, content, (text) => createPathwayInManifest(text, {
      id,
      name: String(name || '').trim(),
      ...(String(note || '').trim() ? { note: String(note).trim() } : {}),
      slideIds: []
    }))
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
})

ipcMain.handle('pathways:rename', async (_event, outlinePath: string, content: string, id: string, name: string) => {
  try {
    return await mutatePathways(outlinePath, content, (text) => renamePathwayInManifest(text, String(id), String(name)))
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
})

ipcMain.handle('pathways:delete', async (_event, outlinePath: string, content: string, id: string) => {
  try {
    return await mutatePathways(outlinePath, content, (text) => deletePathwayInManifest(text, String(id)))
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
})

ipcMain.handle('pathways:set-slide-ids', async (_event, outlinePath: string, content: string, id: string, slideIds: string[]) => {
  try {
    return await mutatePathways(outlinePath, content, (text) =>
      setPathwaySlideIdsInManifest(text, String(id), Array.isArray(slideIds) ? slideIds.map(String) : [])
    )
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
})

function previewDocument(outlinePath: string, content: string, fullHtml: string): { id: string; html: string } {
  const id = createHash('sha256').update(outlinePath).update('\0').update(content).digest('hex').slice(0, 24)
  const html = markSlidePreviewHtml(fullHtml)
  slidePreviewStore.set(id, html)
  return { id, html }
}

function thumbnailDocumentId(html: string): string {
  return createHash('sha256').update(markSlidePreviewHtml(html)).digest('hex').slice(0, 16)
}

ipcMain.handle('talk:compile', async (_event, outlinePath: string, content: string) => {
  try {
    const prepared = await prepareTalk(outlinePath, content)
    return prepared?.rows ?? null
  } catch (e) {
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
    const documentId = thumbnailDocumentId(fullHtml)
    const selected = selectedThumbnailSlide(prepared.rows, String(slideId), documentId)
    if (!selected) return null
    const cacheDir = talkThumbCacheDir(outlinePath, prepared.slug)
    const rendered = await renderThumbnails({ fullHtml, slides: [selected], cacheDir })
    const renderedPath = rendered[selected.key]
    return renderedPath
      ? { slideId: String(slideId), url: thumbUrl(prepared.slug, basename(renderedPath, '.png'), vaultIdOf(outlinePath)) }
      : null
  } catch (e) {
    console.error('[selected-thumbnail]', e)
    return null
  }
})

// ADR-0032 §6 (own slide over sample): the author's CURRENT slide, rendered from outline text with
// another layout (and options) on it, for the picker's pictures and the Inspector's option pictures.
// The outline on disk and in the editor is never touched (preview-layout writes nothing). A variant is
// compiled on the 'variant' lane: UNCACHED (the prepared-talk cache is the live deck's: a variant there
// would evict the live model and stay retained itself) and on the single-flight prepare gate's
// BACKGROUND lane (one deck at a time still, but the live deck's compile never waits behind a variant),
// under the video-free thumbnail media contract when it loads (the 2026-09-15 browser-lane precedent;
// a failed load is asked again next time, not kept). The model is garbage once the render returns.
const variantMedia = memoiseUntilFailure(browserThumbnailMediaOptions)
const renderVariantThumbnail = createVariantThumbnailRenderer({
  prepareTalk: async (outlinePath, content) => prepareTalk(outlinePath, content, undefined, await variantMedia(), 'variant'),
  render: (opts) => renderThumbnails(opts),
  cacheDirFor: (outlinePath, slug) => talkThumbCacheDir(outlinePath, slug),
  urlFor: (slug, name, outlinePath) => thumbUrl(slug, name, vaultIdOf(outlinePath)),
  documentId: (html) => thumbnailDocumentId(html),
  inputsFingerprint: (outlinePath, content) => {
    const vaultRoot = vaultRootFor(outlinePath)
    return mediaFingerprint(outlinePath, vaultRoot ? resolveImageRefs(content, vaultRoot) : content)
  }
})
ipcMain.handle('layout:variant-thumbnail', createVariantThumbnailHandler(outlineRefused, renderVariantThumbnail))
// Ticket 10: pictures of one compared version of a conflict (Mine or the other). Compiled like a layout
// variant: on the 'variant' lane (uncached, background), so the live deck's model is neither
// displaced nor made to wait, under the variant media contract. Keyed by slide id for the screen.
ipcMain.handle('conflict:pictures', async (_event, token: unknown, side: unknown) => {
  const version = conflictCompare.versionText(String(token ?? ''), side === 'theirs' ? 'theirs' : 'mine')
  if (!version || outlineRefused(version.outlinePath)) return {}
  try {
    const prepared = await prepareTalk(version.outlinePath, version.text, undefined, await variantMedia(), 'variant')
    if (!prepared) return {}
    const rows = (prepared.rows ?? []) as Array<{ slide_id?: string; render_hash?: string; content_hash?: string; thumbnail_hash?: string; layout?: string; triggers?: Record<string, string> }>
    const fullHtml = prepared.model.fullHtml as string
    const slides = thumbnailSlides(rows, thumbnailDocumentId(fullHtml))
    const rendered = await renderThumbnails({ fullHtml, slides, cacheDir: talkThumbCacheDir(version.outlinePath, prepared.slug), requestKey: `conflict:${_event.sender.id}:${side === 'theirs' ? 'theirs' : 'mine'}` })
    const vaultId = vaultIdOf(version.outlinePath)
    const out: Record<string, string> = {}
    for (const row of rows) {
      const key = row.render_hash || row.content_hash || row.slide_id || ''
      if (row.slide_id && key && rendered[key]) out[row.slide_id] = thumbUrl(prepared.slug, basename(rendered[key], '.png'), vaultId)
    }
    return out
  } catch (e) {
    console.error('[conflict:pictures]', e)
    return {}
  }
})

// Inspector + Slide Focus compile the SAME full live outline as Present and thumbnails. The
// content-addressed URL is stable across slide navigation; the renderer changes only its hash.
ipcMain.handle('slide:render-preview', async (_event, outlinePath: string, outlineContent: string) => {
  try {
    const prepared = await prepareTalk(outlinePath, outlineContent)
    const fullHtml = prepared?.model.fullHtml
    if (typeof fullHtml !== 'string') return null
    return slidePreviewUrl(previewDocument(outlinePath, outlineContent, fullHtml).id)
  } catch (e) {
    console.error('[slide:render-preview]', e)
    return null
  }
})

// ── Embed preflight ("Check embeds") ─────────────────────────────────────────
// Reports, per embed, whether it will actually DISPLAY when presenting — catching
// embedding-disabled YouTube videos (the "Video unavailable" case), private/deleted
// videos, and sites that refuse framing. See docs/superpowers/specs/2026-06-30-embed-preflight.
type EmbedStatusKind = 'youtube' | 'vimeo' | 'site'
type EmbedStatusState =
  | 'ok' | 'embedding-disabled' | 'not-found' | 'refuses-framing' | 'unreachable' | 'unknown'
interface EmbedStatus {
  slideId: string
  title: string
  url: string
  kind: EmbedStatusKind
  status: EmbedStatusState
  detail: string
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
}

// Every embed compiles to `<iframe data-src="URL" …>` inside its slide `<section data-id…>`.
// Local inlined sims use `srcdoc` (no data-src) and always work, so they are skipped here —
// this preflight is only about embeds that load over the network.
function extractDeckEmbeds(html: string): Array<{ slideId: string; title: string; url: string; isVideo: boolean }> {
  const out: Array<{ slideId: string; title: string; url: string; isVideo: boolean }> = []
  const sectionRe = /<section class="slide"([^>]*)>([\s\S]*?)<\/section>/g
  let m: RegExpExecArray | null
  while ((m = sectionRe.exec(html))) {
    const attrs = m[1]
    const slideId = (attrs.match(/data-id="([^"]*)"/) || [])[1] || ''
    const title = decodeHtmlEntities((attrs.match(/data-nav-title="([^"]*)"/) || [])[1] || slideId)
    const iframeRe = /<iframe\b([^>]*)>/g
    let f: RegExpExecArray | null
    while ((f = iframeRe.exec(m[2]))) {
      const src = (f[1].match(/data-src="([^"]*)"/) || [])[1]
      if (!src || !/^https?:/i.test(decodeHtmlEntities(src))) continue
      out.push({ slideId, title, url: decodeHtmlEntities(src), isVideo: /\bdata-embed-video\b/.test(f[1]) })
    }
  }
  return out
}

function classifyEmbed(url: string): EmbedStatusKind {
  if (/(?:^|\.)youtube(?:-nocookie)?\.com|youtu\.be/i.test(url)) return 'youtube'
  if (/(?:^|\.)vimeo\.com/i.test(url)) return 'vimeo'
  return 'site'
}

async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  try {
    return await fetch(url, { ...init, signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function checkEmbedUrl(
  url: string,
  parseVideoEmbed: (s: string) => { id: string } | null
): Promise<{ status: EmbedStatusState; detail: string; kind: EmbedStatusKind }> {
  const kind = classifyEmbed(url)
  try {
    if (kind === 'youtube') {
      const v = parseVideoEmbed(url)
      const watch = v ? `https://www.youtube.com/watch?v=${v.id}` : url
      const res = await fetchWithTimeout(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watch)}`, {}, 6000)
      if (res.ok) return { kind, status: 'ok', detail: 'Embeddable' }
      if (res.status === 401) return { kind, status: 'embedding-disabled', detail: 'Embedding disabled or video is private' }
      // YouTube oEmbed answers 404 for a deleted video and 400 for an unknown/invalid id — both
      // mean the embed will show "Video unavailable".
      if (res.status === 404 || res.status === 400) return { kind, status: 'not-found', detail: 'Video not found, deleted, or unavailable' }
      return { kind, status: 'unknown', detail: `YouTube oEmbed returned HTTP ${res.status}` }
    }
    if (kind === 'vimeo') {
      const res = await fetchWithTimeout(`https://vimeo.com/api/oembed.json?url=${encodeURIComponent(url)}`, {}, 6000)
      if (res.ok) return { kind, status: 'ok', detail: 'Embeddable' }
      if (res.status === 403) return { kind, status: 'embedding-disabled', detail: 'Embedding restricted by the owner' }
      if (res.status === 404) return { kind, status: 'not-found', detail: 'Video not found' }
      return { kind, status: 'unknown', detail: `Vimeo oEmbed returned HTTP ${res.status}` }
    }
    // Arbitrary site: predict framing from X-Frame-Options and CSP frame-ancestors.
    const res = await fetchWithTimeout(url, { method: 'GET', redirect: 'follow' }, 6000)
    const xfo = (res.headers.get('x-frame-options') || '').toLowerCase()
    const csp = (res.headers.get('content-security-policy') || '').toLowerCase()
    const frameAncestors = (csp.match(/frame-ancestors([^;]*)/) || [])[1]?.trim() || ''
    // A frame-ancestors directive that does NOT include a wildcard will refuse our (file://-ish,
    // never-allowlisted) presentation origin. X-Frame-Options DENY/SAMEORIGIN refuses outright.
    const xfoRefuses = xfo.includes('deny') || xfo.includes('sameorigin')
    // A frame-ancestors directive with no wildcard (incl. 'none' or a specific host allowlist like
    // Canvas's) will not include our presentation origin, so framing is refused.
    const cspRefuses = frameAncestors !== '' && !frameAncestors.includes('*')
    if (xfoRefuses) return { kind, status: 'refuses-framing', detail: `X-Frame-Options: ${xfo}` }
    if (cspRefuses) return { kind, status: 'refuses-framing', detail: `CSP frame-ancestors ${frameAncestors}` }
    return { kind, status: 'ok', detail: 'Frames OK (no blocking header)' }
  } catch (e) {
    const aborted = (e as { name?: string })?.name === 'AbortError'
    return { kind, status: 'unreachable', detail: aborted ? 'Timed out' : 'Unreachable' }
  }
}

ipcMain.handle('talk:check-embeds', async (_event, outlinePath: string, content: string): Promise<EmbedStatus[]> => {
  const compilerDir = getCompilerPath()
  if (!compilerDir) return []
  try {
    const stat = statSync(outlinePath)
    const slug = basename(outlinePath).replace('-outline.md', '')
    const { prepareSource } = await import(pathToFileURL(join(compilerDir, 'lib/08-source-adapters.mjs')).href)
    const { parseVideoEmbed } = await import(pathToFileURL(join(compilerDir, 'lib/02-triggers-layout.mjs')).href)
    const vaultRoot = vaultRootFor(outlinePath)
    const resolved = vaultRoot ? resolveImageRefs(content, vaultRoot) : content
    const model = await prepareSource(outlinePath, resolved, slug, stat)
    const embeds = extractDeckEmbeds(model.fullHtml || '')
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
  const compilerDir = getCompilerPath()
  if (!compilerDir) return null
  try {
    const stat = statSync(outlinePath)
    const slug = basename(outlinePath).replace('-outline.md', '')
    const vaultRoot = vaultRootFor(outlinePath)
    const resolved = vaultRoot ? resolveImageRefs(content, vaultRoot) : content
    const { prepareSource } = await import(pathToFileURL(join(compilerDir, 'lib/08-source-adapters.mjs')).href)
    const { buildPerSlideProjections } = await import(pathToFileURL(join(compilerDir, 'lib/10-projections.mjs')).href)
    const model = await prepareSource(outlinePath, resolved, slug, stat)
    const rows = (buildPerSlideProjections(model, slug) ?? []) as ProjectionRowMain[]
    const fullHtml = String(model.fullHtml ?? '')
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

// ── Cross-talk search (cached index, ADR-0019) ───────────────────────────────
// Recompiling every talk per keystroke is wasteful. Cache compiled projection rows
// per outline keyed by mtimeMs; reuse unless the file changed since last compile.
// `compilerTag` = the compiler namespace (thumbCacheRoot()) the rows' render_hash values were
// built with; rows from another compiler address thumbnails no build will write (see
// search-index-freshness.ts). Absent on entries persisted before 2026-09-15 → stale.
type SearchCacheEntry = { mtimeMs: number; compilerTag?: string; rows: ProjectionRowMain[]; talkTitle: string; meta?: string }

// Lowercased frontmatter keywords (title/subtitle/event/author/license/…) for the search's metadata
// filter. A single haystack string — the filter is a substring match over it.
function parseTalkMeta(content: string): string {
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!fm) return ''
  const fields = new Set(['title', 'subtitle', 'event', 'author', 'license', 'license-note', 'cta', 'thanks', 'handout_url'])
  const out: string[] = []
  for (const line of fm[1].split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.+)$/)
    if (m && fields.has(m[1])) out.push(m[2].replace(/^["']|["']$/g, ''))
  }
  return out.join(' ').toLowerCase()
}
interface ProjectionRowMain {
  slide_id?: string
  nav_title?: string
  title?: string
  text_excerpt?: string
  section?: string
  source_markdown?: string
  content_hash?: string
  /** Curated slide tags (ADR-0037) — parsed from the Trigger line's `tags=` token by the
   *  compiler's projections; [] when untagged, absent only on pre-tags cached rows. */
  tags?: string[]
  [k: string]: unknown
}
const searchCache = new Map<string, SearchCacheEntry & { slug: string }>()
// Outlines the warm pass could not compile (talk search treats them as read, with no slide text).
const slideTextUnreadable = new Set<string>()

// Persist the compiled index to disk so search is fast on a cold app start, not just
// within one session. Keyed by outlinePath; each entry carries the mtimeMs it was built
// at, so stale entries are recompiled lazily by ensureTalkRows.
function searchIndexFile(): string {
  return join(app.getPath('userData'), 'search-index.json')
}
function loadSearchIndexFromDisk(): void {
  // Read the vault list first: a migration it runs (and the change it emits) happens before the
  // entries load, never after, so it cannot clear them.
  const primaryRoot = currentVaultRoot() ?? null
  try {
    const raw = readFileSync(searchIndexFile(), 'utf8')
    const obj = JSON.parse(raw) as Record<string, SearchCacheEntry & { slug: string }>
    for (const [k, v] of Object.entries(obj)) {
      if (v && Array.isArray(v.rows)) searchCache.set(k, v)
    }
    console.log('[search] loaded ' + searchCache.size + ' talks from disk index')
  } catch { /* no index yet */ }
  // The vault the loaded entries were warmed for; a later change of first open vault clears them.
  lastPrimaryRoot = primaryRoot
}
let persistTimer: ReturnType<typeof setTimeout> | null = null
let persisting = false
let persistAgain = false
function persistSearchIndexSoon(): void {
  if (persistTimer) clearTimeout(persistTimer)
  // The index is the full projection rows (source_markdown included) for every talk — a
  // multi-MB JSON. Serialize + write it OFF the event loop (async write, atomic rename) so a
  // mid-editing re-index never stalls IPC. Overlapping requests coalesce into one trailing write.
  persistTimer = setTimeout(async () => {
    if (persisting) { persistAgain = true; return }
    persisting = true
    try {
      const obj: Record<string, unknown> = {}
      for (const [k, v] of searchCache.entries()) obj[k] = v
      const json = JSON.stringify(obj)
      const tmp = searchIndexFile() + '.tmp'
      const { writeFile, rename } = await import('fs/promises')
      await writeFile(tmp, json, 'utf8')
      await rename(tmp, searchIndexFile())
      // The index is the source of the sidebar's slide counts; tell every window fresh
      // counts exist so a talk-meta fetched BEFORE the warmer finished stops showing "—".
      // Trailing-debounced with the write itself, so editing bursts coalesce to one ping.
      notifyTalkMetaUpdated()
    } catch (e) { console.error('[search] persist failed', e) } finally {
      persisting = false
      if (persistAgain) { persistAgain = false; persistSearchIndexSoon() }
    }
  }, 500)
}

// Compile (or reuse cached) projection rows for one talk. Shared by the live handler and
// the background warmer so they never diverge.
async function ensureTalkRows(
  talk: TalkInfo,
  vaultRoot: string,
  prepareSource: (...a: unknown[]) => Promise<{ [k: string]: unknown }>,
  buildPerSlideProjections: (...a: unknown[]) => ProjectionRowMain[] | null
): Promise<ProjectionRowMain[] | null> {
  if (!existsSync(talk.outlinePath)) return null
  const stat = statSync(talk.outlinePath)
  const entry = searchCache.get(talk.outlinePath)
  const compilerTag = thumbCacheRoot()
  // Fresh = same outline mtime AND same compiler (render_hash is a compiled-model hash; a new
  // compiler renames every changed slide's thumbnail) AND rows carry `tags`.
  if (entry && isSearchIndexEntryFresh(entry, stat.mtimeMs, compilerTag)) {
    // Backfill meta for entries loaded from an older on-disk index (cheap; frontmatter only).
    if (entry.meta === undefined) { try { entry.meta = parseTalkMeta(readFileSync(talk.outlinePath, 'utf8')) } catch { entry.meta = '' } }
    return entry.rows
  }
  const content = readFileSync(talk.outlinePath, 'utf8')
  const resolved = resolveImageRefs(content, vaultRoot)
  // projectionsOnly: search rows are pure TEXT — never inline this talk's media (video/image Buffers)
  // into the main process. A whole-vault warm/search over a heavy-media vault used to OOM-crash here.
  const model = await prepareSource(talk.outlinePath, resolved, talk.slug, stat, undefined, { projectionsOnly: true })
  const rows = buildPerSlideProjections(model, talk.slug)
  if (!rows) return null
  searchCache.set(talk.outlinePath, { mtimeMs: stat.mtimeMs, compilerTag, rows, talkTitle: talk.title, slug: talk.slug, meta: parseTalkMeta(content) })
  persistSearchIndexSoon()
  return rows
}

// Build/refresh the whole index in the background. Runs at startup and after vault change
// so the first ⌘K is instant (warm cache ~10ms) instead of recompiling 13 talks (~5s).
let warming = false
async function warmSearchIndex(): Promise<void> {
  if (warming) return
  // An unavailable vault is not indexed (invariant 5): know which folders answer before scanning.
  await checkVaultAvailability().catch(() => false)
  if (warming) return
  const vaultRoot = currentVaultRoot()
  const compilerDir = getCompilerPath()
  if (!vaultRoot || !compilerDir) return
  warming = true
  try {
    const { prepareSource } = await import(pathToFileURL(join(compilerDir, 'lib/08-source-adapters.mjs')).href)
    const { buildPerSlideProjections } = await import(pathToFileURL(join(compilerDir, 'lib/10-projections.mjs')).href)
    // Every open vault's talks (the Talks panel shows slide counts and Recent across all of them).
    const roots = [vaultRoot, ...availableVaults().filter((v) => v.root !== vaultRoot).map((v) => v.root)]
    for (const root of roots) for (const talk of findTalks(root)) {
      // A talk the compiler cannot read counts as read (no slide text) for talk search, so its
      // "Reading slide text" line ends and searches stop restarting this pass for it.
      try {
        const rows = await ensureTalkRows(talk, root, prepareSource, buildPerSlideProjections)
        if (rows) slideTextUnreadable.delete(talk.outlinePath)
        else slideTextUnreadable.add(talk.outlinePath)
      } catch { slideTextUnreadable.add(talk.outlinePath) }
    }
    console.log('[search] index warmed: ' + searchCache.size + ' talks')
  } catch (e) {
    console.error('[search] warm failed', e)
  } finally {
    warming = false
  }
}

// Pre-generate per-slide thumbnails for changed/new talks (ADR-0019: cross-Talk search is "backed
// by pre-generated thumbnails"). A persisted outline-content ledger prevents the expensive
// synchronous compiler pass from running for an unchanged talk whose cache directory still exists.
// Changed talks are staggered so input can run between main-process compiler passes.
let prerendering = false
async function prerenderAllThumbnails(): Promise<void> {
  if (prerendering) return
  const vaultRoot = currentVaultRoot()
  const compilerDir = getCompilerPath()
  if (!vaultRoot || !compilerDir) return
  prerendering = true
  try {
    const { prepareSource } = await import(pathToFileURL(join(compilerDir, 'lib/08-source-adapters.mjs')).href)
    const { buildPerSlideProjections } = await import(pathToFileURL(join(compilerDir, 'lib/10-projections.mjs')).href)
    const talks = findTalks(vaultRoot)
    const ledgerPath = join(app.getPath('userData'), 'prerender-ledger.json')
    const ledger = loadPrerenderLedger(ledgerPath)
    let done = 0
    let compiled = 0
    for (const talk of talks) {
      try {
        if (!existsSync(talk.outlinePath)) continue
        const content = readFileSync(talk.outlinePath, 'utf8')
        const contentHash = contentHashForPrerender(content)
        const cacheDir = talkThumbCacheDir(talk.outlinePath, talk.slug)
        if (!shouldPrerenderTalk(ledger, talk.outlinePath, contentHash, cacheDir)) continue
        if (compiled > 0) await new Promise<void>((resolve) => setTimeout(resolve, 250))
        await new Promise<void>((resolve) => setImmediate(resolve))
        compiled += 1
        const stat = statSync(talk.outlinePath)
        const resolved = resolveImageRefs(content, vaultRoot)
        const model = await prepareSource(talk.outlinePath, resolved, talk.slug, stat)
        const rows = (buildPerSlideProjections(model, talk.slug) ?? []) as Array<{
          content_hash?: string
          render_hash?: string
          thumbnail_hash?: string
          slide_id?: string
          layout?: string
          triggers?: Record<string, string>
        }>
        // SAME key precedence as the live `talk:thumbnails` handler (render_hash first) —
        // the prerender used to key on content_hash only, so any slide with a layout/trigger
        // (render_hash ≠ content_hash) missed the warm cache and re-rendered on first open.
        const fullHtml = model.fullHtml as string
        const documentId = thumbnailDocumentId(fullHtml)
        const slides = thumbnailSlides(rows, documentId)
        const rendered = slides.length
          ? await renderThumbnails({ fullHtml, slides, cacheDir })
          : (mkdirSync(cacheDir, { recursive: true }), {})
        if (!slides.every((slide) => rendered[slide.key])) continue
        recordSuccessfulPrerender(ledger, talk.outlinePath, contentHash, documentId)
        savePrerenderLedger(ledgerPath, ledger)
        done += 1
      } catch { /* skip a talk that fails to render */ }
    }
    console.log('[thumbnails] pre-generated for ' + done + ' changed talks; skipped ' + (talks.length - compiled) + ' unchanged talks')
  } catch (e) {
    console.error('[thumbnails] prerender failed', e)
  } finally {
    prerendering = false
  }
}

// ── OCR (image-text) search — native macOS Vision via the bundled `ocr` helper ───────────────────
// "Basic image text search" in TalkWeaver itself (ADR-0026 revised): OCR every vault image once,
// cache the text by file path+mtime, and fold it into the search haystack so a query word that only
// appears INSIDE a slide's image still finds the slide. SlideWell will later own a richer index;
// this is the good-enough-now version with no third-party deps (Vision is built into macOS).
const ocrCache = new Map<string, { mtimeMs: number; text: string }>()
let ocrCacheLoaded = false
let ocring = false
const slideOcrMemo = new Map<string, string>() // slideKey → lowercased OCR text (cleared on cache change)

function ocrCacheFile(): string { return join(app.getPath('userData'), 'ocr-cache.json') }
function loadOcrCache(): void {
  if (ocrCacheLoaded) return
  ocrCacheLoaded = true
  try {
    const obj = JSON.parse(readFileSync(ocrCacheFile(), 'utf8')) as Record<string, { mtimeMs: number; text: string }>
    for (const [k, v] of Object.entries(obj)) ocrCache.set(k, v)
  } catch { /* no cache yet */ }
}
let ocrPersistTimer: ReturnType<typeof setTimeout> | null = null
function persistOcrCacheSoon(): void {
  if (ocrPersistTimer) clearTimeout(ocrPersistTimer)
  ocrPersistTimer = setTimeout(() => {
    try { writeFileSync(ocrCacheFile(), JSON.stringify(Object.fromEntries(ocrCache)), 'utf8') } catch { /* ignore */ }
  }, 1500)
}
// Packaged: <Resources>/ocr; dev (electron .): repo native/ocr (out/main → ../../native/ocr).
function resolveOcrBin(): string | null {
  const candidates = [
    join(process.resourcesPath || '', 'ocr'),
    join(__dirname, '../../native/ocr'),
    join(__dirname, '../../../native/ocr')
  ]
  for (const c of candidates) { try { if (c && existsSync(c)) return c } catch { /* ignore */ } }
  return null
}
// The native media helper (ADR-0028): GIF→MP4 conversion + poster extraction. Same resolution as OCR.
function resolveMediaBin(): string | null {
  const candidates = [
    join(process.resourcesPath || '', 'media'),
    join(__dirname, '../../native/media'),
    join(__dirname, '../../../native/media')
  ]
  for (const c of candidates) { try { if (c && existsSync(c)) return c } catch { /* ignore */ } }
  return null
}
// Run the media helper and parse its single JSON result line. Never throws.
function runMediaBin(args: string[]): Promise<{ ok: boolean; [k: string]: unknown }> {
  const bin = resolveMediaBin()
  if (!bin) return Promise.resolve({ ok: false, error: 'media helper not found' })
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 180000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      const line = String(stdout || '').trim().split('\n').filter(Boolean).pop() || ''
      try { resolve(JSON.parse(line)) } catch { resolve({ ok: false, error: err ? String(err.message) : 'no output' }) }
    })
  })
}
// Stream a sha256 over a file (videos can be large) → 7-hex content id, never loading it whole.
function hashFileSoon(p: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    const s = createReadStream(p)
    s.on('error', reject)
    s.on('data', (d) => h.update(d))
    s.on('end', () => resolve(h.digest('hex').slice(0, 7)))
  })
}
// OCR a batch of image paths via the helper (chunked to keep argv sane). Updates the cache.
async function ocrBatch(paths: string[]): Promise<void> {
  const bin = resolveOcrBin()
  if (!bin || paths.length === 0) return
  const CHUNK = 80
  for (let i = 0; i < paths.length; i += CHUNK) {
    const chunk = paths.slice(i, i + CHUNK)
    const stdout = await new Promise<string>((resolve) => {
      execFile(bin, chunk, { maxBuffer: 64 * 1024 * 1024, timeout: 120000 }, (err, out) => resolve(err ? '' : String(out || '')))
    })
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue
      try {
        const obj = JSON.parse(line) as { p: string; t: string }
        let mtimeMs = 0
        try { mtimeMs = statSync(obj.p).mtimeMs } catch { /* file may be gone */ }
        ocrCache.set(obj.p, { mtimeMs, text: obj.t || '' })
      } catch { /* skip a bad line */ }
    }
  }
  slideOcrMemo.clear()
  persistOcrCacheSoon()
}
const IMG_EXTS = new Set(['.webp', '.png', '.jpg', '.jpeg', '.gif'])
// Gather every image file under the vault pool (_assets) + each talk's assets/ dir.
function gatherVaultImages(vaultRoot: string): string[] {
  const out: string[] = []
  const scanDir = (dir: string): void => {
    let entries: string[]
    try { entries = readdirSync(dir) } catch { return }
    for (const name of entries) {
      const full = join(dir, name)
      try { if (statSync(full).isFile() && IMG_EXTS.has(extname(name).toLowerCase())) out.push(full) } catch { /* ignore */ }
    }
  }
  scanDir(join(vaultRoot, '_assets'))
  for (const talk of findTalks(vaultRoot)) scanDir(join(dirname(talk.outlinePath), 'assets'))
  return out
}
// Background pass: OCR every vault image not already cached (or changed). Idempotent + cached.
async function ocrAllVaultImages(): Promise<void> {
  if (ocring) return
  // Opt-in (default off): OCR of every vault image is the heaviest background pass and only powers
  // image-text search. On a large imported vault it saturates the machine, so it never runs unless
  // Dominik turns it on (SCALE policy, 2026-07-20).
  if (!getConfig('ocrEnabled', false)) return
  const vaultRoot = currentVaultRoot()
  if (!vaultRoot || !resolveOcrBin()) return
  ocring = true
  try {
    loadOcrCache()
    const all = gatherVaultImages(vaultRoot)
    const todo = all.filter((p) => {
      const c = ocrCache.get(p)
      if (!c) return true
      try { return statSync(p).mtimeMs !== c.mtimeMs } catch { return false }
    })
    if (todo.length) {
      console.log('[ocr] indexing ' + todo.length + ' image(s)…')
      await ocrBatch(todo)
      console.log('[ocr] done (' + ocrCache.size + ' images cached)')
    }
  } catch (e) { console.error('[ocr] pass failed', e) } finally { ocring = false }
}
// Resolve a slide image ref to an absolute file path (img-id → pool; relative → talk dir; decoded).
function resolveImageAbs(ref: string, talkDir: string, vaultRoot: string): string | null {
  let s = ref.trim().replace(/\s+"[^"]*"$/, '')
  if (/^(https?:|data:)/.test(s)) return null
  s = s.replace(/^img-img-([0-9a-f]{7})$/, 'img-$1')
  if (/^img-[0-9a-f]{7}$/.test(s)) {
    for (const ext of ['webp', 'png', 'jpg', 'jpeg', 'gif']) {
      const p = join(vaultRoot, '_assets', s + '.' + ext)
      if (existsSync(p)) return p
    }
    return null
  }
  try { s = decodeURIComponent(s) } catch { /* keep raw */ }
  return s.startsWith('/') ? s : join(talkDir, s)
}
// The cached OCR text for one slide's images (lowercased), memoized by a stable slide key.
function slideOcrText(row: ProjectionRowMain, talkDir: string, vaultRoot: string): string {
  // Keyed per vault: the same slide text in two vaults can point at different image files.
  const key = vaultRoot + '\u0000' + String(row.content_hash || row.slide_id || '')
  const memo = slideOcrMemo.get(key)
  if (memo !== undefined) return memo
  const md = String(row.source_markdown || '')
  let text = ''
  for (const m of md.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
    const abs = resolveImageAbs(m[1], talkDir, vaultRoot)
    if (abs) { const c = ocrCache.get(abs); if (c && c.text) text += '\n' + c.text }
  }
  text = text.toLowerCase()
  slideOcrMemo.set(key, text)
  return text
}

// Manual trigger for the OCR index (command palette) — runs the same cached pass and reports counts.
ipcMain.handle('talk:ocr-index', async () => {
  const vaultRoot = currentVaultRoot()
  if (!vaultRoot) return { success: false, error: 'No vault root' }
  if (!resolveOcrBin()) return { success: false, error: 'OCR helper not found (rebuild the app)' }
  loadOcrCache()
  const before = ocrCache.size
  await ocrAllVaultImages()
  const total = gatherVaultImages(vaultRoot).length
  return { success: true, total, cached: ocrCache.size, added: ocrCache.size - before }
})

// The structured search the renderer sends (mirrors slideBrowserModel.ParsedQuery). A bare
// string is the legacy all-fields all-words form — kept so older callers and the diagnose
// harnesses that invoke tw.search.allSlides('word') still work unchanged.
type SearchQuery = { scope: 'all' | 'title' | 'body' | 'image'; exact: boolean; text: string; terms: string[] }
function normalizeSearchQuery(q: unknown): SearchQuery {
  if (typeof q === 'string') {
    return { scope: 'all', exact: false, text: q, terms: q.toLowerCase().split(/\s+/).filter(Boolean) }
  }
  const o = (q ?? {}) as Partial<SearchQuery>
  const scope = o.scope === 'title' || o.scope === 'body' || o.scope === 'image' ? o.scope : 'all'
  const text = typeof o.text === 'string' ? o.text : ''
  const terms = Array.isArray(o.terms) ? o.terms.filter((t): t is string => typeof t === 'string' && t !== '') : []
  return { scope, exact: Boolean(o.exact), text, terms }
}
// Does a lowercased haystack satisfy the query? Exact → the phrase must appear contiguously; else
// every term must appear (order-independent). An empty phrase / empty term list matches all.
function matchHay(hayLower: string, q: SearchQuery): boolean {
  if (q.exact) return hayLower.includes(q.text.toLowerCase())
  return q.terms.every((t) => hayLower.includes(t))
}

// Talk search over IPC (ADR-0029 §1): the Talks browser today, the picker's "Find a talk" next.
// options.vaultIds (a list) searches those vaults, merged in that order; an empty list searches
// nothing. An unavailable, closed or unknown vault is not searched (invariant 5).
ipcMain.handle('talks:search', async (_event, query: unknown, options: unknown) => {
  const opts = options && typeof options === 'object' ? options as { vaultId?: unknown; vaultIds?: unknown; within?: unknown } : {}
  const empty = emptyTalkSearchResult(typeof query === 'string' ? query : '', typeof opts.within === 'string' ? opts.within : null)
  if (Array.isArray(opts.vaultIds)) {
    const searches = opts.vaultIds.map((id) => (typeof id === 'string' && id ? talkSearchFor(id) : null)).filter((x): x is NonNullable<typeof x> => !!x)
    if (!searches.length) return empty
    return mergeTalkSearchResults(await Promise.all(searches.map((search) => handleTalkSearchRequest(search, query, options))))
  }
  const search = talkSearchFor(opts.vaultId)
  return search ? handleTalkSearchRequest(search, query, options) : empty
})
// The fo: completion source (ADR-0029 §2): folders at every depth with their talk counts, from
// the same talk scan the search uses (vault:list-folders stops at depth 3).
ipcMain.handle('talks:folders', () => talkSearch.folders())

// Talks browser folders stay open or closed as left, across restarts (ADR-0029 §3).
const talkFolderState = createTalkFolderStateStore({
  vaultRoot: () => currentVaultRoot() ?? null,
  readValue: () => readConfig().talkListFolders,
  writeValue: (value) => writeConfig({ talkListFolders: value })
})
ipcMain.handle('talks:folder-state', () => {
  try { return talkFolderState.read() } catch { return {} }
})
ipcMain.handle('talks:set-folder-state', (_event, changes: unknown) => {
  try { return talkFolderState.write(changes) } catch { return {} }
})

// options.vaultIds limits the search to those open vaults (vault-scope.ts searchVaults); without it,
// the first open vault as before. Rows carry the vaultId of their talk.
ipcMain.handle('search:all-slides', async (_event, query: string | SearchQuery, options?: unknown) => {
  const vaults = searchVaults(vaultRegistry.list().filter((v) => !vaultAvailability.isUnavailable(v.id)), options)
  if (!vaults.length) return options ? [] : null
  const compilerDir = getCompilerPath()
  if (!compilerDir) return null
  loadOcrCache()
  try {
    const results: Array<ProjectionRowMain & { vaultId: string; talkSlug: string; talkTitle: string; outlinePath: string; talkMtimeMs: number; talkMeta: string; titleHit: boolean }> = []
    // Scoped, all-words (or exact-phrase) match. The four searchable fields are the slide TITLE
    // (nav_title + title), the slide BODY (full source_markdown), and the IMAGE text (cached OCR of
    // the slide's images) — Section/subsection are deliberately NOT searched (they are a UI filter;
    // matching them made search far too broad). scope picks which field(s) the query is tested
    // against; scope 'all' is today's behaviour (all four at once). Empty query → every slide.
    const q = normalizeSearchQuery(query)
    const adaptersUrl = pathToFileURL(join(compilerDir, 'lib/08-source-adapters.mjs')).href
    const projectionsUrl = pathToFileURL(join(compilerDir, 'lib/10-projections.mjs')).href
    const { prepareSource } = await import(adaptersUrl)
    const { buildPerSlideProjections } = await import(projectionsUrl)

    for (const { id: vaultId, root: vaultRoot } of vaults) for (const talk of findTalks(vaultRoot)) {
      try {
        const rows = await ensureTalkRows(talk, vaultRoot, prepareSource, buildPerSlideProjections)
        if (!rows) continue
        const cached = searchCache.get(talk.outlinePath)
        const talkMtimeMs = cached?.mtimeMs ?? 0
        const talkMeta = cached?.meta ?? ''
        const talkDir = dirname(talk.outlinePath)
        for (const row of rows) {
          const titleHay = `${row.nav_title || ''}\n${row.title || ''}`.toLowerCase()
          const bodyHay = String(row.source_markdown || '').toLowerCase()
          const imageHay = slideOcrText(row, talkDir, vaultRoot) // already lowercased
          const fieldHay =
            q.scope === 'title' ? titleHay
              : q.scope === 'body' ? bodyHay
                : q.scope === 'image' ? imageHay
                  : `${titleHay}\n${bodyHay}\n${imageHay}`
          if (matchHay(fieldHay, q)) {
            // titleHit drives the renderer's title-priority ranking: a title-scoped hit is a title
            // hit by definition; otherwise it is whether the query also matches the title field.
            const titleHit = q.scope === 'title' ? true : matchHay(titleHay, q)
            results.push({
              ...row,
              vaultId,
              talkSlug: talk.slug,
              talkTitle: talk.title,
              outlinePath: talk.outlinePath,
              talkMtimeMs,
              talkMeta,
              titleHit
            })
          }
        }
      } catch { /* skip failed talks */ }
    }
    return results
  } catch (e) {
    console.error('[search:all-slides]', e)
    return null
  }
})

// ── Outline read/write ─────────────────────────────────────────────────────

// ── Outline v2 migration offer (heading-is-slide, Task 9) ───────────────────
// Opening a talk whose outline is not stamped `outline_version: 2` offers a ONE-TIME
// (per talk, per app run) migration to the new grammar. Decline opens unmigrated —
// the compiler still renders best-effort and emits its `legacy-outline` warning.
// Accept runs the same migrateOutline the CLI uses, writes a `.bak` of the original
// BESIDE the outline FIRST, then the migrated text — and refuses outright if the
// migrated text is structurally empty (same predicate as the talk:write-outline
// data-loss backstop: a migration must never produce an empty file).
const migrationOffered = new Set<string>()

function outlineHasV2Stamp(text: string): boolean {
  const m = text.match(/^﻿?---[^\S\n]*\n([\s\S]*?)\n---/)
  if (!m) return false
  return /^\s*outline[_-]version\s*:\s*["']?2["']?\s*$/m.test(m[1])
}

// Harness/automation guard: every e2e harness launches Electron with --user-data-dir
// (never used by real dev or packaged runs), and the recording harness sets TW_REC_TEST.
// A modal dialog would hang those runs. TW_MIGRATE_PROMPT=0 is the explicit off-switch.
function migrationPromptSuppressed(): boolean {
  return (
    process.env.TW_E2E === '1' ||
    process.env.TW_REC_TEST === '1' ||
    process.env.TW_MIGRATE_PROMPT === '0' ||
    app.commandLine.hasSwitch('user-data-dir')
  )
}

async function maybeOfferOutlineMigration(outlinePath: string, text: string): Promise<string> {
  if (outlineHasV2Stamp(text)) return text
  if (migrationPromptSuppressed()) return text
  if (migrationOffered.has(outlinePath)) return text
  migrationOffered.add(outlinePath) // ask once per talk per app run, whatever the answer
  const compilerDir = getCompilerPath()
  if (!compilerDir) return text
  let migrateOutline: (t: string) => { text: string; changed: boolean; report: string[] }
  try {
    const mod = await import(pathToFileURL(join(compilerDir, 'migrate-outline.mjs')).href)
    migrateOutline = mod.migrateOutline
  } catch (e) {
    console.error('[outline-migrate] cannot load migrate-outline.mjs', e)
    return text
  }
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const opts: Electron.MessageBoxOptions = {
    type: 'question',
    buttons: ['Migrate', 'Not now'],
    defaultId: 0,
    cancelId: 1,
    message: 'Migrate this talk to the new outline format?',
    detail: 'A backup copy (.bak) will be kept beside the outline.'
  }
  const { response } = win
    ? await dialog.showMessageBox(win, opts)
    : await dialog.showMessageBox(opts)
  if (response !== 0) return text // declined: open unmigrated
  try {
    // TOCTOU guard: the modal can sit open for minutes while another window (multi-window
    // is supported) autosaves this same outline. Migrating the bytes read BEFORE the dialog
    // would clobber those edits — and the .bak would preserve only the stale pre-dialog
    // text. So on accept: re-read the file, re-check the stamp (someone may have migrated
    // it meanwhile), and migrate the FRESH bytes; the .bak gets the fresh pre-migration text.
    let fresh = text
    try { fresh = readFileSync(outlinePath, 'utf8') } catch { /* keep the original read */ }
    // Never trust an empty re-read over a non-empty original (the 2026-07-05 emptied-outline
    // incident class): a concurrent transient truncation here would make migrateOutline('')
    // emit a stamp-only outline and put EMPTY bytes in the .bak.
    if (isStructurallyEmptyOutline(fresh) && !isStructurallyEmptyOutline(text)) fresh = text
    if (outlineHasV2Stamp(fresh)) return fresh // already migrated elsewhere — nothing to do
    const result = migrateOutline(fresh)
    if (!result || typeof result.text !== 'string' || !result.changed) return fresh
    if (isStructurallyEmptyOutline(result.text)) {
      // Never let a migration empty a file — surface it, keep the original untouched.
      console.error(`[outline-migrate] REFUSED structurally-empty migration result for ${outlinePath}`)
      dialog.showErrorBox(
        'Migration refused',
        'The migration produced an empty outline, so nothing was written. The talk opens unmigrated.'
      )
      return fresh
    }
    writeFileSync(`${outlinePath}.bak`, fresh, 'utf8') // backup FIRST, then the migrated text
    // Open-time: the buffer does not exist yet, so this writes the file (talk-writer.ts, never routed).
    const migrated = await writeTalkOutline(outlinePath, result.text, 'migration')
    if (!migrated.ok) throw new Error(migrated.error)
    console.log(`[outline-migrate] migrated ${outlinePath} (${result.report.length} change(s); backup: ${outlinePath}.bak)`)
    return result.text
  } catch (e) {
    console.error('[outline-migrate] migration failed; opening unmigrated', e)
    dialog.showErrorBox(
      'Migration failed',
      'The outline could not be migrated and was left untouched. The talk opens unmigrated.'
    )
    return text
  }
}

// `forEditor`: the editor window is loading this talk (Editor.tsx) — the text it gets is the external-
// change guard's baseline for the file (outline-disk-guard.ts). Every other reader leaves it alone.
ipcMain.handle('talk:read-outline', async (event, outlinePath: string, opts?: { forEditor?: boolean }) => {
  const refusal = outlineRefused(outlinePath) // writes beside the outline: refuse one outside the vault
  if (refusal) return null
  try {
    const text = await readFileAsync(outlinePath, 'utf8')
    const loaded = await maybeOfferOutlineMigration(outlinePath, text)
    if (opts?.forEditor === true && typeof loaded === 'string') {
      // Only the window that has claimed this talk (window:claim-talk) becomes its guard owner.
      const claimed = editorWindows.get(event.sender.id)?.outlinePath
      if (claimed && outlineIdentity(claimed).key === outlineIdentity(outlinePath).key) {
        outlineDiskGuard.track(String(event.sender.id), outlinePath, loaded)
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
  try { return await outlineDiskGuard.diskVersion(outlinePath) } catch { return null }
})
ipcMain.handle('talk:outline-accept-disk', async (event, outlinePath: unknown, hash: unknown, opts?: { keepPending?: boolean }) => {
  if (typeof outlinePath !== 'string' || !outlinePath || typeof hash !== 'string') return { ok: false, change: null, error: 'Nothing to accept.' }
  if (!outlineDiskGuard.owns(String(event.sender.id), outlinePath)) {
    return { ok: false, change: null, error: 'This window does not have that talk open, so nothing was accepted.' }
  }
  try { return await outlineDiskGuard.accept(outlinePath, hash, { keepPending: opts?.keepPending === true }) } catch (e) {
    return { ok: false, change: null, error: e instanceof Error ? e.message : String(e) }
  }
})
// Recovery copies (outline-recovery.ts): the text a refused save kept, for the talk this window has
// open (the bar's "Restore my unsaved text"), and dropping it (restored and saved, or Discard).
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
  try { await outlineRecovery.clear(canonicalOutlinePath(outlinePath)) } catch { /* best effort */ }
  return true
})
// The renderer resolved the close sheet (Reload or Keep mine completed): close for real, and finish
// the quit that asked for it.
// The renderer received outline:close-requested (its sheet is up): the 5-second fallback is off.
ipcMain.handle('window:close-request-ack', (event) => {
  clearTimeout(closeHolds.get(event.sender.id))
  closeHolds.delete(event.sender.id)
  return true
})
ipcMain.handle('window:confirm-close', (event, opts?: { quit?: boolean }) => {
  const entry = editorWindows.get(event.sender.id)
  if (!entry || entry.win.isDestroyed()) return false
  closeConfirmed.add(event.sender.id)
  if (opts?.quit === true) app.quit()
  else entry.win.close()
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
ipcMain.handle('talk:write-outline', async (_event, outlinePath: string, content: string) => {
  // An outline outside the current vault (a window still holding a talk from a previous vault):
  // nothing is written, and the editor is told in the same shape as the empty-write backstop.
  const saveRefusal = outlineSaveRefusal(vaultRootFor(outlinePath), outlinePath)
  if (saveRefusal) return saveRefusal
  // HARD BACKSTOP: refuse to write a structurally-empty payload OVER a file that still holds real
  // content. This is the last line of defence against the data-loss bug (a full 58-slide outline was
  // emptied to 0 bytes during Slide Focus testing, then auto-committed by reposync). Absent/empty
  // targets and any structurally-valid write pass straight through, so no legitimate save is blocked.
  if (isStructurallyEmptyOutline(content)) {
    let existing = ''
    try { existing = readFileSync(outlinePath, 'utf8') } catch { /* absent = nothing to protect */ }
    if (existing.trim() !== '') {
      console.warn(emptyOverNonemptyMessage(outlinePath, content, existing))
      return { ok: false as const, refused: 'empty-over-nonempty' as const }
    }
  }
  // Heading-is-slide model (Task 8): every heading gets an {id=…} before the ledger ever sees
  // it — a save is the ONLY point new headings (typed post-migration) get stamped. Stamping goes
  // through the engine's write-back channel (setSlideId/mergeTriggerAtLine in 12-outline-edit.mjs),
  // never a raw splice here, so idProtect semantics apply. Best-effort: a stamping failure must
  // never block a save — the unstamped content still writes, and ledgering simply skips those
  // heading(s) until a later save succeeds. Runs strictly AFTER the empty-over-nonempty backstop
  // above: a refused payload is never stamped, and stampMissingIds cannot manufacture content
  // (no headings in → no-op out), so the backstop's verdict is always on the caller's own bytes.
  //
  // ID CHURN GUARD (two layers, both required):
  //  1. `preferred` — ids the PREVIOUS save minted (read from the on-disk file, matched by
  //     normalised heading + occurrence) are REUSED for still-unstamped headings, so a renderer
  //     buffer that never adopted the last stamp converges on the same ids instead of re-minting
  //     new ones every save (which would fragment each slide's ledger history).
  //  2. The stamped text is returned to the caller (`content` field below) so the renderer can
  //     adopt it into the editor buffer and stop sending unstamped text at all.
  let toWrite = content
  let stampedContent: string | null = null
  try {
    const compilerDir = getCompilerPath()
    if (compilerDir) {
      const mod = await import(pathToFileURL(join(compilerDir, 'lib/12-outline-edit.mjs')).href)
      let preferred: Map<string, string> | null = null
      try { preferred = mod.preferredIdsFromText(readFileSync(outlinePath, 'utf8')) } catch { /* new file: nothing to reuse */ }
      const stamped = mod.stampMissingIds(content, undefined, { preferred })
      if (stamped?.text && stamped.stamped?.length) {
        toWrite = stamped.text
        stampedContent = stamped.text
      }
    }
  } catch { /* stamping must never block a save */ }
  // The editor's own queued save: written to disk (atomically, under the file's lock), never routed.
  const written = await writeTalkOutline(outlinePath, toWrite, 'editor')
  if (!written.ok && written.changedOnDisk) {
    // External-change guard: the file differs from what the editor holds. Nothing was written; the
    // renderer shows the bar (the change is named by the path this window uses). The editor's text is
    // kept in a recovery copy meanwhile, so a forced quit or a crash before the choice loses nothing.
    lastUnsavedText.set(canonicalOutlinePath(outlinePath), toWrite)
    await outlineRecovery.save(canonicalOutlinePath(outlinePath), toWrite).catch((e) => console.error('[outline-recovery] save', e))
    return { ok: false as const, refused: 'changed-on-disk' as const, change: { ...written.changedOnDisk, outlinePath } }
  }
  if (!written.ok) {
    const real = canonicalOutlinePath(outlinePath)
    if (outlineDiskGuard.tracks(real)) {
      // Any failed save of a guarded (open) talk keeps the editor's text in a recovery copy.
      lastUnsavedText.set(real, toWrite)
      await outlineRecovery.save(real, toWrite).catch((e) => console.error('[outline-recovery] save', e))
      // The person chose (Keep mine / Save it again) and that save failed: the bar stays, saying why.
      const pending = outlineDiskGuard.pending(outlinePath)
      if (pending) return { ok: false as const, refused: 'changed-on-disk' as const, change: { ...pending, outlinePath, saveError: written.error } }
    }
    return false
  }
  // Saved: an older recovery copy of this talk is no longer needed.
  lastUnsavedText.delete(canonicalOutlinePath(outlinePath))
  await outlineRecovery.clear(canonicalOutlinePath(outlinePath)).catch(() => undefined)
  notifyPathwaysChanged(outlinePath)
  // Share for comments: a shared talk pushes this save in the background (switch 1). Returns at
  // once and never throws — a push failure lands on the share, never on the save.
  try { sharedTalks().noteSaved(outlinePath, toWrite) } catch { /* sharing must never break a save */ }
  // ADR-0024: this is the app-edit event that enrolment is keyed on — a real save, made here.
  try { noteAppEdit(outlinePath) } catch { /* backup bookkeeping must never break a save */ }
  // Ledger records only on a REAL write (a refused write above returns before here). Records the
  // STAMPED content so newly-minted ids are ledgered in the same save that created them.
  const collisions = await ledgerRecord(outlinePath, toWrite)
  // `content` present only when stamping changed the bytes — the renderer adopts it into the
  // editor buffer (Editor.tsx) so the next save sends already-stamped text.
  return stampedContent === null
    ? { ok: true, collisions }
    : { ok: true, collisions, content: stampedContent }
})

// ── Metadata Registry surfaces (ADR-0036) ───────────────────────────────────
// The registry (src/shared/metadata-registry.ts) declares every key; here live the vault-wide
// services: the doctor (unregistered-key scan), the open-vocabulary aggregator, the per-outline
// ignore list, and the in-place frontmatter editor (the generalised retitleOutline).

// Full-frontmatter parse — top-level `key:` lines only (indented lines belong to the key above).
function frontmatterPairs(text: string): Array<{ key: string; value: string }> {
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!fm) return []
  const pairs: Array<{ key: string; value: string }> = []
  for (const line of fm[1].split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+):[ \t]*(.*)$/)
    if (m) pairs.push({ key: m[1], value: m[2].trim().replace(/^["']|["']$/g, '').trim() })
  }
  return pairs
}

// Handlers that write the outline or files beside it (dist/, handouts, assets, present files,
// thumbnails) take the outline path from the renderer: before anything is written, any path that is
// not an `*-outline.md` whose real path is inside the current vault is refused. Each handler returns
// the refusal in its OWN reply shape — never a throw, which would reach the renderer as a rejected
// invoke (a second window still holding a talk from a previous vault would lose its typing silently).
function outlineRefused(outlinePath: unknown): string | null {
  return outlineRefusal(vaultRootFor(typeof outlinePath === 'string' ? outlinePath : null), outlinePath)
}

function insideVault(outlinePath: string): boolean {
  if (typeof outlinePath !== 'string' || !outlinePath) return false
  const hit = vaultRegistry.resolve(resolvePath(outlinePath))
  return !!hit && hit.vault.open && hit.rel !== ''
}

// Per-outline "Keep (ignore)" list — keys the user chose to leave undeclared. Registering a key
// is a development act (it needs an explanation and a vocabulary), so the panel's counterpart
// action records the key here and the doctor stops flagging it. userData, not the vault: the
// list is a per-machine triage note, not talk content.
type MetadataIgnore = Array<{ outline: string; key: string }>
function metadataIgnorePath(): string {
  return join(app.getPath('userData'), 'metadata-ignore.json')
}
function readMetadataIgnore(): MetadataIgnore {
  try {
    const parsed = JSON.parse(readFileSync(metadataIgnorePath(), 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch { return [] }
}

// 5s-cached doctor scan (same TTL pattern as the talk cache; vault mutations invalidate both).
type DoctorReport = Array<{
  talk: string
  slug: string
  outlinePath: string
  unregistered: Array<{ key: string; value: string }>
}>
let metadataScanCache: { root: string; at: number; doctor: DoctorReport; vocabulary: Record<string, Array<{ value: string; count: number }>> } | null = null
function invalidateMetadataCaches(): void {
  metadataScanCache = null
}
function metadataScan(root: string): NonNullable<typeof metadataScanCache> {
  if (metadataScanCache && metadataScanCache.root === root && Date.now() - metadataScanCache.at < TALK_CACHE_TTL_MS) {
    return metadataScanCache
  }
  const registered = registeredKeyNames()
  const openKeys = openVocabularyFrontmatterKeys()
  const ignore = readMetadataIgnore()
  const doctor: DoctorReport = []
  const counts: Record<string, Map<string, number>> = {}
  for (const k of openKeys) counts[k] = new Map()
  for (const talk of findTalks(root)) {
    let text = ''
    try { text = readFileSync(talk.outlinePath, 'utf8') } catch { continue }
    const rel = relativePath(root, talk.outlinePath)
    const unregistered: Array<{ key: string; value: string }> = []
    for (const { key, value } of frontmatterPairs(text)) {
      if (openKeys.includes(key) && value) {
        counts[key].set(value, (counts[key].get(value) ?? 0) + 1)
      }
      if (!registered.has(key) && !ignore.some((i) => i.outline === rel && i.key === key)) {
        unregistered.push({ key, value })
      }
    }
    if (unregistered.length > 0) {
      doctor.push({ talk: talk.title, slug: talk.slug, outlinePath: talk.outlinePath, unregistered })
    }
  }
  const vocabulary: Record<string, Array<{ value: string; count: number }>> = {}
  for (const [k, m] of Object.entries(counts)) {
    vocabulary[k] = [...m.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
  }
  metadataScanCache = { root, at: Date.now(), doctor, vocabulary }
  return metadataScanCache
}

type LayoutDoctorTalk = { talk: string; slug: string; outlinePath: string; findings: LayoutDoctorFinding[] }
let layoutScanCache: { root: string; at: number; report: LayoutDoctorTalk[] } | null = null
function invalidateLayoutDoctorCache(): void { layoutScanCache = null }
function layoutScan(root: string): LayoutDoctorTalk[] {
  if (layoutScanCache && layoutScanCache.root === root && Date.now() - layoutScanCache.at < TALK_CACHE_TTL_MS) {
    return layoutScanCache.report
  }
  const report: LayoutDoctorTalk[] = []
  for (const talk of findTalks(root)) {
    let text = ''
    try { text = readFileSync(talk.outlinePath, 'utf8') } catch { continue }
    const findings = scanOutlineTriggers(text, LAYOUT_DOCTOR_VOCABULARY)
    if (findings.length > 0) report.push({ talk: talk.title, slug: talk.slug, outlinePath: talk.outlinePath, findings })
  }
  layoutScanCache = { root, at: Date.now(), report }
  return report
}

// Doctor: every outline's unresolved trigger findings. The panel filters to one talk; the
// vault view shows the whole report. Main only reports — fixes go through the editor.
ipcMain.handle('layout:doctor', () => {
  const root = currentVaultRoot()
  return root ? layoutScan(root) : []
})

// Doctor: every outline's unregistered frontmatter keys (respecting the ignore list). The panel
// filters to one talk; a future vault-health surface can show the whole report. NO auto-fixing
// here — main only reports; removal goes through metadata:edit-frontmatter on explicit request.
ipcMain.handle('metadata:doctor', () => {
  const root = currentVaultRoot()
  return root ? metadataScan(root).doctor : []
})

// Open-vocabulary values observed across the vault: { event: [{ value, count }, …], … }.
ipcMain.handle('metadata:vocabulary', () => {
  const root = currentVaultRoot()
  return root ? metadataScan(root).vocabulary : {}
})

// "Keep (ignore)": record an unregistered key for this outline so the doctor stops flagging it.
ipcMain.handle('metadata:ignore-key', (_event, outlinePath: string, key: string) => {
  const root = vaultRootFor(outlinePath)
  if (!root || !insideVault(outlinePath) || typeof key !== 'string' || !/^[A-Za-z0-9_-]+$/.test(key)) {
    return { ok: false as const }
  }
  const rel = relativePath(resolvePath(root), resolvePath(outlinePath))
  const list = readMetadataIgnore()
  if (!list.some((i) => i.outline === rel && i.key === key)) {
    list.push({ outline: rel, key })
    try {
      writeFileSync(metadataIgnorePath(), JSON.stringify(list, null, 2), 'utf8')
    } catch (e) {
      console.error('[metadata:ignore-key]', e)
      return { ok: false as const }
    }
  }
  invalidateMetadataCaches()
  invalidateLayoutDoctorCache()
  return { ok: true as const }
})

// In-place frontmatter edit — the Metadata panel's single write path. Reads the CURRENT file
// (the renderer flushes its autosave first for the active talk), applies the edits, and returns
// the full new text so the caller can adopt it into the editor buffer (the publish-handout
// adoption pattern — otherwise the next autosave would overwrite this write).
ipcMain.handle(
  'metadata:edit-frontmatter',
  async (_event, outlinePath: string, edits: Array<{ key: string; value: string | null; aliases?: string[] }>) => {
    if (!insideVault(outlinePath) || !Array.isArray(edits) || edits.length === 0) {
      return { ok: false as const, error: 'bad-request' }
    }
    for (const e of edits) {
      if (typeof e?.key !== 'string' || !/^[A-Za-z0-9_-]+$/.test(e.key)) return { ok: false as const, error: 'bad-key' }
      if (e.value !== null && typeof e.value !== 'string') return { ok: false as const, error: 'bad-value' }
    }
    try { readFileSync(outlinePath, 'utf8') } catch { return { ok: false as const, error: 'unreadable' } }
    // The talk's current text — the open editor's buffer when a window has it (talk-writer.ts).
    const written = await writeTalkOutline(outlinePath, (text) => editFrontmatterText(text, edits), 'frontmatter')
    if (!written.ok) {
      console.error('[metadata:edit-frontmatter]', written.error)
      return { ok: false as const, error: 'write-failed' }
    }
    if (!written.changed) return { ok: true as const, content: written.text, changed: false as const }
    const next = written.text
    frontmatterCache.delete(outlinePath) // sidebar meta must not serve the pre-edit head
    invalidateTalkCache(outlinePath)
    invalidateMetadataCaches()
    invalidateLayoutDoctorCache()
    return { ok: true as const, content: next, changed: true as const }
  }
)

// ── Slide tags IPC (ADR-0037) ────────────────────────────────────────────────
// Tags live on each slide's Trigger line (`tags=a,b`, per-occurrence, lowercase-kebab). The
// ADR-0010 §5: this already uses the shared-safe engine editor rather than renderer string logic.
// The write is applySlideTags — token-precise, merge-only, id-guard-safe (own-group
// rendering, other tokens verbatim). House rules follow ledger:adopt: every target outline must
// resolve inside the vault or the whole call is rejected; per-outline failures are isolated;
// the caller (renderer) flushes its autosave FIRST for the active talk and re-reads/adopts the
// rewritten text afterwards (the publish-handout adoption pattern).

type TagTarget = { outline: string; id?: string | null; heading?: string; occurrence?: number }

ipcMain.handle(
  'tags:apply',
  async (_event, targets: TagTarget[], add: string[], remove: string[]) => {
    if (!Array.isArray(targets) || targets.length === 0) return null
    if (!Array.isArray(add) || !Array.isArray(remove)) return null
    if (add.some((t) => typeof t !== 'string') || remove.some((t) => typeof t !== 'string')) return null
    const vaultRoot = writableVaultRoot()
    const compilerDir = getCompilerPath()
    if (!vaultRoot || !compilerDir) return null
    try {
      const mod = await import(pathToFileURL(join(compilerDir, 'lib/12-outline-edit.mjs')).href)
      const addNorm: string[] = add.map((t) => mod.normalizeTag(t)).filter(Boolean)
      const removeNorm: string[] = remove.map((t) => mod.normalizeTag(t)).filter(Boolean)
      if (addNorm.length === 0 && removeNorm.length === 0) {
        return { ok: false as const, reason: 'no-tags' }
      }
      // Path-traversal guard over the WHOLE batch before any write (ledger:adopt rule).
      const rootAbs = resolvePath(vaultRoot)
      const byOutline = new Map<string, TagTarget[]>()
      for (const t of targets) {
        if (!t || typeof t.outline !== 'string' || !t.outline) return null
        if (t.id != null && (typeof t.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(t.id))) return null
        if (t.id == null && typeof t.heading !== 'string') return null
        const abs = resolvePath(vaultRoot, t.outline)
        if (abs !== rootAbs && !abs.startsWith(rootAbs + pathSep)) return null
        const list = byOutline.get(abs)
        if (list) list.push(t)
        else byOutline.set(abs, [t])
      }
      const applied: Array<{ outline: string; tags: string[][] }> = []
      const failed: Array<{ outline: string; error: string }> = []
      for (const [abs, outlineTargets] of byOutline) {
        try {
          // Applied to the talk's current text — the open editor's buffer when a window has it
          // (talk-writer.ts). finalTags is from the run that produced the written text.
          let finalTags: string[][] = []
          const applyTags = (original: string): string => {
            let text = original
            finalTags = []
            for (const target of outlineTargets) {
              // Refs are recomputed against the CURRENT text each step: applySlideTags may scrub
              // a hand-authored heading tags token, which changes that heading's verbatim line.
              const refs: Array<{ heading: string; occurrence: number }> =
                target.id != null ? mod.blockRefsForId(text, target.id) : []
              if (refs.length === 0 && typeof target.heading === 'string' && target.heading) {
                refs.push({ heading: target.heading, occurrence: target.occurrence ?? 1 })
              }
              if (refs.length === 0) throw new Error(`slide not found (id=${target.id ?? '—'})`)
              const eol = mod.dominantEol(text)
              for (const ref of refs) {
                const result = mod.applySlideTags(text, ref, { add: addNorm, remove: removeNorm }, eol)
                text = result.text
                finalTags.push(result.tags)
              }
            }
            return text
          }
          const written = await writeTalkOutline(abs, applyTags, 'tags')
          if (!written.ok) throw new Error(written.error)
          if (written.changed) {
            // Same post-write housekeeping as talk:write-outline: ledger the save (best-effort)
            // and drop the search-cache entry so the Browser reflects the new tags on next query.
            try { await ledgerRecord(abs, written.text) } catch { /* ledgering must never fail the write */ }
            try { searchCache.delete(abs) } catch { /* cache only */ }
          }
          applied.push({ outline: abs, tags: finalTags })
        } catch (e) {
          failed.push({ outline: abs, error: e instanceof Error ? e.message : String(e) })
        }
      }
      // Re-warm the dropped entries in the background so tags:vocabulary stays live.
      void warmSearchIndex()
      return { ok: true as const, applied, failed }
    } catch (e) {
      console.error('[tags:apply]', e)
      return null
    }
  }
)

// Every tag observed across the vault with occurrence counts — the pickers' autocomplete.
// Reads the live search index (projection rows carry `tags`); entries mid-recompile simply
// contribute on the next call. warmSearchIndex keeps it current after writes/vault changes.
ipcMain.handle('tags:vocabulary', () => {
  const rows: Array<string[] | undefined> = []
  for (const entry of searchCache.values()) {
    for (const row of entry.rows) rows.push(row.tags)
  }
  void warmSearchIndex() // ripen any stale/pre-tags entries for the next call
  return vocabularyFromTagLists(rows)
})

// ── Slide Ledger IPC (ADR-0032) ─────────────────────────────────────────────

ipcMain.handle('ledger:where-used', async (_event, id: string) => {
  // Renderer-supplied id reaches a path join under the vault; reject anything
  // that is not a plain id token (e.g. "../../..") before it can escape.
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id)) return []
  try {
    const vaultRoot = currentVaultRoot()
    const lib = await ledgerLib()
    return vaultRoot && lib ? lib.whereUsed(vaultRoot, id) : []
  } catch { return [] }
})

ipcMain.handle('ledger:versions', async (_event, id: string) => {
  // Same path-traversal guard as ledger:where-used.
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id)) return []
  try {
    const vaultRoot = currentVaultRoot()
    const lib = await ledgerLib()
    return vaultRoot && lib ? lib.listVersions(vaultRoot, id) : []
  } catch { return [] }
})

ipcMain.handle('ledger:detach', async (_event, outlinePath: string, content: string, ref: { heading: string; occurrence: number }) => {
  const refusal = outlineRefused(outlinePath) // writes beside the outline: refuse one outside the vault
  if (refusal) return null
  const compilerDir = getCompilerPath()
  if (!compilerDir) return null
  try {
    const mod = await import(pathToFileURL(join(compilerDir, 'lib/12-outline-edit.mjs')).href)
    const vaultRoot = vaultRootFor(outlinePath)
    const lib = await ledgerLib()
    // Detached against the talk's current text — the open editor's buffer when a window has it
    // (talk-writer.ts). The lineage hint must be the FIRST ledger record of the new id: on the editor
    // route it is recorded before the editor's own save ledgers the text.
    const detached: { result: { text: string; newId: string; oldId: string } | null; hinted: boolean } = { result: null, hinted: false }
    const recordHint = (text: string): void => {
      const result = detached.result
      if (detached.hinted || !result || !vaultRoot || !lib) return
      detached.hinted = true
      lib.recordOutlineSave(vaultRoot, outlinePath, text, {
        now: Date.now(),
        lineageHints: new Map([[result.newId, result.oldId]])
      })
    }
    const written = await writeTalkOutline(outlinePath, (current) => {
      detached.result = mod.detachSlideId(current, ref) ?? null
      if (!detached.result) throw new Error('slide not found')
      return detached.result.text
    }, 'ledger-detach', { beforeEditorApply: recordHint })
    if (!written.ok || !detached.result) return null
    recordHint(written.text)
    return detached.result
  } catch { return null }
})

// ── Slide propagation IPC (ADR-0032/ADR-0034) ───────────────────────────────
// Thin wrappers over the engine's 14-slide-propagation.mjs (status / diff / adopt).
// Same house rules as the other ledger handlers: id validated against the plain-token
// regex before any path work, and every failure returns null/empty — never a throw
// that could reach the renderer.
async function propagationLib(): Promise<any | null> {
  const compilerDir = getCompilerPath()
  if (!compilerDir) return null
  return import(pathToFileURL(join(compilerDir, 'lib/14-slide-propagation.mjs')).href)
}

ipcMain.handle('ledger:status', async (_event, id: string, adoptMarkdown: string) => {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id)) return null
  try {
    const vaultRoot = currentVaultRoot()
    const lib = await propagationLib()
    if (!vaultRoot || !lib) return null
    return lib.slideStatus(vaultRoot, id, String(adoptMarkdown ?? ''))
  } catch { return null }
})

ipcMain.handle('ledger:diff', async (_event, a: string, b: string) => {
  try {
    const lib = await propagationLib()
    return lib ? lib.lineDiff(String(a ?? ''), String(b ?? '')) : []
  } catch { return [] }
})

// The engine's outline reads and writes (14-slide-propagation / 15-slide-merge `io`) go through the
// one writer (talk-writer.ts): an open talk is read from and written through its editor buffer.
function talkOutlineIO(origin: TalkWriteOrigin) {
  return {
    read: (abs: string) => readTalkOutline(abs),
    write: (abs: string, transform: (current: string) => string, opts?: TalkWriteOptions) => writeTalkOutline(abs, transform, origin, opts),
  }
}

ipcMain.handle('ledger:adopt', async (_event, id: string, versionMarkdown: string, targetOutlines: string[]) => {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id)) return null
  if (!Array.isArray(targetOutlines) || targetOutlines.some((t) => typeof t !== 'string')) return null
  try {
    const vaultRoot = writableVaultRoot()
    const lib = await propagationLib()
    if (!vaultRoot || !lib) return null
    // Path-traversal guard: targets are vault-relative outline paths (as whereUsed/slideStatus
    // return them); every one must resolve INSIDE the vault or the whole call is rejected —
    // adoption writes files, so no partial acceptance of a tampered batch.
    const rootAbs = resolvePath(vaultRoot)
    for (const t of targetOutlines) {
      const abs = resolvePath(vaultRoot, t)
      if (!abs.startsWith(rootAbs + pathSep)) return null
    }
    const result = await lib.adoptVersion(vaultRoot, id, String(versionMarkdown ?? ''), targetOutlines, { io: talkOutlineIO('ledger-adopt') })
    // Adoption rewrote those outlines on disk behind the search index's back — drop the
    // affected talks' cache entries (same invalidation vault:set-root relies on) so the
    // Browser reflects the adopted content on its next query.
    for (const r of result?.replaced ?? []) {
      try { searchCache.delete(join(vaultRoot, r.outline)) } catch { /* cache only */ }
    }
    return result
  } catch { return null }
})

// ── Duplicate merge IPC (ADR-0032) ──────────────────────────────────────────
// Thin wrapper over the engine's 15-slide-merge.mjs. Same house rules as ledger:adopt: EVERY
// target outline must resolve inside the vault (whole call rejected → null on any escape, no
// partial acceptance of a tampered batch), and every failure returns null — never a throw into
// the renderer. Targets arrive with `outline` as an absolute path or a vault-relative path (the
// Browser rows carry outlinePath); we guard, then relativise, so the engine always sees a clean
// vault-relative outline (its join(vaultRoot, outline) assumes that).
async function mergeLib(): Promise<any | null> {
  const compilerDir = getCompilerPath()
  if (!compilerDir) return null
  return import(pathToFileURL(join(compilerDir, 'lib/15-slide-merge.mjs')).href)
}

ipcMain.handle(
  'ledger:merge-duplicates',
  async (_event, targets: Array<{ outline: string; heading: string; occurrence: number }>) => {
    if (!Array.isArray(targets) || targets.length === 0) return null
    if (targets.some((t) => !t || typeof t.outline !== 'string' || typeof t.heading !== 'string')) return null
    try {
      const vaultRoot = writableVaultRoot()
      const lib = await mergeLib()
      if (!vaultRoot || !lib) return null
      const rootAbs = resolvePath(vaultRoot)
      // Guard every target inside the vault, then normalise `outline` to vault-relative.
      const safeTargets: Array<{ outline: string; heading: string; occurrence: number }> = []
      for (const t of targets) {
        const abs = resolvePath(vaultRoot, t.outline)
        if (abs !== rootAbs && !abs.startsWith(rootAbs + pathSep)) return null
        safeTargets.push({
          outline: relativePath(vaultRoot, abs),
          heading: t.heading,
          occurrence: Number.isFinite(t.occurrence) ? t.occurrence : 1
        })
      }
      const result = await lib.mergeDuplicateSlides(vaultRoot, safeTargets, { now: Date.now(), io: talkOutlineIO('ledger-merge') })
      // Merge rewrote those outlines behind the search index's back — drop the affected talks'
      // cache entries (same invalidation ledger:adopt relies on) so the Browser reflects the shared
      // id on its next query. Applies to every touched outline, merged or failed-after-write.
      const touched = new Set<string>()
      for (const r of result?.merged ?? []) touched.add(r.outline)
      for (const r of result?.failed ?? []) touched.add(r.outline)
      for (const rel of touched) {
        try { searchCache.delete(join(vaultRoot, rel)) } catch { /* cache only */ }
      }
      return result
    } catch { return null }
  }
)

// Version thumbnails for one slide id: a real compiled render of EVERY recorded version,
// following the layout:preview-thumbnails pattern — synthetic outline → prepareSource →
// buildPerSlideProjections → renderThumbnails. All versions ride in ONE synthetic outline
// (newest first, listVersions order), so the whole id renders in a single hidden-window
// pass; navigateToSlide toggles .active by INDEX, so versions sharing the same {id=…}
// cannot mis-navigate. Content-addressed under cacheSlug '__ledger__' by
// sha1(version.file + version.markdown) — re-opening a version history is cache-free.
ipcMain.handle('ledger:version-thumbnails', async (_event, id: string) => {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id)) return null
  const compilerDir = getCompilerPath()
  if (!compilerDir) return null
  try {
    const vaultRoot = currentVaultRoot()
    const lib = await ledgerLib()
    if (!vaultRoot || !lib) return null
    const versions = (lib.listVersions(vaultRoot, id) ?? []) as Array<{ file: string; markdown: string }>
    if (!versions.length) return {}

    const { prepareSource } = await import(pathToFileURL(join(compilerDir, 'lib/08-source-adapters.mjs')).href)
    const { buildPerSlideProjections } = await import(pathToFileURL(join(compilerDir, 'lib/10-projections.mjs')).href)

    const keyFor = (v: { file: string; markdown: string }): string =>
      createHash('sha1').update(v.file + v.markdown).digest('hex').slice(0, 16)
    const cacheSlug = '__ledger__'
    const cacheDir = join(app.getPath('userData'), thumbCacheRoot(), cacheSlug)

    const outline =
      '---\ntitle: version preview\n---\n\n' + versions.map((v) => v.markdown).join('\n\n') + '\n'
    // Pool refs (img-/vid-) resolve against the vault so version renders show their images;
    // relative assets/ refs cannot resolve from a temp dir and render as-is (acceptable: the
    // version store keeps markdown only, exactly like the diff view).
    const resolved = resolveImageRefs(outline, vaultRoot)
    const work = join(tmpdir(), `tw-version-thumbs-${randomBytes(6).toString('hex')}`)
    mkdirSync(work, { recursive: true })
    const outlinePath = join(work, `${cacheSlug}-outline.md`)
    writeFileSync(outlinePath, resolved, 'utf8')
    const stat = statSync(outlinePath)
    const model = await prepareSource(outlinePath, resolved, cacheSlug, stat)
    const rows = (buildPerSlideProjections(model, cacheSlug) ?? []) as Array<{
      source_line?: number | null
      render_hash?: string
      content_hash?: string
    }>

    // renderThumbnails addresses slides by deck INDEX, so pass every row in order; authored
    // rows (source_line set) map 1:1, in order, onto the versions that produced them —
    // synthesized cover/closing rows keep their own render_hash key and are simply unused.
    const authoredIndexes = rows
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => r.source_line != null)
      .map(({ i }) => i)
    const keyByRowIndex = new Map<number, string>()
    authoredIndexes.forEach((rowIndex, vi) => {
      if (vi < versions.length) keyByRowIndex.set(rowIndex, keyFor(versions[vi]))
    })
    const slides = rows.map((r, i) => ({
      key: keyByRowIndex.get(i) ?? r.render_hash ?? r.content_hash ?? `row-${i}`
    }))
    const rendered = await renderThumbnails({ fullHtml: model.fullHtml as string, slides, cacheDir })

    const out: Record<string, string> = {}
    versions.forEach((v, vi) => {
      if (vi >= authoredIndexes.length) return
      const key = keyFor(v)
      if (rendered[key]) out[v.file] = 'twthumb://' + cacheSlug + '/' + key
    })
    try { rmSync(work, { recursive: true, force: true }) } catch { /* temp only */ }
    return out
  } catch (e) {
    console.error('[ledger:version-thumbnails]', e)
    return null
  }
})

// ── Present ────────────────────────────────────────────────────────────────

type PresentBuild = { slug: string; title: string; html: string; presentPath: string; preworkSlideIds?: string[]; slideOrder?: Array<{ id: string; title: string }>; startSlideId?: string }

async function compileTalkForPresent(outlinePath: string, content: string): Promise<Omit<PresentBuild, 'presentPath'>> {
  // Goes through the shared prepared-model memo: F5 right after an edit pause (same content the
  // strip just compiled with different defaults) still recompiles, but repeated F5s don't.
  const prepared = await prepareTalk(outlinePath, content, timerSettings())
  if (!prepared) throw new Error('Compiler not found')
  // Ticket 08: the talk's pre-work section (compiler model.prework) — its slides are answered
  // before the session and never presented.
  const prework = prepared.model.prework as { slideIds?: unknown } | undefined
  const preworkSlideIds = Array.isArray(prework?.slideIds) ? prework.slideIds.filter((id): id is string => typeof id === 'string') : []
  return {
    slug: prepared.slug,
    title: String((prepared.model.title as string) ?? prepared.slug),
    html: String(prepared.model.fullHtml ?? ''),
    preworkSlideIds,
    slideOrder: (Array.isArray(prepared.model.slides) ? prepared.model.slides as Array<{ id?: unknown; title?: unknown }> : [])
      .map((slide) => ({ id: String(slide.id ?? ''), title: String(slide.title ?? '') }))
  }
}

function writeTalkPresentHtml(outlinePath: string, slug: string, html: string, allowTmpFallback: boolean, pathwayId?: string): string {
  const talkDir = dirname(outlinePath)
  const pathwaySuffix = pathwayId ? '-pathway-' + pathwayId.replace(/[^a-zA-Z0-9_-]/g, '-') : ''
  let presentPath = join(talkDir, slug + pathwaySuffix + '-present.html')
  try {
    writeFileSync(presentPath, html, 'utf8')
  } catch (writeErr) {
    if (!allowTmpFallback) throw writeErr
    console.warn('[present] talk dir not writable, using tmpdir (iframes may 404):', writeErr)
    presentPath = join(tmpdir(), slug + pathwaySuffix + '-present.html')
    writeFileSync(presentPath, html, 'utf8')
  }
  return presentPath
}

async function buildTalkPresentFile(outlinePath: string, content: string, allowTmpFallback: boolean, pathwayId?: string, startSlideId?: string): Promise<PresentBuild> {
  let compiled = await compileTalkForPresent(outlinePath, content)
  // Fix round S4: present-from-here on a pre-work step starts at the first talk slide after the
  // section, and the presenter's status line says so.
  const start = presentStartOutsidePrework(compiled.slideOrder ?? [], compiled.preworkSlideIds ?? [], startSlideId)
  if (start.notice) compiled = { ...compiled, html: injectPresenterNotice(compiled.html, start.notice) }
  if (pathwayId) {
    const vaultRoot = vaultRootFor(outlinePath)
    if (!vaultRoot) throw new Error('Choose a Vault before presenting a pathway.')
    const prepared = await prepareTalk(outlinePath, content, timerSettings())
    const manifest = readPathwayManifest(vaultRoot, compiled.slug)
    const resolved = resolvePathways(manifest.pathways, (prepared?.rows ?? []) as PathwaySlideRow[])
      .find((pathway) => pathway.id === pathwayId)
    if (!resolved) throw new Error('That pathway no longer exists.')
    const preworkIds = new Set(compiled.preworkSlideIds ?? [])
    compiled = {
      ...compiled,
      html: injectPathwayRuntime(compiled.html, resolved.present.map((row) => row.slide_id).filter((id) => !preworkIds.has(id)), pathwayId)
    }
  } else if (compiled.preworkSlideIds?.length) {
    // Ticket 08: presenting skips the pre-work steps (the talk's own slide sequence never has them).
    compiled = { ...compiled, html: withoutPresenterSlides(compiled.html, compiled.preworkSlideIds) }
  }
  const presentPath = writeTalkPresentHtml(outlinePath, compiled.slug, compiled.html, allowTmpFallback, pathwayId)
  return { ...compiled, presentPath, startSlideId: start.slideId }
}

function talkBySlug(slug: string): TalkInfo | null {
  const vaultRoot = currentVaultRoot()
  if (!vaultRoot) return null
  return findTalks(vaultRoot).find((talk) => talk.slug === slug) ?? null
}

ipcMain.handle('talk:present', async (_event, outlinePath: string, content: string, mode?: string, startSlideId?: string, pathwayId?: string, plannedRunId?: string) => {
  const refusal = outlineRefused(outlinePath) // writes beside the outline: refuse one outside the vault
  if (refusal) return { success: false, error: refusal }
  const blocked = unresolvedOutboundFailure(content)
  if (blocked) return blocked
  try {
    const build = await buildTalkPresentFile(outlinePath, content, true, pathwayId, startSlideId)
    const { slug, title, presentPath } = build
    startSlideId = build.startSlideId
    const localHandoutPath = join(dirname(outlinePath), 'dist', `${slug}-handout.html`)
    const publishedUrl = readHandoutUrl(content)
      ?? (existsSync(localHandoutPath) ? pathToFileURL(localHandoutPath).href : null)
    // Window title by role + talk (e.g. "TalkWeaver Presenter — AI 2026 Agents") so ⌘` / Mission
    // Control / the Window menu name each deck by what's in it. Kept via page-title-updated below.
    const roleLabel = mode === 'presenter' ? 'Presenter' : mode === 'audience' ? 'Audience' : 'Presentation'
    const winTitle = `TalkWeaver ${roleLabel} — ${title}`

    // Reuse an existing deck window for this talk+mode instead of spawning a duplicate: focus it and
    // refresh it in place with the freshly-compiled file. ⇧F5 (startSlideId set) jumps it to that
    // slide; plain F5 keeps its current slide. If a recording is armed, DON'T reload (that would drop
    // it) — just focus and hint. Menu-launched audience windows dedupe the same way (repeated clicks
    // used to multiply them); the runtime-launched audience (F5 inside the presenter) is a child
    // window that never comes through this handler.
    if (mode === 'presenter' || mode === 'window' || mode === 'audience') {
      for (const [wcId, info] of presentWindows) {
        if (info.outlinePath !== outlinePath || info.mode !== mode || info.pathwayId !== pathwayId) continue
        const existing = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.id === wcId)
        if (!existing) continue
        let hash = startSlideId || ''
        let rec = ''
        try {
          const s = await existing.webContents.executeJavaScript(
            "({ h: location.hash.startsWith('#') ? decodeURIComponent(location.hash.slice(1)) : '', r: ((document.getElementById('twrec-module')||{}).dataset||{}).rec || '' })"
          )
          if (!hash) hash = s.h
          rec = s.r
        } catch { /* fall through: refresh from the top */ }
        if (existing.isMinimized()) existing.restore()
        if (mode === 'presenter') livePresenterContexts.set(wcId, { talkSlug: slug, shortUrl: publishedUrl })
        existing.setTitle(winTitle)
        existing.focus()
        const recordingArmed = rec && rec !== 'idle' && rec !== 'saved' && rec !== 'error'
        if (recordingArmed) {
          existing.webContents.send('present:hint', 'Already presenting — stop the recording (⇧R) to refresh this deck.')
        } else {
          // Cache-bust (_r) so the reused window truly reloads the freshly-compiled file.
          const reuseQuery: Record<string, string> =
            mode === 'presenter' ? { presenter: '1' } : mode === 'audience' ? { audience: '1' } : {}
          reuseQuery._r = String(++presentReloadNonce)
          const reuseOpts: { query: Record<string, string>; hash?: string } = { query: reuseQuery }
          if (hash) reuseOpts.hash = hash
          existing.loadFile(presentPath, reuseOpts)
          existing.webContents.once('did-finish-load', () => {
            if (!existing.isDestroyed()) existing.webContents.send('present:hint', '✓ Refreshed with your latest edits')
          })
          void ledgerSeal(outlinePath, content, 'present')
        }
        return { success: true }
      }
    }
    // Recording lives in the presenter view only: attach the opt-in recorder bridge preload there
    // (sandbox off so it can hand the audio buffer back). The recorder bridge ALSO mounts the ⌘E
    // "edit this slide" bridge. A plain presentation window gets the edit-only bridge; the audience
    // view stays preload-less + portable. (These windows are opened BY TalkWeaver, so a preload here
    // never touches the exported portable artifact.)
    const recording = mode === 'presenter'
    const bridgePreload =
      mode === 'presenter' ? join(__dirname, '../preload/presentRecorder.js')
      : mode === 'audience' ? null
      : join(__dirname, '../preload/presentEdit.js')
    const win = new BrowserWindow({
      width: 1440, height: 900, fullscreen: false,
      ...(E2E ? { show: false } : {}),
      title: winTitle,
      backgroundColor: '#f7f3ea',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        ...(E2E ? { backgroundThrottling: false } : {}),
        ...(bridgePreload ? { preload: bridgePreload, sandbox: false } : {})
      }
    })
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
      registerRecordingContext(wcId, {
        talkSlug: slug,
        talkTitle: title,
        timerTargetMin: timerSettings().warnAtMinutes,
        pathwayId: pathwayId ?? null,
        preferredPlannedRunId: plannedRunId ?? null
      })
      win.on('closed', () => unregisterRecordingContext(wcId))
    }
    // mode: 'presenter' → presenter view (notes + controls); 'audience' → chromeless audience view;
    // anything else → the plain presentation window. The deck runtime reads ?presenter=1 / ?audience=1.
    const query: Record<string, string> | undefined = mode === 'presenter' ? { presenter: '1' } : mode === 'audience' ? { audience: '1' } : undefined
    // ⇧F5 present-from-here: the runtime reads location.hash on init and starts on the slide whose
    // dataset.id matches the id (09-output-builders.mjs). An unknown/empty id falls back to slide 0.
    const loadOpts: { query?: Record<string, string>; hash?: string } = {}
    if (query) loadOpts.query = query
    if (startSlideId) loadOpts.hash = startSlideId
    win.loadFile(presentPath, Object.keys(loadOpts).length ? loadOpts : undefined)
    // Track this deck for ⌘R refresh-in-place, and OWN ⌘R here: before-input-event preempts the
    // default menu's Reload accelerator (which would reload to slide 0 without recompiling).
    const deckWcId = win.webContents.id
    presentWindows.set(deckWcId, { outlinePath, mode: mode ?? 'window', pathwayId })
    if (mode === 'presenter') livePresenterContexts.set(deckWcId, { talkSlug: slug, shortUrl: publishedUrl })
    win.on('close', (event) => {
      const record = attachLiveWindow(deckWcId)
      const live = !!record && !['ended', 'expired'].includes(record.status)
      const offerRunSave = shouldOfferRunSave(deckWcId)
      const audioArmed = recordingAudioArmed(deckWcId)
      if (!live && !offerRunSave && !audioArmed) return
      event.preventDefault()
      sendRecordingCloseOffer(win, { live, offerRunSave, audioArmed })
    })
    win.on('closed', () => {
      liveSessions?.detach(deckWcId)
      presentWindows.delete(deckWcId)
      livePresenterContexts.delete(deckWcId)
    })
    // F5 in the presenter opens the audience view (its Audience button); ⇧F5 there, F5 / ⇧F5 in the
    // other deck windows and ⌘R everywhere refresh the deck in place (deck-window-keys.ts).
    // preventDefault here also keeps the menu's F5 "Present from the top" from firing.
    win.webContents.on('before-input-event', (event, input) => {
      const action = deckWindowKeyAction(deckWindowMode(mode), input)
      if (!action) return
      event.preventDefault()
      if (action === 'open-audience') {
        win.webContents.executeJavaScript(OPEN_AUDIENCE_SCRIPT, true).catch((e) => console.warn('[present] F5 audience failed:', e))
      } else {
        void refreshDeckFromEditor(win)
      }
    })
    // F5 in the presenter opens the audience view via window.open(?audience=1). Send it FULL-SCREEN
    // to a second display if one exists; otherwise leave it as a normal window on this screen.
    // The board's own window is a blank page the presenter window draws into (feedback-boards ticket
    // 05); under its name nothing else opens.
    win.webContents.setWindowOpenHandler((details) => details.frameName === 'tw-board-window' && details.url !== 'about:blank' ? { action: 'deny' } : ({
      action: 'allow',
      ...(E2E ? {
        overrideBrowserWindowOptions: {
          show: false,
          webPreferences: { backgroundThrottling: false }
        }
      } : {})
    }))
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
      if (!details?.url || !details.url.includes('audience=1')) return
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
    void ledgerSeal(outlinePath, content, 'present')
    return { success: true }
  } catch (e) {
    console.error('[present]', e)
    return { success: false, error: String(e) }
  }
})

// The presenter's More → Refresh with latest edits (presenter redesign ticket 05): the same
// refresh-in-place ⌘R runs, for the deck window that asked.
ipcMain.handle('present:refresh-deck', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win && !win.isDestroyed()) await refreshDeckFromEditor(win)
})

// ⌘E in a live deck window (presenter / presentation window): bring the editor window to the front
// and jump it to this slide. The bridge sends the deck's current slide — its ledger id AND compiled
// index — and the renderer resolves whichever it can. The deck window is left open (recording, if
// any, keeps running); the user closes it themselves. No-op if the editor window is gone.
ipcMain.handle('present:edit-slide', (event, payload: { slideId?: string; index?: number }) => {
  // Target the editor window that has this deck's talk active (or the last-focused one as fallback).
  const deckInfo = presentWindows.get(event.sender.id)
  const win = targetEditorFor(deckInfo?.outlinePath ?? null)
  if (!win || win.isDestroyed()) return { ok: false }
  if (win.isMinimized()) win.restore()
  if (!E2E) win.show()
  win.focus()
  win.webContents.send('present:edit-slide', payload)
  return { ok: true }
})

// New editor window (⌘N) — for working on two presentations at once. A given talk can only be active
// in one window (window:claim-talk enforces it), so two windows always hold two different talks.
ipcMain.handle('window:new', () => { createWindow(); return { ok: true } })

// Same-talk guard (block-and-focus). The renderer calls this before switching a window to `outlinePath`.
// If ANOTHER editor window already has that talk active, focus it and refuse (the renderer keeps its
// current talk); otherwise record it as this window's active talk. null releases (window has no talk).
ipcMain.handle('window:claim-talk', (event, outlinePath: string | null) => {
  const entry = editorWindows.get(event.sender.id)
  // Opening a talk does not enrol it, but it does keep an enrolled talk alive (ADR-0024 §2).
  if (outlinePath) { try { noteAppOpen(outlinePath) } catch { /* never block opening a talk */ } }
  // Compared by file identity (device + inode), so a talk reached through a symlinked outline or
  // folder, or through a second hard link, is still one talk: two windows on one file would hold two
  // buffers and two save queues (ticket 07, third review; one-writer spec D3).
  if (outlinePath) {
    const holder = otherEditorHolding(outlinePath, entry?.win)
    if (holder) {
      if (holder.isMinimized()) holder.restore()
      if (!E2E) holder.show()
      holder.focus()
      return { ok: false, reason: 'open-elsewhere' }
    }
  }
  if (entry) {
    // The outgoing talk is no longer watched for outside changes (its baseline is kept for a grace
    // period, so its last flush save is still checked); the editor's load of the new talk tracks it.
    if (entry.outlinePath && entry.outlinePath !== outlinePath) outlineDiskGuard.release(String(event.sender.id))
    entry.outlinePath = outlinePath
  }
  return { ok: true }
})

// Refresh-in-place (⌘R): the editor hands back the talk's current content; recompile it and reload
// the deck window at the slide it was on. Reuses the present-from-here hash so the reload lands in
// place. The preload persists across loadFile, so the ⌘E/⌘R bridges re-mount automatically.
ipcMain.handle('present:rebuild', async (_event, deckWcId: number, outlinePath: string, content: string, slideId?: string) => {
  const refusal = outlineRefused(outlinePath) // writes beside the outline: refuse one outside the vault
  if (refusal) return { ok: false, error: refusal }
  const block = unresolvedTriggerBlock(content)
  if (block) return { ok: false, error: block.message }
  try {
    const deck = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.id === deckWcId)
    if (!deck) return { ok: false }
    const info = presentWindows.get(deckWcId)
    const { presentPath } = await buildTalkPresentFile(outlinePath, content, true, info?.pathwayId)
    const mode = info?.mode
    // Cache-bust (_r) so this is a REAL navigation, not a same-URL no-op that skips the fresh file.
    const query: Record<string, string> = mode === 'presenter' ? { presenter: '1' } : mode === 'audience' ? { audience: '1' } : {}
    query._r = String(++presentReloadNonce)
    const loadOpts: { query: Record<string, string>; hash?: string } = { query }
    if (slideId) loadOpts.hash = slideId
    deck.loadFile(presentPath, loadOpts)
    // Confirm once the fresh page has loaded (the bridge re-mounts + registers its hint listener by then).
    deck.webContents.once('did-finish-load', () => {
      if (!deck.isDestroyed()) deck.webContents.send('present:hint', '✓ Refreshed with your latest edits')
    })
    return { ok: true }
  } catch (e) {
    console.error('[present:rebuild]', e)
    return { ok: false, error: String(e) }
  }
})

ipcMain.handle('replay:build', async (_event, talkSlug: string): Promise<{ success: boolean; url?: string; error?: string }> => {
  try {
    const slug = String(talkSlug || '').trim()
    if (!slug) return { success: false, error: 'Missing Talk slug' }
    const talk = talkBySlug(slug)
    if (!talk) return { success: false, error: 'Talk not found' }
    const content = readFileSync(talk.outlinePath, 'utf8')
    const blocked = unresolvedOutboundFailure(content)
    if (blocked) return blocked
    const built = await buildTalkPresentFile(talk.outlinePath, content, false)
    return {
      success: true,
      url: `twpresent://${encodeURIComponent(built.slug)}/${encodeURIComponent(basename(built.presentPath))}?replay=1&audience=1`
    }
  } catch (e) {
    console.error('[replay:build]', e)
    return { success: false, error: String(e) }
  }
})

// Presentation recording IPC (recording:context + recording:save). Registered once; the
// deps are read lazily per call, so this is safe at module scope (app not yet ready).
registerRecordingIpc({
  compilerDir: () => getCompilerPath(),
  userDataDir: () => app.getPath('userData'),
  vaultRoot: () => writableVaultRoot() ?? null, // writes: only a vault folder that is there (ticket 07)
  discardThresholdMs: () => Math.max(0, Number(getConfig('recordingDiscardMs', 20000)) || 20000),
  r2Config: () => ({
    endpoint: getConfig('recordingR2Endpoint', undefined) ?? '',
    bucket: getConfig('recordingR2Bucket', undefined) ?? '',
    credsSource: getConfig('recordingR2CredsSource', 'settings') ?? 'settings',
    bwsSecretId: getConfig('recordingR2BwsSecretId', undefined) ?? ''
  }),
  readSafeKeys: () => readR2Keys(),
  testMode: () => process.env.TW_REC_TEST === '1',
  beforeCloseWindow: async (id, action) => {
    const record = attachLiveWindow(id)
    if (record && !['ended', 'expired'].includes(record.status)) {
      if (action !== 'end' && action !== 'keep') return { ok: false, error: 'Choose whether to end the live session or keep it live.' }
      if (action === 'end') await liveSessions!.end(id)
    }
    liveSessions?.detach(id)
    return { ok: true }
  },
  // A saved run changes the vault's presentation facts (last delivered); ping every window so
  // the panel and the status-bar dates refresh WITHOUT a reload (T29). Reuses the existing
  // 'talk meta changed' channel — pathways already ride it.
  onSessionSaved: (saved) => {
    notifyTalkMetaUpdated()
    // Reactions ticket 06: the Run file may exist only now; a live session bound to it writes its
    // history at once instead of waiting for its 30 s retry.
    liveSessions?.runSaved(saved.talkSlug, saved.runId)
  },
})

// TalkWeaver History IPC (handout URLs + cached live checks). Registered once; deps are lazy.
registerHistoryIpc({
  userDataDir: () => app.getPath('userData'),
  vaultRoot: () => writableVaultRoot() ?? null, // writes: only a vault folder that is there (ticket 07)
  listTalks: (root) => listIndexedTalks(root),
  testMode: () => process.env.TW_REC_TEST === '1'
})

// Transcription IPC (Parakeet bridge + transcript store). Registered once; deps are lazy.
registerTranscriptionIpc({
  userDataDir: () => app.getPath('userData'),
  vaultRoot: () => writableVaultRoot() ?? null, // writes: only a vault folder that is there (ticket 07)
  config: () => {
    const cfg = transcriptionSettings()
    return {
      python: expandHomePath(cfg.python),
      script: expandHomePath(cfg.script)
    }
  },
  testMode: () => process.env.TW_REC_TEST === '1'
})

talkTextIpcController = registerTalkTextIpc({
  vaultRoot: () => writableVaultRoot() ?? null, // writes: only a vault folder that is there (ticket 07)
  listTalks: (root) => listIndexedTalks(root),
  compile: async (outlinePath, content) => (await prepareTalk(outlinePath, content))?.rows ?? null,
  readSidecar: (id) => readAssetSidecar(id),
  resources: () => app.isPackaged
    ? { resourcesPath: process.resourcesPath }
    : { devRoot: app.getAppPath() },
  // Turn-into-text IPC is authorised only for the actual Tools window.
  toolsWindow: () => toolsWindow
})

// ── Build ──────────────────────────────────────────────────────────────────

ipcMain.handle('talk:build', async (_event, outlinePath: string, content: string) => {
  const refusal = outlineRefused(outlinePath) // writes beside the outline: refuse one outside the vault
  if (refusal) return { success: false, error: refusal }
  const blocked = unresolvedOutboundFailure(content)
  if (blocked) return blocked
  const compilerDir = getCompilerPath()
  if (!compilerDir) return { success: false, error: 'Compiler not found' }
  try {
    const stat = statSync(outlinePath)
    const slug = basename(outlinePath).replace('-outline.md', '')
    const talkDir = dirname(outlinePath)
    const { prepareSource } = await import(pathToFileURL(join(compilerDir, 'lib/08-source-adapters.mjs')).href)
    const vaultRoot = vaultRootFor(outlinePath)
    const resolved = vaultRoot ? resolveImageRefs(content, vaultRoot) : content
    const model = await prepareSource(outlinePath, resolved, slug, stat, timerSettings())
    const html = model.fullHtml as string
    const distDir = join(talkDir, 'dist')
    if (!existsSync(distDir)) mkdirSync(distDir) // only inside a talk folder that is there (a vanished vault is never re-created)
    const outPath = join(distDir, slug + '.html')
    writeFileSync(outPath, html, 'utf8')
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
    const stat = statSync(outlinePath)
    const slug = basename(outlinePath).replace('-outline.md', '')
    const talkDir = dirname(outlinePath)
    const vaultRoot = vaultRootFor(outlinePath)
    const resolved = vaultRoot ? resolveImageRefs(content, vaultRoot) : content

    const { prepareSource } = await import(pathToFileURL(join(compilerDir, 'lib/08-source-adapters.mjs')).href)
    const model = await prepareSource(outlinePath, resolved, slug, stat, timerSettings())

    const distDir = join(talkDir, 'dist')
    if (!existsSync(distDir)) mkdirSync(distDir) // only inside a talk folder that is there (a vanished vault is never re-created)

    const title = (model.title as string) ?? slug
    const fullHtml = model.fullHtml as string
    const outPaths: string[] = []

    const fullPath = join(distDir, slug + '-full.html')
    writeFileSync(fullPath, fullHtml, 'utf8')
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
      writeFileSync(notesPath, shareNotes, 'utf8')
      writeFileSync(noNotesPath, shareNoNotes, 'utf8')
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
      writeFileSync(notesPath, fullHtml, 'utf8')
      writeFileSync(noNotesPath, stripped, 'utf8')
      outPaths.push(notesPath, noNotesPath)
    }

    // Per-slide projections JSONL alongside the variants.
    try {
      const { buildPerSlideProjections } = await import(
        pathToFileURL(join(compilerDir, 'lib/10-projections.mjs')).href
      )
      const rows = buildPerSlideProjections(model, slug)
      if (rows && rows.length) {
        const jsonl = rows.map((r: unknown) => JSON.stringify(r)).join('\n') + '\n'
        const jsonlPath = join(distDir, slug + '-projections.jsonl')
        writeFileSync(jsonlPath, jsonl, 'utf8')
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

type RunHandoutArtifact = {
  path: string
  html: string
  title: string
  slug: string
  slideIds: string[]
  missing: string[]
  venueSource: { slides: Array<{ html: string; notes: string }>; styles: string; license: null; liveTalkSlug: string }
}

async function buildRunHandoutArtifact(
  talk: TalkInfo,
  run: RunRecord,
  content: string,
  outputSlug?: string,
  workerBaseUrl?: string,
  prework?: HandoutPreworkConfig
): Promise<RunHandoutArtifact> {
  const compilerDir = getCompilerPath()
  if (!compilerDir) throw new Error('Compiler not found')
  let compiled = await compileTalkForPresent(talk.outlinePath, content)
  let slideIds: string[] = []
  let missing: string[] = []
  if (run.slideSet.kind === 'pathway') {
    const pathwayId = run.slideSet.pathwayId
    const vaultRoot = vaultRootFor(talk.outlinePath)
    if (!vaultRoot) throw new Error('Choose a Vault before building a Run handout.')
    const prepared = await prepareTalk(talk.outlinePath, content, timerSettings())
    const manifest = readPathwayManifest(vaultRoot, talk.slug)
    const resolved = resolvePathways(manifest.pathways, (prepared?.rows ?? []) as PathwaySlideRow[])
      .find((pathway) => pathway.id === pathwayId)
    if (!resolved) throw new Error('The Run pathway no longer exists.')
    slideIds = resolved.present.map((row) => row.slide_id)
    missing = resolved.missing
    compiled = { ...compiled, html: injectPathwayRuntime(compiled.html, slideIds, pathwayId) }
  } else {
    const prepared = await prepareTalk(talk.outlinePath, content, timerSettings())
    slideIds = ((prepared?.rows ?? []) as PathwaySlideRow[]).map((row) => row.slide_id)
  }

  const datedHtml = injectRunCoverMetadata(compiled.html, run.eventTitle ?? run.talkTitle, run.plannedDate ?? run.startedAt.slice(0, 10))
  const { extractStyles, extractSlides } = await import(pathToFileURL(join(compilerDir, 'lib/04-html-extraction.mjs')).href)
  const { buildShareHtml } = await import(pathToFileURL(join(compilerDir, 'lib/09-output-builders.mjs')).href)
  const styles = extractStyles(datedHtml)
  // Feedback-boards ticket 09: a Run handout never lists the pre-work steps as ordinary slides. They
  // travel only as the form's steps (an inert template the form shows while pre-work is open); once it
  // closes, or on a handout with no pre-work, they are not shown at all.
  const preworkIds = new Set(compiled.preworkSlideIds ?? [])
  const allSlides = extractSlides(datedHtml) as Array<{ id: string; html: string; notes: string }>
  const slides = allSlides.filter((slide) => !preworkIds.has(slide.id))
  const preworkSlides = allSlides.filter((slide) => preworkIds.has(slide.id))
  const slug = outputSlug ?? runHandoutSlug(talk.slug, run.eventTitle ?? 'run', run.plannedDate ?? run.startedAt.slice(0, 10), [])
  const html = buildShareHtml({
    title: compiled.title, slides, styles, includeNotes: false, slug,
    workerBaseUrl: workerBaseUrl ?? '', liveTalkSlug: talk.slug,
    ...(prework ? { prework: { ...prework, steps: preworkSlides.map((slide) => ({ id: slide.id, html: slide.html })) } } : {}),
  }) as string
  const distDir = join(dirname(talk.outlinePath), 'dist')
  if (!existsSync(distDir)) mkdirSync(distDir) // only inside a talk folder that is there (a vanished vault is never re-created)
  const path = join(distDir, `${slug}-handout.html`)
  writeFileSync(path, html, 'utf8')
  return { path, html, title: compiled.title, slug, slideIds, missing,
    venueSource: { slides, styles, license: null, liveTalkSlug: talk.slug } }
}

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
    const stat = statSync(outlinePath)
    const slug = basename(outlinePath).replace('-outline.md', '')
    const talkDir = dirname(outlinePath)
    const vaultRoot = vaultRootFor(outlinePath)
    const resolved = vaultRoot ? resolveImageRefs(content, vaultRoot) : content

    const { prepareSource } = await import(pathToFileURL(join(compilerDir, 'lib/08-source-adapters.mjs')).href)
    const model = await prepareSource(outlinePath, resolved, slug, stat)
    const title = (model.title as string) ?? slug
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
    writeFileSync(handoutPath, handoutHtml, 'utf8')
    void ledgerSeal(outlinePath, content, 'export')
    return { success: true, path: handoutPath }
  } catch (e) {
    console.error('[export-handout]', e)
    return { success: false, error: String(e) }
  }
})

// ── Publish handout — in-app, config-driven Cloudflare Pages publishing (no external repo) ──────
// Build the share-no-notes handout in-process (same path as talk:export-handout), write it into a
// local accumulating "site" dir, then deploy the WHOLE dir via wrangler with the user's own
// credentials. Optionally (publishUseShortIds) assign a stable short id and regenerate _redirects so
// the link is <base>/<id>. The API token is read from the OS keychain (safeStorage); the user's
// account/project/domain come from config.json (Settings → Publishing). Nothing private is bundled.

function publishSiteDir(): string {
  return getConfig('publishSiteDir', undefined) ?? join(app.getPath('userData'), 'cloudflare-pages-site')
}
function handoutRegistryPath(): string {
  return join(app.getPath('userData'), 'handout-registry.json')
}
function readHandoutRegistry(): Record<string, string> {
  try {
    const r = JSON.parse(readFileSync(handoutRegistryPath(), 'utf8'))
    return r && typeof r === 'object' ? (r as Record<string, string>) : {}
  } catch {
    return {}
  }
}
function writeHandoutRegistry(reg: Record<string, string>): void {
  writeFileSync(handoutRegistryPath(), JSON.stringify(reg, null, 2), 'utf8')
}
// True if a `wrangler` executable exists in any dir of the augmented PATH.
function wranglerFoundOn(pathStr: string): boolean {
  for (const dir of pathStr.split(':')) {
    if (dir && existsSync(join(dir, 'wrangler'))) return true
  }
  return false
}

// Slim the PUBLISHED handout so each file stays under Cloudflare Pages' 25 MiB/file cap (the local
// build stays pristine — this operates on the in-memory copy only). Ported from the proven
// The handout builder: (1) drops the data of large inlined videos to a "plays live" note;
// (2) recompress big inlined PNGs to near-lossless WebP (cwebp), falling back to sips JPEG, never
// growing a file. Best-effort: if cwebp/sips are missing it returns the html unchanged.
// Slim a self-contained handout to fit Cloudflare Pages' 25 MiB per-file limit — BUDGET-AWARE
// (2026-07-20). The old pass compressed images at ONE fixed quality (near_lossless 60) and stripped
// only videos over 8 MB; a video-heavy imported deck (6 clips ≤8 MB inlined + 40+ screenshots) still
// landed at ~28 MB and wrangler rejected it. Now: try TOP quality first (unchanged for the ~90% of
// talks that already fit — they return on the first tier, untouched), and only for the heavy ones
// escalate — first nudging image quality/dimensions down, and only if even the lowest image tier
// can't fit, strip progressively smaller videos to placeholders. Videos stay playable as long as
// possible; quality drops just enough to clear the limit. Verified: a 28.6 MB deck → 24.2 MB with
// every video still inlined. See [[talkweaver-vault-scale]].
function slimHandoutHtml(html: string): string {
  const TARGET = 24 * 1024 * 1024 // ~1 MiB under the 25 MiB Cloudflare Pages ceiling
  const CWEBP = existsSync('/opt/homebrew/bin/cwebp') ? '/opt/homebrew/bin/cwebp' : 'cwebp'
  const VIDEO_PLACEHOLDER =
    '<figure class="slide-figure slide-video video-placeholder"><div class="video-placeholder-note"><span class="vp-glyph" aria-hidden="true">▶</span><span>Video plays in the live presentation</span></div></figure>'

  // Replace every inlined video larger than `limit` bytes with a poster placeholder.
  const stripVideos = (h: string, limit: number): string =>
    h.replace(/<figure class="slide-figure slide-video"[^>]*>[\s\S]*?<\/figure>/g, (fig) => {
      if (/video-placeholder/.test(fig)) return fig
      const data = fig.match(/src="data:video\/[^;]+;base64,([A-Za-z0-9+/=]+)"/)
      const bytes = data ? Math.floor(data[1].length * 0.75) : Infinity
      return bytes <= limit ? fig : VIDEO_PLACEHOLDER
    })

  // Re-encode every inlined image (png / jpeg / webp, over ~120 KB) to webp at the given cwebp
  // quality flag and max dimension. Always re-encodes from the ORIGINAL `h`, so escalating tiers
  // never stack lossy-on-lossy. `qualityFlag` is a cwebp arg pair, e.g. ['-near_lossless','60'] or
  // ['-q','84'].
  const compressImages = (h: string, qualityFlag: string[], maxDim: number): string => {
    let tmp: string
    try { tmp = mkdtempSync(join(tmpdir(), 'handout-slim-')) } catch { return h }
    let idx = 0
    try {
      return h.replace(/data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)/g, (match, fmt: string, b64: string) => {
        const origBytes = Buffer.byteLength(b64, 'base64')
        if (origBytes < 120 * 1024) return match // leave small images alone
        const i = idx++
        const ext = fmt === 'jpeg' ? 'jpg' : fmt
        const inPath = join(tmp, `i${i}.${ext}`)
        writeFileSync(inPath, Buffer.from(b64, 'base64'))
        // cwebp reads png/jpeg but not webp — transcode a webp source to png via sips first.
        let src = inPath
        try {
          if (fmt === 'webp') {
            const p = join(tmp, `i${i}s.png`)
            execFileSync('sips', ['-s', 'format', 'png', inPath, '--out', p], { stdio: 'ignore' })
            src = p
          }
        } catch { return match }
        let resize: string[] = []
        try {
          const g = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', src], { encoding: 'utf8' })
          const w = Number((g.match(/pixelWidth:\s*(\d+)/) || [])[1]) || 0
          const ht = Number((g.match(/pixelHeight:\s*(\d+)/) || [])[1]) || 0
          if (Math.max(w, ht) > maxDim) resize = w >= ht ? ['-resize', String(maxDim), '0'] : ['-resize', '0', String(maxDim)]
        } catch { /* dims unknown → encode at native size */ }
        const webpPath = join(tmp, `i${i}.webp`)
        try {
          execFileSync(CWEBP, ['-quiet', ...qualityFlag, ...resize, src, '-o', webpPath], { stdio: 'ignore' })
          const out = readFileSync(webpPath)
          if (out.length >= origBytes) return match // never grow a file
          return 'data:image/webp;base64,' + out.toString('base64')
        } catch {
          try {
            const jpgPath = join(tmp, `i${i}.jpg`)
            execFileSync('sips', ['-Z', String(maxDim), '-s', 'format', 'jpeg', '-s', 'formatOptions', '82', src, '--out', jpgPath], { stdio: 'ignore' })
            return 'data:image/jpeg;base64,' + readFileSync(jpgPath).toString('base64')
          } catch { return match }
        }
      })
    } finally {
      try { rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  }

  // Phase 1: keep every clip playable (strip only >8 MB, as before) and escalate image quality only.
  const base = stripVideos(html, 8 * 1024 * 1024)
  const imageTiers: Array<[string[], number]> = [
    [['-near_lossless', '60'], 2400], // top quality — unchanged from the old behaviour; most talks stop here
    [['-q', '84'], 2000],
    [['-q', '80'], 1700],
    [['-q', '74'], 1500]
  ]
  let last = base
  for (const [flag, dim] of imageTiers) {
    const out = compressImages(base, flag, dim)
    if (Buffer.byteLength(out, 'utf8') <= TARGET) return out
    last = out
  }
  // Phase 2: images already at the lowest tier and still over budget — strip progressively smaller
  // videos to placeholders until it fits.
  for (const mb of [4, 2, 1]) {
    const out = compressImages(stripVideos(html, mb * 1024 * 1024), ['-q', '74'], 1500)
    if (Buffer.byteLength(out, 'utf8') <= TARGET) return out
    last = out
  }
  return last // best effort — still over 25 MiB only if a single clip ≤1 MB + text already exceeds it
}

ipcMain.handle('talk:publish-handout', async (_event, outlinePath: string, content: string) => {
  const refusal = outlineRefused(outlinePath) // writes beside the outline: refuse one outside the vault
  if (refusal) return { success: false, error: refusal }
  // `content` is the renderer's copy of the buffer, which can trail the last keystrokes: it gates the
  // request early, but the handout, the ledger seal and the stamp use the flushed text below.
  const blocked = unresolvedOutboundFailure(content)
  if (blocked) return blocked

  const compilerDir = getCompilerPath()
  if (!compilerDir) return { success: false, error: 'Compiler not found' }

  const accountId = getConfig('cfAccountId', undefined)
  const project = getConfig('cfPagesProject', undefined)
  const baseUrl = getConfig('publishBaseUrl', undefined)
  const useShortIds = getConfig('publishUseShortIds', false) ?? false
  const prodBranch = getConfig('publishProdBranch', undefined) ?? 'main'
  const token = readToken()

  const PATH = augmentedPath(process.env.PATH)
  const wranglerFound = wranglerFoundOn(PATH)

  const pre = checkPreconditions({
    accountId: accountId as string | undefined,
    project: project as string | undefined,
    hasToken: !!token,
    wranglerFound
  })
  if (!pre.ok) return { success: false, error: pre.error }

  try {
    // What is published is the editor's buffer as it stands when Publish was pressed: flush it to disk
    // first (a forced save of the open editor's buffer through the one writer, talk-writer.ts; a
    // closed talk's file is read as it is) and build from the text the flush returns — never from
    // `content`, and never by writing the file here.
    const flushed = await flushTalkForPublish(outlinePath)
    if (!flushed.ok) return { success: false, error: flushed.error }
    const published = flushed.text
    const blockedNow = unresolvedOutboundFailure(published)
    if (blockedNow) return blockedNow
    const liveWorker = await ensureLiveWorker()

    const stat = statSync(outlinePath)
    const slug = basename(outlinePath).replace('-outline.md', '')
    const vaultRoot = vaultRootFor(outlinePath)
    const resolved = vaultRoot ? resolveImageRefs(published, vaultRoot) : published

    // Build the handout HTML exactly like talk:export-handout (share-no-notes).
    const { prepareSource } = await import(pathToFileURL(join(compilerDir, 'lib/08-source-adapters.mjs')).href)
    const model = await prepareSource(outlinePath, resolved, slug, stat)
    // Title for the handout <title> + viewer page: prefer the outline's frontmatter `title:`
    // (the canonical deck title), like the old publisher did — model.title falls back to the slug
    // for plain-markdown decks the v1 adapter routes, which would show the slug instead of the title.
    const fmTitle = (published.match(/^title:\s*["']?(.+?)["']?\s*$/m) || [])[1]
    const title = (fmTitle && fmTitle.trim()) || (model.title as string) || slug
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
      workerBaseUrl: liveWorker.baseUrl, liveTalkSlug: slug,
    })

    // Publish output: each handout
    // folder gets the slimmed handout as <slug>.html PLUS a viewer/landing index.html (Open +
    // Download + QR + short link). The whole accumulating site dir is deployed so prior talks survive.
    const siteDir = publishSiteDir()
    const talkOutDir = join(siteDir, slug)
    if (!existsSync(talkOutDir)) mkdirSync(talkOutDir, { recursive: true })

    const base = resolveBase({ baseUrl: baseUrl as string | undefined, project: project as string })

    // Stable short id assigned BEFORE the URL/QR so the viewer page + _redirects carry the final link.
    let id: string | undefined
    if (useShortIds) {
      const registry = readHandoutRegistry()
      const recoveredId = recoverIdFromUrl(readHandoutUrl(published), base)
      const gen = (): string => generateShortId((n) => Uint8Array.from(randomBytes(n)))
      const picked = pickShortId({ registry, slug, recoveredId, gen })
      id = picked.id
      writeHandoutRegistry(picked.registry)
    }
    const url = publishUrl({ base, slug, id, useShortIds })

    // The handout file (slimmed for the 25 MiB/file Pages cap) + the viewer/landing page that links to it.
    const handoutFile = `${slug}.html`
    writeFileSync(join(talkOutDir, handoutFile), slimHandoutHtml(handoutHtml), 'utf8')
    const { makeQrSvg } = await import(pathToFileURL(join(compilerDir, 'lib/01-cli-utils.mjs')).href)
    const qr = (makeQrSvg(url) as string) || ''
    writeFileSync(join(talkOutDir, 'index.html'), await viewerPageHtml({ title, handoutFile, url, qr }, compilerDir), 'utf8')
    const { buildVenuePageHtml, buildUnavailableVenuePageHtml } = await import(pathToFileURL(join(compilerDir, 'lib/venue-page.mjs')).href)
    const venueDir = join(talkOutDir, 'p')
    mkdirSync(venueDir, { recursive: true })
    writeFileSync(join(venueDir, 'index.html'), slimHandoutHtml(buildVenuePageHtml({
      title, slides, styles, slug, license, workerBaseUrl: liveWorker.baseUrl,
      liveTalkSlug: slug, qr, handoutUrl: url,
    })), 'utf8')
    writeFileSync(join(siteDir, '404.html'), buildUnavailableVenuePageHtml(), 'utf8')

    // _redirects regenerated AFTER the viewer index.html exists (the scan keys off each folder's index.html).
    if (useShortIds) {
      const registry = readHandoutRegistry()
      const existingSlugs = readdirSync(siteDir).filter((n) => existsSync(join(siteDir, n, 'index.html')))
      writeFileSync(join(siteDir, '_redirects'), buildRedirects(registry, existingSlugs), 'utf8')
    }

    // Deploy the whole site dir via wrangler with the user's credentials. execFile resolves the
    // `wrangler` command using the PATH in env (homebrew/usr/local cover global npm installs).
    const env = {
      ...process.env,
      PATH,
      CLOUDFLARE_API_TOKEN: token as string,
      CLOUDFLARE_ACCOUNT_ID: accountId as string
    }
    // cwd MUST be a writable dir: a packaged .app launched from Finder/`open` inherits CWD `/`, so
    // wrangler can't create its `./.wrangler/tmp` scratch (fails with "Missing file or directory:
    // /.wrangler/tmp"). Use userData — writable, app-owned, and the PARENT of siteDir so the scratch
    // dir is never inside (and thus never deployed with) the published folder.
    const wranglerCwd = app.getPath('userData')
    const deploy = await new Promise<{ ok: boolean; err?: string }>((resolveP) => {
      execFile(
        'wrangler',
        ['pages', 'deploy', siteDir, '--project-name', project as string, '--branch', prodBranch, '--commit-dirty=true'],
        { cwd: wranglerCwd, env, timeout: 180000, maxBuffer: 64 * 1024 * 1024 },
        (error, _stdout, stderr) => {
          if (error) resolveP({ ok: false, err: String(stderr || error.message).slice(-600) })
          else resolveP({ ok: true })
        }
      )
    })
    if (!deploy.ok) return { success: false, error: `wrangler deploy failed: ${deploy.err}` }

    // Best-effort: stamp handout_url into the outline frontmatter (so the short id is recoverable
    // later). No frontmatter → left unchanged. Stamped onto the talk's CURRENT text through the one
    // writer (the deploy can take minutes; the open editor's buffer may have moved on). `updatedOutline`
    // reports the text the writer applied; the renderer does not adopt it — it stamps its own buffer
    // as it stands (WorkspaceLayout.handlePublishHandout), a no-op when this stamp landed.
    let updatedOutline = stampHandoutUrl(published, url)
    if (updatedOutline !== published) {
      const stamped = await writeTalkOutline(outlinePath, (current) => stampHandoutUrl(current, url), 'publish-handout')
      if (stamped.ok) updatedOutline = stamped.text
    }
    void ledgerSeal(outlinePath, published, 'publish')
    return { success: true, url, display: url, updatedOutline }
  } catch (e) {
    console.error('[publish-handout]', e)
    return { success: false, error: String(e) }
  }
})

async function deployPublishedSite(siteDir: string): Promise<{ ok: boolean; error?: string }> {
  if (process.env.TW_REC_TEST === '1') return { ok: true }
  const accountId = getConfig('cfAccountId', undefined)
  const project = getConfig('cfPagesProject', undefined)
  const prodBranch = getConfig('publishProdBranch', undefined) ?? 'main'
  const token = readToken()
  const PATH = augmentedPath(process.env.PATH)
  const pre = checkPreconditions({
    accountId: accountId as string | undefined,
    project: project as string | undefined,
    hasToken: !!token,
    wranglerFound: wranglerFoundOn(PATH)
  })
  if (!pre.ok) return { ok: false, error: pre.error }
  const env = { ...process.env, PATH, CLOUDFLARE_API_TOKEN: token as string, CLOUDFLARE_ACCOUNT_ID: accountId as string }
  return new Promise((resolveP) => {
    execFile('wrangler', ['pages', 'deploy', siteDir, '--project-name', project as string, '--branch', prodBranch, '--commit-dirty=true'], {
      cwd: app.getPath('userData'), env, timeout: 180000, maxBuffer: 64 * 1024 * 1024
    }, (error, _stdout, stderr) => {
      resolveP(error ? { ok: false, error: `wrangler deploy failed: ${String(stderr || error.message).slice(-600)}` } : { ok: true })
    })
  })
}

type LiveWorkerCredentials = { adminSecret: string; signingSecret: string }
let localLiveWorker: { process: ChildProcessByStdio<null, Readable, Readable>; baseUrl: string; adminSecret: string } | null = null

function liveWorkerDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'worker') : join(process.cwd(), 'worker')
}
function liveCredentialsBlobPath(): string {
  return join(app.getPath('userData'), 'live-worker-credentials.bin')
}
function readLiveWorkerCredentials(): LiveWorkerCredentials | null {
  try {
    if (!safeStorage.isEncryptionAvailable() || !existsSync(liveCredentialsBlobPath())) return null
    const value = JSON.parse(safeStorage.decryptString(readFileSync(liveCredentialsBlobPath()))) as Partial<LiveWorkerCredentials>
    return value.adminSecret && value.signingSecret
      ? { adminSecret: value.adminSecret, signingSecret: value.signingSecret }
      : null
  } catch { return null }
}
function getOrCreateLiveWorkerCredentials(): LiveWorkerCredentials {
  const existing = readLiveWorkerCredentials()
  if (existing) return existing
  if (!safeStorage.isEncryptionAvailable()) throw new Error('OS keychain encryption is unavailable; live Worker credentials cannot be stored securely.')
  const credentials = {
    adminSecret: randomBytes(32).toString('base64url'),
    signingSecret: randomBytes(32).toString('base64url'),
  }
  writeFileSync(liveCredentialsBlobPath(), safeStorage.encryptString(JSON.stringify(credentials)))
  return credentials
}

function runWrangler(
  args: string[], env: NodeJS.ProcessEnv, input?: string,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    const child = spawn('wrangler', args, {
      cwd: app.getPath('userData'), env, stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    const timer = setTimeout(() => child.kill('SIGTERM'), 180_000)
    child.on('error', (error) => { clearTimeout(timer); resolveRun({ ok: false, stdout, stderr: `${stderr}\n${error.message}` }) })
    child.on('close', (code) => { clearTimeout(timer); resolveRun({ ok: code === 0, stdout, stderr }) })
    if (input) child.stdin.end(input)
    else child.stdin.end()
  })
}

// Strips `//` line comments and `/* … */` block comments from JSONC text, leaving string contents
// untouched, so wrangler.jsonc — which may legitimately carry either, per its own extension — reads
// as plain JSON. Self-contained rather than depending on a parser package: none of this repo's own
// declared dependencies ships one, and wrangler.jsonc here is never large.
function stripJsonComments(text: string): string {
  let out = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      out += ch
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; out += ch; continue }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1
      out += '\n'
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1
      i += 1
      continue
    }
    out += ch
  }
  return out
}

// Share link domain (ticket 07): the shipped wrangler.jsonc never hardcodes a custom domain — it is
// per-user (each person deploys the live Worker to their own Cloudflare account). When Settings has
// a valid domain, the deploy config gets a `routes: [{ pattern, custom_domain: true }]` entry;
// Workers custom domains create the DNS record and certificate themselves (verified against
// Cloudflare's docs — no separate DNS-record step is needed here, unlike attaching a domain via the
// raw API). Unset, or a stored value that no longer passes isValidShareDomain (edited by hand, or
// saved before that rule existed): the base wrangler.jsonc deploys unchanged, same as sharedTalkLink
// falling back to the Worker origin for the same reason.
function liveWorkerDeployConfigPath(baseConfig: string): { ok: true; path: string } | { ok: false; error: string } {
  try {
    const linkBase = getConfig('sharedTalkLinkBase', undefined)
    const hostname = (() => { try { return linkBase ? new URL(linkBase).hostname : null } catch { return null } })()
    if (!hostname || !isValidShareDomain(hostname)) return { ok: true, path: baseConfig }
    const source = JSON.parse(stripJsonComments(readFileSync(baseConfig, 'utf8'))) as Record<string, unknown>
    // Written outside the (possibly read-only, once signed) app resources directory, so `main` is
    // made absolute rather than left relative to the generated file's own location.
    const generated = {
      ...source,
      main: join(liveWorkerDir(), String(source.main ?? 'index.ts')),
      // Wrangler disables the workers.dev route by default once any `routes` entry is present unless
      // `workers_dev` says otherwise — keep it on: the app's own API calls (ensureLiveWorker's baseUrl,
      // parsed from this same deploy's output below) still go through workers.dev; only the colleague
      // link moves to the custom domain.
      workers_dev: true,
      routes: [{ pattern: hostname, custom_domain: true }],
    }
    const generatedPath = join(app.getPath('userData'), 'live-worker-wrangler.generated.jsonc')
    writeFileSync(generatedPath, JSON.stringify(generated, null, 2), 'utf8')
    return { ok: true, path: generatedPath }
  } catch (error) {
    return { ok: false, error: `Could not generate the live Worker's deploy config: ${error instanceof Error ? error.message : String(error)}` }
  }
}

async function deployLiveWorker(env: NodeJS.ProcessEnv): Promise<{ ok: true; baseUrl: string; adminSecret: string } | { ok: false; error: string }> {
  const accountId = getConfig('cfAccountId', undefined)
  const PATH = augmentedPath(env.PATH)
  if (!accountId) return { ok: false, error: 'Configure a Cloudflare account in Settings → Publishing.' }
  if (!wranglerFoundOn(PATH)) return { ok: false, error: 'wrangler not found — install it before starting a live session.' }
  const baseConfig = join(liveWorkerDir(), 'wrangler.jsonc')
  if (!existsSync(baseConfig)) return { ok: false, error: 'Live Worker files are missing from this TalkWeaver installation.' }
  const generatedConfig = liveWorkerDeployConfigPath(baseConfig)
  if (!generatedConfig.ok) return generatedConfig
  const config = generatedConfig.path
  let token: string
  try {
    token = await resolveLiveWorkerCloudflareToken()
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Could not resolve the live Worker Cloudflare API token from Bitwarden Secrets Manager.' }
  }
  const credentials = getOrCreateLiveWorkerCredentials()
  const cloudflareEnv = { ...env, PATH, CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: accountId }
  const deployed = await runWrangler(['deploy', '--config', config], cloudflareEnv)
  if (!deployed.ok) return { ok: false, error: `wrangler deploy failed: ${String(deployed.stderr || deployed.stdout).slice(-600)}` }
  const secrets = await runWrangler(
    ['secret', 'bulk', '--config', config],
    cloudflareEnv,
    JSON.stringify({ ADMIN_SECRET: credentials.adminSecret, SESSION_SIGNING_SECRET: credentials.signingSecret }),
  )
  if (!secrets.ok) return { ok: false, error: `Worker secret setup failed: ${String(secrets.stderr || secrets.stdout).slice(-600)}` }
  const output = `${deployed.stdout}\n${deployed.stderr}`
  const baseUrl = output.match(/https:\/\/[^\s]+\.workers\.dev\b/)?.[0]
  if (!baseUrl) return { ok: false, error: 'Worker deployed, but Wrangler did not report its workers.dev URL. Set the Worker base URL in Settings.' }
  writeConfig({ liveWorkerBaseUrl: baseUrl, liveWorkerVersion: LIVE_WORKER_VERSION })
  return { ok: true, baseUrl, adminSecret: credentials.adminSecret }
}

async function startLocalLiveWorker(requestedBaseUrl = 'http://127.0.0.1:8787'): Promise<{ baseUrl: string; adminSecret: string }> {
  if (localLiveWorker && !localLiveWorker.process.killed) {
    return { baseUrl: localLiveWorker.baseUrl, adminSecret: localLiveWorker.adminSecret }
  }
  const PATH = augmentedPath(process.env.PATH)
  if (!wranglerFoundOn(PATH)) throw new Error('wrangler not found — install it to run live sessions locally.')
  const config = join(liveWorkerDir(), 'wrangler.jsonc')
  if (!existsSync(config)) throw new Error('Live Worker files are missing from this TalkWeaver installation.')
  const adminSecret = randomBytes(24).toString('base64url')
  const signingSecret = randomBytes(24).toString('base64url')
  const requested = new URL(requestedBaseUrl)
  const port = requested.port || '8787'
  const wranglerState = join(app.getPath('userData'), 'live-worker-local-state')
  const child = spawn('wrangler', [
    'dev', '--config', config, '--ip', '127.0.0.1', '--port', port,
    '--var', `ADMIN_SECRET:${adminSecret}`, '--var', `SESSION_SIGNING_SECRET:${signingSecret}`,
    // A local Worker only: pre-work submissions without cf-connecting-ip share one source (ticket 09).
    '--var', 'PREWORK_LOCAL_SOURCE:1',
    '--persist-to', wranglerState, '--show-interactive-dev-session=false',
  ], {
    cwd: app.getPath('userData'),
    env: { ...process.env, PATH, WRANGLER_LOG_PATH: join(app.getPath('userData'), 'live-worker-wrangler.log') },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const baseUrl = await new Promise<string>((resolveStart, rejectStart) => {
    let output = ''
    const timer = setTimeout(() => { child.kill('SIGTERM'); rejectStart(new Error(`Local live Worker did not start. ${output.slice(-600)}`)) }, 30_000)
    const inspect = (chunk: Buffer): void => {
      output = `${output}${String(chunk)}`.slice(-4000)
      const found = output.match(/https?:\/\/(?:127\.0\.0\.1|localhost):\d+/)?.[0]
      if (!found) return
      clearTimeout(timer)
      child.stdout.off('data', inspect)
      child.stderr.off('data', inspect)
      child.stdout.resume()
      child.stderr.resume()
      resolveStart(found.replace('localhost', '127.0.0.1'))
    }
    child.stdout.on('data', inspect)
    child.stderr.on('data', inspect)
    child.once('error', (error) => { clearTimeout(timer); rejectStart(error) })
    child.once('exit', (code) => { clearTimeout(timer); rejectStart(new Error(`Local live Worker stopped during startup (${code}). ${output.slice(-600)}`)) })
  })
  localLiveWorker = { process: child, baseUrl, adminSecret }
  child.once('exit', () => { if (localLiveWorker?.process === child) localLiveWorker = null })
  return { baseUrl, adminSecret }
}

// Bump whenever worker/ changes so ensureLiveWorker RE-DEPLOYS instead of reusing a stale Worker.
// (Reuse-forever meant the Stage-1 Worker — with no poll handling — kept serving live sessions and
// silently dropped poll.open; a re-deploy is safe: same URL, same reused secrets.)
const LIVE_WORKER_VERSION = LIVE_WORKER_BUILD

async function ensureLiveWorker(): Promise<{ baseUrl: string; adminSecret: string }> {
  const configured = getConfig('liveWorkerBaseUrl', undefined)?.replace(/\/+$/, '')
  if (configured) {
    const url = new URL(configured)
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') {
      // A local Worker someone else already runs (the e2e harness, a developer's wrangler dev) and
      // whose admin secret is handed over explicitly: use it rather than spawning a second one.
      const externalSecret = process.env.TALKWEAVER_LIVE_ADMIN_SECRET?.trim()
      if (externalSecret) return { baseUrl: configured, adminSecret: externalSecret }
      return startLocalLiveWorker(configured)
    }
    // Re-deploy when the bundled Worker is newer than what was last deployed to this URL, if we
    // have the credentials to do so. On failure, fall through and reuse the URL rather than break go-live.
    const canDeploy = Boolean(readToken()) && Boolean(getConfig('cfAccountId', undefined))
    if (getConfig('liveWorkerVersion', undefined) !== LIVE_WORKER_VERSION && canDeploy) {
      const redeployed = await deployLiveWorker(process.env)
      if (redeployed.ok) return redeployed
    }
    const credentials = readLiveWorkerCredentials()
    const envSecret = process.env.TALKWEAVER_LIVE_ADMIN_SECRET?.trim()
    const adminSecret = credentials?.adminSecret ?? envSecret
    if (!adminSecret) throw new Error('The configured live Worker has no stored admin credential. Clear its URL to deploy or run a local Worker.')
    return { baseUrl: configured, adminSecret }
  }
  if (process.env.TW_LIVE_LOCAL === '1' || !readToken() || !getConfig('cfAccountId', undefined)) return startLocalLiveWorker()
  const deployed = await deployLiveWorker(process.env)
  if (!deployed.ok) throw new Error(deployed.error)
  return deployed
}

// ── Pre-work for a planned Run (feedback-boards ticket 09) ─────────────────────────────────────
// Built lazily (app.getPath needs a ready app); the timer starts once the app is ready.
let runPreworkService: RunPreworkService | null = null
function runPrework(): RunPreworkService {
  runPreworkService ??= createRunPrework({
    registryPath: join(app.getPath('userData'), 'run-prework-registry.json'),
    endpoint: () => ensureLiveWorker(),
    vaultRoot: () => writableVaultRoot() ?? null, // writes: only a vault folder that is there (ticket 07)
    fetch,
  })
  return runPreworkService
}

// ── Share for comments (ticket 03) ──────────────────────────────────────────────────────────────
// The shared-talk module (shared-talk.ts) owns the share registry, the Worker calls and the push
// queue; this is its wiring: the live Worker endpoint, the share build, the share_url stamp and the
// window broadcast. Built lazily — app.getPath needs a ready app.
let sharedTalkService: SharedTalks | null = null
function sharedTalkSlug(outlinePath: string): string {
  return basename(outlinePath).replace('-outline.md', '')
}
function sharedTalks(): SharedTalks {
  if (sharedTalkService) return sharedTalkService
  sharedTalkService = createSharedTalks({
    registryPath: join(app.getPath('userData'), 'shared-talk-registry.json'),
    endpoint: () => ensureLiveWorker(),
    linkBase: () => getConfig('sharedTalkLinkBase', undefined),
    identityOf: (outlinePath) => outlineIdentity(outlinePath),
    slugOf: sharedTalkSlug,
    peekOutline: (outlinePath) => readFileSync(outlinePath, 'utf8'),
    readOutline: async (outlinePath) => {
      // The talk as it stands (publish's flush: the open editor's buffer, saved when it differs from
      // the file). A refused flush — an empty talk, or the file changed on disk under the external-
      // change guard — fails the push rather than pushing whatever the file holds.
      const flushed = await flushTalkForPublish(outlinePath)
      if (!flushed.ok) throw new Error(flushed.error)
      return flushed.text
    },
    build: ({ outlinePath, content, slug, proposals }) => preparePass.background(async () => {
      const blocked = unresolvedOutboundFailure(content)
      if (blocked) throw new Error(blocked.error)
      const compilerDir = getCompilerPath()
      if (!compilerDir) throw new Error('Compiler not found.')
      const vaultRoot = vaultRootFor(outlinePath)
      const payload = await buildSharedTalkPayload({
        compilerDir, outlinePath, content, slug, proposals,
        compileContent: vaultRoot ? resolveImageRefs(content, vaultRoot) : content,
        // The talk's vault's personal author first (ticket 04), then Settings.
        ownerName: ownerNameFrom(content, vaultPersonalAuthor(outlinePath) || String(metadataDefaults().author ?? '')),
      })
      // The Worker takes up to 32 MiB per push; slim media only when a deck comes near it.
      return payload.html.length > 24 * 1024 * 1024 ? { ...payload, html: slimHandoutHtml(payload.html) } : payload
    }),
    stampShareUrl: async (outlinePath, url) => {
      const written = await writeTalkOutline(outlinePath, (current) => stampShareUrl(current, url), 'share-for-comments')
      if (!written.ok) throw new Error(written.error)
    },
    qrSvg: async (url) => {
      const compilerDir = getCompilerPath()
      if (!compilerDir) return ''
      const { makeQrSvg } = await import(pathToFileURL(join(compilerDir, 'lib/01-cli-utils.mjs')).href)
      return String(makeQrSvg(url) || '')
    },
    fetch: (input, init) => fetch(input, init),
    onChange: (key, state, previousKey) => {
      for (const win of BrowserWindow.getAllWindows()) {
        try { win.webContents.send('shared-talk:changed', previousKey ? { key, state, previousKey } : { key, state }) } catch { /* window closing */ }
      }
      // A share created, moved or stopped: its owner socket follows.
      sharedTalkFeedbackService?.sync()
    },
    log: (message) => console.warn(message),
  })
  return sharedTalkService
}

// ── Feedback rail (ticket 05) ────────────────────────────────────────────────────────────────────
// One owner socket per share, every item mirrored into <talk>/feedback/<share-id>.jsonl by one
// serialised writer (feedback-mirror.ts); the rail reads that file. Started at app ready.
let sharedTalkFeedbackService: SharedTalkFeedback | null = null
function sharedTalkFeedback(): SharedTalkFeedback {
  if (sharedTalkFeedbackService) return sharedTalkFeedbackService
  sharedTalkFeedbackService = createSharedTalkFeedback({
    shares: () => sharedTalks().owners(),
    mirror: createFeedbackMirror(),
    fetch: (input, init) => fetch(input, init),
    revisionSlides: (outlinePath, shareId, revision) => {
      const kept = readRevisionSnapshot(outlinePath, shareId, revision)
      return kept ? { slides: kept.slides, pushedAt: kept.pushedAt } : null
    },
    // The owner socket found the share stopped, retired or refusing the token: record it.
    onEnded: (shareId, reason) => sharedTalks().markEnded(shareId, reason),
    onChange: (shareId, summary) => {
      for (const win of BrowserWindow.getAllWindows()) {
        try { win.webContents.send('shared-talk:feedback-changed', { shareId, summary }) } catch { /* window closing */ }
      }
    },
    log: (message) => console.warn(message),
  })
  return sharedTalkFeedbackService
}
async function feedbackShareIdFor(outlinePath: unknown): Promise<string | null> {
  if (typeof outlinePath !== 'string' || !outlinePath) return null
  return (await sharedTalks().status(outlinePath))?.shareId ?? null
}
ipcMain.handle('shared-talk:feedback-summaries', () => {
  try { return sharedTalkFeedback().summaries() } catch { return [] }
})
ipcMain.handle('shared-talk:feedback-list', async (_event, outlinePath: unknown) => {
  try {
    const shareId = await feedbackShareIdFor(outlinePath)
    return shareId ? sharedTalkFeedback().list(shareId) : null
  } catch (error) {
    console.warn('[shared-talk] feedback list failed', error)
    return null
  }
})
ipcMain.handle('shared-talk:feedback-set-status', async (event, outlinePath: unknown, itemId: unknown, status: unknown, edit?: unknown) => {
  if (typeof itemId !== 'string' || !itemId || !RAIL_STATUSES.includes(status as FeedbackStatus)) return { success: false, error: 'Bad request.' }
  // Only the window that has the talk open (the external-change guard's owner for that file) may set
  // an item's status: an accept records a change that window's editor made.
  if (typeof outlinePath !== 'string' || !outlinePath || !outlineDiskGuard.owns(String(event.sender.id), outlinePath)) {
    return { success: false, error: 'This window does not have that talk open, so nothing was changed.' }
  }
  // An accept names the splice it made (Undo needs it); nothing else carries one.
  const accepted = status === 'accepted' ? parseAcceptRecord(edit) : null
  if (status === 'accepted' && edit != null && !accepted) return { success: false, error: 'Bad request.' }
  if (status !== 'accepted' && edit != null) return { success: false, error: 'Bad request.' }
  try {
    const shareId = await feedbackShareIdFor(outlinePath)
    if (!shareId) return { success: false, error: 'This talk is not shared.' }
    const list = await sharedTalkFeedback().setStatus(shareId, itemId, status as FeedbackStatus, accepted)
    return { success: true, list }
  } catch (error) { return sharedTalkError(error) }
})
function sharedTalkError(error: unknown): { success: false; error: string } {
  return { success: false, error: error instanceof Error ? error.message : String(error) }
}
ipcMain.handle('shared-talk:status', async (_event, outlinePath: unknown) => {
  if (typeof outlinePath !== 'string' || !outlinePath) return null
  try { return await sharedTalks().status(outlinePath) } catch { return null }
})
ipcMain.handle('shared-talk:inspect', async (_event, outlinePath: unknown) => {
  if (typeof outlinePath !== 'string' || !outlinePath) return { share: null, foreignShareUrl: null }
  try { return await sharedTalks().inspect(outlinePath) } catch { return { share: null, foreignShareUrl: null } }
})
ipcMain.handle('shared-talk:list', () => {
  try { return sharedTalks().list() } catch { return [] }
})
ipcMain.handle('shared-talk:share', async (_event, outlinePath: unknown, title: unknown) => {
  const refusal = outlineRefused(outlinePath) // writes beside the outline: refuse one outside the vault
  if (refusal) return { success: false, error: refusal }
  if (typeof outlinePath !== 'string' || !outlinePath) return { success: false, error: 'No talk is open.' }
  try {
    const blocked = unresolvedOutboundFailure(readFileSync(outlinePath, 'utf8'))
    if (blocked) return blocked
    const state = await sharedTalks().share(outlinePath, typeof title === 'string' ? title : undefined)
    return { success: true, share: state }
  } catch (error) { return sharedTalkError(error) }
})
ipcMain.handle('shared-talk:set-options', async (_event, outlinePath: unknown, options: unknown) => {
  const refusal = outlineRefused(outlinePath) // writes beside the outline: refuse one outside the vault
  if (refusal) return { success: false, error: refusal }
  if (typeof outlinePath !== 'string' || !outlinePath || !options || typeof options !== 'object') return { success: false, error: 'Bad request.' }
  const { liveUpdates, proposals } = options as { liveUpdates?: unknown; proposals?: unknown }
  try {
    const state = await sharedTalks().setOptions(outlinePath, {
      ...(typeof liveUpdates === 'boolean' ? { liveUpdates } : {}),
      ...(typeof proposals === 'boolean' ? { proposals } : {}),
    })
    return { success: true, share: state }
  } catch (error) { return sharedTalkError(error) }
})
ipcMain.handle('shared-talk:update', async (_event, outlinePath: unknown) => {
  const refusal = outlineRefused(outlinePath) // writes beside the outline: refuse one outside the vault
  if (refusal) return { success: false, error: refusal }
  if (typeof outlinePath !== 'string' || !outlinePath) return { success: false, error: 'No talk is open.' }
  try { return { success: true, share: await sharedTalks().update(outlinePath) } } catch (error) { return sharedTalkError(error) }
})
ipcMain.handle('shared-talk:stop', async (_event, outlinePath: unknown) => {
  if (typeof outlinePath !== 'string' || !outlinePath) return { success: false, error: 'No talk is open.' }
  try { return { success: true, ...(await sharedTalks().stop(outlinePath)) } } catch (error) { return sharedTalkError(error) }
})

async function liveHttpError(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json() as { error?: { message?: string } }
    return body.error?.message || fallback
  } catch { return fallback }
}

function localHandoutWorkerBaseUrl(): string {
  const configured = getConfig('liveWorkerBaseUrl', undefined)?.replace(/\/+$/, '')
  if (configured) return configured
  return !readToken() || process.env.TW_LIVE_LOCAL === '1' ? 'http://127.0.0.1:8787' : ''
}

async function ensureLiveJoinUrl(context: { talkSlug: string; shortUrl: string | null }): Promise<string> {
  if (!context.shortUrl) throw new Error('Publish or export this handout before going live.')
  const current = new URL(context.shortUrl)
  if (current.protocol === 'file:') return current.toString()
  const project = getConfig('cfPagesProject', undefined)
  if (!project) return current.toString()
  const base = resolveBase({ baseUrl: getConfig('publishBaseUrl', undefined), project })
  if (!current.toString().startsWith(`${base}/`)) return current.toString()
  const siteDir = publishSiteDir()
  if (!existsSync(join(siteDir, context.talkSlug, 'index.html'))) return current.toString()
  const registry = readHandoutRegistry()
  const picked = pickShortId({
    registry,
    slug: context.talkSlug,
    recoveredId: recoverIdFromUrl(current.toString(), base),
    gen: () => generateShortId((n) => Uint8Array.from(randomBytes(n))),
  })
  writeHandoutRegistry(picked.registry)
  const slugs = existsSync(siteDir)
    ? readdirSync(siteDir).filter((name) => existsSync(join(siteDir, name, 'index.html')))
    : []
  const redirects = buildRedirects(picked.registry, slugs)
  const redirectPath = join(siteDir, '_redirects')
  const currentRedirects = existsSync(redirectPath) ? readFileSync(redirectPath, 'utf8') : ''
  if (redirects !== currentRedirects) {
    writeFileSync(redirectPath, redirects, 'utf8')
    const deployed = await deployPublishedSite(siteDir)
    if (!deployed.ok) throw new Error(deployed.error || 'Could not deploy the live short URL.')
  }
  return publishUrl({ base, slug: context.talkSlug, id: picked.id, useShortIds: true })
}

ipcMain.handle('run:build-handout', async (_event, payload: { talkSlug: string; runId: string }) => {
  try {
    const vault = writableVaultRoot()
    if (!vault) return { success: false, error: 'no-vault' }
    const run = readRun(vault, String(payload.talkSlug), String(payload.runId))
    const talk = talkBySlug(String(payload.talkSlug))
    if (!run || !talk) return { success: false, error: 'run-or-talk-not-found' }
    // An open talk's unsaved edits belong in the handout: flush the editor's buffer through the one
    // writer first and build from the text it returns (a closed talk's file is read as it is).
    const flushed = await flushTalkForPublish(talk.outlinePath)
    if (!flushed.ok) return { success: false, error: flushed.error }
    const content = flushed.text
    const blocked = unresolvedOutboundFailure(content)
    if (blocked) return blocked
    const artifact = await buildRunHandoutArtifact(talk, run, content, undefined, localHandoutWorkerBaseUrl())
    return { success: true, path: artifact.path, slideIds: artifact.slideIds, missing: artifact.missing }
  } catch (cause) {
    return { success: false, error: cause instanceof Error ? cause.message : String(cause) }
  }
})

ipcMain.handle('run:publish-handout', async (_event, payload: { talkSlug: string; runId: string }) => {
  try {
    const vault = writableVaultRoot()
    if (!vault) return { success: false, error: 'no-vault' }
    const run = readRun(vault, String(payload.talkSlug), String(payload.runId))
    const talk = talkBySlug(String(payload.talkSlug))
    // Feedback-boards ticket 09 (ADR-0032 amendment point 3): a planned Run publishes its handout
    // before the day too, so the link participants get for pre-work is the one the talk will use.
    if (!run || !talk) return { success: false, error: 'run-not-found' }
    // As run:build-handout: the open editor's buffer, flushed through the one writer, is what is published.
    const flushed = await flushTalkForPublish(talk.outlinePath)
    if (!flushed.ok) return { success: false, error: flushed.error }
    const content = flushed.text
    const blocked = unresolvedOutboundFailure(content)
    if (blocked) return blocked
    const project = getConfig('cfPagesProject', undefined) ?? (process.env.TW_REC_TEST === '1' ? 'talkweaver-test' : undefined)
    if (!project) return { success: false, error: 'Configure Cloudflare publishing in Settings → Publishing (see docs/PUBLISHING.md)' }
    const liveWorkerBaseUrl = process.env.TW_REC_TEST === '1'
      ? getConfig('liveWorkerBaseUrl', undefined) ?? ''
      : (await ensureLiveWorker()).baseUrl
    const siteDir = publishSiteDir()
    if (!existsSync(siteDir)) mkdirSync(siteDir, { recursive: true })
    const existing = readdirSync(siteDir).filter((name) => existsSync(join(siteDir, name, 'index.html')))
    let stableSlug: string | undefined
    if (run.handoutUrl) {
      try {
        const pathPart = new URL(run.handoutUrl).pathname.split('/').filter(Boolean)[0]
        if (pathPart && existing.includes(pathPart)) stableSlug = pathPart
        if (!stableSlug) stableSlug = Object.entries(readHandoutRegistry()).find(([, id]) => id === pathPart)?.[0]
      } catch { /* derive a fresh collision-safe slug below */ }
    }
    const slug = stableSlug ?? runHandoutSlug(talk.slug, run.eventTitle ?? 'run', run.plannedDate ?? run.startedAt.slice(0, 10), existing)
    // A planned Run with a pre-work window carries its form: pushed to the Worker first, then the
    // handout is built with the pre-work object's id so it can ask whether pre-work is open.
    let prework: HandoutPreworkConfig | undefined
    let preworkWarning: string | undefined
    // Pre-work is hidden for 0.37: no form is pushed to the Worker and none goes into the handout, whatever
    // pre-work times the Run still holds (they stay on disk).
    const preworkMs = preworkEnabled() && run.status === 'planned' ? preworkWindowMs(preworkWindow(run), run.timeZone) : null
    // A window that closes before it opens would publish a handout with no form, silently.
    if (preworkEnabled() && run.status === 'planned' && run.preworkOpens && !preworkMs) {
      return { success: false, error: 'Pre-work closes before it opens; fix the dates in the plan.' }
    }
    if (preworkMs) {
      const prepared = await prepareTalk(talk.outlinePath, content, timerSettings())
      const form = publicPreworkForm(prepared?.model.prework as Parameters<typeof publicPreworkForm>[0],
        (Array.isArray(prepared?.model.slides) ? prepared!.model.slides : []) as Parameters<typeof publicPreworkForm>[1])
      if (form) {
        const published = await runPrework().publish(talk.slug, run.id, form, preworkMs)
        preworkWarning = published.warning
        if (published.open) prework = { preworkId: published.preworkId, workerBaseUrl: published.workerBaseUrl, form }
      }
    }
    const artifact = await buildRunHandoutArtifact(talk, run, content, slug, liveWorkerBaseUrl, prework)
    const talkOutDir = join(siteDir, slug)
    if (!existsSync(talkOutDir)) mkdirSync(talkOutDir, { recursive: true })
    const handoutFile = `${slug}.html`
    writeFileSync(join(talkOutDir, handoutFile), slimHandoutHtml(artifact.html), 'utf8')

    const base = resolveBase({ baseUrl: getConfig('publishBaseUrl', undefined) ?? (process.env.TW_REC_TEST === '1' ? 'https://mock-run-handouts.test' : undefined), project })
    const useShortIds = getConfig('publishUseShortIds', false) ?? false
    let id: string | undefined
    if (useShortIds) {
      const registry = readHandoutRegistry()
      const picked = pickShortId({
        registry,
        slug,
        recoveredId: recoverIdFromUrl(run.handoutUrl, base),
        gen: () => generateShortId((n) => Uint8Array.from(randomBytes(n)))
      })
      id = picked.id
      writeHandoutRegistry(picked.registry)
    }
    const url = publishUrl({ base, slug, id, useShortIds })
    const compilerDir = getCompilerPath()
    if (!compilerDir) return { success: false, error: 'Compiler not found' }
    const { makeQrSvg } = await import(pathToFileURL(join(compilerDir, 'lib/01-cli-utils.mjs')).href)
    const qr = (makeQrSvg(url) as string) || ''
    writeFileSync(join(talkOutDir, 'index.html'), await viewerPageHtml({ title: `${artifact.title} — ${run.eventTitle ?? 'Run'}`, handoutFile, url, qr }, compilerDir), 'utf8')
    const { buildVenuePageHtml, buildUnavailableVenuePageHtml } = await import(pathToFileURL(join(compilerDir, 'lib/venue-page.mjs')).href)
    const venueDir = join(talkOutDir, 'p')
    mkdirSync(venueDir, { recursive: true })
    writeFileSync(join(venueDir, 'index.html'), slimHandoutHtml(buildVenuePageHtml({
      title: artifact.title, ...artifact.venueSource, slug,
      workerBaseUrl: liveWorkerBaseUrl, qr, handoutUrl: url,
    })), 'utf8')
    writeFileSync(join(siteDir, '404.html'), buildUnavailableVenuePageHtml(), 'utf8')
    if (useShortIds) {
      const registry = readHandoutRegistry()
      const slugs = readdirSync(siteDir).filter((name) => existsSync(join(siteDir, name, 'index.html')))
      writeFileSync(join(siteDir, '_redirects'), buildRedirects(registry, slugs), 'utf8')
    }
    const deployed = await deployPublishedSite(siteDir)
    if (!deployed.ok) return { success: false, error: deployed.error }
    persistRun(vault, setRunHandoutUrl(readRun(vault, run.talkSlug, run.id) ?? run, url))
    return { success: true, url, path: artifact.path, slideIds: artifact.slideIds, missing: artifact.missing, ...(preworkWarning ? { warning: preworkWarning } : {}) }
  } catch (cause) {
    return { success: false, error: cause instanceof Error ? cause.message : String(cause) }
  }
})

ipcMain.handle('run:unpublish-handout', async (_event, payload: { talkSlug: string; runId: string }) => {
  try {
    const vault = writableVaultRoot()
    if (!vault) return { success: false, error: 'no-vault' }
    const run = readRun(vault, String(payload.talkSlug), String(payload.runId))
    if (!run) return { success: false, error: 'run-not-found' }
    const siteDir = publishSiteDir()
    if (run.handoutUrl && existsSync(siteDir)) {
      const pathPart = new URL(run.handoutUrl).pathname.split('/').filter(Boolean)[0]
      const registry = readHandoutRegistry()
      const slug = existsSync(join(siteDir, pathPart)) ? pathPart : Object.entries(registry).find(([, id]) => id === pathPart)?.[0]
      if (slug) rmSync(join(siteDir, slug), { recursive: true, force: true })
      if (slug && registry[slug]) {
        delete registry[slug]
        writeHandoutRegistry(registry)
      }
      const slugs = readdirSync(siteDir).filter((name) => existsSync(join(siteDir, name, 'index.html')))
      writeFileSync(join(siteDir, '_redirects'), buildRedirects(registry, slugs), 'utf8')
      const deployed = await deployPublishedSite(siteDir)
      if (!deployed.ok) return { success: false, error: deployed.error }
    }
    // The pre-work object is NOT closed here: the missing handout is the closure for participants, and
    // publishing again brings back the same open form with its answers. Only "Close pre-work now" or
    // the Run's close date closes it (ticket 09 fix round).
    persistRun(vault, clearRunHandoutUrl(readRun(vault, run.talkSlug, run.id) ?? run))
    return { success: true }
  } catch (cause) {
    return { success: false, error: cause instanceof Error ? cause.message : String(cause) }
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
    // Unique convertible refs: relative path ending .png/.jpg/.jpeg (not img- ids, urls, data:).
    const refs = new Set<string>()
    const re = /!\[[^\]]*\]\(([^)]+)\)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(content)) !== null) {
      const raw = m[1].trim().replace(/\s+"[^"]*"$/, '') // drop optional "title"
      if (/^(https?:|data:|img-)/.test(raw)) continue
      if (!/\.(png|jpe?g)$/i.test(raw)) continue
      refs.add(raw)
    }
    let newContent = content
    const rewrites: Array<[string, string]> = []
    let converted = 0
    let savedBytes = 0
    const failed: string[] = []
    for (const ref of refs) {
      let rel = ref
      try { rel = decodeURIComponent(ref) } catch { rel = ref }
      const abs = rel.startsWith('/') ? rel : join(talkDir, rel)
      if (!existsSync(abs)) { failed.push(ref); continue }
      const webpRef = ref.replace(/\.(png|jpe?g)$/i, '.webp') // keep the ref's encoding form
      const webpRel = rel.replace(/\.(png|jpe?g)$/i, '.webp')
      const webpAbs = webpRel.startsWith('/') ? webpRel : join(talkDir, webpRel)
      try {
        const before = statSync(abs).size
        await sharp(abs)
          .resize({ width: 2560, height: 2560, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 82 })
          .toFile(webpAbs)
        const after = statSync(webpAbs).size
        newContent = newContent.split(ref).join(webpRef)
        rewrites.push([ref, webpRef])
        savedBytes += Math.max(0, before - after)
        converted += 1
        if (resolvePath(webpAbs) !== resolvePath(abs)) {
          try { await shell.trashItem(abs) } catch { /* leave the original if trashing fails */ }
        }
      } catch (convErr) {
        console.warn('[optimize-images] failed for', ref, convErr)
        failed.push(ref)
      }
    }
    if (converted > 0) {
      // The same ref rewrites, applied to the talk's CURRENT text — the open editor's buffer when a
      // window has it (talk-writer.ts), so edits made during the conversion survive.
      const written = await writeTalkOutline(outlinePath, (current) => rewrites.reduce((text, [from, to]) => text.split(from).join(to), current), 'optimize-images')
      if (!written.ok) throw new Error(written.error)
      newContent = written.text
      invalidateVaultCaches(outlinePath)
    }
    return { success: true, converted, savedBytes, failed: failed.length, newContent }
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
ipcMain.handle('talk:materialize-slide-assets', async (_event, sourceOutlinePath: string, markdown: string) => {
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
    return { success: true, markdown: out, materialized, skipped }
  } catch (e) {
    console.error('[materialize-slide-assets]', e)
    return { success: false, error: String(e), markdown }
  }
})

// Slides across vaults (ticket 06): a slide picked from ANOTHER open vault is copied into the open
// talk's vault — its media read from the source vault and written into the target's pool, a colliding
// id re-stamped, and provenance split: the target's ledger gets `origin` {vault_id, vault_name,
// slide_id} on the first save; the source talk's title and path stay in this Mac's app data. Same vault
// → { crossVault: false } and the renderer takes the ordinary materialize path.

async function crossVaultTools(): Promise<CrossVaultTools> {
  const compilerDir = getCompilerPath()
  const edit = await import(pathToFileURL(join(compilerDir, 'lib/12-outline-edit.mjs')).href)
  const ledger = await import(pathToFileURL(join(compilerDir, 'lib/13-slide-ledger.mjs')).href)
  return {
    listSlideBlocks: (text) => edit.listSlideBlocks(text),
    stampMissingIds: (text, rng, opts) => edit.stampMissingIds(text, rng, opts),
    idLineIndex: (lines, at, end) => ledger.idLineIndex(lines, at, end),
    mintId: (rng, taken) => ledger.mintId(rng, taken),
    idsInVault: (root) => ledger.idsInVault(root)
  }
}

/** A vault's own name (no service suffix), from its cached vault file or the name it had when last
 *  reachable, else its folder's name; never a fresh disk read of every vault. */
function vaultNameOf(id: string): string {
  const vault = vaultRegistry.get(id)
  if (!vault) return ''
  const cached = vaultFileCache.get(id) ?? (vaultAvailability.isUnavailable(id) ? null : vaultFiles.read(vault.root))
  if (cached && !vaultFileCache.has(id) && !vaultAvailability.isUnavailable(id)) vaultFileCache.set(id, cached)
  return (cached?.state === 'ok' ? fileText(cached.file, 'name') : '') || vaultAvailability.lastGood(id)?.name || basename(vault.root)
}

ipcMain.handle('talk:insert-from-vault', async (_event, sourceOutlinePath: unknown, targetOutlinePath: unknown, markdown: unknown, liveIds?: unknown) => {
  if (typeof sourceOutlinePath !== 'string' || typeof targetOutlinePath !== 'string' || typeof markdown !== 'string') {
    return { ok: false as const, error: 'Nothing to insert.' }
  }
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
    const result = await prepareCrossVaultInsert({
      source: { id: from.vault.id, name: vaultNameOf(from.vault.id), root: from.vault.root },
      target: { id: to.vault.id, name: vaultNameOf(to.vault.id), root: to.vault.root },
      sourceOutlinePath,
      sourceTalkTitle: sourceTalk?.title || basename(sourceOutlinePath).replace(/-outline\.md$/, ''),
      markdown,
      extraTaken,
      // Who inserts it: their "Just for me" author for the target vault, else the Settings author.
      insertedBy: vaultRegistry.personal(to.vault.id).author?.trim() || String(metadataDefaults().author ?? '').trim()
    }, await crossVaultTools(), { toWebp: normaliseToWebp })
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

// Where a slide in this talk came from, when it came from another vault (Inspector, ticket 06). The
// owner's Mac has the private record (source talk title); anyone else sees the vault name and who
// inserted the slide (as the vault's ledger records it) — never a path.
ipcMain.handle('ledger:origin', async (_event, outlinePath: unknown, slideId: unknown) => {
  if (typeof outlinePath !== 'string' || typeof slideId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(slideId)) return null
  try {
    const hit = vaultRegistry.resolve(resolvePath(outlinePath))
    const lib = await ledgerLib()
    if (!hit || !hit.vault.open || !lib) return null
    const found = lib.slideOrigin(hit.vault.root, slideId) as { origin: SlideOrigin; savedAt: number } | null
    if (!found) return null
    const views = vaultViews()
    const sourceView = views.find((v) => v.id === found.origin.vault_id) ?? null
    const mine = provenanceStore().get(hit.vault.id, slideId)
    const privateRecord = mine && mine.source_vault_id === found.origin.vault_id ? mine : null
    return {
      vaultId: found.origin.vault_id,
      vaultName: sourceView?.name ?? found.origin.vault_name,
      sourceSlideId: found.origin.slide_id,
      insertedAt: privateRecord?.inserted_at ?? (found.savedAt ? new Date(found.savedAt).toISOString() : null),
      talkTitle: privateRecord?.source_talk_title ?? null,
      badge: sourceView ? { initial: sourceView.initial, color: sourceView.color } : null,
      insertedBy: found.origin.inserted_by ?? null
    }
  } catch { return null }
})

// Vault-wide asset index (basename → absolute path), built lazily and cached. Used to heal relative
// image refs in PASTED slide markdown, which — unlike picker insert — carries no source path, so we
// locate `assets/<name>` by FILENAME anywhere in the vault.
let vaultAssetIndex: Map<string, string> | null = null
function buildVaultAssetIndex(vaultRoot: string): Map<string, string> {
  const idx = new Map<string, string>()
  const walk = (dir: string, depth: number): void => {
    if (depth > 6) return
    let entries: Dirent[]
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name !== 'dist' && e.name !== 'node_modules' && !e.name.startsWith('.')) walk(p, depth + 1)
      } else if (/\.(png|jpe?g|gif|webp|mp4|mov|m4v|webm)$/i.test(e.name) && !idx.has(e.name)) {
        idx.set(e.name, p)
      }
    }
  }
  walk(vaultRoot, 0)
  return idx
}

// Cross-talk reuse via TEXT PASTE: the picker materialises a slide's relative images using its
// source path, but pasted markdown has none. Resolve each relative `assets/<name>` ref by FILENAME
// across the vault, copy it into the content-addressed pool (img-<hash>, WebP-normalised), and
// rewrite the ref — so a pasted sequence's images resolve from any talk. Pool/http/data refs and
// names not found anywhere are left untouched. Returns the rewritten markdown.
ipcMain.handle('talk:materialize-pasted-assets', async (_event, markdown: string) => {
  const vaultRoot = writableVaultRoot()
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
    if (refs.size === 0) return { success: true, markdown, materialized: 0, skipped: 0 }
    if (!vaultAssetIndex) vaultAssetIndex = buildVaultAssetIndex(vaultRoot)
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
      let found = vaultAssetIndex.get(base)
      if (!found || !existsSync(found)) {
        // Rebuild once in case the asset was added since the index was cached.
        vaultAssetIndex = buildVaultAssetIndex(vaultRoot)
        found = vaultAssetIndex.get(base)
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
            const posterFound = vaultAssetIndex.get(stem + '.' + pext)
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

// App version, so any screen can show which build is running (dev-confusion guard).
ipcMain.handle('app:version', () => process.env.npm_package_version ?? app.getVersion())

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

interface ThumbnailRequest {
  outlinePath: string
  content: string
  lane: string
  /** The media contract this lane compiles under; part of the prepared-cache identity. */
  mediaOptions?: Record<string, unknown>
}

const latestThumbnailRequest = createLatestThumbnailRequestHandler(
  ({ outlinePath, content, mediaOptions }: ThumbnailRequest) =>
    prepareTalk(outlinePath, content, undefined, mediaOptions),
  async (input, prepared, owner): Promise<Record<string, string> | null> => {
    if (!prepared) return null
    const { slug, model } = prepared
    const rows = (prepared.rows ?? []) as Array<{
      content_hash?: string
      render_hash?: string
      thumbnail_hash?: string
      slide_id?: string
      layout?: string
      triggers?: Record<string, string>
    }>
    // Key on render_hash (layout + block model), NOT content_hash: a layout/trigger change keeps
    // the same content_hash, so keying on it served a STALE thumbnail after every layout edit.
    const fullHtml = model.fullHtml as string
    const documentId = thumbnailDocumentId(fullHtml)
    const slides = thumbnailSlides(rows, documentId)
    const cacheDir = talkThumbCacheDir(input.outlinePath, slug)
    const vaultId = vaultIdOf(input.outlinePath)
    let rendered: Record<string, string> = {}
    try {
      rendered = await renderThumbnails({ fullHtml, slides, cacheDir, requestKey: `editor:${owner}` })
    } finally {
      // The background sweep has no follow-up request for this deck, so nothing may keep its
      // (possibly 200MB+) model alive once the render is done — including the cache's "one
      // oversized current document" retention. The editor lane keeps its entry: compile ->
      // thumbnails on the same model is exactly what that retention is for. (2026-09-15 OOM.)
      if (input.lane === BROWSER_THUMBNAIL_LANE) {
        preparedTalkCache.evict(preparedTalkGroup(input.outlinePath, undefined, input.mediaOptions))
        logThumbnails(
          `${slug}: rendered ${Object.keys(rendered).length} of ${slides.length} slides, ` +
          `prepared model evicted, heap at ${heapGuardDecision(process.memoryUsage().heapUsed).heapMb} MB`
        )
      }
    }
    // renderThumbnails returns key -> absolute png path; expose as twthumb:// URLs (naming the
    // talk's vault) the protocol handler resolves back to that vault's folder for the slug.
    const map: Record<string, string> = {}
    for (const key of Object.keys(rendered)) {
      map[key] = thumbUrl(slug, basename(rendered[key], '.png'), vaultId)
    }
    return map
  },
  {} as Record<string, string>
)

// Latest-wins is scoped per OWNER = window + lane. One window hosts two independent requesters —
// the editor strip (re-requests on every compile, 900ms after any content change) and the Slide
// Browser's background per-talk render. With a window-wide owner the strip's re-request ABORTED
// the browser's render mid-talk: a partial cache, `{}` back, and the browser marked the talk done —
// half its cards blank for the rest of the session (2026-09-15).
ipcMain.handle('talk:thumbnails', async (_event, outlinePath: string, content: string, opts?: { lane?: string }) => {
  const refusal = outlineRefused(outlinePath) // writes beside the outline: refuse one outside the vault
  if (refusal) return null
  try {
    const lane = typeof opts?.lane === 'string' && /^[a-z-]{1,32}$/.test(opts.lane) ? opts.lane : ''
    const owner = String(_event.sender.id) + (lane ? ':' + lane : '')
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
    const result = await latestThumbnailRequest(owner, { outlinePath, content, lane, mediaOptions })
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

// ── Asset sidecar metadata (ADR-0020) ────────────────────────────────────────
// Flat `key: value` YAML, tags as `[a, b]` or a block list. Hand-parsed, no yaml dep.
type AssetSidecar = { id: string; alt: string; caption: string; source: string; tags: string[] }
function parseSidecar(text: string, id: string): AssetSidecar & { created?: string } {
  const out: AssetSidecar & { created?: string } = { id, alt: '', caption: '', source: '', tags: [] }
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const m = line.match(/^([A-Za-z0-9_-]+):\s?(.*)$/)
    if (!m) continue
    const key = m[1]
    let val = m[2]
    const unquote = (s: string): string => s.replace(/^["']|["']$/g, '')
    if (key === 'tags') {
      const inline = val.trim()
      if (inline.startsWith('[')) {
        out.tags = inline
          .replace(/^\[|\]$/g, '')
          .split(',')
          .map((t) => unquote(t.trim()))
          .filter(Boolean)
      } else if (inline === '' || inline === '|') {
        // block list: subsequent `- item` lines
        const tags: string[] = []
        for (let j = i + 1; j < lines.length; j += 1) {
          const item = lines[j].match(/^\s*-\s+(.*)$/)
          if (!item) break
          tags.push(unquote(item[1].trim()))
        }
        out.tags = tags
      }
      continue
    }
    val = unquote(val.trim())
    if (key === 'alt') out.alt = val
    else if (key === 'caption') out.caption = val
    else if (key === 'source') out.source = val
    else if (key === 'id') out.id = val || id
    else if (key === 'created') out.created = val
  }
  return out
}
function serializeSidecar(prev: { id: string; created?: string }, meta: { alt: string; caption: string; source: string; tags: string[] }): string {
  const q = (s: string): string => '"' + String(s).replace(/"/g, '\\"') + '"'
  const lines = ['id: ' + prev.id]
  if (prev.created) lines.push('created: ' + prev.created)
  lines.push('alt: ' + q(meta.alt || ''))
  lines.push('caption: ' + q(meta.caption || ''))
  lines.push('source: ' + q(meta.source || ''))
  const tags = (meta.tags || []).filter(Boolean)
  lines.push('tags: [' + tags.map((t) => q(t)).join(', ') + ']')
  return lines.join('\n') + '\n'
}

function readAssetSidecar(id: string): AssetSidecar | null {
  const target = assetSidecarPath(currentVaultRoot(), id)
  if (!target.ok) return null
  const path = target.path
  if (!existsSync(path)) return null
  try {
    const parsed = parseSidecar(readFileSync(path, 'utf8'), id)
    return { id: parsed.id, alt: parsed.alt, caption: parsed.caption, source: parsed.source, tags: parsed.tags }
  } catch (e) {
    console.error('[asset:read-sidecar]', e)
    return null
  }
}

ipcMain.handle('asset:read-sidecar', (_event, id: string): AssetSidecar | null => readAssetSidecar(id))

ipcMain.handle(
  'asset:write-sidecar',
  (_event, id: string, meta: { alt: string; caption: string; source: string; tags: string[] }): boolean => {
    const vaultRoot = writableVaultRoot()
    if (!vaultRoot) return false
    // The id comes from the renderer: only `<vault>/_assets/<id>.yml`, a single safe name.
    const target = assetSidecarPath(vaultRoot, id)
    if (!target.ok) { console.error('[asset:write-sidecar] refused', target.error); return false }
    try {
      const assetsDir = dirname(target.path)
      mkdirInVault(vaultRoot, assetsDir)
      const path = target.path
      let prev: { id: string; created?: string } = { id }
      if (existsSync(path)) {
        const existing = parseSidecar(readFileSync(path, 'utf8'), id)
        prev = { id: existing.id, created: existing.created }
      }
      writeFileSync(path, serializeSidecar(prev, meta), 'utf8')
      return true
    } catch (e) {
      console.error('[asset:write-sidecar]', e)
      return false
    }
  }
)

// ── Abstract read/write (ADR-0009) ───────────────────────────────────────────
ipcMain.handle('abstract:read', (_event, talkPath: string) => {
  // talkPath comes from the renderer: only `<talk folder>/abstract.md` inside the vault.
  const target = abstractPath(vaultRootFor(talkPath), talkPath)
  if (!target.ok) return null
  const path = target.path
  if (!existsSync(path)) return null
  try {
    const raw = readFileSync(path, 'utf8')
    const fm = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
    const frontmatter: Record<string, unknown> = {}
    let body = raw
    if (fm) {
      body = fm[2]
      for (const line of fm[1].split('\n')) {
        const m = line.match(/^([A-Za-z0-9_-]+):\s?(.*)$/)
        if (m) frontmatter[m[1]] = m[2].replace(/^["']|["']$/g, '')
      }
    }
    return { raw, frontmatter, body }
  } catch (e) {
    console.error('[abstract:read]', e)
    return null
  }
})

ipcMain.handle('abstract:write', (_event, talkPath: string, raw: string): boolean => {
  // talkPath comes from the renderer: only a talk folder inside the vault (never the vault root).
  const vaultRoot = writableRootFor(talkPath)
  if (!vaultRoot) return false // the talk's vault is unavailable: nothing is written into it
  const target = abstractPath(vaultRoot, talkPath)
  if (!target.ok) { console.error('[abstract:write] refused', target.error); return false }
  try {
    const folder = dirname(target.path)
    mkdirInVault(vaultRoot, folder)
    writeFileSync(target.path, raw, 'utf8')
    return true
  } catch (e) {
    console.error('[abstract:write]', e)
    return false
  }
})

// ── Outline reorder (ADR-0005/0019 strip↔file sync) ──────────────────────────
// The renderer's block indices count ONLY `### `-headed rows (GridView/SlideStrip
// isOutlineBlock), but outline-v2 listSlideBlocks lists EVERY heading ##–###### as its
// own block — indexing those directly moved the WRONG block (e.g. the `## Section` line)
// and could park a section below its own subsection. Map grid indices to depth-3 heading
// blocks and move each with its WHOLE SUBTREE (its ####–###### children travel with it),
// which is the only structurally sound move under heading-is-slide. Returns new text;
// does NOT write the file. `content` is the text to reorder — the open editor's buffer (one-writer
// spec D1: the renderer mutates its buffer, then saves it); without it the file is read.
ipcMain.handle('outline:reorder', async (_event, outlinePath: string, fromIndex: number, toIndex: number, content?: unknown) => {
  const compilerDir = getCompilerPath()
  if (!compilerDir) return null
  try {
    const text = typeof content === 'string' ? content : readFileSync(outlinePath, 'utf8')
    const { listSlideBlocks } = await import(
      pathToFileURL(join(compilerDir, 'lib/12-outline-edit.mjs')).href
    )
    const blocks = listSlideBlocks(text) as Array<{ heading: string; start: number; end: number }>
    const depthOf = (heading: string): number => (heading.match(/^(#{1,6})\s/) ?? ['', ''])[1].length
    // RULING (Task 9, deliberate stopgap — do not extend): the depth-3 filter below exists
    // ONLY to mirror GridView/SlideStrip's ###-only block counters (isOutlineBlock), so the
    // renderer's numeric block indices land on the same blocks here. Under heading-is-slide
    // every ##–###### heading is a slide, so the model-consistent fix is identity-addressed
    // moves ({heading, occurrence} read from the row's source_markdown, not a counter) plus
    // a subtree-aware reorderSlide with per-depth legality rules. See
    // .superpowers/sdd/task-9-report.md for the full spec of that follow-up.
    // Depth-3 blocks, each spanning through its deeper-heading children ([start, end) lines).
    const gridBlocks: Array<{ start: number; end: number }> = []
    for (let i = 0; i < blocks.length; i += 1) {
      if (depthOf(blocks[i].heading) !== 3) continue
      let end = blocks[i].end
      for (let j = i + 1; j < blocks.length && depthOf(blocks[j].heading) > 3; j += 1) end = blocks[j].end
      gridBlocks.push({ start: blocks[i].start, end })
    }
    if (
      fromIndex < 0 ||
      toIndex < 0 ||
      fromIndex >= gridBlocks.length ||
      toIndex >= gridBlocks.length ||
      fromIndex === toIndex
    ) {
      return null
    }
    const from = gridBlocks[fromIndex]
    const target = gridBlocks[toIndex]
    // Dragging down: land AFTER the target subtree; dragging up: land BEFORE it.
    const lines = text.split('\n')
    const moved = lines.splice(from.start, from.end - from.start)
    let at = toIndex > fromIndex ? target.end : target.start
    if (from.start < at) at -= moved.length // indices shifted by the removal above
    lines.splice(at, 0, ...moved)
    return lines.join('\n')
  } catch (e) {
    console.error('[outline:reorder]', e)
    return null
  }
})

// ── Per-item icon override (ADR-0021 icon picker) ────────────────────────────
// Pin (or clear, iconKey=null) the icon on ONE top-level list item of a slide, by writing the
// canonical `{icon=KEY}` token at the end of that bullet's line. Operates on the renderer's LIVE
// in-memory `content` (not the on-disk file, which lags behind a debounced autosave) and returns
// the rewritten text; the renderer then drives onContentChange → autosave so the file syncs. Item
// is addressed by {heading, occurrence} + 0-based item index, exactly as setListItemIcon expects.
ipcMain.handle(
  'outline:set-item-icon',
  async (
    _event,
    content: string,
    slideHeading: string,
    slideOccurrence: number,
    itemIndex: number,
    iconKey: string | null
  ) => {
    const compilerDir = getCompilerPath()
    if (!compilerDir) return null
    try {
      const { setListItemIcon } = await import(
        pathToFileURL(join(compilerDir, 'lib/12-outline-edit.mjs')).href
      )
      const ref = { heading: slideHeading, occurrence: slideOccurrence || 1 }
      return setListItemIcon(content, ref, itemIndex, iconKey)
    } catch (e) {
      console.error('[outline:set-item-icon]', e)
      return null
    }
  }
)

// ── Trigger merge (⌘L layout picker) ─────────────────────────────────────────
// Merge the chosen trigger onto the slide under `lineNumber` (1-based caret line) in the
// renderer's LIVE content: same-key tokens replaced via the Trigger Dictionary, everything
// else — {id=…} above all — kept verbatim (ADR-0032 id-loss fix). Returns rewritten text
// or null; the renderer must no-op on null, never fall back to replacing the line.
ipcMain.handle('outline:merge-trigger', async (_event, content: string, lineNumber: number, trigger: string) => {
  const compilerDir = getCompilerPath()
  if (!compilerDir) return null
  try {
    const { mergeTriggerAtLine } = await import(
      pathToFileURL(join(compilerDir, 'lib/12-outline-edit.mjs')).href
    )
    return mergeTriggerAtLine(content, lineNumber, trigger)
  } catch (e) {
    console.error('[outline:merge-trigger]', e)
    return null
  }
})

// ── Asset paste ────────────────────────────────────────────────────────────

// ADR-0020: normalise clipboard images to WebP via sharp, then content-address the
// POST-CONVERSION bytes. sharp is a native module loaded lazily so a missing/broken
// build never breaks app startup; if conversion throws we fall back to the original
// bytes/ext so paste NEVER fails. The twasset:// handler tries webp first, so converted
// assets display without renderer changes.
async function normaliseToWebp(buf: Buffer): Promise<Buffer> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const sharp = require('sharp')
  return sharp(buf).webp({ quality: 82 }).toBuffer()
}

// outlinePath (the open talk) names the vault whose asset pool receives the image; without it, the current vault.
ipcMain.handle('asset:paste-image', async (_event, bytes: ArrayBuffer | Uint8Array, ext: string = 'png', outlinePath?: string) => {
  const vaultRoot = typeof outlinePath === 'string' && outlinePath ? writableRootFor(outlinePath) : writableVaultRoot()
  if (!vaultRoot) return null
  try {
    // The renderer sends an ArrayBuffer over IPC; crypto/fs need a Buffer/TypedArray.
    return await storePastedImage(vaultRoot, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), ext, normaliseToWebp)
  } catch (e) {
    console.error('[asset:paste-image]', e)
    return null
  }
})

// ── Instant slides after the talk (live-presenting ticket 07, frame L6) ─────────────────────
// "Add to talk" writes the talk's source outline. If an editor window has the talk open, the
// insertion is planned against that window's BUFFER and applied there (apply-only-if-unchanged,
// then saved through the editor's normal save path), so an unsaved edit is never overwritten and
// the next autosave cannot undo the slide. Otherwise the file is re-read, checked unchanged and
// written atomically. Either way the operation itself is addRunInstantSlide (instant-slide-insert.ts).
const editorDocumentReplies = new Map<string, (value: EditorDocumentReply | null) => void>()
ipcMain.handle('outline:editor-reply', (_event, requestId: unknown, value: unknown) => {
  const resolve = typeof requestId === 'string' ? editorDocumentReplies.get(requestId) : undefined
  if (!resolve) return
  editorDocumentReplies.delete(requestId as string)
  resolve(value && typeof value === 'object' ? value as EditorDocumentReply : null)
})
function requestEditorDocument(win: BrowserWindow, request: EditorDocumentRequestBody): Promise<EditorDocumentReply | null> {
  return new Promise((resolve) => {
    const requestId = randomBytes(12).toString('hex')
    const timer = setTimeout(() => { editorDocumentReplies.delete(requestId); resolve(null) }, 10_000)
    editorDocumentReplies.set(requestId, (value) => { clearTimeout(timer); resolve(value) })
    try { win.webContents.send('outline:editor-request', { ...request, requestId }) } catch { clearTimeout(timer); editorDocumentReplies.delete(requestId); resolve(null) }
  })
}
// Also the talk writer's editor route (talk-writer.ts EditorBuffer): `origin` names the writer so the
// window words its refusal; "Add to talk" calls commit without one (its own words are kept).
function editorOutlineDocument(win: BrowserWindow, outlinePath: string): OutlineDocument & EditorBuffer {
  return {
    async read() {
      const reply = await requestEditorDocument(win, { kind: 'read', outlinePath })
      if (!reply) throw new OutlineRefusal('The editor window with this talk did not respond. Nothing was added; try again.')
      if (!reply.ok || typeof reply.text !== 'string') throw new OutlineRefusal(reply.ok ? 'The editor did not return the talk.' : reply.error)
      return reply.text
    },
    // The editor replies ok only once the insertion's save has been written to disk; a failed save
    // is a refusal (the entry stays un-added; the edit stays in the editor, undoable).
    async commit(base: string, next: string, origin?: TalkWriteOrigin) {
      const reply = await requestEditorDocument(win, { kind: 'apply', outlinePath, base, next, origin: origin ?? INSTANT_SLIDE_ORIGIN })
      if (!reply) {
        return {
          ok: false as const,
          error: origin
            ? `The editor window with this talk did not confirm the save of ${changeNoun(origin)}. Check the talk in the editor before trying again.`
            : 'The editor window with this talk did not confirm the save, so the slide is not marked as added. Check the talk in the editor before adding it again.',
        }
      }
      return reply.ok
        ? { ok: true as const, ...(typeof reply.text === 'string' ? { text: reply.text } : {}) }
        : { ok: false as const, error: reply.error, moved: reply.moved === true }
    },
  }
}
// The editor window holding this talk's real file, whichever path (link or real) History and the
// window each use; requests to it carry the WINDOW's own path, which is what its buffer is bound to.
function editorWindowForOutline(outlinePath: string): { win: BrowserWindow; outlinePath: string } | null {
  const entry = editorEntryForOutline(editorWindows.values(), outlinePath, liveWindow)
  return entry ? { win: entry.win, outlinePath: entry.outlinePath } : null
}
// One writer for talk files (talk-writer.ts): a main-process write of a talk an editor window has open
// goes through that window's buffer, by the same read / apply messages as "Add to talk".
// External-change guard (shared-talk ticket 01, outline-disk-guard.ts): watches each open talk's folder
// (the same watcher registry as TalkText) and tells the window when its outline changed behind it.
const outlineDiskWatchers = createDirectoryWatcherRegistry((directory, onChange) => watch(directory, onChange))
const outlineRecovery = createOutlineRecovery(join(app.getPath('userData'), 'recovery'))
// Windows whose close the person confirmed (the close sheet), and whether ⌘Q is under way.
const closeConfirmed = new Set<number>()
// A close held for the person's choice, until the renderer acknowledges it (the 5-second fallback).
const closeHolds = new Map<number, ReturnType<typeof setTimeout>>()
// The last text each guarded talk's editor failed to save (real path → text): the fallback close's
// recovery copy. Cleared by the next successful save.
const lastUnsavedText = new Map<string, string>()
// ⌘Q in progress. Set by before-quit; a close that holds for the person takes it (and resets it); and it
// is cleared once the close cycle is over, so a quit cancelled anywhere else never lingers to quit the
// app on some later close.
let quitting = false
let quittingTimer: ReturnType<typeof setTimeout> | null = null
app.on('before-quit', () => {
  quitting = true
  if (quittingTimer) clearTimeout(quittingTimer)
  quittingTimer = setTimeout(() => { quitting = false; quittingTimer = null }, 1500)
})
const outlineDiskGuard = createOutlineDiskGuard({
  canonical: canonicalOutlinePath,
  async readText(realPath) {
    try { return await readFileAsync(realPath, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null
      throw error
    }
  },
  async mtime(realPath) { try { return statSync(realPath).mtimeMs } catch { return null } },
  withLock: (outlinePath, work) => withTalkFileLock(outlinePath, () => work()),
  // The same folder watch feeds the conflict-copy scan (ticket 09): once when the talk opens, then on
  // every change in its folder.
  watch: (realPath, onChange, onError) => {
    // The talk-open scan runs even when the folder cannot be watched (review T3).
    try {
      outlineDiskWatchers.acquire(dirname(realPath), realPath, () => { onChange(); scheduleConflictScan(realPath) }, onError)
    } finally {
      scheduleConflictScan(realPath)
    }
  },
  unwatch: (realPath) => outlineDiskWatchers.releaseOwner(realPath),
  notify(owner, outlinePath, change: OutlineDiskChange | null) {
    const win = editorWindows.get(Number(owner))?.win
    if (win && !win.isDestroyed()) win.webContents.send('outline:changed-on-disk', { outlinePath, change })
  },
})
app.on('will-quit', () => { outlineDiskGuard.dispose(); outlineDiskWatchers.releaseAll() })
configureTalkWriter({
  diskGuard: outlineDiskGuard,
  editorBufferFor(outlinePath) {
    const editor = editorWindowForOutline(outlinePath)
    return editor ? editorOutlineDocument(editor.win, editor.outlinePath) : null
  },
  trace({ outlinePath, origin, result }) {
    if (origin === 'editor' && result.ok) return
    console.log(`[talk-writer] ${origin} ${outlinePath}: ${result.ok ? `${result.changed ? 'written' : 'unchanged'} via ${result.via}` : `refused: ${result.error}`}`)
  },
})
// The renderer keys its per-file save queue by the identity key (lib/saveQueue.ts), resolved on every
// write, so every alias of one outline shares one queue and a retargeted link moves to its new file.
ipcMain.handle('talk:outline-identity', (_event, outlinePath: unknown) =>
  typeof outlinePath === 'string' && outlinePath ? outlineIdentity(outlinePath) : null)
ipcMain.handle('outline:canonical-path', (_event, outlinePath: unknown) =>
  typeof outlinePath === 'string' && outlinePath ? outlineIdentity(outlinePath).realPath : null)
let instantOutlineTools: Promise<OutlineTools> | null = null
function outlineTools(): Promise<OutlineTools> {
  const compilerDir = getCompilerPath()
  if (!compilerDir) return Promise.reject(new Error('Compiler not found.'))
  instantOutlineTools ??= loadOutlineTools(compilerDir).catch((error) => { instantOutlineTools = null; throw error })
  return instantOutlineTools
}

ipcMain.handle('history:instant-anchors', async (_event, payload: { talkSlug?: unknown; runId?: unknown }) => {
  const vaultRoot = currentVaultRoot()
  const talkSlug = String(payload?.talkSlug ?? ''), runId = String(payload?.runId ?? '')
  // Only this talk's own Run, from this talk's folder (the names are validated as path segments).
  const run = vaultRoot ? readRunForTalk(vaultRoot, talkSlug, runId) : null
  const talk = run ? talkBySlug(talkSlug) : null
  if (!run?.instantSlides?.length || !talk) return {}
  try {
    // The open editor's buffer is what "Add to talk" will plan against, so the numbers shown match it.
    const editor = editorWindowForOutline(talk.outlinePath)
    const text = editor ? await editorOutlineDocument(editor.win, editor.outlinePath).read().catch(() => readFileSync(talk.outlinePath, 'utf8'))
      : readFileSync(talk.outlinePath, 'utf8')
    const anchors = await resolveInstantAnchors(talk.outlinePath, text, run.instantSlides.map((entry) => entry.afterSlideId), await outlineTools())
    return Object.fromEntries(run.instantSlides.map((entry) => [entry.id, entry.afterSlideId ? anchors[entry.afterSlideId] ?? null : null]))
  } catch (error) {
    console.error('[history:instant-anchors]', error)
    return {}
  }
})

// Reactions ticket 06: where each slide a Run's questions and reactions name sits in the talk NOW
// (number and title for the Run card), keyed by slide id; null when the slide is no longer there.
ipcMain.handle('history:feedback-slides', async (_event, payload: { talkSlug?: unknown; runId?: unknown }) => {
  const vaultRoot = currentVaultRoot()
  const talkSlug = String(payload?.talkSlug ?? ''), runId = String(payload?.runId ?? '')
  const run = vaultRoot ? readRunForTalk(vaultRoot, talkSlug, runId) : null
  const talk = run ? talkBySlug(talkSlug) : null
  // Feedback-boards ticket 06: the board and poll blocks name their slides too ("slide 44").
  const slideIds = [...(run?.questions ?? []), ...(run?.reactions ?? [])].map((entry) => entry.slideId)
    .concat((run?.boards ?? []).flatMap((board) => board.slideId ? [board.slideId] : []))
    .concat((run?.polls ?? []).flatMap((poll) => poll.slideId ? [poll.slideId] : []))
  if (!slideIds.length || !talk) return {}
  try {
    const editor = editorWindowForOutline(talk.outlinePath)
    const text = editor ? await editorOutlineDocument(editor.win, editor.outlinePath).read().catch(() => readFileSync(talk.outlinePath, 'utf8'))
      : readFileSync(talk.outlinePath, 'utf8')
    return await resolveInstantAnchors(talk.outlinePath, text, slideIds, await outlineTools())
  } catch (error) {
    console.error('[history:feedback-slides]', error)
    return {}
  }
})

ipcMain.handle('history:add-instant-slide', async (_event, payload: { talkSlug?: unknown; runId?: unknown; entryId?: unknown }) => {
  const vaultRoot = writableVaultRoot()
  if (!vaultRoot) return { ok: false, error: 'No vault is open.' }
  const talkSlug = String(payload?.talkSlug ?? ''), runId = String(payload?.runId ?? ''), entryId = String(payload?.entryId ?? '')
  const talk = talkBySlug(talkSlug)
  if (!talk) return { ok: false, error: 'This talk is no longer in the vault, so nothing was added.' }
  let tools: OutlineTools
  try { tools = await outlineTools() } catch { return { ok: false, error: 'The talk compiler is unavailable, so nothing was added.' } }
  const editor = editorWindowForOutline(talk.outlinePath)
  const result = await addRunInstantSlide({
    vaultRoot, talkSlug, runId, entryId, outlinePath: talk.outlinePath, tools,
    document: editor ? editorOutlineDocument(editor.win, editor.outlinePath) : fileOutlineDocument(talk.outlinePath),
    // `format` is the image's real type by its header (checked in addInstantSlideToTalk). The image
    // must fully decode (sharp reads a real size and converts it) or nothing is stored and the Add
    // refuses — never the paste route's keep-the-original fallback.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    storeImage: async (bytes, format) => (await storePastedImage(vaultRoot, bytes, format, (buf) => decodeToWebp(require('sharp'), buf), { requireDecode: true })).id,
  })
  if (!result.ok) return result
  if (!editor) {
    // The file route bypassed talk:write-outline, so do its bookkeeping here (the editor route's
    // save went through talk:write-outline itself).
    notifyPathwaysChanged(talk.outlinePath)
    try { noteAppEdit(talk.outlinePath) } catch { /* backup bookkeeping never breaks a write */ }
    try { await ledgerRecord(talk.outlinePath, readFileSync(talk.outlinePath, 'utf8')) } catch { /* ledger is best-effort */ }
    return result
  }
  // The editor route reported success only after its save reached the disk (the renderer's D1 seam,
  // lib/outlineMutation.ts applyFromMain), so there is nothing left to reconcile here.
  return result
})

// Store an image buffer under the img- namespace (used as the GIF fallback path). Returns the id.
function storeBufAsImage(assetsDir: string, buf: Buffer, ext: string, note: string): string {
  const hash = createHash('sha256').update(buf).digest('hex').slice(0, 7)
  const id = 'img-' + hash
  const p = join(assetsDir, id + '.' + ext)
  if (!existsSync(p)) {
    writeFileSync(p, buf)
    const sc = join(assetsDir, id + '.yml')
    if (!existsSync(sc)) {
      writeFileSync(sc, [
        'id: ' + id,
        'created: ' + new Date().toISOString().slice(0, 10),
        'original_format: ' + ext,
        'note: ' + JSON.stringify(note),
        'alt: ""', 'caption: ""', 'source: ""', 'tags: []'
      ].join('\n') + '\n', 'utf8')
    }
  }
  return id
}

const VIDEO_EXTS = ['mp4', 'mov', 'm4v', 'webm']

// Idempotently write a clip's poster + sidecar beside vid-<id>.<ext> (best effort for the poster).
async function ensureVideoSidecars(assetsDir: string, id: string, videoPath: string, originalFormat: string, durationMs: number): Promise<void> {
  const posterPath = join(assetsDir, id + '.jpg')
  if (!existsSync(posterPath)) await runMediaBin(['poster', videoPath, posterPath])
  const sidecarPath = join(assetsDir, id + '.yml')
  if (!existsSync(sidecarPath)) {
    writeFileSync(sidecarPath, [
      'id: ' + id,
      'kind: video',
      'created: ' + new Date().toISOString().slice(0, 10),
      'original_format: ' + originalFormat,
      'duration_ms: ' + durationMs,
      'alt: ""', 'caption: ""', 'source: ""', 'tags: []'
    ].join('\n') + '\n', 'utf8')
  }
}

// Ingest a video or animated GIF into the Vault Asset Pool (ADR-0028). Accepts either a file
// `path` (drag-drop — avoids piping big bytes over IPC) or `bytes` (paste). Animated GIFs are
// converted to silent MP4; static GIFs and conversion failures fall back to the img- image path.
// Stores `vid-<7hex>.<ext>` + a generated poster `vid-<id>.jpg` + a `vid-<id>.yml` sidecar.
// The id hashes the SOURCE bytes, not the converted output — the GIF→MP4 encode is not byte-
// deterministic, so hashing the MP4 would mint a fresh id on every re-import (defeating ADR-0020).
ipcMain.handle('asset:add-video', async (_event, input: { path?: string; bytes?: ArrayBuffer | Uint8Array; ext?: string }) => {
  const vaultRoot = writableVaultRoot()
  if (!vaultRoot) return { success: false, error: 'No vault root' }
  if (!resolveMediaBin()) return { success: false, error: 'Media helper not found (rebuild the app)' }
  const tmp: string[] = []
  try {
    let ext = (input.ext || '').toLowerCase().replace('jpeg', 'jpg')
    // 1. Resolve a concrete source file on disk.
    let srcPath: string
    if (input.path && existsSync(input.path)) {
      srcPath = input.path
      if (!ext) ext = (input.path.split('.').pop() || '').toLowerCase()
    } else if (input.bytes) {
      const buf = Buffer.from(input.bytes instanceof Uint8Array ? input.bytes : new Uint8Array(input.bytes))
      srcPath = join(tmpdir(), 'tw-ingest-' + randomBytes(6).toString('hex') + '.' + (ext || 'bin'))
      writeFileSync(srcPath, buf); tmp.push(srcPath)
    } else {
      return { success: false, error: 'No file path or bytes' }
    }

    const assetsDir = join(vaultRoot, '_assets')
    mkdirInVault(vaultRoot, assetsDir)

    // Content identity from the SOURCE bytes — stable across the non-deterministic GIF→MP4 encode.
    const srcHash = await hashFileSoon(srcPath)

    // 2. GIF → MP4. Static (single-frame) GIFs and conversion failures degrade to an image.
    if (ext === 'gif') {
      const id = 'vid-' + srcHash
      const finalPath = join(assetsDir, id + '.mp4')
      if (existsSync(finalPath)) { // already imported — idempotent, skip re-conversion
        await ensureVideoSidecars(assetsDir, id, finalPath, 'gif', 0)
        return { success: true, id, ext: 'mp4', origin: 'gif' as const }
      }
      if (existsSync(join(assetsDir, 'img-' + srcHash + '.gif'))) { // previously fell back to image
        return { success: true, id: 'img-' + srcHash, ext: 'gif', origin: 'image' as const }
      }
      const tmpMp4 = join(tmpdir(), 'tw-conv-' + randomBytes(6).toString('hex') + '.mp4'); tmp.push(tmpMp4)
      const res = await runMediaBin(['convert-gif', srcPath, tmpMp4])
      if (!res.ok || res.static) {
        const sid = storeBufAsImage(assetsDir, readFileSync(srcPath), 'gif',
          res.static ? 'static gif kept as image' : 'gif->mp4 failed; kept as image: ' + (res.error || ''))
        return { success: true, id: sid, ext: 'gif', origin: 'image' as const, ...(res.static ? {} : { warning: 'GIF could not be converted; stored as image' }) }
      }
      cpSync(tmpMp4, finalPath)
      await ensureVideoSidecars(assetsDir, id, finalPath, 'gif', Number(res.durationMs || 0))
      return { success: true, id, ext: 'mp4', origin: 'gif' as const }
    }

    if (!VIDEO_EXTS.includes(ext)) return { success: false, error: 'Unsupported media type: .' + ext }

    // 3. MP4/MOV/… stored as-is; id is the hash of its own bytes (source == stored here).
    const id = 'vid-' + srcHash
    const finalPath = join(assetsDir, id + '.' + ext)
    if (!existsSync(finalPath)) cpSync(srcPath, finalPath)
    await ensureVideoSidecars(assetsDir, id, finalPath, ext, 0)
    return { success: true, id, ext, origin: 'video' as const }
  } catch (e) {
    console.error('[asset:add-video]', e)
    return { success: false, error: String(e) }
  } finally {
    for (const f of tmp) { try { rmSync(f, { force: true }) } catch { /* ignore */ } }
  }
})

// ── Create talk ────────────────────────────────────────────────────────────

ipcMain.handle('vault:create-talk', async (_event, opts: { title: string; slug: string; topicFolder?: string; vaultId?: string }) => {
  // An unavailable vault (or one whose folder has just gone) gets no new talk: its folder is never
  // re-created (ticket 07).
  const vaultRoot = writableRootOfVault(opts?.vaultId)
  if (!vaultRoot) return null
  try {
    const { title, slug, topicFolder } = opts
    // slug / topicFolder come from the renderer: the new talk folder must land inside the vault.
    const target = newTalkFolder(vaultRoot, slug, topicFolder)
    if (!target.ok) { console.error('[vault:create-talk] refused', target.error); return null }
    const talkDir = target.path
    mkdirInVault(vaultRoot, talkDir)
    const outlinePath = join(talkDir, slug + '-outline.md')
    if (!existsSync(outlinePath)) {
      const initialContent = [
        '---',
        'title: ' + title,
        // Stamp new talks as outline-v2 at birth — without this, every freshly created
        // talk fails outlineHasV2Stamp and gets the migration prompt + a pointless .bak
        // on first open.
        'outline_version: 2',
        '---',
        '',
        '## Introduction',
        '',
        '### Opening slide',
        '',
        'Your content here.',
        '',
      ].join('\n')
      // Pre-fill the presenter's identity and house style: the vault file's affiliation, style and
      // logo, then this person's author for the vault, then Settings → Presenter identity and deck
      // defaults (several-vaults ticket 04). fill-missing only: nothing already in the template is
      // touched, and a blank default writes nothing at all.
      const vault = vaultOfRoot(vaultRoot)
      const vaultFile = vault ? vaultRegistry.readFile(vault.id) : null
      const { defaults } = resolveNewTalkDefaults({
        vaultFile: vaultFile?.state === 'ok' ? vaultFile.file : null,
        personal: vault ? vaultRegistry.personal(vault.id) : null,
        app: metadataDefaults(),
        talkFolderRel: talkFolderRelOf(vaultRoot, talkDir)
      })
      const { edits } = applyMetadataDefaults(parseFrontmatterPairs(initialContent), normaliseMetadataDefaults(METADATA_REGISTRY, defaults), { mode: 'fill-missing' })
      const seeded = edits.length > 0 ? editFrontmatterText(initialContent, edits) : initialContent
      const created = await writeTalkOutline(outlinePath, seeded, 'create-talk')
      if (!created.ok) throw new Error(created.error)
    }
    invalidateTalkCache(vaultRoot)
    return { name: slug, path: talkDir, outlinePath, title, slug } satisfies TalkInfo
  } catch (e) {
    console.error('[vault:create-talk]', e)
    return null
  }
})

// ── Clone + folder management (ported from the Raycast extension's rename.ts) ────────────────
// slugify must match the compiler's slugify so a cloned talk's files line up with its outline.
function slugifyTalk(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}
// Rename every `{oldSlug}-…` / `{oldSlug}.…` file in dir to use newSlug (the outline + siblings).
function renameSlugFiles(dir: string, oldSlug: string, newSlug: string): void {
  if (oldSlug === newSlug) return
  for (const file of readdirSync(dir)) {
    let renamed: string | null = null
    if (file.startsWith(`${oldSlug}-`)) renamed = `${newSlug}-${file.slice(oldSlug.length + 1)}`
    else if (file.startsWith(`${oldSlug}.`)) renamed = `${newSlug}${file.slice(oldSlug.length)}`
    if (renamed) renameSync(join(dir, file), join(dir, renamed))
  }
}
// Both edit the talk's current text through the one writer (talk-writer.ts): the open editor's
// buffer when a window has the talk, else the file.
async function retitleOutline(outlinePath: string, newTitle: string): Promise<void> {
  if (!existsSync(outlinePath)) return
  const line = `title: "${newTitle.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  const written = await writeTalkOutline(outlinePath, (text) => {
    const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    if (fm && /^\s*title:/m.test(fm[1])) {
      return text.slice(0, fm.index! + fm[0].length).replace(/^\s*title:.*$/m, line) + text.slice(fm.index! + fm[0].length)
    } else if (fm) {
      return text.replace(/^---\r?\n/, `---\n${line}\n`)
    }
    return `---\n${line}\n---\n\n${text}`
  }, 'retitle')
  if (!written.ok) throw new Error(written.error)
}
// A clone is NOT published — drop handout_url so it doesn't inherit the original's live link.
async function stripPublishedFields(outlinePath: string): Promise<void> {
  if (!existsSync(outlinePath)) return
  const written = await writeTalkOutline(outlinePath, (text) => {
    const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    if (!fm) return text
    const lines = fm[1].split(/\r?\n/)
    const kept = lines.filter((l) => !/^\s*handout_url\s*:/.test(l))
    if (kept.length === lines.length) return text
    return text.slice(0, fm.index!) + `---\n${kept.join('\n')}\n---` + text.slice(fm.index! + fm[0].length)
  }, 'strip-published')
  if (!written.ok) throw new Error(written.error)
}
function findOutlineIn(dir: string): string | null {
  try {
    const hit = pickOutlineName(readdirSync(dir), basename(dir))
    return hit ? join(dir, hit) : null
  } catch { return null }
}
function talkInfoFor(talkDir: string): TalkInfo | null {
  const outlinePath = findOutlineIn(talkDir)
  if (!outlinePath) return null
  const slug = basename(outlinePath).replace('-outline.md', '')
  let title = slug
  try {
    const m = readFileSync(outlinePath, 'utf8').match(/^title:\s*["']?(.+?)["']?\s*$/m)
    if (m) title = m[1]
  } catch { /* keep slug as title */ }
  return { name: slug, path: talkDir, outlinePath, title, slug }
}

// Clone a talk: copy its whole folder (skip bundle/ + logs), rename slug files, retitle, strip the
// published handout_url. Lands as a sibling (same parent folder), exactly like Raycast's Duplicate.
ipcMain.handle('vault:clone-talk', async (_event, outlinePath: string, newTitle: string) => {
  // outlinePath comes from the renderer: clone only a talk folder inside the vault, to a sibling
  // folder that is still inside it.
  const vaultRoot = writableRootFor(outlinePath)
  if (!vaultRoot) return null // the talk's vault is unavailable: nothing is copied into it
  const src = talkFolderOfOutline(vaultRoot, outlinePath)
  if (!src.ok) { console.error('[vault:clone-talk] refused', src.error); return null }
  try {
    const srcDir = src.path
    const oldSlug = basename(outlinePath).replace('-outline.md', '')
    const siblingFor = (slug: string): string => {
      const sibling = siblingTalkFolder(vaultRoot, srcDir, slug)
      if (!sibling.ok) throw new Error(sibling.error)
      return sibling.path
    }
    let newSlug = slugifyTalk(newTitle) || `${oldSlug}-copy`
    let target = siblingFor(newSlug)
    // Never clobber: suffix -2, -3, … until the folder name is free.
    let n = 2
    while (existsSync(target)) { newSlug = `${slugifyTalk(newTitle) || oldSlug}-${n}`; target = siblingFor(newSlug); n += 1 }
    const skip = new Set([join(srcDir, 'bundle'), join(srcDir, 'dist'), join(srcDir, '.deck-server.log')])
    cpSync(srcDir, target, {
      recursive: true,
      filter: (s) => !skip.has(s) && ![...skip].some((p) => s.startsWith(p + pathSep))
    })
    renameSlugFiles(target, oldSlug, newSlug)
    const newOutline = findOutlineIn(target)
    if (newOutline) { await retitleOutline(newOutline, newTitle); await stripPublishedFields(newOutline) }
    invalidateVaultCaches(outlinePath)
    return talkInfoFor(target)
  } catch (e) {
    console.error('[vault:clone-talk]', e)
    return null
  }
})

// Rename a talk IN PLACE: retitle the frontmatter and, when the new title yields a new slug,
// rename the talk folder + every slug-prefixed file in it (same mechanics as clone). The
// published handout_url is kept — renaming a talk does not unpublish it. Refuses (returns
// null) if the target folder name is already taken, rather than guessing a suffix: unlike a
// clone, a rename must land exactly where the author pointed it.
ipcMain.handle('vault:rename-talk', async (event, outlinePath: string, newTitle: string) => {
  try {
    const title = String(newTitle || '').trim()
    if (!title) return null
    // Refuse while ANOTHER window holds this talk open: its autosave would recreate the old
    // path after the move and the two files would drift apart (same hazard class as the
    // 2026-07-05 empty-write incident). The requesting window is expected to flush + re-select.
    if (otherEditorHolding(outlinePath, editorWindows.get(event.sender.id)?.win)) return { error: 'open-elsewhere' }
    // outlinePath comes from the renderer: rename only a talk folder inside the vault, to a sibling
    // folder that is still inside it.
    const vaultRoot = vaultRootFor(outlinePath)
    const src = talkFolderOfOutline(vaultRoot, outlinePath)
    if (!src.ok) { console.error('[vault:rename-talk] refused', src.error); return null }
    const srcDir = src.path
    const oldSlug = basename(outlinePath).replace('-outline.md', '')
    const newSlug = slugifyTalk(title) || oldSlug
    let dir = srcDir
    if (newSlug !== oldSlug) {
      const sibling = siblingTalkFolder(vaultRoot, srcDir, newSlug)
      if (!sibling.ok) { console.error('[vault:rename-talk] refused', sibling.error); return null }
      const target = sibling.path
      if (existsSync(target)) return { error: 'target-exists' }
      const oldReal = canonicalOutlinePath(outlinePath)
      outlineDiskGuard.forget(srcDir) // the app's own move or delete: never reported as a removal on disk
      renameSync(srcDir, target)
      renameSlugFiles(target, oldSlug, newSlug)
      dir = target
      // The talk's recovery copy (if any) moves with it, so its next open still offers it.
      const moved = findOutlineIn(target)
      if (moved) await outlineRecovery.rekey(oldReal, canonicalOutlinePath(moved)).catch((e) => console.error('[outline-recovery] rekey', e))
    }
    const newOutline = findOutlineIn(dir)
    if (newOutline) await retitleOutline(newOutline, title)
    invalidateVaultCaches(outlinePath)
    return talkInfoFor(dir)
  } catch (e) {
    console.error('[vault:rename-talk]', e)
    return null
  }
})

// Vault-relative path of an absolute path (forward-slashed), or '' when it is the root itself.
// The registry's resolve() does the stripping, so a root stored with a trailing slash (or any
// unnormalised form) still yields a clean relative path. A path in no vault keeps the old answer.
function vaultRel(abs: string, vaults: Vault[] = vaultRegistry.list()): string {
  const hit = resolveInVaults(vaults, abs)
  if (hit) return hit.rel
  const root = vaultRootFor(abs)
  if (!root) return ''
  const rel = abs.startsWith(root) ? abs.slice(root.length) : abs
  return rel.replace(/^[/\\]+/, '').split(pathSep).join('/')
}

// Create a folder under the vault (optionally nested under parentRel). Returns its vault-rel path.
ipcMain.handle('vault:create-folder', (_event, name: string, parentRel?: string, vaultId?: string) => {
  const vaultRoot = writableRootOfVault(vaultId)
  if (!vaultRoot) return null
  try {
    // name / parentRel come from the renderer: the new folder must land inside the vault.
    const target = createFolderTarget(vaultRoot, name, parentRel)
    if (!target.ok) { console.error('[vault:create-folder] refused', target.error); return null }
    const dir = target.path
    if (existsSync(dir)) return vaultRel(dir) // already there — idempotent
    mkdirInVault(vaultRoot, dir)
    invalidateTalkCache(vaultRoot)
    return vaultRel(dir)
  } catch (e) {
    console.error('[vault:create-folder]', e)
    return null
  }
})

// Rename a folder (by its vault-rel path). Returns the new vault-rel path.
ipcMain.handle('vault:rename-folder', (_event, folderRel: string, newName: string, vaultId?: string) => {
  const vaultRoot = writableRootOfVault(vaultId)
  if (!vaultRoot || !folderRel) return null
  try {
    // folderRel / newName come from the renderer: a folder inside the vault (never the vault root)
    // renamed to a sibling that is still inside the vault.
    const target = renameFolderTargets(vaultRoot, folderRel, newName)
    if (!target.ok) { console.error('[vault:rename-folder] refused', target.error); return null }
    const { src, dest } = target
    if (!existsSync(src) || existsSync(dest)) return null
    const oldReal = canonicalOutlinePath(src)
    outlineDiskGuard.forget(src) // the app's own move or delete: never reported as a removal on disk
    renameSync(src, dest)
    void outlineRecovery.rekey(oldReal, canonicalOutlinePath(dest), { under: true }).catch((e) => console.error('[outline-recovery] rekey', e))
    invalidateVaultCaches(vaultRoot)
    return vaultRel(dest)
  } catch (e) {
    console.error('[vault:rename-folder]', e)
    return null
  }
})

// Move a talk's whole folder into destFolderRel ('' = vault root). Returns the moved TalkInfo.
ipcMain.handle('vault:move-talk', (_event, outlinePath: string, destFolderRel: string) => {
  const vaultRoot = writableRootFor(outlinePath)
  if (!vaultRoot) return null
  try {
    // outlinePath / destFolderRel come from the renderer: move a talk folder inside the vault to a
    // folder inside the vault ('' = the vault root).
    const target = moveTalkTargets(vaultRoot, outlinePath, destFolderRel)
    if (!target.ok) { console.error('[vault:move-talk] refused', target.error); return null }
    const { srcDir, destParent, dest } = target
    mkdirInVault(vaultRoot, destParent)
    if (resolvePath(dest) === resolvePath(srcDir)) return talkInfoFor(srcDir) // no-op (same folder)
    if (existsSync(dest)) return null // a talk of that name already lives there
    const oldReal = canonicalOutlinePath(srcDir)
    outlineDiskGuard.forget(srcDir) // the app's own move or delete: never reported as a removal on disk
    renameSync(srcDir, dest)
    void outlineRecovery.rekey(oldReal, canonicalOutlinePath(dest), { under: true }).catch((e) => console.error('[outline-recovery] rekey', e))
    invalidateVaultCaches(vaultRoot)
    return talkInfoFor(dest)
  } catch (e) {
    console.error('[vault:move-talk]', e)
    return null
  }
})

// List CATEGORY folders under the vault (vault-rel paths), INCLUDING empty ones — so a folder you
// just created is visible in the sidebar even before any talk lives in it. A "category folder" is a
// directory that is NOT itself a talk folder (a talk folder directly contains a *-outline.md).
ipcMain.handle('vault:list-folders', async (_event, vaultId?: string) => {
  const vaultRoot = rootOfVault(vaultId)
  if (!vaultRoot) return []
  const SKIP = new Set(['bundle', 'dist', 'node_modules', '.git'])
  const isTalkDir = async (dir: string): Promise<boolean> => {
    try { return (await readdirAsync(dir)).some((f) => f.endsWith('-outline.md')) } catch { return false }
  }
  const out: string[] = []
  const vaults = vaultRegistry.list() // one config read for every folder's relative path
  const scan = async (dir: string, depth: number): Promise<void> => {
    if (depth > 3) return
    let entries
    try { entries = await readdirAsync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const name = entry.name
      // `_`-prefixed dirs are system areas (_assets, _SLIDE-VERSIONS), never category folders.
      if (name.startsWith('.') || name.startsWith('_') || SKIP.has(name)) continue
      if (!entry.isDirectory()) continue
      const full = join(dir, name)
      if (await isTalkDir(full)) continue // a talk, not a category folder
      out.push(vaultRel(full, vaults))
      await scan(full, depth + 1)
    }
  }
  await scan(vaultRoot, 0)
  return out
})

// Delete a talk — moved to the OS Trash (recoverable), not hard-deleted, so an accidental
// create/clone can be undone from Finder.
ipcMain.handle('vault:delete-talk', async (_event, outlinePath: string) => {
  // outlinePath comes from the renderer: trash only a talk folder inside the vault, never the vault
  // root or anything outside it.
  const target = talkFolderOfOutline(vaultRootFor(outlinePath), outlinePath)
  if (!target.ok) { console.error('[vault:delete-talk] refused', target.error); return false }
  try {
    outlineDiskGuard.forget(target.path) // the app's own move or delete: never reported as a removal on disk
    await shell.trashItem(target.path)
    invalidateVaultCaches(outlinePath)
    return true
  } catch (e) {
    console.error('[vault:delete-talk]', e)
    return false
  }
})

// Delete a category folder (and anything inside it) — also to the OS Trash (recoverable).
ipcMain.handle('vault:delete-folder', async (_event, folderRel: string, vaultId?: string) => {
  const vaultRoot = writableRootOfVault(vaultId)
  if (!vaultRoot || !folderRel) return false
  // folderRel comes from the renderer: a folder inside the vault, never the vault root.
  const target = deleteFolderTarget(vaultRoot, folderRel)
  if (!target.ok) { console.error('[vault:delete-folder] refused', target.error); return false }
  try {
    // A talk open in a window inside the folder is NOT forgotten: once the folder is in the Bin its
    // window shows the removed-file bar (shared-talk ticket 08), its saves are refused (a recovery copy
    // keeps the typing) and nothing is recreated unless the person chooses Save it again.
    const open = outlineDiskGuard.openUnder(target.path)
    await shell.trashItem(target.path)
    for (const realPath of open) await outlineDiskGuard.check(realPath).catch((e) => console.error('[vault:delete-folder] check', e))
    invalidateVaultCaches(vaultRoot)
    return true
  } catch (e) {
    console.error('[vault:delete-folder]', e)
    return false
  }
})

// Open a built artifact (file or folder) in the OS file manager / browser.
ipcMain.handle('shell:open-path', async (_event, path: string): Promise<boolean> => {
  try {
    const err = await shell.openPath(path)
    return err === ''
  } catch (e) {
    console.error('[shell:open-path]', e)
    return false
  }
})

// Reveal a file in Finder (select it in its folder) — for "I want to copy the file, not view it".
ipcMain.handle('shell:show-item-in-folder', async (_event, path: string): Promise<boolean> => {
  try {
    shell.showItemInFolder(path)
    return true
  } catch (e) {
    console.error('[shell:show-item-in-folder]', e)
    return false
  }
})

// Open an external URL (e.g. the published handout link) in the default browser.
ipcMain.handle('shell:open-external', async (_event, url: string): Promise<boolean> => {
  try {
    if (!/^https?:\/\//i.test(url)) return false
    await shell.openExternal(url)
    return true
  } catch (e) {
    console.error('[shell:open-external]', e)
    return false
  }
})

// ── Old-PowerPoint archive image search + import (read-only, ADR-0019) ────────
// The archive is a content-addressed store of slides extracted from old decks, with
// SQLite registries at {archiveRoot}/registry/{slides,media,images}.db. We never bundle a
// native SQLite module — instead we shell out to the system sqlite3 binary READ-ONLY, porting
// the proven query + path-resolution logic from raycast-slide-search (do not import it).
//
// The on-disk image files served back to the renderer go through the twarchive:// scheme
// (registered below in whenReady) with a path-traversal guard, so only files inside the
// archive root can be read. Importing an image copies its bytes into the CURRENT vault's
// _assets, content-addressed exactly like asset:paste-image, with a ppt-archive provenance
// sidecar.

const SQLITE3_CANDIDATES = ['/usr/bin/sqlite3', 'sqlite3', '/opt/homebrew/bin/sqlite3', '/opt/anaconda3/bin/sqlite3']

let cachedSqlite3: string | null | undefined
function detectSqlite3(): string | null {
  if (cachedSqlite3 !== undefined) return cachedSqlite3
  // Bare 'sqlite3' resolves on PATH at exec time; for the others verify the file exists.
  for (const cand of SQLITE3_CANDIDATES) {
    if (cand === 'sqlite3') {
      cachedSqlite3 = cand
      return cand
    }
    if (existsSync(cand)) {
      cachedSqlite3 = cand
      return cand
    }
  }
  cachedSqlite3 = null
  return null
}

function detectArchiveRoot(): string | null {
  const root = getConfig('archiveRoot', undefined) ?? null
  if (!root) return null
  return existsSync(join(root, 'registry', 'media.db')) ? root : null
}

class SqliteError extends Error {}

// Run sqlite3 with the SQL script on stdin, no shell. Mirrors raycast runSqlite3.
function runSqlite3(binary: string, args: string[], script: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      binary,
      args,
      { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new SqliteError((stderr || '').toString().trim() || err.message))
          return
        }
        resolve((stdout || '').toString())
      }
    )
    child.stdin?.end(script)
  })
}

function shellQuoteSqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}
function toParamLiteral(value: string | number | null): string {
  if (value === null) return 'NULL'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new SqliteError('Non-finite numeric param: ' + value)
    return String(value)
  }
  return shellQuoteSqlString(value)
}

// Parameterised read-only query. The sqlite3 CLI cannot take out-of-band bind values, so each
// ? is replaced by a hardened SQL literal (numbers verified finite; strings single-quote
// escaped by doubling every quote → user input is always data, never syntax).
async function sqliteQuery<T = Record<string, string>>(opts: {
  binary: string
  dbPath: string
  sql: string
  params?: Array<string | number | null>
  attach?: Record<string, string>
  timeoutMs?: number
}): Promise<T[]> {
  const params = opts.params ?? []
  let i = 0
  const inlined = opts.sql.replace(/\?/g, () => {
    if (i >= params.length) throw new SqliteError('More ? placeholders than params')
    return toParamLiteral(params[i++])
  })
  if (i !== params.length) throw new SqliteError(`Placeholder count (${i}) != params length (${params.length})`)

  const lines: string[] = []
  for (const [schema, path] of Object.entries(opts.attach ?? {})) {
    lines.push(`ATTACH DATABASE ${shellQuoteSqlString('file:' + path + '?mode=ro')} AS ${schema};`)
  }
  lines.push(inlined.trim().endsWith(';') ? inlined : inlined + ';')
  const script = lines.join('\n')

  const dbUri = 'file:' + opts.dbPath + '?mode=ro'
  const stdout = await runSqlite3(opts.binary, ['-json', '-readonly', dbUri], script, opts.timeoutMs ?? 8000)
  const trimmed = stdout.trim()
  if (!trimmed) return []
  try {
    return JSON.parse(trimmed) as T[]
  } catch {
    throw new SqliteError('sqlite3 returned non-JSON output: ' + trimmed.slice(0, 200))
  }
}

// ── archive image file path resolution (ported from raycast paths.ts) ─────────
// Prefer a content-addressed media-store entry (survives source pruning); fall back to the
// per-deck extracted copy. Returns an absolute path or null when nothing is on disk.
const MEDIA_STORE_DIRS = ['media-store', 'media_store']
function archiveImagePath(archiveRoot: string, presentationId: string, relPath: string, sha256: string): string | null {
  const ext = (relPath.split('.').pop() || '').toLowerCase()
  for (const storeName of MEDIA_STORE_DIRS) {
    if (!ext) break
    const flat = join(archiveRoot, storeName, sha256 + '.' + ext)
    if (existsSync(flat)) return flat
    const sharded = join(archiveRoot, storeName, sha256.slice(0, 2), sha256 + '.' + ext)
    if (existsSync(sharded)) return sharded
  }
  const perDeck = join(archiveRoot, 'extracted', presentationId, relPath)
  if (existsSync(perDeck)) return perDeck
  return null
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// The registry has no separate human title column; presentation_id IS the deck name for
// readable decks ("01 MondAI Roundup - 11 Nov 24") and a UUID for the rest. Surface the
// readable ones as deckTitle; leave UUID-only decks without one.
function deckTitleFor(presentationId: string): string | undefined {
  if (!presentationId || UUID_RE.test(presentationId)) return undefined
  return presentationId
}

// base64url helpers for the twarchive:// scheme (RFC 4648 §5, no padding).
function toBase64Url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function fromBase64Url(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(b64, 'base64').toString('utf8')
}

// twarchive:// is registered as a STANDARD scheme, so Chromium canonicalises the URL host to
// lowercase — which would corrupt the case-sensitive base64url payload. Keep the payload in the
// URL PATH (case-preserved) behind a fixed throwaway host. The thumbUrl value still carries the
// base64url of the absolute file path, per contract; decoding tolerates both shapes.
const TWARCHIVE_HOST = 'f'
function twarchiveUrl(absPath: string): string {
  return 'twarchive://' + TWARCHIVE_HOST + '/' + toBase64Url(absPath)
}
// Pull the base64url payload out of any twarchive:// URL shape (path-first, or legacy host).
function twarchivePayload(url: string): string {
  const rest = url.slice('twarchive://'.length)
  const slash = rest.indexOf('/')
  // Path form twarchive://<host>/<payload>: take everything after the first slash.
  if (slash >= 0) return rest.slice(slash + 1).replace(/\/+$/, '')
  // Bare form twarchive://<payload> (legacy / raw): the whole remainder.
  return rest.replace(/\/+$/, '')
}

// Guard: resolve symlinks where possible and require the path to sit inside the archive root.
function isInsideArchive(absPath: string, archiveRoot: string): boolean {
  let resolvedRoot: string
  let resolvedPath: string
  try {
    resolvedRoot = realpathSync(archiveRoot)
  } catch {
    resolvedRoot = resolvePath(archiveRoot)
  }
  try {
    resolvedPath = realpathSync(absPath)
  } catch {
    resolvedPath = resolvePath(absPath)
  }
  const rootWithSep = resolvedRoot.endsWith(pathSep) ? resolvedRoot : resolvedRoot + pathSep
  return resolvedPath === resolvedRoot || resolvedPath.startsWith(rootWithSep)
}

ipcMain.handle('archive:available', async (): Promise<boolean> => {
  return detectArchiveRoot() !== null && detectSqlite3() !== null
})

interface ArchiveImageHit {
  assetKey: string
  presentationId: string
  relPath: string
  sha256?: string
  ocrText: string
  thumbUrl: string
  deckTitle?: string
}

interface OcrAssetRow {
  asset_key: string
  presentation_id: string | null
  rel_path: string | null
  text: string | null
}

ipcMain.handle('archive:search-images', async (_event, query: string): Promise<ArchiveImageHit[] | null> => {
  const archiveRoot = detectArchiveRoot()
  const sqlite3Path = detectSqlite3()
  if (!archiveRoot || !sqlite3Path) return null
  try {
    // media.db has no FTS; ocr_assets.text holds the OCR. LIKE on each bare token (escaped to a
    // literal), AND across tokens — mirrors raycast searchImages.
    const tokens = (query || '')
      .trim()
      .split(/\s+/)
      .map((t) => t.replace(/[%_]/g, (m) => '\\' + m))
      .filter(Boolean)
    if (tokens.length === 0) return []

    const whereLikes = tokens.map(() => `o.text LIKE ? ESCAPE '\\'`).join(' AND ')
    const params: Array<string | number> = tokens.map((t) => '%' + t + '%')
    params.push(60)

    const rows = await sqliteQuery<OcrAssetRow>({
      binary: sqlite3Path,
      dbPath: join(archiveRoot, 'registry', 'media.db'),
      sql: `SELECT o.asset_key, o.presentation_id, o.rel_path, o.text
            FROM ocr_assets o
            WHERE o.kind = 'image'
              AND o.text IS NOT NULL
              AND ${whereLikes}
            ORDER BY length(o.text) DESC
            LIMIT ?`,
      params
    })

    const hits: ArchiveImageHit[] = []
    for (const r of rows) {
      const sha = r.asset_key
      const pid = r.presentation_id || ''
      const relPath = r.rel_path || ''
      const filePath = archiveImagePath(archiveRoot, pid, relPath, sha)
      if (!filePath) continue // skip hits with no file on disk
      hits.push({
        assetKey: sha,
        presentationId: pid,
        relPath,
        sha256: sha,
        ocrText: r.text || '',
        thumbUrl: twarchiveUrl(filePath),
        deckTitle: deckTitleFor(pid)
      })
    }
    return hits
  } catch (e) {
    console.error('[archive:search-images]', e)
    return null
  }
})

ipcMain.handle(
  'archive:import-image',
  async (_event, thumbUrlOrPath: string): Promise<{ id: string; ext: string; path: string } | null> => {
    const vaultRoot = writableVaultRoot()
    const archiveRoot = detectArchiveRoot()
    if (!vaultRoot || !archiveRoot) return null
    try {
      // Decode the source path: either a twarchive:// URL (b64url of an absolute path, carried in
      // the URL path so its case survives Chromium canonicalisation) or a raw absolute path.
      let absPath: string
      if (thumbUrlOrPath.startsWith('twarchive://')) {
        absPath = fromBase64Url(twarchivePayload(thumbUrlOrPath))
      } else {
        absPath = thumbUrlOrPath
      }
      absPath = resolvePath(absPath)

      // Verify the file is inside the read-only archive before reading it.
      if (!isInsideArchive(absPath, archiveRoot)) {
        console.warn('[archive:import-image] refused path outside archive:', absPath)
        return null
      }
      if (!existsSync(absPath)) return null

      const origBuf = readFileSync(absPath)
      const ext = (absPath.split('.').pop() || 'png').toLowerCase()

      // Content-address the bytes exactly like asset:paste-image (img-{7hex sha256}.{ext}).
      const hash = createHash('sha256').update(origBuf).digest('hex').slice(0, 7)
      const id = 'img-' + hash
      const assetsDir = join(vaultRoot, '_assets')
      mkdirInVault(vaultRoot, assetsDir)
      const assetPath = join(assetsDir, id + '.' + ext)
      if (!existsSync(assetPath)) {
        writeFileSync(assetPath, origBuf)
        const sidecarPath = join(assetsDir, id + '.yml')
        if (!existsSync(sidecarPath)) {
          // Provenance: source ppt-archive, with the originating archive path noted.
          const note = 'imported from ppt-archive: ' + absPath
          writeFileSync(
            sidecarPath,
            [
              'id: ' + id,
              'created: ' + new Date().toISOString().slice(0, 10),
              'original_format: ' + ext,
              'note: ' + JSON.stringify(note),
              'alt: ""',
              'caption: ""',
              'source: "ppt-archive"',
              'tags: []'
            ].join('\n') + '\n',
            'utf8'
          )
        }
      }
      return { id, ext, path: assetPath }
    } catch (e) {
      console.error('[archive:import-image]', e)
      return null
    }
  }
)

// ── App lifecycle ──────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  initialiseLiveSessions()
  // Feedback-boards ticket 06: History's board actions and the Run's read-only share link.
  registerRunBoardIpc({
    ipcMain: ipcMain as unknown as Parameters<typeof registerRunBoardIpc>[0]['ipcMain'],
    vaultRoot: () => writableVaultRoot() ?? null, // writes: only a vault folder that is there (ticket 07)
    sessions: () => liveSessions,
    shares: createRunResultsShares({
      registryPath: join(app.getPath('userData'), 'run-results-share-registry.json'),
      endpoint: () => ensureLiveWorker(),
      linkBase: () => getConfig('sharedTalkLinkBase', undefined),
      fetch,
    }),
  })
  // Feedback-boards ticket 09: History's pre-work actions, and a pull every few minutes while any
  // Run's pre-work is open (answers reach the Run through the atomic Run writer).
  registerRunPreworkIpc(ipcMain as unknown as Parameters<typeof registerRunPreworkIpc>[0], runPrework(), {
    onQuestionMarked: (talkSlug, runId) => {
      for (const wcId of livePresenterContexts.keys()) {
        const record = liveSessions?.record(wcId)
        if (!record || record.talkSlug !== talkSlug || record.runId !== runId) continue
        const win = BrowserWindow.getAllWindows().find((item) => item.webContents.id === wcId)
        if (win && !win.isDestroyed()) win.webContents.send('live:prework-questions', preworkTrayForSession(currentVaultRoot() ?? null, record))
      }
    },
  })
  // The Run page's board slides: which board slide each pre-work step feeds, with the compiler's own slide ids.
  ipcMain.handle('history:prework-feeds', async (_event, payload: unknown) => {
    try {
      const talk = talkBySlug(String((payload as { talkSlug?: unknown } | null)?.talkSlug ?? ''))
      if (!talk) return { ok: false as const }
      const prepared = await prepareTalk(talk.outlinePath, readFileSync(talk.outlinePath, 'utf8'))
      const prework = prepared?.model?.prework as { feeds?: PreworkFeed[] } | undefined
      return prepared ? { ok: true as const, feeds: prework?.feeds ?? [] } : { ok: false as const }
    } catch { return { ok: false as const } }
  })
  startRunPreworkTimer(runPrework(), () => notifyTalkMetaUpdated())
  // Feedback rail: open the owner socket of every shared talk (never blocks launch).
  try { sharedTalkFeedback().sync() } catch (error) { console.warn('[shared-talk] feedback start failed', error) }
  installApplicationMenu()
  // Let embedded iframes load sites that would otherwise refuse framing (X-Frame-Options /
  // CSP frame-ancestors). Scoped to SUB-FRAMES only, so app/editor chrome and top-level loads
  // are untouched. App-only — a shared HTML file in a browser can't do this (hence the compile-
  // time "Open ↗" caption beside remote embeds).
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (details.resourceType !== 'subFrame') {
      callback({})
      return
    }
    const headers = details.responseHeaders ?? {}
    for (const key of Object.keys(headers)) {
      const lower = key.toLowerCase()
      if (lower === 'x-frame-options') {
        delete headers[key]
      } else if (lower === 'content-security-policy') {
        headers[key] = (headers[key] as string[]).map((v) =>
          v.replace(/frame-ancestors[^;]*;?/gi, '').trim()
        )
      }
    }
    callback({ responseHeaders: headers })
  })

  // 2026-07-08: YouTube's embedded player refuses to configure without an HTTP Referer
  // ("Error 153 — video player configuration error"). Decks load from file:// / twpresent://,
  // which send none, so inject a stable https referer on player requests. Vimeo's player has
  // the same domain-check behaviour. App-only — an exported deck opened from file:// in a
  // plain browser still needs "Watch on YouTube" (the player's own fallback link).
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['*://*.youtube.com/*', '*://*.youtube-nocookie.com/*', '*://player.vimeo.com/*'] },
    (details, callback) => {
      const headers = details.requestHeaders ?? {}
      if (!headers['Referer'] && !headers['referer']) headers['Referer'] = 'https://talkweaver.app/'
      callback({ requestHeaders: headers })
    }
  )

  // Register twasset:// to serve vault asset files safely
  protocol.registerFileProtocol('twasset', (request, callback) => {
    const vaultRoot = currentVaultRoot()
    if (!vaultRoot) { callback({ error: -2 }); return }
    // twasset://img-a3f9b2 ; tolerate the legacy double prefix (img-img-…) from the old import bug.
    const id = new URL(request.url).hostname.replace(/^img-img-/, 'img-')
    const assetsDir = join(vaultRoot, '_assets')
    // A clip (vid-…) serves its POSTER image — authoring previews never play (ADR-0028).
    if (/^vid-[0-9a-f]{7}$/.test(id)) {
      const poster = join(assetsDir, id + '.jpg')
      if (existsSync(poster)) { callback({ path: poster }); return }
      callback({ error: -2 }); return
    }
    // Try common image extensions in order
    for (const ext of ['webp', 'png', 'jpg', 'jpeg', 'gif']) {
      const p = join(assetsDir, id + '.' + ext)
      if (existsSync(p)) { callback({ path: p }); return }
    }
    callback({ error: -2 })
  })
  // Serve rendered slide thumbnails: twthumb://<slug>/<key> -> {userData}/thumb-cache/<slug>/<key>.png
  // `?vault=<id>` reads that vault's folder only; a bare URL tries the open vaults in order, then the
  // namespace level (thumb-cache-dirs.ts).
  protocol.registerFileProtocol('twthumb', (request, callback) => {
    try {
      const req = parseThumbUrl(request.url)
      if (!req) { callback({ error: -2 }); return }
      // Slug and key come from the URL: only a PNG inside this talk's thumbnail folders.
      const namespaceDir = thumbNamespaceDir()
      if (!thumbCacheDir(namespaceDir, req.slug).ok) { callback({ error: -2 }); return }
      adoptLegacyThumbsOnce()
      touchNamespaceHourly() // a read-only session keeps older builds' cache sweep away too
      const openIds = vaultRegistry.list().filter((v) => v.open).map((v) => v.id)
      const dirs = thumbLookupDirs(namespaceDir, req, openIds).filter((d) => pathStaysInside(namespaceDir, d) !== null)
      // Fallback: the pre-render writes DOCUMENT-SCOPED filenames `<documentId>-<render_hash>.png`
      // (thumbnailDocumentCacheKey), but the Slide Browser can only address a slide by its bare
      // `render_hash` — it never compiles the talk, so it cannot know the documentId. Resolve the
      // bare key to `<documentId>-<key>.png`. This is safe: render_hash is the PICTURE identity
      // (it already folds in layout + section accent), so any file with that suffix is the same
      // picture. Without this, tens of thousands of correctly-built thumbnails were unreachable and
      // every browser card rendered blank (2026-07-19).
      for (const dir of dirs) {
        const hit = resolveThumbFile(dir, req.key)
        if (hit) { callback({ path: hit }); return }
      }
    } catch { /* fall through */ }
    callback({ error: -2 })
  })
  // Serve a recorded Session's local audio: twrec://<sessionId> -> {userData}/recordings/<id>.webm.
  // The session id is a controlled `sess-<utc>-<rand>` token (no user path input), so serving the
  // file directly is safe; Range requests (seeking) work via the stream-privileged scheme.
  protocol.registerFileProtocol('twrec', (request, callback) => {
    try {
      const sessionId = new URL(request.url).hostname
      if (!sessionId) { callback({ error: -2 }); return }
      const p = recordingAudioPath(app.getPath('userData'), sessionId)
      if (p && existsSync(p)) { callback({ path: p }); return }
    } catch { /* fall through */ }
    callback({ error: -2 })
  })
  // Serve in-memory live previews from the dedicated preview host, and Talk build files to
  // Studio replay everywhere else. Talk paths keep the existing containment guards.
  protocol.handle('twpresent', async (request) => {
    try {
      const url = new URL(request.url)
      if (url.hostname === 'preview') {
        const previewId = slidePreviewIdFromUrl(request.url)
        const html = previewId == null ? undefined : slidePreviewStore.get(previewId)
        return html == null
          ? new Response('Preview not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } })
          : new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
      }
      const slug = decodeURIComponent(url.hostname)
      const talk = talkBySlug(slug)
      if (!talk) return new Response('Not found', { status: 404 })
      const rel = decodeURIComponent(url.pathname.replace(/^\/+/, '')) || `${slug}-present.html`
      const absPath = resolvePath(talk.path, rel)
      if (!isInsideArchive(absPath, talk.path)) return new Response('Not found', { status: 404 })
      if (existsSync(absPath) && statSync(absPath).isFile()) return net.fetch(pathToFileURL(absPath).href)
    } catch { /* fall through */ }
    return new Response('Not found', { status: 404 })
  })
  // Serve read-only old-PowerPoint archive image files: twarchive://<b64url> where b64url is
  // the base64url of an absolute file path. Decode, then serve ONLY if the resolved real path
  // sits inside the archive root (path-traversal guard via realpath/resolve + startsWith).
  protocol.registerFileProtocol('twarchive', (request, callback) => {
    try {
      const archiveRoot = detectArchiveRoot()
      if (!archiveRoot) { callback({ error: -2 }); return }
      // Payload is the case-preserved base64url in the URL path (twarchive://f/<b64url>).
      const b64 = decodeURIComponent(twarchivePayload(request.url))
      const decoded = fromBase64Url(b64)
      const absPath = resolvePath(decoded)
      if (!isInsideArchive(absPath, archiveRoot)) { callback({ error: -2 }); return }
      if (existsSync(absPath)) { callback({ path: absPath }); return }
    } catch { /* fall through */ }
    callback({ error: -2 })
  })
  // Serve local image files referenced by path in an outline: twfile://f/<b64url> where b64url
  // is the base64url of an absolute path. Served ONLY if the resolved real path sits inside the
  // vault root (path-traversal guard) — the editor uses this to preview path-based images.
  protocol.registerFileProtocol('twfile', (request, callback) => {
    try {
      const vaultRoot = currentVaultRoot()
      if (!vaultRoot) { callback({ error: -2 }); return }
      const rest = request.url.slice('twfile://'.length)
      const slash = rest.indexOf('/')
      const payload = slash >= 0 ? rest.slice(slash + 1) : rest
      const decoded = fromBase64Url(decodeURIComponent(payload.replace(/\/+$/, '')))
      const absPath = resolvePath(decoded)
      if (!isInsideArchive(absPath, vaultRoot)) { callback({ error: -2 }); return }
      if (existsSync(absPath)) { callback({ path: absPath }); return }
    } catch { /* fall through */ }
    callback({ error: -2 })
  })
  createWindow()

  // Recording uploads are ON REQUEST ONLY (never automatic) — no launch drain, no retry loop.
  // A recording uploads only when the user clicks Upload in Studio (recording:upload).

  // Load any persisted search index, then warm stale entries in the background so the first ⌘K
  // is instant. Once the text index is warm, prerender only changed/new talks (or talks whose
  // thumbnail directory is missing); the persisted prerender ledger skips compilation entirely
  // for unchanged talks while keeping cross-Talk search backed by rendered slides (ADR-0019).
  loadSearchIndexFromDisk()
  loadOcrCache()
  // Temp files an interrupted config write left behind (config-file.ts), older than a minute.
  configFile().sweepStaleTemps(60_000)
  // SCALE (2026-07-20, Dominik): a vault can now hold thousands of imported slides. The old startup
  // ran an EAGER whole-vault sweep — render every changed slide's thumbnail in a hidden window, then
  // OCR every image — which, dumped 1400+ slides at once, beachballed and natively crashed the app.
  // New policy = lazy + bounded: thumbnails render ON DEMAND as talks are browsed (the Slide Browser
  // already requests a per-talk render on a cache miss), and OCR (image-text search, the heaviest and
  // least essential pass) is OPT-IN via `ocrEnabled` (default off). Only the light search-index warm
  // still runs at startup so cross-talk ⌘K stays instant; prerenderAllThumbnails remains available
  // for an explicit "rebuild previews" action.
  setTimeout(() => {
    // Frontmatter details and delivery summaries for talk search: cheap, read before first use.
    talkSearch.warm().catch(() => {})
    warmSearchIndex()
      .catch(() => {})
      .finally(() => {
        if (getConfig('ocrEnabled', false)) {
          setTimeout(() => { ocrAllVaultImages().catch(() => {}) }, 3000)
        }
      })
  }, 800)
  // Presentation backup (ADR-0024): ONE pass over the enrolled talks that are stale, never a
  // vault scan and never a timer. It waits for the first window to be on screen and then a further
  // 30s, so nothing competes with launch — the old startup sweep OOM-killed the app at ~13.6s.
  {
    const first = BrowserWindow.getAllWindows()[0]
    const armLaunchBackup = (): void => {
      setTimeout(() => { runLaunchBackup().catch(() => {}) }, 30_000)
    }
    if (!first || first.isVisible()) armLaunchBackup()
    else first.once('ready-to-show', armLaunchBackup)
  }
  // Orphaned thumbnail namespaces (a profile held 56 of them, 52 GB): one async sweep per
  // session, 90s after the first window so launch and the backup pass (30s) run first. Never the
  // live namespace, never one with activity in the last 7 days (thumbnail-cache-gc.ts).
  {
    const first = BrowserWindow.getAllWindows()[0]
    const armThumbSweep = (): void => {
      setTimeout(() => {
        sweepOrphanedThumbCaches(app.getPath('userData'), thumbCacheRoot(), { log: (m) => console.log(m) })
          .catch((e) => console.error('[thumbnails] cache sweep failed', e))
      }, 90_000)
    }
    if (!first || first.isVisible()) armThumbSweep()
    else first.once('ready-to-show', armThumbSweep)
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  liveSessions?.shutdown()
  sharedTalkFeedbackService?.stopAll()
  try { localLiveWorker?.process.kill('SIGTERM') } catch { /* already stopped */ }
  localLiveWorker = null
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
