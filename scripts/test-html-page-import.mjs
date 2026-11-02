// Insert › HTML page… — the write boundary (src/main/html-page-import.ts). Seam: the two handlers
// registerHtmlPageImportIpc installs, driven with a fake ipcMain and a scripted picker over real temp
// folders, plus the compiler reading the line that comes back. What is under test is what lands on
// disk: Cancel and every refusal write nothing; a page from outside the talk is copied byte for byte
// into its assets folder; an existing file is never replaced; the talk named at choose time is the
// only one written to; and the reference compiles to the inlined page.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  HTML_PAGE_MAX_BYTES, checkHtmlPageSource, importHtmlPage, localReferencesOf, registerHtmlPageImportIpc, safePageFileName
} from '../src/main/html-page-import.ts'
import { runImportHere } from './lib/html-page-import-here.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const base = realpathSync(mkdtempSync(join(tmpdir(), 'tw-html-page-')))
process.on('exit', () => rmSync(base, { recursive: true, force: true }))
let passed = 0
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ok  ${name}`) } catch (err) { console.error(`  FAIL ${name}`); throw err }
}

/** main's checks, then the copy run in the talk folder (as the app's import process runs it), with `fs` as its file system. */
const imp = (target, source, fs) => importHtmlPage(target, source, async (job) => runImportHere(job, fs))

let n = 0
/** A vault with one talk, and a folder outside it holding the user's pages. */
function fixture() {
  const root = join(base, `case-${++n}`)
  const vault = join(root, 'vault')
  const talkDir = join(vault, 'talks', 'energy')
  mkdirSync(talkDir, { recursive: true })
  const outline = join(talkDir, 'energy-outline.md')
  writeFileSync(outline, '# Energy\n\n### Map\n\nUnsaved text lives in the editor, not here.\n')
  const outside = join(root, 'materials')
  mkdirSync(outside, { recursive: true })
  return { root, vault, talkDir, outline, outside }
}
const page = (title = 'Map') => `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}-MARKER</h1><script>let ü = "é"</script></body></html>`
const listing = (dir) => (existsSync(dir) ? readdirSync(dir).sort() : [])

/** The handlers over a fake ipcMain; `pick` scripts the picker (null = Cancel); `roots` maps a talk to its writable root. */
function harness({ pick = () => null, roots = () => undefined, now = () => 1000, platform } = {}) {
  const handlers = new Map()
  const opened = []
  registerHtmlPageImportIpc({
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    dialog: { showOpenDialog: async (...args) => { opened.push(args.at(-1)); const p = pick(); return p ? { canceled: false, filePaths: [p] } : { canceled: true, filePaths: [] } } },
    windowOf: () => null,
    writableTalkRoot: (outlinePath) => roots(outlinePath),
    runImport: async (job) => runImportHere(job),
    now: () => now(),
    ...(platform ? { platform } : {})
  })
  const call = (sender, channel, ...args) => handlers.get(channel)({ sender: { id: sender } }, ...args)
  return { opened, choose: (outline, sender = 1) => call(sender, 'talk:choose-html-page', outline), importPage: (token, outline, sender = 1) => call(sender, 'talk:import-html-page', token, outline) }
}

console.log('HTML page import (write boundary)')

await test('the picker opens for one file, HTML only, and Cancel writes nothing', async () => {
  const f = fixture()
  const before = readFileSync(f.outline, 'utf8')
  const h = harness({ pick: () => null, roots: () => f.vault })
  assert.equal(await h.choose(f.outline), null)
  assert.deepEqual(h.opened[0].properties, ['openFile'])
  assert.deepEqual(h.opened[0].filters, [{ name: 'HTML pages', extensions: ['html', 'htm'] }])
  assert.equal(existsSync(join(f.talkDir, 'assets')), false, 'no assets folder is made by choosing')
  assert.equal(readFileSync(f.outline, 'utf8'), before)
})

await test('choosing writes nothing; importing copies the page byte for byte into the talk’s assets folder', async () => {
  const f = fixture()
  const source = join(f.outside, 'energy-domain-map.html')
  const bytes = Buffer.from(page('Energy'), 'utf8')
  writeFileSync(source, bytes)
  const h = harness({ pick: () => source, roots: () => f.vault })
  const choice = await h.choose(f.outline)
  assert.equal(choice.ok, true)
  assert.equal(choice.fileName, 'energy-domain-map.html')
  assert.deepEqual(listing(f.talkDir), ['energy-outline.md'], 'choosing copies nothing')
  const result = await h.importPage(choice.token, f.outline)
  assert.deepEqual(result, { ok: true, embedPath: 'assets/energy-domain-map.html', how: 'copied', localReferences: [] })
  assert.ok(readFileSync(join(f.talkDir, 'assets', 'energy-domain-map.html')).equals(bytes))
  assert.ok(readFileSync(source).equals(bytes), 'the original is untouched')
})

await test('a token is used once, only by the window that chose, and only for the talk it was chosen for', async () => {
  const f = fixture()
  const other = join(f.vault, 'talks', 'other')
  mkdirSync(other, { recursive: true })
  const otherOutline = join(other, 'other-outline.md')
  writeFileSync(otherOutline, '# Other\n')
  const source = join(f.outside, 'map.html')
  writeFileSync(source, page())
  const h = harness({ pick: () => source, roots: () => f.vault })
  const a = await h.choose(f.outline)
  assert.equal((await h.importPage(a.token, f.outline, 2)).reason, 'expired', 'another window cannot redeem it')
  const b = await h.choose(f.outline)
  const stale = await h.importPage(b.token, otherOutline)
  assert.equal(stale.reason, 'talk-changed')
  assert.deepEqual(listing(other), ['other-outline.md'], 'nothing written into the talk open now')
  assert.equal(existsSync(join(f.talkDir, 'assets')), false, 'nor into the talk it was chosen for')
  assert.equal((await h.importPage(b.token, f.outline)).reason, 'expired', 'a refused token is spent')
  assert.equal((await h.importPage('made-up', f.outline)).reason, 'expired')
})

await test('a choice expires after ten minutes', async () => {
  const f = fixture()
  const source = join(f.outside, 'map.html')
  writeFileSync(source, page())
  let clock = 0
  const h = harness({ pick: () => source, roots: () => f.vault, now: () => clock })
  const choice = await h.choose(f.outline)
  clock = 10 * 60 * 1000 + 1
  assert.equal((await h.importPage(choice.token, f.outline)).reason, 'expired')
  assert.equal(existsSync(join(f.talkDir, 'assets')), false)
})

await test('the vault is resolved again at import: closed or missing while the picker was open writes nothing', async () => {
  const f = fixture()
  const source = join(f.outside, 'map.html')
  writeFileSync(source, page())
  let open = true
  const h = harness({ pick: () => source, roots: () => (open ? f.vault : undefined) })
  const choice = await h.choose(f.outline)
  open = false
  assert.equal((await h.importPage(choice.token, f.outline)).reason, 'vault-unavailable')
  assert.equal(existsSync(join(f.talkDir, 'assets')), false)
  assert.equal((await h.choose(f.outline)).reason, 'no-talk', 'no picker for a talk with no writable vault')
  assert.equal(h.opened.length, 1, 'the picker did not open the second time')
})

await test('a talk outside the vault it would be written under is refused', async () => {
  const f = fixture()
  const stray = join(f.root, 'stray')
  mkdirSync(stray)
  const strayOutline = join(stray, 'stray-outline.md')
  writeFileSync(strayOutline, '# Stray\n')
  const source = join(f.outside, 'map.html')
  writeFileSync(source, page())
  assert.equal((await imp({ root: f.vault, outlinePath: strayOutline }, source)).reason, 'outside-vault')
  assert.deepEqual(listing(stray), ['stray-outline.md'])
  const h = harness({ pick: () => source, roots: () => f.vault })
  assert.equal((await h.choose(join(f.talkDir, 'notes.md'))).reason, 'no-talk', 'only an outline file names a talk')
  assert.equal((await h.choose('relative-outline.md')).reason, 'no-talk')
})

await test('an existing file is never replaced: a different page gets the next free name, the same page is reused', async () => {
  const f = fixture()
  const assets = join(f.talkDir, 'assets')
  mkdirSync(assets)
  const unrelated = Buffer.from('<p>someone else’s page</p>')
  writeFileSync(join(assets, 'map.html'), unrelated)
  const source = join(f.outside, 'map.html')
  writeFileSync(source, page())
  const first = await imp({ root: f.vault, outlinePath: f.outline }, source)
  assert.equal(first.embedPath, 'assets/map-2.html')
  assert.equal(first.how, 'copied')
  assert.ok(readFileSync(join(assets, 'map.html')).equals(unrelated), 'the unrelated file keeps its bytes')
  const again = await imp({ root: f.vault, outlinePath: f.outline }, source)
  assert.deepEqual([again.embedPath, again.how], ['assets/map-2.html', 'reused'])
  assert.deepEqual(listing(assets), ['map-2.html', 'map.html'], 'no third copy')
  // A link occupying a candidate name is a taken name, never followed or replaced.
  writeFileSync(source, page('Changed'))
  symlinkSync(join(f.outside, 'nowhere.html'), join(assets, 'map-3.html'))
  const third = await imp({ root: f.vault, outlinePath: f.outline }, source)
  assert.equal(third.embedPath, 'assets/map-4.html')
  assert.equal(existsSync(join(f.outside, 'nowhere.html')), false, 'nothing written through the link')
})

await test('a page already in the talk’s folder is named where it is and not copied', async () => {
  const f = fixture()
  mkdirSync(join(f.talkDir, 'sims'))
  const inside = join(f.talkDir, 'sims', 'demo.html')
  writeFileSync(inside, page())
  const result = await imp({ root: f.vault, outlinePath: f.outline }, inside)
  assert.deepEqual([result.embedPath, result.how], ['sims/demo.html', 'in-talk'])
  assert.equal(existsSync(join(f.talkDir, 'assets')), false)
  // A name the Embed line cannot carry as written is copied under a safe name instead.
  const awkward = join(f.talkDir, 'odd [v2].html')
  writeFileSync(awkward, page())
  const copied = await imp({ root: f.vault, outlinePath: f.outline }, awkward)
  assert.deepEqual([copied.embedPath, copied.how], ['assets/odd-v2.html', 'copied'])
})

// Slide Scratchpad ticket 2: the same checked copy for an agent's file in the talk's scratchpad/ folder. It is
// always copied (alwaysCopy), never named where it is; an SVG keeps its .svg name; the source is never written.
await test('Slide Scratchpad: an agent page in scratchpad/ is copied into assets (never named in place), an SVG keeps .svg, the source is untouched', async () => {
  const f = fixture()
  mkdirSync(join(f.talkDir, 'scratchpad'))
  const agentPage = join(f.talkDir, 'scratchpad', 'research loop.html')
  writeFileSync(agentPage, page('Loop'))
  const before = statSync(agentPage)
  const copied = await importHtmlPage({ root: f.vault, outlinePath: f.outline }, agentPage, async (job) => runImportHere(job), undefined, undefined, { alwaysCopy: true })
  assert.deepEqual([copied.embedPath, copied.how], ['assets/research-loop.html', 'copied'])
  assert.equal(readFileSync(join(f.talkDir, 'assets', 'research-loop.html'), 'utf8'), page('Loop'))
  const again = await importHtmlPage({ root: f.vault, outlinePath: f.outline }, agentPage, async (job) => runImportHere(job), undefined, undefined, { alwaysCopy: true })
  assert.deepEqual([again.embedPath, again.how], ['assets/research-loop.html', 'reused'], 'inserting twice copies once')
  const svg = join(f.talkDir, 'scratchpad', 'chart.svg')
  const drawing = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'
  writeFileSync(svg, drawing)
  const svgCopy = await importHtmlPage({ root: f.vault, outlinePath: f.outline }, svg, async (job) => runImportHere(job), undefined, undefined, { kind: 'svg', alwaysCopy: true })
  assert.deepEqual([svgCopy.embedPath, svgCopy.how, svgCopy.localReferences], ['assets/chart.svg', 'copied', []])
  assert.equal(readFileSync(join(f.talkDir, 'assets', 'chart.svg'), 'utf8'), drawing)
  // The kind is checked by name: an SVG copy refuses an HTML file and the other way round.
  assert.equal((await importHtmlPage({ root: f.vault, outlinePath: f.outline }, agentPage, async (job) => runImportHere(job), undefined, undefined, { kind: 'svg' })).ok, false)
  assert.equal((await importHtmlPage({ root: f.vault, outlinePath: f.outline }, svg, async (job) => runImportHere(job))).ok, false)
  assert.deepEqual(listing(join(f.talkDir, 'scratchpad')), ['chart.svg', 'research loop.html'], 'nothing new in the scratch folder')
  const after = statSync(agentPage)
  assert.deepEqual([after.size, after.mtimeMs, after.ino], [before.size, before.mtimeMs, before.ino], 'the agent file is not written, moved or replaced')
  assert.equal(readFileSync(agentPage, 'utf8'), page('Loop'))
  assert.equal(safePageFileName('My Chart.SVG', 'svg'), 'My-Chart.svg')
})

// Review 2026-10-27 (second correction, P2 2): naming a page in the talk's folder where it is needs
// proof, after the read, that the path still names the file chosen. Here the chosen file is renamed
// and a link to another page put in its place the moment the read closes it.
await test('a page in the talk’s folder swapped for a link to another page just after it is read is never named: the checked bytes are copied', async () => {
  const realFs = await import('node:fs')
  for (const target of ['outside', 'inside']) {
    const f = fixture()
    const chosen = join(f.talkDir, 'page.html')
    writeFileSync(chosen, '<!doctype html><body>SELECTED-MARKER</body>')
    const other = target === 'outside' ? join(f.outside, 'other.html') : join(f.talkDir, 'other.html')
    writeFileSync(other, '<body>UNSELECTED-MARKER</body>')
    let sourceFd, swapped = false
    const racing = { ...realFs,
      openSync(path, ...args) { const fd = realFs.openSync(path, ...args); if (path === chosen) sourceFd = fd; return fd },
      closeSync(fd) { realFs.closeSync(fd); if (fd === sourceFd && !swapped) { swapped = true; realFs.renameSync(chosen, chosen + '.held'); realFs.symlinkSync(other, chosen) } }
    }
    const result = await imp({ root: f.vault, outlinePath: f.outline }, chosen, racing)
    assert.ok(swapped, 'the swap happened')
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.deepEqual([result.embedPath, result.how], ['assets/page.html', 'copied'], `link ${target}`)
    const at = join(f.talkDir, ...result.embedPath.split('/'))
    assert.equal(realpathSync(at), at, 'a plain file, not a link')
    assert.match(readFileSync(at, 'utf8'), /SELECTED-MARKER/)
    assert.doesNotMatch(readFileSync(at, 'utf8'), /UNSELECTED/)
    // And what the slide shows is the chosen page.
    const { prepareSource } = await import(pathToFileURL(join(here, '..', 'compiler', 'scripts', 'lib', '08-source-adapters.mjs')).href)
    const model = await prepareSource(f.outline, `# Energy\n\n### Map\n\n[Embed: ${result.embedPath}]\n`, 'energy', statSync(f.outline), undefined, { allowedAssetRoots: [f.vault] })
    assert.ok(model.fullHtml.includes('SELECTED-MARKER'))
    assert.ok(!model.fullHtml.includes('UNSELECTED-MARKER'))
  }
})

