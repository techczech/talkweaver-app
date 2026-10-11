#!/usr/bin/env node
// Local handout preview: compiles a talk's published handout exactly as Publish does (landing
// index.html in home mode, <slug>.html, lazy slide-assets/, the self-contained download file) into
// .local-handout-preview/<slug>/, then serves it on http://127.0.0.1:<port> with a stub live service on
// the same origin and a presenter control page at /control. Nothing is deployed.
//
//   npm run preview:handout                       # the layout showcase talk, port 4173
//   npm run preview:handout -- --talk <outline.md> --port 4300
//   npm run preview:handout -- --host 0.0.0.0     # reachable from a phone on the same network
//
// Options: --talk <path>  --port <n>  --host <addr>  --out <dir>  --no-sample-run
//   (--no-sample-run leaves out the sample "starts in 3 hours" run and its pre-work, so the page opens on the handout layout)
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir, networkInterfaces, tmpdir } from 'node:os'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'
import { createLiveStub } from './lib/local-live-stub.mjs'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const COMPILER = join(REPO, 'compiler/scripts')
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export function parseArgs(argv) {
  const out = { talk: '', port: 4173, host: '127.0.0.1', out: join(REPO, '.local-handout-preview'), sampleRun: true }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--talk') out.talk = argv[++i] ?? ''
    else if (a === '--port') out.port = Number(argv[++i])
    else if (a === '--host') out.host = argv[++i] ?? out.host
    else if (a === '--out') out.out = resolve(argv[++i] ?? out.out)
    else if (a === '--no-sample-run') out.sampleRun = false
    else throw new Error(`Unknown option ${a}`)
  }
  if (!Number.isInteger(out.port) || out.port < 0 || out.port > 65535) throw new Error('--port must be a number from 0 to 65535')
  return out
}

/** The vault root from the app's config, or null. */
function configuredVaultRoot() {
  for (const name of ['TalkWeaver', 'talk-weaver']) {
    try {
      const cfg = JSON.parse(readFileSync(join(homedir(), 'Library/Application Support', name, 'config.json'), 'utf8'))
      if (cfg.vaultRoot && existsSync(cfg.vaultRoot)) return cfg.vaultRoot
    } catch { /* next */ }
  }
  return null
}

function findOutlines(dir, depth = 0, hits = []) {
  if (depth > 4) return hits
  let entries = []
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return hits }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === '_assets') continue
    const p = join(dir, e.name)
    if (e.isDirectory()) findOutlines(p, depth + 1, hits)
    else if (e.name.endsWith('-outline.md') && /showcase/i.test(p)) hits.push(p)
  }
  return hits
}

/** Dominik's layout showcase talk: the outline whose path says "layout showcase". Read-only search. */
export function findLayoutShowcase() {
  const root = configuredVaultRoot()
  if (!root) throw new Error('No vault found in the TalkWeaver config; pass --talk <outline.md>.')
  const hits = findOutlines(root)
  const best = hits.find((p) => /layout[-_ ]showcase/i.test(p)) ?? hits[0]
  if (!best) throw new Error(`No outline with "showcase" in its path under ${root}; pass --talk <outline.md>.`)
  return best
}

/** The vault root holding an outline: the nearest ancestor with an _assets folder, else the configured one. */
function vaultRootFor(outline) {
  for (let dir = dirname(outline); dirname(dir) !== dir; dir = dirname(dir)) if (existsSync(join(dir, '_assets'))) return dir
  return configuredVaultRoot()
}

