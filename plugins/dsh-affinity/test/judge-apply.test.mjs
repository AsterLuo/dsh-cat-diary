import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 端到端：真的跑一遍 apply()，用假 ctx 观察判分实际用了哪条路由。
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'affinity-apply-'))
process.env.DSH_HOME = home

const mod = await import('../lib/index.js')

const calls = []
const llm = {
  stream: (options) => {
    calls.push({ provider: options.provider, model: options.model, reasoningEffort: options.reasoningEffort })
    return (async function * () {
      yield { type: 'text-delta', text: '{"delta": 1, "reason": "主人给了明确的约束与授权"}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  }
}

const handlers = new Map()
const services = new Map([['llm', llm]])
const ctx = {
  get: (name) => services.get(name),
  on: (event, fn) => { handlers.set(event, fn) },
  set: () => {},
  inject: (names, fn) => fn({ get: (n) => services.get(n), webServer: { register: () => () => {} }, effect: (f) => { f(); return () => {} } }),
  effect: (fn) => { fn(); return () => {} },
  logger: { warn: () => {}, info: () => {} },
  systemPrompt: { getContextOrder: () => 135, context: () => {} },
  tools: { register: () => {} }
}

mod.apply(ctx, { person: 'alice', maxStep: 4, maxDaily: 16, cutoffHour: 5, diag: false })
assert.ok(handlers.has('agent/pre-step'), 'pre-step 钩子必须注册')

const preStep = handlers.get('agent/pre-step')
const makePayload = (turn, text) => ({
  turn,
  step: 1,
  messages: [{ id: 'm' + turn, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }],
  agent: {
    id: 'sess-1',
    options: { provider: 'session-p', model: 'session-m' },
    session: { requestHeader: () => ({ header: { config: { provider: 'session-p', model: 'session-m' } } }) }
  },
  signal: undefined
})

// ---- 1. 没有面板选择时：跟随会话 ----
await preStep(makePayload(1, '主人：请把这件事认真做完，要保证不出问题'), () => {})
assert.equal(calls.length, 1)
assert.deepEqual(
  { p: calls[0].provider, m: calls[0].model, e: calls[0].reasoningEffort },
  { p: 'session-p', m: 'session-m', e: undefined },
  '没设过判分模型时应该用会话路由'
)

// ---- 2. 面板上给判分选了模型：优先于会话 ----
const choiceDir = path.join(home, 'storages', 'dsh-cat-diary', 'alice')
fs.mkdirSync(choiceDir, { recursive: true })
fs.writeFileSync(path.join(choiceDir, 'autoWriteRoute.json'), JSON.stringify({
  diary: { provider: 'diary-p', model: 'diary-m' },
  judge: { provider: 'judge-p', model: 'judge-m', reasoningEffort: 'low' }
}), 'utf8')

await preStep(makePayload(2, '主人：继续，把剩下的一起做完'), () => {})
assert.equal(calls.length, 2)
assert.deepEqual(
  { p: calls[1].provider, m: calls[1].model, e: calls[1].reasoningEffort },
  { p: 'judge-p', m: 'judge-m', e: 'low' },
  '面板选择必须压过会话路由，且带上思考等级'
)

// ---- 3. 会话路由指向坏渠道 + 面板有值：仍然要成功 ----
await preStep({
  ...makePayload(3, '主人：这事交给你了，我信你'),
  agent: { id: 'sess-1', options: { provider: 'buddy', model: 'deepseek-v4.1-flash' }, session: { requestHeader: () => null } }
}, () => {})
assert.equal(calls.length, 3)
assert.equal(calls[2].provider, 'judge-p', 'buddy 那种坏路由不该影响判分')

// 账本里应该真的落了分
const ledger = fs.readFileSync(path.join(home, 'storages', 'dsh-affinity', 'alice', 'affinity', 'events.jsonl'), 'utf8')
  .trim().split('\n').map((line) => JSON.parse(line))
const judged = ledger.filter((e) => e.kind === 'judge')
assert.ok(judged.length >= 3, '三次判分都要有记录，实际 ' + judged.length)

fs.rmSync(home, { recursive: true, force: true })
console.log('JUDGE APPLY PASS')