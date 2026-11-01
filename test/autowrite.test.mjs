import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { pendingDays, dayClosed, resolveRoute, writeOneDay, catchUp, MAX_CATCHUP_DAYS } from '../lib/autowrite.js'
import { dayRange } from '../lib/day.js'
import { readDiary } from '../lib/diary.js'

/** 造一个隔离的人格根。 */
function root () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-'))
  const rel = path.relative(os.tmpdir(), dir)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('refusing to run outside the temp directory: ' + dir)
  }
  fs.mkdirSync(path.join(dir, 'days'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'raw'), { recursive: true })
  return dir
}

/** 假宿主：可配置 defaultModel 与 llm 输出。 */
function host (options = {}) {
  let calls = 0
  const ctx = {
    get (name) {
      if (name === 'agentDefaultModel') {
        if (options.noRoute) return null
        return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
      }
      if (name === 'llm') {
        if (options.noLlm) return null
        return {
          stream () {
            calls += 1
            if (options.llmThrows) throw new Error('llm 炸了')
            return (async function* () {
              const text = options.reply ?? '## 一、新学到的知识\n- a\n\n## 二、感想与认识\n- b\n\n## 三、我对主人的印象\n- c\n'
              yield { type: 'text-delta', index: 0, text }
              yield { type: 'finish', reason: { kind: 'stop' } }
            })()
          }
        }
      }
      return null
    }
  }
  return { ctx, calls: () => calls }
}

const DAY = '2026-10-31'
const NOON_NEXT = new Date(2026, 10, 1, 12, 0, 0).getTime()

test('已有日记的日子不进待补列表', () => {
  const data = root()
  fs.writeFileSync(path.join(data, 'days', '2026-10-31.md'), '# x')
  const list = pendingDays(data, '2026-11-01', { maxDays: 3 })
  assert(!list.includes('2026-10-31'), '已写过的不能重复补')
})

test('待补列表按时间从旧到新', () => {
  const data = root()
  const list = pendingDays(data, '2026-11-01', { maxDays: 3 })
  assert.deepEqual(list, ['2026-10-29', '2026-10-30', '2026-10-31'], '顺序必须旧在前')
})

test('追溯天数有上限，不会一次扫出一大堆历史', () => {
  const data = root()
  const list = pendingDays(data, '2026-11-01', { maxDays: 2 })
  assert.equal(list.length, 2)
  const list2 = pendingDays(data, '2026-11-01')
  assert.equal(list2.length, MAX_CATCHUP_DAYS, '默认上限生效')
})

test('日记日结束后才算关闭（05:00 换日）', () => {
  const range = dayRange(DAY, 5)
  assert.equal(dayClosed(DAY, range.end - 1000, 5), false, '结束前一秒还不能写')
  assert.equal(dayClosed(DAY, range.end + 1000, 5), true, '结束后才能写')
  assert.equal(dayClosed(DAY, range.start, 5), false, '刚开始更不能写')
})

test('路由优先取显式配置，其次 defaultModel 服务', () => {
  const { ctx } = host()
  assert.deepEqual(resolveRoute(ctx, { provider: 'x', model: 'y' }), { ok: true, provider: 'x', model: 'y' })
  assert.deepEqual(resolveRoute(ctx, {}), { ok: true, provider: 'p', model: 'm' })
})

test('拿不到路由时拒绝补写，而不是猜一个模型', () => {
  const { ctx } = host({ noRoute: true })
  const route = resolveRoute(ctx, {})
  assert.equal(route.ok, false, '不能瞎猜')
  assert(String(route.error).includes('路由'))
})

test('已存在的日记不被覆盖（幂等）', async () => {
  const data = root()
  fs.writeFileSync(path.join(data, 'raw', DAY + '.md'), 'x')
  fs.writeFileSync(path.join(data, 'days', DAY + '.md'), '# 手写的原稿')
  const { ctx } = host()
  const result = await writeOneDay(ctx, {
    dataRoot: data, dshHome: data, day: DAY, person: 'default',
    cutoffHour: 5, provider: 'p', model: 'm'
  })
  assert.equal(result.skipped, 'already-written')
  assert.equal(fs.readFileSync(path.join(data, 'days', DAY + '.md'), 'utf8'), '# 手写的原稿', '原内容必须原样保留')
})

