import assert from 'node:assert/strict'
import ts from 'typescript'
import { readMainSource } from './read-source.mjs'

const registrations = new Map()

/** The complete registration statement, including its callback, wherever main defines it. */
export function readIpcRegistration(channel) {
  const matches = []
  readMainSource((source, path) => {
    if (!source.includes(`'${channel}'`) && !source.includes(`"${channel}"`) && !source.includes('`' + channel + '`')) return ''
    if (!registrations.has(path)) {
      registrations.set(path, ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true))
    }
    const file = registrations.get(path)
    function visit(node) {
      if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
        const { expression, arguments: [name] } = node.expression
        if (name && ts.isStringLiteralLike(name) && name.text === channel &&
          ts.isPropertyAccessExpression(expression) && ['handle', 'on'].includes(expression.name.text)) {
          matches.push(node.getText(file))
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
    return ''
  })
  assert.equal(matches.length, 1, `one registration for ${channel}`)
  return matches[0]
}
