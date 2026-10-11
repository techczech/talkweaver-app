// The config the live Worker is deployed with: the shipped worker/wrangler.jsonc, rewritten so it can
// live OUTSIDE the app's own folder. wrangler keeps its scratch (`.wrangler/tmp`) beside the config it
// is given; a config inside the installed app would have it write into a folder that is sealed by the
// app's signature and may not be writable. Pure (no Electron, erasable TypeScript): the main process
// and scripts/smoke-packaged-wrangler.mjs both use it.
import { posix, win32 } from 'node:path'

// Strips `//` line comments and `/* … */` block comments from JSONC text, leaving string contents
// untouched, so wrangler.jsonc — which may legitimately carry either, per its own extension — reads
// as plain JSON. Self-contained rather than depending on a parser package: none of this repo's own
// declared dependencies ships one, and wrangler.jsonc here is never large.
export function stripJsonComments(text: string): string {
  let out = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      out += ch
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; out += ch; continue }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1
      out += '\n'
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1
      i += 1
      continue
    }
    out += ch
  }
  return out
}

/**
 * `baseConfigText`: the shipped wrangler.jsonc. `workerDir`: the folder it ships in (`main` is made
 * absolute, pointing back into it). `shareHostname`: a validated share-link domain, or null.
 */
export function liveWorkerDeployConfig(
  baseConfigText: string, workerDir: string, shareHostname: string | null, platform: string = process.platform,
): Record<string, unknown> {
  const source = JSON.parse(stripJsonComments(baseConfigText)) as Record<string, unknown>
  const path = platform === 'win32' ? win32 : posix
  const generated: Record<string, unknown> = { ...source, main: path.join(workerDir, String(source.main ?? 'index.ts')) }
  if (!shareHostname) return generated
  return {
    ...generated,
    // Wrangler disables the workers.dev route by default once any `routes` entry is present unless
    // `workers_dev` says otherwise — keep it on: the app's own API calls (ensureLiveWorker's baseUrl,
    // parsed from the deploy's output) still go through workers.dev; only the colleague link moves to
    // the custom domain.
    workers_dev: true,
    routes: [{ pattern: shareHostname, custom_domain: true }],
  }
}
