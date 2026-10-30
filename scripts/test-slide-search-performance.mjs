// Slide Browser search: speed on a synthetic corpus (>= 3,000 slides over 40 talks), old matching vs
// src/main/slide-search.ts. Prints both numbers; asserts only the NEW path against generous budgets
// (they trip on a large regression, not on CI noise). `legacyScan` below is a faithful copy of the
// per-query loop `search:all-slides` ran before the module existed: lowercase title and the whole
// source_markdown per row per query, plus the memoised image-text lookup.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { pathStaysInside } from '../src/main/path-containment.ts'
import { createSlideSearch, matchHay, normalizeSearchQuery } from '../src/main/slide-search.ts'
import { extractImageRefs, resolveImagePaths } from '../src/main/slide-image-refs.ts'
import { compactSlideSearchReply, expandSlideSearchReply } from '../src/shared/slide-search-reply.ts'

let seed = 7
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32 }
const pick = (a) => a[Math.floor(rnd() * a.length)]
const vocab = Array.from({ length: 3000 }, (_, i) => 'w' + (i * 7919).toString(36))
for (let i = 0; i < vocab.length; i++) if (rnd() < 0.4) vocab[i] = vocab[i][0].toUpperCase() + vocab[i].slice(1) // real prose is mixed case: lowercasing it is real work
vocab[0] = 'alpha'; vocab[1] = 'bravo'; vocab[2] = 'charlie'
const sentence = (n) => Array.from({ length: n }, () => pick(vocab)).join(' ')

