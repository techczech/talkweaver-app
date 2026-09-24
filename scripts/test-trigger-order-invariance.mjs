import { strict as assert } from 'node:assert'
import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { LAYOUTS } from '../src/shared/layout-registry/entries.ts'

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const sourcePath = join(root, 'docs/layout-sampler-outline.md')
const sourceStat = statSync(sourcePath)
const expectedSlideIds = [
  'deck-title',
  'sect',
  'child',
  'next-section',
  'another-child',
  'deck-thanks'
]

function outlineWith(triggerLine, placement = 'trigger-line') {
  const sectionHeading = placement === 'heading' ? `## Sect ${triggerLine}` : '## Sect'
  const triggerLineBlock = placement === 'heading' ? '' : `${triggerLine}\n`
  return `# Timer order probe

${sectionHeading}
${triggerLineBlock}

### Child

- First child

## Next section

### Another child

- Second child
`
}

async function compile(triggerLine, placement) {
  return prepareSource(
    sourcePath,
    outlineWith(triggerLine, placement),
    'Timer order probe',
    sourceStat
  )
}

const timerCases = [
  {
    triggerLine: '{timer=10min}',
    show: 'presenter',
    warnings: []
  },
  {
    triggerLine: '{timer=10min}{timer-audience}',
    show: 'audience',
    warnings: []
  },
  {
    triggerLine: '{timer-audience}{timer=10min}',
    show: 'audience',
    warnings: []
  },
  {
    triggerLine: '{timer=10min}{timer-show=audience}',
    show: 'audience',
    warnings: ['unresolved-trigger:timer-show=audience']
  }
]

const openPatternOrderCases = [
  { key: 'countdown', valueToken: 'countdown=30s', siblingToken: 'countdown-style=bar' },
  { key: 'countdown-style', valueToken: 'countdown-style=bar', siblingToken: 'countdown=30s' },
  { key: 'timer', valueToken: 'timer=10min', siblingToken: 'timer-audience' },
  { key: 'remind', valueToken: 'remind=Pause', siblingToken: 'remind-in=10min' },
  { key: 'remind-at', valueToken: 'remind-at=09:30', siblingToken: 'remind=Pause' },
  { key: 'remind-in', valueToken: 'remind-in=10min', siblingToken: 'remind=Pause' },
  { key: 'kicker', valueToken: 'kicker=Context', siblingToken: 'statement' },
  { key: 'icon', valueToken: 'icon=lucide:star', siblingToken: 'iconlist' },
  { key: 'tags', valueToken: 'tags=intro,team', siblingToken: 'numbered' },
  { key: 'blocks', valueToken: 'blocks:2x2', siblingToken: 'cards' },
  { key: 'cols', valueToken: 'cols=2', siblingToken: 'columns' },
  { key: 'id', valueToken: 'id=stable-id', siblingToken: 'notitle' },
  { key: 'from', valueToken: 'from=source-talk#slide', siblingToken: 'notitle' },
  { key: 'clonedFrom', valueToken: 'clonedFrom=source-talk#slide', siblingToken: 'notitle' },
  { key: 'palette', valueToken: 'palette=green', siblingToken: 'notitle' },
  { key: 'centre', valueToken: 'centre=Core', siblingToken: 'system-map' },
  { key: 'center', valueToken: 'center=Core', siblingToken: 'system-map' },
  { key: 'curve', valueToken: 'curve=sigmoid', siblingToken: 'chart' },
  { key: 'titlestyle', valueToken: 'titlestyle=sidebar', siblingToken: 'sidebar' },
  { key: 'role', valueToken: 'role=content', siblingToken: 'notitle' }
]

const matrixFailures = []
for (const { key, valueToken, siblingToken } of openPatternOrderCases) {
  const variants = {
    alone: `{${valueToken}}`,
    valueThenSibling: `{${valueToken}}{${siblingToken}}`,
    siblingThenValue: `{${siblingToken}}{${valueToken}}`
  }
  const compiled = {}
  for (const [variant, triggerLine] of Object.entries(variants)) {
    const model = await compile(triggerLine)
    compiled[variant] = {
      slideIds: model.slides.map((slide) => slide.id),
      warnings: model.warnings.filter((warning) => !String(warning).startsWith('icon-'))
    }
  }
  const slideSets = Object.values(compiled).map(({ slideIds }) => JSON.stringify(slideIds))
  const complete = Object.values(compiled).every(({ slideIds }) => slideIds.length === expectedSlideIds.length)
  const invariant = new Set(slideSets).size === 1
  if (!complete || !invariant) {
    matrixFailures.push({ key, valueToken, siblingToken, ...compiled })
  }
}

