import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  judge, recordJudgeFailure, readLedger, summaryForDay, ensureInitialised,
  deriveState, ledgerPaths, diaryDayOf, clampScore, withLedgerLock,
  MIN_SCORE, MAX_SCORE, INITIAL_SCORE
} from '../lib/ledger.js'
import { parseJudgeReply, judgeUserPrompt, judgeSystemPrompt, runJudge } from '../lib/judge.js'
import { buildOverview, lastDays, recentChanges, dailySeries } from '../lib/stats.js'
import { readableDays, DIARY_WINDOW_DAYS } from '../lib/route.js'
import { pickUserMessage, toolParameters, toolDescription } from '../lib/index.js'

/** 每个测试独立的临时人格根。 */
function root () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'affinity2-'));
  const rel = path.relative(os.tmpdir(), dir);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('refusing to run outside the temp directory: ' + dir);
  }
  return dir;
}

const DAY = '2026-10-31';
const NOON = new Date(2026, 9, 31, 12, 0, 0).getTime();

test('全新账本从 50 开始', () => {
  assert.equal(readLedger(root()).score, INITIAL_SCORE);
});

test('同一 turnKey 重复提交只入账一次', () => {
  const data = root();
  const first = judge(data, { turnKey: 's1:1', requestedDelta: 2, reason: '夸奖', at: NOON, day: DAY });
  assert.equal(first.ok, true);
  assert.equal(first.appliedDelta, 2);
  const second = judge(data, { turnKey: 's1:1', requestedDelta: 2, reason: '夸奖', at: NOON, day: DAY });
  assert.equal(second.duplicate, true);
  assert.equal(readLedger(data).score, 52, '重复提交不得二次加扣');
});

test('判定为 0 也留下 judge 记录，且不进变化曲线', () => {
  const data = root();
  const outcome = judge(data, { turnKey: 's1:1', requestedDelta: 0, reason: '纯技术讨论', at: NOON, day: DAY });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.appliedDelta, 0);
  const state = readLedger(data);
  assert.equal(state.judged, 1, 'judge 事件存在');
  assert.equal(state.applied, 0, '没有 adjust 事件');
  assert.equal(state.score, INITIAL_SCORE);
});

test('单次超过 ±4（默认上限）被拒绝，且不改分', () => {
  const data = root();
  const outcome = judge(data, { turnKey: 's1:1', requestedDelta: 5, reason: 'x', at: NOON, day: DAY });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'step-too-large');
  assert.equal(readLedger(data).score, INITIAL_SCORE);
});

test('小数与非整数被拒绝', () => {
  const data = root();
  assert.equal(judge(data, { turnKey: 'a', requestedDelta: 1.5, reason: 'x', at: NOON, day: DAY }).code, 'bad-delta');
  assert.equal(judge(data, { turnKey: 'b', requestedDelta: NaN, reason: 'x', at: NOON, day: DAY }).code, 'bad-delta');
});

test('日额度按绝对值累计，且超额时截断而不是丢弃', () => {
  const data = root();
  // 默认日额度 16：4×4 = 16 正好用尽。
  for (let index = 0; index < 4; index += 1) {
    const outcome = judge(data, { turnKey: 'k' + index, requestedDelta: 4, reason: 'r', at: NOON, day: DAY });
    assert.equal(outcome.ok, true, '第 ' + (index + 1) + ' 次应被接受');
  }
  const overflow = judge(data, { turnKey: 'k5', requestedDelta: 4, reason: 'r', at: NOON, day: DAY });
  assert.equal(overflow.appliedDelta, 0, '额度用尽后实际变化为 0');
  assert.equal(overflow.limitReason, 'daily-cap');
  assert.equal(readLedger(data).score, INITIAL_SCORE + 16);
});

