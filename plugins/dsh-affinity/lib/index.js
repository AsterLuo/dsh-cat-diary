/**
 * `dsh-affinity` — 好感度子插件（挂在 dsh-cat-diary 下的唯一写入方）。
 *
 * 三条不可让渡的契约：
 *
 * 1. **唯一写入方**。分数只经 `ledger.judge()` 落账；日记、速读卡、长期记忆、
 *    客户端面板一律只读。
 * 2. **每轮必判**。判定由宿主在 `agent/pre-step` 首步发起（不是靠提示词求模型调用）。
 *    实测把“请调用工具”写进提示词后，模型仍会挑更短的路径直接 finish，所以
 *    强制点必须落在事件循环里，而不是落在文风里。
 * 3. **失败不改分、不伪装成不变**。判定异常写 `failed` 记录，原分保留。
 *
 * 注入契约的两个静默坑（都实测踩过）：`inject` 必须是纯数组；`systemPrompt.context`
 * 的字段是 `text` 而不是 `render`——写 `render` 不报错，只是永远渲染空串。
 *
 * @module dsh-affinity
 */

import path from 'node:path'
import os from 'node:os'

import {
  judge, recordJudgeFailure, readLedger, summaryForDay, ensureInitialised, diaryDayOf,
  renderStatusLine, renderLabelledLine, ledgerPaths,
  DEFAULT_MAX_STEP, DEFAULT_MAX_DAILY, DEFAULT_CUTOFF_HOUR, INITIAL_SCORE, RULE_VERSION
} from './ledger.js'

import { runJudge } from './judge.js'
import { readJudgeChoice } from './judge-route.js'
import { createDiagnostics } from './diagnostics.js'
import { registerRoutes } from './route.js'

/** Cordis 插件名。 */
export const name = 'dsh-affinity'

/**
 * 依赖服务。
 *
 * `tools` + `systemPrompt` 是必需的；`llm` 故意**不**写进 inject——
 * inject 是硬等待，把一个可能不存在的服务写进去会让整个插件不加载。
 * 裁判在运行时用 `ctx.get("llm")` 探测，取不到就记一次 failed 判定。
 */
export const inject = ['tools', 'systemPrompt']

/** 工具名：模型可主动补判，但宿主已经判过，同轮会幂等返回。 */
export const TOOL_NAME = 'affinity_evaluate'

/** 存储目录名。 */
export const STORAGE_NAME = 'dsh-affinity'

/** 注入行刷新周期。 */
const REFRESH_MS = 30 * 1000

/**
 * 解析人格数据根。
 * @param {{dshHome?: string, person?: string, env?: NodeJS.ProcessEnv}} [options] - 覆盖项。
 * @returns {{dshHome: string, dataRoot: string}} 路径。
 */
export function resolveDataRoot (options = {}) {
  const env = options.env ?? process.env
  const home = options.dshHome
    ? path.resolve(options.dshHome)
    : (env?.DSH_HOME && env.DSH_HOME.trim() !== "" ? path.resolve(env.DSH_HOME) : path.join(os.homedir(), ".dsh"))
  const person = options.person ?? (env?.DSH_AFFINITY_PERSONA?.trim() || "default")
  // person 必须一起回传：下面既要算账本目录，又要去 cat-diary 的同一人格目录
  // 读判分模型选择。少这一个字段，两处就会各自写一遍 `?? "default"`，
  // 而「同一个事实有两个来源」正是这次查了一整晚的那类 bug。
  return { dshHome: home, person, dataRoot: path.join(home, "storages", STORAGE_NAME, person) }
}

/**
 * 工具描述。这段文字就是行为准则，模型没有别的地方能读到规则。
 * @param {{maxStep: number, maxDaily: number}} limits - 上限。
 * @returns {string} 描述。
 */
