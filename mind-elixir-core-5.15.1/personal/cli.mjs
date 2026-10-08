import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { api } from './client.mjs'

const help = `MEC 本地编辑工具（先运行 npm run dev）
node personal/cli.mjs get
node personal/cli.mjs subtree <nodeId>
node personal/cli.mjs protocol
node personal/cli.mjs apply <request.json>
node personal/cli.mjs replace <request.json>
node personal/cli.mjs undo <request.json>
node personal/cli.mjs redo <request.json>

所有写入文件必须带 documentId、baseRevision；默认生成 requestId。
apply 还需要 operations，replace 还需要 data。
从 get 读取版本后规划修改；冲突时重新读取，不能强制覆盖。`

try {
  const [command, argument] = process.argv.slice(2)
  let result
  if (command === 'get') result = await api('/api/document')
  else if (command === 'subtree' && argument) result = await api(`/api/subtree/${encodeURIComponent(argument)}`)
  else if (command === 'protocol') result = await api('/api/protocol')
  else if (['apply', 'replace', 'undo', 'redo'].includes(command) && argument) {
    const request = JSON.parse((await readFile(argument, 'utf8')).replace(/^\uFEFF/, ''))
    request.requestId ||= randomUUID()
    request.actor ||= 'codex'
    const endpoint = { apply: '/api/operations', replace: '/api/document', undo: '/api/history/undo', redo: '/api/history/redo' }[command]
    result = await api(endpoint, request)
  } else {
    console.log(help)
    if (command && command !== '--help') process.exitCode = 1
  }
  if (result) console.log(JSON.stringify(result, null, 2))
} catch (error) {
  console.error(JSON.stringify({ error: error.code || 'REQUEST_FAILED', message: error.message, hint: error.cause ? '确认本地服务已启动，默认端口 23333' : undefined }))
  process.exitCode = 1
}
