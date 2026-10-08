# MindElixirCore4Agent

个人自用的 AI 思维导图编辑器，基于 Mind Elixir Core 5.15.1。

这个仓库保存个人版本的源码、配置模板、测试和虚构示例。应用代码在 `mind-elixir-core-5.15.1/`，目录结构保持不变。

## 已有功能

- 全窗口思维导图编辑：增删节点、拖动调整层级、展开收起、缩放及适应画布。
- 本地文件自动保存、刷新与重启恢复、版本冲突保护和故障草稿恢复。
- 统一 CLI / HTTP 编辑协议，让 Codex 按稳定节点 ID 创建、读取和局部修改导图。
- AI 修改实时同步至浏览器；人工与 AI 共用撤销、重做和版本检查。
- 节点备注、来源引用、事实/归纳/推断标记及完整 JSON 导入导出。
- DeepSeek V4 工具调用适配器；真实连接需要自行配置 API 密钥。

## 本地启动

需要 Node.js 22+ 和 pnpm。

```powershell
git clone https://github.com/taikeladi/MindElixirCore4Agent.git
cd MindElixirCore4Agent/mind-elixir-core-5.15.1
pnpm.cmd install --frozen-lockfile
npm.cmd run dev
```

打开 <http://127.0.0.1:23333/>。依赖安装好后，也可在仓库根目录运行 `./start.ps1`。

从克隆目录启动时，本地服务会创建新的 `.mindmap/` 存档。个人导图、模型密钥、`node_modules`、构建结果和测试缓存均不入库；`.env.example` 仅提供配置字段。仓库内示例资料为虚构材料。

提交时请使用 GitHub 隐私邮箱。文档和示例统一使用仓库相对路径，避免写入个人电脑目录、私人对话或私人联系方式。

## 文档与测试

- [个人版本使用说明](mind-elixir-core-5.15.1/PERSONAL_README.zh-CN.md)
- [验收记录](mind-elixir-core-5.15.1/personal/VERIFICATION.zh-CN.md)
- [开发交接背景](mind-elixir-core-5.15.1/HANDOFF_AI_MINDMAP.zh-CN.md)
- [Codex 工作区操作说明](AGENTS.md)

在应用目录执行：

```powershell
npm.cmd run test:personal
npm.cmd run test:personal:ui
npm.cmd run tsc -- --noEmit
npm.cmd run build
```

## 来源与许可

基础项目是 [SSShooter/mind-elixir-core](https://github.com/SSShooter/mind-elixir-core)。保留原始源码中的版权及 [MIT 许可](mind-elixir-core-5.15.1/LICENSE)，个人功能主要位于 `personal/` 和 `src/personal/`。

这是独立维护的个人版本仓库。后续本地修改提交并推送到本仓库的 `origin/main`。
