// Where a Run's recording is (0.45, second Mac). A Run record travels with the vault; its audio and video
// stay in the app data of the Mac that recorded them. A Run saved from 0.45 on names that Mac
// (`recordedOn: { computer }`, the name the app lists this computer under for the live service); older
// Runs name none. Whether the recording is HERE is decided by looking for its files, never by the
// `uploaded` flag or by the name (two Macs can share a name). Studio's audio label and the recording
// editor's notice say one of three things:
//   the files are here                           → on this Mac
//   not here, the Run names another Mac          → Recorded on <name>. The recording is on that Mac.
//   not here, the Run names no Mac, or a Mac with this Mac's own name (this Mac after the files went, or
//   another Mac called the same: the app cannot tell which)
//                                                → The recording is not on this Mac.
//                                                  (with the name: Recorded on a Mac named <name>. …)
// Pure, no imports: main writes and reads the field; main and the renderer share the words.

/** How long a recorded computer name may be (the live service's computer names are shorter). */
export const RECORDED_ON_MAX = 80

/** The field a Run carries from 0.45 on. */
export type RecordedOn = { computer: string }

/** The `recordedOn` field to write for this computer's name, or undefined when there is no usable name. */
export function recordedOnFor(computerName: string | null | undefined): RecordedOn | undefined {
  const name = cleanName(computerName)
  return name ? { computer: name } : undefined
}

/** The computer a Run names as holding its recording, or null (older Runs, or a field that is not a name). */
export function recordedOnOf(record: unknown): string | null {
  const field = record && typeof record === 'object' ? (record as { recordedOn?: unknown }).recordedOn : undefined
  return field && typeof field === 'object' ? cleanName((field as { computer?: unknown }).computer) : null
}

function cleanName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  // eslint-disable-next-line no-control-regex
  const name = value.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return name && [...name].length <= RECORDED_ON_MAX ? name : null
}

/**
 * Where the recording is, as the screens say it. `here` comes from looking for the files.
 * `elsewhere`: not here and the Run names a Mac whose name differs from this one's;
 * `same-name`: not here and the Run names a Mac with this Mac's name; `unknown`: not here and no Mac named.
 */
export type MediaPlace =
  | { state: 'here' }
  | { state: 'elsewhere'; computer: string }
  | { state: 'same-name'; computer: string }
  | { state: 'unknown' }

const sameName = (a: string, b: string): boolean => a.normalize('NFC').toLocaleLowerCase() === b.normalize('NFC').toLocaleLowerCase()

export function mediaPlaceOf(here: boolean, recordedOn: string | null, thisComputer: string | null): MediaPlace {
  if (here) return { state: 'here' }
  if (!recordedOn) return { state: 'unknown' }
  if (thisComputer && sameName(recordedOn, thisComputer)) return { state: 'same-name', computer: recordedOn }
  return { state: 'elsewhere', computer: recordedOn }
}

export const RECORDING_NOT_HERE = 'The recording is not on this Mac.'

/** The editor's sentence when none of the Run's recorded files is on this Mac; null when they are. */
export function mediaAwaySentence(place: MediaPlace): string | null {
  switch (place.state) {
    case 'here': return null
    case 'elsewhere': return `Recorded on ${place.computer}. The recording is on that Mac.`
    case 'same-name': return `Recorded on a Mac named ${place.computer}. ${RECORDING_NOT_HERE}`
    case 'unknown': return RECORDING_NOT_HERE
  }
}

/** Studio's audio label on a Run card: the short text, the full sentence for its tooltip, and whether it is here. */
export function studioAudioLabel(place: MediaPlace, uploaded: boolean): { text: string; title: string; here: boolean } {
  if (place.state === 'here') return uploaded ? { text: 'uploaded', title: 'On this Mac, and uploaded to recording storage.', here: true } : { text: 'on this Mac', title: 'The recording is on this Mac.', here: true }
  const sentence = mediaAwaySentence(place) ?? RECORDING_NOT_HERE
  if (place.state === 'elsewhere') return { text: `on ${place.computer}`, title: sentence, here: false }
  return { text: 'not on this Mac', title: sentence, here: false }
}
