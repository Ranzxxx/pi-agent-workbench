# TASK-009：v0.1.0 开源发布准备

## 元数据

- 状态：`review`
- 负责人：Codex 主 Agent
- 分支或 worktree：`codex/task-009-v01-release-readiness`，`/home/lzs/Projects/pi`
- 基线提交：`fd2fb7c1f932dffb453e111e90ff0f4478cdeaa1`
- 依赖任务：TASK-008（已完成并合并）
- 提交/推送授权：用户于 2026-09-30 要求完成 v0.1.0 README 发布准备 PR 和发布前审计。
- 公开仓库、推送 release tag、创建 GitHub Release：本任务不执行。
- 在线模型授权：无；不得发起付费调用。

## 背景与目标

为 v0.1.0 的 GitHub 源码 Release 和后续开源作准备：更新 README 的版本状态、功能范围、工具链要求、在线费用和未验证限制，并审计当前源文件、可达 Git 历史和 GitHub Actions 记录中的发布风险。

## 范围与非目标

- 校正 README 中过期的 TASK-007 状态，说明 v0.1.0 候选内容、运行要求、默认离线行为和主要限制。
- 检查 MIT 许可证、仓库文件、可达 Git 历史和 GitHub Actions 运行记录中的密钥、个人数据及私有研究资料。
- 记录第三方代码来源和许可证风险；代码审计不能替代代码贡献者或权利人的授权确认。
- 运行 `npm run check`、`npm test`、`npm run build`、`npm run spike` 和 `git diff --check`，如实记录结果。
- 不修改生产代码、依赖、锁文件或发布版本；不公开仓库、不创建 tag/Release、不进行 npm 发布。

## 允许路径与依赖授权

- `README.md`
- `doc/tasks/README.md`
- `doc/tasks/009-v01-release-readiness.md`

本任务唯一写入者为 Codex 主 Agent。任务索引仅同步本任务状态；计划文件仅在 v0.1.0 实际发布这一里程碑发生后更新。

## 输入与前置条件

- `main` 与 `origin/main` 的本地记录基线为 `fd2fb7c1f932dffb453e111e90ff0f4478cdeaa1`，开始时工作区干净。
- TASK-008 已完成；PR #18 与状态记录 PR #19 已合并，GitHub Actions Offline checks #53/#58 成功。
- 根 `package.json` 和所有 workspace package 均使用 `0.1.0`；根及各 workspace 设置 `private: true`，本任务的 Release 目标是 GitHub 源码归档，不是 npm 包。
- 根目录已有 MIT `LICENSE`；README 的 TASK-007 状态描述已过期。

## 验收标准

- [x] README 清楚说明 v0.1.0 候选包含内容、工具链、离线默认模式、在线模式费用/密钥要求和未验证限制。
- [x] 发布前源文件、可达 Git 历史和 GitHub Actions 日志完成密钥/敏感信息模式扫描，并记录局限及结果。
- [x] MIT 许可证、提交身份和 SDK 来源已检查；代码证据无法确认的所有权事项留给用户确认。
- [x] 用户要求的类型检查、测试、生产构建、spike 与差异检查均记录真实结果。
- [ ] README 变更经 PR review 和集成；此任务不切换仓库可见性、不发布 tag/Release。
- [ ] 用户确认自有代码可按 MIT 发布，并决定是否公开现有模型评测运行与成本元数据。

## 验证命令与证据

计划命令：

```bash
npm run check
npm test
npm run build
npm run spike
git diff --check
```

实施结果与审计证据在检查完成后追加；不得把正则扫描描述成对任意秘密、个人数据或权利来源的证明。

实际验证（2026-09-30；Node.js 24.21.0、npm 11.9.0）：npm 11.9.0 从本机 npm 缓存临时取出，校验缓存完整性后仅用于本轮检查，没有改变全局 npm。

- `npm run check`：通过，7/7 workspace 类型检查通过。
- `npm test`：通过，所有带测试脚本的 workspace 测试通过。沙箱内首次启动因 tsx IPC 管道返回 `EPERM`；沙箱外使用同一固定工具链重跑通过。
- `npm run build`：Web 生产构建通过。沙箱内首次运行无法解析 TypeScript `--showConfig` 输出；沙箱外同一固定工具链重跑通过。
- `npm run spike`：离线 spike 通过。沙箱内首次启动因 tsx IPC 管道返回 `EPERM`；沙箱外重跑通过。
- `git diff --check`：通过。构建生成的 `apps/web/next-env.d.ts` 已恢复；没有保留允许路径以外的变更。

