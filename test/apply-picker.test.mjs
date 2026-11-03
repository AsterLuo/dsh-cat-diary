import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const entry = await import('../lib/index.js')

// ---- 假的 cordis 上下文：只实现 apply 真正碰到的那几个面 ----
const registeredRoutes = []
const contexts = new Map()
function makeCtx ({ withWebServer = true, withLlm = true } = {}) {
  const llm = withLlm
    ? {
        listProviders: () => [{ id: 'p', name: '渠道' }],
        listModels: async () => [{ id: 'm', name: '模型' }],
        resolveModelInfo: async (provider, id) => ({ provider, id, name: id })
      }
    : null
  const services = new Map()
  if (withWebServer) {
    services.set('webServer', {
      register: (route) => { registeredRoutes.push(route.path); return () => {} }
    })
  }
  if (llm) services.set('llm', llm)
  const ctx = {
    get: (name) => services.get(name),
    inject: (names, fn) => {
      const host = {
        get: (name) => services.get(name),
        webServer: services.get('webServer'),
        effect: (inner) => { inner(); return () => {} }
      }
      if (names.every((name) => services.has(name))) fn(host)
    },
    effect: (fn) => { fn(); return () => {} },
    systemPrompt: {
      getContextOrder: () => 130,
      context: (entry) => { contexts.set(entry.name, entry) }
    },
    logger: { warn: () => {}, info: () => {} },
    on: () => {},
    set: () => {}
  }
  return ctx
}

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'catdiary-apply-'))

// 1. 正常 apply：不抛，且路由注册上了
const ctx1 = makeCtx()
entry.apply(ctx1, { dshHome: tmpHome, person: 'p1', autoWrite: false, cutoffHour: 5 })
assert.ok(contexts.has('cat-diary-brief'), '速读卡上下文必须注册')
assert.ok(registeredRoutes.includes('/dsh-cat-diary/diary/model'), '模型路由必须注册：' + registeredRoutes.join(','))

// 2. 没有 webServer 的宿主：apply 仍然不抛（只是没有路由）
registeredRoutes.length = 0
entry.apply(makeCtx({ withWebServer: false }), { dshHome: tmpHome, person: 'p2', autoWrite: false })

// 3. 开着 autoWrite：定时器 unref，不会拖住进程；这里只验证不抛
entry.apply(makeCtx(), { dshHome: tmpHome, person: 'p3', autoWrite: true, autoWriteDelayMs: 50, cutoffHour: 5 })

// 4. 没有 llm：路由仍然注册（GET 时才报错）
registeredRoutes.length = 0
entry.apply(makeCtx({ withLlm: false }), { dshHome: tmpHome, person: 'p4', autoWrite: false })
assert.ok(registeredRoutes.includes('/dsh-cat-diary/diary/model'), '没有 llm 也要把路由挂上')

// 5. resolveAutoWriteRoute 在 apply 里被用到的路径：存储优先
const { writeChoice } = await import('../lib/model-choice.js')
const dataRoot = path.join(tmpHome, 'storages', 'dsh-cat-diary', 'p5')
fs.mkdirSync(dataRoot, { recursive: true })
writeChoice(dataRoot, { provider: 'stored-p', model: 'stored-m' })
const route = entry.resolveAutoWriteRoute({ get: () => null }, { provider: 'cfg-p', model: 'cfg-m' }, dataRoot)
assert.equal(route.source, 'stored')
assert.equal(route.provider, 'stored-p')

// 等一拍，让第 3 个用例的 50ms 定时器跑掉
await new Promise((resolve) => setTimeout(resolve, 200))

fs.rmSync(tmpHome, { recursive: true, force: true })
console.log('APPLY PASS')
