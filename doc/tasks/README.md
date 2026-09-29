# 任务索引与执行协议

任务卡是详细状态和验收证据的事实来源；本索引仅同步摘要。产品范围见 [计划](../plan.md)，规则见 [AGENTS.md](../../AGENTS.md)，接力提示词见 [协作流程](../multi-agent-workflow.md)。

## 状态

backlog（待开始）→ in_progress（实施）→ review（待验收/集成）→ done（验收、审查与集成都完成）。有具体外部阻塞时用 blocked。已经合并但复审发现验收缺口，也可以重开为 review，并保留历史。

不要求每个任务建立 GitHub Issue。一个任务一个写入者，默认顺序接力；并行必须独立 worktree，共享协议与根锁文件由集成者或指定唯一写入者负责。

## 当前任务

| 任务 | 状态 | 负责人 | 依赖/下一步 |
| --- | --- | --- | --- |
| [TASK-001 PI SDK 技术验证](001-pi-sdk-spike.md) | done | Codex | PR #1/#2 已合并；TASK-003 已补齐独立干净安装证据 |
| [TASK-002 验证补强与计划校准](002-review-hardening.md) | done | Codex | PR #2 已合并；提交 e455fb3，合并 58d4a78 |
| [TASK-003 最小工程、协议与离线 CI](003-project-foundation.md) | done | Codex | PR #3 已合并；用户确认 GitHub Actions 全绿 |
| [TASK-004 合成仓库证据与报告闭环](004-evidence-report.md) | done | Codex | PR #7 已合并至 `main`（`7dc9dc7`）；可以开始 TASK-005 |
| [TASK-005 公开仓库快照与单 Agent 分析](005-public-repository.md) | done | Codex | PR #9/#11/#12 已合并，CI #24/#30/#33 通过；DeepSeek Flash 固定样本在线质量门与人工评分通过 |
| [TASK-006 API、SSE 与通用 Agent 工作台基础界面](006-web-workbench.md) | done | 主 Agent | PR #14 已合并至 main；GitHub Actions #39 成功；本地 main 已快进同步。仍保留真实 socket 断线重连未端到端模拟等限制 |
| [TASK-007 v0.1 Review 问题修复与回归验收](007-v01-review-fixes.md) | done | Codex | PR #17 已 squash 合并至 `main`（`cede3fd`）；浏览器完整交互和固定工具链仍有任务卡记录的后补验证项 |

下一可用编号为 TASK-008；TASK-007 是已完成的修复和验收任务，不代表已决定下一项产品功能。TASK-005 已通过真实固定样本在线评测和人工评分；单一样本不构成跨仓库泛化保证。TASK-006 的 API、SSE、通用工作台和首个注册能力已集成，独立 Review 确认的 9 项代码问题已由 TASK-007 修复并集成；此前浏览器验收和全仓检查的历史证据仍保留在 [TASK-006 任务卡](006-web-workbench.md)，不能替代 TASK-007 的回归验收。真实 socket 断线重连、固定 Node.js 工具链复核和真实在线运行的完整元数据仍是已有验证缺口。详细修复项、触发证据和验收记录见 [TASK-007 任务卡](007-v01-review-fixes.md)。

## 创建与交接

从 [模板](TEMPLATE.md) 建卡，写明允许路径、共享文件所有权、依赖、验收和权限。实施前检查 Git 状态，填写基线和分支。结束时记录命令的真实结果与未验证项，同步此索引。

root package.json、锁文件、协议、迁移和计划不可由多个任务同时修改。依赖安装可由用户执行；在线模型、提交和推送分别需要明确授权。

TASK-006 的既有桌面/窄屏 fake 模式验收、全仓检查、历史测试及生产构建记录见对应任务卡。之后的独立 Review 已发现运行取消/互斥、会话状态、产物入口、UTF-8 边界、文本搜索和 SSE 错误响应等问题；TASK-007 完成前，不应把这些历史检查当作新发现问题已修复的证据。用户确认在线仓库分析报告引用正确，但没有提供完整 run ID/仓库 SHA；独立复现与账单核对仍未完成。
