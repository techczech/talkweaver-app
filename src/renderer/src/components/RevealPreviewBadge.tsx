/** Studio chrome stays outside the deck document and the generated thumbnail. */
export default function RevealPreviewBadge({ count, onOpen }: { count?: number; onOpen?: () => void }) {
  const label = count == null ? 'Reveal on' : `Reveal on · ${count} ${count === 1 ? 'step' : 'steps'}`
  return onOpen
    ? <button type="button" className="tw-reveal-badge" title="Open Steps" onClick={onOpen}>{label}</button>
    : <span className="tw-reveal-badge" data-counted={count != null || undefined}>{label}</span>
}
