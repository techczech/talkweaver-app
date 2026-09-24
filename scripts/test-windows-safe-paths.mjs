import { strict as assert } from 'node:assert'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = process.env.TW_WINDOWS_SAFE_PATHS_ROOT ?? dirname(dirname(fileURLToPath(import.meta.url)))
const roots = ['scripts', 'compiler/scripts', 'src/main']
const extensions = /\.(?:mjs|js|ts)$/
// These pathnames represent resource routes or browser locations, rather than file-URL conversion.
const allowed = new Map([
  ['scripts/layout-doctor-render.mjs', [
    { text: 'const pathname = decodeURIComponent(new URL(requestUrl).pathname)', reason: 'Explicitly retained by T35 brief; this is a file: request URL later compared with filesystem paths.' }
  ]],
  ['scripts/live-presenter-recovery.test.ts', [
    { text: 'url.pathname', reason: 'Assertion about a presenter HTTP route.' }
  ]],
  ['scripts/test-video-lightbox.mjs', [
    { text: 'location.pathname', reason: 'Browser document route used as a deck identifier.' }
  ]],
  ['compiler/scripts/lib/09-output-builders.mjs', [
    { text: 'location.pathname', reason: 'Browser document and location routes in generated client code.' }
  ]],
  ['src/main/index.ts', [
    { text: 'const key = decodeURIComponent(url.pathname.replace', reason: 'Thumbnail custom protocol resource key.' },
    { text: 'const rel = decodeURIComponent(url.pathname.replace', reason: 'Presentation custom protocol relative resource path.' },
    { text: 'const pathPart = new URL(run.handoutUrl).pathname.split', reason: 'Handout web route segment.' }
  ]]
])

function filesBelow(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const path = join(dir, entry.name)
      return entry.isDirectory() ? filesBelow(path) : extensions.test(entry.name) ? [path] : []
    })
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

const failures = []
let checked = 0
for (const folder of roots) {
  for (const file of filesBelow(join(root, folder))) {
    checked++
    const name = relative(root, file).replaceAll('\\', '/')
    const source = readFileSync(file, 'utf8')
    const ast = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true)
    const urlVars = new Set()
    const tainted = new Set()
    const isAllowed = node => {
      const line = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line
      const sourceLine = source.split('\n')[line] ?? ''
      return (allowed.get(name) ?? []).some(entry => sourceLine.includes(entry.text))
    }
    const isUrl = node => ts.isNewExpression(node) && node.expression.getText(ast) === 'URL'
      || ts.isIdentifier(node) && urlVars.has(node.text)
    const hasPathname = node => {
      if (ts.isPropertyAccessExpression(node) && node.name.text === 'pathname' && isUrl(node.expression)) {
        return !isAllowed(node)
      }
      return ts.forEachChild(node, hasPathname) ?? false
    }
    const hasTaint = node => {
      if (ts.isIdentifier(node) && tainted.has(node.text)) return true
      if (hasPathname(node)) return true
      return ts.forEachChild(node, hasTaint) ?? false
    }
    // Establish aliases before inspecting sinks, including aliases declared after a use.
    const declarations = []
    const collect = node => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) declarations.push(node)
      ts.forEachChild(node, collect)
    }
    collect(ast)
    for (const declaration of declarations) {
      if (isUrl(declaration.initializer)) urlVars.add(declaration.name.text)
    }
    for (let pass = 0; pass < declarations.length; pass++) {
      let changed = false
      for (const declaration of declarations) {
        if (hasTaint(declaration.initializer) && !tainted.has(declaration.name.text)) {
          tainted.add(declaration.name.text)
          changed = true
        }
      }
      if (!changed) break
    }
    const inspect = node => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression.getText(ast)
        if (/^(?:resolve|join|readFile(?:Sync)?|mkdir(?:Sync)?)$/.test(callee)
          && node.arguments.some(hasTaint)) {
          const line = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1
          failures.push(`${name}:${line}: URL pathname passed to ${callee}`)
        }
      }
      if (ts.isPropertyAssignment(node) && node.name.getText(ast) === 'path' && hasTaint(node.initializer)) {
        const line = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1
        failures.push(`${name}:${line}: URL pathname passed to path: option`)
      }
      ts.forEachChild(node, inspect)
    }
    inspect(ast)
  }
}
assert(checked > 0, 'No source files were scanned')
if (failures.length) {
  console.error(failures.join('\n'))
  process.exitCode = 1
} else {
  console.log(`Windows-safe paths: checked ${checked} source files`)
}
