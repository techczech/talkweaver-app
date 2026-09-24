import type { RecorderController, SaveResult } from './present-recorder'

export type LiveCloseAction = 'end' | 'keep'
export interface PresentationCloseOffer {
  live: boolean
  offerRunSave: boolean
  audioArmed?: boolean
}
type CloseController = Pick<RecorderController, 'getState' | 'runGate' | 'plannedRuns' | 'currentKind' | 'saveRun' | 'stop' | 'confirmSave' | 'closeWindow'>

/** One confirmation owns both the live-session decision and saving the local run. */
export function showPresentationCloseOffer(controller: CloseController, offer: PresentationCloseOffer): void {
  if (document.querySelector('.twrec-close-modal')) return
  const previousFocus = document.activeElement as HTMLElement | null
  const audio = !!offer.audioArmed || controller.runGate().audioArmed
  const combined = audio || offer.offerRunSave
  const overlay = document.createElement('div')
  overlay.className = 'twrec-close-modal'
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-modal', 'true')
  overlay.setAttribute('aria-labelledby', 'twrec-close-title')
  overlay.innerHTML = `
    <div class="twrec-close-panel">
      <div class="twrec-close-title" id="twrec-close-title">Close presentation?</div>
      <div class="twrec-close-sub">${audio ? 'Save your recording before closing. Short recordings will be kept.' : offer.offerRunSave ? 'Save this run to History, or close without saving it.' : 'Choose whether the audience can keep using the live session.'}</div>
      ${offer.live && combined ? `<fieldset style="border:0;padding:0;margin:16px 0">
        <legend style="margin-bottom:8px">Live session</legend>
        <label style="display:block;margin:8px 0"><input type="radio" name="twrec-live-close" value="end"> End live session</label>
        <label style="display:block;margin:8px 0"><input type="radio" name="twrec-live-close" value="keep"> Keep live session</label>
      </fieldset>` : ''}
      ${offer.offerRunSave && !audio ? '<div class="twrec-planned-list" aria-label="Attach delivery to a planned run"></div><label id="twrec-close-kind-label" hidden>Run kind <select id="twrec-close-kind"><option value="delivery">Delivery</option><option value="rehearsal">Rehearsal</option><option value="recording">Recording</option></select></label>' : ''}
      <div role="alert" class="twrec-close-sub" style="color:#ffb4ab" hidden></div>
      <div class="twrec-close-row" style="flex-wrap:wrap">
        <button type="button" class="rec-btn ghost" id="twrec-close-cancel">Cancel</button>
        ${audio ? '<button type="button" class="rec-btn keep" id="twrec-close-audio">Stop and save recording</button>' : offer.offerRunSave ? `
          <button type="button" class="rec-btn keep" id="twrec-close-save">Save delivery</button>
          <button type="button" class="rec-btn ghost" id="twrec-close-save-as">Save as…</button>
          <button type="button" class="rec-btn danger" id="twrec-close-discard">Don't save</button>` : offer.live ? `
          <button type="button" class="rec-btn danger" data-live-action="end">Close and end session</button>
          <button type="button" class="rec-btn keep" data-live-action="keep">Close presentation, keep live</button>` : '<button type="button" class="rec-btn" id="twrec-close-discard">Close presentation</button>'}
      </div>
    </div>`
  document.body.appendChild(overlay)
  let busy = false
  let liveAction: LiveCloseAction | undefined
  const cancel = overlay.querySelector<HTMLButtonElement>('#twrec-close-cancel')!
  const alert = overlay.querySelector<HTMLElement>('[role="alert"]')!
  const sync = (): void => {
    overlay.querySelectorAll<HTMLButtonElement>('button').forEach(button => {
      button.disabled = busy || (button !== cancel && offer.live && combined && !liveAction)
    })
    overlay.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input,select').forEach(input => { input.disabled = busy })
  }
  const dismiss = (): void => {
    window.removeEventListener('keydown', onKey, true)
    overlay.remove()
    previousFocus?.focus()
  }
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopImmediatePropagation()
      if (!busy) dismiss()
    } else if (event.key === 'Tab') {
      const items = Array.from(overlay.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled)')).filter(item => !item.closest('[hidden]'))
      const index = items.indexOf(document.activeElement as HTMLElement)
      if (event.shiftKey && index <= 0) { event.preventDefault(); items.at(-1)?.focus() }
      else if (!event.shiftKey && (index < 0 || index === items.length - 1)) { event.preventDefault(); items[0]?.focus() }
    }
  }
  const saved = (result: SaveResult | null): void => {
    if (!result?.ok || result.discarded) throw new Error('The recording or run could not be saved. The presentation is still open; please try again.')
  }
  const run = async (save?: () => Promise<void>, action = liveAction): Promise<void> => {
    if (busy || (offer.live && !action)) return
    busy = true
    alert.hidden = true
    sync()
    try {
      await save?.()
      await controller.closeWindow(action)
      dismiss()
    } catch (error) {
      alert.textContent = error instanceof Error ? error.message : String(error)
      alert.hidden = false
    } finally {
      busy = false
      sync()
    }
  }
  cancel.addEventListener('click', () => { if (!busy) dismiss() })
  overlay.querySelectorAll<HTMLInputElement>('input[name="twrec-live-close"]').forEach(input => {
    input.addEventListener('change', () => { liveAction = input.value as LiveCloseAction; sync() })
  })
  overlay.querySelectorAll<HTMLButtonElement>('[data-live-action]').forEach(button => {
    button.addEventListener('click', () => { void run(undefined, button.dataset.liveAction as LiveCloseAction) })
  })
  overlay.querySelector('#twrec-close-save')?.addEventListener('click', () => { void run(async () => { saved(await controller.saveRun('delivery')) }) })
  overlay.querySelector('#twrec-close-discard')?.addEventListener('click', () => { void run() })
  const kindLabel = overlay.querySelector<HTMLElement>('#twrec-close-kind-label')
  const kind = overlay.querySelector<HTMLSelectElement>('#twrec-close-kind')
  if (kind) kind.value = controller.currentKind()
  overlay.querySelector('#twrec-close-save-as')?.addEventListener('click', (event) => {
    if (!kindLabel || !kind) return
    if (kindLabel.hidden) {
      kindLabel.hidden = false
      ;(event.currentTarget as HTMLButtonElement).textContent = 'Save selected kind'
      kind.focus()
    } else {
      void run(async () => { saved(await controller.saveRun(kind.value as 'delivery' | 'rehearsal' | 'recording')) })
    }
  })
  overlay.querySelector('#twrec-close-audio')?.addEventListener('click', () => {
    void run(async () => {
      const state = controller.getState()
      let result: SaveResult | null = null
      if (state === 'recording' || state === 'paused') result = await controller.stop(true)
      if (controller.getState() === 'confirm' || controller.getState() === 'error') result = await controller.confirmSave(true)
      // A prior successful save may be followed by a failed live close; retry only the close.
      if (controller.getState() !== 'saved') saved(result)
      else if (result) saved(result)
    })
  })
  if (offer.offerRunSave && !audio) {
    void controller.plannedRuns().then(planned => {
      if (!overlay.isConnected) return
      const list = overlay.querySelector('.twrec-planned-list')!
      for (const plannedRun of planned) {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'twrec-planned'
        button.textContent = [plannedRun.eventTitle || 'Planned run', plannedRun.plannedDate, plannedRun.audience].filter(Boolean).join(' · ')
        button.addEventListener('click', () => { void run(async () => { saved(await controller.saveRun('delivery', plannedRun.id)) }) })
        list.appendChild(button)
      }
      sync()
    }).catch(() => { /* saving a new run remains available */ })
  }
  window.addEventListener('keydown', onKey, true)
  sync()
  cancel.focus()
}
