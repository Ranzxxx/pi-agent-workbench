import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { openStorage, resolveDatabasePath } from "@pi-workbench/storage";
import { createWorkbenchService } from "../src/coordinator.js";

const fixtureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../fixtures/synthetic-ts-repo");
const productionWorker = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../apps/worker/src/main.ts");
const beforeCallWorker = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures/usage-safety-worker.ts");
const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitFor<T>(probe: () => T | undefined, message: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = probe();
    if (result !== undefined) return result;
    await pause(2);
  }
  throw new Error(message);
}

async function setupService(workerEntryPath: string) {
  const parent = await mkdtemp(path.join(os.tmpdir(), "pi-usage-safety-worker-"));
  const dataDirectory = path.join(parent, "state");
  const service = await createWorkbenchService({ mode: "fake", dataDirectory, fixtureRoot, workerEntryPath });
  const storage = openStorage({ path: resolveDatabasePath({ dataDirectory }) });
  return { parent, dataDirectory, service, storage };
}

async function waitForTerminal(service: Awaited<ReturnType<typeof createWorkbenchService>>, runId: string) {
  return waitFor(() => {
    const run = service.getRunV2(runId);
    return ["completed", "failed", "cancelled", "interrupted"].includes(run.status) ? run : undefined;
  }, `Run ${runId} did not reach a terminal state`);
}

test("kill before the provider call preserves the zero-usage checkpoint and permits continuation", { timeout: 60_000 }, async (t) => {
  const context = await setupService(beforeCallWorker);
  t.after(async () => {
    await context.service.close().catch(() => undefined);
    context.storage.close();
    await rm(context.parent, { recursive: true, force: true });
  });
  const conversation = context.service.createConversationV2();
  const submitted = context.service.submitV2(conversation.conversationId,
    { kind: "message", text: "[[test:before-call]] continue safely after this injected pre-call crash" }, randomUUID());
  const runId = submitted.run.runId;
  const firstAttempt = await waitFor(() => {
    const attempt = context.storage.attempts.list(runId).at(-1);
    const safety = attempt && context.storage.attemptSafety.get(attempt.attemptId);
    const usage = attempt && context.storage.usage.get(attempt.attemptId);
    return attempt?.status === "running" && safety?.state === "safe" && safety.checkpointKind === "pre_call" && usage?.modelCalls === 0
      ? { attempt, safety, usage } : undefined;
  }, "Coordinator did not durably establish its pre-call checkpoint");
  await waitFor(() => existsSync(path.join(context.dataDirectory, "usage-safety-before-call-paused")) ? true : undefined,
    "First Worker did not enter the pre-call pause before kill injection");
  const identity = context.storage.workerIdentity.get();
  assert.ok(identity);
  process.kill(identity.pid, "SIGKILL");

  const interrupted = await waitForTerminal(context.service, runId).catch((error: unknown) => {
    throw new Error(`${String(error)}; run=${JSON.stringify(context.service.getRunV2(runId))}; identity=${JSON.stringify(context.storage.workerIdentity.get())}; attempts=${JSON.stringify(context.storage.attempts.list(runId))}; safety=${JSON.stringify(context.storage.attemptSafety.get(firstAttempt.attempt.attemptId))}`);
  });
  assert.equal(interrupted.status, "interrupted");
  assert.equal(context.storage.attempts.get(firstAttempt.attempt.attemptId)?.usageComplete, true);
  assert.equal(context.storage.attemptSafety.get(firstAttempt.attempt.attemptId)?.checkpointKind, "pre_call");
  assert.equal(context.storage.usage.get(firstAttempt.attempt.attemptId)?.modelCalls, 0);

  await waitFor(() => context.service.workerReady ? true : undefined, "Coordinator did not replace the killed Worker");
  const continued = context.service.continueV2(runId, randomUUID());
  assert.equal(continued.run.status, "running");
  const completed = await waitForTerminal(context.service, runId).catch((error: unknown) => {
    throw new Error(`${String(error)}; run=${JSON.stringify(context.service.getRunV2(runId))}; identity=${JSON.stringify(context.storage.workerIdentity.get())}; attempts=${JSON.stringify(context.storage.attempts.list(runId))}; safety=${JSON.stringify(context.storage.attempts.list(runId).map((attempt) => context.storage.attemptSafety.get(attempt.attemptId)))}; usage=${JSON.stringify(context.storage.attempts.list(runId).map((attempt) => context.storage.usage.get(attempt.attemptId)))}`);
  });
  assert.equal(completed.status, "completed", JSON.stringify(completed));
  const attempts = context.storage.attempts.list(runId);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0]?.status, "interrupted");
  assert.equal(attempts[1]?.status, "completed");
  assert.equal(context.storage.usage.get(attempts[0]!.attemptId)?.modelCalls, 0);
  assert.equal(context.storage.usage.get(attempts[1]!.attemptId)?.modelCalls, 1);
});

