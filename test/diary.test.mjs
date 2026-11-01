import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'

import {
  SECTIONS, EMPTY_MARKER, renderTemplate, parseDiary, validateDiary,
  composeDiary, writeDiary, readDiary, renderBrief, knowledgeBullets, diaryPaths
} from '../lib/diary.js'
import { tempRoot, assert, assertEqual, assertIsolated } from './helpers.mjs'

/**
 * Build an isolated data root and prove it really is isolated.
 * @returns {string} a temp data root.
 */
function root () {
  const dir = tempRoot()
  assertIsolated(dir, 'diary')
  return dir
}

test('the template has exactly the four agreed sections', () => {
  const parsed = parseDiary(renderTemplate('2026-10-30'))
  assertEqual(Object.values(parsed.sections).length, 4, 'four sections')
  for (const section of SECTIONS) {
    assertEqual(parsed.sections[section.key], `- ${EMPTY_MARKER}`, `${section.heading} is stubbed`)
  }
  assertEqual(parsed.unknown, [], 'no stray sections')
})

test('a complete diary passes validation', () => {
  const body = composeDiary('2026-10-30', {
    knowledge: ['会话存档是多帧 zstd。[源 s-a#seq1]'],
    thoughts: ['我原来以为记得，其实只是窗口大。'],
    impression: ['他会要产物级证据（明确偏好）。'],
    affinity: ['日初 58 → 日终 62', '+2 主人批准方案']
  })
  const verdict = validateDiary(body)
  assertEqual(verdict.ok, true, `should pass: ${verdict.errors.join(';')}`)
})

test('a stub section still counts as present (empty days are legal)', () => {
  // composeDiary fills an unmentioned section with the "nothing new" marker; that
  // is a complete diary, not a broken one, so validation must accept it.
  const body = composeDiary('2026-10-30', { knowledge: ['x'], thoughts: ['y'], affinity: ['58 → 60'] })
  assertEqual(validateDiary(body).ok, true, 'a stubbed section is legal')
})

test('the affinity section is cross-checked against the ledger, not just for an arrow', () => {
  // The original defect: validation only required a "→", so a hand-written
  // "日初 70 → 日终 74" passed while the ledger still said 70. Structure is fine;
  // the number is what must match.
  const body = composeDiary('2026-10-30', {
    knowledge: ['k'], thoughts: ['t'], impression: ['i'],
    affinity: ['日初 70 → 日终 74']
  })
  assertEqual(validateDiary(body).ok, true, 'structure alone still passes')

  const verdict = validateDiary(body, { affinitySummary: { score: 70, net: 0, opening: 70, closing: 70 } })
  assertEqual(verdict.ok, false, 'a number disagreeing with the ledger is refused')
  assert(verdict.errors.some((e) => e.includes('74')), 'the error names the offending value')
})

test('an affinity section that matches the ledger is accepted', () => {
  const body = composeDiary('2026-10-30', {
    knowledge: ['k'], thoughts: ['t'], impression: ['i'],
    affinity: ['日初 68 → 日终 70']
  })
  const verdict = validateDiary(body, { affinitySummary: { score: 70, net: 2, opening: 68, closing: 70 } })
  assertEqual(verdict.ok, true, `matching numbers pass: ${verdict.errors.join(';')}`)
})

test('a diary with a whole section HEADING missing is refused, and named', () => {
  // Hand-written body that drops section three entirely — this is the real fault.
  const body = [
    '# 2026-10-30（周五）',
    '',
    '## 一、新学到的知识',
    '- x',
    '',
    '## 二、感想与认识',
    '- y',
    '',
    '## 四、好感度',
    '- 58 → 60',
    ''
  ].join('\n')
  const verdict = validateDiary(body)
  assertEqual(verdict.ok, false, 'refused')
  assert(verdict.errors.some((error) => error.includes('三、我对主人的印象')), 'names the missing section')
})

test('an extra section is refused (the diary must not grow into a log)', () => {
  const base = composeDiary('2026-10-30', { knowledge: ['x'], thoughts: ['y'], impression: ['z'], affinity: ['1 → 2'] })
  const verdict = validateDiary(`${base}\n## 五、运行日志\n- 跑了 3 次\n`)
  assertEqual(verdict.ok, false, 'refused')
  assert(verdict.errors.some((error) => error.includes('约定之外')), 'explains that the section is not part of the contract')
})

test('a run-log-shaped heading is refused even when worded differently', () => {
  const base = composeDiary('2026-10-30', { knowledge: ['x'], thoughts: ['y'], impression: ['z'], affinity: ['1 → 2'] })
  const verdict = validateDiary(`${base}\n## 待办\n- 修插件\n`)
  assertEqual(verdict.ok, false, 'refused')
})

test('the affinity section must show a before → after arrow', () => {
  const body = composeDiary('2026-10-30', { knowledge: ['x'], thoughts: ['y'], impression: ['z'], affinity: ['今天很开心'] })
  const verdict = validateDiary(body)
  assertEqual(verdict.ok, false, 'refused without an arrow')
  assert(verdict.errors.some((error) => error.includes('→')), 'says the arrow is missing')
})

