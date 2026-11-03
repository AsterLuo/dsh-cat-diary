import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'

import { registerModelRoutes, MODEL_ROUTE } from '../lib/model-route.js'
import { readChoice } from '../lib/model-choice.js'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const clientSource = fs.readFileSync(path.join(ROOT, 'client/client.js'), 'utf8')
const clientRoute = /const MODEL_ROUTE = '(\S+)'/.exec(clientSource)?.[1]
assert.equal(clientRoute, MODEL_ROUTE, '客户端与服务端路由必须完全一致')

// ---- 假的宿主上下文：只实现本模块真正用到的那几个面 ----
const routes = new Map()
// llm 在 inject 之外，靠运行时探测：这条是本次的契约，测试里也照它搭。
const LLM = {
  listProviders: () => [
    { id: 'alpha', name: '甲渠道' },
    { id: 'beta', name: '乙渠道' }
  ],
  listModels: async (id) => (id === 'alpha'
    ? [{ id: 'a-1', name: '甲一' }, { id: 'a-2', name: '甲二' }]
    : [{ id: 'b-1', name: '乙一' }]),
  resolveModelInfo: async (provider, model) => {
    if (provider === 'beta') throw new Error('该渠道不给元数据')
    return { provider, id: model, name: model, reasoning: { efforts: [{ id: 'low', name: '低' }, { id: 'high', name: '高' }], defaultEffort: 'low' } }
  }
}
const webHost = {
  get: (name) => (name === 'llm' ? LLM : undefined),
  webServer: { register: (route) => { routes.set(route.path, route.handler); return () => {} } },
  effect: (fn) => { fn(); return () => {} }
}
const ctx = {
  get: (name) => (name === 'llm' ? LLM : undefined),
  inject: (names, fn) => {
    assert.deepEqual(names, ['webServer'], '只应硬等待 webServer，llm 走运行时探测')
    fn(webHost)
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'catdiary-int-'))
registerModelRoutes(ctx, {
  dataRoot: tmp,
  // 兜底按用途分：日记有明确配置，判分只声明"跟随当前会话"
  fallback: (purpose) => (purpose === 'judge'
    ? { source: 'session' }
    : { provider: 'cfg', model: 'cfg-m', source: 'config' })
})
assert.ok(routes.has(MODEL_ROUTE), '路由必须注册上')
const handler = routes.get(MODEL_ROUTE)

