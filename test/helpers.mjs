/**
 * Shared test scaffolding.
 *
 * "The test is green" is not evidence that nothing leaked into real data, so
 * every fixture built here lives under a fresh temp directory, and
 * `assertIsolated` re-proves that before each suite runs.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

/**
 * Create a unique temporary directory and register it for cleanup.
 * @param {string} [prefix] - directory name prefix.
 * @returns {string} absolute temp path.
 */
export function tempRoot (prefix = 'dsh-cat-diary-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/**
 * Assert helper that throws with a readable message.
 * @param {boolean} condition - condition that must hold.
 * @param {string} message - failure message.
 * @returns {void}
 */
export function assert (condition, message) {
  if (!condition) throw new Error(message)
}

/**
 * Assert deep equality on JSON-serializable values.
 * @param {unknown} actual - observed.
 * @param {unknown} expected - expected.
 * @param {string} message - failure message.
 * @returns {void}
 */
export function assertEqual (actual, expected, message) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${message}\n  expected: ${b}\n  actual:   ${a}`)
}

/**
 * Write a session archive in the **same multi-frame layout DSH uses**, so tests
 * exercise the real decoder instead of a single-frame shortcut.
 *
 * @param {string} file - destination path.
 * @param {object[]} records - session records.
 * @param {number} [frames] - how many zstd frames to split the lines into.
 * @returns {string} the written file.
 */
export function writeFakeSession (file, records, frames = 3) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const lines = records.map((record) => JSON.stringify(record))
  const chunks = []
  const perFrame = Math.max(1, Math.ceil(lines.length / Math.max(1, frames)))
  for (let i = 0; i < lines.length; i += perFrame) {
    const slice = lines.slice(i, i + perFrame).join('\n') + '\n'
    chunks.push(zlib.zstdCompressSync(Buffer.from(slice, 'utf8')))
  }
  fs.writeFileSync(file, Buffer.concat(chunks))
  return file
}

/**
 * Minimal structural check that a directory is a throwaway temp dir.
 * @param {string} dir - candidate.
 * @param {string} [tempBase] - base to test against.
 * @returns {boolean} true when `dir` lives under the temp base.
 */
export function isUnderTemp (dir, tempBase = os.tmpdir()) {
  const rel = path.relative(tempBase, path.resolve(dir))
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/**
 * Prove the fixture root is isolated before asserting anything about behaviour.
 *
 * This exists because a silently-wrong environment variable once let a test suite
 * write 56 fake sessions into real user data: the isolation looked configured,
 * the tests were green, and the damage was only visible in the UI.
 *
 * @param {string} dir - the data root a test is about to write into.
 * @param {string} [label] - suite name for the error message.
 * @returns {void}
 */
export function assertIsolated (dir, label = 'suite') {
  if (!isUnderTemp(dir)) {
    throw new Error(`${label}: refusing to run — ${dir} is not under the system temp directory`)
  }
}

/**
 * Build a `user/message` record.
 * @param {string} text - visible text.
 * @param {number} at - epoch milliseconds.
 * @param {string} [id] - message id.
 * @returns {object} a session record.
 */
export function userRecord (text, at, id = `u-${at}`) {
  return { type: 'user/message', seq: at, time: at, data: { content: [{ type: 'text', text }], role: 'user', id } }
}

/**
 * Build an `assistant/message` record.
 * @param {string} text - visible text.
 * @param {number} at - epoch milliseconds.
 * @param {{tools?: string[], reasoning?: string}} [options] - extra content parts.
 * @returns {object} a session record.
 */
export function assistantRecord (text, at, options = {}) {
  const content = []
  if (options.reasoning) content.push({ type: 'reasoning', text: options.reasoning })
  if (text !== '') content.push({ type: 'text', text })
  for (const tool of options.tools ?? []) content.push({ type: 'tool-call', id: `c-${at}-${tool}`, name: tool, arguments: '{}' })
  return { type: 'assistant/message', seq: at, time: at, data: { turn: 1, step: 1, message: { role: 'assistant', content, id: `a-${at}` } } }
}

/**
 * Build a `session` header record.
 * @param {{id?: string, cwd?: string, delegationDepth?: number, createdAt?: number}} [options] - header fields.
 * @returns {object} a session record.
 */
export function sessionHeader (options = {}) {
  return {
    type: 'session',
    version: 4,
    id: options.id ?? 'session-test',
    createdAt: options.createdAt ?? Date.now(),
    cwd: options.cwd ?? 'C:\\test',
    isSeeded: false,
    delegationDepth: options.delegationDepth ?? 0,
    agentPreset: 'ptc'
  }
}

/**
 * Build a compaction-summary replay record, matching the real shape.
 * @param {number} at - epoch milliseconds.
 * @returns {object} a `user/message` record holding a replayed summary.
 */
export function replayRecord (at) {
  const body = [
    '## Primary Request and Intent',
    '- User request verbatim: 「把图片插件的重试补上」',
    '## Key Technical Concepts',
    '- retry, exponential backoff, 503',
    '## All user messages',
    'x'.repeat(20000)
  ].join('\n')
  return userRecord(body, at)
}
