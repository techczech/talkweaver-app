import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
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
assert.match(overview, /\/\* @order 1074 \*\/[\s\S]*\.slide-sublink/, 'overview child row needs explicit overview-range order')
assert.match(overview, /\/\* @order 1229 \*\/[\s\S]*\.presenter-outline \.slide-sublink/, 'presenter child row needs explicit presenter-outline-range order')
assert(overrides.split('\n').length <= 200, 'overrides.css must not exceed 200 lines')
assert(!buildDeckStyles().includes('@layer '), 'assembled deck stylesheet must not use cascade layers')

const template = readFileSync(join(repo, 'compiler/assets/templates/presenter-popup-single-html.html'), 'utf8')
assert.equal(template, renderTemplateWithDeckStyles(template), 'Generated inline deck stylesheet is stale')
console.log(`css modules: ${modules.length} layout modules; overrides ${overrides.split('\n').length} lines; generated template current`)
