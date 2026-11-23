// The e2e triage line for an Electron SIGTRAP (e2e/lib/electron-crash-note.mjs), on synthetic crash reports.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CRASH_DOC, electronCrashNote, readCrashReport } from '../e2e/lib/electron-crash-note.mjs'

const FRAMEWORK = { name: 'Electron Framework', uuid: '4c4c4425-5555-3144-a151-a187d31bc087' }
const ips = (pid, offsets, image = FRAMEWORK) => JSON.stringify({ app_name: 'Electron' }) + '\n' + JSON.stringify({
  pid, faultingThread: 0, exception: { type: 'EXC_BREAKPOINT', signal: 'SIGTRAP' }, usedImages: [image],
  threads: [{ name: 'CrBrowserMain', frames: offsets.map((imageOffset) => ({ imageIndex: 0, imageOffset })) }]
})
// The Studio report of 23 November 2026: NotifyCreated, the agent host, its create function, FrameAutoAttacher.
const KNOWN = [0x13b22b4, 0x4278510, 0x4277fb4, 0x420dd88, 0x4279950]
const child = (pid, signalCode, exitCode = null) => Object.assign(new EventEmitter(), { pid, signalCode, exitCode })

const dir = mkdtempSync(join(tmpdir(), 'tw-crash-note-'))
try {
  assert.equal(readCrashReport('not a report'), null)
  assert.equal(readCrashReport(ips(7, KNOWN)).frames[3].offset, 0x420dd88)

  writeFileSync(join(dir, 'Electron-2026-11-23-091551.ips'), ips(64297, KNOWN))
  writeFileSync(join(dir, 'Electron-2026-11-23-091000.ips'), ips(64297, [0x1234, 0x5678, 0x9, 0xa]))
  utimesSync(join(dir, 'Electron-2026-11-23-091000.ips'), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
  writeFileSync(join(dir, 'Electron-2026-11-23-091600.ips'), ips(111, [0x1234, 0x5678, 0x9, 0xa]))
  writeFileSync(join(dir, 'Electron Helper-2026-11-23-091552.ips'), ips(64297, [0x1, 0x2, 0x3, 0x4]))

  const known = await electronCrashNote(child(64297, 'SIGTRAP'), { dir, reportWaitMs: 0 })
  assert.match(known, /^\[e2e\] KNOWN FLAKE: Electron 42\.11\.16 arm64 main process 64297 hit Chromium's DevToolsAgentHostImpl::NotifyCreated check/)
  assert.ok(known.includes(CRASH_DOC) && known.endsWith('Electron-2026-11-23-091551.ips'), 'newest report of that pid, doc named')
  assert.equal(known.split('\n').length, 1, 'one line')

  const other = await electronCrashNote(child(111, 'SIGTRAP'), { dir, reportWaitMs: 0 })
  assert.match(other, /died by SIGTRAP, not the known NotifyCreated crash \(top frame Electron Framework\+0x1234, Electron 42\.11\.16 arm64\)/)
  writeFileSync(join(dir, 'Electron-2026-11-24-000000.ips'), ips(222, KNOWN, { name: 'Electron Framework', uuid: 'ffffffff-0000-0000-0000-000000000000' }))
  assert.match(await electronCrashNote(child(222, 'SIGTRAP'), { dir, reportWaitMs: 0 }), /not the known NotifyCreated crash .*NotifyCreated offset is not recorded/)
  assert.match(await electronCrashNote(child(333, 'SIGTRAP'), { dir, reportWaitMs: 0 }), /no crash report for it was found/)

  assert.equal(await electronCrashNote(child(64297, null, 1), { dir }), null, 'an ordinary failure prints nothing')
  assert.equal(await electronCrashNote(child(64297, 'SIGKILL'), { dir }), null)
  assert.equal(await electronCrashNote(undefined, { dir }), null)
  const late = child(64297, null)
  setTimeout(() => { late.signalCode = 'SIGTRAP'; late.emit('exit', null, 'SIGTRAP') }, 20)
  assert.match(await electronCrashNote(late, { dir, reportWaitMs: 0 }), /KNOWN FLAKE/, 'waits for a process still ending')
  console.log('PASS: SIGTRAP with NotifyCreated on top is named as the known flake in one line; other crashes, unknown builds, missing reports and ordinary failures are told apart')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
