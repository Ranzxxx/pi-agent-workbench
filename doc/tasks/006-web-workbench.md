# TASK-006：API、SSE 与通用 Agent 工作台基础界面

## 元数据

- 状态：`done`
- 负责人：主 Agent（补充修复、独立测试与验收）；此前实现由实现子代理完成
- 分支或 worktree：集成/验收 `task/006-web-workbench`（当前 checkout）；实现 `task/006-web-workbench-impl`（`/tmp/pi-task006-implementation`）
- 计划校准基线：`a726c26c6fdab2c167aa39d048d7886bb117bd30`
- 实施基线提交：`a726c26c6fdab2c167aa39d048d7886bb117bd30`
- 依赖任务：TASK-005 的可运行分析流水线
- 提交/推送授权：用户于 2026-09-28 明确授权创建本地提交、推送分支，并通过 GitHub 插件创建和合并 PR。
- 在线模型授权：用户于 2026-09-28 授权一次 DeepSeek Flash 普通对话冒烟验证，应用侧单次成本上限 USD 0.20；已完成
- 状态说明：原实现与主 Agent 独立审查、测试和 fake 浏览器验收已完成；2026-09-28 在线仓库分析复现出 GitHub API 匿名速率限制耗尽，故复开补齐可选服务端 GitHub Token 透传和安全错误提示。复开基线为当前 checkout 的 `a726c26`；新增允许路径仅限 `apps/server/**`、`packages/reporting/src/public-runner.ts`、`packages/tools/src/public-github-snapshot.ts` 及对应测试、`.env.example` 和 README 的在线配置说明。复开前已有修改：`AGENTS.md`、`README.md`、`doc/plan.md`、本任务卡、`doc/tasks/README.md`；未覆盖这些改动，并在用户明确授权下随 TASK-006 一并提交，以保持产品说明、任务计划和实现状态一致。私有参考笔记仍留在被忽略的 `doc/internal/`，未提交。实现期间确认了普通提示词、显式 `@` 能力、进程内上下文、对话/运行 ID、全局单运行、进程内对话列表及失败/取消规则。

## 目标与非目标

在本地 Linux 单用户环境建立可扩展的 Agent 工作台基础：主界面提供通用对话输入，普通自然语言提示无需先选择能力，直接进入 PI Agent 对话；默认 Agent 不开放工具。用户可在“能力”栏目浏览已注册能力，也可在输入框键入 `@` 搜索并显式调用能力；选中后再按其输入 schema 呈现所需参数。能力调用携带稳定 ID 和结构化输入，由服务端能力注册表校验并分发到固定处理流程；普通提示词不会被模型自动推断为能力调用。TASK-005 的公开 GitHub 仓库分析作为本任务唯一接入的首个能力，显示名为“仓库分析”；通用界面/API 不把仓库 URL、GitHub 分析步骤或报告字段写死。

API 与 Agent 执行器同进程；请求契约必须同时表达普通对话消息和显式能力调用，不要求每条消息都带任务类型。一个 `conversationId` 对应一个进程内 PI 会话；每次用户提交创建一个关联此对话的 `runId`。网络层重复提交使用幂等键返回同一运行；用户主动重试创建新的 `runId`，并记录 `retryOfRunId`。服务进程全局最多执行一个运行，其他对话提交时明确返回忙碌。对话列表和消息仅保存在内存中，刷新可通过 `conversationId` 找回当前进程内的对话，服务重启后不恢复。普通对话使用 PI Agent 的会话上下文；显式调用能力时只开放该能力注册的输入和工具。当前只注册仓库分析能力，未知能力必须拒绝。默认不开放 Shell、写文件或任意网络工具，不做独立 Worker、数据库恢复、登录、公网部署、动态插件市场或多人协作。

## 允许路径与依赖授权

- `apps/server/**`、`apps/web/**`。
- `packages/protocol/**`（只由本卡指定的唯一所有者维护 REST/SSE schema）。
- `packages/agent-runtime/**`：仅增加受控的通用多轮 PI 会话适配器；固定空工具集，不开放 tools 参数或绕过现有 wrapper；保留现有单次仓库分析 `createSession` API 及其预算、取消、provider 和资源加载安全边界。
- `packages/reporting/src/public-runner.ts`：仅将服务端传入的可选 GitHub Token 转交给快照解析配置，不调整分析流程或在线预算。
- `packages/tools/src/public-github-snapshot.ts` 及 `packages/tools/tests/public-github-snapshot.test.ts`：仅增加可选 GitHub Token 对 `api.github.com` 元数据/ref 请求的服务端认证；不得把 Token 发送到 `codeload.github.com`，不得将其写入日志、事件、报告或错误。
- 根 package.json、锁文件、tsconfig、`.env.example`、`.gitignore`、CI 工作流。
- README、必要 API 文档、本任务卡和索引。

