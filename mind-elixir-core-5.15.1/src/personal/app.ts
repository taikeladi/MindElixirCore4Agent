import MindElixir, { type MindElixirData, type NodeObj } from '../index'
import { zh_CN } from '../i18n'
import './editor.css'

type Source = { document?: string; section?: string; page?: string | number; quote?: string; [key: string]: unknown }
type Metadata = { kind?: string; sources?: Source[]; [key: string]: unknown }
type Snapshot = {
  documentId: string
  revision: number
  updatedAt: string
  actor: string
  data: MindElixirData
  canUndo: boolean
  canRedo: boolean
  nodeCount: number
  committedRevision?: number
}
type Draft = { documentId: string; baseRevision: number; data: MindElixirData; savedAt: string; details?: { id: string; values: string[] } }
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const button = (id: string) => $<HTMLButtonElement>(id)
const input = (id: string) => $<HTMLInputElement>(id)
const signature = (data: MindElixirData) => JSON.stringify(data)
const draftPrefix = `mec-draft:${location.origin}:`
let tabId: string = crypto.randomUUID()
try {
  tabId = sessionStorage.getItem('mec-tab-id') || tabId
  sessionStorage.setItem('mec-tab-id', tabId)
} catch {
  /* storage may be disabled */
}
const draftKey = `${draftPrefix}${tabId}`
const actor = `browser-${crypto.randomUUID().slice(0, 8)}`
const simpleTheme = {
  ...MindElixir.THEME,
  name: 'Simple',
  palette: ['#4f77c8', '#4b9683', '#c38a4c', '#9470b8'],
  cssVar: { ...MindElixir.THEME.cssVar, '--bgcolor': '#ffffff', '--root-bgcolor': '#35445d', '--root-radius': '12px', '--main-radius': '8px' },
}
let mind: MindElixir
let current: Snapshot
let savedSignature = ''
let rendered = false
let suppress = false
let saving: Promise<void> | null = null
let pending: Record<string, unknown> | null = null
let timer: ReturnType<typeof setTimeout> | undefined
let conflict = false
let remoteWaiting = false
let recovered: Draft | null = null
let recoveryStorageKey: string | null = null
let draftBase: { documentId: string; baseRevision: number } | null = null
let detailId: string | null = null
let detailsDirty = false
let imported: MindElixirData | null = null
let actionBusy = false

