// TESTS ONLY. Loaded into a wrangler process by `--require`, which the launcher adds only when its
// `trace` argument is given (src/main/wrangler-launcher.ts; the app never gives it). Writes one JSON
// line per thing the process touches to the file named by TALKWEAVER_WRANGLER_TRACE_FILE:
//   { kind: 'file', op, path }       every path handed to an fs function (open, read, stat, list, …)
//   { kind: 'module', path }         every module file Node resolved for require()
//   { kind: 'process', file, args }  every process started (spawn, exec, execFile, fork, and the sync forms)
//   { kind: 'connect', to }          every outbound socket (host:port, or a pipe path)
// What it cannot see: what the started processes themselves do (esbuild, workerd and the shell are
// native programs), and the file reads Node's own module loader makes while searching.
'use strict'

const out = process.env.TALKWEAVER_WRANGLER_TRACE_FILE
if (out) {
  const fs = require('fs')
  const path = require('path')
  const childProcess = require('child_process')
  const net = require('net')
  const Module = require('module')
  const { fileURLToPath } = require('url')

  const writeSync = fs.writeSync
  const fd = fs.openSync(out, 'a')
  const record = (event) => { try { writeSync(fd, `${JSON.stringify(event)}\n`) } catch { /* the trace must never break the run */ } }
  const asPath = (value) => {
    try {
      if (typeof value === 'string') return path.resolve(value)
      if (Buffer.isBuffer(value)) return path.resolve(value.toString())
      if (value instanceof URL) return fileURLToPath(value)
    } catch { /* not a path */ }
    return null
  }
  const wrap = (owner, name, onCall) => {
    const original = owner[name]
    if (typeof original !== 'function') return
    const replacement = function (...args) {
      onCall(args)
      return original.apply(this, args)
    }
    Object.defineProperties(replacement, Object.getOwnPropertyDescriptors(original))
    owner[name] = replacement
  }

  // ── files ─────────────────────────────────────────────────────────────────────────────────────
  const READS = [
    'access', 'exists', 'stat', 'lstat', 'statfs', 'open', 'openAsBlob', 'readFile', 'readdir', 'opendir', 'readlink', 'realpath',
    'createReadStream', 'watch', 'watchFile', 'cp', 'copyFile',
  ]
  const WRITES = [
    'writeFile', 'appendFile', 'mkdir', 'mkdtemp', 'rm', 'rmdir', 'unlink', 'rename', 'symlink', 'link', 'truncate', 'chmod', 'chown',
    'utimes', 'createWriteStream',
  ]
  for (const [names, write] of [[READS, false], [WRITES, true]]) {
    for (const name of names) {
      const onCall = (op) => (args) => {
        const first = asPath(args[0])
        if (first) record({ kind: 'file', op, path: first, ...(write ? { write: true } : {}) })
        // rename/copy/link take a second path.
        if (/^(?:rename|cp|copyFile|symlink|link)/.test(name)) { const second = asPath(args[1]); if (second) record({ kind: 'file', op, path: second, write: true }) }
      }
      wrap(fs, name, onCall(name))
      wrap(fs, `${name}Sync`, onCall(`${name}Sync`))
      wrap(fs.promises, name, onCall(`promises.${name}`))
    }
  }
  wrap(fs.realpathSync, 'native', (args) => { const p = asPath(args[0]); if (p) record({ kind: 'file', op: 'realpathSync.native', path: p }) })
  wrap(fs.realpath, 'native', (args) => { const p = asPath(args[0]); if (p) record({ kind: 'file', op: 'realpath.native', path: p }) })
  Module.syncBuiltinESMExports()

  // ── modules ───────────────────────────────────────────────────────────────────────────────────
  const resolveFilename = Module._resolveFilename
  Module._resolveFilename = function (...args) {
    const resolved = resolveFilename.apply(this, args)
    if (typeof resolved === 'string' && path.isAbsolute(resolved)) record({ kind: 'module', path: resolved })
    return resolved
  }

  // ── processes ─────────────────────────────────────────────────────────────────────────────────
  // Every asynchronous start (spawn, exec, execFile, fork) ends in ChildProcess.prototype.spawn.
  wrap(childProcess.ChildProcess.prototype, 'spawn', (args) => {
    const options = args[0] || {}
    record({ kind: 'process', via: 'spawn', file: String(options.file), args: (options.args || []).map(String), cwd: options.cwd ? String(options.cwd) : undefined })
  })
  wrap(childProcess, 'spawnSync', (args) => record({ kind: 'process', via: 'spawnSync', file: String(args[0]), args: Array.isArray(args[1]) ? args[1].map(String) : [] }))
  wrap(childProcess, 'execFileSync', (args) => record({ kind: 'process', via: 'execFileSync', file: String(args[0]), args: Array.isArray(args[1]) ? args[1].map(String) : [] }))
  // exec and execSync hand a command line to the shell.
  wrap(childProcess, 'execSync', (args) => record({ kind: 'process', via: 'execSync', shell: true, file: process.platform === 'win32' ? String(process.env.ComSpec || 'cmd.exe') : '/bin/sh', args: [String(args[0])] }))
  wrap(childProcess, 'exec', (args) => record({ kind: 'process', via: 'exec', shell: true, file: process.platform === 'win32' ? String(process.env.ComSpec || 'cmd.exe') : '/bin/sh', args: [String(args[0])] }))

  // ── network ───────────────────────────────────────────────────────────────────────────────────
  wrap(net.Socket.prototype, 'connect', (args) => {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0]
    if (first && typeof first === 'object') record({ kind: 'connect', to: first.path ? `pipe:${first.path}` : `${first.host || first.hostname || 'localhost'}:${first.port}` })
    else if (typeof first === 'string') record({ kind: 'connect', to: `pipe:${first}` })
    else record({ kind: 'connect', to: `${typeof args[1] === 'string' ? args[1] : 'localhost'}:${first}` })
  })
}
