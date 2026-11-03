/**
 * `dsh-cat-diary` — where a diary lives.
 *
 * All paths are derived at runtime; no drive letter and no hard-coded separator
 * appears anywhere, so the package keeps working on another machine or after the
 * DSH home moves.
 *
 * @module dsh-cat-diary/paths
 */

import os from 'node:os'
import path from 'node:path'

import { resolveDshHome } from './sessions.js'

/** Storage folder name under `<dshHome>/storages`. */
export const STORAGE_NAME = 'dsh-cat-diary'

/**
 * The identity whose diary this is.
 *
 * Today the environment runs one persona, so the value is a stable constant; the
 * parameter exists so that a second persona gets a separate ledger instead of
 * mixing two bonds into one score.
 *
 * @param {NodeJS.ProcessEnv} [env] - environment.
 * @returns {string} a filesystem-safe persona id.
 */
export function resolvePersonaId (env = process.env) {
  const explicit = env?.DSH_CAT_DIARY_PERSONA
  if (explicit && explicit.trim() !== '') return explicit.trim().replace(/[^\w.-]+/g, '_')
  return 'default'
}

/**
 * Resolve every directory the plugin uses.
 *
 * @param {{dshHome?: string, person?: string, env?: NodeJS.ProcessEnv}} [options] - overrides.
 * @returns {{dshHome: string, person: string, storageRoot: string, dataRoot: string, sessionsRoot: string}} resolved paths.
 */
export function resolvePaths (options = {}) {
  const env = options.env ?? process.env
  const dshHome = options.dshHome ? path.resolve(options.dshHome) : resolveDshHome(env, path.join(os.homedir(), '.dsh'))
  const storageRoot = path.join(dshHome, 'storages', STORAGE_NAME)
  // person 必须**解析一次、原样返回**。
  //
  // 原来 dataRoot 用 env 兜底（resolvePersonaId），而调用方读好感度时却各自
  // 写 `config.person ?? 'default'`——同一个「我是谁」有两个答案：日记落进
  // alice/，好感度却去 default/ 找账本，于是第四节永远报「账本为空」。
  // 把解析结果一起返回，调用方就没机会再各写一份。
  const person = options.person ?? resolvePersonaId(env)
  const dataRoot = path.join(storageRoot, person)
  return {
    dshHome,
    person,
    storageRoot,
    dataRoot,
    sessionsRoot: path.join(dshHome, 'sessions')
  }
}