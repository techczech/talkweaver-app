// Which microphone a recording uses (9 Nov 2026 incident: a room AV system became the Mac's default
// input mid-talk, and a resume or reconnect silently opened it instead of the laptop microphone).
//
// The rules, pure, over the device lists `navigator.mediaDevices.enumerateDevices()` gives:
//   - the inputs, by name: Chromium's "default" and "communications" entries follow whatever macOS
//     chooses, so they are never an input, never a stored choice and never a reconnect key;
//   - what Record uses: the input chosen (this session, or remembered on this Mac) when connected;
//     if it is not, the Mac's built-in microphone, and the presenter is told; if no built-in
//     microphone can be identified (no names, or a Mac without one), nothing: the presenter picks.
//     Never the system's current input, never "the first one";
//   - a list without names or ids (the page has no microphone permission yet) is not used to choose:
//     the recorder asks for permission once (that stream is stopped unused) and lists again;
//   - the recorder opens exactly the chosen device and, on a resume or a reconnect, only that same
//     device: matched by deviceId, then groupId, then name (a deviceId can change after unplugging).
//     There is no fallback to another input;
//   - a newly connected input is offered once per session.
//
// The choice is remembered by name: deviceIds are salted per page origin, so the presenter and the
// Settings window see different ids for one device, while the name is the same in both.
//
// Pure; erasable TypeScript only (node tests import it as it is).

export interface AudioInput {
  deviceId: string
  groupId: string
  label: string
}

type DeviceLike = { kind?: unknown; deviceId?: unknown; groupId?: unknown; label?: unknown }

const PSEUDO_IDS = new Set(['default', 'communications'])
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** True for Chromium's "default" / "communications" entries: whatever macOS uses now, not a device. */
export function isPseudoInput(input: Pick<AudioInput, 'deviceId'> | null | undefined): boolean {
  return !!input && PSEUDO_IDS.has(input.deviceId)
}

/** The real audio inputs of a device list: never Chromium's "default" or "communications" entries, never one without an id. */
export function audioInputs(devices: ReadonlyArray<DeviceLike> | null | undefined): AudioInput[] {
  return (devices ?? [])
    .filter((d) => d && d.kind === 'audioinput')
    .map((d) => ({ deviceId: str(d.deviceId), groupId: str(d.groupId), label: str(d.label) }))
    .filter((d) => d.deviceId && !PSEUDO_IDS.has(d.deviceId))
}

/**
 * True when this list cannot be chosen from: no real input, or one without a name (Chromium hides
 * ids and names until the page may use the microphone).
 */
export function needsPermission(devices: ReadonlyArray<DeviceLike> | null | undefined): boolean {
  const inputs = audioInputs(devices)
  return !inputs.length || inputs.some((i) => !i.label)
}

/** A name as people read it: Chromium's "Default - " prefix and surrounding space dropped. */
export function inputName(input: Pick<AudioInput, 'label'> | null | undefined): string {
  return str(input?.label).replace(/^(Default|Communications)\s+-\s+/i, '').trim()
}

/** The Mac's own microphone: "MacBook Pro Microphone", "Built-in Microphone", "… (Built-in)". */
export function isBuiltIn(input: Pick<AudioInput, 'label'>): boolean {
  return /\b(MacBook|iMac)\b|built-?in/i.test(inputName(input))
}

function builtInInput(inputs: readonly AudioInput[]): AudioInput | null {
  const builtIn = inputs.filter(isBuiltIn)
  // A headset in the jack is also "(Built-in)" on some Macs: the Mac's own microphone wins.
  return builtIn.find((i) => /\b(MacBook|iMac)\b/i.test(inputName(i)))
    ?? builtIn.find((i) => !/external|headset|headphone|line in/i.test(inputName(i)))
    ?? builtIn[0]
    ?? null
}

/**
 * What Record uses: the chosen input (this session's pick, else the name remembered on this Mac)
 * when connected; else the identified built-in microphone, with `missing` naming the one that is
 * not connected (the presenter is told); else null — no input is guessed, the presenter picks.
 */
