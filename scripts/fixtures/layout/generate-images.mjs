import sharp from 'sharp'
import { writeFileSync, copyFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)))
const fixture = join(root, 'scripts/fixtures/layout')
const site = join(root, 'docs/assets')
const images = [
  { name: 'sample-image.png', width: 1600, height: 1000, colour: '#386b9a' },
  { name: 'slide_0010.webp', width: 1500, height: 844, colour: '#66805a' },
  { name: '07-minister-portrait.png', width: 1074, height: 1678, colour: '#a76a65' },
]

for (const { name, width, height, colour } of images) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="${colour}"/><circle cx="${Math.round(width / 2)}" cy="${Math.round(height / 2)}" r="${Math.round(Math.min(width, height) / 5)}" fill="#f7f3e9"/></svg>`
  const output = await sharp(Buffer.from(svg))[name.endsWith('.webp') ? 'webp' : 'png']().toBuffer()
  writeFileSync(join(fixture, name), output)
  copyFileSync(join(fixture, name), join(site, name))
  console.log(`${name}: ${width}x${height}`)
}