await test('a page in the talk’s folder replaced by another plain file just after it is read is never named', async () => {
  const realFs = await import('node:fs')
  const f = fixture()
  const chosen = join(f.talkDir, 'page.html')
  writeFileSync(chosen, '<!doctype html><body>SELECTED-MARKER</body>')
  let sourceFd, swapped = false
  const racing = { ...realFs,
    openSync(path, ...args) { const fd = realFs.openSync(path, ...args); if (path === chosen) sourceFd = fd; return fd },
    closeSync(fd) { realFs.closeSync(fd); if (fd === sourceFd && !swapped) { swapped = true; realFs.renameSync(chosen, chosen + '.held'); realFs.writeFileSync(chosen, '<body>UNSELECTED-MARKER</body>') } }
  }
  const result = await imp({ root: f.vault, outlinePath: f.outline }, chosen, racing)
  assert.ok(swapped)
  assert.notEqual(result.how, 'in-talk', JSON.stringify(result))
  if (result.ok) assert.match(readFileSync(join(f.talkDir, ...result.embedPath.split('/')), 'utf8'), /SELECTED-MARKER/)
})

await test('only regular .html/.htm files, checked where they really are', async () => {
  const f = fixture()
  const text = join(f.outside, 'notes.txt')
  writeFileSync(text, 'not a page')
  assert.equal(checkHtmlPageSource(text).reason, 'not-html')
  const disguised = join(f.outside, 'disguised.html')
  symlinkSync(text, disguised)
  assert.equal(checkHtmlPageSource(disguised).reason, 'not-html', 'a .html link to a .txt file is refused')
  const folder = join(f.outside, 'folder.html')
  mkdirSync(folder)
  assert.equal(checkHtmlPageSource(folder).reason, 'missing', 'a folder is not a page')
  const dangling = join(f.outside, 'dangling.html')
  symlinkSync(join(f.outside, 'gone.html'), dangling)
  assert.equal(checkHtmlPageSource(dangling).reason, 'missing')
  assert.equal(checkHtmlPageSource('relative.html').reason, 'missing')
  const fifo = join(f.outside, 'pipe.html')
  execFileSync('mkfifo', [fifo])
  assert.equal(checkHtmlPageSource(fifo).reason, 'missing', 'a FIFO is not a page (and is never opened)')
  const upper = join(f.outside, 'UPPER.HTM')
  writeFileSync(upper, page())
  assert.equal(checkHtmlPageSource(upper).ok, true)
  assert.equal((await imp({ root: f.vault, outlinePath: f.outline }, upper)).embedPath, 'assets/UPPER.htm')
  const real = join(f.outside, 'real.html')
  writeFileSync(real, page('Linked'))
  const link = join(f.outside, 'link.html')
  symlinkSync(real, link)
  const linked = await imp({ root: f.vault, outlinePath: f.outline }, link)
  assert.equal(linked.embedPath, 'assets/real.html', 'a link is followed to the page it names, and copied as a file')
  assert.equal(statSync(join(f.talkDir, 'assets', 'real.html')).isFile(), true)
  const big = join(f.outside, 'big.html')
  writeFileSync(big, '')
  truncateSync(big, HTML_PAGE_MAX_BYTES + 1)
  assert.equal(checkHtmlPageSource(big).reason, 'too-large')
})

