// Pre-work is hidden for 0.37 (it failed its journey test and is being redesigned). One switch, off by
// default: every pre-work entry point asks this and shows nothing while it is false. Nothing is deleted
// or rewritten: a talk's {prework} section, a Run's pre-work fields and its answers stay on disk, and a
// {prework} section is still left out of presenting, the handout and the venue screen either way.
// Tests that exercise pre-work run with TW_PREWORK=1 in the environment (the renderer has no
// process.env, so it always reads the constant).
export const PREWORK_ENABLED = false

export function preworkEnabled(): boolean {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
  return PREWORK_ENABLED || env?.TW_PREWORK === '1'
}
