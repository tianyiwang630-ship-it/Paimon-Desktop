import { apiClient } from './client'
import type { Project, ProjectCreate } from '../types'

export async function listProjects(): Promise<Project[]> {
  const response = await apiClient.get<Project[]>('/projects')
  return response.data
}

export async function createProject(data: ProjectCreate): Promise<Project> {
  const response = await apiClient.post<Project>('/projects', data)
  return response.data
}

export async function getProject(projectId: string): Promise<Project> {
  const response = await apiClient.get<Project>(`/projects/${projectId}`)
  return response.data
}

export async function updateProject(
  projectId: string,
  data: Partial<ProjectCreate>
): Promise<Project> {
  const response = await apiClient.patch<Project>(`/projects/${projectId}`, data)
  return response.data
}

export async function deleteProject(projectId: string): Promise<void> {
  await apiClient.delete(`/projects/${projectId}`, {
    params: { hard: true },
  })
}
