// Release step (owner's decision of 2026-10-09): pack the GPL corresponding source of the ffmpeg the
// macOS app ships into the release assets
//   TalkWeaver-<version>-ffmpeg-<ffmpeg version>-corresponding-source.tar
//   TalkWeaver-<version>-ffmpeg-<ffmpeg version>-corresponding-source.SHA256SUMS
// which .github/workflows/release.yml attaches to the same GitHub release as the Mac app (see
// docs/RELEASING.md). Every file comes from scripts/lib/ffmpeg-mac-source-manifest.json and is
// refused unless its SHA-256 is the pinned one (scripts/lib/ffmpeg-source-bundle.mjs). Downloads are
// kept in a git-ignored cache, so a second run fetches nothing.
//
//   node scripts/build-ffmpeg-source-bundle.mjs [--out <folder>] [--cache <folder>] [--version <TalkWeaver version>]
//   defaults: ffmpeg-mac-source/, ffmpeg-mac-source/cache/, the version in package.json
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readMacFfmpegPin } from './lib/ffmpeg-mac-fetch.mjs'
import { assembleSourceBundle, readSourceManifest } from './lib/ffmpeg-source-bundle.mjs'

const repo = realpathSync(dirname(dirname(fileURLToPath(import.meta.url))))
const option = (name) => {
  const at = process.argv.indexOf(name)
  return at > 0 && process.argv[at + 1] ? process.argv[at + 1] : null
}
const outDir = resolve(option('--out') ?? join(repo, 'ffmpeg-mac-source'))
const cacheDir = resolve(option('--cache') ?? join(repo, 'ffmpeg-mac-source', 'cache'))
const appVersion = option('--version') ?? JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version

try {
  const pin = readMacFfmpegPin()
  const manifest = readSourceManifest()
  if (manifest.ffmpegVersion !== pin.version || manifest.build !== pin.url) throw new Error('refused: scripts/lib/ffmpeg-mac-source-manifest.json is not for the pinned build in scripts/lib/ffmpeg-mac-pin.json')
  const bundle = await assembleSourceBundle({ manifest, pinSource: pin.source, appVersion, outDir, cacheDir, log: (line) => console.log(`ffmpeg-source: ${line}`) })
  console.log(`ffmpeg-source: ${bundle.files} pinned files, all verified → ${bundle.tar} (${(bundle.bytes / 1024 / 1024).toFixed(1)} MiB, sha256 ${bundle.sha256}); ${bundle.sums}`)
} catch (error) {
  console.error(`ffmpeg-source: the corresponding source bundle could not be made.\n${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
