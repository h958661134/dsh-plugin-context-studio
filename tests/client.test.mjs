import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = (await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')).replace('return module.exports;', 'exports.test = { request, StudioPage, Inspector, Board, Dialog, LineageDetail }; return module.exports;')
function harness({ fetch = () => new Promise(()=>{}), saved = {}, storageFails = false } = {}) {
  let cursor = 0, values = [], effects = [], pending = [], api, tree
  const timers = new Map(); let timerId=0
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState(init) { const i=cursor++; if (!(i in values)) values[i] = typeof init === 'function' ? init() : init; return [values[i], value=>{values[i] = typeof value === 'function' ? value(values[i]) : value}] },
    useRef(value) { const i=cursor++; if (!(i in values)) values[i]={current:value}; return values[i] },
    useMemo(fn) { cursor++; return fn() },
    useEffect(fn,deps) { const i=cursor++; if (!effects[i] || deps.some((d,j)=>d!==effects[i].deps[j])) pending.push(()=>{ effects[i]?.cleanup?.(); effects[i]={deps,cleanup:fn()} }) },
  }
  const context = vm.createContext({
    window:{__ModuleLoader__:{load({factory}) { api=factory(()=>react).test }}},
    fetch, AbortController, console, navigator:{clipboard:{writeText:async()=>{}}},
    localStorage:{ getItem:k=> k in saved ? JSON.stringify(saved[k]) : null, setItem(k,v){ if(storageFails) throw Error('quota'); saved[k]=JSON.parse(v) } },
    setTimeout(fn,ms){const id=++timerId;timers.set(id,{fn,ms});return id}, clearTimeout(id){timers.delete(id)},
  })
  vm.runInContext(source,context)
  return { api, timers, context, render(component,props={}) {cursor=0;tree=component(props); const jobs=pending;pending=[];jobs.forEach(f=>f()); return tree}, unmount(){effects.forEach(e=>e?.cleanup?.())} }
}
const tick = () => new Promise(setImmediate)
const nodes = root => !root || typeof root !== 'object' ? [] : Array.isArray(root) ? root.flatMap(nodes) : [root,...nodes(root.children),...nodes(root.props?.branch)]
const text = root => JSON.stringify(root)
const json = d => ({ ok:true,json:async()=>d })

test('GET fetch 或 JSON 永不返回，均能截止退出并中止；写请求结果未知且不重放', async () => {
  for (const bodyPending of [false,true]) {
    let signal, calls=0
    const h=harness({fetch:async(_,opts)=>{calls++;signal=opts.signal;return bodyPending?{ok:true,json:()=>new Promise(()=>{})}:await new Promise(()=>{})}})
    const result = h.api.request('/inspect',undefined)
    const rejected=assert.rejects(result,/读取超时/)
    Array.from(h.timers.values()).find(t=>t.ms===25000).fn()
    await rejected;assert.equal(signal.aborted,true);assert.equal(calls,1)
  }
  let calls=0
  const h=harness({fetch:()=>{calls++;return new Promise(()=>{})}})
  const result=h.api.request('/write',{items:[]})
  const rejected=assert.rejects(result,/操作结果未知/)
  Array.from(h.timers.values())[0].fn(); await rejected;assert.equal(calls,1)
})

test('默认回答排查只加载会话目录，不等待 graph 或扫描文件；切项目取消旧查询', async () => {
  const requests=[]
  const h=harness({fetch:(url,opts)=>{requests.push({url,signal:opts.signal});return new Promise(()=>{})}})
  h.render(h.api.StudioPage)
  assert.ok(requests.some(r=>r.url.includes('/sessions?project=global')))
  assert.equal(requests.some(r=>r.url.includes('/graph')||r.url.includes('/pieces')),false)
  h.unmount()
  assert.equal(requests.find(r=>r.url.includes('/sessions')).signal.aborted,true)
})

test('会话 A 晚到不会覆盖 B；切换会话会中止旧历史请求', async () => {
  const jobs=[]
  const h=harness({fetch:(url,opts)=>new Promise(resolve=>jobs.push({url,opts,resolve}))})
  const snapshot={sessionId:'B',boundary:0,answer:null,timeline:[],timelineInfo:{total:0},modules:[],warnings:[],summary:{active:0,added:0},flow:{comparison:{available:true,first:true,added:0,retained:0,removed:0},scope:'changes',page:{index:0,total:0,pages:0},nodes:[],anchors:[],edges:[],guidance:[]}}
  const props={session:{id:'A',title:'A'},has:()=>false}
  h.render(h.api.Inspector,props)
  assert.match(jobs[0].url,/\/inspect-flow\?id=A/)
  h.render(h.api.Inspector,{...props,session:{id:'B',title:'B'}})
  assert.equal(jobs[0].opts.signal.aborted,true)
  jobs[1].resolve(json(snapshot));await tick()
  jobs[0].resolve(json({error:'OLD A'}));await tick()
  vm.runInContext('Array.prototype.findLast = undefined',h.context)
  const tree=h.render(h.api.Inspector,{...props,session:{id:'B',title:'B'}})
  assert.doesNotMatch(text(tree),/OLD A|正在读取/)
  assert.match(text(tree),/还没有模型回答/)
})

