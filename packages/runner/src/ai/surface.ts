// Lightweight static surface extraction from a checked-out repo. This keeps the
// AI prompt focused and cheap: instead of shipping the whole repo, we extract
// candidate routes/pages, forms and their fields, elements carrying stable test
// ids, and framework hints. All regex/heuristic — best-effort, never executed.

import { readdirSync, readFileSync, statSync } from 'node:fs'

export interface FormField {
  name: string
  type?: string
}
export interface FormSurface {
  file: string
  route?: string
  fields: FormField[]
}
export interface RouteSurface {
  path: string
  file: string
}
export interface RepoSurface {
  framework: string[]
  routes: RouteSurface[]
  forms: FormSurface[]
  testIds: { id: string; file: string }[]
  files: number
}

const CODE_EXT = /\.(tsx?|jsx?|vue|svelte|html)$/
const SKIP_DIR = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'out',
  'coverage',
  '.turbo',
  '.nx',
  'vendor',
])
const MAX_FILES = 2000
const MAX_FILE_BYTES = 400_000

/** Recursively collect code files under `dir` (repo-relative paths), bounded. */
function collectFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string, rel: string) => {
    if (out.length >= MAX_FILES) return
    let entries: ReturnType<typeof readdirSync>
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES) break
      const abs = `${dir}/${e.name}`
      const relPath = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (!SKIP_DIR.has(e.name) && !e.name.startsWith('.')) walk(abs, relPath)
      } else if (e.isFile() && CODE_EXT.test(e.name)) {
        out.push(relPath)
      }
    }
  }
  walk(root, '')
  return out
}

function readSafe(root: string, rel: string): string | null {
  try {
    if (statSync(`${root}/${rel}`).size > MAX_FILE_BYTES) return null
    return readFileSync(`${root}/${rel}`, 'utf8')
  } catch {
    return null
  }
}

// Next.js file-router path from a pages/app file path.
function nextRoute(rel: string): string | null {
  const m = rel.match(/(?:^|\/)(?:app|pages)\/(.+)\.(tsx?|jsx?)$/)
  if (!m) return null
  let p = m[1]!
  if (/(^|\/)(_app|_document|layout|page|route|index)$/.test(`/${p}`)) {
    p = p.replace(/\/?(page|route|index|layout|_app|_document)$/, '')
  }
  p = p.replace(/\[([^\]]+)\]/g, ':$1') // [id] → :id
  return `/${p}`.replace(/\/+$/, '') || '/'
}

function extractRoutes(rel: string, src: string): string[] {
  const routes = new Set<string>()
  // react-router / vue-router style: path="/x" or path: '/x'
  for (const m of src.matchAll(/\bpath\s*[:=]\s*["'`]([^"'`]+)["'`]/g)) {
    const p = m[1]!
    if (p.startsWith('/') || p === '*') routes.add(p)
  }
  // Next.js file conventions.
  const nr = nextRoute(rel)
  if (nr) routes.add(nr)
  return [...routes]
}

function extractForms(rel: string, src: string): FormSurface[] {
  const forms: FormSurface[] = []
  // Split on <form> occurrences and read the inputs that follow (bounded window).
  const formIdx = [...src.matchAll(/<form\b/gi)].map((m) => m.index ?? 0)
  for (const idx of formIdx) {
    const window = src.slice(idx, idx + 2000)
    const fields: FormField[] = []
    for (const f of window.matchAll(
      /<(?:input|select|textarea)\b[^>]*\bname=["']([^"']+)["'][^>]*>/gi,
    )) {
      const tag = f[0]!
      const typeM = tag.match(/\btype=["']([^"']+)["']/i)
      fields.push({ name: f[1]!, type: typeM?.[1] })
    }
    if (fields.length) forms.push({ file: rel, fields })
  }
  return forms
}

function detectFramework(root: string): string[] {
  const pkg = readSafe(root, 'package.json')
  const hints: string[] = []
  if (!pkg) return hints
  const map: Record<string, string> = {
    next: 'next',
    'react-router-dom': 'react-router',
    'vue-router': 'vue-router',
    '@remix-run/react': 'remix',
    '@sveltejs/kit': 'sveltekit',
    'react-dom': 'react',
    vue: 'vue',
    svelte: 'svelte',
  }
  for (const [dep, label] of Object.entries(map)) {
    if (new RegExp(`"${dep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*:`).test(pkg)) {
      if (!hints.includes(label)) hints.push(label)
    }
  }
  return hints
}

/** Extract the static surface of a repo checked out at `root`. */
export function extractSurface(root: string): RepoSurface {
  const files = collectFiles(root)
  const routes: RouteSurface[] = []
  const forms: FormSurface[] = []
  const testIds: { id: string; file: string }[] = []
  const seenRoutes = new Set<string>()
  const seenTestIds = new Set<string>()

  for (const rel of files) {
    const src = readSafe(root, rel)
    if (!src) continue
    for (const p of extractRoutes(rel, src)) {
      const key = `${p}`
      if (!seenRoutes.has(key)) {
        seenRoutes.add(key)
        routes.push({ path: p, file: rel })
      }
    }
    forms.push(...extractForms(rel, src))
    for (const m of src.matchAll(/\bdata-test(?:id|-id)?=["']([^"']+)["']/g)) {
      const id = m[1]!
      if (!seenTestIds.has(id) && seenTestIds.size < 200) {
        seenTestIds.add(id)
        testIds.push({ id, file: rel })
      }
    }
  }

  return {
    framework: detectFramework(root),
    routes: routes.slice(0, 100),
    forms: forms.slice(0, 50),
    testIds: testIds.slice(0, 200),
    files: files.length,
  }
}
