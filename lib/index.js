/**
 * `dsh-cat-diary` — host half.
 *
 * Design rule for this plugin: **it must be impossible for this file to stop DSH
 * from booting.** Everything that touches disk or time runs inside `try/catch`,
 * the timer is unref'd, and the dynamic context provider is synchronous and
 * memory-only. If anything here throws, the session loses the diary card and
 * nothing else.
 *
 * @module dsh-cat-diary
 */

import fs from 'node:fs'
import path from 'node:path'

import { resolvePaths } from './paths.js'
import { diaryDayOf, shiftDay, recentDays, isDayKey } from './day.js'
import { collectDay } from './collect.js'
import { readDiary, renderBrief, diaryPaths } from './diary.js'
import { resolveDaySummary, renderAffinityHeader } from './affinity-reader.js'
import { catchUp, resolveRoute } from './autowrite.js'
import { readChoice } from './model-choice.js'
import { registerModelRoutes } from './model-route.js'
import { readText, writeText, ensureDir, listByExtension } from './store.js'

/** Cordis plugin name. */
export const name = 'cat-diary'

/**
 * Services to wait for before `apply` runs.
 *
 * Cordis expects a **plain array** here (`inject = ['tools']`), not the
 * `{ required, optional }` object shape — that object is silently accepted by
 * the loader and then never gates anything, so `ctx.systemPrompt` is simply
 * `undefined` at apply time and the plugin contributes nothing while looking
 * perfectly healthy.
 *
 * Every service read inside `apply` must be listed: cordis throws
 * `cannot get property "x" without inject` at access time, and because the
 * registration sits in a try/catch that becomes a log line and a silently dead
 * feature.
 *
 * `affinity` is deliberately **NOT** listed. `inject` is a hard wait: naming a
 * service that is never provided means `apply` never runs at all, so the diary
 * would vanish entirely whenever the affinity plugin is missing or failed —
 * measured, not theorised. The diary must survive that, because the whole point
 * of this split is that the score is optional while the diary is not.
 *
 * Instead `ctx.affinity` is probed at use time and the on-disk ledger is the
 * fallback.
 */
export const inject = ['systemPrompt']

/**
 * 把「存储文件 → 配置 → 宿主默认」三段合并成一次补写用的路由。
 *
 * 为什么优先级是反的（存储优先于配置）：面板上的选择是主人**刚刚亲手点的**，
 * 而 cordis.patch.yml 里的 autoWriteRoute 是部署时的静态兜底。让静态值压过
 * 实时选择，等于面板点了不生效——那正是这次要修的那类"以为改了其实没改"。
 *
 * @param {object} ctx - 宿主上下文。
 * @param {{provider?: string, model?: string}} configRoute - 配置里的兜底路由。
 * @param {string} dataRoot - 人格数据目录。
 * @returns {{provider: string, model: string, reasoningEffort?: string, source: string}|null} 最终路由。
 */
export function resolveAutoWriteRoute (ctx, configRoute, dataRoot) {
  let stored = null
  try {
    stored = readChoice(dataRoot)
  } catch {
    stored = null
  }
  if (stored) {
    return {
      provider: stored.provider,
      model: stored.model,
      ...(stored.reasoningEffort === undefined ? {} : { reasoningEffort: stored.reasoningEffort }),
      source: 'stored'
    }
  }
  if (configRoute?.provider && configRoute?.model) {
    return {
      provider: configRoute.provider,
      model: configRoute.model,
      ...(configRoute.reasoningEffort ? { reasoningEffort: configRoute.reasoningEffort } : {}),
      source: 'config'
    }
  }
  const live = resolveRoute(ctx, {})
  if (live.ok) return { provider: live.provider, model: live.model, source: 'host' }
  return null
}

/** Default hint cadence in milliseconds (30 minutes). */
const DEFAULT_TICK_MS = 30 * 60 * 1000

/** Byte budget for the injected card. */
const DEFAULT_BRIEF_BYTES = 6000

/**
 * Read the newest available brief for "yesterday", falling back to older days.
 *
 * A missing yesterday must never be silently replaced by a random older entry:
 * the returned card always carries its own date and a staleness marker.
 *
 * @param {string} dataRoot - persona data directory.
 * @param {string} today - today's diary day key.
 * @param {{briefBytes?: number}} [options] - budget.
 * @returns {{text: string, day: string, stale: boolean}|null} the card, or null when nothing exists.
 */
