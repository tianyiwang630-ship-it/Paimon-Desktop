import { apiClient } from './client'

export interface AppGuideResponse {
  guide: string
}

export interface SkillCatalogItem {
  name: string
  description: string
}

export interface SkillCatalogResponse {
  skills: SkillCatalogItem[]
}

export async function getAppGuide(): Promise<AppGuideResponse> {
  const response = await apiClient.get<AppGuideResponse>('/meta/guide')
  return response.data
}

export async function getSkillCatalog(): Promise<SkillCatalogResponse> {
  const controller = new AbortController()
  const timeoutId = window.setTimeout(() => controller.abort(), 5000)
  try {
    const response = await apiClient.get<SkillCatalogResponse>('/meta/skills', {
      timeout: 5000,
      signal: controller.signal,
    })
    return response.data
  } finally {
    window.clearTimeout(timeoutId)
  }
}
