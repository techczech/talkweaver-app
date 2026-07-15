// Standalone proof the VENDORED compiler renders with no Electron and no ~/gitrepos.
// Imports ONLY from ../compiler, so a green run also proves independence from the skill repo.
import { mkdtempSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const compilerDir = join(here, '..', 'compiler', 'scripts')

const { prepareSource } = await import(
  pathToFileURL(join(compilerDir, 'lib/08-source-adapters.mjs')).href
)
const { buildPerSlideProjections } = await import(
  pathToFileURL(join(compilerDir, 'lib/10-projections.mjs')).href
)

let failures = 0

function assert(condition, label) {
  if (condition) {
    console.log(`PASS: ${label}`)
  } else {
    console.error(`FAIL: ${label}`)
    failures++
  }
}

// --- Base smoke ---
const dir = mkdtempSync(join(tmpdir(), 'tw-smoke-'))
const outlinePath = join(dir, 'smoke-outline.md')
const content = '# Smoke Test Deck\n\n### Hello World\n\n- one\n- two\n'
writeFileSync(outlinePath, content, 'utf8')
const stat = statSync(outlinePath)

const model = await prepareSource(outlinePath, content, 'smoke', stat)
const rows = buildPerSlideProjections(model, 'smoke') ?? []

const html = model.fullHtml
assert(typeof html === 'string' && html.length >= 500, `fullHtml ${html?.length} bytes`)
assert(Array.isArray(rows) && rows.length >= 1, `${rows?.length} slide projection(s)`)

// --- Round A3: implicit image + table/prose is one copy-visual pair, with stacked copy ---
const copyVisualPath = join(dir, 'copy-visual-default.md')
const copyVisualContent = [
  '---',
  'title: Copy visual default',
  'auto_title_slide: false',
  'auto_thanks_slide: false',
  '---',
  '',
  '### Evidence',
  '',
  '![](sample.png)',
  '',
  '| Measure | Result |',
  '| --- | --- |',
  '| Accuracy | 92% |',
  '',
  'The table and this explanation belong together beside the image.',
].join('\n')
writeFileSync(copyVisualPath, copyVisualContent, 'utf8')
const copyVisualModel = await prepareSource(copyVisualPath, copyVisualContent, 'copy-visual-default', statSync(copyVisualPath))
const copyVisualSlide = copyVisualModel.slides.find((slide) => slide.title === 'Evidence')
assert(copyVisualSlide?.layout === 'copy-visual', 'Round A3: image + table + paragraph without a trigger infers copy-visual')
assert(
  /<div class="cv-body"><div class="cv-media">[\s\S]*<div class="cv-copy">[\s\S]*slide-table[\s\S]*content-p/.test(copyVisualModel.fullHtml),
  'Round A3: copy-visual renders media and all text/table blocks in separate non-overlapping columns'
)

const explicitLayoutPath = join(dir, 'copy-visual-explicit-regressions.md')
const explicitLayoutContent = [
  '---',
  'title: Explicit layout regressions',
  'auto_title_slide: false',
  'auto_thanks_slide: false',
  '---',
  '',
  '### Explicit media',
  '{media}',
  '![](sample.png)',
  'Copy remains under explicit media control.',
  '',
  '### Explicit image grid',
  '{image-grid}',
  '![](one.png)',
  '![](two.png)',
  '',
  '### Explicit copy visual',
  '{copy-visual}',
  '![](sample.png)',
  'Copy stays beside the image.',
  '',
  '### Image only',
  '![](sample.png)',
].join('\n')
writeFileSync(explicitLayoutPath, explicitLayoutContent, 'utf8')
const explicitLayoutModel = await prepareSource(explicitLayoutPath, explicitLayoutContent, 'copy-visual-explicit-regressions', statSync(explicitLayoutPath))
const explicitLayouts = Object.fromEntries(explicitLayoutModel.slides.map((slide) => [slide.title, slide.layout]))
assert(explicitLayouts['Explicit media'] === 'media', 'Round A3 regression: explicit {media} remains media')
assert(explicitLayouts['Explicit image grid'] === 'image-grid', 'Round A3 regression: explicit {image-grid} remains image-grid')
assert(explicitLayouts['Explicit copy visual'] === 'copy-visual', 'Round A3 regression: explicit {copy-visual} remains copy-visual')
assert(explicitLayouts['Image only'] === 'media', 'Round A3 regression: image-only inference remains media')

// --- ONE RENDERER: named section accents are section-wide and pin without shifting the cycle ---
const accentPath = join(dir, 'section-accents.md')
const accentContent = [
  '---',
  'title: Section Accent Deck',
  'auto_title_slide: false',
  'auto_thanks_slide: false',
  '---',
  '',
  '## Section A {id=section-a accent=vermilion}',
  '',
  '### A one {id=a-one}',
  '',
  'One.',
  '',
  '### A two {id=a-two}',
  '',
  'Two.',
  '',
  '## Section B {id=section-b}',
  '',
  '### B one {id=b-one}',
  '',
  'Three.',
].join('\n')
writeFileSync(accentPath, accentContent, 'utf8')
const accentModel = await prepareSource(accentPath, accentContent, 'section-accents', statSync(accentPath))
const styleFor = (compiled, id) => compiled.fullHtml.match(new RegExp(`<section[^>]*data-id="${id}"[^>]*style="([^"]*)"`))?.[1] ?? ''
const sectionAStyles = ['section-a', 'a-one', 'a-two'].map((id) => styleFor(accentModel, id))
assert(sectionAStyles.every((style) => style.includes('--sec-accent: #c2410c')), 'section accent: every slide in pinned Section A carries vermilion')
assert(new Set(sectionAStyles).size === 1, 'section accent: accent and tint never change inside a section')

const unpinnedContent = accentContent.replace(' accent=vermilion', '')
const unpinnedPath = join(dir, 'section-accents-unpinned.md')
writeFileSync(unpinnedPath, unpinnedContent, 'utf8')
const unpinnedModel = await prepareSource(unpinnedPath, unpinnedContent, 'section-accents-unpinned', statSync(unpinnedPath))
assert(styleFor(accentModel, 'section-b') === styleFor(unpinnedModel, 'section-b'), 'section accent: pinning one section does not shift or recolour later sections')

const unknownAccentContent = accentContent.replace('accent=vermilion', 'accent=ultraviolet')
const unknownAccentPath = join(dir, 'section-accent-unknown.md')
writeFileSync(unknownAccentPath, unknownAccentContent, 'utf8')
const unknownAccentModel = await prepareSource(unknownAccentPath, unknownAccentContent, 'section-accent-unknown', statSync(unknownAccentPath))
assert(unknownAccentModel.warnings.includes('accent-unknown:ultraviolet'), 'section accent: unknown named colour emits accent-unknown warning')
assert(styleFor(unknownAccentModel, 'section-a') === styleFor(unpinnedModel, 'section-a'), 'section accent: unknown named colour falls back to the deterministic cycle')

// --- Task 4 tree contract: records + beats agree on tree-deduped IDs ---
const treeContractPath = join(dir, 'tree-contract.md')
const treeContractContent = [
  '---',
  'title: Tree Contract Deck',
  'outline_version: 1',
  'auto_title_slide: false',
  'auto_thanks_slide: false',
  '---',
  '',
  '## Section {id=section}',
  '',
  '### Duplicate {id=dup}',
  '{notitle}',
  'First body.',
  '',
  '### Duplicate {id=dup}',
  'Second body.',
].join('\n')
writeFileSync(treeContractPath, treeContractContent, 'utf8')
const treeContractModel = await prepareSource(treeContractPath, treeContractContent, 'tree-contract', statSync(treeContractPath))
const treeSlideIds = treeContractModel.slides.map((s) => s.id)
const treeBeatIds = treeContractModel.beats.map((b) => b.slideId)
assert(treeSlideIds.join(',') === 'section,dup,dup-2', `Task 4: tree ids de-duped before record emission (${treeSlideIds.join(',')})`)
assert(treeBeatIds.join(',') === treeSlideIds.join(','), `Task 4: beat ids match slide record ids (${treeBeatIds.join(',')})`)
assert(treeContractModel.warnings.includes('legacy-outline'), 'Task 4: outline_version < 2 emits legacy-outline warning')
assert(treeContractModel.warnings.includes('duplicate-slide-id:dup'), 'Task 4: duplicate id warning preserved')
assert(treeContractModel.slides[0].nodeLevel === 2 && treeContractModel.slides[0].isSection === true, 'Task 4: section record carries nodeLevel/isSection')
assert(treeContractModel.slides[1].nodeLevel === 3 && treeContractModel.slides[1].isSection === false, 'Task 4: leaf record carries nodeLevel/isSection')
assert(treeContractModel.slides[1].noTitle === true, 'Task 4: stray trigger line in body folds into attrs')
assert(!treeContractModel.slides[1].blocks.some((b) => JSON.stringify(b).includes('{notitle}')), 'Task 4: stray trigger line does not render as body text')

const openingDropPath = join(dir, 'opening-drop.md')
const openingDropContent = [
  '---',
  'title: Opening Drop Deck',
  'auto_title_slide: false',
  'auto_thanks_slide: false',
  '---',
  '',
  '## Only Section {id=only-section}',
  '',
  '### Real opening {id=real-opening role=opening}',
  'Hello.',
].join('\n')
writeFileSync(openingDropPath, openingDropContent, 'utf8')
const openingDropModel = await prepareSource(openingDropPath, openingDropContent, 'opening-drop', statSync(openingDropPath))
const openingDropSlideIds = new Set(openingDropModel.slides.map((s) => s.id))
assert(!openingDropSlideIds.has('only-section'), 'Task 4: opening-first dropped single-content section divider')
assert(openingDropModel.beats.every((b) => openingDropSlideIds.has(b.slideId)), 'Task 4: beats reference only final slide records after post-passes')

const openingCarouselPath = join(dir, 'opening-carousel.md')
const openingCarouselContent = [
  '---',
  'title: Opening Carousel Deck',
  'auto_title_slide: false',
  'auto_thanks_slide: false',
  '---',
  '',
  '## Section {id=opening-section}',
  '',
  '### Opening carousel {id=opening-carousel role=opening carousel}',
  '',
  '#### First {id=opening-child}',
  '',
  'One.',
  '',
  '#### Second {id=opening-child}',
  '',
  'Two.',
  '',
  '### Later {id=later-slide}',
  '',
  'Later.',
].join('\n')
writeFileSync(openingCarouselPath, openingCarouselContent, 'utf8')
const openingCarouselModel = await prepareSource(openingCarouselPath, openingCarouselContent, 'opening-carousel', statSync(openingCarouselPath))
assert(openingCarouselModel.slides.map((slide) => slide.id).join(',') === 'opening-carousel,opening-section,later-slide', 'opening carousel: rendered slides open with carousel, then divider, then later sibling')
assert(openingCarouselModel.beats.map((beat) => beat.slideId).join(',') === 'opening-child,opening-child-2,opening-section,later-slide', 'opening carousel: both canonical child beats precede moved divider and later sibling')
assert(openingCarouselModel.beats.slice(0, 2).every((beat) => beat.context?.sectionId === 'opening-carousel'), 'opening carousel: first two beats render through opening parent')

const spineGridPath = join(dir, 'spine-grid.md')
const spineGridContent = [
  '---',
  'title: Spine Grid Deck',
  'auto_title_slide: false',
  'auto_thanks_slide: false',
  '---',
  '',
  '## Zoom section {grid-zoom id=zoom}',
  '',
  '### Long spine {timelinespine id=long-spine}',
  '',
  '**Timeline:**',
  '- 2001',
  '  - stop one',
  '- 2002',
  '  - stop two',
  '- 2003',
  '  - stop three',
  '- 2004',
  '  - stop four',
  '- 2005',
  '  - stop five',
  '- 2006',
  '  - stop six',
  '- 2007',
  '  - stop seven',
  '- 2008',
  '  - stop eight',
  '- 2009',
  '  - stop nine',
  '- 2010',
  '  - stop ten',
  '- 2011',
  '  - stop eleven',
  '- 2012',
  '  - stop twelve',
].join('\n')
writeFileSync(spineGridPath, spineGridContent, 'utf8')
const spineGridModel = await prepareSource(spineGridPath, spineGridContent, 'spine-grid', statSync(spineGridPath))
const spineGridRecordIds = new Set(spineGridModel.slides.map((s) => s.id))
const spineGridBeatIds = spineGridModel.beats.map((b) => b.slideId)
assert(spineGridModel.slides.some((s) => s.id === 'long-spine-2'), 'Task 4 review: spine auto-split emits continuation slide record')
assert(spineGridModel.beats.every((b) => spineGridRecordIds.has(b.slideId)), 'Task 4 review: every spine-grid beat slideId is a final record id')
assert(
  spineGridModel.beats.map((b) => `${b.kind}:${b.slideId}`).join(' ') === 'grid:zoom slide:long-spine grid-return:zoom slide:long-spine-2 grid-return:zoom',
  `Task 4 review: auto-split spine continuation beats stay inside grid-zoom sequence (${spineGridModel.beats.map((b) => `${b.kind}:${b.slideId}`).join(' ')})`
)
const spineReturns = spineGridModel.beats.filter((b) => b.kind === 'grid-return')
assert(JSON.stringify(spineReturns[0]?.context?.completed) === JSON.stringify(['long-spine']), 'Task 4 review: first grid-return completed list names original split slide')
assert(JSON.stringify(spineReturns[1]?.context?.completed) === JSON.stringify(['long-spine', 'long-spine-2']), 'Task 4 review: second grid-return completed list includes continuation')

const fencedTriggerPath = join(dir, 'fenced-trigger.md')
const fencedTriggerContent = [
  '---',
  'title: Fenced Trigger Deck',
  'auto_title_slide: false',
  'auto_thanks_slide: false',
  '---',
  '',
  '### Code keeps trigger-shaped text {id=code-keeps-trigger}',
  '',
  '```txt',
  '{notitle}',
  '```',
].join('\n')
writeFileSync(fencedTriggerPath, fencedTriggerContent, 'utf8')
const fencedTriggerModel = await prepareSource(fencedTriggerPath, fencedTriggerContent, 'fenced-trigger', statSync(fencedTriggerPath))
const fencedSlide = fencedTriggerModel.slides.find((s) => s.id === 'code-keeps-trigger')
assert(fencedSlide && fencedSlide.noTitle !== true, 'Task 4 review: trigger-shaped line inside code fence does NOT set noTitle')
assert(JSON.stringify(fencedSlide?.blocks || []).includes('{notitle}'), 'Task 4 review: trigger-shaped line inside code fence survives in rendered block model')

// --- Task 3 SD-7: no data-title-density stamp on any slide ---
// Compile two slides: one with sparse body (near-empty) and one content-rich.
const sdensityPath = join(dir, 'density-test.md')
const densityContent = [
  '# Density Test Deck',
  '',
  '## Section A',
  '',
  '### Sparse slide',
  '',
  '### Rich slide',
  '',
  '- item one',
  '- item two',
  '- item three',
  '- item four',
  '- item five',
  '- item six',
  '- item seven',
].join('\n')
writeFileSync(sdensityPath, densityContent, 'utf8')
const densityStat = statSync(sdensityPath)
const densityModel = await prepareSource(sdensityPath, densityContent, 'density-test', densityStat)
// The CSS comment mentions data-title-density="sparse" but the attribute must NOT appear
// on any <section> element. Check by looking for the attribute in a section tag context.
assert(!/\bdata-title-density="/.test(densityModel.fullHtml.replace(/<style[\s\S]*?<\/style>/g, '')), 'SD-7: no data-title-density stamp on section elements')

// --- Task 3: {title=side} on a slide → data-title-style="sidebar" ---
const sideSlidePath = join(dir, 'side-title.md')
const sideTitleContent = [
  '# Side Title Deck',
  '',
  '## Intro',
  '',
  '### My slide {title=side}',
  '',
  '- item one',
  '- item two',
].join('\n')
writeFileSync(sideSlidePath, sideTitleContent, 'utf8')
const sideStat = statSync(sideSlidePath)
const sideModel = await prepareSource(sideSlidePath, sideTitleContent, 'side-title', sideStat)
assert(sideModel.fullHtml.includes('data-title-style="sidebar"'), 'frame.title=side → data-title-style="sidebar"')

// --- Task 3: defaults: { title: side } in deck YAML → sidebar on all content slides ---
const defaultsSidePath = join(dir, 'defaults-side.md')
const defaultsSideContent = [
  '---',
  'title: Defaults Side Deck',
  'defaults:',
  '  title: side',
  '---',
  '',
  '## Introduction',
  '',
  '### First slide',
  '',
  '- alpha',
  '- beta',
].join('\n')
writeFileSync(defaultsSidePath, defaultsSideContent, 'utf8')
const defaultsSideStat = statSync(defaultsSidePath)
const defaultsSideModel = await prepareSource(defaultsSidePath, defaultsSideContent, 'defaults-side', defaultsSideStat)
assert(defaultsSideModel.fullHtml.includes('data-title-style="sidebar"'), 'defaults.title=side → data-title-style="sidebar"')

// --- Task 3 SD-8: {section=corner} → .corner-section element in output ---
const cornerPath = join(dir, 'corner-section.md')
const cornerContent = [
  '# Corner Section Deck',
  '',
  '## Setup',
  '',
  '### My corner slide {section=corner}',
  '',
  '- item one',
  '- item two',
].join('\n')
writeFileSync(cornerPath, cornerContent, 'utf8')
const cornerStat = statSync(cornerPath)
const cornerModel = await prepareSource(cornerPath, cornerContent, 'corner-section', cornerStat)
assert(cornerModel.fullHtml.includes('class="corner-section"'), 'SD-8: corner-section element present when frame.section=corner')

// --- Task 4 SD-4: image title → <figcaption> centred under the image ---
// Must be a v2 outline so the lexer produces a proper image block (frontmatter triggers v2).
const captionPath = join(dir, 'caption-test.md')
const captionContent = [
  '---',
  'title: Caption Test Deck',
  '---',
  '',
  '## Section',
  '',
  '### Slide with captioned image',
  '',
  '![A chart](chart.png "Codex working through a multi-file refactor")',
].join('\n')
writeFileSync(captionPath, captionContent, 'utf8')
const captionStat = statSync(captionPath)
const captionModel = await prepareSource(captionPath, captionContent, 'caption-test', captionStat)
assert(captionModel.fullHtml.includes('class="slide-figure fig"'), 'SD-4: figure has fig class')
assert(captionModel.fullHtml.includes('<figcaption>'), 'SD-4: figcaption present for image title')
assert(captionModel.fullHtml.includes('Codex working through'), 'SD-4: caption text rendered')

// --- Task 4 SD-14: {image=right} → .split.media-right, figcaption, list in .copy ---
const splitRightPath = join(dir, 'split-right.md')
const splitRightContent = [
  '# Split Right Deck',
  '',
  '## Setup',
  '',
  '### What\'s in the folder {image=right}',
  '',
  '![repo root](folder.png "repo root")',
  '',
  '- AGENTS.md — house rules',
  '- ROADMAP.md — what\'s next',
  '- compiler/ — the vendored engine',
].join('\n')
writeFileSync(splitRightPath, splitRightContent, 'utf8')
const splitRightStat = statSync(splitRightPath)
const splitRightModel = await prepareSource(splitRightPath, splitRightContent, 'split-right', splitRightStat)
assert(splitRightModel.fullHtml.includes('class="split media-right"'), 'SD-14: .split.media-right present for {image=right}')
assert(splitRightModel.fullHtml.includes('<figcaption>'), 'SD-14: figcaption present in split')
assert(splitRightModel.fullHtml.includes('class="copy"'), 'SD-14: .copy column present')

// --- Task 4 review fix: {image=right}{align=top} → .split.media-right.align-top ---
const splitAlignTopPath = join(dir, 'split-align-top.md')
const splitAlignTopContent = [
  '# Split Align Top Deck',
  '',
  '## Setup',
  '',
  '### Top-aligned media {image=right}{align=top}',
  '',
  '![diagram](diagram.png "A diagram")',
  '',
  '- first item',
  '- second item',
].join('\n')
writeFileSync(splitAlignTopPath, splitAlignTopContent, 'utf8')
const splitAlignTopStat = statSync(splitAlignTopPath)
const splitAlignTopModel = await prepareSource(splitAlignTopPath, splitAlignTopContent, 'split-align-top', splitAlignTopStat)
assert(splitAlignTopModel.fullHtml.includes('class="split media-right align-top"'), 'frame.align=top: .split carries align-top class on {image=right}{align=top}')

// --- Task 4 SD-14: {image=left} → .split.media-left ---
const splitLeftPath = join(dir, 'split-left.md')
const splitLeftContent = [
  '# Split Left Deck',
  '',
  '## Setup',
  '',
  '### What\'s in the folder {image=left}',
  '',
  '![repo root](folder.png "repo root")',
  '',
  '- AGENTS.md — house rules',
  '- ROADMAP.md — what\'s next',
].join('\n')
writeFileSync(splitLeftPath, splitLeftContent, 'utf8')
const splitLeftStat = statSync(splitLeftPath)
const splitLeftModel = await prepareSource(splitLeftPath, splitLeftContent, 'split-left', splitLeftStat)
assert(splitLeftModel.fullHtml.includes('class="split media-left"'), 'SD-14: .split.media-left present for {image=left}')

// --- Task 4 SD-5: 3 consecutive images → .img-row with 3 figure.fig units ---
// Frontmatter triggers v2 so images lex as blocks (not inline markdown).
const imgRowPath = join(dir, 'img-row.md')
const imgRowContent = [
  '---',
  'title: Image Row Deck',
  '---',
  '',
  '## Section',
  '',
  '### Three tools, one workflow',
  '',
  '![Codex](codex.png "Codex — the daily driver in the terminal")',
  '![Git](git.png "Git — every change reviewed")',
  '![Claude](claude.png "Claude — the planning partner")',
].join('\n')
writeFileSync(imgRowPath, imgRowContent, 'utf8')
const imgRowStat = statSync(imgRowPath)
const imgRowModel = await prepareSource(imgRowPath, imgRowContent, 'img-row', imgRowStat)
assert(imgRowModel.fullHtml.includes('class="img-row count-3"'), 'SD-5: .img-row.count-3 present for 3 consecutive images')
// All 3 figures have the fig class
const figCount = (imgRowModel.fullHtml.match(/class="slide-figure fig"/g) || []).length
assert(figCount === 3, `SD-5: 3 figure.fig units in img-row (got ${figCount})`)

// --- Task 4 regression: image + list without explicit {image=} attr → no split ---
// Frontmatter forces v2 so the image lex is accurate; without {image=}, split must NOT apply.
const noSplitPath = join(dir, 'no-split.md')
const noSplitContent = [
  '---',
  'title: No Split Deck',
  '---',
  '',
  '## Section',
  '',
  '### Slide without explicit image attr',
  '',
  '![chart](chart.png "A chart")',
  '',
  '- item one',
  '- item two',
].join('\n')
writeFileSync(noSplitPath, noSplitContent, 'utf8')
const noSplitStat = statSync(noSplitPath)
const noSplitModel = await prepareSource(noSplitPath, noSplitContent, 'no-split', noSplitStat)
assert(!noSplitModel.fullHtml.includes('class="split '), 'regression: no split without explicit {image=} attr')

// --- Task 5 SD-10: {icons=all} → icons at top level AND sub-bullets (.fl-sub-icon) ---
const iconsAllPath = join(dir, 'icons-all.md')
const iconsAllContent = [
  '# Icons All Deck',
  '',
  '## Section',
  '',
  '### Tools I use every day {icons=all}',
  '',
  '- Terminal — run commands and scripts',
  '  - fast feedback loop',
  '  - stays close to the code',
  '- Browser — explore and review',
  '  - search documentation',
  '  - share screenshots',
  '- Editor — write and refactor',
  '  - syntax highlighting',
  '  - integrated diff view',
].join('\n')
writeFileSync(iconsAllPath, iconsAllContent, 'utf8')
const iconsAllStat = statSync(iconsAllPath)
const iconsAllModel = await prepareSource(iconsAllPath, iconsAllContent, 'icons-all', iconsAllStat)
// Top-level icons must be present (fl-icon)
assert(iconsAllModel.fullHtml.includes('class="fl-icon"') || iconsAllModel.fullHtml.includes('fl-icon fl-num'), 'SD-10: top-level fl-icon present for {icons=all}')
// Sub-bullet icons must be present (fl-sub-icon)
assert(iconsAllModel.fullHtml.includes('fl-sub-icon'), 'SD-10: fl-sub-icon present for {icons=all}')
// fl-sublist > li must still be present (step units unchanged)
assert(iconsAllModel.fullHtml.includes('fl-sublist'), 'SD-10: fl-sublist present (step units unchanged)')

// --- Task 5 SD-10: {icons=off} → no icons even when list could have them ---
const iconsOffPath = join(dir, 'icons-off.md')
const iconsOffContent = [
  '# Icons Off Deck',
  '',
  '## Section',
  '',
  '### Tools I use {icons=off}',
  '',
  '- Terminal — run commands',
  '- Browser — explore',
  '- Editor — write',
].join('\n')
writeFileSync(iconsOffPath, iconsOffContent, 'utf8')
const iconsOffStat = statSync(iconsOffPath)
const iconsOffModel = await prepareSource(iconsOffPath, iconsOffContent, 'icons-off', iconsOffStat)
// No fl-icon should be present for a plain list with icons=off
const iconsOffBody = iconsOffModel.fullHtml.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<aside[\s\S]*?<\/aside>/g, '')
assert(!iconsOffBody.includes('fl-icon'), 'SD-10: no fl-icon for plain list with {icons=off}')

// --- Task 5 SD-10 regression: bare {icons}/{iconlist} → top-level icons still work ---
const iconsBarePath = join(dir, 'icons-bare.md')
const iconsBareContent = [
  '# Icons Bare Deck',
  '',
  '## Section',
  '',
  '### Tools I use {icons}',
  '',
  '- Terminal — run commands',
  '- Browser — explore documentation',
  '- Editor — write and refactor',
].join('\n')
writeFileSync(iconsBarePath, iconsBareContent, 'utf8')
const iconsBareStat = statSync(iconsBarePath)
const iconsBareModel = await prepareSource(iconsBarePath, iconsBareContent, 'icons-bare', iconsBareStat)
// Top-level icons must still be present (regression guard for bare {icons})
assert(iconsBareModel.fullHtml.includes('class="fl-icon"') || iconsBareModel.fullHtml.includes('fl-icon fl-num'), 'SD-10 regression: bare {icons} still produces top-level icons')
// Sub-icons must NOT be present in HTML body (bare {icons} is top-only, not all)
// Strip <style> to avoid matching the CSS class selector .fl-sub-icon in the stylesheet.
const iconsBareBodyOnly = iconsBareModel.fullHtml.replace(/<style[\s\S]*?<\/style>/g, '')
assert(!iconsBareBodyOnly.includes('fl-sub-icon'), 'SD-10 regression: bare {icons} does not produce sub-bullet icons')

// --- Task 5 SD-10: {icons=top} on a slide with a plain list → top-level icons forced ---
const iconsTopPath = join(dir, 'icons-top.md')
const iconsTopContent = [
  '# Icons Top Deck',
  '',
  '## Section',
  '',
  '### Tools I use {icons=top}',
  '',
  '- Terminal — run commands',
  '- Browser — explore documentation',
  '- Editor — write and refactor',
].join('\n')
writeFileSync(iconsTopPath, iconsTopContent, 'utf8')
const iconsTopStat = statSync(iconsTopPath)
const iconsTopModel = await prepareSource(iconsTopPath, iconsTopContent, 'icons-top', iconsTopStat)
// frame.icons=top should force icons on the plain list at top level
assert(iconsTopModel.fullHtml.includes('class="fl-icon"') || iconsTopModel.fullHtml.includes('fl-icon fl-num'), 'SD-10: {icons=top} forces top-level icons on any list')
// No sub-icons in HTML body (top level only) — strip <style> to avoid CSS class name match
const iconsTopBodyOnly = iconsTopModel.fullHtml.replace(/<style[\s\S]*?<\/style>/g, '')
assert(!iconsTopBodyOnly.includes('fl-sub-icon'), 'SD-10: {icons=top} does not produce sub-bullet icons')

// --- Task 6 SD-9: annotated list with leads of DIFFERING length → single shared-axis grid ---
// The ul gets fl-annotated; each li should have fl-lead and fl-ann children (not fl-has-aside).
// ONE parent grid means display:contents on each li lifts lead+ann into the shared column-1 axis.
const annotatedPath = join(dir, 'annotated-test.md')
const annotatedContent = [
  '# Annotated Test Deck',
  '',
  '## Section',
  '',
  '### How a session goes {annotated}',
  '',
  '- Plan',
  '  - agree the design before any code is written',
  '- Execute',
  '  - it does the work in the repo',
  '- Review and ship',
  '  - I read the diff and we install',
].join('\n')
writeFileSync(annotatedPath, annotatedContent, 'utf8')
const annotatedStat = statSync(annotatedPath)
const annotatedModel = await prepareSource(annotatedPath, annotatedContent, 'annotated-test', annotatedStat)
// Strip <style> to check only HTML markup
const annotatedBody = annotatedModel.fullHtml.replace(/<style[\s\S]*?<\/style>/g, '')
// The feature-list must carry fl-annotated
assert(annotatedBody.includes('class="feature-list fl-annotated"'), 'SD-9: feature-list has fl-annotated class')
// Each item must carry fl-lead (the column-1 lead) and fl-ann (the column-2 annotation)
assert(annotatedBody.includes('class="fl-lead"'), 'SD-9: fl-lead present (column-1 label span)')
// Existing test has single-child leads → fl-ann inline spans (not fl-sublist)
assert(annotatedBody.includes('class="fl-ann"'), 'SD-9: fl-ann present (single-child leads use inline span)')
// fl-has-aside must NOT appear (old per-item card structure removed)
assert(!annotatedBody.includes('fl-has-aside'), 'SD-9: fl-has-aside absent in new single-grid structure')
// fl-wide must NOT appear (would override the shared-axis grid-template-columns)
assert(!annotatedBody.includes('fl-wide'), 'SD-9: fl-wide absent in annotated list')

// --- SD-9 fix: multi-child annotated → fl-sublist (not " · " join) ---
const annotatedMultiPath = join(dir, 'annotated-multi-test.md')
const annotatedMultiContent = [
  '# Annotated Multi-Child Test',
  '',
  '## Section',
  '',
  '### Session stages {annotated}',
  '',
  '- Plan',
  '  - agree the design before any code is written',
  '  - read the existing codebase first',
  '- Execute',
  '  - it does the work',
  '  - tests pass before commit',
  '- Review and ship',
  '  - read the diff',
  '  - install and verify',
].join('\n')
writeFileSync(annotatedMultiPath, annotatedMultiContent, 'utf8')
const annotatedMultiStat = statSync(annotatedMultiPath)
const annotatedMultiModel = await prepareSource(annotatedMultiPath, annotatedMultiContent, 'annotated-multi-test', annotatedMultiStat)
const annotatedMultiBody = annotatedMultiModel.fullHtml.replace(/<style[\s\S]*?<\/style>/g, '')
// Multi-child: must have a fl-sublist (not a " · "-joined fl-ann)
assert(annotatedMultiBody.includes('class="fl-sublist"'), 'SD-9 multi-child: fl-sublist present in annotation col')
// Must have multiple <li> inside fl-sublist (not collapsed to one)
const multiLiMatches = [...annotatedMultiBody.matchAll(/<ul class="fl-sublist[^"]*"[^>]*>[\s\S]*?<\/ul>/g)]
assert(multiLiMatches.length > 0, 'SD-9 multi-child: at least one fl-sublist found')
// fl-sublist must contain multiple <li>
assert((annotatedMultiBody.match(/<li>/g) || []).length > 3, 'SD-9 multi-child: multiple <li> present (leads + sub-bullets)')
// Must NOT join with " · " inside fl-sublist or fl-ann elements (the old wrong behaviour).
// Use greedy regex to extract the full feature-list block (from opening <ul> to final </ul>).
const featureListMatch = annotatedMultiBody.match(/<ul class="feature-list fl-annotated"[\s\S]*<\/ul>/)
const featureListSection = featureListMatch ? featureListMatch[0] : ''
assert(!featureListSection.includes(' · '), 'SD-9 multi-child: no " · " join inside feature-list markup')
for (const line of [
  'agree the design before any code is written',
  'read the existing codebase first',
  'it does the work',
  'tests pass before commit',
  'read the diff',
  'install and verify'
]) {
  assert(featureListSection.includes(`<span class="fl-subtext">${line}</span>`), `SD-9 multi-child: preserves annotation line "${line}" in compiled markup`)
}

// --- {timeline=dynamic}: every event list item is registered as a runtime reveal/focus unit ---
const dynamicTimelinePath = join(dir, 'timeline-dynamic-test.md')
const dynamicTimelineContent = [
  '# Dynamic Timeline Test',
  '',
  '## Section',
  '',
  '### Project history {timeline=dynamic}',
  '',
  '- 2024 — Discovery',
  '  - First detail card',
  '- 2025 — Delivery',
  '  - Second detail card',
].join('\n')
writeFileSync(dynamicTimelinePath, dynamicTimelineContent, 'utf8')
const dynamicTimelineModel = await prepareSource(dynamicTimelinePath, dynamicTimelineContent, 'timeline-dynamic-test', statSync(dynamicTimelinePath))
const dynamicTimelineBody = dynamicTimelineModel.fullHtml.replace(/<style[\s\S]*?<\/style>/g, '')
assert(dynamicTimelineBody.includes('class="timeline timeline-dynamic"'), 'timeline dynamic: compiled fixture uses dynamic renderer')
assert((dynamicTimelineBody.match(/class="tl-dyn-entries"/g) || []).length === 2, 'timeline dynamic: compiled fixture emits one tl-dyn event list per event')
assert(dynamicTimelineBody.includes('".timeline .tl-dyn-entries > li"'), 'timeline dynamic: runtime registers each event li in MODE_SELECTOR')

// --- SD-9 fix: single-child annotated → single inline fl-ann (original look preserved) ---
const annotatedSinglePath = join(dir, 'annotated-single-test.md')
const annotatedSingleContent = [
  '# Annotated Single-Child Test',
  '',
  '## Section',
  '',
  '### Session stages {annotated}',
  '',
  '- Plan',
  '  - agree the design before any code',
  '- Execute',
  '  - do the work',
  '- Ship',
  '  - install and verify',
].join('\n')
writeFileSync(annotatedSinglePath, annotatedSingleContent, 'utf8')
const annotatedSingleStat = statSync(annotatedSinglePath)
const annotatedSingleModel = await prepareSource(annotatedSinglePath, annotatedSingleContent, 'annotated-single-test', annotatedSingleStat)
const annotatedSingleBody = annotatedSingleModel.fullHtml.replace(/<style[\s\S]*?<\/style>/g, '')
// Single child: must use inline fl-ann span (not a sub-list)
assert(annotatedSingleBody.includes('class="fl-ann"'), 'SD-9 single-child: fl-ann inline span present')
// Must NOT produce a fl-sublist for single-child annotations
assert(!annotatedSingleBody.includes('class="fl-sublist"'), 'SD-9 single-child: no fl-sublist for single-child annotations')

// --- Task 6 SD-16: statement + list → .stmt-list with .stmt column not stretched ---
const stmtListPath = join(dir, 'stmt-list-test.md')
const stmtListContent = [
  '# StmtList Test Deck',
  '',
  '## Section',
  '',
  '### The cost-benefit question {stmt-list}',
  '',
  'Is the time you save worth the time you spend reviewing?',
  '',
  '- Yes for repetitive, well-specified work',
  '- Break-even on one-off scripts',
  '- A clear win when you\'d plan anyway',
].join('\n')
writeFileSync(stmtListPath, stmtListContent, 'utf8')
const stmtListStat = statSync(stmtListPath)
const stmtListModel = await prepareSource(stmtListPath, stmtListContent, 'stmt-list-test', stmtListStat)
const stmtListBody = stmtListModel.fullHtml.replace(/<style[\s\S]*?<\/style>/g, '')
// Must have .stmt-list container
assert(stmtListBody.includes('class="stmt-list"'), 'SD-16: .stmt-list container present')
// Must have .stmt column (the claim)
assert(stmtListBody.includes('class="stmt"'), 'SD-16: .stmt column present')
// Must have .list-side column (the support list)
assert(stmtListBody.includes('class="list-side"'), 'SD-16: .list-side column present')
// Layout must be stamped as stmt-list
assert(stmtListModel.fullHtml.includes('data-layout="stmt-list"'), 'SD-16: data-layout="stmt-list" on slide section')
// The statement text must appear in the .stmt column (check it's inside the wrapper)
assert(stmtListBody.includes('Is the time you save'), 'SD-16: statement text rendered inside .stmt-list')

// --- I1 (Wave-1 review): {title=side} on a TITLE_TOP_LAYOUTS layout → data-title-layout="left" AND data-title-style="sidebar" ---
// {columns} is not in TITLE_LEFT_LAYOUTS so titlePlacementFor returns mode="" by default.
// The I1 guard must override mode to "left" so the rail is stamped on ANY layout.
const i1ColumnsPath = join(dir, 'i1-columns-title-side.md')
const i1ColumnsContent = [
  '# I1 Test Deck',
  '',
  '## Section',
  '',
  '### Columns slide with rail {columns}{title=side}',
  '',
  '- left item one',
  '- left item two',
  '',
  '- right item one',
  '- right item two',
].join('\n')
writeFileSync(i1ColumnsPath, i1ColumnsContent, 'utf8')
const i1ColumnsStat = statSync(i1ColumnsPath)
const i1ColumnsModel = await prepareSource(i1ColumnsPath, i1ColumnsContent, 'i1-columns-title-side', i1ColumnsStat)
assert(i1ColumnsModel.fullHtml.includes('data-title-layout="left"'), 'I1: {columns}{title=side} → data-title-layout="left" (rail forced on TITLE_TOP_LAYOUTS layout)')
assert(i1ColumnsModel.fullHtml.includes('data-title-style="sidebar"'), 'I1: {columns}{title=side} → data-title-style="sidebar"')

// --- ADR-0022 carousel: #### sub-slides must carry data-fragment so plain Next/arrow stepping
// works. The runtime's next()/previous() count [data-fragment] units to decide how many in-slide
// steps precede crossing to the next slide. Every sub-slide EXCEPT the first must be a fragment
// (the first is visible on arrival as active-card). Regression: without it, fragments().length was
// 0 and "Next" jumped straight past the carousel to the next slide (reveal/focus modes still
// stepped because they walk the [data-exclusive] gallery directly). ---
const carouselPath = join(dir, 'carousel.md')
const carouselContent = [
  '# Carousel Test Deck',
  '',
  '## Section',
  '',
  '### Parent slide {carousel}',
  '',
  '#### First & foremost {id=carousel-child}',
  '',
  'Card one.',
  '',
  '#### Second "quoted" card {id=carousel-child}',
  '',
  'Card two.',
  '',
  '#### Third card',
  '',
  'Card three.',
].join('\n')
writeFileSync(carouselPath, carouselContent, 'utf8')
const carouselModel = await prepareSource(carouselPath, carouselContent, 'carousel', statSync(carouselPath))
const carouselBody = carouselModel.fullHtml.replace(/<style[\s\S]*?<\/style>/g, '')
const carouselSection = carouselBody.match(/<section class="slide"[^>]*data-carousel[\s\S]*?<\/section>/)?.[0] ?? ''
const carouselCards = carouselSection.match(/<div class="card carousel-subslide[^"]*"[^>]*>/g) ?? []
const carouselFragments = (carouselSection.match(/data-fragment/g) ?? []).length
const carouselBeats = carouselModel.beats.filter((beat) => beat.slideId === carouselModel.slides.find((slide) => slide.layout === 'carousel')?.id || beat.context?.container === 'carousel')
assert(carouselCards.length === 3, `ADR-0022 carousel: 3 sub-slide cards rendered (got ${carouselCards.length})`)
assert(!/data-fragment/.test(carouselCards[0] ?? ''), 'ADR-0022 carousel: first sub-slide is NOT a fragment (active-card on arrival)')
assert(carouselFragments === carouselCards.length - 1, `ADR-0022 carousel: every sub-slide except the first carries data-fragment so Next steps the carousel (got ${carouselFragments}, expected ${carouselCards.length - 1})`)
assert(carouselCards[0]?.includes('data-sub-title="First &amp; foremost"') && carouselCards[0]?.includes('data-sub-index="0"'), 'ADR-0022 carousel: first child carries escaped title and index 0')
assert(carouselCards[1]?.includes('data-sub-title="Second &quot;quoted&quot; card"') && carouselCards[1]?.includes('data-sub-index="1"'), 'ADR-0022 carousel: second child carries escaped title and index 1')
assert(carouselCards[2]?.includes('data-sub-title="Third card"') && carouselCards[2]?.includes('data-sub-index="2"'), 'ADR-0022 carousel: third child carries title and index 2')
assert(carouselBeats.length === 3, `ADR-0022 carousel: exactly three addressable child beats emitted (got ${carouselBeats.length})`)
assert(JSON.stringify(carouselBeats.map((beat) => beat.slideId)) === JSON.stringify(['carousel-child', 'carousel-child-2', 'third-card']), 'ADR-0022 carousel: child beats retain ordered, deduped canonical authored ids')
assert(JSON.stringify(carouselBeats.map((beat) => beat.context)) === JSON.stringify([
  { container: 'carousel', sectionId: carouselModel.slides.find((slide) => slide.layout === 'carousel')?.id, index: 0, count: 3 },
  { container: 'carousel', sectionId: carouselModel.slides.find((slide) => slide.layout === 'carousel')?.id, index: 1, count: 3 },
  { container: 'carousel', sectionId: carouselModel.slides.find((slide) => slide.layout === 'carousel')?.id, index: 2, count: 3 },
]), 'ADR-0022 carousel: child beats retain ordered carousel context')

// A section-level {carousel} owns its child slides: the section and all children compile as ONE
// stepped slide, with each child becoming one full sub-slide in the data-exclusive container.
const sectionCarouselPath = join(dir, 'section-carousel.md')
const sectionCarouselContent = [
  '---',
  'auto_title_slide: false',
  'auto_thanks_slide: false',
  '---',
  '',
  '# Section Carousel Test Deck',
  '',
  '## Three views {carousel}',
  '',
  '### List view',
  '',
  '- One',
  '- Two',
  '',
  '### Image view',
  '',
  '![](assets/sample-image.png)',
  '',
  '### Final view',
  '',
  '- Three',
  '- Four',
].join('\n')
writeFileSync(sectionCarouselPath, sectionCarouselContent, 'utf8')
const sectionCarouselModel = await prepareSource(
  sectionCarouselPath,
  sectionCarouselContent,
  'section-carousel',
  statSync(sectionCarouselPath)
)
const sectionCarouselSlides = sectionCarouselModel.slides.filter((slide) => !slide.synthetic)
const sectionCarouselSlide = sectionCarouselSlides[0]
assert(sectionCarouselSlides.length === 1, `section {carousel}: parent and three children fold to ONE slide (got ${sectionCarouselSlides.length})`)
assert(sectionCarouselSlide?.layout === 'carousel', `section {carousel}: folded parent resolves to carousel layout (got ${sectionCarouselSlide?.layout ?? 'none'})`)
assert(sectionCarouselSlide?.carousel?.length === 3, `section {carousel}: three children become three carousel cards (got ${sectionCarouselSlide?.carousel?.length ?? 0})`)
const sectionCarouselHtml = sectionCarouselModel.fullHtml.replace(/<style[\s\S]*?<\/style>/g, '')
assert(/class="card-gallery[^"]*"[^>]*data-exclusive/.test(sectionCarouselHtml), 'section {carousel}: cards render in data-exclusive stepping container')

// --- B3 embed interaction: a covered (non-video) embed carries the opt-in "Interact" chip so the
// runtime can flip it from a pointer-events:none preview to an interactive frame; a VIDEO embed
// must NOT get the chip (videos stay clickable/playable). Bare URLs embed via the carousel path. ---
const embedChipPath = join(dir, 'embed-chip.md')
const embedChipContent = [
  '# Embed Chip Deck',
  '',
  '## Section',
  '',
  '### Demos',
  '',
  '#### Slides',
  '- a',
  '',
  '#### Site demo',
  'https://agent-demos.pages.dev',
  '',
  '#### Video demo',
  'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
].join('\n')
writeFileSync(embedChipPath, embedChipContent, 'utf8')
const embedChipModel = await prepareSource(embedChipPath, embedChipContent, 'embed-chip', statSync(embedChipPath))
const embedChipBody = embedChipModel.fullHtml.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<script[\s\S]*?<\/script>/g, '')
const embedFigures = embedChipBody.match(/<figure class="slide-embed[\s\S]*?<\/figure>/g) ?? []
const siteFigure = embedFigures.find((f) => !/slide-embed-video/.test(f)) ?? ''
const videoFigure = embedFigures.find((f) => /slide-embed-video/.test(f)) ?? ''
assert(/class="embed-interact-chip"/.test(siteFigure), 'B3: non-video embed carries an Interact chip')
assert(videoFigure !== '' && !/embed-interact-chip/.test(videoFigure), 'B3: video embed does NOT carry an Interact chip')
assert((embedChipBody.match(/embed-interact-chip/g) ?? []).length === 1, 'B3: exactly one Interact chip (site embed only, not the video)')

// --- Task 3: frontmatter `warn-at:` / `urgent-at:` → data-warn-at / data-urgent-at on <main class="deck"> ---
const warnAtPath = join(dir, 'warn-at.md')
const warnAtContent = [
  '---',
  'title: Warn At Deck',
  'warn-at: 8',
  '---',
  '',
  '### Opening slide',
  '',
  '- alpha',
].join('\n')
writeFileSync(warnAtPath, warnAtContent, 'utf8')
const warnAtModel = await prepareSource(warnAtPath, warnAtContent, 'warn-at', statSync(warnAtPath))
assert(warnAtModel.fullHtml.includes('data-warn-at="8"'), 'Task 3: frontmatter warn-at: 8 stamps data-warn-at="8"')
assert(warnAtModel.fullHtml.includes('data-urgent-at="1"'), 'Task 3: urgent-at defaults to 1 when unset')

// --- Task 3: no frontmatter override → hardcoded 5/1 default ---
const timerDefaultPath = join(dir, 'timer-default.md')
const timerDefaultContent = [
  '# Timer Default Deck',
  '',
  '### Opening slide',
  '',
  '- alpha',
].join('\n')
writeFileSync(timerDefaultPath, timerDefaultContent, 'utf8')
const timerDefaultModel = await prepareSource(timerDefaultPath, timerDefaultContent, 'timer-default', statSync(timerDefaultPath))
assert(timerDefaultModel.fullHtml.includes('data-warn-at="5"'), 'Task 3: no frontmatter/config → data-warn-at="5"')
assert(timerDefaultModel.fullHtml.includes('data-urgent-at="1"'), 'Task 3: no frontmatter/config → data-urgent-at="1"')

// --- Task 3: Settings global default (5th prepareSource arg) is used when frontmatter is absent ---
const timerGlobalPath = join(dir, 'timer-global.md')
const timerGlobalContent = [
  '# Timer Global Default Deck',
  '',
  '### Opening slide',
  '',
  '- alpha',
].join('\n')
writeFileSync(timerGlobalPath, timerGlobalContent, 'utf8')
const timerGlobalModel = await prepareSource(
  timerGlobalPath, timerGlobalContent, 'timer-global', statSync(timerGlobalPath),
  { warnAtMinutes: 10, urgentAtMinutes: 3 }
)
assert(timerGlobalModel.fullHtml.includes('data-warn-at="10"'), 'Task 3: Settings global default (10) used when frontmatter absent')
assert(timerGlobalModel.fullHtml.includes('data-urgent-at="3"'), 'Task 3: Settings global default (3) used when frontmatter absent')

// --- Task 3: frontmatter overrides the Settings global default ---
const timerOverridePath = join(dir, 'timer-override.md')
const timerOverrideContent = [
  '---',
  'title: Timer Override Deck',
  'warn-at: 8',
  '---',
  '',
  '### Opening slide',
  '',
  '- alpha',
].join('\n')
writeFileSync(timerOverridePath, timerOverrideContent, 'utf8')
const timerOverrideModel = await prepareSource(
  timerOverridePath, timerOverrideContent, 'timer-override', statSync(timerOverridePath),
  { warnAtMinutes: 10, urgentAtMinutes: 3 }
)
assert(timerOverrideModel.fullHtml.includes('data-warn-at="8"'), 'Task 3: frontmatter warn-at overrides Settings global default')
assert(timerOverrideModel.fullHtml.includes('data-urgent-at="3"'), 'Task 3: Settings global default urgent-at (3) still applies when only warn-at is overridden')

// --- Task 3: urgent-at is clamped so it never exceeds warn-at ---
const timerClampPath = join(dir, 'timer-clamp.md')
const timerClampContent = [
  '---',
  'title: Timer Clamp Deck',
  'warn-at: 3',
  'urgent-at: 8',
  '---',
  '',
  '### Opening slide',
  '',
  '- alpha',
].join('\n')
writeFileSync(timerClampPath, timerClampContent, 'utf8')
const timerClampModel = await prepareSource(timerClampPath, timerClampContent, 'timer-clamp', statSync(timerClampPath))
assert(timerClampModel.fullHtml.includes('data-warn-at="3"'), 'Task 3 clamp: warn-at stays 3')
assert(timerClampModel.fullHtml.includes('data-urgent-at="3"'), 'Task 3 clamp: urgent-at (8) clamped down to warn-at (3), never exceeds it')
assert(!timerClampModel.fullHtml.includes('data-urgent-at="8"'), 'Task 3 clamp: unclamped urgent-at="8" must NOT appear')

// --- Task 5: beats embedded in the compiled HTML (window.__deckBeats) ---
// The presenter runtime navigates by beat index, so the compiled single-file HTML must carry the
// sequencer's beat list verbatim (angle brackets unicode-escaped against early </script> close).
{
  const expectedBeats = `<script>window.__deckBeats=${JSON.stringify(spineGridModel.beats || []).replace(/</g, '\\u003c')};</script>`
  assert(spineGridModel.fullHtml.includes(expectedBeats), 'Task 5: compiled HTML embeds window.__deckBeats with the model beat list')
  assert(!spineGridModel.fullHtml.includes('<!--BEATS_JSON-->'), 'Task 5: BEATS_JSON placeholder is consumed by the build')
}

// --- Task 5: container triggers are registered vocabulary (warning-clean compiles) ---
const containerTriggerPath = join(dir, 'container-triggers.md')
const containerTriggerContent = [
  '---',
  'title: Container Trigger Deck',
  'auto_title_slide: false',
  'auto_thanks_slide: false',
  '---',
  '',
  '## Linear grid {grid-linear id=gl}',
  '',
  '### GL child one {id=gl-a}',
  '',
  '### GL child two {id=gl-b}',
  '',
  '## Contents hub {contents id=hub}',
  '',
  '### Hub child {id=hub-a}',
].join('\n')
writeFileSync(containerTriggerPath, containerTriggerContent, 'utf8')
const containerTriggerModel = await prepareSource(containerTriggerPath, containerTriggerContent, 'container-triggers', statSync(containerTriggerPath))
const containerUnknowns = (containerTriggerModel.warnings || []).filter((w) =>
  w === 'unknown-trigger:grid-linear' || w === 'unknown-trigger:grid-zoom' || w === 'unknown-trigger:contents')
assert(containerUnknowns.length === 0, `Task 5: {grid-linear}/{contents} emit no unknown-trigger warnings (${containerUnknowns.join(', ') || 'clean'})`)
assert(!(spineGridModel.warnings || []).includes('unknown-trigger:grid-zoom'), 'Task 5: {grid-zoom} emits no unknown-trigger warning')
assert(
  containerTriggerModel.beats.map((b) => `${b.kind}:${b.slideId}`).join(' ') === 'grid:gl slide:gl-a slide:gl-b slide:hub slide:hub-a',
  `Task 5: container triggers still drive the sequencer (${containerTriggerModel.beats.map((b) => `${b.kind}:${b.slideId}`).join(' ')})`
)

if (failures > 0) {
  console.error(`\n${failures} test(s) FAILED`)
  process.exit(1)
}
console.log('\nAll smoke tests PASSED')
