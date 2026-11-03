/**
 * `dsh-cat-diary` — 日记模型选择器的 Host 半区。
 *
 * 三件事，一件都不能少：
 *
 * 1. **实时目录**。模型与推理等级一律从宿主的 llm 服务现读，绝不写死一份清单——
 *    写死的清单在换渠道/换账号之后就是错的，而错清单比没有清单更糟：它会让人
 *    以为"选过了"，实际选的是一个已经不存在的东西。
 * 2. **超时隔离**。每个 provider 的枚举单独限时。任何一个渠道卡住（实测某个
 *    本地网关在目录拉取失败时会反复重试），面板都必须照常弹出，只是那一组
 *    标红并写明原因。整窗挂在第一个渠道上是最差的体验。
 * 3. **短缓存**。目录 5 分钟有效，避免每次点开弹窗都去打一遍远端。
 *
 * @module dsh-cat-diary/model-route
 */

import { readChoice, writeChoice, clearChoice, choiceFile, normalizePurpose, PURPOSES } from './model-choice.js'

/** 模型目录路由（GET 读、POST 存、`{"reset":true}` 清）。 */
export const MODEL_ROUTE = '/dsh-cat-diary/diary/model'

/** 目录缓存时长。 */
const CATALOG_TTL_MS = 5 * 60 * 1000

/**
 * 单个 provider 枚举的限时。
 *
 * 原来的 8 秒对「几十个模型逐个解析元数据」的渠道不够（实测过一个渠道挂 70 个
 * 模型），单个渠道慢不该让整组被判失败。放宽到 20 秒；元数据解析本身改成 6 路
 * 并发，整个目录再有 5 分钟缓存，所以这只是保险丝而不是常见路径。
 */
const PROVIDER_TIMEOUT_MS = 20000

/** 单次请求体上限（选择器只提交三个短字符串）。 */
const MAX_BODY_BYTES = 8 * 1024

/**
 * 给一个 Promise 加超时，超时后 reject 一个可读错误。
 * @param {Promise<unknown>} promise - 原始 Promise。
 * @param {number} ms - 毫秒。
 * @param {string} label - 报错里用的名字。
 * @returns {Promise<unknown>} 结果。
 */
function withTimeout (promise, ms, label) {
  return new Promise((resolve, reject) => {
    // 故意 **不** unref：unref 的定时器在事件循环空闲时不会触发，
    // 而"超时永远不触发"正是这层最不该出现的失败模式（那时候整窗会一直转圈）。
    // 每次正常返回都会 clearTimeout，所以不会积累。
    const timer = setTimeout(() => reject(new Error(label + ' 超过 ' + Math.round(ms / 1000) + ' 秒没有返回')), ms)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) }
    )
  })
}

/**
 * 读一份 provider 的模型清单（含推理等级）。
 * @param {object} llm - 宿主 llm 服务。
 * @param {{id: string, name: string}} provider - provider 元数据。
 * @returns {Promise<object>} `{kind:'group'|'failure', …}`。
 */
async function readProvider (llm, provider) {
  const models = await llm.listModels(provider.id)
  // 并发解析元数据，但要限流。
  //
  // 实测过单个渠道就挂 70 个模型的情况：串行 await 一轮下来会撞穿渠道超时，
  // 整组被判定失败——而它其实完全正常，只是慢。反过来一次性 70 个并发又会把
  // 适配器/上游打满。6 路刚好。
  const limit = 6
  const entries = new Array(models.length)
  let cursor = 0
  const worker = async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= models.length) return
      const model = models[index]
      // resolveModelInfo 单个模型失败不该带走整组：某渠道对个别模型不给元数据
      // 是常态（实测 workbuddy 就整组不给），整组失败会让面板上整块空白。
      let reasoning = null
      try {
        const resolved = await llm.resolveModelInfo(provider.id, model.id)
        if (resolved?.reasoning && Array.isArray(resolved.reasoning.efforts) && resolved.reasoning.efforts.length > 0) {
          reasoning = {
            efforts: resolved.reasoning.efforts.map((effort) => ({
              id: effort.id,
              name: effort.name,
              ...(typeof effort.description === 'string' ? { description: effort.description } : {})
            })),
            ...(typeof resolved.reasoning.defaultEffort === 'string'
              ? { defaultEffort: resolved.reasoning.defaultEffort }
              : {})
          }
        }
      } catch {
        reasoning = null
      }
      entries[index] = {
        id: model.id,
        name: model.name,
        ...(reasoning === null ? {} : { reasoning })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, models.length) }, worker))
  return { kind: 'group', group: { id: provider.id, name: provider.name, models: entries } }
}

