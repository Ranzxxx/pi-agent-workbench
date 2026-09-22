# PI Agent Workbench

使用 PI SDK、Node.js 和 TypeScript 构建带证据的 GitHub 仓库技术分析工作台。输入公开仓库与目标，固定提交版本，生成可追溯的分析报告并展示执行过程。

**项目已建立协议、PI 运行适配层与离线测试，尚未提供 Web、API 或实际仓库分析功能。**

## 安装与验证

正式 workspace 固定 Node.js **24.21.0**、npm **11.9.0**，使用 ESM 和 TypeScript strict。已安装 nvm 的本地环境可在项目根目录执行：

```bash
nvm install
nvm use
npm install --global npm@11.9.0 --ignore-scripts --no-audit --no-fund
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm test
npm run spike
```

没有 nvm 时，先准备上述版本的 Node/npm，再从 `npm ci` 开始。全局 npm 安装命令仅用于你选择的 Node 环境；本轮 Agent 验证使用临时工具链，没有更改系统 Node。`npm run check` 和 `npm test` 会拒绝不一致的工具链。

根目录的 `package-lock.json` 是 workspace 安装依据。根安装后无需再进入子目录安装依赖；`spikes/pi-sdk/package-lock.json` 仅保留给独立 spike 的历史复现。所有模型测试使用模拟 provider，不需要 API Key，不调用真实模型。安装依赖需要访问 npm 注册表。

CI 配置见 [.github/workflows/ci.yml](.github/workflows/ci.yml)，执行根 workspace 和独立 spike 的干净安装与检查。具体已执行证据及远程 CI 状态见 [TASK-003](doc/tasks/003-project-foundation.md)。

## 当前模块

| 路径 | 职责 |
| --- | --- |
| `packages/protocol` | 版本化输入、预算、事件、结果、证据与产物引用的 schema 和校验 |
| `packages/agent-runtime` | PI SDK 薄适配层、受控资源与工具、调用/Token/成本预算、取消和结果校验入口 |
| `spikes/pi-sdk` | 保留的 SDK 行为实验与负向回归 |

运行适配层接口与边界见 [模块说明](packages/agent-runtime/README.md)。当前源码通过 tsx 运行；未配置发布构建，也没有根 `npm start` 或 Web 服务。

七个生命周期场景和回归说明见 [spike 文档](spikes/pi-sdk/README.md)。

## 第一版目标

- 公开 GitHub 仓库固定 SHA，限制文件和获取范围。
- 单 Agent 通过只读工具收集证据，不安装或执行目标仓库代码。
- 结构化报告与 Markdown 报告共享事实来源。
- 展示运行事件、证据和产物，支持取消。
- 离线自动测试与单独授权的在线模型评测。

仓库获取、证据采集、报告生成和 Web 仍是待实现目标。当前不支持进程重启恢复、多 Agent、Docker 执行、RAG 或长期记忆。

## 开发与协作

- [项目计划](doc/plan.md)
- [任务索引](doc/tasks/README.md)
- [PI SDK 集成决策](doc/decisions/001-pi-sdk-integration.md)
- [协作与交接流程](doc/multi-agent-workflow.md)
- [仓库规则](AGENTS.md)

先读任务卡再修改，默认一个任务分支和一个写入者。Issue 可选；PR 记录问题、验证与限制。提交前检查差异，不提交模型凭据、本地运行数据或私有笔记。SDK 源码参考目录不是启动前置条件。

## 依赖与许可证

核心依赖为 [PI SDK](https://github.com/earendil-works/pi)，通过发布包使用，没有复制其实现源码。本项目采用 [MIT 许可证](LICENSE)，第三方依赖保留各自许可证。