test('writeDiary refuses an invalid body unless forced', () => {
  const data = root()
  const bad = '# 2026-10-30\n## 一、新学到的知识\n- x\n'
  const refused = writeDiary(data, '2026-10-30', bad)
  assertEqual(refused.ok, false, 'refused by default')
  assertEqual(readDiary(data, '2026-10-30').exists, false, 'nothing was written')
  const forced = writeDiary(data, '2026-10-30', bad, {}, { force: true })
  assertEqual(forced.ok, true, 'force overrides')
  assertEqual(readDiary(data, '2026-10-30').exists, true, 'now on disk')
})

test('a written diary round-trips through disk with its metadata', () => {
  const data = root()
  const body = composeDiary('2026-10-30', { knowledge: ['k'], thoughts: ['t'], impression: ['i'], affinity: ['1 → 2'] })
  writeDiary(data, '2026-10-30', body, { coverage: 'complete', sessions: 3 })
  const read = readDiary(data, '2026-10-30')
  assertEqual(read.exists, true, 'exists')
  assertEqual(read.meta.coverage, 'complete', 'metadata persisted')
  assertEqual(read.meta.sessions, 3, 'coverage numbers persisted')
})

test('the written file has no BOM (PowerShell would add one)', () => {
  const data = root()
  const body = composeDiary('2026-10-30', { knowledge: ['k'], thoughts: ['t'], impression: ['i'], affinity: ['1 → 2'] })
  writeDiary(data, '2026-10-30', body)
  const raw = fs.readFileSync(diaryPaths(data, '2026-10-30').body)
  assertEqual([raw[0], raw[1], raw[2]], [0x23, 0x20, 0x32], 'starts with "# 2", not a BOM')
})

test('the brief stays inside its byte budget, enforced in code', () => {
  const long = '这是一段很长的内容。'.repeat(400)
  const body = composeDiary('2026-10-30', { knowledge: [long], thoughts: [long], impression: [long], affinity: ['1 → 2'] })
  const { brief, bytes, truncated } = renderBrief({ day: '2026-10-30', text: body, affinity: '好感度 62' }, 1200)
  assertEqual(truncated, true, 'had to truncate')
  assert(bytes <= 1200, `brief must fit the budget, got ${bytes} bytes`)
})

test('one huge section cannot starve the other three out of the brief', () => {
  // The exact regression this guards: a long knowledge section used to consume
  // the whole budget, so the affinity line — the most useful part for a new
  // session — was silently cut off.
  const huge = '很长的知识。'.repeat(500)
  const body = composeDiary('2026-10-30', {
    knowledge: [huge],
    thoughts: ['一句感想'],
    impression: ['一句印象'],
    affinity: ['日初 58 → 日终 62']
  })
  const { brief, bytes } = renderBrief({ day: '2026-10-30', text: body, affinity: '好感度 62' }, 2000)
  assert(brief.includes('四、好感度'), 'the affinity heading survives')
  assert(brief.includes('62'), 'and so does its value')
  assert(brief.includes('二、感想与认识'), 'thoughts survive')
  assert(brief.includes('三、我对主人的印象'), 'impressions survive')
  assert(bytes <= 2000, `still within budget, got ${bytes}`)
})

test('the default brief budget is 6000 bytes', () => {
  const body = composeDiary('2026-10-30', { knowledge: ['k'], thoughts: ['t'], impression: ['i'], affinity: ['1 → 2'] })
  const { bytes, truncated } = renderBrief({ day: '2026-10-30', text: body, affinity: '好感度 50' })
  assert(bytes < 6000, 'a normal diary is not truncated')
  assertEqual(truncated, false, 'and reports no truncation')
})

test('the brief names the day and states a missing diary plainly', () => {
  const { brief } = renderBrief({ day: '2026-10-30', text: null, affinity: '好感度 50' }, 3000)
  assert(brief.includes('2026-10-30'), 'names the day')
  assert(brief.includes('没有日记'), 'admits the gap instead of pretending')
  assert(brief.includes('不要假装记得'), 'forbids confabulating')
})

test('a stale brief is labelled so nobody mistakes it for yesterday', () => {
  const body = composeDiary('2026-10-28', { knowledge: ['k'], thoughts: ['t'], impression: ['i'], affinity: ['1 → 2'] })
  const { brief } = renderBrief({ day: '2026-10-28', text: body, affinity: '好感度 50', stale: true }, 3000)
  assert(brief.includes('待补写'), 'marks the staleness')
})

test('knowledgeBullets extracts only the knowledge section', () => {
  const body = composeDiary('2026-10-30', {
    knowledge: ['甲知识', '乙知识'],
    thoughts: ['感想不该进来'],
    impression: ['印象不该进来'],
    affinity: ['1 → 2']
  })
  assertEqual(knowledgeBullets(body), ['甲知识', '乙知识'], 'only knowledge bullets')
})

test('an empty section marker is not indexed as knowledge', () => {
  const body = composeDiary('2026-10-30', { thoughts: ['t'], impression: ['i'], affinity: ['1 → 2'] })
  assertEqual(knowledgeBullets(body), [], 'the stub is not knowledge')
})

test('writing the same day twice keeps the newest content', () => {
  const data = root()
  const first = composeDiary('2026-10-30', { knowledge: ['旧'], thoughts: ['t'], impression: ['i'], affinity: ['1 → 2'] })
  const second = composeDiary('2026-10-30', { knowledge: ['新'], thoughts: ['t'], impression: ['i'], affinity: ['2 → 3'] })
  writeDiary(data, '2026-10-30', first)
  writeDiary(data, '2026-10-30', second)
  assert(readDiary(data, '2026-10-30').text.includes('新'), 'newest content wins')
})
