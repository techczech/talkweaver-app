// The quiet bar at the top of an open talk when its outline file differs from what the editor holds
// (shared-talk ticket 01): "This talk changed on disk at 09:12 · Reload · Keep mine", and its variants
// for a talk removed on disk, a save that failed halfway, and unsaved text kept from an earlier session.
// No dialog; the talk stays usable in every view, and saves wait (refused by the main process) until a
// choice is made. OutlineDiskChangeSheet is the same choice when the person leaves the talk.
// lib/outlineDiskChange.ts carries out the choice.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { describeDiskChange, type OutlineDiskChange, type OutlineDiskChoice } from '../lib/outlineDiskChange';
export default function OutlineDiskChangeBar({ change, busy, onChoose }: {
  change: OutlineDiskChange;
  busy: boolean;
  onChoose: (choice: Exclude<OutlineDiskChoice, 'stay'>) => void;
}) {
  const { text, actions } = describeDiskChange(change);
  return (<div className="disk-change-bar" role="status" aria-live="polite" data-testid="outline-disk-change-bar" data-kind={change.kind}>
    <span className="disk-change-bar__text">{text}</span>
    {actions.map((action) => (<span key={action.choice} className="disk-change-bar__item">
      <span className="disk-change-bar__sep" aria-hidden="true">·</span>
      <button type="button" className="disk-change-bar__action" disabled={busy} title={action.title} onClick={() => onChoose(action.choice)}>{action.label}</button>
    </span>))}
  </div>);
}
/**
 * R2: the same notice as a warning chip in the status bar. It opens by itself when the change arrives (it signals an
 * external change and must not be missed) and shows the whole text with every action in a popover; the chip closes
 * and opens it again, and choosing an action ends the notice.
 */
export function OutlineDiskChangeChip({ change, busy, onChoose }: {
  change: OutlineDiskChange;
  busy: boolean;
  onChoose: (choice: Exclude<OutlineDiskChoice, 'stay'>) => void;
}) {
  const [open, setOpen] = useState(true);
  const { text } = describeDiskChange(change);
  // A newer version of the change, or a change that becomes a removal, opens the popover again even if it was closed.
  useEffect(() => { setOpen(true); }, [change.hash, change.kind]);
  return (
    <span className="tw-disk-chip" data-testid="outline-disk-change-chip">
      {/* The announcement does not depend on the popover: it stays while the popover is closed and follows every new change. */}
      <span role="status" aria-live="polite" data-testid="outline-disk-change-live" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' }}>{text}</span>
      <button type="button" className="tw-disk-chip-btn" aria-expanded={open} title={text} onClick={() => setOpen((v) => !v)} onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); }}>
        <span aria-hidden="true">⚠</span> Changed on disk
      </button>
      {open && <span className="tw-disk-chip-pop"><OutlineDiskChangeBar change={change} busy={busy} onChoose={onChoose} /></span>}
    </span>
  );
}
/** The sheet that holds a talk switch or a window close until the person has chosen. */
export function OutlineDiskChangeSheet({ change, onAnswer }: {
  change: OutlineDiskChange;
  onAnswer: (choice: OutlineDiskChoice) => void;
}) {
  const { text, sheetTitle, actions } = describeDiskChange(change);
  const surface = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const siblings = Array.from(document.body.children).filter(el => el !== surface.current && !el.hasAttribute('inert'));
    siblings.forEach(el => el.setAttribute('inert', ''));
    surface.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        onAnswer('stay');
      }
      if (e.key === 'Tab') {
        const buttons = Array.from(surface.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
        const first = buttons[0], last = buttons.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        }
        else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => {
      window.removeEventListener('keydown', onKey, { capture: true });
      siblings.forEach(el => el.removeAttribute('inert'));
      if (previous?.isConnected)
        previous.focus({ preventScroll: true });
    };
  }, [onAnswer]);
  return createPortal(<div ref={surface}>
    <div className="disk-change-sheet__scrim" onClick={() => onAnswer('stay')} />
    <div className="disk-change-sheet" role="dialog" aria-modal="true" aria-label={sheetTitle} data-testid="outline-disk-change-sheet">
      <div className="disk-change-sheet__title">{sheetTitle}</div>
      <div className="disk-change-sheet__detail">{text}. Choose what to keep before you leave the talk.</div>
      <div className="disk-change-sheet__actions">
        <button type="button" className="disk-change-sheet__btn disk-change-sheet__btn--ghost" onClick={() => onAnswer('stay')}>Stay here</button>
        {actions.map((action) => (<button key={action.choice} type="button" className="disk-change-sheet__btn" title={action.title} onClick={() => onAnswer(action.choice)}>{action.label}</button>))}
      </div>
    </div>
  </div>, document.body);
}
