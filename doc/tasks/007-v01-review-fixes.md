# TASK-007：v0.1 Review 问题修复与回归验收

## 元数据

- 状态：`review`（实现和本地离线验证完成，尚未提交、独立审查或集成）
- 负责人：Codex（本任务独占写入者）
- 分支或 worktree：`task/007-v01-review-fixes`，工作区 `/home/lzs/Projects/pi`
- 基线提交：Review 基线 `7aebe6c9ca9751c5450340ef6d4870fc45aed64f`（当前 `main`）；功能实现基线 `a726c26 → 1f031d9`
- 开始实施时已有修改：`doc/plan.md`、`doc/tasks/README.md` 为前轮未提交修改，`doc/tasks/007-v01-review-fixes.md` 为前轮未跟踪的新任务卡；均由本任务沿用，不算作代码修复
- 依赖任务：TASK-006（已集成）；本任务基于完成后的独立 Review
- 提交/推送授权：无
- 在线模型授权：无；本任务须用 faux provider、合成仓库和离线验证，不发起真实模型调用
- 任务性质：修复已交付 v0.1 的运行正确性、界面状态和验收缺口，不增加新功能

## 背景与目标

对当前 v0.1 代码做独立 Review 后，确认以下问题有可复现证据：仓库分析在取消后仍会继续消耗模型调用；取消宽限期耗尽后，服务会在底层运行仍活动时释放全局运行名额；切换会话时旧 SSE 回调会覆盖当前会话；历史和部分运行产物无法从界面打开；UTF-8 字节边界会把有效输入/报告变成运行失败；仓库文本搜索被二进制文件中断；不存在的运行 ID 的 SSE 请求会挂起；成功分析的 `events.jsonl` 缺少终态事件。

修复这些问题，为每个确认的缺陷增加有针对性的回归验证，并保持既有协议、权限边界和 v0.1 单进程范围。代码行号来自基线提交，实施前应重新定位并确认触发路径。

## 范围与非目标

- 修复下列 9 项 Review 发现，或通过证据证明个别项不属于本任务后记录原因并由集成者决定。
- 为服务端行为增加离线回归测试；前端用现有测试/浏览器验收能力验证，不为本任务引入 Playwright 或其他新依赖。
- 更新本任务卡与任务索引的状态、命令、结果和已知缺口。
- 不实施 TASK-008 的产品功能，不新增能力、持久化、队列、Worker、多租户或工作区执行能力。
- 不减弱校验、缩短已有安全边界、不改变 DeepSeek 配置、不调用真实 GitHub/模型服务。
- 不创建提交、推送或合并，除非用户另行授权。

## 允许路径与依赖授权

- `apps/server/src/app.ts`、`apps/server/src/service.ts`、`apps/server/tests/**`
- `apps/server/src/registry.ts`（集成者本轮指定唯一写入者：Codex；仅为转发 runtime 取消状态与 pending 警告扩展内部回调）
- `apps/web/src/app/page.tsx` 及已有 Web 源码/测试路径（如需新增测试，先检查现有框架；不得添加依赖）
- `packages/reporting/src/public-runner.ts`、`packages/reporting/tests/**`
- `packages/agent-runtime/src/index.ts`、`packages/agent-runtime/src/conversation.ts`、`packages/agent-runtime/tests/**`
- `packages/tools/src/read-only-repository.ts`、`packages/tools/tests/**`
- `doc/tasks/007-v01-review-fixes.md`、`doc/tasks/README.md`
- 根 `README.md`（用户本轮明确要求同步）

本任务不预先授权修改共享公共协议、根配置、npm lockfile 或生产依赖。若修复终态日志必须调整协议，应先记录影响与兼容方案，由集成负责人决定唯一写入者。UI 如需测试工具，也须先证明现有工具无法验证并取得明确授权。

## 前置条件与工作区记录

