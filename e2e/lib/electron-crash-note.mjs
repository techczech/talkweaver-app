// One line for triage when an e2e's Electron main process dies by SIGTRAP. It never retries: the flake
// stays visible. The known case is Chromium's DevToolsAgentHostImpl::NotifyCreated check under
// Playwright's auto-attach (docs/diagnostics/report-devtools-attach-crash-2026-11-23.md).
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const CRASH_DOC = 'docs/diagnostics/report-devtools-attach-crash-2026-11-23.md'

// Electron Framework builds whose offsets were symbolicated with the official symbols: the
// NotifyCreated check (frame 0) and FrameAutoAttacher::DidFinishNavigation (frame 3).
export const KNOWN_NOTIFY_CREATED = {
  '4c4c4425-5555-3144-a151-a187d31bc087': { electron: '42.11.16 arm64', top: 0x13b22b4, autoAttacher: 0x420dd88 }
}

/** Reads a macOS .ips crash report (a JSON header line, then the JSON report). null when it is not one. */
export function readCrashReport(text) {
  try {
    const body = JSON.parse(text.slice(text.indexOf('\n') + 1))
    const thread = body.threads[body.faultingThread]
    const frames = thread.frames.map((frame) => ({ offset: frame.imageOffset, image: body.usedImages[frame.imageIndex] ?? {} }))
    return { pid: body.pid, signal: body.exception?.signal, frames }
  } catch {
    return null
  }
}

/** The triage line for one crash report of this pid. */
export function crashNote({ pid, file, report }) {
  if (!report) return `[e2e] Electron main process ${pid} died by SIGTRAP; no crash report for it was found (looked in ${file}).`
  const [top, , , fourth] = report.frames
  const known = KNOWN_NOTIFY_CREATED[String(top?.image.uuid ?? '').toLowerCase()]
  const where = top ? `${top.image.name ?? '?'}+0x${top.offset.toString(16)}` : 'no frames'
  if (known && top.offset === known.top && fourth?.offset === known.autoAttacher) {
    return `[e2e] KNOWN FLAKE: Electron ${known.electron} main process ${pid} hit Chromium's DevToolsAgentHostImpl::NotifyCreated check (FrameAutoAttacher, Playwright auto-attach); test-only, see ${CRASH_DOC}. Report: ${file}`
  }
  const build = known ? `Electron ${known.electron}` : 'an Electron build whose NotifyCreated offset is not recorded'
  return `[e2e] Electron main process ${pid} died by SIGTRAP, not the known NotifyCreated crash (top frame ${where}, ${build}). Report: ${file}`
}

/** The newest main-process report (Electron-*.ips, not Electron Helper) for this pid in the folder, or null. */
export function findCrashReport(pid, dir) {
  let names = []
  try { names = readdirSync(dir).filter((name) => /^Electron-.*\.ips$/.test(name)) } catch { return null }
  const reports = names.map((name) => ({ file: join(dir, name), mtime: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  for (const { file } of reports) {
    let report = null
    try { report = readCrashReport(readFileSync(file, 'utf8')) } catch { continue }
    if (report?.pid === pid) return { file, report }
  }
  return null
}

/**
 * After an e2e fails: if Electron's main process ended by SIGTRAP, the triage line, else null. Waits a
 * moment for the process to end and for macOS to write its report (about two seconds after the crash).
 */
export async function electronCrashNote(child, { dir = join(homedir(), 'Library/Logs/DiagnosticReports'), exitWaitMs = 3000, reportWaitMs = 10000 } = {}) {
  if (!child) return null
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise((resolve) => { const timer = setTimeout(resolve, exitWaitMs); child.once('exit', () => { clearTimeout(timer); resolve() }) })
  }
  if (child.signalCode !== 'SIGTRAP') return null
  const end = Date.now() + reportWaitMs
  for (;;) {
    const found = findCrashReport(child.pid, dir)
    if (found || Date.now() >= end) return crashNote({ pid: child.pid, file: found?.file ?? dir, report: found?.report })
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}
