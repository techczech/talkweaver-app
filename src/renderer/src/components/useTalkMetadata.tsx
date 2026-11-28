import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { isMap, parseDocument } from 'yaml'
import { isFrontmatterDelimiter, type FrontmatterEdit } from '../../../shared/frontmatter-editor'
import { notify } from '../lib/notify'

interface MetadataField {
  key: string
  aliases?: string[]
  label: string
  value: string
  present: boolean
}

interface PendingField {
  field: MetadataField
  value: string
  staged: boolean
  timer?: ReturnType<typeof setTimeout>
  refused?: boolean
}

export type CommitMetadata = (path: string, edits: FrontmatterEdit[], bases?: MetadataField[]) => boolean

function fieldEdit(field: MetadataField, value: string, raw = false): FrontmatterEdit {
  return { key: field.key, aliases: field.aliases, value: value === '' ? null : value, raw }
}

function validStructuredValue(value: string): boolean {
  if (!value) return true
  const lines = value.split(/\r?\n/)
  if (lines.some(line => isFrontmatterDelimiter(line)) ||
      lines.slice(1).some(line => !/^ /.test(line))) return false
  const document = parseDocument(`value: ${value}`)
  return document.errors.length === 0 && isMap(document.contents) && document.contents.items.length === 1
}

function changedFields(fields: PendingField[]): string {
  return fields.map(({ field }) => field.label).join(', ')
}

type LeaveChoice = 'save' | 'discard' | 'stay'

