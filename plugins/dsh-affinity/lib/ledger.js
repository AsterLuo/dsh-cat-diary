/**
 * `dsh-affinity` — 事件账本：唯一权威分数来源。
 *
 * 设计约束（按重要性排序）：
 *
 * 1. **唯一写入方**。任何其他组件都不能直接写分：日记、速读卡、长期记忆、UI 全是读者。
 * 2. **追加式**。分数由事件重放得出，从不存成可变的权威数字；两个会话各自的
 *    “读 58 加 2 写 60” 会丢一次，而两个会话各追加一条事件不会。
 * 3. **日额度按绝对值累计**。`Σ|Δ| ≤ maxDaily`，不是 `|ΣΔ|`。净值和上限可以被
 *    “+2 −2 +2 −2 …” 洗掉，绝对值上限不会。
 * 4. **初始化只发生一次**。全新关系从 50 开始，但“从 50 开始”绝不能变成“每次会话重置成 50”。
 * 5. **判定记录与分数变化是两类事件**。每轮判定都会留下一条 `judge` 记录（可能 appliedDelta=0），
 *    而只有 appliedDelta≠0 时才写 `adjust`。这样“判定成功但没变”“额度用完”“判定失败”
 *    三种情况在账本里可以分辨，而分数曲线只由 `adjust` 决定。
 *
 * @module dsh-affinity/ledger
 */

import fs from 'node:fs'
import path from 'node:path'

/** 可表示的最小分数。 */
export const MIN_SCORE = -100

/** 可表示的最大分数。 */
export const MAX_SCORE = 100

/** 全新关系的初始分，只写一次，之后永不重新推导。 */
export const INITIAL_SCORE = 50

/** 单次最大调整量（任一方向）。 */
export const DEFAULT_MAX_STEP = 2

/** 每个日记日的最大移动总量，按绝对值求和。 */
export const DEFAULT_MAX_DAILY = 10

/** 日记日切换小时；与日记插件保持一致。 */
export const DEFAULT_CUTOFF_HOUR = 5

/** 规则版本；写进每条判定事件，便于历史审计。 */
export const RULE_VERSION = 2

/**
 * 把分数夹到可表示区间。
 * @param {number} value - 原始值。
 * @returns {number} 落在 {@link MIN_SCORE}..{@link MAX_SCORE} 内的整数。
 */
export function clampScore (value) {
  return Math.max(MIN_SCORE, Math.min(MAX_SCORE, Math.round(value)))
}

/**
 * 两位数补零。
 * @param {number} value - 数字。
 * @returns {string} 补零文本。
 */
function pad (value) {
  return String(value).padStart(2, '0')
}

/**
 * 某个时刻属于哪个日记日（尊重换日小时）。
 * @param {number|Date} instant - 毫秒时间戳或 Date。
 * @param {number} [cutoffHour] - 日记日起始小时。
 * @returns {string} `YYYY-MM-DD`。
 */
export function diaryDayOf (instant, cutoffHour = DEFAULT_CUTOFF_HOUR) {
  const date = instant instanceof Date ? new Date(instant.getTime()) : new Date(instant)
  if (Number.isNaN(date.getTime())) throw new TypeError('diaryDayOf received an invalid instant')
  if (date.getHours() < cutoffHour) date.setDate(date.getDate() - 1)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * 账本在某个数据根下的路径。
 * @param {string} dataRoot - 人格数据目录。
 * @returns {{dir: string, events: string, state: string, lock: string}} 绝对路径。
 */
export function ledgerPaths (dataRoot) {
  const dir = path.join(dataRoot, 'affinity')
  return {
    dir,
    events: path.join(dir, 'events.jsonl'),
    state: path.join(dir, 'state.json'),
    lock: path.join(dir, '.write.lock')
  }
}

/**
 * 读取全部事件，跳过无法解析的行。
 * @param {string} file - 事件文件路径。
 * @returns {object[]} 按写入顺序排列的事件。
 */
export function readEvents (file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const events = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      events.push(JSON.parse(trimmed))
    } catch {
      /* 跳过损坏行，保住其余历史 */
    }
  }
  return events
}

/**
 * 把事件重放成当前分数与每日统计。
 *
 * @param {object[]} events - 按写入顺序排列的事件。
 * @returns {{
 *   score: number,
 *   byDay: Map<string, {net: number, used: number, count: number}>,
 *   anchors: number,
 *   applied: number,
 *   judged: number,
 *   initialised: boolean
 * }} 派生态。
 */
