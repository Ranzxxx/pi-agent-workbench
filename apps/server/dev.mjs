import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export function runDevelopment({ npm = process.env.npm_execpath, startupTimeoutMs = 60_000 } = {}) {
  if (!npm) throw new Error("Run the development command through npm");
  const webPort = Number(process.env.WEB_PORT ?? 2026);
  const apiPort = Number(process.env.API_PORT ?? 2027);
  for (const [name, value] of [["WEB_PORT", webPort], ["API_PORT", apiPort]]) {
    if (!Number.isInteger(value) || value < 1 || value > 65_535) throw new Error(`${name} must be a valid TCP port`);
  }
  const webEnv = { ...process.env };
  delete webEnv.DEEPSEEK_API_KEY;
  delete webEnv.GITHUB_TOKEN;
  const children = [];
  let stopping = false;
  let webStarted = false;
  let startupTimer;
  function stop(signal = "SIGTERM") {
    if (stopping) return;
    stopping = true;
    clearTimeout(startupTimer);
    for (const child of children) {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
        else if (!child.killed) child.kill(signal);
      } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
  }
  function start(args, options) {
    const child = spawn(process.execPath, [npm, ...args], { cwd: root, detached: process.platform !== "win32", ...options });
    children.push(child);
    child.once("error", (error) => {
      console.error(error.message);
      process.exitCode = 1;
      stop();
    });
    child.once("exit", (code) => {
      if (!stopping) process.exitCode = code || 1;
      stop();
    });
    return child;
  }
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));
  console.log("Waiting for the Workbench API before starting the web UI…");
  const server = start(["run", "dev", "--workspace", "@pi-workbench/server"], {
    stdio: ["inherit", "pipe", "inherit"], env: { ...process.env },
  });
  server.stdout.pipe(process.stdout);
  const lines = createInterface({ input: server.stdout });
  const mode = process.env.WORKBENCH_MODE === "online" ? "online" : "fake";
  const readyLine = `Workbench API listening on http://${process.env.HOST ?? "127.0.0.1"}:${apiPort} (${mode} mode)`;
  // main.ts emits this only after app.listen resolves. An unrelated service on
  // API_PORT cannot make this child look ready, as it could with a port probe.
  lines.on("line", (line) => {
    if (line !== readyLine || stopping || webStarted) return;
    webStarted = true;
    clearTimeout(startupTimer);
    start(["run", "dev", "--workspace", "@pi-workbench/web", "--", "--port", String(webPort)], {
      stdio: "inherit", env: webEnv,
    });
  });
  startupTimer = setTimeout(() => {
    console.error(`Workbench API did not become ready within ${startupTimeoutMs / 1000}s; web UI was not started. Check the API startup output above.`);
    process.exitCode = 1;
    stop();
  }, startupTimeoutMs);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) runDevelopment();
