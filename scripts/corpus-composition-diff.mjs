#!/usr/bin/env node
// =============================================================================
// Corpus composition diff (Composition Programme, Ticket 0)
//
// Compares two corpus-baseline output directories slide by slide and says what a ticket
// actually moved: per-field change counts, then every slide whose layout, role, titleLayout or
// slotUse changed, grouped by (from -> to).
//
//   npm run corpus:diff -- artefacts/corpus-baseline/<baseSha> artefacts/corpus-baseline/<newSha>
//   node scripts/corpus-composition-diff.mjs <baseDir> <newDir>
//
// Slides are matched on (outline, id). A slide whose id changed reads as one removal plus one
// addition — that is the honest answer, since a changed id IS a change.
// =============================================================================

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

// Every field compared for the per-field change counts. The first four also get a grouped
// (from -> to) listing, because they are the composition decisions the programme is about.
const COMPARED_FIELDS = [
  'layout', 'role', 'titleLayout', 'slotUse', 'iconLists',
  'titleLayoutAttr', 'headingLevel', 'hasChildren', 'bodyEmpty', 'authorTokens',
  'mediaCount', 'textBlockKinds', 'blockTypes', 'quoteCite', 'wholeBoldParagraph',
  'wholeBoldParagraphCount', 'poll', 'warnings', 'title', 'slideIndex'
]
const GROUPED_FIELDS = ['layout', 'role', 'titleLayout', 'slotUse', 'iconLists']

export function loadSlides(dir) {
  const path = statSync(dir).isDirectory() ? join(dir, 'slides.jsonl') : dir
  if (!existsSync(path)) throw new Error(`no slides.jsonl at ${path}`)
  const rows = readFileSync(path, 'utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line))
  const byKey = new Map()
  for (const row of rows) byKey.set(`${row.outline} ${row.id}`, row)
  return { rows, byKey }
}

function render(value) {
  if (Array.isArray(value)) return value.length ? value.join(' ') : '(none)'
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, count]) => count)
    return entries.length ? entries.map(([key, count]) => `${key}:${count}`).join(' ') : '(none)'
  }
  if (value === '' || value == null) return '(empty)'
  return String(value)
}

function same(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

export function diffSlides(base, next) {
  const removed = []
  const added = []
  const changedByField = new Map(COMPARED_FIELDS.map((field) => [field, []]))

  for (const [key, baseRow] of base.byKey) {
    const nextRow = next.byKey.get(key)
    if (!nextRow) {
      removed.push(baseRow)
      continue
    }
    for (const field of COMPARED_FIELDS) {
      if (!same(baseRow[field], nextRow[field])) {
        changedByField.get(field).push({ base: baseRow, next: nextRow })
      }
    }
  }
  for (const [key, nextRow] of next.byKey) {
    if (!base.byKey.has(key)) added.push(nextRow)
  }
  return { removed, added, changedByField }
}

function report(baseDir, nextDir) {
  const base = loadSlides(baseDir)
  const next = loadSlides(nextDir)
  const { removed, added, changedByField } = diffSlides(base, next)

  const arrow = '->'
  const lines = []
  lines.push(`base: ${baseDir}  (${base.rows.length} slides)`)
  lines.push(`new:  ${nextDir}  (${next.rows.length} slides)`)
  lines.push('')
  lines.push(`slides added:   ${added.length}`)
  lines.push(`slides removed: ${removed.length}`)
  lines.push('')
  lines.push('Per-field change counts (slides present in both):')
  for (const field of COMPARED_FIELDS) {
    const count = changedByField.get(field).length
    lines.push(`  ${field.padEnd(24)} ${count}`)
  }

  for (const field of GROUPED_FIELDS) {
    const changes = changedByField.get(field)
    lines.push('')
    lines.push(`== ${field}: ${changes.length} changed ==`)
    if (!changes.length) {
      lines.push('  (no change)')
      continue
    }
    const groups = new Map()
    for (const change of changes) {
      const key = `${render(change.base[field])} ${arrow} ${render(change.next[field])}`
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(change.next)
    }
    for (const [key, slides] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
      lines.push(`  ${key}   (${slides.length})`)
      for (const slide of slides) lines.push(`      ${slide.outline}  #${slide.id}  ${slide.title}`)
    }
  }

  if (added.length) {
    lines.push('')
    lines.push('== added slides ==')
    for (const slide of added) lines.push(`  ${slide.outline}  #${slide.id}  ${slide.title}`)
  }
  if (removed.length) {
    lines.push('')
    lines.push('== removed slides ==')
    for (const slide of removed) lines.push(`  ${slide.outline}  #${slide.id}  ${slide.title}`)
  }

  return lines.join('\n')
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  const [baseArg, nextArg] = process.argv.slice(2)
  if (!baseArg || !nextArg) {
    console.error('usage: node scripts/corpus-composition-diff.mjs <baseDir> <newDir>')
    process.exit(2)
  }
  console.log(report(resolve(baseArg), resolve(nextArg)))
}