export function toolDescription (limits) {
  return [
    "对当前这一轮主人说的话做一次好感度判定（加分 / 扣分 / 不变）。",
    "宿主已经会在每轮开始时自动判一次；你只在本轮缺少判定时才需要调用，重复调用会返回同一结果不会重复计分。",
    "规则：delta 是 -" + limits.maxStep + " 到 +" + limits.maxStep + " 之间的整数；单日所有变化按绝对值累计不超过 " + limits.maxDaily + "。",
    "档位按强度给：+1 轻微正向、+2 明显正向，更大的档位只留给罕见的高强度事件——到了就给，不要为了保守压低。",
    "普通技术问题、指出 bug、提出反对意见、要求返工——都不是冒犯，不扣分。",
    "+1 适用于：被认真对待、被记住、认真授权你做事、给出关键约束或边界要求、认可你的工作成果、关心你的状态或成长。",
    "0 只用于纯信息交换、语气完全中性、或确实无法判断；不要把它当默认值。",
    "reason 写具体原因（主人做了什么），不要写「开心」这种空话。"
  ].join("\n")
}

/**
 * 工具参数：必须是完整 JSON Schema 对象（宿主只认 type/oneOf/properties/required 等子集）。
 * @param {{maxStep: number}} limits - 上限。
 * @returns {object} schema。
 */
/**
 * 由上限生成枚举值。-0 不存在，所以从 -cap 递增到 +cap。
 * @param {number} maxStep - 单次上限。
 * @returns {number[]} 枚举数组。
 */
function rangeArray (maxStep) {
  const cap = Math.abs(Number(maxStep) || 2)
  const out = []
  for (let v = -cap; v <= cap; v += 1) out.push(v)
  return out
}

export function toolParameters (limits) {
  return {
    type: "object",
    properties: {
      delta: {
        type: "integer",
        enum: rangeArray(limits.maxStep),
        description: "本轮好感度变化量，范围 -" + limits.maxStep + " ~ +" + limits.maxStep
      },
      reason: {
        type: "string",
        description: "具体原因：主人做了什么、为什么这样感受"
      }
    },
    required: ["delta", "reason"]
  }
}

/**
 * 从一轮消息里挑出真实用户输入。
 *
 * 系统注入（runtime context、AGENTS.md、skill 目录）同样是 `user/message`，
 * 一天能占四分之一字符。把它们当“主人说的话”判分，会让日记凭空长出对话。
 *
 * @param {object[]} messages - 本轮进入 step 的消息。
 * @returns {object|null} 最后一条真实用户消息。
 */
export function pickUserMessage (messages) {
  if (!Array.isArray(messages)) return null
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message || message.role !== "user") continue
    if (message.source?.kind !== "user") continue
    const text = (message.content ?? [])
      .filter((block) => block && block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n")
      .trim()
    if (text === "") continue
    return { id: message.id, text }
  }
  return null
}

/**
 * 注册插件。
 * @param {object} ctx - cordis 上下文。
 * @param {object} [config] - 配置。
 * @returns {void}
 */
