// Browser-only mock of window.tw — injected when running outside Electron
// Not imported in production; used only for dev preview in a plain browser

const MOCK_VAULT_ROOT = '/Users/you/Talks'

const MOCK_TALKS = [
  { name: 'ai-history-impact-on-expertise', path: MOCK_VAULT_ROOT + '/ai-topics/ai-history-impact-on-expertise', outlinePath: MOCK_VAULT_ROOT + '/ai-topics/ai-history-impact-on-expertise/ai-history-impact-on-expertise-outline.md', title: 'Ai History Impact On Expertise', slug: 'ai-history-impact-on-expertise' },
  { name: 'agents-for-research-reproducibility', path: MOCK_VAULT_ROOT + '/ai-topics/agents-for-research-reproducibility', outlinePath: MOCK_VAULT_ROOT + '/ai-topics/agents-for-research-reproducibility/agents-for-research-reproducibility-outline.md', title: 'Agents For Research Reproducibility', slug: 'agents-for-research-reproducibility' },
  { name: 'getting-started-with-codex-for-study', path: MOCK_VAULT_ROOT + '/ai-topics/getting-started-with-codex-for-study', outlinePath: MOCK_VAULT_ROOT + '/ai-topics/getting-started-with-codex-for-study/getting-started-with-codex-for-study-outline.md', title: 'Getting Started With Codex For Study', slug: 'getting-started-with-codex-for-study' },
  { name: 'vibecoding-for-lts', path: MOCK_VAULT_ROOT + '/ai-topics/vibecoding-for-lts', outlinePath: MOCK_VAULT_ROOT + '/ai-topics/vibecoding-for-lts/vibecoding-for-lts-outline.md', title: 'Vibecoding For Lts', slug: 'vibecoding-for-lts' },
]

const MOCK_OUTLINE = `---
title: AI History Impact on Expertise
---

## Introduction
{statement}

### The question we're asking today

This talk explores how artificial intelligence reshapes what it means to be an expert.

### Why this matters now

AI systems are crossing capability thresholds that were previously considered uniquely human.

## Historical context

### Early days of expert systems

Rule-based systems in the 1980s promised to capture expert knowledge in databases.

### The pattern recognition turn

Deep learning shifted the focus from explicit rules to learned representations.

## What expertise actually is

### Tacit knowledge
{contrast}

Experts know more than they can tell.

### The compilation of skill

With enough practice, deliberate processes become automatic.

## AI capabilities today

### Pattern recognition at scale

Modern AI matches or exceeds human performance on a growing list of pattern-recognition tasks.

### What AI still cannot do

Genuine understanding, embodied reasoning, and contextual judgment remain areas of human advantage.

## Implications

### The expertise paradox

AI may devalue some forms of expertise while amplifying the need for others.

### New forms of expertise

Working effectively with AI systems is itself becoming a form of expertise.

## Conclusion

### What this means for education

### What this means for professionals

### The path forward
`

