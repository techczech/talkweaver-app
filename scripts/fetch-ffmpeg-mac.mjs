// Build step (ticket 08, ADR-0003 amendment of 2026-10-09): put the pinned plain-GPL ffmpeg for macOS
// into ffmpeg-mac/ (git-ignored), from where electron-builder copies it to resources/ffmpeg/. The
// address and both SHA-256 values are in scripts/lib/ffmpeg-mac-pin.json; anything else is refused
// (scripts/lib/ffmpeg-mac-fetch.mjs). A copy already there with the pinned hash is kept, so this
// downloads once per checkout. The before-pack hook runs it for every macOS package.
//
//   node scripts/fetch-ffmpeg-mac.mjs [--out <folder>]     default: ffmpeg-mac/ in the repository
import { dirname, join, resolve } from 'node:path'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ensurePinnedMacFfmpeg, readMacFfmpegPin } from './lib/ffmpeg-mac-fetch.mjs'

const repo = realpathSync(dirname(dirname(fileURLToPath(import.meta.url))))
const at = process.argv.indexOf('--out')
const outDir = at > 0 && process.argv[at + 1] ? resolve(process.argv[at + 1]) : join(repo, 'ffmpeg-mac')
try {
  const pin = readMacFfmpegPin()
  const { path, fetched } = await ensurePinnedMacFfmpeg({ pin, outDir })
  console.log(`ffmpeg-mac: FFmpeg ${pin.version} (${pin.licence}) for macOS ${pin.arch} ${fetched ? 'downloaded and verified' : 'already in place and verified'} → ${path} (sha256 ${pin.binarySha256})`)
} catch (error) {
  console.error(`ffmpeg-mac: the pinned macOS ffmpeg could not be put in place.\n${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