export function apply (ctx, config = {}) {
  const maxStep = Number.isFinite(config.maxStep) ? Math.abs(config.maxStep) : DEFAULT_MAX_STEP
  const maxDaily = Number.isFinite(config.maxDaily) ? Math.abs(config.maxDaily) : DEFAULT_MAX_DAILY
  const cutoffHour = Number.isFinite(config.cutoffHour) ? config.cutoffHour : DEFAULT_CUTOFF_HOUR
  const enabled = config.enabled !== false

  let dataRoot
  let dshHome
  let person
  try {
    const resolved = resolveDataRoot({ dshHome: config.dshHome, person: config.person });
    dataRoot = resolved.dataRoot
    dshHome = resolved.dshHome
    person = resolved.person
  } catch (error) {
    ctx?.logger?.warn?.(`[affinity] disabled: cannot resolve data root — ${error?.message ?? error}`)
    return
  }

  if (!enabled) {
    ctx?.logger?.warn?.("[affinity] disabled by configuration")
    return
  }

  try {
    ensureInitialised(dataRoot)
  } catch (error) {
    ctx?.logger?.warn?.(`[affinity] initialisation failed — ${error?.message ?? error}`)
  }

  const paths = ledgerPaths(dataRoot)
  const cache = { line: "", builtAt: 0 }
  // 只有开了 diag 才写；平时完全不碰磁盘。
  const diag = config.diag === true
    ? createDiagnostics(path.join(dataRoot, "affinity", "diagnostic.json"))
    : { mark () {}, path: null }
  diag.mark("apply", {
    dshHome,
    dataRoot,
    // person 记进诊断：判分模型选择是按人格目录读的，人格错了就会静默
    // 退回"跟随会话"，而那个现象和"没设置过"一模一样。
    person,
    maxStep,
    maxDaily,
    cutoffHour,
    stepJudge: config.stepJudge !== false,
    hasOn: typeof ctx?.on === "function",
    pluginVersion: "v2"
  })

  /**
   * 重建注入行缓存。
   * @returns {string} 当前行。
   */
  const refresh = () => {
    try {
      const state = readLedger(dataRoot)
      const day = summaryForDay(dataRoot, diaryDayOf(Date.now(), cutoffHour))
      cache.line = renderLabelledLine({ score: state.score, net: day.net, used: day.used, maxDaily })
      cache.builtAt = Date.now()
      return cache.line
    } catch (error) {
      ctx?.logger?.warn?.(`[affinity] status refresh failed — ${error?.message ?? error}`)
      return cache.line
    }
  };
  refresh();

  /**
   * 把一次判定交给账本。
   * @param {{turnKey: string, delta: number, reason: string, sessionId?: string, turn?: number, inputRevision?: string, evidenceMessageId?: string}} request - 判定。
   * @returns {object} 账本结果。
   */
  const commit = (request) => {
    // 账本只认 requestedDelta。工具参数叫 delta，裁判结果叫 delta——都在这里归一。
    // 少了这一句，delta=2 会被当成 0 记成“已记 0”，是又一个静默失败。
    const normalized = {
      ...request,
      requestedDelta: request?.requestedDelta ?? request?.delta ?? 0
    }
    const outcome = judge(dataRoot, normalized, { maxStep, maxDaily, cutoffHour })
    refresh()
    return outcome
  };

  // ---- 每轮强制判定：挂在 agent/pre-step 的首步 ----------------------------
  //
  // 为什么是 pre-step 而不是提示词：模型会挑最短路径；为什么是首步而不是每步：
  // 一轮里会有多次工具调用，每次都是一个 step，按 step 判会一轮记好几次分。
  if (config.stepJudge !== false) {
    try {
      ctx.on("agent/pre-step", async (payload, next) => {
        diag.mark("pre-step", {
          turn: payload?.turn ?? null,
          step: payload?.step ?? null,
          messageCount: Array.isArray(payload?.messages) ? payload.messages.length : null,
          messageKinds: Array.isArray(payload?.messages)
            ? payload.messages.map((message) => message?.source?.kind ?? "(none)")
            : null
        })
        try {
          const step = Number(payload?.step ?? 0)
          if (step <= 1) {
            const user = pickUserMessage(payload?.messages)
            diag.mark("judge-candidate", { picked: user !== null, textLength: user?.text?.length ?? 0 })
            const turn = Number(payload?.turn ?? 0)
            const sessionId = String(payload?.agent?.id ?? "")
            if (user !== null && turn > 0) {
              const turnKey = sessionId + ":" + turn
              const known = readLedger(dataRoot).events
              const done = known.some((event) => event?.kind === "judge" && event.turnKey === turnKey)
              if (!done) {
                const state = readLedger(dataRoot)
                const day = summaryForDay(dataRoot, diaryDayOf(Date.now(), cutoffHour))
                // provider/model 不一定在 agent.options 上——实测这台机器的
                // request/header 里它们藏在 header.config 里，options 可能是空的。
                // 取不到就明确记失败，而不是抛一个被 catch 吞掉的异常。
                const agentOptions = payload?.agent?.options ?? {}
                let provider = agentOptions.provider
                let model = agentOptions.model
                if (!provider || !model) {
                  try {
                    const header = payload?.agent?.session?.requestHeader?.()
                    const config = header?.header?.config ?? header?.config ?? null
                    if (config) {
                      provider = provider ?? config.provider
                      model = model ?? config.model
                    }
                  } catch {
                    /* 读不到请求头就保持 undefined，下面会记失败 */
                  }
                }
                // 主人在面板上为「判分」单独选过模型时，**它优先于会话路由**。
                //
                // 为什么优先级要高于会话：会话路由是这轮对话本身用的模型，
                // 判分是一个独立的后台任务，两者的诉求不同（判分要快、要稳、
                // 要便宜）。而会话模型一旦指向没有 adapter 的渠道（buddy 那个
                // NO_ADAPTER），判分就会跟着一起静默停摆——那是实测踩过的坑。
                let source = provider && model ? "session" : "none"
                let reasoningEffort
                const chosen = readJudgeChoice(dshHome, person)
                if (chosen !== null) {
                  provider = chosen.provider
                  model = chosen.model
                  reasoningEffort = chosen.reasoningEffort
                  source = "stored"
                }
                diag.mark("judge-route", { provider: provider ?? null, model: model ?? null, source, reasoningEffort: reasoningEffort ?? null })
                const verdict = await runJudge(ctx, {
                  provider,
                  model,
                  reasoningEffort,
                  userText: user.text,
                  score: state.score,
                  used: day.used,
                  maxDaily,
                  maxStep,
                  signal: payload?.signal
                })
                diag.mark("judge-verdict", {
                  ok: verdict.ok,
                  delta: verdict.delta ?? null,
                  error: verdict.error ?? null,
                  // 记**实际用的**路由，不是会话的：这两者现在可能不同，
                  // 记错了下次排障就会去查一个根本不是它用的模型。
                  provider: provider ?? null,
                  model: model ?? null,
                  source
                })
                if (verdict.ok) {
                  const written = commit({
                    turnKey,
                    delta: verdict.delta,
                    reason: verdict.reason,
                    sessionId,
                    turn,
                    inputRevision: user.id,
                    evidenceMessageId: user.id,
                    judgeVersion: "judge-v1"
                  });
                  diag.mark("committed", {
                    ok: written.ok,
                    applied: written.appliedDelta ?? null,
                    score: written.score ?? null,
                    limitReason: written.limitReason ?? null,
                    code: written.code ?? null
                  });
                } else {
                  recordJudgeFailure(dataRoot, {
                    turnKey,
                    error: verdict.error,
                    sessionId,
                    turn
                  });
                  diag.mark("judge-failed-recorded", { error: verdict.error });
                }
              }
            }
          }
        } catch (error) {
          // 判定永不影响本轮对话：这里绝不 rethrow。
          // 但**必须留痕**——只写 logger 的 catch 会让“钩子跑了却失败”和
          // “钩子根本没跑”在外部表现得一模一样，这一整轮排查就是栽在这上面。
          const detail = {
            error: String(error?.message ?? error),
            stack: String(error?.stack ?? "").slice(0, 600)
          }
          diag.mark("judge-exception", detail)
          try {
            recordJudgeFailure(dataRoot, {
              turnKey: String(payload?.agent?.id ?? "") + ":" + Number(payload?.turn ?? 0),
              error: detail.error,
              sessionId: String(payload?.agent?.id ?? ""),
              turn: Number(payload?.turn ?? 0)
            })
          } catch {
            /* 连失败都记不上时只能放弃，绝不冒泡 */
          }
          ctx?.logger?.warn?.(`[affinity] step judge failed — ${detail.error}`)
        }
        return next()
      });
      diag.mark("pre-step-registered")
    } catch (error) {
      diag.mark("pre-step-register-failed", { error: String(error?.message ?? error) })
      ctx?.logger?.warn?.(`[affinity] pre-step hook registration failed — ${error?.message ?? error}`)
    }
  }

  // ---- 工具：模型可补判（同轮幂等） ---------------------------------------
  try {
    if (ctx?.tools?.register) {
      ctx.tools.register({
        name: TOOL_NAME,
        description: toolDescription({ maxStep, maxDaily }),
        parameters: toolParameters({ maxStep }),
        output: {
          schema: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
            content: { type: "string" }
            },
            required: ["ok", "content"]
          },
          render (_args, value) {
            return [{ type: "text", text: String(value?.content ?? "") }];
          }
        },
        async execute (args, exec) {
          try {
            const sessionId = String(exec?.agent?.id ?? "tool");
            const turnKey = sessionId + ":manual:" + Date.now();
            const outcome = commit({
              turnKey,
              delta: Number(args?.delta ?? 0),
              reason: String(args?.reason ?? ""),
              sessionId,
              judgeVersion: "tool-v1"
            });
            if (outcome.ok === false) {
              return { ok: false, content: `本次未记分：${outcome.reason}。当前 ${cache.line}` };
            }
            const sign = outcome.appliedDelta > 0 ? "+" : "";
            return {
              ok: true,
              content: `已记 ${sign}${outcome.appliedDelta}，当前 ${outcome.score}；今日已用 ${outcome.usedToday}/${maxDaily}，还能再用 ${outcome.remaining} 分。`
            };
          } catch (error) {
            return { ok: false, content: `记分失败：${error?.message ?? error}` };
          }
        }
      });
    }
  } catch (error) {
    ctx?.logger?.warn?.(`[affinity] tool registration failed — ${error?.message ?? error}`);
  }

  // ---- 动态上下文：当前分数 + 今日额度 ------------------------------------
  try {
    const order = ctx?.systemPrompt?.getContextOrder?.("AFFINITY");
    ctx?.systemPrompt?.context?.({
      name: "affinity-status",
      order: Number.isFinite(order) ? order : 135,
      // 每次组装都实时回读账本，不用 30 秒缓存——缓存会让注入行滞后于账本，
      // 模型照着旧数字说话就变成"手写值与账本不符"。读失败时才退回上次的缓存。
      text: () => {
        const line = refresh() || cache.line;
        if (!line) return "";
        return [
          `${line}；单次上限 ±${maxStep}。`,
          "⚠️ 好感度数值的唯一来源是本行（由账本实时渲染）。禁止在回复里手写、推测、估算或自行累加好感度数值，也不要在回复末尾自行追加「好感度：X → Y」这类文本——那会与账本不一致。需要展示当前好感度时，原样引用本行的数字。"
        ].join("\n");
      }
    });
  } catch (error) {
    ctx?.logger?.warn?.(`[affinity] context registration failed — ${error?.message ?? error}`);
  }

  // ---- 只读 HTTP 路由：供客户端面板读取 -----------------------------------
  try {
    registerRoutes(ctx, {
      eventsFile: paths.events,
      diaryRoot: path.join(dshHome, "storages", "dsh-cat-diary", config.person ?? "default"),
      maxDaily,
      cutoffHour
    });
  } catch (error) {
    ctx?.logger?.warn?.(`[affinity] route registration failed — ${error?.message ?? error}`);
  }

  try {
    const timer = setInterval(refresh, REFRESH_MS);
    timer.unref?.();
    ctx?.on?.("dispose", () => clearInterval(timer));
  } catch {
    /* 没有计时器也不会坏，只是行会变旧 */
  }

  // ---- 给其他插件（日记）的只读服务面 -------------------------------------
  try {
    ctx?.set?.("affinity", {
      get score () { return readLedger(dataRoot).score; },
      read: () => {
        const state = readLedger(dataRoot);
        const day = summaryForDay(dataRoot, diaryDayOf(Date.now(), cutoffHour));
        return { score: state.score, net: day.net, used: day.used, maxDaily };
      },
      summary: (day) => summaryForDay(dataRoot, day),
      line: () => cache.line
    });
  } catch {
    /* 服务槽可选 */
  }
}

export { judge, recordJudgeFailure, readLedger, summaryForDay, renderStatusLine, renderLabelledLine, INITIAL_SCORE, RULE_VERSION, DEFAULT_MAX_STEP, DEFAULT_MAX_DAILY }
