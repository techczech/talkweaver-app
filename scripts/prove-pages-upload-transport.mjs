// The large-upload allowance at its real length, once, on request (not part of any test tier: it waits over
// five minutes). A real `pages deploy` through `runWrangler`, with the real bundled wrangler on the stand-in
// API, whose first upload is answered only after `--hold-seconds` (default 310: past the HTTP client's
// default of 300 and the old process limit of 180).
//   node scripts/prove-pages-upload-transport.mjs [--hold-seconds 310] [--timeout-seconds N] [--electron]
// Prints one JSON line: how the run ended and what became of each upload. `--timeout-seconds` replaces the
// process limit (to see the HTTP client's own limit past the old process limit of three minutes).
import { createRequire } from 'node:module'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runWrangler } from '../src/main/wrangler-launcher.ts'
import { pagesDeployArgs, startPagesUploadStandIn } from './lib/pages-upload-stand-in.mjs'

const option = (name, fallback) => { const at = process.argv.indexOf(name); return at > 0 ? Number(process.argv[at + 1]) : fallback }
const holdSeconds = option('--hold-seconds', 310)
const timeoutSeconds = option('--timeout-seconds', 0)
const electron = process.argv.includes('--electron')
const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'tw-pages-proof-')))
const execPath = electron ? createRequire(import.meta.url)('electron') : process.execPath
const standIn = await startPagesUploadStandIn({ mode: 'headers', hold: 1, holdMs: holdSeconds * 1_000 })
const started = Date.now()
try {
  const run = await runWrangler({ execPath, appRoot: repo, platform: process.platform, workDir: join(scratch, 'runs') }, pagesDeployArgs(scratch), {
    inherited: {}, set: standIn.credentials, ...(timeoutSeconds ? { timeoutMs: timeoutSeconds * 1_000 } : {}),
  })
  console.log(JSON.stringify({
    runner: electron ? 'Electron' : 'Node', holdSeconds, timeoutSeconds: timeoutSeconds || 'default', ok: run.ok, timedOut: run.timedOut === true,
    seconds: Math.round((Date.now() - started) / 100) / 10,
    uploads: standIn.uploads.map((upload) => ({ held: upload.held, gaveUpAfterSeconds: upload.gaveUpAfterMs === null ? null : Math.round(upload.gaveUpAfterMs / 100) / 10 })),
    said: `${run.stdout}\n${run.stderr}`.replace(/\s+/g, ' ').slice(-400),
  }))
} finally {
  await standIn.stop()
  rmSync(scratch, { recursive: true, force: true })
}