test('额度只剩 1 点时 +2 截断为 +1 并注明', () => {
  const data = root();
  // 4×3 + 1×3 = 15，剩 1 点额度，此时再 +4 应当被截断成 +1。
  judge(data, { turnKey: 'a', requestedDelta: 4, reason: 'r', at: NOON, day: DAY });
  judge(data, { turnKey: 'b', requestedDelta: 4, reason: 'r', at: NOON, day: DAY });
  judge(data, { turnKey: 'c', requestedDelta: 4, reason: 'r', at: NOON, day: DAY });
  judge(data, { turnKey: 'd', requestedDelta: 3, reason: 'r', at: NOON, day: DAY });
  const outcome = judge(data, { turnKey: 'f', requestedDelta: 4, reason: 'r', at: NOON, day: DAY });
  assert.equal(outcome.appliedDelta, 1, '只剩 1 点额度');
  assert.equal(outcome.limitReason, 'daily-cap-truncated');
});

test('正负混合同样消耗额度，不能被洗掉', () => {
  const data = root();
  const seq = [4, -4, 4, -4, 4, -4];
  const results = seq.map((delta, index) => judge(data, { turnKey: 'm' + index, requestedDelta: delta, reason: 'r', at: NOON, day: DAY }));
  const used = results.reduce((sum, item) => sum + Math.abs(item.appliedDelta ?? 0), 0);
  assert(used <= 16, '绝对值累计不得超过 16，实际 ' + used);
});

test('达到上限后不再越界', () => {
  const data = root();
  judge(data, { turnKey: 'hi', requestedDelta: 0, reason: 'anchor', at: NOON, day: DAY });
  const state = deriveState([{ kind: 'init', value: MAX_SCORE, day: DAY, at: NOON }]);
  assert.equal(state.score, MAX_SCORE);
  assert.equal(clampScore(999), MAX_SCORE);
  assert.equal(clampScore(-999), MIN_SCORE);
});

test('判定失败写入 failed 记录且不改分', () => {
  const data = root();
  const before = readLedger(data).score;
  const outcome = recordJudgeFailure(data, { turnKey: 's9:3', error: '裁判超时', sessionId: 's9', turn: 3 });
  assert.equal(outcome.ok, true);
  const state = readLedger(data);
  assert.equal(state.score, before, '失败不得改分');
  const failed = state.events.find((event) => event.turnKey === 's9:3');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.result, 'failed');
});

test('缺少 turnKey 时拒绝计分', () => {
  const data = root();
  const outcome = judge(data, { requestedDelta: 2, reason: 'x', at: NOON, day: DAY });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'missing-turn-key');
});

test('跨 05:00 换日后额度重新计算', () => {
  const data = root();
  const lateNight = new Date(2026, 9, 31, 2, 0, 0).getTime();
  const afterCutoff = new Date(2026, 9, 31, 6, 0, 0).getTime();
  assert.equal(diaryDayOf(lateNight), '2026-10-30', '02:00 算前一天');
  assert.equal(diaryDayOf(afterCutoff), '2026-10-31', '06:00 算当天');
  const a = judge(data, { turnKey: 'x1', requestedDelta: 2, reason: 'r', at: lateNight });
  const b = judge(data, { turnKey: 'x2', requestedDelta: 2, reason: 'r', at: afterCutoff });
  assert.equal(a.usedToday, 2);
  assert.equal(b.usedToday, 2, '新的一天重新计额度');
  assert.equal(b.remaining, 14, '新的一天额度重置为 16，已用 2，剩 14');
});

test('锁被占用时释放后仍可写入', () => {
  const data = root();
  const paths = ledgerPaths(data);
  ensureInitialised(data, { at: NOON, day: DAY });
  const value = withLedgerLock(paths.lock, 1000, () => 'inside');
  assert.equal(value, 'inside');
  assert.equal(fs.existsSync(paths.lock), false, '临界区结束必须删除锁');
  assert.equal(judge(data, { turnKey: 'l1', requestedDelta: 1, reason: 'r', at: NOON, day: DAY }).ok, true);
});

test('概览包含 7/30 天序列与最近变化', () => {
  const data = root();
  judge(data, { turnKey: 'o1', requestedDelta: 2, reason: '好', at: NOON, day: DAY });
  judge(data, { turnKey: 'o2', requestedDelta: -1, reason: '差', at: NOON, day: DAY });
  const overview = buildOverview({ eventsFile: ledgerPaths(data).events, maxDaily: 10, cutoffHour: 5, now: NOON });
  assert.equal(overview.score, 51);
  assert.equal(overview.days7.length, 7);
  assert.equal(overview.days30.length, 30);
  assert.equal(overview.recentChanges.length, 2);
  assert.equal(overview.recentChanges[0].delta, 2);
  assert.equal(overview.recentChanges[1].delta, -1);
  assert.equal(overview.todayUsed, 3, '绝对值累计 2+1');
});