test('取消拖拽后删除原项，再拖入外部文本不会插入 undefined', () => {
  const h=harness();let changed=false
  const a={key:'a',kind:'note',text:'a'},b={key:'b',kind:'note',text:'b'}
  let tree=h.render(h.api.Board,{items:[a,b],onChange:()=>{changed=true}})
  const transfer={data:{},getData(k){return this.data[k]||''},setData(k,v){this.data[k]=v}}
  const row=nodes(tree).filter(n=>n.props?.draggable)[1]
  row.props.onDragStart({dataTransfer:transfer});row.props.onDragEnd()
  tree=h.render(h.api.Board,{items:[a],onChange:()=>{changed=true}})
  tree.props.onDrop({preventDefault(){},dataTransfer:{getData:()=>''}})
  assert.equal(changed,false)
})

test('损坏草稿能恢复界面且不覆盖原值；存储失败显示持久提示', () => {
  const key='dsh-context-studio:board'
  for (const bad of [{},[null]]) {
    const saved={[key]:bad};const h=harness({saved})
    assert.match(text(h.render(h.api.StudioPage)),/原始数据仍保留/)
    assert.deepEqual(saved[key],bad)
  }
  const h=harness({storageFails:true});h.render(h.api.StudioPage)
  assert.match(text(h.render(h.api.StudioPage)),/草稿尚未保存/)
})

test('确认操作期间无法关闭；同步异常也能解除 busy', async () => {
  let closes=0
  const h=harness(),props={dialog:{title:'确认',onConfirm(){throw Error('failed')}},onClose(){closes++}}
  let tree=h.render(h.api.Dialog,props)
  nodes(tree).find(n=>n.props?.onClick && n.children?.includes('确定')).props.onClick()
  tree=h.render(h.api.Dialog,props);tree.props.onClick()
  assert.equal(closes,0);assert.match(text(tree),/处理中/)
  await tick();tree=h.render(h.api.Dialog,props)
  assert.doesNotMatch(text(tree),/处理中/)
})

test('刚编辑即复制仍生成新正文，compose 失败绝不复制错误提示', async () => {
  let copied=[],fail=false
  const h=harness({saved:{'dsh-context-studio:board':[{key:'a',kind:'note',text:'OLD'}]},fetch:async(url,opts)=> {
    if(url.endsWith('/compose')) { if(fail)throw Error('offline');return json({text:JSON.parse(opts.body).items[0].text}) }
    if(url.endsWith('/projects'))return json({projects:[]})
    if(url.endsWith('/journal'))return json({ops:[]})
    return json({sessions:[]})
  }})
  h.context.navigator.clipboard.writeText=async text=>{copied.push(text)}
  let tree=h.render(h.api.StudioPage)
  nodes(tree).find(n=>n.type===h.api.Board).props.onChange([{key:'b',kind:'note',text:'NEW'}])
  tree=h.render(h.api.StudioPage)
  await nodes(tree).find(n=>n.children?.includes('复制')).props.onClick()
  assert.deepEqual(copied,['NEW'])
  fail=true
  await nodes(tree).find(n=>n.children?.includes('复制')).props.onClick()
  assert.deepEqual(copied,['NEW'])
})

test('文件读取失败显示未知，不能显示已删除或当前版本', () => {
  const h=harness()
  const m={key:'m',kind:'instruction',label:'AGENTS.md',cls:'single',chains:[],exists:null,uses:[{sessionId:'s',current:null}],transplants:[]}
  const tree=h.render(h.api.LineageDetail,{graph:{memories:[m],chains:[]},selection:{type:'memory',id:'m'},sessionById:{s:{id:'s',title:'Session'}}})
  assert.match(text(tree),/文件读取未完成，状态未知/)
  assert.match(text(tree),/版本未知/)
  assert.doesNotMatch(text(tree),/文件已经不在|当前版本/)
})
