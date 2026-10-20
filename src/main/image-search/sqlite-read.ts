// Read-only SQLite through the system sqlite3 binary (moved out of index.ts for the image search
// seam, ticket 10). We never bundle a native SQLite module; every query opens its database with
// -readonly and a mode=ro URI, so nothing on this path can write the archive or SlideWell's store.

import { execFile } from 'child_process'
import { existsSync } from 'fs'

const SQLITE3_CANDIDATES = ['/usr/bin/sqlite3', 'sqlite3', '/opt/homebrew/bin/sqlite3', '/opt/anaconda3/bin/sqlite3']

let cachedSqlite3: string | null | undefined
export function detectSqlite3(): string | null {
  if (cachedSqlite3 !== undefined) return cachedSqlite3
  // Bare 'sqlite3' resolves on PATH at exec time; for the others verify the file exists.
  for (const cand of SQLITE3_CANDIDATES) {
    if (cand === 'sqlite3') {
      cachedSqlite3 = cand
      return cand
    }
    if (existsSync(cand)) {
      cachedSqlite3 = cand
      return cand
    }
  }
  cachedSqlite3 = null
  return null
}

export class SqliteError extends Error {}
/** The read ran out of time: sqlite3 was killed at timeoutMs, or gave up waiting for a writer's lock. */
export class SqliteTimeoutError extends SqliteError {}

/** Per read of a store another app writes (SlideWell's, the presentation archive's): the most we wait
 *  for the owner's lock, and the hard limit after which sqlite3 is killed. The owners wait 4–5 s for a
 *  lock themselves, so a read of ours can never make a write of theirs fail. */
export const READ_BUSY_MS = 250
export const READ_LIMIT_MS = 500

// Run sqlite3 with the SQL script on stdin, no shell. Mirrors raycast runSqlite3.
// timeoutMs is a hard limit: the process is killed (SIGKILL) when it runs out, and the OS drops
// its file locks the moment it dies, so a slow read can never hold a lock past that limit.
function runSqlite3(binary: string, args: string[], script: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      binary,
      args,
      { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const said = (stderr || '').toString().trim()
          const timedOut = err.killed === true || /database is locked|database is busy/i.test(said)
          reject(new (timedOut ? SqliteTimeoutError : SqliteError)(said || err.message))
          return
        }
        resolve((stdout || '').toString())
      }
    )
    child.stdin?.end(script)
  })
}

function shellQuoteSqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}
function toParamLiteral(value: string | number | null): string {
  if (value === null) return 'NULL'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new SqliteError('Non-finite numeric param: ' + value)
    return String(value)
  }
  // NUL would end the CLI's input line mid-literal; it is never meaningful in a query value.
  return shellQuoteSqlString(value.replace(/\u0000/g, ''))
}

/** A file path as the path part of an SQLite URI: '%', '?' and '#' would otherwise be read as URI syntax. */
function uriPath(path: string, escape: boolean): string {
  return escape ? path.replace(/%/g, '%25').replace(/\?/g, '%3f').replace(/#/g, '%23') : path
}

// Parameterised read-only query. The sqlite3 CLI cannot take out-of-band bind values, so each
// ? is replaced by a hardened SQL literal (numbers verified finite; strings single-quote
// escaped by doubling every quote → user input is always data, never syntax).
// One call = one sqlite3 process = one connection, closed when the process exits (or is killed at
// timeoutMs). busyTimeoutMs waits out a writer's lock (SlideWell writes its store while we read it);
// escapePaths makes a path holding '%', '?' or '#' safe inside the mode=ro URI. Both are off for
// the archive's own queries, which run exactly as they always have.
export async function sqliteQuery<T = Record<string, string>>(opts: {
  binary: string
  dbPath: string
  sql: string
  params?: Array<string | number | null>
  attach?: Record<string, string>
  timeoutMs?: number
  busyTimeoutMs?: number
  escapePaths?: boolean
}): Promise<T[]> {
  const params = opts.params ?? []
  let i = 0
  const inlined = opts.sql.replace(/\?/g, () => {
    if (i >= params.length) throw new SqliteError('More ? placeholders than params')
    return toParamLiteral(params[i++])
  })
  if (i !== params.length) throw new SqliteError(`Placeholder count (${i}) != params length (${params.length})`)

  const escape = opts.escapePaths === true
  const lines: string[] = []
  // `.timeout` is a CLI dot-command: it sets the busy timeout without printing a result row.
  if (opts.busyTimeoutMs) lines.push(`.timeout ${Math.max(0, Math.floor(opts.busyTimeoutMs))}`)
  for (const [schema, path] of Object.entries(opts.attach ?? {})) {
    lines.push(`ATTACH DATABASE ${shellQuoteSqlString('file:' + uriPath(path, escape) + '?mode=ro')} AS ${schema};`)
  }
  lines.push(inlined.trim().endsWith(';') ? inlined : inlined + ';')
  const script = lines.join('\n')

  const dbUri = 'file:' + uriPath(opts.dbPath, escape) + '?mode=ro'
  const stdout = await runSqlite3(opts.binary, ['-json', '-readonly', dbUri], script, opts.timeoutMs ?? 8000)
  const trimmed = stdout.trim()
  if (!trimmed) return []
  try {
    return JSON.parse(trimmed) as T[]
  } catch {
    throw new SqliteError('sqlite3 returned non-JSON output: ' + trimmed.slice(0, 200))
  }
}
