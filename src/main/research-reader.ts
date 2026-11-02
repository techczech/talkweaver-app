import { researchLinks } from '../shared/research-links.ts'
import { execFile } from 'node:child_process'
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parseDocument } from 'yaml'
import { decideShellPath } from './shell-path-policy.ts'
import { findScout, CAPTURE_KINDS, type CaptureDeps } from './research-capture.ts'
import { pathStaysInside } from './path-containment.ts'
import { pickOutlineEntry } from './talk-scan.mjs'
import { inReservedFolder } from './vault-paths.ts'
import type { ResearchItem, ResearchArtefact, ResearchListResult, ResearchUsedResult, ResearchUse, ResearchFailure } from '../shared/research.ts'

export interface ResearchDeps extends CaptureDeps { vaultRoots?: string[]; signal?: AbortSignal; activeTalkDir?: () => string | null; insertResearch?: (file: string, slide: boolean) => Promise<{ ok: true } | ResearchFailure> }
const TEXT_CAP = 256 * 1024
const ARTEFACT_CAP = 8 * 1024 * 1024
const LIST_CAP = 200
const TOTAL_CAP = 4 * 1024 * 1024
const fail = (message: string, code = 'research-refused'): ResearchFailure => ({ ok: false, error: { code, message } })
const roots = (deps: ResearchDeps): string[] => deps.vaultRoots ?? (deps.vaultRoot ? [deps.vaultRoot] : [])
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const text = (value: unknown): string => typeof value === 'string' ? value : ''
function vaultFor(file: string, deps: ResearchDeps): string | null {
  for (const root of roots(deps)) {
    try {
      const canonicalRoot = realpathSync(root), canonicalFile = realpathSync(file)
      if (pathStaysInside(root, file) !== null || pathStaysInside(canonicalRoot, canonicalFile) !== null) return canonicalRoot
    } catch { /* missing vault or file */ }
  }
  return null
}
function talkFolder(raw: unknown, deps: ResearchDeps): string | null {
  if (typeof raw !== 'string' || !isAbsolute(raw) || raw.includes('\0')) return null
  const root = vaultFor(raw, deps)
  if (!root) return null
  try {
    const talk = realpathSync(raw)
    if (!statSync(talk).isDirectory() || inReservedFolder(realpathSync(root), talk)) return null
    if (!pickOutlineEntry(readdirSync(talk, { withFileTypes: true }), basename(talk))) return null
    return talk
  } catch { return null }
}
/** Refuse symbolic links at every research path segment, then check canonical containment again. */
function researchFile(talk: string, raw: string, cap: number): string | null {
  try {
    const research = join(talk, 'research')
    if (!isAbsolute(raw) || raw.includes('\0')) return null
    let probe = resolve(raw)
    while (true) {
      if (lstatSync(probe).isSymbolicLink()) return null
      if (realpathSync(probe) === research) break
      const parent = dirname(probe)
      if (parent === probe) return null
      probe = parent
    }
    const candidate = realpathSync(raw)
    if (candidate === research || !candidate.startsWith(research + sep)) return null
    let part = research
    if (lstatSync(part).isSymbolicLink() || !statSync(part).isDirectory()) return null
    for (const segment of relative(research, candidate).split(sep)) {
      part = join(part, segment)
      if (lstatSync(part).isSymbolicLink()) return null
    }
    if (pathStaysInside(research, candidate) === null) return null
    const stat = statSync(candidate)
    return stat.isFile() && stat.size <= cap ? realpathSync(candidate) : null
  } catch { return null }
}
function sourceStrings(value: unknown): string[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value)) return null
  const out: string[] = []
  for (const source of value) {
    if (typeof source === 'string') out.push(source)
    else {
      const entries = Object.entries(object(source))
      if (entries.length !== 1 || typeof entries[0][1] !== 'string') return null
      out.push(`${entries[0][0]}:${entries[0][1]}`)
    }
  }
  return out
}
function artefact(talk: string, raw: string, load: boolean): ResearchArtefact | null {
  const path = researchFile(talk, isAbsolute(raw) ? raw : join(talk, raw), ARTEFACT_CAP)
  if (!path) return null
  const ext = extname(path).toLowerCase()
  const mime = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' } as Record<string, string>)[ext]
  const type = mime ? 'image' : ['.html', '.htm'].includes(ext) ? 'html' : 'text'
  return { file: path, name: basename(path), type, ...(load ? { data: mime ? `data:${mime};base64,${readFileSync(path).toString('base64')}` : readFileSync(path, 'utf8') } : {}) }
}
function readItem(talk: string, file: string, load = false): ResearchItem | null {
  const checked = researchFile(talk, file, TEXT_CAP)
  if (!checked || extname(checked).toLowerCase() !== '.md') return null
  try {
    const content = readFileSync(checked, 'utf8')
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)
    if (!match) return null
    const doc = parseDocument(match[1], { uniqueKeys: true })
    if (doc.errors.length) return null
    const front = object(doc.toJS({ maxAliasCount: 20 }))
    if (!text(front.title).trim() || !(CAPTURE_KINDS as readonly string[]).includes(text(front.kind)) || !text(front.created) || !text(front.by).trim() || !Number.isFinite(Date.parse(text(front.created)))) return null
    if (front.artefact !== undefined && typeof front.artefact !== 'string') return null
    if (front.prompt !== undefined && typeof front.prompt !== 'string') return null
    const sources = sourceStrings(front.sources)
    if (!sources) return null
    const body = content.slice(match[0].length)
    const attachments: ResearchArtefact[] = []
    let artefactBytes = 0
    const attach = (raw: string): void => {
      if (attachments.length >= 8) return
      const found = artefact(talk, raw, false)
      if (!found || attachments.some(a => a.file === found.file)) return
      const size = statSync(found.file).size
      if (artefactBytes + size > ARTEFACT_CAP) return
      artefactBytes += size
      attachments.push(load ? artefact(talk, found.file, true)! : found)
    }
    if (typeof front.artefact === 'string') {
      const raw = front.artefact
      attach(raw)
      if (!attachments.length && !isAbsolute(raw)) attach(join(talk, 'research', raw))
    }
    // Captures may link an adjacent artefact in their Markdown instead of naming frontmatter.
    for (const m of body.matchAll(/!?\[[^\]]*\]\(([^\s)]+)\)/g)) {
      let raw: string
      try { raw = decodeURIComponent(m[1]) } catch { continue }
      if (/^[a-z][a-z\d+.-]*:/i.test(raw)) continue
      attach(resolve(dirname(checked), raw))
    }
    for (const m of body.matchAll(/^\[(?:Embed|Simulation):\s*(.+?)\]$/gim)) {
      try { attach(resolve(dirname(checked), decodeURIComponent(m[1]))) } catch { /* malformed path */ }
    }
    return { file: checked, project: talk, projectTitle: basename(talk), title: text(front.title), kind: text(front.kind), created: text(front.created), by: text(front.by), prompt: text(front.prompt), sources, body, preview: body.replace(/\s+/g, ' ').slice(0, 180), artefacts: attachments }
  } catch { return null }
}
export async function listResearch(raw: unknown, deps: ResearchDeps): Promise<ResearchListResult> {
  const input = object(raw), talk = talkFolder(input.talkDir, deps)
  if (!talk) return fail('Open a talk inside an open vault to read its research.')
  if (input.file !== undefined) {
    if (typeof input.file !== 'string') return fail('That research item cannot be read.')
    const item = readItem(talk, input.file, true)
    return item ? { ok: true, items: [{ ...item, inCurrentTalk: true }], skipped: 0, limited: false } : fail('That research item is missing, too large or outside this talk’s research folder.')
  }
  const items: ResearchItem[] = []
  let skipped = 0, total = 0, limited = false
  try {
    const research = join(talk, 'research')
    if (lstatSync(research).isSymbolicLink()) return fail('The research folder must be an ordinary folder inside this talk.')
    for (const entry of readdirSync(research, { withFileTypes: true })) {
      if (entry.name.startsWith('_') || !/\.md$/i.test(entry.name)) continue
      if (items.length >= LIST_CAP || total >= TOTAL_CAP) { limited = true; break }
      const item = readItem(talk, join(research, entry.name))
      if (!item) { skipped++; continue }
      total += Buffer.byteLength(item.body)
      if (total > TOTAL_CAP) { limited = true; break }
      items.push({ ...item, inCurrentTalk: true })
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return fail('The research folder could not be read. Try again.')
  }
  items.sort((a, b) => Date.parse(b.created) - Date.parse(a.created) || a.title.localeCompare(b.title))
  return { ok: true, items, skipped, limited }
}
async function scoutJson(args: string[], deps: ResearchDeps): Promise<{ ok: true; value: Record<string, unknown> } | ResearchFailure> {
  const scout = findScout(deps.env, deps.home, deps.platform)
  if (!scout) return fail('Scout is not installed on this computer. Install Scout, then try again.', 'scout-missing')
  return new Promise(resolveReply => {
    const child = execFile(scout, args, { env: deps.env ?? process.env, timeout: deps.timeoutMs ?? 30_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (stderr) deps.log?.(`[research-reader] ${stderr.slice(-4000)}`)
      if (error && (error.code !== 1 || error.killed || deps.signal?.aborted)) { deps.log?.(`[research-reader] ${error.message}`); resolveReply(fail('Scout could not finish. Try again.', 'scout-failed')); return }
      try { resolveReply({ ok: true, value: object(JSON.parse(stdout)) }) }
      catch { resolveReply(fail('Scout returned an unreadable reply. Try again.', 'scout-failed')) }
    })
    const abort = (): void => { child.kill() }
    if (deps.signal?.aborted) abort()
    else deps.signal?.addEventListener('abort', abort, { once: true })
    child.once('close', () => deps.signal?.removeEventListener('abort', abort))
    child.stdin?.end()
  })
}
function ordinaryVaultFile(raw: string, deps: ResearchDeps): string | null {
  const root = vaultFor(raw, deps)
  if (!root) return null
  try {
    // Unlike researchFile, outline files may be below a symlink that resolves inside the vault.
    const file = pathStaysInside(root, realpathSync(raw))
    return file && statSync(file).isFile() && statSync(file).size <= TEXT_CAP ? file : null
  } catch { return null }
}
let usageRunning = 0
const usageWaiters = new Set<() => void>()
async function usageScout(args: string[], deps: ResearchDeps): ReturnType<typeof scoutJson> {
  while (usageRunning >= 2 && !deps.signal?.aborted) {
    await new Promise<void>(done => {
      const wake = (): void => { usageWaiters.delete(wake); deps.signal?.removeEventListener('abort', wake); done() }
      usageWaiters.add(wake)
      deps.signal?.addEventListener('abort', wake, { once: true })
    })
  }
  if (deps.signal?.aborted) return fail('Usage check cancelled.', 'cancelled')
  usageRunning++
  try { return await scoutJson(args, deps) }
  finally { usageRunning--; for (const wake of [...usageWaiters]) wake() }
}
export async function whereUsedResearch(raw: unknown, deps: ResearchDeps): Promise<ResearchUsedResult> {
  const input = object(raw), talk = talkFolder(input.talkDir, deps)
  if (!talk || typeof input.file !== 'string' || !researchFile(talk, input.file, TEXT_CAP)) return fail('Choose a research item inside an open talk.')
  const reply = await usageScout(['capture', `--where-used=${input.file}`, '--json'], deps)
  if (!reply.ok) return reply
  if (!Array.isArray(reply.value.hits)) return fail('Scout returned an unreadable usage list.', 'scout-failed')
  const uses: ResearchUse[] = []
  let skipped = Number(reply.value.skipped) || 0
  const seen = new Set<string>()
  for (const hit of reply.value.hits) {
    const row = object(hit), file = ordinaryVaultFile(text(row.file), deps), line = Number(row.line)
    if (!file || !Number.isInteger(line) || line < 1) { skipped++; continue }
    const lines = readFileSync(file, 'utf8').split('\n')
    if (dirname(file) !== talk || !basename(file).endsWith('-outline.md')) continue
    const linked = researchLinks(lines[line - 1] ?? '').some(match => {
      try { return realpathSync(resolve(dirname(file), decodeURIComponent(match.path))) === realpathSync(input.file as string) } catch { return false }
    })
    if (!linked) continue
    let slideLine = 1, slideTitle = basename(file), slideNumber = 0, fenced = false
    for (let i = 0; i < Math.min(line, lines.length); i++) {
      if (/^\s*(```|~~~)/.test(lines[i])) fenced = !fenced
      if (!fenced && /^#{2,6}\s+/.test(lines[i])) { slideNumber++; slideLine = i + 1; slideTitle = lines[i].replace(/^#+\s+/, '').replace(/\s*\{.*\}\s*$/, '') }
    }
    const key = `${file}:${slideLine}`
    if (!seen.has(key)) { seen.add(key); uses.push({ file, line, text: text(row.text).slice(0, 300), slideLine, slideTitle, slideNumber }) }
  }
  return { ok: true, uses, skipped }
}
function researchProject(file: string, deps: ResearchDeps): string | null {
  const root = vaultFor(file, deps)
  if (!root) return null
  const parts = relative(root, file).split(sep), index = parts.findIndex(p => p.toLowerCase() === 'research')
  return index > 0 ? talkFolder(join(root, ...parts.slice(0, index)), deps) : null
}
function allResearch(deps: ResearchDeps): ResearchListResult {
  const items: ResearchItem[] = []
  let visited = 0, skipped = 0, total = 0, limited = false
  const walk = (folder: string, depth: number): void => {
    if (depth > 20 || visited >= 50_000 || items.length >= LIST_CAP || total >= TOTAL_CAP) { limited = true; return }
    try {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        if (++visited >= 50_000) { limited = true; return }
        if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.') || ['node_modules', 'dist'].includes(entry.name)) continue
        const path = join(folder, entry.name)
        if (entry.name === 'research') {
          const project = talkFolder(folder, deps)
          if (!project || lstatSync(path).isSymbolicLink()) continue
          for (const stub of readdirSync(path, { withFileTypes: true })) {
            if (stub.name.startsWith('_') || !/\.md$/i.test(stub.name)) continue
            if (items.length >= LIST_CAP || total >= TOTAL_CAP) { limited = true; return }
            const item = readItem(project, join(path, stub.name))
            if (!item) { skipped++; continue }
            total += Buffer.byteLength(item.body)
            if (total > TOTAL_CAP) { limited = true; return }
            items.push(item)
          }
        } else walk(path, depth + 1)
      }
    } catch { skipped++ }
  }
  for (const root of roots(deps)) { try { walk(realpathSync(root), 0) } catch { skipped++ } }
  items.sort((a, b) => Date.parse(b.created) - Date.parse(a.created) || a.title.localeCompare(b.title))
  return { ok: true, items, skipped, limited }
}
export async function searchResearch(raw: unknown, deps: ResearchDeps): Promise<ResearchListResult> {
  const input = object(raw), talk = talkFolder(input.talkDir, deps)
  if (!talk || typeof input.query !== 'string' || input.query.includes('\0') || input.query.length > 2000 || !['talk', 'research', 'everything'].includes(text(input.scope))) return fail('Choose a talk, a search scope and a search of up to 2,000 characters.')
  if (!input.query.trim()) {
    if (input.scope === 'talk') return listResearch({ talkDir: talk }, deps)
    if (input.scope === 'research') { const result = allResearch(deps); return result.ok ? { ...result, items: result.items.map(item => ({ ...item, inCurrentTalk: item.project === talk })) } : result }
    // An empty query asks Scout for the newest documents across its registered corpora.
  }
  const args = ['search', '--json', '--limit=1000', ...(input.query.trim() ? [] : ['--sort=newest']), '--', input.query.trim()]
  const reply = await scoutJson(args, deps)
  if (!reply.ok) return reply
  if (!Array.isArray(reply.value.results)) return fail('Scout returned an unreadable search list.', 'scout-failed')
  const items: ResearchItem[] = [], seen = new Set<string>()
  let skipped = 0, total = 0
  for (const hit of reply.value.results) {
    const row = object(hit), file = text(row.path)
    if (!file || seen.has(file)) continue
    seen.add(file)
    const project = researchProject(file, deps)
    if (input.scope === 'talk' && project !== talk) continue
    if (input.scope === 'research' && !project) continue
    if (project) {
      const item = readItem(project, file)
      if (item) { items.push({ ...item, inCurrentTalk: project === talk }); total += Buffer.byteLength(item.body) } else skipped++
    } else if (input.scope === 'everything') {
      const body = (Array.isArray(row.hits) ? row.hits.map(h => text(object(h).quote)).join('\n\n') : '').slice(0, TEXT_CAP)
      items.push({ file, project: '', projectTitle: text(row.corpus) || 'Archive', title: text(row.title) || basename(file), kind: text(row.kind) || 'search', created: text(row.date), prompt: '', by: 'scout', sources: [text(row.public_url) || text(row.source)].filter(Boolean), body, preview: body.replace(/\s+/g, ' ').slice(0, 180), artefacts: [], archive: true })
      total += Buffer.byteLength(body)
    }
    if (items.length >= LIST_CAP || total >= TOTAL_CAP) break
  }
  return { ok: true, items, skipped, limited: reply.value.results.length >= 1000 || items.length >= LIST_CAP || total >= TOTAL_CAP }
}

/** Reveal is deliberately separate from reading: corpus files can be selected in Finder, but their
 * bytes never cross this reader seam. The existing shell policy still checks canonical containment. */
export async function revealResearchSource(raw: unknown, deps: ResearchDeps & { reveal: (file: string) => void }): Promise<{ ok: true } | ResearchFailure> {
  const input = object(raw)
  if (typeof input.file !== 'string' || !isAbsolute(input.file) || input.file.includes('\0')) return fail('That source cannot be revealed.')
  let allowedRoots = roots(deps)
  if (!vaultFor(input.file, deps)) {
    const reply = await scoutJson(['corpora', 'list', '--json'], deps)
    if (!reply.ok) return reply
    allowedRoots = [...allowedRoots, ...(Array.isArray(reply.value.corpora) ? reply.value.corpora.map(c => text(object(c).root)).filter(isAbsolute) : [])]
  }
  let target
  try { target = decideShellPath('reveal', realpathSync(input.file), allowedRoots.flatMap(root => { try { return [realpathSync(root)] } catch { return [] } })) }
  catch { return fail('This source is missing or cannot be revealed.') }
  if (!target.ok) return fail('This source is not inside an open vault or a registered Scout corpus.')
  try { deps.reveal(target.path); return { ok: true } } catch { return fail('The source could not be revealed. Try again.') }
}
