#!/usr/bin/env node
/**
 * `dsh-cat-diary` command line.
 *
 * Works with or without a running DSH: it decodes session archives directly. This
 * is the degraded path the whole design rests on — if the plugin ever fails to
 * load, the diary can still be produced and read from here.
 */

import path from 'node:path'

import { resolvePaths, resolvePersonaId } from '../lib/paths.js'
import { collectDay, surveyDays, estimateCost, readRaw, rawPath } from '../lib/collect.js'
import { isDayKey, shiftDay, diaryDayOf, recentDays, weekdayLabel } from '../lib/day.js'
import { readDiary, writeDiary, renderBrief, composeDiary, validateDiary, knowledgeBullets, diaryPaths, SECTIONS, replaceAffinitySection } from '../lib/diary.js'
import { resolveDaySummary, renderAffinityHeader, renderAffinitySection } from '../lib/affinity-reader.js'
import { writeText, readText, listByExtension, ensureDir, utf8Bytes } from '../lib/store.js'

/** Parsed command line. */
const argv = process.argv.slice(2)

/**
 * Read a flag value.
 * @param {string[]} list - arguments.
 * @param {string} flag - flag name including dashes.
 * @param {string} [fallback] - default.
 * @returns {string|undefined} value.
 */
function flag (list, flagName, fallback) {
  const index = list.indexOf(flagName)
  if (index === -1) return fallback
  return list[index + 1]
}

/** @returns {boolean} whether the flag is present. */
function has (list, flagName) {
  return list.includes(flagName)
}

/**
 * Resolve the day argument, defaulting to yesterday.
 * @param {string} [arg] - `today` | `yesterday` | `YYYY-MM-DD`.
 * @param {{todayIsDay?: boolean}} [options] - whether "today" means the current diary day.
 * @returns {string} a day key.
 */
function resolveDay (arg, options = {}) {
  const today = diaryDayOf(Date.now(), Number(flag(argv, '--cutoff', '5')))
  if (!arg || arg === 'yesterday') return shiftDay(today, -1)
  if (arg === 'today') return today
  if (!isDayKey(arg)) throw new Error(`无法识别的日期：${arg}（要 today / yesterday / YYYY-MM-DD）`)
  return arg
}

/**
 * Print a labeled section of output.
 * @param {string} title - heading.
 * @param {string} body - content.
 * @returns {void}
 */
function section (title, body) {
  process.stdout.write(`\n${title}\n${'─'.repeat(48)}\n${body}\n`)
}

/**
 * One-line machine-readable summary, always printed so a run can be audited.
 * @param {Record<string, unknown>} values - key/value pairs.
 * @returns {void}
 */
function report (values) {
  const parts = Object.entries(values).map(([key, value]) => `${key}=${value}`)
  process.stdout.write(`\n[报数] ${parts.join('  ')}\n`)
}

/**
 * Print usage.
 * @returns {void}
 */
function usage () {
  process.stdout.write(`dsh-cat-diary — 猫娘日记与跨会话记忆

用法：
  diary open [--date D]            打印指定日（默认昨天）的速读卡，供新会话读取
  diary show [--date D]            打印整篇日记
  diary list                       列出已有日记
  diary raw [--date D]             打印采集到的原料
  diary collect [--date D]         只采集原料，不写日记
  diary write --date D --file F    从文件写入日记（做四栏校验）
  diary template [--date D]        打印空白模板
  diary affinity [show|add]        查看 / 追加好感度事件
  diary knowledge [关键词]         检索知识摘录
  diary backfill [--days N]        倒着补历史原料，带成本预估
  diary status                     报数：日记数、原料数、好感度、最近状态

环境变量：
  DSH_HOME                  DSH 数据根（默认 ~/.dsh）
  DSH_CAT_DIARY_PERSONA     人格 id（默认 default）
`)
}

/** Resolve the current paths once. */
const paths = resolvePaths({})

const command = argv[0] ?? 'open'

