import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const source = fs.readFileSync(path.join(ROOT, 'client/client.js'), 'utf8')

// ---- 极简 React 桩：只做"能渲染出树"这件事 ----
//
// 目的不是跑真实 React，而是抓住"组件里引用了未定义的变量 / 拼错字段名"
// 这类会直接白屏的错误。真实 React 的 hooks 语义不在这里验证。
const hooks = { effects: 0 }
const reactStub = {
  createElement: (type, props, ...children) => ({
    kind: typeof type === 'string' ? 'tag' : (typeof type === 'function' ? 'component:' + (type.name || '?') : 'other'),
    type,
    props: props ?? {},
    children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false)
  }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => { hooks.effects += 1 },
  useCallback: (fn) => fn,
  useRef: () => ({ current: null }),
  useMemo: (fn) => fn()
}

let captured = null
globalThis.window = {
  __ModuleLoader__: {
    load: (definition) => { captured = definition }
  }
}
globalThis.document = {
  createElement: () => ({ setAttribute () {}, textContent: '', style: {} }),
  head: { appendChild () {} },
  body: { appendChild () {} }
}
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, groups: [], failures: [], current: null }) })

// 求值客户端模块
const factory = new Function('window', 'document', 'fetch', source + '\n//#sourceURL=client.js')
factory(globalThis.window, globalThis.document, globalThis.fetch)

assert.ok(captured !== null, '客户端必须通过 __ModuleLoader__ 注册')
assert.equal(captured.id, 'dsh-cat-diary')
const exports = captured.factory((name) => {
  if (name === 'react') return reactStub
  throw new Error('unexpected require: ' + name)
})

// ---- 导出面 ----
assert.equal(exports.MODEL_ROUTE, '/dsh-cat-diary/diary/model')
assert.equal(typeof exports.ModelPicker, 'function')
assert.equal(typeof exports.apply, 'function')
assert.deepEqual(exports.inject, ['slots'])

// ---- 渲染弹窗（空目录状态） ----
const tree = exports.ModelPicker({ onClose: () => {}, onSaved: null })
assert.equal(tree.props.className, 'cd-mask')
const modal = tree.children[0]
assert.equal(modal.props.className, 'cd-modal')
assert.equal(modal.props.role, 'dialog')
// 五段结构：head / tabs / current / body / foot
// （页签是 2026-11-03 加的：补写日记与判好感各自有独立的选择）
const classes = modal.children.map((child) => child.props.className)
assert.deepEqual(classes, ['cd-modal-head', 'cd-tabs', 'cd-modal-current', 'cd-modal-body', 'cd-modal-foot'])

// 标题与当前值都真的渲染出来了
const flat = (node, out = []) => {
  if (node === null || node === undefined) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { node.forEach((child) => flat(child, out)); return out }
  if (node.children) node.children.forEach((child) => flat(child, out))
  return out
}
const texts = flat(tree).join('|')
assert.ok(texts.includes('模型设置'), texts.slice(0, 200))
assert.ok(texts.includes('补写日记') && texts.includes('判好感'), '两个用途页签都要在：' + texts.slice(0, 300))
assert.ok(texts.includes('正在读取模型清单'), texts.slice(0, 300))
assert.ok(texts.includes('跟随默认'))
assert.ok(texts.includes('保存'))

// ---- 顶栏两个图标按钮：刷新只放图标，不再有文字 ----
assert.ok(source.includes("h(IconButton, {"), '顶栏必须用图标按钮')
assert.ok(!source.includes("'刷新中' : '刷新'"), '刷新按钮不应再有可切换的文字')
assert.ok(source.includes('function IconRefresh'), '刷新图标要有定义')
assert.ok(source.includes('function IconSliders'), '设置图标要有定义')
assert.ok(source.includes('function purposeLabel'), '用途文案要有统一定义')

// ---- 设置按钮必须在刷新按钮之前（刷新留在最右） ----
const setIdx = source.indexOf("title: '模型设置（补写日记 / 判好感）'")
const refreshIdx = source.indexOf("title: state.phase === 'refreshing' ? '刷新中…' : '刷新'")
assert.ok(setIdx > 0 && refreshIdx > setIdx, '设置要排在刷新左边')

console.log('CLIENT PASS')