export function buildBriefFor (dataRoot, today, options = {}) {
  const budget = options.briefBytes ?? DEFAULT_BRIEF_BYTES
  const yesterday = shiftDay(today, -1)
  // The score is read through the affinity authority, never recomputed here.
  // `paths` lets the CLI fall back to the on-disk ledger when no host is running.
  const paths = options.paths ?? { dshHome: '', person: 'default' }
  const maxDaily = options.maxDaily ?? 16
  const summaryFor = (day) => resolveDaySummary(options.affinityService ?? null, paths, day)
  const headerFor = (day) => renderAffinityHeader(summaryFor(day), maxDaily)

  const candidates = [yesterday, ...recentDays(yesterday, 7).reverse().filter((day) => day !== yesterday)]
  for (const [index, day] of candidates.entries()) {
    const diary = readDiary(dataRoot, day)
    if (!diary.exists) continue
    const { brief } = renderBrief({ day, text: diary.text, affinity: headerFor(day), stale: index > 0 }, budget)
    return { text: brief, day, stale: index > 0 }
  }
  // Nothing on disk yet: still report the real state instead of staying silent.
  const { brief } = renderBrief({ day: yesterday, text: null, affinity: headerFor(yesterday) }, budget)
  return { text: brief, day: yesterday, stale: true }
}

/**
 * Register the plugin.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - cordis context.
 * @param {object} config - projected configuration.
 * @returns {void}
 */
