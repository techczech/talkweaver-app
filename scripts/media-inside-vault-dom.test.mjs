// 0.38 ticket 10 — the output property of ADR-0036, in a real browser:
//
//   A compiled page never asks for a local file the compiler did not itself resolve inside the
//   allowed roots.
//
// The compiler reads a reference as a file name; a browser reads the same text as a URL, and the
// URL parser is more permissive (`file:` URLs, `\` as `/`, tabs and newlines dropped, `file:` with
// a relative path). So this test does not reason about spellings: it compiles a talk whose
// references point — by the BROWSER's reading — at files outside the vault, writes the page into
// the talk's folder (where the app writes the present file), opens it from `file://` in headless
// Chromium and records every request the page makes. No request may name anything outside the vault.
//
// A control page with a plain `<img src="file://…outside…">` proves the recording sees such a load.
import { strict as assert } from 'node:assert'
import { mkdtemp, mkdir, writeFile, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'

const lib = (name) => pathToFileURL(join(process.cwd(), 'compiler/scripts/lib', name)).href
const { prepareSource } = await import(lib('08-source-adapters.mjs'))

let failures = 0
const check = async (name, fn) => {
  try { await fn(); console.log(`ok   ${name}`) } catch (error) { failures++; console.error(`FAIL ${name}\n     ${error?.message ?? error}`) }
}

const base = await realpath(await mkdtemp(join(tmpdir(), 'tw-media-dom-')))
const vault = join(base, 'vault')
const talk = join(vault, 'talk')
const outside = join(base, 'outside')
await mkdir(talk, { recursive: true })
await mkdir(outside, { recursive: true })
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
for (const name of ['secret.png', 'secret.svg', 'secret.mp4', 'secret.mp3', 'secret.html']) {
  await writeFile(join(outside, name), name.endsWith('.png') ? PNG_1X1 : name.endsWith('.svg') ? '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>' : `<!doctype html><title>${name}</title>`)
}
await writeFile(join(talk, 'inside.png'), PNG_1X1)

// The ways a reference can point outside by the browser's reading. `{ext}` is the kind's extension.
const out = (ext) => join(outside, `secret.${ext}`)
const FORMS = {
  'a file: URL': (ext) => `file://${out(ext)}`,
  'a file: URL with one slash': (ext) => `file:${out(ext)}`,
  'a file: URL naming localhost': (ext) => `file://localhost${out(ext)}`,
  'FILE: in capitals': (ext) => `FILE://${out(ext)}`,
  'a file: URL with a relative path': (ext) => `file:../../outside/secret.${ext}`,
  'backslash traversal': (ext) => `..\\..\\outside\\secret.${ext}`,
  'backslashes after a slash': (ext) => `./..\\..\\outside/secret.${ext}`,
  'tabs inside the dots': (ext) => `.\t./.\t./outside/secret.${ext}`,
  'percent-encoded dots': (ext) => `%2e%2e/%2E%2e/outside/secret.${ext}`,
  'a plain ../ path': (ext) => `../../outside/secret.${ext}`,
  'a ../ path with a query': (ext) => `../../outside/secret.${ext}?v=1`,
  'a ../ path with a fragment': (ext) => `../../outside/secret.${ext}#t=1`,
  'an absolute path': (ext) => out(ext),
  'an absolute path with a query': (ext) => `${out(ext)}?v=1`,
  'a scheme-relative path': (ext) => `//localhost${out(ext)}`,
  'a ../ path to a file that is not there yet': (ext) => `../../outside/later.${ext}`,
}
const KINDS = {
  image: { ext: 'png', write: (ref) => ({ body: `![A picture](${ref})` }) },
  video: { ext: 'mp4', write: (ref) => ({ body: `![A clip](${ref})` }) },
  'video directive': { ext: 'mp4', write: (ref) => ({ body: `[Video: ${ref}]` }) },
  audio: { ext: 'mp3', write: (ref) => ({ body: `![A sound](${ref})` }) },
  logo: { ext: 'svg', write: (ref) => ({ frontmatter: `logo: ${ref}`, body: 'Body.' }) },
  embed: { ext: 'html', write: (ref) => ({ body: `[Embed: ${ref}]` }) },
  simulation: { ext: 'html', write: (ref) => ({ body: `[Simulation: ${ref}]` }) },
  // Nested shapes: a picture in a compare half (resolved by the sweep alone) and in a contrast card
  // (the visitor's `cards` branch).
  'image in a compare half': { ext: 'png', write: (ref) => ({ token: '{compare}', body: `#### One\n\n![a](${ref})\n\nText.\n\n#### Two\n\n![b](${ref})\n\nText.` }) },
  'image in a contrast card': { ext: 'png', write: (ref) => ({ token: '{contrast}', body: `#### One\n\n![a](${ref})\n\nText.\n\n#### Two\n\n![b](${ref})\n\nText.` }) },
}
const outline = ({ frontmatter = '', token = '', body }) =>
  ['---', 'title: Containment', ...(frontmatter ? [frontmatter] : []), '---', '', `### A slide ${token}{id=probe}`, '', body, ''].join('\n')

const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] })
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } })

