import axios from 'axios'
import { BACKEND_API_BASE_URL } from '../../shared/backendConfig'

const API_BASE_URL = BACKEND_API_BASE_URL

export const apiClient = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
  },
})

export function setApiBaseUrl(baseURL: string): void {
  apiClient.defaults.baseURL = baseURL.replace(/\/+$/, '')
}

export function getApiErrorMessage(error: unknown, fallback: string): string {
  if (axios.isAxiosError(error)) {
    const detail = error.response?.data?.detail
    if (typeof detail === 'string' && detail.trim()) {
      return detail.trim()
    }
    if (!error.response) {
      return 'Backend is unavailable. Please retry after backend startup completes.'
    }
    if (typeof error.message === 'string' && error.message.trim()) {
      return error.message.trim()
    }
  }

  if (error instanceof Error && error.message.trim()) {
    return error.message.trim()
  }

  return fallback
}

apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    console.error('API Error:', error)
    return Promise.reject(error)
  }
)
