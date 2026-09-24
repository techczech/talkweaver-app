import { strict as assert } from 'node:assert'
import { toggleList, insertNewSlide } from '../src/renderer/src/components/actionBar/editing.ts'

assert.equal(toggleList('alpha\nbeta', 0, 10, 'bullet').text, '- alpha\n- beta')
assert.equal(toggleList('- alpha\n- beta', 0, 14, 'bullet').text, 'alpha\nbeta')
assert.equal(toggleList('1. alpha\n2. beta', 0, 16, 'bullet').text, '- alpha\n- beta')
assert.equal(toggleList('- alpha\n- beta', 0, 14, 'numbered').text, '1. alpha\n2. beta')
assert.equal(toggleList('1. alpha\n2. beta', 0, 16, 'numbered').text, 'alpha\nbeta')
const newSlide = insertNewSlide('## One\n\nBody\n## Two\n', 8)
assert.equal(newSlide.text, '## One\n\nBody\n## \n## Two\n')
assert.equal(newSlide.cursor, '## One\n\nBody\n## '.length)
console.log('action bar editing: all assertions passed')
