# TASK-005：公开仓库快照与单 Agent 分析

## 元数据

- 状态：`done`
- 负责人：Codex
- 分支或 worktree：TASK-005 实现已合并；本次验收记录分支为 `task/005-v2-evaluation-record`，`/home/lzs/Projects/pi`
- 当前验收记录基线提交：`48bab4c5edfe0fcd0af6e7cff40bafbc3e37d3ab`（PR #12 合并后的 `main`）
- 依赖任务：TASK-004
- 集成状态：实现经 PR #9、#11、#12 合并，在线评测结果及人工评分通过本次验收；本地 `main` 已同步至 PR #12 合并提交 `48bab4c5edfe0fcd0af6e7cff40bafbc3e37d3ab`。
- 在线模型选择：用户指定 PI provider `deepseek`、模型 ID `deepseek-flash`（DeepSeek 官方当前映射为 V4.1-Flash），所有后续真实模型调用使用此模型；API 地址 `https://api.deepseek.com`
- 在线调用状态：三次旧版提示词尝试曾因 `token_limit` 取消；提示词 v2 的一次获授权运行已成功产出报告并完成人工评分，质量门通过。该次 3 次模型调用、7 次工具调用、7,353 tokens，保守峰时价估算 `¥0.01424648`，低于本次授权的 `¥0.20` 应用侧上限。实际服务账单未核对；后续在线调用仍须单独授权。

## 在线测评提示词收敛续作（2026-09-27）

- 开始基线：`main` 提交 `30c592418a4754ab3acb71d01e4eafbd1b2e8ad8`；切出独立分支 `task/005-eval-prompt-v2`。
- 本阶段开始前工作区已有三处未提交文档改动：`doc/plan.md`、本任务卡、`doc/tasks/README.md`，用于记录 PR #11 合并；原样保留，不计作本阶段代码改动。
- 本阶段允许路径：`packages/reporting/src/public-runner.ts`、`packages/reporting/src/public-online-eval-cli.ts`、`packages/reporting/src/public-online-evaluation.ts`、`packages/reporting/tests/public-online-evaluation.test.ts`、本任务卡、任务索引和计划。增加 `public-online-evaluation.ts` 是为了让评分器接受新版提示记录，同时保留旧版已完成运行记录的评分兼容。用户随后将范围扩展为提交、推送、创建 PR、通过 GitHub 插件合并并同步本地 `main`，继续真实模型测评；如再次因累计 Token 限制取消，可在单次最高 ¥0.20 的应用侧费用上限下将该 Token 限制提高到协议允许的最大值。保留模型/工具调用、单次输出、超时及费用保护；不自动重复调用。
- 本阶段目标：将在线评测目标收窄到固定事实清单中的问题，只传问题 ID 与问题文本，不向模型暴露标准答案或预期证据；提示版本升级，并加入离线回归测试。
- 用户授权（2026-09-27）：提交并推送本阶段变更、在 GitHub 创建 PR、通过 GitHub 插件合并且快进同步本地 `main`；授权继续一次 DeepSeek Flash 真实评测，费用估算上限设为 ¥0.20/次。若 v2 仍因 `token_limit` 取消，允许仅对该在线评测放宽累计 Token 上限；其他预算限制保持不变。

## 目标与非目标

将公开 GitHub 仓库固定为不可变快照，通过正式 PI 适配层与受控工具产出证据报告。先支持一个小仓库，不做私有仓库、OAuth、Issue/PR 写入、目标代码安装与执行、多 Agent 或大型仓库全量扫描。

## 允许路径与依赖授权

- `packages/tools/**`、`packages/reporting/**`、`packages/agent-runtime/**`。
- `evals/**`、`fixtures/**`（仅原创/明确许可的小型 HTTP 与归档测试数据）。
- `doc/decisions/002-repository-snapshots.md`、README、计划中的真实模型/固定 SHA 记录、本任务卡及索引。
- 若需变更协议或引入归档解析依赖，先在本卡记录具体 schema/依赖和理由，经集成者指定唯一写入者后再修改共享文件。

