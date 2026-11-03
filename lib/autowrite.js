/**
 * `dsh-cat-diary` — 开机补写任务。
 *
 * 为什么不是「每天 23:59 或 05:00 定时跑」：
 * 05:00 换日意味着日记该在 05:00 之后生成，而那个点电脑通常是关着的，
 * 定时器根本不会响。所以改成**每次启动时补作业**——抓住「一天已经结束、
 * 但日记还没写」这个状态，写一次就够。
 *
 * 三条硬约束：
 *
 * 1. **幂等**。同一天无论重启多少次，最多写一篇。判断依据是磁盘上有没有
 *    `days/<day>.md`，不是内存状态——内存状态活不过重启。
 * 2. **只补不重写**。已存在的日记一律不碰：主人可能手动改过，重写等于覆盖。
 * 3. **失败不改状态、不重试到底**。生成失败就留一份 `.failed.json` 痕迹，
 *    下次启动再试。绝不因为写日记失败影响宿主启动。
 *
 * @module dsh-cat-diary/autowrite
 */

import fs from 'node:fs'
import path from 'node:path'

import { diaryDayOf, shiftDay, dayRange, weekdayLabel } from './day.js'
import { collectDay, readRaw } from './collect.js'
import { readDiary, writeDiary, diaryPaths, replaceAffinitySection, composeDiary, parseDiary } from './diary.js'
import { resolveDaySummary, renderAffinitySection } from './affinity-reader.js'
import { readJson, writeJson, ensureDir } from './store.js'

/** 一次补写最多往回追几天，避免首次启动扫出一大堆历史。 */
export const MAX_CATCHUP_DAYS = 7

/**
 * 单日日记生成的默认输出上限（tokens）。
 *
 * 原先硬编码 1600，实测不够：三节内容的长度随当天原料波动，内容一多模型
 * 话就长，`finish.reason.kind` 变成 `max-tokens`，整篇被判失败并留下
 * `days/<day>.failed.json`（历史受害者：2026-10-25、2026-10-31）。
 * 上调到 3200 给足余量，仍可由配置 `autoWriteMaxTokens` 覆盖。
 */
export const DEFAULT_MAX_TOKENS = 3200

/**
 * 送模型的原料字符上限。
 *
 * 原先硬编码 40000 字符。中文一字约 3 字节，40000 字符对模型而言偏长，
 * 容易诱发过长输出；压到 24000 既保住当天主线，又抑制啰嗦。
 * 可由配置 `autoWriteRawChars` 覆盖。
 */
export const DEFAULT_RAW_CHARS = 24000

/**
 * 找出「已经结束但还没有日记」的日子，从旧到新。
 *
 * `today` 是当前日记日；它的前一天才是「刚结束」的那天。
 * 往回最多看 {@link MAX_CATCHUP_DAYS} 天——首次启用时不要把半个月前的
 * 历史一次性全生成出来，那既花钱又没有意义。
 *
 * @param {string} dataRoot - 人格数据目录。
 * @param {string} today - 当前日记日 key。
 * @param {{maxDays?: number}} [options] - 追溯上限。
 * @returns {string[]} 待补的日 key，旧的在前。
 */
export function pendingDays (dataRoot, today, options = {}) {
  const maxDays = options.maxDays ?? MAX_CATCHUP_DAYS
  // `includeCurrent` 处理一个很实际的场景：
  //
  // 换日点是 05:00，所以凌晨 1 点打开 DSH 时「今天」还是昨天。
  // 如果只看今天之前的，那么主人昨晚聊了一整晚、凌晨来开机，
  // 待补列表会跳过他真正关心的那一天，去补一周前的空档——看起来像坏了。
  //
  // 所以允许把当前日记日也纳入候选，是否真的能写由 dayClosed() 再判一次：
  // 05:00 之前它还没结束，自然会被跳过；05:00 之后它才成为候选。
  const out = []
  const from = options.includeCurrent === true ? 0 : 1
  for (let offset = from; offset <= maxDays; offset += 1) {
    const day = shiftDay(today, -offset)
    const { exists } = readDiary(dataRoot, day)
    if (!exists) out.push(day)
  }
  // 日期由近到远收集，反过来就是旧的在前，保证补写按时间顺序。
  return out.reverse()
}

