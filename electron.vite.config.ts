import { resolve } from 'path'
import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Build stamp — injected so the running app can show which build it is (bottom-left status bar),
// so a test session never wastes time on a stale install. Best-effort; never fails the build.
// Commands are constant argument arrays (no shell, no interpolation).
function gitShort(): string {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
    // Dirty = uncommitted SOURCE changes only. Scoped to source paths so the `dist:mac` step's
    // in-build rebuild of the tracked native binaries (native/ocr, native/media) doesn't show a
    // false `+`. Build outputs (out/, release/) and those binaries are excluded by omission.
    const dirty = execFileSync(
      'git',
      ['status', '--porcelain', '--', 'src', 'compiler', 'scripts', 'package.json', 'electron.vite.config.ts'],
      { encoding: 'utf8' }
    ).trim().length > 0
    return sha + (dirty ? '+' : '')
  } catch {
    return 'nogit'
  }
}
const APP_VERSION = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')).version
const BUILD_SHA = gitShort()
const BUILD_TIME = new Date().toISOString()

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          // Recording bridge — attached to the present window ONLY when TalkWeaver opens it
          // (opt-in), so a portable deck opened as a plain file has no preload and no REC control.
          // It also mounts the ⌘E edit bridge (shared present-edit-bridge module).
          presentRecorder: resolve(__dirname, 'src/preload/present-recorder.ts'),
          // Edit-only bridge for a plain presentation window — ⌘E jumps back to the editor.
          presentEdit: resolve(__dirname, 'src/preload/present-edit.ts')
        }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    define: {
      __APP_VERSION__: JSON.stringify(APP_VERSION),
      __BUILD_SHA__: JSON.stringify(BUILD_SHA),
      __BUILD_TIME__: JSON.stringify(BUILD_TIME)
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html')
        }
      }
    },
    plugins: [react()]
  }
})
