import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import postcss from 'postcss'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const stylesDir = join(repo, 'compiler/assets/styles')
const templatePath = join(repo, 'compiler/assets/templates/presenter-popup-single-html.html')
const marker = '/*DECK_STYLES*/'
const endMarker = '/*END_DECK_STYLES*/'

export function layoutModulesInRegistryOrder() {
  const registry = readFileSync(join(repo, 'src/shared/layout-registry/entries.ts'), 'utf8')
  const modules = [...registry.matchAll(/cssModule:\s*'([^']+)'/g)].map((match) => match[1])
  return [...new Set(modules)]
}

export function buildDeckStyles() {
  const files = readdirSync(stylesDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.css'))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort()
  const blocks = []
  let sequence = 0

  for (const file of files) {
    const root = postcss.parse(readFileSync(file, 'utf8'), { from: file })
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
        css: `${node.raws.before ?? ''}${node.toString()}`
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

export function renderTemplateWithDeckStyles(template = readFileSync(templatePath, 'utf8')) {
  const start = template.indexOf(marker)
  const end = template.indexOf(endMarker)
  if (start < 0 || end < start) throw new Error(`Template must contain ${marker} and ${endMarker}`)
  return `${template.slice(0, start + marker.length)}${buildDeckStyles()}${template.slice(end)}`
}

export function writeDeckStyles() {
  const next = renderTemplateWithDeckStyles()
  writeFileSync(templatePath, next, 'utf8')
  return templatePath
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  console.log(`deck styles → ${writeDeckStyles()}`)
}
