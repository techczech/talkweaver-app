import assert from 'node:assert/strict'
const ops = await import('../src/shared/slide-handling/pathway-list.ts').catch(() => null)
assert.ok(ops, 'shared pathway list operations exist')
const { addPathwaySlides, insertPathwaySlides, movePathwaySlide, removePathwaySlides, dropMissingPathwaySlides } = ops
let checks = 0
const eq = (actual, expected) => { assert.deepEqual(actual, expected); checks++ }
eq(addPathwaySlides(['c'], ['d', 'a', 'b'], ['a', 'b', 'c', 'd']), ['c', 'a', 'b', 'd'])
eq(addPathwaySlides(['c'], ['c', 'a', 'a', 'missing'], ['a', 'b', 'c']), ['c', 'a'])
eq(insertPathwaySlides(['a', 'c'], ['b', 'd'], 1), ['a', 'b', 'd', 'c'])
eq(insertPathwaySlides(['a', 'b', 'c', 'd'], ['b'], 3), ['a', 'c', 'b', 'd'])
eq(insertPathwaySlides(['a', 'b', 'c'], ['a', 'b'], 2), ['a', 'b', 'c'])
eq(insertPathwaySlides(['a', 'b'], ['a'], 2), ['b', 'a'])
eq(movePathwaySlide(['a', 'b', 'c'], 'c', -1), ['a', 'c', 'b'])
eq(movePathwaySlide(['a', 'b'], 'a', -1), ['a', 'b'])
eq(movePathwaySlide(['a', 'b'], 'x', 1), ['a', 'b'])
eq(removePathwaySlides(['a', 'missing', 'b'], ['missing', 'a']), ['b'])
eq(dropMissingPathwaySlides(['c', 'missing', 'a'], ['a', 'b', 'c']), ['c', 'a'])
const ids = ['c', 'a']
eq(dropMissingPathwaySlides(ids, ['c', 'b', 'a']), ids)
eq(ids, ['c', 'a'])
console.log(`${checks} pathway list checks passed`)
