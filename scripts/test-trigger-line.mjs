import { strict as assert } from 'node:assert'
import {
  applyLayoutSelection, headingHasChildSlides, logicalTriggerBlockAfterHeading, parseTriggerGroups
} from '../src/shared/trigger-line.ts'

const source = '### Example {statement} {id=abc-123 tags="alpha, beta"} {from=source clonedFrom=original mystery=x}'
assert.equal(parseTriggerGroups(source).map((token) => token.raw).join('|'), 'statement|id=abc-123|tags=alpha, beta|from=source|clonedFrom=original|mystery=x')
assert.equal(
  applyLayoutSelection(source, { layout: 'quote', modifiers: ['reveal'], removeModifiers: ['statement'] }),
  '### Example {quote} {id=abc-123 tags="alpha, beta"} {from=source clonedFrom=original mystery=x} {reveal}'
)

assert.deepEqual(
  logicalTriggerBlockAfterHeading([
    '### Not all Agents are Agents',
    '{sidebar} {id=hnwcx}',
    '{layout=media} {id=3plcu}',
    '',
    'Body'
  ], 0),
  {
    start: 1,
    end: 3,
    line: '{sidebar}{layout=media}{id=3plcu}',
    warnings: ['duplicate-slide-id-merged:3plcu']
  },
  'consecutive Trigger-only lines form one ordered block and keep the final id'
)

assert.equal(headingHasChildSlides([
  '### Parent', '```md', '#### Example only', '```', '### Next'
], 0), false, 'fenced heading-shaped content is not a child slide')
assert.equal(headingHasChildSlides([
  '### Parent', '<!--', '#### Hidden child', '-->', '### Next'
], 0), false, 'comment-hidden headings are not child slides')
assert.equal(headingHasChildSlides([
  '### Parent', '', '#### Real child', '', '### Next'
], 0), true, 'a structural deeper heading is a child slide')

assert.deepEqual(
  logicalTriggerBlockAfterHeading([
    '### Final question - How much are you willing to invest in AI-assisted research?',
    '{iconlist}',
    '{id=uyee5} {split=50}',
    '',
    'Body'
  ], 0),
  {
    start: 1,
    end: 3,
    line: '{iconlist}{id=uyee5}{split=50}',
    warnings: []
  },
  'a bare modifier above an id-bearing Trigger line is one logical block'
)

const spaced = '### Example  {statement, numbered}   {id=a1} tail'
assert.equal(applyLayoutSelection(spaced, { layout: 'quote', modifiers: [], removeModifiers: ['numbered'] }), spaced)

const triggerLine = '{statement}  {id=a1 tags=x} {unknown=verbatim}'
assert.equal(
  applyLayoutSelection(triggerLine, { layout: 'quote', modifiers: ['focus'], removeModifiers: [] }),
  '{quote}  {id=a1 tags=x} {unknown=verbatim} {focus}'
)

console.log('trigger-line: parsing and byte-preserving selection checks passed')