export function inputForRecording(
  devices: ReadonlyArray<DeviceLike> | null | undefined,
  remembered = '',
  chosen: AudioInput | null = null
): { input: AudioInput; missing: string } | null {
  const inputs = audioInputs(devices)
  const picked = findSameInput(inputs, chosen)
  if (picked) return { input: picked, missing: '' }
  const wanted = (chosen && inputName(chosen)) || inputName({ label: remembered })
  if (wanted) {
    const saved = inputs.find((i) => inputName(i) === wanted)
    if (saved) return { input: saved, missing: '' }
  }
  const builtIn = builtInInput(inputs.filter((i) => i.label))
  return builtIn ? { input: builtIn, missing: wanted } : null
}

/** The input Record would use, or null (see inputForRecording). */
export function defaultInput(devices: ReadonlyArray<DeviceLike> | null | undefined, remembered = ''): AudioInput | null {
  return inputForRecording(devices, remembered)?.input ?? null
}

/**
 * The same physical device in a new list, or null: by deviceId, then groupId (shared by a device's
 * input and output, so only among inputs), then name. Never another device.
 */
export function findSameInput(inputs: readonly AudioInput[], chosen: AudioInput | null | undefined): AudioInput | null {
  // A "default" entry is never an identity: it is whatever macOS uses now.
  if (!chosen || isPseudoInput(chosen)) return null
  const real = inputs.filter((i) => i.deviceId && !PSEUDO_IDS.has(i.deviceId))
  if (chosen.deviceId) {
    const byId = real.find((i) => i.deviceId === chosen.deviceId)
    if (byId) return byId
  }
  if (chosen.groupId) {
    const byGroup = real.find((i) => i.groupId === chosen.groupId)
    if (byGroup) return byGroup
  }
  const name = inputName(chosen)
  return name ? real.find((i) => inputName(i) === name) ?? null : null
}

/** getUserMedia constraints for exactly this device. */
export function exactInputConstraints(input: Pick<AudioInput, 'deviceId'>): { audio: { deviceId: { exact: string } } } {
  return { audio: { deviceId: { exact: input.deviceId } } }
}

/**
 * Newly connected inputs, each offered once per session. The first list with names is the baseline
 * (nothing in it is new); afterwards an input whose name was never listed is new, unless it is the
 * one in use. An input that is unplugged and plugged in again is not offered again.
 */
export function createNewInputWatch(): { observe(inputs: readonly AudioInput[], inUse?: AudioInput | null): AudioInput[] } {
  let known: Set<string> | null = null
  return {
    observe(inputs, inUse) {
      const named = inputs.filter((i) => inputName(i) && !PSEUDO_IDS.has(i.deviceId))
      if (known === null) {
        if (named.length) known = new Set(named.map(inputName))
        return []
      }
      const seen = known
      const using = findSameInput(inputs, inUse)
      const fresh = named.filter((i) => !seen.has(inputName(i)) && i !== using)
      for (const i of named) seen.add(inputName(i))
      return fresh
    }
  }
}

/** The Microphone menu: every input by name, the one chosen marked. A remembered device not connected is listed as such. */
export function microphoneMenu(inputs: readonly AudioInput[], chosen: AudioInput | null): Array<{ name: string; input: AudioInput | null; selected: boolean; missing: boolean }> {
  const current = findSameInput(inputs, chosen)
  const rows: Array<{ name: string; input: AudioInput | null; selected: boolean; missing: boolean }> = inputs
    .filter((i) => inputName(i) || inputs.length === 1)
    .map((i) => ({ name: inputName(i) || 'Microphone', input: i, selected: i === current, missing: false }))
  if (chosen && !rows.some((r) => r.selected)) rows.unshift({ name: inputName(chosen) || 'Microphone', input: null, selected: true, missing: true })
  return rows
}

/**
 * Settings › Recording › Microphone as a menu: the built-in microphone (the empty value), then every
 * input by name; a remembered device that is not connected stays listed, as not connected.
 */
export function microphoneSettingOptions(inputs: readonly AudioInput[], saved: string): Array<{ value: string; label: string }> {
  const names = [...new Set(inputs.map(inputName).filter(Boolean))]
  const options = [{ value: '', label: 'Built-in microphone' }, ...names.map((name) => ({ value: name, label: name }))]
  const wanted = inputName({ label: saved })
  if (wanted && !names.includes(wanted)) options.push({ value: saved, label: `${wanted} (not connected)` })
  return options
}
