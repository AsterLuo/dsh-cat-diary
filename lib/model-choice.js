/**
 * `dsh-cat-diary` — 日记生成所用模型的选择（持久化）。
 *
 * 为什么单独一个文件、而不是写进 `cordis.patch.yml`：
 *
 * 1. profile 配置是 YAML，改它要解析 + 回写整棵树，任何一次写坏都会让宿主
 *    起不来；而日记的模型选择只是一条业务偏好，没有资格拥有那种破坏力。
 * 2. 插件升级会整包覆盖 `lib/`，但不会碰 `storages/`，所以放在人格数据目录
 *    里的选择能活过升级；写在配置里的反而会被"重新写一份默认值"冲掉。
 * 3. 读取顺序天然可解释：**存储文件 > 配置 > 宿主默认模型**。前者是主人在
 *    面板上亲手点的，后者是部署时的兜底。
 *
 * @module dsh-cat-diary/model-choice
 */

import fs from 'node:fs'
import path from 'node:path'

import { readJson, writeJson, ensureDir } from './store.js'

/** 存储文件名（人格数据目录下）。 */
export const CHOICE_FILE = 'autoWriteRoute.json'

/**
 * 用途 id。
 *
 * 一个存储文件里放多份选择，而不是每个用途一个文件：
 * 它们在语义上是「同一张设置页里的两个下拉」，拆成两个文件会出现
 * 「删了一个、另一个还在、界面显示半套」这种没法解释的状态。
 *
 * - `diary`：补写日记时调用哪个模型（主人在面板上弹出的选择器）；
 * - `judge`：判好感时调用哪个模型（同上，另开一页）。
 */
export const PURPOSES = Object.freeze(['diary', 'judge'])

/**
 * 校验并归一一个用途 id。
 * @param {unknown} value - 候选。
 * @returns {'diary'|'judge'} 用途。
 */
export function normalizePurpose (value) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text === 'judge' ? 'judge' : 'diary'
}

/**
 * 选择文件的绝对路径。
 * @param {string} dataRoot - 人格数据目录。
 * @returns {string} 路径。
 */
export function choiceFile (dataRoot) {
  return path.join(dataRoot, CHOICE_FILE)
}

/**
 * 把任意输入规整成合法的路由对象。
 *
 * 这里做的是**白名单化**而不是补默认值：provider/model 必须是非空字符串，
 * reasoningEffort 只能是非空字符串或干脆没有。任何一项不合格就返回 null，
 * 让上层退回配置值，而不是拿一个半成品去调模型。
 *
 * @param {unknown} value - 候选值。
 * @returns {{provider: string, model: string, reasoningEffort?: string, savedAt: number}|null} 规整结果。
 */
export function normalizeChoice (value) {
  if (!value || typeof value !== 'object') return null
  const provider = typeof value.provider === 'string' ? value.provider.trim() : ''
  const model = typeof value.model === 'string' ? value.model.trim() : ''
  if (provider === '' || model === '') return null
  const effort = typeof value.reasoningEffort === 'string' ? value.reasoningEffort.trim() : ''
  return {
    provider,
    model,
    ...(effort === '' ? {} : { reasoningEffort: effort }),
    savedAt: Number.isFinite(Number(value.savedAt)) ? Number(value.savedAt) : 0
  }
}

/**
 * 读整个存储文件，并把旧格式升级成新格式。
 *
 * 旧版（2026-11-02 之前）的文件是**扁平的一条**：`{provider, model, …}`，
 * 只服务日记。新格式是 `{diary: {...}, judge: {...}}`。这里直接认旧的、
 * 回写时换成新的——不做「检测到旧版就报错让人手工迁」那种事，
 * 主人的设置在升级之后必须继续有效。
 *
 * @param {string} dataRoot - 人格数据目录。
 * @returns {{diary: object|null, judge: object|null}} 每用途的原始条目。
 */
function readRaw (dataRoot) {
  const stored = readJson(choiceFile(dataRoot), null)
  if (!stored || typeof stored !== 'object') return { diary: null, judge: null }
  // 旧格式：顶层直接就是 provider/model
  if (typeof stored.provider === 'string' || typeof stored.model === 'string') {
    return { diary: stored, judge: null }
  }
  return {
    diary: stored.diary ?? null,
    judge: stored.judge ?? null
  }
}

/**
 * 读取某个用途在面板上选定的模型。
 * @param {string} dataRoot - 人格数据目录。
 * @param {'diary'|'judge'} [purpose] - 用途，默认日记。
 * @returns {{provider: string, model: string, reasoningEffort?: string, savedAt: number}|null} 结果，未设置时 null。
 */
export function readChoice (dataRoot, purpose = 'diary') {
  try {
    return normalizeChoice(readRaw(dataRoot)[normalizePurpose(purpose)])
  } catch {
    return null
  }
}

/**
 * 写入某个用途的选择（原子、无 BOM）。
 *
 * 只覆盖目标用途，另一用途原样保留：判分和日记是两个独立决定，
 * 改一个不该悄悄把另一个改回默认——那是很难自证的隐性行为。
 *
 * @param {string} dataRoot - 人格数据目录。
 * @param {{provider: string, model: string, reasoningEffort?: string}} choice - 选择。
 * @param {'diary'|'judge'} [purpose] - 用途，默认日记。
 * @returns {{provider: string, model: string, reasoningEffort?: string, savedAt: number}} 落盘值。
 */
export function writeChoice (dataRoot, choice, purpose = 'diary') {
  const normalized = normalizeChoice({ ...choice, savedAt: Date.now() })
  if (normalized === null) throw new Error('provider 与 model 都必须是非空字符串')
  const raw = readRaw(dataRoot)
  ensureDir(dataRoot)
  writeJson(choiceFile(dataRoot), {
    ...(raw.diary === null ? {} : { diary: raw.diary }),
    ...(raw.judge === null ? {} : { judge: raw.judge }),
    [normalizePurpose(purpose)]: normalized
  })
  return normalized
}

/**
 * 清掉某个用途的选择，回到「跟随宿主默认模型」。
 * @param {string} dataRoot - 人格数据目录。
 * @param {'diary'|'judge'} [purpose] - 用途，默认日记。
 * @returns {boolean} 是否真的改动过文件。
 */
export function clearChoice (dataRoot, purpose = 'diary') {
  const target = normalizePurpose(purpose)
  const raw = readRaw(dataRoot)
  const rest = {
    ...(raw.diary === null || target === 'diary' ? {} : { diary: raw.diary }),
    ...(raw.judge === null || target === 'judge' ? {} : { judge: raw.judge })
  }
  const hasOther = Object.keys(rest).length > 0
  try {
    if (!hasOther) {
      fs.unlinkSync(choiceFile(dataRoot))
      return true
    }
    writeJson(choiceFile(dataRoot), rest)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}