// Minimal client-side compile for browser mock — parses ### headings into ProjectionRow shape
function mockCompile(outlinePath: string, content: string) {
  const slug = outlinePath.split('/').pop()?.replace('-outline.md', '') ?? 'mock'
  const lines = content.split('\n')
  const rows: any[] = []
  let order = 0
  let section = ''
  let subsection = ''
  let current: { title: string; lines: string[]; layout: string } | null = null

  const flush = () => {
    if (!current) return
    const excerpt = current.lines.join(' ').slice(0, 240)
    rows.push({
      slide_id: `${slug}:${order}`,
      deck_slug: slug,
      order: order++,
      section,
      subsection,
      role: order === 1 ? 'opening' : 'content',
      layout: current.layout || 'default',
      nav_title: current.title,
      title: current.title,
      text_excerpt: excerpt,
      word_count: excerpt.split(/\s+/).length,
      bullet_count: 0,
      image_count: 0,
      source_markdown: '',
      triggers: current.layout ? { layout: current.layout } : {},
      content_hash: `sha256-mock-${order}`
    })
    current = null
  }

  for (const line of lines) {
    if (line.startsWith('## ')) {
      section = line.replace(/^## /, '').replace(/\{[^}]*\}/g, '').trim()
    } else if (line.startsWith('### ')) {
      flush()
      const title = line.replace(/^### /, '').replace(/\{[^}]*\}/g, '').trim()
      const m = line.match(/\{([^}]+)\}/)
      const layout = m ? m[1].split('|')[0] : ''
      current = { title, lines: [], layout }
    } else if (current && line.trim() && !line.startsWith('#')) {
      current.lines.push(line.trim())
    }
  }
  flush()
  return rows
}

// ── Slide Ledger fixtures (browser dev for the propagation surfaces) ─────────
// One shared slide id used across TWO talks; THREE recorded versions (newest first, like
// listVersions); status rows show one 'behind' talk and one 'diverged' talk so both badge
// paths are exercisable in a plain browser.
const MOCK_SLIDE_ID = 'sl-mock1a2b'
const MOCK_LEDGER_TALKS = [
  { talk: 'ai-history-impact-on-expertise', outline: 'ai-topics/ai-history-impact-on-expertise/ai-history-impact-on-expertise-outline.md' },
  { talk: 'vibecoding-for-lts', outline: 'ai-topics/vibecoding-for-lts/vibecoding-for-lts-outline.md' }
]
const MOCK_VERSIONS = [
  {
    file: '2026-07-03T09-15-00Z_ai-history-impact-on-expertise.md',
    id: MOCK_SLIDE_ID, talk: 'ai-history-impact-on-expertise', outline: MOCK_LEDGER_TALKS[0].outline,
    savedAt: Date.parse('2026-07-03T09:15:00Z'), sealed: false, sealedBy: null, lineage: null,
    markdown: `### The question we're asking today {id=${MOCK_SLIDE_ID}}\n\nThis talk explores how artificial intelligence reshapes what it means to be an expert.\n\n- Capability thresholds are moving\n- Expertise is being redefined`
  },
  {
    file: '2026-07-01T14-02-00Z_vibecoding-for-lts.md',
    id: MOCK_SLIDE_ID, talk: 'vibecoding-for-lts', outline: MOCK_LEDGER_TALKS[1].outline,
    savedAt: Date.parse('2026-07-01T14:02:00Z'), sealed: true, sealedBy: 'present',
    lineage: null,
    markdown: `### The question we're asking today {id=${MOCK_SLIDE_ID}}\n\nThis talk explores how AI reshapes what it means to be an expert.\n\n- Capability thresholds are moving`
  },
  {
    file: '2026-06-28T10-30-00Z_ai-history-impact-on-expertise.md',
    id: MOCK_SLIDE_ID, talk: 'ai-history-impact-on-expertise', outline: MOCK_LEDGER_TALKS[0].outline,
    savedAt: Date.parse('2026-06-28T10:30:00Z'), sealed: true, sealedBy: 'build',
    lineage: null,
    markdown: `### The question we're asking today {id=${MOCK_SLIDE_ID}}\n\nHow does AI change expertise?`
  }
]

// Tiny inline-SVG placeholder thumbnails so the version strip renders in a plain browser
// (twthumb:// only exists in Electron).
function mockThumbDataUri(label: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#f7f3ea"/><rect x="8" y="8" width="304" height="164" fill="none" stroke="#c9bfa8"/><text x="160" y="96" font-family="sans-serif" font-size="16" fill="#6b6152" text-anchor="middle">${label}</text></svg>`
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg)
}

// Minimal line diff for the mock: common prefix/suffix as 'same', middle as del/add.
// Good enough for browser dev; the real LCS lives in the engine (ledger:diff).
function mockLineDiff(a: string, b: string): Array<{ kind: 'same' | 'del' | 'add'; text: string }> {
  const A = String(a ?? '').split('\n')
  const B = String(b ?? '').split('\n')
  let pre = 0
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++
  let suf = 0
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++
  const out: Array<{ kind: 'same' | 'del' | 'add'; text: string }> = []
  for (let i = 0; i < pre; i++) out.push({ kind: 'same', text: A[i] })
  for (let i = pre; i < A.length - suf; i++) out.push({ kind: 'del', text: A[i] })
  for (let i = pre; i < B.length - suf; i++) out.push({ kind: 'add', text: B[i] })
  for (let i = A.length - suf; i < A.length; i++) out.push({ kind: 'same', text: A[i] })
  return out
}

