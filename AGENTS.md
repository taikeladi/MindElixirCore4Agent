# 个人 AI 思维导图工作区

应用目录是仓库根目录下的 `mind-elixir-core-5.15.1/`。先读应用目录的 `PERSONAL_README.zh-CN.md`；历史背景见 `HANDOFF_AI_MINDMAP.zh-CN.md`。

## 用户要求整理或编辑导图时

- 这是可以实际操作的本地应用。阅读用户指定文档后，用下面的本地 CLI 写入导图，不要只回复大纲或要求用户搬运 JSON。
- 在应用目录运行 `npm.cmd run dev`，页面默认 `http://127.0.0.1:23333/`。先检测 `/api/health`；已有正确服务时复用，不结束未知进程。
- `node personal/cli.mjs get` 读取最新文档、documentId、revision 和稳定节点 ID；`node personal/cli.mjs subtree <id>` 读取子树（包含收起节点）。
- 把修改写成 UTF-8 JSON 请求文件：`{documentId, baseRevision, requestId, actor:"codex", summary, operations:[...]}`，再运行 `node personal/cli.mjs apply <请求文件>`。requestId 可省略由 CLI 生成；网络结果不明时，应复用相同 requestId 和相同内容重试。
- 操作包括 `add_node`（parentId,node,index?）、`update_node`（id,patch）、`move_node`（id,parentId,index?）、`delete_node`（id）。完整协议见 `node personal/cli.mjs protocol`。
- 普通补充使用局部操作。仅在用户明确要求整图替换/新建时，用 `replace <请求文件>`，请求携带 `data` 而非 `operations`。
- 版本冲突时重新读取并重新规划；不要仅修改 baseRevision 后盲目重放旧的全图内容。不要直接改 `.mindmap/document.json`，唯一写入入口是本地服务。
- 节点标题简短，长解释放 `note`；来源写入 `metadata.sources:[{document,section,page,quote}]`，内容性质用 `metadata.kind: fact|summary|inference`。引用和页码必须有原文依据。修改 metadata 时保留已有字段和来源。
- 命令成功后核对返回的新 revision、受影响节点和数据；浏览器通过 SSE 自动更新。
- DeepSeek 运行需要用户本机的 `.env.local`，不要读取或输出密钥。不擅自发送未指定文档或运行会产生模型费用的真实调用。

## 开发验证

- 尽量修改外围 `personal/` 与 `src/personal/`，保留 MEC 核心和原始 demo。
- 协议/服务检查：`npm.cmd run test:personal`。
- 页面检查：`npm.cmd run test:personal:ui`，独立端口 23335、临时数据目录，不覆盖用户存档。
- 类型检查：`npm.cmd run tsc -- --noEmit`；上游构建：`npm.cmd run build`。
- 不提交/上传 `.mindmap`、`.env.local` 或用户文档。不要自动创建公开仓库。
- 公开文档和示例使用仓库相对路径，不记录真实本机目录、私人对话、个人邮箱或其他项目的信息。提交使用 GitHub 隐私邮箱；保留上游版权及许可声明。
