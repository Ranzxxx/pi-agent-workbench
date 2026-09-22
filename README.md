# PI Agent Workbench

使用 PI SDK、Node.js 和 TypeScript 构建带证据的 GitHub 仓库技术分析工作台。输入公开仓库与目标，固定提交版本，生成可追溯的分析报告并展示执行过程。

**项目处于技术验证阶段，尚未提供 Web、API 或实际仓库分析功能。**

## 当前可运行内容

`spikes/pi-sdk` 是独立的 SDK 实验：会话、类型化工具、事件、失败、模型取消、超时与工具取消。使用模拟 provider，不需要模型 API Key。

```bash
cd spikes/pi-sdk
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm test
npm start
```

依赖已有时跳过 npm ci。当前使用 Node.js 22.23.1 验证；正式工程计划使用 Node.js 24。干净安装与新工具链验证仍待 CI 完成。根目录目前没有 package.json，不能在根目录执行 npm start。

七个生命周期场景和回归说明见 [spike 文档](spikes/pi-sdk/README.md)。

## 第一版目标

- 公开 GitHub 仓库固定 SHA，限制文件和获取范围。
- 单 Agent 通过只读工具收集证据，不安装或执行目标仓库代码。
- 结构化报告与 Markdown 报告共享事实来源。
- 展示运行事件、证据和产物，支持取消。
- 离线自动测试与单独授权的在线模型评测。

这些是待实现目标。当前不支持进程重启恢复、多 Agent、Docker 执行、RAG 或长期记忆。

## 开发与协作

- [项目计划](doc/plan.md)
- [任务索引](doc/tasks/README.md)
- [PI SDK 集成决策](doc/decisions/001-pi-sdk-integration.md)
- [协作与交接流程](doc/multi-agent-workflow.md)
- [仓库规则](AGENTS.md)

先读任务卡再修改，默认一个任务分支和一个写入者。Issue 可选；PR 记录问题、验证与限制。提交前检查差异，不提交模型凭据、本地运行数据或私有笔记。SDK 源码参考目录不是启动前置条件。

## 依赖与许可证

核心依赖为 [PI SDK](https://github.com/earendil-works/pi)，通过发布包使用，没有复制其实现源码。本项目采用 [MIT 许可证](LICENSE)，第三方依赖保留各自许可证。
