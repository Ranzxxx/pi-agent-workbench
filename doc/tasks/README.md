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
| [TASK-006 API、SSE 与通用 Agent 工作台基础界面](006-web-workbench.md) | review | 主 Agent | 全仓离线检查和 fake 浏览器闭环已有通过记录；Token 修复与错误响应复审后的 server 定向检查通过；用户确认在线报告引用正确；用户已授权提交、推送并创建/合并 PR |

下一可用编号为 TASK-007；不要提前分配给未知功能。TASK-005 已通过真实固定样本在线评测和人工评分，PR #12 与 CI #33 已合并/通过；评分质量门通过。该单一样本不构成跨仓库泛化保证。TASK-006 已校准为通用 Agent 工作台：普通提示词直接进入 PI Agent 对话，特殊需求可通过 `@名称` 显式调用已注册能力；默认不开放工具，仓库分析是首个能力。fake 浏览器闭环及先前全仓验证已通过。用户一次在线仓库分析遇到 GitHub API 匿名限流（HTTP 403、剩余额度 0）；已补可选服务端 Token 透传和安全限流提示，相关工作区测试通过；主 Agent 复审还补强了 Fastify 错误码映射并验证 server 定向检查。用户反馈在线仓库分析成功并确认报告引用正确；完整 run ID/仓库 SHA 尚缺，真实 socket 断线自动重连也未端到端模拟。TASK-006 保持 review，用户已授权提交与 PR 集成流程，合并后再同步完成状态。

## 创建与交接

从 [模板](TEMPLATE.md) 建卡，写明允许路径、共享文件所有权、依赖、验收和权限。实施前检查 Git 状态，填写基线和分支。结束时记录命令的真实结果与未验证项，同步此索引。

root package.json、锁文件、协议、迁移和计划不可由多个任务同时修改。依赖安装可由用户执行；在线模型、提交和推送分别需要明确授权。

TASK-006 的桌面/窄屏 fake 模式验收已由主 Agent 在当前项目完成。能力参数表单按注册元数据渲染；fake 模式只支持固定合成仓库，其他仓库不再得到误导性的 Harborlight 结果，前端会给无效 URL 明确提示。全仓检查、70 项测试和生产构建通过。用户另授权一次隔离 online API 普通 DeepSeek Flash 对话冒烟，真实回复写入对话且 SSE 事件完成。之后用户在线调用 `@仓库分析` 因 GitHub API 匿名限流失败，已补 optional `GITHUB_TOKEN` 服务端透传及错误提示，tools/server 定向测试通过；用户现反馈在线仓库分析成功且确认报告引用正确，但未提供完整 run ID/仓库 SHA，独立复现与账单核对仍未完成。具体结果见 [TASK-006 任务卡](006-web-workbench.md)。
