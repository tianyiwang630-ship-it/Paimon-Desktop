export type ChatRunStatus =
  | 'running'
  | 'recovering'
  | 'success'
  | 'failed'
  | 'permission_required'
  | 'interrupted'
  | 'error'

export function normalizeChatRunStatus(status: unknown): ChatRunStatus {
  const value = String(status || '').trim().toLowerCase()
  if (value === 'error') return 'failed'
  if (
    value === 'running' ||
    value === 'recovering' ||
    value === 'success' ||
    value === 'failed' ||
    value === 'permission_required' ||
    value === 'interrupted'
  ) {
    return value
  }
  return 'failed'
}

export function isActiveChatRunStatus(status: unknown): boolean {
  const normalized = normalizeChatRunStatus(status)
  return normalized === 'running' || normalized === 'recovering'
}

export function getRecoveryNotice(status: unknown, response?: string | null): string {
  if (normalizeChatRunStatus(status) !== 'recovering') return ''
  const message = String(response || '').trim()
  return message || 'Recovering from a transient model/provider issue. The task will continue automatically.'
}
