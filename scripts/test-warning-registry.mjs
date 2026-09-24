import { strict as assert } from 'node:assert'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const {
  WARNING_REGISTRY,
  formatWarning,
  warningBadgesForSurface,
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

const unresolved = WARNING_REGISTRY.find((warning) => warning.id === 'unresolved-trigger')
assert.equal(unresolved?.severity, 'error', 'unresolved triggers are compiler errors')
assert.deepEqual(
  unresolved?.surfaces,
  ['strip-badge', 'inspector', 'doctor'],
  'unresolved triggers surface wherever the author can inspect or fix the slide'
)
const unknownTrigger = WARNING_REGISTRY.find((warning) => warning.id === 'unknown-trigger')
assert.equal(unknownTrigger?.severity, 'error', 'unknown bare triggers are compiler errors')
assert.deepEqual(
  unknownTrigger?.surfaces,
  ['strip-badge', 'inspector', 'doctor'],
  'unknown bare triggers use the same visible error surfaces'
)
const triggerConflict = WARNING_REGISTRY.find((warning) => warning.id === 'trigger-conflict')
assert.equal(triggerConflict?.severity, 'warning', 'last-wins trigger conflicts remain non-blocking warnings')
assert.deepEqual(
  triggerConflict?.surfaces,
  ['strip-badge', 'inspector', 'doctor'],
  'trigger conflicts are visible on every authoring warning surface'
)
const sectionOnlyLevel = WARNING_REGISTRY.find((warning) => warning.id === 'section-only-trigger-level')
assert.equal(sectionOnlyLevel?.severity, 'warning', 'wrong-level section-only triggers are compiler warnings')
assert.deepEqual(
  sectionOnlyLevel?.surfaces,
  ['strip-badge', 'inspector', 'doctor'],
  'wrong-level section-only triggers are visible on every authoring warning surface'
)
assert.equal(
  formatWarning('section-only-trigger-level:slide-7:timer-audience:3'),
  'Trigger “timer-audience” only applies to ## sections, but it appears on heading level 3. Move the trigger to a ## section heading.',
  'wrong-level section-only warnings identify the trigger and authored heading level'
)

const quoteTooLong = WARNING_REGISTRY.find((warning) => warning.id === 'quote-too-long')
assert.equal(quoteTooLong?.severity, 'warning', 'an overlong quote is a visible staged compiler warning')
const codeTooLong = WARNING_REGISTRY.find((warning) => warning.id === 'code-too-long')
assert.equal(codeTooLong?.severity, 'warning', 'an overlong code block is a visible staged compiler warning')
assert.deepEqual(
  quoteTooLong?.surfaces,
  ['strip-badge', 'inspector', 'doctor'],
  'overlong quotes surface wherever the author can inspect or fix the slide'
)

assert.deepEqual(
  warningBadgesForSurface(
    ['unresolved-trigger:layout=nonsense', 'trigger-conflict:layout:statement→quote', 'made-up-code:payload'],
    'strip-badge'
  ),
  [
    {
      id: 'unresolved-trigger',
      severity: 'error',
      text: 'Unresolved trigger: layout=nonsense. Register the token or fix it — the Layout Doctor lists every occurrence.'
    },
    {
      id: 'trigger-conflict',
      severity: 'warning',
      text: 'Conflicting trigger values: layout:statement→quote. Keep one value for this trigger.'
    },
    {
      id: 'made-up-code',
      severity: 'warning',
      text: 'made-up-code:payload'
    }
  ],
  'badge rendering retains warning identity and severity while preserving unknown codes'
)

console.log(`warning registry parity: ${WARNING_REGISTRY.length} registered codes, ${literalCodes.size} literal warnings.push codes`)
