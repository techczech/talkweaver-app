type RecordingEditSave<T> = { ok: true; edits: T } | { ok: false; error: string }

/** Main already waits for the lock. Keep a refused operation for the person's Retry. */
export async function saveRecordingEdit<T>(
  attempt: () => Promise<RecordingEditSave<T>>
): Promise<RecordingEditSave<T>> {
  try {
    return await attempt()
  } catch {
    return { ok: false, error: 'TalkWeaver could not save this edit.' }
  }
}
