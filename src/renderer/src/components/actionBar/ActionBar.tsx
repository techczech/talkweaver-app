import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react'
import { Icon, type IconName } from '../ToolbarMenu'
import type { ToolbarIconToken } from '../../../../shared/command-registry'
import { planButtonOverflow } from './overflow'
import type { ActionBarSection, ResolvedActionBarItem } from './model'

export type ActionBarProps = { sections: ActionBarSection[] }
type TokenIsIconName = ToolbarIconToken extends IconName ? true : false
const tokenVocabularyIsCovered: TokenIsIconName = true
void tokenVocabularyIsCovered
const iconFor = (token: ToolbarIconToken): IconName => token

type BarItem = { item: ResolvedActionBarItem; section: number }

export default function ActionBar({ sections }: ActionBarProps): ReactElement {
  const barRef = useRef<HTMLDivElement | null>(null)
  const measureRef = useRef<HTMLDivElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const overflowButtonRef = useRef<HTMLButtonElement | null>(null)
  const tipRef = useRef<HTMLSpanElement | null>(null)
  const items: BarItem[] = sections.flatMap((section, index) => section.items.map((item) => ({ item, section: index })))
  const [visibleCount, setVisibleCount] = useState(items.length)
  const [menuOpen, setMenuOpen] = useState(false)
  const [tip, setTip] = useState<{ content: string; left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    const bar = barRef.current
    const measure = measureRef.current
    if (!bar || !measure) return
    const replan = (): void => {
      const buttons = [...measure.querySelectorAll<HTMLElement>('[data-measure-button]')]
      if (!buttons.length) return
      const left = buttons[0].getBoundingClientRect().left
      const widths = buttons.map((node) => node.getBoundingClientRect().right - left)
      const lastRight = left + widths[widths.length - 1]
      const overflowRight = measure.querySelector<HTMLElement>('[data-measure-overflow]')?.getBoundingClientRect().right ?? lastRight
      const style = getComputedStyle(bar)
      const available = bar.getBoundingClientRect().width - parseFloat(style.paddingLeft || '0') - parseFloat(style.paddingRight || '0')
      setVisibleCount(planButtonOverflow({ available, prefixWidths: widths, overflowChunk: overflowRight - lastRight, tailChunk: 0 }).visible)
    }
    replan()
    const observer = new ResizeObserver(replan)
    observer.observe(bar)
    return () => observer.disconnect()
  }, [sections])

  useLayoutEffect(() => {
    if (!tip || !tipRef.current) return
    const width = tipRef.current.getBoundingClientRect().width
    const left = Math.max(4, Math.min(tip.left - width / 2, window.innerWidth - width - 4))
    tipRef.current.style.left = `${left}px`
  }, [tip])

  const shown = items.slice(0, visibleCount)
  const overflowed = items.slice(visibleCount)
  useEffect(() => {
    if (overflowed.length === 0 && menuOpen) setMenuOpen(false)
  }, [menuOpen, overflowed.length])
  useEffect(() => {
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setTip(null)
    }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [])
  useEffect(() => {
    if (!menuOpen) return
    const outside = (event: PointerEvent): void => {
      if (!menuRef.current?.contains(event.target as Node) && !overflowButtonRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    window.addEventListener('pointerdown', outside, true)
    return () => window.removeEventListener('pointerdown', outside, true)
  }, [menuOpen])

  const showTip = (button: HTMLButtonElement, content: string): void => {
    const rect = button.getBoundingClientRect()
    setTip({ content, left: rect.left + rect.width / 2, top: rect.bottom + 4 })
  }
  const keepCaret = (event: { preventDefault: () => void }): void => event.preventDefault()
  const button = ({ item }: BarItem): ReactElement => (
    <button
      type="button" key={item.commandId} className="tw-action-bar-btn" data-command={item.commandId}
      disabled={item.disabled} aria-label={item.label} onMouseDown={keepCaret}
      onMouseEnter={(event) => showTip(event.currentTarget, item.tooltip)}
      onFocus={(event) => { if (event.currentTarget.matches(':focus-visible')) showTip(event.currentTarget, item.tooltip) }}
      onClick={() => { setTip(null); item.run() }}
    ><Icon name={iconFor(item.icon)} size={16} /></button>
  )

  return (
    <div className="tw-action-bar" role="toolbar" aria-label="Action bar" ref={barRef} onMouseLeave={() => setTip(null)}>
      {shown.map((entry, index) => (
        <Fragment key={entry.item.commandId}>
          {index > 0 && entry.section !== shown[index - 1].section && <span className="tw-action-bar-sep" aria-hidden="true" />}
          {button(entry)}
        </Fragment>
      ))}
      {overflowed.length > 0 && (
        <div className="tw-action-bar-tail">
          <span className="tw-action-bar-sep" aria-hidden="true" />
          <button
            type="button" ref={overflowButtonRef} className={`tw-action-bar-btn${menuOpen ? ' is-open' : ''}`}
            aria-haspopup="menu" aria-expanded={menuOpen} aria-label="More actions" onMouseDown={keepCaret}
            onMouseEnter={(event) => showTip(event.currentTarget, 'More actions')}
            onFocus={(event) => { if (event.currentTarget.matches(':focus-visible')) showTip(event.currentTarget, 'More actions') }}
            onClick={(event) => {
              setTip(null)
              setMenuOpen(!menuOpen)
              if (event.detail === 0 && !menuOpen) requestAnimationFrame(() => menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus())
            }}
          ><Icon name="more" size={16} /></button>
        </div>
      )}
      {menuOpen && overflowed.length > 0 && (
        <div className="tw-action-bar-menu" role="menu" aria-label="More actions" ref={menuRef}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return
            event.preventDefault()
            setMenuOpen(false)
            overflowButtonRef.current?.focus()
          }}>
          {overflowed.map((entry, index) => (
            <Fragment key={entry.item.commandId}>
              {index > 0 && entry.section !== overflowed[index - 1].section && <div className="tw-action-bar-menu-separator" role="separator" />}
              <button type="button" role="menuitem" data-command={entry.item.commandId}
                className="tw-action-bar-menu-item" disabled={entry.item.disabled} onMouseDown={keepCaret}
                onClick={() => { setTip(null); setMenuOpen(false); entry.item.run() }}>
                <Icon name={iconFor(entry.item.icon)} size={15} />
                <span>{entry.item.label}</span>
                {entry.item.keys && <kbd>{entry.item.keys}</kbd>}
              </button>
            </Fragment>
          ))}
        </div>
      )}
      {tip && <span ref={tipRef} className="tw-action-bar-tip" role="tooltip" style={{ top: tip.top, left: tip.left }}>{tip.content}</span>}
      <div className="tw-action-bar-measure" ref={measureRef} aria-hidden="true">
        {items.map((entry, index) => (
          <Fragment key={entry.item.commandId}>
            {index > 0 && entry.section !== items[index - 1].section && <span className="tw-action-bar-sep" />}
            <span className="tw-action-bar-btn" data-measure-button=""><Icon name={iconFor(entry.item.icon)} size={16} /></span>
          </Fragment>
        ))}
        <span className="tw-action-bar-sep" />
        <span className="tw-action-bar-btn" data-measure-overflow=""><Icon name="more" size={16} /></span>
      </div>
    </div>
  )
}
