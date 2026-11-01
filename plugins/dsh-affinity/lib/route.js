/**
 * `dsh-affinity` — 供客户端面板读取的只读 HTTP 路由。
 *
 * 走宿主的 webServer（`ctx.webServer.register`），和 dsh-disk-doctor 同一套做法：
 * 客户端面板拿不到进程内服务，只能从本机路由取数据。两条路由都是 GET 只读，
 * 没有任何写操作——改分只有一条路（裁判 → 账本）。
 *
 * 边界三条，缺一条就是漏洞：
 * 1. 只接受 GET/HEAD；
 * 2. 日期必须在「今天及此前 6 天」白名单里，服务端校验而不是靠前端隐藏按钮；
 * 3. 日记正文直接按白名单拼路径读取，不接受任何来自 URL 的路径片段。
 *
 * @module dsh-affinity/route
 */

import fs from 'node:fs'
import path from 'node:path'

import { diaryDayOf, DEFAULT_CUTOFF_HOUR } from './ledger.js'
import { buildOverview } from './stats.js'

/** 好感度概览路由。 */
export const OVERVIEW_ROUTE = '/dsh-cat-diary/affinity/overview'

/** 单日日记正文路由。 */
export const DIARY_ROUTE = '/dsh-cat-diary/diary/day'

/** 日记阅读窗口：今天及此前 6 天，共 7 天。 */
export const DIARY_WINDOW_DAYS = 7

/**
 * 能读的日键白名单（升序，含今天）。
 * @param {number} now - 当前时间。
 * @param {number} cutoffHour - 换日小时。
 * @returns {string[]} 日键。
 */
export function readableDays (now, cutoffHour = DEFAULT_CUTOFF_HOUR) {
  const today = diaryDayOf(now, cutoffHour)
  const [year, month, day] = today.split("-").map(Number)
  const out = []
  for (let offset = DIARY_WINDOW_DAYS - 1; offset >= 0; offset -= 1) {
    const date = new Date(year, month - 1, day - offset)
    const pad = (value) => String(value).padStart(2, "0")
    out.push(date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()))
  }
  return out
}

/**
 * 解析查询参数。
 * @param {string} url - 请求 URL。
 * @returns {URLSearchParams} 参数。
 */
function queryOf (url) {
  try {
    return new URL(String(url ?? ""), "http://127.0.0.1").searchParams
  } catch {
    return new URLSearchParams()
  }
}

/**
 * 读一天的日记（只读，缺文件返回 null）。
 * @param {string} diaryRoot - 日记人格根目录。
 * @param {string} day - 已在白名单里的日键。
 * @returns {{exists: boolean, text?: string, bytes?: number, meta?: object|null}|null} 结果。
 */
export function readDiaryDay (diaryRoot, day) {
  if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null
  const body = path.join(diaryRoot, "days", day + ".md")
  const meta = path.join(diaryRoot, "days", day + ".meta.json")
  let text
  try {
    text = fs.readFileSync(body, "utf8")
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false }
    throw error
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  let metaValue = null
  try {
    metaValue = JSON.parse(fs.readFileSync(meta, "utf8"));
  } catch {
    metaValue = null;
  }
  return { exists: true, text, bytes: Buffer.byteLength(text, "utf8"), meta: metaValue }
}

/**
 * 注册只读路由。
 * @param {object} ctx - 插件上下文。
 * @param {{eventsFile: string, diaryRoot: string, maxDaily: number, cutoffHour: number}} deps - 依赖。
 * @returns {void}
 */
export function registerRoutes (ctx, deps) {
  if (!ctx || typeof ctx.inject !== "function") return
  ctx.inject(["webServer"], (host) => {
    const json = (response, status, payload, method) => {
      response.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      })
      response.end(method === "HEAD" ? undefined : JSON.stringify(payload))
    }

    host.effect(() => host.webServer.register({
      kind: "exact",
      path: OVERVIEW_ROUTE,
      handler: async (request, response) => {
        if (request.method !== "GET" && request.method !== "HEAD") {
          response.writeHead(405, { allow: "GET, HEAD" })
          response.end()
          return
        }
        try {
          const overview = buildOverview({
            eventsFile: deps.eventsFile,
            maxDaily: deps.maxDaily,
            cutoffHour: deps.cutoffHour
          })
          const days = readableDays(Date.now(), deps.cutoffHour).map((day) => {
            const diary = readDiaryDay(deps.diaryRoot, day)
            return { day, exists: Boolean(diary?.exists), bytes: diary?.bytes ?? 0 }
          })
          json(response, 200, { ...overview, diaryDays: days }, request.method)
        } catch (error) {
          json(response, 500, { error: String(error?.message ?? error) }, request.method)
        }
      }
    }), "dsh-affinity: overview route")

    host.effect(() => host.webServer.register({
      kind: "exact",
      path: DIARY_ROUTE,
      handler: async (request, response) => {
        if (request.method !== "GET" && request.method !== "HEAD") {
          response.writeHead(405, { allow: "GET, HEAD" })
          response.end()
          return
        }
        try {
          const day = queryOf(request.url).get("day") ?? ""
          if (!readableDays(Date.now(), deps.cutoffHour).includes(day)) {
            json(response, 403, { error: "只能读取最近 7 天的日记", day }, request.method)
            return
          }
          const diary = readDiaryDay(deps.diaryRoot, day)
          if (!diary || !diary.exists) {
            json(response, 404, { error: "该日没有日记", day }, request.method)
            return
          }
          json(response, 200, { day, text: diary.text, bytes: diary.bytes, meta: diary.meta }, request.method)
        } catch (error) {
          json(response, 500, { error: String(error?.message ?? error) }, request.method)
        }
      }
    }), "dsh-affinity: diary route")
  })
}
