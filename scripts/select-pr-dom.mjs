// Reads NUL-separated changed paths from git diff and selects scripts from the DOM inventory.
import { appendFileSync, readFileSync } from 'node:fs'
import { matchesGlob } from 'node:path'

const readJson = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'))
const { dom, prDom } = readJson('./test-tiers.json')
const { scripts } = readJson('../package.json')
const changed = new Set(readFileSync(0, 'utf8').split('\0').filter(Boolean))

for (const name of [...dom, ...prDom.smoke, ...prDom.poppler, ...prDom.owners.flatMap(owner => owner.tests)]) {
  if (!/^test:[\w:-]+$/.test(name) || !dom.includes(name) || typeof scripts[name] !== 'string') {
    throw new Error(`Unknown DOM script in prDom: ${name}`)
  }
}

const selected = new Set(prDom.smoke)
for (const { paths, tests } of prDom.owners) {
  if ([...changed].some(file => paths.some(pattern => matchesGlob(file, pattern)))) {
    for (const name of tests) selected.add(name)
  }
}
for (const name of dom) {
  // npm scripts name their JS entry point directly. Include it when its own source changes.
  const changedEntry = scripts[name].split(/\s+/).some(token =>
    token.startsWith('scripts/') && /\.[cm]?js$/.test(token) && changed.has(token))
  if (changedEntry) selected.add(name)
}

const shards = prDom.shards ?? {}
for (const [name, parts] of Object.entries(shards)) {
  if (!dom.includes(name) || !Array.isArray(parts) || parts.length < 2 || new Set(parts).size !== parts.length ||
      parts.some(part => !/^test:[\w:-]+$/.test(part) || typeof scripts[part] !== 'string' || dom.includes(part))) {
    throw new Error(`Invalid hosted DOM shards for ${name}`)
  }
}

const ubuntuExclusions = new Map(Object.entries(prDom.ubuntuExclusions ?? {}))
for (const [name, reason] of ubuntuExclusions) {
  if (!dom.includes(name) || typeof reason !== 'string' || !reason.trim() || /[\r\n]/.test(reason)) {
    throw new Error(`Invalid hosted Ubuntu DOM exclusion for ${name}`)
  }
  if (selected.has(name)) console.log(`Excluded from Ubuntu PR DOM: ${name}. ${reason}`)
}

const affected = dom.filter(name => selected.has(name) && !ubuntuExclusions.has(name))
const ordered = affected.flatMap(name => shards[name] ?? [name])
const needsPoppler = affected.some(name => prDom.poppler.includes(name))
console.log(`Selected ${affected.length} of ${dom.length} DOM scripts (${ordered.length} runs): ${ordered.join(' ')}`)
appendFileSync(process.env.GITHUB_OUTPUT, `scripts=${ordered.join(' ')}\npoppler=${needsPoppler}\n`)