await test('the source is checked again at import: swapped for something else after choosing is refused', async () => {
  const f = fixture()
  const source = join(f.outside, 'map.html')
  writeFileSync(source, page())
  const h = harness({ pick: () => source, roots: () => f.vault })
  const choice = await h.choose(f.outline)
  rmSync(source)
  writeFileSync(join(f.outside, 'secret.txt'), 'private')
  symlinkSync(join(f.outside, 'secret.txt'), source)
  assert.equal((await h.importPage(choice.token, f.outline)).reason, 'not-html')
  assert.equal(existsSync(join(f.talkDir, 'assets')), false)
})

await test('an assets folder that leads out of the vault is refused and nothing is written outside', async () => {
  const f = fixture()
  const elsewhere = join(f.root, 'elsewhere')
  mkdirSync(elsewhere)
  symlinkSync(elsewhere, join(f.talkDir, 'assets'))
  const source = join(f.outside, 'map.html')
  writeFileSync(source, page())
  assert.equal((await imp({ root: f.vault, outlinePath: f.outline }, source)).reason, 'outside-vault')
  assert.deepEqual(listing(elsewhere), [])
})

await test('file names: safe for the Embed line on every file system', async () => {
  assert.equal(safePageFileName('energy-domain-map.html'), 'energy-domain-map.html')
  assert.equal(safePageFileName('Énergie map (v2).HTML'), 'Energie-map-v2.html')
  assert.equal(safePageFileName('].html'), 'page.html')
  assert.equal(safePageFileName('..hidden.htm'), 'hidden.htm')
  assert.equal(safePageFileName(`${'x'.repeat(200)}.html`).length, 85)
})

