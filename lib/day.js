/**
 * `dsh-cat-diary` — day bucketing and date arithmetic.
 *
 * The diary day is a **30-hour day**: with the default cutoff of 05:00, anything
 * written between midnight and 05:00 belongs to the previous calendar day. Late
 * night work therefore lands in one diary instead of being split across two.
 *
 * No function here uses `Date.now()` implicitly — every entry point takes the
 * instant it should reason about, so tests drive time instead of sleeping.
 *
 * @module dsh-cat-diary/day
 */

/** Default diary-day cutoff hour (local time). */
export const DEFAULT_CUTOFF_HOUR = 5

/**
 * Pad a number to two digits.
 * @param {number} value - the number.
 * @returns {string} zero-padded two-digit text.
 */
function pad (value) {
  return String(value).padStart(2, '0')
}

/**
 * Format a local calendar date as `YYYY-MM-DD`.
 * @param {Date} date - the instant.
 * @returns {string} the local date key.
 */
export function dateKey (date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * Resolve which **diary day** an instant belongs to, honouring the cutoff.
 *
 * @param {number|Date} instant - epoch milliseconds or a Date.
 * @param {number} [cutoffHour] - hour the diary day starts (default 05:00).
 * @returns {string} the diary day key `YYYY-MM-DD`.
 */
export function diaryDayOf (instant, cutoffHour = DEFAULT_CUTOFF_HOUR) {
  const date = instant instanceof Date ? new Date(instant.getTime()) : new Date(instant)
  if (Number.isNaN(date.getTime())) throw new TypeError('diaryDayOf received an invalid instant')
  if (date.getHours() < cutoffHour) date.setDate(date.getDate() - 1)
  return dateKey(date)
}

/**
 * The half-open instant range `[start, end)` covered by one diary day.
 *
 * Computed from calendar fields rather than by subtracting 24 hours, so a DST
 * transition inside the day keeps the real wall-clock boundaries.
 *
 * @param {string} dayKey - the diary day, `YYYY-MM-DD`.
 * @param {number} [cutoffHour] - hour the diary day starts.
 * @returns {{start: number, end: number, startIso: string, endIso: string}} range.
 */
export function dayRange (dayKey, cutoffHour = DEFAULT_CUTOFF_HOUR) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey)
  if (!match) throw new TypeError(`invalid diary day: ${dayKey}`)
  const [, y, m, d] = match
  const start = new Date(Number(y), Number(m) - 1, Number(d), cutoffHour, 0, 0, 0)
  const end = new Date(Number(y), Number(m) - 1, Number(d) + 1, cutoffHour, 0, 0, 0)
  return {
    start: start.getTime(),
    end: end.getTime(),
    startIso: start.toISOString(),
    endIso: end.toISOString()
  }
}

/**
 * Step a day key by whole days.
 * @param {string} dayKey - the diary day.
 * @param {number} delta - days to add (negative walks back).
 * @returns {string} the shifted day key.
 */
export function shiftDay (dayKey, delta) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey)
  if (!match) throw new TypeError(`invalid diary day: ${dayKey}`)
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + delta)
  return dateKey(date)
}

/**
 * Is this a syntactically valid `YYYY-MM-DD` day key that denotes a real date?
 * @param {unknown} value - candidate.
 * @returns {boolean} true when the value is a real calendar date.
 */
export function isDayKey (value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [y, m, d] = value.split('-').map(Number)
  const probe = new Date(y, m - 1, d)
  return probe.getFullYear() === y && probe.getMonth() === m - 1 && probe.getDate() === d
}

/**
 * The inclusive list of diary days ending at `endDay` and walking back `count` days.
 *
 * @param {string} endDay - the newest day key (usually yesterday).
 * @param {number} count - how many days to include.
 * @returns {string[]} day keys, oldest first.
 */
export function recentDays (endDay, count) {
  if (!Number.isInteger(count) || count < 1) throw new TypeError('recentDays needs a positive integer count')
  const days = []
  for (let i = count - 1; i >= 0; i--) days.push(shiftDay(endDay, -i))
  return days
}

/**
 * Human-readable weekday label for a day key.
 * @param {string} dayKey - the diary day.
 * @returns {string} e.g. `周五`.
 */
export function weekdayLabel (dayKey) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey)
  if (!match) return ''
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][date.getDay()]
}
