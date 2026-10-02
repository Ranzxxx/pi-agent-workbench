import {
  parseCapabilityManifest,
  type CapabilityCatalogEntry,
  type CapabilityManifest,
  type CapabilityPermission,
  type ExtensionJsonSchema,
} from "@pi-workbench/protocol";
import type { JsonValue } from "@pi-workbench/storage";
import type { Usage, V2RunSubmission, V2CreateRunSubmission } from "@pi-workbench/protocol";

export const CAPABILITY_API_VERSION = "1.0";

export const publicRepositoryCapability: CapabilityManifest = {
  id: "public_repository_analysis",
  apiVersion: CAPABILITY_API_VERSION,
  name: "仓库分析",
  description: "只读分析一个公开 GitHub 仓库，固定解析后的提交并生成带行号和 SHA 的证据报告。不会安装或执行目标仓库代码。",
  kind: "workflow",
  icon: "grid",
  configSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
  inputSchema: {
    type: "object", additionalProperties: false, required: ["repositoryUrl"],
    properties: {
      repositoryUrl: { type: "string", title: "公开 GitHub 仓库", description: "填写仓库 HTTPS 地址。", maxLength: 512, format: "github-repository-url" },
      ref: { type: "string", title: "分支、标签或提交", description: "可选；留空时分析默认分支的当前提交。", maxLength: 256 },
      goal: { type: "string", title: "分析目标", description: "旧版请求的分析目标；v2 使用消息输入框。", maxLength: 8000, "x-ui": "prompt" },
    },
  },
  outputSchema: {
    type: "object", additionalProperties: false, required: ["snapshotSha", "claims", "evidenceCount"],
    properties: {
      snapshotSha: { type: "string", minLength: 40, maxLength: 40 },
      evidenceCount: { type: "integer", minimum: 0, maximum: 4096 },
      claims: { type: "array", maxItems: 32, items: {
        type: "object", additionalProperties: false, required: ["text", "kind"],
        properties: { text: { type: "string", minLength: 1, maxLength: 1000 }, kind: { type: "string", enum: ["fact", "inference", "unknown"] } },
      } },
    },
  },
  requiredPermissions: ["public_repository.read", "results.write"],
};

export const developmentGreetingCapability: CapabilityManifest = {
  id: "development_greeting_tool",
  apiVersion: CAPABILITY_API_VERSION,
  name: "开发示例：问候工具",
  description: "仅用于开发验证的工具型扩展示例。启用后通过 @ 选择；离线演示输入 [[demo:greeting-tool]] 可确定性地触发调用。",
  kind: "tools",
  icon: "spark",
  configSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
  inputSchema: { type: "object", additionalProperties: false, properties: {}, required: [] },
  outputSchema: {
    type: "object", additionalProperties: false, required: ["toolCalls"],
    properties: { toolCalls: { type: "array", maxItems: 8, items: {
      type: "object", additionalProperties: false, required: ["toolName", "result"],
      properties: { toolName: { type: "string", minLength: 1, maxLength: 128 }, result: { type: "object", additionalProperties: false, required: ["message"], properties: { message: { type: "string", minLength: 1, maxLength: 256 } } } },
    } } },
  },
  requiredPermissions: [],
};

export interface CapabilityState {
  capabilityId: string;
  apiVersion: string;
  enabled: boolean;
  config: Record<string, JsonValue>;
  updatedAt?: string;
}

export interface CapabilityRuntimeEvent {
  type: "progress" | "checkpoint_saved" | "tool.started" | "tool.finished" | "run.cancelling" | "run.warning" | "runtime_status";
  phase?: string;
  message?: string;
  checkpointId?: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  reason?: "user" | "timeout" | "token_limit" | "call_limit" | "tool_limit" | "cost_limit";
  code?: "cancellation_pending";
  state?: "started" | "completed" | "aborted" | "failed";
  compactionReason?: "manual" | "threshold" | "overflow";
}

export interface CapabilityContext {
  runId: string;
  attemptId: string;
  conversationId: string;
  projectId: string | null;
  prompt: string;
  signal: AbortSignal;
  budget: { timeoutMs: number; maxModelCalls: number; maxToolCalls: number; maxTokens: number; maxOutputTokens: number; maxCostUsd: number };
  initialUsage?: Usage;
  initialUsageComplete?: boolean;
  configuration: Record<string, JsonValue>;
  emit(event: CapabilityRuntimeEvent): void | Promise<void>;
}