## 发布前审计结果

- GitHub 仓库当前为 private；API 返回 19 个远端分支，本地远端跟踪引用也有 19 个且名称一致。扫描所有当前可达分支的 448 个 Git 对象（约 2.47 MB blob 内容）和提交消息。
- 自定义模式扫描未发现 GitHub/npm/provider token、私钥标记、JWT、真实凭据赋值或含凭据 URL。扫描器只做有限模式匹配；环境中没有安装 Gitleaks 或 TruffleHog，不能将结果称为对所有秘密的证明。
- 邮箱模式只匹配到 `packages/tools/tests/public-github-snapshot.test.ts` 中用于拒绝 user-info URL 的合成恶意 URL；没有发现真实邮箱。数字/电话启发式命中来自 SVG 坐标、版本、动作运行号、哈希和费用/Token 测试数据，复核为非电话号码。唯一提交者邮箱使用 GitHub noreply 地址。
- 19 个分支的全部 59 次 GitHub Actions 运行均为成功；已逐一检查其 job 日志中的令牌、凭据、私钥、JWT、邮箱和凭据 URL 模式，未发现命中。CI workflow 不配置真实模型凭据。
- `doc/internal/`、`.env`、运行 artifacts 和日志不在任何可达 Git 历史路径中；根 `.gitignore` 排除这些本地数据。工作区有一个被忽略且未跟踪的 `.env` 文件；未读取其内容，也不纳入本次发布内容。
- 当前文件和可达历史中的若干项目文档含有绝对本地路径 `/home/lzs/...`，可暴露本机用户名/目录结构。命中包括 `AGENTS.md`、`doc/plan.md`、`doc/multi-agent-workflow.md` 及多张旧任务卡；这些路径在当前主线和历史提交中均存在。本任务不改旧文件或重写历史，公开前需用户决定是否接受，或另开清理任务。
- 根 `LICENSE` 为 MIT，README 声明项目采用 MIT；`pi/` 参考源码没有被跟踪，PI SDK 以依赖包使用。仓库扫描不能判断是否存在雇佣关系、先前合同或其他权利限制，也没有执行完整的依赖许可证兼容性审查；公开前需代码权利人确认授权。
- [项目计划](../plan.md)和 [TASK-005 任务卡](005-public-repository.md)包含已提交的真实模型评测研究记录：provider/model 与提示版本、固定样本、运行标识、质量指标、Token 数和估算费用。它们不属于 `doc/internal/`，也不是密钥；是否作为公开研究记录披露需用户决定。此项确认前不应切换仓库为 Public。

## 决策、冲突与范围变化

- 用户要求先做 README 发布准备和发布前审计；实际切换 Public、创建 release tag 和发布 Release 仍须单独确认。
- 项目 README/许可证可以核对文本，但 Codex 无法仅凭 Git 历史判定用户是否拥有全部自有代码的开源授权权利；发布前需要权利人确认。
- 发现历史及现有项目文档暴露本地 `/home/lzs/...` 路径。本轮范围不包含旧文档脱敏或 Git 历史重写；公开前需由用户决定清理范围和处理方式。

## 交接

- 当前状态：`review`；README 与聚焦审计已完成，待 PR 审查及用户确认公开权利和研究元数据披露。
- 完成内容：校正 TASK-007/TASK-008 状态；补全 v0.1.0 README 范围与限制；审计文件、当前全部远端分支的可达历史和 Actions 日志；完成固定工具链本地检查。
- 修改路径：`README.md`、`doc/tasks/README.md`、`doc/tasks/009-v01-release-readiness.md`。
- 实际验证：见“验证命令与证据”；本地各项命令结果均已记录。
- 风险与未验证：密钥扫描是有限模式扫描；MIT 权利归属、已提交模型评测研究元数据的公开意愿、含本地 `/home/lzs/...` 路径的旧文档/历史是否清理待用户决定；没有检查未公开的本地 `.env` 内容。
- 提交 SHA / PR：待创建。
- 已停止写入：是；本轮差异已整理，等待审查和必要的用户确认。
- 下一步：创建 README 发布准备 PR；等待 PR review 与用户决定是否公开模型评测元数据，并确认 MIT 权利归属。不要在此任务内公开仓库或创建 release。
