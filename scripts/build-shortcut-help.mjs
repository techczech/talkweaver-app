import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const templatePath = join(root, 'compiler/assets/templates/presenter-popup-single-html.html')
const startMarker = '/*SHORTCUT_HELP*/'
const endMarker = '/*END_SHORTCUT_HELP*/'

export async function buildShortcutHelp() {
  const { SHORTCUT_REGISTRY } = await import(new URL('../src/shared/shortcut-registry.ts', import.meta.url))
  const byId = new Map(SHORTCUT_REGISTRY.map((entry) => [entry.id, entry]))
  const tooltipIds = {
    presenterFirst: 'presenter.first', presenterPrev: 'presenter.previous', presenterNext: 'presenter.next',
    skipNextBtn: 'presenter.skip', returnBtn: 'presenter.return', presenterLast: 'presenter.last',
    presenterReveal: 'presenter.reveal', presenterFocus: 'presenter.focus', presenterHighlight: 'presenter.highlight',
    outlineBtn: 'presenter.overview', presenterAudienceApp: 'presenter.audience', twClockBtn: 'presenter.timer',
    twDurationBtn: 'presenter.duration', previewSizeBtn: 'presenter.preview-size',
    presenterMediaPlay: 'presenter.media', presenterGalleryBtn: 'presenter.gallery'
  }
  const tooltipKeys = Object.fromEntries(Object.entries(tooltipIds).map(([target, id]) => [target, byId.get(id).keys]))
  const groups = []
  for (const entry of SHORTCUT_REGISTRY.filter((item) => item.scope === 'presenter')) {
    let group = groups.find(([name]) => name === entry.group)
    if (!group) { group = [entry.group, []]; groups.push(group) }
    group[1].push([entry.keys, entry.label])
  }
  return `const SHORTCUT_KEYS = ${JSON.stringify(tooltipKeys)};\n  const SHORTCUTS_LIST = ${JSON.stringify(groups)};`
}

export async function renderTemplateWithShortcutHelp(template = readFileSync(templatePath, 'utf8')) {
  const start = template.indexOf(startMarker)
  const end = template.indexOf(endMarker)
  if (start < 0 || end < start) throw new Error(`Template must contain ${startMarker} and ${endMarker}`)
  const generated = await buildShortcutHelp()
  return `${template.slice(0, start + startMarker.length)}\n  ${generated}\n  ${template.slice(end)}`
}

export async function writeShortcutHelp() {
  writeFileSync(templatePath, await renderTemplateWithShortcutHelp(), 'utf8')
  return templatePath
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  console.log(`shortcut help → ${await writeShortcutHelp()}`)
}
