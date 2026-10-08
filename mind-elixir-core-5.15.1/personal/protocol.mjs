// Model-independent, DOM-independent editing protocol. No runtime parent pointers.
export class ProtocolError extends Error {
  constructor(message, status = 400, code = 'INVALID_INPUT') {
    super(message)
    this.status = status
    this.code = code
  }
}

export const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024
const ID = /^[a-zA-Z0-9_-]{1,128}$/
const forbidden = new Set(['__proto__', 'constructor', 'prototype', 'dangerouslySetInnerHTML'])
const nodeFields = new Set(['topic', 'note', 'metadata', 'expanded', 'direction', 'style', 'tags', 'icons', 'hyperLink', 'image', 'branchColor'])
export const assert = (condition, message, status, code) => {
  if (!condition) throw new ProtocolError(message, status, code)
}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const validId = (value, label = 'id') => assert(typeof value === 'string' && ID.test(value), `${label} 仅允许 1–128 位字母、数字、下划线和连字符`)
const text = (value, label, max = 100000) => assert(typeof value === 'string' && value.length <= max, `${label} 必须是字符串（最多 ${max} 字符）`)

function inspectJson(value, depth = 0) {
  assert(depth <= 150, '数据嵌套过深')
  if (value === null || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    assert(!forbidden.has(key), `不支持字段 ${key}`)
    inspectJson(child, depth + 1)
  }
}

function safeUrl(value, image = false) {
  text(value, 'URL', 2 * 1024 * 1024)
  assert(/^(https?:\/\/|mailto:)/i.test(value) || (image && /^data:image\/(png|jpeg|gif|webp);base64,/i.test(value)), '链接只支持 http(s)/mailto，图片支持 http(s) 或 PNG/JPEG/GIF/WebP data URL')
}

function validateFields(node) {
  text(node.topic, 'topic', 10000)
  assert(node.topic.trim().length > 0, '节点标题不能为空')
  if ('note' in node) text(node.note, 'note')
  if ('expanded' in node) assert(typeof node.expanded === 'boolean', 'expanded 必须是布尔值')
  if ('direction' in node) assert([0, 1].includes(node.direction), '节点 direction 必须是 0 或 1')
  if ('metadata' in node) assert(object(node.metadata), 'metadata 必须是对象')
  if ('style' in node) {
    assert(object(node.style), 'style 必须是对象')
    for (const value of Object.values(node.style)) text(value, 'style 值', 1000)
  }
  if ('tags' in node) {
    assert(Array.isArray(node.tags), 'tags 必须是数组')
    for (const tag of node.tags) {
      if (object(tag)) {
        text(tag.text, 'tag.text', 1000)
        if ('className' in tag) text(tag.className, 'tag.className', 1000)
        if ('style' in tag) {
          assert(object(tag.style), 'tag.style 必须是对象')
          for (const value of Object.values(tag.style)) text(value, 'tag.style 值', 1000)
        }
      } else text(tag, 'tag', 1000)
    }
  }
  if ('icons' in node) {
    assert(Array.isArray(node.icons), 'icons 必须是数组')
    node.icons.forEach(icon => text(icon, 'icon', 1000))
  }
  if (node.hyperLink) safeUrl(node.hyperLink)
  if ('image' in node) {
    assert(object(node.image), 'image 必须是对象')
    safeUrl(node.image.url, true)
    assert([node.image.width, node.image.height].every(n => Number.isFinite(n) && n > 0 && n <= 10000), '图片尺寸无效')
  }
  if ('branchColor' in node) text(node.branchColor, 'branchColor', 100)
}

export function indexNodes(root) {
  const index = new Map()
  function visit(node, parent, depth) {
    assert(depth <= 100, '导图最多支持 100 层')
    assert(object(node), '节点必须是对象')
    validId(node.id)
    assert(!index.has(node.id), `重复节点 ID：${node.id}`)
    assert(!('parent' in node), '节点不能包含运行时 parent 引用')
    validateFields(node)
    index.set(node.id, { node, parent })
    assert(index.size <= 5000, '单张导图最多接受 5000 个节点；这不是性能承诺')
    if ('children' in node) {
      assert(Array.isArray(node.children), 'children 必须是数组')
      node.children.forEach(child => visit(child, node, depth + 1))
    }
  }
  visit(root, null, 0)
  return index
}