// The real slimHandoutHtml and resolveImageRefs, lifted from src/main like scripts/test-lazy-publish.mjs does.
function liftedPublishHelpers() {
  const source = readFileSync(join(REPO, 'src/main/index.ts'), 'utf8')
  const file = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const decl = file.statements.find((n) => ts.isFunctionDeclaration(n) && n.name?.text === 'slimHandoutHtml')
  if (!decl) throw new Error('slimHandoutHtml not found in src/main/index.ts')
  const js = ts.transpileModule(decl.getText(file), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const deps = { existsSync, mkdtempSync, join, tmpdir, writeFileSync, readFileSync, rmSync, execFileSync, Buffer }
  return Function(...Object.keys(deps), `${js}\nreturn slimHandoutHtml`)(...Object.values(deps))
}

/** Compile the talk's handout the way Publish does and write it under <out>/<slug>/. Returns what the server needs. */
export async function buildPreviewSite({ talk, out, baseUrl, sampleRun }) {
  const outlinePath = resolve(talk)
  const published = readFileSync(outlinePath, 'utf8') // read-only
  const slug = basename(outlinePath).replace('-outline.md', '')
  const stat = statSync(outlinePath)
  const vaultRoot = vaultRootFor(outlinePath)
  const { resolveImageRefs } = await import(pathToFileURL(join(REPO, 'src/main/image-refs.ts')).href).catch(() => ({ resolveImageRefs: null }))
  const resolved = vaultRoot && resolveImageRefs ? resolveImageRefs(published, vaultRoot) : refsFallback(published, vaultRoot)
  const mod = (name) => import(pathToFileURL(join(COMPILER, 'lib', name)).href)
  const { prepareSource } = await mod('08-source-adapters.mjs')
  const { extractStyles, extractSlides } = await mod('04-html-extraction.mjs')
  const { buildShareHtml } = await mod('09-output-builders.mjs')
  const { buildHandoutHomePageHtml } = await mod('handout-home-page.mjs')
  const { publishLazyHandoutPages } = await mod('handout-lazy-assets.mjs')
  const { makeQrSvg } = await mod('01-cli-utils.mjs')
  const { handoutHomeDetails, handoutHomePrework } = await import(pathToFileURL(join(REPO, 'src/shared/handout-home.ts')).href)
  const { withoutPreworkSlides } = await import(pathToFileURL(join(REPO, 'src/shared/run-prework.ts')).href)

  const model = await prepareSource(outlinePath, resolved, slug, stat)
  const fmTitle = (published.match(/^title:\s*["']?(.+?)["']?\s*$/m) || [])[1]
  const title = (fmTitle && fmTitle.trim()) || model.title || slug
  const fullHtml = model.fullHtml
  const styles = extractStyles(fullHtml)
  const slides = withoutPreworkSlides(extractSlides(fullHtml), model.prework)
  const license = model.license
  const shareArgs = { title, slides, styles, includeNotes: false, slug, license, workerBaseUrl: baseUrl, liveTalkSlug: slug }
  const handoutHtml = buildShareHtml(shareArgs)
  const lazyHandoutHtml = buildShareHtml({ ...shareArgs, lazyAssets: true, homeHref: './' })

  const talkOutDir = join(out, slug)
  mkdirSync(talkOutDir, { recursive: true })
  const url = `${baseUrl}/${slug}/`
  const downloadFile = `${slug}-download.html`
  // A sample run: starts in 3 hours today, with two pre-work steps, so the "before the talk" layout has its content.
  const start = new Date(Date.now() + 3 * 3600_000)
  start.setMinutes(0, 0, 0) // on the hour, so two captures in the same hour show the same time
  const pad = (n) => String(n).padStart(2, '0')
  const run = sampleRun
    ? { status: 'planned', plannedDate: `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`, startTime: `${pad(start.getHours())}:${pad(start.getMinutes())}`, eventTitle: 'Sample event' }
    : null
  const details = handoutHomeDetails({ outline: published, run })
  const prework = sampleRun ? handoutHomePrework({ title: 'Get ready for the session', steps: [{ title: 'Try one agent before the session', kind: 'task', minutes: 10 }, { title: 'Read: Choosing a slide layout', kind: 'slide', minutes: 5 }] }) : null
  const homeHtml = buildHandoutHomePageHtml({
    title, slides, styles, slug, license, workerBaseUrl: baseUrl, liveTalkSlug: slug, lazyAssets: true,
    home: { url, qr: makeQrSvg(url) || '', downloadHref: downloadFile, ...details, ...(prework ? { prework } : {}) },
  })
  const { warnings } = publishLazyHandoutPages(talkOutDir, [
    { fileName: downloadFile, html: handoutHtml, lazy: false },
    { fileName: `${slug}.html`, html: lazyHandoutHtml },
    { fileName: 'index.html', html: homeHtml },
  ], { slim: liftedPublishHelpers() })

  const withPoll = model.slides.find((s) => s.poll)?.poll ?? null
  const poll = withPoll
    ? { pollId: withPoll.pollId, pollType: withPoll.type, question: withPoll.question, options: withPoll.options, ...(withPoll.board ? { board: withPoll.board } : {}) }
    : undefined
  return { slug, title, slideIds: slides.map((s) => s.id), poll, talkOutDir, warnings }
}

// Same refs as src/main/image-refs.ts, for when that .ts file cannot be imported directly.
function refsFallback(content, vaultRoot) {
  if (!vaultRoot) return content
  const assets = join(vaultRoot, '_assets')
  return content.replace(/!\[([^\]]*)\]\((img-(?:img-)?[0-9a-f]{7}|vid-[0-9a-f]{7})\)/g, (whole, alt, rawId) => {
    const id = rawId.replace(/^img-img-/, 'img-')
    for (const ext of id.startsWith('vid-') ? ['mp4', 'mov', 'm4v', 'webm'] : ['webp', 'png', 'jpg', 'jpeg', 'gif']) {
      const p = join(assets, `${id}.${ext}`)
      if (existsSync(p)) return `![${alt}](${p})`
    }
    return whole
  })
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.webm': 'video/webm', '.json': 'application/json' }

// A minimal RFC 6455 server side: text frames in and out, ping/pong, close. Enough for the audience socket.
function acceptWebSocket(req, socket, onText, onClose) {
  const key = req.headers['sec-websocket-key']
  if (!key) { socket.destroy(); return null }
  const accept = createHash('sha1').update(key + GUID).digest('base64')
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
  const frame = (opcode, payload) => {
    const len = payload.length
    const head = len < 126 ? Buffer.from([0x80 | opcode, len]) : len < 65536 ? Buffer.from([0x80 | opcode, 126, len >> 8, len & 255]) : (() => { const b = Buffer.alloc(10); b[0] = 0x80 | opcode; b[1] = 127; b.writeBigUInt64BE(BigInt(len), 2); return b })()
    return Buffer.concat([head, payload])
  }
  let buffer = Buffer.alloc(0)
  let open = true
  const close = () => { if (open) { open = false; onClose() } }
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    for (;;) {
      if (buffer.length < 2) return
      const opcode = buffer[0] & 15
      let len = buffer[1] & 127, offset = 2
      if (len === 126) { if (buffer.length < 4) return; len = buffer.readUInt16BE(2); offset = 4 }
      else if (len === 127) { if (buffer.length < 10) return; len = Number(buffer.readBigUInt64BE(2)); offset = 10 }
      const masked = (buffer[1] & 128) !== 0
      if (buffer.length < offset + (masked ? 4 : 0) + len) return
      const mask = masked ? buffer.subarray(offset, offset + 4) : null
      if (masked) offset += 4
      const payload = Buffer.from(buffer.subarray(offset, offset + len))
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]
      buffer = buffer.subarray(offset + len)
      if (opcode === 1) onText(payload.toString('utf8'))
      else if (opcode === 9) socket.write(frame(10, payload))
      else if (opcode === 8) { socket.end(frame(8, Buffer.alloc(0))); close(); return }
    }
  })
  socket.on('close', close)
  socket.on('error', close)
  return (text) => { if (open && !socket.destroyed) socket.write(frame(1, Buffer.from(text, 'utf8'))) }
}

const CONTROL_HTML = (slug) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Handout preview control</title>
<style>
body{font:16px/1.4 system-ui,sans-serif;margin:0;padding:16px;max-width:520px;margin-inline:auto;background:#fafaf7;color:#1c1c1a}
h1{font-size:20px;margin:0 0 4px}p{margin:4px 0 12px;color:#555}
.row{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:0 0 8px}
button{min-height:48px;font:inherit;font-weight:600;border:1px solid #1c1c1a;border-radius:8px;background:#fff;color:inherit;cursor:pointer}
button.go{background:#1c1c1a;color:#fff}button:active{opacity:.7}
input{width:100%;box-sizing:border-box;min-height:44px;font:inherit;padding:0 10px;border:1px solid #888;border-radius:8px;margin:0 0 8px}
pre{background:#fff;border:1px solid #ddd;border-radius:8px;padding:10px;font-size:13px;white-space:pre-wrap;word-break:break-word}
a{color:inherit}
</style></head><body>
<h1>Handout preview control</h1>
<p><a href="/${slug}/" target="_blank" rel="noopener">Open the handout page</a> (this page and the handout share one origin).</p>
<div class="row"><button class="go" data-a="start">Start live</button><button data-a="end">End live</button></div>
<div class="row"><button data-a="prev">Previous slide</button><button data-a="next">Next slide</button></div>
<div class="row"><button class="go" data-a="poll-open">Open poll</button><button data-a="poll-close">Close poll</button></div>
<div class="row"><button class="go" data-a="board-open">Open board</button><button data-a="instant-clear">Clear instant slide</button></div>
<input id="t" value="Back at 11:15" aria-label="Instant slide text"><input id="l" placeholder="Link (optional)" aria-label="Instant slide link">
<div class="row"><button class="go" data-a="instant" style="grid-column:1/-1">Show instant slide</button></div>
<pre id="s">…</pre>
<script>
async function post(a){const r=await fetch('/control/api/'+a,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:t.value,link:l.value})});show(await r.json())}
function show(s){document.getElementById('s').textContent='live: '+s.live+'\\nslide: '+(s.slideIndex+1)+' / '+s.slideCount+' ('+s.slideId+')\\npolls: '+JSON.stringify(s.polls)+'\\ninstant: '+(s.instant?s.instant.text:'none')+'\\nconnected pages: '+s.sockets+'\\n\\n'+s.log.slice(-8).join('\\n')}
document.querySelectorAll('button[data-a]').forEach(b=>b.onclick=()=>post(b.dataset.a))
async function poll(){try{show(await (await fetch('/control/api/state')).json())}catch{}}
poll();setInterval(poll,2000)
</script></body></html>`

/** Start the server for an already built site. Returns { server, port, stub, close }. */
export async function startPreviewServer({ siteRoot, slug, stub, port, host }) {
  const root = resolve(siteRoot)
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    const send = (status, body, type = 'application/json') => { res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'access-control-allow-origin': '*' }); res.end(body) }
    try {
      if (url.pathname === '/capabilities') return send(200, JSON.stringify(stub.capabilities()))
      if (url.pathname.startsWith('/session/') && req.method === 'GET') return send(200, JSON.stringify(stub.discovery()))
      if (url.pathname === '/control' || url.pathname === '/control/') return send(200, CONTROL_HTML(slug), 'text/html; charset=utf-8')
      if (url.pathname === '/control/api/state') return send(200, JSON.stringify(stub.state()))
      if (url.pathname.startsWith('/control/api/') && req.method === 'POST') {
        let raw = ''
        for await (const chunk of req) raw += chunk
        const body = raw ? JSON.parse(raw) : {}
        const actions = {
          start: () => stub.startLive(), end: () => stub.endLive(),
          next: () => stub.goToSlide(1), prev: () => stub.goToSlide(-1),
          'poll-open': () => stub.openPoll(), 'poll-close': () => stub.closePoll(), 'board-open': () => stub.openBoard(),
          instant: () => stub.showInstant({ text: body.text, link: body.link }), 'instant-clear': () => stub.clearInstant(),
        }
        const action = actions[url.pathname.slice('/control/api/'.length)]
        if (!action) return send(404, '{"error":"unknown action"}')
        action()
        return send(200, JSON.stringify(stub.state()))
      }
      if (url.pathname === '/') { res.writeHead(302, { location: `/${slug}/` }); return res.end() }
      // The request path is resolved as a file URL below the preview folder, then turned into a path
      // with fileURLToPath (Windows-safe: no URL pathname is handed to the path or fs functions).
      let file
      try { file = fileURLToPath(new URL('.' + url.pathname, pathToFileURL(root + sep))) } catch { return send(400, 'Bad request', 'text/plain') }
      if (file.endsWith(sep) && file !== root + sep) file = file.slice(0, -1)
      if (file === root + sep) file = root
      if (file !== root && !file.startsWith(root + sep)) return send(403, 'Forbidden', 'text/plain')
      if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html')
      if (!existsSync(file)) return send(404, 'Not found', 'text/plain')
      res.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-store' })
      res.end(readFileSync(file))
    } catch (e) { send(500, JSON.stringify({ error: String(e?.message ?? e) })) }
  })
  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url, 'http://x')
    if (!/^\/sessions\/[^/]+\/audience$/.test(url.pathname) || !stub.isLive()) { socket.end('HTTP/1.1 404 Not Found\r\n\r\n'); return }
    let disconnect = () => {}
    let sendText = null
    sendText = acceptWebSocket(req, socket, (raw) => stub.handle((t) => sendText?.(t), raw), () => disconnect())
    if (sendText) disconnect = stub.connect((t) => sendText(t))
  })
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(port, host, ok) })
  const actual = server.address().port
  return { server, port: actual, close: () => new Promise((ok) => { server.closeAllConnections?.(); server.close(ok) }) }
}

/** Build and serve; the one call the CLI and the smoke test share. */
export async function startLocalHandoutPreview(options) {
  const out = options.out ?? join(REPO, '.local-handout-preview')
  const host = options.host ?? '127.0.0.1'
  // Bind first when the port is 0, so the compiled pages carry the real origin.
  const placeholder = options.port === 0 ? await startPreviewServer({ siteRoot: out, slug: '', stub: createLiveStub({ slug: '', slideIds: ['x'] }), port: 0, host }) : null
  const port = placeholder ? placeholder.port : options.port
  if (placeholder) await placeholder.close()
  const baseUrl = `http://${host === '0.0.0.0' ? lanAddress() : host === '127.0.0.1' ? '127.0.0.1' : host}:${port}`
  const built = await buildPreviewSite({ talk: options.talk, out, baseUrl, sampleRun: options.sampleRun !== false })
  const stub = createLiveStub({ slug: built.slug, slideIds: built.slideIds, ...(built.poll ? { poll: built.poll } : {}) })
  const running = await startPreviewServer({ siteRoot: out, slug: built.slug, stub, port, host })
  return { ...built, stub, baseUrl, ...running }
}

function lanAddress() {
  for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address
  return '127.0.0.1'
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2))
    const talk = args.talk || findLayoutShowcase()
    console.log(`Compiling ${talk} ...`)
    const run = await startLocalHandoutPreview({ ...args, talk })
    const shown = args.host === '0.0.0.0' ? lanAddress() : args.host
    console.log(`\nHandout page   http://${shown}:${run.port}/${run.slug}/`)
    console.log(`Presenter      http://${shown}:${run.port}/control`)
    console.log(`Output folder  ${run.talkOutDir}  (nothing is deployed)`)
    for (const w of run.warnings) console.log(`Warning: ${w}`)
    console.log('\nCtrl-C to stop.')
    const stop = async () => { await run.close(); process.exit(0) }
    process.on('SIGINT', stop); process.on('SIGTERM', stop)
  } catch (e) {
    console.error(`preview:handout: ${e?.message ?? e}`)
    process.exit(1)
  }
}
