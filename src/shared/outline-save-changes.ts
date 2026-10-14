// What a save of the open talk does to its text on the way to the file. Pure: no DOM, no CodeMirror.
//
// A change that is saved at once and promises "only this changed" (title-icon-restore.ts) has to know
// that the save itself adds nothing. The save of the open talk's buffer (lib/outlineMutation.ts apply,
// `save: true`) passes the text through these, in this order, and each one can change it:
//
//   1. the editor's buffer (Editor.tsx registerReplaceDoc): the text goes into CodeMirror as one
//      minimal change. CodeMirror keeps a document as lines, so a `\r\n` or a lone `\r` put into it
//      reads back as `\n`;
//   2. the tidy-up (Editor.tsx registerReplaceDoc: normalizePositions over the whole buffer, the same
//      call the autosave and flushSave make);
//   3. id stamping (main process, the talk:write-outline handler: stampMissingIds over the whole
//      text, compiler/scripts/lib/12-outline-edit.mjs), which adds `{id=…}` under every heading
//      that has none;
//   4. the file (talk-writer.ts writeTalkFileInPlace: Buffer.from(text, 'utf8')), where half of a
//      surrogate pair standing alone becomes U+FFFD.
//
// Everything else on the way either passes the text on as it is (the mutation seam, the save queue,
// the IPC call) or refuses the whole save (outside the vault, empty over a talk with content, the
// file changed on disk). After the save, stamped text is adopted back into the buffer; with nothing
// stamped there is nothing to adopt.
//
// The answers come from the save's own functions: normalizePositions is the function the editor
// calls, and headingsMissingIds is where stampMissingIds takes its targets from (slide-blocks.mjs),
// so "would stamp" is asked without minting an id. scripts/test-layout-doctor-restore-title-icon.mjs
// runs the real chain (a CodeMirror document, normalizePositions, stampMissingIds, Buffer) and holds
// this module to it.
import { headingsMissingIds } from '../../compiler/scripts/lib/slide-blocks.mjs'
import { normalizePositions } from './outline-normalize.ts'

/** Which step of the save would change the text: the first that would, in the save's order. */
export type OutlineSaveChange = 'line-endings' | 'tidy-up' | 'ids' | 'encoding'

/** Half of a surrogate pair with no partner: UTF-8 has no bytes for it. */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

/**
 * The step of the save that would change `text`, or null when the file would hold `text` exactly.
 * Throws when the text cannot be read (a caller that writes must treat that as "would change").
 */
export function outlineSaveChange(text: string): OutlineSaveChange | null {
  if (text.includes('\r')) return 'line-endings'
  if (normalizePositions(text) !== text) return 'tidy-up'
  if (headingsMissingIds(text).length > 0) return 'ids'
  if (LONE_SURROGATE_RE.test(text)) return 'encoding'
  return null
}
