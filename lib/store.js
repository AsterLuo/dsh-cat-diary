/**
 * `dsh-cat-diary` — atomic, BOM-free persistence.
 *
 * Two invariants, both learned the hard way on this machine:
 * 1. **Write UTF-8 without a BOM.** Node's `readFileSync(path, 'utf8')` does not
 *    strip a BOM, so a file written by PowerShell 5.1's `Set-Content -Encoding utf8`
 *    breaks the next `JSON.parse` with `Unexpected token \uFEFF`. Every write here
 *    goes through Node's `fs`, never through PowerShell.
 * 2. **Never leave a half-written file.** Content goes to `<name>.tmp` first and is
 *    then renamed over the target, so a crash leaves either the old file or the
 *    new one — never a truncated mix that would look like a corrupt diary.
 *
 * @module dsh-cat-diary/store
 */

import fs from 'node:fs'
import path from 'node:path'

/**
 * Ensure a directory exists (recursive, idempotent).
 * @param {string} dir - directory path.
 * @returns {string} the directory path.
 */
export function ensureDir (dir) {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Write text atomically as UTF-8 without a BOM.
 *
 * @param {string} file - destination path.
 * @param {string} text - content.
 * @returns {string} the written path.
 */
export function writeText (file, text) {
  ensureDir(path.dirname(file))
  const temp = `${file}.tmp`
  fs.writeFileSync(temp, text, { encoding: 'utf8' })
  fs.renameSync(temp, file)
  return file
}

/**
 * Read a UTF-8 text file, tolerating a stray BOM left by another tool.
 * @param {string} file - source path.
 * @returns {string|null} the text, or null when the file does not exist.
 */
export function readText (file) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
}

/**
 * Write JSON atomically, pretty-printed and newline-terminated.
 * @param {string} file - destination path.
 * @param {unknown} value - value to serialize.
 * @returns {string} the written path.
 */
export function writeJson (file, value) {
  return writeText(file, `${JSON.stringify(value, null, 2)}\n`)
}

/**
 * Read JSON, returning a fallback when the file is missing or unparsable.
 *
 * A corrupt metadata file must never make the diary unreadable, so a parse
 * failure degrades to the fallback instead of throwing.
 *
 * @param {string} file - source path.
 * @param {unknown} [fallback] - value returned on failure.
 * @returns {unknown} parsed value or fallback.
 */
export function readJson (file, fallback = null) {
  const text = readText(file)
  if (text === null) return fallback
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

/**
 * Append one line to a JSONL file.
 * @param {string} file - destination path.
 * @param {unknown} value - record to append.
 * @returns {string} the written path.
 */
export function appendJsonl (file, value) {
  ensureDir(path.dirname(file))
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, { encoding: 'utf8' })
  return file
}

/**
 * Read a JSONL file into an array, skipping unparsable lines.
 * @param {string} file - source path.
 * @returns {object[]} parsed records.
 */
export function readJsonl (file) {
  const text = readText(file)
  if (text === null) return []
  const records = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      records.push(JSON.parse(trimmed))
    } catch {
      /* skip a corrupt line rather than losing the whole ledger */
    }
  }
  return records
}

/**
 * Count UTF-8 bytes of a string without allocating a Buffer for the common case.
 * @param {string} text - the text.
 * @returns {number} byte length as stored on disk.
 */
export function utf8Bytes (text) {
  return Buffer.byteLength(String(text ?? ''), 'utf8')
}

/**
 * List files matching an extension directly inside a directory, sorted by name.
 * @param {string} dir - directory.
 * @param {string} extension - e.g. `.md`.
 * @returns {string[]} file names.
 */
export function listByExtension (dir, extension) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => entry.name)
    .sort()
}
