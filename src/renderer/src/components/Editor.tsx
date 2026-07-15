import { useEffect, useRef, useCallback } from 'react'
import { imageWidgetExtension } from '../extensions/imageWidget'
import {
  getCursorListItemContext,
  minimalChange,
  moveNode,
  reLevel,
  moveBlockTo,
  normalizeTriggersCommand,
  deleteSlideAtCursor,
  type CursorListItemContext
} from '../extensions/outliner'
import { buildEditorKeyBindings, KEYMAP_CHANGED_EVENT } from '../keymap/store'
import { outlineFoldService } from '../extensions/outlineFold'
import { frontmatterTableExtension } from '../extensions/frontmatterTable'
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view'
import { EditorState, EditorSelection, Prec, Compartment } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, undo, redo } from '@codemirror/commands'
import { search, searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import {
  syntaxHighlighting,
  defaultHighlightStyle,
  foldGutter,
  codeFolding,
  foldKeymap,
  foldAll,
  unfoldAll
} from '@codemirror/language'
import type { TalkInfo } from '../../../preload/index'
import { notify } from '../lib/notify'
import { triggerCompleteExtension } from '../extensions/triggerComplete'
import { tokenProtectExtension } from '../extensions/idProtect'
import {
  commitLayoutSelection,
  commitPickerOption,
  provisionalTriggerAtCursor,
  selectionFromTriggerLine,
  toggleLayoutSelection,
  type LayoutPickerContext
} from './layoutPickerModel'
import { LAYOUTS, type LayoutDef, type OptionGroup } from '../data/layouts'
import { headingHasChildSlides, logicalTriggerBlockAfterHeading } from '../../../shared/trigger-line'
import { planEditorTriggerCommit } from '../extensions/inlineTriggerCommitModel'
import { headingLineForSlideId } from './inspectorModel'
import {
  focusScopeExtension,
  setFocusRange,
  FOCUS_SCOPE_EVENT,
  type FocusRange
} from '../extensions/focusScope'

type AddVideoResult = {
  success: boolean
  id?: string
  origin?: 'gif' | 'video' | 'image'
  warning?: string
  error?: string
}

// Markdown for an ingested media result (ADR-0028). GIF-origin clips carry the EXPLICIT ambient set
// {autoplay}{loop}{muted} so the compiler maps tokens → <video> attributes mechanically (no "loop
// implies autoplay" inference). MP4 and static-GIF-fallback images get a bare ref (manual/controls).
function mediaMarkdown(res: AddVideoResult | null | undefined): string | null {
  if (!res || !res.success || !res.id) return null
  if (res.origin === 'gif') return '![](' + res.id + '){autoplay}{loop}{muted}'
  return '![](' + res.id + ')'
}

// Splice an ingested clip into the doc at `pos` (or the caret), surfacing failures/warnings as toasts
// so media ingestion never fails silently (ADR-0023).
function insertMediaResult(view: EditorView | null, res: AddVideoResult | null | undefined, pos: number | 'caret'): void {
  if (!res || !res.success) { notify('Could not add media: ' + (res?.error || 'unknown error'), 'error', 'addmedia'); return }
  if (res.warning) notify(res.warning, 'info', 'addmedia')
  const md = mediaMarkdown(res)
  if (!md || !view) return
  const at = pos === 'caret' ? view.state.selection.main.head : pos
  const line = view.state.doc.lineAt(at)
  view.dispatch({
    changes: { from: line.to, insert: '\n' + md + '\n' },
    selection: { anchor: line.to + ('\n' + md).length }
  })
}

interface Props {
  talk: TalkInfo
  content: string
  onContentChange: (content: string) => void
  onSaved?: () => void
  /** Save-health signal: true on a real user edit (autosave pending), false once it reaches disk.
   *  A refused/failed save never reports false — the status bar keeps showing unsaved. */
  onDirty?: (dirty: boolean) => void
  vaultRoot?: string | null
  /** Jump target. takeFocus=true moves keyboard focus into the editor (sidebar/⌘E jumps);
   *  false only aims the viewport/caret (strip card clicks keep their own keyboard nav). */
  focusLine?: { line: number; takeFocus: boolean } | null
  // Slide Focus (ADR-0032, Task 8): when set, the editor shows/edits ONLY this slide's line range
  // (absolute doc offsets [from, to)); every other line is hidden and edit-guarded — a scoped view
  // onto the SAME outline doc, never a copy. null / undefined = normal full-outline editing (today's
  // behaviour, fully inert). Task 9 drives this from the Slide Focus surface.
  focusRange?: FocusRange | null
  onCursorLine?: (line: number) => void
  onImageWidgetClick?: (id: string) => void
  // Imperative insert-at-cursor channel (ADR-0013 cross-talk reuse).
  // On mount, Editor calls registerInsert(fn). The parent stores `fn` and may call
  // it later — e.g. when the cross-talk search palette inserts a hit — with the
  // markdown to splice in. `fn(text)` inserts `text` at the CURRENT selection head
  // (surrounded by blank lines so the imported slide stays its own block) and the
  // resulting docChanged drives onContentChange + autosave, so the doc and on-disk
  // file stay in sync without the parent rewriting the whole outline. Unlike the
  // onSlashCommand insertFn (which replaces the trigger line in place), this is a
  // free insert at wherever the caret is. Editor re-registers if the prop changes.
  registerInsert?: (fn: (text: string) => void) => void
  // Lets the app drive editor-only commands (fold/unfold all) from the command palette.
  registerEditorCommands?: (cmds: {
    foldAll: () => void
    unfoldAll: () => void
    move: (line: number, dir: 'up' | 'down') => void
    reLevel: (line: number, dir: -1 | 1, withSubtree: boolean) => void
    moveTo: (fromLine: number, toLine: number) => void
    undo: () => void
    redo: () => void
    normalizeTriggers: () => void
    deleteSlide: () => void
    // Flush any pending debounced autosave to disk NOW and resolve once written. Slide Focus's
    // detach awaits this before calling ledger.detach so the engine reads the just-typed text, not
    // a stale on-disk copy (the progress ledger flagged this detach-vs-autosave race).
    flushSave: () => Promise<void>
    // Scroll the editor to reveal the current cursor (selection head) WITHOUT changing the selection,
    // and focus it. Used when a view switch re-shows the editor so it lands on the slide you're on
    // (the cursor is wherever strip/grid/outline navigation last put it) instead of snapping to the top.
    scrollCursorIntoView: () => void
    // Viewport coordinates of the caret (below the caret line), for anchoring the ⌘K slide
    // context menu near the caret's slide. Null when the caret is scrolled out of the viewport
    // (the caller falls back to a toolbar anchor).
    cursorCoords: () => { x: number; y: number } | null
    // Move the caret to the document position under viewport (x, y) — the right-click path of
    // the slide context menu, so "the current slide" is the slide under the pointer.
    placeCursorAtCoords: (x: number, y: number) => void
    // Clipboard for the slide context menu's Text rows. Cut/copy defer to the browser command
    // (CodeMirror's own clipboard handlers run); paste splices the clipboard text at the selection.
    cutSelection: () => void
    copySelection: () => void
    pasteClipboard: () => void
  }) => void
  // Icon picker (ADR-0021): on mount Editor registers a reader that returns the CURRENT caret's
  // top-level list-item context ({heading, occurrence, itemIndex}) — or null when the caret is not
  // in a list bullet. The picker calls it when opened to know which bullet a chosen glyph pins to.
  registerIconContext?: (fn: () => CursorListItemContext | null) => void
  // Replace the WHOLE doc with programmatically-rewritten text (e.g. after an icon is pinned)
  // WITHOUT remounting — so the caret + scroll stay put instead of snapping to the top of the file.
  registerReplaceDoc?: (fn: (text: string) => void) => void
  // ⌘L layout picker: places a bare layout trigger on the CURRENT slide's Trigger line (no slash to
  // clean up). The parent opens the picker and calls this with the chosen trigger.
  registerLayoutContext?: (fn: () => LayoutPickerContext | null) => void
  registerApplyLayout?: (fn: (initial: LayoutDef[], selected: LayoutDef[]) => void) => void
  registerApplyOption?: (fn: (entry: LayoutDef | undefined, group: OptionGroup, token: string, headingLine?: number, slideId?: string | null) => string | null) => void
  // Protected-token click (2026-07-03): clicking a `{…}` chip reports the token instead of
  // placing a cursor inside it — the parent routes id → where-used panel, trigger → ⌘L picker.
  onProtectedTokenClick?: (token: string, kind: 'id' | 'trigger') => void
}

// Outliner keyboard extension (ADR-0019). Built from the single-source-of-truth registry (+ any
// user overrides from Settings) so the bindings and the Ctrl-/ help popup can never drift. Held in
// a Compartment so a Settings change re-binds live, without remounting the editor. Bound at highest
// precedence so the chords override CodeMirror's default selection-extension bindings. The registry
// documents WHY these chords were chosen (no Ctrl+Arrow — macOS reserves it for Mission Control).
const keymapCompartment = new Compartment()

// history() lives in a Compartment so a talk switch can RESET the undo stack: detaching and
// re-attaching the extension discards its state. Without this, the load's content-replacing
// dispatch is itself undoable — ⌘Z right after opening a talk reverted the doc to the previous
// talk's text (or empty), and with the path marked loaded, autosave could write THAT to the
// new talk's file (live finding 2026-07-11; same hazard class as the 2026-07-05 empty write —
// and the cross-talk variant would sail past the empty-over-nonempty backstop).
const historyCompartment = new Compartment()
function outlinerKeymapExtension() {
  return keymapCompartment.of(Prec.highest(keymap.of(buildEditorKeyBindings())))
}

// Warm paper theme — matches the slide palette from html-presentations
const twTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '14px',
    fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
    background: '#f7f3ea'
  },
  '.cm-content': {
    padding: '16px 20px',
    caretColor: '#0b3a6b'
  },
  '.cm-line': { lineHeight: '1.7', color: '#17202a' },
  '.cm-gutters': {
    backgroundColor: '#f0ebe0',
    borderRight: '1px solid #d9d0c1',
    color: '#8a9099'
  },
  '.cm-activeLineGutter': { backgroundColor: '#e4ddd0' },
  '.cm-activeLine': { backgroundColor: '#e8e3d6' },
  '&.cm-focused .cm-cursor': { borderLeftColor: '#0b3a6b', borderLeftWidth: '2px' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: '#0b3a6b22'
  },
  '.cm-matchingBracket': { backgroundColor: '#0b3a6b15', outline: '1px solid #0b3a6b30' }
}, { dark: false })

