// test:icon-svg-raster:dom — the icon picker's sanitiser (sanitiseIconSvg) in a real browser DOM with
// the real DOMPurify, on the compiler's own output (05-icons.mjs iconSvg, what icons:svg returns):
//   - every catalogue mark backed by an embedded raster (METR, Synthesia, Thinking Machines, Developer
//     Student Club, PowerToys, Open WebUI) passes and keeps its picture; Developer Student Club keeps
//     its <use> of the picture inside its own <defs>;
//   - SVG icons that reuse their own shapes with <use> (Ubuntu, the SVG logo) pass; a plain icon passes;
//   - every other reference is refused: external URL, SVG-in-image, a data URL outside <image>, <use>
//     of another document or of an id that is not in the picture, scripts and handlers.
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const root = fileURLToPath(new URL('..', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'talk-weaver-icon-svg-raster-'))
const outfile = join(dir, 'bundle.js')
let browser
try {
  await build({
    stdin: { contents: "import { sanitiseIconSvg } from './src/shared/objects/sanitise-icon-svg.ts'; window.sanitiseIconSvg = sanitiseIconSvg", resolveDir: root, loader: 'ts' },
    bundle: true, format: 'iife', outfile, logLevel: 'silent'
  })
  const icons = await import(pathToFileURL(join(root, 'compiler/scripts/lib/05-icons.mjs')).href)

  // Every catalogue entry whose picture is an embedded raster, found in the data (not a fixed list).
  const rasterKeys = []
  for (const file of ['svgl.json', 'extra.json']) {
    const data = JSON.parse(readFileSync(join(root, 'compiler/assets/icons', file), 'utf8'))
    for (const key of Object.keys(data)) if (/data:image\//.test(data[key]?.svg ?? '')) rasterKeys.push(`svgl:${key}`)
  }
  for (const key of ['svgl:metr', 'svgl:synthesia', 'svgl:thinking-machines', 'svgl:developer-student-club', 'svgl:powertoys', 'svgl:open-webui']) {
    assert.ok(rasterKeys.includes(key), `${key} is a raster-backed catalogue entry (${rasterKeys})`)
  }
  const catalogue = Object.fromEntries(rasterKeys.map((key) => [key, icons.iconSvg(key)]))
  for (const [key, svg] of Object.entries(catalogue)) assert.ok(svg && /data:image\//.test(svg), `the compiler returns ${key} with its raster`)
  const withUse = Object.fromEntries(['svgl:ubuntu', 'svgl:svg'].map((key) => [key, icons.iconSvg(key)]))
  for (const [key, svg] of Object.entries(withUse)) assert.ok(svg && /<use\b/.test(svg), `the compiler returns ${key} with <use>`)

  const plainSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M2 2h20v20H2z" fill="#3776ab"/></svg>'
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
  const xlink = 'xmlns:xlink="http://www.w3.org/1999/xlink"'
  const refused = {
    'external image URL': '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.example/x.png" width="1" height="1"/></svg>',
    'SVG inside an image': '<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" width="1" height="1"/></svg>',
    'raster data URL on a link': `<svg xmlns="http://www.w3.org/2000/svg"><a href="${png}"><rect width="1" height="1"/></a></svg>`,
    'raster data URL on use': `<svg xmlns="http://www.w3.org/2000/svg"><use href="${png}"/></svg>`,
    'external use href': '<svg xmlns="http://www.w3.org/2000/svg"><use href="https://evil.example/sprite.svg#icon"/></svg>',
    'external use xlink:href': `<svg xmlns="http://www.w3.org/2000/svg" ${xlink}><use xlink:href="sprite.svg#icon"/></svg>`,
    'use of an id not in the picture': `<svg xmlns="http://www.w3.org/2000/svg" ${xlink}><use xlink:href="#missing"/></svg>`,
    'use of itself': '<svg xmlns="http://www.w3.org/2000/svg"><use id="loop" href="#loop"/></svg>',
    'use with no href': '<svg xmlns="http://www.w3.org/2000/svg"><use/></svg>',
    'script beside a use': `<svg xmlns="http://www.w3.org/2000/svg" ${xlink}><path id="a" d="M0 0h1v1z"/><use xlink:href="#a"/><script>alert(1)</script></svg>`,
    'event handler on a use': `<svg xmlns="http://www.w3.org/2000/svg" ${xlink}><path id="a" d="M0 0h1v1z"/><use xlink:href="#a" onclick="alert(1)"/></svg>`,
    'script beside a raster': `<svg xmlns="http://www.w3.org/2000/svg"><image href="${png}" width="1" height="1"/><script>alert(1)</script></svg>`,
    'event handler on the image': `<svg xmlns="http://www.w3.org/2000/svg"><image href="${png}" onload="alert(1)" width="1" height="1"/></svg>`,
    'raster in CSS': `<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:url(${png})" width="1" height="1"/></svg>`,
    'a forged placeholder': '<svg xmlns="http://www.w3.org/2000/svg"><image href="#tw-raster-0" width="1" height="1"/></svg>'
  }

  browser = await chromium.launch()
  const page = await browser.newPage()
  await page.setContent('<!doctype html><body></body>')
  await page.addScriptTag({ path: outfile })
  const results = await page.evaluate(({ catalogue, withUse, plainSvg, refused }) => {
    const draw = (svg) => {
      const host = document.createElement('span')
      host.innerHTML = svg
      document.body.append(host)
      const images = Array.from(host.querySelectorAll('image')).map((image) => image.getAttribute('href') ?? image.getAttribute('xlink:href') ?? '')
      const uses = Array.from(host.querySelectorAll('use')).map((use) => use.getAttribute('href') ?? use.getAttribute('xlink:href') ?? '')
      const box = host.querySelector('svg')?.getBoundingClientRect()
      return { images, uses, paths: host.querySelectorAll('path').length, drawn: !!box && box.width > 0 && box.height > 0 }
    }
    const verdict = (svg) => {
      const result = window.sanitiseIconSvg(svg)
      return 'svg' in result ? { ok: true, ...draw(result.svg) } : { ok: false, error: result.error }
    }
    const sourceImages = (svg) => Array.from(svg.matchAll(/<image\b[^>]*?\s(?:xlink:)?href="([^"]+)"/g)).map((m) => m[1])
    const out = { catalogue: {}, withUse: {}, plain: verdict(plainSvg), refused: {} }
    for (const [key, svg] of Object.entries(catalogue)) out.catalogue[key] = { ...verdict(svg), source: sourceImages(svg), sourceUses: (svg.match(/<use\b/g) || []).length }
    for (const [key, svg] of Object.entries(withUse)) out.withUse[key] = { ...verdict(svg), sourceUses: (svg.match(/<use\b/g) || []).length }
    for (const [name, svg] of Object.entries(refused)) {
      const result = window.sanitiseIconSvg(svg)
      out.refused[name] = 'svg' in result ? `PASSED: ${result.svg}` : result.error
    }
    return out
  }, { catalogue, withUse, plainSvg, refused })

  for (const [key, result] of Object.entries(results.catalogue)) {
    assert.ok(result.ok, `${key}: catalogue raster mark passes (${result.error ?? ''})`)
    assert.ok(result.drawn, `${key}: drawn with a size`)
    assert.deepEqual(result.images, result.source, `${key}: every embedded picture kept, byte for byte`)
    assert.ok(result.images.every((href) => /^data:image\/(png|jpe?g|webp);base64,/.test(href)), `${key}: only raster data URLs on <image>`)
    assert.equal(result.uses.length, result.sourceUses, `${key}: its <use> elements kept`)
  }
  assert.deepEqual(results.catalogue['svgl:developer-student-club'].uses, ['#image0_245_1788'], 'Developer Student Club keeps its <use> of its own picture')
  for (const [key, result] of Object.entries(results.withUse)) {
    assert.ok(result.ok && result.drawn, `${key}: an icon reusing its own shapes passes (${result.error ?? ''})`)
    assert.equal(result.uses.length, result.sourceUses, `${key}: its <use> elements kept`)
    assert.ok(result.uses.every((href) => /^#/.test(href)), `${key}: every <use> points inside the picture`)
  }
  assert.ok(results.plain.ok && results.plain.paths === 1, `an ordinary SVG icon passes with its path (${JSON.stringify(results.plain)})`)
  for (const [name, outcome] of Object.entries(results.refused)) {
    assert.ok(!String(outcome).startsWith('PASSED'), `${name} is refused: ${outcome}`)
  }
  console.log(`icon svg raster: ${rasterKeys.length} raster-backed catalogue marks drawn from the compiler's output (${rasterKeys.join(', ')}), ${Object.keys(withUse).length} <use> icons drawn, plain SVG drawn, ${Object.keys(refused).length} unsafe shapes refused — passed`)
} finally {
  await browser?.close()
  rmSync(dir, { recursive: true, force: true })
}
