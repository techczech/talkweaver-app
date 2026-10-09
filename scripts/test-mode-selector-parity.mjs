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
import { readFileSync } from 'node:fs'

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

// Emphasis steps (0.38 ticket 02) are a second kind of unit in the same positional enumeration.
// Their selector and their order are not copied into the two runtimes: both inline ONE module
// (compiler/assets/runtime/emphasis-steps.js), so there is nothing to drift. What can go wrong is
// that one runtime stops inlining it, so that is what is checked here.
{
  const moduleSrc = readFileSync(new URL('../compiler/assets/runtime/emphasis-steps.js', import.meta.url), 'utf8')
  const EMPH_STEP_SELECTOR = moduleSrc.match(/export const EMPH_STEP_SELECTOR = '([^']+)'/)?.[1]
  if (!EMPH_STEP_SELECTOR) { failed = true; console.error('FAIL emphasis steps: runtime/emphasis-steps.js no longer exports EMPH_STEP_SELECTOR') }
  const presenterSrc = readFileSync(PRESENTER_PATH, 'utf8')
  const audienceSrc = readFileSync(AUDIENCE_PATH, 'utf8')
  const inlined = {
    presenter: presenterSrc.includes('<!--EMPHASIS_STEPS_RUNTIME-->') && /emphasisStepElements\(scope, blocks, isVisibleUnit\)/.test(presenterSrc),
    audience: audienceSrc.includes('${emphasisStepsRuntimeSource()}') && /emphasisStepElements\(gallery \? card : slide, blocks, isVisibleUnit\)/.test(audienceSrc),
  }
  for (const [runtime, ok] of Object.entries(inlined)) {
    if (ok) continue
    failed = true
    console.error(`FAIL emphasis steps: the ${runtime} runtime does not enumerate emphasis spans through runtime/emphasis-steps.js.`)
    console.error('  A slide with {emphasis-steps} would count its steps differently there and fall out of step.')
  }
  if (inlined.presenter && inlined.audience) console.log(`emphasis steps: both runtimes enumerate ${EMPH_STEP_SELECTOR} through the one shared module`)
}

// Files that play as a step (0.38 ticket 05) are a third kind of unit in that same enumeration,
// listed by the same shared module, so their ORDER cannot drift either. What each runtime must
// still do by itself is read a file's state from the step with the module's mediaStepStates and
// hand it to the one playback source (compiler/assets/runtime/media-steps.js).
{
  const moduleSrc = readFileSync(new URL('../compiler/assets/runtime/emphasis-steps.js', import.meta.url), 'utf8')
  const MEDIA_STEP_SELECTOR = moduleSrc.match(/export const MEDIA_STEP_SELECTOR = '([^']+)'/)?.[1]
  if (!MEDIA_STEP_SELECTOR) { failed = true; console.error('FAIL media steps: runtime/emphasis-steps.js no longer exports MEDIA_STEP_SELECTOR') }
  if (!/EMPH_STEP_SELECTOR \+ ',' \+ MEDIA_STEP_SELECTOR/.test(moduleSrc)) { failed = true; console.error('FAIL media steps: emphasisStepElements no longer lists the files with the blocks and the emphasis spans') }
  const presenterSrc = readFileSync(PRESENTER_PATH, 'utf8')
  const audienceSrc = readFileSync(AUDIENCE_PATH, 'utf8')
  const wired = {
    presenter: presenterSrc.includes('<!--MEDIA_STEPS_RUNTIME-->') && /mediaSteps\.apply\(slide, plan\.files, plan\.media\(/.test(presenterSrc) && /mediaStepStates\(units, kind, step, movedOn\)/.test(presenterSrc),
    audience: audienceSrc.includes('${mediaStepsRuntimeSource()}') && /venueMediaSteps\.apply\(slide, mediaStepFiles\(found\.els\), mediaStepStates\(found\.units, at\.mode, at\.step, movedOn\)\)/.test(audienceSrc),
  }
  for (const [runtime, ok] of Object.entries(wired)) {
    if (ok) continue
    failed = true
    console.error(`FAIL media steps: the ${runtime} runtime does not play {play-on-next} files from the shared step order.`)
    console.error('  The venue screen and the projector would start and stop a file at different steps.')
  }
  if (wired.presenter && wired.audience) console.log(`media steps: both runtimes play ${MEDIA_STEP_SELECTOR} from the one shared step order and playback source`)
}

if (failed) process.exit(1)
console.log('mode selector parity: presenter and audience runtimes enumerate the same units')