await test('local files the page loads are named in the answer, remote and inline ones are not', async () => {
  const html = '<link rel="stylesheet" href="style.css"><script src="./app.js?v=2"></script><img src=pic.png>'
    + '<script src="https://cdn.example/x.js"></script><img src="data:image/png;base64,AAAA"><a href="other.html">link</a><img srcset="a.png 1x, b.png 2x">'
  assert.deepEqual(localReferencesOf(html), ['style.css', './app.js', 'pic.png', 'a.png'])
  const f = fixture()
  const source = join(f.outside, 'app.html')
  writeFileSync(source, `<!doctype html>${html}`)
  writeFileSync(join(f.outside, 'style.css'), 'body{}')
  const result = await imp({ root: f.vault, outlinePath: f.outline }, source)
  assert.deepEqual(result.localReferences, ['style.css', './app.js', 'pic.png', 'a.png'])
  assert.deepEqual(listing(join(f.talkDir, 'assets')), ['app.html'], 'only the page is copied, never the files beside it')
})

await test('the reference that comes back compiles to the inlined page with no warning', async () => {
  const f = fixture()
  const source = join(f.outside, 'energy-domain-map.html')
  writeFileSync(source, page('Energy'))
  const result = await imp({ root: f.vault, outlinePath: f.outline }, source)
  const { prepareSource } = await import(pathToFileURL(join(here, '..', 'compiler', 'scripts', 'lib', '08-source-adapters.mjs')).href)
  const content = `# Energy\n\n### Map\n\n[Embed: ${result.embedPath}]\n`
  const model = await prepareSource(f.outline, content, 'energy', statSync(f.outline), undefined, { allowedAssetRoots: [f.vault] })
  assert.ok(model.fullHtml.includes('Energy-MARKER'), 'the page is inlined into the deck')
  assert.deepEqual(model.warnings.filter((w) => /asset|embed/.test(w)), [], `no missing/outside warning (${model.warnings.join(', ')})`)
})

