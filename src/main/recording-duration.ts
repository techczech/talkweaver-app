// Packet timestamps survive an interrupted WebM even when its container has no duration.
// Copy packets to the null muxer: no decoding, PCM buffer, or main-thread blocking.
import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'

export async function recordingDurationMs(ffmpeg: string, path: string, timeoutMs = 10000): Promise<number> {
  return new Promise((resolve, reject) => {
    execFile(ffmpeg, ['-v', 'error', '-nostdin', '-i', path, '-map', '0:a:0', '-c:a', 'copy', '-f', 'null', '-', '-nostats', '-stats_period', '30', '-progress', 'pipe:1'],
      { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, windowsHide: true }, async (error, stdout) => {
        const times = [...stdout.matchAll(/^out_time_us=(-?\d+)$/gm)].map(m => Number(m[1]) / 1000)
        if (!error && times.length && times.every(t => Number.isFinite(t) && t >= 0 && t <= 7 * 24 * 60 * 60 * 1000)) { resolve(Math.max(...times)); return }
        // Chromium can flush just the WebM initialisation header. It has no Cluster,
        // hence no audio packets. Leave other unreadable/corrupt files as explicit errors.
        if (await headerOnlyWebm(path)) { resolve(0); return }
        reject(new Error('The audio segment could not be read. Check the local recording and ffmpeg in Settings.'))
      })
  })
}

/** A small WebM initialisation header, including a cut-off Cluster ID, holds no packets. */
export async function headerOnlyWebm(path: string): Promise<boolean> {
  try {
    if ((await stat(path)).size > 65536) return false
    const bytes = await readFile(path)
    return bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) &&
      !bytes.includes(Buffer.from([0x1f, 0x43, 0xb6, 0x75]))
  } catch { return false }
}
