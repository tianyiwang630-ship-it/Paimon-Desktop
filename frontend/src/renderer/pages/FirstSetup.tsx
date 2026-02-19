import { useState } from 'react'
import { updateSettings } from '../api/settings'
import type { SettingsUpdate } from '../types'

interface FirstSetupProps {
  onComplete: () => void
}

export default function FirstSetup({ onComplete }: FirstSetupProps) {
  const [formData, setFormData] = useState<SettingsUpdate>({
    llm_base_url: 'https://api.minimaxi.com/v1',
    llm_api_key: '',
    llm_model_name: 'MiniMax-M2.5',
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)

    try {
      await updateSettings(formData)
      onComplete()
    } catch (err: any) {
      setError(err.response?.data?.detail || 'Failed to save configuration')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex h-screen items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100">
      <div className="w-full max-w-md rounded-lg bg-white p-8 shadow-xl">
        <h1 className="mb-6 text-center text-3xl font-bold text-gray-800">
          Welcome to Paimon
        </h1>
        <p className="mb-6 text-center text-gray-600">
          Configure your LLM service to get started.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">
              LLM Base URL
            </label>
            <input
              type="text"
              value={formData.llm_base_url}
              onChange={(e) =>
                setFormData({ ...formData, llm_base_url: e.target.value })
              }
              className="w-full rounded-md border border-gray-300 px-3 py-2 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              placeholder="https://api.minimaxi.com/v1"
              required
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">
              API Key
            </label>
            <input
              type="password"
              value={formData.llm_api_key}
              onChange={(e) =>
                setFormData({ ...formData, llm_api_key: e.target.value })
              }
              className="w-full rounded-md border border-gray-300 px-3 py-2 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              placeholder="Enter API key"
              required
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
              className="w-full rounded-md border border-gray-300 px-3 py-2 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              placeholder="MiniMax-M2.5"
              required
            />
          </div>

          {error && (
            <div className="rounded-md bg-red-50 p-3 text-sm text-red-600">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-md bg-blue-600 px-4 py-2 text-white transition-colors hover:bg-blue-700 disabled:bg-gray-400"
          >
            {loading ? 'Saving...' : 'Start'}
          </button>
        </form>
      </div>
    </div>
  )
}