function status(message: string, error = false) {
  $('save-status').textContent = message
  $('save-status').dataset.state = error ? 'error' : 'ok'
}
function notice(message: string, actions: string[] = []) {
  $('notice-text').textContent = message
  $('notice').hidden = false
  for (const id of ['retry', 'draft-export', 'reload-latest', 'restore-draft']) $(id).hidden = !actions.includes(id)
}
function editing() {
  return !!document.querySelector('#input-box') || detailsDirty
}
function changed() {
  return rendered && signature(mind.getData()) !== savedSignature
}
function findNode(node: NodeObj, id: string): NodeObj | undefined {
  if (node.id === id) return node
  for (const child of node.children || []) {
    const found = findNode(child, id)
    if (found) return found
  }
}
function activeDraftData() {
  const data = mind.getData()
  const editor = document.querySelector<HTMLElement>('#input-box')
  const id = mind.currentNode?.nodeObj.id
  if (editor && id) {
    const node = findNode(data.nodeData, id)
    if (node && editor.innerText.trim()) node.topic = editor.innerText
  }
  return data
}
function keepDraft() {
  if (!rendered) return
  const draft: Draft = {
    ...(draftBase || { documentId: current.documentId, baseRevision: current.revision }),
    data: activeDraftData(),
    savedAt: new Date().toISOString(),
  }
  if (detailsDirty && detailId) draft.details = { id: detailId, values: detailFields.map(id => input(id).value) }
  try {
    localStorage.setItem(draftKey, JSON.stringify(draft))
  } catch {
    notice('浏览器草稿空间不足，请保持页面打开并导出备份。', ['draft-export'])
  }
}
function clearDraft() {
  try {
    localStorage.removeItem(draftKey)
    if (recoveryStorageKey) localStorage.removeItem(recoveryStorageKey)
    recoveryStorageKey = null
  } catch {
    /* disabled storage */
  }
}
function download(data: unknown, name: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
  const anchor = document.createElement('a')
  anchor.href = url
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Windows filenames cannot contain control characters.
  anchor.download = name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
async function request(path: string, body?: unknown): Promise<Snapshot> {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  })
  const result = await response.json()
  if (!response.ok) throw Object.assign(new Error(result.message || result.error), { status: response.status })
  return result
}
function updateHeading() {
  $('document-title').textContent = mind.nodeData.topic
  document.title = `${mind.nodeData.topic} · 思维导图`
  $('map-info').textContent = `${current.nodeCount} 个节点 · v${current.revision} · 本地保存`
  button('undo').disabled = !current.canUndo || conflict || actionBusy
  button('redo').disabled = !current.canRedo || conflict || actionBusy
}
function fitMap() {
  const bounds = () => {
    const rects = Array.from(mind.map.querySelectorAll('me-tpc'), node => node.getBoundingClientRect())
    return {
      left: Math.min(...rects.map(r => r.left)),
      right: Math.max(...rects.map(r => r.right)),
      top: Math.min(...rects.map(r => r.top)),
      bottom: Math.max(...rects.map(r => r.bottom)),
    }
  }
  mind.map.style.transition = 'none'
  const available = mind.container.getBoundingClientRect()
  const before = bounds()
  const factor = Math.min((available.width - 100) / (before.right - before.left), (available.height - 70) / (before.bottom - before.top))
  mind.scale(Math.max(mind.scaleMin, Math.min(1, mind.scaleVal * factor)))
  const after = bounds()
  mind.move((available.left + available.right - after.left - after.right) / 2, (available.top + available.bottom - after.top - after.bottom) / 2)
}
function render(snapshot: Snapshot, center = false) {
  suppress = true
  draftBase = null
  const rootChanged = snapshot.data.nodeData.id !== mind.nodeData.id
  const selectedId = mind.currentNode?.nodeObj.id
  current = snapshot
  mind.direction = snapshot.data.direction ?? MindElixir.RIGHT
  mind.compact = snapshot.data.compact ?? false
  mind.meta = snapshot.data.meta || {}
  mind.changeTheme(snapshot.data.theme || simpleTheme, false)
  mind.refresh(snapshot.data)
  if (selectedId) {
    try {
      mind.selectNode(mind.findEle(selectedId))
    } catch {
      /* deleted or collapsed */
    }
  }
  if (center || rootChanged) fitMap()
  savedSignature = signature(mind.getData())
  suppress = false
  updateHeading()
  showDetails()
  status('已保存到本机')
}
function stopForConflict(message: string) {
  conflict = true
  keepDraft()
  status('有冲突 · 草稿已保留', true)
  notice(`${message} 本地修改尚未覆盖服务器，可导出草稿后载入最新版本。`, ['draft-export', 'reload-latest'])
  updateHeading()
}
async function pullLatest() {
  if (conflict || pending || saving || changed() || editing() || actionBusy || recovered) {
    remoteWaiting = true
    return
  }
  try {
    const latest = await request('/api/document')
    if (conflict || pending || saving || changed() || editing() || actionBusy || recovered) {
      remoteWaiting = true
      return
    }
    if (latest.documentId !== current.documentId) return stopForConflict('服务打开了另一份存档。')
    if (latest.revision > current.revision) render(latest)
    remoteWaiting = false
  } catch {
    status('连接中断 · 等待重连', true)
  }
}
function capture() {
  if (!rendered || suppress || recovered) return
  if (!changed()) {
    if (remoteWaiting && !editing()) void pullLatest()
    return
  }
  keepDraft()
  updateHeading()
  if (conflict || actionBusy) return
  status('正在保存…')
  clearTimeout(timer)
  timer = setTimeout(() => void save(), 180)
}
async function save(): Promise<void> {
  clearTimeout(timer)
  if (saving) {
    await saving
    if (!conflict && !pending && changed()) return save()
    return
  }
  if (conflict || recovered || document.querySelector('#input-box') || (!pending && !changed())) return
  pending ||= {
    documentId: current.documentId,
    baseRevision: current.revision,
    requestId: crypto.randomUUID(),
    data: mind.getData(),
    actor,
    summary: '人工编辑',
  }
  const sending = pending
  const sentSignature = signature(sending.data as MindElixirData)
  saving = (async () => {
    try {
      const result = await request('/api/document', sending)
      pending = null
      if (result.committedRevision !== result.revision) return stopForConflict('上次写入已成功，但之后又出现了外部修改。')
      current = result
      draftBase = null
      savedSignature = sentSignature
      if (!changed() && !editing()) clearDraft()
      else keepDraft()
      updateHeading()
      if (!detailsDirty) showDetails()
      status(changed() ? '正在保存…' : '已保存到本机')
      $('notice').hidden = true
    } catch (error) {
      const err = error as Error & { status?: number }
      if (err.status === 409) stopForConflict(err.message)
      else if (err.status && err.status < 500) {
        pending = null
        stopForConflict(`未能保存：${err.message}`)
      } else {
        keepDraft()
        status('尚未保存 · 草稿已保留', true)
        notice('本地服务暂时不可用。恢复连接后可重试，或导出草稿。', ['retry', 'draft-export'])
      }
    }
  })()
  await saving
  saving = null
  if (!conflict && !pending) {
    if (changed()) return save()
    if (remoteWaiting) void pullLatest()
  }
}
async function history(kind: 'undo' | 'redo') {
  if (actionBusy || conflict || recovered) return
  document.querySelector<HTMLElement>('#input-box')?.blur()
  if (detailsDirty) {
    notice('先保存节点详情，再撤销或重做。')
    return
  }
  await save()
  if (pending || changed() || conflict) return
  actionBusy = true
  mind.disableEdit()
  updateHeading()
  try {
    render(
      await request(`/api/history/${kind}`, {
        documentId: current.documentId,
        baseRevision: current.revision,
        requestId: crypto.randomUUID(),
        actor,
        summary: kind === 'undo' ? '撤销上一次提交' : '重做上一次提交',
      })
    )
  } catch (error) {
    notice((error as Error).message)
    remoteWaiting = true
  } finally {
    actionBusy = false
    mind.enableEdit()
    updateHeading()
    if (remoteWaiting) void pullLatest()
  }
}

