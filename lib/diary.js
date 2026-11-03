/**
 * `dsh-cat-diary` — the four-section diary document.
 *
 * The body has exactly four sections and nothing else. A diary that quietly grows
 * 工作总结 / 待办 / 运行日志 sections stops being a diary and starts being a log
 * nobody rereads, so every section is validated before a file is accepted.
 *
 * @module dsh-cat-diary/diary
 */

import { readText, writeText, utf8Bytes, readJson, writeJson } from './store.js'
import { weekdayLabel } from './day.js'

/** The four required sections, in order. */
export const SECTIONS = Object.freeze([
  { key: 'knowledge', heading: '一、新学到的知识' },
  { key: 'thoughts', heading: '二、感想与认识' },
  { key: 'impression', heading: '三、我对主人的印象' },
  { key: 'affinity', heading: '四、好感度' }
])

/** Default byte budget for an injected brief. */
export const DEFAULT_BRIEF_BYTES = 6000

/** Marker used when a section genuinely has nothing to say. */
export const EMPTY_MARKER = '今日暂无新增'

/**
 * Paths used by the diary inside one persona's data root.
 * @param {string} dataRoot - persona data directory.
 * @param {string} day - diary day key.
 * @returns {{body: string, meta: string, brief: string}} absolute paths.
 */
export function diaryPaths (dataRoot, day) {
  return {
    body: `${dataRoot}/days/${day}.md`,
    meta: `${dataRoot}/days/${day}.meta.json`,
    brief: `${dataRoot}/briefs/${day}.md`
  }
}

/**
 * Render the document skeleton for one day.
 * @param {string} day - diary day key.
 * @returns {string} an empty but structurally valid diary.
 */
export function renderTemplate (day) {
  const lines = [`# ${day}（${weekdayLabel(day)}）`, '']
  for (const section of SECTIONS) {
    lines.push(`## ${section.heading}`, `- ${EMPTY_MARKER}`, '')
  }
  return lines.join('\n')
}

/**
 * Split a diary body into its four sections.
 *
 * @param {string} text - the markdown body.
 * @returns {{title: string, sections: Record<string, string>, unknown: string[]}} parsed parts.
 */
