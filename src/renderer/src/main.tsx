import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import ErrorBoundary from './components/ErrorBoundary'
import './styles.css'
import './lighttable.css'
import { installMock } from './tw-mock'

// In Electron, window.tw is injected synchronously by the preload script.
// In a plain browser (dev preview / Vite HMR), install the mock before React mounts.
if (typeof (window as any).tw === 'undefined') {
  installMock()
}

// Surface uncaught async errors too (effects/promises the boundary can't catch) to the console,
// so ELECTRON_ENABLE_LOGGING=1 shows them in the terminal.
window.addEventListener('error', (e) => console.error('[TalkWeaver] window error:', e.error ?? e.message))
window.addEventListener('unhandledrejection', (e) => console.error('[TalkWeaver] unhandled rejection:', e.reason))

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