if (matrixFailures.length) {
  console.log('Open-pattern order/content failures:')
  for (const failure of matrixFailures) console.log(JSON.stringify(failure))
}
assert.deepEqual(
  matrixFailures,
  [],
  'open-pattern value + sibling compiles preserve complete, order-invariant slide ids'
)

const sectionOnlyCases = [
  { name: 'accent', triggerLine: '{accent=vermilion}' },
  { name: 'grid-linear', triggerLine: '{grid-linear}' },
  { name: 'grid-zoom', triggerLine: '{grid-zoom}' },
  { name: 'contents', triggerLine: '{contents}' },
  { name: 'timer-audience', triggerLine: '{timer=10min}{timer-audience}' }
]

const carouselEntry = LAYOUTS.find((entry) => entry.name === 'carousel')
assert(carouselEntry, 'carousel entry exists in the layout registry')
const carouselSampleModel = await prepareSource(
  sourcePath,
  carouselEntry.sample,
  'Carousel registry sample',
  sourceStat
)
assert.deepEqual(
  carouselSampleModel.warnings.filter((warning) => String(warning).startsWith('section-only-trigger-level:')),
  [],
  'carousel registry sample compiles without a false section-only warning'
)

for (const { name, triggerLine } of sectionOnlyCases) {
  const model = await prepareSource(
    sourcePath,
    `# Wrong-level probe

## Modes

### Wrong level ${name}
${triggerLine}

#### Child

- Body
`,
    `Wrong-level ${name} probe`,
    sourceStat
  )
  assert(
    model.warnings.includes(`section-only-trigger-level:wrong-level-${name}:${name}:3`),
    `${name}: section-only trigger below ## emits a compiler warning`
  )
}

for (const { triggerLine, show, warnings } of timerCases) {
  for (const placement of ['trigger-line', 'heading']) {
    const model = await compile(triggerLine, placement)
    assert.deepEqual(
      model.slides.map((slide) => slide.id),
      expectedSlideIds,
      `${triggerLine} on ${placement}: compile preserves the complete slide sequence`
    )
    assert.deepEqual(
      model.slides
        .filter((slide) => slide.sectionTimerSeconds)
        .map((slide) => [slide.id, slide.sectionTimerSeconds, slide.sectionTimerShow]),
      [
        ['sect', 600, show],
        ['child', 600, show]
      ],
      `${triggerLine} on ${placement}: section timer reaches the section divider and its child`
    )
    const relevantWarnings = model.warnings.filter((warning) => !String(warning).startsWith('icon-'))
    assert.deepEqual(
      relevantWarnings,
      warnings,
      `${triggerLine} on ${placement}: warnings remain explicit and stable`
    )
  }
}

const samplerModel = await prepareSource(
  sourcePath,
  readFileSync(sourcePath, 'utf8'),
  'TalkWeaver Layout Sampler',
  sourceStat,
  undefined,
  { projectionsOnly: true }
)
const samplerTimerHost = samplerModel.slides.find((slide) => slide.title === 'timer-audience')
const samplerTimerChild = samplerModel.slides.find((slide) => slide.title === 'Timed child')
assert.equal(samplerTimerHost?.nodeLevel, 2, 'sampler timer-audience host is authored at ##')
assert.deepEqual(
  [samplerTimerHost?.sectionTimerSeconds, samplerTimerHost?.sectionTimerShow],
  [600, 'audience'],
  'sampler timer-audience host demonstrates the audience timer'
)
assert.deepEqual(
  [samplerTimerChild?.sectionTimerSeconds, samplerTimerChild?.sectionTimerShow],
  [600, 'audience'],
  'sampler timed child inherits the demonstrated audience timer'
)

console.log(
  `trigger order invariance: PASS (${timerCases.length * 2} timer placement cases; `
  + `${openPatternOrderCases.length} open-pattern matrix cases; `
  + `carousel sample clean; ${sectionOnlyCases.length} wrong-level cases; sampler host compiled)`
)
