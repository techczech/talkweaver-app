// The agent-skill offer as the editor window holds it: asked once from main when the window opens, shared by the
// onboarding step and the status-bar mark so they never disagree, cleared when answered.
import { useEffect, useState } from 'react'
import type { Offer } from '../../../shared/agent-skill/types'

interface Bridge {
  offer(): Promise<Offer>
  answerOffer(a: { install: string[]; decline: string[] }): Promise<unknown>
  decline(ids: string[]): Promise<unknown>
  install(ids: string[]): Promise<unknown>
  offerShown(ids: string[]): Promise<void>
}
export const agentSkillBridge = (): Bridge | undefined => (typeof window === 'undefined' ? undefined : (window as unknown as { tw?: { agentSkill?: Bridge } }).tw?.agentSkill)

let current: Offer | null = null
let asked = false
const subs = new Set<() => void>()
const publish = (next: Offer | null): void => { current = next; subs.forEach((f) => f()) }

export function useAgentSkillOffer(): [Offer | null, (next: Offer | null) => void] {
  const [, tick] = useState(0)
  useEffect(() => {
    const sub = (): void => tick((n) => n + 1)
    subs.add(sub)
    if (!asked) {
      asked = true
      void agentSkillBridge()?.offer().then((o) => { if (o.kind !== 'none') publish(o) }).catch(() => {})
    }
    return () => { subs.delete(sub) }
  }, [])
  return [current, publish]
}
