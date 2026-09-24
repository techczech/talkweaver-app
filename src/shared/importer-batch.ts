import type { ImportSourceInfo, ImportStartRequest, ImporterSettings } from './importer'

export type ImportDestinationOverrides = Record<string, string>

export function appendImportSources(
  current: ImportSourceInfo[],
  incoming: ImportSourceInfo[]
): ImportSourceInfo[] {
  const seen = new Set(current.map((source) => source.path))
  const next = [...current]
  for (const source of incoming) {
    if (seen.has(source.path)) continue
    seen.add(source.path)
    next.push(source)
  }
  return next
}

export function setImportDestination(
  current: ImportDestinationOverrides,
  sourcePath: string,
  destination: string
): ImportDestinationOverrides {
  return { ...current, [sourcePath]: destination.trim() }
}

export function resetImportDestination(
  current: ImportDestinationOverrides,
  sourcePath: string
): ImportDestinationOverrides {
  const next = { ...current }
  delete next[sourcePath]
  return next
}

export function effectiveImportDestination(
  sourcePath: string,
  defaultDestination: string,
  overrides: ImportDestinationOverrides
): string {
  return Object.prototype.hasOwnProperty.call(overrides, sourcePath)
    ? overrides[sourcePath]
    : defaultDestination.trim()
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'imported-talk'
}

function sourceTitle(source: ImportSourceInfo): string {
  return source.fileName.replace(/\.pptx$/i, '').replace(/[_-]+/g, ' ').trim() || 'Imported talk'
}

export function importRequestsForBatch(input: {
  sources: ImportSourceInfo[]
  singleTitle: string
  singleSlug: string
  defaultDestination: string
  destinationOverrides: ImportDestinationOverrides
  slideRange: string
  settings: ImporterSettings
}): ImportStartRequest[] {
  return input.sources.map((source) => {
    const title = input.sources.length === 1 ? input.singleTitle.trim() : sourceTitle(source)
    const slug = input.sources.length === 1 ? input.singleSlug.trim() : slugify(title)
    return {
      sourcePath: source.path,
      options: {
        title,
        slug,
        topicFolder: effectiveImportDestination(
          source.path,
          input.defaultDestination,
          input.destinationOverrides
        ),
        slideRange: input.slideRange,
        includeHidden: input.settings.includeHidden,
        preserveNotes: input.settings.preserveNotes,
        extractMedia: input.settings.extractMedia,
        fallbackPolicy: input.settings.fallbackPolicy,
        renderer: input.settings.renderer
      }
    }
  })
}
