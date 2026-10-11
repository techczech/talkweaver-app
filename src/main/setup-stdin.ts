// Standard input for the `setup` command (setup-cli.ts): where a token or access keys come in.
//
// Piped: everything up to the end of input, at most MAX_INPUT_BYTES. In a terminal: one answer per
// prompt, typed with nothing shown (the terminal is put in raw mode, so it does not echo), the
// prompt written to standard error. What is read is returned to the caller and to nothing else: it
// is never written anywhere.
//
// Fails closed (ticket 07 fix round). Input that is too long, that could not be read, a stream that
// closed or failed before its end, Ctrl-C or an interrupt: a SecretInputError with a fixed sentence,
// never "nothing given". A terminal that cannot be put in raw mode (or has no raw mode) is never
// read at all: what is typed there would be shown. The one "nothing given" (null) is input that
// ended with nothing in it, or Return alone at the first prompt.
//
// No Electron import and erasable TypeScript only (scripts/test-setup-cli.mjs drives it with fake
// streams).

export const MAX_INPUT_BYTES = 64 * 1024

export type SecretInputFailure = 'too-long' | 'read-failed' | 'cancelled' | 'cannot-hide'

export const INPUT_TOO_LONG_ERROR = 'Standard input is too long for a token or keys. Nothing was read and nothing was done.'
export const INPUT_READ_ERROR = 'Standard input could not be read to its end. Nothing was done.'
export const INPUT_CANCELLED_ERROR = 'Cancelled. Nothing was done.'
export const CANNOT_HIDE_PREFIX = 'This terminal cannot hide what you type. Pipe the token in instead: '

export class SecretInputError extends Error {
  readonly reason: SecretInputFailure
  constructor(reason: SecretInputFailure, message: string) {
    super(message)
    this.name = 'SecretInputError'
    this.reason = reason
  }
}

/** The parts of process.stdin this needs. */
export interface SecretInput {
  isTTY?: boolean
  /** Whether the terminal is in raw mode now (tty.ReadStream keeps it). */
  isRaw?: boolean
  setRawMode?: (mode: boolean) => unknown
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown
  on(event: 'end' | 'close', listener: () => void): unknown
  on(event: 'error', listener: (error: unknown) => void): unknown
  removeAllListeners(event?: string): unknown
  resume(): unknown
  pause(): unknown
}

export interface PromptOutput {
  write(text: string): unknown
}

/** Listen for an interrupt (SIGINT) while a hidden answer is typed. Answers a function that stops. */
export type InterruptWatch = (handler: () => void) => () => void

const processInterrupts: InterruptWatch = (handler) => {
  process.once('SIGINT', handler)
  return () => { process.removeListener('SIGINT', handler) }
}

const EVENTS = ['data', 'end', 'close', 'error'] as const

/** Everything piped in; null when the input ended with nothing in it. */
function readPiped(input: SecretInput): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = []
    let size = 0
    let done = false
    const stop = (): boolean => {
      if (done) return false
      done = true
      for (const event of EVENTS) input.removeAllListeners(event)
      input.pause()
      return true
    }
    // The buffers are dropped with this closure; nothing else holds them.
    const fail = (reason: SecretInputFailure, message: string): void => { if (stop()) { parts.length = 0; reject(new SecretInputError(reason, message)) } }
    input.on('data', (chunk) => {
      if (done) return
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
      size += bytes.length
      if (size > MAX_INPUT_BYTES) { fail('too-long', INPUT_TOO_LONG_ERROR); return }
      parts.push(bytes)
    })
    input.on('end', () => { if (stop()) resolve(size > 0 ? Buffer.concat(parts).toString('utf8') : null) })
    // Closed before its end, or failed: what arrived may be cut short, so none of it is used.
    input.on('close', () => fail('read-failed', INPUT_READ_ERROR))
    input.on('error', () => fail('read-failed', INPUT_READ_ERROR))
    input.resume()
  })
}

/** One line typed in a terminal with nothing shown. '' for Return (or Ctrl-D) alone. */
function readHidden(input: SecretInput, output: PromptOutput, prompt: string, pipeHint: string, interrupts: InterruptWatch): Promise<string> {
  return new Promise((resolve, reject) => {
    // Raw mode first: a terminal that cannot hide what is typed is never read, and no prompt invites typing.
    // Node's tty.ReadStream reports a refused raw mode by emitting 'error' (not by throwing) and
    // leaves isRaw false: raw mode counts only when nothing was thrown or emitted and isRaw is true.
    let raw = false
    let refused = false
    input.on('error', () => { refused = true })
    try {
      if (typeof input.setRawMode === 'function') { input.setRawMode(true); raw = input.isRaw === true }
    } catch { raw = false }
    input.removeAllListeners('error')
    if (refused || !raw) {
      try { if (raw) input.setRawMode?.(false) } catch { /* the terminal has gone */ }
      reject(new SecretInputError('cannot-hide', `${CANNOT_HIDE_PREFIX}${pipeHint}`)); return }

    let typed = ''
    let done = false
    let stopInterrupts = (): void => {}
    const stop = (): boolean => {
      if (done) return false
      done = true
      for (const event of EVENTS) input.removeAllListeners(event)
      stopInterrupts()
      try { input.setRawMode?.(false) } catch { /* the terminal has gone */ }
      input.pause()
      output.write('\n')
      return true
    }
    const answer = (): void => { if (stop()) resolve(typed) }
    const fail = (reason: SecretInputFailure, message: string): void => { if (stop()) { typed = ''; reject(new SecretInputError(reason, message)) } }
    stopInterrupts = interrupts(() => fail('cancelled', INPUT_CANCELLED_ERROR))
    output.write(`${prompt} `)
    input.on('data', (chunk) => {
      for (const char of typeof chunk === 'string' ? chunk : chunk.toString('utf8')) {
        if (done) return
        if (char === '\r' || char === '\n') return answer()
        if (char === '\u0003') return fail('cancelled', INPUT_CANCELLED_ERROR) // Ctrl-C
        if (char === '\u0004') return answer() // Ctrl-D: what was typed, or '' (nothing given)
        if (char === '\u007f' || char === '\b') { typed = typed.slice(0, -1); continue }
        if (typed.length >= MAX_INPUT_BYTES) return fail('too-long', INPUT_TOO_LONG_ERROR)
        if (char >= ' ') typed += char
      }
    })
    input.on('end', () => fail('read-failed', INPUT_READ_ERROR))
    input.on('close', () => fail('read-failed', INPUT_READ_ERROR))
    input.on('error', () => fail('read-failed', INPUT_READ_ERROR))
    input.resume()
  })
}

/**
 * What standard input holds for the setup command. Piped: all of it. A terminal: an answer to each
 * prompt, joined by line breaks; an empty first answer means nothing given (the rest are not asked).
 * Null: nothing given. Rejects with a SecretInputError (a fixed sentence) in every other case.
 * `pipeHint`: how to pipe the value in, for a terminal that cannot hide what is typed.
 */
export async function readSecretInput(
  input: SecretInput, output: PromptOutput, prompts: readonly string[], pipeHint: string, interrupts: InterruptWatch = processInterrupts,
): Promise<string | null> {
  if (!input.isTTY) return readPiped(input)
  const answers: string[] = []
  for (const prompt of prompts) {
    const answer = await readHidden(input, output, prompt, pipeHint, interrupts)
    if (answers.length === 0 && !answer.trim()) return null
    answers.push(answer)
  }
  return answers.join('\n')
}
