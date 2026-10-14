// The two Settings rows for the Plain tab (plain editing view, spec T13; drawing state-s11):
// "Plain view font" (Sans · Serif), "Text size" (− 16 px +), and a sample line that follows both.
import React from 'react'
import {
  PLAIN_FONTS, PLAIN_TEXT_SIZE_MAX, PLAIN_TEXT_SIZE_MIN, plainFontStack, stepPlainTextSize,
  type PlainFont, type PlainLook
} from '../../../shared/plain-view-look'

export interface PlainLookRowsProps {
  look: PlainLook
  onChange: (change: { font?: PlainFont; size?: number }) => void
}

export default function PlainLookRows({ look, onChange }: PlainLookRowsProps): React.JSX.Element {
  return (
    <div data-plain-look-rows>
      <div style={row}>
        <div style={{ minWidth: 0 }}>
          <div style={label}>Plain view font</div>
          <div style={sub}>The font used in the Plain tab. The Markdown tab always uses the code font.</div>
        </div>
        <div role="radiogroup" aria-label="Plain view font" style={segmented}>
          {PLAIN_FONTS.map((f) => {
            const on = f.id === look.font
            return (
              <button
                key={f.id}
                role="radio"
                aria-checked={on}
                data-font={f.id}
                style={on ? { ...segment, ...segmentOn } : segment}
                onClick={() => { if (!on) onChange({ font: f.id }) }}
              >
                {f.label}
              </button>
            )
          })}
        </div>
      </div>
      <div style={row}>
        <div style={label}>Text size</div>
        <div role="group" aria-label="Text size" style={stepper}>
          <button
            aria-label="Smaller text"
            data-step="down"
            disabled={look.size <= PLAIN_TEXT_SIZE_MIN}
            style={stepBtn}
            onClick={() => onChange({ size: stepPlainTextSize(look.size, -1) })}
          >
            &minus;
          </button>
          <span data-size-value style={stepValue}>{look.size} px</span>
          <button
            aria-label="Larger text"
            data-step="up"
            disabled={look.size >= PLAIN_TEXT_SIZE_MAX}
            style={{ ...stepBtn, borderRight: 'none' }}
            onClick={() => onChange({ size: stepPlainTextSize(look.size, 1) })}
          >
            +
          </button>
        </div>
      </div>
      <div data-plain-sample style={{ ...sample, fontFamily: plainFontStack(look.font), fontSize: look.size }}>
        Steepest rises: <em>2018</em>, the station opens; <strong>2022, e-bikes arrive</strong>.
      </div>
    </div>
  )
}

const row: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '6px 0'
}
const label: React.CSSProperties = { fontSize: 12.5, fontWeight: 600, color: 'var(--ink)' }
const sub: React.CSSProperties = { fontSize: 11.5, color: 'var(--muted)', marginTop: 2, lineHeight: 1.4 }
const segmented: React.CSSProperties = {
  display: 'flex', gap: 2, padding: 2, borderRadius: 8, background: 'var(--hover)', flexShrink: 0
}
const segment: React.CSSProperties = {
  fontSize: 12, padding: '4px 12px', borderRadius: 6, border: 'none', background: 'transparent',
  color: 'var(--muted)', cursor: 'pointer'
}
const segmentOn: React.CSSProperties = {
  background: 'var(--panel)', color: 'var(--ink)', fontWeight: 700, boxShadow: '0 1px 2px rgba(0,0,0,0.12)'
}
const stepper: React.CSSProperties = {
  display: 'flex', alignItems: 'stretch', border: '1px solid var(--line)', borderRadius: 6, overflow: 'hidden', flexShrink: 0
}
const stepBtn: React.CSSProperties = {
  fontSize: 13, width: 30, border: 'none', borderRight: '1px solid var(--line)', background: 'var(--panel)',
  color: 'var(--ink)', cursor: 'pointer', padding: '4px 0'
}
const stepValue: React.CSSProperties = {
  fontSize: 12, minWidth: 56, textAlign: 'center', alignSelf: 'center', color: 'var(--ink)',
  borderRight: '1px solid var(--line)', padding: '4px 0'
}
const sample: React.CSSProperties = {
  marginTop: 6, padding: '12px 10px', borderRadius: 6, background: 'var(--hover)', color: 'var(--ink)', lineHeight: 1.5
}
