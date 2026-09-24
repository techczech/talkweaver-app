// Exporting a batch of talks to the backup folder, lifted out of the Electron main process so it
// can be run and proven by plain node (Ticket 11 + ADR-0024, 2026-09-12).
//
// It is handed an explicit list of talks — the ENROLLED ones (see backup-scope.mjs). It never
// scans the vault and is never driven by a timer: that design is what the 2026-09-11 incident
// killed. What survives from it are the two memory rules, which matter just as much for two talks
// as for thirty-two because one talk alone was enough to exhaust the heap:
//
//   1. One deck's HTML in memory at a time. exportOneTalk owns the only reference to `html`; it
//      hands the string to writeFile and returns a size, so the string is unreachable the moment
//      the call returns. The loop is strictly serial and yields to the event loop between talks.
//   2. A deck that is simply too big is refused BEFORE it is compiled, not after it has already
//      allocated. The ceiling is measured from the assets folder on disk, which costs a few stats.
//
// The media budget itself (8MB/video, 64MB/deck) lives in the compiler's prepareSource options —
// see BACKUP_EXPORT_MEDIA_OPTIONS in 08-source-adapters.mjs.
//
// Every dependency is injected, so nothing here imports Electron or touches a real vault.
export const BACKUP_ASSETS_CEILING_BYTES = 512 * 1024 * 1024

const MB = 1024 * 1024
const asMb = (bytes) => Math.round(bytes / MB)

export function createBackupSweep({
  buildHtml,
  assetBytesOf,
  writeFile,
  ensureDir,
  onExported = () => {},
  log = console.error,
  // Injected so the caller's platform path semantics (node's join) are the ones that apply.
  destFor = joinBackupPath,
  assetsCeilingBytes = BACKUP_ASSETS_CEILING_BYTES,
  yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve))
}) {
  let running = false

  // The ONLY holder of a deck's HTML. It never returns the string and never stores it, so when
  // this function returns, that memory is collectable — which is what keeps a media-heavy vault
  // from stacking several hundred-megabyte strings in the main process.
  async function exportOneTalk(outlinePath, dest) {
    const html = await buildHtml(outlinePath)
    if (!html) return { ok: false, bytes: 0 }
    writeFile(dest, html)
    return { ok: true, bytes: html.length }
  }

  // `talks` is the explicit, already-decided list: [{ slug, outlinePath }]. Deciding WHICH talks
  // belong here is backup-scope.mjs's job, never this module's.
  async function run({ folder, talks }) {
    if (running) return { at: Date.now(), ok: false, exported: 0, skipped: 0, failed: 0, skippedTalks: [], error: 'busy' }
    running = true
    let exported = 0
    let skipped = 0
    let failed = 0
    const skippedTalks = []
    try {
      ensureDir(folder)
      for (const talk of talks) {
        try {
          const dest = destFor(folder, talk.slug)
          // Refuse before compiling. A deck over the ceiling is not a failure — it is a deck we
          // decline to inline today, and it stays declined cheaply every time until it shrinks.
          const assetBytes = assetBytesOf(talk.outlinePath)
          if (assetBytes > assetsCeilingBytes) {
            skipped++
            const reason = `Assets are too large to back up: ${asMb(assetBytes)}MB exceeds the ${asMb(assetsCeilingBytes)}MB ceiling.`
            skippedTalks.push({ slug: talk.slug, reason })
            log(`[backup] skipped ${talk.slug}: ${reason}`)
            // No backup timestamp is recorded, so the talk is retried on the next save or launch
            // and refused again for the price of a few stat() calls — until the deck shrinks, at
            // which point it exports on its own without anyone clearing state by hand.
            continue
          }
          const result = await exportOneTalk(talk.outlinePath, dest)
          if (!result.ok) {
            failed++
            skippedTalks.push({ slug: talk.slug, reason: 'The compiler produced no HTML for this talk.' })
            continue
          }
          onExported(talk.slug, result.bytes)
          exported++
        } catch (error) {
          // Failure isolation: one bad talk must never end the run for the others.
          failed++
          skippedTalks.push({ slug: talk.slug, reason: String(error?.message ?? error) })
          log(`[backup] ${talk.slug} failed: ${error?.message ?? error}`)
        }
        // Hand the main process back to the UI between decks. Without this a multi-talk run is
        // one uninterrupted stretch of synchronous compiles and the window is frozen throughout.
        await yieldToEventLoop()
      }
      return { at: Date.now(), ok: failed === 0, exported, skipped, failed, skippedTalks, folder }
    } catch (error) {
      return { at: Date.now(), ok: false, exported, skipped, failed, skippedTalks, error: String(error), folder }
    } finally {
      running = false
    }
  }

  return { run, exportOneTalk }
}

// Files are named `<slug>-backup.html` so they can never be mistaken for the originals.
export function joinBackupPath(folder, slug) {
  const separator = folder.endsWith('/') || folder.endsWith('\\') ? '' : '/'
  return `${folder}${separator}${slug}-backup.html`
}
