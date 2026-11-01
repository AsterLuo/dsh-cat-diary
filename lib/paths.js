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
 * @returns {{dshHome: string, storageRoot: string, dataRoot: string, sessionsRoot: string}} resolved paths.
 */
export function resolvePaths (options = {}) {
  const env = options.env ?? process.env
  const dshHome = options.dshHome ? path.resolve(options.dshHome) : resolveDshHome(env, path.join(os.homedir(), '.dsh'))
  const storageRoot = path.join(dshHome, 'storages', STORAGE_NAME)
  const dataRoot = path.join(storageRoot, options.person ?? resolvePersonaId(env))
  return {
    dshHome,
    storageRoot,
    dataRoot,
    sessionsRoot: path.join(dshHome, 'sessions')
  }
}
