import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

import { ZSTD_MAGIC, findFrameBounds, decompressFrames, readSessionFile } from '../lib/decode.js'
import { tempRoot, assert, assertEqual, writeFakeSession, sessionHeader, userRecord } from './helpers.mjs'

test('finds every frame boundary in a multi-frame archive', () => {
  const dir = tempRoot()
  const file = path.join(dir, 's', 'session.v4.jsonl.zstd')
  writeFakeSession(file, [sessionHeader(), userRecord('一', 1), userRecord('二', 2), userRecord('三', 3)], 4)
  const buf = fs.readFileSync(file)
  const bounds = findFrameBounds(buf)
  assertEqual(bounds.length, 4, 'one boundary per frame')
  assert(bounds[0] === 0, 'first boundary is offset 0')
  for (const bound of bounds) {
    assertEqual([...buf.subarray(bound, bound + 4)], ZSTD_MAGIC, 'boundary carries the magic number')
  }
})

test('decodes ALL frames, not only the first', () => {
  const dir = tempRoot()
  const file = path.join(dir, 's', 'session.v4.jsonl.zstd')
  writeFakeSession(file, [sessionHeader(), userRecord('甲', 1), userRecord('乙', 2), userRecord('丙', 3)], 4)
  const { records, frames } = readSessionFile(file)
  assertEqual(frames, 4, 'four frames read')
  assertEqual(records.length, 4, 'four records recovered')
  assertEqual(records.filter((r) => r.type === 'user/message').length, 3, 'all three user messages present')
})

test('whole-file decompression returns only the first frame (the trap this guards against)', () => {
  const dir = tempRoot()
  const file = path.join(dir, 's', 'session.v4.jsonl.zstd')
  writeFakeSession(file, [sessionHeader(), userRecord('甲', 1), userRecord('乙', 2)], 3)
  const buf = fs.readFileSync(file)
  const naive = zlib.zstdDecompressSync(buf).toString('utf8')
  const real = decompressFrames(buf).text
  assert(naive.length < real.length, 'the naive path loses data — decoding must walk frames')
  assertEqual(JSON.parse(naive.trim()).type, 'session', 'naive decode yields only the header')
})

test('merges a frame when a magic number appears inside payload bytes', () => {
  const dir = tempRoot()
  const file = path.join(dir, 's', 'session.v4.jsonl.zstd')
  // A payload that literally contains the zstd magic bytes.
  const tricky = userRecord('payload with \u0028\u00b5\u002f\u00fd magic inside', 1)
  writeFakeSession(file, [tricky], 1)
  const { records } = readSessionFile(file)
  assertEqual(records.length, 1, 'record survives a false boundary')
})

test('returns empty text for an empty buffer instead of throwing', () => {
  assertEqual(decompressFrames(Buffer.alloc(0)), { text: '', frames: 0, merged: 0 }, 'empty buffer')
})

test('counts a corrupt line without losing the rest of the file', () => {
  const dir = tempRoot()
  const file = path.join(dir, 's', 'session.v4.jsonl.zstd')
  const lines = [
    JSON.stringify(sessionHeader()),
    '{ this is not json',
    JSON.stringify(userRecord('有效', 5))
  ].join('\n') + '\n'
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, zlib.zstdCompressSync(Buffer.from(lines, 'utf8')))
  const { records, badLines } = readSessionFile(file)
  assertEqual(badLines, 1, 'one bad line counted')
  assertEqual(records.length, 2, 'valid lines still parsed')
})
