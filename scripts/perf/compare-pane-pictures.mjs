#!/usr/bin/env node
/** Compare two folders of presenter pane pictures (presenting-path.mjs --shots=DIR), file by file.
 * Usage: node scripts/perf/compare-pane-pictures.mjs BEFORE_DIR AFTER_DIR
 * Prints how many pictures are identical and, for the rest, the share of channel values that differ by more than 8/255.
 * The pictures show the talk's content: keep both folders out of the repo and delete them after comparing.
 */
import sharp from 'sharp'
import { readdirSync } from 'node:fs'
const [a, b] = process.argv.slice(2)
if (!a || !b) throw Error('Expected BEFORE_DIR AFTER_DIR')
let same = 0
const differ = []
for (const f of readdirSync(a).filter((n) => n.endsWith('.png')).sort()) {
  try {
    const [x, y] = await Promise.all([a, b].map((d) => sharp(`${d}/${f}`).raw().toBuffer({ resolveWithObject: true })))
    if (x.info.width !== y.info.width || x.info.height !== y.info.height) { differ.push(`${f} size`); continue }
    let n = 0
    for (let i = 0; i < x.data.length; i++) if (Math.abs(x.data[i] - y.data[i]) > 8) n++
    if (n) differ.push(`${f} ${(n / x.data.length * 100).toFixed(3)}%`); else same++
  } catch (e) { differ.push(`${f} ${String(e.message).slice(0, 60)}`) }
}
console.log({ same, differ: differ.length })
if (differ.length) console.log(differ.join('\n'))
