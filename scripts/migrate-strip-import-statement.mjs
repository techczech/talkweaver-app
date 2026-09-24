#!/usr/bin/env node
// =============================================================================
// Vault migration — strip the importer's `{statement}` from bare section headings
//
// Ticket 1 made author tokens win over the section-divider default. The corpus diff
// 11b13a1 -> fb556b8 shows 337 slides moving `section-title` -> `statement`: headings that
// have child headings and no body of their own, carrying a `{statement}` (or
// `{layout=statement}`) token the PowerPoint importer stamped on them. Dominik decided
// (2026-09-11) to migrate the vault: remove that stale token so those headings stay dividers.
//
//   npm run migrate:strip-import-statement                  # DRY RUN (default) — writes nothing
//   npm run migrate:strip-import-statement -- --apply       # rewrites the library
//   npm run migrate:strip-import-statement -- --simulate    # dry run + simulated verification
//
// THE TARGET SET IS DATA-DRIVEN. It is read out of the two frozen corpus baselines
// (artefacts/corpus-baseline/11b13a1 and .../fb556b8) using the diff script's own
// diffSlides(), not inferred from the source. The count is asserted against EXPECTED_TARGETS.
//
// THE LIBRARY IS READ-ONLY unless --apply is passed, and --apply first re-checks that the
// library working tree is clean.
// =============================================================================

import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TRIGGER_LINE_RE, tokenizeTriggerBody } from '../compiler/scripts/lib/trigger-tokenizer.mjs'
import { diffSlides, loadSlides } from './corpus-composition-diff.mjs'
import { DEFAULT_LIBRARY } from './corpus-composition-baseline.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')

const BASE_DIR = join(repo, 'artefacts/corpus-baseline/11b13a1')
const NEXT_DIR = join(repo, 'artefacts/corpus-baseline/fb556b8')
const OUT_DIR = join(repo, 'artefacts/migration-strip-import-statement')

// The migration's own scope: the layout transition Ticket 1 caused on importer-stamped
// dividers. The 4 other transitions in the same diff (-> list, -> media) are hand-authored
// intent and are deliberately NOT touched.
const FROM_LAYOUT = 'section-title'
const TO_LAYOUT = 'statement'
const EXPECTED_TARGETS = 337

// The two written forms of the same token. `{statement}` is the Trigger Dictionary bare word;
// `{layout=statement}` is its explicit form. Both resolve to layout=statement.
const STATEMENT_TOKENS = new Set(['statement', 'layout=statement'])

const USAGE =
  'usage: node scripts/migrate-strip-import-statement.mjs [--apply] [--simulate] [--allow-dirty] [--library <dir>]\n'
  + '       default is DRY RUN: writes only artefacts/migration-strip-import-statement/{dry-run.diff,plan.json}'

// -----------------------------------------------------------------------------
// Target selection (data-driven, from the two frozen baselines)
// -----------------------------------------------------------------------------

export function selectTargets(baseDir = BASE_DIR, nextDir = NEXT_DIR) {
  const base = loadSlides(baseDir)
  const next = loadSlides(nextDir)
  const { changedByField } = diffSlides(base, next)
  const layoutChanges = changedByField.get('layout') ?? []
  return layoutChanges
    .filter((change) => change.base.layout === FROM_LAYOUT && change.next.layout === TO_LAYOUT)
    .map((change) => ({
      outline: change.next.outline,
      id: change.next.id,
      title: change.next.title,
      fromLayout: change.base.layout,
      toLayout: change.next.layout,
      fromRole: change.base.role,
      toRole: change.next.role
    }))
}

// -----------------------------------------------------------------------------
// Outline structure (headings, their trigger groups, their bodies)
// -----------------------------------------------------------------------------

// Split keeping every line's own terminator attached, so a rewrite is byte-preserving for
// CRLF files and for a file with no trailing newline.
function splitKeepingEndings(text) {
  return text.split(/(?<=\n)/)
}

