// The three empty states under the grid: zero results (A6), an empty vault (A6), and search
// unavailable (compiler missing — preserved from SearchPalette). Each is always mounted and shown
// by the `.show` class.
import { Archive, SearchX } from 'lucide-react'
import type { CSSProperties } from 'react'
import { type parseSearchQuery, scopeNoun } from '../slideBrowserModel'
import { type ChipVault, orList } from './vaultChipsModel'

export function EmptyStates({
  zeroResults, vaultEmpty, unavailable, query, parsedQuery, filtersOn,
  onClearSearch, onClearFilters, onClose, offVaults = null
}: {
  zeroResults: boolean
  vaultEmpty: boolean
  unavailable: boolean
  query: string
  parsedQuery: ReturnType<typeof parseSearchQuery>
  filtersOn: boolean
  onClearSearch: () => void
  onClearFilters: () => void
  onClose: () => void
  /** Ticket 06 (LOCKED-add-slide frame 4): the vaults switched on, and switched-off vaults that match. */
  offVaults?: { onNames: string[]; hidden: Array<{ vault: ChipVault; count: number }>; onSwitchOn: (id: string) => void } | null
}) {
  const hidden = offVaults && query.trim() ? offVaults.hidden : []
  return (
    <>
      {/* zero-results (A6) */}
      <div className={`lt-empty${zeroResults ? ' show' : ''}`}>
        <div className="lt-e-frame"><SearchX className="lt-icon" /></div>
        <h3>Nothing on the table</h3>
        {hidden.length > 0 ? null : parsedQuery.scope === 'all' && !parsedQuery.exact ? (
          <p>
            No slides match {query.trim() ? <span className="lt-q">“{query.trim()}”</span> : 'the current filters'}
            {query.trim() ? ' within the current filters' : ''}. Loosen the Talk filters, or clear the search to lay everything back out.
          </p>
        ) : (
          <p>
            No slides with {scopeNoun(parsedQuery)}
            {parsedQuery.text.trim() ? <> — <span className="lt-q">“{parsedQuery.text.trim()}”</span></> : null}
            {filtersOn ? ' within the current filters' : ''}. Drop the{' '}
            <span className="lt-q">{parsedQuery.exact ? 'e:' : parsedQuery.scope === 'title' ? 't:' : parsedQuery.scope === 'body' ? 's:' : 'i:'}</span>{' '}
            prefix to search everywhere, or clear the search.
          </p>
        )}
        {hidden.length > 0 && offVaults && (
          <div className="lt-e-offvault" data-off-vault-matches>
            <p>No slides match <span className="lt-q">“{query.trim()}”</span> in {orList(offVaults.onNames)}.</p>
            {hidden.map(({ vault, count }) => (
              <p key={vault.id}>
                {count} {count === 1 ? 'match' : 'matches'} in
                <span className="vs-vb sm" style={{ '--c': vault.color } as CSSProperties}>{vault.initial}</span>
                <b>{vault.name}</b>, which is off.{' '}
                <button type="button" className="lt-linkbtn" data-switch-on={vault.id} onClick={() => offVaults.onSwitchOn(vault.id)}>Switch it on</button>
              </p>
            ))}
          </div>
        )}
        <div className="lt-e-actions">
          {query.trim() !== '' && (
            <button type="button" className="lt-btn" onClick={onClearSearch}>
              Clear search <kbd>Esc</kbd>
            </button>
          )}
          {filtersOn && (
            <button type="button" className="lt-btn" onClick={onClearFilters}>
              Clear filters &amp; scope
            </button>
          )}
        </div>
      </div>

      {/* empty vault (A6) */}
      <div className={`lt-empty${vaultEmpty ? ' show' : ''}`}>
        <div className="lt-e-frame"><Archive className="lt-icon" /></div>
        <h3>The vault is empty</h3>
        <p>
          Slides gather here as you author and present Talks — every saved slide becomes searchable,
          with its full history kept. Open a Talk and this table fills itself.
        </p>
        <div className="lt-e-actions">
          <button
            type="button"
            className="lt-btn primary"
            onClick={() => { window.dispatchEvent(new Event('tw-search-talks')); onClose() }}
          >
            Open a Talk
          </button>
          <button
            type="button"
            className="lt-btn"
            onClick={() => { window.dispatchEvent(new Event('tw-new-talk')); onClose() }}
          >
            New Talk
          </button>
        </div>
      </div>

      {/* search unavailable (compiler missing) — preserved from SearchPalette */}
      <div className={`lt-empty${unavailable ? ' show' : ''}`}>
        <div className="lt-e-frame"><SearchX className="lt-icon" /></div>
        <h3>Search unavailable</h3>
        <p>The html-presentations compiler wasn’t found, so the vault index can’t be searched. Check the compiler bundle, then reopen the Browser.</p>
      </div>
    </>
  )
}
