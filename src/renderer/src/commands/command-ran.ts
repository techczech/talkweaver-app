// The one notifier every route by which a command runs calls (onboarding 0.38.1 ticket 08):
// `commandRan(id)`. Commands do not pass through one function (the handler map, the editor keymap,
// the window-level key handler, the Talks panel and the tool windows each run their own), so each
// route reports here once the command has run.
//
// What it does: it names the command (a command id, the shortcut id it carries or its handler id)
// and tells main, which keeps the Guide's progress for every window. It is fire-and-forget and can
// never fail a command: nothing here throws, and nothing is awaited by the caller.
//
// Call it only when the command ran. A command that declined (a key handler returning false, a
// dialog that was cancelled) is not a run and must not tick a row.
//
// Routes that report (listed in scripts/test-command-ran.mjs, which fails when a command can run by a
// route that does not):
//   - WorkspaceLayout `commandHandlersRef` (palette, Actions here, the native menu, the Insert, Deck,
//     Tools and Present menus, the action bar): every handler is wrapped by `reportingHandlers`;
//   - WorkspaceLayout `runListedCommand` (palette, Actions here and the shortcut sheet's Run for a
//     command only a key reaches), the global key handler, the Share menu, the old slide menu;
//   - keymap/store.ts `buildEditorKeyBindings` (every editor key);
//   - App.tsx's key handler (sidebar keys, Settings), TalkList and its actions (the Talks panel);
//   - Pathways and the notes window, which report through the same preload (`window.tw.guide`);
//   - the presenter: through the preload bridge `tw-guide-command-ran` (ticket 10 wires its routes).

import { DELETING_COMMANDS, resolveCommandId } from '../../../shared/guide-chapters'

type RanListener = (id: string) => void
type TickListener = (id: string) => void
const ranListeners = new Set<RanListener>()
const tickListeners = new Set<TickListener>()

/** What the window knows about where it is: the talk's outline path, so main can tell the example vault. */
type ContextProvider = () => { outlinePath?: string | null }
let contextProvider: ContextProvider = () => ({})

/** The workspace says which talk is open. Main reads decision 12 ("only inside the example vault") from it. */
export function setCommandRanContext(provider: ContextProvider): () => void {
  contextProvider = provider
  return () => { if (contextProvider === provider) contextProvider = () => ({}) }
}

// Commands whose report is made once per session: a tick never undoes, so asking main again changes
// nothing. Commands that delete are asked every time (they depend on where they ran).
const sent = new Set<string>()

/** A command ran, by any route in any window. Safe to call with ids that belong to no chapter. */
export function commandRan(id: string, context?: { outlinePath?: string | null }): void {
  try {
    const canonical = resolveCommandId(id)
    if (canonical === null) return
    for (const listener of ranListeners) { try { listener(canonical) } catch { /* a listener never fails a command */ } }
    const deleting = DELETING_COMMANDS.has(canonical)
    if (!deleting && sent.has(canonical)) return
    const outlinePath = context?.outlinePath ?? contextProvider().outlinePath ?? undefined
    const report = window.tw?.guide?.commandRan
    if (!report) return
    void Promise.resolve(report(canonical, outlinePath ?? undefined))
      .then((outcome) => {
        if (!deleting) sent.add(canonical)
        if (outcome?.ticked) for (const listener of tickListeners) { try { listener(outcome.id ?? canonical) } catch { /* ignore */ } }
      })
      .catch(() => { /* main unavailable: nothing to tell */ })
  } catch {
    /* never fails a command */
  }
}

/** Listen for every run (any route, this window); returns the stop function. */
export function onCommandRan(listener: RanListener): () => void {
  ranListeners.add(listener)
  return () => { ranListeners.delete(listener) }
}

/** Listen for a run that ticked a row for the first time (this window); returns the stop function. */
export function onCommandTicked(listener: TickListener): () => void {
  tickListeners.add(listener)
  return () => { tickListeners.delete(listener) }
}

/**
 * Wrap a handler map so each handler reports after it ran. `ids` maps a handler id to the command it
 * runs (the handler id itself when it is a command id); a handler that throws is not a run.
 */
export function reportingHandlers<T extends Record<string, () => void>>(handlers: T, report: (handlerId: string) => void = commandRan): T {
  const out: Record<string, () => void> = {}
  for (const [handlerId, handler] of Object.entries(handlers)) {
    out[handlerId] = () => {
      handler()
      report(handlerId)
    }
  }
  return out as T
}

/** Run a function and then report the command: for a route that calls a handler directly. */
export function ran<A extends unknown[]>(id: string, fn: (...args: A) => unknown): (...args: A) => void {
  return (...args: A) => {
    fn(...args)
    commandRan(id)
  }
}
