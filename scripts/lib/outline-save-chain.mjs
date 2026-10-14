// The save of the open talk, from the mutation seam to the bytes in the file, built from the
// functions the app runs (src/shared/outline-save-changes.ts lists the steps and where they live):
//
//   the buffer    a CodeMirror document (EditorState, @codemirror/state): text goes in as one
//                 minimal change (lib/minimalChange.ts), as Editor.tsx registerReplaceDoc does it;
//   the tidy-up   normalizePositions over the whole buffer, put back as a minimal change;
//   stamping      stampMissingIds with the ids the file already holds as `preferred`
//                 (main process, the talk:write-outline handler);
//   the file      Buffer.from(text, 'utf8') (talk-writer.ts writeTalkFileInPlace);
//   adoption      the stamped text goes back into the buffer while it is still the text sent.
//
// Nothing here is a stand-in for a transformation: only the transport (the save queue, IPC, the
// file's lock and the guards that refuse a whole save) is left out, and it passes text on unchanged.
import { EditorState } from '@codemirror/state'
import { preferredIdsFromText, stampMissingIds } from '../../compiler/scripts/lib/12-outline-edit.mjs'
import { applyMinimalChange } from '../../src/renderer/src/lib/minimalChange.ts'
import { createOutlineMutator } from '../../src/renderer/src/lib/outlineMutation.ts'
import { normalizePositions } from '../../src/shared/outline-normalize.ts'

/** A fixed sequence for minted ids (the ids themselves are never compared). */
function sequence(seed = 1) {
  let a = seed >>> 0
  return () => {
    a = (Math.imul(a, 1664525) + 1013904223) >>> 0
    return (a + 0.5) / 4294967296
  }
}

/**
 * The open editor on a talk whose file holds `initial`. `text()` is the buffer, `file()` the file's
 * bytes read back as text, `writes` every text written to the file, in order.
 */
export function openTalk(initial, { path = 'talk.md', seed = 1 } = {}) {
  let state = EditorState.create({ doc: initial })
  let bytes = Buffer.from(initial, 'utf8')
  const rng = sequence(seed)
  const writes = []
  const text = () => state.doc.toString()
  const put = (next) => {
    const change = applyMinimalChange(text(), next)
    if (change) state = state.update({ changes: change }).state
  }
  /** Editor.tsx registerReplaceDoc with `save: true`: the text in, the buffer tidied, the text to save out. */
  const applyForSave = (next) => {
    put(next)
    const normalized = normalizePositions(text())
    put(normalized)
    return normalized
  }
  /** The talk:write-outline handler: stamp, write, and answer with the stamped text when it stamped. */
  const write = async (_path, content) => {
    let toWrite = content
    let stampedContent = null
    const stamped = stampMissingIds(content, rng, { preferred: preferredIdsFromText(bytes.toString('utf8')) })
    if (stamped?.text && stamped.stamped?.length) {
      toWrite = stamped.text
      stampedContent = stamped.text
    }
    bytes = Buffer.from(toWrite, 'utf8')
    writes.push(bytes.toString('utf8'))
    return stampedContent === null ? { ok: true, collisions: [] } : { ok: true, collisions: [], content: stampedContent }
  }
  const adopt = (sent, saved) => { if (text() === sent) put(saved) }
  const mutator = createOutlineMutator({
    bufferFor: (outlinePath) => (outlinePath !== path ? null : {
      read: () => text(),
      apply: (_path, next) => applyForSave(next),
      adopt: (_path, sent, saved) => adopt(sent, saved)
    }),
    settled: async () => {},
    write
  })
  return {
    text,
    file: () => bytes.toString('utf8'),
    writes,
    /** The seam a surface writes through (WorkspaceLayout applyOutlineMutation). */
    apply: (mutate, options) => mutator.apply(path, mutate, options),
    /** The person types: `next` replaces the buffer. Nothing is saved until `autosave`. */
    type: (next) => put(next),
    /** The ordinary autosave (Editor.tsx scheduleAutosave, then writeQueued and adoptStampedContent). */
    autosave: async () => {
      const content = text()
      const normalized = normalizePositions(content)
      put(normalized)
      const reply = await write(path, normalized)
      if (typeof reply.content === 'string' && reply.content !== normalized) adopt(normalized, reply.content)
    }
  }
}

/** What the file holds after a save of a buffer that is exactly `text`. */
export async function savedAs(text, seed = 1) {
  const talk = openTalk('', { seed })
  talk.type(text)
  await talk.apply((current) => current, { force: true })
  return talk.file()
}

/** A talk as the app leaves it after its saves: tidied and stamped until a save changes nothing more. */
export async function asSaved(text, seed = 1) {
  const talk = openTalk('', { seed })
  talk.type(text)
  for (let round = 0; round < 6; round += 1) {
    const before = talk.text()
    await talk.autosave()
    if (talk.text() === before && talk.file() === before) return before
  }
  throw new Error('the talk did not settle after six saves')
}
