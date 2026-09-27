import type { StructuredReport } from "./contracts.js";

function escapeText(text: string): string {
  return text
    .replace(/\r?\n/gu, " ")
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/[\\`*_{}\[\]()#+.!|]/gu, "\\$&");
}

function code(text: string): string {
  const source = text.replace(/\r?\n/gu, " ↵ ");
  const longest = Math.max(0, ...Array.from(source.matchAll(/`+/gu), (match) => match[0].length));
  const fence = "`".repeat(longest + 1);
  const padding = source.startsWith("`") || source.endsWith("`") ? " " : "";
  return `${fence}${padding}${source}${padding}${fence}`;
}

const label: Record<StructuredReport["claims"][number]["kind"], string> = {
  fact: "事实",
  inference: "推断",
  unknown: "未知",
};

export function renderMarkdown(report: StructuredReport): string {
  const lines = [
    `# ${escapeText(report.title)}`,
    "",
    `- Snapshot: ${code(report.snapshotId)}`,
    `- Run: ${code(report.runId)} / ${code(report.attemptId)}`,
    "",
    "## 结论",
    "",
  ];
  for (const claim of report.claims) {
    lines.push(`### ${label[claim.kind]}：${escapeText(claim.text)}`, "");
    if (claim.kind === "unknown") lines.push(`原因：${escapeText(claim.reason ?? "未提供原因")}`, "");
    if (claim.evidenceIds.length > 0) {
      for (const evidenceId of claim.evidenceIds) {
        const evidence = report.evidence.find((item) => item.id === evidenceId);
        if (!evidence) throw new Error("Cannot render a report with a missing evidence reference");
        lines.push(`- 证据 ${code(evidence.id)}：${code(`${evidence.path}#L${evidence.startLine}-L${evidence.endLine}`)}`);
        lines.push(`  摘录：${code(evidence.excerpt)}`);
      }
      lines.push("");
    }
  }
  lines.push("## 范围与限制", "");
  for (const limitation of report.limitations) lines.push(`- ${escapeText(limitation)}`);
  lines.push("");
  return lines.join("\n");
}
