/**
 * `dsh-cat-diary` — turn one diary day into a compact, source-tagged raw material file.
 *
 * The raw file is what a model reads to write the diary. It is deliberately
 * **not** a dump of the conversation: reasoning traces, tool arguments, tool
 * results and compaction replays are all dropped, because they are either
 * enormous, secret-bearing, or previously-said content that would be counted
 * twice.
 *
 * @module dsh-cat-diary/collect
 */

import path from 'node:path'

import { listSessionFiles, loadSession, immediateSessions, groupByDay, bucketVolume } from './sessions.js'
import { isReplayedSummary, isInjectedContext, clampMessage, DEFAULT_MESSAGE_CAP } from './filter.js'
import { diaryDayOf, dayRange, isDayKey } from './day.js'
import { writeText, ensureDir, readText } from './store.js'

/** Default byte ceiling for one day's raw material. */
export const DEFAULT_RAW_BUDGET = 60000

/**
 * Paths used by raw material inside one persona's data root.
 * @param {string} dataRoot - persona data directory.
 * @param {string} day - diary day key.
 * @returns {string} absolute raw file path.
 */
export function rawPath (dataRoot, day) {
  return `${dataRoot}/raw/${day}.md`
}

/**
 * Filter and clamp one day's messages, reporting what was dropped and why.
 *
 * @param {{sessions: {id: string, cwd: string, messages: object[]}[], counts: object}} bucket - one day bucket.
 * @param {{cap?: number}} [options] - per-message cap.
 * @returns {{
 *   sessions: {id: string, cwd: string, messages: object[]}[],
 *   kept: number, droppedReplays: number, droppedReplayChars: number,
 *   droppedInjected: number, truncated: number, chars: number
 * }} filtered material.
 */
export function filterDay (bucket, options = {}) {
  const cap = options.cap ?? DEFAULT_MESSAGE_CAP
  let kept = 0
  let droppedReplays = 0
  let droppedReplayChars = 0
  let droppedInjected = 0
  let truncated = 0
  let chars = 0
  const sessions = []
  for (const session of bucket.sessions) {
    const messages = []
    for (const message of session.messages) {
      if (message.role === 'user' && isReplayedSummary(message.text)) {
        droppedReplays++
        droppedReplayChars += message.text.length
        continue
      }
      if (message.role === 'user' && isInjectedContext(message.text)) {
        droppedInjected++
        continue
      }
      const { text, truncated: wasTruncated } = clampMessage(message.text, cap)
      if (text === '') continue
      if (wasTruncated) truncated++
      chars += text.length
      kept++
      messages.push({ at: message.at, role: message.role, text, tools: message.tools })
    }
    if (messages.length > 0) sessions.push({ id: session.id, cwd: session.cwd, messages })
  }
  return { sessions, kept, droppedReplays, droppedReplayChars, droppedInjected, truncated, chars }
}

/**
 * Render filtered material as the markdown a model reads.
 *
 * @param {string} day - diary day key.
 * @param {ReturnType<typeof filterDay>} filtered - filtered material.
 * @param {{budget?: number, sessionCount: number, counts: object}} context - run context.
 * @returns {{text: string, truncated: boolean, bytes: number}} rendered raw file.
 */
export function renderRaw (day, filtered, context) {
  const budget = context.budget ?? DEFAULT_RAW_BUDGET
  const header = [
    `# 原料 ${day}`,
    '',
    `- 会话：${context.sessionCount} 个；用户消息 ${context.counts?.user ?? 0} 条；助手消息 ${context.counts?.assistant ?? 0} 条；工具调用 ${context.counts?.toolCalls ?? 0} 次`,
    `- 保留 ${filtered.kept} 条，${filtered.chars} 字符；剔除压缩摘要回放 ${filtered.droppedReplays} 条（${filtered.droppedReplayChars} 字符）；剔除系统注入 ${filtered.droppedInjected} 条；超长截断 ${filtered.truncated} 条`,
    ''
  ].join('\n')
  const lines = [header]
  let bytes = Buffer.byteLength(header, 'utf8')
  let truncated = false
  for (const session of filtered.sessions) {
    const sessionHead = `\n## 会话 ${session.id.slice(0, 18)}…（${session.cwd || '未知目录'}）\n`
    if (bytes + Buffer.byteLength(sessionHead, 'utf8') > budget) {
      truncated = true
      break
    }
    lines.push(sessionHead)
    bytes += Buffer.byteLength(sessionHead, 'utf8')
    for (const message of session.messages) {
      const clock = new Date(message.at).toTimeString().slice(0, 5)
      const who = message.role === 'user' ? '主人' : '我'
      const toolNote = message.tools?.length ? ` 〔工具：${[...new Set(message.tools)].join('、')}〕` : ''
      const block = `- ${clock} **${who}**：${message.text.replace(/\n/g, ' ')} ${toolNote}\n`
      const size = Buffer.byteLength(block, 'utf8')
      if (bytes + size > budget) {
        truncated = true
        break
      }
      lines.push(block)
      bytes += size
    }
    if (truncated) break
  }
  if (truncated) lines.push('\n> 原料已按字节预算截断，未覆盖的部分未写入。\n')
  const text = lines.join('')
  return { text, truncated, bytes: Buffer.byteLength(text, 'utf8') }
}

