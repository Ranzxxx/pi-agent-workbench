import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createEvidenceRegistry, EvidenceValidationError } from "../src/index.js";
import { createReadOnlyRepository } from "../src/read-only-repository.js";

const fixtureRoot = new URL("../../../fixtures/synthetic-ts-repo/", import.meta.url);

test("registers source-bound evidence and rejects mismatched paths, lines, snapshot, and digest", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-task004-evidence-"));
  try {
    const { cp } = await import("node:fs/promises");
    await cp(fixtureRoot, root, { recursive: true });
    const repository = createReadOnlyRepository({ root, snapshotId: "synthetic-harborlight-v1" });
    const registry = createEvidenceRegistry(repository);
    const validInput = {
      id: "e-health",
      path: "src/health.ts",
      startLine: 1,
      endLine: 3,
      excerpt: 'export function getHealth(): { status: "ok" } {\n  return { status: "ok" };\n}',
    };
    const valid = await registry.register(validInput);
    assert.equal(valid.snapshotId, "synthetic-harborlight-v1");
    assert.match(valid.fileSha256, /^[a-f0-9]{64}$/u);
    await registry.validate(valid);
    assert.deepEqual(registry.list(), [valid]);

    await assert.rejects(registry.register({ ...validInput, id: "e-wrong-lines", endLine: 4 }), EvidenceValidationError);
    await assert.rejects(registry.register({ ...validInput, id: "e-wrong-excerpt", excerpt: "return true;" }), EvidenceValidationError);
    await assert.rejects(registry.register({ ...validInput, id: "e-missing", path: "src/missing.ts" }), /ENOENT/u);
    await assert.rejects(registry.register({ ...validInput, id: "bad id" }), EvidenceValidationError);
    await assert.rejects(registry.register({ ...validInput, id: "e-duplicate" }).then(() => registry.register({ ...validInput, id: "e-duplicate" })), EvidenceValidationError);

    await assert.rejects(registry.validate({ ...valid, snapshotId: "other-snapshot" }), EvidenceValidationError);
    await assert.rejects(registry.validate({ ...valid, fileSha256: "a".repeat(64) }), EvidenceValidationError);
    await assert.rejects(registry.validate({ ...valid, startLine: 2, endLine: 4 }), EvidenceValidationError);
    await assert.rejects(registry.validate({ ...valid, excerpt: "unrelated source" }), EvidenceValidationError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
