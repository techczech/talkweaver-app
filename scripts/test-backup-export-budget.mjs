// Ticket 11 — "Backup export never exhausts the main process".
//
// The installed app died ~13.6s after launch with an OOM in the MAIN process: the startup backup
// sweep compiled a deck whose 208MB of local video was base64-inlined into a 433MB HTML string,
// and four copies of it were live at once (2.28GB of strings). These gates fix the three separate
// causes: an unbounded per-deck inline budget, a sweep that could hold more than one deck's HTML,
// and a deck with no size ceiling at all.
import { strict as assert } from 'node:assert'
import { mkdtemp, mkdir, writeFile, rm, stat, readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const MB = 1024 * 1024
const adaptersUrl = pathToFileURL(join(process.cwd(), 'compiler/scripts/lib/08-source-adapters.mjs')).href
const { prepareSource, BACKUP_EXPORT_MEDIA_OPTIONS, THUMBNAIL_MEDIA_OPTIONS, createMediaInlineBudget } =
  await import(adaptersUrl)
const { createBackupSweep } = await import(pathToFileURL(join(process.cwd(), 'src/main/backup-sweep.mjs')).href)

const base = await mkdtemp(join(tmpdir(), 'tw-backup-budget-'))
let failures = 0
const check = (name, fn) => fn().then(
  () => console.log(`ok   ${name}`),
  (error) => { failures++; console.error(`FAIL ${name}\n     ${error?.message ?? error}`) }
)

// A synthetic video: the compiler only stats and base64s these bytes, it never decodes them, so
// zero-filled bytes of the right SIZE exercise the budget exactly as a real clip would.
async function makeDeck(name, videos) {
  const dir = join(base, name)
  await mkdir(join(dir, 'assets'), { recursive: true })
  const lines = ['---', `title: ${name}`, '---', '']
  for (const [index, sizeBytes] of videos.entries()) {
    const file = `clip-${index}.mp4`
    await writeFile(join(dir, 'assets', file), Buffer.alloc(sizeBytes))
    lines.push(`### Slide ${index + 1}`, '', `![Clip ${index}](assets/${file})`, '')
  }
  const outlinePath = join(dir, `${name}-outline.md`)
  await writeFile(outlinePath, lines.join('\n'), 'utf8')
  return outlinePath
}

async function compile(outlinePath, options) {
  const text = await readFile(outlinePath, 'utf8')
  const sourceStat = await stat(outlinePath)
  return prepareSource(outlinePath, text, null, sourceStat, {}, options)
}

const assetOnlyWarnings = (model) => (model.warnings ?? []).filter((w) => String(w).startsWith('video-asset-only'))
const budgetWarnings = (model) => (model.warnings ?? []).filter((w) => String(w).startsWith('media-budget-exhausted'))
const inlinedVideoCount = (model) => (String(model.fullHtml).match(/src="data:video\//g) ?? []).length

// The irreducible per-deck runtime (reveal + CSS + fonts) that no media budget can shrink.
let shellBytes = 0

try {
  const shellDeck = await makeDeck('text-only', [])
  shellBytes = (await compile(shellDeck, {})).fullHtml.length

  // ── 1. The unchanged path: default options still inline a 12MB clip ────────────────────────
  // The present/preview/publish paths must be untouched by this ticket. 12MB is under the
  // standing 20MB per-video default (ADR-0028), so it inlines exactly as it does today.
  const twelve = await makeDeck('twelve-mb', [12 * MB])
  await check('default options inline a 12MB video (present/preview/publish unchanged)', async () => {
    const model = await compile(twelve, {})
    assert.equal(inlinedVideoCount(model), 1, 'the 12MB video should be base64-inlined by default')
    assert.deepEqual(assetOnlyWarnings(model), [], 'no asset-only warning on the default path')
    assert(model.fullHtml.length > 12 * MB, 'inlined HTML must carry the video bytes')
  })

  // ── 2. Backup options refuse it, and the HTML collapses ────────────────────────────────────
  // Size is measured against the EMPTY-DECK SHELL, not a flat byte count: every deck carries a
  // ~1.26MB runtime (reveal + CSS + fonts) that no budget can remove, so "small" can only mean
  // "the shell plus a reference, not the shell plus a video". (The parcel asked for "under 1MB";
  // that is below the shell itself and unreachable for any deck — see the report.)
  await check('backup options make a 12MB video asset-only and add almost nothing to the shell', async () => {
    const model = await compile(twelve, BACKUP_EXPORT_MEDIA_OPTIONS)
    const inlined = await compile(twelve, {})
    assert.equal(inlinedVideoCount(model), 0, 'no video may be inlined under the backup budget')
    assert.equal(assetOnlyWarnings(model).length, 1, 'the refusal reports the existing video-asset-only warning')
    assert.match(model.fullHtml, /src="assets\/clip-0\.mp4"/, 'the video is referenced by relative path')
    assert(
      model.fullHtml.length < shellBytes + 64 * 1024,
      `backup HTML must be the shell plus a reference, got ${model.fullHtml.length} vs a ${shellBytes}-byte shell`
    )
    assert(
      model.fullHtml.length < inlined.fullHtml.length * 0.1,
      'the backup HTML must be a small fraction of the inlined one'
    )
  })

  // ── 3. The per-deck budget stops the third of three 30MB videos ────────────────────────────
  // Per-video limit raised above 30MB so ONLY the deck budget can refuse: 30+30 = 60MB fits the
  // 64MB budget, the third would take it to 90MB and is refused.
  const three = await makeDeck('three-thirty', [30 * MB, 30 * MB, 30 * MB])
  await check('the per-deck budget is spent after the second of three 30MB videos', async () => {
    const model = await compile(three, { videoInlineLimitBytes: 64 * MB, mediaInlineBudgetBytes: 64 * MB })
    assert.equal(inlinedVideoCount(model), 2, 'exactly two videos fit the 64MB deck budget')
    assert.equal(assetOnlyWarnings(model).length, 1, 'the third video is refused with a warning')
    assert.match(model.fullHtml, /src="assets\/clip-2\.mp4"/, 'the refused video is referenced by relative path')
  })

  await check('an unset deck budget inlines all three (the budget is opt-in)', async () => {
    const model = await compile(three, { videoInlineLimitBytes: 64 * MB })
    assert.equal(inlinedVideoCount(model), 3, 'no budget means no refusal')
  })

  // ── 4. The sweep refuses an oversized deck instead of compiling it ──────────────────────────
  await check('the sweep skips a talk whose assets exceed the ceiling and records it', async () => {
    const compiled = []
    const backedUp = []
    const sweep = createBackupSweep({
      assetsCeilingBytes: 100 * MB,
      assetBytesOf: (p) => (p.includes('huge') ? 208 * MB : 1 * MB),
      buildHtml: async () => '<html>deck</html>',
      writeFile: (dest) => compiled.push(dest),
      onExported: (slug) => backedUp.push(slug),
      ensureDir: () => {},
      log: () => {}
    })
    const run = await sweep.run({
      folder: '/backups',
      talks: [
        { slug: 'small', outlinePath: '/vault/small/small-outline.md' },
        { slug: 'huge', outlinePath: '/vault/huge/huge-outline.md' },
        { slug: 'also-small', outlinePath: '/vault/also/also-outline.md' }
      ]
    })
    assert.equal(run.exported, 2, 'the two small talks still export')
    assert.equal(run.failed, 0, 'refusing an oversized deck is not a failure')
    assert.equal(run.skippedTalks.length, 1, 'the oversized talk is recorded')
    assert.equal(run.skippedTalks[0].slug, 'huge')
    assert.match(run.skippedTalks[0].reason, /too large|ceiling|208/i, 'the reason names the size problem')
    assert(!compiled.some((d) => d.includes('huge')), 'the oversized deck is never compiled or written')
    // Bookkeeping: a skipped talk records no backup, so it is retried on the next save or launch.
    assert.deepEqual(backedUp, ['small', 'also-small'], 'only exported talks record a backup')
  })

  // ── 5. One deck in memory at a time ────────────────────────────────────────────────────────
  await check('the sweep holds at most one deck HTML live at a time', async () => {
    let live = 0
    let peak = 0
    const sweep = createBackupSweep({
      assetBytesOf: () => 1024,
      buildHtml: async () => {
        live++
        peak = Math.max(peak, live)
        await new Promise((r) => setTimeout(r, 1))
        return '<html>deck</html>'
      },
      // The written HTML is released the moment it is handed over: the sweep must not keep it.
      writeFile: () => { live-- },
      ensureDir: () => {},
      log: () => {}
    })
    const run = await sweep.run({
      folder: '/backups',
      talks: Array.from({ length: 5 }, (_, i) => ({ slug: `t${i}`, outlinePath: `/vault/t${i}/t${i}-outline.md` }))
    })
    assert.equal(run.exported, 5)
    assert.equal(peak, 1, `at most one deck HTML may be live, peaked at ${peak}`)
  })

  // ── 6. Failure isolation ───────────────────────────────────────────────────────────────────
  await check('a throw in one talk is caught, recorded, and does not stop the run', async () => {
    const backedUp = []
    const sweep = createBackupSweep({
      assetBytesOf: () => 1024,
      buildHtml: async (p) => { if (p.includes('boom')) throw new Error('compiler exploded'); return '<html>ok</html>' },
      writeFile: () => {},
      onExported: (slug) => backedUp.push(slug),
      ensureDir: () => {},
      log: () => {}
    })
    const run = await sweep.run({
      folder: '/backups',
      talks: [
        { slug: 'a', outlinePath: '/vault/a/a-outline.md' },
        { slug: 'boom', outlinePath: '/vault/boom/boom-outline.md' },
        { slug: 'c', outlinePath: '/vault/c/c-outline.md' }
      ]
    })
    assert.equal(run.exported, 2, 'the talks either side of the throw still export')
    assert.equal(run.failed, 1, 'the throwing talk is counted as failed')
    assert.equal(run.skippedTalks.some((s) => s.slug === 'boom'), true, 'the failure is recorded with its slug')
    assert.match(run.skippedTalks.find((s) => s.slug === 'boom').reason, /compiler exploded/, 'the reason carries the error')
    assert(!backedUp.includes('boom'), 'a failed talk records no backup')
  })

  // ── 7. The backup option contract ──────────────────────────────────────────────────────────
  await check('the backup export options are the documented defaults', async () => {
    assert.equal(BACKUP_EXPORT_MEDIA_OPTIONS.videoInlineLimitBytes, 0, 'backups never inline video')
    assert.equal(BACKUP_EXPORT_MEDIA_OPTIONS.mediaInlineBudgetBytes, 16 * MB, '16MB per deck, images only')
    assert.equal(BACKUP_EXPORT_MEDIA_OPTIONS.largeMediaMode, 'poster', 'backups fall back to the poster')
  })

  // The standing invariant, stated as bluntly as it can be: whatever a deck's video weighs, a
  // backup of it contains no video bytes. This is what makes the export size bounded by the
  // images alone, and it is the assertion to keep if every other one in this file is rewritten.
  await check('a backup of a deck with video contains no data:video/ at all', async () => {
    const mixed = await makeDeck('mixed-media', [1 * MB, 12 * MB, 30 * MB])
    const model = await compile(mixed, BACKUP_EXPORT_MEDIA_OPTIONS)
    assert.equal(inlinedVideoCount(model), 0, 'not one video may be inlined into a backup')
    assert(!model.fullHtml.includes('data:video/'), 'the backup HTML carries no video data URI anywhere')
    assert.equal(assetOnlyWarnings(model).length, 3, 'every video is reported as an external asset')
    // Even the 1MB clip — well under any per-file limit that ever applied — stays out.
    assert.match(model.fullHtml, /src="assets\/clip-0\.mp4"/, 'the smallest clip is a reference too')
  })

  // ── 7b. The thumbnail contract (2026-09-15 main-process OOM) ────────────────────────────────
  // Same mechanism, a third entry point. The Slide Browser's background sweep prepares every talk
  // whose prints are missing; with the standing defaults it inlined every clip under 20MB of all
  // 84 vault talks and took the main process to 3.9GB against a 4096MB ceiling. A thumbnail shows
  // a POSTER — the capture settles on the poster frame — so it has never needed a video byte.
  // Unlike a backup, it DOES need the pictures, so images stay unbounded here.
  await check('the thumbnail budget refuses every video and allows every image', async () => {
    const budget = createMediaInlineBudget(THUMBNAIL_MEDIA_OPTIONS)
    assert.equal(budget.allowsVideo(1), false, 'not one byte of video may be inlined into a thumbnail render')
    assert.equal(budget.allowsVideo(102 * MB), false, 'nor the 102MB of clips in the heaviest vault deck')
    assert.equal(budget.allowsImage(44 * MB), true, 'images are unbounded — the pictures are the thumbnail')
    assert.equal(budget.bounded, false, 'no per-deck ceiling means no extra stat() per image')
    assert.equal(budget.largeMediaMode, 'poster', 'a refused video renders its poster frame')
    assert.equal(THUMBNAIL_MEDIA_OPTIONS.mediaInlineBudgetBytes, undefined, 'deliberately no image budget')
  })

  await check('a thumbnail compile of a video deck carries no video bytes at all', async () => {
    const clips = await makeDeck('thumbnail-clips', [1 * MB, 12 * MB, 30 * MB])
    const model = await compile(clips, THUMBNAIL_MEDIA_OPTIONS)
    assert.equal(inlinedVideoCount(model), 0, 'not one video may be inlined for a thumbnail')
    assert(!model.fullHtml.includes('data:video/'), 'no video data URI anywhere in the deck HTML')
    assert(
      model.fullHtml.length < shellBytes + 64 * 1024,
      `thumbnail HTML must be the shell plus references, got ${model.fullHtml.length} vs a ${shellBytes}-byte shell`
    )
    const inlined = await compile(clips, {})
    assert.equal(inlinedVideoCount(inlined), 2, 'the default path still inlines the two clips under the 20MB limit')
    assert(inlined.fullHtml.length > 15 * MB, 'the default path still carries their bytes (the regression baseline)')
  })

  await check('a thumbnail compile still inlines the pictures', async () => {
    // A 3MB PNG: the compiler stats and base64s the bytes and parses the IHDR header for intrinsic
    // dimensions — it never decodes the pixels, so a valid header over zero-filled bytes is enough.
    const dir = join(base, 'thumbnail-images')
    await mkdir(join(dir, 'assets'), { recursive: true })
    const png = Buffer.alloc(3 * MB)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0)
    png.write('IHDR', 12, 'ascii')
    png.writeUInt32BE(1280, 16)
    png.writeUInt32BE(720, 20)
    await writeFile(join(dir, 'assets', 'shot.png'), png)
    const outlinePath = join(dir, 'thumbnail-images-outline.md')
    await writeFile(outlinePath, ['---', 'title: thumbnail-images', '---', '', '### Slide 1', '',
      '![Shot](assets/shot.png)', ''].join('\n'), 'utf8')
    const model = await compile(outlinePath, THUMBNAIL_MEDIA_OPTIONS)
    assert.match(model.fullHtml, /data:image\/png;base64,/, 'the picture must be inlined — it IS the thumbnail')
    assert(model.fullHtml.length > 3 * MB, 'and its bytes must actually be present')
  })

  // ── 8. One mechanism, two entry points ─────────────────────────────────────────────────────
  // The --video-inline-limit CLI flag and the videoInlineLimitBytes option must resolve through
  // the same budget, so the flag can never drift from the in-process path.
  await check('the CLI flag and the option resolve to the same per-video mechanism', async () => {
    const source = readFileSync('compiler/scripts/lib/08-source-adapters.mjs', 'utf8')
    const start = source.indexOf('function createMediaInlineBudget')
    assert(start > 0, 'a single budget factory exists')
    const factory = source.slice(start, source.indexOf('\n}', start))
    // The option overrides the CLI-derived constant INSIDE one factory, so the two entry points
    // cannot drift: there is exactly one place a per-video limit is ever decided.
    assert.match(factory, /options\.videoInlineLimitBytes/, 'the option is read here')
    assert.match(factory, /VIDEO_INLINE_LIMIT_BYTES/, 'and falls back to the CLI flag constant here')
    assert.equal(
      source.split('VIDEO_INLINE_LIMIT_BYTES').length - 1,
      2,
      'the per-video constant is declared once and consumed once — only inside the budget factory'
    )
  })
} finally {
  await rm(base, { recursive: true, force: true })
}

if (failures) {
  console.error(`\n${failures} backup-export-budget check(s) failed`)
  process.exit(1)
}
console.log('\nbackup export budget: all checks passed')