export function parseDiary (text) {
  const sections = {}
  const unknown = []
  let title = ''
  let currentKey = null
  const buffers = new Map()
  for (const line of String(text ?? '').split('\n')) {
    const heading = /^##\s+(.+?)\s*$/.exec(line)
    if (heading) {
      const found = SECTIONS.find((section) => heading[1].startsWith(section.heading) || heading[1] === section.heading)
      currentKey = found ? found.key : `__unknown${unknown.length}`
      if (!found) unknown.push(heading[1])
      buffers.set(currentKey, [])
      continue
    }
    if (/^#\s+/.test(line) && title === '') {
      title = line.replace(/^#\s+/, '').trim()
      continue
    }
    if (currentKey !== null) buffers.get(currentKey).push(line)
  }
  for (const section of SECTIONS) {
    sections[section.key] = (buffers.get(section.key) ?? []).join('\n').trim()
  }
  return { title, sections, unknown }
}

/**
 * Validate a diary body before it is allowed onto disk.
 *
 * Structure alone is not enough for the affinity section. Requiring only a "→"
 * is how a diary came to claim `日初 70 → 日终 74` while the ledger still said 70 —
 * it passed, because nothing compared the two. When a ledger summary is supplied,
 * every number in that section must be one the ledger actually produced.
 *
 * @param {string} text - the markdown body.
 * @param {{affinitySummary?: {score: number|null, opening?: number|null, closing?: number|null}}} [context] - cross-checks.
 * @returns {{ok: boolean, errors: string[], warnings: string[]}} verdict.
 */
export function validateDiary (text, context = {}) {
  const errors = []
  const warnings = []
  const { sections, unknown } = parseDiary(text)
  for (const section of SECTIONS) {
    if (sections[section.key] === undefined || sections[section.key] === '') {
      errors.push(`缺少小节：${section.heading}`)
    }
  }
  if (unknown.length > 0) {
    errors.push(`出现约定之外的小节：${unknown.join('、')}`)
  }
  const affinity = sections.affinity ?? ''
  // 箭头要求只作用于「真的有分数」的正文。
  // 账本为空时第四节写的是「今日无可核验的记录」，那是**合法状态**而不是
  // 格式错误；硬要求箭头会把一整篇合法日记判死（实测踩过）。
  const noRecord = affinity.includes('无可核验')
  if (affinity !== '' && !noRecord && !affinity.includes('→')) {
    errors.push('好感度小节缺少「日初 → 日终」的变化箭头')
  }
  const summary = context?.affinitySummary
  if (summary && affinity !== '') {
    // 只核对**那一条变化行**（`日初 X → 日终 Y（今日净 ±N，已用 U/M）`）。
    //
    // 原来是对整节做数字扫描，结果理由正文里出现任何数字都被当成分数声明：
    // 2026-11-01 的四条理由里有「第5问」「16 分额度」，整篇就被判成
    // 「16、5 与账本不一致」而写不进盘——校验器在用自己的产物杀自己。
    // 理由是人话，数字天然会出现在里面；只有变化行是结构化声明。
    const line = affinity.split('\n').find((item) => item.includes('日初') && item.includes('日终')) ?? ''
    const scores = new Set()
    if (typeof summary.score === 'number') scores.add(summary.score)
    if (typeof summary.opening === 'number') scores.add(summary.opening)
    if (typeof summary.closing === 'number') scores.add(summary.closing)
    const maxDaily = typeof summary.maxDaily === 'number' ? summary.maxDaily : 16
    const counters = new Set([0, 1, 2, maxDaily])
    if (typeof summary.net === 'number') counters.add(Math.abs(summary.net))
    if (typeof summary.used === 'number') {
      counters.add(summary.used)
      // 剩余额度是 maxDaily - used，不能写死 10（日上限早改成 16 了）
      counters.add(Math.abs(maxDaily - summary.used))
    }
    const claimed = (line.match(/\d{1,3}/g) ?? []).map(Number)
    const foreign = [...new Set(claimed.filter((value) => !scores.has(value) && !counters.has(value)))]
    if (foreign.length > 0) {
      errors.push(`好感度小节里的 ${foreign.join('、')} 与账本不一致（账本：当前 ${summary.score ?? '未知'}，日初 ${summary.opening ?? '未知'}，日终 ${summary.closing ?? '未知'}）`)
    }
  }
  const body = String(text ?? '')
  if (utf8Bytes(body) > 6000) warnings.push(`正文超过 6000 字节（${utf8Bytes(body)}）`)
  if (/^##\s*(运行日志|工作日志|待办|TODO)/m.test(body)) {
    errors.push('正文不得包含运行日志 / 待办类小节')
  }
  return { ok: errors.length === 0, errors, warnings }
}

/**
 * Read one day's diary.
 * @param {string} dataRoot - persona data directory.
 * @param {string} day - diary day key.
 * @returns {{exists: boolean, text: string|null, meta: object|null, bytes: number}} the document.
 */
export function readDiary (dataRoot, day) {
  const paths = diaryPaths(dataRoot, day)
  const text = readText(paths.body)
  return {
    exists: text !== null,
    text,
    meta: readJson(paths.meta, null),
    bytes: text === null ? 0 : utf8Bytes(text)
  }
}

/**
 * Write one day's diary, rejecting structurally invalid bodies.
 *
 * @param {string} dataRoot - persona data directory.
 * @param {string} day - diary day key.
 * @param {string} text - the markdown body.
 * @param {object} [meta] - machine metadata (coverage, sources, completeness).
 * @param {{force?: boolean}} [options] - `force` writes despite validation errors.
 * @returns {{ok: boolean, errors: string[], warnings: string[], path?: string}} outcome.
 */
export function writeDiary (dataRoot, day, text, meta = {}, options = {}) {
  // 交叉校验：第四节里的数字必须来自账本。
  // 只靠"有没有 → 箭头"这道结构检查，曾经放行过「日初 70 → 日终 74」——账本里根本没有那 4 分。
  const verdict = validateDiary(text, { affinitySummary: options.affinitySummary })
  if (!verdict.ok && options.force !== true) {
    return { ok: false, errors: verdict.errors, warnings: verdict.warnings }
  }
  const paths = diaryPaths(dataRoot, day)
  writeText(paths.body, text.endsWith('\n') ? text : `${text}\n`)
  writeJson(paths.meta, { day, ...meta, bytes: utf8Bytes(text), writtenAt: Date.now() })
  return { ok: true, errors: verdict.errors, warnings: verdict.warnings, path: paths.body }
}

/**
 * Compose a diary body from already-distilled section content.
 *
 * @param {string} day - diary day key.
 * @param {{knowledge?: string[], thoughts?: string[], impression?: string[], affinity?: string[]}} content - bullet text per section.
 * @returns {string} the markdown body.
 */
export function composeDiary (day, content = {}) {
  const lines = [`# ${day}（${weekdayLabel(day)}）`, '']
  for (const section of SECTIONS) {
    lines.push(`## ${section.heading}`)
    const bullets = Array.isArray(content[section.key]) ? content[section.key].filter((item) => String(item).trim() !== '') : []
    if (bullets.length === 0) lines.push(`- ${EMPTY_MARKER}`)
    else for (const bullet of bullets) lines.push(`- ${String(bullet).trim()}`)
    lines.push('')
  }
  return lines.join('\n')
}

/**
 * Per-section byte allowance for a brief, in source order.
 *
 * The affinity section gets a guaranteed floor no matter how much the knowledge
 * section wants, because "we are at 70 and I was happy to see you" is the part a
 * new session most needs, and truncating it away is the one failure that would
 * make the whole feature pointless.
 */
const BRIEF_SECTION_SHARE = Object.freeze({
  knowledge: 0.42,
  thoughts: 0.20,
  impression: 0.20,
  affinity: 0.18
})

/**
 * Render the brief shown to a new session: short, dated, and honest about gaps.
 *
 * The brief is capped in **bytes**, enforced in code rather than requested in a
 * prompt, because an oversized context is a hard failure, not a suggestion. Each
 * section is trimmed against its own share first, so one long section cannot
 * starve the others — an abridged card that still carries all four headings is
 * far more useful than a complete first section with the rest missing.
 *
 * @param {{day: string, text: string|null, affinity: string, stale?: boolean}} input - source material.
 * @param {number} [maxBytes] - byte budget (default 6000).
 * @returns {{brief: string, bytes: number, truncated: boolean, omitted: string[]}} the rendered card.
 */
export function renderBrief (input, maxBytes = 6000) {
  const { day, text, affinity, stale = false } = input
  const header = stale
    ? `【昨日速读】${day}（${weekdayLabel(day)}）· 该日日记待补写，以下为最近有效记录`
    : `【昨日速读】${day}（${weekdayLabel(day)}）`
  const parts = [header]
  if (affinity) parts.push(affinity)
  if (text === null) {
    parts.push('（该日没有日记。不要假装记得；主人问起时直接说没有记录。）')
    return { brief: parts.join('\n'), bytes: utf8Bytes(parts.join('\n')), truncated: false, omitted: [] }
  }

  const { sections } = parseDiary(text)
  const used = utf8Bytes(parts.join('\n'))
  const remaining = Math.max(0, maxBytes - used)
  const omitted = []
  let truncated = false

  for (const section of SECTIONS) {
    const body = (sections[section.key] ?? '').trim()
    if (body === '') continue
    const share = Math.floor(remaining * (BRIEF_SECTION_SHARE[section.key] ?? 0.2))
    let clipped = body
    if (utf8Bytes(clipped) > share) {
      while (utf8Bytes(clipped) > share && clipped.length > 0) {
        clipped = clipped.slice(0, Math.max(0, clipped.length - 40)).trimEnd()
      }
      clipped = `${clipped}…`
      truncated = true
    }
    if (clipped.replace('…', '').trim() === '') {
      omitted.push(section.heading)
      continue
    }
    parts.push(`· ${section.heading}\n${clipped}`)
  }

  // Final guard: the whole card must still fit, even if the math above drifted.
  let brief = parts.join('\n')
  while (utf8Bytes(brief) > maxBytes && brief.length > 0) {
    brief = `${brief.slice(0, Math.max(0, brief.length - 120)).trimEnd()}…`
    truncated = true
  }
  return { brief, bytes: utf8Bytes(brief), truncated, omitted }
}

/**
 * Extract the knowledge bullets from a diary body, for the rebuildable index.
 * @param {string} text - diary markdown.
 * @returns {string[]} knowledge bullets without the leading dash.
 */
export function knowledgeBullets (text) {
  const { sections } = parseDiary(text)
  const raw = sections.knowledge ?? ''
  return raw
    .split('\n')
    .map((line) => line.replace(/^\s*[-*]\s*/, '').trim())
    .filter((line) => line !== '' && line !== EMPTY_MARKER)
}

/**
 * 用账本生成的第四节替换正文里的第四节。
 *
 * 设计约束：模型只负责前三节的内容，第四节永远是**代码产物**。这样“日记说 74、账本说 70”
 * 这类分歧在结构上就不可能发生——不存在两个写入方。
 *
 * @param {string} text - 原正文。
 * @param {string[]} bullets - 账本生成的小节点。
 * @returns {string} 替换后的正文。
 */
export function replaceAffinitySection (text, bullets) {
  const lines = String(text ?? '').split('\n')
  const out = []
  let skipping = false
  let found = false
  const heading = SECTIONS[SECTIONS.length - 1].heading
  for (const line of lines) {
    const match = /^##\s+(.+?)\s*$/.exec(line)
    if (match) {
      skipping = match[1].startsWith(heading)
      if (skipping) {
        found = true
        out.push('## ' + heading)
        for (const bullet of Array.isArray(bullets) ? bullets : []) out.push('- ' + String(bullet).trim())
        out.push('')
        continue
      }
      out.push(line)
      continue
    }
    if (skipping) continue
    out.push(line)
  }
  // 正文里本来就没有第四节时**必须补上**。
  // 只替换不追加的话，模型只交前三节就会得到一篇缺第四节的正文，
  // 随后被 validateDiary 拒掉——实测踩过一次，而且它是静默的：
  // 表面上"生成成功"了，只是写盘失败。
  if (!found) {
    while (out.length > 0 && out[out.length - 1].trim() === '') out.pop()
    out.push('', '## ' + heading)
    for (const bullet of Array.isArray(bullets) ? bullets : []) out.push('- ' + String(bullet).trim())
    out.push('')
  }
  return out.join('\n')
}
