import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { getSettings, updateSettings } from '../api/settings'
import { getApiErrorMessage } from '../api/client'
import type { Settings, SettingsUpdate } from '../types'

export default function SettingsPage() {
  const navigate = useNavigate()
  const [, setSettings] = useState<Settings | null>(null)
  const [formData, setFormData] = useState<SettingsUpdate>({})
  const [loading, setLoading] = useState(false)
  const [success, setSuccess] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    loadSettings()
  }, [])

  const loadSettings = async () => {
    try {
      const data = await getSettings()
      setSettings(data)
      setFormData({
        llm_provider: data.llm_provider || 'openai',
        llm_base_url: data.llm_base_url || '',
        llm_model_name: data.llm_model_name || '',
      })
    } catch (error) {
      console.error('Failed to load settings:', error)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setSuccess(false)
    setError('')

    try {
      await updateSettings(formData)
      setSuccess(true)
      await loadSettings()
    } catch (error) {
      console.error('Failed to update settings:', error)
      setError(getApiErrorMessage(error, 'Failed to update settings'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex h-screen flex-col bg-[var(--app-surface)] text-[var(--app-text)]">
      <header className="border-b border-[var(--app-border)] bg-[var(--app-surface-elevated)] px-6 py-4">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">Settings</h1>
          <button
            onClick={() => navigate('/')}
            className="rounded-xl border border-[var(--app-border)] bg-[var(--app-surface-muted)] px-4 py-2 transition-colors hover:bg-[var(--app-surface-elevated)]"
          >
            Back
          </button>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-2xl rounded-2xl border border-[var(--app-border)] bg-[var(--app-surface-elevated)] p-6 shadow-sm">
          <h2 className="mb-4 text-xl font-semibold">LLM Configuration</h2>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-[var(--app-text)]">
                Provider
              </label>
              <select
                value={formData.llm_provider || 'openai'}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    llm_provider: e.target.value as SettingsUpdate['llm_provider'],
                  })
                }
                className="w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-surface-muted)] px-3 py-2 focus:border-[var(--app-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--app-accent-soft)]"
              >
                <option value="openai">OpenAI</option>
                <option value="minimax">MiniMax</option>
                <option value="siliconflow">SiliconFlow</option>
                <option value="zhipu">Zhipu</option>
                <option value="kimi">Kimi</option>
              </select>
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-[var(--app-text)]">
                Base URL
              </label>
              <input
                type="text"
                value={formData.llm_base_url || ''}
                onChange={(e) =>
                  setFormData({ ...formData, llm_base_url: e.target.value })
                }
                className="w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-surface-muted)] px-3 py-2 focus:border-[var(--app-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--app-accent-soft)]"
              />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-[var(--app-text)]">
                API Key
              </label>
              <input
                type="password"
                value={formData.llm_api_key || ''}
                onChange={(e) =>
                  setFormData({ ...formData, llm_api_key: e.target.value })
                }
                placeholder="Secret field, leave empty to keep unchanged"
                className="w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-surface-muted)] px-3 py-2 focus:border-[var(--app-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--app-accent-soft)]"
              />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-[var(--app-text)]">
                Model name
              </label>
              <input
                type="text"
                value={formData.llm_model_name || ''}
                onChange={(e) =>
                  setFormData({ ...formData, llm_model_name: e.target.value })
                }
                className="w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-surface-muted)] px-3 py-2 focus:border-[var(--app-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--app-accent-soft)]"
              />
            </div>

            {success && (
              <div className="rounded-xl bg-green-50 p-3 text-sm text-green-700">
                Settings saved successfully
              </div>
            )}

            {error && (
              <div className="rounded-xl bg-red-50 p-3 text-sm text-red-700">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-xl bg-[var(--app-accent)] px-4 py-2 text-white transition-colors hover:bg-[var(--app-accent-hover)] disabled:bg-gray-400"
            >
              {loading ? 'Saving...' : 'Save Settings'}
            </button>
          </form>
        </div>
      </main>
    </div>
  )
}
