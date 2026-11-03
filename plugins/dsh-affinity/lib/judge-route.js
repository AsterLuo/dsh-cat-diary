/**
 * `dsh-affinity` — 判分所用的模型选择（只读）。
 *
 * 这份选择由 **dsh-cat-diary 的面板**写入，文件就在 cat-diary 的人格目录里：
 *
 *   <dshHome>/storages/dsh-cat-diary/<person>/autoWriteRoute.json
 *      { "diary": {...}, "judge": {"provider","model","reasoningEffort"?} }
 *
 * 为什么让 affinity 去读另一个插件的文件，而不是自己存一份：
 *
 * 1. 这是**同一张设置页上的两个下拉**。分成两处存，删了一个另一个还在，
 *    界面就会显示半套，而"半套"没法解释也没法回滚。
 * 2. affinity 只读不写，所以不构成第二个写入方；账本的唯一写入方契约不受影响。
 * 3. 文件不存在（没装 cat-diary / 没选过）就是 null，调用方退回会话路由——
 *    静默失败在这里是可接受的，因为**兜底就是主人的当前模型**，不是一个坏值。
 *
 * ⚠️ 这是一条跨包约定：改存储格式时两边必须同时改。
 *    `dsh-cat-diary/lib/model-choice.js` 是格式的真源。
 *
 * @module dsh-affinity/judge-route
 */

import fs from 'node:fs'
import path from 'node:path'

/** cat-diary 的存储目录名。 */
const DIARY_STORAGE = 'dsh-cat-diary'

/** 选择文件名。 */
const CHOICE_FILE = 'autoWriteRoute.json'

/**
 * 读 cat-diary 的人格数据目录下的选择文件。
 * @param {string} dshHome - DSH home。
 * @param {string} person - 人格 id（与 cat-diary 的 config.person 一致）。
 * @returns {object|null} 解析后的对象，读不到时 null。
 */
function readRaw (dshHome, person) {
  if (typeof dshHome !== 'string' || dshHome === '') return null
  if (typeof person !== 'string' || person === '') return null
  const file = path.join(dshHome, 'storages', DIARY_STORAGE, person, CHOICE_FILE)
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
  // Node 的 readFileSync 不剥 BOM；别的工具（PowerShell 5.1）可能写进一个。
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  try {
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    // 文件被写坏时**不要删它**：那是主人的设置，坏了也不该由读取方动手。
    return null
  }
}

/**
 * 读主人为判分选定的模型。
 *
 * @param {string} dshHome - DSH home。
 * @param {string} person - 人格 id。
 * @returns {{provider: string, model: string, reasoningEffort?: string}|null} 选择，未设置时 null。
 */
export function readJudgeChoice (dshHome, person) {
  const raw = readRaw(dshHome, person)
  if (raw === null) return null
  // 兼容旧格式：扁平文件只服务日记，不能当判分选择用。
  const entry = raw.judge
  if (!entry || typeof entry !== 'object') return null
  const provider = typeof entry.provider === 'string' ? entry.provider.trim() : ''
  const model = typeof entry.model === 'string' ? entry.model.trim() : ''
  if (provider === '' || model === '') return null
  const effort = typeof entry.reasoningEffort === 'string' ? entry.reasoningEffort.trim() : ''
  return {
    provider,
    model,
    ...(effort === '' ? {} : { reasoningEffort: effort })
  }
}