开始时必须重新阅读根 `AGENTS.md`、本任务卡、`doc/plan.md`、`doc/tasks/README.md`，以及 `apps/web/AGENTS.md` 和受影响目录的约定；检查 `git status`、当前分支、HEAD 与允许路径。不得覆盖任务开始前已有改动。

把本卡改为 `in_progress`，填写负责人、独占分支/worktree、实际代码基线 SHA 和开始时已有修改。当前审查时工作区干净，但实施开始时仍须重新检查。

## 已确认问题与修复要求

### 1. P1：仓库分析在模型阶段收到取消信号后仍继续执行

- **位置（Review 基线）：** `packages/reporting/src/public-runner.ts:211-217`、`:272-275`；取消从 `apps/server/src/service.ts:304-312` 传入。
- **触发条件：** 快照已获取、分析 session 已运行时，用户调用取消，或上层 AbortSignal 被取消。
- **证据与影响：** `options.signal` 只传给 `fetchPublicGitHubSnapshot`，之后没有监听并调用 `session.abort()`；`session.run()` 未获得该外部 signal。离线复现于第一次模型调用时触发外部 abort，provider 仍进行 3 次模型调用，最终 `runPublicRepositoryAnalysis` 返回 `completed` 并生成报告。服务层可能把 UI 运行标成 cancelled，但后台模型调用和费用仍继续。
- **最小修复方向：** 将外部 signal 连接到分析 session 的 abort 生命周期，覆盖快照之后的模型、工具和发布阶段；在 session 结束时解除 listener，并正确处理 session 创建前/期间已经 aborted 的情况。不可仅在服务层覆盖终态来宣称执行已停止。
- **验收：** faux provider 在模型调用中等待可控闸门；取消后断言 PI runtime 收到 abort、不会发生后续模型/工具调用、不发布 completed 报告、API 与 runner 终态一致；再覆盖下载阶段取消和结束后的迟到取消。

### 2. P1：取消宽限期后仍释放全局运行名额

- **位置（Review 基线）：** `packages/agent-runtime/src/index.ts:122-126`、`:242-246`；runner `packages/reporting/src/public-runner.ts:287-290`；服务清理 `apps/server/src/service.ts:337-343`。
- **触发条件：** provider 或工具不响应 abort，运行超时/取消并超过 runtime 的取消宽限期。
- **证据与影响：** runtime 会以 `CancellationPendingError` 拒绝 `run()`，但底层 `completion` 仍未结束。runner 将该错误直接抛出，服务 `finally` 随即清除 `activeRunId`。离线复现中，第一次运行被记为 failed 时旧 provider 仍在执行，第二次运行已被接受并进入 running，突破进程全局单运行限制并可能造成并行费用和状态竞争。
- **最小修复方向：** 把 pending 当作仍在执行的 `cancelling` 状态；只有底层 completion 真正结束后才完成运行并清除全局运行锁。利用已有 `waitForResult()` 或等效等待，不伪造执行已停止。
- **验收：** 使用忽略 AbortSignal 的 faux provider，触发超时并等待取消宽限期；底层尚未退出时再次提交必须返回 busy，直到它真实结束；终态事件唯一，资源最终释放。

### 3. P2：切换会话后旧 SSE 回调覆盖当前会话

- **位置（Review 基线）：** `apps/web/src/app/page.tsx:79-89`、`:90-119`，重点为 `:87-88` 与 `:111-115`。
- **触发条件：** 会话 A 有活动 run 时，切换到没有 run 的会话 B，随后 A 的 SSE 到达 `run.finished`；其他切换竞态也需一并检查。
- **证据与影响：** 加载无运行记录的会话只清空 run 状态，没有关闭旧 EventSource；旧完成回调无条件从 API 读取 `event.conversationId` 并 `setConversation`。原回调模拟复现为：页面已显示 B，A 完成后页面变回 A，但 localStorage 仍是 B。Delta 处理也会无条件更新全局 draft/events。
- **最小修复方向：** 每次切换 conversation（包括切到空会话）立即关闭旧流；为异步加载和事件回调增加当前 conversation/run 或切换代次校验，丢弃过期更新。不能只过滤 `activeRun` 而让 delta 或 conversation 更新泄漏。
- **验收：** 覆盖 A→B（B 无运行）、A→C（C 有另一个历史 run）、旧 delta、旧 reset、旧 finished 迟到；断言 B/C 消息、运行卡、草稿和 localStorage 均不被污染。可用现有 CUA 验证真实浏览器交互。

