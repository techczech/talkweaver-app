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
// The shared settings packages are bundled, not left as node_modules files: they are linked by
// file: path, and electron-builder copies those as plain files with whatever transitive versions
// it finds. The Settings window's preload is sandboxed and cannot require packages at all.
const BUNDLED = ['@app-patterns/commands', '@app-patterns/settings', '@app-patterns/settings-electron', '@app-patterns/settings-react']

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: BUNDLED })],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          // A publish builds and writes its handout pages in a utility process of its own (handout-pages-worker.ts).
          'handout-pages-worker': resolve(__dirname, 'src/main/handout-pages-worker.ts'),
          // The live compile (prepareTalk) runs in a utility process of its own (prepare-talk-worker.ts).
          'prepare-talk-worker': resolve(__dirname, 'src/main/prepare-talk-worker.ts'),
          // An Insert › HTML page… copy runs in a utility process started in the talk folder (html-page-import-worker.ts).
          'html-page-import-worker': resolve(__dirname, 'src/main/html-page-import-worker.ts'),
          // A saved view of a live web page is written by a utility process started in the talk folder (live-page-capture-worker.ts).
          'live-page-capture-worker': resolve(__dirname, 'src/main/live-page-capture-worker.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: BUNDLED })],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          // Recording bridge — attached to the present window ONLY when TalkWeaver opens it
          // (opt-in), so a portable deck opened as a plain file has no preload and no REC control.
          // It also mounts the ⌘E edit bridge (shared present-edit-bridge module).
          presentRecorder: resolve(__dirname, 'src/preload/present-recorder.ts'),
          // Edit-only bridge for a plain presentation window — ⌘E jumps back to the editor.
          presentEdit: resolve(__dirname, 'src/preload/present-edit.ts'),
          // The shared Settings window (sandboxed): the settings: bridge and the app's own pages' calls.
          settings: resolve(__dirname, 'src/preload/settings.ts')
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
          index: resolve(__dirname, 'src/renderer/index.html'),
          settings: resolve(__dirname, 'src/renderer/settings.html'),
          // Capture embed… (src/main/live-page-capture-window.ts): an app page with no preload.
          'capture-embed': resolve(__dirname, 'src/renderer/capture-embed.html')
        }
      }
    },
    plugins: [react()]
  }
})