export interface CapabilityTool {
  name: string;
  description: string;
  inputSchema: ExtensionJsonSchema;
  outputSchema: ExtensionJsonSchema;
  execute(input: unknown, context: CapabilityContext): Promise<unknown> | unknown;
}

export interface WorkflowArtifact { kind: string; path: string; sha256: string; }
export interface CapabilityWorkflowResult {
  title: string;
  summary: string;
  reply: string;
  output: unknown;
  artifacts?: WorkflowArtifact[];
  usage?: Usage;
  usageComplete?: boolean;
}

export interface CapabilityDefinition {
  manifest: CapabilityManifest;
  enabledByDefault: boolean;
  defaultConfig: Record<string, JsonValue>;
  execute?: (input: Record<string, unknown>, context: CapabilityContext) => Promise<CapabilityWorkflowResult>;
  createTools?: (context: CapabilityContext) => CapabilityTool[] | Promise<CapabilityTool[]>;
}

export type CapabilityErrorCode =
  | "unknown_extension" | "extension_disabled" | "extension_unconfigured" | "extension_incompatible"
  | "extension_permission_denied" | "extension_invalid_input" | "extension_invalid_config";

export class CapabilityRegistryError extends Error {
  constructor(readonly code: CapabilityErrorCode, message: string) { super(message); this.name = "CapabilityRegistryError"; }
}

export class CapabilityCancelledError extends Error {
  constructor(
    readonly reason: "user" | "timeout" | "token_limit" | "call_limit" | "tool_limit" | "cost_limit",
    readonly usage?: import("@pi-workbench/protocol").Usage,
    readonly usageComplete = true,
    readonly artifacts: WorkflowArtifact[] = [],
  ) {
    super("Capability execution was cancelled"); this.name = "CapabilityCancelledError";
  }
}

interface PreparedCapability {
  definition: CapabilityDefinition;
  input: Record<string, unknown>;
  configuration: Record<string, JsonValue>;
}

