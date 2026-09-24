#!/usr/bin/env node
// Vault-wide Layout Doctor audit (ADR-0020 D1: the audit ships BEFORE the tightening).
// Usage: node scripts/layout-audit.mjs <vaultRoot> [--out report.md]
import { lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { scanOutlineTriggers } from '../src/shared/layout-doctor.ts'

const [root, ...rest] = process.argv.slice(2)
if (!root) { console.error('usage: node scripts/layout-audit.mjs <vaultRoot> [--out report.md]'); process.exit(2) }
const outFlag = rest.indexOf('--out')
const outPath = outFlag >= 0 ? rest[outFlag + 1] : null

const SKIP_DIRS = new Set(['node_modules', '_ledger', '.git', 'artefacts', 'cache'])
function* markdownFiles(dir) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.') || SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    let st
    try { st = lstatSync(full) } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    if (st.isDirectory()) yield* markdownFiles(full)
    else if (name.endsWith('.md')) yield full
  }
}

const rows = []
const unreadable = []
let total = 0
for (const file of markdownFiles(root)) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    unreadable.push({
      file: relative(root, file),
      error: error?.code ? String(error.code) : 'read-error'
    })
    continue
  }
  const findings = scanOutlineTriggers(text)
  if (!findings.length) continue
  total += findings.length
  rows.push({ file: relative(root, file), findings })
}

const lines = [
  `# Layout audit — ${new Date().toISOString().slice(0, 10)}`,
  '',
  `Scanned vault: \`${root}\` — ${rows.length} file(s) with findings, ${total} finding(s) total, ${unreadable.length} unreadable file(s).`,
  ''
]
if (unreadable.length > 0) {
  lines.push('## Unreadable files', '', '| File | Error |', '| --- | --- |')
  for (const row of unreadable) lines.push(`| ${row.file} | ${row.error} |`)
  lines.push('')
}
for (const row of rows) {
  lines.push(`## ${row.file}`, '', '| Kind | Token | Line | Slide |', '| --- | --- | --- | --- |')
  for (const f of row.findings) lines.push(`| ${f.kind} | \`${f.token}\` | ${f.line} | ${f.slideTitle} |`)
  lines.push('')
}
const report = lines.join('\n')
if (outPath) writeFileSync(outPath, report)
else console.log(report)
process.exit(total || unreadable.length ? 1 : 0)
