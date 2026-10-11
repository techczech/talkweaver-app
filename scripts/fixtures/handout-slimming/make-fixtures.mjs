// Makes the four pictures scripts/test-handout-slimming.mjs slims. Run once, by hand
// (`node scripts/fixtures/handout-slimming/make-fixtures.mjs`); the pictures are committed, and the
// sizes pinned in that test were measured on exactly these files. Running it again must give the
// same bytes: everything is drawn from a fixed seed, and nothing here reads a clock or a file.
//   screenshot.png  2880 x 1800  a slide-screenshot: flat panels, rules, a soft gradient (wider than
//                                every size limit, so each quality step also scales it down)
//   chart.png       1600 x 1000  flat colour bars on white with a little texture
//   photo.jpg       2000 x 1400  smooth noise, the way a photograph compresses
//   diagram.webp    1600 x 1200  a picture that is already WebP
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const here = dirname(fileURLToPath(import.meta.url))

function random(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Raw RGB, drawn by `colour(x, y) → [r, g, b]`. */
function draw(width, height, colour) {
  const pixels = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = colour(x, y)
      const at = (y * width + x) * 3
      pixels[at] = r; pixels[at + 1] = g; pixels[at + 2] = b
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } })
}

/** Smooth noise: a coarse grid of random values, blended between its points. */
function smoothNoise(seed, cell) {
  const next = random(seed)
  const grid = new Map()
  const at = (gx, gy) => {
    const key = gx * 100003 + gy
    if (!grid.has(key)) grid.set(key, next())
    return grid.get(key)
  }
  return (x, y) => {
    const gx = Math.floor(x / cell), gy = Math.floor(y / cell)
    const fx = x / cell - gx, fy = y / cell - gy
    const top = at(gx, gy) * (1 - fx) + at(gx + 1, gy) * fx
    const bottom = at(gx, gy + 1) * (1 - fx) + at(gx + 1, gy + 1) * fx
    return top * (1 - fy) + bottom * fy
  }
}

const clamp = (value) => Math.max(0, Math.min(255, Math.round(value)))

async function screenshot() {
  const grain = random(11)
  const image = draw(2880, 1800, (x, y) => {
    if (y < 120) return [0, 33, 71] // title bar
    if (x < 520) return (y - 120) % 64 < 2 ? [205, 208, 212] : [244, 242, 236] // side list with rules
    if (y > 1500) { const g = clamp(120 + (x - 520) / 12 + grain() * 26); return [g, clamp(g + 18), clamp(g + 40)] } // textured strip
    if ((x - 520) % 590 < 540 && (y - 180) % 440 < 380) { // cards
      const shade = 250 - Math.floor(((y - 180) % 440) / 38) * 3
      return (x + y) % 97 < 3 ? [60, 70, 82] : [shade, shade, clamp(shade + 3)]
    }
    return [253, 252, 249]
  })
  writeFileSync(join(here, 'screenshot.png'), await image.png({ compressionLevel: 9 }).toBuffer())
}

async function chart() {
  const grain = random(23)
  const image = draw(1600, 1000, (x, y) => {
    const bar = Math.floor(x / 200)
    const height = 180 + ((bar * 137) % 620)
    if (x % 200 > 40 && x % 200 < 170 && y > 1000 - height) {
      const tint = clamp(40 + bar * 24 + grain() * 14)
      return [tint, clamp(90 + bar * 12), clamp(200 - bar * 14)]
    }
    return y % 100 === 0 ? [215, 215, 215] : [255, 255, 255]
  })
  writeFileSync(join(here, 'chart.png'), await image.png({ compressionLevel: 9 }).toBuffer())
}

async function photo() {
  const broad = smoothNoise(31, 180), mid = smoothNoise(37, 40), fine = smoothNoise(41, 6)
  const image = draw(2000, 1400, (x, y) => {
    const light = broad(x, y) * 170 + mid(x, y) * 60 + fine(x, y) * 25
    return [clamp(light + 30), clamp(light * 0.9 + 25), clamp(light * 0.7 + 40)]
  })
  writeFileSync(join(here, 'photo.jpg'), await image.jpeg({ quality: 90 }).toBuffer())
}

async function diagram() {
  const soft = smoothNoise(53, 90), fine = smoothNoise(59, 5)
  const image = draw(1600, 1200, (x, y) => {
    const ring = Math.hypot(x - 800, y - 600)
    if (Math.abs(ring - 380) < 6 || Math.abs(ring - 220) < 4) return [0, 33, 71]
    if (ring < 220) { const v = clamp(200 + soft(x, y) * 40 + fine(x, y) * 44); return [v, clamp(v - 20), clamp(v - 70)] }
    const v = clamp(232 + soft(x, y) * 18 + fine(x, y) * 16)
    return [v, v, clamp(v - 6)]
  })
  writeFileSync(join(here, 'diagram.webp'), await image.webp({ quality: 96 }).toBuffer())
}

await screenshot()
await chart()
await photo()
await diagram()
