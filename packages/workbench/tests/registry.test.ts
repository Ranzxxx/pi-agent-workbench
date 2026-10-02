import assert from "node:assert/strict";
import test from "node:test";
import { createCapabilityRegistry, publicRepositoryCapability, validateExtensionValue, type CapabilityContext } from "../src/registry.js";
import { createDevelopmentGreetingExtension } from "../src/development-extension.js";

function context(): CapabilityContext {
  return {
    runId: "run_registry", attemptId: "attempt_registry", conversationId: "conversation_registry", projectId: null,
    prompt: "test prompt", signal: new AbortController().signal,
    budget: { timeoutMs: 10_000, maxModelCalls: 2, maxToolCalls: 2, maxTokens: 1000, maxOutputTokens: 200, maxCostUsd: 1 },
    configuration: {}, emit() {},
  };
}

test("capability catalog defaults, state updates, input validation, and request-scoped tool execution", async () => {
  const registry = createCapabilityRegistry([createDevelopmentGreetingExtension()]);
  const definition = registry.get("development_greeting_tool");
  const initial = registry.catalog(new Map())[0]!;
  assert.equal(initial.enabled, false);
  assert.equal(initial.status, "disabled");
  assert.throws(() => registry.prepareInvocation({ kind: "capability", capabilityId: definition.manifest.id, input: {}, prompt: "hello" }, undefined, new Set()),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "extension_disabled");

  const state = registry.updateState(definition, undefined, { enabled: true });
  const input = registry.prepareInvocation({ kind: "capability", capabilityId: definition.manifest.id, input: {}, prompt: "Please call the greeting tool." }, state, new Set());
  assert.equal(input.kind, "capability");
  if (input.kind !== "capability") throw new Error("Expected capability invocation");
  assert.equal(input.apiVersion, definition.manifest.apiVersion);
  assert.equal(registry.validateOutput(definition.manifest.id, { toolCalls: [] }), true);
  assert.equal(registry.validateOutput(definition.manifest.id, { toolCalls: [{ unexpected: true }] }), false);

  const tools = await registry.createTools(input, context(), new Set());
  assert.equal(tools.length, 1);
  assert.equal(tools[0]!.qualifiedName, "development_greeting_tool__make_greeting");
  assert.deepEqual(await tools[0]!.execute({ name: "Ada" }, context()), { message: "Hello, Ada." });
  await assert.rejects(async () => { await tools[0]!.execute({ name: "Ada", command: "anything" }, context()); });
});

test("workflow handlers use the same versioned invocation and validate their result schema", async () => {
  const registry = createCapabilityRegistry([{
    manifest: publicRepositoryCapability,
    enabledByDefault: true,
    defaultConfig: {},
    async execute(_input, invocationContext) {
      assert.equal(invocationContext.prompt, "summarize this repository");
      return {
        title: "Synthetic analysis", summary: "Verified summary", reply: "Analysis complete.",
        output: { snapshotSha: "a".repeat(40), evidenceCount: 1, claims: [{ kind: "fact", text: "One verified fact." }] },
      };
    },
  }]);
  const definition = registry.get(publicRepositoryCapability.id);
  const prepared = registry.prepareInvocation({
    kind: "capability", capabilityId: definition.manifest.id,
    input: { repositoryUrl: "https://github.com/example/project" }, prompt: "summarize this repository",
  }, undefined, new Set(["public_repository.read", "results.write"]));
  assert.throws(() => registry.prepareInvocation({
    kind: "capability", capabilityId: definition.manifest.id,
    input: { repositoryUrl: "https://github.com/example/project" }, prompt: "summarize this repository",
  }, undefined, new Set(["results.write"])),
  (error: unknown) => error instanceof Error && "code" in error && error.code === "extension_permission_denied");
  const invoked = await registry.invokeWorkflow(prepared, context());
  assert.equal(invoked.result.reply, "Analysis complete.");
  assert.equal(registry.validateOutput(definition.manifest.id, invoked.result.output), true);
  assert.throws(() => registry.prepareInvocation({
    kind: "capability", capabilityId: "unregistered", input: {}, prompt: "test",
  }, undefined, new Set()), (error: unknown) => error instanceof Error && "code" in error && error.code === "unknown_extension");
});

test("required non-secret config can start incomplete and becomes selectable after validation", () => {
  const manifest = {
    ...publicRepositoryCapability,
    configSchema: {
      type: "object", additionalProperties: false, required: ["namespace"],
      properties: { namespace: { type: "string", minLength: 1, maxLength: 40 } },
    },
  };
  const registry = createCapabilityRegistry([{
    manifest, enabledByDefault: true, defaultConfig: {},
    async execute() { return { title: "test", summary: "test", reply: "test", output: { snapshotSha: "a".repeat(40), evidenceCount: 0, claims: [] } }; },
  }]);
  const definition = registry.get(publicRepositoryCapability.id);
  const initial = registry.catalog(new Map())[0]!;
  assert.equal(initial.enabled, true);
  assert.equal(initial.configured, false);
  assert.equal(initial.status, "needs_configuration");
  const invocation = {
    kind: "capability" as const, capabilityId: definition.manifest.id,
    input: { repositoryUrl: "https://github.com/example/project" }, prompt: "summarize this repository",
  };
  const permissions = new Set(["public_repository.read", "results.write"] as const);
  assert.throws(() => registry.prepareInvocation(invocation, undefined, permissions),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "extension_unconfigured");
  assert.throws(() => registry.prepareInvocation(invocation, {
    capabilityId: definition.manifest.id, apiVersion: "0.9", enabled: true, config: { namespace: "research" },
  }, permissions), (error: unknown) => error instanceof Error && "code" in error && error.code === "extension_incompatible");
  assert.throws(() => registry.prepareInvocation({ ...invocation, input: { repositoryUrl: "https://example.com/a/b" } }, {
    capabilityId: definition.manifest.id, apiVersion: definition.manifest.apiVersion, enabled: true, config: { namespace: "research" },
  }, permissions), (error: unknown) => error instanceof Error && "code" in error && error.code === "extension_invalid_input");
  assert.throws(() => registry.updateState(definition, undefined, { config: { namespace: 4 } }));

  const configured = registry.updateState(definition, undefined, { config: { namespace: "research" } });
  const updated = registry.catalog(new Map([[configured.capabilityId, configured]]))[0]!;
  assert.equal(updated.configured, true);
  assert.equal(updated.status, "enabled");
});

test("extension schema validation enforces object property bounds and rejects contradictory ranges", () => {
  const schema = {
    type: "object", additionalProperties: false, minProperties: 1, maxProperties: 2,
    properties: { label: { type: "string", minLength: 1 }, enabled: { type: "boolean" } },
    required: [],
  };
  assert.equal(validateExtensionValue(schema, {}), false);
  assert.equal(validateExtensionValue(schema, { label: "demo" }), true);
  assert.equal(validateExtensionValue(schema, { label: "demo", enabled: true, extra: "value" }), false);
  assert.throws(() => validateExtensionValue({
    type: "object", additionalProperties: false, minProperties: 2, maxProperties: 1,
    properties: {}, required: [],
  }, {}));
});