### 4. P2：同一会话的新 run 覆盖旧报告入口

- **位置（Review 基线）：** `apps/web/src/app/page.tsx:79-89`、`:222`、`:248-253`。
- **触发条件：** 仓库分析成功后，在相同对话中再提交普通提示，或刷新后加载该对话。
- **证据与影响：** UI 仅持有一个 `activeRun`，加载会话时也只取 `runs[0]`。新 run 替换旧 run 后，旧报告下载链接消失。后端会话虽仍返回最近运行列表，但前端没有选择历史运行/报告的入口；复现渲染旧成功报告后再渲染普通 run，artifact 链接从 1 个变为 0 个。
- **最小修复方向：** 提供既有 runs 的历史选择/展示，或将 run/artifact 引用持久关联到对应消息并在加载时恢复。不得只增加一个组件 state 而丢失刷新恢复。
- **验收：** 一个会话先完成能力分析，再完成普通对话；切换离开、返回并刷新后，仍能选中旧 run 并成功读取旧报告产物。

### 5. P2：失败/取消结果中的部分产物没有 UI 入口

- **位置（Review 基线）：** `apps/web/src/app/page.tsx:250-253`。
- **触发条件：** 能力运行失败或取消，但服务已登记 `events.jsonl`、`manifest.json` 或其他部分产物。
- **证据与影响：** artifact links 位于 `result.status === "completed" && result.capabilityResult` 区块内部。原组件渲染带 artifacts 的 cancelled run 时不显示任何 artifact link，违反 TASK-006“失败或取消显示已登记部分日志/产物”的标准，用户无法检查失败过程。
- **最小修复方向：** 将通用产物入口从成功报告条件中拆出，按 run 的实际 artifacts 渲染；仍按服务端登记接口读取，不自行拼接不受控路径。
- **验收：** fake/离线地构造 failed 与 cancelled run（各含部分 artifacts），断言 UI 显示已登记产物且可读取；缺少 artifacts 时不显示坏链接。

### 6. P2：字符长度校验与 UTF-8 字节上限不一致

- **位置（Review 基线）：** `apps/server/src/service.ts:319-325`；`packages/agent-runtime/src/conversation.ts:146-150`、`:192-201`；请求 schema `packages/protocol/src/workbench.ts:18-23`。
- **触发条件：** 含中文或其他多字节字符的提示/合法能力结果，其 UTF-8 字节数大于 runtime 上限，但字符数仍通过协议及应用限制。
- **证据与影响：** 服务层用 `contextText.slice(0, 12_000)` 计字符，runtime 用 `Buffer.byteLength(...) > 12 * 1024` 计字节。离线构造满足 report schema 的多条中文结论，报告及 manifest 已成功发布，但上下文注入抛错，工作台返回 `runtime_error`，有效能力结果没有进入会话。另有 11,000 个汉字的普通提示通过 16,000 字符 schema，却超过 runtime 的 32 KiB 限制并失败。
- **最小修复方向：** 在协议/API/runtime 边界采用一致、明确的 UTF-8 字节预算并提前拒绝过大输入；能力摘要根据字段/引用数量缩减后再序列化，并以字节计数，禁止切坏结构化 JSON。
- **验收：** 中英文混合输入、恰好达到边界和超过一个 UTF-8 字节的负向用例；用合法中文能力报告验证注入成功，超限输入应在调用模型前返回清晰的 invalid_request，而非泛化 runtime_error。

### 7. P2：仓库文本搜索遇二进制/超大文件整体失败

