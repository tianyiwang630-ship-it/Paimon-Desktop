import { BrowserRouter, HashRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useState, useEffect } from 'react'
import ChatPage from './pages/ChatPage'
import SettingsPage from './pages/SettingsPage'
import FirstSetup from './pages/FirstSetup'
import { checkConfigStatus } from './api/settings'

function App() {
  // BrowserRouter can fail under file:// in packaged Electron builds.
  // Use HashRouter in production package and keep BrowserRouter for local dev.
  const Router = window.location.protocol === 'file:' ? HashRouter : BrowserRouter

  const [isConfigured, setIsConfigured] = useState<boolean | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    checkConfigStatus()
      .then((configured) => {
        setIsConfigured(configured)
      })
      .catch((err) => {
        console.error('Failed to check configuration status:', err)
        setIsConfigured(false)
      })
      .finally(() => {
        setLoading(false)
      })
  }, [])

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-lg text-muted-foreground">Loading...</div>
      </div>
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
