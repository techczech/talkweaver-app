import { join } from 'node:path'

/**
 * A deck window's preload and sandbox, per present mode. The presenter carries the recorder bridge
 * (which also mounts ⌘E) and is the only deck window without the sandbox: that preload requires a
 * shared chunk and hands audio buffers back, and has not been verified sandboxed. A plain
 * presentation ('window', the default) gets the edit-only bridge, built as one file so it runs
 * sandboxed. The audience view has no preload.
 */
export function presentWindowPreferences(mode: string | undefined, preloadDir: string): { preload?: string; sandbox: boolean } {
  if (mode === 'presenter') return { preload: join(preloadDir, 'presentRecorder.js'), sandbox: false }
  if (mode === 'audience') return { sandbox: true }
  return { preload: join(preloadDir, 'presentEdit.js'), sandbox: true }
}