test('无事件日期承接前值而不是填 0', () => {
  const days = lastDays('2026-10-31', 3);
  assert.deepEqual(days, ['2026-10-29', '2026-10-30', '2026-10-31']);
  const data = root();
  const overview = buildOverview({ eventsFile: path.join(data, 'none.jsonl'), now: new Date(2026, 9, 31, 12).getTime() });
  assert.equal(overview.score, 50);
});

test('裁判解析：合法 JSON 通过', () => {
  const verdict = parseJudgeReply('{"delta": 1, "reason": "主人耐心解释"}');
  assert.equal(verdict.ok, true);
  assert.equal(verdict.delta, 1);
});

test('裁判解析：被代码块包裹也能取出', () => {
  const verdict = parseJudgeReply('```json\n{"delta": -2, "reason": "辱骂"}\n```');
  assert.equal(verdict.ok, true);
  assert.equal(verdict.delta, -2);
});

test('裁判解析：缺字段必须失败，绝不默认 0', () => {
  assert.equal(parseJudgeReply('').ok, false);
  assert.equal(parseJudgeReply('我觉得还好').ok, false);
  assert.equal(parseJudgeReply('{"delta": 5, "reason": "x"}').ok, false);
  assert.equal(parseJudgeReply('{"delta": 1}').ok, false, '没有 reason 也不接受');
  assert.equal(parseJudgeReply('{"delta": 1.5, "reason": "x"}').ok, false);
});

test('裁判提示词包含反向约束', () => {
  const prompt = judgeSystemPrompt({ maxStep: 2 });
  assert(prompt.includes('要求返工'), '必须说明返工不算冒犯');
  assert(prompt.includes('加满'), '必须说明命令不构成感情');
  assert(judgeUserPrompt({ userText: '你好', score: 70, used: 0, maxDaily: 10 }).includes('70'));
});

test('裁判提示词不得把 0 写成默认答案（A 方案回归）', () => {
  const prompt = judgeSystemPrompt({ maxStep: 2 });
  assert(!prompt.includes('这是最常见的答案'), '不得再用「这是最常见的答案」诱导判 0');
  assert(prompt.includes('不要把 0 当作默认值'), '必须显式禁止把 0 当默认值');
});

test('裁判提示词必须把技术协作中的正向信号纳入 +1（B 方案回归）', () => {
  const prompt = judgeSystemPrompt({ maxStep: 2 });
  assert(prompt.includes('认真授权'), '+1 必须覆盖「认真授权猫娘做事」');
  assert(prompt.includes('关键约束') || prompt.includes('边界要求'), '+1 必须覆盖「给出关键约束/边界要求」');
  assert(prompt.includes('认可猫娘的工作成果'), '+1 必须覆盖「认可工作成果」');
  assert(prompt.includes('关心猫娘的状态或成长'), '+1 必须覆盖「关心状态或成长」');
});

test('指出 bug 本身不扣分，但带正向信号时应判 +1 而不是 0', () => {
  const prompt = judgeSystemPrompt({ maxStep: 2 });
  assert(prompt.includes('不是冒犯'), '必须保留「指出 bug 不是冒犯」的反向约束');
  assert(prompt.includes('纯技术批评且无正向信号时才判 0'), '必须区分「纯批评」与「批评+正向信号」');
});

test('工具描述同样不得把 0 当默认值', () => {
  const description = toolDescription({ maxStep: 2, maxDaily: 10 });
  assert(!description.includes('都是正常协作，判 0'), '工具描述不得再一刀切判 0');
  assert(description.includes('不要把它当默认值'), '工具描述必须显式禁止 0 当默认值');
  assert(description.includes('认真授权你做事'), '工具描述必须同步 B 方案的正向信号');
});

