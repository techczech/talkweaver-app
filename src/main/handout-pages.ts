// Building and writing a published handout's pages, OFF the main process's thread (Dominik,
// 0.38.2-preview.1: "publishing handout ties up TalkWeaver with a beachball but works").
//
// A heavy handout is tens of megabytes of text: the compile inlines every picture, the pages are
// built and searched as whole strings, every picture is re-encoded to fit Cloudflare Pages' 25 MiB
// file limit, and the files are hashed and written. Done on the main process's thread, each of
// those steps held it for up to a second at a time, and macOS showed the beachball. So this work
// runs in a worker thread (handout-pages-worker.ts, started by the main process for one publish and
// ended with it). The main process keeps everything that reads its own state or decides what may be
// published: the flush of the open talk, ENTRY FIRST (every link and the redirect file checked
// before anything is written), the short-id registry, the redirect file, the check after the build
// and the upload (handout-publishing.ts). What it hands over here is plain data, already checked.
//
// Two kinds of job:
//   talk   Publish handout: compile the talk (as talk:export-handout does), build the Download page,
//          the lazy page and the home page, then write them (below).
//   run    Publish handout for this Run: compile the talk as the live deck is compiled (the same
//          defaults and media folders), apply the Run's pathway and cover (runHandoutSourceFrom, which
//          Build Run handout also uses), then build the Run's handout, its copy in the talk's dist/
//          folder, the lazy page and the home page (buildRunHandoutHtml, also shared).
//   pages  Pages the caller has built already: only the writing happens here.
// Both then write the pages exactly as before: the lazy pages and the Download page through
// publishLazyHandoutPagesAsync (assets first, pages by temp + rename, slimming with `slim`), the venue
// screen (slimmed), and the site's 404 page.
//
// No Electron import and erasable TypeScript only: scripts/test-handout-from-buffer.mjs and
// test-prework-publish.mjs run `buildHandoutPages` in their own process, as the worker does.
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { withoutPreworkSlides, type CompiledPrework } from '../shared/run-prework.ts'
import type { HandoutHomeDetails } from '../shared/handout-home.ts'
import { injectPathwayRuntime, resolvePathways, type Pathway, type PathwaySlideRow } from './pathways.ts'
import { injectRunCoverMetadata } from './runs.ts'
import { requireAllowedAssetRoots } from './compile-roots.ts'
import { withRunExtraIds, type PlacedRunExtra, type RunExtrasModel } from '../../compiler/scripts/lib/run-extras.mjs'
import type { RunExtraSlide } from '../shared/run-extras.ts'

export { withRunExtraIds, type PlacedRunExtra, type RunExtrasModel }

/**
 * A compile for a Run (work-files ticket 25, compiler run-extras.mjs): its id, its pathway's slides (null: the
 * full talk) and its extra slides from the Run record, which the compiler makes into slides of their own.
 */
export type RunCompileOption = { id: string; slideIds: string[] | null; extraSlides: RunExtraSlide[] }

/**
 * The Run's extra slides as its compile placed them, with the deck's final slide order (model.runExtras), which
 * withRunExtraIds takes their places from; none for a talk's own compile.
 */
export function placedRunExtras(model: Record<string, unknown>): RunExtrasModel {
  const runExtras = model.runExtras as { slides?: unknown; order?: unknown } | undefined
  const slides = Array.isArray(runExtras?.slides) ? runExtras.slides.filter((slide): slide is PlacedRunExtra => Boolean(slide) && typeof (slide as PlacedRunExtra).id === 'string') : []
  const order = Array.isArray(runExtras?.order) ? runExtras.order.filter((id): id is string => typeof id === 'string') : undefined
  return { slides, ...(order ? { order } : {}) }
}

/**
 * What of a Run its handout's deck depends on: its cover, its id and extra slides (ticket 25) and, for a
 * pathway Run, its pathway with the talk's pathways (`pathways`, as the talk's manifest holds them).
 */