const API_VERSION_PATTERN = /^[0-9]+\.[0-9]+$/u;
const SAFE_TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/u;
const SENSITIVE_CONFIG_KEY = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|authorization|credential|secret)/iu;
const JSON_SCHEMA_KEYS = new Set([
  "type", "title", "description", "properties", "required", "additionalProperties", "items", "enum",
  "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties",
  "format", "pattern", "x-ui",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function encode(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    if (typeof text !== "string") throw new Error("Value is not serializable");
    return text;
  } catch { throw new CapabilityRegistryError("extension_invalid_input", "扩展数据不是有效的 JSON 值。") }
}
function schemaRecord(value: unknown, code: CapabilityErrorCode, depth = 0): Record<string, unknown> {
  if (depth > 12 || !isRecord(value) || Object.keys(value).length > 32) throw new CapabilityRegistryError(code, "扩展 JSON Schema 不受支持。");
  if (Object.keys(value).some((key) => !JSON_SCHEMA_KEYS.has(key))) throw new CapabilityRegistryError(code, "扩展 JSON Schema 含有不支持的关键字。");
  const type = value.type;
  if (!["object", "string", "number", "integer", "boolean", "array"].includes(String(type))) throw new CapabilityRegistryError(code, "扩展 JSON Schema 缺少受支持的 type。");
  for (const key of ["title", "description"] as const) if (value[key] !== undefined && (typeof value[key] !== "string" || value[key].length > 512)) throw new CapabilityRegistryError(code, "扩展 JSON Schema 文本元数据无效。");
  if (type === "object") {
    const properties = value.properties === undefined ? {} : value.properties;
    if (!isRecord(properties) || Object.keys(properties).length > 64) throw new CapabilityRegistryError(code, "扩展 JSON Schema properties 无效。");
    for (const [name, property] of Object.entries(properties)) {
      if (name.length > 128) throw new CapabilityRegistryError(code, "扩展 JSON Schema 属性名称过长。");
      if (code === "extension_invalid_config" && SENSITIVE_CONFIG_KEY.test(name)) throw new CapabilityRegistryError(code, "扩展配置 schema 不得声明凭据字段。");
      schemaRecord(property, code, depth + 1);
    }
    if (value.additionalProperties !== false) throw new CapabilityRegistryError(code, "扩展对象 schema 必须拒绝额外字段。");
    const required = value.required === undefined ? [] : value.required;
    if (!Array.isArray(required) || required.some((name) => typeof name !== "string" || !(name in properties)) || new Set(required).size !== required.length) {
      throw new CapabilityRegistryError(code, "扩展 JSON Schema required 无效。");
    }
    if (value.minProperties !== undefined && value.maxProperties !== undefined && Number(value.minProperties) > Number(value.maxProperties)) {
      throw new CapabilityRegistryError(code, "扩展 JSON Schema 对象属性范围无效。");
    }
  }
  if (type === "array") {
    if (!value.items) throw new CapabilityRegistryError(code, "扩展数组 schema 必须声明 items。");
    schemaRecord(value.items, code, depth + 1);
    for (const key of ["minItems", "maxItems"] as const) if (value[key] !== undefined && (!Number.isInteger(value[key]) || Number(value[key]) < 0 || Number(value[key]) > 4096)) throw new CapabilityRegistryError(code, "扩展 JSON Schema 数组限制无效。");
    if (value.minItems !== undefined && value.maxItems !== undefined && Number(value.minItems) > Number(value.maxItems)) throw new CapabilityRegistryError(code, "扩展 JSON Schema 数组范围无效。");
  }
  for (const key of ["minLength", "maxLength", "minProperties", "maxProperties"] as const) {
    if (value[key] !== undefined && (!Number.isInteger(value[key]) || Number(value[key]) < 0 || Number(value[key]) > 65_536)) throw new CapabilityRegistryError(code, "扩展 JSON Schema 长度限制无效。");
  }
  for (const key of ["minimum", "maximum"] as const) if (value[key] !== undefined && (typeof value[key] !== "number" || !Number.isFinite(value[key]))) throw new CapabilityRegistryError(code, "扩展 JSON Schema 数值限制无效。");
  if (value.minimum !== undefined && value.maximum !== undefined && Number(value.minimum) > Number(value.maximum)) throw new CapabilityRegistryError(code, "扩展 JSON Schema 数值范围无效。");
  if (value.minLength !== undefined && value.maxLength !== undefined && Number(value.minLength) > Number(value.maxLength)) throw new CapabilityRegistryError(code, "扩展 JSON Schema 字符长度范围无效。");
  if (value.pattern !== undefined && (typeof value.pattern !== "string" || value.pattern.length > 128 || /\(\?/.test(value.pattern) || /\\[1-9]/.test(value.pattern) || /\([^)]*[+*][^)]*\)[+*]/.test(value.pattern))) {
    throw new CapabilityRegistryError(code, "扩展 JSON Schema pattern 超出允许范围。");
  }
  if (value.enum !== undefined && (!Array.isArray(value.enum) || value.enum.length < 1 || value.enum.length > 64 || value.enum.some((entry) => !["string", "number", "boolean"].includes(typeof entry) && entry !== null))) {
    throw new CapabilityRegistryError(code, "扩展 JSON Schema enum 无效。");
  }
  if (value.format !== undefined && !["github-repository-url"].includes(String(value.format))) throw new CapabilityRegistryError(code, "扩展 JSON Schema format 不受支持。");
  if (value["x-ui"] !== undefined && !["text", "textarea", "prompt"].includes(String(value["x-ui"]))) throw new CapabilityRegistryError(code, "扩展 JSON Schema x-ui 不受支持。");
  return value;
}

