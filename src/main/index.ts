import { researchDestinations } from './research-writer'
import { researchWriteHandler } from './agent-verbs'
import { RESEARCH_INSERT_VERB, RESEARCH_MAKE_SLIDE_VERB } from './agent-verbs'
import { revealResearchSource } from './research-reader'
import { INK_LIMITS, parseInkMessage, parsePointerMessage } from '../../worker/protocol'
import { createLatestThumbnailRequestHandler } from './thumbnail-queue'
import { app, BrowserWindow, clipboard, ipcMain, dialog, Menu, net, protocol, shell, session, screen, powerMonitor, WebContentsView, type IpcMainInvokeEvent, type MenuItemConstructorOptions } from 'electron'
import { join, basename, dirname, extname } from 'path'

// EPIPE guard: when the packaged binary is launched with stdout/stderr piped and the pipe
// dies, any console.log (prerenderAllThumbnails logs a lot) would otherwise throw an
// uncaught EPIPE and crash the main process with a dialog. Swallow stream errors — logging
// must never kill the app.
process.stdout.on('error', () => {})
process.stderr.on('error', () => {})

const E2E = process.env.TW_E2E === '1'

// `TalkWeaver setup …` (ticket 07, spec D14): the set-up command for an agent. Found here, before
// the single-instance lock: it opens no window and shows no Dock icon, runs its one command once the
// app is ready (app.whenReady below) and exits with its code. It takes the same lock as the app
// (Owner, 10 Oct: setup refuses while the app is open), so only one process ever writes this folder.
const SETUP_ARGS = setupArguments(process.argv, Boolean(process.defaultApp))
if (SETUP_ARGS) app.dock?.hide()
// `TalkWeaver settings …` (0.42, settings-cli.ts): the agent's settings path. Like `setup` it opens no
// window, but it takes no single-instance lock: the settings file has its own, so it runs beside an open app.
const SETTINGS_ARGS = SETUP_ARGS ? null : settingsArguments(process.argv, Boolean(process.defaultApp))
if (SETTINGS_ARGS) app.dock?.hide()

