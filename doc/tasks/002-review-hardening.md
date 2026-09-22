# TASK-002：技术验证补强与计划校准

## 元数据

- 状态：`review`
- 负责人：Codex（实现与文档集成）
- 分支或 worktree：`task/002-review-hardening`，`/home/lzs/Projects/pi`；当前 checkout 由本任务独占，无并行写入者。
- 基线提交：`dd82a11a90676691121c2617495112563f844c6c`
- 依赖任务：TASK-001（已通过 PR #1 集成）
- 提交授权：无；本轮不创建 commit、不推送、不合并。

## 背景与目标

用户接受项目复审建议，并明确本轮只修复现有问题、更新全部文档。消除 TASK-001 的假阳性和本地配置污染，建立与实际进度一致的计划、决策、任务及协作入口。

## 允许修改的路径与授权

- `spikes/pi-sdk/**`
- `AGENTS.md`
- `README.md`、`LICENSE`
- `doc/plan.md`、`doc/multi-agent-workflow.md`
- `doc/decisions/001-pi-sdk-integration.md`
- `doc/tasks/**`

集成负责人在本卡明确批准上述共享文档修改和 spike 测试脚本调整。不得修改根依赖或锁文件，不增加依赖，不修改 `pi/` 或发布 `doc/internal/`。

## 非目标

- 不实施后续 monorepo、仓库分析、API、SSE 或 Web；只建立对应任务卡。
- 不调用真实模型、不安装目标仓库依赖、不执行目标仓库代码。
- 不变更已合并提交历史，不声称真实模型质量或干净安装已经验证。

## 验收标准

- [x] 正常、错误、取消、超时具有严格终态断言，正常结束和无关异常不能误判为通过。
- [x] 校验工具结果、最终文本、关键事件顺序与关联；包含参数错误、工具失败和工具取消验证。
- [x] 使用内存凭据和明确资源加载边界，不自动发现本地认证、上下文或扩展；污染环境回归验证通过。
- [x] 等待有明确上限，取消在操作实际开始后触发，失败会让检查命令非零退出。
- [x] 计划聚焦 v0.1 仓库证据报告，后续能力以启用条件约束，消除重复和矛盾。
- [x] ADR 明确结果、事件、预算与取消语义的设计约束，区分已验证 API 与未来协议。
- [x] 任务索引、历史卡、协作流程、根使用说明与实际状态一致；后续任务可独立接管。
- [x] 修改范围、验证命令、限制和下一步完整记录。

## 验证计划

- 在 `spikes/pi-sdk` 执行 `npm run check`、`npm test`、`npm start`。
- 只读核对文档链接、任务状态、私有路径排除和 `git diff --check`。
- 依赖安装仍由用户负责，本轮使用已有依赖，不宣称已验证干净安装。

## 决策与范围变化

- 本卡记录复审修复，不将原 TASK-001 的弱验收结论追溯修改成当时已验证。
- 顺序接力可以使用独占的现有 checkout 和任务分支；并行写入仍必须分配独立 worktree。协作指南与 AGENTS 的冲突由集成负责人在本轮统一修正。
- 当前计划与 ADR、任务卡间的状态和协议矛盾属于本轮授权修正范围。
- 发布包公开入口不导出 AuthStorage；已采用 pi-ai 的 InMemoryCredentialStore，没有依赖内部路径。
- SDK 会把数字参数尝试转换成字符串；拒绝测试使用缺失必填字段，不错误要求 SDK 禁止所有转换。
- 工具取消的最终 SDK 消息实测为 error / This operation was aborted；断言同时要求信号到达、精确错误、工具取消结果和单一终态，普通错误仍必须失败。
- TASK-001 保留 PR #1 合并事实，但复审状态改为 review；干净安装未验证，由 TASK-003 补齐。TASK-003～006 本轮仅建卡。

## 交接

- 当前状态：review，代码与文档可审查；未提交、未合并。
- 完成内容：重写 spike 的隔离会话与严格断言；七场景演示、五组回归；重整计划/ADR/协作协议；更新历史卡与索引；新建 TASK-003～006；补充根 README 与 MIT LICENSE。
- 修改文件：AGENTS.md、README.md、LICENSE；doc/plan.md、doc/multi-agent-workflow.md、doc/decisions/001-pi-sdk-integration.md；doc/tasks/001～006、README.md、TEMPLATE.md；spikes/pi-sdk 的 README.md、package.json、tsconfig.json、src/index.ts、src/harness.ts、src/checks.ts、src/assertions.ts、tests/spike.test.ts。
- 验证结果（2026-09-21，已有依赖，Node.js 22.23.1）：
  - `npm run check`：通过，包含源码与测试类型。
  - `npm test`：5 组全部通过；包含 7 个生命周期场景及负向、隔离、等待上限验证。
  - `npm run --silent start`：7 个场景全部通过，正常/错误/取消结果与断言一致。
  - `git diff --check`：通过。
  - Python 本地 Markdown 链接检查：14 个文档，0 个缺失目标。
  - `git -C pi status --short`：无参考源码改动；`git ls-files pi doc/internal` 无跟踪内容；依赖锁文件未改。
  - Snap Node 在沙箱内无法启动，Node 检查通过批准的沙箱外执行完成；没有安装或升级依赖。
- 风险与未验证事项：真实 provider、在线质量/费用、干净安装、Node.js 24、正式协议、进程恢复和非协作式工具终止未验证；不能将模拟结果推广为生产保证。
- 提交 SHA：无（未提交）。
- 已停止写入：本轮结束后停止；下一位 Agent 先检查实际 Git 状态。
- 下一步：按本卡范围审查差异，由用户提交/推送和 PR 合并；集成者回填本卡后再启动 TASK-003，不重复安装或重做已经验证的 spike。
