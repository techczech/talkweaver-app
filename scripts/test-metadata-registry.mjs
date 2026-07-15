// Metadata Registry enforcement (ADR-0036) — the categorical guarantee.
//
// Two halves:
//   1. REGISTRY HYGIENE — every entry has a non-empty user-facing explanation, a valid
//      location/ownership, system keys name their delete consequence, and closed vocabularies
//      document at least one option (each option explained).
//   2. STATIC SCAN — greps the compiler and the app for frontmatter-key READS and fails when a
//      read key is not declared in the registry. Patterns covered:
//        • compiler: `meta.key` / `meta["key"]` / `frontmatter.key` member reads
//        • app:      regex-literal frontmatter reads (/^\s*key\s*:/) in src/main + src/renderer
//        • app:      the frontmatter table's FIELDS list ({ key: '…' } in frontmatterTable.ts)
//      Non-metadata matches (e.g. a Map named `meta`, the legacy per-slide library adapter)
//      live in SCAN_IGNORE with a documented reason — an unexplained new key FAILS.
//
// Runs the registry TypeScript directly via Node's native type stripping (Node ≥ 22.18);
// keep src/shared/metadata-registry.ts erasable-syntax-only.

import { strict as assert } from 'node:assert'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const registryMod = await import(new URL('../src/shared/metadata-registry.ts', import.meta.url))
const { METADATA_REGISTRY, registeredKeyNames } = registryMod
assert.equal(
  METADATA_REGISTRY.some((entry) => entry.key === 'pathways' && entry.location === 'manifest'),
  true,
  'Talk manifest pathways key is registered'
)
assert.equal(
  METADATA_REGISTRY.some((entry) => entry.key === 'pathwayId' && entry.location === 'run'),
  true,
  'Run pathwayId key is registered'
)
for (const key of ['status', 'plannedDate', 'eventTitle', 'audience', 'slideSet', 'handoutUrl']) {
  assert.equal(
    METADATA_REGISTRY.some((entry) => entry.key === key && entry.location === 'run'),
    true,
    `Run ${key} key is registered`
  )
}

let failures = 0
const fail = (msg) => { failures += 1; console.error('  ✗ ' + msg) }
const ok = (msg) => console.log('  ✓ ' + msg)

// ── 1. registry hygiene ────────────────────────────────────────────────────────
console.log('Registry hygiene:')
const LOCATIONS = new Set(['frontmatter', 'trigger', 'manifest', 'run'])
const OWNERSHIPS = new Set(['user', 'system'])
const seen = new Set()
for (const e of METADATA_REGISTRY) {
  const who = `entry "${e.key}"`
  if (!e.key || typeof e.key !== 'string') fail(`an entry has no key`)
  for (const name of [e.key, ...(e.aliases ?? [])]) {
    if (seen.has(name)) fail(`${who}: duplicate key/alias "${name}"`)
    seen.add(name)
  }
  if (!LOCATIONS.has(e.location)) fail(`${who}: invalid location "${e.location}"`)
  if (!OWNERSHIPS.has(e.ownership)) fail(`${who}: invalid ownership "${e.ownership}"`)
  if (!e.explanation || !e.explanation.trim() || e.explanation.trim().length < 20) {
    fail(`${who}: explanation missing or too thin to help anyone`)
  }
  if (!e.label || !e.label.trim()) fail(`${who}: missing label`)
  if (e.ownership === 'system' && (!e.deleteConsequence || !e.deleteConsequence.trim())) {
    fail(`${who}: system key without a named deleteConsequence`)
  }
  if (e.vocabulary.kind === 'closed') {
    if (!Array.isArray(e.vocabulary.options) || e.vocabulary.options.length < 1) {
      fail(`${who}: closed vocabulary with no documented options`)
    } else {
      for (const o of e.vocabulary.options) {
        if (!o.explanation || !o.explanation.trim()) {
          fail(`${who}: closed option "${o.value}" has no explanation`)
        }
      }
    }
  }
}
if (failures === 0) ok(`${METADATA_REGISTRY.length} entries well-formed (locations, ownership, explanations, closed options)`)

