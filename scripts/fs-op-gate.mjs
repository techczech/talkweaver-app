// Test helper (not a test): watches the real fs.promises operations main's object readers use (lstat,
// realpath, opendir, open, and stat/read on an opened file), so a test can hold the k-th one past a
// deadline and count every operation started after a given moment. Patches the built-in module and
// syncs its ESM exports, as the independent review probes of 03756f0f did; restore() undoes it.
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'

const NAMES = ['lstat', 'realpath', 'opendir', 'open']

export function gateFsOps() {
  const original = Object.fromEntries(NAMES.map((n) => [n, fs.promises[n]]))
  const ops = []
  let holdAt = -1
  let held = null
  let release = null
  const enter = async (name, path) => {
    const index = ops.length
    ops.push({ name, path: String(path), at: performance.now() })
    if (index === holdAt) {
      held = { name, path: String(path) }
      await new Promise((resolve) => { release = resolve })
    }
  }
  for (const name of NAMES) {
    fs.promises[name] = async function gated(path, ...args) {
      await enter(name, path)
      const result = await original[name].call(this, path, ...args)
      if (name === 'open') {
        for (const method of ['stat', 'read']) {
          const own = result[method].bind(result)
          result[method] = async (...a) => { await enter(`file.${method}`, path); return own(...a) }
        }
      }
      return result
    }
  }
  syncBuiltinESMExports()
  return {
    ops,
    /** Hold the k-th operation (0-based) of the next run until release(). */
    holdAt(k) { holdAt = k; held = null; release = null; ops.length = 0 },
    get held() { return held },
    release() { release?.() },
    startedAfter(t) { return ops.filter((op) => op.at > t) },
    restore() { Object.assign(fs.promises, original); syncBuiltinESMExports() }
  }
}

export const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms))