function contentOf(line) {
  const match = String(line).match(/^([\s\S]*?)(\r?\n)?$/)
  return { body: match[1], ending: match[2] ?? '' }
}

const HEADING_RE = /^(#{1,6})\s+(.+)$/
const FENCE_RE = /^(```|~~~)/

// Every trailing `{…}` brace group on a heading line, as [start,end) spans into the line body.
// Mirrors parseHeadingAttrs's right-to-left peel: stop at the first non-brace trailing content.
function headingGroupSpans(body) {
  const spans = []
  let end = body.replace(/\s+$/, '').length
  for (;;) {
    if (end === 0 || body[end - 1] !== '}') break
    const open = body.lastIndexOf('{', end - 1)
    if (open < 0) break
    if (body.slice(open + 1, end - 1).includes('}')) break
    spans.unshift({ start: open, end })
    end = body.slice(0, open).replace(/\s+$/, '').length
  }
  return spans
}

// Every `{…}` group on a Trigger line (a body line consisting only of brace groups).
function triggerLineGroupSpans(body) {
  const spans = []
  const re = /\{[^}]*\}/g
  let match
  while ((match = re.exec(body))) spans.push({ start: match.index, end: match.index + match[0].length })
  return spans
}

// Walk one outline into heading records. For each heading: its line, level, the lines that
// make up its trigger group (the heading line itself, plus every Trigger line in its body),
// whether it has any real body content, and whether a deeper heading follows it directly.
export function parseOutline(text) {
  const lines = splitKeepingEndings(text)
  const headings = []
  let current = null
  let inFence = false
  let inComment = false
  let inNotes = false

  const closeCurrent = () => {
    if (current) headings.push(current)
    current = null
  }

  for (let index = 0; index < lines.length; index += 1) {
    const { body } = contentOf(lines[index])
    const trimmed = body.trim()

    if (FENCE_RE.test(trimmed)) {
      inFence = !inFence
      if (current && !inNotes) current.bodyLines.push(index)
      continue
    }
    if (inFence) {
      if (current && !inNotes) current.bodyLines.push(index)
      continue
    }

    const headingMatch = body.match(HEADING_RE)
    if (headingMatch && !inComment) {
      closeCurrent()
      inNotes = false
      current = {
        lineIndex: index,
        level: headingMatch[1].length,
        rawTitle: headingMatch[2],
        triggerLineIndices: [],
        bodyLines: [],
        hasChildren: false
      }
      continue
    }

    if (!current) continue
    if (trimmed.toLowerCase() === ':::notes') {
      inNotes = true
      continue
    }
    if (inNotes) continue

    // HTML comments are bookkeeping, not body.
    if (inComment) {
      if (trimmed.includes('-->')) inComment = false
      continue
    }
    if (trimmed.startsWith('<!--')) {
      if (!trimmed.includes('-->')) inComment = true
      continue
    }

    if (trimmed && TRIGGER_LINE_RE.test(trimmed)) {
      current.triggerLineIndices.push(index)
      continue
    }
    if (trimmed) current.bodyLines.push(index)
  }
  closeCurrent()

  for (let index = 0; index < headings.length; index += 1) {
    const next = headings[index + 1]
    headings[index].hasChildren = Boolean(next && next.level > headings[index].level)
  }
  return { lines, headings }
}

// Every (lineIndex, groupSpans) pair that makes up a heading's trigger group.
function triggerGroupLines(heading, lines) {
  const out = []
  const headingBody = contentOf(lines[heading.lineIndex]).body
  const spans = headingGroupSpans(headingBody)
  if (spans.length) out.push({ lineIndex: heading.lineIndex, spans, isHeadingLine: true })
  for (const lineIndex of heading.triggerLineIndices) {
    const body = contentOf(lines[lineIndex]).body
    out.push({ lineIndex, spans: triggerLineGroupSpans(body), isHeadingLine: false })
  }
  return out
}

function groupCarriesId(lines, group, slideId) {
  const body = contentOf(lines[group.lineIndex]).body
  for (const span of group.spans) {
    for (const token of tokenizeTriggerBody(body.slice(span.start + 1, span.end - 1))) {
      if (token.raw === `id=${slideId}`) return true
    }
  }
  return false
}

// -----------------------------------------------------------------------------
// The rewrite — byte-preserving removal of the statement token
// -----------------------------------------------------------------------------

// Remove every `{statement}` / `{layout=statement}` token from the given brace-group spans of
// one line, touching nothing else on that line. Returns { body, removed }.
export function stripStatementTokens(body, spans) {
  let out = body
  let removed = 0
  // Right-to-left so earlier offsets stay valid.
  for (const span of [...spans].sort((a, b) => b.start - a.start)) {
    const groupBody = out.slice(span.start + 1, span.end - 1)
    const tokens = tokenizeTriggerBody(groupBody)
    const hits = tokens.filter((token) => STATEMENT_TOKENS.has(token.raw))
    if (!hits.length) continue
    removed += hits.length
    if (hits.length === tokens.length) {
      // The whole group goes. Take one adjacent whitespace run with it — the one BEFORE the
      // group when there is preceding content, otherwise the one after.
      let start = span.start
      let end = span.end
      const before = out.slice(0, start)
      const trimmedBefore = before.replace(/\s+$/, '')
      if (trimmedBefore.length) start = trimmedBefore.length
      else end += out.slice(end).match(/^[^\S\r\n]*/)[0].length
      out = out.slice(0, start) + out.slice(end)
      continue
    }
    // Keep the group; remove just the offending tokens, each with one adjacent separator.
    let newGroupBody = groupBody
    for (const hit of [...hits].sort((a, b) => b.start - a.start)) {
      let start = hit.start
      let end = hit.end
      const before = newGroupBody.slice(0, start)
      const trimmedBefore = before.replace(/[\s,]+$/, '')
      if (trimmedBefore.length) start = trimmedBefore.length
      else end += newGroupBody.slice(end).match(/^[\s,]*/)[0].length
      newGroupBody = newGroupBody.slice(0, start) + newGroupBody.slice(end)
    }
    out = out.slice(0, span.start + 1) + newGroupBody + out.slice(span.end - 1)
  }
  return { body: out, removed }
}

// -----------------------------------------------------------------------------
// Planning one outline
// -----------------------------------------------------------------------------

// Plan every target that lives in one outline. Returns { edits, skipped, alreadyClean }.
//   edits        { lineIndex, before, after, deleteLine, tokensRemoved, target }
//   skipped      { target, reason }
//   alreadyClean targets whose heading carries no statement token any more (idempotency)
export function planOutline(text, targets) {
  const { lines, headings } = parseOutline(text)
  const edits = []
  const skipped = []
  const alreadyClean = []

  for (const target of targets) {
    const matches = headings.filter((heading) =>
      triggerGroupLines(heading, lines).some((group) => groupCarriesId(lines, group, target.id))
    )
    if (matches.length !== 1) {
      skipped.push({ target, reason: `heading id {id=${target.id}} found ${matches.length} times, expected exactly 1` })
      continue
    }
    const heading = matches[0]
    if (heading.bodyLines.length) {
      skipped.push({ target, reason: `heading has a non-empty body (${heading.bodyLines.length} content line(s))` })
      continue
    }
    if (!heading.hasChildren) {
      skipped.push({ target, reason: 'heading has no child headings' })
      continue
    }

    const groups = triggerGroupLines(heading, lines)
    const perLine = []
    for (const group of groups) {
      const { body, ending } = contentOf(lines[group.lineIndex])
      const { body: nextBody, removed } = stripStatementTokens(body, group.spans)
      if (!removed) continue
      const deleteLine = !group.isHeadingLine && !nextBody.trim()
      perLine.push({
        lineIndex: group.lineIndex,
        before: body,
        after: nextBody,
        ending,
        deleteLine,
        tokensRemoved: removed,
        target
      })
    }
    if (!perLine.length) {
      alreadyClean.push(target)
      continue
    }
    edits.push(...perLine)
  }

  edits.sort((a, b) => a.lineIndex - b.lineIndex)
  return { lines, edits, skipped, alreadyClean }
}

export function applyEdits(lines, edits) {
  const next = [...lines]
  const deletions = new Set()
  for (const edit of edits) {
    if (edit.deleteLine) deletions.add(edit.lineIndex)
    else next[edit.lineIndex] = edit.after + edit.ending
  }
  return next.filter((_, index) => !deletions.has(index)).join('')
}

// -----------------------------------------------------------------------------
// Unified diff
// -----------------------------------------------------------------------------

// A `diff -u` style rendering. Every edit is a single-line replace or a single-line delete at a
// known index, so hunks are built directly from those indices with 3 lines of context.
export function unifiedDiff(relPath, lines, edits, context = 3) {
  if (!edits.length) return ''
  const byLine = new Map(edits.map((edit) => [edit.lineIndex, edit]))
  const indices = [...byLine.keys()].sort((a, b) => a - b)

  const blocks = []
  for (const index of indices) {
    const last = blocks[blocks.length - 1]
    if (last && index - last[last.length - 1] <= context * 2 + 1) last.push(index)
    else blocks.push([index])
  }

  const strip = (line) => contentOf(line).body
  const out = [`--- a/${relPath}`, `+++ b/${relPath}`]
  for (const block of blocks) {
    const first = Math.max(0, block[0] - context)
    const last = Math.min(lines.length - 1, block[block.length - 1] + context)
    const body = []
    let oldCount = 0
    let newCount = 0
    for (let index = first; index <= last; index += 1) {
      const edit = byLine.get(index)
      if (!edit) {
        body.push(` ${strip(lines[index])}`)
        oldCount += 1
        newCount += 1
        continue
      }
      body.push(`-${strip(lines[index])}`)
      oldCount += 1
      if (!edit.deleteLine) {
        body.push(`+${edit.after}`)
        newCount += 1
      }
    }
    out.push(`@@ -${first + 1},${oldCount} +${first + 1},${newCount} @@`)
    out.push(...body)
  }
  return out.join('\n')
}

// -----------------------------------------------------------------------------
// Library cleanliness
// -----------------------------------------------------------------------------

export function libraryStatus(libraryDir) {
  return execFileSync('git', ['-C', libraryDir, 'status', '--porcelain'], { encoding: 'utf8' })
}

// --apply refuses to run on a dirty library. `--allow-dirty` narrows that to "no Markdown file
// may be dirty" — the app writes session JSON into the vault while it is open, and that dirt is
// not a reason to block a Markdown-only migration. It never permits a dirty outline.
function assertApplySafe(libraryDir, allowDirty) {
  const status = libraryStatus(libraryDir)
  const entries = status.split('\n').filter((line) => line.trim())
  if (!entries.length) return status
  const markdown = entries.filter((line) => /\.md$/i.test(line.trim()))
  if (!allowDirty || markdown.length) {
    const hint = allowDirty
      ? 'dirty Markdown file(s) in the library'
      : 'library working tree is not clean'
    throw new Error(`refusing to --apply: ${hint}\n${status}`)
  }
  return status
}

// -----------------------------------------------------------------------------
// Run
// -----------------------------------------------------------------------------

function groupByOutline(targets) {
  const byOutline = new Map()
  for (const target of targets) {
    if (!byOutline.has(target.outline)) byOutline.set(target.outline, [])
    byOutline.get(target.outline).push(target)
  }
  return byOutline
}

export function planAll(libraryDir, targets) {
  const byOutline = groupByOutline(targets)
  const files = []
  const skipped = []
  const alreadyClean = []
  for (const [outline, outlineTargets] of [...byOutline.entries()].sort()) {
    const path = join(libraryDir, outline)
    const text = readFileSync(path, 'utf8')
    const plan = planOutline(text, outlineTargets)
    skipped.push(...plan.skipped)
    alreadyClean.push(...plan.alreadyClean)
    if (!plan.edits.length) continue
    files.push({ outline, path, lines: plan.lines, edits: plan.edits })
  }
  return { files, skipped, alreadyClean }
}

export async function run({ libraryDir = DEFAULT_LIBRARY, apply = false, allowDirty = false, outDir = OUT_DIR } = {}) {
  const targets = selectTargets()
  if (targets.length !== EXPECTED_TARGETS) {
    throw new Error(
      `target count ${targets.length} does not match the expected ${EXPECTED_TARGETS} `
      + `(${FROM_LAYOUT} -> ${TO_LAYOUT} in ${BASE_DIR} -> ${NEXT_DIR}) — refusing to run`
    )
  }

  const statusBefore = libraryStatus(libraryDir)
  if (apply) assertApplySafe(libraryDir, allowDirty)

  const { files, skipped, alreadyClean } = planAll(libraryDir, targets)

  const diffs = files.map((file) => unifiedDiff(file.outline, file.lines, file.edits)).filter(Boolean)
  const diffText = diffs.length ? `${diffs.join('\n')}\n` : ''

  const plan = {
    mode: apply ? 'apply' : 'dry-run',
    library: libraryDir,
    baseBaseline: BASE_DIR,
    nextBaseline: NEXT_DIR,
    targetCount: targets.length,
    plannedEditCount: files.reduce((total, file) => total + file.edits.length, 0),
    plannedFileCount: files.length,
    alreadyCleanCount: alreadyClean.length,
    skippedCount: skipped.length,
    deletedLineCount: files.reduce(
      (total, file) => total + file.edits.filter((edit) => edit.deleteLine).length, 0
    ),
    skipped: skipped.map((entry) => ({ outline: entry.target.outline, id: entry.target.id, title: entry.target.title, reason: entry.reason })),
    alreadyClean: alreadyClean.map((target) => ({ outline: target.outline, id: target.id, title: target.title })),
    targets: files.flatMap((file) => file.edits.map((edit) => ({
      outline: file.outline,
      id: edit.target.id,
      title: edit.target.title,
      line: edit.lineIndex + 1,
      before: edit.before,
      after: edit.deleteLine ? null : edit.after,
      deleteLine: edit.deleteLine,
      tokensRemoved: edit.tokensRemoved
    })))
  }

  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'dry-run.diff'), diffText, 'utf8')
  writeFileSync(join(outDir, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`, 'utf8')

  if (apply) {
    for (const file of files) writeFileSync(file.path, applyEdits(file.lines, file.edits), 'utf8')
  }

  return { plan, files, diffText, statusBefore, statusAfter: libraryStatus(libraryDir) }
}