test('没有原料的日子跳过，不调模型', async () => {
  const data = root()
  const { ctx, calls } = host()
  const result = await writeOneDay(ctx, {
    dataRoot: data, dshHome: data, day: DAY, person: 'default',
    cutoffHour: 5, provider: 'p', model: 'm'
  })
  assert.equal(result.skipped, 'no-material')
  assert.equal(calls(), 0, '没原料就不该花钱调模型')
})

test('完整流程写出四节，第四节由代码生成', async () => {
  const data = root()
  fs.writeFileSync(path.join(data, 'raw', DAY + '.md'), '# raw')
  const { ctx } = host()
  const result = await writeOneDay(ctx, {
    dataRoot: data, dshHome: data, day: DAY, person: 'default',
    cutoffHour: 5, provider: 'p', model: 'm'
  })
  assert.equal(result.ok, true)
  const diary = readDiary(data, DAY)
  assert.equal(diary.exists, true)
  for (const heading of ['一、新学到的知识', '二、感想与认识', '三、我对主人的印象', '四、好感度']) {
    assert(diary.text.includes(heading), '必须含小节：' + heading)
  }
  assert(diary.text.includes('affinity 账本'), '第四节要标明来自账本')
})

test('模型失败时留痕迹且不写正文', async () => {
  const data = root()
  fs.writeFileSync(path.join(data, 'raw', DAY + '.md'), '# raw')
  const { ctx } = host({ llmThrows: true })
  const result = await writeOneDay(ctx, {
    dataRoot: data, dshHome: data, day: DAY, person: 'default',
    cutoffHour: 5, provider: 'p', model: 'm'
  })
  assert.equal(result.ok, false)
  assert.equal(readDiary(data, DAY).exists, false, '失败不能留下半截日记')
  const failedPath = path.join(data, 'days', DAY + '.failed.json')
  assert.equal(fs.existsSync(failedPath), true, '必须留下失败痕迹')
})

test('模型输出为空视为失败', async () => {
  const data = root()
  fs.writeFileSync(path.join(data, 'raw', DAY + '.md'), '# raw')
  const { ctx } = host({ reply: '' })
  const result = await writeOneDay(ctx, {
    dataRoot: data, dshHome: data, day: DAY, person: 'default',
    cutoffHour: 5, provider: 'p', model: 'm'
  })
  assert.equal(result.ok, false)
  assert(String(result.error).includes('空'))
})

test('catchUp 整天只写一次，再跑不重复调用模型', async () => {
  const data = root()
  fs.writeFileSync(path.join(data, 'raw', DAY + '.md'), '# raw')
  const { ctx, calls } = host()
  const options = {
    dataRoot: data, dshHome: data, person: 'default', cutoffHour: 5,
    maxDaily: 10, maxDays: 1, now: NOON_NEXT
  }
  const first = await catchUp(ctx, options)
  assert.equal(first.results.filter((r) => r.ok && !r.skipped).length, 1)
  const afterFirst = calls()
  const second = await catchUp(ctx, options)
  assert.equal(calls(), afterFirst, '第二次不该再调模型')
  assert.equal(second.taken.length, 0, '已写完的日子不再进列表')
})

test('catchUp 在没路由时给出失败结果而不是抛错', async () => {
  const data = root()
  fs.writeFileSync(path.join(data, 'raw', DAY + '.md'), '# raw')
  const { ctx } = host({ noRoute: true })
  const result = await catchUp(ctx, {
    dataRoot: data, dshHome: data, person: 'default', cutoffHour: 5,
    maxDaily: 10, maxDays: 1, now: NOON_NEXT
  })
  assert.equal(result.results.length, 1)
  assert.equal(result.results[0].ok, false)
})

test('账本为空时日记仍能写入（合法状态不该被拒）', async () => {
  const data = root()
  fs.writeFileSync(path.join(data, 'raw', DAY + '.md'), '# raw')
  const { ctx } = host()
  const result = await writeOneDay(ctx, {
    dataRoot: data, dshHome: data, day: DAY, person: 'default',
    cutoffHour: 5, provider: 'p', model: 'm'
  })
  assert.equal(result.ok, true, '空账本不是格式错误')
  const diary = readDiary(data, DAY)
  assert(diary.text.includes('无可核验'), '空账本要如实说明')
})
