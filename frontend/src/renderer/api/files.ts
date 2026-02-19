import { apiClient } from './client'

export interface FileInfo {
  name: string
  path: string
  size: number
  is_dir: boolean
}

interface ScopedParams {
  sessionId: string
  projectId?: string | null
  path?: string
}

function buildParams(params: ScopedParams) {
  return {
    session_id: params.sessionId,
    project_id: params.projectId || undefined,
    path: params.path || undefined,
  }
}

export async function listInputFiles(params: ScopedParams): Promise<FileInfo[]> {
  const response = await apiClient.get<FileInfo[]>('/files/input', {
    params: buildParams(params),
  })
  return response.data
}

export async function listOutputFiles(params: ScopedParams): Promise<FileInfo[]> {
  const response = await apiClient.get<FileInfo[]>('/files/output', {
    params: buildParams(params),
  })
  return response.data
}

export async function listTempFiles(params: ScopedParams): Promise<FileInfo[]> {
  const response = await apiClient.get<FileInfo[]>('/files/temp', {
    params: buildParams(params),
  })
  return response.data
}

export async function uploadFile(
  file: File,
  params: ScopedParams & { relativePath?: string }
): Promise<{
  name: string
  size: number
  path: string
}> {
  const formData = new FormData()
  formData.append('file', file)

  const response = await apiClient.post('/files/upload', formData, {
    headers: {
      'Content-Type': 'multipart/form-data',
    },
    params: {
      ...buildParams(params),
      relative_path: params.relativePath || undefined,
    },
  })
  return response.data
}

export function getDownloadUrl(path: string, params: ScopedParams): string {
  const q = new URLSearchParams({
    path,
    session_id: params.sessionId,
  })
  if (params.projectId) {
    q.set('project_id', params.projectId)
  }
  return `${apiClient.defaults.baseURL}/files/download?${q.toString()}`
}

export function getDownloadZipUrl(path: string, params: ScopedParams): string {
  const q = new URLSearchParams({
    path,
    session_id: params.sessionId,
  })
  if (params.projectId) {
    q.set('project_id', params.projectId)
  }
  return `${apiClient.defaults.baseURL}/files/download-zip?${q.toString()}`
}

export function getDownloadOutputZipUrl(params: ScopedParams): string {
  const q = new URLSearchParams({
    session_id: params.sessionId,
  })
  if (params.projectId) {
    q.set('project_id', params.projectId)
  }
  return `${apiClient.defaults.baseURL}/files/download-output-zip?${q.toString()}`
}

export function getDownloadTempZipUrl(params: ScopedParams): string {
  const q = new URLSearchParams({
    session_id: params.sessionId,
  })
  if (params.projectId) {
    q.set('project_id', params.projectId)
  }
  return `${apiClient.defaults.baseURL}/files/download-temp-zip?${q.toString()}`
}
