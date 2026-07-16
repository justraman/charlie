// Minimal ambient declarations for the Bun/Node runtime the CLI runs under,
// so the package typechecks without pulling in full @types/node.
declare const process: {
  env: Record<string, string | undefined>
  argv: string[]
  exit(code?: number): never
}

// The k6 engine writes the bundled script + reads the summary from disk and
// spawns the `k6` binary. Only the surface actually used is declared here.
declare module 'node:fs' {
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void
  export function writeFileSync(path: string, data: string): void
  export function readFileSync(path: string, encoding: 'utf8'): string
  export function existsSync(path: string): boolean
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void
}

declare namespace Bun {
  function spawnSync(
    cmd: string[],
    options?: { cwd?: string; env?: Record<string, string | undefined> },
  ): { exitCode: number | null; success: boolean; stdout: Uint8Array; stderr: Uint8Array }
}
