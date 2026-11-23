type QuitStage = 'before-quit' | 'will-quit'

interface QuitEvent {
  readonly defaultPrevented: boolean
  preventDefault(): void
}

interface QuitApp {
  on(stage: QuitStage, listener: (event: QuitEvent) => void): unknown
  quit(): void
}

interface QuitStep {
  name: string
  stage: QuitStage
  // Synchronous steps use zero. Only a returned promise can hold up the native event.
  timeoutMs: number
  run(): void | Promise<void>
  when?(): boolean
}

type StageProgress = 'new' | 'ready-to-resume' | 'resumed'

function newAttempt() {
  return {
    holding: false,
    willQuitStarted: false,
    progress: { 'before-quit': 'new', 'will-quit': 'new' } as Record<QuitStage, StageProgress>,
  }
}

/** Native window close separates the two stages. Each stage can defer its own event once. */
export function createQuitSequence(
  app: QuitApp,
  logFailure: (name: string, error: unknown) => void,
  captureQuitVeto: () => () => void,
) {
  const steps: Record<QuitStage, QuitStep[]> = { 'before-quit': [], 'will-quit': [] }
  let attempt = newAttempt()

  function runStep(step: QuitStep): void | Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      if (step.when && !step.when()) return
      if (step.timeoutMs <= 0) {
        const unexpected = step.run()
        if (unexpected) {
          // A synchronous replay must never take another hold, even with a misconfigured step.
          void unexpected.catch(() => undefined)
          logFailure(step.name, new Error('Asynchronous quit steps require a positive timeout'))
        }
        return
      }
      // Start the ceiling before invoking the service, which may set its own timer at the same limit.
      const ceiling = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${step.timeoutMs} ms`)), step.timeoutMs)
      })
      const result = step.run()
      if (result) {
        return Promise.race([ceiling, result])
          .catch(error => logFailure(step.name, error))
          .finally(() => clearTimeout(timer))
      }
    } catch (error) {
      logFailure(step.name, error)
    }
    clearTimeout(timer)
  }

  function runStage(stage: QuitStage, event: QuitEvent): void {
    const current = attempt
    if (current.holding) {
      event.preventDefault()
      return
    }

    if (!event.defaultPrevented && runSteps()) return
    if (stage === 'before-quit') {
      const cancel = captureQuitVeto()
      // Later before-quit listeners also get a chance to veto the quit.
      setImmediate(() => { if (current === attempt && event.defaultPrevented) cancel() })
    }

    function runSteps(): boolean {
      if (stage === 'will-quit') current.willQuitStarted = true
      if (current.progress[stage] === 'ready-to-resume') {
        current.progress[stage] = 'resumed'
        if (stage === 'will-quit') return false
      }

      // A replay can enter before-quit again. Stop work opened during the wait and re-establish
      // synchronous native-close bookkeeping, with no second export hold in this attempt.
      const eligible = current.progress[stage] === 'resumed'
        ? steps[stage].filter(step => step.timeoutMs === 0)
        : steps[stage]
      for (const [index, step] of eligible.entries()) {
        const waiting = runStep(step)
        if (!waiting) continue
        event.preventDefault()
        current.holding = true
        void finish(waiting, eligible.slice(index + 1))
        return true
      }
      return false
    }

    async function finish(waiting: Promise<void>, remaining: QuitStep[]): Promise<void> {
      await waiting
      for (const step of remaining) {
        if (current !== attempt) return
        const next = runStep(step)
        if (next) await next
      }
      // Electron ignores a re-entrant quit while the native callback is unwinding.
      setImmediate(() => {
        if (current !== attempt) return
        current.holding = false
        current.progress[stage] = 'ready-to-resume'
        app.quit()
      })
    }
  }

  app.on('before-quit', event => runStage('before-quit', event))
  app.on('will-quit', event => runStage('will-quit', event))
  return {
    add(step: QuitStep): void { steps[step.stage].push(step) },
    cancel(): void {
      // Native window close has finished. Even if the updater abandons its restart,
      // do not strand a running app with its stores and watchers already closed.
      // The replayed before-quit records the native attempt again for any reopened windows.
      if (!attempt.willQuitStarted) attempt = newAttempt()
    },
  }
}
