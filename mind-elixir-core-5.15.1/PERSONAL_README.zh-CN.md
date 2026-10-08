# 个人 AI 思维导图

在 MEC 5.15.1 外围增加本地保存、版本检查、AI 编辑协议和浏览器实时同步。原始演示保留在 `/demo.html`。

## 启动与日常使用

环境：Node.js 22 或更新版本，依赖按 `pnpm-lock.yaml` 安装。从仓库根目录执行：

```powershell
cd mind-elixir-core-5.15.1
pnpm.cmd install --frozen-lockfile  # 首次安装或迁移目录后需要
npm.cmd run dev
```

打开 <http://127.0.0.1:23333/>。也可以在父目录运行 `./start.ps1`。停止服务使用 Ctrl+C。仅监听本机地址；默认不会联网调用模型。

- 双击修改文字；Tab 新增子节点；Enter 新增同级节点；拖动调整层级。底部保留 MEC 缩放工具。
- 数据变化后自动保存；右上角显示保存状态。刷新和服务重启后恢复同一份导图及节点 ID。
- 顶部撤销/重做或 Ctrl+Z / Ctrl+Shift+Z 使用服务端历史，人工和 AI 共用。一次 AI 批次为一次撤销；人工相邻 180 ms 内的变更会合并。
- “备注与来源”面板编辑选中节点，保留未涉及的 metadata 和其他来源。面板默认收起以保留画布空间。
- 导出为完整 MEC JSON；导入需要确认替换，可撤销。PDF/Word 先由 Codex 或现有工具阅读提取，不是直接导入文件格式。
- 发生并发冲突时保留当前页面和本地草稿，服务器内容不会被旧版本覆盖。“载入最新版本”先下载草稿备份；需要继续的部分让 AI 根据草稿和最新图做局部合并。

## 数据位置与恢复

存档在应用目录 `.mindmap/document.json`，包含图数据、版本号、最近撤销/重做历史和请求回执。每次提交先写临时文件、同步磁盘再替换存档；`.mindmap/document.json.bak` 保留上一次有效版本。

只有服务进程写存档，浏览器和 CLI 都通过同一 HTTP API 提交。不在服务运行时手改存档。数据目录有进程锁；进程异常退出的锁会在确认 PID 不存在后清理。损坏存档不会被自动初始化覆盖。恢复备份时先停止服务、复制损坏原件，再用 `.bak` 恢复，重新启动。恢复后已打开的浏览器应刷新。

浏览器在断网/冲突时将草稿放在当前站点的 localStorage。下次打开会提示恢复；这只是故障补救，正常存档在磁盘。多窗口可以实时同步，但两处同时编辑可能出现需要人工合并的版本冲突。单张图接受最多 5000 节点、100 层、4 MB，这些是输入上限，不是性能保证。历史最多 40 步且每个方向最多 16 MB，超过会移除最旧历史。

## Codex 直接编辑

父目录 `AGENTS.md` 提供操作指南。直接在此工作区对 Codex 说“阅读这份文档并整理到当前导图”即可；Codex 使用本机命令，不需要另外申请 OpenAI API 密钥。

```powershell
node personal/cli.mjs get
node personal/cli.mjs subtree example-goals
node personal/cli.mjs protocol
node personal/cli.mjs apply edit-request.json
```

先读取实际 `documentId` 和 `revision`，请求示例：

```json
{
  "documentId": "替换成 get 返回的 documentId",
  "baseRevision": 3,
  "requestId": "一个新的唯一请求ID",
  "actor": "codex",
  "summary": "补充阅读笔记",
  "operations": [
    {"type":"update_node","id":"example-goals","patch":{"note":"补充说明"}},
    {"type":"add_node","parentId":"example-goals","node":{"id":"new-stable-id","topic":"新观点"}}
  ]
}
```

节点 ID 不随编辑变化。ID 允许字母、数字、下划线、连字符。`patch` 不能修改 id/children；`metadata` 是整体替换，需保留原有键；可选字段传 null 表示移除。`move_node.index` 是移除源节点后在目标 children 中的插入位置，不传则追加。删除节点会删除子树及悬空关联线。若节点操作使既有总结括号不再对应连续的原始成员，该操作被拒绝，避免悄悄改变总结语义。

