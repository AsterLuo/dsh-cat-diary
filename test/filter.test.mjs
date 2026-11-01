import test from 'node:test'

import {
  isReplayedSummary,
  isInjectedContext,
  clampMessage,
  normalizeWhitespace,
  userMessageText,
  assistantMessageParts,
  DEFAULT_MESSAGE_CAP
} from '../lib/filter.js'
import { assert, assertEqual } from './helpers.mjs'

test('detects a compaction summary by its heading', () => {
  const text = '## Primary Request and Intent\n- 修插件\n## Key Technical Concepts\n- retry'
  assertEqual(isReplayedSummary(text), true, 'heading is decisive')
})

test('detects a Chinese summary heading', () => {
  assertEqual(isReplayedSummary('## 关键信息\n- 一些内容'), true, 'localized heading')
})

test('detects a summary by two markers in the head', () => {
  const text = '一些前缀\nPrimary Request and Intent\nPending Tasks\n'
  assertEqual(isReplayedSummary(text), true, 'two markers are enough')
})

test('detects a large message that quotes user requests verbatim', () => {
  const text = `前情\nUser request verbatim: 「做点事」\n${'x'.repeat(20000)}`
  assertEqual(isReplayedSummary(text), true, 'large verbatim replay')
})

test('does NOT flag an ordinary user message that merely mentions "summary"', () => {
  assertEqual(isReplayedSummary('帮我加个 summary 按钮，点一下生成摘要'), false, 'normal request stays')
})

test('does NOT flag a normal long message without summary markers', () => {
  const text = '这是一段很长的说明。'.repeat(1000)
  assertEqual(isReplayedSummary(text), false, 'length alone is not evidence')
})

test('does NOT flag an empty or non-string message', () => {
  assertEqual(isReplayedSummary(''), false, 'empty')
  assertEqual(isReplayedSummary(null), false, 'null')
  assertEqual(isReplayedSummary(undefined), false, 'undefined')
})

test('a single marker is not enough (avoids false positives)', () => {
  const text = `请看一下 Current Work 那一节\n${'y'.repeat(300)}`
  assertEqual(isReplayedSummary(text), false, 'one marker must not flag')
})

test('harness-authored context is not mistaken for the owner speaking', () => {
  assertEqual(isInjectedContext('<system-reminder>\nA skill is reusable'), true, 'system-reminder')
  assertEqual(isInjectedContext('Instructions from: $DSH_HOME/AGENTS.md'), true, 'AGENTS injection')
  assertEqual(isInjectedContext('Current runtime context. This snapshot supersedes earlier'), true, 'runtime snapshot')
  assertEqual(isInjectedContext('<available_skills>\n- onetake'), true, 'skill catalog')
})

test('a normal message that merely mentions a reminder is not filtered', () => {
  assertEqual(isInjectedContext('给提醒功能加个 system-reminder 样式'), false, 'ordinary request')
  assertEqual(isInjectedContext('Current runtime context 这个标题太长了吧'), false, 'discussing the phrase')
  assertEqual(isInjectedContext(''), false, 'empty')
})

test('clampMessage truncates to the cap and says so', () => {
  const { text, truncated } = clampMessage('字'.repeat(2000), 100)
  assertEqual(truncated, true, 'was truncated')
  assert(text.startsWith('字'.repeat(100)), 'keeps the head')
  assert(text.includes('已截断'), 'marks the cut')
})

test('clampMessage leaves a short message untouched', () => {
  const { text, truncated } = clampMessage('  hello   world  ', DEFAULT_MESSAGE_CAP)
  assertEqual(truncated, false, 'not truncated')
  assertEqual(text, 'hello   world', 'trimmed but internal spacing preserved')
})

test('normalizeWhitespace collapses blank-line runs', () => {
  assertEqual(normalizeWhitespace('a\n\n\n\n b\r\n'), 'a\n\n b', 'collapsed')
})

test('userMessageText joins text parts and marks media', () => {
  const record = { data: { content: [{ type: 'text', text: '看这个' }, { type: 'image' }] } }
  assertEqual(userMessageText(record), '看这个\n[图片，未解析]', 'media is referenced, not invented')
})

test('assistantMessageParts drops reasoning and keeps only tool names', () => {
  const record = {
    data: {
      message: {
        content: [
          { type: 'reasoning', text: '很长的内部推理' },
          { type: 'text', text: '结论是 A' },
          { type: 'tool-call', name: 'pwsh', arguments: '{"command":"secret"}' }
        ]
      }
    }
  }
  const { text, tools } = assistantMessageParts(record)
  assertEqual(text, '结论是 A', 'reasoning is excluded')
  assertEqual(tools, ['pwsh'], 'tool name kept')
  assert(!JSON.stringify({ text, tools }).includes('secret'), 'tool arguments never leak through')
})