// Open a page from file:// and return every URL it (and its frames) asked for, the page itself excepted.
async function requestsOf(pagePath) {
  const page = await context.newPage()
  // A load that the page's own policy (or the browser) stops is still announced as a request, and
  // then fails: it never reached the file. `finished` holds the ones that did; `byPolicy` the ones
  // the embedded page's Content-Security-Policy stopped.
  const asked = []
  const finished = new Set()
  const byPolicy = new Set()
  page.on('request', (request) => asked.push(request))
  page.on('requestfinished', (request) => finished.add(request))
  const failed = new Set()
  page.on('requestfailed', (request) => { failed.add(request); if (request.failure()?.errorText === 'csp') byPolicy.add(request) })
  const pageUrl = pathToFileURL(pagePath).href
  await page.goto(`${pageUrl}#probe`, { waitUntil: 'load' })
  // Everything that loads lazily or on demand is made to load now.
  await page.evaluate(async () => {
    for (const el of document.querySelectorAll('img, iframe')) el.loading = 'eager'
    for (const frame of document.querySelectorAll('iframe[data-src]')) if (!frame.getAttribute('src')) frame.src = frame.dataset.src
    // An embedded local page runs only on the slide being presented (ticket 11): every such frame is
    // given its inlined document here, in the sandbox the compiler wrote, so each page does run.
    for (const frame of document.querySelectorAll('iframe[data-embed-doc]')) if (!frame.hasAttribute('srcdoc')) frame.srcdoc = frame.getAttribute('data-embed-doc')
    for (const media of document.querySelectorAll('video, audio')) { try { media.preload = 'auto'; media.load(); await media.play().catch(() => {}) } catch { /* nothing to play */ } }
  })
  await page.waitForTimeout(250)
  // What a person reading the page sees (every slide's text, shown or not).
  const pageText = await page.evaluate(() => document.body.textContent || '')
  await page.close()
  const made = asked.filter((request) => request.url().split('#')[0] !== pageUrl)
  const urls = (list) => list.map((request) => request.url())
  return { pageText, all: urls(made), reached: urls(made.filter((request) => finished.has(request))), stopped: urls(made.filter((request) => byPolicy.has(request))), failed: urls(made.filter((request) => failed.has(request))) }
}
const leavesVault = (url) => {
  if (!/^file:/i.test(url)) return false
  let path = url
  try { path = decodeURIComponent(new URL(url).pathname) } catch { /* judge the text */ }
  return !path.startsWith(vault + '/')
}

await check('control: the recording sees a page load an outside file from file://', async () => {
  const control = join(talk, 'control.html')
  await writeFile(control, `<!doctype html><img src="file://${out('png')}"><img src="..\\..\\outside\\secret.png"><img src="inside.png">`)
  const asked = (await requestsOf(control)).reached
  assert.ok(asked.some((url) => url.endsWith('/vault/talk/inside.png')), `the inside picture is requested: ${JSON.stringify(asked)}`)
  assert.ok(asked.filter(leavesVault).length >= 1, `the outside picture is reached: ${JSON.stringify(asked)}`)
})