- **位置（Review 基线）：** `packages/tools/src/read-only-repository.ts:202-218`，尤其 `:207-209`；文件限制在 `:132-156`。
- **触发条件：** 固定仓库快照包含 PNG 等非 UTF-8 文件，或大小超过单文件读取限制，Agent 使用 `search_text`。
- **证据与影响：** 搜索对 `listFiles()` 返回的每个路径一律执行严格 UTF-8 `readChecked()`，没有按文本类型筛选或略过不可搜索文件。最小离线复现含一份命中 query 的 README 和一份 PNG，整个 search 抛出 `Repository file is not valid UTF-8 text`，README 命中也丢失；超限文件也能中断搜索。
- **最小修复方向：** 将二进制/超限文件从全文搜索范围安全排除，或逐文件跳过并在有界结果中报告 skipped count；对路径逃逸、符号链接等安全错误继续 fail closed。
- **验收：** README 命中加 PNG/无效 UTF-8/单文件超限 fixture 时，返回文本命中和明确跳过信息；纯文本搜索稳定；路径与符号链接安全回归仍通过。

### 8. P2：不存在的运行 ID 的 SSE 请求挂起

- **位置（Review 基线）：** `apps/server/src/app.ts:46-68`。
- **触发条件：** 请求 `/api/v1/runs/{unknown}/events`，或运行记录已被容量淘汰。
- **证据与影响：** 路由先 `reply.hijack()`、写出 HTTP 200 SSE 头并 flush，再在 `:62` 调用可能因 run 不存在而抛错的 `service.subscribeEvents()`。限时离线注入复现 1 秒仍未结束，没有正常的 API 404 错误 envelope，并可能遗留被接管的连接。
- **最小修复方向：** hijack/发 headers 之前先查找运行并建立可清理的订阅；不存在时通过 Fastify 的版本化错误处理返回 404。若订阅建立可能失败，也必须结束已接管的 raw response 并清理监听。
- **验收：** 有效运行的 SSE 回放/重连保持通过；unknown/evicted run 在有限时间内返回版本化 404，不返回 200，也无遗留连接、计时器或 listener。

### 9. P3：成功仓库分析的 `events.jsonl` 缺少终态事件

- **位置（Review 基线）：** `packages/reporting/src/public-runner.ts:230-264`，重点 `:248`；`packages/agent-runtime/src/index.ts:213-222`。
- **触发条件：** 仓库分析成功并发布完整产物。
- **证据与影响：** 成功报告的 `events.jsonl` 在 finalize 中先写盘；runtime 只有 finalize 返回后才执行 `finish({ status: "completed" ... })` 并发出 `run.finished`。离线复现的成功日志最后一项是 `text.delta`，没有成功终态；报告 bundle 不能单独表明 Agent run 如何结束。
- **最小修复方向：** 明确成功日志的终态记录格式及其与结果/manifest 哈希的非循环关系，并在发布前确保日志和 manifest 一致。若需要修改公共协议，按“允许路径与依赖授权”先决策。
- **验收：** 成功事件日志含可解析的 completed 终态且身份、顺序与 manifest/result 一致；失败/取消日志仍含唯一终态；产物哈希重新核验。

## 允许的实现与验证边界

- 默认离线；仅使用 faux provider、临时目录、合成 fixture 和 stub SSE/UI 交互。不得读取或打印 `.env`、真实模型响应、用户本机运行日志或凭据。
- 保持公开仓库固定 SHA、路径约束、文件大小/下载限制、provider 模型/工具/Token/费用预算、工具白名单和目标仓库不执行等边界。
- 不得通过降低已有测试覆盖、放宽协议、吞掉异常或把“仍运行”伪装为“已取消”来让验收通过。
- 不添加生产依赖。除非先获授权，不改根 lock/config 或公共协议。
- 类型检查与测试应使用项目固定 Node.js 24.21.0/npm 11.9.0；若环境不可用，记录实际工具链与限制，不能写成固定工具链通过。
- 浏览器验证覆盖 session 切换、迟到事件、run 历史以及成功/失败/取消产物。若沙箱不可用，提供最小可复核的替代证据并明确留下未验证项。

