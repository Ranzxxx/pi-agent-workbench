import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { InMemoryCredentialStore, type CredentialStore, type Model, type Provider } from "@pi-workbench/agent-runtime";
import type { Budget, Pricing } from "@pi-workbench/protocol";

export type WorkbenchMode = "fake" | "online";

export const WORKBENCH_BUDGET = {
  timeoutMs: 180_000,
  maxModelCalls: 8,
  maxToolCalls: 20,
  maxTokens: 32_000,
  maxOutputTokens: 2_000,
} as const;

export const DEEPSEEK_PRICING: Pricing = {
  version: "deepseek-flash-peak-2026-09-27",
  input: 0.3,
  output: 1.2,
  cacheRead: 0.006,
  cacheWrite: 0,
};

export interface ModelConfiguration {
  credentials: CredentialStore;
  provider: Provider;
  model: Model<string>;
  pricing: Pricing;
  budget: Budget;
}

function textFromMessage(message: unknown): string {
  if (typeof message !== "object" || message === null || !("content" in message)) return "";
  const content = (message as { content: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((item: unknown) => {
    if (typeof item === "object" && item !== null && "type" in item && item.type === "text" && "text" in item && typeof item.text === "string") return item.text;
    return "";
  }).join("");
}

/** Deterministic browser-safe fake model. Sentinels exist only to exercise failure/cancel paths in fake mode. */
export function createFakeChatConfiguration(configurationOptions: { allowDevelopmentGreetingTool?: boolean } = {}): ModelConfiguration {
  const fake = fauxProvider({ api: "workbench-fake", provider: `workbench_fake_${randomUUID().replaceAll("-", "")}`, models: [{ id: "offline-demo" }], tokenSize: { min: 8, max: 8 } });
  const original = fake.provider.streamSimple.bind(fake.provider);
  const provider: Provider = {
    ...fake.provider,
    streamSimple(model, context, options) {
      const prompt = context.messages.map(textFromMessage).filter(Boolean).at(-1) ?? "";
      if (prompt.includes("[[fake:fail]]")) {
        fake.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "Synthetic offline model failure" })]);
      } else if (prompt.includes("[[fake:slow]]")) {
        fake.setResponses([async (_context, callOptions) => {
          await new Promise<void>((resolve) => {
            const signal = callOptions?.signal;
            if (!signal || signal.aborted) resolve();
            else signal.addEventListener("abort", () => resolve(), { once: true });
          });
          return fauxAssistantMessage("", { stopReason: "aborted" });
        }]);
      } else if (configurationOptions.allowDevelopmentGreetingTool && prompt.includes("[[demo:greeting-tool]]")) {
        fake.setResponses([
          fauxAssistantMessage(fauxToolCall("development_greeting_tool__make_greeting", { name: "PI Workbench" }), { stopReason: "toolUse" }),
          fauxAssistantMessage("已调用示例问候工具。"),
        ]);
      } else {
        fake.setResponses([fauxAssistantMessage(`这是离线模拟回复，没有调用真实模型。你提到的内容是：${prompt.slice(0, 700)}`)]);
      }
      return original(model, context, options);
    },
  };
  return { ...fakeConfigurationFromProvider(fake, provider), budget: { ...WORKBENCH_BUDGET, maxToolCalls: 0, maxCostUsd: 1 } } as ModelConfiguration;
}