const root = mkdtempSync(join(tmpdir(), 'tw-slide-search-perf-'))
const TALKS = 40, SLIDES = 80, PER_TALK = 6, IMAGES = TALKS * PER_TALK
const ocr = new Map()
const talks = []
try {
  for (let t = 0; t < TALKS; t++) {
    const dir = join(root, `talk-${t}`)
    mkdirSync(join(dir, 'assets'), { recursive: true })
    const rows = []
    for (let s = 0; s < SLIDES; s++) {
      let md = `### ${sentence(4)}\n\n` + Array.from({ length: 4 + Math.floor(rnd() * 20) }, () => `- ${sentence(8 + Math.floor(rnd() * 12))}`).join('\n')
      if (rnd() < 0.2 || (t === 5 && s === 3)) md += `\n\n![${sentence(2)}](assets/pic-${t}-${t === 5 && s === 3 ? 0 : Math.floor(rnd() * PER_TALK)}.png)`
      rows.push({ slide_id: `t${t}s${s}`, content_hash: `h${t}-${s}`, nav_title: sentence(3), title: sentence(4), source_markdown: md })
    }
    talks.push({ outline: join(dir, `talk-${t}-outline.md`), dir, rows, freshness: `${1000 + t}|tag` })
  }
  for (let t = 0; t < TALKS; t++) for (let k = 0; k < PER_TALK; k++) {
    const p = join(root, `talk-${t}`, 'assets', `pic-${t}-${k}.png`)
    writeFileSync(p, '')
    ocr.set(p, sentence(30) + (t === 5 && k === 0 ? ' zebracrossing' : ''))
  }
  const total = talks.reduce((n, t) => n + t.rows.length, 0)
  assert.ok(total >= 3000, 'corpus is at least 3,000 slides')

  const queries = {
    'empty query': normalizeSearchQuery({ scope: 'all', exact: false, text: '', terms: [] }),
    'one word': normalizeSearchQuery({ scope: 'all', exact: false, text: 'alpha', terms: ['alpha'] }),
    'two words': normalizeSearchQuery({ scope: 'all', exact: false, text: 'alpha bravo', terms: ['alpha', 'bravo'] }),
    'image scope': normalizeSearchQuery({ scope: 'image', exact: false, text: 'zebracrossing', terms: ['zebracrossing'] })
  }

  // ---- old behaviour --------------------------------------------------------------------------
  const memo = new Map()
  function legacyOcrText(row, talkDir) {
    const key = root + '\u0000' + row.content_hash
    const m = memo.get(key)
    if (m !== undefined) return m
    let text = ''
    for (const mm of String(row.source_markdown || '').matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
      let s = mm[1].trim().replace(/\s+"[^"]*"$/, '')
      const abs = pathStaysInside(root, s.startsWith('/') ? s : join(talkDir, s)) ? join(talkDir, s) : null
      if (abs) { const c = ocr.get(abs); if (c) text += '\n' + c }
    }
    text = text.toLowerCase(); memo.set(key, text); return text
  }
  function legacyScan(q) {
    const results = []
    for (const t of talks) for (const row of t.rows) {
      const titleHay = `${row.nav_title || ''}\n${row.title || ''}`.toLowerCase()
      const bodyHay = String(row.source_markdown || '').toLowerCase()
      const imageHay = legacyOcrText(row, t.dir)
      const hay = q.scope === 'title' ? titleHay : q.scope === 'body' ? bodyHay : q.scope === 'image' ? imageHay : `${titleHay}\n${bodyHay}\n${imageHay}`
      if (matchHay(hay, q)) results.push({ ...row, titleHit: q.scope === 'title' ? true : matchHay(titleHay, q) })
    }
    return results
  }

  // ---- new module -----------------------------------------------------------------------------
  let generation = 1
  const search = createSlideSearch({ imageText: { generation: () => generation, textLower: (p) => (ocr.get(p) ?? '').toLowerCase() } })
  const loadTalk = (t) => Promise.resolve({ key: t.outline, freshness: t.freshness, rows: t.rows, imageRefsFor: (row) => extractImageRefs(row.source_markdown), resolveImages: (refs) => resolveImagePaths(refs, t.dir, root) })
  async function newScan(q) {
    const hits = await search.scan({ query: q, talks, load: loadTalk })
    return hits.map((h) => ({ ...h.row, titleHit: h.titleHit }))
  }

  const time = async (fn) => { const t0 = performance.now(); const r = await fn(); return [performance.now() - t0, r] }
  const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]
  const report = []
  const budgets = { 'empty query': 400, 'one word': 150, 'two words': 150, 'image scope': 150 }
  let coldFirst = true
  for (const [name, q] of Object.entries(queries)) {
    const oldTimes = []; let oldRes
    for (let i = 0; i < 5; i++) { const [ms, r] = await time(() => legacyScan(q)); oldTimes.push(ms); oldRes = r }
    const [coldMs, newRes] = await time(() => newScan(q))
    const warm = []
    for (let i = 0; i < 5; i++) warm.push((await time(() => newScan(q)))[0])
    assert.deepEqual(newRes.map((r) => r.slide_id), oldRes.map((r) => r.slide_id), `${name}: same slides in the same order as the old scan`)
    assert.deepEqual(newRes.map((r) => r.titleHit), oldRes.map((r) => r.titleHit), `${name}: same titleHit flags`)
    report.push({ query: name, hits: newRes.length, 'old first ms': +oldTimes[0].toFixed(1), 'old median ms': +median(oldTimes).toFixed(1), 'new first ms': +coldMs.toFixed(1), 'new warm median ms': +median(warm).toFixed(1) })
    assert.ok(median(warm) < budgets[name], `${name}: warm scan ${median(warm).toFixed(1)}ms is under the ${budgets[name]}ms budget`)
    if (coldFirst) { coldFirst = false; assert.ok(coldMs < 3000, `first scan including preparation ${coldMs.toFixed(0)}ms is under 3000ms`) }
  }
  assert.ok(report.find((r) => r.query === 'image scope').hits >= 1, 'the image-scope word is found through the picture text')
  // After picture text changes, the next scan re-resolves every row that names a picture (so a picture
  // that arrived later is picked up): that scan, too, stays inside a budget.
  generation += 1
  const [refreshMs] = await time(() => newScan(queries['one word']))
  console.log(`scan right after a picture-text change (rows with pictures re-resolved): ${refreshMs.toFixed(1)}ms`)
  assert.ok(refreshMs < 600, `re-resolving scan ${refreshMs.toFixed(1)}ms is under 600ms`)
  // Context only (not asserted, not changed here): what handing the empty query's rows to the renderer costs.
  const everything = await newScan(queries['empty query'])
  const [cloneMs] = await time(() => structuredClone(everything))
  console.log(`structured clone of the empty-query result (the IPC payload shape): ${cloneMs.toFixed(1)}ms for ${everything.length} rows`)
  console.log(`corpus: ${total} slides, ${TALKS} talks, ${IMAGES} pictures`)
  console.table(report)

  // ---- the empty-query reply the Browser receives: full rows vs the compact reply ------------------
  // ~8,600 rows shaped like the compiler's projection rows (10-projections.mjs), per-talk fields
  // as main adds them. On the owner's vault (8,653 rows) the full reply was 16.86 M characters.
  const BIG_TALKS = 108, BIG_SLIDES = 80
  const bigHits = []
  for (let t = 0; t < BIG_TALKS; t++) {
    const slug = `talk-${t}-${sentence(2).toLowerCase().replace(/\s+/g, '-')}`
    const talk = {
      vaultId: '35122fd6-105c-49bb-8960-2b3d38e4b1fe', slug, title: sentence(5),
      outlinePath: `/fixture/cloud-storage/shared-folder/presentations-library/${slug}/${slug}-outline.md`,
      mtimeMs: 1790000000000 + t, meta: `event: ${sentence(4)}\ndate: 2026-0${1 + (t % 9)}-1${t % 10}\nvenue: ${sentence(3)}\naudience: ${sentence(6)}\ntags: ${sentence(5)}\nsummary: ${sentence(25)}`
    }
    for (let s = 0; s < BIG_SLIDES; s++) {
      const md = `### ${sentence(5)}\n\n` + Array.from({ length: 2 + Math.floor(rnd() * 4) }, () => `- ${sentence(5 + Math.floor(rnd() * 6))}`).join('\n')
      const hash = 'sha256-' + Array.from({ length: 64 }, () => Math.floor(rnd() * 16).toString(16)).join('')
      const row = {
        slide_id: `${slug}-slide-${s + 1}`, id_source: 'auto', derived_id_basis: `${slug}:${hash}`, deck_slug: slug, order: s,
        section: `section-${Math.floor(s / 10)}`, subsection: '', role: 'content', layout: s % 5 ? '' : 'statement',
        nav_title: sentence(4), title: sentence(5), text_excerpt: md.slice(0, 240), word_count: 40, bullet_count: 4, image_count: 0,
        embed_count: 0, has_quote: false, has_table: false, has_code: false, source_markdown: md, source_line: s * 6 + 1,
        triggers: {}, tags: [], content_hash: hash, render_hash: hash.replace('sha256-', 'sha256-r'),
        title_layout: 'top', elements: [{ kind: 'heading', text: sentence(4) }, { kind: 'list', items: 4 }], image_placements: [], warnings: []
      }
      bigHits.push({ talk, row, titleHit: false })
    }
  }
  const fullReply = bigHits.map(({ talk, row, titleHit }) => ({ ...row, vaultId: talk.vaultId, talkSlug: talk.slug, talkTitle: talk.title, outlinePath: talk.outlinePath, talkMtimeMs: talk.mtimeMs, talkMeta: talk.meta, titleHit }))
  const compact = compactSlideSearchReply(bigHits, ({ talk, row, titleHit }) => ({
    row, titleHit, talk: { talkSlug: talk.slug, talkTitle: talk.title, outlinePath: talk.outlinePath, vaultId: talk.vaultId, talkMtimeMs: talk.mtimeMs, talkMeta: talk.meta }
  }), 'stamp-7')
  const fullChars = JSON.stringify(fullReply).length
  const compactChars = JSON.stringify(compact).length
  const [fullCloneMs] = await time(() => structuredClone(fullReply))
  const [compactCloneMs, cloned] = await time(() => structuredClone(compact))
  const [expandMs, expanded] = await time(() => expandSlideSearchReply(cloned))
  console.log(`empty-query reply for ${bigHits.length} rows / ${BIG_TALKS} talks: full ${(fullChars / 1e6).toFixed(2)} M chars (clone ${fullCloneMs.toFixed(1)}ms) -> compact ${(compactChars / 1e6).toFixed(2)} M chars (clone ${compactCloneMs.toFixed(1)}ms, expand ${expandMs.toFixed(1)}ms), ${(100 * compactChars / fullChars).toFixed(0)}%`)
  assert.equal(expanded.length, fullReply.length, 'the compact reply expands to every row')
  for (const i of [0, 1234, expanded.length - 1]) {
    for (const k of ['talkSlug', 'talkTitle', 'outlinePath', 'vaultId', 'talkMtimeMs', 'talkMeta', 'titleHit', 'slide_id', 'source_markdown', 'content_hash', 'render_hash', 'section', 'order', 'tags']) {
      assert.deepEqual(expanded[i][k], fullReply[i][k], `row ${i}: ${k} survives the compact reply`)
    }
    assert.equal(expanded[i].elements, undefined, 'unread fields are dropped')
    assert.equal(expanded[i].t, undefined, 'the talk index is not left on the row')
  }
  assert.equal(compact.stamp, 'stamp-7', 'the reply carries the freshness stamp')
  assert.ok(compactChars < fullChars * 0.6, `compact reply ${compactChars} is under 60% of the full ${fullChars}`)
  console.log('PASS slide search performance: parity with the old scan, warm queries inside budget, compact reply')
} finally {
  rmSync(root, { recursive: true, force: true })
}
