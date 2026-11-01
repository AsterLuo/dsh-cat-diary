/**
 * `dsh-cat-diary` — message extraction and the compression-replay filter.
 *
 * Real sessions contain far more than what was said. Measured on this machine
 * across 16 days of history: **5.81 million of the 11.07 million user-side
 * characters (86.5%) were compression summaries re-injected as
 * `user/message`** — each 20k–22k characters, opening with
 * `## Primary Request and Intent`. Feeding those to a summarizer costs ~20x the
 * real content and blows the context window.
 *
 * {@link isReplayedSummary} is therefore a hard filter, not a heuristic
 * preference: it is what makes backfilling history affordable at all.
 *
 * @module dsh-cat-diary/filter
 */

/** Default per-message character cap. */
export const DEFAULT_MESSAGE_CAP = 1200

/** Headings that only ever appear in a compaction summary. */
const SUMMARY_HEADING = /^#{1,4}\s*(?:Primary Request|Conversation Summary|Summary of|关键(?:信息|技术|请求)|摘要|会话摘要|本次会话)/i

/** Markers found near the start of a compaction summary. */
const SUMMARY_MARKERS = [
  'Primary Request and Intent',
  'Key Technical Concepts',
  'Pending Tasks',
  'Current Work',
  'User request verbatim',
  '<summary>',
  '<analysis>',
  'All user messages',
  'Errors and fixes'
]

/** A message this long that also mentions verbatim user requests is a replay. */
const LARGE_MESSAGE = 8000

/**
 * Was this "user" message actually written by the harness rather than by the human?
 *
 * DSH delivers system reminders, workspace instruction blocks and the runtime
 * context snapshot as `user/message` records. A real 2026-10-29 session showed
 * three of the first four "user" messages were `<system-reminder>` blocks and a
 * 8.5 KB `AGENTS.md` injection. Counting those as things the owner said would
 * produce a diary confidently describing a conversation that never happened.
 *
 * @param {string} text - the raw message text.
 * @returns {boolean} true when the harness authored the message.
 */
export function isInjectedContext (text) {
  if (typeof text !== 'string') return false
  const head = text.slice(0, 240)
  if (head.trimStart().startsWith('<system-reminder>')) return true
  if (head.includes('Instructions from:')) return true
  if (head.startsWith('Current runtime context.')) return true
  if (head.includes('This snapshot supersedes earlier runtime-context snapshots')) return true
  if (/^\s*A skill is a reusable set of task-specific instructions/.test(head)) return true
  if (/^\s*<available_skills>/.test(head)) return true
  return false
}

/**
 * Was this text injected by the compactor rather than typed by the human?
 *
 * @param {string} text - the raw message text.
 * @returns {boolean} true when the message is a compression replay.
 */
export function isReplayedSummary (text) {
  if (typeof text !== 'string' || text.length === 0) return false
  const head = text.slice(0, 400)
  if (SUMMARY_HEADING.test(text.trimStart())) return true
  let hits = 0
  for (const marker of SUMMARY_MARKERS) if (head.includes(marker)) hits++
  if (hits >= 2) return true
  if (text.length > LARGE_MESSAGE && head.includes('User request verbatim')) return true
  if (text.length > LARGE_MESSAGE && hits >= 1) return true
  return false
}

/**
 * Collapse whitespace and trim, so a one-line summary of many paragraphs stays readable.
 * @param {string} text - raw text.
 * @returns {string} normalized text.
 */
export function normalizeWhitespace (text) {
  return text.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * Clamp a message to the per-message character budget.
 *
 * @param {string} text - the text.
 * @param {number} cap - maximum characters.
 * @returns {{text: string, truncated: boolean}} clamped text and whether it was cut.
 */
export function clampMessage (text, cap = DEFAULT_MESSAGE_CAP) {
  const normalized = normalizeWhitespace(text)
  if (normalized.length <= cap) return { text: normalized, truncated: false }
  return { text: `${normalized.slice(0, cap)}…[已截断 ${normalized.length - cap} 字]`, truncated: true }
}

/**
 * Pull the visible text out of a `user/message` record.
 *
 * Only `text` parts are used: image and attachment parts are kept as a reference
 * marker so the diary never claims to have understood something it cannot see.
 *
 * @param {object} record - a `user/message` session record.
 * @returns {string} the joined visible text ('' when the message had none).
 */
export function userMessageText (record) {
  const content = record?.data?.content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const part of content) {
    if (part?.type === 'text' && typeof part.text === 'string') parts.push(part.text)
    else if (part?.type === 'image') parts.push('[图片，未解析]')
    else if (part?.type === 'attachment') parts.push('[附件，未解析]')
  }
  return parts.join('\n')
}

/**
 * Pull what the assistant said *visibly* out of an `assistant/message` record.
 *
 * Reasoning traces are deliberately dropped: they are internal, huge, and the
 * diary is supposed to record what the catgirl concluded, not how she rambled.
 * Tool calls keep only their name — arguments are dropped as noise and as a
 * likely place for secrets.
 *
 * @param {object} record - an `assistant/message` session record.
 * @returns {{text: string, tools: string[]}} visible text and tool names used.
 */
export function assistantMessageParts (record) {
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