let n = 0
for (const [kind, spec] of Object.entries(KINDS)) {
  await check(`${kind}: no form of reference makes the page ask for a file outside the vault`, async () => {
    const problems = []
    for (const [how, form] of Object.entries(FORMS)) {
      const ref = form(spec.ext)
      const source = outline(spec.write(ref))
      const outlinePath = join(talk, 'talk-outline.md')
      await writeFile(outlinePath, source)
      const model = await prepareSource(outlinePath, source, 'talk', undefined, {}, { allowedAssetRoots: [vault] })
      const pagePath = join(talk, `talk-present-${++n}.html`)
      await writeFile(pagePath, String(model.fullHtml))
      // Any request that names an outside file counts, whether or not anything stopped it later.
      const opened = await requestsOf(pagePath)
      const escaped = opened.all.filter(leavesVault)
      if (escaped.length) problems.push(`${how} (${JSON.stringify(ref)}) → ${escaped.join(', ')}`)
      // …and nothing on the page names the outside folder or where this vault is.
      for (const needle of [outside, base.split('/').pop()]) {
        const at = opened.pageText.indexOf(needle)
        if (at >= 0) problems.push(`${how}: the page's text names a folder: ${JSON.stringify(opened.pageText.slice(Math.max(0, at - 40), at + needle.length + 20))}`)
      }
    }
    assert.deepEqual(problems, [])
  })
}

await check('an allowed local embed page cannot load local files of its own: no file: URL, no ../ path, no frame', async () => {
  const page = [
    '<!doctype html><html><head><title>Embed</title></head><body>',
    `<img src="file://${out('png')}">`,
    '<img src="../../outside/secret.png">',
    '<img src="..\\..\\outside\\secret.png">',
    `<iframe src="file://${out('html')}"></iframe>`,
    `<video src="file://${out('mp4')}" preload="auto"></video>`,
    `<script>fetch(${JSON.stringify('file://' + out('html'))}).catch(() => {}); new Image().src = ${JSON.stringify('file://' + out('png') + '?script')}</script>`,
    `<link rel="stylesheet" href="file://${out('html')}">`,
    `<div style="background-image:url('file://${out('png')}?css')">x</div>`,
    `<img id="inline-ok" src="data:image/png;base64,${PNG_1X1.toString('base64')}">`,
    '</body></html>',
  ].join('\n')
  await writeFile(join(talk, 'embed.html'), page)
  for (const directive of ['Embed', 'Simulation']) {
    const source = outline({ body: `[${directive}: embed.html]` })
    const outlinePath = join(talk, 'talk-outline.md')
    await writeFile(outlinePath, source)
    const model = await prepareSource(outlinePath, source, 'talk', undefined, {}, { allowedAssetRoots: [vault] })
    assert.ok(String(model.fullHtml).includes(' data-embed-doc="'), 'the page is inlined')
    assert.match(String(model.fullHtml), /<iframe data-embed-doc="[^"]*" sandbox="allow-scripts allow-forms" credentialless /, 'in a sandboxed frame')
    const pagePath = join(talk, `talk-present-embed-${directive}.html`)
    await writeFile(pagePath, String(model.fullHtml))
    const asked = await requestsOf(pagePath)
    assert.deepEqual(asked.reached.filter(leavesVault), [], `${directive}: the embedded page reached local files`)
    // The check is not vacuous: the page did try, and each attempt failed. Since ticket 11 the page
    // runs in a sandboxed frame with an opaque origin, and Chromium refuses a file: load from such a
    // page before the page's own policy is consulted; the policy is still the first element of the
    // inlined document (scripts/test-media-inside-vault.mjs) and binds wherever that rule does not.
    assert.ok(asked.failed.filter(leavesVault).length >= 4, `${directive}: the page's attempts all failed: ${JSON.stringify(asked.failed)}`)
    assert.deepEqual(asked.all.filter(leavesVault).filter((url) => !asked.failed.includes(url)), [], `${directive}: no attempt was left to succeed`)
  }
})

await context.close()
await browser.close()
await rm(base, { recursive: true, force: true })

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1) }
console.log('\nmedia inside the vault (browser): all checks passed')
