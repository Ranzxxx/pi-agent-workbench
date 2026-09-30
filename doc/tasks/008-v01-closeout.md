# TASK-008：v0.1 收尾与聚焦验证

## 元数据

- 状态：`done`
- 负责人：Codex 主 Agent
- 实施分支：`codex/task-008-v01-closeout`；合并状态同步分支：`codex/task-008-integration-record`；仓库根目录的独占 checkout
- 基线提交：`0c6d3ff86645cfe70be8cf96144158ecfe30cecb`
- 依赖任务：TASK-007（已完成并合并）
- 提交/推送授权：用户于 2026-09-29 明确授权本地提交、推送、创建 PR 并合并。
- 实施提交：`b4c27f8990ea319c5e40d09407713c6de709db6e`
- 集成记录：PR #18 squash 合并；合并提交 `f31681bb29f23c68a46bda29fad97b04f88ae190`
- GitHub Actions：Offline checks #53 全部通过（[运行记录](https://github.com/Ranzxxx/pi-agent-workbench/actions/runs/36571628811)）
- 在线模型授权：无；本任务只运行离线检查

## 背景与目标

将 v0.1 的已交付范围和当前验收状态同步到计划与任务索引，并对 TASK-007 集成后的工作区做一轮聚焦的本地检查。任务目标是完成 v0.1 收尾，不扩大为完整严格验收或新功能开发。

## 范围与非目标

- 校正 `doc/plan.md`、本任务卡与任务索引的状态：TASK-007 已完成，TASK-008 收尾完成并经 review、集成后标记 done。
- 运行已有 workspace 类型检查、测试、Web 构建和差异格式检查，记录实际工具链版本与命令结果。
- 如固定 Node.js 24.21.0/npm 11.9.0 不可用，可用当前可用版本进行聚焦检查，但必须明确记录版本差异，不称为固定工具链验证。
- 不新增产品功能，不做真实 socket 断线重连的完整浏览器验收，不发起真实 GitHub/模型请求，不进行付费在线评测。
- 本任务不计划修改生产代码、公共协议、依赖或锁文件；若检查暴露需代码修复的问题，记录证据并评估是否需要另开任务。

## 允许路径与依赖授权

- `doc/plan.md`
- `doc/tasks/README.md`
- `doc/tasks/008-v01-closeout.md`

不授权改动其他路径。唯一计划文件写入者为本任务负责人。

## 输入与前置条件

- TASK-007 已由 PR #17 合并至 `main`，合并提交 `cede3fd112c4291e7597ac02d104a70d5267629`。
- 开始前 `main` 与 `origin/main` 同为 `0c6d3ff86645cfe70be8cf96144158ecfe30cecb`。
- 开始前已有未提交的 `doc/plan.md` 变更，内容涉及 TASK-007 Review 状态及后续步骤。本任务保留并校准该已有修改，没有覆盖其他工作区内容。
- 本任务 shell 的 `node` 命令解析到受限的 `/snap/bin/node` 包装入口；经用户提供绝对路径后，确认 `/snap/node/12007/bin/node` 为 Node.js 24.21.0，npm 为 11.9.0，并使用该固定工具链完成验证。

## 验收标准

- [x] 计划、任务索引和任务卡一致反映 TASK-007 已完成、TASK-008 收尾工作已完成并进入 review。
- [x] 对当前集成代码运行已有 workspace 检查、测试和 Web 构建；所有实际命令、退出结果和工具链版本均记录。固定 Node.js 24.21.0/npm 11.9.0 检查通过。
- [x] `git diff --check` 通过；检查结束时没有发现未记录的工作区改动。
- [x] 未将未执行的 socket、在线质量或固定工具链验收描述为通过；未发起外部网络或付费模型调用。

## 验证命令与证据

计划执行：

```bash
npm run check
npm test
npm run build
git diff --check
```

实施中记录实际可用工具链及命令。若根级工具链守卫因固定版本不可用而拒绝执行，记录该结果；是否使用可用 Node/npm 绕过版本守卫运行 workspace 脚本，由负责人先核对命令语义并在此记录。

实际结果（2026-09-29；Node.js 24.21.0、npm 11.9.0）：

- `npm run check`：标准根级工具链守卫通过，7/7 workspace 类型检查通过。
- `npm test`：获准在沙箱外执行后，6 个带 test 脚本的 workspace 共 79 项测试通过；沙箱内首次执行时，tsx IPC 管道创建返回 `EPERM`，测试尚未启动。
- `node --import tsx --test apps/web/tests/*.test.tsx`：Web 独立 SSR 测试 1/1 通过。总计 80 项。
- `npm run build`：Web 生产构建通过。沙箱内首次运行在 Next.js 读取 TypeScript `--showConfig` 输出时失败；获准在沙箱外以固定工具链重跑后，编译、类型处理和静态生成通过。
- `git diff --check`：通过。
- 没有运行真实模型、GitHub 在线请求或真实 socket 断线 E2E；这些仍是本任务范围外的已知限制。

## 决策、冲突与范围变化

- 用户确认 TASK-008 作为 v0.1 收尾，重点为收尾工作和聚焦测试，不要求大量严格验收。
- 已有 socket 端到端和在线多次评测证据缺口在计划中继续如实保留，不在本任务内扩大范围。
- 如需修改生产代码、测试文件、协议或依赖，先记录具体失败证据并重新界定任务范围。

## 交接

- 当前状态：`done`；聚焦检查、审查和集成都已完成。
- 完成内容：TASK-007 状态校正；TASK-008 计划与索引同步；7 个 workspace 类型检查通过，80 项测试通过，Web 生产构建和 `git diff --check` 通过。
- 修改路径：`doc/tasks/008-v01-closeout.md`、`doc/tasks/README.md`、`doc/plan.md`。
- 实际验证：见“验证命令与证据”。
- 风险与未验证：真实 socket 断线 E2E、额外在线评测不属于本任务且仍未验证。
- 实施提交 / PR：`b4c27f8990ea319c5e40d09407713c6de709db6e` / [PR #18](https://github.com/Ranzxxx/pi-agent-workbench/pull/18)。
- 集成提交：`f31681bb29f23c68a46bda29fad97b04f88ae190`；GitHub Actions Offline checks #53 通过。
- 状态同步分支 / PR：`codex/task-008-integration-record` / [PR #19](https://github.com/Ranzxxx/pi-agent-workbench/pull/19)。
- 已停止写入：是；实施已合并，任务最终状态和证据已同步。
- 下一步：根据使用反馈与已记录的限制决定是否需要新的、有明确范围的任务；不预设 TASK-009。