export function validateDocument(data) {
  assert(object(data), '导图必须是对象')
  inspectJson(data)
  const index = indexNodes(data.nodeData)
  assert(new TextEncoder().encode(JSON.stringify(data)).length <= MAX_DOCUMENT_BYTES, '导图文件超过 4 MB')
  if ('direction' in data) assert([0, 1, 2, 3].includes(data.direction), '导图 direction 必须是 0–3')
  if ('compact' in data) assert(typeof data.compact === 'boolean', 'compact 必须是布尔值')
  if ('meta' in data) assert(object(data.meta), 'meta 必须是对象')
  if ('theme' in data) {
    assert(object(data.theme), 'theme 必须是对象')
    text(data.theme.name, 'theme.name', 100)
    assert(Array.isArray(data.theme.palette) && data.theme.palette.length > 0, 'theme.palette 不能为空')
    data.theme.palette.forEach(color => text(color, '主题颜色', 100))
    if ('cssVar' in data.theme) {
      assert(object(data.theme.cssVar), 'theme.cssVar 必须是对象')
      for (const [key, value] of Object.entries(data.theme.cssVar)) {
        assert(key.startsWith('--'), '主题变量必须以 -- 开头')
        text(value, '主题变量', 1000)
      }
    }
  }
  for (const key of ['arrows', 'summaries']) {
    if (!(key in data)) continue
    assert(Array.isArray(data[key]), `${key} 必须是数组`)
    const ids = new Set()
    for (const item of data[key]) {
      assert(object(item), `${key} 元素必须是对象`)
      validId(item.id)
      assert(!ids.has(item.id), `重复 ${key} ID`)
      ids.add(item.id)
      text(item.label, `${key}.label`, 10000)
      if (key === 'arrows') {
        assert(index.has(item.from) && index.has(item.to), '关联线端点不存在')
        for (const delta of [item.delta1, item.delta2]) {
          if (delta) assert(Number.isFinite(delta.x) && Number.isFinite(delta.y), '关联线坐标无效')
        }
      } else {
        const children = index.get(item.parent)?.node.children || []
        assert(Number.isInteger(item.start) && Number.isInteger(item.end) && item.start >= 0 && item.end >= item.start && item.end < children.length, '总结标记的父节点或范围无效')
      }
    }
  }
  return data
}

// Preserve summary membership when sibling indices change. Reject an operation
// if the original bracket could no longer describe a contiguous sibling range.
function summaryMembers(data) {
  const index = indexNodes(data.nodeData)
  return (data.summaries || []).map(summary => ({
    summary,
    ids: index.get(summary.parent).node.children.slice(summary.start, summary.end + 1).map(n => n.id),
  }))
}
function restoreSummaries(data, members) {
  const index = indexNodes(data.nodeData)
  data.summaries = members.flatMap(({ summary, ids }) => {
    const children = index.get(summary.parent)?.node.children || []
    const positions = ids.filter(id => index.has(id)).map(id => children.findIndex(n => n.id === id)).sort((a, b) => a - b)
    if (!positions.length) return []
    assert(positions[0] >= 0 && positions.at(-1) - positions[0] + 1 === positions.length, `操作会改变总结 ${summary.id} 的成员关系，请先调整或删除总结`)
    return [{ ...summary, start: positions[0], end: positions.at(-1) }]
  })
}

