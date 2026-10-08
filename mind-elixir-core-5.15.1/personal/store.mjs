import { mkdir, open, readFile, rename, rm, copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { applyOperations, assert, indexNodes, validateDocument } from './protocol.mjs'

const clone = value => structuredClone(value)
const initialData = () => ({
  nodeData: { id: randomUUID(), topic: '中心主题', children: ['分支一', '分支二', '分支三'].map(topic => ({ id: randomUUID(), topic })) },
  direction: 1, arrows: [], summaries: [],
})

export class DocumentStore {
  constructor(directory) {
    this.directory = directory
    this.file = join(directory, 'document.json')
    this.listeners = new Set()
    this.queue = Promise.resolve()
  }
  async init() {
    await mkdir(this.directory, { recursive: true })
    const lockPath = join(this.directory, 'server.lock')
    // A killed process may leave a lock; only remove it if its PID no longer exists.
    try {
      const lock = JSON.parse(await readFile(lockPath, 'utf8'))
      let alive = true
      try { process.kill(lock.pid, 0) } catch (error) { if (error.code === 'ESRCH') alive = false }
      assert(!alive, `数据目录已有服务使用（PID ${lock.pid}）`, 409, 'STORE_LOCKED')
      await rm(lockPath)
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    this.lock = await open(lockPath, 'wx')
    await this.lock.writeFile(JSON.stringify({ pid: process.pid }))
    try {
      try {
        this.state = JSON.parse(await readFile(this.file, 'utf8'))
        assert(this.state.schemaVersion === 1 && Number.isSafeInteger(this.state.revision) && this.state.revision >= 0 && typeof this.state.documentId === 'string', '不支持或损坏的存档；原文件保持不变')
        validateDocument(this.state.data)
        assert(Array.isArray(this.state.past) && Array.isArray(this.state.future) && Array.isArray(this.state.receipts), '存档历史损坏；原文件保持不变')
        for (const item of [...this.state.past, ...this.state.future]) validateDocument(item)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        this.state = { schemaVersion: 1, documentId: randomUUID(), revision: 0, updatedAt: new Date().toISOString(), actor: 'system', summary: '创建导图', data: initialData(), past: [], future: [], receipts: [] }
        await this.persist(this.state, false)
      }
      return this
    } catch (error) { await this.close(); throw error }
  }
  snapshot(extra = {}) {
    const { past, future, receipts, ...document } = this.state
    return { ...clone(document), canUndo: past.length > 0, canRedo: future.length > 0, nodeCount: indexNodes(document.data.nodeData).size, ...extra }
  }
  subtree(id) {
    const item = indexNodes(this.state.data.nodeData).get(id)
    assert(item, `节点不存在：${id}`, 404, 'NODE_NOT_FOUND')
    return { documentId: this.state.documentId, revision: this.state.revision, parentId: item.parent?.id ?? null, node: clone(item.node) }
  }
  async persist(state, backup = true) {
    const temp = `${this.file}.${randomUUID()}.tmp`
    try {
      const handle = await open(temp, 'wx')
      try { await handle.writeFile(JSON.stringify(state, null, 2)); await handle.sync() } finally { await handle.close() }
      if (backup) await copyFile(this.file, `${this.file}.bak`)
      await rename(temp, this.file)
    } finally { await rm(temp, { force: true }) }
  }
  transact(kind, request) {
    const work = this.queue.then(() => this.commit(kind, request))
    this.queue = work.catch(() => {})
    return work
  }
  async commit(kind, request) {
    assert(request && typeof request === 'object', '请求体必须是对象')
    assert(typeof request.requestId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(request.requestId), '写入必须带唯一 requestId')
    assert(Number.isSafeInteger(request.baseRevision) && request.baseRevision >= 0, '写入必须带 baseRevision')
    assert(request.documentId === this.state.documentId, '文档标识不同，请重新读取导图', 409, 'DOCUMENT_CONFLICT')
    const hash = createHash('sha256').update(JSON.stringify({ kind, request })).digest('hex')
    const receipt = this.state.receipts.find(r => r.id === request.requestId)
    if (receipt) {
      assert(receipt.hash === hash, 'requestId 已用于不同请求', 409, 'REQUEST_ID_REUSED')
      return this.snapshot({ replayed: true, committedRevision: receipt.revision, affectedNodeIds: receipt.affectedNodeIds })
    }
    assert(request.baseRevision === this.state.revision, `版本冲突：请求 v${request.baseRevision}，当前 v${this.state.revision}。请重新读取后局部修改。`, 409, 'REVISION_CONFLICT')
    const next = clone(this.state)
    let affectedNodeIds = []
    if (kind === 'undo' || kind === 'redo') {
      const from = kind === 'undo' ? next.past : next.future
      const to = kind === 'undo' ? next.future : next.past
      assert(from.length > 0, kind === 'undo' ? '没有可撤销的修改' : '没有可重做的修改', 409, 'NO_HISTORY')
      to.push(next.data)
      next.data = from.pop()
    } else {
      let data
      if (kind === 'operations') ({ data, affectedNodeIds } = applyOperations(next.data, request.operations))
      else if (kind === 'replace') data = clone(validateDocument(request.data))
      else throw new Error(`Unknown transaction ${kind}`)
      next.past.push(next.data)
      next.future = []
      next.data = data
    }
    // Bound history by both count and bytes. Current document is never evicted.
    for (const history of [next.past, next.future]) {
      while (history.length > 40 || (history.length && Buffer.byteLength(JSON.stringify(history)) > 16 * 1024 * 1024)) history.shift()
    }
    next.revision++
    next.updatedAt = new Date().toISOString()
    next.actor = typeof request.actor === 'string' ? request.actor.slice(0, 100) : 'local'
    next.summary = typeof request.summary === 'string' ? request.summary.slice(0, 200) : kind
    next.receipts = [...next.receipts, { id: request.requestId, hash, revision: next.revision, affectedNodeIds }].slice(-128)
    await this.persist(next)
    this.state = next
    for (const listener of this.listeners) {
      try { listener({ documentId: next.documentId, revision: next.revision, actor: next.actor }) } catch { /* dead SSE clients cannot invalidate a durable commit */ }
    }
    return this.snapshot({ committedRevision: next.revision, affectedNodeIds })
  }
  async close() {
    await this.queue
    if (this.lock) {
      await this.lock.close()
      this.lock = null
      await rm(join(this.directory, 'server.lock'), { force: true })
    }
  }
}
