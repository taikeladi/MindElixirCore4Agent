import { createServer as createHttpServer } from 'node:http'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { DocumentStore } from './store.mjs'
import { assert, operationsSchema, ProtocolError, MAX_DOCUMENT_BYTES } from './protocol.mjs'

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const json = (response, status, value) => {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  response.end(JSON.stringify(value))
}
async function readJson(request) {
  assert(request.headers['content-type']?.split(';')[0].trim() === 'application/json', '写入需要 application/json', 415)
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    assert(size <= MAX_DOCUMENT_BYTES + 1024 * 1024, '请求过大', 413)
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '')) } catch { throw new ProtocolError('请求不是有效 JSON') }
}

export async function startServer({ port = 23333, directory = resolve(projectRoot, '.mindmap'), withVite = true } = {}) {
  const store = await new DocumentStore(directory).init()
  let vite
  const clients = new Set()
  const server = createHttpServer(async (request, response) => {
    try {
      // Local-only service: reject DNS rebinding and cross-origin reads/writes.
      const host = request.headers.host || ''
      const actualPort = server.address().port
      assert([`127.0.0.1:${actualPort}`, `localhost:${actualPort}`].includes(host), '仅允许本机 Host', 403)
      const origin = request.headers.origin
      assert(!origin || origin === `http://${host}`, '拒绝跨站请求', 403)
      assert(request.headers['sec-fetch-site'] !== 'cross-site', '拒绝跨站请求', 403)
      const url = new URL(request.url, `http://${host}`)
      if (!url.pathname.startsWith('/api/')) {
        // Private store and credentials must never be served by Vite's file server.
        const decoded = decodeURIComponent(url.pathname).replaceAll('\\', '/')
        if (/(^|\/)(\.mindmap|\.env[^/]*)(\/|$)/i.test(decoded) || decoded.includes('/@fs/')) return json(response, 403, { error: 'PRIVATE_FILE' })
        if (vite) return vite.middlewares(request, response, () => json(response, 404, { error: 'NOT_FOUND' }))
        return json(response, 404, { error: 'NOT_FOUND' })
      }
      if (request.method === 'GET' && url.pathname === '/api/health') return json(response, 200, { ok: true, service: 'mec-personal', protocolVersion: 1, revision: store.state.revision })
      if (request.method === 'GET' && url.pathname === '/api/document') return json(response, 200, store.snapshot())
      if (request.method === 'GET' && url.pathname.startsWith('/api/subtree/')) return json(response, 200, store.subtree(decodeURIComponent(url.pathname.slice('/api/subtree/'.length))))
      if (request.method === 'GET' && url.pathname === '/api/protocol') return json(response, 200, { protocolVersion: 1, operations: operationsSchema, requiredForWrite: ['documentId', 'baseRevision', 'requestId'] })
      if (request.method === 'GET' && url.pathname === '/api/events') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
        const send = event => response.write(`event: revision\ndata: ${JSON.stringify(event)}\n\n`)
        clients.add(response)
        store.listeners.add(send)
        send({ documentId: store.state.documentId, revision: store.state.revision })
        const interval = setInterval(() => response.write(': heartbeat\n\n'), 15000)
        response.on('close', () => { clearInterval(interval); store.listeners.delete(send); clients.delete(response) })
        return
      }
      const routes = { '/api/operations': 'operations', '/api/document': 'replace', '/api/history/undo': 'undo', '/api/history/redo': 'redo' }
      if (request.method === 'POST' && routes[url.pathname]) return json(response, 200, await store.transact(routes[url.pathname], await readJson(request)))
      json(response, 404, { error: 'NOT_FOUND', message: '接口不存在' })
    } catch (error) {
      if (!response.headersSent) json(response, error.status || 500, { error: error.code || 'SERVER_ERROR', message: error.status ? error.message : '本地服务错误，请查看服务日志', revision: store.state.revision })
      if (!error.status) console.error(error)
    }
  })
  try {
    if (withVite) {
      const { createServer } = await import('vite')
      vite = await createServer({ root: projectRoot, server: { middlewareMode: true, hmr: { server }, fs: { deny: ['.env', '.env.*', '**/.mindmap/**', '**/*.pem', '**/*.key', '**/.git/**'] } }, appType: 'spa' })
    }
    await new Promise((yes, no) => { server.once('error', no); server.listen(port, '127.0.0.1', yes) })
  } catch (error) { await vite?.close(); await store.close(); throw error }
  return {
    server, store, url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      for (const client of clients) client.end()
      await vite?.close()
      const closed = new Promise((yes, no) => server.close(error => error ? no(error) : yes()))
      server.closeAllConnections()
      await closed
      await store.close()
    },
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  const portIndex = args.indexOf('--port')
  const port = Number(portIndex < 0 ? (process.env.MINDMAP_PORT || 23333) : args[portIndex + 1])
  assert(Number.isInteger(port) && port > 0 && port < 65536, '端口无效')
  const app = await startServer({ port, directory: process.env.MINDMAP_DATA_DIR ? resolve(process.env.MINDMAP_DATA_DIR) : undefined })
  console.log(`个人思维导图：${app.url}\n存档：${app.store.file}\nCtrl+C 停止服务。`)
  let closing = false
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
    if (closing) return
    closing = true
    await app.close()
    process.exit(0)
  })
}
