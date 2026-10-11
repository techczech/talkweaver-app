// Packaging gate (ticket 11): the app is not packaged while worker-dist/ is missing, empty, does not
// match its manifest, or is older than the Worker's sources. Run by `npm run build` after the build
// step and by electron-builder before it packs (scripts/electron-builder-before-pack.cjs).
//
//   node scripts/check-worker-dist.mjs [<folder>]     default: worker-dist/ in the repository
import { realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkWorkerDist } from './lib/worker-dist.mjs'

const repo = realpathSync(dirname(dirname(fileURLToPath(import.meta.url))))
const distDir = process.argv[2] ? resolve(process.argv[2]) : join(repo, 'worker-dist')
const problems = checkWorkerDist({ repo, distDir })
if (problems.length) {
  console.error(`worker-dist is not ready to ship:\n${problems.map((line) => `  - ${line}`).join('\n')}`)
  process.exit(1)
}
console.log(`worker-dist: ${distDir} matches its manifest and the Worker's sources`)
