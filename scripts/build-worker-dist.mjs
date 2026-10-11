// Build step (ticket 11): compile the live service once, here in the repository, into worker-dist/,
// which ships in the app's resources and is what the app uploads. Then check what was written, so
// the build fails on a missing, empty or mismatched bundle (scripts/lib/worker-dist.mjs).
//
//   node scripts/build-worker-dist.mjs [--out <folder>]     default: worker-dist/ in the repository
import { join, resolve } from 'node:path'
import { realpathSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildWorkerDist, checkWorkerDist } from './lib/worker-dist.mjs'

const repo = realpathSync(dirname(dirname(fileURLToPath(import.meta.url))))
const at = process.argv.indexOf('--out')
const outDir = at > 0 && process.argv[at + 1] ? resolve(process.argv[at + 1]) : join(repo, 'worker-dist')
try {
  const manifest = buildWorkerDist({ repo, outDir })
  const problems = checkWorkerDist({ repo, distDir: outDir })
  if (problems.length) throw new Error(problems.join('\n'))
  const bundle = manifest.files[manifest.mainModule]
  console.log(`worker-dist: live service build ${manifest.build} compiled with wrangler ${manifest.wrangler} → ${outDir} (${manifest.mainModule}, ${bundle.bytes} bytes, sha256 ${bundle.sha256})`)
} catch (error) {
  console.error(`worker-dist: the live service could not be built.\n${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
