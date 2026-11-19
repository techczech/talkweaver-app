// Stand-ins for TalkWeaver's windows as an update's restart closes them (ADR-0044 §6, src/main/restart-windows.ts),
// shared by scripts/test-update-install.mjs and scripts/test-update-engine.mjs. Each kind behaves as its close route
// does in src/main/index.ts and the editor's renderer: the editor's 'close' guard and its five-second fallback
// (shortened); the renderer's close, which is the REAL lib/closeFreeze.ts (freeze, leave guard with the changed-on-disk
// sheet, save until nothing is unsaved, confirm the current revision, 'resave'); window:confirm-close as index.ts
// decides it, with main's record of saves by revision from the REAL editor-revisions.ts; window:close-kept; and
// outline:close-cancelled (release). The restart's decisions come from the real createRestartWindows; only the
// windows, their text and their disk are stand-ins.
import { EventEmitter } from 'node:events'
import { createRestartWindows } from '../../src/main/restart-windows.ts'
import { createEditorRevisions } from '../../src/main/editor-revisions.ts'
import { closeFrozen } from '../../src/renderer/src/lib/closeFreeze.ts'

export const delay = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * One app: its window list, the real restart-windows module over it, and makers for each kind of window.
 * The code before this round, one part at a time (all three false is the code as review round two found it):
 * `freeze: false`: the editor went on taking keystrokes while it closed; `settle: false`: it flushed once and
 * confirmed; `revisions: false`: main accepted "the last save did not fail" as the confirmation.
 */