// -----------------------------------------------------------------------------
// Simulated verification — apply into a COPY and re-run the baseline over the copy
// -----------------------------------------------------------------------------

export async function simulate({ libraryDir = DEFAULT_LIBRARY, outDir = OUT_DIR } = {}) {
  const { runBaseline } = await import('./corpus-composition-baseline.mjs')
  const simRoot = join(outDir, 'simulated')
  rmSync(simRoot, { recursive: true, force: true })

  const targets = selectTargets()
  const { files } = planAll(libraryDir, targets)

  for (const file of files) {
    const destination = join(simRoot, file.outline)
    mkdirSync(dirname(destination), { recursive: true })
    cpSync(file.path, destination)
    writeFileSync(destination, applyEdits(file.lines, file.edits), 'utf8')
  }

  const simOut = join(outDir, 'simulated-baseline')
  rmSync(simOut, { recursive: true, force: true })
  const result = await runBaseline({ libraryDir: simRoot, outDir: simOut })

  // Diff the simulated rows against fb556b8, restricted to the outlines we copied.
  const outlines = new Set(files.map((file) => file.outline))
  const nextRows = loadSlides(NEXT_DIR).rows.filter((row) => outlines.has(row.outline))
  const simRows = loadSlides(simOut).rows
  const nextByKey = new Map(nextRows.map((row) => [`${row.outline} ${row.id}`, row]))
  const simByKey = new Map(simRows.map((row) => [`${row.outline} ${row.id}`, row]))
  const diff = diffSlides({ rows: nextRows, byKey: nextByKey }, { rows: simRows, byKey: simByKey })

  return { result, diff, outlines, targets, files, simRoot, simOut, nextRows, simRows }
}

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE)
    process.exit(0)
  }
  const apply = argv.includes('--apply')
  const wantsSimulation = argv.includes('--simulate')
  const allowDirty = argv.includes('--allow-dirty')
  const libraryIndex = argv.indexOf('--library')
  const libraryDir = libraryIndex >= 0 ? resolve(argv[libraryIndex + 1]) : DEFAULT_LIBRARY

  let outcome
  try {
    outcome = await run({ libraryDir, apply, allowDirty })
  } catch (error) {
    console.error(`migrate-strip-import-statement: ${error.message}`)
    process.exit(1)
  }
  const { plan, files, statusBefore, statusAfter } = outcome

  console.log(readFileSync(join(OUT_DIR, 'dry-run.diff'), 'utf8'))
  console.log(`mode:              ${plan.mode}`)
  console.log(`targets:           ${plan.targetCount}`)
  console.log(`files to change:   ${plan.plannedFileCount}`)
  console.log(`lines to change:   ${plan.plannedEditCount} (${plan.deletedLineCount} deleted outright)`)
  console.log(`already clean:     ${plan.alreadyCleanCount}`)
  console.log(`skipped:           ${plan.skippedCount}`)
  for (const entry of plan.skipped) console.log(`  SKIP ${entry.outline} #${entry.id} — ${entry.reason}`)
  console.log('')
  console.log('| Outline | Lines changed | Tokens removed |')
  console.log('| :--- | ---: | ---: |')
  for (const file of files) {
    const tokens = file.edits.reduce((total, edit) => total + edit.tokensRemoved, 0)
    console.log(`| ${file.outline} | ${file.edits.length} | ${tokens} |`)
  }
  console.log('')
  console.log(`library git status before: ${statusBefore.trim() ? `\n${statusBefore.trimEnd()}` : '(clean)'}`)
  console.log(`library git status after:  ${statusAfter.trim() ? `\n${statusAfter.trimEnd()}` : '(clean)'}`)

  if (wantsSimulation) {
    console.log('')
    console.log('== simulated verification (a COPY of the affected outlines; the library is not written) ==')
    const { result, diff, outlines, nextRows, simRows } = await simulate({ libraryDir })
    console.log(`copied outlines:   ${outlines.size}`)
    console.log(`baseline over copy: ${result.slideCount} slides from ${result.outlineCount} outlines → ${result.targetDir}`)
    console.log(`fb556b8 rows for the same outlines: ${nextRows.length}`)
    console.log(`simulated rows:                     ${simRows.length}`)
    console.log(`added: ${diff.added.length}   removed: ${diff.removed.length}`)
    for (const [field, changes] of diff.changedByField) {
      if (!changes.length) continue
      const groups = new Map()
      for (const change of changes) {
        const key = `${JSON.stringify(change.base[field])} -> ${JSON.stringify(change.next[field])}`
        groups.set(key, (groups.get(key) ?? 0) + 1)
      }
      console.log(`  ${field}: ${changes.length} changed`)
      for (const [key, count] of [...groups.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`      ${key}   (${count})`)
      }
    }
    console.log(`library git status after simulation: ${libraryStatus(libraryDir).trim() ? `\n${libraryStatus(libraryDir).trimEnd()}` : '(clean)'}`)
  }
}