export default function Editor({
  talk,
  onContentChange,
  onSaved,
  onDirty,
  vaultRoot,
  focusLine,
  focusRange,
  onCursorLine,
  onImageWidgetClick,
  registerInsert,
  registerEditorCommands,
  registerIconContext,
  registerReplaceDoc,
  registerLayoutContext,
  registerApplyLayout,
  registerApplyOption,
  onProtectedTokenClick
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const provisionalTriggerRef = useRef<{ before: string; from: number; to: number } | null>(null)
  const rollingBackProvisionalRef = useRef(false)
  const currentTalkRef = useRef<string>('')
  // Data-loss guard (2026-07-05): the path whose REAL content is loaded and live in the doc, or null
  // while a load is in flight. The editor is remounted on every talk switch / reorderNonce bump, so a
  // fresh instance starts with `doc: ''`; autosave must stay OFF during that transient (and during the
  // load's own content-replacing dispatch) so the empty doc can never be mistaken for a user edit and
  // written to disk. Set null when a load starts; set to the path only AFTER its content is dispatched.
  const loadedPathRef = useRef<string | null>(null)
  const onCursorLineRef = useRef(onCursorLine)
  useEffect(() => { onCursorLineRef.current = onCursorLine }, [onCursorLine])
  const onDirtyRef = useRef(onDirty)
  useEffect(() => { onDirtyRef.current = onDirty }, [onDirty])
  const onImageWidgetClickRef = useRef(onImageWidgetClick)
  useEffect(() => { onImageWidgetClickRef.current = onImageWidgetClick }, [onImageWidgetClick])
  const onProtectedTokenClickRef = useRef(onProtectedTokenClick)
  useEffect(() => { onProtectedTokenClickRef.current = onProtectedTokenClick }, [onProtectedTokenClick])

  // Heading-is-slide (Task 8): a save may come back with `content` — the STAMPED text the main
  // process actually wrote ({id=…} minted for id-less headings). Adopt it into the buffer so the
  // NEXT save sends already-stamped text; without adoption every save would re-send the unstamped
  // buffer (id churn is then only held off by the main process's id-reuse fallback). Adoption is
  // dropped when the doc moved on during the IPC round-trip — a minimalChange computed against
  // stale text could clobber what the user just typed; convergence then relies on id reuse until
  // a quieter save lands. The dispatch preserves caret + scroll (minimalChange, same pattern as
  // registerReplaceDoc / mergeTrigger below) and DOES re-enter the updateListener → one follow-up
  // autosave of the stamped text — a fixpoint (stamping stamped text is a no-op), never a loop.
  const adoptStampedContent = useCallback((sentText: string, res: { ok: boolean; content?: string } | false) => {
    if (!res || res.ok !== true || typeof res.content !== 'string' || res.content === sentText) return
    const view = viewRef.current
    if (!view) return
    if (view.state.doc.toString() !== sentText) return // doc moved on while saving: drop, don't clobber
    const ch = minimalChange(sentText, res.content)
    view.dispatch({
      // Let CodeMirror map the live selection through the insertion. Restoring the old absolute
      // offset moved the caret backwards whenever ID stamping inserted bytes before it.
      changes: { from: ch.from, to: ch.to, insert: ch.insert }
    })
  }, [])

  const scheduleAutosave = useCallback(
    (outlinePath: string, content: string) => {
      // NEVER autosave an empty / whitespace-only doc: an outline never legitimately becomes empty via
      // autosave, so this can only ever be the remount/`doc:''` transient (data-loss guard). The main
      // process also refuses an empty-over-nonempty write — belt-and-braces.
      if (content.trim() === '') return
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      saveTimerRef.current = setTimeout(async () => {
        saveTimerRef.current = null
        const res = await window.tw.talk.writeOutline(outlinePath, content)
        // Save-indicator honesty (2026-07-05): only stamp "saved" on a REAL write. If the main-process
        // backstop refused (structurally-empty over a non-empty file), the disk is unchanged — say so
        // instead of a false "saved just now". `res === false` is an IO failure (also not a save).
        if (res && res.ok === true) {
          onSaved?.()
          adoptStampedContent(content, res)
        }
        else if (res && res.ok === false) {
          notify('Save skipped — the app refused to overwrite the outline with empty content. Your file on disk is unchanged.', 'warning', 'save-refused')
        }
        else {
          // IO failure (write threw: permissions, disk, file vanished). Without this the status
          // bar keeps ageing "Saved Xm ago" while every keystroke is silently lost.
          notify('Save FAILED — the outline could not be written to disk. Your recent edits are not saved.', 'error', 'save-failed')
        }
      }, 1500)
    },
    [onSaved, adoptStampedContent]
  )

  // Mount editor once
  useEffect(() => {
    if (!containerRef.current) return

    const rollbackProvisionalTrigger = (view: EditorView): boolean => {
      const provisional = provisionalTriggerRef.current
      if (!provisional) return false
      provisionalTriggerRef.current = null
      rollingBackProvisionalRef.current = true
      const current = view.state.doc.toString()
      const change = minimalChange(current, provisional.before)
      view.dispatch({
        changes: { from: change.from, to: change.to, insert: change.insert },
        selection: EditorSelection.cursor(Math.min(provisional.from, provisional.before.length))
      })
      return true
    }

    const view = new EditorView({
      parent: containerRef.current,
      state: EditorState.create({
        doc: '',
        extensions: [
          EditorView.domEventHandlers({
            paste(event: ClipboardEvent) {
              const items = event.clipboardData?.items
              if (!items) return false
              for (const item of Array.from(items)) {
                const isGif = item.type === 'image/gif'
                const isVideo = item.type.startsWith('video/')
                // Video + animated-GIF route to the media pipeline (ADR-0028); GIFs must NOT go
                // through the image path (sharp would flatten them to a single WebP frame).
                if (isVideo || isGif) {
                  event.preventDefault()
                  const blob = item.getAsFile()
                  if (!blob) return true
                  const ext = isGif ? 'gif' : item.type.replace('video/', '')
                  blob.arrayBuffer().then(async (bytes) => {
                    const res = await window.tw.asset.addVideo({ bytes, ext })
                    insertMediaResult(viewRef.current, res, 'caret')
                  }).catch(console.error)
                  return true
                }
                if (item.type.startsWith('image/')) {
                  event.preventDefault()
                  const blob = item.getAsFile()
                  if (!blob) return true
                  const ext = item.type.replace('image/', '').replace('jpeg', 'jpg')
                  blob.arrayBuffer().then(async (arrayBuffer) => {
                    const result = await window.tw.asset.pasteImage(arrayBuffer, ext)
                    if (result && viewRef.current) {
                      const pos = viewRef.current.state.selection.main.head
                      const line = viewRef.current.state.doc.lineAt(pos)
                      const id = result.id  // already "img-XXXXXXX"
                      viewRef.current.dispatch({
                        changes: { from: line.to, insert: '\n![](' + id + ')\n' }
                      })
                    } else if (!result) {
                      // Same never-fail-silently rule as clips (ADR-0023) — a paste that inserts
                      // nothing with no feedback reads as "the paste didn't register".
                      notify('Could not paste the image — it was not added to the outline.', 'error', 'addmedia')
                    }
                  }).catch((e) => { console.error(e); notify('Could not paste the image — it was not added to the outline.', 'error', 'addmedia') })
                  return true
                }
              }
              // Text paste of slide markdown: relative image refs (assets/X.png) come from the
              // SOURCE talk and would go grey here. Materialise them into the vault pool (img-<hash>)
              // by filename so a pasted SEQUENCE's images resolve (the picker does this per-slide;
              // text paste didn't). Only intercept when the text actually carries such refs.
              const pastedText = event.clipboardData?.getData('text/plain')
              if (pastedText && /!\[[^\]]*\]\(assets\/[^)]+\.(?:png|jpe?g|gif|webp)\)/i.test(pastedText)) {
                event.preventDefault()
                window.tw.talk
                  .materializePastedAssets(pastedText)
                  .then((res) => {
                    const v = viewRef.current
                    if (v) v.dispatch(v.state.replaceSelection(res?.markdown ?? pastedText))
                  })
                  .catch(() => {
                    const v = viewRef.current
                    if (v) v.dispatch(v.state.replaceSelection(pastedText))
                  })
                return true
              }
              return false
            },
            // Drag-and-drop a media FILE into the editor → store + insert at the drop point.
            // Video/GIF go to the media pipeline (by path, so we never pipe big bytes over IPC);
            // images keep the existing path. Text drags are left to CodeMirror's drag-to-move.
            drop(event: DragEvent) {
              const files = event.dataTransfer?.files
              if (!files || files.length === 0) return false
              const arr = Array.from(files)
              const mediaFile = arr.find((f) => f.type.startsWith('video/') || f.type === 'image/gif')
              const imageFile = arr.find((f) => f.type.startsWith('image/') && f.type !== 'image/gif')
              const v = viewRef.current
              const dropPos = v ? (v.posAtCoords({ x: event.clientX, y: event.clientY }) ?? v.state.selection.main.head) : 0
              if (mediaFile) {
                event.preventDefault()
                const ext = mediaFile.type === 'image/gif' ? 'gif'
                  : (mediaFile.type.replace('video/', '') || (mediaFile.name.split('.').pop() || '').toLowerCase())
                const path = window.tw.asset.pathForFile(mediaFile)
                window.tw.asset.addVideo({ path, ext })
                  .then((res) => insertMediaResult(viewRef.current, res, dropPos))
                  .catch((e) => { console.error(e); notify('Could not add the dropped clip — it was not added to the outline.', 'error', 'addmedia') })
                return true
              }
              if (imageFile) {
                event.preventDefault()
                const ext = imageFile.type.replace('image/', '').replace('jpeg', 'jpg')
                imageFile.arrayBuffer().then(async (buf) => {
                  const result = await window.tw.asset.pasteImage(buf, ext)
                  if (result && viewRef.current) {
                    const view = viewRef.current
                    const line = view.state.doc.lineAt(dropPos)
                    view.dispatch({
                      changes: { from: line.to, insert: '\n![](' + result.id + ')\n' },
                      selection: { anchor: line.to + ('\n![](' + result.id + ')').length }
                    })
                  } else if (!result) {
                    notify('Could not add the dropped image — it was not added to the outline.', 'error', 'addmedia')
                  }
                }).catch((e) => { console.error(e); notify('Could not add the dropped image — it was not added to the outline.', 'error', 'addmedia') })
                return true
              }
              return false
            }
          }),
          lineNumbers(),
          historyCompartment.of(history()),
          highlightActiveLine(),
          syntaxHighlighting(defaultHighlightStyle),
          markdown({ base: markdownLanguage, codeLanguages: languages }),
          // Folding: collapse any heading section or list subtree (gutter arrows + Ctrl-Shift-[/]).
          codeFolding(),
          foldGutter(),
          outlineFoldService,
          // {-triggered autocomplete for layout triggers and frame modifiers (Tier 1).
          // The opening token is provisional until a completion closes it. Escape and click-away
          // restore the byte-exact pre-picker document, before autosave/id stamping can see it.
          // The extension comes first at highest precedence so scene C can use the first Escape to
          // back up from options; when no chained step is active, the rollback binding below wins.
          triggerCompleteExtension,
          Prec.highest(keymap.of([{
            key: 'Escape',
            run: (view) => rollbackProvisionalTrigger(view)
          }])),
          EditorView.domEventHandlers({
            blur: (_event, view) => {
              setTimeout(() => {
                if (!view.hasFocus) rollbackProvisionalTrigger(view)
              }, 0)
              return false
            }
          }),
          // `{id=…}` and trigger-line tokens rendered as atomic, machine-managed chips — cursor
          // skips them, delete removes a whole token, ids can't be nibbled at all, and clicking a
          // chip opens the right editor surface (where-used / ⌘L picker) instead of a caret.
          tokenProtectExtension(() => onProtectedTokenClickRef.current ?? null),
          // Slide Focus scoped view (ADR-0032, Task 8). Inert until a range is set (via the
          // focusRange prop / setFocusRange effect); then hides every line outside the focused
          // block, guards edits from touching outside it, and keeps the caret inside — composing
          // with tokenProtectExtension above (all id/trigger/heading guards stay active in-band).
          focusScopeExtension(),
          // YAML frontmatter rendered as a typed table (raw ↔ table toggle).
          frontmatterTableExtension(),
          // Plain-text find (⌘F opens the search panel) + match highlighting.
          search({ top: true }),
          highlightSelectionMatches(),
          keymap.of([...defaultKeymap, ...historyKeymap, ...foldKeymap, ...searchKeymap]),
          outlinerKeymapExtension(),
          twTheme,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              const content = update.state.doc.toString()
              if (rollingBackProvisionalRef.current) {
                rollingBackProvisionalRef.current = false
                return
              }
              const head = update.state.selection.main.head
              const provisional = provisionalTriggerAtCursor(content, head)
              if (provisional) {
                const existing = provisionalTriggerRef.current
                provisionalTriggerRef.current = {
                  before: existing?.before ?? update.startState.doc.toString(),
                  from: existing?.from ?? provisional.from,
                  to: provisional.to
                }
                return
              }
              const pending = provisionalTriggerRef.current
              if (pending && !content.slice(pending.from, head).includes('}')) {
                queueMicrotask(() => {
                  const currentView = viewRef.current
                  if (currentView && provisionalTriggerRef.current === pending) {
                    rollbackProvisionalTrigger(currentView)
                  }
                })
                return
              }
              // A completion inserted its closing brace: the edit is now authored and may cross
              // the parent/autosave boundary normally.
              provisionalTriggerRef.current = null
              onContentChange(content)
              // Autosave ONLY once this talk's real content is loaded AND the doc still belongs to the
              // active talk — never during the fresh-mount `doc:''` transient or the load's own initial
              // content dispatch (data-loss guard, 2026-07-05). scheduleAutosave also skips empty text.
              if (loadedPathRef.current && loadedPathRef.current === currentTalkRef.current) {
                onDirtyRef.current?.(true)
                scheduleAutosave(currentTalkRef.current, content)
              }
              // (The `/` auto-popup was removed — it left stray slashes behind. The layout picker is
              // now ⌘L, which places the trigger on the slide's Trigger line with no slash to clean up.
              // See registerInsertLayout below + WorkspaceLayout's global ⌘L handler.)
            }

            // Clicking elsewhere in the editor dismisses autocomplete without blurring CodeMirror.
            // Treat that exactly like backdrop click-away: the provisional token never becomes text.
            if (update.selectionSet && provisionalTriggerRef.current) {
              const pending = provisionalTriggerRef.current
              const head = update.state.selection.main.head
              if (head < pending.from || head > pending.to) {
                queueMicrotask(() => {
                  const currentView = viewRef.current
                  if (currentView && provisionalTriggerRef.current === pending) {
                    rollbackProvisionalTrigger(currentView)
                  }
                })
              }
            }

            // Report the 1-based line of the main cursor on selection change.
            if (update.selectionSet && onCursorLineRef.current) {
              const head = update.state.selection.main.head
              const lineNumber = update.state.doc.lineAt(head).number
              onCursorLineRef.current(lineNumber)
            }
          }),
          imageWidgetExtension({
            vaultRoot: vaultRoot ?? null,
            // currentTalkRef holds the active outline path; derive its dir (reused across talks).
            talkDir: () => currentTalkRef.current.replace(/\/[^/]*$/, '') || null,
            onClick: (id) => onImageWidgetClickRef.current?.(id)
          }),
          EditorView.lineWrapping
        ]
      })
    })

    viewRef.current = view

    return () => {
      // Cancel any pending autosave from THIS instance before it unmounts. A stale timer that fired
      // after the remount could write into the next instance's `doc:''` transient, or clobber the
      // authoritative text a reorder/detach/publish flow just wrote to disk before remounting — those
      // flows persist their own content, so the editor's pending save is redundant here (data-loss
      // guard, 2026-07-05).
      if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null }
      view.destroy()
      viewRef.current = null
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Re-bind the outliner keymap live when the user customises shortcuts in Settings.
  useEffect(() => {
    function reconfigure(): void {
      const v = viewRef.current
      if (!v) return
      v.dispatch({
        effects: keymapCompartment.reconfigure(Prec.highest(keymap.of(buildEditorKeyBindings())))
      })
    }
    window.addEventListener(KEYMAP_CHANGED_EVENT, reconfigure)
    return () => window.removeEventListener(KEYMAP_CHANGED_EVENT, reconfigure)
  }, [])

  // Slide Focus (ADR-0032, Task 8): push the focusRange prop into the editor's focus-scope field via
  // an effect — no remount, no compartment churn. undefined/null exits focus (the extension is then
  // fully inert). Task 9 supplies this prop from the Slide Focus surface; today nothing sets it.
  useEffect(() => {
    const v = viewRef.current
    if (v) setFocusRange(v, focusRange ?? null)
  }, [focusRange])

  // e2e seam (mirrors KEYMAP_CHANGED_EVENT): the diagnose harness drives focus by dispatching a
  // `tw-focus-scope` window event carrying {from,to} | null, so the scoped view can be exercised in
  // real Electron before Task 9's Slide Focus surface exists. Harmless in production (nobody else
  // dispatches it).
  useEffect(() => {
    function onFocusEvent(e: Event): void {
      const v = viewRef.current
      if (!v) return
      const detail = (e as CustomEvent).detail as FocusRange | null | undefined
      setFocusRange(v, detail ?? null)
    }
    window.addEventListener(FOCUS_SCOPE_EVENT, onFocusEvent)
    return () => window.removeEventListener(FOCUS_SCOPE_EVENT, onFocusEvent)
  }, [])

  // Load content when talk changes
  useEffect(() => {
    currentTalkRef.current = talk.outlinePath
    // Autosave stays OFF until this talk's content is actually in the doc, and any timer still pending
    // from the previous talk/instance is cancelled — so neither the empty transient nor a stale save
    // can write during the load (data-loss guard, 2026-07-05).
    loadedPathRef.current = null
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null }
    const pathAtLoad = talk.outlinePath
    async function load() {
      const content = await window.tw.talk.readOutline(pathAtLoad)
      // Guard the whole apply against a remount that happened while readOutline was in flight: only
      // apply if the view is still alive AND still bound to the path we read (currentTalkRef moved on
      // otherwise). The content-replacing dispatch runs while loadedPathRef is null, so its docChanged
      // never triggers autosave; we mark the path loaded ONLY after that dispatch lands.
      if (viewRef.current && content !== null && currentTalkRef.current === pathAtLoad) {
        viewRef.current.dispatch({
          changes: { from: 0, to: viewRef.current.state.doc.length, insert: content }
        })
        // RESET the undo stack across the talk boundary: detach + re-attach history() so the
        // load dispatch above (and every edit belonging to the PREVIOUS talk) is not undoable
        // in this one. ⌘Z in a freshly opened talk must be a no-op, never a revert-to-empty.
        viewRef.current.dispatch({ effects: historyCompartment.reconfigure([]) })
        viewRef.current.dispatch({ effects: historyCompartment.reconfigure(history()) })
        loadedPathRef.current = pathAtLoad
        onContentChange(content)
      }
    }
    load()
  }, [talk.outlinePath]) // eslint-disable-line react-hooks/exhaustive-deps

  // Register the imperative insert-at-cursor channel (ADR-0013). We read the live
  // view from viewRef at call time so the splice always lands at the CURRENT caret,
  // however long after registration the parent invokes it. Inserting at the end of
  // the caret's line (with surrounding blank lines) keeps the imported slide as its
  // own block; the resulting docChanged drives onContentChange + autosave.
  useEffect(() => {
    if (!registerInsert) return
    registerInsert((text: string) => {
      const view = viewRef.current
      if (!view) return
      const head = view.state.selection.main.head
      const line = view.state.doc.lineAt(head)
      const block = text.replace(/^\n+/, '').replace(/\n+$/, '')
      const insert = '\n\n' + block + '\n'
      const at = line.to
      view.dispatch({
        changes: { from: at, insert },
        selection: { anchor: at + insert.length },
        scrollIntoView: true
      })
      view.focus()
    })
  }, [registerInsert])

  // Expose fold/unfold-all so the command palette can collapse/expand the whole outline.
  useEffect(() => {
    registerEditorCommands?.({
      foldAll: () => { const v = viewRef.current; if (v) { foldAll(v); v.focus() } },
      unfoldAll: () => { const v = viewRef.current; if (v) { unfoldAll(v); v.focus() } },
      move: (line, dir) => {
        const v = viewRef.current; if (!v) return
        const p = v.state.doc.line(Math.min(Math.max(line, 1), v.state.doc.lines)).from
        v.dispatch({ selection: EditorSelection.cursor(p) })
        moveNode(v, dir)
      },
      reLevel: (line, dir, withSubtree) => {
        const v = viewRef.current; if (!v) return
        const p = v.state.doc.line(Math.min(Math.max(line, 1), v.state.doc.lines)).from
        v.dispatch({ selection: EditorSelection.cursor(p) })
        reLevel(v, dir, withSubtree)
      },
      moveTo: (fromLine, toLine) => { const v = viewRef.current; if (v) moveBlockTo(v, fromLine, toLine) },
      // Undo/redo the editor's history — lets the grid/slides views route ⌘Z to a reorder they made
      // without the editor being focused. No view.focus() so the caller (e.g. grid) keeps focus.
      undo: () => { const v = viewRef.current; if (v) undo(v) },
      redo: () => { const v = viewRef.current; if (v) redo(v) },
      normalizeTriggers: () => { const v = viewRef.current; if (v) normalizeTriggersCommand(v) },
      deleteSlide: () => { const v = viewRef.current; if (v) { deleteSlideAtCursor(v); v.focus() } },
      // Cancel the pending debounce and write the CURRENT doc immediately, so a caller that reads the
      // file straight after (detach) never races the 1.5s autosave. No-op-safe when nothing is pending.
      flushSave: async () => {
        // Only a PENDING debounced edit needs flushing. With no timer the disk is already current, so a
        // talk switch (App flushes the OUTGOING editor before tearing it down) stays a no-op — no
        // redundant write or ledger churn, and crucially no write on a reorderNonce remount path. When
        // an edit IS pending, cancel the timer and write the CURRENT doc to the OUTGOING talk's path NOW
        // (currentTalkRef is still the outgoing talk, since flush runs before the switch) — so a sub-1.5s
        // edit made just before a talk switch is persisted, not dropped (data-loss guard, 2026-07-05).
        if (!saveTimerRef.current) return
        clearTimeout(saveTimerRef.current); saveTimerRef.current = null
        const v = viewRef.current
        if (!v) return
        const text = v.state.doc.toString()
        // Never flush an empty doc (a fresh-mount transient before load) or one whose content isn't the
        // loaded talk's yet — the caller (detach / switch) only needs the just-typed real text.
        if (text.trim() === '' || loadedPathRef.current !== currentTalkRef.current) return
        const res = await window.tw.talk.writeOutline(currentTalkRef.current, text)
        if (res && res.ok === true) {
          onSaved?.()
          // Stamped-id adoption (see adoptStampedContent). On the talk-switch flush path the view
          // may already be torn down or repointed — the helper's viewRef/doc-unchanged guards make
          // that a safe no-op (disk is stamped either way; the reload will read the stamped file).
          adoptStampedContent(text, res)
        }
        else if (res && res.ok === false) {
          notify('Save skipped — the app refused to overwrite the outline with empty content. Your file on disk is unchanged.', 'warning', 'save-refused')
        }
        else {
          notify('Save FAILED — the outline could not be written to disk. Your recent edits are not saved.', 'error', 'save-failed')
        }
      },
      scrollCursorIntoView: () => {
        const v = viewRef.current
        if (!v) return
        const head = v.state.selection.main.head
        v.dispatch({ effects: EditorView.scrollIntoView(head, { y: 'start' }) })
        v.focus()
      },
      cursorCoords: () => {
        const v = viewRef.current
        if (!v) return null
        const r = v.coordsAtPos(v.state.selection.main.head)
        return r ? { x: r.left, y: r.bottom + 4 } : null
      },
      placeCursorAtCoords: (x, y) => {
        const v = viewRef.current
        if (!v) return
        const pos = v.posAtCoords({ x, y })
        if (pos != null) v.dispatch({ selection: EditorSelection.cursor(pos) })
      },
      // Cut/copy re-focus the editor then run the browser command, so CodeMirror's own
      // clipboard handlers apply (same semantics as ⌘X/⌘C, including empty-selection rules).
      cutSelection: () => { const v = viewRef.current; if (v) { v.focus(); document.execCommand('cut') } },
      copySelection: () => { const v = viewRef.current; if (v) { v.focus(); document.execCommand('copy') } },
      pasteClipboard: () => {
        const v = viewRef.current
        if (!v) return
        v.focus()
        navigator.clipboard.readText().then(async (text) => {
          if (!text) return
          // Same source-talk asset rule as the DOM paste handler: relative image refs are
          // materialised into the vault pool so a pasted slide's images resolve here too.
          if (/!\[[^\]]*\]\(assets\/[^)]+\.(?:png|jpe?g|gif|webp)\)/i.test(text)) {
            try {
              const res = await window.tw.talk.materializePastedAssets(text)
              text = res?.markdown ?? text
            } catch { /* fall back to the raw text */ }
          }
          const view = viewRef.current
          if (view) view.dispatch(view.state.replaceSelection(text))
        }).catch(() => notify('Couldn’t read the clipboard — paste with ⌘V instead.', 'warning'))
      }
    })
  }, [registerEditorCommands, onSaved, adoptStampedContent])

  // Expose the caret's list-item context to the icon picker. Read from the LIVE view at call
  // time so it reflects wherever the caret is when the picker opens (not registration time).
  useEffect(() => {
    registerIconContext?.(() => {
      const v = viewRef.current
      return v ? getCursorListItemContext(v) : null
    })
  }, [registerIconContext])

  // The picker reads and writes the CURRENT heading's Trigger line through the shared ADR-0010
  // editor. Components/templates use the separate insert-at-cursor channel and never enter here.
  useEffect(() => {
    const target = (headingLine?: number): { headingLevel: number; headingLine: number; hasChildren: boolean; trigger: { text: string } | null; warnings: string[]; needsMerge: boolean } | null => {
      const v = viewRef.current
      if (!v) return null
      const doc = v.state.doc
      const caretLine = headingLine ?? doc.lineAt(v.state.selection.main.head).number
      if (caretLine < 1 || caretLine > doc.lines) return null
      for (let n = caretLine; n >= 1; n -= 1) {
        const heading = doc.line(n)
        const match = heading.text.match(/^(#{1,6})\s/)
        if (!match) continue
        const sourceLines = Array.from({ length: doc.lines }, (_, index) => doc.line(index + 1).text)
        const block = logicalTriggerBlockAfterHeading(sourceLines, n - 1)
        const trigger = block ? { text: block.line } : null
        const needsMerge = Boolean(block && (
          block.end > block.start + 1 || sourceLines[block.start] !== block.line
        ))
        return {
          headingLevel: match[1].length,
          headingLine: n,
          hasChildren: headingHasChildSlides(sourceLines, n - 1),
          trigger,
          warnings: block?.warnings ?? [],
          needsMerge
        }
      }
      return null
    }
    registerLayoutContext?.(() => {
      const current = target()
      return current ? {
        headingLevel: current.headingLevel,
        hasChildren: current.hasChildren,
        triggerLine: current.trigger?.text ?? ''
      } : null
    })
    registerApplyLayout?.((initial, selected) => {
      const v = viewRef.current
      const current = target()
      if (!v || !current) return
      const next = commitLayoutSelection(current.trigger?.text ?? '', initial, selected)
      if (!next || (next === current.trigger?.text && !current.needsMerge)) return
      const plan = planEditorTriggerCommit(v.state.doc.toString(), current.headingLine, () => next)
      for (const warning of plan.warnings) console.warn(warning)
      v.dispatch({ changes: plan.changes })
      v.focus()
    })
    registerApplyOption?.((entry, group, token, headingLine, slideId) => {
      const v = viewRef.current
      if (!v) return null
      // Line numbers must NEVER cross text-identity boundaries: the caller computed headingLine
      // against ITS text (saved outline state), but this doc can differ transiently (adoption
      // mid-flight after a save). Re-derive the heading from the SLIDE ID against THIS doc; if
      // the id is not present here, REFUSE — a stale line number once wrote an option onto a
      // different slide's trigger line.
      const ownHeadingLine = slideId != null
        ? headingLineForSlideId(v.state.doc.toString(), slideId)
        : headingLine ?? null
      if (slideId != null && ownHeadingLine == null) return null
      const current = target(ownHeadingLine ?? undefined)
      if (!current) return null
      const original = current.trigger?.text ?? ''
      const initial = selectionFromTriggerLine(original, LAYOUTS)
      const withEntry = entry
        ? commitLayoutSelection(original, initial, toggleLayoutSelection(initial, entry))
        : original
      const next = commitPickerOption(withEntry, group, token)
      if (!next || (next === original && !current.needsMerge)) return original
      const plan = planEditorTriggerCommit(v.state.doc.toString(), current.headingLine, () => next)
      for (const warning of plan.warnings) console.warn(warning)
      v.dispatch({ changes: plan.changes })
      return next
    })
  }, [registerApplyLayout, registerApplyOption, registerLayoutContext])

  // Replace the whole doc with rewritten text in place — preserving caret + scroll. The parent
  // uses this for tiny programmatic rewrites (icon pin) that previously remounted the editor and
  // snapped it to the top. docChanged from this dispatch drives onContentChange (→ compile/strip).
  useEffect(() => {
    if (!registerReplaceDoc) return
    registerReplaceDoc((text: string) => {
      const view = viewRef.current
      if (!view) return
      const sel = view.state.selection.main
      // Minimal change (not a full from:0,to:end replace) so CodeMirror keeps its scroll anchor —
      // an icon pin is a tiny `{icon=…}` token, so only that span changes and the viewport holds.
      const ch = minimalChange(view.state.doc.toString(), text)
      const head = Math.min(sel.head, text.length)
      view.dispatch({
        changes: { from: ch.from, to: ch.to, insert: ch.insert },
        selection: EditorSelection.cursor(head)
      })
    })
  }, [registerReplaceDoc])

  // Scroll to + place the cursor at focusLine (1-based) whenever it changes.
  useEffect(() => {
    if (focusLine == null) return
    const view = viewRef.current
    if (!view) return
    const clamped = Math.max(1, Math.min(focusLine.line, view.state.doc.lines))
    const line = view.state.doc.line(clamped)
    view.dispatch({
      selection: { anchor: line.from },
      // 'start' parks the target line at the TOP of the editor viewport — matching the slide
      // strip/preview, which already scrolls the selected card to the top. 'center' left the
      // jumped-to slide mid-screen, which read as inconsistent with the previews.
      effects: EditorView.scrollIntoView(line.from, { y: 'start' })
    })
    if (focusLine.takeFocus) view.focus()
  }, [focusLine])

  return <div ref={containerRef} className="editor-container" />
}
