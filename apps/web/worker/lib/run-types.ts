// Shapes exchanged between the compute plane (runner) and the control plane
// (Worker + Run Coordinator DO).

export type ShardStatus = 'pending' | 'running' | 'passed' | 'failed' | 'errored'
export type RunStatus = 'queued' | 'running' | 'passed' | 'failed' | 'cancelled'

export interface FlowResultEntry {
  flow: string
  status: 'passed' | 'failed'
  durationMs?: number
  failedStep?: number
  error?: string
}

// Posted by a runner to /api/runs/:id/shard-result.
export interface ShardResultPayload {
  shardIndex: number
  status: 'passed' | 'failed' | 'errored'
  runner?: string
  publicIp?: string
  flowResults?: FlowResultEntry[]
  metrics?: unknown
  runtimeIssues?: unknown
  events?: unknown
  artifactKeys?: string[]
}

// What the DO initializes with when a run is created.
export interface RunInit {
  orgId: string
  engine: 'playwright' | 'k6'
  expectedShards: number
  flowSelection: { flowId: string; versionId: string; name: string; kind?: 'steps' | 'code' }[]
}

// Live snapshot / SSE event payload.
export interface RunSnapshot {
  runId: string
  status: RunStatus
  expectedShards: number
  reportedShards: number
  shards: { index: number; status: ShardStatus }[]
  finalizeSeen: boolean
  terminal: boolean
}
