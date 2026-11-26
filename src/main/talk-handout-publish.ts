import { randomBytes } from 'node:crypto'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { handoutHomeDetails } from '../shared/handout-home.ts'
import { unresolvedOutboundFailure } from '../shared/layout-doctor.ts'
import { redactPublishException, redactPublishText, type PublishDiagnostic, type PublishProgress } from '../shared/publish-diagnostic.ts'
import type { MediaPublishChoice, PublishNotReady } from '../shared/publish-status.ts'
import { publicationMediaReview, publicationBuildWarnings } from '../shared/publication-files.ts'
import { hasGitConflictMarkers } from './conflict-copies.mjs'
import { publishedFolders, writableSiteFolder } from './handout-publishing.ts'
import type { TalkIpcHost } from './index'
import { outlineIdentity } from './outline-identity.ts'
import { preservationMessage, PreservationRefusal, type PreservationReason } from './publication-preservation.ts'
import { SITE_FOLDER_REFUSED, resolveBase, publishUrl, readHandoutUrl, recoverIdFromUrl, generateShortId, pickShortId, buildRedirects, stampHandoutUrl } from './publishing-logic.ts'
import { flushTalkForPublish, PUBLISH_EMPTY_TALK, readSavedTalkForPublish, writeTalkOutline } from './talk-writer.ts'

type TalkPublishHost = Pick<TalkIpcHost,
  'assetRootsFor' | 'buildHandoutPagesOffThread' | 'getCompilerPath' | 'getConfig' | 'handoutPublishing'
  | 'ledgerSeal' | 'outlineRefused' | 'presenterPublications' | 'publishingHistory' | 'readHandoutRegistry'
  | 'resolvePooledRefs' | 'writeHandoutRegistry'>

export type TalkPublishOptions = {
  retryAttemptId?: string
  signal?: AbortSignal
  onProgress?: (progress: PublishProgress) => void
  dryRun?: boolean
  savedOnly?: true
  onWarning?: (warning: string) => void
  pinSource?: true
}

export type TalkPublishResult =
  | { success: false; error?: string; code?: PreservationReason; details?: string; notReady?: PublishNotReady; diagnostic?: PublishDiagnostic; cancelled?: true }
  | { success: true; url: string; unchanged?: true; display?: string; updatedOutline?: string; warning?: string;
      liveNotice?: string; liveDetails?: string; earlierNotice?: string; earlierDetails?: string }
  | { success: true; preview: { files: number; bytes: number }; warning?: string }

