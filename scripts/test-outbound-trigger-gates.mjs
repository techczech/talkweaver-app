import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const sourceText = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
const sourceFile = ts.createSourceFile(
  'src/main/index.ts',
  sourceText,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS
)

function handlerSource(channel) {
  let callback = null
  const visit = (node) => {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.expression.getText(sourceFile) === 'ipcMain'
      && node.expression.name.text === 'handle'
      && ts.isStringLiteral(node.arguments[0])
      && node.arguments[0].text === channel
    ) {
      callback = node.arguments[1]
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  assert.ok(callback, `${channel}: handler is registered`)
  return callback.getText(sourceFile)
}

function loadHandler(channel, dependencies) {
  const callback = handlerSource(channel)
  const transpiled = ts.transpileModule(`const handler = ${callback}`, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext
    }
  }).outputText
  const names = Object.keys(dependencies)
  const values = Object.values(dependencies)
  return Function(...names, `${transpiled}\nreturn handler`)(...values)
}

const brokenOutline = [
  '### Safe',
  '{statement}',
  '',
  '### Broken',
  '{nonsense}'
].join('\n')
const expected = {
  success: false,
  error: 'This talk has 1 unresolved trigger. Publishing, exporting and presenting live are blocked until it is fixed.'
}
const expectedRebuild = {
  ok: false,
  error: expected.error
}

const unresolvedOutboundFailure = (content) =>
  content === brokenOutline ? expected : null
const unresolvedTriggerBlock = (content) =>
  content === brokenOutline ? { message: expected.error } : null
const dependencies = {
  unresolvedOutboundFailure,
  unresolvedTriggerBlock,
  unresolvedTriggerFindings: () => [{ token: 'nonsense' }],
  getConfig: (key) => key === 'vaultRoot' ? '/vault' : undefined,
  readRun: () => ({ status: 'delivered' }),
  talkBySlug: () => ({ slug: 'talk', outlinePath: '/vault/talk-outline.md' }),
  readFileSync: () => brokenOutline
}

const cases = [
  ['talk:present', [null, '/vault/talk-outline.md', brokenOutline, 'presenter'], expected],
  ['present:rebuild', [null, 42, '/vault/talk-outline.md', brokenOutline, 'slide-1'], expectedRebuild],
  ['replay:build', [null, 'talk'], expected],
  ['talk:build', [null, '/vault/talk-outline.md', brokenOutline], expected],
  ['talk:build-variants', [null, '/vault/talk-outline.md', brokenOutline], expected],
  ['talk:export-handout', [null, '/vault/talk-outline.md', brokenOutline], expected],
  ['talk:publish-handout', [null, '/vault/talk-outline.md', brokenOutline], expected],
  ['run:build-handout', [null, { talkSlug: 'talk', runId: 'run-1' }], expected],
  ['run:publish-handout', [null, { talkSlug: 'talk', runId: 'run-1' }], expected]
]

for (const [channel, args, expectedResult] of cases) {
  const handler = loadHandler(channel, dependencies)
  let result
  try {
    result = await handler(...args)
  } catch (cause) {
    result = { threw: cause instanceof Error ? cause.message : String(cause) }
  }
  assert.deepEqual(result, expectedResult, `${channel}: refuses unresolved content with its real failure shape`)
}

const historySource = readFileSync(new URL('../src/renderer/src/components/History.tsx', import.meta.url), 'utf8')
const pathwaysSource = readFileSync(new URL('../src/renderer/src/components/Pathways.tsx', import.meta.url), 'utf8')
const workspaceSource = readFileSync(new URL('../src/renderer/src/components/WorkspaceLayout.tsx', import.meta.url), 'utf8')

assert.match(
  historySource,
  /const presentPlanned[\s\S]*?unresolvedTriggerBlock\(source\)[\s\S]*?window\.tw\.pathways\.present/,
  'History gates planned-Run pathway presentation before its outbound call'
)
assert.match(
  historySource,
  /const presentPlanned[\s\S]*?unresolvedTriggerBlock\(source\)[\s\S]*?window\.tw\.talk\.present/,
  'History gates planned-Run full-talk presentation before its outbound call'
)
assert.match(
  historySource,
  /const publishRunHandout[\s\S]*?unresolvedTriggerBlock\(source\)[\s\S]*?window\.tw\.history\.publishRunHandout/,
  'History gates the live Run-handout publish before its outbound call'
)
assert.match(
  pathwaysSource,
  /const present =[\s\S]*?unresolvedTriggerBlock\(content\)[\s\S]*?window\.tw\.pathways\.present/,
  'Pathways gates presentation before its outbound call'
)
assert.match(
  workspaceSource,
  /function blockedByUnresolved\(content: string\)[\s\S]*?unresolvedTriggerBlock\(content\)/,
  'Workspace gates the exact outline string each handler sends'
)
assert.match(
  workspaceSource,
  /onRefresh\?\.\(async[\s\S]*?if \(content == null\) return[\s\S]*?blockedByUnresolved\(content\)[\s\S]*?window\.tw\.present\.rebuild/,
  'Workspace gates deck-window refresh against the current content before rebuilding'
)
assert.ok(
  workspaceSource.includes('The first is “{unresolvedBlock.firstTitle}” at line {unresolvedBlock.firstLine}.'),
  'Workspace names the first offending slide and line in the block modal'
)

console.log(`outbound trigger gates: ${cases.length} main handlers and renderer call sites refuse unresolved content`)