export function deriveState (events) {
  let score = null
  const byDay = new Map()
  let anchors = 0
  let applied = 0
  let judged = 0

  /**
   * 记一次移动。
   * @param {string|undefined} day - 日键。
   * @param {number} delta - 带符号变化。
   * @returns {void}
   */
  const touch = (day, delta) => {
    if (typeof day !== 'string' || day === '') return
    const bucket = byDay.get(day) ?? { net: 0, used: 0, count: 0 }
    bucket.net += delta
    bucket.used += Math.abs(delta)
    bucket.count += 1
    byDay.set(day, bucket)
  }

  for (const event of events) {
    if (!event || typeof event !== 'object') continue

    if (event.kind === 'judge') {
      judged++
      continue
    }

    if (typeof event.value === 'number' || event.kind === 'init' || event.kind === 'anchor') {
      const target = clampScore(typeof event.value === 'number' ? event.value : INITIAL_SCORE)
      const before = score
      score = target
      anchors++
      if (before !== null && before !== target) touch(event.day, target - before)
      continue
    }

    const delta = Number(event.delta ?? 0)
    if (!Number.isFinite(delta) || delta === 0) continue
    const current = score ?? INITIAL_SCORE
    const next = clampScore(current + delta)
    const actual = next - current
    score = next
    applied++
    touch(event.day, actual)
  }

  return {
    score: score ?? INITIAL_SCORE,
    byDay,
    anchors,
    applied,
    judged,
    initialised: anchors > 0
  }
}

/**
 * 追加一行 JSONL，创建目录。
 * @param {string} file - 目标文件。
 * @param {unknown} value - 记录。
 * @returns {void}
 */
function appendLine (file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, { encoding: 'utf8' })
}

/**
 * 写派生状态缓存（非权威）。人打开数据目录时能直接看到数字，但以 events.jsonl 为准。
 * @param {string} file - state.json 路径。
 * @param {{score: number, day: string}} info - 待记录内容。
 * @returns {void}
 */
function writeStateCache (file, info) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    `${JSON.stringify({ score: info.score, day: info.day, derived: true, note: '派生的便利缓存；以 events.jsonl 为准，手改无效', updatedAt: Date.now() }, null, 2)}\n`,
    { encoding: 'utf8' }
  )
}

/**
 * 简单的跨进程互斥：O_EXCL 建锁文件。
 *
 * 追加文件本身不是并发安全的：“读额度 → 检查 → 追加”之间存在竞争窗口，
 * 两个进程可能同时判定“还剩 2 分”。这里用独占创建把整段提交串行化，
 * 并在超时后清理疑似陈旧锁（进程崩溃留下的）。
 *
 * @template T
 * @param {string} lockFile - 锁文件路径。
 * @param {number} [timeoutMs] - 等待上限。
 * @param {() => T} body - 临界区。
 * @returns {T} 临界区返回值。
 */
export function withLedgerLock (lockFile, timeoutMs, body) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true })
  const deadline = Date.now() + (timeoutMs ?? 3000)
  let fd = null
  while (fd === null) {
    try {
      fd = fs.openSync(lockFile, 'wx')
      fs.writeSync(fd, String(process.pid))
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      // 陈旧锁：持有者进程已不在，或锁文件过老。
      try {
        const stat = fs.statSync(lockFile)
        if (Date.now() - stat.mtimeMs > 10000) {
          fs.unlinkSync(lockFile)
          continue
        }
      } catch {
        continue
      }
      if (Date.now() > deadline) throw new Error(`账本被占用，等待超时：${lockFile}`)
      const until = Date.now() + 15
      while (Date.now() < until) { /* 短暂自旋，避免引入异步依赖 */ }
    }
  }
  try {
    return body()
  } finally {
    try { if (fd !== null) fs.closeSync(fd) } catch { /* ignore */ }
    try { fs.unlinkSync(lockFile) } catch { /* ignore */ }
  }
}

/**
 * 确保账本恰好初始化一次。
 * @param {string} dataRoot - 人格数据目录。
 * @param {{at?: number, day?: string}} [options] - 时钟覆盖。
 * @returns {{initialised: boolean, score: number}} 是否写入了 init 事件。
 */
export function ensureInitialised (dataRoot, options = {}) {
  const paths = ledgerPaths(dataRoot)
  const events = readEvents(paths.events)
  const state = deriveState(events)
  if (state.initialised) return { initialised: false, score: state.score }
  const at = options.at ?? Date.now()
  const day = options.day ?? diaryDayOf(at)
  appendLine(paths.events, {
    id: `init-${day}`,
    kind: 'init',
    at,
    day,
    value: INITIAL_SCORE,
    reason: '账本首次建立，初始值 50（只初始化一次，之后跨会话连续）'
  })
  writeStateCache(paths.state, { score: INITIAL_SCORE, day })
  return { initialised: true, score: INITIAL_SCORE }
}