const detailFields = ['node-topic', 'node-note', 'node-kind', 'source-document', 'source-section', 'source-page', 'source-quote']
function showDetails() {
  if (detailsDirty) return
  const node = mind.currentNode?.nodeObj
  detailId = node?.id || null
  $('selection-hint').hidden = !!node
  $('details-form').hidden = !node
  if (!node) return
  const metadata = (node.metadata || {}) as Metadata
  const sources = Array.isArray(metadata.sources) ? metadata.sources : []
  const source = sources[0] || {}
  const values = [
    node.topic,
    node.note || '',
    metadata.kind || '',
    source.document || '',
    source.section || '',
    String(source.page || ''),
    source.quote || '',
  ]
  detailFields.forEach((id, index) => {
    input(id).value = values[index]
  })
  $('node-id').textContent = node.id
  $('more-sources').textContent = sources.length > 1 ? `另有 ${sources.length - 1} 条来源会保留；这里编辑第 1 条。` : '来源随节点一起保存和导出。'
}
function toggleDetails(open: boolean) {
  $('details').hidden = !open
  document.body.classList.toggle('details-open', open)
  $('details-toggle').setAttribute('aria-expanded', String(open))
  if (open) showDetails()
}
button('details-toggle').onclick = () => toggleDetails(Boolean($('details').hidden))
button('details-close').onclick = () => toggleDetails(false)
$('details-form').addEventListener('input', () => {
  detailsDirty = true
  keepDraft()
})
$('details-form').addEventListener('submit', event => {
  event.preventDefault()
  if (!detailId || actionBusy) return
  const targetId = detailId
  const data = mind.getData()
  const target = findNode(data.nodeData, targetId)
  if (!target) return
  target.topic = input('node-topic').value.trim()
  if (!target.topic) return
  target.note = input('node-note').value
  const metadata: Metadata = structuredClone((target.metadata || {}) as Metadata)
  if (input('node-kind').value) metadata.kind = input('node-kind').value
  else delete metadata.kind
  const sources = Array.isArray(metadata.sources) ? metadata.sources : []
  const first: Source = {
    ...sources[0],
    document: input('source-document').value,
    section: input('source-section').value,
    page: input('source-page').value,
    quote: input('source-quote').value,
  }
  metadata.sources = [first.document, first.section, first.page, first.quote].some(Boolean) ? [first, ...sources.slice(1)] : sources.slice(1)
  target.metadata = metadata
  detailsDirty = false
  suppress = true
  mind.refresh(data)
  try {
    mind.selectNode(mind.findEle(targetId))
  } catch {
    /* collapsed */
  }
  suppress = false
  showDetails()
  capture()
})
button('undo').onclick = () => void history('undo')
button('redo').onclick = () => void history('redo')
button('center').onclick = () => fitMap()
button('retry').onclick = () => void save()
button('export').onclick = () => download(activeDraftData(), `${mind.nodeData.topic}.mindmap.json`)
button('draft-export').onclick = () => {
  const details = detailsDirty && detailId ? { id: detailId, values: detailFields.map(id => input(id).value) } : undefined
  download(
    recovered || { ...(draftBase || { documentId: current.documentId, baseRevision: current.revision }), data: activeDraftData(), details },
    '思维导图-本地草稿.json'
  )
}
button('reload-latest').onclick = async () => {
  try {
    const latest = await request('/api/document')
    button('draft-export').click()
    pending = null
    conflict = false
    recovered = null
    detailsDirty = false
    clearDraft()
    render(latest)
    mind.enableEdit()
    $('notice').hidden = true
  } catch (error) {
    notice((error as Error).message, ['draft-export', 'reload-latest'])
  }
}
button('restore-draft').onclick = () => {
  if (!recovered) return
  const draft = recovered
  recovered = null
  draftBase = { documentId: draft.documentId, baseRevision: draft.baseRevision }
  suppress = true
  mind.direction = draft.data.direction ?? 1
  mind.meta = draft.data.meta || {}
  mind.compact = draft.data.compact ?? false
  mind.changeTheme(draft.data.theme || simpleTheme, false)
  mind.refresh(draft.data)
  suppress = false
  if (draft.details) {
    const draftDetailId = draft.details.id
    try {
      mind.selectNode(mind.findEle(draftDetailId))
    } catch {
      /* hidden nodes are still editable from details */
    }
    detailId = draftDetailId
    detailFields.forEach((id, i) => {
      input(id).value = draft.details!.values[i]
    })
    detailsDirty = true
    toggleDetails(true)
    $('selection-hint').hidden = true
    $('details-form').hidden = false
  }
  mind.enableEdit()
  $('notice').hidden = true
  if (draft.documentId !== current.documentId || draft.baseRevision !== current.revision) stopForConflict('草稿基于旧版本，已恢复在当前页面。')
  else capture()
}
button('import').onclick = () => input('import-file').click()
input('import-file').onchange = async () => {
  const file = input('import-file').files?.[0]
  if (!file) return
  try {
    if (file.size > 4 * 1024 * 1024) throw new Error('导入文件不能超过 4 MB')
    const parsed = JSON.parse((await file.text()).replace(/^\uFEFF/, ''))
    imported = parsed.data || parsed
    if (!imported?.nodeData?.topic) throw new Error('文件需要包含 nodeData 根节点')
    $('import-description').textContent = `即将导入「${String(imported.nodeData.topic)}」。`
    $<HTMLDialogElement>('import-dialog').showModal()
  } catch (error) {
    notice(`导入失败：${(error as Error).message}`)
  }
  input('import-file').value = ''
}
button('import-cancel').onclick = () => {
  imported = null
  $<HTMLDialogElement>('import-dialog').close()
}
button('import-confirm').onclick = async () => {
  if (!imported || actionBusy || conflict || recovered) return
  if (detailsDirty) {
    notice('请先保存节点详情。')
    return
  }
  await save()
  if (pending || changed() || conflict) return
  actionBusy = true
  mind.disableEdit()
  try {
    const result = await request('/api/document', {
      documentId: current.documentId,
      baseRevision: current.revision,
      requestId: crypto.randomUUID(),
      data: imported,
      actor,
      summary: '导入导图',
    })
    imported = null
    render(result, true)
    clearDraft()
    $<HTMLDialogElement>('import-dialog').close()
  } catch (error) {
    $<HTMLDialogElement>('import-dialog').close()
    notice(`导入失败：${(error as Error).message}`)
    remoteWaiting = true
  } finally {
    actionBusy = false
    mind.enableEdit()
    updateHeading()
    if (remoteWaiting) void pullLatest()
  }
}
button('connection').onclick = () => $<HTMLDialogElement>('connection-dialog').showModal()
button('connection-close').onclick = () => $<HTMLDialogElement>('connection-dialog').close()
window.addEventListener(
  'keydown',
  event => {
    const target = event.target as HTMLElement
    if (target.closest('input, textarea, select, [contenteditable]')) return
    if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) {
      event.preventDefault()
      event.stopPropagation()
      void history(event.key.toLowerCase() === 'y' || event.shiftKey ? 'redo' : 'undo')
    }
  },
  true
)
window.addEventListener('beforeunload', event => {
  if (rendered && (changed() || pending || editing())) {
    keepDraft()
    event.preventDefault()
    event.returnValue = ''
  }
})
document.addEventListener('input', event => {
  if ((event.target as HTMLElement).id === 'input-box') keepDraft()
})
document.addEventListener('focusout', () => {
  setTimeout(() => {
    if (remoteWaiting && !editing()) void pullLatest()
  }, 0)
})