function fakeConfigurationFromProvider(fake: ReturnType<typeof fauxProvider>, provider: Provider) {
  return {
    provider,
    model: fake.getModel(),
    credentials: new InMemoryCredentialStore(),
    pricing: { version: "offline-zero", input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

export async function createOnlineConfiguration(apiKey: string): Promise<ModelConfiguration> {
  if (!apiKey.trim()) throw new Error("DEEPSEEK_API_KEY is required in online mode");
  const provider = deepseekProvider();
  const model = provider.getModels().find((item) => item.id === "deepseek-flash");
  if (!model || model.provider !== "deepseek" || model.api !== "openai-completions" || model.baseUrl !== "https://api.deepseek.com") {
    throw new Error("The configured PI SDK does not expose the reviewed DeepSeek Flash model");
  }
  if (model.cost.input !== DEEPSEEK_PRICING.input || model.cost.output !== DEEPSEEK_PRICING.output ||
      model.cost.cacheRead !== DEEPSEEK_PRICING.cacheRead || model.cost.cacheWrite !== DEEPSEEK_PRICING.cacheWrite) {
    throw new Error("DeepSeek Flash catalog prices differ from the reviewed price snapshot; update the pricing record before online use");
  }
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(provider.id, async () => ({ type: "api_key", key: apiKey.trim() }));
  return {
    credentials, provider, model, pricing: DEEPSEEK_PRICING,
    budget: { ...WORKBENCH_BUDGET, maxToolCalls: WORKBENCH_BUDGET.maxToolCalls, maxCostUsd: 0.2 },
  };
}

export interface FakeSnapshotFetchOptions {
  repositoryRoot: string;
  sha: string;
}

function octal(value: number, size: number): string { return value.toString(8).padStart(size - 1, "0") + "\0"; }

function tarFile(name: string, contents: Buffer, rootName: string): Buffer {
  const header = Buffer.alloc(512);
  header.write(`${rootName}/${name}`, 0, 100, "utf8");
  header.write(octal(0o100644, 8), 100, 8, "ascii");
  header.write(octal(0, 8), 108, 8, "ascii");
  header.write(octal(0, 8), 116, 8, "ascii");
  header.write(octal(contents.length, 12), 124, 12, "ascii");
  header.write(octal(0, 12), 136, 12, "ascii");
  header.fill(32, 148, 156);
  header[156] = "0".charCodeAt(0);
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  const padded = Buffer.alloc(Math.ceil(contents.length / 512) * 512);
  contents.copy(padded);
  return Buffer.concat([header, padded]);
}

async function fakeArchive(repositoryRoot: string, sha: string): Promise<Buffer> {
  const entries: Buffer[] = [];
  const visit = async (directory: string, prefix = ""): Promise<void> => {
    const names = await readdir(directory, { withFileTypes: true });
    for (const entry of names.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      const relative = path.posix.join(prefix, entry.name);
      if (entry.isDirectory()) await visit(absolute, relative);
      else if (entry.isFile()) entries.push(tarFile(relative, await readFile(absolute), `synthetic-${sha.slice(0, 7)}`));
      else throw new Error("The synthetic fixture contains a non-regular file");
    }
  };
  await visit(repositoryRoot);
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
}

function fakeResponse(body: BodyInit | null, url: string, status = 200): Response {
  const response = new Response(body, { status });
  Object.defineProperty(response, "url", { value: url });
  return response;
}

/** Restrict all fake-mode repository fetches to an in-memory archive from the checked-in synthetic fixture. */
export async function createFakeSnapshotFetch(options: FakeSnapshotFetchOptions): Promise<typeof fetch> {
  const archive = await fakeArchive(options.repositoryRoot, options.sha);
  return async (input, requestInit) => {
    const url = String(input);
    if (requestInit?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (url.startsWith("https://api.github.com/repos/")) {
      const parsed = new URL(url);
      const segments = parsed.pathname.split("/").filter(Boolean);
      if (parsed.hostname !== "api.github.com" || segments[0] !== "repos" || segments[1]?.toLowerCase() !== "demo" || segments[2]?.replace(/\.git$/iu, "").toLowerCase() !== "harborlight") return fakeResponse("{}", url, 404);
      if (segments.length === 5 && segments[3] === "commits") return fakeResponse(JSON.stringify({ sha: options.sha }), url);
      if (segments.length === 3) return fakeResponse(JSON.stringify({ default_branch: "main" }), url);
      return fakeResponse("{}", url, 404);
    }
    if (url.startsWith("https://codeload.github.com/")) {
      const parsed = new URL(url);
      const segments = parsed.pathname.split("/").filter(Boolean);
      if (parsed.hostname === "codeload.github.com" && segments.length === 4 && segments[0]?.toLowerCase() === "demo" && segments[1]?.replace(/\.git$/iu, "").toLowerCase() === "harborlight" && segments[2] === "legacy.tar.gz" && segments[3] === options.sha) {
        return fakeResponse(new Uint8Array(archive), url);
      }
      return fakeResponse("{}", url, 404);
    }
    return fakeResponse("{}", url, 404);
  };
}

export async function createFakeRepositoryAnalysisConfiguration(repositoryRoot: string, sha: string) {
  const fake = fauxProvider({ api: "workbench-fake-analysis", provider: `workbench_fake_analysis_${randomUUID().replaceAll("-", "")}`, models: [{ id: "offline-analysis" }], tokenSize: { min: 8, max: 8 } });
  fake.setResponses([
    fauxAssistantMessage(fauxToolCall("list_files", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("register_evidence", {
      id: "fixture-service-summary", path: "README.md", startLine: 3, endLine: 5,
      excerpt: "Harborlight is a small TypeScript service fixture maintained for offline\nrepository-analysis tests. It exposes a health response and starts on port\n4317 when no port is supplied.",
    }), { stopReason: "toolUse" }),
    fauxAssistantMessage('{"status":"complete"}'),
    fauxAssistantMessage(JSON.stringify({
      title: "Harborlight 仓库分析",
      claims: [{ id: "fixture-service-summary", kind: "fact", text: "这是一个用于离线仓库分析的 TypeScript 服务样例；说明文档写明默认端口为 4317。", evidenceIds: ["fixture-service-summary"] }],
    })),
  ]);
  return {
    provider: fake.provider,
    model: fake.getModel(),
    credentials: new InMemoryCredentialStore(),
    pricing: { version: "offline-zero", input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as Pricing,
    budget: { ...WORKBENCH_BUDGET, maxToolCalls: 8, maxModelCalls: 6, maxCostUsd: 1 },
    fetch: await createFakeSnapshotFetch({ repositoryRoot, sha }),
  };
}
