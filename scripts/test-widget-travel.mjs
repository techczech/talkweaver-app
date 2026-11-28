import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import vm from 'node:vm'
import ts from 'typescript'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { buildPerSlideProjections } from '../compiler/scripts/lib/10-projections.mjs'
import { buildShareHtml } from '../compiler/scripts/lib/09-output-builders.mjs'
import { extractSlides, extractStyles } from '../compiler/scripts/lib/04-html-extraction.mjs'
import { pathStaysInside } from '../src/main/path-containment.ts'
import { registerObjectStatusIpc } from '../src/main/object-status.ts'
import { copySlideLocalFiles, copySlideWidgetDependencies } from '../src/main/slide-local-files.ts'
import { repairSlideWidget, widgetRepairMatch, copyPastedSlideFiles } from '../src/main/widget-repair.ts'
import { createSlideSearch, normalizeSearchQuery } from '../src/main/slide-search.ts'
import { matchSlide, parseQuery, prepareFields } from '../src/shared/slide-handling/query.ts'
import { readIpcRegistration } from './lib/read-ipc-registration.mjs'

import { buildHandoutPages } from '../src/main/handout-pages.ts'
import { buildSharedTalkPayload } from '../src/main/shared-talk-build.ts'
import { MAX_PUSH_BODY_BYTES } from '../worker/shared-talk-route.ts'
import { PAGE_FILE_LIMIT } from '../compiler/scripts/lib/handout-lazy-assets.mjs'
import { WIDGET_MEDIA_OMITTED_NOTE } from '../compiler/scripts/lib/embed-frame.mjs'
import { forkNodeCompileChild } from './lib/node-compile-child.mjs'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'tw-widget-travel-')))
try {
  const source = join(root, 'source', 'source-outline.md')
  const target = join(root, 'target', 'target-outline.md')
  const repair = join(root, 'repair', 'repair-outline.md')
  const widgetRef = 'widgets/example.html'
  const sourceBlock = '### A reused slide\n{id=sample} {from=source}\n\n[Simulation: widgets/example.html]\n'
  const insideScript = 'document.querySelector("h1").textContent = "Widget script ran";'
  const widget = '<title>Interactive Decision Map</title><link rel="stylesheet" href="css/main.css"><h1>Loading</h1><script src="script.js"></script><img src="outside.svg">'
  function put(path, text) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
  }
  put(source, sourceBlock)
  put(join(dirname(source), widgetRef), widget)
  put(join(dirname(source), 'widgets/script.js'), insideScript)
  put(join(dirname(source), 'widgets/css/main.css'), 'h1 { background-image: url(../shape.svg); }')
  put(join(dirname(source), 'widgets/shape.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  put(join(root, 'outside.svg'), '<svg>outside sentinel</svg>')
  symlinkSync(join(root, 'outside.svg'), join(dirname(source), 'widgets/outside.svg'))
  put(target, '# Target\n')
  put(join(dirname(target), 'widgets/script.js'), 'different bytes already in target')

  // Run the handler the Slide Browser calls, with actual talks and the real file copier.
  let materialize
  const registration = readIpcRegistration('talk:materialize-slide-assets')
  vm.runInNewContext(ts.transpileModule(registration, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
    basename, dirname, extname, join, createHash, existsSync, readFileSync, writeFileSync, pathStaysInside, copySlideLocalFiles,
    writableRootFor: () => root, outlineRefused: () => null,
    editorWindows: new Map([[1, { outlinePath: target }]]),
    mkdirInVault: (_root, dir) => mkdirSync(dir, { recursive: true }),
    ipcMain: { handle: (_name, callback) => { materialize = callback } }
  })
  const inserted = await materialize({ sender: { id: 1 } }, source, sourceBlock, target)
  assert.equal(inserted.success, true, inserted.error)
  const copiedRef = inserted.markdown.match(/\[Simulation: ([^\]]+)\]/)[1]
  assert.notEqual(copiedRef, widgetRef, 'a collision moves the whole dependency graph')
  const copiedDir = dirname(join(dirname(target), copiedRef))
  assert.equal(readFileSync(join(dirname(target), 'widgets/script.js'), 'utf8'), 'different bytes already in target')
  assert.equal(readFileSync(join(copiedDir, 'script.js'), 'utf8'), insideScript)
  assert.equal(readFileSync(join(copiedDir, 'example.html'), 'utf8'), widget)
  assert.ok(existsSync(join(copiedDir, 'css/main.css')))
  assert.ok(existsSync(join(copiedDir, 'shape.svg')))
  assert.ok(!existsSync(join(copiedDir, 'outside.svg')))
  assert.equal((await materialize({ sender: { id: 1 } }, source, sourceBlock, target)).markdown, inserted.markdown, 'repeat reuses the same copy')
  const existingRef = await materialize({ sender: { id: 2 } }, source, sourceBlock, target)
  assert.equal(existingRef.success, false, 'other windows cannot copy into the target')
  put(target, inserted.markdown)
  const deck = await prepareSource(target, inserted.markdown, 'Target', statSync(target))
  assert.doesNotMatch(deck.fullHtml, /Missing embed:/)
  assert.match(deck.fullHtml, /data:text\/javascript;base64,/)
  assert.match(deck.fullHtml, /data:text\/css;base64,/)
  assert.ok(deck.fullHtml.includes(Buffer.from(insideScript).toString('base64')))
  assert.ok(!deck.fullHtml.includes(Buffer.from('<svg>outside sentinel</svg>').toString('base64')))
  const share = buildShareHtml({ title: 'Target', slug: 'target', includeNotes: false, slides: extractSlides(deck.fullHtml), styles: extractStyles(deck.fullHtml) })
  assert.ok(share.includes(Buffer.from(insideScript).toString('base64')))

  // The agent Scratchpad importer first places the page with the checked HTML-file copy.
  const scratchTarget = join(root, 'agent-import', 'agent-import-outline.md')
  put(scratchTarget, '# Agent import\n')
  put(join(dirname(scratchTarget), 'assets/page.html'), widget)
  assert.equal(copySlideWidgetDependencies(join(dirname(source), widgetRef), scratchTarget, 'assets/page.html'), 3)
  assert.equal(readFileSync(join(dirname(scratchTarget), 'assets/script.js'), 'utf8'), insideScript)
  assert.ok(existsSync(join(dirname(scratchTarget), 'assets/css/main.css')))

  put(repair, sourceBlock)
  const talks = [{ slug: 'source', title: 'Source talk', outlinePath: source }]
  assert.equal(copyPastedSlideFiles(root, repair, sourceBlock, talks), sourceBlock)
  assert.ok(existsSync(join(dirname(repair), 'widgets/script.js')))
  const broken = join(root, 'broken', 'broken-outline.md')
  put(broken, sourceBlock)
  const handlers = new Map()
  registerObjectStatusIpc({
    ipcMain: { handle: (key, handler) => handlers.set(key, handler) },
    currentTalkOf: (id) => id === 1 ? broken : null,
    contextFor: () => ({ talkDir: dirname(broken), vaultRoot: root, roots: [root] }),
    repairOffers: async (path, refs) => new Map(refs.flatMap(ref => {
      const match = widgetRepairMatch(root, path, readFileSync(path, 'utf8'), ref, talks)
      return !match ? [] : [[ref, 'source' in match ? { repairTitle: match.source.title } : { repairCandidates: match.candidates }]]
    })),
    repairWidget: (path, ref, title) => repairSlideWidget(root, path, readFileSync(path, 'utf8'), ref, talks, title)
  })
  const event = { sender: { id: 1 } }
  const status = await handlers.get('object:status')(event, broken, [widgetRef])
  assert.equal(status.statuses[0].repairTitle, 'Source talk')
  assert.equal(widgetRepairMatch(root, broken, sourceBlock.replace('from=source', 'from=sample'), widgetRef, talks)?.source?.title, 'Source talk')
  assert.equal(handlers.get('object:repair-widget')({ sender: { id: 2 } }, broken, widgetRef, 'Source talk'), false)
  assert.equal(handlers.get('object:repair-widget')(event, broken, widgetRef, 'Source talk'), true)
  assert.equal(readFileSync(broken, 'utf8'), sourceBlock, 'repair never edits the outline')
  assert.equal(readFileSync(join(dirname(broken), 'widgets/script.js'), 'utf8'), insideScript)
  assert.equal((await handlers.get('object:status')(event, broken, [widgetRef])).statuses[0].state, 'present')
  assert.equal(handlers.get('object:repair-widget')(event, broken, widgetRef, 'Source talk'), false, 'repair refuses a present file')

  const inherited = join(root, 'inherited', 'inherited-outline.md')
  const withoutFrom = sourceBlock.replace(' {from=source}', '')
  put(inherited, withoutFrom)
  const versions = join(root, '_SLIDE-VERSIONS', 'sample')
  assert.equal(widgetRepairMatch(root, inherited, withoutFrom, widgetRef, talks)?.source?.title, 'Source talk')
  assert.equal(repairSlideWidget(root, inherited, withoutFrom, widgetRef, talks, 'A different source'), false)
  assert.ok(!existsSync(versions), 'a repair lookup does not create a ledger')

  const second = join(root, 'another', 'another-outline.md')
  put(second, withoutFrom)
  put(join(dirname(second), widgetRef), widget)
  put(join(dirname(second), 'widgets/script.js'), 'different dependency')
  put(join(dirname(second), 'widgets/css/main.css'), 'h1 { background-image: url(../shape.svg); }')
  put(join(dirname(second), 'widgets/shape.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  talks.push({ slug: 'another', title: 'Another talk', outlinePath: second })
  assert.deepEqual(widgetRepairMatch(root, inherited, withoutFrom, widgetRef, talks), { candidates: ['Another talk', 'Source talk'] })
  assert.equal(repairSlideWidget(root, inherited, withoutFrom, widgetRef, talks), false, 'a conflicting match never copies')
  assert.equal(widgetRepairMatch(root, inherited, sourceBlock, widgetRef, talks)?.source?.title, 'Source talk', 'an explicit source wins')
  put(join(dirname(second), 'widgets/script.js'), insideScript)
  assert.equal(widgetRepairMatch(root, inherited, withoutFrom, widgetRef, talks)?.source?.title, 'Another talk', 'identical graphs allow one copy')

  // Both current talks dropped the slide id. Only the version record still ties it to the source.
  put(source, sourceBlock.replace('id=sample', 'id=other'))
  put(second, withoutFrom.replace('id=sample', 'id=other'))
  assert.equal(widgetRepairMatch(root, inherited, withoutFrom, widgetRef, talks), null)
  put(join(versions, '20261126-092000--source.md'),
    '---\nid: sample\ntalk: source\noutline: source/source-outline.md\n---\n' + sourceBlock)
  assert.equal(widgetRepairMatch(root, inherited, withoutFrom, widgetRef, talks)?.source?.title, 'Source talk')
  assert.equal(repairSlideWidget(root, inherited, withoutFrom, widgetRef, talks, 'Source talk'), true)
  assert.equal(readFileSync(inherited, 'utf8'), withoutFrom)

  // Exercise the actual read-only repair worker, including its message boundary.
  const workerTarget = join(root, 'worker-target', 'worker-target-outline.md')
  put(workerTarget, withoutFrom)
  const worker = forkNodeCompileChild(join(process.cwd(), 'src/main/widget-repair-worker.ts'))
  try {
    const offers = await new Promise((resolve, reject) => {
      worker.on('message', resolve)
      worker.on('exit', code => reject(new Error(`repair worker exited with ${code}`)))
      worker.postMessage({ vault: root, outlinePath: workerTarget, refs: [widgetRef] })
    })
    assert.deepEqual(offers.get(widgetRef), { repairTitle: 'Broken' }, 'the current same-id talk takes precedence over history')
  } finally { worker.kill() }

  // These entries used to put 20 MiB of binary media (over 26 MiB of base64) in each publish page.
  // The medium image references on the same slide also exercise the shared cap across widgets.
  const publishOutline = join(root, 'publish-source', 'publish-source-outline.md')
  const publishDir = dirname(publishOutline)
  const mib = 1024 * 1024
  const outline = [
    '# Heavy widgets', '', '### Media widgets {id=heavy}', '',
    '[Simulation: widgets/video.html]', '', '[Embed: widgets/audio.html]', '',
    '### SVG figure {id=figure}', '', '![SVG widget](widgets/extra.svg)', ''
  ].join('\n')
  put(publishOutline, outline)
  put(join(publishDir, 'widgets/video.html'), '<title>Video widget</title><video src="large.mp4"></video><img src="medium.png">')
  put(join(publishDir, 'widgets/audio.html'), '<title>Audio widget</title><audio src="large.mp3"></audio><img src="medium.png">')
  put(join(publishDir, 'widgets/extra.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><image href="other.png"/></svg>')
  put(join(publishDir, 'widgets/large.mp4'), Buffer.alloc(10 * mib, 17))
  put(join(publishDir, 'widgets/large.mp3'), Buffer.alloc(10 * mib, 18))
  put(join(publishDir, 'widgets/medium.png'), Buffer.alloc(4 * mib, 19))
  put(join(publishDir, 'widgets/other.png'), Buffer.alloc(4 * mib, 20))
  const siteDir = join(root, 'site')
  const talkOutDir = join(siteDir, 'widgets')
  const published = await buildHandoutPages({
    kind: 'talk', outlinePath: publishOutline, outline, text: outline, assetRoots: [root],
    compilerDir: join(process.cwd(), 'compiler/scripts'), siteDir, talkOutDir,
    slug: 'widgets', live: '', url: 'https://example.org/widgets/', qr: '',
    downloadFile: 'widgets-download.html', handoutFile: 'widgets.html', homeDetails: {}
  }, async html => html)
  assert.ok(published.warnings.some(warning => warning.startsWith('widget-media-omitted:')))
  for (const page of ['index.html', 'widgets.html', 'widgets-download.html', 'p/index.html']) {
    assert.ok(statSync(join(talkOutDir, page)).size < PAGE_FILE_LIMIT, page)
  }
  const download = readFileSync(join(talkOutDir, 'widgets-download.html'), 'utf8')
  assert.doesNotMatch(download, /data:(?:audio\/mpeg|video\/mp4);base64,/)
  assert.equal(download.split('class="embed-media-warning"').length - 1, 2, 'both published widget cards show the warning')
  assert.ok(download.includes(WIDGET_MEDIA_OMITTED_NOTE))
  assert.equal(download.split('data:image/png;base64,' + Buffer.alloc(30, 19).toString('base64')).length - 1, 1, 'ordinary widget resources also share a deck-wide allowance')
  assert.ok(download.includes('class="widget-media-warning"'), 'SVG dependencies use the same allowance')

  const { html, slides } = await buildSharedTalkPayload({
    compilerDir: join(process.cwd(), 'compiler/scripts'), outlinePath: publishOutline,
    content: outline, allowedAssetRoots: [root], slug: 'widgets', ownerName: 'Author', proposals: true
  })
  assert.ok(Buffer.byteLength(JSON.stringify({ revision: 1, html, slides })) < MAX_PUSH_BODY_BYTES,
    'the shared-talk push with both heavy widgets fits the Worker’s limit')

  const plain = prepareFields({ title: 'Simulation theory', body: 'Discussion' })
  assert.equal(matchSlide(plain, parseQuery('widget:')), false)
  const chat = prepareFields({ title: 'Example', body: '```chat\nUser: hi\nBot: hello\n```' })
  assert.equal(matchSlide(chat, parseQuery('widget:simulation')), true)
  const projections = await prepareSource(target, inserted.markdown, 'Target', statSync(target), undefined, { projectionsOnly: true })
  const rows = buildPerSlideProjections(projections, 'target')
  const search = createSlideSearch({ imageText: { generation: () => 0, textLower: () => '' } })
  for (const query of ['widget:', 'simulation', 'example.html', 'interactive decision map', 'widget:decision map']) {
    const hits = await search.scan({
      query: normalizeSearchQuery(query), talks: [target],
      includeMatch: true,
      load: async () => ({ key: target, freshness: '1', rows, imageRefsFor: () => [], resolveImages: () => [] })
    })
    const hit = hits.find(({ row }) => row.widget_titles?.includes('Interactive Decision Map'))
    assert.ok(hit?.matchEvidence?.fields.widget, query)
    if (query.startsWith('widget:')) assert.equal(hit.titleHit, false, query)
  }
  console.log('PASS widget transfer, collision, export, repair and search')
} finally {
  rmSync(root, { recursive: true, force: true })
}
