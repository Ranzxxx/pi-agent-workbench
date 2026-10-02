# PI Agent Workbench

使用 PI SDK、Node.js 和 TypeScript 构建可扩展的本地 Agent 工作台。首个已接入能力是只读分析公开 GitHub 仓库：固定提交版本，生成带源码证据的报告，并展示执行过程。

**当前工作台把对话、运行、附件和项目修改记录保存在本地 SQLite，并由一个受监督的 Worker 执行。默认离线模拟不调用真实模型。能力中心管理已注册扩展；输入 `@` 只为当前请求选择一个已启用能力。在线模式必须在服务端显式配置 `WORKBENCH_MODE=online` 和 DeepSeek API Key。全局同时最多一个活动运行。**

v0.1.0 包含本地 Web/API 工作台、默认离线模拟的多轮对话、显式 `@仓库分析` 能力、SSE 运行事件和受限报告产物访问。正式 workspace 要求 Node.js **24.21.0** 与 npm **11.9.0**。离线模式不调用真实模型；在线分析须在服务端配置 `WORKBENCH_MODE=online` 和 `DEEPSEEK_API_KEY`，GitHub 元数据访问可选配置只读 `GITHUB_TOKEN`，真实模型请求可能产生费用。

服务进程全局最多一个活动运行。对话和运行写入本地 SQLite（默认 `~/.local/share/pi-agent-workbench/workbench.sqlite`，可用绝对路径 `PI_WORKBENCH_DATA_DIR` 改到其他目录）。API 重启后可以打开原来的对话；Worker 被中断的运行保持 `interrupted`，不会自动重新调用模型，需要在界面或 `POST /api/v2/runs/:runId/continue` 里手动继续。SSE 支持 `Last-Event-ID` 续传已持久化的事件。当前没有登录、多 Agent 或独立部署包，也不执行目标项目里的命令。项目计划、任务卡和详细验证记录保存在维护者本地，不随公开仓库发布。

当前版本已完成基础 Review 和收尾工作。仓库分析的取消会等待底层执行真正退出后才释放全局运行名额；同一会话中的历史运行及其报告可以在 Web 端重新选择，失败或取消时也可查看已登记的部分产物。更详细的内部验证记录不随公开仓库发布。

## 安装与验证

正式 workspace 固定 Node.js **24.21.0**、npm **11.9.0**，使用 ESM 和 TypeScript strict。已安装 nvm 的本地环境可在项目根目录执行：

```bash
nvm install
nvm use
npm install --global npm@11.9.0 --ignore-scripts --no-audit --no-fund
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm test
npm run dev
# 浏览器打开 http://127.0.0.1:2026
npm run spike
npm run demo:offline
```

没有 nvm 时，先准备上述版本的 Node/npm，再从 `npm ci` 开始。全局 npm 安装命令仅用于你选择的 Node 环境；本轮 Agent 验证使用临时工具链，没有更改系统 Node。`npm run check` 和 `npm test` 会拒绝不一致的工具链。

根目录的 `package-lock.json` 是 workspace 安装依据。根安装后无需再进入子目录安装依赖；`npm run dev` 同时启动只绑定 `127.0.0.1` 的 API (`2027`) 与 Web (`2026`)。如果 Web 端口被其他本地服务占用，可运行 `WEB_PORT=3026 npm run dev` 使用其他端口；API 地址可通过 `API_PORT` 调整。默认使用不产生真实模型费用的离线模拟；仓库分析在离线模式下只支持合成仓库 `https://github.com/demo/harborlight`，其他仓库和演示数据未覆盖的 ref 会被拒绝，不会将合成结果冒充成真实仓库分析。需要分析真实仓库时，将 `.env.example` 复制为本地 `.env`，设置 `WORKBENCH_MODE=online` 并填写 `DEEPSEEK_API_KEY`，密钥只由服务进程读取。`spikes/pi-sdk/package-lock.json` 仅保留给独立 spike 的历史复现。离线测试和演示使用模拟 provider，不需要 API Key，也不会调用真实模型。单独的在线评测 CLI 默认关闭；在线调用需要本地配置密钥、显式启用 `--online` 并设置人民币费用上限。安装依赖需要访问 npm 注册表。

在线 `@仓库分析` 需要先解析 GitHub 分支/标签到固定提交；若遇到 GitHub 匿名 API 限额，可在 `.env` 另设可选只读 `GITHUB_TOKEN`。它只供服务端访问 `api.github.com` 的仓库元数据和 ref，不传给浏览器或 `codeload.github.com`，不要提交 `.env`。

CI 配置见 [.github/workflows/ci.yml](.github/workflows/ci.yml)，执行根 workspace 和独立 spike 的干净安装与检查。

## 当前模块

| 路径 | 职责 |
| --- | --- |
| `apps/server` | 版本化 REST/SSE API、能力目录和安全产物访问；监督单个 Worker |
| `apps/worker` | 独立 Worker 进程，执行已接受的运行并回报事件 |
| `apps/web` | Next.js 工作台：对话、项目选择、差异与撤销、能力中心和 `@` 选择 |
| `packages/storage` | SQLite WAL、迁移和对话/运行/附件/文件修改记录 |
| `packages/protocol` | 版本化输入、预算、事件、结果、证据与产物引用的 schema 和校验 |
| `packages/agent-runtime` | PI SDK 薄适配层、受控资源与工具、调用/Token/成本预算、取消和结果校验入口 |
| `packages/tools` | 项目内文本列举、读取、搜索和修改；公开 GitHub 固定 SHA 快照与只读检索 |
| `packages/reporting` | 单 Agent 快照分析、报告和证据校验、Markdown 与 manifest/事件日志生成、离线评测及显式在线评测 CLI |
| `spikes/pi-sdk` | 保留的 SDK 行为实验与负向回归 |