// ---- 起一个真 http server 打进去 ----
const server = http.createServer((req, res) => {
  handler(req, res).catch((error) => { res.writeHead(500); res.end(String(error)) })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const call = async (method, url, payload) => {
  const response = await fetch('http://127.0.0.1:' + port + url, {
    method,
    headers: payload === undefined ? {} : { 'content-type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload)
  })
  const text = await response.text()
  let parsed = null
  try { parsed = text === '' ? null : JSON.parse(text) } catch { parsed = { raw: text } }
  return { status: response.status, body: parsed }
}

// GET：实时目录
const got = await call('GET', MODEL_ROUTE)
assert.equal(got.status, 200)
assert.equal(got.body.groups.length, 2)
assert.equal(got.body.groups[0].models[0].reasoning.efforts.length, 2)
// 元数据失败不该拖垮整组：beta 的模型仍在，只是没有 reasoning
assert.equal(got.body.groups[1].models[0].reasoning, undefined)
assert.equal(got.body.current.source, 'config')

// POST：合法选择 -> 落盘
const ok = await call('POST', MODEL_ROUTE, { provider: 'alpha', model: 'a-2', reasoningEffort: 'high' })
assert.equal(ok.status, 200, JSON.stringify(ok.body))
assert.equal(ok.body.current.source, 'stored')
assert.equal(readChoice(tmp).model, 'a-2')

// POST：不存在的等级 -> 400，且不覆盖已存的合法值
const badEffort = await call('POST', MODEL_ROUTE, { provider: 'alpha', model: 'a-2', reasoningEffort: 'max' })
assert.equal(badEffort.status, 400)
assert.ok(badEffort.body.error.includes('max'))
assert.equal(readChoice(tmp).reasoningEffort, 'high', '被拒的写入不能改动已有选择')

// POST：不存在的模型 -> 400
assert.equal((await call('POST', MODEL_ROUTE, { provider: 'alpha', model: 'zzz' })).status, 400)
// POST：不存在的渠道 -> 400
assert.equal((await call('POST', MODEL_ROUTE, { provider: 'nope', model: 'a-1' })).status, 400)
// POST：非法 JSON -> 500（readJsonBody reject，被 catch）
assert.equal((await fetch('http://127.0.0.1:' + port + MODEL_ROUTE, { method: 'POST', body: '{oops' })).status, 500)
// 方法白名单
assert.equal((await call('DELETE', MODEL_ROUTE)).status, 405)

// POST reset -> 回到配置兜底
const reset = await call('POST', MODEL_ROUTE, { reset: true })
assert.equal(reset.status, 200)
assert.equal(reset.body.current.source, 'config')
assert.equal(readChoice(tmp), null)

// ---- 用途隔离：?purpose=judge 与默认日记互不影响 ----
const judgeSave = await call('POST', MODEL_ROUTE + '?purpose=judge', { provider: 'beta', model: 'b-1' })
assert.equal(judgeSave.status, 200, JSON.stringify(judgeSave.body))
assert.equal(judgeSave.body.purpose, 'judge')

const diaryState = await call('GET', MODEL_ROUTE)
assert.equal(diaryState.body.purpose, 'diary')
assert.ok(diaryState.body.purposes, '要同时给出两个用途的当前值')
assert.equal(diaryState.body.purposes.diary.source, 'config', '日记侧没存过，还是配置兜底')
assert.equal(diaryState.body.purposes.judge.source, 'stored')
assert.equal(diaryState.body.purposes.judge.model, 'b-1')
assert.equal(diaryState.body.current.source, 'config', 'current 必须跟着 purpose 走')

const judgeState = await call('GET', MODEL_ROUTE + '?purpose=judge')
assert.equal(judgeState.body.purpose, 'judge')
assert.equal(judgeState.body.current.model, 'b-1')

// 保存日记侧不动判分侧
await call('POST', MODEL_ROUTE, { provider: 'alpha', model: 'a-1' })
const afterSave = await call('GET', MODEL_ROUTE + '?purpose=judge')
assert.equal(afterSave.body.current.model, 'b-1', '存日记不能覆盖判分')

// 只清判分
const resetJudge = await call('POST', MODEL_ROUTE + '?purpose=judge', { reset: true })
assert.equal(resetJudge.status, 200)
assert.equal(resetJudge.body.current.source, 'session', '判分的兜底是跟随当前会话')
const diaryStillThere = await call('GET', MODEL_ROUTE)
assert.equal(diaryStillThere.body.current.model, 'a-1', '清判分不能连日记一起清')

// 用途参数写错时退回日记，不报错
const weirdPurpose = await call('GET', MODEL_ROUTE + '?purpose=nonsense')
assert.equal(weirdPurpose.body.purpose, 'diary')

// 宿主没有 llm 服务时：注册照常成功，GET 明确报错而不是白屏
const routes2 = new Map()
const blindCtx = {
  get: () => undefined,
  inject: (names, fn) => fn({
    get: () => undefined,
    webServer: { register: (route) => { routes2.set(route.path, route.handler); return () => {} } },
    effect: (fn2) => { fn2(); return () => {} }
  })
}
registerModelRoutes(blindCtx, { dataRoot: tmp, fallback: () => ({ source: 'none' }) })
assert.ok(routes2.has(MODEL_ROUTE), '没有 llm 也必须把路由挂上')
const blindServer = http.createServer((req, res) => { routes2.get(MODEL_ROUTE)(req, res) })
await new Promise((resolve) => blindServer.listen(0, '127.0.0.1', resolve))
const blindPort = blindServer.address().port
const blind = await fetch('http://127.0.0.1:' + blindPort + MODEL_ROUTE)
const blindBody = await blind.json()
assert.equal(blindBody.ok, false)
assert.ok(String(blindBody.error).includes('llm'), JSON.stringify(blindBody))
blindServer.close()

server.close()
fs.rmSync(tmp, { recursive: true, force: true })
console.log('INTEGRATION PASS')
