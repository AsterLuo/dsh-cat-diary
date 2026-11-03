import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const source = fs.readFileSync(ROOT + '/client/client.js', 'utf8')

// ---- React 桩 ----
//
// 不是为了跑真 React：要抓的是"渲染时引用未定义变量 / 拼错字段名 / 少一层
// children"这类会直接白屏的错。所以这里实现的是**按调用顺序编号的插槽**，
// 同一次组件调用内顺序稳定，跨调用保留上次的值（这才叫 state）。
function makeReact () {
  const slots = []
  let cursor = 0
  const api = {
    createElement: (type, props, ...children) => ({
      type,
      props: props ?? {},
      children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false)
    }),
    useState: (initial) => {
      const index = cursor
      cursor += 1
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      const setter = (next) => { slots[index] = typeof next === 'function' ? next(slots[index]) : next }
      return [slots[index], setter]
    },
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: () => ({ current: null }),
    useMemo: (fn) => fn(),
    // 每次重新调用组件函数前重置游标，模拟一次 render
    __begin: () => { cursor = 0 },
    __slots: slots
  }
  return api
}

const flat = (node, out = []) => {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { node.forEach((child) => flat(child, out)); return out }
  if (node && node.children) node.children.forEach((child) => flat(child, out))
  return out
}
const findByClass = (node, cls, out = []) => {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) { node.forEach((child) => findByClass(node === null ? child : child, cls, out)); return out }
  if (node.props && node.props.className === cls) out.push(node)
  if (node.children) node.children.forEach((child) => findByClass(child, cls, out))
  return out
}

function loadModule (react) {
  let captured = null
  const windowStub = { __ModuleLoader__: { load: (definition) => { captured = definition } } }
  const documentStub = {
    createElement: () => ({ setAttribute () {}, textContent: '', style: {} }),
    head: { appendChild () {} },
    body: { appendChild () {} }
  }
  const factory = new Function('window', 'document', 'fetch', source + '\n//#sourceURL=client.js')
  factory(windowStub, documentStub, globalThis.fetch)
  return captured.factory((name) => {
    if (name === 'react') return react
    throw new Error('unexpected require ' + name)
  })
}

const render = (react, mod, props) => {
  react.__begin()
  return mod.ModelPicker(props)
}

// ---- 场景 1：首次渲染是 loading，不能先画"空" ----
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, groups: [], failures: [], current: null }) })
const react1 = makeReact()
const mod1 = loadModule(react1)
const tree1 = render(react1, mod1, { onClose () {}, onSaved: null })
const texts1 = flat(tree1).join('|')
assert.ok(texts1.includes('正在读取模型清单'), texts1.slice(0, 200))
assert.ok(!texts1.includes('宿主没有任何可用的模型渠道'), '拿到空目录之前不该断言"没有渠道"')
assert.ok(texts1.includes('跟随默认') && texts1.includes('保存'), '底部三个动作要在')

// ---- 场景 2：有目录、当前是已保存值 ----
const catalog = {
  ok: true,
  groups: [
    { id: 'alpha', name: 'Alpha Gateway', models: [
      { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', reasoning: { efforts: [{ id: 'low', name: '低' }, { id: 'high', name: '高' }], defaultEffort: 'high' } },
      { id: 'glm-5.3', name: 'GLM 5.3' }
    ] },
    { id: 'gateway', name: '聚合网关', models: [{ id: 'some-model-1017', name: 'Some Model 1017' }] }
  ],
  failures: [{ id: 'beta', name: 'Beta Gateway', message: 'listModels 超时' }],
  current: { provider: 'alpha', model: 'deepseek-v4.1-flash', reasoningEffort: 'high', source: 'stored' }
}
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => catalog })

const react2 = makeReact()
const mod2 = loadModule(react2)
// 先渲染一次建出全部插槽，再按真实顺序灌值。
// 插槽顺序就是组件里 useState 的出现顺序，改组件时必须同步改这里：
// 0=purpose 1=state 2=picked 3=effort 4=saving 5=message
render(react2, mod2, { onClose () {}, onSaved: null })
const slots = react2.__slots
assert.equal(slots.length, 6, 'ModelPicker 的 useState 数量变了，测试要同步：' + slots.length)
const diaryEntry = { provider: 'alpha', model: 'deepseek-v4.1-flash', reasoningEffort: 'high', source: 'stored' }
slots[0] = 'diary'
slots[1] = {
  phase: 'ready',
  groups: catalog.groups,
  failures: catalog.failures,
  current: catalog.current,
  purposes: { diary: diaryEntry, judge: { source: 'session' } },
  error: null
}
slots[2] = { provider: 'alpha', model: 'deepseek-v4.1-flash' }
slots[3] = 'high'
slots[4] = false
slots[5] = null

const tree2 = render(react2, mod2, { onClose () {}, onSaved: null })
const texts2 = flat(tree2).join('|')
assert.ok(texts2.includes('alpha / deepseek-v4.1-flash · high'), '当前值要带上思考等级：' + texts2.slice(0, 300))
assert.ok(texts2.includes('（已保存）'), '要标明来源')
assert.ok(texts2.includes('Alpha Gateway') && texts2.includes('聚合网关'), '渠道名要显示')
assert.ok(texts2.includes('DeepSeek V4.1 Flash') && texts2.includes('GLM 5.3'), '模型名要显示')
assert.ok(texts2.includes('Beta Gateway') && texts2.includes('listModels 超时'), '读不到的渠道要连同原因列出')

const models = findByClass(tree2, 'cd-model')
assert.equal(models.length, 3, '三个模型都要渲染') 
assert.equal(models.filter((node) => node.props['data-on'] === '1').length, 1, '只能有一个选中')
const efforts = findByClass(tree2, 'cd-effort')
assert.equal(efforts.length, 2, '只有选中的模型展开思考等级')
assert.equal(efforts.filter((node) => node.props['data-on'] === '1').length, 1, '思考等级只能选中一个')

// ---- 场景 3：点第二个渠道的模型 -> 选中态转移，且没有思考等级展开 ----
const target = findByClass(tree2, 'cd-model').find((node) => flat(node).join('').includes('Some Model 1017'))
assert.ok(target, '要能找到 gateway 的那个模型')
target.props.onClick()
const tree3 = render(react2, mod2, { onClose () {}, onSaved: null })
const models3 = findByClass(tree3, 'cd-model')
assert.equal(models3.filter((node) => node.props['data-on'] === '1').length, 1)
const on3 = models3.find((node) => node.props['data-on'] === '1')
assert.ok(flat(on3).join('').includes('1017'), '选中态要跟到新模型上')
assert.equal(findByClass(tree3, 'cd-effort').length, 0, '新模型没有思考等级就不该展开')

console.log('CLIENT RENDER PASS')