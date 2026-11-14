// Only an identified run measured in the genuine historical output can be grandfathered.
export function newFloorFailures(runs, baseline = []) {
  const old = new Map(baseline.map(run => [run.key, run]))
  return runs.filter(run => {
    const before = old.get(run.key)
    return !run.key || !before || !Number.isFinite(before.px) || !Number.isFinite(run.px) || run.px < before.px
  })
}
