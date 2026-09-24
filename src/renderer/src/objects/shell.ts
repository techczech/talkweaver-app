export type ObjectEditorCommitContext = 'interactive' | 'teardown'
export type ObjectEditorCommitResult =
  | { ok: true }
  | { ok: false; reason: string }
export type ObjectEditorApi = {
  preflight(source: string): ObjectEditorCommitResult
  commit(source: string, context: ObjectEditorCommitContext): ObjectEditorCommitResult
}
export type MountedEditor = {
  element: HTMLElement
  serialise(): string
  focus(): void
  onEscape?(): boolean
  destroy?(): void
}
export type ShellCheatSheet = {
  isShortcut(event: KeyboardEvent): boolean
  request(anchor: HTMLElement): void
  isFinishShortcut?(event: KeyboardEvent): boolean
  isLeaveShortcut?(event: KeyboardEvent): boolean
}

export function textareaEditor(source: string, className = 'oe-markup'): MountedEditor {
  const area = document.createElement('textarea')
  area.className = className
  area.value = source
  area.spellcheck = false
  return { element: area, serialise: () => area.value, focus: () => area.focus() }
}

export function mountShell(options: {
  kind: string
  editor: MountedEditor
  markup?: MountedEditor
  editorLabel?: string
  editorDisabledTitle?: string
  parseEditor?(source: string): MountedEditor | null
  foot: string
  api: ObjectEditorApi
  cheatSheet?: ShellCheatSheet
}): HTMLElement {
  const shell = document.createElement('div')
  shell.className = 'oe'
  shell.tabIndex = -1
  const head = document.createElement('div')
  head.className = 'oe-head'
  const kind = document.createElement('span')
  kind.className = 'oe-kind'
  kind.textContent = options.kind
  const tabs = document.createElement('div')
  tabs.className = 'oe-tabs'
  const surfaces = document.createElement('div')
  surfaces.className = 'oe-surface'
  let active = options.editor
  let api = options.api
  const note = document.createElement('div')
  note.className = 'oe-parse-note'
  note.textContent = ''
  note.hidden = true
  const setActive = (
    mounted: MountedEditor,
    button: HTMLButtonElement
  ): void => {
    active.destroy?.()
    active.element.replaceWith(mounted.element)
    active = mounted
    note.hidden = true
    tabs.querySelectorAll('button').forEach((item) => item.classList.toggle('on', item === button))
    mounted.focus()
  }
  if (options.markup) {
    const editorTab = document.createElement('button')
    editorTab.type = 'button'
    editorTab.textContent = options.editorLabel ?? 'Editor'
    if (options.editorDisabledTitle) {
      editorTab.disabled = true
      editorTab.title = options.editorDisabledTitle
    }
    const markupTab = document.createElement('button')
    markupTab.type = 'button'
    markupTab.textContent = 'Markup'
    editorTab.className = 'on'
    editorTab.addEventListener('click', () => {
      if (!options.parseEditor || active === options.editor) return
      const parsed = options.parseEditor(active.serialise())
      if (!parsed) {
        note.textContent = `This markup cannot be parsed as a ${options.editorLabel?.toLowerCase() ?? 'visual editor'} yet. Fix it here; your text is unchanged.`
        note.hidden = false
        return
      }
      options.editor = parsed
      setActive(parsed, editorTab)
    })
    markupTab.addEventListener('click', () => {
      if (active !== options.editor) return
      options.markup = textareaEditor(active.serialise())
      setActive(options.markup, markupTab)
    })
    tabs.append(editorTab, markupTab)
  }
  head.append(kind, tabs)
  surfaces.append(active.element, note)
  const foot = document.createElement('div')
  foot.className = 'oe-foot'
  const hint = document.createElement('span')
  hint.className = 'grow'
  hint.textContent = options.foot
  const done = document.createElement('button')
  done.type = 'button'
  done.className = 'oe-done'
  done.innerHTML = '✓ Done <kbd>⌘↵</kbd>'
  const controller = new AbortController()
  let finished = false
  const showRefusal = (reason: string): void => {
    shell.classList.remove('oe-commit-refused')
    void shell.offsetWidth
    shell.classList.add('oe-commit-refused')
    note.textContent = `This edit was not saved: ${reason}. Your text is still here.`
    note.hidden = false
  }
  const preflightTeardown = (): ObjectEditorCommitResult => {
    if (finished) return { ok: true }
    const result = api.preflight(active.serialise())
    if (!result.ok) showRefusal(result.reason)
    return result
  }
  const commit = (
    context: ObjectEditorCommitContext = 'interactive'
  ): ObjectEditorCommitResult => {
    if (finished) return { ok: true }
    finished = true
    const source = active.serialise()
    const result = api.commit(source, context)
    if (!result.ok) {
      finished = false
      showRefusal(result.reason)
      return result
    }
    controller.abort()
    active.destroy?.()
    return result
  }
  const controlledShell = shell as HTMLElement & {
    __twCommit?: (context?: ObjectEditorCommitContext) => ObjectEditorCommitResult
    __twPreflightTeardown?: () => ObjectEditorCommitResult
    __twRetargetApi?: (next: ObjectEditorApi) => void
  }
  controlledShell.__twCommit = (context = 'teardown') => commit(context)
  controlledShell.__twPreflightTeardown = preflightTeardown
  controlledShell.__twRetargetApi = (next) => { api = next }
  done.addEventListener('click', () => commit())
  foot.append(hint, done)
  shell.append(head, surfaces, foot)
  shell.addEventListener('keydown', (event) => {
    if (options.cheatSheet?.isShortcut(event)) {
      event.preventDefault()
      event.stopPropagation()
      options.cheatSheet.request(shell)
      return
    }
    const finish = options.cheatSheet?.isFinishShortcut
      ? options.cheatSheet.isFinishShortcut(event)
      : event.key === 'Enter' && (event.metaKey || event.ctrlKey)
    if (finish) {
      event.preventDefault()
      event.stopPropagation()
      commit()
      return
    }
    if (event.key === 'Escape' && active.onEscape?.() === true) {
      event.preventDefault()
      event.stopPropagation()
      return
    }
    const leave = options.cheatSheet?.isLeaveShortcut
      ? options.cheatSheet.isLeaveShortcut(event)
      : event.key === 'Escape'
    if (leave) {
      event.preventDefault()
      event.stopPropagation()
      commit()
      return
    }
    event.stopPropagation()
  })
  for (const type of ['keyup', 'keypress', 'beforeinput', 'input', 'mousedown', 'click', 'dblclick'] as const) {
    shell.addEventListener(type, (event) => event.stopPropagation())
  }
  document.addEventListener(
    'mousedown',
    (event) => {
      if (!shell.contains(event.target as Node)) commit()
    },
    { capture: true, signal: controller.signal }
  )
  window.addEventListener('blur', () => commit(), { signal: controller.signal })
  queueMicrotask(() => active.focus())
  return shell
}