本次由实现子代理在独立 worktree 独占写入上述代码、协议和根配置路径；主 Agent 在当前 checkout 负责监督、只读审查和验收测试，不并行编辑这些共享路径。主 Agent 已审核并批准以下精确依赖版本：Fastify `5.12.5`（REST/SSE 服务）、Next.js `16.3.6`（工作台 Web 框架）、React 与 React DOM `19.3.0`（交互界面）、`@types/react` 与 `@types/react-dom` `19.3.0`（严格 TypeScript/TSX 类型）。不增加 Playwright；桌面和窄屏浏览器验收使用主 Agent 的 CUA。

浏览器测试优先复用可用工具；不得借机加入队列、数据库或通用 UI 平台依赖。

## 验收标准

- [x] 一个开发命令启动 API 和 Web，默认绑定回环地址，API Key 只保留在服务端。
- [x] API 使用版本化类型化契约，支持普通对话消息和显式能力调用，并支持查询/取消/重试运行及访问登记产物。首个注册能力为公开仓库分析；不支持的能力明确拒绝；忙碌时明确返回，默认最多一个运行。
- [x] `conversationId` 标识进程内对话/PI 会话，`runId` 标识一次用户提交并关联对话。网络重复提交携带幂等键时返回原运行；显式重试创建新 `runId` 并记录 `retryOfRunId`。
- [x] 服务进程全局最多执行一个运行；正在执行时从同一或其他对话提交都返回明确忙碌状态，不启动并行运行。
- [x] 普通自然语言提示可不带能力 ID 直接发给 Agent；同一对话中的多轮消息共享会话上下文，进程重启后不承诺恢复。
- [x] 可创建、列出和读取当前进程内的对话；侧栏可切换已有对话，新建对话使用独立 PI 上下文。浏览器刷新后可通过 `conversationId` 恢复；服务重启后对话和上下文丢失。
- [x] 用户可通过 `@` 显式附加已注册能力；只有该调用获得能力专属输入和工具。没有 `@` 时使用默认空工具集，未知能力不可调用。
- [x] 能力调用请求包含稳定能力 ID 和 schema 校验后的结构化输入；服务端通过注册表分发到唯一已注册处理流程，不根据普通提示词自动推断并启用能力。
- [x] 每轮成功运行都返回 Agent 回复文本；产物引用可选。普通对话只返回文本，能力运行可同时返回简短回复和报告等产物。
- [x] 能力成功后，将简短摘要及有大小/字段限制的结构化结果加入同一对话的后续 Agent 上下文，并保留产物引用；后续普通提示可围绕该结果追问。不要注入完整大型产物、原始执行日志或凭据。
- [x] 失败或取消的能力运行显示终态和已登记的部分日志/产物（若有），但不把部分结果注入为成功能力结果；只有成功能力结果进入后续对话上下文。
- [x] SSE run event 发送版本化事件，每个 run event 有唯一 `eventId`，`sequence` 在同一运行内单调递增；进程存活期间可按最后真实 run event 游标补发，缓冲丢失明确返回重置指示。
- [x] `stream.reset` 是独立版本化传输控制帧：payload 带独立 `eventId` 用于诊断，但不占用 run sequence，也不设置 SSE `id:` 字段；客户端从控制帧的 `latestEventId` 读取最新真实 run event 游标并以该游标重连，不能把控制帧 ID 当作业务事件游标。
- [x] 浏览器刷新/断开不会取消 Agent，主动取消才发送取消请求；幂等取消和终态竞争有测试。真实网络故障期间的 socket 重连未端到端模拟。
- [x] 重试使用新 runId，关联旧任务，事件不能串线。
- [x] 主界面提供通用 composer、运行记录入口、状态/事件视图和通用产物区域；不常驻展示 GitHub 仓库专属表单，也不解析终端日志判断状态。
- [x] 独立“能力”栏目展示已注册能力及说明。用户在 composer 输入 `@` 时可搜索并选择能力；本任务接入的首个选项为 `@仓库分析`。选择后按已注册字段元数据显示结构化输入项。
- [x] `@仓库分析` 能启动 TASK-005 的只读仓库分析，并在通用产物区域查看报告和逐条证据；能力输入由自身 schema 校验，未知能力不能提交。
- [x] 页面组件按通用对话/运行/产物契约与具体能力输入字段解耦；不将 `@` 调用呈现为可任意执行未经注册的插件或工具。
- [x] 报告渲染禁止任意 HTML/危险链接；产物接口限制在任务目录，防止路径逃逸。
- [x] fake 模式下浏览器验证正常、失败、取消、重连和产物查看，无真实模型费用。已验证普通提示、失败终态、能力闭环、取消、活动运行刷新后重连、产物查看和无效仓库拦截；真实网络故障期间的自动 socket 重连仍未端到端模拟。
- [x] 明确说明内存状态在进程重启后不可恢复；不暗示已实现 v0.2。
- [x] 根 README 启动路径与实际一致，留下演示步骤和限制。

