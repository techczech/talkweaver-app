import type { CSSProperties, ReactNode } from 'react'
import { macWindowChromeFallback } from '../../../shared/window-chrome'
import '../window-chrome.css'

declare global {
  interface Window {
    readonly twMacInset?: boolean
  }
}

/** All full-window views share the inset reported by their BrowserWindow, including overlays. */
export default function WindowChrome({ children }: { children: ReactNode }) {
  const style = window.twMacInset ? {
    '--tw-native-fallback-inline': `${macWindowChromeFallback.inline}px`,
    '--tw-native-fallback-block': `${macWindowChromeFallback.block}px`
  } as CSSProperties : undefined
  return <div className="tw-window-shell" style={style}>{children}</div>
}
