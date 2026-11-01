/**
 * `dsh-affinity` — 运行期自检。
 *
 * 起因很实际：插件加载、注入、路由全部正常，账本却一个字节都没动，
 * 而“没抛错”什么也证明不了。所以把关键事实落到一个 JSON 文件里：
 * apply 跑没跑、钩子注册没注册、pre-step 到底有没有被派发、被派发时看到了什么。
 *
 * 只在配置 `diag: true` 时写，平时零开销。
 *
 * @module dsh-affinity/diagnostics
 */

import fs from 'node:fs'
import path from 'node:path'

/**
 * 创建一个可累积的自检记录器。
 * @param {string} file - 输出路径。
 * @returns {{mark: (event: string, detail?: object) => void, path: string}} 记录器。
 */
export function createDiagnostics (file) {
  const startedAt = Date.now()
  const marks = []
  const write = () => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify({
        startedAt,
        updatedAt: Date.now(),
        pid: process.pid,
        marks
      }, null, 2) + "\n", { encoding: "utf8" })
    } catch {
      /* 自检失败绝不能影响插件 */
    }
  }
  write()
  return {
    path: file,
    mark (event, detail) {
      marks.push({ at: Date.now(), event, ...(detail ?? {}) })
      // 只留最近 80 条，避免无限增长
      if (marks.length > 80) marks.splice(0, marks.length - 80)
      write()
    }
  }
}
