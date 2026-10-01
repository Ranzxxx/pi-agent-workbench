import * as React from "react";
import type { WorkbenchRun } from "@pi-workbench/protocol";

/** Show every artifact the API registered, including logs from failed runs. */
export function RunArtifacts({ run }: { run: WorkbenchRun }) {
  const artifacts = run.result?.artifacts;
  if (!artifacts?.length) return null;
  return <div className="artifact-list" aria-label="运行产物">{artifacts.map((artifact) =>
    <a className="artifact-link" key={artifact.kind} href={`/api/v2/runs/${encodeURIComponent(run.runId)}/artifacts/${encodeURIComponent(artifact.kind)}`} target="_blank" rel="noreferrer">查看产物 · {artifact.kind}</a>
  )}</div>;
}
