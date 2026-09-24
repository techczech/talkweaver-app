import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, posix, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { DOMParser } from '@xmldom/xmldom'
import type {
  ImportPictureShape,
  ImportRendererRecord,
  ImportShapeGeometry,
  ImportSmartArtNode,
  ImportSmartArtShape,
  ImportSlideSource,
  ImportSourceInfo,
  ImportTextShape,
  ImportUnsupportedShape,
  ImportVideoShape
} from '../../shared/importer.ts'
import { writeTextAtomic } from './atomic.ts'

const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

type XmlNode = Node & { localName?: string | null }
type Relationship = { id: string; type: string; target: string; external: boolean }

export interface ExtractedPptx {
  source: ImportSourceInfo
  packageDir: string
  slides: ImportSlideSource[]
}

export interface RenderedSlides {
  renderer: ImportRendererRecord
  files: string[]
}

export interface ProcessResult {
  code: number
  stdout: string
  stderr: string
}

export type ProcessRunner = (command: string, args: string[], cwd?: string) => Promise<ProcessResult>

export interface RendererPaths {
  officePath: string | null
  rasterPath: string | null
}

export function safeArchiveEntry(entry: string): string {
  if (!entry || entry.includes('\0') || entry.startsWith('/') || /^[A-Za-z]:[\\/]/.test(entry)) {
    throw new Error(`unsafe-pptx-entry:${entry}`)
  }
  const normalised = posix.normalize(entry.replaceAll('\\', '/'))
  if (normalised === '..' || normalised.startsWith('../') || normalised.includes('/../')) {
    throw new Error(`unsafe-pptx-entry:${entry}`)
  }
  return normalised.replace(/^\.\//, '')
}

export const runProcess: ProcessRunner = (command, args, cwd) => new Promise((resolveResult, reject) => {
  const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  child.on('error', reject)
  child.on('close', (code) => resolveResult({ code: code ?? -1, stdout, stderr }))
})

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolveHash, reject) => {
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', resolveHash)
  })
  return hash.digest('hex')
}

function localName(node: XmlNode): string {
  return node.localName || node.nodeName.split(':').pop() || ''
}

function allElements(root: Node, name: string): Element[] {
  const nodes = (root as Document | Element).getElementsByTagName('*')
  return Array.from(nodes).filter((node) => localName(node) === name)
}

function firstElement(root: Node, name: string): Element | null {
  return allElements(root, name)[0] ?? null
}

function directElementChildren(root: Node): Element[] {
  return Array.from(root.childNodes).filter((node): node is Element => node.nodeType === 1)
}

function attribute(element: Element | null, name: string, namespace?: string): string {
  if (!element) return ''
  return (namespace ? element.getAttributeNS(namespace, name) : null)
    || element.getAttribute(name)
    || element.getAttribute(`r:${name}`)
    || ''
}

function readXml(filePath: string): Document {
  const xml = readFileSync(filePath, 'utf8')
  const errors: string[] = []
  const doc = new DOMParser({ errorHandler: { warning: () => {}, error: (message) => errors.push(message), fatalError: (message) => errors.push(message) } }).parseFromString(xml, 'application/xml')
  if (errors.length || allElements(doc, 'parsererror').length) {
    throw new Error(`pptx-xml-invalid:${filePath}:${errors[0] ?? 'parse error'}`)
  }
  return doc
}

function relationshipMap(filePath: string): Map<string, Relationship> {
  if (!existsSync(filePath)) return new Map()
  const map = new Map<string, Relationship>()
  for (const rel of allElements(readXml(filePath), 'Relationship')) {
    const id = attribute(rel, 'Id')
    if (!id) continue
    map.set(id, {
      id,
      type: attribute(rel, 'Type'),
      target: attribute(rel, 'Target'),
      external: attribute(rel, 'TargetMode').toLowerCase() === 'external'
    })
  }
  return map
}

function resolvePartTarget(basePart: string, target: string): string {
  return safeArchiveEntry(posix.normalize(posix.join(posix.dirname(basePart), target)))
}

