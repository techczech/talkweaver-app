// Talk-local assets retain their relative layout. A conflicting file moves the entire dependency
// graph under a new folder, so references inside HTML, CSS and SVG need no rewriting on disk.
import { createHash } from 'node:crypto'
import { closeSync, constants, copyFileSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { widgetDependencyPath, widgetDependencyRefs, WIDGET_DEPENDENCY_TYPES, WIDGET_MAX_BYTES, WIDGET_MAX_FILES } from '../../compiler/scripts/lib/widget-dependencies.mjs'
import { slideFiles } from '../shared/slide-handling/query.ts'
import { pathStaysInside } from './path-containment.ts'

export function slideLocalPath(ref: string): string | null {
  if (/^(?:[a-z][a-z0-9+.-]*:|[\\/#])/i.test(ref)) return null
  let path = ref.split(/[?#]/)[0]
  try { path = decodeURIComponent(path) } catch { return null }
  if (!path || isAbsolute(path) || /[\\:\0]/.test(path) ||
      path.split('/').some((part) => part.startsWith('.') && part !== '.')) return null
  return path
}

type LocalFile = { path: string; size: number; digest?: string }

function localGraph(source: string, entry: string): Map<string, LocalFile> {
  const files = new Map<string, LocalFile>()
  const seen = new Set<string>()
  let remainingText = WIDGET_MAX_BYTES
  function visit(path: string): void {
    if (seen.has(path)) return
    if (seen.size >= WIDGET_MAX_FILES) throw new Error('The widget refers to too many files.')
    seen.add(path)
    const allowed = pathStaysInside(source, path)
    if (!allowed) return
    let size: number
    try {
      const stat = statSync(allowed)
      if (!stat.isFile()) return
      size = stat.size
    } catch { return }
    const ext = extname(path).toLowerCase()
    if (['.html', '.htm', '.css', '.svg'].includes(ext)) {
      if (size > remainingText) throw new Error('The widget dependencies are too large to read.')
      remainingText -= size
      for (const { raw } of widgetDependencyRefs(readFileSync(allowed, 'utf8'), ext)) {
        const dependency = widgetDependencyPath(path, raw)
        if (dependency) visit(dependency.path)
      }
    }
    if (/^\.(mp4|webm|mov|m4v)$/.test(ext)) {
      for (const poster of ['.png', '.jpg', '.jpeg', '.webp']) {
        visit(path.slice(0, -ext.length) + poster)
      }
    }
    // Publish the widget entry after its dependencies.
    files.set(relative(source, path), { path: allowed, size })
  }
  visit(join(source, entry))
  return files
}

function fileDigest(path: string): string {
  const hash = createHash('sha256')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const chunk = Buffer.alloc(64 * 1024)
    for (let count = readSync(fd, chunk); count > 0; count = readSync(fd, chunk)) {
      hash.update(chunk.subarray(0, count))
    }
    return hash.digest('hex')
  } finally { closeSync(fd) }
}

function graphDigest(files: ReadonlyMap<string, LocalFile>): string {
  const hash = createHash('sha256')
  for (const name of [...files.keys()].sort()) {
    const file = files.get(name)!
    hash.update(JSON.stringify([name, file.digest ??= fileDigest(file.path)]))
  }
  return hash.digest('hex')
}

/** The entry and each contained dependency must match before one source can stand for another. */
export function slideLocalFileDigest(talkDir: string, ref: string): string | null {
  const entry = slideLocalPath(ref)
  if (!entry) return null
  try {
    const files = localGraph(realpathSync(talkDir), entry)
    return files.size ? graphDigest(files) : null
  } catch { return null }
}

export function hasSlideLocalFile(talkDir: string, ref: string): boolean {
  const path = slideLocalPath(ref)
  const allowed = path && pathStaysInside(talkDir, resolve(talkDir, path))
  try { return Boolean(allowed && statSync(allowed).isFile()) } catch { return false }
}

function targetFile(root: string, path: string): string | null {
  const candidate = join(root, path)
  // Do not write through a link, even one to another place inside the talk.
  return pathStaysInside(root, candidate) === candidate ? candidate : null
}

function slotState(target: string, path: string, file: LocalFile): 'same' | 'empty' | 'clash' {
  const dest = targetFile(target, path)
  if (!dest) return 'clash'
  try {
    const stat = lstatSync(dest)
    if (!stat.isFile() || stat.size !== file.size) return 'clash'
    return fileDigest(dest) === (file.digest ??= fileDigest(file.path)) ? 'same' : 'clash'
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'empty' : 'clash'
  }
}

export function copySlideLocalFile(source: string, target: string, ref: string, repair = false): string | null {
  const entry = slideLocalPath(ref)
  if (!entry) return null
  source = realpathSync(source)
  target = realpathSync(target)
  if (source === target) return hasSlideLocalFile(source, ref) ? ref : null
  const extension = extname(entry).toLowerCase()
  if (!WIDGET_DEPENDENCY_TYPES.has(extension) && extension !== '.pdf' && extension !== '.flac' && extension !== '.aac' && extension !== '.opus' && extension !== '.mov' && extension !== '.m4v') return null
  const files = localGraph(source, entry)
  if (!files.size) return null
  const fits = (base: string): boolean => [...files].every(([name, file]) => slotState(target, join(base, name), file) !== 'clash')
  let base = ''
  if (!fits(base)) {
    if (repair) throw new Error('A different file already occupies a widget path in this talk.')
    const prefix = join('widgets', `reused-${graphDigest(files).slice(0, 12)}`)
    base = prefix
    for (let attempt = 2; !fits(base); attempt++) {
      if (attempt > WIDGET_MAX_FILES) throw new Error('No free folder for this widget.')
      base = `${prefix}-${attempt}`
    }
  }
  writeLocalGraph(source, target, files, base)
  if (!base) return ref
  const suffix = /[?#].*$/.exec(ref)?.[0] ?? ''
  return join(base, entry).split(sep).map(encodeURIComponent).join('/') + suffix
}

function writeLocalGraph(source: string, target: string, files: ReadonlyMap<string, LocalFile>, base: string): void {
  for (const [name, file] of files) {
    const path = join(base, name)
    const dest = targetFile(target, path)
    if (!dest) throw new Error('The widget destination changed.')
    if (slotState(target, path, file) === 'same') continue
    mkdirSync(dirname(dest), { recursive: true })
    if (targetFile(target, path) !== dest) throw new Error('The widget destination changed.')
    if (pathStaysInside(source, file.path) !== file.path) throw new Error('The widget source changed.')
    copyFileSync(file.path, dest, constants.COPYFILE_EXCL)
  }
}

/** The Scratchpad's checked HTML/SVG importer has placed the entry file. Copy the files it uses beside it. */
export function copySlideWidgetDependencies(sourcePath: string, targetOutline: string, targetRef: string): number {
  const source = dirname(realpathSync(sourcePath))
  const target = dirname(realpathSync(targetOutline))
  const entry = slideLocalPath(targetRef)
  const targetPath = entry && targetFile(target, entry)
  if (!targetPath) throw new Error('The widget destination changed.')
  const files = localGraph(source, basename(sourcePath))
  files.delete(basename(sourcePath))
  const base = relative(target, dirname(targetPath))
  if ([...files].some(([name, file]) => slotState(target, join(base, name), file) === 'clash')) {
    throw new Error('A different file already occupies a widget resource path.')
  }
  writeLocalGraph(source, target, files, base)
  return files.size
}

export function copySlideLocalFiles(source: string, target: string, markdown: string, travelled?: Set<string>): string {
  const copiedRefs = new Map<string, string | null>()
  const edits: Array<{ start: number; ref: string; copied: string }> = []
  for (const { ref, start } of slideFiles(markdown)) {
    if (!ref || start === undefined) continue
    if (!copiedRefs.has(ref)) copiedRefs.set(ref, copySlideLocalFile(source, target, ref))
    const copied = copiedRefs.get(ref)
    if (copied) travelled?.add(copied)
    if (copied && copied !== ref) edits.push({ start, ref, copied })
  }
  for (const { start, ref, copied } of edits.sort((a, b) => b.start - a.start)) {
    markdown = markdown.slice(0, start) + copied + markdown.slice(start + ref.length)
  }
  return markdown
}
