// Human-readable diff summary between two flow versions, stored on
// flow_versions.diff_summary and rendered in the history view. Deliberately
// terse — a changelog line, not a full patch.

import type { CodeSpec, FlowBody, FlowStep } from './schema'

function stepLabel(step: FlowStep, index: number): string {
  const target =
    'selector' in step && step.selector
      ? step.selector
      : 'url' in step && step.url
        ? step.url
        : 'name' in step && step.name
          ? step.name
          : ''
  return `#${index + 1} ${step.action}${target ? ` ${target}` : ''}`
}

function stepsEqual(a: FlowStep, b: FlowStep): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export function summarizeFlowDiff(prev: FlowBody | null, next: FlowBody): string {
  if (!prev) return 'Initial version.'

  const lines: string[] = []
  const prevSteps = prev.steps
  const nextSteps = next.steps

  const countDelta = nextSteps.length - prevSteps.length
  if (countDelta !== 0) {
    lines.push(
      `${countDelta > 0 ? 'Added' : 'Removed'} ${Math.abs(countDelta)} step${
        Math.abs(countDelta) === 1 ? '' : 's'
      } (${prevSteps.length} → ${nextSteps.length}).`,
    )
  }

  // Positional comparison over the shared prefix.
  const shared = Math.min(prevSteps.length, nextSteps.length)
  let modified = 0
  const modifiedExamples: string[] = []
  for (let i = 0; i < shared; i++) {
    if (!stepsEqual(prevSteps[i]!, nextSteps[i]!)) {
      modified++
      if (modifiedExamples.length < 3) modifiedExamples.push(stepLabel(nextSteps[i]!, i))
    }
  }
  if (modified > 0) {
    lines.push(
      `Modified ${modified} step${modified === 1 ? '' : 's'}: ${modifiedExamples.join(', ')}${
        modified > modifiedExamples.length ? ', …' : ''
      }.`,
    )
  }

  const prevProfile = JSON.stringify(prev.loadProfile ?? null)
  const nextProfile = JSON.stringify(next.loadProfile ?? null)
  if (prevProfile !== nextProfile) lines.push('Changed load profile.')

  return lines.length > 0 ? lines.join(' ') : 'No changes.'
}

/** Terse changelog line between two code-flow versions (repo/ref/filter). */
export function summarizeCodeDiff(prev: CodeSpec | null, next: CodeSpec): string {
  if (!prev) return `Initial version — ${next.repo}${next.ref ? `@${next.ref}` : ''}.`

  const lines: string[] = []
  const field = (label: string, a?: string, b?: string) => {
    if ((a ?? '') !== (b ?? '')) lines.push(`${label}: ${a || '∅'} → ${b || '∅'}.`)
  }
  field('repo', prev.repo, next.repo)
  field('ref', prev.ref, next.ref)
  field('working dir', prev.workingDir, next.workingDir)
  field('test filter', prev.testFilter, next.testFilter)
  field('grep', prev.grep, next.grep)
  field('install command', prev.installCommand, next.installCommand)
  field('test command', prev.testCommand, next.testCommand)

  return lines.length > 0 ? `Changed ${lines.join(' ')}` : 'No changes.'
}
