import { apiClient } from './client'

export interface PermissionConfirmRequest {
  session_id: string
  pending_request_id: string
  tool: string
  args: Record<string, any>
  action: 'allow_once' | 'deny' | 'retry_with_context'
  extra_instruction?: string
}

export interface PermissionConfirmResponse {
  success: boolean
  message: string
  requires_execution: boolean
  pending_request_id?: string | null
}

export interface PermissionExecuteRequest {
  session_id: string
  pending_request_id: string
}

export interface PermissionExecuteResponse {
  request_id: string
  session_id: string
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

export async function executePendingPermission(
  data: PermissionExecuteRequest
): Promise<PermissionExecuteResponse> {
  const response = await apiClient.post<PermissionExecuteResponse>(
    '/permissions/execute',
    data
  )
  return response.data
}