export function standInApp({ fallbackMs = 20, freeze = true, settle = true, revisions = true } = {}) {
  let nextId = 1
  let revision = 0 // the window's revision counter (lib/editorRevision.ts); one per stand-in app is enough here
  const a = { windows: [], log: [], opened: 0, stopped: 0, revisions: createEditorRevisions() }
  a.live = () => a.windows.filter((w) => !w.gone)
  a.editors = () => a.live().filter((w) => w.cls === 'editor')
  /** The restart blockers the open windows raise (index.ts windowRestartBlockers). */
  a.windowBlockers = () => a.live().filter((w) => w.cls === 'blocker').map((w) => w.blocker)
  a.rw = createRestartWindows({
    windows: () => a.live(),
    id: (w) => w.id,
    classOf: (w) => w.cls,
    release: (w) => { w.releases += 1; w.frozen = false },
    stopBackground: async () => { a.stopped += 1 },
    hasEditor: () => a.editors().length > 0,
    openEditor: () => { a.opened += 1; a.editor({ kind: 'editor opened again', talk: false }) },
    log: (m) => a.log.push(m),
  })
  function base(kind, { cls, blocker = null }) {
    const w = new EventEmitter()
    Object.assign(w, { kind, id: nextId++, gone: false, cls, blocker, hidden: cls === 'helper', closeCalls: 0, releases: 0 })
    w.isDestroyed = () => w.gone
    /** The window is destroyed ('closed'), whoever closed it. */
    w.finish = () => { if (!w.gone) { w.gone = true; w.emit('closed') } }
    a.windows.push(w)
    return w
  }
  /**
   * A window with no close guard. hidden: a helper (thumbnail renderer, capture window): the restart closes it.
   * Otherwise a blocker (Tools, Settings, Capture embed, a deck's windows: window-kinds.ts): the restart never
   * closes it; it raises `blocker` (default 'window'). `route(w)` replaces its close route; `delayMs` makes the close
   * take that long.
   */
  a.plain = (kind, { hidden = false, blocker = 'window', route = null, delayMs = 0 } = {}) => {
    const w = base(kind, hidden ? { cls: 'helper' } : { cls: 'blocker', blocker })
    w.close = () => { w.closeCalls += 1; if (route) return route(w); if (delayMs) setTimeout(w.finish, delayMs); else setImmediate(w.finish) }
    return w
  }
  /** A deck window whose close offer (live session, run save, armed audio) keeps it open. */
  a.deckKeeps = (kind = 'presenter window') => a.plain(kind, { blocker: 'presenting', route: (w) => setImmediate(() => a.rw.kept(w.id)) })
  /**
   * An editor window. talk: a talk is open (else it closes at once: nothing to save). save: 'ok', 'fails' (the
   * save is refused or the disk fails; main keeps the text as unsaved and writes a recovery copy, which itself
   * fails when recovery is 'fails'), or 'hung' (the renderer never answers). saveMs: how long each save takes.
   * sheet: null, a choice the changed-on-disk sheet gets at once ('stay', 'keep', 'reload'), or 'wait' (the sheet
   * is up until the test calls w.answerSheet(choice)). w.type(text): the person types; refused while frozen.
   * duringSave(w): called once when the close's first save has started (typing during the save).
   */
  a.editor = ({ kind = 'editor', talk = true, save = 'ok', saveMs = 0, recovery = 'ok', sheet = null, duringSave = null } = {}) => {
    const w = base(kind, { cls: 'editor' })
    Object.assign(w, {
      text: talk ? 'typed text' : null, disk: talk ? 'old text' : null, savedText: talk ? 'old text' : null, recoveryCopy: null, lastUnsaved: null,
      saveFailed: false, confirmed: false, answerSheet: null, saves: 0, frozen: false, refused: [], frozenSeen: false, closedText: null,
    })
    if (talk) { a.revisions.loaded(w.id, revision); w.text = 'typed text'; revision += 1 } // the person typed after the load
    /** The person types. While frozen the keystroke is refused (Editor.tsx transactionFilter, not editable). */
    w.type = (more) => {
      if (w.gone) return false
      if (w.frozen && freeze) { w.refused.push(more); return false }
      w.text += more
      revision += 1
      return true
    }
    /** One save of the text as it stands (Editor writeQueued with its revision). */
    w.save = async () => {
      const text = w.text
      const rev = revision
      const finished = a.revisions.writeStarted(w.id, rev)
      const first = w.saves === 0
      w.saves += 1
      const wrote = delay(saveMs)
      if (first && duringSave) duringSave(w)
      await wrote
      if (save === 'ok') { w.disk = text; w.savedText = text; w.saveFailed = false; w.lastUnsaved = null; finished(true) } else {
        w.saveFailed = true
        w.lastUnsaved = text
        if (recovery === 'ok') w.recoveryCopy = text
        finished(false)
      }
    }
    w.close = () => {
      w.closeCalls += 1
      a.rw.ordinaryClose(w.id) // index.ts: the 'close' handler's first line
      if (w.confirmed) { w.closedText = w.text; setImmediate(w.finish); return }
      if (!talk) { a.rw.saved(w.id); setImmediate(w.finish); return }
      clearTimeout(w.fallback)
      // Main's five-second fallback: unchanged for an ordinary close; an update's restart keeps the window instead.
      w.fallback = setTimeout(() => {
        if (w.gone) return
        if (a.rw.timedOut(w.id)) return
        if (w.lastUnsaved !== null && recovery === 'ok') w.recoveryCopy = w.lastUnsaved
        w.confirmed = true
        w.close()
      }, fallbackMs)
      if (save === 'hung') { if (freeze) w.frozen = true; return }
      void closeFrozen({
        freeze: () => { if (freeze) { w.frozen = true; w.frozenSeen = true } },
        unfreeze: () => { w.frozen = false },
        // The leave guard: flush the typing, then the sheet when the talk changed on disk.
        leave: async () => {
          if (w.text !== w.savedText || w.saveFailed) await w.save()
          if (!sheet) return true
          clearTimeout(w.fallback) // the sheet is up: window:close-request-ack
          const choice = await new Promise((resolve) => { w.answerSheet = resolve; if (sheet !== 'wait') resolve(sheet) })
          if (choice === 'stay') return false
          if (choice === 'keep') await w.save()
          return true
        },
        settle: async () => {
          if (!settle) return
          for (let i = 0; i < 5 && w.text !== w.savedText && save === 'ok'; i++) await w.save()
          if (w.saveFailed) throw new Error('not saved')
        },
        forceSave: () => w.save(),
        revision: () => revision,
        // window:confirm-close as index.ts decides it.
        confirm: async (rev) => {
          if (w.gone) return false
          const forRestart = a.rw.waiting(w.id)
          const workSaved = !w.saveFailed
          const verdict = revisions ? a.revisions.verdict(w.id, rev, forRestart ? 'restart' : 'close') : 'saved'
          if (verdict === 'resave' && (!forRestart || workSaved)) return 'resave'
          clearTimeout(w.fallback)
          if (a.rw.confirm(w.id, verdict === 'saved' && workSaved) === 'keep') return false
          w.confirmed = true
          w.close()
          return true
        },
        kept: async () => { clearTimeout(w.fallback); a.rw.kept(w.id) }, // window:close-kept
      })
    }
    return w
  }
  return a
}
