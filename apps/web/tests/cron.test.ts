import { describe, expect, test } from 'bun:test'
import { CronError, cronMatches, isValidCron, nextDue, parseCron } from '../worker/lib/cron'

describe('parseCron', () => {
  test('expands *, lists, ranges, steps', () => {
    const f = parseCron('*/15 0-2 1,15 * 1-5')
    expect([...f.minute].sort((a, b) => a - b)).toEqual([0, 15, 30, 45])
    expect([...f.hour].sort((a, b) => a - b)).toEqual([0, 1, 2])
    expect([...f.dom].sort((a, b) => a - b)).toEqual([1, 15])
    expect(f.month.size).toBe(12)
    expect([...f.dow].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5])
    expect(f.domRestricted).toBe(true)
    expect(f.dowRestricted).toBe(true)
  })

  test('treats dow 7 as Sunday (0)', () => {
    expect([...parseCron('0 0 * * 7').dow]).toEqual([0])
  })

  test('supports @macros', () => {
    expect(isValidCron('@hourly')).toBe(true)
    const f = parseCron('@daily')
    expect([...f.minute]).toEqual([0])
    expect([...f.hour]).toEqual([0])
  })

  test('rejects malformed expressions', () => {
    expect(() => parseCron('* * * *')).toThrow(CronError) // 4 fields
    expect(() => parseCron('60 * * * *')).toThrow(CronError) // minute out of range
    expect(() => parseCron('5-1 * * * *')).toThrow(CronError) // inverted range
    expect(isValidCron('*/0 * * * *')).toBe(false) // zero step
  })
})

describe('cronMatches', () => {
  test('every-15-minutes matches on the quarter hours only (UTC)', () => {
    const f = parseCron('*/15 * * * *')
    expect(cronMatches(f, new Date('2026-07-16T12:15:00Z'))).toBe(true)
    expect(cronMatches(f, new Date('2026-07-16T12:16:00Z'))).toBe(false)
  })

  test('day-of-month and day-of-week both restricted → OR', () => {
    // Fires on the 1st OR on Mondays.
    const f = parseCron('0 0 1 * 1')
    expect(cronMatches(f, new Date('2026-07-01T00:00:00Z'))).toBe(true) // 1st (a Wed)
    expect(cronMatches(f, new Date('2026-07-06T00:00:00Z'))).toBe(true) // a Monday
    expect(cronMatches(f, new Date('2026-07-07T00:00:00Z'))).toBe(false) // Tue, not 1st
  })
})

describe('nextDue', () => {
  test('returns the next quarter hour strictly after `after`', () => {
    const next = nextDue('*/15 * * * *', new Date('2026-07-16T12:16:30Z'))
    expect(next?.toISOString()).toBe('2026-07-16T12:30:00.000Z')
  })

  test('advances to the next day for a daily schedule', () => {
    const next = nextDue('@daily', new Date('2026-07-16T09:00:00Z'))
    expect(next?.toISOString()).toBe('2026-07-17T00:00:00.000Z')
  })

  test('lands exactly one minute later, never the same minute', () => {
    const next = nextDue('* * * * *', new Date('2026-07-16T12:16:00Z'))
    expect(next?.toISOString()).toBe('2026-07-16T12:17:00.000Z')
  })
})