/**
 * 建立整份目录。任何一组失败都只让它进 failures，不抛。
 * @param {object} llm - 宿主 llm 服务。
 * @param {{providerTimeoutMs?: number}} [options] - 超时可覆盖（测试用极小值）。
 * @returns {Promise<{groups: object[], failures: object[]}>} 目录。
 */
export async function buildCatalog (llm, options = {}) {
  const providerTimeoutMs = Number.isFinite(options.providerTimeoutMs)
    ? options.providerTimeoutMs
    : PROVIDER_TIMEOUT_MS
  const providers = typeof llm?.listProviders === 'function' ? llm.listProviders() : []
  const settled = await Promise.all(providers.map(async (provider) => {
    try {
      return await withTimeout(readProvider(llm, provider), providerTimeoutMs, provider.id)
    } catch (error) {
      return {
        kind: 'failure',
        failure: {
          id: provider.id,
          name: provider.name,
          message: String(error?.message ?? error)
        }
      }
    }
  }))
  return {
    groups: settled.filter((item) => item.kind === 'group').map((item) => item.group)
      .filter((group) => group.models.length > 0),
    failures: settled.filter((item) => item.kind === 'failure').map((item) => item.failure)
  }
}

/**
 * 读完请求体（超限即拒绝）。
 * @param {import('node:http').IncomingMessage} request - 请求。
 * @returns {Promise<object>} 解析后的 JSON 对象。
 */
function readJsonBody (request) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') return resolve({})
      try {
        const value = JSON.parse(text)
        resolve(value && typeof value === 'object' ? value : {})
      } catch (error) {
        reject(new Error('请求体不是合法 JSON：' + String(error?.message ?? error)))
      }
    })
    request.on('error', reject)
  })
}

/**
 * 从目录里核对一个选择是否真的存在（provider/model/effort 三级）。
 * @param {{groups: object[]}} catalog - 目录。
 * @param {{provider: string, model: string, reasoningEffort?: string}} choice - 选择。
 * @returns {{ok: boolean, error?: string}} 核对结果。
 */
export function verifyChoice (catalog, choice) {
  const group = catalog.groups.find((item) => item.id === choice.provider)
  if (!group) {
    const failure = (catalog.failures ?? []).find((item) => item.id === choice.provider)
    return {
      ok: false,
      error: failure
        ? '渠道 ' + choice.provider + ' 的模型清单读不到（' + failure.message + '），先修好这个渠道再选'
        : '没有这个渠道：' + choice.provider
    }
  }
  const model = group.models.find((item) => item.id === choice.model)
  if (!model) return { ok: false, error: group.name + ' 里没有模型 ' + choice.model }
  if (choice.reasoningEffort === undefined) return { ok: true }
  const efforts = model.reasoning?.efforts ?? []
  if (!efforts.some((effort) => effort.id === choice.reasoningEffort)) {
    return {
      ok: false,
      error: model.name + ' 不支持思考等级 ' + choice.reasoningEffort
    }
  }
  return { ok: true }
}

/**
 * 注册模型选择路由。
 *
 * @param {object} ctx - 插件上下文。
 * @param {{
 *   dataRoot: string,
 *   fallback: () => {provider?: string, model?: string, reasoningEffort?: string, source: string}
 * }} deps - 依赖。`fallback` 在没存过选择时给出配置/宿主默认值。
 * @returns {void}
 */
