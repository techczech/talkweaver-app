import { strict as assert } from 'node:assert'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { buildLayoutSampler } from './build-layout-sampler.mjs'

// Ticket 18: the default type scale is the former XL and long lists spend leading and air before type.
const LIST_IDS = ['t18-list-4', 't18-list-12', 't18-list-grouped', 't18-list-keyvalue']
const LADDER_ID = 'font-body-per-slide-type-override'
const VIEWPORTS = [
  { width: 1600, height: 900 },
  { width: 1280, height: 720 },
  // A shorter band at full width: the twelve-item list must step its leading at runtime here.
  { width: 1600, height: 800 }
]
const BODY_CQW = 3.2
const RAIL_CQW = 3.8
const TITLE_CQW = 5.2
const FLOOR_PX_AT_1600 = 31

const { html, outPath } = await buildLayoutSampler()
for (const id of [...LIST_IDS, LADDER_ID]) {
  assert(html.includes(`data-id="${id}"`), `${id}: sampler fixture compiles`)
}
const section = (id) => html.match(new RegExp(`<section class="slide"[^>]*data-id="${id}"[\\s\\S]*?</section>`))?.[0] ?? ''
assert(/<ul class="feature-list[^"]*"[^>]*data-list-density="long"/.test(section('t18-list-12')), 'a twelve-item list is stamped long at compile time')
assert(!/data-list-density=/.test(section('t18-list-4')), 'a four-item list carries no density stamp')