// Review round 2026-10-27 (independent review of fe58930, findings F1–F4).
await test('F1: an assets folder swapped for a link out of the vault at ANY point of the import writes nothing outside', async () => {
  // The swap is made by "another program" just before each filesystem call the import makes, one
  // call per run, so every interval between a check and the write is tried. The write itself is the
  // real one on the real filesystem.
  const fs = await import('node:fs')
  for (const existingName of [false, true]) {
    for (let at = 1; ; at++) {
      const f = fixture()
      const source = join(f.outside, 'page.html')
      writeFileSync(source, page('Raced'))
      const assets = join(f.talkDir, 'assets')
      mkdirSync(assets)
      if (existingName) writeFileSync(join(assets, 'page.html'), 'another page')
      const elsewhere = join(f.root, 'elsewhere')
      mkdirSync(elsewhere)
      if (existingName) writeFileSync(join(elsewhere, 'page.html'), 'another page')
      let calls = 0
      let swapped = false
      const racing = new Proxy(fs, {
        get(target, key) {
          const value = target[key]
          if (typeof value !== 'function') return value
          return (...args) => {
            if (++calls === at && !swapped) { swapped = true; fs.renameSync(assets, assets + '-moved'); fs.symlinkSync(elsewhere, assets) }
            return value.apply(target, args)
          }
        }
      })
      const result = await imp({ root: f.vault, outlinePath: f.outline }, source, racing)
      const outsideFiles = listing(elsewhere).filter((name) => !(existingName && name === 'page.html'))
      assert.deepEqual(outsideFiles, [], `swap before call ${at}: nothing new outside the vault (${JSON.stringify(result)})`)
      if (existingName) assert.equal(readFileSync(join(elsewhere, 'page.html'), 'utf8'), 'another page', `swap before call ${at}: the file outside is untouched`)
      // A success is honest only when the page's bytes are in a real file inside the vault (a swap
      // after the descriptor was checked renames the vault's own folder; the file stays the vault's).
      if (result.ok && result.how === 'copied') {
        const held = ['assets', 'assets-moved'].map((dir) => join(f.talkDir, dir, result.embedPath.split('/')[1]))
          .filter((path) => existsSync(path) && realpathSync(path).startsWith(f.vault + '/') && readFileSync(path, 'utf8') === page('Raced'))
        assert.ok(held.length > 0, `swap before call ${at}: the copied bytes are inside the vault (${JSON.stringify(result)})`)
      }
      if (!swapped) break
    }
  }
})

await test('F1: a write that fails after the file is created never deletes by path', async () => {
  const fs = await import('node:fs')
  const f = fixture()
  const source = join(f.outside, 'page.html')
  writeFileSync(source, page('Fails'))
  let unlinked = 0
  const failing = { ...fs, writeSync: () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }) }, writeFileSync: () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }) }, unlinkSync: () => { unlinked++ } }
  const result = await imp({ root: f.vault, outlinePath: f.outline }, source, failing)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'write-failed')
  assert.equal(unlinked, 0, 'no path is unlinked after a failed write')
})

await test('F2: a page in the talk folder whose name reads as an address is copied under a safe local name', async () => {
  const f = fixture()
  const source = join(f.talkDir, 'https:page.html')
  writeFileSync(source, page('Local-URI'))
  const result = await imp({ root: f.vault, outlinePath: f.outline }, source)
  assert.equal(result.ok, true)
  assert.ok(!result.embedPath.includes(':'), `no scheme-like reference (${result.embedPath})`)
  const { prepareSource } = await import(pathToFileURL(join(here, '..', 'compiler', 'scripts', 'lib', '08-source-adapters.mjs')).href)
  const content = `# Energy\n\n### Map\n\n[Embed: ${result.embedPath}]\n`
  const model = await prepareSource(f.outline, content, 'energy', statSync(f.outline), undefined, { allowedAssetRoots: [f.vault] })
  assert.ok(model.fullHtml.includes('Local-URI-MARKER'), 'the local bytes are inlined')
  assert.deepEqual(model.warnings.filter((w) => /remote|asset|embed/.test(w)), [], `no remote or missing warning (${model.warnings.join(', ')})`)
  for (const name of ['mailto:x.html', 'a%41.html', 'C:page.html']) {
    const other = join(f.talkDir, name)
    writeFileSync(other, page('X'))
    const again = await imp({ root: f.vault, outlinePath: f.outline }, other)
    assert.ok(again.ok && !/[:%]/.test(again.embedPath), `${name} → ${again.embedPath}`)
  }
})

