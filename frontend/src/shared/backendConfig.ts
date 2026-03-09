export const DEFAULT_BACKEND_HOST = '127.0.0.1'
export const DEFAULT_BACKEND_PORT = 8000
export const BACKEND_APP_ID = 'com.skills-mcp.desktop'

export const BACKEND_HOST_ENV_VAR = 'SKILLS_MCP_BACKEND_HOST'
export const BACKEND_PORT_ENV_VAR = 'SKILLS_MCP_BACKEND_PORT'
export const BACKEND_APP_ID_ENV_VAR = 'SKILLS_MCP_BACKEND_APP_ID'
export const BACKEND_APP_VERSION_ENV_VAR = 'SKILLS_MCP_BACKEND_APP_VERSION'

export function buildBackendOrigin(host: string, port: number): string {
  return `http://${host}:${port}`
}

export function buildBackendApiBaseUrl(origin: string): string {
  return `${origin}/api`
}

export function buildBackendHealthUrl(origin: string): string {
  return `${buildBackendApiBaseUrl(origin)}/health`
}

export function buildBackendRuntimeUrls(host: string, port: number) {
  const origin = buildBackendOrigin(host, port)
  return {
    origin,
    apiBaseUrl: buildBackendApiBaseUrl(origin),
    healthUrl: buildBackendHealthUrl(origin),
  }
}

export const BACKEND_ORIGIN = buildBackendOrigin(DEFAULT_BACKEND_HOST, DEFAULT_BACKEND_PORT)
export const BACKEND_API_BASE_URL = buildBackendApiBaseUrl(BACKEND_ORIGIN)
export const BACKEND_HEALTH_URL = buildBackendHealthUrl(BACKEND_ORIGIN)
