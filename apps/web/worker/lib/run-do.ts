// Helpers for talking to a run's Coordinator Durable Object. The DO is keyed
// deterministically by run id, so any Worker invocation reaches the same
// instance for a given run.
import type { Env } from '../env'

export function runStub(env: Env, runId: string): DurableObjectStub {
  return env.RUN_COORDINATOR.get(env.RUN_COORDINATOR.idFromName(runId))
}

/** Call an internal DO endpoint. Returns the raw Response (for SSE pass-through). */
export function callRunDO(
  env: Env,
  runId: string,
  path: string,
  opts: { method?: 'GET' | 'POST'; body?: unknown } = {},
): Promise<Response> {
  const method = opts.method ?? (opts.body !== undefined ? 'POST' : 'GET')
  return runStub(env, runId).fetch(`https://do${path}`, {
    method,
    headers: opts.body === undefined ? undefined : { 'content-type': 'application/json' },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
}