async function start() {
  try {
    current = await request('/api/document')
    mind = new MindElixir({
      el: '#map',
      direction: MindElixir.RIGHT,
      newTopicName: '新节点',
      editable: true,
      keypress: true,
      allowUndo: false,
      toolBar: true,
      contextMenu: { locale: zh_CN, focus: false, link: true },
      theme: simpleTheme,
    })
    // MEC sets the host to position:relative in its constructor. Restore the
    // application shell's viewport-sized canvas before measuring the layout.
    $('map').style.position = 'fixed'
    mind.init(current.data)
    fitMap()
    // MEC's generic serializer strips every object-valued "parent" key, even
    // inside metadata. Omit only runtime node parents and retain extension data.
    mind.getData = function () {
      const exportNode = (node: NodeObj): NodeObj => {
        const { parent, children, ...fields } = node
        return { ...fields, ...(children ? { children: children.map(exportNode) } : {}) }
      }
      return JSON.parse(
        JSON.stringify({
          ...current.data,
          nodeData: exportNode(mind.nodeData),
          direction: mind.direction,
          compact: mind.compact,
          theme: mind.theme,
          arrows: mind.arrows,
          summaries: mind.summaries,
          meta: mind.meta,
        })
      ) as MindElixirData
    }
    mind.undo = () => void history('undo')
    mind.redo = () => void history('redo')
    rendered = true
    savedSignature = signature(mind.getData())
    updateHeading()
    status('已保存到本机')
    mind.bus.addListener('operation', operation => {
      if (operation.name !== 'beginEdit') capture()
    })
    mind.bus.addListener('expandNode', capture)
    mind.bus.addListener('changeDirection', capture)
    mind.bus.addListener('linkDiv', () => {
      queueMicrotask(capture)
    })
    mind.bus.addListener('selectNodes', showDetails)
    mind.bus.addListener('unselectNodes', showDetails)
    setInterval(() => {
      if (!conflict && !pending) capture()
    }, 1000)
    try {
      recovered = JSON.parse(localStorage.getItem(draftKey) || 'null') as Draft | null
      if (recovered) recoveryStorageKey = draftKey
      if (!recovered) {
        const drafts = Object.keys(localStorage)
          .filter(key => key.startsWith(draftPrefix))
          .map(key => {
            try {
              return { key, draft: JSON.parse(localStorage.getItem(key)!) as Draft }
            } catch {
              return null
            }
          })
          .filter((entry): entry is { key: string; draft: Draft } => !!entry && entry.draft.documentId === current.documentId)
        const newest = drafts.sort((a, b) => b.draft.savedAt.localeCompare(a.draft.savedAt))[0]
        recovered = newest?.draft || null
        recoveryStorageKey = newest?.key || null
      }
      if (recovered && !recovered.details && signature(recovered.data) === savedSignature) {
        recovered = null
        clearDraft()
      }
    } catch {
      recovered = null
    }
    if (recovered) {
      mind.disableEdit()
      notice('检测到上次未保存的本地草稿。可恢复查看，或导出后载入服务器版本。', ['restore-draft', 'draft-export', 'reload-latest'])
    }
    const events = new EventSource('/api/events')
    events.addEventListener('revision', event => {
      const update = JSON.parse((event as MessageEvent).data)
      if (update.revision > current.revision || update.documentId !== current.documentId) {
        remoteWaiting = true
        void pullLatest()
      }
    })
    events.onopen = () => {
      if (!pending && !conflict) {
        status('已连接本机')
        void pullLatest()
      }
    }
    events.onerror = () => status('连接中断 · 等待重连', true)
  } catch (error) {
    status('无法打开导图', true)
    notice(`请先在项目中运行 npm run dev，然后刷新页面。${(error as Error).message}`)
  }
}
void start()