export function registerModelRoutes (ctx, deps) {
  if (!ctx || typeof ctx.inject !== 'function') return
  // 只把 webServer 写进 inject。
  //
  // `llm` 故意不写：inject 是硬等待，服务名一旦对不上（或这个 profile 里根本
  // 没装对话组件），整条路由就永远不注册，而外部表现和「插件没装」一模一样。
  // 改成运行时探测，取不到就在响应里明说——这是本仓库一贯的取舍。
  ctx.inject(['webServer'], (host) => {
    const cache = { at: 0, value: null }

    /**
     * 运行时探测宿主的 llm 服务。
     *
     * 顺序不能反：先问 **scoped host**（它的 inject 链是完整的），再退回外层
     * ctx。cordis 在 fiber 里访问没写进 inject 的服务会直接抛错，所以两次都
     * 必须各自 try/catch——外层那次抛了不该把内层已经拿到的结果作废。
     *
     * @returns {object|null} 服务或 null。
     */
    const probeLlm = () => {
      try {
        const fromHost = host.get?.('llm')
        if (fromHost) return fromHost
      } catch {
        /* 没声明就抛，正常 */
      }
      try {
        return ctx.get?.('llm') ?? null
      } catch {
        return null
      }
    }

    const catalog = async (force) => {
      const llm = probeLlm()
      if (llm === null) throw new Error('宿主没有 llm 服务，读不到模型清单')
      const now = Date.now()
      if (!force && cache.value !== null && now - cache.at < CATALOG_TTL_MS) return cache.value
      const built = await buildCatalog(llm)
      cache.value = built
      cache.at = now
      return built
    }

    const json = (response, status, payload, method) => {
      response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store'
      })
      response.end(method === 'HEAD' ? undefined : JSON.stringify(payload))
    }

    host.effect(() => host.webServer.register({
      kind: 'exact',
      path: MODEL_ROUTE,
      handler: async (request, response) => {
        const method = request.method ?? 'GET'
        if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
          response.writeHead(405, { allow: 'GET, HEAD, POST' })
          response.end()
          return
        }
        try {
          // 用途从**查询串**取，不从 body 取：GET 要能读某一用途、POST 要能写
          // 某一用途，两者共用一个参数名才不会出现「写 A 读 B」的错位。
          // 路径保持一条（不加 /judge 之类的子路径），因为路由是按 pathname
          // 精确匹配的，多一条就多一个需要同步注册的面。
          const url = new URL(String(request.url ?? ''), 'http://127.0.0.1')
          const purpose = normalizePurpose(url.searchParams.get('purpose'))
          if (method === 'POST') {
            const body = await readJsonBody(request)
            if (body.reset === true) {
              clearChoice(deps.dataRoot, purpose)
              json(response, 200, { ok: true, purpose, current: describeCurrent(deps, purpose) }, method)
              return
            }
            const candidate = {
              provider: String(body.provider ?? '').trim(),
              model: String(body.model ?? '').trim(),
              ...(body.reasoningEffort === undefined || body.reasoningEffort === null || String(body.reasoningEffort).trim() === ''
                ? {}
                : { reasoningEffort: String(body.reasoningEffort).trim() })
            }
            const live = await catalog(false)
            const verdict = verifyChoice(live, candidate)
            if (!verdict.ok) {
              json(response, 400, { ok: false, purpose, error: verdict.error, current: describeCurrent(deps, purpose) }, method)
              return
            }
            const saved = writeChoice(deps.dataRoot, candidate, purpose)
            json(response, 200, { ok: true, purpose, current: describeCurrent(deps, purpose), saved }, method)
            return
          }
          const force = url.searchParams.get('refresh') === '1'
          const live = await catalog(force)
          json(response, 200, {
            ok: true,
            purpose,
            current: describeCurrent(deps, purpose),
            // 两个用途各自的当前值一起给出：前端切页签时不必再发一次请求，
            // 而且能顺便显示「另一边选了什么」，避免以为自己改错了。
            purposes: Object.fromEntries(PURPOSES.map((key) => [key, describeCurrent(deps, key)])),
            groups: live.groups,
            failures: live.failures,
            file: choiceFile(deps.dataRoot),
            generatedAt: cache.at
          }, method)
        } catch (error) {
          json(response, 500, { ok: false, error: String(error?.message ?? error) }, method)
        }
      }
    }), 'dsh-cat-diary: model route')
  })
}

/**
 * 当前生效的选择：存储文件 > 该用途的兜底。
 *
 * `fallback` 现在按用途取：日记的兜底是 `autoWriteRoute` / 宿主默认模型，
 * 判分的兜底是**当前会话所用的模型**（判分本来就跑在会话里，用同一个模型
 * 最自然，也顺手治好了 buddy 那个 NO_ADAPTER 的历史故障）。
 *
 * @param {{dataRoot: string, fallback: (purpose: string) => object}} deps - 依赖。
 * @param {'diary'|'judge'} [purpose] - 用途。
 * @returns {object} 描述。
 */
export function describeCurrent (deps, purpose = 'diary') {
  const key = normalizePurpose(purpose)
  const stored = readChoice(deps.dataRoot, key)
  if (stored) {
    return {
      provider: stored.provider,
      model: stored.model,
      ...(stored.reasoningEffort === undefined ? {} : { reasoningEffort: stored.reasoningEffort }),
      source: 'stored',
      savedAt: stored.savedAt
    }
  }
  const fallback = typeof deps.fallback === 'function' ? (deps.fallback(key) ?? {}) : {}
  return {
    ...(fallback?.provider ? { provider: fallback.provider } : {}),
    ...(fallback?.model ? { model: fallback.model } : {}),
    ...(fallback?.reasoningEffort ? { reasoningEffort: fallback.reasoningEffort } : {}),
    source: fallback?.source ?? 'none'
  }
}