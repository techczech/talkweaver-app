export type ImportRunStatus =
  | 'queued'
  | 'extracting'
  | 'rendering'
  | 'review'
  | 'cleanup-ready'
  | 'reviewed'
  | 'failed'

export type ImportSlideStatus = 'extracted' | 'converted' | 'review' | 'fallback' | 'failed'
export type ImportSlideFilter = 'all' | 'flagged' | 'fallback' | 'failed'
export type ImportRepresentation = 'candidate' | 'fallback'
export type ImportLayout = string
export type ImportCleanupPass = 'structural-parity' | 'layout-repair' | 'accessibility' | 'editorial'

export interface ImportOptions {
  title: string
  slug: string
  topicFolder?: string
  slideRange: string
  includeHidden: boolean
  preserveNotes: boolean
  extractMedia: boolean
  fallbackPolicy: 'uncertain' | 'always'
  renderer: 'automatic' | 'libreoffice'
}

export interface ImportSourceInfo {
  path: string
  fileName: string
  hash: string
  bytes: number
  slideCount: number
  width: number
  height: number
}

export interface ImportSourceSelection {
  sources: ImportSourceInfo[]
  errors: Array<{ path: string; message: string }>
}

export interface ImportShapeGeometry {
  x: number
  y: number
  width: number
  height: number
}

export interface ImportTextShape {
  kind: 'text'
  id: string
  name: string
  placeholder: string | null
  paragraphs: string[]
  markdownParagraphs?: string[]
  geometry: ImportShapeGeometry | null
  zIndex: number
  hyperlinks: string[]
}

export interface ImportSmartArtNode {
  id: string
  text: string
  children: ImportSmartArtNode[]
}

export interface ImportSmartArtShape {
  kind: 'smartart'
  id: string
  name: string
  layoutName: string
  categories: string[]
  geometry: ImportShapeGeometry | null
  zIndex: number
  nodes: ImportSmartArtNode[]
}

export interface ImportPictureShape {
  kind: 'picture'
  id: string
  name: string
  placeholder: string | null
  mediaPath: string | null
  mediaName: string | null
  geometry: ImportShapeGeometry | null
  zIndex: number
  hyperlinks: string[]
}

export interface ImportVideoShape {
  kind: 'video'
  id: string
  name: string
  placeholder: string | null
  mediaPath: string | null
  mediaName: string | null
  posterPath: string | null
  posterName: string | null
  geometry: ImportShapeGeometry | null
  zIndex: number
  hyperlinks: string[]
}

export interface ImportUnsupportedShape {
  kind: 'unsupported'
  id: string
  name: string
  objectType: string
  geometry: ImportShapeGeometry | null
  zIndex: number
}

export type ImportShape = ImportTextShape | ImportPictureShape | ImportVideoShape | ImportSmartArtShape | ImportUnsupportedShape

export interface ImportSlideSource {
  slideNumber: number
  hidden: boolean
  title: string
  paragraphs: string[]
  notes: string
  layoutName?: string
  shapes: ImportShape[]
  warnings: string[]
}

export interface ImportDecisionOverride {
  layout?: ImportLayout
  title?: string
  markdown?: string
  representation?: ImportRepresentation
  changedAt: string
}

export interface ImportSlideDecision {
  sourceId: string
  slideNumber: number
  ruleset: string
  status: ImportSlideStatus
  layout: ImportLayout
  modifiers?: string[]
  title: string
  basis: string[]
  warnings: string[]
  candidateMarkdown: string
  fallbackMarkdown: string
  representation: ImportRepresentation
  manualOverride?: ImportDecisionOverride
}

export interface ImportSlideRecord {
  slideNumber: number
  title: string
  hidden: boolean
  status: ImportSlideStatus
  warnings: string[]
  source: ImportSlideSource
  decision: ImportSlideDecision
  originalPath: string | null
}

export interface ImportRendererRecord {
  name: 'libreoffice' | 'none'
  status: 'ready' | 'blocked' | 'failed'
  officePath: string | null
  rasterPath: string | null
  officeVersion: string | null
  rasterVersion: string | null
  error?: string
}

export interface ImportRunManifest {
  schemaVersion: 1
  rulesetVersion: string
  id: string
  createdAt: string
  updatedAt: string
  status: ImportRunStatus
  source: ImportSourceInfo
  options: ImportOptions
  talk: {
    title: string
    slug: string
    path: string
    outlinePath: string
  }
  progress: {
    completedOperation: string
    completedSlide: number
    completed: number
    total: number
    note: string
  }
  renderer: ImportRendererRecord
  slides: Array<{
    slideNumber: number
    title: string
    hidden: boolean
    status: ImportSlideStatus
    warnings: string[]
  }>
  error?: string
}

export interface ImportRunDetail {
  manifest: ImportRunManifest
  slides: ImportSlideRecord[]
  outlineContent: string
}

export interface ImportProgress {
  runId: string
  status: ImportRunStatus
  completed: number
  total: number
  note: string
}

export interface ImportStartRequest {
  sourcePath: string
  options: ImportOptions
}

export interface ImportSlidePatch {
  layout?: ImportLayout
  title?: string
  markdown?: string
  representation?: ImportRepresentation
}

export interface ImportPackRequest {
  runId: string
  slideNumbers: number[]
  passes: ImportCleanupPass[]
}

export interface ImportSuggestion {
  slideNumber: number
  category: 'structure' | 'layout' | 'accessibility' | 'editorial'
  evidence: string[]
  rationale: string
  markdown: string
  sourcePreserving: boolean
}

export interface ImporterSettings {
  includeHidden: boolean
  preserveNotes: boolean
  extractMedia: boolean
  fallbackPolicy: 'uncertain' | 'always'
  renderer: 'automatic' | 'libreoffice'
  cleanupPasses: ImportCleanupPass[]
}

export const DEFAULT_IMPORTER_SETTINGS: ImporterSettings = {
  includeHidden: true,
  preserveNotes: true,
  extractMedia: true,
  fallbackPolicy: 'uncertain',
  renderer: 'automatic',
  cleanupPasses: ['structural-parity', 'layout-repair']
}

export function isFlaggedImportStatus(status: ImportSlideStatus): boolean {
  return status === 'review' || status === 'fallback' || status === 'failed'
}