/**
 * Collect one diary day: read sessions, filter, render, and optionally persist.
 *
 * @param {{
 *   dshHome: string, dataRoot: string, day: string,
 *   cutoffHour?: number, cap?: number, budget?: number, write?: boolean
 * }} options - collection options.
 * @returns {{
 *   day: string, sessionCount: number, counts: object, kept: number,
 *   droppedReplays: number, droppedReplayChars: number, truncated: boolean,
 *   bytes: number, text: string, path: string|null, empty: boolean
 * }} collection result.
 */
export function collectDay (options) {
  const { dshHome, dataRoot, day } = options
  if (!isDayKey(day)) throw new TypeError(`invalid diary day: ${day}`)
  const cutoffHour = options.cutoffHour ?? 5
  const files = listSessionFiles(path.join(dshHome, 'sessions'))
  const sessions = []
  for (const file of files) {
    try {
      sessions.push(loadSession(file))
    } catch {
      /* a single unreadable archive must not abort the whole day */
    }
  }
  const days = groupByDay(immediateSessions(sessions))
  const bucket = days.get(day)
  if (!bucket) {
    return {
      day,
      sessionCount: 0,
      counts: { user: 0, assistant: 0, toolCalls: 0 },
      kept: 0,
      droppedReplays: 0,
      droppedReplayChars: 0,
      truncated: false,
      bytes: 0,
      text: '',
      path: null,
      empty: true
    }
  }
  const filtered = filterDay(bucket, { cap: options.cap })
  const { text, truncated, bytes } = renderRaw(day, filtered, {
    budget: options.budget,
    sessionCount: bucket.sessions.length,
    counts: bucket.counts
  })
  let written = null
  if (options.write !== false) {
    ensureDir(path.dirname(rawPath(dataRoot, day)))
    written = writeText(rawPath(dataRoot, day), text)
  }
  return {
    day,
    sessionCount: bucket.sessions.length,
    counts: bucket.counts,
    kept: filtered.kept,
    droppedReplays: filtered.droppedReplays,
    droppedReplayChars: filtered.droppedReplayChars,
    droppedInjected: filtered.droppedInjected,
    truncated,
    bytes,
    text,
    path: written,
    empty: false
  }
}

/**
 * Summarize which diary days have activity, without rendering anything.
 *
 * @param {string} dshHome - DSH home.
 * @returns {Map<string, {day: string, sessions: number, counts: object, chars: number}>} day summary, newest last.
 */
export function surveyDays (dshHome) {
  const files = listSessionFiles(path.join(dshHome, 'sessions'))
  const sessions = []
  for (const file of files) {
    try {
      sessions.push(loadSession(file))
    } catch {
      /* ignore unreadable archives */
    }
  }
  const days = groupByDay(immediateSessions(sessions))
  const summary = new Map()
  for (const [day, bucket] of days) {
    const volume = bucketVolume(bucket)
    summary.set(day, { day, sessions: bucket.sessions.length, counts: bucket.counts, chars: volume.chars })
  }
  return summary
}

/**
 * Estimate the cost of processing N days, using measured character volume.
 *
 * @param {Map<string, {chars: number}>} summary - from {@link surveyDays}.
 * @param {string[]} days - the days to price.
 * @param {{charsPerToken?: number, cnyPerKToken?: number}} [rates] - pricing.
 * @returns {{days: number, chars: number, tokens: number, cny: number}} estimate.
 */
export function estimateCost (summary, days, rates = {}) {
  const charsPerToken = rates.charsPerToken ?? 1.5
  const cnyPerKToken = rates.cnyPerKToken ?? 0.00172
  let chars = 0
  let count = 0
  for (const day of days) {
    const entry = summary.get(day)
    if (!entry) continue
    chars += entry.chars
    count++
  }
  const tokens = Math.round(chars / charsPerToken)
  return { days: count, chars, tokens, cny: Math.round((tokens / 1000) * cnyPerKToken * 150) / 100 }
}

/**
 * Read a previously collected raw file.
 * @param {string} dataRoot - persona data directory.
 * @param {string} day - diary day key.
 * @returns {string|null} raw text or null.
 */
export function readRaw (dataRoot, day) {
  return readText(rawPath(dataRoot, day))
}