export function apply (ctx, config = {}) {
  let paths
  try {
    paths = resolvePaths({ dshHome: config.dshHome, person: config.person })
  } catch (error) {
    ctx?.logger?.warn?.(`[cat-diary] disabled: cannot resolve paths — ${error?.message ?? error}`)
    return
  }

  const state = { brief: null, builtAt: 0, day: null }
  const briefBytes = config.briefBytes ?? DEFAULT_BRIEF_BYTES

  /**
   * Rebuild the cached card. Never throws: a failure keeps the previous card.
   * @returns {void}
   */
  const refresh = () => {
    try {
      const today = diaryDayOf(Date.now(), config.cutoffHour ?? 5)
      // Probe the live service defensively: cordis throws when a service is read
      // without being declared in `inject`, and that throw must not take the
      // refresh down with it.
      let affinityService = null
      try {
        affinityService = ctx?.affinity ?? null
      } catch {
        affinityService = null
      }
      const card = buildBriefFor(paths.dataRoot, today, {
        briefBytes,
        // Read the score through whatever authority exists: the live service when
        // mounted, else the on-disk ledger. Never recompute a score locally.
        affinityService,
        // 用 paths.person（已在 resolvePaths 里解析过），不要再写一遍
        // `config.person ?? 'default'`——那正是账本读不到的根因。
        paths: { dshHome: paths.dshHome, person: paths.person },
        maxDaily: config.maxDaily ?? 16
      })
      state.brief = card?.text ?? null
      state.day = card?.day ?? null
      state.builtAt = Date.now()
    } catch (error) {
      ctx?.logger?.warn?.(`[cat-diary] brief refresh failed — ${error?.message ?? error}`)
    }
  }

  refresh()

  // Dynamic context: strictly synchronous and memory-only. Reading the disk here
  // would put file I/O in the request path of every single turn.
  //
  // The field is `text`, NOT `render`. `PromptContext` is
  // `{ name, order, text: string | ((ctx) => string) }`. Using `render` is
  // silently ignored by the host — nothing throws, the plugin just contributes an
  // empty string forever, so it looks loaded while doing nothing. That cost one
  // full debugging cycle; the shape is pinned by a test now.
  //
  // The order must avoid the host's reserved slots (SANDBOX_POLICY 110,
  // APPROVAL_POLICY 115, SUBAGENT_DELEGATION 120) so the diary never displaces
  // policy context.
  const contextOrder = ctx?.systemPrompt?.getContextOrder?.('CAT_DIARY')
  try {
    ctx?.systemPrompt?.context?.({
      name: 'cat-diary-brief',
      order: Number.isFinite(contextOrder) ? contextOrder : 130,
      text: () => {
        if (!state.brief) return ''
        return `${state.brief}\n`
      }
    })
  } catch (error) {
    ctx?.logger?.warn?.(`[cat-diary] context registration failed — ${error?.message ?? error}`)
  }

  // A periodic refresh keeps a long-running DSH from serving a card from last week.
  try {
    const timer = setInterval(refresh, config.tickMs ?? DEFAULT_TICK_MS)
    timer.unref?.()
    ctx?.on?.('dispose', () => clearInterval(timer))
  } catch (error) {
    ctx?.logger?.warn?.(`[cat-diary] timer setup failed — ${error?.message ?? error}`)
  }

  // ---- 模型选择路由：面板上的「设置」用它实时拉目录、保存选择 -------------
  try {
    registerModelRoutes(ctx, {
      dataRoot: paths.dataRoot,
      fallback: (purpose) => {
        if (purpose === 'judge') {
          // 判分的兜底是**当前会话所用的模型**，而会话路由只有 affinity 插件
          // 在 pre-step 里才看得到（它在 payload 里）。cat-diary 这一侧没有
          // 会话上下文，硬凑一个默认模型就又是原来那个 buddy 老坑。
          // 所以这里只声明来源，不给具体值——界面显示「跟随当前会话」，
          // 真正的解析发生在判分那一刻。
          return { source: 'session' }
        }
        const configured = config.autoWriteRoute ?? {}
        if (configured.provider && configured.model) {
          return {
            provider: configured.provider,
            model: configured.model,
            ...(configured.reasoningEffort ? { reasoningEffort: configured.reasoningEffort } : {}),
            source: 'config'
          }
        }
        const live = resolveRoute(ctx, {})
        return live.ok
          ? { provider: live.provider, model: live.model, source: 'host' }
          : { source: 'none' }
      }
    })
  } catch (error) {
    ctx?.logger?.warn?.('[cat-diary] model route registration failed — ' + String(error?.message ?? error))
  }

  // ---- 启动补写：每天第一次打开时，把欠下的日记补上 ----------------------
  //
  // 为什么是启动时而不是定时：日记日按 05:00 换日，5 点人通常在睡觉、
  // 电脑是关的，定时器根本不会响。改成"开机看一眼有没有欠账"更符合实际。
  //
  // 三个必须的性质：
  // 1. 延迟几秒再跑——宿主刚起来时服务和模型都还没就绪；
  // 2. 全程 try/catch，绝不因为写日记失败影响启动；
  // 3. 写不写由磁盘状态决定，不由内存状态决定，所以重启多少次都只写一次。
  if (config.autoWrite !== false) {
    try {
      const delay = Number.isFinite(config.autoWriteDelayMs) ? config.autoWriteDelayMs : 8000
      const timer = setTimeout(async () => {
        try {
          // 路由在这里合并：存储文件（面板点选） > 配置兜底 > 宿主默认模型。
          const route = resolveAutoWriteRoute(ctx, config.autoWriteRoute ?? {}, paths.dataRoot)
          if (route === null) {
            // 拿不到任何路由就明确留痕，而不是静默跳过——
            // "今天没写日记"和"根本没找到模型来写"在外部看起来一样。
            ctx?.logger?.warn?.('[cat-diary] 没有可用的模型路由，本次不补写')
            return
          }
          const result = await catchUp(ctx, {
            dataRoot: paths.dataRoot,
            dshHome: paths.dshHome,
            person: paths.person,
            cutoffHour: config.cutoffHour ?? 5,
            provider: route.provider,
            model: route.model,
            reasoningEffort: route.reasoningEffort,
            maxDaily: config.maxDaily ?? 16,
            maxDays: Number.isFinite(config.autoWriteMaxDays) ? config.autoWriteMaxDays : undefined,
            // 生成预算可配置：undefined 时沿用 autowrite.js 里的默认值。
            // 放在配置层是为了以后调参只改 cordis.patch.yml，不必再动代码
            // （插件升级会整包覆盖 lib/，写死在代码里的调参会丢）。
            maxTokens: Number.isFinite(config.autoWriteMaxTokens) ? config.autoWriteMaxTokens : undefined,
            rawChars: Number.isFinite(config.autoWriteRawChars) ? config.autoWriteRawChars : undefined,
            // 凌晨开机时「今天」还是昨天，那是主人最想补的一天；
            // 它有没有结束由 dayClosed 判断，这里只放宽候选。
            includeCurrent: true
          })
          const wrote = result.results.filter((item) => item.ok && !item.skipped)
          if (wrote.length > 0) {
            ctx?.logger?.info?.(`[cat-diary] 已补写 ${wrote.map((item) => item.day).join('、')}`)
            // 补完之后刷新速读卡，否则上下文里还是旧的
            refresh()
          }
        } catch (error) {
          // 补写失败只是少一篇日记，绝不影响宿主
          ctx?.logger?.warn?.(`[cat-diary] 启动补写失败 — ${error?.message ?? error}`)
        }
      }, delay)
      timer.unref?.()
      ctx?.on?.('dispose', () => clearTimeout(timer))
    } catch (error) {
      ctx?.logger?.warn?.(`[cat-diary] 补写任务设置失败 — ${error?.message ?? error}`)
    }
  }

  // Expose a read-only snapshot for the CLI/tests.
  try {
    ctx?.set?.('catDiary', {
      get brief () {
        return state.brief
      },
      get day () {
        return state.day
      },
      refresh,
      paths
    })
  } catch {
    /* the service slot is optional */
  }
}

/**
 * Generate raw material for a day, isolated from any host process.
 *
 * @param {{dshHome?: string, dataRoot?: string, day: string, budget?: number, person?: string}} options - options.
 * @returns {ReturnType<typeof collectDay>} collection result.
 */
export function collect (options) {
  const resolved = resolvePaths({ dshHome: options.dshHome, person: options.person })
  const dataRoot = options.dataRoot ?? resolved.dataRoot
  return collectDay({ dshHome: resolved.dshHome, dataRoot, day: options.day, budget: options.budget })
}

export {
  resolvePaths,
  diaryDayOf,
  shiftDay,
  recentDays,
  isDayKey,
  readDiary,
  renderBrief,
  diaryPaths,
  resolveDaySummary,
  renderAffinityHeader,
  readText,
  writeText,
  ensureDir,
  listByExtension,
  path,
  fs
}