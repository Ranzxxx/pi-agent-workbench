# TASK-009：v0.1.0 开源发布准备

## 元数据

- 状态：`done`
- 负责人：Codex 主 Agent
- 分支或 worktree：`codex/task-009-v01-release-readiness`，仓库根目录的独占 checkout
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
- 在当前跟踪文件中删除本机绝对 home 路径，改用仓库相对路径或通用工作区描述；按用户选择保留已有 Git 历史。
- 不修改生产代码、依赖、锁文件或发布版本；不公开仓库、不创建 tag/Release、不进行 npm 发布。

## 允许路径与依赖授权

- `README.md`
- `AGENTS.md`
- `doc/plan.md`
- `doc/tasks/001-pi-sdk-spike.md`
- `doc/tasks/002-review-hardening.md`
- `doc/tasks/003-project-foundation.md`
- `doc/tasks/005-public-repository.md`
- `doc/tasks/007-v01-review-fixes.md`
- `doc/tasks/008-v01-closeout.md`
- `doc/tasks/README.md`
- `doc/tasks/009-v01-release-readiness.md`

本任务唯一写入者为 Codex 主 Agent。用户于 2026-09-30 将范围扩展为清理当前跟踪文件中的本机绝对路径，并确认保留已推送历史；完整模型评测记录按用户选择保留公开。计划文件只做路径脱敏，不更新里程碑。

## 输入与前置条件

- `main` 与 `origin/main` 的本地记录基线为 `fd2fb7c1f932dffb453e111e90ff0f4478cdeaa1`，开始时工作区干净。
- TASK-008 已完成；PR #18 与状态记录 PR #19 已合并，GitHub Actions Offline checks #53/#58 成功。
- 根 `package.json` 和所有 workspace package 均使用 `0.1.0`；根及各 workspace 设置 `private: true`，本任务的 Release 目标是 GitHub 源码归档，不是 npm 包。
- 根目录已有 MIT `LICENSE`；README 的 TASK-007 状态描述已过期。

## 验收标准

- [x] README 清楚说明 v0.1.0 候选包含内容、工具链、离线默认模式、在线模式费用/密钥要求和未验证限制。
- [x] 发布前源文件、可达 Git 历史和 GitHub Actions 日志完成密钥/敏感信息模式扫描，并记录局限及结果。
- [x] MIT 许可证、提交身份和 SDK 来源已检查；用户已确认自有代码均有权按 MIT 发布。
- [x] 用户要求的类型检查、测试、生产构建、spike 与差异检查均记录真实结果。
- [x] 当前跟踪文件中的本机绝对路径已替换为仓库相对或通用描述；旧 Git 历史按用户决定保留。
- [x] PR #20 已合并至 `main`（merge commit `2c1145ebf211981745198d0e20c27ec0a57d511b`）；此任务未切换仓库可见性、未发布 tag/Release。
- [x] 用户确认公开完整模型评测记录；计划和 TASK-005 中现有完整记录予以保留。

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
- 工作树 home-path 扫描：无命中（退出码 1 表示未匹配）；该检查不扫描 Git 历史，历史路径按用户决定保留。

## 发布前审计结果

