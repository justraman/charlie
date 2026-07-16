// Minimal standard cron support for scheduling. Five fields
// (minute hour day-of-month month day-of-week) plus a few `@macro` shorthands.
// All evaluation is in UTC — schedules fire on wall-clock UTC, matching the way
// Cloudflare Cron Triggers invoke the Worker.
//
// Field syntax per position: `*`, a number, `a-b` range, `*/n` or `a-b/n` step,
// and comma-separated lists of those. Day-of-week is 0–6 (0 = Sunday); 7 is
// accepted as Sunday too. When BOTH day-of-month and day-of-week are restricted
// (neither is `*`), a date matches if EITHER field matches — the standard
// (Vixie) cron rule.

export interface CronFields {
  minute: Set<number>
  hour: Set<number>
  dom: Set<number>
  month: Set<number>
  dow: Set<number>
  domRestricted: boolean
  dowRestricted: boolean
}

const MACROS: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
}

const RANGES: Record<string, { min: number; max: number }> = {
  minute: { min: 0, max: 59 },
  hour: { min: 0, max: 23 },
  dom: { min: 1, max: 31 },
  month: { min: 1, max: 12 },
  dow: { min: 0, max: 6 },
}

export class CronError extends Error {}

// Parse one field into the set of matching integers within [min,max].
function parseField(field: string, name: keyof typeof RANGES): Set<number> {
  const { min, max } = RANGES[name]!
  const out = new Set<number>()
  for (const part of field.split(',')) {
    if (part === '') throw new CronError(`empty term in ${name} field`)
    let range = part
    let step = 1
    const slash = part.indexOf('/')
    if (slash !== -1) {
      range = part.slice(0, slash)
      step = Number(part.slice(slash + 1))
      if (!Number.isInteger(step) || step < 1) throw new CronError(`bad step in ${name}: ${part}`)
    }
    let lo: number
    let hi: number
    if (range === '*') {
      lo = min
      hi = max
    } else if (range.includes('-')) {
      const [a, b] = range.split('-')
      lo = Number(a)
      hi = Number(b)
    } else {
      lo = Number(range)
      hi = lo
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) {
      throw new CronError(`non-numeric term in ${name}: ${part}`)
    }
    // Day-of-week 7 == Sunday (0).
    if (name === 'dow') {
      if (lo === 7) lo = 0
      if (hi === 7) hi = 0
    }
    if (lo > hi) throw new CronError(`inverted range in ${name}: ${part}`)
    if (lo < min || hi > max) throw new CronError(`out of range in ${name}: ${part}`)
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return out
}

/** Parse a cron expression (or `@macro`) into matchable field sets. Throws CronError. */
export function parseCron(expr: string): CronFields {
  const trimmed = expr.trim()
  const normalized = MACROS[trimmed] ?? trimmed
  const parts = normalized.split(/\s+/)
  if (parts.length !== 5) {
    throw new CronError('expected 5 fields (minute hour day-of-month month day-of-week)')
  }
  const [minute, hour, dom, month, dow] = parts as [string, string, string, string, string]
  return {
    minute: parseField(minute, 'minute'),
    hour: parseField(hour, 'hour'),
    dom: parseField(dom, 'dom'),
    month: parseField(month, 'month'),
    dow: parseField(dow, 'dow'),
    domRestricted: dom !== '*',
    dowRestricted: dow !== '*',
  }
}

/** True iff `date` (evaluated in UTC) satisfies the cron fields. */
export function cronMatches(fields: CronFields, date: Date): boolean {
  if (!fields.minute.has(date.getUTCMinutes())) return false
  if (!fields.hour.has(date.getUTCHours())) return false
  if (!fields.month.has(date.getUTCMonth() + 1)) return false

  const domOk = fields.dom.has(date.getUTCDate())
  const dowOk = fields.dow.has(date.getUTCDay())
  // Both restricted → OR; otherwise the restricted one (or both `*`) must hold.
  if (fields.domRestricted && fields.dowRestricted) return domOk || dowOk
  if (fields.domRestricted) return domOk
  if (fields.dowRestricted) return dowOk
  return true
}

// ~366 days of minutes: an upper bound so an impossible expression (e.g. Feb 30)
// terminates instead of looping forever.
const MAX_MINUTES = 366 * 24 * 60

/**
 * The next UTC time strictly after `after` at which the expression fires,
 * aligned to the start of the minute. Returns null if none within ~1 year.
 */
export function nextDue(expr: string, after: Date): Date | null {
  const fields = parseCron(expr)
  // Start at the next whole minute after `after`.
  const cursor = new Date(after.getTime())
  cursor.setUTCSeconds(0, 0)
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1)
  for (let i = 0; i < MAX_MINUTES; i++) {
    if (cronMatches(fields, cursor)) return cursor
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1)
  }
  return null
}

/** Validate without throwing — for API input checks. */
export function isValidCron(expr: string): boolean {
  try {
    parseCron(expr)
    return true
  } catch {
    return false
  }
}
