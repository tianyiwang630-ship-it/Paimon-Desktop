import { useState } from 'react'
import { updateSettings } from '../api/settings'
import { getApiErrorMessage } from '../api/client'
import type { SettingsUpdate } from '../types'

interface FirstSetupProps {
  onComplete: () => void
}

export default function FirstSetup({ onComplete }: FirstSetupProps) {
  const [formData, setFormData] = useState<SettingsUpdate>({
    llm_provider: 'minimax',
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
    } catch (err) {
      setError(getApiErrorMessage(err, 'Failed to save configuration'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex h-screen items-center justify-center bg-[var(--app-surface)] px-6">
      <div className="w-full max-w-md rounded-[28px] border border-[var(--app-border)] bg-[var(--app-surface-elevated)] p-8 shadow-[0_20px_60px_rgba(31,35,43,0.08)]">
        <h1 className="mb-6 text-center text-3xl font-bold text-[var(--app-text)]">
          Welcome to Paimon
        </h1>
        <p className="mb-6 text-center text-[var(--app-text-muted)]">
          Configure your LLM service to get started.
        </p>

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
              <option value="zhipu">Zhipu</option>
              <option value="kimi">Kimi</option>
            </select>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-[var(--app-text)]">
              LLM Base URL
            </label>
            <input
              type="text"
              value={formData.llm_base_url}
              onChange={(e) =>
                setFormData({ ...formData, llm_base_url: e.target.value })
              }
              className="w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-surface-muted)] px-3 py-2 focus:border-[var(--app-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--app-accent-soft)]"
              placeholder="https://api.minimaxi.com/v1"
              required
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-[var(--app-text)]">
              API Key
            </label>
            <input
              type="password"
              value={formData.llm_api_key}
              onChange={(e) =>
                setFormData({ ...formData, llm_api_key: e.target.value })
              }
              className="w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-surface-muted)] px-3 py-2 focus:border-[var(--app-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--app-accent-soft)]"
              placeholder="Enter API key"
              required
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-[var(--app-text)]">
              Model name
            </label>
            <input
              type="text"
              value={formData.llm_model_name}
              onChange={(e) =>
                setFormData({ ...formData, llm_model_name: e.target.value })
              }
              className="w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-surface-muted)] px-3 py-2 focus:border-[var(--app-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--app-accent-soft)]"
              placeholder="MiniMax-M2.5"
              required
            />
          </div>

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
            {loading ? 'Saving...' : 'Start'}
          </button>
        </form>
      </div>
    </div>
  )
}
