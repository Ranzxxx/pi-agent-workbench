import path from "node:path";
import { PublicAnalysisCancelledError, runPublicRepositoryAnalysis } from "@pi-workbench/reporting";
import { openStorage } from "@pi-workbench/storage";
import {
  CapabilityCancelledError,
  CapabilityRegistryError,
  publicRepositoryCapability,
  type CapabilityContext,
  type CapabilityDefinition,
} from "./registry.js";
import {
  createFakeRepositoryAnalysisConfiguration, createFakeSnapshotFetch, createOnlineConfiguration,
  type WorkbenchMode,
} from "./model-config.js";

const FAKE_REPOSITORY_URL = "https://github.com/demo/harborlight";
const FAKE_REPOSITORY_SHA = "7f06c6b2792349e4d9ccbd393008e5bf1f4d419a";

export interface PublicRepositoryExtensionOptions {
  mode: WorkbenchMode;
  dataDirectory: string;
  fixtureRoot: string;
  apiKey?: string;
  githubToken?: string;
}

function isFakeRepository(urlValue: string): boolean {
  try {
    const url = new URL(urlValue);
    const parts = url.pathname.match(/^\/([^/]+)\/([^/]+)\/?$/u);
    return url.protocol === "https:" && url.hostname === "github.com" && !url.port && !url.username && !url.password && !url.search && !url.hash &&
      parts?.[1]?.toLowerCase() === "demo" && parts[2]?.replace(/\.git$/iu, "").toLowerCase() === "harborlight";
  } catch { return false; }
}

function emitAnalysisEvents(context: CapabilityContext) {
  return {
    onEvent(event: import("@pi-workbench/protocol").RunEvent) {
      if (event.type === "tool.started") void context.emit({ type: "tool.started", toolCallId: event.data.toolCallId, toolName: event.data.toolName });
      else if (event.type === "tool.finished") void context.emit({ type: "tool.finished", toolCallId: event.data.toolCallId, toolName: event.data.toolName, isError: event.data.isError });
      else if (event.type === "run.cancelling") void context.emit({ type: "run.cancelling", reason: event.data.reason });
      else if (event.type === "run.warning") void context.emit({ type: "run.warning", code: event.data.code });
    },
    onWorkflowProgress(event: Parameters<NonNullable<Parameters<typeof runPublicRepositoryAnalysis>[0]["onWorkflowProgress"]>>[0]) {
      if (event.type === "workflow_progress") void context.emit({ type: "progress", phase: event.data.phase, message: event.data.message });
      else if (event.type === "checkpoint_saved") void context.emit({ type: "checkpoint_saved", phase: event.data.phase, checkpointId: event.data.checkpointId });
      else void context.emit({ type: "runtime_status", phase: "compaction", state: event.data.state, compactionReason: event.data.reason });
    },
  };
}

export function createPublicRepositoryAnalysisExtension(options: PublicRepositoryExtensionOptions): CapabilityDefinition {
  return {
    manifest: publicRepositoryCapability,
    enabledByDefault: true,
    defaultConfig: {},
    async execute(input, context) {
      const repositoryUrl = String(input.repositoryUrl ?? "");
      const requestedRef = typeof input.ref === "string" ? input.ref : undefined;
      const goal = context.prompt.trim() || (typeof input.goal === "string" ? input.goal.trim() : "");
      if (!goal) throw new CapabilityRegistryError("extension_invalid_input", "请在输入框中填写本次仓库分析目标。");
      if (options.mode === "fake" && (!isFakeRepository(repositoryUrl) || (requestedRef !== undefined && requestedRef !== "main" && requestedRef !== FAKE_REPOSITORY_SHA))) {
        throw new CapabilityRegistryError("extension_invalid_input", `离线演示仅支持合成仓库 ${FAKE_REPOSITORY_URL}（main 或固定演示 SHA）。`);
      }
      const configuration = options.mode === "online"
        ? await createOnlineConfiguration(options.apiKey ?? "")
        : await createFakeRepositoryAnalysisConfiguration(options.fixtureRoot, FAKE_REPOSITORY_SHA);
      const workflowStorage = openStorage({ dataDirectory: { dataDirectory: path.resolve(options.dataDirectory) } });
      try {
        let summary;
        try {
          summary = await runPublicRepositoryAnalysis({
            repository: { url: repositoryUrl, ...(requestedRef ? { ref: requestedRef } : {}) },
            questions: [{ id: "analysis_goal", question: goal }],
            cacheDirectory: path.join(options.dataDirectory, "cache"), outputDirectory: path.join(options.dataDirectory, "runs"),
            credentials: configuration.credentials, provider: configuration.provider, model: configuration.model,
            budget: context.budget, pricing: configuration.pricing,
            runId: context.runId, attemptId: context.attemptId,
            initialUsage: context.initialUsage, initialUsageComplete: context.initialUsageComplete,
            workflowDirectory: path.join(options.dataDirectory, "workflows", context.runId),
            checkpointStore: {
              list: (runId) => workflowStorage.checkpoints.list(runId),
              create: (record) => workflowStorage.checkpoints.create(record),
            },
            ...(options.mode === "online" && options.githubToken ? { githubToken: options.githubToken } : {}),
            ...(options.mode === "fake" ? { fetch: await createFakeSnapshotFetch({ repositoryRoot: options.fixtureRoot, sha: FAKE_REPOSITORY_SHA }) } : {}),
            signal: context.signal,
            ...emitAnalysisEvents(context),
          });
        } catch (error) {
          if (error instanceof PublicAnalysisCancelledError) throw new CapabilityCancelledError(error.reason, error.usage, error.usageComplete);
          throw error;
        }
        if (summary.result.status === "cancelled") throw new CapabilityCancelledError(summary.result.reason, summary.result.usage, summary.usageComplete);
        if (summary.status !== "completed" || !summary.report) throw new Error("仓库分析工作流未完成，未发布成功结果。");
        const claims = summary.report.claims.slice(0, 32).map((claim) => ({ kind: claim.kind, text: claim.text.slice(0, 1000) }));
        const summaryText = `已完成固定提交 ${summary.snapshot.sha} 的只读仓库分析。共收集 ${summary.report.evidence.length} 条证据和 ${claims.length} 条结论。`;
        const artifacts = summary.directory ? summary.artifacts.map((artifact) => ({
          kind: artifact.kind, path: path.resolve(summary.directory!, artifact.kind), sha256: artifact.sha256,
        })) : [];
        return {
          title: summary.report.title.slice(0, 256), summary: summaryText,
          reply: `${summary.report.title}\n${summaryText}\n${claims.length} 条结论及报告产物已加入本次运行，可继续追问。`,
          output: { snapshotSha: summary.snapshot.sha, evidenceCount: summary.report.evidence.length, claims },
          artifacts,
          usage: summary.result.usage,
          usageComplete: summary.usageComplete,
        };
      } finally { workflowStorage.close(); }
    },
  };
}
