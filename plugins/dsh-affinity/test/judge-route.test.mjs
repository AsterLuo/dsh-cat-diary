import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { readJudgeChoice } from '../lib/judge-route.js'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'affinity-judge-route-'))
const file = (person) => path.join(home, 'storages', 'dsh-cat-diary', person, 'autoWriteRoute.json')

// ---- 1. 文件不存在 ----
assert.equal(readJudgeChoice(home, 'alice'), null)

// ---- 2. 只有 diary（旧格式或只设了日记） ----
fs.mkdirSync(path.dirname(file('alice')), { recursive: true })
fs.writeFileSync(file('alice'), JSON.stringify({ diary: { provider: 'p', model: 'm' } }), 'utf8')
assert.equal(readJudgeChoice(home, 'alice'), null, '没设判分就不该瞎猜')

// 旧扁平格式同样不能当判分
fs.writeFileSync(file('alice'), JSON.stringify({ provider: 'old', model: 'old-m' }), 'utf8')
assert.equal(readJudgeChoice(home, 'alice'), null)

// ---- 3. 正常读取 ----
fs.writeFileSync(file('alice'), JSON.stringify({
  diary: { provider: 'd', model: 'dm' },
  judge: { provider: 'j', model: 'jm', reasoningEffort: 'low' }
}), 'utf8')
const choice = readJudgeChoice(home, 'alice')
assert.deepEqual(choice, { provider: 'j', model: 'jm', reasoningEffort: 'low' })

// 不带等级
fs.writeFileSync(file('alice'), JSON.stringify({ judge: { provider: 'j', model: 'jm' } }), 'utf8')
assert.deepEqual(readJudgeChoice(home, 'alice'), { provider: 'j', model: 'jm' })

// ---- 4. 带 BOM 也要能读（别的工具可能写进 BOM） ----
const withBom = Buffer.concat([
  Buffer.from([0xef, 0xbb, 0xbf]),
  Buffer.from(JSON.stringify({ judge: { provider: 'b', model: 'bm' } }), 'utf8')
])
fs.writeFileSync(file('alice'), withBom)
assert.equal(readJudgeChoice(home, 'alice').provider, 'b')

// ---- 5. 残缺/非法一律 null ----
for (const bad of [
  '{broken',
  JSON.stringify({ judge: { provider: '', model: 'x' } }),
  JSON.stringify({ judge: { provider: 'x', model: '  ' } }),
  JSON.stringify({ judge: 'not-an-object' }),
  JSON.stringify({ judge: { provider: 42, model: 'x' } }),
  '[]',
  'null'
]) {
  fs.writeFileSync(file('alice'), bad, 'utf8')
  assert.equal(readJudgeChoice(home, 'alice'), null, '应当拒绝：' + bad)
}

// ---- 6. 人格隔离 ----
fs.writeFileSync(file('alice'), JSON.stringify({ judge: { provider: 'alice-p', model: 'm' } }), 'utf8')
assert.equal(readJudgeChoice(home, 'alice').provider, 'alice-p')
assert.equal(readJudgeChoice(home, 'default'), null, '别的人格不能读到 alice 的设置')

// ---- 7. 参数缺省 ----
assert.equal(readJudgeChoice('', 'alice'), null)
assert.equal(readJudgeChoice(home, ''), null)

fs.rmSync(home, { recursive: true, force: true })
console.log('JUDGE ROUTE PASS')