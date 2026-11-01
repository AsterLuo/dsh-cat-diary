/**
 * `dsh-cat-diary` — multi-frame zstd session decoding.
 *
 * DSH persists a session as a *concatenation* of independently compressed zstd
 * frames (`session.v4.jsonl.zstd`). Feeding the whole file to
 * `zlib.zstdDecompressSync` returns only the FIRST frame — measured on a real
 * 788 KB session: whole-file and streaming both yielded 316 characters while the
 * file actually held 2.2 MB of JSON lines. So the frames must be walked by hand.
 *
 * @module dsh-cat-diary/decode
 */

import fs from 'node:fs'
import zlib from 'node:zlib'

/** Zstd frame magic number, little-endian `0xFD2FB528`. */
export const ZSTD_MAGIC = Object.freeze([0x28, 0xb5, 0x2f, 0xfd])

/**
 * Locate every zstd frame boundary inside a buffer.
 *
 * A magic number can in principle occur inside compressed payload bytes. Being
 * wrong there is recoverable rather than fatal: {@link decompressFrames} merges
 * a frame with its successor whenever a slice fails to decompress, so a false
 * boundary costs one retry and never corrupts output.
 *
 * @param {Buffer} buf - raw file bytes.
 * @returns {number[]} ascending frame start offsets.
 */
export function findFrameBounds (buf) {
  const bounds = []
  const limit = buf.length - ZSTD_MAGIC.length
  for (let i = 0; i <= limit; i++) {
    if (
      buf[i] === ZSTD_MAGIC[0] &&
      buf[i + 1] === ZSTD_MAGIC[1] &&
      buf[i + 2] === ZSTD_MAGIC[2] &&
      buf[i + 3] === ZSTD_MAGIC[3]
    ) bounds.push(i)
  }
  return bounds
}

/**
 * Decode one frame, retrying with progressively more successor frames until the
 * slice decompresses (a false magic boundary forces exactly this).
 *
 * @param {Buffer} buf - raw file bytes.
 * @param {number[]} bounds - frame start offsets from {@link findFrameBounds}.
 * @param {number} index - which frame to decode.
 * @returns {{text: string, next: number}} decoded text and the next frame index.
 */
function decodeAt (buf, bounds, index) {
  let lastError = null
  for (let end = index + 1; end <= bounds.length; end++) {
    const start = bounds[index]
    const stop = end < bounds.length ? bounds[end] : buf.length
    try {
      return { text: zlib.zstdDecompressSync(buf.subarray(start, stop)).toString('utf8'), next: end }
    } catch (error) {
      lastError = error
    }
  }
  throw lastError ?? new Error(`zstd frame ${index} could not be decoded`)
}

/**
 * Decode every zstd frame in a buffer into one UTF-8 string.
 *
 * @param {Buffer} buf - raw file bytes.
 * @returns {{text: string, frames: number, merged: number}} decoded text, the
 *   number of frame starts found, and how many slices needed merging.
 */
export function decompressFrames (buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return { text: '', frames: 0, merged: 0 }
  const bounds = findFrameBounds(buf)
  if (bounds.length === 0) {
    // A plain (or v0) jsonl file that was never compressed.
    return { text: buf.toString('utf8'), frames: 0, merged: 0 }
  }
  let text = ''
  let index = 0
  let merged = 0
  while (index < bounds.length) {
    const { text: chunk, next } = decodeAt(buf, bounds, index)
    if (next > index + 1) merged += next - index - 1
    text += chunk
    index = next
  }
  return { text, frames: bounds.length, merged }
}

/**
 * Decode a session file into parsed JSON lines, tolerating one corrupt line.
 *
 * @param {string} file - absolute path to a `session*.jsonl.zstd` file.
 * @returns {{records: object[], frames: number, badLines: number}} parsed records.
 */
export function readSessionFile (file) {
  const { text, frames } = decompressFrames(fs.readFileSync(file))
  const records = []
  let badLines = 0
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      records.push(JSON.parse(trimmed))
    } catch {
      badLines++
    }
  }
  return { records, frames, badLines }
}
