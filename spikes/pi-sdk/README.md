# PI SDK 技术验证

TASK-001 的隔离实验程序，由 TASK-002 补强验收。这里是 SDK 行为验证，不是正式应用或生产适配层。

## 运行

原验证环境：Linux、Node.js 22.23.1、PI SDK 0.86.1。TASK-003 将正式 workspace 固定为 Node.js 24.21.0 / npm 11.9.0；新的干净安装与兼容性证据见任务卡。

日常开发在仓库根目录按根锁文件统一安装：

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run check --workspace pi-sdk-spike
npm test --workspace pi-sdk-spike
npm run spike
```

根安装完成后，在本目录执行 `npm run check`、`npm test`、`npm start` 仍然有效。不要混用根安装和子目录安装来维护依赖。

独立复现实验时，将本目录的 package.json、package-lock.json、tsconfig.json、src/、tests/ 复制到一个不属于 workspace 的新目录，再执行 `npm ci --ignore-scripts --no-audit --no-fund`、`npm run check`、`npm test`、`npm start`。CI 包含这个独立安装检查；保留的子锁文件仅供该用途。

## 校验内容

`npm start` 输出包含七个场景的 JSON：

1. 正常会话、类型化工具输入/输出、调用关联、事件顺序与最终文本。
2. 精确的 provider 错误传播。
3. 缺少必填参数时拒绝执行工具。
4. 工具异常以错误结果返回。
5. 模型响应期间显式取消。
6. 模型响应期间 30 ms 超时触发取消。
7. 工具执行期间取消及当前 SDK 的 abort 错误结果。

任何断言失败均非零退出。操作开始、prompt、空闲等待和清理均有等待上限；取消场景先确认 provider/工具已经开始，再触发取消。

`npm test` 还验证：正常结束不能冒充失败/取消，无关错误不能冒充预期错误，损坏工具结果、最终文本或事件顺序必须失败；污染的认证/上下文/扩展不能进入会话；无响应等待必须报错。

## 隔离与边界

- 使用 faux provider，不需要模型 API Key，不调用真实模型。
- 通过 InMemoryCredentialStore 和显式 ResourceLoader 隔离文件认证及资源自动发现，不加载个人或目标仓库配置。
- 只启用测试定义的工具，工具不安装或执行目标仓库代码。
- 配置污染测试只在专用临时目录创建和清理测试文件。
- 不改写进程的 HOME，不修改个人 PI 配置或根目录的 `pi/`。
- 不需要下载 PI 源码；发布包的类型与 API 是验证依据。

类型约束不是完整安全策略；PI 会尝试转换部分工具参数。当前版本在工具取消场景可能最终给出 error，而不是 aborted，因此验证同时检查具体错误、取消信号与工具事件，绝不接受任意错误作为通过。

## 文件与后续

- `src/harness.ts`：隔离会话、事件记录、受控清理与等待上限。
- `src/checks.ts`：七个行为场景。
- `src/assertions.ts`：被正常及负向样例共同调用的严格断言。
- `tests/spike.test.ts`：回归测试。
- [ADR-001](../../doc/decisions/001-pi-sdk-integration.md)：观察结果和未来适配层约束。

真实模型质量与费用尚未验证。干净安装与 Node.js 24 的实际验证记录见 [TASK-003](../../doc/tasks/003-project-foundation.md)。