export function useTalkMetadata(path: string | undefined, commit: CommitMetadata, settle: () => Promise<void>) {
  const wiring = useRef({ path, commit, settle })
  wiring.current = { path, commit, settle }
  const edits = useRef(new Map<string, PendingField>())
  const [, redraw] = useReducer((count: number) => count + 1, 0)
  const [question, setQuestion] = useState<string | null>(null)
  const reply = useRef<((choice: LeaveChoice) => void) | null>(null)
  const saving = useRef(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const fields = edits.current
    return () => {
      for (const { timer } of fields.values()) clearTimeout(timer)
      fields.clear()
      reply.current?.('stay')
    }
  }, [path])

  const remove = useCallback((keys: Iterable<string>) => {
    for (const key of keys) {
      clearTimeout(edits.current.get(key)?.timer)
      edits.current.delete(key)
    }
    redraw()
  }, [])

  const commitText = useCallback((key: string, retryFrom?: MetadataField): boolean => {
    const pending = edits.current.get(key)
    const { path, commit } = wiring.current
    if (!pending || pending.staged) return true
    clearTimeout(pending.timer)
    pending.timer = undefined
    if (!path || saving.current) return false

    // Only an explicit retry after a refusal can use a newer value as its base.
    const base = pending.refused && retryFrom ? retryFrom : pending.field
    if (!commit(path, [fieldEdit(base, pending.value)], [base])) {
      pending.refused = true
      notify(`Couldn’t apply the change to ${base.label}. Check the current value and try again. Your edit is still here.`, 'warning', `talk-metadata:${key}`)
      return false
    }
    remove([key])
    return true
  }, [remove])

  const scheduleText = useCallback((pending: PendingField) => {
    pending.timer = setTimeout(() => commitText(pending.field.key), 600)
  }, [commitText])

  function type(field: MetadataField, value: string, staged = false): void {
    if (!path || wiring.current.path !== path) return
    clearTimeout(edits.current.get(field.key)?.timer)
    if (value === field.value) {
      remove([field.key])
      return
    }
    const pending = { field, value, staged }
    edits.current.set(field.key, pending)
    if (!staged && !saving.current) scheduleText(pending)
    redraw()
  }

  function choose(field: MetadataField, value: string): void {
    if (!path || wiring.current.path !== path) return
    if (edits.current.get(field.key)?.value !== value) type(field, value)
    commitText(field.key, field)
  }

  const flushText = useCallback((): boolean => {
    let committed = true
    for (const [key, field] of edits.current) {
      if (!field.staged && !commitText(key)) committed = false
    }
    return committed
  }, [commitText])

  const stagedFields = useCallback(() => [...edits.current.values()].filter(field => field.staged), [])
  const save = useCallback(async (): Promise<boolean> => {
    const { path, commit, settle } = wiring.current
    const staged = stagedFields()
    if (!path || staged.length === 0) return true
    if (saving.current) return false
    const invalid = staged.filter(({ value }) => !validStructuredValue(value))
    if (invalid.length) {
      notify(`Check the YAML for ${changedFields(invalid)}. Indent each continuation line and fix any incomplete values.`, 'warning')
      return false
    }
    const fields = staged.map(({ field }) => field)
    if (!commit(path, staged.map(({ field, value }) => fieldEdit(field, value, true)), fields)) {
      notify(`Couldn’t apply the changes to ${changedFields(staged)}. Check the values in Markdown, then re-enter your changes.`, 'warning')
      return false
    }
    // Once accepted by CodeMirror the changes are ordinary undoable outline edits.
    remove(fields.map(field => field.key))
    saving.current = true
    setBusy(true)
    try {
      await settle()
      return true
    } catch {
      return false
    } finally {
      saving.current = false
      setBusy(false)
      if (wiring.current.path === path) {
        for (const pending of edits.current.values()) {
          if (!pending.staged && !pending.timer && !pending.refused) scheduleText(pending)
        }
      }
    }
  }, [remove, scheduleText, stagedFields])

  const guard = useCallback((signal?: AbortSignal): boolean | Promise<boolean> => {
    if (reply.current || saving.current || signal?.aborted || !flushText()) return false
    const staged = stagedFields()
    if (staged.length === 0) return true
    if (signal) void window.tw.talk.ackCloseRequest?.()
    const cancel = () => reply.current?.('stay')
    return new Promise<LeaveChoice>(resolve => {
      reply.current = resolve
      signal?.addEventListener('abort', cancel, { once: true })
      setQuestion(changedFields(staged))
    }).then(async choice => {
      signal?.removeEventListener('abort', cancel)
      reply.current = null
      setQuestion(null)
      if (choice === 'stay' || signal?.aborted) return false
      if (choice === 'save') return await save() && !signal?.aborted && flushText() && stagedFields().length === 0
      remove(staged.map(({ field }) => field.key))
      return true
    })
  }, [flushText, remove, save, stagedFields])

  const afterLeave = useCallback((action: () => void) => {
    const result = guard()
    if (result === true) action()
    else if (result !== false) void result.then(allowed => { if (allowed) action() })
  }, [guard])

  return {
    value: (field: MetadataField) => edits.current.get(field.key)?.value ?? field.value,
    type, choose, commitText, guard, afterLeave, save, busy,
    hasStaged: () => stagedFields().length > 0,
    isAsking: () => reply.current !== null,
    staged: changedFields(stagedFields()),
    question,
    answer: (choice: LeaveChoice) => reply.current?.(choice)
  }
}

export type TalkMetadata = ReturnType<typeof useTalkMetadata>

export function TalkMetadataLeaveDialog({ fields, answer }: { fields: string; answer(choice: LeaveChoice): void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => { dialog.current?.showModal() }, [])
  return <dialog ref={dialog} className="tw-agent-dialog" aria-labelledby="tw-talk-metadata-question"
    onCancel={event => { event.preventDefault(); answer('stay') }}>
    <h2 id="tw-talk-metadata-question">You have unsaved changes to {fields}.</h2>
    <footer className="tw-agent-actions">
      <button className="toolbar-btn" type="button" autoFocus onClick={() => answer('stay')}>Keep editing</button>
      <button className="toolbar-btn" type="button" onClick={() => answer('discard')}>Discard</button>
      <button className="toolbar-btn tw-agent-primary" type="button" onClick={() => answer('save')}>Save</button>
    </footer>
  </dialog>
}
