import type { Artifact, Manifest, Report, RunEvent } from "@pi-workbench/protocol";

export const SYNTHETIC_SNAPSHOT_ID = "synthetic-harborlight-v1";

export type StructuredReport = Report;
export type ReportClaim = Report["claims"][number];
export type ManifestArtifact = Manifest["artifacts"][number];
export type RunManifest = Manifest;
export type Task004Artifact = Artifact;
export type Task004ArtifactKind = Artifact["kind"];
export type RunEventEnvelope = RunEvent;

export interface ProtocolBoundary {
  parseReport(value: unknown): Report;
  parseManifest(value: unknown): Manifest;
  parseEvent(value: unknown): RunEvent;
  parseArtifacts(value: unknown): Artifact[];
}

/** Load the shared schema implementation and fail closed if this workspace is not integrated. */
export async function loadProtocolBoundary(): Promise<ProtocolBoundary> {
  const module = await import("@pi-workbench/protocol");
  const candidate = module as unknown as Partial<ProtocolBoundary>;
  for (const exportName of ["parseReport", "parseManifest", "parseEvent", "parseArtifacts"] as const) {
    if (typeof candidate[exportName] !== "function") throw new Error(`Protocol export ${exportName} is required for TASK-004`);
  }
  return candidate as unknown as ProtocolBoundary;
}
