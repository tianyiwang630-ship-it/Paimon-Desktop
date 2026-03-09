interface StartupFailureProps {
  reason: string
  logPath: string
  retrying: boolean
  onRetry: () => void | Promise<void>
  onOpenLogs: () => void | Promise<void>
}

export default function StartupFailure({
  reason,
  logPath,
  retrying,
  onRetry,
  onOpenLogs,
}: StartupFailureProps) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--app-surface)] px-6">
      <div className="w-full max-w-2xl rounded-[28px] border border-[var(--app-border)] bg-[var(--app-surface-elevated)] p-8 shadow-[0_20px_60px_rgba(31,35,43,0.08)]">
        <h1 className="text-3xl font-bold text-[var(--app-text)]">Backend startup failed</h1>
        <p className="mt-3 text-sm text-[var(--app-text-muted)]">
          Paimon could not start its local backend, so setup is unavailable until startup succeeds.
        </p>

        <div className="mt-6 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {reason}
        </div>

        <div className="mt-4 rounded-2xl border border-[var(--app-border)] bg-[var(--app-surface-muted)] p-4 text-sm text-[var(--app-text-muted)]">
          <div className="font-medium text-[var(--app-text)]">Startup log</div>
          <div className="mt-2 break-all">{logPath}</div>
        </div>

        <div className="mt-6 flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => void onRetry()}
            disabled={retrying}
            className="rounded-xl bg-[var(--app-accent)] px-4 py-2 text-white transition-colors hover:bg-[var(--app-accent-hover)] disabled:bg-gray-400"
          >
            {retrying ? 'Retrying...' : 'Retry startup'}
          </button>
          <button
            type="button"
            onClick={() => void onOpenLogs()}
            className="rounded-xl border border-[var(--app-border)] bg-[var(--app-surface-muted)] px-4 py-2 text-[var(--app-text)] transition-colors hover:bg-[var(--app-surface-elevated)]"
          >
            Open logs
          </button>
        </div>
      </div>
    </div>
  )
}