/**
 * 一天是否已经结束（可以写日记了）。
 *
 * 用 dayRange 的 end 判断，而不是比较日期字符串：这样 DST 切换和
 * 换日小时改动都自动跟着走。
 *
 * @param {string} day - 日 key。
 * @param {number} now - 当前时刻。
 * @param {number} cutoffHour - 换日小时。
 * @returns {boolean} 是否已结束。
 */
export function dayClosed (day, now, cutoffHour) {
  try {
    return now >= dayRange(day, cutoffHour).end
  } catch {
    return false
  }
}

/**
 * 把 llm `finish` 事件的 reason 压成一行可读文本。
 *
 * dsh 的 reason 形状不稳定（不同 provider 塞不同的键：error / message /
 * detail / code），这里按优先级捞，捞不到就退化成 JSON 片段——总之不能像
 * 原先那样只留一个 `kind`，让人对着 `error` 三个字无从下手。
 *
 * @param {object} reason - `finish` 事件的 reason。
 * @returns {string} 可读细节，可能为空串。
 */
function describeFinishReason (reason) {
  if (!reason || typeof reason !== 'object') return ''
  const err = reason.error ?? reason.cause ?? null
  const candidates = [
    typeof err === 'string' ? err : err?.message,
    reason.message,
    reason.detail,
    reason.code
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
  }
  try {
    const json = JSON.stringify(reason)
    return json && json !== '{}' ? json.slice(0, 300) : ''
  } catch {
    return ''
  }
}

/**
 * 把原料交给模型，请它写前三节。
 *
 * 第四节（好感度）**不让模型写**——它由账本生成后拼上去，模型只负责
 * 知识、感想、印象这三段。这是「唯一写入方」原则在日记上的体现。
 *
 * @param {object} ctx - 宿主上下文（需要 llm）。
 * @param {{day: string, raw: string, provider: string, model: string, maxTokens?: number, rawChars?: number, signal?: AbortSignal}} input - 输入。
 *   `maxTokens` 缺省取 {@link DEFAULT_MAX_TOKENS}，`rawChars` 缺省取 {@link DEFAULT_RAW_CHARS}。
 * @returns {Promise<{ok: true, text: string}|{ok: false, error: string}>} 结果。
 */
