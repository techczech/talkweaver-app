import { spawnSync } from 'node:child_process'

export function missingPopplerTools(...tools) {
  return tools.filter((tool) => {
    const { error } = spawnSync(tool, ['-v'], { stdio: 'ignore' })
    if (error?.code === 'ENOENT') return true
    if (error) throw error
    return false
  })
}

export function reportMissingPoppler(checks, missing) {
  if (missing.length) console.log(`TEST NOT RUN: ${checks} require Poppler (${missing.join(', ')} missing)`)
}
