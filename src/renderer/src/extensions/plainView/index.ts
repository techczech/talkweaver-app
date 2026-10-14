// The Plain editing view (spec T1): one extension that Editor.tsx puts in its `viewCompartment`.
// Later tickets add to plainViewExtension (concealed marks, margin, icons, placeholders); the
// options object is where they will take their inputs. Markdown mode holds today's look instead.
import type { Extension } from '@codemirror/state'
import { markdownLookExtension } from '../editorLook'
import { plainLookExtension } from './theme'
import { concealExtension } from './conceal'
import { marginExtension, type MarginMenuHandlers } from './margin'
import { hiddenLinesExtension } from './hiddenLines'
import { listMarksExtension } from './listMarks'
import { talkDetailsExtension } from './talkDetails'
import { placeholdersExtension } from './placeholders'
import { iconPicturesExtension, type IconSvgSource } from './iconPictures'
import { guardKeysExtension } from './guardKeys'
import { settleCaretExtension } from './settleCaret'
import type { EditorViewMode } from '../../../../shared/editor-view-mode'

export interface PlainViewOptions extends MarginMenuHandlers {
  /** Where icon pictures come from (`window.tw.icons.svg`). Without it a list item's `{icon=…}` stays a chip. */
  iconSvg?: IconSvgSource
  // (The margin's labels arrive through `setMarginLabels`; its menus are raised through `onLevelMenu` / `onLayoutMenu`.)
}

export function plainViewExtension(options: PlainViewOptions = {}): Extension {
  return [plainLookExtension(), concealExtension(), iconPicturesExtension(options.iconSvg), listMarksExtension(), hiddenLinesExtension(), marginExtension(options), talkDetailsExtension(), guardKeysExtension(), settleCaretExtension(), placeholdersExtension()]
}

/** What the view compartment holds for a mode. Markdown = exactly today's editor. */
export function viewModeExtension(mode: EditorViewMode, options: PlainViewOptions = {}): Extension {
  return mode === 'plain' ? plainViewExtension(options) : markdownLookExtension()
}