## 验收标准

- [x] 9 项 Review 发现都有对应实现；第 9 项归档终态采用非循环的报告引用子集，设计限制见下文。
- [x] 分析模型阶段取消不再发起后续调用；超时/pending 仍持有全局运行锁，直到底层 provider 实际退出。
- [x] 会话切换关闭旧流并用会话 ID/切换代次过滤迟到 SSE；普通追问和刷新后可重新选择既有报告。
- [x] failed/cancelled 的已登记产物由独立组件渲染；未知 run 的 SSE 先返回版本化 404。
- [x] 多字节普通提示超过 32 KiB 在创建 run 前拒绝；有效大型中文报告缩减成不超过 12 KiB 的结构化上下文。
- [x] 搜索跳过二进制和超限单文件并报告有界诊断；符号链接仍拒绝。
- [x] 成功归档日志含一个可解析 completed 终态；失败/取消日志原有唯一终态不变；测试重算 manifest 的三个产物 SHA。
- [x] 7 个 workspace 的 TypeScript 检查、16 个测试文件和 Web 生产构建通过；`git diff --check` 通过。固定工具链命令未运行，见下文限制。
- [ ] 浏览器完整交互验收：已验证旧报告选择/刷新、A→空白 B 的迟到 finished、A→已有历史 C 的迟到 finished、普通运行快速切换后的无污染、失败运行卡、取消运行卡、390px 宽度及导航；由于 fake provider 没有可控的“带部分产物的 failed/cancelled”浏览器 fixture，部分产物入口由 React SSR 和服务端回归覆盖；迟到 `stream.reset` 仍未在真实页面稳定制造，迟到 delta 仅完成快速切换冒烟，未宣称完整通过。
- [x] 没有修改 `packages/protocol`、新增依赖、密钥或真实运行产物；改动保持原只读能力白名单和资源边界。
- [x] 实现结束进入 `review`；独立审查、提交与集成尚未发生，不标 `done`。

## 验证命令与证据

计划验证（实施开始后应先确认项目脚本和工具链）：

```bash
npm run check
npm test
npm run build
git diff --check
```

本轮实际环境只有已安装的 Node.js **24.19.0** 可用；`node`/`npm` 的默认路径调用落到受限 snap，不能据此声称固定 Node.js 24.21.0/npm 11.9.0 验证。使用该 Node 的绝对路径执行：

- `node node_modules/typescript/bin/tsc --project <workspace>/tsconfig.json --noEmit --incremental false`：`packages/protocol`、`packages/agent-runtime`、`packages/tools`、`packages/reporting`、`apps/server`、`apps/web`、`spikes/pi-sdk` 7/7 通过。
- `node --import tsx --test apps/server/tests/*.test.ts apps/web/tests/*.test.tsx packages/agent-runtime/tests/*.test.ts packages/protocol/tests/*.test.ts packages/reporting/tests/*.test.ts packages/tools/tests/*.test.ts spikes/pi-sdk/tests/*.test.ts`：16 个测试文件通过，0 失败；Node 的汇总数字是文件数，不冒充用例数。
- `API_PORT=3227 node ../../node_modules/next/dist/bin/next build`（`apps/web`，在允许子进程输出的本地执行环境中）：生产编译、TypeScript、静态生成通过。首次在受限沙箱内执行时 Next 的 `tsc --showConfig` 子进程没有返回 stdout，构建停在解析配置；隔离环境重跑通过。
- `git diff --check`：通过。新增的 `apps/web/tests/run-artifacts.test.tsx` 用现有 `node:test`、React SSR 和 `tsx`，未加依赖；该测试不在 `apps/web/tsconfig.json` 的 include 中，已直接执行并以独立的严格 `tsc --noEmit` 命令检查。
- 另启 3226/3227 端口的 fake 模式生产 Web/API（默认 2026/2027 的现有 online 服务未触碰），浏览器验证：能力成功后普通追问、旧报告重选、刷新后旧报告仍可重选；A 慢运行切换到空白 B 后取消 A，B 未被旧 finished 覆盖；A 慢运行切换到有历史运行的 C 后取消 A，C 的消息、运行卡和历史结果保持不变；普通运行快速切换到 C 未产生旧回复/草稿污染；fake 失败和取消运行分别显示失败/取消状态与对应操作入口；390px 宽度没有横向溢出且导航可展开。隔离服务和验收标签页已关闭。

