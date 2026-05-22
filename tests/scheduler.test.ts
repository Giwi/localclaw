import { describe, it, expect } from 'vitest'
import { parseSchedule, getNextRun, isValidCron } from '../src/scheduler.js'

describe('parseSchedule', () => {
  it('parses "every 5m"', () => {
    expect(parseSchedule('every 5m')).toEqual({ type: 'interval', minutes: 5 })
  })

  it('parses "every 10 minutes"', () => {
    expect(parseSchedule('every 10 minutes')).toEqual({ type: 'interval', minutes: 10 })
  })

  it('parses "every 1 min"', () => {
    expect(parseSchedule('every 1 min')).toEqual({ type: 'interval', minutes: 1 })
  })

  it('parses "every 2h"', () => {
    expect(parseSchedule('every 2h')).toEqual({ type: 'interval', minutes: 120 })
  })

  it('parses "every 3 hours"', () => {
    expect(parseSchedule('every 3 hours')).toEqual({ type: 'interval', minutes: 180 })
  })

  it('parses "daily at 08:30"', () => {
    expect(parseSchedule('daily at 08:30')).toEqual({ type: 'daily', minutes: 1440, time: '08:30' })
  })

  it('parses "every day at 23:00"', () => {
    expect(parseSchedule('every day at 23:00')).toEqual({ type: 'daily', minutes: 1440, time: '23:00' })
  })

  it('pads single-hour daily times', () => {
    expect(parseSchedule('daily at 8:05')).toEqual({ type: 'daily', minutes: 1440, time: '08:05' })
  })

  it('parses "daily"', () => {
    expect(parseSchedule('daily')).toEqual({ type: 'interval', minutes: 1440 })
  })

  it('parses "every day"', () => {
    expect(parseSchedule('every day')).toEqual({ type: 'interval', minutes: 1440 })
  })

  it('parses "once a day"', () => {
    expect(parseSchedule('once a day')).toEqual({ type: 'interval', minutes: 1440 })
  })

  it('parses "weekly"', () => {
    expect(parseSchedule('weekly')).toEqual({ type: 'interval', minutes: 10080 })
  })

  it('parses "every week"', () => {
    expect(parseSchedule('every week')).toEqual({ type: 'interval', minutes: 10080 })
  })

  it('defaults to 24h interval for unknown format', () => {
    expect(parseSchedule('foobar')).toEqual({ type: 'interval', minutes: 1440 })
  })

  it('clamps minutes to minimum 1', () => {
    expect(parseSchedule('every 0m')).toEqual({ type: 'interval', minutes: 1 })
    expect(parseSchedule('every 0h')).toEqual({ type: 'interval', minutes: 1 })
  })

  it('is case-insensitive', () => {
    expect(parseSchedule('EVERY 5M')).toEqual({ type: 'interval', minutes: 5 })
    expect(parseSchedule('Daily At 09:00')).toEqual({ type: 'daily', minutes: 1440, time: '09:00' })
  })

  it('handles extra whitespace', () => {
    expect(parseSchedule('  every   15m  ')).toEqual({ type: 'interval', minutes: 15 })
  })

  it('favors earlier match (minute over hour)', () => {
    expect(parseSchedule('every 5h')).toEqual({ type: 'interval', minutes: 300 })
    expect(parseSchedule('every 5m')).toEqual({ type: 'interval', minutes: 5 })
  })

  it('recognizes cron expressions', () => {
    const result = parseSchedule('30 9 * * 1-5')
    expect(result.type).toBe('cron')
    expect(result.cron).toBe('30 9 * * 1-5')
  })
})

describe('getNextRun', () => {
  const base = new Date(2026, 4, 17, 12, 0, 0)

  it('adds interval to "after" date', () => {
    const next = getNextRun('every 30m', base)
    expect(next.getTime()).toBe(base.getTime() + 30 * 60 * 1000)
  })

  it('schedules daily at specified time if not yet passed', () => {
    const next = getNextRun('daily at 14:00', base)
    expect(next.getHours()).toBe(14)
    expect(next.getMinutes()).toBe(0)
    expect(next.getTime()).toBeGreaterThan(base.getTime())
  })

  it('schedules daily at specified time and moves to next day if already past', () => {
    const next = getNextRun('daily at 08:00', base)
    expect(next.getHours()).toBe(8)
    expect(next.getMinutes()).toBe(0)
    expect(next.getTime()).toBeGreaterThan(base.getTime())
    const diff = (next.getTime() - base.getTime()) / (24 * 60 * 60 * 1000)
    expect(diff).toBeGreaterThan(0.5)
  })

  it('handles weekly interval', () => {
    const next = getNextRun('weekly', base)
    expect(next.getTime()).toBe(base.getTime() + 7 * 24 * 60 * 60 * 1000)
  })

  it('returns a future date for cron expressions', () => {
    const next = getNextRun('30 9 * * 1-5', base)
    expect(next.getTime()).toBe(base.getTime() + 60 * 1000)
  })

  it('always returns a date in the future', () => {
    const next = getNextRun('every 1m')
    expect(next.getTime()).toBeGreaterThan(Date.now())
  })
})

describe('isValidCron', () => {
  it('accepts valid 5-field cron expressions', () => {
    expect(isValidCron('*/5 * * * *')).toBe(true)
    expect(isValidCron('30 9 * * 1-5')).toBe(true)
    expect(isValidCron('0 0 1 * *')).toBe(true)
    expect(isValidCron('15,45 * * * *')).toBe(true)
  })

  it('rejects expressions with fewer than 5 fields', () => {
    expect(isValidCron('* * * *')).toBe(false)
    expect(isValidCron('* * *')).toBe(false)
  })

  it('rejects expressions with more than 5 fields', () => {
    expect(isValidCron('* * * * * *')).toBe(false)
  })

  it('rejects expressions with invalid characters', () => {
    expect(isValidCron('x * * * *')).toBe(false)
  })

  it('rejects empty string', () => {
    expect(isValidCron('')).toBe(false)
  })
})
