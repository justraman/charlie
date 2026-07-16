// Charlie runner CLI. Invoked by the reusable workflow:
//   charlie fetch-flow --run <id> --api <url>
//   charlie execute --engine <playwright|k6> --shard <n> --run <id> --api <url>
//   charlie finalize --run <id> --api <url>
// The run token comes from the CHARLIE_RUN_TOKEN environment variable.

import type { RunnerConfig } from './api'
import { runExecute, runFetchFlow, runFinalize } from './execute'

function parseFlags(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a?.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) {
        flags[key] = next
        i++
      } else {
        flags[key] = 'true'
      }
    }
  }
  return flags
}

function required(flags: Record<string, string>, key: string, envKey?: string): string {
  const value = flags[key] ?? (envKey ? process.env[envKey] : undefined)
  if (!value) throw new Error(`missing --${key}${envKey ? ` (or $${envKey})` : ''}`)
  return value
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2)
  const flags = parseFlags(rest)

  const runToken = process.env.CHARLIE_RUN_TOKEN
  if (!runToken) throw new Error('CHARLIE_RUN_TOKEN is required')
  const cfg: RunnerConfig = {
    apiUrl: required(flags, 'api', 'CHARLIE_API').replace(/\/$/, ''),
    runToken,
  }
  const runId = required(flags, 'run', 'CHARLIE_RUN_ID')

  switch (command) {
    case 'fetch-flow':
      await runFetchFlow(cfg, runId)
      break
    case 'execute': {
      const engine = required(flags, 'engine') as 'playwright' | 'k6'
      const shardIndex = Number(required(flags, 'shard'))
      await runExecute({ cfg, runId, shardIndex, engine })
      break
    }
    case 'finalize':
      await runFinalize(cfg, runId)
      break
    default:
      throw new Error(
        `unknown command: ${command ?? '(none)'} (expected fetch-flow|execute|finalize)`,
      )
  }
}

main().catch((err) => {
  console.error(`[charlie] ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
