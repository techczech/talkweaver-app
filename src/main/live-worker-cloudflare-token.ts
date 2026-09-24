import { execFile } from 'child_process'
import { homedir, userInfo } from 'os'
import { join } from 'path'

export type ExecFileResult = { stdout: string; stderr: string }

export type ExecFileRunner = (
  file: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv },
) => Promise<ExecFileResult>

type LiveWorkerCloudflareTokenResolverOptions = {
  execFile: ExecFileRunner
  env: NodeJS.ProcessEnv
  username: string
  homeDir: string
}

const LIVE_WORKER_TOKEN_KEY = 'CLOUDFLARE-WORKER-TALKWEAVERLIVE'

function runExecFile(
  file: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv },
): Promise<ExecFileResult> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { env: options.env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(error)
      else resolve({ stdout, stderr })
    })
  })
}

function isMissingExecutable(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function selectLiveWorkerToken(output: string): string {
  let secrets: unknown
  try {
    secrets = JSON.parse(output)
  } catch {
    throw new Error('bws returned invalid JSON while listing secrets.')
  }
  if (!Array.isArray(secrets)) throw new Error('bws returned an unexpected response while listing secrets.')
  const match = secrets.find((secret): secret is { key: string; value: string } => (
    typeof secret === 'object' && secret !== null
    && 'key' in secret && secret.key === LIVE_WORKER_TOKEN_KEY
    && 'value' in secret && typeof secret.value === 'string'
  ))
  const token = match?.value.trim()
  if (!token) throw new Error(`Bitwarden Secrets Manager does not contain a value for ${LIVE_WORKER_TOKEN_KEY}.`)
  return token
}

export function createLiveWorkerCloudflareTokenResolver(
  options: LiveWorkerCloudflareTokenResolverOptions,
): () => Promise<string> {
  let cachedToken: string | undefined
  return async () => {
    if (cachedToken) return cachedToken

    let bwsAccessToken = options.env.BWS_ACCESS_TOKEN?.trim()
    if (!bwsAccessToken) {
      try {
        const keychain = await options.execFile('security', [
          'find-generic-password', '-w', '-s', 'BWS_ACCESS_TOKEN', '-a', options.username,
        ], { env: options.env })
        bwsAccessToken = keychain.stdout.trim()
      } catch {
        throw new Error('BWS_ACCESS_TOKEN is not set and could not be read from macOS Keychain service BWS_ACCESS_TOKEN for the current OS user.')
      }
    }
    if (!bwsAccessToken) {
      throw new Error('BWS_ACCESS_TOKEN is not set and macOS Keychain returned an empty value for service BWS_ACCESS_TOKEN.')
    }

    const childEnv = { ...options.env, BWS_ACCESS_TOKEN: bwsAccessToken }
    let listed: ExecFileResult
    try {
      listed = await options.execFile('bws', ['secret', 'list', '--output', 'json'], { env: childEnv })
    } catch (pathError) {
      if (!isMissingExecutable(pathError)) {
        throw new Error('bws could not list secrets. Check the BWS access token and Bitwarden Secrets Manager access.')
      }
      const localBws = join(options.homeDir, '.local', 'bin', 'bws')
      try {
        listed = await options.execFile(localBws, ['secret', 'list', '--output', 'json'], { env: childEnv })
      } catch (localError) {
        if (isMissingExecutable(localError)) {
          throw new Error(`bws was not found on PATH or at ${localBws}. Install the Bitwarden Secrets Manager CLI.`)
        }
        throw new Error('bws could not list secrets. Check the BWS access token and Bitwarden Secrets Manager access.')
      }
    }

    cachedToken = selectLiveWorkerToken(listed.stdout)
    return cachedToken
  }
}

const processResolver = createLiveWorkerCloudflareTokenResolver({
  execFile: runExecFile,
  env: process.env,
  username: userInfo().username,
  homeDir: homedir(),
})

export async function resolveLiveWorkerCloudflareToken(): Promise<string> {
  return processResolver()
}