export function validateExtensionValue(schemaValue: ExtensionJsonSchema, value: unknown, options: { allowMissingRequired?: boolean } = {}): boolean {
  const schema = schemaRecord(schemaValue, "extension_invalid_input");
  return checkValue(schema, value, 0, options.allowMissingRequired ?? false);
}
function checkValue(schema: Record<string, unknown>, value: unknown, depth: number, allowMissingRequired: boolean): boolean {
  if (depth > 16 || value === undefined || typeof value === "function" || typeof value === "symbol") return false;
  const type = schema.type;
  if (type === "object") {
    if (!isRecord(value)) return false;
    const propertyCount = Object.keys(value).length;
    if (propertyCount < Number(schema.minProperties ?? 0) || propertyCount > Number(schema.maxProperties ?? 64)) return false;
    const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
    const required = schema.required as string[] | undefined;
    if (!allowMissingRequired && required?.some((key) => !Object.hasOwn(value, key))) return false;
    for (const [key, item] of Object.entries(value)) {
      const child = properties?.[key];
      if (!child || !checkValue(child, item, depth + 1, allowMissingRequired)) return false;
    }
    return true;
  }
  if (type === "string") {
    if (typeof value !== "string" || value.length < Number(schema.minLength ?? 0) || value.length > Number(schema.maxLength ?? 65_536)) return false;
    if (schema.format === "github-repository-url") {
      try { const url = new URL(value); if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password || url.search || url.hash || !/^\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/u.test(url.pathname)) return false; }
      catch { return false; }
    }
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) return false;
    if (Array.isArray(schema.enum) && !schema.enum.some((entry) => Object.is(entry, value))) return false;
    return true;
  }
  if (type === "number" || type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value) || (type === "integer" && !Number.isInteger(value))) return false;
    if (typeof schema.minimum === "number" && value < schema.minimum) return false;
    if (typeof schema.maximum === "number" && value > schema.maximum) return false;
  } else if (type === "boolean" && typeof value !== "boolean") return false;
  else if (type === "array") {
    if (!Array.isArray(value) || value.length < Number(schema.minItems ?? 0) || value.length > Number(schema.maxItems ?? 4096)) return false;
    return value.every((item) => checkValue(schema.items as Record<string, unknown>, item, depth + 1, allowMissingRequired));
  } else if (type !== "number" && type !== "integer" && type !== "boolean") return false;
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => Object.is(entry, value))) return false;
  return true;
}

function missingRequired(schema: ExtensionJsonSchema, config: Record<string, JsonValue>): string[] {
  const record = schemaRecord(schema, "extension_invalid_config");
  const required = record.required as string[] | undefined;
  return (required ?? []).filter((key) => !Object.hasOwn(config, key));
}

function assertDefinition(definition: CapabilityDefinition): CapabilityDefinition {
  const manifest = parseCapabilityManifest(definition.manifest);
  if (!API_VERSION_PATTERN.test(manifest.apiVersion)) throw new TypeError("Capability API version must use major.minor format");
  schemaRecord(manifest.configSchema, "extension_invalid_config");
  schemaRecord(manifest.inputSchema, "extension_invalid_input");
  schemaRecord(manifest.outputSchema, "extension_invalid_input");
  if ((manifest.kind === "workflow") !== Boolean(definition.execute) || (manifest.kind === "tools") !== Boolean(definition.createTools)) throw new TypeError("Capability handler does not match manifest kind");
  if (!definition.defaultConfig || !isRecord(definition.defaultConfig) || !validateExtensionValue(manifest.configSchema, definition.defaultConfig, { allowMissingRequired: true })) throw new TypeError("Capability default configuration does not match config schema");
  if (!Array.isArray(manifest.requiredPermissions) || new Set(manifest.requiredPermissions).size !== manifest.requiredPermissions.length) throw new TypeError("Capability permissions must be unique");
  return { ...definition, manifest };
}

