import { readEvents, deriveState, diaryDayOf, DEFAULT_CUTOFF_HOUR } from './ledger.js'

/**
 * 区间内的每日聚合（升序）。
 * @param {object[]} events - 账本事件。
 * @param {string[]} days - 升序日键列表。
 * @param {number} currentScore - 当前分数。
 * @returns {Array<object>} 每日数据。
 */
export function dailySeries (events, days, currentScore) {
  const first = days[0]
  // 逐日聚合：锚点单独记（它是当日起点），adjust 累加到 added/subtracted。
  //
  // 为什么锚点不能只当 adjust 看：锚点表示"分数被设成这个值"。
  // 只把 adjust 计入的话，锚点前后的差会被重复计算，画出比当前分还高的假值
  //（实测 84 > 77，曲线穿过未来）。
  const buckets = new Map()
  for (const event of events) {
    if (!event || typeof event !== 'object') continue
    if (event.kind === 'judge') continue
    if (typeof event.day !== 'string') continue
    const isAnchor = typeof event.value === 'number' || event.kind === 'init' || event.kind === 'anchor'
    const bucket = buckets.get(event.day) ?? { added: 0, subtracted: 0, anchor: null }
    if (isAnchor) {
      const target = Number(event.value)
      if (Number.isFinite(target)) bucket.anchor = target
      buckets.set(event.day, bucket)
      continue
    }
    const delta = Number(event.delta ?? 0)
    if (!Number.isFinite(delta) || delta === 0) continue
    if (delta > 0) bucket.added += delta
    else bucket.subtracted += delta
    buckets.set(event.day, bucket)
  }

  // 起点分 = 从当前分倒推回区间首日之前那一刻。
  //
  // 不能"遇到第一个 day >= 首日就 break"：账本按写入顺序追加，
  // 锚点和补写都会让日期乱序，提前 break 会漏掉后面的增量
  //（实测 10-26 显示成 77 而不是 70）。所以遍历全部，只看首日之前的。
  let start = currentScore
  for (const event of events) {
    if (!event || typeof event !== 'object') continue
    if (event.kind === 'judge') continue
    if (typeof event.day !== 'string') continue
    if (event.day >= first) continue
    const isAnchor = typeof event.value === 'number' || event.kind === 'init' || event.kind === 'anchor'
    if (isAnchor) {
      const target = Number(event.value)
      if (Number.isFinite(target)) start = target
      continue
    }
    const delta = Number(event.delta ?? 0)
    if (Number.isFinite(delta) && delta !== 0) start -= delta
  }

  let score = start
  const series = []
  for (const day of days) {
    const bucket = buckets.get(day) ?? { added: 0, subtracted: 0, anchor: null }
    const before = score
    // 锚点是**当日起点**，不是当日终值：先把它当作今天开始时的分数，
    // 再把今天的 adjust 加上去。当成终值处理会吞掉锚点当天的加减
    //（实测 init(50) 落在今天时，当天两笔 +2 全没了，曲线停在 50）。
    const base = (bucket.anchor !== null && bucket.anchor !== undefined)
      ? Number(bucket.anchor)
      : score
    score = base + bucket.added + bucket.subtracted
    series.push({
      day,
      net: score - before,
      used: Math.abs(bucket.added) + Math.abs(bucket.subtracted),
      added: bucket.added,
      subtracted: bucket.subtracted,
      closing: score
    })
  }
  return series
}

/**
 * 某一天内按事件顺序的阶梯点。
 * @param {object[]} events - 账本事件。
 * @param {string} day - 日键。
 * @returns {Array<object>} 阶梯点。
 */
export function stepSeries (events, day) {
  const points = []
  for (const event of events) {
    if (!event || event.kind !== 'adjust' || event.day !== day) continue
    points.push({
      at: Number(event.at ?? 0),
      from: Number(event.from ?? 0),
      to: Number(event.to ?? 0),
      delta: Number(event.delta ?? 0),
      reason: typeof event.reason === 'string' ? event.reason : ''
    })
  }
  return points
}