## 验证计划（实施后提供）

根 check/test/build；普通对话与多轮上下文测试；conversationId/runId 关联、网络幂等提交、显式重试关联、全局忙碌状态及失败/取消上下文测试；能力调用 envelope 的合法/非法类型及默认空工具集测试；SSE 顺序/重连/取消集成测试；浏览器 fake 模式下新建/切换/刷新恢复对话与 TASK-005 能力闭环。真实模型演示不在本任务验收范围，不能因 UI 接通而自动增加额度。

## 实施交接

- 完成内容：实现通用多轮 PI Agent adapter、版本化 REST/SSE 协议与服务、内存对话/运行/重试/取消/幂等协调、固定能力注册表与仓库分析衔接、同源 Next.js 深色工作台、fake 模式及启动文档。默认提示使用固定空工具集。能力表单现在按注册元数据渲染字段、控件类型和长度限制，不在主页面写死仓库分析字段。`stream.reset` 为独立传输控制帧，带诊断 `eventId` 但不设置 SSE `id:`、不占 run sequence；客户端关闭旧 EventSource 并按控制帧 `latestEventId` 对活动运行续接。
- 修改文件：`apps/server/**`、`apps/web/**`、根 `package.json`/`package-lock.json`/`.env.example`/`.gitignore`/`README.md`、`packages/agent-runtime/src/index.ts`、`packages/agent-runtime/src/conversation.ts`、`packages/agent-runtime/tests/conversation.test.ts`、`packages/protocol/src/index.ts`、`packages/protocol/src/workbench.ts`、`packages/protocol/tests/protocol.test.ts`、本任务卡和任务索引。任务开始时已存在的 `AGENTS.md`、`doc/plan.md` 与任务卡/索引改动均保留。
- 实际验证：实现环境 Node.js `v24.19.0`、npm `11.9.0`；项目根固定要求 Node.js `24.21.0`、npm `11.9.0`。实现阶段类型检查覆盖 agent-runtime、tools、reporting、protocol、server、web 全部通过；直接运行 workspace 测试文件共 71 项通过。主 Agent 在最终代码上使用项目固定工具链运行 `npm run check`、`npm test`（70 项通过）和 `npm run build`，全部通过；构建输出确认 Next.js `16.3.6` 生产构建完成。`git diff --check` 通过。新增协议测试覆盖能力输入控件元数据和长度上限；SSE 测试覆盖 run event ID 唯一、相邻 run sequence 严格递增、reset 控制帧无 SSE `id:`，以及使用 `latestEventId` 恢复而不重复终态事件。
- 主审查后的补充修复与验证：`cancel()` 在状态已为 `cancelling` 或已经终态时直接返回当前运行，不重复写入 `run.cancelling`、不覆盖 `run.finished` 结果。回归测试使用延迟会话配置稳定制造 cancelling 窗口，检查连续取消仅产生一个 `run.cancelling` 和一个 `run.finished`，并验证取消完成后再次取消保持 `cancelled`；普通运行完成后再取消保持 `completed`。同时把 SSE 序号断言收紧为逐事件严格递增。SSE 断连清理现监听响应 raw 的 `close`/`error`，请求侧只监听 `aborted`；清理仅退订事件和心跳，不取消 Agent。既有终态 SSE 集成用例检查回放与终态响应正常关闭；未新增真实 socket 断连模拟。补充命令 `npm run check --workspace @pi-workbench/server`、`node --import tsx apps/server/tests/workbench.test.ts`（4/4 通过）、`git diff --check` 均通过。该补充后未重跑其他 workspace 测试；完整 71 项测试通过记录对应此前 sweep。
- 主 Agent 在当前项目的独立验收：安装锁文件依赖后，使用 Node.js `24.21.0` / npm `11.9.0` 运行 `npm run check`、`npm test`、`npm run build`，均通过；`git diff --check` 通过。集成验收时发现默认 Web 端口 `2026` 已由另一个本地服务占用，未停止或改动该服务；服务入口增加可选 `WEB_PORT`，默认仍为 `2026`，本地预览使用 `WORKBENCH_MODE=fake API_PORT=2027 WEB_PORT=3026 npm run dev` 成功启动，单一命令同时提供 API 和 Web。Web 取消响应修复合入当前工作区后，使用隔离的 Node.js `24.19.0` 直接执行 TypeScript Web 项目检查通过；CUA 浏览器再次验证取消终态。
- 主 Agent 浏览器验收（fake 模式、无真实模型调用）：桌面 1440×900 检查深色工作台布局；390×844 窄屏无横向溢出（文档宽度 375px），导航抽屉可打开。普通提示、多轮对话和显式 `@仓库分析` 运行均返回模拟回复/带 README 行号的证据报告；新建/切换对话及页面刷新可找回当前服务进程内的对话与报告；刷新时有活动运行后可重新连回运行，再点击取消后 UI 到达“已取消”终态并显示取消说明。输入 fake 故障哨兵后浏览器显示失败终态和安全错误摘要。元数据驱动表单显示注册表提供的三个字段及其控件；输入 `pi` 显示 URL 格式提示、输入 `https://github.com/octocat/Hello-World` 显示 fake 模式边界，输入 `https://github.com/demo/harborlight` 成功返回固定 SHA、README 行号和报告产物。窄屏 `390×844` 实测文档/页面宽度为 `375px`，composer 可见，移动导航按钮可见。
- fake 仓库分析的用户演示复核：用户用非演示仓库地址发现仍返回 Harborlight 的固定合成结果。修复为 fake 模式仅接受 `https://github.com/demo/harborlight` 的默认分支 `main` 或固定演示 SHA；其他仓库/ref 在创建运行前返回明确 400，不再输出伪装成真实仓库的报告。`createFakeSnapshotFetch` 也只对该合成仓库和固定归档 SHA 返回 fixture；表单提示当前模式的限制。用户随后用 `pi` 测试时，请求因协议要求完整 GitHub URL 而被早期拒绝；前端已补格式/长度校验，显示中文格式提示，并在 fake 模式本地拦截不支持的仓库/ref。服务端回归测试验证了有效演示仓库成功、其他仓库及不支持 ref 被拒绝。
- 最近补充验证：fake 分析边界和元数据表单改动后，新增 `CapabilityInfoSchema` 输入描述校验。项目固定工具链下 `npm run check` 通过；`npm test` 通过（70/70）；`npm run build` 的 Next.js 生产构建通过；`git diff --check` 通过。fake 仓库分析服务测试为 4/4。浏览器运行验证复用了当前项目自身监听默认端口 `2026`/`2027` 的服务；临时启动 `WEB_PORT=3026` 的第二实例时发现端口/API 已被占用，没有终止或修改现有服务。
- 在线仓库分析故障与补充修复（2026-09-28）：用户在线运行 `bf317553-e076-49cd-b111-82208a9ebc6b` 失败。服务 `/health` 为 `online`，其事件仅有 `run.started`、`capability.started`、`run.finished`，没有工具步骤；对该次已提交的公开仓库进行只读 GitHub API 检查得到 HTTP 403 且 `X-RateLimit-Remaining: 0`。`.env` 中没有配置 `GITHUB_TOKEN`，原快照客户端也没有 Token 透传。修复后，服务端从环境读取可选 `GITHUB_TOKEN`，仅在 `api.github.com` 元数据/ref请求设置 Bearer Authorization；源码归档 `codeload.github.com` 不带 Token，Web 子进程也剔除 `GITHUB_TOKEN`。服务将受控 `SnapshotError` 的安全码和消息返回 UI，例如限流原因，不暴露原始响应/凭据。README 与 `.env.example` 已说明配置方式。
- 故障修复验证：Node.js `24.19.0`、npm `11.9.0` 下，`npm run check --workspace @pi-workbench/tools`、`npm run check --workspace @pi-workbench/reporting`、`npm run check --workspace @pi-workbench/server` 均通过；`npm run test --workspace @pi-workbench/tools` 14/14 通过，`npm run test --workspace @pi-workbench/server` 5/5 通过；测试覆盖 Bearer Token 只到 GitHub API、归档请求无 Token、限流错误安全回显。`git diff --check` 通过。用户运行中的服务 health 仍为 online；未发起新的模型调用。
- 用户本机在线能力复测（2026-09-28）：用户反馈 `@仓库分析` 在线测试通过，并确认成功报告中的引用正确。此前截图中的运行 `b8638ccb…` 已取消，故该反馈记录为后续运行结果。成功运行的完整 run ID、仓库/ref/SHA 和实际费用未提供；Agent 无法从用户本机服务读取详情，因此记录为用户验证通过，不声称独立复现或确认 Token 已加载。
- 主 Agent 完整差异复审（2026-09-28）：发现 Fastify 内置请求解析错误携带框架错误码，可能不符合版本化 API 错误契约；现将未识别的 4xx 归一为 `invalid_request`、5xx 归一为 `internal_error`，并增加畸形 JSON 回归用例。隔离 Node.js `24.19.0`、npm `11.9.0` 下 `npm run check --workspace @pi-workbench/server` 通过；直接运行 `node --import tsx apps/server/tests/workbench.test.ts` 为 6/6 通过；新增/未跟踪源码空白检查和 `git diff --check` 通过。此沙箱未提供项目固定 Node.js `24.21.0`；不因此改动用户的 Node 环境。此前全仓 check/test/build 的 `24.21.0` 通过记录仍对应本次小修复之前的工作树。
- 在线冒烟验证（2026-09-28）：用户明确授权一次 DeepSeek Flash 普通对话调用，应用侧单次运行成本上限 USD 0.20。为避免改变用户默认服务，在 `127.0.0.1:3027` 单独启动 `WORKBENCH_MODE=online` API；运行时 Node.js `24.19.0`、npm `11.9.0`。健康接口确认 `mode=online`；创建新对话并提交一条普通提示后，运行状态为 `completed`，回复为“DeepSeek 在线调用成功。”，assistant 消息已写入对话；SSE 回放包含 `run.started`、`message.delta` 和 `run.finished`。本次只验证普通对话 API 与 SSE 的真实 provider 调用，不是浏览器 UI 在线模式验收，也未调用在线仓库分析能力。公开 API 响应未暴露本次实际 Token/费用，因此只记录应用侧配置的 USD 0.20 上限，不推断实际费用。临时在线 API 已停止，默认服务仍报告 `mode=fake`。此冒烟使用 Node.js `24.19.0`，不能替代固定工具链 `24.21.0` 的工程检查。
- 未验证/限制：真实 socket 断线期间的浏览器自动重连未作端到端网络中断模拟；真实模型回答质量、成功运行的仓库/ref/SHA 与实际服务账单未独立核验。用户已确认在线 `@仓库分析` 报告引用正确，但缺少完整 run ID 和仓库版本详情，Agent 无法独立复现。Agent 沙箱无法自行绑定 localhost；此前 fake 浏览器验收复用用户当前项目的 API `2027` 与 Web `2026`，未停止该进程。任务范围外的公网部署、数据库/进程重启恢复和动态插件市场未实现。
- 已知限制：服务状态只在进程内；fake 普通回答与固定合成仓库只用于闭环演示，不证明在线模型质量或真实 GitHub 全面兼容；活跃运行最多一个；没有登录、持久化或公网部署。浏览器刷新后的活动运行恢复已验证，但真实 socket 断线自动重连没有端到端模拟。
- GitHub 集成：PR [#14](https://github.com/Ranzxxx/pi-agent-workbench/pull/14) 已合并到 `main`；GitHub Actions “Offline checks” #39 成功；合并提交 `c5b050523cfec6b6c049a5688b0e3cdb9b95ceda`。本地 `main` 已快进到该提交。
- 提交 SHA：实现提交 `1f031d9`（`feat(TASK-006): add API, SSE, and web workbench`）；交接记录提交 `863e648`（`docs(TASK-006): record implementation commit`）。
- 下一步：TASK-006 已集成完成，可开始规划 TASK-007。若需补足可复核的在线运行记录，可提供成功运行的完整 run ID、仓库/ref/SHA 与报告产物摘要（不要提供 Token）。真实 socket 自动重连仍未端到端模拟；该限制保留为已知限制。