// ── 2. static scan ─────────────────────────────────────────────────────────────
// Reads that LOOK like metadata-key accesses but are not talk-outline metadata. Every entry
// needs a reason; delete the entry when the code it excuses goes away.
const SCAN_IGNORE = new Map([
  // 13-slide-ledger.mjs builds a local `const meta = new Map()` of heading functions.
  ['get', 'Map.get on a local variable named meta (13-slide-ledger.mjs), not frontmatter'],
  ['set', 'Map.set on a local variable named meta (13-slide-ledger.mjs), not frontmatter'],
  // The legacy JSON slide-library adapter reads PER-SLIDE frontmatter of library entries
  // (role/id/message/…), a retired input format — not talk-outline metadata (ADR-0036 scope).
  ...['role', 'id', 'message', 'prepares_for', 'preparesFor', 'section', 'subsection',
    'navTitle', 'nav_title', 'title', 'layout', 'notes', 'reuse'].map((k) => [
    `frontmatter.${k}`,
    'per-slide frontmatter of the legacy JSON library adapter (08-source-adapters.mjs), not talk-outline metadata'
  ])
])

const registered = registeredKeyNames()
const hits = new Map() // key -> Set of "file:line"

function record(key, file, line) {
  if (!hits.has(key)) hits.set(key, new Set())
  hits.get(key).add(`${relative(root, file)}:${line}`)
}

function scanFile(file, patterns) {
  const text = readFileSync(file, 'utf8')
  const lines = text.split('\n')
  lines.forEach((lineText, i) => {
    for (const { re, prefix } of patterns) {
      re.lastIndex = 0
      let m
      while ((m = re.exec(lineText)) !== null) {
        record((prefix ?? '') + m[1], file, i + 1)
      }
    }
  })
}

// Compiler: deck-level meta / frontmatter member reads. `import.meta.` excluded by lookbehind.
const compilerPatterns = [
  { re: /(?<!import\.)\bmeta\.([A-Za-z_$][\w$]*)/g },
  { re: /\bmeta\[["']([^"']+)["']\]/g },
  { re: /(?<!import\.)\bfrontmatter\.([A-Za-z_$][\w$]*)/g, prefix: 'frontmatter.' },
  { re: /\bfrontmatter\[["']([^"']+)["']\]/g, prefix: 'frontmatter.' }
]
const compilerDirs = [join(root, 'compiler/scripts/lib'), join(root, 'compiler/scripts')]
for (const dir of compilerDirs) {
  for (const f of readdirSync(dir)) {
    if (f.endsWith('.mjs')) scanFile(join(dir, f), compilerPatterns)
  }
}

// App: regex-literal frontmatter reads like /^\s*handout_url\s*:/ (or `^title:` in a template).
const appPatterns = [
  { re: /\^\\s\*([A-Za-z][A-Za-z0-9_-]*)\\s\*:/g },
  { re: /\^([A-Za-z][A-Za-z0-9_-]{2,}):/g }
]
function walk(dir, exts, fn) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, exts, fn)
    else if (exts.some((x) => entry.name.endsWith(x))) fn(full)
  }
}
walk(join(root, 'src/main'), ['.ts'], (f) => scanFile(f, appPatterns))
walk(join(root, 'src/renderer/src'), ['.ts', '.tsx'], (f) => scanFile(f, appPatterns))

// App: the editor's frontmatter table declares its editable keys as FIELDS entries.
scanFile(join(root, 'src/renderer/src/extensions/frontmatterTable.ts'), [
  { re: /\{ key: '([A-Za-z][A-Za-z0-9_-]*)'/g }
])

console.log('Static scan (compiler + app frontmatter reads):')
let scanned = 0
let unregistered = 0
for (const [key, where] of [...hits.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  scanned += 1
  const bare = key.startsWith('frontmatter.') ? key.slice('frontmatter.'.length) : key
  if (SCAN_IGNORE.has(key)) continue
  if (!registered.has(bare)) {
    unregistered += 1
    fail(`key "${bare}" is read in code but NOT declared in the Metadata Registry:\n      ${[...where].join('\n      ')}`)
  }
}
if (unregistered === 0) ok(`${scanned} distinct key reads scanned — all declared (or explained in SCAN_IGNORE)`)

// Ignore-list hygiene: an SCAN_IGNORE entry that no longer matches anything is stale.
for (const [key] of SCAN_IGNORE) {
  if (!hits.has(key)) {
    fail(`SCAN_IGNORE entry "${key}" matches nothing any more — delete it`)
  }
}

if (failures > 0) {
  console.error(`\ntest-metadata-registry: ${failures} failure(s).`)
  console.error('New metadata keys MUST be declared in src/shared/metadata-registry.ts (ADR-0036).')
  process.exit(1)
}
console.log('\ntest-metadata-registry: all checks passed.')
