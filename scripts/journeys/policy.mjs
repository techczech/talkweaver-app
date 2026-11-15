// What counts as a pass. Pure functions over stage ledgers, so test-journey-policy.mjs can feed them made-up
// ledgers. A stage passes only when its process exited 0, every row belongs to this run, every required id is
// reported exactly once, no id is unknown, nothing FAILed, every COULD-NOT is allowed (could-not-allowed.mjs,
// condition met), and at least one check passed. A run qualifies as a release pass only when it was a full
// run (no --only) over every stage and every stage passed; a subset run is a diagnostic and never prints PASSED.

/** --only a,b → { mode: 'subset', names }; none → { mode: 'full', names: all }. An empty or unknown list is an error. */
export function parseSelection(argv, allNames) {
  const i = argv.indexOf('--only')
  if (i < 0) return { mode: 'full', names: [...allNames] }
  const raw = argv[i + 1]
  if (raw === undefined || raw.startsWith('--')) return { error: '--only needs a comma-separated list of stages' }
  const names = raw.split(',').map((s) => s.trim()).filter(Boolean)
  if (!names.length) return { error: `--only "${raw}" selects no stage; stages: ${allNames.join(', ')}` }
  const unknown = names.filter((n) => !allNames.includes(n))
  if (unknown.length) return { error: `unknown stage ${unknown.join(', ')}; stages: ${allNames.join(', ')}` }
  return { mode: 'subset', names: allNames.filter((n) => names.includes(n)) }
}

/**
 * @param {{ name: string, required: string[], rows: object[], exit: number|string|null, runId: string,
 *           allow: Record<string, { reason: string, when: (data: any) => boolean }> }} s
 */
export function judgeStage({ name, required, rows, exit, runId, allow }) {
  const problems = []
  const harness = `${name}.harness`
  if (exit !== 0) problems.push(`process exit ${exit}`)
  const seen = new Map()
  let pass = 0, fail = 0, couldNot = 0, allowed = 0
  for (const row of rows) {
    if (row.run !== runId) { problems.push(`row from another run: ${row.id ?? '(no id)'} (run ${row.run ?? 'none'})`); continue }
    if (!row.id) { problems.push(`row without an id: ${JSON.stringify(row).slice(0, 120)}`); continue }
    seen.set(row.id, (seen.get(row.id) || 0) + 1)
    if (row.id !== harness && !required.includes(row.id)) problems.push(`unknown check id ${row.id}`)
    if (row.result === 'PASS') pass++
    else if (row.result === 'FAIL') { fail++; problems.push(`FAIL ${row.id}: ${String(row.detail ?? '').slice(0, 300)}`) }
    else if (row.result === 'COULD-NOT') {
      couldNot++
      const entry = allow[row.id]
      let ok = false
      try { ok = !!entry && entry.when(row.data) === true } catch { ok = false }
      if (ok) allowed++
      else problems.push(entry ? `COULD-NOT ${row.id} outside its allowed condition: ${String(row.detail ?? '').slice(0, 200)}` : `COULD-NOT ${row.id} is not on the allow-list: ${String(row.detail ?? '').slice(0, 200)}`)
    } else problems.push(`row ${row.id} has result ${row.result}`)
  }
  for (const [id, n] of seen) if (n > 1) problems.push(`check ${id} reported ${n} times`)
  const missing = required.filter((id) => !seen.has(id))
  if (missing.length) problems.push(`not reported: ${missing.join(', ')}`)
  if (pass === 0) problems.push('no check passed')
  return { name, ok: problems.length === 0, pass, fail, couldNot, allowedCouldNot: allowed, missing, problems }
}

/** The run's verdict from its stage verdicts. extraFailures: run-level failures (temp, clean-up). */
export function judgeRun({ mode, selected, allNames, stages, extraFailures = [] }) {
  if (!selected.length) return { verdict: 'NO STAGES', qualifies: false, exitCode: 2, line: 'NO STAGES SELECTED: nothing was checked' }
  const stagesOk = stages.length === selected.length && stages.every((s) => s.ok) && selected.every((n) => stages.some((s) => s.name === n))
  const ok = stagesOk && extraFailures.length === 0
  if (mode === 'full') {
    const complete = selected.length === allNames.length && allNames.every((n) => selected.includes(n))
    if (!complete) return { verdict: 'FAILED', qualifies: false, exitCode: 1, line: 'FAILED: a full run must cover every stage' }
    return ok ? { verdict: 'PASSED', qualifies: true, exitCode: 0, line: 'PASSED (full run: qualifies for release)' }
      : { verdict: 'FAILED', qualifies: false, exitCode: 1, line: 'FAILED' }
  }
  return ok ? { verdict: 'SUBSET OK', qualifies: false, exitCode: 0, line: `SUBSET OK: ${selected.join(', ')} (diagnostic only; does not qualify for release)` }
    : { verdict: 'SUBSET FAILED', qualifies: false, exitCode: 1, line: `SUBSET FAILED: ${selected.join(', ')} (diagnostic)` }
}