/**
 * 在一次判定里提交结果。
 *
 * 顺序固定：幂等键 → 参数合法性 → 单次上限 → 日额度 → 分数边界 → 落账。
 * 无论是否真正改分，都会写一条 `judge` 判定记录（失败除外，失败另记）。
 *
 * @param {string} dataRoot - 人格数据目录。
 * @param {{
 *   turnKey: string,
 *   requestedDelta: number,
 *   reason?: string,
 *   evidenceMessageId?: string,
 *   sessionId?: string,
 *   turn?: number,
 *   inputRevision?: string,
 *   judgeVersion?: string,
 *   at?: number,
 *   day?: string
 * }} request - 一次判定。
 * @param {{maxStep?: number, maxDaily?: number, cutoffHour?: number}} [limits] - 上限。
 * @returns {object} 判定结果。
 */
export function judge (dataRoot, request, limits = {}) {
  const maxStep = limits.maxStep ?? DEFAULT_MAX_STEP
  const maxDaily = limits.maxDaily ?? DEFAULT_MAX_DAILY
  const cutoffHour = limits.cutoffHour ?? DEFAULT_CUTOFF_HOUR
  const paths = ledgerPaths(dataRoot)

  ensureInitialised(dataRoot, request)

  return withLedgerLock(paths.lock, 5000, () => {
    const events = readEvents(paths.events)
    const state = deriveState(events)
    const turnKey = typeof request?.turnKey === 'string' ? request.turnKey.trim() : ''
    if (turnKey === '') {
      return { ok: false, code: 'missing-turn-key', reason: '缺少轮次身份，拒绝记分', state }
    }

    const existing = events.find((event) => event?.kind === 'judge' && event.turnKey === turnKey)
    if (existing) {
      const dayKey = existing.day ?? diaryDayOf(request.at ?? Date.now(), cutoffHour)
      const used = state.byDay.get(dayKey)?.used ?? 0
      return {
        ok: true,
        duplicate: true,
        score: state.score,
        requestedDelta: existing.requestedDelta ?? 0,
        appliedDelta: existing.appliedDelta ?? 0,
        usedToday: used,
        remaining: Math.max(0, maxDaily - used),
        judge: existing,
        state
      }
    }

    const at = request.at ?? Date.now()
    const day = typeof request.day === 'string' && request.day !== '' ? request.day : diaryDayOf(at, cutoffHour)
    const raw = Number(request?.requestedDelta ?? 0)
    if (!Number.isFinite(raw)) {
      return { ok: false, code: 'bad-delta', reason: 'requestedDelta 必须是有限数字', state }
    }
    if (!Number.isInteger(raw)) {
      return { ok: false, code: 'bad-delta', reason: `requestedDelta 必须是整数，收到 ${raw}`, state }
    }
    if (Math.abs(raw) > maxStep) {
      return { ok: false, code: 'step-too-large', reason: `单次最多 ±${maxStep}，收到 ${raw}`, state }
    }

    const bucket = state.byDay.get(day) ?? { net: 0, used: 0, count: 0 }
    const from = state.score
    let applied = raw
    let limitReason = null

    if (raw !== 0 && bucket.used + Math.abs(raw) > maxDaily) {
      // 截断到剩余额度，而不是直接拒绝：建议 +2、只剩 1 点时记 +1。
      const room = Math.max(0, maxDaily - bucket.used)
      const sign = raw > 0 ? 1 : -1
      applied = sign * Math.min(Math.abs(raw), room)
      limitReason = applied === 0 ? 'daily-cap' : 'daily-cap-truncated'
    }

    const to = clampScore(from + applied)
    if (applied !== 0 && to === from) {
      applied = 0
      limitReason = 'score-bound'
    }

    const actual = to - from
    const judgeEvent = {
      id: `judge-${at}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'judge',
      turnKey,
      at,
      day,
      requestedDelta: raw,
      appliedDelta: actual,
      before: from,
      after: to,
      result: actual > 0 ? 'increase' : actual < 0 ? 'decrease' : 'unchanged',
      limitReason,
      reason: typeof request.reason === 'string' ? request.reason.slice(0, 200) : '',
      evidenceMessageId: typeof request.evidenceMessageId === 'string' ? request.evidenceMessageId.slice(0, 120) : '',
      sessionId: typeof request.sessionId === 'string' ? request.sessionId.slice(0, 120) : '',
      turn: Number.isFinite(request.turn) ? request.turn : null,
      inputRevision: typeof request.inputRevision === 'string' ? request.inputRevision.slice(0, 80) : '',
      ruleVersion: RULE_VERSION,
      judgeVersion: typeof request.judgeVersion === 'string' ? request.judgeVersion.slice(0, 80) : ''
    }
    appendLine(paths.events, judgeEvent)

    if (actual !== 0) {
      appendLine(paths.events, {
        id: `adj-${at}-${Math.abs(actual)}`,
        kind: 'adjust',
        turnKey,
        at,
        day,
        delta: actual,
        from,
        to,
        reason: judgeEvent.reason,
        source: 'judge'
      })
    }

    const after = deriveState(readEvents(paths.events))
    const usedToday = after.byDay.get(day)?.used ?? 0
    writeStateCache(paths.state, { score: after.score, day })
    return {
      ok: true,
      score: after.score,
      requestedDelta: raw,
      appliedDelta: actual,
      usedToday,
      remaining: Math.max(0, maxDaily - usedToday),
      limitReason,
      judge: judgeEvent,
      state: after
    }
  })
}

/**
 * 记录一次判定失败。失败不改分，但必须留下痕迹，不能伪装成“不变”。
 * @param {string} dataRoot - 人格数据目录。
 * @param {{turnKey: string, error?: string, at?: number, day?: string, sessionId?: string, turn?: number}} request - 失败信息。
 * @returns {object} 记录结果。
 */
export function recordJudgeFailure (dataRoot, request) {
  const paths = ledgerPaths(dataRoot)
  ensureInitialised(dataRoot, request)
  return withLedgerLock(paths.lock, 5000, () => {
    const events = readEvents(paths.events)
    const state = deriveState(events)
    const turnKey = typeof request?.turnKey === 'string' ? request.turnKey.trim() : ''
    if (turnKey === '') return { ok: false, code: 'missing-turn-key', state }
    if (events.some((event) => event?.kind === 'judge' && event.turnKey === turnKey)) {
      return { ok: true, duplicate: true, state }
    }
    const at = request.at ?? Date.now()
    const day = typeof request.day === 'string' && request.day !== '' ? request.day : diaryDayOf(at)
    const event = {
      id: `judge-failed-${at}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'judge',
      status: 'failed',
      turnKey,
      at,
      day,
      requestedDelta: null,
      appliedDelta: 0,
      before: state.score,
      after: state.score,
      result: 'failed',
      reason: typeof request.error === 'string' ? request.error.slice(0, 200) : '判定失败',
      sessionId: typeof request.sessionId === 'string' ? request.sessionId.slice(0, 120) : '',
      turn: Number.isFinite(request.turn) ? request.turn : null,
      ruleVersion: RULE_VERSION
    }
    appendLine(paths.events, event)
    return { ok: true, state, judge: event }
  })
}

