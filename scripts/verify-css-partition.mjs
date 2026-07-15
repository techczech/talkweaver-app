import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { buildDeckStyles } from './build-deck-styles.mjs'

const templatePath = 'compiler/assets/templates/presenter-popup-single-html.html'
const originalTemplate = execFileSync('git', ['show', `HEAD:${templatePath}`], { encoding: 'utf8' })
const styleStart = originalTemplate.indexOf('<style>')
const styleEnd = originalTemplate.indexOf('</style>', styleStart)
const marker = '/*DECK_STYLES*/'
const endMarker = '/*END_DECK_STYLES*/'

assert(styleStart >= 0 && styleEnd > styleStart, `HEAD:${templatePath} must contain a <style> block`)

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
  `CSS partition differs from HEAD monolith (expected ${sha256(originalCss)}, got ${sha256(assembledCss)})`
)

console.log(`css partition byte-identical: ${Buffer.byteLength(assembledCss)} bytes; sha256 ${sha256(assembledCss)}`)
