import { strict as assert } from 'node:assert'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { buildDeckStyles, layoutModulesInRegistryOrder, renderTemplateWithDeckStyles } from './build-deck-styles.mjs'

const repo = resolve(new URL('..', import.meta.url).pathname)
const styles = join(repo, 'compiler/assets/styles')
const manifest = JSON.parse(readFileSync(join(styles, 'layout-scopes.json'), 'utf8'))
const modules = layoutModulesInRegistryOrder()

assert.deepEqual(modules, Object.keys(manifest), 'scope manifest order must match unique registry cssModule order')
for (const name of modules) {
  const layoutCss = readFileSync(join(styles, 'layouts', `${name}.css`), 'utf8')
  const skinCss = readFileSync(join(styles, 'skin', `${name}.css`), 'utf8')
  assert(layoutCss.includes('/* @order '), `${name}: needs ordered migration blocks`)
  assert(skinCss.includes('/* @order ') || skinCss.trim() === '', `skin/${name}: needs ordered migration blocks`)
  assert(manifest[name].length > 0, `${name}: needs declared selector scopes`)
  for (const [path, css] of [[name, layoutCss], [`skin/${name}`, skinCss]]) {
    const uncommented = css.replace(/\/\*[\s\S]*?\*\//g, '')
    const selectors = [...uncommented.matchAll(/(?:^|})\s*([^{}]+)\{/gm)].map((match) => match[1].trim()).filter((selector) => !selector.startsWith('@'))
    const escaped = selectors.filter((selector) => !selector.split(',').every((part) => manifest[name].some((scope) => part.includes(scope))))
    assert.deepEqual(escaped, [], `${path}: selector(s) outside declared scopes: ${escaped.join(' | ')}`)
  }
}

const overrides = readFileSync(join(styles, 'overrides.css'), 'utf8')
const overview = readFileSync(join(styles, 'overview.css'), 'utf8')
const base = readFileSync(join(styles, 'base.css'), 'utf8')
assert.match(
  buildDeckStyles(),
  /mark\.ink-marker\s*\{\s*\/\* ==mark== highlighter[\s\S]*?\*\//,
  'the ==mark== explanation travels inside its generated CSS rule'
)
assert.match(overview, /\/\* @order \d{4} \*\/\s*\.slide-sublink/, 'overview child row needs an explicit order')
assert.match(overview, /\/\* @order \d{4} \*\/\s*\.presenter-outline \.slide-sublink/, 'presenter child row needs an explicit order')

const orderedSheets = []
function collectCss(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) collectCss(path)
    else if (entry.name.endsWith('.css')) orderedSheets.push(path)
  }
}
collectCss(styles)
const orderOwners = new Map()
let orderTagCount = 0
for (const path of orderedSheets) {
  const css = readFileSync(path, 'utf8')
  for (const match of css.matchAll(/\/\*\s*@order\s+(\d{4})\s*\*\//g)) {
    orderTagCount += 1
    const owners = orderOwners.get(match[1]) ?? []
    owners.push(path.slice(styles.length + 1))
    orderOwners.set(match[1], owners)
  }
}
const duplicateOrders = [...orderOwners]
  .filter(([, owners]) => owners.length > 1)
  .map(([order, owners]) => `${order}: ${owners.join(', ')}`)
assert.deepEqual(
  duplicateOrders,
  [],
  `@order tags are globally unique across every deck stylesheet:\n${duplicateOrders.join('\n')}`
)
assert.equal(orderOwners.size, orderTagCount, 'every @order tag has exactly one owner')

const markOrder = base.match(/\/\* @order (\d{4}) \*\/\s*mark\.ink-marker/)?.[1]
const paragraphOrder = base.match(/\/\* @order (\d{4}) \*\/\s*\.slide-content > p:not\(\.lead\):not\(\.kicker\)/)?.[1]
assert(markOrder, 'ink-marker rule has a preceding migration order')
assert.equal(paragraphOrder, '0040', 'the paragraph rule keeps its pre-O-E migration order')
assert.notEqual(markOrder, paragraphOrder, 'ink-marker owns a genuinely free order tag')
assert(overrides.split('\n').length <= 200, 'overrides.css must not exceed 200 lines')
assert(!buildDeckStyles().includes('@layer '), 'assembled deck stylesheet must not use cascade layers')

const template = readFileSync(join(repo, 'compiler/assets/templates/presenter-popup-single-html.html'), 'utf8')
assert.equal(template, renderTemplateWithDeckStyles(template), 'Generated inline deck stylesheet is stale')
const preOeParagraphRule = '.slide-content > p:not(.lead):not(.kicker) { max-width: 60ch; }'
assert.equal(
  template.match(/\.slide-content > p:not\(\.lead\):not\(\.kicker\) \{[^}]*\}/)?.[0],
  preOeParagraphRule,
  'the generated template keeps the paragraph rule byte-identical to its pre-O-E form'
)
console.log(`css modules: ${modules.length} layout modules; overrides ${overrides.split('\n').length} lines; generated template current`)
