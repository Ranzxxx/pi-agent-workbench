# ADR-001：PI SDK 集成与验证边界

## 状态与证据

- TASK-001 的基本实验已合并；TASK-002 补强了验收与隔离，本次修改尚待审查。
- 验证版本：`@earendil-works/pi-coding-agent@0.86.1`、`@earendil-works/pi-ai@0.86.1`，Node.js 22.23.1。
- 下面“已验证”仅指离线 faux provider 下的具体行为，不证明真实模型质量、持久化恢复或任意工具都能取消。
- spike 位于 [spikes/pi-sdk](../../spikes/pi-sdk/README.md)，独立于未来生产适配层。

## 复审修正

原检查用“错误/取消状态或出现 agent_end”判断通过，正常结束也能满足条件。原结论应理解为基本演示跑通，不能作为完整失败/取消回归证据。

TASK-002 改为严格断言，并增加正常结果不能冒充错误/取消、无关错误不能冒充预期错误、结果损坏和事件顺序错误必须失败的回归。检查命令有非零失败出口，等待有上限，不吞掉未知异常。

## 已验证的 API 和行为

| 场景 | API 与判定依据 |
| --- | --- |
| 会话生命周期 | `createAgentSession`、`prompt`、`waitForIdle`、`subscribe`、`dispose` |
| 类型化工具 | `defineTool`、TypeBox 参数；校验输入、结构化 details 和输出文本 |
| 正常事件 | 工具调用 ID 对应、开始/结果顺序、文本增量重建、最终文本和单次结束事件 |
| Provider 失败 | 最终 `stopReason=error` 且错误内容精确匹配；prompt 在此场景可正常 resolve |
| 参数缺失 | 必填参数缺失不会执行工具体，工具结果标记为错误 |
| 工具异常 | 工具错误可作为结果返回，Agent 随后仍可完成；单个工具失败不自动等同整个运行失败 |
| 模型等待时取消/超时 | 操作真正开始后取消，信号到达，最终 `aborted`，取消确认在测试的 1 秒阈值内 |
| 工具执行时取消 | 信号到达工具、工具返回明确取消错误；当前 SDK 后续路径最终为 `error`，错误为 `This operation was aborted` |
| 本地配置隔离 | 内存凭据、显式空资源加载器；包含认证/上下文/扩展污染的临时目录不影响结果 |

工具取消验证精确匹配当前版本行为，不能把任意 error 都当作取消。正式适配层应记录自己发起的取消原因和信号传播事实，再结合 SDK 结果决定终态。

SDK 的参数校验会尝试类型转换：数字 42 可能变成字符串 "42"。缺少必填字段的回归才明确验证拒绝路径；不要把 TypeScript 类型或 TypeBox schema 当成完全禁止转换的安全边界。路径和权限必须在工具实现中独立验证。

## 集成决策

正式业务代码只能通过 `packages/agent-runtime` 接入 PI。复用 PI 的 Agent 循环和 provider 机制，适配层仅负责项目语义与边界。

- 凭据使用明确传入的 store；离线测试使用公开 API `InMemoryCredentialStore`。
- 测试提供受控 `ResourceLoader`，所有扩展、Skills、提示模板、主题和上下文文件集合为空；系统提示由应用提供。
- 不从目标仓库自动加载 AGENTS.md 或可执行扩展。仓库内容只能经受限工具进入证据上下文。
- 每次运行采用明确工具白名单。应用负责快照获取和受控产物写入，Agent 不获得通用 shell。
- 订阅在 finally 中解除，会话退出后 dispose。临时 provider 在所属 `ModelRuntime` 中调用 `unregisterProvider(provider.id)`。
- `fauxProvider()` 返回的 handle 没有 `unregister()`；不要混用兼容入口和当前 API。
- 已安装发布包的公开导出是实现依据；本地 main 分支参考源码不能替代锁定版本的类型验证。
- 当前实验未增加依赖；测试采用 Node 内置 test runner 和已有 tsx。

## 正式协议约束（设计，尚未实现）

由 TASK-003 将下面结构落实为可校验 schema。这里不再提供可直接复制的 `unknown` 占位接口。

### 运行结果

`RunResult` 使用区分联合，公共字段包含 schemaVersion、runId、attemptId、usage 和结束时间：

| status | 必需数据 |
| --- | --- |
| completed | 已通过产物校验的 artifact 引用列表 |
| failed | code、message、可选失败阶段；不得暴露凭据 |
| cancelled | reason：user / timeout / token_limit / call_limit / cost_limit；保留已收集证据 |

运行状态为 queued（预留）→ running → cancelling（需要时）→ 一个终态。一次 attempt 最多一个终态事件。先完成且校验已通过时，迟到的取消不能改写成功；运行期间已接受取消后不能发布成功报告。无法及时取消的操作保留取消中状态和明确错误记录，不能谎称已停止。

### 事件

公共信封包含 `schemaVersion: 1`、eventId、runId、attemptId、严格递增 sequence、timestamp 和事件数据。各 type 与 data 绑定校验：

| type | data |
| --- | --- |
| run.started | 不可变仓库标识、SHA 和分析目标 |
| text.delta | 文本增量 |
| tool.started | toolCallId、toolName 和经过裁剪的参数摘要 |
| tool.finished | 对应调用 ID、isError、带类型与大小限制的结果摘要 |
| run.finished | RunResult；每个 attempt 唯一 |

PI 原始事件不直接成为公共协议。工具错误、模型错误、用户取消、超时和预算耗尽分别映射；不能用 agent_end 判断成功。工具细节若需扩展，应新增具体 schema，不让 UI 猜测任意 payload。

### 会话接口与预算

- `createSession` 只分配一次 runId，明确会话所有权；run 请求不再次携带可能冲突的运行 ID。
- run 接受分析输入与预算，返回 RunResult；abort 接受项目定义的原因；dispose 有明确幂等语义。
- 预算包括总时长、调用次数、工具次数、累计 Token 和估算成本，初值见计划。
- 每次调用前检查剩余额度，在途调用发送取消，所有尝试计费。凭据与完整敏感参数不进入公开事件。
- 应用阶段检查点、PI 消息历史和 SSE 事件日志分别管理，不把会话序列化等同于业务恢复。

## 验证命令与限制

在 `spikes/pi-sdk` 执行：

```bash
npm run check
npm test
npm start
```

- `npm start` 校验七个生命周期场景；失败抛错并非零退出。
- `npm test` 增加负向断言、配置污染与等待上限测试。
- 使用已有 node_modules 验证；未重新安装依赖，干净安装交由 TASK-003 的 CI 验证。
- faux 的文本分块固定；时间戳、耗时和模拟 usage 不作为真实模型性能依据。
- 不执行真实 provider、联网模型、进程重启恢复、SSE、数据库、Docker 或非协作式工具强制终止测试。
- 正式 SDK 升级与 Node.js 24 迁移后需重新验证，尤其是工具取消和资源加载行为。
