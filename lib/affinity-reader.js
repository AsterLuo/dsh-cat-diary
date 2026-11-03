/**
 * `dsh-cat-diary` — read-only view of the affinity score.
 *
 * The diary **never computes or writes** the bond score. That authority belongs to
 * `dsh-affinity` alone; this module exists because the diary still has to display
 * it, and a display path that silently invents a number is exactly how the old
 * design ended up showing `好感度 70` in a header above `70 → 74` in the body.
 *
 * Two sources, in order:
 * 1. `ctx.affinity` service — the live, in-process truth.
 * 2. The affinity ledger on disk, read-only — used by the CLI when no host runs.
 *
 * When neither is available the result is `null`, and callers must render a
 * visible "unknown" rather than a plausible-looking zero.
 *
 * @module dsh-cat-diary/affinity-reader
 */

import fs from 'node:fs'
import path from 'node:path'

/** Storage folder the affinity plugin owns. */
const AFFINITY_STORAGE = 'dsh-affinity'

/**
 * Replay an events file into a score. Duplicated deliberately, not shared: a
 * display path must keep working even if the affinity plugin is not installed,
 * and this copy can never write.
 *
 * @param {object[]} events - ledger events.
 * @returns {number|null} the score, or null when nothing is recorded yet.
 */
function replayScore (events) {
  let score = null
  for (const event of events) {
    if (!event || typeof event !== 'object') continue
    if (typeof event.value === 'number') {
      score = Math.max(-100, Math.min(100, Math.round(event.value)))
      continue
    }
    const delta = Number(event.delta ?? 0)
    if (!Number.isFinite(delta) || delta === 0) continue
    const current = score ?? 50
    score = Math.max(-100, Math.min(100, Math.round(current + delta)))
  }
  return score
}

/**
 * Read an events file, tolerating missing files and bad lines.
 * @param {string} file - events.jsonl path.
 * @returns {object[]} parsed events.
 */
function readEvents (file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const events = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      events.push(JSON.parse(trimmed))
    } catch {
      /* skip a damaged line */
    }
  }
  return events
}

/**
 * Summarize one day from the affinity ledger on disk (read-only).
 *
 * @param {string} dshHome - DSH home.
 * @param {string} person - persona id.
 * @param {string} day - diary day key.
 * @returns {{score: number, net: number, used: number, opening: number|null, closing: number|null, reasons: string[]}|null}
 *   the summary, or null when no ledger exists.
 */
export function readDayFromLedger (dshHome, person, day) {
  const file = path.join(dshHome, 'storages', AFFINITY_STORAGE, person, 'affinity', 'events.jsonl')
  const events = readEvents(file)
  if (events.length === 0) return null
  const score = replayScore(events)
  if (score === null) return null

  const dayEvents = events.filter((event) => event?.day === day && typeof event.delta === 'number')
  let net = 0
  let used = 0
  for (const event of dayEvents) {
    net += event.delta
    used += Math.abs(event.delta)
  }
  return {
    score,
    net,
    used,
    opening: dayEvents.length > 0 ? dayEvents[0].from ?? null : null,
    closing: dayEvents.length > 0 ? dayEvents[dayEvents.length - 1].to ?? null : null,
    reasons: dayEvents.map((event) => event.reason).filter((text) => typeof text === 'string' && text !== '')
  }
}

/**
 * Resolve the day summary from the best available source.
 *
 * @param {object|null} affinityService - `ctx.affinity` when the plugin is mounted.
 * @param {{dshHome: string, person: string}} paths - fallback locations.
 * @param {string} day - diary day key.
 * @returns {{score: number|null, net: number, used: number, opening: number|null, closing: number|null, reasons: string[], source: string}}
 *   the summary; `score` is null when nothing could be read.
 */
export function resolveDaySummary (affinityService, paths, day) {
  if (affinityService && typeof affinityService.summary === 'function') {
    try {
      const summary = affinityService.summary(day)
      if (summary && typeof summary.score === 'number') {
        return { ...summary, source: 'service' }
      }
    } catch {
      /* fall through to the on-disk ledger */
    }
  }
  const fromDisk = readDayFromLedger(paths.dshHome, paths.person, day)
  if (fromDisk !== null) return { ...fromDisk, source: 'ledger' }
  return { score: null, net: 0, used: 0, opening: null, closing: null, reasons: [], source: 'none' }
}

/**
 * Render the line the brief shows above the diary body.
 *
 * An unknown score is stated as unknown, never as `0` or `50`.
 *
 * @param {{score: number|null, net: number, used: number}} summary - day summary.
 * @param {number} [maxDaily] - the affinity plugin's daily cap, for the usage readout.
 * @returns {string} e.g. `好感度 72，今日 +2，已用 2/16`.
 */
export function renderAffinityHeader (summary, maxDaily = 16) {
  if (summary.score === null) return '好感度：未记录（affinity 插件未安装或账本为空）'
  const parts = [`好感度 ${summary.score}`]
  if (summary.net === 0) parts.push('今日无变化')
  else parts.push(`今日 ${summary.net > 0 ? '+' : ''}${summary.net}`)
  if (typeof summary.used === 'number' && summary.used > 0) parts.push(`已用 ${summary.used}/${maxDaily}`)
  return parts.join('，')
}

/**
 * Render the fourth diary section, generated from the ledger rather than typed.
 *
 * This is the fix for the original defect: the score is no longer prose the model
 * writes, it is a line the code produces and the model only annotates.
 *
 * @param {{score: number|null, net: number, used: number, opening: number|null, closing: number|null, reasons: string[]}} summary - day summary.
 * @param {number} [maxDaily] - daily cap.
 * @returns {string[]} bullet lines for the section.
 */
export function renderAffinitySection (summary, maxDaily = 16) {
  if (summary.score === null) {
    return ['今日无可核验的好感度记录（affinity 账本为空）']
  }
  const bullets = []
  if (summary.opening !== null && summary.closing !== null) {
    bullets.push(`日初 ${summary.opening} → 日终 ${summary.closing}（今日净 ${summary.net > 0 ? '+' : ''}${summary.net}，已用 ${summary.used}/${maxDaily}）`)
  } else {
    // 没发生过加减的日子也必须写成「日初 X → 日终 X」。
    // 结构校验要求这一节有箭头；如果代码自己产出的正文过不了自己的校验，
    // 那这条校验就只能被 --force 绕过，等于没有——实测踩到过。
    const flat = summary.score
    bullets.push(`日初 ${flat} → 日终 ${flat}（今日净 0，已用 ${summary.used}/${maxDaily}）`)
  }
  for (const reason of summary.reasons) bullets.push(reason)
  bullets.push(`数值来源：affinity 账本（唯一写入方），本条由代码生成，未经模型改写`)
  return bullets
}
