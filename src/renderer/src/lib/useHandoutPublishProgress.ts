import { useEffect, useRef, useState } from 'react'
import { publishProgressText, type PublishProgress } from '../../../shared/publish-diagnostic'

const preparing: PublishProgress = {
  step: 'preparing', attempt: 0, filesAcknowledged: 0, filesTotal: 0, filesSent: 0, bytesSent: 0, canCancel: true,
}

export function useHandoutPublishProgress() {
  const active = useRef<string>()
  const [state, setState] = useState<{ progress: PublishProgress; beganAt: number; changedAt: number }>()
  const [observed, setObserved] = useState<typeof state>()
  const displayed = state ?? observed
  const [cancelling, setCancelling] = useState(false)
  const [now, setNow] = useState(0)
  useEffect(() => {
    if (!displayed) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [Boolean(displayed)])

  function observe(progress?: PublishProgress): void {
    const time = Date.now()
    setNow(time)
    setObserved(previous => progress ? { progress, beganAt: previous?.beganAt ?? time, changedAt: time } : undefined)
  }

  async function run<T>(invoke: (requestId: string) => Promise<T>): Promise<T> {
    const id = crypto.randomUUID()
    active.current = id
    const beganAt = Date.now()
    setNow(beganAt)
    setState({ progress: preparing, beganAt, changedAt: beganAt })
    setCancelling(false)
    const unsubscribe = window.tw.talk.onPublishProgress?.(id, progress => {
      if (active.current === id) setState({ progress, beganAt, changedAt: Date.now() })
    })
    try { return await invoke(id) }
    finally {
      unsubscribe?.()
      if (active.current === id) { active.current = undefined; setState(undefined) }
    }
  }

  async function cancel(): Promise<void> {
    const id = active.current
    if (!id || cancelling) return
    setCancelling(true)
    const accepted = await window.tw.talk.cancelHandoutPublish(id).catch(() => false)
    if (!accepted && active.current === id) setCancelling(false)
  }

  return {
    run, cancel, cancelling, observe,
    canCancel: state?.progress.canCancel === true,
    text: displayed && (cancelling ? 'Cancelling…' : publishProgressText(displayed.progress, now - displayed.changedAt)),
    elapsed: displayed ? Math.max(0, Math.floor((now - displayed.beganAt) / 1000)) : 0,
  }
}