function packagePath(packageDir: string, part: string): string {
  const safe = safeArchiveEntry(part)
  const target = resolve(packageDir, safe)
  const root = resolve(packageDir)
  if (target !== root && !target.startsWith(`${root}/`)) throw new Error(`unsafe-pptx-entry:${part}`)
  return target
}

function paragraphText(paragraph: Element): string {
  const pieces: string[] = []
  for (const child of allElements(paragraph, 't')) pieces.push(child.textContent ?? '')
  return pieces.join('').replaceAll('\r', '').trim()
}

function escapeMarkdownText(value: string): string {
  return value.replace(/([\\`*_{}<>#+|])/g, '\\$1')
}

function paragraphMarkdown(paragraph: Element): string {
  const pieces: string[] = []
  for (const child of directElementChildren(paragraph)) {
    const name = localName(child)
    if (name === 'br') {
      pieces.push('  \n')
      continue
    }
    if (name !== 'r' && name !== 'fld') continue
    const text = allElements(child, 't').map((node) => node.textContent ?? '').join('')
    if (!text) continue
    const properties = firstElement(child, 'rPr')
    const match = text.match(/^(\s*)(.*?)(\s*)$/s)
    const leading = match?.[1] ?? ''
    const trailing = match?.[3] ?? ''
    let formatted = escapeMarkdownText(match?.[2] ?? text)
    if (formatted && attribute(properties, 'b') === '1') formatted = `**${formatted}**`
    if (formatted && attribute(properties, 'i') === '1') formatted = `_${formatted}_`
    pieces.push(`${leading}${formatted}${trailing}`)
  }
  return pieces.join('').replaceAll('\r', '').trim()
}

function paragraphsOf(root: Element): string[] {
  return allElements(root, 'p').map(paragraphText).filter(Boolean)
}

function markdownParagraphsOf(root: Element): string[] {
  return allElements(root, 'p').map(paragraphMarkdown).filter(Boolean)
}

function shapeGeometry(root: Element): ImportShapeGeometry | null {
  const transform = firstElement(root, 'xfrm')
  const offset = transform ? firstElement(transform, 'off') : null
  const extent = transform ? firstElement(transform, 'ext') : null
  if (!offset || !extent) return null
  const x = Number(attribute(offset, 'x'))
  const y = Number(attribute(offset, 'y'))
  const width = Number(attribute(extent, 'cx'))
  const height = Number(attribute(extent, 'cy'))
  return [x, y, width, height].every(Number.isFinite) ? { x, y, width, height } : null
}

function shapeIdentity(root: Element): { id: string; name: string; placeholder: string | null } {
  const cNvPr = firstElement(root, 'cNvPr')
  const placeholder = firstElement(root, 'ph')
  return {
    id: attribute(cNvPr, 'id') || '0',
    name: attribute(cNvPr, 'name'),
    placeholder: placeholder ? (attribute(placeholder, 'type') || 'body') : null
  }
}

function hyperlinksOf(root: Element, relationships: Map<string, Relationship>): string[] {
  const links: string[] = []
  for (const link of allElements(root, 'hlinkClick')) {
    const rel = relationships.get(attribute(link, 'id', REL_NS))
    if (rel?.target) links.push(rel.target)
  }
  return [...new Set(links)]
}

function textShape(root: Element, zIndex: number, relationships: Map<string, Relationship>): ImportTextShape | null {
  const paragraphs = paragraphsOf(root)
  if (!paragraphs.length) return null
  return {
    kind: 'text',
    ...shapeIdentity(root),
    paragraphs,
    markdownParagraphs: markdownParagraphsOf(root),
    geometry: shapeGeometry(root),
    zIndex,
    hyperlinks: hyperlinksOf(root, relationships)
  }
}

function slideLayoutName(packageDir: string, slidePart: string, relationships: Map<string, Relationship>): string {
  const rel = [...relationships.values()].find((candidate) => candidate.type.endsWith('/slideLayout') && !candidate.external)
  if (!rel) return ''
  const layoutPath = packagePath(packageDir, resolvePartTarget(slidePart, rel.target))
  if (!existsSync(layoutPath)) return ''
  return attribute(firstElement(readXml(layoutPath), 'cSld'), 'name')
}

function smartArtNodes(data: Document): ImportSmartArtNode[] {
  type ModelNode = { id: string; text: string; type: string }
  const models = new Map<string, ModelNode>()
  for (const point of allElements(data, 'pt')) {
    const id = attribute(point, 'modelId')
    const type = attribute(point, 'type')
    if (!id || ['parTrans', 'sibTrans', 'pres'].includes(type)) continue
    models.set(id, { id, type, text: paragraphsOf(point).join(' ').trim() })
  }
  const children = new Map<string, Array<{ id: string; order: number }>>()
  const incoming = new Set<string>()
  for (const connection of allElements(data, 'cxn')) {
    if (attribute(connection, 'type')) continue
    const source = attribute(connection, 'srcId')
    const destination = attribute(connection, 'destId')
    if (!models.has(source) || !models.has(destination)) continue
    const order = Number(attribute(connection, 'srcOrd')) || 0
    children.set(source, [...(children.get(source) ?? []), { id: destination, order }])
    incoming.add(destination)
  }
  const build = (id: string, path: Set<string>): ImportSmartArtNode | null => {
    const model = models.get(id)
    if (!model || path.has(id)) return null
    const nextPath = new Set(path).add(id)
    const nested = (children.get(id) ?? [])
      .sort((a, b) => a.order - b.order)
      .map((child) => build(child.id, nextPath))
      .filter((node): node is ImportSmartArtNode => Boolean(node))
    if (!model.text && model.type !== 'doc') return null
    return { id, text: model.text, children: nested }
  }
  const roots = [...models.values()].filter((model) => model.type === 'doc' || !incoming.has(model.id))
  return roots.flatMap((root) => {
    const built = build(root.id, new Set())
    return built ? (root.type === 'doc' && !built.text ? built.children : [built]) : []
  })
}

function smartArtShape(
  root: Element,
  zIndex: number,
  relationships: Map<string, Relationship>,
  packageDir: string,
  slidePart: string
): ImportSmartArtShape | null {
  const identity = shapeIdentity(root)
  const relIds = firstElement(root, 'relIds')
  const dataRel = relationships.get(attribute(relIds, 'dm', REL_NS))
  const layoutRel = relationships.get(attribute(relIds, 'lo', REL_NS))
  if (!dataRel || dataRel.external) return null
  const dataPath = packagePath(packageDir, resolvePartTarget(slidePart, dataRel.target))
  if (!existsSync(dataPath)) return null
  let layoutName = ''
  let categories: string[] = []
  if (layoutRel && !layoutRel.external) {
    const layoutPath = packagePath(packageDir, resolvePartTarget(slidePart, layoutRel.target))
    if (existsSync(layoutPath)) {
      const layout = readXml(layoutPath)
      layoutName = attribute(firstElement(layout, 'title'), 'val')
        || attribute(layout.documentElement, 'uniqueId').split('/').pop()
        || ''
      categories = [...new Set(allElements(layout, 'cat').map((category) => attribute(category, 'type')).filter(Boolean))]
    }
  }
  return {
    kind: 'smartart',
    id: identity.id,
    name: identity.name,
    layoutName,
    categories,
    geometry: shapeGeometry(root),
    zIndex,
    nodes: smartArtNodes(readXml(dataPath))
  }
}

function pictureShape(
  root: Element,
  zIndex: number,
  relationships: Map<string, Relationship>,
  packageDir: string,
  slidePart: string
): ImportPictureShape | ImportVideoShape {
  const blip = firstElement(root, 'blip')
  const posterRel = relationships.get(attribute(blip, 'embed', REL_NS))
  const posterPart = posterRel && !posterRel.external ? resolvePartTarget(slidePart, posterRel.target) : null
  const posterPath = posterPart ? packagePath(packageDir, posterPart) : null
  const videoFile = firstElement(root, 'videoFile')
  const embeddedMedia = firstElement(root, 'media')
  const videoRel = relationships.get(attribute(videoFile, 'link', REL_NS))
    ?? relationships.get(attribute(embeddedMedia, 'embed', REL_NS))
  if (videoRel) {
    const videoPart = !videoRel.external ? resolvePartTarget(slidePart, videoRel.target) : null
    const videoPath = videoPart ? packagePath(packageDir, videoPart) : null
    return {
      kind: 'video',
      ...shapeIdentity(root),
      mediaPath: videoPath && existsSync(videoPath) ? videoPath : null,
      mediaName: videoPart ? basename(videoPart) : basename(videoRel.target),
      posterPath: posterPath && existsSync(posterPath) ? posterPath : null,
      posterName: posterPart ? basename(posterPart) : null,
      geometry: shapeGeometry(root),
      zIndex,
      hyperlinks: hyperlinksOf(root, relationships)
    }
  }
  return {
    kind: 'picture',
    ...shapeIdentity(root),
    mediaPath: posterPath && existsSync(posterPath) ? posterPath : null,
    mediaName: posterPart ? basename(posterPart) : null,
    geometry: shapeGeometry(root),
    zIndex,
    hyperlinks: hyperlinksOf(root, relationships)
  }
}

function unsupportedType(root: Element): string {
  if (allElements(root, 'chart').length) return 'chart'
  if (allElements(root, 'tbl').length) return 'table'
  if (allElements(root, 'oleObj').length) return 'embedded-object'
  const graphicData = firstElement(root, 'graphicData')
  const uri = attribute(graphicData, 'uri').toLowerCase()
  if (uri.includes('diagram')) return 'smartart'
  if (uri.includes('math')) return 'equation'
  return localName(root) || 'unsupported'
}

function unsupportedShape(root: Element, zIndex: number): ImportUnsupportedShape {
  const identity = shapeIdentity(root)
  return {
    kind: 'unsupported',
    id: identity.id,
    name: identity.name,
    objectType: unsupportedType(root),
    geometry: shapeGeometry(root),
    zIndex
  }
}

function notesForSlide(packageDir: string, slidePart: string, relationships: Map<string, Relationship>): string {
  const notesRel = [...relationships.values()].find((rel) => rel.type.endsWith('/notesSlide') && !rel.external)
  if (!notesRel) return ''
  const notesPart = resolvePartTarget(slidePart, notesRel.target)
  const notesPath = packagePath(packageDir, notesPart)
  if (!existsSync(notesPath)) return ''
  const doc = readXml(notesPath)
  const paragraphs: string[] = []
  for (const shape of allElements(doc, 'sp')) {
    const type = shapeIdentity(shape).placeholder
    if (type && ['hdr', 'ftr', 'dt', 'sldNum'].includes(type)) continue
    paragraphs.push(...paragraphsOf(shape))
  }
  return paragraphs.join('\n')
}

function parseSlide(
  packageDir: string,
  slidePart: string,
  slideNumber: number,
  hiddenByPresentation: boolean
): ImportSlideSource {
  const slidePath = packagePath(packageDir, slidePart)
  const doc = readXml(slidePath)
  const slideRoot = doc.documentElement
  const relPath = posix.join(posix.dirname(slidePart), '_rels', `${posix.basename(slidePart)}.rels`)
  const relationships = relationshipMap(packagePath(packageDir, relPath))
  const spTree = firstElement(doc, 'spTree')
  const shapes = spTree ? directElementChildren(spTree).flatMap((element, zIndex) => {
    const name = localName(element)
    if (name === 'sp') {
      const parsed = textShape(element, zIndex, relationships)
      return parsed ? [parsed] : []
    }
    if (name === 'pic') return [pictureShape(element, zIndex, relationships, packageDir, slidePart)]
    if (name === 'graphicFrame' && unsupportedType(element) === 'smartart') {
      return [smartArtShape(element, zIndex, relationships, packageDir, slidePart) ?? unsupportedShape(element, zIndex)]
    }
    if (name === 'graphicFrame' || name === 'oleObj' || name === 'grpSp') return [unsupportedShape(element, zIndex)]
    return []
  }) : []
  const textShapes = shapes.filter((shape): shape is ImportTextShape => shape.kind === 'text')
  const paragraphs = textShapes.flatMap((shape) => shape.paragraphs)
  const titleShape = textShapes.find((shape) => shape.placeholder === 'title' || shape.placeholder === 'ctrTitle')
  const unsupported = shapes.filter((shape): shape is ImportUnsupportedShape => shape.kind === 'unsupported')
  const warnings = [...new Set([
    ...unsupported.map((shape) => `${shape.objectType}-unsupported`),
    ...shapes.filter((shape) => shape.kind === 'video' && !shape.mediaPath).map(() => 'video-unavailable')
  ])]
  return {
    slideNumber,
    hidden: hiddenByPresentation || attribute(slideRoot, 'show') === '0',
    title: titleShape?.paragraphs.join(' ') || paragraphs[0] || `Slide ${slideNumber}`,
    paragraphs,
    notes: notesForSlide(packageDir, slidePart, relationships),
    layoutName: slideLayoutName(packageDir, slidePart, relationships),
    shapes,
    warnings
  }
}

async function validateAndExtract(sourcePath: string, packageDir: string, runner: ProcessRunner): Promise<void> {
  if (extname(sourcePath).toLowerCase() !== '.pptx') throw new Error('pptx-extension-required')
  const signature = readFileSync(sourcePath).subarray(0, 4).toString('hex')
  if (signature !== '504b0304' && signature !== '504b0506' && signature !== '504b0708') throw new Error('pptx-zip-signature-invalid')
  const listed = await runner('/usr/bin/unzip', ['-Z1', sourcePath])
  if (listed.code !== 0) throw new Error(`pptx-list-failed:${listed.stderr.trim() || listed.stdout.trim()}`)
  for (const entry of listed.stdout.split(/\r?\n/).filter(Boolean)) safeArchiveEntry(entry)
  mkdirSync(packageDir, { recursive: true })
  const extracted = await runner('/usr/bin/unzip', ['-q', sourcePath, '-d', packageDir])
  if (extracted.code !== 0) throw new Error(`pptx-extract-failed:${extracted.stderr.trim() || extracted.stdout.trim()}`)
}

export async function extractPptx(
  sourcePath: string,
  outputDir: string,
  runner: ProcessRunner = runProcess
): Promise<ExtractedPptx> {
  const packageDir = join(outputDir, 'package')
  await validateAndExtract(sourcePath, packageDir, runner)
  const presentationPart = 'ppt/presentation.xml'
  const presentationPath = packagePath(packageDir, presentationPart)
  if (!existsSync(presentationPath)) throw new Error('pptx-presentation-part-missing')
  const presentation = readXml(presentationPath)
  const relationships = relationshipMap(packagePath(packageDir, 'ppt/_rels/presentation.xml.rels'))
  const slideSize = firstElement(presentation, 'sldSz')
  const width = Number(attribute(slideSize, 'cx')) || 0
  const height = Number(attribute(slideSize, 'cy')) || 0
  // PowerPoint repeats p14:sldId elements inside section metadata. Only the direct children of
  // the presentation's primary p:sldIdLst are real ordered slides with relationship ids.
  const slideList = firstElement(presentation, 'sldIdLst')
  const slideIds = slideList
    ? directElementChildren(slideList).filter((element) => localName(element) === 'sldId')
    : []
  const slides = slideIds.map((slideId, index) => {
    const rel = relationships.get(attribute(slideId, 'id', REL_NS))
    if (!rel || rel.external || !rel.type.endsWith('/slide')) throw new Error(`pptx-slide-relationship-missing:${index + 1}`)
    return parseSlide(packageDir, resolvePartTarget(presentationPart, rel.target), index + 1, attribute(slideId, 'show') === '0')
  })
  const stat = statSync(sourcePath)
  return {
    source: {
      path: resolve(sourcePath),
      fileName: basename(sourcePath),
      hash: await sha256File(sourcePath),
      bytes: stat.size,
      slideCount: slides.length,
      width,
      height
    },
    packageDir,
    slides
  }
}

export async function inspectPptx(sourcePath: string, runner: ProcessRunner = runProcess): Promise<ImportSourceInfo> {
  const work = await mkdtemp(join(tmpdir(), 'talkweaver-pptx-inspect-'))
  try {
    return (await extractPptx(sourcePath, work, runner)).source
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

function executable(candidates: string[]): string | null {
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

export async function discoverRenderer(
  runner: ProcessRunner = runProcess,
  explicitPaths?: RendererPaths
): Promise<ImportRendererRecord> {
  const officePath = explicitPaths?.officePath ?? executable([
    '/opt/homebrew/bin/soffice',
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
    '/usr/local/bin/soffice'
  ])
  const rasterPath = explicitPaths?.rasterPath ?? executable(['/opt/homebrew/bin/pdftoppm', '/usr/local/bin/pdftoppm', '/usr/bin/pdftoppm'])
  if (!officePath || !rasterPath) {
    return {
      name: 'none',
      status: 'blocked',
      officePath,
      rasterPath,
      officeVersion: null,
      rasterVersion: null,
      error: `Missing ${!officePath ? 'LibreOffice' : 'pdftoppm'}.`
    }
  }
  const [officeVersion, rasterVersion] = await Promise.all([
    runner(officePath, ['--version']),
    runner(rasterPath, ['-v'])
  ])
  return {
    name: 'libreoffice',
    status: 'ready',
    officePath,
    rasterPath,
    officeVersion: (officeVersion.stdout || officeVersion.stderr).trim().split('\n')[0] || null,
    rasterVersion: (rasterVersion.stdout || rasterVersion.stderr).trim().split('\n')[0] || null
  }
}

export async function renderOriginalSlides(
  sourcePath: string,
  runDir: string,
  slideCount: number,
  runner: ProcessRunner = runProcess,
  explicitPaths?: RendererPaths
): Promise<RenderedSlides> {
  const renderer = await discoverRenderer(runner, explicitPaths)
  if (renderer.status !== 'ready' || !renderer.officePath || !renderer.rasterPath) return { renderer, files: [] }
  const renderDir = join(runDir, '.render')
  mkdirSync(renderDir, { recursive: true })
  const office = await runner(renderer.officePath, ['--headless', '--convert-to', 'pdf', '--outdir', renderDir, sourcePath])
  if (office.code !== 0) return { renderer: { ...renderer, status: 'failed', error: office.stderr.trim() || 'LibreOffice export failed.' }, files: [] }
  const expectedPdf = join(renderDir, `${basename(sourcePath, extname(sourcePath))}.pdf`)
  const pdfPath = existsSync(expectedPdf) ? expectedPdf : readdirSync(renderDir).map((file) => join(renderDir, file)).find((file) => extname(file).toLowerCase() === '.pdf')
  if (!pdfPath) return { renderer: { ...renderer, status: 'failed', error: 'LibreOffice did not produce a PDF.' }, files: [] }
  const prefix = join(renderDir, 'slide')
  const raster = await runner(renderer.rasterPath, ['-png', '-r', '144', pdfPath, prefix])
  if (raster.code !== 0) return { renderer: { ...renderer, status: 'failed', error: raster.stderr.trim() || 'pdftoppm failed.' }, files: [] }
  const pages = readdirSync(renderDir)
    .filter((file) => /^slide-\d+\.png$/i.test(file))
    .sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]))
  const files: string[] = []
  for (let index = 0; index < Math.min(slideCount, pages.length); index += 1) {
    const slideDir = join(runDir, 'slides', String(index + 1).padStart(3, '0'))
    mkdirSync(slideDir, { recursive: true })
    const target = join(slideDir, 'original.png')
    const source = join(renderDir, pages[index])
    const bytes = readFileSync(source)
    writeTextAtomic(target, bytes)
    files.push(target)
  }
  if (files.length !== slideCount) {
    return { renderer: { ...renderer, status: 'failed', error: `Rendered ${files.length} of ${slideCount} slides.` }, files }
  }
  return { renderer, files }
}
