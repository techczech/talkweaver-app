import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Own the entire fixture, including the vault, Electron profile and generated assets. */
export function scratchVault(prefix) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  return {
    root,
    [Symbol.dispose]() {
      rmSync(root, { recursive: true, force: true, maxRetries: 3 })
    }
  }
}
