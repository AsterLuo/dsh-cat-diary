import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  CHOICE_FILE, PURPOSES, normalizePurpose,
  normalizeChoice, readChoice, writeChoice, clearChoice, choiceFile
} from '../lib/model-choice.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'catdiary-purpose-'))

// ---- 1. 用途归一 ----
assert.equal(normalizePurpose('judge'), 'judge')
assert.equal(normalizePurpose('diary'), 'diary')
assert.equal(normalizePurpose(undefined), 'diary', '缺省必须是日记，与旧行为一致')
assert.equal(normalizePurpose('JUDGE'), 'diary', '大小写不做魔法转换，只认精确值')
assert.deepEqual([...PURPOSES], ['diary', 'judge'])

// ---- 2. 两个用途互不影响 ----
assert.equal(readChoice(tmp), null)
assert.equal(readChoice(tmp, 'judge'), null)

writeChoice(tmp, { provider: 'p1', model: 'm1', reasoningEffort: 'low' }, 'diary')
writeChoice(tmp, { provider: 'p2', model: 'm2' }, 'judge')

assert.equal(readChoice(tmp, 'diary').model, 'm1')
assert.equal(readChoice(tmp, 'diary').reasoningEffort, 'low')
assert.equal(readChoice(tmp, 'judge').model, 'm2')
assert.equal(readChoice(tmp, 'judge').reasoningEffort, undefined)

// 改一个不该动另一个
writeChoice(tmp, { provider: 'p3', model: 'm3' }, 'diary')
assert.equal(readChoice(tmp, 'judge').model, 'm2', '改日记不应影响判分')

// 文件里两个键都在
const raw = JSON.parse(fs.readFileSync(choiceFile(tmp), 'utf8'))
assert.deepEqual(Object.keys(raw).sort(), ['diary', 'judge'])

// 无 BOM
assert.notEqual(fs.readFileSync(choiceFile(tmp))[0], 0xef)

// ---- 3. 只清一个用途 ----
assert.equal(clearChoice(tmp, 'judge'), true)
assert.equal(readChoice(tmp, 'judge'), null)
assert.equal(readChoice(tmp, 'diary').model, 'm3', '清判分不能连日记一起清')
assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(choiceFile(tmp), 'utf8'))), ['diary'])

// 清最后一个 -> 文件消失
assert.equal(clearChoice(tmp, 'diary'), true)
assert.equal(fs.existsSync(choiceFile(tmp)), false)
assert.equal(readChoice(tmp), null)
// 再清不存在的
assert.equal(clearChoice(tmp, 'diary'), false)

// ---- 4. 旧格式自动升级（升级后主人的设置必须继续有效） ----
const legacy = { provider: 'old-p', model: 'old-m', reasoningEffort: 'high', savedAt: 123 }
fs.writeFileSync(choiceFile(tmp), JSON.stringify(legacy), 'utf8')

assert.equal(readChoice(tmp, 'diary').model, 'old-m', '旧的扁平文件要当成日记的选择')
assert.equal(readChoice(tmp, 'judge'), null, '旧文件没有判分选择，不能瞎猜')

writeChoice(tmp, { provider: 'new-p', model: 'new-m' }, 'judge')
const upgraded = JSON.parse(fs.readFileSync(choiceFile(tmp), 'utf8'))
assert.equal(upgraded.diary.model, 'old-m', '升级时不能丢旧值')
assert.equal(upgraded.judge.model, 'new-m')
assert.equal(upgraded.provider, undefined, '升级后不应残留扁平字段')

// ---- 5. 坏文件：读成 null，但不删（那是主人的设置） ----
fs.writeFileSync(choiceFile(tmp), '{broken', 'utf8')
assert.equal(readChoice(tmp, 'diary'), null)
assert.equal(readChoice(tmp, 'judge'), null)
assert.equal(fs.existsSync(choiceFile(tmp)), true, '读失败不许删文件')

// ---- 6. 非法输入 ----
assert.equal(normalizeChoice({ provider: '  ', model: 'x' }), null)
assert.throws(() => writeChoice(tmp, { provider: '', model: 'x' }), /provider/)

fs.rmSync(tmp, { recursive: true, force: true })
console.log('PURPOSE PASS')
