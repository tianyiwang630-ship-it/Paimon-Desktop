export type AppStartupState = 'starting' | 'ready' | 'failed'

export interface AppRuntimeStatus {
  backendOrigin: string
  backendApiBaseUrl: string
  backendHealthUrl: string
  startupState: AppStartupState
  startupFailureReason: string | null
  logPath: string
}

export interface OpenPathResult {
  ok: boolean
  path?: string
  error?: string
}
