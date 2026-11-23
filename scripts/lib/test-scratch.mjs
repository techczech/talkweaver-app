import { lstatSync, mkdtempSync, rmSync } from 'node:fs'

const owned = new Map()

// This also covers explicit process.exit() and uncaught test failures. A test
// killed at its wall limit is cleaned by the tier runner's outer scratch owner.
process.once('exit', () => {
  for (const [path, owner] of [...owned].reverse()) {
    try {
      const current = lstatSync(path, { throwIfNoEntry: false })
      if (!current) continue
      if (!current.isDirectory() || current.dev !== owner.dev || current.ino !== owner.ino) {
        throw new Error('directory identity changed')
      }
      rmSync(path, { recursive: true, force: true, maxRetries: 3 })
    } catch (error) {
      console.error(`Could not clean test scratch ${path}: ${error.message}`)
      process.exitCode ||= 1
    }
  }
})

export function testScratchDir(prefix) {
  const path = mkdtempSync(prefix)
  owned.set(path, lstatSync(path))
  return path
}
