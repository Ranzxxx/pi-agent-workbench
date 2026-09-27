import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createEvidenceRegistry, createReadOnlyRepository, type EvidenceRecord } from "@pi-workbench/tools";
import { SYNTHETIC_SNAPSHOT_ID, type ManifestArtifact, type ProtocolBoundary, type RunEventEnvelope, type StructuredReport, type Task004Artifact } from "./contracts.js";
import { loadProtocolBoundary } from "./contracts.js";
import { evaluateFixtureReport, verifyGoldenSnapshot } from "./fixture-evaluation.js";
import { renderMarkdown } from "./markdown.js";
import type { EvaluationMetrics } from "./evaluation.js";

const MAX_REPORT_BYTES = 512 * 1024;
const MAX_EVENT_COUNT = 256;

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../");
const defaultFixtureRoot = path.join(projectRoot, "fixtures", "synthetic-ts-repo");

export class OfflineRunCancelledError extends Error {
  constructor() {
    super("Offline analysis was cancelled");
    this.name = "OfflineRunCancelledError";
  }
}

export interface OfflineRunOptions {
  outputDirectory: string;
  fixtureRoot?: string;
  snapshotId?: string;
  runId?: string;
  attemptId?: string;
  signal?: AbortSignal;
  now?: () => Date;
  /** Test hook used only to prove that cancellation cannot publish a completed run. */
  beforePublish?: () => void | Promise<void>;
  protocol?: ProtocolBoundary;
}

export interface OfflineRunSummary {
  status: "completed" | "failed" | "cancelled";
  runId: string;
  attemptId: string;
  snapshotId: string;
  directory?: string;
  artifacts: Task004Artifact[];
  report?: StructuredReport;
  evaluation?: EvaluationMetrics;
  error?: string;
}

interface EvidenceSelection {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256Text(text: string): string {
  return sha256(Buffer.from(text, "utf8"));
}

function timestamp(now: () => Date): string {
  const value = now();
  if (!Number.isFinite(value.getTime())) throw new Error("Clock returned an invalid date");
  return value.toISOString();
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new OfflineRunCancelledError();
}

function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function reportClaims(evidence: EvidenceRecord[]): StructuredReport["claims"] {
  const evidenceIds = new Set(evidence.map((item) => item.id));
  const claims: StructuredReport["claims"] = [
    {
      id: "claim-identity", kind: "fact",
      text: "The package is named harborlight-service and has version 0.4.2.",
      evidenceIds: ["e-identity"],
    },
    {
      id: "claim-exports", kind: "fact",
      text: "The package entry module exports startServer and getHealth.",
      evidenceIds: ["e-exports"],
    },
    {
      id: "claim-default-port", kind: "fact",
      text: "startServer defaults its port to 4317.",
      evidenceIds: ["e-default-port"],
    },
    {
      id: "claim-health-route", kind: "fact",
      text: "The /health route returns the value produced by getHealth, whose status is ok.",
      evidenceIds: ["e-health-route", "e-health-value"],
    },
    {
      id: "claim-test-command", kind: "fact",
      text: "The package declares npm test as node --test.",
      evidenceIds: ["e-test-script"],
    },
    {
      id: "claim-bun-runtime-inference", kind: "inference",
      text: "The server calls Bun.serve, so compatibility with standard Node.js is not established by source inspection alone.",
      evidenceIds: ["e-bun-serve"],
    },
    {
      id: "claim-test-outcome-unknown", kind: "unknown",
      text: "Whether the fixture test command passes is unknown.",
      reason: "The offline workbench reads source only and never installs or executes the fixture's scripts.",
      evidenceIds: [],
    },
  ];
  if (claims.some((claim) => claim.evidenceIds.some((id) => !evidenceIds.has(id)))) throw new Error("Offline demo has a dangling evidence reference");
  return claims;
}

function createEventFactory(
  protocol: ProtocolBoundary,
  runId: string,
  attemptId: string,
  now: () => Date,
  events: RunEventEnvelope[],
): (type: string, data: Record<string, unknown>) => RunEventEnvelope {
  let sequence = 0;
  return (type, data) => {
    if (events.length >= MAX_EVENT_COUNT) throw new Error("Offline event log limit exceeded");
    const event = protocol.parseEvent({
      schemaVersion: 1,
      eventId: `event-${sequence + 1}`,
      runId,
      attemptId,
      sequence: ++sequence,
      timestamp: timestamp(now),
      type,
      data,
    });
    events.push(event);
    return event;
  };
}

function eventLog(events: RunEventEnvelope[]): string {
  return events.map((event) => JSON.stringify(event)).join("\n") + "\n";
}

async function writeAtomic(directory: string, filename: string, contents: string): Promise<void> {
  const target = path.join(directory, filename);
  const temporary = path.join(directory, `.${filename}.${randomUUID()}.tmp`);
  await writeFile(temporary, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await rename(temporary, target);
}

async function readArtifactRef<K extends Task004Artifact["kind"]>(directory: string, kind: K): Promise<Task004Artifact & { kind: K }> {
  const contents = await readFile(path.join(directory, kind));
  return { kind, path: kind, sha256: sha256(contents) } as Task004Artifact & { kind: K };
}

function reportBytes(report: StructuredReport): string {
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_REPORT_BYTES) throw new Error("Structured report exceeds the output limit");
  return serialized;
}

function checkOutputLocation(fixtureRoot: string, outputDirectory: string, runId: string): { parent: string; stage: string; final: string } {
  if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(runId)) throw new Error("Invalid run ID");
  const parent = path.resolve(outputDirectory);
  const final = path.join(parent, runId);
  const stage = path.join(parent, `.${runId}.pending`);
  if (within(fixtureRoot, final) || within(final, fixtureRoot)) throw new Error("Output and fixture paths must be separate");
  return { parent, stage, final };
}