/** The handout operation used by the editor, history retry and the command line. */
export async function publishTalkHandout(host: TalkPublishHost, outlinePath: string, content: string, mediaChoice?: MediaPublishChoice,
  options: TalkPublishOptions = {}): Promise<TalkPublishResult> {
  const { assetRootsFor, buildHandoutPagesOffThread, getCompilerPath, getConfig, handoutPublishing, ledgerSeal,
    outlineRefused, presenterPublications, publishingHistory, readHandoutRegistry, resolvePooledRefs, writeHandoutRegistry } = host
  let diagnostic: PublishDiagnostic | undefined
  let publishedUrl: string | undefined
  let unchanged: true | undefined
  let sourceOutline: { path: string; key: string } | undefined
  const tracked = {
    signal: options.signal,
    onProgress: options.onProgress,
    dryRun: options.dryRun,
    onUnexpectedFailure: (failure: PublishDiagnostic) => { diagnostic = failure },
  }
  let expectedSite: string | undefined
  let retryKey: string | undefined
  const refused = (error: string, reply?: { success: false; error: string }) =>
    ({ ok: false as const, error: redactPublishText(error), reply })
  const input = async () => {
    if (options.retryAttemptId !== undefined) {
      const attemptId = options.retryAttemptId
      let original: ReturnType<ReturnType<typeof publishingHistory>['retrySource']>
      if (typeof attemptId === 'string' && /^[0-9a-f-]{36}$/u.test(attemptId)) {
        try { original = publishingHistory().retrySource(attemptId) }
        catch (error) { console.warn(`[publish-handout] history retry: ${redactPublishException(error)}`) }
      }
      if (!original) return refused('This publishing attempt can no longer be retried from history. Open the talk to publish it.')
      outlinePath = original.path
      retryKey = original.key
      expectedSite = original.site
      content = ''
      mediaChoice = undefined
    }
    const refusal = outlineRefused(outlinePath) // writes beside the outline: refuse one outside the vault
    if (refusal) return refused(refusal)
    const identity = outlineIdentity(outlinePath)
    if (retryKey && identity.key !== retryKey) return refused('The original talk has moved or been replaced. Open it to publish it.')
    sourceOutline = { path: outlinePath, key: identity.key }
    // The renderer copy gates this request early. The handout, ledger seal and stamp use the flushed text.
    const blocked = unresolvedOutboundFailure(content)
    if (blocked) return refused(blocked.error, blocked)
    const compilerDir = getCompilerPath()
    if (!compilerDir) return refused('Compiler not found')
    // What is published is the editor's buffer as it stands when Publish was pressed: flush it to disk
    // first (a forced save of the open editor's buffer through the one writer, talk-writer.ts; a
    // closed talk's file is read as it is) and build from the text the flush returns — never from
    // `content`, and never by writing the file here.
    let published: string
    if (options.savedOnly) {
      const saved = await readSavedTalkForPublish(outlinePath)
      published = saved.text
      const name = redactPublishText(basename(outlinePath, '-outline.md'))
      if (saved.editorDiffers) options.onWarning?.(saved.editorDiffers === 'unknown'
        ? `Could not check the open editor for ${name}. Using the saved version.`
        : `${name} has unsaved changes in TalkWeaver. Using the saved version.`)
      if (!published.trim()) return refused(PUBLISH_EMPTY_TALK)
    } else {
      const flushed = await flushTalkForPublish(outlinePath)
      if (!flushed.ok) return refused(flushed.error)
      published = flushed.text
    }
    const blockedNow = unresolvedOutboundFailure(published)
    if (blockedNow) return refused(blockedNow.error, blockedNow)
    return { ok: true as const, compilerDir, published, sourceKey: identity.key }
  }
  try {
    const prepared = await input().catch(error => {
      const cause = redactPublishException(error)
      if (!options.pinSource) console.error(`[publish-handout] preparing: ${cause}`)
      return { ...refused('TalkWeaver could not read or save the talk before publishing.'), cause }
    })
    const mediaNotices: string[] = []
    const presenterTicket = presenterPublications.ticket()

    // The sequence (leave to publish, the live service or its absence, the one upload, what a
    // superseded publish does) is handout-publishing.ts. This supplies the talk's pages: `live` is
    // the only live address they may carry, and it is '' when the live service is not ready.
    const outcome = await handoutPublishing().publish({
      entry: 'talk',
      ...tracked, sourceOutline, expectedSite,
      ...((retryKey || options.pinSource) && prepared.ok ? { revision: () => {
        if (outlineRefused(outlinePath) || outlineIdentity(outlinePath).key !== prepared.sourceKey) throw new PreservationRefusal('PUBLISH_IDENTITY_CHANGED')
        return prepared.sourceKey
      } } : {}),
      begin: async (report) => {
        if (!prepared.ok) return { fail: prepared }
        const { compilerDir, published } = prepared
        if (retryKey && outlineIdentity(outlinePath).key !== retryKey) return { fail: { error: 'The original talk has moved or been replaced. Open it to publish it.' } }
        if (hasGitConflictMarkers(published)) return { fail: { error: 'The talk has unresolved Git conflict markers. Resolve them before publishing.', reply: { success: false, error: 'The talk has competing edits from syncing', notReady: { kind: 'not-ready', title: 'The talk has competing edits from syncing', detail: 'Keep both versions and resolve the Git conflict before publishing.', fix: { action: 'show-source', label: 'Reveal talk source' } } } } }
        if (mediaChoice === 'with-placeholders') return null
        const fileCheck = await buildHandoutPagesOffThread({ kind: 'preflight', compilerDir, outlinePath, text: resolvePooledRefs(published, outlinePath), assetRoots: assetRootsFor(outlinePath) })
          .catch(() => ({ warnings: ['The media check could not finish.'], publicationFiles: undefined }))
        if (fileCheck.publicationFiles) {
          const { checked, findings } = fileCheck.publicationFiles
          report?.({ checked, missing: new Set(findings.map(finding => finding.file)).size })
        }
        const media = publicationMediaReview(fileCheck.publicationFiles, fileCheck.warnings, mediaChoice)
        if (media.prompt) return { fail: { error: media.prompt.title, reply: { success: false, notReady: media.prompt } } }
        if (media.notices) mediaNotices.push(...media.notices)
        return null
      },
      // The flushed string below is the compiler's selected input; no mutable-source recheck is claimed.
      prepare: async ({ dir: siteDir, project, live, link, redirects, makeFolder, writeSiteFile, claimFile, previewLinks }) => {
        if (!prepared.ok) return prepared
        const { compilerDir, published } = prepared
        const baseUrl = getConfig('publishBaseUrl', undefined)
        const useShortIds = previewLinks?.shortLinks ?? getConfig('publishUseShortIds', false) ?? false
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
        // Download + QR + short link). Only this folder is sent: every other talk keeps its live hash (per-talk publishing).
        // ENTRY FIRST, the rest of it, all in memory before the first file is written: the stable short
        // id (so the viewer page and the redirects carry the final link), the handout's own link (it
        // goes into its pages: the QR code, the venue screen), and the WHOLE redirect file as it will be.
        let id: string | undefined
        let redirectsText: string | null = null
        let registryToKeep: Record<string, string> | null = null
        if (useShortIds) {
          const registry = previewLinks?.registry ?? readHandoutRegistry()
          const recoveredId = recoverIdFromUrl(readHandoutUrl(published), base)
          const gen = (): string => generateShortId((n) => Uint8Array.from(randomBytes(n)))
          const picked = pickShortId({ registry, slug, recoveredId, gen })
          id = picked.id
          registryToKeep = picked.registry
          redirectsText = redirects(buildRedirects(picked.registry, [...new Set([...publishedFolders(siteDir), slug])]))
        }
        const url = link(publishUrl({ base, slug, id, useShortIds }))
        // Checked: from here on things are written.
        if (registryToKeep) {
          if (previewLinks) previewLinks.registry = registryToKeep
          else writeHandoutRegistry(registryToKeep)
        }
        // Built privately and moved into the site only when the upload launches (handout-publishing.ts), or written in place when already there.
        const outDir = makeFolder(talkOutDir)
        claimFile(join(siteDir, '404.html')) // the page builder writes the site's 404 page: owned by this publish when it is new

        const { makeQrSvg } = await import(pathToFileURL(join(compilerDir, 'lib/01-cli-utils.mjs')).href)
        const qr = (makeQrSvg(url) as string) || ''
        // The compile, the pages (Download, lazy <slug>.html, the home page, the venue screen) and their
        // slimming and writing run OFF this thread (handout-pages.ts): a heavy handout held it for
        // seconds, and the app showed the beachball. Everything it is handed has been checked above.
        const pagesWritten = await buildHandoutPagesOffThread({
          kind: 'talk', compilerDir, talkOutDir: outDir, siteDir, slug, live, url, qr,
          downloadFile: `${slug}-download.html`, handoutFile: `${slug}.html`,
          outlinePath, text: resolved, outline: published, assetRoots: assetRootsFor(outlinePath),
          homeDetails: handoutHomeDetails({ outline: published }),
        })


        // The redirect file, as it was checked before the build began.
        if (redirectsText !== null) writeSiteFile(join(siteDir, '_redirects'), redirectsText)
        return { ok: true, built: { url, warnings: [...mediaNotices, ...publicationBuildWarnings(pagesWritten.warnings)] } }
      },
    })
    // A publish that did not go up, or that the connection changed under, records nothing below.
    if (!outcome.ok && outcome.reply) return { ...(outcome.reply as { success: false; error: string }), diagnostic: outcome.diagnostic }
    if (!outcome.ok) {
      const code = outcome.error.startsWith('PUBLISH_') ? outcome.error as PreservationReason : undefined
      const error = code
        ? (outcome.details?.includes('cannot be compared safely') || outcome.details?.startsWith('Publishing stopped because the local file ')
          ? outcome.details : preservationMessage(code))
        : outcome.error
      return {
        success: false, error: redactPublishText(error), code,
        ...(outcome.details ? { details: redactPublishText(outcome.details) } : {}), ...(outcome.notReady ? { notReady: outcome.notReady } : {}),
        diagnostic: outcome.diagnostic, cancelled: outcome.cancelled,
      }
    }
    if (!prepared.ok) return { success: false, error: 'TalkWeaver could not prepare the handout.' }
    const { published } = prepared
    const { url, warnings } = outcome.built
    const warning = [...warnings, outcome.localWarning].filter(Boolean).join(' ')
    if (outcome.preview) return { success: true, preview: outcome.preview, warning }
    publishedUrl = url
    unchanged = outcome.unchanged
    if ((retryKey || options.pinSource) && (outlineRefused(outlinePath) || outlineIdentity(outlinePath).key !== prepared.sourceKey)) {
      return { success: true, url, unchanged: outcome.unchanged, warning: 'The original talk has moved or been replaced, so its published link could not be saved.' }
    }

    // Best-effort: stamp handout_url into the outline frontmatter (so the short id is recoverable
    // later). No frontmatter → left unchanged. Stamped onto the talk's CURRENT text through the one
    // writer (the deploy can take minutes; the open editor's buffer may have moved on). `updatedOutline`
    // reports the text the writer applied; the renderer does not adopt it — it stamps its own buffer
    // as it stands (WorkspaceLayout.handlePublishHandout), a no-op when this stamp landed.
    let updatedOutline = stampHandoutUrl(published, url)
    if (updatedOutline !== published) {
      // A CLI publish must never commit an editor's unsaved text as a side effect of stamping.
      const stamped = await writeTalkOutline(
        outlinePath,
        current => options.savedOnly && current !== published ? current : stampHandoutUrl(current, url),
        'publish-handout',
        options.savedOnly ? { authorize: () => {
          if (outlineRefused(outlinePath) || outlineIdentity(outlinePath).key !== prepared.sourceKey) throw new PreservationRefusal('PUBLISH_IDENTITY_CHANGED')
        } } : undefined,
      )
      if (stamped.ok && (!options.savedOnly || readHandoutUrl(stamped.text) === url)) updatedOutline = stamped.text
      else if (options.savedOnly) updatedOutline = published
    }
    presenterPublications.published(presenterTicket, { kind: 'talk', outlinePath, url,
      retainUrl: (options.savedOnly && readHandoutUrl(updatedOutline) !== url)
        || (!readHandoutUrl(updatedOutline) && stampHandoutUrl(updatedOutline, url) === updatedOutline) })
    const seal = ledgerSeal(outlinePath, published, 'publish')
    if (options.pinSource) await seal
    return {
      success: true, url, display: url, updatedOutline, unchanged: outcome.unchanged, ...(warning ? { warning } : {}),
      // Published without live features (spec D7): the sentence, and what lies behind it for "Details".
      ...(outcome.notice ? { liveNotice: outcome.notice, ...(outcome.noticeDetails ? { liveDetails: outcome.noticeDetails } : {}) } : {}),
      // Handouts an earlier version left with a dead live address: how many, and their names for "Details".
      ...(outcome.earlierNotice ? { earlierNotice: outcome.earlierNotice, ...(outcome.earlierDetails ? { earlierDetails: outcome.earlierDetails } : {}) } : {}),
    }
  } catch (failure) {
    if (!diagnostic && !options.pinSource) console.error(`[publish-handout] ${redactPublishException(failure)}`)
    if (publishedUrl) return { success: true, url: publishedUrl, unchanged, warning: 'The handout went live. TalkWeaver could not finish saving its link on this Mac.' }
    const error = 'TalkWeaver could not finish publishing the handout.'
    return { success: false, error, diagnostic }
  }
}
