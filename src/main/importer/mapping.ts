import type {
  ImportDecisionOverride,
  ImportLayout,
  ImportSlideDecision,
  ImportSlideRecord,
  ImportSlideSource,
  ImportSmartArtNode,
  ImportTextShape
} from '../../shared/importer.ts'
import { importLayoutTrigger } from '../../shared/importer-layouts.ts'

export const IMPORT_RULESET_VERSION = 'talkweaver-import/3'

export interface ImportDecisionContext {
  sourceHash: string
  originalAsset: (slideNumber: number) => string
  mediaAssets: Record<string, string>
}

function markdownText(value: string): string {
  // Full stops and exclamation marks are ordinary prose inside TalkWeaver headings and blocks.
  // Escaping them makes imported email addresses and sentences visibly wrong in the editor.
  return value.replace(/([\\`*_{}<>#+|])/g, '\\$1')
}

function imageAlt(value: string): string {
  return value.replaceAll('[', '\\[').replaceAll(']', '\\]')
}

function titleShape(source: ImportSlideSource): ImportTextShape | undefined {
  return source.shapes.find((shape): shape is ImportTextShape =>
    shape.kind === 'text' && (shape.placeholder === 'title' || shape.placeholder === 'ctrTitle'))
}

function bodyParagraphs(source: ImportSlideSource): string[] {
  const title = titleShape(source)
  return source.shapes
    .filter((shape): shape is ImportTextShape => shape.kind === 'text' && shape !== title)
    .flatMap((shape) => shape.markdownParagraphs ?? shape.paragraphs.map(markdownText))
    .filter(Boolean)
}

function triggerLine(sourceId: string, layout: ImportLayout, modifiers: string[] = []): string {
  const tokens = [importLayoutTrigger(layout), ...modifiers.map((modifier) => `{${modifier}}`)].filter(Boolean)
  return [`{id=${sourceId}}`, ...tokens].join(' ')
}

function notesBlock(notes: string, hidden: boolean): string {
  const lines = [hidden ? 'Imported from a hidden PowerPoint slide.' : '', notes].filter(Boolean)
  return lines.length ? `\n\n:::notes\n${lines.join('\n\n')}\n:::` : ''
}

function slideMarkdown(
  source: ImportSlideSource,
  sourceId: string,
  layout: ImportLayout,
  content: string[],
  modifiers: string[] = []
): string {
  return [
    `### ${markdownText(source.title || `Slide ${source.slideNumber}`)}`,
    triggerLine(sourceId, layout, modifiers),
    '',
    ...content,
    notesBlock(source.notes, source.hidden)
  ].join('\n').replace(/\n{3,}:::notes/g, '\n\n:::notes').trim()
}

function smartArtMarkdown(nodes: ImportSmartArtNode[], depth = 0): string[] {
  return nodes.flatMap((node) => [
    `${'  '.repeat(depth)}- ${markdownText(node.text)}`,
    ...smartArtMarkdown(node.children, depth + 1)
  ])
}

function unsupportedWarnings(source: ImportSlideSource): string[] {
  return [...new Set([
    ...source.warnings,
    ...source.shapes
      .filter((shape) => shape.kind === 'unsupported')
      .map((shape) => `${shape.objectType}-unsupported`)
  ])]
}

export function classifySlide(source: ImportSlideSource, context: ImportDecisionContext): ImportSlideDecision {
  const sourceId = `pptx-${context.sourceHash.slice(0, 12)}-${String(source.slideNumber).padStart(3, '0')}`
  const body = bodyParagraphs(source)
  const media = source.shapes.filter((shape) => (shape.kind === 'picture' || shape.kind === 'video') && shape.mediaPath)
  const smartArt = source.shapes.find((shape) => shape.kind === 'smartart')
  const modifiers = /side\s*bar/i.test(source.layoutName ?? '') ? ['sidebar'] : []
  const warnings = unsupportedWarnings(source)
  const fallbackMarkdown = slideMarkdown(source, sourceId, 'media', [
    `![Original PowerPoint slide ${source.slideNumber}](${context.originalAsset(source.slideNumber)})`
  ])
  let layout: ImportLayout = 'auto'
  let status: ImportSlideDecision['status'] = 'review'
  let representation: ImportSlideDecision['representation'] = 'candidate'
  const basis: string[] = []
  let content: string[] = body

  if (smartArt) {
    layout = smartArt.categories.some((category) => category.toLowerCase() === 'timeline') ? 'timeline=compact' : 'smartart'
    status = 'converted'
    content = smartArtMarkdown(smartArt.nodes)
    basis.push('smartart-structure', `smartart-${layout}`)
  } else if (warnings.some((warning) => /(?:chart|smartart|equation|embedded-object)-unsupported/.test(warning))) {
    layout = 'media'
    status = 'fallback'
    representation = 'fallback'
    basis.push('unsupported-object')
  } else if (body.length === 0 && media.length === 0 && source.title.length <= 160) {
    layout = 'statement'
    status = 'converted'
    content = []
    basis.push('title-placeholder', 'single-short-text')
  } else if (media.length === 0 && body.length >= 2) {
    layout = 'list'
    status = 'converted'
    content = body.map((paragraph) => `- ${paragraph}`)
    basis.push('title-placeholder', 'multiple-body-paragraphs', 'no-media')
  } else if (media.length === 1 && body.length > 0) {
    layout = 'copy-visual'
    status = 'converted'
    const item = media[0]
    const asset = item.mediaPath ? context.mediaAssets[item.mediaPath] : null
    content = [
      ...body.map((paragraph) => `- ${paragraph}`),
      asset ? `![${imageAlt(item.name || source.title)}](${asset})` : ''
    ].filter(Boolean)
    basis.push('title-placeholder', 'body-copy', item.kind === 'video' ? 'single-video' : 'single-picture')
  } else if (media.length === 1 && body.length === 0) {
    layout = 'media'
    status = 'converted'
    const item = media[0]
    const asset = item.mediaPath ? context.mediaAssets[item.mediaPath] : null
    content = asset ? [`![${imageAlt(item.name || source.title)}](${asset})`] : []
    basis.push(item.kind === 'video' ? 'single-video' : 'single-picture', 'no-body-copy')
  } else if (media.length > 1) {
    layout = body.length ? 'copy-visual' : 'media'
    status = 'review'
    basis.push('multiple-media', 'z-order-preserved')
    warnings.push('composition-ambiguous')
    content = [
      ...body,
      ...media.map((item) => item.mediaPath && context.mediaAssets[item.mediaPath]
        ? `![${imageAlt(item.name || source.title)}](${context.mediaAssets[item.mediaPath]})`
        : '').filter(Boolean)
    ]
  } else {
    layout = 'list'
    status = 'review'
    basis.push('ambiguous-composition')
    warnings.push('composition-ambiguous')
  }

  return {
    sourceId,
    slideNumber: source.slideNumber,
    ruleset: IMPORT_RULESET_VERSION,
    status,
    layout,
    title: source.title,
    basis,
    warnings: [...new Set(warnings)],
    candidateMarkdown: slideMarkdown(source, sourceId, layout, content, modifiers),
    fallbackMarkdown,
    representation,
    modifiers,
  }
}

function replaceHeading(markdown: string, title: string): string {
  return markdown.replace(/^### .*$/m, `### ${markdownText(title)}`)
}

function replaceLayout(markdown: string, sourceId: string, layout: ImportLayout, modifiers: string[] = []): string {
  return markdown.replace(/^\{id=[^}]+\}(?:\s+\{[^}]+\})*$/m, triggerLine(sourceId, layout, modifiers))
}

export function effectiveSlideMarkdown(decision: ImportSlideDecision): string {
  const override: ImportDecisionOverride | undefined = decision.manualOverride
  const representation = override?.representation ?? decision.representation
  let markdown = representation === 'fallback'
    ? decision.fallbackMarkdown
    : (override?.markdown ?? decision.candidateMarkdown)
  if (override?.title) markdown = replaceHeading(markdown, override.title)
  if (override?.layout) markdown = replaceLayout(markdown, decision.sourceId, override.layout, decision.modifiers)
  return markdown.trim()
}

function yamlString(value: string): string {
  return JSON.stringify(value)
}

export function buildImportOutline(
  manifest: { id: string; status: string; source: { fileName: string }; talk: { title: string } },
  records: ImportSlideRecord[]
): string {
  return [
    '---',
    `title: ${yamlString(manifest.talk.title)}`,
    'outline_version: 2',
    `import_status: ${manifest.status}`,
    `import_run: ${manifest.id}`,
    `import_source: ${yamlString(manifest.source.fileName)}`,
    '---',
    '',
    '## Imported slides',
    '',
    ...records.sort((a, b) => a.slideNumber - b.slideNumber).map((record) => effectiveSlideMarkdown(record.decision)),
    ''
  ].join('\n\n').replace(/\n{4,}/g, '\n\n\n')
}
