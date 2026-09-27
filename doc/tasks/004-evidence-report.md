# TASK-004：合成仓库的证据与报告闭环

## 元数据

- 状态：`review`
- 负责人：Codex 主 Agent（协议、集成、监督与验收）；subagent 实现已交付
- 分支或 worktree：集成 checkout `task/004-evidence-report`（`/home/lzs/Projects/pi`）；实现 checkout `codex/task004-implementation`（`/tmp/pi-task004-worker`）
- 基线提交：`0484e12ead35a0b2265ee91d6d7a478d45e2edfb`
- 依赖任务：TASK-003
- 提交/推送授权：用户于 2026-09-27 明确授权本地提交；推送和合并未授权。
- 在线模型授权：无

## 目标与非目标

使用项目自有合成 TypeScript 仓库，在完全离线环境完成读取/检索 → 证据登记 → report.json 校验 → Markdown 与 manifest 生成。不接 GitHub 网络，不安装或执行 fixture 中的程序，不建设通用 RAG 或 Web。

## 允许路径与依赖授权

- `packages/tools/**`、`packages/reporting/**`。
- `packages/protocol/**`（集成者指定本卡唯一所有者，落实报告/证据 schema）。
- `evals/**`、`fixtures/**`（仅本项目原创合成数据，不存真实运行日志）。
- 根 package.json、锁文件仅允许登记新增 workspace；优先复用现有依赖，不新增第三方依赖。
- README、本任务卡与任务索引。

## 验收标准

- [x] 合成 fixture 的内容、快照标识及人工事实清单固定，可重复使用。
- [x] 只读工具只接受根目录内的相对路径，限制读取/结果大小，拒绝逃逸、符号链接和特殊文件。
- [x] AGENTS.md、README 中的恶意指令作为待分析数据，不改变工具或资源权限。
- [x] 证据绑定快照、路径、行号与摘录，越界行号、错误 SHA、缺失路径不能通过。
- [x] report.json 通过 schema 和引用检查后才生成 Markdown，两种报告事实一致。
- [x] 区分事实/推断/未知；fixture 仅提供测试脚本时不能声称测试已执行。
- [x] 事实清单预先人工维护，分别输出事实召回、引用有效、证据支持和无证据断言指标；语义人工评分有说明。
- [x] 失败或取消保存部分产物但不标记 completed；成功保存 `report.json`、`report.md`、`manifest.json`、`events.jsonl` 四类产物。
- [x] CLI 演示从 fixture 到报告，不依赖网络或 API Key。

## 固定离线数据

- 合成仓库：`fixtures/synthetic-ts-repo/`（Harborlight service；含原创 TypeScript 源码、测试声明及恶意 README/AGENTS 文本）。
- 人工必答事实清单：`evals/golden-facts.json`，启动评测前校验其固定 tree SHA-256。
- 人工语义标注：`evals/offline-demo-annotations.json`；分数只描述本 fixture，不代表真实仓库质量。
- 成功 manifest 的 artifacts 列出 report.json、report.md、events.jsonl；manifest 不列出自身，避免自引用哈希。运行结果仍引用四类产物。

## 实测结果

- Node.js `24.21.0`、npm `11.9.0`；使用临时 npm 启动器绕开主机 Snap npm 与 sandbox IPC 限制，未更改系统 Node/npm。
- `npm run check`：通过，所有 5 个 workspace 类型检查通过。
- `npm test`：通过，protocol 7/7、agent-runtime 14/14、tools 5/5、reporting 9/9、SDK spike 5/5，共 40 项通过。
- 2026-09-27 复核：`npm run check` 再次通过。当前沙箱运行 `npm test` 时，`tsx` 因无法创建 `/tmp/tsx-1000/*.pipe` IPC socket 而未启动测试；使用 `/tmp/pi-node24/bin/node --import tsx --test packages/protocol/tests/*.test.ts packages/agent-runtime/tests/*.test.ts packages/tools/tests/*.test.ts packages/reporting/tests/*.test.ts spikes/pi-sdk/tests/*.test.ts` 直接运行同一组测试入口，10 个测试文件全部通过。
- 2026-09-27 复核：使用 `/tmp/pi-node24/bin/node --import tsx packages/reporting/src/cli.ts` 执行离线演示成功；生成四类产物，事实召回 5/5、引用有效 7/7、人工支持 6/6、无依据断言 0。
- `npm run demo:offline`：成功；输出写入被忽略的 `artifacts/TASK-004/run-0f10a005-29f5-4686-8e87-f9a033097aa8/`。
- 输出目录恰有四个文件。manifest 状态为 completed，引用 report.json、report.md、events.jsonl；逐个重新计算并核对三者 SHA-256 均匹配，CLI 结果也包含 manifest 自身 SHA-256。
- `git diff --check`：通过。Golden tree SHA-256 在运行时与预置值核对；离线报告的五个事实召回、7/7 引用有效、6/6 人工支持、0 个无依据断言仅描述这个合成样例。

## 交接

- 完成内容：subagent 在独立 worktree 实现只读仓库工具、证据登记、原创 fixture、人工 golden facts/语义标注、报告/Markdown/manifest/事件日志、离线 CLI 和单元/端到端测试；未运行本地测试、未提交。主 Agent 维护 protocol schema、根 workspace 与 lock，集成实现后独立检查并运行全套类型检查、测试、离线 CLI 和四产物摘要核验；修复了测试断言问题，并让事实召回必须由引用覆盖 golden 源码范围。
- 修改文件：`packages/protocol/**`、`packages/tools/**`、`packages/reporting/**`、`fixtures/synthetic-ts-repo/**`、`evals/**`、根 `package.json` / `package-lock.json` / `README.md`、本任务卡及任务索引。
- 未完成项：本地提交后仍需用户按 Git 流程推送并合并到 main；在集成完成前任务状态保持 review。
- 风险：证据位置与摘要有效不自动证明语义正确；语义支持由人工标注；分数不代表真实 GitHub 仓库质量。该演示不访问 GitHub、不使用模型/API Key，也不安装或执行 fixture 程序。
- 提交 SHA：`ebd1a2b869e76d23ad51ff9fc538f538a9deaa2d`（本地功能提交）。
- 下一步：由用户决定是否推送并合并；集成完成且确认验收后再改为 done。