test("a committed file operation blocks safe continuation without a new attempt or repeated write", { timeout: 60_000 }, async (t) => {
  const context = await setupService(beforeCallWorker);
  t.after(async () => {
    await context.service.close().catch(() => undefined);
    context.storage.close();
    await rm(context.parent, { recursive: true, force: true });
  });

  const projectRoot = path.join(context.parent, "project");
  await mkdir(projectRoot);
  const rootInfo = await lstat(projectRoot);
  const projectId = randomUUID();
  context.storage.projects.create({
    id: projectId, displayName: "Continuation guard", canonicalRoot: projectRoot,
    directoryIdentity: `${rootInfo.dev}:${rootInfo.ino}`, validationState: "valid",
  });
  const conversationId = randomUUID();
  context.storage.conversations.create({ id: conversationId, projectId, piSessionId: null, title: "Continuation guard" });
  const committedText = "already committed\n";
  const committedPath = path.join(projectRoot, "notes.txt");
  await writeFile(committedPath, committedText, "utf8");

  const submitted = context.service.submitV2(conversationId,
    { kind: "message", text: "[[test:before-call]] this turn must not repeat after its earlier file write" }, randomUUID());
  const runId = submitted.run.runId;
  const firstAttempt = await waitFor(() => {
    const attempt = context.storage.attempts.list(runId).at(-1);
    const safety = attempt && context.storage.attemptSafety.get(attempt.attemptId);
    return attempt?.status === "running" && safety?.state === "safe" && safety.checkpointKind === "pre_call"
      ? attempt : undefined;
  }, "Coordinator did not establish the safe pre-call checkpoint");
  await waitFor(() => existsSync(path.join(context.dataDirectory, "usage-safety-before-call-paused")) ? true : undefined,
    "First Worker did not enter the pre-call pause before kill injection");
  const changeset = context.storage.fileChangesets.ensureForRun({ id: randomUUID(), conversationId, projectId, runId });
  const digest = createHash("sha256").update(committedText).digest("hex");
  const fileInfo = await lstat(committedPath);
  const operation = context.storage.fileOperations.prepare({
    id: randomUUID(), changesetId: changeset.id, relativePath: "notes.txt", kind: "create",
    preVersion: null, preHash: null, expectedPostHash: digest, backupSha256: null, resultSha256: null,
  });
  context.storage.fileOperations.applied(operation.id, `${fileInfo.dev}:${fileInfo.ino}`, digest);
  assert.equal(context.storage.fileOperations.hasRunOperations(runId), true);

  const identity = context.storage.workerIdentity.get();
  assert.ok(identity);
  process.kill(identity.pid, "SIGKILL");
  const interrupted = await waitForTerminal(context.service, runId);
  assert.equal(interrupted.status, "interrupted");
  assert.equal(context.storage.attempts.get(firstAttempt.attemptId)?.usageComplete, true);
  await waitFor(() => context.service.workerReady ? true : undefined, "Coordinator did not replace the killed Worker");

  assert.throws(() => context.service.continueV2(runId, randomUUID()), (error: unknown) =>
    typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === 409);
  assert.equal(context.storage.attempts.list(runId).length, 1, "file-operation guard must reject before creating another attempt");
  assert.equal(await readFile(committedPath, "utf8"), committedText, "file content must remain unchanged after rejected continuation");
});

