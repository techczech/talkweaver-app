// Pure publishing logic (no Electron/fs). The replica in scripts/test-publishing-logic.mjs MUST
// match these algorithms (the main process has no TS test runner — same convention as
// searchPaletteSelection.ts / test-selector-logic.mjs).

const CFG_ERR = 'Configure Cloudflare publishing in Settings → Publishing (see docs/PUBLISHING.md)'
const WRANGLER_ERR = 'wrangler not found — install it (npm i -g wrangler) — see docs/PUBLISHING.md'

export function checkPreconditions(c: {
  accountId?: string
  project?: string
  hasToken: boolean
  wranglerFound: boolean
}): { ok: true } | { ok: false; error: string } {
  if (!c.accountId || !c.project || !c.hasToken) return { ok: false, error: CFG_ERR }
  if (!c.wranglerFound) return { ok: false, error: WRANGLER_ERR }
  return { ok: true }
}

export function resolveBase(opts: { baseUrl?: string; project: string }): string {
  const raw = opts.baseUrl && opts.baseUrl.trim() ? opts.baseUrl.trim() : `https://${opts.project}.pages.dev`
  return raw.replace(/\/+$/, '')
}

export function publishUrl(opts: { base: string; slug: string; id?: string; useShortIds: boolean }): string {
  if (opts.useShortIds && opts.id) return `${opts.base}/${opts.id}`
  return `${opts.base}/${opts.slug}/`
}

export function augmentedPath(processPath?: string): string {
  return ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', processPath || '']
    .filter(Boolean)
    .join(':')
}

export function readHandoutUrl(text: string): string | null {
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  const scope = fm ? fm[1] : ''
  const m = scope.match(/^\s*handout_url\s*:\s*(.+?)\s*$/m)
  return m ? m[1].replace(/^["']|["']$/g, '') : null
}

export function recoverIdFromUrl(handoutUrl: string | null | undefined, base: string): string | null {
  if (!handoutUrl) return null
  const b = base.replace(/\/+$/, '')
  if (!handoutUrl.startsWith(b + '/')) return null
  const rest = handoutUrl.slice(b.length + 1).replace(/\/+$/, '')
  return /^[a-z0-9]{3,8}$/.test(rest) ? rest : null
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
export function generateShortId(rand: (n: number) => Uint8Array): string {
  const bytes = rand(4)
  let s = ''
  for (let i = 0; i < 4; i++) s += ALPHABET[bytes[i] % 36]
  return s
}

export function pickShortId(opts: {
  registry: Record<string, string>
  slug: string
  recoveredId?: string | null
  gen: () => string
}): { id: string; registry: Record<string, string> } {
  const { registry, slug } = opts
  if (registry[slug]) return { id: registry[slug], registry }
  const used = new Set(Object.values(registry))
  let id: string | null = null
  if (opts.recoveredId && !used.has(opts.recoveredId)) id = opts.recoveredId
  while (!id) {
    const c = opts.gen()
    if (!used.has(c)) id = c
  }
  return { id, registry: { ...registry, [slug]: id } }
}

export function buildRedirects(registry: Record<string, string>, existingSlugs: Iterable<string>): string {
  const exists = new Set(existingSlugs)
  const lines = Object.entries(registry)
    .filter(([slug]) => exists.has(slug))
    .sort((a, b) => a[1].localeCompare(b[1]))
    .map(([slug, id]) => `/${id}  /${slug}/  302`)
  return lines.length ? lines.join('\n') + '\n' : ''
}

export function stampHandoutUrl(outlineText: string, url: string): string {
  const fm = outlineText.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!fm) return outlineText
  const lines = fm[1].split(/\r?\n/)
  const idx = lines.findIndex((l) => /^\s*handout_url\s*:/.test(l))
  if (idx >= 0) lines[idx] = `handout_url: ${url}`
  else lines.push(`handout_url: ${url}`)
  return outlineText.slice(0, fm.index!) + `---\n${lines.join('\n')}\n---` + outlineText.slice(fm.index! + fm[0].length)
}