/**
 * 最近 N 次实际变化（非零）。
 * @param {object[]} events - 账本事件。
 * @param {number} limit - 条数。
 * @returns {object[]} 变化记录，旧的在前。
 */
export function recentChanges (events, limit) {
  const out = []
  for (let index = events.length - 1; index >= 0 && out.length < limit; index -= 1) {
    const event = events[index]
    if (!event || event.kind !== 'adjust') continue
    out.push({
      at: Number(event.at ?? 0),
      day: typeof event.day === 'string' ? event.day : '',
      from: Number(event.from ?? 0),
      to: Number(event.to ?? 0),
      delta: Number(event.delta ?? 0),
      reason: typeof event.reason === 'string' ? event.reason : ''
    })
  }
  return out.reverse()
}

/**
 * 最近 N 次判定（含 0 分与失败）。
 * @param {object[]} events - 账本事件。
 * @param {number} limit - 条数。
 * @returns {object[]} 判定记录，旧的在前。
 */
export function recentJudgements (events, limit) {
  const out = []
  for (let index = events.length - 1; index >= 0 && out.length < limit; index -= 1) {
    const event = events[index]
    if (!event || event.kind !== 'judge') continue
    out.push({
      at: Number(event.at ?? 0),
      day: typeof event.day === 'string' ? event.day : '',
      status: typeof event.status === 'string' ? event.status : 'committed',
      result: typeof event.result === 'string' ? event.result : 'unchanged',
      requestedDelta: typeof event.requestedDelta === 'number' ? event.requestedDelta : null,
      appliedDelta: typeof event.appliedDelta === 'number' ? event.appliedDelta : 0,
      before: typeof event.before === 'number' ? event.before : null,
      after: typeof event.after === 'number' ? event.after : null,
      limitReason: typeof event.limitReason === 'string' ? event.limitReason : null,
      reason: typeof event.reason === 'string' ? event.reason : ''
    })
  }
  return out.reverse()
}

/**
 * 生成近 N 天的日键列表（升序，含今天）。
 * @param {string} today - 今天日键。
 * @param {number} count - 天数。
 * @returns {string[]} 日键。
 */
export function lastDays (today, count) {
  const [year, month, day] = today.split('-').map(Number)
  const out = []
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const date = new Date(year, month - 1, day - offset)
    const pad = (value) => String(value).padStart(2, '0')
    out.push(date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()))
  }
  return out
}

/**
 * 组装概览面板所需的全部只读数据。
 * @param {object} options - eventsFile / now / maxDaily / cutoffHour。
 * @returns {object} 概览。
 */
export function buildOverview (options) {
  const maxDaily = options?.maxDaily ?? 10
  const cutoffHour = options?.cutoffHour ?? DEFAULT_CUTOFF_HOUR
  const events = readEvents(options?.eventsFile)
  const state = deriveState(events)
  const now = options?.now ?? Date.now()
  const today = diaryDayOf(now, cutoffHour)
  const yesterday = lastDays(today, 2)[0]
  const days7 = lastDays(today, 7)
  const days30 = lastDays(today, 30)
  const todayBucket = state.byDay.get(today) ?? { net: 0, used: 0, count: 0 }
  const yesterdayBucket = state.byDay.get(yesterday) ?? { net: 0, used: 0, count: 0 }

  return {
    score: state.score,
    today,
    yesterday,
    cutoffHour,
    maxDaily,
    todayNet: todayBucket.net,
    todayUsed: todayBucket.used,
    yesterdayNet: yesterdayBucket.net,
    yesterdayUsed: yesterdayBucket.used,
    remaining: Math.max(0, maxDaily - todayBucket.used),
    todaySteps: stepSeries(events, today),
    yesterdaySteps: stepSeries(events, yesterday),
    days7: dailySeries(events, days7, state.score),
    days30: dailySeries(events, days30, state.score),
    recentChanges: recentChanges(events, 10),
    recentJudgements: recentJudgements(events, 10),
    judgedTotal: state.judged,
    appliedTotal: state.applied,
    initialised: state.initialised
  }
}