await test('F3: CSS is not read for names; names come from tags only, and the notice never depends on them', () => {
  // Round 2 (2026-10-27): valid CSS a scanner missed (@import/**/"x", u\72l(x)) got a bare success.
  // The CSS scanner is gone; every insert says files beside the page are not copied
  // (test-insert-html-page-flow.mjs). Names found in tags are still listed.
  for (const css of ['<style>@import/**/"theme.css";</style>', '<style>body{background:u\\72l(pic.png)}</style>', '<style>body{background-image:url(./picture.png)}</style>']) {
    assert.deepEqual(localReferencesOf(css), [], css)
  }
  assert.deepEqual(localReferencesOf('<img src="pic.png"><style>@import "theme.css";</style>'), ['pic.png'])
})

await test('F4: a large malformed page is scanned in time proportional to its size', () => {
  const time = (bytes) => { const html = '<script '.repeat(bytes / 8); const t = performance.now(); localReferencesOf(html); return performance.now() - t }
  time(64 * 1024)
  const small = Math.max(time(32 * 1024), 1)
  const large = time(512 * 1024)
  assert.ok(large < 1000, `512 KB of unclosed tags scanned in ${large.toFixed(0)} ms`)
  assert.ok(large / small < 64, `16x the input took ${(large / small).toFixed(1)}x the time (quadratic would be ~256x)`)
  const styles = '<style>' + 'url('.repeat(128 * 1024)
  const t = performance.now(); localReferencesOf(styles); const css = performance.now() - t
  assert.ok(css < 1000, `512 KB of unclosed url( scanned in ${css.toFixed(0)} ms`)
})

// Round 2 (2026-10-27): the copy runs in a process whose working directory is the talk folder
// (src/main/html-page-import-core.ts). The reviewer's reproductions, then every filesystem call of the
// copy with five kinds of swap made just before it, then the real child process and main's time.
const realFs = await import('node:fs')
/** Every file below `dir` (recursively) with its size. */
const filesBelow = (dir) => {
  const out = []
  const walk = (d) => { for (const e of realFs.readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (e.isFile()) out.push([p, realFs.statSync(p).size]) } }
  if (existsSync(dir)) walk(dir)
  return out
}
/** The reviewer's fixture: vault/talk/talk-outline.md, the chosen page in materials/, an outside folder. */
function raceFixture() {
  const dir = join(base, `race-${++n}`), vault = join(dir, 'vault'), talk = join(vault, 'talk')
  const outside = join(dir, 'outside'), materials = join(dir, 'materials'), alternate = join(dir, 'alternate-source')
  for (const path of [talk, outside, materials, alternate]) mkdirSync(path, { recursive: true })
  const outline = join(talk, 'talk-outline.md'), source = join(materials, 'page.html'), assets = join(talk, 'assets')
  writeFileSync(outline, '# Talk\n\n### Slide\n')
  writeFileSync(source, '<!doctype html><body>SELECTED-MARKER</body>')
  writeFileSync(join(alternate, 'page.html'), '<body>UNSELECTED-MARKER</body>')
  return { dir, vault, talk, outside, materials, alternate, outline, source, assets, target: { root: vault, outlinePath: outline } }
}
/** A success names a file inside the vault, reached by the talk's own path, holding the chosen bytes. */
const honest = (f, result) => {
  if (!result.ok) return true
  const at = join(f.talk, ...result.embedPath.split('/'))
  return existsSync(at) && realpathSync(at).startsWith(f.vault + '/') && readFileSync(at, 'utf8').includes('SELECTED-MARKER') && !readFileSync(at, 'utf8').includes('UNSELECTED')
}
/** No byte of the chosen page is outside the vault: no file in `outside` holds any of it (the talk's own
 *  outline may be there when the whole talk folder was moved out; a file the import made there is empty). */
const nothingOutside = (f) => filesBelow(f.outside).every(([path, size]) => size === 0 || !readFileSync(path, 'utf8').includes('SELECTED-MARKER'))

await test('reviewer case: talk folder swapped for a link out of the vault just before mkdir creates nothing outside', async () => {
  const f = raceFixture()
  const racing = { ...realFs, mkdirSync(path, options) {
    if (path === 'assets') { realFs.renameSync(f.talk, f.talk + '-held'); realFs.symlinkSync(f.outside, f.talk) }
    return realFs.mkdirSync(path, options)
  } }
  const result = await imp(f.target, f.source, racing)
  assert.equal(result.ok, false, JSON.stringify(result))
  assert.deepEqual(listing(f.outside), [], 'no folder or file is created outside the vault')
})

await test('reviewer case: assets moved out and replaced by a link during the descriptor check never succeeds, and leaves no bytes outside', async () => {
  const f = raceFixture()
  const escaped = join(f.outside, 'moved-assets')
  let swapped = false
  // The descriptor check is now the no-links reopen of the same file (the reviewer's hook was the
  // statSync of this path, which the copy no longer makes).
  const racing = { ...realFs, openSync(path, flags, ...rest) {
    if (!swapped && path === join(f.assets, 'page.html') && !(flags & realFs.constants.O_CREAT)) { swapped = true; realFs.renameSync(f.assets, escaped); realFs.symlinkSync(escaped, f.assets) }
    return realFs.openSync(path, flags, ...rest)
  } }
  const result = await imp(f.target, f.source, racing)
  assert.equal(swapped, true, 'the swap happened')
  assert.equal(result.ok, false, JSON.stringify(result))
  assert.ok(nothingOutside(f), `files outside: ${JSON.stringify(filesBelow(f.outside))}`)
})