写入必须带 documentId、baseRevision、requestId。CLI 可以生成 requestId；直接 API 调用必须提供。同 requestId 同内容的重试只提交一次，最近 128 条回执保留在磁盘。409 表示冲突，须重新读取而非强制覆盖。

| HTTP 接口 | 用途 |
| --- | --- |
| GET `/api/document` | 完整文档、版本、历史状态 |
| GET `/api/subtree/:id` | 子树（包括收起的节点） |
| GET `/api/protocol` | 操作 JSON schema |
| POST `/api/operations` | 原子批量局部修改 |
| POST `/api/document` | 替换导图，请求包含 data |
| POST `/api/history/undo`、`redo` | 整体撤销/重做 |
| GET `/api/events` | SSE 版本通知，页面自动拉取 |
| GET `/api/health` | 服务识别和版本 |

可用 `MINDMAP_PORT` 更改服务端口；CLI 的 `MINDMAP_URL` 需对应。`MINDMAP_DATA_DIR` 可指定另一个本地存档目录。默认只管理一张当前导图，可用 JSON 导入/导出保存多份。首版是本地开发服务器，不是公网部署服务。

## DeepSeek V4

适配器使用官方 Chat Completions + Tool Calls，默认模型 **deepseek-v4-pro**，不自动替换为其他模型。模型 ID、工具参数与非思考模式开关于 2026-09-29 核对 [DeepSeek 官方 API 文档](https://api-docs.deepseek.com/api/create-chat-completion/)。

1. 将 `.env.example` 复制为 `.env.local`，在本机编辑 `DEEPSEEK_API_KEY`。不要将密钥贴进聊天或放到前端文件。
2. 启动本地服务。
3. 运行：

```powershell
npm.cmd run deepseek -- --document personal/examples/城市绿地观察计划.md --prompt "按文档生成导图，保留来源" --replace
# 此后增量编辑，不传 --replace：
npm.cmd run deepseek -- --prompt "为观察方法分支补充更清晰的说明，不修改其他分支"
```

只有显式执行此命令时，指定原文、用户指令和当前导图才会发给配置的 DeepSeek 服务，会使用该账户 API 额度。适配器只读取指定的 UTF-8 `.md`/`.txt`/`.markdown` 文件（上限 15 万字符），不扫描工作区、不上传其他文件。

模型工具在内存工作副本上执行；完整计划成功后，使用最初读到的版本一次性提交。无效命令、模型报错、截断、轮数上限或生成期间人工编辑冲突都不会部分写入。`--dry-run` 仍会调用模型，但只输出计划而不提交导图。模型 API 返回错误时不回显包含凭据的请求。

**当前验证状态：适配器及模拟工具调用测试已实现；未配置真实 API 密钥，因此尚未完成真实 DeepSeek 连接验收。**

## 示例与验证

虚构示例原文：`personal/examples/城市绿地观察计划.md`；对应导图：`personal/examples/城市绿地观察计划.mindmap.json`。可从页面“导入”打开。原文事实、整理归纳和待确认推断在节点来源中区分。

```powershell
npm.cmd run test:personal
npm.cmd run test:personal:ui
npm.cmd run tsc -- --noEmit
npm.cmd run build
```

协议和服务测试使用系统临时目录。浏览器测试独立使用端口 23335 和临时存档，不覆盖个人数据；Windows 默认使用本机 Edge，可通过 `MEC_BROWSER_CHANNEL` 指定其他已安装通道。其他平台需先运行 `pnpm exec playwright install chromium`。上游测试仍可用 `npm test`；`npm run dev:core` 只启动原 Vite 核心开发模式，不包含个人保存接口。

2026-09-29 验收：14 项协议/服务/模型模拟测试和 9 项浏览器测试通过，类型检查、改动文件静态检查、上游构建通过。详情见 `personal/VERIFICATION.zh-CN.md`；示例验收截图位于 `personal/artifacts/example-preview.png`。

Codex 的工作区操作说明使用 [OpenAI 官方 AGENTS.md 机制](https://learn.chatgpt.com/docs/agent-configuration/agents-md)。当前接入是实际可调用的本地 CLI/API，没有宣称安装 MCP 或修改全局 Codex 配置。
