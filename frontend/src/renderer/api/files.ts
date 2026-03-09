import { apiClient } from './client'

export interface FileInfo {
  name: string
  path: string
  size: number
  is_dir: boolean
}

export interface UploadFolderLocalResult {
  imported_count: number
  failed_count: number
  first_error?: string
  root_name: string
}

export interface UploadConflictItem {
  path: string
  name: string
  is_dir: boolean
}

export interface UploadConflictsCheckResult {
  has_conflicts: boolean
  conflicts: UploadConflictItem[]
}

export type ConflictStrategy = 'replace' | 'rename'

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
  params: ScopedParams & { relativePath?: string; signal?: AbortSignal; conflictStrategy?: ConflictStrategy }
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
      conflict_strategy: params.conflictStrategy || undefined,
    },
    signal: params.signal,
  })
  return response.data
}

export async function checkInputConflicts(
  params: ScopedParams & { relativePaths: string[] }
): Promise<UploadConflictsCheckResult> {
  const response = await apiClient.post<UploadConflictsCheckResult>('/files/input-conflicts/check', {
    session_id: params.sessionId,
    project_id: params.projectId || undefined,
    relative_paths: params.relativePaths,
  })
  return response.data
}

export async function uploadFolderLocal(
  params: ScopedParams & {
    folderPath: string
    signal?: AbortSignal
    conflictStrategy?: ConflictStrategy
  }
): Promise<UploadFolderLocalResult> {
  const response = await apiClient.post<UploadFolderLocalResult>(
    '/files/upload-folder-local',
    {
      session_id: params.sessionId,
      project_id: params.projectId || undefined,
      folder_path: params.folderPath,
      conflict_strategy: params.conflictStrategy || undefined,
    },
    {
      signal: params.signal,
    }
  )
  return response.data
}

export async function deleteInputItem(
  params: ScopedParams & { path: string }
): Promise<{ deleted: boolean; path: string; is_dir: boolean }> {
  const response = await apiClient.delete<{ deleted: boolean; path: string; is_dir: boolean }>(
    '/files/input-item',
    {
      params: {
        session_id: params.sessionId,
        project_id: params.projectId || undefined,
        path: params.path,
      },
    }
  )
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
