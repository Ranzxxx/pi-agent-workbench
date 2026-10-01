import { parse, RepositoryAnalysisInputSchema, type CancelReason, type CapabilityInfo, type RepositoryAnalysisInput } from "@pi-workbench/protocol";
import type { PublicAnalysisSummary } from "@pi-workbench/reporting";

export const publicRepositoryCapability: CapabilityInfo = {
  id: "public_repository_analysis",
  name: "仓库分析",
  description: "只读分析一个公开 GitHub 仓库，固定解析后的提交并生成带行号和 SHA 的证据报告。不会安装或执行目标仓库代码。",
  inputs: [
    { id: "repositoryUrl", label: "公开 GitHub 仓库", required: true, description: "填写仓库 HTTPS 地址。", control: "text", maxLength: 512 },
    { id: "ref", label: "分支、标签或提交", required: false, description: "可选；留空时分析默认分支的当前提交。", control: "text", maxLength: 256 },
    { id: "goal", label: "分析目标", required: true, description: "描述希望重点了解的内容。", control: "textarea", maxLength: 8000 },
  ],
};

export interface RepositoryAnalysisContext {
  signal: AbortSignal;
  onEvent: (event:
    | { type: "tool.started" | "tool.finished"; toolCallId: string; toolName: string; isError?: boolean }
    | { type: "run.cancelling"; reason: CancelReason }
    | { type: "run.warning"; code: "cancellation_pending" }
  ) => void;
}

export type RepositoryAnalysisOutput = PublicAnalysisSummary;

export type RepositoryAnalysisHandler = (input: RepositoryAnalysisInput, context: RepositoryAnalysisContext) => Promise<RepositoryAnalysisOutput>;

/** A closed registry: request content can select a registered ID, never provide executable behavior. */
export function createCapabilityRegistry(repositoryAnalysis: RepositoryAnalysisHandler) {
  const handlers = new Map<string, RepositoryAnalysisHandler>([[publicRepositoryCapability.id, repositoryAnalysis]]);
  return {
    list(): CapabilityInfo[] { return [structuredClone(publicRepositoryCapability)]; },
    async invoke(capabilityId: string, input: unknown, context: RepositoryAnalysisContext): Promise<RepositoryAnalysisOutput> {
      const handler = handlers.get(capabilityId);
      if (!handler) throw new Error("Unsupported capability");
      const validated = structuredClone(parse(RepositoryAnalysisInputSchema, input));
      return handler(validated, context);
    },
  };
}
