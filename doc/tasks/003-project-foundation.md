# TASK-003：最小工程、协议与离线 CI

## 元数据

- 状态：`done`（PR #3 已集成；GitHub Actions 在最终任务分支提交上全绿）
- 负责人：Codex（唯一写入者与集成者）
- 分支或 worktree：`task/003-project-foundation`；仓库根目录的独占 checkout
- 基线提交：`58d4a7886048581bcb6dc1b6b07ed7ab5d587f20`
- 依赖任务：TASK-002 审查并集成；不要求 TASK-001 干净安装验收预先通过，本卡负责补齐该证据。
- 提交/推送：用户已在前续轮次提交 `daf7176` 并推送；未由 Codex 执行。
- 在线模型授权：无

## 目标与非目标

建立可从干净环境安装和验证的最小 npm workspace、正式运行协议及 PI 薄适配层。不创建空的全套应用目录，不实现 GitHub 获取、报告业务或 Web。

## 允许路径与依赖授权

- 根 `package.json`、`package-lock.json`、`tsconfig*.json`、`.nvmrc`。
- `.github/workflows/**`、`.gitignore`（仅新增构建/测试忽略项）。
- `packages/protocol/**`、`packages/agent-runtime/**`。
- `spikes/pi-sdk/package.json`、`spikes/pi-sdk/tsconfig.json`（仅 workspace 与工具链协调，不删除回归）。
- `README.md`、`doc/decisions/001-pi-sdk-integration.md`、TASK-001、本任务卡和任务索引。
- 用户本轮明确授权同步 TASK-002：允许更新 `doc/tasks/002-review-hardening.md` 与 `doc/plan.md`。
- 集成者补充授权：更新 `spikes/pi-sdk/README.md` 的根 workspace 安装说明；保留其独立锁文件用于 TASK-001 干净安装验证。

集成负责人授权本卡唯一写入者建立根锁文件与配置，并使用已选定的 PI SDK 0.86.1、TypeBox、TypeScript、tsx 和 Node 类型依赖；版本在开始时检查并固定。Schema 优先复用 TypeBox，不并行引入第二套校验库。额外依赖先记录理由再由集成者决定。首次依赖安装和 Node 升级可交由用户，不自动修改用户全局环境。

## 输入

[计划](../plan.md)、[ADR-001](../decisions/001-pi-sdk-integration.md)、TASK-002 的 spike 与负向测试。

## 验收标准

