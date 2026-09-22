# TASK-003：最小工程、协议与离线 CI

## 元数据

- 状态：`backlog`
- 负责人：未分配
- 分支或 worktree：实施前创建 `task/003-project-foundation`
- 基线提交：实施前记录
- 依赖任务：TASK-002 审查并集成；不要求 TASK-001 干净安装验收预先通过，本卡负责补齐该证据。
- 提交/推送授权：无
- 在线模型授权：无

## 目标与非目标

建立可从干净环境安装和验证的最小 npm workspace、正式运行协议及 PI 薄适配层。不创建空的全套应用目录，不实现 GitHub 获取、报告业务或 Web。

## 允许路径与依赖授权

- 根 `package.json`、`package-lock.json`、`tsconfig*.json`、`.nvmrc`。
- `.github/workflows/**`、`.gitignore`（仅新增构建/测试忽略项）。
- `packages/protocol/**`、`packages/agent-runtime/**`。
- `spikes/pi-sdk/package.json`、`spikes/pi-sdk/tsconfig.json`（仅 workspace 与工具链协调，不删除回归）。
- `README.md`、`doc/decisions/001-pi-sdk-integration.md`、TASK-001、本任务卡和任务索引。

集成负责人授权本卡唯一写入者建立根锁文件与配置，并使用已选定的 PI SDK 0.86.1、TypeBox、TypeScript、tsx 和 Node 类型依赖；版本在开始时检查并固定。Schema 优先复用 TypeBox，不并行引入第二套校验库。额外依赖先记录理由再由集成者决定。首次依赖安装和 Node 升级可交由用户，不自动修改用户全局环境。

## 输入

[计划](../plan.md)、[ADR-001](../decisions/001-pi-sdk-integration.md)、TASK-002 的 spike 与负向测试。

## 验收标准

- [ ] Node.js 24 的明确版本可按根说明启动检查，开发与 CI 工具链一致。
- [ ] npm workspaces 只包含实际模块，根提供 check、test；spike 保持可运行。
- [ ] 协议包含版本、runId/attemptId、eventId/sequence、时间戳、明确事件 payload 与结果联合；无 unknown 占位公共数据。
- [ ] 运行状态机保证终态唯一，区分模型错误、工具错误、用户取消、超时和预算。
- [ ] PI 适配层显式注入凭据/资源/工具，业务模块不直接导入 PI。
- [ ] 离线测试验证错误拒绝、取消竞争、事件顺序、Token/调用上限与结果校验，既检查成功也检查失败。
- [ ] CI 在干净 checkout 使用锁文件安装并运行检查，不要求模型 Key；附实际成功日志或工作流链接。
- [ ] 按 spike 文档从无 node_modules 环境验证安装和启动，回填 TASK-001 的缺失验收证据。
- [ ] README 与任务状态真实同步。

## 验证计划（实施后提供）

- 根目录 `npm ci`、`npm run check`、`npm test`。
- `npm run start --workspace pi-sdk-spike`（若 spike 纳入 workspace）。
- GitHub Actions 或等价干净环境的实际结果，不能只提交 workflow 文件即称 CI 通过。

## 交接

- 完成内容：仅已定义任务；尚未实现或验证。
- 修改文件：本任务卡。
- 风险：发布包与源码 main 存在 API 差异；Node 24 未验证；真实模型依然不在默认测试中。
- 提交 SHA：无。
- 下一步：先核对 TASK-002 集成结果和现有依赖，再确定根 workspace 范围与精确工具链版本。
