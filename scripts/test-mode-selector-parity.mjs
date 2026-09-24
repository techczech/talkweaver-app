#!/usr/bin/env node
/**
 * Reveal/focus selector parity — presenter deck runtime vs audience handout runtime.
 *
 * The presenter template and the published handout are two SEPARATE runtimes that must
 * enumerate the SAME reveal/focus units, because the live protocol addresses a unit by its
 * integer index within that enumeration (worker/protocol.ts SlideFocusState.step). If one
 * side's MODE_SELECTOR gains an entry the other lacks, that layout either steps out of
 * alignment or silently no-ops on the audience phone.
 *
 * That is not hypothetical. `.timeline .tl-dyn-entries > li` lived only in the presenter list,
 * so on a {timeline=dynamic} slide the handout enumerated ZERO units and reveal-following was a
 * complete no-op — while both sides' own tests passed. The 09-output-builders comment claimed
 * "test-presentation-bundle's selector-parity check fails on drift"; no such test existed.
 * This is that test.
 *
 * Companion: `test:reveal-cross-runtime` proves the two live DOMs agree. This one proves the
 * selector SOURCES agree, and fails with a far clearer message when they do not.
 */
import {
  presenterSelectors,
  audienceSelectors,
  PRESENTER_PATH,
  AUDIENCE_PATH,
} from './lib/mode-selectors.mjs'

let failed = false

for (const name of ['MODE_SELECTOR', 'CARD_UNIT_SELECTOR']) {
  const presenter = presenterSelectors(name)
  const audience = audienceSelectors(name)
  const pSet = new Set(presenter)
  const aSet = new Set(audience)
  const onlyPresenter = presenter.filter((s) => !aSet.has(s))
  const onlyAudience = audience.filter((s) => !pSet.has(s))

  if (onlyPresenter.length || onlyAudience.length) {
    failed = true
    console.error(`FAIL ${name}: the two runtimes disagree.`)
    for (const s of onlyPresenter) console.error(`  only in PRESENTER: ${s}`)
    for (const s of onlyAudience) console.error(`  only in AUDIENCE:  ${s}`)
    console.error(
      '  Reveal/focus indexes are positional, so this drift makes the affected layout\n' +
      '  step out of alignment — or no-op entirely — on the audience handout.\n' +
      `  Fix: add the missing entry to the other list.\n` +
      `    presenter: ${PRESENTER_PATH}\n` +
      `    audience:  ${AUDIENCE_PATH}`
    )
  } else {
    console.log(`${name}: ${pSet.size} selectors, presenter and audience agree`)
  }
}

if (failed) process.exit(1)
console.log('mode selector parity: presenter and audience runtimes enumerate the same units')
