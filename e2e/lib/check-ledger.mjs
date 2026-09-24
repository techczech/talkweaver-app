export function createCheckLedger(checkNames, options = {}) {
  const log = options.log ?? console.log
  const results = new Map(checkNames.map((name) => [
    name,
    { name, status: 'NOT RUN', detail: '' },
  ]))

  function record(name, pass, detail = '') {
    const current = results.get(name)
    if (!current) throw new Error(`Unknown e2e check: ${name}`)
    if (current.status !== 'NOT RUN') throw new Error(`Duplicate e2e check result: ${name}`)
    const status = pass ? 'PASS' : 'FAIL'
    results.set(name, { name, status, detail })
    log(`${status}  ${name}${detail ? `  — ${detail}` : ''}`)
  }

  function summary(label) {
    const entries = [...results.values()]
    for (const result of entries) {
      if (result.status === 'NOT RUN') log(`NOT RUN  ${result.name}`)
    }
    const passed = entries.filter((result) => result.status === 'PASS').length
    const failed = entries.filter((result) => result.status === 'FAIL').length
    const notRun = entries.filter((result) => result.status === 'NOT RUN').length
    const total = entries.length
    log(`\n=== ${label}: ${passed}/${total} passed; ${failed} failed; ${notRun} NOT RUN ===`)
    return {
      passed,
      failed,
      notRun,
      total,
      exitCode: failed === 0 && notRun === 0 ? 0 : 1,
    }
  }

  return { record, summary }
}
