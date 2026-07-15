import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  contentHashForPrerender,
  loadPrerenderLedger,
  recordSuccessfulPrerender,
  savePrerenderLedger,
  shouldPrerenderTalk
} from '../src/main/prerender-ledger.ts'

const root = mkdtempSync(join(tmpdir(), 'talkweaver-prerender-ledger-'))
const ledgerPath = join(root, 'prerender-ledger.json')
const outlinePath = join(root, 'vault', 'talk', 'talk-outline.md')
const cacheDir = join(root, 'userData', 'thumbnails', 'talk')
mkdirSync(cacheDir, { recursive: true })

const originalHash = contentHashForPrerender('# Original\n')
let ledger = loadPrerenderLedger(ledgerPath)
assert.equal(shouldPrerenderTalk(ledger, outlinePath, originalHash, cacheDir), true, 'new talk compiles')

recordSuccessfulPrerender(ledger, outlinePath, originalHash, 'document-a')
savePrerenderLedger(ledgerPath, ledger)
ledger = loadPrerenderLedger(ledgerPath)
assert.equal(shouldPrerenderTalk(ledger, outlinePath, originalHash, cacheDir), false, 'matching hash and cache directory skip compile after a ledger round-trip')
assert.deepEqual(ledger[outlinePath], { contentHash: originalHash, documentId: 'document-a' }, 'successful prerender persists hash and document id')

const changedHash = contentHashForPrerender('# Changed\n')
assert.notEqual(changedHash, originalHash, 'content changes alter the hash')
assert.equal(shouldPrerenderTalk(ledger, outlinePath, changedHash, cacheDir), true, 'content change recompiles')
recordSuccessfulPrerender(ledger, outlinePath, changedHash, 'document-b')
savePrerenderLedger(ledgerPath, ledger)
assert.deepEqual(JSON.parse(readFileSync(ledgerPath, 'utf8'))[outlinePath], { contentHash: changedHash, documentId: 'document-b' }, 'recompile updates the ledger')

const missingCacheDir = join(root, 'userData', 'thumbnails', 'missing')
assert.equal(existsSync(missingCacheDir), false)
assert.equal(shouldPrerenderTalk(ledger, outlinePath, changedHash, missingCacheDir), true, 'missing cache directory recompiles even when the hash matches')

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const mainSource = readFileSync(join(repoRoot, 'src/main/index.ts'), 'utf8')
const prerenderSource = mainSource.match(/async function prerenderAllThumbnails\(\): Promise<void> \{([\s\S]*?)\n\}\n\n\/\/ ── OCR/)?.[1] ?? ''
assert(prerenderSource, 'startup prerender function is available for source-contract checks')
assert(
  prerenderSource.indexOf('shouldPrerenderTalk(') < prerenderSource.indexOf('await prepareSource('),
  'ledger skip is evaluated before the synchronous compiler pass'
)
assert.match(prerenderSource, /setTimeout\(resolve, 250\)/, 'changed-talk compiles pause for 250ms between talks')
assert.match(prerenderSource, /setImmediate\(resolve\)/, 'each changed-talk compile starts on a fresh event-loop tick')
assert(!mainSource.includes('pre-generate per-slide thumbnails for every talk'), 'startup comment does not claim every talk recompiles')
assert(!mainSource.includes('Both are content/mtime cached, so this is a one-time cost.'), 'startup comment does not call recurring thumbnail compilation a one-time cost')

console.log('prerender ledger: round-trip, content invalidation, and missing-cache invalidation pass')
