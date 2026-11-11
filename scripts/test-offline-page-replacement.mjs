import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const temp = mkdtempSync(join(tmpdir(), 'tw-offline-replacement-'))
try {
  const file = join(temp, 'policy.mjs')
  await build({ entryPoints: ['src/renderer/src/lib/offlinePage.ts'], bundle: true, platform: 'node', format: 'esm', outfile: file, logLevel: 'silent' })
  const { offlinePageCandidates, selectOfflinePage, offlinePageReplacement } = await import(pathToFileURL(file).href)
  const source = 'https://example.org/?x=1&y=2'
  const text = `### First\n\n\`\`\`\n[Embed: ${source}]\n~~~\n\`\`\`\n\n[Embed: ${source}]\n\n### Second\n\nPreserve this text.\n`
  assert.deepEqual(offlinePageCandidates(text, 1).map(item => item.source), [source])
  const selected = selectOfflinePage(text, 1).candidate
  const result = offlinePageReplacement(text, 1, selected, 'assets/offline-page.html')
  assert.ok(result.includes(`\`\`\`\n[Embed: ${source}]\n~~~\n\`\`\``), 'fenced example preserved')
  assert.ok(result.includes('[Embed: assets/offline-page.html]'))
  assert.ok(result.includes(`[Original page](<${source}>)`))
  assert.ok(result.endsWith('### Second\n\nPreserve this text.\n'))
  assert.equal(offlinePageReplacement(text, 1, selected, '../outside.html'), null)
  assert.equal(offlinePageReplacement(text + `\n[Embed: ${source}]`, 1, {...selected, source: 'https://not-here/'}, 'assets/offline.html'), null)
  const duplicate = `### A\n[Embed: ${source}]\n[Embed: ${source}]`
  assert.equal(selectOfflinePage(duplicate, 1).ok, false)
  const chosen = offlinePageCandidates(duplicate, 1)[1]
  assert.equal(offlinePageReplacement(duplicate, 1, chosen, 'assets/offline.html'), `### A\n[Embed: ${source}]\n[Embed: assets/offline.html]\n\n[Original page](<${source}>)`)
  assert.equal(offlinePageReplacement(duplicate, 1, {...chosen, line: 20}, 'assets/offline.html'), null)
  assert.equal(offlinePageReplacement(duplicate.replace('[Embed:', '[Simulation:'), 1, offlinePageCandidates(duplicate, 1)[0], 'assets/offline.html'), null)
  assert.equal(offlinePageReplacement(duplicate, 1, {...chosen, text: chosen.text + ' '}, 'assets/offline.html'), null)
  console.log('PASS: offline replacement, fenced examples, exact-line identity, ambiguity and path refusals')
} finally { rmSync(temp, { recursive: true, force: true }) }
