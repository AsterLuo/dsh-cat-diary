import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { resolvePaths, resolvePersonaId } from '../lib/paths.js'
import { resolveDaySummary, renderAffinitySection, renderAffinityHeader } from '../lib/affinity-reader.js'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'catdiary-persona-'))

// ---- 1. resolvePaths 会把解析后的 person 一起返回 ----
const withConfig = resolvePaths({ dshHome: home, person: 'alice', env: {} })
assert.equal(withConfig.person, 'alice')
assert.equal(withConfig.dataRoot, path.join(home, 'storages', 'dsh-cat-diary', 'alice'))

const withEnv = resolvePaths({ dshHome: home, env: { DSH_CAT_DIARY_PERSONA: 'alice' } })
assert.equal(withEnv.person, 'alice', '没给 person 时 env 兜底，且必须回传')
assert.equal(withEnv.dataRoot, path.join(home, 'storages', 'dsh-cat-diary', 'alice'))

const fallback = resolvePaths({ dshHome: home, env: {} })
assert.equal(fallback.person, 'default')

// 非法字符会被清洗，且返回值和目录名一致
const dirty = resolvePaths({ dshHome: home, env: { DSH_CAT_DIARY_PERSONA: 'a b/c' } })
assert.equal(dirty.person, 'a_b_c')
assert.equal(path.basename(dirty.dataRoot), 'a_b_c')

// ---- 2. 复现原来的 bug：日记在 alice，账本却去 default 找 ----
const mon = path.join(home, 'storages', 'dsh-affinity', 'alice', 'affinity')
fs.mkdirSync(mon, { recursive: true })
// 起点必须是一条带 value 的锚点，否则 replayScore 会从 50 起算 —— 这是账本
// 的真实形态（真账本第一行就是 migrated-anchor，value: 70）。
const events = [
  { id: 'anchor', kind: 'anchor', day: '2026-10-30', value: 77, reason: '回溯锚点' },
  { id: 'a1', kind: 'adjust', day: '2026-11-01', delta: 4, from: 77, to: 81, reason: '主人明确授权改界面' },
  { id: 'a2', kind: 'adjust', day: '2026-11-02', delta: 7, from: 81, to: 88, reason: '继续推进' }
]
fs.writeFileSync(path.join(mon, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')

const wrong = resolveDaySummary(null, { dshHome: home, person: 'default' }, '2026-11-01')
assert.equal(wrong.score, null)
assert.equal(renderAffinitySection(wrong, 16)[0], '今日无可核验的好感度记录（affinity 账本为空）')

const right = resolveDaySummary(null, { dshHome: home, person: 'alice' }, '2026-11-01')
assert.equal(right.score, 88)
assert.equal(right.net, 4)
assert.equal(right.used, 4)
assert.equal(right.opening, 77)
assert.equal(right.closing, 81)
assert.equal(renderAffinitySection(right, 16)[0], '日初 77 → 日终 81（今日净 +4，已用 4/16）')
assert.ok(renderAffinityHeader(right, 16).startsWith('好感度 88'), renderAffinityHeader(right, 16))

// ---- 3. 关键回归：只用配置解析出的 paths.person 去读，必须拿到真数 ----
const resolved = resolvePaths({ dshHome: home, person: 'alice', env: {} })
const viaResolved = resolveDaySummary(null, { dshHome: resolved.dshHome, person: resolved.person }, '2026-11-01')
assert.equal(viaResolved.score, 88, 'paths.person 必须能读到账本（这是这次修复的核心）')

fs.rmSync(home, { recursive: true, force: true })
console.log('PERSONA PASS')