test("kill during a fake provider call records unknown usage and rejects continuation before another call", { timeout: 60_000 }, async (t) => {
  const context = await setupService(productionWorker);
  t.after(async () => {
    await context.service.close().catch(() => undefined);
    context.storage.close();
    await rm(context.parent, { recursive: true, force: true });
  });
  const conversation = context.service.createConversationV2();
  const submitted = context.service.submitV2(conversation.conversationId,
    { kind: "message", text: "[[fake:slow]]" }, randomUUID());
  const runId = submitted.run.runId;
  const inFlight = await waitFor(() => {
    const attempt = context.storage.attempts.list(runId).at(-1);
    const safety = attempt && context.storage.attemptSafety.get(attempt.attemptId);
    const usage = attempt && context.storage.usage.get(attempt.attemptId);
    return attempt?.status === "running" && safety?.state === "in_flight" && usage?.modelCalls === 1 && usage.costStatus === "unknown"
      ? { attempt, safety, usage } : undefined;
  }, "Fake provider call did not reach a persisted in-flight state");
  const identity = context.storage.workerIdentity.get();
  assert.ok(identity);
  process.kill(identity.pid, "SIGKILL");

  const interrupted = await waitForTerminal(context.service, runId);
  assert.equal(interrupted.status, "interrupted");
  assert.equal(context.storage.attempts.get(inFlight.attempt.attemptId)?.usageComplete, false);
  assert.equal(context.storage.attemptSafety.get(inFlight.attempt.attemptId)?.state, "in_flight");
  assert.equal(context.storage.usage.get(inFlight.attempt.attemptId)?.costStatus, "unknown");
  await waitFor(() => context.service.workerReady ? true : undefined, "Coordinator did not replace the killed Worker");
  assert.throws(() => context.service.continueV2(runId, randomUUID()), (error: unknown) =>
    typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === 409);
  assert.equal(context.storage.attempts.list(runId).length, 1, "failed continuation must not create another attempt or provider call");
});

test("the synthetic repository workflow fixture completes with non-empty evidence before kill injection", { timeout: 60_000 }, async (t) => {
  const context = await setupService(productionWorker);
  t.after(async () => {
    await context.service.close().catch(() => undefined);
    context.storage.close();
    await rm(context.parent, { recursive: true, force: true });
  });
  const conversation = context.service.createConversationV2();
  const submitted = context.service.submitV2(conversation.conversationId, {
    kind: "capability", capabilityId: "public_repository_analysis",
    input: { repositoryUrl: "https://github.com/demo/harborlight", ref: "7f06c6b2792349e4d9ccbd393008e5bf1f4d419a" },
    prompt: "Analyze the synthetic repository for its documented default port.",
  }, randomUUID());
  const completed = await waitForTerminal(context.service, submitted.run.runId);
  assert.equal(completed.status, "completed", JSON.stringify(completed));
  const result = completed.result;
  assert.equal(result?.status, "completed");
  const output = result?.status === "completed" ? result.extensionResult?.output as { evidenceCount?: unknown } | undefined : undefined;
  assert.equal(typeof output?.evidenceCount, "number");
  assert.ok((output?.evidenceCount as number) > 0, JSON.stringify(output));
});

