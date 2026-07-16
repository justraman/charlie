// Minimal ambient declarations for the Bun/Node runtime the CLI runs under,
// so the package typechecks without pulling in full @types/node.
declare const process: {
  env: Record<string, string | undefined>
  argv: string[]
  exit(code?: number): never
}
