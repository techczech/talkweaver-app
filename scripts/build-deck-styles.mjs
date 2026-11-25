import { randomUUID } from 'node:crypto'
import { closeSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  deckStylesheetPaths, presenterTemplateOutput, presenterTemplateSource, PresenterTemplateError, readPresenterTemplate
} from '../compiler/scripts/lib/presenter-template.mjs'
import { renderTemplateWithShortcutHelp } from './build-shortcut-help.mjs'
import postcss from 'postcss'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const stylesDir = join(repo, 'compiler/assets/styles')
const compiler = join(repo, 'compiler')
const sourcePath = join(compiler, presenterTemplateSource)
const outputPath = join(compiler, presenterTemplateOutput)
const marker = '/*DECK_STYLES*/'
const endMarker = '/*END_DECK_STYLES*/'

export function layoutModulesInRegistryOrder() {
  const registry = readFileSync(join(repo, 'src/shared/layout-registry/entries.ts'), 'utf8')
  const modules = [...registry.matchAll(/cssModule:\s*'([^']+)'/g)].map((match) => match[1])
  return [...new Set(modules)]
}

export function buildDeckStyles() {
  const files = deckStylesheetPaths(stylesDir)
  const blocks = []
  let sequence = 0

  for (const file of files) {
    const root = postcss.parse(readFileSync(file, 'utf8').replaceAll('\r\n', '\n'), { from: file })
    let pendingOrder = null
    for (const node of root.nodes) {
      const match = node.type === 'comment' && node.text.match(/^\s*@order\s+(\d{4})\s*$/)
      if (match) {
        pendingOrder = Number(match[1])
        continue
      }
      blocks.push({
        order: pendingOrder ?? Number.POSITIVE_INFINITY,
        sequence: sequence++,
        css: `${node.raws.before ?? ''}${node.toString()}`.replace(/url\(['"]?\.\.\/\.\.\/fonts\/([^)'"]+)['"]?\)/g, (_, name) => `url(data:font/woff2;base64,${readFileSync(join(repo, 'compiler/assets/fonts', name)).toString('base64')})`)
      })
      pendingOrder = null
    }
    if (root.raws.after) {
      blocks.push({ order: Number.POSITIVE_INFINITY, sequence: sequence++, css: root.raws.after })
    }
  }

  blocks.sort((a, b) => a.order - b.order || a.sequence - b.sequence)
  return blocks.map((block) => block.css).join('')
}

export function renderTemplateWithDeckStyles(template) {
  const start = template.indexOf(marker)
  const end = template.indexOf(endMarker)
  if (start < 0 || end < start) throw new Error(`Template must contain ${marker} and ${endMarker}`)
  return `${template.slice(0, start + marker.length)}${buildDeckStyles()}${template.slice(end)}`
}

function currentTemplate() {
  try {
    return readPresenterTemplate()
  } catch (error) {
    if (error instanceof PresenterTemplateError || error.code === 'ENOENT') return null
    throw error
  }
}

export async function writeDeckStyles() {
  const source = readFileSync(sourcePath, 'utf8').replaceAll('\r\n', '\n')
  const next = await renderTemplateWithShortcutHelp(renderTemplateWithDeckStyles(source))
  if (next === currentTemplate()) return outputPath

  // Both generators publish a complete file. Parallel readers never see a half-written deck.
  const temporary = `${outputPath}.${randomUUID()}.tmp`
  const fd = openSync(temporary, 'wx')
  try {
    try { writeFileSync(fd, next) } finally { closeSync(fd) }
    renameSync(temporary, outputPath)
  } catch (error) {
    unlinkSync(temporary)
    throw error
  }
  return outputPath
}

export async function ensurePresenterTemplate() {
  return currentTemplate() === null ? writeDeckStyles() : outputPath
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const generate = process.argv.includes('--ensure') ? ensurePresenterTemplate : writeDeckStyles
  generate().then((path) => console.log(`deck styles and shortcut help → ${path}`)).catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
