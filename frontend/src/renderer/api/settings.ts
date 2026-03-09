import { apiClient } from './client'
import type { Settings, SettingsUpdate } from '../types'

export async function checkConfigStatus(): Promise<boolean> {
  const response = await apiClient.get<{ is_configured: boolean }>(
    '/settings/status'
  )
  return response.data.is_configured
}

export async function getSettings(): Promise<Settings> {
  const response = await apiClient.get<Settings>('/settings')
  return response.data
}

export async function updateSettings(data: SettingsUpdate): Promise<Settings> {
  const response = await apiClient.patch<Settings>('/settings', data)
  return response.data
}
