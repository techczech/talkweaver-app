import { useEffect, useState } from 'react'
import type { TranscriptionRow } from '../../../preload/index'
import {
  TRANSCRIPTION_ROW_NAME, TRANSCRIPTION_SETUP_STEPS, transcriptionRowDetail, transcriptionRowEdge,
} from '../../../shared/transcription-status'
import { featureList, featureRow, rowDetail, rowState, tone } from './CloudflareSettings'
import { notify } from '../lib/notify'

// Settings → Transcription: the one status row (spec docs/plans/cloudflare-setup-in-app, D16), a
// bordered row with the state at the right-hand edge as on the Cloudflare screen, then "Set-up
// steps" and "Copy instructions for your agent". Every word comes from
// src/shared/transcription-status.ts; the row itself is decided in the main process
// (transcription-setup.ts). Transcription is optional, so "Not set up" is shown calmly.

type Look = Record<'hint' | 'folderLabel' | 'folderPath' | 'btn' | 'btnGhost', React.CSSProperties>

interface Props {
  look: Look
  /** Bumped by the panel whenever the three paths were saved or reset: the row is read again. */
  version: number
}

export default function TranscriptionStatusRow({ look, version }: Props) {
  const [row, setRow] = useState<TranscriptionRow | null>(null)
  const [steps, setSteps] = useState(false)

  useEffect(() => {
    let open = true
    void window.tw.settings.transcriptionStatus().then((next) => { if (open) setRow(next) }).catch(() => {})
    return () => { open = false }
  }, [version])

  const copyPrompt = (): void => {
    void window.tw.settings.transcriptionAgentPrompt()
      .then((prompt) => navigator.clipboard.writeText(prompt))
      .then(() => notify('Instructions copied. Paste them to your agent.', 'info'))
      .catch(() => notify('The instructions could not be copied. Try again.', 'error'))
  }
  const openFolder = (): void => {
    void window.tw.settings.openTranscriptionSetupFolder()
      .then((opened) => { if (!opened) notify('The set-up folder could not be opened.', 'error') })
      .catch(() => notify('The set-up folder could not be opened.', 'error'))
  }

  const edge = row ? transcriptionRowEdge(row) : null
  return (<>
    <div style={featureList} role="list" aria-label="Transcription status" data-transcription="features">
      <div role="listitem" style={featureRow} data-transcription="status" data-state={row?.state ?? 'loading'}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={look.folderLabel}>{TRANSCRIPTION_ROW_NAME}</div>
          <div style={rowDetail(look)} data-transcription="detail">{row ? transcriptionRowDetail(row) : 'Checking…'}</div>
        </div>
        {edge && edge.kind === 'state' && (
          <div style={{ ...rowState, color: tone[edge.tone] }} data-transcription="label">{edge.text}</div>
        )}
      </div>
    </div>

    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', padding: '0 0 6px' }}>
      <button style={look.btnGhost} aria-expanded={steps} onClick={() => setSteps((shown) => !shown)} data-transcription="steps-toggle">Set-up steps</button>
      <button style={look.btn} onClick={copyPrompt} data-transcription="copy-prompt">Copy instructions for your agent</button>
    </div>
    {steps && (
      <div style={{ ...look.hint, marginTop: 2 }} data-transcription="steps">
        <ol style={{ margin: '0 0 8px', paddingLeft: 18 }}>
          {TRANSCRIPTION_SETUP_STEPS.map((step) => <li key={step}>{step}</li>)}
        </ol>
        <button style={look.btnGhost} onClick={openFolder} data-transcription="open-folder">Open the set-up folder</button>
      </div>
    )}
  </>)
}