export async function composeWithModel (ctx, input) {
  let llm = null
  try {
    llm = ctx?.get ? ctx.get('llm') : ctx?.llm
  } catch (error) {
    return { ok: false, error: '宿主不允许访问 llm：' + (error?.message ?? error) }
  }
  if (!llm || typeof llm.stream !== 'function') return { ok: false, error: '宿主没有 llm 服务' }
  if (!input?.provider || !input?.model) return { ok: false, error: '缺少 provider 或 model' }

  const system = [
    '你在为主人和一只猫娘整理当天日记。输入是当天的对话原料。',
    '只输出 Markdown，包含且只包含三个二级标题，顺序固定：',
    '## 一、新学到的知识',
    '## 二、感想与认识',
    '## 三、我对主人的印象',
    '每节用「- 」开头的短句，每节 2~5 条。',
    '不要写标题行（# 开头），不要写「四、好感度」，不要写任何前言后语。',
    '只写原料里真实发生过的事，不要编造。原料空就写「今日暂无新增」。'
  ].join('\n')

  // 输出上限与输入字符上限改为可配置：原先写死 1600 / 40000，前者会在
  // 内容较多的日子被截断（finish=max-tokens）导致整篇失败，后者让模型
  // 面对过长的中文原料而更容易写出长文。两者都可从 cordis 配置覆盖。
  const rawChars = Number.isFinite(input?.rawChars) ? input.rawChars : DEFAULT_RAW_CHARS
  const maxTokens = Number.isFinite(input?.maxTokens) ? input.maxTokens : DEFAULT_MAX_TOKENS

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 90000)
  const onAbort = () => controller.abort()
  input.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    let text = ''
    const stream = llm.stream({
      provider: input.provider,
      model: input.model,
      // 思考等级只在主人于面板上显式选过时下发。留空则交给适配器默认值——
      // 擅自补一个 high 会让某些模型直接拒收（buddy 渠道实测就认死自己的枚举）。
      ...(typeof input.reasoningEffort === 'string' && input.reasoningEffort !== ''
        ? { reasoningEffort: input.reasoningEffort }
        : {}),
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: input.raw.slice(0, rawChars) }] }],
      temperature: 0.7,
      maxTokens,
      signal: controller.signal
    })
    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta') text += chunk.text
      else if (chunk?.type === 'finish' && chunk.reason && chunk.reason.kind !== 'stop') {
        if (chunk.reason.kind === 'aborted') return { ok: false, error: '生成被中止' }
        // 把 reason 里的细节一并带出来。原先只留 kind，于是 provider 侧的真实
        // 报错（限流 / 额度 / 上游错误）在 failed.json 里只剩一个 `error` 字样，
        // 等于没有线索——排查时被迫从零猜起。
        const detail = describeFinishReason(chunk.reason)
        return { ok: false, error: '生成未正常结束：' + chunk.reason.kind + (detail ? '（' + detail + '）' : '') }
      }
    }
    if (String(text).trim() === '') return { ok: false, error: '模型输出为空' }
    return { ok: true, text }
  } catch (error) {
    return { ok: false, error: '生成失败：' + (error?.message ?? error) }
  } finally {
    clearTimeout(timer)
    input.signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * 补写一天。
 *
 * @param {object} ctx - 宿主上下文。
 * @param {{
 *   dataRoot: string, dshHome: string, day: string, person: string,
 *   cutoffHour: number, provider: string, model: string,
 *   maxTokens?: number, rawChars?: number,
 *   maxDaily: number, signal?: AbortSignal
 * }} options - 参数。
 * @returns {Promise<object>} 结果。
 */
export async function writeOneDay (ctx, options) {
  const { dataRoot, dshHome, day, person, cutoffHour } = options
  const existing = readDiary(dataRoot, day)
  // 幂等的第一道闸：已有正文就什么都不做。
  if (existing.exists) return { ok: true, skipped: 'already-written', day }

  let raw = readRaw(dataRoot, day)
  if (raw === null) {
    const collected = collectDay({ dshHome, dataRoot, day, cutoffHour, write: true })
    if (collected.empty) {
      return { ok: true, skipped: 'no-material', day }
    }
    raw = collected.text
  }

  const verdict = await composeWithModel(ctx, {
    day,
    raw,
    provider: options.provider,
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    maxTokens: options.maxTokens,
    rawChars: options.rawChars,
    signal: options.signal
  })
  if (verdict.ok === false) {
    // 失败留痕：下次启动要能看出这天试过、也失败过。
    try {
      // 带上**当时用的路由**：这次排障就是因为 failed.json 里只有一句
      // 「生成未正常结束：error（no adapter registered for provider "buddy"）」，
      // 却看不出是谁选了这个渠道。以后面板上换了模型再失败，一眼就能对上。
      writeJson(path.join(dataRoot, 'days', day + '.failed.json'), {
        day,
        error: verdict.error,
        route: {
          provider: options.provider,
          model: options.model,
          ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {})
        },
        at: Date.now()
      })
    } catch { /* 记录失败也不能影响启动 */ }
    return { ok: false, day, error: verdict.error }
  }

  // 拼装正文：标题行 + 模型写的前三节 + 代码生成的第四节。

  // 这里不能用 composeDiary(day, {}) 打底——那会先塞进四个「今日暂无新增」，
  // 再把模型输出接在后面，同一节就出现了两次。直接拼更干净。
  const summary = resolveDaySummary(null, { dshHome, person }, day)
  const affinityBullets = renderAffinitySection(summary, options.maxDaily ?? 16)
  const heading = `# ${day}（${weekdayLabel(day)}）`
  const body = replaceAffinitySection(
    heading + '\n\n' + String(verdict.text).trim() + '\n',
    affinityBullets
  )

  const written = writeDiary(dataRoot, day, body, { source: 'auto', mode: 'startup' }, {
    // maxDaily 必须一起传：校验器要用它算「剩余额度」这个合法数，
    // 拿不到就会退回硬编码的 16，与真实的 16 撞车纯属巧合。
    affinitySummary: { ...summary, maxDaily: options.maxDaily ?? 16 }
  })
  if (written.ok === false) {
    try {
      writeJson(path.join(dataRoot, 'days', day + '.failed.json'), {
        day, error: written.errors.join('；'), at: Date.now()
      })
    } catch { /* ignore */ }
    return { ok: false, day, error: written.errors.join('；') }
  }
  // 成功后清掉失败痕迹
  try {
    const failed = path.join(dataRoot, 'days', day + '.failed.json')
    if (fs.existsSync(failed)) fs.unlinkSync(failed)
  } catch { /* ignore */ }
  return { ok: true, day, path: written.path, bytes: body.length }
}