test('只有真实用户消息才判分，系统注入被跳过', () => {
  const messages = [
    { role: 'user', id: 'u1', source: { kind: 'runtime-context', form: 'snapshot' }, content: [{ type: 'text', text: 'runtime' }] },
    { role: 'user', id: 'u2', source: { kind: 'user' }, content: [{ type: 'text', text: '主人真的说的话' }] }
  ];
  const picked = pickUserMessage(messages);
  assert.equal(picked.id, 'u2');
  assert.equal(picked.text, '主人真的说的话');
});

test('没有真实用户消息时返回 null', () => {
  assert.equal(pickUserMessage([{ role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'x' }] }]), null);
  assert.equal(pickUserMessage([]), null);
  assert.equal(pickUserMessage(null), null);
});

test('工具参数是合法 JSON Schema 对象', () => {
  const schema = toolParameters({ maxStep: 2 });
  assert.equal(schema.type, 'object');
  assert(Array.isArray(schema.required));
  assert.deepEqual(schema.properties.delta.enum, [-2, -1, 0, 1, 2]);
});

test('日记只开放最近 7 天', () => {
  const days = readableDays(NOON, 5);
  assert.equal(days.length, DIARY_WINDOW_DAYS);
  assert.equal(days[days.length - 1], '2026-10-31');
  assert.equal(days[0], '2026-10-25');
});

test('summaryForDay 只统计 adjust 事件，judge 的 0 分不算变化', () => {
  const data = root();
  judge(data, { turnKey: 's1', requestedDelta: 0, reason: '技术问题', at: NOON, day: DAY });
  const summary = summaryForDay(data, DAY);
  assert.equal(summary.net, 0);
  assert.equal(summary.count, 0, 'judge 不是 adjust');
  assert.equal(summary.opening, null, '没有实际变化就不编造日初');
});

test('recentChanges 只返回实际非零变化', () => {
  const events = [
    { kind: 'judge', requestedDelta: 0, appliedDelta: 0, day: DAY },
    { kind: 'adjust', delta: 2, from: 50, to: 52, day: DAY }
  ];
  const changes = recentChanges(events, 10);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].delta, 2);
});

test('初始化只发生一次，新会话继承旧分数而不是重置成 50', () => {
  const data = root();
  const first = ensureInitialised(data, { at: NOON, day: DAY });
  assert.equal(first.initialised, true);
  judge(data, { turnKey: 'r1', requestedDelta: 2, reason: '夸奖', at: NOON, day: DAY });
  const second = ensureInitialised(data, { at: NOON, day: DAY });
  assert.equal(second.initialised, false, '已有账本不得再写 init');
  assert.equal(readLedger(data).score, 52, '新会话读到的是旧分数');
});

test('runJudge 在 fiber 上下文里被拒绝访问 llm 时必须返回失败而不是抛错', async () => {
  // 真机踩过的坑：cordis fiber 里 ctx.llm 会抛
  //   cannot get property "llm" without inject
  // 如果 runJudge 不包 try/catch，异常会一路炸到外层 catch，
  // 而外层只写 logger，于是外部表现是“钩子没跑”——完全误导。
  const hostile = {
    get () { throw new Error('cannot get property "llm" without inject') }
  };
  const verdict = await runJudge(hostile, {
    provider: 'buddy',
    model: 'deepseek-v4.1-flash',
    userText: '你好',
    score: 50,
    used: 0,
    maxDaily: 10,
    maxStep: 2
  });
  assert.equal(verdict.ok, false, '必须是失败结果，不能抛');
  assert(String(verdict.error).includes('llm'), '错误信息要点明 llm 访问被拒');
});

test('runJudge 缺少 provider 时返回失败而不是抛错', async () => {
  const ctx = { get: () => ({ stream () { throw new Error('不该被调用') } }) };
  const verdict = await runJudge(ctx, {
    provider: '',
    model: 'deepseek-v4.1-flash',
    userText: '你好',
    score: 50,
    used: 0,
    maxDaily: 10,
    maxStep: 2
  });
  assert.equal(verdict.ok, false);
  assert(String(verdict.error).includes('provider'));
});

