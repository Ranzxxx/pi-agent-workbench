import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

async function launch(t: TestContext, behavior: string, startupTimeoutMs = 3_000) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-dev-startup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const address = reservation.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const npm = path.join(directory, "fake-npm.mjs");
  await writeFile(npm, `
    import { createServer } from "node:http";
    if (process.argv.includes("@pi-workbench/server")) {
      console.log("TEST_API_STARTING");
      if (process.env.TEST_BEHAVIOR === "fail") process.exit(7);
      if (process.env.TEST_BEHAVIOR === "never") setInterval(() => {}, 1000);
      else setTimeout(() => {
        createServer((req, res) => { res.end("ready"); }).listen(Number(process.env.API_PORT), "127.0.0.1", () => {
          const line = "Workbench API listening on http://127.0.0.1:" + process.env.API_PORT + " (fake mode)";
          console.log(line);
          console.log(line);
        });
      }, 150);
    } else {
      const response = await fetch("http://127.0.0.1:" + process.env.API_PORT + "/api/v2/health");
      if (await response.text() !== "ready") process.exit(8);
      if (process.env.DEEPSEEK_API_KEY || process.env.GITHUB_TOKEN) process.exit(9);
      console.log("TEST_WEB_READY");
      setInterval(() => {}, 1000);
    }
  `);
  const launcher = new URL("../dev.mjs", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `import { runDevelopment } from ${JSON.stringify(launcher)}; runDevelopment({ npm: ${JSON.stringify(npm)}, startupTimeoutMs: ${startupTimeoutMs} });`], {
    env: { ...process.env, HOST: "127.0.0.1", API_PORT: String(address.port), WEB_PORT: "3026", WORKBENCH_MODE: "fake", TEST_BEHAVIOR: behavior, DEEPSEEK_API_KEY: "synthetic", GITHUB_TOKEN: "synthetic" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const finished = once(child, "close");
  t.after(async () => { child.kill("SIGTERM"); await finished; });
  return {
    child, finished, output: () => output,
    async waitFor(text: string) {
      for (let count = 0; count < 200; count++) {
        if (output.includes(text)) return;
        if (child.exitCode !== null) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.fail(`Missing ${text}: ${output}`);
    },
  };
}

test("dev waits for its delayed API listener, starts web once and strips web secrets", { timeout: 5_000 }, async (t) => {
  const running = await launch(t, "delayed");
  await running.waitFor("TEST_API_STARTING");
  assert.ok(!running.output().includes("TEST_WEB_READY"));
  await running.waitFor("TEST_WEB_READY");
  running.child.kill("SIGTERM");
  assert.equal((await running.finished)[0], 0);
  assert.equal(running.output().split("TEST_WEB_READY").length - 1, 1);
  assert.ok(running.output().indexOf("Workbench API listening") < running.output().indexOf("TEST_WEB_READY"));
});

test("dev reports API startup failure without launching web", { timeout: 5_000 }, async (t) => {
  const running = await launch(t, "fail");
  assert.equal((await running.finished)[0], 7);
  assert.ok(!running.output().includes("TEST_WEB_READY"));
});

test("dev times out an API that never becomes ready without launching web", { timeout: 5_000 }, async (t) => {
  const running = await launch(t, "never", 300);
  assert.equal((await running.finished)[0], 1);
  assert.match(running.output(), /did not become ready/);
  assert.ok(!running.output().includes("TEST_WEB_READY"));
});
