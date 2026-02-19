import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { getSettings, updateSettings } from '../api/settings'
import type { Settings, SettingsUpdate } from '../types'

export default function SettingsPage() {
  const navigate = useNavigate()
  const [, setSettings] = useState<Settings | null>(null)
  const [formData, setFormData] = useState<SettingsUpdate>({})
  const [loading, setLoading] = useState(false)
  const [success, setSuccess] = useState(false)

  useEffect(() => {
    loadSettings()
  }, [])

  const loadSettings = async () => {
    try {
      const data = await getSettings()
      setSettings(data)
      setFormData({
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

    try {
      await updateSettings(formData)
      setSuccess(true)
      await loadSettings()
    } catch (error) {
      console.error('Failed to update settings:', error)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex h-screen flex-col bg-gray-50">
      <header className="border-b bg-white px-6 py-4">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">Settings</h1>
          <button
            onClick={() => navigate('/')}
            className="rounded-lg bg-gray-200 px-4 py-2 hover:bg-gray-300"
          >
            Back
          </button>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-2xl rounded-lg bg-white p-6 shadow">
          <h2 className="mb-4 text-xl font-semibold">LLM Configuration</h2>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">
                Base URL
              </label>
              <input
                type="text"
                value={formData.llm_base_url}
                onChange={(e) =>
                  setFormData({ ...formData, llm_base_url: e.target.value })
                }
                className="w-full rounded-md border border-gray-300 px-3 py-2 focus:border-blue-500 focus:outline-none"
              />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">
                API Key
              </label>
              <input
                type="password"
                value={formData.llm_api_key || ''}
                onChange={(e) =>
                  setFormData({ ...formData, llm_api_key: e.target.value })
                }
                placeholder="Secret field, leave empty to keep unchanged"
                className="w-full rounded-md border border-gray-300 px-3 py-2 focus:border-blue-500 focus:outline-none"
              />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">
                Model name
              </label>
              <input
                type="text"
                value={formData.llm_model_name}
                onChange={(e) =>
                  setFormData({ ...formData, llm_model_name: e.target.value })
                }
                className="w-full rounded-md border border-gray-300 px-3 py-2 focus:border-blue-500 focus:outline-none"
              />
            </div>

            {success && (
              <div className="rounded-md bg-green-50 p-3 text-sm text-green-600">
                Settings saved successfully
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-md bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 disabled:bg-gray-400"
            >
              {loading ? 'Saving...' : 'Save Settings'}
            </button>
          </form>
        </div>
      </main>
    </div>
  )
}