/**
 * 读当前状态而不额外触碰磁盘。
 * @param {string} dataRoot - 人格数据目录。
 * @returns {{score: number, byDay: Map, events: object[], initialised: boolean}} 状态。
 */
export function readLedger (dataRoot) {
  const paths = ledgerPaths(dataRoot)
  const events = readEvents(paths.events)
  const state = deriveState(events)
  return { ...state, events }
}

/**
 * 供日记插件消费的单日摘要（契约上只读）。
 * @param {string} dataRoot - 人格数据目录。
 * @param {string} day - 日记日键。
 * @returns {{score: number, day: string, net: number, used: number, count: number, opening: number|null, closing: number|null, reasons: string[]}} 摘要。
 */
export function summaryForDay (dataRoot, day) {
  const paths = ledgerPaths(dataRoot)
  const events = readEvents(paths.events)
  const state = deriveState(events)

  const dayEvents = events.filter((event) => event?.day === day && event.kind === 'adjust')
  const reasons = dayEvents.map((event) => event.reason).filter((text) => typeof text === 'string' && text !== '')
  const net = state.byDay.get(day)?.net ?? 0
  const used = state.byDay.get(day)?.used ?? 0

  let opening = null
  let closing = null
  if (dayEvents.length > 0) {
    opening = dayEvents[0].from
    closing = dayEvents[dayEvents.length - 1].to
  }

  return { score: state.score, day, net, used, count: dayEvents.length, opening, closing, reasons }
}

/**
 * 渲染一行状态。
 * @param {{score: number, net?: number, used?: number, remaining?: number, maxDaily?: number}} info - 数字。
 * @returns {string} 例如 `72（今日 +2，已用 2/10）`。
 */
export function renderStatusLine (info) {
  const parts = [String(info.score)]
  if (typeof info.net === 'number' && info.net !== 0) parts.push(`今日 ${info.net > 0 ? '+' : ''}${info.net}`)
  else if (typeof info.net === 'number') parts.push('今日无变化')
  if (typeof info.used === 'number' && typeof info.maxDaily === 'number') {
    parts.push(`已用 ${info.used}/${info.maxDaily}`)
  }
  return parts.join('，')
}

/**
 * 渲染带标签的状态行。
 * @param {{score: number, net?: number, used?: number, maxDaily?: number}} info - 数字。
 * @returns {string} 例如 `好感度 72，今日 +2，已用 2/10`。
 */
export function renderLabelledLine (info) {
  return `好感度 ${renderStatusLine(info)}`
}