/**
 * 启动时补写所有欠下的日记。
 *
 * 全程 try/catch：补写失败绝不影响宿主启动，这是本模块最重要的性质。
 *
 * @param {object} ctx - 宿主上下文。
 * @param {{
 *   dataRoot: string, dshHome: string, person: string, cutoffHour: number,
 *   provider?: string, model?: string, maxDaily?: number, maxDays?: number,
 *   now?: number, signal?: AbortSignal
 * }} options - 参数。
 * @returns {Promise<{day: string, taken: string[], results: object[]}>} 结果。
 */
export async function catchUp (ctx, options) {
  const now = options.now ?? Date.now()
  const cutoffHour = options.cutoffHour ?? 5
  const today = diaryDayOf(now, cutoffHour)
  // includeCurrent：凌晨开机时「今天」还是昨天，主人真正想补的正是它。
  // 但 05:00 之前它并未结束，下面的 dayClosed 会把它挡掉——
  // 所以这里放宽候选范围是安全的，不会写出半天的日记。
  const taken = pendingDays(options.dataRoot, today, {
    maxDays: options.maxDays,
    includeCurrent: options.includeCurrent === true
  })
  if (taken.length === 0) return { today, taken, results: [] }

  // 路由来源按可靠性排序：
  // 1. 配置里显式指定的 provider/model；
  // 2. 宿主的 defaultModel 服务（启动时还没有任何会话，这是唯一干净来源）；
  // 3. 放弃补写——绝不去猜一个模型来烧钱。
  const route = resolveRoute(ctx, options)
  if (route.ok === false) {
    return {
      today,
      taken,
      results: taken.map((day) => ({ ok: false, day, error: route.error }))
    }
  }

  const results = []
  for (const day of taken) {
    if (!dayClosed(day, now, cutoffHour)) continue
    try {
      results.push(await writeOneDay(ctx, { ...options, ...route, day }))
    } catch (error) {
      results.push({ ok: false, day, error: String(error?.message ?? error) })
    }
  }
  return { today, taken, results }
}

/**
 * 确定调用哪个模型。
 *
 * 为什么需要这一层：补写发生在启动后几秒，那时还没有任何会话，拿不到
 * `agent.options`。宿主的 defaultModel 服务是此刻唯一可靠的来源。
 *
 * @param {object} ctx - 宿主上下文。
 * @param {{provider?: string, model?: string}} options - 显式配置。
 * @returns {{ok: true, provider: string, model: string}|{ok: false, error: string}} 路由。
 */
export function resolveRoute (ctx, options) {
  // options.provider/model 是**调用方已经合并过的最终值**（存储文件优先，
  // 其次配置，最后宿主默认）。这里只做存在性判断，不再自己决定优先级——
  // 优先级分散在两处就一定会漂。
  if (options?.provider && options?.model) {
    return {
      ok: true,
      provider: options.provider,
      model: options.model,
      ...(typeof options.reasoningEffort === 'string' && options.reasoningEffort !== ''
        ? { reasoningEffort: options.reasoningEffort }
        : {})
    }
  }
  // 服务名是 agentDefaultModel，读法是 currentSelection()。
  // 不能猜成 defaultModel/read()——那样会静默拿不到路由，补写永远不执行。
  let service = null
  try {
    service = ctx?.get ? ctx.get('agentDefaultModel') : ctx?.agentDefaultModel
  } catch {
    service = null
  }
  try {
    const current = service && typeof service.currentSelection === 'function'
      ? service.currentSelection()
      : null
    if (current && current.provider && current.model) {
      return { ok: true, provider: current.provider, model: current.model }
    }
  } catch {
    service = null
  }
  return { ok: false, error: '拿不到默认模型路由，本次不补写（不猜模型）' }
}