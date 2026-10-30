import { parseMarkdownFenceOpeningLine, isMarkdownFenceClosingLine } from '../../compiler/scripts/lib/03-object-token.mjs'
import { constants, copyFileSync, lstatSync, mkdirSync, openSync, closeSync, writeFileSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, fstatSync, rmSync, rmdirSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { parseDocument } from 'yaml'
import { CAPTURE_KINDS, captureResearch } from './research-capture.ts'
import { listResearch, type ResearchDeps } from './research-reader.ts'
import { readTalkOutline, writeTalkOutline } from './talk-writer.ts'
import { researchPaths, replaceResearchLinks } from '../shared/research-links.ts'
import type { ResearchWriteInput, ResearchWriteResult, ResearchUse, ResearchItem } from '../shared/research.ts'

export interface ResearchWriteDeps extends ResearchDeps {
  trash?: (file: string) => Promise<void>
}
const refuse = (message: string): ResearchWriteResult => ({ ok: false, error: { code: 'research-refused', message } })
const validText = (v: unknown, cap = 4096): v is string => typeof v === 'string' && !!v && !v.includes('\0') && v.length <= cap
const roots = (d: ResearchDeps): string[] => d.vaultRoots ?? (d.vaultRoot ? [d.vaultRoot] : [])
/** Canonical vault roots may be aliases; every segment below the root must be ordinary. */
function contained(path: string, deps: ResearchDeps, newTarget = false): string {
  if (!validText(path) || !isAbsolute(path) || path !== resolve(path)) throw Error('Choose an ordinary path inside an open vault.')
  for (const rawRoot of roots(deps)) {
    const root = realpathSync(rawRoot)
    const rel = relative(root, path)
    if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) continue
    let probe = root
    for (const part of rel.split(sep)) {
      probe = join(probe, part)
      try {
        if (lstatSync(probe).isSymbolicLink()) throw Error('Symbolic links are not allowed in research write paths.')
      } catch (error) {
        if (newTarget && probe === path && (error as NodeJS.ErrnoException).code === 'ENOENT') return root
        throw error
      }
    }
    if (realpathSync(path) !== path) throw Error('The research path changed. Try again.')
    return root
  }
  throw Error('Choose a path inside an open vault.')
}
function canonicalPath(path: string, deps: ResearchDeps): string {
  if (!validText(path) || !isAbsolute(path) || path !== resolve(path)) throw Error('Choose an ordinary path inside an open vault.')
  for (const rawRoot of roots(deps)) {
    const root = realpathSync(rawRoot)
    for (const prefix of [resolve(rawRoot), root]) {
      const rel = relative(prefix, path)
      if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) continue
      const candidate = join(root, rel)
      contained(candidate, deps)
      if (realpathSync(path) !== candidate) throw Error('The research path changed. Try again.')
      return candidate
    }
  }
  throw Error('Choose a path inside an open vault.')
}
function talkFolder(path: string, deps: ResearchDeps): string {
  const root = contained(path, deps)
  if (basename(path).toLowerCase() === 'research' || !statSync(path).isDirectory() || relative(root, path).split(sep).some(p => p.toLowerCase() === 'research')) throw Error('Choose a talk folder, not a research folder.')
  if (!readdirSync(path, { withFileTypes: true }).some(e => e.isFile() && e.name.endsWith('-outline.md'))) throw Error('The destination must hold a talk outline.')
  return root
}
function researchFolder(talk: string, deps: ResearchDeps, create = false): string {
  talkFolder(talk, deps)
  const dir = join(talk, 'research')
  if (create && !readdirSync(talk).includes('research')) { contained(dir, deps, true); mkdirSync(dir) }
  contained(dir, deps)
  if (!statSync(dir).isDirectory()) throw Error('Research must be an ordinary folder.')
  // Scout writes its manifest and lock here, too. Refuse links before handing it the folder.
  for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isSymbolicLink() || e.isFile() && lstatSync(join(dir, e.name)).nlink !== 1) throw Error('Research contains a symbolic link or hard link. Nothing was changed.')
  return dir
}
function safeFile(file: string, talk: string, deps: ResearchDeps, cap: number): void {
  contained(file, deps)
  const dir = researchFolder(talk, deps)
  if (!file.startsWith(dir + sep) || !statSync(file).isFile() || statSync(file).size > cap || statSync(file).nlink !== 1) throw Error('The research file is outside this talk, linked or too large.')
}
function slug(title: string): string {
  let out = title.normalize('NFD').replace(/\p{M}/gu, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase()
  if (out.length > 60) out = out[60] === '-' ? out.slice(0, 60) : out.slice(0, out.slice(0, 60).lastIndexOf('-') > -1 ? out.slice(0, 60).lastIndexOf('-') : 60)
  return out || 'capture'
}
function freeFile(dir: string, name: string): string {
  const names = new Set(readdirSync(dir).map(n => n.toLowerCase()))
  if (names.has(name.toLowerCase())) throw Error('A file with that name already exists. Choose another title or keep the file name.')
  return join(dir, name)
}
function writeExisting(file: string, before: string, after: string, deps: ResearchWriteDeps): void {
  contained(file, deps)
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  const temp = join(dirname(file), `.research-${randomUUID()}.tmp`)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1 || readFileSync(fd, 'utf8') !== before) throw Error('The research item changed. Try again.')
    contained(temp, deps, true)
    writeFileSync(temp, after, { flag: 'wx', mode: stat.mode })
    contained(file, deps)
    const current = lstatSync(file)
    if (current.ino !== stat.ino || current.dev !== stat.dev || current.nlink !== 1 || readFileSync(file, 'utf8') !== before) throw Error('The research item changed. Try again.')
    renameSync(temp, file)
  } finally { closeSync(fd); rmSync(temp, { force: true }) }
}
function matchesLink(outline: string, target: string, path: string): boolean {
  try { return resolve(dirname(outline), decodeURIComponent(path.split(/[?#]/, 1)[0])) === target } catch { return false }
}
async function outlinesAndUses(talk: string, file: string, deps: ResearchWriteDeps, artefacts: string[] = []): Promise<{ snapshots: Map<string, string>; uses: ResearchUse[]; uncheckedOutlines: string[] }> {
  const snapshots = new Map<string, string>(), uses: ResearchUse[] = [], uncheckedOutlines: string[] = []
  for (const e of readdirSync(talk, { withFileTypes: true })) {
    if (!e.name.endsWith('-outline.md')) continue
    const outline = join(talk, e.name)
    let text: string
    try {
      contained(outline, deps)
      if (!e.isFile() || statSync(outline).nlink !== 1) throw Error('Outline links cannot be updated safely.')
      text = await readTalkOutline(outline)
      if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw Error('The outline is too large to update safely.')
    } catch { uncheckedOutlines.push(outline); continue }
    snapshots.set(outline, text)
    let slideTitle = basename(outline), slideLine = 1, slideNumber = 0
    let fence: ReturnType<typeof parseMarkdownFenceOpeningLine> = null
    for (const [index, line] of text.split('\n').entries()) {
      if (fence) { if (isMarkdownFenceClosingLine(line, fence)) fence = null; continue }
      const opening = parseMarkdownFenceOpeningLine(line)
      if (opening) { fence = opening; continue }
      if (/^#{2,6}\s/.test(line)) { slideLine = index + 1; slideTitle = line.replace(/^#+\s+/, ''); slideNumber++ }
      if (researchPaths(line).some(path => [file, ...artefacts].some(target => matchesLink(outline, target, path))) && !uses.some(u => u.file === outline && u.slideLine === slideLine)) uses.push({ file: outline, line: index + 1, text: line, slideLine, slideTitle, slideNumber })
    }
  }
  return { snapshots, uses, uncheckedOutlines }
}
function rewriteStub(content: string, key: string, value: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)
  if (!match) throw Error('This item has no capture metadata.')
  const doc = parseDocument(match[1]); if (doc.errors.length) throw Error('The capture metadata cannot be edited.')
  doc.set(key, value)
  return `---\n${doc.toString()}---\n${content.slice(match[0].length)}`
}
/** A visible group preserves all-or-restore Trash behaviour without hiding deleted items. */
async function trashGroup(files: string[], talk: string, deps: ResearchWriteDeps): Promise<void> {
  if (!deps.trash) throw Error('Trash is unavailable. Nothing was removed.')
  for (const file of files) safeFile(file, talk, deps, 8 * 1024 * 1024)
  const stage = join(researchFolder(talk, deps), 'Deleted research – ' + randomUUID())
  contained(stage, deps, true)
  mkdirSync(stage)
  const moved: [string, string][] = []
  try {
    for (const [i, file] of files.entries()) {
      const target = join(stage, `${i}-${basename(file)}`)
      contained(target, deps, true)
      renameSync(file, target); moved.push([file, target])
    }
    await deps.trash(stage)
  } catch (error) {
    const restoreErrors: string[] = [], restoredNames: string[] = []
    for (const [file, target] of moved.reverse()) {
      try {
        let restored: string
        try { restored = freeFile(dirname(file), basename(file)) }
        catch { restored = freeFile(dirname(file), `restored-${randomUUID()}-${basename(file)}`) }
        contained(restored, deps, true)
        renameSync(target, restored)
        if (restored !== file) restoredNames.push(`${basename(file)}: ${basename(restored)}`)
      } catch (restoreError) { restoreErrors.push(String(restoreError)) }
    }
    // Only remove an empty stage: never discard the last copy on an I/O failure.
    try { rmdirSync(stage) } catch (cleanupError) { restoreErrors.push(String(cleanupError)) }
    if (restoreErrors.length) deps.log?.(`Research restore: ${restoreErrors.join('; ')}`)
    if (restoredNames.length) throw Error(`${error instanceof Error ? error.message : String(error)}. Restored under new names: ${restoredNames.join('; ')}. Update any outline links to these files.`)
    throw error
  }
}
async function copyItem(item: ResearchItem, destination: string, deps: ResearchWriteDeps): Promise<{ file: string; replacements: Map<string, string> }> {
  const root = talkFolder(destination, deps), dir = researchFolder(destination, deps, true)
  safeFile(item.file, item.project, deps, 256 * 1024)
  let total = 0
  for (const a of item.artefacts) { safeFile(a.file, item.project, deps, 8 * 1024 * 1024); total += statSync(a.file).size }
  if (total > 8 * 1024 * 1024 || item.artefacts.length > 8) throw Error('The attachments exceed the research size limit.')
  let body = item.body, file: string
  const replacements = new Map<string, string>()
  try {
    // Distinct artefact names avoid overwrites and preserve multiple attachments despite Scout's one-attachment CLI.
    for (const a of item.artefacts) {
      safeFile(a.file, item.project, deps, 8 * 1024 * 1024)
      const target = freeFile(dir, `copy-${randomUUID()}-${basename(a.file)}`)
      contained(target, deps, true)
      copyFileSync(a.file, target, constants.COPYFILE_EXCL)
      replacements.set(a.file, target)
      body = replaceResearchLinks(body, path => {
        let decoded: string; try { decoded = decodeURIComponent(path) } catch { return path }
        const resolved = resolve(dirname(item.file), decoded)
        return resolved === a.file ? encodeURIComponent(basename(target)) : path
      })
      if (!body.includes(encodeURIComponent(basename(target)))) body += `\n\n${a.type === 'image' ? `![${item.title.replace(/[\[\]]/g, '')}](${encodeURIComponent(basename(target))})` : a.type === 'html' ? `[Embed: ${encodeURIComponent(basename(target))}]` : `[${a.name}](${encodeURIComponent(basename(target))})`}`
    }
    researchFolder(destination, deps)
    const result = await captureResearch({ talkDir: destination, title: item.title, kind: item.kind, prompt: item.prompt, sources: [...item.sources, `file:${item.file}`], body: `---\nby: app:talkweaver\n---\n${body}` }, { ...deps, vaultRoot: root,
      // Capture's normal registered-corpus refresh writes a global index. This parcel confines
      // every write to the destination talk, so use an absent registry and local data path.
      env: { ...(deps.env ?? process.env), SCOUT_CONFIG: join(dir, `.capture-${randomUUID()}.toml`), SCOUT_DATA_DIR: dir } })
    if (!result.ok) throw Error(result.error.message)
    file = isAbsolute(result.file) ? result.file : join(dir, result.file)
  } catch (error) {
    for (const target of replacements.values()) rmSync(target, { force: true })
    throw error
  }
  // Capture has committed a stub. A later refusal must keep its attachments with it.
  safeFile(file, destination, deps, 256 * 1024)
  replacements.set(item.file, file)
  return { file, replacements }
}

/** All writes pass here, through the same validation, preview and live outline writer. */
async function performWrite(raw: unknown, deps: ResearchWriteDeps): Promise<ResearchWriteResult> {
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return refuse('The research request was not understood.')
    let input = raw as ResearchWriteInput
    if (!['rename', 'kind', 'delete', 'move', 'copy', 'insertHere'].includes(input.op) || !validText(input.file)) return refuse('Choose a research item and action.')
    for (const [key, cap] of [['title', 500], ['kind', 40], ['destination', 4096], ['confirmation', 128]] as const) if (input[key] !== undefined && !validText(input[key], cap)) return refuse('The research request contains invalid text.')
    for (const key of ['preview', 'renameSlug'] as const) if (input[key] !== undefined && typeof input[key] !== 'boolean') return refuse('The research options must be true or false.')
    const activePath = deps.activeTalkDir?.()
    if (!activePath) return refuse('Open a talk first.')
    const active = canonicalPath(activePath, deps)
    input = { ...input, file: canonicalPath(input.file, deps), ...(input.destination ? { destination: canonicalPath(input.destination, deps) } : {}) }
    talkFolder(active, deps)
    const sourceTalk = dirname(dirname(input.file))
    talkFolder(sourceTalk, deps)
    safeFile(input.file, sourceTalk, deps, 256 * 1024)
    if (input.op !== 'insertHere' && sourceTalk !== active) return refuse('Tidy actions only change research in the active talk.')
    if (input.op === 'rename' && (!input.title?.trim() || input.title.length > 500)) return refuse('Give the item a title of up to 500 characters.')
    if (input.op === 'kind' && !(CAPTURE_KINDS as readonly string[]).includes(input.kind ?? '')) return refuse('Choose a research kind.')
    const result = await listResearch({ talkDir: sourceTalk, file: input.file }, deps)
    if (!result.ok || !result.items[0]) return refuse('This research item cannot be edited.')
    const item = result.items[0], before = readFileSync(item.file, 'utf8')
    const artefacts = input.op === 'delete' || input.op === 'move' ? item.artefacts.map(a => a.file) : []
    const { snapshots, uses, uncheckedOutlines } = await outlinesAndUses(sourceTalk, item.file, deps, artefacts)
    // Destructive path changes check other open talks too. Every outline is read through the live buffer route.
    if (input.op === 'delete' || input.op === 'move' || input.op === 'rename' && input.renameSlug) {
      for (const target of researchDestinations(deps, true)) {
        if (target.path === sourceTalk) continue
        const external = await outlinesAndUses(target.path, item.file, deps, artefacts)
        uses.push(...external.uses)
        uncheckedOutlines.push(...external.uncheckedOutlines)
      }
    }
    const confirmation = createHash('sha256').update(JSON.stringify({ op: input.op, file: item.file, before, title: input.title, kind: input.kind, renameSlug: input.renameSlug, destination: input.destination, uses, uncheckedOutlines, snapshots: [...snapshots] })).digest('hex')
    if (input.preview) return { ok: true, file: item.file, uses, uncheckedOutlines, confirmation }
    if ((input.op === 'rename' || (input.op === 'delete' || input.op === 'move') && (uses.length || uncheckedOutlines.length)) && input.confirmation !== confirmation) return refuse('Review the slides that use this item, then confirm. Nothing was changed.')
    if (deps.activeTalkDir?.() !== activePath) return refuse('The active talk changed. Try again.')
    safeFile(item.file, sourceTalk, deps, 256 * 1024)
    if (readFileSync(item.file, 'utf8') !== before) return refuse('The item changed after the preview. Try again.')
    if (input.op === 'kind') { safeFile(item.file, sourceTalk, deps, 256 * 1024); writeExisting(item.file, before, rewriteStub(before, 'kind', input.kind!), deps); return { ok: true, file: item.file } }
    if (input.op === 'rename') {
      const next = rewriteStub(before, 'title', input.title!.trim())
      if (!input.renameSlug) { writeExisting(item.file, before, next, deps); return { ok: true, file: item.file } }
      const date = new Date(Date.parse(item.created)).toISOString().slice(0, 10)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw Error('The research date cannot be used in a file name.')
      const name = `${date}-${slug(input.title!.trim())}.md`
      if (basename(item.file) === name) { writeExisting(item.file, before, next, deps); return { ok: true, file: item.file } }
      const target = freeFile(dirname(item.file), name)
      if (dirname(target) !== dirname(item.file)) throw Error('The renamed item must stay in its research folder.')
      contained(target, deps, true)
      writeFileSync(target, next, { flag: 'wx' })
      for (const [outline, expected] of snapshots) {
        const changed = replaceResearchLinks(expected, path => matchesLink(outline, item.file, path) ? `research/${encodeURIComponent(name)}` : path)
        if (changed === expected) continue
        contained(outline, deps)
        const saved = await writeTalkOutline(outline, current => { if (current !== expected) throw Error('The outline changed after the preview. Try again.'); return changed }, 'research-rename')
        if (!saved.ok) throw Error(saved.error || 'The outline could not be updated. Both research files were kept.')
      }
      await trashGroup([item.file], sourceTalk, deps)
      return { ok: true, file: target }
    }
    const files = [item.file, ...item.artefacts.map(a => a.file)]
    if (input.op === 'delete' || input.op === 'move') {
      // A shared attachment belongs to both stubs. Keep it when another item references it.
      const siblings = await listResearch({ talkDir: sourceTalk }, deps)
      if (!siblings.ok || siblings.skipped || siblings.limited) throw Error('All research items must be readable before removing artefacts.')
      for (let i = files.length - 1; i > 0; i--) if (siblings.items.some(s => s.file !== item.file && (s.file === files[i] || s.artefacts.some(a => a.file === files[i])))) files.splice(i, 1)
    }
    if (input.op === 'delete') {
      safeFile(item.file, sourceTalk, deps, 256 * 1024)
      if (readFileSync(item.file, 'utf8') !== before) throw Error('The item changed. Nothing was removed.')
      await trashGroup(files, sourceTalk, deps); return { ok: true, file: item.file } }
    const destination = input.op === 'insertHere' ? active : input.destination
    if (!destination || destination === sourceTalk) return refuse('Choose another talk.')
    const { file: copied, replacements } = await copyItem(item, destination, deps)
    if (input.op === 'move') {
      if (deps.activeTalkDir?.() !== activePath) throw Error('The active talk changed. The original and copy were kept.')
      const current = await outlinesAndUses(sourceTalk, item.file, deps)
      if (JSON.stringify([...current.snapshots]) !== JSON.stringify([...snapshots])) throw Error('The outline changed. The original and copy were kept.')
      safeFile(item.file, sourceTalk, deps, 256 * 1024)
      if (readFileSync(item.file, 'utf8') !== before) throw Error('The item changed. The original and copy were kept.')
      const movedItem = await listResearch({ talkDir: destination, file: copied }, deps)
      if (!movedItem.ok || !movedItem.items[0]) throw Error('The copied research could not be checked. Both copies were kept.')
      for (const [outline, expected] of snapshots) {
        const changed = replaceResearchLinks(expected, path => {
          for (const [original, target] of replacements) if (matchesLink(outline, original, path)) return relative(dirname(outline), target).split(sep).map(encodeURIComponent).join('/')
          return path
        })
        if (changed === expected) continue
        contained(outline, deps)
        const saved = await writeTalkOutline(outline, current => { if (current !== expected) throw Error('The outline changed after the preview. Try again.'); return changed }, 'research-rename')
        if (!saved.ok) throw Error(saved.error || 'The outline could not be updated. Both research files were kept.')
      }
      await trashGroup(files, sourceTalk, deps)
    }
    if (input.op === 'insertHere') {
      if (deps.activeTalkDir?.() !== activePath || !deps.insertResearch) throw Error('The copy was kept. Open the destination talk to insert it.')
      const inserted = await deps.insertResearch(copied, false)
      if (!inserted.ok) return inserted
    }
    return { ok: true, file: copied }
  } catch (error) { return refuse(error instanceof Error ? error.message : 'The research action could not finish. The original was kept where possible.') }
}

export function researchDestinations(deps: ResearchDeps, complete = false): { path: string; title: string }[] {
  const found: { path: string; title: string }[] = []
  let visited = 0
  const walk = (dir: string, depth: number): void => {
    if (depth > 20 || ++visited > 50_000 || found.length >= 2000) { if (complete) throw Error('The vault is too large to check every use safely. Nothing was removed.'); return }
    try {
      const entries = readdirSync(dir, { withFileTypes: true })
      if (entries.some(e => e.isFile() && e.name.endsWith('-outline.md'))) { talkFolder(dir, deps); found.push({ path: dir, title: basename(dir) }) }
      for (const e of entries) if (e.isDirectory() && !e.isSymbolicLink() && !e.name.startsWith('.') && !['research', 'node_modules', 'dist'].includes(e.name.toLowerCase())) walk(join(dir, e.name), depth + 1)
    } catch (e) { if (complete) throw e }
  }
  for (const root of roots(deps)) walk(realpathSync(root), 0)
  return found
}

let writeQueue: Promise<unknown> = Promise.resolve()
export function writeResearch(raw: unknown, deps: ResearchWriteDeps): Promise<ResearchWriteResult> {
  const next = writeQueue.then(() => performWrite(raw, deps))
  writeQueue = next.catch(() => {})
  return next
}