## TASK-005 在线评测入口续作（2026-09-27）

- 在线评测续作开始（2026-09-27）：主工作区 `/home/lzs/Projects/pi` 从 `main` 的 `c8d0f83` 建立专用分支 `task/005-online-eval`；开始时已有两处未提交文档改动：`doc/plan.md` 与本任务卡，内容为用户选择 DeepSeek Flash 的模型策略和价格记录。这些是本阶段开始前已有改动，继续保留，不覆盖。
- 本阶段允许路径：`packages/reporting/**`、`evals/**`、`doc/plan.md`、`doc/tasks/README.md`、本任务卡。用户随后明确希望使用本地 `.env` 配置 API key、向 GitHub 提供可复制模板，因此额外授权添加仅含占位符的根目录 `.env.example`；`.gitignore` 已忽略真实 `.env` 并允许提交 `.env.example`。不得修改根配置/锁文件、公共协议、`packages/agent-runtime/**` 或既有快照实现；若评测入口需要扩大范围，先记录理由并暂停该部分。
- 本阶段范围：提供显式启用的 `deepseek-flash` 评测命令，使用固定公开仓库 SHA 与既有人工事实清单，记录模型 ID、提示/评测版本、usage、保守价格估算及结果评分；补齐 faux provider/离线测试和误用保护。真实 API 调用尚未授权，本阶段不运行真实模型。

## 原始公开仓库闭环实现阶段记录

- 开始时主工作区 `/home/lzs/Projects/pi` 为干净的 `main`，HEAD 与 `origin/main` 均为 `8ce3ae7d422ef0830a5aaf6251284c743d518ed7`；任务开始前无未提交修改。
- 实现工作区为上述独立 worktree；验收代理只读审查。
- 允许路径：`packages/tools/**`、`packages/reporting/**`、`packages/agent-runtime/**`、`evals/**`、`fixtures/**` 中原创测试资料、`doc/decisions/002-repository-snapshots.md`、本任务卡和索引。任何协议、根配置/锁文件及生产依赖变更均暂停并交集成者裁定。
- 依赖集成裁定（2026-09-27）：集成者为 `package-lock.json` 唯一写入者；实现者仅在 `packages/reporting/package.json` 声明现有 workspace dependency `@pi-workbench/agent-runtime@0.1.0` 和现有 production dependency `typebox@1.3.27`。前者供 runner 调用 PI runtime；后者供 runner 自行构造四个受控工具的参数 schema。两者此前仅经 npm hoisting 可见，不代表 reporting manifest 声明正确；TypeBox 已是 runtime 现有依赖，不新增外部包。实现者不改根 package.json / package-lock.json，也不运行会改锁文件的安装命令；根 lock 由集成者更新。
- 禁止读取 `fixtures/synthetic-ts-repo/AGENTS.md` 作为指令；该文件仅可作为被测仓库数据处理。
- 集成状态：PR #9 已于 2026-09-27 合并至 `main`；实现已集成。由于在线质量评测未获授权且验收项仍未验证，任务保持 `review`。

## 验收标准

