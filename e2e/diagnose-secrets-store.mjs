// The secrets module against the real operating-system encryption (Electron safeStorage: Keychain on
// macOS, DPAPI on Windows), in a throwaway user-data folder, with made-up values. Starts Electron on
// e2e/secrets-host (no window), waits for it, and reports its PASS lines. What it proves is listed in
// e2e/secrets-host/main.mjs; the logic under plain Node is scripts/test-secrets-store.mjs and
// scripts/test-owner-tokens.mjs. The installed app and its data are never touched.
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const electron = createRequire(import.meta.url)('electron') // the path of the pinned Electron binary
const scratch = mkdtempSync(join(tmpdir(), 'tw-secrets-host-'))
const userData = join(scratch, 'userData')
const EXPECTED = 5

const env = { ...process.env, TW_SECRETS_HOST_DIR: userData, ELECTRON_ENABLE_LOGGING: '0' }
delete env.ELECTRON_RUN_AS_NODE
mkdirSync(userData, { recursive: true })

const child = spawn(electron, [join(repo, 'e2e', 'secrets-host'), `--user-data-dir=${userData}`], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] })
let out = ''
let err = ''
child.stdout.on('data', (chunk) => { out += chunk })
child.stderr.on('data', (chunk) => { err += chunk })
const timer = setTimeout(() => { try { process.kill(child.pid) } catch { /* already gone */ } }, 90_000)
const code = await new Promise((done) => child.on('exit', (status, signal) => done(signal ? `signal ${signal}` : status)))
clearTimeout(timer)
rmSync(scratch, { recursive: true, force: true })

const lines = out.split(/\r?\n/).filter((line) => /^(PASS|FAILED|SECRETS-HOST)/.test(line))
for (const line of lines) console.log(line)
const leaked = /test-token-/.test(out) || /test-token-/.test(err)
const passed = lines.filter((line) => line.startsWith('PASS ')).length
const ok = code === 0 && passed === EXPECTED && lines.includes(`SECRETS-HOST OK ${EXPECTED}`) && !leaked
if (leaked) console.log('FAILED: a made-up secret value appeared in the host\'s output')
if (!ok && code !== 0) console.log(`FAILED: the Electron host ended with ${code}${lines.length ? '' : ' and printed no result'}`)
console.log(`\n=== SECRETS-STORE (Electron safeStorage, ${process.platform}) SUMMARY: ${passed}/${EXPECTED} passed ===`)
process.exit(ok ? 0 : 1)