根 `npm run check`/`npm test` 无法在缺少固定工具链的环境中如实运行；本轮没有触发真实模型或 GitHub 网络调用。未做真实 socket 断线、在线模型质量、浏览器 failed/cancelled 产物和 A→C/迟到 delta/reset 的端到端验收。

## 决策、冲突与范围变化

- Review 发现按 P1、P2、P3 的优先级排列。修复过程中若发现多个问题有共同根因，可共用实现与回归用例，但仍逐条说明覆盖证据。
- P1 修复需要将 runtime 的 `run.cancelling`/`run.warning` 转给服务端，内部注册表回调是必须经过的路径。集成者将 `apps/server/src/registry.ts` 加入允许路径并由本轮 Codex 独占写入；不修改公共协议。
- Web 部分产物 UI 从页面拆到 `apps/web/src/app/run-artifacts.tsx`，便于用现有 React SSR 测试 failed/cancelled 的已登记链接与空产物情形；没有引入 UI 测试依赖。
- 成功归档 `events.jsonl` 中新增一个 schema 合法的 `run.finished(completed)` 记录，`usage`、runId、attemptId 与运行结果一致，时间与 manifest 的归档时间一致。该归档记录只引用已经写出的 `report.json`/`report.md`；随后日志和 manifest 的 SHA 才能稳定计算。PI runtime 对外发出的完整 `run.finished` 仍含四项产物，发生在 finalize 返回后，时间可能晚于归档记录数毫秒。不能要求单个文件既包含自己的哈希又与该哈希一致；此非循环布局未改共享协议，并由测试核对报告引用、日志唯一终态和 manifest 内 SHA。
- 修复需要修改共享协议、依赖或超出允许路径时，先停止该项扩展、记录证据和候选方案，由集成负责人决定；其他无冲突工作可继续。
- 此任务卡不代表 TASK-008 新功能已选定；后续路线应在 TASK-007 验收后另行规划。

## 交接

- 当前状态：`review`，实现和本地离线检查完成，尚未独立审查/提交/集成。
- 完成内容：9 项修复及 README 同步；成功归档终态的非循环哈希布局已记录。
- 修改路径：`README.md`、`apps/server/src/{app,registry,service}.ts`、`apps/server/tests/workbench.test.ts`、`apps/web/src/app/{page,globals,run-artifacts}`、`apps/web/tests/run-artifacts.test.tsx`、`packages/agent-runtime/src/index.ts`、`packages/reporting/src/public-runner.ts` 及其测试、`packages/tools/src/read-only-repository.ts` 及其测试、本任务卡和索引。`doc/plan.md` 为任务开始前已有改动，本轮没有把它当作本次代码修复。
- 实际验证：见“验证命令与证据”；7/7 类型检查、16/16 测试文件、Web build 和部分浏览器场景通过。
- 风险与未验证：固定 Node24.21/npm11.9 复核、浏览器 failed/cancelled 与全部迟到事件变体、真实 socket 断线、在线模型未验证；归档终态为报告引用子集而非完整四产物结果。
- 提交 SHA / PR：无；没有提交、推送或合并。
- 已停止写入：是；待独立审查与固定工具链复核。
- 下一位 Agent 第一个动作：在本分支复核 `git status` 和任务起点已有的文档差异，独立检查 9 项修复及归档终态语义，尽可能用固定工具链重跑，并逐项处理审查问题。
