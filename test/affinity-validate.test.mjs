import assert from 'node:assert/strict'
import { validateDiary, replaceAffinitySection } from '../lib/diary.js'
import { renderAffinitySection } from '../lib/affinity-reader.js'

const summary = { score: 88, net: 4, used: 4, opening: 77, closing: 81, maxDaily: 16, reasons: [] }

const body = [
  '# 2026-11-01（周日）',
  '',
  '## 一、新学到的知识',
  '- 学到了东西',
  '',
  '## 二、感想与认识',
  '- 有点感慨',
  '',
  '## 三、我对主人的印象',
  '- 主人很认真',
  '',
  '## 四、好感度',
  '- 日初 77 → 日终 81（今日净 +4，已用 4/16）',
  '- 主人问第 5 问，还在意会不会影响其他插件',
  '- 数值来源：affinity 账本（唯一写入方），本条由代码生成，未经模型改写',
  ''
].join('\n')
const good = validateDiary(body, { affinitySummary: summary })
assert.equal(good.ok, true, JSON.stringify(good.errors))

// 理由里出现"16"这种与额度巧合的数字也必须过
const withStray = body.replace('主人问第 5 问', '主人在 16 点前后问第 5 问')
assert.equal(validateDiary(withStray, { affinitySummary: summary }).ok, true)

// 真的写错分数要被抓
const wrong = body.replace('日初 77 → 日终 81', '日初 70 → 日终 74')
const caught = validateDiary(wrong, { affinitySummary: summary })
assert.equal(caught.ok, false)
assert.ok(caught.errors[0].includes('70'), caught.errors.join('|'))
assert.ok(caught.errors[0].includes('74'), caught.errors.join('|'))

// 剩余额度（16-4=12）是合法数
const withRemain = body.replace('已用 4/16', '已用 4/16，剩 12')
assert.equal(validateDiary(withRemain, { affinitySummary: summary }).ok, true)

// 日上限换掉之后，剩余额度要跟着变（不能硬编码 10）
const s20 = { ...summary, maxDaily: 20, used: 6 }
const body20 = body.replace('已用 4/16', '已用 6/20').replace('日初 77 → 日终 81', '日初 77 → 日终 81').replace('今日净 +4', '今日净 +4')
const v20 = validateDiary(body20, { affinitySummary: s20 })
assert.equal(v20.ok, true, JSON.stringify(v20.errors))
const with14 = body.replace('已用 4/16', '已用 6/20，剩 14')
assert.equal(validateDiary(with14, { affinitySummary: s20 }).ok, true, '剩余额度必须按 maxDaily-used 算')

// 空账本的合法形态仍然通过
const empty = body.replace(/## 四、好感度[\s\S]*$/, '## 四、好感度\n- 今日无可核验的好感度记录（affinity 账本为空）\n')
assert.equal(validateDiary(empty, { affinitySummary: { score: null, net: 0, used: 0, opening: null, closing: null } }).ok, true)

// renderAffinitySection + replaceAffinitySection 端到端
const bullets = renderAffinitySection({ ...summary, reasons: ['主人问第 5 问，并关心影响面'] }, 16)
const rebuilt = replaceAffinitySection('# 2026-11-01（周日）\n\n## 一、新学到的知识\n- x\n', bullets)
assert.ok(rebuilt.includes('日初 77 → 日终 81'))
assert.ok(rebuilt.includes('第 5 问'))
assert.equal(validateDiary(rebuilt.replace('## 二、感想与认识', '## 二、感想与认识\n- y'), { affinitySummary: summary }).ok, false, '缺小节仍然要报')

console.log('VALIDATE PASS')