test("kill after a settled workflow checkpoint keeps attempt-local usage and resumes from that checkpoint", { timeout: 60_000 }, async (t) => {
  const context = await setupService(beforeCallWorker);
  t.after(async () => {
    await context.service.close().catch(() => undefined);
    context.storage.close();
    await rm(context.parent, { recursive: true, force: true });
  });
  const conversation = context.service.createConversationV2();
  const submitted = context.service.submitV2(conversation.conversationId, {
    kind: "capability", capabilityId: "public_repository_analysis",
    input: { repositoryUrl: "https://github.com/demo/harborlight", ref: "7f06c6b2792349e4d9ccbd393008e5bf1f4d419a" },
    prompt: "Analyze the synthetic repository for its documented default port.",
  }, randomUUID());
  const runId = submitted.run.runId;
  const attemptId = context.storage.attempts.list(runId).at(-1)!.attemptId;

  const marker = path.join(context.dataDirectory, "usage-safety-analysis-checkpoint-paused");
  await waitFor(() => existsSync(marker) ? true : undefined, "Worker did not pause after committing the analysis checkpoint").catch((error: unknown) => {
    throw new Error(`${String(error)}; run=${JSON.stringify(context.service.getRunV2(runId))}; safety=${JSON.stringify(context.storage.attemptSafety.get(attemptId))}; usage=${JSON.stringify(context.storage.usage.get(attemptId))}; rows=${JSON.stringify(context.storage.checkpoints.list(runId))}; worker=${JSON.stringify(context.storage.workerIdentity.get())}`);
  });
  const firstSafetyAtKill = context.storage.attemptSafety.get(attemptId);
  const checkpointAtKill = firstSafetyAtKill?.checkpointId ? context.storage.checkpoints.get(firstSafetyAtKill.checkpointId) : undefined;
  assert.equal(firstSafetyAtKill?.state, "safe");
  assert.equal(firstSafetyAtKill?.checkpointKind, "workflow_stage");
  assert.equal(checkpointAtKill?.phaseId, "analysis");
  assert.equal(checkpointAtKill?.status, "completed");
  const identity = context.storage.workerIdentity.get();
  assert.ok(identity);
  process.kill(identity.pid, "SIGKILL");
  const interrupted = await waitFor(() => {
    const run = context.service.getRunV2(runId);
    return run.status === "interrupted" ? run : undefined;
  }, `Run ${runId} did not become interrupted (run=${JSON.stringify(context.service.getRunV2(runId))}; attempts=${JSON.stringify(context.storage.attempts.list(runId))}; safety=${JSON.stringify(context.storage.attemptSafety.get(attemptId))}; worker=${JSON.stringify(context.storage.workerIdentity.get())})`);
  assert.equal(interrupted.status, "interrupted");
  const firstAttempt = context.storage.attempts.get(attemptId);
  const firstUsage = context.storage.usage.get(attemptId);
  const firstSafety = context.storage.attemptSafety.get(attemptId);
  assert.equal(firstAttempt?.usageComplete, true);
  assert.ok(firstUsage && firstUsage.modelCalls > 0 && firstUsage.costStatus === "estimate");
  assert.equal(firstSafety?.state, "safe");
  assert.equal(firstSafety?.checkpointKind, "workflow_stage");
  assert.ok(firstSafety.checkpointId);

  await waitFor(() => context.service.workerReady ? true : undefined, "Coordinator did not replace the killed workflow Worker");
  const continued = context.service.continueV2(runId, randomUUID());
  assert.equal(continued.run.status, "running");
  const completed = await waitForTerminal(context.service, runId);
  assert.equal(completed.status, "completed", JSON.stringify(completed));
  const attempts = context.storage.attempts.list(runId);
  assert.equal(attempts.length, 2);
  const resumedUsage = context.storage.usage.get(attempts[1]!.attemptId);
  assert.equal(attempts[1]?.status, "completed");
  assert.equal(attempts[1]?.usageComplete, true);
  assert.ok(resumedUsage);
  assert.equal(resumedUsage.costStatus, "estimate");
  assert.equal(resumedUsage.pricingVersion, firstUsage.pricingVersion);
  assert.equal(resumedUsage.modelCalls, 0, "cached completed stages must not replay their model calls on continuation");
  assert.equal(resumedUsage.totalTokens, 0);
  assert.notEqual(firstUsage.attemptId, resumedUsage.attemptId);
});

