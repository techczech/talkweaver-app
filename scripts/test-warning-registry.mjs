import { strict as assert } from 'node:assert'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const {
  WARNING_REGISTRY,
  formatWarning,
  warningsForSurface
} = await import(new URL('../compiler/scripts/lib/warning-registry.mjs', import.meta.url))

const ids = new Set()
for (const warning of WARNING_REGISTRY) {
  assert(warning.id?.trim(), 'warning id is required')
  assert(!ids.has(warning.id), `duplicate warning id: ${warning.id}`)
  ids.add(warning.id)
  assert(['error', 'warning', 'hint'].includes(warning.severity), `${warning.id}: invalid severity`)
  assert(warning.message?.trim(), `${warning.id}: message template is required`)
  assert(warning.remedy?.trim() && /[.!?]$/.test(warning.remedy), `${warning.id}: remedy must be one actionable sentence`)
  assert(Array.isArray(warning.surfaces) && warning.surfaces.length > 0, `${warning.id}: surfaces are required`)
}

const libDir = join(root, 'compiler/scripts/lib')
const literalCodes = new Set()
for (const name of readdirSync(libDir).filter((name) => name.endsWith('.mjs') && name !== 'warning-registry.mjs')) {
  const source = readFileSync(join(libDir, name), 'utf8')
  for (const match of source.matchAll(/(?:\b|\.)warnings\.push\(\s*`([^`:$]+)(?::|`)/g)) literalCodes.add(match[1])
  for (const match of source.matchAll(/(?:\b|\.)warnings\.push\(\s*["']([^"':]+)(?::|["'])/g)) literalCodes.add(match[1])
}
assert.deepEqual([...literalCodes].filter((id) => !ids.has(id)).sort(), [], 'compiler warnings.push literal prefix lacks a registry entry')

assert.equal(formatWarning('made-up-code:payload'), 'made-up-code:payload', 'unknown warnings fall back to raw text')
const iconWarning = formatWarning('iconlist-no-icons:slide-1')
assert(iconWarning.includes('No icons resolved'), 'registered warning renders its message')
assert(iconWarning.includes('Choose concrete icon names'), 'registered warning renders its remedy')
assert.deepEqual(
  warningsForSurface(['iconlist-no-icons:slide-1', 'made-up-code:payload'], 'strip-badge'),
  [iconWarning, 'made-up-code:payload'],
  'surface rendering formats known codes and safely preserves unknown codes'
)

console.log(`warning registry parity: ${WARNING_REGISTRY.length} registered codes, ${literalCodes.size} literal warnings.push codes`)
