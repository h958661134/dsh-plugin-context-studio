import { test } from 'node:test'
import assert from 'node:assert/strict'
import { indexContext, contextView, contextDetail, sourcePage, createContextReader, VIEW_LIMITS } from '../lib/context-view.js'
import { inspectLog } from '../lib/inspect.js'
import { createHandlers, resolveConfig } from '../lib/host.js'

const msg = (seq, type, text, source = { kind: 'user' }, extra = {}) => ({ seq, type, time: 1000 + seq, surfaceOp: 'append', data: type === 'user/message' ? { content: [{ type: 'text', text }], source } : { turn: 1, step: 1, message: { content: [{ type: 'text', text }], source } }, ...extra })
const log = events => ({ session: { id: 's' }, events })

test('工具结果可追溯到白名单调用原文，仍不可读取未来调用和请求头', async () => {
  const call = { seq: 0, type: 'tool/call', data: { callId: 'read-1', name: 'read', arguments: '{"file":"SKILL.md"}', private: 'SYNTHETIC-HIDDEN' } }
  const result = msg(1, 'tool/result', '步骤……'); result.data.message.toolCallId = 'read-1'; result.sourceEventSeqs = [0]
  const index = await indexContext(log([call, result, { seq: 2, type: 'request/header', data: { secret: 'SYNTHETIC-HIDDEN' } }, msg(3, 'assistant/message', 'answer'), { ...call, seq: 4, data: { ...call.data, callId: 'future' } }]), 3)
  const detail = contextDetail(index, 0)
  assert.equal(detail.row.status, 'source')
  assert.equal(detail.row.module, 'tools')
  assert.match(detail.text, /SKILL.md/)
  assert.equal(detail.incomplete, false)
  assert.equal(JSON.stringify(detail).includes('SYNTHETIC-HIDDEN'), false)
  assert.throws(() => contextDetail(index, 2), e => e.status === 404)
  assert.throws(() => contextDetail(index, 4), e => e.status === 404)
})

test('超过旧版累计字符和行数仍能看到模块、选回答与逐页记录', async () => {
  const events = Array.from({ length: 2300 }, (_, i) => msg(i, 'user/message', 'x'.repeat(2048)))
  events.push(msg(2300, 'assistant/message', 'latest answer'))
  assert.throws(() => inspectLog(log(events)), e => e.status === 413)
  const index = await indexContext(log(events))
  const view = contextView(index)
  assert.equal(view.summary.active, 2300)
  assert.equal(view.modules.find(m => m.id === 'requirements').active, 2300)
  assert.equal(view.page.items.length, 16)
  assert.ok(JSON.stringify(view).length < 20000)
  assert.equal(contextView(index, { page: 1 }).page.items[0].seq, 16)
  assert.equal(contextView(index, { page: 9999 }).page.items.at(-1).seq, 2299)
  assert.equal(contextDetail(index, 2299).text.length, 2048)
})

test('多兆单条原文可连续分页还原，页面大小有界且末尾不丢失', async () => {
  const original = 'AB中\n'.repeat(300000) + 'TAIL-MUST-SURVIVE'
  const index = await indexContext(log([msg(0,'user/message',original),msg(1,'assistant/message','answer')]))
  let offset=0, restored=''
  do {
    const page=contextDetail(index,0,offset)
    assert.ok(page.text.length <= VIEW_LIMITS.text)
    assert.equal(page.totalChars,original.length)
    assert.equal(page.incomplete,false,'分页不是内容不完整')
    restored+=page.text;offset=page.nextOffset
  } while(offset!==null)
  assert.equal(restored,original)
  assert.match(restored,/TAIL-MUST-SURVIVE$/)
})

test('模块目录不读取未选模块的大正文，只为当前页生成预览', async () => {
  const hidden=msg(0,'user/message','', {kind:'agent-instructions'})
  Object.defineProperty(hidden.data.content[0],'text',{get(){throw Error('unselected body read')}})
  const index=await indexContext(log([hidden,msg(1,'user/message','question'),msg(2,'assistant/message','answer')]))
  const view=contextView(index,{module:'requirements'})
  assert.equal(view.modules.find(m=>m.id==='memory').active,1)
  assert.equal(view.page.items[0].preview,'question')
})

