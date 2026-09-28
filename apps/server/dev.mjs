import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const npm = process.env.npm_execpath;
if (!npm) throw new Error("Run the development command through npm");
const node = process.execPath;
const webPort = Number(process.env.WEB_PORT ?? 2026);
if (!Number.isInteger(webPort) || webPort < 1 || webPort > 65_535) throw new Error("WEB_PORT must be a valid TCP port");
const serverEnv = { ...process.env };
const webEnv = { ...process.env };
delete webEnv.DEEPSEEK_API_KEY;
delete webEnv.GITHUB_TOKEN;
const children = [
  spawn(node, [npm, "run", "dev", "--workspace", "@pi-workbench/server"], { cwd: root, stdio: "inherit", env: serverEnv }),
  spawn(node, [npm, "run", "dev", "--workspace", "@pi-workbench/web", "--", "--port", String(webPort)], { cwd: root, stdio: "inherit", env: webEnv }),
];
let stopping = false;
function stop(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (!child.killed) child.kill(signal);
}
process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));
for (const child of children) child.once("exit", (code) => {
  if (code !== 0 && code !== null && !stopping) process.exitCode = code;
  stop();
});