- [x] URL 严格解析为 GitHub owner/repo/ref，拒绝凭据 URL、任意主机和危险重定向目标；覆盖规范化路径、危险 ref 与拒绝重定向。
- [x] 可变 branch/tag ref 先解析为完整 SHA，再按该 SHA 获取归档；提供完整 SHA 时直接按 immutable SHA 获取。codeload 请求/缓存键均为真实 SHA，不使用可变 ref；已存在的 SHA 缓存逐路径逐字节匹配新验证归档，篡改、额外路径和链接均拒绝。
- [x] 流式下载/解包时限制压缩字节、解包总字节及文件/目录项数量；拒绝路径穿越、链接、特殊文件、重复路径、结构性 PAX 字段及超限内容。
- [x] 网络、GitHub 限流、仓库/ref 不存在、危险重定向与实际挂起超时都返回脱敏 SnapshotError.code；错误 message/cause 不包含 URL query 或底层异常文本。测试覆盖敏感 query 和 fake network error 不泄露。
- [x] 固定首个公开小仓库：sindresorhus/slugify，v3.0.0，SHA 7c318bd1aa4b4affab29761f15a9604323fe2a3b，MIT；人工必答清单见 evals/public-repository-facts.json。
- [x] 可控 HTTP fixture 覆盖 ref 解析、下载和归档边界；faux provider 离线端到端生成通过 schema 与源行重新校验的报告。
- [x] 复用 runtime 时长、模型调用、工具调用、Token/费用预算；集成测试将模型调用限额设为 1，证明只有一次 provider 调用，后续调用被阻止，取消结果与部分 events/manifest 说明 call_limit。
- [x] 提示词 v2 的真实在线质量评测与人工评分完成：运行 `404428b3-c236-49f2-83de-bb177eab0441` 通过质量门。5 项基准事实中 4 项有证据支持（召回率 4/5 = 0.80），引用有效性 4/4 = 1.00，证据支持 4/4 = 1.00，不支持断言 0；`test-status` 因只读分析未运行目标仓库测试而正确弃答（1/1）。项目负责人已确认按建议评分。一次小型固定 SHA 样本只证明本次链路与评分标准通过，不代表跨仓库的一般模型质量保证。累计 Token 按 provider usage 事后检查，仍是软预算。价格与峰谷时段见 [DeepSeek 模型与价格（中文官方文档）](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)。
- [x] 真实固定 SHA 仓库快照→PI faux provider→report.json/report.md/manifest/events 的展示闭环成功。此项验证真实仓库获取和离线报告路径；真实模型质量由上一项在线评测单独验收。

## 验证计划（实施后提供）

根 check/test；针对快照下载/路径边界的离线测试；验证在线评测默认关闭、缺少显式开关/Key 时失败、模型/provider 固定为 `deepseek-flash`、评分输入和输出可复现。真实 GitHub 获取与真实模型计费分别记录，不混为一次“离线测试”。在线调用待用户确认预算与授权后进行。

## 实际实现与验证

