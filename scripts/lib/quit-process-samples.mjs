import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export function readQuitProcesses() {
  return run('/bin/ps', ['-ww', '-axo', 'pid=,ppid=,command=']).then(({ stdout }) => stdout)
}

function processRows(listing) {
  return listing.trim().split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line)
    return match ? [{ pid: Number(match[1]), parent: Number(match[2]), command: match[3] }] : []
  })
}

export function quitProcessTree(listing, mainPid, userData, previous = []) {
  const rows = processRows(listing)
  const profile = ` --user-data-dir=${userData}`
  const beforeQuit = new Map(previous.map(({ pid, command }) => [pid, command]))
  const owned = new Set(rows.filter(({ pid, command }) =>
    pid === mainPid || command.endsWith(profile) || command.includes(profile + ' ') ||
    beforeQuit.get(pid) === command
  ).map(({ pid }) => pid))
  // Parent/child order in ps output is unspecified. Include helpers at any depth.
  for (let size = -1; size !== owned.size;) {
    size = owned.size
    for (const { pid, parent } of rows) {
      if (owned.has(parent)) owned.add(pid)
    }
  }
  return rows.filter(({ pid }) => owned.has(pid))
}

export async function sampleQuitProcesses(processes, folder, prefix, execute = run) {
  return Promise.all(processes.map(async ({ pid }) => {
    const file = join(folder, `${prefix}-${pid}.sample.txt`)
    try {
      // The three-second collection is followed by symbolication. Several Electron
      // helpers symbolicate in parallel, so give that phase a separate margin.
      await execute('/usr/bin/sample', [String(pid), '3', '-mayDie', '-file', file], { timeout: 45000 })
      return { pid, file }
    } catch (error) {
      const status = error.signal ? `sample ended with ${error.signal}` : error.message
      return { pid, error: [status, error.stderr?.trim()].filter(Boolean).join('\n') }
    }
  }))
}
