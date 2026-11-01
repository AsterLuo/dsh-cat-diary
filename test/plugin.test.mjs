import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'

import { apply, buildBriefFor, collect, inject, name as pluginName } from '../lib/index.js'
import { composeDiary, writeDiary } from '../lib/diary.js'
import { renderAffinityHeader } from '../lib/affinity-reader.js'
import { tempRoot, assert, assertEqual, assertIsolated, writeFakeSession, sessionHeader, userRecord } from './helpers.mjs'

/**
 * A cordis-like context that records what the plugin tried to do.
 * @returns {{ctx: object, registered: object[], disposed: boolean[]}} the fake host.
 */
function fakeContext () {
  const registered = []
  const disposed = []
  const ctx = {
    logger: { warn: (message) => registered.push({ kind: 'warn', message }) },
    systemPrompt: {
      context: (definition) => {
        registered.push({ kind: 'context', definition })
        return () => {}
      }
    },
    set: (name, value) => registered.push({ kind: 'service', name, value }),
    on: (event, handler) => {
      if (event === 'dispose') disposed.push(handler)
    }
  }
  return { ctx, registered, disposed }
}

/**
 * Build an isolated data root holding one diary.
 * @returns {{dataRoot: string, day: string}} fixture.
 */
function withDiary () {
  const dataRoot = tempRoot()
  assertIsolated(dataRoot, 'plugin')
  const day = '2026-10-30'
  writeDiary(dataRoot, day, composeDiary(day, {
    knowledge: ['多帧 zstd 必须逐帧解'],
    thoughts: ['我今天才明白记忆不是窗口'],
    impression: ['主人要产物级证据'],
    affinity: ['58 → 62']
  }))
  return { dataRoot, day }
}

test('inject is a plain array, the only shape cordis actually gates on', () => {
  // `export const inject = { optional: [...] }` is accepted by the loader and then
  // ignored: apply() runs with ctx.systemPrompt still undefined. The plugin then
  // looks installed and healthy while contributing zero context. Array only.
  assert(Array.isArray(inject), 'inject must be an array, not { required, optional }')
  assert(inject.includes('systemPrompt'), 'systemPrompt is the hard dependency')
  // `affinity` must NOT be here. `inject` is a hard wait, so naming a service that
  // may never be provided means apply() never runs and the whole diary vanishes —
  // observed, not theorised. The score is optional; the diary is not.
  assert(!inject.includes('affinity'), 'affinity must be OPTIONAL: inject would block apply() forever without it')
  assertEqual(typeof pluginName, 'string', 'plugin name is exported')
  assert(pluginName !== '', 'plugin name is not empty')
})

test('the diary still loads and renders when no affinity service exists', () => {
  // The affinity plugin being absent must cost the diary the score line, not the card.
  const dataRoot = tempRoot()
  assertIsolated(dataRoot, 'plugin-no-affinity')
  const header = renderAffinityHeader({ score: null, net: 0, used: 0 }, 10)
  assert(header.includes('未记录'), 'the score is reported as unknown rather than guessed')
  const { ctx, registered } = fakeContext()
  apply(ctx, { dshHome: path.dirname(path.dirname(dataRoot)) })
  const definition = registered.find((item) => item.kind === 'context').definition
  assert(typeof definition.text({}) === 'string', 'the card still renders without affinity')
})

test('apply() registers a dynamic context and never throws', () => {
  const { dataRoot } = withDiary()
  const { ctx, registered } = fakeContext()
  apply(ctx, { dshHome: path.dirname(path.dirname(dataRoot)), briefBytes: 2000 })
  const contexts = registered.filter((item) => item.kind === 'context')
  assertEqual(contexts.length, 1, 'exactly one context registered')
  assertEqual(contexts[0].definition.name, 'cat-diary-brief', 'context is named')
})

test('the context uses the host field name `text`, never `render`', () => {
  // PromptContext is { name, order, text }. Handing the host `render` throws
  // nowhere — the host simply renders an empty string, so the plugin looks
  // loaded while contributing nothing. This is the guard against that regression.
  const { dataRoot } = withDiary()
  const { ctx, registered } = fakeContext()
  apply(ctx, { dshHome: path.dirname(path.dirname(dataRoot)) })
  const definition = registered.find((item) => item.kind === 'context').definition
  assertEqual(typeof definition.text, 'function', 'PromptContext.text must be a provider function')
  assertEqual(definition.render, undefined, 'a `render` field is ignored by the host, so it must not appear')
  assert(Number.isFinite(definition.order), 'order must be finite or the host throws')
  assert(definition.order > 120, 'order sits after the reserved policy slots (110/115/120)')
  const rendered = definition.text({})
  assert(typeof rendered === 'string', 'text provider returns a string, never a promise')
  assert(rendered.includes('昨日速读'), 'card carries its own header')
})

test('a broken host (no systemPrompt) still loads without throwing', () => {
  const { dataRoot } = withDiary()
  const bare = { logger: { warn: () => {} } }
  let threw = false
  try {
    apply(bare, { dshHome: path.dirname(path.dirname(dataRoot)) })
  } catch {
    threw = true
  }
  assertEqual(threw, false, 'a host without systemPrompt must not crash the plugin')
})

test('a host whose context() throws is contained', () => {
  const { dataRoot } = withDiary()
  const hostile = {
    logger: { warn: () => {} },
    systemPrompt: { context: () => { throw new Error('host refused') } },
    set: () => {}
  }
  let threw = false
  try {
    apply(hostile, { dshHome: path.dirname(path.dirname(dataRoot)) })
  } catch {
    threw = true
  }
  assertEqual(threw, false, 'a throwing host must be caught, not propagated')
})

test('an unresolvable path disables the plugin instead of crashing DSH', () => {
  const { ctx } = fakeContext()
  let threw = false
  try {
    apply(ctx, { dshHome: '\u0000invalid\u0000' })
  } catch {
    threw = true
  }
  assertEqual(threw, false, 'path failures degrade, never throw')
})

test('the brief falls back to an older day and marks it stale', () => {
  const { dataRoot } = withDiary()
  // Ask for a day whose yesterday (10-31) has no diary: 10-30 must be used, marked stale.
  const card = buildBriefFor(dataRoot, '2026-11-01', { briefBytes: 3000 })
  assertEqual(card.day, '2026-10-30', 'fell back to the newest available day')
  assertEqual(card.stale, true, 'and admitted it is stale')
})

test('the brief prefers yesterday when it exists', () => {
  const { dataRoot } = withDiary()
  const card = buildBriefFor(dataRoot, '2026-10-31', { briefBytes: 3000 })
  assertEqual(card.day, '2026-10-30', 'used yesterday')
  assertEqual(card.stale, false, 'not stale')
})

test('collect() writes raw material for a day without a host running', () => {
  const base = tempRoot()
  assertIsolated(base, 'plugin-collect')
  const dshHome = path.join(base, 'dsh-home')
  writeFakeSession(path.join(dshHome, 'sessions', 'w', 'session-x', 'session.v4.jsonl.zstd'), [
    sessionHeader({ id: 'session-x' }),
    userRecord('你好', new Date(2026, 9, 30, 22).getTime())
  ])
  const result = collect({ dshHome, day: '2026-10-30' })
  assert(result.kept >= 1, 'collected the message')
  assert(fs.existsSync(path.join(base, 'dsh-home', 'storages', 'dsh-cat-diary', 'default', 'raw', '2026-10-30.md')), 'raw file written under storages')
})
