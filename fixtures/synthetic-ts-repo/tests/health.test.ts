import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getHealth } from "../src/health.js";

describe("health response", () => {
  it("returns an ok status", () => {
    assert.deepEqual(getHealth(), { status: "ok" });
  });
});
