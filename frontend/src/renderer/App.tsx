import { BrowserRouter, HashRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useState, useEffect } from 'react'
import ChatPage from './pages/ChatPage'
import SettingsPage from './pages/SettingsPage'
import FirstSetup from './pages/FirstSetup'
import StartupFailure from './pages/StartupFailure'
import { checkConfigStatus } from './api/settings'
import { getApiErrorMessage, setApiBaseUrl } from './api/client'
import type { AppRuntimeStatus } from './types'
import { BACKEND_API_BASE_URL, BACKEND_HEALTH_URL, BACKEND_ORIGIN } from '../shared/backendConfig'

function App() {
  // BrowserRouter can fail under file:// in packaged Electron builds.
  // Use HashRouter in production package and keep BrowserRouter for local dev.
  const Router = window.location.protocol === 'file:' ? HashRouter : BrowserRouter

  const [runtimeStatus, setRuntimeStatus] = useState<AppRuntimeStatus | null>(null)
  const [isConfigured, setIsConfigured] = useState<boolean | null>(null)
  const [loading, setLoading] = useState(true)
  const [retryingStartup, setRetryingStartup] = useState(false)

  const fallbackRuntimeStatus: AppRuntimeStatus = {
    backendOrigin: BACKEND_ORIGIN,
    backendApiBaseUrl: BACKEND_API_BASE_URL,
    backendHealthUrl: BACKEND_HEALTH_URL,
    startupState: 'ready',
    startupFailureReason: null,
    logPath: '',
  }

  const initializeApp = async (providedRuntime?: AppRuntimeStatus) => {
    setLoading(true)
    let runtime = fallbackRuntimeStatus
    try {
      runtime =
        providedRuntime ||
        (window.electronAPI
          ? await window.electronAPI.getRuntimeStatus()
          : fallbackRuntimeStatus)

      setRuntimeStatus(runtime)
      setApiBaseUrl(runtime.backendApiBaseUrl)

      if (runtime.startupState !== 'ready') {
        setIsConfigured(null)
        return
      }

      const configured = await checkConfigStatus()
      setIsConfigured(configured)
      setRuntimeStatus({
        ...runtime,
        startupState: 'ready',
        startupFailureReason: null,
      })
    } catch (err) {
      console.error('Failed to initialize app runtime:', err)
      setIsConfigured(null)
      setRuntimeStatus({
        ...runtime,
        startupState: 'failed',
        startupFailureReason: getApiErrorMessage(
          err,
          'Backend became unavailable before configuration could be loaded.',
        ),
      })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void initializeApp()
  }, [])

  const handleRetryStartup = async () => {
    if (!window.electronAPI) {
      await initializeApp(fallbackRuntimeStatus)
      return
    }

    setRetryingStartup(true)
    try {
      const nextRuntime = await window.electronAPI.retryBackendStartup()
      await initializeApp(nextRuntime)
    } finally {
      setRetryingStartup(false)
    }
  }

  const handleOpenLogs = async () => {
    if (!window.electronAPI) return
    const result = await window.electronAPI.openBackendLogs()
    if (!result.ok) {
      console.error('Failed to open backend logs:', result.error)
    }
  }

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-lg text-muted-foreground">Loading...</div>
      </div>
    )
  }

  if (runtimeStatus?.startupState === 'failed') {
    return (
      <StartupFailure
        reason={runtimeStatus.startupFailureReason || 'Unknown backend startup failure.'}
        logPath={runtimeStatus.logPath}
        retrying={retryingStartup}
        onRetry={handleRetryStartup}
        onOpenLogs={handleOpenLogs}
      />
    )
  }

  return (
    <Router>
      <Routes>
        {!isConfigured && (
          <Route
            path="/setup"
            element={<FirstSetup onComplete={() => setIsConfigured(true)} />}
          />
        )}

        {isConfigured && (
          <>
            <Route path="/" element={<ChatPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </>
        )}

        <Route
          path="*"
          element={<Navigate to={isConfigured ? '/' : '/setup'} replace />}
        />
      </Routes>
    </Router>
  )
}

export default App