- 快照模块 `packages/tools/src/public-github-snapshot.ts` 对 GitHub URL/ref 做严格校验；branch/tag 通过 GitHub API 解析到完整 SHA，完整 SHA 则直接请求 codeload；下载和解包均有超时/尺寸/条目限制，拒绝路径穿越、链接、特殊文件及可改变归档语义的 PAX 字段。结构化错误不保留底层异常文本。
- `packages/reporting/src/public-runner.ts` 将快照交给只读仓库工具和现有 PI runtime，只开放 `list_files`、`read_file`、`search_text`、`register_evidence`；校验模型 JSON、逐条复核证据后发布报告。预算失败会停止后续调用并写入失败事件与 manifest。
- 固定样例为 `sindresorhus/slugify@7c318bd1aa4b4affab29761f15a9604323fe2a3b`，人工事实清单在 `evals/public-repository-facts.json`。在线 tag API 曾遇 GitHub 未认证限流；另用固定 SHA 成功完成真实 codeload 快照以及 faux provider 报告演示。演示读取 13 个文件，压缩归档 8,057 bytes、解包 50,688 bytes；输出 `report.json`、`report.md`、`events.jsonl`、`manifest.json` 至 `/tmp/task005-real-run/runs/033fcec6-01a2-4c10-a9da-fa9f5468270f`。未安装或执行目标仓库代码，未调用真实模型。
- 集成者复验：Node.js 24.21.0/npm 11.9.0 下 `npm run check` 通过；标准 `npm test` 为 protocol 7、runtime 14、tools 13、reporting 11、spike 5，共 50/50 通过。普通受限 sandbox 下该脚本因 tsx IPC socket `EPERM` 无法启动；获准的本地测试运行及直接 Node 方式运行全部测试文件均通过。
- 快照 fixture 测试涵盖 branch/tag/SHA、HTTP 错误、限流、挂起超时、重定向、脱敏、恶意 tar 条目和资源上限；runner faux E2E 覆盖报告与 call_limit 不再触发第二次 provider 调用。
- `packages/reporting/package.json` 明确声明现有 `@pi-workbench/agent-runtime@0.1.0` workspace dependency 和 `typebox@1.3.27` production dependency。依照集成者安排，根 `package-lock.json` 已由集成者单独更新，仅增加这两条依赖边。用户随后在任务 worktree 完成干净 `npm ci`，安装成功。
- SHA 缓存命中现在会与本次刚验证的归档逐路径、逐字节比对，并检查缓存中无额外路径、符号链接、特殊文件或超限内容；回归覆盖合法命中及篡改文件、额外文件、链接后拒绝。
- 缓存缺陷修复后的复验：`PATH=/tmp/pi-node24/bin:/home/lzs/.npm-global/bin:$PATH npm run test --workspace @pi-workbench/tools` → 13/13 通过；`PATH=/tmp/pi-node24/bin:/home/lzs/.npm-global/bin:$PATH npm run check` → 所有 workspace TypeScript 检查通过。普通 sandbox 下 `tsx` IPC socket 收到 `EPERM`，在获批的本地测试运行中重跑后通过。
- 用户本机干净安装复验（2026-09-27）：Node.js 24.21.0/npm 11.9.0；`npm ci --ignore-scripts --no-audit --no-fund` 成功（242 packages；仅出现 node-domexception 弃用警告）；随后 `npm run check` 通过、`npm test` 50/50 通过。
- 未验证：成功完成的真实模型运行、人工在线评分、服务端实际账单；GitHub 可变 ref 的实时 API 成功路径受限流，当前由受控 fixture 验证。PI SDK 0.86.1 已内置 `deepseek` provider 和 `deepseek-flash` 模型定义；离线测试继续使用 faux provider。

### 在线评测入口续作结果

