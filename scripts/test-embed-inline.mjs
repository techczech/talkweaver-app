// Verifies local HTML embeds are inlined into the slide as <iframe srcdoc> (self-contained),
// and a missing embed renders a placeholder + warning instead of a broken external reference.
import { mkdtempSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const compilerDir = join(here, '..', 'compiler', 'scripts')
const { prepareSource } = await import(pathToFileURL(join(compilerDir, 'lib/08-source-adapters.mjs')).href)

let failures = 0
const check = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); failures++ } }

// --- present case: a local sim embed must inline as srcdoc ---
const dir = mkdtempSync(join(tmpdir(), 'tw-embed-'))
mkdirSync(join(dir, 'assets'), { recursive: true })
const simHtml = '<!doctype html><html><body><h1>SIM-MARKER</h1><script>console.log("x")</script></body></html>'
writeFileSync(join(dir, 'assets', 'sim.html'), simHtml, 'utf8')

const okContent = '# Embed Test\n\n### Sim slide\n\n[Simulation: assets/sim.html]\n'
const okPath = join(dir, 'ok-outline.md')
writeFileSync(okPath, okContent, 'utf8')
const okModel = await prepareSource(okPath, okContent, 'ok', statSync(okPath))
const okHtml = okModel.fullHtml

check(/<iframe\s+srcdoc=/.test(okHtml), 'inlined embed should emit <iframe srcdoc=')
check(okHtml.includes('SIM-MARKER'), 'srcdoc should contain the sim content (escaped)')
check(!/data-src="assets\/sim\.html"/.test(okHtml), 'should NOT leave an external assets/ data-src ref')
check(!okHtml.includes('"assets/sim.html"'), 'should NOT reference the external file path')

// --- missing case: a missing local embed must render a placeholder + warning ---
const missContent = '# Embed Test\n\n### Missing slide\n\n[Simulation: assets/nope.html]\n'
const missPath = join(dir, 'miss-outline.md')
writeFileSync(missPath, missContent, 'utf8')
const missModel = await prepareSource(missPath, missContent, 'miss', statSync(missPath))
check(/slide-embed-missing/.test(missModel.fullHtml), 'missing embed should render the placeholder class')
check((missModel.warnings || []).some((w) => w.startsWith('missing-asset:')), 'missing embed should warn missing-asset')

// --- remote embed: a live iframe + a persistent "Open <host>" caption link, no card ---
const remoteContent = '# Embed Test\n\n### Remote slide\n\n[Embed: https://example.com/page]\n'
const remotePath = join(dir, 'remote-outline.md')
writeFileSync(remotePath, remoteContent, 'utf8')
const remoteModel = await prepareSource(remotePath, remoteContent, 'remote', statSync(remotePath))
const remoteHtml = remoteModel.fullHtml
check(/class="embed-open-link"/.test(remoteHtml), 'remote embed should render the Open-link caption')
check(/data-embed-url="https:\/\/example\.com\/page"/.test(remoteHtml), 'remote embed should still carry the live iframe data-embed-url')
check(remoteHtml.includes('example.com'), 'caption should name the host')

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1) }
console.log('PASS: local HTML embeds inline as srcdoc; missing embeds render a placeholder + warning')
