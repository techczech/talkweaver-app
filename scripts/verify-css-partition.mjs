import { strict as assert } from 'node:assert'
import { readPresenterTemplate } from '../compiler/scripts/lib/presenter-template.mjs'
import { createHash } from 'node:crypto'
import { buildDeckStyles } from './build-deck-styles.mjs'

const originalTemplate = readPresenterTemplate()
const styleStart = originalTemplate.indexOf('<style>')
const styleEnd = originalTemplate.indexOf('</style>', styleStart)
const marker = '/*DECK_STYLES*/'
const endMarker = '/*END_DECK_STYLES*/'

assert(styleStart >= 0 && styleEnd > styleStart, 'The generated presenter template must contain a <style> block')

const generatedStart = originalTemplate.indexOf(marker, styleStart)
const generatedEnd = originalTemplate.indexOf(endMarker, generatedStart)
const originalCss = generatedStart >= 0 && generatedEnd > generatedStart
  ? originalTemplate.slice(generatedStart + marker.length, generatedEnd)
  : originalTemplate.slice(styleStart + '<style>'.length, styleEnd)
const assembledCss = buildDeckStyles()
const sha256 = (value) => createHash('sha256').update(value).digest('hex')

assert.equal(
  assembledCss,
  originalCss,
  `CSS partition differs from generated presenter template (expected ${sha256(originalCss)}, got ${sha256(assembledCss)})`
)

console.log(`css partition byte-identical: ${Buffer.byteLength(assembledCss)} bytes; sha256 ${sha256(assembledCss)}`)
