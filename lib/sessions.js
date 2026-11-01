/**
 * `dsh-cat-diary` — read-only view over DSH session archives.
 *
 * Everything here is strictly read-only: no session file is ever opened for
 * writing, renamed, or deleted. The CLI works without a running DSH by decoding
 * the files directly; the plugin prefers the host's `ctx.sessionQuery` service
 * when it is mounted.
 *
 * @module dsh-cat-diary/sessions
 */

import fs from 'node:fs'
import path from 'node:path'

import { readSessionFile } from './decode.js'
import { diaryDayOf } from './day.js'

/** Session archive file name. */
const SESSION_FILE = 'session.v4.jsonl.zstd'

/**
 * Resolve the DSH home directory from an environment object.
 *
 * @param {NodeJS.ProcessEnv} [env] - environment (defaults to `process.env`).
 * @param {string} [fallback] - used when `DSH_HOME` is unset.
 * @returns {string} absolute DSH home path.
 */
export function resolveDshHome (env = process.env, fallback = path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh')) {
  const configured = env?.DSH_HOME
  return configured && configured.trim() !== '' ? path.resolve(configured) : path.resolve(fallback)
}

/**
 * Recursively collect every session archive under a sessions root.
 *
 * @param {string} sessionsRoot - `<dshHome>/sessions`.
 * @returns {{file: string, size: number, mtimeMs: number}[]} archives, newest first.
 */
export function listSessionFiles (sessionsRoot) {
  const found = []
  if (!fs.existsSync(sessionsRoot)) return found
  const walk = (dir) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name === SESSION_FILE || entry.name.startsWith('session.') && entry.name.endsWith('.jsonl.zstd')) {
        let stat = null
        try {
          stat = fs.statSync(full)
        } catch {
          continue
        }
        found.push({ file: full, size: stat.size, mtimeMs: stat.mtimeMs })
      }
    }
  }
  walk(sessionsRoot)
  found.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return found
}

/**
 * Summarize one session archive: header identity plus its visible messages.
 *
 * @param {{file: string}} entry - an entry from {@link listSessionFiles}.
 * @returns {{
 *   file: string, id: string, cwd: string, delegationDepth: number, agentPreset: string,
 *   createdAt: number|null, messages: {day: string, at: number, role: string, text: string, tools: string[]}[]
 * }} the session shape used by the rest of the library.
 */
export function loadSession (entry) {
  const { records } = readSessionFile(entry.file)
  let header = null
  const messages = []
  for (const record of records) {
    if (record?.type === 'session') {
      header = record
      continue
    }
    const at = typeof record?.time === 'number' ? record.time : null
    if (at === null) continue
    if (record.type === 'user/message') {
      const text = extractUser(record)
      if (text !== '') messages.push({ day: diaryDayOf(at), at, role: 'user', text, tools: [] })
    } else if (record.type === 'assistant/message') {
      const { text, tools } = extractAssistant(record)
      if (text !== '' || tools.length > 0) messages.push({ day: diaryDayOf(at), at, role: 'assistant', text, tools })
    }
  }
  return {
    file: entry.file,
    id: header?.id ?? path.basename(path.dirname(entry.file)),
    cwd: header?.cwd ?? '',
    delegationDepth: typeof header?.delegationDepth === 'number' ? header.delegationDepth : 0,
    agentPreset: header?.agentPreset ?? '',
    createdAt: typeof header?.createdAt === 'number' ? header.createdAt : null,
    messages
  }
}

/**
 * Local re-export indirection so this module owns no filtering policy of its own.
 * @param {object} record - a `user/message` record.
 * @returns {string} visible text.
 */
function extractUser (record) {
  const content = record?.data?.content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const part of content) {
    if (part?.type === 'text' && typeof part.text === 'string') parts.push(part.text)
    else if (part?.type === 'image') parts.push('[图片，未解析]')
  }
  return parts.join('\n')
}

/**
 * @param {object} record - an `assistant/message` record.
 * @returns {{text: string, tools: string[]}} visible text and tool names.
 */
function extractAssistant (record) {
  const content = record?.data?.message?.content
  if (!Array.isArray(content)) return { text: '', tools: [] }
  const texts = []
  const tools = []
  for (const part of content) {
    if (part?.type === 'text' && typeof part.text === 'string' && part.text.trim() !== '') texts.push(part.text)
    else if (part?.type === 'tool-call' && typeof part.name === 'string') tools.push(part.name)
  }
  return { text: texts.join('\n'), tools }
}

/**
 * Keep only the immediate conversations of the current persona.
 *
 * Sub-agent sessions (`delegationDepth > 0`) are excluded: they are the team's
 * internal chatter, they duplicate the parent's content, and including them
 * would let the diary summarize its own summaries.
 *
 * @param {{delegationDepth: number}[]} sessions - loaded sessions.
 * @returns {object[]} the sessions that belong to a diary.
 */
export function immediateSessions (sessions) {
  return sessions.filter((session) => session.delegationDepth === 0)
}

/**
 * Group sessions' messages into diary days.
 *
 * @param {object[]} sessions - loaded sessions (already filtered).
 * @returns {Map<string, {day: string, sessions: {id: string, cwd: string, messages: object[]}[], counts: {user: number, assistant: number, toolCalls: number}}>}
 *   one entry per diary day that saw activity.
 */
export function groupByDay (sessions) {
  const days = new Map()
  for (const session of sessions) {
    for (const message of session.messages) {
      let bucket = days.get(message.day)
      if (!bucket) {
        bucket = { day: message.day, sessions: new Map(), counts: { user: 0, assistant: 0, toolCalls: 0 } }
        days.set(message.day, bucket)
      }
      let view = bucket.sessions.get(session.id)
      if (!view) {
        view = { id: session.id, cwd: session.cwd, messages: [] }
        bucket.sessions.set(session.id, view)
      }
      view.messages.push(message)
      if (message.role === 'user') bucket.counts.user++
      else bucket.counts.assistant++
      bucket.counts.toolCalls += message.tools.length
    }
  }
  const result = new Map()
  for (const [day, bucket] of days) {
    const list = [...bucket.sessions.values()]
    for (const view of list) view.messages.sort((a, b) => a.at - b.at)
    result.set(day, { day, sessions: list, counts: bucket.counts })
  }
  return result
}

/**
 * Total character volume of a day bucket, used for cost estimation and budgets.
 * @param {{sessions: {messages: object[]}[]}} bucket - one entry of {@link groupByDay}.
 * @returns {{chars: number, messages: number}} character and message totals.
 */
export function bucketVolume (bucket) {
  let chars = 0
  let messages = 0
  for (const session of bucket.sessions) {
    for (const message of session.messages) {
      chars += message.text.length
      messages++
    }
  }
  return { chars, messages }
}
