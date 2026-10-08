import test from 'node:test'
import strict from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { applyOperations, validateDocument } from '../protocol.mjs'
import { DocumentStore } from '../store.mjs'
import { startServer } from '../server.mjs'
import { planWithDeepSeek } from '../deepseek.mjs'

const fixture = () => ({ nodeData: { id: 'root', topic: '文档主题', children: [
  { id: 'a', topic: '收起分支', expanded: false, children: [{ id: 'a1', topic: '隐藏节点', note: '保留备注', metadata: { kind: 'fact', sources: [{ document: '原文.md', section: '第一节', quote: '原文片段' }] } }] },
  { id: 'b', topic: '不相关分支' },
] }, direction: 1, arrows: [], summaries: [] })
const body = (store, extra = {}) => ({ documentId: store.state.documentId, baseRevision: store.state.revision, requestId: randomUUID(), ...extra })
async function withStore(t) {
  const dir = await mkdtemp(join(tmpdir(), 'mec-personal-test-'))
  const store = await new DocumentStore(dir).init()
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }) })
  return store
}

test('collapsed subtree edit preserves other branches, IDs and provenance', () => {
  const data = fixture()
  const result = applyOperations(data, [{ type: 'update_node', id: 'a1', patch: { topic: 'AI 补充' } }])
  strict.equal(result.data.nodeData.children[0].expanded, false)
  strict.equal(result.data.nodeData.children[0].children[0].id, 'a1')
  strict.deepEqual(result.data.nodeData.children[0].children[0].metadata, data.nodeData.children[0].children[0].metadata)
  strict.deepEqual(result.data.nodeData.children[1], data.nodeData.children[1])
  strict.equal(data.nodeData.children[0].children[0].topic, '隐藏节点')
})
test('invalid mixed batch, duplicate IDs, cycles and root deletion leave input unchanged', () => {
  const data = fixture()
  const original = structuredClone(data)
  for (const invalid of [
    { type: 'move_node', id: 'a', parentId: 'a1' },
    { type: 'delete_node', id: 'root' },
    { type: 'add_node', parentId: 'root', node: { id: 'b', topic: '重复' } },
    { type: 'update_node', id: 'missing', patch: { topic: '不存在' } },
    { type: 'update_node', id: 'a1', patch: { id: 'renamed' } },
    { type: 'move_node', id: 'b', parentId: 'a', index: -1 },
    { type: 'update_node', id: 'b', patch: { topic: '不接受拼错的参数' }, unexpected: true },
  ]) strict.throws(() => applyOperations(data, [{ type: 'update_node', id: 'b', patch: { topic: '临时' } }, invalid]))
  strict.deepEqual(data, original)
})
test('add subtree, move by final index, delete descendants and dangling arrows', () => {
  const data = fixture()
  data.arrows = [{ id: 'line1', from: 'a1', to: 'b', label: '关联' }]
  const { data: result } = applyOperations(data, [
    { type: 'add_node', parentId: 'b', node: { id: 'c', topic: '新增' } },
    { type: 'move_node', id: 'c', parentId: 'root', index: 0 },
    { type: 'delete_node', id: 'a' },
  ])
  strict.deepEqual(result.nodeData.children.map(n => n.id), ['c', 'b'])
  strict.deepEqual(result.arrows, [])
})
test('summary membership survives index shifts and rejects discontiguous moves', () => {
  const data = fixture()
  data.summaries = [{ id: 's1', parent: 'root', start: 0, end: 1, label: '原来的两项' }]
  const result = applyOperations(data, [{ type: 'add_node', parentId: 'root', index: 0, node: { id: 'c', topic: '新' } }]).data
  strict.deepEqual([result.summaries[0].start, result.summaries[0].end], [1, 2])
  strict.throws(() => applyOperations(data, [{ type: 'add_node', parentId: 'root', index: 1, node: { id: 'c', topic: '新' } }]))
})
test('reject executable HTML/URLs and malformed tree while preserving literal text', () => {
  for (const patch of [{ dangerouslySetInnerHTML: '<img onerror=alert(1)>' }, { hyperLink: 'javascript:alert(1)' }, { children: {} }, { id: 'unsafe"id' }]) {
    const data = fixture(); Object.assign(data.nodeData, patch)
    strict.throws(() => validateDocument(data))
  }
  const data = fixture(); data.nodeData.topic = '<script>literal text</script>'
  strict.equal(validateDocument(data).nodeData.topic, data.nodeData.topic)
})
test('persistent batch undo/redo, stable IDs and monotonically increasing revisions', async t => {
  const store = await withStore(t)
  await store.transact('replace', body(store, { data: fixture() }))
  const before = store.snapshot()
  await store.transact('operations', body(store, { operations: [{ type: 'update_node', id: 'a1', patch: { topic: '一批修改' } }, { type: 'add_node', parentId: 'b', node: { id: 'c', topic: '新节点' } }] }))
  const after = store.snapshot()
  await store.transact('undo', body(store))
  strict.deepEqual(store.snapshot().data, before.data)
  strict.equal(store.state.revision, after.revision + 1)
  const dir = store.directory
  await store.close()
  const reopened = await new DocumentStore(dir).init()
  try {
    strict.deepEqual(reopened.snapshot().data, before.data)
    strict.equal(reopened.snapshot().canRedo, true)
    await reopened.transact('redo', body(reopened))
    strict.deepEqual(reopened.snapshot().data, after.data)
    strict.equal(reopened.subtree('a1').node.note, '保留备注')
  } finally { await reopened.close() }
})
test('simultaneous writers serialize and stale revisions never overwrite human edits', async t => {
  const store = await withStore(t)
  await store.transact('replace', body(store, { data: fixture() }))
  const a = body(store, { operations: [{ type: 'update_node', id: 'b', patch: { topic: '人工修改' } }] })
  const b = body(store, { operations: [{ type: 'update_node', id: 'a1', patch: { topic: 'AI' } }] })
  const results = await Promise.allSettled([store.transact('operations', a), store.transact('operations', b)])
  strict.equal(results[0].status, 'fulfilled')
  strict.equal(results[1].reason.code, 'REVISION_CONFLICT')
  strict.equal(store.subtree('b').node.topic, '人工修改')
})
test('idempotent retry avoids duplicate nodes; request reuse with other payload is rejected', async t => {
  const store = await withStore(t)
  const request = body(store, { operations: [{ type: 'add_node', parentId: store.state.data.nodeData.id, node: { id: 'new', topic: '唯一新增' } }] })
  const first = await store.transact('operations', request)
  const retry = await store.transact('operations', request)
  strict.equal(retry.revision, first.revision)
  strict.equal(retry.replayed, true)
  await strict.rejects(store.transact('operations', { ...request, summary: 'different' }), { code: 'REQUEST_ID_REUSED' })
})
test('disk failure does not advance memory/revision or broadcast changes', async t => {
  const store = await withStore(t)
  const before = store.snapshot()
  store.persist = async () => { throw new Error('simulated disk failure') }
  let broadcasts = 0
  store.listeners.add(() => broadcasts++)
  await strict.rejects(store.transact('replace', body(store, { data: fixture() })), /disk failure/)
  strict.deepEqual(store.snapshot(), before)
  strict.equal(broadcasts, 0)
})
test('lock rejects a second writer and corrupt save is never silently overwritten', async t => {
  const store = await withStore(t)
  await strict.rejects(new DocumentStore(store.directory).init(), { code: 'STORE_LOCKED' })
  await store.close()
  await writeFile(store.file, '{broken', 'utf8')
  await strict.rejects(new DocumentStore(store.directory).init())
  strict.equal(await readFile(store.file, 'utf8'), '{broken')
})
test('HTTP reads, subtree, real-time event, write validation and origin protection', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mec-http-test-'))
  const app = await startServer({ port: 0, directory: dir, withVite: false })
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }) })
  const read = await (await fetch(`${app.url}/api/document`)).json()
  const stream = await fetch(`${app.url}/api/events`)
  const reader = stream.body.getReader()
  await reader.read()
  const response = await fetch(`${app.url}/api/document`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ documentId: read.documentId, baseRevision: read.revision, requestId: randomUUID(), data: fixture() }) })
  strict.equal(response.status, 200)
  strict.match(new TextDecoder().decode((await reader.read()).value), /"revision":1/)
  await reader.cancel()
  const subtree = await (await fetch(`${app.url}/api/subtree/a1`)).json()
  strict.equal(subtree.node.id, 'a1')
  strict.equal((await fetch(`${app.url}/api/document`, { headers: { Origin: 'https://evil.example' } })).status, 403)
  strict.equal((await fetch(`${app.url}/.mindmap/document.json`)).status, 403)
  strict.equal((await fetch(`${app.url}/api/document`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415)
})