test('历史顺序与替换位置保留，未来内容不混入较早回答', async () => {
  const events=[msg(0,'system/message','old'),msg(1,'user/message','question'),msg(2,'assistant/message','first'),msg(3,'system/message','new',{}, {surfaceOp:{op:'replace',startSeq:0,endSeq:0},sourceEventSeqs:[0]}),msg(4,'assistant/message','last')]
  const old=await indexContext(log(events),2),latest=await indexContext(log(events),4)
  assert.deepEqual(old.active,[0,1]);assert.deepEqual(latest.active,[3,1,2])
  assert.equal(contextView(latest,{module:'system',state:'replaced'}).page.items[0].replacedBy,3)
  assert.equal(contextDetail(latest,0).row.status,'replaced')
  assert.deepEqual(contextDetail(latest,3).row.sourceEventSeqs,[0])
  assert.throws(()=>contextDetail(old,3),e=>e.status===404)
})

test('超过旧事件阈值仍能索引；无效未来记录不影响早期回答', async () => {
  const events=Array.from({length:51000},(_,seq)=>({seq,type:'runtime/event',data:{}}))
  events.push(msg(51000,'user/message','question'),msg(51001,'assistant/message','answer'),null)
  const index=await indexContext(log(events),51001)
  assert.equal(contextView(index).summary.active,1)
  assert.equal(index.answer.seq,51001)
})

test('大量有效替换按位置线性折叠；非法替换标为未知', async () => {
  const events=[msg(0,'user/message','0')]
  for(let seq=1;seq<=5000;seq++)events.push(msg(seq,'user/message',String(seq),{kind:'compaction'},{surfaceOp:{op:'replace',startSeq:seq-1,endSeq:seq-1}}))
  events.push(msg(5001,'user/message','invalid',{}, {surfaceOp:{op:'replace',startSeq:0,endSeq:5000}}),msg(5002,'assistant/message','answer'))
  const index=await indexContext(log(events))
  assert.deepEqual(index.active,[5000]);assert.equal(index.rows.get(5001).status,'unknown')
  assert.equal(contextView(index,{module:'other',state:'replaced'}).page.total,4999)
  assert.equal(contextView(index).partial,true)
})

test('回答目录窗口可以跳最早/最新和整页；正文损坏不挡导航', async () => {
  const events=Array.from({length:300},(_,i)=>msg(i,'assistant/message','answer '+i))
  events[200].data.message.content=[null]
  const latest=contextView(await indexContext(log(events)))
  assert.equal(latest.timeline.length,80)
  assert.equal(latest.timelineInfo.total,300)
  assert.equal(latest.timelineInfo.firstSeq,0)
  assert.ok(latest.timelineInfo.earlierWindowSeq < latest.timeline[0].seq)
  const first=contextView(await indexContext(log(events),0))
  assert.equal(first.timeline[0].index,1)
  assert.equal(first.timelineInfo.previousSeq,null)
  assert.equal(first.timelineInfo.lastSeq,299)
})

test('原文分页跳过隐藏推理、请求头与流；坏块只影响当前详情', async () => {
  const e=msg(0,'user/message','good');e.data.content=[{type:'reasoning',text:'HIDDEN'},null,{type:'text',text:'visible'}]
  const data=log([e,{seq:1,type:'request/header',data:{header:{authorization:'SECRET'}}},msg(2,'assistant/message','answer')])
  const index=await indexContext(data),view=contextView(index),detail=contextDetail(index,0)
  assert.equal(detail.text,'visible');assert.equal(detail.incomplete,true)
  assert.doesNotMatch(JSON.stringify([view,detail]),/HIDDEN|SECRET/)
  assert.equal(view.answer.seq,2)
})

