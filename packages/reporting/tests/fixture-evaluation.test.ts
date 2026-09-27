import assert from "node:assert/strict";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createReadOnlyRepository } from "@pi-workbench/tools";
import { SYNTHETIC_SNAPSHOT_ID } from "../src/contracts.js";
import { verifyGoldenSnapshot } from "../src/fixture-evaluation.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../");
const fixtureRoot = path.join(projectRoot, "fixtures", "synthetic-ts-repo");

test("golden fact scoring only accepts the pinned synthetic fixture tree", async () => {
  const repository = createReadOnlyRepository({ root: fixtureRoot, snapshotId: SYNTHETIC_SNAPSHOT_ID });
  const golden = await verifyGoldenSnapshot(repository);
  assert.equal(golden.snapshotId, SYNTHETIC_SNAPSHOT_ID);
  assert.equal(golden.contentDigestSha256, "2c12777a98aae20f4919170635844cdbcdb98c27f1f2bfe4165f74fe3263d0d1");

  const temporary = await mkdtemp(path.join(os.tmpdir(), "pi-task004-golden-"));
  try {
    const changed = path.join(temporary, "fixture");
    await cp(fixtureRoot, changed, { recursive: true });
    await writeFile(path.join(changed, "additional-fact.txt"), "changed snapshot\n");
    await assert.rejects(
      verifyGoldenSnapshot(createReadOnlyRepository({ root: changed, snapshotId: SYNTHETIC_SNAPSHOT_ID })),
      /differs from the pre-scored golden snapshot/u,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
