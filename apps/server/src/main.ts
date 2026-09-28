import { createWorkbenchApp } from "./app.js";
import type { WorkbenchMode } from "./model-config.js";

const mode: WorkbenchMode = process.env.WORKBENCH_MODE === "online" ? "online" : "fake";
if (mode === "online" && !process.env.DEEPSEEK_API_KEY?.trim()) {
  throw new Error("WORKBENCH_MODE=online requires the server-side DEEPSEEK_API_KEY environment variable");
}
const app = await createWorkbenchApp({ mode, apiKey: process.env.DEEPSEEK_API_KEY, githubToken: process.env.GITHUB_TOKEN });
const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.API_PORT ?? 2027);
await app.listen({ host, port });
console.log(`Workbench API listening on http://${host}:${port} (${mode} mode)`);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => { void app.close().finally(() => process.exit(0)); });
}
