// Stopping the processes a stage recorded (lib.mjs writes pid, process group and start time for every app and
// browser it launches). A process is ours only while its pid shows the start time recorded for it: a pid or a
// group id can be reused once the original has gone. So a group is signalled only while its leader is the
// recorded process (same pid, same start time); a group whose leader has gone is never signalled as a group,
// only through its members known to be ours: the recorded processes and the members seen in the group while
// its recorded leader was still alive, each again only while its start time matches. Identity is checked
// immediately before every signal. Process inspection is passed in, so test-journey-policy.mjs can mock it.
import { spawnSync } from 'node:child_process'

/** The real machine: one process, every process (pid, group, start time), signals. Never by name. */
export const systemProcesses = {
  procInfo(pid) {
    const r = spawnSync('ps', ['-o', 'pid=,pgid=,lstart=', '-p', String(pid)], { encoding: 'utf8' })
    const m = r.status === 0 && r.stdout.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
    return m ? { pid: Number(m[1]), pgid: Number(m[2]), started: m[3].trim() } : null
  },
  groupMembers(pgid) {
    const r = spawnSync('ps', ['-A', '-o', 'pid=,pgid='], { encoding: 'utf8' })
    return (r.stdout || '').split('\n').map((l) => l.trim().split(/\s+/).map(Number)).filter(([p, g]) => p > 0 && g === pgid).map(([p]) => p)
  },
  kill(target, sig) { try { process.kill(target, sig) } catch {} },
}

/**
 * @param {{ entries: Array<{ kind?: string, pid?: number, pgid?: number, started?: string }>, myGroup?: number,
 *           io?: typeof systemProcesses, wait?: (ms: number) => Promise<void>, termMs?: number, killMs?: number }} o
 * @returns {Promise<{ targets: Array<{ pid: number, kind: string }>, left: Array<{ pid: number, kind: string }>, signals: Array<[number, string]> }>}
 */
export async function reapProcesses({ entries, myGroup, io = systemProcesses, wait = (ms) => new Promise((r) => setTimeout(r, ms)), termMs = 5000, killMs = 10000 }) {
  const ours = entries.filter((e) => Number.isInteger(e.pid) && e.pid > 0 && typeof e.started === 'string' && e.started)
  const same = (pid, started) => { const now = io.procInfo(pid); return !!now && now.pid === pid && now.started === started }
  const leads = (e) => e.pgid === e.pid && e.pgid !== myGroup
  // Known members: pid → { started, kind }. The recorded processes, and members seen in a group whose recorded
  // leader was alive and matched at that moment (so they were started under our leader, not under a reused id).
  const known = new Map()
  for (const e of ours) if (same(e.pid, e.started)) known.set(e.pid, { started: e.started, kind: e.kind || 'process' })
  const learn = () => {
    for (const e of ours) {
      if (!leads(e) || !same(e.pid, e.started)) continue
      for (const pid of io.groupMembers(e.pgid)) {
        if (known.has(pid)) continue
        const p = io.procInfo(pid)
        if (p && p.pgid === e.pgid && same(e.pid, e.started)) known.set(pid, { started: p.started, kind: `${e.kind || 'process'} helper` })
      }
    }
  }
  const signals = []
  const send = (target, sig) => { signals.push([target, sig]); io.kill(target, sig) }
  const signalAll = (sig) => {
    learn()
    for (const e of ours) if (leads(e) && same(e.pid, e.started)) send(-e.pgid, sig)
    for (const [pid, k] of known) if (same(pid, k.started)) send(pid, sig)
  }
  const alive = () => [...known].filter(([pid, k]) => same(pid, k.started))
  if (!known.size) return { targets: [], left: [], signals }
  learn()
  signalAll('SIGTERM')
  for (let t = 0; t < termMs && alive().length; t += 100) await wait(100)
  if (alive().length) signalAll('SIGKILL')
  for (let t = 0; t < killMs && alive().length; t += 100) await wait(100)
  return { targets: [...known].map(([pid, k]) => ({ pid, kind: k.kind })), left: alive().map(([pid, k]) => ({ pid, kind: k.kind })), signals }
}