await test('reviewer case: assets moved out and recreated empty just before the write is refused, bytes emptied', async () => {
  const f = raceFixture()
  const escaped = join(f.outside, 'moved-assets')
  let swapped = false
  const racing = { ...realFs, writeSync(...args) {
    if (!swapped) { swapped = true; realFs.renameSync(f.assets, escaped); realFs.mkdirSync(f.assets) }
    return realFs.writeSync(...args)
  } }
  const result = await imp(f.target, f.source, racing)
  assert.equal(result.ok, false, JSON.stringify(result))
  assert.ok(nothingOutside(f), `files outside: ${JSON.stringify(filesBelow(f.outside))}`)
  assert.deepEqual(listing(f.assets), [], 'and no success names a file that is not there')
})

await test('reviewer case: the chosen page’s folder swapped for a link just before the source open is refused', async () => {
  const f = raceFixture()
  const racing = { ...realFs, openSync(path, flags, ...rest) {
    if (path === f.source) { realFs.renameSync(f.materials, f.materials + '-held'); realFs.symlinkSync(f.alternate, f.materials) }
    return realFs.openSync(path, flags, ...rest)
  } }
  const result = await imp(f.target, f.source, racing)
  assert.equal(result.ok, false, JSON.stringify(result))
  assert.equal(filesBelow(f.talk).some(([p]) => readFileSync(p, 'utf8').includes('UNSELECTED')), false, 'another file is never copied')
})

await test('the chosen page replaced by another file after choosing is refused (it must be the file chosen)', async () => {
  const f = raceFixture()
  const h = harness({ pick: () => f.source, roots: () => f.vault })
  const choice = await h.choose(f.outline)
  rmSync(f.source)
  writeFileSync(f.source, '<!doctype html><body>REPLACED</body>')
  assert.equal((await h.importPage(choice.token, f.outline)).reason, 'missing')
  assert.equal(existsSync(f.assets), false)
})

await test('every filesystem call of the copy, five kinds of swap before it: no folder or byte outside, success always honest', async () => {
  const variants = {
    // The talk folder's path swapped for a link out: nothing may ever be created outside.
    ancestorLink: (f) => { realFs.renameSync(f.talk, f.talk + '-held'); realFs.symlinkSync(f.outside, f.talk) },
    // assets moved out of the vault and its path swapped for a link to it.
    assetsLink: (f) => { if (!existsSync(f.assets)) return false; realFs.renameSync(f.assets, join(f.outside, 'moved-assets')); realFs.symlinkSync(join(f.outside, 'moved-assets'), f.assets) },
    // assets moved out and an empty one made in its place.
    assetsMoved: (f) => { if (!existsSync(f.assets)) return false; realFs.renameSync(f.assets, join(f.outside, 'moved-assets')); realFs.mkdirSync(f.assets) },
    // The talk folder itself moved out of the vault (the case no design can stop: caught, emptied).
    talkMovedOut: (f) => { realFs.renameSync(f.talk, join(f.outside, 'moved-talk')) },
    // The chosen page's folder swapped for a link to another page.
    sourceLink: (f) => { realFs.renameSync(f.materials, f.materials + '-held'); realFs.symlinkSync(f.alternate, f.materials) },
  }
  let runs = 0
  for (const [kind, swap] of Object.entries(variants)) {
    for (const assetsFirst of [false, true]) {
      for (let at = 1; ; at++) {
        const f = raceFixture()
        if (assetsFirst) mkdirSync(f.assets)
        let calls = 0
        let swapped = false
        // Every call that resolves a path (its first argument is one), the copy's realpath checks included,
        // gets a swap before it, so every interval between two lookups is tried. A call on an open
        // descriptor (fstat, read, write, close) resolves nothing: the state any later lookup sees is
        // the same as for a swap before that lookup, and after the last lookup the import has decided.
        // The reviewer's swap before the write is its own case above.
        const racing = new Proxy(realFs, {
          get(target, key) {
            const value = key === 'realpathNative' ? (path) => realFs.realpathSync.native(path) : target[key]
            if (typeof value !== 'function') return value
            return (...args) => {
              if (typeof args[0] === 'string' && ++calls === at && !swapped) swapped = swap(f) !== false
              return value.apply(target, args)
            }
          }
        })
        const result = await imp(f.target, f.source, racing)
        runs++
        const label = `${kind}, assets ${assetsFirst ? 'present' : 'absent'}, swap before call ${at}: ${JSON.stringify(result)}`
        assert.ok(honest(f, result), `success names the chosen bytes inside the vault (${label})`)
        assert.ok(nothingOutside(f), `no byte outside the vault (${label}; ${JSON.stringify(filesBelow(f.outside))})`)
        if (kind === 'ancestorLink' || kind === 'sourceLink') assert.deepEqual(listing(f.outside), [], `nothing created outside (${label})`)
        if (kind === 'assetsLink' || kind === 'assetsMoved') assert.deepEqual(listing(f.outside).filter((name) => name !== 'moved-assets'), [], `no new folder outside (${label})`)
        if (kind === 'talkMovedOut') assert.deepEqual(listing(f.outside).filter((name) => name !== 'moved-talk'), [], `no new folder outside (${label})`)
        if (calls < at) break
      }
    }
  }
  console.log(`      (${runs} raced imports)`)
})

