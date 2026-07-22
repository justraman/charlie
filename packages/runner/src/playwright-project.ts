// Code-flow engine: run a user's real Playwright test project from a GitHub repo.
//
// Unlike a `steps` flow (executed step-by-step by @charlie/flow-core), a `code`
// flow points at a repo containing a Playwright project. We check it out on the
// compute plane, install its dependencies, and invoke `playwright test`,
// injecting the target environment through a small, framework-free contract:
//
//   CHARLIE_BASE_URL          the environment's base_url
//   CHARLIE_HEADERS           JSON of the environment's default headers
//   CHARLIE_SECRET_<NAME>     one variable per environment secret
//
// The repo's playwright.config.ts reads these (see examples/playwright-custom-tests).
// We parse Playwright's JSON reporter to decide pass/fail and upload the report
// plus any traces to R2, reusing the same shard-result pipeline as steps flows.
//
// Style note: this package hand-declares a minimal Node/Bun surface (globals.d.ts)
// rather than pulling in @types/node, so we shell out with Bun.spawnSync and use
// the sync fs APIs — mirroring k6-engine.ts.

import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CodeSpec } from '@charlie/flow-core'
import type { Bundle, BundleFlow } from './api'

export interface CodeFlowResult {
  flow: string
  status: 'passed' | 'failed'
  durationMs?: number
  error?: string
  artifactKeys: string[]
}

type Uploader = (name: string, bytes: Uint8Array, contentType: string) => Promise<string>
type Env = Record<string, string | undefined>

interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

const MAX_LOG_BYTES = 512 * 1024
const decoder = new TextDecoder()

// Playwright's JSON reporter shape (only the fields we read).
interface PwReport {
  stats?: { expected?: number; unexpected?: number; flaky?: number; skipped?: number }
  errors?: unknown[]
}

/** Run a command synchronously, capturing combined output. Never throws. */
function exec(cmd: string[], opts: { cwd: string; env: Env }): ExecResult {
  const r = Bun.spawnSync(cmd, { cwd: opts.cwd, env: opts.env })
  return {
    code: r.exitCode ?? (r.success ? 0 : 1),
    stdout: decoder.decode(r.stdout),
    stderr: decoder.decode(r.stderr),
  }
}

/** A filesystem-safe key for caching a repo checkout within the workspace. */
function repoKey(spec: CodeSpec): string {
  return `${spec.repo}@${spec.ref ?? 'default'}`.replace(/[^\w.-]/g, '_')
}

/** Clone (once per repo+ref) into workspaceRoot and return the checkout dir. */
function ensureCheckout(
  spec: CodeSpec,
  workspaceRoot: string,
  cloneToken: string | null,
  log: string[],
): string {
  const dir = join(workspaceRoot, repoKey(spec))
  if (existsSync(join(dir, '.git'))) {
    log.push(`  reusing existing checkout of ${spec.repo}`)
    return dir
  }
  mkdirSync(workspaceRoot, { recursive: true })

  // Authenticated HTTPS clone. The token is a short-lived GitHub App
  // installation token minted by the control plane for this run only.
  const auth = cloneToken ? `x-access-token:${cloneToken}@` : ''
  const url = `https://${auth}github.com/${spec.repo}.git`
  const env: Env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }

  // A shallow clone of the wanted ref is cheapest; fall back to a full clone +
  // checkout when the ref is a commit SHA that `--branch` cannot target.
  const cloneArgs = ['git', 'clone', '--depth', '1']
  if (spec.ref) cloneArgs.push('--branch', spec.ref)
  cloneArgs.push(url, dir)
  let res = exec(cloneArgs, { cwd: workspaceRoot, env })
  if (res.code !== 0 && spec.ref) {
    log.push(`  shallow clone of ref "${spec.ref}" failed; retrying with full clone`)
    res = exec(['git', 'clone', url, dir], { cwd: workspaceRoot, env })
    if (res.code === 0) {
      const co = exec(['git', 'checkout', spec.ref], { cwd: dir, env })
      if (co.code !== 0)
        throw new Error(`git checkout ${spec.ref} failed: ${co.stderr.slice(0, 300)}`)
    }
  }
  if (res.code !== 0) {
    // Never echo the URL (it embeds the token) — report the repo slug only.
    throw new Error(`git clone ${spec.repo} failed (exit ${res.code}): ${res.stderr.slice(0, 300)}`)
  }
  log.push(`  cloned ${spec.repo}${spec.ref ? `@${spec.ref}` : ''}`)
  return dir
}

/** Pick an install command from the lockfile present in the project dir. */
function detectInstall(projectDir: string): string[] {
  const has = (f: string) => existsSync(join(projectDir, f))
  if (has('bun.lockb') || has('bun.lock')) return ['bun', 'install', '--frozen-lockfile']
  if (has('pnpm-lock.yaml')) return ['pnpm', 'install', '--frozen-lockfile']
  if (has('yarn.lock')) return ['yarn', 'install', '--frozen-lockfile']
  if (has('package-lock.json')) return ['npm', 'ci']
  return ['npm', 'install']
}

/** Recursively collect files under `dir` matching `pred` (absolute paths). */
function walk(dir: string, pred: (name: string) => boolean, out: string[] = []): string[] {
  let entries: ReturnType<typeof readdirSync>
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) walk(full, pred, out)
    else if (pred(e.name)) out.push(full)
  }
  return out
}

/**
 * Run one code flow. `workspaceRoot` is shared across a shard's flows so repos
 * are cloned/installed once. Returns a per-flow result + uploaded artifact keys.
 */