export function installMock() {
  ;(window as any).tw = {
    vault: {
      getRoot: async () => MOCK_VAULT_ROOT,
      setRoot: async (_path: string) => {},
      chooseRoot: async () => MOCK_VAULT_ROOT,
      listTalks: async () => MOCK_TALKS,
      createTalk: async (opts: { title: string; slug: string; topicFolder?: string }) => {
        const slug = opts.slug
        return {
          name: slug, path: MOCK_VAULT_ROOT + '/' + slug,
          outlinePath: MOCK_VAULT_ROOT + '/' + slug + '/' + slug + '-outline.md',
          title: opts.title, slug
        }
      },
    },
    talk: {
      readOutline: async (_path: string) => MOCK_OUTLINE,
      writeOutline: async (_path: string, _content: string) => true,
      compile: async (outlinePath: string, content: string) => mockCompile(outlinePath, content),
      checkEmbeds: async (_outlinePath: string, _content: string) => [],
      present: async (_outlinePath: string, _content: string) => {
        alert('Present mode: not available in browser mock — run in Electron')
        return { success: false, error: 'browser-only' }
      },
      build: async (_outlinePath: string, _content: string) => {
        alert('Build: not available in browser mock — run in Electron')
        return { success: false, error: 'browser-only' }
      },
    },
    search: {
      // Scoped/exact filter over every mock talk's compiled rows — same contract as
      // search:all-slides (empty query → everything; null never happens in the mock). Accepts a
      // bare string (legacy) or the structured query the Browser now sends. The mock has no
      // source_markdown/OCR, so 'body' falls back to the excerpt and 'image' matches nothing.
      allSlides: async (
        query:
          | string
          | { scope?: string; exact?: boolean; text?: string; terms?: string[] }
      ) => {
        const q =
          typeof query === 'string'
            ? { scope: 'all', exact: false, text: query, terms: (query || '').toLowerCase().split(/\s+/).filter(Boolean) }
            : {
                scope: query?.scope || 'all',
                exact: Boolean(query?.exact),
                text: query?.text || '',
                terms: Array.isArray(query?.terms) ? query!.terms!.filter(Boolean) : [],
              }
        const match = (hay: string): boolean =>
          q.exact ? hay.includes((q.text || '').toLowerCase()) : q.terms.every((t) => hay.includes(t))
        const results: any[] = []
        for (const talk of MOCK_TALKS) {
          for (const row of mockCompile(talk.outlinePath, MOCK_OUTLINE)) {
            const titleHay = `${row.nav_title}\n${row.title}`.toLowerCase()
            const bodyHay = `${row.text_excerpt}`.toLowerCase()
            const fieldHay =
              q.scope === 'title' ? titleHay
                : q.scope === 'body' ? bodyHay
                  : q.scope === 'image' ? ''
                    : `${titleHay}\n${bodyHay}`
            if (match(fieldHay)) {
              const titleHit = q.scope === 'title' ? true : match(titleHay)
              results.push({ ...row, talkSlug: talk.slug, talkTitle: talk.title, outlinePath: talk.outlinePath, talkMtimeMs: 0, talkMeta: '', titleHit })
            }
          }
        }
        return results
      },
    },
    ledger: {
      whereUsed: async (_id: string) => MOCK_LEDGER_TALKS.map(({ talk, outline }) => ({ talk, outline })),
      versions: async (_id: string) => MOCK_VERSIONS,
      // One 'behind' row (matches the middle recorded version) + one 'diverged' row
      // (local edit matching no version) — both propagation badges exercisable.
      status: async (_id: string, _adoptMarkdown: string) => [
        {
          talk: MOCK_LEDGER_TALKS[0].talk, outline: MOCK_LEDGER_TALKS[0].outline,
          status: 'behind', currentMarkdown: MOCK_VERSIONS[1].markdown, headingLine: 20
        },
        {
          talk: MOCK_LEDGER_TALKS[1].talk, outline: MOCK_LEDGER_TALKS[1].outline,
          status: 'diverged',
          currentMarkdown: `### The question we're asking today {id=${MOCK_SLIDE_ID}}\n\nA locally reworded framing of the expertise question.\n\n- Edited on this machine only`,
          headingLine: 8
        }
      ],
      // Detach the referenced block from its shared id: mint a fresh id and rewrite the block's
      // {id=…} (or stamp one if unstamped) so the browser-dev Focus surface can exercise the flow.
      detach: async (
        _outlinePath: string,
        content: string,
        ref: { heading: string; occurrence: number }
      ) => {
        const lines = String(content ?? '').split('\n')
        let seen = 0
        let headIdx = -1
        for (let i = 0; i < lines.length; i++) {
          if (lines[i] === ref.heading) { seen++; if (seen === (ref.occurrence || 1)) { headIdx = i; break } }
        }
        if (headIdx < 0) return null
        const newId = 'sl-' + Math.random().toString(36).slice(2, 8)
        let oldId = 'unknown'
        // Scan the heading + next two lines (heading / Trigger) for an existing {id=…}.
        let replaced = false
        for (let i = headIdx; i < Math.min(headIdx + 3, lines.length); i++) {
          const m = lines[i].match(/\{id=([A-Za-z0-9_-]+)\}/)
          if (m) { oldId = m[1]; lines[i] = lines[i].replace(m[0], `{id=${newId}}`); replaced = true; break }
        }
        if (!replaced) lines[headIdx] = lines[headIdx] + ` {id=${newId}}`
        return { text: lines.join('\n'), oldId, newId }
      },
      adopt: async (_id: string, _versionMarkdown: string, targetOutlines: string[]) => ({
        replaced: (targetOutlines ?? []).map((outline) => ({
          talk: outline.split('/').pop()?.replace('-outline.md', '') ?? outline, outline
        })),
        failed: []
      }),
      versionThumbnails: async (_id: string) =>
        Object.fromEntries(MOCK_VERSIONS.map((v, i) => [v.file, mockThumbDataUri(`version ${i + 1}`)])),
      diff: async (a: string, b: string) => mockLineDiff(a, b),
      // Two byte-identical UNSTAMPED copies → a freshly minted shared id, every copy reported merged
      // (oldId null because they carried no id). Mirrors the real 15-slide-merge happy path.
      mergeDuplicates: async (
        targets: Array<{ outline: string; heading: string; occurrence: number }>
      ) => ({
        ok: true as const,
        canonicalId: Math.random().toString(36).slice(2, 7),
        merged: (targets ?? []).map((t) => ({ outline: t.outline, oldId: null })),
        failed: [] as Array<{ outline: string; error: string }>
      }),
    },
    slide: {
      // Crude browser-only full-outline preview; Electron uses the real compiled deck.
      renderPreview: async (_outlinePath: string, outlineContent: string) => {
        const lines = String(outlineContent ?? '').split('\n')
        const title = (lines[0] ?? '').replace(/^#+\s*/, '').replace(/\{[^}]*\}/g, '').trim()
        const body = lines.slice(1).join('\n').trim()
        const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        return `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;display:grid;place-content:center;min-height:100vh;background:#f7f3ea;font-family:Georgia,serif;color:#2b2417}main{max-width:52rem;padding:3rem}h1{font-size:2.2rem;margin:0 0 1rem}pre{font-family:inherit;font-size:1.1rem;white-space:pre-wrap}</style></head><body><main><h1>${esc(title)}</h1><pre>${esc(body)}</pre></main></body></html>`
      },
    },
    asset: {
      pasteImage: async (_bytes: ArrayBuffer, _ext?: string) => {
        // Return a fake asset ID for browser preview
        return { id: 'img-mock001', ext: _ext ?? 'png', path: '/mock/_assets/img-mock001.png' }
      },
    },
  }
}
