import { readdirSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

function newestFileMtime(directory, excludedDirectory = '') {
  let newest = 0
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = `${directory}/${entry.name}`
    if (target === excludedDirectory) continue
    newest = Math.max(
      newest,
      entry.isDirectory() ? newestFileMtime(target, excludedDirectory) : statSync(target).mtimeMs
    )
  }
  return newest
}

export async function ensureFreshBuild(repoRoot) {
  const sourceMtime = Math.max(
    newestFileMtime(`${repoRoot}/src/main`),
    newestFileMtime(`${repoRoot}/src/preload`),
    newestFileMtime(`${repoRoot}/src/shared`),
    newestFileMtime(`${repoRoot}/src/renderer`, `${repoRoot}/src/renderer/out`),
    ...readdirSync(repoRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.startsWith('electron.vite.config.'))
      .map((entry) => statSync(`${repoRoot}/${entry.name}`).mtimeMs)
  )

  let outputMtime = 0
  try {
    outputMtime = statSync(`${repoRoot}/out/main/index.js`).mtimeMs
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }

  if (outputMtime >= sourceMtime) {
    console.log('[e2e] Compiled app is fresh; skipping build.')
    return
  }

  console.log('[e2e] Compiled app is stale or missing; running npx electron-vite build.')
  const result = spawnSync('npx', ['electron-vite', 'build'], {
    cwd: repoRoot,
    stdio: 'inherit'
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`electron-vite build failed with exit code ${result.status ?? 'unknown'}`)
  }
}
