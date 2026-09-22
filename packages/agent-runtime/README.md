# PI 运行适配层

业务模块从 `@pi-workbench/agent-runtime` 接入运行时，数据协议从 `@pi-workbench/protocol` 导入。PI SDK 的直接调用限制在本包和保留的 spike；不重写 SDK Agent 循环。

## 接口

`createSession(options)` 要求明确传入 cwd、credentials、provider、model、应用 systemPrompt、tools、budget、pricing 和 finalize。返回单次运行会话：

- `runId` / `attemptId` 在创建时分配；`run(input)` 不再接收可冲突的 ID。
- `run(input)` 接收固定 SHA 的仓库标识和分析目标，返回版本化 RunResult。
- `state` 为 queued、running、cancelling 或唯一终态。
- `abort(reason)` 只在 running 时接受第一个原因；之后调用返回 false。
- `dispose()` 幂等；运行时先取消并等待退出。正常终结会自动清理订阅和 SDK 会话。
- `waitForResult()` 用于取消未及时完成时继续观察实际退出；不能用它跳过业务校验。
- `onEvent` 接收克隆后的公共事件。观察器异常不影响执行，计入 `observerErrors`；后续 API 层须监测这个计数，不承诺当前已经具备可靠事件存储。

`finalize({ text, signal })` 是应用提供的产物校验与发布入口。SDK 最终消息必须为 stop，且 finalize 返回有效、非空的产物引用，才能 completed。调用方必须校验报告内容、证据及实际文件；本包只校验返回引用的 schema，不实现报告业务，也不声称已验证引用对应文件的内容。取消后不得发布产物，下一任务需在写入前检查 signal。

## 边界

- 显式内存会话及设置；资源加载器不发现认证文件、AGENTS.md、扩展、Skills 或提示模板。
- 凭据必须显式传入，离线使用 InMemoryCredentialStore；缺失时拒绝，不退回本地认证文件。
- tools 是唯一工具白名单；默认空。工具实现由应用提供，本包不授予 shell 或任意文件操作。工具输入的路径安全在 TASK-004 实现。
- PI 的公开 `streamFunction` 边界在每次模型调用前检查预算；保留 SDK 已安装的工具钩子，并在工具执行前加准入检查。SDK 自动重试和自动压缩关闭。
- 工具调用计数包含获准进入 SDK 校验的请求，错误参数也消耗一次；超额请求不执行工具体。单个工具错误通过 tool.finished 表达，模型可继续，最终成功仍需应用校验。
- 公共工具参数摘要固定为 omitted，工具结果只发出 ok/tool_error/cancelled。原始 SDK 错误不直接放进公共事件。
- Token 统计包含输入、输出、缓存读取和缓存写入，思考 Token 已包含在输出中，不重复相加；以每次实际返回的 usage 累加。
- pricing 使用带版本的每百万 Token 美元价格。达到余额上限时停止后续模型和工具调用；在途请求可能超限或没有完整 usage，费用并非硬性预付上限。
- 运行时长覆盖模型、工具和 finalize；单次输出 Token 被设置上限。失败/取消返回已经收到的 usage。
- 取消在 1 秒内未退出时，run 抛 CancellationPendingError，并发出 run.warning，state 保持 cancelling；没有 run.finished。实际操作退出后才发布 cancelled。非协作式调用可能一直不退出，本包不具备进程级强制终止能力。
- 一次会话仅允许一次 run。不会恢复进程、获取源码、自动生成报告、启动 API 或调用真实模型。

## 验证

从根目录运行 `npm run check`、`npm test`。测试覆盖协议拒绝、生命周期、工具结果、取消竞争、预算、配置污染和无法及时退出的操作；测试 fixture 全部为合成数据。
