import { apiClient } from './client'

export interface PermissionConfirmRequest {
  session_id: string
  tool: string
  args: Record<string, any>
  action: 'allow_once' | 'allow_session' | 'deny' | 'retry_with_context' | 'switch_auto'
  extra_instruction?: string
}

export interface PermissionConfirmResponse {
  success: boolean
  message: string
}

export interface PermissionModeRequest {
  session_id: string
  mode: 'ask' | 'auto'
}

export interface PermissionModeResponse {
  success: boolean
  mode: 'ask' | 'auto'
  message: string
}

export async function confirmPermission(
  data: PermissionConfirmRequest
): Promise<PermissionConfirmResponse> {
  const response = await apiClient.post<PermissionConfirmResponse>(
    '/permissions/confirm',
    data
  )
  return response.data
}

export async function setPermissionMode(
  data: PermissionModeRequest
): Promise<PermissionModeResponse> {
  const response = await apiClient.post<PermissionModeResponse>('/permissions/mode', data)
  return response.data
}
