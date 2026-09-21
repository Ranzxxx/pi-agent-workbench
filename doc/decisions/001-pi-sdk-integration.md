# ADR-001：PI SDK 适配层技术决策

## 状态

已验证，作为 v0.1 适配层设计输入。

## 背景

TASK-001 需要在不调用付费模型的前提下确认 PI SDK 是否能够支撑 Agent Worker 的会话生命周期、类型化工具、运行事件和取消控制。验证程序位于 `spikes/pi-sdk`，使用固定版本 `@earendil-works/pi-coding-agent@0.86.1` 与 `@earendil-works/pi-ai@0.86.1`。

## 验证结论

验证程序通过了以下路径：

| 能力 | 结果 | 观察到的 API 或行为 |
| --- | --- | --- |
| 创建与释放会话 | 通过 | `createAgentSession()`、`session.dispose()` |
| 类型化只读工具 | 通过 | `defineTool()` + TypeBox schema + `customTools` |
| 工具调用与结果事件 | 通过 | `tool_execution_start`、`tool_execution_end` |
| 文本和工具消息事件 | 通过 | `message_update` 的 `text_*`、`toolcall_*` 子类型 |
| Agent 生命周期 | 通过 | `agent_start`、`agent_end`、`agent_settled`、`turn_*` |
| 确定性失败 | 通过 | assistant message 的 `stopReason: "error"`，随后产生 `agent_end` |
| 显式取消 | 通过 | `session.abort()`，assistant message 的 `stopReason: "aborted"` |
| 应用层超时 | 通过 | 适配层定时调用 `session.abort()`，结果为 `aborted` |

失败和取消不应只依赖 `prompt()` 是否 reject。当前验证中，PI 会把部分失败和取消作为 assistant message 的 `stopReason` 返回，因此适配层必须同时检查消息结果、事件和异常。

## 决策

正式代码通过 `packages/agent-runtime` 封装 PI SDK，业务模块不直接依赖 `@earendil-works/pi-coding-agent` 的分散 API。建议对外暴露以下最小接口：

```ts
export type AgentRunRequest = {
  runId: string;
  prompt: string;
  timeoutMs?: number;
};

export type AgentRunEvent = {
  runId: string;
  sequence: number;
  type: "message" | "tool_start" | "tool_end" | "completed" | "failed" | "aborted";
  payload: unknown;
};

export interface AgentRuntime {
  createSession(options: { runId: string }): Promise<AgentSessionHandle>;
}

export interface AgentSessionHandle {
  run(request: AgentRunRequest, onEvent: (event: AgentRunEvent) => void): Promise<unknown>;
  abort(reason?: string): Promise<void>;
  dispose(): Promise<void>;
}
```

适配层内部负责：

1. 创建独立的 `ModelRuntime` 和 `AgentSession`。
2. 将项目工具注册为 `defineTool()` 定义，并在注册前执行只读策略检查。
3. 将 PI 事件转换为项目自己的版本化事件信封，补充 `runId` 和递增 `sequence`。
4. 将 `stopReason`、异常和取消统一映射为项目状态。
5. 在 `finally` 中取消订阅、释放会话，并通过 `runtime.unregisterProvider(provider.id)` 清理测试或临时 provider。
6. 用适配层自己的定时器实现超时，超时后调用 `session.abort()`。

## PI SDK 依赖点

- 会话：`createAgentSession`、`AgentSession.prompt`、`AgentSession.subscribe`、`AgentSession.abort`、`AgentSession.dispose`。
- 工具：`defineTool`、`customTools`、TypeBox 参数 schema。
- Provider：`ModelRuntime.create`、`registerNativeProvider`、`unregisterProvider`。
- 测试：`fauxProvider`、`fauxAssistantMessage`、`fauxToolCall`。

## 已知限制和风险

- `fauxProvider` 只用于确定性测试，不代表真实模型的延迟、重试、限流或上下文行为。
- `fauxProvider()` 返回的 `FauxProviderHandle` 没有 `unregister()`；provider 清理要调用 `ModelRuntime.unregisterProvider(provider.id)`。兼容入口中的注册函数是另一套 API，不能混用。
- `prompt()` 完成不等于业务成功。必须检查最终 assistant message 的 `stopReason`，并保留 `agent_end`、`agent_settled` 等事件。
- PI SDK 不提供项目级 `runId`、事件序号、任务持久化、断点恢复或业务幂等语义，这些由项目适配层和后续 Worker 负责。
- `defineTool()` 能提供参数校验，但“只读”是工具实现和项目策略的责任，SDK 不会自动阻止副作用。
- SDK 版本应固定并通过锁文件管理；升级时需要重新运行本技术验证，因为 provider 注册和生命周期 API 可能变化。
- v0.1 仍只允许只读仓库分析，不能因为 SDK 能执行工具就扩大到目标仓库代码安装或执行。

## 后续影响

TASK-002 可以基于本决策创建 `packages/agent-runtime` 的最小适配层。正式适配层建立前，不应把 `spikes/pi-sdk` 当作生产模块，也不应让业务代码直接导入 PI SDK。
