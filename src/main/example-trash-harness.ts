// The e2e stand-in Bin for removing the example vault (onboarding ticket 12). Test-only: a packaged
// launch, or a launch without TW_E2E=1, gets the system Bin (`shell.trashItem`) or a function that
// always fails; never a folder elsewhere. The stand-in has a check-then-move gap against a hostile
// local process (its folder is checked, then the example is moved into it); it cannot be reached in a
// packaged launch.
import { randomBytes } from 'node:crypto'
import { lstat, realpath, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, sep } from 'node:path'
import type { TrashItem } from './example-vault-removal.ts'

/** The harness override for the Bin. See `resolveExampleTrash`. */
export const EXAMPLE_BIN_OVERRIDE = 'TW_E2E_BIN'

/**
 * The trash function for this run. A normal launch uses the system's (`shell.trashItem`). A run with
 * the e2e flag never reaches the real Bin: it gets the stand-in (the folder is moved into
 * `TW_E2E_BIN`), honoured only when the app is unpackaged and that directory, at the moment of the
 * call, is not a symlink and its real path is inside the real system temp folder; otherwise a
 * function that always fails.
 */
export function resolveExampleTrash(input: {
  isPackaged: boolean
  env: Record<string, string | undefined>
  systemTrash: TrashItem
  tempDir?: () => string
  move?: (from: string, to: string) => Promise<void>
}): TrashItem {
  if (input.env.TW_E2E !== '1') return input.systemTrash
  const bin = input.isPackaged ? '' : input.env[EXAMPLE_BIN_OVERRIDE]?.trim() ?? ''
  if (bin === '') return async () => { throw Object.assign(new Error('No Bin in a harness run.'), { code: 'NO_BIN' }) }
  return async (path) => {
    const real = await harnessBinInsideTemp(bin, (input.tempDir ?? tmpdir)())
    if (real === null) throw Object.assign(new Error('The harness Bin is not a plain folder inside the temp folder.'), { code: 'BIN_OUTSIDE_TEMP' })
    const target = join(real, `${basename(path)} ${Date.now()}-${randomBytes(4).toString('hex')}`)
    await (input.move ?? rename)(path, target)
  }
}

/** The harness Bin's real path, or null unless it is a plain directory strictly inside the real temp folder. */
export async function harnessBinInsideTemp(bin: string, tempDir: string): Promise<string | null> {
  try {
    if (!isAbsolute(bin)) return null
    const own = await lstat(bin)
    if (own.isSymbolicLink() || !own.isDirectory()) return null
    const [real, temp] = await Promise.all([realpath(bin), realpath(tempDir)])
    const inside = temp.endsWith(sep) ? temp : temp + sep
    return real.startsWith(inside) && real.length > inside.length ? real : null
  } catch {
    return null
  }
}