const response = (message, finish_reason = 'stop') => ({ ok: true, json: async () => ({ choices: [{ message: { role: 'assistant', ...message }, finish_reason }] }) })
const call = (name, args, id = 'call1') => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })
test('DeepSeek staged tool loop uses V4, keeps source, and has no live side effects', async () => {
  const original = fixture()
  let rounds = 0
  const result = await planWithDeepSeek({ document: { data: original }, prompt: '补充隐藏节点', source: '虚构文档原文', sourceName: '原文.md', apiKey: 'mock-key', fetcher: async (url, options) => {
    strict.equal(url.href, 'https://api.deepseek.com/chat/completions')
    const body = JSON.parse(options.body)
    strict.equal(body.model, 'deepseek-v4-pro')
    strict.match(body.messages[1].content, /虚构文档原文/)
    return rounds++ === 0 ? response({ content: null, tool_calls: [call('apply_operations', { operations: [{ type: 'update_node', id: 'a1', patch: { topic: '模型补充' } }] })] }, 'tool_calls') : response({ content: '已暂存' })
  } })
  strict.equal(result.data.nodeData.children[0].children[0].topic, '模型补充')
  strict.equal(original.nodeData.children[0].children[0].topic, '隐藏节点')
})
test('DeepSeek failure after a valid batch aborts entire plan; no-tool output is not success', async () => {
  const original = fixture()
  let rounds = 0
  await strict.rejects(planWithDeepSeek({ document: { data: original }, prompt: '改图', apiKey: 'mock', fetcher: async () => response({ tool_calls: [call('apply_operations', { operations: [rounds++ === 0 ? { type: 'update_node', id: 'b', patch: { topic: '暂存' } } : { type: 'delete_node', id: 'root' }] })] }) }), /整次任务未提交/)
  strict.equal(original.nodeData.children[1].topic, '不相关分支')
  await strict.rejects(planWithDeepSeek({ document: { data: original }, prompt: '改图', apiKey: 'mock', fetcher: async () => response({ content: '口头声称完成' }) }), /没有执行编辑工具/)
})

test('human edit during model generation prevents the final AI snapshot from overwriting it', async t => {
  const store = await withStore(t)
  await store.transact('replace', body(store, { data: fixture() }))
  const document = store.snapshot()
  let rounds = 0
  const plan = await planWithDeepSeek({ document, prompt: '改图', apiKey: 'mock', fetcher: async () => {
    if (rounds++ === 0) {
      await store.transact('operations', body(store, { operations: [{ type: 'update_node', id: 'b', patch: { topic: '模型执行期间人工修改' } }] }))
      return response({ tool_calls: [call('apply_operations', { operations: [{ type: 'update_node', id: 'a1', patch: { topic: 'AI 暂存' } }] })] })
    }
    return response({ content: '计划完成' })
  } })
  await strict.rejects(store.transact('replace', { documentId: document.documentId, baseRevision: document.revision, requestId: randomUUID(), data: plan.data }), { code: 'REVISION_CONFLICT' })
  strict.equal(store.subtree('b').node.topic, '模型执行期间人工修改')
  strict.equal(store.subtree('a1').node.topic, '隐藏节点')
})
