// Ambient declaration for the virtual module esbuild injects at bundle time
// (packages/runner/src/k6-engine.ts). It carries the compiled scenarios, the
// resolved k6 options (stages + thresholds), and the environment base URL.
declare module 'virtual:charlie-scenario' {
  import type { K6Scenario } from '@charlie/flow-core'
  export const options: {
    stages: { duration: string; target: number }[]
    thresholds: Record<string, string[]>
  }
  export const scenarios: K6Scenario[]
  export const baseUrl: string
  /** File path handleSummary writes the k6 summary JSON to (relative to cwd). */
  export const summaryPath: string
}
