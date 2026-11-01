#!/usr/bin/env node
/**
 * Prove the isolation actually holds **before** trusting a single green test.
 *
 * A suite once wrote 56 fake sessions into real user data because an environment
 * variable was spelled wrong: the variable name was simply ignored, isolation
 * silently degraded to "write to the real folder", and every assertion still
 * passed. So this script does two things the tests cannot do for themselves:
 *
 * 1. Fingerprints `<real DSH_HOME>/sessions` (file count + total bytes + newest
 *    mtime) before and after the full test suite.
 * 2. Asserts that the resolved data root really is under the temp directory.
 *
 * Non-zero exit means: do not trust the test run.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { resolvePaths } from '../lib/paths.js'
import { isUnderTemp } from '../test/helpers.mjs'

/**
 * Fingerprint a directory tree: count, total bytes, and newest mtime.
 * @param {string} dir - directory to fingerprint.
 * @returns {{files: number, bytes: number, newest: number}} fingerprint.
 */
export function fingerprint (dir) {
  let files = 0
  let bytes = 0
  let newest = 0
  const walk = (current) => {
    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) {
        try {
          const stat = fs.statSync(full)
          files++
          bytes += stat.size
          if (stat.mtimeMs > newest) newest = stat.mtimeMs
        } catch {
          /* a file may vanish mid-walk; ignore */
        }
      }
    }
  }
  walk(dir)
  return { files, bytes, newest }
}

/**
 * Collect every session archive path under a directory.
 * @param {string} dir - sessions root.
 * @returns {string[]} absolute file paths.
 */
export function fingerprintPaths (dir) {
  const found = []
  const walk = (current) => {
    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && entry.name.endsWith('.jsonl.zstd')) found.push(full)
    }
  }
  walk(dir)
  return found.sort()
}

const realHome = resolvePaths({}).dshHome
const realSessions = path.join(realHome, 'sessions')
const tempBase = os.tmpdir()

process.stdout.write(`真实 DSH_HOME：${realHome}\n`)

// 1. A temp data root must be recognised as temporary.
const probe = fs.mkdtempSync(path.join(tempBase, 'dsh-cat-diary-isolation-'))
if (!isUnderTemp(probe)) {
  process.stderr.write(`隔离自检失败：${probe} 不被判定为临时目录\n`)
  process.exit(1)
}
process.stdout.write(`临时根：${probe}（已判定为临时目录）\n`)

// 2. Fingerprint the REAL sessions before the suite runs.
const before = fingerprint(realSessions)
const beforePaths = new Set(fingerprintPaths(realSessions))
process.stdout.write(`真实会话（前）：${before.files} 个文件 / ${before.bytes} 字节\n`)

// 3. Run the full suite.
const testDir = path.resolve(import.meta.dirname, '..', 'test')
const testFiles = fs
  .readdirSync(testDir)
  .filter((entry) => entry.endsWith('.test.mjs'))
  .sort()
  .map((entry) => path.join('test', entry))
process.stdout.write(`测试文件：${testFiles.length} 个\n`)

const result = spawnSync(process.execPath, ['--test', ...testFiles], {
  cwd: path.resolve(import.meta.dirname, '..'),
  encoding: 'utf8',
  stdio: 'pipe'
})
process.stdout.write(result.stdout ?? '')
if (result.stderr) process.stderr.write(result.stderr)

// 4. Fingerprint again and compare.
const after = fingerprint(realSessions)
const afterPaths = new Set(fingerprintPaths(realSessions))
process.stdout.write(`真实会话（后）：${after.files} 个文件 / ${after.bytes} 字节\n`)

// Which paths appeared or disappeared? This — not the total byte count — is the
// real evidence, because the *currently running* DSH appends to its own session
// file while the suite runs. Measuring total bytes would flag that self-write as
// contamination and teach us to ignore a genuine warning.
const appeared = [...afterPaths].filter((p) => !beforePaths.has(p))
const vanished = [...beforePaths].filter((p) => !afterPaths.has(p))
if (appeared.length > 0) {
  process.stderr.write(`出现新会话文件（可能是测试污染）：\n  ${appeared.join('\n  ')}\n`)
}
if (vanished.length > 0) {
  process.stderr.write(`会话文件消失：\n  ${vanished.join('\n  ')}\n`)
}
const selfWrite = after.bytes - before.bytes
process.stdout.write(
  `会话集合：新增 ${appeared.length} / 删除 ${vanished.length}；期间字节增量 ${selfWrite}（若有，来自当前活动会话的自我追加，非污染）\n`
)

let failed = false
if (result.status !== 0) {
  process.stderr.write('测试套件未全绿。\n')
  failed = true
}
// The load-bearing assertions: the set of session files must be unchanged.
// A new session file means a test wrote into real data; a vanished one means
// something deleted archives. Byte growth in an EXISTING file is the live DSH
// appending to its own conversation and is expected.
if (appeared.length > 0) failed = true
if (vanished.length > 0) failed = true
if (after.files !== before.files && appeared.length === 0 && vanished.length === 0) {
  process.stderr.write(`文件计数不一致但集合相同：${before.files} → ${after.files}\n`)
  failed = true
}

process.stdout.write(
  failed
    ? '\n隔离验证：失败 —— 不要相信这次测试结果。\n'
    : '\n隔离验证：通过 —— 真实会话未被动过，且临时根判定有效。\n'
)
fs.rmSync(probe, { recursive: true, force: true })
process.exit(failed ? 1 : 0)
