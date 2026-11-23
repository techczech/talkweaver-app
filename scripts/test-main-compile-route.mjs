import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = fileURLToPath(new URL('../src/main/', import.meta.url))

// [Imports or loader references, direct compile calls]. The remaining non-preparation entries
// are existing routes. New main-process callers must use the shared preparation route.
const expected = {
  'handout-pages.ts': [3, 3], // handout worker: publication preflight, talk build and Run build
  'index.ts': [3, 0], // backup/thumbnail options and the pre-work outline parser
  'instant-slide-insert.ts': [1, 1],
  'prepare-talk-worker.ts': [1, 1],
  'scratchpad-html.ts': [1, 0], // embed page policy
  'shared-talk-build.ts': [1, 1],
  'work-file-compile.ts': [1, 1],
}

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? sourceFiles(path) : /\.(?:[cm]?[jt]sx?)$/.test(entry.name) ? [path] : []
  })
}

function isAdapterLoad(node) {
  if (!ts.isStringLiteralLike(node) || !/(^|\/)08-source-adapters\.mjs$/.test(node.text)) return false
  // getCompilerPath's existence check locates the package; it does not load or compile anything.
  for (let parent = node.parent; parent && !ts.isStatement(parent); parent = parent.parent) {
    if (ts.isCallExpression(parent) && ts.isIdentifier(parent.expression) && parent.expression.text === 'existsSync') return false
  }
  return true
}

function isDirectCompile(node) {
  if (!ts.isCallExpression(node)) return false
  const callee = node.expression
  if (ts.isIdentifier(callee)) return callee.text === 'prepareSource'
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text === 'prepareSource'
  return ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression) && callee.argumentExpression.text === 'prepareSource'
}

const actual = {}
for (const path of sourceFiles(root)) {
  const tree = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
  let loads = 0
  let compiles = 0
  function inspect(node) {
    if (isAdapterLoad(node)) loads++
    if (isDirectCompile(node)) compiles++
    ts.forEachChild(node, inspect)
  }
  inspect(tree)
  if (loads || compiles) actual[relative(root, path).split('\\').join('/')] = [loads, compiles]
}

assert.deepEqual(actual, expected)
console.log('main compile route: all compiler imports and direct calls match the existing routes')
