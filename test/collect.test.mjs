import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'

import { collectDay, filterDay, estimateCost, surveyDays, rawPath } from '../lib/collect.js'
import { groupByDay, immediateSessions, listSessionFiles, loadSession } from '../lib/sessions.js'
import { assert, assertEqual, tempRoot, assertIsolated, writeFakeSession, sessionHeader, userRecord, assistantRecord, replayRecord } from './helpers.mjs'

/**
 * Build a fake DSH home with one session spanning two days.
 * @returns {{dshHome: string, dataRoot: string, at: (h: number, m?: number, day?: number) => number}} fixture.
 */
function fixture () {
  const base = tempRoot()
  assertIsolated(base, 'collect')
  const dshHome = path.join(base, 'dsh-home')
  const dataRoot = path.join(base, 'data')
  const sessionDir = path.join(dshHome, 'sessions', '--proj--', 'session-aaaa')
  // 2026-10-30 22:00 local
  const at = (hour, minute = 0, day = 30) => new Date(2026, 9, day, hour, minute).getTime()
  writeFakeSession(path.join(sessionDir, 'session.v4.jsonl.zstd'), [
    sessionHeader({ id: 'session-aaaa', cwd: 'E:\\proj' }),
    userRecord('给我写个记忆系统', at(22)),
    assistantRecord('好的，我看看文档。', at(22, 1), { tools: ['read', 'pwsh'], reasoning: '很长的内部推理不该出现在原料里' }),
    userRecord('再加个好感度', at(22, 2)),
    userRecord('<system-reminder>\nA skill is reusable\n</system-reminder>', at(22, 2)),
    replayRecord(at(22, 3)),
    assistantRecord('加好了。', at(22, 4)),
    // next diary day
    userRecord('第二天的话', at(9, 0, 31))
  ])
  return { dshHome, dataRoot, at }
}

test('a sub-agent session is excluded from day grouping', () => {
  const base = tempRoot()
  writeFakeSession(path.join(base, 'sessions', 'w', 'session-main', 'session.v4.jsonl.zstd'), [
    sessionHeader({ id: 'session-main', delegationDepth: 0 }),
    userRecord('主会话', new Date(2026, 9, 30, 22).getTime())
  ])
  writeFakeSession(path.join(base, 'sessions', 'w', 'session-sub', 'session.v4.jsonl.zstd'), [
    sessionHeader({ id: 'session-sub', delegationDepth: 1 }),
    userRecord('子代理流水', new Date(2026, 9, 30, 22, 5).getTime())
  ])
  const sessions = listSessionFiles(path.join(base, 'sessions')).map(loadSession)
  const immediate = immediateSessions(sessions)
  assertEqual(immediate.length, 1, 'only the main session counts')
  assertEqual(immediate[0].id, 'session-main', 'and it is the right one')
})

test('collectDay keeps real messages and drops compaction replays', () => {
  const { dshHome, dataRoot } = fixture()
  const result = collectDay({ dshHome, dataRoot, day: '2026-10-30' })
  assertEqual(result.sessionCount, 1, 'one session')
  assertEqual(result.droppedReplays, 1, 'the replay was dropped')
  assert(result.droppedReplayChars > 20000, 'and it was the big one')
  assert(result.kept >= 4, `kept the real messages, got ${result.kept}`)
  assertEqual(result.droppedInjected, 1, 'harness-injected context was dropped')
  assert(!result.text.includes('<system-reminder>'), 'injected context never reaches the raw file')
  assert(!result.text.includes('Primary Request and Intent'), 'replay text never reaches the raw file')
  assert(!result.text.includes('内部推理'), 'reasoning never reaches the raw file')
  assert(result.text.includes('给我写个记忆系统'), 'user words survive')
  assert(result.text.includes('pwsh'), 'tool names survive')
  assert(!result.text.includes('"--command"'), 'tool arguments do not')
})

test('collectDay separates midnight-adjacent messages into different diary days', () => {
  const { dshHome, dataRoot } = fixture()
  const thirtieth = collectDay({ dshHome, dataRoot, day: '2026-10-30' })
  const thirtyFirst = collectDay({ dshHome, dataRoot, day: '2026-10-31' })
  assert(thirtieth.text.includes('给我写个记忆系统'), 'day 30 has its own material')
  assert(!thirtieth.text.includes('第二天的话'), 'day 30 does not leak day 31')
  assert(thirtyFirst.text.includes('第二天的话'), 'day 31 has its own material')
})

test('collectDay on an empty day reports empty rather than inventing material', () => {
  const { dshHome, dataRoot } = fixture()
  const result = collectDay({ dshHome, dataRoot, day: '2026-10-01' })
  assertEqual(result.empty, true, 'marked empty')
  assertEqual(result.kept, 0, 'nothing kept')
  assertEqual(result.path, null, 'nothing written')
})

test('collectDay writes the raw file and respects the byte budget', () => {
  const { dshHome, dataRoot } = fixture()
  const result = collectDay({ dshHome, dataRoot, day: '2026-10-30', budget: 400 })
  assert(fs.existsSync(rawPath(dataRoot, '2026-10-30')), 'raw file created')
  assert(result.bytes <= 500, `raw file must respect the budget, got ${result.bytes}`)
  assertEqual(result.truncated, true, 'truncation is reported, not silent')
})

test('collectDay refuses an impossible day', () => {
  const { dshHome, dataRoot } = fixture()
  let threw = false
  try {
    collectDay({ dshHome, dataRoot, day: '2026-02-30' })
  } catch {
    threw = true
  }
  assert(threw, 'must reject a non-existent date')
})

test('a corrupt session archive does not abort the whole collection', () => {
  const { dshHome, dataRoot } = fixture()
  const broken = path.join(dshHome, 'sessions', '--broken--', 'session-broken')
  fs.mkdirSync(broken, { recursive: true })
  fs.writeFileSync(path.join(broken, 'session.v4.jsonl.zstd'), Buffer.from('not a zstd file at all'))
  const result = collectDay({ dshHome, dataRoot, day: '2026-10-30' })
  assert(result.kept > 0, 'the healthy session still produced material')
})

test('estimateCost scales with the number of days', () => {
  const summary = new Map([
    ['2026-10-29', { day: '2026-10-29', chars: 100000 }],
    ['2026-10-30', { day: '2026-10-30', chars: 100000 }]
  ])
  const one = estimateCost(summary, ['2026-10-30'])
  const two = estimateCost(summary, ['2026-10-29', '2026-10-30'])
  assertEqual(one.days, 1, 'one day priced')
  assertEqual(two.days, 2, 'two days priced')
  assert(two.cny >= one.cny, 'more days never cost less')
})

test('filterDay reports counts that add up', () => {
  const { dshHome } = fixture()
  const sessions = listSessionFiles(path.join(dshHome, 'sessions')).map(loadSession)
  const bucket = groupByDay(immediateSessions(sessions)).get('2026-10-30')
  const filtered = filterDay(bucket)
  const totalIn = bucket.sessions.reduce((sum, session) => sum + session.messages.length, 0)
  assertEqual(
    filtered.kept + filtered.droppedReplays + filtered.droppedInjected,
    totalIn,
    'every message is either kept or dropped, none vanish'
  )
})
