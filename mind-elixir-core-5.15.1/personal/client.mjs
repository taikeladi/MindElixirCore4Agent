import { ProtocolError } from './protocol.mjs'

export async function api(path, body, base = process.env.MINDMAP_URL || 'http://127.0.0.1:23333') {
  const url = new URL(base)
  if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.protocol !== 'http:') throw new Error('MINDMAP_URL 必须指向本机 http 服务')
  const response = await fetch(new URL(path, url), {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  })
  const result = await response.json()
  if (!response.ok) throw new ProtocolError(result.message || result.error, response.status, result.error)
  return result
}