try {
  switch (command) {
    case 'open': {
      const day = resolveDay(flag(argv, '--date'))
      const diary = readDiary(paths.dataRoot, day)
      const affinityPaths = { dshHome: paths.dshHome, person: process.env.DSH_AFFINITY_PERSONA?.trim() || 'default' }
      const affinity = renderAffinityHeader(resolveDaySummary(null, affinityPaths, day), 10)
      const { brief, bytes, truncated } = renderBrief(
        { day, text: diary.exists ? diary.text : null, affinity, stale: !diary.exists },
        Number(flag(argv, '--bytes', '3000'))
      )
      process.stdout.write(`${brief}\n`)
      report({ day, 日记: diary.exists ? `有（${diary.bytes}B）` : '缺', 卡片字节: bytes, 截断: truncated })
      break
    }

    case 'show': {
      const day = resolveDay(flag(argv, '--date'))
      const diary = readDiary(paths.dataRoot, day)
      if (!diary.exists) {
        process.stdout.write(`${day} 没有日记。` + '\n')
        report({ day, 日记: '缺' })
        break
      }
      process.stdout.write(`${diary.text}\n`)
      report({ day, 日记: `${diary.bytes}B`, 完整性: diary.meta?.coverage ?? '未知' })
      break
    }

    case 'list': {
      const files = listByExtension(path.join(paths.dataRoot, 'days'), '.md')
      const days = files.map((file) => file.replace(/\.md$/, ''))
      if (days.length === 0) process.stdout.write('还没有任何日记。\n')
      for (const day of days) {
        const diary = readDiary(paths.dataRoot, day)
        process.stdout.write(`${day}（${weekdayLabel(day)}）  ${diary.bytes} 字节\n`)
      }
      report({ 日记数: days.length })
      break
    }

    case 'raw': {
      const day = resolveDay(flag(argv, '--date'))
      const raw = readRaw(paths.dataRoot, day)
      if (raw === null) {
        process.stdout.write(`${day} 还没有原料，先跑 diary collect。\n`)
        report({ day, 原料: '缺' })
        break
      }
      process.stdout.write(raw)
      report({ day, 原料字节: utf8Bytes(raw) })
      break
    }

    case 'collect': {
      const day = resolveDay(flag(argv, '--date'))
      const result = collectDay({ dshHome: paths.dshHome, dataRoot: paths.dataRoot, day })
      report({
        day,
        会话: result.sessionCount,
        保留: result.kept,
        剔除回放: result.droppedReplays,
        截断: result.truncated,
        字节: result.bytes
      })
      break
    }

    case 'write': {
      const day = resolveDay(flag(argv, '--date'))
      const file = flag(argv, '--file')
      if (!file) throw new Error('write 需要 --file 指定正文来源（或用 --stdin）')
      const raw = readText(file) ?? ''
      // 第四节永远由账本生成：模型只交前三节，代码把它拼上去。
      // 这样“日记里的数字”不可能再有第二个作者，也就不可能和账本对不上。
      const person = process.env.DSH_AFFINITY_PERSONA?.trim() || 'default'
      const summary = resolveDaySummary(null, { dshHome: paths.dshHome, person }, day)
      const text = has(argv, '--no-affinity') || summary.score === null
        ? raw
        : replaceAffinitySection(raw, renderAffinitySection(summary, 10))
      const result = writeDiary(paths.dataRoot, day, text, { source: path.basename(file) }, {
        force: has(argv, '--force'),
        affinitySummary: summary
      })
      if (!result.ok) {
        process.stderr.write(`拒绝写入：\n  ${result.errors.join('\n  ')}\n`)
        process.exitCode = 2
        break
      }
      report({ day, 写入: result.path, 字节: utf8Bytes(text), 好感度: summary.score ?? '未知' })
      break
    }

    case 'template': {
      const day = resolveDay(flag(argv, '--date'))
      process.stdout.write(composeDiary(day, {}))
      report({ day })
      break
    }

    case 'affinity': {
      const action = argv[1] ?? 'show'
      const person = process.env.DSH_AFFINITY_PERSONA?.trim() || 'default'
      if (action === 'show') {
        const day = resolveDay(flag(argv, '--date', 'yesterday'))
        const summary = resolveDaySummary(null, { dshHome: paths.dshHome, person }, day)
        section('好感度（只读）', [
          `当前值：${summary.score === null ? '未记录' : summary.score}`,
          `${day}：净 ${summary.net > 0 ? '+' : ''}${summary.net}，已用 ${summary.used}/10`,
          `来源：${summary.source}（写入方是 dsh-affinity 插件，本命令只读）`
        ].join('\n'))
        for (const reason of summary.reasons) process.stdout.write(`  · ${reason}\n`)
        report({ 好感度: summary.score ?? '未知', 来源: summary.source })
        break
      }
      if (action === 'add') {
        throw new Error('好感度只能由 dsh-affinity 插件的 affinity_adjust 工具写入，CLI 不再提供加分入口')
      }
      throw new Error(`未知的 affinity 子命令：${action}`)
    }

    case 'knowledge': {
      const query = argv.slice(1).filter((item) => !item.startsWith('--')).join(' ').trim()
      const files = listByExtension(path.join(paths.dataRoot, 'days'), '.md')
      let hits = 0
      for (const file of files) {
        const day = file.replace(/\.md$/, '')
        const diary = readDiary(paths.dataRoot, day)
        if (!diary.exists) continue
        for (const bullet of knowledgeBullets(diary.text)) {
          if (query === '' || bullet.includes(query)) {
            process.stdout.write(`${day}  ${bullet}\n`)
            hits++
          }
        }
      }
      report({ 命中: hits, 检索词: query || '（全部）' })
      break
    }

    case 'backfill': {
      const days = Number(flag(argv, '--days', '7'))
      const dryRun = has(argv, '--dry-run')
      const yesterday = shiftDay(diaryDayOf(Date.now()), -1)
      const targets = recentDays(yesterday, days).reverse()
      const summary = surveyDays(paths.dshHome)
      const cost = estimateCost(summary, targets)
      section('补录计划', [
        `范围：${targets[targets.length - 1]} ← ${targets[0]}（${days} 天）`,
        `有内容的天数：${cost.days}`,
        `素材字符：${cost.chars}`,
        `估算 token：${cost.tokens}`,
        `估算费用：约 ¥${cost.cny.toFixed(2)}`,
        dryRun ? '这是 --dry-run，未写入任何文件。' : ''
      ].filter(Boolean).join('\n'))
      if (dryRun) {
        report({ 模式: 'dry-run', 天数: cost.days, 估算人民币: cost.cny.toFixed(2) })
        break
      }
      let written = 0
      let empty = 0
      for (const day of targets) {
        const result = collectDay({ dshHome: paths.dshHome, dataRoot: paths.dataRoot, day })
        if (result.empty) empty++
        else written++
        process.stdout.write(`  ${day}  ${result.empty ? '无内容' : `${result.kept} 条 / ${result.bytes}B`}\n`)
      }
      report({ 天数: targets.length, 有内容: written, 空日: empty })
      break
    }

    case 'status': {
      const days = listByExtension(path.join(paths.dataRoot, 'days'), '.md')
      const raws = listByExtension(path.join(paths.dataRoot, 'raw'), '.md')
      const person = process.env.DSH_AFFINITY_PERSONA?.trim() || 'default'
      const today = diaryDayOf(Date.now())
      const state = resolveDaySummary(null, { dshHome: paths.dshHome, person }, today)
      section('状态', [
        `数据根：${paths.dataRoot}`,
        `日记：${days.length} 篇`,
        `原料：${raws.length} 份`,
        `好感度：${state.score === null ? '未记录' : state.score}（来源 ${state.source}）`,
        `今日（${today}）日记：${days.includes(`${today}.md`) ? '有' : '无'}`,
        `昨日（${shiftDay(today, -1)}）日记：${days.includes(`${shiftDay(today, -1)}.md`) ? '有' : '无'}`
      ].join('\n'))
      report({ 日记: days.length, 原料: raws.length, 好感度: state.score ?? '未知', 今日: today })
      break
    }

    default:
      usage()
      process.exitCode = 1
  }
} catch (error) {
  process.stderr.write(`出错：${error?.message ?? error}\n`)
  process.exitCode = 1
}
