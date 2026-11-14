import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync, statSync, rmSync, readdirSync, mkdtempSync, copyFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { walkSlides } from './lib/slide-readability.mjs'
import { clipWalk } from './lib/ocean-clip-walk.mjs'
const workRoot = resolve('.audit-local')
mkdirSync(workRoot, { recursive: true })
const work = mkdtempSync(resolve(workRoot, 'readability-coverage-'))
process.on('exit', () => rmSync(work, { recursive: true, force: true }))
for (const [signal, code] of Object.entries({ SIGINT: 130, SIGTERM: 143 })) process.once(signal, () => process.exit(code))
try {
  const source = resolve(work, 'neutral-outline.md')
  writeFileSync(source, '---\ntitle: Neutral\nauto_title_slide: false\nauto_thanks_slide: false\n---\n# Neutral\n## Section\n### Many\n{reveal}{id=many}\n\n' + Array.from({ length: 65 }, (_, i) => `- Neutral point ${i + 1}`).join('\n') + '\n\n### End\n{id=end}\n\nFinished.\n')
  const model = await prepareSource(source, readFileSync(source, 'utf8'), 'neutral', statSync(source))
  const html = resolve(work, 'neutral.html')
  writeFileSync(html, model.fullHtml)
  let tail = false
  const runtimeStates = []
  const coverage = await walkSlides(html, async (_, state) => { runtimeStates.push(state); if (state.id === 'many' && state.step >= 65 && state.terminal) tail = true }, { settleMs: 5 })
  assert.ok(tail, '65-item reveal terminal state measured')
  assert.ok(coverage.complete, JSON.stringify(coverage.issues))
  // Expected steps come from the deck runtime (slideSteps().max and the beat list), not from the walker's guess
  assert.ok(coverage.runtime, 'a compiled deck is walked with its runtime position')
  const many = runtimeStates.filter((state) => state.id === 'many')
  assert.ok(many.every((state) => state.runtime && state.runtime.max === many[0].runtime.max && state.runtime.max >= 65), JSON.stringify(many[0]?.runtime))
  assert.deepEqual(many.map((state) => state.runtime.step), Array.from({ length: many[0].runtime.max + 1 }, (_, i) => i), 'every step from 0 to slideSteps().max was measured once')
  assert.deepEqual(many.filter((state) => state.terminal).map((state) => state.runtime.step), [many[0].runtime.max], 'only the last step is terminal, by the runtime')
  assert.equal(readFileSync(html, 'utf8'), String(model.fullHtml), 'the compiled deck itself is not changed')
  assert.deepEqual(readdirSync(work).filter((name) => name.includes('.walk-')), [], 'the hooked copy is removed')
  const clipping = await clipWalk(html, { settleMs: 5 })
  assert.ok('many#66' in clipping, 'clipping regression walker measures the terminal 65-item state')
  await assert.rejects(() => clipWalk(html, { settleMs: 5, maxStepsPerSlide: 60 }), /clipping walk incomplete:.*state cap/, 'clipping comparisons must reject partial coverage')
  const capped = await walkSlides(html, async () => {}, { maxStepsPerSlide: 60, settleMs: 5 })
  assert.equal(capped.complete, false, 'R4: legacy 60-state cap must be incomplete')
  assert.ok(capped.issues.some(x => x.includes('state cap')))
  const pressed = await walkSlides(html, async () => {}, { maxPresses: 1, settleMs: 5 })
  assert.equal(pressed.complete, false, 'overall cap must be incomplete')
  const blockedHtml = resolve(work, 'blocked.html')
  writeFileSync(blockedHtml, model.fullHtml + '<script>window.addEventListener("keydown", e => { e.stopImmediatePropagation(); e.preventDefault() }, true)</script>')
  const blocked = await walkSlides(blockedHtml, async () => {}, { settleMs: 5 })
  assert.equal(blocked.complete, false, 'forced hash navigation must never certify full coverage')
  assert.ok(blocked.issues.some(x => x.includes('forced navigation escape')), JSON.stringify(blocked.issues))
  // A compiled carousel whose beat list has one beat fewer than the gallery has cards (the fault seen in real talks,
  // injected here so the test does not depend on when the product is fixed): Next never shows the last card. That is a
  // deck fault, listed apart; the card is shown with its dot and measured; the walk stays complete.
  copyFileSync(resolve('scripts/fixtures/ocean-look/assets/stand-in-picture.png'), resolve(work, 'pic.png'))
  const carouselSource = resolve(work, 'carousel-source.md')
  writeFileSync(carouselSource, '---\ntitle: Neutral\nauto_title_slide: false\nauto_thanks_slide: false\n---\n# Neutral\n## Section\n### Cards\n{carousel}{id=cards}\n\n#### Picture card\n\n![Neutral picture](pic.png)\n\n#### Second card\n\nNeutral second words.\n\n#### Third card\n\nNeutral third words.\n\n### End\n{id=end}\n\nFinished.\n')
  const carousel = await prepareSource(carouselSource, readFileSync(carouselSource, 'utf8'), 'neutral', statSync(carouselSource), undefined, { allowedAssetRoots: [work] })
  const carouselHtml = resolve(work, 'carousel.html')
  const lastBeat = /,\{"kind":"slide","slideId":"[a-z-]+","context":\{"container":"carousel","sectionId":"cards","index":2,"count":3\}\}/
  assert.match(String(carousel.fullHtml), lastBeat, 'the compiled carousel has a beat per card')
  writeFileSync(carouselHtml, String(carousel.fullHtml).replace(lastBeat, ''))
  const carouselStates = []
  const skippedCard = await walkSlides(carouselHtml, async (_, state) => carouselStates.push(state), { settleMs: 5 })
  assert.ok(skippedCard.complete, `a card Next never shows is not a tool limit: ${JSON.stringify(skippedCard.issues)}`)
  assert.deepEqual(skippedCard.neverShown, [{ id: 'cards', card: 2, cards: 3 }])
  assert.ok(carouselStates.some((state) => state.at === 'cards@card2#0' && state.direct && state.galleries[0].active === 2), 'the skipped card is shown directly and measured')
  // A slide the beat list leaves out (seen in a 0.43 talk): Next never shows it, and the runtime will not show it by
  // address either (its lookup falls back to the first beat). A deck fault listed as not measured; the walk stays
  // complete, so the other side's states for the slide stay unmatched.
  const noBeatHtml = resolve(work, 'no-beat.html')
  const endBeat = /,\{"kind":"slide","slideId":"end"\}/
  assert.match(String(carousel.fullHtml), endBeat)
  writeFileSync(noBeatHtml, String(carousel.fullHtml).replace(endBeat, ''))
  const noBeatStates = []
  const noBeat = await walkSlides(noBeatHtml, async (_, state) => noBeatStates.push(state), { settleMs: 5 })
  assert.ok(noBeat.complete, `a slide left out of the beat list is not a tool limit: ${JSON.stringify(noBeat.issues)}`)
  assert.deepEqual(noBeat.neverShown, [{ id: 'end', card: null, cards: 0, measured: false }])
  assert.ok(!noBeatStates.some((state) => state.id === 'end'), 'no state is recorded for a slide the deck cannot show')
  const mixedHtml = resolve(work, 'mixed.html')
  writeFileSync(mixedHtml, `<!doctype html><div class="stage"><section class="slide active" data-id="mixed"><div class="card-gallery" data-exclusive><div class="card active-card"><strong data-emph-state="off">Neutral</strong></div><div class="card">Neutral second card</div></div></section><section class="slide" data-id="end"></section></div><script>
    let step = 0;
    window.addEventListener('keydown', () => {
      step++;
      if (step === 1) document.querySelector('strong').dataset.emphState = 'on';
      if (step === 2) document.querySelectorAll('.card').forEach((c, i) => c.classList.toggle('active-card', i === 1));
      if (step >= 3) document.querySelectorAll('.slide').forEach((s, i) => s.classList.toggle('active', i === 1));
    });
  </script>`)
  const mixedStates = []
  const mixed = await walkSlides(mixedHtml, async (_, state) => mixedStates.push(state), { settleMs: 5 })
  assert.ok(mixed.complete, JSON.stringify(mixed.issues))
  assert.equal(mixedStates.filter(state => state.id === 'mixed').length, 3, 'card and inline emphasis changes are separate measured states')
  assert.equal(mixedStates.find(state => state.id === 'mixed').terminal, false)
  const skippedGalleryHtml = resolve(work, 'skipped-gallery.html')
  writeFileSync(skippedGalleryHtml, `<!doctype html><style>.card:not(.active-card){display:none}</style><div class="stage"><section class="slide active" data-id="skipped-gallery"><div class="card-gallery" data-exclusive><div class="card active-card">Neutral first card</div><div class="card">Neutral last card</div></div></section><section class="slide" data-id="end"></section></div><script>
    window.addEventListener('keydown', () => document.querySelectorAll('.slide').forEach((s, i) => s.classList.toggle('active', i === 1)));
  </script>`)
  const skippedGallery = await walkSlides(skippedGalleryHtml, async () => {}, { settleMs: 5 })
  assert.equal(skippedGallery.complete, false, 'a card Next never shows and that cannot be shown directly leaves the walk incomplete')
  assert.ok(skippedGallery.issues.includes('card not shown directly: skipped-gallery card 2'), JSON.stringify(skippedGallery.issues))
  assert.deepEqual(skippedGallery.neverShown, [{ id: 'skipped-gallery', card: 1, cards: 2 }])
  // The same fault in a deck whose cards have dots: a fault of the deck, not of the walk. The card is shown directly
  // and measured; the walk is complete.
  const dotsHtml = resolve(work, 'skipped-dots.html')
  writeFileSync(dotsHtml, `<!doctype html><style>.card:not(.active-card){display:none}</style><div class="stage"><section class="slide active" data-id="dots"><div class="card-gallery" data-exclusive><div class="card active-card">Neutral first card</div><div class="card">Neutral last card</div></div><div class="gallery-dots"><button class="gallery-dot" data-card-index="0"></button><button class="gallery-dot" data-card-index="1"></button></div></section><section class="slide" data-id="end"></section></div><script>
    const show = (i) => document.querySelectorAll('.card').forEach((c, j) => c.classList.toggle('active-card', i === j));
    document.querySelectorAll('.gallery-dot').forEach((dot) => dot.addEventListener('click', () => show(Number(dot.dataset.cardIndex))));
    window.addEventListener('hashchange', () => document.querySelectorAll('.slide').forEach((s) => s.classList.toggle('active', s.dataset.id === location.hash.slice(1))));
    window.addEventListener('keydown', () => document.querySelectorAll('.slide').forEach((s, i) => s.classList.toggle('active', i === 1)));
  </script>`)
  const dotStates = []
  const dots = await walkSlides(dotsHtml, async (_, state) => dotStates.push(state), { settleMs: 5 })
  assert.ok(dots.complete, JSON.stringify(dots.issues))
  assert.deepEqual(dots.neverShown, [{ id: 'dots', card: 1, cards: 2 }], 'the card Next never shows is listed as a deck fault')
  assert.ok(dotStates.some((state) => state.at === 'dots@card1#0' && state.direct), 'and measured after it is shown directly')
  const containerHtml = resolve(work, 'container.html')
  writeFileSync(containerHtml, `<!doctype html><div class="stage"><section class="slide active" data-id="container"><div class="ct-overlay"><span class="ct-tile">Neutral card</span></div></section><section class="slide" data-id="end"></section></div><script>
    let step = 0;
    window.addEventListener('keydown', () => {
      step++;
      if (step <= 2) document.querySelector('.ct-tile').className = step === 1 ? 'ct-tile now' : 'ct-tile done';
      else document.querySelectorAll('.slide').forEach((s, i) => s.classList.toggle('active', i === 1));
    });
  </script>`)
  const containerStates = []
  const containerCoverage = await walkSlides(containerHtml, async (_, state) => containerStates.push(state), { settleMs: 5 })
  assert.ok(containerCoverage.complete, JSON.stringify(containerCoverage.issues))
  assert.equal(containerStates.filter(state => state.id === 'container').length, 3, 'container return paints are measured even when the active slide and reveal attributes do not change')
  const mediaHtml = resolve(work, 'media.html')
  writeFileSync(mediaHtml, `<!doctype html><style>.card:not(.active-card){display:none}</style><div class="stage"><section class="slide active" data-id="media"><div class="card-gallery" data-exclusive><div class="card active-card"><span data-media-step="waiting">Neutral file one</span></div><div class="card"><span data-media-step="waiting">Neutral file two</span></div></div></section><section class="slide" data-id="end"></section></div><script>
    let step = 0;
    const files = document.querySelectorAll('[data-media-step]');
    window.addEventListener('keydown', () => {
      step++;
      if (step === 1) files[0].dataset.mediaStep = 'playing';
      if (step === 2) { files[0].dataset.mediaStep = 'waiting'; document.querySelectorAll('.card').forEach((c, i) => c.classList.toggle('active-card', i === 1)); }
      if (step === 3) files[1].dataset.mediaStep = 'playing';
      if (step >= 4) document.querySelectorAll('.slide').forEach((s, i) => s.classList.toggle('active', i === 1));
    });
  </script>`)
  const mediaStates = []
  const mediaCoverage = await walkSlides(mediaHtml, async (_, state) => mediaStates.push(state), { settleMs: 5 })
  assert.ok(mediaCoverage.complete, JSON.stringify(mediaCoverage.issues))
  assert.equal(mediaStates.filter(state => state.id === 'media').length, 4)
  assert.equal(mediaStates.filter(state => state.id === 'media').at(-1).terminal, true, 'last file playing is a terminal forward state; inactive-card waiting files are not pending steps')
  const imagesHtml = resolve(work, 'images.html')
  writeFileSync(imagesHtml, `<!doctype html><div class="stage"><section class="slide active" data-id="images">Neutral picture sequence</section><section class="slide" data-id="end"></section></div><div id="lightbox" hidden><span id="lightboxCounter">1 / 2</span></div><script>
    let step = 0;
    window.addEventListener('keydown', () => {
      step++;
      const box = document.getElementById('lightbox');
      if (step === 1) box.hidden = false;
      if (step === 2) document.getElementById('lightboxCounter').textContent = '2 / 2';
      if (step === 3) box.hidden = true;
      if (step >= 4) document.querySelectorAll('.slide').forEach((s, i) => s.classList.toggle('active', i === 1));
    });
  </script>`)
  const imageStates = []
  const imagesCoverage = await walkSlides(imagesHtml, async (_, state) => imageStates.push(state), { settleMs: 5 })
  assert.ok(imagesCoverage.complete, JSON.stringify(imagesCoverage.issues))
  assert.equal(imageStates.filter(state => state.id === 'images').length, 4, 'same-picture entries still have distinct image-counter states, then return to the slide')
  assert.equal(imageStates.filter(state => state.imageOpen).length, 2)
  const lastHtml = resolve(work, 'last-reveal.html')
  writeFileSync(lastHtml, `<!doctype html><div class="stage"><section class="slide active" data-id="last"><span data-mode-state="hidden">Neutral final reveal</span></section></div><script>
    let step = 0;
    window.addEventListener('keydown', () => { step = (step + 1) % 3; document.querySelector('span').dataset.modeState = ['hidden', 'current', 'full'][step]; });
  </script>`)
  const lastStates = []
  const lastCoverage = await walkSlides(lastHtml, async (_, state) => lastStates.push(state), { settleMs: 5, maxStepsPerSlide: 10 })
  assert.ok(lastCoverage.complete, JSON.stringify(lastCoverage.issues))
  assert.equal(lastStates.length, 3, 'final reveal loop closes after all states and the terminal state were measured')
  const lastImages = resolve(work, 'last-images.html')
  writeFileSync(lastImages, readFileSync(imagesHtml, 'utf8').replace('<section class="slide" data-id="end"></section>', '').replace("if (step >= 4) document.querySelectorAll('.slide').forEach((s, i) => s.classList.toggle('active', i === 1));", 'if (step >= 4) step = 0;'))
  const lastImageStates = []
  const lastImageCoverage = await walkSlides(lastImages, async (_, state) => lastImageStates.push(state), { settleMs: 5 })
  assert.ok(lastImageCoverage.complete, JSON.stringify(lastImageCoverage.issues))
  assert.equal(lastImageStates.filter(state => state.imageOpen).length, 2, 'terminal-looking initial final slide still visits every image')
  const typingDeck = held => `<!doctype html><div class="stage"><section class="slide active" data-id="typing"><div class="sim-step" data-mode-state="hidden">Neutral</div></section><section class="slide" data-id="end"></section></div><script>
    let step = 0;
    const unit = document.querySelector('.sim-step');
    const finish = () => { unit.classList.remove('sim-typing'); unit.textContent = 'Neutral complete text'; };
    window.addEventListener('keydown', () => {
      step++;
      if (step === 1) {
        unit.dataset.modeState = 'full'; unit.classList.add('sim-typing'); unit.textContent = 'Neutral';
        const rest = document.createElement('span'); rest.className = 'sim-typing-rest'; rest.style.visibility = 'hidden'; rest.textContent = ' complete text'; unit.appendChild(rest);
        if (!${held}) setTimeout(finish, 25);
      } else if (${held} && step === 2) finish();
      else document.querySelectorAll('.slide').forEach((s, i) => s.classList.toggle('active', i === 1));
    });
  </script>`
  const typingHtml = resolve(work, 'typing.html')
  writeFileSync(typingHtml, typingDeck(false))
  let completeTypedText = false
  const typed = await walkSlides(typingHtml, async (page, state) => {
    assert.equal(state.typing, 0, 'normal measurements wait for completed typing')
    if (state.id === 'typing' && state.terminal) completeTypedText = await page.evaluate(() => document.querySelector('.sim-step').textContent === 'Neutral complete text')
  }, { settleMs: 5 })
  assert.ok(typed.complete, JSON.stringify(typed.issues))
  assert.ok(completeTypedText)
  const heldHtml = resolve(work, 'typing-held.html')
  writeFileSync(heldHtml, typingDeck(true))
  const timedTyping = await walkSlides(heldHtml, async () => {}, { settleMs: 5, typingTimeoutMs: 10 })
  assert.equal(timedTyping.complete, false, 'typing readiness timeout cannot certify complete coverage')
  assert.ok(timedTyping.issues.some(issue => issue.includes('typing settle cap')))
  const cli = spawnSync(process.execPath, ['scripts/audit-talks-look.mjs', '--talks', work, '--before', '.', '--out', resolve(work, 'report'), '--no-sheets', '--max-steps-per-slide', '60', '--jobs', '1'], { encoding: 'utf8' })
  assert.equal(cli.status, 3, cli.stderr)
  assert.match(readFileSync(resolve(work, 'report/report.md'), 'utf8'), /INCOMPLETE[\s\S]*state cap/)
  const recordDir = resolve(work, 'report/records')
  const recordFile = resolve(recordDir, readdirSync(recordDir).find(name => name.endsWith('.json')))
  const legacy = JSON.parse(readFileSync(recordFile, 'utf8'))
  delete legacy.sides.before.coverage
  legacy.sides.before.compatibilitySentinel = 'preserve-recorded-before'
  writeFileSync(recordFile, JSON.stringify(legacy))
  const redo = spawnSync(process.execPath, ['scripts/audit-talks-look.mjs', '--talks', work, '--before', '.', '--out', resolve(work, 'report'), '--no-sheets', '--redo-after', '--max-steps-per-slide', '60', '--jobs', '1'], { encoding: 'utf8' })
  assert.equal(redo.status, 3, 'legacy before side is kept but cannot certify completeness')
  assert.deepEqual(JSON.parse(readFileSync(recordFile, 'utf8')).sides.before, legacy.sides.before, '--redo-after preserves the recorded before side')
  const zeroJobsOut = resolve(work, 'report-zero-jobs')
  const zeroJobs = spawnSync(process.execPath, ['scripts/audit-talks-look.mjs', '--talks', work, '--before', '.', '--out', zeroJobsOut, '--no-sheets', '--jobs', '0', '--max-presses', '0'], { encoding: 'utf8' })
  assert.equal(zeroJobs.status, 3, 'existing --jobs 0 still means one worker, with an explicit overall cap here')
  assert.equal(JSON.parse(readFileSync(resolve(zeroJobsOut, 'combos.json'), 'utf8')).stateCount, 1, 'the clamped worker actually measured a state')
  const invalid = spawnSync(process.execPath, ['scripts/audit-talks-look.mjs', '--talks', work, '--jobs', 'NaN'], { encoding: 'utf8' })
  assert.equal(invalid.status, 2, 'invalid worker count must never certify an unmeasured selection')
  console.log('PASS reveal coverage: 65-item terminal, per-slide cap, overall cap')
} finally { rmSync(work, { recursive: true, force: true }) }
