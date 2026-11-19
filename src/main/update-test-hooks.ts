// Test-only: the unpublished update-test flavour (ADR-0044; scripts/prove-in-place-update.mjs) and a test run from
// source (TW_E2E=1, never packaged; e2e/diagnose-outline-disk-guard.mjs). In a release build __TW_UPDATE_TEST__ is
// false and the app is packaged, so saveDelayAllowed is false and nothing waits (scripts/test-write-queues.mjs
// asserts it, and that electron.vite.config.ts defines the flag false).
import { app } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'

declare const __TW_UPDATE_TEST__: boolean

/** Whether the save-delay hook may act: the packaged update-test flavour, or an unpackaged test run. Never a release. */
export function saveDelayAllowed(build: { updateTest: boolean; packaged: boolean; e2e: boolean }): boolean {
  return (build.updateTest && build.packaged) || (!build.packaged && build.e2e)
}

/** The milliseconds written in the file `variable` names (at most ten minutes), when the hooks may act; else 0. */
function delayFrom(variable: string): number {
  if (!saveDelayAllowed({ updateTest: __TW_UPDATE_TEST__, packaged: app.isPackaged, e2e: process.env.TW_E2E === '1' })) return 0
  const file = process.env[variable]
  if (!file || !isAbsolute(file) || !existsSync(file)) return 0
  let ms = 0
  try { ms = Number(readFileSync(file, 'utf8').trim()) } catch { return 0 }
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, 600_000) : 0
}

/**
 * While the file TW_UPDATE_TEST_SETTINGS_DELAY_FILE names exists, each preference write main makes waits that long
 * before it reaches the settings store: the packaged proof's pending preference write at an update's restart.
 */
export async function updateTestSettingsDelay(): Promise<void> {
  const ms = delayFrom('TW_UPDATE_TEST_SETTINGS_DELAY_FILE')
  if (!ms) return
  console.log(`[update-test] this preference write waits ${ms} ms`)
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * While the file TW_UPDATE_TEST_SAVE_DELAY_FILE names exists, each editor save waits the number of milliseconds
 * written in it (at most ten minutes) before it is written: the packaged proof's slow save during an update's
 * restart, and the close tests' slow save. Every other build waits for nothing.
 */
export async function updateTestSaveDelay(): Promise<void> {
  const ms = delayFrom('TW_UPDATE_TEST_SAVE_DELAY_FILE')
  if (!ms) return
  console.log(`[update-test] this save waits ${ms} ms`)
  await new Promise((resolve) => setTimeout(resolve, ms))
}
