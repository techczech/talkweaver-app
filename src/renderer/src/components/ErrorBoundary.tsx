import { Component, type ErrorInfo, type ReactNode } from 'react'

// Turns a render/effect throw into a readable, recoverable card instead of a blank white window.
// A white screen of death hides the cause and looks like data loss; this shows the message, a
// stack you can expand, and a Reload — and logs to the console (visible with ELECTRON_ENABLE_LOGGING).
type Props = { children: ReactNode }
type State = { error: Error | null; info: ErrorInfo | null }

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ info })
    // eslint-disable-next-line no-console
    console.error('[TalkWeaver] render error:', error, info.componentStack)
  }

  render(): ReactNode {
    const { error, info } = this.state
    if (!error) return this.props.children
    return (
      <div className="tw-errbound" role="alert">
        <div className="tw-errbound-card">
          <h1>Something in this window hit an error</h1>
          <p>The screen was stopped so nothing is lost on disk. Reload to try again; if it keeps
            happening, this message says why.</p>
          <pre className="tw-errbound-msg">{error.name}: {error.message}</pre>
          {error.stack && (
            <details>
              <summary>Technical details</summary>
              <pre className="tw-errbound-stack">{error.stack}</pre>
            </details>
          )}
          {info?.componentStack ? (
            <details>
              <summary>Where it happened</summary>
              <pre className="tw-errbound-stack">{info.componentStack.trim()}</pre>
            </details>
          ) : null}
          <div className="tw-errbound-actions">
            <button type="button" onClick={() => window.location.reload()}>Reload this window</button>
          </div>
        </div>
      </div>
    )
  }
}
