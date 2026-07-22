// Semantic color classes for a run/shard status badge. Shared by the runs
// table and the dashboard so a status looks the same everywhere.
export function statusBadge(status: string): string {
  switch (status) {
    case 'passed':
      return 'border-transparent bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
    case 'failed':
    case 'errored':
      return 'border-transparent bg-red-500/15 text-red-600 dark:text-red-400'
    case 'running':
      return 'border-transparent bg-blue-500/15 text-blue-600 dark:text-blue-400'
    case 'queued':
    case 'pending':
      return 'border-transparent bg-secondary text-secondary-foreground'
    default:
      return 'border-border bg-transparent text-muted-foreground'
  }
}