const browser = await chromium.launch({ headless: true })
try {
  for (const viewport of VIEWPORTS) {
    const page = await browser.newPage({ viewport })
    await page.goto(pathToFileURL(outPath).href, { waitUntil: 'load' })
    await page.evaluate(() => document.fonts?.ready)
    const measure = async (slideId, stripDensity = false) => page.evaluate(([id, strip]) => {
      const slides = [...document.querySelectorAll('.stage > .slide')]
      const slide = slides.find((candidate) => candidate.dataset.id === id)
      if (!slide) return null
      slides.forEach((candidate) => candidate.classList.toggle('active', candidate === slide))
      if (strip) slide.querySelectorAll('[data-list-density]').forEach((list) => delete list.dataset.listDensity)
      window.__autofitForTest?.()
      const content = slide.querySelector('.slide-content')
      const stage = slide.parentElement
      const token = (name) => {
        const probe = document.createElement('span')
        probe.style.cssText = `position:absolute;visibility:hidden;font-size:var(${name})`
        content.append(probe)
        const value = parseFloat(getComputedStyle(probe).fontSize)
        probe.remove()
        return value
      }
      const items = [...content.querySelectorAll('.feature-list > li')]
      const subItems = [...content.querySelectorAll('.fl-sublist > li')]
      const slideStyle = getComputedStyle(slide)
      const availableHeight = slide.clientHeight - parseFloat(slideStyle.paddingTop) - parseFloat(slideStyle.paddingBottom)
      let unionTop = Infinity
      let unionBottom = -Infinity
      for (const child of content.children) {
        const rect = child.getBoundingClientRect()
        if (rect.height <= 0) continue
        unionTop = Math.min(unionTop, rect.top)
        unionBottom = Math.max(unionBottom, rect.bottom)
      }
      const naturalHeight = unionBottom - unionTop
      const first = items[0]
      const firstStyle = first ? getComputedStyle(first) : null
      const h1 = slide.querySelector('h1:not(.sr-only)')
      const list = content.querySelector('.feature-list')
      const listRect = list?.getBoundingClientRect()
      const stageRect = stage.getBoundingClientRect()
      return {
        id,
        stageWidth: stage.clientWidth,
        titleLayout: slide.dataset.titleLayout,
        bodyToken: token('--fs-body'),
        railToken: token('--fs-rail'),
        titleToken: token('--fs-title'),
        h1Font: h1 ? parseFloat(getComputedStyle(h1).fontSize) : null,
        itemFonts: items.map((item) => parseFloat(getComputedStyle(item).fontSize)),
        subItemFonts: subItems.map((item) => parseFloat(getComputedStyle(item).fontSize)),
        lineHeightRatio: firstStyle ? parseFloat(firstStyle.lineHeight) / parseFloat(firstStyle.fontSize) : null,
        listFit: content.dataset.listFit || null,
        zoom: Number(getComputedStyle(content).zoom || 1),
        overflowPx: naturalHeight - availableHeight,
        topAirPx: listRect ? listRect.top - stageRect.top : null,
        bottomAirPx: listRect ? stageRect.bottom - listRect.bottom : null
      }
    }, [slideId, stripDensity])

    const scale = viewport.width / 1600
    const floor = FLOOR_PX_AT_1600 * scale
    const near = (actual, expected, label) => assert(Math.abs(actual - expected) < 0.6, `${viewport.width}: ${label} ${actual.toFixed(2)}px ≈ ${expected.toFixed(2)}px`)

    const four = await measure('t18-list-4')
    assert(four, 'four-item fixture renders')
    console.log(JSON.stringify({ viewport, four }))
    near(four.bodyToken, four.stageWidth * BODY_CQW / 100, 'default body token is 3.2cqw of the stage')
    assert(four.itemFonts.length === 4, 'four items render')
    four.itemFonts.forEach((px, index) => near(px, four.stageWidth * BODY_CQW / 100, `item ${index + 1} body font`))
    near(four.railToken, Math.max(38, four.stageWidth * RAIL_CQW / 100), 'default rail token')
    near(four.titleToken, Math.max(44, four.stageWidth * TITLE_CQW / 100), 'default title token')
    assert.equal(four.titleLayout, 'left', 'a plain list keeps the sidebar title')
    assert(four.h1Font <= four.railToken + 0.6 && four.h1Font >= floor, `sidebar title renders at or under the rail token (${four.h1Font}px)`)
    // Ticket 21 gives the sidebar column max(6vh, 61px) above and below and a wider rail gap
    // (stage.css @order 1341), so on the short 1600x800 band four two-line rows spend leading —
    // never air or type; at 16:9 they still need no fitting.
    const shortBand = viewport.height / viewport.width < 0.55
    if (shortBand) assert(['base', 'leading'].includes(four.listFit) && four.lineHeightRatio >= 1.18, `a short list on a short band spends leading only (${four.listFit}, ${four.lineHeightRatio.toFixed(3)})`)
    else {
      near(four.lineHeightRatio, 1.35, 'a short list keeps the default leading')
      assert.equal(four.listFit, 'base', 'a short list needs no fitting')
    }
    assert.equal(four.zoom, 1, 'a short list is never zoomed')
    assert(four.overflowPx <= 1, 'a short list fits its band')
    assert(Math.abs(four.topAirPx - four.bottomAirPx) <= 8, `a short list is centred on the vertical axis (${four.topAirPx.toFixed(1)} vs ${four.bottomAirPx.toFixed(1)})`)

    const twelve = await measure('t18-list-12')
    console.log(JSON.stringify({ viewport, twelve }))
    assert.equal(twelve.itemFonts.length, 12, 'twelve items render')
    assert(twelve.lineHeightRatio < 1.3, `a twelve-item list compresses its leading (${twelve.lineHeightRatio.toFixed(3)} < 1.3)`)
    assert(twelve.itemFonts.every((px) => px >= floor - 0.01), `twelve-item type never falls below the floor (${Math.min(...twelve.itemFonts).toFixed(1)}px ≥ ${floor.toFixed(1)}px)`)
    // On the short 1600x800 band (Ticket 21's max(6vh, 61px) column padding) twelve items spend a
    // couple of pixels of type after leading and air; at 16:9 leading and air still suffice.
    if (shortBand) assert(twelve.listFit !== 'too-long' && twelve.itemFonts[0] >= twelve.bodyToken - 3, `a twelve-item list on a short band steps type by at most 3px (${twelve.listFit}, ${twelve.itemFonts[0]}px)`)
    else assert(!['type', 'too-long'].includes(twelve.listFit), `a twelve-item list fits by leading and air, not type (${twelve.listFit})`)
    assert(twelve.overflowPx <= 1, `a twelve-item list does not overflow its band (${twelve.overflowPx.toFixed(1)}px)`)
    assert.equal(twelve.zoom, 1, 'list fitting prevents whole-slide zoom')
    assert(twelve.topAirPx >= 0 && twelve.bottomAirPx >= 0, 'the fitted list keeps its top and bottom margins')

    // Without the compile-time stamp the runtime alone must find the fit — by leading and air, never type.
    const runtimeOnly = await measure('t18-list-12', true)
    console.log(JSON.stringify({ viewport, runtimeOnly }))
    assert(runtimeOnly.overflowPx <= 1, `runtime-only fit does not overflow (${runtimeOnly.overflowPx.toFixed(1)}px)`)
    if (shortBand) {
      assert(['leading', 'gap', 'type'].includes(runtimeOnly.listFit), `a short band forces the runtime to step (${runtimeOnly.listFit})`)
      assert(runtimeOnly.itemFonts.every((px) => px >= runtimeOnly.bodyToken - 3), 'runtime-only fit on a short band steps type by at most 3px')
    } else {
      assert(['base', 'leading', 'gap'].includes(runtimeOnly.listFit), `runtime-only fit spends leading and air, not type (${runtimeOnly.listFit})`)
      assert(runtimeOnly.itemFonts.every((px) => Math.abs(px - runtimeOnly.bodyToken) < 0.6), 'runtime-only fit leaves type at the body token')
    }

    for (const id of ['t18-list-grouped', 't18-list-keyvalue']) {
      const nested = await measure(id)
      console.log(JSON.stringify({ viewport, nested }))
      assert(nested.subItemFonts.length >= 4, `${id}: nested items render`)
      nested.subItemFonts.forEach((px) => near(px, nested.bodyToken, `${id} nested item takes the body token`))
      assert(nested.itemFonts.every((px) => px >= nested.bodyToken - 0.6), `${id}: parent items never fall under the body token`)
      assert(nested.overflowPx <= 1, `${id}: fits its band (${nested.overflowPx.toFixed(1)}px)`)
      assert.equal(nested.zoom, 1, `${id}: no whole-slide zoom`)
    }

    const ladder = await measure(LADDER_ID)
    // The ladder is a stylesheet fact: read the token with the runtime fitter's inline step removed
    // (on the short band the three long items at L legitimately spend a couple of pixels of type).
    ladder.bodyToken = await page.evaluate(() => {
      const content = document.querySelector('.slide.active .slide-content')
      const inline = content.style.getPropertyValue('--fs-body')
      content.style.removeProperty('--fs-body')
      const probe = document.createElement('span')
      probe.style.cssText = 'position:absolute;visibility:hidden;font-size:var(--fs-body)'
      content.append(probe)
      const value = parseFloat(getComputedStyle(probe).fontSize)
      probe.remove()
      if (inline) content.style.setProperty('--fs-body', inline)
      return value
    })
    near(ladder.bodyToken, ladder.stageWidth * 3.5 / 100, '{font-body=l} is one step above the default')
    near(ladder.titleToken, Math.max(38, ladder.stageWidth * 4.4 / 100), '{font-title=s} is one step below the default')

    // Ticket 21 — the sidebar content column takes the mockup's padding (6vh above and below, 5cqw
    // from the rail) and grouped lists sit in a hairline rhythm; tables read at the body token as
    // their minimum, fill the content width, centre with equal air, and a crowded table steps
    // padding (--list-gap) and leading before type, never past the footer band.
    const grouped = await measure('t18-list-grouped')
    const groupedGeometry = await page.evaluate(() => {
      const slide = document.querySelector('.slide.active')
      const content = slide.querySelector('.slide-content')
      const list = content.querySelector(':scope > .feature-list')
      const items = [...list.querySelectorAll(':scope > li')]
      const px = (el, prop) => parseFloat(getComputedStyle(el)[prop])
      return {
        padTop: px(content, 'paddingTop'), padBottom: px(content, 'paddingBottom'), columnGap: px(content, 'columnGap'),
        listGap: px(list, 'rowGap'),
        rows: items.map((li) => ({ borderTop: px(li, 'borderTopWidth'), borderBottom: px(li, 'borderBottomWidth'), padTop: px(li, 'paddingTop'), font: px(li, 'fontSize') })),
        listLeft: list.getBoundingClientRect().left, railRight: slide.querySelector('.slide-head').getBoundingClientRect().right
      }
    })
    near(groupedGeometry.padTop, Math.max(viewport.height * 0.06, 61), 'sidebar content column has 6vh (never less than the footer band) above')
    near(groupedGeometry.padBottom, Math.max(viewport.height * 0.06, 61), 'sidebar content column has 6vh (never less than the footer band) below')
    near(groupedGeometry.columnGap, Math.min(96, Math.max(40, grouped.stageWidth * 0.05)), 'sidebar content column sits 5cqw from the rail')
    near(groupedGeometry.listLeft - groupedGeometry.railRight, groupedGeometry.columnGap, 'the list starts one column gap after the rail')
    assert.equal(groupedGeometry.listGap, 0, 'groups have no open row gap between them')
    assert(groupedGeometry.rows.every((row) => row.borderTop >= 1), 'a hairline separates every group')
    assert(groupedGeometry.rows.at(-1).borderBottom >= 1, 'a hairline closes the run')
    groupedGeometry.rows.forEach((row) => near(row.padTop, row.font * 0.5, 'a group has ~.5em above'))

    const measureTable = async (id) => {
      await page.goto(`${pathToFileURL(outPath).href}#${id}`, { waitUntil: 'load' })
      await page.evaluate(() => document.fonts?.ready)
      await page.evaluate(() => new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))))
      return page.evaluate((slideId) => {
        const slide = document.querySelector('.slide.active')
        if (!slide || slide.dataset.id !== slideId) return null
        const content = slide.querySelector('.slide-content')
        const table = content.querySelector('.slide-table')
        const head = slide.querySelector('.slide-head')
        const footer = document.querySelector('.footer')
        const px = (el, prop) => (el ? parseFloat(getComputedStyle(el)[prop]) : null)
        const cells = [...table.querySelectorAll('td, th')]
        const tableRect = table.getBoundingClientRect()
        return {
          stageWidth: slide.parentElement.clientWidth,
          listFit: content.dataset.listFit || null,
          zoom: Number(getComputedStyle(content).zoom || 1),
          cellFonts: cells.map((cell) => px(cell, 'fontSize')),
          cellPadTop: px(table.querySelector('td'), 'paddingTop'),
          columnBorders: cells.map((cell) => px(cell, 'borderLeftWidth')),
          hasThead: !!table.querySelector('thead'),
          rows: table.querySelectorAll('tr').length,
          tableWidth: tableRect.width, contentWidth: content.getBoundingClientRect().width,
          topAir: tableRect.top - head.getBoundingClientRect().bottom,
          bottomAir: footer.getBoundingClientRect().top - tableRect.bottom
        }
      }, id)
    }
    const bodyPx = grouped.stageWidth * BODY_CQW / 100
    const table = await measureTable('t21-table-noheader')
    assert(table, 'table fixture renders by deep link')
    console.log(JSON.stringify({ viewport, table }))
    assert(table.cellFonts.every((px) => Math.abs(px - bodyPx) < 0.6), `table cells read at the body token, 3.2cqw (${Math.min(...table.cellFonts).toFixed(1)}px vs ${bodyPx.toFixed(1)}px)`)
    assert(Math.abs(table.tableWidth - table.contentWidth) <= 1, 'the table fills the content width')
    assert(Math.abs(table.topAir - table.bottomAir) <= 4, `the table is centred with equal air (${table.topAir.toFixed(1)} vs ${table.bottomAir.toFixed(1)})`)
    assert(table.bottomAir >= -1, 'the table never runs under the footer band')
    assert.equal(table.hasThead, false, '{table-header=off} renders the first row as a plain row')
    assert.equal(table.rows, 3, 'all three authored rows render')
    assert(table.cellPadTop >= bodyPx * 0.45 * 0.64 - 0.5, 'row padding never falls under its .45em floor on the gap seam')
    assert.equal(table.zoom, 1, 'a three-row table is never zoomed')
    const plain = await measureTable('t21-table-plain')
    assert(plain.columnBorders.every((width) => width === 0), '{table-columns=off} draws no column rules')
    const gridded = await measureTable('t21-table-nocolumns')
    assert(gridded.hasThead && gridded.columnBorders.every((width) => width === 0), '{table-columns=off} keeps the header and drops the rules')
    const long = await measureTable('t21-table-long')
    assert(long.cellFonts.every((px) => px >= floor - 0.01), `a ten-row table never falls below the floor (${Math.min(...long.cellFonts).toFixed(1)}px)`)
    assert(long.cellFonts.every((px) => px < bodyPx), 'a ten-row table stepped its type after padding')
    assert(long.bottomAir >= -1, 'a ten-row table stays above the footer band')
    assert(long.cellPadTop < table.cellPadTop, 'a crowded table has tighter row padding than a short one')

    await page.close()
  }
} finally {
  await browser.close()
}

console.log('list sizing: PASS')