export function runForHandoutOf(
  run: { id: string; eventTitle?: string; talkTitle: string; plannedDate?: string; startedAt: string; slideSet: { kind: 'full' } | { kind: 'pathway'; pathwayId: string }; extraSlides?: RunExtraSlide[] },
  pathways: () => Pathway[],
): RunForHandout {
  const base = {
    eventTitle: run.eventTitle, talkTitle: run.talkTitle, plannedDate: run.plannedDate, startedAt: run.startedAt, runId: run.id,
    ...(run.extraSlides?.length ? { extraSlides: run.extraSlides } : {}),
  }
  return run.slideSet.kind === 'pathway' ? { ...base, pathway: { id: run.slideSet.pathwayId, pathways: pathways() } } : base
}

/**
 * The compile option for a Run's handout: the Run's extra slides, placed against its pathway's slides. None for
 * a Run without extra slides, whose handout deck is then the talk's own compile (the same cache entry).
 */
export function runCompileOption(run: RunForHandout): RunCompileOption | undefined {
  if (!run.runId || !run.extraSlides?.length) return undefined
  const pathway = run.pathway ? run.pathway.pathways.find((item) => item.id === run.pathway?.id) : undefined
  return { id: run.runId, slideIds: pathway ? [...pathway.slideIds] : null, extraSlides: run.extraSlides }
}

export type HandoutPage = { fileName: string; html: string; lazy?: boolean }

/** What buildVenuePageHtml takes, beyond the slides: the job's own fields fill the rest. */
export type VenueSource = { title: string; slides: unknown[]; styles: unknown; license?: unknown; liveTalkSlug?: string }

export type HandoutPagesJob = {
  compilerDir: string
  /** The handout's folder in the site (already checked by writableSiteFolder). */
  talkOutDir: string
  siteDir: string
  slug: string
  /** The live address the pages may carry, or ''. */
  live: string
  /** The handout's own link (checked): the QR code and the venue screen's join link. */
  url: string
  qr: string
  downloadFile: string
  handoutFile: string
} & (
  | {
      kind: 'talk'
      outlinePath: string
      /** The flushed outline, with pooled references resolved. */
      text: string
      /** The outline as flushed, for the frontmatter title. */
      outline: string
      assetRoots: string[]
      /** handoutHomeDetails({ outline }), made by the main process. */
      homeDetails: HandoutHomeDetails
    }
  | {
      kind: 'run'
      outlinePath: string
      /** The flushed outline, with pooled references resolved. */
      text: string
      /** The compile's defaults and media folders: the live deck's (prepareTalk with timerSettings()). */
      defaults: Record<string, unknown>
      assetRoots: string[]
      /** The talk's slug: the live room the handout follows. */
      talkSlug: string
      run: RunForHandout
      /**
       * handoutHomeDetails({ outline, run }), handoutHomePrework(form, 'pre-work/') and
       * handoutHomePostwork(form, 'post-work/'), made by the main process: the home page links to the
       * Run's work pages (work-files ticket 16); the handout itself carries no form.
       */
      homeDetails: HandoutHomeDetails
      homePrework: unknown
      homePostwork?: unknown
      /** The Run's extras (ticket 24: intro note and links), as the Run record holds them; only a Run's home page shows them. */
      homeExtras?: unknown
      /** The Run's handout as a file on this computer (talk folder/dist/<slug>-handout.html), written as Build Run handout writes it. */
      distPath: string
    }
  | {
      kind: 'pages'
      /** The Download page, the lazy page and the home page, built. */
      pages: HandoutPage[]
      venue: VenueSource
    }
)

/** A Run's compiled deck, as the main process makes it (index.ts runHandoutSource). */
export type RunHandoutSource = {
  /** The compiled deck with the Run's pathway and cover applied. */
  html: string
  title: string
  /** The talk's pre-work steps: never ordinary slides of a Run's handout. */
  preworkSlideIds: string[]
  /** The talk's slug: the live room the handout follows. */
  liveTalkSlug: string
}

