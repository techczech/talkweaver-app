import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TRIGGER_DICTIONARY, VALUE_TRIGGER_DICTIONARY } from '../compiler/scripts/triggers.mjs'
import {
  FINITE_VALUE_TOKENS,
  GLOBAL_OPTION_GROUPS,
  LAYOUTS,
  OPEN_PATTERN_TOKENS
} from '../src/shared/layout-registry/entries.ts'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const compilerFiles = [
  join(root, 'compiler/scripts/lib/02-triggers-layout.mjs'),
  join(root, 'compiler/scripts/lib/08-source-adapters.mjs')
]

const openPatternKeys = new Set(OPEN_PATTERN_TOKENS.map((token) => token.key))

function attributeReads() {
  const keys = new Set()
  for (const file of compilerFiles) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/\b(?:slide\.)?attrs(?:\?\.)?\.([A-Za-z_$][\w$]*)/g)) keys.add(match[1])
    for (const match of source.matchAll(/\b(?:slide\.)?attrs(?:\?\.)?\[['"]([^'"]+)['"]\]/g)) keys.add(match[1])
  }
  // Hand-curated indirect reads in 08-source-adapters (`rawAttrs` / `a` aliases).
  for (const key of ['image', 'media', 'title', 'grid-linear', 'grid-zoom', 'contents']) keys.add(key)
  return keys
}

const optionGroups = [...GLOBAL_OPTION_GROUPS, ...LAYOUTS.flatMap((entry) => entry.options ?? [])]
const optionTokens = new Set()
for (const group of optionGroups) {
  for (const value of group.values) if (value.token) optionTokens.add(value.token)
  for (const token of group.dictionaryTokens ?? []) optionTokens.add(token)
}
for (const token of FINITE_VALUE_TOKENS) optionTokens.add(token)
// Layout-kind names and entries that resolve to a layout are the finite choosing vocabulary for
// explicit layout=<name> tokens. This mirrors buildTriggerVocabulary + dictionary generation.
for (const entry of LAYOUTS) {
  if (entry.kind === 'layout') optionTokens.add(`layout=${entry.name}`)
  if (entry.resolvesTo?.key === 'layout') optionTokens.add(`layout=${entry.resolvesTo.value}`)
  for (const raw of [entry.trigger, ...entry.aliases]) {
    const token = String(raw).replace(/^\{|\}$/g, '')
    if (token.includes('=')) optionTokens.add(token)
  }
}

// Values discovered in compiler branches or legacy aliases rather than VALUE_TRIGGER_DICTIONARY.
// Keeping them explicit makes new/changed branches reviewable instead of relying on key-only scans.
const CURATED_COMPILER_VALUES = [
  'equation=pills', 'equation=circle', 'equation=square', 'equation=oval',
  'flow=horizontal', 'flow=vertical', 'flow=loop', 'flow=branch',
  'image=left', 'image=right', 'media=left', 'media=right',
  'mode=reveal', 'mode=focus', 'reveal=steps',
  'title=show', 'title=compact'
]
const uncoveredCuratedValues = CURATED_COMPILER_VALUES.filter((token) => !optionTokens.has(token))
assert.deepEqual(uncoveredCuratedValues, [], 'Curated compiler value(s) lack an OptionGroup value or dictionaryToken')

const entryWords = new Set(LAYOUTS.flatMap((entry) => [
  ...entry.triggerWords,
  ...(entry.bareAliases ?? []).map((alias) => alias.word)
]))
assert.deepEqual(
  Object.keys(TRIGGER_DICTIONARY).filter((word) => !entryWords.has(word)),
  [],
  'Bare compiler trigger(s) lack a layout-registry entry'
)

const uncoveredValues = []
for (const [key, values] of Object.entries(VALUE_TRIGGER_DICTIONARY)) {
  for (const value of values) {
    const token = `${key}=${value}`
    if (!optionTokens.has(token)) uncoveredValues.push(token)
  }
}
assert.deepEqual(uncoveredValues, [], 'Compiler value trigger(s) lack an OptionGroup value')

const registeredKeys = new Set()
for (const token of optionTokens) registeredKeys.add(token.includes('=') ? token.slice(0, token.indexOf('=')) : token)
for (const entry of LAYOUTS) {
  const target = entry.resolvesTo ?? (entry.kind === 'layout'
    ? { key: 'layout' }
    : { key: entry.name })
  registeredKeys.add(target.key)
}

const uncoveredReads = [...attributeReads()]
  .filter((key) => !registeredKeys.has(key) && !openPatternKeys.has(key))
  .sort()
assert.deepEqual(
  uncoveredReads,
  [],
  `Compiler-readable slide option(s) are uncovered: ${uncoveredReads.join(', ')}. Add each to a registry OptionGroup or OPEN_PATTERN_TOKENS.`
)

// ADR-0020 R4: EVERY key the compiler can meet has a declared value story — a finite group
// vocabulary or a registry open pattern. Both directions; no vacuous keys.
const declaredKeys = new Set([...Object.keys(VALUE_TRIGGER_DICTIONARY), ...openPatternKeys])
const readsWithoutValueStory = [...attributeReads()]
  .filter((key) => !declaredKeys.has(key))
  .filter((key) => {
    // A key produced ONLY by bare boolean flags (e.g. {reveal}, {sub}) is value-free by design.
    const flagOnly = Object.values(TRIGGER_DICTIONARY).some((token) => token.key === key && token.value === true)
    return !flagOnly
  })
  .sort()
assert.deepEqual(
  readsWithoutValueStory,
  [],
  `Compiler-readable key(s) with neither a value vocabulary nor an open pattern: ${readsWithoutValueStory.join(', ')} (ADR-0020 R4)`
)

// And no double declaration: inspect the raw registry tokens BEFORE generator/runtime precedence
// filters open-pattern keys out of VALUE_TRIGGER_DICTIONARY.
const rawFiniteKeys = new Set(
  [...optionTokens]
    .filter((token) => token.includes('='))
    .map((token) => token.slice(0, token.indexOf('=')))
)
function assertNoOpenFiniteContradictions(openKeys, finiteKeys) {
  const doubleDeclared = [...openKeys].filter((key) => finiteKeys.has(key)).sort()
  assert.deepEqual(doubleDeclared, [], `Key(s) declared both open and finite: ${doubleDeclared.join(', ')}`)
}

assertNoOpenFiniteContradictions(openPatternKeys, rawFiniteKeys)
assert.throws(
  () => assertNoOpenFiniteContradictions(new Set(['fixture-key']), new Set(['fixture-key'])),
  /Key\(s\) declared both open and finite: fixture-key/,
  'the open/finite contradiction gate detects an inline fixture without environment seams'
)

console.log(`options parity: ${Object.keys(TRIGGER_DICTIONARY).length} bare triggers, ${optionTokens.size} option tokens and ${attributeReads().size} compiler attribute reads covered`)