export async function runCodeFlow(opts: {
  flow: BundleFlow
  bundle: Bundle
  workspaceRoot: string
  upload: Uploader
}): Promise<CodeFlowResult> {
  const { flow, bundle, workspaceRoot, upload } = opts
  const spec = flow.code
  const artifactKeys: string[] = []
  const log: string[] = [`code flow: ${flow.name}`, '']
  const started = Date.now()

  if (!spec) {
    return { flow: flow.name, status: 'failed', error: 'code flow missing code spec', artifactKeys }
  }

  // The environment contract handed to the user's tests.
  const env: Env = {
    ...process.env,
    CI: '1',
    CHARLIE_BASE_URL: bundle.environment.baseUrl,
    PLAYWRIGHT_BASE_URL: bundle.environment.baseUrl,
    CHARLIE_HEADERS: JSON.stringify(bundle.environment.headers ?? {}),
  }
  for (const [name, value] of Object.entries(bundle.environment.secrets ?? {})) {
    env[`CHARLIE_SECRET_${name}`] = value
  }

  try {
    const checkout = ensureCheckout(spec, workspaceRoot, bundle.cloneToken, log)
    const projectDir = spec.workingDir ? join(checkout, spec.workingDir) : checkout
    if (!existsSync(join(projectDir, 'package.json'))) {
      throw new Error(`no package.json at ${spec.workingDir ?? '.'} in ${spec.repo}`)
    }

    // Install deps (skip if node_modules already present from a prior flow).
    if (!existsSync(join(projectDir, 'node_modules'))) {
      const install = spec.installCommand
        ? ['sh', '-c', spec.installCommand]
        : detectInstall(projectDir)
      log.push(`$ ${install.join(' ')}`)
      const res = exec(install, { cwd: projectDir, env })
      log.push(res.stdout, res.stderr)
      if (res.code !== 0) throw new Error(`dependency install failed (exit ${res.code})`)
      // Ensure the browser matching the repo's Playwright is available. The
      // official Playwright image ships browsers, but a differing PW version
      // needs its own; --with-deps is skipped (the image already has the libs).
      const inst = exec(['npx', 'playwright', 'install', 'chromium'], { cwd: projectDir, env })
      if (inst.code !== 0)
        log.push(`  (playwright install chromium exited ${inst.code}; continuing)`)
    }

    // Build the test command. `playwright test` writes its JSON report to
    // PLAYWRIGHT_JSON_OUTPUT_NAME; `list` keeps human-readable output on stdout.
    const reportPath = join(projectDir, 'charlie-report.json')
    const testEnv: Env = { ...env, PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath }
    let command: string[]
    if (spec.testCommand) {
      command = ['sh', '-c', spec.testCommand]
    } else {
      command = ['npx', 'playwright', 'test', '--reporter=list,json']
      if (spec.testFilter) command.push(spec.testFilter)
      if (spec.grep) command.push('--grep', spec.grep)
    }
    log.push('', `$ ${command.join(' ')}`)
    const res = exec(command, { cwd: projectDir, env: testEnv })
    log.push(res.stdout, res.stderr)

    // Prefer the JSON report for pass/fail; fall back to the exit code.
    let status: 'passed' | 'failed' = res.code === 0 ? 'passed' : 'failed'
    let error: string | undefined
    try {
      const report = JSON.parse(readFileSync(reportPath, 'utf8')) as PwReport
      const s = report.stats ?? {}
      const unexpected = s.unexpected ?? 0
      status = unexpected === 0 && (report.errors?.length ?? 0) === 0 ? 'passed' : 'failed'
      log.push(
        '',
        `stats: expected=${s.expected ?? 0} unexpected=${unexpected} flaky=${s.flaky ?? 0} skipped=${s.skipped ?? 0}`,
      )
      if (status === 'failed') error = `${unexpected} test(s) failed`
      try {
        artifactKeys.push(
          await upload('playwright-report.json', await readFile(reportPath), 'application/json'),
        )
      } catch (e) {
        log.push(`  (report upload failed: ${e instanceof Error ? e.message : String(e)})`)
      }
    } catch {
      if (status === 'failed') error = `playwright test exited ${res.code}`
      log.push('', '(no JSON report produced; used exit code)')
    }

    // Upload Playwright traces (test-results/**/*.zip) for the report viewer.
    const resultsDir = join(projectDir, 'test-results')
    if (existsSync(resultsDir)) {
      const traces = walk(resultsDir, (n) => n.endsWith('.zip'))
      for (let i = 0; i < traces.length && i < 20; i++) {
        try {
          artifactKeys.push(
            await upload(`trace-${i}.zip`, await readFile(traces[i]!), 'application/zip'),
          )
        } catch {
          // best-effort
        }
      }
    }

    const durationMs = Date.now() - started
    log.push('', `status: ${status}`, `durationMs: ${durationMs}`)
    await uploadLog(upload, log, artifactKeys)
    return { flow: flow.name, status, durationMs, error, artifactKeys }
  } catch (err) {
    const durationMs = Date.now() - started
    const message = err instanceof Error ? err.message : String(err)
    log.push('', `ERROR: ${message}`, 'status: failed')
    await uploadLog(upload, log, artifactKeys)
    return { flow: flow.name, status: 'failed', durationMs, error: message, artifactKeys }
  }
}

async function uploadLog(upload: Uploader, log: string[], keys: string[]): Promise<void> {
  try {
    let text = log.filter(Boolean).join('\n')
    if (text.length > MAX_LOG_BYTES) text = `${text.slice(0, MAX_LOG_BYTES)}\n…(truncated)`
    keys.push(await upload('log.txt', new TextEncoder().encode(text), 'text/plain'))
  } catch {
    // best-effort
  }
}