test('runJudge 缺少 model 时返回失败而不是抛错', async () => {
  const ctx = { get: () => ({ stream () { throw new Error('不该被调用') } }) };
  const verdict = await runJudge(ctx, {
    provider: 'buddy',
    model: '',
    userText: '你好',
    score: 50,
    used: 0,
    maxDaily: 10,
    maxStep: 2
  });
  assert.equal(verdict.ok, false);
  assert(String(verdict.error).includes('model'));
});

test('曲线最后一天的收盘分必须等于当前分', () => {
  // 真机踩过的坑：曲线画出 84，而当前分是 77——曲线穿过未来，一眼假。
  // 根因是锚点既没被计入当日净额、又没参与倒推，7 分被重复累加。
  const data = root();
  judge(data, { turnKey: 'a', requestedDelta: 1, reason: 'r', at: NOON, day: DAY });
  judge(data, { turnKey: 'b', requestedDelta: 1, reason: 'r', at: NOON, day: DAY });
  const overview = buildOverview({ eventsFile: ledgerPaths(data).events, maxDaily: 10, cutoffHour: 5, now: NOON });
  const last = overview.days7[overview.days7.length - 1]
  assert.equal(last.closing, overview.score, '末值必须等于当前分')
  assert.equal(overview.days7[overview.days7.length - 1].day, overview.today, '最后一天应是今天')
});

test('锚点参与曲线：其所在日收盘等于锚点值', () => {
  const data = root();
  ensureInitialised(data, { at: NOON, day: DAY });
  // 手工写一个锚点，模拟从旧账本迁移的情形
  const paths = ledgerPaths(data);
  fs.appendFileSync(paths.events, JSON.stringify({
    id: 'anchor-test', kind: 'anchor', at: NOON, day: DAY, value: 70
  }) + '\n', 'utf8');
  const overview = buildOverview({ eventsFile: paths.events, maxDaily: 10, cutoffHour: 5, now: NOON });
  const today = overview.days7[overview.days7.length - 1]
  assert.equal(today.closing, 70, '锚点日收盘应等于锚点值')
  assert.equal(overview.score, 70)
});

test('曲线不会高于当前分（不穿过未来）', () => {
  const data = root();
  judge(data, { turnKey: 'x1', requestedDelta: 2, reason: 'r', at: NOON, day: DAY });
  const overview = buildOverview({ eventsFile: ledgerPaths(data).events, maxDaily: 10, cutoffHour: 5, now: NOON });
  const max = Math.max.apply(null, overview.days7.map((row) => row.closing))
  assert(max <= overview.score, '历史任何一天都不该高于当前分，实际 ' + max + ' > ' + overview.score)
});

test('日期乱序的账本也能算对起点', () => {
  // 账本按写入顺序追加，锚点和补写都会让日期乱序。
  // 旧实现"遇到第一个 >= 首日就 break"，一旦乱序就漏算后面的增量。
  const data = root();
  const paths = ledgerPaths(data);
  ensureInitialised(data, { at: NOON, day: DAY });
  // 先写晚日期，再写早日期（乱序）
  fs.appendFileSync(paths.events, JSON.stringify({
    id: 'late', kind: 'adjust', at: NOON, day: '2026-11-02', delta: 2, from: 50, to: 52
  }) + '\n', 'utf8');
  fs.appendFileSync(paths.events, JSON.stringify({
    id: 'early', kind: 'adjust', at: NOON, day: '2026-10-20', delta: 1, from: 50, to: 51
  }) + '\n', 'utf8');
  const events = fs.readFileSync(paths.events, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  // 区间 10-25、10-26 内没有事件，所以两天收盘都等于「10-25 之前那一刻」的分。
  //
  // 注意 init 落在 10-31，**晚于**区间首日 10-25，所以它不算"区间之前"，
  // 不参与倒推；只有 10-20 的 +1 在区间之前，会被扣掉。
  // 当前分传 53（50+1+2），倒推扣 1 → 52。
  //
  // 这里的关键是用 53 而不是 52：如果实现把区间之后的 11-02 那条也扣了，
  // 就会得到 51，测试能抓住。
  const series = dailySeries(events, ['2026-10-25', '2026-10-26'], 53)
  assert.equal(series[0].closing, 52, '只扣区间之前的变化')
  assert.equal(series[1].closing, 52, '区间内无事件，第二天不变')
});