export function applyOperations(original, operations) {
  assert(Array.isArray(operations) && operations.length > 0 && operations.length <= 500, 'operations 必须包含 1–500 条命令')
  const data = structuredClone(validateDocument(original))
  const affected = new Set()
  for (const op of operations) {
    assert(object(op), '操作必须是对象')
    const allowed = {
      add_node: ['type', 'parentId', 'index', 'node'],
      update_node: ['type', 'id', 'patch'],
      move_node: ['type', 'id', 'parentId', 'index'],
      delete_node: ['type', 'id'],
    }[op.type]
    assert(allowed && Object.keys(op).every(key => allowed.includes(key)), `未知操作或多余参数：${op.type}`)
    const index = indexNodes(data.nodeData)
    const get = id => {
      validId(id)
      const item = index.get(id)
      assert(item, `节点不存在：${id}`, 404, 'NODE_NOT_FOUND')
      return item
    }
    const insert = (parent, node) => {
      parent.children ||= []
      const position = op.index ?? parent.children.length
      assert(Number.isInteger(position) && position >= 0 && position <= parent.children.length, '插入位置 index 越界')
      parent.children.splice(position, 0, node)
      affected.add(parent.id)
    }
    const members = summaryMembers(data)
    if (op.type === 'add_node') {
      const { node: parent } = get(op.parentId)
      assert(object(op.node), 'add_node 需要 node 对象')
      for (const id of indexNodes(op.node).keys()) {
        assert(!index.has(id), `重复节点 ID：${id}`)
        affected.add(id)
      }
      insert(parent, structuredClone(op.node))
    } else if (op.type === 'update_node') {
      const { node } = get(op.id)
      assert(object(op.patch) && Object.keys(op.patch).length > 0, 'update_node 需要非空 patch')
      for (const [key, value] of Object.entries(op.patch)) {
        assert(nodeFields.has(key), `不能用 patch 修改 ${key}`)
        if (value === null && key !== 'topic') delete node[key]
        else node[key] = structuredClone(value)
      }
      affected.add(node.id)
    } else if (op.type === 'move_node') {
      const { node, parent } = get(op.id)
      assert(parent, '不能移动根节点')
      const destination = get(op.parentId).node
      assert(!indexNodes(node).has(destination.id), '移动不能形成循环')
      parent.children.splice(parent.children.indexOf(node), 1)
      insert(destination, node)
      affected.add(parent.id)
      affected.add(node.id)
    } else if (op.type === 'delete_node') {
      const { node, parent } = get(op.id)
      assert(parent, '不能删除根节点')
      const removed = indexNodes(node)
      parent.children.splice(parent.children.indexOf(node), 1)
      data.arrows = (data.arrows || []).filter(a => !removed.has(a.from) && !removed.has(a.to))
      removed.forEach((_, id) => affected.add(id))
      affected.add(parent.id)
    } else throw new ProtocolError(`未知操作：${op.type}`)
    restoreSummaries(data, members)
    validateDocument(data)
  }
  return { data, affectedNodeIds: [...affected] }
}

const nodeSchema = {
  type: 'object',
  description: 'MEC node. Stable id and topic required; children are recursive nodes. metadata.sources: [{document, section, page, quote}], metadata.kind: fact|summary|inference.',
  properties: { id: { type: 'string' }, topic: { type: 'string' }, note: { type: 'string' }, metadata: { type: 'object' }, children: { type: 'array', items: { type: 'object' } } },
  required: ['id', 'topic'],
}
export const operationsSchema = {
  type: 'array', minItems: 1, maxItems: 500,
  items: { oneOf: [
    { type: 'object', properties: { type: { const: 'add_node' }, parentId: { type: 'string' }, index: { type: 'integer', minimum: 0 }, node: nodeSchema }, required: ['type', 'parentId', 'node'], additionalProperties: false },
    { type: 'object', properties: { type: { const: 'update_node' }, id: { type: 'string' }, patch: { type: 'object', description: 'Patch only supplied fields; null removes an optional field. metadata replaces the entire metadata object; preserve existing keys.' } }, required: ['type', 'id', 'patch'], additionalProperties: false },
    { type: 'object', properties: { type: { const: 'move_node' }, id: { type: 'string' }, parentId: { type: 'string' }, index: { type: 'integer', minimum: 0 } }, required: ['type', 'id', 'parentId'], additionalProperties: false },
    { type: 'object', properties: { type: { const: 'delete_node' }, id: { type: 'string' } }, required: ['type', 'id'], additionalProperties: false },
  ] },
}