/** What of a Run its handout's deck depends on. */
export type RunForHandout = {
  eventTitle?: string
  talkTitle: string
  plannedDate?: string
  startedAt: string
  /** The Run's pathway, with the talk's pathways as the manifest holds them; absent for the full talk. */
  pathway?: { id: string; pathways: Pathway[] }
  /** The Run's id and its extra slides (ticket 25, from the Run record), compiled in. Absent: the talk's slides only. */
  runId?: string
  extraSlides?: RunExtraSlide[]
}

/**
 * A Run's deck from the talk's compiled model and its per-slide rows: the Run's pathway (its slides
 * only) and its cover (event and date) applied, and which slides it shows. A pathway that is no longer
 * in the manifest is refused. A model compiled for the Run (runCompileOption) has the Run's extra slides
 * in place; with a pathway they join its slides, each after its chosen slide or at the end (ticket 25).
 */
export function runHandoutSourceFrom(
  model: Record<string, unknown>, rows: PathwaySlideRow[] | null, run: RunForHandout, slug: string, liveTalkSlug: string,
): { source: RunHandoutSource; slideIds: string[]; missing: string[] } {
  let html = String(model.fullHtml ?? '')
  let slideIds: string[]
  let missing: string[] = []
  if (run.pathway) {
    const resolved = resolvePathways(run.pathway.pathways, rows ?? []).find((pathway) => pathway.id === run.pathway?.id)
    if (!resolved) throw new Error('The Run pathway no longer exists.')
    slideIds = withRunExtraIds(resolved.present.map((row) => row.slide_id), placedRunExtras(model))
    missing = resolved.missing
    html = injectPathwayRuntime(html, slideIds, run.pathway.id)
  } else {
    slideIds = (rows ?? []).map((row) => row.slide_id)
  }
  const prework = model.prework as { slideIds?: unknown } | undefined
  const preworkSlideIds = Array.isArray(prework?.slideIds) ? prework.slideIds.filter((id): id is string => typeof id === 'string') : []
  return {
    source: {
      html: injectRunCoverMetadata(html, run.eventTitle ?? run.talkTitle, run.plannedDate ?? run.startedAt.slice(0, 10)),
      title: String((model.title as string) ?? slug), preworkSlideIds, liveTalkSlug,
    },
    slideIds, missing,
  }
}

export type HandoutPagesResult = {
  warnings: string[]
  /** A Run's job: the slides its handout shows, and the pathway's slides that are no longer in the talk. */
  slideIds?: string[]
  missing?: string[]
}

type Slim = (html: string) => string | Promise<string>

const load = async <T>(compilerDir: string, file: string): Promise<T> => (await import(pathToFileURL(join(compilerDir, file)).href)) as T

/**
 * A Run's handout from its compiled deck: the self-contained page, and (`lazyAssets`) the page that
 * loads its slide media lazily. A Run handout never lists a talk's `{prework}` steps as slides, and
 * carries no pre-work form (work-files ticket 16: pre-work and post-work have pages of their own).
 */
export async function buildRunHandoutHtml(
  compilerDir: string, source: RunHandoutSource,
  options: { slug: string; workerBaseUrl: string; lazyAssets?: boolean },
): Promise<{ html: string; lazyHtml?: string; slides: Array<{ id: string; html: string; notes: string }>; styles: string }> {
  const { extractStyles, extractSlides } = await load<{ extractStyles: (html: string) => string; extractSlides: (html: string) => Array<{ id: string; html: string; notes: string }> }>(compilerDir, 'lib/04-html-extraction.mjs')
  const { buildShareHtml } = await load<{ buildShareHtml: (args: Record<string, unknown>) => string }>(compilerDir, 'lib/09-output-builders.mjs')
  const styles = extractStyles(source.html)
  const preworkIds = new Set(source.preworkSlideIds)
  const allSlides = extractSlides(source.html)
  const slides = allSlides.filter((slide) => !preworkIds.has(slide.id))
  const shareArgs = {
    title: source.title, slides, styles, includeNotes: false, slug: options.slug,
    workerBaseUrl: options.workerBaseUrl, liveTalkSlug: source.liveTalkSlug,
  }
  const html = buildShareHtml(shareArgs)
  // The published <slug>.html sits beside the home page (index.html): it links back to it.
  const lazyHtml = options.lazyAssets ? buildShareHtml({ ...shareArgs, lazyAssets: true, homeHref: './' }) : undefined
  return { html, lazyHtml, slides, styles }
}