- GitHub 仓库当前为 private；打开 PR 前有 19 个远端分支，PR #20 创建后为 20 个，本地远端跟踪引用与 GitHub 分支名一致。最新本地快照有 461 个可达 Git 对象（约 2.41 MB blob 内容）。
- 自定义模式扫描未发现 GitHub/npm/provider token、私钥标记、JWT、真实凭据赋值或含凭据 URL。扫描器只做有限模式匹配；环境中没有安装 Gitleaks 或 TruffleHog，不能将结果称为对所有秘密的证明。
- 邮箱模式只匹配到 `packages/tools/tests/public-github-snapshot.test.ts` 中用于拒绝 user-info URL 的合成恶意 URL；没有发现真实邮箱。数字/电话启发式命中来自 SVG 坐标、版本、动作运行号、哈希和费用/Token 测试数据，复核为非电话号码。唯一提交者邮箱使用 GitHub noreply 地址。
- PR 创建前取得的 59 次 GitHub Actions 运行均为成功，已逐一检查其 job 日志中的令牌、凭据、私钥、JWT、邮箱和凭据 URL 模式，未发现命中。PR checks #61/#63/#65/#67 在先前 PR head 上通过，日志扫描也无上述模式命中。PR 文档补充提交 `015d72240899c3a3bceafc401a0f838372f9f812` 未返回新的 PR workflow；合并提交的 combined status 也为空。push 触发的 PR 分支日志未能通过当前 GitHub Actions 接口单独取得，故不声称覆盖这些新增日志。CI workflow 不配置真实模型凭据。
- `doc/internal/`、`.env`、运行 artifacts 和日志不在任何可达 Git 历史路径中；根 `.gitignore` 排除这些本地数据。工作区有一个被忽略且未跟踪的 `.env` 文件；未读取其内容，也不纳入本次发布内容。
- 已在 9 个当前跟踪文件中定位本机绝对 home 路径，并替换为仓库相对路径或通用工作区描述。当前工作树 `rg` 扫描无此类路径命中。按用户选择不改写历史；旧提交和未更新的既有远端分支仍含这些路径，修改合并后旧提交也继续可达。
- 根 `LICENSE` 为 MIT，README 声明项目采用 MIT；`pi/` 参考源码没有被跟踪，PI SDK 以依赖包使用。用户已确认自有代码均有权按 MIT 发布。检查了当前 7 个正式 workspace/spike 清单中声明的外部直接生产依赖：其锁定版本在 lock metadata 中均标为 MIT。根及 workspace 均为 `private: true`，本仓库分发的是源码归档；`git ls-files` 未发现 `node_modules/`、`dist/`、`.next/` 或 `pi/` 内容，因此发布归档本身不打包 npm 依赖源码。
- 依赖安装仍会按 `package-lock.json` 拉取第三方包，第三方许可证不由根 MIT 覆盖。当前锁文件中，`next@16.3.6` 声明可选依赖 `sharp@0.35.5`；Sharp 的可选平台条目涉及 10 个 `LGPL-3.0-or-later` 元数据项、3 个 `Apache-2.0 AND LGPL-3.0-or-later` 项和 1 个 `Apache-2.0 AND LGPL-3.0-or-later AND MIT` 项，另有 `caniuse-lite@1.0.30001812` 的 `CC-BY-4.0` 元数据。七个本地 workspace package 的清单未声明 `license` 字段（lock 中因 workspace 链接表示重复为 14 项）；`README` 和仓库根 LICENSE 表明的是项目自身 MIT 声明。以上是锁文件和已安装 package metadata 的盘点，未逐一核对每个归档中的完整许可证文本、通知要求、兼容性或发布后二进制再分发义务；不能仅凭 SPDX 字段得出法律结论。
- [项目计划](../plan.md)和 [TASK-005 任务卡](005-public-repository.md)包含真实模型评测研究记录：provider/model 与提示版本、固定样本、运行标识、质量指标、Token 数和估算费用。用户已明确选择公开完整记录；相关内容保留，其中固定单样本结果不应表述为跨仓库泛化保证。

## 决策、冲突与范围变化

- 用户要求先做 README 发布准备和发布前审计；实际切换 Public、创建 release tag 和发布 Release 仍须单独确认。
- 用户于 2026-09-30 确认拥有全部自有代码按 MIT 发布的权利，并选择公开完整模型评测记录。
- 用户选择只清理当前跟踪文件、不改写 Git 历史。该选择避免全面改写造成多分支提交 SHA 变化，并接受旧提交仍含本机绝对路径。

## 交接

- 当前状态：`done`；PR #20 已由用户合并至 `main`，合并提交为 `2c1145ebf211981745198d0e20c27ec0a57d511b`。
- 完成内容：校正 TASK-007/TASK-008 状态；补全 v0.1.0 README 范围与限制；审计文件、当前全部远端分支的可达历史和 Actions 日志；完成固定工具链本地检查和依赖许可证元数据盘点；PR #20 已集成。
- 修改路径：README、项目协作指引、计划、旧任务卡和任务索引；具体允许路径见本卡范围清单。
- 实际验证：见“验证命令与证据”；本地各项命令结果均已记录。
- 风险与未验证：密钥扫描是有限模式扫描；新增 push 触发的 Actions 日志未直接检查；依赖许可证盘点只核对锁文件及已安装 package metadata，未完成逐包许可证文本、通知和再分发兼容性审查；旧 Git 历史继续包含本机绝对路径；没有检查未公开的本地 `.env` 内容。
- 提交 SHA / PR：初始文档提交 `a9a37e4a457381106aa8704f06b86dc77f8fd6c7`；依赖盘点提交 `015d72240899c3a3bceafc401a0f838372f9f812`；[PR #20](https://github.com/Ranzxxx/pi-agent-workbench/pull/20) 已于 2026-09-30 合并，merge commit `2c1145ebf211981745198d0e20c27ec0a57d511b`。
- 已停止写入：是；TASK-009 文档准备和发布前审计已合并。
- 下一步：单独完成 v0.1.0 的标签与 GitHub Release、公开前检查和仓库可见性变更；若未来随应用分发构建产物或依赖，再针对实际分发内容完成逐包许可证文本与通知审查。
