import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { resolveAutoWriteRoute } from '../lib/index.js'
import { writeChoice, clearChoice } from '../lib/model-choice.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'catdiary-route-'))

// 宿主 ctx：llm 顺序走 agentDefaultModel
const ctx = {
  get: (name) => {
    if (name === 'agentDefaultModel') {
      return { currentSelection: () => ({ provider: 'host-p', model: 'host-m' }) }
    }
    return null
  }
}

// 1. 什么都没配 -> 宿主默认
let route = resolveAutoWriteRoute(ctx, {}, tmp)
assert.deepEqual(route, { provider: 'host-p', model: 'host-m', source: 'host' })

// 2. 配置有 -> config 胜出宿主
route = resolveAutoWriteRoute(ctx, { provider: 'cfg-p', model: 'cfg-m', reasoningEffort: 'high' }, tmp)
assert.equal(route.source, 'config')
assert.equal(route.reasoningEffort, 'high')

// 3. 面板存过 -> stored 胜出配置（这一条是本次修复的核心）
writeChoice(tmp, { provider: 'pick-p', model: 'pick-m' })
route = resolveAutoWriteRoute(ctx, { provider: 'cfg-p', model: 'cfg-m' }, tmp)
assert.equal(route.source, 'stored')
assert.equal(route.provider, 'pick-p')
assert.equal(route.model, 'pick-m')
assert.equal(route.reasoningEffort, undefined)

// 4. 存过带等级
writeChoice(tmp, { provider: 'pick-p', model: 'pick-m', reasoningEffort: 'max' })
route = resolveAutoWriteRoute(ctx, {}, tmp)
assert.equal(route.reasoningEffort, 'max')

// 5. 清掉后回到配置
clearChoice(tmp)
route = resolveAutoWriteRoute(ctx, { provider: 'cfg-p', model: 'cfg-m' }, tmp)
assert.equal(route.source, 'config')

// 6. 没有宿主默认模型也拿不到配置 -> null（不猜）
const blind = { get: () => null }
assert.equal(resolveAutoWriteRoute(blind, {}, tmp), null)

// 7. 存储文件坏了 -> 优雅退回配置，而不是抛
fs.writeFileSync(path.join(tmp, 'autoWriteRoute.json'), '{broken', 'utf8')
route = resolveAutoWriteRoute(ctx, { provider: 'cfg-p', model: 'cfg-m' }, tmp)
assert.equal(route.source, 'config')

fs.rmSync(tmp, { recursive: true, force: true })
console.log('ROUTE PASS')
