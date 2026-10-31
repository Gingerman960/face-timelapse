import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { isTauri } from '@tauri-apps/api/core'
import { App } from './App'
import { CrashPanel, ErrorBoundary } from './components/ui/ErrorBoundary'
import { queryClient } from './state/queries'
import './styles/tokens.css'
import './styles/base.css'
import './components/ui/ui.css'
import './features/shell/shell.css'

/**
 * Outside Tauri (plain browser dev, Playwright) or with VITE_FT_MOCK=1 the
 * in-memory fake backend answers every command. The branch is compiled out
 * of production builds unless VITE_FT_MOCK=1 is set at build time.
 */
async function installMockIfNeeded(): Promise<void> {
  if (!(import.meta.env.DEV || import.meta.env.VITE_FT_MOCK === '1')) return
  const forced = import.meta.env.VITE_FT_MOCK === '1' || new URLSearchParams(location.search).has('mock')
  if (isTauri() && !forced) return
  const { installMockBackend } = await import('./ipc/mock/install')
  installMockBackend()
}

/**
 * macOS: the shell makes the window transparent with the `sidebar` material
 * behind the webview (INTEGRATION-NOTES §5.5). Flag it before the first paint
 * so only the sidebar card lets the material through; Windows/Linux windows
 * and plain browsers stay opaque.
 */
function markVibrancy(): void {
  if (isTauri() && /Mac OS X|Macintosh/.test(navigator.userAgent)) document.documentElement.dataset.vibrancy = 'sidebar'
}

async function boot(): Promise<void> {
  markVibrancy()
  await installMockIfNeeded()
  const root = document.getElementById('root')
  if (!root) throw new Error('Missing #root')
  // Logged where it can be read in the webview's console; the boundaries keep the window usable.
  createRoot(root, {
    onUncaughtError: (error, info) => console.error('[FaceTimelapse] uncaught', error, info.componentStack),
  }).render(
    <StrictMode>
      <ErrorBoundary fallback={(error) => <CrashPanel title="FaceTimelapse" error={error} />}>
        <QueryClientProvider client={queryClient}>
          <App />
        </QueryClientProvider>
      </ErrorBoundary>
    </StrictMode>,
  )
}

void boot()