test("kill after publication checkpoint reuses verified final artifacts on continuation", { timeout: 60_000 }, async (t) => {
  const context = await setupService(productionWorker);
  t.after(async () => {
    await context.service.close().catch(() => undefined);
    context.storage.close();
    await rm(context.parent, { recursive: true, force: true });
  });
  const conversation = context.service.createConversationV2();
  const submitted = context.service.submitV2(conversation.conversationId, {
    kind: "capability", capabilityId: "public_repository_analysis",
    input: { repositoryUrl: "https://github.com/demo/harborlight", ref: "7f06c6b2792349e4d9ccbd393008e5bf1f4d419a" },
    prompt: "Analyze the synthetic repository for its documented default port.",
  }, randomUUID());
  const runId = submitted.run.runId;
  const attemptId = context.storage.attempts.list(runId).at(-1)!.attemptId;

  let killed = false;
  let observedPublication: { checkpointId: string; usage: unknown } | undefined;
  const subscription = context.service.subscribeEventsV2(runId, undefined, (event) => {
    if (killed || event.type !== "checkpoint.saved" || event.data.phase !== "publication") return;
    const safety = context.storage.attemptSafety.get(attemptId);
    const usage = context.storage.usage.get(attemptId);
    const checkpoint = context.storage.checkpoints.get(event.data.checkpointId);
    if (!safety || safety.state !== "safe" || safety.checkpointKind !== "workflow_stage" ||
        safety.checkpointId !== event.data.checkpointId || !usage || usage.costStatus === "unknown" ||
        !checkpoint || checkpoint.status !== "completed" || checkpoint.phaseId !== "publication") return;
    const identity = context.storage.workerIdentity.get();
    if (!identity) return;
    try {
      observedPublication = { checkpointId: checkpoint.id, usage };
      process.kill(identity.pid, "SIGKILL");
      killed = true;
    } catch {
      // Keep observing if the Worker exited before the injected kill reached it.
    }
  });
  t.after(() => subscription.unsubscribe());
  await waitFor(() => killed ? true : undefined, "No durable publication checkpoint was observable before Worker completion");
  const interrupted = await waitFor(() => {
    const run = context.service.getRunV2(runId);
    return run.status === "interrupted" ? run : undefined;
  }, `Run ${runId} did not become interrupted after publication checkpoint kill`);
  assert.equal(interrupted.status, "interrupted");
  assert.ok(observedPublication);
  const firstAttempt = context.storage.attempts.get(attemptId);
  const firstUsage = context.storage.usage.get(attemptId);
  const firstSafety = context.storage.attemptSafety.get(attemptId);
  assert.equal(firstAttempt?.usageComplete, true);
  assert.ok(firstUsage && firstUsage.modelCalls > 0 && firstUsage.costStatus === "estimate");
  assert.equal(firstSafety?.state, "safe");
  assert.equal(firstSafety?.checkpointKind, "workflow_stage");
  assert.equal(firstSafety?.checkpointId, observedPublication.checkpointId);
  assert.equal(context.storage.results.get(runId), undefined, "the Coordinator has not finalized the run yet");

  const final = path.join(context.dataDirectory, "runs", runId, "final");
  const capturePublication = async () => Promise.all(["report.json", "report.md", "events.jsonl", "manifest.json"].map(async (name) => {
    const filePath = path.join(final, name);
    const [bytes, metadata] = await Promise.all([readFile(filePath), stat(filePath)]);
    return [name, createHash("sha256").update(bytes).digest("hex"), metadata.ino, metadata.mtimeMs] as const;
  }));
  const firstPublication = await capturePublication();

  await waitFor(() => context.service.workerReady ? true : undefined, "Coordinator did not replace the killed publication Worker");
  const continued = context.service.continueV2(runId, randomUUID());
  assert.equal(continued.run.status, "running");
  const completed = await waitForTerminal(context.service, runId);
  assert.equal(completed.status, "completed", JSON.stringify(completed));
  const resumedPublication = await capturePublication();
  assert.deepEqual(resumedPublication, firstPublication, "continuation must leave the verified report, manifest, and event bytes untouched");

  const attempts = context.storage.attempts.list(runId);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[1]?.status, "completed");
  assert.equal(attempts[1]?.usageComplete, true);
  const resumedUsage = context.storage.usage.get(attempts[1]!.attemptId);
  assert.ok(resumedUsage);
  assert.equal(resumedUsage.modelCalls, 0, "the resumed attempt must not invoke the provider again");
  assert.equal(resumedUsage.totalTokens, 0, "the prior attempt's usage stays with its original ledger row");
  assert.equal(resumedUsage.costStatus, "estimate");
  const publicationRows = context.storage.checkpoints.list(runId).filter((checkpoint) => checkpoint.phaseId === "publication" && checkpoint.status === "completed");
  assert.equal(publicationRows.length, 1, "recovery must not duplicate the logical publication checkpoint");
  const stored = context.storage.results.get(runId) as { artifacts?: Array<{ kind: string; sha256: string }> } | undefined;
  assert.ok(stored?.artifacts);
  for (const [kind, sha256] of firstPublication) {
    assert.equal(stored.artifacts.find((artifact) => artifact.kind === kind)?.sha256, sha256, `Coordinator result must retain ${kind} SHA`);
  }
});
