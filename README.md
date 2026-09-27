# PI Agent Workbench

使用 PI SDK、Node.js 和 TypeScript 构建带证据的 GitHub 仓库技术分析工作台。输入公开仓库与目标，固定提交版本，生成可追溯的分析报告并展示执行过程。

**现已提供合成仓库离线演示、公开 GitHub 固定 SHA 快照，以及显式注入 PI provider 的单 Agent 报告流水线。尚无 Web 或 API 服务；真实模型质量和在线评测未验证。**

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
npm run demo:offline
```

没有 nvm 时，先准备上述版本的 Node/npm，再从 `npm ci` 开始。全局 npm 安装命令仅用于你选择的 Node 环境；本轮 Agent 验证使用临时工具链，没有更改系统 Node。`npm run check` 和 `npm test` 会拒绝不一致的工具链。

根目录的 `package-lock.json` 是 workspace 安装依据。根安装后无需再进入子目录安装依赖；`spikes/pi-sdk/package-lock.json` 仅保留给独立 spike 的历史复现。所有模型测试使用模拟 provider，不需要 API Key，不调用真实模型。安装依赖需要访问 npm 注册表。

CI 配置见 [.github/workflows/ci.yml](.github/workflows/ci.yml)，执行根 workspace 和独立 spike 的干净安装与检查。具体已执行证据及远程 CI 状态见 [TASK-003](doc/tasks/003-project-foundation.md)。

## 当前模块

| 路径 | 职责 |
| --- | --- |
| `packages/protocol` | 版本化输入、预算、事件、结果、证据与产物引用的 schema 和校验 |
| `packages/agent-runtime` | PI SDK 薄适配层、受控资源与工具、调用/Token/成本预算、取消和结果校验入口 |
| `packages/tools` | 获取固定 SHA 的公开 GitHub 快照并施加下载/解包边界；只读列举、读取、检索与证据登记 |
| `packages/reporting` | 单 Agent 快照分析、报告和证据校验、Markdown 与 manifest/事件日志生成、离线评测 |
| `spikes/pi-sdk` | 保留的 SDK 行为实验与负向回归 |

运行适配层接口与边界见 [模块说明](packages/agent-runtime/README.md)。当前源码通过 tsx 运行；未配置发布构建，也没有根 `npm start` 或 Web 服务。

七个生命周期场景和回归说明见 [spike 文档](spikes/pi-sdk/README.md)。

## 第一版目标

- 公开 GitHub 仓库固定 SHA，限制文件和获取范围。
- 单 Agent 通过只读工具收集证据，不安装或执行目标仓库代码。
- 结构化报告与 Markdown 报告共享事实来源。
- 展示运行事件、证据和产物，支持取消。
- 离线自动测试与单独授权的在线模型评测。

`npm run demo:offline` 使用 `fixtures/synthetic-ts-repo`，写入被 Git 忽略的 `artifacts/TASK-004/`。它不会连接网络、读取 API Key、安装或执行 fixture 中的脚本；评测基于预先维护的合成 golden facts，证据支持与无依据断言由人工标注。当前还提供真实固定 SHA 的只读快照与报告库入口，但尚无 Web/API、在线评测 CLI 或真实模型质量验证。当前不支持进程重启恢复、多 Agent、Docker 执行、RAG 或长期记忆。

### TASK-005 公开仓库分析入口

从 `@pi-workbench/reporting` 导入 `runPublicRepositoryAnalysis`。调用方必须显式提供 PI provider、model、credentials、价格表和运行预算；适配层不会加载个人 PI 配置，也不会自动开启网络模型。分支或 tag ref 会先解析为完整 SHA；完整 SHA 输入直接获取该不可变版本。Agent 只能列举、读取、检索快照和登记证据，仓库文件（包括 AGENTS.md）均按数据处理，不安装或执行源码。

必需的调用参数包括 repository（公开 GitHub HTTPS URL 与可选 ref）、cacheDirectory、outputDirectory、credentials、provider、model、budget 和 pricing。成功时返回结构化结果、SHA 快照信息、产物路径以及 report.json、report.md、manifest.json 和 events.jsonl 的校验引用。入口实现见 [public-runner.ts](packages/reporting/src/public-runner.ts)。

TASK-005 的首个评测样例固定为 sindresorhus/slugify@7c318bd1aa4b4affab29761f15a9604323fe2a3b，许可为 MIT；人工必答事实见 [public-repository-facts.json](evals/public-repository-facts.json)。真实仓库到报告已通过 faux provider 验证，不代表真实模型质量。真实模型评测需另行明确模型、价格、Token/成本上限并授权。

## 开发与协作

- [项目计划](doc/plan.md)
- [任务索引](doc/tasks/README.md)
- [PI SDK 集成决策](doc/decisions/001-pi-sdk-integration.md)
- [协作与交接流程](doc/multi-agent-workflow.md)
- [仓库规则](AGENTS.md)

先读任务卡再修改，默认一个任务分支和一个写入者。Issue 可选；PR 记录问题、验证与限制。提交前检查差异，不提交模型凭据、本地运行数据或私有笔记。SDK 源码参考目录不是启动前置条件。

## 依赖与许可证

核心依赖为 [PI SDK](https://github.com/earendil-works/pi)，通过发布包使用，没有复制其实现源码。本项目采用 [MIT 许可证](LICENSE)，第三方依赖保留各自许可证。