async function ensureRealOutputDirectory(directory: string): Promise<void> {
  const absolute = path.resolve(directory);
  const parsedRoot = path.parse(absolute).root;
  if (absolute === parsedRoot) throw new Error("Output directory cannot be a filesystem root");
  const rootInfo = await lstat(parsedRoot);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() || await realpath(parsedRoot) !== parsedRoot) throw new Error("Filesystem root is not a real directory");
  let current = parsedRoot;
  for (const segment of absolute.slice(parsedRoot.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    await mkdir(current).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory() || await realpath(current) !== current) {
      throw new Error("Output path contains a symlink or non-directory component");
    }
  }
}

export async function runOfflineAnalysis(options: OfflineRunOptions): Promise<OfflineRunSummary> {
  const protocol = options.protocol ?? await loadProtocolBoundary();
  const fixtureRoot = path.resolve(options.fixtureRoot ?? defaultFixtureRoot);
  const snapshotId = options.snapshotId ?? SYNTHETIC_SNAPSHOT_ID;
  const runId = options.runId ?? `run-${randomUUID()}`;
  const attemptId = options.attemptId ?? `attempt-${randomUUID()}`;
  const paths = checkOutputLocation(fixtureRoot, options.outputDirectory, runId);
  const now = options.now ?? (() => new Date());
  const startedAt = timestamp(now);
  const events: RunEventEnvelope[] = [];
  const written = new Set<Task004Artifact["kind"]>();
  let finalPublished = false;
  let stageCreated = false;
  let repo: ReturnType<typeof createReadOnlyRepository> | undefined;
  let report: StructuredReport | undefined;
  let evaluation: EvaluationMetrics | undefined;
  let addEvent: ReturnType<typeof createEventFactory> | undefined;

  try {
    await ensureRealOutputDirectory(paths.parent);
    if (await lstat(paths.stage).then(() => true, () => false) || await lstat(paths.final).then(() => true, () => false)) throw new Error("Run output already exists");
    await mkdir(paths.stage, { mode: 0o700 });
    stageCreated = true;
    throwIfAborted(options.signal);

    repo = createReadOnlyRepository({ root: fixtureRoot, snapshotId });
    const fingerprint = await repo.fingerprint();
    await verifyGoldenSnapshot(repo);
    addEvent = createEventFactory(protocol, runId, attemptId, now, events);
    addEvent("run.started", {
      repository: { url: "https://github.com/example/harborlight-service", sha: fingerprint.syntheticEventSha },
      goal: "Offline inspection of a fictional synthetic fixture; do not access a network or execute repository commands.",
    });

    let toolSequence = 0;
    async function tool<T>(toolName: string, action: () => Promise<T>): Promise<T> {
      throwIfAborted(options.signal);
      const toolCallId = `tool-${++toolSequence}`;
      addEvent!("tool.started", { toolCallId, toolName, argumentsSummary: "omitted" });
      try {
        const value = await action();
        addEvent!("tool.finished", { toolCallId, toolName, isError: false, summary: "ok" });
        return value;
      } catch (error) {
        addEvent!("tool.finished", { toolCallId, toolName, isError: true, summary: "tool_error" });
        throw error;
      }
    }

    const listedFiles = await tool("list_files", () => repo!.listFiles());
    for (const required of ["AGENTS.md", "README.md", "package.json", "src/index.ts", "src/server.ts", "src/health.ts", "tests/health.test.ts"]) {
      if (!listedFiles.includes(required)) throw new Error("Synthetic fixture is missing a required source file");
    }
    // These files deliberately contain hostile prompt-like sentences; this code reads them as bytes/text only.
    const readme = await tool("read_file", () => repo!.readFile("README.md"));
    const agents = await tool("read_file", () => repo!.readFile("AGENTS.md"));
    if (!readme.text.includes("not an instruction") || !agents.text.includes("SYSTEM OVERRIDE")) throw new Error("Hostile fixture text was changed or is missing");

    const registry = createEvidenceRegistry(repo);
    const selections: EvidenceSelection[] = [
      { id: "e-identity", path: "package.json", startLine: 2, endLine: 3 },
      { id: "e-exports", path: "src/index.ts", startLine: 1, endLine: 2 },
      { id: "e-default-port", path: "src/server.ts", startLine: 8, endLine: 8 },
      { id: "e-health-route", path: "src/server.ts", startLine: 12, endLine: 13 },
      { id: "e-health-value", path: "src/health.ts", startLine: 1, endLine: 3 },
      { id: "e-test-script", path: "package.json", startLine: 6, endLine: 8 },
      { id: "e-bun-serve", path: "src/server.ts", startLine: 8, endLine: 10 },
    ];
    const evidence: EvidenceRecord[] = [];
    for (const selection of selections) {
      const source = await tool("read_file", () => repo!.readFile(selection.path));
      const lines = source.text.split(/\r?\n/u);
      if (selection.endLine > lines.length) throw new Error("Golden evidence range exceeds a fixture file");
      const excerpt = lines.slice(selection.startLine - 1, selection.endLine).join("\n");
      const registered = await tool("register_evidence", () => registry.register({ ...selection, excerpt }));
      evidence.push(registered);
    }
    throwIfAborted(options.signal);

    const candidate: StructuredReport = {
      schemaVersion: 1,
      runId,
      attemptId,
      snapshotId,
      title: "Harborlight service — 离线仓库分析",
      limitations: [
        "This is an offline analysis of a fictional synthetic fixture, not a live GitHub repository.",
        "The fixture was read as data only; no dependency installation, script execution, or test run was performed.",
        "Evidence hashes and source ranges establish provenance, not human-level semantic correctness.",
      ],
      evidence,
      claims: reportClaims(evidence),
    };
    // Schema, reference identity, and every real file/range/hash are checked before a Markdown report exists.
    report = protocol.parseReport(candidate);
    if (report.runId !== runId || report.attemptId !== attemptId || report.snapshotId !== snapshotId) throw new Error("Report identity mismatch");
    for (const item of report.evidence) await registry.validate(item);
    evaluation = await evaluateFixtureReport(report, repo);
    throwIfAborted(options.signal);
    const markdown = renderMarkdown(report);
    if (Buffer.byteLength(markdown, "utf8") > MAX_REPORT_BYTES) throw new Error("Markdown report exceeds the output limit");
    const json = reportBytes(report);
    await options.beforePublish?.();
    throwIfAborted(options.signal);

    await writeAtomic(paths.stage, "report.json", json);
    written.add("report.json");
    await writeAtomic(paths.stage, "report.md", markdown);
    written.add("report.md");
    const eventsText = eventLog(events);
    await writeAtomic(paths.stage, "events.jsonl", eventsText);
    written.add("events.jsonl");
    const coreArtifacts: ManifestArtifact[] = [
      await readArtifactRef(paths.stage, "report.json"),
      await readArtifactRef(paths.stage, "report.md"),
      await readArtifactRef(paths.stage, "events.jsonl"),
    ];
    const manifestValue = protocol.parseManifest({
      schemaVersion: 1,
      runId,
      attemptId,
      snapshotId,
      status: "completed",
      startedAt,
      endedAt: timestamp(now),
      artifacts: coreArtifacts,
    });
    const manifestText = `${JSON.stringify(manifestValue, null, 2)}\n`;
    const candidateArtifacts = protocol.parseArtifacts([
      ...coreArtifacts,
      { kind: "manifest.json", path: "manifest.json", sha256: sha256Text(manifestText) },
    ]);
    await writeAtomic(paths.stage, "manifest.json", manifestText);
    written.add("manifest.json");
    throwIfAborted(options.signal);
    await rename(paths.stage, paths.final);
    finalPublished = true;
    return { status: "completed", runId, attemptId, snapshotId, directory: paths.final, artifacts: candidateArtifacts, report, evaluation };
  } catch (error) {
    const status: OfflineRunSummary["status"] = options.signal?.aborted || error instanceof OfflineRunCancelledError ? "cancelled" : "failed";
    const errorSummary = status === "cancelled" ? "Offline fixture analysis was cancelled before publication" : "Offline fixture analysis failed validation or artifact publication";
    if (!finalPublished && stageCreated) {
      try {
        for (const name of await readdir(paths.stage)) {
          if (name.startsWith(".") && name.endsWith(".tmp")) await rm(path.join(paths.stage, name), { force: true });
        }
        // No terminal run.finished event is ever written to this demo log. Manifest status is the success gate.
        if (addEvent) {
          const log = eventLog(events);
          await writeAtomic(paths.stage, "events.jsonl", log).catch(async () => {
            await rm(path.join(paths.stage, "events.jsonl"), { force: true });
            await writeAtomic(paths.stage, "events.jsonl", log);
          });
          written.add("events.jsonl");
        }
        await rm(path.join(paths.stage, "manifest.json"), { force: true });
        const partialKinds = (["report.json", "report.md", "events.jsonl"] as const).filter((kind) => written.has(kind));
        const partialRefs: Array<{ kind: "report.json" | "report.md" | "events.jsonl"; path: string; sha256: string }> = [];
        for (const kind of partialKinds) partialRefs.push(await readArtifactRef(paths.stage, kind));
        const partialManifest = protocol.parseManifest({
          schemaVersion: 1,
          runId,
          attemptId,
          snapshotId,
          status,
          startedAt,
          endedAt: timestamp(now),
          artifacts: partialRefs,
        });
        await writeAtomic(paths.stage, "manifest.json", `${JSON.stringify(partialManifest, null, 2)}\n`);
        written.add("manifest.json");
        const stageInfo = await lstat(paths.stage);
        if (stageInfo.isDirectory() && !(await lstat(paths.final).then(() => true, () => false))) {
          await rename(paths.stage, paths.final);
          finalPublished = true;
        }
      } catch {
        // If even partial publication fails, return the non-completed state with no fabricated artifact references.
      }
    }
    const artifacts: Task004Artifact[] = [];
    if (finalPublished) {
      for (const kind of ["report.json", "report.md", "events.jsonl", "manifest.json"] as const) {
        if (written.has(kind)) {
          try { artifacts.push(await readArtifactRef(paths.final, kind)); } catch { /* partial files may be absent */ }
        }
      }
      try {
        if (artifacts.length > 0) protocol.parseArtifacts(artifacts);
      } catch {
        artifacts.length = 0;
      }
    }
    return { status, runId, attemptId, snapshotId, ...(finalPublished ? { directory: paths.final } : {}), artifacts, ...(report ? { report } : {}), ...(evaluation ? { evaluation } : {}), error: errorSummary };
  }
}

export function offlineDefaults(): { fixtureRoot: string; outputDirectory: string } {
  return {
    fixtureRoot: defaultFixtureRoot,
    outputDirectory: path.join(projectRoot, "artifacts", "TASK-004"),
  };
}
