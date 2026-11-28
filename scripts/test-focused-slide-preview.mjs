import assert from 'node:assert/strict'
import { statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { findSlideSections } from '../compiler/scripts/lib/04-html-extraction.mjs'
import { ensurePresenterTemplate } from './build-deck-styles.mjs'

await ensurePresenterTemplate()
const path = fileURLToPath(new URL('../demo-vault/layout-sampler/layout-sampler-outline.md', import.meta.url))
const stat = statSync(path)
const outline = `---
outline_version: 2
auto_title_slide: false
palette: ocean
font: geist
title_look: tab-strip
---
## The first section {id=first}

### An earlier list {id=earlier} {iconlist}

- Open a folder
- Search the web

## The second section {id=second}

### Plain list {id=plain} {plainlist}

- Record this observation
- Check the next one

### Icon list {id=icons} {iconlist} {iconlist=list}

- Keep this record {icon=lucide:clipboard-check}
- Open the folder {icon=lucide:folder-open}

### Table {id=table} {table} {table-rows=bands}

| Day | Volunteers |
| --- | --- |
| Monday | 4 |

### Image {id=image}

A picture of the field.

![Sample](assets/sample-image.png)

### Inferred icons {id=inferred} {iconlist}

- Search the web
- Open a folder

### A building list {id=steps} {reveal}

- The first thing
- The second thing
`
const full = await prepareSource(path, outline, 'Context', stat)
const fullSlides = findSlideSections(full.fullHtml)
for (const slideId of ['plain', 'icons', 'table', 'image']) {
  const preview = await prepareSource(path, outline, 'Context', stat, undefined, { authoringSlide: { slideId } })
  assert.equal(preview.slideId, slideId)
  const sections = findSlideSections(preview.fullHtml)
  assert.equal(sections.length, 1, `${slideId} renders only its own slide`)
  assert.deepEqual(sections[0].html, fullSlides.find(section => section.html.includes(`data-id="${slideId}"`)).html,
    `${slideId} keeps the full deck's exact slide markup`)
  assert.ok(preview.fullHtml.includes('data-deck-font="geist"'))
}
for (const slideId of ['first', 'inferred', 'steps', 'absent']) {
  assert.ok(await prepareSource(path, outline, 'Context', stat, undefined, { authoringSlide: { slideId } }) === null,
    `${slideId} uses the full preview when it needs the deck runtime or its icon vocabulary`)
}
const legacyHeading = outline.replace('Plain list {id=plain}', 'A renamed list')
const headingLine = legacyHeading.split('\n').findIndex(line => line.startsWith('### A renamed list')) + 1
const renamed = await prepareSource(path, legacyHeading, 'Context', stat, undefined, { authoringSlide: { slideId: 'plain', headingLine } })
assert.equal(renamed.slideId, 'a-renamed-list')
assert.ok(findSlideSections(renamed.fullHtml)[0].html.includes('A renamed list'))
console.log('PASS focused preview renders only the selected slide with identical artwork')