test('工具参数独立分页并保留来源；尾部和配对不丢失', async () => {
  const result=msg(1,'tool/result','failed');result.data.message.toolCallId='call';result.data.message.isError=true
  const args='z'.repeat(25000)+'END'
  const index=await indexContext(log([{seq:0,type:'tool/call',data:{callId:'call',name:'read',arguments:args}},result,msg(2,'assistant/message','answer')]))
  const view=contextView(index,{module:'tools'})
  assert.equal(view.modules.find(m=>m.id==='tools').issues,1)
  const detail=contextDetail(index,1,24000,'arguments')
  assert.equal(detail.text,args.slice(24000));assert.equal(detail.row.textOffset,24000)
  assert.equal(detail.row.sourcePart,'arguments');assert.equal(detail.row.callSeq,0)
  assert.equal(detail.nextOffset,null);assert.equal(detail.hasArguments,true)
})

test('过大的对象参数只影响参数展示，不阻断结果或其他模块', async () => {
  const result=msg(1,'tool/result','tool result');result.data.message.toolCallId='c'
  const index=await indexContext(log([{seq:0,type:'tool/call',data:{callId:'c',name:'tool',arguments:{huge:'x'.repeat(200000)}}},result,msg(2,'assistant/message','answer')]))
  assert.equal(contextDetail(index,1).text,'tool result')
  const args=contextDetail(index,1,0,'arguments')
  assert.equal(args.incomplete,true);assert.match(args.notices.join(''),/累计保护预算/)
})

test('空会话、参数非法、未知模块/状态和顺序不可信明确处理', async () => {
  const index=await indexContext(log([]));assert.equal(contextView(index).answer,null)
  await assert.rejects(indexContext(log([]),-1),e=>e.status===400)
  await assert.rejects(indexContext(log([msg(1,'user/message','a'),msg(0,'assistant/message','a')])),e=>e.status===422)
  assert.throws(()=>contextView(index,{module:'missing'}),e=>e.status===400)
  assert.throws(()=>contextView(index,{state:'evil'}),e=>e.status===400)
  assert.throws(()=>sourcePage(msg(0,'user/message','x'),10),e=>e.status===416)
})

test('极端结构上限仍保留回答导航和答案原文，不误报零上下文', async () => {
  const events=Array.from({length:VIEW_LIMITS.events+1},(_,seq)=>({seq,type:'runtime/event'}))
  events.push(msg(events.length,'assistant/message','answer'))
  const index=await indexContext(log(events)),view=contextView(index)
  assert.equal(view.summary.available,false)
  assert.equal(view.timeline.length,1)
  assert.equal(contextDetail(index,index.answer.seq).text,'answer')
})

test('短缓存合并读取、显式刷新、超时过期及服务变化均取新快照', async () => {
  let time=0,calls=0,query={async readSession(){calls++;return log([msg(0,'user/message','q'),msg(1,'assistant/message','a')])}}
  const reader=createContextReader(()=>query,{now:()=>time,ttlMs:1000})
  await Promise.all([reader.view('s'),reader.view('s')]);assert.equal(calls,1)
  await reader.detail('s',{event:0});assert.equal(calls,1)
  await reader.view('s',{refresh:true});assert.equal(calls,2)
  time=2000;await reader.view('s');assert.equal(calls,3)
  query={async readSession(){return log([msg(0,'assistant/message','new')])}}
  assert.equal((await reader.view('s')).answer.preview,'new')
})

test('新 Host 路由在旧容量失败时仍可导航/读尾页，并校验参数', async () => {
  const huge='a'.repeat(1100000)+'TAIL'
  const handlers=createHandlers({config:resolveConfig({}),getRegistry:()=>null,getQuery:()=>query})
  const query={async readSession(){return log([msg(0,'user/message',huge),msg(1,'assistant/message','answer')])}}
  const call=(route,params)=>handlers.get[route]({query:new URLSearchParams({id:'s',...params}),body:{}})
  await assert.rejects(call('inspect',{}),e=>e.status===413)
  assert.equal((await call('inspect-view',{})).summary.active,1)
  assert.match((await call('inspect-detail',{event:'0',offset:'1092000'})).text,/TAIL$/)
  await assert.rejects(call('inspect-view',{answer:'-1'}),e=>e.status===400)
  await assert.rejects(call('inspect-detail',{event:'9007199254740992'}),e=>e.status===400)
  await assert.rejects(call('inspect-detail',{event:'2'}),e=>e.status===404)
})
