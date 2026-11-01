import test from 'node:test'

import { diaryDayOf, dayRange, shiftDay, isDayKey, recentDays, weekdayLabel, dateKey } from '../lib/day.js'
import { assert, assertEqual } from './helpers.mjs'

test('an instant before the cutoff belongs to the previous day', () => {
  const late = new Date(2026, 9, 31, 3, 30, 0) // 10-31 03:30
  assertEqual(diaryDayOf(late.getTime()), '2026-10-30', '3:30am counts as yesterday')
})

test('an instant at the cutoff belongs to the new day', () => {
  const boundary = new Date(2026, 9, 31, 5, 0, 0) // 10-31 05:00
  assertEqual(diaryDayOf(boundary.getTime()), '2026-10-31', '05:00 starts the new diary day')
})

test('an evening instant belongs to the same day', () => {
  const evening = new Date(2026, 9, 30, 23, 59, 59)
  assertEqual(diaryDayOf(evening.getTime()), '2026-10-30', '23:59 is still today')
})

test('the cutoff hour is configurable', () => {
  const instant = new Date(2026, 9, 31, 8, 0, 0)
  assertEqual(diaryDayOf(instant.getTime(), 9), '2026-10-30', 'a 09:00 cutoff moves 8am back a day')
})

test('dayRange spans exactly one diary day and is half-open', () => {
  const { start, end } = dayRange('2026-10-30')
  assertEqual(new Date(start).getHours(), 5, 'starts at the cutoff')
  assertEqual(new Date(end).getTime() - start, 24 * 60 * 60 * 1000, 'is 24h in a normal week')
  assert(diaryDayOf(end - 1) === '2026-10-30', 'the last instant inside belongs to this day')
  assert(diaryDayOf(end) === '2026-10-31', 'the boundary instant belongs to the next day')
})

test('dayRange follows the calendar across a DST change', () => {
  // The machine may or may not observe DST; the point is that the range is derived
  // from calendar fields, so it is either 23h, 24h or 25h — never an arbitrary value.
  const { start, end } = dayRange('2026-03-29')
  const hours = (end - start) / 3600000
  assert(hours >= 23 && hours <= 25, `range length must stay within 23..25h, got ${hours}`)
})

test('shiftDay walks across month and year boundaries', () => {
  assertEqual(shiftDay('2026-10-01', -1), '2026-09-30', 'back over a month start')
  assertEqual(shiftDay('2026-12-31', 1), '2027-01-01', 'forward over a year end')
  assertEqual(shiftDay('2026-03-01', -1), '2026-02-28', 'honours a short month')
})

test('isDayKey rejects impossible dates and loose formats', () => {
  assertEqual(isDayKey('2026-10-30'), true, 'a real date')
  assertEqual(isDayKey('2026-02-30'), false, 'February has no 30th')
  assertEqual(isDayKey('2026-13-01'), false, 'no month 13')
  assertEqual(isDayKey('2026-1-1'), false, 'unpadded is rejected')
  assertEqual(isDayKey('yesterday'), false, 'words are rejected')
})

test('recentDays returns oldest-first and includes the end day', () => {
  assertEqual(recentDays('2026-10-30', 3), ['2026-10-28', '2026-10-29', '2026-10-30'], 'three days ending today')
  assertEqual(recentDays('2026-10-30', 1), ['2026-10-30'], 'a single day')
})

test('recentDays refuses a non-positive count', () => {
  let threw = false
  try {
    recentDays('2026-10-30', 0)
  } catch {
    threw = true
  }
  assert(threw, 'count 0 must throw rather than silently return nothing')
})

test('weekdayLabel matches the calendar', () => {
  assertEqual(weekdayLabel('2026-10-30'), '周五', '2026-10-30 is a Friday')
})

test('dateKey pads month and day', () => {
  assertEqual(dateKey(new Date(2026, 0, 5)), '2026-01-05', 'zero padded')
})