- 新增 `packages/reporting/src/public-online-eval-cli.ts` 和 `public-online-evaluation.ts`，并在 reporting workspace 增加 `eval:public` 命令。真实调用须显式传 `--online` 和 `--max-cost-cny`（最高 ¥1.33），仅使用 PI SDK 的 `deepseek` / `deepseek-flash`，固定到公开仓库 SHA `7c318bd1aa4b4affab29761f15a9604323fe2a3b`；模型输出、事件和报告保存在系统临时目录，不写入仓库。
- DeepSeek 中文官方峰时单价快照为每百万 tokens：输入（缓存未命中）¥2、输出 ¥8、缓存命中 ¥0.04；闲时为峰时一半。入口按峰时价格保守估算人民币费用。底层 protocol 的 `estimatedCostUsd`/`maxCostUsd` 字段保持美元语义，CLI 按官方同时公布的 USD/CNY 价格比例将人民币上限换算后传入 runtime，不修改公共协议或锁文件。历史运行的 `$0.20` 上限对应当前人民币命令上限约 `¥1.33`。
- CLI 不读取个人 PI 配置；只从本机环境读取 `DEEPSEEK_API_KEY`，注入内存凭据存储。输出目录设置为仅当前用户访问。费用和 Token 阈值是基于 provider 返回 usage 的应用侧停止阈值，不是 provider 侧硬限额；单个在途请求可能造成明显超限。
- `eval:public` 通过 Node.js 24 的 `--env-file-if-exists=../../.env` 加载项目根目录本机配置；根目录 `.env.example` 只含空值占位符。`.gitignore` 已忽略 `.env`，所以团队成员可以各自复制模板和填入自己的密钥，GitHub 仓库只公开模板。
- 自动评分结合机器校验与人工标注：固定事实召回、引用有效性、人工证据支持判断、断言审查覆盖及未知项正确弃答；不调用第二个模型充当裁判。成功阈值为事实召回至少 80%、引用和证据支持均 100%、无不支持断言且所有结论经人工复核。
- 验证（人民币调整后）：`PATH=/tmp/pi-node24/bin:/home/lzs/.npm-global/bin:$PATH npm run check` → 所有 workspace TypeScript 检查通过；`packages/reporting/tests/public-online-evaluation.test.ts` 的 6 项测试通过，覆盖人民币价格、人民币费用换算及上限解析；`npm run eval:public --workspace @pi-workbench/reporting -- --help` → 显示人民币参数和阈值；`git diff --check` → 通过。该次验证没有运行在线模型。
- 前两次在线尝试由用户在本机手动发起。DeepSeek 返回了 usage，但运行均以 `token_limit` 取消，未生成 `report.json`/`annotations.json`，没有可评分结果。第二次报告 5 次模型调用、11 次工具调用、44,447 tokens（输入 19,240、输出 887、缓存读取 24,320），峰时价估算 `¥0.0465488`；实际服务账单未核对。由于 token 阈值是在响应后检查，usage 可超出配置值。
- 针对前两次用量，曾将本地默认在线评测预算调整为 12 次模型调用、24 次工具调用、100,000 tokens、每次最多输出 2,000 tokens、180 秒；但第三次运行仍以 100,247 tokens 因 `token_limit` 取消，说明输入 usage 事后计量会造成软阈值越界。现在将累计 Token 阈值提高到 200,000，为后续模型和工具步骤预留空间；这仍不构成 provider 侧硬限额。在线质量、成功产物、人工评分和服务端实际账单仍未验证；TASK-005 保持 `review`。
- 第三次运行由 Codex 根据用户明确请求发起，目录 `/tmp/pi-agent-workbench/public-evaluation/runs/86995250-03ab-469d-aae9-5bce2d7c4a13`。白名单运行记录包含 9 次模型调用、15 次工具调用、输入 20,263、输出 1,264、缓存读取 78,720、总计 100,247 tokens；DeepSeek 官方峰时价估算为 `¥0.0537868`。只生成 `evaluation-run.json`、`events.jsonl`、`manifest.json`，没有 `report.json` 或 `annotations.json`，不能评分。CLI 输出了通用错误而未显示结构化摘要；安全记录无法确认具体异常点。没有进行自动重试。
- CLI 摘要修复：将不含提示词、模型文本和凭据的结构化摘要放到 `runPublicRepositoryAnalysis` 返回之后立即输出，并等待 stdout 写入完成，再进行可选运行记录写入；摘要包含状态、模型/工具调用数、tokens、CNY 估算、取消原因和运行目录。加入取消状态摘要格式的离线测试。此举确保后续可选产物写入失败不会先于摘要遮蔽已返回的运行结果；先前错误的具体触发点仍未确认。
- 当前累计 Token 预算调整为 200,000（此前曾设为 100,000），模型调用 12、工具调用 24、每次输出 2,000、超时 180 秒不变；依据最近 100,247-token 的运行留出约一倍空间。Token/cost 仍在响应后按 usage 检查，可能越界。没有授权或发起第四次运行。
- 本轮离线验收：`PATH=/tmp/pi-node24/bin:/home/lzs/.npm-global/bin:$PATH npm run check` 通过；`node --import tsx --test --test-reporter=spec packages/reporting/tests/public-online-evaluation.test.ts` 通过；`npm run eval:public --workspace @pi-workbench/reporting -- --help` 显示 200,000-token 预算及软阈值说明；`git diff --check` 通过。没有运行真实模型。
- 用户本机在线尝试记录（2026-09-27）：命令 `npm run eval:public --workspace @pi-workbench/reporting -- --online --max-cost-usd 0.20` 返回 `cancelled/token_limit`，8 model calls、16 tool calls、50,009 total tokens。旧 USD 价格快照估算 `$0.007575228`；按当前 DeepSeek 官方峰时人民币价估算约 `¥0.05050152`。产物目录只有 `evaluation-run.json`、`events.jsonl`、`manifest.json`；没有 `report.json` 或 `annotations.json`，故不可评分。确认这是模型调用已发生但质量评测未完成；下一次付费重试尚未授权。
- 用户本机第二次在线尝试记录（2026-09-27）：命令 `npm run eval:public --workspace @pi-workbench/reporting -- --online --max-cost-cny 1.33` 返回 `cancelled/token_limit`，5 model calls、11 tool calls、44,447 total tokens（输入 19,240、输出 887、缓存读取 24,320）。按 DeepSeek 中文官方峰时人民币价估算 `¥0.0465488`。产物目录 `/tmp/pi-agent-workbench/public-evaluation/runs/3d20ee6f-1390-4ec7-85e9-8701804b31b2` 中只有 `evaluation-run.json`、`events.jsonl`、`manifest.json`；没有 `report.json` 或 `annotations.json`，故不可评分。下一次付费重试尚未授权。
- 在线评测续作集成（2026-09-27）：PR [#11](https://github.com/Ranzxxx/pi-agent-workbench/pull/11) 已 squash 合并，提交 `30c592418a4754ab3acb71d01e4eafbd1b2e8ad8`。GitHub Actions [Offline checks #30](https://github.com/Ranzxxx/pi-agent-workbench/actions/runs/36304021785) 全部通过：Node/npm 工具链、干净 `npm ci`、`npm run check`、`npm test`、`npm run spike` 和独立 spike 安装验证。PR 无 review 评论。合并后本地 `main` 快进同步到该提交，工作树原先干净。TASK-005 仍为 `review`：在线评测入口已集成，但目前三次真实模型运行都因 `token_limit` 取消，没有成功报告或人工评分；下一次付费运行仍需用户另行授权。

### 在线测评提示词收敛续作结果

- 在线评测提示词版本升级为 `public-repository-analysis-v2`。通用 Agent 接受可选问题列表；在线评测只将五项基准问题的 ID 和问题文本传给模型，评分答案及预期证据只保留在本地评测器。模型被要求只回答这些问题、每题输出一个同 ID 的 claim、登记必要的精确行号证据并在完成后停止。
- 评分器接受 v1 和 v2 两种已完成运行记录，避免提示版本升级导致旧运行记录无法评分。离线回归测试验证问题清单传递不泄漏 `expectedAnswer`/`expectedEvidence`，并验证旧 v1 运行仍可评分。
- 验证环境：Node.js 24.21.0、npm 11.9.0。根目录 `npm run check` 通过；在 `packages/reporting` 目录运行 `node --import tsx tests/public-online-evaluation.test.ts`，10/10 通过；`node --import tsx --test --test-reporter=spec tests/*.test.ts`，6/6 测试文件通过；`git diff --check` 通过。
- `npm test --workspace @pi-workbench/reporting` 在受限 sandbox 中因 tsx IPC socket `listen EPERM` 未能启动；用 Node.js 内置测试运行器直接加载 tsx 后，全套 reporting 测试通过。没有发起真实 DeepSeek 调用。
- 本阶段实现已通过 PR #12 合并；后续验收记录在本卡下一节补充。

### 提示词 v2 在线验收结果

- 代码集成：PR [#12 feat(TASK-005): focus online evaluation prompt](https://github.com/Ranzxxx/pi-agent-workbench/pull/12) squash 合并，合并提交 `48bab4c5edfe0fcd0af6e7cff40bafbc3e37d3ab`。GitHub Actions [Offline checks #33](https://github.com/Ranzxxx/pi-agent-workbench/actions/runs/36305446234) 全部通过；无 review 评论或未解决线程。本地 `main` 已快进同步到相同提交。
- 在线运行：固定仓库 `sindresorhus/slugify@7c318bd1aa4b4affab29761f15a9604323fe2a3b`；PI provider `deepseek`、模型 `deepseek-flash`；提示版本 `public-repository-analysis-v2`。运行 ID `404428b3-c236-49f2-83de-bb177eab0441`，3 次模型调用、7 次工具调用、7,353 tokens（输入 2,505、输出 1,136、缓存读取 3,712），保守峰时价估算 `¥0.01424648`。目录：`/tmp/pi-agent-workbench/public-evaluation/runs/404428b3-c236-49f2-83de-bb177eab0441`；报告为 `report.md`。未调整 200,000 的累计 Token 阈值。
- 人工复核：负责人同意四条有充分证据的事实按“支持”标注，并将 `test-status` 标为“正确弃答”。生成的评分文件记录人工复核方法。评分结果 `qualityGate: passed`；事实召回 0.80、引用有效性 1.00、证据支持 1.00、不支持断言 0，断言和未知项均已复核。
- 本次授权范围内的在线质量评测和人工评分验收项已满足。该样本很小，评分证明的是此固定样本达到项目门槛，不证明模型对任意 GitHub 仓库均可靠。DeepSeek 服务端账单未查验；运行文件留在 `/tmp`，没有提交到仓库。

## 交接

- 完成内容：公开仓库固定 SHA 获取、受限 tar 解包、只读工具及 faux provider 报告闭环；DeepSeek Flash 在线评测入口、提示词 v2、预算/CLI 摘要改进、固定样本真实在线评测和人工评分均完成，任务验收通过。
- 修改文件：`README.md`、`doc/decisions/002-repository-snapshots.md`、本任务卡、任务索引、`evals/public-repository-facts.json`、`packages/tools/{src/index.ts,src/public-github-snapshot.ts,tests/public-github-snapshot.test.ts}`、`packages/reporting/{package.json,src/index.ts,src/public-runner.ts,tests/public-runner.test.ts}`。
- 在线评测续作修改文件：`packages/reporting/package.json`、`packages/reporting/src/public-runner.ts`、`packages/reporting/src/public-online-eval-cli.ts`、`packages/reporting/src/public-online-evaluation.ts`、`packages/reporting/tests/public-online-evaluation.test.ts`、根目录 `.env.example`、`doc/plan.md`、本任务卡及任务索引。实现已由 PR #11 集成。
- 实际验证：根锁更新后，用户本机干净 `npm ci --ignore-scripts --no-audit --no-fund` 成功；`npm run check` 通过；`npm test` 通过 50/50；集成者 `git diff --check` 通过；固定 SHA 真实 GitHub 快照→faux provider→报告产物成功。
- 风险/未验证：GitHub API 限流；DeepSeek 服务端实际账单未核对；branch/tag 的 GitHub API 实时成功路径由受控 fixture 覆盖。单一小仓库样本不构成泛化质量保证。缓存安全依赖每次请求完成新归档验证后再与现有目录比较，不提供本地缓存免下载快捷路径。
- 实现提交：`7e0dd03d35c9dc2062f7e1246a0583047dbbe697`。
- PR：[#9 feat(TASK-005): add public repository analysis](https://github.com/Ranzxxx/pi-agent-workbench/pull/9) 与 [#11 feat(TASK-005): add DeepSeek online evaluation workflow](https://github.com/Ranzxxx/pi-agent-workbench/pull/11) 均已合并至 `main`。
- 初始闭环集成提交：`175a0fa5b6864068630515275cb466105b1bcb65`，CI [Offline checks #24](https://github.com/Ranzxxx/pi-agent-workbench/actions/runs/36298816877) 通过。在线评测续作集成提交：`30c592418a4754ab3acb71d01e4eafbd1b2e8ad8`，CI [Offline checks #30](https://github.com/Ranzxxx/pi-agent-workbench/actions/runs/36304021785) 全绿。本地 `main` 已快进同步至续作集成提交。
- 最终状态：`done`；验收、人工评分、PR 集成和 CI 检查均完成。下一步可按 TASK-006 任务卡开始 API、SSE 与最小 Web；尚未启动。
