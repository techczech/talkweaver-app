// The rules the ambient-access trace test (scripts/test-wrangler-ambient-trace.mjs) judges a traced
// wrangler run by. Every rule takes the platform as an argument, so the Windows side is tested with
// literal Windows paths on any machine (scripts/test-wrangler-launcher.mjs).

/** Path helpers for one platform: Windows compares without regard to case and accepts both separators. */
export function pathRules(platform) {
  const windows = platform === 'win32'
  const norm = (path) => (windows ? String(path).replaceAll('/', '\\').toLowerCase() : String(path))
  const sep = windows ? '\\' : '/'
  const under = (path, dir) => { const p = norm(path); const d = norm(dir).replace(windows ? /\\+$/ : /\/+$/, ''); return p === d || p.startsWith(d + sep) || (d === '' && p.startsWith(sep)) }
  const same = (a, b) => norm(a) === norm(b)
  const isAncestorOf = (path, dir) => !same(path, dir) && under(dir, path)
  return { under, same, isAncestorOf }
}

/** The system's own folders: not writable by the person or by ordinary software. */
export function isSystemPath(path, { platform, systemRoot = 'C:\\Windows' }) {
  const { under } = pathRules(platform)
  if (platform === 'win32') return under(path, systemRoot)
  return ['/usr', '/bin', '/sbin', '/System', '/dev', '/etc', '/private/etc', '/proc', '/sys', '/lib', '/lib64'].some((dir) => under(path, dir))
}

/**
 * What a started process is: 'own' (the app's Node), 'esbuild' or 'workerd' (the bundled binaries,
 * inside the app root), 'git-probe' (the system shell, by absolute path, running wrangler's git
 * probe), or null for anything else, which the test fails on.
 */
export function classifyProcess(event, { platform, execPath, appRoot, systemRoot = 'C:\\Windows' }) {
  const { under, same } = pathRules(platform)
  const program = String(event.file)
  if (same(program, execPath)) return 'own'
  const bundled = /[\\/](esbuild|workerd)(?:\.exe)?$/i.exec(program)
  if (bundled && under(program, appRoot)) return bundled[1].toLowerCase()
  const shell = platform === 'win32' ? same(program, `${systemRoot}\\System32\\cmd.exe`) : program === '/bin/sh'
  const command = (event.args ?? []).join(' ')
  if (shell && /(?:^|\s|")git (?:rev-parse|status|show|log)\b/.test(command)) return 'git-probe'
  return null
}

/** A socket to this machine (or a local pipe). */
export function isLocalConnect(to) {
  return /^(?:127\.0\.0\.1|localhost|::1|\[::1\]):\d+$/.test(to) || to.startsWith('pipe:')
}
