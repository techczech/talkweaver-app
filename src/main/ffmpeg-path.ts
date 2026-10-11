// Which ffmpeg transcription uses (spec docs/plans/cloudflare-setup-in-app, D16 and "Outside this
// spec": ffmpeg ships with the app). Pure: the caller says which platform, where the app's resources
// are and what exists, so a test can build any layout from fixture paths.
//
// Order: the path set in Settings, when one is set (and only that one: a path the person typed that
// is not there is reported, never silently replaced); otherwise the ffmpeg that ships with
// TalkWeaver; otherwise, on macOS and Linux only, the usual system places. Nothing is looked up on
// PATH, so what runs is always a file this function named. A path set in Settings counts only when
// it is absolute and names an existing regular file that can be run: a bare name such as `ffmpeg`,
// or a relative path, is "not found", because spawning it would look it up on PATH (or in the
// current folder) instead of running a file the person chose.
//
// Where the shipped one is: the build's resources folder, as `ffmpeg/ffmpeg` (`ffmpeg/ffmpeg.exe` on
// Windows). On Windows electron-builder copies it from node_modules/ffmpeg-static (package.json,
// build.win.extraResources); on macOS from ffmpeg-mac/, the pinned plain-GPL build
// scripts/fetch-ffmpeg-mac.mjs puts there (build.mac.extraResources; ADR-0003, amendment of
// 2026-10-09). An unpackaged app (npm run dev, the e2e harness) uses the copy in
// node_modules/ffmpeg-static that `npm install` downloaded; it is never handed to anyone.
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join } from 'node:path'

export type FfmpegSource = 'configured' | 'shipped' | 'system'
export type FfmpegResolution =
  | { found: true; path: string; source: FfmpegSource }
  | { found: false; path: null; source: 'configured' | null }

/** The executable's file name on this platform. */
export function ffmpegExecutableName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
}

/**
 * The places the shipped ffmpeg can be, most likely first. `resourcesPath` is the build's resources
 * folder (process.resourcesPath); `appPath` the app's own folder (app.getAppPath()), whose
 * node_modules hold the copy an unpackaged app uses.
 */
export function shippedFfmpegCandidates(input: { platform: NodeJS.Platform; resourcesPath: string | null; appPath: string | null; packaged: boolean }): string[] {
  const name = ffmpegExecutableName(input.platform)
  const inResources = input.resourcesPath ? [join(input.resourcesPath, 'ffmpeg', name)] : []
  const inNodeModules = input.appPath ? [join(input.appPath, 'node_modules', 'ffmpeg-static', name)] : []
  return input.packaged ? [...inResources, ...inNodeModules] : [...inNodeModules, ...inResources]
}

/** Where ffmpeg usually is when a person installed it themselves. None on Windows: it has no such place. */
export function systemFfmpegCandidates(platform: NodeJS.Platform): string[] {
  if (platform === 'win32') return []
  return ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']
}

/** Whether `path` is a regular file (a link is followed) that this process may run. */
export function isExecutableFile(path: string, platform: NodeJS.Platform = process.platform): boolean {
  try {
    if (!statSync(path).isFile()) return false
    if (platform !== 'win32') accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** The one ffmpeg to run, or why there is none. */
export function resolveFfmpeg(input: {
  configured: string
  shipped: readonly string[]
  system: readonly string[]
  exists: (path: string) => boolean
  /** For the path set in Settings: a regular file that can be run (default: the real file system). */
  executable?: (path: string) => boolean
  /** Whether a path is absolute on this computer (default: node:path). */
  absolute?: (path: string) => boolean
}): FfmpegResolution {
  const configured = input.configured.trim()
  if (configured) {
    const absolute = input.absolute ?? isAbsolute
    const executable = input.executable ?? ((path: string) => isExecutableFile(path))
    return absolute(configured) && executable(configured) ? { found: true, path: configured, source: 'configured' } : { found: false, path: null, source: 'configured' }
  }
  for (const path of input.shipped) if (input.exists(path)) return { found: true, path, source: 'shipped' }
  for (const path of input.system) if (input.exists(path)) return { found: true, path, source: 'system' }
  return { found: false, path: null, source: null }
}

/**
 * The environment the engine runs in: the chosen ffmpeg's folder first on PATH, because Parakeet
 * decodes audio by running `ffmpeg` by name. Windows keeps the variable as `Path`; the existing key
 * is reused, so the child never gets two of them.
 */
export function childEnvWithFfmpegDir(ffmpegPath: string, env: NodeJS.ProcessEnv = process.env, sep: string = delimiter, dirOf: (path: string) => string = dirname): NodeJS.ProcessEnv {
  const next = { ...env }
  const key = Object.keys(next).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH'
  const rest = next[key]
  next[key] = rest ? `${dirOf(ffmpegPath)}${sep}${rest}` : dirOf(ffmpegPath)
  return next
}
