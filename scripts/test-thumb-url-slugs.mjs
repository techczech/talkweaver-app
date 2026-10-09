// twthumb:// addresses for talks whose slugs have spaces, capitals or non-ASCII letters: every
// producer (main thumb-cache-dirs.ts thumbUrl, renderer lib/thumbUrl.ts and browserHelpers coverUrlOf)
// builds an address the protocol handler's seam (parseThumbUrl → thumbFileFor) resolves to the right
// PNG in a real cache folder, after the URL has been parsed the way Chromium parses a STANDARD scheme
// (twthumb is registered standard + secure in main/index.ts: its host is read as a domain name).
// The handler's containment guards still run on the decoded values: traversal, raw or encoded, and
// absolute paths are refused.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { VAULTS_DIR, parseThumbUrl, thumbFileFor, thumbUrl as mainThumbUrl } from '../src/main/thumb-cache-dirs.ts'
import { thumbUrl as rendererThumbUrl } from '../src/renderer/src/lib/thumbUrl.ts'
import { coverUrlOf } from '../src/renderer/src/components/slide-browser/browserHelpers.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let checks = 0
const check = (name, fn) => { fn(); checks++; console.log(`  ✓ ${name}`) }

// Chromium parses a standard scheme like http: the host is a domain (lowercased, punycoded, a space
// is invalid). Node's URL treats `twthumb:` as non-special, so emulate by parsing as http and
// putting the scheme back, which is what the handler's request.url then holds.
function asChromium(raw) {
  assert.ok(raw.startsWith('twthumb://'), raw)
  const parsed = new URL('http:' + raw.slice('twthumb:'.length)) // throws on an invalid host
  return 'twthumb:' + parsed.href.slice('http:'.length)
}

const ns = realpathSync(mkdtempSync(join(tmpdir(), 'tw-thumb-slugs-')))
const VAULT = 'vault-1'
const KEY = '0123abcd'
const slugs = ['plain-ascii', 'two words', 'Přednáška o agentech', 'MixedCase', 'a+b&c=d#e?f%g']
for (const slug of slugs) {
  const dir = join(ns, VAULTS_DIR, VAULT, slug)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${KEY}.png`), slug)
}
const resolveAs = (raw) => {
  const req = parseThumbUrl(asChromium(raw))
  return req ? thumbFileFor(ns, req, [VAULT]) : null
}

console.log('Producer → handler round trip:')
for (const slug of slugs) {
  check(`"${slug}" resolves to its own cache file from every producer`, () => {
    const want = join(ns, VAULTS_DIR, VAULT, slug, `${KEY}.png`)
    const urls = [
      mainThumbUrl(slug, KEY, VAULT),
      mainThumbUrl(slug, KEY, null),
      rendererThumbUrl(slug, KEY, VAULT),
      rendererThumbUrl(slug, KEY),
      coverUrlOf(slug, { [slug]: { coverKey: KEY } }),
    ]
    for (const url of urls) {
      assert.equal(parseThumbUrl(asChromium(url))?.slug, slug, url)
      const hit = resolveAs(url)
      assert.equal(hit, want, url)
      assert.equal(readFileSync(hit, 'utf8'), slug)
    }
  })
}
check('an address from an older build (slug in the host) still resolves', () => {
  assert.equal(resolveAs(`twthumb://plain-ascii/${KEY}?vault=${VAULT}`), join(ns, VAULTS_DIR, VAULT, 'plain-ascii', `${KEY}.png`))
})

console.log('Containment on the decoded values:')
// A file outside every talk folder that a traversal would reach.
writeFileSync(join(ns, 'secret.png'), 'x')
mkdirSync(join(ns, VAULTS_DIR, VAULT, 'secret'), { recursive: true })
const traversal = [
  'twthumb://thumb/..%2F..%2Fsecret/0123abcd', 'twthumb://thumb/%2e%2e%2f%2e%2e/secret', 'twthumb://thumb/%2E%2E/0123abcd',
  'twthumb://thumb/../0123abcd', 'twthumb://thumb/plain-ascii/..%2F..%2F..%2Fsecret', 'twthumb://thumb/plain-ascii/%2e%2e',
  'twthumb://thumb/%2Fetc/passwd', 'twthumb://thumb/%2Fetc%2Fpasswd/x', 'twthumb://thumb/plain-ascii/%2Fetc%2Fpasswd',
  'twthumb://thumb/a%5C..%5C..%5Csecret/k', 'twthumb://thumb/plain-ascii/a%5Cb', 'twthumb://thumb/.hidden/k',
  'twthumb://thumb/plain-ascii/a/b', 'twthumb://thumb/%E0%A4%A/k', 'twthumb://..%2F..%2Fsecret/k', 'twthumb://alpha/a/b',
]
for (const raw of traversal) {
  check(`refused: ${raw}`, () => {
    const req = parseThumbUrl(raw)
    const hit = req ? thumbFileFor(ns, req, [VAULT]) : null
    assert.equal(hit, null, `${raw} → ${JSON.stringify(req)} → ${hit}`)
  })
}

console.log('Every producer goes through the one helper:')
check('no twthumb:// address is concatenated by hand in src/', () => {
  for (const rel of ['src/main/index.ts', 'src/main/thumb-cache-dirs.ts', 'src/renderer/src/lib/thumbUrl.ts', 'src/renderer/src/components/slide-browser/browserHelpers.ts']) {
    const src = readFileSync(join(root, rel), 'utf8')
    assert.doesNotMatch(src, /'twthumb:\/\/' *\+|`twthumb:\/\/\$\{/, rel)
  }
})

console.log(`thumb-url-slugs: ${checks} checks passed`)