运行适配层接口与边界见 [模块说明](packages/agent-runtime/README.md)。API、Web 开发服务通过 workspace `tsx` 与 Next.js 运行；生产打包目前仅为 Web 提供 `next build`。

七个生命周期场景和回归说明见 [spike 文档](spikes/pi-sdk/README.md)。

运行记录随对话保存在 SQLite 中。新一轮对话不会覆盖旧报告入口：在当前会话的“运行记录”中选择旧能力运行，即可打开其报告与已登记产物；刷新页面后会默认选择最新运行，但仍可切回旧运行。仓库分析的 `events.jsonl` 保存可解析的归档完成事件，指向 `report.json` 和 `report.md`；日志及 manifest 不能引用自身哈希，完整的四项产物哈希由运行结果和 manifest 分别提供。普通提示按 UTF-8 32 KiB 上限在提交时校验，超限会返回 `invalid_request`，不会消耗模型调用。

## 当前能力范围

- 提供可增加已注册能力的通用工作台基础；未知任务类型必须拒绝，通用界面不代表可执行任意提示词或工具。
- 能力中心列出已注册扩展，可启停和非敏感配置。输入框用 `@` 为当前这一次请求选择一个已启用且已配置的能力；移除标签后的下一轮不再加载该扩展。未知、停用或未配置的调用由服务端拒绝。开发用问候工具默认关闭。
- 打开本机项目目录后，同一项目可以有多个对话：文件在项目内共享，对话上下文分开。文件工具只处理授权根目录内的 UTF-8 文本，拒绝越界、符号链接和敏感路径。工作台不安装、不构建、也不执行目标项目代码。
- 一次请求产生的文本修改可以查看差异并整组撤销。撤销前核对文件版本；外部已改动的文件保持现状并记为冲突。永久删除对话会清掉该对话的消息、附件和撤销记录，不删除或回滚项目目录里的当前文件。活动任务未停止时删除会被拒绝。
- 公开 GitHub 仓库分析是已注册的 workflow：固定 SHA，限制文件和获取范围。
- 单 Agent 通过只读工具收集仓库证据，不安装或执行目标仓库代码。
- 结构化报告与 Markdown 报告共享事实来源。
- 展示运行事件、证据和产物，支持取消。
- 离线自动测试与单独授权的在线模型评测。

`npm run demo:offline` 使用 `fixtures/synthetic-ts-repo`，写入被 Git 忽略的本地 `artifacts/` 目录。它不会连接网络、读取 API Key、安装或执行 fixture 中的脚本；评测基于预先维护的合成 golden facts，证据支持与无依据断言由人工标注。公开仓库分析入口会获取固定 SHA 快照并生成证据报告；在线评测 CLI 通过单独命令显式启用。一次固定样本的真实模型评测和人工评分已通过质量门，但样本不足以证明模型在其他仓库上的表现。工作台默认离线模式只连接 faux provider 与合成仓库。离线回复不能代表真实模型质量。目录选择范围可用 `PI_WORKBENCH_PICKER_ROOTS`（路径分隔符分隔的绝对路径）限制。服务进程全局最多运行一个 Agent。不支持登录、多 Agent、Docker 执行、RAG 或长期记忆。`npm run test:v02` 用合成项目跑本地 API、Worker 和 SQLite 上的项目修改、撤销、附件隔离和能力请求作用域。

### 在线模型评测

`@pi-workbench/reporting` 提供 `eval:public` CLI。离线模式用于查看帮助和评分既有运行；真实调用须在项目根目录本地配置 `.env` 中的 `DEEPSEEK_API_KEY`，并显式传入 `--online` 与 `--max-cost-cny`。应用侧 Token、时长和费用阈值按 provider 返回的 usage 事后核算，是软预算而非服务端硬限额。真实凭据和运行产物不得提交。

### 公开仓库分析入口

从 `@pi-workbench/reporting` 导入 `runPublicRepositoryAnalysis`。调用方必须显式提供 PI provider、model、credentials、价格表和运行预算；适配层不会加载个人 PI 配置，也不会自动开启网络模型。分支或 tag ref 会先解析为完整 SHA；完整 SHA 输入直接获取该不可变版本。Agent 只能列举、读取、检索快照和登记证据，仓库文件（包括 AGENTS.md）均按数据处理，不安装或执行源码。

必需的调用参数包括 repository（公开 GitHub HTTPS URL 与可选 ref）、cacheDirectory、outputDirectory、credentials、provider、model、budget 和 pricing。成功时返回结构化结果、SHA 快照信息、产物路径以及 report.json、report.md、manifest.json 和 events.jsonl 的校验引用。入口实现见 [public-runner.ts](packages/reporting/src/public-runner.ts)。

首个评测样例固定为 sindresorhus/slugify@7c318bd1aa4b4affab29761f15a9604323fe2a3b，许可为 MIT；人工必答事实见 [public-repository-facts.json](evals/public-repository-facts.json)。真实仓库到报告已通过 faux provider 验证，不代表真实模型质量。真实模型评测需另行明确模型、价格、Token/成本上限并授权。

## 开发与协作

项目计划、任务记录和内部协作说明只在维护者本地保存，不纳入公开仓库。仓库规则见 [AGENTS.md](AGENTS.md)。

维护者在本地按任务记录协作，默认一个任务分支和一个写入者。Issue 可选；PR 记录问题、验证与限制。提交前检查差异，不提交模型凭据、本地运行数据或私有笔记。SDK 源码参考目录不是启动前置条件。

## 依赖与许可证

核心依赖为 [PI SDK](https://github.com/earendil-works/pi)，通过发布包使用，没有复制其实现源码。本项目采用 [MIT 许可证](LICENSE)，第三方依赖保留各自许可证。
