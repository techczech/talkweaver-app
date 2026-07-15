// Verifies the pure publishing logic. The functions below MUST match src/main/publishing-logic.ts
// exactly (same algorithm) — this is a logic guard, since the main process has no TS test runner.
// (Same convention as scripts/test-selector-logic.mjs.)

const CFG_ERR = 'Configure Cloudflare publishing in Settings → Publishing (see docs/PUBLISHING.md)'
const WRANGLER_ERR = 'wrangler not found — install it (npm i -g wrangler) — see docs/PUBLISHING.md'

function checkPreconditions(c) {
  if (!c.accountId || !c.project || !c.hasToken) return { ok: false, error: CFG_ERR }
  if (!c.wranglerFound) return { ok: false, error: WRANGLER_ERR }
  return { ok: true }
}
function resolveBase(opts) {
  const raw = opts.baseUrl && opts.baseUrl.trim() ? opts.baseUrl.trim() : `https://${opts.project}.pages.dev`
  return raw.replace(/\/+$/, '')
}
function publishUrl(opts) {
  if (opts.useShortIds && opts.id) return `${opts.base}/${opts.id}`
  return `${opts.base}/${opts.slug}/`
}
function augmentedPath(processPath) {
  return ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', processPath || '']
    .filter(Boolean).join(':')
}
function readHandoutUrl(text) {
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  const scope = fm ? fm[1] : ''
  const m = scope.match(/^\s*handout_url\s*:\s*(.+?)\s*$/m)
  return m ? m[1].replace(/^["']|["']$/g, '') : null
}
function recoverIdFromUrl(handoutUrl, base) {
  if (!handoutUrl) return null
  const b = base.replace(/\/+$/, '')
  if (!handoutUrl.startsWith(b + '/')) return null
  const rest = handoutUrl.slice(b.length + 1).replace(/\/+$/, '')
  return /^[a-z0-9]{3,8}$/.test(rest) ? rest : null
}
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
function generateShortId(rand) {
  const bytes = rand(4)
  let s = ''
  for (let i = 0; i < 4; i++) s += ALPHABET[bytes[i] % 36]
  return s
}
function pickShortId(opts) {
  const { registry, slug } = opts
  if (registry[slug]) return { id: registry[slug], registry }
  const used = new Set(Object.values(registry))
  let id = null
  if (opts.recoveredId && !used.has(opts.recoveredId)) id = opts.recoveredId
  while (!id) { const c = opts.gen(); if (!used.has(c)) id = c }
  return { id, registry: { ...registry, [slug]: id } }
}
function buildRedirects(registry, existingSlugs) {
  const exists = new Set(existingSlugs)
  const lines = Object.entries(registry)
    .filter(([slug]) => exists.has(slug))
    .sort((a, b) => a[1].localeCompare(b[1]))
    .map(([slug, id]) => `/${id}  /${slug}/  302`)
  return lines.length ? lines.join('\n') + '\n' : ''
}
function stampHandoutUrl(outlineText, url) {
  const fm = outlineText.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!fm) return outlineText
  const lines = fm[1].split(/\r?\n/)
  const idx = lines.findIndex((l) => /^\s*handout_url\s*:/.test(l))
  if (idx >= 0) lines[idx] = `handout_url: ${url}`
  else lines.push(`handout_url: ${url}`)
  return outlineText.slice(0, fm.index) + `---\n${lines.join('\n')}\n---` + outlineText.slice(fm.index + fm[0].length)
}

let fail = 0
const ck = (c, m) => { if (!c) { console.error('FAIL:', m); fail++ } }

// checkPreconditions
ck(checkPreconditions({ project: 'p', hasToken: true, wranglerFound: true }).error === CFG_ERR, 'precond: missing account → cfg error')
ck(checkPreconditions({ accountId: 'a', project: 'p', hasToken: false, wranglerFound: true }).error === CFG_ERR, 'precond: no token → cfg error')
ck(checkPreconditions({ accountId: 'a', project: 'p', hasToken: true, wranglerFound: false }).error === WRANGLER_ERR, 'precond: no wrangler → wrangler error')
ck(checkPreconditions({ accountId: 'a', project: 'p', hasToken: true, wranglerFound: true }).ok === true, 'precond: all present → ok')

// resolveBase
ck(resolveBase({ baseUrl: 'https://h.fyi/', project: 'p' }) === 'https://h.fyi', 'resolveBase strips trailing slash')
ck(resolveBase({ baseUrl: '', project: 'proj' }) === 'https://proj.pages.dev', 'resolveBase falls back to pages.dev')

// publishUrl
ck(publishUrl({ base: 'https://x.pages.dev', slug: 's', id: 'a1', useShortIds: true }) === 'https://x.pages.dev/a1', 'publishUrl short')
ck(publishUrl({ base: 'https://x.pages.dev', slug: 's', useShortIds: false }) === 'https://x.pages.dev/s/', 'publishUrl slug')
ck(publishUrl({ base: 'https://x.pages.dev', slug: 's', useShortIds: true }) === 'https://x.pages.dev/s/', 'publishUrl short-on but no id → slug')

// augmentedPath
ck(augmentedPath('/foo/bin').includes('/opt/homebrew/bin'), 'augmentedPath includes homebrew')
ck(augmentedPath('/foo/bin').endsWith('/foo/bin'), 'augmentedPath appends process PATH')

// readHandoutUrl
ck(readHandoutUrl('---\ntitle: x\nhandout_url: https://h.fyi/ab12\n---\nbody') === 'https://h.fyi/ab12', 'readHandoutUrl from frontmatter')
ck(readHandoutUrl('no frontmatter here') === null, 'readHandoutUrl null when none')

// recoverIdFromUrl
ck(recoverIdFromUrl('https://h.fyi/ab12', 'https://h.fyi') === 'ab12', 'recoverId from short url')
ck(recoverIdFromUrl('https://h.fyi/some-slug/', 'https://h.fyi') === null, 'recoverId null for slug path')
ck(recoverIdFromUrl(null, 'https://h.fyi') === null, 'recoverId null for missing url')

// generateShortId
ck(generateShortId(() => Uint8Array.from([0, 1, 26, 35])) === 'ab09', 'generateShortId maps bytes → [a-z0-9]')

// pickShortId
ck(JSON.stringify(pickShortId({ registry: { x: 'aa11' }, slug: 'x', gen: () => 'zz99' })) === JSON.stringify({ id: 'aa11', registry: { x: 'aa11' } }), 'pickShortId reuses existing')
ck(pickShortId({ registry: { x: 'aa11' }, slug: 'y', gen: () => 'bb22' }).id === 'bb22', 'pickShortId fresh non-colliding')
{
  const seq = ['aa11', 'cc33']; let i = 0
  ck(pickShortId({ registry: { x: 'aa11' }, slug: 'y', gen: () => seq[i++] }).id === 'cc33', 'pickShortId skips collision')
}
ck(pickShortId({ registry: {}, slug: 'z', recoveredId: 'dd44', gen: () => 'zz99' }).id === 'dd44', 'pickShortId adopts recovered id')
ck(pickShortId({ registry: { x: 'dd44' }, slug: 'z', recoveredId: 'dd44', gen: () => 'ee55' }).id === 'ee55', 'pickShortId ignores recovered id that collides')

// buildRedirects
ck(buildRedirects({ a: 'a1', b: 'b2', c: 'c3' }, ['a', 'b']) === '/a1  /a/  302\n/b2  /b/  302\n', 'buildRedirects only existing slugs, sorted by id')
ck(buildRedirects({}, []) === '', 'buildRedirects empty → empty string')

// stampHandoutUrl
ck(stampHandoutUrl('no frontmatter', 'https://x/y') === 'no frontmatter', 'stamp: no frontmatter → unchanged')
ck(stampHandoutUrl('---\ntitle: t\n---\nbody', 'https://x/y') === '---\ntitle: t\nhandout_url: https://x/y\n---\nbody', 'stamp: appends handout_url')
ck(stampHandoutUrl('---\ntitle: t\nhandout_url: old\n---\nbody', 'https://x/y') === '---\ntitle: t\nhandout_url: https://x/y\n---\nbody', 'stamp: replaces handout_url')

if (fail) { console.error(`\n${fail} check(s) failed`); process.exit(1) }
console.log('publishing-logic: all checks passed')