// Review 2026-10-27 (second correction, P2 1): outside macOS no open can refuse a link above the
// last path component, so a swapped-in assets link would still CREATE an empty file outside before
// any proof could refuse it. There the import refuses before touching the file system at all.
// Run on the macOS file system with the platform faked: a branch test, NOT a Windows or Linux test.
for (const platform of ['linux', 'win32']) {
  await test(`outside macOS (${platform}, faked): the import refuses before any file-system call, so a link in place of assets creates nothing`, async () => {
    const desc = Object.getOwnPropertyDescriptor(process, 'platform')
    let core
    try { Object.defineProperty(process, 'platform', { ...desc, value: platform }); core = await import(pathToFileURL(join(here, '..', 'src', 'main', 'html-page-import-core.ts')).href + `?${platform}`) }
    finally { Object.defineProperty(process, 'platform', desc) }
    const f = raceFixture()
    mkdirSync(f.assets)
    let calls = 0
    const racing = new Proxy(realFs, { get(target, key) {
      const value = target[key]
      if (typeof value !== 'function') return value
      return (...args) => {
        calls++
        if (key === 'openSync' && (args[1] & realFs.constants.O_CREAT)) { realFs.renameSync(f.assets, f.assets + '-held'); realFs.symlinkSync(f.outside, f.assets) }
        return value.apply(target, args)
      }
    } })
    const prepared = (await import('../src/main/html-page-import.ts')).htmlPageImportJob(f.target, f.source)
    const back = process.cwd()
    process.chdir(f.talk)
    let result
    try { result = core.importInWorkingFolder(prepared.job, racing) } finally { process.chdir(back) }
    assert.equal(result.ok, false, JSON.stringify(result))
    assert.equal(result.reason, 'unsupported')
    assert.equal(calls, 0, 'no file-system call at all')
    assert.deepEqual(listing(f.outside), [], 'nothing created outside, not even an empty file')
    assert.deepEqual(listing(f.assets), [], 'nothing created in assets')
  })
}

await test('outside macOS the picker never opens: Insert HTML page says it is not available, and nothing is chosen or written', async () => {
  for (const platform of ['linux', 'win32']) {
    const f = fixture()
    const source = join(f.outside, 'map.html')
    writeFileSync(source, page())
    const h = harness({ pick: () => source, roots: () => f.vault, platform })
    const choice = await h.choose(f.outline)
    assert.equal(choice.ok, false)
    assert.equal(choice.reason, 'unsupported')
    assert.match(choice.message, /macOS/)
    assert.equal(h.opened.length, 0, 'no picker')
    // A token from anywhere else is refused the same way, before main names a job.
    const imported = await h.importPage('any-token', f.outline)
    assert.equal(imported.ok, false)
    assert.equal(listing(f.talkDir).includes('assets'), false)
  }
})

const { createHtmlPageImportRunner } = await import('../src/main/html-page-import.ts')
const { forkNodeCompileChild } = await import('./lib/node-compile-child.mjs')
const workerPath = join(here, '..', 'src', 'main', 'html-page-import-worker.ts')
const runInChild = createHtmlPageImportRunner(workerPath, (path, cwd) => forkNodeCompileChild(path, { cwd }))

await test('the copy runs in its own process started in the talk folder (the worker, as the app starts it)', async () => {
  const f = raceFixture()
  const result = await importHtmlPage(f.target, f.source, runInChild)
  assert.deepEqual(result, { ok: true, embedPath: 'assets/page.html', how: 'copied', localReferences: [] })
  assert.equal(readFileSync(join(f.assets, 'page.html'), 'utf8'), readFileSync(f.source, 'utf8'))
  const again = await importHtmlPage(f.target, f.source, runInChild)
  assert.deepEqual([again.embedPath, again.how], ['assets/page.html', 'reused'])
})

await test('F4: a 20 MB hostile page is read, scanned and copied off main; main keeps answering', async () => {
  const f = raceFixture()
  const half = HTML_PAGE_MAX_BYTES / 2
  const hostile = Buffer.concat([Buffer.from('url('.repeat(half / 4)), Buffer.from('<img src=x>'.repeat(Math.floor(half / 11)))])
  writeFileSync(f.source, Buffer.concat([hostile, Buffer.alloc(HTML_PAGE_MAX_BYTES - hostile.length, 0x20)]))
  assert.equal(statSync(f.source).size, HTML_PAGE_MAX_BYTES, 'exactly the largest page accepted')
  let last = performance.now()
  let worst = 0
  const beat = setInterval(() => { const now = performance.now(); worst = Math.max(worst, now - last); last = now }, 5)
  const started = performance.now()
  const result = await importHtmlPage(f.target, f.source, runInChild)
  const total = performance.now() - started
  clearInterval(beat)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(statSync(join(f.assets, 'page.html')).size, HTML_PAGE_MAX_BYTES)
  assert.ok(worst < 250, `main's longest pause while importing: ${worst.toFixed(0)} ms`)
  console.log(`      (20 MB import ${total.toFixed(0)} ms in its own process; main's longest pause ${worst.toFixed(0)} ms)`)
})

console.log(`html page import: ${passed} passed`)