// One TalkWeaver per user-data folder (ticket 12): two instances on one folder would share the
// share registry, the owner-token store and every other file there, each holding its own copy in
// memory. The lock is Electron's, held per user-data folder, so a run started with its own
// --user-data-dir (every e2e harness) is unaffected. A second launch on the same folder hands
// over to the first (its window comes forward) and quits before it touches anything.
// A setup command says so in the lock's data, so an open TalkWeaver does not bring its window
// forward for a command it is refusing.
const SETUP_LOCK_DATA = { talkweaverSetup: true }
const holdsInstanceLock = SETTINGS_ARGS ? false : app.requestSingleInstanceLock(SETUP_ARGS ? SETUP_LOCK_DATA : undefined)
if (SETTINGS_ARGS) {
  // No lock, no window: the command runs once the app is ready and exits (app.whenReady below).
} else if (SETUP_ARGS) {
  if (!holdsInstanceLock) {
    // TalkWeaver is open on this folder: refused before anything is parsed, read from standard input
    // or written. Written at once (a few bytes to a pipe or terminal) so the process can go now.
    try { writeSync(1, `${appOpenRefusal(SETUP_ARGS)}\n`) } catch { /* the reader has gone */ }
    app.exit(1)
  }
  // Holding the lock: held until this process exits. A TalkWeaver launched meanwhile loses the lock
  // and exits (below); its 'second-instance' event comes here, where nothing listens for it, so no
  // window ever opens over a half-finished set-up.
} else if (!holdsInstanceLock) {
  app.exit(0)
} else {
  app.on('second-instance', (_event, _argv, _cwd, data) => {
    // A `setup` command that lost the lock refuses on its own: nothing comes forward for it.
    if ((data as { talkweaverSetup?: unknown } | null)?.talkweaverSetup === true) return
    // Editor windows only (round 4): a hidden utility window (the thumbnail renderer) is never shown.
    const win = targetEditorFor(null)
    if (!win) { if (app.isReady()) createWindow(); return }
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })
}

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
// Bounded (1 MB, trimmed to its last 512 KB) so a crash loop cannot fill the user's disk.
const appendMainError = createErrorLog(() => join(app.getPath('userData'), 'tw-main-errors.log'))
function logMainError(kind: string, err: unknown): void {
  try { console.error(`[main] ${kind}:`, err) } catch {}
  appendMainError(kind, err)
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
  // Serves a recorded Session's local audio (twrec://<sessionId>?talk=<talkSlug>) to Studio's <audio>. `stream`
  // enables Range requests so the player can seek/scrub without downloading the whole file.
  { scheme: 'twrec', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  // Serves the compiled present HTML and sibling assets for Studio replay iframes.
  { scheme: 'twpresent', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])
// No window navigates away from its own page: a web or mail link goes to the OS, anything else is
// refused (navigation-guard.ts). Installed before the first window; under E2E links are only logged.
installNavigationGuard(app, {
  openExternal: (url) => E2E ? console.log('[navigation] external (E2E):', url) : shell.openExternal(url),
  openPath: (path) => E2E ? console.log('[navigation] local page (E2E):', path) : shell.openPath(path),
  // No window hands the OS a link whose host is local as written, or anything from a blank page
  // (hand-out.ts): the rule is for EVERY window, so a deck renderer added later is covered without
  // being marked. A hidden renderer (thumbnail capture: window-kinds.ts) navigates nowhere and hands
  // out nothing at all.
  refuseHandOut: (_contents, link, from) => contentHandOutRefusal({ url: link, from }),
  isHiddenRenderer: (contents) => isHiddenRenderer((contents as { id?: unknown } | null)?.id),
  // A live web page's own view judges its own navigations and never hands anything to the OS (live-page-host.ts).
  isLivePageContents,
  // A frame showing a Slide Scratchpad page stays on that page: its own script cannot send it to twfile:// or
  // another twpresent:// address (scratchpad-html.ts).
  frameRule: scratchFrameNavigation
})
// No IPC listener answers a frame that is not its window's main frame (ipc-main-frame-only.ts).
// Applied to ipcMain itself, here, BEFORE the first registration below and before any module is
// handed ipcMain: a listener registered earlier would not be covered (a unit test checks the order).
applyMainFrameOnly(ipcMain)
// When a real key or mouse press last reached each window (recent-press.ts): asked by the clipboard
// read and by a deck window's web links. Installed before the first window.
const pressLedger = createPressLedger()
installPressLedger(app, pressLedger)
import { fileURLToPath, pathToFileURL } from 'url'
import { cpus, homedir, hostname, loadavg, tmpdir, totalmem } from 'os'
import { installNavigationGuard } from './navigation-guard'
import { applyMainFrameOnly } from './ipc-main-frame-only'
import { contentHandOutRefusal, handOutLink } from './hand-out'
import { decideDownload, isAppWindow, isHiddenRenderer } from './window-kinds'
import { createPressLedger, installPressLedger } from './recent-press'
import { liveReadClipboardHandler } from './live-read-clipboard'
import { appLocalHostOf, installLocalAddressFilter } from './local-address-filter'
import { createOpenRequests, refuseOpenTarget } from './open-requests'
import { decideOpenInNewWindow, parseOpenInNewWindowTarget, type OpenInNewWindowTarget } from '../shared/open-in-new-window'
import { canonicalOutlinePath, editorEntryForOutline, outlineIdentity, type EditorWindowEntry } from './outline-identity'
import {
  configureTalkWriter, emptyOverNonemptyMessage, flushTalkForPublish, isStructurallyEmptyOutline, readTalkOutline, withTalkFileLock, writeTalkOutline,
  type EditorBuffer, type TalkWriteOptions, type TalkWriteOrigin,
} from './talk-writer'
import { readAbstract, writeAbstract } from './abstract-ipc'
import { registerScratchpadIpc } from './scratchpad-ipc'
import { createScratchVisualImporter, slideSourceOutline } from './scratchpad-visual-import'
import { createScratchpadHtmlPreviews, scratchFrameNavigation } from './scratchpad-html'
import { createHtmlThumbnailer } from './scratchpad-html-thumb'
import { createHtmlCapture } from './scratchpad-html-capture'
import { researchCaptureHandler, researchRevealHandler, researchReadHandler } from './agent-verbs'
import { createOutlineDiskGuard } from './outline-disk-guard'
import { createOutlineRecovery } from './outline-recovery'
import { createDirectoryWatcherRegistry } from './talkTextWatchers'
import type { OutlineDiskChange } from '../shared/outline-disk-change'
import { type Dirent, existsSync, lstatSync, readdirSync, statSync, readFileSync, writeFileSync, mkdirSync, realpathSync, cpSync, rmSync, renameSync, createReadStream, constants as fsConstants, mkdtempSync, openSync, readSync, closeSync, appendFileSync, watch, writeSync } from 'fs'
import { createHash, randomBytes, randomUUID } from 'crypto'
import { execFile, execFileSync, spawn, type ChildProcessByStdio } from 'child_process'
import type { Readable } from 'stream'
import { resolve as resolvePath, sep as pathSep, relative as relativePath, isAbsolute } from 'path'
import { cancelThumbnailRender, recycleRenderWindow, renderThumbnails, renderThumbnailsIdle, renderWindowProcessId, thumbnailForeground } from './thumbnails'
import { createThumbnailPrewarm, type PrewarmTalk } from './thumbnail-prewarm'
import { thumbKeysIn } from './thumb-key-resolution'
import { createVariantThumbnailHandler, createVariantThumbnailRenderer, mediaFingerprint } from './layout-variant-thumbnail'
import {
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
import { createArchiveProvider } from './image-search/archive-provider'
import { createImageSearch } from './image-search/image-search'
import { createSlideWellProvider, locateSlideWell } from './image-search/slidewell-provider'
import { detectSqlite3 } from './image-search/sqlite-read'
import { fromBase64Url, isInsideRoot } from './image-search/thumb-url'
import { createVaultPictureSearch, twassetFileFor, gatherVaultImages as gatherVaultImagesIn, MAX_VAULT_QUERY } from './image-search/vault-pictures'
import { createOcrIndex, type OcrIndex, type OcrPicture } from './ocr-index'
import { createSlideSearch, normalizeSearchQuery, type ImageTextSource, type SearchQuery } from './slide-search'
import { compactSlideSearchReply } from '../shared/slide-search-reply'
import { currentSearchTalks, scanWithStartStamp, searchIndexStamp } from './search-index-stamp'
import { OCR_PICTURE_EXTS, deckPicturesOf, extractImageRefs, resolveImagePaths, rowImageRefs, slideImagePaths, talkImagePaths, type DeckPictures, type ImageRef } from './slide-image-refs'
import { createSupersedeTracker } from './search-supersede'
import { importImageForTalk, talkVaultWriteRoot, type ImageImportDeps } from './image-search/image-import'
import type { ImageSearchResult, ImageSearchStatus, ImportedImage, MatchMode, VaultPictureResult } from '../shared/image-search'
import { decideShellPath } from './shell-path-policy'
import { resolveImageRefs } from './image-refs'
import { assetRootsForTalk, talkVaultRoot } from './asset-roots'
import { convertibleImageRefs, planOptimisation, rewriteConvertedRefs, writeNewFile, type AssetContainment } from './optimise-images'
import { isSearchIndexEntryFresh } from './search-index-freshness'
import { sweepOrphanedThumbCaches } from './thumbnail-cache-gc'
import { createPreparationRoute, createPreparedTalkCache, memoiseUntilFailure, preparedTalkGroup, type PreparationLane } from './prepared-talk-cache'
import { preparePass, setPreparationReleaseHook, withPrewarmYield } from './preparation-gate'
import {
  BROWSER_THUMBNAIL_LANE,
  THUMBNAIL_HEAP_WAIT_MAX_MS,
  heapGuardDecision,
  thumbnailMediaOptions,
  waitForHeap
} from './thumbnail-media-policy'
import { createAppendLog, createErrorLog } from './main-log'
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
import { HTML_PAGE_TEXT, createHtmlPageImportRunner, importHtmlPage, registerHtmlPageImportIpc } from './html-page-import'
import { registerObjectStatusIpc } from './object-status'
import { ExampleVault, resolveExampleHome } from './example-vault'
import { ExampleVaultRemoval, windowsOnExample, type OpenAppWindow } from './example-vault-removal'
import { resolveExampleTrash } from './example-trash-harness'
import { resolveNewTalkDefaults } from '../shared/vault-defaults'
import { pathsInVault, pathsOutsideOpenVaults, searchVaults } from './vault-scope'
import { VAULTS_DIR, adoptLegacyThumbDirs, isPlainSegment, parseThumbUrl, talkThumbDir, thumbFileFor, thumbLookupDirs, thumbUrl, touchNamespace } from './thumb-cache-dirs'
import { createConfigFile, type ConfigFile } from './config-file'
import type { ConfigOverlay } from './settings-overlay'
import { settingsPageUrl, startSettingsHost, type TalkWeaverSettings } from './settings-host'
import { createSecretSlots, recordedKeyChange } from './settings-secret-slots'
import { createSettingsKeymap, legacyOverridesArg, overridesArg, type SettingsKeymap } from './settings-keymap'
import { openSettings, runWithSettings } from './settings-open'
import { RECORDING_SETTINGS_ONLY, settingsWindowOnly } from './settings-window-channels'
import { SECRET_KEYS } from '../shared/settings-schema'
import { KEYMAP_SETTING } from '../shared/keymap-overrides'
import { bridleIdOfKeymapId, keymapIdOf } from '../shared/bridle-commands'
import {
  createSlidePreviewStore,
  markSlidePreviewHtml,
  slidePreviewIdFromUrl,
  slidePreviewUrl,
  selectedThumbnailSlide,
  thumbnailSlides
} from '../shared/slide-preview'
import { readFile as readFileAsync, readdir as readdirAsync, stat as statAsync, access as accessAsync } from 'fs/promises'
import {
  setupRecordingPermissions,
  installRecordingPermissions,
  registerAppWindowPermissions,
  registerRecordingIpc,
  registerRecordingContext,
  unregisterRecordingContext,
  shouldOfferRunSave,
  recordingAudioArmed,
  recordingOpen,
  onRecordingOpenChange,
  recordingRunReference,
  sendRecordingCloseOffer,
  recordingAudioPath,
  recoverInterruptedRecordings
} from './recording'
import { registerHistoryIpc } from './history'
import { listWorkFilesFor, listWorkFilesAcross, workFileWriteRoot } from './work-files'
import { addWorkFileStep, setWorkFileStepLocal, createWorkFile } from './work-file-write'
import { movePreworkToWorkFile } from './prework-move'
import {
  DEFAULT_TRANSCRIPTION_PYTHON,
  DEFAULT_TRANSCRIPTION_SCRIPT,
  registerTranscriptionIpc
} from './transcription'
import { createTranscriptionSetup, type TranscriptionSetup } from './transcription-setup'
import { shippedFfmpegCandidates, systemFfmpegCandidates } from './ffmpeg-path'
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
import { EDITOR_VIEW_MODE_KEY, editorViewModeFrom, type EditorViewMode } from '../shared/editor-view-mode'
import { PLAIN_FONT_KEY, PLAIN_TEXT_SIZE_KEY, plainFontFrom, plainTextSizeFrom, plainLookFrom, type PlainLook } from '../shared/plain-view-look'
import { placeChipVisibleFrom } from '../shared/place-chip-settings'
import { guideButtonVisibleFrom, guideProgressFrom } from '../shared/guide'
import { GuideLearnStore } from './guide-learn-store'
import { GUIDE_LINKS, isGuideLinkId, probeConnections } from './guide-connections'
import { NO_SOURCES, connectionRows, type ConnectionRow, type ConnectionSources } from '../shared/guide-connections'
import { GUIDE_LEARN_KEY, type GuideLearn } from '../shared/guide-learn'
import { presentGuideView, type PresentGuideView } from '../shared/guide-present'
import { chapterFor } from '../shared/guide-chapters'
import { SHORTCUT_REGISTRY } from '../shared/shortcut-registry'
import { PresenterGuideHost, SHOW_CHAPTER_LIST_CHANNEL, acceptCommandRan, registerPresenterGuideIpc } from './guide-present'
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
  injectRunCoverMetadata,
  listRuns,
  persistRun,
  readRun,
  readRunForTalk,
  runHandoutSlug,
  setRunHandoutUrl,
  stampRunWork,
  type RunRecord
} from './runs'
import { WORK_PAGE_FOLDER, type Phase } from '../shared/run-work'
import {
  SITE_FOLDER_REFUSED,
  siteFolder,
  resolveSiteDir,
  pagesBundlingHazard,
  resolveBase,
  publishUrl,
  readHandoutUrl,
  recoverIdFromUrl,
  generateShortId,
  pickShortId,
  buildRedirects,
  stampHandoutUrl
} from './publishing-logic'
import { endAllWranglerRuns, prepareWranglerRun, resolveWranglerLaunch, runWrangler, type WranglerInstall, type WranglerMissing, type WranglerRun } from './wrangler-launcher'
import { liveWorkerDeployConfig } from './live-worker-deploy-config'
import { blockingFileText, brokenJsonFileInOutput } from './wrangler-failures'
import { isTerminalLiveStatus, type LiveStatus } from './live-presenter-client'
import { createLiveSessionManager, livePresenterContext, type LivePresenterContext } from './live-session-manager'
import { presentedTalkVault, type PresentedVaultDeps } from './presented-vault'
import { createLiveSessionStore, type SessionRecoveryRecord } from './live-session-store'
import { secretsSlot, type SecretSlot, type SecretsStore } from './secrets-store'
import { openSecretsStore } from './secrets-store-electron'
import { installUpdateNotices } from './update-notices'
import { helpMenu, macAppMenu } from './app-menu'
import type { UpdateState } from '@app-patterns/updates'
import { cloudflareApiBase, createCloudflareConnection, standInApiBase, type CloudflareConnectionService, type ConnectionReply as CloudflareReply } from './cloudflare-connection'
import { LIVE_ACCESS_REMOVED, LIVE_NOT_SET_UP, LiveServiceError, deployLiveService, lookUpLiveService, surveyLiveService, type DeployPhase, type LiveDeployResult } from './live-service-deploy'
import { KeyStoreUnreadable, computerNameOrNull, createComputerKeyStore, defaultComputerName, keyKind, keyToPresent, sendWithHeldKeys, type ComputerKeyStore, type KeyKind, type StoredKey } from './live-service-key'
import { changeShareAddress, shareDomainEntries, shareLinkBase, type ShareDomainEntry, type ShareDomainPorts, type ShareDomainRecords, type ShareDomainResult } from './live-service-share-domain'
import type { AdminEndpoint } from './live-admin-request'
import { createLiveService, type LiveService } from './live-service'
import { LIVE_WORKER_NAME, type GoingLiveRow, type LiveSetupPrompt } from '../shared/live-service-status'
import { WORKER_DIST_DIR, readShippedFiles, type ShippedFiles } from './live-service-upload'
import { addressKind, createHandoutPublishing, liveAddressForPages, localLiveAllowed, publishedFolders, writableSiteFolder, type HandoutPublishing } from './handout-publishing'
import { slimHandoutHtml } from './handout-slimming'
import { buildRunHandoutHtml, placedRunExtras, runCompileOption, runForHandoutOf, runHandoutSourceFrom, withRunExtraIds, type HandoutPagesJob, type HandoutPagesResult, type RunExtrasModel, type RunCompileOption, type RunForHandout, type RunHandoutSource } from './handout-pages'
import { createPrepareTalkOffThread } from './prepare-talk-off-thread'
import { forkCompileChild, forkHandoutPagesChild, forkHtmlPageImportChild, forkLivePageCaptureChild } from './prepare-talk-utility-process'
import { createLivePageCaptureRunner, createLivePageCaptureSaver, encodeCapture, placeSavedView } from './live-page-capture'
import { CAPTURE_EMBED_TEXT, captureEmbedInitScript, captureEmbedPageUrl, checkCaptureEmbedRequest, readCaptureEmbedViews } from './live-page-capture-window'
import { slideSavedViews } from './live-page-saved-views'
import { createHandoutPagesOffProcess } from './handout-pages-off-process'
import { SHARE_LINK_NOT_NOW, type CloudflareStatus } from '../shared/cloudflare-status'
import { LEGACY_OUTLINE_ADAPTER } from '../shared/run-extra-slides'
import { createRecordingStorage, type RecordingStorage } from './recording-storage'
import type { RecordingStorageRow } from '../shared/recording-storage-status'
import { appOpenRefusal, runSetup, setupArguments, type ImporterRow } from './setup-cli'
import { runTalkWeaverSettings, settingsArguments } from './settings-cli'
import { folderInside, separateFolderProblem } from '../shared/settings-folders'
import { createSetupOperations, type PublishSettings, type RecordingSettings } from './setup-operations'
import { readSecretInput } from './setup-stdin'
import { discoverRenderer } from './importer/pptx'
import { PPT_EXTRACTOR_POINTER, PPT_EXTRACTOR_URL, rendererNotice } from '../shared/importer-renderer-notice'
import { createOwnerTokens, incompleteOwnerTokenRestores, migrateOwnerTokens, restorePlainOwnerTokens, RESTORE_PLAIN_OWNER_TOKENS_SWITCH, type OwnerTokens } from './owner-tokens'
import { closeLiveBoardsLeftOpen, flushLiveSessionHistory, recoverFinalLiveHistory } from './live-session-history'
import { registerRunBoardIpc } from './run-board-ipc'
import { registerSessionsListIpc } from './sessions-list'
import { openVaults, registerPublishedPagesIpc, siteClaims, type PublishedPagesDeps } from './published-pages'
import { TALK_NOT_FOUND, talkByOutline, talkLinkNotCleared, talkUnpublishJob } from './talk-unpublish'
import { registerRunPageIpc, runVaultRoot } from './run-page'
import { createRunResultsShares } from './run-results-share'
import { seedPollForRun, withoutSeed } from './run-prework-seed'
import { answerPreworkTrayForLiveSession, isPreworkQuestionId, preworkTrayForLiveSession } from './prework-tray'
import type { PollDefinition } from '../../worker/protocol'
import type { PreworkFeed } from '../../compiler/scripts/lib/prework.mjs'
import { createRunPrework, registerRunPreworkIpc, startRunPreworkTimer, type RunPreworkService } from './run-prework'
import { withoutPreworkSlides, type CompiledPrework } from '../shared/run-prework'
import { buildRunWorkPreview, planRunWork, runLineFor, sendRunWork, writeRunWorkPages, type SentWork } from './run-work-publish'
import { RUN_FOLDER_UNCLEAR, runPublishFolder, runSiteFolder, runUnpublishJob, sentPhases } from './run-unpublish'
import { createPostWorkOpener, startPostWorkOpenTimer, type PostWorkOpener } from './post-work-open'
import { buildNotAvailablePage } from './work-page'
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
import { createSharedTalks, readRevisionSnapshot, type SharedTalks } from './shared-talk'
import { createFeedbackMirror } from './feedback-mirror'
import { createSharedTalkFeedback, type SharedTalkFeedback } from './shared-talk-feedback'
import { parseAcceptRecord, type FeedbackStatus } from '../shared/feedback'
// What the rail may set: Done, Dismiss, Accept (with the splice it made, for Undo) and back to new
// (Undo). Every status reaches the Worker from here, never from the renderer.
const RAIL_STATUSES: readonly FeedbackStatus[] = ['done', 'dismissed', 'accepted', 'new']
import { buildInGate, buildSharedTalkPayload, ownerNameFrom } from './shared-talk-build'
import { isSharedTalkStopped, isValidShareDomain } from '../shared/shared-talk'
import { deckWindowKeyAction, deckWindowMode, OPEN_AUDIENCE_SCRIPT } from './deck-window-keys'
import { appWindowOpenHandler, guardDeckWindowTree, isAppAudienceUrl } from './present-window-open'
import { followRemotePages } from './remote-page-follow'
import { createLivePageHost, disposeAllLivePageHosts, isLivePageContents, pairLivePageHosts, type DeckWindow, type LivePageHost, type LivePageRole, type LivePageSession, type LiveView } from './live-page-host'
import { testLoopbackAllowance } from './live-page-policy'
import { isPresenterBoardMessage, parsePresenterMessage, parseSlideLightbox } from '../../worker/protocol'
import { handoutHomeDetails, handoutHomePostwork, handoutHomePrework } from '../shared/handout-home'
import { historyResultsRefusal, isOpenableToolsView, parseToolsRunRef, type ToolsRunRef, type ToolsView } from '../shared/tools-views'

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
  // Cloudflare Pages publishing (Settings → Cloudflare). NON-SECRET config only — the API token is
  // kept by the secrets store (secrets-store.ts, slot `cloudflare-token`), encrypted by the operating
  // system, NEVER in this file.
  cfAccountId?: string
  cfPagesProject?: string
  publishBaseUrl?: string // optional custom domain, e.g. https://handouts.example.com
  liveWorkerBaseUrl?: string // deployed Worker origin; empty means auto-deploy or local wrangler dev
  liveWorkerVersion?: string // LIVE_WORKER_VERSION last deployed to liveWorkerBaseUrl; mismatch → re-deploy
  liveWorkerAccountId?: string // the Cloudflare account liveWorkerBaseUrl was deployed for (unset on installs from before it was recorded)
  computerName?: string // the name this computer is listed under; default: the host name without .local. (The computer's id is NOT here: it is made with its key and kept with it in the secrets store.)
  liveComputerRecordedFor?: string // the Cloudflare account whose live service has this computer on its list, under the name recorded with it
  liveWorkerShareDomains?: { hostname: string; wanted: boolean }[] // every hostname THIS computer asked Cloudflare to attach to the live service and has not been shown detached; `wanted`: the share-link address in use (at most one); written only by live-service-share-domain.ts through applyShareAddress
  liveWorkerShareDomain?: string // before the list above: the one hostname recorded. Read once as its `wanted` entry, and removed by the list's first write
  liveWorkerShareDomainPrevious?: string // before the list above: the address whose removal had failed. Read once as an entry of the list, and removed by its first write
  // Share for comments: the host colleagues' links use (ticket 07 sets https://drafts.handouts.fyi once
  // the Worker has that route). Empty = the Worker origin serves shares at /shares/<id>.
  sharedTalkLinkBase?: string
  publishUseShortIds?: boolean // <base>/<id> links instead of <base>/<slug>/
  publishSiteDir?: string // advanced override; default {userData}/cloudflare-pages-site
  publishProdBranch?: string // advanced override; default 'main'
  // Presentation backup (a "present from anywhere" safety net): periodically write each Talk's
  // full self-contained presenter HTML to a folder the user puts inside OneDrive/Dropbox, so a
  // forgotten laptop never blocks presenting. TalkWeaver only writes files; the sync client syncs.
  // Background image-text reading for image search. On unless false (default flipped to on 2026-10-20;
  // the palette command "Index image text" runs whatever this says).
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
  // NEVER in this file — they are typed into Settings and kept by the secrets store (slot
  // `recording-keys`, recording-storage.ts). Two keys of an earlier source of them are read once
  // and dropped (recording-storage.ts, retireRecordingConfig); they are not part of this type.
  recordingDiscardMs?: number
  recordingR2Endpoint?: string
  recordingR2Bucket?: string
  // Transcription engine (Settings -> Transcription; optional, spec D16). Non-secret local paths:
  // the Python of an environment and the script (both set up from resources/agent-setup/transcription),
  // and an ffmpeg of the person's own (unset: the one that ships with the app). `~` is expanded at runtime.
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
  editorViewMode?: EditorViewMode
  // Plain tab font and text size (spec T13); read tolerantly through src/shared/plain-view-look.ts.
  plainViewFont?: string
  plainViewTextSize?: number
  actionBarItems?: string[]
  // The example vault was removed (onboarding ticket 12): Settings → Get started offers it again.
  // Beside the vault registry, outside every vault; progress is kept under its own keys.
  exampleVaultRemoved?: boolean
  // The editor keymap's overrides were moved from the renderer's localStorage into the settings store (0.42), once.
  keymapOverridesMoved?: boolean
  // The status-bar place chip, "Show where I am in the status bar" (onboarding ticket 02): ON
  // until switched off; read tolerantly (src/shared/place-chip-settings.ts).
  placeChipVisible?: boolean
  // Update notices (ADR-0041): the setting `updates.checkForNewVersions` (on until switched off) and the
  // check's state (last result, skipped version, last version run); both read in src/main/update-notices.ts.
  updatesCheckForNewVersions?: boolean
  updateNotices?: UpdateState
  // The Guide (onboarding ticket 07): "Show the Guide button in the sidebar" (ON until switched off)
  // and the Guide's progress. Both read tolerantly (src/shared/guide.ts); progress lives here,
  // beside the vault registry and outside every vault.
  guideButtonVisible?: boolean
  guideProgress?: { exampleTalkOpened?: boolean }
  // Chapter progress (onboarding ticket 08): ticks, chapter opens, read marks. Its own record with a
  // version; read tolerantly (src/shared/guide-learn.ts), beside the vault registry, outside every vault.
  guideLearn?: unknown
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
// Since 0.42 the preferences live in the settings store (settings-host.ts); readConfig / writeConfig
// go through its overlay once it is open, so every reader below is unchanged. The app opens it in
// startSharedSettings and the setup command in runSetupCommand (both through settings-open.ts, after
// the migration); nothing reads a preference before that.
let settingsOverlay: ConfigOverlay | null = null
function readConfig(): Config {
  return (settingsOverlay ? settingsOverlay.read() : configFile().read()) as Config
}
function writeConfig(patch: Partial<Config>) {
  if (settingsOverlay) settingsOverlay.write(patch as Record<string, unknown>)
  else configFile().write(patch)
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
/** The folders the compiler may read a talk's media from (ADR-0036; passed as `allowedAssetRoots` on
 *  EVERY prepareSource call): the registered vault holding the talk, else the talk's own folder.
 *  Unlike vaultRootFor there is no fallback to the current vault: a talk outside every vault is never
 *  given a vault to read from. Pooled `_assets` media sits at the vault root, so a compile that
 *  omitted this would lose its pooled pictures (the compiler's default is the talk's folder alone). */
function assetRootsFor(outlinePath: string, extra: string[] = []): string[] {
  return assetRootsForTalk(vaultRegistry, outlinePath, extra)
}
/** A talk's text with its pooled ids (`img-…`, `vid-…`) pointed at the pool of the talk's OWN vault:
 *  the registered vault that holds it, open or closed, current or not (the same vault assetRootsFor
 *  allows). A talk in no vault keeps its ids as written. Never the current vault's pool. */
function resolvePooledRefs(content: string, outlinePath: string): string {
  const root = talkVaultRoot(vaultRegistry, outlinePath)
  return root ? resolveImageRefs(content, root, outlinePath) : content
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
/** presented-vault.ts over the live registry: where a presenter window's writes go. */
const presentedVaultDeps: PresentedVaultDeps = {
  resolve: (absPath) => vaultRegistry.resolve(absPath),
  available: (vault) => vaultAvailable(vault as Vault),
  writable: (root) => writableRoot(root, rootFs) ?? undefined,
  openVaults: () => vaultRegistry.list().filter((v) => v.open).length,
  current: () => writableVaultRoot() ?? null,
}
/** The vault a Run publish or unpublish names (run-page.ts runVaultRoot): that open vault only, never another. */
function runVaultFor(vaultId: unknown): { root: string | undefined } | { error: string } {
  return runVaultRoot(availableVaults().map((v) => ({ id: v.id, root: v.root })), vaultId, writableVaultRoot, (root) => writableRoot(root, rootFs) ?? undefined)
}
/** A talk of one vault, by its slug. */
function talkInVault(vaultRoot: string, slug: string): TalkInfo | null {
  return findTalks(vaultRoot).find((talk) => talk.slug === slug) ?? null
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

// ── Secrets: every one sits in the secrets store (secrets-store.ts; spec decision D3) ─────────────
// The operating system's own encryption, one named slot per secret, nothing in config.json and
// nothing sent to a window but a "has it" boolean. Opened lazily: app.getPath needs a ready app.
let secretsStore: SecretsStore | null = null
function secrets(): SecretsStore {
  secretsStore ??= openSecretsStore(app.getPath('userData'))
  return secretsStore
}
/** A slot's text, or null when it holds nothing or cannot be read just now. Never throws. */
function secretOrNull(slot: SecretSlot): string | null {
  try { return secrets().read(slot) } catch { return null }
}
/** Owner tokens for shares, run-results links and pre-work (owner-tokens.ts), in the secrets store. */
let ownerTokenStore: OwnerTokens | null = null
function ownerTokens(): OwnerTokens {
  ownerTokenStore ??= createOwnerTokens(secrets())
  return ownerTokenStore
}

// ── The Settings window's own changes (Sol review 1, #2) ─────────────────────────────────────────
/** True when a call came from the Settings window's own page, in its top frame (the settings host's rule, given the whole event). */
function fromSettingsWindow(event: IpcMainInvokeEvent): boolean {
  return sharedSettings?.host.isSettingsWindowSender(event) === true
}
/** A change only the Settings window's pages make (settings-window-channels.ts SETTINGS_WINDOW_ONLY): any other sender gets `refused()`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handleFromSettingsWindow(channel: string, refused: () => unknown, handler: (event: IpcMainInvokeEvent, ...args: any[]) => unknown): void {
  ipcMain.handle(channel, settingsWindowOnly(fromSettingsWindow, refused, handler))
}

// ── Cloudflare: the one token (slot `cloudflare-token`) and the connection made with it ──────────
// The token is saved, replaced, checked and removed only through cloudflare-connection.ts (spec
// decisions D1, D4, D5, D6), and handed out only inside its authorisations (a publish, the live
// service's set-up or lookup). Nothing else is a source of a Cloudflare token: not Bitwarden, not
// the Keychain command, not an environment variable.
function tokenExists(): boolean {
  return secrets().has('cloudflare-token')
}
/** The environment override for tests, under its three conditions (cloudflare-connection.ts). */
function cloudflareTestContext(): { packaged: boolean; e2e: boolean; override: unknown } {
  return { packaged: app.isPackaged, e2e: E2E, override: process.env.TW_E2E_CLOUDFLARE_API_BASE_URL }
}
let cloudflareService: CloudflareConnectionService | null = null
function cloudflareConnection(): CloudflareConnectionService {
  cloudflareService ??= createCloudflareConnection({
    secrets: secrets(),
    settings: {
      read: () => ({
        accountId: getConfig('cfAccountId', undefined) ?? '',
        project: getConfig('cfPagesProject', undefined) ?? '',
        baseUrl: getConfig('publishBaseUrl', undefined) ?? '',
        shareDomain: shareDomainFromLinkBase(),
        productionBranch: getConfig('publishProdBranch', undefined) ?? 'main',
      }),
      write: (patch) => writeConfig({
        ...(patch.accountId ? { cfAccountId: patch.accountId } : {}),
        ...(patch.project ? { cfPagesProject: patch.project } : {}),
      }),
    },
    fetch: (input, init) => fetch(input, init),
    apiBase: () => cloudflareApiBase(cloudflareTestContext()),
    onChange: (status: CloudflareStatus) => {
      for (const win of BrowserWindow.getAllWindows()) {
        try { if (!win.isDestroyed()) win.webContents.send('cloudflare:status', status) } catch { /* window closing */ }
      }
      // The Going live and sharing row is worked out from the connection too (live-service.ts).
      liveServiceInstance?.refresh()
    },
  })
  return cloudflareService
}
// Settings → Cloudflare. Every reply is a status (states, an account's name and id, fixed
// sentences): never the token. None of these waits on a window or holds one up: they run in the
// main process's own queue while editing and presenting go on.
ipcMain.handle('cloudflare:status', () => cloudflareConnection().status())
ipcMain.handle('cloudflare:check', async (_event, reason: unknown) => {
  const why = reason === 'opened' ? 'opened' : 'asked'
  const reply = await cloudflareConnection().check(why)
  // Opening the screen, or Check again, also looks the live service up at Cloudflare (a Worker
  // deleted in the dashboard reads Not set up). It does not hold the reply up.
  void liveService().look(why).catch(() => {})
  return reply
})
// Saving, replacing and removing the token, and choosing the account, are the Settings window's own
// (settings-window-channels.ts): any other window or frame is refused. Save and Disconnect log the
// token's change in Changes as Accounts and keys does: connected or missing, never the value.
const cloudflareSettingsOnly = (): CloudflareReply => ({ ok: false, error: 'This can be changed only in the Settings window.', status: cloudflareConnection().status() })
function recordedCloudflareKeyChange(run: () => Promise<CloudflareReply> | CloudflareReply): Promise<CloudflareReply> {
  return recordedKeyChange({
    has: () => tokenExists(),
    run,
    record: async (from, to) => (sharedSettings ? sharedSettings.store.recordSecret(SECRET_KEYS.cloudflare, from, to) : { ok: false }),
    changed: () => sharedSettings?.host.slotsChanged(),
    log: (line) => console.warn(line)
  })
}
handleFromSettingsWindow('cloudflare:save-token', cloudflareSettingsOnly, (_event, token: unknown) => recordedCloudflareKeyChange(() => cloudflareConnection().saveToken(token)))
handleFromSettingsWindow('cloudflare:choose-account', cloudflareSettingsOnly, (_event, id: unknown) => cloudflareConnection().chooseAccount(id))
// Making the site saves the account and site the publishing goes to: Settings configuration, so the
// Settings window's only (Sol review 4). A publish sheet in an editor window opens Settings → Cloudflare.
handleFromSettingsWindow('cloudflare:create-site', cloudflareSettingsOnly, () => cloudflareConnection().createSite())
handleFromSettingsWindow('cloudflare:disconnect', cloudflareSettingsOnly, () => recordedCloudflareKeyChange(() => cloudflareConnection().disconnect()))
// "Open Settings" on a publish sheet or notice, from whichever window showed it: the editor window
// comes forward with Settings → Cloudflare. Carries nothing.
// "Open Settings" from a publish sheet or notice: the Settings window at its Cloudflare page (0.42).
ipcMain.handle('cloudflare:open-settings', () => openSettingsWindow('cloudflare'))

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

/** What Settings → Cloudflare's fields hold: what the window and `setup` both read. */
function publishSettings(): PublishSettings {
  return {
    accountId: getConfig('cfAccountId', undefined) ?? '',
    project: getConfig('cfPagesProject', undefined) ?? '',
    baseUrl: getConfig('publishBaseUrl', undefined) ?? '',
    workerBaseUrl: getConfig('liveWorkerBaseUrl', undefined) ?? '',
    useShortIds: getConfig('publishUseShortIds', false) ?? false,
    shareDomain: shareDomainFromLinkBase(),
  }
}

handleFromSettingsWindow(
  'publish:set-config',
  () => ({ success: false, error: 'This can be changed only in the Settings window.' }),
  (_event, cfg: { accountId?: string; project?: string; baseUrl?: string; workerBaseUrl?: string; useShortIds?: boolean; shareDomain?: string }):
    { success: true } | { success: false; error: string } => {
    const saved = applyPublishSettings(cfg)
    return saved.success ? { success: true } : saved
  }
)

/**
 * Settings → Cloudflare's Save: the one writer of these fields, for the window and for `setup`
 * (ticket 07). `checked`: the check the connection starts when the account, site, custom domain or
 * share-link address changed (a caller may wait for it; the window does not).
 */
function applyPublishSettings(cfg: { accountId?: string; project?: string; baseUrl?: string; workerBaseUrl?: string; useShortIds?: boolean; shareDomain?: string }):
  { success: true; checked?: Promise<unknown> } | { success: false; error: string } {
    const hostnameInput = (cfg.shareDomain || '').trim().toLowerCase()
    if (hostnameInput && !isValidShareDomain(hostnameInput)) {
      return {
        success: false,
        error: 'Share link domain must be a bare hostname, like drafts.example.com — no https://, port, path, space, wildcard, IP address or localhost.'
      }
    }
    const nextLinkBase = hostnameInput ? `https://${hostnameInput}` : undefined
    const previousLinkBase = getConfig('sharedTalkLinkBase', undefined)
    const previousWorkerBaseUrl = getConfig('liveWorkerBaseUrl', undefined)
    const connectionBefore = [getConfig('cfAccountId', undefined), getConfig('cfPagesProject', undefined), getConfig('publishBaseUrl', undefined), getConfig('sharedTalkLinkBase', undefined)].join('\n')
    writeConfig({
      cfAccountId: (cfg.accountId || '').trim() || undefined,
      cfPagesProject: (cfg.project || '').trim() || undefined,
      publishBaseUrl: (cfg.baseUrl || '').trim() || undefined,
      liveWorkerBaseUrl: (cfg.workerBaseUrl || '').trim().replace(/\/+$/, '') || undefined,
      publishUseShortIds: !!cfg.useShortIds,
      sharedTalkLinkBase: nextLinkBase,
      // A Live Worker URL typed by hand is not known to be any account's deploy.
      ...(((cfg.workerBaseUrl || '').trim().replace(/\/+$/, '') || undefined) !== previousWorkerBaseUrl ? { liveWorkerAccountId: undefined } : {})
    })
    // The Live Worker URL or the share-link address may have changed what the Going live row says.
    liveServiceInstance?.refresh()
    // The account, the site, the custom domain or the share-link address was edited by hand: the Cloudflare rows are asked for again.
    const connectionAfter = [getConfig('cfAccountId', undefined), getConfig('cfPagesProject', undefined), getConfig('publishBaseUrl', undefined), getConfig('sharedTalkLinkBase', undefined)].join('\n')
    // An event of the connection, not a refresh of it: what was being checked or offered for the earlier
    // values is cancelled (a site is never made in an account Settings no longer names).
    // The share-link address is attached or removed HERE, by this Save, and nowhere else (decision R2:
    // a set-up or a code update of the live service never touches a domain). Then the rows are asked again.
    const shareAddress = nextLinkBase !== previousLinkBase || shareAddressDue() ? applyShareAddress() : null
    if (connectionAfter !== connectionBefore || shareAddress) {
      return { success: true, checked: (shareAddress ?? Promise.resolve()).then(() => cloudflareConnection().settingsChanged()) }
    }
    return { success: true }
}

function attachLiveWindow(wcId: number) {
  const context = livePresenterContexts.get(wcId)
  // The vault of the talk this presenter window shows (issue 256), never the current vault.
  if (context) liveSessions?.attach(wcId, context.talkSlug, context.vaultRoot)
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
    if (liveSessions.inUse(context.talkSlug, context.vaultRoot, wcId)) throw new Error('This talk is already live in another presenter window. Close that presentation and keep it live before reopening it here.')
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
    // With two keys held for this live service (this computer's own and the 0.38.2 one), a 401 for the
    // one presented is followed by one more try with the other (live-service-key.ts `sendWithHeldKeys`).
    const { response, refused } = await sendWithHeldKeys(recordedLiveService(), liveKeysHeldFor(endpoint.baseUrl), endpoint.adminSecret, (secret) => fetch(`${endpoint.baseUrl}/sessions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ talkSlug: context.talkSlug }),
      signal: AbortSignal.timeout(15_000),
    }))
    // The live service refuses every key this computer holds for it (its access was removed from another
    // computer): the same fixed sentence as the Settings row's, with Open Settings, never the reply's own text.
    if (refused) throw new LiveServiceError('failed', LIVE_ACCESS_REMOVED, null, 'open-settings')
    if (!response.ok) throw new Error(await liveHttpError(response, 'Could not create a live session.'))
    const created = await response.json() as { sessionId: string; presenterToken: string; shortId: string; expiresAt: number }
    if (!created.sessionId || !created.presenterToken || !created.shortId || !Number.isFinite(created.expiresAt)) throw new Error('The live service returned an incomplete session.')
    const record: SessionRecoveryRecord = {
      ...created, baseUrl: endpoint.baseUrl, shortUrl: joinUrl, qrSvg,
      talkSlug: context.talkSlug, vaultRoot: context.vaultRoot,
      status: 'connecting', startedAtMs: Date.now(), endRequested: false,
      latest: null, pending: [], polls: [], voteRecords: [], cursor: 0,
    }
    liveSessions.detach(wcId)
    liveSessions.create(record, wcId)
    liveSessions.bindRun(wcId, recordingRunReference(wcId))
    return { success: true, ...liveSessions.snapshot(wcId) }
  } catch (cause) {
    // A live service that is not set up or failed its set-up: the sorted sentence; what the tool printed only as `details`;
    // and what Go live offers for it (Open Settings, or Set up going live now). Presenting goes on either way.
    if (cause instanceof LiveServiceError) return { success: false, error: cause.message, ...(cause.details ? { details: cause.details } : {}), ...(cause.prompt ? { setup: cause.prompt } : {}) }
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
  // Read from the session's own vault (record.vaultRoot) only while it is open and there; never the current vault.
  return snapshot ? { ...snapshot, preworkQuestions: preworkTrayForLiveSession(record, liveVaultReadable) } : null
})
ipcMain.handle('live:status', (event): LiveStatus => attachLiveWindow(event.sender.id)?.status ?? 'ended')
ipcMain.on('live:pointer', (event, value: unknown) => {
  const message = parsePointerMessage(value)
  if (message) liveSessions?.pointer(event.sender.id, message)
})
// The Pen's ink (ticket 08): relayed to the worker, held nowhere in main.
ipcMain.on('live:ink', (event, value: unknown) => {
  const message = parseInkMessage(value)
  if (message && new TextEncoder().encode(JSON.stringify(message)).length <= INK_LIMITS.bytes) liveSessions?.ink(event.sender.id, message)
})
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
/** The board slides fed by a step (`model.resultsFeeds`, which also holds the work-file ones), or null when there is no model. */
function feedsOfModel(model: unknown): PreworkFeed[] | null {
  const m = model as { resultsFeeds?: PreworkFeed[]; prework?: { feeds?: PreworkFeed[] } } | null | undefined
  return m ? (m.resultsFeeds ?? m.prework?.feeds ?? []) : null
}
/** A live session's own vault may be read: it is open and its folder answered the last check. */
function liveVaultReadable(root: string): boolean {
  return availableVaults().some((vault) => vault.root === root)
}
function seedFromRunPrework(wcId: number, poll: PollDefinition): Promise<PollDefinition> {
  const outlinePath = presentWindows.get(wcId)?.outlinePath ?? null
  return seedPollForRun(poll, liveSessions?.record(wcId) ?? null, {
    // The session's own vault (record.vaultRoot), read only while it is open and its folder is there;
    // never the current primary vault, which may be another vault with the same talk slug and Run id.
    vaultReadable: liveVaultReadable,
    readOutline: () => (outlinePath ? readFileSync(outlinePath, 'utf8') : null),
    feeds: async (outline) => (outlinePath ? feedsOfModel((await prepareTalk(outlinePath, outline))?.model) : null),
    onFinding: (finding) => console.warn('[board-seed]', finding.code, finding.slideId, finding.detail),
    // The Run page's own pull (same queue and cursor), into the session's vault; offline, the board opens with what is on disk.
    pull: (talkSlug, runId, phase, vaultRoot) => runPrework().pull(talkSlug, runId, phase, vaultRoot),
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
      // Written to the session's own vault only (open, there and writable), never the current primary vault.
      const result = answerPreworkTrayForLiveSession(liveSessions?.record(event.sender.id) ?? null, liveVaultReadable,
        (root) => writableRoot(root, rootFs) ?? null, questionId, answered !== false)
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
async function instantLinkQrSvg(url: string): Promise<string> {
  const compilerDir = getCompilerPath()
  if (!compilerDir) throw new Error('Compiler not found.')
  const { makeQrSvg } = await import(pathToFileURL(join(compilerDir, 'lib/01-cli-utils.mjs')).href)
  return String(makeQrSvg(url) || '') // '' when the link is longer than a QR code can hold: the slide then shows the link without one
}
ipcMain.handle('live:instant-qr', async (event, url: unknown) => {
  if (!livePresenterContexts.has(event.sender.id) || typeof url !== 'string' || !/^https?:\/\/[^\s]+$/i.test(url) || url.length > 2048) return { success: false }
  try { const svg = await instantLinkQrSvg(url); return { success: Boolean(svg), svg } } catch { return { success: false } }
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
    // A text or countdown slide may carry a web link; its QR code is made here, from the link, never taken from the window.
    if ((slide.kind === 'text' || slide.kind === 'countdown') && typeof slide.link === 'string') {
      try {
        if (!['http:', 'https:'].includes(new URL(slide.link).protocol)) throw new Error('Only web links can be shown.')
        const svg = await instantLinkQrSvg(slide.link)
        if (svg) slide.linkQrSvg = svg; else delete slide.linkQrSvg
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
// The Live menu's "Instant slide from clipboard": the clipboard is read here, never in the preload,
// and only for a focused presenter window that had a real press in the last five seconds
// (live-read-clipboard.ts). ⌘V is another path: the page's own paste event.
ipcMain.handle('live:read-clipboard', liveReadClipboardHandler({
  isPresenter: (wcId) => livePresenterContexts.has(wcId),
  isFocused: (sender) => {
    const win = BrowserWindow.fromWebContents(sender as Electron.WebContents)
    return !!win && !win.isDestroyed() && win.isFocused()
  },
  pressedRecently: (wcId) => pressLedger.pressedRecently(wcId),
  clipboard,
}))

// ── Recording storage (Settings → Recording) — R2 destination + access keys ──
// Mirrors the publishing-config pattern: non-secret config in config.json; the R2 access keys go
// to the secrets store (slot `recording-keys`) through recording-storage.ts, the only module that
// reads or writes them. They are NEVER returned to a window: it learns a hasKeys boolean and the
// row's state (RecordingStorageRow: states, the bucket's name, fixed sentences).
let recordingStorageService: RecordingStorage | null = null
function recordingStorage(): RecordingStorage {
  recordingStorageService ??= createRecordingStorage({
    secrets: secrets(),
    settings: () => ({ endpoint: getConfig('recordingR2Endpoint', undefined) ?? '', bucket: getConfig('recordingR2Bucket', undefined) ?? '' }),
    // The two config keys of the source that is gone: read once, then removed from config.json.
    retired: {
      read: () => readConfig() as Record<string, unknown>,
      drop: (keys) => {
        // config.json itself, not the overlay's view: the store's preferences are never written into it.
        const kept = { ...(configFile().read() as Record<string, unknown>) }
        for (const key of keys) delete kept[key]
        configFile().replace(kept as Config)
      },
    },
    onChange: (row: RecordingStorageRow) => {
      for (const win of BrowserWindow.getAllWindows()) {
        try { if (!win.isDestroyed()) win.webContents.send('recording:storage-status', row) } catch { /* window closing */ }
      }
    },
  })
  return recordingStorageService
}

ipcMain.handle('recording:get-storage', () => ({
  endpoint: getConfig('recordingR2Endpoint', undefined) ?? '',
  bucket: getConfig('recordingR2Bucket', undefined) ?? '',
  discardSeconds: Math.round((getConfig('recordingDiscardMs', 20000) ?? 20000) / 1000),
  hasKeys: recordingStorage().hasKeys()
}))

handleFromSettingsWindow(
  'recording:set-storage',
  () => RECORDING_SETTINGS_ONLY,
  (
    _event: IpcMainInvokeEvent,
    cfg: {
      endpoint?: string
      bucket?: string
      discardSeconds?: number
    }
  ) => {
    applyRecordingSettings(cfg)
    return { success: true }
  }
)

/** Recording storage's fields: what the window and `setup recording` both read. */
function recordingSettings(): RecordingSettings {
  return {
    endpoint: getConfig('recordingR2Endpoint', undefined) ?? '',
    bucket: getConfig('recordingR2Bucket', undefined) ?? '',
    discardSeconds: Math.round((getConfig('recordingDiscardMs', 20000) ?? 20000) / 1000),
  }
}
/** Recording storage's Save: the one writer of these fields, for the window and for `setup recording` (ticket 07). */
function applyRecordingSettings(cfg: { endpoint?: string; bucket?: string; discardSeconds?: number }): void {
  writeConfig({
    recordingR2Endpoint: (cfg.endpoint || '').trim() || undefined,
    recordingR2Bucket: (cfg.bucket || '').trim() || undefined,
    recordingDiscardMs: Number.isFinite(cfg.discardSeconds)
      ? Math.max(0, Math.round((cfg.discardSeconds as number) * 1000))
      : undefined
  })
  // What a check found was about the endpoint and bucket as they were.
  recordingStorage().settingsChanged()
}

// The recording keys are a secret: only the Settings window may save or remove them (Accounts and
// keys goes through settings-secret-slots.ts; these calls are that window's too).
handleFromSettingsWindow('recording:set-keys', () => RECORDING_SETTINGS_ONLY, (_event, keys: unknown) => recordingStorage().saveKeys(keys))
handleFromSettingsWindow('recording:clear-keys', () => RECORDING_SETTINGS_ONLY, () => recordingStorage().clearKeys())
// The Recording storage row of Settings → Cloudflare, and its Check (one list of the bucket; a read).
ipcMain.handle('recording:storage-status', () => recordingStorage().status())
ipcMain.handle('recording:check-storage', () => recordingStorage().check())
// "Recording storage: enter your access keys", once, for a set-up that took its keys from Bitwarden.
ipcMain.handle('recording:take-setup-notice', () => recordingStorage().takeNotice())

// ── Transcription engine (Settings → Transcription) ─────────────────────────
// Non-secret local paths only. Optional (spec D16): whether it can run is the one row decided in
// transcription-setup.ts, which Settings shows and Studio's Transcribe obeys. The same operations
// are what the `setup transcription` command will call (ticket 07: setPaths and status).
function transcriptionSettings(): { python: string; script: string; ffmpeg: string; defaultPython: string; defaultScript: string } {
  return {
    python: getConfig('transcriptionPython', undefined) ?? DEFAULT_TRANSCRIPTION_PYTHON,
    script: getConfig('transcriptionScript', undefined) ?? DEFAULT_TRANSCRIPTION_SCRIPT,
    ffmpeg: getConfig('transcriptionFfmpeg', undefined) ?? '',
    defaultPython: DEFAULT_TRANSCRIPTION_PYTHON,
    defaultScript: DEFAULT_TRANSCRIPTION_SCRIPT
  }
}

let transcriptionSetupInstance: TranscriptionSetup | null = null
function transcriptionSetup(): TranscriptionSetup {
  if (transcriptionSetupInstance) return transcriptionSetupInstance
  transcriptionSetupInstance = createTranscriptionSetup({
    read: () => {
      const cfg = transcriptionSettings()
      return { python: expandHomePath(cfg.python.trim()), script: expandHomePath(cfg.script.trim()), ffmpeg: expandHomePath(cfg.ffmpeg.trim()) }
    },
    write: (paths) => writeConfig({
      transcriptionPython: paths.python.trim() || undefined,
      transcriptionScript: paths.script.trim() || undefined,
      transcriptionFfmpeg: paths.ffmpeg.trim() || undefined
    }),
    shippedFfmpeg: () => shippedFfmpegCandidates({ platform: process.platform, resourcesPath: process.resourcesPath ?? null, appPath: app.getAppPath(), packaged: app.isPackaged }),
    systemFfmpeg: () => systemFfmpegCandidates(process.platform),
    setupFolder: () => app.isPackaged
      ? join(process.resourcesPath, 'agent-setup', 'transcription')
      : join(app.getAppPath(), 'resources', 'agent-setup', 'transcription'),
    userData: () => app.getPath('userData')
  })
  return transcriptionSetupInstance
}

ipcMain.handle('preferences:get-transcription', () => transcriptionSettings())

// These paths name programs main runs (Python, the script, ffmpeg): only the Settings window may
// change them; any other sender gets the paths as they are, unchanged.
handleFromSettingsWindow('preferences:set-transcription', () => transcriptionSettings(), async (_event, cfg: { python?: string; script?: string; ffmpeg?: string }) => {
  // Settings sends all three; an empty field clears its setting. Stored as typed (`~` kept).
  writeConfig({
    transcriptionPython: (cfg.python || '').trim() || undefined,
    transcriptionScript: (cfg.script || '').trim() || undefined,
    transcriptionFfmpeg: (cfg.ffmpeg || '').trim() || undefined
  })
  return transcriptionSettings()
})

// The Transcription row (spec D16), the agent prompt it copies, and the set-up folder it opens.
ipcMain.handle('transcription:status', () => transcriptionSetup().status())
ipcMain.handle('transcription:agent-prompt', () => transcriptionSetup().agentPrompt())
ipcMain.handle('transcription:open-setup-folder', async () => (await shell.openPath(transcriptionSetup().setupFolder())) === '')

// window.open / target="_blank" in any app window: web and mail links go to the OS (logged instead
// under E2E), nothing else opens in-app except a deck's own pages (present-window-open.ts).
const appWindowOpenOpts = { openExternal: (url: string) => E2E ? console.log('[window-open] external (E2E):', url) : shell.openExternal(url) }
// A deck window hands a link to the OS only after a real press in that window (present-window-open.ts).
const deckWindowOpenOpts = { ...appWindowOpenOpts, pressedRecently: (contents: { id: number }) => pressLedger.pressedRecently(contents.id), ...(E2E ? { allowOptions: { overrideBrowserWindowOptions: { show: false, webPreferences: { backgroundThrottling: false } } } } : {}) }

// The end-of-break chime plays only in the audience (projector) window, and a browser starts audio
// only after a user gesture. Both ways that window comes to exist (the presenter's window.open and
// "Present to audience") end in a page load, so every audience page is unlocked here with a
// user-gesture script. That covers the chime's audio context alone: no autoplay policy is relaxed,
// so videos and iframes in a deck window still need a click.
app.on('web-contents-created', (_event, contents) => {
  contents.on('did-finish-load', () => {
    try {
      // Only the top-level page of an app-created window (not a webview, not an iframe: did-finish-load is the main frame) at the app's own file: deck URL.
      if (contents.getType() !== 'window' || contents.hostWebContents || !isAppAudienceUrl(contents.getURL())) return
      contents.executeJavaScript('window.__twUnlockChime && window.__twUnlockChime()', true).catch(() => {})
    } catch { /* not a page with a URL */ }
  })
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

  win.webContents.setWindowOpenHandler(appWindowOpenHandler(appWindowOpenOpts, () => pressLedger.pressedRecently(win.webContents.id)))
  registerAppWindowPermissions(win) // this window's own page may read the clipboard (recording-permissions.ts)
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
/** Restore, show and focus a window (E2E windows stay hidden). */
function bringToFront(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore()
  if (!E2E) win.show()
  win.focus()
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

// Only when the settings store could not open (startSharedSettings): the menu bar of 0.41, so the app
// stays usable. Normally the shared settings host generates the menu bar from the command registry.
function installFallbackMenu(): void {
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
    // The macOS TalkWeaver menu carries Check for Updates… under About; Help is the registry's Help items (app-menu.ts).
    ...(process.platform === 'darwin' ? [macAppMenu(app.name, customMenus.get('Help') ?? [])] : []),
    // File menu: the OS-standard role PLUS a discoverable "New Window" (⌘N). New Window is driven
    // from MAIN so it opens a window regardless of which surface has focus, and is prepended so it
    // reads first. Working on two presentations at once (2026-07-19).
    {
      label: 'File',
      submenu: [
        { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: () => { createWindow(); guideLearn.commandRan('new-window', { inExample: false }) } },
        { type: 'separator' },
        { role: 'close' }
      ]
    },
    { role: 'editMenu' },
    ...[...customMenus].filter(([label]) => label !== 'View' && label !== 'Help').map(([label, submenu]) => ({ label, submenu })),
    { label: 'View', submenu: [...(customMenus.get('View') ?? []), { type: 'separator' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
    helpMenu(customMenus.get('Help') ?? [], process.platform)
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// Live deck windows opened by talk:present, so ⌘R (refresh-in-place) can recompile the right talk
// and reload the deck at its current slide. wcId → { outlinePath, mode }.
const presentWindows = new Map<number, { outlinePath: string; mode: string; pathwayId?: string; runId?: string }>()
const livePresenterContexts = new Map<number, LivePresenterContext>()
let liveSessions: ReturnType<typeof createLiveSessionManager> | null = null
/** The update check, once installed: told whenever a talk opens or closes. */
let updateChecker: ReturnType<typeof installUpdateNotices> | null = null
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
    liveRecoveryStore = createLiveSessionStore(secretsSlot(secrets(), 'live-sessions'))
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
      onEnded: ({ talkSlug, runId, vaultRoot }) => openPostWorkFor(talkSlug, runId, vaultRoot),
      onActivity: () => updateChecker?.busyChanged(),
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

type PathwayWindowContext = { outlinePath: string; talkSlug: string; talkTitle: string }
let toolsWindow: BrowserWindow | null = null
let talkTextIpcController: ReturnType<typeof registerTalkTextIpc> | null = null
let pathwayWindow: BrowserWindow | null = null
let pathwayWindowContext: PathwayWindowContext | null = null

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

function sendToolsShow(win: BrowserWindow, view: ToolsView, sessionId?: string, pathway?: PathwayWindowContext, run?: ToolsRunRef): void {
  const payload = { view, sessionId: sessionId || undefined, pathway, run }
  const send = (): void => {
    if (!win.isDestroyed()) win.webContents.send('tools:show', payload)
  }
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send)
  else send()
}

function createToolsWindow(view: ToolsView, sessionId?: string, run?: ToolsRunRef): BrowserWindow {
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
  win.webContents.setWindowOpenHandler(appWindowOpenHandler(appWindowOpenOpts, () => pressLedger.pressedRecently(win.webContents.id)))
  registerAppWindowPermissions(win) // this window's own page may read the clipboard (recording-permissions.ts)
  loadRenderer(win, view)
  sendToolsShow(win, view, sessionId, undefined, run)
  return win
}

function openToolsWindow(view: ToolsView, sessionId?: string, run?: ToolsRunRef): void {
  const existing = toolsWindow && !toolsWindow.isDestroyed() ? toolsWindow : null
  const win = existing ?? createToolsWindow(view, sessionId, run)
  if (win.isMinimized()) win.restore()
  win.focus()
  if (existing) sendToolsShow(win, view, sessionId, undefined, run)
}

// The one way into the Tools window: a view, and for Sessions optionally a Run by its talk and Run id.
ipcMain.handle('tools:open', (_event, view: unknown, sessionId?: unknown, run?: unknown) => {
  if (!isOpenableToolsView(view)) return { success: false, error: 'Unknown Tools view.' }
  if (view === 'sessions' && run && typeof run === 'object' && (run as { home?: unknown }).home === null) {
    return { success: false, error: 'This action requires a Run in an open vault.' }
  }
  const runRef = run === undefined || run === null ? undefined : parseToolsRunRef(run)
  if (runRef === null) return { success: false, error: 'Unknown Run.' }
  // A reference without a vault comes from History, which lists the primary vault's Runs (writableVaultRoot):
  // it names that vault, so Sessions never selects another open vault's Run with the same talk and Run id.
  const historyVaultId = vaultRegistry.primary()?.id
  // Open results (Sessions) names the Run's vault and History reads that vault's Runs, so any open vault's Run opens;
  // a vault that is not open is refused (issue 256).
  if (view === 'history' && typeof sessionId === 'string' && sessionId.startsWith('results:')) {
    const refused = historyResultsRefusal(runRef, (id) => rootOfVault(id) !== undefined)
    if (refused) return { success: false, error: refused }
  }
  const named = runRef && !runRef.vaultId && historyVaultId ? { ...runRef, vaultId: historyVaultId } : runRef
  openToolsWindow(view, typeof sessionId === 'string' ? sessionId : undefined, named)
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
    win.webContents.setWindowOpenHandler(appWindowOpenHandler(appWindowOpenOpts, () => pressLedger.pressedRecently(win.webContents.id)))
    registerAppWindowPermissions(win) // this window's own page may read the clipboard (recording-permissions.ts)
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

// Insert › HTML page… (src/main/html-page-import.ts). Under TW_E2E the OS picker is never shown: a
// test sets globalThis.__twE2eHtmlPagePick to the file to answer with (null = Cancel) and reads the
// options the picker was opened with from __twE2eHtmlPagePickOptions.
type E2eHtmlPick = { __twE2eHtmlPagePick?: string | null; __twE2eHtmlPagePickOptions?: Electron.OpenDialogOptions }
// Object cards' file status (object-status.ts): only for the talk the asking editor window has open,
// contained in the folders the compiler reads that talk's media from; never a read, listing or fetch.
registerObjectStatusIpc({
  ipcMain,
  currentTalkOf: (senderId) => editorWindows.get(senderId)?.outlinePath ?? null,
  contextFor: (outlinePath) => ({
    talkDir: dirname(outlinePath),
    roots: assetRootsFor(outlinePath),
    vaultRoot: talkVaultRoot(vaultRegistry, outlinePath) ?? undefined
  })
})
// The copy runs in its own process, started in the talk folder (html-page-import-worker.ts). The Slide Scratchpad's
// Insert visual only uses the same copy for an agent's page or SVG (scratchpad-visual-import.ts).
const htmlPageRunImport = createHtmlPageImportRunner(join(__dirname, 'html-page-import-worker.js'), forkHtmlPageImportChild)
registerHtmlPageImportIpc({
  ipcMain,
  dialog: E2E
    ? {
        showOpenDialog: async (...args: unknown[]) => {
          const g = globalThis as typeof globalThis & E2eHtmlPick
          g.__twE2eHtmlPagePickOptions = args[args.length - 1] as Electron.OpenDialogOptions
          const pick = g.__twE2eHtmlPagePick
          return pick ? { canceled: false, filePaths: [pick] } : { canceled: true, filePaths: [] }
        }
      } as unknown as Pick<Electron.Dialog, 'showOpenDialog'>
    : dialog,
  windowOf: (sender) => BrowserWindow.fromWebContents(sender),
  writableTalkRoot: (outlinePath) => writableTalkRoot(outlinePath),
  runImport: htmlPageRunImport
})

// Open example vault (onboarding ticket 06): five talks written from the bundle to
// ~/Documents/TalkWeaver/Example vault on a click, then added to the list flagged as the example.
// No argument: the path is fixed in example-vault.ts. A run with TW_E2E never sees the real home.
const exampleHome = (): string | null => resolveExampleHome({ isPackaged: app.isPackaged, env: process.env, systemHome: homedir, realpath: (p) => realpathSync(p), systemTemp: tmpdir })
const exampleVault = new ExampleVault({
  home: exampleHome,
  bundleDir: app.isPackaged ? join(process.resourcesPath, 'example-vault') : join(app.getAppPath(), 'resources', 'example-vault'),
  registry: vaultRegistry,
  log: (event, details) => console.log(`[${event}]`, JSON.stringify(details))
})
async function afterExampleVaultChange(): Promise<void> {
  searchCache.clear()
  invalidateTalkCache()
  scheduleVaultWarm()
  await checkVaultAvailability(true).catch(() => false)
  for (const win of BrowserWindow.getAllWindows()) {
    try { if (!win.isDestroyed()) win.webContents.send('vault:vaults-changed') } catch { /* window closing */ }
  }
}
ipcMain.handle('vault:open-example', async () => {
  const result = await exampleVault.open()
  if (result.ok) await afterExampleVaultChange()
  return result
})

// ── Remove the example vault and bring it back (onboarding ticket 12) ──
// The rules are in example-vault-removal.ts. The renderer never passes a path: preview takes nothing,
// remove takes the confirmation's token, restore takes nothing; the sender is main's own number for
// the asking window, and only an app window may ask.
const exampleRemoval = new ExampleVaultRemoval({
  home: exampleHome,
  registry: vaultRegistry,
  record: {
    removed: () => readConfig().exampleVaultRemoved === true,
    setRemoved: (removed) => { try { writeConfig({ exampleVaultRemoved: removed }); return true } catch { return false } }
  },
  writer: exampleVault,
  trash: resolveExampleTrash({ isPackaged: app.isPackaged, env: process.env, systemTrash: (path) => shell.trashItem(path) }),
  openWindows: windowsShowingExample,
  log: (event, details) => console.log(`[${event}]`, JSON.stringify(details))
})
// Rule I's port: the names of every window that shows, or might show, an example talk, from main's
// own bookkeeping (editorWindows, presentWindows, the Pathways window's context). The Tools window
// and any window opened from a deck window (Presenter from a presentation, Audience, a board) are not
// tied to a talk here and are judged by windowsOnExample's conservative rule. Removal closes nothing.
function windowsShowingExample(root: string): string[] {
  const inExample = (path: string): boolean => {
    if (vaultRegistry.resolve(path)?.vault.example === true) return true
    const p = resolvePath(path)
    return p === root || p.startsWith(root + pathSep)
  }
  const talkTitle = (outlinePath: string | null): string => {
    if (!outlinePath) return ''
    try { return outlineFrontmatter(outlinePath, statSync(outlinePath).mtimeMs).title ?? basename(outlinePath).replace(/-outline\.md$/, '') } catch { return basename(outlinePath).replace(/-outline\.md$/, '') }
  }
  const windows: OpenAppWindow[] = []
  const placed = new Set<number>()
  for (const { win, outlinePath } of editorWindows.values()) {
    if (win.isDestroyed()) continue
    placed.add(win.webContents.id)
    windows.push({ kind: 'editor', outlinePath, title: talkTitle(outlinePath) })
  }
  const pathways = pathwayWindow
  if (pathways && !pathways.isDestroyed()) {
    placed.add(pathways.webContents.id)
    windows.push({ kind: 'pathways', outlinePath: pathwayWindowContext?.outlinePath ?? null, title: pathwayWindowContext?.talkTitle ?? talkTitle(pathwayWindowContext?.outlinePath ?? null) })
  }
  const tools = toolsWindow
  if (tools && !tools.isDestroyed()) {
    placed.add(tools.webContents.id)
    windows.push({ kind: 'tools', title: 'TalkWeaver Tools' })
  }
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    const id = win.webContents.id
    if (placed.has(id) || isHiddenRenderer(id)) continue
    const deck = presentWindows.get(id)
    if (deck) windows.push({ kind: 'deck', outlinePath: deck.outlinePath, title: talkTitle(deck.outlinePath) })
    else windows.push({ kind: 'other', url: win.webContents.getURL(), title: win.getTitle() })
  }
  return windowsOnExample(windows, inExample, tmpdir(), (url) => {
    try { return url.startsWith('file:') ? fileURLToPath(url) : null } catch { return null }
  })
}
const notFromAppWindow = { ok: false as const, message: 'This window cannot remove the example vault.' }
ipcMain.handle('example:state', () => ({ removed: exampleRemoval.wasRemoved() }))
ipcMain.handle('example:removal-preview', (event) => (isAppWindow(event.sender.id) ? exampleRemoval.preview(event.sender.id) : notFromAppWindow))
ipcMain.handle('example:remove', async (event, token: unknown) => {
  if (!isAppWindow(event.sender.id)) return notFromAppWindow
  const result = await exampleRemoval.remove(token, event.sender.id)
  if (result.ok) {
    await afterExampleVaultChange()
    broadcastToWindows('example:changed', { removed: exampleRemoval.wasRemoved(), moved: true })
  }
  return result
})
ipcMain.handle('example:restore', async (event) => {
  if (!isAppWindow(event.sender.id)) return notFromAppWindow
  const result = await exampleRemoval.restore()
  if (result.ok) {
    await afterExampleVaultChange()
    broadcastToWindows('example:changed', { removed: exampleRemoval.wasRemoved(), moved: false })
  }
  return result
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
ipcMain.handle('preferences:get-paths', () => {
  const c = readConfig()
  return {
    vaultRoot: currentVaultRoot() ?? null,
    archiveRoot: c.archiveRoot ?? null,
    archiveDefault: null,
    archiveAvailable: detectArchiveRoot() != null
  }
})

handleFromSettingsWindow('preferences:choose-archive', () => null, async () => {
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

handleFromSettingsWindow('preferences:clear-archive', () => detectArchiveRoot(), () => {
  writeConfig({ archiveRoot: undefined }) // a preference: back to its default through the store
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
    // lstat, never stat: a link (the folder itself, or a file in it) is not followed, so the total
    // never includes the size of a file somewhere else on this Mac (ADR-0036).
    if (!lstatSync(assetsDir).isDirectory()) return 0
    let total = 0
    for (const f of readdirSync(assetsDir)) {
      try { const info = lstatSync(join(assetsDir, f)); if (info.isFile()) total += info.size } catch { /* skip */ }
    }
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
  const resolved = resolvePooledRefs(content, outlinePath)
  const model = await withPrewarmYield(() => prepareSource(outlinePath, resolved, slug, stat, timerSettings(), { ...mediaOptions, allowedAssetRoots: assetRootsFor(outlinePath) }))
  return String(model.fullHtml ?? '')
}

// Export exactly the talks handed in — never a vault scan (ADR-0024). The caller has already
// decided who is enrolled; this only compiles, writes and records.
async function runBackupFor(talks: Array<{ slug: string; outlinePath: string }>): Promise<BackupRun> {
  const folder = getConfig('backupFolder', undefined)
  const compilerDir = getCompilerPath()
  const empty = { at: Date.now(), ok: false, exported: 0, skipped: 0, failed: 0, skippedTalks: [] as BackupSkip[] }
  if (!folder) return (lastBackup = { ...empty, error: 'No backup folder set' })
  const overlap = backupFolderOverlap(folder)
  if (overlap) return (lastBackup = { ...empty, error: overlap })
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
ipcMain.handle('preferences:get-action-bar', () => actionBarState())
ipcMain.handle('preferences:set-action-bar-visible', (_event, visible: boolean) => {
  writeConfig({ actionBarVisible: visible === true })
  broadcastActionBar()
  return actionBarState().visible
})

// ── Editor view (plain editing view): Plain or Markdown, one app-wide setting, broadcast to every window ──
function editorViewMode(): EditorViewMode {
  return editorViewModeFrom(readConfig()[EDITOR_VIEW_MODE_KEY])
}
ipcMain.handle('preferences:get-editor-view-mode', () => editorViewMode())
ipcMain.handle('preferences:set-editor-view-mode', (_event, mode: unknown) => {
  writeConfig({ [EDITOR_VIEW_MODE_KEY]: editorViewModeFrom(mode) })
  const next = editorViewMode()
  for (const win of BrowserWindow.getAllWindows()) {
    try { if (!win.isDestroyed()) win.webContents.send('editor-view-mode:changed', next) } catch { /* window closing */ }
  }
  return next
})

// ── Plain view look (plain editing view, spec T13): font and text size, app-wide, broadcast to every window ──
function plainLook(): PlainLook {
  return plainLookFrom(readConfig() as Record<string, unknown>)
}
ipcMain.handle('preferences:get-plain-look', () => plainLook())
ipcMain.handle('preferences:set-plain-look', (_event, change: unknown) => {
  const c = (change && typeof change === 'object' ? change : {}) as { font?: unknown; size?: unknown }
  const current = plainLook()
  writeConfig({
    [PLAIN_FONT_KEY]: c.font === undefined ? current.font : plainFontFrom(c.font),
    [PLAIN_TEXT_SIZE_KEY]: c.size === undefined ? current.size : plainTextSizeFrom(c.size)
  })
  const next = plainLook()
  for (const win of BrowserWindow.getAllWindows()) {
    try { if (!win.isDestroyed()) win.webContents.send('plain-look:changed', next) } catch { /* window closing */ }
  }
  return next
})

// ── Place chip (onboarding ticket 02): one app-wide visibility setting, broadcast like the bar ──
function placeChipVisible(): boolean {
  return placeChipVisibleFrom(readConfig().placeChipVisible)
}
ipcMain.handle('preferences:get-place-chip', () => ({ visible: placeChipVisible() }))
ipcMain.handle('preferences:set-place-chip-visible', (_event, visible: boolean) => {
  writeConfig({ placeChipVisible: visible === true })
  const state = { visible: placeChipVisible() }
  for (const win of BrowserWindow.getAllWindows()) {
    try { if (!win.isDestroyed()) win.webContents.send('place-chip:changed', state) } catch { /* window closing */ }
  }
  return state.visible
})

// ── The Guide (onboarding ticket 07): the sidebar button's switch and the Guide's progress ──
function broadcastToWindows(channel: string, state: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    try { if (!win.isDestroyed()) win.webContents.send(channel, state) } catch { /* window closing */ }
  }
}
function guideButtonVisible(): boolean {
  return guideButtonVisibleFrom(readConfig().guideButtonVisible)
}
ipcMain.handle('preferences:get-guide-button', () => ({ visible: guideButtonVisible() }))
function setGuideButtonVisible(visible: boolean): boolean {
  writeConfig({ guideButtonVisible: visible === true })
  const state = { visible: guideButtonVisible() }
  broadcastToWindows('guide-button:changed', state)
  // The presenter's chip and column follow the switch (ticket 10): no chip and no column while off.
  pushPresentChapter()
  return state.visible
}
ipcMain.handle('preferences:set-guide-button-visible', (_event, visible: boolean) => setGuideButtonVisible(visible === true))
ipcMain.handle('guide:get-progress', () => guideProgressFrom(readConfig().guideProgress))
// A talk of the example vault was opened in some window: kept once, told to every window.
ipcMain.handle('guide:note-example-talk-opened', () => {
  const current = guideProgressFrom(readConfig().guideProgress)
  if (current.exampleTalkOpened) return current
  writeConfig({ guideProgress: { ...readConfig().guideProgress, exampleTalkOpened: true } })
  const next = guideProgressFrom(readConfig().guideProgress)
  broadcastToWindows('guide:progress-changed', next)
  return next
})

// ── Chapter progress (onboarding ticket 08): the one place every window reports a command run to ──
// Main is the one writer. The window says which talk it was in (`outlinePath`) and main decides
// whether that is the example vault: commands that delete tick only there (lock decision 12).
const guideLearn = new GuideLearnStore({
  read: () => readConfig()[GUIDE_LEARN_KEY],
  write: (record: GuideLearn) => writeConfig({ [GUIDE_LEARN_KEY]: record })
})
// The whole record goes to app windows only; a presenter is sent its Present chapter (ticket 10).
guideLearn.onChange = (record) => {
  for (const win of BrowserWindow.getAllWindows()) {
    try { if (!win.isDestroyed() && isAppWindow(win.webContents.id)) win.webContents.send('guide:learn-changed', record) } catch { /* window closing */ }
  }
  pushPresentChapter()
}
ipcMain.handle('guide:get-learn', (event) => (isAppWindow(event.sender.id) ? guideLearn.read() : null))
ipcMain.handle('guide:command-ran', (event, id: unknown, outlinePath?: unknown): { id: string | null; ticked: boolean } => {
  try {
    // An app window (editor, Tools, Pathways) may report any command. A deck window main opened (the
    // presenter, a plain presentation window) reaches here through its bridge preload and may report
    // only a well-formed presenter id (src/main/guide-present.ts); its outline path is not asked for.
    const appWindow = isAppWindow(event.sender.id)
    if (!acceptCommandRan({ appWindow, deckWindow: presentWindows.has(event.sender.id) }, id)) return { id: null, ticked: false }
    const hit = appWindow && typeof outlinePath === 'string' && outlinePath ? vaultRegistry.resolve(outlinePath) : null
    return guideLearn.commandRan(id, { inExample: hit?.vault.example === true })
  } catch {
    return { id: null, ticked: false }
  }
})
ipcMain.handle('guide:chapter-opened', (event, task: unknown) => isAppWindow(event.sender.id) && guideLearn.chapterOpened(task))
ipcMain.handle('guide:topic-read', (event, topic: unknown) => isAppWindow(event.sender.id) && guideLearn.topicRead(topic))

// ── The Present chapter in the presenter (onboarding ticket 10; src/main/guide-present.ts) ──
const presenterChordOf = (shortcutId: string): string => SHORTCUT_REGISTRY.find((row) => row.id === shortcutId)?.keys ?? ''
/** The presenter window main opened for this webContents id, or undefined. */
function presenterDeck(senderId: number): BrowserWindow | undefined {
  if (presentWindows.get(senderId)?.mode !== 'presenter') return undefined
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.id === senderId)
  return win
}
function presentChapterFor(senderId: number): PresentGuideView | null {
  if (!guideButtonVisible()) return null
  const chapter = chapterFor(guideLearn.chapters(), 'Present')
  if (!chapter) return null
  // "(open now)" when this presenter shows the chapter's practice talk: Lightning round in the example vault.
  const outlinePath = presentWindows.get(senderId)?.outlinePath
  const hit = outlinePath ? vaultRegistry.resolve(outlinePath) : null
  const openNow = hit?.vault.example === true && hit.rel.split('/')[0] === 'lightning-round'
  return presentGuideView(chapter, guideLearn.read(), presenterChordOf, openNow)
}
const presenterGuide = new PresenterGuideHost({
  isPresenter: (senderId) => presenterDeck(senderId) !== undefined,
  view: presentChapterFor,
  showChapterList: (senderId) => {
    // The editor window that has this deck's talk active, or the last-focused one (as ⌘E does).
    const win = targetEditorFor(presentWindows.get(senderId)?.outlinePath ?? null)
    if (!win || win.isDestroyed()) return false
    if (win.isMinimized()) win.restore()
    if (!E2E) win.show()
    win.focus()
    win.webContents.send(SHOW_CHAPTER_LIST_CHANNEL)
    return true
  },
  hideButton: () => { setGuideButtonVisible(false) }
})
registerPresenterGuideIpc(ipcMain, presenterGuide)
function pushPresentChapter(): void {
  for (const [wcId, info] of presentWindows) {
    if (info.mode !== 'presenter') continue
    const win = presenterDeck(wcId)
    if (!win) continue
    try { win.webContents.send('guide:present-chapter-changed', presenterGuide.chapter(wcId)) } catch { /* window closing */ }
  }
}

// ── What it connects to (onboarding ticket 11) ──
// Read-only probes run when the Features segment is opened and on its refresh button, never at launch
// (src/main/guide-connections.ts). Two asks at once share one read. TW_E2E_MACHINE (an unpackaged E2E
// run only) stands in for the machine: a JSON ConnectionSources.
let connectionsInFlight: Promise<ConnectionRow[]> | null = null
function readConnections(): Promise<ConnectionRow[]> {
  const stub = process.env.TW_E2E_MACHINE
  if (E2E && !app.isPackaged && stub) {
    try { return Promise.resolve(connectionRows({ ...NO_SOURCES, ...(JSON.parse(stub) as Partial<ConnectionSources>) })) } catch { /* fall through to the real probes */ }
  }
  connectionsInFlight ??= probeConnections({
    platform: process.platform,
    home: homedir(),
    pathEnv: process.env.PATH,
    timeoutMs: 1500,
    stat: async (path) => {
      try {
        const s = await statAsync(path)
        let executable = false
        try { await accessAsync(path, fsConstants.X_OK); executable = true } catch { /* not runnable */ }
        return { isFile: s.isFile(), isDirectory: s.isDirectory(), executable }
      } catch { return null }
    },
    config: readConfig(),
    // The statuses Settings shows, as they stand (none asks the network): the Guide words the same objects.
    cloudflare: () => cloudflareConnection().status(),
    goingLive: () => liveService().row(),
    recording: () => recordingStorage().status(),
    transcription: () => transcriptionSetup().status(),
    vaults: () => vaultViews().filter((v) => v.open && !v.unavailable && !v.example).map((v) => ({ name: v.name, service: v.service }))
  }).finally(() => { connectionsInFlight = null })
  return connectionsInFlight
}
ipcMain.handle('guide:connections', (event): Promise<ConnectionRow[]> => {
  if (!isAppWindow(event.sender.id)) return Promise.resolve([])
  return readConnections().catch(() => [])
})
ipcMain.handle('guide:open-link', async (event, id: unknown): Promise<boolean> => {
  if (!isAppWindow(event.sender.id) || !isGuideLinkId(id)) return false
  if (E2E) { console.log('[guide] link (E2E):', GUIDE_LINKS[id]); return true }
  const link = handOutLink(GUIDE_LINKS[id])
  if (!link || link.kind !== 'web') return false
  try { await shell.openExternal(link.href); return true } catch { return false }
})

ipcMain.handle('preferences:get-backup', () => backupSettings())

ipcMain.handle('preferences:set-backup', (_event, patch: { enabled?: boolean; intervalMin?: number }) => {
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

handleFromSettingsWindow('preferences:choose-backup-folder', () => backupSettings(), async () => {
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

handleFromSettingsWindow('preferences:clear-backup-folder', () => backupSettings(), () => {
  writeConfig({ backupFolder: undefined }) // a preference: back to its default through the store
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

ipcMain.handle('preferences:get-timer', () => timerSettings())

ipcMain.handle('preferences:set-timer', (_event, patch: { warnAtMinutes?: number; urgentAtMinutes?: number }) => {
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

ipcMain.handle('preferences:get-metadata-defaults', () => metadataDefaults())

ipcMain.handle('preferences:set-metadata-defaults', (_event, patch: MetadataDefaults) => {
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
ipcMain.handle('preferences:changelog-get', () => readSettingsChangelog())
ipcMain.handle('preferences:changelog-log', (_event, entry: { key: string; label: string; from: string; to: string }) => {
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
handleFromSettingsWindow('backup:run-now', () => null, async () => {
  const state = loadBackupScope()
  const talks = enrolledSlugs(state).map((slug) => ({ slug, outlinePath: state.talks[slug].outlinePath }))
  return runBackupFor(talks.filter((t) => t.outlinePath))
})

// Settings: tick/untick a talk. Unticking is how a talk leaves the set before the 14 days are up.
handleFromSettingsWindow('backup:set-enrolled', () => backupSettings(), (_event, slug: string, enrolled: boolean) => {
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
  'chat', 'chat-lanes', 'terminal', 'terminal-agent',
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
    // The reference deck is the app's own: its media is the fixtures folder copied into this temp folder.
    const model = await withPrewarmYield(() => prepareSource(outlinePath, outline, slug, stat, undefined, { allowedAssetRoots: [refWork] }))
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
      if (key) out[layoutName] = thumbUrl(cacheSlug, key, null)
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

// The names of the vendored Lucide set, as keys (`lucide:name`), in the set's own order: what the
// Plain view's Command-I picker lists before a search is typed, and the set its verb accepts
// names from. Read from the file the compiler's 05-icons.mjs reads; the search stays icons:search.
let lucideNamesCache: { dir: string; names: string[] } | null = null
ipcMain.handle('icons:names', async () => {
  try {
    const compilerDir = getCompilerPath()
    if (lucideNamesCache && lucideNamesCache.dir === compilerDir) return lucideNamesCache.names
    const set = JSON.parse(await readFileAsync(join(compilerDir, '..', 'assets/icons/lucide.json'), 'utf8')) as Record<string, unknown>
    const names = Object.keys(set).filter((name) => /^[a-z0-9][a-z0-9-]*$/.test(name)).map((name) => `lucide:${name}`)
    lucideNamesCache = { dir: compilerDir, names }
    return names
  } catch (e) {
    console.error('[icons:names]', e)
    return []
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
  /** sha256 (hex) of markSlidePreviewHtml(model.fullHtml), worked out in the compile's worker thread. */
  previewKey?: string
}
const preparedTalkCache = createPreparedTalkCache<PreparedTalk>({
  maxEntries: 6,
  maxBytes: 256 * 1024 * 1024,
  sizeOf: (entry) => typeof entry.model.fullHtml === 'string' ? entry.model.fullHtml.length * 2 : 0
})

// Live, variant and share preparations are serialised by preparePass. Direct compiles (builds,
// exports, diagnostics, previews and publishing workers) use its counted withPrewarmYield scope;
// they keep their existing concurrency and do not wait in either queue. Every non-prewarm gate
// request and direct scope releases the prewarm's held talk synchronously. Queued work and direct
// scopes block prewarm starts, including a prewarm job queued before a direct compile began. This bounds prewarm overlap;
// it does not promise that other callers retain only one deck after their compile has settled.
// Residual: a scope does not queue. If it starts while a prewarm compile is already running in the worker, the scope's
// deck and the prewarm's incoming video-free deck are both in the main heap until wantedWhilePreparing drops the latter
// (thumbnail-prewarm.ts:365).
// A live compile: cached, on the gate's ordinary lane. A layout variant: uncached, on its background lane.
const routePreparation = createPreparationRoute(preparedTalkCache, preparePass)

// The live compile's own process (prepare-talk-off-thread.ts): a utility process with a heap of its own,
// started on the first compile, ended when idle. out/main/prepare-talk-worker.js is its own build entry
// (electron.vite.config.ts) and ships as a plain file (asar is off in package.json "build").
const prepareTalkOffThread = createPrepareTalkOffThread(join(__dirname, 'prepare-talk-worker.js'), forkCompileChild)

async function prepareTalk(
  outlinePath: string,
  content: string,
  defaults?: Record<string, unknown>,
  options?: Record<string, unknown>,
  /** 'variant' for a compile that is not the live deck (a layout variant): uncached, so it neither
   *  displaces the live deck's retained model nor stays retained itself, and on the preparation gate's
   *  background lane, so the live deck's compile never waits behind it (createPreparationRoute).
   *  'prewarm' is the same uncached priority, but must not trigger its own release hook. */
  lane: PreparationLane = 'live'
): Promise<PreparedTalk | null> {
  const compilerDir = getCompilerPath()
  if (!compilerDir) return null
  statSync(outlinePath) // an outline that is not there fails here, as before (the worker reads its own stat)
  const slug = basename(outlinePath).replace('-outline.md', '')
  const vaultRoot = vaultRootFor(outlinePath)
  const resolved = resolvePooledRefs(content, outlinePath)
  // The allowed media folders are part of what was compiled, so they are part of the cache group.
  const compileOptions = { ...(options ?? {}), allowedAssetRoots: assetRootsFor(outlinePath) }
  const group = preparedTalkGroup(outlinePath, defaults, compileOptions)
  const key = group + '\0' + createHash('sha256').update(resolved).digest('hex')
  const load = async (gated: <R>(task: () => Promise<R>) => Promise<R>): Promise<PreparedTalk> => {
    if (process.env.TW_REC_TEST === '1') {
      const testGlobal = globalThis as typeof globalThis & { __twPrepareCount?: number }
      testGlobal.__twPrepareCount = (testGlobal.__twPrepareCount ?? 0) + 1
    }
    // The compile and the per-slide rows run in the compile's own process (prepare-talk-worker.ts),
    // still inside the gate: one heavy compile at a time, as before.
    const { model, rows, previewKey } = await gated(() => prepareTalkOffThread({ compilerDir, outlinePath, text: resolved, slug, defaults, options: compileOptions }))
    return { slug, model: model as PreparedTalk['model'], rows, previewKey }
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

/** The thumbnails' document id: the first 16 hex digits of sha256(markSlidePreviewHtml(html)). A
 *  compile from prepareTalk carries that digest already (`previewKey`, from its worker thread), which
 *  saves the main process a whole-deck regex pass and hash. */
function thumbnailDocumentId(html: string, previewKey?: string): string {
  if (previewKey) return previewKey.slice(0, 16)
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
    const documentId = thumbnailDocumentId(fullHtml, prepared.previewKey)
    const selected = selectedThumbnailSlide(prepared.rows, String(slideId), documentId)
    if (!selected) return null
    const cacheDir = talkThumbCacheDir(outlinePath, prepared.slug)
    const rendered = await renderThumbnails({ fullHtml, deckKey: prepared.previewKey, slides: [selected], cacheDir })
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
    return mediaFingerprint(outlinePath, resolvePooledRefs(content, outlinePath))
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
    const slides = thumbnailSlides(rows, thumbnailDocumentId(fullHtml, prepared.previewKey))
    const rendered = await renderThumbnails({ fullHtml, deckKey: prepared.previewKey, slides, cacheDir: talkThumbCacheDir(version.outlinePath, prepared.slug), requestKey: `conflict:${_event.sender.id}:${side === 'theirs' ? 'theirs' : 'mine'}` })
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
// Local inlined pages carry their document in `data-embed-doc` (no data-src) and always work, so they are skipped here —
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
    const resolved = resolvePooledRefs(content, outlinePath)
    const model = await withPrewarmYield(() => prepareSource(outlinePath, resolved, slug, stat, undefined, { allowedAssetRoots: assetRootsFor(outlinePath) }))
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
    const resolved = resolvePooledRefs(content, outlinePath)
    const { prepareSource } = await import(pathToFileURL(join(compilerDir, 'lib/08-source-adapters.mjs')).href)
    const { buildPerSlideProjections } = await import(pathToFileURL(join(compilerDir, 'lib/10-projections.mjs')).href)
    const model = await withPrewarmYield(() => prepareSource(outlinePath, resolved, slug, stat, undefined, { allowedAssetRoots: assetRootsFor(outlinePath) }))
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
type SearchCacheEntry = { mtimeMs: number; compilerTag?: string; rows: ProjectionRowMain[]; talkTitle: string; meta?: string; deckPictures?: DeckPictures }

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
// The search index, counting the times it dropped entries (`resets`: delete and clear). Part of the
// Slide Browser's freshness stamp (search-index-stamp.ts); an entry rebuilt for a changed outline is
// already told by the outline's mtime there.
class ResetCountingMap<K, V> extends Map<K, V> {
  resets = 0
  delete(key: K): boolean { const had = super.delete(key); if (had) this.resets += 1; return had }
  clear(): void { if (this.size > 0) this.resets += 1; super.clear() }
}
const searchCache = new ResetCountingMap<string, SearchCacheEntry & { slug: string }>()
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
    if (entry.meta === undefined || entry.deckPictures === undefined) {
      let content = ''
      try { content = readFileSync(talk.outlinePath, 'utf8') } catch { /* unreadable: empty */ }
      if (entry.meta === undefined) entry.meta = parseTalkMeta(content)
      if (entry.deckPictures === undefined) entry.deckPictures = deckPicturesOf(content)
    }
    return entry.rows
  }
  const content = readFileSync(talk.outlinePath, 'utf8')
  const resolved = resolveImageRefs(content, vaultRoot, talk.outlinePath)
  // projectionsOnly: search rows are pure TEXT — never inline this talk's media (video/image Buffers)
  // into the main process. A whole-vault warm/search over a heavy-media vault used to OOM-crash here.
  const model = await withPrewarmYield(() => prepareSource(talk.outlinePath, resolved, talk.slug, stat, undefined, { projectionsOnly: true, allowedAssetRoots: assetRootsFor(talk.outlinePath) }))
  const rows = buildPerSlideProjections(model, talk.slug)
  if (!rows) return null
  searchCache.set(talk.outlinePath, { mtimeMs: stat.mtimeMs, compilerTag, rows, talkTitle: talk.title, slug: talk.slug, meta: parseTalkMeta(content), deckPictures: deckPicturesOf(content) })
  persistSearchIndexSoon()
  // New or changed pictures this rebuild brought in: read their text in the background.
  queueTalkImages(talk.outlinePath, vaultRoot, rows, content)
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
    thumbnailPrewarm.nudge() // new or changed talks: the prewarm looks again
  } catch (e) {
    console.error('[search] warm failed', e)
  } finally {
    warming = false
  }
}

// ── Thumbnail prewarm (thumbnail-prewarm.ts says why it is shaped as it is) ─────────────────────
// Renders, in the background, the pictures the Slide Browser will ask for: every talk of every open
// vault, open-in-an-editor first, then most recently edited. The talk list and its picture keys come
// from the search index (no compile); a talk is compiled only when a picture is missing, video-free and
// uncached (the explicit 'prewarm' lane, behind every live compile), and its model is
// dropped as soon as its pictures are written. Renders take the lowest place in the render queue.
const PREWARM_RENDER_KEY = 'prewarm'
type PrewarmDeckHeld = { fullHtml: string | null; deckKey?: string; cacheDir: string }
const prewarmDecks = new WeakMap<object, PrewarmDeckHeld>()
const thumbnailPrewarm = createThumbnailPrewarm({
  listTalks: () => {
    const compilerTag = thumbCacheRoot()
    const open = new Set([...editorWindows.values()].map((entry) => entry.outlinePath).filter((p): p is string => Boolean(p)))
    const talks: PrewarmTalk[] = []
    for (const vault of availableVaults()) for (const talk of findTalks(vault.root)) {
      const entry = searchCache.get(talk.outlinePath)
      let mtimeMs = 0
      try { mtimeMs = statSync(talk.outlinePath).mtimeMs } catch { continue }
      // Only rows built from this outline by this compiler name the pictures the Browser asks for.
      if (!entry || !isSearchIndexEntryFresh(entry, mtimeMs, compilerTag)) continue
      const keys = entry.rows
        .map((row) => { const r = row as { render_hash?: string; content_hash?: string }; return r.render_hash || r.content_hash || '' })
        .filter(Boolean)
      if (keys.length) talks.push({ outlinePath: talk.outlinePath, slug: talk.slug, editedMs: mtimeMs, open: open.has(talk.outlinePath), keys })
    }
    return talks
  },
  missing: (talk, keys) => {
    const held = thumbKeysIn(talkThumbCacheDir(talk.outlinePath, talk.slug))
    return keys.filter((key) => !held.has(key))
  },
  prepare: async (talk) => {
    if (outlineRefused(talk.outlinePath)) return null
    const mediaOptions = await browserThumbnailMediaOptions()
    if (!mediaOptions) return null // never the standing defaults: inlining every video is the crash
    const content = await readFileAsync(talk.outlinePath, 'utf8')
    const prepared = await prepareTalk(talk.outlinePath, content, undefined, mediaOptions, 'prewarm')
    if (!prepared || typeof prepared.model.fullHtml !== 'string') return null
    const fullHtml = prepared.model.fullHtml
    const slides = thumbnailSlides((prepared.rows ?? []) as Parameters<typeof thumbnailSlides>[0], thumbnailDocumentId(fullHtml, prepared.previewKey))
    const held: PrewarmDeckHeld = { fullHtml, deckKey: prepared.previewKey, cacheDir: talkThumbCacheDir(talk.outlinePath, prepared.slug) }
    const deck = { slides, release: () => { held.fullHtml = null } }
    prewarmDecks.set(deck, held)
    return deck
  },
  render: async (_talk, deck, slides, paceMs, shouldYield) => {
    const held = prewarmDecks.get(deck)
    if (!held?.fullHtml) return { interrupted: false }
    const { interrupted } = await renderThumbnailsIdle({
      fullHtml: held.fullHtml, deckKey: held.deckKey, slides, cacheDir: held.cacheDir, requestKey: PREWARM_RENDER_KEY, paceMs, shouldYield
    })
    return { interrupted }
  },
  talkAlive: (talk) => existsSync(talk.outlinePath) && availableVaults().some((vault) => {
    const rel = relativePath(vault.root, talk.outlinePath)
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
  }),
  recycleRenderer: () => recycleRenderWindow(),
  cancelRender: () => cancelThumbnailRender(PREWARM_RENDER_KEY),
  memory: () => {
    const usage = process.memoryUsage()
    const rendererPid = renderWindowProcessId()
    let appBytes = 0
    let rendererBytes: number | null = null
    try {
      for (const metric of app.getAppMetrics()) {
        const bytes = (metric.memory?.workingSetSize ?? 0) * 1024
        appBytes += bytes
        if (rendererPid != null && metric.pid === rendererPid) rendererBytes = bytes
      }
    } catch { appBytes = usage.rss }
    return { mainHeapBytes: usage.heapUsed, mainRssBytes: usage.rss, rendererBytes, appBytes, loadPerCpu: loadavg()[0] / Math.max(1, cpus().length) }
  },
  presenting: () => presentWindows.size > 0 || (liveSessions?.liveRuns().length ?? 0) > 0,
  // Someone's render or compile, or the search index's own warm (it compiles in this process).
  foregroundBusy: () => thumbnailForeground().busy || preparePass.foregroundBusy() || warming,
  lastForegroundAt: () => thumbnailForeground().lastAt,
  now: () => Date.now(),
  sleep: (ms, signal) => new Promise<void>((resolve) => {
    if (signal.aborted) { resolve(); return }
    const timer = setTimeout(done, ms)
    function done(): void { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
    signal.addEventListener('abort', done, { once: true })
  }),
  log: (message) => logThumbnails(message),
  limits: {
    // Half the machine at most, and never past 8 GB, for the whole app before the prewarm waits.
    appPauseBytes: Math.min(8192 * 1024 * 1024, Math.floor(totalmem() * 0.5)),
    hardAppBytes: Math.min(10240 * 1024 * 1024, Math.floor(totalmem() * 0.6)),
    ...(E2E && process.env.TW_E2E_PREWARM_DELAY_MS ? { startDelayMs: Number(process.env.TW_E2E_PREWARM_DELAY_MS) } : {}),
    ...(E2E && process.env.TW_E2E_PREWARM_QUIET_MS ? { quietMs: Number(process.env.TW_E2E_PREWARM_QUIET_MS) } : {}),
    ...(E2E && process.env.TW_E2E_PREWARM_MAX_LOAD ? { loadPerCpuPause: Number(process.env.TW_E2E_PREWARM_MAX_LOAD) } : {})
  }
})
setPreparationReleaseHook(() => thumbnailPrewarm.releaseNow())
// Test runs leave the prewarm off (it would render behind every other e2e spec) unless asked for;
// a harness that asks reads its state from the main process.
const PREWARM_ENABLED = !E2E || process.env.TW_E2E_PREWARM === '1'
if (E2E && PREWARM_ENABLED) (globalThis as typeof globalThis & { __twPrewarm?: typeof thumbnailPrewarm }).__twPrewarm = thumbnailPrewarm

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
        const resolved = resolveImageRefs(content, vaultRoot, talk.outlinePath)
        const model = await withPrewarmYield(() => prepareSource(talk.outlinePath, resolved, talk.slug, stat, undefined, { allowedAssetRoots: assetRootsFor(talk.outlinePath) }))
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
function ocrCacheFile(): string { return join(app.getPath('userData'), 'ocr-cache.json') }
// Image-text index (ocr-index.ts): file path + mtime -> recognised text. On by default; Settings
// (`ocrEnabled: false`) stops the BACKGROUND pass only, the palette command always runs.
const ocrIndex: OcrIndex = createOcrIndex({
  loadCache: () => { try { return JSON.parse(readFileSync(ocrCacheFile(), 'utf8')) } catch { return null } },
  saveCache: (cache) => { try { writeFileSync(ocrCacheFile(), JSON.stringify(cache), 'utf8') } catch { /* ignore */ } },
  mtimeOf: (path) => { try { return statSync(path).mtimeMs } catch { return null } },
  runHelper: (paths) => new Promise((resolve) => {
    const bin = resolveOcrBin()
    if (!bin) { resolve({ stdout: '', ok: false }); return }
    execFile(bin, paths, { maxBuffer: 64 * 1024 * 1024, timeout: 120000 }, (err, out) => resolve({ stdout: String(out || ''), ok: !err }))
  }),
  helperAvailable: () => !!resolveOcrBin(),
  isEnabled: () => getConfig('ocrEnabled', true) !== false,
  log: (m) => console.log(m)
})
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
// Every picture file the image-text pass should read for one vault: the pool + each talk's assets/
// (contained, no links: image-search/vault-pictures.ts) AND every picture a slide there names.
function ocrCandidatesFor(vaultRoot: string): string[] {
  const talks = findTalks(vaultRoot)
  const out = new Set(gatherVaultImagesIn(vaultRoot, talks.map((talk) => talk.outlinePath), OCR_PICTURE_EXTS))
  for (const talk of talks) {
    const cached = searchCache.get(talk.outlinePath)
    if (!cached?.rows) continue
    for (const p of talkImagePaths(cached.rows, talk.outlinePath, vaultRoot)) out.add(p)
    // The deck logo (drawn on title / closing posters), from the cached frontmatter.
    if (cached.deckPictures?.logo.length) for (const p of resolveImagePaths(cached.deckPictures.logo, dirname(talk.outlinePath), vaultRoot)) out.add(p)
  }
  return [...out]
}
// Every open vault, the first (current) one first. Each picture carries the vault it was found in:
// the index re-checks, right before reading, that its real path is still inside that vault.
function ocrCandidates(): OcrPicture[] {
  const out = new Map<string, string>()
  const primary = currentVaultRoot()
  const roots = [...(primary ? [primary] : []), ...availableVaults().map((v) => v.root).filter((r) => r !== primary)]
  for (const root of roots) for (const p of ocrCandidatesFor(root)) if (!out.has(p)) out.set(p, root)
  return [...out].map(([path, root]) => ({ path, root }))
}
// Background pass: read every picture not already known (or changed). Idempotent + cached; one
// helper process at a time, never blocks search.
function ocrAllVaultImages(): void {
  if (!getConfig('ocrEnabled', true)) return
  try {
    const all = ocrCandidates()
    ocrIndex.queue(all)
  } catch (e) { console.error('[ocr] pass failed', e) }
}
// A talk's rows were just rebuilt (save, import, startup warm): queue its pictures that are new or
// changed. Debounced inside the index; returns at once.
function queueTalkImages(outlinePath: string, vaultRoot: string, rows: ProjectionRowMain[], outlineText: string): void {
  if (!getConfig('ocrEnabled', true)) return
  try { ocrIndex.queue(talkImagePaths(rows, outlinePath, vaultRoot, outlineText).map((path) => ({ path, root: vaultRoot }))) } catch { /* background only */ }
}
// The picture files one row names (extract + resolve), for the search's image haystack.
// The text read from the pictures a talk names, keyed by the picture's absolute path: handed to the compiler
// (`pictureText`, ticket 2b) so the presenter outline and the exported pages can search "in picture:". Pictures with
// no stored text are left out; with the setting off nothing is ever stored.
function pictureTextForCompile(outlinePath: string, outlineText: string): Record<string, string> {
  const vaultRoot = vaultRootFor(outlinePath)
  if (!vaultRoot) return {}
  const out: Record<string, string> = {}
  for (const path of slideImagePaths(outlineText, dirname(outlinePath), vaultRoot)) {
    const entry = ocrIndex.entry(path)
    if (entry && !entry.failed && !entry.skipped && entry.text) out[path] = entry.text
  }
  return out
}
const slideImageText: ImageTextSource = { generation: () => ocrIndex.generation(), textLower: (p) => ocrIndex.textLower(p) }
const slideSearch = createSlideSearch({ imageText: slideImageText })

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
// options.requestId + options.supersedeKey: a newer request with the same key from the same window
// replaces this one; the scan stops at the next yield and answers [] (the renderer drops it).
// The latest request id per window + key; a window's records go when its page navigates (a reload
// restarts the renderer's ids at 1) or closes.
const searchSupersede = createSupersedeTracker()
const searchSupersedeWatched = new WeakSet<Electron.WebContents>()
function watchSearchSender(wc: Electron.WebContents): void {
  if (searchSupersedeWatched.has(wc)) return
  searchSupersedeWatched.add(wc)
  const id = wc.id
  const forget = (): void => searchSupersede.forgetSender(id)
  wc.on('did-navigate', forget)
  wc.once('destroyed', forget)
}
function searchTalksOf(vaults: ReadonlyArray<{ id: string; root: string }>): Array<{ vaultId: string; vaultRoot: string; talk: TalkInfo }> {
  // A fresh walk, not the 5 s findTalks cache: the stamp must see a talk added or removed just now.
  return currentSearchTalks(vaults, scanTalks, (root, talks) => talkCache.set(root, { at: Date.now(), talks }))
}
function browserIndexStamp(talks: ReadonlyArray<{ vaultId: string; vaultRoot: string; talk: TalkInfo }>): string {
  return searchIndexStamp({
    talks,
    mtimeOf: (p) => { try { return statSync(p).mtimeMs } catch { return null } },
    compilerTag: thumbCacheRoot(),
    resets: searchCache.resets
  })
}
// The Slide Browser's freshness probe: the stamp a whole-index scan of these vaults would carry if
// it started now (search-index-stamp.ts). Stats the outlines; compiles and reads nothing. null when
// there is nothing to search.
ipcMain.handle('search:index-stamp', (_event, options?: unknown) => {
  const vaults = searchVaults(vaultRegistry.list().filter((v) => !vaultAvailability.isUnavailable(v.id)), options)
  if (!vaults.length || !getCompilerPath()) return null
  try { return browserIndexStamp(searchTalksOf(vaults)) } catch { return null }
})

ipcMain.handle('search:all-slides', async (event, query: string | SearchQuery, options?: unknown) => {
  const vaults = searchVaults(vaultRegistry.list().filter((v) => !vaultAvailability.isUnavailable(v.id)), options)
  if (!vaults.length) return options ? [] : null
  const compilerDir = getCompilerPath()
  if (!compilerDir) return null
  const opts = (options && typeof options === 'object' ? options : {}) as { requestId?: unknown; supersedeKey?: unknown }
  if (typeof opts.requestId === 'number' && typeof opts.supersedeKey === 'string' && opts.supersedeKey) watchSearchSender(event.sender)
  const superseded = searchSupersede.begin(event.sender.id, opts.supersedeKey, opts.requestId)
  try {
    // Scoped, all-words (or exact-phrase) match (slide-search.ts). The searchable fields are the slide
    // TITLE (nav_title + title), the slide BODY (full source_markdown), and the IMAGE text (cached OCR of
    // the pictures the slide names) - Section/subsection are deliberately NOT searched (they are a UI
    // filter; matching them made search far too broad). scope picks which field(s) the query is tested
    // against; scope 'all' tests all three. Empty query -> every slide.
    const q = normalizeSearchQuery(query)
    const adaptersUrl = pathToFileURL(join(compilerDir, 'lib/08-source-adapters.mjs')).href
    const projectionsUrl = pathToFileURL(join(compilerDir, 'lib/10-projections.mjs')).href
    const { prepareSource } = await import(adaptersUrl)
    const { buildPerSlideProjections } = await import(projectionsUrl)

    const compact = (opts as { compact?: unknown }).compact === true
    const wholeIndex = compact && q.terms.length === 0 && q.text.trim() === ''
    // Only a held whole-index snapshot needs fresh discovery. Typing queries keeps the 5 s cache.
    const talks = wholeIndex ? searchTalksOf(vaults) : vaults.flatMap(({ id: vaultId, root: vaultRoot }) =>
      findTalks(vaultRoot).map((talk) => ({ vaultId, vaultRoot, talk })))
    // The Browser's reply is stamped BEFORE the scan reads anything: an outline changed while it
    // runs leaves the stamp behind main's, so the held rows read as stale (search-index-stamp.ts).
    let skippedTalk = false // a talk that failed to load is missing from the rows: the stamp says so
    const { stamp, result: hits } = await scanWithStartStamp(() => wholeIndex ? browserIndexStamp(talks) : '', () => slideSearch.scan({
      query: q,
      talks,
      shouldStop: superseded,
      load: async ({ vaultRoot, talk }) => {
        try {
          const rows = await ensureTalkRows(talk, vaultRoot, prepareSource, buildPerSlideProjections)
          if (!rows) { skippedTalk = true; return null }
          const cached = searchCache.get(talk.outlinePath)
          const talkDir = dirname(talk.outlinePath)
          const deck = cached?.deckPictures ?? null
          return {
            key: talk.outlinePath,
            freshness: `${cached?.mtimeMs ?? 0}|${cached?.compilerTag ?? ''}`,
            rows,
            // The row's own pictures, plus the deck logo on the title / closing slides that draw it.
            imageRefsFor: (row: ProjectionRowMain) => rowImageRefs(row, deck),
            resolveImages: (refs: readonly unknown[]) => resolveImagePaths(refs as ImageRef[], talkDir, vaultRoot)
          }
        } catch { skippedTalk = true; return null /* skip failed talks */ }
      }
    }), () => skippedTalk)
    if (hits === null) return []
    // The Slide Browser asks for the compact reply: each talk once, rows pointing at it, without
    // the projection fields it never reads (slide-search-reply.ts). Other callers get full rows.
    if (compact) {
      return compactSlideSearchReply(hits, ({ talk: { vaultId, talk }, row, titleHit }) => {
        const cached = searchCache.get(talk.outlinePath)
        return {
          row: row as unknown as Record<string, unknown>,
          titleHit,
          talk: { talkSlug: talk.slug, talkTitle: talk.title, outlinePath: talk.outlinePath, vaultId, talkMtimeMs: cached?.mtimeMs ?? 0, talkMeta: cached?.meta ?? '' }
        }
      }, wholeIndex ? stamp : null)
    }
    return hits.map(({ talk: { vaultId, talk }, row, titleHit }) => {
      const cached = searchCache.get(talk.outlinePath)
      return {
        ...row,
        vaultId,
        talkSlug: talk.slug,
        talkTitle: talk.title,
        outlinePath: talk.outlinePath,
        talkMtimeMs: cached?.mtimeMs ?? 0,
        talkMeta: cached?.meta ?? '',
        titleHit
      }
    })
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
  // Open decks and the Capture embed window show the slide's saved views as saved now.
  try { refreshLivePageSavedViews(outlinePath) } catch { /* a deck refresh must never break a save */ }
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
    const findings = scanOutlineTriggers(text, LAYOUT_DOCTOR_VOCABULARY, { strandedTitleIcons: true })
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
    // The versions are this vault's slides, staged in a temp folder: their pooled media is in the vault.
    const model = await withPrewarmYield(() => prepareSource(outlinePath, resolved, cacheSlug, stat, undefined, { allowedAssetRoots: assetRootsFor(outlinePath, [vaultRoot]) }))
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
      if (rendered[key]) out[v.file] = thumbUrl(cacheSlug, key, null)
    })
    try { rmSync(work, { recursive: true, force: true }) } catch { /* temp only */ }
    return out
  } catch (e) {
    console.error('[ledger:version-thumbnails]', e)
    return null
  }
})

// ── Present ────────────────────────────────────────────────────────────────

type PresentBuild = { slug: string; title: string; html: string; presentPath: string; preworkSlideIds?: string[]; slideOrder?: Array<{ id: string; title: string }>; startSlideId?: string; runExtras?: RunExtrasModel }

/**
 * Presenting a planned Run (work-files ticket 25): the Run's extra slides (from its Run record) go in, after
 * their chosen slides. The Run is looked up in the talk's own folder of the outline's vault (readRunForTalk):
 * an id that names no Run of this talk, or a Run without extra slides, presents the talk as it is. With a
 * pathway, its slides decide where an extra slide can go.
 */
function runCompileForPresent(outlinePath: string, runId: string | undefined, pathwayId: string | undefined): RunCompileOption | undefined {
  if (!runId) return undefined
  const vaultRoot = vaultRootFor(outlinePath)
  if (!vaultRoot) return undefined
  const slug = basename(outlinePath).replace('-outline.md', '')
  try {
    const extraSlides = readRunForTalk(vaultRoot, slug, runId)?.extraSlides
    if (!extraSlides?.length) return undefined
    const pathway = pathwayId ? readPathwayManifest(vaultRoot, slug).pathways.find((item) => item.id === pathwayId) : undefined
    return { id: runId, slideIds: pathway ? [...pathway.slideIds] : null, extraSlides }
  } catch { return undefined }
}

async function compileTalkForPresent(outlinePath: string, content: string, run?: RunCompileOption): Promise<Omit<PresentBuild, 'presentPath'>> {
  // Goes through the shared prepared-model memo: F5 right after an edit pause (same content the
  // strip just compiled with different defaults) still recompiles, but repeated F5s don't.
  // presenterClipRefs: the presenter window's deck alone keeps each video's authored reference (so
  // a recording can name the clip); every other compile has it stripped (compiler prepareSource).
  const prepared = await prepareTalk(outlinePath, content, timerSettings(), { presenterClipRefs: true, pictureText: pictureTextForCompile(outlinePath, content), ...(run ? { run } : {}) })
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
    ...(run ? { runExtras: placedRunExtras(prepared.model) } : {}),
    slideOrder: (Array.isArray(prepared.model.slides) ? prepared.model.slides as Array<{ id?: unknown; title?: unknown }> : [])
      .map((slide) => ({ id: String(slide.id ?? ''), title: String(slide.title ?? '') }))
  }
}

function writeTalkPresentHtml(outlinePath: string, slug: string, html: string, allowTmpFallback: boolean, pathwayId?: string, runId?: string): string {
  const talkDir = dirname(outlinePath)
  const pathwaySuffix = (pathwayId ? '-pathway-' + pathwayId.replace(/[^a-zA-Z0-9_-]/g, '-') : '')
    + (runId ? '-run-' + runId.replace(/[^a-zA-Z0-9_-]/g, '-') : '')
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

async function buildTalkPresentFile(outlinePath: string, content: string, allowTmpFallback: boolean, pathwayId?: string, startSlideId?: string, runId?: string): Promise<PresentBuild> {
  const run = runCompileForPresent(outlinePath, runId, pathwayId)
  let compiled = await compileTalkForPresent(outlinePath, content, run)
  // Fix round S4: present-from-here on a pre-work step starts at the first talk slide after the
  // section, and the presenter's status line says so.
  const start = presentStartOutsidePrework(compiled.slideOrder ?? [], compiled.preworkSlideIds ?? [], startSlideId)
  if (start.notice) compiled = { ...compiled, html: injectPresenterNotice(compiled.html, start.notice) }
  if (pathwayId) {
    const vaultRoot = vaultRootFor(outlinePath)
    if (!vaultRoot) throw new Error('Choose a Vault before presenting a pathway.')
    const prepared = await prepareTalk(outlinePath, content, timerSettings(), run ? { run } : undefined)
    const manifest = readPathwayManifest(vaultRoot, compiled.slug)
    const resolved = resolvePathways(manifest.pathways, (prepared?.rows ?? []) as PathwaySlideRow[])
      .find((pathway) => pathway.id === pathwayId)
    if (!resolved) throw new Error('That pathway no longer exists.')
    const preworkIds = new Set(compiled.preworkSlideIds ?? [])
    // A Run's extra slides (ticket 25) join the pathway's slides, each after its chosen slide or at the end.
    const ids = withRunExtraIds(resolved.present.map((row) => row.slide_id).filter((id) => !preworkIds.has(id)), compiled.runExtras)
    compiled = { ...compiled, html: injectPathwayRuntime(compiled.html, ids, pathwayId) }
  } else if (compiled.preworkSlideIds?.length) {
    // Ticket 08: presenting skips the pre-work steps (the talk's own slide sequence never has them).
    compiled = { ...compiled, html: withoutPresenterSlides(compiled.html, compiled.preworkSlideIds) }
  }
  const presentPath = writeTalkPresentHtml(outlinePath, compiled.slug, compiled.html, allowTmpFallback, pathwayId, run?.id)
  return { ...compiled, presentPath, startSlideId: start.slideId }
}

function talkBySlug(slug: string): TalkInfo | null {
  const vaultRoot = currentVaultRoot()
  if (!vaultRoot) return null
  return findTalks(vaultRoot).find((talk) => talk.slug === slug) ?? null
}

// A live web page on a slide (live-page-host.ts): one host per deck window TalkWeaver opens (loaded
// with ?livepage=1), the presenter's paired with its audience window's for following.
const livePageHosts = new Map<number, LivePageHost>()
const livePageAllowance = testLoopbackAllowance({ isPackaged: app.isPackaged, e2e: E2E, value: process.env.TW_E2E_LIVE_PAGE_ALLOW })
// The capture gallery (live-page-capture.ts): a deck window's saved views go to the talk main opened
// that window for (recorded here at attach time, never taken from the deck or the page), written by a
// process of their own started in the talk folder (live-page-capture-worker.ts).
// A Capture embed window (live-page-capture-window.ts) is also bound to the one slide and page it was
// opened for: the saver refuses any other.
const livePageTalks = new Map<number, { outlinePath: string; bound?: { slideId: string; pageUrl: string } }>()
const saveLivePageCapture = createLivePageCaptureSaver({
  talkOf: (deckId) => {
    const talk = livePageTalks.get(deckId)
    const root = talk ? writableTalkRoot(talk.outlinePath) : undefined
    return talk && root ? { root, outlinePath: talk.outlinePath, ...(talk.bound ? { bound: talk.bound } : {}) } : null
  },
  run: createLivePageCaptureRunner(join(__dirname, 'live-page-capture-worker.js'), forkLivePageCaptureChild),
  saved: (outlinePath) => preparedTalkCache.evictOutline(outlinePath),
  // The saved view's {capture} line (live-page-capture-markup.mjs) goes under the slide's page through
  // the one talk writer, as a transformation of the talk's CURRENT text: an open editor's buffer takes
  // it as one change (unsaved typing kept, one Undo step), a closed talk's file is written in place
  // under its lock. A slide whose id the compiler derives is found only in the text compiled
  // (live-page-capture.ts placeSavedView); a slide or page no longer in the talk leaves it untouched.
  place: (outlinePath, view) => placeSavedView({
    read: (p) => readTalkOutline(p),
    compiledSlides: async (p, text) => (await outlineTools()).compiledSlides(p, text),
    write: async (p, next) => {
      const result = await writeTalkOutline(p, next, 'live-page-capture')
      return result.ok ? { ok: true, changed: result.changed } : { ok: false, error: result.error }
    }
  }, outlinePath, view).finally(() => refreshLivePageSavedViews(outlinePath))
})
// Every open deck and Capture embed window of the talk is told its slide's saved views as the talk's
// text has them now (live-page-saved-views.ts): after an editor save, a placed view, a removed one.
function refreshLivePageSavedViews(outlinePath: string): void {
  let canonical = ''
  try { canonical = canonicalOutlinePath(outlinePath) } catch { return }
  for (const [id, talk] of livePageTalks) {
    let same = false
    try { same = canonicalOutlinePath(talk.outlinePath) === canonical } catch { same = false }
    if (same) void livePageHosts.get(id)?.refreshSavedViews().catch(() => { /* the deck reloaded */ })
  }
}
const livePageSavedViewsOf = (outlinePath: string) => (slideId: string, pageUrl: string) => slideSavedViews({
  read: (p) => readTalkOutline(p),
  compiledSlides: async (p, text) => (await outlineTools()).compiledSlides(p, text),
  pictures: (p, items) => readCaptureEmbedViews(p, items)
}, outlinePath, slideId, pageUrl)
function attachLivePageHost(win: BrowserWindow, role: LivePageRole, outlinePath: string, bound?: { slideId: string; pageUrl: string }): LivePageHost | null {
  if (win.isDestroyed()) return null
  const id = win.webContents.id
  const existing = livePageHosts.get(id)
  if (existing) return existing
  const host = createLivePageHost(win as unknown as DeckWindow, role, {
    createView: (webPreferences) => new WebContentsView({ webPreferences }) as unknown as LiveView,
    sessionFor: (partition) => session.fromPartition(partition) as unknown as LivePageSession,
    allowance: livePageAllowance,
    devTools: !app.isPackaged,
    userAgent: app.userAgentFallback,
    newId: () => randomUUID(),
    capture: { encode: encodeCapture, save: (request) => saveLivePageCapture(id, request), views: livePageSavedViewsOf(outlinePath) }
  })
  livePageHosts.set(id, host)
  livePageTalks.set(id, { outlinePath, ...(bound ? { bound } : {}) })
  win.once('closed', () => { livePageHosts.delete(id); livePageTalks.delete(id) })
  return host
}
app.on('before-quit', () => disposeAllLivePageHosts())

// Capture embed… (live-page-capture-window.ts): one window at a time, for one slide's web page, opened
// by an editor window for the talk it has open. It closes when that editor closes or asks (another
// talk, another request). Its page has no preload: the live page and the capture are the host's.
let captureEmbed: { win: BrowserWindow; opener: number } | null = null
function closeCaptureEmbed(): void {
  const open = captureEmbed
  captureEmbed = null
  if (open && !open.win.isDestroyed()) open.win.close()
}
ipcMain.handle('live-page:open-capture', async (event, raw: unknown) => {
  const opener = BrowserWindow.fromWebContents(event.sender)
  const checked = checkCaptureEmbedRequest(raw, { writableTalkRoot: (p) => writableTalkRoot(p), allowance: livePageAllowance })
  if (!checked.ok) return checked
  const { request } = checked
  // Only an editor window, for the talk it has open (never a deck, the page, or another talk).
  const editor = opener ? editorWindowForOutline(request.outlinePath) : null
  if (!opener || !editor || editor.win !== opener) return { ok: false, message: CAPTURE_EMBED_TEXT.noEditor }
  closeCaptureEmbed()
  const alts = (raw as { alts?: unknown }).alts
  const views = readCaptureEmbedViews(request.outlinePath, request.images.map((image, i) => ({ image, alt: Array.isArray(alts) && typeof alts[i] === 'string' ? alts[i] : '' })))
  const win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 760, minHeight: 520,
    title: 'Capture embed',
    ...(E2E ? { show: false } : {}),
    backgroundColor: '#f7f3ea',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false, backgroundThrottling: false }
  })
  captureEmbed = { win, opener: opener.webContents.id }
  // The page is the app's own and never goes anywhere else.
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  attachLivePageHost(win, 'presenter', request.outlinePath, { slideId: request.slideId, pageUrl: request.pageUrl })
  let host = ''
  try { host = new URL(request.pageUrl).host } catch { /* checked */ }
  win.webContents.once('did-finish-load', () => {
    if (win.isDestroyed()) return
    win.webContents.executeJavaScript(captureEmbedInitScript({ slideId: request.slideId, pageUrl: request.pageUrl, title: request.title, host, views }), false).catch(() => {})
  })
  const onOpenerClosed = (): void => { if (captureEmbed?.win === win) closeCaptureEmbed() }
  opener.once('closed', onOpenerClosed)
  win.once('closed', () => { if (captureEmbed?.win === win) captureEmbed = null; if (!opener.isDestroyed()) opener.removeListener('closed', onOpenerClosed) })
  await win.loadURL(captureEmbedPageUrl(process.env['ELECTRON_RENDERER_URL'], __dirname))
  return { ok: true }
})
// The editor switched talk or slide set: its Capture embed window closes (no other window can ask).
ipcMain.handle('live-page:close-capture', (event) => {
  if (captureEmbed && captureEmbed.opener === event.sender.id) closeCaptureEmbed()
  return true
})

ipcMain.handle('talk:present', async (_event, outlinePath: string, content: string, mode?: string, startSlideId?: string, pathwayId?: string, plannedRunId?: string) => {
  const refusal = outlineRefused(outlinePath) // writes beside the outline: refuse one outside the vault
  if (refusal) return { success: false, error: refusal }
  const blocked = unresolvedOutboundFailure(content)
  if (blocked) return blocked
  try {
    const build = await buildTalkPresentFile(outlinePath, content, true, pathwayId, startSlideId, typeof plannedRunId === 'string' ? plannedRunId : undefined)
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
        if (mode === 'presenter') livePresenterContexts.set(wcId, livePresenterContext(vaultRegistry, outlinePath, slug, publishedUrl))
        existing.setTitle(winTitle)
        existing.focus()
        const recordingArmed = rec && rec !== 'idle' && rec !== 'saved' && rec !== 'error'
        if (recordingArmed) {
          existing.webContents.send('present:hint', 'Already presenting — stop the recording (⇧R) to refresh this deck.')
        } else {
          // Cache-bust (_r) so the reused window truly reloads the freshly-compiled file.
          const reuseQuery: Record<string, string> =
            mode === 'presenter' ? { presenter: '1' } : mode === 'audience' ? { audience: '1' } : {}
          reuseQuery.livepage = '1'
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
    // livepage=1: this deck shows a slide's web page live, in a view of its own (live-page-host.ts).
    const query: Record<string, string> = { ...(mode === 'presenter' ? { presenter: '1' } : mode === 'audience' ? { audience: '1' } : {}), livepage: '1' }
    // ⇧F5 present-from-here: the runtime reads location.hash on init and starts on the slide whose
    // dataset.id matches the id (09-output-builders.mjs). An unknown/empty id falls back to slide 0.
    const loadOpts: { query?: Record<string, string>; hash?: string } = {}
    if (query) loadOpts.query = query
    if (startSlideId) loadOpts.hash = startSlideId
    attachLivePageHost(win, mode === 'presenter' ? 'presenter' : mode === 'audience' ? 'audience' : 'window', outlinePath)
    win.loadFile(presentPath, Object.keys(loadOpts).length ? loadOpts : undefined)
    // Track this deck for ⌘R refresh-in-place, and OWN ⌘R here: before-input-event preempts the
    // default menu's Reload accelerator (which would reload to slide 0 without recompiling).
    const deckWcId = win.webContents.id
    presentWindows.set(deckWcId, { outlinePath, mode: mode ?? 'window', pathwayId, ...(typeof plannedRunId === 'string' && plannedRunId ? { runId: plannedRunId } : {}) })
    updateChecker?.busyChanged()
    if (mode === 'presenter') livePresenterContexts.set(deckWcId, livePresenterContext(vaultRegistry, outlinePath, slug, publishedUrl))
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
      presenterGuide.forget(deckWcId)
      presentWindows.delete(deckWcId)
      livePresenterContexts.delete(deckWcId)
      updateChecker?.busyChanged()
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
        win.webContents.executeJavaScript(OPEN_AUDIENCE_SCRIPT, true).catch((e) => console.warn('[present] F5 audience failed:', e))
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

// Right-click "Open in new window" (and the palette command): the same route as ⌘N then opening the
// file, in one step. A talk already open in any window (including the asking one) is focused instead
// (one writer per talk file); otherwise a new window starts and takes `target` from main once it has
// loaded its talk list (window:take-open-request — pull, so nothing is lost to a load race).
const openRequests = createOpenRequests((p) => outlineIdentity(p).key, (wcId) => { const w = editorWindows.get(wcId)?.win; return !!w && liveWindow(w) })
ipcMain.handle('window:open-in-new-window', (_event, raw: unknown) => {
  const target = parseOpenInNewWindowTarget(raw)
  if (!target) return { ok: false, reason: 'bad-target' }
  const refusal = refuseOpenTarget(target, { outlineRefused: (p) => outlineRefused(p), hasVault: (id) => !!vaultRegistry.get(id) })
  if (refusal) return { ok: false, reason: refusal }
  if (target.kind === 'talk') {
    // Open in any window, or in a window still starting for it (it has not claimed the talk yet).
    const startingId = openRequests.startingFor(target.outlinePath)
    const holder = editorEntryForOutline(editorWindows.values(), target.outlinePath, liveWindow)?.win
      ?? (startingId !== null ? editorWindows.get(startingId)?.win ?? null : null)
    const decision = decideOpenInNewWindow(holder)
    if (decision.action === 'focus') { bringToFront(decision.window); return { ok: true, focused: true } }
  }
  const win = createWindow()
  const wcId = win.webContents.id
  openRequests.start(wcId, target)
  win.on('closed', () => { openRequests.closed(wcId) })
  return { ok: true, focused: false }
})
ipcMain.handle('window:take-open-request', (event) => openRequests.take(event.sender.id))

// Same-talk guard (block-and-focus). The renderer calls this before switching a window to `outlinePath`.
// If ANOTHER editor window already has that talk active, focus it and refuse (the renderer keeps its
// current talk); otherwise record it as this window's active talk. null releases (window has no talk).
ipcMain.handle('window:claim-talk', (event, outlinePath: string | null) => {
  const entry = editorWindows.get(event.sender.id)
  openRequests.claimed(event.sender.id) // any claim attempt ends this window's "starting" state
  // Opening a talk does not enrol it, but it does keep an enrolled talk alive (ADR-0024 §2).
  if (outlinePath) { try { noteAppOpen(outlinePath) } catch { /* never block opening a talk */ } }
  // Compared by file identity (device + inode), so a talk reached through a symlinked outline or
  // folder, or through a second hard link, is still one talk: two windows on one file would hold two
  // buffers and two save queues (ticket 07, third review; one-writer spec D3).
  if (outlinePath) {
    const holder = otherEditorHolding(outlinePath, entry?.win)
    if (holder) {
      bringToFront(holder)
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
    const { presentPath } = await buildTalkPresentFile(outlinePath, content, true, info?.pathwayId, undefined, info?.runId)
    const mode = info?.mode
    // Cache-bust (_r) so this is a REAL navigation, not a same-URL no-op that skips the fresh file.
    const query: Record<string, string> = mode === 'presenter' ? { presenter: '1' } : mode === 'audience' ? { audience: '1' } : {}
    query.livepage = '1'
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
  openVaultRoots: () => availableVaults().map((vault) => vault.root),
  hasUnavailableOpenVaults: () => vaultRegistry.list().some((vault) => vault.open && vaultAvailability.isUnavailable(vault.id)),
  // A presenter window's recording, Run and stream marker go to the vault of the talk it presents (issue 256).
  presenterVault: (wcId) => {
    const info = presentWindows.get(wcId)
    return info ? presentedTalkVault(presentedVaultDeps, info.outlinePath) : undefined
  },
  writableVault: (root) => {
    const vault = availableVaults().find((v) => v.root === root)
    return vault ? writableRoot(vault.root, rootFs) ?? undefined : undefined
  },
  discardThresholdMs: () => Math.max(0, Number(getConfig('recordingDiscardMs', 20000)) || 20000),
  storage: () => recordingStorage(),
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
    // A delivery saved onto its Run: post-work that opens when the session ends opens now (ticket 19).
    if (saved.kind === 'delivery') openPostWorkFor(saved.talkSlug, saved.runId, saved.vaultRoot ?? null)
  },
})

// TalkWeaver History IPC (handout URLs + cached live checks). Registered once; deps are lazy.
// The Tools window's Work files view (work-files ticket 06): the `Work files/` folder, who names each file, which Runs carry it. Read only.
// `work-files:list` (vaultId?) → { folder, items } | null (null: no vault is open). Never throws into the renderer.
// With a vault id (the editor's strips, ticket 08): that open vault's files, null for an unknown, closed or
// unavailable vault — never another vault's. Without one: the current vault, as the Work files view lists it.
ipcMain.handle('work-files:list', async (_event, vaultId?: unknown) => {
  try {
    if (typeof vaultId === 'string' && vaultId !== '') {
      const root = rootOfVault(vaultId) ?? null
      return listWorkFilesFor(root, root ? await listIndexedTalks(root) : [])
    }
    // No vault named (the Tools window's Work files view): every open vault's files, each tagged with its vault.
    const vaults = availableVaults()
    const views = new Map(vaultViews().map((v) => [v.id, v.name]))
    const talks = new Map<string, Awaited<ReturnType<typeof listIndexedTalks>>>()
    for (const v of vaults) talks.set(v.root, await listIndexedTalks(v.root))
    // A New work file goes to the vault of the talk open in the last-focused editor window, else the current vault.
    const openTalk = mainWindow && !mainWindow.isDestroyed() ? editorWindows.get(mainWindow.webContents.id)?.outlinePath ?? null : null
    const openTalkVault = vaults.find((v) => v.id === vaultIdOf(openTalk))
    const newFileVaultId = openTalkVault?.id ?? (writableVaultRoot() ? vaultRegistry.primary()?.id : undefined) ?? vaults[0]?.id
    return listWorkFilesAcross(vaults.map((v) => ({ id: v.id, name: views.get(v.id) ?? v.id, root: v.root })), (root) => talks.get(root) ?? [], newFileVaultId)
  } catch (error) {
    console.error('[work-files] list failed', error)
    return null
  }
})
// Work-files ticket 07: make a new work file / add a step to one. Writes only into the vault's `Work files/` folder.
// `work-files:create` ({ title, presetId?, adds?, vaultId? }) and `work-files:add-step` ({ fileName, add, vaultId? }) → { ok, fileName, relPath } | { ok: false, error }.
// A request naming a vault writes into that open vault only (writableRootOfVault: no fallback to the first vault);
// without one it is the current vault, as before.
ipcMain.handle('work-files:create', (_event, input) => {
  const i = input && typeof input === 'object' ? input : {}
  const root = workFileWriteRoot(i.vaultId, writableRootOfVault)
  if (!root) return { ok: false, error: i.vaultId ? 'That vault is not open.' : 'No vault is open.' }
  return createWorkFile(root, i)
})
ipcMain.handle('work-files:add-step', (_event, input) => {
  const i = input && typeof input === 'object' ? input : {}
  const root = workFileWriteRoot(i.vaultId, writableRootOfVault)
  if (!root) return { ok: false, error: i.vaultId ? 'That vault is not open.' : 'No vault is open.' }
  return addWorkFileStep(root, i.fileName, i.add)
})
// 2026-10-19 prework-responses design: `work-files:set-step-local` ({ fileName, stepId, local, vaultId? }) writes or takes out
// the step's `{local}` (Local only / Sent to you). Every field is checked in setWorkFileStepLocal. The vault rule is add-step's:
// a named vault must be open (no fallback to the first vault); without one it is the current vault.
ipcMain.handle('work-files:set-step-local', (_event, input) => {
  const i = input && typeof input === 'object' ? input : {}
  const root = workFileWriteRoot(i.vaultId, writableRootOfVault)
  if (!root) return { ok: false, error: i.vaultId ? 'That vault is not open.' : 'No vault is open.' }
  return setWorkFileStepLocal(root, i.fileName, i.stepId, i.local)
})
// Work-files ticket 28: the Layout Doctor's "Move to a work file" for a retired `{prework}` section.
// `work-files:move-prework` ({ outlinePath }) → { ok, fileName, relPath, id, stepIds } | { ok: false, error }. The work file is written into the
// talk's own vault; the outline goes through the one outline writer (talk-writer.ts), so an open editor applies it to its own
// buffer. Unstamped steps take the ids the compiler resolves for them (adaptMarkdownOutlineV2, the talk's own compile path).
// If either write fails the section stays (see main/prework-move.ts).
ipcMain.handle('work-files:move-prework', async (_event, input) => {
  const outlinePath = input && typeof input === 'object' ? (input as { outlinePath?: unknown }).outlinePath : undefined
  // In an open vault (so the work file goes to the talk's own vault), and through the outline-writing guard: an
  // `*-outline.md` whose REAL path is inside that vault (a link to a file outside it is refused).
  if (typeof outlinePath !== 'string' || !insideVault(outlinePath) || outlineRefused(outlinePath)) return { ok: false, error: 'That talk is not in an open vault.' }
  const root = writableTalkRoot(outlinePath)
  if (!root) return { ok: false, error: 'The talk’s vault is not available, so nothing was changed.' }
  let adapters: { adaptMarkdownOutlineV2: (markdown: string, fallbackTitle: string, defaults?: unknown) => { prework?: { steps?: Array<{ id: string; sourceLine: number | null }> } | null } }
  try {
    adapters = await import(pathToFileURL(join(getCompilerPath(), 'lib/08-source-adapters.mjs')).href)
  } catch {
    return { ok: false, error: 'The talk could not be read, so nothing was changed.' }
  }
  const slug = basename(outlinePath).replace('-outline.md', '')
  const moved = await movePreworkToWorkFile(root, outlinePath, writeTalkOutline, (text) => adapters.adaptMarkdownOutlineV2(text, slug, undefined)?.prework?.steps ?? null)
  if (moved.ok || moved.keptFile) {
    frontmatterCache.delete(outlinePath)
    invalidateTalkCache(outlinePath)
    invalidateMetadataCaches()
    invalidateLayoutDoctorCache()
    notifyTalkMetaUpdated()
  }
  if (!moved.ok) return { ok: false, error: moved.error }
  return { ok: true, fileName: moved.fileName, relPath: moved.relPath, id: moved.id, stepIds: moved.stepIds }
})
registerHistoryIpc({
  userDataDir: () => app.getPath('userData'),
  vaultRoot: () => writableVaultRoot() ?? null, // writes: only a vault folder that is there (ticket 07)
  // A planned Run lives in its talk's vault: a request naming a vault writes there, only while it is open and there.
  runVault: (vaultId) => runVaultFor(vaultId),
  hasTalk: (root, talkSlug) => talkInVault(root, talkSlug) !== null,
  openVaults: () => vaultRegistry.list().filter((v) => v.open).length,
  readVault: (vaultId) => rootOfVault(vaultId),
  listTalks: (root) => listIndexedTalks(root),
  testMode: () => process.env.TW_REC_TEST === '1',
  // Work-files ticket 13: a changed opening or closing time reaches the work already sent (a later
  // closing time reopens it). In the background: the plan is saved whether or not the service answers.
  // Then post-work owed now is opened (ticket 19 review round 2: a delivered Run's post-work changed from a
  // set time to when the session ends opens now), in the vault the Run was saved in.
  onPlannedRunUpdated: (talkSlug, runId, vaultRoot) => {
    void runPrework().syncWindows(talkSlug, runId, vaultRoot).then((results) => {
      for (const result of results) if (!result.ok) console.warn(`[prework] ${result.phase}-work times not sent: ${result.error}`)
      if (results.some((result) => result.ok && !result.unchanged)) notifyTalkMetaUpdated()
    }).catch(() => console.warn('[prework] work times not sent'))
      .finally(() => openPostWorkFor(talkSlug, runId, vaultRoot))
  }
})

// Transcription IPC (Parakeet bridge + transcript store). Registered once; deps are lazy.
registerTranscriptionIpc({
  userDataDir: () => app.getPath('userData'),
  vaultRoot: () => writableVaultRoot() ?? null, // writes: only a vault folder that is there (ticket 07)
  config: () => transcriptionSetup().quickStatus().paths,
  readiness: () => transcriptionSetup().quickStatus(),
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
    const resolved = resolvePooledRefs(content, outlinePath)
    const model = await withPrewarmYield(() => prepareSource(outlinePath, resolved, slug, stat, timerSettings(), { allowedAssetRoots: assetRootsFor(outlinePath), pictureText: pictureTextForCompile(outlinePath, content) }))
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
    const resolved = resolvePooledRefs(content, outlinePath)

    const { prepareSource } = await import(pathToFileURL(join(compilerDir, 'lib/08-source-adapters.mjs')).href)
    const model = await withPrewarmYield(() => prepareSource(outlinePath, resolved, slug, stat, timerSettings(), { allowedAssetRoots: assetRootsFor(outlinePath) }))

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
  /** The same handout built to load its slide media lazily (published <slug>.html); only when asked for. */
  lazyHtml?: string
  title: string
  slug: string
  slideIds: string[]
  missing: string[]
  venueSource: { slides: Array<{ html: string; notes: string }>; styles: string; license: null; liveTalkSlug: string }
}

/**
 * A Run's compiled deck: the talk's prepared model (the editor keeps it warm), with the Run's pathway
 * and cover applied, and which slides the Run shows. What Build Run handout and Publish handout for
 * this Run build their pages from (handout-pages.ts buildRunHandoutHtml).
 */
async function runHandoutSource(
  talk: TalkInfo, run: RunRecord, content: string,
): Promise<{ source: RunHandoutSource; slideIds: string[]; missing: string[] }> {
  const forRun = runForHandout(talk, run)
  const compileRun = runCompileOption(forRun)
  const prepared = await prepareTalk(talk.outlinePath, content, timerSettings(), compileRun ? { run: compileRun } : undefined)
  if (!prepared) throw new Error('Compiler not found')
  return runHandoutSourceFrom(prepared.model, (prepared.rows ?? null) as PathwaySlideRow[] | null, forRun, prepared.slug, talk.slug)
}

/** What of a Run its handout's deck depends on: its cover, and its pathway with the talk's pathways. */
function runForHandout(talk: TalkInfo, run: RunRecord): RunForHandout {
  return runForHandoutOf(run, () => {
    const vaultRoot = vaultRootFor(talk.outlinePath)
    if (!vaultRoot) throw new Error('Choose a Vault before building a Run handout.')
    return readPathwayManifest(vaultRoot, talk.slug).pathways
  })
}

/** Where a Run's handout is kept on this computer: the talk folder's dist/. */
function runHandoutDistPath(talk: TalkInfo, slug: string): string {
  return join(dirname(talk.outlinePath), 'dist', `${slug}-handout.html`)
}

async function buildRunHandoutArtifact(
  talk: TalkInfo,
  run: RunRecord,
  content: string,
  outputSlug?: string,
  workerBaseUrl?: string,
  options: { lazyAssets?: boolean } = {}
): Promise<RunHandoutArtifact> {
  const compilerDir = getCompilerPath()
  if (!compilerDir) throw new Error('Compiler not found')
  const { source, slideIds, missing } = await runHandoutSource(talk, run, content)
  const slug = outputSlug ?? runHandoutSlug(talk.slug, run.eventTitle ?? 'run', run.plannedDate ?? run.startedAt.slice(0, 10), [])
  const { html, lazyHtml, slides, styles } = await buildRunHandoutHtml(compilerDir, source, { slug, workerBaseUrl: workerBaseUrl ?? '', lazyAssets: options.lazyAssets })
  const path = runHandoutDistPath(talk, slug)
  const distDir = dirname(path)
  if (!existsSync(distDir)) mkdirSync(distDir) // only inside a talk folder that is there (a vanished vault is never re-created)
  writeFileSync(path, html, 'utf8')
  return { path, html, lazyHtml, title: source.title, slug, slideIds, missing,
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
    const resolved = resolvePooledRefs(content, outlinePath)

    const { prepareSource } = await import(pathToFileURL(join(compilerDir, 'lib/08-source-adapters.mjs')).href)
    const model = await withPrewarmYield(() => prepareSource(outlinePath, resolved, slug, stat, undefined, { allowedAssetRoots: assetRootsFor(outlinePath), pictureText: pictureTextForCompile(outlinePath, content) }))
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
// the link is <base>/<id>. The API token is read from the secrets store (secrets-store.ts); the user's
// account/project/domain come from config.json (Settings → Cloudflare). Nothing private is bundled.

function publishSiteDir(): string {
  return resolveSiteDir(app.getPath('userData'), getConfig('publishSiteDir', undefined))
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
// wrangler ships inside the app and runs on the app's own Node (wrangler-launcher.ts); every
// wrangler command in this file goes through the three functions below. `app.getAppPath()` is the
// folder holding the app's node_modules: Resources/app when packaged, the repository otherwise.
// Every command runs in a folder kept for wrangler alone (the launcher clears it of `.env` files
// before each run). It MUST be writable (a packaged app launched from Finder inherits CWD `/`, where
// wrangler cannot create its `./.wrangler/tmp` scratch) and it is never inside the site folder, so
// the scratch is never deployed with what is published.
function wranglerWorkDir(): string {
  return join(app.getPath('userData'), 'wrangler-runs')
}
function wranglerInstall(): WranglerInstall {
  return { execPath: process.execPath, appRoot: app.getAppPath(), platform: process.platform, workDir: wranglerWorkDir() }
}
/** Null when the bundled tool is there; otherwise the message and its Details. */
function wranglerMissing(): WranglerMissing | null {
  const resolved = resolveWranglerLaunch(wranglerInstall(), [])
  return resolved.ok ? null : resolved
}
/**
 * Run one wrangler command to completion, in the folder kept for wrangler runs.
 * `set` is everything this command is given on purpose (the credentials); nothing else in the app's
 * own environment can steer wrangler (wrangler-launcher.ts builds the child's environment).
 */
function runBundledWrangler(
  args: string[], options: { set: Record<string, string>; input?: string },
): Promise<WranglerRun> {
  return runWrangler(wranglerInstall(), args, { inherited: process.env, set: { ...options.set, ...standInCloudflareApi() }, input: options.input })
}
/**
 * Tests only (spec decision D1: environment overrides are for tests and are ignored in a packaged
 * build). A harness (TW_E2E=1, never a packaged app) may point the bundled wrangler at a stand-in
 * Cloudflare API on this computer's own loopback address, so a publish runs to its end with a made-up
 * token and no request leaves the machine (e2e/diagnose-secrets-gate.mjs). Any other address is ignored.
 */
function standInCloudflareApi(): Record<string, string> {
  // The same rule, in the same function, as for the app's own calls to the API (cloudflare-connection.ts).
  const base = standInApiBase(cloudflareTestContext())
  return base ? { CLOUDFLARE_API_BASE_URL: base } : {}
}
/** A message when the site about to be published would make `pages deploy` compile code; else null. */
function pagesBundlingBlock(siteDir: string): string | null {
  return siteFolderOverlap(siteDir) ?? pagesBundlingHazard(siteDir, wranglerWorkDir(), existsSync)
}
// Separate folders (settings-folders.ts): checked again where they are used, as the import rule asks.
// The site folder is uploaded as it is, so it never overlaps the backup folder (talks with their
// notes) and never holds a vault.
function siteFolderOverlap(siteDir: string): string | null {
  const backup = (getConfig('backupFolder', undefined) ?? '').trim()
  const vaultsInside = vaultRegistry.list().filter((v) => folderInside(v.root, siteDir)).map((v) => ({ path: v.root, name: 'a vault' }))
  return separateFolderProblem(siteDir, 'Publishing', [...(backup ? [{ path: expandHomePath(backup), name: 'the backup folder' }] : []), ...vaultsInside])
}
function backupFolderOverlap(folder: string): string | null {
  return separateFolderProblem(expandHomePath(folder.trim()), 'Backing up', [{ path: publishSiteDir(), name: 'the published site folder' }])
}
/**
 * A failed `deploy` or `dev`: when what wrangler printed is esbuild refusing a malformed
 * tsconfig.json, jsconfig.json or package.json in a parent folder, the message that names the file;
 * otherwise `fallback`. Nothing outside the app is read for this (wrangler-failures.ts).
 */
function liveWorkerFailureText(output: string, fallback: string): string {
  const broken = brokenJsonFileInOutput(output, wranglerWorkDir())
  return broken ? blockingFileText(broken.path) : fallback
}
/** One line for a thrown error, where no separate Details field reaches the screen. */
function wranglerMissingText(missing: WranglerMissing): string {
  return `${missing.error}. Details: ${missing.details}`
}

// Slimming the PUBLISHED handout (each file under Cloudflare Pages' 25 MiB limit) is
// handout-slimming.ts: `sharp` on every platform, no program taken from the machine (spec D11).

// A publish's handout pages are built and written in a utility process of its own (handout-pages.ts,
// handout-pages-off-process.ts): a heap of its own, so a heavy talk can never end the app. One process
// for the one job, ended when it answers; a build that dies or takes over 10 minutes fails the publish.
// The parent scopes the whole job so its compiles are visible to the main process's prewarm. A build
// failure rejects as it did in this thread.
const buildHandoutPagesInOwnProcess = createHandoutPagesOffProcess(join(__dirname, 'handout-pages-worker.js'), forkHandoutPagesChild)
function buildHandoutPagesOffThread(job: HandoutPagesJob): Promise<HandoutPagesResult> {
  return withPrewarmYield(() => buildHandoutPagesInOwnProcess(job))
}

// Every upload of the site goes through this one service (handout-publishing.ts): leave to publish
// from the connection, the live service's address or its absence, the pages, the one upload. The
// handlers below supply the pages; they read no token and start no upload themselves.
let handoutPublishingService: HandoutPublishing | null = null
function handoutPublishing(): HandoutPublishing {
  handoutPublishingService ??= createHandoutPublishing({
    siteDir: () => publishSiteDir(),
    authorise: () => cloudflareConnection().authorisePublish(),
    live: async () => (publishRehearsal() ? { baseUrl: getConfig('liveWorkerBaseUrl', undefined) ?? '' } : ensureLiveWorker()),
    toolMissing: () => wranglerMissing(),
    bundlingHazard: (siteDir) => pagesBundlingBlock(siteDir),
    upload: (args, credentials) => runBundledWrangler(args, { set: credentials }),
    rehearsal: () => publishRehearsal(),
  })
  return handoutPublishingService
}
/**
 * Tests only (never a packaged build): with TW_REC_TEST=1 a publish builds its pages and reads them
 * for addresses on this computer, and nothing is asked of Cloudflare or uploaded.
 */
function publishRehearsal(): { project: string } | null {
  if (app.isPackaged || process.env.TW_REC_TEST !== '1') return null
  return { project: getConfig('cfPagesProject', undefined) ?? 'talkweaver-test' }
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

    // The sequence (leave to publish, the live service or its absence, the one upload, what a
    // superseded publish does) is handout-publishing.ts. This supplies the talk's pages: `live` is
    // the only live address they may carry, and it is '' when the live service is not ready.
    const outcome = await handoutPublishing().publish({
      entry: 'talk',
      prepare: async ({ dir: siteDir, project, live, link, redirects }) => {
        const baseUrl = getConfig('publishBaseUrl', undefined)
        const useShortIds = getConfig('publishUseShortIds', false) ?? false
        // ENTRY FIRST: the address every link of this handout starts with is checked before anything is
        // built or written (handout-publishing.ts). An address on this computer stops the publish here.
        const base = link(resolveBase({ baseUrl: baseUrl as string | undefined, project }))
        const slug = basename(outlinePath).replace('-outline.md', '')
        // The talk's folder in the site: by the one function that makes a name a folder there
        // (publishing-logic.ts siteFolder, and never through a link). A name that would not stay inside the site folder is refused here.
        const talkOutDir = writableSiteFolder(siteDir, slug)
        if (!talkOutDir) return { ok: false, error: SITE_FOLDER_REFUSED }
        const resolved = resolvePooledRefs(published, outlinePath)

        // Publish output: each handout
        // folder gets the slimmed handout as <slug>.html PLUS a viewer/landing index.html (Open +
        // Download + QR + short link). The whole accumulating site dir is deployed so prior talks survive.
        // ENTRY FIRST, the rest of it, all in memory before the first file is written: the stable short
        // id (so the viewer page and the redirects carry the final link), the handout's own link (it
        // goes into its pages: the QR code, the venue screen), and the WHOLE redirect file as it will be.
        let id: string | undefined
        let redirectsText: string | null = null
        let registryToKeep: Record<string, string> | null = null
        if (useShortIds) {
          const registry = readHandoutRegistry()
          const recoveredId = recoverIdFromUrl(readHandoutUrl(published), base)
          const gen = (): string => generateShortId((n) => Uint8Array.from(randomBytes(n)))
          const picked = pickShortId({ registry, slug, recoveredId, gen })
          id = picked.id
          registryToKeep = picked.registry
          redirectsText = redirects(buildRedirects(picked.registry, [...new Set([...publishedFolders(siteDir), slug])]))
        }
        const url = link(publishUrl({ base, slug, id, useShortIds }))
        // Checked: from here on things are written.
        if (registryToKeep) writeHandoutRegistry(registryToKeep)
        if (!existsSync(talkOutDir)) mkdirSync(talkOutDir, { recursive: true })

        const { makeQrSvg } = await import(pathToFileURL(join(compilerDir, 'lib/01-cli-utils.mjs')).href)
        const qr = (makeQrSvg(url) as string) || ''
        // The compile, the pages (Download, lazy <slug>.html, the home page, the venue screen) and their
        // slimming and writing run OFF this thread (handout-pages.ts): a heavy handout held it for
        // seconds, and the app showed the beachball. Everything it is handed has been checked above.
        const pagesWritten = await buildHandoutPagesOffThread({
          kind: 'talk', compilerDir, talkOutDir, siteDir, slug, live, url, qr,
          downloadFile: `${slug}-download.html`, handoutFile: `${slug}.html`,
          outlinePath, text: resolved, outline: published, assetRoots: assetRootsFor(outlinePath),
          homeDetails: handoutHomeDetails({ outline: published }),
        })

        // The redirect file, as it was checked before the build began.
        if (redirectsText !== null) writeFileSync(join(siteDir, '_redirects'), redirectsText, 'utf8')
        return { ok: true, built: { url, warnings: pagesWritten.warnings } }
      },
    })
    // A publish that did not go up, or that the connection changed under, records nothing below.
    if (!outcome.ok) {
      return {
        success: false, error: outcome.error,
        ...(outcome.details ? { details: outcome.details } : {}), ...(outcome.notReady ? { notReady: outcome.notReady } : {}),
      }
    }
    const { url, warnings } = outcome.built

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
    return {
      success: true, url, display: url, updatedOutline, ...(warnings.length ? { warning: warnings.join(' ') } : {}),
      // Published without live features (spec D7): the sentence, and what lies behind it for "Details".
      ...(outcome.notice ? { liveNotice: outcome.notice, ...(outcome.noticeDetails ? { liveDetails: outcome.noticeDetails } : {}) } : {}),
      // Handouts an earlier version left with a dead live address: how many, and their names for "Details".
      ...(outcome.earlierNotice ? { earlierNotice: outcome.earlierNotice, ...(outcome.earlierDetails ? { earlierDetails: outcome.earlierDetails } : {}) } : {}),
    }
  } catch (e) {
    console.error('[publish-handout]', e)
    return { success: false, error: String(e) }
  }
})

let localLiveWorker: { process: ChildProcessByStdio<null, Readable, Readable>; baseUrl: string; adminSecret: string } | null = null

function liveWorkerDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'worker') : join(process.cwd(), 'worker')
}
// This computer's admin keys for the live service: slot `live-worker-credentials` of the secrets store
// (live-service-key.ts reads and writes it: one entry per Cloudflare account and Worker, each with
// the computer id made with it; a 0.38.2 blob is read as the `legacy` key of the account Settings
// records). config.json holds only the computer's name: no id, and never a key.
let computerKeyStore: ComputerKeyStore | null = null
function computerKeys(): ComputerKeyStore {
  if (computerKeyStore) return computerKeyStore
  computerKeyStore = createComputerKeyStore({
    // Null only when the slot's file is not there; a file that cannot be read or decrypted throws (SecretsError).
    read: () => secrets().read('live-worker-credentials'),
    // Atomic (secrets-store.ts); refused when the operating system's encryption is unavailable.
    write: (text) => secrets().write('live-worker-credentials', text),
    recorded: () => ({ accountId: getConfig('liveWorkerAccountId', undefined) ?? null, baseUrl: getConfig('liveWorkerBaseUrl', undefined) ?? null, workerName: LIVE_WORKER_NAME }),
    // An unreleased build kept the computer's id in config.json: the store takes that field out when it is made (R5).
    settings: { fields: () => Object.keys(readConfig()), remove: (field) => writeConfig({ [field]: undefined } as Partial<Config>) },
  })
  // A 0.38.2 blob is bound to the account Settings records NOW, before anything can change that record.
  // If this rewrite fails, the store gives no key at all (every read throws) until a rewrite is taken (R9).
  computerKeyStore.migrate()
  return computerKeyStore
}
/** The live service Settings records as set up from here: the only one a stored key is used on outside a set-up. */
function recordedLiveService(): { accountId: string | null; workerName: string; baseUrl: string | null } {
  return { accountId: getConfig('liveWorkerAccountId', undefined) ?? null, workerName: LIVE_WORKER_NAME, baseUrl: getConfig('liveWorkerBaseUrl', undefined)?.replace(/\/+$/, '') || null }
}
/** This computer's key for the recorded live service (its own first), or null. Throws KeyStoreUnreadable. */
function recordedLiveKey(): StoredKey | null {
  return computerKeys().keysFor(recordedLiveService())[0] ?? null
}
/** The name this computer is listed under: the one in Settings, or the host name without `.local`. */
function computerName(): string {
  return computerNameOrNull(getConfig('computerName', undefined)) ?? defaultComputerName(hostname())
}
/** `<account>\n<name>`: what `liveComputerRecordedFor` holds once this computer is on that account's list under that name. */
const computerRecordMark = (accountId: string): string => `${accountId}\n${computerName()}`

// The config `wrangler dev` is given (the local live service, tests and the unpackaged app only) is
// ALWAYS a generated copy in the wrangler-runs folder, never the shipped file: wrangler keeps its
// scratch (`.wrangler/tmp`) beside the config it is given, and the app's own folder must not be
// written to (it is sealed by its signature, and may not be writable at all).
function writeLiveWorkerConfig(baseConfig: string, fileName: string, shareHostname: string | null): string {
  const path = join(wranglerWorkDir(), fileName)
  // Atomic (temp file, fsync, rename): wrangler never reads a half-written config.
  createConfigFile<Record<string, unknown>>(path).replace(
    liveWorkerDeployConfig(readFileSync(baseConfig, 'utf8'), liveWorkerDir(), shareHostname),
  )
  return path
}

// The live service as it ships: compiled when the app was built, never on this computer (ticket 11).
function liveWorkerDistDir(): string {
  return app.isPackaged ? join(process.resourcesPath, WORKER_DIST_DIR) : join(process.cwd(), WORKER_DIST_DIR)
}
/** The shipped files, as bytes; null for one that cannot be read (readShippedFiles: never throws). */
function shippedLiveWorker(): ShippedFiles {
  const dir = liveWorkerDistDir()
  return readShippedFiles((name) => { try { return readFileSync(join(dir, name)) } catch { return null } })
}
// The share-link domain (ticket 07) is per person (each deploys the live service to their own
// account). A stored value that no longer passes isValidShareDomain (edited by hand, or saved before
// that rule existed) counts as none, as sharedTalkLink falls back to the Worker origin for the same reason.
// This is the address the person ASKED for (what Settings' field shows, and what the share-address
// action is asked to attach). No link is built from it: see attachedShareLinkBase (R13).
function liveShareHostname(): string | null {
  const linkBase = getConfig('sharedTalkLinkBase', undefined)
  const hostname = (() => { try { return linkBase ? new URL(linkBase).hostname : null } catch { return null } })()
  return hostname && isValidShareDomain(hostname) ? hostname : null
}
/** Every hostname this computer asked Cloudflare to attach and has not been shown detached (`liveWorkerShareDomains`; live-service-share-domain.ts keeps it). */
function listedShareDomains(): ShareDomainEntry[] {
  return shareDomainEntries(shareDomainRecords()).entries
}
/** config.json's fields for that list: the list itself, and the two fields kept before there was one. */
function shareDomainRecords(): ShareDomainRecords {
  return { liveWorkerShareDomains: getConfig('liveWorkerShareDomains', undefined), liveWorkerShareDomain: getConfig('liveWorkerShareDomain', undefined), liveWorkerShareDomainPrevious: getConfig('liveWorkerShareDomainPrevious', undefined) }
}
/**
 * THE link base of every share link and Run results link (R13): the address this computer's list
 * holds as attached and in use (`shareLinkBase`), or undefined (links then use the live service's
 * workers.dev address). Never the address typed in Settings, which may not be attached.
 */
function attachedShareLinkBase(): string | undefined {
  return shareLinkBase(shareDomainRecords())
}
/** Something for the share-address action to do: an address set, or a hostname this computer asked for that has not been shown detached. */
const shareAddressDue = (): boolean => liveShareHostname() !== null || listedShareDomains().length > 0
function shareDomainPorts(): ShareDomainPorts {
  return {
    authorise: () => cloudflareConnection().authoriseLiveDeploy(),
    fetch: (input, init) => fetch(input, init),
    apiBase: () => cloudflareApiBase(cloudflareTestContext()),
    workerName: LIVE_WORKER_NAME,
    // The list is written before an attach is sent, and an entry leaves it only once it is shown not attached (R11). The two earlier fields go with the first write.
    records: {
      read: () => shareDomainRecords(),
      write: (entries) => writeConfig({ liveWorkerShareDomains: entries, liveWorkerShareDomain: undefined, liveWorkerShareDomainPrevious: undefined }),
    },
  }
}
/**
 * THE share-address action (decision R2), run only because a person set or cleared the share-link
 * address (Settings' Save, the "Use share.<domain>" button, `setup cloudflare share-domain`), or as
 * the tail of a first set-up that made the Worker. It attaches the ONE address set, without
 * displacing anything; and removes the hostnames this computer's own list holds (those it asked
 * Cloudflare to attach before), only once the address set is attached (a new address that is
 * refused leaves the old one in place). One at a time. With no live service set up from this
 * computer for the account in use there is nothing to attach to: nothing is sent.
 */
let shareAddressRun: Promise<ShareDomainResult | null> = Promise.resolve(null)
function applyShareAddress(): Promise<ShareDomainResult | null> {
  const next = shareAddressRun.catch(() => null).then(async (): Promise<ShareDomainResult | null> => {
    const wanted = liveShareHostname()
    const at = cloudflareConnection().status().connection
    const account = at.state === 'connected' ? at.account?.id ?? null : null
    if (!account || !getConfig('liveWorkerBaseUrl', undefined) || getConfig('liveWorkerAccountId', undefined) !== account) return null
    return changeShareAddress(shareDomainPorts(), { wanted })
  })
  shareAddressRun = next
  return next
}

// A set-up or update as the Going live row runs it: the sequence (deployLiveWorker), and then the
// tail of a FIRST set-up (that run made the Worker): a share-link address already set on this
// computer is attached now, if nothing holds it (applyShareAddress). Its failure does not undo the
// set-up: the Share-link domain row says "Not attached yet", and Save tries again.
async function setUpLiveWorker(progress?: (phase: DeployPhase) => void): Promise<LiveDeployResult> {
  const result = await deployLiveWorker(progress)
  if (result.ok && result.created && liveShareHostname()) { try { await applyShareAddress() } catch { /* the row says so */ } }
  return result
}

// The sequence, and every point at which a set-up stops because the token, the account or the site
// changed under it, is live-service-deploy.ts; this supplies what only the app has. It reads neither
// the token nor the account for itself: both come with the authorisation (spec D1). A token found
// not to run the live service is refused there (nothing is redeployed until a sufficient token is
// entered; a service already deployed keeps working with its stored keys, ensureLiveWorker falls
// back to it). No program is started: the shipped bundle is uploaded with Cloudflare's API.
function deployLiveWorker(progress?: (phase: DeployPhase) => void): Promise<LiveDeployResult> {
  return deployLiveService({
    ...(progress ? { progress } : {}),
    shipped: () => shippedLiveWorker(),
    expectedBuild: LIVE_WORKER_VERSION,
    authorise: () => cloudflareConnection().authoriseLiveDeploy(),
    keys: computerKeys(),
    computerName: () => computerName(),
    fetch: (input, init) => fetch(input, init),
    liveFetch: (input, init) => fetch(input, init),
    apiBase: () => cloudflareApiBase(cloudflareTestContext()),
    // With the address, the account it was deployed for: a publish by another account does not publish this address.
    save: ({ baseUrl, accountId, recorded }) => writeConfig({
      liveWorkerBaseUrl: baseUrl, liveWorkerVersion: LIVE_WORKER_VERSION, liveWorkerAccountId: accountId,
      liveComputerRecordedFor: recorded ? computerRecordMark(accountId) : undefined,
    }),
  })
}

async function startLocalLiveWorker(requestedBaseUrl = 'http://127.0.0.1:8787'): Promise<{ baseUrl: string; adminSecret: string }> {
  if (localLiveWorker && !localLiveWorker.process.killed) {
    return { baseUrl: localLiveWorker.baseUrl, adminSecret: localLiveWorker.adminSecret }
  }
  const shippedConfig = join(liveWorkerDir(), 'wrangler.jsonc')
  if (!existsSync(shippedConfig)) throw new Error('Live Worker files are missing from this TalkWeaver installation.')
  // As for a deploy: a generated copy outside the app's folder, so wrangler's scratch is too.
  const config = writeLiveWorkerConfig(shippedConfig, 'live-worker-wrangler.local.jsonc', null)
  const adminSecret = randomBytes(24).toString('base64url')
  const signingSecret = randomBytes(24).toString('base64url')
  const requested = new URL(requestedBaseUrl)
  const port = requested.port || '8787'
  const wranglerState = join(app.getPath('userData'), 'live-worker-local-state')
  const resolved = prepareWranglerRun(wranglerInstall(), [
    'dev', '--config', config, '--ip', '127.0.0.1', '--port', port,
    '--var', `ADMIN_SECRET:${adminSecret}`, '--var', `SESSION_SIGNING_SECRET:${signingSecret}`,
    // A local Worker only: pre-work submissions without cf-connecting-ip share one source (ticket 09).
    '--var', 'PREWORK_LOCAL_SOURCE:1',
    '--persist-to', wranglerState, '--show-interactive-dev-session=false',
  ], { inherited: process.env, set: { WRANGLER_LOG_PATH: join(app.getPath('userData'), 'live-worker-wrangler.log') } })
  if (!resolved.ok) throw new Error(wranglerMissingText(resolved))
  const child = spawn(resolved.launch.command, resolved.launch.args, {
    cwd: resolved.launch.cwd,
    env: resolved.launch.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const baseUrl = await new Promise<string>((resolveStart, rejectStart) => {
    let output = ''
    const timer = setTimeout(() => { child.kill('SIGTERM'); rejectStart(new Error(liveWorkerFailureText(output, `Local live Worker did not start. ${output.slice(-600)}`))) }, 30_000)
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
    child.once('exit', (code) => { clearTimeout(timer); rejectStart(new Error(liveWorkerFailureText(output, `Local live Worker stopped during startup (${code}). ${output.slice(-600)}`))) })
  })
  localLiveWorker = { process: child, baseUrl, adminSecret }
  child.once('exit', () => { if (localLiveWorker?.process === child) localLiveWorker = null })
  return { baseUrl, adminSecret }
}

// Bump whenever worker/ changes so ensureLiveWorker RE-DEPLOYS instead of reusing a stale Worker.
// (Reuse-forever meant the Stage-1 Worker — with no poll handling — kept serving live sessions and
// silently dropped poll.open; a re-deploy is safe: same URL, same reused secrets.)
const LIVE_WORKER_VERSION = LIVE_WORKER_BUILD

/** Decision D8: a live service on this computer's own address, only in an unpackaged build started with TW_LIVE_LOCAL=1. */
function liveLocalAllowed(): boolean {
  return localLiveAllowed({ packaged: app.isPackaged, flag: process.env.TW_LIVE_LOCAL })
}

// The live service's admin secret for the address in Settings: the stored one, or (an unpackaged
// test run only, decision D1) the one handed over in TALKWEAVER_LIVE_ADMIN_SECRET.
function liveAdminSecret(): string | null {
  // Only the key stored FOR the recorded live service (its account, or with none recorded its address).
  const stored = (() => { try { return recordedLiveKey()?.key ?? null } catch { return null } })()
  if (stored) return stored
  const handed = app.isPackaged ? '' : process.env.TALKWEAVER_LIVE_ADMIN_SECRET?.trim()
  return handed || null
}
// The secret a use presents (Go live, a share). With one key held for the recorded live service:
// that one, nothing asked. With two (this computer's own and the 0.38.2 one): the one the live
// service accepts, so a 0.38.2 key that still works is used while this computer's own is not
// registered; "access was removed" is said only when it refuses both.
async function liveAdminSecretToPresent(): Promise<string | null> {
  let held: StoredKey[] = []
  const at = recordedLiveService()
  try { held = computerKeys().keysFor(at) } catch { return liveAdminSecret() }
  if (held.length < 2) return liveAdminSecret()
  return (await keyToPresent({ fetch: (input, init) => fetch(input, init) }, at, held))?.key ?? null
}
// The keys held for the recorded live service, for a request going to ITS address; none for any other
// address (a live service on this computer in a test run), and none when the slot cannot be read.
function liveKeysHeldFor(baseUrl: string): StoredKey[] {
  const at = recordedLiveService()
  if (!at.baseUrl || at.baseUrl !== baseUrl.replace(/\/+$/, '')) return []
  try { return computerKeys().keysFor(at) } catch { return [] }
}
function broadcast(channel: string, value: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    try { if (!win.isDestroyed()) win.webContents.send(channel, value) } catch { /* window closing */ }
  }
}
// Going live and sharing (live-service.ts): whether there is a live service, what to do before
// using it, and its Settings row. This supplies what only the app has: the connection's state, the
// key held here, what Settings records as deployed, the set-up sequence, the lookup and the survey.
let liveServiceInstance: LiveService | null = null
function liveService(): LiveService {
  liveServiceInstance ??= createLiveService({
    facts: () => {
      const status = cloudflareConnection().status()
      const at = status.connection
      const connection = at.state === 'connected' && at.account ? 'connected' : at.state === 'checking' || at.state === 'unreachable' ? 'not-checked' : 'not-connected'
      const configured = getConfig('liveWorkerBaseUrl', undefined)?.replace(/\/+$/, '') || null
      return {
        connection,
        permission: status.liveService.state === 'no-permission' ? 'no-permission' : status.liveService.state === 'not-refused' ? 'not-refused' : 'unknown',
        accountId: at.state === 'connected' ? at.account?.id ?? null : null,
        // The key stored for the recorded live service; with none recorded, for the account in use. A slot
        // that cannot be read is said so, never "none". An unpackaged test run's handed-over secret stands for the first computer's.
        key: ((): KeyKind | 'unreadable' => {
          try {
            const held = configured ? recordedLiveKey() : computerKeys().keysFor({ accountId: at.state === 'connected' ? at.account?.id ?? null : null, workerName: LIVE_WORKER_NAME, baseUrl: null })[0] ?? null
            return held ? keyKind(held) : liveAdminSecret() !== null ? 'legacy' : 'none'
          } catch (error) {
            if (error instanceof KeyStoreUnreadable) return 'unreadable'
            throw error
          }
        })(),
        deployed: { baseUrl: configured, version: getConfig('liveWorkerVersion', undefined) ?? null, accountId: getConfig('liveWorkerAccountId', undefined) ?? null },
        appBuild: LIVE_WORKER_VERSION,
      }
    },
    adminSecret: () => liveAdminSecretToPresent(),
    deploy: (progress) => setUpLiveWorker(progress),
    lookUp: (accountId) => lookUpLiveService({
      shipped: () => shippedLiveWorker(),
      expectedBuild: LIVE_WORKER_VERSION,
      authorise: () => cloudflareConnection().authoriseLiveDeploy(),
      fetch: (input, init) => fetch(input, init),
      apiBase: () => cloudflareApiBase(cloudflareTestContext()),
      accountId,
    }),
    survey: () => surveyLiveService({
      shipped: () => shippedLiveWorker(),
      expectedBuild: LIVE_WORKER_VERSION,
      authorise: () => cloudflareConnection().authoriseLiveDeploy(),
      fetch: (input, init) => fetch(input, init),
      liveFetch: (input, init) => fetch(input, init),
      apiBase: () => cloudflareApiBase(cloudflareTestContext()),
      keys: computerKeys(),
      // On the list once, under its current name: a 0.38.2 computer is recorded (as `legacy`) the first time this build asks.
      record: {
        due: (accountId) => getConfig('liveWorkerAccountId', undefined) === accountId && getConfig('liveComputerRecordedFor', undefined) !== computerRecordMark(accountId),
        name: () => computerName(),
        done: (accountId) => writeConfig({ liveComputerRecordedFor: computerRecordMark(accountId) }),
      },
    }),
    // A Worker deleted in the dashboard: its address, build and account are dropped. The key stays.
    // Reached from cloudflare:check (any window) by design: the caller cannot choose a value, the address is only cleared when the Worker is verifiably gone (Sol review 4, S2, accepted).
    forget: () => writeConfig({ liveWorkerBaseUrl: undefined, liveWorkerVersion: undefined, liveWorkerAccountId: undefined, liveComputerRecordedFor: undefined }),
    onChange: (row: GoingLiveRow) => {
      broadcast('live-service:status', row)
      // `setup cloudflare live` prints its progress from the same rows the window is sent.
      for (const listener of liveRowListeners) { try { listener(row) } catch { /* a listener that has gone */ } }
    },
    tell: (message) => broadcast('live-service:notice', message),
  })
  return liveServiceInstance
}
const liveRowListeners = new Set<(row: GoingLiveRow) => void>()
// Settings → Cloudflare's Going live and sharing row. A row holds states, the live service's address,
// its build and fixed sentences: never a key.
ipcMain.handle('live-service:status', () => liveService().row())
// The set-up deploys the live service and saves its address and keys: Settings configuration, so
// only the Settings window's Cloudflare page (its Going live and sharing row) may ask (Sol review 4,
// S1). Editor, Tools, presenter windows and embedded frames are refused; they open Settings instead.
handleFromSettingsWindow(
  'live-service:set-up',
  () => ({ ok: false, error: 'Going live can be set up only in the Settings window.', details: null, row: liveService().row() }),
  () => liveService().setUp()
)

// Settings → Cloudflare's Share-link domain row: its one button, "Use share.<handout domain>"
// (Dominik, 10 Oct: "definitely want share.handouts.fyi"). The address is the one the row suggests,
// read here from the connection's own status, never taken from the window. Pressing it is the only
// way the suggestion is used: it saves it as the share-link address (`sharedTalkLinkBase`, as
// typing it in Settings does), checks the row again, and when the token was not refused the zone's
// Workers routes and the live service is set up, attaches that one address now (applyShareAddress:
// the live service's code is not touched). A live service not set up yet attaches it at the end of
// its first set-up. Refused routes: saved, nothing attached, and the row says which permission to add.
let shareUse: Promise<CloudflareReply> | null = null
async function useSuggestedShareDomain(): Promise<CloudflareReply> {
  const before = cloudflareConnection().status()
  const offered = before.shareLink
  const host = offered.state === 'none' && !offered.stale ? offered.suggested?.host ?? '' : ''
  if (before.connection.state !== 'connected' || !isValidShareDomain(host)) return { ok: false, error: SHARE_LINK_NOT_NOW, status: before }
  writeConfig({ sharedTalkLinkBase: `https://${host}` })
  liveServiceInstance?.refresh()
  const checked = await cloudflareConnection().settingsChanged()
  if (checked.status.shareLink.state !== 'not-attached' || checked.status.shareLink.host !== host || liveService().row().state !== 'ready') return { ok: true, status: checked.status }
  const attached = await applyShareAddress()
  const after = await cloudflareConnection().check('asked')
  return !attached || attached.ok ? { ok: true, status: after.status } : { ok: false, error: attached.error, status: after.status }
}
// Only from the Settings window's Cloudflare page, where the row is (0.42).
handleFromSettingsWindow(
  'cloudflare:use-share-domain',
  (): CloudflareReply => ({ ok: false, error: 'A share-link address can be set only from TalkWeaver’s Settings window.', status: cloudflareConnection().status() }),
  (): Promise<CloudflareReply> => {
    shareUse ??= useSuggestedShareDomain().finally(() => { shareUse = null })
    return shareUse
  }
)

// Throws a LiveServiceError (a fixed sentence, with Details, and what Go live offers) when there is
// no live service to use. Publishing never calls this directly: handout-publishing.ts does, and turns
// any throw into a handout published without live features (spec D7). Nothing is SET UP here (D9:
// set up on purpose); an update of a service deployed from here is done before it is used.
async function ensureLiveWorker(): Promise<{ baseUrl: string; adminSecret: string; accountId?: string | null }> {
  const configured = getConfig('liveWorkerBaseUrl', undefined)?.replace(/\/+$/, '')
  const local = liveLocalAllowed()
  if (configured) {
    // One rule for "is this address on this computer" (handout-publishing.ts `addressKind`): every spelling of it.
    const where = addressKind(configured)
    if (where === 'not-an-address' || !/^https?:\/\//i.test(configured)) throw new LiveServiceError('not-set-up', LIVE_NOT_SET_UP)
    if (where === 'this-computer') {
      // An address on this computer is a live service for tests only (D8): no phone can reach it.
      if (!local) throw new LiveServiceError('not-set-up', LIVE_NOT_SET_UP)
      // A local Worker someone else already runs (the e2e harness, a developer's wrangler dev) and
      // whose admin secret is handed over explicitly: use it rather than spawning a second one.
      const externalSecret = process.env.TALKWEAVER_LIVE_ADMIN_SECRET?.trim()
      if (externalSecret) return { baseUrl: configured, adminSecret: externalSecret }
      return startLocalLiveWorker(configured)
    }
    return liveService().endpoint()
  }
  if (local) return startLocalLiveWorker()
  // No address on this computer is ever started as a fallback (D8).
  return liveService().endpoint()
}
/**
 * The live service as a request that carries this computer's key needs it (a share, a Run's results
 * link, pre-work; live-admin-request.ts): the key to present, and the keys held for the recorded live
 * service, which are tried in turn only on a request to its recorded address, as Go live does.
 */
async function liveAdminEndpoint(): Promise<AdminEndpoint> {
  const endpoint = await ensureLiveWorker()
  return { baseUrl: endpoint.baseUrl, adminSecret: endpoint.adminSecret, held: { at: recordedLiveService(), keys: liveKeysHeldFor(endpoint.baseUrl) } }
}

// ── Pre-work for a planned Run (feedback-boards ticket 09) ─────────────────────────────────────
// Built lazily (app.getPath needs a ready app); the timer starts once the app is ready.
let runPreworkService: RunPreworkService | null = null
function runPrework(): RunPreworkService {
  runPreworkService ??= createRunPrework({
    registryPath: join(app.getPath('userData'), 'run-prework-registry.json'),
    ownerTokens: ownerTokens(),
    endpoint: () => liveAdminEndpoint(),
    vaultRoot: () => writableVaultRoot() ?? null, // writes: only a vault folder that is there (ticket 07)
    // The timer pulls a Run into the vault its last publish recorded, only while that vault is open and there.
    writableVault: (root) => availableVaults().some((vault) => vault.root === root) ? writableRoot(root, rootFs) : null,
    // Every pull fixes the id of the vault at its root and asks again before writing: a vault replaced at the
    // same folder (removed, another added there) is never written.
    vaultIdAt: (root) => availableVaults().find((vault) => vault.root === root)?.id ?? null,
    fetch,
  })
  return runPreworkService
}

// ── Post-work opens when the session ends (work-files ticket 19) ─────────────────────────────────
// Asked when a live session bound to a Run ends, when a Run is marked or saved as delivered, after a Run
// is published, at launch and every pull cycle. Behind the pre-work flag, as everything it opens.
let postWorkOpenerInstance: PostWorkOpener | null = null
function postWorkOpener(): PostWorkOpener {
  postWorkOpenerInstance ??= createPostWorkOpener({
    service: runPrework(),
    // Each Run in its own vault, only while that vault is open (ticket 19 review): never the writable vault in its place.
    vaults: () => availableVaults().map((vault) => vault.root),
    liveEnded: (talkSlug, runId, vaultRoot) => liveSessions?.endedRun(talkSlug, runId, vaultRoot) ?? false,
  })
  return postWorkOpenerInstance
}
/** Open one Run's post-work, in the vault it belongs to, if it is owed now; in the background, never throws. */
function openPostWorkFor(talkSlug: string, runId: string, vaultRoot: string | null): void {
  void postWorkOpener().open(talkSlug, runId, vaultRoot).then((result) => {
    if (!result.ok) console.warn(`[post-work] not opened: ${result.error}`)
    else if (result.opened) notifyTalkMetaUpdated()
  })
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
    ownerTokens: ownerTokens(),
    endpoint: () => liveAdminEndpoint(),
    linkBase: () => attachedShareLinkBase(),
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
    // In the compiler's one-at-a-time gate until the compile settles (ticket 12): Stop does not wait
    // for it (the push races it against Stop's abort), and the compile stops at its next stage.
    build: ({ outlinePath, content, slug, proposals, signal }) => buildInGate(preparePass, signal, async () => {
      const blocked = unresolvedOutboundFailure(content)
      if (blocked) throw new Error(blocked.error)
      const compilerDir = getCompilerPath()
      if (!compilerDir) throw new Error('Compiler not found.')
      const vaultRoot = vaultRootFor(outlinePath)
      const payload = await buildSharedTalkPayload({
        compilerDir, outlinePath, content, slug, proposals, signal,
        compileContent: resolvePooledRefs(content, outlinePath),
        allowedAssetRoots: assetRootsFor(outlinePath),
        // The talk's vault's personal author first (ticket 04), then Settings.
        ownerName: ownerNameFrom(content, vaultPersonalAuthor(outlinePath) || String(metadataDefaults().author ?? '')),
      })
      // The Worker takes up to 32 MiB per push; slim media only when a deck comes near it.
      return payload.html.length > 24 * 1024 * 1024 ? { ...payload, html: await slimHandoutHtml(payload.html) } : payload
    }),
    // `decide` is the shared-talk module's share_url decision, taken when the write runs (ticket 12).
    stampShareUrl: async (outlinePath, decide) => {
      const written = await writeTalkOutline(outlinePath, (current) => decide(current), 'share-for-comments')
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
function sharedTalkError(error: unknown): { success: false; error: string; setup?: LiveSetupPrompt } {
  // No live service to share with: the sheet offers what Go live offers (spec, "What each user action does").
  const prompt = error instanceof LiveServiceError ? error.prompt : null
  return { success: false, error: error instanceof Error ? error.message : String(error), ...(prompt ? { setup: prompt } : {}) }
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
    // Stopped part-way (ticket 12): neither a link nor a failure.
    if (isSharedTalkStopped(state)) return { success: true, stopped: true, shareId: state.shareId }
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
    // Stopped while the change ran (ticket 12 round 2): no link, as for Share.
    if (isSharedTalkStopped(state)) return { success: true, stopped: true, shareId: state.shareId }
    return { success: true, share: state }
  } catch (error) { return sharedTalkError(error) }
})
ipcMain.handle('shared-talk:update', async (_event, outlinePath: unknown) => {
  const refusal = outlineRefused(outlinePath) // writes beside the outline: refuse one outside the vault
  if (refusal) return { success: false, error: refusal }
  if (typeof outlinePath !== 'string' || !outlinePath) return { success: false, error: 'No talk is open.' }
  try {
    const state = await sharedTalks().update(outlinePath)
    if (isSharedTalkStopped(state)) return { success: true, stopped: true, shareId: state.shareId }
    return { success: true, share: state }
  } catch (error) { return sharedTalkError(error) }
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

// The live address a handout saved on this computer carries ("Export handout", "Save as a file
// instead", a Run's built handout). The address in Settings, unless it is on this computer and local
// live is not allowed (D8); with none, the local test service's address only where that is allowed.
// A packaged build therefore never writes `127.0.0.1` into a handout.
function localHandoutWorkerBaseUrl(): string {
  const configured = getConfig('liveWorkerBaseUrl', undefined)?.replace(/\/+$/, '')
  if (liveLocalAllowed()) return configured || 'http://127.0.0.1:8787'
  return liveAddressForPages(configured)
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
  // The talk's folder in the site, by the one function that makes a name a folder there.
  const talkFolder = siteFolder(siteDir, context.talkSlug)
  if (!talkFolder || !existsSync(join(talkFolder, 'index.html'))) return current.toString()
  const registry = readHandoutRegistry()
  const picked = pickShortId({
    registry,
    slug: context.talkSlug,
    recoveredId: recoverIdFromUrl(current.toString(), base),
    gen: () => generateShortId((n) => Uint8Array.from(randomBytes(n))),
  })
  writeHandoutRegistry(picked.registry)
  const slugs = publishedFolders(siteDir)
  const redirects = buildRedirects(picked.registry, slugs)
  const redirectPath = join(siteDir, '_redirects')
  const currentRedirects = existsSync(redirectPath) ? readFileSync(redirectPath, 'utf8') : ''
  const joinUrl = publishUrl({ base, slug: context.talkSlug, id: picked.id, useShortIds: true })
  if (redirects !== currentRedirects) {
    // An upload of the site like any other (handout-publishing.ts): the same leave, the same one upload.
    const deployed = await handoutPublishing().publish({
      entry: 'live-short-link',
      // ENTRY FIRST: the join link and the whole redirect text are checked before the file is written.
      prepare: async ({ link, redirects: checked }) => { link(joinUrl); writeFileSync(redirectPath, checked(redirects), 'utf8'); return { ok: true, built: null } },
    })
    // The sentence is the message; what the tool printed stays behind Details.
    if (!deployed.ok) throw new LiveServiceError('failed', deployed.error, deployed.details ?? null)
  }
  return joinUrl
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

ipcMain.handle('run:publish-handout', async (_event, payload: { talkSlug: string; runId: string; vaultId?: string }) => {
  try {
    // The selected Run's own vault when the caller names it (the Sessions view does), refused when it is not
    // open; never the first writable vault in its place. Its talk is read from that vault too.
    const named = payload.vaultId !== undefined
    const picked = named ? runVaultFor(payload.vaultId) : { root: writableVaultRoot() }
    if ('error' in picked) return { success: false, error: picked.error }
    const vault = picked.root
    if (!vault) return { success: false, error: 'no-vault' }
    const asked = readRun(vault, String(payload.talkSlug), String(payload.runId))
    const talk = named ? talkInVault(vault, String(payload.talkSlug)) : talkBySlug(String(payload.talkSlug))
    // Feedback-boards ticket 09 (ADR-0032 amendment point 3): a planned Run publishes its handout
    // before the day too, so the link participants get for pre-work is the one the talk will use.
    if (!asked || !talk) return { success: false, error: 'run-not-found' }
    const run = asked
    // The sequence is handout-publishing.ts (as talk:publish-handout). The publish takes its place in
    // the site's queue AT ONCE, before anything is awaited, so that an unpublish asked for after it
    // comes after it; what it needs it reads when its turn begins (`begin`), then supplies the Run's
    // pages: `live` is the only live address they may carry, '' when the live service is not ready.
    // Publish for this run (work-files ticket 16): with pre-work and post-work files attached, the Run's
    // folder holds three pages: the handout (linking to both), `pre-work/` and `post-work/`
    // (run-work-publish.ts). A file that is not ready refuses the publish, with the finding, in `begin`;
    // the pins and the pushes to the Worker happen in `prepare`, with leave to publish.
    let content = ''
    let workPhases: Phase[] = []
    let workWarning: string | undefined
    const outcome = await handoutPublishing().publish({
      entry: 'run',
      begin: async () => {
        // As run:build-handout: the open editor's buffer, flushed through the one writer, is what is published.
        const flushed = await flushTalkForPublish(talk.outlinePath)
        if (!flushed.ok) return { fail: { error: flushed.error } }
        content = flushed.text
        const blocked = unresolvedOutboundFailure(content)
        if (blocked) return { fail: { error: blocked.error, reply: blocked } }
        const current = readRun(vault, asked.talkSlug, asked.id) ?? asked
        const plan = planRunWork(vault, current, (phase) => runPrework().status(talk.slug, current.id, phase, vault))
        if (!plan.ok) return { fail: { error: plan.error } }
        workPhases = plan.phases
        workWarning = plan.warning
        return null
      },
      prepare: async ({ dir: siteDir, project, live: liveWorkerBaseUrl, link, redirects }) => {
        // ENTRY FIRST: the address every link of this handout starts with, checked before anything is built or written.
        const base = link(resolveBase({ baseUrl: getConfig('publishBaseUrl', undefined) ?? (process.env.TW_REC_TEST === '1' ? 'https://mock-run-handouts.test' : undefined), project }))
        // The handouts the site holds: the real names of its own folders (handout-publishing.ts).
        const existing = publishedFolders(siteDir)
        // The Run as it stands now, at this publish's turn: an earlier publish or unpublish may have changed its link.
        const run = readRun(vault, asked.talkSlug, asked.id) ?? asked
        // The Run's folder, decided from the Run's own facts (run-unpublish.ts runSiteFolder, D2): the folder
        // its last publish recorded, when its link names it too; for an older Run, the registry's folder when
        // its link is a registered short id, otherwise the folder its link names. Never a path made from the
        // link, never chosen by what this computer happens to hold. An
        // unpublished Run's folder (its pages "not available", ticket 17) is written back at the same
        // addresses. A recorded folder missing on this computer is written into by that same name, unless
        // another Run recorded it or a publish would not make that name (runPublishFolder, D4). A link that
        // does not name the recorded folder, or a short id given to two folders, refuses before anything is
        // pushed, built or written; an older Run whose folder is not here gets a new one, as a first publish does.
        const bound = runSiteFolder(run, existing, readHandoutRegistry())
        const otherFolders = listRuns(vault).filter((other) => !(other.talkSlug === run.talkSlug && other.id === run.id) && other.handoutUrl && other.handoutFolder).map((other) => other.handoutFolder as string)
        const target = runPublishFolder(siteDir, bound, otherFolders)
        if (target.kind === 'unclear') return { ok: false, error: RUN_FOLDER_UNCLEAR }
        const stableSlug = target.kind === 'same' ? target.name : undefined
        const slug = stableSlug ?? runHandoutSlug(talk.slug, run.eventTitle ?? 'run', run.plannedDate ?? run.startedAt.slice(0, 10), [...existing, ...otherFolders])
        // The Run's folder in the site, by the one function that makes a name a folder there: refused before anything is built or sent.
        const talkOutDir = writableSiteFolder(siteDir, slug)
        if (!talkOutDir) return { ok: false, error: SITE_FOLDER_REFUSED }
        const compilerDir = getCompilerPath()
        if (!compilerDir) return { ok: false, error: 'Compiler not found' }
        // Each attached phase: pinned (its copy is what every later publish uses), compiled and pushed to
        // its object on the Worker, before any page is built. A refusal here writes no page.
        let sentWork: SentWork[] = []
        const warnings: string[] = workWarning ? [workWarning] : []
        if (workPhases.length) {
          const sent = await sendRunWork({ vaultRoot: vault, talkSlug: talk.slug, runId: run.id, phases: workPhases, compilerDir, service: runPrework() })
          if (!sent.ok) return { ok: false, error: sent.error }
          sentWork = sent.sent
          warnings.push(...sent.warnings)
        }
        let preworkWarning: string | undefined = warnings.length ? warnings.join(' ') : undefined
        // What of the Run its deck depends on (its pathway is read from the manifest now); the talk is compiled off this thread, below.
        const runSource = runForHandout(talk, run)
        const handoutFile = `${slug}.html`
        const downloadFile = `${slug}-download.html`
        let redirectsText: string | null = null
        let registryToKeep: Record<string, string> | null = null

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
          registryToKeep = picked.registry
          redirectsText = redirects(buildRedirects(picked.registry, [...new Set([...existing, slug])]))
        }
        const url = link(publishUrl({ base, slug, id, useShortIds }))
        // Checked (ENTRY FIRST): from here on things are written.
        if (registryToKeep) writeHandoutRegistry(registryToKeep)
        if (!existsSync(talkOutDir)) mkdirSync(talkOutDir, { recursive: true })
        const { makeQrSvg } = await import(pathToFileURL(join(compilerDir, 'lib/01-cli-utils.mjs')).href)
        const qr = (makeQrSvg(url) as string) || ''
        // As talk:publish-handout, built and written OFF this thread (handout-pages.ts): the Run's
        // handout (and its copy in the talk's dist/ folder), lazy <slug>.html, the home page (locked
        // design 2026-10-07 "Handout 4b": the day, start time and event in its navy band), the
        // self-contained <slug>-download.html, the venue screen and the 404 page.
        const path = runHandoutDistPath(talk, slug)
        const pagesWritten = await buildHandoutPagesOffThread({
          kind: 'run', compilerDir, talkOutDir, siteDir, slug, live: liveWorkerBaseUrl, url, qr, downloadFile, handoutFile,
          outlinePath: talk.outlinePath, text: resolvePooledRefs(content, talk.outlinePath), defaults: timerSettings() as Record<string, unknown>,
          assetRoots: assetRootsFor(talk.outlinePath), talkSlug: talk.slug, run: runSource, distPath: path,
          // The home page links to the Run's work pages, beside it in its folder; the handout carries no form.
          homeDetails: handoutHomeDetails({ outline: content, run }),
          homePrework: handoutHomePrework(sentWork.find((work) => work.phase === 'pre')?.compiled.form, WORK_PAGE_FOLDER.pre + '/'),
          homePostwork: handoutHomePostwork(sentWork.find((work) => work.phase === 'post')?.compiled.form, WORK_PAGE_FOLDER.post + '/'),
          // Extras for this run (ticket 24): the intro note and links, as the Run reads now; escaped by the compiler.
          homeExtras: run.extras ?? null,
        })
        if (pagesWritten.warnings.length) preworkWarning = [preworkWarning, ...pagesWritten.warnings].filter(Boolean).join(' ')
        // The work pages, in the Run's own folder of the site (a phase the Run no longer has loses its page).
        await writeRunWorkPages({ compilerDir, folder: talkOutDir, sent: sentWork, talkTitle: run.talkTitle || talk.slug, runLine: runLineFor(run), handoutUrl: url })
        if (redirectsText !== null) writeFileSync(join(siteDir, '_redirects'), redirectsText, 'utf8')
        return { ok: true, built: { url, folder: slug, artifact: { path, slideIds: pagesWritten.slideIds ?? [], missing: pagesWritten.missing ?? [] }, preworkWarning, phases: sentWork.map((work) => work.phase) } }
      },
      // The Run's link, the folder it was written to (bound to the Run from now on), and when each phase
      // went out, are kept once the pages are up.
      record: ({ url, folder, phases }) => {
        const current = readRun(vault, asked.talkSlug, asked.id) ?? asked
        persistRun(vault, stampRunWork(setRunHandoutUrl(current, url, folder), phases, 'publishedAt', new Date().toISOString()))
      },
    })
    // A refusal of its first step (an unresolved trigger) is answered exactly as before.
    if (!outcome.ok && outcome.reply) return outcome.reply as { success: false; error: string }
    if (!outcome.ok) {
      return {
        success: false, error: outcome.error,
        ...(outcome.details ? { details: outcome.details } : {}), ...(outcome.notReady ? { notReady: outcome.notReady } : {}),
      }
    }
    const { url, artifact, preworkWarning } = outcome.built
    // A Run published after its session (or published again): its post-work opens now if it is owed (ticket 19).
    openPostWorkFor(asked.talkSlug, asked.id, vault)
    return {
      success: true, url, path: artifact.path, slideIds: artifact.slideIds, missing: artifact.missing, ...(preworkWarning ? { warning: preworkWarning } : {}),
      // Published without live features (spec D7): the sentence, and what lies behind it for "Details".
      ...(outcome.notice ? { liveNotice: outcome.notice, ...(outcome.noticeDetails ? { liveDetails: outcome.noticeDetails } : {}) } : {}),
      // Handouts an earlier version left with a dead live address: how many, and their names for "Details".
      ...(outcome.earlierNotice ? { earlierNotice: outcome.earlierNotice, ...(outcome.earlierDetails ? { earlierDetails: outcome.earlierDetails } : {}) } : {}),
    }
  } catch (cause) {
    return { success: false, error: cause instanceof Error ? cause.message : String(cause) }
  }
})

ipcMain.handle('run:unpublish-handout', async (_event, payload: { talkSlug: string; runId: string; vaultId?: string }) => {
  try {
    // The selected Run's own vault when the caller names it (the Sessions view does), refused when it is not
    // open; never the first writable vault in its place.
    const picked = payload.vaultId !== undefined ? runVaultFor(payload.vaultId) : { root: writableVaultRoot() }
    if ('error' in picked) return { success: false, error: picked.error }
    const vault = picked.root
    if (!vault) return { success: false, error: 'no-vault' }
    const asked = readRun(vault, String(payload.talkSlug), String(payload.runId))
    if (!asked) return { success: false, error: 'run-not-found' }
    // EVERY unpublish takes its turn in the site's queue, and reads the Run when its turn begins: asked
    // for while a publish of the same Run is still going up, it finds the link (and the work phases) that
    // publish recorded, and the Run ends unpublished. What it does is run-unpublish.ts: for a Run whose
    // pre-work or post-work went out (work-files ticket 17), each phase is withdrawn on the Worker and
    // every page of the Run's folder becomes "This page is not available" at the same address; for a
    // Run with its handout only, the folder is taken out of the site, as Unpublish Run handout always
    // did. Answers stay on the Run. (handout-publishing.ts: pages change only with leave to publish,
    // and the Run is written only once the site without them is up.)
    const outcome = await handoutPublishing().publish({
      entry: 'run-unpublish',
      ...runUnpublishJob({
        run: () => readRun(vault, asked.talkSlug, asked.id) ?? asked,
        siteExists: () => existsSync(publishSiteDir()),
        readRegistry: readHandoutRegistry,
        writeRegistry: writeHandoutRegistry,
        notAvailablePage: async () => {
          const compilerDir = getCompilerPath()
          if (!compilerDir) throw new Error('Compiler not found')
          return buildNotAvailablePage(compilerDir)
        },
        service: runPrework(),
        // The Run's own vault's objects (issue 256): never the same talk and Run id in another vault.
        vaultRoot: vault,
        persist: (run) => { persistRun(vault, run) },
      }),
    })
    if (!outcome.ok) {
      return {
        success: false, error: outcome.error,
        ...(outcome.details ? { details: outcome.details } : {}), ...(outcome.notReady ? { notReady: outcome.notReady } : {}),
      }
    }
    return { success: true }
  } catch (cause) {
    return { success: false, error: cause instanceof Error ? cause.message : String(cause) }
  }
})

// Published pages (work-files ticket 22): what the list reads, and what the talk-handout unpublish checks
// a talk's folder against (every Run's and every other talk's link, in every open vault).
function publishedPagesDeps(): PublishedPagesDeps {
  return {
    // Every open vault: an unavailable one is not scanned but counted as unreadable (review round 3).
    vaults: () => openVaults(vaultRegistry.list(), (id) => vaultAvailability.isUnavailable(id)),
    // A fresh walk (scanTalks), not the cached list: the cache can come from the vault index, which leaves out an
    // outline it cannot read, and an unreadable outline must be counted (review round 2), never missed.
    talks: (root) => scanTalks(root).map((talk) => ({ slug: talk.slug, title: talk.title, outlinePath: talk.outlinePath })),
    readOutline: (outlinePath) => { try { return readFileSync(outlinePath, 'utf8') } catch { return null } },
    siteDir: () => publishSiteDir(),
    readRegistry: readHandoutRegistry,
    sentPhases: (run, root) => sentPhases(runPrework(), run, root),
  }
}

ipcMain.handle('published:unpublish-talk', async (_event, payload: { vaultId: string; outline: string }) => {
  try {
    // The talk's own vault, named by the caller, refused when it is not open; never the first writable vault.
    if (typeof payload?.vaultId !== 'string') return { success: false, error: TALK_NOT_FOUND }
    const picked = runVaultFor(payload.vaultId)
    if ('error' in picked) return { success: false, error: picked.error }
    const vault = picked.root
    if (!vault) return { success: false, error: TALK_NOT_FOUND }
    const vaultId = payload.vaultId
    // The talk is named by its OUTLINE, relative to the vault's folder (two outlines of one vault may share a
    // slug): inside the vault (the outline guard: this writes the outline), one of its talks, its slug its own.
    const located = talkByOutline(vault, payload?.outline, findTalks(vault), (outlinePath) => outlineRefusal(vault, outlinePath))
    if (!located.ok) return { success: false, error: located.error }
    const outlinePath = located.talk.outlinePath
    const slug = located.talk.slug
    // EVERY unpublish takes its turn in the site's queue and reads the talk when its turn begins (a publish
    // of the same talk asked for before it has recorded its link by then). What it does is
    // talk-unpublish.ts: the talk's own folder, decided from its slug and link and checked against every
    // other page's, leaves the site; the site goes up without it; only then is `handout_url` taken out of
    // the talk through the one outline writer. Run handouts are other folders and are not touched.
    const outcome = await handoutPublishing().publish({
      entry: 'talk-unpublish',
      ...talkUnpublishJob({
        talk: async () => {
          // At the job's turn, against a fresh walk of the vault (not the cached list): the same outline, still
          // inside the vault, and still the only outline of its slug (one added while this waited is refused).
          const now = talkByOutline(vault, payload.outline, scanTalks(vault), (path) => outlineRefusal(vault, path))
          if (!now.ok) return now.error === TALK_NOT_FOUND ? null : { error: now.error }
          if (now.talk.outlinePath !== outlinePath) return null
          return { slug, handoutUrl: readHandoutUrl(await readTalkOutline(outlinePath)) }
        },
        siteExists: () => existsSync(publishSiteDir()),
        readRegistry: readHandoutRegistry,
        writeRegistry: writeHandoutRegistry,
        // Every other page's claim, read at the job's turn from a fresh walk of each vault; talks that cannot be read refuse it.
        claims: () => siteClaims(publishedPagesDeps(), { vaultId, outlinePath }),
        clearLink: async () => {
          const written = await writeTalkOutline(outlinePath, (current) => editFrontmatterText(current, [{ key: 'handout_url', value: null }]), 'unpublish-handout')
          if (!written.ok) return { ok: false, error: written.error }
          // A spelling the editor does not take (`handout_url :`) would still be read as the link: said, not hidden.
          if (readHandoutUrl(written.text)) return { ok: false, error: 'its handout_url line is not one this app can change' }
          return { ok: true }
        },
      }),
    })
    if (!outcome.ok) {
      return {
        success: false, error: outcome.error,
        ...(outcome.details ? { details: outcome.details } : {}), ...(outcome.notReady ? { notReady: outcome.notReady } : {}),
      }
    }
    if (outcome.built.way === 'removed') notifyTalkMetaUpdated()
    if (outcome.built.way === 'removed' && !outcome.built.linkCleared) return { success: false, error: talkLinkNotCleared(outcome.built.linkError ?? '') }
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
  progress?: (map: Record<string, string>) => void
  /** The media contract this lane compiles under; part of the prepared-cache identity. */
  mediaOptions?: Record<string, unknown>
}

const latestThumbnailRequest = createLatestThumbnailRequestHandler(
  ({ outlinePath, content, mediaOptions }: ThumbnailRequest) =>
    prepareTalk(outlinePath, content, undefined, mediaOptions),
  async (input, prepared, owner, isCurrent): Promise<Record<string, string> | null> => {
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
    const documentId = thumbnailDocumentId(fullHtml, prepared.previewKey)
    const slides = thumbnailSlides(rows, documentId)
    const cacheDir = talkThumbCacheDir(input.outlinePath, slug)
    const vaultId = vaultIdOf(input.outlinePath)
    let rendered: Record<string, string> = {}
    try {
      rendered = await renderThumbnails({
        fullHtml, deckKey: prepared.previewKey, slides, cacheDir, requestKey: `editor:${owner}`,
        onProgress: input.progress ? (pictures) => {
          if (!isCurrent()) return
          const map: Record<string, string> = {}
          for (const key of Object.keys(pictures)) map[key] = thumbUrl(slug, basename(pictures[key], '.png'), vaultId)
          input.progress?.(map)
        } : undefined
      })
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
ipcMain.handle('talk:thumbnails', async (_event, outlinePath: string, content: string, opts?: { lane?: string; requestId?: string }) => {
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
    const requestId = typeof opts?.requestId === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(opts.requestId) ? opts.requestId : null
    const progress = requestId ? (thumbnails: Record<string, string>): void => {
      if (!_event.sender.isDestroyed()) _event.sender.send('talk:thumbnail-progress', { outlinePath, requestId, thumbnails })
    } : undefined
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

function readSidecarIn(vaultRoot: string | undefined, id: string): AssetSidecar | null {
  const target = assetSidecarPath(vaultRoot, id)
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
function readAssetSidecar(id: string): AssetSidecar | null {
  return readSidecarIn(currentVaultRoot(), id)
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
ipcMain.handle('abstract:read', (_event, talkPath: string) =>
  readAbstract(vaultRootFor(talkPath), talkPath)
)

ipcMain.handle('abstract:write', (_event, talkPath: string, raw: string): boolean => {
  const vaultRoot = writableRootFor(talkPath)
  if (!vaultRoot) return false
  return writeAbstract(vaultRoot, talkPath, raw)
})

// ── Research folder (knowledge step two) ─────────────────────────────────────
// The sheet and the agent reach the same verb (agent-verbs.ts RESEARCH_CAPTURE_VERB): scout writes the
// file; main only checks the talk folder is inside the vault that holds it. Never throws: the sheet
// shows the error message.
let researchLogFile: ((message: string) => void) | null = null
const researchLog = (message: string): void => {
  try { researchLogFile ??= createAppendLog(join(app.getPath('userData'), 'tw-research.log')); researchLogFile(message) } catch { /* logging must never fail a capture */ }
}
const researchUsageControllers = new Map<string, AbortController>()
ipcMain.on('research:cancel-usage', (event, requestId: unknown) => {
  if (typeof requestId === 'string') researchUsageControllers.get(`${event.sender.id}:${requestId}`)?.abort()
})
for (const [channel, verb] of [['research:list', 'research.list'], ['research:where-used', 'research.whereUsed'], ['research:search', 'research.search']] as const) {
  ipcMain.handle(channel, async (event, input: unknown) => {
    const requestId = input && typeof input === 'object' && 'requestId' in input ? input.requestId : undefined
    const key = typeof requestId === 'string' && requestId.length <= 128 ? `${event.sender.id}:${requestId}` : null
    const controller = new AbortController()
    if (key) { researchUsageControllers.get(key)?.abort(); researchUsageControllers.set(key, controller) }
    const destroyed = (): void => controller.abort()
    event.sender.once('destroyed', destroyed)
    try {
      return await researchReadHandler(verb, input, {
        signal: controller.signal,
        vaultRootFor: (dir) => availableVaults().find(v => pathStaysInside(v.root, dir) !== null)?.root ?? null,
        vaultRoots: availableVaults().map(v => v.root), log: researchLog
      })
    } finally {
      event.sender.removeListener('destroyed', destroyed)
      if (key && researchUsageControllers.get(key) === controller) researchUsageControllers.delete(key)
    }
  })
}
ipcMain.handle('research:destinations', () => researchDestinations({ vaultRoot: null, vaultRoots: availableVaults().map(v => v.root) }))
ipcMain.handle('research:write', async (event, op: unknown, input: unknown) => {
  if (typeof op !== 'string') return { ok: false, error: { code: 'invalid-input', message: 'Choose a research action.' } }
  const editor = editorWindows.get(event.sender.id)
  if (!editor?.outlinePath) return { ok: false, error: { code: 'not-open', message: 'Open a talk first.' } }
  const outlinePath = editor.outlinePath
  return researchWriteHandler(op, input, {
    vaultRoot: null, vaultRoots: availableVaults().map(v => v.root), log: researchLog,
    activeTalkDir: () => editor.outlinePath === outlinePath ? dirname(outlinePath) : null,
    trash: file => shell.trashItem(file),
    insertResearch: async (file, slide) => {
      if (editor.outlinePath !== outlinePath) return { ok: false, error: { code: 'not-open', message: 'The active talk changed. The copy was kept.' } }
      const reply = await requestEditorDocument(editor.win, { kind: 'research-insert', outlinePath, file, slide })
      return reply?.ok ? { ok: true } : { ok: false, error: { code: 'insert-failed', message: reply && !reply.ok ? reply.error : 'The editor did not answer. The copy was kept.' } }
    }
  })
})
ipcMain.handle('research:insert', async (event, input: unknown, slide: unknown) => {
  const editor = editorWindows.get(event.sender.id)
  if (!editor?.outlinePath) return { ok: false, error: { code: 'not-open', message: 'Open a talk first.' } }
  const outlinePath = editor.outlinePath
  return (slide === true ? RESEARCH_MAKE_SLIDE_VERB : RESEARCH_INSERT_VERB).run(input, {
    vaultRoot: null, vaultRoots: availableVaults().map(v => v.root),
    activeTalkDir: () => editor.outlinePath === outlinePath ? dirname(outlinePath) : null,
    insertResearch: async (file, makeSlide) => {
      const reply = await requestEditorDocument(editor.win, { kind: 'research-insert', outlinePath, file, slide: makeSlide })
      return reply?.ok ? { ok: true } : { ok: false, error: { code: 'insert-failed', message: reply && !reply.ok ? reply.error : 'The editor did not answer. Try again.' } }
    }
  })
})
ipcMain.handle('research:reveal-source', (_event, input: unknown) => revealResearchSource(input, {
  vaultRoot: null, vaultRoots: availableVaults().map(v => v.root), log: researchLog,
  reveal: (file) => { if (!E2E) shell.showItemInFolder(file) }
}))
ipcMain.handle('research:capture', (_event, input: unknown) =>
  researchCaptureHandler(input, { vaultRootFor: (dir) => vaultRootFor(dir) ?? null, log: researchLog })
)
ipcMain.handle('research:reveal-folder', (_event, talkDir: unknown) =>
  researchRevealHandler(talkDir, {
    vaultRootFor: (dir) => vaultRootFor(dir) ?? null,
    reveal: (path) => { if (!E2E) shell.showItemInFolder(path) }
  })
)

// ── Slide Scratchpad (scratchpad-ipc.ts): the open talk's scratch folder; agent files read-only ─────────
// An agent's HTML page is previewed through twpresent://preview/… from its own small store, so it never
// pushes a deck's preview out of slidePreviewStore.
const scratchpadPreviewStore = createSlidePreviewStore(6)
const scratchpadHtmlPreview = createScratchpadHtmlPreviews({ compilerDir: () => getCompilerPath(), store: scratchpadPreviewStore })
const scratchpadHtmlThumbs = createHtmlThumbnailer({
  cacheDir: join(app.getPath('userData'), 'cache', 'scratchpad-html-thumbs'),
  preview: scratchpadHtmlPreview,
  capture: createHtmlCapture({ store: scratchpadPreviewStore })
})
const scratchpadIpc = registerScratchpadIpc({
  ipc: ipcMain,
  outlinePathFor: (event) => editorWindows.get(event.sender.id)?.outlinePath ?? null,
  // A picture or SVG loads in an <img> through the existing twfile:// path (guarded to the vault root).
  storeOptions: {
    fileUrlFor: (absolutePath) => `twfile://f/${Buffer.from(absolutePath, 'utf8').toString('base64url')}`,
    renderedTextFor: (absolutePath) => scratchpadHtmlThumbs.textFor(absolutePath)
  },
  htmlPreview: scratchpadHtmlPreview,
  // Thumbnails of agent HTML pages: captured once in a hidden window, cached in userData (never in the talk).
  htmlThumb: scratchpadHtmlThumbs,
  htmlText: (path) => scratchpadHtmlThumbs.textFor(path),
  revealFolder: (folder) => {
    try { mkdirSync(folder, { recursive: true }) } catch { /* the reveal below says nothing then */ }
    if (!E2E) shell.showItemInFolder(folder)
  },
  // Insert visual only (ticket 2): a picture through the image drawer's pool import (a lookup that answers this one
  // file only), an SVG or a page through Insert › HTML page…'s checked copy into the talk's assets folder.
  importVisual: createScratchVisualImporter({
    importPicture: (path, outlinePath, provenance) => importImageForTalk(
      { ...imageImportDeps, fileFor: async (asked) => (asked === path ? { absPath: path, provenance } : null) }, path, outlinePath),
    copyIntoAssets: async (path, outlinePath, kind) => {
      const root = writableTalkRoot(outlinePath)
      if (!root) return { ok: false, reason: 'vault-unavailable', message: HTML_PAGE_TEXT.vaultUnavailable }
      return importHtmlPage({ root, outlinePath }, path, htmlPageRunImport, undefined, undefined, { kind, alwaysCopy: true })
    }
  }),
  slideSource: (slide, outlinePath) => {
    const holding = vaultRegistry.resolve(outlinePath)?.vault.root
    const own = slide.vaultId ? vaultRegistry.get(slide.vaultId) : null
    const roots = [holding, own?.open ? own.root : undefined, currentVaultRoot()].filter((r): r is string => typeof r === 'string' && r !== '')
    const source = slideSourceOutline(slide, roots)
    if (!source) return null
    const hit = vaultRegistry.resolve(source)
    return { outlinePath: source, root: hit && hit.vault.open && vaultAvailable(hit.vault) ? hit.vault.root : null }
  }
})
app.on('before-quit', () => scratchpadIpc.closeAll())

// ── Per-item icon override (ADR-0021 icon picker) ────────────────────────────
// Pin (or clear, iconKey=null) the icon on ONE top-level list item of a slide, by writing the
// canonical `{icon=KEY}` token at the end of that bullet's line. Operates on the renderer's LIVE
// in-memory `content` (not the on-disk file, which lags behind a debounced autosave) and returns
// the rewritten text; the renderer then drives onContentChange → autosave so the file syncs. The
// item is addressed by its 1-based line (`itemLine`, what the editor knows) and the heading line of
// its slide, which the verb checks against the slide that holds the line. There is no other
// address on this route: a call without a whole-number line or without a heading line is answered
// as null and nothing is read (an item number counted by the editor can name another row than the
// caret's, so the route does not take one). The verb finds the
// item on the compiler's own reading, checks its edit by compiling and refuses otherwise
// (compiler/scripts/lib/outline-list-item-icon.mjs, issue #120): a refusal is logged with its
// reason and answered as null, and the renderer leaves its buffer alone.
ipcMain.handle(
  'outline:set-item-icon',
  async (
    _event,
    content: string,
    slideHeading: unknown,
    iconKey: string | null,
    itemLine: unknown
  ) => {
    if (typeof itemLine !== 'number' || !Number.isInteger(itemLine) || typeof slideHeading !== 'string') return null
    const compilerDir = getCompilerPath()
    if (!compilerDir) return null
    try {
      const { setListItemIcon } = await import(
        pathToFileURL(join(compilerDir, 'lib/12-outline-edit.mjs')).href
      )
      const result = setListItemIcon(content, { heading: slideHeading }, { line: itemLine }, iconKey)
      if (!result.ok) {
        console.error('[outline:set-item-icon] refused:', result.reason)
        return null
      }
      return result.text
    } catch (e) {
      console.error('[outline:set-item-icon]', e)
      return null
    }
  }
)

// ── Title icon and paragraph icon (plain view ticket 07) ─────────────────────
// The renderer's LIVE buffer in, the verb's own result out, unaltered: { ok: true, text, changed }
// or a refusal { ok: false, text (the buffer as given), reason } the renderer can show (null only
// when the compiler is missing or the verb threw). The verbs check their edit by compiling and
// refuse otherwise (12-outline-edit.mjs setHeadingIcon / setParagraphIcon). Nothing is written
// here: the renderer applies `text` to its buffer when `ok && changed`, and autosave writes the file.
ipcMain.handle(
  'outline:set-heading-icon',
  async (_event, content: string, slideHeading: string, slideOccurrence: number, iconKey: string | null) => {
    const compilerDir = getCompilerPath()
    if (!compilerDir) return null
    try {
      const { setHeadingIcon } = await import(
        pathToFileURL(join(compilerDir, 'lib/12-outline-edit.mjs')).href
      )
      // The verb renders the target slide to see whether its title is painted. A slide that holds
      // an SVG fence needs the compiler's sanitiser, which loads asynchronously; the verb is not.
      const { loadCompilerSvgSanitiser } = await import(
        pathToFileURL(join(compilerDir, 'lib/06-block-renderers.mjs')).href
      )
      await loadCompilerSvgSanitiser()
      return setHeadingIcon(content, { heading: slideHeading, occurrence: slideOccurrence || 1 }, iconKey)
    } catch (e) {
      console.error('[outline:set-heading-icon]', e)
      return null
    }
  }
)
ipcMain.handle(
  'outline:set-paragraph-icon',
  async (
    _event,
    content: string,
    line: number,
    iconKey: string | null
  ) => {
    const compilerDir = getCompilerPath()
    if (!compilerDir) return null
    try {
      const { setParagraphIcon } = await import(
        pathToFileURL(join(compilerDir, 'lib/12-outline-edit.mjs')).href
      )
      return setParagraphIcon(content, line, iconKey)
    } catch (e) {
      console.error('[outline:set-paragraph-icon]', e)
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

ipcMain.handle('history:instant-anchors', async (_event, payload: { talkSlug?: unknown; runId?: unknown; home?: unknown }) => {
  if (payload?.home === null) return {}
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
ipcMain.handle('history:feedback-slides', async (_event, payload: { talkSlug?: unknown; runId?: unknown; home?: unknown }) => {
  if (payload?.home === null) return {}
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

ipcMain.handle('history:add-instant-slide', async (_event, payload: { talkSlug?: unknown; runId?: unknown; home?: unknown; entryId?: unknown }) => {
  if (payload?.home === null) return { ok: false, error: 'This action requires a Run in an open vault.' }
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
      if (name.startsWith('.') || name.startsWith('_') || name.toLowerCase() === 'research' || SKIP.has(name)) continue
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
// The path comes from the renderer: only a folder or a document inside an open vault, never an app,
// installer or script (shell-path-policy.ts).
const openVaultRoots = (): string[] => vaultRegistry.list().filter((v) => v.open).map((v) => v.root)
ipcMain.handle('shell:open-path', async (_event, path: string): Promise<boolean> => {
  try {
    const target = decideShellPath('open', path, openVaultRoots())
    if (!target.ok) { console.error('[shell:open-path] refused', target.reason, String(path).slice(0, 300)); return false }
    const err = await shell.openPath(target.path)
    return err === ''
  } catch (e) {
    console.error('[shell:open-path]', e)
    return false
  }
})

// Reveal a file in Finder (select it in its folder) — for "I want to copy the file, not view it".
ipcMain.handle('shell:show-item-in-folder', async (_event, path: string): Promise<boolean> => {
  try {
    const target = decideShellPath('reveal', path, openVaultRoots())
    if (!target.ok) { console.error('[shell:show-item-in-folder] refused', target.reason, String(path).slice(0, 300)); return false }
    shell.showItemInFolder(target.path)
    return true
  } catch (e) {
    console.error('[shell:show-item-in-folder]', e)
    return false
  }
})

// Open an external URL (e.g. the published handout link) in the default browser.
ipcMain.handle('shell:open-external', async (_event, url: string): Promise<boolean> => {
  try {
    // The editor's own links (the published handout, the share link, an embed's source, a Run's
    // handout). Some of these strings come from a talk or a Run record, so the link is parsed once
    // and handed out as that parsed object's normalised href: web links only (hand-out.ts).
    const link = handOutLink(url)
    if (!link || link.kind !== 'web') { console.error('[shell:open-external] refused', String(url).slice(0, 200)); return false }
    if (E2E) { console.log('[shell:open-external] external (E2E):', link.href); return true }
    await shell.openExternal(link.href)
    return true
  } catch (e) {
    console.error('[shell:open-external]', e)
    return false
  }
})

// ── Image search + import (read-only, ADR-0019 / ADR-0026; one seam, ticket 10) ──────────
// src/main/image-search/ holds the seam: SlideWell's shared store when it is on disk (screenshots,
// added images, talk images and old-PowerPoint images, picture matches while SlideWell runs), else
// the old-PowerPoint archive alone, exactly as before. Both are read through the system sqlite3
// binary, read-only. Thumbnails go through the twarchive:// scheme (registered below in whenReady),
// which serves only files the seam vouches for. Importing copies the bytes into the CURRENT
// vault's _assets, content-addressed exactly like asset:paste-image, with a provenance sidecar.
// Under E2E the SlideWell store is never read (tests must not see this Mac's own SlideWell).

function detectArchiveRoot(): string | null {
  const root = getConfig('archiveRoot', undefined) ?? null
  if (!root) return null
  return existsSync(join(root, 'registry', 'media.db')) ? root : null
}

// Guard: resolve symlinks where possible and require the path to sit inside the root.
function isInsideArchive(absPath: string, archiveRoot: string): boolean {
  return isInsideRoot(absPath, archiveRoot)
}

const archiveImageProvider = createArchiveProvider({ archiveRoot: detectArchiveRoot, sqlite3: detectSqlite3 })
const imageSearch = createImageSearch({
  archive: archiveImageProvider,
  slidewell: E2E
    ? null
    : createSlideWellProvider({
        location: () => locateSlideWell(),
        archive: archiveImageProvider,
        sqlite3: detectSqlite3,
        vaultRoots: () => [...new Set([currentVaultRoot(), ...openVaultRoots()].filter((r): r is string => Boolean(r)))]
      })
})

ipcMain.handle('images:status', async (): Promise<ImageSearchStatus> => imageSearch.status())

ipcMain.handle('images:search', async (_event, query: string, opts?: { match?: MatchMode }): Promise<ImageSearchResult | null> => {
  const match = opts?.match === 'words' || opts?.match === 'meaning' ? opts.match : 'both'
  try {
    return await imageSearch.search(typeof query === 'string' ? query : '', { match })
  } catch (e) {
    console.error('[images:search]', e)
    return null
  }
})

/** `images:search-vault` (query): the pictures in the `_assets` of every open vault (image-search/vault-pictures.ts).
 *  Nothing is stored; the answer is kept in memory for a few seconds. The query is a string of at most
 *  MAX_VAULT_QUERY characters, else nothing is searched. */
const vaultPictures = createVaultPictureSearch({
  vaults: () => availableVaults().map((v) => ({ id: v.id, root: v.root, name: basename(v.root) })),
  readSidecar: (vaultRoot, id) => readSidecarIn(vaultRoot, id),
  talks: (vaultRoot) => findTalks(vaultRoot).map((t) => ({ title: t.title, outlinePath: t.outlinePath }))
})

ipcMain.handle('images:search-vault', async (_event, query: unknown): Promise<VaultPictureResult | null> => {
  if (typeof query !== 'string' || query.length > MAX_VAULT_QUERY) return null
  try {
    return vaultPictures.search(query)
  } catch (e) {
    console.error('[images:search-vault]', e)
    return null
  }
})

/** `images:import` (thumbUrl, talkPath): a search hit copied into the _assets of the vault holding the named
 *  talk (image-search/image-import.ts). The vault is worked out here from the talk path through the vault
 *  registry, as for a talk's other writes (writableTalkRoot), but a path in no open vault is refused, never
 *  sent to the current vault. */
const imageImportDeps: ImageImportDeps = {
  // A picture of a vault (the In your talks tab) or one the search seam vouches for.
  fileFor: async (thumbUrlOrPath) => (await vaultPictures.fileFor(thumbUrlOrPath)) ?? imageSearch.fileFor(thumbUrlOrPath),
  vaultRootForTalk: (talkPath) => talkVaultWriteRoot(vaultRegistry, talkPath, (vault) =>
    vaultAvailable(vaultRegistry.get(vault.id)) ? writableRoot(vault.root, rootFs) ?? undefined : undefined),
  warn: (message) => console.warn(message)
}

ipcMain.handle('images:import', async (_event, thumbUrl: unknown, talkPath: unknown): Promise<ImportedImage | null> =>
  importImageForTalk(imageImportDeps, thumbUrl, talkPath)
)

// ── `setup` (ticket 07, spec D14): the same operations as the window, with no window ─────────────

/** The Importer's slide-pictures row: the same discovery and the same words as the Importer (D17). */
async function importerRow(): Promise<ImporterRow> {
  const available = process.platform === 'darwin'
  const renderer = await discoverRenderer()
  const notice = rendererNotice(renderer)
  return {
    state: notice.showPointer ? 'not-available' : renderer.status === 'ready' ? 'ready' : 'unknown',
    available,
    pointer: notice.showPointer ? PPT_EXTRACTOR_POINTER : null,
    url: notice.showPointer ? PPT_EXTRACTOR_URL : null,
  }
}

/** Run the one setup command and exit with its code. Nothing here opens a window. The process holds
 *  the single-instance lock (top of this file) until it exits. */
async function runSetupCommand(args: string[]): Promise<void> {
  app.dock?.hide()
  const write = (stream: NodeJS.WriteStream, line: string): void => { try { stream.write(`${line}\n`) } catch { /* the reader has gone */ } }
  // The preferences setup reads and writes (the recording endpoint and bucket, the publishing fields)
  // live in the settings store: it is opened after the migration, as the app opens it, and every
  // readConfig / writeConfig below goes through it (Sol review 1, #6). Never config.json's old copies.
  // runWithSettings (settings-open.ts, Sol review 2) refuses a store that did not open or may not be
  // used (a newer version's file, another app's, a damaged one) with "Nothing was done.", and fails
  // the command when a preference it wrote was not saved.
  const code = await runWithSettings(
    () => openSettings({
      dir: app.getPath('userData'),
      appVersion: app.getVersion(),
      file: { read: () => configFile().read() as Record<string, unknown>, write: (patch) => configFile().write(patch as Partial<Config>) },
      watch: false,
      log: (line) => write(process.stderr, line)
    }),
    async (opened) => {
      settingsOverlay = opened.overlay
      const ops = createSetupOperations({
        connection: cloudflareConnection(),
        liveService: liveService(),
        recording: recordingStorage(),
        transcription: transcriptionSetup(),
        importer: importerRow,
        publishSettings: { read: publishSettings, apply: applyPublishSettings },
        recordingSettings: { read: recordingSettings, apply: applyRecordingSettings },
        watchLiveRow: (listener) => { liveRowListeners.add(listener); return () => { liveRowListeners.delete(listener) } },
        applyShareAddress: () => applyShareAddress(),
      })
      return runSetup(args, {
        out: (line) => write(process.stdout, line),
        err: (line) => write(process.stderr, line),
        readSecret: (prompts, pipeHint) => readSecretInput(process.stdin, process.stderr, prompts, pipeHint),
      }, ops, {
        // A test harness's S3 stand-in on loopback, accepted as the recording endpoint under the same
        // three conditions as the Cloudflare API override: unpackaged, TW_E2E=1, and named exactly.
        testEndpoint: !app.isPackaged && E2E ? process.env.TW_E2E_RECORDING_ENDPOINT ?? null : null,
      })
    },
    (line) => write(process.stderr, line)
  )
  settingsOverlay = null
  // A test harness may confirm that the command opened no window (an unpackaged test run only).
  if (E2E && !app.isPackaged) write(process.stderr, `[setup] windows=${BrowserWindow.getAllWindows().length}`)
  // Standard output may be a pipe, which Node writes to later: everything is handed over before exit.
  await Promise.all([process.stdout, process.stderr].map((stream) => new Promise<void>((done) => {
    try { stream.write('', () => done()) } catch { done() }
  })))
  app.exit(code)
}

// ── App lifecycle ──────────────────────────────────────────────────────────


// ── Shared settings (0.42): the store, the Settings window, the menu bar (settings-host.ts) ──────────
// Started first thing at launch (app.whenReady below), before anything reads a preference.
let sharedSettings: TalkWeaverSettings | null = null
let settingsKeymap: SettingsKeymap | null = null
let lastShortcutKeys = ''

/** Opens the Settings window (one only), at `section` when it names one. False before the store is open. */
function openSettingsWindow(section?: string): boolean {
  if (!sharedSettings) return false
  sharedSettings.host.openSettingsWindow(typeof section === 'string' && section ? section : undefined)
  return true
}

/** Every change to the store, from anywhere, reaches the windows and services that follow a preference. */
function preferencesChanged(keys: string[], shortcutKeys: Readonly<Record<string, string>>): void {
  const has = (...wanted: string[]): boolean => wanted.some((k) => keys.includes(k))
  if (has('updates.checkForNewVersions')) updateChecker?.settingChanged()
  if (has('writing.actionBar')) broadcastActionBar()
  if (has('general.placeChip')) broadcastToWindows('place-chip:changed', { visible: placeChipVisible() })
  if (has('general.guideButton')) { broadcastToWindows('guide-button:changed', { visible: guideButtonVisible() }); pushPresentChapter() }
  if (has('writing.plainFont', 'writing.plainTextSize')) broadcastToWindows('plain-look:changed', plainLook())
  if (has('recording.endpoint', 'recording.bucket', 'recording.discardShorter')) recordingStorage().settingsChanged()
  if (has('publishing.customDomain')) void cloudflareConnection().settingsChanged().catch(() => {})
  // The Settings window and CLI can enable main's background image-text pass after startup.
  if (has('general.imageText') && getConfig('ocrEnabled', true)) ocrAllVaultImages()
  // Turning backup on, or a new folder: whatever is enrolled and stale is backed up (never a vault scan).
  if (has('presenting.backup', 'presenting.backupFolder') && getConfig('backupEnabled', false) && getConfig('backupFolder', undefined)) {
    setTimeout(() => { runLaunchBackup().catch(() => {}) }, 400)
  }
  const shortcuts = JSON.stringify(shortcutKeys)
  if (has(KEYMAP_SETTING) || shortcuts !== lastShortcutKeys) {
    // A registry shortcut changed (a rebind or reset in Settings, an import, the CLI): that command's
    // app-layer key goes too, so a reset shows the default (Sol review 1, #5). The write comes back here.
    if (shortcuts !== lastShortcutKeys && settingsKeymap) {
      let before: Record<string, string> = {}
      try { before = JSON.parse(lastShortcutKeys || '{}') as Record<string, string> } catch { /* none known */ }
      void settingsKeymap.registryChanged(before, shortcutKeys)
    }
    lastShortcutKeys = shortcuts
    if (settingsKeymap) broadcastToWindows('keymap:changed', settingsKeymap.overrides())
  }
}

async function startSharedSettings(): Promise<void> {
  const dir = app.getPath('userData')
  sharedSettings = await startSettingsHost({
    dir,
    appVersion: app.getVersion(),
    file: { read: () => configFile().read() as Record<string, unknown>, write: (patch) => configFile().write(patch as Partial<Config>) },
    window: { preload: join(__dirname, '../preload/settings.js'), url: settingsPageUrl(process.env['ELECTRON_RENDERER_URL'], __dirname) },
    slots: createSecretSlots({
      cloudflare: {
        has: () => secrets().has('cloudflare-token'),
        save: (token) => cloudflareConnection().saveToken(token),
        disconnect: () => cloudflareConnection().disconnect()
      },
      recording: {
        has: () => recordingStorage().hasKeys(),
        save: (keys) => recordingStorage().saveKeys(keys),
        clear: () => recordingStorage().clearKeys()
      }
    }),
    openMain: () => {
      const win = targetEditorFor(null)
      if (!win) { createWindow(); return }
      if (!E2E) bringToFront(win)
    },
    runInEditor: (commandId) => {
      const win = targetEditorFor(null)
      if (!win) return
      // A window made just now runs it once its page has loaded.
      if (win.webContents.isLoading()) win.webContents.once('did-finish-load', () => win.webContents.send('app:run-command', commandId))
      else win.webContents.send('app:run-command', commandId)
    },
    runInMain: (commandId) => {
      if (commandId !== 'new-window') return false
      createWindow()
      guideLearn.commandRan('new-window', { inExample: false })
      return true
    },
    changed: (keys, state) => preferencesChanged(keys, state.keys)
  })
  settingsOverlay = sharedSettings.overlay
  settingsKeymap = createSettingsKeymap(sharedSettings.store, { bridleIdOfKeymapId, keymapIdOf })
  lastShortcutKeys = JSON.stringify(sharedSettings.store.view().keys)
}

// Every app window may open Settings (its own window), at a section.
ipcMain.handle('settings-window:open', (_event, section: unknown) => openSettingsWindow(typeof section === 'string' ? section : undefined))
// The Settings window's Get started page: these run in the editor window. Only the Settings window may ask.
handleFromSettingsWindow('settings-window:editor-action', () => false, (_event, action: unknown) => {
  if (action === 'whats-new') {
    const win = targetEditorFor(null) ?? createWindow()
    const send = (): void => win.webContents.send('app:run-command', 'whats-new')
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send)
    else send()
    return true
  }
  if (action !== 'open-guide' && action !== 'restore-example' && action !== 'add-vault') return false
  const win = targetEditorFor(null) ?? createWindow()
  if (!E2E) bringToFront(win)
  const send = (): void => win.webContents.send('settings-window:editor-action', action)
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send)
  else send()
  return true
})
ipcMain.handle('settings-window:example-removed', () => readConfig().exampleVaultRemoved === true && !vaultRegistry.list().some((v) => v.example))
// The editor keymap's overrides (keymap/store.ts): kept in the store, the same for every window.
ipcMain.handle('keymap:get', () => settingsKeymap?.overrides() ?? {})
ipcMain.handle('keymap:set', async (_event, wanted: unknown) => {
  const overrides = overridesArg(wanted)
  if (!settingsKeymap || !overrides) return { ok: false, overrides: settingsKeymap?.overrides() ?? {} }
  const r = await settingsKeymap.set(overrides)
  return { ok: r.ok, overrides: r.overrides }
})
// Answers consumed (the renderer may delete its localStorage copy) or retry (it keeps it): Sol review 1, #9.
ipcMain.handle('keymap:move-legacy', async (_event, legacy: unknown) => {
  const overrides = legacyOverridesArg(legacy)
  if (!settingsKeymap || !overrides) return { outcome: 'retry', overrides: settingsKeymap?.overrides() ?? {} }
  return settingsKeymap.moveLegacy(
    overrides,
    () => configFile().read().keymapOverridesMoved === true,
    () => configFile().write({ keymapOverridesMoved: true })
  )
})

app.whenReady().then(async () => {
  // A setup refused because the app is open has already exited (app.exit above); one holding the
  // lock runs its command and exits.
  if (SETTINGS_ARGS) {
    let code = 1
    try {
      code = await runTalkWeaverSettings(SETTINGS_ARGS, {
        dir: app.getPath('userData'),
        version: app.getVersion(),
        io: {
          stdout: (text) => { try { process.stdout.write(text) } catch { /* the reader has gone */ } },
          stderr: (text) => { try { process.stderr.write(text) } catch { /* the reader has gone */ } }
        }
      })
    } catch { try { process.stderr.write('The settings command could not run.\n') } catch { /* gone */ } }
    // app.exit does not flush pipes. A trailing write callback waits for every queued byte on
    // each stream, including error output, without closing either stream. A gone reader is safe.
    await Promise.all([process.stdout, process.stderr].map((stream) => new Promise<void>((done) => {
      try { stream.write('', () => done()) } catch { done() }
    })))
    app.exit(code)
    return
  }
  if (SETUP_ARGS) { if (holdsInstanceLock) await runSetupCommand(SETUP_ARGS); return }
  // A second instance on this user-data folder is quitting (the lock above): it starts nothing.
  if (!holdsInstanceLock) return
  // Shared settings first: the preferences are moved in (or again after a downgrade) and the store
  // opened before anything reads one. A store that cannot open leaves config.json as the source.
  try { await startSharedSettings() } catch (error) { console.error('[settings] the settings store did not open', error) }
  // Owner tokens (owner-tokens.ts). Before anything reads a registry: with the switch, write them
  // back into the registries for an older version and quit; otherwise move any that are still in a
  // registry into the secrets store. Only counts are logged.
  if (app.commandLine.hasSwitch(RESTORE_PLAIN_OWNER_TOKENS_SWITCH)) {
    const restoredOwnerTokens = restorePlainOwnerTokens(app.getPath('userData'), ownerTokens())
    console.info('[owner-tokens] restored to the registries', JSON.stringify(restoredOwnerTokens))
    // Anything short of every row of every registry having its token again is a failure, by name:
    // a registry that could not be read, or a row the store holds no token for.
    const notRestored = incompleteOwnerTokenRestores(restoredOwnerTokens)
    if (notRestored.length > 0) console.error(`[owner-tokens] NOT fully restored: ${notRestored.join(', ')}`)
    app.exit(notRestored.length > 0 ? 1 : 0)
    return
  }
  const movedOwnerTokens = migrateOwnerTokens(app.getPath('userData'), ownerTokens())
  if (Object.values(movedOwnerTokens).some((step) => 'failed' in step || step.found > 0)) {
    console.info('[owner-tokens] moved into secure storage', JSON.stringify(movedOwnerTokens))
  }
  initialiseLiveSessions()
  // Work-files ticket 09: the Sessions view's list, every Run of every open vault (read-only).
  registerSessionsListIpc({
    ipcMain: ipcMain as unknown as Parameters<typeof registerSessionsListIpc>[0]['ipcMain'],
    vaults: () => availableVaults().map((v) => ({ id: v.id, root: v.root })),
    liveRuns: () => liveSessions?.liveRuns() ?? [],
    // The one sent set (ticket 17, D1): the Unpublish confirmation names exactly what the job withdraws.
    sentPhases: (run, root) => sentPhases(runPrework(), run, root),
    // Responses waiting on the live service (counted on the work timer, never pulled here), for the Run's own vault.
    waitingOf: (run, root) => (['pre', 'post'] as const).reduce((sum, phase) => {
      const state = runPrework().status(run.talkSlug, run.id, phase, root)
      return sum + (state?.waiting && (!state.vaultRoot || state.vaultRoot === root) ? state.waiting : 0)
    }, 0)
  })
  // Work-files ticket 22: the Published pages view's list, every live page of every open vault (read-only).
  registerPublishedPagesIpc({
    ipcMain: ipcMain as unknown as Parameters<typeof registerPublishedPagesIpc>[0]['ipcMain'],
    ...publishedPagesDeps(),
  })
  // Work-files ticket 10: the Run page (how its files read, Mark as delivered, Open file, Open live view).
  registerRunPageIpc({
    ipcMain: ipcMain as unknown as Parameters<typeof registerRunPageIpc>[0]['ipcMain'],
    vaults: () => availableVaults().map((v) => ({ id: v.id, root: v.root })),
    openPath: (path) => E2E ? Promise.resolve('') : shell.openPath(path),
    focusLive: (talkSlug, runId, vaultRoot) => {
      const id = liveSessions?.windowFor(talkSlug, runId, vaultRoot)
      const win = id == null ? undefined : BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.id === id)
      if (!win) return false
      if (win.isMinimized()) win.restore()
      win.focus()
      return true
    },
    // The Run's own vault, never the current one: a Run from another vault reads that vault's talk.
    readOutline: (root, talkSlug) => {
      try { const talk = findTalks(root).find((item) => item.slug === talkSlug); return talk ? readFileSync(talk.outlinePath, 'utf8') : null } catch { return null }
    },
    // Pulls, stars and marks write to the Run's own vault: any open vault whose folder is there.
    writableVault: (vaultId) => { const picked = runVaultFor(vaultId); return !('error' in picked) && Boolean(picked.root) },
    // Pre-work or post-work published before 0.41 by a vault nothing records (issue 256): the Run page says so.
    ownerUnknown: (root, run) => (['pre', 'post'] as const).filter((phase) => runPrework().ownerUnknown(run.talkSlug, run.id, phase, root)),
    // Extra slides (ticket 25): the talk of the Run's own vault, compiled as the strip compiles it ("Place after").
    talkSlides: async (root, talkSlug) => {
      const talk = talkInVault(root, talkSlug)
      if (!talk || outlineRefused(talk.outlinePath)) return null
      const prepared = await prepareTalk(talk.outlinePath, readFileSync(talk.outlinePath, 'utf8'), timerSettings())
      if (!prepared) return null
      const prework = prepared.model.prework as { slideIds?: unknown } | undefined
      return {
        slides: ((prepared.rows ?? []) as Array<{ slide_id?: unknown; title?: unknown }>)
          .filter((row) => typeof row.slide_id === 'string' && row.slide_id)
          .map((row) => ({ id: String(row.slide_id), title: typeof row.title === 'string' ? row.title : '' })),
        preworkIds: Array.isArray(prework?.slideIds) ? prework.slideIds.filter((id): id is string => typeof id === 'string') : [],
        // An outline in the older format never takes a Run's extra slides (compiler 08-source-adapters.mjs).
        ...(prepared.model.adapter === LEGACY_OUTLINE_ADAPTER ? { legacy: true } : {}),
      }
    },
    onDelivered: (talkSlug, runId, vaultRoot) => { notifyTalkMetaUpdated(); openPostWorkFor(talkSlug, runId, vaultRoot) },
    // Preview page (ticket 16).
    previewPage: async (root, run) => {
      const compilerDir = getCompilerPath()
      if (!compilerDir) return { ok: false, error: 'Compiler not found' }
      return buildRunWorkPreview({ vaultRoot: root, run, compilerDir, talkTitle: run.talkTitle || run.talkSlug })
    },
    qrSvg: (url) => instantLinkQrSvg(url),
  })
  // Feedback-boards ticket 06: History's board actions and the Run's read-only share link.
  registerRunBoardIpc({
    ipcMain: ipcMain as unknown as Parameters<typeof registerRunBoardIpc>[0]['ipcMain'],
    vaultRoot: () => writableVaultRoot() ?? null, // writes: only a vault folder that is there (ticket 07)
    sessions: () => liveSessions,
    shares: createRunResultsShares({
      registryPath: join(app.getPath('userData'), 'run-results-share-registry.json'),
      ownerTokens: ownerTokens(),
      endpoint: () => liveAdminEndpoint(),
      linkBase: () => attachedShareLinkBase(),
      fetch,
    }),
  })
  // Feedback-boards ticket 09: History's pre-work actions, and a pull every few minutes while any
  // Run's pre-work is open (answers reach the Run through the atomic Run writer).
  registerRunPreworkIpc(ipcMain as unknown as Parameters<typeof registerRunPreworkIpc>[0], runPrework(), {
    // The Run page names the Run's vault: its pulls and marks go there, never to another vault.
    vaultFor: (vaultId) => runVaultFor(vaultId),
    onQuestionMarked: (talkSlug, runId) => {
      for (const wcId of livePresenterContexts.keys()) {
        const record = liveSessions?.record(wcId)
        if (!record || record.talkSlug !== talkSlug || record.runId !== runId) continue
        const win = BrowserWindow.getAllWindows().find((item) => item.webContents.id === wcId)
        if (win && !win.isDestroyed()) win.webContents.send('live:prework-questions', preworkTrayForLiveSession(record, liveVaultReadable))
      }
    },
  })
  // The Run page's board slides: which board slide each pre-work step feeds, with the compiler's own slide ids.
  ipcMain.handle('history:prework-feeds', async (_event, payload: unknown) => {
    try {
      const asked = (payload ?? {}) as { talkSlug?: unknown; vaultId?: unknown }
      const slug = String(asked.talkSlug ?? '')
      // The Run page names the Run's vault: its talk is read from there (read only: any open vault that is there).
      // Only an absent vaultId means the current vault: null, '' or a non-text id reads nothing (rootOfVault would give the current vault).
      const root = asked.vaultId === undefined ? undefined : typeof asked.vaultId === 'string' && asked.vaultId ? rootOfVault(asked.vaultId) : undefined
      if (asked.vaultId !== undefined && !root) return { ok: false as const }
      const talk = root ? talkInVault(root, slug) : talkBySlug(slug)
      if (!talk) return { ok: false as const }
      const prepared = await prepareTalk(talk.outlinePath, readFileSync(talk.outlinePath, 'utf8'))
      return prepared ? { ok: true as const, feeds: feedsOfModel(prepared.model) ?? [] } : { ok: false as const }
    } catch { return { ok: false as const } }
  })
  startRunPreworkTimer(runPrework(), () => notifyTalkMetaUpdated())
  // Ticket 19: at launch (post-work whose session ended while the app was closed) and every pull cycle.
  startPostWorkOpenTimer(postWorkOpener(), () => notifyTalkMetaUpdated())
  // A recording that never reached Stop last time (crash, power loss) becomes a Run marked partial
  // that references the audio already on disk. Never blocks launch; never deletes audio.
  void recoverInterruptedRecordings()
    .then((n) => { if (n) console.log(`[recording] recovered ${n} interrupted recording(s)`) })
    .catch((error) => console.warn('[recording] recovery failed', error))
  // A share whose create was under way when the app last quit, and whose owner token was never kept:
  // reported only (ticket 12 round 2) — the log here, and the talk's share sheet, which asks before
  // sharing; that Share replaces it on the service. No request is sent.
  try {
    for (const create of sharedTalks().interruptedCreates()) console.warn(`[shared-talk] ${create.outlinePath}: ${create.message}`)
  } catch (error) { console.warn('[shared-talk] interrupted creates not read', error) }
  // Feedback rail: open the owner socket of every shared talk (never blocks launch).
  try { sharedTalkFeedback().sync() } catch (error) { console.warn('[shared-talk] feedback start failed', error) }
  // The menu bar is generated from the command registry by the shared settings host (startSharedSettings).
  if (!sharedSettings) installFallbackMenu()
  updateChecker = installUpdateNotices({
    editorWindows: () => [...editorWindows.values()].map((entry) => entry.win).concat((sharedSettings?.host.settingsWindow() as BrowserWindow | null) ?? []),
    isPresentingNow: () => presentWindows.size > 0 || recordingOpen() || (liveSessions?.anyOpen() ?? false),
    readConfig,
    writeConfig,
    e2e: E2E,
  })
  onRecordingOpenChange(() => updateChecker?.busyChanged())
  // Every permission request and check is answered by one table from app start: the microphone to a
  // presenter window's own page, clipboard and full screen to a window's own page, nothing to a
  // frame embedded in a slide (recording-permissions.ts).
  installRecordingPermissions(session.defaultSession)
  // A page embedded in a slide does not reach this Mac's services or the local network
  // (local-address-filter.ts). The session's ONE onBeforeRequest listener; the player Referer hook
  // below is another event (onBeforeSendHeaders) and is untouched.
  // A request with no frame (main's own, or a worker's) may reach a local address only at a host
  // registered here: the dev server in development. Main asks for no other local address this way.
  // Only an app window saves a download; a deck window, a hidden renderer and a request with no
  // window are cancelled (window-kinds.ts). There was no handler: any page could raise the Save dialog.
  session.defaultSession.on('will-download', (event, item, contents) => {
    if (decideDownload(contents?.id) === 'allow') return
    event.preventDefault()
    console.warn(`[download] cancelled ${String(item?.getURL?.() ?? '').slice(0, 120)} from window ${String(contents?.id ?? '?')}: only the editor saves downloads`)
  })
  installLocalAddressFilter(session.defaultSession, { appLocalHosts: [appLocalHostOf(process.env['ELECTRON_RENDERER_URL'])].filter((host): host is string => !!host) })
  // A page that refuses to be framed (X-Frame-Options, CSP frame-ancestors) is refused in the app
  // too: no response header is rewritten, for any frame. Such a page shows Chromium's refusal in the
  // frame, beside the "Open <host> ↗" link the compiler gives every remote page, and Check embeds
  // reports it as "Refuses framing" (e2e/check-remote-page-framing.mjs).

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

  // Register twasset:// to serve vault asset files safely: twasset://img-a3f9b2 reads the current vault's
  // pool; ?vault=<id> that open vault's (the image drawer's In your talks tab). Only a plain pool file reached
  // through plain folders is served, never through a link (twassetFileFor → containedPoolFile).
  protocol.registerFileProtocol('twasset', (request, callback) => {
    const file = twassetFileFor(request.url, currentVaultRoot(), availableVaults())
    callback(file ? { path: file } : { error: -2 })
  })
  // Serve rendered slide thumbnails: twthumb://thumb/<slug>/<key> -> {userData}/thumb-cache/<slug>/<key>.png
  // (slug and key percent-encoded, shared/thumb-url.ts). `?vault=<id>` reads that vault's folder only;
  // a bare URL tries the open vaults in order, then the namespace level (thumb-cache-dirs.ts).
  protocol.registerFileProtocol('twthumb', (request, callback) => {
    try {
      const req = parseThumbUrl(request.url)
      if (!req) { callback({ error: -2 }); return }
      // Slug and key come from the URL, decoded: only a PNG inside this talk's thumbnail folders
      // (thumbFileFor runs the containment guards on the decoded values).
      const namespaceDir = thumbNamespaceDir()
      if (!thumbCacheDir(namespaceDir, req.slug).ok) { callback({ error: -2 }); return }
      adoptLegacyThumbsOnce()
      touchNamespaceHourly() // a read-only session keeps older builds' cache sweep away too
      const openIds = vaultRegistry.list().filter((v) => v.open).map((v) => v.id)
      // Fallback: the pre-render writes DOCUMENT-SCOPED filenames `<documentId>-<render_hash>.png`
      // (thumbnailDocumentCacheKey), but the Slide Browser can only address a slide by its bare
      // `render_hash` — it never compiles the talk, so it cannot know the documentId. Resolve the
      // bare key to `<documentId>-<key>.png`. This is safe: render_hash is the PICTURE identity
      // (it already folds in layout + section accent), so any file with that suffix is the same
      // picture. Without this, tens of thousands of correctly-built thumbnails were unreachable and
      // every browser card rendered blank (2026-07-19).
      const hit = thumbFileFor(namespaceDir, req, openIds)
      if (hit) { callback({ path: hit }); return }
    } catch { /* fall through */ }
    callback({ error: -2 })
  })
  // Serve only a segment named by this talk's Run (or its recovery marker).
  protocol.registerFileProtocol('twrec', (request, callback) => {
    try {
      const url = new URL(request.url)
      const sessionId = url.hostname
      const talkSlug = url.searchParams.get('talk')
      if (!sessionId || !talkSlug) { callback({ error: -2 }); return }
      const home = url.searchParams.get('home')
      const vault = home === null ? currentVaultRoot() ?? null : home === '' ? null
        : availableVaults().some((v) => v.root === home) ? writableRoot(home, rootFs) : undefined
      if (vault === undefined) { callback({ error: -2 }); return }
      const p = recordingAudioPath(app.getPath('userData'), sessionId, vault, talkSlug)
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
        const html = previewId == null ? undefined : slidePreviewStore.get(previewId) ?? scratchpadPreviewStore.get(previewId)
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
  // Serve read-only search thumbnails: twarchive://f/<b64url> where b64url is the base64url of an
  // absolute file path. Served ONLY when the image search seam vouches for the file (fileFor).
  protocol.registerFileProtocol('twarchive', (request, callback) => {
    // The image search seam decides, at request time: an archive image the registry lists or a
    // search returned, or a SlideWell item a search returned and SlideWell still lists.
    imageSearch.fileFor(request.url).then(
      (file) => callback(file ? { path: file.absPath } : { error: -2 }),
      () => callback({ error: -2 })
    )
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
  // 2026-10-20: thumbnails are rendered ahead of the Browser again, but by the bounded prewarm
  // (thumbnail-prewarm.ts): one video-free talk at a time, lowest render priority, paused under
  // memory pressure and while presenting — not the eager sweep above.
  setTimeout(() => {
    // Frontmatter details and delivery summaries for talk search: cheap, read before first use.
    talkSearch.warm().catch(() => {})
    warmSearchIndex()
      .catch(() => {})
      .finally(() => {
        // Image text is on by default (Settings can turn the background pass off); one helper
        // process at a time, queued behind a debounce, never blocking search.
        if (getConfig('ocrEnabled', true)) {
          setTimeout(() => { ocrAllVaultImages() }, 3000)
        }
        // Thumbnail prewarm: after the search rows it reads are warm and the image-text pass has
        // started; it then waits its own start delay and works only while nothing else is.
        if (PREWARM_ENABLED) thumbnailPrewarm.start()
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

// A share's create on the service under way at quit: up to 5 s for its reply, so its owner token is
// kept (ticket 12 round 2). What does not finish in time keeps its note: reported at the next start,
// and replaced on the service when the talk is next shared.
let sharedTalkCreatesDrained = false
// Preference writes the store has not answered yet are waited for (the overlay queues them), then the store is closed.
let sharedSettingsClosed = false
app.on('will-quit', (event) => {
  if (sharedSettings && !sharedSettingsClosed) {
    sharedSettingsClosed = true
    event.preventDefault()
    const closing = sharedSettings
    // Electron ignores a re-entrant quit while this will-quit callback is still unwinding.
    // Disposal can settle in a microtask; resume on the next turn so the quit is honoured.
    void Promise.race([closing.dispose(), new Promise((done) => setTimeout(done, 3000))]).catch(() => {}).finally(() => setImmediate(() => app.quit()))
    return
  }
  if (!sharedTalkCreatesDrained && sharedTalkService?.createsPending()) {
    sharedTalkCreatesDrained = true
    event.preventDefault()
    void sharedTalkService.drainCreates(5000).catch(() => {}).finally(() => app.quit())
    return
  }
  void thumbnailPrewarm.stop()
  liveSessions?.shutdown()
  sharedTalkFeedbackService?.stopAll()
  try { localLiveWorker?.process.kill('SIGTERM') } catch { /* already stopped */ }
  localLiveWorker = null
  // A publish or a live-service set-up under way: its tool runs in a process group of its own and
  // would go on after the app has gone. Ended here, at once (wrangler-launcher.ts).
  endAllWranglerRuns()
})

app.on('activate', () => {
  // The setup command never opens a window, whatever macOS asks of it.
  if (SETUP_ARGS || !holdsInstanceLock) return
  // Settings and hidden utility windows are not editors. createWindow keeps E2E runs hidden.
  if (!targetEditorFor(null)) createWindow()
})
