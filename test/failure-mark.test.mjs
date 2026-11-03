import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { writeOneDay } from '../lib/autowrite.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'catdiary-fail-'))
// 先摆一份原料，否则 writeOneDay 会判定"没有素材"直接跳过，根本走不到模型那一步
fs.mkdirSync(path.join(tmp, 'raw'), { recursive: true })
fs.writeFileSync(path.join(tmp, 'raw', '2026-11-01.md'), '主人：今天修了日记插件。\n', 'utf8')

// 一个"生成就失败"的宿主：llm.stream 抛错，模拟渠道没注册
const ctx = {
  get: (name) => (name === 'llm'
    ? { stream: () => { throw new Error('no adapter registered for provider "buddy"') } }
    : null)
}

const result = await writeOneDay(ctx, {
  dataRoot: tmp,
  dshHome: tmp,
  day: '2026-11-01',
  person: 'p',
  cutoffHour: 5,
  provider: 'buddy',
  model: 'deepseek-v4.1-flash',
  reasoningEffort: 'high',
  maxDaily: 16
})

assert.equal(result.ok, false, '生成失败必须如实返回')
const failedFile = path.join(tmp, 'days', '2026-11-01.failed.json')
assert.ok(fs.existsSync(failedFile), '失败必须落盘留痕')
const failed = JSON.parse(fs.readFileSync(failedFile, 'utf8'))
assert.equal(failed.day, '2026-11-01')
assert.ok(String(failed.error).includes('no adapter'), failed.error)
assert.ok(failed.route, '失败痕迹必须带上当时用的路由')
assert.equal(failed.route.provider, 'buddy')
assert.equal(failed.route.model, 'deepseek-v4.1-flash')
assert.equal(failed.route.reasoningEffort, 'high')
assert.ok(failed.at > 0)

// 无原料的日子：不写日记，也不留失败痕迹
const emptyResult = await writeOneDay(ctx, {
  dataRoot: tmp, dshHome: tmp, day: '2020-01-01', person: 'p', cutoffHour: 5,
  provider: 'buddy', model: 'm'
})
assert.equal(emptyResult.skipped, 'no-material')
assert.ok(!fs.existsSync(path.join(tmp, 'days', '2020-01-01.failed.json')), '没原料不是失败')

fs.rmSync(tmp, { recursive: true, force: true })
console.log('FAILMARK PASS')
