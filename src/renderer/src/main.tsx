import { createRoot } from 'react-dom/client'
import { Component, type ReactNode } from 'react'
import '@fontsource-variable/montserrat'
import './theme/tokens.css'
import './styles/app.css'
import './styles/sources.css'
import './styles/editor.css'
import './styles/settings.css'
import './styles/player.css'
import './styles/polish.css'
import App from './App'

/** If part of the UI crashes, show what happened (and a reload button) instead of a blank window. */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error) {
    console.error('UI crashed', error)
  }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="crash">
        <h2>Something went wrong in the app window.</h2>
        <p>Recording and the replay buffer keep running in the background.</p>
        <pre>{this.state.error.message}</pre>
        <button className="btn btn-accent" onClick={() => location.reload()}>
          Reload window
        </button>
      </div>
    )
  }
}

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
)
