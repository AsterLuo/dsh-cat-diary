import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'

import { readDayFromLedger, resolveDaySummary, renderAffinityHeader, renderAffinitySection } from '../lib/affinity-reader.js'
import { tempRoot, assert, assertEqual, assertIsolated } from './helpers.mjs'

const DAY = '2026-10-30'

/**
 * Build an isolated DSH home containing an affinity ledger.
 * @param {object[]} events - ledger events.
 * @returns {string} the dsh home path.
 */
function homeWith (events) {
  const home = tempRoot()
  assertIsolated(home, 'affinity-reader')
  const dir = path.join(home, 'storages', 'dsh-affinity', 'default', 'affinity')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')
  return home
}

test('the diary reads the score from the affinity ledger', () => {
  const home = homeWith([
    { id: 'init', kind: 'init', value: 50, day: DAY },
    { id: 'a', kind: 'adjust', day: DAY, delta: 2, from: 50, to: 52, reason: '主人先问思路' },
    { id: 'b', kind: 'adjust', day: DAY, delta: 1, from: 52, to: 53, reason: '主人拍板' }
  ])
  const summary = resolveDaySummary(null, { dshHome: home, person: 'default' }, DAY)
  assertEqual(summary.score, 53, 'score comes from the ledger')
  assertEqual(summary.net, 3, 'net for the day')
  assertEqual(summary.used, 3, 'absolute usage')
  assertEqual(summary.opening, 50, 'opening value')
  assertEqual(summary.closing, 53, 'closing value')
  assertEqual(summary.source, 'ledger', 'source is the fallback ledger')
})

test('the diary NEVER writes a score of its own', () => {
  const home = homeWith([{ id: 'init', kind: 'init', value: 60, day: DAY }])
  const before = fs.readFileSync(path.join(home, 'storages', 'dsh-affinity', 'default', 'affinity', 'events.jsonl'), 'utf8')
  resolveDaySummary(null, { dshHome: home, person: 'default' }, DAY)
  renderAffinityHeader({ score: 60, net: 0, used: 0 }, 10)
  renderAffinitySection({ score: 60, net: 0, used: 0, opening: null, closing: null, reasons: [] }, 10)
  const after = fs.readFileSync(path.join(home, 'storages', 'dsh-affinity', 'default', 'affinity', 'events.jsonl'), 'utf8')
  assertEqual(after, before, 'reading must not mutate the ledger')
})

test('the live service wins over the on-disk ledger', () => {
  const home = homeWith([{ id: 'init', kind: 'init', value: 10, day: DAY }])
  const service = { summary: () => ({ score: 88, net: 8, used: 8, opening: 80, closing: 88, reasons: ['from service'] }) }
  const summary = resolveDaySummary(service, { dshHome: home, person: 'default' }, DAY)
  assertEqual(summary.score, 88, 'service value is authoritative')
  assertEqual(summary.source, 'service', 'source recorded')
})

test('a broken service falls back to the ledger instead of throwing', () => {
  const home = homeWith([{ id: 'init', kind: 'init', value: 40, day: DAY }])
  const service = { summary: () => { throw new Error('service exploded') } }
  const summary = resolveDaySummary(service, { dshHome: home, person: 'default' }, DAY)
  assertEqual(summary.score, 40, 'fell back to disk')
})

test('no ledger at all reports unknown, never a fabricated number', () => {
  const home = tempRoot()
  assertIsolated(home, 'affinity-reader-empty')
  const summary = resolveDaySummary(null, { dshHome: home, person: 'default' }, DAY)
  assertEqual(summary.score, null, 'unknown is null')
  const header = renderAffinityHeader(summary, 10)
  assert(header.includes('未记录'), `header must admit the gap, got: ${header}`)
  assert(!header.includes('好感度 50'), 'must not default to the initial score')
})

test('the header states today\'s movement without inventing one', () => {
  assertEqual(
    renderAffinityHeader({ score: 72, net: 2, used: 2 }, 10),
    '好感度 72，今日 +2，已用 2/10',
    'with movement'
  )
  assertEqual(
    renderAffinityHeader({ score: 72, net: 0, used: 0 }, 10),
    '好感度 72，今日无变化',
    'flat day'
  )
})

test('the diary section is generated from the ledger, not typed by the model', () => {
  const bullets = renderAffinitySection({ score: 72, net: 3, used: 3, opening: 69, closing: 72, reasons: ['主人先问思路', '主人拍板'] }, 10)
  assert(bullets[0].includes('日初 69 → 日终 72'), `opening/closing rendered, got: ${bullets[0]}`)
  assert(bullets.includes('主人先问思路'), 'reasons carried over')
  assert(bullets.some((line) => line.includes('由代码生成')), 'states its own provenance')
})

test('a day with no movement says so plainly', () => {
  // 无变化日也必须写成「日初 X → 日终 X」：第四节要能通过 diary.js 的结构校验，
  // 否则代码自己生成的内容会被自己的校验拒掉（实测踩过）。
  const bullets = renderAffinitySection({ score: 72, net: 0, used: 0, opening: null, closing: null, reasons: [] }, 10)
  assert(bullets[0].includes('日初 72 → 日终 72'), 'shows a flat arrow rather than prose only')
  assert(bullets[0].includes('今日净 0'), 'states no change')
  assert(bullets[0].includes('72'), 'still reports the current value')
})

test('a corrupt ledger line does not break the read', () => {
  const home = homeWith([{ id: 'init', kind: 'init', value: 50, day: DAY }])
  const file = path.join(home, 'storages', 'dsh-affinity', 'default', 'affinity', 'events.jsonl')
  fs.appendFileSync(file, '{ broken\n', 'utf8')
  fs.appendFileSync(file, JSON.stringify({ id: 'a', kind: 'adjust', day: DAY, delta: 2 }) + '\n', 'utf8')
  const summary = readDayFromLedger(home, 'default', DAY)
  assertEqual(summary.score, 52, 'valid events still counted')
})
