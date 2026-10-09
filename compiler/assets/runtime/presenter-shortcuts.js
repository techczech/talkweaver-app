// One spelling for recorded events, registry defaults and persisted chords.
export function normalisePresenterChord(chord) {
  if (typeof chord !== 'string') return null;
  const match = /^([⌃⌥⌘⇧]*)(.+)$/.exec(chord);
  if (!match || new Set(match[1]).size !== match[1].length || match[1].length === 4) return null;
  let mods = match[1], key = match[2];
  const names = ['Space', 'Tab', 'Enter', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
    'Backspace', 'Delete', 'Home', 'End', 'PageUp', 'PageDown', 'MediaTrackNext', 'MediaTrackPrevious'];
  const named = names.find(name => name.toUpperCase() === key.toUpperCase());
  const shifted = '~!@#$%^&*()_+{}|:"<>?';
  const bases = '`1234567890-=[]\\;\',./';
  if (named) key = named;
  else if (/^F([1-9]|1\d|2[0-4])$/i.test(key)) key = key.toUpperCase();
  else if (key.length === 1 && /^[a-z0-9`\-=\[\]\\;',./]$/i.test(key)) key = key.toUpperCase();
  else if (key.length === 1 && shifted.includes(key)) {
    key = bases[shifted.indexOf(key)];
    if (!mods.includes('⇧')) mods += '⇧';
  } else return null;
  return ['⌃', '⌥', '⌘', '⇧'].filter(mod => mods.includes(mod)).join('') + key;
}
export function presenterChord(event) {
  let key = event.key;
  if (['Meta', 'Control', 'Alt', 'Shift'].includes(key)) return null;
  // macOS Option produces composed characters or Dead; bind the physical key instead.
  const punctuation = { Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
    Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/' };
  if (event.altKey && /^Key[A-Z]$/.test(event.code || '')) key = event.code.slice(3);
  else if (event.altKey && /^Digit\d$/.test(event.code || '')) key = event.code.slice(5);
  else if (punctuation[event.code]) key = punctuation[event.code];
  return normalisePresenterChord((event.ctrlKey ? '⌃' : '') + (event.altKey ? '⌥' : '') + (event.metaKey ? '⌘' : '')
    + (event.shiftKey ? '⇧' : '') + (key === ' ' ? 'Space' : key || ''));
}
export function presenterCodeChord(code) {
  if (code === '-') return '-';
  const parts = code.split('-');
  let key = parts.pop();
  if (key === 'BracketLeft') key = '[';
  if (key === 'BracketRight') key = ']';
  return normalisePresenterChord((parts.includes('Ctrl') ? '⌃' : '') + (parts.includes('Alt') ? '⌥' : '')
    + (parts.includes('Mod') || parts.includes('Meta') ? '⌘' : '')
    + (parts.includes('Shift') ? '⇧' : '') + key);
}
export function createPresenterShortcuts({ document, storage, commands, onChange }) {
  const store = 'talkweaver:presenter:shortcuts';
  const overrides = Object.create(null);
  const extra = {
    '⌘K': 'Contextual actions', '⌘P': 'Inspector', '⌘F': 'Find', '⌘⇧F': 'Search', '⌘,': 'Settings',
    '⌘/': 'Keyboard shortcuts', '⌘⇧P': 'All commands', '⌘⇧K': 'Navigation', '⌘⇧,': 'Rebind command',
    '-': 'Slide text smaller', '=': 'Slide text larger', '?': 'Keyboard shortcuts', '⇧?': 'Keyboard shortcuts'
  };
  for (let i = 0; i <= 9; i++) extra[String(i)] = 'Card on a grid slide';
  const navigationKeys = ['Space', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End',
    'Enter', 'Tab', 'Escape', 'Backspace', 'Delete'];
  function taken(chord, id) {
    const normal = normalisePresenterChord(chord);
    if (!normal) return 'a reserved or invalid key';
    chord = normal;
    const own = commands.find(command => command.id === id);
    const ownDefault = own?.codes.some(code => presenterCodeChord(code) === chord);
    const key = chord.replace(/^[⌃⌥⌘⇧]+/, '');
    if (['Tab', 'Escape', 'Enter'].includes(key)
      || ((chord.includes('⌘') || chord.includes('⌃')) && !ownDefault)
      || (chord.includes('⌥') && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Backspace'].includes(key))) {
      return 'a reserved key';
    }
    if (!ownDefault) {
      for (const [code, label] of Object.entries(extra)) {
        if (normalisePresenterChord(code) === chord) return label;
      }
    }
    for (const command of commands) {
      if (command.id === id) continue;
      if (command.codes.some(code => presenterCodeChord(code) === chord) || overrides[command.id]?.chord === chord) {
        return command.label;
      }
    }
    // Navigation and editing keys stay the deck's, with or without Shift: the deck's key handler
    // matches on the key alone, so Shift+Right and Shift+Space already navigate. Name the holder of the plain key if any.
    if (navigationKeys.includes(key) && !ownDefault) {
      if (chord.includes('⇧')) {
        const plain = chord.replace('⇧', '');
        for (const [code, label] of Object.entries(extra)) if (normalisePresenterChord(code) === plain) return label;
        for (const command of commands) {
          if (command.id !== id && command.codes.some(code => presenterCodeChord(code) === plain)) return command.label;
        }
      }
      return 'a reserved key';
    }
    return null;
  }
  function persist() { try { storage.setItem(store, JSON.stringify(overrides)); } catch {} }
  try {
    const saved = JSON.parse(storage.getItem(store) || '{}');
    for (const command of commands) {
      const value = saved[command.id];
      if (value && !taken(value.chord, command.id)) overrides[command.id] = {
        chord: normalisePresenterChord(value.chord), entryId: command.id.startsWith('palette.') ? command.id.slice(8)
          : typeof value.entryId === 'string' ? value.entryId : undefined
      };
    }
    const old = storage.getItem('talkweaver:presenter:pointer-shortcut');
    if (old && !overrides['presenter.pointer'] && !taken(old, 'presenter.pointer')) {
      overrides['presenter.pointer'] = { chord: normalisePresenterChord(old), entryId: 'pointer' };
      persist();
      storage.removeItem('talkweaver:presenter:pointer-shortcut');
    }
  } catch {}
  persist();
  let dialog;
  let previousFocus, focusFrame;
  function recoverFocus() {
    if (!dialog) return;
    document.defaultView.cancelAnimationFrame(focusFrame);
    focusFrame = document.defaultView.requestAnimationFrame(() => dialog?.focus());
  }
  function focusInside(event) {
    if (dialog && !dialog.contains(event.target)) dialog.focus();
  }
  function record(event) {
    if (!dialog) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.key === 'Escape') { close(); return; }
    dialog.record(event);
  }
  function close() {
    document?.removeEventListener('keydown', record, true);
    document?.removeEventListener('focusin', focusInside, true);
    document?.defaultView.removeEventListener('pagehide', close);
    document?.defaultView.removeEventListener('blur', recoverFocus);
    document?.defaultView.cancelAnimationFrame(focusFrame);
    dialog?.remove(); dialog = null;
    previousFocus?.focus?.();
  }
  function rebind(id, label, entryId) {
    close();
    dialog = document.createElement('dialog');
    dialog.className = 'tw-shortcut-rebind';
    dialog.setAttribute('aria-modal', 'true');
    dialog.id = 'presenterRebind';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-label', `Rebind ${label}`);
    dialog.tabIndex = -1;
    const prompt = document.createElement('p');
    prompt.textContent = `Press a new key for ${label}. Esc cancels.`;
    const status = document.createElement('p');
    status.setAttribute('role', 'status');
    const reset = document.createElement('button');
    reset.textContent = 'Reset to default';
    reset.type = 'button';
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.type = 'button';
    function save(next) {
      if (next) overrides[id] = { chord: next, entryId };
      else delete overrides[id];
      persist();
      close();
      onChange();
    }
    reset.addEventListener('click', () => save(null));
    cancel.addEventListener('click', close);
    dialog.append(prompt, status, reset, cancel);
    previousFocus = document.activeElement;
    document.body.append(dialog);
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    dialog.focus();
    dialog.record = event => {
      const next = presenterChord(event);
      if (!next) { status.textContent = 'That key is reserved. Choose another.'; return; }
      const owner = taken(next, id);
      if (owner) { status.textContent = `That key is already used by ${owner}. Choose another.`; return; }
      save(next);
    };
    document.addEventListener('keydown', record, true);
    document.addEventListener('focusin', focusInside, true);
    document.defaultView.addEventListener('blur', recoverFocus);
    document.defaultView.addEventListener('pagehide', close, { once: true });
  }
  return {
    key(id, fallback = '') {
      const chord = overrides[id]?.chord;
      if (!chord) return fallback;
      const defaults = commands.find(command => command.id === id)?.keys ?? fallback;
      return chord !== defaults ? [chord, defaults].filter(Boolean).join(' / ') : defaults;
    },
    taken, rebind,
    match(event) {
      if (event.target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable=false])')) return null;
      const chord = presenterChord(event);
      for (const [id, value] of Object.entries(overrides)) {
        if (value.chord === chord) return { id, entryId: value.entryId };
      }
      return null;
    }
  };
}
export function presenterShortcutsRuntimeSource() {
  return [normalisePresenterChord, presenterChord, presenterCodeChord, createPresenterShortcuts].map(fn => fn.toString()).join('\n');
}