- [x] Node.js 24 的明确版本可按根说明启动检查，开发与 CI 工具链一致。
- [x] npm workspaces 只包含实际模块，根提供 check、test；spike 保持可运行。
- [x] 协议包含版本、runId/attemptId、eventId/sequence、时间戳、明确事件 payload 与结果联合；无 unknown 占位公共数据。
- [x] 运行状态机保证终态唯一，区分模型错误、工具错误、用户取消、超时和预算。
- [x] PI 适配层显式注入凭据/资源/工具，业务模块不直接导入 PI。
- [x] 离线测试验证错误拒绝、取消竞争、事件顺序、Token/调用上限与结果校验，既检查成功也检查失败。
- [x] CI 在干净 checkout 使用锁文件安装并运行检查，不要求模型 Key；[Offline checks 运行 #35813163678](https://github.com/Ranzxxx/pi-agent-workbench/actions/runs/35813163678) 在提交 `f14bbf8f99ac0d2c478708ae925ade818a937e94` 上全部通过。
- [x] 按 spike 文档从无 node_modules 环境验证安装和启动，回填 TASK-001 的缺失验收证据。
- [x] README 与任务状态真实同步。

PR #3 已合并到 `main`，代码合并提交为 `6834ee2b4caa4b30b543da2832c6e49ebdcdf39b`。状态记录 PR #5 已合并，GitHub merge commit 为 `6c2030314b8d6d4af67962b9602f998117f8647b`。[Offline checks 运行 #35813163678](https://github.com/Ranzxxx/pi-agent-workbench/actions/runs/35813163678) 在提交 `f14bbf8f99ac0d2c478708ae925ade818a937e94` 上全部通过。

## 实施决策

- 用户明确授权在临时目录安装 Node/npm、生成根锁文件并验证；没有升级或替换全局 Node，也没有安装目标仓库代码。
- 工具链固定 Node.js 24.21.0 / npm 11.9.0；正式 Node 类型 24.13.6，TypeScript 5.9.3，tsx 4.20.5，TypeBox 1.3.27，PI SDK 0.86.1。Node/npm 包经注册表 integrity 校验后解压；没有增加上述范围之外的直接生产依赖。
- 仅建立 protocol 和 agent-runtime 两个包，spike 纳入 workspace；保留独立 spike 锁文件及原测试代码，不混用安装入口。
- TypeBox schema 和语义校验共同拒绝错误版本、联合分支、ID、日期、路径、Token 合计和重复产物；公共事件不包含 unknown 数据占位。
- 薄适配层使用 SDK 公开 streamFunction / beforeToolCall 加准入控制，保留原工具钩子，不重写 Agent 循环；SDK 自动重试/压缩关闭。
- 模型 stop 不是业务完成：应用 finalize 必须成功并返回有效产物引用。报告内容与实际文件的验证由 TASK-004 实现，本任务测试只使用明确的合成产物引用。
- 增加 run.cancelling / run.warning，工具配额使用独立 tool_limit 原因；取消超出等待上限时保留 cancelling，不虚报操作已结束。
- SDK 工具错误允许模型恢复，公共 tool.finished 单独标明 tool_error；原始错误和参数不直接公开。
- faux provider 会重算模拟 usage；集成断言与其实际返回值比较，预算单元测试另用固定数值校验累计及价格运算。
- 同步 TASK-002 的用户提交 e455fb3 / PR #2 / 合并 58d4a78；TASK-001 的原代码及补强已集成，本轮补齐干净安装验收后恢复 done。

## 实际验证（2026-09-22）

两份临时副本创建时均没有 node_modules，不包含 pi/ 或 doc/internal/；npm 缓存可复用，属于全新项目安装，不代表全新操作系统。Node 24.21.0 / npm 11.9.0 下：

| 环境 | 命令与结果 |
| --- | --- |
| 根工程副本 | `npm ci --ignore-scripts --no-audit --no-fund` 通过，按根锁文件安装 |
| 根工程副本 | `npm run check` 通过，检查两个正式包及 spike |
| 根工程副本 | `npm test`：24 项通过，0 失败（protocol 5、runtime 14、spike 5） |
| 根工程副本 | `npm run spike`：7 个场景全部 ok: true |
| 独立 spike 副本 | 按原子锁文件执行 `npm ci --ignore-scripts --no-audit --no-fund` 通过 |
| 独立 spike 副本 | `npm run check`、`npm test`、`npm start` 通过；5 项测试、7 场景 |

- 根工程日志：`/tmp/pi-task003-clean-workspace.log`，SHA-256 `76887153a36445e8c36feec3f275f215c58a28fe9f3738bede65d20238f02444`。
- 独立 spike 日志：`/tmp/pi-task003-clean-spike.log`，SHA-256 `20ea3273d97163618e581a29551d83b1aac197c7aaf80c85ae2f5319f9c74e6b`。
- 上述为本机临时日志，不提交到仓库；远程 CI 结果见 [运行 #35813163678](https://github.com/Ranzxxx/pi-agent-workbench/actions/runs/35813163678)，测试提交为 `f14bbf8f99ac0d2c478708ae925ade818a937e94`。
- 用户确认远程分支 `revert-3-task/003-project-foundation` 是误触产生；其提交 `74d257c` 会撤销 TASK-003 的 25 个文件，但不包含在 `main`。不把它当作有效回滚或合并目标。
- 最终只读复核：`git diff --check` 通过；15 个 Markdown 文档的本地链接无缺失；24 个代码/配置/锁文件与已通过干净验证的副本逐字节一致；25 个变更文件均在任务授权范围内；原 spike 锁文件未修改，pi/ 和 doc/internal/ 无 Git 跟踪内容。Workflow YAML 已通过解析及触发器/测试步骤检查，此检查不替代远程 Actions 执行。
- 环境限制：tsx 的 IPC socket 在沙箱内被 EPERM 拒绝，离线检查通过已批准的沙箱外执行；全程无真实模型调用。
- 本次审查使用完整工作区差异；实现问题已修复，本地验收通过。远程 workflow 还需在推送后确认。

## 集成与验收

- 用户已创建并合并 [PR #3](https://github.com/Ranzxxx/pi-agent-workbench/pull/3)。实现提交：`daf71765e5f22bce6507a0d658bc8f8ac230ee81`；GitHub merge commit：`6834ee2b4caa4b30b543da2832c6e49ebdcdf39b`。
- 本地 `main` 已快进同步到 `6834ee2`。TASK-003 代码现已集成。
- 本地全新安装、24 项测试、7 个 spike 场景均通过，证据见上节。
- GitHub Actions [运行 #35813163678](https://github.com/Ranzxxx/pi-agent-workbench/actions/runs/35813163678) 对提交 `f14bbf8f99ac0d2c478708ae925ade818a937e94` 的离线检查全部通过；本地干净安装与离线验证也已通过。
- TASK-003 的实现、本地验收、PR 集成与远程 CI 用户确认均已完成，状态设为 done；可以启动 TASK-004。
- 用户确认远程撤销分支为误触产生；它没有影响 `main`，不要合并该分支。

## 交接

- 当前状态：done；实现、本地验收、PR #3 集成和用户确认的远程 CI 均完成。
- 修改路径：根 package.json / package-lock.json / tsconfig.base.json / .nvmrc；.github/workflows/ci.yml；packages/protocol/**、packages/agent-runtime/**；README.md、spike README；计划、ADR、TASK-001～003 与任务索引。
- 已知限制：真实 provider/成本质量、报告业务、GitHub 获取、API/Web、进程恢复与强制终止未验证或尚未实现；在途调用可能超出估算预算。GitHub Actions 远程离线验收已通过，见 [运行记录](https://github.com/Ranzxxx/pi-agent-workbench/actions/runs/35813163678)。
- 实现提交：`daf71765e5f22bce6507a0d658bc8f8ac230ee81`；PR #3；合并提交：`6834ee2b4caa4b30b543da2832c6e49ebdcdf39b`。
- 状态记录 PR #5 已合并；验收记录与 CI 证据链接见本卡上方，提交历史见 GitHub。
- 已停止写入：本轮结束后停止；下一位 Agent 先检查实际 Git 状态。
- 下一位 Agent 第一个动作：按任务索引启动 TASK-004；TASK-003 的远程 CI 证据见 [运行 #35813163678](https://github.com/Ranzxxx/pi-agent-workbench/actions/runs/35813163678)。
