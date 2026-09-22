# 任务索引与执行协议

任务卡是详细状态和验收证据的事实来源；本索引仅同步摘要。产品范围见 [计划](../plan.md)，规则见 [AGENTS.md](../../AGENTS.md)，接力提示词见 [协作流程](../multi-agent-workflow.md)。

## 状态

backlog（待开始）→ in_progress（实施）→ review（待验收/集成）→ done（验收、审查与集成都完成）。有具体外部阻塞时用 blocked。已经合并但复审发现验收缺口，也可以重开为 review，并保留历史。

不要求每个任务建立 GitHub Issue。一个任务一个写入者，默认顺序接力；并行必须独立 worktree，共享协议与根锁文件由集成者或指定唯一写入者负责。

## 当前任务

| 任务 | 状态 | 负责人 | 依赖/下一步 |
| --- | --- | --- | --- |
| [TASK-001 PI SDK 技术验证](001-pi-sdk-spike.md) | review | Codex / 待集成者复核 | PR #1 已合并；复审重开，补强见 TASK-002，干净安装证据待 TASK-003 |
| [TASK-002 验证补强与计划校准](002-review-hardening.md) | review | Codex | 修复与文档已验证，未提交/集成 |
| [TASK-003 最小工程、协议与离线 CI](003-project-foundation.md) | backlog | 未分配 | TASK-002 |
| [TASK-004 合成仓库证据与报告闭环](004-evidence-report.md) | backlog | 未分配 | TASK-003 |
| [TASK-005 公开仓库快照与单 Agent 分析](005-public-repository.md) | backlog | 未分配 | TASK-004 |
| [TASK-006 API、SSE 与最小 Web](006-web-workbench.md) | backlog | 未分配 | TASK-005 |

下一可用编号为 TASK-007；不要提前分配给未知功能。本轮用户明确选择只完成 TASK-002，不启动 TASK-003～006。

## 创建与交接

从 [模板](TEMPLATE.md) 建卡，写明允许路径、共享文件所有权、依赖、验收和权限。实施前检查 Git 状态，填写基线和分支。结束时记录命令的真实结果与未验证项，同步此索引。

root package.json、锁文件、协议、迁移和计划不可由多个任务同时修改。依赖安装可由用户执行；在线模型、提交和推送分别需要明确授权。
