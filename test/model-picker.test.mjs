import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { normalizeChoice, readChoice, writeChoice, clearChoice, choiceFile } from '../lib/model-choice.js'
import { buildCatalog, verifyChoice, describeCurrent } from '../lib/model-route.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'catdiary-'))

// 1. 未设置时为 null
assert.equal(readChoice(tmp), null)

// 2. 非法值一律 null，不半成品
assert.equal(normalizeChoice(null), null)
assert.equal(normalizeChoice({ provider: ' ', model: 'x' }), null)
assert.equal(normalizeChoice({ provider: 'a', model: '' }), null)
assert.equal(normalizeChoice({ provider: 'a', model: 'b', reasoningEffort: '' }).reasoningEffort, undefined)

// 3. 写入 -> 读回
const saved = writeChoice(tmp, { provider: 'buddy', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' })
assert.equal(saved.provider, 'buddy')
assert.equal(saved.reasoningEffort, 'high')
assert.ok(saved.savedAt > 0)
const back = readChoice(tmp)
assert.deepEqual({ p: back.provider, m: back.model, e: back.reasoningEffort }, { p: 'buddy', m: 'deepseek-v4.1-flash', e: 'high' })

// 4. 无 BOM
const raw = fs.readFileSync(choiceFile(tmp))
assert.notEqual(raw[0], 0xef)

// 5. 清除
assert.equal(clearChoice(tmp), true)
assert.equal(clearChoice(tmp), false)
assert.equal(readChoice(tmp), null)

// 6. 目录构建：超时的 provider 只进 failures
const fakeLlm = {
  listProviders: () => [
    { id: 'good', name: '好渠道' },
    { id: 'slow', name: '卡住的渠道' }
  ],
  listModels: async (id) => {
    if (id === 'slow') return new Promise(() => {})            // 永不 resolve
    return [{ id: 'm1', name: '模型一' }]
  },
  resolveModelInfo: async (id, model) => {
    if (model === 'm1') return { provider: id, id: model, name: '模型一', reasoning: { efforts: [{ id: 'low', name: '低' }, { id: 'high', name: '高' }], defaultEffort: 'low' } }
    throw new Error('no info')
  }
}
// 撑一个 keep-alive：这个用例里除了测试自己的定时器没有别的活动 handle，
// 万一将来 withTimeout 又被人改成 unref，进程会静默提前退出而不是报错。
const keepAlive = setInterval(() => {}, 1000)
const t0 = Date.now()
const catalog = await buildCatalog(fakeLlm, { providerTimeoutMs: 300 })
const elapsed = Date.now() - t0
clearInterval(keepAlive)
assert.equal(catalog.groups.length, 1)
assert.equal(catalog.groups[0].id, 'good')
assert.equal(catalog.groups[0].models[0].reasoning.efforts.length, 2)
assert.equal(catalog.failures.length, 1)
assert.equal(catalog.failures[0].id, 'slow')
assert.ok(elapsed < 3000, '超时必须生效，实测 ' + elapsed + 'ms')

// 7. 选择核对三级
assert.equal(verifyChoice(catalog, { provider: 'good', model: 'm1' }).ok, true)
assert.equal(verifyChoice(catalog, { provider: 'good', model: 'm1', reasoningEffort: 'high' }).ok, true)
assert.equal(verifyChoice(catalog, { provider: 'good', model: 'm1', reasoningEffort: 'max' }).ok, false)
assert.equal(verifyChoice(catalog, { provider: 'good', model: 'zzz' }).ok, false)
assert.equal(verifyChoice(catalog, { provider: 'nope', model: 'm1' }).ok, false)
const slowVerdict = verifyChoice(catalog, { provider: 'slow', model: 'm1' })
assert.equal(slowVerdict.ok, false)
assert.ok(slowVerdict.error.includes('读不到'), slowVerdict.error)

// 8. describeCurrent：存储优先于 fallback
const fallback = () => ({ provider: 'cfg', model: 'cfgmodel', source: 'config' })
assert.deepEqual(describeCurrent({ dataRoot: tmp, fallback }).source, 'config')
writeChoice(tmp, { provider: 'x', model: 'y' })
const described = describeCurrent({ dataRoot: tmp, fallback })
assert.equal(described.source, 'stored')
assert.equal(described.provider, 'x')

fs.rmSync(tmp, { recursive: true, force: true })
console.log('ALL PASS')