/** Build (for a talk or a Run) and write a handout's pages. Runs in the worker; tests run it in their own process. */
export async function buildHandoutPages(job: HandoutPagesJob, slim: Slim): Promise<HandoutPagesResult> {
  const { compilerDir, talkOutDir, siteDir, slug, live, url, qr, downloadFile, handoutFile } = job
  let pages: HandoutPage[]
  let venue: VenueSource
  let slideIds: string[] | undefined
  let missing: string[] | undefined
  if (job.kind === 'talk') {
    // Build the handout HTML exactly like talk:export-handout (share-no-notes).
    const { prepareSource } = await load<{ prepareSource: (...args: unknown[]) => Promise<Record<string, unknown>> }>(compilerDir, 'lib/08-source-adapters.mjs')
    const model = await prepareSource(job.outlinePath, job.text, slug, statSync(job.outlinePath), undefined, { allowedAssetRoots: requireAllowedAssetRoots(job.assetRoots, 'The handout build') })
    // Title for the handout <title> + viewer page: prefer the outline's frontmatter `title:`
    // (the canonical deck title), like the old publisher did — model.title falls back to the slug
    // for plain-markdown decks the v1 adapter routes, which would show the slug instead of the title.
    const fmTitle = (job.outline.match(/^title:\s*["']?(.+?)["']?\s*$/m) || [])[1]
    const title = (fmTitle && fmTitle.trim()) || (model.title as string) || slug
    const fullHtml = model.fullHtml as string
    const { extractStyles, extractSlides } = await load<{ extractStyles: (html: string) => unknown; extractSlides: (html: string) => Array<{ id: string; html: string; notes: string }> }>(compilerDir, 'lib/04-html-extraction.mjs')
    const { buildShareHtml } = await load<{ buildShareHtml: (args: Record<string, unknown>) => string }>(compilerDir, 'lib/09-output-builders.mjs')
    const styles = extractStyles(fullHtml)
    // Ticket 09: pre-work steps are never slides of a handout (the evergreen one included).
    const slides = withoutPreworkSlides(extractSlides(fullHtml), model.prework as CompiledPrework | undefined)
    const license = model.license
    const shareArgs = { title, slides, styles, includeNotes: false, slug, license, workerBaseUrl: live, liveTalkSlug: slug }
    const handoutHtml = buildShareHtml(shareArgs)
    // <slug>.html links back to the home page beside it (index.html); the download file stays self-contained.
    const lazyHandoutHtml = buildShareHtml({ ...shareArgs, lazyAssets: true, homeHref: './' })
    // The home page the QR code and short link open: the handout bundle in home mode (locked design
    // 2026-10-07 "Handout 4b"), so its live layout is the handout's own live client.
    const { buildHandoutHomePageHtml } = await load<{ buildHandoutHomePageHtml: (args: Record<string, unknown>) => string }>(compilerDir, 'lib/handout-home-page.mjs')
    const homeHtml = buildHandoutHomePageHtml({
      title, slides, styles, slug, license, workerBaseUrl: live, liveTalkSlug: slug, lazyAssets: true,
      // The Download target is handed over as a file NAME; the compiler makes the relative, encoded link.
      home: { url, qr, downloadFile, ...job.homeDetails },
    })
    pages = [
      { fileName: downloadFile, html: handoutHtml, lazy: false },
      { fileName: handoutFile, html: lazyHandoutHtml },
      { fileName: 'index.html', html: homeHtml },
    ]
    venue = { title, slides, styles, license, liveTalkSlug: slug }
  } else if (job.kind === 'run') {
    // The talk compiled as the live deck is (prepareTalk: the outline's own file name for its slug).
    const talkFileSlug = basename(job.outlinePath).replace('-outline.md', '')
    const { prepareSource } = await load<{ prepareSource: (...args: unknown[]) => Promise<Record<string, unknown>> }>(compilerDir, 'lib/08-source-adapters.mjs')
    const { buildPerSlideProjections } = await load<{ buildPerSlideProjections: (model: unknown, slug: string) => PathwaySlideRow[] | null }>(compilerDir, 'lib/10-projections.mjs')
    const run = runCompileOption(job.run)
    const model = await prepareSource(job.outlinePath, job.text, talkFileSlug, statSync(job.outlinePath), job.defaults, { allowedAssetRoots: requireAllowedAssetRoots(job.assetRoots, 'The handout build'), ...(run ? { run } : {}) })
    const from = runHandoutSourceFrom(model, buildPerSlideProjections(model, talkFileSlug) ?? null, job.run, talkFileSlug, job.talkSlug)
    slideIds = from.slideIds
    missing = from.missing
    const built = await buildRunHandoutHtml(compilerDir, from.source, { slug, workerBaseUrl: live, lazyAssets: true })
    // The Run's handout as a file on this computer too, as Build Run handout writes it: only inside a
    // talk folder that is there (a vanished vault is never re-created).
    const distDir = dirname(job.distPath)
    if (!existsSync(distDir)) mkdirSync(distDir)
    writeFileSync(job.distPath, built.html, 'utf8')
    venue = { title: from.source.title, slides: built.slides, styles: built.styles, license: null, liveTalkSlug: job.talkSlug }
    // The home page (locked design 2026-10-07 "Handout 4b"): the Run's handout bundle in home mode. The day,
    // start time and event go in its navy band; a planned start ahead gives the "before the talk" layout.
    const { buildHandoutHomePageHtml } = await load<{ buildHandoutHomePageHtml: (args: Record<string, unknown>) => string }>(compilerDir, 'lib/handout-home-page.mjs')
    const homeHtml = buildHandoutHomePageHtml({
      ...venue, slug, workerBaseUrl: live, lazyAssets: true,
      home: { url, qr, downloadFile, ...job.homeDetails, prework: job.homePrework, postwork: job.homePostwork ?? null, extras: job.homeExtras ?? null },
    })
    pages = [
      { fileName: downloadFile, html: built.html, lazy: false },
      { fileName: handoutFile, html: built.lazyHtml ?? built.html },
      { fileName: 'index.html', html: homeHtml },
    ]
  } else {
    pages = job.pages
    venue = job.venue
  }

  // <slug>.html and index.html load their slide media lazily from slide-assets/ (moved out before any
  // slimming); the Download button saves <slug>-download.html, the self-contained handout, slimmed for
  // the 25 MiB/file Pages cap. Written together: new assets, then pages via temp + rename, then a prune
  // that keeps the previous publish's assets for phones still open on it.
  mkdirSync(talkOutDir, { recursive: true })
  const { publishLazyHandoutPagesAsync } = await load<{ publishLazyHandoutPagesAsync: (dir: string, pages: HandoutPage[], options: { slim: Slim }) => Promise<{ warnings: string[] }> }>(compilerDir, 'lib/handout-lazy-assets.mjs')
  const written = await publishLazyHandoutPagesAsync(talkOutDir, pages, { slim })
  const { buildVenuePageHtml, buildUnavailableVenuePageHtml } = await load<{ buildVenuePageHtml: (args: Record<string, unknown>) => string; buildUnavailableVenuePageHtml: () => string }>(compilerDir, 'lib/venue-page.mjs')
  const venueDir = join(talkOutDir, 'p')
  mkdirSync(venueDir, { recursive: true })
  writeFileSync(join(venueDir, 'index.html'), await slim(buildVenuePageHtml({
    ...venue, slug, workerBaseUrl: live, qr, handoutUrl: url,
  })), 'utf8')
  writeFileSync(join(siteDir, '404.html'), buildUnavailableVenuePageHtml(), 'utf8')
  return { warnings: written.warnings, ...(slideIds ? { slideIds, missing: missing ?? [] } : {}) }
}
