import { runOfflineAnalysis, offlineDefaults } from "./offline-runner.js";

async function main(): Promise<void> {
  const defaults = offlineDefaults();
  const result = await runOfflineAnalysis({
    fixtureRoot: defaults.fixtureRoot,
    outputDirectory: defaults.outputDirectory,
  });
  console.log("TASK-004 offline demo: fictional fixture; no GitHub access, network, API key, dependency install, or fixture command execution.");
  console.log(`Status: ${result.status}`);
  console.log(`Snapshot: ${result.snapshotId}`);
  if (result.directory) console.log(`Output: ${result.directory}`);
  for (const artifact of result.artifacts) console.log(`Artifact: ${artifact.kind} (${artifact.sha256})`);
  if (result.evaluation) console.log(`Evaluation: ${JSON.stringify(result.evaluation, null, 2)}`);
  if (result.error) console.error(result.error);
  if (result.status !== "completed") process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Offline demo failed");
  process.exitCode = 1;
});