export function createCapabilityRegistry(definitions: CapabilityDefinition[]) {
  const items = definitions.map(assertDefinition);
  const byId = new Map(items.map((item) => [item.manifest.id, item]));
  if (byId.size !== items.length) throw new TypeError("Capability IDs must be unique");

  function stateFor(definition: CapabilityDefinition, stored?: CapabilityState) {
    const version = stored?.apiVersion ?? definition.manifest.apiVersion;
    const config = stored?.config ?? definition.defaultConfig;
    const enabled = stored?.enabled ?? definition.enabledByDefault;
    const compatible = definition.manifest.apiVersion === CAPABILITY_API_VERSION && version === definition.manifest.apiVersion;
    const missingConfiguration = missingRequired(definition.manifest.configSchema, config);
    const configured = missingConfiguration.length === 0 && validateExtensionValue(definition.manifest.configSchema, config);
    const status = !compatible ? "incompatible" : !enabled ? "disabled" : !configured ? "needs_configuration" : "enabled";
    return { version, config, enabled, compatible, missingConfiguration, configured, status } as const;
  }

  function get(capabilityId: string): CapabilityDefinition {
    const definition = byId.get(capabilityId);
    if (!definition) throw new CapabilityRegistryError("unknown_extension", "所选扩展未注册。");
    return definition;
  }

  function assertReady(definition: CapabilityDefinition, stored: CapabilityState | undefined, permissions: ReadonlySet<CapabilityPermission>) {
    const state = stateFor(definition, stored);
    if (!state.compatible) throw new CapabilityRegistryError("extension_incompatible", "扩展接口版本与当前工作台不兼容。");
    if (!state.enabled) throw new CapabilityRegistryError("extension_disabled", "此扩展已停用。");
    if (!state.configured) throw new CapabilityRegistryError("extension_unconfigured", "此扩展尚未完成必需配置。");
    if (definition.manifest.requiredPermissions.some((permission) => !permissions.has(permission))) throw new CapabilityRegistryError("extension_permission_denied", "当前对话未授予此扩展所需权限。");
    return state;
  }

  function resolveRun(input: V2RunSubmission): PreparedCapability {
    if (input.kind !== "capability" || !input.apiVersion || !input.configSnapshot) throw new CapabilityRegistryError("extension_incompatible", "运行缺少已固定的扩展版本或配置快照。");
    const definition = get(input.capabilityId);
    if (definition.manifest.apiVersion !== CAPABILITY_API_VERSION || input.apiVersion !== definition.manifest.apiVersion) throw new CapabilityRegistryError("extension_incompatible", "此运行的扩展接口版本不兼容。");
    if (!validateExtensionValue(definition.manifest.configSchema, input.configSnapshot)) throw new CapabilityRegistryError("extension_invalid_config", "运行配置快照与 manifest schema 不匹配。");
    if (!validateExtensionValue(definition.manifest.inputSchema, input.input)) throw new CapabilityRegistryError("extension_invalid_input", "运行输入与 manifest schema 不匹配。");
    return { definition, input: input.input, configuration: input.configSnapshot as Record<string, JsonValue> };
  }

  return {
    list(): CapabilityDefinition[] { return [...items]; },
    get,
    catalog(states: ReadonlyMap<string, CapabilityState>): CapabilityCatalogEntry[] {
      return items.map((definition) => {
        const state = stateFor(definition, states.get(definition.manifest.id));
        return {
          manifest: structuredClone(definition.manifest), enabled: state.enabled, configured: state.configured,
          compatible: state.compatible, status: state.status, config: structuredClone(state.config), missingConfiguration: [...state.missingConfiguration],
        };
      });
    },
    prepareInvocation(input: V2CreateRunSubmission, stored: CapabilityState | undefined, permissions: ReadonlySet<CapabilityPermission>): V2RunSubmission {
      if (input.kind === "message") return structuredClone(input);
      const definition = get(input.capabilityId);
      const state = assertReady(definition, stored, permissions);
      if (!validateExtensionValue(definition.manifest.inputSchema, input.input)) throw new CapabilityRegistryError("extension_invalid_input", "扩展输入与 manifest schema 不匹配。");
      if (input.prompt !== undefined && input.prompt.length > 16_000) throw new CapabilityRegistryError("extension_invalid_input", "扩展提示过长。");
      return { ...structuredClone(input), apiVersion: definition.manifest.apiVersion, configSnapshot: structuredClone(state.config) };
    },
    resolveRun,
    assertReady,
    async invokeWorkflow(input: V2RunSubmission, context: CapabilityContext): Promise<{ definition: CapabilityDefinition; result: CapabilityWorkflowResult }> {
      const prepared = resolveRun(input);
      if (prepared.definition.manifest.kind !== "workflow" || !prepared.definition.execute) throw new CapabilityRegistryError("extension_incompatible", "所选扩展不是流程型能力。");
      const prompt = input.kind === "capability" ? input.prompt ?? (typeof input.input.goal === "string" ? input.input.goal : "") : "";
      const result = await prepared.definition.execute(prepared.input, { ...context, prompt, configuration: prepared.configuration });
      if (!validateExtensionValue(prepared.definition.manifest.outputSchema, result.output)) throw new CapabilityRegistryError("extension_invalid_input", "扩展输出与 manifest schema 不匹配。");
      if (!result.title.trim() || result.title.length > 256 || !result.summary.trim() || result.summary.length > 4096 || !result.reply.trim() || result.reply.length > 16_000 || encode(result.output).length > 16_384) {
        throw new CapabilityRegistryError("extension_invalid_input", "扩展结果超过允许大小或缺少必需内容。");
      }
      return { definition: prepared.definition, result };
    },
    async createTools(input: V2RunSubmission, context: CapabilityContext, reservedNames: ReadonlySet<string>): Promise<Array<CapabilityTool & { qualifiedName: string }>> {
      const prepared = resolveRun(input);
      if (prepared.definition.manifest.kind !== "tools" || !prepared.definition.createTools) throw new CapabilityRegistryError("extension_incompatible", "所选扩展不是工具型能力。");
      const prompt = input.kind === "capability" ? input.prompt ?? (typeof input.input.goal === "string" ? input.input.goal : "") : "";
      const tools = await prepared.definition.createTools({ ...context, prompt, configuration: prepared.configuration });
      const names = new Set<string>();
      return tools.map((tool) => {
        if (!SAFE_TOOL_NAME.test(tool.name) || !tool.description.trim() || tool.description.length > 512) throw new TypeError("Extension tool metadata is invalid");
        schemaRecord(tool.inputSchema, "extension_invalid_input"); schemaRecord(tool.outputSchema, "extension_invalid_input");
        const qualifiedName = `${prepared.definition.manifest.id}__${tool.name}`;
        if (qualifiedName.length > 128 || names.has(qualifiedName) || reservedNames.has(qualifiedName)) throw new TypeError("Extension tool name conflicts with another registered tool");
        names.add(qualifiedName);
        return {
          ...tool, qualifiedName,
          async execute(value: unknown, toolContext: CapabilityContext) {
            if (!validateExtensionValue(tool.inputSchema, value)) throw new CapabilityRegistryError("extension_invalid_input", "扩展工具参数与 schema 不匹配。");
            const output = await tool.execute(value, toolContext);
            if (!validateExtensionValue(tool.outputSchema, output)) throw new CapabilityRegistryError("extension_invalid_input", "扩展工具结果与 schema 不匹配。");
            if (encode(output).length > 8192) throw new CapabilityRegistryError("extension_invalid_input", "扩展工具结果过大。");
            return output;
          },
        };
      });
    },
    validateOutput(capabilityId: string, value: unknown): boolean {
      return validateExtensionValue(get(capabilityId).manifest.outputSchema, value);
    },
    updateState(definition: CapabilityDefinition, previous: CapabilityState | undefined, patch: { enabled?: boolean; config?: Record<string, unknown> }): CapabilityState {
      const state = stateFor(definition, previous);
      if (!patch.enabled && patch.enabled !== false && patch.config === undefined) throw new TypeError("Capability state update is empty");
      const enabled = patch.enabled ?? state.enabled;
      const config = patch.config === undefined ? state.config : patch.config;
      if (!isRecord(config) || !validateExtensionValue(definition.manifest.configSchema, config, { allowMissingRequired: true })) throw new CapabilityRegistryError("extension_invalid_config", "配置与 manifest configSchema 不匹配。");
      const text = encode(config);
      if (text.length > 8192 || Object.keys(config).some((key) => SENSITIVE_CONFIG_KEY.test(key))) throw new CapabilityRegistryError("extension_invalid_config", "配置只能保存非敏感 JSON 值。");
      return { capabilityId: definition.manifest.id, apiVersion: definition.manifest.apiVersion, enabled, config: structuredClone(config as Record<string, JsonValue>) };
    },
    hasPermission(id: string, permission: CapabilityPermission): boolean { return get(id).manifest.requiredPermissions.includes(permission); },
  };
}
